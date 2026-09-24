'use strict';
// 底部面板的页面脚本（DESIGN §11.13 做成终端面板那样；内容区 §8.2、§11.2–11.4、§11.7）。
// - 一个整体：一侧是会话列表（仿终端标签列表：listbox、22px 行、选中高亮、行尾按钮、窄条），另一块是内容区
//   （会话条 + 智能体表），中间是可拖动的分隔线。列表在哪边、宽度多少由扩展推来（list 消息），拖动后存回扩展。
// - 只渲染扩展算好的视图模型（lib/agents-view.js），不排序、不拼句子；文字要么已格式化，要么查注入的词典。
// - §11.3 硬性要求：按 key / 行 id 增量更新 DOM。已有行原地改文字（同一行始终是同一个元素），
//   新行按视图模型给的顺序插到规定位置；展开状态、焦点、滚动位置都保持。内容区换会话时才整表换掉。
// - 所有操作（选中、压缩、复制、打开文件）只 postMessage 会话 key / 行 id / 序号，由扩展重新查找数据后执行。
// - 宽度吸附、键盘移动、首字母跳转、增量同步的纯函数在 media/session-list.js（单测直接测它们）。
(function () {
  const vscode = acquireVsCodeApi();
  const LS = window.AgentMonitorList;
  const syncKeyed = LS.syncKeyed;

  // ---------- 词典（扩展注入的 JSON 数据块） ----------
  let dict = {};
  try { dict = (JSON.parse(document.getElementById('l10n').textContent) || {}).dict || {}; } catch (e) { dict = {}; }
  const t = (key, vars) => {
    const s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    return !vars ? s : s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] == null ? '' : vars[k]) : m));
  };

  // ---------- 持久状态：每个会话展开了哪些行、折叠了哪些工作流、滚到哪；会话列表的宽度 ----------
  const MAX_KEYS = 50;
  const saved = vscode.getState() || {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const state = {
    expanded: obj(saved.expanded), collapsed: obj(saved.collapsed), scroll: obj(saved.scroll),
    details: obj(saved.details), // 会话条“详情”展开了哪些会话（§11.14）
    listWidth: typeof saved.listWidth === 'number' && Number.isFinite(saved.listWidth) ? LS.snapWidth(saved.listWidth) : null,
  };
  const save = () => vscode.setState(state);
  const listOf = (bag, key) => (Array.isArray(bag[key]) ? bag[key] : []);
  function setIn(bag, key, id, on) {
    const list = listOf(bag, key).filter((x) => x !== id);
    if (on) list.push(id);
    delete bag[key]; // 重新插入 = 最近用过，超出上限时删最早的
    if (list.length) bag[key] = list;
    const keys = Object.keys(bag);
    if (keys.length > MAX_KEYS) for (const k of keys.slice(0, keys.length - MAX_KEYS)) delete bag[k];
    save();
  }

  // ---------- DOM 小工具：只在值真的变了时才写，免得打断选中文字、闪烁 ----------
  const $ = (id) => document.getElementById(id);
  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    if (kids) for (const c of kids) if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  }
  function txt(el, s) { s = s == null ? '' : String(s); if (el.textContent !== s) el.textContent = s; }
  function at(el, k, v) {
    if (v == null || v === false) { if (el.hasAttribute(k)) el.removeAttribute(k); return; }
    const s = v === true ? '' : String(v);
    if (el.getAttribute(k) !== s) el.setAttribute(k, s);
  }
  function cn(el, s) { if (el.className !== s) el.className = s; }
  function show(el, on) { if (el.hidden === !!on) el.hidden = !on; }

  // ---------- 元素 ----------
  const E = {
    app: $('app'), content: $('content'), sash: $('sash'), slist: $('slist'), box: $('sl-box'),
    empty: $('empty'), emptyActLine: $('empty-act-line'), emptyAct: $('empty-act'),
    sbar: $('sbar'), grid: $('grid'), rows: $('rows'), note: $('note'),
    lamp: $('s-lamp'), title: $('s-title'), meta: $('s-meta'), headCtx: $('s-headctx'), compact: $('s-compact'),
    badge: $('s-badge'), status: $('s-status'),
    urgent: $('s-urgent'), details: $('s-details'), more: $('s-more'), resumeBtn: $('s-resumebtn'),
    ctxline: $('s-ctxline'), meter: $('s-meter'), fill: $('s-fill'), ctx: $('s-ctx'), pct: $('s-pct'), remain: $('s-remain'), zone: $('s-zone'),
    acline: $('s-acline'), autocompact: $('s-autocompact'), compacts: $('s-compacts'), cache: $('s-cache'),
    costline: $('s-costline'), cost: $('s-cost'), today: $('s-today'),
    banners: $('s-banners'), resume: $('s-resume'),
    storeline: $('s-storeline'), path: $('s-path'), sizes: $('s-sizes'), reveal: $('s-reveal'), copypath: $('s-copypath'),
  };

  let vm = null;           // 最近一份视图模型
  let skew = 0;            // 扩展时钟 - 页面时钟（倒计时按扩展给的 now 走）
  let shownKey = null;     // 当前显示的会话
  let seq = 0;             // 细节面板 id 用
  const units = new Map(); // 行 id -> 单元（行 + 细节面板）

  const lampClass = (x) => `lamp codicon codicon-${x.shape || 'circle-large-outline'} lamp-${x.lamp || 'idle'}`;

  // ---------- 顶部会话条 ----------
  function renderBar(s) {
    cn(E.lamp, lampClass(s));
    txt(E.title, s.title);
    at(E.title, 'title', s.title);
    txt(E.meta, s.meta);
    at(E.meta, 'title', s.metaTip);
    show(E.compact, !!s.compactable);

    if (s.badge) cn(E.badge, `badge codicon codicon-${s.badge} lamp-${s.lamp}`);
    show(E.badge, !!s.badge);
    txt(E.status, s.statusText);
    // 窄面板下这一行会被省略号截断，悬停时先给完整的状态句
    at(E.status, 'title', [s.statusText, s.statusTip].filter(Boolean).join('\n') || null);
    E.status.classList.toggle('guess', !!s.guess);

    const c = s.context || {};
    show(E.meter, c.pct != null);
    if (c.pct != null) {
      const w = c.pct + '%';
      if (E.fill.style.width !== w) E.fill.style.width = w; // CSSOM 写样式不受 CSP 限制
      at(E.meter, 'aria-valuenow', c.pct);
      at(E.meter, 'aria-valuetext', c.ariaText);
    }
    txt(E.ctx, c.text);
    show(E.ctx, !!c.text);
    at(E.ctx, 'title', c.tip || null);
    // 标题行「压缩…」旁的“上下文 41%”（会话列表不再写这段）
    txt(E.headCtx, c.shortText);
    show(E.headCtx, !!c.shortText);
    at(E.headCtx, 'title', c.tip || null);
    show(E.ctxline, c.pct != null || !!c.pctText || !!c.remainText);
    // 占窗口的百分比、距自动压缩：各自成块，窄面板里整块换到下一行，不被省略号截掉
    txt(E.pct, c.pctText);
    show(E.pct, !!c.pctText);
    at(E.pct, 'title', c.tip || null);
    txt(E.remain, c.remainText);
    show(E.remain, !!c.remainText);
    at(E.remain, 'title', c.tip || null);
    show(E.zone, !!c.zone);
    if (c.zone) {
      cn(E.zone, 'chip zone-' + c.zone);
      cn(E.zone.firstElementChild, 'codicon codicon-' + (c.zone === 'act' ? 'warning' : 'info'));
      txt(E.zone.lastElementChild, c.zoneText);
      at(E.zone, 'title', c.zoneTip);
    }
    show(E.compacts, !!c.compactText);
    txt(E.compacts, c.compactText);
    at(E.compacts, 'title', c.compactTip || null);
    E.compacts.classList.toggle('tone-error', c.compactTone === 'error');
    updateCache();

    // 自动压缩：{值}（来源）▾（§11.9）；点了由扩展弹档位选择
    const ac = s.autoCompact;
    show(E.autocompact, !!ac);
    if (ac) {
      txt(E.autocompact.children[0], ac.text);
      txt(E.autocompact.children[1], ac.detailText);
      show(E.autocompact.children[1], !!ac.detailText);
      at(E.autocompact, 'title', ac.tip || null);
    }
    show(E.acline, !!ac || !!c.compactText); // 缓存倒计时在摘要行

    // 记录位置（§11.11）：路径、大小、在文件管理器中显示、复制路径
    const st = s.storage;
    show(E.storeline, !!st);
    if (st) {
      txt(E.path, st.pathText);
      at(E.path, 'title', st.pathTip || null);
      txt(E.sizes, st.sizesText);
      show(E.sizes, !!st.sizesText);
      at(E.sizes, 'title', st.sizesTip || null);
      txt(E.reveal.children[1], st.revealText);
      at(E.reveal, 'title', st.revealText);
      txt(E.copypath.children[1], st.copyText);
      at(E.copypath, 'title', st.copyText);
    }

    txt(E.cost, s.costText);
    txt(E.today, s.todayText);
    show(E.cost, !!s.costText);
    show(E.today, !!s.todayText);
    at(E.cost, 'title', s.costTip || null);
    at(E.today, 'title', s.todayTip || null);
    show(E.costline, !!s.todayText); // 本会话费用在摘要行，今日合计在详情

    // 额度、报错、提示横幅：文字可以换行，不截断
    syncKeyed(E.banners, s.banners || [], (b) => b.id, () => h('div', { class: 'banner', role: 'note' }, [
      h('i', { class: 'codicon', 'aria-hidden': 'true' }), h('span', { class: 'b-body' }, [h('span', { class: 'b-text' }), h('span', { class: 'b-detail' })]),
    ]), (node, b) => {
      cn(node, 'banner b-' + b.tone);
      cn(node.children[0], 'codicon codicon-' + b.icon);
      const body = node.children[1];
      txt(body.children[0], b.text);
      txt(body.children[1], b.detail);
      show(body.children[1], !!b.detail);
      at(node, 'title', b.tip || null);
    });

    // 续跑提示：一条一行（名字 + 复制按钮 + 代价说明），放不下时说明折到下一行
    const resume = s.resume || [];
    show(E.resume, resume.length > 0);
    syncKeyed(E.resume, resume, (r) => r.index + '|' + r.label, () => h('li', { class: 'r-item' }, [
      h('i', { class: 'codicon codicon-history', 'aria-hidden': 'true' }), h('span', { class: 'r-label' }),
      h('span', { class: 'r-btns' }), h('span', { class: 'r-info' }),
    ]), (node, r) => {
      txt(node.children[1], r.label);
      syncKeyed(node.children[2], r.buttons || [], (b) => b.variant, (b) => h('button', {
        type: 'button', class: 'btn secondary', 'data-act': 'resume',
      }, [h('i', { class: 'codicon codicon-copy', 'aria-hidden': 'true' }), h('span')]), (btn, b) => {
        btn.dataset.index = String(r.index);
        btn.dataset.variant = b.variant;
        txt(btn.children[1], b.label);
        at(btn, 'title', b.tip);
      });
      txt(node.children[3], r.infoText);
      at(node.children[3], 'title', r.infoText || null);
      show(node.children[3], !!r.infoText);
    });

    // 紧急横幅（§11.14）：报错 / 警告类横幅和压缩循环，只占一行；完整内容在悬停提示和详情里
    const urgent = (s.banners || []).filter((b) => b.tone === 'error' || b.tone === 'warning')
      .map((b) => ({ tone: b.tone, icon: b.icon, text: [b.text, b.detail].filter(Boolean).join(' · ') }));
    if (c.compactTone === 'error' && c.compactText) urgent.push({ tone: 'error', icon: 'sync', text: c.compactText });
    show(E.urgent, urgent.length > 0);
    if (urgent.length) {
      const u0 = urgent[0];
      cn(E.urgent, 's-line s-urgent u-' + u0.tone);
      cn(E.urgent.children[0], 'codicon codicon-' + u0.icon);
      txt(E.urgent.children[1], urgent.length > 1 ? u0.text + ' (+' + (urgent.length - 1) + ')' : u0.text);
      at(E.urgent, 'title', urgent.map((x) => x.text).join('\n'));
    }
    show(E.resumeBtn, resume.length > 0);
    applyDetails();
  }

  // “详情”折叠区：默认收起，按会话记住（§11.14）
  function applyDetails() {
    const open = !!(shownKey && state.details[shownKey]);
    show(E.details, open);
    at(E.more, 'aria-expanded', String(open));
    cn(E.more.children[1], 'codicon codicon-chevron-' + (open ? 'down' : 'right'));
  }
  function setDetails(open) {
    if (!shownKey) return;
    delete state.details[shownKey];
    if (open) state.details[shownKey] = true;
    const keys = Object.keys(state.details);
    if (keys.length > MAX_KEYS) for (const k of keys.slice(0, keys.length - MAX_KEYS)) delete state.details[k];
    save();
    applyDetails();
  }

  // 面板矮（< 400px）时藏起费用、用时两列，先保“名称 · 状态 · 当前步骤 · 上下文”（§11.14）
  function applyShort() { document.body.classList.toggle('short', window.innerHeight < 400); }
  applyShort();
  window.addEventListener('resize', applyShort);

  // 缓存倒计时：用 cacheExpiresMs 自己每 30 秒刷新这一处（§11.7），不动表格
  function updateCache() {
    const c = vm && vm.session && vm.session.cache;
    show(E.cache, !!c);
    if (!c) return;
    const left = c.expiresMs - (Date.now() + skew);
    txt(E.cache, left <= 0 ? t('session.cacheExpired') : t('session.cacheLeft', { m: Math.max(1, Math.ceil(left / 60000)) }));
    E.cache.classList.toggle('expired', left <= 0);
  }
  setInterval(updateCache, 30000);

  // ---------- 表格行 ----------
  function makeUnit(r) {
    const u = { id: r.id, detailOpen: false, detail: null };
    u.el = h('div', { class: 'unit', role: 'none' });
    u.el.dataset.id = r.id;
    u.twisty = h('button', { type: 'button', class: 'twisty codicon codicon-chevron-right', 'data-act': 'toggle' });
    u.lamp = h('i', { class: 'lamp codicon', 'aria-hidden': 'true' });
    u.name = h('span', { class: 'name' });
    u.sub = h('span', { class: 'sub' });
    u.badge = h('i', { class: 'badge codicon', 'aria-hidden': 'true' });
    u.lampText = h('span', { class: 'sr-only' });
    u.status = h('span', { class: 'st' });
    u.step = h('div', { class: 'cell c-step', role: 'cell' });
    u.tok = h('div', { class: 'cell c-tok num', role: 'cell' });
    u.cost = h('div', { class: 'cell c-cost num', role: 'cell' });
    u.time = h('div', { class: 'cell c-time num', role: 'cell' });
    // 宽面板：各格按 CSS 指定的列排成一行；窄面板：c-line2 变成第二行（步骤 + token + 费用 + 用时），
    // 第一行只放名字和状态，状态句（例如“等你批准”）不被截断
    u.row = h('div', { class: 'row', role: 'row' }, [
      h('div', { class: 'cell c-name', role: 'cell' }, [u.twisty, u.lamp, h('span', { class: 'names' }, [u.name, u.sub])]),
      h('div', { class: 'cell c-status', role: 'cell' }, [u.badge, u.lampText, u.status]),
      h('div', { class: 'c-line2', role: 'none' }, [u.step, u.tok, u.cost, u.time]),
    ]);
    u.el.appendChild(u.row);
    u.el._unit = u;
    return u.el;
  }

  function updateUnit(el, r) {
    const u = el._unit;
    u.data = r;
    const isWf = r.kind === 'workflow';
    cn(u.row, `row lv${r.depth} k-${r.kind} lamp-${r.lamp}${r.guess ? ' guess' : ''}`);
    at(u.row, 'title', r.tip);
    cn(u.lamp, lampClass(r));
    txt(u.name, r.name);
    txt(u.sub, r.sub);
    show(u.sub, !!r.sub);
    cn(u.badge, r.badge ? `badge codicon codicon-${r.badge} lamp-${r.lamp}` : 'badge codicon');
    show(u.badge, !!r.badge);
    txt(u.lampText, r.lampText);
    txt(u.status, r.statusText);
    u.status.classList.toggle('muted', r.lamp === 'doneSeen' || r.lamp === 'idle');
    txt(u.step, r.stepText);
    txt(u.tok, r.tokensText);
    txt(u.cost, r.costText);
    at(u.cost, 'title', r.costTip || null);
    txt(u.time, r.durText);

    // 折叠按钮：智能体行 = 展开细节；工作流行 = 折叠组内智能体
    const open = isWf ? !isCollapsed(r.id) : isExpanded(r.id);
    cn(u.twisty, 'twisty codicon codicon-chevron-' + (open ? 'down' : 'right'));
    at(u.twisty, 'aria-expanded', String(open));
    at(u.twisty, 'aria-label', t(isWf ? (open ? 'webview.group.collapse' : 'webview.group.expand') : (open ? 'webview.collapse' : 'webview.expand'), { name: r.name }));
    at(u.row, 'aria-expanded', isWf || r.expandable ? String(open) : null);
    if (!isWf) setDetail(u, open);
    // 所在工作流被折叠时藏起来（不删，节点身份不变）
    show(el, !(r.parentId && isCollapsed(r.parentId)));
  }

  const isExpanded = (id) => listOf(state.expanded, shownKey).includes(id);
  const isCollapsed = (id) => listOf(state.collapsed, shownKey).includes(id);

  // ---------- 细节面板（最近几步、结果、改过的文件、报错） ----------
  function makeDetail(u) {
    const id = 'd' + (++seq);
    const d = { id };
    d.open = h('button', { type: 'button', class: 'link', 'data-act': 'openTranscript' }, [
      h('i', { class: 'codicon codicon-go-to-file', 'aria-hidden': 'true' }), h('span', null, [t('webview.openTranscript')]),
    ]);
    d.counts = h('span', { class: 'd-counts muted' });
    d.loading = h('p', { class: 'd-loading muted' }, [t('webview.detail.loading')]);
    d.tl = h('ol', { class: 'tl' });
    d.tlEmpty = h('p', { class: 'muted' }, [t('webview.noSteps')]);
    d.result = h('pre', { class: 'result', tabindex: '0' });
    d.resultEmpty = h('p', { class: 'muted' }, [t('webview.noResult')]);
    d.trunc = h('p', { class: 'muted trunc' }, [t('webview.result.truncated')]);
    d.copy = h('button', { type: 'button', class: 'link', 'data-act': 'copyResult' }, [
      h('i', { class: 'codicon codicon-copy', 'aria-hidden': 'true' }), h('span', null, [t('webview.copyResult')]),
    ]);
    d.files = h('ul', { class: 'files' });
    d.errs = h('ul', { class: 'errs' });
    const sec = (cls, title, extra, kids) => h('section', { class: 'd-sec ' + cls }, [h('h4', { class: 'd-title' }, [h('span', null, [title]), extra]), ...kids]);
    d.secFiles = sec('s-files', t('webview.files'), null, [d.files]);
    d.secErrs = sec('s-errs', t('webview.errors'), null, [d.errs]);
    d.body = h('div', { class: 'd-cols' }, [
      sec('s-tl', t('webview.timeline'), null, [d.tl, d.tlEmpty]),
      sec('s-res', t('webview.result'), d.copy, [d.result, d.trunc, d.resultEmpty]),
      d.secFiles,
      d.secErrs,
    ]);
    d.el = h('div', { class: 'detail', role: 'row', id }, [
      h('div', { class: 'd-inner', role: 'cell' }, [h('div', { class: 'd-head' }, [d.open, d.counts]), d.loading, d.body]),
    ]);
    u.el.appendChild(d.el);
    at(u.twisty, 'aria-controls', id);
    return d;
  }

  function setDetail(u, open) {
    if (!open) { if (u.detail) show(u.detail.el, false); return; }
    if (!u.detail) u.detail = makeDetail(u);
    const d = u.detail;
    show(d.el, true);
    const dv = vm && vm.detail ? vm.detail[u.id] : null;
    show(d.loading, !dv || !dv.loaded);
    show(d.body, !!(dv && dv.loaded));
    show(d.open, !!(dv && dv.canOpen));
    txt(d.counts, dv ? dv.countsText : '');
    if (!dv || !dv.loaded) return;

    syncKeyed(d.tl, dv.timeline, (x, i) => String(i), () => h('li', null, [
      h('span', { class: 'ago muted' }), h('i', { class: 'codicon', 'aria-hidden': 'true' }), h('span', { class: 'tl-text' }),
    ]), (li, x) => {
      txt(li.children[0], x.ago);
      cn(li.children[1], 'codicon codicon-' + x.icon + (x.tone ? ' tone-' + x.tone : ''));
      txt(li.children[2], x.text);
      at(li.children[2], 'title', x.text);
    });
    show(d.tl, dv.timeline.length > 0);
    show(d.tlEmpty, dv.timeline.length === 0);

    const res = dv.result;
    if (res) txt(d.result, res.text); // 只在变了时写，结果框的滚动位置不丢
    show(d.result, !!res);
    show(d.copy, !!res);
    show(d.trunc, !!(res && res.truncated));
    show(d.resultEmpty, !res);

    syncKeyed(d.files, dv.files, (f) => f.path, (f) => h('li', null, [
      h('button', { type: 'button', class: 'link file', 'data-act': 'openFile' }, [
        h('i', { class: 'codicon', 'aria-hidden': 'true' }), h('span', { class: 'f-base' }), h('span', { class: 'f-dir muted' }),
      ]),
      h('span', { class: 'f-op muted' }),
    ]), (li, f) => {
      const b = li.children[0];
      b.dataset.path = f.path;
      at(b, 'title', t('webview.openFile', { path: f.path }));
      cn(b.children[0], 'codicon codicon-' + f.icon);
      txt(b.children[1], f.base);
      txt(b.children[2], f.dir);
      show(b.children[2], !!f.dir);
      txt(li.children[1], f.opText);
    });
    show(d.secFiles, dv.files.length > 0);

    syncKeyed(d.errs, dv.errors, (x, i) => String(i), () => h('li', null, [
      h('span', { class: 'ago muted' }), h('i', { class: 'codicon codicon-error tone-error', 'aria-hidden': 'true' }),
      h('span', { class: 'e-tool' }), h('span', { class: 'e-text' }),
    ]), (li, x) => {
      txt(li.children[0], x.ago);
      txt(li.children[2], x.tool);
      show(li.children[2], !!x.tool);
      txt(li.children[3], x.text);
      at(li.children[3], 'title', x.text);
    });
    show(d.secErrs, dv.errors.length > 0);
  }

  // ---------- 内容区整体渲染 ----------
  function render(m) {
    vm = m;
    if (typeof m.now === 'number') skew = m.now - Date.now();
    document.body.classList.toggle('no-cost', !m.showCost);
    if (!m.session) {
      rememberScroll();
      shownKey = null;
      units.clear();
      E.rows.replaceChildren();
      txt(E.empty, m.emptyText);
      show(E.empty, true);
      // 只看工作区而工作区里没有会话：给“显示所有会话”
      const ea = m.emptyAction;
      show(E.emptyActLine, !!ea);
      if (ea) txt(E.emptyAct, ea.text);
      show(E.sbar, false);
      show(E.grid, false);
      show(E.note, false);
      return;
    }
    let switched = false;
    if (m.sessionKey !== shownKey) {
      // 换会话：整表换掉（不同会话的行本来就不是同一批），记住旧会话滚到哪
      rememberScroll();
      shownKey = m.sessionKey;
      units.clear();
      E.rows.replaceChildren();
      switched = true;
    }
    show(E.empty, false);
    show(E.emptyActLine, false);
    show(E.sbar, true);
    show(E.grid, true);
    renderBar(m.session);
    syncKeyed(E.rows, m.rows, (r) => r.id, (r) => {
      const el = makeUnit(r);
      units.set(r.id, el._unit);
      return el;
    }, updateUnit);
    for (const id of Array.from(units.keys())) if (!m.rows.some((r) => r.id === id)) units.delete(id);
    txt(E.note, m.note);
    show(E.note, !!m.note);
    if (switched) E.content.scrollTop = Number(state.scroll[shownKey]) || 0;
  }

  // 内容区自己滚动（列表和内容各滚各的，像终端）；记住每个会话滚到哪
  function rememberScroll() {
    if (!shownKey) return;
    const y = Math.round(E.content.scrollTop);
    if ((Number(state.scroll[shownKey]) || 0) === y) return;
    delete state.scroll[shownKey];
    if (y > 0) state.scroll[shownKey] = y;
    const keys = Object.keys(state.scroll);
    if (keys.length > MAX_KEYS) for (const k of keys.slice(0, keys.length - MAX_KEYS)) delete state.scroll[k];
    save();
  }
  let scrollTimer = 0;
  E.content.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(rememberScroll, 300);
  }, { passive: true });

  // ---------- 会话列表（§11.13，仿终端标签列表） ----------
  let listSel = null;       // 扩展推来的选中
  let pendingSel = null;    // { key, until }：页面刚点的，等扩展确认（期间不被旧消息改回去）
  let focusKey = null;      // 键盘焦点所在行（aria-activedescendant）
  let position = 'right';  // 和 HTML 里的初始排法一致（内容、分隔线、列表）
  let savedWidth = state.listWidth; // 页面记着的宽度优先；没有时用扩展存的（globalState）
  let dragging = false;
  let dragW = null;
  let typed = '';
  let typedAt = 0;
  let optSeq = 0;
  let rowEls = new Map();   // key -> 行元素

  const currentSel = () => (pendingSel ? pendingSel.key : listSel);
  const sessionRows = () => Array.from(E.box.children).filter((el) => el._data && el._data.kind === 'session');

  function makeGroup() {
    return h('div', { class: 'sl-group', 'aria-hidden': 'true' }, [h('span', { class: 'sl-gtext' }), h('span', { class: 'sl-count' })]);
  }
  function updateGroup(el, it) {
    el._data = it;
    txt(el.children[0], it.text);
    txt(el.children[1], it.count);
  }

  function makeRow() {
    const act = (name, icon, label) => h('button', {
      type: 'button', class: 'sl-act', 'data-act': name, tabindex: '-1', title: label, 'aria-label': label,
    }, [h('i', { class: 'codicon codicon-' + icon, 'aria-hidden': 'true' })]);
    const el = h('div', { class: 'sl-row', role: 'option', id: 'sl-o' + (++optSeq), 'aria-selected': 'false' }, [
      h('i', { class: 'lamp codicon', 'aria-hidden': 'true' }),
      h('span', { class: 'sl-title' }),
      h('span', { class: 'sl-desc' }),
      h('span', { class: 'sl-acts' }, [
        act('rowCompact', 'screen-normal', t('webview.compact')),
        act('rowMore', 'ellipsis', t('webview.list.more')),
      ]),
    ]);
    // 鼠标离开后再换上悬停期间攒下的新提示
    el.addEventListener('mouseleave', () => {
      if (el._tip == null) return;
      at(el, 'title', el._tip);
      el._tip = null;
    });
    return el;
  }
  function updateRow(el, it) {
    el._data = it;
    cn(el.children[0], lampClass(it));
    txt(el.children[1], it.title);
    txt(el.children[2], it.desc);
    // 悬停提示（窄条模式下名字也在这里）：没有逐秒变化的内容，但会跟着状态、token 更新。
    // 鼠标正停在这一行上时先不改（改了会把正在看的提示关掉），离开后再换——和原生树悬停时现算的效果一样
    if (el.matches(':hover') && el.getAttribute('title') !== it.tip) el._tip = it.tip;
    else { el._tip = null; at(el, 'title', it.tip); }
    at(el, 'aria-label', it.a11y);
    // VS Code 的 webview 右键菜单读这个属性（webviewSection / sessionKey / compactable / resumable）
    at(el, 'data-vscode-context', it.context);
    show(el.children[3].children[0], !!it.compactable);
    paintRow(el);
  }
  function paintRow(el) {
    const key = el._data.key;
    const sel = key === currentSel();
    el.classList.toggle('selected', sel);
    at(el, 'aria-selected', sel ? 'true' : 'false');
    el.classList.toggle('focused', key === focusKey);
  }
  function paintAll() {
    for (const el of rowEls.values()) paintRow(el);
    const f = rowEls.get(focusKey);
    at(E.box, 'aria-activedescendant', f ? f.id : null);
  }

  // 让某一行露出来（只滚列表自己，不动整页）
  function reveal(el) {
    if (!el) return;
    const box = E.slist;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  }

  // 左 = 列表、分隔线、内容；右 = 内容、分隔线、列表。DOM 顺序和看到的一致，Tab 顺序也就跟着对
  function applyPosition(pos) {
    const p = pos === 'left' ? 'left' : 'right';
    if (p === position) return;
    position = p;
    E.app.classList.toggle('list-left', p === 'left');
    E.app.classList.toggle('list-right', p === 'right');
    if (p === 'left') {
      E.app.insertBefore(E.slist, E.app.firstChild);
      E.app.insertBefore(E.sash, E.content);
    } else {
      E.app.appendChild(E.sash);
      E.app.appendChild(E.slist);
    }
  }

  // 实际宽度：面板窄于 500 自动窄条；< 80 收成 46 的窄条（只有图标，名字在悬停提示里）；给内容区留出地方
  function applyWidth(raw) {
    const panel = window.innerWidth || document.documentElement.clientWidth;
    const eff = LS.effectiveWidth(raw != null ? raw : savedWidth, panel);
    const w = eff.width + 'px';
    if (E.slist.style.width !== w) E.slist.style.width = w; // CSSOM 写样式不受 CSP 限制
    E.slist.classList.toggle('narrow', eff.narrow);
    E.app.classList.toggle('auto-narrow', eff.auto);
    return eff;
  }

  function saveWidth(w) {
    savedWidth = LS.snapWidth(w);
    state.listWidth = savedWidth;
    save();
    applyWidth();
    vscode.postMessage({ type: 'resizeList', width: savedWidth });
  }

  function renderList(m) {
    applyPosition(m.position);
    if (savedWidth == null) savedWidth = LS.snapWidth(m.width);
    if (!dragging) applyWidth();
    const before = currentSel();
    listSel = m.selectedKey || null;
    // 扩展确认了刚点的那一行，或者等太久：以扩展的为准
    if (pendingSel && (pendingSel.key === listSel || Date.now() > pendingSel.until)) pendingSel = null;
    const items = Array.isArray(m.items) ? m.items : [];
    syncKeyed(E.box, items,
      (it) => (it.kind === 'group' ? it.id : 's:' + it.key),
      (it) => (it.kind === 'group' ? makeGroup(it) : makeRow(it)),
      (el, it) => (it.kind === 'group' ? updateGroup(el, it) : updateRow(el, it)));
    rowEls = new Map(sessionRows().map((el) => [el._data.key, el]));
    if (focusKey && !rowEls.has(focusKey)) focusKey = null;
    paintAll();
    // 选中被扩展换了（切到别的对话标签时跟随）：让它露出来
    const after = currentSel();
    if (after && after !== before) reveal(rowEls.get(after));
  }

  // 用户选中：先在页面上标出来，再告诉扩展（扩展记已看过、换内容区、发 focus）
  function choose(key) {
    if (!key || !rowEls.has(key)) return;
    pendingSel = { key, until: Date.now() + 1500 };
    focusKey = key;
    paintAll();
    vscode.postMessage({ type: 'select', sessionKey: key });
  }

  function setFocus(key) {
    focusKey = key;
    paintAll();
    reveal(rowEls.get(key));
  }

  // 键盘：↑ ↓ Home End PageUp PageDown 移动焦点，Enter / 空格选中，Shift+F10 / 菜单键打开“…”，打字按标题首字母跳转
  E.box.addEventListener('keydown', (e) => {
    const rows = sessionRows();
    if (!rows.length) return;
    const keys = rows.map((el) => el._data.key);
    const cur = keys.indexOf(focusKey != null ? focusKey : currentSel());
    if (e.key === 'Enter' || e.key === ' ') {
      if (cur >= 0) { e.preventDefault(); choose(keys[cur]); }
      return;
    }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      if (cur >= 0) { e.preventDefault(); vscode.postMessage({ type: 'more', sessionKey: keys[cur] }); }
      return;
    }
    const page = Math.max(1, Math.floor(E.slist.clientHeight / 22) - 1);
    const next = LS.moveIndex(e.key, cur, keys.length, page);
    if (next >= 0) {
      e.preventDefault();
      setFocus(keys[next]);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typed = now - typedAt < 800 ? typed + e.key : e.key;
      typedAt = now;
      const j = LS.typeAhead(rows.map((el) => el._data.title), cur, typed);
      if (j >= 0) { e.preventDefault(); setFocus(keys[j]); }
    }
  });
  // Tab 进到列表：焦点落在选中的那一行（没有就第一行）
  E.box.addEventListener('focus', () => {
    if (!focusKey || !rowEls.has(focusKey)) {
      const first = sessionRows()[0];
      focusKey = currentSel() || (first ? first._data.key : null);
    }
    paintAll();
  });
  // 行尾按钮不抢焦点（列表保持“有焦点”的选中色）
  E.box.addEventListener('mousedown', (e) => { if (e.target.closest('.sl-act')) e.preventDefault(); });
  // 右键：焦点跟到这一行（不改选中；菜单由 VS Code 按 data-vscode-context 弹出，这里不 preventDefault）
  E.box.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.sl-row');
    if (row && row._data) { focusKey = row._data.key; paintAll(); }
  });

  // 分隔线：拖动改宽度（按终端的规则吸附），双击复位；面板太窄自动窄条时不能拖
  E.sash.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || E.app.classList.contains('auto-narrow')) return;
    e.preventDefault();
    dragging = true;
    dragW = null;
    try { E.sash.setPointerCapture(e.pointerId); } catch (err) { /* 没有捕获也能拖 */ }
    E.app.classList.add('resizing');
  });
  E.sash.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const panel = window.innerWidth || document.documentElement.clientWidth;
    const eff = applyWidth(LS.snapWidth(LS.dragWidth(position, e.clientX, panel)));
    dragW = eff.width;
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    E.app.classList.remove('resizing');
    if (dragW != null) saveWidth(dragW);
    dragW = null;
  };
  E.sash.addEventListener('pointerup', endDrag);
  E.sash.addEventListener('pointercancel', endDrag);
  E.sash.addEventListener('lostpointercapture', endDrag);
  E.sash.addEventListener('dblclick', () => saveWidth(LS.WIDTH.DEFAULT));
  window.addEventListener('resize', () => { if (!dragging) applyWidth(); });

  // ---------- 交互 ----------
  function toggle(u) {
    if (!u || !u.data) return;
    const r = u.data;
    if (r.kind === 'workflow') {
      setIn(state.collapsed, shownKey, r.id, !isCollapsed(r.id));
      for (const x of units.values()) if (x.data) updateUnit(x.el, x.data); // 组内行跟着显示/隐藏
      return;
    }
    const open = !isExpanded(r.id);
    setIn(state.expanded, shownKey, r.id, open);
    updateUnit(u.el, r);
    vscode.postMessage({ type: 'expand', sessionKey: shownKey, rowId: r.id, open });
  }

  const unitOf = (target) => {
    const el = target.closest('.unit');
    return el && el._unit ? el._unit : null;
  };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const act = btn && btn.dataset.act;
    const key = shownKey;
    // 列表行尾的按钮：压缩、“…”（扩展弹出与右键菜单同样内容的 QuickPick）；不改选中
    if (act === 'rowCompact' || act === 'rowMore') {
      const row = btn.closest('.sl-row');
      if (row && row._data) vscode.postMessage({ type: act === 'rowCompact' ? 'compact' : 'more', sessionKey: row._data.key });
      return;
    }
    const srow = e.target.closest('.sl-row');
    if (srow && srow._data) { choose(srow._data.key); return; }
    if (act === 'emptyAction') { if (vm && vm.emptyAction) vscode.postMessage({ type: vm.emptyAction.act }); return; }
    if (act === 'toggle') { toggle(unitOf(btn)); return; }
    if (act === 'toggleDetails') { setDetails(!(shownKey && state.details[shownKey])); return; }
    if (act === 'showResume') { setDetails(true); E.resume.scrollIntoView({ block: 'nearest' }); return; }
    if (act === 'compact' || btn === E.compact) { if (key) vscode.postMessage({ type: 'compact', sessionKey: key }); return; }
    if (act === 'setAutoCompact' || act === 'revealTranscript' || act === 'copyTranscriptPath') {
      if (key) vscode.postMessage({ type: act, sessionKey: key });
      return;
    }
    if (act === 'resume') {
      vscode.postMessage({ type: 'copyResume', sessionKey: key, hintIndex: Number(btn.dataset.index), variant: btn.dataset.variant });
      return;
    }
    if (act === 'copyResult' || act === 'openTranscript' || act === 'openFile') {
      const u = unitOf(btn);
      if (!u) return;
      const m = { type: act, sessionKey: key, rowId: u.id };
      if (act === 'openFile') m.path = btn.dataset.path;
      vscode.postMessage(m);
      return;
    }
    if (btn) return;
    // 点行的其它地方也能展开 / 折叠（和原生树一样）；拖选文字、点在细节面板里不算
    const row = e.target.closest('.row');
    if (!row || row.classList.contains('head') || String(window.getSelection() || '')) return;
    toggle(unitOf(row));
  });

  // 折叠按钮上 ←/→ 折叠 / 展开（Enter、空格由 button 自带）
  document.addEventListener('keydown', (e) => {
    const tw = e.target;
    if (!tw.classList || !tw.classList.contains('twisty')) return;
    const open = tw.getAttribute('aria-expanded') === 'true';
    if ((e.key === 'ArrowLeft' && open) || (e.key === 'ArrowRight' && !open)) {
      e.preventDefault();
      toggle(unitOf(tw));
    }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'render') render(m);
    else if (m.type === 'list') renderList(m);
  });
  applyWidth(); // 第一份列表消息到来前先按记着的宽度（或默认 200）排好，免得跳
  const ready = { type: 'ready', expanded: state.expanded };
  if (state.listWidth != null) ready.listWidth = state.listWidth;
  vscode.postMessage(ready);
})();
