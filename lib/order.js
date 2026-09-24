'use strict';
// 稳定排序（DESIGN §11.3，硬性要求）：左侧会话、右侧智能体的顺序一旦定下就不跳。
// - 排序键只用 startedMs；缺失时用“第一次看到的时间”。键在第一次看到时锁定，存在内存 Map 里不再改。
// - 绝不使用活动时间（updatedMs / lastActivityMs）、灯、token 作为排序键。
// - 左侧：分“打开中 / 最近”两组，组内按 startedMs 倒序（新会话在最上面）；只在换组时移动。
// - 右侧：主对话在最上面；其余按开始时间正序（新的追加在下面），工作流的智能体归在该工作流组里、组内正序。
// 纯 JS，不依赖 vscode；扩展和终端版共用。

const GROUP = Object.freeze({ OPEN: 'open', RECENT: 'recent' });

// 行 id（同一会话内唯一；lamp.js、右侧 webview 增量更新都用它）
const ROW_MAIN = 'main';
const agentRowId = (agentId) => `a/${agentId}`;
const workflowRowId = (wfId) => `wf/${wfId}`;
const workflowAgentRowId = (wfId, agentId) => `wf/${wfId}/${agentId}`;

const DEFAULT_MAX_ENTRIES = 5000;
const validStart = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * 一组 id → 锁定的排序键。第一次看到时定键（startedMs，缺失用 now()），之后不变。
 * seq 是第一次看到的先后序号，同键时用来打破平局（结果确定、也不看活动）。
 */
class StableKeys {
  /** @param {() => number} now @param {number} [maxEntries] */
  constructor(now, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.map = new Map(); // id -> { k, seq, touched }
    this.seq = 0;
    this.tick = 0;
  }

  /**
   * @param {string} id
   * @param {number|null|undefined} startedMs
   * @returns {{ k: number, seq: number }}
   */
  get(id, startedMs) {
    let e = this.map.get(id);
    if (!e) {
      e = { k: validStart(startedMs) ? startedMs : this.now(), seq: ++this.seq, touched: 0 };
      this.map.set(id, e);
    }
    e.touched = this.tick;
    return e;
  }

  has(id) { return this.map.has(id); }
  peek(id) { const e = this.map.get(id); return e ? e.k : undefined; }

  // 每次排序前调用：计数加一；太多时删掉最久没出现的（它们再出现会重新定键，这是唯一的例外）
  begin() {
    this.tick++;
    if (this.map.size <= this.maxEntries) return;
    const old = [...this.map.entries()].sort((a, b) => a[1].touched - b[1].touched);
    for (const [id] of old.slice(0, this.map.size - this.maxEntries)) this.map.delete(id);
  }
}

const asc = (a, b) => (a.k - b.k) || (a.seq - b.seq);
const desc = (a, b) => (b.k - a.k) || (b.seq - a.seq);

/**
 * 左侧会话列表的有状态排序器。
 * @param {{ now?: () => number, isOpen?: (s: any) => boolean, maxEntries?: number }} [o]
 *   isOpen 默认看 session.live（§11.1：登记表存活的 Claude 会话 / 有进行中回合的 Codex 线程）
 */
function createSessionOrder(o = {}) {
  const now = o.now || Date.now;
  const isOpen = o.isOpen || ((s) => !!(s && s.live));
  const keys = new StableKeys(now, o.maxEntries);

  /**
   * @template {{ key: string, startedMs?: number|null, live?: boolean }} S
   * @param {S[]} sessions 顺序无所谓（快照按 updatedMs 排，这里不看）
   * @param {{ grouped?: boolean }} [opts] grouped=false 时不分组（侧边栏总览树可用）
   * @returns {{ list: S[], keys: string[], groups: { id: 'open'|'recent', sessions: S[] }[], showGroupHeaders: boolean }}
   */
  function arrange(sessions, opts = {}) {
    keys.begin();
    const grouped = opts.grouped !== false;
    const open = [];
    const recent = [];
    for (const s of sessions || []) {
      if (!s || typeof s.key !== 'string') continue;
      const e = keys.get(s.key, s.startedMs);
      const item = { s, k: e.k, seq: e.seq };
      (grouped && isOpen(s) ? open : recent).push(item);
    }
    open.sort(desc);
    recent.sort(desc);
    const groups = [];
    if (open.length) groups.push({ id: GROUP.OPEN, sessions: open.map((x) => x.s) });
    if (recent.length) groups.push({ id: GROUP.RECENT, sessions: recent.map((x) => x.s) });
    const list = groups.flatMap((g) => g.sessions);
    return { list, keys: list.map((s) => s.key), groups, showGroupHeaders: groups.length > 1 };
  }

  return {
    arrange,
    /** 某会话锁定的排序键（测试、调试用） */
    sortKey: (key) => keys.peek(key),
  };
}

/**
 * 右侧智能体表的有状态排序器。每个会话一份键表。
 * @param {{ now?: () => number, maxEntries?: number, maxSessions?: number }} [o]
 */
function createAgentOrder(o = {}) {
  const now = o.now || Date.now;
  const maxSessions = o.maxSessions || 200;
  const perSession = new Map(); // sessionKey -> { keys: StableKeys, used: number }
  let tick = 0;

  function keysFor(sessionKey) {
    let p = perSession.get(sessionKey);
    if (!p) {
      p = { keys: new StableKeys(now, o.maxEntries), used: 0 };
      perSession.set(sessionKey, p);
      if (perSession.size > maxSessions) {
        const oldest = [...perSession.entries()].sort((a, b) => a[1].used - b[1].used)[0];
        if (oldest && oldest[0] !== sessionKey) perSession.delete(oldest[0]);
      }
    }
    p.used = ++tick;
    return p.keys;
  }

  /**
   * @param {any} session Session（main、agents、workflows）
   * @param {{ hideCompleted?: boolean }} [opts] hideCompleted：隐藏 done 的智能体和 completed 的工作流（主对话总在）
   * @returns {Array<{ id: string, kind: 'main'|'agent'|'workflow'|'workflowAgent', depth: number,
   *   parentId: string|null, agent: any|null, workflow: any|null }>}
   */
  function arrange(session, opts = {}) {
    if (!session || typeof session.key !== 'string') return [];
    const keys = keysFor(session.key);
    keys.begin();
    const hide = !!opts.hideCompleted;
    const isDone = (a) => !!(a && a.status && a.status.code === 'done');
    const rows = [];
    if (session.main) {
      rows.push({ id: ROW_MAIN, kind: 'main', depth: 0, parentId: null, agent: session.main, workflow: null });
    }

    // 顶层：子智能体 + 工作流组，按锁定的键正序
    const top = [];
    for (const a of session.agents || []) {
      if (!a || a.id == null) continue;
      const id = agentRowId(a.id);
      const e = keys.get(id, a.startedMs);
      if (hide && isDone(a)) continue; // 先定键再过滤：隐藏/显示切换不影响顺序
      top.push({ k: e.k, seq: e.seq, rows: [{ id, kind: 'agent', depth: 1, parentId: null, agent: a, workflow: null }] });
    }
    for (const w of session.workflows || []) {
      if (!w || w.id == null) continue;
      const wid = workflowRowId(w.id);
      const agents = (w.agents || []).filter((a) => a && a.id != null);
      let start = validStart(w.startedMs) ? w.startedMs : null;
      if (start == null) {
        for (const a of agents) if (validStart(a.startedMs) && (start == null || a.startedMs < start)) start = a.startedMs;
      }
      const e = keys.get(wid, start);
      const inner = [];
      for (const a of agents) {
        const id = workflowAgentRowId(w.id, a.id);
        const ae = keys.get(id, a.startedMs);
        if (hide && isDone(a)) continue;
        inner.push({ k: ae.k, seq: ae.seq, row: { id, kind: 'workflowAgent', depth: 2, parentId: wid, agent: a, workflow: w } });
      }
      if (hide && w.state === 'completed') continue;
      inner.sort(asc);
      top.push({
        k: e.k,
        seq: e.seq,
        rows: [{ id: wid, kind: 'workflow', depth: 1, parentId: null, agent: null, workflow: w }, ...inner.map((x) => x.row)],
      });
    }
    top.sort(asc);
    for (const t of top) rows.push(...t.rows);
    return rows;
  }

  return {
    arrange,
    /** 某会话里某行锁定的排序键（测试、调试用） */
    sortKey: (sessionKey, rowId) => {
      const p = perSession.get(sessionKey);
      return p ? p.keys.peek(rowId) : undefined;
    },
    /** 会话被删掉时可以丢掉它的键表 */
    forget: (sessionKey) => { perSession.delete(sessionKey); },
  };
}

/**
 * 两次行 id 顺序的差异，给 webview 增量更新用：
 * removed：要删的行；added：新行及它前面那一行的 id（null 表示放最前）；
 * moved：共同存在的行相对顺序是否变了（变了才需要重排 DOM，按 §11.3 正常不会发生，除非换组）。
 * @param {string[]} prev
 * @param {string[]} next
 * @returns {{ removed: string[], added: { id: string, afterId: string|null }[], moved: boolean }}
 */
function diffOrder(prev, next) {
  const p = prev || [];
  const n = next || [];
  const inNext = new Set(n);
  const inPrev = new Set(p);
  const removed = p.filter((id) => !inNext.has(id));
  const added = [];
  n.forEach((id, i) => { if (!inPrev.has(id)) added.push({ id, afterId: i > 0 ? n[i - 1] : null }); });
  const a = p.filter((id) => inNext.has(id));
  const b = n.filter((id) => inPrev.has(id));
  const moved = a.length !== b.length || a.some((id, i) => id !== b[i]);
  return { removed, added, moved };
}

module.exports = {
  GROUP, ROW_MAIN, agentRowId, workflowRowId, workflowAgentRowId,
  StableKeys, createSessionOrder, createAgentOrder, diffOrder,
};
