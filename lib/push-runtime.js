'use strict';
// Remote push at run time: wires lib/push.js (channels, events, policy, limits) into the extension, without vscode.
// - update() after each render, with all sessions (not this window's scope), their lamps and the quota snapshot. The
//   tracker is fed even while push is off, so turning it on never reports a wait or a limit that was already there.
// - Push off, or no channel in settings: nothing is planned, claimed, queued or sent. No timer, no network.
// - needsYou waits delaySeconds (an escalation after the desktop notification), one pending wait per session (a newer
//   wait of the same session replaces it and starts the delay again). Shortly before the delay is up it asks for a rescan
//   (a follower asks the leader), and decides on a snapshot newer than that request (waiting for one at most freshWaitMs):
//   pushed only if the chat still waits, and claimed with the id of its current wait (which may have moved on while the
//   lamp stayed on, e.g. a second tool call asked right after the first was approved), so every window claims the same.
//   A decision that comes far later than planned (the computer slept) is dropped: the user is back at the computer.
// - Before queuing, notify.claimOnce(<shared claim dir>, claimId): whichever window claims first sends, so push works the
//   same in a leader, a follower or a window that scans alone. The limiter's send history is a JSON file in that same
//   dir (push-sent.json), so the hourly and daily caps hold across windows.
// - Settings hold the non-secret half of each channel; SecretStorage holds the secrets under secretKeyOf(key), and every
//   send uses mergeConfig(settings entry, secrets). Errors are logged through describeError (always redacted); a raw
//   config is never logged. After FAIL_WARN_AFTER failures in a row a channel gets one warning, and no other until a
//   send to it works again.

const path = require('path');
const nodeCrypto = require('crypto');
const push = require('./push');
const notify = require('./notify');

const SECRET_PREFIX = 'agentMonitor.push.';
const STORE_FILE = 'push-sent.json';
const FAIL_WARN_AFTER = 3;
const RESCAN_LEAD_MS = 1200;   // ask for a rescan this long before a needsYou delay is up
const FRESH_WAIT_MS = 10000;   // then wait at most this long for a snapshot scanned after that request
const LATE_MS = 20000;         // a needsYou decided this long after freshWaitMs past its deadline is dropped (sleep)
const KEY_RANDOM_BYTES = 6;    // a new channel key: `${channelId}-` + 8 base64url characters

/** SecretStorage key of a channel (its settings entry, or its key) */
function secretKeyOf(entryOrKey) {
  const key = typeof entryOrKey === 'string' ? entryOrKey : push.channelKeyOf(entryOrKey);
  return SECRET_PREFIX + key;
}

/** Settings entries that are channel objects (anything else in the array is ignored) */
function channelEntries(list) {
  return (Array.isArray(list) ? list : []).filter((e) => e && typeof e === 'object' && !Array.isArray(e) && push.channelOf(e));
}

/**
 * Display name of a channel: its localized label, with a number when there are several channels of that type.
 * @param {any} entry
 * @param {any[]} entries all settings entries (to number channels of the same type)
 * @param {Function|{ t: Function }} t
 */
function channelName(entry, entries, t) {
  const tr = typeof t === 'function' ? t : (k, v) => t.t(k, v);
  const ch = push.channelOf(entry);
  const label = ch ? tr(ch.label) : String((entry && entry.channel) || '?');
  const same = channelEntries(entries).filter((e) => e.channel === entry.channel);
  const i = same.indexOf(entry);
  return same.length > 1 && i >= 0 ? `${label} ${i + 1}` : label;
}

/**
 * A key for a new channel of this type: `${channelId}-` and a random part, unique among the settings entries (unknown
 * ones included). Never reused, so a secret left on another computer under an old key (Settings Sync removed the entry,
 * not that computer's SecretStorage) is never matched to a new entry.
 * @param {string} channelId
 * @param {any[]} entries the raw settings array
 * @param {(n: number) => Buffer} [randomBytes] for tests
 */
function newChannelKey(channelId, entries, randomBytes) {
  const rand = typeof randomBytes === 'function' ? randomBytes : nodeCrypto.randomBytes;
  const used = new Set((Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object').map((e) => push.channelKeyOf(e)));
  for (let i = 0; ; i++) {
    const key = `${channelId}-${Buffer.from(rand(KEY_RANDOM_BYTES)).toString('base64url')}`;
    if (!used.has(key)) return key;
    if (i >= 100) return `${channelId}-${Date.now().toString(36)}-${i}`; // a broken random source
  }
}

/**
 * @param {{
 *   read: () => { enabled?: boolean, events?: any, delaySeconds?: number, includeTitle?: boolean, channels?: any[] },
 *   secret: (key: string) => any,
 *   claimDir: () => string,
 *   i18n: any,
 *   log?: (line: string) => void,
 *   warn?: (text: string) => void,
 *   notice?: (text: string) => void,
 *   rescan?: () => void,
 *   fetch?: Function,
 *   clock?: () => number,
 *   timing?: { wait?: (delayMs: number) => number, rescanLeadMs?: number, freshWaitMs?: number, lateMs?: number, limiter?: object },
 * }} deps read: push settings from user settings only (inspect().globalValue); secret: SecretStorage get; warn: a warning
 *   with an "Open setup" button; notice: an information message; fetch: defaults to globalThis.fetch at send time
 */
function createPushRuntime(deps) {
  const i18n = deps.i18n;
  const t = (k, v) => i18n.t(k, v);
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now;
  const timing = deps.timing || {};
  const waitMs = typeof timing.wait === 'function' ? timing.wait : (ms) => ms;
  const leadMs = Number.isFinite(timing.rescanLeadMs) ? timing.rescanLeadMs : RESCAN_LEAD_MS;
  const freshWaitMs = Number.isFinite(timing.freshWaitMs) ? timing.freshWaitMs : FRESH_WAIT_MS;
  const lateMs = Number.isFinite(timing.lateMs) ? timing.lateMs : LATE_MS;
  const log = (line) => { try { if (deps.log) deps.log(line); } catch { /* ignore */ } };

  let stopped = false;
  let tracker = push.createPushTracker();
  let limiter = null;
  let limiterDir = null;
  let flushTimer = null;
  let latest = { sessions: [], lamps: null };
  let lastSeq = 0;
  const waits = new Map();        // session key → pending needsYou { ev, seq, awaiting, timers, dueAt }
  const failures = new Map();     // channel key → failed sends in a row
  const warned = new Set();       // channel keys warned about since their last good send
  const capped = new Set();       // channel keys told about their daily cap since their last good send

  function settings() {
    let raw = null;
    try { raw = deps.read(); } catch { raw = null; }
    const s = push.normalizeSettings(raw);
    s.channels = channelEntries(raw && raw.channels);
    return s;
  }

  /** Push is on and at least one channel is in settings (whether its secrets are here is checked when sending) */
  const active = (s) => s.enabled && s.channels.some((e) => e.enabled !== false);

  function claimDir() {
    try { return String(deps.claimDir() || ''); } catch { return ''; }
  }

  function getLimiter() {
    const dir = claimDir();
    if (!limiter || dir !== limiterDir) {
      limiterDir = dir;
      const store = dir ? push.fileStore(path.join(dir, STORE_FILE)) : null;
      limiter = push.createLimiter({ ...(timing.limiter || {}), store });
    }
    return limiter;
  }

  function timer(fn, ms, set) {
    const h = setTimeout(() => {
      if (set) set.delete(h);
      if (stopped) return;
      try {
        Promise.resolve(fn()).catch(logError);
      } catch (err) {
        logError(err);
      }
    }, Math.max(0, ms));
    if (set) set.add(h);
    return h;
  }

  function logError(err) {
    log(t('ext.log.failed', { what: 'push', error: String((err && err.message) || err) }));
  }

  /**
   * Channels usable on this computer: the settings entry merged with its SecretStorage copy.
   * @param {{ all?: boolean }} [o] all: also channels turned off and entries without secrets here (config null)
   * @returns {Promise<{ key: string, entry: any, config: any|null, name: string, enabled: boolean }[]>}
   */
  async function configs(o = {}) {
    const entries = settings().channels;
    const out = [];
    const seen = new Set();
    for (const entry of entries) {
      const key = push.channelKeyOf(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const enabled = entry.enabled !== false;
      if (!enabled && !o.all) continue;
      let sec = null;
      try {
        const raw = await deps.secret(secretKeyOf(key));
        sec = typeof raw === 'string' && raw ? JSON.parse(raw) : null;
      } catch {
        sec = null;
      }
      const config = push.mergeConfig(entry, sec);
      if (!config && !o.all) continue;
      out.push({ key, entry, config, name: channelName(entry, entries, t), enabled });
    }
    return out;
  }

  /**
   * After each render.
   * @param {{ sessions: any[], lamps: any, quota: any, now?: number, seq?: number }} input seq: count of real snapshots
   *   (replays not counted); a waiting needsYou check goes ahead once it grows past the count at its rescan request
   * @returns {any[]} the tracker's events (for tests and logs)
   */
  function update(input = {}) {
    if (stopped) return [];
    const now = Number.isFinite(input.now) ? input.now : clock();
    latest = { sessions: Array.isArray(input.sessions) ? input.sessions : [], lamps: input.lamps || null };
    const events = tracker.update({ sessions: latest.sessions, lamps: latest.lamps, quota: input.quota, now });
    if (Number.isFinite(input.seq) && input.seq > lastSeq) {
      lastSeq = input.seq;
      for (const w of [...waits.values()]) if (w.awaiting && lastSeq > w.seq) decide(w);
    }
    if (!events.length) return events;
    const s = settings();
    if (!active(s)) return events;
    for (const ev of events) {
      const p = push.plan({ event: ev, settings: s });
      if (p.action === 'wait') schedule(ev, p);
      else if (p.action === 'send') enqueue(ev, p).catch(logError);
    }
    return events;
  }

  // needsYou: rescan shortly before the delay is up, then decide on data scanned after that request
  function schedule(ev, p) {
    const prev = waits.get(ev.key);
    if (prev && prev.ev.transitionId === ev.transitionId) return;
    if (prev) clearTimers(prev); // a newer wait of this session: its delay starts again
    const delay = Math.max(0, waitMs(p.delayMs));
    const w = { ev, seq: lastSeq, awaiting: false, timers: new Set(), dueAt: clock() + delay };
    waits.set(ev.key, w);
    timer(() => {
      w.seq = lastSeq;
      if (deps.rescan) deps.rescan();
    }, delay - leadMs, w.timers);
    timer(() => {
      if (lastSeq > w.seq) { decide(w); return; }
      w.awaiting = true; // decided by the next real snapshot, or with what there is after freshWaitMs
      timer(() => decide(w), freshWaitMs, w.timers);
    }, delay, w.timers);
  }

  function clearTimers(w) {
    for (const h of w.timers) clearTimeout(h);
    w.timers.clear();
  }

  function decide(w) {
    if (waits.get(w.ev.key) !== w) return;
    waits.delete(w.ev.key);
    clearTimers(w);
    const s = settings();
    if (!active(s)) return;
    // Timers stop while the computer sleeps, the clock does not: this far past the deadline, the user is back
    if (clock() - w.dueAt > freshWaitMs + lateMs) return;
    // Still waiting, possibly on another prompt than the one that started the delay: push (and claim) its current wait
    const cur = push.currentEventOf(w.ev, latest.sessions, latest.lamps);
    const p = push.plan({ event: cur || w.ev, settings: s, stillActive: !!cur });
    if (p.action === 'send') enqueue(cur, p).catch(logError);
  }

  async function enqueue(ev, p) {
    const list = await configs();
    // No usable channel here: do not claim, so a window of another VS Code-family app with channels can still send it
    if (stopped || !list.length || !active(settings())) return;
    const now = clock();
    if (!notify.claimOnce(claimDir(), p.claimId, now)) return; // another window sends it
    const lim = getLimiter();
    for (const c of list) lim.add(c.key, ev, now, { dailyMax: push.withDefaults(c.config).dailyMax });
    arm();
  }

  function arm() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    const at = limiter ? limiter.nextAt() : null;
    if (at == null || stopped) return;
    flushTimer = timer(() => {
      flushTimer = null;
      return flush();
    }, at - clock());
  }

  async function flush() {
    if (stopped || !limiter) return;
    const s = settings();
    if (!active(s)) { reset(); return; }
    const now = clock();
    const { batches, dropped } = limiter.due(now);
    arm(); // another window's send can push a batch back: always re-arm
    const list = await configs();
    const byKey = new Map(list.map((c) => [c.key, c]));
    const nameOf = (key) => (byKey.get(key) || { name: key }).name;
    for (const d of dropped) {
      log(t('push.log.dropped', { channel: nameOf(d.channel), n: d.events.length, reason: t(`push.log.reason.${d.reason}`) }));
      if (d.reason === 'daily' && !capped.has(d.channel) && deps.notice) {
        capped.add(d.channel);
        deps.notice(t('push.ui.capped', { channel: nameOf(d.channel) }));
      }
    }
    await Promise.all(batches.map(async (b) => {
      const c = byKey.get(b.channel);
      if (!c) return; // removed or turned off meanwhile
      const msg = push.formatPush(b.events, i18n, { includeTitle: s.includeTitle, now });
      const r = await push.send(c.config, msg, { fetch: fetchImpl() });
      record(c, r, b.events.length);
    }));
  }

  function fetchImpl() {
    return deps.fetch || globalThis.fetch;
  }

  function record(c, r, n) {
    if (stopped) return;
    if (r && r.ok) {
      failures.delete(c.key);
      warned.delete(c.key);
      capped.delete(c.key);
      log(t('push.log.sent', { channel: c.name, n }));
      return;
    }
    const error = push.describeError(r, i18n, { channel: c.config.channel });
    const text = t('push.ui.sendFailed', { channel: c.name, error });
    log(text);
    const count = (failures.get(c.key) || 0) + 1;
    failures.set(c.key, count);
    if (count >= FAIL_WARN_AFTER && !warned.has(c.key)) {
      warned.add(c.key);
      if (deps.warn) deps.warn(text);
    }
  }

  /**
   * Sends the test message to one channel, now (no claim, no limiter): an explicit user action, so it works while push is
   * off. A good result also clears the channel's failure count.
   * @param {string} key
   * @returns {Promise<{ ok: boolean, code: string|null, error: string|null, status?: number, field?: string, problem?: string }>}
   */
  async function test(key) {
    const c = (await configs({ all: true })).find((x) => x.key === key);
    if (!c || !c.config) return { ok: false, status: 0, code: 'config', error: 'not set up', field: 'channel', problem: 'channel' };
    const r = await push.send(c.config, push.testMessage(i18n), { fetch: fetchImpl() });
    if (r.ok) {
      failures.delete(key);
      warned.delete(key);
      log(t('push.ui.testOk', { channel: c.name }));
    } else {
      log(t('push.ui.testFailedChannel', { channel: c.name, error: push.describeError(r, i18n, { channel: c.config.channel }) }));
    }
    return r;
  }

  /** Drops pending waits and queued batches (push turned off, or its last channel removed) */
  function reset() {
    for (const w of waits.values()) clearTimers(w);
    waits.clear();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    limiter = null; // the send history stays in the store file
  }

  /** A push setting changed */
  function onSettings() {
    if (!active(settings())) reset();
  }

  /** The scan settings changed: sessions that only show up now are not new events */
  function reseed() {
    tracker = push.createPushTracker();
  }

  function dispose() {
    stopped = true;
    reset();
  }

  return {
    update, configs, test, onSettings, reseed, dispose,
    // for tests
    _state: () => ({ waits: waits.size, flushTimer: !!flushTimer, failures: new Map(failures), warned: new Set(warned) }),
  };
}

module.exports = {
  SECRET_PREFIX, STORE_FILE, FAIL_WARN_AFTER, secretKeyOf, channelEntries, channelName, newChannelKey, createPushRuntime,
};
