'use strict';
// 自动压缩容量的预设档位（DESIGN §11.9；数值与依据来自 docs/compaction-threshold-guide.md 第 6、7 节）。
// 只放数字、词典键和常量，不含界面文字；换算、估价、界面拼装在 lib/autocompact.js。
// 注意：没有任何厂商或论文给过“调研用 X%、写代码用 Y%”的标准答案，下表是折中结果，依据强弱照实标注。

const WINDOW_1M = 1000000;
const WINDOW_200K = 200000;

// autoCompactWindow 的合法范围（Claude Code settings schema：100000–1000000）
const SETTING_MIN = 100000;
const SETTING_MAX = 1000000;

// 实际压缩点 ≈ 设定值（与窗口取小）− 33K【推断：由官方“1M 约 967K 压缩”推出，与 Qwen Code“摘要加输出约需 33K”一致】
const COMPACT_BUFFER = 33000;

// 200K 窗口的模型只能在 50%–100% 之间选（最小值 100K / 200K）
const MIN_PCT_SMALL = SETTING_MIN / WINDOW_200K;

// Codex：默认在窗口的 90% 压缩（源码 auto_compact_token_limit = min(配置值, 窗口 × 9/10)）
const CODEX_DEFAULT_RATIO = 0.9;
// rollout 里的 model_context_window 是可用窗口（完整窗口 × 95%），换算完整窗口用
const CODEX_EFFECTIVE_PCT = 95;

// 参考说明（用户点“查看参考说明”时用 openExternal 打开；这是用户主动点的外链，不算扩展自己联网）
const GUIDE_URL = 'https://github.com/cyuneo/cyuneo-agent-monitor/blob/main/docs/compaction-threshold-guide.md';

/**
 * 成本模型的假设（§11.9、参考说明第 6 节）：
 * 缓存一直热；每次调用把之前的整个上下文按缓存读计费，新增约 3K 按缓存写计费；压缩后剩约 30K；
 * 一次压缩 = 按缓存读把当前上下文读一遍 + 摘要输出（压缩点的 4%，2K–20K）+ 压缩后把 30K 重新写入缓存，平摊到这一轮的每次调用。
 */
const COST_MODEL = Object.freeze({
  perCallNew: 3000,
  afterCompact: 30000,
  summaryRatio: 0.04,
  summaryMin: 2000,
  summaryMax: 20000,
});

/**
 * 预设档位。
 * - value1m：窗口大于 200K 的模型写入的设定值（null = 不设，即 auto）；
 * - value200k：200K 窗口的模型写入的设定值（null = 不设）；
 * - codexRatio：Codex 的压缩比例（× 完整窗口）；
 * - evidence：依据强弱 strong / medium / weak；
 * - reference：参考说明里按 Opus 5.5、1M 窗口算出的“每次调用 / 相对默认”，只给测试对账用。
 * 词典键写全名，方便测试核对“用到的键都在词典里”。
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
  CODEX_DEFAULT_RATIO, CODEX_EFFECTIVE_PCT, GUIDE_URL, COST_MODEL, PRESETS, EVIDENCE_KEYS,
  presetById,
};
