'use strict';
// Preset levels for auto-compaction capacity (values and rationale come from sections 6 and 7 of docs/compaction-threshold-guide.md).
// Only numbers, dictionary keys and constants live here, no UI text; conversion, cost estimates and UI assembly are in lib/autocompact.js.
// Note: no vendor or paper gives a standard answer like "X% for research, Y% for coding". The table below is a compromise, and the strength of the evidence is labeled honestly.

const WINDOW_1M = 1000000;
const WINDOW_200K = 200000;

// Valid range of autoCompactWindow (Claude Code settings schema: 100000–1000000)
const SETTING_MIN = 100000;
const SETTING_MAX = 1000000;

// Actual compaction point ≈ setting (capped at the window) − 33K. Inferred from the official "1M compacts at about 967K"; consistent with Qwen Code's "summary plus output needs about 33K".
const COMPACT_BUFFER = 33000;

// Models with a 200K window can only choose between 50% and 100% (minimum 100K / 200K)
const MIN_PCT_SMALL = SETTING_MIN / WINDOW_200K;

// Codex: compacts at 90% of the window by default (source: auto_compact_token_limit = min(configured value, window × 9/10))
const CODEX_DEFAULT_RATIO = 0.9;
// model_context_window in the rollout is the usable window (full window × 95%); used to convert back to the full window
const CODEX_EFFECTIVE_PCT = 95;

// Reference guide (opened with openExternal when the user clicks "View reference guide"; this is a link the user chooses to open, not the extension going online by itself)
const GUIDE_URL = 'https://github.com/cyuneo/cyuneo-agent-monitor/blob/main/docs/compaction-threshold-guide.md';
// Chinese version of the same guide (Simplified Chinese; also used for zh-tw, which has no separate translation)
const GUIDE_URL_ZH = 'https://github.com/cyuneo/cyuneo-agent-monitor/blob/main/docs/compaction-threshold-guide.zh-CN.md';

/**
 * Reference guide URL for a UI locale: zh-cn / zh-tw (any zh* locale) → Chinese version, everything else → English.
 * @param {string|null|undefined} locale
 * @returns {string}
 */
function guideUrl(locale) {
  return String(locale || '').trim().toLowerCase().startsWith('zh') ? GUIDE_URL_ZH : GUIDE_URL;
}

/**
 * Cost model assumptions (section 6 of the reference guide):
 * The cache stays warm; each call bills the entire previous context as cache reads and about 3K of new tokens as cache writes; about 30K remains after compaction.
 * One compaction = reading the current context once at the cache-read rate + summary output (4% of the compaction point, 2K–20K) + rewriting 30K into the cache afterwards, amortized over every call in that cycle.
 */
const COST_MODEL = Object.freeze({
  perCallNew: 3000,
  afterCompact: 30000,
  summaryRatio: 0.04,
  summaryMin: 2000,
  summaryMax: 20000,
});

/**
 * Preset levels.
 * - value1m: setting written for models with a window larger than 200K (null = not set, i.e. auto);
 * - value200k: setting written for models with a 200K window (null = not set);
 * - codexRatio: Codex compaction ratio (× full window);
 * - evidence: strength of the evidence, strong / medium / weak;
 * - reference: "per call / relative to default" figures from the reference guide, computed for Opus 5.5 with a 1M window; used only for cross-checking in tests.
 * Dictionary keys are written out in full so tests can verify that every key used exists in the dictionary.
 */
const PRESETS = Object.freeze([
  Object.freeze({
    id: 'auto', icon: 'sparkle', value1m: null, value200k: null, codexRatio: 0.9, evidence: 'strong',
    nameKey: 'autocompact.preset.auto.name', summaryKey: 'autocompact.preset.auto.summary', basisKey: 'autocompact.preset.auto.basis',
    reference: Object.freeze({ usdPerCall: 0.126, ratio: 1 }),
  }),
  Object.freeze({
    id: 'coding', icon: 'code', value1m: 400000, value200k: null, codexRatio: 0.9, evidence: 'medium',
    nameKey: 'autocompact.preset.coding.name', summaryKey: 'autocompact.preset.coding.summary', basisKey: 'autocompact.preset.coding.basis',
    reference: Object.freeze({ usdPerCall: 0.069, ratio: 0.55 }),
  }),
  Object.freeze({
    id: 'research', icon: 'search', value1m: 250000, value200k: 160000, codexRatio: 0.8, evidence: 'medium',
    nameKey: 'autocompact.preset.research.name', summaryKey: 'autocompact.preset.research.summary', basisKey: 'autocompact.preset.research.basis',
    reference: Object.freeze({ usdPerCall: 0.056, ratio: 0.44 }),
  }),
  Object.freeze({
    id: 'long', icon: 'watch', value1m: 600000, value200k: null, codexRatio: 0.9, evidence: 'weak',
    nameKey: 'autocompact.preset.long.name', summaryKey: 'autocompact.preset.long.summary', basisKey: 'autocompact.preset.long.basis',
    reference: Object.freeze({ usdPerCall: 0.088, ratio: 0.70 }),
  }),
  Object.freeze({
    id: 'budget', icon: 'credit-card', value1m: 200000, value200k: null, codexRatio: 0.8, evidence: 'medium',
    nameKey: 'autocompact.preset.budget.name', summaryKey: 'autocompact.preset.budget.summary', basisKey: 'autocompact.preset.budget.basis',
    reference: Object.freeze({ usdPerCall: 0.052, ratio: 0.41 }),
  }),
]);

const EVIDENCE_KEYS = Object.freeze({
  strong: 'autocompact.evidence.strong',
  medium: 'autocompact.evidence.medium',
  weak: 'autocompact.evidence.weak',
});

/** @param {string} id */
function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

module.exports = {
  WINDOW_1M, WINDOW_200K, SETTING_MIN, SETTING_MAX, COMPACT_BUFFER, MIN_PCT_SMALL,
  CODEX_DEFAULT_RATIO, CODEX_EFFECTIVE_PCT, GUIDE_URL, GUIDE_URL_ZH, COST_MODEL, PRESETS, EVIDENCE_KEYS,
  presetById, guideUrl,
};
