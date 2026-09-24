'use strict';
// “已看过”（DESIGN §3.4）：{ [sessionKey]: seenAtMs } 存取。
// - 扩展：context.globalState（键 agentMonitor.seen.v1，不跨设备同步）；Memento 没有变更事件，
//   所以每次读都直接 get（读的是内存缓存，很便宜），多个窗口共用同一份。
// - 终端版：内存实现（createMemoryMemento），默认全部当作未看过；--seen-all 用 allSeen。
// - seenAtMs 只增不减；激活时清掉 14 天前的条目，最多留 1000 条。
// - “停留 ≥1.5 秒才算看过”的计时器（createDwellTracker）：标签页 / 右侧视图各一路，计时器可注入，便于测试。
// 不依赖 vscode。

const SEEN_KEY = 'agentMonitor.seen.v1';
const KEEP_MS = 14 * 24 * 3600e3;
const KEEP_MAX = 1000;
const DWELL_MS = 1500;
// 终端版 --seen-all：比任何时间都大
const ALL_SEEN = Number.MAX_SAFE_INTEGER;

/**
 * 内存版 Memento（终端版、测试用），接口同 vscode.Memento 的 get / update。
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
    /** 某会话的 seenAtMs（没看过 → 0） */
    get(sessionKey) { return allSeen ? ALL_SEEN : val(read(), sessionKey); },

    /** 读一次、返回查询函数：同一份快照里算所有灯用同一份数据 */
    reader() {
      if (allSeen) return () => ALL_SEEN;
      const m = read();
      return (k) => val(m, k);
    },

    /** 全部条目的副本 */
    all() { return { ...read() }; },

    /**
     * 记为看过（只增不减）。
     * @param {string} sessionKey
     * @param {number} [ms] 默认现在
     * @returns {Promise<boolean>} 值是否变了
     */
    mark(sessionKey, ms) { return this.markMany([sessionKey], ms); },

    /** 一次记多个（markAllSeen 用） */
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
     * 清理：删掉早于 maxAgeMs 的条目，再只留最新的 maxEntries 条（激活时调一次）。
     * @returns {Promise<number>} 删掉的条数
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
 * “持续 ≥1.5 秒才算看过”（§3.4 第 2、3 条）。
 * 每一路来源（'tab'：Claude / Codex 标签是活动标签且窗口有焦点；'view'：右侧视图显示该会话且可见、窗口有焦点）
 * 各有一个计时器：set(source, key) 在条件成立时传会话 key，不成立时传 null。
 * 同一 key 持续期间再调 set 不会重新计时；满 1.5 秒记一次。之后每份快照调 refresh()，
 * 让一直盯着看的会话里新出的结果也算看过。
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

    /** 当前各路来源正在看的会话 */
    active() {
      const out = {};
      for (const [src, s] of slots) out[src] = s.key;
      return out;
    },

    /**
     * 已经满 1.5 秒、仍在看的会话再记一次（每份快照、算灯之前调）。
     * @param {(key: string) => boolean} [shouldMark] 只记有新内容的会话，避免每 2 秒写一次 globalState；
     *   例如 (k) => (session(k).doneAtMs || 0) > store.get(k)
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
