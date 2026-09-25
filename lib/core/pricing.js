'use strict';
// Price tables and cost calculation. USD per million tokens.
// This computes the "equivalent API cost": an estimate at list prices; subscription users are not billed this way.

const { claudeWindow } = require('./context');

const PRICES_UPDATED = '2026-09-23';
const M = 1e6;

// ---------------------------------------------------------------------------
// Anthropic (source: https://platform.claude.com/docs/en/about-claude/pricing, as of 2026-09-23)
// fast: input / output prices in fast mode (usage.speed === 'fast'); the docs do not list fast cache prices, so they are derived by ratio and flagged "estimated".
// ---------------------------------------------------------------------------

function claudeRow(prefix, input, cacheWrite5m, cacheWrite1h, cacheRead, output, fast) {
  return Object.freeze({ prefix, input, cacheWrite5m, cacheWrite1h, cacheRead, output, fast: fast ? Object.freeze(fast) : null });
}

const ANTHROPIC_PRICES = Object.freeze([
  claudeRow('claude-fable-5-1', 10, 12.5, 20, 0.25, 50),
  claudeRow('claude-mythos-5-1', 10, 12.5, 20, 0.25, 50),
  claudeRow('claude-fable-5', 10, 12.5, 20, 1, 50),
  claudeRow('claude-mythos-5', 10, 12.5, 20, 1, 50),
  claudeRow('claude-opus-5-5', 4, 5, 8, 0.2, 20, { input: 8, output: 40 }),
  claudeRow('claude-opus-5', 5, 6.25, 10, 0.5, 25, { input: 10, output: 50 }),
  claudeRow('claude-opus-4-8', 5, 6.25, 10, 0.5, 25, { input: 10, output: 50 }),
  claudeRow('claude-opus-4-7', 5, 6.25, 10, 0.5, 25),
  claudeRow('claude-opus-4-6', 5, 6.25, 10, 0.5, 25),
  claudeRow('claude-opus-4-5', 5, 6.25, 10, 0.5, 25),
  claudeRow('claude-sonnet-5', 2, 2.5, 4, 0.2, 10),
  claudeRow('claude-sonnet-4-6', 3, 3.75, 6, 0.3, 15),
  claudeRow('claude-sonnet-4-5', 3, 3.75, 6, 0.3, 15),
  claudeRow('claude-haiku-4-5', 1, 1.25, 2, 0.1, 5),
]);
// Longest prefix first
const CLAUDE_BY_LENGTH = [...ANTHROPIC_PRICES].sort((a, b) => b.prefix.length - a.prefix.length);

/**
 * Normalize a model id: lowercase; strip the [1m] suffix, Bedrock prefix, trailing date (-YYYYMMDD / @YYYYMMDD) and -v1:0.
 * @param {string|null} model
 * @returns {string}
 */
function normalizeClaudeModel(model) {
  let m = String(model || '').trim().toLowerCase();
  m = m.replace(/\[1m\]/g, '');
  m = m.replace(/^(?:[a-z]{2}\.)?anthropic\./, '');
  m = m.replace(/-v\d+(?::\d+)?$/, '');
  m = m.replace(/[@-]\d{8}$/, '');
  return m;
}

/**
 * Find the price row (longest prefix). Returns null when not found (unpriced).
 * @param {string|null} model
 */
function claudePriceRow(model) {
  const m = normalizeClaudeModel(model);
  if (!m) return null;
  for (const row of CLAUDE_BY_LENGTH) {
    if (m === row.prefix || m.startsWith(row.prefix + '-')) return row;
  }
  return null;
}

/**
 * Unit prices for a model at a given speed.
 * @param {string|null} model
 * @param {string|null} [speed] usage.speed: 'standard' | 'fast'
 * @returns {{ input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number, estimated: boolean }|null}
 */
function claudeRates(model, speed) {
  const row = claudePriceRow(model);
  if (!row) return null;
  if (speed === 'fast') {
    if (!row.fast) return { ...pickRates(row), estimated: true };
    const fi = row.fast.input;
    return {
      input: fi,
      cacheWrite5m: fi * 1.25,
      cacheWrite1h: fi * 2,
      cacheRead: fi * (row.cacheRead / row.input),
      output: row.fast.output,
      estimated: true, // inferred: fast-mode cache prices
    };
  }
  return { ...pickRates(row), estimated: false };
}

function pickRates(row) {
  return { input: row.input, cacheWrite5m: row.cacheWrite5m, cacheWrite1h: row.cacheWrite1h, cacheRead: row.cacheRead, output: row.output };
}

function int(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }

/**
 * usage from a Claude transcript → tokens by category. If cache_creation is missing, the whole amount counts as 5-minute cache writes.
 * @param {any} usage message.usage
 * @returns {{ input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number, speed: string|null }}
 */
function claudeUsageTokens(usage) {
  const u = usage || {};
  const total = int(u.cache_creation_input_tokens);
  let w5 = 0;
  let w1 = 0;
  if (u.cache_creation && typeof u.cache_creation === 'object') {
    w5 = int(u.cache_creation.ephemeral_5m_input_tokens);
    w1 = int(u.cache_creation.ephemeral_1h_input_tokens);
  }
  const rest = Math.max(0, total - w5 - w1); // the unsplit part counts as 5-minute
  return {
    input: int(u.input_tokens),
    cacheWrite5m: w5 + rest,
    cacheWrite1h: w1,
    cacheRead: int(u.cache_read_input_tokens),
    output: int(u.output_tokens),
    speed: typeof u.speed === 'string' ? u.speed : null,
  };
}

/**
 * Price tokens by category. Returns null when unpriced.
 * @param {string|null} model
 * @param {{ input?: number, cacheWrite5m?: number, cacheWrite1h?: number, cacheRead?: number, output?: number }} tokens
 * @param {string|null} [speed]
 * @returns {number|null}
 */
function priceClaudeTokens(model, tokens, speed) {
  const r = claudeRates(model, speed);
  if (!r) return null;
  const t = tokens || {};
  return (int(t.input) * r.input + int(t.cacheWrite5m) * r.cacheWrite5m + int(t.cacheWrite1h) * r.cacheWrite1h
    + int(t.cacheRead) * r.cacheRead + int(t.output) * r.output) / M;
}

/**
 * Equivalent cost of one request (USD). Returns null when unpriced.
 * @param {string|null} model
 * @param {any} usage message.usage
 * @returns {number|null}
 */
function priceClaude(model, usage) {
  const t = claudeUsageTokens(usage);
  return priceClaudeTokens(model, t, t.speed);
}

/**
 * Same as priceClaude, plus whether it is estimated and the token breakdown.
 * @returns {{ usd: number|null, estimated: boolean, tokens: ReturnType<typeof claudeUsageTokens> }}
 */
function priceClaudeDetail(model, usage) {
  const t = claudeUsageTokens(usage);
  const r = claudeRates(model, t.speed);
  return { usd: r ? priceClaudeTokens(model, t, t.speed) : null, estimated: !!(r && r.estimated), tokens: t };
}

// ---------------------------------------------------------------------------
// OpenAI (source: https://developers.openai.com/api/docs/pricing.md, Standard and Fast tables, as of 2026-09-23)
// Each set: input / cached input / cache write / output; the *Long variants are long-context prices (null = no long-context price).
// ---------------------------------------------------------------------------

function oaRates(input, cached, cacheWrite, output) {
  return Object.freeze({ input, cached, cacheWrite, output });
}

const OPENAI_PRICES = Object.freeze({
  'gpt-6-astra': {
    standard: oaRates(10, 1, 12.5, 50), standardLong: oaRates(20, 2, 25, 75),
    fast: oaRates(20, 2, 25, 100), fastLong: oaRates(40, 4, 50, 150),
  },
  'gpt-6-sol': {
    standard: oaRates(2, 0.2, 2.5, 10), standardLong: oaRates(4, 0.4, 5, 15),
    fast: oaRates(4, 0.4, 5, 20), fastLong: oaRates(8, 0.8, 10, 30),
  },
  'gpt-6-luna': {
    standard: oaRates(0.1, 0.01, 0.125, 0.5), standardLong: oaRates(0.2, 0.02, 0.25, 0.75),
    fast: oaRates(0.2, 0.02, 0.25, 1), fastLong: oaRates(0.4, 0.04, 0.5, 1.5),
  },
  'gpt-5.6-sol': {
    standard: oaRates(4, 0.4, 5, 20), standardLong: oaRates(8, 0.8, 10, 30),
    fast: oaRates(8, 0.8, 10, 40), fastLong: oaRates(16, 1.6, 20, 60),
  },
  'gpt-5.6-terra': {
    standard: oaRates(2, 0.2, 2.5, 12), standardLong: oaRates(4, 0.4, 5, 18),
    fast: oaRates(4, 0.4, 5, 24), fastLong: oaRates(8, 0.8, 10, 36),
  },
  'gpt-5.6-luna': {
    standard: oaRates(0.2, 0.02, 0.25, 1.2), standardLong: oaRates(0.4, 0.04, 0.5, 1.8),
    fast: oaRates(0.4, 0.04, 0.5, 2.4), fastLong: oaRates(0.8, 0.08, 1, 3.6),
  },
  // gpt-5.5: no cache-write price; the Fast tier has no long-context price
  'gpt-5.5': {
    standard: oaRates(5, 0.5, null, 30), standardLong: oaRates(10, 1, null, 45),
    fast: oaRates(12.5, 1.25, null, 75), fastLong: null,
  },
});

// Long-context threshold: the page states <272K only for gpt-5.5; the others are assumed to use the same threshold (inferred)
const OPENAI_LONG_CONTEXT = 272000;

/** Normalize a model id: lowercase, strip a trailing -YYYY-MM-DD date. Exact match only; anything unrecognized is unpriced. */
function normalizeOpenAIModel(model) {
  return String(model || '').trim().toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function isFastTier(tier) { return tier === 'fast' || tier === 'priority'; }

/**
 * @param {string|null} model
 * @param {{ tier?: string|null, long?: boolean }} [o]
 * @returns {{ input: number, cached: number, cacheWrite: number|null, output: number, estimated: boolean }|null}
 */
function openaiRates(model, o = {}) {
  const row = OPENAI_PRICES[normalizeOpenAIModel(model)];
  if (!row) return null;
  const fast = isFastTier(o.tier);
  let r = fast ? (o.long ? row.fastLong : row.fast) : (o.long ? row.standardLong : row.standard);
  let estimated = false;
  if (!r) { r = fast ? row.fast : row.standard; estimated = true; }
  return { ...r, estimated };
}

/**
 * Codex usage → tokens by category. input_tokens already includes cached_input_tokens.
 * @param {any} usage token_usage_record.usage / token_count.info.last_token_usage
 * @returns {{ input: number, cachedInput: number, cacheWrite: number, output: number, reasoning: number }}
 */
function openaiUsageTokens(usage) {
  const u = usage || {};
  const details = u.input_tokens_details || {};
  const outDetails = u.output_tokens_details || {};
  return {
    input: int(u.input_tokens),
    cachedInput: int(u.cached_input_tokens ?? details.cached_tokens),
    cacheWrite: int(u.cache_write_input_tokens ?? details.cache_write_tokens),
    output: int(u.output_tokens),
    reasoning: int(u.reasoning_output_tokens ?? outDetails.reasoning_tokens),
  };
}

/**
 * Price tokens by category: (input − cached)×input + cached×cached input + cacheWrite×cache write + output×output.
 * For models without a cache-write price, cache writes are charged at the input price (flagged estimated). Returns null when unpriced.
 * @param {string|null} model
 * @param {{ input?: number, cachedInput?: number, cacheWrite?: number, output?: number }} tokens
 * @param {{ tier?: string|null, long?: boolean }} [o]
 * @returns {number|null}
 */
function priceOpenAITokens(model, tokens, o = {}) {
  const r = openaiRates(model, o);
  if (!r) return null;
  const t = tokens || {};
  const input = int(t.input);
  const cached = Math.min(int(t.cachedInput), input);
  const writeRate = r.cacheWrite == null ? r.input : r.cacheWrite;
  return ((input - cached) * r.input + cached * r.cached + int(t.cacheWrite) * writeRate + int(t.output) * r.output) / M;
}

/**
 * Equivalent cost of one request (USD). Input above 272K uses long-context prices. Returns null when unpriced.
 * @param {string|null} model
 * @param {any} usage
 * @param {string|null} [tier] service_tier: 'default' | 'flex' | 'fast' | 'priority' …
 * @returns {number|null}
 */
function priceOpenAI(model, usage, tier) {
  const t = openaiUsageTokens(usage);
  return priceOpenAITokens(model, t, { tier, long: t.input > OPENAI_LONG_CONTEXT });
}

// ---------------------------------------------------------------------------
// Cost of resuming
// ---------------------------------------------------------------------------

const TTL_MS = Object.freeze({ '5m': 5 * 60e3, '1h': 60 * 60e3 });

/**
 * Cost of re-reading contextTokens when resuming.
 * Claude: miss = × cache-write price for the TTL, hit = × cache-read price; Codex: miss = × input price, hit = ×
 * cached-input price. Copilot (billed in credits) and unknown providers: no price.
 * @param {'claude'|'codex'|'copilot'} provider
 * @param {string|null} model
 * @param {number} contextTokens
 * @param {'5m'|'1h'|'unknown'} [ttl]
 * @returns {{ usdIfMiss: number|null, usdIfHit: number|null }}
 */
function rereadCost(provider, model, contextTokens, ttl) {
  const n = int(contextTokens);
  if (provider === 'codex') {
    const r = openaiRates(model, {});
    if (!r) return { usdIfMiss: null, usdIfHit: null };
    return { usdIfMiss: n * r.input / M, usdIfHit: n * r.cached / M };
  }
  if (provider === 'copilot') return { usdIfMiss: null, usdIfHit: null };
  const r = claudeRates(model);
  if (!r) return { usdIfMiss: null, usdIfHit: null };
  const write = ttl === '1h' ? r.cacheWrite1h : r.cacheWrite5m;
  return { usdIfMiss: n * write / M, usdIfHit: n * r.cacheRead / M };
}

// ---------------------------------------------------------------------------
// Compaction cost estimate
// ---------------------------------------------------------------------------

const COMPACT_OUT_RATIO = 0.04;      // inferred: estimated ratio of summary output to context size
const COMPACT_OUT_MIN = 2000;
const COMPACT_OUT_MAX = 20000;
const COMPACT_HEADROOM = 20000;      // the target model's window must exceed the context by at least this much
const COMPACT_TARGETS = Object.freeze(['claude-sonnet-5', 'claude-haiku-4-5']); // cheaper models allowed for background compaction (allowlist)

/** Estimated output tokens of a compaction summary: clamp(round(contextUsed × 0.04), 2000, 20000) */
function compactOutputTokens(contextUsed) {
  const n = Math.round(int(contextUsed) * COMPACT_OUT_RATIO);
  return Math.min(COMPACT_OUT_MAX, Math.max(COMPACT_OUT_MIN, n));
}

/**
 * Whether the cache has likely expired (same rule as the resume-cost estimate): (atMs ?? now) − lastActivityMs > TTL.
 * With an unknown ttl, the main agent uses 1h and others 5m. Missing lastActivityMs → treated as expired.
 */
function cacheLikelyExpired(ttl, lastActivityMs, now, isMain = true, atMs = null) {
  if (!Number.isFinite(lastActivityMs)) return true;
  const ms = TTL_MS[ttl] || (isMain ? TTL_MS['1h'] : TTL_MS['5m']);
  return (atMs ?? now) - lastActivityMs > ms;
}

/**
 * Estimate the equivalent cost of one compaction.
 * - Same model and cache likely still warm: contextUsed × cache-read price + out × output price;
 * - Different model or cache expired: contextUsed × cache-write price + out × output price. The cache-write price uses the TTL this compaction request would use
 *   (ttl '1h' / '5m'; when unknown, the main conversation uses 1h and others 5m, consistent with cacheLikelyExpired);
 * - Target model window too small (contextUsed + 20000 > window) → available = false, amounts are null.
 * @param {{ contextUsed: number, model: string|null, targetModel?: string|null, ttl?: '5m'|'1h'|'unknown'|null,
 *   lastActivityMs?: number|null, now?: number, isMain?: boolean }} o
 * @returns {{ model: string|null, targetModel: string|null, sameModel: boolean, available: boolean,
 *   unavailableReason: 'window'|null, targetWindow: number, contextTokens: number, outTokens: number,
 *   cacheLikelyExpired: boolean, pricing: 'hit'|'miss', priced: boolean,
 *   readUsd: number|null, writeUsd: number|null, usd: number|null }}
 */
function estimateCompact(o) {
  const now = o.now ?? Date.now();
  const contextTokens = int(o.contextUsed);
  const model = o.model || null;
  const target = o.targetModel || model;
  const sameModel = normalizeClaudeModel(target) === normalizeClaudeModel(model);
  const outTokens = compactOutputTokens(contextTokens);
  const expired = cacheLikelyExpired(o.ttl, o.lastActivityMs, now, o.isMain !== false);
  // Original model: it already fits (observed usage above 200K counts as 1M); other model: use the target model's native window
  const targetWindow = sameModel ? claudeWindow(target, contextTokens).window : claudeWindow(target, 0).window;
  const available = sameModel || contextTokens + COMPACT_HEADROOM <= targetWindow;
  const pricing = sameModel && !expired ? 'hit' : 'miss';
  const r = claudeRates(target);
  let readUsd = null;
  let writeUsd = null;
  if (r && available) {
    const ttl = o.ttl === '1h' || o.ttl === '5m' ? o.ttl : (o.isMain !== false ? '1h' : '5m');
    const write = ttl === '1h' ? r.cacheWrite1h : r.cacheWrite5m;
    readUsd = contextTokens * (pricing === 'hit' ? r.cacheRead : write) / M;
    writeUsd = outTokens * r.output / M;
  }
  return {
    model,
    targetModel: target,
    sameModel,
    available,
    unavailableReason: available ? null : 'window',
    targetWindow,
    contextTokens,
    outTokens,
    cacheLikelyExpired: expired,
    pricing,
    priced: !!r,
    readUsd,
    writeUsd,
    usd: readUsd == null ? null : readUsd + writeUsd,
  };
}

/**
 * Background compaction candidates and recommendation: the original model, claude-sonnet-5, claude-haiku-4-5 (deduplicated).
 * Recommended = the cheapest estimate among the available, priced ones; on a tie the original model wins.
 * @param {{ contextUsed: number, model: string|null, ttl?: string|null, lastActivityMs?: number|null, now?: number, isMain?: boolean }} o
 * @returns {{ candidates: (ReturnType<typeof estimateCompact> & { id: string|null, role: 'original'|'target',
 *   recommended: boolean, savingVsOriginal: number|null })[], recommended: string|null }}
 */
function compactCandidates(o) {
  const ids = [o.model || null];
  const seen = new Set([normalizeClaudeModel(o.model)]);
  for (const id of COMPACT_TARGETS) {
    const n = normalizeClaudeModel(id);
    if (seen.has(n)) continue;
    seen.add(n);
    ids.push(id);
  }
  const list = ids.map((id, i) => ({
    ...estimateCompact({ ...o, targetModel: id }),
    id,
    role: i === 0 ? 'original' : 'target',
    recommended: false,
    savingVsOriginal: null,
  }));
  const orig = list[0];
  for (const c of list) {
    if (c !== orig && orig.usd != null && c.usd != null && orig.usd > 0) c.savingVsOriginal = (orig.usd - c.usd) / orig.usd;
  }
  let best = null;
  for (const c of list) {
    if (!c.available || c.usd == null) continue;
    if (!best || c.usd < best.usd - 1e-9) best = c; // on a tie keep the first one (the original model comes first)
  }
  if (best) best.recommended = true;
  return { candidates: list, recommended: best ? best.id : null };
}

module.exports = {
  PRICES_UPDATED,
  ANTHROPIC_PRICES, OPENAI_PRICES, OPENAI_LONG_CONTEXT,
  normalizeClaudeModel, claudePriceRow, claudeRates, claudeUsageTokens,
  priceClaude, priceClaudeTokens, priceClaudeDetail,
  normalizeOpenAIModel, isFastTier, openaiRates, openaiUsageTokens, priceOpenAI, priceOpenAITokens,
  TTL_MS, rereadCost, cacheLikelyExpired,
  COMPACT_OUT_RATIO, COMPACT_OUT_MIN, COMPACT_OUT_MAX, COMPACT_HEADROOM, COMPACT_TARGETS,
  compactOutputTokens, estimateCompact, compactCandidates,
};
