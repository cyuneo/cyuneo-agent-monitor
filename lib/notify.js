'use strict';
// "Needs you" notifications: detect sessions that start waiting for the user, make sure only one VS Code window
// reports each transition, and deliver it as a system notification (or leave it to the caller to show a toast).
// No vscode dependency; the extension wires it in:
//   const items = tracker.update(sessions, lamps);          // after each computeLamps
//   for (const item of items) switch (plan({ enabled, windowFocused })) {
//     case 'toast':      if (claimOnce(dir, item.transitionId, Date.now())) showToast(formatNeedsYou(item, t)); break;
//     case 'claimLater': setTimeout(async () => {
//                          if (!claimOnce(dir, item.transitionId, Date.now())) return;
//                          const msg = formatNeedsYou(item, t);
//                          if (!(await sendSystemNotification(msg))) showToast(msg);
//                        }, CLAIM_DELAY_MS); break;
//   }
// The focused window claims right away and unfocused windows only after CLAIM_DELAY_MS, so across all windows the user
// gets exactly one notification per transition, and it is the in-window one whenever some window has focus.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const S = require('./core/status');
const lampLib = require('./lamp');
const { ROW_MAIN } = require('./order');

const APP_NAME = 'CYUNEO Agent Monitor';
const CLAIM_DELAY_MS = 2500;
const NOTIFY_TIMEOUT_MS = 5000;
const MARKER_TTL_MS = 24 * 3600e3;
const PRUNE_EVERY_MS = 3600e3;
const PRUNE_STAMP = '.pruned';
const MARKER_RE = /^[0-9a-f]{40}\.claim$/;
const TITLE_MAX = 80;
const BODY_MAX = 200;
const CHAT_TITLE_MAX = 60;
const AGENT_NAME_MAX = 40;
const TRACKER_MAX_KEYS = 1000;

// ---------------------------------------------------------------------------
// Text cleanup
// ---------------------------------------------------------------------------

// C0 / DEL / C1 controls and line/paragraph separators become spaces; bidi embedding, override and isolate marks are dropped
// (they can reorder what the user sees). ZWJ and other format characters are kept so emoji sequences stay intact.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * One line of plain text: controls stripped, whitespace collapsed, at most max characters (code points) with a trailing ….
 * @param {any} s
 * @param {number} max
 */
function cleanText(s, max) {
  const one = String(s == null ? '' : s).replace(CONTROL_RE, ' ').replace(BIDI_RE, '').replace(/\s+/g, ' ').trim();
  const a = Array.from(one);
  return a.length > max ? a.slice(0, Math.max(1, max - 1)).join('').trimEnd() + '…' : one;
}

/** Body text for notify-send: the notification spec lets daemons parse <b>, <a href>, <img> and entities in the body */
function escapeMarkup(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** VS Code turns [label](https:|command:|file:...) in a notification into a link: a zero-width space after ']' breaks it */
function breakLinks(s) {
  return String(s).replace(/\](\s*)\(/g, ']\u200b$1(');
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/** Last path segment of a folder (either separator); null when unknown */
function projectOf(session) {
  const cwd = session && typeof session.cwd === 'string' ? session.cwd.replace(/[\\/]+$/, '') : '';
  if (!cwd) return null;
  const parts = cwd.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

/** sessionLamps result for a key: from computeLamps' result, from a Map of key → sessionLamps, or computed here */
function lampsFor(lamps, session) {
  const map = lamps && lamps.bySession instanceof Map ? lamps.bySession : lamps instanceof Map ? lamps : null;
  const r = map ? map.get(session.key) : null;
  if (r && typeof r === 'object') return r;
  return map ? null : lampLib.sessionLamps(session);
}

/**
 * When the current wait began, taken from the transcript / registry data (never the local clock), so every window
 * derives the same value: the corrected status of the row that makes the session lamp NeedsYou (lead.status.sinceMs;
 * the registry's statusUpdatedAt or the pending question / tool call time), falling back to the session's updatedMs.
 */
function waitSinceOf(L, session) {
  const lead = L && L.lead;
  const candidates = [
    lead && lead.status && lead.status.sinceMs,
    lead && lead.agent && lead.agent.status && lead.agent.status.sinceMs,
    session && session.updatedMs,
  ];
  for (const v of candidates) if (Number.isFinite(v) && v > 0) return Math.round(v);
  return 0;
}

/** The id of a session's current wait (see itemFor); the same in every window that sees the same data */
function transitionIdOf(session, L) {
  const lead = (L && L.lead) || { rowId: ROW_MAIN };
  return `${session.key}|${lead.rowId || ROW_MAIN}|${waitSinceOf(L, session)}`;
}

/**
 * One notification item for a session whose lamp is NeedsYou.
 * @returns {{ key: string, transitionId: string, title: string, project: string|null, agentName: string|null }}
 */
function itemFor(session, L) {
  const lead = (L && L.lead) || { rowId: ROW_MAIN, agent: session.main || null };
  const rowId = lead.rowId || ROW_MAIN;
  const agent = lead.agent || null;
  const isMain = rowId === ROW_MAIN || !agent || agent.kind === 'main';
  let agentName = null;
  if (!isMain) {
    const raw = agent.name || agent.agentType || (agent.id != null ? String(agent.id).slice(0, 8) : '');
    agentName = raw ? String(raw) : null;
  }
  return {
    key: session.key,
    transitionId: transitionIdOf(session, L),
    title: String(session.title || session.id || ''),
    project: projectOf(session),
    agentName,
  };
}

/**
 * Tracks which sessions are in NeedsYou and reports the transitions into it.
 * - The first update (with an array) only seeds: sessions already waiting when the window opens are not reported.
 * - A session that stays NeedsYou is reported once; after leaving and coming back it is reported again, unless the new
 *   wait has the same transitionId as the last one reported for that key (a flicker of the same wait, which claimOnce
 *   would refuse anyway).
 * - A session that first appears after seeding and is already waiting is reported (a new chat that asked right away).
 * - A session missing from a later list keeps only its last transitionId, so it is not reported again for the same
 *   wait when it comes back (scope switches, activity window).
 * Pass the same session list the lamps were computed from; lamps may be computeLamps' result, its bySession Map, or
 * omitted (then computed here with default options; NeedsYou does not depend on "seen").
 */
function createNeedsYouTracker() {
  let seeded = false;
  const needs = new Map();  // key → true while the session is NeedsYou (present keys only)
  const lastId = new Map(); // key → last transitionId seen for that key (seeded or reported)

  /**
   * @param {any[]} sessions
   * @param {any} [lamps]
   * @returns {{ key: string, transitionId: string, title: string, project: string|null, agentName: string|null }[]}
   */
  function update(sessions, lamps) {
    if (!Array.isArray(sessions)) return [];
    const out = [];
    const present = new Set();
    for (const s of sessions) {
      if (!s || typeof s.key !== 'string' || present.has(s.key)) continue;
      present.add(s.key);
      const L = lampsFor(lamps, s);
      const isNeeds = !!L && L.lamp === S.LAMP.NEEDS_YOU;
      const was = needs.get(s.key) === true;
      if (!isNeeds) { needs.set(s.key, false); continue; }
      needs.set(s.key, true);
      if (was) continue;
      const item = itemFor(s, L);
      const prevId = lastId.get(s.key);
      lastId.delete(s.key); // re-insert to keep recently used keys last (pruning drops the oldest first)
      lastId.set(s.key, item.transitionId);
      if (seeded && prevId !== item.transitionId) out.push(item);
    }
    for (const k of [...needs.keys()]) if (!present.has(k)) needs.delete(k);
    if (lastId.size > TRACKER_MAX_KEYS) {
      for (const k of [...lastId.keys()]) {
        if (lastId.size <= TRACKER_MAX_KEYS) break;
        if (!present.has(k)) lastId.delete(k);
      }
    }
    seeded = true;
    return out;
  }

  return { update };
}

// ---------------------------------------------------------------------------
// Cross-window claim
// ---------------------------------------------------------------------------

/** Marker file name for a transition: hashed so any id is a safe, fixed-length file name */
function markerName(transitionId) {
  return crypto.createHash('sha1').update(String(transitionId)).digest('hex') + '.claim';
}

/** Removes markers older than 24 h, at most once an hour across all windows (a stamp file in dir records the last run) */
function maybePrune(fsx, dir, now) {
  const stamp = path.join(dir, PRUNE_STAMP);
  let last = NaN;
  try { last = Number(String(fsx.readFileSync(stamp, 'utf8')).trim()); } catch { /* no stamp yet */ }
  if (Number.isFinite(last) && Math.abs(now - last) < PRUNE_EVERY_MS) return false;
  try { fsx.writeFileSync(stamp, String(now)); } catch { /* still prune */ }
  let names = [];
  try { names = fsx.readdirSync(dir); } catch { return false; }
  for (const name of names) {
    if (!MARKER_RE.test(String(name))) continue;
    const p = path.join(dir, String(name));
    try {
      const st = fsx.statSync(p);
      if (now - st.mtimeMs > MARKER_TTL_MS) fsx.unlinkSync(p);
    } catch { /* gone already or not ours to touch */ }
  }
  return true;
}

/**
 * A claim directory every VS Code-family app of this user shares (VS Code, Insiders, Cursor ... each have their own
 * globalStorage, so claims kept there would let each app report the same wait): <tmp>/cyuneo-agent-monitor-<uid>/notify.
 * The parent is created with mode 0700 and used only when it is a real directory owned by this user and closed to others
 * (else another local user could pre-create it and swallow the notifications). null when that fails; the caller then
 * falls back to its own storage.
 * @param {{ base?: string, fs?: typeof import('fs'), uid?: number, platform?: string }} [o]
 * @returns {string|null}
 */
function sharedClaimDir(o = {}) {
  const fsx = o.fs || fs;
  try {
    const uid = Number.isInteger(o.uid) ? o.uid : typeof process.getuid === 'function' ? process.getuid() : -1;
    const posix = (o.platform || process.platform) !== 'win32';
    const parent = path.join(o.base || os.tmpdir(), `cyuneo-agent-monitor-${uid >= 0 ? uid : os.userInfo().username}`);
    try { fsx.mkdirSync(parent, { recursive: true, mode: 0o700 }); } catch { /* checked below */ }
    let st = fsx.lstatSync(parent);
    if (!st.isDirectory()) return null; // lstat: a symlink is not accepted
    if (posix) {
      if (uid >= 0 && st.uid !== uid) return null;
      if (st.mode & 0o077) {
        fsx.chmodSync(parent, 0o700);
        st = fsx.lstatSync(parent);
        if (st.mode & 0o077) return null;
      }
    }
    const dir = path.join(parent, 'notify');
    fsx.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return null;
  }
}

/**
 * Claims a transition for this window: creates <dir>/<sha1(id)>.claim with the 'wx' flag, so only the first caller
 * across all windows (processes) gets true. Also prunes old markers (see maybePrune). Never throws.
 * Fails open: when the marker cannot be written for any reason other than "already exists" (no dir, permissions),
 * returns true, preferring a possible duplicate over a lost notification.
 * @param {string} dir shared by all windows, e.g. path.join(context.globalStorageUri.fsPath, 'notify')
 * @param {string} transitionId
 * @param {number} [now] epoch ms (default Date.now())
 * @param {typeof import('fs')} [fsImpl]
 * @returns {boolean}
 */
function claimOnce(dir, transitionId, now, fsImpl) {
  const fsx = fsImpl || fs;
  const t = Number.isFinite(now) ? now : Date.now();
  let p;
  try {
    if (typeof dir !== 'string' || !dir) return true;
    try { fsx.mkdirSync(dir, { recursive: true }); } catch { /* openSync reports the real problem */ }
    try { maybePrune(fsx, dir, t); } catch { /* never blocks the claim */ }
    p = path.join(dir, markerName(transitionId));
  } catch {
    return true;
  }
  let fd;
  try {
    fd = fsx.openSync(p, 'wx');
  } catch (err) {
    return !(err && err.code === 'EEXIST');
  }
  try { fsx.writeSync(fd, String(t)); } catch { /* the file's existence is the claim */ }
  try { fsx.closeSync(fd); } catch { /* ignore */ }
  return true;
}

// ---------------------------------------------------------------------------
// System notification
// ---------------------------------------------------------------------------

/**
 * Command and argv for a system notification; null when the platform is not supported.
 * User text only ever travels as separate argv items (no shell, no script source), after '--'.
 */
function notifyCommand(platform, title, body) {
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run',
        '--', title, body],
    };
  }
  if (platform === 'linux') return { cmd: 'notify-send', args: ['--app-name', APP_NAME, '--', title, escapeMarkup(body)] };
  return null;
}

/** Whether sendSystemNotification has a command for this platform (it can still fail, e.g. notify-send not installed) */
function hasSystemNotifier(platform = process.platform) {
  return notifyCommand(platform, '', '') != null;
}

/**
 * Shows a system notification. Resolves true when the command ran successfully, false otherwise (unsupported platform
 * such as win32, command missing, non-zero exit, timeout). Never throws or rejects.
 * @param {{ title: string, body: string }} msg
 * @param {{ platform?: string, execFile?: Function, timeoutMs?: number }} [o]
 * @returns {Promise<boolean>}
 */
function sendSystemNotification(msg, o = {}) {
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
      const platform = (o && o.platform) || process.platform;
      const run = (o && o.execFile) || childProcess.execFile;
      const title = cleanText(msg && msg.title, TITLE_MAX) || APP_NAME;
      const body = cleanText(msg && msg.body, BODY_MAX);
      const c = notifyCommand(platform, title, body);
      if (!c) { finish(false); return; }
      const timeoutMs = Number.isFinite(o && o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : NOTIFY_TIMEOUT_MS;
      // Backstop in case the callback never comes (execFile's own timeout kills the process). Not unref'd, so the
      // promise always settles.
      timer = setTimeout(() => finish(false), timeoutMs + 1000);
      const child = run(c.cmd, c.args, { timeout: timeoutMs, windowsHide: true, shell: false }, (err) => finish(!err));
      if (child && typeof child.on === 'function') child.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Decision and text
// ---------------------------------------------------------------------------

/**
 * What this window does with a new item.
 * - 'none': notifications are off;
 * - 'toast': this window has focus → claimOnce now, show an in-window toast if it wins;
 * - 'claimLater': no focus → wait CLAIM_DELAY_MS, claimOnce, then sendSystemNotification (toast if that resolves false).
 * @param {{ enabled?: boolean, windowFocused?: boolean }} [o]
 * @returns {'toast'|'claimLater'|'none'}
 */
function plan(o = {}) {
  if (!o || !o.enabled) return 'none';
  return o.windowFocused ? 'toast' : 'claimLater';
}

/**
 * Notification text for an item.
 * @param {{ title?: string, project?: string|null, agentName?: string|null }} item
 * @param {Function|{ t: Function }} t translate function (key, vars) or an i18n instance
 * @returns {{ title: string, body: string, toast: string }} title / body for the system notification, toast for the in-window message
 */
function formatNeedsYou(item, t) {
  const tr = typeof t === 'function' ? t : (k, v) => t.t(k, v);
  const it = item || {};
  const chat = cleanText(it.title, CHAT_TITLE_MAX);
  const agent = cleanText(it.agentName, AGENT_NAME_MAX);
  const project = cleanText(it.project, AGENT_NAME_MAX);
  const title = project ? tr('ext.notify.titleProject', { project }) : tr('ext.notify.title');
  const body = agent ? tr('ext.notify.bodyAgent', { title: chat, agent }) : tr('ext.notify.body', { title: chat });
  return { title, body, toast: breakLinks(tr('ext.notify.toast', { heading: title, body })) };
}

module.exports = {
  APP_NAME, CLAIM_DELAY_MS, NOTIFY_TIMEOUT_MS, MARKER_TTL_MS, PRUNE_EVERY_MS,
  createNeedsYouTracker, claimOnce, sendSystemNotification, plan, formatNeedsYou, itemFor, transitionIdOf,
  sharedClaimDir, hasSystemNotifier, cleanText, markerName, notifyCommand,
};
