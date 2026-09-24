'use strict';
// Alerts beyond "needs you": notification sounds, quiet hours and threshold alerts (usage %, daily cost, context).
// No vscode dependency; execFile, fs and the clock are injectable. The extension wires it in:
//   const cfg = normalizeThresholds(settings.thresholds);
//   const events = thresholds.update({ sessions, quota, today, now, cfg });        // after each scan, all sessions
//   for (const ev of events) {
//     if (!notify.claimOnce(dir, ev.transitionId, Date.now())) continue;          // one window per alert
//     const msg = formatAlert(ev, i18n);
//     if (focused || shouldMute('system', ev.type, Date.now(), quiet)) showToast(msg.toast);
//     else if (!(await notify.sendSystemNotification(msg))) showToast(msg.toast);
//     if (!shouldMute('sound', ev.type, Date.now(), quiet)) playSound(soundEventOf(ev.type), { sound, claimDir: dir });
//   }
// Quiet hours mute sounds, system notifications and remote push (see shouldMute). In-window VS Code messages, the panel
// and badges still update: quiet hours decide how loudly the user is told, never what the extension shows.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const notify = require('./notify');

const APP_NAME = notify.APP_NAME;
const SOUND_TIMEOUT_MS = 5000;
const SOUND_GAP_MS = 3000;
const MINUTE_MS = 60e3;
const DEFAULT_MAX_AGE_MS = 15 * 60e3;
const FIRED_MAX = 2000;
// Codex resolves resets_in_seconds against each line's time, so one reset time drifts by a second or two between lines:
// ids use it rounded up to RESET_STEP_MS, and a new value within RESET_STEP_MS of a known one is that same reset. Two
// windows of one limit reset at least the window length apart (5 h, a week), so this never merges two windows.
const RESET_STEP_MS = 10 * MINUTE_MS;
const TITLE_MAX = 80;
const BODY_MAX = 200;
const CHAT_TITLE_MAX = 60;
const NAME_MAX = 40;
// Title sources that are a real chat title, never the prompt (same rule as push.js)
const SAFE_TITLE_SOURCES = new Set(['custom', 'ai', 'index']);

const cleanText = notify.cleanText;

/** VS Code turns [label](command:…|https:…) in a notification into a link: a zero-width space after ']' breaks it */
function breakLinks(s) {
  return String(s).replace(/\](\s*)\(/g, ']\u200b$1(');
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const toMs = (v) => (v instanceof Date ? v.getTime() : Number.isFinite(v) ? v : Date.now());

// ---------------------------------------------------------------------------
// Sounds
// ---------------------------------------------------------------------------

// Events that can have their own sound. Threshold alerts use 'alert' (see soundEventOf).
const SOUND_EVENTS = Object.freeze(['needsYou', 'error', 'done', 'alert']);
// The names are macOS's built-in alert sounds (/System/Library/Sounds/<Name>.aiff). Linux and Windows play a sound of a
// similar character: a freedesktop sound-theme id, and a file that ships in %WINDIR%\Media.
const SOUND_TABLE = Object.freeze({
  Glass: Object.freeze({ linux: 'message-new-instant', win32: 'Windows Notify System Generic.wav' }),
  Ping: Object.freeze({ linux: 'bell', win32: 'Windows Ding.wav' }),
  Pop: Object.freeze({ linux: 'message', win32: 'notify.wav' }),
  Tink: Object.freeze({ linux: 'audio-volume-change', win32: 'ding.wav' }),
  Submarine: Object.freeze({ linux: 'window-attention', win32: 'chimes.wav' }),
  Funk: Object.freeze({ linux: 'dialog-information', win32: 'chord.wav' }),
  Hero: Object.freeze({ linux: 'complete', win32: 'tada.wav' }),
  Basso: Object.freeze({ linux: 'dialog-warning', win32: 'Windows Exclamation.wav' }),
});
const SOUND_NAMES = Object.freeze(Object.keys(SOUND_TABLE));
// Values of a per-event sound setting: 'default' is the event's default below, 'off' is no sound
const SOUND_CHOICES = Object.freeze(['default', 'off', ...SOUND_NAMES]);
const SOUND_BY_LOWER = new Map(SOUND_NAMES.map((n) => [n.toLowerCase(), n]));
// Per event, so each is recognisable by ear: a light chime when an agent needs you, a low tone for errors, a fanfare when
// work is done, a softer tone for threshold alerts. Through SOUND_TABLE each maps to the matching sound of the platform.
const DEFAULT_SOUNDS = Object.freeze({ needsYou: 'Glass', error: 'Basso', done: 'Hero', alert: 'Funk' });
const MAC_SOUND_DIR = '/System/Library/Sounds';
const LINUX_SOUND_DIR = '/usr/share/sounds/freedesktop/stereo';
// The file path reaches PowerShell only through this environment variable; the script itself never changes
const WIN_SOUND_ENV = 'AGENT_MONITOR_SOUND';
const WIN_SCRIPT = `$ErrorActionPreference = 'Stop'; (New-Object System.Media.SoundPlayer $env:${WIN_SOUND_ENV}).PlaySync()`;

/** Which sound event an alert or push event type plays: usageHigh / costDaily / contextHigh → 'alert', limitHit → 'error' */
function soundEventOf(type) {
  if (type === 'needsYou' || type === 'error' || type === 'done' || type === 'alert') return type;
  if (type === 'limitHit') return 'error';
  if (type === 'usageHigh' || type === 'costDaily' || type === 'contextHigh') return 'alert';
  return null;
}

/**
 * Default sound name of an event. The same name on every platform (settings sync between machines); SOUND_TABLE turns it
 * into that platform's own sound, e.g. Glass → Glass.aiff / message-new-instant / Windows Notify System Generic.wav.
 * @param {string} event one of SOUND_EVENTS
 * @returns {string|null}
 */
function defaultSound(event) {
  return typeof event === 'string' && own(DEFAULT_SOUNDS, event) ? DEFAULT_SOUNDS[event] : null;
}

/**
 * The sound to play for an event: 'default' (or no value) → the event's default; 'off' → none; a name from SOUND_NAMES
 * (any case) → that name. Anything else → none: only names from the fixed list ever become a file name.
 * @param {string} event
 * @param {any} choice the per-event setting
 * @returns {string|null}
 */
function resolveSound(event, choice) {
  if (choice === false || choice === 'off' || choice === 'none') return null;
  if (choice == null || choice === '' || choice === true || choice === 'default') return defaultSound(event);
  if (typeof choice !== 'string') return null;
  return SOUND_BY_LOWER.get(choice.toLowerCase()) || null;
}

/**
 * Commands to try in order for a sound on a platform; [] when the name is not in SOUND_TABLE or the platform is not
 * supported. No shell anywhere; the sound name only ever comes from SOUND_TABLE.
 * - darwin: afplay /System/Library/Sounds/<Name>.aiff
 * - linux:  canberra-gtk-play --id=<id>, then paplay /usr/share/sounds/freedesktop/stereo/<id>.oga
 * - win32:  powershell.exe with a fixed script; the file (%SystemRoot%\Media\<file>) goes in an environment variable.
 *           Written from the documentation and not tested on Windows.
 * @param {string} platform
 * @param {string} name
 * @param {Record<string, string|undefined>} [env] base environment (win32 only; default process.env)
 * @returns {{ cmd: string, args: string[], env?: Record<string, string|undefined> }[]}
 */
function soundCommands(platform, name, env) {
  if (typeof name !== 'string' || !own(SOUND_TABLE, name)) return [];
  const row = SOUND_TABLE[name];
  if (platform === 'darwin') return [{ cmd: 'afplay', args: [`${MAC_SOUND_DIR}/${name}.aiff`] }];
  if (platform === 'linux') {
    return [
      { cmd: 'canberra-gtk-play', args: [`--id=${row.linux}`] },
      { cmd: 'paplay', args: [`${LINUX_SOUND_DIR}/${row.linux}.oga`] },
    ];
  }
  if (platform === 'win32') {
    const base = env || process.env;
    const winDir = String(base.SystemRoot || base.SYSTEMROOT || base.WINDIR || base.windir || 'C:\\Windows');
    return [{
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', WIN_SCRIPT],
      env: { ...base, [WIN_SOUND_ENV]: path.win32.join(winDir, 'Media', row.win32) },
    }];
  }
  return [];
}

let lastLocalSound = -Infinity;

/**
 * Takes the right to play a sound now: at most one sound per SOUND_GAP_MS.
 * - With a shared dir (e.g. notify.sharedClaimDir()): across all windows, through notify.claimOnce on the time bucket
 *   `sound|<floor(now / gap)>`; the winner also checks the previous bucket's marker, so a burst across a bucket edge
 *   still plays once. The marker holds the time of the last sound actually played. Fails open like claimOnce.
 * - Without one: in this process only.
 * @param {string|null} [dir]
 * @param {number} [now]
 * @param {typeof import('fs')} [fsImpl]
 * @returns {boolean}
 */
function claimSoundSlot(dir, now, fsImpl) {
  const t = Number.isFinite(now) ? now : Date.now();
  if (typeof dir !== 'string' || !dir) {
    if (Math.abs(t - lastLocalSound) < SOUND_GAP_MS) return false;
    lastLocalSound = t;
    return true;
  }
  const bucket = Math.floor(t / SOUND_GAP_MS);
  if (!notify.claimOnce(dir, `sound|${bucket}`, t, fsImpl)) return false;
  const fsx = fsImpl || fs;
  let prev = null;
  try {
    prev = String(fsx.readFileSync(path.join(dir, notify.markerName(`sound|${bucket - 1}`)), 'utf8')).trim();
  } catch {
    return true; // no marker: nobody played in the previous bucket
  }
  const at = Number(prev);
  // An empty marker is being written right now by another window: treat it as a sound just played
  if (prev && Number.isFinite(at) && Math.abs(t - at) >= SOUND_GAP_MS) return true;
  // Too close: this bucket stays claimed (nobody else plays in it) and records the last sound actually played
  if (prev && Number.isFinite(at)) {
    try { fsx.writeFileSync(path.join(dir, notify.markerName(`sound|${bucket}`)), String(at)); } catch { /* best effort */ }
  }
  return false;
}

/**
 * Plays an event's sound. Resolves true when a command played it, false otherwise (sound off or not in the fixed list,
 * unsupported platform, debounced, command missing, non-zero exit, timeout). Never throws or rejects.
 * @param {string} event one of SOUND_EVENTS (or any name when o.sound names a sound)
 * @param {{ platform?: string, execFile?: Function, sound?: string, timeoutMs?: number, env?: Record<string, string>,
 *   claimDir?: string|null, debounce?: boolean, now?: number, fs?: typeof import('fs') }} [o]
 *   sound: the event's setting ('default' | 'off' | a name); claimDir: shared dir for the cross-window debounce;
 *   debounce: false skips the debounce (a preview the user asked for)
 * @returns {Promise<boolean>}
 */
function playSound(event, o = {}) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    try {
      const opts = o || {};
      const platform = opts.platform || process.platform;
      const name = resolveSound(event, opts.sound);
      const cmds = name ? soundCommands(platform, name, opts.env) : [];
      if (!cmds.length) { finish(false); return; }
      if (opts.debounce !== false && !claimSoundSlot(opts.claimDir, opts.now, opts.fs)) { finish(false); return; }
      const run = opts.execFile || childProcess.execFile;
      const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : SOUND_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      // Backstop in case no callback comes (execFile's own timeout kills the process). Not unref'd, so the promise settles.
      timer = setTimeout(() => finish(false), timeoutMs + 1000);
      const attempt = (i) => {
        if (done) return;
        const left = deadline - Date.now();
        if (i >= cmds.length || left <= 0) { finish(false); return; }
        const c = cmds[i];
        let settled = false;
        const next = (ok) => {
          if (settled) return;
          settled = true;
          if (ok) finish(true);
          else attempt(i + 1);
        };
        try {
          const execOpts = { timeout: left, windowsHide: true, shell: false };
          if (c.env) execOpts.env = c.env;
          const child = run(c.cmd, c.args, execOpts, (err) => next(!err));
          if (child && typeof child.on === 'function') child.on('error', () => next(false));
        } catch {
          next(false);
        }
      };
      attempt(0);
    } catch {
      finish(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

const HM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DAY_NAMES = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const DAY_FULL = Object.freeze(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
// Channels quiet hours mute. Everything else (in-window messages, the panel, badges, the status bar) is never muted.
const MUTED_CHANNELS = Object.freeze(['sound', 'system', 'push']);
// Event types allowErrors lets through: errors and usage-limit hits. An agent stopped by a usage limit shows the Error
// lamp, so its sound already passes as 'error'; its push is 'limitHit', and passes too.
const ERROR_TYPES = new Set(['error', 'limitHit']);

/** 'HH:MM' (24-hour, 00:00–23:59, one-digit hour allowed) → minutes after midnight; null when invalid */
function parseHm(s) {
  const m = HM_RE.exec(String(s == null ? '' : s).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Days as a set of weekdays (0 = Sunday): numbers 0–6, or 'sun'…'sat' / 'sunday'…'saturday' (any case). Missing or empty →
 * every day; entries that are neither are ignored; a list with no valid entry → null (quiet hours off).
 */
function parseDays(days) {
  if (days == null || (Array.isArray(days) && !days.length)) return new Set([0, 1, 2, 3, 4, 5, 6]);
  if (!Array.isArray(days)) return null;
  const out = new Set();
  for (const d of days) {
    if (Number.isInteger(d) && d >= 0 && d <= 6) out.add(d);
    else if (typeof d === 'string') {
      const x = d.trim().toLowerCase();
      const i = DAY_NAMES.indexOf(x) >= 0 ? DAY_NAMES.indexOf(x) : DAY_FULL.indexOf(x);
      if (i >= 0) out.add(i);
    }
  }
  return out.size ? out : null;
}

/**
 * Quiet-hours settings as a rule, or null when quiet hours are off: not enabled, a time is not 'HH:MM', start equals
 * end, or no valid day.
 * @param {{ enabled?: boolean, start?: string, end?: string, days?: (number|string)[], allowErrors?: boolean }} cfg
 * @returns {{ start: number, end: number, days: Set<number>, allowErrors: boolean }|null}
 */
function quietRule(cfg) {
  if (!cfg || typeof cfg !== 'object' || cfg.enabled !== true) return null;
  const start = parseHm(cfg.start);
  const end = parseHm(cfg.end);
  if (start == null || end == null || start === end) return null;
  const days = parseDays(cfg.days);
  if (!days) return null;
  return { start, end, days, allowErrors: cfg.allowErrors === true };
}

/**
 * Whether quiet hours are on at an instant, by the local wall clock (whatever time zone and DST offset apply then).
 * A range whose end is before its start runs past midnight (22:00–07:00). days name the day a quiet period starts on:
 * with days ['fri'], Friday 22:00 → Saturday 07:00 is quiet, Thursday night's period is not. End is exclusive.
 * @param {number|Date} now
 * @param {any} cfg { enabled, start: 'HH:MM', end: 'HH:MM', days?, allowErrors? }
 */
function isQuiet(now, cfg) {
  const r = quietRule(cfg);
  if (!r) return false;
  const d = new Date(toMs(now));
  const m = d.getHours() * 60 + d.getMinutes();
  const wd = d.getDay();
  if (r.start < r.end) return m >= r.start && m < r.end && r.days.has(wd);
  return (m >= r.start && r.days.has(wd)) || (m < r.end && r.days.has((wd + 6) % 7));
}

/**
 * When isQuiet next changes (epoch ms, strictly after now), for a timer; null when quiet hours are off. A boundary that
 * falls in a DST gap (02:30 on a spring-forward night) moves to the end of the gap, where the wall clock passes it. On a
 * fall-back night a boundary inside the repeated hour is taken at its first occurrence (isQuiet follows the wall clock,
 * so a period ending at 01:30 is quiet again for the repeated 01:00–01:30; the timer does not see that change).
 * @param {number|Date} now
 * @param {any} cfg
 * @returns {number|null}
 */
function nextQuietChange(now, cfg) {
  const r = quietRule(cfg);
  if (!r) return null;
  const t = toMs(now);
  const cur = isQuiet(t, cfg);
  const d = new Date(t);
  const cands = [];
  for (let k = 0; k <= 8; k++) {
    for (const m of [r.start, r.end]) {
      const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + k, Math.floor(m / 60), m % 60, 0, 0).getTime();
      if (c > t) cands.push(c);
    }
  }
  cands.sort((a, b) => a - b);
  let lo = t - (((t % MINUTE_MS) + MINUTE_MS) % MINUTE_MS); // same minute as now, so the same state
  for (const c of cands) {
    if (isQuiet(c, cfg) === cur) { lo = c; continue; }
    if (isQuiet(c - MINUTE_MS, cfg) === cur) return c;
    // The wall clock skipped the boundary: find the first minute with the new state
    let hi = c;
    while (hi - lo > MINUTE_MS) {
      const mid = lo + Math.max(1, Math.floor((hi - lo) / 2 / MINUTE_MS)) * MINUTE_MS;
      if (isQuiet(mid, cfg) === cur) lo = mid; else hi = mid;
    }
    return hi > t ? hi : c;
  }
  return null;
}

/**
 * Whether a channel is muted for an event right now. Quiet hours mute 'sound', 'system' (the OS notification) and
 * 'push'; any other channel ('toast', 'panel', 'badge' …) is never muted. With allowErrors, 'error' and 'limitHit'
 * events get through (limitReset and threshold alerts stay muted).
 * @param {string} channel
 * @param {string} eventType
 * @param {number|Date} now
 * @param {any} cfg quiet-hours settings
 */
function shouldMute(channel, eventType, now, cfg) {
  if (!MUTED_CHANNELS.includes(channel)) return false;
  const r = quietRule(cfg);
  if (!r) return false;
  if (r.allowErrors && ERROR_TYPES.has(eventType)) return false;
  return isQuiet(now, cfg);
}

// ---------------------------------------------------------------------------
// Threshold alerts
// ---------------------------------------------------------------------------

const ALERT_TYPES = Object.freeze(['usageHigh', 'costDaily', 'contextHigh']);
const DEFAULT_THRESHOLDS = Object.freeze({ usagePercent: 90, dailyCost: 0, contextPercent: 0 });

function pctSetting(v, def) {
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * Threshold settings with defaults. 0 turns a check off.
 * @param {any} raw { usagePercent (1–100, default 90), dailyCost (USD, default 0), contextPercent (1–100, default 0) }
 * @returns {{ usagePercent: number, dailyCost: number, contextPercent: number }}
 */
function normalizeThresholds(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const cost = Number(r.dailyCost);
  return {
    usagePercent: pctSetting(r.usagePercent, DEFAULT_THRESHOLDS.usagePercent),
    dailyCost: Number.isFinite(cost) && cost > 0 ? Math.round(cost * 100) / 100 : 0,
    contextPercent: pctSetting(r.contextPercent, DEFAULT_THRESHOLDS.contextPercent),
  };
}

/** Last path segment of the session folder (either separator); null when unknown */
function projectOf(session) {
  const cwd = session && typeof session.cwd === 'string' ? session.cwd.replace(/[\\/]+$/, '') : '';
  if (!cwd) return null;
  const parts = cwd.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

/** Local date 'YYYY-MM-DD' of an instant */
function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Usage windows with a percentage from a QuotaSnapshot: every provider entry that has windows[] (today only Codex;
 * Claude's snapshot has lastHit only, because Claude Code writes no usage percentage to its transcripts).
 * @returns {{ provider: string, label: string, minutes: number|null, usedPct: number, resetsAtMs: number|null }[]}
 */
function usageWindowsOf(quota) {
  const out = [];
  if (!quota || typeof quota !== 'object') return out;
  for (const provider of Object.keys(quota)) {
    const q = quota[provider];
    if (!q || typeof q !== 'object' || !Array.isArray(q.windows)) continue;
    for (const w of q.windows) {
      if (!w || typeof w !== 'object') continue;
      const usedPct = Number(w.usedPct);
      if (w.usedPct == null || !Number.isFinite(usedPct)) continue;
      const minutes = Number.isFinite(w.minutes) ? w.minutes : null;
      const label = typeof w.label === 'string' && w.label ? w.label : minutes != null ? `${minutes}m` : 'window';
      const resetsAtMs = Number.isFinite(w.resetsAtMs) && w.resetsAtMs > 0 ? w.resetsAtMs : null;
      out.push({ provider, label, minutes, usedPct, resetsAtMs });
    }
  }
  return out;
}

/**
 * A session's main-conversation context against its auto-compact point, or null when there is none to compare with
 * (compaction off or unknown, or Codex's body_after_prefix scope, where the point is not an absolute token count).
 * cycle names the compaction cycle: the last compaction's transcript time, so it is the same in every window.
 */
function contextOf(s) {
  const compactAt = Number(s && s.compactAt);
  if (!(compactAt > 0)) return null;
  const tokens = s.main && s.main.tokens;
  if (tokens && typeof tokens === 'object' && 'toCompact' in tokens && tokens.toCompact === null) return null;
  const used = Math.max(0, Number(s.contextUsed) || 0);
  const lc = s.main && s.main.lastCompact;
  const cycle = lc && Number.isFinite(lc.ms) && lc.ms > 0 ? Math.round(lc.ms) : 0;
  return {
    pct: used / compactAt * 100,
    used,
    compactAt,
    cycle,
    windowPct: Number.isFinite(s.contextPct) ? s.contextPct : null,
  };
}

/** Bounded insertion-ordered set */
function rememberId(set, id, max) {
  set.delete(id);
  set.add(id);
  while (set.size > max) set.delete(set.values().next().value);
}

/**
 * Tracks threshold crossings.
 * - usageHigh: a usage window's used % reaches cfg.usagePercent. Id `usageHigh|<provider>|<window>|<reset>|<threshold>`,
 *   so it fires once per window per threshold. A window whose reset time has passed is ignored (old data).
 * - costDaily: today's estimated cost (Claude + Codex) reaches cfg.dailyCost. Id `costDaily|<local date>|<threshold>`.
 *   Skipped while today's totals are still being read (partial), so catching up is not taken for a crossing.
 * - contextHigh: a session's context reaches cfg.contextPercent of its auto-compact point. Id
 *   `contextHigh|<session key>|c<last compaction ms>|<threshold>`: fires again after the next compaction.
 * Every id derives from the data only, so every VS Code window names a crossing alike (use it with notify.claimOnce).
 * - The first update carrying each source (quota / today / sessions) only seeds: what is over a threshold when the window
 *   opens is not reported. A threshold change seeds again, so editing a setting never reports what is already over it.
 * - A session that shows up after seeding already over the threshold is reported only if it was updated within
 *   maxAgeMs (a chat that just crossed), not when an old chat comes into scope.
 * @param {{ maxAgeMs?: number }} [o]
 */
function createThresholdTracker(o = {}) {
  const maxAgeMs = Number.isFinite(o && o.maxAgeMs) && o.maxAgeMs > 0 ? o.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const lastT = { usage: null, cost: null, context: null }; // threshold at the last update per source; null = not seeded
  const fired = new Set();      // ids seen (seeded or reported)
  const knownReset = new Map(); // `${provider}|${label}` → canonical reset time

  function canonReset(k, resetAt) {
    const q = Math.ceil(resetAt / RESET_STEP_MS) * RESET_STEP_MS;
    const prev = knownReset.get(k);
    if (prev != null && Math.abs(prev - q) <= RESET_STEP_MS) return prev;
    knownReset.delete(k);
    knownReset.set(k, q);
    while (knownReset.size > 100) knownReset.delete(knownReset.keys().next().value);
    return q;
  }

  /**
   * @param {{ sessions?: any[], quota?: any, today?: any, now?: number, cfg?: any }} [input]
   * @returns {any[]} events, each { type, key, transitionId, … }:
   *   usageHigh   { provider, window, windowMinutes, percent, threshold, resetAt, atLimit }
   *   costDaily   { date, cost, threshold, claudeCost, codexCost }
   *   contextHigh { provider, title, titleSource, project, percent (of the compact point), threshold, contextPct (of the
   *                 window), contextUsed, compactAt, toCompact }
   */
  function update(input = {}) {
    const { sessions, quota, today } = input || {};
    const now = Number.isFinite(input && input.now) ? input.now : Date.now();
    const cfg = normalizeThresholds(input && input.cfg);
    const out = [];

    if (quota && typeof quota === 'object') {
      const T = cfg.usagePercent;
      const seeding = lastT.usage !== T;
      if (T > 0) {
        for (const w of usageWindowsOf(quota)) {
          if (w.resetsAtMs != null && w.resetsAtMs <= now) continue;
          if (w.usedPct < T) continue;
          const reset = w.resetsAtMs != null ? String(canonReset(`${w.provider}|${w.label}`, w.resetsAtMs)) : 'unknown';
          const id = `usageHigh|${w.provider}|${w.label}|${reset}|${T}`;
          if (fired.has(id)) continue;
          rememberId(fired, id, FIRED_MAX);
          if (seeding) continue;
          out.push({
            type: 'usageHigh', key: `quota:${w.provider}:${w.label}`, transitionId: id,
            provider: w.provider, window: w.label, windowMinutes: w.minutes, percent: w.usedPct, threshold: T,
            resetAt: w.resetsAtMs, atLimit: w.usedPct >= 100,
          });
        }
      }
      lastT.usage = T;
    }

    if (today && typeof today === 'object' && !today.partial) {
      const T = cfg.dailyCost;
      const seeding = lastT.cost !== T;
      if (T > 0) {
        const cc = Number(today.claude && today.claude.costUsd) || 0;
        const xc = Number(today.codex && today.codex.costUsd) || 0;
        const cost = cc + xc;
        if (cost >= T) {
          const date = localDate(Number.isFinite(today.dayStartMs) ? today.dayStartMs : now);
          const id = `costDaily|${date}|${T}`;
          if (!fired.has(id)) {
            rememberId(fired, id, FIRED_MAX);
            if (!seeding) {
              out.push({
                type: 'costDaily', key: 'today', transitionId: id, date, cost, threshold: T, claudeCost: cc, codexCost: xc,
              });
            }
          }
        }
      }
      lastT.cost = T;
    }

    if (Array.isArray(sessions)) {
      const T = cfg.contextPercent;
      const seeding = lastT.context !== T;
      const seen = new Set();
      if (T > 0) {
        for (const s of sessions) {
          if (!s || typeof s.key !== 'string' || seen.has(s.key)) continue;
          seen.add(s.key);
          const c = contextOf(s);
          if (!c || c.pct < T) continue;
          const id = `contextHigh|${s.key}|c${c.cycle}|${T}`;
          if (fired.has(id)) continue;
          rememberId(fired, id, FIRED_MAX);
          const since = Number(s.updatedMs);
          if (seeding || (since > 0 && now - since > maxAgeMs)) continue;
          out.push({
            type: 'contextHigh', key: s.key, transitionId: id,
            provider: s.provider || String(s.key).split(':')[0] || null,
            title: String(s.title || ''), titleSource: typeof s.titleSource === 'string' ? s.titleSource : null,
            project: projectOf(s), percent: Math.floor(c.pct), threshold: T, contextPct: c.windowPct,
            contextUsed: c.used, compactAt: c.compactAt, toCompact: Math.max(0, c.compactAt - c.used),
          });
        }
      }
      lastT.context = T;
    }

    return out;
  }

  return { update };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function translated(tr, key, fallback) {
  const v = tr(key);
  return v && v !== key ? v : fallback;
}

function windowLabel(tr, e) {
  if (e.window === '5h') return tr('alerts.window.5h');
  if (e.window === 'weekly') return tr('alerts.window.weekly');
  if (Number.isFinite(e.windowMinutes) && e.windowMinutes > 0) return tr('alerts.window.minutes', { n: e.windowMinutes });
  return cleanText(e.window || '', NAME_MAX);
}

/**
 * Text for a threshold alert.
 * - includeTitle (default true): name the chat of a contextHigh alert; false leaves only the project folder.
 * - forPush: the remote-push rules of push.js: a chat title only when includeTitle and it is a real title (never one made
 *   from the prompt), and no cost amounts (costDaily says the budget was passed, without numbers).
 * @param {any} event from createThresholdTracker().update
 * @param {Function|{ t: Function, fmtPct?: Function, fmtUsd?: Function, fmtClock?: Function }} t translate function
 *   (key, vars) or an i18n instance (then its number and time formatting is used too)
 * @param {{ includeTitle?: boolean, forPush?: boolean, now?: number, fmtClock?: (ms: number) => string,
 *   fmtPct?: (ratio: number) => string, fmtUsd?: (usd: number) => string }} [o]
 * @returns {{ title: string, body: string, toast: string }} title / body for the system notification or push, toast for
 *   the in-window message
 */
function formatAlert(event, t, o = {}) {
  const tr = typeof t === 'function' ? t : (k, v) => t.t(k, v);
  const i18n = t && typeof t === 'object' ? t : null;
  const opts = o || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const fmtPct = typeof opts.fmtPct === 'function' ? opts.fmtPct
    : i18n && typeof i18n.fmtPct === 'function' ? (r) => i18n.fmtPct(r) : (r) => `${Math.round(r * 100)}%`;
  const fmtUsd = typeof opts.fmtUsd === 'function' ? opts.fmtUsd
    : i18n && typeof i18n.fmtUsd === 'function' ? (x) => i18n.fmtUsd(x) : (x) => `$${Number(x).toFixed(2)}`;
  const clock = typeof opts.fmtClock === 'function' ? opts.fmtClock
    : i18n && typeof i18n.fmtClock === 'function' ? (ms) => i18n.fmtClock(ms, now) : null;
  const pct = (p) => fmtPct(Math.floor(Number(p) || 0) / 100);
  const e = event || {};
  let title = '';
  let body = '';
  if (e.type === 'usageHigh') {
    const provider = translated(tr, `alerts.provider.${e.provider}`, cleanText(e.provider || '', NAME_MAX));
    const vars = { provider, window: windowLabel(tr, e), pct: pct(e.percent) };
    const reset = Number.isFinite(e.resetAt) && clock ? clock(e.resetAt) : '';
    title = tr('alerts.usageHigh.title', vars);
    body = reset ? tr('alerts.usageHigh.body', { reset }) : tr('alerts.usageHigh.bodyNoReset');
  } else if (e.type === 'costDaily') {
    if (opts.forPush) {
      title = tr('alerts.costDaily.titleNoAmount');
      body = tr('alerts.costDaily.bodyNoAmount');
    } else {
      title = tr('alerts.costDaily.title', { budget: fmtUsd(e.threshold) });
      body = tr('alerts.costDaily.body', { cost: fmtUsd(e.cost) });
    }
  } else if (e.type === 'contextHigh') {
    const project = cleanText(e.project, NAME_MAX);
    const showTitle = opts.includeTitle !== false && (!opts.forPush || SAFE_TITLE_SOURCES.has(e.titleSource));
    const chat = showTitle ? cleanText(e.title, CHAT_TITLE_MAX) : '';
    title = project ? tr('alerts.contextHigh.titleProject', { project }) : tr('alerts.contextHigh.title');
    body = chat ? tr('alerts.contextHigh.bodyTitle', { title: chat, pct: pct(e.percent) })
      : tr('alerts.contextHigh.body', { pct: pct(e.percent) });
  } else {
    return { title: APP_NAME, body: '', toast: '' };
  }
  title = cleanText(title, TITLE_MAX);
  body = cleanText(body, BODY_MAX);
  return { title, body, toast: breakLinks(tr('alerts.toast', { heading: title, body })) };
}

/** Label of a sound setting value ('default', 'off' or a sound name) */
function soundLabel(choice, t) {
  const tr = typeof t === 'function' ? t : (k, v) => t.t(k, v);
  const c = choice === 'default' || choice === 'off' ? choice : resolveSound('', choice);
  return c ? tr(`alerts.sound.${c}`) : String(choice == null ? '' : choice);
}

/** Label of a sound event (needsYou / error / done / alert), e.g. for a "pick a sound" list */
function soundEventLabel(event, t) {
  const tr = typeof t === 'function' ? t : (k, v) => t.t(k, v);
  return SOUND_EVENTS.includes(event) ? tr(`alerts.soundEvent.${event}`) : String(event == null ? '' : event);
}

/**
 * Status text while quiet hours are on ("Quiet hours until 07:00"), '' otherwise; e.g. for the status bar tooltip.
 * @param {number|Date} now
 * @param {any} cfg
 * @param {Function|{ t: Function, fmtClock?: Function }} t
 * @param {{ fmtClock?: (ms: number) => string }} [o]
 */
function formatQuietStatus(now, cfg, t, o = {}) {
  if (!isQuiet(now, cfg)) return '';
  const tr = typeof t === 'function' ? t : (k, v) => t.t(k, v);
  const n = toMs(now);
  const until = nextQuietChange(n, cfg);
  const clock = typeof (o && o.fmtClock) === 'function' ? o.fmtClock
    : t && typeof t.fmtClock === 'function' ? (ms) => t.fmtClock(ms, n) : (ms) => new Date(ms).toTimeString().slice(0, 5);
  return until == null ? '' : tr('alerts.quiet.until', { time: clock(until) });
}

module.exports = {
  APP_NAME, SOUND_TIMEOUT_MS, SOUND_GAP_MS,
  // sounds
  SOUND_EVENTS, SOUND_NAMES, SOUND_CHOICES, SOUND_TABLE, DEFAULT_SOUNDS, WIN_SCRIPT, WIN_SOUND_ENV,
  soundEventOf, defaultSound, resolveSound, soundCommands, claimSoundSlot, playSound,
  // quiet hours
  DAY_NAMES, MUTED_CHANNELS, parseHm, quietRule, isQuiet, nextQuietChange, shouldMute,
  // thresholds
  ALERT_TYPES, DEFAULT_THRESHOLDS, normalizeThresholds, usageWindowsOf, contextOf, createThresholdTracker,
  // text
  formatAlert, soundLabel, soundEventLabel, formatQuietStatus,
};
