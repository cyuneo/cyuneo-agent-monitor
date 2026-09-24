'use strict';
// 底部面板 webview 的 HTML（DESIGN §11.13：做成终端面板那样）。纯函数、不依赖 vscode，预览页和扩展共用。
// - 一个整体：#app 里一侧是会话列表 #slist（role=listbox，仿终端标签列表），另一块是内容区 #content
//   （会话条 + 智能体表），两者之间是可拖动的分隔线 #sash。列表在哪边由扩展按设置推给页面，页面自己调换 DOM 顺序。
// - asset(relPath)：把 media/ 下的相对路径转成 webview 能加载的 URL。
// - i18n：lib/i18n.js 的实例。页面 <html lang> 用它的 Intl locale（中日韩字形按语言选字体），
//   静态文字（表头、按钮）在这里取好；另把 webview 用到的词条注入 <script type="application/json" id="l10n">，
//   agents.js 只拿它做查表（缓存倒计时、展开/折叠的无障碍标签），不自己拼句子。
// - CSP 只放行 cspSource（样式、字体）和带 nonce 的脚本；JSON 数据块不执行，不受 script-src 限制。

// 注入 webview 的词条前缀：本区 webview.*，外加右侧会话条每 30 秒自己刷新的缓存文字（views 区）
const WEBVIEW_DICT_PREFIXES = Object.freeze(['webview.', 'session.cacheLeft', 'session.cacheExpired', 'session.loading']);

function attr(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 没传 i18n 时（旧调用方、单测）用的最小兜底
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
    <button type="button" id="s-compact" class="btn" data-act="compact" hidden title="${t('webview.compact.tip')}"><i class="codicon codicon-screen-normal" aria-hidden="true"></i><span>${t('webview.compact')}</span></button>
  </div>
  <!-- §11.14：会话条固定两行（标题行 + 这一行摘要），矮面板里也要让智能体表露出来；其余收进“详情” -->
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
  <!-- 紧急横幅：只在确有其事时占一行（额度中断、API 报错、压缩循环），完整内容在悬停提示和详情里 -->
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
