'use strict';
// HTML for the bottom-panel webview, laid out like VS Code's terminal panel. Pure function with no vscode
// dependency; shared by the preview page and the extension.
// - One layout: inside #app, one side is the session list #slist (role=listbox, modeled on the terminal tab list)
//   and the other is the content area #content (session bar + agent table), separated by a draggable sash #sash.
//   The extension tells the page which side the list goes on (from settings); the page reorders the DOM itself.
// - asset(relPath): turns a path relative to media/ into a URL the webview can load.
// - i18n: an instance from lib/i18n.js. <html lang> uses its Intl locale (so CJK glyphs pick the right font per
//   language); static text (column headers, buttons) is resolved here. The strings the webview needs are injected as
//   <script type="application/json" id="l10n">; agents.js only looks them up (cache countdown, expand/collapse
//   accessibility labels) and never builds sentences itself.
// - The CSP allows only cspSource (styles, fonts) and scripts with the nonce; the JSON data block is not executed,
//   so script-src does not apply to it.

// Prefixes of strings injected into the webview: everything under webview.*, plus the cache text that the session
// bar refreshes on its own every 30 seconds (from the views section)
const WEBVIEW_DICT_PREFIXES = Object.freeze(['webview.', 'session.cacheLeft', 'session.cacheExpired', 'session.loading']);

function attr(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Minimal fallback when no i18n is passed (older callers, unit tests)
function fallbackI18n() {
  return {
    intlLocale: 'en',
    t: (k, vars) => String(k).replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m)),
    webviewJson: () => JSON.stringify({ locale: 'en', intlLocale: 'en', dict: {} }),
  };
}

/**
 * @param {{ cspSource: string, asset: (p: string) => string, nonce: string, version: string, i18n?: any }} o
 * @returns {string}
 */
function webviewHtml({ cspSource, asset, nonce, version, i18n }) {
  const L = i18n || fallbackI18n();
  const t = (k, vars) => attr(L.t(k, vars));
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  const l10n = typeof L.webviewJson === 'function' ? L.webviewJson(WEBVIEW_DICT_PREFIXES) : '{}';
  const head = (cls, key, tip) => `<div class="cell ${cls}" role="columnheader"${tip ? ` title="${t(tip)}"` : ''}>${t(key)}</div>`;
  return `<!DOCTYPE html>
<html lang="${attr(L.intlLocale || 'en')}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${attr(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(asset('codicons/codicon.css'))}">
<link rel="stylesheet" href="${attr(asset('agents.css'))}">
<title>${t('webview.title')}</title>
<script type="application/json" id="l10n">${l10n}</script>
</head>
<body>
<div id="app" class="app list-right">
<main id="content" class="content" tabindex="0" aria-label="${t('webview.title')}">
<p id="empty" class="empty" role="status">${t('session.loading')}</p>
<p id="empty-act-line" class="empty-act" hidden><button type="button" id="empty-act" class="link" data-act="emptyAction"></button></p>
<section id="sbar" class="sbar" hidden aria-labelledby="s-title">
  <div class="s-line s-head">
    <i id="s-lamp" class="lamp codicon codicon-circle-large-outline" aria-hidden="true"></i>
    <h2 id="s-title" class="s-title"></h2>
    <span id="s-meta" class="s-meta muted"></span>
    <span class="spacer"></span>
    <span id="s-headctx" class="s-text s-headctx" hidden></span>
    <button type="button" id="s-goto" class="btn secondary" data-act="goTo" hidden title="${t('webview.goTo.tip')}" aria-label="${t('webview.goTo')}"><i class="codicon codicon-link-external" aria-hidden="true"></i><span>${t('webview.goTo')}</span></button>
    <button type="button" id="s-compact" class="btn" data-act="compact" hidden title="${t('webview.compact.tip')}"><i class="codicon codicon-screen-normal" aria-hidden="true"></i><span>${t('webview.compact')}</span></button>
  </div>
  <!-- The session bar is always two lines (title line + this summary line) so the agent table stays visible in a short panel; everything else goes under "Details" -->
  <div class="s-line s-sum">
    <i id="s-badge" class="badge codicon" aria-hidden="true" hidden></i>
    <span id="s-status" class="s-text"></span>
    <span id="s-ctx" class="s-text sum-ctx"></span>
    <span id="s-zone" class="chip" hidden><i class="codicon" aria-hidden="true"></i><span></span></span>
    <span id="s-cache" class="s-text sum-cache" hidden title="${t('webview.cache.tip')}"></span>
    <span id="s-cost" class="s-text sum-cost"></span>
    <span class="spacer"></span>
    <button type="button" id="s-resumebtn" class="link sum-btn" data-act="showResume" hidden title="${t('webview.resumeShort')}" aria-label="${t('webview.resumeShort')}"><i class="codicon codicon-history" aria-hidden="true"></i><span>${t('webview.resumeShort')}</span></button>
    <button type="button" id="s-more" class="link sum-btn" data-act="toggleDetails" aria-expanded="false" aria-controls="s-details"><span>${t('webview.details')}</span><i class="codicon codicon-chevron-right" aria-hidden="true"></i></button>
  </div>
  <!-- Urgent banner: takes a line only when something is actually wrong (usage limit hit, API error, compaction loop); full text is in the hover tooltip and details -->
  <div id="s-urgent" class="s-line s-urgent" role="alert" hidden><i class="codicon" aria-hidden="true"></i><span class="u-text"></span></div>
  <div id="s-details" class="s-details" hidden>
    <div id="s-ctxline" class="s-line s-ctx">
      <span class="s-label">${t('webview.ctx.label')}</span>
      <span id="s-meter" class="meter" role="meter" aria-label="${t('webview.ctx.meter')}" aria-valuemin="0" aria-valuemax="100"><span id="s-fill" class="meter-fill"></span></span>
      <span id="s-pct" class="s-text" hidden></span>
      <span id="s-remain" class="s-text" hidden></span>
    </div>
    <div id="s-acline" class="s-line s-ac" hidden>
      <button type="button" id="s-autocompact" class="link ac" data-act="setAutoCompact" hidden><span class="ac-text"></span><span class="ac-src"></span><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button>
      <span id="s-compacts" class="s-text" hidden></span>
    </div>
    <div id="s-costline" class="s-line s-cost">
      <span id="s-today" class="s-text"></span>
    </div>
    <div id="s-banners" class="banners"></div>
    <ul id="s-resume" class="r-list" aria-label="${t('webview.resume')}" hidden></ul>
    <div id="s-storeline" class="s-line s-store" hidden>
      <span class="s-pathbox"><span class="s-label">${t('webview.store.label')}</span><span id="s-path" class="s-path"></span></span>
      <span id="s-sizes" class="s-text muted" hidden></span>
      <button type="button" id="s-reveal" class="link" data-act="revealTranscript"><i class="codicon codicon-folder-opened" aria-hidden="true"></i><span></span></button>
      <button type="button" id="s-copypath" class="link" data-act="copyTranscriptPath"><i class="codicon codicon-copy" aria-hidden="true"></i><span></span></button>
    </div>
  </div>
</section>
<div id="grid" class="grid" role="table" aria-label="${t('webview.table')}" hidden>
  <div class="row head" role="row">
    ${head('c-name', 'webview.col.agent')}
    ${head('c-status', 'webview.col.status')}
    <div class="c-line2" role="none">
      ${head('c-step', 'webview.col.step')}
      ${head('c-tok num', 'webview.col.tokens', 'webview.col.tokens.tip')}
      ${head('c-cost num', 'webview.col.cost')}
      ${head('c-time num', 'webview.col.time', 'webview.col.time.tip')}
    </div>
  </div>
  <div id="rows" role="rowgroup"></div>
</div>
<p id="note" class="note muted" hidden></p>
<footer class="muted">${t('webview.footer', { version })}</footer>
</main>
<div id="sash" class="sash" aria-hidden="true"></div>
<div id="slist" class="slist">
  <div id="sl-box" class="sl-box" role="listbox" tabindex="0" aria-label="${t('webview.list')}"></div>
</div>
</div>
<script nonce="${attr(nonce)}" src="${attr(asset('session-list.js'))}"></script>
<script nonce="${attr(nonce)}" src="${attr(asset('agents.js'))}"></script>
</body>
</html>`;
}

module.exports = { webviewHtml, WEBVIEW_DICT_PREFIXES };
