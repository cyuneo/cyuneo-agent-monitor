'use strict';
// 上下文窗口与自动压缩阈值（DESIGN §6.1，§11.9、§11.10 优先）。只读文件，不写任何东西。
// - 百分比用 Claude Code 自己的公式（round(已用 / 窗口 × 100)，夹在 0–100），分母是窗口；
// - Claude 窗口：cost-state 的 modelUsage 键带 [1m] → 1M；否则按原生 1M 的模型规则，其余 200K；
// - Claude 压缩点：设置三层（项目本地 → 项目 → 用户）→ 实测（observedCompact）→ 默认；
//   来自设定值（设置或默认的“窗口”）的，实际压缩点 = 设定值 − 33K；来自实测的直接用实测值。
// 插件看不到 Claude 进程的环境变量（CLAUDE_CODE_AUTO_COMPACT_WINDOW 等），不依赖它们（§11.10）。

const fs = require('fs');
const path = require('path');
const { WINDOW_SOURCE, COMPACT_SOURCE } = require('./status');

const WINDOW_200K = 200000;
const WINDOW_1M = 1000000;
// §11.9：实际压缩点约为设定值减 33K【推断：由官方“1M 约 967K 压缩”推出，与 Qwen Code 文档一致】
const COMPACT_BUFFER = 33000;
// 原生 1M 的模型默认在约 967K 压缩【文档 model-config#default-auto-compact-thresholds】
const COMPACT_1M_DEFAULT = WINDOW_1M - COMPACT_BUFFER;
// 原生 1M 窗口的 Claude 模型（Anthropic API 上的 Sonnet 5、Fable、Mythos、Opus 4.7 及以后）
const CLAUDE_1M_RE = /^claude-(opus-(4-[7-9]|[5-9])|sonnet-5|fable-|mythos-)/;
// autoCompactWindow 的合法范围（100K–1M）
const OVERRIDE_MIN = 100000;
const OVERRIDE_MAX = 1000000;
// 设置文件多久最多 stat 一次（不在每 2 秒的刷新里重读）
const SETTINGS_CHECK_MS = 5000;

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Claude Code 的上下文百分比（本机 2.1.280 打包代码 KJt，状态栏 context_window.used_percentage 也用它）：
 * round(已用 / 窗口 × 100)，夹在 0–100。窗口不知道时返回 null。
 * 小于 1% 但大于 0 时显示“<1%”由 format 层判断（这里照公式给 0）。
 * @param {number} used input + cache_creation + cache_read（Codex：last_token_usage.total_tokens）
 * @param {number|null} window
 * @returns {number|null}
 */
function usedPercent(used, window) {
  const w = num(window);
  if (!w || w <= 0) return null;
  const u = Math.max(0, Number(used) || 0);
  return Math.max(0, Math.min(100, Math.round(u / w * 100)));
}

/**
 * Claude 模型的上下文窗口（只按模型名规则）。带 [1m] 后缀、或观察到的占用已超过 200K，都按 1M 算。
 * @param {string|null} model
 * @param {number} [contextUsed]
 * @returns {{ window: number, native1m: boolean }}
 */
function claudeWindow(model, contextUsed = 0) {
  const m = String(model || '').toLowerCase();
  const native1m = CLAUDE_1M_RE.test(m.replace(/^(?:[a-z]{2}\.)?anthropic\./, ''));
  if (native1m || /\[1m\]/.test(m) || contextUsed > WINDOW_200K) return { window: WINDOW_1M, native1m };
  return { window: WINDOW_200K, native1m: false };
}

/**
 * 在 cost-state.modelUsage 的键里找这个模型（§11.10 第 1 步）。
 * 记录里的 message.model 不带 [1m]；键名带真实变体，例如 'claude-opus-5-5[1m]'。
 * 先找同名带 [1m] 的键，再找同名键；也认去掉 -YYYYMMDD 日期后缀的写法。大小写不敏感。
 * @param {string|null} model
 * @param {string[]|null} keys
 * @returns {{ variant: string|null, is1m: boolean }}
 */
function costStateVariant(model, keys) {
  if (!model || !Array.isArray(keys) || !keys.length) return { variant: null, is1m: false };
  const m = String(model).toLowerCase();
  const bases = [m];
  const noDate = m.replace(/-\d{8}$/, '');
  if (noDate !== m) bases.push(noDate);
  const byLower = new Map();
  for (const k of keys) if (typeof k === 'string' && k) byLower.set(k.toLowerCase(), k);
  for (const b of bases) { const k = byLower.get(b + '[1m]'); if (k) return { variant: k, is1m: true }; }
  for (const b of bases) { const k = byLower.get(b); if (k) return { variant: k, is1m: false }; }
  return { variant: null, is1m: false };
}

/**
 * Claude 窗口与来源（§11.10）：cost-state 键带 [1m] → 1M（cost-state）；否则按模型规则（model-rule）。
 * @param {string|null} model 记录里的 message.model
 * @param {number} [contextUsed]
 * @param {string[]|null} [costKeys] 最后一条 cost-state 的 modelUsage 键
 * @returns {{ contextWindow: number, contextWindowSource: 'cost-state'|'model-rule', modelVariant: string|null }}
 */
function resolveClaudeWindow(model, contextUsed = 0, costKeys = null) {
  const v = costStateVariant(model, costKeys);
  if (v.is1m) return { contextWindow: WINDOW_1M, contextWindowSource: WINDOW_SOURCE.COST_STATE, modelVariant: v.variant };
  return { contextWindow: claudeWindow(model, contextUsed).window, contextWindowSource: WINDOW_SOURCE.MODEL_RULE, modelVariant: v.variant };
}

/** 实测压缩点的键：`${model}|${contextWindow}`（扩展写 globalState、worker 查表都用它） */
function observedKey(model, contextWindow) {
  return `${model || ''}|${contextWindow || ''}`;
}

/**
 * 读一个 settings 文件里和压缩有关的两个键。读不到、解析失败返回空对象。
 * @param {string} settingsPath
 * @returns {{ autoCompactWindow?: number, autoCompactEnabled?: boolean }}
 */
function readClaudeSettings(settingsPath) {
  let j;
  try { j = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return {}; }
  return pickCompactKeys(j);
}

function pickCompactKeys(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
  const out = {};
  const w = num(j.autoCompactWindow);
  if (w != null) out.autoCompactWindow = w;
  if (typeof j.autoCompactEnabled === 'boolean') out.autoCompactEnabled = j.autoCompactEnabled;
  return out;
}

/**
 * settings 文件缓存：每个文件最多每 checkMs 毫秒 stat 一次，mtime / 大小变了才重读。
 * 文件不存在 → 空对象。
 */
class SettingsCache {
  /** @param {{ checkMs?: number, maxEntries?: number }} [o] */
  constructor(o = {}) {
    this.checkMs = o.checkMs ?? SETTINGS_CHECK_MS;
    this.maxEntries = o.maxEntries ?? 500;
    this.files = new Map(); // 文件 → { checkedAt, mtimeMs, size, value }
    this.reads = 0;         // 真正读文件的次数（测试用）
  }

  /**
   * @param {string} file
   * @param {number} [now]
   * @returns {{ autoCompactWindow?: number, autoCompactEnabled?: boolean }}
   */
  get(file, now = Date.now()) {
    let c = this.files.get(file);
    if (c && now - c.checkedAt < this.checkMs && now >= c.checkedAt) return c.value;
    let st = null;
    try { st = fs.statSync(file); } catch { /* 没有这个文件 */ }
    if (!c) {
      if (this.files.size >= this.maxEntries) this.prune(now);
      c = { checkedAt: now, mtimeMs: -1, size: -1, value: {} };
      this.files.set(file, c);
    }
    c.checkedAt = now;
    if (!st || !st.isFile()) { c.mtimeMs = -1; c.size = -1; c.value = {}; return c.value; }
    if (st.mtimeMs === c.mtimeMs && st.size === c.size) return c.value;
    this.reads++;
    c.mtimeMs = st.mtimeMs;
    c.size = st.size;
    c.value = readClaudeSettings(file);
    return c.value;
  }

  // 太多时丢掉最久没查过的一半
  prune(now) {
    const list = [...this.files].sort((a, b) => a[1].checkedAt - b[1].checkedAt);
    for (const [f] of list.slice(0, Math.ceil(list.length / 2))) this.files.delete(f);
    void now;
  }
}

/**
 * 某个会话要读的三层设置文件（优先级从高到低，§11.10）。cwd 为空时只有用户设置。
 * 会话目录就是主目录时，<cwd>/.claude/settings.json 就是用户设置本身，不重复算作项目设置。
 * @param {string|null} cwd
 * @param {string} userSettingsPath 通常是 <claudeConfigDir>/settings.json
 * @returns {{ source: 'settings-local'|'settings-project'|'settings-user', file: string }[]}
 */
function claudeSettingsFiles(cwd, userSettingsPath) {
  const out = [];
  if (cwd && typeof cwd === 'string') {
    const dir = path.join(cwd, '.claude');
    out.push({ source: COMPACT_SOURCE.SETTINGS_LOCAL, file: path.join(dir, 'settings.local.json') });
    const proj = path.join(dir, 'settings.json');
    if (!userSettingsPath || path.resolve(proj) !== path.resolve(userSettingsPath)) {
      out.push({ source: COMPACT_SOURCE.SETTINGS_PROJECT, file: proj });
    }
  }
  if (userSettingsPath) out.push({ source: COMPACT_SOURCE.SETTINGS_USER, file: userSettingsPath });
  return out;
}

/**
 * 合并三层设置：每个键取优先级最高、且写了这个键的那一层（与 Claude Code 的合并方式一致）。
 * @param {{ source: string, value: { autoCompactWindow?: number, autoCompactEnabled?: boolean } }[]} layers 优先级从高到低
 * @returns {{ autoCompactWindow: number|null, windowSource: string|null, autoCompactEnabled: boolean|null, enabledSource: string|null }}
 */
function mergeCompactSettings(layers) {
  const out = { autoCompactWindow: null, windowSource: null, autoCompactEnabled: null, enabledSource: null };
  for (const l of layers || []) {
    const v = (l && l.value) || {};
    if (out.autoCompactWindow == null && num(v.autoCompactWindow) != null) {
      out.autoCompactWindow = num(v.autoCompactWindow);
      out.windowSource = l.source;
    }
    if (out.autoCompactEnabled == null && typeof v.autoCompactEnabled === 'boolean') {
      out.autoCompactEnabled = v.autoCompactEnabled;
      out.enabledSource = l.source;
    }
  }
  return out;
}

/**
 * 读某个会话生效的压缩设置（三层，带缓存）。
 * @param {SettingsCache} cache
 * @param {string|null} cwd
 * @param {string} userSettingsPath
 * @param {number} [now]
 */
function claudeCompactSettings(cache, cwd, userSettingsPath, now = Date.now()) {
  const layers = claudeSettingsFiles(cwd, userSettingsPath).map((x) => ({ source: x.source, value: cache.get(x.file, now) }));
  return mergeCompactSettings(layers);
}

/**
 * 自动压缩点与来源（§11.10）。
 * @param {{
 *   contextWindow: number|null,
 *   settings?: { autoCompactWindow?: number|null, windowSource?: string|null, autoCompactEnabled?: boolean|null }|null,
 *   observed?: number|null
 * }} o
 * @returns {{ compactAt: number|null, compactAtSource: string|null, autoCompactWindow: number|null }}
 *   autoCompactWindow：compactAt 由哪个“设定值”推出来（设置取与窗口的较小值；默认 = 窗口）；实测、已关时为 null。
 */
function resolveClaudeCompact(o) {
  const window = num(o && o.contextWindow);
  const st = (o && o.settings) || {};
  if (st.autoCompactEnabled === false) return { compactAt: null, compactAtSource: COMPACT_SOURCE.DISABLED, autoCompactWindow: null };
  if (!window || window <= 0) return { compactAt: null, compactAtSource: null, autoCompactWindow: null };
  const setting = num(st.autoCompactWindow);
  if (setting != null && setting > 0) {
    const v = Math.min(OVERRIDE_MAX, Math.max(OVERRIDE_MIN, setting));
    const set = Math.min(v, window);
    return {
      compactAt: Math.max(0, set - COMPACT_BUFFER),
      compactAtSource: st.windowSource || COMPACT_SOURCE.SETTINGS_USER,
      autoCompactWindow: set,
    };
  }
  const obs = num(o && o.observed);
  if (obs != null && obs > 0) return { compactAt: Math.min(Math.round(obs), window), compactAtSource: COMPACT_SOURCE.OBSERVED, autoCompactWindow: null };
  return { compactAt: Math.max(0, window - COMPACT_BUFFER), compactAtSource: COMPACT_SOURCE.DEFAULT, autoCompactWindow: window };
}

/**
 * Claude 的上下文占用、窗口、压缩点与来源（§6.1 + §11.10）。
 * @param {string|null} model 记录里的 message.model
 * @param {number} contextUsed 上次非 synthetic 调用的 input + cache_creation + cache_read
 * @param {{ autoCompactWindow?: number|null, windowSource?: string|null, autoCompactEnabled?: boolean|null }} [settings]
 *   mergeCompactSettings / claudeCompactSettings 的结果；也接受旧写法 readClaudeSettings 的结果（按用户设置算）
 * @param {{ costKeys?: string[]|null, observed?: Record<string, number>|null }} [o]
 * @returns {{ contextUsed: number, contextWindow: number|null, contextWindowSource: string|null, modelVariant: string|null,
 *   compactAt: number|null, compactAtSource: string|null, autoCompactWindow: number|null, toCompact: number|null,
 *   autoCompactOff: boolean, contextPct: number|null, pctOfWindow: number, pctOfCompact: number|null }}
 */
function claudeContext(model, contextUsed, settings = {}, o = {}) {
  const used = Math.max(0, Number(contextUsed) || 0);
  // 还没有任何模型回复（不知道模型、也没有占用）：窗口和压缩点都不知道，不按 200K 猜
  const win = !model && !used
    ? { contextWindow: null, contextWindowSource: null, modelVariant: null }
    : resolveClaudeWindow(model, used, o && o.costKeys);
  const observedMap = o && o.observed && typeof o.observed === 'object' ? o.observed : null;
  const observed = observedMap ? num(observedMap[observedKey(model, win.contextWindow)]) : null;
  const cp = resolveClaudeCompact({ contextWindow: win.contextWindow, settings, observed });
  return {
    contextUsed: used,
    contextWindow: win.contextWindow,
    contextWindowSource: win.contextWindowSource,
    modelVariant: win.modelVariant,
    compactAt: cp.compactAt,
    compactAtSource: cp.compactAtSource,
    autoCompactWindow: cp.autoCompactWindow,
    toCompact: cp.compactAt == null ? null : Math.max(0, cp.compactAt - used),
    autoCompactOff: cp.compactAtSource === COMPACT_SOURCE.DISABLED,
    contextPct: usedPercent(used, win.contextWindow),
    pctOfWindow: win.contextWindow ? used / win.contextWindow : 0,
    pctOfCompact: cp.compactAt ? used / cp.compactAt : null,
  };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/**
 * 从 config.toml 文本里用正则取三个顶层键（只看第一个 [表] 之前的部分）。
 * @param {string} text
 * @returns {{ modelAutoCompactTokenLimit: number|null, modelContextWindow: number|null, autoCompactScope: string|null }}
 */
function parseCodexConfig(text) {
  const out = { modelAutoCompactTokenLimit: null, modelContextWindow: null, autoCompactScope: null };
  if (typeof text !== 'string' || !text) return out;
  const top = text.split(/^\s*\[/m)[0];
  const numKey = (k) => {
    const m = new RegExp('^\\s*' + k + '\\s*=\\s*([0-9_]+)\\s*(?:#.*)?$', 'm').exec(top);
    return m ? Number(m[1].replace(/_/g, '')) : null;
  };
  out.modelAutoCompactTokenLimit = numKey('model_auto_compact_token_limit');
  out.modelContextWindow = numKey('model_context_window');
  const s = /^\s*model_auto_compact_token_limit_scope\s*=\s*["']([^"']*)["']/m.exec(top);
  if (s) out.autoCompactScope = s[1];
  return out;
}

/** @param {string} file */
function readCodexConfig(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* 没有就当没设 */ }
  return parseCodexConfig(text);
}

/**
 * models_cache.json → Map(slug → { contextWindow, maxContextWindow, effectivePct })
 * @param {any} json 已解析的对象
 */
function codexModelsIndex(json) {
  const map = new Map();
  const list = json && Array.isArray(json.models) ? json.models : [];
  for (const m of list) {
    if (!m || typeof m.slug !== 'string') continue;
    map.set(m.slug, {
      contextWindow: num(m.context_window),
      maxContextWindow: num(m.max_context_window),
      effectivePct: num(m.effective_context_window_percent),
    });
  }
  return map;
}

/** @param {string} file */
function readCodexModelsCache(file) {
  try { return codexModelsIndex(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return new Map(); }
}

/**
 * Codex 的上下文占用与压缩阈值（§6.1）。
 * @param {{ model: string|null, contextUsed: number, modelContextWindow?: number|null }} thread
 *   contextUsed = token_count.info.last_token_usage.total_tokens；
 *   modelContextWindow = token_count.info.model_context_window 或 task_started.model_context_window
 * @param {Map<string, { contextWindow: number|null, maxContextWindow: number|null, effectivePct: number|null }>} [models]
 * @param {{ modelAutoCompactTokenLimit?: number|null, modelContextWindow?: number|null, autoCompactScope?: string|null }} [config]
 * @returns {{ contextUsed: number, contextWindow: number|null, contextWindowSource: 'codex-record'|'model-rule'|null,
 *   compactAt: number|null, compactAtSource: 'settings-user'|'default'|null, toCompact: number|null,
 *   scopeRelative: boolean, contextPct: number|null, pctOfWindow: number|null, pctOfCompact: number|null }}
 *   窗口来源：记录里给了 model_context_window → codex-record；只能按 models_cache 推 → model-rule。
 *   压缩点来源：config.toml 的 model_auto_compact_token_limit 起了作用 → settings-user；否则 default（窗口 × 0.9）。
 */
function codexContext(thread, models = new Map(), config = {}) {
  const used = Math.max(0, Number(thread && thread.contextUsed) || 0);
  const usable = num(thread && thread.modelContextWindow);
  const info = thread && thread.model && models && models.get ? models.get(thread.model) : null;
  const cfg = config || {};
  let cw = num(cfg.modelContextWindow);
  if (cw == null && info) cw = info.contextWindow || info.maxContextWindow || null;
  let compactAt = null;
  /** @type {'settings-user'|'default'|null} */
  let compactAtSource = null;
  // 用整数运算，避免 0.9、0.95 的浮点误差（272000 → 244800）
  if (cw) compactAt = Math.floor(cw * 9 / 10);
  else if (usable) compactAt = Math.floor(Math.round(usable * 100 / 95) * 9 / 10); // 【推断】按 95% 有效比例反推
  if (compactAt != null) compactAtSource = COMPACT_SOURCE.DEFAULT;
  const limit = num(cfg.modelAutoCompactTokenLimit);
  if (limit != null && limit > 0 && (compactAt == null || limit < compactAt)) {
    compactAt = limit;
    compactAtSource = COMPACT_SOURCE.SETTINGS_USER;
  }
  let contextWindow = usable;
  /** @type {'codex-record'|'model-rule'|null} */
  let contextWindowSource = usable ? WINDOW_SOURCE.CODEX_RECORD : null;
  if (contextWindow == null && cw) {
    const eff = info && info.effectivePct ? info.effectivePct : 95;
    contextWindow = Math.floor(cw * eff / 100);
    contextWindowSource = WINDOW_SOURCE.MODEL_RULE;
  }
  const scopeRelative = cfg.autoCompactScope === 'body_after_prefix';
  return {
    contextUsed: used,
    contextWindow,
    contextWindowSource,
    compactAt,
    compactAtSource,
    toCompact: scopeRelative || compactAt == null ? null : Math.max(0, compactAt - used),
    scopeRelative,
    contextPct: usedPercent(used, contextWindow),
    pctOfWindow: contextWindow ? used / contextWindow : null,
    pctOfCompact: compactAt && !scopeRelative ? used / compactAt : null,
  };
}

module.exports = {
  WINDOW_200K, WINDOW_1M, COMPACT_BUFFER, COMPACT_1M_DEFAULT, CLAUDE_1M_RE, OVERRIDE_MIN, OVERRIDE_MAX, SETTINGS_CHECK_MS,
  usedPercent, claudeWindow, costStateVariant, resolveClaudeWindow, observedKey,
  readClaudeSettings, SettingsCache, claudeSettingsFiles, mergeCompactSettings, claudeCompactSettings,
  resolveClaudeCompact, claudeContext,
  parseCodexConfig, readCodexConfig, codexModelsIndex, readCodexModelsCache, codexContext,
};
