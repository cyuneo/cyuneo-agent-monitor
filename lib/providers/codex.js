'use strict';
// Codex provider.
// Reads rollouts under $CODEX_HOME (sessions/YYYY/MM/DD/rollout-*.jsonl), session_index.jsonl,
// models_cache.json and config.toml, and produces Session v2. Read-only, no network, no UI text:
// only status codes, step kinds, numbers, timestamps and raw snippets (title, tool-argument summary, result, first error line).
// Plain Node with no vscode dependency; usable from both the worker and the terminal version.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { JsonlTail } = require('../core/jsonl');
const {
  STATUS, STEP, makeStatus, isRunningCode, isNeedsYouCode, isErrorCode,
  guessAwaitingApproval, isFastTool, sessionKey, parseSessionKey, APPROVAL_GUESS, APPROVAL_GUESS_DEFAULT_SECONDS,
  noteCompact, compactLoopOf,
} = require('../core/status');
const pricing = require('../core/pricing');
const quotaLib = require('../core/quota');
const contextLib = require('../core/context');
const { resumeHints } = require('../core/resume');

const PROVIDER = 'codex';

const DEFAULT_LIMITS = Object.freeze({ timeline: 30, timelineSent: 12, resultChars: 4000, filesPerAgent: 200, errorsPerAgent: 10 });
const ROLLOUT_RE = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const DISCOVER_MS = 5000;       // re-list rollouts every 5 seconds (same cadence as discover)
const COLD_DIR_MS = 60000;      // with many files, scan older date directories only every 60 seconds
const MANY_FILES = 2000;
const HOT_DAYS = 3;             // the most recent date directories are scanned every time
const MAX_REMEMBER = 5000;      // cap on remembered startedMs / first-seen entries
const RL_TAIL_BYTES = 512 * 1024; // when no thread is in the window, look for a quota snapshot at the end of the newest rollout
const COMPACT_MERGE_MS = 60000; // a compacted line and a ContextCompaction item are the same compaction; count it once within 60 seconds
const RUNNING_CELL_RE = /^\s*Script running with cell ID\s+(\S+)/i; // exec code cell still running
const FAILED_SCRIPT_RE = /^\s*Script failed\b/i;                     // exec code threw an error

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function tsOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v !== 'string' || !v) return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

function str(v) { return typeof v === 'string' && v ? v : null; }
function int(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; }

// Single line, length-limited (same as oneLine in monitor.js)
function oneLine(t, max = 90) {
  if (t == null) return '';
  let s = String(t);
  if (s.length > max * 8) s = s.slice(0, max * 8); // cut very long text first, then collapse whitespace, so the whole text is not processed
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// First non-empty line, at most max chars
function firstLine(t, max = 200) {
  if (typeof t !== 'string') return null;
  for (const l of t.split('\n')) { const s = l.trim(); if (s) return oneLine(s, max); }
  return null;
}

// Last non-empty line (when a command fails, the error is usually at the end of the output)
function lastLine(t, max = 200) {
  if (typeof t !== 'string') return null;
  const ls = t.split('\n');
  for (let i = ls.length - 1; i >= 0; i--) { const s = ls[i].trim(); if (s) return oneLine(s, max); }
  return null;
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? String(p) : '…/' + parts.slice(-2).join('/');
}

// Turn common escapes in JS / JSON string literals back into readable text
function unescapeLiteral(s) {
  return String(s).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, c) => {
    if (c === 'n' || c === 'r' || c === 't') return ' ';
    if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return c;
  });
}

// Message content array → text (input_text / output_text / text / Text)
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const c of content) {
    if (c && typeof c.text === 'string') out += (out ? '\n' : '') + c.text;
  }
  return out;
}

// Tool output → text (a string, or an array like [{type:'input_text', text}])
function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return contentText(output);
  if (output && typeof output === 'object' && typeof output.content === 'string') return output.content;
  return '';
}

// Injected context (environment info, AGENTS.md, etc.) is not a prompt the user actually typed
function isInjectedContext(text) {
  const t = String(text || '').trimStart();
  return t.startsWith('<') || t.startsWith('# AGENTS.md');
}

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_REMEMBER) map.delete(map.keys().next().value);
  return value;
}

// ---------------------------------------------------------------------------
// Tool call → step (describeCodexCall)
// ---------------------------------------------------------------------------

// Extract key: "string" from JS code (the key may be quoted; the value may be "…" '…' `…`)
function pickStringProp(code, keys) {
  const k = keys.join('|');
  const re = new RegExp('(?:\\b(?:' + k + ')|["\'](?:' + k + ')["\'])\\s*:\\s*(["\'`])((?:\\\\[\\s\\S]|(?!\\1)[^\\\\])*)\\1');
  const m = re.exec(code);
  return m ? unescapeLiteral(m[2]) : null;
}

// apply_patch headers: *** Add/Update/Delete File: path (optionally followed by *** Move to: new path).
// The patch may contain real newlines or \n escapes inside a string, so the path ends at a newline or backslash.
function parsePatchHeaders(text) {
  const out = [];
  if (typeof text !== 'string' || !text.includes('*** ')) return out;
  const re = /\*\*\* (Add|Update|Delete) File: ((?:[^\n\\"'`]|\\(?![nrt"'`\\]))+)(?:(?:\n|\\n)\*\*\* Move to: ((?:[^\n\\"'`]|\\(?![nrt"'`\\]))+))?/g;
  let m;
  while ((m = re.exec(text))) {
    const p = m[2].trim();
    if (!p) continue;
    const op = m[1] === 'Add' ? 'create' : m[1] === 'Delete' ? 'delete' : (m[3] ? 'move' : 'edit');
    out.push({ path: p, op, movedTo: m[3] ? m[3].trim() : null });
  }
  return out;
}

/**
 * exec code mode: input is a JS snippet that calls tools as tools.<name>(…).
 * @param {string} code
 * @returns {{ tool: string, tools: string[], detail: string|null, parallel: number, patch: {path:string, op:string, movedTo:string|null}[] }}
 */
function describeExecCode(code) {
  const src = typeof code === 'string' ? code : '';
  const calls = [...src.matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  const tools = [...new Set(calls)];
  const patch = parsePatchHeaders(src);
  if (!tools.length) return { tool: 'exec', tools: [], detail: null, parallel: 1, patch };
  const tool = tools[0];
  let detail = null;
  if (tool === 'exec_command') detail = pickStringProp(src, ['cmd', 'command']);
  else if (tool === 'apply_patch') detail = patch.length ? shortPath(patch[0].path) : null;
  else if (tool === 'web__run' || /search/i.test(tool)) detail = pickStringProp(src, ['query', 'q']);
  else if (tool === 'view_image') detail = shortPath(pickStringProp(src, ['path']));
  return { tool, tools, detail: detail ? oneLine(detail) : null, parallel: Math.max(1, calls.length), patch };
}

// function_call arguments (JSON string) → argument summary
function describeArgs(name, args) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  if (!a || typeof a !== 'object') return { detail: null, patch: [], cellId: null };
  const cellId = a.cell_id != null ? String(a.cell_id) : null;
  let patch = [];
  let detail = null;
  const cmd = a.cmd != null ? a.cmd : a.command;
  if (Array.isArray(cmd)) detail = cmd.map(String).join(' ');
  else if (typeof cmd === 'string') detail = cmd;
  if (typeof a.input === 'string' && a.input.includes('*** ')) patch = parsePatchHeaders(a.input);
  else if (typeof a.patch === 'string') patch = parsePatchHeaders(a.patch);
  if (!detail && patch.length) detail = shortPath(patch[0].path);
  if (!detail) {
    for (const k of ['query', 'q', 'path', 'file_path', 'url', 'pattern', 'message', 'prompt']) {
      if (typeof a[k] === 'string' && a[k]) { detail = k.includes('path') ? shortPath(a[k]) : a[k]; break; }
    }
  }
  return { detail: detail ? oneLine(detail) : null, patch, cellId };
}

/**
 * Tool call in a response_item → step description.
 * - custom_tool_call named exec: take tools.<name> from the code;
 * - function_call: wait (waits on a code cell) and older tools such as shell / exec_command / apply_patch; parse the arguments;
 * - local_shell_call: the older local shell.
 * @param {any} p response_item.payload
 * @returns {{ name: string, tool: string, tools: string[], detail: string|null, parallel: number,
 *   patch: {path:string, op:string, movedTo:string|null}[], cellId: string|null }}
 */
function describeCodexCall(p) {
  const type = p && p.type;
  const name = str(p && p.name) || (type === 'local_shell_call' ? 'local_shell' : String(type || 'tool').replace(/_call$/, ''));
  if (type === 'custom_tool_call' && name === 'exec') {
    const d = describeExecCode(p.input);
    return { name, tool: d.tool, tools: d.tools, detail: d.detail, parallel: d.parallel, patch: d.patch, cellId: null };
  }
  if (type === 'custom_tool_call') {
    // Other custom tools: input is raw text (e.g. the apply_patch patch)
    const patch = parsePatchHeaders(p.input);
    const detail = name === 'apply_patch' && patch.length ? shortPath(patch[0].path) : null;
    return { name, tool: name, tools: [name], detail, parallel: 1, patch, cellId: null };
  }
  if (type === 'local_shell_call') {
    const cmd = p.action && Array.isArray(p.action.command) ? p.action.command.join(' ') : null;
    return { name, tool: 'local_shell', tools: ['local_shell'], detail: cmd ? oneLine(cmd) : null, parallel: 1, patch: [], cellId: null };
  }
  const d = describeArgs(name, p && (p.arguments != null ? p.arguments : p.input));
  return { name, tool: name, tools: [name], detail: name === 'wait' ? null : d.detail, parallel: 1, patch: d.patch, cellId: d.cellId };
}

// Which tool name to use when guessing a pending approval: fast only if every tool in the code is fast; otherwise the first non-fast tool (avoids false alarms)
function guessToolOf(call) {
  const c = call && call.cell ? call.cell : call;
  if (!c) return null;
  const tools = c.tools && c.tools.length ? c.tools : [c.tool];
  const slow = tools.find((t) => !isFastTool(PROVIDER, t));
  return slow || tools[0] || c.tool || null;
}

// ---------------------------------------------------------------------------
// State of a single thread (rollout file), accumulated incrementally
// ---------------------------------------------------------------------------

/**
 * @param {typeof DEFAULT_LIMITS} [limits]
 * @param {string|null} [fileId] thread id from the file name; only session_meta with this id is accepted
 */
function newThreadState(limits = DEFAULT_LIMITS, fileId = null) {
  return {
    limits,
    fileId,
    meta: null,               // result of metaOf()
    firstTs: null, lastTs: null,
    tcModel: null,            // latest turn_context.model
    settingsModel: null,      // latest thread_settings_applied.thread_settings.model
    cwd: null, serviceTier: null,
    approvalPolicy: null,     // latest approval_policy from turn_context / thread_settings ('never' means no approval prompts)
    openTurn: null,           // { turnId, startedMs, modelOutput, promptEv, promptFromEvent }
    lastTurnEnd: null,        // { kind: 'complete'|'aborted', ms, turnId, reason, error, lastAgentMessage }
    lastDoneMs: null,         // time of the latest normal turn completion (doneAtMs)
    turns: 0,
    pending: new Map(),       // call_id -> call (describeCodexCall + ms + cell)
    cells: new Map(),         // exec code cell_id -> the call that started it (still running)
    callIds: new Set(),       // dedupes toolCalls by call_id
    toolCalls: 0,
    lastEvent: null,          // { kind, tool, detail, parallel, ms }
    tokenInfo: null,          // latest token_count.info
    ctxWindowHint: null,      // task_started.model_context_window
    rateLimits: null, rateLimitsMs: 0,
    // Usage: once token_usage_record exists, dedupe by response_id; before that, use total_token_usage deltas
    usage: { apiCalls: 0, output: 0, processed: 0, costUsd: 0, pricedAny: false, estimated: false, unpricedTokens: 0, unpricedModel: null },
    lastApiMs: null,          // time of the latest response usage
    responses: new Set(),
    hasRecords: false,
    prevTotal: null,
    lastCompact: null,        // { ms, trigger, preTokens, postTokens, model }
    compactCount: 0, compactTimes: [], // a compacted line and a ContextCompaction item within 60 seconds count as one
    awaitPostCompact: false,  // after a compaction, take postTokens from the next token_count (Codex recomputes once from the new history)
    timeline: [], files: new Map(), errors: [], toolErrors: 0,
    firstPrompt: null,        // first user message (used for the title)
    fallbackPrompt: null,     // with no UserMessage event, fall back to the first non-injected response_item user message
    finalAnswer: null,        // { text, ms } latest final_answer
    lastText: null,           // { text, ms } latest assistant text
    result: null,             // { text, ms, source, truncated }
    sawPatchEnd: false,
  };
}

function modelNow(s) { return s.tcModel || s.settingsModel || null; }

function pushTimeline(s, ev) {
  s.timeline.push(ev);
  const max = (s.limits && s.limits.timeline) || DEFAULT_LIMITS.timeline;
  if (s.timeline.length > max) s.timeline.splice(0, s.timeline.length - max);
  return ev;
}

function pushError(s, ms, tool, text) {
  s.toolErrors++;
  s.errors.push({ ms, tool: tool || null, text: text || '' });
  const max = (s.limits && s.limits.errorsPerAgent) || DEFAULT_LIMITS.errorsPerAgent;
  if (s.errors.length > max) s.errors.splice(0, s.errors.length - max);
  pushTimeline(s, { ms, kind: 'toolError', tool: tool || null, detail: text || null });
}

function addFile(s, ms, filePath, op, movedTo) {
  if (!filePath) return;
  const f = s.files.get(filePath);
  if (f) {
    f.count++; f.lastMs = ms;
    if (op === 'delete' || op === 'move' || f.op !== 'create') f.op = op;
    if (movedTo) f.movedTo = movedTo;
    return;
  }
  const max = (s.limits && s.limits.filesPerAgent) || DEFAULT_LIMITS.filesPerAgent;
  if (s.files.size >= max) return;
  s.files.set(filePath, { path: filePath, op, count: 1, lastMs: ms, movedTo: movedTo || null });
}

// FileChange.changes: keys are paths, values are { type: add|update|delete, unified_diff?, move_path?, content? }
function addChanges(s, ms, changes) {
  if (!changes || typeof changes !== 'object') return;
  for (const [p, c] of Object.entries(changes)) {
    const t = c && typeof c === 'object' ? (c.type || Object.keys(c)[0]) : null;
    const inner = c && typeof c === 'object' && !c.type && t ? c[t] : c;
    const move = inner && typeof inner === 'object' ? str(inner.move_path) : null;
    const op = t === 'add' ? 'create' : t === 'delete' ? 'delete' : move ? 'move' : 'edit';
    addFile(s, ms, p, op, move);
  }
}

function setPrompt(s, text, fromEvent) {
  if (typeof text !== 'string' || !text.trim()) return;
  if (fromEvent) { if (s.firstPrompt == null) s.firstPrompt = text; }
  else if (s.fallbackPrompt == null && !isInjectedContext(text)) s.fallbackPrompt = text;
  const t = s.openTurn;
  if (!t || !t.promptEv) return;
  // The UserMessage event is authoritative; a response_item user message only fills in when there is none yet
  if (fromEvent && !t.promptFromEvent) { t.promptEv.detail = oneLine(text); t.promptFromEvent = true; }
  else if (!fromEvent && t.promptEv.detail == null && !isInjectedContext(text)) t.promptEv.detail = oneLine(text);
  if (s.lastEvent && s.lastEvent.kind === STEP.PROMPT) s.lastEvent.detail = t.promptEv.detail;
}

function markOutput(s) { if (s.openTurn) s.openTurn.modelOutput = true; }

// Final answer: in legacy mode the response_item and the agent_message event are the same message; with identical text keep the first
function setFinal(s, text, ms) {
  if (!text) return;
  if (s.finalAnswer && s.finalAnswer.text === text && ms - s.finalAnswer.ms < 60000) return;
  s.finalAnswer = { text, ms };
}

function setResult(s, text, ms, source) {
  const max = (s.limits && s.limits.resultChars) || DEFAULT_LIMITS.resultChars;
  const t = String(text);
  s.result = { text: t.length > max ? t.slice(0, max) : t, ms, source, truncated: t.length > max };
}

// Add one usage entry to the session totals (model / tier as of that moment)
function addUsage(s, u, total, ms) {
  const model = modelNow(s);
  const tok = pricing.openaiUsageTokens(u);
  const usd = pricing.priceOpenAI(model, u, s.serviceTier);
  if (ms != null && (s.lastApiMs == null || ms > s.lastApiMs)) s.lastApiMs = ms;
  s.usage.apiCalls++;
  s.usage.output += tok.output;
  s.usage.processed += total != null ? int(total) : tok.input + tok.output;
  if (usd == null) {
    s.usage.unpricedTokens += tok.input + tok.output;
    if (model) s.usage.unpricedModel = model;
  } else {
    s.usage.costUsd += usd;
    s.usage.pricedAny = true;
    // When the price table lacks this tier (e.g. no long-context or cache-write price), an approximate price is used and flagged "estimated"
    const r = pricing.openaiRates(model, { tier: s.serviceTier, long: tok.input > pricing.OPENAI_LONG_CONTEXT });
    if (r && (r.estimated || (tok.cacheWrite > 0 && r.cacheWrite == null))) s.usage.estimated = true;
  }
}

const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];

// Older versions (no token_usage_record): this total_token_usage − the previous one; equal → skip; smaller → treat as a reset and count it in full
function addTotalDelta(s, total, ms) {
  if (!total || typeof total !== 'object') return;
  const prev = s.prevTotal;
  s.prevTotal = total;
  let d = {};
  let reset = false;
  if (prev) {
    for (const k of USAGE_KEYS) {
      const v = int(total[k]) - int(prev[k]);
      if (v < 0) { reset = true; break; }
      d[k] = v;
    }
  }
  if (!prev || reset) d = Object.fromEntries(USAGE_KEYS.map((k) => [k, int(total[k])]));
  if (!USAGE_KEYS.some((k) => d[k] > 0)) return;
  addUsage(s, d, d.total_tokens || (d.input_tokens + d.output_tokens), ms);
}

function onCompact(s, ms) {
  if (s.lastCompact && Math.abs(ms - s.lastCompact.ms) < COMPACT_MERGE_MS) return;
  const pre = s.tokenInfo && s.tokenInfo.last_token_usage ? int(s.tokenInfo.last_token_usage.total_tokens) : null;
  // model: the model at compaction time (Codex does not reveal auto vs manual, so trigger is always null and it is not used to learn observed compact points)
  // postTokens: the first token_count after the compaction (compacted is immediately followed by a token_count recomputed from the new history:
  // total_token_usage unchanged, last_token_usage becomes the post-compaction size)
  s.lastCompact = { ms, trigger: null, preTokens: pre || null, postTokens: null, model: modelNow(s) };
  s.awaitPostCompact = true;
  s.compactCount++;
  noteCompact(s.compactTimes, ms);
  s.lastEvent = { kind: STEP.COMPACT, tool: null, detail: null, parallel: 0, ms };
  pushTimeline(s, { ms, kind: 'compact', tool: null, detail: null });
}

function metaOf(p, ms) {
  const src = p.source;
  const sub = src && typeof src === 'object' ? (src.subagent !== undefined ? src.subagent : src.sub_agent) : undefined;
  const spawn = sub && typeof sub === 'object' && sub.thread_spawn && typeof sub.thread_spawn === 'object' ? sub.thread_spawn : null;
  const other = sub && typeof sub === 'object' && typeof sub.other === 'string' ? sub.other : null;
  const internal = src && typeof src === 'object' && typeof src.internal === 'string' ? src.internal : null;
  const subKind = typeof sub === 'string' ? sub : other || (spawn ? 'thread_spawn' : sub ? Object.keys(sub)[0] || null : null);
  const threadSource = str(p.thread_source);
  const id = str(p.id);
  const parentId = str(p.parent_thread_id) || (spawn && str(spawn.parent_thread_id)) || null;
  const sessionId = str(p.session_id);
  return {
    id,
    parentId,
    // session_id equals the root thread id (per Codex source, SessionMeta); child threads attach to the root
    rootId: sessionId && sessionId !== id ? sessionId : parentId,
    timestampMs: tsOf(p.timestamp) ?? ms,
    cwd: str(p.cwd),
    originator: str(p.originator),
    cliVersion: str(p.cli_version),
    source: typeof src === 'string' ? src : sub !== undefined ? 'subagent' : internal ? 'internal' : null,
    subKind,
    internal,
    threadSource,
    nickname: str(p.agent_nickname) || (spawn && str(spawn.agent_nickname)) || null,
    role: str(p.agent_role) || str(p.agent_type) || (spawn && (str(spawn.agent_role) || str(spawn.agent_type))) || null,
    historyMode: str(p.history_mode),
    reviewer: threadSource === 'guardian_review' || other === 'guardian' || internal === 'guardian',
    // Internal threads such as memory consolidation are not user conversations and do not become separate sessions
    hidden: threadSource === 'memory_consolidation' || internal === 'memory_consolidation' || subKind === 'memory_consolidation',
  };
}

// Old format: lines without the {type, payload} wrapper
const BARE_RESPONSE_TYPES = new Set(['message', 'reasoning', 'function_call', 'function_call_output',
  'custom_tool_call', 'custom_tool_call_output', 'local_shell_call', 'web_search_call']);

/**
 * Feed for JsonlTail: accumulate one rollout line into the thread state. Unknown types are ignored.
 * @param {ReturnType<typeof newThreadState>} s
 * @param {any} e
 */
function ingestCodex(s, e) {
  const ms0 = tsOf(e.timestamp);
  if (ms0 != null) {
    if (s.firstTs == null) s.firstTs = ms0;
    if (s.lastTs == null || ms0 > s.lastTs) s.lastTs = ms0;
  }
  const ms = ms0 != null ? ms0 : (s.lastTs || 0);
  let type = e.type;
  let p = e.payload && typeof e.payload === 'object' ? e.payload : null;
  if (!p) {
    if (BARE_RESPONSE_TYPES.has(type)) { p = e; type = 'response_item'; }
    else if (!type && str(e.id) && e.timestamp) { p = e; type = 'session_meta'; }
    else return;
  }
  switch (type) {
    case 'session_meta': {
      const m = metaOf(p, ms);
      if (s.meta) return;                                   // only the first one counts
      if (s.fileId && m.id && m.id !== s.fileId) return;    // meta copied from another thread
      s.meta = m;
      if (!s.cwd && m.cwd) s.cwd = m.cwd;
      return;
    }
    case 'turn_context':
      if (str(p.model)) s.tcModel = p.model;
      if (str(p.cwd)) s.cwd = p.cwd;
      if (p.approval_policy !== undefined) s.approvalPolicy = policyOf(p.approval_policy);
      return;
    case 'event_msg': onEvent(s, p, ms); return;
    case 'response_item': onResponse(s, p, ms); return;
    case 'token_usage_record': onUsageRecord(s, p, ms); return;
    case 'compacted': onCompact(s, ms); return;
    default: return;
  }
}

// approval_policy may be a string (never / on-request / untrusted …) or an object (a granular policy)
function policyOf(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return Object.keys(v)[0] || 'custom';
  return null;
}

function onUsageRecord(s, p, ms) {
  s.hasRecords = true;
  const id = str(p.response_id);
  if (id) { if (s.responses.has(id)) return; s.responses.add(id); }
  if (!p.usage || typeof p.usage !== 'object') return;
  addUsage(s, p.usage, p.usage.total_tokens, ms);
}

function endTurn(s, p, ms) {
  const t = s.openTurn;
  // The turn being ended is an earlier one (turn_id mismatch): record the end only, do not close the turn in progress
  const mismatch = t && t.turnId && str(p.turn_id) && p.turn_id !== t.turnId;
  if (!mismatch) {
    s.openTurn = null;
    s.pending.clear();
    s.cells.clear();
  }
  return !mismatch;
}

function onEvent(s, p, ms) {
  switch (p.type) {
    case 'task_started':
    case 'turn_started': {
      s.turns++;
      s.pending.clear();
      s.cells.clear();
      if (p.model_context_window != null) s.ctxWindowHint = int(p.model_context_window) || s.ctxWindowHint;
      const promptEv = pushTimeline(s, { ms, kind: 'prompt', tool: null, detail: null });
      s.openTurn = { turnId: str(p.turn_id), startedMs: ms, modelOutput: false, promptEv, promptFromEvent: false };
      s.lastEvent = { kind: STEP.PROMPT, tool: null, detail: null, parallel: 0, ms };
      return;
    }
    case 'task_complete':
    case 'turn_complete': {
      const closes = endTurn(s, p, ms);
      const err = p.error && typeof p.error === 'object' ? p.error : null;
      s.lastTurnEnd = {
        kind: 'complete', ms, turnId: str(p.turn_id), reason: null,
        error: err ? { message: typeof err.message === 'string' ? err.message : null, info: err.codex_error_info ?? null } : null,
        lastAgentMessage: typeof p.last_agent_message === 'string' ? p.last_agent_message : null,
        closes,
      };
      if (err) {
        const kind = quotaLib.codexErrorKind(err.codex_error_info);
        pushTimeline(s, { ms, kind: kind === 'usage_limit_exceeded' ? 'quota' : 'apiError', tool: null, detail: firstLine(err.message) });
      } else {
        s.lastDoneMs = ms;
        pushTimeline(s, { ms, kind: 'done', tool: null, detail: null });
      }
      // Result: task_complete.last_agent_message; when null, fall back to the latest final_answer
      if (typeof p.last_agent_message === 'string' && p.last_agent_message) setResult(s, p.last_agent_message, ms, 'taskComplete');
      else if (s.finalAnswer) setResult(s, s.finalAnswer.text, s.finalAnswer.ms, 'lastText');
      else if (s.lastText) setResult(s, s.lastText.text, s.lastText.ms, 'lastText');
      return;
    }
    case 'turn_aborted': {
      const closes = endTurn(s, p, ms);
      const reason = str(p.reason) || 'interrupted';
      s.lastTurnEnd = { kind: 'aborted', ms, turnId: str(p.turn_id), reason, error: null, lastAgentMessage: null, closes };
      const kind = reason === 'budget_limited' ? 'quota' : (reason === 'replaced' || reason === 'review_ended') ? 'done' : 'interrupt';
      if (kind === 'done') s.lastDoneMs = ms;
      pushTimeline(s, { ms, kind, tool: null, detail: null });
      return;
    }
    case 'token_count': {
      const info = p.info && typeof p.info === 'object' ? p.info : null;
      if (info) {
        s.tokenInfo = info;
        if (!s.hasRecords) addTotalDelta(s, info.total_token_usage, ms);
        if (s.awaitPostCompact && s.lastCompact) {
          const last = info.last_token_usage && typeof info.last_token_usage === 'object' ? int(info.last_token_usage.total_tokens) : 0;
          s.lastCompact.postTokens = last || null;
          s.awaitPostCompact = false;
        }
      }
      if (p.rate_limits && typeof p.rate_limits === 'object') { s.rateLimits = p.rate_limits; s.rateLimitsMs = ms; }
      return;
    }
    case 'thread_settings_applied': {
      const ts = p.thread_settings && typeof p.thread_settings === 'object' ? p.thread_settings : {};
      if (str(ts.model)) s.settingsModel = ts.model;
      if (ts.service_tier !== undefined) s.serviceTier = str(ts.service_tier);
      if (ts.approval_policy !== undefined) s.approvalPolicy = policyOf(ts.approval_policy);
      return;
    }
    case 'item_completed': onItem(s, p.item, ms); return;
    // legacy-mode events (paginated mode uses item_completed instead)
    case 'user_message': setPrompt(s, p.message, true); return;
    case 'agent_message':
      if (typeof p.message === 'string' && p.phase === 'final_answer') setFinal(s, p.message, ms);
      return;
    case 'patch_apply_end': {
      s.sawPatchEnd = true;
      if (p.success === false || p.status === 'failed' || p.status === 'declined') {
        pushError(s, ms, 'apply_patch', firstLine(p.stderr) || firstLine(p.stdout) || p.status || null);
      } else addChanges(s, ms, p.changes);
      return;
    }
    case 'context_compacted': onCompact(s, ms); return;
    case 'mcp_tool_call_end': {
      const r = p.result;
      const inv = p.invocation || {};
      const tool = inv.server && inv.tool ? `mcp__${inv.server}__${inv.tool}` : 'mcp';
      if (r && typeof r === 'object' && r.Err !== undefined) pushError(s, ms, tool, firstLine(String(r.Err)));
      else if (r && r.Ok && r.Ok.isError) pushError(s, ms, tool, firstLine(contentText(r.Ok.content)));
      return;
    }
    default: return;
  }
}

function onItem(s, it, ms) {
  if (!it || typeof it !== 'object') return;
  switch (it.type) {
    case 'UserMessage': setPrompt(s, contentText(it.content), true); return;
    case 'AgentMessage': {
      if (it.phase === 'final_answer') setFinal(s, contentText(it.content), ms);
      return;
    }
    case 'Reasoning': {
      // Reasoning summary: attach it to the current thinking entry
      const sum = Array.isArray(it.summary_text) ? it.summary_text.find((x) => typeof x === 'string' && x.trim()) : null;
      const last = s.timeline[s.timeline.length - 1];
      if (sum && last && last.kind === 'thinking' && !last.detail) last.detail = oneLine(sum);
      if (sum && s.lastEvent && s.lastEvent.kind === STEP.THINKING && !s.lastEvent.detail) s.lastEvent.detail = oneLine(sum);
      return;
    }
    case 'FileChange':
      if (it.status === 'completed') addChanges(s, ms, it.changes);
      else if (it.status === 'failed' || it.status === 'declined') {
        pushError(s, ms, 'apply_patch', firstLine(it.stderr) || firstLine(it.stdout) || it.status);
      }
      return;
    case 'CommandExecution': {
      const failed = it.status === 'failed' || (it.status == null && it.exit_code != null && it.exit_code !== 0);
      if (!failed) return;
      const text = firstLine(it.stderr) || lastLine(it.aggregated_output) || lastLine(it.stdout)
        || (it.exit_code != null ? `exit ${it.exit_code}` : null);
      pushError(s, ms, 'exec_command', text);
      return;
    }
    case 'McpToolCall': {
      if (it.status !== 'failed') return;
      const tool = it.server && it.tool ? `mcp__${it.server}__${it.tool}` : 'mcp';
      const r = it.result;
      let text = null;
      if (r && typeof r === 'object') {
        if (typeof r.Err === 'string') text = firstLine(r.Err);
        else text = firstLine(contentText(r.content || (r.Ok && r.Ok.content)));
      } else if (typeof r === 'string') text = firstLine(r);
      pushError(s, ms, tool, text || (typeof it.error === 'string' ? firstLine(it.error) : null));
      return;
    }
    case 'ContextCompaction': onCompact(s, ms); return;
    default: return;
  }
}

function onResponse(s, p, ms) {
  switch (p.type) {
    case 'message': {
      const text = contentText(p.content);
      if (p.role === 'user') { setPrompt(s, text, false); return; }
      if (p.role !== 'assistant') return;
      markOutput(s);
      if (!text || !text.trim()) return;
      s.lastText = { text, ms };
      if (p.phase === 'final_answer') setFinal(s, text, ms);
      const detail = oneLine(text);
      s.lastEvent = { kind: STEP.TEXT, tool: null, detail, parallel: 0, ms };
      pushTimeline(s, { ms, kind: 'text', tool: null, detail });
      return;
    }
    case 'reasoning': {
      markOutput(s);
      const sum = Array.isArray(p.summary) ? p.summary.find((x) => x && typeof x.text === 'string' && x.text.trim()) : null;
      const detail = sum ? oneLine(sum.text) : null;
      const last = s.timeline[s.timeline.length - 1];
      if (last && last.kind === 'thinking') { if (!last.detail && detail) last.detail = detail; } // consecutive thinking merges into one entry
      else pushTimeline(s, { ms, kind: 'thinking', tool: null, detail });
      if (!(s.lastEvent && s.lastEvent.kind === STEP.THINKING)) s.lastEvent = { kind: STEP.THINKING, tool: null, detail, parallel: 0, ms };
      else if (!s.lastEvent.detail && detail) s.lastEvent.detail = detail;
      return;
    }
    case 'custom_tool_call':
    case 'function_call':
    case 'local_shell_call':
    case 'tool_search_call': {
      markOutput(s);
      const callId = str(p.call_id) || str(p.id);
      const call = describeCodexCall(p);
      call.ms = ms;
      call.callId = callId;
      if (call.name === 'wait' && call.cellId != null) call.cell = s.cells.get(call.cellId) || null;
      if (callId) {
        // A repeated write of the same call_id (already has a result) is not marked pending again
        if (!s.callIds.has(callId)) { s.callIds.add(callId); s.toolCalls++; s.pending.set(callId, call); }
        else if (s.pending.has(callId)) s.pending.set(callId, call);
      } else s.toolCalls++;
      const eff = call.cell || call;
      s.lastEvent = { kind: STEP.TOOL, tool: eff.tool, detail: eff.detail, parallel: eff.parallel || 1, ms };
      // wait only waits for the output of a known code cell; do not record it again in the timeline
      if (!call.cell) pushTimeline(s, { ms, kind: 'tool', tool: call.tool, detail: call.detail });
      return;
    }
    case 'custom_tool_call_output':
    case 'function_call_output':
    case 'tool_search_output': {
      const callId = str(p.call_id);
      const call = callId ? s.pending.get(callId) : null;
      if (callId) s.pending.delete(callId);
      const text = outputText(p.output);
      const head = text.split('\n', 1)[0] || '';
      const eff = call ? (call.cell || call) : null;
      const running = RUNNING_CELL_RE.exec(head);
      if (call && call.name === 'wait' && call.cellId != null && !running) s.cells.delete(call.cellId);
      if (running && eff) s.cells.set(running[1], eff); // code cell still running: remember which tool it belongs to
      const tool = eff ? eff.tool : null;
      if (FAILED_SCRIPT_RE.test(head)) {
        const rest = text.slice(head.length);
        pushError(s, ms, tool, firstLine(rest) || null);
      } else if (!running) {
        pushTimeline(s, { ms, kind: 'toolDone', tool, detail: null });
        // When a legacy thread has no patch_apply_end, fall back to parsing patch headers from the apply_patch input
        if (eff && eff.patch && eff.patch.length && !s.sawPatchEnd && s.meta && s.meta.historyMode === 'legacy') {
          for (const f of eff.patch) addFile(s, ms, f.path, f.op, f.movedTo);
        }
      }
      s.lastEvent = { kind: STEP.TOOL_RESULT, tool, detail: eff ? eff.detail : null, parallel: 0, ms };
      return;
    }
    case 'web_search_call': {
      markOutput(s);
      const q = p.action && typeof p.action.query === 'string' ? oneLine(p.action.query) : null;
      pushTimeline(s, { ms, kind: 'tool', tool: 'web_search', detail: q });
      return;
    }
    case 'compaction':
    case 'context_compaction': onCompact(s, ms); return;
    default: return;
  }
}

// If the format changes or a line has an unexpected shape, skip just that line instead of failing the whole scan
function safeIngest(s, e) {
  try { ingestCodex(s, e); } catch { s.badLines = (s.badLines || 0) + 1; }
}

// ---------------------------------------------------------------------------
// Status classification
// ---------------------------------------------------------------------------

// Whether the quota snapshot is still at the limit right now: with full windows, check whether they have not reset yet;
// with no full window but a rate_limit_reached_type (e.g. credits used up), there is no reset time to check, so treat it as still at the limit
function limitReachedNow(rl, rlMs, now) {
  if (!rl || !quotaLib.codexLimitReached(rl)) return false;
  const full = quotaLib.codexWindows(rl, rlMs).filter((w) => w.usedPct >= 100);
  if (full.length) return full.some((w) => w.resetsAtMs == null || w.resetsAtMs > now);
  return typeof rl.rate_limit_reached_type === 'string' && !!rl.rate_limit_reached_type;
}

function pendingList(s) {
  const out = [];
  for (const c of s.pending.values()) out.push({ tool: guessToolOf(c), sinceMs: c.cell ? c.cell.ms : c.ms, call: c });
  return out;
}

/**
 * Thread state → AgentStatus.
 * @param {ReturnType<typeof newThreadState>} s
 * @param {{ now: number, mtimeMs?: number, staleMs: number, isMain?: boolean, childWorking?: boolean,
 *   reviewerWorking?: boolean, approvalGuess?: string, approvalGuessSeconds?: number, staleMinutes?: number,
 *   accountRl?: { rl: any, ms: number }|null }} o
 * @returns {import('../core/status').AgentStatus}
 */
function classifyThread(s, o) {
  const now = o.now;
  const lastActivity = Math.max(s.lastTs || 0, o.mtimeMs || 0);
  // Quota snapshot: this thread's own, or a newer account-level one
  let rl = s.rateLimits;
  let rlMs = s.rateLimitsMs;
  if (o.accountRl && o.accountRl.rl && (!rl || o.accountRl.ms > rlMs)) { rl = o.accountRl.rl; rlMs = o.accountRl.ms; }

  const t = s.openTurn;
  const end = s.lastTurnEnd;
  if (!t) {
    if (end && end.kind === 'complete' && end.error) {
      const info = end.error.info;
      const kind = quotaLib.codexErrorKind(info);
      if (kind === 'usage_limit_exceeded') {
        return makeStatus(STATUS.QUOTA, end.ms, { quota: quotaLib.codexQuotaHit(rl, rlMs, { kind: 'window', source: 'turnError' }) });
      }
      return makeStatus(STATUS.API_ERROR, end.ms, {
        error: { kind: kind || 'unknown', http: quotaLib.codexErrorHttp(info), message: firstLine(end.error.message) },
      });
    }
    if (end && end.kind === 'aborted') {
      if (end.reason === 'budget_limited') {
        return makeStatus(STATUS.QUOTA, end.ms, {
          quota: { kind: 'spend', model: null, resetsAtMs: null, resetsText: null, source: 'turnError', autoContinue: false },
        });
      }
      if (end.reason === 'replaced' || end.reason === 'review_ended') return doneStatus(end.ms, o);
      return makeStatus(STATUS.INTERRUPTED, end.ms);
    }
    if (end) return doneStatus(end.ms, o);
    // Only session_meta: starting; after the timeout it counts as stale
    if (now - lastActivity > o.staleMs) return makeStatus(STATUS.STALE, lastActivity);
    return makeStatus(STATUS.STARTING, (s.meta && s.meta.timestampMs) || s.firstTs || lastActivity);
  }

  const stale = now - lastActivity > o.staleMs;
  // Hit the limit and no longer writing records: classify as quota rather than stale (inferred)
  if (stale && limitReachedNow(rl, rlMs, now)) {
    return makeStatus(STATUS.QUOTA, lastActivity, { quota: quotaLib.codexQuotaHit(rl, rlMs, { kind: 'window', source: 'rateLimits' }) });
  }
  const pend = pendingList(s);
  // A fast tool with no result for a long time → maybe waiting for your approval (Codex has no registry, so hasRegistry is always false); checked before stale.
  // No guess in two cases: approval_policy is never (Codex never asks for approval); a reviewer thread is reviewing (it is waiting on the reviewer, not you).
  const canAsk = s.approvalPolicy !== 'never' && !o.reviewerWorking;
  const hit = canAsk && guessAwaitingApproval({
    provider: PROVIDER,
    pending: pend.map((x) => ({ tool: x.tool, sinceMs: x.sinceMs })),
    now,
    mode: o.approvalGuess || APPROVAL_GUESS.FAST_TOOLS,
    seconds: o.approvalGuessSeconds ?? APPROVAL_GUESS_DEFAULT_SECONDS,
    staleMinutes: o.staleMinutes ?? o.staleMs / 60e3,
    hasRegistry: false,
  });
  if (hit) return makeStatus(STATUS.MAYBE_AWAITING_APPROVAL, hit.sinceMs, { pendingTool: hit.tool });
  const latest = pend.length ? pend.reduce((a, b) => (b.call.ms >= a.call.ms ? b : a)) : null;
  if (stale) {
    return makeStatus(STATUS.STALE, lastActivity, {
      stalePending: pend.length > 0,
      pendingTool: latest ? latest.tool : null,
    });
  }
  if (latest) return makeStatus(STATUS.TOOL, latest.sinceMs, { pendingTool: latest.tool });
  if (!t.modelOutput) return makeStatus(STATUS.STARTING, t.startedMs);
  return makeStatus(STATUS.THINKING, (s.lastEvent && s.lastEvent.ms) || t.startedMs);
}

function doneStatus(ms, o) {
  // The main thread's turn ended but child threads are still running → idleBackground
  return makeStatus(o.isMain && o.childWorking ? STATUS.IDLE_BACKGROUND : STATUS.DONE, ms);
}

/**
   * Current step.
 * @param {ReturnType<typeof newThreadState>} s
 * @returns {import('../core/status').Step|null}
 */
function stepOf(s) {
  if (s.pending.size) {
    let latest = null;
    let parallel = 0;
    for (const c of s.pending.values()) {
      const eff = c.cell || c;
      parallel += eff.parallel || 1;
      if (!latest || c.ms >= latest.ms) latest = c;
    }
    const eff = latest.cell || latest;
    return { kind: STEP.TOOL, tool: eff.tool, detail: eff.detail || null, parallel, sinceMs: eff.ms };
  }
  const ev = s.lastEvent;
  if (!ev) return null;
  return {
    kind: ev.kind === STEP.TOOL ? STEP.TOOL_RESULT : ev.kind,
    tool: ev.tool || null,
    detail: ev.detail || null,
    parallel: 0,
    sinceMs: ev.ms,
  };
}

// session_meta → Session.entry
function entryOf(meta) {
  const o = (meta && meta.originator) || '';
  if (/desktop/i.test(o)) return 'desktop';
  if (/vscode/i.test(o)) return 'vscode';
  const src = meta && meta.source;
  if (src === 'cli') return 'cli';
  if (src === 'exec') return 'exec';
  if (src === 'vscode') return 'vscode';
  return 'other';
}

function agentKindOf(meta, asMain) {
  if (asMain) return 'main';
  return meta && meta.reviewer ? 'codexReviewer' : 'codexSubagent';
}

// ---------------------------------------------------------------------------
// Rollout discovery
// ---------------------------------------------------------------------------

function listDirents(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; }
}

function statRollouts(dir) {
  const out = [];
  for (const f of listDirents(dir)) {
    if (!f.isFile() && !f.isSymbolicLink()) continue;
    const m = ROLLOUT_RE.exec(f.name);
    if (!m) continue;
    const file = path.join(dir, f.name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    out.push({ id: m[1].toLowerCase(), file, mtimeMs: st.mtimeMs, size: st.size });
  }
  return out;
}

// Search backwards from the end of the file for the latest token_count with rate_limits (reads only the last 512KB)
function readLatestRateLimits(file, size) {
  let fd;
  try {
    const len = Math.min(size, RL_TAIL_BYTES);
    if (!(len > 0)) return null;
    const buf = Buffer.allocUnsafe(len);
    fd = fs.openSync(file, 'r');
    const got = fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8', 0, got).split('\n');
    if (len < size) lines.shift(); // the first line may be partial
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.includes('"rate_limits":{')) continue;
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      const p = e && e.payload;
      if (p && p.type === 'token_count' && p.rate_limits && typeof p.rate_limits === 'object') {
        return { rl: p.rate_limits, ms: tsOf(e.timestamp) || 0 };
      }
    }
  } catch { /* unreadable: give up */ } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return null;
}

// session_index.jsonl: { id, thread_name, updated_at }; for the same id the last entry wins
function ingestIndex(map, e) {
  if (e && typeof e.id === 'string' && typeof e.thread_name === 'string') {
    const name = e.thread_name.trim();
    if (name) map.set(e.id.toLowerCase(), name);
    else map.delete(e.id.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Codex provider. Usage (worker / terminal version):
 *   const p = new CodexProvider({ home, activeWindowMinutes, staleMinutes, limits, approvalGuess, approvalGuessSeconds });
 *   const sessions = p.scan(now);          // Session[], filtered by the activity window, sorted by updatedMs descending
 *   const q = p.quota();                   // QuotaSnapshot.codex (account-level: the latest rate_limits across all rollouts)
 *   const d = p.details(keys, now);        // { [sessionKey]: SessionDetail }, only for sessions that appeared in scan
 */
class CodexProvider {
  /**
   * @param {{ home?: string, codex?: { home?: string }, activeWindowMinutes?: number, staleMinutes?: number,
   *   limits?: Partial<typeof DEFAULT_LIMITS>, approvalGuess?: 'fastTools'|'allTools'|'off', approvalGuessSeconds?: number,
   *   env?: Record<string, string|undefined> }} [opts]
   *   Also accepts a whole WorkerConfig (the path is taken from opts.codex.home).
   */
  constructor(opts = {}) {
    const env = opts.env || process.env;
    this.home = opts.home || (opts.codex && opts.codex.home) || env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.sessionsDir = path.join(this.home, 'sessions');
    this.windowMs = (opts.activeWindowMinutes ?? 30) * 60e3;
    this.staleMinutes = opts.staleMinutes ?? 5;
    this.staleMs = this.staleMinutes * 60e3;
    this.approvalGuess = opts.approvalGuess || APPROVAL_GUESS.FAST_TOOLS;
    this.approvalGuessSeconds = opts.approvalGuessSeconds ?? APPROVAL_GUESS_DEFAULT_SECONDS;
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    this.index = new JsonlTail(path.join(this.home, 'session_index.jsonl'), () => new Map(), ingestIndex);
    this.models = new Map();
    this.modelsMtime = -1;
    this.config = {};
    this.configMtime = -1;
    this.files = new Map();     // thread id -> { id, file, mtimeMs, size } (all rollouts, used to find parent threads)
    this.dirs = new Map();      // date directory -> { scannedMs, entries }
    this.threads = new Map();   // thread id -> JsonlTail (only those in the window, plus the parent threads they need)
    this.startedMs = new Map(); // thread id -> stable start time
    this.firstSeen = new Map(); // thread id -> first-seen time
    this.latestRl = null;       // { rl, ms } latest rate_limits among the threads read
    this.rlFallback = null;     // { file, size, rl, ms } taken from the end of the newest rollout when no thread is in the window
    this.built = new Map();     // sessionKey -> { rootId, childIds } (result of the previous scan, used by details)
    this.lastDiscover = -Infinity;
    this.lastFullScan = -Infinity;
  }

  // ---------- Auxiliary files ----------

  refreshAux() {
    this.index.poll();
    const mc = path.join(this.home, 'models_cache.json');
    const mt = mtimeOf(mc);
    if (mt !== this.modelsMtime) { this.modelsMtime = mt; this.models = contextLib.readCodexModelsCache(mc); }
    const cf = path.join(this.home, 'config.toml');
    const ct = mtimeOf(cf);
    if (ct !== this.configMtime) { this.configMtime = ct; this.config = contextLib.readCodexConfig(cf); }
  }

  // ---------- Discovery ----------

  discover(now) {
    this.lastDiscover = now;
    const days = [];
    for (const y of listDirents(this.sessionsDir)) {
      if (!y.isDirectory()) continue;
      const yd = path.join(this.sessionsDir, y.name);
      for (const m of listDirents(yd)) {
        if (!m.isDirectory()) continue;
        const md = path.join(yd, m.name);
        for (const d of listDirents(md)) if (d.isDirectory()) days.push(path.join(md, d.name));
      }
    }
    days.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest dates first
    const many = this.files.size > MANY_FILES;
    const full = !many || now - this.lastFullScan >= COLD_DIR_MS;
    if (full) this.lastFullScan = now;
    const seen = new Set();
    const scanDir = (dir, force) => {
      seen.add(dir);
      let c = this.dirs.get(dir);
      if (!c || force) { c = { scannedMs: now, entries: statRollouts(dir) }; this.dirs.set(dir, c); }
      return c.entries;
    };
    const files = new Map();
    const put = (x) => { const old = files.get(x.id); if (!old || x.mtimeMs > old.mtimeMs) files.set(x.id, x); };
    // Older versions may put files directly under sessions/
    for (const x of scanDir(this.sessionsDir, true)) put(x);
    days.forEach((dir, i) => { for (const x of scanDir(dir, full || i < HOT_DAYS)) put(x); });
    for (const k of [...this.dirs.keys()]) if (!seen.has(k)) this.dirs.delete(k);
    // Threads being read: the reader's stat result wins (it is more up to date)
    for (const [id, tail] of this.threads) {
      const x = files.get(id);
      if (x && tail.mtimeMs > x.mtimeMs) x.mtimeMs = tail.mtimeMs;
    }
    this.files = files;
  }

  // ---------- Readers ----------

  track(id, now = Date.now()) {
    let tail = this.threads.get(id);
    if (tail) return tail;
    const f = this.files.get(id);
    if (!f) return null;
    const limits = this.limits;
    tail = new JsonlTail(f.file, () => newThreadState(limits, id), safeIngest);
    this.threads.set(id, tail);
    if (!this.firstSeen.has(id)) remember(this.firstSeen, id, now);
    return tail;
  }

  pollThread(tail) {
    tail.poll();
    const f = this.files.get(tail.state.fileId);
    if (f && tail.mtimeMs) f.mtimeMs = tail.mtimeMs;
    const s = tail.state;
    if (s.rateLimits && (!this.latestRl || s.rateLimitsMs > this.latestRl.ms)) this.latestRl = { rl: s.rateLimits, ms: s.rateLimitsMs };
  }

  // Stable start time: session_meta.timestamp → first line time → first-seen time; once set it never changes
  stableStart(id, s, now) {
    const known = this.startedMs.get(id);
    if (known != null) return known;
    const v = (s.meta && s.meta.timestampMs) || s.firstTs || this.firstSeen.get(id) || now;
    return remember(this.startedMs, id, v);
  }

  /**
   * Scan once and return the sessions in the window.
   * @param {number} [now]
   * @param {{ keepKeys?: Iterable<string> }} [opts] keepKeys: sessions to keep even outside the activity window (e.g. the one currently selected)
   * @returns {import('../core/status').Session[]}
   */
  scan(now = Date.now(), opts = {}) {
    if (now - this.lastDiscover >= DISCOVER_MS || now < this.lastDiscover) this.discover(now);
    this.refreshAux();
    const keep = new Set();
    for (const k of opts.keepKeys || []) {
      const pk = parseSessionKey(k);
      if (pk && pk.provider === PROVIDER) keep.add(pk.id.toLowerCase());
    }

    // 1. Read every rollout in the window; release those whose file is gone
    for (const id of [...this.threads.keys()]) if (!this.files.has(id)) this.threads.delete(id);
    for (const [id, f] of this.files) {
      if (now - f.mtimeMs < this.windowMs || keep.has(id)) this.track(id, now);
    }
    for (const tail of this.threads.values()) this.pollThread(tail);

    // 2. Also read the root / parent of child threads if not already read (a parent outside the window is still included)
    const rootOf = new Map();
    for (let round = 0; round < 4; round++) {
      let added = false;
      for (const [id, tail] of this.threads) {
        if (rootOf.has(id)) continue;
        const m = tail.state.meta;
        if (!m || (!m.rootId && !m.parentId)) { rootOf.set(id, id); continue; }
        const cands = [m.rootId, m.parentId].filter(Boolean).map((x) => x.toLowerCase());
        let root = null;
        for (const c of cands) {
          if (this.threads.has(c)) { root = c; break; }
          if (this.files.has(c)) { const t = this.track(c, now); this.pollThread(t); root = c; added = true; break; }
        }
        rootOf.set(id, root || id); // parent not found: becomes its own session
      }
      if (!added) break;
    }
    // The root thread may itself be a child thread (multiple levels): walk all the way up
    const finalRoot = (id) => {
      let r = id;
      for (let i = 0; i < 8; i++) { const n = rootOf.get(r); if (!n || n === r) break; r = n; }
      return r;
    };

    // 3. Group by root
    const groups = new Map(); // rootId -> childIds[]
    for (const [id, tail] of this.threads) {
      const s = tail.state;
      if (!s.meta && s.firstTs == null) continue; // no lines written yet
      const r = finalRoot(id);
      if (!groups.has(r)) groups.set(r, []);
      if (r !== id) groups.get(r).push(id);
    }

    // 4. Build sessions; release sessions outside the window and unused readers
    const out = [];
    const used = new Set();
    this.built = new Map();
    const accountRl = this.accountRl();
    for (const [rootId, childIdsAll] of groups) {
      const rootTail = this.threads.get(rootId);
      if (!rootTail) continue;
      const rs = rootTail.state;
      if (rs.meta && rs.meta.hidden) continue;
      const childIds = childIdsAll.filter((cid) => {
        const t = this.threads.get(cid);
        return t && (now - t.mtimeMs < this.windowMs || keep.has(cid)) && !(t.state.meta && t.state.meta.hidden);
      });
      const updatedMs = Math.max(rootTail.mtimeMs || 0, ...childIds.map((cid) => this.threads.get(cid).mtimeMs || 0));
      if (!(now - updatedMs < this.windowMs) && !keep.has(rootId)) continue;
      const session = this.buildSession(rootId, childIds, now, updatedMs, accountRl);
      out.push(session);
      used.add(rootId);
      for (const c of childIds) used.add(c);
      this.built.set(session.key, { rootId, childIds });
    }
    for (const id of [...this.threads.keys()]) {
      const f = this.files.get(id);
      const inWindow = f && now - f.mtimeMs < this.windowMs;
      if (!used.has(id) && !inWindow && !keep.has(id)) this.threads.delete(id);
    }
    out.sort((a, b) => b.updatedMs - a.updatedMs || (a.key < b.key ? -1 : 1));
    return out;
  }

  accountRl() {
    let best = this.latestRl;
    // No newer quota snapshot among the threads read: take one from the end of the newest rollout (when no thread is in the window)
    let newest = null;
    for (const f of this.files.values()) if (!newest || f.mtimeMs > newest.mtimeMs) newest = f;
    if (newest && !this.threads.has(newest.id) && (!best || newest.mtimeMs > best.ms)) {
      const fb = this.rlFallback;
      if (!fb || fb.file !== newest.file || fb.size !== newest.size) {
        const r = readLatestRateLimits(newest.file, newest.size);
        this.rlFallback = { file: newest.file, size: newest.size, rl: r ? r.rl : null, ms: r ? r.ms : 0 };
      }
    }
    const fb = this.rlFallback;
    if (fb && fb.rl && (!best || fb.ms > best.ms)) best = { rl: fb.rl, ms: fb.ms };
    return best;
  }

  classifyOpts(now, mtimeMs, isMain, childWorking, accountRl, reviewerWorking = false) {
    return {
      now, mtimeMs, staleMs: this.staleMs, isMain, childWorking, reviewerWorking,
      approvalGuess: this.approvalGuess, approvalGuessSeconds: this.approvalGuessSeconds,
      staleMinutes: this.staleMinutes, accountRl,
    };
  }

  /** @returns {any} Agent; ctx (the codexContext result) is also attached as the non-enumerable _ctx, for session-level fields */
  buildAgent(id, tail, kind, now, st) {
    const s = tail.state;
    const model = modelNow(s);
    const info = s.tokenInfo;
    const last = info && info.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : null;
    const used = last ? int(last.total_tokens) : 0;
    const ctx = contextLib.codexContext(
      { model, contextUsed: used, modelContextWindow: (info && info.model_context_window) || s.ctxWindowHint || null },
      this.models, this.config,
    );
    const u = s.usage;
    const m = s.meta || {};
    const agent = {
      id,
      kind,
      name: kind === 'main' ? null : m.nickname || null,
      agentType: m.role || null,
      phase: null,
      background: false,
      model,
      status: st,
      step: stepOf(s),
      tokens: {
        display: used,
        contextUsed: used,
        contextWindow: ctx.contextWindow,
        compactAt: ctx.compactAt,
        toCompact: ctx.toCompact,
        contextPct: ctx.contextPct,
        output: u.output,
        processed: u.processed,
        apiCalls: u.apiCalls,
      },
      toolCalls: s.toolCalls,
      toolErrors: s.toolErrors,
      filesChanged: s.files.size,
      costUsd: u.pricedAny ? u.costUsd : (u.unpricedTokens > 0 ? null : 0),
      costEstimated: u.estimated,
      unpricedModel: u.unpricedTokens > 0 ? u.unpricedModel : null,
      lastCompact: s.lastCompact ? { ...s.lastCompact, contextWindow: ctx.contextWindow } : null,
      cacheTtl: null,
      startedMs: this.stableStart(id, s, now),
      lastActivityMs: Math.max(s.lastTs || 0, tail.mtimeMs || 0),
      lastApiMs: s.lastApiMs,
      mtimeMs: tail.mtimeMs || 0,
      file: tail.file,
    };
    Object.defineProperty(agent, '_ctx', { value: ctx, enumerable: false });
    return agent;
  }

  buildSession(rootId, childIds, now, updatedMs, accountRl) {
    const rootTail = this.threads.get(rootId);
    const rs = rootTail.state;
    const meta = rs.meta || {};
    const agents = [];
    for (const cid of childIds) {
      const t = this.threads.get(cid);
      const st = classifyThread(t.state, this.classifyOpts(now, t.mtimeMs, false, false, accountRl));
      agents.push(this.buildAgent(cid, t, agentKindOf(t.state.meta, false), now, st));
    }
    // Sorted by start time ascending; the earliest starts on top
    agents.sort((a, b) => (a.startedMs - b.startedMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const childWorking = agents.some((a) => isRunningCode(a.status.code) || isNeedsYouCode(a.status.code));
    const reviewerWorking = agents.some((a) => a.kind === 'codexReviewer' && isRunningCode(a.status.code));
    const mainSt = classifyThread(rs, this.classifyOpts(now, rootTail.mtimeMs, true, childWorking, accountRl, reviewerWorking));
    const main = this.buildAgent(rootId, rootTail, 'main', now, mainSt);

    const idxName = this.index.state.get(rootId);
    let title;
    let titleSource;
    if (idxName) { title = idxName; titleSource = 'index'; }
    else if (rs.firstPrompt || rs.fallbackPrompt) { title = oneLine(rs.firstPrompt || rs.fallbackPrompt, 40); titleSource = 'prompt'; }
    else { title = rootId.slice(0, 8); titleSource = 'id'; }

    const all = [main, ...agents];
    const counts = { running: 0, awaiting: 0, error: 0, done: 0, total: all.length };
    let cost = null;
    let unpricedModel = null;
    for (const a of all) {
      const c = a.status.code;
      if (isRunningCode(c)) counts.running++;
      else if (isNeedsYouCode(c)) counts.awaiting++;
      else if (isErrorCode(c)) counts.error++;
      else if (c === STATUS.DONE) counts.done++;
      if (a.costUsd != null) cost = (cost || 0) + a.costUsd;
      if (!unpricedModel && a.unpricedModel) unpricedModel = a.unpricedModel;
    }
    const live = !!rs.openTurn;
    const session = {
      key: sessionKey(PROVIDER, rootId),
      provider: PROVIDER,
      id: rootId,
      title,
      titleSource,
      cwd: rs.cwd || meta.cwd || null,
      projectDir: null,
      entry: entryOf(meta),
      entryRaw: meta.originator || (typeof meta.source === 'string' ? meta.source : null),
      entrypoint: null,
      version: meta.cliVersion || null,
      model: main.model,
      createdMs: meta.timestampMs || rs.firstTs || null,
      updatedMs,
      startedMs: main.startedMs,
      doneAtMs: rs.lastDoneMs,
      // Codex has no registry, so "open" = a turn is in progress
      live,
      liveStatus: live ? (mainSt.code === STATUS.MAYBE_AWAITING_APPROVAL ? 'waiting' : 'busy') : null,
      waitingFor: null,
      compactCount: rs.compactCount,
      compactLoop: compactLoopOf(rs.compactTimes, main.lastActivityMs),
      // Convenience fields named like those of Claude sessions; Codex cache retention has no reliable basis, so all cache fields are null
      contextUsed: main.tokens.contextUsed,
      modelVariant: null,
      contextWindow: main.tokens.contextWindow,
      contextWindowSource: main._ctx.contextWindowSource, // model_context_window from the transcript → codex-record
      compactAt: main.tokens.compactAt,
      compactAtSource: main._ctx.compactAtSource,
      autoCompactWindow: null,
      contextPct: main.tokens.contextPct,
      cacheTtl: null,
      cacheTtlInferred: false,
      cacheTtlMs: null,
      lastApiMs: main.lastApiMs,
      cacheExpiresMs: null,
      lastActivityMs: main.lastActivityMs,
      main,
      agents,
      workflows: [],
      counts,
      costUsd: cost,
      unpricedModel,
      ccCostUsd: null,
      transcript: rootTail.file,   // rollout of the main thread
      resume: [],
    };
    session.resume = resumeHints(session, { now });
    return session;
  }

  /**
   * Details: only for sessions that appeared in the previous scan. Uses in-memory state only; never re-reads files.
   * @param {string} idOrKey thread id or 'codex:<id>'
   * @returns {import('../core/status').SessionDetail|null}
   */
  detail(idOrKey) {
    const key = keyOf(idOrKey);
    const b = key && this.built.get(key);
    if (!b) return null;
    const agents = {};
    for (const id of [b.rootId, ...b.childIds]) {
      const t = this.threads.get(id);
      if (!t) continue;
      const s = t.state;
      const sent = this.limits.timelineSent;
      agents[id] = {
        timeline: s.timeline.slice(-sent).map((e) => ({ ms: e.ms, kind: e.kind, tool: e.tool || null, detail: e.detail || null })),
        result: s.result ? { ...s.result } : null,
        files: [...s.files.values()].sort((a, c) => c.lastMs - a.lastMs).map((f) => ({ ...f })),
        errors: s.errors.map((e) => ({ ...e })),
      };
    }
    return { key, agents };
  }

  /**
   * @param {Iterable<string>} keys
   * @returns {Record<string, import('../core/status').SessionDetail>}
   */
  details(keys) {
    const out = {};
    for (const k of keys || []) {
      const d = this.detail(k);
      if (d) out[d.key] = d;
    }
    return out;
  }

  /** Whether this session appeared in the previous scan */
  has(idOrKey) {
    const key = keyOf(idOrKey);
    return !!key && this.built.has(key);
  }

  /** Account-level quota snapshot: the rate_limits with the newest timestamp across all rollouts */
  quota() {
    const best = this.accountRl();
    return best && best.rl ? quotaLib.codexQuota(best.rl, best.ms) : quotaLib.emptyQuotaSnapshot().codex;
  }

  dispose() {
    this.threads.clear();
    this.files.clear();
    this.dirs.clear();
    this.built.clear();
  }
}

function mtimeOf(f) {
  try { return fs.statSync(f).mtimeMs; } catch { return 0; }
}

// 'codex:<id>' or a bare id → session key; a key of another provider returns null
function keyOf(idOrKey) {
  if (typeof idOrKey !== 'string' || !idOrKey) return null;
  const pk = parseSessionKey(idOrKey);
  if (pk && pk.provider === PROVIDER) return sessionKey(PROVIDER, pk.id.toLowerCase());
  if (pk) return null;
  return sessionKey(PROVIDER, idOrKey.toLowerCase());
}

module.exports = {
  PROVIDER, DEFAULT_LIMITS, ROLLOUT_RE,
  CodexProvider,
  // The exports below are reused by tests and other modules
  newThreadState, ingestCodex, classifyThread, stepOf, entryOf, agentKindOf, metaOf,
  describeCodexCall, describeExecCode, parsePatchHeaders, guessToolOf, ingestIndex, readLatestRateLimits, limitReachedNow,
  oneLine, shortPath,
};
