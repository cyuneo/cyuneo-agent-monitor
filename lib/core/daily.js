'use strict';
// Today's totals: a scanner independent of the "activity window"; incremental, chunked, never double-counts.
// - "Today" = local midnight until now; crossing midnight drops all accumulators and starts over.
// - One JsonlTail per file (separate from the activity-window readers); a prefilter skips irrelevant lines by substring before JSON.parse.
// - Each tick reads at most budgetBytes; whatever is left is read next time (partial / progress).
// - Claude is de-duplicated globally by message.id (one message is written over several lines with usage updated line by line; only the increment is taken); synthetic messages are skipped.
// - Codex files that have token_usage_record are counted by response_id; older files use the difference between cumulative token_count values.
// - The listing, parsing, de-duplication and pricing helpers are shared with the usage history (lib/core/history.js).
// Read-only, plain Node.

const fs = require('fs');
const path = require('path');
const { JsonlTail, substringFilter } = require('./jsonl');
const pricing = require('./pricing');

const DEFAULT_BUDGET = 8 * 1024 * 1024;
const DEFAULT_LIST_MS = 30000;

const CLAUDE_FILTER = substringFilter('"usage"');
const CODEX_FILTER = substringFilter('token_usage_record', 'token_count', 'turn_context', 'thread_settings_applied');

/** Local midnight of the current day */
function localDayStart(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function listDir(d) {
  try { return fs.readdirSync(d); } catch { return []; }
}

function statOf(f) {
  try { return fs.statSync(f); } catch { return null; }
}

function emptyClaude() {
  return { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, costUsd: 0, unpricedTokens: 0, byModel: {} };
}

function emptyCodex() {
  return { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, unpricedTokens: 0, byModel: {} };
}

// Accumulate per model (sign = -1 rolls back)
function addByModel(bucket, model, tokens, usd, sign = 1) {
  const key = model || 'unknown';
  let b = bucket.byModel[key];
  if (!b) { b = { tokens: 0, costUsd: usd == null ? null : 0 }; bucket.byModel[key] = b; }
  b.tokens += sign * tokens;
  if (usd != null) b.costUsd = (b.costUsd || 0) + sign * usd;
}

class DailyScanner {
  /**
   * @param {{
   *   claudeProjectsDir?: string|null,   // null / empty = do not scan Claude
   *   codexHome?: string|null,           // null / empty = do not scan Codex
   *   budgetBytes?: number,              // max bytes read per tick, default 8 MB
   *   listMs?: number,                   // how often to re-list files, default 30 seconds
   *   dayStart?: (now: number) => number // for tests: custom "start of day"
   * }} [opts]
   */
  constructor(opts = {}) {
    this.claudeDir = opts.claudeProjectsDir || null;
    this.codexHome = opts.codexHome || null;
    this.budget = opts.budgetBytes > 0 ? opts.budgetBytes : DEFAULT_BUDGET;
    this.listMs = opts.listMs ?? DEFAULT_LIST_MS;
    this.dayStartFn = opts.dayStart || localDayStart;
    this.dayStartMs = null;
    this.resetDay(null);
  }

  resetDay(dayStartMs) {
    this.dayStartMs = dayStartMs;
    this.tails = new Map();      // file → { tail, provider }
    this.order = [];             // read order (most recently modified first)
    this.msgs = new Map();       // Claude message.id → per-category tokens seen last time
    this.responses = new Set();  // Codex response_id (already counted)
    this.codexFiles = new Map(); // Codex file → that file's model, tier, counting mode, etc.
    this.claude = emptyClaude();
    this.codex = emptyCodex();
    this.lastList = -Infinity;
    this.codexCtx = { minTs: dayStartMs, responses: this.responses, add: (model, t, usd, sign) => this.addCodex(model, t, usd, sign) };
  }

  /**
   * Advances once (reading at most budgetBytes) and returns the current totals.
   * @param {number} [now]
   * @returns {import('./status').DailyTotals}
   */
  tick(now = Date.now()) {
    const ds = this.dayStartFn(now);
    if (ds !== this.dayStartMs) this.resetDay(ds);
    if (now - this.lastList >= this.listMs) {
      this.list();
      this.lastList = now;
    }
    let budget = this.budget;
    for (const f of this.order) {
      const x = this.tails.get(f);
      if (!x) continue;
      if (budget > 0) {
        x.tail.poll(budget);
        budget -= x.tail.bytesRead;
      } else {
        x.tail.poll(0); // budget used up: only update the size, for progress
      }
    }
    return this.totals();
  }

  // List files modified today (new files are added; existing ones are kept until midnight)
  list() {
    const found = [];
    walkTranscripts(this.claudeDir, this.codexHome, (file, provider) => this.consider(found, file, provider));
    for (const x of found) {
      if (this.tails.has(x.file)) { this.tails.get(x.file).mtimeMs = x.mtimeMs; continue; }
      this.tails.set(x.file, { tail: this.makeTail(x.file, x.provider), provider: x.provider, mtimeMs: x.mtimeMs });
    }
    this.order = [...this.tails.keys()].sort((a, b) => this.tails.get(b).mtimeMs - this.tails.get(a).mtimeMs);
  }

  consider(found, file, provider) {
    const st = statOf(file);
    if (!st || !st.isFile() || st.mtimeMs < this.dayStartMs) return;
    found.push({ file, provider, mtimeMs: st.mtimeMs });
  }

  makeTail(file, provider) {
    if (provider === 'claude') {
      return new JsonlTail(file, () => ({}), (_s, e) => this.feedClaude(e), { prefilter: CLAUDE_FILTER });
    }
    let first = true;
    const init = () => {
      // Re-read after the file was truncated / replaced: what was already counted is not counted again (see replay in feedCodex)
      const f = this.codexFile(file);
      if (!first) f.replay = true;
      first = false;
      return {};
    };
    return new JsonlTail(file, init, (_s, e) => this.feedCodex(file, e), { prefilter: CODEX_FILTER });
  }

  // ---------- Claude ----------

  feedClaude(e) {
    const r = claudeIncrement(e, this.msgs, this.dayStartMs);
    if (!r) return;
    const { d, tokens, usd } = r;
    const c = this.claude;
    c.input += d.input;
    c.cacheWrite5m += d.cacheWrite5m;
    c.cacheWrite1h += d.cacheWrite1h;
    c.cacheRead += d.cacheRead;
    c.output += d.output;
    if (usd == null) c.unpricedTokens += tokens;
    else c.costUsd += usd;
    addByModel(c, r.model, tokens, usd);
  }

  // ---------- Codex ----------

  codexFile(file) {
    let f = this.codexFiles.get(file);
    if (!f) {
      f = newCodexFileState();
      this.codexFiles.set(file, f);
    }
    return f;
  }

  feedCodex(file, e) {
    feedCodexEntry(this.codexFile(file), e, this.codexCtx);
  }

  addCodex(model, t, usd, sign) {
    const c = this.codex;
    c.input += sign * t.input;
    c.cachedInput += sign * t.cachedInput;
    c.cacheWrite += sign * t.cacheWrite;
    c.output += sign * t.output;
    c.reasoning += sign * t.reasoning;
    const tokens = t.input + t.output; // = total_tokens (input already includes cached)
    if (usd == null) c.unpricedTokens += sign * tokens;
    else c.costUsd += sign * usd;
    addByModel(c, model === 'unknown' ? null : model, tokens, usd, sign);
  }

  totals() {
    let size = 0;
    let read = 0;
    for (const x of this.tails.values()) {
      size += x.tail.size;
      read += Math.min(x.tail.offset, x.tail.size);
    }
    return {
      dayStartMs: this.dayStartMs,
      partial: read < size,
      progress: size > 0 ? read / size : 1,
      claude: cloneBucket(this.claude),
      codex: cloneBucket(this.codex),
    };
  }
}

// ---------- Shared with lib/core/history.js (listing, parsing, de-duplication, pricing) ----------

/**
 * Visits every transcript file under the roots: Claude <projects>/<proj>/*.jsonl plus subagent and workflow agents,
 * Codex <home>/sessions/YYYY/MM/DD/rollout-*.jsonl. A null / empty root is skipped.
 * @param {string|null} claudeDir
 * @param {string|null} codexHome
 * @param {(file: string, provider: 'claude'|'codex') => void} visit
 */
function walkTranscripts(claudeDir, codexHome, visit) {
  if (claudeDir) {
    for (const proj of listDir(claudeDir)) {
      const pd = path.join(claudeDir, proj);
      for (const f of listDir(pd)) {
        const p = path.join(pd, f);
        if (f.endsWith('.jsonl')) { visit(p, 'claude'); continue; }
        // Session directory: subagents/agent-*.jsonl, subagents/workflows/wf_*/agent-*.jsonl
        const sub = path.join(p, 'subagents');
        for (const a of listDir(sub)) {
          if (a.startsWith('agent-') && a.endsWith('.jsonl')) visit(path.join(sub, a), 'claude');
        }
        const wfRoot = path.join(sub, 'workflows');
        for (const wf of listDir(wfRoot)) {
          if (!wf.startsWith('wf_')) continue;
          for (const a of listDir(path.join(wfRoot, wf))) {
            if (a.startsWith('agent-') && a.endsWith('.jsonl')) visit(path.join(wfRoot, wf, a), 'claude');
          }
        }
      }
    }
  }
  if (codexHome) {
    const root = path.join(codexHome, 'sessions');
    for (const y of listDir(root)) {
      for (const m of listDir(path.join(root, y))) {
        for (const d of listDir(path.join(root, y, m))) {
          const dir = path.join(root, y, m, d);
          for (const f of listDir(dir)) {
            if (f.startsWith('rollout-') && f.endsWith('.jsonl')) visit(path.join(dir, f), 'codex');
          }
        }
      }
    }
  }
}

/**
 * One Claude transcript line → what it adds, de-duplicated globally by message.id (one message is written over several
 * lines with usage updated line by line; only the increment is taken). Synthetic, error and pre-minTs lines do not count.
 * @param {any} e parsed line
 * @param {{ get: (id: string) => any, set: (id: string, tokens: any, ts: number) => any }} msgs message.id → tokens seen last time (a Map works)
 * @param {number} minTs lines before this are dropped
 * @returns {{ model: string|null, ts: number, d: { input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number },
 *   tokens: number, usd: number|null }|null}
 */
function claudeIncrement(e, msgs, minTs) {
  if (e.type !== 'assistant' || e.isApiErrorMessage === true) return null;
  const m = e.message;
  if (!m || typeof m !== 'object' || !m.id || !m.usage || typeof m.usage !== 'object') return null;
  if (m.model === '<synthetic>') return null;
  const ts = Date.parse(e.timestamp);
  if (!Number.isFinite(ts) || ts < minTs) return null; // lines before the cutoff are dropped
  const t = pricing.claudeUsageTokens(m.usage);
  const prev = msgs.get(m.id);
  const d = {
    input: t.input - (prev ? prev.input : 0),
    cacheWrite5m: t.cacheWrite5m - (prev ? prev.cacheWrite5m : 0),
    cacheWrite1h: t.cacheWrite1h - (prev ? prev.cacheWrite1h : 0),
    cacheRead: t.cacheRead - (prev ? prev.cacheRead : 0),
    output: t.output - (prev ? prev.output : 0),
  };
  msgs.set(m.id, { input: t.input, cacheWrite5m: t.cacheWrite5m, cacheWrite1h: t.cacheWrite1h, cacheRead: t.cacheRead, output: t.output }, ts);
  const tokens = d.input + d.cacheWrite5m + d.cacheWrite1h + d.cacheRead + d.output;
  if (!tokens) return null;
  return { model: m.model, ts, d, tokens, usd: pricing.priceClaudeTokens(m.model, d, t.speed) };
}

/** Per-rollout state for feedCodexEntry (model, tier, counting mode, baselines) */
function newCodexFileState() {
  return {
    model: null, settingsModel: null, tier: null,
    records: false,        // seen token_usage_record: this file is counted by it only
    last: null,            // total_token_usage of the previous token_count (per-category tokens)
    high: null,            // largest cumulative value seen (prevents double-counting on re-read)
    replay: false,         // re-reading after the file was truncated / replaced
    turnAcc: new Map(),    // amounts counted via token_count in this turn (since the last turn_context): key → { model, ts, t, usd }
  };
}

/**
 * One Codex rollout line. Files that have token_usage_record are counted by response_id (de-duplicated globally);
 * older files use the difference between cumulative token_count values.
 * @param {ReturnType<typeof newCodexFileState>} f this file's state
 * @param {any} e parsed line
 * @param {{ minTs: number, responses: { has: (id: string) => boolean, add: (id: string, ts: number) => any },
 *   add: (model: string|null, t: any, usd: number|null, sign: number, ts: number) => void, bucket?: (ts: number) => string }} ctx
 *   bucket: optional grouping of this turn's token_count amounts (history keeps them per day so a rollback hits the same day)
 */
function feedCodexEntry(f, e, ctx) {
  const p = e.payload && typeof e.payload === 'object' ? e.payload : null;
  if (!p) return;
  if (e.type === 'turn_context') {
    if (typeof p.model === 'string' && p.model) f.model = p.model;
    f.turnAcc.clear();
    return;
  }
  if (e.type === 'event_msg' && p.type === 'thread_settings_applied') {
    const ts = p.thread_settings && typeof p.thread_settings === 'object' ? p.thread_settings : {};
    if (typeof ts.model === 'string' && ts.model) f.settingsModel = ts.model;
    if (typeof ts.service_tier === 'string' && ts.service_tier) f.tier = ts.service_tier;
    return;
  }
  const ts = Date.parse(e.timestamp);
  if (e.type === 'token_usage_record') {
    if (!f.records) {
      // First per-response record seen: roll back what this turn already counted via token_count (the same response writes both, in no fixed order)
      f.records = true;
      for (const x of f.turnAcc.values()) ctx.add(x.model, x.t, x.usd, -1, x.ts);
      f.turnAcc.clear();
    }
    const rid = typeof p.response_id === 'string' ? p.response_id : null;
    if (!rid || ctx.responses.has(rid)) return;
    if (!Number.isFinite(ts) || ts < ctx.minTs) return;
    ctx.responses.add(rid, ts);
    const model = f.model || f.settingsModel;
    const t = pricing.openaiUsageTokens(p.usage);
    const usd = pricing.priceOpenAI(model, p.usage, f.tier);
    ctx.add(model, t, usd, 1, ts);
    return;
  }
  if (e.type === 'event_msg' && p.type === 'token_count') {
    if (f.records) return; // files with per-response records no longer use cumulative values (otherwise double-counted)
    const info = p.info && typeof p.info === 'object' ? p.info : null;
    if (!info || !info.total_token_usage) return;
    const cur = pricing.openaiUsageTokens(info.total_token_usage);
    const total = cur.input + cur.output;
    let d;
    if (f.replay) {
      // Re-read: everything up to the largest value seen before has already been counted
      if (f.high && total <= f.high.input + f.high.output) { f.last = cur; return; }
      d = diffTokens(cur, f.high || zeroTokens());
      f.replay = false;
    } else if (!f.last) {
      d = cur;
    } else {
      const lastTotal = f.last.input + f.last.output;
      if (total === lastTotal) { f.last = cur; return; } // same as the previous one: skip
      d = total < lastTotal ? cur : diffTokens(cur, f.last); // a decrease is treated as a reset; the whole value is counted
    }
    f.last = cur;
    if (!f.high || total > f.high.input + f.high.output) f.high = cur;
    if (!Number.isFinite(ts) || ts < ctx.minTs) return; // before the cutoff: only advance the baseline, do not count
    const model = f.model || f.settingsModel;
    const usd = pricing.priceOpenAITokens(model, d, { tier: f.tier });
    ctx.add(model, d, usd, 1, ts);
    const k = (model || 'unknown') + (ctx.bucket ? '\n' + ctx.bucket(ts) : '');
    const acc = f.turnAcc.get(k);
    f.turnAcc.set(k, acc
      ? { model: acc.model, ts: acc.ts, t: sumTokens(acc.t, d), usd: acc.usd == null || usd == null ? null : acc.usd + usd }
      : { model: model || 'unknown', ts, t: d, usd });
  }
}

function zeroTokens() { return { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 }; }

function diffTokens(a, b) {
  return {
    input: Math.max(0, a.input - b.input),
    cachedInput: Math.max(0, a.cachedInput - b.cachedInput),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
    output: Math.max(0, a.output - b.output),
    reasoning: Math.max(0, a.reasoning - b.reasoning),
  };
}

function sumTokens(a, b) {
  return {
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

function cloneBucket(b) {
  const byModel = {};
  for (const [k, v] of Object.entries(b.byModel)) byModel[k] = { tokens: v.tokens, costUsd: v.costUsd };
  return { ...b, byModel };
}

/** Empty today's totals (used when there is no scanner) */
function emptyDailyTotals(dayStartMs = null) {
  return { dayStartMs, partial: false, progress: 1, claude: emptyClaude(), codex: emptyCodex() };
}

module.exports = {
  DailyScanner, localDayStart, emptyDailyTotals, DEFAULT_BUDGET, CLAUDE_FILTER, CODEX_FILTER,
  // shared with lib/core/history.js
  walkTranscripts, claudeIncrement, newCodexFileState, feedCodexEntry, diffTokens, sumTokens, emptyClaude, emptyCodex,
};
