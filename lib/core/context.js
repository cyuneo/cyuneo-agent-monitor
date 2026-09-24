'use strict';
// Context window and auto-compact threshold. Read-only: never writes anything.
// - The percentage uses Claude Code's own formula (round(used / window × 100), clamped to 0–100); the denominator is the window;
// - Claude window: a cost-state modelUsage key with [1m] → 1M; otherwise the native-1M model rule applies, everything else is 200K;
// - Claude compact point: three settings layers (project local → project → user) → observed (observedCompact) → default;
//   when it comes from a configured value (a setting, or the default "window"), the actual compact point = that value − 33K; an observed value is used as is.
// The extension cannot see the Claude process's environment variables (CLAUDE_CODE_AUTO_COMPACT_WINDOW etc.), so it does not rely on them.

const fs = require('fs');
const path = require('path');
const { WINDOW_SOURCE, COMPACT_SOURCE } = require('./status');

const WINDOW_200K = 200000;
const WINDOW_1M = 1000000;
// The actual compact point is about the configured value minus 33K (inferred from the official "1M compacts at about 967K"; consistent with the Qwen Code docs)
const COMPACT_BUFFER = 33000;
// Models with a native 1M window compact at about 967K by default (Claude Code docs: model-config#default-auto-compact-thresholds)
const COMPACT_1M_DEFAULT = WINDOW_1M - COMPACT_BUFFER;
// Claude models with a native 1M window (Sonnet 5, Fable, Mythos, Opus 4.7 and later on the Anthropic API)
const CLAUDE_1M_RE = /^claude-(opus-(4-[7-9]|[5-9])|sonnet-5|fable-|mythos-)/;
// Valid range of autoCompactWindow (100K–1M)
const OVERRIDE_MIN = 100000;
const OVERRIDE_MAX = 1000000;
// How often, at most, a settings file is stat'ed (it is not re-read on every 2-second refresh)
const SETTINGS_CHECK_MS = 5000;

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Claude Code's context percentage (same formula as its bundled code, e.g. v2.1.280; the status line's context_window.used_percentage uses it too):
 * round(used / window × 100), clamped to 0–100. Returns null when the window is unknown.
 * Showing "<1%" for values above 0 but below 1% is up to the format layer (here the formula gives 0).
 * @param {number} used input + cache_creation + cache_read (Codex: last_token_usage.total_tokens)
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
 * Context window of a Claude model (by model-name rules only). A [1m] suffix, or observed usage above 200K, both count as 1M.
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
 * Find this model among the cost-state.modelUsage keys (step 1 of window resolution).
 * message.model in the transcript has no [1m]; the keys carry the real variant, e.g. 'claude-opus-5-5[1m]'.
 * Looks for a same-name key with [1m] first, then the same-name key; also accepts names without the -YYYYMMDD date suffix. Case-insensitive.
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
 * Claude window and its source: cost-state key with [1m] → 1M (cost-state); otherwise the model rule (model-rule).
 * @param {string|null} model message.model from the transcript
 * @param {number} [contextUsed]
 * @param {string[]|null} [costKeys] modelUsage keys of the latest cost-state
 * @returns {{ contextWindow: number, contextWindowSource: 'cost-state'|'model-rule', modelVariant: string|null }}
 */
function resolveClaudeWindow(model, contextUsed = 0, costKeys = null) {
  const v = costStateVariant(model, costKeys);
  if (v.is1m) return { contextWindow: WINDOW_1M, contextWindowSource: WINDOW_SOURCE.COST_STATE, modelVariant: v.variant };
  return { contextWindow: claudeWindow(model, contextUsed).window, contextWindowSource: WINDOW_SOURCE.MODEL_RULE, modelVariant: v.variant };
}

/** Key for an observed compact point: `${model}|${contextWindow}` (used both when the extension writes globalState and when the worker looks it up) */
function observedKey(model, contextWindow) {
  return `${model || ''}|${contextWindow || ''}`;
}

/**
 * Read the two compaction-related keys from one settings file. Returns an empty object if unreadable or unparseable.
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
 * Settings file cache: each file is stat'ed at most once per checkMs ms and re-read only when its mtime / size changes.
 * Missing file → empty object.
 */
class SettingsCache {
  /** @param {{ checkMs?: number, maxEntries?: number }} [o] */
  constructor(o = {}) {
    this.checkMs = o.checkMs ?? SETTINGS_CHECK_MS;
    this.maxEntries = o.maxEntries ?? 500;
    this.files = new Map(); // file → { checkedAt, mtimeMs, size, value }
    this.reads = 0;         // number of actual file reads (for tests)
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
    try { st = fs.statSync(file); } catch { /* no such file */ }
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

  // When there are too many, drop the least recently checked half
  prune(now) {
    const list = [...this.files].sort((a, b) => a[1].checkedAt - b[1].checkedAt);
    for (const [f] of list.slice(0, Math.ceil(list.length / 2))) this.files.delete(f);
    void now;
  }
}

/**
 * The three settings files to read for a session (highest priority first). With an empty cwd, only user settings.
 * When the session directory is the home directory, <cwd>/.claude/settings.json is the user settings file itself and is not counted again as project settings.
 * @param {string|null} cwd
 * @param {string} userSettingsPath usually <claudeConfigDir>/settings.json
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
 * Merge the three settings layers: each key comes from the highest-priority layer that sets it (same as Claude Code's merge).
 * @param {{ source: string, value: { autoCompactWindow?: number, autoCompactEnabled?: boolean } }[]} layers highest priority first
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
 * Read the effective compaction settings for a session (three layers, cached).
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
 * Auto-compact point and its source.
 * @param {{
 *   contextWindow: number|null,
 *   settings?: { autoCompactWindow?: number|null, windowSource?: string|null, autoCompactEnabled?: boolean|null }|null,
 *   observed?: number|null
 * }} o
 * @returns {{ compactAt: number|null, compactAtSource: string|null, autoCompactWindow: number|null }}
 *   autoCompactWindow: the configured value compactAt was derived from (a setting is capped at the window; default = window); null when observed or disabled.
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
 * Claude context usage, window, compact point and their sources.
 * @param {string|null} model message.model from the transcript
 * @param {number} contextUsed input + cache_creation + cache_read of the last non-synthetic call
 * @param {{ autoCompactWindow?: number|null, windowSource?: string|null, autoCompactEnabled?: boolean|null }} [settings]
 *   result of mergeCompactSettings / claudeCompactSettings; the older readClaudeSettings result is also accepted (treated as user settings)
 * @param {{ costKeys?: string[]|null, observed?: Record<string, number>|null }} [o]
 * @returns {{ contextUsed: number, contextWindow: number|null, contextWindowSource: string|null, modelVariant: string|null,
 *   compactAt: number|null, compactAtSource: string|null, autoCompactWindow: number|null, toCompact: number|null,
 *   autoCompactOff: boolean, contextPct: number|null, pctOfWindow: number, pctOfCompact: number|null }}
 */
function claudeContext(model, contextUsed, settings = {}, o = {}) {
  const used = Math.max(0, Number(contextUsed) || 0);
  // No model reply yet (model unknown, no usage): window and compact point are both unknown; do not guess 200K
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
 * Extract three top-level keys from config.toml text with regexes (only the part before the first [table]).
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
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* missing means not set */ }
  return parseCodexConfig(text);
}

/**
 * models_cache.json → Map(slug → { contextWindow, maxContextWindow, effectivePct })
 * @param {any} json already-parsed object
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
 * Codex context usage and compaction threshold.
 * @param {{ model: string|null, contextUsed: number, modelContextWindow?: number|null }} thread
 *   contextUsed = token_count.info.last_token_usage.total_tokens;
 *   modelContextWindow = token_count.info.model_context_window or task_started.model_context_window
 * @param {Map<string, { contextWindow: number|null, maxContextWindow: number|null, effectivePct: number|null }>} [models]
 * @param {{ modelAutoCompactTokenLimit?: number|null, modelContextWindow?: number|null, autoCompactScope?: string|null }} [config]
 * @returns {{ contextUsed: number, contextWindow: number|null, contextWindowSource: 'codex-record'|'model-rule'|null,
 *   compactAt: number|null, compactAtSource: 'settings-user'|'default'|null, toCompact: number|null,
 *   scopeRelative: boolean, contextPct: number|null, pctOfWindow: number|null, pctOfCompact: number|null }}
 *   Window source: model_context_window present in the transcript → codex-record; only inferable from models_cache → model-rule.
 *   Compact point source: config.toml's model_auto_compact_token_limit took effect → settings-user; otherwise default (window × 0.9).
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
  // Integer math avoids float error from 0.9 / 0.95 (272000 → 244800)
  if (cw) compactAt = Math.floor(cw * 9 / 10);
  else if (usable) compactAt = Math.floor(Math.round(usable * 100 / 95) * 9 / 10); // inferred: back-calculated from the 95% effective ratio
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
