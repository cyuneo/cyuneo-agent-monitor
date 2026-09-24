'use strict';
// Claude Code provider.
// Reads the jsonl transcripts Claude Code writes under <projectsDir> plus the live-session registry in <claudeHome>/sessions,
// and produces Session / Agent / Workflow and SessionDetail.
// Emits only codes, numbers, timestamps and raw text snippets, never UI text (text is assembled per language by the format layer).
// Plain Node, no vscode dependency; usable by the worker and the terminal version. Read-only: never writes any Claude file.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { JsonlTail } = require('../core/jsonl');
const S = require('../core/status');
const pricing = require('../core/pricing');
const quota = require('../core/quota');
const context = require('../core/context');
const resume = require('../core/resume');
const { readRegistry, cmpVersion } = require('./claude-live');

const { STATUS, STEP, makeStatus } = S;

const DEFAULT_LIMITS = Object.freeze({ timeline: 30, timelineSent: 12, resultChars: 4000, filesPerAgent: 200, errorsPerAgent: 10 });

// User interruption: [Request interrupted by user] / [Request interrupted by user for tool use]
const INTERRUPT_RE = /^\s*\[Request interrupted by user/;
// Echo lines of local slash commands and ! commands: do not start a model turn and do not change the status
const LOCAL_CMD_RE = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/;
// Statuses in the workflow state file that mean "stopped"
const KILLED_RE = /kill|fail|abort|error|cancel/i;
// Workflow run id
const WF_RUN_RE = /\bwf_[0-9a-f]+(?:-[0-9a-f]+)?\b/;
// Tools that modify files
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Tools that wait for the user to answer
const QUESTION_TOOLS = { AskUserQuestion: 'askUser', ExitPlanMode: 'planApproval' };
// "Container" tools: an open call means waiting on a subagent / workflow, not waiting for approval
const CONTAINER_TOOLS = new Set(['Agent', 'Task', 'Workflow']);
// "Running" for a workflow: running or waiting on you
function busyCode(code) { return S.isRunningCode(code) || S.isNeedsYouCode(code); }

function defaultProjectsDir(env = process.env) {
  if (env && env.CLAUDE_CONFIG_DIR) return path.join(env.CLAUDE_CONFIG_DIR, 'projects');
  return path.join(os.homedir(), '.claude', 'projects');
}

// ---------------------------------------------------------------------------
// State of a single transcript file
// ---------------------------------------------------------------------------

function newState(lim, isMain) {
  return {
    lim,
    isMain: !!isMain,
    firstTs: null,        // first line with a timestamp (any type): source of the sort key startedMs
    firstMsgTs: null,     // first user / assistant line: createdMs
    lastTs: null,
    title: null, customTitle: null, lastPrompt: null,
    entrypoint: null, cwd: null, version: null,
    model: null,          // model of the latest non-synthetic assistant message
    lastRole: null,       // 'user' | 'assistant'
    sawAssistant: false,
    stopReason: null,
    interrupted: false, interruptTs: null,
    promptTs: null,
    turnEndTs: null,      // latest "end of turn" (stop_reason other than tool_use)
    doneMsgId: null,
    lastUsage: null, lastUsageTs: null,
    lastUsageTtl: null,   // '5m' | '1h': tier inferred from the latest usage with cache writes
    ctxOverride: null,    // context usage after compaction, before the next call (compact_boundary.postTokens)
    msgs: new Map(),      // message.id → { out, proc, usd } (one message is written over several lines; the last one wins)
    outSum: 0, procSum: 0, apiCalls: 0,
    costSum: 0, pricedCalls: 0, unpricedModel: null, costEstimated: false,
    toolNames: new Map(), // tool_use id → tool name
    pending: new Map(),   // tool_use id → { tool, detail, sinceMs }: issued, no result yet
    cancelled: new Map(), // ids of Agent/Task calls ended by interruption / error → time (foreground subagents stop with them)
    toolCalls: 0, toolErrors: 0,
    lastEvent: null,      // { kind, tool, detail, ts }
    prevTool: null,
    submitted: false, submittedTs: null,
    structured: null,     // input of StructuredOutput (truncated text)
    wfPending: new Map(), // Workflow tool call id → { name, scriptPath }
    wfInfo: new Map(),    // runId → { name, scriptPath }
    apiError: null,       // { ts, quota: QuotaHit|null, error }
    retry: null,          // { attempt, max, inMs, ts }
    lastCompact: null,    // { ms, trigger, preTokens, postTokens, model }
    compactCount: 0, compactTimes: [], // compaction count and times (for loop detection)
    costState: null,      // latest cost-state: { totalCostUSD, keys } (main transcript only)
    lastText: null, lastTextMsgId: null, // { text, ms, truncated }
    timeline: [],
    files: new Map(),     // path → { op, count, lastMs, movedTo }
    pendingFile: new Map(),
    errors: [],
  };
}

function num(v) { const n = Number(v); return v != null && Number.isFinite(n) ? n : null; }
function int(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }

function ingest(s, e) {
  const ts0 = Date.parse(e.timestamp);
  const hasTs = Number.isFinite(ts0);
  if (hasTs && s.firstTs == null) s.firstTs = ts0;
  switch (e.type) {
    case 'ai-title': if (typeof e.aiTitle === 'string' && e.aiTitle) s.title = e.aiTitle; return;
    case 'custom-title': if (typeof e.customTitle === 'string' && e.customTitle) s.customTitle = e.customTitle; return;
    case 'last-prompt': if (typeof e.lastPrompt === 'string' && e.lastPrompt) s.lastPrompt = e.lastPrompt; return;
    case 'cost-state': ingestCostState(s, e); return;
    case 'system': case 'user': case 'assistant': break;
    default: return;
  }
  if (s.isMain && e.isSidechain === true) return; // older versions also wrote subagent lines into the main transcript
  if (hasTs && (s.lastTs == null || ts0 > s.lastTs)) s.lastTs = ts0;
  const ts = hasTs ? ts0 : (s.lastTs || 0);
  if (typeof e.entrypoint === 'string' && e.entrypoint) s.entrypoint = e.entrypoint;
  if (typeof e.cwd === 'string' && e.cwd) s.cwd = e.cwd;
  if (typeof e.version === 'string' && e.version) s.version = e.version;
  if (e.type === 'system') { ingestSystem(s, e, ts); return; }
  if (e.isMeta) return;
  const m = e.message;
  if (!m || typeof m !== 'object') return;
  if (s.firstMsgTs == null && hasTs) s.firstMsgTs = ts;
  if (e.type === 'assistant') ingestAssistant(s, e, m, ts);
  else ingestUser(s, e, m, ts);
}

// Session-cumulative cost and per-model usage recorded by Claude Code itself. modelUsage keys carry the real variant (e.g. 'claude-opus-5-5[1m]'),
// used to determine the window; totalCostUSD is the cost computed by Claude Code. Only the main transcript counts; the last entry wins.
function ingestCostState(s, e) {
  if (!s.isMain) return;
  const mu = e.modelUsage && typeof e.modelUsage === 'object' && !Array.isArray(e.modelUsage) ? e.modelUsage : {};
  s.costState = { totalCostUSD: num(e.totalCostUSD), keys: Object.keys(mu) };
}

function ingestSystem(s, e, ts) {
  if (e.subtype === 'api_error') {
    // Retrying: record the attempt number; cleared by the next assistant message
    s.retry = { attempt: num(e.retryAttempt), max: num(e.maxRetries), inMs: num(e.retryInMs), ts };
    const detail = s.retry.attempt != null ? `${s.retry.attempt}/${s.retry.max ?? '?'}` : null;
    pushTimeline(s, { ms: ts, kind: 'retry', tool: null, detail });
  } else if (e.subtype === 'compact_boundary') {
    const md = e.compactMetadata && typeof e.compactMetadata === 'object' ? e.compactMetadata : {};
    const trigger = md.trigger === 'auto' || md.trigger === 'manual' ? md.trigger : null;
    // model: the main conversation's model at compaction time (used to learn observed compaction points)
    s.lastCompact = { ms: ts, trigger, preTokens: num(md.preTokens), postTokens: num(md.postTokens), model: s.model || null };
    s.compactCount++;
    S.noteCompact(s.compactTimes, ts);
    if (num(md.postTokens) != null) s.ctxOverride = { tokens: num(md.postTokens), ts };
    s.lastEvent = { kind: 'compact', tool: null, detail: null, ts };
    pushTimeline(s, { ms: ts, kind: 'compact', tool: null, detail: trigger });
  }
}

function ingestAssistant(s, e, m, ts) {
  const synthetic = m.model === '<synthetic>';
  if (e.isApiErrorMessage === true) {
    // API error lines do not count as calls and do not overwrite lastUsage / stopReason; they go through the error rules in classify()
    const hit = quota.isClaudeQuotaLine(e) ? quota.parseClaudeQuota(e, { timeZone: s.lim.timeZone, now: ts }) : null;
    s.apiError = { ts, quota: hit, error: hit ? null : quota.claudeApiError(e) };
    s.retry = null;
    pushTimeline(s, { ms: ts, kind: hit ? 'quota' : 'apiError', tool: null, detail: firstLine(quota.claudeMessageText(e), 90) });
    return;
  }
  s.apiError = null;
  s.retry = null;
  s.lastRole = 'assistant';
  s.sawAssistant = true;
  s.interrupted = false;
  s.submitted = false;
  if (!synthetic && typeof m.model === 'string' && m.model) s.model = m.model;
  s.stopReason = m.stop_reason || null;

  if (!synthetic && m.usage && typeof m.usage === 'object' && m.id) {
    const u = m.usage;
    const out = int(u.output_tokens);
    const proc = int(u.input_tokens) + int(u.cache_creation_input_tokens) + int(u.cache_read_input_tokens) + out;
    const prev = s.msgs.get(m.id);
    if (!prev) s.apiCalls++;
    const detail = pricing.priceClaudeDetail(m.model, u);
    const usd = detail.usd;
    s.outSum += out - (prev ? prev.out : 0);
    s.procSum += proc - (prev ? prev.proc : 0);
    if (usd != null) {
      s.costSum += usd - (prev && prev.usd != null ? prev.usd : 0);
      if (!prev || prev.usd == null) s.pricedCalls++;
      if (detail.estimated) s.costEstimated = true;
    } else if (!s.unpricedModel) {
      s.unpricedModel = m.model || null;
    }
    s.msgs.set(m.id, { out, proc, usd });
    s.lastUsage = u;
    s.lastUsageTs = ts;
    s.ctxOverride = null;
    const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
    if (cc && int(cc.ephemeral_1h_input_tokens) > 0) s.lastUsageTtl = '1h';
    else if (cc && int(cc.ephemeral_5m_input_tokens) > 0) s.lastUsageTtl = '5m';
    else if (!cc && int(u.cache_creation_input_tokens) > 0) s.lastUsageTtl = '5m';
  }

  const content = Array.isArray(m.content) ? m.content : [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'tool_use') {
      const name = typeof c.name === 'string' && c.name ? c.name : 'unknown';
      const detail = describeInput(name, c.input) || null;
      if (c.id && !s.toolNames.has(c.id)) {
        s.toolCalls++;
        s.toolNames.set(c.id, name);
        s.pending.set(c.id, { tool: name, detail, sinceMs: ts });
        pushTimeline(s, { ms: ts, kind: 'tool', tool: name, detail });
        if (name === 'Workflow') s.wfPending.set(c.id, { name: workflowNameOf(c.input) || null, scriptPath: scriptPathOf(c.input) });
        if (FILE_TOOLS.has(name)) {
          const p = filePathOf(c.input);
          if (p) s.pendingFile.set(c.id, { path: p, tool: name });
        }
        if (name === 'StructuredOutput') s.structured = clip(stringifyResult(c.input), s.lim.resultChars);
      }
      s.lastEvent = { kind: 'tool', tool: name, detail, ts };
    } else if (c.type === 'thinking' || c.type === 'redacted_thinking') {
      if (!s.lastEvent || s.lastEvent.kind !== 'thinking') s.lastEvent = { kind: 'thinking', tool: null, detail: null, ts };
      pushTimeline(s, { ms: ts, kind: 'thinking', tool: null, detail: null });
    } else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
      const detail = oneLine(c.text);
      s.lastEvent = { kind: 'text', tool: null, detail, ts };
      if (!synthetic) {
        // Result: all text blocks of the last assistant message that has text
        if (m.id && s.lastTextMsgId === m.id && s.lastText) {
          s.lastText = appendClip(s.lastText, c.text, ts, s.lim.resultChars);
        } else {
          s.lastText = { ...clip(c.text, s.lim.resultChars), ms: ts };
          s.lastTextMsgId = m.id || null;
        }
      }
      const last = s.timeline[s.timeline.length - 1];
      if (!(last && last.kind === 'text' && last.msgId && last.msgId === m.id)) {
        pushTimeline(s, { ms: ts, kind: 'text', tool: null, detail, msgId: m.id || null });
      }
    }
  }
  if (s.stopReason && s.stopReason !== 'tool_use') {
    s.turnEndTs = ts;
    const mid = m.id || null;
    if (!mid || s.doneMsgId !== mid) pushTimeline(s, { ms: ts, kind: 'done', tool: null, detail: null });
    s.doneMsgId = mid;
  }
}

function ingestUser(s, e, m, ts) {
  const content = Array.isArray(m.content) ? m.content : null;
  let text = typeof m.content === 'string' ? m.content : null;
  let results = 0;
  let others = 0;
  // Tool calls the user rejected / interrupted: the result has is_error but does not count as a tool error
  const interruptHere = !!content && content.some((c) => c && c.type === 'text' && typeof c.text === 'string' && INTERRUPT_RE.test(c.text));
  const denied = interruptHere ? 'interrupt' : (e.toolDenialKind ? 'denied' : null);
  for (const c of content || []) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'tool_result') { results++; handleResult(s, e, c, ts, content.length, denied); }
    else if (c.type === 'text' && typeof c.text === 'string') { if (text == null) text = c.text; }
    else others++;
  }
  if (e.isCompactSummary) return; // a compaction summary is not a prompt (compact_boundary already recorded it)
  if (text != null && INTERRUPT_RE.test(text)) {
    s.lastRole = 'user';
    s.stopReason = null;
    s.interrupted = true;
    s.interruptTs = ts;
    s.apiError = null;
    s.retry = null;
    for (const [id, p] of s.pending) if (CONTAINER_TOOLS.has(p.tool)) s.cancelled.set(id, ts);
    s.pending.clear();
    s.pendingFile.clear();
    s.lastEvent = { kind: 'interrupt', tool: null, detail: null, ts };
    pushTimeline(s, { ms: ts, kind: 'interrupt', tool: null, detail: null });
    return;
  }
  if (results > 0) {
    s.lastRole = 'user';
    s.stopReason = null;
    s.apiError = null;
    s.retry = null;
    const p = s.prevTool;
    s.lastEvent = { kind: 'toolResult', tool: p ? p.tool : null, detail: p ? p.detail : null, ts };
    return;
  }
  if (text != null && LOCAL_CMD_RE.test(text)) return; // local commands (/compact, /model, ! commands…)
  if (text == null && others === 0) return;
  // A new prompt (including messages injected by Claude Code that start a new turn, such as <task-notification>)
  s.lastRole = 'user';
  s.stopReason = null;
  s.interrupted = false;
  s.apiError = null;
  s.retry = null;
  s.submitted = false;
  s.pending.clear();
  s.pendingFile.clear();
  s.promptTs = ts;
  const detail = text != null ? oneLine(text.replace(/<\/?[a-zA-Z][\w-]*>/g, ' ')) : null;
  s.lastEvent = { kind: 'prompt', tool: null, detail, ts };
  pushTimeline(s, { ms: ts, kind: 'prompt', tool: null, detail });
}

function handleResult(s, e, c, ts, blocks, denied) {
  const id = c.tool_use_id;
  const p = s.pending.get(id);
  const name = (p && p.tool) || s.toolNames.get(id) || null;
  s.pending.delete(id);
  const isErr = c.is_error === true;
  if (name === 'StructuredOutput' && !isErr) { s.submitted = true; s.submittedTs = ts; }
  const wf = s.wfPending.get(id);
  if (wf) {
    const run = WF_RUN_RE.exec(resultText(c));
    if (run) s.wfInfo.set(run[0], wf);
    s.wfPending.delete(id);
  }
  const pf = s.pendingFile.get(id);
  if (pf) {
    s.pendingFile.delete(id);
    if (!isErr) {
      const tr = blocks === 1 && e.toolUseResult && typeof e.toolUseResult === 'object' ? e.toolUseResult : null;
      recordFile(s, pf.path, pf.tool === 'Write' && tr && tr.type === 'create' ? 'create' : 'edit', ts);
    }
  }
  if (isErr && (name === 'Agent' || name === 'Task')) s.cancelled.set(id, ts);
  if (isErr && !denied) {
    s.toolErrors++;
    s.errors.push({ ms: ts, tool: name, text: firstLine(resultText(c), 200) || '' });
    if (s.errors.length > s.lim.errorsPerAgent) s.errors.splice(0, s.errors.length - s.lim.errorsPerAgent);
  }
  // an interruption is followed immediately by an interrupt event, so do not record another one here
  if (denied !== 'interrupt') pushTimeline(s, { ms: ts, kind: isErr ? 'toolError' : 'toolDone', tool: name, detail: p ? p.detail : null });
  s.prevTool = { tool: name, detail: p ? p.detail : null, ts };
}

function recordFile(s, file, op, ts) {
  let f = s.files.get(file);
  if (!f) {
    if (s.files.size >= s.lim.filesPerAgent) return;
    f = { op, count: 0, lastMs: ts, movedTo: null };
    s.files.set(file, f);
  } else if (f.op !== 'create') {
    f.op = op; // created then edited still counts as created
  }
  f.count++;
  f.lastMs = ts;
}

function pushTimeline(s, ev) {
  const tl = s.timeline;
  const last = tl[tl.length - 1];
  if (ev.kind === 'thinking' && last && last.kind === 'thinking') return; // merge consecutive thinking
  tl.push(ev);
  if (tl.length > s.lim.timeline) tl.splice(0, tl.length - s.lim.timeline);
}

// ---------------------------------------------------------------------------
// Workflow log journal.jsonl: started / result / failed
// ---------------------------------------------------------------------------

function newJournal(lim) {
  return { lim, done: new Set(), failed: new Set(), labels: new Map(), phases: new Map(), keyOf: new Map(), latest: new Map(), results: new Map() };
}

function ingestJournal(j, e) {
  if (!e.agentId || typeof e.agentId !== 'string') return;
  if (e.type === 'started') {
    if (typeof e.label === 'string' && e.label) j.labels.set(e.agentId, e.label);
    if (typeof e.phase === 'string' && e.phase) j.phases.set(e.agentId, e.phase);
    if (e.key != null) { j.keyOf.set(e.agentId, String(e.key)); j.latest.set(String(e.key), e.agentId); }
  } else if (e.type === 'result') {
    j.done.add(e.agentId);
    j.results.set(e.agentId, clip(stringifyResult(e.result), j.lim.resultChars));
  } else if (e.type === 'failed') {
    j.failed.add(e.agentId);
  }
}

// ---------------------------------------------------------------------------
// Status classification
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<typeof newState>} s
 * @param {{ now: number, staleMs: number, mtimeMs: number, isMain?: boolean, bgRunning?: boolean,
 *   journalDone?: boolean, journalFailed?: boolean, killed?: boolean, busy?: boolean,
 *   parentGoneMs?: number|null,
 *   guess?: { mode?: string, seconds?: number, staleMinutes?: number, hasRegistry?: boolean } }} c
 * @returns {import('../core/status').AgentStatus}
 */
function classify(s, c) {
  const now = c.now;
  const lastActivity = Math.max(c.mtimeMs || 0, s.lastTs || 0);
  // 1, 2: API error (usage limit hit / other)
  if (s.apiError) {
    if (s.apiError.quota) return makeStatus(STATUS.QUOTA, s.apiError.ts, { quota: s.apiError.quota });
    return makeStatus(STATUS.API_ERROR, s.apiError.ts, { error: s.apiError.error });
  }
  // 3: retrying
  if (s.retry) {
    return makeStatus(STATUS.RETRYING, s.retry.ts, { retry: { attempt: s.retry.attempt ?? 0, max: s.retry.max ?? 0, inMs: s.retry.inMs } });
  }
  // 4: interrupted by the user
  if (s.interrupted) return makeStatus(STATUS.INTERRUPTED, s.interruptTs ?? lastActivity);
  // 5: this turn has ended
  if (s.lastRole === 'assistant' && s.stopReason && s.stopReason !== 'tool_use' && s.pending.size === 0) {
    return makeStatus(c.isMain && c.bgRunning ? STATUS.IDLE_BACKGROUND : STATUS.DONE, s.turnEndTs ?? lastActivity);
  }
  // 6: a workflow agent submitted its result
  if ((s.submitted && s.pending.size === 0) || c.journalDone) return makeStatus(STATUS.DONE, s.submittedTs ?? lastActivity);
  // failed recorded in the journal (if its own transcript showed quota, that already returned above)
  if (c.journalFailed) return makeStatus(STATUS.API_ERROR, lastActivity, { error: { kind: 'workflowAgentFailed', http: null, message: null } });
  // 7: workflow was stopped
  if (c.killed) return makeStatus(STATUS.KILLED, lastActivity);
  // 8: waiting for the user to answer (question, plan approval) — never becomes stale
  let q = null;
  for (const p of s.pending.values()) {
    if (QUESTION_TOOLS[p.tool] && (!q || p.sinceMs >= q.sinceMs)) q = p;
  }
  if (q) return makeStatus(STATUS.AWAITING_INPUT, q.sinceMs, { question: QUESTION_TOOLS[q.tool], pendingTool: q.tool });
  // Foreground subagent: the parent's call has already ended (interrupted / stopped), so it will not move again
  if (c.parentGoneMs != null) return makeStatus(STATUS.INTERRUPTED, c.parentGoneMs);
  // A fast tool with no result for a long time → may be awaiting your approval (no guessing for sessions with a registry signal)
  const latest = latestPending(s);
  if (latest) {
    const g = c.guess || {};
    const hit = S.guessAwaitingApproval({
      provider: 'claude',
      pending: [...s.pending.values()].map((p) => ({ tool: p.tool, sinceMs: p.sinceMs })),
      now,
      mode: g.mode,
      seconds: g.seconds,
      staleMinutes: g.staleMinutes,
      hasRegistry: g.hasRegistry,
    });
    if (hit) return makeStatus(STATUS.MAYBE_AWAITING_APPROVAL, hit.sinceMs, { pendingTool: hit.tool, stalePending: true });
  }
  // 10: should be running but has not written to the transcript for a long time (not judged when the registry says busy)
  if (!c.busy && now - lastActivity > c.staleMs) {
    return makeStatus(STATUS.STALE, lastActivity, { stalePending: s.pending.size > 0, pendingTool: latest ? latest.tool : null });
  }
  // 9: task received, no model output yet
  if (!s.sawAssistant || (s.lastEvent && s.lastEvent.kind === 'prompt')) {
    return makeStatus(STATUS.STARTING, s.promptTs ?? s.firstTs ?? lastActivity);
  }
  // 11
  if (latest) return makeStatus(STATUS.TOOL, latest.sinceMs, { pendingTool: latest.tool });
  return makeStatus(STATUS.THINKING, (s.lastEvent && s.lastEvent.ts) || lastActivity);
}

function latestPending(s) {
  let latest = null;
  for (const p of s.pending.values()) if (!latest || p.sinceMs >= latest.sinceMs) latest = p;
  return latest;
}

/** Current step. Returns null when there are no events at all. */
function stepOf(s) {
  const latest = latestPending(s);
  if (latest) return { kind: STEP.TOOL, tool: latest.tool, detail: latest.detail || null, parallel: s.pending.size, sinceMs: latest.sinceMs };
  const ev = s.lastEvent;
  if (!ev) return null;
  switch (ev.kind) {
    case 'tool': return { kind: STEP.TOOL, tool: ev.tool, detail: ev.detail || null, parallel: 0, sinceMs: ev.ts };
    case 'toolResult': return { kind: STEP.TOOL_RESULT, tool: ev.tool || null, detail: ev.detail || null, parallel: 0, sinceMs: ev.ts };
    case 'thinking': return { kind: STEP.THINKING, tool: null, detail: null, parallel: 0, sinceMs: ev.ts };
    case 'text': return { kind: STEP.TEXT, tool: null, detail: ev.detail || null, parallel: 0, sinceMs: ev.ts };
    case 'prompt': return { kind: STEP.PROMPT, tool: null, detail: ev.detail || null, parallel: 0, sinceMs: ev.ts };
    case 'compact': return { kind: STEP.COMPACT, tool: null, detail: null, parallel: 0, sinceMs: ev.ts };
    default: return { kind: STEP.NONE, tool: null, detail: null, parallel: 0, sinceMs: ev.ts };
  }
}

// ---------------------------------------------------------------------------
// Tool input → one-line summary (raw text, not translated; used as Step.detail)
// ---------------------------------------------------------------------------

function describeInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = (...keys) => { for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k]; return ''; };
  let d;
  switch (name) {
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      d = shortPath(pick('file_path', 'notebook_path')); break;
    case 'Bash':
      d = pick('description') || pick('command'); break;
    case 'Grep': case 'Glob':
      d = pick('pattern'); break;
    case 'WebFetch':
      d = shortUrl(pick('url')); break;
    case 'WebSearch':
      d = pick('query'); break;
    case 'Agent': case 'Task':
      d = pick('description') || pick('prompt'); break;
    case 'Skill':
      d = pick('skill'); break;
    case 'TodoWrite': case 'StructuredOutput':
      d = ''; break;
    case 'Workflow':
      d = workflowNameOf(input); break;
    default:
      d = pick('description', 'file_path', 'path', 'query', 'url', 'command', 'prompt', 'title', 'name');
      if (!d) {
        for (const v of Object.values(input)) if (typeof v === 'string' && v) { d = v; break; }
      }
  }
  return oneLine(d || '');
}

function workflowNameOf(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.name === 'string' && input.name) return input.name;
  const m = /name\s*:\s*['"`]([^'"`]+)['"`]/.exec(typeof input.script === 'string' ? input.script : '');
  if (m) return m[1];
  if (typeof input.scriptPath === 'string' && input.scriptPath) return path.basename(input.scriptPath).replace(/\.[jt]s$/, '');
  return '';
}

function scriptPathOf(input) {
  return input && typeof input.scriptPath === 'string' && input.scriptPath ? input.scriptPath : null;
}

function filePathOf(input) {
  if (!input || typeof input !== 'object') return null;
  const p = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
  return p || null;
}

function resultText(c) {
  if (typeof c.content === 'string') return c.content;
  if (Array.isArray(c.content)) return c.content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n');
  return '';
}

function stringifyResult(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2) || ''; } catch { return String(v); }
}

// Truncate to max characters and flag whether it was truncated
function clip(text, max) {
  const t = String(text || '');
  return t.length > max ? { text: t.slice(0, max), truncated: true } : { text: t, truncated: false };
}

function appendClip(prev, more, ts, max) {
  if (prev.truncated) return { ...prev, ms: ts };
  const c = clip(prev.text + '\n\n' + more, max);
  return { ...c, ms: ts };
}

function oneLine(t, max = 90) {
  const s = String(t).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function firstLine(t, max) {
  const line = String(t || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function shortPath(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/');
}

function shortUrl(u) {
  try { const x = new URL(u); return x.host + x.pathname; } catch { return u; }
}

// ---------------------------------------------------------------------------
// Other small helpers
// ---------------------------------------------------------------------------

function listDir(d) {
  try { return fs.readdirSync(d); } catch { return []; }
}

function mtimeOf(f) {
  try { return fs.statSync(f).mtimeMs; } catch { return 0; }
}

function agentIdOf(file) {
  return path.basename(file, '.jsonl').replace(/^agent-/, '');
}

// VS Code workspace path → directory name under projects (every non-alphanumeric character becomes -)
function projectDirName(p) {
  return String(p || '').replace(/[^a-zA-Z0-9]/g, '-');
}

// Transcript entrypoint → Session.entry
function entryOf(raw) {
  if (!raw) return 'other';
  if (raw === 'claude-vscode') return 'vscode';
  if (raw === 'cli') return 'cli';
  if (raw === 'claude-desktop') return 'desktop';
  if (/^sdk/.test(raw)) return 'sdk';
  return 'other';
}

function inputSide(u) {
  if (!u) return 0;
  return int(u.input_tokens) + int(u.cache_creation_input_tokens) + int(u.cache_read_input_tokens);
}

function sumCost(list) {
  let usd = 0;
  let priced = false;
  let unpriced = null;
  let any = false;
  for (const a of list) {
    if (a.tokens.apiCalls > 0) any = true;
    if (a.costUsd != null) { usd += a.costUsd; if (a.tokens.apiCalls > 0) priced = true; }
    if (a.unpricedModel && !unpriced) unpriced = a.unpricedModel;
  }
  return { costUsd: priced || !any ? usd : null, unpricedModel: unpriced };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class ClaudeProvider {
  /**
   * @param {{
   *   projectsDir?: string, settingsPath?: string, home?: string,
   *   activeWindowMinutes?: number, staleMinutes?: number,
   *   limits?: Partial<typeof DEFAULT_LIMITS>,
   *   approvalGuess?: 'fastTools'|'allTools'|'off', approvalGuessSeconds?: number,
   *   timeZone?: string, env?: Record<string, string|undefined>,
   *   discoverMs?: number, isAlive?: (pid: number) => boolean,
   *   observedCompact?: Record<string, number>, settingsCheckMs?: number
   * }} [opts]
   *   home: Claude config directory (CLAUDE_CONFIG_DIR or ~/.claude; the registry lives in <home>/sessions), defaults to the parent of projectsDir;
   *   settingsPath: user settings, defaults to <home>/settings.json;
   *   observedCompact: observed compaction points learned by the extension, `${model}|${contextWindow}` → preTokens.
   */
  constructor(opts = {}) {
    this.projectsDir = opts.projectsDir || defaultProjectsDir(opts.env || process.env);
    this.home = opts.home || path.dirname(this.projectsDir);
    this.settingsPath = opts.settingsPath || path.join(this.home, 'settings.json');
    this.staleMinutes = opts.staleMinutes ?? 5;
    this.windowMs = (opts.activeWindowMinutes ?? 30) * 60e3;
    this.staleMs = this.staleMinutes * 60e3;
    this.lim = { ...DEFAULT_LIMITS, ...(opts.limits || {}), timeZone: opts.timeZone || undefined };
    this.guessMode = opts.approvalGuess || S.APPROVAL_GUESS.FAST_TOOLS;
    this.guessSeconds = opts.approvalGuessSeconds ?? S.APPROVAL_GUESS_DEFAULT_SECONDS;
    this.discoverMs = opts.discoverMs ?? 5000;
    this.env = opts.env || process.env;
    this.isAlive = opts.isAlive || undefined;
    this.readers = new Map();   // file → JsonlTail
    this.metas = new Map();     // meta.json → contents
    this.wfFiles = new Map();   // workflow state json → { mtimeMs, data }
    this.sessions = new Map();  // sessionId → { sid, proj, dir, main, tracked:Set, units }
    this.index = new Map();     // sessionId → { proj, main, dir } (every main transcript discovered)
    this.started = new Map();   // sort key: sid or sid/agentId → startedMs (never changes once set)
    this.lastDiscover = -Infinity;
    // Three layers of settings files (per session cwd); each file is stat'ed at most once every 5 seconds and re-read only when changed
    this.settingsCache = new context.SettingsCache({ checkMs: opts.settingsCheckMs });
    this.observedConfig = cleanObserved(opts.observedCompact);
    this.learned = new Map();   // auto-compaction points seen by this process itself: key → { ms, tokens } (only fills keys the extension did not provide)
    this.observed = { ...this.observedConfig };
    this.registry = { ok: false, live: new Map(), minVersion: null };
    this.minRegistryVersion = null;
    this.lastQuotaHit = null;
  }

  reader(file, kind) {
    let r = this.readers.get(file);
    if (!r) {
      const lim = this.lim;
      r = kind === 'journal'
        ? new JsonlTail(file, () => newJournal(lim), ingestJournal)
        : new JsonlTail(file, () => newState(lim, kind === 'main'), ingest);
      this.readers.set(file, r);
    }
    return r;
  }

  meta(file) {
    if (this.metas.has(file)) return this.metas.get(file);
    let v;
    try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } // not fully written yet; read again next time
    if (!v || typeof v !== 'object') v = {};
    this.metas.set(file, v);
    return v;
  }

  // Workflow state file: written only when a run ends (completed / aborted)
  workflowFile(file) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const cached = this.wfFiles.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached;
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return cached || null; }
    const v = { mtimeMs: st.mtimeMs, data: data && typeof data === 'object' ? data : {} };
    this.wfFiles.set(file, v);
    return v;
  }

  /**
   * Observed compaction points passed in by the extension (globalState agentMonitor.observedCompact). Changing them does not require rebuilding the provider.
   * @param {Record<string, number>} map
   */
  setObservedCompact(map) {
    this.observedConfig = cleanObserved(map);
    this.mergeObserved();
  }

  // Values from the extension take precedence; what this process learned only fills missing keys
  mergeObserved() {
    const out = {};
    for (const [k, v] of this.learned) out[k] = v.tokens;
    this.observed = Object.assign(out, this.observedConfig);
  }

  // Learn observed compaction points: auto-triggered, has preTokens, and the session's threshold was not changed by settings (otherwise the observed value reflects the user's setting)
  learnCompact(lc, window, settings) {
    if (!lc || lc.trigger !== 'auto' || !(lc.preTokens > 0) || !lc.model || !window) return;
    if (settings && (settings.autoCompactWindow != null || settings.autoCompactEnabled === false)) return;
    const key = context.observedKey(lc.model, window);
    const prev = this.learned.get(key);
    if (prev && prev.ms >= lc.ms) return;
    this.learned.set(key, { ms: lc.ms, tokens: lc.preTokens });
    this.mergeObserved();
  }

  pinStarted(key, candidate, now) {
    let v = this.started.get(key);
    if (v == null) {
      v = Number.isFinite(candidate) ? candidate : now;
      this.started.set(key, v);
      if (this.started.size > 50000) { // prevent unbounded growth: drop the earliest batch of entries
        let n = 10000;
        for (const k of this.started.keys()) { if (n-- <= 0) break; this.started.delete(k); }
      }
    }
    return v;
  }

  // Find sessions with recent activity: the main transcript, the session directory or the subagents directory changed within the window
  discover(now) {
    let projs;
    try { projs = fs.readdirSync(this.projectsDir, { withFileTypes: true }); } catch { return; }
    for (const p of projs) {
      if (!p.isDirectory()) continue;
      const projDir = path.join(this.projectsDir, p.name);
      for (const f of listDir(projDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const sid = f.slice(0, -6);
        const main = path.join(projDir, f);
        const dir = path.join(projDir, sid);
        if (!this.index.has(sid)) this.index.set(sid, { proj: p.name, main, dir });
        if (this.sessions.has(sid)) continue;
        const recent = [main, dir, path.join(dir, 'subagents'), path.join(dir, 'subagents', 'workflows')]
          .some((x) => now - mtimeOf(x) < this.windowMs);
        if (recent) this.track(sid, { proj: p.name, main, dir });
      }
    }
  }

  track(sid, loc) {
    const sess = { sid, proj: loc.proj, main: loc.main, dir: loc.dir, tracked: new Set(), units: null };
    this.sessions.set(sid, sess);
    return sess;
  }

  // Sessions alive in the registry but not yet tracked: derive the directory name from cwd; if not found, wait for the next discovery
  adoptLive(sid, entry) {
    let loc = this.index.get(sid);
    if (!loc && entry.cwd) {
      const proj = projectDirName(entry.cwd);
      const main = path.join(this.projectsDir, proj, sid + '.jsonl');
      if (mtimeOf(main)) { loc = { proj, main, dir: path.join(this.projectsDir, proj, sid) }; this.index.set(sid, loc); }
    }
    if (!loc) return null; // first line not written yet, or the directory name was truncated (found by sessionId on the next discovery)
    return this.track(sid, loc);
  }

  // agent-*.jsonl files to show in the directory: those written within the window, plus those this session has already shown (finished ones keep their place)
  agentFiles(sess, dir, now) {
    const out = [];
    for (const f of listDir(dir)) {
      if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      const mtimeMs = mtimeOf(file);
      if (!mtimeMs) continue;
      if (now - mtimeMs < this.windowMs || sess.tracked.has(file)) {
        sess.tracked.add(file);
        out.push({ file, mtimeMs });
      }
    }
    return out;
  }

  /**
   * Runs one scan.
   * @param {number} [now]
   * @param {{ keep?: Iterable<string> }} [opts] keep: sessions exempt from window filtering (sessionId or 'claude:<id>')
   * @returns {{ sessions: import('../core/status').Session[], quotaHit: any, registryOk: boolean }}
   */
  scan(now = Date.now(), opts = {}) {
    const keep = new Set();
    for (const k of opts.keep || []) keep.add(String(k).replace(/^claude:/, ''));
    this.registry = readRegistry(this.home, { isAlive: this.isAlive });
    const rv = this.registry.minVersion;
    if (rv && (!this.minRegistryVersion || cmpVersion(rv, this.minRegistryVersion) < 0)) this.minRegistryVersion = rv;
    if (now - this.lastDiscover >= this.discoverMs || now < this.lastDiscover) {
      this.discover(now);
      this.lastDiscover = now;
    }
    for (const [sid, entry] of this.registry.live) {
      if (!this.sessions.has(sid)) this.adoptLive(sid, entry);
    }
    const out = [];
    for (const [sid, sess] of [...this.sessions]) {
      const live = this.registry.live.get(sid) || null;
      let built = null;
      try {
        built = this.buildSession(sess, now, live);
      } catch (err) {
        // An error in one session does not affect the others; its readers are kept (not released, so large files are not re-read on every discovery)
        this.lastError = err;
        continue;
      }
      if (!built) { this.drop(sid, sess); continue; }
      const inWindow = now - built.updatedMs < this.windowMs;
      if (!inWindow && !live && !keep.has(sid)) { this.drop(sid, sess); continue; }
      out.push(built);
    }
    out.sort((a, b) => (b.startedMs - a.startedMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { sessions: out, quotaHit: this.lastQuotaHit, registryOk: this.registry.ok };
  }

  // Whether the session has a "registry signal": alive in the registry with a status; or the registry is available, this session's version registers, yet it is not in the registry (process has exited)
  registrySignal(live, version) {
    if (live) return live.status != null;
    if (!this.registry.ok || !this.minRegistryVersion || !version) return false;
    return quota.versionAtLeast(version, this.minRegistryVersion);
  }

  buildSession(sess, now, live) {
    const mainFile = sess.main;
    if (!mtimeOf(mainFile)) return null; // main transcript is gone
    const subDir = path.join(sess.dir, 'subagents');
    const units = [];

    // Read subagents and workflows first (so that when the parent's result line is read, the subagent's last line has already been read too)
    for (const x of this.agentFiles(sess, subDir, now)) {
      const r = this.reader(x.file, 'agent');
      r.poll();
      const id = agentIdOf(x.file);
      const meta = this.meta(x.file.replace(/\.jsonl$/, '.meta.json')) || {};
      units.push({ id, kind: 'subagent', r, meta, file: x.file, wf: null });
    }
    const wfUnits = [];
    const wfRoot = path.join(subDir, 'workflows');
    for (const wf of listDir(wfRoot)) {
      if (!wf.startsWith('wf_')) continue;
      const wfDir = path.join(wfRoot, wf);
      const files = this.agentFiles(sess, wfDir, now);
      if (!files.length) continue;
      const jr = this.reader(path.join(wfDir, 'journal.jsonl'), 'journal');
      jr.poll();
      const j = jr.state;
      const wfNewest = Math.max(jr.mtimeMs, ...files.map((x) => x.mtimeMs));
      // Only a state file newer than all agent activity means this run has ended; otherwise it is being resumed
      const info = this.workflowFile(path.join(sess.dir, 'workflows', wf + '.json'));
      const ended = info && typeof info.data.status === 'string' && info.mtimeMs >= wfNewest - 5000 ? info.data.status : null;
      const group = { id: wf, j, jr, info, ended, killed: !!(ended && KILLED_RE.test(ended)), newest: wfNewest, units: [] };
      for (const x of files) {
        const id = agentIdOf(x.file);
        const k = j.keyOf.get(id);
        if (k && j.latest.get(k) !== id) continue; // old agents replaced by a resumed run are not shown
        const r = this.reader(x.file, 'agent');
        r.poll();
        const meta = this.meta(x.file.replace(/\.jsonl$/, '.meta.json')) || {};
        const u = { id, kind: 'workflowAgent', r, meta, file: x.file, wf: group };
        group.units.push(u);
        units.push(u);
      }
      if (group.units.length) wfUnits.push(group);
    }
    const mainR = this.reader(mainFile, 'main');
    mainR.poll();
    if (!mainR.mtimeMs) return null;
    const ms = mainR.state;
    const mainUnit = { id: 'main', kind: 'main', r: mainR, meta: {}, file: mainFile, wf: null };

    const guess = {
      mode: this.guessMode,
      seconds: this.guessSeconds,
      staleMinutes: this.staleMinutes,
      hasRegistry: this.registrySignal(live, ms.version),
    };
    const busy = !!(live && live.status === S.LIVE_STATUS.BUSY);

    // Subagents / workflow agents
    for (const u of units) {
      const s = u.r.state;
      // Foreground subagent: the parent's Agent call was interrupted / ended with an error while pending → it will not move again
      const tuid = u.kind === 'subagent' && typeof u.meta.toolUseId === 'string' ? u.meta.toolUseId : null;
      const parentGoneMs = tuid && ms.cancelled.has(tuid) ? ms.cancelled.get(tuid) : null;
      u.status = classify(s, {
        now,
        staleMs: this.staleMs,
        mtimeMs: u.r.mtimeMs,
        isMain: false,
        journalDone: !!(u.wf && u.wf.j.done.has(u.id)),
        journalFailed: !!(u.wf && u.wf.j.failed.has(u.id)),
        killed: !!(u.wf && u.wf.killed),
        parentGoneMs,
        guess,
      });
    }
    const bgRunning = units.some((u) => busyCode(u.status.code));
    mainUnit.status = classify(ms, {
      now, staleMs: this.staleMs, mtimeMs: mainR.mtimeMs, isMain: true, bgRunning, busy, guess,
    });
    const all = [mainUnit, ...units];
    this.applyRegistry(all, mainUnit, live, bgRunning, now);

    // Assemble Agents. Window and compaction point: the three settings layers are read per session cwd; cost-state keys decide [1m]
    const key = S.sessionKey('claude', sess.sid);
    const cwd = (live && live.cwd) || ms.cwd || null;
    const ctxOpts = {
      settings: context.claudeCompactSettings(this.settingsCache, cwd, this.settingsPath, now),
      costKeys: ms.costState ? ms.costState.keys : null,
    };
    for (const u of all) {
      u.agent = this.agentObj(u, sess.sid, now, ctxOpts);
      const hit = u.r.state.apiError && u.r.state.apiError.quota;
      if (hit && (!this.lastQuotaHit || u.r.state.apiError.ts > this.lastQuotaHit.ms)) {
        this.lastQuotaHit = { ...hit, ms: u.r.state.apiError.ts, sessionKey: key };
      }
    }
    const main = mainUnit.agent;
    const agents = units.filter((u) => u.kind === 'subagent').map((u) => u.agent).sort(byStart);
    const workflows = wfUnits.map((g) => this.workflowObj(g, ms, sess.sid, now)).sort(byStart);

    let updatedMs = mainR.mtimeMs;
    for (const u of units) updatedMs = Math.max(updatedMs, u.r.mtimeMs || 0);
    for (const g of wfUnits) updatedMs = Math.max(updatedMs, g.newest || 0);

    const counts = { running: 0, awaiting: 0, error: 0, done: 0, total: 0 };
    for (const u of all) {
      const code = u.agent.status.code;
      counts.total++;
      if (S.isRunningCode(code)) counts.running++;
      else if (S.isNeedsYouCode(code)) counts.awaiting++;
      else if (S.isErrorCode(code)) counts.error++;
      else if (code === STATUS.DONE) counts.done++;
    }
    const cost = sumCost(all.map((u) => u.agent));
    const entrypoint = (live && live.entrypoint) || ms.entrypoint || null;
    const cacheTtl = main.cacheTtl || '1h'; // not detectable: the main conversation defaults to 1h (subscription default)
    const cacheTtlMs = pricing.TTL_MS[cacheTtl];
    let title = null;
    let titleSource = 'id';
    if (ms.customTitle) { title = ms.customTitle; titleSource = 'custom'; }
    else if (ms.title) { title = ms.title; titleSource = 'ai'; }
    else if (ms.lastPrompt) { title = oneLine(ms.lastPrompt, 40); titleSource = 'prompt'; }
    else title = sess.sid.slice(0, 8);

    const session = {
      key,
      provider: 'claude',
      id: sess.sid,
      title,
      titleSource,
      cwd,
      projectDir: sess.proj,
      entry: entryOf(ms.entrypoint || entrypoint),
      entryRaw: ms.entrypoint || null,
      entrypoint,
      version: ms.version || null,
      model: ms.model || null,
      createdMs: ms.firstMsgTs,
      updatedMs,
      startedMs: this.pinStarted(sess.sid, ms.firstTs, now),
      doneAtMs: ms.turnEndTs,
      live: !!live,
      liveStatus: live ? live.status : null,
      waitingFor: live && live.status === S.LIVE_STATUS.WAITING ? live.waitingFor : null,
      compactCount: ms.compactCount,
      compactLoop: S.compactLoopOf(ms.compactTimes, main.lastActivityMs),
      // follow the main conversation (same as main.tokens)
      contextUsed: main.tokens.contextUsed,
      modelVariant: mainUnit.ctx.modelVariant,
      contextWindow: main.tokens.contextWindow,
      contextWindowSource: mainUnit.ctx.contextWindowSource,
      compactAt: main.tokens.compactAt,
      compactAtSource: mainUnit.ctx.compactAtSource,
      autoCompactWindow: mainUnit.ctx.autoCompactWindow,
      contextPct: main.tokens.contextPct,
      cacheTtl,
      cacheTtlInferred: !main.cacheTtl,
      cacheTtlMs,
      lastApiMs: main.lastApiMs,
      cacheExpiresMs: main.lastApiMs ? main.lastApiMs + cacheTtlMs : null,
      lastActivityMs: main.lastActivityMs,
      main,
      agents,
      workflows,
      counts,
      costUsd: cost.costUsd,
      unpricedModel: cost.unpricedModel,
      ccCostUsd: ms.costState ? ms.costState.totalCostUSD : null, // computed by Claude Code itself
      transcript: mainFile,
      resume: [],
    };
    session.resume = resume.resumeHints(session, { now });
    sess.units = all;
    return session;
  }

  // The registry's certain status overrides the status inferred from the transcript
  applyRegistry(all, mainUnit, live, bgRunning, now) {
    if (!live || !live.status) return;
    if (live.status === S.LIVE_STATUS.WAITING) {
      // Find the agent that is really waiting: the most recently issued non-container tool call; when waiting for an answer, prefer one with a pending question tool
      const wantQuestion = live.waitingFor === S.WAITING_FOR.INPUT;
      let best = null;
      for (const pass of wantQuestion ? [true, false] : [false]) {
        for (const u of all) {
          if (S.STOPPED_CODES.has(u.status.code)) continue;
          for (const p of u.r.state.pending.values()) {
            if (CONTAINER_TOOLS.has(p.tool)) continue;
            if (pass && !QUESTION_TOOLS[p.tool]) continue;
            if (!best || p.sinceMs >= best.p.sinceMs) best = { u, p };
          }
        }
        if (best) break;
      }
      const target = best ? best.u : mainUnit;
      const fallback = best ? best.p.sinceMs : Math.max(target.r.mtimeMs || 0, target.r.state.lastTs || 0);
      const st = S.statusFromRegistry(live, fallback);
      if (st) {
        if (best) st.pendingTool = best.p.tool;
        if (st.code === STATUS.AWAITING_INPUT && best && QUESTION_TOOLS[best.p.tool]) st.question = QUESTION_TOOLS[best.p.tool];
        // Dialog shown after hitting a usage limit: status follows the registry, but the quota info (reset time) is kept
        if (target.status.quota) st.quota = target.status.quota;
        target.status = st;
      }
      return;
    }
    const code = mainUnit.status.code;
    // The process says busy but the transcript shows the turn has ended: work is still going on in the background (background commands, workflows, a just-submitted prompt not yet written) → count as running
    if (live.status === S.LIVE_STATUS.BUSY && code === STATUS.DONE) {
      mainUnit.status = makeStatus(STATUS.IDLE_BACKGROUND, mainUnit.status.sinceMs);
      return;
    }
    const inFlight = S.isRunningCode(code) || code === STATUS.STALE || code === STATUS.MAYBE_AWAITING_APPROVAL;
    // The process says idle, and that idle is newer than the transcript's last line: this turn has ended (the transcript has no end line, e.g. an internal process error).
    // Not trusted when the transcript is newer than the registry (a just-submitted prompt; the registry has not switched to busy yet).
    const lastTs = mainUnit.r.state.lastTs || 0;
    if (live.status === S.LIVE_STATUS.IDLE && inFlight && code !== STATUS.IDLE_BACKGROUND
      && live.statusUpdatedAt && live.statusUpdatedAt >= lastTs) {
      mainUnit.status = makeStatus(bgRunning ? STATUS.IDLE_BACKGROUND : STATUS.DONE, live.statusUpdatedAt);
    }
  }

  agentObj(u, sid, now, ctxOpts = {}) {
    const s = u.r.state;
    const model = s.model || (typeof u.meta.model === 'string' ? u.meta.model : null);
    const contextUsed = s.ctxOverride ? s.ctxOverride.tokens : inputSide(s.lastUsage);
    const display = s.ctxOverride ? s.ctxOverride.tokens : contextUsed + int(s.lastUsage && s.lastUsage.output_tokens);
    // Subagents use the same compaction logic (see the Claude Code sub-agents docs, "Auto-compaction"): the same settings and the same cost-state keys
    const ctx = context.claudeContext(model, contextUsed, ctxOpts.settings, { costKeys: ctxOpts.costKeys, observed: this.observed });
    u.ctx = ctx;
    let lastCompact = null;
    if (s.lastCompact) {
      const lc = s.lastCompact;
      const lcWindow = !lc.model ? null
        : lc.model === model ? ctx.contextWindow
          : context.resolveClaudeWindow(lc.model, lc.preTokens || 0, ctxOpts.costKeys).contextWindow;
      lastCompact = { ...lc, contextWindow: lcWindow };
      this.learnCompact(lastCompact, lcWindow, ctxOpts.settings);
    }
    const jr = u.wf ? u.wf.j : null;
    return {
      id: u.id,
      kind: u.kind,
      name: u.kind === 'main' ? null : (strOr(u.meta.description) || (jr && jr.labels.get(u.id)) || null),
      agentType: strOr(u.meta.agentType),
      phase: strOr(u.meta.workflowPhase) || (jr && jr.phases.get(u.id)) || null,
      background: u.meta.requestShape === 'background',
      model,
      status: u.status,
      step: stepOf(s),
      tokens: {
        display,
        contextUsed,
        contextWindow: ctx.contextWindow,
        compactAt: ctx.compactAt,
        toCompact: ctx.toCompact,
        contextPct: ctx.contextPct,
        output: s.outSum,
        processed: s.procSum,
        apiCalls: s.apiCalls,
      },
      toolCalls: s.toolCalls,
      toolErrors: s.toolErrors,
      filesChanged: s.files.size,
      costUsd: s.pricedCalls > 0 ? s.costSum : (s.apiCalls > 0 ? null : 0),
      costEstimated: s.costEstimated,
      unpricedModel: s.unpricedModel,
      lastCompact,
      cacheTtl: s.lastUsageTtl,
      startedMs: this.pinStarted(u.kind === 'main' ? `${sid}/main` : `${sid}/${u.id}`, s.firstTs, now),
      lastActivityMs: Math.max(u.r.mtimeMs || 0, s.lastTs || 0),
      lastApiMs: s.lastUsageTs,
      mtimeMs: u.r.mtimeMs,
      file: u.file,
    };
  }

  workflowObj(g, ms, sid, now) {
    const agents = g.units.map((u) => u.agent).sort(byStart);
    const data = (g.info && g.info.data) || {};
    const fromMain = ms.wfInfo.get(g.id) || {};
    const running = agents.filter((a) => busyCode(a.status.code));
    const done = agents.filter((a) => a.status.code === STATUS.DONE).length;
    let state;
    if (running.length) state = 'running';
    else if (g.ended) state = g.killed ? 'killed' : 'completed';
    else if (agents.some((a) => a.status.code === STATUS.QUOTA)) state = 'paused'; // Claude Code v2.1.271+ pauses on a usage limit until the reset
    else if (done === agents.length) state = 'completed';
    else state = 'stale';
    const cost = sumCost(agents);
    const first = agents.reduce((m, a) => Math.min(m, a.startedMs), Infinity);
    return {
      id: g.id,
      taskId: strOr(data.taskId),
      name: strOr(data.workflowName) || fromMain.name || g.id,
      scriptPath: strOr(data.scriptPath) || fromMain.scriptPath || null,
      state,
      phases: [...new Set(running.map((a) => a.phase).filter(Boolean))],
      done,
      total: agents.length,
      running: running.length,
      tokens: agents.reduce((t, a) => t + a.tokens.display, 0),
      outTokens: agents.reduce((t, a) => t + a.tokens.output, 0),
      costUsd: cost.costUsd,
      startedMs: this.pinStarted(`${sid}/${g.id}`, Number.isFinite(first) ? first : null, now),
      agents,
    };
  }

  /**
   * Details of the selected session. Uses in-memory state only; never re-reads files.
   * @param {string} idOrKey sessionId or 'claude:<id>'
   * @returns {import('../core/status').SessionDetail|null}
   */
  detail(idOrKey) {
    const sid = String(idOrKey || '').replace(/^claude:/, '');
    const sess = this.sessions.get(sid);
    if (!sess || !sess.units) return null;
    const n = this.lim.timelineSent;
    const agents = {};
    for (const u of sess.units) {
      const s = u.r.state;
      let result = null;
      const jres = u.wf && u.wf.j.results.get(u.id);
      const lastMs = Math.max(u.r.mtimeMs || 0, s.lastTs || 0);
      if (jres && jres.text) result = { text: jres.text, truncated: jres.truncated, ms: lastMs, source: 'journal' };
      else if (u.kind === 'workflowAgent' && s.structured && s.structured.text) result = { text: s.structured.text, truncated: s.structured.truncated, ms: s.submittedTs || lastMs, source: 'structuredOutput' };
      else if (s.lastText) result = { text: s.lastText.text, truncated: s.lastText.truncated, ms: s.lastText.ms, source: 'lastText' };
      agents[u.id] = {
        timeline: s.timeline.slice(-n).map((ev) => ({ ms: ev.ms, kind: ev.kind, tool: ev.tool ?? null, detail: ev.detail ?? null })),
        result,
        files: [...s.files].map(([p, f]) => ({ path: p, op: f.op, count: f.count, lastMs: f.lastMs, movedTo: f.movedTo }))
          .sort((a, b) => b.lastMs - a.lastMs),
        errors: s.errors.map((x) => ({ ms: x.ms, tool: x.tool, text: x.text })),
      };
    }
    return { key: S.sessionKey('claude', sid), agents };
  }

  has(idOrKey) {
    return this.sessions.has(String(idOrKey || '').replace(/^claude:/, ''));
  }

  // Session expired: release its readers (the sort key is kept, so it returns to the same position)
  drop(sid, sess) {
    this.sessions.delete(sid);
    const under = (f) => f === sess.main || f.startsWith(sess.dir + path.sep);
    for (const m of [this.readers, this.metas, this.wfFiles]) {
      for (const f of [...m.keys()]) if (under(f)) m.delete(f);
    }
  }

  dispose() {
    this.readers.clear();
    this.metas.clear();
    this.wfFiles.clear();
    this.sessions.clear();
  }
}

function strOr(v) { return typeof v === 'string' && v ? v : null; }

/**
 * Observed compaction point table: keeps only positive finite numbers
 * @param {any} map
 * @returns {Record<string, number>}
 */
function cleanObserved(map) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [k, v] of Object.entries(map)) {
    const n = Number(v);
    if (typeof k === 'string' && k && Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}
function byStart(a, b) { return (a.startedMs - b.startedMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

module.exports = {
  ClaudeProvider,
  DEFAULT_LIMITS,
  defaultProjectsDir,
  projectDirName,
  entryOf,
  describeInput,
  // for tests
  cleanObserved,
  _internal: { newState, ingest, classify, stepOf, newJournal, ingestJournal, INTERRUPT_RE, LOCAL_CMD_RE },
};
