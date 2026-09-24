'use strict';
// Qwen price table and cost calculation (Alibaba Cloud Model Studio / DashScope). USD per million tokens.
// This computes the "equivalent API cost": an estimate at list prices. Qwen OAuth (free tier) users are not billed this way,
// and its model alias ('coder-model') has no list price, so it stays unpriced.
//
// Source: https://www.alibabacloud.com/help/en/model-studio/model-pricing (International deployment, standard list prices,
// page dated 2026-09-24; limited-time discounts are ignored). Other regions (China Beijing, Frankfurt, Global) have other prices.
// Tiered pricing: the tier is chosen by the total input tokens of one request, and all tokens of that request use that tier's prices.
// Context cache (https://www.alibabacloud.com/help/en/model-studio/context-cache): explicit cache hits are billed at 10% of the input
// price (creation at 125%), implicit cache hits at 20% (creation at 100%). Qwen Code's usageMetadata only carries the hit count
// (cachedContentTokenCount), not the creation count or the cache kind, so hits are priced at the explicit rate and flagged "estimated".
// Plain Node, no dependencies.

const QWEN_PRICES_UPDATED = '2026-09-24';
const QWEN_PRICES_SOURCE = 'https://www.alibabacloud.com/help/en/model-studio/model-pricing';
const M = 1e6;
const CACHE_HIT_RATIO = 0.1;   // explicit cache hit (implicit would be 0.2; the record does not say which)

// upTo: inclusive upper bound of input tokens per request for this tier (K = 1,000, M = 1,000,000)
function tier(upTo, input, output, outputThinking) {
  return Object.freeze({ upTo, input, output, outputThinking: outputThinking ?? output });
}
function qwenRow(prefix, tiers) { return Object.freeze({ prefix, tiers: Object.freeze(tiers) }); }

// Matched by prefix at a '-' boundary, longest prefix first, so snapshots (qwen3-coder-plus-2025-09-23) use their family's row
const QWEN_PRICES = Object.freeze([
  qwenRow('qwen3-coder-plus', [tier(32e3, 1, 5), tier(128e3, 1.8, 9), tier(256e3, 3, 15), tier(1e6, 6, 60)]),
  qwenRow('qwen3-coder-flash', [tier(32e3, 0.3, 1.5), tier(128e3, 0.5, 2.5), tier(256e3, 0.8, 4), tier(1e6, 1.6, 9.6)]),
  qwenRow('qwen3-coder-next', [tier(32e3, 0.3, 1.5), tier(128e3, 0.5, 2.5), tier(256e3, 0.8, 4)]),
  qwenRow('qwen3-coder-480b-a35b-instruct', [tier(32e3, 1.5, 7.5), tier(128e3, 2.7, 13.5), tier(200e3, 4.5, 22.5)]),
  qwenRow('qwen3-coder-30b-a3b-instruct', [tier(32e3, 0.45, 2.25), tier(128e3, 0.75, 3.75), tier(200e3, 1.2, 6)]),
  qwenRow('qwen3.8-max', [tier(1e6, 2, 6)]),
  qwenRow('qwen3.7-max', [tier(1e6, 2.5, 7.5)]),
  qwenRow('qwen3.6-max-preview', [tier(128e3, 1.3, 7.8), tier(256e3, 2, 12)]),
  qwenRow('qwen3-max', [tier(32e3, 1.2, 6), tier(128e3, 2.4, 12), tier(256e3, 3, 15)]),
  // Plus models list a separate thinking-mode output price
  qwenRow('qwen3.7-plus', [tier(256e3, 0.4, 1.6, 1.6), tier(1e6, 1.2, 4.8, 4.8)]),
  qwenRow('qwen3.6-plus', [tier(256e3, 0.5, 3, 3), tier(1e6, 2, 6, 6)]),
  qwenRow('qwen3.5-plus', [tier(256e3, 0.4, 2.4, 2.4), tier(1e6, 0.5, 3, 3)]),
  qwenRow('qwen-plus', [tier(256e3, 0.4, 1.2, 4), tier(1e6, 1.2, 3.6, 12)]),
]);
const QWEN_BY_LENGTH = [...QWEN_PRICES].sort((a, b) => b.prefix.length - a.prefix.length);

function int(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; }

/**
 * Normalize a model id: lowercase, trim, drop a vendor prefix ('qwen/…', 'dashscope/…', 'alibaba/…').
 * @param {string|null} model
 * @returns {string|null}
 */
function normalizeQwenModel(model) {
  if (typeof model !== 'string') return null;
  let m = model.trim().toLowerCase();
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  return m || null;
}

/** @param {string|null} model @returns {typeof QWEN_PRICES[number]|null} */
function qwenPriceRow(model) {
  const m = normalizeQwenModel(model);
  if (!m) return null;
  for (const r of QWEN_BY_LENGTH) {
    if (m === r.prefix || (m.startsWith(r.prefix) && m[r.prefix.length] === '-')) return r;
  }
  return null;
}

/**
 * Rates for one request.
 * @param {string|null} model
 * @param {number} [promptTokens] total input tokens of the request (picks the tier)
 * @returns {{ input: number, cacheRead: number, output: number, outputThinking: number, upTo: number, overLimit: boolean }|null}
 *   overLimit: the input is above the largest listed tier (the largest tier's prices are used)
 */
function qwenRates(model, promptTokens = 0) {
  const r = qwenPriceRow(model);
  if (!r) return null;
  const p = int(promptTokens);
  let t = r.tiers.find((x) => p <= x.upTo);
  const overLimit = !t;
  if (!t) t = r.tiers[r.tiers.length - 1];
  return { input: t.input, cacheRead: t.input * CACHE_HIT_RATIO, output: t.output, outputThinking: t.outputThinking, upTo: t.upTo, overLimit };
}

/**
 * Qwen Code usageMetadata (Gemini field names) → token breakdown.
 * promptTokenCount includes the cached part. Billed output = totalTokenCount − promptTokenCount when the total is present
 * (this holds whether or not candidatesTokenCount already includes thoughtsTokenCount); otherwise candidates + thoughts.
 * @param {any} u
 * @returns {{ prompt: number, input: number, cached: number, output: number, thoughts: number, total: number }}
 */
function qwenUsageTokens(u) {
  const prompt = int(u && u.promptTokenCount);
  const cached = Math.min(prompt, int(u && u.cachedContentTokenCount));
  const cand = int(u && u.candidatesTokenCount);
  const thoughts = int(u && u.thoughtsTokenCount);
  const totalRaw = int(u && u.totalTokenCount);
  const output = totalRaw > prompt ? totalRaw - prompt : cand + thoughts;
  return { prompt, input: prompt - cached, cached, output, thoughts, total: totalRaw || prompt + output };
}

/**
 * Cost of one API call.
 * @param {string|null} model
 * @param {any} usageMetadata
 * @returns {{ usd: number, estimated: boolean }|null} null when the model has no price
 */
function priceQwen(model, usageMetadata) {
  const tok = qwenUsageTokens(usageMetadata);
  const r = qwenRates(model, tok.prompt);
  if (!r) return null;
  const outRate = tok.thoughts > 0 ? r.outputThinking : r.output;
  const usd = (tok.input * r.input + tok.cached * r.cacheRead + tok.output * outRate) / M;
  return { usd, estimated: tok.cached > 0 || r.overLimit };
}

module.exports = {
  QWEN_PRICES_UPDATED, QWEN_PRICES_SOURCE, QWEN_PRICES, CACHE_HIT_RATIO,
  normalizeQwenModel, qwenPriceRow, qwenRates, qwenUsageTokens, priceQwen,
};
