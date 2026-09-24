'use strict';
// "Seen" state: read/write of { [sessionKey]: seenAtMs }.
// - Extension: context.globalState (key agentMonitor.seen.v1, not synced across devices). Memento has
//   no change event, so every read calls get() directly (an in-memory cache, cheap); all windows share one copy.
// - Terminal version: in-memory implementation (createMemoryMemento); everything starts unseen; --seen-all uses allSeen.
// - seenAtMs only ever increases; on activation, entries older than 14 days are dropped and at most 1000 are kept.
// - "Seen only after dwelling >= 1.5 s" timer (createDwellTracker): one slot each for the editor tab and the side view;
//   timers are injectable for testing.
// Does not depend on vscode.

const SEEN_KEY = 'agentMonitor.seen.v1';
const KEEP_MS = 14 * 24 * 3600e3;
const KEEP_MAX = 1000;
const DWELL_MS = 1500;
// terminal --seen-all: larger than any timestamp
const ALL_SEEN = Number.MAX_SAFE_INTEGER;

/**
 * In-memory Memento (terminal version and tests), with the same get / update interface as vscode.Memento.
 * @param {Record<string, any>} [init]
 */
function createMemoryMemento(init = {}) {
  const data = new Map(Object.entries(init));
  return {
    get: (k, d) => (data.has(k) ? data.get(k) : d),
    update: (k, v) => { if (v === undefined) data.delete(k); else data.set(k, v); return Promise.resolve(); },
    keys: () => [...data.keys()],
  };
}

function cleanMap(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * @param {{ get(key: string, dflt?: any): any, update(key: string, value: any): Thenable<void>|Promise<void>|void }} memento
 * @param {{ key?: string, now?: () => number, allSeen?: boolean }} [o]
 */
function createSeenStore(memento, o = {}) {
  const key = o.key || SEEN_KEY;
  const now = o.now || Date.now;
  const allSeen = !!o.allSeen;
  const read = () => cleanMap(memento.get(key, {}));
  const val = (m, k) => { const v = Number(m[k]); return v > 0 ? v : 0; };
  const write = (next) => Promise.resolve(memento.update(key, next)).then(() => true);

  return {
    key,
    /** seenAtMs for a session (never seen -> 0) */
    get(sessionKey) { return allSeen ? ALL_SEEN : val(read(), sessionKey); },

    /** Read once and return a lookup function, so all lamps in one snapshot use the same data */
    reader() {
      if (allSeen) return () => ALL_SEEN;
      const m = read();
      return (k) => val(m, k);
    },

    /** Copy of all entries */
    all() { return { ...read() }; },

    /**
     * Mark as seen (value only increases).
     * @param {string} sessionKey
     * @param {number} [ms] defaults to now
     * @returns {Promise<boolean>} whether the value changed
     */
    mark(sessionKey, ms) { return this.markMany([sessionKey], ms); },

    /** Mark several at once (used by markAllSeen) */
    markMany(keys, ms) {
      if (allSeen) return Promise.resolve(false);
      const t = Number.isFinite(ms) ? ms : now();
      const cur = read();
      let next = null;
      for (const k of keys || []) {
        if (typeof k !== 'string' || !k) continue;
        if (val(cur, k) >= t) continue;
        if (!next) next = { ...cur };
        next[k] = t;
      }
      return next ? write(next) : Promise.resolve(false);
    },

    /**
     * Prune: drop entries older than maxAgeMs, then keep only the newest maxEntries (called once on activation).
     * @returns {Promise<number>} number of entries removed
     */
    prune(opts = {}) {
      const t = Number.isFinite(opts.now) ? opts.now : now();
      const maxAge = opts.maxAgeMs ?? KEEP_MS;
      const maxEntries = opts.maxEntries ?? KEEP_MAX;
      const cur = read();
      let entries = Object.entries(cur).filter(([, v]) => Number(v) > 0 && t - Number(v) <= maxAge);
      if (entries.length > maxEntries) entries = entries.sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, maxEntries);
      const removed = Object.keys(cur).length - entries.length;
      if (!removed) return Promise.resolve(0);
      return write(Object.fromEntries(entries)).then(() => removed);
    },
  };
}

/**
 * "Seen only after being viewed continuously for >= 1.5 s".
 * Each source ('tab': a Claude / Codex tab is the active tab and the window is focused; 'view': the side view
 * is visible, shows that session, and the window is focused) has its own timer: set(source, key) passes the
 * session key while the condition holds and null when it doesn't.
 * Calling set again with the same key does not restart the timer; after 1.5 s it is marked once. Afterwards call
 * refresh() on every snapshot so new results in a session you keep watching also count as seen.
 * @param {{ mark(key: string, ms?: number): any }} store
 * @param {{ delayMs?: number, now?: () => number, setTimeout?: Function, clearTimeout?: Function,
 *   onMarked?: (key: string, source: string) => void }} [o]
 */
function createDwellTracker(store, o = {}) {
  const delay = o.delayMs ?? DWELL_MS;
  const now = o.now || Date.now;
  const st = o.setTimeout || setTimeout;
  const ct = o.clearTimeout || clearTimeout;
  const slots = new Map(); // source -> { key, since, timer, armed }

  const fire = (source, slot) => {
    slot.timer = null;
    slot.armed = true;
    Promise.resolve(store.mark(slot.key)).then((changed) => {
      if (changed !== false && o.onMarked) o.onMarked(slot.key, source);
    }, () => {});
  };

  return {
    /** @param {string} source @param {string|null} key */
    set(source, key) {
      const cur = slots.get(source);
      if (cur && cur.key === key) return;
      if (cur && cur.timer) ct(cur.timer);
      if (!key) { slots.delete(source); return; }
      const slot = { key, since: now(), timer: null, armed: false };
      slot.timer = st(() => fire(source, slot), delay);
      if (slot.timer && typeof slot.timer.unref === 'function') slot.timer.unref();
      slots.set(source, slot);
    },

    /** Session currently being viewed by each source */
    active() {
      const out = {};
      for (const [src, s] of slots) out[src] = s.key;
      return out;
    },

    /**
     * Re-mark sessions that have been viewed for >= 1.5 s and are still being viewed (call on every snapshot, before computing lamps).
     * @param {(key: string) => boolean} [shouldMark] only mark sessions with new content, to avoid writing globalState every 2 s;
     *   e.g. (k) => (session(k).doneAtMs || 0) > store.get(k)
     */
    refresh(shouldMark) {
      const keys = new Set();
      for (const s of slots.values()) {
        if (!(s.armed || now() - s.since >= delay)) continue;
        if (shouldMark && !shouldMark(s.key)) continue;
        keys.add(s.key);
      }
      const list = [...keys];
      if (!list.length) return Promise.resolve(false);
      return typeof store.markMany === 'function'
        ? Promise.resolve(store.markMany(list))
        : Promise.all(list.map((k) => store.mark(k))).then((r) => r.some(Boolean));
    },

    dispose() {
      for (const s of slots.values()) if (s.timer) ct(s.timer);
      slots.clear();
    },
  };
}

module.exports = {
  SEEN_KEY, KEEP_MS, KEEP_MAX, DWELL_MS, ALL_SEEN,
  createMemoryMemento, createSeenStore, createDwellTracker,
};
