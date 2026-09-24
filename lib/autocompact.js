'use strict';
// Lets the user set the auto-compaction capacity themselves: command agentMonitor.setAutoCompact.
// - The QuickPick lists the preset levels (lib/compact-presets.js). Each shows the setting (percentage + tokens), roughly where compaction happens, a one-line summary,
//   the strength of the evidence, and "about how much per call, how much cheaper than default" based on the session model's prices, ending with a reminder that more frequent compaction loses more context;
//   last come "Custom…" (100K–1M; accepts shorthand like 300k / 300000 / 300, same rules as Claude Code's /autocompact) and "View reference guide".
// - Models with a 200K window: levels below 50% are unavailable (the setting minimum is 100K); "long autonomous runs" equals the default on 200K and is unavailable too; the reason is shown for each.
// - Scope, one of two: all projects / this project only.
//   · Session open + all projects → prefill /autocompact <value> (reusing compact.js's prefill and clipboard fallback), and Claude Code writes the user settings itself;
//   · Otherwise the extension writes the JSON: only the autoCompactWindow key changes, original indentation and key order are kept, the file is first backed up to the extension's globalStorage,
//     nothing is written and an error is reported if parsing fails, the key is removed for auto, .claude/ is created if missing, and symlinks are written through to the real file.
// - Codex: the TOML is not modified; the extension only copies `model_auto_compact_token_limit = <value>`, opens config.toml, and says to put it at the top of the file, before any [table].
// - The extension never goes online; "View reference guide" is an external link the user chooses to open (openExternal). No setting is written without a user action.
// - Conversion, cost estimates, JSON editing, input parsing, option building and describeCompactSetting are pure functions called directly by tests; vscode is only used inside activateAutoCompact.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pricing = require('./core/pricing');
const { claudeWindow, parseCodexConfig } = require('./core/context');
const claudeLive = require('./providers/claude-live');
const P = require('./compact-presets');
const compactLib = require('./compact');

const CMD = 'agentMonitor.setAutoCompact';
const SETTING_KEY = 'autoCompactWindow';
const CODEX_KEY = 'model_auto_compact_token_limit';
const ENV_WINDOW = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const BACKUP_DIR = 'autocompact-backups';
const BACKUP_KEEP = 30;                 // keep at most this many backups; older ones are deleted
const SEPARATOR_KIND = -1;              // vscode.QuickPickItemKind.Separator
const SAME_EPS = 0.005;                 // estimates within 0.5% count as "same as default"
const SEP = ' · ';

// Compaction point source → dictionary key (written out in full so tests can verify them)
const SOURCE_KEYS = Object.freeze({
  settingsLocal: 'autocompact.source.settingsLocal',
  settingsProject: 'autocompact.source.settingsProject',
  settingsUser: 'autocompact.source.settingsUser',
  env: 'autocompact.source.env',
  observed: 'autocompact.source.observed',
  default: 'autocompact.source.default',
  disabled: 'autocompact.source.disabled',
  codexConfig: 'autocompact.source.codexConfig',
  codexDefault: 'autocompact.source.codexDefault',
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (fin(v) ? v : null);
const clip = (s, n) => {
  const a = Array.from(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
  return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join('');
};

// ---------------------------------------------------------------------------
// Window, compaction point, current setting
// ---------------------------------------------------------------------------

/** Window of a Claude session: Session.contextWindow (from providers) → the main agent's → inferred from model rules */
function claudeWindowOf(session) {
  const t = (session.main && session.main.tokens) || {};
  const w = num(session.contextWindow) ?? num(t.contextWindow);
  if (w && w > 0) return w;
  return claudeWindow(session.modelVariant || session.model || null, compactLib.contextUsedOf(session)).window;
}

/**
 * Codex full window (the denominator of the compaction ratio): model_context_window in the rollout is the usable window (full × 95%), so convert back;
 * with no record, fall back to the default 272K (section 7 of the reference guide).
 */
function codexFullWindow(session) {
  const t = (session.main && session.main.tokens) || {};
  const usable = num(session.contextWindow) ?? num(t.contextWindow);
  if (usable && usable > 0) return Math.round(usable * 100 / P.CODEX_EFFECTIVE_PCT);
  return 272000;
}

/** Session window (Claude: model window; Codex: full window) */
function windowOf(session) {
  return session.provider === 'codex' ? codexFullWindow(session) : claudeWindowOf(session);
}

/** Setting → roughly where compaction actually happens: min(setting, window) − 33K; null (auto) → window − 33K */
function effectivePoint(value, window) {
  const w = fin(window) && window > 0 ? window : P.WINDOW_200K;
  const v = fin(value) && value > 0 ? Math.min(value, w) : w;
  return Math.max(0, v - P.COMPACT_BUFFER);
}

/** Codex setting from a ratio (integer math to avoid 0.9 floating-point error: 272000 → 244800) */
function codexValueFor(ratio, full) {
  return Math.floor(full * Math.round(ratio * 100) / 100);
}

/** Codex default compaction point: full window × 90% */
function codexDefaultPoint(full) {
  return codexValueFor(P.CODEX_DEFAULT_RATIO, full);
}

/**
 * The setting currently in effect (inferred from the Session's compactAt / compactAtSource).
 * If providers supply the raw setting Session.autoCompactWindow, use it directly; otherwise infer it from a settings-sourced compactAt as "setting − 33K".
 * @returns {{ source: string, value: number|null, point: number|null, off: boolean, window: number }}
 *   value: null = auto (not set); point: roughly where compaction actually happens
 */
function currentSetting(session) {
  const window = windowOf(session);
  const t = (session.main && session.main.tokens) || {};
  const src = session.compactAtSource || null;
  const at = num(session.compactAt) ?? num(t.compactAt);
  if (session.provider === 'codex') {
    const dflt = codexDefaultPoint(window);
    const point = at != null && at > 0 ? at : dflt;
    // If there is a source, trust it; only infer from "smaller than the default point" when the source is missing
    const custom = src ? /^settings-/.test(String(src)) : (at != null && at < dflt);
    return { source: custom ? 'codexConfig' : 'codexDefault', value: custom ? point : null, point, off: false, window };
  }
  if (src === 'disabled') return { source: 'disabled', value: null, point: null, off: true, window };
  if (src === 'settings-local' || src === 'settings-project' || src === 'settings-user' || src === 'env') {
    let value = num(session.autoCompactWindow);
    if (value == null && at != null) value = Math.min(window, at + P.COMPACT_BUFFER);
    const point = at != null ? at : effectivePoint(value, window);
    const source = { 'settings-local': 'settingsLocal', 'settings-project': 'settingsProject', 'settings-user': 'settingsUser', env: 'env' }[src];
    return { source, value, point, off: false, window };
  }
  if (src === 'observed' && at != null) return { source: 'observed', value: null, point: at, off: false, window };
  return { source: 'default', value: null, point: effectivePoint(null, window), off: false, window };
}

// ---------------------------------------------------------------------------
// Cost model (section 6 of the reference guide)
// ---------------------------------------------------------------------------

/**
 * Unit prices for the session's model (USD per million tokens); not hard-coded to Opus 5.5:
 * Claude: re-read = cache hit price, new = cache write price for the session's cache tier (1 hour by default); Codex: re-read = cached input price, new = input price.
 * @returns {{ read: number, write: number, output: number, model: string }|null}
 */
function ratesFor(session) {
  const model = session.provider === 'codex' ? session.model : (session.modelVariant || session.model);
  if (!model) return null;
  if (session.provider === 'codex') {
    const r = pricing.openaiRates(model);
    return r ? { read: r.cached, write: r.input, output: r.output, model } : null;
  }
  const r = pricing.claudeRates(model);
  if (!r) return null;
  const ttl = compactLib.ttlOf(session);
  return { read: r.cacheRead, write: ttl === '5m' ? r.cacheWrite5m : r.cacheWrite1h, output: r.output, model };
}

/**
 * Average equivalent cost per call for a given compaction point.
 * Calls per cycle n = round((point − 30K) / 3K), average context = 30K + 3K × (n − 1) / 2;
 * per call = average context × read price + 3K × write price + cost of one compaction / n;
 * one compaction = point × read price + summary (point × 4%, 2K–20K) × output price + 30K × write price.
 * @param {number} point actual compaction point
 * @param {{ read: number, write: number, output: number }|null} rates
 * @param {typeof P.COST_MODEL} [m]
 * @returns {{ calls: number, avgContext: number, rereadUsd: number, writeUsd: number, compactUsd: number,
 *   perCallUsd: number, compactionsPer100: number }|null}
 */
function costPerCall(point, rates, m = P.COST_MODEL) {
  if (!rates || !fin(point) || point <= m.afterCompact) return null;
  const calls = callsPerCycle(point, m);
  const avgContext = m.afterCompact + m.perCallNew * (calls - 1) / 2;
  const summary = Math.min(m.summaryMax, Math.max(m.summaryMin, Math.round(point * m.summaryRatio)));
  const rereadUsd = avgContext * rates.read / 1e6;
  const writeUsd = m.perCallNew * rates.write / 1e6;
  const compactUsd = (point * rates.read + summary * rates.output + m.afterCompact * rates.write) / 1e6;
  return {
    calls, avgContext, rereadUsd, writeUsd, compactUsd,
    perCallUsd: rereadUsd + writeUsd + compactUsd / calls,
    compactionsPer100: 100 / calls,
  };
}

// ---------------------------------------------------------------------------
// Preset levels → options (pure data; UI text is in buildPresetItems)
// ---------------------------------------------------------------------------

/**
 * Value and cost estimate of each preset for this session.
 * @param {any} session
 * @returns {{ id: string, preset: any, value: number|null, available: boolean, reason: 'below50'|'sameAsDefault'|null,
 *   window: number, point: number|null, pct: number|null, sameAsDefault: boolean, current: boolean,
 *   usdPerCall: number|null, ratio: number|null, compactionsPer100: number|null, freq: number|null }[]}
 *   ratio: cost per call / default; freq: compaction frequency as a multiple of the default
 */
function presetOptions(session) {
  const cur = currentSetting(session);
  const rates = ratesFor(session);
  const window = cur.window;
  if (session.provider === 'codex') {
    const dflt = codexDefaultPoint(window);
    const base = costPerCall(dflt, rates);
    return P.PRESETS.map((p) => {
      const v = codexValueFor(p.codexRatio, window);
      const isDefault = p.id === 'auto' || v >= dflt;
      const point = isDefault ? dflt : v;
      const c = costPerCall(point, rates);
      return {
        id: p.id, preset: p, value: isDefault ? null : v, available: true, reason: null, window, point,
        pct: point / window, sameAsDefault: isDefault && p.id !== 'auto',
        current: p.id === 'auto' ? cur.value == null : (!isDefault && cur.value === v),
        usdPerCall: c ? c.perCallUsd : null,
        ratio: c && base && base.perCallUsd > 0 ? c.perCallUsd / base.perCallUsd : null,
        compactionsPer100: c ? c.compactionsPer100 : null,
        freq: freqOf(point, dflt),
      };
    });
  }
  const small = window <= P.WINDOW_200K;
  const dfltPoint = cur.source === 'observed' && cur.point ? cur.point : effectivePoint(null, window);
  const base = costPerCall(dfltPoint, rates);
  return P.PRESETS.map((p) => {
    let value = null;
    let available = true;
    let reason = null;
    if (p.id !== 'auto') {
      if (!small) value = p.value1m;
      else if (p.value200k != null) value = p.value200k;
      else {
        available = false;
        reason = p.value1m / P.WINDOW_1M < P.MIN_PCT_SMALL ? 'below50' : 'sameAsDefault';
      }
    }
    const point = !available ? null : (value == null ? dfltPoint : effectivePoint(value, window));
    const c = point == null ? null : costPerCall(point, rates);
    return {
      id: p.id, preset: p, value, available, reason, window, point,
      pct: value == null ? null : value / window,
      sameAsDefault: false,
      current: available && !cur.off && (value == null ? cur.value == null : cur.value === value),
      usdPerCall: c ? c.perCallUsd : null,
      ratio: c && base && base.perCallUsd > 0 ? c.perCallUsd / base.perCallUsd : null,
      compactionsPer100: c ? c.compactionsPer100 : null,
      freq: point == null ? null : freqOf(point, dfltPoint),
    };
  });
}

/** Number of calls per cycle (between two compactions), same as in costPerCall */
function callsPerCycle(point, m = P.COST_MODEL) {
  return fin(point) && point > m.afterCompact ? Math.max(1, Math.round((point - m.afterCompact) / m.perCallNew)) : null;
}

/** Compaction frequency as a multiple of the default (based on call counts only, not prices, so it works without prices) */
function freqOf(point, basePoint) {
  const a = callsPerCycle(point);
  const b = callsPerCycle(basePoint);
  return a && b ? b / a : null;
}

// ---------------------------------------------------------------------------
// Input parsing (same rules as /autocompact and --autocompact in Claude Code 2.1.278)
// ---------------------------------------------------------------------------

/**
 * 'auto' → auto; '300k' / '0.5m' / '300000' / '300,000'; a bare number from 100 to 1000 is shorthand for K ('300' → 300000, '1000' → 1M).
 * The result must be between 100000 and 1000000.
 * @param {any} text
 * @returns {{ value: number|'auto' } | { error: 'empty'|'format'|'range', value?: number }}
 */
function parseWindowInput(text) {
  const s = String(text == null ? '' : text).trim().toLowerCase().replace(/[\s,_]/g, '');
  if (!s) return { error: 'empty' };
  if (s === 'auto') return { value: 'auto' };
  const m = /^(\d+(?:\.\d+)?|\.\d+)(k|m)?$/.exec(s);
  if (!m) return { error: 'format' };
  let n = Number(m[1]);
  if (m[2] === 'm') n *= 1e6;
  else if (m[2] === 'k') n *= 1000;
  else if (n >= 100 && n <= 1000) n *= 1000;
  n = Math.round(n);
  if (!Number.isFinite(n) || n < P.SETTING_MIN || n > P.SETTING_MAX) return { error: 'range', value: n };
  return { value: n };
}

/** Argument for /autocompact: auto, or whole thousands written as 400k (Claude Code also accepts 400000) */
function autocompactArg(value) {
  if (value == null || value === 'auto') return 'auto';
  return value % 1000 === 0 ? `${value / 1000}k` : String(value);
}

// ---------------------------------------------------------------------------
// Safe settings.json editing: change one key only, keep original indentation and key order
// ---------------------------------------------------------------------------

function skipWs(t, i) {
  while (i < t.length && (t[i] === ' ' || t[i] === '\t' || t[i] === '\r' || t[i] === '\n')) i++;
  return i;
}

/** t[i] is '"': returns the position after the string ends; -1 if unterminated */
function skipString(t, i) {
  for (i++; i < t.length; i++) {
    if (t[i] === '\\') { i++; continue; }
    if (t[i] === '"') return i + 1;
  }
  return -1;
}

/** Skip one JSON value (object, array, string, literal) and return its end position; -1 on error */
function skipValue(t, i) {
  const c = t[i];
  if (c === '"') return skipString(t, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    while (i < t.length) {
      const ch = t[i];
      if (ch === '"') { i = skipString(t, i); if (i < 0) return -1; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    return -1;
  }
  const start = i;
  while (i < t.length && !/[\s,}\]]/.test(t[i])) i++;
  return i > start ? i : -1;
}

/**
 * Member positions of the top-level object (the text has already passed JSON.parse). Returns null if it is not an object or the structure cannot be understood.
 * @returns {{ open: number, close: number, members: { key: string, keyStart: number, keyEnd: number, valueStart: number, valueEnd: number }[] }|null}
 */
function scanTopObject(t) {
  let i = skipWs(t, 0);
  if (t[i] !== '{') return null;
  const open = i;
  const members = [];
  i = skipWs(t, i + 1);
  if (t[i] === '}') return { open, close: i, members };
  for (;;) {
    if (t[i] !== '"') return null;
    const keyStart = i;
    const keyEnd = skipString(t, i);
    if (keyEnd < 0) return null;
    let key;
    try { key = JSON.parse(t.slice(keyStart, keyEnd)); } catch { return null; }
    i = skipWs(t, keyEnd);
    if (t[i] !== ':') return null;
    const valueStart = skipWs(t, i + 1);
    const valueEnd = skipValue(t, valueStart);
    if (valueEnd < 0) return null;
    members.push({ key, keyStart, keyEnd, valueStart, valueEnd });
    i = skipWs(t, valueEnd);
    if (t[i] === ',') { i = skipWs(t, i + 1); continue; }
    if (t[i] === '}') return { open, close: i, members };
    return null;
  }
}

function eolOf(t) { return t.includes('\r\n') ? '\r\n' : '\n'; }

/** Indentation: leading whitespace of the first member's line; two spaces if there is none */
function indentOf(t, scan) {
  if (scan && scan.members.length) {
    const lead = t.slice(scan.open + 1, scan.members[0].keyStart);
    const nl = lead.lastIndexOf('\n');
    if (nl >= 0 && lead.length > nl + 1) return lead.slice(nl + 1);
  }
  return '  ';
}

/** Remove the first member named key (along with the comma and whitespace between it and its neighbor) */
function removeFirst(t, scan, key) {
  const k = scan.members.findIndex((m) => m.key === key);
  if (k < 0) return null;
  const m = scan.members[k];
  const prev = scan.members[k - 1];
  const next = scan.members[k + 1];
  if (prev) return t.slice(0, prev.valueEnd) + t.slice(m.valueEnd);   // remove `, "key": v`
  if (next) return t.slice(0, m.keyStart) + t.slice(next.keyStart);   // remove `"key": v, `
  return t.slice(0, scan.open + 1) + t.slice(scan.close);             // only member → {}
}

/** Expected result object: other keys unchanged and in the same order; when setting, an existing key is replaced in place, otherwise appended at the end */
function expectedObject(obj, key, value) {
  const out = {};
  let placed = false;
  for (const k of Object.keys(obj)) {
    if (k === key) {
      if (value != null) { out[k] = value; placed = true; }
      continue;
    }
    out[k] = obj[k];
  }
  if (value != null && !placed) out[key] = value;
  return out;
}

/**
 * Set or remove autoCompactWindow in settings text (removed when value is null).
 * Only this key is touched: if present, its value is replaced in place; otherwise it is appended after the last member with the original indentation; on removal its comma goes too.
 * The result is parsed again to verify that everything except this key is identical and in the same order; if that fails, fall back to reformatting the whole object with the original indentation (no keys are lost).
 * An empty file is treated as {}. Parse failure or a non-object top level returns an error, and the caller does not write the file.
 * @param {string} text original text
 * @param {number|null} value
 * @param {string} [key]
 * @returns {{ text: string, changed: boolean, existed: boolean } | { error: 'parse'|'notObject', message?: string }}
 */
function editSettingsText(text, value, key = SETTING_KEY) {
  const src = String(text == null ? '' : text);
  const bom = src.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const body = bom ? src.slice(1) : src;
  const eol = eolOf(body);
  if (!body.trim()) {
    if (value == null) return { text: src, changed: false, existed: false };
    return { text: bom + `{${eol}  ${JSON.stringify(key)}: ${value}${eol}}${eol}`, changed: true, existed: false };
  }
  let obj;
  try { obj = JSON.parse(body); } catch (err) { return { error: 'parse', message: String((err && err.message) || err) }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'notObject' };
  const existed = Object.prototype.hasOwnProperty.call(obj, key);
  if (value == null && !existed) return { text: src, changed: false, existed };
  if (value != null && existed && obj[key] === value) {
    // value is already the same (duplicate keys must all match too)
    const scan0 = scanTopObject(body);
    const all = scan0 ? scan0.members.filter((m) => m.key === key).every((m) => body.slice(m.valueStart, m.valueEnd) === String(value)) : true;
    if (all) return { text: src, changed: false, existed };
  }
  const expected = expectedObject(obj, key, value);
  let out = null;
  let scan = scanTopObject(body);
  if (scan) {
    if (value == null) {
      out = body;
      for (let guard = 0; scan && guard < 100 && scan.members.some((m) => m.key === key); guard++) {
        out = removeFirst(out, scan, key);
        scan = scanTopObject(out);
      }
      if (!scan) out = null;
    } else {
      const hits = scan.members.filter((m) => m.key === key);
      if (hits.length) {
        out = body;
        for (const m of hits.reverse()) out = out.slice(0, m.valueStart) + String(value) + out.slice(m.valueEnd);
      } else if (!scan.members.length) {
        out = body.slice(0, scan.open + 1) + eol + '  ' + JSON.stringify(key) + ': ' + value + eol + body.slice(scan.close);
      } else {
        const first = scan.members[0];
        const last = scan.members[scan.members.length - 1];
        const colon = body.slice(first.keyEnd, first.valueStart);
        let gap = body.slice(scan.open + 1, first.keyStart);            // with a single member, reuse the whitespace after {
        if (scan.members.length > 1) {
          const between = body.slice(first.valueEnd, scan.members[1].keyStart);
          gap = between.slice(between.indexOf(',') + 1);
        }
        out = body.slice(0, last.valueEnd) + ',' + gap + JSON.stringify(key) + colon + value + body.slice(last.valueEnd);
      }
    }
  }
  let verified = false;
  if (out != null) {
    try { verified = JSON.stringify(JSON.parse(out)) === JSON.stringify(expected); } catch { verified = false; }
  }
  if (!verified) {
    const trailing = /\r?\n\s*$/.test(body) ? eol : '';
    out = JSON.stringify(expected, null, indentOf(body, scanTopObject(body))).replace(/\n/g, eol) + trailing;
  }
  return { text: bom + out, changed: bom + out !== src, existed };
}

// ---------------------------------------------------------------------------
// Writing the file: back up first, re-check before writing, atomic replace
// ---------------------------------------------------------------------------

function stampOf(now) {
  return new Date(fin(now) ? now : Date.now()).toISOString().replace(/[:.]/g, '-');
}

/**
 * Back up the original text to backupDir as <time>-<path hash>-<file name>. Only the newest BACKUP_KEEP copies are kept.
 * @returns {string} backup file path
 */
function backupFile(file, text, backupDir, now) {
  if (!backupDir) throw new Error('no backup folder');
  fs.mkdirSync(backupDir, { recursive: true });
  const hash = crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 8);
  const name = `${stampOf(now)}-${hash}-${path.basename(file)}`;
  const dest = path.join(backupDir, name);
  fs.writeFileSync(dest, text, { flag: 'wx', mode: 0o600 });
  try {
    const olds = fs.readdirSync(backupDir).filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n)).sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - BACKUP_KEEP))) fs.rmSync(path.join(backupDir, n), { force: true });
  } catch { /* cleanup failure is harmless */ }
  return dest;
}

function atomicWrite(target, text, mode) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.agent-monitor-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Set or remove autoCompactWindow in a settings file (value null = auto, which removes the key).
 * - File exists: read → parse (do not write on failure) → change only this key → back up the original → re-read before writing (do not write if someone else changed it) → temp file + rename;
 *   a symlink is written through to the real file it points to without breaking the link; original permissions are kept.
 * - File does not exist: auto does nothing; setting a value creates the containing directory (e.g. <project>/.claude/) and the file.
 * @param {{ file: string, value: number|null, backupDir: string|null, now?: number }} o
 * @returns {{ ok: true, file: string, changed: boolean, created: boolean, existed: boolean, backup: string|null }
 *   | { ok: false, file: string, error: 'parse'|'notObject'|'notFile'|'read'|'backup'|'busy'|'write', message?: string }}
 */
function writeAutoCompactSetting(o) {
  const file = o.file;
  const fail = (error, err) => ({ ok: false, file, error, message: err ? String((err && err.message) || err) : undefined });
  if (o.value != null && !(Number.isInteger(o.value) && o.value >= P.SETTING_MIN && o.value <= P.SETTING_MAX)) {
    return fail('write', new Error(`value out of range: ${o.value}`));
  }
  let exists = false;
  let real = file;
  let text = '';
  let mode = 0o644;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return fail('notFile');
    exists = true;
    real = fs.realpathSync(file);
    mode = st.mode & 0o777;
    text = fs.readFileSync(real, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') return fail('read', err);
  }
  const edit = editSettingsText(text, o.value);
  if (edit.error) return fail(edit.error, edit.message);
  if (!edit.changed) return { ok: true, file, changed: false, created: false, existed: edit.existed, backup: null };
  let backup = null;
  if (exists) {
    try { backup = backupFile(real, text, o.backupDir, o.now); } catch (err) { return fail('backup', err); }
  }
  try {
    if (exists) {
      if (fs.readFileSync(real, 'utf8') !== text) return fail('busy');
      atomicWrite(real, edit.text, mode);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, edit.text, { flag: 'wx' });   // someone else created the file in the meantime → EEXIST, do not overwrite
    }
  } catch (err) {
    return fail(err && err.code === 'EEXIST' ? 'busy' : 'write', err);
  }
  return { ok: true, file, changed: true, created: !exists, existed: edit.existed, backup };
}

/** Read autoCompactWindow from a settings file (read-only; returns null if missing or unreadable) */
function readSettingValue(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const v = j && typeof j === 'object' ? j[SETTING_KEY] : undefined;
    return fin(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Text (describeCompactSetting is used by agents-view / tree)
// ---------------------------------------------------------------------------

let fallbackI18n = null;
function i18nOr(i18n) {
  if (i18n) return i18n;
  if (!fallbackI18n) fallbackI18n = require('./i18n').createI18n('en');
  return fallbackI18n;
}

function valueText(value, window, i18n) {
  if (value == null) return i18n.t('autocompact.value.auto');
  if (fin(window) && value > window) return i18n.t('autocompact.value.capped', { tokens: i18n.fmtTokens(value), window: i18n.fmtTokens(window) });
  return i18n.t('autocompact.value', { tokens: i18n.fmtTokens(value), pct: i18n.fmtPct(value / window) });
}

/**
 * Text for the current auto-compaction setting (used by the "Auto-compact: {value} ▾" session bar on the right and the hover tooltip on the left).
 * Example: "400K (40%) → ≈ 367K · Source: user settings"; other languages get their wording from the dictionary.
 * @param {any} session Session (uses contextWindow, compactAt, compactAtSource, and optionally autoCompactWindow)
 * @param {any} [i18n] defaults to English
 * @returns {{ valueText: string, sourceText: string, effectiveText: string, text: string, tooltip: string,
 *   source: string, value: number|null, point: number|null, window: number, off: boolean }}
 */
function describeCompactSetting(session, i18n) {
  const I = i18nOr(i18n);
  const s = session || {};
  const cur = currentSetting(s);
  const sourceText = I.t('autocompact.source', { source: I.t(SOURCE_KEYS[cur.source] || SOURCE_KEYS.default) });
  const tooltip = I.t(s.provider === 'codex' ? 'autocompact.tooltip.codex' : 'autocompact.tooltip');
  if (cur.off) {
    const v = I.t('autocompact.value.off');
    return { valueText: v, sourceText, effectiveText: '', text: I.t('autocompact.describe.off', { value: v, source: sourceText }),
      tooltip, source: cur.source, value: null, point: null, window: cur.window, off: true };
  }
  const effectiveText = cur.point == null ? '' : I.t(cur.source === 'observed' ? 'autocompact.effective.observed' : 'autocompact.effective',
    { tokens: I.fmtTokens(cur.point) });
  let vText;
  let text;
  if (s.provider === 'codex') {
    vText = I.t('autocompact.value', { tokens: I.fmtTokens(cur.point), pct: I.fmtPct(cur.point / cur.window) });
    text = I.t('autocompact.describe.codex', { value: vText, source: sourceText });
  } else {
    vText = valueText(cur.value, cur.window, I);
    text = I.t('autocompact.describe', { value: vText, effective: effectiveText, source: sourceText });
  }
  return { valueText: vText, sourceText, effectiveText, text, tooltip, source: cur.source, value: cur.value, point: cur.point, window: cur.window, off: false };
}

/** Short form of a preset or custom value (used in the scope picker title and the result message) */
function valueLabel(value, session, i18n) {
  if (value == null) return i18n.t('autocompact.value.auto');
  return valueText(value, windowOf(session), i18n);
}

// ---------------------------------------------------------------------------
// QuickPick items
// ---------------------------------------------------------------------------

function costText(opt, session, i18n) {
  if (opt.usdPerCall == null) {
    const model = session.provider === 'codex' ? session.model : (session.modelVariant || session.model);
    return i18n.t('autocompact.cost.unpriced', { model: model || '—' });
  }
  const usd = i18n.fmtUsd(opt.usdPerCall);
  if (opt.id === 'auto' || opt.ratio == null || Math.abs(1 - opt.ratio) < SAME_EPS) {
    return i18n.t(opt.id === 'auto' ? 'autocompact.cost.default' : 'autocompact.cost.same', { usd });
  }
  if (opt.ratio < 1) return i18n.t('autocompact.cost.less', { usd, pct: i18n.fmtPct(1 - opt.ratio) });
  return i18n.t('autocompact.cost.more', { usd, pct: i18n.fmtPct(opt.ratio - 1) });
}

/**
 * Build the "Set auto-compaction capacity" QuickPick. Pure function; item.action describes what happens when selected:
 * - { type: 'preset', id, value }: value null = auto;
 * - { type: 'custom' }: InputBox; { type: 'guide' }: open the reference guide; { type: 'info', text }: just show the explanation, without closing.
 * @param {any} session
 * @param {{ i18n: any, separatorKind?: number, env?: Record<string, string|undefined> }} ctx
 * @returns {{ title: string, placeholder: string, items: any[], active: any|null, options: ReturnType<typeof presetOptions> }}
 */
function buildPresetItems(session, ctx) {
  const i18n = ctx.i18n;
  const sep = { label: '', kind: ctx.separatorKind ?? SEPARATOR_KIND };
  const codex = session.provider === 'codex';
  const cur = currentSetting(session);
  const window = cur.window;
  const model = codex ? session.model : (session.modelVariant || session.model);
  const title = i18n.t(model ? 'autocompact.pick.title' : 'autocompact.pick.title.noModel', {
    title: clip(session.title || session.id, 50), model, window: i18n.fmtTokens(window), current: describeCompactSetting(session, i18n).valueText,
  });
  const placeholder = i18n.t(codex ? 'autocompact.pick.placeholder.codex' : 'autocompact.pick.placeholder', { date: pricing.PRICES_UPDATED });
  const items = [];
  const info = (icon, label, text) => ({ label: `$(${icon}) ${label}`, action: { type: 'info', text } });
  const reminder = i18n.t(codex ? 'autocompact.reminder.codex' : 'autocompact.reminder');

  if (!codex) {
    // Notes at the top: the official wording and the reminder (also at the end of each level's detail, but detail shows only one line and gets cut off when narrow)
    items.push(info('info', i18n.t('autocompact.info.official.label'), i18n.t('autocompact.info.official')));
    items.push(info('warning', i18n.t('autocompact.info.reminder'), i18n.t('autocompact.info.reminder')));
    const env = ctx.env || {};
    if (cur.source === 'env' || (env[ENV_WINDOW] && String(env[ENV_WINDOW]).trim())) {
      items.push(info('warning', i18n.t('autocompact.info.env'), i18n.t('autocompact.info.env')));
    }
    if (cur.off) items.push(info('warning', i18n.t('autocompact.info.off'), i18n.t('autocompact.info.off')));
    items.push(sep);
  }

  const options = presetOptions(session);
  if (!codex && window <= P.WINDOW_200K) {
    // Savings from lowering a 200K window are computed with the session model's prices (about 3% at Opus 5.5 prices, about 8% at Sonnet 4.6 prices) and shown in an info item
    const r = options.find((o) => o.id === 'research');
    const text = r && r.available && r.ratio != null
      ? i18n.t('autocompact.info.small', { pct: i18n.fmtPct(Math.max(0, 1 - r.ratio)) })
      : i18n.t('autocompact.info.small.noPrice');
    items.splice(items.length - 1, 0, info('info', text, text));
  }
  let active = null;
  let autoItem = null;
  for (const o of options) {
    const name = i18n.t(o.preset.nameKey);
    if (!o.available) {
      const text = o.reason === 'below50'
        ? i18n.t('autocompact.reason.below50')
        : i18n.t('autocompact.reason.sameAsDefault', { at: i18n.fmtTokens(effectivePoint(null, window)) });
      items.push({ label: `$(circle-slash) ${name}`, description: i18n.t('autocompact.unavailable'), detail: text, action: { type: 'info', text } });
      continue;
    }
    let desc;
    if (codex) {
      desc = i18n.t(o.value == null ? 'autocompact.desc.codexDefault' : 'autocompact.desc.codex', { pct: i18n.fmtPct(o.pct), at: i18n.fmtTokens(o.point) });
    } else if (o.value == null) {
      desc = i18n.t('autocompact.desc.auto', { at: i18n.fmtTokens(o.point) });
    } else {
      desc = i18n.t('autocompact.desc.value', { value: valueText(o.value, window, i18n), at: i18n.fmtTokens(o.point) });
    }
    if (o.current) desc += SEP + i18n.t('autocompact.current');
    const evidence = i18n.t('autocompact.evidence', { strength: i18n.t(P.EVIDENCE_KEYS[o.preset.evidence]), basis: i18n.t(o.preset.basisKey) });
    // detail shows only one line: cost estimate first, reminder last
    const freq = o.freq != null && o.freq >= 1.1 ? i18n.t('autocompact.freq', { n: i18n.fmtNum(o.freq, { maximumFractionDigits: 1 }) }) : '';
    const item = {
      label: `$(${o.preset.icon}) ${name}`,
      description: desc,
      detail: [costText(o, session, i18n), freq, i18n.t(o.preset.summaryKey), evidence, reminder].filter(Boolean).join(SEP),
      action: { type: 'preset', id: o.id, value: o.value },
    };
    if (o.id === 'auto') autoItem = item;
    if (o.current && !active) active = item;
    items.push(item);
  }
  items.push(sep);
  items.push({
    label: '$(edit) ' + i18n.t('autocompact.custom'),
    detail: i18n.t(codex ? 'autocompact.custom.detail.codex' : 'autocompact.custom.detail'),
    action: { type: 'custom' },
  });
  items.push({
    label: '$(link-external) ' + i18n.t('autocompact.guide'),
    detail: i18n.t('autocompact.guide.detail'),
    action: { type: 'guide' },
  });
  return { title, placeholder, items, active: active || autoItem, options };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function tilde(p, home = os.homedir()) {
  const s = String(p || '');
  if (home && (s === home || s.startsWith(home + path.sep))) return '~' + s.slice(home.length);
  return s;
}

/**
 * File written for "this project only": <cwd>/.claude/settings.local.json. Unavailable when cwd is missing or does not exist, or when .claude is the Claude data directory
 * (the session was opened in the home directory, so project settings and user settings share one directory).
 * @returns {{ file: string|null, reason: 'noCwd'|'home'|null }}
 */
function projectSettingsFile(session, claudeHome) {
  const cwd = session && session.cwd;
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return { file: null, reason: 'noCwd' };
  try {
    if (!fs.statSync(cwd).isDirectory()) return { file: null, reason: 'noCwd' };
  } catch {
    return { file: null, reason: 'noCwd' };
  }
  const dir = path.join(cwd, '.claude');
  const same = (a, b) => {
    try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); }
  };
  if (claudeHome && same(dir, claudeHome)) return { file: null, reason: 'home' };
  return { file: path.join(dir, 'settings.local.json'), reason: null };
}

// ---------------------------------------------------------------------------
// VS Code wiring
// ---------------------------------------------------------------------------

/**
 * Register the command agentMonitor.setAutoCompact (argument: a session node or sessionKey; with no argument, pick a session first, defaulting to the currently selected one).
 * @param {any} context ExtensionContext (globalStorageUri holds the backups)
 * @param {{ getSession: (key: string) => any, getSessions?: () => any[], listSessions?: () => any[], i18n: any,
 *   claudeHome: string|(() => string), codexHome?: string|(() => string), output?: any, getSelectedKey?: () => string|null,
 *   env?: Record<string, string|undefined>, backupDir?: string }} deps
 *   codexHome defaults to CODEX_HOME or ~/.codex; env / backupDir are only for test overrides.
 * @returns {{ dispose: () => void, run: (arg?: any) => Promise<void> }}
 */
function activateAutoCompact(context, deps) {
  const vscode = require('vscode');
  const ctx = context || {};
  const I = () => (typeof deps.i18n === 'function' ? deps.i18n() : deps.i18n);
  const env = () => deps.env || process.env;
  const claudeHome = () => (typeof deps.claudeHome === 'function' ? deps.claudeHome() : deps.claudeHome)
    || (env().CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  const codexHome = () => (typeof deps.codexHome === 'function' ? deps.codexHome() : deps.codexHome)
    || env().CODEX_HOME || path.join(os.homedir(), '.codex');
  const log = (line) => { try { if (deps.output) deps.output.appendLine(`[autocompact] ${line}`); } catch { /* ignore */ } };
  const sepKind = vscode.QuickPickItemKind ? vscode.QuickPickItemKind.Separator : SEPARATOR_KIND;
  const info = (msg, ...items) => vscode.window.showInformationMessage(msg, ...items);
  const errorMsg = (msg, ...items) => vscode.window.showErrorMessage(msg, ...items);
  const titleOf = (s) => clip((s && (s.title || s.id)) || '', 60);

  function backupDir() {
    if (deps.backupDir) return deps.backupDir;
    const u = ctx.globalStorageUri;
    const base = (u && u.fsPath) || ctx.globalStoragePath || null;
    return base ? path.join(base, BACKUP_DIR) : null;
  }

  function sessions() {
    const f = deps.getSessions || deps.listSessions;
    try { return (f ? f() || [] : []).filter((s) => s && (s.provider === 'claude' || s.provider === 'codex')); } catch { return []; }
  }

  async function pickSessionKey() {
    const i18n = I();
    const list = sessions().slice();
    if (!list.length) { info(i18n.t('autocompact.noSessions')); return null; }
    let selected = null;
    try { selected = deps.getSelectedKey ? deps.getSelectedKey() : null; } catch { selected = null; }
    const at = selected ? list.findIndex((s) => s.key === selected) : -1;
    if (at > 0) list.unshift(...list.splice(at, 1));
    const items = list.map((s) => ({
      label: titleOf(s),
      description: `${i18n.t('provider.' + s.provider)}${SEP}${describeCompactSetting(s, i18n).valueText}`,
      key: s.key,
    }));
    const it = await vscode.window.showQuickPick(items, { placeHolder: i18n.t('autocompact.pickSession') });
    return it ? it.key : null;
  }

  /** QuickPick: info items just show their explanation without closing */
  function pick(built) {
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick();
      qp.title = built.title;
      qp.placeholder = built.placeholder;
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;
      qp.items = built.items;
      if (built.active) qp.activeItems = [built.active];
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
        qp.dispose();
      };
      qp.onDidAccept(() => {
        const it = (qp.selectedItems && qp.selectedItems[0]) || (qp.activeItems && qp.activeItems[0]);
        if (!it || !it.action) return;
        if (it.action.type === 'info') { info(it.action.text); return; }
        finish(it);
      });
      qp.onDidHide(() => finish(undefined));
      qp.show();
    });
  }

  /** Use the registry to tell whether the session is open (same as compact.js: the registry wins, falling back to the snapshot when unavailable) */
  function liveView(session) {
    if (session.provider !== 'claude') return { view: session, liveNow: !!session.live };
    let reg;
    try { reg = claudeLive.readRegistry(claudeHome()); } catch { reg = { ok: false, live: new Map() }; }
    const entry = reg.live.get(session.id);
    if (entry) return { view: { ...session, entrypoint: entry.entrypoint || session.entrypoint }, liveNow: true };
    return { view: session, liveNow: reg.ok ? false : !!session.live };
  }

  async function askCustom(session) {
    const i18n = I();
    const cur = currentSetting(session);
    const v = await vscode.window.showInputBox({
      title: i18n.t('autocompact.input.title', { title: titleOf(session) }),
      prompt: i18n.t(session.provider === 'codex' ? 'autocompact.input.prompt.codex' : 'autocompact.input.prompt', { window: i18n.fmtTokens(cur.window) }),
      placeHolder: i18n.t('autocompact.input.placeholder'),
      value: cur.value != null ? autocompactArg(cur.value) : '',
      ignoreFocusOut: true,
      validateInput: (s) => {
        const r = parseWindowInput(s);
        if (!r.error) return null;
        return i18n.t(r.error === 'range' ? 'autocompact.input.range' : 'autocompact.input.format');
      },
    });
    if (v === undefined) return undefined;
    const r = parseWindowInput(v);
    if (r.error) return undefined;
    return r.value === 'auto' ? null : r.value;
  }

  /** Scope: all / project; returns undefined if cancelled */
  function pickScope(session, value, liveNow) {
    const i18n = I();
    const userFile = path.join(claudeHome(), 'settings.json');
    const proj = projectSettingsFile(session, claudeHome());
    const items = [];
    const all = {
      label: '$(globe) ' + i18n.t('autocompact.scope.all'),
      detail: liveNow
        ? i18n.t('autocompact.scope.all.live', { command: `/autocompact ${autocompactArg(value)}` })
        : i18n.t('autocompact.scope.all.file', { path: tilde(userFile) }),
      action: { type: 'scope', scope: 'all' },
    };
    items.push(all);
    if (proj.file) {
      items.push({
        label: '$(root-folder) ' + i18n.t('autocompact.scope.project'),
        detail: i18n.t('autocompact.scope.project.detail', { path: tilde(proj.file) }),
        action: { type: 'scope', scope: 'project', file: proj.file },
      });
    } else {
      const text = i18n.t(proj.reason === 'home' ? 'autocompact.scope.project.home' : 'autocompact.scope.project.noCwd');
      items.push({ label: '$(circle-slash) ' + i18n.t('autocompact.scope.project'), detail: text, action: { type: 'info', text } });
    }
    return pick({
      title: i18n.t('autocompact.scope.title', { value: valueLabel(value, session, i18n) }),
      placeholder: i18n.t('autocompact.scope.placeholder'),
      items,
      active: all,
    });
  }

  async function openFile(file) {
    try { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file)); } catch (err) { log(`open ${file}: ${err && err.message}`); }
  }

  /** Higher-priority settings that would override the value being written: the environment variable; and, when writing user settings, the two project files */
  function overrideNotes(scope, session) {
    const i18n = I();
    const notes = [];
    const e = env()[ENV_WINDOW];
    if (e && String(e).trim()) notes.push(i18n.t('autocompact.note.env'));
    if (scope === 'all' && typeof session.cwd === 'string' && path.isAbsolute(session.cwd)) {
      for (const f of [path.join(session.cwd, '.claude', 'settings.local.json'), path.join(session.cwd, '.claude', 'settings.json')]) {
        if (path.resolve(f) === path.resolve(path.join(claudeHome(), 'settings.json'))) continue;
        if (readSettingValue(f) != null) { notes.push(i18n.t('autocompact.note.project', { path: tilde(f) })); break; }
      }
    }
    return notes;
  }

  async function writeScoped(session, value, scope, file) {
    const i18n = I();
    const r = writeAutoCompactSetting({ file, value, backupDir: backupDir() });
    const shown = tilde(file);
    const openBtn = i18n.t('autocompact.openFile');
    if (!r.ok) {
      log(`${file}: ${r.error}${r.message ? ' ' + r.message : ''}`);
      const key = {
        parse: 'autocompact.error.parse', notObject: 'autocompact.error.notObject', notFile: 'autocompact.error.notFile',
        read: 'autocompact.error.read', backup: 'autocompact.error.backup', busy: 'autocompact.error.busy', write: 'autocompact.error.write',
      }[r.error] || 'autocompact.error.write';
      const canOpen = r.error === 'parse' || r.error === 'notObject';
      const b = await (canOpen
        ? errorMsg(i18n.t(key, { path: shown, message: r.message || '' }), openBtn)
        : errorMsg(i18n.t(key, { path: shown, message: r.message || '' })));
      if (b === openBtn) await openFile(file);
      return r;
    }
    if (r.backup) log(`backup ${file} → ${r.backup}`);
    log(`${file}: ${value == null ? 'auto (key removed)' : value}${r.changed ? '' : ' (unchanged)'}`);
    let msg;
    if (!r.changed) {
      msg = value == null ? i18n.t('autocompact.done.nothingToRemove', { path: shown }) : i18n.t('autocompact.done.unchanged', { path: shown });
    } else if (value == null) {
      msg = i18n.t('autocompact.done.removed', { path: shown });
    } else {
      msg = i18n.t(r.created ? 'autocompact.done.created' : 'autocompact.done.set', { path: shown, value: valueLabel(value, session, i18n) });
    }
    const tail = [];
    if (r.changed) tail.push(i18n.t(scope === 'project' ? 'autocompact.done.reopen' : 'autocompact.done.reopenUser'));
    tail.push(...overrideNotes(scope, session));
    const b = await info([msg, ...tail].join(' '), openBtn);
    if (b === openBtn) await openFile(file);
    return r;
  }

  async function applyClaude(session, value) {
    const i18n = I();
    const { view, liveNow } = liveView(session);
    const it = await pickScope(view, value, liveNow);
    if (!it) return;
    const scope = it.action.scope;
    if (scope === 'all' && liveNow) {
      // Prefill /autocompact <value>: once the user presses Enter, Claude Code applies it to the current session immediately and writes it to user settings itself
      const text = `/autocompact ${autocompactArg(value)}`;
      const msg = await compactLib.deliverText(vscode, view, text, { i18n, liveNow: true, log });
      log(`${session.key}: prefill ${text}`);
      await info([msg, i18n.t('autocompact.prefill.after'), ...overrideNotes('all', view)].join(' '));
      return;
    }
    const file = scope === 'project' ? it.action.file : path.join(claudeHome(), 'settings.json');
    await writeScoped(view, value, scope, file);
  }

  async function applyCodex(session, value) {
    const i18n = I();
    const file = path.join(codexHome(), 'config.toml');
    const shown = tilde(file);
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
    const existing = text != null ? parseCodexConfig(text).modelAutoCompactTokenLimit : null;
    const openBtn = i18n.t('autocompact.openFile');
    let msg;
    if (value == null) {
      msg = i18n.t(existing != null ? 'autocompact.codex.remove' : 'autocompact.codex.default', { path: shown, old: existing });
    } else {
      const line = `${CODEX_KEY} = ${value}`;
      try { await vscode.env.clipboard.writeText(line); } catch (err) { log(`clipboard: ${err && err.message}`); }
      log(`${session.key}: copied ${line}`);
      if (text == null) msg = i18n.t('autocompact.codex.missing', { line, path: shown });
      else if (existing != null) msg = i18n.t('autocompact.codex.replace', { line, path: shown, old: existing });
      else msg = i18n.t('autocompact.codex.copied', { line, path: shown });
    }
    // The extension does not modify config.toml; it only opens it so the user can paste the line themselves
    if (text != null) await openFile(file);
    const b = await info(msg, ...(text != null ? [openBtn] : []));
    if (b === openBtn) await openFile(file);
  }

  async function run(arg) {
    const i18n = I();
    let key = compactLib.keyFromArg(arg);
    if (!key) key = await pickSessionKey();
    if (!key) return;
    const session = deps.getSession(key);
    if (!session || (session.provider !== 'claude' && session.provider !== 'codex')) {
      errorMsg(i18n.t('autocompact.error.noSession'));
      return;
    }
    const built = buildPresetItems(session, { i18n, separatorKind: sepKind, env: env() });
    const it = await pick(built);
    if (!it) return;
    let value;
    if (it.action.type === 'guide') {
      try { await vscode.env.openExternal(vscode.Uri.parse(P.GUIDE_URL)); } catch (err) { log(`openExternal: ${err && err.message}`); }
      return;
    }
    if (it.action.type === 'custom') {
      value = await askCustom(session);
      if (value === undefined) return;
    } else if (it.action.type === 'preset') {
      value = it.action.value;
    } else {
      return;
    }
    if (session.provider === 'codex') return applyCodex(session, value);
    return applyClaude(session, value);
  }

  const reg = vscode.commands.registerCommand(CMD, (arg) => run(arg).catch((err) => {
    log(`error: ${err && err.message}`);
    errorMsg(I().t('autocompact.error.unexpected', { message: String((err && err.message) || err) }));
  }));

  return {
    run,
    dispose() {
      try { reg.dispose(); } catch { /* ignore */ }
    },
  };
}

module.exports = {
  CMD, SETTING_KEY, CODEX_KEY, BACKUP_DIR, BACKUP_KEEP, SOURCE_KEYS,
  activateAutoCompact, describeCompactSetting,
  // Pure functions (for tests and reuse)
  claudeWindowOf, codexFullWindow, windowOf, effectivePoint, codexValueFor, codexDefaultPoint, currentSetting,
  ratesFor, costPerCall, presetOptions, parseWindowInput, autocompactArg,
  scanTopObject, editSettingsText, writeAutoCompactSetting, readSettingValue, projectSettingsFile,
  buildPresetItems, valueLabel,
};
