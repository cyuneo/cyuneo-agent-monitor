'use strict';
// Auto-resume in the original window (0.11.0, docs/DESIGN.md §12.8), the pure half. When the stopped chat is still open
// in a live Claude Code process (typically the VS Code Claude panel), `claude --bg --resume` cannot take the session and
// starts a copy. Instead the chat itself is sent a message through Claude Code's own cross-session messaging: a small
// helper run (`claude -p`, haiku) calls ListAgents and SendMessage to the chat's registry name. This module decides
// (whom to send to, what to send, what the helper answered, whether the message landed where it should); lib/inwindow.js
// reads the files and runs the helper. No vscode, no fs, no clock: everything comes in as arguments.
//
// Targeting (all checked right before each send; any failure → nothing is sent):
//   a. exactly one live registry entry (<claudeHome>/sessions/<pid>.json) whose sessionId is the chat's;
//   b. its pid is alive and, on Linux, /proc/<pid>/stat starttime equals its procStart (pid reuse guard); elsewhere the
//      entry's statusUpdatedAt / updatedAt must be fresh (not older than the stop, minus a little slack);
//   c. its status is idle (busy / waiting: never interrupted; the caller retries later, bounded);
//   d. it has a plain name, and no other registry entry of a live process carries the same name;
//   e. (helper) ListAgents shows exactly one row with that bare name;
//   f. (after SENT) the registry still names the same file, name and nameSince, and the chat's own transcript holds the
//      exact marker line; the marker anywhere else → misdelivered.
// Only <digits>.json files are ever looked at; the *.key files next to them and ~/.claude/daemon are never opened.

const { isUuid } = require('./status');

const MARKER_TAG = 'Agent Monitor 续跑';
const NONCE_RE = /^[0-9a-f]{16,64}$/;
// A registry name the helper can be told safely: letters, digits, '_', '.', '-' (no spaces, quotes or brackets)
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,63}$/u;
const ACCOUNT_RE = /^#\d{1,4}$/;
const REGISTRY_FILE_RE = /^\d{1,10}\.json$/;
const FRESH_SLACK_MS = 10 * 60e3;   // non-Linux: the entry must have been updated at most this long before the stop
const FRESH_MAX_MS = 24 * 3600e3;   // … and within this long of now
// The permission modes `claude --permission-mode` accepts (Claude Code 2.1.318 --help); transcripts may still say 'default'
const PERMISSION_MODES = Object.freeze(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
const MODE_ALIASES = Object.freeze({ default: 'manual' });
const HELPER_MODEL = 'haiku';
const HELPER_EFFORT = 'low';
const HELPER_MAX_TURNS = 4;          // ListAgents + SendMessage + the answer, one turn to spare
// Only these two tools (`claude --tools <tools...>`: "Bash,Edit,Read" form, Claude Code 2.1.318 --help); no hooks, no ultracode
const HELPER_TOOLS = 'ListAgents,SendMessage';
const HELPER_SETTINGS = '{"disableAllHooks":true,"ultracode":false}';
// Tool search off for the helper: with it on (the default on the first-party API) SendMessage is a deferred tool that
// only ToolSearch can load, and ToolSearch is not among the helper's tools, so the helper could never send
const HELPER_ENV = Object.freeze({ ENABLE_TOOL_SEARCH: 'false' });
const NOTICE_RE = /\[\s*Cross-session delivery notice\s*\]|\bheld\b|\brefused\b|\bawaiting (?:the )?(?:user'?s? )?approval\b|\bnot delivered\b/i;
const PROMPT_LINE_MAX = 1000;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;
const BIDI_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const XMSG_OPEN_RE = /^\s*<cross-session-message\b[^>]*>/;
const XMSG_CLOSE_RE = /<\/cross-session-message>\s*$/;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' && v ? v : null);

/** A Unix timestamp in ms (seconds are converted), else null */
function ms(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

/** 16 random bytes as 32 lowercase hex characters (randomBytes: crypto.randomBytes or a test fake) */
function makeNonce(randomBytes) {
  const b = randomBytes(16);
  const hex = Buffer.from(b).toString('hex').toLowerCase();
  if (!NONCE_RE.test(hex)) throw new Error('bad nonce');
  return hex;
}

/** `[Agent Monitor 续跑 <nonce>]`; null for a nonce that is not 16–64 lowercase hex characters */
function markerOf(nonce) {
  return typeof nonce === 'string' && NONCE_RE.test(nonce) ? `[${MARKER_TAG} ${nonce}]` : null;
}

/** One line: controls and bidi marks out, whitespace collapsed, capped */
function oneLine(text, max = PROMPT_LINE_MAX) {
  const s = String(text == null ? '' : text).replace(BIDI_RE, '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  const a = Array.from(s);
  return a.length > max ? a.slice(0, max).join('').trim() : s;
}

/**
 * The message for the chat: a self-contained Chinese first line with the marker, then the user's resume prompt (one line,
 * when there is one). Never a token, an email or a path: the account is only cswap's '#N'.
 * @param {{ nonce: string, trigger?: 'limit'|'error'|string|null, account?: string|null, prompt?: string|null }} o
 * @returns {{ text: string, firstLine: string, marker: string }|null}
 */
function buildMessage(o = {}) {
  const marker = markerOf(o.nonce);
  if (!marker) return null;
  const account = typeof o.account === 'string' && ACCOUNT_RE.test(o.account) ? o.account : null;
  let line;
  if (o.trigger === 'limit') line = `额度已恢复${account ? `（已切换到 ${account}）` : ''}，请继续刚才因额度用完而中断的任务。`;
  else if (o.trigger === 'error') line = '之前的 API 错误已经过去，请继续刚才因出错而中断的任务。';
  else line = '请继续刚才中断的任务。';
  const firstLine = `${marker} ${line}`;
  const prompt = oneLine(o.prompt).replace(/^[-\s]+/, '');
  return { text: prompt ? `${firstLine}\n${prompt}` : firstLine, firstLine, marker };
}

// ---------------------------------------------------------------------------
// Targeting (registry)
// ---------------------------------------------------------------------------

/** A registry file name the in-window path may open: <pid>.json only (never *.key, sockets or anything else) */
function isRegistryFile(name) {
  return typeof name === 'string' && REGISTRY_FILE_RE.test(name);
}

/**
 * One parsed registry file → the fields used here, or null (not an object, no session id or pid).
 * @param {string} file
 * @param {any} j
 */
function registryEntry(file, j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const sessionId = str(j.sessionId);
  let pid = Number(j.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    const m = /(\d+)\.json$/.exec(String(file || ''));
    pid = m ? Number(m[1]) : NaN;
  }
  if (!sessionId || !Number.isInteger(pid) || pid <= 0) return null;
  return {
    file: String(file || ''),
    pid,
    sessionId,
    name: typeof j.name === 'string' ? j.name : null,
    nameSince: j.nameSince == null ? null : String(j.nameSince),
    procStart: j.procStart == null || j.procStart === '' ? null : String(j.procStart),
    pidDomain: str(j.pidDomain),
    status: str(j.status),
    kind: str(j.kind),
    entrypoint: str(j.entrypoint),
    cwd: str(j.cwd),
    statusUpdatedAt: ms(j.statusUpdatedAt),
    updatedAt: ms(j.updatedAt),
  };
}

/**
 * Whether a registry entry belongs to a process running now, from facts the caller gathered:
 *   alive: process.kill(pid, 0) succeeded (or EPERM); procStartNow: /proc/<pid>/stat starttime (Linux; null unknown);
 *   pidNs: this process's pid namespace ('pid:[…]', Linux; null unknown).
 * @returns {'live'|'dead'|'unguarded'|'stale'} unguarded: Linux without a procStart to compare (alive, but the pid may
 *   have been reused); stale: not Linux and the entry was not updated recently enough
 */
function liveness(e, f = {}, o = {}) {
  if (!e || !f || f.alive !== true) return 'dead';
  if (o.platform === 'linux') {
    if (e.pidDomain && o.pidNs && /^linux:/.test(e.pidDomain) && !e.pidDomain.endsWith(`:${o.pidNs}`)) return 'dead'; // another pid namespace
    if (!e.procStart || f.procStartNow == null) return 'unguarded';
    return String(f.procStartNow) === e.procStart ? 'live' : 'dead'; // pid reuse: another program has that pid now
  }
  const upd = Math.max(e.statusUpdatedAt || 0, e.updatedAt || 0);
  if (!upd) return 'stale';
  if (fin(o.now) && o.now - upd > FRESH_MAX_MS) return 'stale';
  if (fin(o.stopSinceMs) && upd < o.stopSinceMs - FRESH_SLACK_MS) return 'stale';
  return 'live';
}

/**
 * Whom to send to (rules a–d). entries: [{ entry: registryEntry(…), facts: { alive, procStartNow } }].
 * @param {any[]} entries
 * @param {string} sessionId
 * @param {{ platform: string, now?: number, stopSinceMs?: number|null, pidNs?: string|null }} o
 * @returns {{ ok: true, target: any } | { ok: false, reason: 'notOpen'|'ambiguous'|'unguarded'|'stale'|'busy'|'unknownStatus'|'noName'|'badName'|'dupName', open: boolean }}
 *   open: whether the chat may well be open in some process (the fallback chain applies), false: open nowhere
 */
function pickTarget(entries, sessionId, o = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((x) => x && x.entry);
  const judged = list.map((x) => ({ e: x.entry, live: liveness(x.entry, x.facts, o) }));
  const mine = judged.filter((x) => x.e.sessionId === sessionId && x.live !== 'dead');
  const no = (reason, open = true) => ({ ok: false, reason, open });
  if (!isUuid(sessionId) || mine.length === 0) return no('notOpen', false);
  if (mine.length > 1) return no('ambiguous');
  const t = mine[0];
  if (t.live === 'unguarded') return no('unguarded');
  if (t.live === 'stale') return no('stale');
  if (t.e.status === 'busy' || t.e.status === 'waiting') return no('busy');
  if (t.e.status !== 'idle') return no('unknownStatus');
  const name = t.e.name;
  if (typeof name !== 'string' || !name.trim()) return no('noName');
  if (!NAME_RE.test(name)) return no('badName');
  // Any other entry whose process may be running (alive, not shown to be a reused pid) and that has the same name
  const clash = judged.some((x) => x.e !== t.e && x.live !== 'dead' && typeof x.e.name === 'string' && x.e.name === name);
  if (clash) return no('dupName');
  return { ok: true, target: { ...t.e } };
}

/**
 * After SENT (rule f, registry half): the same file still names the same session, pid, name and nameSince.
 * @param {any} before pickTarget's target
 * @param {any|null} after registryEntry of the same file, read again (null: gone or unreadable)
 */
function sameTarget(before, after) {
  if (!before || !after) return false;
  return after.file === before.file && after.sessionId === before.sessionId && after.pid === before.pid
    && after.name === before.name && after.nameSince === before.nameSince;
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

/** The text of a transcript entry's message (a string, or the text blocks of a content array) */
function textOf(entry) {
  const m = entry && entry.message;
  const c = m && typeof m === 'object' ? m.content : typeof m === 'string' ? m : null;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}

/** A user entry someone (a person or another session) typed: not meta, not only tool results */
function isUserPrompt(entry) {
  if (!entry || entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) return false;
  const m = entry.message;
  const c = m && typeof m === 'object' ? m.content : null;
  if (Array.isArray(c)) return c.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim());
  return typeof c === 'string' ? !!c.trim() : false;
}

/** Whether a text has a line that is exactly firstLine (a <cross-session-message …> wrapper around it is allowed) */
function hasMarkerLine(text, firstLine) {
  if (typeof text !== 'string' || typeof firstLine !== 'string' || !firstLine) return false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(XMSG_OPEN_RE, '').replace(XMSG_CLOSE_RE, '').trim();
    if (line === firstLine) return true;
  }
  return false;
}

/**
 * Whether jsonl text (a transcript or its tail) has a user entry whose message holds the exact marker line. Only lines
 * that contain the nonce are parsed; a partial first line (a tail read) is skipped.
 * @param {string} text
 * @param {{ firstLine: string, marker: string }} msg buildMessage's result
 */
function transcriptHasMarker(text, msg) {
  if (typeof text !== 'string' || !msg || !msg.marker || !msg.firstLine) return false;
  const nonce = msg.marker.slice(MARKER_TAG.length + 2, -1);
  if (!NONCE_RE.test(nonce) || !text.includes(nonce)) return false;
  for (const line of text.split('\n')) {
    if (!line.includes(nonce)) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e && e.type === 'user' && hasMarkerLine(textOf(e), msg.firstLine)) return true;
  }
  return false;
}

/**
 * Whether jsonl text appended to a transcript holds a new user prompt (fallback ii: the user pressed Enter on the
 * prefilled text, or typed something else). Partial lines are skipped.
 * @param {string} text
 * @param {number|null} [sinceMs] only entries with a timestamp at or after this (entries without one count)
 */
function hasNewUserPrompt(text, sinceMs) {
  if (typeof text !== 'string' || !text) return false;
  for (const line of text.split('\n')) {
    if (!line.includes('"user"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!isUserPrompt(e)) continue;
    const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (fin(sinceMs) && Number.isFinite(at) && at < sinceMs) continue;
    return true;
  }
  return false;
}

/**
 * The chat's permission mode for the helper: the latest entry with a permissionMode, mapped to what
 * `claude --permission-mode` accepts ('default' → 'manual'); unknown or missing → 'auto'.
 * @param {string} text the transcript (or its tail)
 */
function permissionModeOf(text) {
  if (typeof text === 'string' && text) {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"permissionMode"')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const m = e && typeof e.permissionMode === 'string' ? e.permissionMode : null;
      if (!m) continue;
      const mode = Object.prototype.hasOwnProperty.call(MODE_ALIASES, m) ? MODE_ALIASES[m] : m;
      return PERMISSION_MODES.includes(mode) ? mode : 'auto';
    }
  }
  return 'auto';
}

// ---------------------------------------------------------------------------
// The helper run
// ---------------------------------------------------------------------------

/** What the helper is told: list, check the name is unique, send the exact text, answer SENT / FAIL / NOTARGET / NOTOOLS */
function helperPrompt(name, text) {
  return [
    'You are a one-shot message relay. Follow these steps exactly and do nothing else.',
    '1. If the ListAgents tool or the SendMessage tool is not available to you, answer NOTOOLS and stop.',
    '2. Call ListAgents once, with no arguments.',
    `3. Count the rows whose bare name (the text before " [") is exactly "${name}". If that count is not exactly 1, send nothing and answer NOTARGET.`,
    `4. Otherwise call SendMessage once with to = "${name}" and message = the text between the lines BEGIN-MESSAGE and END-MESSAGE below, unchanged (without those two lines).`,
    '5. If SendMessage reports an error, or a "[Cross-session delivery notice]" arrives, or the message was held for approval or refused, answer FAIL. Otherwise answer SENT.',
    'Your whole answer is one word: SENT, FAIL, NOTARGET or NOTOOLS.',
    'BEGIN-MESSAGE',
    text,
    'END-MESSAGE',
  ].join('\n');
}

/**
 * argv for the helper (spawned without a shell): haiku, low effort, only ListAgents / SendMessage available and allowed,
 * hooks and ultracode off, no session file kept. The variadic --tools / --allowedTools come first so the prompt
 * (always the last argument, right after the single-valued --output-format) is never taken for a tool name.
 * @param {{ name: string, text: string, permissionMode?: string }} o
 * @returns {string[]|null} null when the name is not one the helper can be told
 */
function helperArgs(o = {}) {
  if (typeof o.name !== 'string' || !NAME_RE.test(o.name) || typeof o.text !== 'string' || !o.text) return null;
  const mode = PERMISSION_MODES.includes(o.permissionMode) ? o.permissionMode : 'auto';
  const args = ['-p', '--tools', HELPER_TOOLS, '--allowedTools', HELPER_TOOLS];
  args.push(
    '--model', HELPER_MODEL, '--effort', HELPER_EFFORT, '--permission-mode', mode, '--no-session-persistence',
    '--settings', HELPER_SETTINGS, '--max-turns', String(HELPER_MAX_TURNS), '--output-format', 'json',
    helperPrompt(o.name, o.text),
  );
  return args;
}

/** The last JSON object printed (the --output-format json result), or null */
function resultJson(stdout) {
  const s = String(stdout == null ? '' : stdout).trim();
  if (!s) return null;
  const tryParse = (x) => {
    try {
      const j = JSON.parse(x);
      return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(s);
  if (whole) return whole;
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const j = tryParse(lines[i].trim());
    if (j) return j;
  }
  return null;
}

/**
 * What the helper run came to.
 * @param {{ kind: 'exit'|'timeout'|'spawn', code?: number|null, stdout?: string }} r runChild's result
 * @returns {{ status: 'sent'|'fail'|'error'|'denied'|'notice'|'notarget'|'notools'|'timeout'|'spawn'|'exit'|'bad', detail: string }}
 *   only 'sent' means the message went out; see mayHaveSent for the rest
 */
function parseHelperResult(r) {
  if (!r || typeof r !== 'object') return { status: 'bad', detail: 'no result' };
  if (r.kind === 'timeout') return { status: 'timeout', detail: 'timeout' };
  if (r.kind === 'spawn') return { status: 'spawn', detail: 'could not start' };
  const j = resultJson(r.stdout);
  if (r.code !== 0) return { status: 'exit', detail: `exit ${r.code == null ? '?' : r.code}` };
  if (!j) return { status: 'bad', detail: 'no JSON result' };
  if (j.is_error === true || (j.subtype != null && j.subtype !== 'success')) return { status: 'error', detail: String(j.subtype || 'error') };
  if (Array.isArray(j.permission_denials) && j.permission_denials.length) return { status: 'denied', detail: 'permission denied' };
  const text = typeof j.result === 'string' ? j.result : '';
  if (NOTICE_RE.test(text)) return { status: 'notice', detail: 'delivery notice' };
  const words = text.split(/\r?\n/).map((l) => l.replace(/[`*_.!"'“”\s]/g, '').toUpperCase()).filter(Boolean);
  const last = words.length ? words[words.length - 1] : '';
  if (words.some((w) => w.includes('FAIL'))) return { status: 'fail', detail: 'FAIL' };
  if (last === 'NOTOOLS') return { status: 'notools', detail: 'NOTOOLS' };
  if (last === 'NOTARGET') return { status: 'notarget', detail: 'NOTARGET' };
  if (last === 'SENT') return { status: 'sent', detail: 'SENT' };
  return { status: 'bad', detail: 'unexpected answer' };
}

/**
 * Whether a helper status other than 'sent' can still mean the message went out: the helper can fail after SendMessage
 * (an API error on its last turn, the turn limit, a crash, a kill, a held message that is approved later). Those are
 * verified and waited for, because a copy on top of a delivered message would run the work twice. Only these say
 * nothing was sent: it never started, had no tools, the name check failed, or the send was denied.
 */
function mayHaveSent(status) {
  return !['spawn', 'notools', 'notarget', 'denied'].includes(status);
}

// ---------------------------------------------------------------------------
// The fallback chain
// ---------------------------------------------------------------------------

/**
 * What to do when the message could not be sent or verified:
 *   'prefill' → the chat is a VS Code chat open in this window: fill its input, tell the user, then wait (fallback i);
 *   'wait'    → a message may still land (sent, not verified): wait for a new user entry before the copy (fallback ii);
 *   'bg'      → run `claude --bg --resume` as before (a copy when the chat is open elsewhere, the chat itself when not).
 * @param {{ open: boolean, sent?: boolean, vscodeEntry?: boolean, ownedHere?: boolean, canPrefill?: boolean }} o
 * @returns {'prefill'|'wait'|'bg'}
 */
function fallbackStep(o = {}) {
  if (!o.open) return 'bg';
  if (o.sent) return 'wait';
  if (o.vscodeEntry && o.ownedHere && o.canPrefill) return 'prefill';
  return 'bg';
}

module.exports = {
  MARKER_TAG, NONCE_RE, NAME_RE, PERMISSION_MODES, HELPER_MODEL, HELPER_EFFORT, HELPER_MAX_TURNS, HELPER_TOOLS, HELPER_SETTINGS, HELPER_ENV,
  FRESH_SLACK_MS, FRESH_MAX_MS,
  makeNonce, markerOf, oneLine, buildMessage,
  isRegistryFile, registryEntry, liveness, pickTarget, sameTarget,
  textOf, isUserPrompt, hasMarkerLine, transcriptHasMarker, hasNewUserPrompt, permissionModeOf,
  helperPrompt, helperArgs, resultJson, parseHelperResult, mayHaveSent,
  fallbackStep,
};
