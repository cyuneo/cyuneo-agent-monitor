'use strict';
// 多语言（DESIGN §9 + 决定 6）：locale 归一化、按功能区合并词典、t(key, vars)、数字/时长/金额/时间格式化。
// - 词典：l10n/<区>.<locale>.json，区固定为 core、views、webview、cli、compact、storage；
//   加载某 locale 时合并该 locale 的全部区文件，缺的键回退英文，英文再缺回退键名。
// - 能跑在扩展主线程、终端版（Node），也能在 webview 里用：
//   扩展把 i18n.webviewJson(前缀) 注入 <script type="application/json">，webview 用 fromPayload() 还原；
//   词典合并了全部区，所以任何区的键（例如“存储位置与占用”页面的 storage.page.*）都能按前缀带进去。
//   本文件不在顶层 require 任何 Node 模块，浏览器里直接 <script> 引入时挂在 globalThis.AgentMonitorI18n。
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.AgentMonitorI18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LOCALES = Object.freeze(['en', 'zh-cn', 'zh-tw', 'ko', 'ja']);
  const REGIONS = Object.freeze(['core', 'views', 'webview', 'cli', 'compact', 'storage']);
  const INTL_LOCALE = Object.freeze({ en: 'en-US', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-TW', ko: 'ko-KR', ja: 'ja-JP' });
  const DASH = '—';

  /**
   * VS Code / 系统 locale → 五种之一（§9.2）。
   * zh-tw / zh-hk / zh-mo / zh-hant* → zh-tw；其余 zh* → zh-cn；ko* → ko；ja* → ja；其它 → en。
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

  /** 五种 locale → Intl 用的 BCP 47 标签 */
  function intlLocaleOf(locale) {
    return INTL_LOCALE[normalizeLocale(locale)];
  }

  /**
   * 终端版取语言：--lang / --lang=xx → LC_ALL → LC_MESSAGES → LANG → Intl 默认。
   * C / POSIX 这类“没设语言”的值跳过，看下一个来源。
   * @param {string[]} [argv] process.argv.slice(2)
   * @param {Record<string, string|undefined>} [env]
   * @returns {string} 原始 locale 字符串（再交给 normalizeLocale / createI18n）
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
  // 词典加载（只在 Node 里用）
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
   * 读某个 locale 全部区文件并合并（后面的区覆盖前面的同名键）。缺文件、解析失败都跳过。
   * @param {string} locale 五种之一
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
  // 插值
  // ---------------------------------------------------------------------------

  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /**
   * '{name}' 占位符替换。vars 里没有的占位符原样保留（便于发现漏传），值为 null/undefined 替换成空串。
   * @param {string} template
   * @param {Record<string, any>} [vars]
   */
  function interpolate(template, vars) {
    const s = String(template);
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (own(vars, k) ? (vars[k] == null ? '' : String(vars[k])) : m));
  }

  // 注入 <script type="application/json"> 用：转义 < > & 和 U+2028/2029，避免提前闭合标签
  function safeJsonForScript(value) {
    return JSON.stringify(value)
      .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }

  // ---------------------------------------------------------------------------
  // i18n 实例
  // ---------------------------------------------------------------------------

  /**
   * @param {string} locale 已归一化
   * @param {Record<string, string>} en 英文词典（兜底）
   * @param {Record<string, string>} local 本语言词典
   * @param {{ timeZone?: string }} [opts] timeZone：格式化时间用的时区（默认本机）
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

    /** 取词条：本语言 → 英文 → 键名；有 vars 时做插值 */
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

    /** token 数：412.3K / 41.2万（compact，最多 1 位小数） */
    function fmtTokens(n) {
      if (n == null || !Number.isFinite(Number(n))) return DASH;
      return fmt('tokens', () => new Intl.NumberFormat(intlLocale, { notation: 'compact', maximumFractionDigits: 1 }))
        .format(Number(n));
    }

    /** 比例 → 百分数：0.423 → 42% */
    function fmtPct(ratio) {
      if (ratio == null || !Number.isFinite(Number(ratio))) return DASH;
      return fmt('pct', () => new Intl.NumberFormat(intlLocale, { style: 'percent', maximumFractionDigits: 0 }))
        .format(Number(ratio));
    }

    /**
     * 时长（§9.4）：<60 秒 {s}秒；<60 分 {m}分{ss}秒；<24 时 {h}时{mm}分；更长 {d}天{hh}时。
     * 单位取词典 dur.s / dur.m / dur.h / dur.d。负数、非数 → 空串。
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

    /** 金额（美元）：<1 保留 3 位小数，否则 2 位；(0, 0.001) 显示 <$0.001；null → — */
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
     * 时刻：同一天只显示时间；前后 6 天内加星期；更远加月日。
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

    /** 完整日期时间 */
    function fmtDateTime(ms) {
      if (ms == null || !Number.isFinite(Number(ms))) return '';
      return fmt('dt', () => new Intl.DateTimeFormat(intlLocale, { timeZone, dateStyle: 'medium', timeStyle: 'short' }))
        .format(new Date(Number(ms)));
    }

    /**
     * 相对时间（Intl.RelativeTimeFormat，narrow）：<10 秒“现在”，再按秒/分/时/天。未来时间输出“x 后”。
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
     * 合并后的扁平词典（英文打底、本语言覆盖）。给了 prefixes 就只留以这些前缀开头的键。
     * @param {string[]} [prefixes]
     */
    function dict(prefixes) {
      const all = Object.assign({}, en, local);
      if (!prefixes || !prefixes.length) return all;
      const out = {};
      for (const k of Object.keys(all)) if (prefixes.some((p) => k.startsWith(p))) out[k] = all[k];
      return out;
    }

    /** 给 webview 的载荷 { locale, intlLocale, dict } */
    function payload(prefixes) {
      return { locale, intlLocale, dict: dict(prefixes) };
    }

    /** 可以直接放进 <script type="application/json" id="l10n"> 的 JSON 文本 */
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
   * 创建 i18n 实例。
   * @param {string|null|undefined} rawLocale 扩展里传 vscode.env.language；终端版传 resolveCliLocale()
   * @param {{ dir?: string, regions?: readonly string[], dicts?: Record<string, Record<string, string>>, timeZone?: string, noCache?: boolean }} [opts]
   *   dicts：直接给词典（测试、webview 用），不读文件；dir：词典目录（默认 <本文件>/../l10n）
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
   * 由 payload()/webviewJson() 的内容还原实例（webview 里用，不读文件）。
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
