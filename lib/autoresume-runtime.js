'use strict';
// Auto-resume at run time (docs/DESIGN.md §12.4, §12.6). No vscode: extension.js injects everything (deps below).
// - update({ sessions, now }) after every snapshot, with all sessions (not this window's scope). Plans are computed in
//   every window (so every panel can show them); one timer is armed for the earliest scheduled plan.
// - When it fires, the plan is checked again on the latest snapshot and a fresh read of the state file: the session is
//   still there with the same stopId, not cancelled, not already run, its project still on, the stop not older than
//   24 h, and the plan still scheduled for the same attempt (not self). Anything else → skipped, only logged. Then
//   notify.claimOnce(<shared claim dir>, 'autoresume|' + stopId + '|' + attempt): only the window that wins runs it.
// - The attempt goes into <globalStorage>/autoresume.json (tmp file + rename) before anything starts, so a crash never
//   retries forever. The file also holds the lineages (copies counted under their original), the stops already run and
//   the cancelled ones; it is shared by the windows of this app, and every write re-reads it first.
// - Running: the CLI from findCli (a Windows .cmd / .bat shim is refused: it needs a shell), `--bg` support checked once
//   per CLI path + mtime with `<cli> --help` (15 s), cwd must be an existing folder, then
//   spawn(cli, ['--bg', '--resume', id, prompt], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false }), 60 s at most.
//   Exit 0 printing another job id than the chat's ("backgrounded · <Y>", or the note "started a copy as <Y>") → copied
//   (Y joins the lineage), exit 0 otherwise → resumed; a non-zero exit → failed/untrusted when Claude Code refused a folder
//   it doesn't trust yet, else failed/exit (first output line, redacted, to the log); no exit in 60 s → failed/timeout;
//   could not start → failed/spawn. Every result goes to onOutcome listeners; gaveUp once, when a fresh stop arrives with
//   the attempts used up.
// - The same checks run when a plan first appears (plan.unavailable: cliNotFound / cliTooOld / noCwd), so the panel can
//   say it will fail before it does.
// - resumeNow(key): the manual "continue in the background now" for a stopped Claude chat (apiError, quota,
//   interrupted, stale): no project needed, never counts as an auto attempt (the stop is marked run, so no auto plan
//   follows it), same execution path, claim id 'autoresume-now|' + stopId ('|' + n after n failed tries of that stop).
//   Its outcome is returned, not sent to onOutcome.
// - Account switch (deps.account, optional; lib/accountswitch.js reads cswap): while a usage-limit plan waits for the
//   reset (or has no reset time), deps.account() is asked at most every ACCOUNT_POLL_MS; its answer goes into planFor,
//   which moves the plan to shortly after the switch when the account in use has room.
// - In the original window first (§12.8, lib/inwindow.js; deps.claudeHome given and deps.inWindow() not false): a chat
//   still open in a live Claude Code process is sent a message there (a `claude -p` helper calls ListAgents and
//   SendMessage), checked right before the send (one idle registry entry with a unique name, its pid not reused) and
//   after it (the marker line in the chat's own transcript; anywhere else → failed/misdelivered, never retried). A busy
//   chat is never interrupted: the plan waits BUSY_RETRY_MS and is checked again, at most BUSY_TRIES times, before the
//   claim. Not sendable: a VS Code chat open in this window gets the text in its input (deps.prefill) and the user has
//   WAIT_PROMPT_MS to send it; a send that could not be verified waits the same way; then, or when the chat is not
//   open anywhere, `--bg --resume` as before. Delivered → resumed with via 'message' or 'prefill'.
// - Guards (0.11.1, lib/core/autoresume.js): the spend-limit and refused-account rules, the fast-fail breaker, the hard cap
//   and the brake are all decided from the shared state file and the stop, in planFor, so what one window recorded binds
//   the others on their next look, and the fresh account question before a send can only say no. A plan held or dropped by
//   them logs why, once per stop and reason across windows. A reset of the attempt count logs one line. resumeNow() is
//   never held, and clears the brake of its project.
// - The count must be shared, or each window counts alone (0.11.1): an auto resume whose state write or claim cannot be made
//   does not run, says so once (a notice, the log, and plan.held 'unwritable' on the panel), and is tried again every
//   WRITE_RETRY_MS. A claim won whose count then cannot be written is not run either, and not used up: memory forgets the
//   attempt and this window tries again under a fresh claim id (the others lost the plain one). While the last write failed
//   the window keeps reading the file and merges it into memory (core.mergeStates), so what other windows recorded, a
//   Cancel above all, still counts; memory goes to the file with the next write that works. A write failure is logged once
//   per streak. Without file locking two windows writing within the
//   same millisecond or two can lose one's update, for different stops only (the per-stop claim covers one stop): at worst
//   one extra resume, or one copy's alias and so its count, with the project cap and the brake as the bound. Accepted.
// - A state file found unparsable at startup, or missing though one was written in the last day (a marker in the claim dir),
//   is set aside: state.lostBefore holds the stops before that moment, as what ran before is not known, in all windows, with
//   one warning (deps.warn). A read or stat error (a lock, access) is not a lost file: it is looked at again next time, and
//   nothing is written over it before it was read once. A window that loses the file while running just writes its memory
//   back. A clock set back (update's now earlier than its last by more than a minute) re-normalizes memory, so a time it
//   recorded in the future does not hide or hold the next stops.
// - A window on a version without the hard cap drops state.cap and state.brake whenever it writes. A window that finds them
//   gone puts them back and warns once: that window's own resumes are not held, so it has to be reloaded.
// - A resume that printed no copy id, failed or timed out may still have started a copy: a new session in the same folder
//   opening with the same record ids (core.openingOf) joins the lineage, for RECOVER_MS.
// - The user back in a chat while a copy resumed from it runs: one log line and a 'parallel' outcome, across windows.
// - Nothing thrown out of update(), cancel() or a timer: problems go to the log.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const core = require('./core/autoresume');
const notify = require('./notify');
const inwindowLib = require('./inwindow');
const inwindowCore = require('./core/inwindow');
const { isRunningCode } = require('./core/status');

const HELP_TIMEOUT_MS = 15e3;
const RUN_TIMEOUT_MS = 60e3;
const KILL_GRACE_MS = 3000;          // SIGKILL this long after SIGTERM
const CLOSE_GRACE_MS = 1000;         // after 'exit', wait this long for the pipes (a background child may keep them open)
const OUTPUT_MAX = 256 * 1024;       // bytes kept per stream
const LOG_LINE_MAX = 300;
const CLAUDE_SETTINGS_TTL_MS = 60e3; // the user's Claude settings are read at most once a minute
const GAVE_UP_FRESH_MS = 15 * 60e3;  // gaveUp is announced only for a stop this recent (not for old ones after a restart)
const TIMER_MAX_MS = 3600e3;         // the timer re-arms at least hourly (clock changes, sleep)
const DUE_SLACK_MS = 1000;
const MEMO_MAX = 1000;
const ACCOUNT_POLL_MS = 30e3;        // deps.account() at most this often, only while a limit plan waits
const BUSY_RETRY_MS = 30e3;          // a chat busy in its window: the plan is checked again this much later …
const BUSY_TRIES = 10;               // … at most this many times, then skipped (the chat is running again)
const WRITE_RETRY_MS = 30e3;         // the state file or a claim cannot be written: the plan, and the write, again this much later
const RECOVER_MS = 5 * 60e3;         // after a resume without a copy id, a new session can still be recognized as its copy this long
const OPENING_BYTES = 64 * 1024;     // read from a transcript's start to compare openings
const KNOWN_MARK = 'autoresume-state-known'; // claim-dir marker (24 h), per file: this state file was written lately
const MANUAL_CODES = new Set(['apiError', 'quota', 'interrupted', 'stale']);
// English resume.prompt.claude, used only when deps.prompt() gives nothing usable
const DEFAULT_PROMPT = "Continue the task you were working on before you were interrupted. Pick up from the last completed step and don't redo finished work.";
// Dictionary keys, spelled out so every key the code uses can be found in the source
const TRIGGER_KEY = Object.freeze({
  error: 'autoresume.trigger.error', limit: 'autoresume.trigger.limit', switch: 'autoresume.trigger.switch',
});
const SKIP_KEY = Object.freeze({
  changed: 'autoresume.skip.changed', off: 'autoresume.skip.off', claimed: 'autoresume.skip.claimed',
  cancelled: 'autoresume.skip.cancelled', late: 'autoresume.skip.late', busy: 'autoresume.skip.busy',
});
const ERROR_KEY = Object.freeze({
  cliNotFound: 'autoresume.error.cliNotFound', cliTooOld: 'autoresume.error.cliTooOld', noCwd: 'autoresume.error.noCwd',
  untrusted: 'autoresume.error.untrusted', exit: 'autoresume.error.exit', timeout: 'autoresume.error.timeout', spawn: 'autoresume.error.spawn',
  misdelivered: 'autoresume.error.misdelivered', busy: 'autoresume.error.busy',
});
const DROPPED_KEY = Object.freeze({
  older: 'autoresume.log.dropped.older', active: 'autoresume.log.dropped.active', lost: 'autoresume.log.dropped.lost',
});
const HELD_KEY = Object.freeze({
  spend: 'autoresume.log.held.spend', refused: 'autoresume.log.held.refused', fastFail: 'autoresume.log.held.fastFail',
  lineageCap: 'autoresume.log.held.lineageCap', projectCap: 'autoresume.log.held.projectCap',
});
const STOP_TRIGGER = Object.freeze({ quota: 'limit', apiError: 'error' });
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;

const msg = (e) => String((e && e.message) || e);

/** A Set that forgets its oldest entries past max */
function memo(max) {
  const set = new Set();
  return {
    has: (k) => set.has(k),
    delete: (k) => set.delete(k),
    add(k) {
      set.delete(k);
      set.add(k);
      while (set.size > max) set.delete(set.values().next().value);
    },
  };
}

function defaultT(key, vars) {
  return vars && typeof vars === 'object' && Object.keys(vars).length ? `${key} ${JSON.stringify(vars)}` : key;
}

function defaultFmtTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** lib/push.js redact() (token shapes) plus API keys; never throws */
function defaultRedact(text) {
  let s = String(text == null ? '' : text);
  try { s = require('./push').redact(s); } catch { /* keep the text; the patterns below still apply */ }
  return s
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1***');
}

/**
 * @param {{
 *   store: { get(key: string): any, update(key: string, value: any): any },
 *   stateFile: () => string, claimDir: () => string,
 *   findCli?: () => ({ path: string } | { error: string }), needsShell?: (cli: string) => boolean,
 *   spawn?: typeof cp.spawn, fs?: typeof fs, now?: () => number,
 *   setTimeout?: (fn: Function, ms: number) => any, clearTimeout?: (id: any) => void,
 *   claudeSettingsPath?: () => string|null, prompt?: () => string, settings?: () => any,
 *   log?: (line: string) => void, t?: (key: string, vars?: any) => string, warn?: (text: string) => void,
 *   claimOnce?: typeof notify.claimOnce, platform?: string, redact?: (s: string) => string, fmtTime?: (ms: number) => string,
 *   account?: () => Promise<{ switchedAtMs: number|null, hasRoom: boolean, label?: string }|null>,
 *   claudeHome?: () => string|null, projectsDir?: () => string|null, storageDir?: () => string|null,
 *   inWindow?: () => boolean, prefill?: (o: { sessionId: string, text: string, projectName: string|null }) => Promise<boolean>,
 *   randomBytes?: (n: number) => Buffer, isAlive?: (pid: number) => boolean, hostPid?: number,
 *   processChain?: (pid: number) => Promise<number[]>
 * }} deps
 */
function createAutoResumeRuntime(deps = {}) {
  const fsx = deps.fs || fs;
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const spawnFn = deps.spawn || ((cmd, args, opts) => cp.spawn(cmd, args, opts));
  const claimFn = deps.claimOnce || notify.claimOnce;
  const platform = deps.platform || process.platform;
  const pathOpts = { platform };
  const tr = typeof deps.t === 'function' ? deps.t : defaultT;
  const redact = typeof deps.redact === 'function' ? deps.redact : defaultRedact;
  const fmtTime = typeof deps.fmtTime === 'function' ? deps.fmtTime : defaultFmtTime;
  const findCliFn = typeof deps.findCli === 'function' ? deps.findCli : () => require('./compact').findCli({});
  const needsShellFn = typeof deps.needsShell === 'function' ? deps.needsShell : (p) => require('./compact').needsShell(p);

  let disposed = false;
  let sessions = new Map();      // key → session, latest snapshot
  let plans = new Map();         // key → Plan
  let state = core.emptyState(); // last read or written autoresume.json
  let stateSig = null;
  let unsaved = false;           // the last write failed: memory is ahead of the file, and they are merged on every read
  let loaded = false;            // the state file was looked at once (startup is when a lost file matters)
  let capSeen = false;           // this file has had a hard cap section: without one now, a window of an older version wrote it
  let lastWriteTry = null;       // when the last write was tried, while unsaved
  let ioTroubleSeen = false;     // a read or stat error of the state file was logged (once per streak)
  let lastNow = null;            // update()'s last now: a clock set back re-normalizes memory (times now in the future)
  let timer = null;
  let timerAt = null;
  let claudeCfg = null;
  let claudeCfgAt = 0;
  const listeners = [];
  const running = new Map();     // key → { stopId, manual }
  const handled = memo(MEMO_MAX);   // plan ids fired in this window (claim lost, skipped for good, or run)
  const announced = memo(MEMO_MAX); // plan ids logged as planned and pre-checked
  const gaveUpSeen = memo(MEMO_MAX);
  const heldSeen = memo(MEMO_MAX);  // stop id + reason, logged
  const droppedSeen = memo(MEMO_MAX); // stop id, logged
  const warnedOnce = new Set();     // one-time notes of this window: 'unwritable', 'claim', 'oldWindow'
  const suspects = new Map();       // session id → { root, atMs, known: Set, seen: Set, opening, transcript, cwd }: a resume with no copy id
  const checks = new Map();      // key → the last check's unavailable value for that session
  const bgCache = new Map();     // `${cli}|${mtimeMs}` → --bg supported
  const bgPending = new Map();
  const manualTries = new Map(); // stopId → failed manual tries
  const inflight = new Map();    // key → Promise of a manual run
  const deferred = new Map();    // plan id → { until, tries }: the chat was busy in its window (§12.8)
  const asking = new Set();      // plan ids whose account is being asked right before the send
  const writeTries = new Map();  // plan id → claims won whose count could not be written (the next claim is a fresh one)
  let inwin = null;              // lib/inwindow.js, made on first use
  let account = null;            // deps.account()'s last answer
  let accountAt = null;          // when it was asked last
  let accountPending = false;

  const nowMs = () => {
    try {
      const n = deps.now ? deps.now() : Date.now();
      return Number.isFinite(n) ? n : Date.now();
    } catch {
      return Date.now();
    }
  };
  function log(line) {
    try { if (typeof deps.log === 'function') deps.log(String(line)); } catch { /* logging never throws */ }
  }
  function t(key, vars) {
    try {
      const s = tr(key, vars);
      return typeof s === 'string' ? s : String(s);
    } catch {
      return key;
    }
  }
  function later(fn, ms) {
    const id = setT(fn, ms);
    if (id && typeof id.unref === 'function') id.unref();
    return id;
  }

  // -------------------------------------------------------------------------
  // Inputs: state file, settings, projects, Claude settings
  // -------------------------------------------------------------------------

  function stateFile() {
    try {
      const f = deps.stateFile ? deps.stateFile() : null;
      return typeof f === 'string' && f ? f : null;
    } catch {
      return null;
    }
  }
  const sigOf = (st) => `${st.ino}|${st.mtimeMs}|${st.ctimeMs}|${st.size}`;

  function warnUser(text) {
    log(text);
    try { if (typeof deps.warn === 'function') deps.warn(text); } catch { /* a warning never throws */ }
  }

  function claimDirNow() {
    try { return deps.claimDir ? deps.claimDir() : null; } catch { return null; }
  }

  /** The state file is gone or broken at startup: stops older than now are held in all windows, one warning */
  function stateLost(now) {
    state = core.markLost(state, now);
    if (claim(`autoresume-state-lost|${Math.floor(now / 60e3)}`, now)) warnUser(t('autoresume.warn.stateLost'));
    mutateState((st) => core.markLost(st, now), now);
  }

  /** Read and clean; a file without the cap section that had one: a window of an older version wrote it */
  function adopt(raw, now) {
    const read = core.normalizeState(raw, now);
    const hasCap = !!raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'cap');
    if (hasCap) capSeen = true;
    if (hasCap || !capSeen) return read;
    if (!warnedOnce.has('oldWindow')) {
      warnedOnce.add('oldWindow');
      warnUser(t('autoresume.warn.oldWindow'));
    }
    return { ...core.mergeStates(read, { ...core.emptyState(), cap: state.cap, brake: state.brake, lostBefore: state.lostBefore }), lineages: withHeads(read.lineages) };
  }

  /** An older window keeps only attempts and lastMs per lineage: the rest comes back from memory */
  function withHeads(lineages) {
    const out = {};
    for (const [id, L] of Object.entries(lineages)) {
      const M = state.lineages[id];
      out[id] = M && M.lastMs === L.lastMs ? { ...M, attempts: L.attempts } : L;
    }
    return out;
  }

  /**
   * Re-reads the state file when it changed (always with force). No file or a broken one → what we have in memory stays,
   * unless this is the window's first look (stateLost). After a failed write the file is merged in, not taken over.
   */
  function refreshState(force) {
    const file = stateFile();
    if (!file) return state;
    let sig;
    try {
      sig = sigOf(fsx.statSync(file));
    } catch (e) {
      // Only a file that is not there is missing; any other error (a lock, access) is asked again on the next look
      if (!e || e.code !== 'ENOENT') { ioTrouble(file, e); return state; }
      sig = 'none';
    }
    if (!force && sig === stateSig) return state;
    const first = !loaded;
    const now = nowMs();
    if (sig === 'none') {
      loaded = true;
      stateSig = sig;
      if (first && notify.claimExists(claimDirNow(), `${KNOWN_MARK}|${file}`, fsx)) stateLost(now);
      return state;
    }
    let text;
    try {
      text = String(fsx.readFileSync(file, 'utf8'));
    } catch (e) {
      // Not read (a lock of another program, a rename by another window): not lost, read again next time
      ioTrouble(file, e);
      return state;
    }
    loaded = true;
    stateSig = sig;
    ioTroubleSeen = false;
    try {
      const raw = JSON.parse(text);
      state = unsaved ? core.mergeStates(state, core.normalizeState(raw, now)) : adopt(raw, now);
    } catch (e) {
      log(`autoresume: ${path.basename(file)} unreadable (${msg(e)}), keeping the last state`);
      if (first) {
        try { fsx.renameSync(file, `${file}.unreadable-${now}`); } catch { /* another window has just done it */ }
        stateLost(now);
      }
    }
    return state;
  }

  /** The state file could not be looked at for now: logged once per streak, the file is looked at again next time */
  function ioTrouble(file, e) {
    stateSig = null;
    if (ioTroubleSeen) return;
    ioTroubleSeen = true;
    log(`autoresume: could not read ${path.basename(file)} (${msg(e)}); trying again`);
  }

  /** Read (fresh) → change → write atomically. The change is kept in memory even when the write fails. */
  function mutateState(fn, now) {
    refreshState(true);
    let next;
    try {
      next = core.pruneState(fn(state), now);
    } catch (e) {
      log(`autoresume: state update failed: ${msg(e)}`);
      return state;
    }
    state = next;
    const file = stateFile();
    if (!file) return state;
    if (!loaded) {
      // The file is there but could not be read yet: memory written over it would lose what it holds. Merged in on the
      // next read that works, as after a failed write
      unsaved = true;
      lastWriteTry = now;
      return state;
    }
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      try { fsx.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* the write reports it */ }
      fsx.writeFileSync(tmp, JSON.stringify(next));
      fsx.renameSync(tmp, file);
      unsaved = false;
      capSeen = true;
      try { stateSig = sigOf(fsx.statSync(file)); } catch { stateSig = null; }
      try { claimFn(claimDirNow(), `${KNOWN_MARK}|${file}`, now, fsx); } catch { /* only for telling a lost file from a new one */ }
    } catch (e) {
      try { fsx.unlinkSync(tmp); } catch { /* not there */ }
      if (!unsaved) log(`autoresume: could not write ${path.basename(file)}: ${msg(e)}`); // once per streak of failures
      unsaved = true;
      lastWriteTry = now;
    }
    return state;
  }

  function readSettings() {
    try { return core.normalizeSettings(deps.settings ? deps.settings() : {}); } catch { return core.normalizeSettings({}); }
  }

  function projectList() {
    let raw;
    try { raw = deps.store && typeof deps.store.get === 'function' ? deps.store.get(core.PROJECTS_KEY) : null; } catch { raw = null; }
    const out = [];
    for (const p of Array.isArray(raw) ? raw : []) {
      if (typeof p === 'string' && p.trim() && !out.some((q) => core.sameDir(q, p, pathOpts))) out.push(p);
    }
    return out;
  }

  /** Only autoContinueAtUsageLimit is kept; missing or broken file → {} */
  function claudeSettings(now) {
    if (claudeCfg && now >= claudeCfgAt && now - claudeCfgAt < CLAUDE_SETTINGS_TTL_MS) return claudeCfg;
    let v = {};
    try {
      const p = deps.claudeSettingsPath ? deps.claudeSettingsPath() : null;
      if (typeof p === 'string' && p) {
        const j = JSON.parse(String(fsx.readFileSync(p, 'utf8')));
        if (j && typeof j === 'object' && !Array.isArray(j) && Object.prototype.hasOwnProperty.call(j, 'autoContinueAtUsageLimit')) {
          v = { autoContinueAtUsageLimit: j.autoContinueAtUsageLimit };
        }
      }
    } catch {
      v = {};
    }
    claudeCfg = v;
    claudeCfgAt = now;
    return v;
  }

  function planOptions(now) {
    return {
      settings: readSettings(), projects: projectList(), claudeSettings: claudeSettings(now), now,
      cancelled: state.cancelled, executed: state.executed, platform, account, cap: state.cap, brake: state.brake,
      lostBefore: state.lostBefore,
    };
  }

  const snapshotList = () => [...sessions.values()];

  /** The lineage's count as it stands for this session's stop (core.lineageOf at the stop's time; now without a stop) */
  function lineageFor(s, now) {
    const stop = core.stopOf(s);
    return core.lineageOf(state, s.id, stop ? Math.min(stop.sinceMs, now) : now);
  }

  // -------------------------------------------------------------------------
  // Plans and the timer
  // -------------------------------------------------------------------------

  function computePlans(now) {
    const o = planOptions(now);
    const next = new Map();
    const work = core.lineageWork(state, snapshotList());
    for (const [key, s] of sessions) {
      try {
        if (!s || s.provider !== 'claude') continue;
        const prev = plans.get(key) || null;
        if (running.has(key)) {
          if (prev) next.set(key, { ...prev, state: 'running' });
          continue;
        }
        const lineage = lineageFor(s, now);
        const opts = { ...o, prev, otherWorkMs: work(s.id) };
        const plan = core.planFor(s, lineage, opts);
        if (!plan) {
          logDropped(s, core.whyDropped(s, lineage, opts), now);
          continue;
        }
        if (plan.state === 'scheduled') {
          if (handled.has(core.planIdOf(plan))) continue;
          plan.unavailable = checks.has(key) ? checks.get(key) : null;
          // Refused for now because the count or the claim could not be written: the panel says so, not just a past time
          if (!plan.held && (warnedOnce.has('unwritable') || warnedOnce.has('claim'))) plan.held = 'unwritable';
        }
        next.set(key, plan);
      } catch (e) {
        log(`autoresume: plan for ${key} failed: ${msg(e)}`);
      }
    }
    plans = next;
    for (const k of [...checks.keys()]) if (!plans.has(k)) checks.delete(k);
    if (deferred.size) {
      const ids = new Set([...plans.values()].map((p) => core.planIdOf(p)));
      for (const id of [...deferred.keys()]) if (!ids.has(id)) deferred.delete(id);
    }
    pollAccount(now);
  }

  /** A real stop that gets no plan says why, once across windows */
  function logDropped(s, why, now) {
    if (!why || !DROPPED_KEY[why]) return;
    const stopId = core.stopIdOf(s);
    if (droppedSeen.has(stopId)) return;
    droppedSeen.add(stopId);
    if (!claim(`autoresume-dropped|${stopId}`, now)) return;
    log(t(DROPPED_KEY[why], { project: core.projectName(projectFor(s)) || '', session: s.id }));
  }

  /** A usage-limit plan waits for its reset (not yet moved up by a switch): the account switcher is worth asking */
  function waitingOnLimit() {
    if (typeof deps.account !== 'function') return false;
    for (const p of plans.values()) {
      if (p.trigger === 'limit' && p.via !== 'switch' && (p.state === 'scheduled' || p.state === 'noReset')) return true;
    }
    return false;
  }

  function pollAccount(now) {
    if (accountPending || disposed || !waitingOnLimit()) return;
    if (accountAt !== null && now >= accountAt && now - accountAt < ACCOUNT_POLL_MS) return;
    accountPending = true;
    accountAt = now;
    let p;
    try { p = Promise.resolve(deps.account()); } catch (e) { p = Promise.reject(e); }
    p.then((v) => {
      account = v && typeof v === 'object' ? v : null;
    }, (e) => {
      account = null;
      log(`autoresume: account: ${msg(e)}`);
    }).then(() => {
      accountPending = false;
      recompute();
    });
  }

  /** New scheduled plans: log and pre-check. New gaveUp stops: one Outcome across windows. */
  function announce(now) {
    for (const [key, p] of plans) {
      try {
        logHeld(p, now);
        if (p.state === 'scheduled') {
          const id = core.planIdOf(p);
          const seen = p.via ? `${id}|${p.via}` : id; // moved up by an account switch: logged again
          if (announced.has(seen)) continue;
          announced.add(seen);
          const trigger = p.via === 'switch' ? t(TRIGGER_KEY.switch, { account: p.account || '' }) : t(TRIGGER_KEY[p.trigger] || TRIGGER_KEY.error);
          log(t('autoresume.log.planned', {
            project: p.projectName, session: p.sessionId, trigger,
            time: fmtTime(p.atMs), n: p.attempt, max: p.max,
          }));
          precheck(key, id);
        } else if (p.state === 'gaveUp' && p.held === 'brake') {
          // Once per project and trip, however many of its chats stop
          const trip = `${p.project}|${state.brake.tripped[p.project]}`;
          if (gaveUpSeen.has(trip)) continue;
          gaveUpSeen.add(trip);
          if (!claim(`autoresume-brake|${trip}`, now)) continue;
          log(t('autoresume.log.brake', { project: p.projectName, n: core.brakeLimit(p.max) }));
          emit(core.makeOutcome(p, 'gaveUp', { atMs: now, brake: true }));
        } else if (p.state === 'gaveUp') {
          if (gaveUpSeen.has(p.stopId)) continue;
          gaveUpSeen.add(p.stopId);
          const stop = core.stopOf(sessions.get(key));
          if (!stop || now - stop.sinceMs > GAVE_UP_FRESH_MS) continue;
          if (!claim(`autoresume-gaveup|${p.stopId}`, now)) continue;
          const out = core.makeOutcome(p, 'gaveUp', { atMs: now });
          logResult(out);
          emit(out);
        }
      } catch (e) {
        log(`autoresume: ${msg(e)}`);
      }
    }
  }

  /** Why a plan waits, once per stop and reason */
  function logHeld(p, now) {
    if (!p.held || !HELD_KEY[p.held] || (p.state !== 'scheduled' && p.state !== 'noReset')) return;
    const seen = `${p.stopId}|${p.held}`;
    if (heldSeen.has(seen)) return;
    heldSeen.add(seen);
    if (!claim(`autoresume-held|${seen}`, now)) return; // one line across windows
    const time = p.state === 'scheduled' && core.fin(p.atMs) ? fmtTime(p.atMs) : t('autoresume.log.held.noTime');
    log(t(HELD_KEY[p.held], { project: p.projectName, session: p.sessionId, account: (account && account.label) || '', time, now: fmtTime(now) }));
  }

  function arm() {
    if (disposed) return;
    try {
      let next = null;
      for (const p of plans.values()) {
        const at = dueAt(p);
        if (at !== null && (next === null || at < next)) next = at;
      }
      if (waitingOnLimit() && accountAt !== null) {
        const poll = accountAt + ACCOUNT_POLL_MS;
        if (next === null || poll < next) next = poll;
      }
      if (timer && next === timerAt) return;
      if (timer) clearT(timer);
      timer = null;
      timerAt = null;
      if (next === null) return;
      timerAt = next;
      timer = later(onTimer, Math.min(TIMER_MAX_MS, Math.max(0, next - nowMs())));
    } catch (e) {
      log(`autoresume: timer: ${msg(e)}`);
    }
  }

  function recompute() {
    if (disposed) return;
    try {
      const now = nowMs();
      computePlans(now);
      announce(now);
    } catch (e) {
      log(`autoresume: ${msg(e)}`);
    }
    arm();
  }

  function onTimer() {
    timer = null;
    timerAt = null;
    if (disposed) return;
    try {
      const now = nowMs();
      const due = [...plans.values()]
        .filter((p) => dueAt(p) !== null && dueAt(p) <= now + DUE_SLACK_MS)
        .sort((a, b) => dueAt(a) - dueAt(b));
      for (const p of due) runPlan(p, now).catch((e) => log(`autoresume: ${msg(e)}`));
      pollAccount(now);
    } catch (e) {
      log(`autoresume: ${msg(e)}`);
    }
    arm();
  }

  /** When a scheduled plan runs: its time, or later while its chat was busy in its window; null when not scheduled */
  function dueAt(p) {
    if (!p || p.state !== 'scheduled' || !core.fin(p.atMs)) return null;
    const id = core.planIdOf(p);
    // Fired already, or its account is being asked: not due again (a past time here would re-arm a 0 ms timer, a spin)
    if (handled.has(id) || asking.has(id)) return null;
    const d = deferred.get(id);
    return d && d.until > p.atMs ? d.until : p.atMs;
  }

  function claim(id, now) {
    try { return claimFn(claimDirNow(), id, now, fsx) !== false; } catch { return true; }
  }

  /** claim() that also says when the claim could not be written: true won, false lost, null could not tell */
  function claimStrict(id, now) {
    try {
      const r = claimFn(claimDirNow(), id, now, fsx, { strict: true });
      return r === null ? null : r !== false;
    } catch {
      return null;
    }
  }

  /** An auto resume refused for want of a shared write: logged once per streak, shown once per window (and on its plan) */
  function noteOnce(which, key) {
    if (warnedOnce.has(which)) return;
    warnedOnce.add(which);
    if (warnedOnce.has('toast|unwritable')) { log(t(key)); return; }
    warnedOnce.add('toast|unwritable');
    warnUser(t(key));
  }

  function logSkip(p, reason) {
    log(t('autoresume.log.skipped', { project: p.projectName, session: p.sessionId, reason: t(SKIP_KEY[reason] || SKIP_KEY.changed) }));
  }

  function logResult(o) {
    let text;
    if (o.outcome === 'copied') text = t('autoresume.outcome.copied', { copy: o.copySessionId, session: o.sessionId });
    else if (o.outcome === 'resumed' && o.via === 'message') text = t('autoresume.outcome.messaged');
    else if (o.outcome === 'resumed' && o.via === 'prefill') text = t('autoresume.outcome.prefilled');
    else if (o.outcome === 'failed') text = t('autoresume.outcome.failed', { reason: t(ERROR_KEY[o.error] || ERROR_KEY.spawn) });
    else if (o.outcome === 'gaveUp') text = t('autoresume.outcome.gaveUp', { max: o.max });
    else text = t('autoresume.outcome.resumed');
    log(t('autoresume.log.result', { project: o.projectName, session: o.sessionId, outcome: text }));
  }

  function emit(o) {
    for (const cb of listeners.slice()) {
      try { cb(o); } catch (e) { log(`autoresume: outcome listener: ${msg(e)}`); }
    }
  }

  /**
   * The check right before running (§12.3): null to go ahead, else { reason, retry } — retry: the same stop and attempt
   * are merely planned later now (a setting changed), so the plan may fire again at its new time.
   */
  function recheck(plan, now) {
    const s = sessions.get(plan.key);
    const stop = core.stopOf(s);
    if (!stop || stop.stopId !== plan.stopId) return { reason: 'changed' };
    if (core.has(state.cancelled, stop.stopId)) return { reason: 'cancelled' };
    if (core.has(state.executed, stop.stopId)) return { reason: 'claimed' };
    const o = planOptions(now);
    if (!core.projectOf(s.cwd, o.projects, pathOpts)) return { reason: 'off' };
    if (now - stop.sinceMs > core.CUTOFF_MS) return { reason: 'late' };
    const fresh = core.planFor(s, lineageFor(s, now), { ...o, prev: plan, otherWorkMs: core.lineageWork(state, snapshotList())(s.id) });
    if (!fresh || fresh.state !== 'scheduled' || fresh.attempt !== plan.attempt) return { reason: 'changed' };
    if (fresh.atMs > now + DUE_SLACK_MS) return { reason: 'changed', retry: true };
    return null;
  }

  /** A fresh deps.account() answer: true only when the account in use (after the switch) has room */
  async function roomNow() {
    if (typeof deps.account !== 'function') return false;
    try {
      const v = await deps.account();
      if (v && typeof v === 'object') account = v;
      return !!v && v.hasRoom === true && core.fin(v.switchedAtMs);
    } catch (e) {
      log(`autoresume: account: ${msg(e)}`);
      return false;
    }
  }

  async function runPlan(plan, now) {
    const id = core.planIdOf(plan);
    if (disposed || handled.has(id) || running.has(plan.key)) return;
    let owned = false;
    try {
      refreshState(true);
      const skip = recheck(plan, now);
      if (skip && skip.retry) {
        announced.delete(id); // planned again at its new time (logged as planned once more)
        return;
      }
      if (skip) {
        handled.add(id);
        logSkip(plan, skip.reason);
        return;
      }
      // A chat busy in its window is never interrupted: checked again later (not claimed, not counted), a few times
      if (isBusy(sessions.get(plan.key), plan.stopId)) {
        const d = deferred.get(id) || { until: 0, tries: 0 };
        if (d.tries >= BUSY_TRIES) {
          handled.add(id);
          deferred.delete(id);
          logSkip(plan, 'busy');
          return;
        }
        deferred.set(id, { until: now + BUSY_RETRY_MS, tries: d.tries + 1 });
        if (!d.tries) log(`autoresume: ${plan.projectName} (${plan.sessionId}): the chat is busy in its window; checking again in ${Math.round(BUSY_RETRY_MS / 1000)} s`);
        return;
      }
      // Moved up by an account switch: the account in use is asked once more right now and must still have room
      // (otherwise the plan goes back to the reset time on the next check; not claimed, not counted)
      if (plan.via === 'switch') {
        if (asking.has(id)) return;
        asking.add(id);
        let room = false;
        try { room = await roomNow(); } finally { asking.delete(id); }
        if (!room) {
          deferred.set(id, { until: nowMs() + ACCOUNT_POLL_MS, tries: (deferred.get(id) || { tries: 0 }).tries });
          announced.delete(id);
          log(`autoresume: ${plan.projectName} (${plan.sessionId}): the account in use has no room yet; waiting`);
          arm();
          return;
        }
      }
      if (disposed || handled.has(id)) return;
      // The account question took time: the chat may have moved on, been cancelled or left the snapshot meanwhile
      if (plan.via === 'switch') {
        const late = recheck(plan, nowMs());
        if (late && late.retry) { announced.delete(id); return; }
        if (late) { handled.add(id); logSkip(plan, late.reason); return; }
      }
      // Not counted anywhere others can see means not run: each window would count alone. Asked before the claim, so the
      // stop is not used up: tried again later
      mutateState((st) => st, now);
      const retryLater = (which, key) => {
        noteOnce(which, key);
        deferred.set(id, { until: nowMs() + WRITE_RETRY_MS, tries: (deferred.get(id) || { tries: 0 }).tries });
      };
      if (unsaved) {
        retryLater('unwritable', 'autoresume.log.unwritable');
        return;
      }
      // After a count that could not be written, this window tries again under a claim of its own (the plain one is used)
      const tries = writeTries.get(id) || 0;
      const won = claimStrict(`autoresume|${plan.stopId}|${plan.attempt}${tries ? `|w${tries}` : ''}`, now);
      if (won === null) {
        retryLater('claim', 'autoresume.log.unwritable');
        return;
      }
      deferred.delete(id);
      handled.add(id);
      warnedOnce.delete('unwritable');
      warnedOnce.delete('claim');
      if (!won) {
        logSkip(plan, 'claimed');
        return;
      }
      const session = sessions.get(plan.key);
      owned = true;
      running.set(plan.key, { stopId: plan.stopId, manual: false });
      plans.set(plan.key, { ...plan, state: 'running' });
      const started = nowMs(); // the account question may have taken seconds: the breaker measures from here
      const before = state;
      mutateState((st) => core.recordAttempt(st, session.id, plan.stopId, started, plan.project, plan.max), started);
      if (unsaved) {
        // Not counted where the others can see: not run, and not used up either. Memory forgets the attempt (the file never
        // had it), and this window tries the stop again later under a fresh claim; the others lost the plain one
        state = before;
        handled.delete(id);
        writeTries.set(id, tries + 1);
        if (writeTries.size > MEMO_MAX) writeTries.delete(writeTries.keys().next().value);
        retryLater('unwritable', 'autoresume.log.unwritable');
        return;
      }
      writeTries.delete(id);
      log(t('autoresume.log.started', { project: plan.projectName, session: plan.sessionId, n: plan.attempt, max: plan.max }));
      suspect(session, started);
      const res = await runResume(session, {
        trigger: plan.trigger, account: plan.via === 'switch' ? plan.account || null : null, projectName: plan.projectName,
      });
      if (res.cancelled || res.copySessionId || res.via) suspects.delete(session.id);
      if (res.cancelled) return; // cancel() logged it; no outcome, no copy
      const out = conclude(plan, session, res, false);
      if (!disposed) emit(out);
    } finally {
      if (owned) running.delete(plan.key);
      recompute();
    }
  }

  // -------------------------------------------------------------------------
  // Running the CLI
  // -------------------------------------------------------------------------

  function dirOk(p) {
    if (typeof p !== 'string' || !p || !path.isAbsolute(p)) return false;
    try { return fsx.statSync(p).isDirectory(); } catch { return false; }
  }

  function firstLine(text) {
    const whole = redact(String(text || '').replace(ANSI_RE, ''));
    const line = whole.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
    const a = Array.from(line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '));
    return redact(a.length > LOG_LINE_MAX ? `${a.slice(0, LOG_LINE_MAX - 1).join('')}…` : a.join(''));
  }

  /**
   * Starts a child without a shell and collects its output.
   * @returns {Promise<{ kind: 'exit'|'timeout'|'spawn', code: number|null, signal: string|null, stdout: string,
   *   stderr: string, error: string|null }>}
   */
  function runChild(cmd, args, o) {
    return new Promise((resolve) => {
      const opts = { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true };
      if (o.cwd) opts.cwd = o.cwd;
      if (o.env && typeof o.env === 'object') opts.env = { ...process.env, ...o.env }; // added to, never replacing, the env
      const base = { code: null, signal: null, stdout: '', stderr: '', error: null };
      let child;
      try {
        child = spawnFn(cmd, args, opts);
      } catch (e) {
        resolve({ ...base, kind: 'spawn', error: msg(e) });
        return;
      }
      if (!child || typeof child.on !== 'function') {
        resolve({ ...base, kind: 'spawn', error: 'no child process' });
        return;
      }
      const out = [];
      const err = [];
      let outLen = 0;
      let errLen = 0;
      let done = false;
      let exited = null;
      let grace = null;
      const text = (bufs) => Buffer.concat(bufs).toString('utf8');
      const finish = (r) => {
        if (done) return;
        done = true;
        clearT(timeout);
        if (grace) clearT(grace);
        for (const s of [child.stdout, child.stderr]) {
          try { if (s && typeof s.destroy === 'function') s.destroy(); } catch { /* closed */ }
        }
        resolve({ ...base, ...r, pid: Number.isInteger(child.pid) ? child.pid : null, stdout: text(out), stderr: text(err) });
      };
      const timeout = later(() => {
        if (done) return;
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        later(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, KILL_GRACE_MS);
        finish({ kind: 'timeout' });
      }, o.timeoutMs);
      const collect = (bufs, isOut) => (b) => {
        const x = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
        const len = isOut ? outLen : errLen;
        if (len >= OUTPUT_MAX) return;
        const part = x.length > OUTPUT_MAX - len ? x.subarray(0, OUTPUT_MAX - len) : x;
        bufs.push(part);
        if (isOut) outLen += part.length; else errLen += part.length;
      };
      try {
        if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', collect(out, true));
        if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', collect(err, false));
        child.on('error', (e) => finish({ kind: 'spawn', error: msg(e) }));
        child.on('exit', (code, signal) => {
          if (done || exited) return;
          exited = { code: code == null ? null : code, signal: signal || null };
          grace = later(() => finish({ kind: 'exit', ...exited }), CLOSE_GRACE_MS);
        });
        child.on('close', (code, signal) => finish({ kind: 'exit', ...(exited || { code: code == null ? null : code, signal: signal || null }) }));
      } catch (e) {
        finish({ kind: 'spawn', error: msg(e) });
      }
    });
  }

  /** Does this CLI know --bg? true / false, or null when --help could not tell (not cached then) */
  function bgSupport(cli) {
    let mtime = 'unknown';
    try { mtime = String(fsx.statSync(cli).mtimeMs); } catch { /* keyed by path only */ }
    const k = `${cli}|${mtime}`;
    if (bgCache.has(k)) return Promise.resolve(bgCache.get(k));
    if (bgPending.has(k)) return bgPending.get(k);
    const p = runChild(cli, ['--help'], { timeoutMs: HELP_TIMEOUT_MS }).then((r) => {
      bgPending.delete(k);
      let v = null;
      if (/(^|[^\w-])--bg(?![\w-])/m.test(`${r.stdout}\n${r.stderr}`)) v = true;
      else if (r.kind === 'exit' && r.code === 0) v = false;
      if (v === null) {
        log(`autoresume: ${path.basename(cli)} --help: ${r.kind}${r.code != null ? ` ${r.code}` : ''}${r.error ? ` ${firstLine(r.error)}` : ''}`);
      } else {
        bgCache.set(k, v);
        if (bgCache.size > 20) bgCache.delete(bgCache.keys().next().value);
      }
      return v;
    });
    bgPending.set(k, p);
    return p;
  }

  /** What stands in the way of running now: { error } or { cli } */
  async function availability(session) {
    let found;
    try { found = findCliFn(); } catch { found = null; }
    // compact.findCli reports a cliPath setting that isn't a program as { error: 'cliPath', path }: not found, never run
    if (!found || found.error || typeof found.path !== 'string' || !found.path) return { error: 'cliNotFound' };
    let shim = false;
    try { shim = !!needsShellFn(found.path); } catch { shim = false; }
    if (shim) return { error: 'cliNotFound', shim: found.path };
    if (!dirOk(session && session.cwd)) return { error: 'noCwd' };
    const bg = await bgSupport(found.path);
    if (bg === false) return { error: 'cliTooOld' };
    return { cli: found.path };
  }

  function precheck(key, id) {
    const s = sessions.get(key);
    if (!s) return;
    availability(s).then((a) => {
      if (disposed) return;
      const u = a.error && core.UNAVAILABLE.includes(a.error) ? a.error : null;
      checks.set(key, u);
      const p = plans.get(key);
      if (p && p.state === 'scheduled' && core.planIdOf(p) === id) p.unavailable = u;
    }).catch((e) => log(`autoresume: check failed: ${msg(e)}`));
  }

  // -------------------------------------------------------------------------
  // In the original window (§12.8)
  // -------------------------------------------------------------------------

  function inWindowOn() {
    if (typeof deps.claudeHome !== 'function') return false;
    try { return !deps.inWindow || deps.inWindow() !== false; } catch { return false; }
  }

  function inWindow() {
    if (!inwin) {
      inwin = inwindowLib.createInWindow({
        fs: fsx, platform, now: nowMs, sleep: (ms) => new Promise((r) => later(r, ms)),
        runChild, cli: () => findCliFn(), claudeHome: deps.claudeHome, projectsDir: deps.projectsDir, storageDir: deps.storageDir,
        randomBytes: deps.randomBytes, isAlive: deps.isAlive, hostPid: deps.hostPid, processChain: deps.processChain,
        firstLine, log,
      });
    }
    return inwin;
  }

  /** The stop was cancelled meanwhile, in this window or another (the shared state file is read again) */
  function cancelledNow(stopId) {
    try {
      refreshState(true);
      return core.has(state.cancelled, stopId);
    } catch {
      return false;
    }
  }

  /** The chat is busy (or waiting) in a live window right now, by a fresh read of the registry */
  function isBusy(session, stopId) {
    if (!session || !inWindowOn()) return false;
    try {
      const stop = core.stopOf(session);
      const r = inWindow().probe(session, stop && stop.stopId === stopId ? stop.sinceMs : null);
      return !r.ok && r.reason === 'busy';
    } catch (e) {
      log(`autoresume: in-window: ${msg(e)}`);
      return false;
    }
  }

  function userPrompt() {
    try { return deps.prompt ? deps.prompt() : ''; } catch { return ''; }
  }

  /**
   * The in-window path and its fallback chain. A result when it settled the resume, null when `--bg --resume` should
   * run (not open anywhere, not sendable and not prefilled here, or nobody sent the prefilled text in time).
   * @param {any} session
   * @param {{ trigger?: string|null, account?: string|null, projectName?: string|null }} ctx
   */
  async function inWindowResume(session, ctx) {
    const iw = inWindow();
    const stopId = core.stopIdOf(session);
    const stop = core.stopOf(session);
    const stopSinceMs = stop ? stop.sinceMs : (session.main && session.main.status && session.main.status.sinceMs) || null;
    const trigger = ctx.trigger || STOP_TRIGGER[session.main && session.main.status && session.main.status.code] || null;
    const prompt = userPrompt();
    const r = await iw.send(session, { trigger, account: ctx.account || null, prompt, stopSinceMs });
    const done = (via) => ({ outcome: 'resumed', error: null, copySessionId: null, via });
    const failed = (error) => ({ outcome: 'failed', error, copySessionId: null });
    const stillStopped = () => {
      const cur = sessions.get(session.key);
      return !cur || core.stopIdOf(cur) === stopId;
    };
    if (r.result === 'messaged') {
      log(`autoresume: in-window: delivered to the chat in its own window (${ctx.projectName || session.id})`);
      return done('message');
    }
    if (r.result === 'misdelivered') {
      log(`autoresume: in-window: MISDELIVERED: the message showed up in ${r.files.map((f) => path.basename(f)).join(', ')}; not retried`);
      return failed('misdelivered');
    }
    if (r.result === 'busy') return failed('busy');
    if (r.result === 'notOpen') return null;
    const entry = r.entry || null;
    const ownedHere = r.result === 'unsendable' && !!entry && entry.entrypoint === 'claude-vscode' && typeof deps.prefill === 'function'
      ? await iw.ownedHere(entry.pid) : false;
    const step = inwindowCore.fallbackStep({
      open: true, sent: r.result === 'unverified', vscodeEntry: !!entry && entry.entrypoint === 'claude-vscode',
      ownedHere, canPrefill: typeof deps.prefill === 'function',
    });
    if (r.result === 'unsendable') log(`autoresume: in-window: not sendable (${r.reason}); ${step === 'prefill' ? 'filling in the chat in this window' : 'continuing with claude --bg --resume'}`);
    if (step === 'bg') return null;
    let fromSize = r.result === 'unverified' && Number.isFinite(r.sizeBefore) ? r.sizeBefore : iw.sizeOf(session.transcript);
    let sinceMs = r.result === 'unverified' ? r.sentAtMs : nowMs();
    let via = 'message';
    if (step === 'prefill') {
      const nonce = (() => { try { return inwindowCore.makeNonce(deps.randomBytes || require('crypto').randomBytes); } catch { return null; } })();
      const m = nonce ? inwindowCore.buildMessage({ nonce, trigger, account: ctx.account || null, prompt }) : null;
      let ok = false;
      fromSize = iw.sizeOf(session.transcript);
      sinceMs = nowMs();
      try { ok = !!m && (await deps.prefill({ sessionId: session.id, text: m.text, projectName: ctx.projectName || null })) === true; } catch (e) {
        log(`autoresume: in-window: prefill failed: ${msg(e)}`);
      }
      if (!ok) return null;
      via = 'prefill';
    }
    const w = await iw.waitForPrompt(session, { fromSize, sinceMs, stillStopped, aborted: () => disposed || cancelledNow(stopId) });
    if (w === 'prompt' || w === 'movedOn') {
      log(`autoresume: in-window: the chat continued in its own window (${w === 'prompt' ? 'new message' : 'moved on'})`);
      return done(via);
    }
    if (w === 'aborted') return disposed ? failed('spawn') : { outcome: 'failed', error: null, copySessionId: null, cancelled: true };
    log(`autoresume: in-window: nothing sent in the chat within ${Math.round(inwindowLib.WAIT_PROMPT_MS / 60e3)} min; continuing with claude --bg --resume`);
    return null;
  }

  /**
   * @param {any} session
   * @param {{ trigger?: string|null, account?: string|null, projectName?: string|null }} [ctx]
   * @returns {Promise<{ outcome: 'resumed'|'copied'|'failed', error: string|null, copySessionId: string|null, via?: string|null }>}
   */
  async function runResume(session, ctx = {}) {
    if (inWindowOn() && session && session.provider === 'claude') {
      try {
        const r = await inWindowResume(session, ctx);
        if (r) return r;
      } catch (e) {
        log(`autoresume: in-window: ${msg(e)}`);
      }
      if (disposed) return { outcome: 'failed', error: 'spawn', copySessionId: null };
    }
    return runBg(session);
  }

  /** @returns {Promise<{ outcome: 'resumed'|'copied'|'failed', error: string|null, copySessionId: string|null }>} */
  async function runBg(session) {
    const fail = (error) => ({ outcome: 'failed', error, copySessionId: null });
    try {
      const a = await availability(session);
      if (a.error) {
        checks.set(session.key, a.error);
        if (a.shim) log(`autoresume: ${a.shim} needs a shell to start; not started`);
        return fail(a.error);
      }
      checks.set(session.key, null);
      const prompt = userPrompt();
      const args = core.buildArgs(session.id, prompt) || core.buildArgs(session.id, DEFAULT_PROMPT);
      if (!args) return fail('spawn');
      const r = await runChild(a.cli, args, { cwd: session.cwd, timeoutMs: RUN_TIMEOUT_MS });
      if (r.kind === 'spawn') {
        if (r.error) log(t('autoresume.log.output', { text: firstLine(r.error) }));
        return fail('spawn');
      }
      if (r.kind === 'timeout') return fail('timeout');
      if (r.code !== 0) {
        const line = firstLine(r.stderr) || firstLine(r.stdout);
        if (line) log(t('autoresume.log.output', { text: line }));
        return fail(core.failureOf(r.stdout, r.stderr));
      }
      const { copySessionId } = core.parseOutput(r.stdout, r.stderr, session.id);
      if (copySessionId && copySessionId !== session.id) return { outcome: 'copied', error: null, copySessionId };
      return { outcome: 'resumed', error: null, copySessionId: null };
    } catch (e) {
      log(`autoresume: ${msg(e)}`);
      return fail('spawn');
    }
  }

  /** Until told otherwise, this resume may start a copy nobody hears of: what a new session is compared with */
  function suspect(session, atMs) {
    const opening = openingOfFile(session.transcript);
    if (!opening) return;
    suspects.set(session.id, { atMs, opening, cwd: session.cwd, known: new Set(sessions.keys()), seen: new Set() });
  }

  function openingOfFile(file) {
    if (typeof file !== 'string' || !file) return '';
    let fd = null;
    try {
      fd = fsx.openSync(file, 'r');
      const b = Buffer.alloc(OPENING_BYTES);
      const n = fsx.readSync(fd, b, 0, OPENING_BYTES, 0);
      return core.openingOf(b.toString('utf8', 0, n));
    } catch {
      return '';
    } finally {
      if (fd !== null) { try { fsx.closeSync(fd); } catch { /* ignore */ } }
    }
  }

  /** A new session in the folder of a resume with no copy id, opening like the chat resumed: its copy after all */
  function recoverLineage(now) {
    for (const [parent, x] of [...suspects]) {
      if (now - x.atMs > RECOVER_MS || now < x.atMs) { suspects.delete(parent); continue; }
      for (const [key, c] of sessions) {
        if (x.known.has(key) || x.seen.has(key) || c.provider !== 'claude' || c.cwd !== x.cwd || c.id === parent) continue;
        const opening = openingOfFile(c.transcript);
        if (!opening) continue; // nothing to compare yet: the next snapshot
        x.seen.add(key);
        if (opening !== x.opening) continue;
        suspects.delete(parent);
        mutateState((st) => core.recordCopy(st, c.id, parent), now);
        log(t('autoresume.log.recovered', { copy: c.id, session: parent }));
        break;
      }
    }
  }

  /** The user went back to a chat while a copy resumed from it is still running: both are working now */
  function noteParallel(moved, now) {
    for (const m of moved) {
      const copy = snapshotList().find((x) => x.id === m.from || x.id.slice(0, 8).toLowerCase() === m.from);
      const code = copy && copy.main && copy.main.status && copy.main.status.code;
      if (!copy || !(isRunningCode(code) || copy.liveStatus === 'busy')) continue;
      if (!claim(`autoresume-parallel|${m.root}|${copy.id}|${state.lineages[m.root].headMs}`, now)) continue;
      const project = projectFor(copy);
      log(t('autoresume.log.parallel', { project: core.projectName(project) || '', copy: copy.id, session: m.to }));
      emit(core.makeOutcome({ key: copy.key, sessionId: copy.id, project, max: readSettings().maxAttempts }, 'parallel', { atMs: now }));
    }
  }

  function conclude(base, session, res, manual) {
    const now = nowMs();
    if (res.outcome === 'copied' && res.copySessionId) {
      mutateState((st) => core.recordCopy(st, res.copySessionId, session.id), now);
    }
    const out = core.makeOutcome(base, res.outcome, {
      error: res.error, copySessionId: res.copySessionId, atMs: now, manual, attempt: manual ? 0 : undefined, via: res.via || null,
    });
    logResult(out);
    return out;
  }

  // -------------------------------------------------------------------------
  // Interface
  // -------------------------------------------------------------------------

  function update(o) {
    if (disposed) return;
    try {
      const now = o && core.fin(o.now) ? o.now : nowMs();
      // The clock was set back: times this window recorded are in the future now, and would hold or hide stops
      if (lastNow !== null && now < lastNow - core.FUTURE_SLACK_MS) state = core.normalizeState(state, now);
      lastNow = now;
      const raw = o && o.sessions;
      const list = Array.isArray(raw) ? raw : raw instanceof Map ? [...raw.values()] : [];
      const map = new Map();
      for (const s of list) if (s && typeof s === 'object' && typeof s.key === 'string' && s.key) map.set(s.key, s);
      sessions = map;
      refreshState(false);
      if (unsaved && (lastWriteTry === null || now - lastWriteTry >= WRITE_RETRY_MS || now < lastWriteTry)) mutateState((st) => st, now);
      if (suspects.size) recoverLineage(now);
      if (core.resetOnDone(state, list).changed) {
        let resets = [];
        let moved = [];
        mutateState((st) => {
          const r = core.resetOnDone(st, list);
          resets = r.resets;
          moved = r.moved;
          return r.state;
        }, now);
        for (const r of resets) log(t('autoresume.log.reset', { session: r.sessionId, root: r.root, n: r.attempts }));
        noteParallel(moved, now);
      }
      computePlans(now);
      announce(now);
    } catch (e) {
      log(`autoresume: update failed: ${msg(e)}`);
    }
    arm();
  }

  function projectFor(session) {
    try { return session ? core.projectOf(session.cwd, projectList(), pathOpts) : null; } catch { return null; }
  }

  async function setProject(dir, on) {
    if (typeof dir !== 'string' || !dir.trim() || !path.isAbsolute(dir)) {
      log(`autoresume: not an absolute folder: ${String(dir)}`);
      return;
    }
    const list = projectList();
    const present = list.some((p) => core.sameDir(p, dir, pathOpts));
    if (!!on === present) { recompute(); return; }
    const next = on ? [...list, dir] : list.filter((p) => !core.sameDir(p, dir, pathOpts));
    await deps.store.update(core.PROJECTS_KEY, next);
    const now = nowMs();
    mutateState((st) => core.clearBrake(st, dir), now);
    recompute();
  }

  function cancel(sessionKey) {
    if (disposed) return;
    try {
      const now = nowMs();
      const p = plans.get(sessionKey);
      const s = sessions.get(sessionKey);
      const stop = core.stopOf(s);
      const stopId = (p && p.stopId) || (stop && stop.stopId);
      if (!stopId) return;
      mutateState((st) => core.addCancelled(st, stopId, now), now);
      logSkip({ projectName: p ? p.projectName : core.projectName(projectFor(s) || (s && s.cwd)), sessionId: s ? s.id : stopId.split('|')[0] }, 'cancelled');
    } catch (e) {
      log(`autoresume: cancel failed: ${msg(e)}`);
    }
    recompute();
  }

  /** A stopped Claude chat (apiError, quota, interrupted, stale) with a UUID id: "continue in the background now" applies */
  function stoppedClaude(s) {
    const code = s && s.main && s.main.status && s.main.status.code;
    return !!s && s.provider === 'claude' && MANUAL_CODES.has(code) && !!core.stopIdOf(s) && !!core.buildArgs(s.id, DEFAULT_PROMPT);
  }

  /** What the panel and the menus offer "Continue in background" for: stoppedClaude, and not being resumed right now */
  function canResumeNow(session) {
    try {
      return stoppedClaude(session) && !running.has(session.key) && !inflight.has(session.key);
    } catch {
      return false;
    }
  }

  async function manualRun(key) {
    if (disposed) return null;
    const now = nowMs();
    const s = sessions.get(key);
    const name = core.projectName(projectFor(s) || (s && s.cwd) || '');
    if (!stoppedClaude(s)) {
      logSkip({ projectName: name, sessionId: s ? s.id : key }, 'changed');
      return null;
    }
    if (running.has(key)) {
      logSkip({ projectName: name, sessionId: s.id }, 'claimed');
      return null;
    }
    const stopId = core.stopIdOf(s);
    const project0 = projectFor(s);
    if (isBusy(s, stopId)) {
      // never interrupted; not claimed and not marked run, so it can be tried again
      logSkip({ projectName: name, sessionId: s.id }, 'busy');
      const out = core.makeOutcome({ key, sessionId: s.id, project: project0, projectName: name, max: readSettings().maxAttempts },
        'failed', { error: 'busy', atMs: now, manual: true, attempt: 0 });
      return out;
    }
    const tries = manualTries.get(stopId) || 0;
    if (!claim(`autoresume-now|${stopId}${tries ? `|${tries}` : ''}`, now)) {
      logSkip({ projectName: name, sessionId: s.id }, 'claimed');
      return null;
    }
    const project = projectFor(s);
    const base = { key, sessionId: s.id, project, projectName: name, max: readSettings().maxAttempts };
    running.set(key, { stopId, manual: true });
    const prev = plans.get(key);
    if (prev) plans.set(key, { ...prev, state: 'running' });
    try {
      mutateState((st) => core.markExecuted(project ? core.clearBrake(st, project) : st, stopId, now), now);
      const res = await runResume(s, {
        trigger: STOP_TRIGGER[s.main.status.code] || null,
        account: prev && prev.via === 'switch' ? prev.account || null : null, projectName: name,
      });
      if (res.cancelled) return null;
      if (res.outcome === 'failed') {
        manualTries.set(stopId, tries + 1);
        if (manualTries.size > MEMO_MAX) manualTries.delete(manualTries.keys().next().value);
      }
      return conclude(base, s, res, true);
    } finally {
      running.delete(key);
      recompute();
    }
  }

  function resumeNow(sessionKey) {
    if (inflight.has(sessionKey)) return inflight.get(sessionKey);
    const p = manualRun(sessionKey)
      .catch((e) => { log(`autoresume: ${msg(e)}`); return null; })
      .finally(() => inflight.delete(sessionKey));
    inflight.set(sessionKey, p);
    return p;
  }

  return {
    update,
    plansByKey: () => new Map(plans),
    /** The original session of this one's lineage (for the push of a whole chain, lib/push-runtime.js) */
    chainOf: (sessionId) => core.rootOf(state, sessionId),
    /** When this session's lineage was last resumed automatically, or null (the same push) */
    lastResumeOf: (sessionId) => core.lineageOf(state, sessionId, nowMs()).lastMs,
    projects: () => projectList(),
    isProjectOn: (dir) => projectList().some((p) => core.sameDir(p, dir, pathOpts)),
    setProject,
    projectFor,
    canResumeNow,
    resumeNow,
    cancel,
    onOutcome(cb) {
      if (typeof cb === 'function') listeners.push(cb);
      return { dispose: () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); } };
    },
    dispose() {
      disposed = true;
      if (timer) { try { clearT(timer); } catch { /* ignore */ } }
      timer = null;
      timerAt = null;
      listeners.length = 0;
    },
  };
}

module.exports = {
  createAutoResumeRuntime,
  ACCOUNT_POLL_MS, BUSY_RETRY_MS, BUSY_TRIES, WRITE_RETRY_MS, RECOVER_MS, HELP_TIMEOUT_MS, RUN_TIMEOUT_MS, KILL_GRACE_MS, CLOSE_GRACE_MS, CLAUDE_SETTINGS_TTL_MS, GAVE_UP_FRESH_MS, DEFAULT_PROMPT,
  defaultRedact,
};
