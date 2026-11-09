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
// - Account switch (o.account, from an account switcher such as cswap; optional): a limit stop is resumed SWITCH_PAD_MS
//   after the switch instead of after the reset, when the account now in use has room (plan.via 'switch', plan.account
//   its label) and the switch can have helped (0.11.1):
//   · a spend limit (QuotaHit.kind 'spend', which billing errors are too): only a switch after the stop;
//   · any other limit: a switch after the stop, or at most SWITCH_BEFORE_MS before it (a request in flight on the old
//     login when the switch landed); a stop later than that came from the account switched to, which refused;
//   · a stop within FAST_FAIL_MS of the lineage's last resume (that resume did nothing): only a switch after that resume.
//   Otherwise the plan waits for the reset, or noReset, with plan.held saying why (the panel and the stop's push show it).
//   A later switch still resumes promptly.
//   cswap's "has room" is never taken over any of this: it sees the 5h and 7d windows only. A live CLI chat that continues
//   by itself is still left alone.
// - A planned time already past → now + 5 s, kept stable across snapshots (planFor's prev). A stop older than 24 h, or
//   one whose planned time falls more than 24 h after it, is not resumed (no plan).
// - Lineage: attempts are counted per original session; a copy started by `--bg --resume` (the session was open in
//   another process) counts under the session it was copied from (state.aliases, keyed by the copy's job id: the first
//   8 characters of its session id, which is all `--bg` prints). At most one resume per stop
//   (stopId = `${sessionId}|${code}|${sinceMs}`); maxAttempts per lineage, then gaveUp.
//   The lineage's head (L.head) is the session the last resume continued: the one resumed, then its copy once known. A
//   new prompt in another session of the lineage (the user went back to it) makes that one the head (resetOnDone).
//   The head with a real assistant turn in its transcript since the last resume (Session.lastRealTurnMs, not a synthetic
//   error record) resets the count, however quick the turn and whatever its status: the API answered, so the resume did
//   work. A done without such a turn resets nothing (it may come from the registry alone, while a copy's limit record is
//   still on its way). A stop that comes more than 24 h after the last resume starts at 0 too; one that came within those
//   24 h stays counted, however late it is looked at (a dead chain's last stop is not resumed again a day later).
// - No plan (whyDropped; the runtime logs each once): a stop older than the lineage's last resume (a copy starts with its
//   parent's last records, so for a moment it shows the stop it was copied from: not logged); a copy's stop when another
//   session of its lineage worked after that stop, or when the copy is no longer the head (a resume cannot be recalled,
//   but no further copy is started next to the user); a stop older than state.lostBefore (the state file was lost, so
//   what ran is not known).
// - Hard cap (0.11.1, state.cap; no reset clears it): at most maxAttempts auto resumes per lineage and
//   max(PROJECT_CAP, maxAttempts) per project in any CAP_WINDOW_MS. While it holds, the plan is moved to when a slot
//   frees up (plan.held 'lineageCap' / 'projectCap'). Manual resumes never count and are never held.
// - Brake (0.11.1, state.brake): the cap refills; this does not. brakeLimit(maxAttempts) auto resumes in a project within
//   BRAKE_WINDOW_MS, not followed by a real turn of the chat each resumed (a real turn of a lineage's head takes that
//   lineage's resumes out of the count, found by their times in state.cap.lineages; never another lineage's), stop that
//   project's auto resumes: plan state gaveUp, held 'brake'. It holds every stop up to 24 h after the trip, until the
//   user acts (a manual resume in the project, or turning it off or on), or until every resume it counted was followed
//   by a real turn.

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
const SWITCH_PAD_MS = 30e3;        // resume this long after an account switch
// A switch this long before the stop still counts: the request in flight on the old login when the switch landed gets its
// 429 within seconds, and Claude Code's retries of it end within this. A stop later than that was refused by the account
// switched to. Waiting for the reset is the safe side if a chat really kept the old login for longer.
const SWITCH_BEFORE_MS = 2 * 60e3;
// A stop this soon after the lineage's last resume means the resume did nothing. A forked chat reaches the API within
// seconds (real limit hits: 1 to 4 s after the fork); two minutes leaves room for a large transcript and a slow machine.
// A real turn that hits a limit this soon only loses the prompt resume unless the account changes again.
const FAST_FAIL_MS = 120e3;
const CAP_WINDOW_MS = 10 * 60e3;   // the hard cap's rolling window
// Auto resumes per project in CAP_WINDOW_MS, several chats together: one account switch can legitimately resume every
// chat stopped by the same limit, so a much lower number (2) would block those. The lineage count and cap bound a single
// chat; this one bounds what they cannot see (copies whose lineage was lost). A chat over it waits, it is not dropped.
const PROJECT_CAP = 6;
const CAP_TIMES_MAX = 32;          // attempt times kept per lineage or project (a lineage's for BRAKE_WINDOW_MS: the brake's)
// Two full windows of the project cap without one real turn from anything resumed: resuming is not helping. It needs no
// lineage, so it also ends chains whose copies could not be tied together.
const BRAKE_WINDOW_MS = 3 * 3600e3;
const BRAKE_PROJECTS_MAX = 50;
const FUTURE_SLACK_MS = 60e3;      // a recorded time later than now by more than this is taken as now (a corrected clock)
const OPENING_UUIDS = 3;           // transcripts that open with the same record ids: one was forked from the other
const CAP_LINEAGES_MAX = 200;
const CAP_PROJECTS_MAX = 50;
const PROMPT_MAX = 1000;           // code points
const EXECUTED_MAX = 300;
const CANCELLED_MAX = 300;
const ALIASES_MAX = 500;
const LINEAGES_MAX = 500;
const ALIAS_DEPTH_MAX = 20;

const TRIGGER_OF = Object.freeze({ apiError: 'error', quota: 'limit' });
const PLAN_STATES = Object.freeze(['scheduled', 'self', 'noReset', 'gaveUp', 'running']);
const UNAVAILABLE = Object.freeze(['cliNotFound', 'cliTooOld', 'noCwd']);
// misdelivered: the in-window message showed up in another chat's transcript (§12.8; never retried); busy: the chat was
// running in its window when the message was due (it is never interrupted)
const ERRORS = Object.freeze(['cliNotFound', 'cliTooOld', 'noCwd', 'untrusted', 'exit', 'timeout', 'spawn', 'misdelivered', 'busy']);
// parallel: the user went back to a chat while a copy resumed from it is still running (nothing was started or stopped)
const OUTCOMES = Object.freeze(['resumed', 'copied', 'failed', 'gaveUp', 'parallel']);
// How a resumed chat was continued (§12.8): message — the message reached the chat in its own window; prefill — the
// user sent the text Agent Monitor put in the chat's input; null — `claude --bg --resume` continued it
const VIAS = Object.freeze(['message', 'prefill']);

// Why a plan waits although the account switcher says the account has room, or past its time (a log line, once).
// unwritable: set by the runtime, not planFor: this window could not write the count or the claim, and tries again
const HOLDS = Object.freeze(['spend', 'refused', 'fastFail', 'lineageCap', 'projectCap', 'brake', 'unwritable']);

/** @typedef {{ key: string, sessionId: string, project: string, projectName: string, stopId: string,
 *  trigger: 'error'|'limit', state: 'scheduled'|'self'|'noReset'|'gaveUp'|'running', atMs: number|null,
 *  attempt: number, max: number, unavailable: null|'cliNotFound'|'cliTooOld'|'noCwd', via?: 'switch', account?: string,
 *  held?: 'spend'|'refused'|'fastFail'|'lineageCap'|'projectCap'|'brake'|'unwritable' }} Plan */
/** @typedef {{ switchedAtMs: number|null, hasRoom: boolean, label?: string }} AccountInfo */
/** @typedef {{ type: 'autoResume', outcome: 'resumed'|'copied'|'failed'|'gaveUp'|'parallel', key: string|null,
 *  sessionId: string|null, project: string|null, projectName: string|null, attempt: number, max: number,
 *  copySessionId: string|null, error: null|'cliNotFound'|'cliTooOld'|'noCwd'|'untrusted'|'exit'|'timeout'|'spawn'|'misdelivered'|'busy',
 *  atMs: number|null, manual: boolean, via: null|'message'|'prefill', brake?: true }} Outcome */
/** @typedef {{ v: number, lineages: Record<string, { attempts: number, lastMs: number|null, head?: string, headMs?: number, project?: string }>,
 *  aliases: Record<string, string>, executed: Record<string, number>, cancelled: Record<string, number>,
 *  cap: { lineages: Record<string, number[]>, projects: Record<string, number[]> },
 *  brake: { times: Record<string, number[]>, tripped: Record<string, number> }, lostBefore?: number }} State */

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const objOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
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
 * @param {{ attempts?: number, lastMs?: number|null, root?: string }|number|null} lineage attempts already made in this
 *   session's lineage, the last one's time and the lineage's root (lineageOf)
 * @param {{ settings?: any, projects?: string[], claudeSettings?: any, now: number, cancelled?: any, executed?: any,
 *   prev?: Plan|null, platform?: string, account?: AccountInfo|null, cap?: State['cap'], brake?: State['brake'],
 *   otherWorkMs?: number|null, lostBefore?: number|null }} o prev: the last plan for this session (keeps a clamped time
 *   stable); account: the account switcher's last switch and whether the account in use has room; cap, brake: the state
 *   file's records; otherWorkMs: the newest work of the other sessions in this lineage (lineageWork); lostBefore: the
 *   state file was lost, stops before this are not known to be unrun
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
  const lastMs = lineage && typeof lineage === 'object' && fin(lineage.lastMs) ? lineage.lastMs : null;
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
  if (dropReason(session, stop, lineage, o)) return null;
  if (brakeTripped(o.brake, project, now, stop.sinceMs)) return { ...plan, state: 'gaveUp', held: 'brake' };
  if (used >= max) return { ...plan, state: 'gaveUp', attempt: max };
  let raw;
  if (stop.trigger === 'limit') {
    const check = switchCheck(stop, o.account, lastMs);
    const sw = check.atMs;
    if (check.held) plan.held = check.held;
    if (sw !== null && (!fin(stop.resetsAtMs) || sw < stop.resetsAtMs + LIMIT_PAD_MS)) {
      raw = sw;
      plan.via = 'switch';
      const label = o.account && typeof o.account.label === 'string' ? o.account.label.slice(0, 80) : '';
      if (label) plan.account = label;
    } else if (!fin(stop.resetsAtMs)) {
      return { ...plan, state: 'noReset' };
    } else {
      raw = stop.resetsAtMs + LIMIT_PAD_MS;
    }
  } else {
    raw = stop.sinceMs + settings.errorDelayMinutes * 60e3 * 2 ** (plan.attempt - 1);
  }
  const hold = capHold(o.cap, lineage && typeof lineage === 'object' && lineage.root ? lineage.root : session.id, project, max, now);
  if (hold && hold.atMs > raw) {
    raw = hold.atMs;
    plan.held = hold.held;
  }
  if (raw - stop.sinceMs > CUTOFF_MS) return null;
  let atMs = raw;
  if (atMs <= now) {
    const prev = o.prev;
    const keep = prev && prev.stopId === stop.stopId && prev.attempt === plan.attempt
      && (prev.state === 'scheduled' || prev.state === 'running') && fin(prev.atMs) && prev.atMs <= now + ASAP_MS;
    atMs = keep ? prev.atMs : now + ASAP_MS;
  }
  return { ...plan, atMs };
}

/** A session's id is the lineage's head (recorded as the session id, or as the job id `--bg` prints) */
function isHead(head, id) {
  if (typeof head !== 'string' || !head || typeof id !== 'string') return false;
  return head === id || (isUuid(id) && id.slice(0, 8).toLowerCase() === head);
}

/** Why a stop in scope gets no plan: 'older' | 'active' | 'lost', else null. See the header. */
function dropReason(session, stop, lineage, o) {
  const L = lineage && typeof lineage === 'object' ? lineage : {};
  if (fin(o.lostBefore) && stop.sinceMs < o.lostBefore) return 'lost';
  if (fin(L.lastMs) && stop.sinceMs <= L.lastMs) return 'older';
  const isCopy = typeof L.root === 'string' && L.root !== session.id;
  if (isCopy && fin(o.otherWorkMs) && o.otherWorkMs > stop.sinceMs) return 'active';
  if (isCopy && L.head && !isHead(L.head, session.id)) return 'active';
  return null;
}

/**
 * Why a stopped session that planFor would otherwise consider has no plan, for the log: 'older', 'active', 'lost' or null
 * (it has a plan, is out of scope, or merely shows the stop it was copied from for a moment).
 * @param {any} session
 * @param {any} lineage lineageOf
 * @param {any} o planFor's options
 * @returns {'older'|'active'|'lost'|null}
 */
function whyDropped(session, lineage, o = {}) {
  const stop = stopOf(session);
  if (!stop || !projectOf(session.cwd, o.projects, { platform: o.platform })) return null;
  if (stop.trigger === 'limit' && !normalizeSettings(o.settings).afterLimit) return null;
  const now = fin(o.now) ? o.now : stop.sinceMs;
  if (now - stop.sinceMs > CUTOFF_MS || has(o.cancelled, stop.stopId) || has(o.executed, stop.stopId)) return null;
  if (claudeContinuesItself(session, stop, o.claudeSettings)) return null;
  const why = dropReason(session, stop, lineage, o);
  if (why !== 'older') return why;
  // A stop some session of this chain was already resumed from: a fresh copy showing its parent's stop
  const tail = `|${stop.code}|${stop.sinceMs}`;
  const done = o.executed && typeof o.executed === 'object' ? Object.keys(o.executed) : [];
  return done.some((id) => id.endsWith(tail)) ? null : why;
}

/**
 * Whether a limit stop can be resumed because the account switcher moved to an account with room: atMs when it can;
 * else null, and held says why when the switcher claims room but the switch cannot have helped.
 * @param {ReturnType<typeof stopOf>} stop
 * @param {AccountInfo|null|undefined} account
 * @param {number|null} [lastMs] the lineage's last resume
 * @returns {{ atMs: number|null, held: 'spend'|'refused'|'fastFail'|null }}
 */
function switchCheck(stop, account, lastMs = null) {
  const no = (held = null) => ({ atMs: null, held });
  if (!stop || stop.trigger !== 'limit') return no();
  const at = account && typeof account === 'object' && fin(account.switchedAtMs) ? account.switchedAtMs : null;
  // True whatever the switcher says, or with none: a spend limit waits for the reset or a switch after the stop
  if (stop.quota && stop.quota.kind === 'spend' && (at === null || at <= stop.sinceMs)) return no('spend');
  if (at === null || account.hasRoom !== true) return no();
  if (at < stop.sinceMs - SWITCH_BEFORE_MS) return no('refused');
  if (fin(lastMs) && stop.sinceMs - lastMs <= FAST_FAIL_MS && at <= lastMs) return no('fastFail');
  return { atMs: Math.max(at, stop.sinceMs) + SWITCH_PAD_MS, held: null };
}

/** When a limit stop can be resumed because of an account switch, else null (switchCheck) */
function switchResumeAt(stop, account, lastMs = null) {
  return switchCheck(stop, account, lastMs).atMs;
}

/** The times of `list` inside the window before now (none later than now is believed), oldest first */
function capRecent(list, now, windowMs = CAP_WINDOW_MS) {
  const ms = (Array.isArray(list) ? list : []).filter(fin).sort((a, b) => a - b);
  return fin(now) ? ms.filter((t) => now - t < windowMs && t - now <= FUTURE_SLACK_MS) : ms;
}

/** Auto resumes in a project, with no real turn from anything resumed, after which the brake trips */
function brakeLimit(maxAttempts) {
  const max = fin(maxAttempts) ? maxAttempts : DEFAULTS.maxAttempts;
  return 2 * Math.max(PROJECT_CAP, max);
}

/**
 * The brake is on for this project: for a stop up to 24 h after the trip (stopMs; without one, now), however late the
 * stop is looked at. A trip later than now is not believed.
 */
function brakeTripped(brake, project, now, stopMs) {
  const m = objOf(objOf(brake).tripped);
  if (!own(m, project) || !fin(m[project])) return false;
  const at = m[project];
  if (fin(now) && at - now > FUTURE_SLACK_MS) return false;
  const ref = fin(stopMs) ? stopMs : now;
  return !fin(ref) || ref - at <= CUTOFF_MS;
}

/**
 * The hard cap: when an auto resume of this lineage in this project may run next, or null when it may run now.
 * @param {State['cap']|null|undefined} cap
 * @param {string} root the lineage
 * @param {string} project
 * @param {number} max maxAttempts
 * @param {number} now
 * @returns {{ atMs: number, held: 'lineageCap'|'projectCap' }|null}
 */
function capHold(cap, root, project, max, now) {
  const c = objOf(cap);
  const of = (map, key, n, held) => {
    const m = objOf(map);
    const recent = own(m, key) ? capRecent(m[key], now) : [];
    return recent.length >= n ? { atMs: recent[recent.length - n] + CAP_WINDOW_MS, held } : null;
  };
  const a = of(c.lineages, root, max, 'lineageCap');
  const b = of(c.projects, project, Math.max(PROJECT_CAP, max), 'projectCap');
  return a && b ? (b.atMs > a.atMs ? b : a) : a || b;
}

// ---------------------------------------------------------------------------
// Lineage and the state file (<globalStorage>/autoresume.json)
// ---------------------------------------------------------------------------

/** @returns {State} */
function emptyState() {
  return {
    v: STATE_VERSION, lineages: {}, aliases: {}, executed: {}, cancelled: {},
    cap: { lineages: {}, projects: {} }, brake: { times: {}, tripped: {} },
  };
}

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
  const lastOf = (list) => (list.length ? list[list.length - 1] : 0);
  s.cap.lineages = newest(s.cap.lineages, CAP_LINEAGES_MAX, lastOf);
  s.cap.projects = newest(s.cap.projects, CAP_PROJECTS_MAX, lastOf);
  s.brake.times = newest(s.brake.times, BRAKE_PROJECTS_MAX, lastOf);
  s.brake.tripped = newest(s.brake.tripped, BRAKE_PROJECTS_MAX, (ms) => ms);
  const al = Object.keys(s.aliases);
  if (al.length > ALIASES_MAX) for (const k of al.slice(0, al.length - ALIASES_MAX)) delete s.aliases[k];
  return s;
}

/** A project folder as a state key: a path, so never __proto__ and the like */
const isProjectKey = (p) => typeof p === 'string' && p.length <= 4096 && /[\\/]/.test(p);

/**
 * A state read from disk (or anything else) → a clean, bounded State. Never throws.
 * @param {any} raw
 * @param {number} [now] times later than this (by more than FUTURE_SLACK_MS) are taken as now: kept as they are, they would
 *   hold or hide a stop until the clock caught up; dropped, a count or cap entry would be lost (and written back so)
 * @returns {State}
 */
function normalizeState(raw, now) {
  const out = emptyState();
  const r = objOf(raw);
  const clamp = (ms) => (fin(now) && ms - now > FUTURE_SLACK_MS ? now : ms);
  for (const [id, L] of Object.entries(objOf(r.lineages))) {
    if (!ID_RE.test(id) || !L || typeof L !== 'object') continue;
    out.lineages[id] = {
      attempts: fin(L.attempts) && L.attempts > 0 ? Math.floor(L.attempts) : 0,
      lastMs: fin(L.lastMs) ? clamp(L.lastMs) : null,
    };
    if (typeof L.head === 'string' && ID_RE.test(L.head)) out.lineages[id].head = L.head;
    if (fin(L.headMs)) out.lineages[id].headMs = clamp(L.headMs);
    if (isProjectKey(L.project)) out.lineages[id].project = L.project;
  }
  for (const [id, root] of Object.entries(objOf(r.aliases))) {
    if (ID_RE.test(id) && typeof root === 'string' && ID_RE.test(root) && root !== id) out.aliases[id] = root;
  }
  for (const k of ['executed', 'cancelled']) {
    for (const [id, ms] of Object.entries(objOf(r[k]))) if (STOP_ID_RE.test(id)) out[k][id] = fin(ms) ? ms : 0;
  }
  // Older state files have no cap: it starts empty
  const cap = objOf(r.cap);
  const times = (list) => capRecent(capRecent(list).map(clamp)).slice(-CAP_TIMES_MAX);
  for (const [id, list] of Object.entries(objOf(cap.lineages))) {
    const ms = times(list);
    if (ID_RE.test(id) && ms.length) out.cap.lineages[id] = ms;
  }
  for (const [dir, list] of Object.entries(objOf(cap.projects))) {
    const ms = times(list);
    if (isProjectKey(dir) && ms.length) out.cap.projects[dir] = ms;
  }
  const brake = objOf(r.brake);
  for (const [dir, list] of Object.entries(objOf(brake.times))) {
    const ms = times(list);
    if (isProjectKey(dir) && ms.length) out.brake.times[dir] = ms;
  }
  for (const [dir, ms] of Object.entries(objOf(brake.tripped))) if (isProjectKey(dir) && fin(ms)) out.brake.tripped[dir] = clamp(ms);
  if (fin(r.lostBefore)) out.lostBefore = clamp(r.lostBefore);
  return bound(out);
}

function copyState(state) {
  const s = state && typeof state === 'object' ? state : emptyState();
  const lineages = {};
  for (const [k, L] of Object.entries(objOf(s.lineages))) lineages[k] = { ...L };
  const lists = (m) => Object.fromEntries(Object.entries(objOf(m)).map(([k, v]) => [k, Array.isArray(v) ? v.slice() : []]));
  const cap = objOf(s.cap);
  const brake = objOf(s.brake);
  return {
    v: STATE_VERSION,
    lineages,
    aliases: { ...objOf(s.aliases) },
    executed: { ...objOf(s.executed) },
    cancelled: { ...objOf(s.cancelled) },
    cap: { lineages: lists(cap.lineages), projects: lists(cap.projects) },
    brake: { times: lists(brake.times), tripped: { ...objOf(brake.tripped) } },
    ...(fin(s.lostBefore) ? { lostBefore: s.lostBefore } : {}),
  };
}

/**
 * Two views of the state in one, on the side that resumes less: for a window whose own writes fail and that must still see
 * what the others recorded. Stops run or cancelled, aliases and times: the union; per lineage the larger count and time,
 * and the head of the side that moved it last.
 * @param {State} a @param {State} b
 * @returns {State}
 */
function mergeStates(a, b) {
  const s = copyState(a);
  const o = copyState(b);
  for (const [id, L] of Object.entries(o.lineages)) {
    const M = own(s.lineages, id) ? s.lineages[id] : null;
    if (!M) { s.lineages[id] = L; continue; }
    const last = (x) => (fin(x.lastMs) ? x.lastMs : -1);
    const moved = (x) => Math.max(last(x), fin(x.headMs) ? x.headMs : -1);
    // The head of the side with the newer resume or move, never mixed from both (a move is newer than the resume it follows)
    const at = moved(L) > moved(M) || (moved(L) === moved(M) && fin(L.headMs) && !fin(M.headMs)) ? L : M;
    const next = { ...M, ...L, attempts: Math.max(M.attempts || 0, L.attempts || 0), lastMs: last(L) > last(M) ? L.lastMs : M.lastMs };
    delete next.head;
    delete next.headMs;
    if (typeof at.head === 'string') next.head = at.head;
    if (fin(at.headMs)) next.headMs = at.headMs;
    s.lineages[id] = next;
  }
  Object.assign(s.aliases, o.aliases);
  for (const k of ['executed', 'cancelled']) {
    for (const [id, ms] of Object.entries(o[k])) if (!own(s[k], id) || ms > s[k][id]) s[k][id] = ms;
  }
  const union = (x, y) => {
    for (const [k, list] of Object.entries(y)) x[k] = [...new Set([...(own(x, k) ? x[k] : []), ...list])].sort((p, q) => p - q).slice(-CAP_TIMES_MAX);
  };
  union(s.cap.lineages, o.cap.lineages);
  union(s.cap.projects, o.cap.projects);
  union(s.brake.times, o.brake.times);
  for (const [k, ms] of Object.entries(o.brake.tripped)) if (!own(s.brake.tripped, k) || ms > s.brake.tripped[k]) s.brake.tripped[k] = ms;
  if (fin(o.lostBefore) && !(s.lostBefore >= o.lostBefore)) s.lostBefore = o.lostBefore;
  return bound(s);
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
 * Attempts made in a session's lineage; 0 for a time (now, or a stop's time: the runtime passes the stop's) more than 24 h
 * after the last one.
 * @returns {{ root: string, attempts: number, lastMs: number|null, head: string|null }}
 */
function lineageOf(state, sessionId, now) {
  const root = rootOf(state, sessionId);
  const lineages = objOf(state && state.lineages);
  const L = own(lineages, root) ? lineages[root] : null;
  let attempts = L && fin(L.attempts) ? L.attempts : 0;
  const lastMs = L && fin(L.lastMs) ? L.lastMs : null;
  if (attempts > 0 && fin(now) && lastMs != null && now - lastMs > CUTOFF_MS) attempts = 0;
  return { root, attempts, lastMs, head: L && typeof L.head === 'string' ? L.head : null };
}

/** The newest prompt or real assistant turn of a session, 0 when it has none (copied records carry their old times) */
function workMs(session) {
  const p = session && fin(session.lastPromptMs) ? session.lastPromptMs : 0;
  const r = session && fin(session.lastRealTurnMs) ? session.lastRealTurnMs : 0;
  return Math.max(p, r);
}

/**
 * The newest work per lineage, for planFor's otherWorkMs.
 * @param {State} state
 * @param {any[]} sessions
 * @returns {(sessionId: string) => number|null} the newest work of the other sessions in that session's lineage
 */
function lineageWork(state, sessions) {
  const byRoot = new Map();
  for (const x of Array.isArray(sessions) ? sessions : []) {
    if (!x || x.provider !== 'claude' || typeof x.id !== 'string') continue;
    const root = rootOf(state, x.id);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push({ id: x.id, ms: workMs(x) });
  }
  return (sessionId) => {
    let best = null;
    for (const m of byRoot.get(rootOf(state, sessionId)) || []) if (m.id !== sessionId && m.ms > 0 && (best === null || m.ms > best)) best = m.ms;
    return best;
  };
}

/**
 * One auto attempt for the stop: the lineage count + 1, its time, the session as head, the stop marked as run, and the time
 * in the hard cap's records (of the lineage, and of the project when given) and the brake's. Returns a new state.
 * @param {State} state
 * @param {string} sessionId
 * @param {string|null} stopId
 * @param {number} now
 * @param {string} [project]
 * @param {number} [maxAttempts] given: the brake trips when this attempt reaches brakeLimit(maxAttempts)
 */
function recordAttempt(state, sessionId, stopId, now, project, maxAttempts) {
  const s = copyState(state);
  // Counted as planFor counted it: at the stop's time (the last part of its id), so a stop of the day after the last
  // resume adds to that count even when it runs more than a day after it
  const stopMs = typeof stopId === 'string' ? Number(stopId.slice(stopId.lastIndexOf('|') + 1)) : NaN;
  const { root, attempts } = lineageOf(s, sessionId, fin(stopMs) && fin(now) ? Math.min(stopMs, now) : now);
  s.lineages[root] = { attempts: attempts + 1, lastMs: fin(now) ? now : null, head: sessionId };
  if (isProjectKey(project)) s.lineages[root].project = project;
  if (fin(now)) {
    const add = (m, k, w) => { m[k] = [...capRecent(own(m, k) ? m[k] : [], now, w), now].slice(-CAP_TIMES_MAX); };
    if (ID_RE.test(root)) add(s.cap.lineages, root, BRAKE_WINDOW_MS); // the brake finds a lineage's resumes here
    if (isProjectKey(project)) {
      add(s.cap.projects, project);
      add(s.brake.times, project, BRAKE_WINDOW_MS);
      if (fin(maxAttempts) && s.brake.times[project].length >= brakeLimit(maxAttempts)) s.brake.tripped[project] = now;
    }
  }
  if (typeof stopId === 'string' && STOP_ID_RE.test(stopId)) s.executed[stopId] = fin(now) ? now : 0;
  return bound(s);
}

/** The stop was run by hand (resumeNow): no auto plan for it any more, the attempt count unchanged */
function markExecuted(state, stopId, now) {
  const s = copyState(state);
  if (typeof stopId === 'string' && STOP_ID_RE.test(stopId)) s.executed[stopId] = fin(now) ? now : 0;
  return bound(s);
}

/** The user acted in this project (a manual resume, the project turned off or on): the brake starts over */
function clearBrake(state, project) {
  const s = copyState(state);
  delete s.brake.times[project];
  delete s.brake.tripped[project];
  return s;
}

/** The state file was lost at this time: stops before it are not known to be unrun (whyDropped) */
function markLost(state, now) {
  const s = copyState(state);
  if (fin(now)) s.lostBefore = now;
  return s;
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
  if (own(s.lineages, root)) {
    s.lineages[root] = { ...s.lineages[root], head: copyId };
    delete s.lineages[root].headMs;
  }
  return bound(s);
}

/**
 * What the sessions say about their lineages (see the header):
 * - a prompt in another session than the head, newer than the last resume and the last such move → that session is the
 *   head (moved: the user went back to it; a running old head is theirs to notice);
 * - the head with a real assistant turn since the last resume, at any status → the count starts over (resets);
 * - such a turn from the head the resume left → this lineage's resumes (its times in state.cap.lineages) leave the
 *   project's brake count, and a trip whose count that empties is lifted. Not from a head the user moved (their own work
 *   says nothing about the copies), and never another lineage's resumes (copies nothing ties to this chat are their own).
 * The hard cap's records stay, and so does lastMs: it is what tells a held stop from a new one.
 * @param {State} state
 * @param {any[]} sessions
 * @returns {{ state: State, changed: boolean, resets: { root: string, sessionId: string, attempts: number }[],
 *   moved: { root: string, from: string, to: string }[] }} state is the same object when nothing changed; resets and moved
 *   are for the log
 */
function resetOnDone(state, sessions) {
  let s = null;
  const resets = [];
  const moved = [];
  const list = (Array.isArray(sessions) ? sessions : []).filter((x) => x && x.provider === 'claude' && typeof x.id === 'string');
  const entry = (root) => {
    const lineages = objOf((s || state || {}).lineages);
    return own(lineages, root) ? lineages[root] : null;
  };
  for (const x of list) {
    const root = rootOf(state, x.id);
    const L = entry(root);
    if (!L || !fin(L.lastMs) || !L.head || isHead(L.head, x.id) || !fin(x.lastPromptMs)) continue;
    if (x.lastPromptMs <= L.lastMs || (fin(L.headMs) && x.lastPromptMs <= L.headMs)) continue;
    if (!s) s = copyState(state);
    moved.push({ root, from: L.head, to: x.id });
    s.lineages[root] = { ...L, head: x.id, headMs: x.lastPromptMs };
  }
  for (const x of list) {
    const root = rootOf(state, x.id);
    const L = entry(root);
    if (!L || !fin(L.lastMs) || !fin(x.lastRealTurnMs) || x.lastRealTurnMs <= L.lastMs) continue;
    if (L.head && !isHead(L.head, x.id)) continue;
    const cur = s || state;
    const bt = objOf(objOf(cur.brake).times);
    const times = L.project && !fin(L.headMs) && own(bt, L.project) && Array.isArray(bt[L.project]) ? bt[L.project] : [];
    if (times.length) {
      const mine = objOf(objOf(cur.cap).lineages);
      const left = withoutTimes(times, [...new Set([...(own(mine, root) ? mine[root] : []), L.lastMs])]);
      if (left.length < times.length) {
        if (!s) s = copyState(state);
        if (left.length) s.brake.times[L.project] = left;
        else {
          delete s.brake.times[L.project];
          delete s.brake.tripped[L.project];
        }
      }
    }
    if (!(L.attempts > 0)) continue;
    if (!s) s = copyState(state);
    s.lineages[root] = { ...L, attempts: 0 };
    resets.push({ root, sessionId: x.id, attempts: L.attempts });
  }
  return { state: s || state, changed: !!s, resets, moved };
}

/** list without one occurrence of each time in drop */
function withoutTimes(list, drop) {
  const out = list.slice();
  for (const t of drop) {
    const i = out.indexOf(t);
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}

/** Drops what no longer matters (run or cancelled stops, lineages past the 24 h window, cap times past theirs) and bounds the rest */
function pruneState(state, now) {
  const s = copyState(state);
  if (fin(now)) {
    // an hour of slack past the 24 h window; entries of unknown time (0) go first when the bound is reached
    const old = (ms) => fin(ms) && ms > 0 && now - ms > CUTOFF_MS + 3600e3;
    // A count, or a trip, holds the stops of the 24 h after it until they are 24 h old themselves
    const held = (ms) => fin(ms) && ms > 0 && now - ms > 2 * CUTOFF_MS + 3600e3;
    for (const k of ['executed', 'cancelled']) for (const [id, ms] of Object.entries(s[k])) if (old(ms)) delete s[k][id];
    // A count back at 0 keeps its entry: lastMs still tells a held stop from a new one, the head who is being resumed
    for (const [id, L] of Object.entries(s.lineages)) {
      if ((L.attempts > 0 ? held : old)(L.lastMs) || (!L.attempts && !fin(L.lastMs))) delete s.lineages[id];
    }
    for (const [m, w] of [[s.cap.lineages, BRAKE_WINDOW_MS], [s.cap.projects, CAP_WINDOW_MS]]) {
      for (const [k, list] of Object.entries(m)) {
        const recent = capRecent(list, now, w);
        if (recent.length) m[k] = recent; else delete m[k];
      }
    }
    for (const [k, list] of Object.entries(s.brake.times)) {
      const recent = capRecent(list, now, BRAKE_WINDOW_MS);
      if (recent.length) s.brake.times[k] = recent; else delete s.brake.times[k];
    }
    for (const [k, ms] of Object.entries(s.brake.tripped)) if (held(ms)) delete s.brake.tripped[k];
    if (old(s.lostBefore)) delete s.lostBefore;
  }
  return bound(s);
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/**
 * The ids of the first records of a transcript's beginning (complete lines only): a --bg copy opens with its parent's
 * records, ids included, so two transcripts opening alike are a fork and its parent. '' when no id is there yet.
 * @param {string} text
 * @returns {string}
 */
function openingOf(text) {
  const out = [];
  for (const line of String(text || '').split('\n').slice(0, -1)) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r && typeof r.uuid === 'string' && r.uuid) out.push(r.uuid);
    if (out.length >= OPENING_UUIDS) break;
  }
  return out.join(',');
}

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
 * @param {'resumed'|'copied'|'failed'|'gaveUp'|'parallel'} outcome
 * @param {{ error?: string|null, copySessionId?: string|null, atMs?: number, manual?: boolean, attempt?: number,
 *   via?: 'message'|'prefill'|null, brake?: boolean }} [o] via: only for resumed; brake: the project's brake, not the count
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
    via: outcome === 'resumed' && VIAS.includes(o.via) ? o.via : null,
    ...(o.brake === true ? { brake: true } : {}),
  };
}

module.exports = {
  DEFAULTS, LIMITS, PROJECTS_KEY, STATE_VERSION, CUTOFF_MS, ASAP_MS, LIMIT_PAD_MS, SWITCH_PAD_MS, SWITCH_BEFORE_MS, FAST_FAIL_MS,
  CAP_WINDOW_MS, PROJECT_CAP, BRAKE_WINDOW_MS, FUTURE_SLACK_MS, HOLDS, PROMPT_MAX,
  EXECUTED_MAX, CANCELLED_MAX, ALIASES_MAX, LINEAGES_MAX,
  PLAN_STATES, UNAVAILABLE, ERRORS, OUTCOMES, VIAS,
  fin, has,
  normalizeSettings, projectOf, sameDir, projectName,
  stopIdOf, stopOf, claudeContinuesItself, planIdOf, planFor, whyDropped, switchCheck, switchResumeAt, capHold, brakeLimit, brakeTripped,
  emptyState, normalizeState, mergeStates, rootOf, lineageOf, lineageWork, workMs, recordAttempt, markExecuted, addCancelled, recordCopy,
  resetOnDone, pruneState, clearBrake, markLost, openingOf,
  cleanPrompt, buildArgs, parseOutput, failureOf, trustCommand, makeOutcome,
};
