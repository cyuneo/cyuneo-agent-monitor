'use strict';
// Localization: locale normalization, per-area dictionary merging, t(key, vars), number/duration/amount/time formatting.
// - Dictionaries: l10n/<area>.<locale>.json, with fixed areas core, views, webview, cli, compact, storage, push, alerts, history, autoresume;
//   loading a locale merges all of that locale's area files; missing keys fall back to English, then to the key name.
// - Runs in the extension host, the terminal version (Node), and inside webviews:
//   the extension injects i18n.webviewJson(prefixes) into a <script type="application/json">, and the webview restores it with fromPayload();
//   since the dictionary merges all areas, keys from any area (e.g. storage.page.* for the "Storage location and usage" page) can be passed in by prefix.
//   This file requires no Node modules at top level; loaded directly via <script> in a browser, it attaches to globalThis.AgentMonitorI18n.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.AgentMonitorI18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LOCALES = Object.freeze(['en', 'zh-cn', 'zh-tw', 'ko', 'ja']);
  const REGIONS = Object.freeze(['core', 'views', 'webview', 'cli', 'compact', 'storage', 'push', 'alerts', 'history', 'autoresume']);
  const INTL_LOCALE = Object.freeze({ en: 'en-US', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-TW', ko: 'ko-KR', ja: 'ja-JP' });
  const DASH = '—';

  /**
   * VS Code / system locale → one of the five supported locales.
   * zh-tw / zh-hk / zh-mo / zh-hant* → zh-tw; other zh* → zh-cn; ko* → ko; ja* → ja; anything else → en.
   * @param {string|null|undefined} raw
   * @returns {'en'|'zh-cn'|'zh-tw'|'ko'|'ja'}
   */
  function normalizeLocale(raw) {
    const s = String(raw || '').trim().toLowerCase().replace(/_/g, '-').replace(/\..*$/, '').replace(/@.*$/, '');
    if (s.startsWith('zh')) return /^zh-(tw|hk|mo)\b|^zh-hant/.test(s) ? 'zh-tw' : 'zh-cn';
    if (s.startsWith('ko')) return 'ko';
    if (s.startsWith('ja')) return 'ja';
    return 'en';
  }

  /** One of the five locales → BCP 47 tag for Intl */
  function intlLocaleOf(locale) {
    return INTL_LOCALE[normalizeLocale(locale)];
  }

  /**
   * Language for the terminal version: --lang / --lang=xx → LC_ALL → LC_MESSAGES → LANG → Intl default.
   * "No language set" values such as C / POSIX are skipped in favor of the next source.
   * @param {string[]} [argv] process.argv.slice(2)
   * @param {Record<string, string|undefined>} [env]
   * @returns {string} raw locale string (to pass on to normalizeLocale / createI18n)
   */
  function resolveCliLocale(argv, env) {
    const args = argv || [];
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]);
      if (a === '--lang' && args[i + 1]) return String(args[i + 1]);
      if (a.startsWith('--lang=')) return a.slice(7);
    }
    const e = env || (typeof process !== 'undefined' ? process.env : {}) || {};
    for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
      const v = e[k];
      if (!v) continue;
      if (/^(c|posix)(\..*)?$/i.test(String(v).trim())) continue;
      return String(v);
    }
    try { return Intl.DateTimeFormat().resolvedOptions().locale || 'en'; } catch { return 'en'; }
  }

  // ---------------------------------------------------------------------------
  // Dictionary loading (Node only)
  // ---------------------------------------------------------------------------

  const cache = new Map();
  const loadErrors = [];

  function nodeRequire(name) {
    // eslint-disable-next-line no-undef
    return typeof require === 'function' ? require(name) : null;
  }

  function defaultDir() {
    const path = nodeRequire('path');
    // eslint-disable-next-line no-undef
    return path && typeof __dirname === 'string' ? path.join(__dirname, '..', 'l10n') : null;
  }

  /**
   * Read and merge all area files for a locale (later areas override same-named keys). Missing files and parse failures are skipped.
   * @param {string} locale one of the five
   * @param {{ dir?: string, regions?: readonly string[], noCache?: boolean }} [opts]
   * @returns {Record<string, string>}
   */
  function loadLocaleDict(locale, opts = {}) {
    const loc = normalizeLocale(locale);
    const dir = opts.dir || defaultDir();
    const regions = opts.regions || REGIONS;
    const key = `${dir}\u0000${loc}\u0000${regions.join(',')}`;
    if (!opts.noCache && cache.has(key)) return cache.get(key);
    const fs = nodeRequire('fs');
    const path = nodeRequire('path');
    const out = {};
    if (fs && path && dir) {
      for (const region of regions) {
        const file = path.join(dir, `${region}.${loc}.json`);
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        let obj;
        try { obj = JSON.parse(text); } catch (err) { loadErrors.push({ file, message: String(err && err.message) }); continue; }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
        for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v;
      }
    }
    Object.freeze(out);
    if (!opts.noCache) cache.set(key, out);
    return out;
  }

  function clearCache() { cache.clear(); loadErrors.length = 0; }

  // ---------------------------------------------------------------------------
  // Interpolation
  // ---------------------------------------------------------------------------

  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /**
   * Replace '{name}' placeholders. Placeholders missing from vars are left as is (so missing arguments are easy to spot); null/undefined values become an empty string.
   * @param {string} template
   * @param {Record<string, any>} [vars]
   */
  function interpolate(template, vars) {
    const s = String(template);
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (own(vars, k) ? (vars[k] == null ? '' : String(vars[k])) : m));
  }

  // For injection into <script type="application/json">: escape < > & and U+2028/2029 so the tag cannot be closed early
  function safeJsonForScript(value) {
    return JSON.stringify(value)
      .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }

  // ---------------------------------------------------------------------------
  // i18n instance
  // ---------------------------------------------------------------------------

  /**
   * @param {string} locale already normalized
   * @param {Record<string, string>} en English dictionary (fallback)
   * @param {Record<string, string>} local dictionary for this language
   * @param {{ timeZone?: string }} [opts] timeZone: time zone for formatting times (default: local)
   */
  function makeI18n(locale, en, local, opts = {}) {
    const intlLocale = INTL_LOCALE[locale] || 'en-US';
    const timeZone = opts.timeZone || undefined;
    const fmts = new Map();
    const fmt = (kind, make) => {
      let f = fmts.get(kind);
      if (!f) { f = make(); fmts.set(kind, f); }
      return f;
    };

    /** Look up a string: this language → English → key name; interpolates when vars are given */
    function t(key, vars) {
      const s = own(local, key) ? local[key] : own(en, key) ? en[key] : key;
      return interpolate(s, vars);
    }
    function has(key) { return own(local, key) || own(en, key); }

    function fmtNum(n, options) {
      if (n == null || !Number.isFinite(Number(n))) return DASH;
      if (options) return new Intl.NumberFormat(intlLocale, options).format(Number(n));
      return fmt('num', () => new Intl.NumberFormat(intlLocale)).format(Number(n));
    }

    /** Token count in compact notation (at most 1 decimal), e.g. 412.3K in English */
    function fmtTokens(n) {
      if (n == null || !Number.isFinite(Number(n))) return DASH;
      return fmt('tokens', () => new Intl.NumberFormat(intlLocale, { notation: 'compact', maximumFractionDigits: 1 }))
        .format(Number(n));
    }

    /** Ratio → percentage: 0.423 → 42% */
    function fmtPct(ratio) {
      if (ratio == null || !Number.isFinite(Number(ratio))) return DASH;
      return fmt('pct', () => new Intl.NumberFormat(intlLocale, { style: 'percent', maximumFractionDigits: 0 }))
        .format(Number(ratio));
    }

    /**
     * Duration: <60 s → {s}s; <60 min → {m}m{ss}s; <24 h → {h}h{mm}m; longer → {d}d{hh}h.
     * Units come from the dictionary keys dur.s / dur.m / dur.h / dur.d. Negative or non-numeric → empty string.
     */
    function fmtDur(ms) {
      if (ms == null || !(Number(ms) >= 0) || !Number.isFinite(Number(ms))) return '';
      const u = (k) => t('dur.' + k);
      const pad = (x) => String(x).padStart(2, '0');
      const s = Math.floor(Number(ms) / 1000);
      if (s < 60) return `${s}${u('s')}`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}${u('m')}${pad(s % 60)}${u('s')}`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}${u('h')}${pad(m % 60)}${u('m')}`;
      return `${Math.floor(h / 24)}${u('d')}${pad(h % 24)}${u('h')}`;
    }

    /** Amount (USD): 3 decimals below 1, otherwise 2; values in (0, 0.001) show as <$0.001; null → — */
    function fmtUsd(usd) {
      if (usd == null || !Number.isFinite(Number(usd))) return DASH;
      const v = Number(usd);
      const three = fmt('usd3', () => new Intl.NumberFormat(intlLocale,
        { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 3, maximumFractionDigits: 3 }));
      const two = fmt('usd2', () => new Intl.NumberFormat(intlLocale,
        { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      if (v > 0 && v < 0.001) return '<' + three.format(0.001);
      return Math.abs(v) < 1 ? three.format(v) : two.format(v);
    }

    function dayKey(ms) {
      const p = fmt('day', () => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
      return p.format(new Date(ms));
    }

    /**
     * Point in time: same day shows only the time; within 6 days either way adds the weekday; further out adds month and day.
     * @param {number} ms
     * @param {number} [now]
     */
    function fmtClock(ms, now = Date.now()) {
      if (ms == null || !Number.isFinite(Number(ms))) return '';
      const d = new Date(Number(ms));
      if (dayKey(ms) === dayKey(now)) {
        return fmt('clock', () => new Intl.DateTimeFormat(intlLocale, { timeZone, hour: 'numeric', minute: '2-digit' })).format(d);
      }
      if (Math.abs(ms - now) < 6 * 86400e3) {
        return fmt('clockWd', () => new Intl.DateTimeFormat(intlLocale, { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' })).format(d);
      }
      return fmt('clockMd', () => new Intl.DateTimeFormat(intlLocale, { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })).format(d);
    }

    /** Full date and time */
    function fmtDateTime(ms) {
      if (ms == null || !Number.isFinite(Number(ms))) return '';
      return fmt('dt', () => new Intl.DateTimeFormat(intlLocale, { timeZone, dateStyle: 'medium', timeStyle: 'short' }))
        .format(new Date(Number(ms)));
    }

    /**
     * Relative time (Intl.RelativeTimeFormat, narrow): under 10 s is "now", then seconds/minutes/hours/days. Future times read "in x".
     * @param {number} ms
     * @param {number} [now]
     */
    function fmtAgo(ms, now = Date.now()) {
      if (ms == null || !Number.isFinite(Number(ms))) return '';
      const rtf = fmt('rtf', () => new Intl.RelativeTimeFormat(intlLocale, { numeric: 'auto', style: 'narrow' }));
      const diff = now - Number(ms);
      const sign = diff >= 0 ? -1 : 1;
      const a = Math.abs(diff) / 1000;
      if (a < 10) return rtf.format(0, 'second');
      if (a < 60) return rtf.format(sign * Math.floor(a), 'second');
      if (a < 3600) return rtf.format(sign * Math.floor(a / 60), 'minute');
      if (a < 86400) return rtf.format(sign * Math.floor(a / 3600), 'hour');
      return rtf.format(sign * Math.floor(a / 86400), 'day');
    }

    /**
     * Merged flat dictionary (English base, this language on top). With prefixes, only keys starting with them are kept.
     * @param {string[]} [prefixes]
     */
    function dict(prefixes) {
      const all = Object.assign({}, en, local);
      if (!prefixes || !prefixes.length) return all;
      const out = {};
      for (const k of Object.keys(all)) if (prefixes.some((p) => k.startsWith(p))) out[k] = all[k];
      return out;
    }

    /** Payload for the webview: { locale, intlLocale, dict } */
    function payload(prefixes) {
      return { locale, intlLocale, dict: dict(prefixes) };
    }

    /** JSON text that can go straight into <script type="application/json" id="l10n"> */
    function webviewJson(prefixes) {
      return safeJsonForScript(payload(prefixes));
    }

    return {
      locale, intlLocale, timeZone: timeZone || null,
      t, has, interpolate,
      fmtNum, fmtTokens, fmtPct, fmtDur, fmtUsd, fmtClock, fmtDateTime, fmtAgo,
      dict, payload, webviewJson,
    };
  }

  /**
   * Create an i18n instance.
   * @param {string|null|undefined} rawLocale vscode.env.language in the extension; resolveCliLocale() in the terminal version
   * @param {{ dir?: string, regions?: readonly string[], dicts?: Record<string, Record<string, string>>, timeZone?: string, noCache?: boolean }} [opts]
   *   dicts: dictionaries given directly (for tests and webviews), no file reads; dir: dictionary directory (default <this file>/../l10n)
   */
  function createI18n(rawLocale, opts = {}) {
    const locale = normalizeLocale(rawLocale);
    let en;
    let local;
    if (opts.dicts) {
      en = opts.dicts.en || {};
      local = locale === 'en' ? en : (opts.dicts[locale] || {});
    } else {
      en = loadLocaleDict('en', opts);
      local = locale === 'en' ? en : loadLocaleDict(locale, opts);
    }
    return makeI18n(locale, en, local, opts);
  }

  /**
   * Restore an instance from the output of payload()/webviewJson() (used in webviews; no file reads).
   * @param {{ locale: string, dict: Record<string, string> }} p
   * @param {{ timeZone?: string }} [opts]
   */
  function fromPayload(p, opts = {}) {
    const d = (p && p.dict) || {};
    return makeI18n(normalizeLocale(p && p.locale), d, d, opts);
  }

  return {
    LOCALES, REGIONS, INTL_LOCALE,
    normalizeLocale, intlLocaleOf, resolveCliLocale,
    loadLocaleDict, clearCache, loadErrors,
    interpolate, safeJsonForScript,
    createI18n, fromPayload,
  };
});
