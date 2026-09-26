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
// - Nothing thrown out of update(), cancel() or a timer: problems go to the log.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const core = require('./core/autoresume');
const notify = require('./notify');

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
const MANUAL_CODES = new Set(['apiError', 'quota', 'interrupted', 'stale']);
// English resume.prompt.claude, used only when deps.prompt() gives nothing usable
const DEFAULT_PROMPT = "Continue the task you were working on before you were interrupted. Pick up from the last completed step and don't redo finished work.";
// Dictionary keys, spelled out so every key the code uses can be found in the source
const TRIGGER_KEY = Object.freeze({ error: 'autoresume.trigger.error', limit: 'autoresume.trigger.limit' });
const SKIP_KEY = Object.freeze({
  changed: 'autoresume.skip.changed', off: 'autoresume.skip.off', claimed: 'autoresume.skip.claimed',
  cancelled: 'autoresume.skip.cancelled', late: 'autoresume.skip.late',
});
const ERROR_KEY = Object.freeze({
  cliNotFound: 'autoresume.error.cliNotFound', cliTooOld: 'autoresume.error.cliTooOld', noCwd: 'autoresume.error.noCwd',
  untrusted: 'autoresume.error.untrusted', exit: 'autoresume.error.exit', timeout: 'autoresume.error.timeout', spawn: 'autoresume.error.spawn',
});
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
 *   log?: (line: string) => void, t?: (key: string, vars?: any) => string,
 *   claimOnce?: typeof notify.claimOnce, platform?: string, redact?: (s: string) => string, fmtTime?: (ms: number) => string
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
  let timer = null;
  let timerAt = null;
  let claudeCfg = null;
  let claudeCfgAt = 0;
  const listeners = [];
  const running = new Map();     // key → { stopId, manual }
  const handled = memo(MEMO_MAX);   // plan ids fired in this window (claim lost, skipped for good, or run)
  const announced = memo(MEMO_MAX); // plan ids logged as planned and pre-checked
  const gaveUpSeen = memo(MEMO_MAX);
  const checks = new Map();      // key → the last check's unavailable value for that session
  const bgCache = new Map();     // `${cli}|${mtimeMs}` → --bg supported
  const bgPending = new Map();
  const manualTries = new Map(); // stopId → failed manual tries
  const inflight = new Map();    // key → Promise of a manual run

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

  /**
   * Re-reads the state file when it changed (always with force). No file (not written yet, or it could not be written)
   * or a broken one → keep what we have in memory.
   */
  function refreshState(force) {
    const file = stateFile();
    if (!file) return state;
    let sig;
    try { sig = sigOf(fsx.statSync(file)); } catch { sig = 'none'; }
    if (!force && sig === stateSig) return state;
    if (sig !== 'none') {
      try {
        state = core.normalizeState(JSON.parse(String(fsx.readFileSync(file, 'utf8'))));
      } catch (e) {
        log(`autoresume: ${path.basename(file)} unreadable (${msg(e)}), keeping the last state`);
      }
    }
    stateSig = sig;
    return state;
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
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      try { fsx.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* the write reports it */ }
      fsx.writeFileSync(tmp, JSON.stringify(next));
      fsx.renameSync(tmp, file);
      try { stateSig = sigOf(fsx.statSync(file)); } catch { stateSig = null; }
    } catch (e) {
      try { fsx.unlinkSync(tmp); } catch { /* not there */ }
      log(`autoresume: could not write ${path.basename(file)}: ${msg(e)}`);
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
      cancelled: state.cancelled, executed: state.executed, platform,
    };
  }

  // -------------------------------------------------------------------------
  // Plans and the timer
  // -------------------------------------------------------------------------

  function computePlans(now) {
    const o = planOptions(now);
    const next = new Map();
    for (const [key, s] of sessions) {
      try {
        if (!s || s.provider !== 'claude') continue;
        const prev = plans.get(key) || null;
        if (running.has(key)) {
          if (prev) next.set(key, { ...prev, state: 'running' });
          continue;
        }
        const plan = core.planFor(s, core.lineageOf(state, s.id, now), { ...o, prev });
        if (!plan) continue;
        if (plan.state === 'scheduled') {
          if (handled.has(core.planIdOf(plan))) continue;
          plan.unavailable = checks.has(key) ? checks.get(key) : null;
        }
        next.set(key, plan);
      } catch (e) {
        log(`autoresume: plan for ${key} failed: ${msg(e)}`);
      }
    }
    plans = next;
    for (const k of [...checks.keys()]) if (!plans.has(k)) checks.delete(k);
  }

  /** New scheduled plans: log and pre-check. New gaveUp stops: one Outcome across windows. */
  function announce(now) {
    for (const [key, p] of plans) {
      try {
        if (p.state === 'scheduled') {
          const id = core.planIdOf(p);
          if (announced.has(id)) continue;
          announced.add(id);
          log(t('autoresume.log.planned', {
            project: p.projectName, session: p.sessionId, trigger: t(TRIGGER_KEY[p.trigger] || TRIGGER_KEY.error),
            time: fmtTime(p.atMs), n: p.attempt, max: p.max,
          }));
          precheck(key, id);
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

  function arm() {
    if (disposed) return;
    try {
      let next = null;
      for (const p of plans.values()) {
        if (p.state === 'scheduled' && core.fin(p.atMs) && (next === null || p.atMs < next)) next = p.atMs;
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
        .filter((p) => p.state === 'scheduled' && core.fin(p.atMs) && p.atMs <= now + DUE_SLACK_MS)
        .sort((a, b) => a.atMs - b.atMs);
      for (const p of due) runPlan(p, now).catch((e) => log(`autoresume: ${msg(e)}`));
    } catch (e) {
      log(`autoresume: ${msg(e)}`);
    }
    arm();
  }

  function claim(id, now) {
    let dir = null;
    try { dir = deps.claimDir ? deps.claimDir() : null; } catch { dir = null; }
    try { return claimFn(dir, id, now, fsx) !== false; } catch { return true; }
  }

  function logSkip(p, reason) {
    log(t('autoresume.log.skipped', { project: p.projectName, session: p.sessionId, reason: t(SKIP_KEY[reason] || SKIP_KEY.changed) }));
  }

  function logResult(o) {
    let text;
    if (o.outcome === 'copied') text = t('autoresume.outcome.copied', { copy: o.copySessionId });
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
    const fresh = core.planFor(s, core.lineageOf(state, s.id, now), { ...o, prev: plan });
    if (!fresh || fresh.state !== 'scheduled' || fresh.attempt !== plan.attempt) return { reason: 'changed' };
    if (fresh.atMs > now + DUE_SLACK_MS) return { reason: 'changed', retry: true };
    return null;
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
      handled.add(id);
      if (!claim(`autoresume|${plan.stopId}|${plan.attempt}`, now)) {
        logSkip(plan, 'claimed');
        return;
      }
      const session = sessions.get(plan.key);
      owned = true;
      running.set(plan.key, { stopId: plan.stopId, manual: false });
      plans.set(plan.key, { ...plan, state: 'running' });
      mutateState((st) => core.recordAttempt(st, session.id, plan.stopId, now), now);
      log(t('autoresume.log.started', { project: plan.projectName, session: plan.sessionId, n: plan.attempt, max: plan.max }));
      const res = await runResume(session);
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
        resolve({ ...base, ...r, stdout: text(out), stderr: text(err) });
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

  /** @returns {Promise<{ outcome: 'resumed'|'copied'|'failed', error: string|null, copySessionId: string|null }>} */
  async function runResume(session) {
    const fail = (error) => ({ outcome: 'failed', error, copySessionId: null });
    try {
      const a = await availability(session);
      if (a.error) {
        checks.set(session.key, a.error);
        if (a.shim) log(`autoresume: ${a.shim} needs a shell to start; not started`);
        return fail(a.error);
      }
      checks.set(session.key, null);
      let prompt = '';
      try { prompt = deps.prompt ? deps.prompt() : ''; } catch { prompt = ''; }
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

  function conclude(base, session, res, manual) {
    const now = nowMs();
    if (res.outcome === 'copied' && res.copySessionId) {
      mutateState((st) => core.recordCopy(st, res.copySessionId, session.id), now);
    }
    const out = core.makeOutcome(base, res.outcome, {
      error: res.error, copySessionId: res.copySessionId, atMs: now, manual, attempt: manual ? 0 : undefined,
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
      const raw = o && o.sessions;
      const list = Array.isArray(raw) ? raw : raw instanceof Map ? [...raw.values()] : [];
      const map = new Map();
      for (const s of list) if (s && typeof s === 'object' && typeof s.key === 'string' && s.key) map.set(s.key, s);
      sessions = map;
      refreshState(false);
      if (core.resetOnDone(state, list).changed) mutateState((st) => core.resetOnDone(st, list).state, now);
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
      mutateState((st) => core.markExecuted(st, stopId, now), now);
      const res = await runResume(s);
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
  HELP_TIMEOUT_MS, RUN_TIMEOUT_MS, KILL_GRACE_MS, CLOSE_GRACE_MS, CLAUDE_SETTINGS_TTL_MS, GAVE_UP_FRESH_MS, DEFAULT_PROMPT,
  defaultRedact,
};
