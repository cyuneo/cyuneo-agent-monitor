'use strict';
// Stable ordering (a hard requirement): once placed, sessions on the left and agents on the right never jump around.
// - The sort key is startedMs only; if missing, the "first seen" time. The key is locked on first sight and kept in an in-memory Map.
// - Activity time (updatedMs / lastActivityMs), lamps and tokens are never used as sort keys.
// - Left: two groups, "open" and "recent", each sorted by startedMs descending (newest session on top); rows move only when they change group.
// - Right: main conversation on top; the rest by start time ascending (new ones appended below); workflow agents sit inside
//   their workflow's group, also ascending.
// Plain JS with no vscode dependency; shared by the extension and the terminal version.

const GROUP = Object.freeze({ OPEN: 'open', RECENT: 'recent' });

// Row ids (unique within a session; used by lamp.js and by incremental updates in the right-hand webview)
const ROW_MAIN = 'main';
const agentRowId = (agentId) => `a/${agentId}`;
const workflowRowId = (wfId) => `wf/${wfId}`;
const workflowAgentRowId = (wfId, agentId) => `wf/${wfId}/${agentId}`;

const DEFAULT_MAX_ENTRIES = 5000;
const validStart = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * A set of id -> locked sort key. The key is fixed on first sight (startedMs, or now() if missing) and never changes.
 * seq is the first-seen sequence number, used to break ties between equal keys (deterministic, ignores activity).
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

  // Call before each sort: bumps the counter; when there are too many entries, drop the least recently seen (if they reappear they get a new key, the only exception)
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
 * Stateful sorter for the left-hand session list.
 * @param {{ now?: () => number, isOpen?: (s: any) => boolean, maxEntries?: number }} [o]
 *   isOpen defaults to session.live (a Claude session alive in the session registry / a Codex thread with a turn in progress)
 */
function createSessionOrder(o = {}) {
  const now = o.now || Date.now;
  const isOpen = o.isOpen || ((s) => !!(s && s.live));
  const keys = new StableKeys(now, o.maxEntries);

  /**
   * @template {{ key: string, startedMs?: number|null, live?: boolean }} S
   * @param {S[]} sessions any order (the snapshot sorts by updatedMs; ignored here)
   * @param {{ grouped?: boolean }} [opts] grouped=false disables grouping (usable for the sidebar overview tree)
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
    /** Locked sort key of a session (for tests and debugging) */
    sortKey: (key) => keys.peek(key),
  };
}

/**
 * Stateful sorter for the right-hand agent table. One key table per session.
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
   * @param {any} session Session (main, agents, workflows)
   * @param {{ hideCompleted?: boolean }} [opts] hideCompleted: hide done agents and completed workflows (the main conversation always stays)
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

    // Top level: subagents + workflow groups, ascending by locked key
    const top = [];
    for (const a of session.agents || []) {
      if (!a || a.id == null) continue;
      const id = agentRowId(a.id);
      const e = keys.get(id, a.startedMs);
      if (hide && isDone(a)) continue; // lock the key before filtering, so toggling hide/show does not affect order
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
    /** Locked sort key of a row within a session (for tests and debugging) */
    sortKey: (sessionKey, rowId) => {
      const p = perSession.get(sessionKey);
      return p ? p.keys.peek(rowId) : undefined;
    },
    /** Drop a session's key table when the session is deleted */
    forget: (sessionKey) => { perSession.delete(sessionKey); },
  };
}

/**
 * Difference between two row-id orders, for incremental webview updates:
 * removed: rows to delete; added: new rows with the id of the row before each (null means put first);
 * moved: whether the relative order of rows present in both changed (only then must the DOM be reordered;
 * under stable ordering this normally happens only when a row changes group).
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
