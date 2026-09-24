'use strict';
// Qwen Code provider.
// Reads chat records under $QWEN_RUNTIME_DIR / $QWEN_HOME / ~/.qwen (projects/<sanitized cwd>/chats/<sessionId>.jsonl) and the
// runtime sidecar next to each (<sessionId>.runtime.json: pid, hostname, session_id, started_at …), and produces Session v2.
// Read-only (never writes into the Qwen home), no network, no UI text: only status codes, step kinds, numbers, timestamps and
// raw snippets (title, tool-argument summary, result, first error line).
// Liveness comes from the runtime pid (certain); "needs you" is only ever a guess (maybeAwaitingApproval), as Qwen records no
// approval prompts. Sub-agents are the sidechain records (isSidechain / agentId) in the same file.
// Plain Node with no vscode dependency; usable from both the worker and the terminal version.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { JsonlTail } = require('../core/jsonl');
const {
  STATUS, STEP, makeStatus, isRunningCode, isNeedsYouCode, isErrorCode,
  guessAwaitingApproval, sessionKey, parseSessionKey, APPROVAL_GUESS, APPROVAL_GUESS_DEFAULT_SECONDS,
  noteCompact, compactLoopOf,
} = require('../core/status');
const { usedPercent } = require('../core/context');
const { resumeHints } = require('../core/resume');
const pricingQwen = require('../core/pricing-qwen');
const { oneLine, shortPath } = require('./codex');

const PROVIDER = 'qwen';
const SUBAGENT_KIND = 'qwenSubagent';
const WINDOW_SOURCE_RECORD = 'qwen-record'; // Session.contextWindowSource: contextWindowSize taken from the assistant record

const DEFAULT_LIMITS = Object.freeze({ timeline: 30, timelineSent: 12, resultChars: 4000, filesPerAgent: 200, errorsPerAgent: 10 });
const CHAT_RE = /^([^.\\/]+)\.jsonl$/;       // <sessionId>.jsonl (the runtime sidecar is <sessionId>.runtime.json)
const DISCOVER_MS = 5000;                    // re-list chat files every 5 seconds
const COLD_DIR_MS = 60000;                   // with many files, re-list chat directories with nothing recent only every 60 seconds
const MANY_FILES = 2000;
const MAX_SESSIONS = 50;                     // at most this many (newest) transcripts are read per scan, plus keepKeys
const READ_BUDGET_BYTES = 32 * 1024 * 1024;  // bytes read per scan across all transcripts; the rest is read on later scans
const MAX_SUBS = 64;                         // sub-agents remembered per session (oldest dropped)
const MAX_CALL_IDS = 10000;                  // dedupe set for toolCalls; cleared when it grows past this
const MAX_REMEMBER = 5000;                   // cap on remembered startedMs / first-seen entries
const RUNTIME_MAX_BYTES = 64 * 1024;         // a runtime.json larger than this is ignored
const RETRY_GRACE_MS = 120000;               // an API error followed by nothing for less than this, with the process alive, counts as retrying [inferred]
const MANUAL_COMPACT_MS = 60000;             // a chat_compression within 60 s of a /compress command counts as manual

// Qwen Code tools that normally return within seconds: no result long after being issued most likely means an approval prompt
// (or a question to the user). Names from Qwen Code's tool registry; older Gemini CLI names included.
const QWEN_FAST_TOOLS = Object.freeze(['read_file', 'read_many_files', 'write_file', 'edit', 'replace', 'glob', 'grep_search',
  'search_file_content', 'list_directory', 'todo_write', 'save_memory', 'web_fetch', 'exit_plan_mode', 'ask_user_question']);
const QWEN_FAST_SET = new Set(QWEN_FAST_TOOLS);
const WRITE_TOOLS = new Set(['write_file', 'edit', 'replace']);
const QUOTA_RE = /quota|insufficient[_\s-]?balance|arrearage|free[_\s-]?(tier|allocat)|daily[_\s-]?limit/i;
const COMPRESS_CMD_RE = /^\/(compress|compact|summarize)\b/i;

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
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
// Copy of a cut string: V8 keeps the whole original alive behind a slice of it (a long first prompt or answer would stay in memory)
function ownCopy(s) { return Buffer.from(s, 'utf16le').toString('utf16le'); }

// First non-empty line, at most max chars
function firstLine(t, max = 200) {
  if (typeof t !== 'string') return null;
  for (const l of t.split('\n')) { const s = l.trim(); if (s) return oneLine(s, max); }
  return null;
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

function mtimeOf(f) {
  try { return fs.statSync(f).mtimeMs; } catch { return 0; }
}

/**
 * Qwen Code's project directory name for a cwd: every non-[a-zA-Z0-9] character becomes '-' (lowercased first on Windows).
 * @param {string} cwd
 * @param {string} [platform]
 */
function sanitizeCwd(cwd, platform = process.platform) {
  const s = platform === 'win32' ? String(cwd).toLowerCase() : String(cwd);
  return s.replace(/[^a-zA-Z0-9]/g, '-');
}

// ---------------------------------------------------------------------------
// Liveness (runtime.json)
// ---------------------------------------------------------------------------

/** process.kill(pid, 0): alive; EPERM means it exists but belongs to someone else (still alive); anything else is dead. */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/** Reads <sessionId>.runtime.json; null when missing, too large or not a JSON object. */
function readRuntime(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > RUNTIME_MAX_BYTES) return null;
    return obj(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch { return null; }
}

/**
 * runtime.json → true (process alive) / false (process gone) / null (cannot tell: no pid, another host, another session).
 * Qwen Code never deletes the sidecar on exit or crash, so the pid check is the only signal.
 */
function aliveOf(rt, id, hostname, check = isPidAlive) {
  if (!obj(rt)) return null;
  const pid = Number(rt.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (str(rt.hostname) && hostname && rt.hostname !== hostname) return null;
  if (str(rt.session_id) && id && rt.session_id !== id) return null;
  return check(pid);
}

// ---------------------------------------------------------------------------
// Record parsing
// ---------------------------------------------------------------------------

function partsOf(e) {
  const m = obj(e && e.message);
  return m && Array.isArray(m.parts) ? m.parts : [];
}

// Non-thought text parts joined
function textOf(parts) {
  let out = null;
  for (const p of parts) {
    if (!p || p.thought || typeof p.text !== 'string' || !p.text) continue;
    out = out == null ? p.text : out + '\n' + p.text;
  }
  return out;
}

// Tool-call arguments → one-line summary (Qwen Code tool names)
function describeArgs(name, args) {
  const a = obj(args);
  if (!a) return null;
  const pick = (...keys) => { for (const k of keys) if (typeof a[k] === 'string' && a[k]) return a[k]; return null; };
  let d;
  switch (name) {
    case 'read_file': case 'write_file': case 'edit': case 'replace':
      d = shortPath(pick('file_path', 'absolute_path', 'path')); break;
    case 'read_many_files': {
      const ps = Array.isArray(a.paths) ? a.paths.filter((x) => typeof x === 'string') : [];
      d = ps.length ? shortPath(ps[0]) + (ps.length > 1 ? ` +${ps.length - 1}` : '') : null;
      break;
    }
    case 'list_directory':
      d = shortPath(pick('path', 'dir_path', 'absolute_path')); break;
    case 'glob': case 'grep_search': case 'search_file_content':
      d = pick('pattern', 'query'); break;
    case 'run_shell_command':
      d = pick('description', 'command'); break;
    case 'web_fetch':
      d = pick('url', 'prompt'); break;
    case 'web_search':
      d = pick('query'); break;
    case 'task': case 'agent':
      d = pick('description', 'subagent_type', 'prompt'); break;
    case 'save_memory':
      d = pick('fact'); break;
    case 'todo_write':
      d = null; break;
    default:
      d = pick('description', 'file_path', 'absolute_path', 'path', 'query', 'url', 'command', 'pattern', 'prompt', 'name');
      if (!d) for (const v of Object.values(a)) if (typeof v === 'string' && v) { d = v; break; }
  }
  return d ? oneLine(d) : null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function newAgentState(limits = DEFAULT_LIMITS) {
  return {
    limits,
    firstTs: null, lastTs: null,
    agentName: null,
    model: null,
    ctxUsed: 0, ctxWindow: null,  // promptTokenCount / contextWindowSize of the latest assistant record
    turn: null,                   // { startedMs, sawAssistant } the current (open or last) turn
    turnEnd: null,                // { kind: 'done'|'interrupted', ms } set when the current turn ended
    apiError: null,               // { ms, attempt, quota, error } latest API error not followed by progress
    pending: new Map(),           // call id -> { id, tool, detail, args, ms, anon }
    callIds: new Set(),
    anon: 0,
    toolCalls: 0, toolErrors: 0,
    lastEvent: null,              // { kind, tool, detail, ms }
    usage: { apiCalls: 0, output: 0, processed: 0, costUsd: 0, pricedAny: false, estimated: false, unpricedTokens: 0, unpricedModel: null },
    lastApiMs: null,
    timeline: [], files: new Map(), errors: [],
    firstPrompt: null,
    result: null,                 // { text, ms, source, truncated }
    lastDoneMs: null,
    lastCompact: null, compactCount: 0, compactTimes: [],
    lastSlash: null,              // { ms, command }
  };
}

function newFileState(limits = DEFAULT_LIMITS, id = null) {
  return {
    limits, id,
    lines: 0,
    firstTs: null, lastTs: null,
    cwd: null, version: null, gitBranch: null,
    customTitle: null, titleSource: null,
    sessionModel: null,
    main: newAgentState(limits),
    subs: new Map(),              // sub-agent key -> agent state
  };
}

function pushTimeline(s, ev) {
  s.timeline.push(ev);
  const max = (s.limits && s.limits.timeline) || DEFAULT_LIMITS.timeline;
  if (s.timeline.length > max) s.timeline.splice(0, s.timeline.length - max);
}

function pushError(s, ms, tool, text) {
  s.toolErrors++;
  s.errors.push({ ms, tool: tool || null, text: text || '' });
  const max = (s.limits && s.limits.errorsPerAgent) || DEFAULT_LIMITS.errorsPerAgent;
  if (s.errors.length > max) s.errors.splice(0, s.errors.length - max);
  pushTimeline(s, { ms, kind: 'toolError', tool: tool || null, detail: text || null });
}

function addFile(s, ms, filePath, op) {
  if (!filePath) return;
  const f = s.files.get(filePath);
  if (f) {
    f.count++; f.lastMs = ms;
    if (f.op !== 'create') f.op = op;
    return;
  }
  const max = (s.limits && s.limits.filesPerAgent) || DEFAULT_LIMITS.filesPerAgent;
  if (s.files.size >= max) return;
  s.files.set(filePath, { path: filePath, op, count: 1, lastMs: ms, movedTo: null });
}

function setResult(s, text, ms) {
  const max = (s.limits && s.limits.resultChars) || DEFAULT_LIMITS.resultChars;
  const t = String(text);
  s.result = { text: t.length > max ? ownCopy(t.slice(0, max)) : t, ms, source: 'lastText', truncated: t.length > max };
}

function modelOf(s, f) { return s.model || (f && f.sessionModel) || null; }

function addUsage(s, u, ms, model) {
  const tok = pricingQwen.qwenUsageTokens(u);
  s.usage.apiCalls++;
  s.usage.output += tok.output;
  s.usage.processed += tok.total;
  if (tok.prompt) s.ctxUsed = tok.prompt;
  if (ms != null && (s.lastApiMs == null || ms > s.lastApiMs)) s.lastApiMs = ms;
  const pr = pricingQwen.priceQwen(model, u);
  if (!pr) {
    s.usage.unpricedTokens += tok.total;
    if (model) s.usage.unpricedModel = model;
  } else {
    s.usage.costUsd += pr.usd;
    s.usage.pricedAny = true;
    if (pr.estimated) s.usage.estimated = true;
  }
}

// API error → { quota } or { error }; quota wording (free-tier / balance / quota) becomes a QuotaHit [inferred]
function apiErrorOf(s, ms, message, code, http, model) {
  const text = typeof message === 'string' ? message : message != null ? String(message) : '';
  const attempt = s.apiError && !s.apiError.quota ? s.apiError.attempt + 1 : 1;
  if (QUOTA_RE.test(text) || (typeof code === 'string' && QUOTA_RE.test(code))) {
    return { ms, attempt, error: null,
      quota: { kind: 'unknown', model: model || null, resetsAtMs: null, resetsText: null, source: 'text', autoContinue: null } };
  }
  const h = Number(http);
  return { ms, attempt, quota: null,
    error: { kind: str(code) || (typeof code === 'number' ? String(code) : 'unknown'), http: Number.isInteger(h) && h >= 100 ? h : null, message: firstLine(text) } };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

function subOf(f, e) {
  const key = str(e.agentId) || str(e.agentRunId) || str(e.agentName) || 'sidechain';
  let s = f.subs.get(key);
  if (!s) {
    if (f.subs.size >= MAX_SUBS) {
      let oldest = null;
      for (const [k, v] of f.subs) if (!oldest || (v.lastTs || 0) < (oldest[1].lastTs || 0)) oldest = [k, v];
      if (oldest) f.subs.delete(oldest[0]);
    }
    s = newAgentState(f.limits);
    f.subs.set(key, s);
  }
  if (str(e.agentName)) s.agentName = e.agentName;
  return s;
}

function openTurn(s, ms) {
  s.turn = { startedMs: ms, sawAssistant: false };
  s.turnEnd = null;
}

function onPrompt(s, text, ms) {
  openTurn(s, ms);
  s.apiError = null;
  s.pending.clear(); // a new prompt abandons calls left without a result
  if (!s.firstPrompt && text) s.firstPrompt = text.length > 2000 ? ownCopy(text.slice(0, 2000)) : text;
  const detail = text ? oneLine(text) : null;
  s.lastEvent = { kind: 'prompt', tool: null, detail, ms };
  pushTimeline(s, { ms, kind: 'prompt', tool: null, detail });
}

function addCall(s, fc, ms) {
  const tool = str(fc.name) || 'unknown';
  const anon = !str(fc.id);
  const id = anon ? `anon-${++s.anon}` : fc.id;
  const detail = describeArgs(tool, fc.args);
  if (!s.callIds.has(id)) {
    if (s.callIds.size >= MAX_CALL_IDS) s.callIds.clear();
    s.callIds.add(id);
    s.toolCalls++;
  }
  s.pending.set(id, { id, tool, detail, args: obj(fc.args), ms, anon });
  s.lastEvent = { kind: 'tool', tool, detail, ms };
  pushTimeline(s, { ms, kind: 'tool', tool, detail });
}

function onAssistant(s, f, e, ms) {
  if (!s.turn) openTurn(s, ms); // resumed or truncated file: no prompt seen for this turn
  s.turn.sawAssistant = true;
  s.apiError = null;
  if (str(e.model)) s.model = e.model;
  if (int(e.contextWindowSize)) s.ctxWindow = int(e.contextWindowSize);
  if (obj(e.usageMetadata)) addUsage(s, e.usageMetadata, ms, modelOf(s, f));
  const parts = partsOf(e);
  let calls = 0;
  let thought = false;
  for (const p of parts) {
    if (!p) continue;
    if (obj(p.functionCall)) { addCall(s, p.functionCall, ms); calls++; }
    else if (p.thought && typeof p.text === 'string' && p.text) thought = true;
  }
  const text = textOf(parts);
  if (text && !calls) {
    const detail = oneLine(text);
    s.lastEvent = { kind: 'text', tool: null, detail, ms };
    pushTimeline(s, { ms, kind: 'text', tool: null, detail });
  } else if (thought && !calls) {
    if (!s.lastEvent || s.lastEvent.kind !== 'thinking') pushTimeline(s, { ms, kind: 'thinking', tool: null, detail: null });
    s.lastEvent = { kind: 'thinking', tool: null, detail: null, ms };
  }
  if (calls) { s.turnEnd = null; return; }
  // Final answer: text with no function call and nothing pending ends the turn (Gemini Content carries no stop reason)
  if (text && s.pending.size === 0) {
    s.turnEnd = { kind: 'done', ms };
    s.lastDoneMs = ms;
    setResult(s, text, ms);
    pushTimeline(s, { ms, kind: 'done', tool: null, detail: null });
  }
}

function findPending(s, id, name) {
  if (id && s.pending.has(id)) return s.pending.get(id);
  let best = null;
  if (name) {
    // Same-named call: prefer calls recorded without an id, then the oldest
    for (const c of s.pending.values()) {
      if (c.tool !== name) continue;
      if (!best || (c.anon && !best.anon) || (c.anon === best.anon && c.ms < best.ms)) best = c;
    }
  }
  if (!best && !id && s.pending.size === 1) best = s.pending.values().next().value;
  return best;
}

function resultStatus(tcr, id, resp) {
  if (tcr && (!id || !str(tcr.callId) || tcr.callId === id) && str(tcr.status)) return tcr.status;
  const r = obj(resp && resp.response);
  return r && r.error != null ? 'error' : 'success';
}

function errorText(tcr, resp) {
  const t = obj(tcr);
  const e = t && t.error;
  if (e && typeof e === 'object' && str(e.message)) return firstLine(e.message);
  if (typeof e === 'string') return firstLine(e);
  if (t && typeof t.resultDisplay === 'string') return firstLine(t.resultDisplay);
  const r = obj(resp && resp.response);
  if (r) {
    if (typeof r.error === 'string') return firstLine(r.error);
    if (obj(r.error) && str(r.error.message)) return firstLine(r.error.message);
    if (typeof r.output === 'string') return firstLine(r.output);
  }
  return null;
}

function onResult(s, id, name, status, tcr, resp, ms) {
  const call = findPending(s, id, name);
  if (call) s.pending.delete(call.id);
  const tool = call ? call.tool : name || null;
  const detail = call ? call.detail : null;
  const st = String(status || 'success').toLowerCase();
  if (st === 'error') {
    pushError(s, ms, tool, errorText(tcr, resp));
  } else if (st === 'cancelled' || st === 'canceled') {
    pushTimeline(s, { ms, kind: 'interrupt', tool, detail });
    // Declined or cancelled: the scheduler stops and waits for the user
    if (s.pending.size === 0) s.turnEnd = { kind: 'interrupted', ms };
  } else {
    pushTimeline(s, { ms, kind: 'toolDone', tool, detail });
    if (call && WRITE_TOOLS.has(call.tool) && call.args) {
      const p = str(call.args.file_path) || str(call.args.absolute_path) || str(call.args.path);
      const disp = obj(tcr && tcr.resultDisplay);
      const created = call.tool === 'write_file' && disp && (disp.isNewFile === true || disp.originalContent === null);
      addFile(s, ms, p, created ? 'create' : 'edit');
    }
  }
  s.lastEvent = { kind: 'toolResult', tool, detail, ms };
}

// tool_result records (and, defensively, user records carrying functionResponse parts)
function onResponses(s, e, responses, ms) {
  const tcr = obj(e.toolCallResult);
  if (!responses.length) {
    if (tcr && str(tcr.callId)) onResult(s, tcr.callId, null, str(tcr.status), tcr, null, ms);
    return;
  }
  for (const p of responses) {
    const r = p.functionResponse;
    const id = str(r.id) || (responses.length === 1 && tcr ? str(tcr.callId) : null);
    onResult(s, id, str(r.name), resultStatus(tcr, id, r), tcr, r, ms);
  }
}

function onSystem(s, f, e, ms, isMain) {
  const p = obj(e.systemPayload) || {};
  switch (e.subtype) {
    case 'chat_compression': {
      const info = obj(p.info) || p;
      const pre = int(info.originalTokenCount);
      const post = int(info.newTokenCount);
      if (pre && post && post >= pre) return; // failed / inflated compression: nothing was compacted
      const manual = !!(s.lastSlash && COMPRESS_CMD_RE.test(s.lastSlash.command) && ms - s.lastSlash.ms <= MANUAL_COMPACT_MS);
      s.compactCount++;
      noteCompact(s.compactTimes, ms);
      s.lastCompact = { ms, trigger: manual ? 'manual' : 'auto', preTokens: pre || null, postTokens: post || null, model: modelOf(s, f) };
      if (post) s.ctxUsed = post;
      s.lastEvent = { kind: 'compact', tool: null, detail: null, ms };
      pushTimeline(s, { ms, kind: 'compact', tool: null, detail: manual ? 'manual' : 'auto' });
      return;
    }
    case 'slash_command': {
      const cmd = str(p.rawCommand) || str(p.command) || str(e.rawCommand);
      if (cmd) s.lastSlash = { ms, command: cmd.trim() };
      return;
    }
    case 'custom_title': {
      if (!isMain) return;
      const t = str(p.customTitle) || str(e.customTitle) || str(p.title);
      f.customTitle = t ? t.trim() || null : null;
      f.titleSource = str(p.titleSource) || str(e.titleSource);
      return;
    }
    case 'session_model': {
      const m = str(p.model) || str(p.modelId) || str(e.model);
      if (m) { if (isMain) f.sessionModel = m; s.model = m; }
      return;
    }
    case 'turn_result': {
      const state = str(p.state) || str(e.state);
      const err = obj(p.error) || obj(e.error);
      if (state === 'completed') {
        s.pending.clear();
        s.turnEnd = { kind: 'done', ms };
        s.lastDoneMs = ms;
      } else if (state === 'cancelled') {
        s.pending.clear();
        s.turnEnd = { kind: 'interrupted', ms };
        pushTimeline(s, { ms, kind: 'interrupt', tool: null, detail: null });
      } else if (state === 'error') {
        s.pending.clear();
        s.apiError = apiErrorOf(s, ms, err && err.message, err && err.code, err && err.code, modelOf(s, f));
        s.apiError.final = true;
        pushTimeline(s, { ms, kind: s.apiError.quota ? 'quota' : 'apiError', tool: null, detail: firstLine(err && err.message) });
      }
      return;
    }
    case 'ui_telemetry': {
      // [inferred] uiEvent carries the telemetry event name ('qwen-code.api_error' / 'qwen-code.api_response')
      const ev = obj(p.uiEvent) || p;
      const name = str(ev['event.name']) || str(ev.name) || '';
      if (/api_error$/.test(name)) {
        if (!s.turn || s.turnEnd) return; // a failed utility call after the turn ended (title, next-speaker check …) is not the turn's error
        s.apiError = apiErrorOf(s, ms, ev.error || ev.message, ev.error_type || ev.errorType, ev.status_code ?? ev.statusCode, str(ev.model) || modelOf(s, f));
        pushTimeline(s, { ms, kind: s.apiError.quota ? 'quota' : 'apiError', tool: null, detail: firstLine(String(ev.error || ev.message || '')) });
      } else if (/api_response$/.test(name)) {
        s.apiError = null;
      }
      return;
    }
    default:
      // 30+ other subtypes: tolerated and ignored
  }
}

/**
 * One chat record → file state. Tolerates unknown types / subtypes and missing fields.
 * @param {ReturnType<typeof newFileState>} f
 * @param {any} e
 */
function ingestQwen(f, e) {
  if (!obj(e)) return;
  f.lines++;
  const ts = tsOf(e.timestamp);
  if (ts != null) {
    if (f.firstTs == null || ts < f.firstTs) f.firstTs = ts;
    if (f.lastTs == null || ts > f.lastTs) f.lastTs = ts;
  }
  const side = e.isSidechain === true || (e.isSidechain == null && !!(str(e.agentId) || str(e.agentRunId)));
  if (!side) {
    if (str(e.cwd)) f.cwd = e.cwd;
    if (str(e.version)) f.version = e.version;
    if (str(e.gitBranch)) f.gitBranch = e.gitBranch;
  }
  const s = side ? subOf(f, e) : f.main;
  const ms = ts ?? s.lastTs ?? f.lastTs ?? 0;
  if (s.firstTs == null) s.firstTs = ms;
  if (s.lastTs == null || ms > s.lastTs) s.lastTs = ms;
  switch (e.type) {
    case 'user': {
      const parts = partsOf(e);
      const responses = parts.filter((p) => p && obj(p.functionResponse));
      if (responses.length) onResponses(s, e, responses, ms);
      const text = textOf(parts);
      if (!responses.length || text) onPrompt(s, text, ms);
      break;
    }
    case 'assistant':
      onAssistant(s, f, e, ms);
      break;
    case 'tool_result':
      onResponses(s, e, partsOf(e).filter((p) => p && obj(p.functionResponse)), ms);
      break;
    case 'system':
      onSystem(s, f, e, ms, !side);
      break;
    default:
  }
}

function safeIngest(f, e) {
  try { ingestQwen(f, e); } catch { /* one malformed record must not break the tail */ }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function latestPending(s) {
  let latest = null;
  for (const p of s.pending.values()) if (!latest || p.ms >= latest.ms) latest = p;
  return latest;
}

/**
 * Guess "maybe awaiting your approval" with Qwen's fast-tool list (status.js has no Qwen list: the calls are pre-filtered here,
 * then the shared helper applies the wait time).
 */
function guessQwen(pending, o) {
  const mode = o.approvalGuess || APPROVAL_GUESS.FAST_TOOLS;
  if (mode === APPROVAL_GUESS.OFF) return null;
  const all = mode === APPROVAL_GUESS.ALL_TOOLS;
  const list = pending.filter((p) => all || QWEN_FAST_SET.has(p.tool)).map((p) => ({ tool: p.tool, sinceMs: p.ms }));
  const minutes = all ? (o.staleMinutes ?? o.staleMs / 60e3) : (o.approvalGuessSeconds ?? APPROVAL_GUESS_DEFAULT_SECONDS) / 60;
  return guessAwaitingApproval({
    provider: PROVIDER, pending: list, now: o.now, mode: APPROVAL_GUESS.ALL_TOOLS, staleMinutes: minutes, hasRegistry: false,
  });
}

/**
 * Agent state → AgentStatus.
 * @param {ReturnType<typeof newAgentState>} s
 * @param {{ now: number, staleMs: number, mtimeMs?: number, isMain?: boolean, childWorking?: boolean,
 *   alive?: boolean|null, parentStoppedMs?: number|null,
 *   approvalGuess?: string, approvalGuessSeconds?: number, staleMinutes?: number }} o
 *   alive: runtime pid alive (true) / gone (false) / unknown (null)
 * @returns {import('../core/status').AgentStatus}
 */
function classifyAgent(s, o) {
  const now = o.now;
  const lastActivity = Math.max(s.lastTs || 0, o.mtimeMs || 0);
  if (s.apiError) {
    const e = s.apiError;
    if (e.quota) return makeStatus(STATUS.QUOTA, e.ms, { quota: e.quota });
    if (!e.final && o.alive !== false && now - e.ms < RETRY_GRACE_MS) {
      return makeStatus(STATUS.RETRYING, e.ms, { retry: { attempt: e.attempt, max: null, inMs: null } });
    }
    return makeStatus(STATUS.API_ERROR, e.ms, { error: e.error });
  }
  const end = s.turnEnd;
  if (end) {
    if (end.kind === 'interrupted') return makeStatus(STATUS.INTERRUPTED, end.ms);
    return makeStatus(o.isMain && o.childWorking ? STATUS.IDLE_BACKGROUND : STATUS.DONE, end.ms);
  }
  if (!s.turn) {
    // No prompt yet (only system records)
    if (o.alive === false || now - lastActivity > o.staleMs) return makeStatus(STATUS.STALE, lastActivity);
    return makeStatus(STATUS.STARTING, s.firstTs || lastActivity);
  }
  // The turn is open but the process is gone (certain, from the runtime pid)
  if (o.alive === false) return makeStatus(STATUS.KILLED, lastActivity);
  // Sub-agent whose parent turn has already ended: it will not move again
  if (o.parentStoppedMs != null) return makeStatus(STATUS.INTERRUPTED, o.parentStoppedMs);
  const pend = [...s.pending.values()];
  const hit = guessQwen(pend, o);
  if (hit) return makeStatus(STATUS.MAYBE_AWAITING_APPROVAL, hit.sinceMs, { pendingTool: hit.tool });
  const latest = latestPending(s);
  if (now - lastActivity > o.staleMs) {
    return makeStatus(STATUS.STALE, lastActivity, { stalePending: pend.length > 0, pendingTool: latest ? latest.tool : null });
  }
  if (latest) return makeStatus(STATUS.TOOL, latest.ms, { pendingTool: latest.tool });
  if (!s.turn.sawAssistant) return makeStatus(STATUS.STARTING, s.turn.startedMs);
  return makeStatus(STATUS.THINKING, (s.lastEvent && s.lastEvent.ms) || s.turn.startedMs);
}

/** Current step; null when there are no events at all. */
function stepOf(s) {
  const latest = latestPending(s);
  if (latest) return { kind: STEP.TOOL, tool: latest.tool, detail: latest.detail || null, parallel: s.pending.size, sinceMs: latest.ms };
  const ev = s.lastEvent;
  if (!ev) return null;
  const kind = ev.kind === 'toolResult' ? STEP.TOOL_RESULT
    : ev.kind === 'tool' ? STEP.TOOL
    : [STEP.THINKING, STEP.TEXT, STEP.PROMPT, STEP.COMPACT].includes(ev.kind) ? ev.kind : STEP.NONE;
  return { kind, tool: ev.tool || null, detail: ev.detail || null, parallel: 0, sinceMs: ev.ms };
}

function titleSourceOf(raw) {
  return typeof raw === 'string' && /auto|ai|generat|llm|model/i.test(raw) ? 'ai' : 'custom';
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function statChats(dir, projectDir) {
  const out = [];
  for (const d of listDirents(dir)) {
    if (!d.isFile() && !d.isSymbolicLink()) continue;
    const m = CHAT_RE.exec(d.name);
    if (!m) continue;
    const file = path.join(dir, d.name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ id: m[1], file, runtime: path.join(dir, m[1] + '.runtime.json'), projectDir, mtimeMs: st.mtimeMs, size: st.size });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Qwen Code provider. Usage (worker / terminal version):
 *   const p = new QwenProvider({ qwenHome, activeWindowMinutes, staleMinutes, limits, approvalGuess, approvalGuessSeconds });
 *   const sessions = p.scan(now);          // Session[], filtered by the activity window, sorted by updatedMs descending
 *   const d = p.details(keys);             // { [sessionKey]: SessionDetail }, only for sessions that appeared in scan
 *   const q = p.quota();                   // { lastHit }: latest quota-looking API error seen in a session (same shape as QuotaSnapshot.claude)
 */
class QwenProvider {
  /**
   * @param {{ qwenHome?: string, qwen?: { home?: string }, home?: string, activeWindowMinutes?: number, staleMinutes?: number,
   *   limits?: Partial<typeof DEFAULT_LIMITS>, approvalGuess?: 'fastTools'|'allTools'|'off', approvalGuessSeconds?: number,
   *   maxSessions?: number, readBudgetBytes?: number, hostname?: string, env?: Record<string, string|undefined> }} [opts]
   *   Home: opts.qwenHome → opts.qwen.home → opts.home → $QWEN_RUNTIME_DIR → $QWEN_HOME → ~/.qwen.
   */
  constructor(opts = {}) {
    const env = opts.env || process.env;
    this.home = [opts.qwenHome, opts.qwen && opts.qwen.home, opts.home, env.QWEN_RUNTIME_DIR, env.QWEN_HOME]
      .map((v) => expandHome(v)).find(Boolean) || path.join(os.homedir(), '.qwen');
    this.projectsDir = path.join(this.home, 'projects');
    this.windowMs = (opts.activeWindowMinutes ?? 30) * 60e3;
    this.staleMinutes = opts.staleMinutes ?? 5;
    this.staleMs = this.staleMinutes * 60e3;
    this.approvalGuess = opts.approvalGuess || APPROVAL_GUESS.FAST_TOOLS;
    this.approvalGuessSeconds = opts.approvalGuessSeconds ?? APPROVAL_GUESS_DEFAULT_SECONDS;
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    this.maxSessions = opts.maxSessions > 0 ? opts.maxSessions : MAX_SESSIONS;
    this.readBudgetBytes = opts.readBudgetBytes > 0 ? opts.readBudgetBytes : READ_BUDGET_BYTES;
    this.hostname = opts.hostname || os.hostname();
    this.files = new Map();     // session id -> { id, file, runtime, projectDir, mtimeMs, size }
    this.dirs = new Map();      // chats directory -> { dirMtime, hot, entries }
    this.tails = new Map();     // session id -> JsonlTail (only the transcripts being read)
    this.runtimes = new Map();  // session id -> { mtimeMs, data } (runtime.json cache)
    this.startedMs = new Map(); // agent key -> stable start time
    this.firstSeen = new Map(); // session id -> first-seen time
    this.built = new Map();     // sessionKey -> { id, subIds } (result of the previous scan, used by details)
    this.lastHit = null;        // latest quota hit (QuotaHit & { ms, sessionKey })
    this.lastDiscover = -Infinity;
    this.lastFullScan = -Infinity;
  }

  // ---------- Discovery ----------

  discover(now) {
    this.lastDiscover = now;
    const many = this.files.size > MANY_FILES;
    const full = !many || now - this.lastFullScan >= COLD_DIR_MS;
    if (full) this.lastFullScan = now;
    const files = new Map();
    const seen = new Set();
    for (const p of listDirents(this.projectsDir)) {
      if (!p.isDirectory()) continue;
      const projectDir = path.join(this.projectsDir, p.name);
      const chats = path.join(projectDir, 'chats');
      const dirMtime = mtimeOf(chats);
      if (!dirMtime) continue;
      seen.add(chats);
      let c = this.dirs.get(chats);
      if (!c || full || c.hot || c.dirMtime !== dirMtime) {
        const entries = statChats(chats, projectDir);
        c = { dirMtime, entries, hot: entries.some((x) => now - x.mtimeMs < this.windowMs) };
        this.dirs.set(chats, c);
      }
      for (const x of c.entries) {
        const old = files.get(x.id);
        if (!old || x.mtimeMs > old.mtimeMs) files.set(x.id, { ...x });
      }
    }
    for (const k of [...this.dirs.keys()]) if (!seen.has(k)) this.dirs.delete(k);
    // Transcripts being read: the reader's stat result wins (it is more up to date)
    for (const [id, tail] of this.tails) {
      const x = files.get(id);
      if (x && tail.mtimeMs > x.mtimeMs) x.mtimeMs = tail.mtimeMs;
    }
    this.files = files;
  }

  track(f, now) {
    let tail = this.tails.get(f.id);
    if (tail && tail.file === f.file) return tail;
    const limits = this.limits;
    tail = new JsonlTail(f.file, () => newFileState(limits, f.id), safeIngest);
    this.tails.set(f.id, tail);
    if (!this.firstSeen.has(f.id)) remember(this.firstSeen, f.id, now);
    return tail;
  }

  runtimeOf(f) {
    const mt = mtimeOf(f.runtime);
    if (!mt) { this.runtimes.delete(f.id); return null; }
    let c = this.runtimes.get(f.id);
    if (!c || c.mtimeMs !== mt) { c = { mtimeMs: mt, data: readRuntime(f.runtime) }; this.runtimes.set(f.id, c); }
    return c.data;
  }

  stableStart(key, v, now) {
    const known = this.startedMs.get(key);
    if (known != null) return known;
    return remember(this.startedMs, key, v || now);
  }

  /**
   * Scan once and return the sessions in the window.
   * @param {number} [now]
   * @param {{ keepKeys?: Iterable<string> }} [opts] keepKeys: sessions to keep even outside the activity window (e.g. the one currently selected)
   * @returns {import('../core/status').Session[]}
   */
  scan(now = Date.now(), opts = {}) {
    if (now - this.lastDiscover >= DISCOVER_MS || now < this.lastDiscover) this.discover(now);
    const keep = new Set();
    for (const k of opts.keepKeys || []) {
      const pk = parseSessionKey(k);
      if (pk && pk.provider === PROVIDER) keep.add(pk.id);
    }

    // 1. Pick the newest transcripts in the window (capped) plus the kept ones; release the other readers
    const cands = [...this.files.values()]
      .filter((f) => now - f.mtimeMs < this.windowMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, this.maxSessions);
    for (const id of keep) { const f = this.files.get(id); if (f && !cands.includes(f)) cands.push(f); }
    const want = new Set(cands.map((f) => f.id));
    for (const id of [...this.tails.keys()]) if (!want.has(id)) { this.tails.delete(id); this.runtimes.delete(id); }

    // 2. Read newest first under a byte budget; a transcript still catching up is left out of this scan (unless kept)
    let budget = this.readBudgetBytes;
    const ready = [];
    for (const f of cands) {
      const tail = this.track(f, now);
      tail.poll(budget > 0 ? budget : 0);
      budget -= tail.bytesRead;
      if (tail.mtimeMs) f.mtimeMs = tail.mtimeMs;
      if (tail.remaining() > 0 && !keep.has(f.id)) continue;
      if (!tail.state.lines) continue; // nothing written yet
      if (!(now - f.mtimeMs < this.windowMs) && !keep.has(f.id)) continue;
      ready.push(f);
    }

    // 3. Liveness from runtime.json; one process that switched sessions (/resume, /clear) keeps its pid in the old sidecar,
    //    so a pid only counts for its newest session
    const live = new Map();
    const byPid = new Map();
    for (const f of ready) {
      const rt = this.runtimeOf(f);
      const x = { rt, alive: aliveOf(rt, f.id, this.hostname), started: rt ? tsOf(rt.started_at) || 0 : 0, mtimeMs: f.mtimeMs };
      live.set(f.id, x);
      if (x.alive !== true) continue;
      const prev = byPid.get(rt.pid);
      if (!prev || x.started > prev.started || (x.started === prev.started && x.mtimeMs > prev.mtimeMs)) byPid.set(rt.pid, x);
    }
    for (const x of live.values()) if (x.alive === true && byPid.get(x.rt.pid) !== x) x.alive = false;

    // 4. Build sessions
    const out = [];
    this.built = new Map();
    for (const f of ready) {
      const session = this.buildSession(f, this.tails.get(f.id), now, live.get(f.id), keep.has(f.id));
      out.push(session);
      this.built.set(session.key, { id: f.id, subIds: session.agents.map((a) => a.id) });
      const q = session.main.status.quota;
      if (q && (!this.lastHit || session.main.status.sinceMs > this.lastHit.ms)) {
        this.lastHit = { ...q, ms: session.main.status.sinceMs, sessionKey: session.key };
      }
    }
    out.sort((a, b) => b.updatedMs - a.updatedMs || (a.key < b.key ? -1 : 1));
    return out;
  }

  classifyOpts(now, extra) {
    return {
      now, staleMs: this.staleMs, staleMinutes: this.staleMinutes,
      approvalGuess: this.approvalGuess, approvalGuessSeconds: this.approvalGuessSeconds,
      ...extra,
    };
  }

  buildAgent(id, kind, s, f, st, tail, now) {
    const u = s.usage;
    const model = modelOf(s, f);
    return {
      id,
      kind,
      name: null,
      agentType: kind === 'main' ? null : s.agentName || null,
      phase: null,
      background: false,
      model,
      status: st,
      step: stepOf(s),
      tokens: {
        display: s.ctxUsed,
        contextUsed: s.ctxUsed,
        contextWindow: s.ctxWindow,
        compactAt: null,
        toCompact: null,
        contextPct: usedPercent(s.ctxUsed, s.ctxWindow),
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
      lastCompact: s.lastCompact ? { ...s.lastCompact, contextWindow: s.ctxWindow } : null,
      cacheTtl: null,
      startedMs: this.stableStart(`${f.id}/${id}`, s.firstTs || (kind === 'main' ? this.firstSeen.get(f.id) : null), now),
      lastActivityMs: kind === 'main' ? Math.max(s.lastTs || 0, tail.mtimeMs || 0) : s.lastTs || 0,
      lastApiMs: s.lastApiMs,
      mtimeMs: tail.mtimeMs || 0,
      file: tail.file,
    };
  }

  buildSession(f, tail, now, liveInfo, kept) {
    const fst = tail.state;
    const ms = fst.main;
    const alive = liveInfo ? liveInfo.alive : null;
    const parentEnd = ms.turnEnd ? ms.turnEnd.ms : null;
    const agents = [];
    for (const [key, sub] of fst.subs) {
      if (!(now - (sub.lastTs || 0) < this.windowMs) && !kept) continue;
      const st = classifyAgent(sub, this.classifyOpts(now, {
        isMain: false, alive, parentStoppedMs: parentEnd != null && parentEnd >= (sub.lastTs || 0) ? parentEnd : null,
      }));
      agents.push(this.buildAgent(key, SUBAGENT_KIND, sub, fst, st, tail, now));
    }
    agents.sort((a, b) => (a.startedMs - b.startedMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const childWorking = agents.some((a) => isRunningCode(a.status.code) || isNeedsYouCode(a.status.code));
    const mainSt = classifyAgent(ms, this.classifyOpts(now, { isMain: true, childWorking, alive, mtimeMs: tail.mtimeMs }));
    const main = this.buildAgent(f.id, 'main', ms, fst, mainSt, tail, now);

    let title;
    let titleSource;
    if (fst.customTitle) { title = fst.customTitle; titleSource = titleSourceOf(fst.titleSource); }
    else if (ms.firstPrompt) { title = oneLine(ms.firstPrompt, 40); titleSource = 'prompt'; }
    else { title = f.id.slice(0, 8); titleSource = 'id'; }

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
    const isLive = alive === true;
    const rt = liveInfo && liveInfo.rt;
    const session = {
      key: sessionKey(PROVIDER, f.id),
      provider: PROVIDER,
      id: f.id,
      title,
      titleSource,
      cwd: fst.cwd || (rt && str(rt.work_dir)) || null,
      projectDir: f.projectDir || null,
      entry: 'cli',
      entryRaw: null,
      entrypoint: null,
      version: fst.version || (rt && str(rt.qwen_version)) || null,
      model: main.model,
      createdMs: fst.firstTs || null,
      updatedMs: tail.mtimeMs || f.mtimeMs,
      startedMs: main.startedMs,
      doneAtMs: ms.lastDoneMs,
      // live = the runtime pid is alive on this host (certain); unknown (no sidecar / other host) counts as not live
      live: isLive,
      liveStatus: isLive ? (isNeedsYouCode(mainSt.code) ? 'waiting' : isRunningCode(mainSt.code) ? 'busy' : 'idle') : null,
      waitingFor: null,
      compactCount: ms.compactCount,
      compactLoop: compactLoopOf(ms.compactTimes, main.lastActivityMs),
      contextUsed: main.tokens.contextUsed,
      modelVariant: null,
      contextWindow: main.tokens.contextWindow,
      contextWindowSource: main.tokens.contextWindow ? WINDOW_SOURCE_RECORD : null,
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
      transcript: tail.file,
      resume: [],
    };
    session.resume = resumeHints(session, { now });
    return session;
  }

  /**
   * Details: only for sessions that appeared in the previous scan. Uses in-memory state only; never re-reads files.
   * @param {string} idOrKey session id or 'qwen:<id>'
   * @returns {import('../core/status').SessionDetail|null}
   */
  detail(idOrKey) {
    const key = keyOf(idOrKey);
    const b = key && this.built.get(key);
    if (!b) return null;
    const tail = this.tails.get(b.id);
    if (!tail) return null;
    const fst = tail.state;
    const agents = {};
    const sent = this.limits.timelineSent;
    const put = (id, s) => {
      if (!s) return;
      agents[id] = {
        timeline: s.timeline.slice(-sent).map((e) => ({ ms: e.ms, kind: e.kind, tool: e.tool || null, detail: e.detail || null })),
        result: s.result ? { ...s.result } : null,
        files: [...s.files.values()].sort((a, c) => c.lastMs - a.lastMs).map((x) => ({ ...x })),
        errors: s.errors.map((e) => ({ ...e })),
      };
    };
    put(b.id, fst.main);
    for (const sid of b.subIds) put(sid, fst.subs.get(sid));
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

  /** Qwen records no rate-limit windows; only the latest quota-looking API error is reported (shape of QuotaSnapshot.claude) */
  quota() {
    return { lastHit: this.lastHit ? { ...this.lastHit } : null };
  }

  dispose() {
    this.tails.clear();
    this.files.clear();
    this.dirs.clear();
    this.runtimes.clear();
    this.built.clear();
  }
}

// 'qwen:<id>' or a bare id → session key; a key of another provider returns null
function keyOf(idOrKey) {
  if (typeof idOrKey !== 'string' || !idOrKey) return null;
  const pk = parseSessionKey(idOrKey);
  if (pk && pk.provider === PROVIDER) return sessionKey(PROVIDER, pk.id);
  if (pk) return null;
  return sessionKey(PROVIDER, idOrKey);
}

module.exports = {
  PROVIDER, SUBAGENT_KIND, WINDOW_SOURCE_RECORD, DEFAULT_LIMITS, CHAT_RE, QWEN_FAST_TOOLS,
  QwenProvider,
  // The exports below are reused by tests and other modules
  newFileState, newAgentState, ingestQwen, classifyAgent, stepOf, describeArgs, guessQwen,
  isPidAlive, readRuntime, aliveOf, sanitizeCwd,
};
