'use strict';
// Gemini CLI provider.
// Reads chat recordings under the Gemini runtime directory ($GEMINI_CLI_HOME/.gemini, default ~/.gemini; under the macOS
// Seatbelt sandbox the CLI uses <home>/.cache/.gemini instead, which is scanned too):
//   tmp/<projectId>/chats/session-*.jsonl   append log (CLI ≥ 0.39): a metadata line, then message records in which the same
//                                           id is appended again whenever tokens / tool calls are added (the last copy wins),
//                                           {"$set":{…}} metadata updates (a $set carrying messages is a full checkpoint)
//                                           and {"$rewindTo":"<id>"} rewinds (that message and everything after it is dropped);
//   tmp/<projectId>/chats/session-*.json    legacy whole-file record (CLI ≤ 0.38), re-parsed only when its mtime / size change;
//   tmp/<projectId>/chats/<parentSessionId>/<subSessionId>.jsonl   sub-agent recordings (first line kind 'subagent').
// <projectId> is a slug (older CLIs: sha256 of the project root); the project root comes from tmp/<projectId>/.project_root
// or projects.json. Produces Session v2. Read-only, no network, no UI text: only status codes, step kinds, numbers,
// timestamps and raw snippets (title, tool-argument summary, result, first error line).
// Gemini CLI keeps no process registry and records neither approval waits nor turn ends, and tool calls are written only after
// they finish. So "online", running, done and needs-you are inferred from write timing: those statuses carry certainty 'guess'
// and sessions carry liveCertainty 'guess'. Error records, cancelled tool calls, a sub-agent's complete_task and a visible
// ask_user / exit_plan_mode call are read from the recording and stay 'certain'.
// Token and cost totals count every distinct message id seen in the file (turns later dropped by $rewindTo or a checkpoint
// were still billed); status, step, timeline and title follow the conversation as it stands.
// Plain Node with no vscode dependency; usable from both the worker and the terminal version.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { JsonlTail } = require('../core/jsonl');
const {
  STATUS, STEP, makeStatus, isRunningCode, isNeedsYouCode, isErrorCode, STOPPED_CODES,
  guessAwaitingApproval, sessionKey, parseSessionKey, FAST_TOOLS, APPROVAL_GUESS, APPROVAL_GUESS_DEFAULT_SECONDS,
  WINDOW_SOURCE,
} = require('../core/status');
const pricing = require('../core/pricing');

const PROVIDER = 'gemini';
const SUBAGENT_KIND = 'geminiSubagent';

const DEFAULT_LIMITS = Object.freeze({ timeline: 30, timelineSent: 12, resultChars: 4000, filesPerAgent: 200, errorsPerAgent: 10 });
const SESSION_FILE_RE = /^session-.+\.jsonl?$/;   // excludes the CLI's .tmp-<pid> and .unreadable-<ms> side files
const SUBAGENT_FILE_RE = /^[^.].*\.jsonl$/;
const DISCOVER_MS = 5000;        // re-list recordings every 5 seconds
const COLD_DIR_MS = 60000;       // chats directories with nothing recent are re-listed only every 60 seconds (or when their mtime changes)
const MAX_FILES_PER_DIR = 500;   // newest session files per chats directory (names start with the creation time)
const MAX_SUBAGENT_FILES = 100;  // per parent-session sub-agent directory
const MAX_TRACKED = 200;         // at most this many recordings are read per scan (newest first)
const MAX_REMEMBER = 5000;       // cap on remembered start times / first-seen entries / id → file entries
const LEGACY_MAX_BYTES = 64 << 20; // a legacy .json larger than this is not parsed (same bound as a jsonl line)
const REGISTRY_MAX_BYTES = 4 << 20;
const SETTLE_SECONDS_DEFAULT = 30; // a text answer with no write after it for this long counts as done (guess)
const TAIL_SCAN = 64;            // trailing records examined to find the last meaningful message
const CONV_SCAN = 200;           // trailing records examined to find the current model / context size
const MSG_TEXT_CHARS = 300;       // text kept per message (title, timeline, step); only the latest answer keeps resultChars
const ERROR_TEXT_CHARS = 1000;

// Built-in tools that normally return within seconds (names from packages/core/src/tools/definitions/base-declarations.ts at
// gemini-cli 87de0b6). A call to one of them that has not finished long after it was issued most likely waits for approval.
// status.js has no Gemini entry in FAST_TOOLS yet; once it has one, that list is used instead.
const GEMINI_FAST_TOOLS = Object.freeze(['read_file', 'read_many_files', 'write_file', 'replace', 'list_directory',
  'glob', 'grep_search', 'write_todos', 'web_fetch']);
const GEMINI_FAST_TOOL_SET = new Set(GEMINI_FAST_TOOLS);
const QUESTION_TOOLS = Object.freeze({ ask_user: 'askUser', exit_plan_mode: 'planApproval' });
const COMPLETE_TASK_TOOL = 'complete_task';   // a sub-agent ends by calling this
const FILE_TOOLS = new Set(['write_file', 'replace']);

// Input token limits from https://ai.google.dev/gemini-api/docs/models/<id> (checked 2026-09-24); other ids → unknown window
const CONTEXT_WINDOWS = Object.freeze(Object.fromEntries([
  'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
].map((id) => [id, 1048576])));

const QUOTA_RE = /RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit/i;

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
// A prefix of at most max chars. A cut string is copied: V8 keeps the whole original alive behind a slice of it, so without
// the copy every message summary would hold the message's full text for as long as the recording is tracked
function cap(s, max) { return s.length > max ? ownCopy(s.slice(0, max)) : s; }
function ownCopy(s) { return Buffer.from(s, 'utf16le').toString('utf16le'); }

// Single line, length-limited (same as oneLine in codex.js, except that a cut is copied as in cap)
function oneLine(t, max = 90) {
  if (t == null) return '';
  let s = String(t);
  if (s.length > max * 8) s = ownCopy(s.slice(0, max * 8));
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// First non-empty line, at most max chars
function firstLine(t, max = 200) {
  if (typeof t !== 'string') return null;
  for (const l of t.split('\n')) { const s = l.trim(); if (s) return oneLine(s, max); }
  return null;
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? String(p) : '…/' + parts.slice(-2).join('/');
}

// A dir from a setting or env var: trimmed; a leading ~ (~/… or ~\\…) is the user's home dir, as the extension resolves them
function expandHome(p, home = os.homedir()) {
  const s = typeof p === 'string' ? p.trim() : '';
  if (!s) return '';
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2));
  return s;
}

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_REMEMBER) map.delete(map.keys().next().value);
  return value;
}

function listDirents(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; }
}

function statOf(f) {
  try { return fs.statSync(f); } catch { return null; }
}

function mtimeOf(f) {
  const st = statOf(f);
  return st ? st.mtimeMs : 0;
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// ---------------------------------------------------------------------------
// Content (PartListUnion) helpers
// ---------------------------------------------------------------------------

// string | Part | (string | Part)[] → Part[]
function partsOf(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (Array.isArray(content)) {
    const out = [];
    for (const p of content) {
      if (typeof p === 'string') { if (p) out.push({ text: p }); } else if (p && typeof p === 'object') out.push(p);
    }
    return out;
  }
  return typeof content === 'object' ? [content] : [];
}

// Visible text (thought parts excluded); parts are joined without a separator, as the CLI does
function textOf(content) {
  let out = '';
  for (const p of partsOf(content)) if (typeof p.text === 'string' && !p.thought) out += p.text;
  return out;
}

function callsOf(content) {
  const out = [];
  for (const p of partsOf(content)) {
    const fc = p.functionCall;
    if (fc && typeof fc === 'object') out.push({ name: str(fc.name), args: fc.args && typeof fc.args === 'object' ? fc.args : {} });
  }
  return out;
}

function hasFunctionResponse(content) {
  return partsOf(content).some((p) => p.functionResponse && typeof p.functionResponse === 'object');
}

// User input the CLI itself does not treat as a prompt: slash / help commands (isIgnoredUserContent also skips these)
function isCommandText(t) { const s = t.trimStart(); return s.startsWith('/') || s.startsWith('?'); }
// Context the CLI injects as a user turn
function isContextText(t) { const s = t.trimStart(); return s.startsWith('<session_context>') || s.startsWith('<hook_context>'); }

// ---------------------------------------------------------------------------
// Tool call → step detail
// ---------------------------------------------------------------------------

function describeArgs(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  const s = (v) => (typeof v === 'string' && v.trim() ? v : null);
  switch (name) {
    case 'run_shell_command': return s(a.command) ? oneLine(a.command, 90) : null;
    case 'read_file': case 'write_file': case 'replace': return s(a.file_path) ? shortPath(a.file_path) : null;
    case 'list_directory': return s(a.dir_path) ? shortPath(a.dir_path) : null;
    case 'glob': case 'grep_search': return s(a.pattern) ? oneLine(a.pattern, 90) : null;
    case 'google_web_search': return s(a.query) ? oneLine(a.query, 90) : null;
    case 'web_fetch': return s(a.prompt) ? oneLine(a.prompt, 90) : null;
    default:
      for (const k of ['file_path', 'dir_path', 'path', 'command', 'query', 'pattern', 'prompt', 'description']) {
        if (s(a[k])) return /path$/.test(k) ? shortPath(a[k]) : oneLine(a[k], 90);
      }
      return null;
  }
}

/**
 * ToolCallRecord → { tool, detail } (argument summary first, then the CLI's own description of the invocation).
 * @param {any} tc
 */
function describeGeminiCall(tc) {
  const tool = str(tc && tc.name);
  const detail = describeArgs(tool, tc && tc.args) || (typeof (tc && tc.description) === 'string' ? oneLine(tc.description, 90) || null : null);
  return { tool, detail };
}

// Error text of a finished tool call: resultDisplay, else the functionResponse error / output
function toolResultText(tc) {
  if (typeof tc.resultDisplay === 'string' && tc.resultDisplay.trim()) return tc.resultDisplay;
  for (const p of partsOf(tc.result)) {
    const fr = p.functionResponse;
    if (!fr || typeof fr !== 'object') { if (typeof p.text === 'string' && p.text.trim()) return p.text; continue; }
    const r = fr.response;
    if (!r || typeof r !== 'object') continue;
    if (typeof r.error === 'string') return r.error;
    if (r.error && typeof r.error.message === 'string') return r.error.message;
    if (typeof r.output === 'string') return r.output;
  }
  return '';
}

// Successful write_file / replace → { path, op }. write_file counts as create when the diff shows no original content (inferred).
function fileOpOf(tc) {
  if (tc.status !== 'success' || !FILE_TOOLS.has(tc.name)) return null;
  const p = tc.args && tc.args.file_path;
  if (typeof p !== 'string' || !p) return null;
  const d = tc.resultDisplay;
  const created = tc.name === 'write_file' && !!d && typeof d === 'object' && (d.isNewFile === true || d.originalContent === null);
  return { path: p, op: created ? 'create' : 'edit' };
}

function agentNameOf(args) {
  const a = args && typeof args === 'object' ? args : {};
  for (const k of ['agent_name', 'agentName', 'subagent_type', 'name']) if (typeof a[k] === 'string' && a[k].trim()) return oneLine(a[k], 60);
  return null;
}

// ---------------------------------------------------------------------------
// Recording state
// ---------------------------------------------------------------------------

function newSessionState(limits = DEFAULT_LIMITS, fileId = null) {
  return {
    limits,
    fileId,
    meta: null,          // { sessionId, projectHash, startTimeMs, kind, summary, directories }
    lastUpdatedMs: null, // metadata lastUpdated
    order: [],           // message ids in conversation order (after $rewindTo / checkpoints)
    msgs: new Map(),     // message id -> summary (see summarize)
    ledger: new Map(),   // gemini message id -> { model, ms, tokens } for every id ever seen (last copy wins)
    tools: new Map(),    // tool call id -> summary for every call ever seen (last copy wins)
    errMsgs: new Map(),  // error message id -> { ms, text }
    firstPrompt: null,   // first prompt ever seen (title)
    lastModel: null,     // model of the latest gemini message in file order
    lastText: null,      // { id, text, ms }: latest gemini answer in file order, up to resultChars (the result)
    firstTs: null,
    lastTs: null,
    rewinds: 0,
    checkpoints: 0,
    dirty: true,         // ledger / tools changed since aggregate() last ran
    agg: null,
  };
}

function noteTs(s, ms) {
  if (ms == null) return;
  if (s.firstTs == null || ms < s.firstTs) s.firstTs = ms;
  if (s.lastTs == null || ms > s.lastTs) s.lastTs = ms;
}

function mergeMeta(s, o) {
  const m = s.meta || (s.meta = { sessionId: null, projectHash: null, startTimeMs: null, kind: null, summary: null, directories: null });
  if (typeof o.sessionId === 'string' && o.sessionId) m.sessionId = o.sessionId;
  if (typeof o.projectHash === 'string' && o.projectHash) m.projectHash = o.projectHash;
  if (o.startTime !== undefined) { const t = tsOf(o.startTime); if (t != null) m.startTimeMs = t; }
  if (o.kind === 'main' || o.kind === 'subagent') m.kind = o.kind;
  if (typeof o.summary === 'string') m.summary = o.summary.trim() || null;
  if (Array.isArray(o.directories)) m.directories = o.directories.filter((d) => typeof d === 'string');
  if (o.lastUpdated !== undefined) {
    const t = tsOf(o.lastUpdated);
    if (t != null) { s.lastUpdatedMs = t; noteTs(s, t); }
  }
}

function summarize(s, m, type, ms) {
  const sum = {
    id: m.id, type, ms,
    role: null,          // user: 'prompt' | 'context' | 'command' | 'toolResult'
    text: '',
    calls: null,         // gemini: functionCall parts visible in content (tool calls not finished yet)
    emptyContent: false, // gemini: content '' — the CLI records a tool-call-only response this way before the tools run
    toolCalls: null,     // gemini: finished tool calls
    thoughts: false,
    input: null,         // gemini: tokens.input (context size of this request)
    model: null,
  };
  if (type === 'user') {
    if (hasFunctionResponse(m.content)) sum.role = 'toolResult';
    else {
      const t = textOf(m.content);
      sum.text = cap(t.trim(), MSG_TEXT_CHARS);
      sum.role = isCommandText(t) ? 'command' : isContextText(t) ? 'context' : 'prompt';
    }
  } else if (type === 'gemini') {
    sum.text = cap(textOf(m.content).trim(), MSG_TEXT_CHARS);
    const calls = callsOf(m.content);
    if (calls.length) sum.calls = calls.map((c) => ({ tool: c.name, detail: describeArgs(c.name, c.args) }));
    sum.emptyContent = m.content === '' || m.content == null;
    if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
      sum.toolCalls = [];
      for (const tc of m.toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const d = describeGeminiCall(tc);
        sum.toolCalls.push({ id: str(tc.id), tool: d.tool, detail: d.detail, status: str(tc.status), ms: tsOf(tc.timestamp) ?? ms });
      }
      if (!sum.toolCalls.length) sum.toolCalls = null;
    }
    sum.thoughts = Array.isArray(m.thoughts) && m.thoughts.length > 0;
    if (m.tokens && typeof m.tokens === 'object') sum.input = int(m.tokens.input);
    sum.model = str(m.model);
  } else {
    sum.text = cap(textOf(m.content).trim(), type === 'error' ? ERROR_TEXT_CHARS : MSG_TEXT_CHARS);
  }
  return sum;
}

function toolSummary(tc, fallbackMs) {
  const d = describeGeminiCall(tc);
  const status = str(tc.status);
  return {
    tool: d.tool,
    detail: d.detail,
    status,
    ms: tsOf(tc.timestamp) ?? fallbackMs ?? 0,
    agentId: str(tc.agentId),
    agentName: agentNameOf(tc.args) || str(tc.displayName),
    file: fileOpOf(tc),
    errText: status === 'error' ? firstLine(toolResultText(tc), 200) || '' : null,
  };
}

function onMessage(s, m) {
  const ms = tsOf(m.timestamp);
  noteTs(s, ms);
  const type = typeof m.type === 'string' ? m.type : 'unknown';
  const sum = summarize(s, m, type, ms);
  if (!s.msgs.has(m.id)) s.order.push(m.id); // a repeated id keeps its place (Map semantics of the CLI loader)
  s.msgs.set(m.id, sum);
  if (type === 'gemini') {
    if (sum.model) s.lastModel = sum.model;
    if (sum.text) s.lastText = { id: m.id, text: cap(textOf(m.content).trim(), s.limits.resultChars), ms: ms ?? 0 };
    if (m.tokens && typeof m.tokens === 'object') {
      s.ledger.set(m.id, { model: sum.model, ms, tokens: pricing.geminiUsageTokens(m.tokens) });
      s.dirty = true;
    }
    if (Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        if (!tc || typeof tc !== 'object' || typeof tc.id !== 'string') continue;
        s.tools.set(tc.id, toolSummary(tc, ms));
        s.dirty = true;
      }
    }
  } else if (type === 'error') {
    s.errMsgs.set(m.id, { ms: ms ?? 0, text: firstLine(sum.text, 200) || '' });
    s.dirty = true;
  } else if (type === 'user' && sum.role === 'prompt' && !s.firstPrompt && sum.text) {
    s.firstPrompt = sum.text;
  }
}

// {"$rewindTo": id}: drop that message and everything after it; an unknown id clears the conversation (as the CLI loader does)
function onRewind(s, id) {
  const i = s.order.indexOf(id);
  const removed = s.order.splice(i >= 0 ? i : 0);
  for (const r of removed) s.msgs.delete(r);
  s.rewinds++;
}

function onSet(s, set) {
  if (Array.isArray(set.messages)) {
    // Checkpoint: the conversation is rebuilt from this array
    s.order = [];
    s.msgs.clear();
    s.checkpoints++;
    for (const msg of set.messages) if (msg && typeof msg === 'object' && typeof msg.id === 'string') onMessage(s, msg);
  }
  mergeMeta(s, set);
}

function onMeta(s, e) {
  mergeMeta(s, e);
  // A legacy record (or a legacy record on one line) carries the messages inline
  if (Array.isArray(e.messages)) {
    for (const msg of e.messages) if (msg && typeof msg === 'object' && typeof msg.id === 'string') onMessage(s, msg);
  }
}

/**
 * One record (a jsonl line, or a whole legacy .json record) → state. Same dispatch order as the CLI's loadConversationRecord.
 * @param {ReturnType<typeof newSessionState>} s
 * @param {any} e
 */
function ingestGemini(s, e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return;
  if (typeof e.$rewindTo === 'string') onRewind(s, e.$rewindTo);
  else if (typeof e.id === 'string') onMessage(s, e);
  else if (e.$set && typeof e.$set === 'object' && !Array.isArray(e.$set)) onSet(s, e.$set);
  else if (typeof e.sessionId === 'string' && typeof e.projectHash === 'string') onMeta(s, e);
}

function safeIngest(s, e) {
  try { ingestGemini(s, e); } catch { /* malformed record: skip it */ }
}

// ---------------------------------------------------------------------------
// Totals (recomputed only after the ledger / tools changed)
// ---------------------------------------------------------------------------

function aggregate(s) {
  if (!s.dirty && s.agg) return s.agg;
  const a = {
    input: 0, cached: 0, output: 0, thoughts: 0, tool: 0, processed: 0, apiCalls: 0,
    costUsd: 0, pricedAny: false, unpricedTokens: 0, unpricedModel: null, estimated: false, lastApiMs: null,
    toolCalls: 0, toolErrors: 0, files: new Map(), errors: [],
  };
  for (const x of s.ledger.values()) {
    const t = x.tokens;
    a.input += t.input;
    a.cached += t.cached;
    a.output += t.output + t.thoughts;
    a.thoughts += t.thoughts;
    a.tool += t.tool;
    a.processed += t.total;
    a.apiCalls++;
    const usd = pricing.priceGeminiTokens(x.model, t, { atMs: x.ms });
    if (usd == null) {
      a.unpricedTokens += t.total;
      if (!a.unpricedModel && x.model) a.unpricedModel = x.model;
    } else {
      a.costUsd += usd;
      a.pricedAny = true;
      if (t.tool > 0) a.estimated = true; // tool-use prompt tokens priced at the input price (inferred)
    }
    if (x.ms != null && (a.lastApiMs == null || x.ms > a.lastApiMs)) a.lastApiMs = x.ms;
  }
  for (const tc of s.tools.values()) {
    a.toolCalls++;
    if (tc.status === 'error') {
      a.toolErrors++;
      a.errors.push({ ms: tc.ms, tool: tc.tool, text: tc.errText || '' });
    }
    if (tc.file) {
      let f = a.files.get(tc.file.path);
      if (!f) { f = { path: tc.file.path, op: tc.file.op, count: 0, lastMs: 0, movedTo: null }; a.files.set(tc.file.path, f); }
      f.count++;
      if (tc.ms >= f.lastMs) f.lastMs = tc.ms;
    }
  }
  for (const e of s.errMsgs.values()) a.errors.push({ ms: e.ms, tool: null, text: e.text });
  a.errors.sort((x, y) => x.ms - y.ms);
  if (a.errors.length > s.limits.errorsPerAgent) a.errors = a.errors.slice(-s.limits.errorsPerAgent);
  if (a.files.size > s.limits.filesPerAgent) {
    const keep = [...a.files.values()].sort((x, y) => y.lastMs - x.lastMs).slice(0, s.limits.filesPerAgent);
    a.files = new Map(keep.map((f) => [f.path, f]));
  }
  s.agg = a;
  s.dirty = false;
  return a;
}

// Current model and context size, from the conversation (falls back to file order)
function convInfo(s) {
  let model = null;
  let used = null;
  for (let i = s.order.length - 1, n = 0; i >= 0 && n < CONV_SCAN && (model == null || used == null); i--, n++) {
    const m = s.msgs.get(s.order[i]);
    if (!m || m.type !== 'gemini') continue;
    if (model == null && m.model) model = m.model;
    if (used == null && m.input != null) used = m.input;
  }
  return { model: model || s.lastModel || null, used: used || 0 };
}

function contextWindowOf(model) {
  return CONTEXT_WINDOWS[pricing.normalizeGeminiModel(model)] || null;
}

// ---------------------------------------------------------------------------
// Status inference
// ---------------------------------------------------------------------------

function isMeaningful(m) {
  if (m.type === 'gemini' || m.type === 'error') return true;
  return m.type === 'user' && m.role !== 'command';
}

// Last meaningful message (info / warning notices and slash commands skipped) and its index in order
function lastMeaningful(s) {
  for (let i = s.order.length - 1, n = 0; i >= 0 && n < TAIL_SCAN; i--, n++) {
    const m = s.msgs.get(s.order[i]);
    if (m && isMeaningful(m)) return { last: m, idx: i };
  }
  return { last: null, idx: -1 };
}

function prevGemini(s, idx) {
  for (let i = idx - 1, n = 0; i >= 0 && n < TAIL_SCAN; i--, n++) {
    const m = s.msgs.get(s.order[i]);
    if (!m) continue;
    if (m.type === 'gemini') return m;
    if (m.type === 'user' && m.role !== 'toolResult') return null;
  }
  return null;
}

// Tool calls issued by a gemini message that have not finished (the CLI writes toolCalls only after they finish)
function pendingOf(m) {
  if (!m || m.type !== 'gemini' || m.toolCalls) return null;
  if (m.calls && m.calls.length) return m.calls.map((c) => ({ tool: c.tool, detail: c.detail, sinceMs: m.ms }));
  if (m.emptyContent && !m.text) return [{ tool: null, detail: null, sinceMs: m.ms }];
  return null;
}

function latestCall(list) {
  let best = null;
  for (const c of list || []) if (!best || (c.ms ?? 0) >= (best.ms ?? 0)) best = c;
  return best;
}

/**
 * guessAwaitingApproval with Gemini's fast-tool list. Until status.js knows Gemini's fast tools, fastTools mode keeps only
 * the Gemini fast tools and applies the same wait (mode allTools with the wait expressed in minutes).
 * @param {{ pending: { tool: string|null, sinceMs: number }[], now: number, mode?: string, seconds?: number, staleMinutes?: number }} o
 */
function guessGeminiApproval(o) {
  const mode = o.mode || APPROVAL_GUESS.FAST_TOOLS;
  if (mode !== APPROVAL_GUESS.FAST_TOOLS || (FAST_TOOLS && FAST_TOOLS.gemini)) {
    return guessAwaitingApproval({ ...o, provider: PROVIDER, mode, hasRegistry: false });
  }
  const seconds = o.seconds ?? APPROVAL_GUESS_DEFAULT_SECONDS;
  return guessAwaitingApproval({
    provider: PROVIDER,
    pending: (o.pending || []).filter((p) => p && GEMINI_FAST_TOOL_SET.has(p.tool)),
    now: o.now,
    mode: APPROVAL_GUESS.ALL_TOOLS,
    staleMinutes: seconds / 60,
    hasRegistry: false,
  });
}

function errorStatus(m, fallbackMs) {
  const text = m.text || '';
  const since = m.ms ?? fallbackMs;
  if (QUOTA_RE.test(text)) {
    return makeStatus(STATUS.QUOTA, since, {
      quota: { kind: 'unknown', model: null, resetsAtMs: null, resetsText: null, source: 'text', autoContinue: null },
    });
  }
  const h = /\b([45]\d\d)\b/.exec(text);
  return makeStatus(STATUS.API_ERROR, since, { error: { kind: 'unknown', http: h ? Number(h[1]) : null, message: firstLine(text, 200) } });
}

/**
 * Recording state → AgentStatus. Everything timing-based carries certainty 'guess'.
 * @param {ReturnType<typeof newSessionState>} s
 * @param {{ now: number, mtimeMs?: number, staleMs: number, settleMs?: number, isMain?: boolean, childWorking?: boolean,
 *   approvalGuess?: string, approvalGuessSeconds?: number, staleMinutes?: number }} o
 * @returns {import('../core/status').AgentStatus}
 */
function classifySession(s, o) {
  const now = o.now;
  const lastWrite = Math.max(s.lastTs || 0, o.mtimeMs || 0);
  const quiet = now - lastWrite;
  const stale = quiet > o.staleMs;
  const settleMs = o.settleMs ?? SETTLE_SECONDS_DEFAULT * 1e3;
  const G = { certainty: 'guess' };
  const { last, idx } = lastMeaningful(s);

  if (!last) {
    if (stale) return makeStatus(STATUS.STALE, lastWrite, G);
    return makeStatus(STATUS.STARTING, (s.meta && s.meta.startTimeMs) || s.firstTs || lastWrite, G);
  }
  if (last.type === 'error') return errorStatus(last, lastWrite);

  if (last.type === 'user') {
    // Tool results after tool calls that were all cancelled: the turn was stopped
    if (last.role === 'toolResult') {
      const g = prevGemini(s, idx);
      if (g && g.toolCalls && g.toolCalls.every((c) => c.status === 'cancelled')) {
        return makeStatus(STATUS.INTERRUPTED, (latestCall(g.toolCalls) || {}).ms ?? last.ms ?? lastWrite);
      }
    }
    // A prompt, injected context or tool results were sent: the model is working
    if (stale) return makeStatus(STATUS.STALE, lastWrite, G);
    return makeStatus(STATUS.THINKING, last.ms ?? lastWrite, G);
  }

  // gemini
  if (last.toolCalls) {
    const lc = latestCall(last.toolCalls);
    if (last.toolCalls.some((c) => c.tool === COMPLETE_TASK_TOOL && c.status === 'success')) {
      return makeStatus(STATUS.DONE, lc.ms ?? last.ms ?? lastWrite);
    }
    if (last.toolCalls.every((c) => c.status === 'cancelled')) return makeStatus(STATUS.INTERRUPTED, lc.ms ?? lastWrite);
    // Tools finished; their results go back to the model
    if (stale) return makeStatus(STATUS.STALE, lastWrite, G);
    return makeStatus(STATUS.THINKING, lc.ms ?? last.ms ?? lastWrite, G);
  }

  const pend = pendingOf(last);
  if (pend) {
    const latest = pend[pend.length - 1];
    const since = last.ms ?? lastWrite;
    const q = pend.find((p) => p.tool && QUESTION_TOOLS[p.tool]);
    if (q && !o.childWorking) {
      return makeStatus(STATUS.AWAITING_INPUT, since, { pendingTool: q.tool, question: QUESTION_TOOLS[q.tool] });
    }
    // A sub-agent is still writing: the call that launched it is running
    if (o.childWorking) return makeStatus(STATUS.TOOL, since, { pendingTool: latest.tool, certainty: 'guess' });
    const hit = guessGeminiApproval({
      pending: pend.map((p) => ({ tool: p.tool, sinceMs: since })),
      now,
      mode: o.approvalGuess || APPROVAL_GUESS.FAST_TOOLS,
      seconds: o.approvalGuessSeconds ?? APPROVAL_GUESS_DEFAULT_SECONDS,
      staleMinutes: o.staleMinutes ?? o.staleMs / 60e3,
    });
    if (hit) return makeStatus(STATUS.MAYBE_AWAITING_APPROVAL, hit.sinceMs, { pendingTool: hit.tool });
    if (stale) return makeStatus(STATUS.STALE, lastWrite, { stalePending: true, pendingTool: latest.tool, certainty: 'guess' });
    return makeStatus(STATUS.TOOL, since, { pendingTool: latest.tool, certainty: 'guess' });
  }

  // A text answer: either the turn ended, or a tool the recording does not show yet is running / waiting for approval.
  // Indistinguishable, so: working while writes are recent, done once the file has been quiet for settleMs (a later write undoes it).
  if (o.childWorking) return makeStatus(STATUS.TOOL, last.ms ?? lastWrite, G);
  if (quiet < settleMs) return makeStatus(STATUS.THINKING, last.ms ?? lastWrite, G);
  return makeStatus(STATUS.DONE, last.ms ?? lastWrite, G);
}

/**
 * Current step.
 * @param {ReturnType<typeof newSessionState>} s
 * @returns {import('../core/status').Step|null}
 */
function stepOf(s) {
  const { last, idx } = lastMeaningful(s);
  if (!last) return null;
  const pend = pendingOf(last);
  if (pend) {
    const p = pend[pend.length - 1];
    return { kind: STEP.TOOL, tool: p.tool, detail: p.detail, parallel: pend.length, sinceMs: last.ms };
  }
  if (last.type === 'gemini' && last.toolCalls) {
    const tc = latestCall(last.toolCalls);
    return { kind: STEP.TOOL_RESULT, tool: tc.tool, detail: tc.detail, parallel: 0, sinceMs: tc.ms };
  }
  if (last.type === 'gemini') {
    return { kind: last.text ? STEP.TEXT : STEP.THINKING, tool: null, detail: last.text ? oneLine(last.text, 90) : null, parallel: 0, sinceMs: last.ms };
  }
  if (last.type === 'user' && last.role === 'toolResult') {
    const g = prevGemini(s, idx);
    const tc = g && g.toolCalls ? latestCall(g.toolCalls) : null;
    return { kind: STEP.TOOL_RESULT, tool: tc ? tc.tool : null, detail: tc ? tc.detail : null, parallel: 0, sinceMs: last.ms };
  }
  if (last.type === 'user') return { kind: STEP.PROMPT, tool: null, detail: oneLine(last.text, 90) || null, parallel: 0, sinceMs: last.ms };
  return { kind: STEP.NONE, tool: null, detail: null, parallel: 0, sinceMs: last.ms };
}

function eventsOf(m) {
  const ms = m.ms ?? 0;
  if (m.type === 'user') return m.role === 'prompt' ? [{ ms, kind: 'prompt', tool: null, detail: oneLine(m.text, 90) || null }] : [];
  if (m.type === 'error') return [{ ms, kind: 'apiError', tool: null, detail: firstLine(m.text, 200) }];
  if (m.type !== 'gemini') return [];
  const ev = [];
  if (m.text) ev.push({ ms, kind: 'text', tool: null, detail: oneLine(m.text, 90) });
  if (m.toolCalls) {
    for (const tc of [...m.toolCalls].sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0))) {
      const kind = tc.status === 'error' ? 'toolError' : tc.status === 'cancelled' ? 'interrupt' : 'toolDone';
      ev.push({ ms: tc.ms ?? ms, kind, tool: tc.tool, detail: tc.detail });
    }
  } else if (m.calls) {
    for (const c of m.calls) ev.push({ ms, kind: 'tool', tool: c.tool, detail: c.detail });
  }
  return ev;
}

// Last max timeline events of the conversation as it stands
function timelineOf(s, max) {
  const out = [];
  for (let i = s.order.length - 1; i >= 0 && out.length < max; i--) {
    const m = s.msgs.get(s.order[i]);
    if (!m) continue;
    const evs = eventsOf(m);
    for (let j = evs.length - 1; j >= 0 && out.length < max; j--) out.push(evs[j]);
  }
  return out.reverse();
}

function resultOf(s) {
  for (let i = s.order.length - 1, n = 0; i >= 0 && n < CONV_SCAN; i--, n++) {
    const m = s.msgs.get(s.order[i]);
    if (!m || m.type !== 'gemini' || !m.text) continue;
    const full = s.lastText && s.lastText.id === m.id ? s.lastText.text : m.text;
    return { text: full, ms: m.ms ?? 0, source: 'lastText' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

// Legacy whole-file session-*.json: re-parsed only when mtime / size change; a failed parse keeps the previous state
class LegacyReader {
  constructor(file, init) {
    this.file = file;
    this.init = init;
    this.state = init();
    this.mtimeMs = 0;
    this.size = -1;
    this.parses = 0;
  }

  poll() {
    const st = statOf(this.file);
    if (!st) return false;
    if (st.mtimeMs === this.mtimeMs && st.size === this.size) return false;
    this.mtimeMs = st.mtimeMs;
    this.size = st.size;
    if (!(st.size > 0) || st.size > LEGACY_MAX_BYTES) return false;
    let obj;
    try { obj = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return false; }
    const s = this.init();
    safeIngest(s, obj);
    this.state = s;
    this.parses++;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Gemini CLI provider. Usage (worker / terminal version):
 *   const p = new GeminiProvider({ geminiHome, activeWindowMinutes, staleMinutes, limits, approvalGuess, approvalGuessSeconds, settleSeconds });
 *   const sessions = p.scan(now);          // Session[], filtered by the activity window, sorted by updatedMs descending
 *   const q = p.quota();                   // { lastHit }: the latest quota error seen in a recording
 *   const d = p.details(keys);             // { [sessionKey]: SessionDetail }, only for sessions that appeared in scan
 */
class GeminiProvider {
  /**
   * @param {{ geminiHome?: string, gemini?: { home?: string }, home?: string, activeWindowMinutes?: number, staleMinutes?: number,
   *   limits?: Partial<typeof DEFAULT_LIMITS>, approvalGuess?: 'fastTools'|'allTools'|'off', approvalGuessSeconds?: number,
   *   settleSeconds?: number, maxTracked?: number, sandboxDir?: boolean, env?: Record<string, string|undefined> }} [opts]
   *   The runtime directory is opts.geminiHome / opts.gemini.home / opts.home, else $GEMINI_CLI_HOME/.gemini, else ~/.gemini.
   *   Without an explicit directory, <home>/.cache/.gemini (macOS Seatbelt sandbox) is scanned too unless sandboxDir is false.
   */
  constructor(opts = {}) {
    const env = opts.env || process.env;
    const explicit = [opts.geminiHome, opts.gemini && opts.gemini.home, opts.home].map((v) => expandHome(v)).find(Boolean) || null;
    const envBase = expandHome(env.GEMINI_CLI_HOME);
    const base = envBase || os.homedir();
    this.home = explicit || path.join(base, '.gemini');
    this.homeSource = explicit ? 'setting' : envBase ? 'env' : 'default';
    this.runtimeDirs = [this.home];
    if (!explicit && opts.sandboxDir !== false) this.runtimeDirs.push(path.join(base, '.cache', '.gemini'));
    this.windowMs = (opts.activeWindowMinutes ?? 30) * 60e3;
    this.staleMinutes = opts.staleMinutes ?? 5;
    this.staleMs = this.staleMinutes * 60e3;
    this.settleMs = (opts.settleSeconds ?? SETTLE_SECONDS_DEFAULT) * 1e3;
    this.approvalGuess = opts.approvalGuess || APPROVAL_GUESS.FAST_TOOLS;
    this.approvalGuessSeconds = opts.approvalGuessSeconds ?? APPROVAL_GUESS_DEFAULT_SECONDS;
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    this.maxTracked = opts.maxTracked ?? MAX_TRACKED;
    this.files = new Map();        // file -> entry { file, mtimeMs, size, legacy, chatsDir, projectDir, runtimeDir, parentId }
    this.byChats = new Map();      // chats dir -> entries (for parent lookups)
    this.dirs = new Map();         // chats dir -> { dirMtime, scannedMs, newestMs, entries }
    this.readers = new Map();      // file -> { tail: JsonlTail|LegacyReader, entry }
    this.idFile = new Map();       // session id -> file (so kept sessions can be found outside the window)
    this.startedMs = new Map();    // session id -> stable start time
    this.firstSeen = new Map();    // file -> first-seen time
    this.registries = new Map();   // runtime dir -> { mtimeMs, bySlug, byHash } from projects.json
    this.projectRoots = new Map(); // project dir -> { mtimeMs, root } from .project_root
    this.built = new Map();        // sessionKey -> { rootId, files: { [agentId]: file } }
    this.lastQuota = null;         // latest quota hit (QuotaHit & { ms, sessionKey })
    this.lastDiscover = -Infinity;
  }

  // ---------- Discovery ----------

  discover(now) {
    this.lastDiscover = now;
    const files = new Map();
    const byChats = new Map();
    const seen = new Set();
    for (const rt of this.runtimeDirs) {
      const tmp = path.join(rt, 'tmp');
      for (const d of listDirents(tmp)) {
        if (!d.isDirectory()) continue;
        const projectDir = path.join(tmp, d.name);
        const chatsDir = path.join(projectDir, 'chats');
        const st = statOf(chatsDir);
        if (!st || !st.isDirectory()) continue;
        seen.add(chatsDir);
        let c = this.dirs.get(chatsDir);
        const hot = c && now - c.newestMs < this.windowMs;
        if (!c || c.dirMtime !== st.mtimeMs || hot || now - c.scannedMs >= COLD_DIR_MS || now < c.scannedMs) {
          const entries = listChats(chatsDir, projectDir, rt);
          c = { dirMtime: st.mtimeMs, scannedMs: now, newestMs: Math.max(0, ...entries.map((x) => x.mtimeMs)), entries };
          this.dirs.set(chatsDir, c);
        }
        byChats.set(chatsDir, c.entries);
        for (const x of c.entries) files.set(x.file, { ...x });
      }
    }
    for (const k of [...this.dirs.keys()]) if (!seen.has(k)) this.dirs.delete(k);
    // Files being read: the reader's stat result wins (it is more up to date)
    for (const [f, r] of this.readers) {
      const x = files.get(f);
      if (x && r.tail.mtimeMs > x.mtimeMs) x.mtimeMs = r.tail.mtimeMs;
    }
    this.files = files;
    this.byChats = byChats;
  }

  // ---------- Readers ----------

  track(x, now) {
    let r = this.readers.get(x.file);
    if (r) return r;
    const limits = this.limits;
    const init = () => newSessionState(limits, x.file);
    const tail = x.legacy ? new LegacyReader(x.file, init) : new JsonlTail(x.file, init, safeIngest);
    r = { tail, entry: x };
    this.readers.set(x.file, r);
    if (!this.firstSeen.has(x.file)) remember(this.firstSeen, x.file, now);
    return r;
  }

  poll(r) {
    r.tail.poll();
    const x = this.files.get(r.entry.file);
    if (x && r.tail.mtimeMs) x.mtimeMs = r.tail.mtimeMs;
  }

  // Files that may hold the recording of session pid, looked up next to a sub-agent recording
  parentCandidates(entry, pid) {
    const out = [];
    const short = pid.slice(0, 8);
    for (const x of this.byChats.get(entry.chatsDir) || []) {
      const name = path.basename(x.file);
      if (!x.parentId && (name.endsWith(`-${short}.jsonl`) || name.endsWith(`-${short}.json`))) out.push(x);
      else if (x.parentId && name === `${pid}.jsonl`) out.push(x); // nested sub-agent
    }
    return out.map((x) => this.files.get(x.file) || x);
  }

  // Stable start time: metadata startTime → first record time → first-seen time; once set it never changes
  stableStart(id, r, now) {
    const known = this.startedMs.get(id);
    if (known != null) return known;
    const s = r.tail.state;
    const v = (s.meta && s.meta.startTimeMs) || s.firstTs || this.firstSeen.get(r.entry.file) || now;
    return remember(this.startedMs, id, v);
  }

  // projects.json → slug / legacy sha256 dir name / projectHash → project root
  registry(rt) {
    const f = path.join(rt, 'projects.json');
    const st = statOf(f);
    const mt = st ? st.mtimeMs : 0;
    let c = this.registries.get(rt);
    if (c && c.mtimeMs === mt) return c;
    c = { mtimeMs: mt, bySlug: new Map(), byHash: new Map() };
    if (st && st.size > 0 && st.size <= REGISTRY_MAX_BYTES) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        const projects = j && typeof j.projects === 'object' && j.projects ? j.projects : {};
        for (const [p, slug] of Object.entries(projects)) {
          if (typeof slug === 'string') c.bySlug.set(slug, p);
          c.byHash.set(sha256(p), p);
        }
      } catch { /* unreadable registry: no mapping */ }
    }
    this.registries.set(rt, c);
    return c;
  }

  cwdOf(entry, meta) {
    const pd = entry.projectDir;
    const marker = path.join(pd, '.project_root');
    const mt = mtimeOf(marker);
    let c = this.projectRoots.get(pd);
    if (!c || c.mtimeMs !== mt) {
      let root = null;
      if (mt) { try { root = fs.readFileSync(marker, 'utf8').trim() || null; } catch { root = null; } }
      c = remember(this.projectRoots, pd, { mtimeMs: mt, root });
    }
    if (c.root) return c.root;
    const reg = this.registry(entry.runtimeDir);
    const id = path.basename(pd);
    const hash = meta && meta.projectHash;
    return reg.bySlug.get(id) || reg.byHash.get(id) || (hash && reg.byHash.get(hash)) || (meta && meta.directories && meta.directories[0]) || null;
  }

  /**
   * Scan once and return the sessions in the window.
   * @param {number} [now]
   * @param {{ keepKeys?: Iterable<string> }} [opts] keepKeys: sessions to keep even outside the activity window
   * @returns {import('../core/status').Session[]}
   */
  scan(now = Date.now(), opts = {}) {
    if (now - this.lastDiscover >= DISCOVER_MS || now < this.lastDiscover) this.discover(now);
    const keep = new Set();
    for (const k of opts.keepKeys || []) {
      const pk = parseSessionKey(k);
      if (pk && pk.provider === PROVIDER) keep.add(pk.id);
    }
    const keepFiles = new Set();
    for (const id of keep) { const f = this.idFile.get(id); if (f) keepFiles.add(f); }

    // 1. Read the recordings in the window (newest first, capped) and those holding kept sessions; release vanished files
    for (const f of [...this.readers.keys()]) if (!this.files.has(f)) this.readers.delete(f);
    const cands = [];
    for (const x of this.files.values()) if (now - x.mtimeMs < this.windowMs || keepFiles.has(x.file)) cands.push(x);
    cands.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : 1));
    const want = new Set();
    cands.forEach((x, i) => { if (i < this.maxTracked || keepFiles.has(x.file)) { this.track(x, now); want.add(x.file); } });
    for (const r of this.readers.values()) this.poll(r);

    // 2. Also read the parent of sub-agent recordings (a parent outside the window is still included)
    for (let round = 0; round < 4; round++) {
      const ids = new Set();
      for (const r of this.readers.values()) { const m = r.tail.state.meta; if (m && m.sessionId) ids.add(m.sessionId); }
      let added = false;
      for (const r of [...this.readers.values()]) {
        const pid = r.entry.parentId;
        if (!pid || ids.has(pid)) continue;
        for (const x of this.parentCandidates(r.entry, pid)) {
          if (this.readers.has(x.file)) continue;
          this.poll(this.track(x, now));
          added = true;
        }
      }
      if (!added) break;
    }

    // 3. Index by session id (newest file wins) and group each recording under its root session
    const byId = new Map();
    for (const r of this.readers.values()) {
      const m = r.tail.state.meta;
      if (!m || !m.sessionId) continue;
      const old = byId.get(m.sessionId);
      if (!old || r.tail.mtimeMs > old.tail.mtimeMs) byId.set(m.sessionId, r);
    }
    for (const [id, r] of byId) remember(this.idFile, id, r.entry.file);
    const rootOf = (id) => {
      let cur = id;
      for (let i = 0; i < 8; i++) {
        const p = byId.get(cur).entry.parentId;
        if (!p || p === cur || !byId.has(p)) break; // parent not found: becomes its own session
        cur = p;
      }
      return cur;
    };
    const groups = new Map(); // root id -> child ids
    for (const id of byId.keys()) {
      const root = rootOf(id);
      if (!groups.has(root)) groups.set(root, []);
      if (root !== id) groups.get(root).push(id);
    }

    // 4. Build sessions; release readers that are neither used nor in the window
    const out = [];
    const used = new Set();
    this.built = new Map();
    for (const [rootId, childAll] of groups) {
      const root = byId.get(rootId);
      const children = childAll.filter((cid) => now - byId.get(cid).tail.mtimeMs < this.windowMs || keep.has(cid));
      const updatedMs = Math.max(root.tail.mtimeMs || 0, ...children.map((cid) => byId.get(cid).tail.mtimeMs || 0));
      if (!(now - updatedMs < this.windowMs) && !keep.has(rootId)) continue;
      const session = this.buildSession(rootId, root, children.map((cid) => [cid, byId.get(cid)]), now, updatedMs);
      out.push(session);
      const filesById = { [rootId]: root.entry.file };
      used.add(root.entry.file);
      for (const cid of children) { const f = byId.get(cid).entry.file; filesById[cid] = f; used.add(f); }
      this.built.set(session.key, { rootId, files: filesById });
    }
    for (const f of [...this.readers.keys()]) if (!used.has(f) && !want.has(f) && !keepFiles.has(f)) this.readers.delete(f);
    out.sort((a, b) => b.updatedMs - a.updatedMs || (a.key < b.key ? -1 : 1));
    return out;
  }

  classifyOpts(now, mtimeMs, isMain, childWorking) {
    return {
      now, mtimeMs, staleMs: this.staleMs, settleMs: this.settleMs, isMain, childWorking,
      approvalGuess: this.approvalGuess, approvalGuessSeconds: this.approvalGuessSeconds, staleMinutes: this.staleMinutes,
    };
  }

  buildAgent(id, r, kind, now, st, launchedBy) {
    const s = r.tail.state;
    const a = aggregate(s);
    const conv = convInfo(s);
    const window = contextWindowOf(conv.model);
    const used = conv.used;
    return {
      id,
      kind,
      name: launchedBy ? launchedBy.agentName : null,
      agentType: launchedBy ? launchedBy.tool : null,
      phase: null,
      background: false,
      model: conv.model,
      status: st,
      step: stepOf(s),
      tokens: {
        display: used,
        contextUsed: used,
        contextWindow: window,
        compactAt: null,
        toCompact: null,
        contextPct: window ? Math.min(100, Math.max(0, Math.round((used / window) * 100))) : null,
        output: a.output,        // output + thoughts
        processed: a.processed,  // Σ total
        apiCalls: a.apiCalls,
        // Gemini-only breakdown (Σ over every message id seen)
        input: a.input,          // includes cached
        cached: a.cached,
        thoughts: a.thoughts,
        tool: a.tool,
      },
      toolCalls: a.toolCalls,
      toolErrors: a.toolErrors,
      filesChanged: a.files.size,
      costUsd: a.pricedAny ? a.costUsd : (a.unpricedTokens > 0 ? null : 0),
      costEstimated: a.estimated,
      unpricedModel: a.unpricedTokens > 0 ? a.unpricedModel : null,
      lastCompact: null,
      cacheTtl: null,
      startedMs: this.stableStart(id, r, now),
      lastActivityMs: Math.max(s.lastTs || 0, r.tail.mtimeMs || 0),
      lastApiMs: a.lastApiMs,
      mtimeMs: r.tail.mtimeMs || 0,
      file: r.entry.file,
    };
  }

  noteQuota(status, key) {
    if (!status || status.code !== STATUS.QUOTA || !status.quota) return;
    if (!this.lastQuota || status.sinceMs > this.lastQuota.ms) this.lastQuota = { ...status.quota, ms: status.sinceMs, sessionKey: key };
  }

  buildSession(rootId, root, children, now, updatedMs) {
    const rs = root.tail.state;
    const meta = rs.meta || {};
    const key = sessionKey(PROVIDER, rootId);
    // Sub-agent names come from the finished tool call that launched them (toolCalls[].agentId)
    const launched = new Map();
    for (const r of [root, ...children.map((c) => c[1])]) {
      for (const tc of r.tail.state.tools.values()) if (tc.agentId) launched.set(tc.agentId, tc);
    }
    const agents = [];
    for (const [cid, r] of children) {
      const st = classifySession(r.tail.state, this.classifyOpts(now, r.tail.mtimeMs, false, false));
      agents.push(this.buildAgent(cid, r, SUBAGENT_KIND, now, st, launched.get(cid) || null));
    }
    agents.sort((a, b) => (a.startedMs - b.startedMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const childWorking = agents.some((a) => isRunningCode(a.status.code) || isNeedsYouCode(a.status.code));
    const mainSt = classifySession(rs, this.classifyOpts(now, root.tail.mtimeMs, true, childWorking));
    const main = this.buildAgent(rootId, root, 'main', now, mainSt, null);

    let title;
    let titleSource;
    if (meta.summary) { title = oneLine(meta.summary, 80); titleSource = 'ai'; }
    else if (rs.firstPrompt) { title = oneLine(rs.firstPrompt, 40); titleSource = 'prompt'; }
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
      this.noteQuota(a.status, key);
    }
    // No registry: "open" is a guess = some recording of the session written within staleMinutes, and the main agent not stopped
    const code = mainSt.code;
    const lastWrite = Math.max(main.lastActivityMs, ...agents.map((a) => a.lastActivityMs));
    const live = now - lastWrite <= this.staleMs && !STOPPED_CODES.has(code) && code !== STATUS.STALE;
    return {
      key,
      provider: PROVIDER,
      id: rootId,
      title,
      titleSource,
      cwd: this.cwdOf(root.entry, meta),
      projectDir: root.entry.projectDir,
      entry: 'cli',
      entryRaw: null,
      entrypoint: null,
      version: null,
      model: main.model,
      createdMs: meta.startTimeMs || rs.firstTs || null,
      updatedMs,
      startedMs: main.startedMs,
      doneAtMs: code === STATUS.DONE ? mainSt.sinceMs : null,
      live,
      liveStatus: live ? (isNeedsYouCode(code) ? 'waiting' : 'busy') : null,
      liveCertainty: 'guess',
      waitingFor: null,
      compactCount: 0,
      compactLoop: false,
      contextUsed: main.tokens.contextUsed,
      modelVariant: null,
      contextWindow: main.tokens.contextWindow,
      contextWindowSource: main.tokens.contextWindow ? WINDOW_SOURCE.MODEL_RULE : null,
      compactAt: null,
      compactAtSource: null,
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
      transcript: root.entry.file,
      resume: [],
    };
  }

  /**
   * Details: only for sessions that appeared in the previous scan. Uses in-memory state only; never re-reads files.
   * @param {string} idOrKey session id or 'gemini:<id>'
   * @returns {import('../core/status').SessionDetail|null}
   */
  detail(idOrKey) {
    const key = keyOf(idOrKey);
    const b = key && this.built.get(key);
    if (!b) return null;
    const agents = {};
    for (const [id, file] of Object.entries(b.files)) {
      const r = this.readers.get(file);
      if (!r) continue;
      const s = r.tail.state;
      const a = aggregate(s);
      const res = resultOf(s);
      agents[id] = {
        timeline: timelineOf(s, Math.min(this.limits.timeline, this.limits.timelineSent)),
        result: res ? { ...res } : null,
        files: [...a.files.values()].sort((x, y) => y.lastMs - x.lastMs).map((f) => ({ ...f })),
        errors: a.errors.map((e) => ({ ...e })),
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

  /** Gemini recordings carry no quota snapshot; only the latest quota error seen in a scanned recording */
  quota() {
    return { lastHit: this.lastQuota ? { ...this.lastQuota } : null };
  }

  dispose() {
    this.readers.clear();
    this.files.clear();
    this.byChats.clear();
    this.dirs.clear();
    this.built.clear();
  }
}

// One chats directory → entries: session-*.jsonl / session-*.json (a .json that already has a .jsonl sibling was migrated
// by the CLI and is skipped) plus <parentSessionId>/*.jsonl sub-agent recordings
function listChats(chatsDir, projectDir, runtimeDir) {
  const out = [];
  const dirents = listDirents(chatsDir);
  const names = [];
  for (const f of dirents) if ((f.isFile() || f.isSymbolicLink()) && SESSION_FILE_RE.test(f.name)) names.push(f.name);
  const jsonl = new Set(names.filter((n) => n.endsWith('.jsonl')));
  const picked = names.filter((n) => !(n.endsWith('.json') && jsonl.has(n + 'l'))).sort().reverse().slice(0, MAX_FILES_PER_DIR);
  const push = (file, legacy, parentId) => {
    const st = statOf(file);
    if (!st || !st.isFile()) return;
    out.push({ file, mtimeMs: st.mtimeMs, size: st.size, legacy, chatsDir, projectDir, runtimeDir, parentId });
  };
  for (const n of picked) push(path.join(chatsDir, n), n.endsWith('.json'), null);
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const sub = path.join(chatsDir, d.name);
    const subs = listDirents(sub).filter((f) => (f.isFile() || f.isSymbolicLink()) && SUBAGENT_FILE_RE.test(f.name)).map((f) => f.name);
    for (const n of subs.sort().slice(-MAX_SUBAGENT_FILES)) push(path.join(sub, n), false, d.name);
  }
  return out;
}

// 'gemini:<id>' or a bare id → session key; a key of another provider returns null
function keyOf(idOrKey) {
  if (typeof idOrKey !== 'string' || !idOrKey) return null;
  const pk = parseSessionKey(idOrKey);
  if (pk && pk.provider === PROVIDER) return sessionKey(PROVIDER, pk.id);
  if (pk) return null;
  return sessionKey(PROVIDER, idOrKey);
}

module.exports = {
  PROVIDER, SUBAGENT_KIND, DEFAULT_LIMITS, GEMINI_FAST_TOOLS, CONTEXT_WINDOWS, SETTLE_SECONDS_DEFAULT,
  GeminiProvider,
  // The exports below are reused by tests and other modules
  newSessionState, ingestGemini, aggregate, classifySession, stepOf, timelineOf, resultOf, guessGeminiApproval,
  describeGeminiCall, listChats, LegacyReader, contextWindowOf,
  oneLine, shortPath,
};
