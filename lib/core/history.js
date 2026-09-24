'use strict';
// Usage history: estimated cost and tokens per local day for the last N days (default 30, max 90), Claude Code and Codex.
// - Same listing, parsing, de-duplication and pricing as today's totals (the helpers live in lib/core/daily.js).
// - Per-file cache keyed by path: { size, mtimeMs, ino, offset, end, perDay, cx }. Unchanged files are skipped without being
//   opened; appended files are read from the saved offset; a truncated or replaced file is read again from the start
//   (the global de-duplication keeps what was already counted, exactly like today's totals).
// - Only files modified inside the window are read; lines older than the window are dropped; old days fall out as the window moves.
// - Each step reads at most budgetBytes and stops after sliceMs; progress is { doneBytes, totalBytes, filesDone, filesTotal }.
// - Optional persistence to a JSON-lines file (header, one line per file, de-duplication batches, trailer with counts):
//   written to a temp file and renamed, at most every saveMs; loaded at start. Anything unreadable or inconsistent → rebuild.
//   The cache is also rebuilt when the price tables, the scanned roots or the format change, or when a longer window is asked for.
// - Day boundaries are local midnight (same as today's totals).
// Read-only with respect to transcripts, plain Node.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JsonlTail } = require('./jsonl');
const pricing = require('./pricing');
const daily = require('./daily');

const { CLAUDE_FILTER, CODEX_FILTER, walkTranscripts, claudeIncrement, newCodexFileState, feedCodexEntry, localDayStart } = daily;

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const DEFAULT_HISTORY_BUDGET = 16 * 1024 * 1024;
const DEFAULT_SLICE_MS = 100;       // a step stops after this long even if budget is left (keeps the worker responsive)
const DEFAULT_LIST_MS = 30000;      // re-list files at most this often (force bypasses it)
const DEFAULT_SAVE_MS = 30000;      // persist at most this often while scanning (and once when a pass completes)
const STEP_BYTES = 2 * 1024 * 1024; // read granularity between time checks
const CACHE_VERSION = 1;
const CACHE_KIND = 'agent-monitor-history';
const BATCH = 2000;                 // de-duplication entries per cache line
const WRITE_CHUNK = 256 * 1024;     // cache writes are flushed in chunks of about this many characters

const CLAUDE_KEYS = Object.freeze(['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output']);
const CODEX_KEYS = Object.freeze(['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning']);
const PROVIDERS = Object.freeze(['claude', 'codex']);

const pad2 = (n) => (n < 10 ? '0' : '') + n;

/** Local calendar day of a timestamp: 'YYYY-MM-DD' */
function dayKeyOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local midnight n days after the local day containing ms (DST-safe) */
function addDays(ms, n) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** Requested day count → 1..MAX_DAYS (anything invalid → DEFAULT_DAYS) */
function clampDays(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

// Price tables + format version: cached amounts are only valid for the prices they were computed with
let fingerprint = null;
function pricingFingerprint() {
  if (!fingerprint) {
    fingerprint = crypto.createHash('sha1')
      .update(JSON.stringify([CACHE_VERSION, pricing.PRICES_UPDATED, pricing.ANTHROPIC_PRICES, pricing.OPENAI_PRICES]))
      .digest('hex').slice(0, 16);
  }
  return fingerprint;
}

// ---------------------------------------------------------------------------
// Claude de-duplication store: message.id → tokens seen last time + latest timestamp.
// Values live in one Float64Array (6 slots per id) instead of an object per id: a month of transcripts can hold ~100k ids.
// ---------------------------------------------------------------------------

const MSG_W = 6; // ts, input, cacheWrite5m, cacheWrite1h, cacheRead, output

class MsgStore {
  constructor() {
    this.index = new Map();
    this.data = new Float64Array(MSG_W * 1024);
    this.n = 0;
  }

  get size() { return this.n; }

  get(id) {
    const i = this.index.get(id);
    if (i === undefined) return undefined;
    const d = this.data;
    const o = i * MSG_W;
    return { input: d[o + 1], cacheWrite5m: d[o + 2], cacheWrite1h: d[o + 3], cacheRead: d[o + 4], output: d[o + 5] };
  }

  set(id, t, ts) {
    let i = this.index.get(id);
    if (i === undefined) {
      i = this.n++;
      if (this.n * MSG_W > this.data.length) {
        const bigger = new Float64Array(this.data.length * 2);
        bigger.set(this.data);
        this.data = bigger;
      }
      this.index.set(id, i);
      this.data[i * MSG_W] = -Infinity;
    }
    const d = this.data;
    const o = i * MSG_W;
    if (Number.isFinite(ts) && ts > d[o]) d[o] = ts;
    d[o + 1] = t.input; d[o + 2] = t.cacheWrite5m; d[o + 3] = t.cacheWrite1h; d[o + 4] = t.cacheRead; d[o + 5] = t.output;
    return this;
  }

  /** Drops ids last seen before minTs (their lines are outside the window, so they can no longer count) */
  prune(minTs) {
    const old = this.data;
    const keep = [];
    for (const [id, i] of this.index) if (old[i * MSG_W] >= minTs) keep.push([id, i]);
    if (keep.length === this.n) return;
    let cap = 1024;
    while (cap < keep.length) cap *= 2;
    this.data = new Float64Array(MSG_W * cap);
    this.index = new Map();
    keep.forEach(([id, i], j) => {
      this.data.set(old.subarray(i * MSG_W, i * MSG_W + MSG_W), j * MSG_W);
      this.index.set(id, j);
    });
    this.n = keep.length;
  }

  /** Flat batches for the cache: [id, ts, input, cacheWrite5m, cacheWrite1h, cacheRead, output, id, ...] */
  *batches() {
    let out = [];
    for (const [id, i] of this.index) {
      out.push(id);
      for (let k = 0; k < MSG_W; k++) out.push(this.data[i * MSG_W + k]);
      if (out.length >= BATCH * (MSG_W + 1)) { yield out; out = []; }
    }
    if (out.length) yield out;
  }

  /** Loads one batch; returns the number of ids read, or -1 if malformed */
  load(flat) {
    if (!Array.isArray(flat) || flat.length % (MSG_W + 1)) return -1;
    let n = 0;
    for (let j = 0; j < flat.length; j += MSG_W + 1) {
      const id = flat[j];
      if (typeof id !== 'string' || !id) return -1;
      for (let k = 1; k <= MSG_W; k++) if (typeof flat[j + k] !== 'number') return -1;
      this.set(id, { input: flat[j + 2], cacheWrite5m: flat[j + 3], cacheWrite1h: flat[j + 4], cacheRead: flat[j + 5], output: flat[j + 6] }, flat[j + 1]);
      n++;
    }
    return n;
  }
}

// Codex response_id de-duplication: response_id → timestamp (for pruning)
class ResponseStore {
  constructor() { this.map = new Map(); }
  get size() { return this.map.size; }
  has(id) { return this.map.has(id); }
  add(id, ts) { this.map.set(id, Number.isFinite(ts) ? ts : 0); return this; }
  prune(minTs) { for (const [id, ts] of this.map) if (ts < minTs) this.map.delete(id); }
  *batches() {
    let out = [];
    for (const [id, ts] of this.map) {
      out.push(id, ts);
      if (out.length >= BATCH * 2) { yield out; out = []; }
    }
    if (out.length) yield out;
  }
  load(flat) {
    if (!Array.isArray(flat) || flat.length % 2) return -1;
    for (let j = 0; j < flat.length; j += 2) {
      if (typeof flat[j] !== 'string' || typeof flat[j + 1] !== 'number') return -1;
      this.map.set(flat[j], flat[j + 1]);
    }
    return flat.length / 2;
  }
}

// ---------------------------------------------------------------------------
// Buckets: { byModel: { model: { tokens: {...native categories}, usd } } }
// usd stays null for a model without a public price (same rule as today's totals).
// ---------------------------------------------------------------------------

function addInto(byModel, model, tokens, usd, sign, keys) {
  let b = byModel[model];
  if (!b) {
    b = { tokens: {}, usd: usd == null ? null : 0 };
    for (const k of keys) b.tokens[k] = 0;
    byModel[model] = b;
  }
  for (const k of keys) b.tokens[k] += sign * (tokens[k] || 0);
  if (usd != null) b.usd = (b.usd || 0) + sign * usd;
}

function totalTokens(provider, t) {
  if (provider === 'claude') return t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead + t.output;
  return t.input + t.output; // Codex input already includes cached input; output includes reasoning
}

// Provider-native categories → the table's columns (input excludes cache reads for both providers)
function normalizeTokens(provider, t) {
  if (provider === 'claude') {
    return { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite5m + t.cacheWrite1h, reasoning: null, total: totalTokens('claude', t) };
  }
  return {
    input: Math.max(0, t.input - t.cachedInput), output: t.output, cacheRead: t.cachedInput, cacheWrite: t.cacheWrite,
    reasoning: t.reasoning, total: totalTokens('codex', t),
  };
}

function isEmptyObject(o) {
  for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) return false;
  return true;
}

function newEntry(provider) {
  return {
    provider, size: -1, mtimeMs: 0, ino: 0, offset: 0, end: 0, perDay: {}, cx: provider === 'codex' ? newCodexFileState() : null,
    cur: null, tail: null, gen: 0, // transient: current stat, open reader, listing generation
  };
}

function upToDate(e) {
  return !!e.cur && e.size === e.cur.size && e.mtimeMs === e.cur.mtimeMs && e.end >= e.size;
}

function emptyProviderDay() { return { usd: 0, tokens: 0, unpricedTokens: 0 }; }

/**
 * An empty report (no scanner, or before the first step).
 * @param {number} [days]
 * @param {number} [now]
 */
function emptyHistoryReport(days = DEFAULT_DAYS, now = Date.now()) {
  const n = clampDays(days);
  const today = localDayStart(now);
  const list = [];
  for (let i = n - 1; i >= 0; i--) list.push({ date: dayKeyOf(addDays(today, -i)), claude: emptyProviderDay(), codex: emptyProviderDay() });
  return {
    at: now,
    windowDays: n,
    start: list[0].date,
    end: list[list.length - 1].date,
    days: list,
    byModel: [],
    totals: { usd: 0, tokens: 0, unpricedTokens: 0, activeDays: 0, claude: emptyProviderDay(), codex: emptyProviderDay() },
    progress: { doneBytes: 0, totalBytes: 0, filesDone: 0, filesTotal: 0 },
    partial: false,
    pricesUpdated: pricing.PRICES_UPDATED,
    sources: { claude: false, codex: false },
    cache: { persisted: false, state: 'none', error: null },
  };
}

// ---------------------------------------------------------------------------
// HistoryScanner
// ---------------------------------------------------------------------------

class HistoryScanner {
  /**
   * @param {{
   *   claudeProjectsDir?: string|null,  // null / empty = do not scan Claude
   *   codexHome?: string|null,          // null / empty = do not scan Codex
   *   cacheFile?: string|null,          // where to persist the cache; null = memory only
   *   days?: number,                    // window in days (default 30, max 90); request() can change it
   *   budgetBytes?: number,             // max bytes read per step, default 16 MB
   *   sliceMs?: number,                 // a step stops reading after this many ms, default 100
   *   listMs?: number,                  // re-list files at most this often, default 30 s
   *   saveMs?: number,                  // persist at most this often while scanning, default 30 s
   * }} [opts]
   */
  constructor(opts = {}) {
    this.claudeDir = opts.claudeProjectsDir || null;
    this.codexHome = opts.codexHome || null;
    this.cacheFile = opts.cacheFile || null;
    this.budget = opts.budgetBytes > 0 ? opts.budgetBytes : DEFAULT_HISTORY_BUDGET;
    this.sliceMs = opts.sliceMs > 0 ? opts.sliceMs : DEFAULT_SLICE_MS;
    this.listMs = opts.listMs ?? DEFAULT_LIST_MS;
    this.saveMs = opts.saveMs ?? DEFAULT_SAVE_MS;
    this.viewDays = clampDays(opts.days);
    this.scanDays = this.viewDays;  // the scanned window only grows (a shorter request is a slice of it)
    this.loaded = false;            // persisted cache read (or found missing / unusable)
    this.cacheState = 'none';       // none | loaded | missing | rebuilt
    this.cacheError = null;
    this.lastSave = -Infinity;
    this.clear();
  }

  clear() {
    this.entries = new Map();       // file → entry
    this.agg = new Map();           // day → { claude: byModel, codex: byModel }
    this.msgs = new MsgStore();
    this.responses = new ResponseStore();
    this.queue = [];                // files still to read, most recently modified first
    this.startMs = null;            // first counted instant (local midnight)
    this.startDay = null;
    this.todayStart = null;
    this.lastList = -Infinity;
    this.listed = false;
    this.forceList = false;
    this.gen = 0;
    this.dirty = false;
    this.bucketLo = 0;
    this.bucketHi = -1;
    this.bucketKey = '';
  }

  /** Drop everything and scan again from scratch (the next save overwrites the cache) */
  reset() {
    this.clear();
    this.dirty = true;
  }

  /**
   * @param {{ days?: number, force?: boolean }} [o] force: re-list and re-check every file now (ignores the listing throttle)
   */
  request(o = {}) {
    if (o.days !== undefined) this.viewDays = clampDays(o.days);
    if (this.viewDays > this.scanDays) this.scanDays = this.viewDays;
    if (o.force) this.forceList = true;
  }

  // Local day key of a timestamp; consecutive lines almost always fall on the same day, so the range is cached
  bucket(ts) {
    if (ts >= this.bucketLo && ts < this.bucketHi) return this.bucketKey;
    const lo = localDayStart(ts);
    this.bucketLo = lo;
    this.bucketHi = addDays(lo, 1);
    this.bucketKey = dayKeyOf(lo);
    return this.bucketKey;
  }

  // ---------- window ----------

  ensureWindow(now) {
    const todayStart = localDayStart(now);
    const startMs = addDays(todayStart, -(this.scanDays - 1));
    if (this.startMs === startMs) { this.todayStart = todayStart; return; }
    if (this.startMs != null && startMs < this.startMs) {
      // A longer window (or the clock went back): cached counts lack the older lines
      this.reset();
      if (this.cacheState === 'loaded') this.cacheState = 'rebuilt';
    } else if (this.startMs != null) {
      this.prune(startMs);
    }
    this.startMs = startMs;
    this.startDay = dayKeyOf(startMs);
    this.todayStart = todayStart;
  }

  prune(startMs) {
    const startDay = dayKeyOf(startMs);
    for (const e of this.entries.values()) {
      for (const d of Object.keys(e.perDay)) if (d < startDay) delete e.perDay[d];
      e.tail = null; // its callbacks captured the old cutoff: reopen at the committed offset
    }
    for (const d of [...this.agg.keys()]) if (d < startDay) this.agg.delete(d);
    this.msgs.prune(startMs);
    this.responses.prune(startMs);
    this.lastList = -Infinity; // files that fell out of the window are dropped at the next listing
    this.dirty = true;
  }

  // ---------- listing ----------

  list(now) {
    this.lastList = now;
    this.forceList = false;
    const gen = ++this.gen;
    walkTranscripts(this.claudeDir, this.codexHome, (file, provider) => {
      let st;
      try { st = fs.statSync(file); } catch { return; }
      if (!st.isFile() || st.mtimeMs < this.startMs) return; // untouched since before the window: nothing to count
      let e = this.entries.get(file);
      if (e && e.provider !== provider) return; // the roots overlap: the first provider that claimed the file keeps it
      if (!e) { e = newEntry(provider); this.entries.set(file, e); this.dirty = true; }
      e.cur = { size: st.size, mtimeMs: st.mtimeMs };
      e.gen = gen;
    });
    for (const [file, e] of this.entries) {
      if (e.gen === gen) continue;
      // Deleted, moved or out of the window: keep what it counted while those days are still shown
      e.cur = null;
      e.tail = null;
      if (isEmptyObject(e.perDay)) { this.entries.delete(file); this.dirty = true; }
    }
    this.queue = [...this.entries.entries()]
      .filter(([, e]) => e.cur && !upToDate(e))
      .sort((a, b) => b[1].cur.mtimeMs - a[1].cur.mtimeMs)
      .map(([f]) => f);
    this.listed = true;
  }

  // ---------- reading ----------

  openTail(file, e) {
    let first = true;
    const init = () => {
      // Re-read after truncation / replacement: Codex cumulative counters must not count again (see replay in feedCodexEntry)
      if (!first && e.cx) e.cx.replay = true;
      first = false;
      return null;
    };
    let feed;
    if (e.provider === 'claude') {
      feed = (_s, line) => {
        const r = claudeIncrement(line, this.msgs, this.startMs);
        if (r) this.add(e, 'claude', r.ts, r.model || 'unknown', r.d, r.usd, 1);
      };
    } else {
      const ctx = {
        minTs: this.startMs,
        responses: this.responses,
        add: (model, t, usd, sign, ts) => this.add(e, 'codex', ts, model || 'unknown', t, usd, sign),
        bucket: (ts) => this.bucket(ts),
      };
      feed = (_s, line) => feedCodexEntry(e.cx, line, ctx);
    }
    const tail = new JsonlTail(file, init, feed, { prefilter: e.provider === 'claude' ? CLAUDE_FILTER : CODEX_FILTER });
    tail.offset = e.offset; // resume at the start of the first line not yet parsed
    tail.ino = e.ino || 0;  // a different inode means the file was replaced: JsonlTail starts over
    return tail;
  }

  add(e, provider, ts, model, tokens, usd, sign) {
    if (!(ts >= this.startMs)) return; // a rollback aimed at a day that already left the window
    const day = this.bucket(ts);
    const keys = provider === 'claude' ? CLAUDE_KEYS : CODEX_KEYS;
    const pd = e.perDay[day] || (e.perDay[day] = {});
    const fb = pd[provider] || (pd[provider] = { byModel: {} });
    addInto(fb.byModel, model, tokens, usd, sign, keys);
    let ad = this.agg.get(day);
    if (!ad) { ad = { claude: {}, codex: {} }; this.agg.set(day, ad); }
    addInto(ad[provider], model, tokens, usd, sign, keys);
    this.dirty = true;
  }

  // Record how far a reader got: offset = start of the partial line it holds, end = bytes consumed
  commit(e, tail) {
    e.offset = Math.max(0, tail.offset - tail.carryLen);
    e.end = tail.offset;
    e.size = tail.size;
    e.mtimeMs = tail.mtimeMs;
    e.ino = tail.ino;
    if (e.cur) { e.cur.size = tail.size; e.cur.mtimeMs = tail.mtimeMs; }
    this.dirty = true;
  }

  /**
   * One slice: list if due, then read at most budgetBytes (stopping early after sliceMs). Returns the current report.
   * @param {number} [now]
   */
  step(now = Date.now()) {
    const t0 = Date.now();
    if (!this.loaded) this.load();
    this.ensureWindow(now);
    if (this.forceList || !this.listed || now - this.lastList >= this.listMs) this.list(now);
    let budget = this.budget;
    const wasPartial = this.queue.length > 0;
    while (budget > 0 && this.queue.length) {
      const file = this.queue[0];
      const e = this.entries.get(file);
      if (!e || !e.cur) { this.queue.shift(); continue; }
      if (!e.tail) e.tail = this.openTail(file, e);
      const tail = e.tail;
      tail.mtimeMs = 0; // poll sets it again after a successful stat
      tail.poll(Math.min(budget, STEP_BYTES));
      budget -= tail.bytesRead;
      if (!tail.mtimeMs) {
        // Vanished since the listing: leave the entry as it was; the next listing decides
        e.tail = null;
        e.cur = null;
        this.queue.shift();
        continue;
      }
      if (tail.bytesRead > 0 || tail.size !== e.size || tail.mtimeMs !== e.mtimeMs) this.commit(e, tail);
      if (tail.bytesRead === 0 || tail.offset >= tail.size) {
        // End of file (or unreadable right now): done until it changes
        e.tail = null;
        this.queue.shift();
        if (tail.offset < tail.size) e.cur = { size: e.size, mtimeMs: e.mtimeMs, failed: true };
      }
      if (Date.now() - t0 >= this.sliceMs) break;
    }
    if (this.dirty && this.cacheFile && (now - this.lastSave >= this.saveMs || (wasPartial && !this.queue.length))) this.save(now);
    return this.result(now);
  }

  // ---------- report ----------

  progress() {
    let totalBytes = 0;
    let doneBytes = 0;
    let filesTotal = 0;
    let filesDone = 0;
    for (const e of this.entries.values()) {
      if (!e.cur) continue;
      const size = Math.max(0, e.cur.size);
      filesTotal++;
      totalBytes += size;
      if (upToDate(e) || e.cur.failed) { filesDone++; doneBytes += size; } else doneBytes += Math.min(e.tail ? e.tail.offset : e.end, size);
    }
    return { doneBytes, totalBytes, filesDone, filesTotal };
  }

  /**
   * The report for the requested window (no I/O).
   * @param {number} [now]
   */
  result(now = Date.now()) {
    const today = localDayStart(now);
    const n = this.viewDays;
    const days = [];
    const models = new Map();
    const totals = { usd: 0, tokens: 0, unpricedTokens: 0, activeDays: 0, claude: emptyProviderDay(), codex: emptyProviderDay() };
    for (let i = n - 1; i >= 0; i--) {
      const date = dayKeyOf(addDays(today, -i));
      const row = { date, claude: emptyProviderDay(), codex: emptyProviderDay() };
      const ad = this.agg.get(date);
      if (ad) {
        for (const p of PROVIDERS) {
          for (const [model, b] of Object.entries(ad[p])) {
            const tokens = totalTokens(p, b.tokens);
            row[p].tokens += tokens;
            if (b.usd == null) row[p].unpricedTokens += tokens;
            else row[p].usd += b.usd;
            const k = p + '\n' + model;
            let m = models.get(k);
            if (!m) { m = { provider: p, model, native: {}, usd: b.usd == null ? null : 0 }; models.set(k, m); }
            for (const [c, v] of Object.entries(b.tokens)) m.native[c] = (m.native[c] || 0) + v;
            if (b.usd != null) m.usd = (m.usd || 0) + b.usd;
          }
        }
      }
      for (const p of PROVIDERS) {
        totals[p].usd += row[p].usd;
        totals[p].tokens += row[p].tokens;
        totals[p].unpricedTokens += row[p].unpricedTokens;
      }
      if (row.claude.tokens || row.codex.tokens) totals.activeDays++;
      days.push(row);
    }
    totals.usd = totals.claude.usd + totals.codex.usd;
    totals.tokens = totals.claude.tokens + totals.codex.tokens;
    totals.unpricedTokens = totals.claude.unpricedTokens + totals.codex.unpricedTokens;
    const byModel = [...models.values()]
      .map((m) => ({ provider: m.provider, model: m.model, tokens: normalizeTokens(m.provider, fillKeys(m.provider, m.native)), usd: m.usd }))
      .filter((m) => m.tokens.total !== 0 || (m.usd != null && m.usd !== 0))
      .sort((a, b) => ((b.usd ?? -1) - (a.usd ?? -1)) || (b.tokens.total - a.tokens.total) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    return {
      at: now,
      windowDays: n,
      start: days[0].date,
      end: days[days.length - 1].date,
      days,
      byModel,
      totals,
      progress: this.progress(),
      partial: !this.listed || this.queue.length > 0,
      pricesUpdated: pricing.PRICES_UPDATED,
      sources: { claude: !!this.claudeDir, codex: !!this.codexHome },
      cache: { persisted: !!this.cacheFile, state: this.cacheState, error: this.cacheError },
    };
  }

  // ---------- persistence ----------

  header() {
    return {
      kind: CACHE_KIND, v: CACHE_VERSION, pricing: pricingFingerprint(),
      roots: { claude: this.claudeDir, codex: this.codexHome },
      scanDays: this.scanDays, startMs: this.startMs, startDay: this.startDay,
    };
  }

  /** Persist now if anything changed (temp file + rename). Errors are kept in cache.error, never thrown. */
  flush(now = Date.now()) {
    if (this.dirty && this.cacheFile && this.startMs != null) this.save(now);
  }

  save(now = Date.now()) {
    this.lastSave = now;
    const file = this.cacheFile;
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let fd;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fd = fs.openSync(tmp, 'w');
      let buf = '';
      const out = (obj) => {
        buf += JSON.stringify(obj) + '\n';
        if (buf.length >= WRITE_CHUNK) { fs.writeSync(fd, buf); buf = ''; }
      };
      out({ ...this.header(), savedAt: now });
      let files = 0;
      for (const [f, e] of this.entries) {
        out({ f, p: e.provider, size: e.size, mtimeMs: e.mtimeMs, ino: e.ino, offset: e.offset, end: e.end, perDay: e.perDay, cx: e.cx ? codexStateToJson(e.cx) : null });
        files++;
      }
      for (const b of this.msgs.batches()) out({ m: b });
      for (const b of this.responses.batches()) out({ r: b });
      out({ end: true, files, msgs: this.msgs.size, responses: this.responses.size });
      if (buf) fs.writeSync(fd, buf);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, file);
      this.dirty = false;
      this.cacheError = null;
    } catch (err) {
      this.cacheError = String((err && err.message) || err).split('\n')[0].slice(0, 300);
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  /** Read the persisted cache once; if it is missing, unreadable, inconsistent or for other roots / prices, start empty */
  load() {
    this.loaded = true;
    if (!this.cacheFile) return;
    let st;
    try { st = fs.statSync(this.cacheFile); } catch { this.cacheState = 'missing'; return; }
    if (!st.isFile()) { this.cacheState = 'missing'; return; }
    const want = this.header();
    const s = { header: null, trailer: null, bad: false, files: 0, msgs: 0, responses: 0, lines: 0 };
    const entries = new Map();
    const msgs = new MsgStore();
    const responses = new ResponseStore();
    const feed = (_st, o) => {
      s.lines++;
      if (s.bad || s.trailer) { s.bad = true; return; }
      if (!s.header) {
        if (o.kind !== CACHE_KIND || o.v !== CACHE_VERSION || o.pricing !== want.pricing || !o.roots
          || (o.roots.claude || null) !== want.roots.claude || (o.roots.codex || null) !== want.roots.codex
          || !Number.isFinite(o.startMs) || !(o.scanDays >= 1 && o.scanDays <= MAX_DAYS)) { s.bad = true; return; }
        s.header = o;
        return;
      }
      if (typeof o.f === 'string') {
        const e = entryFromJson(o);
        if (!e) { s.bad = true; return; }
        entries.set(o.f, e);
        s.files++;
      } else if (o.m !== undefined) {
        const k = msgs.load(o.m);
        if (k < 0) s.bad = true; else s.msgs += k;
      } else if (o.r !== undefined) {
        const k = responses.load(o.r);
        if (k < 0) s.bad = true; else s.responses += k;
      } else if (o.end === true) {
        s.trailer = o;
      } else {
        s.bad = true;
      }
    };
    const tail = new JsonlTail(this.cacheFile, () => null, feed);
    try { tail.poll(); } catch { s.bad = true; }
    const t = s.trailer;
    // Every line must parse (a skipped line means corruption) and the counts must match the trailer
    const ok = !s.bad && s.header && t && tail.skipped === 0 && s.lines === tail.lines
      && t.files === s.files && t.msgs === msgs.size && t.responses === responses.size;
    if (!ok) { this.cacheState = 'rebuilt'; this.dirty = true; return; }
    const h = s.header;
    this.scanDays = Math.max(this.scanDays, h.scanDays);
    this.entries = entries;
    this.msgs = msgs;
    this.responses = responses;
    this.startMs = h.startMs;
    this.startDay = dayKeyOf(h.startMs);
    for (const e of entries.values()) {
      if (e.cx) e.cx.turnAcc = new Map(e.cx.turnAccList.map((x) => [(x.model || 'unknown') + '\n' + this.bucket(x.ts), x]));
      if (e.cx) delete e.cx.turnAccList;
      for (const [day, pd] of Object.entries(e.perDay)) {
        for (const p of PROVIDERS) {
          if (!pd[p]) continue;
          let ad = this.agg.get(day);
          if (!ad) { ad = { claude: {}, codex: {} }; this.agg.set(day, ad); }
          for (const [model, b] of Object.entries(pd[p].byModel)) addInto(ad[p], model, b.tokens, b.usd, 1, p === 'claude' ? CLAUDE_KEYS : CODEX_KEYS);
        }
      }
    }
    this.cacheState = 'loaded';
    this.dirty = false;
  }

  /** Persist and free memory; the scanner can be used again (it reloads the cache) */
  dispose() {
    this.flush();
    this.clear();
    this.loaded = false;
  }
}

function fillKeys(provider, native) {
  const out = {};
  for (const k of provider === 'claude' ? CLAUDE_KEYS : CODEX_KEYS) out[k] = native[k] || 0;
  return out;
}

function codexStateToJson(cx) {
  return {
    model: cx.model, settingsModel: cx.settingsModel, tier: cx.tier, records: cx.records,
    last: cx.last, high: cx.high, replay: cx.replay, turnAcc: [...cx.turnAcc.values()],
  };
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);

function entryFromJson(o) {
  if (o.p !== 'claude' && o.p !== 'codex') return null;
  if (!num(o.size) || !num(o.mtimeMs) || !num(o.offset) || !num(o.end) || !o.perDay || typeof o.perDay !== 'object') return null;
  const e = newEntry(o.p);
  e.size = o.size;
  e.mtimeMs = o.mtimeMs;
  e.ino = num(o.ino) ? o.ino : 0;
  e.offset = o.offset;
  e.end = o.end;
  const keys = o.p === 'claude' ? CLAUDE_KEYS : CODEX_KEYS;
  for (const [day, pd] of Object.entries(o.perDay)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !pd || typeof pd !== 'object') return null;
    const b = pd[o.p];
    if (!b || !b.byModel || typeof b.byModel !== 'object') return null;
    for (const m of Object.values(b.byModel)) {
      if (!m || !m.tokens || typeof m.tokens !== 'object' || (m.usd !== null && !num(m.usd))) return null;
      for (const k of keys) if (!num(m.tokens[k])) return null;
    }
  }
  e.perDay = o.perDay;
  if (o.p === 'codex') {
    const c = o.cx;
    if (!c || typeof c !== 'object' || !Array.isArray(c.turnAcc)) return null;
    const tok = (x) => x === null || x === undefined || (typeof x === 'object' && CODEX_KEYS.every((k) => num(x[k])));
    const str = (x) => x === null || x === undefined || typeof x === 'string';
    if (!tok(c.last) || !tok(c.high) || !str(c.model) || !str(c.settingsModel) || !str(c.tier)) return null;
    for (const x of c.turnAcc) {
      if (!x || typeof x !== 'object' || !num(x.ts) || !x.t || typeof x.t !== 'object' || (x.usd !== null && !num(x.usd))) return null;
      for (const k of CODEX_KEYS) if (!num(x.t[k])) return null;
    }
    e.cx = { ...newCodexFileState(), model: c.model ?? null, settingsModel: c.settingsModel ?? null, tier: c.tier ?? null,
      records: c.records === true, last: c.last || null, high: c.high || null, replay: c.replay === true, turnAccList: c.turnAcc };
  }
  return e;
}

module.exports = {
  HistoryScanner, emptyHistoryReport, clampDays, dayKeyOf, addDays, normalizeTokens,
  DEFAULT_DAYS, MAX_DAYS, DEFAULT_HISTORY_BUDGET, CACHE_VERSION,
  _internal: { MsgStore, ResponseStore, pricingFingerprint, upToDate },
};
