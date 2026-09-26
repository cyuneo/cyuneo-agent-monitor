'use strict';
// Auto-resume (0.6.0), the pure half (docs/DESIGN.md §12). For Claude Code chats in projects the user opted in, after an
// API error or a usage limit the extension runs `claude --bg --resume <sessionId> "<prompt>"`. This module decides;
// lib/autoresume-runtime.js acts. No vscode, no fs, no clock: everything comes in as arguments.
// - Settings: maxAttempts 1–10 (default 3), errorDelayMinutes 1–60 (default 2), afterLimit (default true).
// - Project: the opted-in folder that holds the session cwd (separator boundary, lib/scope.js comparison; the longest
//   match wins). Pass { platform: 'darwin' } to also ignore case on macOS (scope.js folds case for Windows paths only).
// - Trigger, from the main agent's status only: apiError → 'error', planned at sinceMs + errorDelayMinutes × 2^(n−1) min;
//   quota (afterLimit on) → 'limit', planned at resetsAtMs + 60 s, or state noReset when the reset time is unknown.
//   A limit Claude Code continues by itself (live, not the VS Code panel, the SDK or a background session,
//   QuotaHit.autoContinue !== false, autoContinueAtUsageLimit !== false in the user's Claude settings) → state self.
//   Any other status: no plan.
// - A planned time already past → now + 5 s, kept stable across snapshots (planFor's prev). A stop older than 24 h, or
//   one whose planned time falls more than 24 h after it, is not resumed (no plan).
// - Lineage: attempts are counted per original session; a copy started by `--bg --resume` (the session was open in
//   another process) counts under the session it was copied from (state.aliases, keyed by the copy's job id: the first
//   8 characters of its session id, which is all `--bg` prints). At most one resume per stop
//   (stopId = `${sessionId}|${code}|${sinceMs}`); maxAttempts per lineage, then gaveUp. A lineage session reaching
//   done after the last resume, or 24 h without a resume, resets the count.

const scope = require('../scope');
const { isUuid } = require('./status');
const { quotePosixPath, quotePwshPath } = require('./resume');

const DEFAULTS = Object.freeze({ maxAttempts: 3, errorDelayMinutes: 2, afterLimit: true });
const LIMITS = Object.freeze({ maxAttempts: Object.freeze([1, 10]), errorDelayMinutes: Object.freeze([1, 60]) });
const PROJECTS_KEY = 'agentMonitor.autoResume.projects';   // globalState: string[] of absolute folder paths
const STATE_VERSION = 1;
const CUTOFF_MS = 24 * 3600e3;     // stops older than this are not resumed; the attempt count resets this long after a resume
const ASAP_MS = 5000;              // a planned time already past → now + 5 s
const LIMIT_PAD_MS = 60e3;         // resume a minute after the usage limit resets
const PROMPT_MAX = 1000;           // code points
const EXECUTED_MAX = 300;
const CANCELLED_MAX = 300;
const ALIASES_MAX = 500;
const LINEAGES_MAX = 500;
const ALIAS_DEPTH_MAX = 20;

const TRIGGER_OF = Object.freeze({ apiError: 'error', quota: 'limit' });
const PLAN_STATES = Object.freeze(['scheduled', 'self', 'noReset', 'gaveUp', 'running']);
const UNAVAILABLE = Object.freeze(['cliNotFound', 'cliTooOld', 'noCwd']);
const ERRORS = Object.freeze(['cliNotFound', 'cliTooOld', 'noCwd', 'untrusted', 'exit', 'timeout', 'spawn']);
const OUTCOMES = Object.freeze(['resumed', 'copied', 'failed', 'gaveUp']);

/** @typedef {{ key: string, sessionId: string, project: string, projectName: string, stopId: string,
 *  trigger: 'error'|'limit', state: 'scheduled'|'self'|'noReset'|'gaveUp'|'running', atMs: number|null,
 *  attempt: number, max: number, unavailable: null|'cliNotFound'|'cliTooOld'|'noCwd' }} Plan */
/** @typedef {{ type: 'autoResume', outcome: 'resumed'|'copied'|'failed'|'gaveUp', key: string|null,
 *  sessionId: string|null, project: string|null, projectName: string|null, attempt: number, max: number,
 *  copySessionId: string|null, error: null|'cliNotFound'|'cliTooOld'|'noCwd'|'untrusted'|'exit'|'timeout'|'spawn',
 *  atMs: number|null, manual: boolean }} Outcome */
/** @typedef {{ v: number, lineages: Record<string, { attempts: number, lastMs: number|null }>,
 *  aliases: Record<string, string>, executed: Record<string, number>, cancelled: Record<string, number> }} State */

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;          // session ids (and copy ids) as state keys
const STOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_|.:-]{0,255}$/;  // stop ids as state keys
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const BIDI_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;

/** id is in a Set, an array, or an object map */
function has(coll, id) {
  if (!coll || id == null) return false;
  if (coll instanceof Set || coll instanceof Map) return coll.has(id);
  if (Array.isArray(coll)) return coll.includes(id);
  return own(coll, id);
}

// ---------------------------------------------------------------------------
// Settings and projects
// ---------------------------------------------------------------------------

function numSetting(v, range, def, round) {
  if (!fin(v)) return def;
  const n = round ? Math.round(v) : v;
  return Math.min(range[1], Math.max(range[0], n));
}

/**
 * Settings with defaults and ranges: maxAttempts 1–10 (whole number, default 3), errorDelayMinutes 1–60 (default 2),
 * afterLimit (only false turns it off).
 * @param {any} raw
 * @returns {{ maxAttempts: number, errorDelayMinutes: number, afterLimit: boolean }}
 */
function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    maxAttempts: numSetting(r.maxAttempts, LIMITS.maxAttempts, DEFAULTS.maxAttempts, true),
    errorDelayMinutes: numSetting(r.errorDelayMinutes, LIMITS.errorDelayMinutes, DEFAULTS.errorDelayMinutes, false),
    afterLimit: r.afterLimit !== false,
  };
}

const foldCase = (p, o) => (o && (o.platform === 'darwin' || o.caseInsensitive === true) ? String(p).toLowerCase() : String(p));

/**
 * The opted-in folder that holds cwd (equal, or inside it on a separator boundary; lib/scope.js comparison). Several
 * match → the longest (the innermost folder). Returns the entry as stored, or null.
 * @param {string|null|undefined} cwd
 * @param {string[]} projects
 * @param {{ platform?: string, caseInsensitive?: boolean }} [o] platform 'darwin' also ignores case on macOS
 * @returns {string|null}
 */
function projectOf(cwd, projects, o = {}) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const c = foldCase(cwd, o);
  let best = null;
  let bestLen = -1;
  for (const p of Array.isArray(projects) ? projects : []) {
    if (typeof p !== 'string' || !p) continue;
    if (!scope.cwdInWorkspace(c, { paths: [foldCase(p, o)] })) continue;
    const len = p.length > 1 ? p.replace(/[\\/]+$/, '').length : p.length;
    if (len > bestLen) { best = p; bestLen = len; }
  }
  return best;
}

/** Two folder paths name the same folder (trailing separators ignored; the same comparison as projectOf) */
function sameDir(a, b, o = {}) {
  if (typeof a !== 'string' || !a || typeof b !== 'string' || !b) return false;
  const x = foldCase(a, o);
  const y = foldCase(b, o);
  return scope.cwdInWorkspace(x, { paths: [y] }) && scope.cwdInWorkspace(y, { paths: [x] });
}

/** Folder name of a path (either separator); the path itself for a root */
function projectName(dir) {
  const raw = typeof dir === 'string' ? dir : '';
  if (!raw) return null;
  const s = raw.replace(/[\\/]+$/, '');
  if (!s) return raw;
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

/** `${sessionId}|${code}|${sinceMs}` of the main status (any status; resumeNow uses it for a stale or interrupted chat) */
function stopIdOf(session) {
  const st = session && session.main && session.main.status;
  if (!session || !st) return null;
  return `${session.id}|${st.code}|${st.sinceMs}`;
}

/**
 * The stop that can trigger an auto-resume: a Claude chat (UUID id) whose main agent is at apiError (trigger 'error')
 * or quota (trigger 'limit'), with a known stop time. Anything else → null.
 * @param {any} session
 * @returns {{ stopId: string, sessionId: string, code: string, trigger: 'error'|'limit', sinceMs: number,
 *   quota: any, resetsAtMs: number|null }|null}
 */
function stopOf(session) {
  if (!session || session.provider !== 'claude' || !isUuid(session.id)) return null;
  const st = session.main && session.main.status;
  if (!st || typeof st !== 'object') return null;
  const trigger = own(TRIGGER_OF, st.code) ? TRIGGER_OF[st.code] : null;
  if (!trigger || !fin(st.sinceMs)) return null;
  const quota = st.quota && typeof st.quota === 'object' ? st.quota : null;
  return {
    stopId: `${session.id}|${st.code}|${st.sinceMs}`,
    sessionId: session.id,
    code: st.code,
    trigger,
    sinceMs: st.sinceMs,
    quota,
    resetsAtMs: quota && fin(quota.resetsAtMs) ? quota.resetsAtMs : null,
  };
}

function entryOf(session) {
  if (session.entry) return session.entry;
  const raw = String(session.entrypoint || session.entryRaw || '');
  if (raw === 'claude-vscode') return 'vscode';
  if (/^sdk/.test(raw)) return 'sdk';
  return raw || null;
}

/**
 * Claude Code waits for the reset and continues by itself (§12.3): a usage limit, the chat is open (live), not in the
 * VS Code panel or the SDK (the setting only works in the interactive CLI), QuotaHit.autoContinue !== false, and the
 * user's Claude settings do not set autoContinueAtUsageLimit to false. A background session (registry kind 'bg', what
 * `--bg` runs; it stays alive, idle, after a turn) is not counted on: that it continues by itself is unverified, so it
 * gets a plan, which is skipped if the chat has moved on by then.
 * @param {any} session
 * @param {ReturnType<typeof stopOf>} stop
 * @param {any} claudeSettings parsed ~/.claude/settings.json ({} when missing or unreadable)
 */
function claudeContinuesItself(session, stop, claudeSettings) {
  if (!session || !stop || stop.trigger !== 'limit' || session.live !== true) return false;
  if (session.liveKind === 'bg') return false;
  const entry = entryOf(session);
  if (entry === 'vscode' || entry === 'sdk') return false;
  if (stop.quota && stop.quota.autoContinue === false) return false;
  const cs = claudeSettings && typeof claudeSettings === 'object' ? claudeSettings : {};
  return cs.autoContinueAtUsageLimit !== false;
}

/** `${stopId}#${attempt}`: one planned run */
function planIdOf(plan) {
  return plan ? `${plan.stopId}#${plan.attempt}` : null;
}

/**
 * The plan for a session, or null (no stop, project not on, limit with afterLimit off, stop cancelled or already run,
 * older than 24 h, or planned time more than 24 h after the stop).
 * @param {any} session
 * @param {{ attempts?: number }|number|null} lineage attempts already made in this session's lineage (lineageOf)
 * @param {{ settings?: any, projects?: string[], claudeSettings?: any, now: number, cancelled?: any, executed?: any,
 *   prev?: Plan|null, platform?: string }} o prev: the last plan for this session (keeps a clamped time stable)
 * @returns {Plan|null}
 */
function planFor(session, lineage, o = {}) {
  const stop = stopOf(session);
  if (!stop) return null;
  const project = projectOf(session.cwd, o.projects, { platform: o.platform });
  if (!project) return null;
  const settings = normalizeSettings(o.settings);
  if (stop.trigger === 'limit' && !settings.afterLimit) return null;
  const now = fin(o.now) ? o.now : stop.sinceMs;
  if (now - stop.sinceMs > CUTOFF_MS) return null;
  if (has(o.cancelled, stop.stopId) || has(o.executed, stop.stopId)) return null;
  const usedRaw = typeof lineage === 'number' ? lineage : lineage && lineage.attempts;
  const used = fin(usedRaw) && usedRaw > 0 ? Math.floor(usedRaw) : 0;
  const max = settings.maxAttempts;
  const plan = {
    key: typeof session.key === 'string' && session.key ? session.key : `claude:${session.id}`,
    sessionId: session.id,
    project,
    projectName: projectName(project),
    stopId: stop.stopId,
    trigger: stop.trigger,
    state: 'scheduled',
    atMs: null,
    attempt: Math.min(used + 1, max),
    max,
    unavailable: null,
  };
  if (claudeContinuesItself(session, stop, o.claudeSettings)) return { ...plan, state: 'self', atMs: stop.resetsAtMs };
  if (used >= max) return { ...plan, state: 'gaveUp', attempt: max };
  let raw;
  if (stop.trigger === 'limit') {
    if (!fin(stop.resetsAtMs)) return { ...plan, state: 'noReset' };
    raw = stop.resetsAtMs + LIMIT_PAD_MS;
  } else {
    raw = stop.sinceMs + settings.errorDelayMinutes * 60e3 * 2 ** (plan.attempt - 1);
  }
  if (raw - stop.sinceMs > CUTOFF_MS) return null;
  let atMs = raw;
  if (atMs <= now) {
    const prev = o.prev;
    const keep = prev && prev.stopId === stop.stopId && prev.attempt === plan.attempt
      && (prev.state === 'scheduled' || prev.state === 'running') && fin(prev.atMs);
    atMs = keep ? prev.atMs : now + ASAP_MS;
  }
  return { ...plan, atMs };
}

// ---------------------------------------------------------------------------
// Lineage and the state file (<globalStorage>/autoresume.json)
// ---------------------------------------------------------------------------

/** @returns {State} */
function emptyState() {
  return { v: STATE_VERSION, lineages: {}, aliases: {}, executed: {}, cancelled: {} };
}

const objOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Keeps the max entries with the largest msOf (all when within the bound) */
function newest(map, max, msOf) {
  const e = Object.entries(map);
  if (e.length <= max) return map;
  e.sort((a, b) => msOf(b[1]) - msOf(a[1]));
  const out = {};
  for (const [k, v] of e.slice(0, max)) out[k] = v;
  return out;
}

function bound(s) {
  s.lineages = newest(s.lineages, LINEAGES_MAX, (L) => (fin(L.lastMs) ? L.lastMs : 0));
  s.executed = newest(s.executed, EXECUTED_MAX, (ms) => ms);
  s.cancelled = newest(s.cancelled, CANCELLED_MAX, (ms) => ms);
  const al = Object.keys(s.aliases);
  if (al.length > ALIASES_MAX) for (const k of al.slice(0, al.length - ALIASES_MAX)) delete s.aliases[k];
  return s;
}

/**
 * A state read from disk (or anything else) → a clean, bounded State. Never throws.
 * @param {any} raw
 * @returns {State}
 */
function normalizeState(raw) {
  const out = emptyState();
  const r = objOf(raw);
  for (const [id, L] of Object.entries(objOf(r.lineages))) {
    if (!ID_RE.test(id) || !L || typeof L !== 'object') continue;
    out.lineages[id] = {
      attempts: fin(L.attempts) && L.attempts > 0 ? Math.floor(L.attempts) : 0,
      lastMs: fin(L.lastMs) ? L.lastMs : null,
    };
  }
  for (const [id, root] of Object.entries(objOf(r.aliases))) {
    if (ID_RE.test(id) && typeof root === 'string' && ID_RE.test(root) && root !== id) out.aliases[id] = root;
  }
  for (const k of ['executed', 'cancelled']) {
    for (const [id, ms] of Object.entries(objOf(r[k]))) if (STOP_ID_RE.test(id)) out[k][id] = fin(ms) ? ms : 0;
  }
  return bound(out);
}

function copyState(state) {
  const s = state && typeof state === 'object' ? state : emptyState();
  const lineages = {};
  for (const [k, L] of Object.entries(objOf(s.lineages))) lineages[k] = { ...L };
  return {
    v: STATE_VERSION,
    lineages,
    aliases: { ...objOf(s.aliases) },
    executed: { ...objOf(s.executed) },
    cancelled: { ...objOf(s.cancelled) },
  };
}

/** What a session was copied from: its own entry, or its job id's (a copy is recorded by the job id `--bg` prints) */
function aliasOf(aliases, id) {
  if (own(aliases, id)) return aliases[id];
  const job = isUuid(id) ? id.slice(0, 8).toLowerCase() : null;
  return job && job !== id && own(aliases, job) ? aliases[job] : null;
}

/** The original session of a (possibly copied) session: follows state.aliases */
function rootOf(state, sessionId) {
  const aliases = objOf(state && state.aliases);
  let id = sessionId;
  const seen = new Set([id]);
  for (let i = 0; i < ALIAS_DEPTH_MAX; i++) {
    const next = aliasOf(aliases, id);
    if (typeof next !== 'string' || !next || seen.has(next)) break;
    seen.add(next);
    id = next;
  }
  return id;
}

/**
 * Attempts made in a session's lineage; 0 once 24 h passed since the last one.
 * @returns {{ root: string, attempts: number, lastMs: number|null }}
 */
function lineageOf(state, sessionId, now) {
  const root = rootOf(state, sessionId);
  const lineages = objOf(state && state.lineages);
  const L = own(lineages, root) ? lineages[root] : null;
  let attempts = L && fin(L.attempts) ? L.attempts : 0;
  const lastMs = L && fin(L.lastMs) ? L.lastMs : null;
  if (attempts > 0 && fin(now) && lastMs != null && now - lastMs > CUTOFF_MS) attempts = 0;
  return { root, attempts, lastMs };
}

/** One auto attempt for the stop: the lineage count + 1, its time, and the stop marked as run. Returns a new state. */
function recordAttempt(state, sessionId, stopId, now) {
  const s = copyState(state);
  const { root, attempts } = lineageOf(s, sessionId, now);
  s.lineages[root] = { attempts: attempts + 1, lastMs: fin(now) ? now : null };
  if (typeof stopId === 'string' && STOP_ID_RE.test(stopId)) s.executed[stopId] = fin(now) ? now : 0;
  return bound(s);
}

/** The stop was run by hand (resumeNow): no auto plan for it any more, the attempt count unchanged */
function markExecuted(state, stopId, now) {
  const s = copyState(state);
  if (typeof stopId === 'string' && STOP_ID_RE.test(stopId)) s.executed[stopId] = fin(now) ? now : 0;
  return bound(s);
}

/** The user cancelled the auto-resume of this stop */
function addCancelled(state, stopId, now) {
  const s = copyState(state);
  if (typeof stopId === 'string' && STOP_ID_RE.test(stopId)) s.cancelled[stopId] = fin(now) ? now : 0;
  return bound(s);
}

/** `--bg --resume` started a copy (copyId: its job id or session id): it counts under the original's lineage from now on */
function recordCopy(state, copyId, sessionId) {
  const s = copyState(state);
  if (typeof copyId !== 'string' || !ID_RE.test(copyId)) return s;
  const root = rootOf(s, sessionId);
  if (typeof root !== 'string' || !ID_RE.test(root) || root === copyId || root.slice(0, 8).toLowerCase() === copyId.toLowerCase()
    || rootOf(s, root) === copyId) return s;
  delete s.aliases[copyId];
  s.aliases[copyId] = root;
  return bound(s);
}

/**
 * A lineage session whose main status is done, entered after the lineage's last resume, resets the count.
 * @param {State} state
 * @param {any[]} sessions
 * @returns {{ state: State, changed: boolean }} state is the same object when nothing changed
 */
function resetOnDone(state, sessions) {
  let s = null;
  const lineages = objOf(state && state.lineages);
  for (const x of Array.isArray(sessions) ? sessions : []) {
    if (!x || x.provider !== 'claude' || typeof x.id !== 'string') continue;
    const st = x.main && x.main.status;
    if (!st || st.code !== 'done' || !fin(st.sinceMs)) continue;
    const root = rootOf(state, x.id);
    const L = own(lineages, root) ? lineages[root] : null;
    if (!L || !(L.attempts > 0) || !fin(L.lastMs) || st.sinceMs <= L.lastMs) continue;
    if (!s) s = copyState(state);
    s.lineages[root] = { attempts: 0, lastMs: L.lastMs };
  }
  return { state: s || state, changed: !!s };
}

/** Drops what no longer matters (run or cancelled stops and lineages past the 24 h window) and bounds the rest */
function pruneState(state, now) {
  const s = copyState(state);
  if (fin(now)) {
    // an hour of slack past the 24 h window; entries of unknown time (0) go first when the bound is reached
    const old = (ms) => fin(ms) && ms > 0 && now - ms > CUTOFF_MS + 3600e3;
    for (const k of ['executed', 'cancelled']) for (const [id, ms] of Object.entries(s[k])) if (old(ms)) delete s[k][id];
    for (const [id, L] of Object.entries(s.lineages)) if (!L.attempts || old(L.lastMs)) delete s.lineages[id];
  }
  return bound(s);
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/** The prompt as one line: controls and bidi marks out, whitespace collapsed, capped, never starting with '-' */
function cleanPrompt(prompt) {
  let s = String(prompt == null ? '' : prompt).replace(BIDI_RE, '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[-\s]+/, '');
  const a = Array.from(s);
  if (a.length > PROMPT_MAX) s = a.slice(0, PROMPT_MAX).join('').trim();
  return s;
}

/**
 * argv for the background resume: ['--bg', '--resume', sessionId, prompt]. null when the id is not a UUID or the
 * prompt is empty after cleaning.
 * @param {string} sessionId
 * @param {string} prompt
 * @returns {string[]|null}
 */
function buildArgs(sessionId, prompt) {
  if (!isUuid(sessionId)) return null;
  const p = cleanPrompt(prompt);
  if (!p) return null;
  return ['--bg', '--resume', sessionId, p];
}

const COPY_RE = /started\s+a\s+(?:restricted\s+)?copy(?:\s+of\s+that\s+conversation)?\s+as\s*[:=]?\s*[`'"\u2018\u201c(<\[]*([A-Za-z0-9][A-Za-z0-9_-]*)/i;
const JOB_RE = /(?:^|\n)[ \t]*backgrounded\b[^\n]*?\b([0-9a-f]{8})\b/i;
const UNTRUSTED_RE = /workspace\s+not\s+trusted/i;

const outputText = (stdout, stderr) => `${stdout == null ? '' : String(stdout)}\n${stderr == null ? '' : String(stderr)}`.replace(ANSI_RE, '');

/**
 * What `claude --bg --resume <id>` printed (§12.2, Claude Code 2.1.283). stdout begins "backgrounded · <job>", the job
 * id being the first 8 characters of the session that now runs. A job id other than the chat's own means Claude Code
 * started a copy, and stderr says so:
 *   note: session <X> is already running in the background, so this started a copy as <Y>. `claude attach <X>` opens the original.
 *   note: session <X> is open in another Claude Code process, so this started a copy as <Y>. The original conversation is unchanged.
 * Tolerant: stdout or stderr, any case, ANSI colors, quotes around the id.
 * @param {any} stdout
 * @param {any} stderr
 * @param {string} [sessionId] the chat resumed: a job id other than its first 8 characters is a copy even without the note
 * @returns {{ copySessionId: string|null }} the copy's id as printed (a job id), or null when the chat itself continues
 */
function parseOutput(stdout, stderr, sessionId) {
  const text = outputText(stdout, stderr);
  const m = COPY_RE.exec(text);
  let id = m && m[1] && m[1].length >= 6 && m[1].length <= 128 ? m[1] : null;
  if (!id && typeof sessionId === 'string' && sessionId) {
    const j = JOB_RE.exec(text);
    const job = j ? j[1].toLowerCase() : null;
    if (job && job !== sessionId.slice(0, 8).toLowerCase()) id = job;
  }
  return { copySessionId: id };
}

/** A non-zero exit: 'untrusted' when Claude Code refused to run in a folder it doesn't trust yet (§12.2), else 'exit' */
function failureOf(stdout, stderr) {
  return UNTRUSTED_RE.test(outputText(stdout, stderr)) ? 'untrusted' : 'exit';
}

/**
 * What [Open terminal] types (never runs) after failed/untrusted: the CLI found, quoted for the shell of that platform
 * (PowerShell on Windows), or plain `claude`. Run once in the chat's folder, it shows Claude Code's trust prompt.
 * @param {string|null} cliPath
 * @param {string} platform process.platform
 */
function trustCommand(cliPath, platform) {
  const cli = typeof cliPath === 'string' && cliPath && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(cliPath) ? cliPath : null;
  if (!cli) return 'claude';
  return platform === 'win32' ? `& ${quotePwshPath(cli)}` : quotePosixPath(cli);
}

/**
 * An Outcome event (§12.5) for a plan (or anything with key / sessionId / project / projectName / attempt / max).
 * @param {any} base
 * @param {'resumed'|'copied'|'failed'|'gaveUp'} outcome
 * @param {{ error?: string|null, copySessionId?: string|null, atMs?: number, manual?: boolean, attempt?: number }} [o]
 * @returns {Outcome}
 */
function makeOutcome(base, outcome, o = {}) {
  const b = base && typeof base === 'object' ? base : {};
  return {
    type: 'autoResume',
    outcome,
    key: b.key || null,
    sessionId: b.sessionId || null,
    project: b.project || null,
    projectName: b.projectName || (b.project ? projectName(b.project) : null),
    attempt: fin(o.attempt) ? o.attempt : fin(b.attempt) ? b.attempt : 0,
    max: fin(b.max) ? b.max : DEFAULTS.maxAttempts,
    copySessionId: outcome === 'copied' && o.copySessionId ? o.copySessionId : null,
    error: outcome === 'failed' ? (ERRORS.includes(o.error) ? o.error : 'spawn') : null,
    atMs: fin(o.atMs) ? o.atMs : null,
    manual: o.manual === true,
  };
}

module.exports = {
  DEFAULTS, LIMITS, PROJECTS_KEY, STATE_VERSION, CUTOFF_MS, ASAP_MS, LIMIT_PAD_MS, PROMPT_MAX,
  EXECUTED_MAX, CANCELLED_MAX, ALIASES_MAX, LINEAGES_MAX,
  PLAN_STATES, UNAVAILABLE, ERRORS, OUTCOMES,
  fin, has,
  normalizeSettings, projectOf, sameDir, projectName,
  stopIdOf, stopOf, claudeContinuesItself, planIdOf, planFor,
  emptyState, normalizeState, rootOf, lineageOf, recordAttempt, markExecuted, addCancelled, recordCopy, resetOnDone, pruneState,
  cleanPrompt, buildArgs, parseOutput, failureOf, trustCommand, makeOutcome,
};
