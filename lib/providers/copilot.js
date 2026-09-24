'use strict';
// GitHub Copilot Chat provider (VS Code built-in chat, including agent mode).
// Reads the chat session logs that VS Code core writes under the VS Code user dir (<User>):
//   <User>/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl   (workspace windows; 'no-workspace' is one such hash dir)
//   <User>/globalStorage/emptyWindowChatSessions/<sessionId>.jsonl  (empty windows; also <User>/profiles/<id>/globalStorage/…)
// plus the legacy whole-file <sessionId>.json format. A .jsonl file is a change log, replayed in order:
//   {kind:0,v} initial snapshot · {kind:1,k,v} set at path k · {kind:2,k,v,i?} push (truncate to i first) · {kind:3,k} delete.
// VS Code appends to the log and from time to time rewrites it as a single snapshot line. The reader continues from its byte
// offset and replays from the start when the file shrinks, is replaced, or the bytes just before the offset changed.
// VS Code flushes only on its save cycle (about every 60 s) and when a session is released, so disk state lags by up to ~1 minute.
// Produces Session v2. Read-only, no network, no UI text: only status codes, step kinds, numbers, timestamps and raw snippets
// (title, tool invocation message, result, first error line). Bounded work per scan: only recently modified files, capped in
// count and bytes. Plain Node with no vscode dependency; usable from both the worker and the terminal version.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fileURLToPath } = require('url');
const { JsonlTail } = require('../core/jsonl');
const {
  STATUS, STEP, makeStatus, isRunningCode, isNeedsYouCode, isErrorCode, sessionKey, parseSessionKey,
} = require('../core/status');
const contextLib = require('../core/context');
const { resumeHints } = require('../core/resume');

const PROVIDER = 'copilot';
const SUBAGENT_KIND = 'copilotSubagent';     // Agent.kind of a sub-agent run (tool call with toolSpecificData.kind 'subagent')
const WINDOW_SOURCE_MODEL = 'copilot-model'; // Session.contextWindowSource: maxInputTokens of the chat model metadata stored with the session
const ENTRY_VSCODE = 'vscode';

const DEFAULT_LIMITS = Object.freeze({
  timeline: 30, timelineSent: 12, resultChars: 4000, filesPerAgent: 200, errorsPerAgent: 10,
  maxSessions: 40,            // at most this many recently modified non-empty sessions are read per scan (keepKeys come on top)
  emptyPerScan: 200,          // at most this many unread files are opened and found to hold an empty chat per scan (more: next scan)
  scanBytes: 32 << 20,        // bytes read per scan across all files; a larger backlog is read over the following scans
  maxFileBytes: 128 << 20,    // session files larger than this are skipped entirely
  subagentsPerSession: 50,    // most recent sub-agent runs kept per session
});

const SESSION_FILE_RE = /^([^.\\/][^\\/]*?)\.(jsonl|json)$/i;
const DISCOVER_MS = 5000;   // re-list session files every 5 seconds
const COLD_DIR_MS = 30000;  // with many files, re-list directories with no recent file only every 30 seconds
const MANY_FILES = 500;
const MAX_REMEMBER = 5000;  // cap on remembered start / first-seen entries and learned model windows
const SIG_BYTES = 64;       // bytes before the read offset compared on each change to detect a rewritten log
const PROMPT_CHARS = 400;   // kept prefix of a request's prompt text (title / timeline)
const DETAIL_CHARS = 300;   // kept prefix of a tool invocation message

/** Change-log entry kinds */
const ENTRY = Object.freeze({ INITIAL: 0, SET: 1, PUSH: 2, DELETE: 3 });
/** request.modelState.value */
const MODEL_STATE = Object.freeze({ PENDING: 0, COMPLETE: 1, CANCELLED: 2, FAILED: 3, NEEDS_INPUT: 4 });
/** toolInvocationSerialized.isConfirmed.type */
const CONFIRM = Object.freeze({ DENIED: 0, NOT_NEEDED: 1, SETTING: 2, LM_SERVICE_PER_TOOL: 3, USER_ACTION: 4, SKIPPED: 5 });

const TOOL_KINDS = new Set(['toolInvocationSerialized', 'toolInvocation']);
const EDIT_KINDS = new Set(['textEditGroup', 'notebookEditGroup']);
const MARKDOWN_KINDS = new Set(['markdownContent', 'markdownVuln']);
// Parts that ask the user something while the request is in NeedsInput
const INPUT_KINDS = new Map([
  ['questionCarousel', 'askUser'], ['elicitationSerialized', 'askUser'], ['elicitation', 'askUser'], ['planReview', 'planApproval'],
]);
const CONFIRMATION_KINDS = new Set(['confirmation']);
const RESOLVED_STATES = new Set(['accepted', 'rejected', 'completed', 'complete', 'answered', 'dismissed', 'cancelled', 'canceled', 'used']);
const SUBAGENT_TOOL_RE = /subagent/i;
const DROP_REQUEST_FIELDS = ['variableData', 'contentReferences', 'codeCitations', 'followups', 'responseMarkdownInfo',
  'editedFileEvents', 'modelConfiguration', 'outputBuffer', 'promptTokenDetails'];
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return typeof v === 'string' && v ? v : null; }
function num(v) { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; }
function int(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; }
function tsOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v > 1e12 ? v : v * 1000;
  if (typeof v !== 'string' || !v) return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

// A prefix of at most max chars. A cut string is copied: V8 keeps the whole original alive behind a slice of it, so without
// the copy a clipped 400-char prompt would still hold a pasted 1 MB log in memory for as long as the session is tracked
function clip(t, max) {
  if (typeof t !== 'string') return null;
  return t.length > max ? ownCopy(t.slice(0, max)) : t;
}
function ownCopy(s) { return Buffer.from(s, 'utf16le').toString('utf16le'); }

// Single line, length-limited (same as oneLine in codex.js)
function oneLine(t, max = 90) {
  if (t == null) return '';
  let s = String(t);
  if (s.length > max * 8) s = s.slice(0, max * 8);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// First non-empty line, at most max chars
function firstLine(t, max = 200) {
  if (typeof t !== 'string') return null;
  for (const l of t.split('\n')) { const s = l.trim(); if (s) return oneLine(s, max); }
  return null;
}

// Text of a MarkdownString-like value: a plain string, { value } or { content: { value } }
function mdText(v) {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return null;
  if (typeof v.value === 'string') return v.value;
  if (typeof v.content === 'string') return v.content;
  if (isObj(v.content) && typeof v.content.value === 'string') return v.content.value;
  return null;
}

// URI (serialized UriComponents or string) → file system path; non-file URIs are returned raw
function uriToPath(u) {
  if (!u) return null;
  if (typeof u === 'string') {
    if (/^file:\/\//i.test(u)) { try { return fileURLToPath(u); } catch { return u; } }
    return u;
  }
  if (!isObj(u)) return null;
  if (typeof u.fsPath === 'string' && u.fsPath) return u.fsPath;
  if (typeof u.external === 'string' && u.external) return uriToPath(u.external);
  if (typeof u.path === 'string' && u.path) {
    if (u.scheme && u.scheme !== 'file') return `${u.scheme}://${u.authority || ''}${u.path}`;
    // '/c:/Users/me' → 'c:\Users\me' (as VS Code's fsPath: lower-case drive letter, backslashes); a UNC authority → '\\server\share'
    if (/^\/[a-zA-Z]:/.test(u.path)) return u.path[1].toLowerCase() + u.path.slice(2).replace(/\//g, '\\');
    if (u.authority && u.path.length > 1) return `\\\\${u.authority}${u.path.replace(/\//g, '\\')}`;
    return u.path;
  }
  return null;
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

// ---------------------------------------------------------------------------
// Slimming: the replayed tree keeps only the fields this provider reads, so a few dozen sessions stay small in memory.
// Replaced parts keep their array positions, so later set / push-with-truncate entries still land where VS Code meant them.
// ---------------------------------------------------------------------------

const SLIM = new WeakSet();
function mark(o) { SLIM.add(o); return o; }

// Shallow copy of primitive fields (strings clipped); nested objects are dropped
function primitives(src, maxStr = 200, skip = null) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (skip && skip.has(k)) continue;
    if (typeof v === 'string') out[k] = clip(v, maxStr);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}

function slimTsd(t, limits) {
  if (!isObj(t)) return t === undefined ? undefined : null;
  if (t.kind !== 'subagent') return { kind: str(t.kind) };
  const out = primitives(t, 200, new Set(['prompt', 'result']));
  if (typeof t.result === 'string') out.result = clip(t.result, limits.resultChars);
  return out;
}

function slimTool(p, limits) {
  const out = {
    kind: p.kind,
    toolId: str(p.toolId),
    toolCallId: str(p.toolCallId),
    isComplete: typeof p.isComplete === 'boolean' ? p.isComplete : undefined,
    isConfirmed: isObj(p.isConfirmed) ? { type: num(p.isConfirmed.type) } : p.isConfirmed,
    invocationMessage: clip(mdText(p.invocationMessage), DETAIL_CHARS),
    resultError: p.resultError == null ? undefined : clip(typeof p.resultError === 'string' ? p.resultError : (mdText(p.resultError) || JSON.stringify(p.resultError) || ''), 400),
    isError: isObj(p.resultDetails) && p.resultDetails.isError === true ? true : undefined,
    subAgentInvocationId: str(p.subAgentInvocationId) || undefined,
    toolSpecificData: slimTsd(p.toolSpecificData, limits),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

function slimPart(p, limits) {
  if (typeof p === 'string') return mark({ kind: 'markdownContent', value: clip(p, limits.resultChars) });
  if (!isObj(p)) return p;
  const kind = typeof p.kind === 'string' ? p.kind : null;
  if (!kind || MARKDOWN_KINDS.has(kind)) {
    const t = mdText(p);
    if (t == null && !kind) return mark({ kind: null });
    return mark({ kind: 'markdownContent', value: clip(t || '', limits.resultChars) });
  }
  if (kind === 'thinking') return mark({ kind });
  if (TOOL_KINDS.has(kind)) return mark(slimTool(p, limits));
  if (EDIT_KINDS.has(kind) || kind === 'codeblockUri') {
    return mark({ kind, uri: uriToPath(p.uri), isEdit: p.isEdit === true || undefined, done: typeof p.done === 'boolean' ? p.done : undefined });
  }
  return mark(primitives(p, 200));
}

function slimResult(res) {
  const md = isObj(res.metadata) ? res.metadata : null;
  const u = isObj(res.usage) ? res.usage : null;
  const ed = isObj(res.errorDetails) ? res.errorDetails : null;
  const out = {
    errorDetails: ed ? primitives(ed, 400) : null,
    timings: isObj(res.timings) ? primitives(res.timings) : null,
    promptTokens: num(u && u.promptTokens) ?? num(md && md.promptTokens),
    completionTokens: num(u && u.completionTokens) ?? num(md && (md.outputTokens ?? md.completionTokens)),
    rounds: md && Array.isArray(md.toolCallRounds) ? md.toolCallRounds.length : null,
  };
  return mark(out);
}

function slimRequest(r, limits) {
  for (const f of DROP_REQUEST_FIELDS) if (f in r) delete r[f];
  if (typeof r.message === 'string') r.message = mark({ text: clip(r.message, PROMPT_CHARS) });
  else if (isObj(r.message) && !SLIM.has(r.message)) r.message = mark({ text: clip(r.message.text, PROMPT_CHARS) });
  if (isObj(r.agent) && !SLIM.has(r.agent)) r.agent = mark({ id: str(r.agent.id), name: str(r.agent.name), extensionVersion: str(r.agent.extensionVersion) });
  if (isObj(r.modeInfo) && !SLIM.has(r.modeInfo)) r.modeInfo = mark(primitives(r.modeInfo, 60));
  if (isObj(r.result) && !SLIM.has(r.result)) r.result = slimResult(r.result);
  const resp = r.response;
  if (Array.isArray(resp)) {
    for (let i = 0; i < resp.length; i++) {
      const p = resp[i];
      if (p == null || (typeof p === 'object' && SLIM.has(p))) continue;
      resp[i] = slimPart(p, limits);
    }
  }
}

function slimInputState(s) {
  if (!isObj(s) || SLIM.has(s)) return s;
  const sm = isObj(s.selectedModel) ? s.selectedModel : null;
  const md = sm && isObj(sm.metadata) ? sm.metadata : null;
  return mark({
    mode: isObj(s.mode) ? primitives(s.mode, 60) : (typeof s.mode === 'string' ? s.mode : null),
    permissionLevel: str(s.permissionLevel),
    selectedModel: sm ? {
      identifier: str(sm.identifier),
      metadata: md ? {
        id: str(md.id), family: str(md.family), vendor: str(md.vendor),
        maxInputTokens: num(md.maxInputTokens), maxOutputTokens: num(md.maxOutputTokens),
        multiplierNumeric: num(md.multiplierNumeric) ?? (typeof md.multiplier === 'string' && /^\s*\d/.test(md.multiplier) ? num(parseFloat(md.multiplier)) : null),
      } : null,
    } : null,
  });
}

// Slims what the entry at path k may have touched (k = null: the whole tree)
function slimTree(root, k, limits) {
  const top = k && k.length ? k[0] : null;
  if (top === null || top === 'requests') {
    const reqs = root.requests;
    if (Array.isArray(reqs)) {
      if (top !== null && typeof k[1] === 'number') { if (isObj(reqs[k[1]])) slimRequest(reqs[k[1]], limits); }
      else for (const r of reqs) if (isObj(r)) slimRequest(r, limits);
    }
  }
  if ((top === null || top === 'inputState') && isObj(root.inputState)) {
    // A nested set (selectedModel, attachments, inputText, …) lands on the slimmed object: slim it again from a copy
    const s = root.inputState;
    root.inputState = SLIM.has(s) && k && k.length > 1 ? slimInputState({ ...s }) : slimInputState(s);
  }
  if ((top === null || top === 'pendingRequests') && Array.isArray(root.pendingRequests)) {
    const pr = root.pendingRequests;
    for (let i = 0; i < pr.length; i++) if (!(isObj(pr[i]) && SLIM.has(pr[i]))) pr[i] = mark({ kind: isObj(pr[i]) ? str(pr[i].kind) : null });
  }
  if (top === null || top === 'repoData') delete root.repoData;
}

// ---------------------------------------------------------------------------
// Change-log replay
// ---------------------------------------------------------------------------

function newReplayState() {
  return { root: null, initials: 0, ops: 0, badOps: 0, orphanOps: 0 };
}

function validKey(k) {
  return (typeof k === 'number' && Number.isInteger(k) && k >= 0) || (typeof k === 'string' && !BAD_KEYS.has(k));
}

/**
 * Applies one change-log entry. Unknown kinds and malformed paths are counted and ignored.
 * @param {ReturnType<typeof newReplayState>} st
 * @param {any} e
 * @param {typeof DEFAULT_LIMITS} [limits]
 */
function applyEntry(st, e, limits = DEFAULT_LIMITS) {
  if (!isObj(e)) return;
  const kind = e.kind;
  if (kind === ENTRY.INITIAL) {
    // A snapshot always replaces everything (also when it shows up mid-file after a rewrite)
    st.root = isObj(e.v) ? e.v : null;
    st.initials++;
    if (st.root) slimTree(st.root, null, limits);
    return;
  }
  if (kind !== ENTRY.SET && kind !== ENTRY.PUSH && kind !== ENTRY.DELETE) { st.badOps++; return; }
  if (!st.root) { st.orphanOps++; return; }
  const k = e.k;
  if (!Array.isArray(k) || !k.every(validKey)) { st.badOps++; return; }
  if (!k.length) {
    if (kind === ENTRY.SET && isObj(e.v)) { st.root = e.v; slimTree(st.root, null, limits); st.ops++; } else st.badOps++;
    return;
  }
  let o = st.root;
  for (let j = 0; j < k.length - 1; j++) {
    let next = o[k[j]];
    if (next == null || typeof next !== 'object') {
      if (kind === ENTRY.DELETE) { st.ops++; return; } // nothing to delete
      next = typeof k[j + 1] === 'number' ? [] : {};
      o[k[j]] = next;
    }
    o = next;
  }
  const last = k[k.length - 1];
  if (kind === ENTRY.SET) {
    o[last] = e.v;
  } else if (kind === ENTRY.PUSH) {
    let arr = o[last];
    if (!Array.isArray(arr)) { arr = []; o[last] = arr; }
    if (Number.isInteger(e.i) && e.i >= 0 && e.i < arr.length) arr.length = e.i;
    if (Array.isArray(e.v)) { for (const x of e.v) arr.push(x); } else if (e.v !== undefined) arr.push(e.v);
  } else if (Array.isArray(o) && typeof last === 'number') {
    if (last === o.length - 1) o.pop(); else if (last < o.length) o[last] = undefined;
  } else {
    delete o[last];
  }
  st.ops++;
  slimTree(st.root, k, limits);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function readSig(file, offset) {
  const len = Math.min(SIG_BYTES, offset);
  if (!(len > 0)) return null;
  let fd;
  try {
    const buf = Buffer.allocUnsafe(len);
    fd = fs.openSync(file, 'r');
    const got = fs.readSync(fd, buf, 0, len, offset - len);
    return got === len ? buf : null;
  } catch { return null; } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * One session file. .jsonl: incremental change-log replay (JsonlTail + rewrite detection); .json: whole-file snapshot.
 */
class SessionReader {
  /** @param {{ id: string, file: string, fmt: 'jsonl'|'json' }} f @param {typeof DEFAULT_LIMITS} limits */
  constructor(f, limits) {
    this.id = f.id;
    this.file = f.file;
    this.fmt = f.fmt;
    this.limits = limits;
    this.tail = f.fmt === 'jsonl' ? new JsonlTail(f.file, newReplayState, (st, e) => applyEntry(st, e, limits)) : null;
    this.snapState = newReplayState();
    this.sig = null;
    this.mtimeMs = 0;
    this.size = 0;
    this.ino = 0;
    this.version = 0;      // bumped whenever the replayed state changed
    this.caughtUp = false; // everything up to the end of the file has been read
    this.rewrites = 0;     // replays from the start detected via the signature check
    this.parseErrors = 0;  // .json files that failed to parse
    this.deferrals = 0;    // .json reads postponed for lack of budget (read anyway after two)
    // Cached analysis and the times derived from observing changes
    this.analysis = null;
    this.analysisVersion = -1;
    this.stateKey = null;
    this.stateSinceMs = null;
    this.partKey = null;
    this.partSinceMs = null;
  }

  get state() { return this.tail ? this.tail.state : this.snapState; }
  get root() { return this.state.root; }

  /**
   * Reads new content, at most budget bytes (a .json file is read whole or not at all; force reads it even over budget).
   * @returns {number} bytes read
   */
  poll(budget, force = false) {
    let st;
    try { st = fs.statSync(this.file); } catch { return 0; }
    const ino = st.ino || 0;
    if (this.tail) {
      const t = this.tail;
      if (st.size === this.size && st.mtimeMs === this.mtimeMs && ino === this.ino && t.offset >= st.size) return 0;
      // Rewritten in place with a size ≥ our offset: the bytes before the offset no longer match → replay from the start
      if (t.offset > 0 && st.size >= t.offset && this.sig) {
        const now = readSig(this.file, t.offset);
        if (!now || !now.equals(this.sig)) { t.reset(); this.rewrites++; }
      }
      const lines = t.lines;
      const resets = t.resets;
      t.poll(budget);
      this.sig = readSig(this.file, t.offset);
      this.mtimeMs = t.mtimeMs;
      this.size = t.size;
      this.ino = ino;
      if (t.lines !== lines || t.resets !== resets) this.version++;
      this.caughtUp = t.remaining() === 0;
      return t.bytesRead;
    }
    if (st.size === this.size && st.mtimeMs === this.mtimeMs && ino === this.ino && this.caughtUp) return 0;
    if (st.size > budget && !force && this.deferrals < 2) { this.deferrals++; this.caughtUp = false; return 0; }
    this.deferrals = 0;
    let obj = null;
    try { obj = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { obj = null; this.parseErrors++; }
    // A file that does not parse (caught mid-write) keeps the previous snapshot until it changes again
    if (isObj(obj) || !this.snapState.root) {
      const s = newReplayState();
      if (isObj(obj)) applyEntry(s, { kind: ENTRY.INITIAL, v: obj }, this.limits);
      this.snapState = s;
      this.version++;
    }
    this.mtimeMs = st.mtimeMs;
    this.size = st.size;
    this.ino = ino;
    this.caughtUp = true;
    return st.size;
  }
}

// ---------------------------------------------------------------------------
// Analysis of a replayed session (cached per reader version; independent of the current time)
// ---------------------------------------------------------------------------

function modelStateOf(r) {
  const ms = r.modelState;
  const v = typeof ms === 'number' ? ms : isObj(ms) ? ms.value : undefined;
  if (Number.isInteger(v) && v >= 0 && v <= 4) return v;
  // Logs without modelState (older VS Code): infer from the result
  if (r.isCanceled === true) return MODEL_STATE.CANCELLED;
  if (isObj(r.result)) return isObj(r.result.errorDetails) ? MODEL_STATE.FAILED : MODEL_STATE.COMPLETE;
  return MODEL_STATE.PENDING;
}

function completedAtOf(r) { return isObj(r.modelState) ? tsOf(r.modelState.completedAt) : null; }

function promptTokensOf(r) {
  const res = isObj(r.result) ? r.result : {};
  return int(r.promptTokens ?? res.promptTokens ?? (isObj(res.usage) ? res.usage.promptTokens : null) ?? (isObj(res.metadata) ? res.metadata.promptTokens : null));
}

function completionTokensOf(r) {
  const res = isObj(r.result) ? r.result : {};
  const md = isObj(res.metadata) ? res.metadata : {};
  return int(r.completionTokens ?? res.completionTokens ?? (isObj(res.usage) ? res.usage.completionTokens : null) ?? md.outputTokens ?? md.completionTokens);
}

function modelTotalsOf(r) {
  if (!Array.isArray(r.modelTotals)) return null;
  const t = { input: 0, cached: 0, output: 0 };
  for (const m of r.modelTotals) {
    if (!isObj(m)) continue;
    t.input += int(m.inputTokens); t.cached += int(m.cachedTokens); t.output += int(m.outputTokens);
  }
  return t;
}

function isToolPart(p) { return isObj(p) && TOOL_KINDS.has(p.kind); }
function isSubagentTool(p) {
  return isToolPart(p) && ((isObj(p.toolSpecificData) && p.toolSpecificData.kind === 'subagent') || SUBAGENT_TOOL_RE.test(p.toolId || ''));
}
function isMarkdownPart(p) { return isObj(p) && (p.kind === 'markdownContent' || p.kind === 'markdownVuln' || (!p.kind && mdText(p) != null)); }
function isMeaningful(p) {
  return isToolPart(p) || isMarkdownPart(p) || (isObj(p) && (p.kind === 'thinking' || INPUT_KINDS.has(p.kind) || CONFIRMATION_KINDS.has(p.kind)));
}
// Unconfirmed: isConfirmed missing / null (a confirmation is still being waited on)
function isUnconfirmed(p) { return p.isConfirmed == null; }
// Tool call still open: explicitly incomplete, or not confirmed yet (the serialized isComplete is not reliable on its own)
function toolOpen(p) { return p.isComplete === false || isUnconfirmed(p); }
function toolError(p) { return p.resultError != null || p.isError === true; }
function toolErrorText(p) { return firstLine(typeof p.resultError === 'string' ? p.resultError : '') || null; }
function toolDetail(p) { return oneLine(mdText(p.invocationMessage) || '', 200) || null; }
function interactionResolved(p) {
  return p.isUsed === true || p.resolved === true || p.isComplete === true || p.isHidden === true
    || (typeof p.state === 'string' && RESOLVED_STATES.has(p.state.toLowerCase()));
}

function newAgentLog() {
  return { toolCalls: 0, toolErrors: 0, files: new Map(), errors: [], timeline: [], lastPart: null, lastPartIdx: -1, openTools: 0 };
}

function pushTimeline(log, ev, limits) {
  const prev = log.timeline[log.timeline.length - 1];
  // Collapse runs of thinking / text into one event
  if (prev && (ev.kind === 'thinking' || ev.kind === 'text') && prev.kind === ev.kind && prev.ms === ev.ms) return;
  log.timeline.push(ev);
  if (log.timeline.length > limits.timeline) log.timeline.splice(0, log.timeline.length - limits.timeline);
}

function pushError(log, ms, tool, text, limits) {
  log.errors.push({ ms, tool: tool || null, text: text || '' });
  if (log.errors.length > limits.errorsPerAgent) log.errors.splice(0, log.errors.length - limits.errorsPerAgent);
}

function addFile(log, ms, filePath, limits) {
  if (!filePath) return;
  const f = log.files.get(filePath);
  if (f) { f.count++; f.lastMs = Math.max(f.lastMs, ms); return; }
  if (log.files.size >= limits.filesPerAgent) return;
  log.files.set(filePath, { path: filePath, op: 'edit', count: 1, lastMs: ms, movedTo: null });
}

// One response part into an agent log (main or sub-agent)
function ingestPart(log, p, idx, ms, limits) {
  if (isToolPart(p)) {
    log.toolCalls++;
    const err = toolError(p);
    if (err) { log.toolErrors++; pushError(log, ms, p.toolId, toolErrorText(p), limits); }
    pushTimeline(log, { ms, kind: err ? 'toolError' : 'tool', tool: p.toolId || null, detail: err ? toolErrorText(p) : toolDetail(p) }, limits);
  } else if (isObj(p) && EDIT_KINDS.has(p.kind)) {
    addFile(log, ms, typeof p.uri === 'string' ? p.uri : uriToPath(p.uri), limits);
  } else if (isObj(p) && p.kind === 'thinking') {
    pushTimeline(log, { ms, kind: 'thinking', tool: null, detail: null }, limits);
  } else if (isMarkdownPart(p)) {
    pushTimeline(log, { ms, kind: 'text', tool: null, detail: null }, limits);
  }
  if (isMeaningful(p)) { log.lastPart = p; log.lastPartIdx = idx; }
}

/**
 * Replayed root → everything the session / agents / detail need.
 * @param {any} root
 * @param {typeof DEFAULT_LIMITS} [limits]
 */
function analyze(root, limits = DEFAULT_LIMITS) {
  const reqs = Array.isArray(root.requests) ? root.requests.filter(isObj) : [];
  const inp = isObj(root.inputState) ? root.inputState : {};
  const sm = isObj(inp.selectedModel) ? inp.selectedModel : null;
  const smd = sm && isObj(sm.metadata) ? sm.metadata : null;
  const a = {
    n: reqs.length,
    queued: Array.isArray(root.pendingRequests) ? root.pendingRequests.length : 0,
    sessionId: str(root.sessionId),
    customTitle: str(typeof root.customTitle === 'string' ? root.customTitle.trim() : null),
    firstPrompt: null,
    createdMs: tsOf(root.creationDate),
    initialLocation: str(root.initialLocation),
    workingDirectory: uriToPath(root.workingDirectory),
    selected: sm ? { identifier: str(sm.identifier), maxInputTokens: int(smd && smd.maxInputTokens) || null, multiplier: smd ? num(smd.multiplierNumeric) : null } : null,
    mode: isObj(inp.mode) ? str(inp.mode.kind) || str(inp.mode.id) : str(inp.mode),
    permissionLevel: str(inp.permissionLevel),
    model: null,
    version: null,
    lastTs: 0,
    lastDoneMs: null,
    lastApiMs: null,
    tokens: { contextUsed: 0, output: 0, processed: 0, cached: 0, apiCalls: 0 },
    credits: null,
    main: newAgentLog(),
    result: null,
    subagents: [],
    last: null,
  };
  let creditSum = null;
  let sessionCredits = null;
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i];
    const ts = tsOf(r.timestamp) || a.createdMs || 0;
    const state = modelStateOf(r);
    const doneAt = completedAtOf(r);
    const isLast = i === reqs.length - 1;
    const text = isObj(r.message) ? r.message.text : typeof r.message === 'string' ? r.message : null;
    if (!a.firstPrompt && typeof text === 'string' && text.trim()) a.firstPrompt = text;
    if (str(r.modelId)) a.model = r.modelId;
    if (isObj(r.agent) && str(r.agent.extensionVersion)) a.version = r.agent.extensionVersion;
    a.lastTs = Math.max(a.lastTs, ts, doneAt || 0, tsOf(r.responseTimestamp) || 0);
    if (doneAt) a.lastApiMs = Math.max(a.lastApiMs || 0, doneAt);
    if (state === MODEL_STATE.COMPLETE && doneAt) a.lastDoneMs = Math.max(a.lastDoneMs || 0, doneAt);

    // Tokens: promptTokens is the prompt size of the request's last model call; completion tokens add up
    const pt = promptTokensOf(r);
    const ct = completionTokensOf(r);
    const mt = modelTotalsOf(r);
    if (pt > 0) a.tokens.contextUsed = pt;
    a.tokens.output += mt && mt.output ? mt.output : ct;
    a.tokens.processed += mt && mt.input ? mt.input : pt;
    if (mt) a.tokens.cached += mt.cached;
    const rounds = isObj(r.result) ? (num(r.result.rounds) ?? (isObj(r.result.metadata) && Array.isArray(r.result.metadata.toolCallRounds) ? r.result.metadata.toolCallRounds.length : null)) : null;
    a.tokens.apiCalls += rounds != null ? rounds : (pt || ct ? 1 : 0);
    if (num(r.copilotCredits) != null) creditSum = (creditSum || 0) + num(r.copilotCredits);
    if (num(r.sessionCopilotCredits) != null) sessionCredits = num(r.sessionCopilotCredits);

    pushTimeline(a.main, { ms: ts, kind: 'prompt', tool: null, detail: oneLine(text || '', 90) || null }, limits);

    // Sub-agent runs of this request (their nested parts carry subAgentInvocationId)
    const resp = Array.isArray(r.response) ? r.response : [];
    const subs = new Map();
    resp.forEach((p, idx) => {
      if (!isSubagentTool(p)) return;
      const tsd = isObj(p.toolSpecificData) ? p.toolSpecificData : {};
      const sub = {
        id: p.toolCallId || `${a.sessionId || 'session'}#${i}.${idx}`,
        part: p, tsd, reqIdx: i, partIdx: idx, reqTs: ts, reqState: state, reqDoneAt: doneAt, reqError: isObj(r.result) ? r.result.errorDetails || null : null,
        isLastRequest: isLast, laterMain: false, log: newAgentLog(), pendingApproval: null,
      };
      subs.set(sub.id, sub);
      for (const alt of [tsd.subAgentInvocationId, tsd.invocationId]) if (str(alt) && !subs.has(alt)) subs.set(alt, sub);
      a.subagents.push(sub);
    });
    const ownerOf = (p) => {
      if (!isObj(p) || !p.subAgentInvocationId) return null;
      const s = subs.get(p.subAgentInvocationId);
      return s && s.part !== p ? s : null;
    };
    let lastMain = null;
    let lastMainIdx = -1;
    let partCount = 0;
    resp.forEach((p, idx) => {
      if (p == null) return;
      partCount++;
      const owner = ownerOf(p);
      if (owner) { ingestPart(owner.log, p, idx, ts, limits); return; }
      ingestPart(a.main, p, idx, ts, limits);
      if (isMeaningful(p)) {
        lastMain = p; lastMainIdx = idx;
        // The main agent moved on past these sub-agent runs (parallel sub-agent calls do not count)
        if (!isSubagentTool(p)) for (const s of new Set(subs.values())) if (s.partIdx < idx) s.laterMain = true;
      }
    });

    // Terminal events
    const ed = isObj(r.result) && isObj(r.result.errorDetails) ? r.result.errorDetails : null;
    if (state === MODEL_STATE.COMPLETE) pushTimeline(a.main, { ms: doneAt || ts, kind: 'done', tool: null, detail: null }, limits);
    else if (state === MODEL_STATE.CANCELLED) pushTimeline(a.main, { ms: doneAt || ts, kind: 'interrupt', tool: null, detail: null }, limits);
    else if (state === MODEL_STATE.FAILED) {
      const q = ed && (ed.isQuotaExceeded === true || ed.isRateLimited === true);
      const msg = ed ? firstLine(typeof ed.message === 'string' ? ed.message : '') : null;
      pushTimeline(a.main, { ms: doneAt || ts, kind: q ? 'quota' : 'apiError', tool: null, detail: msg }, limits);
      pushError(a.main, doneAt || ts, null, msg || '', limits);
    }
    if (state === MODEL_STATE.COMPLETE) {
      for (let j = resp.length - 1; j >= 0; j--) {
        const p = resp[j];
        if (isMarkdownPart(p) && !ownerOf(p)) {
          const t = (mdText(p) || '').trim();
          if (t) { a.result = { text: clip(t, limits.resultChars), ms: doneAt || ts, source: 'lastText' }; break; }
        }
      }
    }

    if (isLast) {
      // What NeedsInput is waiting on: the last unresolved question / plan review / confirmation, or the last unconfirmed tool
      let pending = null;
      if (state === MODEL_STATE.NEEDS_INPUT) {
        for (let j = resp.length - 1; j >= 0 && !pending; j--) {
          const p = resp[j];
          if (!isObj(p)) continue;
          if (INPUT_KINDS.has(p.kind) && !interactionResolved(p)) pending = { code: STATUS.AWAITING_INPUT, question: INPUT_KINDS.get(p.kind), tool: null, part: p };
          else if (CONFIRMATION_KINDS.has(p.kind) && !interactionResolved(p)) pending = { code: STATUS.AWAITING_APPROVAL, question: null, tool: null, part: p };
          else if (isToolPart(p) && toolOpen(p)) pending = { code: STATUS.AWAITING_APPROVAL, question: null, tool: p.toolId || null, part: p };
        }
        if (!pending) pending = { code: STATUS.AWAITING_APPROVAL, question: null, tool: null, part: null };
        const owner = pending.part ? ownerOf(pending.part) : null;
        if (owner) owner.pendingApproval = pending;
        pending.ownerId = owner ? owner.id : null;
      }
      a.last = {
        idx: i, state, ts, doneAt, errorDetails: ed, partCount,
        lastMain, lastMainIdx, pending,
        openSub: null,
      };
    }
  }
  a.credits = sessionCredits ?? creditSum;
  if (a.last) {
    const pendingReq = a.last.state === MODEL_STATE.PENDING || a.last.state === MODEL_STATE.NEEDS_INPUT;
    for (const s of a.subagents) {
      s.open = subagentOpen(s, pendingReq && s.isLastRequest);
      if (s.open && s.isLastRequest) a.last.openSub = s;
    }
  }
  return a;
}

// Whether a sub-agent run is still going
function subagentOpen(s, reqPending) {
  const p = s.part;
  const tsd = s.tsd;
  if (tsd.isActive === true) return true;
  if (tsd.isActive === false) return false;
  if (!reqPending) return false;
  if (s.pendingApproval) return true;
  if (p.isComplete === false) return true;
  if ((typeof tsd.result === 'string' && tsd.result) || toolError(p)) return false;
  // No explicit flag: open until the main agent moves on past it
  return !s.laterMain;
}

// ---------------------------------------------------------------------------
// Status and step
// ---------------------------------------------------------------------------

function errorStatus(ed, ms, model) {
  if (ed && (ed.isQuotaExceeded === true || ed.isRateLimited === true)) {
    return makeStatus(STATUS.QUOTA, ms, {
      quota: { kind: 'unknown', model: model || null, resetsAtMs: null, resetsText: null, source: 'turnError', autoContinue: false },
    });
  }
  const code = ed && ed.code != null && ed.code !== '' ? String(ed.code) : null;
  return makeStatus(STATUS.API_ERROR, ms, {
    error: {
      kind: code || (ed && ed.responseIsFiltered === true ? 'filtered' : 'unknown'),
      http: null,
      message: ed ? firstLine(typeof ed.message === 'string' ? ed.message : '') : null,
    },
  });
}

/**
 * Main agent status from the last request.
 * @param {ReturnType<typeof analyze>} a
 * @param {{ now: number, staleMs: number, mtimeMs: number, stateSinceMs?: number|null, partSinceMs?: number|null, childWorking?: boolean }} o
 * @returns {import('../core/status').AgentStatus}
 */
function classifyMain(a, o) {
  const L = a.last;
  const lastActivity = Math.max(o.mtimeMs || 0, a.lastTs || 0);
  if (!L) {
    if (o.now - lastActivity > o.staleMs) return makeStatus(STATUS.STALE, lastActivity);
    return makeStatus(STATUS.STARTING, a.createdMs || lastActivity);
  }
  const since = o.stateSinceMs || L.doneAt || lastActivity;
  switch (L.state) {
    case MODEL_STATE.COMPLETE:
      return makeStatus(o.childWorking ? STATUS.IDLE_BACKGROUND : STATUS.DONE, L.doneAt || since);
    case MODEL_STATE.CANCELLED:
      return makeStatus(STATUS.INTERRUPTED, L.doneAt || since);
    case MODEL_STATE.FAILED:
      return errorStatus(L.errorDetails, L.doneAt || since, a.model);
    case MODEL_STATE.NEEDS_INPUT: {
      const p = L.pending || {};
      return makeStatus(p.code || STATUS.AWAITING_APPROVAL, since, { pendingTool: p.tool || null, question: p.question || null, certainty: 'certain' });
    }
    default: break;
  }
  // Pending
  const lp = L.openSub ? L.openSub.part : L.lastMain;
  const openTool = lp && isToolPart(lp) && (toolOpen(lp) || lp === (L.openSub && L.openSub.part)) ? lp : null;
  if (o.now - lastActivity > o.staleMs) {
    return makeStatus(STATUS.STALE, lastActivity, { stalePending: !!openTool, pendingTool: openTool ? openTool.toolId || null : null });
  }
  const partSince = o.partSinceMs || lastActivity;
  if (openTool) return makeStatus(STATUS.TOOL, partSince, { pendingTool: openTool.toolId || null });
  if (!lp) return makeStatus(STATUS.STARTING, L.ts || lastActivity);
  return makeStatus(STATUS.THINKING, partSince);
}

/**
 * Sub-agent status.
 * @param {any} s sub-agent run from analyze()
 * @param {{ now: number, staleMs: number, lastActivity: number, sinceMs: number }} o
 */
function classifySubagent(s, o) {
  const p = s.part;
  const endMs = s.reqDoneAt || s.reqTs || o.sinceMs;
  if (toolError(p)) {
    return makeStatus(STATUS.API_ERROR, endMs, { error: { kind: 'toolError', http: null, message: toolErrorText(p) } });
  }
  if (!s.open) {
    const unfinished = s.tsd.isActive === true || (!(typeof s.tsd.result === 'string' && s.tsd.result) && !s.laterMain);
    if (unfinished && s.reqState === MODEL_STATE.CANCELLED) return makeStatus(STATUS.INTERRUPTED, endMs);
    if (unfinished && s.reqState === MODEL_STATE.FAILED) return errorStatus(s.reqError, endMs, null);
    return makeStatus(STATUS.DONE, endMs);
  }
  if (s.pendingApproval) {
    const pa = s.pendingApproval;
    return makeStatus(pa.code, o.sinceMs, { pendingTool: pa.tool || null, question: pa.question || null, certainty: 'certain' });
  }
  const lp = s.log.lastPart;
  if (o.now - o.lastActivity > o.staleMs && s.reqState === MODEL_STATE.PENDING) {
    const open = lp && isToolPart(lp) && toolOpen(lp) ? lp : null;
    return makeStatus(STATUS.STALE, o.lastActivity, { stalePending: !!open, pendingTool: open ? open.toolId || null : null });
  }
  if (lp && isToolPart(lp) && toolOpen(lp)) return makeStatus(STATUS.TOOL, o.sinceMs, { pendingTool: lp.toolId || null });
  if (!lp && s.tsd.hasStarted === false) return makeStatus(STATUS.STARTING, s.reqTs || o.sinceMs);
  return makeStatus(STATUS.THINKING, o.sinceMs);
}

/**
 * Step from a part.
 * @returns {import('../core/status').Step|null}
 */
function stepOfPart(p, running, sinceMs, parallel = 1) {
  if (!p) return null;
  if (isToolPart(p)) {
    const open = running && toolOpen(p);
    return { kind: open ? STEP.TOOL : STEP.TOOL_RESULT, tool: p.toolId || null, detail: toolDetail(p), parallel: open ? parallel : 0, sinceMs };
  }
  if (p.kind === 'thinking') return { kind: STEP.THINKING, tool: null, detail: null, parallel: 0, sinceMs };
  if (isMarkdownPart(p)) return { kind: STEP.TEXT, tool: null, detail: null, parallel: 0, sinceMs };
  if (INPUT_KINDS.has(p.kind) || CONFIRMATION_KINDS.has(p.kind)) return { kind: STEP.TOOL, tool: p.kind, detail: null, parallel: 0, sinceMs };
  return null;
}

function mainStep(a, st, o) {
  const L = a.last;
  if (!L) return null;
  const running = L.state === MODEL_STATE.PENDING || L.state === MODEL_STATE.NEEDS_INPUT;
  const since = o.partSinceMs || o.mtimeMs || null;
  if (L.state === MODEL_STATE.NEEDS_INPUT && L.pending && L.pending.part) {
    const pp = L.pending.part;
    if (isToolPart(pp)) return { kind: STEP.TOOL, tool: pp.toolId || null, detail: toolDetail(pp), parallel: 1, sinceMs: st.sinceMs };
    return stepOfPart(pp, true, st.sinceMs);
  }
  if (running && L.openSub) {
    const sp = L.openSub.part;
    return { kind: STEP.TOOL, tool: sp.toolId || null, detail: toolDetail(sp), parallel: 1, sinceMs: since };
  }
  if (!L.lastMain) return running ? { kind: STEP.PROMPT, tool: null, detail: null, parallel: 0, sinceMs: L.ts || null } : null;
  return stepOfPart(L.lastMain, running, running ? since : (L.doneAt || since));
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Default VS Code user dirs for the terminal version (stable and Insiders; missing dirs cost one failed readdir).
 * The extension passes its own dir instead (globalStorageUri up two levels), which also covers portable / --user-data-dir.
 */
function defaultUserDirs(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.VSCODE_PORTABLE) return [path.join(env.VSCODE_PORTABLE, 'user-data', 'User')];
  let base;
  if (platform === 'darwin') base = path.join(home, 'Library', 'Application Support');
  else if (platform === 'win32') base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  else base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [path.join(base, 'Code', 'User'), path.join(base, 'Code - Insiders', 'User')];
}

// A profile folder (<User>/profiles/<id>) is mapped back to <User>: workspaceStorage lives only there. A leading ~ (~/… or
// ~\…) is the user's home dir, as the extension resolves its settings.
function normalizeUserDir(d) {
  let s = typeof d === 'string' ? d.trim() : '';
  if (!s) return null;
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));
  const p = path.resolve(s);
  const parent = path.dirname(p);
  if (path.basename(parent) === 'profiles') return path.dirname(parent);
  return p;
}

function statSessionFiles(dir) {
  const out = [];
  for (const f of listDirents(dir)) {
    if (!f.isFile() && !f.isSymbolicLink()) continue;
    const m = SESSION_FILE_RE.exec(f.name);
    if (!m) continue;
    const file = path.join(dir, f.name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ id: m[1], file, fmt: m[2].toLowerCase() === 'json' ? 'json' : 'jsonl', mtimeMs: st.mtimeMs, size: st.size });
  }
  return out;
}

// 'copilot:<id>' or a bare id → session key; a key of another provider returns null
function keyOf(idOrKey) {
  if (typeof idOrKey !== 'string' || !idOrKey) return null;
  const pk = parseSessionKey(idOrKey);
  if (pk && pk.provider === PROVIDER) return sessionKey(PROVIDER, pk.id);
  if (pk) return null;
  return sessionKey(PROVIDER, idOrKey);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Copilot Chat provider. Usage (worker / terminal version):
 *   const p = new CopilotProvider({ userDir, activeWindowMinutes, staleMinutes, limits });
 *   const sessions = p.scan(now);          // Session[], filtered by the activity window, sorted by updatedMs descending
 *   const q = p.quota();                   // { lastHit } — the latest quota / rate-limit failure seen (Copilot keeps no quota snapshot on disk)
 *   const d = p.details(keys);             // { [sessionKey]: SessionDetail }, only for sessions that appeared in scan
 */
class CopilotProvider {
  /**
   * @param {{ userDir?: string, userDirs?: string[], copilot?: { userDir?: string, userDirs?: string[] },
   *   activeWindowMinutes?: number, staleMinutes?: number, limits?: Partial<typeof DEFAULT_LIMITS>,
   *   env?: Record<string, string|undefined>, platform?: string, home?: string }} [opts]
   *   Also accepts a whole WorkerConfig (the dir is taken from opts.copilot.userDir / userDirs).
   */
  constructor(opts = {}) {
    const env = opts.env || process.env;
    const c = opts.copilot || {};
    let dirs = opts.userDirs || opts.userDir || c.userDirs || c.userDir || null;
    if (typeof dirs === 'string') dirs = [dirs];
    if (!Array.isArray(dirs) || !dirs.length) dirs = defaultUserDirs(env, opts.platform || process.platform, opts.home || os.homedir());
    this.userDirs = [...new Set(dirs.map(normalizeUserDir).filter(Boolean))];
    this.windowMs = (opts.activeWindowMinutes ?? 30) * 60e3;
    this.staleMinutes = opts.staleMinutes ?? 5;
    this.staleMs = this.staleMinutes * 60e3;
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    this.files = new Map();       // session id -> { id, file, fmt, mtimeMs, size, storage, wsDir, userDir }
    this.dirs = new Map();        // chat dir -> { scannedMs, entries, hot }
    this.readers = new Map();     // session id -> SessionReader (only recently modified / kept sessions)
    this.workspaces = new Map();  // workspace storage dir -> { mtimeMs, folder, workspaceFile }
    this.modelWindows = new Map(); // model identifier -> maxInputTokens (learned from any session's selected model)
    this.startedMs = new Map();
    this.firstSeen = new Map();
    this.built = new Map();       // sessionKey -> { id } (result of the previous scan, used by details)
    this.empty = new Map();       // session id -> { file, size, mtimeMs } of a file last seen holding an empty chat
    this.lastHit = null;
    this.stats = { files: 0, dirs: 0, tracked: 0, empty: 0, bytesRead: 0, oversized: 0, deferred: 0, rewrites: 0, badOps: 0, parseErrors: 0 };
    this.lastDiscover = -Infinity;
    this.lastFullScan = -Infinity;
  }

  // ---------- Discovery ----------

  chatDirs() {
    const out = [];
    for (const u of this.userDirs) {
      const ws = path.join(u, 'workspaceStorage');
      for (const d of listDirents(ws)) {
        if (!d.isDirectory()) continue;
        const wsDir = path.join(ws, d.name);
        out.push({ dir: path.join(wsDir, 'chatSessions'), storage: 'workspace', wsDir, userDir: u });
      }
      out.push({ dir: path.join(u, 'globalStorage', 'emptyWindowChatSessions'), storage: 'emptyWindow', wsDir: null, userDir: u });
      for (const p of listDirents(path.join(u, 'profiles'))) {
        if (!p.isDirectory()) continue;
        out.push({ dir: path.join(u, 'profiles', p.name, 'globalStorage', 'emptyWindowChatSessions'), storage: 'emptyWindow', wsDir: null, userDir: u });
      }
    }
    return out;
  }

  discover(now) {
    this.lastDiscover = now;
    const many = this.files.size > MANY_FILES;
    const full = !many || now - this.lastFullScan >= COLD_DIR_MS;
    if (full) this.lastFullScan = now;
    const files = new Map();
    const seen = new Set();
    const tracked = new Set([...this.readers.values()].map((r) => r.file));
    for (const cd of this.chatDirs()) {
      seen.add(cd.dir);
      let c = this.dirs.get(cd.dir);
      if (!c || full || c.hot) {
        const entries = statSessionFiles(cd.dir);
        c = { scannedMs: now, entries, hot: entries.some((x) => now - x.mtimeMs < this.windowMs || tracked.has(x.file)) };
        this.dirs.set(cd.dir, c);
      }
      for (const x of c.entries) {
        const f = { ...x, storage: cd.storage, wsDir: cd.wsDir, userDir: cd.userDir };
        const old = files.get(f.id);
        if (!old || f.mtimeMs > old.mtimeMs) files.set(f.id, f);
      }
    }
    for (const k of [...this.dirs.keys()]) if (!seen.has(k)) this.dirs.delete(k);
    // Forget empty chats whose file is gone, and workspaces that no longer have a chat dir
    for (const [id, e] of this.empty) { const f = files.get(id); if (!f || f.file !== e.file) this.empty.delete(id); }
    for (const k of [...this.workspaces.keys()]) if (!seen.has(path.join(k, 'chatSessions'))) this.workspaces.delete(k);
    // Sessions being read: the reader's stat result wins (it is more up to date)
    for (const [id, r] of this.readers) {
      const f = files.get(id);
      if (f && f.file === r.file && r.mtimeMs > f.mtimeMs) { f.mtimeMs = r.mtimeMs; f.size = r.size; }
    }
    this.files = files;
    this.stats.files = files.size;
    this.stats.dirs = [...this.dirs.values()].filter((d) => d.entries.length).length;
  }

  /** Whether the file is unchanged since it was last found holding an empty chat */
  knownEmpty(f) {
    const e = this.empty.get(f.id);
    return !!e && e.file === f.file && e.size === f.size && e.mtimeMs === f.mtimeMs;
  }

  workspaceInfo(wsDir) {
    if (!wsDir) return null;
    const f = path.join(wsDir, 'workspace.json');
    const mt = mtimeOf(f);
    let w = this.workspaces.get(wsDir);
    if (w && w.mtimeMs === mt) return w;
    w = { mtimeMs: mt, folder: null, workspaceFile: null };
    if (mt) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (isObj(j)) { w.folder = uriToPath(j.folder); w.workspaceFile = uriToPath(j.workspace || j.configuration); }
      } catch { /* unreadable: no folder */ }
    }
    this.workspaces.set(wsDir, w);
    return w;
  }

  // ---------- Readers ----------

  analysisOf(r) {
    if (r.analysis && r.analysisVersion === r.version) return r.analysis;
    const a = analyze(r.root, this.limits);
    r.analysis = a;
    r.analysisVersion = r.version;
    if (a.selected && a.selected.identifier && a.selected.maxInputTokens) remember(this.modelWindows, a.selected.identifier, a.selected.maxInputTokens);
    // Observed transition times (parts carry no timestamps; the file mtime of the poll that showed the change is the best bound)
    const first = r.stateKey === null;
    const L = a.last;
    const sk = L ? `${L.idx}:${L.state}` : '';
    if (sk !== r.stateKey) {
      r.stateKey = sk;
      if (!L) r.stateSinceMs = null;
      else if (L.doneAt) r.stateSinceMs = L.doneAt;
      else if (L.state === MODEL_STATE.PENDING && first) r.stateSinceMs = L.ts || r.mtimeMs;
      else r.stateSinceMs = Math.max(r.mtimeMs || 0, L.ts || 0);
    }
    const lp = L ? (L.openSub ? L.openSub.part : L.lastMain) : null;
    const pk = L ? `${L.idx}:${L.partCount}:${lp ? `${lp.kind}:${lp.toolCallId || ''}` : ''}` : '';
    if (pk !== r.partKey) { r.partKey = pk; r.partSinceMs = Math.max(r.mtimeMs || 0, (L && L.ts) || 0) || null; }
    return a;
  }

  stableStart(id, a, now) {
    const known = this.startedMs.get(id);
    if (known != null) return known;
    return remember(this.startedMs, id, a.createdMs || (a.last && a.last.ts) || this.firstSeen.get(id) || now);
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

    // 1. Pick and read the recently modified files (newest first) within the byte budget, plus kept ones. Only chats with at
    //    least one request count toward maxSessions: VS Code creates a file for every chat view it opens, and such empty
    //    files can outnumber the real sessions. A file found empty is remembered with its size / mtime and skipped without
    //    being opened until it changes; at most emptyPerScan files per scan are found empty (further unread files wait for
    //    the next scan), so the work per scan stays bounded.
    const cands = [];
    for (const f of this.files.values()) {
      if (!(now - f.mtimeMs < this.windowMs || keep.has(f.id))) continue;
      if (this.knownEmpty(f)) continue;
      cands.push(f);
    }
    cands.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
    const chosen = [];
    let n = 0;
    let probes = 0;
    let budget = this.limits.scanBytes;
    let oversized = 0;
    let deferred = 0;
    for (const f of cands) {
      const kept = keep.has(f.id);
      if (!kept && n >= this.limits.maxSessions) continue;
      if (f.size > this.limits.maxFileBytes) { this.readers.delete(f.id); oversized++; continue; }
      let r = this.readers.get(f.id);
      if (r && (r.file !== f.file || r.fmt !== f.fmt)) r = null;
      if (!r) {
        if (!kept && probes >= this.limits.emptyPerScan) continue;
        r = new SessionReader(f, this.limits);
        this.readers.set(f.id, r);
      }
      const got = r.poll(Math.max(0, budget), budget === this.limits.scanBytes);
      budget -= got;
      this.stats.bytesRead += got;
      if (r.mtimeMs) { f.mtimeMs = r.mtimeMs; f.size = r.size; }
      if (r.caughtUp && (!r.root || !this.analysisOf(r).n)) {
        // Empty chat (or nothing replayable): remember it and release the reader
        remember(this.empty, f.id, { file: f.file, size: r.size, mtimeMs: r.mtimeMs });
        this.readers.delete(f.id);
        probes++;
        continue;
      }
      this.empty.delete(f.id);
      if (!this.firstSeen.has(f.id)) remember(this.firstSeen, f.id, now);
      if (!r.caughtUp) deferred++;
      chosen.push(f);
      if (!kept) n++;
    }
    const chosenIds = new Set(chosen.map((f) => f.id));
    for (const id of [...this.readers.keys()]) if (!chosenIds.has(id)) this.readers.delete(id);
    this.stats.tracked = this.readers.size;
    this.stats.empty = this.empty.size;
    this.stats.oversized = oversized;
    this.stats.deferred = deferred;

    // 3. Build sessions (only readers that are caught up; a backlog shows up once it has been read)
    const out = [];
    this.built = new Map();
    let rewrites = 0;
    let badOps = 0;
    let parseErrors = 0;
    // Analyze first, so model windows learned from any session apply to all of them in this scan
    const ready = [];
    for (const f of chosen) {
      const r = this.readers.get(f.id);
      if (!r) continue;
      rewrites += r.rewrites;
      badOps += r.state.badOps + r.state.orphanOps;
      parseErrors += r.parseErrors;
      if (!r.caughtUp || !r.root) continue;
      ready.push([f, r, this.analysisOf(r)]);
    }
    for (const [f, r, a] of ready) {
      if (!a.n) continue; // empty chat: nothing asked yet (not reached: such files are released in step 1)
      const session = this.buildSession(f, r, a, now, keep);
      if (!session) continue;
      out.push(session);
      this.built.set(session.key, { id: f.id });
      if (session.main.status.code === STATUS.QUOTA && (!this.lastHit || session.main.status.sinceMs > this.lastHit.ms)) {
        this.lastHit = { ...session.main.status.quota, ms: session.main.status.sinceMs, sessionKey: session.key };
      }
    }
    this.stats.rewrites = rewrites;
    this.stats.badOps = badOps;
    this.stats.parseErrors = parseErrors;
    out.sort((a, b) => b.updatedMs - a.updatedMs || (a.key < b.key ? -1 : 1));
    return out;
  }

  contextWindowOf(a) {
    const model = a.model;
    if (a.selected && a.selected.maxInputTokens && a.selected.identifier && (!model || a.selected.identifier === model)) return a.selected.maxInputTokens;
    if (model && this.modelWindows.has(model)) return this.modelWindows.get(model);
    return null;
  }

  buildAgentBase(id, kind, r, now) {
    return {
      id, kind, name: null, agentType: null, phase: null, background: false, model: null,
      status: null, step: null,
      // Copilot records no token counts for sub-agents: unknown (the main agent's are filled in by buildSession)
      tokens: { display: 0, contextUsed: 0, contextWindow: null, compactAt: null, toCompact: null, contextPct: null, output: 0, processed: 0, apiCalls: 0, unknown: true },
      toolCalls: 0, toolErrors: 0, filesChanged: 0,
      costUsd: null, costEstimated: false, unpricedModel: null,
      lastCompact: null, cacheTtl: null,
      startedMs: now, lastActivityMs: r.mtimeMs || 0, lastApiMs: null, mtimeMs: r.mtimeMs || 0,
      file: r.file,
    };
  }

  buildSession(f, r, a, now, keep) {
    const id = f.id;
    const lastActivity = Math.max(r.mtimeMs || 0, a.lastTs || 0);
    const updatedMs = lastActivity;
    if (!(now - updatedMs < this.windowMs) && !keep.has(id)) return null;
    const L = a.last;

    // Sub-agents: those still running, plus the most recent ones inside the activity window
    const agents = [];
    const staleMs = this.staleMs;
    const subs = a.subagents.filter((s) => s.open || keep.has(id) || now - (s.reqDoneAt || s.reqTs || 0) < this.windowMs)
      .slice(-this.limits.subagentsPerSession);
    for (const s of subs) {
      const st = classifySubagent(s, { now, staleMs, lastActivity, sinceMs: r.partSinceMs || lastActivity });
      const lp = s.log.lastPart;
      const ag = this.buildAgentBase(s.id, SUBAGENT_KIND, r, now);
      ag.name = str(s.tsd.agentDisplayName) || str(s.tsd.agentName) || null;
      ag.agentType = str(s.tsd.agentName) || str(s.part.toolId) || null;
      ag.model = str(s.tsd.modelName) || str(s.tsd.model) || null;
      ag.status = st;
      ag.step = st.pendingTool && isNeedsYouCode(st.code) && s.pendingApproval && s.pendingApproval.part
        ? stepOfPart(s.pendingApproval.part, true, st.sinceMs)
        : stepOfPart(lp, s.open, r.partSinceMs || lastActivity);
      ag.toolCalls = s.log.toolCalls;
      ag.toolErrors = s.log.toolErrors;
      ag.filesChanged = s.log.files.size;
      ag.startedMs = s.reqTs || this.stableStart(id, a, now);
      ag.lastActivityMs = s.open ? lastActivity : (s.reqDoneAt || s.reqTs || lastActivity);
      ag.description = str(s.tsd.description) ? oneLine(s.tsd.description, 200) : null;
      Object.defineProperty(ag, '_order', { value: s.reqIdx * 1e6 + s.partIdx, enumerable: false });
      agents.push(ag);
    }
    agents.sort((x, y) => (x.startedMs - y.startedMs) || (x._order - y._order));
    const childWorking = agents.some((x) => isRunningCode(x.status.code) || isNeedsYouCode(x.status.code));

    const mainSt = classifyMain(a, { now, staleMs, mtimeMs: r.mtimeMs, stateSinceMs: r.stateSinceMs, partSinceMs: r.partSinceMs, childWorking });
    const main = this.buildAgentBase(id, 'main', r, now);
    const window = this.contextWindowOf(a);
    const used = a.tokens.contextUsed;
    main.model = a.model;
    main.status = mainSt;
    main.step = mainStep(a, mainSt, { mtimeMs: r.mtimeMs, partSinceMs: r.partSinceMs });
    main.tokens = {
      display: used, contextUsed: used, contextWindow: window, compactAt: null, toCompact: null,
      // No prompt token count recorded (older VS Code, or nothing answered yet): unknown, not 0 %
      contextPct: used > 0 ? contextLib.usedPercent(used, window) : null,
      output: a.tokens.output, processed: a.tokens.processed, apiCalls: a.tokens.apiCalls,
    };
    if (!(used > 0 || a.tokens.processed > 0 || a.tokens.output > 0)) main.tokens.unknown = true;
    main.toolCalls = a.main.toolCalls;
    main.toolErrors = a.main.toolErrors;
    main.filesChanged = a.main.files.size;
    main.startedMs = this.stableStart(id, a, now);
    main.lastActivityMs = lastActivity;
    main.lastApiMs = a.lastApiMs;
    main.copilotCredits = a.credits;

    let title;
    let titleSource;
    if (a.customTitle) { title = a.customTitle; titleSource = 'custom'; }
    else if (a.firstPrompt) { title = oneLine(a.firstPrompt, 40); titleSource = 'prompt'; }
    else { title = id.slice(0, 8); titleSource = 'id'; }

    const all = [main, ...agents];
    const counts = { running: 0, awaiting: 0, error: 0, done: 0, total: all.length };
    for (const x of all) {
      const c = x.status.code;
      if (isRunningCode(c)) counts.running++;
      else if (isNeedsYouCode(c)) counts.awaiting++;
      else if (isErrorCode(c)) counts.error++;
      else if (c === STATUS.DONE) counts.done++;
    }
    const code = mainSt.code;
    const waiting = code === STATUS.AWAITING_APPROVAL || code === STATUS.AWAITING_INPUT;
    const live = waiting || (L && L.state === MODEL_STATE.PENDING && code !== STATUS.STALE) || false;
    const ws = f.storage === 'workspace' ? this.workspaceInfo(f.wsDir) : null;
    const session = {
      key: sessionKey(PROVIDER, id),
      provider: PROVIDER,
      id,
      title,
      titleSource,
      cwd: a.workingDirectory || (ws && ws.folder) || null,
      projectDir: null,
      entry: ENTRY_VSCODE,
      entryRaw: a.initialLocation,
      entrypoint: null,
      version: a.version,
      model: main.model,
      createdMs: a.createdMs,
      updatedMs,
      startedMs: main.startedMs,
      doneAtMs: a.lastDoneMs,
      // No process registry: "live" = the last request is running (and not stale) or waiting on you
      live: !!live,
      liveStatus: waiting ? 'waiting' : live ? 'busy' : null,
      waitingFor: null,
      compactCount: 0,
      compactLoop: false,
      contextUsed: used,
      modelVariant: null,
      contextWindow: window,
      contextWindowSource: window ? WINDOW_SOURCE_MODEL : null,
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
      // Copilot bills by credits / premium requests, not tokens: no equivalent USD estimate here
      costUsd: null,
      unpricedModel: null,
      ccCostUsd: null,
      transcript: r.file,
      resume: [],
      // Copilot-only raw fields
      copilot: {
        credits: a.credits,
        multiplier: a.selected && a.selected.identifier === a.model ? a.selected.multiplier : null,
        cachedTokens: a.tokens.cached,
        requests: a.n,
        queued: a.queued,
        modelState: L ? L.state : null,
        mode: a.mode,
        permissionLevel: a.permissionLevel,
        storage: f.storage,
        workspaceFile: ws ? ws.workspaceFile : null,
      },
    };
    session.resume = resumeHints(session, { now });
    return session;
  }

  /**
   * Details: only for sessions that appeared in the previous scan. Uses in-memory state only; never re-reads files.
   * @param {string} idOrKey session id or 'copilot:<id>'
   * @returns {import('../core/status').SessionDetail|null}
   */
  detail(idOrKey) {
    const key = keyOf(idOrKey);
    const b = key && this.built.get(key);
    if (!b) return null;
    const r = this.readers.get(b.id);
    const a = r && r.analysis;
    if (!a) return null;
    const sent = this.limits.timelineSent;
    const pack = (log, result) => ({
      timeline: log.timeline.slice(-sent).map((e) => ({ ms: e.ms, kind: e.kind, tool: e.tool || null, detail: e.detail || null })),
      result: result ? { ...result } : null,
      files: [...log.files.values()].sort((x, y) => y.lastMs - x.lastMs).map((x) => ({ ...x })),
      errors: log.errors.map((e) => ({ ...e })),
    });
    const agents = { [b.id]: pack(a.main, a.result) };
    for (const s of a.subagents.slice(-this.limits.subagentsPerSession)) {
      const res = typeof s.tsd.result === 'string' && s.tsd.result.trim()
        ? { text: clip(s.tsd.result.trim(), this.limits.resultChars), ms: s.reqDoneAt || s.reqTs, source: 'lastText' }
        : null;
      agents[s.id] = pack(s.log, res);
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

  /** Copilot keeps no quota snapshot on disk: only the latest quota / rate-limit failure seen in a scan */
  quota() {
    return { lastHit: this.lastHit ? { ...this.lastHit } : null };
  }

  dispose() {
    this.readers.clear();
    this.files.clear();
    this.dirs.clear();
    this.built.clear();
    this.workspaces.clear();
    this.empty.clear();
  }
}

module.exports = {
  PROVIDER, SUBAGENT_KIND, WINDOW_SOURCE_MODEL, DEFAULT_LIMITS, SESSION_FILE_RE, ENTRY, MODEL_STATE, CONFIRM,
  CopilotProvider,
  // The exports below are reused by tests and other modules
  SessionReader, newReplayState, applyEntry, analyze, classifyMain, classifySubagent, mainStep, stepOfPart, modelStateOf,
  defaultUserDirs, normalizeUserDir, uriToPath, keyOf, oneLine,
};
