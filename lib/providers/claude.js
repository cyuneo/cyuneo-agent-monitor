'use strict';
// Claude Code provider（DESIGN §4.1–4.3、§5、§6.1、§7、§11.1、§11.10）。
// 读 <projectsDir> 下 Claude Code 自己写的 jsonl 记录 + <claudeHome>/sessions 在线登记表，
// 产出 Session / Agent / Workflow（§2）与 SessionDetail（§2.7）。
// 只出代码、数字、时间戳和原文片段，不产出任何界面文字（文字由 format 层按语言拼）。
// 纯 Node，不依赖 vscode；worker、终端版都能用。只读，不写任何 Claude 的文件。

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

// 用户打断：[Request interrupted by user] / [Request interrupted by user for tool use]
const INTERRUPT_RE = /^\s*\[Request interrupted by user/;
// 本地斜杠命令、! 命令的回显行：不开始模型回合，不改变状态
const LOCAL_CMD_RE = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/;
// 工作流状态文件里表示“被停掉”的状态
const KILLED_RE = /kill|fail|abort|error|cancel/i;
// 工作流运行 id
const WF_RUN_RE = /\bwf_[0-9a-f]+(?:-[0-9a-f]+)?\b/;
// 改文件的工具（§5）
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// 在等用户回答的工具（§4.2 第 8 条）
const QUESTION_TOOLS = { AskUserQuestion: 'askUser', ExitPlanMode: 'planApproval' };
// “容器”工具：挂着它表示在等子智能体 / 工作流，不是在等批准
const CONTAINER_TOOLS = new Set(['Agent', 'Task', 'Workflow']);
// 工作流的“在跑”：在跑或在等你处理
function busyCode(code) { return S.isRunningCode(code) || S.isNeedsYouCode(code); }

function defaultProjectsDir(env = process.env) {
  if (env && env.CLAUDE_CONFIG_DIR) return path.join(env.CLAUDE_CONFIG_DIR, 'projects');
  return path.join(os.homedir(), '.claude', 'projects');
}

// ---------------------------------------------------------------------------
// 单个记录文件的状态（§4.2）
// ---------------------------------------------------------------------------

function newState(lim, isMain) {
  return {
    lim,
    isMain: !!isMain,
    firstTs: null,        // 第一条带时间戳的行（任何类型）：排序键 startedMs 的来源
    firstMsgTs: null,     // 第一条 user / assistant：createdMs
    lastTs: null,
    title: null, customTitle: null, lastPrompt: null,
    entrypoint: null, cwd: null, version: null,
    model: null,          // 最近一条非 synthetic assistant 的模型
    lastRole: null,       // 'user' | 'assistant'
    sawAssistant: false,
    stopReason: null,
    interrupted: false, interruptTs: null,
    promptTs: null,
    turnEndTs: null,      // 最近一次“一轮结束”（stop_reason 非 tool_use）
    doneMsgId: null,
    lastUsage: null, lastUsageTs: null,
    lastUsageTtl: null,   // '5m' | '1h'：最近一次有缓存写入的 usage 推出的档位（§7.3）
    ctxOverride: null,    // 压缩后、下一次调用前的上下文占用（compact_boundary.postTokens）
    msgs: new Map(),      // message.id → { out, proc, usd }（同一消息分多行写，取最后一次）
    outSum: 0, procSum: 0, apiCalls: 0,
    costSum: 0, pricedCalls: 0, unpricedModel: null, costEstimated: false,
    toolNames: new Map(), // tool_use id → 工具名
    pending: new Map(),   // tool_use id → { tool, detail, sinceMs }：已发出、还没结果
    cancelled: new Map(), // 被打断 / 报错结束的 Agent·Task 调用 id → 时间（前台子智能体随之停下）
    toolCalls: 0, toolErrors: 0,
    lastEvent: null,      // { kind, tool, detail, ts }
    prevTool: null,
    submitted: false, submittedTs: null,
    structured: null,     // StructuredOutput 的 input（截断后的文字）
    wfPending: new Map(), // Workflow 工具调用 id → { name, scriptPath }
    wfInfo: new Map(),    // runId → { name, scriptPath }
    apiError: null,       // { ts, quota: QuotaHit|null, error }
    retry: null,          // { attempt, max, inMs, ts }
    lastCompact: null,    // { ms, trigger, preTokens, postTokens, model }
    compactCount: 0, compactTimes: [], // §11.8 第 2 条
    costState: null,      // §11.10 最后一条 cost-state：{ totalCostUSD, keys }（只看主记录）
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
  if (s.isMain && e.isSidechain === true) return; // 老版本把子智能体的行也写进主记录
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

// §11.10：Claude Code 自己记的本会话累计费用与各模型用量。modelUsage 的键带真实变体（例如 'claude-opus-5-5[1m]'），
// 用来判断窗口；totalCostUSD 是 Claude Code 自己算的费用。只认主记录里的，取最后一条。
function ingestCostState(s, e) {
  if (!s.isMain) return;
  const mu = e.modelUsage && typeof e.modelUsage === 'object' && !Array.isArray(e.modelUsage) ? e.modelUsage : {};
  s.costState = { totalCostUSD: num(e.totalCostUSD), keys: Object.keys(mu) };
}

function ingestSystem(s, e, ts) {
  if (e.subtype === 'api_error') {
    // 正在重试：记下第几次，下一条 assistant 清掉
    s.retry = { attempt: num(e.retryAttempt), max: num(e.maxRetries), inMs: num(e.retryInMs), ts };
    const detail = s.retry.attempt != null ? `${s.retry.attempt}/${s.retry.max ?? '?'}` : null;
    pushTimeline(s, { ms: ts, kind: 'retry', tool: null, detail });
  } else if (e.subtype === 'compact_boundary') {
    const md = e.compactMetadata && typeof e.compactMetadata === 'object' ? e.compactMetadata : {};
    const trigger = md.trigger === 'auto' || md.trigger === 'manual' ? md.trigger : null;
    // model：压缩时主对话的模型（学习实测压缩点用，§11.12.2）
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
    // §1.3 修 bug：API 报错行不计调用、不覆盖 lastUsage / stopReason，走 §4.2 的报错规则
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
        // 结果：最后一条有文字的 assistant 消息的全部 text 块
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
  // 用户自己拒绝 / 打断的工具调用：结果带 is_error，但不算工具报错
  const interruptHere = !!content && content.some((c) => c && c.type === 'text' && typeof c.text === 'string' && INTERRUPT_RE.test(c.text));
  const denied = interruptHere ? 'interrupt' : (e.toolDenialKind ? 'denied' : null);
  for (const c of content || []) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'tool_result') { results++; handleResult(s, e, c, ts, content.length, denied); }
    else if (c.type === 'text' && typeof c.text === 'string') { if (text == null) text = c.text; }
    else others++;
  }
  if (e.isCompactSummary) return; // 压缩摘要不是提示（compact_boundary 已经记过）
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
  if (text != null && LOCAL_CMD_RE.test(text)) return; // 本地命令（/compact、/model、! 命令…）
  if (text == null && others === 0) return;
  // 新的提示（含 <task-notification> 这类由 Claude Code 注入、会开始新一轮的消息）
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
  // 打断时紧跟着会记 interrupt，这里不再记一条
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
    f.op = op; // 先新建后改仍算新建
  }
  f.count++;
  f.lastMs = ts;
}

function pushTimeline(s, ev) {
  const tl = s.timeline;
  const last = tl[tl.length - 1];
  if (ev.kind === 'thinking' && last && last.kind === 'thinking') return; // 连续思考合并
  tl.push(ev);
  if (tl.length > s.lim.timeline) tl.splice(0, tl.length - s.lim.timeline);
}

// ---------------------------------------------------------------------------
// 工作流日志 journal.jsonl：started / result / failed
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
// 状态判定（§4.2 + 决定 4 + §11.1）
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
  // 1、2：API 报错（撞额度 / 其它）
  if (s.apiError) {
    if (s.apiError.quota) return makeStatus(STATUS.QUOTA, s.apiError.ts, { quota: s.apiError.quota });
    return makeStatus(STATUS.API_ERROR, s.apiError.ts, { error: s.apiError.error });
  }
  // 3：正在重试
  if (s.retry) {
    return makeStatus(STATUS.RETRYING, s.retry.ts, { retry: { attempt: s.retry.attempt ?? 0, max: s.retry.max ?? 0, inMs: s.retry.inMs } });
  }
  // 4：用户打断
  if (s.interrupted) return makeStatus(STATUS.INTERRUPTED, s.interruptTs ?? lastActivity);
  // 5：这一轮结束
  if (s.lastRole === 'assistant' && s.stopReason && s.stopReason !== 'tool_use' && s.pending.size === 0) {
    return makeStatus(c.isMain && c.bgRunning ? STATUS.IDLE_BACKGROUND : STATUS.DONE, s.turnEndTs ?? lastActivity);
  }
  // 6：工作流智能体交了结果
  if ((s.submitted && s.pending.size === 0) || c.journalDone) return makeStatus(STATUS.DONE, s.submittedTs ?? lastActivity);
  // journal 里记了 failed（它自己的记录判出 quota 的已在上面返回）
  if (c.journalFailed) return makeStatus(STATUS.API_ERROR, lastActivity, { error: { kind: 'workflowAgentFailed', http: null, message: null } });
  // 7：工作流被停掉
  if (c.killed) return makeStatus(STATUS.KILLED, lastActivity);
  // 8：在等用户回答（提问、计划批准）——不会变成 stale
  let q = null;
  for (const p of s.pending.values()) {
    if (QUESTION_TOOLS[p.tool] && (!q || p.sinceMs >= q.sinceMs)) q = p;
  }
  if (q) return makeStatus(STATUS.AWAITING_INPUT, q.sinceMs, { question: QUESTION_TOOLS[q.tool], pendingTool: q.tool });
  // 前台子智能体：父智能体的那次调用已经结束（被打断 / 被停掉），它不会再动
  if (c.parentGoneMs != null) return makeStatus(STATUS.INTERRUPTED, c.parentGoneMs);
  // 决定 4：快工具久无结果 → 可能在等你批准（登记表有信号的会话不推测）
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
  // 10：本该在跑却很久没写记录（登记表说 busy 时不判）
  if (!c.busy && now - lastActivity > c.staleMs) {
    return makeStatus(STATUS.STALE, lastActivity, { stalePending: s.pending.size > 0, pendingTool: latest ? latest.tool : null });
  }
  // 9：收到任务、还没有模型输出
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

/** 当前步骤（§2.6）。没有任何事件时返回 null。 */
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
// 工具参数 → 一行摘要（原文，不翻译；§2.6 detail）
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

// 截断到 max 个字符，标记是否截断
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
// 其它小工具
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

// VS Code 工作区路径 → projects 下的目录名（非字母数字一律换成 -）
function projectDirName(p) {
  return String(p || '').replace(/[^a-zA-Z0-9]/g, '-');
}

// 记录的 entrypoint → Session.entry
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
   *   home：Claude 配置目录（CLAUDE_CONFIG_DIR 或 ~/.claude；登记表在 <home>/sessions），默认 projectsDir 的上一级；
   *   settingsPath：用户设置，默认 <home>/settings.json；
   *   observedCompact：扩展学到的实测压缩点 `${model}|${contextWindow}` → preTokens（§11.10）。
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
    this.readers = new Map();   // 文件 → JsonlTail
    this.metas = new Map();     // meta.json → 内容
    this.wfFiles = new Map();   // 工作流状态 json → { mtimeMs, data }
    this.sessions = new Map();  // sessionId → { sid, proj, dir, main, tracked:Set, units }
    this.index = new Map();     // sessionId → { proj, main, dir }（发现过的全部主记录）
    this.started = new Map();   // 排序键：sid 或 sid/agentId → startedMs（一旦定下不再变）
    this.lastDiscover = -Infinity;
    // §11.10：三层设置文件（按会话 cwd），每个文件最多 5 秒 stat 一次、变了才重读
    this.settingsCache = new context.SettingsCache({ checkMs: opts.settingsCheckMs });
    this.observedConfig = cleanObserved(opts.observedCompact);
    this.learned = new Map();   // 本进程里自己看到的自动压缩点：键 → { ms, tokens }（只补扩展没给的键）
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
    try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } // 还没写完，下次再读
    if (!v || typeof v !== 'object') v = {};
    this.metas.set(file, v);
    return v;
  }

  // 工作流状态文件：一次运行结束（完成 / 中止）时才写
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
   * 扩展传来的实测压缩点（globalState agentMonitor.observedCompact）。换了不需要重建 provider。
   * @param {Record<string, number>} map
   */
  setObservedCompact(map) {
    this.observedConfig = cleanObserved(map);
    this.mergeObserved();
  }

  // 扩展给的优先；本进程学到的只补没有的键
  mergeObserved() {
    const out = {};
    for (const [k, v] of this.learned) out[k] = v.tokens;
    this.observed = Object.assign(out, this.observedConfig);
  }

  // 学实测压缩点：自动触发、有 preTokens、会话没有被设置改过阈值（否则实测值反映的是用户设定）
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
      if (this.started.size > 50000) { // 防止无限增长：丢掉最早登记的一批
        let n = 10000;
        for (const k of this.started.keys()) { if (n-- <= 0) break; this.started.delete(k); }
      }
    }
    return v;
  }

  // 找最近有动静的会话：主记录、会话目录、subagents 目录任一在窗口内变过（沿用 v0.2）
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

  // 登记表里存活、但还没在跟踪的会话：按 cwd 推目录名，找不到就等下一次发现
  adoptLive(sid, entry) {
    let loc = this.index.get(sid);
    if (!loc && entry.cwd) {
      const proj = projectDirName(entry.cwd);
      const main = path.join(this.projectsDir, proj, sid + '.jsonl');
      if (mtimeOf(main)) { loc = { proj, main, dir: path.join(this.projectsDir, proj, sid) }; this.index.set(sid, loc); }
    }
    if (!loc) return null; // 还没写第一行，或目录名被截断（下一次发现时按 sessionId 找到）
    return this.track(sid, loc);
  }

  // 目录里要显示的 agent-*.jsonl：窗口内写过的，加上这个会话已经显示过的（已完成的留在原位，§11.3）
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
   * 扫一遍。
   * @param {number} [now]
   * @param {{ keep?: Iterable<string> }} [opts] keep：不做窗口过滤的会话（sessionId 或 'claude:<id>'）
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
        // 单个会话出错不影响其它会话；读取器保留（不释放，免得每次发现都重读大文件）
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

  // 会话有没有“登记表信号”：登记表里存活且有状态；或本机登记表可用、这个会话的版本会登记、却不在表里（进程已退出）
  registrySignal(live, version) {
    if (live) return live.status != null;
    if (!this.registry.ok || !this.minRegistryVersion || !version) return false;
    return quota.versionAtLeast(version, this.minRegistryVersion);
  }

  buildSession(sess, now, live) {
    const mainFile = sess.main;
    if (!mtimeOf(mainFile)) return null; // 主记录没了
    const subDir = path.join(sess.dir, 'subagents');
    const units = [];

    // 先读子智能体和工作流（保证读到父智能体的结果行时，子智能体的最后一行也已读到）
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
      // 状态文件比所有智能体的活动都新，才说明这次运行已经结束；否则是续跑中
      const info = this.workflowFile(path.join(sess.dir, 'workflows', wf + '.json'));
      const ended = info && typeof info.data.status === 'string' && info.mtimeMs >= wfNewest - 5000 ? info.data.status : null;
      const group = { id: wf, j, jr, info, ended, killed: !!(ended && KILLED_RE.test(ended)), newest: wfNewest, units: [] };
      for (const x of files) {
        const id = agentIdOf(x.file);
        const k = j.keyOf.get(id);
        if (k && j.latest.get(k) !== id) continue; // 被续跑替换掉的旧智能体不显示
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

    // 子智能体 / 工作流智能体
    for (const u of units) {
      const s = u.r.state;
      // 前台子智能体：父智能体那次 Agent 调用在挂着时被打断 / 报错结束 → 它不会再动
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

    // 组装 Agent。窗口与压缩点（§11.10）：三层设置按会话 cwd 读；cost-state 的键判断 [1m]
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
    const cacheTtl = main.cacheTtl || '1h'; // 检测不到：主对话按订阅默认 1h（§11.5）
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
      // §11.10：以主对话为准（与 main.tokens 一致）
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
      ccCostUsd: ms.costState ? ms.costState.totalCostUSD : null, // §11.10 Claude Code 自己算的
      transcript: mainFile,                                          // §11.11
      resume: [],
    };
    session.resume = resume.resumeHints(session, { now });
    sess.units = all;
    return session;
  }

  // §11.1：登记表的确定状态盖过记录推出来的状态
  applyRegistry(all, mainUnit, live, bgRunning, now) {
    if (!live || !live.status) return;
    if (live.status === S.LIVE_STATUS.WAITING) {
      // 找真正在等的那个智能体：挂着非容器工具、最近发出的；等回答时优先挂着提问工具的
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
        // 撞额度后弹出的对话框：状态按登记表，额度信息（重置时间）保留下来
        if (target.status.quota) st.quota = target.status.quota;
        target.status = st;
      }
      return;
    }
    const code = mainUnit.status.code;
    // 进程说 busy、记录却显示这一轮已结束：后台还有活（后台命令、工作流、刚提交的提示还没写进记录）→ 算在跑
    if (live.status === S.LIVE_STATUS.BUSY && code === STATUS.DONE) {
      mainUnit.status = makeStatus(STATUS.IDLE_BACKGROUND, mainUnit.status.sinceMs);
      return;
    }
    const inFlight = S.isRunningCode(code) || code === STATUS.STALE || code === STATUS.MAYBE_AWAITING_APPROVAL;
    // 进程说空闲、且这个空闲比记录最后一行还新：这一轮已经结束（记录里没写结束行，例如进程内部出错）。
    // 记录比登记表新时不采信（刚提交的提示，登记表还没来得及改成 busy）。
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
    // 子智能体用同样的压缩逻辑【文档 sub-agents#auto-compaction】：同一套设置、同一份 cost-state 键
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
    else if (agents.some((a) => a.status.code === STATUS.QUOTA)) state = 'paused'; // v2.1.271+ 撞额度会暂停等重置
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
   * 选中会话的细节（§2.7）。只用内存里的状态，不重读文件。
   * @param {string} idOrKey sessionId 或 'claude:<id>'
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

  // 会话过期：释放它占的读取器（排序键保留，回来时位置不变）
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
 * 实测压缩点表：只留正的有限数
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
  // 测试用
  cleanObserved,
  _internal: { newState, ingest, classify, stepOf, newJournal, ingestJournal, INTERRUPT_RE, LOCAL_CMD_RE },
};
