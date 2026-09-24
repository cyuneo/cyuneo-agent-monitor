'use strict';
// "Usage history" page: a singleton WebviewPanel in the editor area (opening it again reveals it).
// - buildHistoryVm(): a pure function that turns the worker's HistoryReport (lib/core/history.js) into a view model.
//   All text is localized and formatted here; media/history.js only lays it out (bar geometry, tooltip, cost / tokens toggle).
// - The scan runs in the worker only while this page asks for it: one request when the page opens or becomes visible,
//   progress replies until complete, then a new request every minute while visible (cheap: only appended bytes are read).
//   Closing the page sends release, so the worker saves its cache and frees the memory.
// - The webview sends only { type: 'ready' | 'refresh' }; it never names files or paths.

const crypto = require('crypto');
const { clampDays, DEFAULT_DAYS } = require('./core/history');
const { formatCost, formatCostNote } = require('./format');

const VIEW_TYPE = 'agentMonitor.history';
// Strings injected into the webview: those the page shows before it receives the first view model
const HISTORY_DICT_PREFIXES = Object.freeze(['history.page.']);
const APPS = Object.freeze(['claude', 'codex']);
const LIVE_REFRESH_MS = 60e3;  // while visible and complete: ask again this often for new usage
const STALE_MS = 15e3;         // becoming visible again re-asks only if the last complete report is older than this
const WAIT_MS = 45e3;          // no reply this long after a request: show an error (the page keeps working if one arrives later)
const POST_EVERY_MS = 250;     // at most this many view-model posts per second while a scan streams progress
const TICK_EVERY = 7;          // x-axis label every 7th day, counted back from today
const MODEL_COLS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'cost']);
const COL_KEYS = Object.freeze({
  input: 'history.col.input', output: 'history.col.output', cacheRead: 'history.col.cacheRead', cacheWrite: 'history.col.cacheWrite',
  reasoning: 'history.col.reasoning', total: 'history.col.tokens', cost: 'history.col.cost',
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const pos = (v) => (fin(v) && v > 0 ? v : 0);

function attr(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 'YYYY-MM-DD' → a UTC date formatted in UTC, so the label is exactly that calendar day whatever the time zone setting
function dateOf(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : null;
}
function fmtDate(key, i18n, opts) {
  const d = dateOf(key);
  if (!d) return String(key || '');
  try { return new Intl.DateTimeFormat(i18n.intlLocale || 'en-US', { ...opts, timeZone: 'UTC' }).format(d); } catch { return String(key); }
}

/**
 * Round axis ticks from 0 to at least max (1, 2, 2.5 or 5 × 10^k steps).
 * @param {number} max
 * @param {number} [count] about this many intervals
 * @returns {{ top: number, ticks: number[] }}
 */
function niceTicks(max, count = 4) {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(+v.toPrecision(12));
  return { top: ticks[ticks.length - 1], ticks };
}

// Axis amounts: short ($0.25, $12, $1.5K)
function fmtAxisUsd(v, i18n) {
  try {
    const small = v < 10;
    return new Intl.NumberFormat(i18n.intlLocale || 'en-US', {
      style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol',
      notation: small ? 'standard' : 'compact', maximumFractionDigits: small ? 2 : 1, minimumFractionDigits: 0,
    }).format(v);
  } catch {
    return '$' + v;
  }
}

/**
 * View model for the page.
 * @param {{ report?: any, loading?: boolean, error?: string|null, i18n: any, now?: number, days?: number }} input
 *   report: the latest worker reply (HistoryReport); error: a request failure on the extension side
 */
function buildHistoryVm(input) {
  const i18n = input.i18n;
  const t = (k, v) => i18n.t(k, v);
  const r = input.report && typeof input.report === 'object' && Array.isArray(input.report.days) && input.report.days.length ? input.report : null;
  const now = fin(input.now) ? input.now : Date.now();
  const nDays = r && fin(r.windowDays) ? r.windowDays : clampDays(input.days);
  const appLabel = (a) => t('history.app.' + a);
  const err = input.error || (input.report && typeof input.report === 'object' && input.report.error) || null;
  const vm = {
    title: t('history.page.title'),
    // An error stops the spinner and the progress bar even if the last report was partial (e.g. the scanner stopped answering)
    busy: !err && (!!input.loading || !!(r && r.partial)),
    statusText: '',
    // Screen-reader announcement (the page's polite live region): changes only when a scan starts, finishes or fails,
    // not on every progress step or on the minute-by-minute refresh
    liveText: '',
    labels: {
      refresh: t('history.btn.refresh'),
      mode: t('history.mode.label'),
      cost: t('history.mode.cost'),
      tokens: t('history.mode.tokens'),
      legend: t('history.chart.legend'),
      showTable: t('history.chart.showTable'),
      date: t('history.col.date'),
      total: t('history.col.total'),
      claude: appLabel('claude'),
      codex: appLabel('codex'),
    },
    errorText: null,
    progress: null,
    unpricedText: null,
    cacheText: null,
    empty: null,
    totals: [],
    chart: null,
    models: null,
    notes: null,
    footer: t('history.page.footer'),
  };
  if (err) vm.errorText = t('history.page.error', { error: String(err).split('\n')[0] });
  if (!r) {
    vm.statusText = err ? '' : t('history.page.loading');
    vm.liveText = vm.statusText;
    return vm;
  }

  const range = t('history.page.range', { days: i18n.fmtNum(nDays), from: fmtDate(r.start, i18n, { month: 'short', day: 'numeric' }), to: fmtDate(r.end, i18n, { month: 'short', day: 'numeric' }) });
  vm.statusText = r.partial
    ? range
    : range + ' · ' + t('history.page.updated', { time: i18n.fmtClock ? i18n.fmtClock(r.at, now) : new Date(r.at).toLocaleTimeString() });

  if (!err) vm.liveText = r.partial ? t('history.page.loading') : t('history.live.done');

  if (r.partial && !err) {
    const p = r.progress || {};
    const ratio = pos(p.totalBytes) ? Math.min(0.99, pos(p.doneBytes) / p.totalBytes) : 0;
    const pct = Math.floor(ratio * 100);
    vm.progress = {
      pct,
      text: t('history.progress.text', { pct: i18n.fmtPct(pct / 100) }),
      detail: pos(p.filesTotal) ? t('history.progress.files', { done: i18n.fmtNum(pos(p.filesDone)), total: i18n.fmtNum(p.filesTotal) }) : '',
      label: t('history.progress.label'),
    };
  }

  const tot = r.totals || {};
  const tp = (a) => (tot[a] && typeof tot[a] === 'object' ? tot[a] : { usd: 0, tokens: 0, unpricedTokens: 0 });
  // Nothing spent reads "$0.00" (fmtUsd writes amounts under $1 with three decimals, which looks odd for nothing at all)
  const zeroUsd = i18n.fmtNum(0, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const costText = (usd, unpricedTokens) => {
    const v = fin(usd) ? usd : 0;
    const unpriced = pos(unpricedTokens) > 0;
    return Math.abs(v) < 1e-9 ? zeroUsd + (unpriced ? '+' : '') : formatCost(v, i18n, { unpriced });
  };
  if (pos(tot.unpricedTokens)) vm.unpricedText = t('history.unpriced', { tokens: i18n.fmtTokens(tot.unpricedTokens) });
  if (r.cache && r.cache.error) vm.cacheText = t('history.cacheError', { error: String(r.cache.error) });

  const hasData = pos(tot.tokens) > 0;
  if (!hasData && !r.partial && !err) {
    const any = !r.sources || r.sources.claude || r.sources.codex;
    vm.empty = { title: t('history.empty.title', { days: i18n.fmtNum(nDays) }), hint: t(any ? 'history.empty.hint' : 'history.empty.disabled') };
  }

  // ---------- Totals ----------
  vm.totals = [
    { key: 'cost', label: t('history.total.cost'), value: costText(tot.usd, tot.unpricedTokens), sub: t('history.total.window', { days: i18n.fmtNum(nDays) }) },
    { key: 'tokens', label: t('history.total.tokens'), value: i18n.fmtTokens(pos(tot.tokens)), sub: t('history.total.exact', { n: i18n.fmtNum(pos(tot.tokens)) }) },
    ...APPS.map((a) => ({
      key: a, swatch: a, label: appLabel(a),
      value: costText(tp(a).usd, tp(a).unpricedTokens),
      sub: t('history.total.appTokens', { tokens: i18n.fmtTokens(pos(tp(a).tokens)) }),
    })),
    {
      key: 'avg', label: t('history.total.avg'), value: costText(pos(tot.usd) / nDays, tot.unpricedTokens),
      sub: t('history.total.activeDays', { n: i18n.fmtNum(pos(tot.activeDays)), days: i18n.fmtNum(nDays) }),
    },
  ];

  // ---------- Chart ----------
  if (hasData || r.partial) {
    const last = r.days.length - 1;
    let maxCost = 0;
    let maxTok = 0;
    let peakCost = null;
    let peakTok = null;
    const bars = r.days.map((d, i) => {
      const c = APPS.map((a) => pos(d[a] && d[a].usd));
      const k = APPS.map((a) => pos(d[a] && d[a].tokens));
      const cs = c[0] + c[1];
      const ks = k[0] + k[1];
      if (cs > maxCost) { maxCost = cs; peakCost = d.date; }
      if (ks > maxTok) { maxTok = ks; peakTok = d.date; }
      const long = fmtDate(d.date, i18n, { weekday: 'short', month: 'short', day: 'numeric' });
      const unpriced = APPS.map((a) => pos(d[a] && d[a].unpricedTokens) > 0);
      const text = {
        cost: { claude: costText(c[0], unpriced[0] ? 1 : 0), codex: costText(c[1], unpriced[1] ? 1 : 0), total: costText(cs, unpriced[0] || unpriced[1] ? 1 : 0) },
        tokens: { claude: i18n.fmtTokens(k[0]), codex: i18n.fmtTokens(k[1]), total: i18n.fmtTokens(ks) },
      };
      const aria = (m) => t('history.chart.day', { date: long, total: text[m].total, claude: text[m].claude, codex: text[m].codex });
      return {
        date: d.date,
        short: fmtDate(d.date, i18n, { month: 'numeric', day: 'numeric' }),
        long: i === last ? t('history.chart.today', { date: long }) : long,
        today: i === last,
        tick: (last - i) % TICK_EVERY === 0,
        cost: c,
        tokens: k,
        text,
        aria: { cost: aria('cost'), tokens: aria('tokens') },
      };
    });
    const axis = (max, fmt) => {
      const n = niceTicks(max);
      return { top: n.top, ticks: n.ticks.map((v) => ({ value: v, text: fmt(v) })) };
    };
    const summary = (m, peak, max) => (peak
      ? t('history.chart.summary.' + m, { days: i18n.fmtNum(nDays), max: m === 'cost' ? i18n.fmtUsd(max) : i18n.fmtTokens(max), date: fmtDate(peak, i18n, { month: 'short', day: 'numeric' }) })
      : t('history.chart.summary.none', { days: i18n.fmtNum(nDays) }));
    vm.chart = {
      heading: { cost: t('history.chart.heading.cost'), tokens: t('history.chart.heading.tokens') },
      label: { cost: summary('cost', peakCost, maxCost), tokens: summary('tokens', peakTok, maxTok) },
      legend: APPS.map((a) => ({ key: a, label: appLabel(a) })),
      axis: { cost: axis(maxCost, (v) => fmtAxisUsd(v, i18n)), tokens: axis(maxTok, (v) => i18n.fmtTokens(v)) },
      bars,
      tableCaption: { cost: t('history.chart.tableCaption.cost', { days: i18n.fmtNum(nDays) }), tokens: t('history.chart.tableCaption.tokens', { days: i18n.fmtNum(nDays) }) },
    };
  }

  // ---------- By model ----------
  const rows = (Array.isArray(r.byModel) ? r.byModel : []).map((m) => {
    const tk = m.tokens || {};
    const num = (v) => (v == null ? { text: '—', title: t('history.models.notReported') } : { text: i18n.fmtTokens(v), title: i18n.fmtNum(v) });
    return {
      key: m.provider + ':' + m.model,
      provider: m.provider,
      providerLabel: appLabel(m.provider === 'codex' ? 'codex' : 'claude'),
      model: m.model === 'unknown' ? t('history.models.unknown') : m.model,
      cells: {
        input: num(tk.input), output: num(tk.output), cacheRead: num(tk.cacheRead), cacheWrite: num(tk.cacheWrite),
        reasoning: num(tk.reasoning), total: num(tk.total),
        cost: m.usd == null ? { text: t('cost.unpriced'), title: '' } : { text: costText(m.usd, 0), title: '' },
      },
    };
  });
  if (rows.length) {
    const sum = (k) => r.byModel.reduce((s, m) => s + (m.tokens && fin(m.tokens[k]) ? m.tokens[k] : 0), 0);
    vm.models = {
      heading: t('history.models.heading'),
      caption: t('history.models.caption', { days: i18n.fmtNum(nDays) }),
      cols: [{ key: 'model', label: t('history.col.model'), num: false }, ...MODEL_COLS.map((k) => ({ key: k, label: t(COL_KEYS[k]), num: true }))],
      rows,
      total: {
        label: t('history.col.total'),
        cells: {
          input: { text: i18n.fmtTokens(sum('input')), title: i18n.fmtNum(sum('input')) },
          output: { text: i18n.fmtTokens(sum('output')), title: i18n.fmtNum(sum('output')) },
          cacheRead: { text: i18n.fmtTokens(sum('cacheRead')), title: i18n.fmtNum(sum('cacheRead')) },
          cacheWrite: { text: i18n.fmtTokens(sum('cacheWrite')), title: i18n.fmtNum(sum('cacheWrite')) },
          reasoning: { text: i18n.fmtTokens(sum('reasoning')), title: i18n.fmtNum(sum('reasoning')) },
          total: { text: i18n.fmtTokens(sum('total')), title: i18n.fmtNum(sum('total')) },
          cost: { text: costText(tot.usd, tot.unpricedTokens), title: '' },
        },
      },
    };
  }

  vm.notes = {
    heading: t('history.notes.heading'),
    items: [
      formatCostNote(i18n),
      t('history.note.local'),
      t('history.note.retention'),
      t('history.note.columns'),
      t('history.note.scope'),
    ],
  };
  return vm;
}

// ---------------------------------------------------------------------------
// Page HTML (pure function)
// ---------------------------------------------------------------------------

/**
 * @param {{ cspSource: string, asset: (p: string) => string, nonce: string, i18n: any }} o
 * @returns {string}
 */
function historyHtml({ cspSource, asset, nonce, i18n }) {
  const t = (k, vars) => attr(i18n.t(k, vars));
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  const l10n = i18n.webviewJson(HISTORY_DICT_PREFIXES);
  return `<!DOCTYPE html>
<html lang="${attr(i18n.intlLocale || 'en')}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${attr(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(asset('codicons/codicon.css'))}">
<link rel="stylesheet" href="${attr(asset('history.css'))}">
<title>${t('history.page.title')}</title>
<script type="application/json" id="l10n">${l10n}</script>
</head>
<body>
<main class="page">
  <header class="p-head">
    <h1 id="title">${t('history.page.title')}</h1>
    <span id="status" class="muted">${t('history.page.loading')}</span>
    <span class="spacer"></span>
    <button type="button" id="refresh" class="btn secondary" data-act="refresh"><i class="codicon codicon-refresh" aria-hidden="true"></i><span>${t('history.btn.refresh')}</span></button>
  </header>
  <p id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p>
  <div id="root"></div>
</main>
<script nonce="${attr(nonce)}" src="${attr(asset('history.js'))}"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// WebviewPanel
// ---------------------------------------------------------------------------

let current = null;

class HistoryPanel {
  /**
   * @param {any} context ExtensionContext
   * @param {{ requestHistory: (req: { days?: number, force?: boolean, release?: boolean }) => void,
   *   onHistory: (listener: (report: any) => void) => ({ dispose: () => void }|(() => void)),
   *   i18n: any, days?: number, vscode?: any, log?: (s: string) => void }} deps
   */
  constructor(context, deps) {
    this.vscode = deps.vscode || require('vscode');
    this.context = context;
    this.deps = deps;
    this.i18n = deps.i18n;
    this.days = clampDays(deps.days ?? DEFAULT_DAYS);
    this.log = typeof deps.log === 'function' ? deps.log : () => {};
    this.panel = null;
    this.ready = false;
    this.disposed = false;
    this.report = null;
    this.loading = false;
    this.error = null;
    this.completeAt = 0;      // when the last complete (not partial) report arrived
    this.lastJson = '';
    this.lastPost = 0;
    this.postTimer = null;
    this.waitTimer = null;
    this.liveTimer = null;
    this.sub = null;
    this.disposables = [];
  }

  t(k, v) { return this.i18n.t(k, v); }

  open() {
    const vscode = this.vscode;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, this.t('history.page.title'),
      vscode.ViewColumn ? vscode.ViewColumn.Active : -1,
      { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: false });
    this.panel = panel;
    try { panel.iconPath = vscode.Uri.joinPath(media, 'icon.png'); } catch { /* ignore */ }
    const nonce = crypto.randomBytes(16).toString('base64');
    panel.webview.html = historyHtml({
      cspSource: panel.webview.cspSource,
      asset: (p) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, ...p.split('/'))).toString(),
      nonce,
      i18n: this.i18n,
    });
    try { this.sub = this.deps.onHistory((m) => this.onReport(m)); } catch (err) { this.log('history view: ' + ((err && err.stack) || err)); }
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m) => {
        Promise.resolve().then(() => this.onMessage(m)).catch((err) => this.log('history view: ' + ((err && err.stack) || err)));
      }),
      panel.onDidDispose(() => this.dispose()),
    );
    if (typeof panel.onDidChangeViewState === 'function') {
      this.disposables.push(panel.onDidChangeViewState(() => {
        if (!panel.visible) { this.ready = false; return; }
        if (!this.loading && Date.now() - this.completeAt > STALE_MS) this.request(false);
      }));
    }
    // While visible and complete, pick up new usage every minute (the worker reads only appended bytes)
    this.liveTimer = setInterval(() => {
      if (this.panel && this.panel.visible !== false && !this.loading && this.report && !this.report.partial) this.request(false);
    }, LIVE_REFRESH_MS);
    if (this.liveTimer && typeof this.liveTimer.unref === 'function') this.liveTimer.unref();
    this.request(false);
    return this;
  }

  reveal() {
    if (this.panel) {
      try { this.panel.reveal(); } catch { /* ignore */ }
    }
    if (!this.loading) this.request(false);
  }

  /** Ask the worker for the history (force: re-list and re-check every file now) */
  request(force) {
    this.loading = true;
    this.error = null;
    clearTimeout(this.waitTimer);
    this.waitTimer = setTimeout(() => {
      if (this.disposed || !this.loading) return;
      this.loading = false;
      this.error = this.t('history.page.noReply');
      this.post(true);
    }, WAIT_MS);
    if (this.waitTimer && typeof this.waitTimer.unref === 'function') this.waitTimer.unref();
    try {
      this.deps.requestHistory({ days: this.days, force: !!force });
    } catch (err) {
      this.loading = false;
      this.error = String((err && err.message) || err);
    }
    this.post(true);
  }

  onReport(m) {
    if (this.disposed || !m || typeof m !== 'object') return;
    const { type, ...rep } = m; // eslint-disable-line no-unused-vars
    this.report = rep;
    this.error = null;
    if (rep.partial) {
      // More replies follow; keep the no-reply watchdog armed between them
      clearTimeout(this.waitTimer);
      this.waitTimer = setTimeout(() => {
        if (this.disposed) return;
        this.loading = false;
        this.error = this.t('history.page.noReply');
        this.post(true);
      }, WAIT_MS);
      if (this.waitTimer && typeof this.waitTimer.unref === 'function') this.waitTimer.unref();
      this.post(false);
      return;
    }
    clearTimeout(this.waitTimer);
    this.loading = false;
    this.completeAt = Date.now();
    this.post(true);
  }

  build() {
    return buildHistoryVm({ report: this.report, loading: this.loading, error: this.error, i18n: this.i18n, now: Date.now(), days: this.days });
  }

  /** Send the view model (skipped when unchanged; while progress streams in, at most every POST_EVERY_MS unless now) */
  post(now) {
    if (!this.panel || !this.ready || this.disposed) return;
    const wait = this.lastPost + POST_EVERY_MS - Date.now();
    if (!now && wait > 0) {
      if (!this.postTimer) {
        this.postTimer = setTimeout(() => { this.postTimer = null; this.post(true); }, wait);
        if (this.postTimer && typeof this.postTimer.unref === 'function') this.postTimer.unref();
      }
      return;
    }
    clearTimeout(this.postTimer);
    this.postTimer = null;
    const vm = this.build();
    const json = JSON.stringify(vm);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.lastPost = Date.now();
    this.panel.webview.postMessage({ type: 'vm', vm });
  }

  onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.lastJson = '';
        this.post(true);
        return;
      case 'refresh':
        this.request(true);
        return;
      default:
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.liveTimer);
    clearTimeout(this.waitTimer);
    clearTimeout(this.postTimer);
    this.liveTimer = this.waitTimer = this.postTimer = null;
    // The page is gone: the worker saves its cache and frees the scanner
    try { this.deps.requestHistory({ release: true }); } catch { /* ignore */ }
    const sub = this.sub;
    this.sub = null;
    try { if (typeof sub === 'function') sub(); else if (sub && typeof sub.dispose === 'function') sub.dispose(); } catch { /* ignore */ }
    for (const d of this.disposables.splice(0)) { try { d.dispose(); } catch { /* ignore */ } }
    const p = this.panel;
    this.panel = null;
    this.ready = false;
    if (p) { try { p.dispose(); } catch { /* ignore */ } }
    if (current === this) current = null;
  }
}

/**
 * Opens the "Usage history" page (singleton: if already open, reveal it and ask for fresh numbers).
 * @param {any} context ExtensionContext
 * @param {{ requestHistory: (req: { days?: number, force?: boolean, release?: boolean }) => void,
 *   onHistory: (listener: (report: any) => void) => ({ dispose: () => void }|(() => void)),
 *   i18n: any, days?: number, vscode?: any, log?: (s: string) => void }} deps
 * @returns {HistoryPanel}
 */
function openHistory(context, deps) {
  if (current && !current.disposed) {
    current.deps = { ...current.deps, ...deps };
    current.reveal();
    return current;
  }
  current = new HistoryPanel(context, deps);
  return current.open();
}

module.exports = {
  VIEW_TYPE, HISTORY_DICT_PREFIXES,
  openHistory, openHistoryView: openHistory, HistoryPanel, buildHistoryVm, historyHtml,
  _internal: { niceTicks, fmtAxisUsd, fmtDate, attr },
};
