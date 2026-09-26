'use strict';
// Page script for the bottom panel, laid out like VS Code's terminal panel.
// - One layout: one side is the session list (modeled on the terminal tab list: listbox, 22px rows, selection highlight,
//   row-end buttons, narrow strip), the other is the content area (session bar + agent table), with a draggable sash between them.
//   Which side the list is on and its width are pushed by the extension (list message); after dragging, the width is saved back to the extension.
// - Only renders the view model computed by the extension (lib/agents-view.js); never sorts or builds sentences. Text is either preformatted or looked up in the injected dictionary.
// - Hard requirement: update the DOM incrementally by key / row id. Existing rows get their text changed in place (the same row is always the same element);
//   new rows are inserted at the position given by the view model; expanded state, focus and scroll position are all kept. The whole table is replaced only when the content area switches sessions.
// - Every action (select, compact, copy, open file) only posts the session key / row id / index; the extension looks up the data again and performs it.
// - Pure functions for width snapping, keyboard navigation, type-to-jump and incremental sync live in media/session-list.js (unit-tested directly).
(function () {
  const vscode = acquireVsCodeApi();
  const LS = window.AgentMonitorList;
  const syncKeyed = LS.syncKeyed;

  // ---------- Dictionary (JSON data block injected by the extension) ----------
  let dict = {};
  try { dict = (JSON.parse(document.getElementById('l10n').textContent) || {}).dict || {}; } catch (e) { dict = {}; }
  const t = (key, vars) => {
    const s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    return !vars ? s : s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] == null ? '' : vars[k]) : m));
  };

  // ---------- Persistent state: expanded rows, collapsed workflows and scroll position per session; session list width ----------
  const MAX_KEYS = 50;
  const saved = vscode.getState() || {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const state = {
    expanded: obj(saved.expanded), collapsed: obj(saved.collapsed), scroll: obj(saved.scroll),
    details: obj(saved.details), // sessions whose "Details" section in the session bar is expanded
    listWidth: typeof saved.listWidth === 'number' && Number.isFinite(saved.listWidth) ? LS.snapWidth(saved.listWidth) : null,
  };
  const save = () => vscode.setState(state);
  const listOf = (bag, key) => (Array.isArray(bag[key]) ? bag[key] : []);
  function setIn(bag, key, id, on) {
    const list = listOf(bag, key).filter((x) => x !== id);
    if (on) list.push(id);
    delete bag[key]; // re-inserting = most recently used; the oldest is dropped when over the limit
    if (list.length) bag[key] = list;
    const keys = Object.keys(bag);
    if (keys.length > MAX_KEYS) for (const k of keys.slice(0, keys.length - MAX_KEYS)) delete bag[k];
    save();
  }

  // ---------- DOM helpers: write only when the value actually changed, to avoid disrupting text selection or flickering ----------
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

  // ---------- Elements ----------
  const E = {
    app: $('app'), content: $('content'), sash: $('sash'), slist: $('slist'), box: $('sl-box'),
    empty: $('empty'), emptyActLine: $('empty-act-line'), emptyAct: $('empty-act'),
    sbar: $('sbar'), grid: $('grid'), rows: $('rows'), note: $('note'),
    lamp: $('s-lamp'), title: $('s-title'), meta: $('s-meta'), headCtx: $('s-headctx'), compact: $('s-compact'), goto: $('s-goto'),
    badge: $('s-badge'), status: $('s-status'),
    urgent: $('s-urgent'), details: $('s-details'), more: $('s-more'), resumeBtn: $('s-resumebtn'),
    ctxline: $('s-ctxline'), meter: $('s-meter'), fill: $('s-fill'), ctx: $('s-ctx'), pct: $('s-pct'), remain: $('s-remain'), zone: $('s-zone'),
    acline: $('s-acline'), autocompact: $('s-autocompact'), compacts: $('s-compacts'), cache: $('s-cache'),
    costline: $('s-costline'), cost: $('s-cost'), today: $('s-today'),
    banners: $('s-banners'), resume: $('s-resume'),
    storeline: $('s-storeline'), path: $('s-path'), sizes: $('s-sizes'), reveal: $('s-reveal'), copypath: $('s-copypath'),
    costHead: document.querySelector('.row.head .c-cost'),
  };

  // Auto-resume block in "Details", right after the resume hints (Claude Code chats only; hidden while vm.session.autoResume is null).
  // Built here because the static HTML comes from lib/webview-html.js; every text in it comes preformatted from the view model.
  // The heading is the group's accessible name only: the project line already reads "Auto-resume is on for <project>".
  const AR = {};
  {
    const btn = (act, icon) => h('button', { type: 'button', class: 'btn secondary', 'data-act': act }, [
      h('i', { class: 'codicon codicon-' + icon, 'aria-hidden': 'true' }), h('span'),
    ]);
    AR.project = h('span', { class: 'ar-project' });
    AR.toggle = h('button', { type: 'button', class: 'link ar-toggle', 'data-act': 'autoResumeProject' }, [h('span')]);
    AR.icon = h('i', { class: 'codicon', 'aria-hidden': 'true' });
    AR.plan = h('span', { class: 'ar-plan' });
    AR.now = btn('autoResumeNow', 'debug-continue');
    AR.cancel = btn('autoResumeCancel', 'close');
    AR.planLine = h('div', { class: 'ar-line ar-planline' }, [AR.icon, AR.plan, h('span', { class: 'ar-btns' }, [AR.now, AR.cancel])]);
    AR.note = h('p', { class: 'ar-note muted' });
    AR.el = h('div', { id: 's-ar', class: 'ar', role: 'group', hidden: '' }, [
      h('div', { class: 'ar-line ar-head' }, [h('i', { class: 'codicon codicon-sync', 'aria-hidden': 'true' }), AR.project, AR.toggle]),
      AR.planLine, AR.note,
    ]);
    E.resume.parentNode.insertBefore(AR.el, E.resume.nextSibling);
  }

  let vm = null;           // latest view model
  let skew = 0;            // extension clock - page clock (countdowns follow the now given by the extension)
  let shownKey = null;     // session currently shown
  let seq = 0;             // for detail panel ids
  const units = new Map(); // row id -> unit (row + detail panel)

  const lampClass = (x) => `lamp codicon codicon-${x.shape || 'circle-large-outline'} lamp-${x.lamp || 'idle'}`;

  // ---------- Session bar at the top ----------
  function renderBar(s) {
    cn(E.lamp, lampClass(s));
    txt(E.title, s.title);
    at(E.title, 'title', s.title);
    txt(E.meta, s.meta);
    at(E.meta, 'title', s.metaTip);
    show(E.compact, !!s.compactable);
    show(E.goto, !!s.goTo);

    if (s.badge) cn(E.badge, `badge codicon codicon-${s.badge} lamp-${s.lamp}`);
    show(E.badge, !!s.badge);
    txt(E.status, s.statusText);
    // In a narrow panel this line gets truncated with an ellipsis, so show the full status sentence on hover
    at(E.status, 'title', [s.statusText, s.statusTip].filter(Boolean).join('\n') || null);
    E.status.classList.toggle('guess', !!s.guess);

    const c = s.context || {};
    show(E.meter, c.pct != null);
    if (c.pct != null) {
      const w = c.pct + '%';
      if (E.fill.style.width !== w) E.fill.style.width = w; // setting styles via CSSOM is not restricted by the CSP
      at(E.meter, 'aria-valuenow', c.pct);
      at(E.meter, 'aria-valuetext', c.ariaText);
    }
    txt(E.ctx, c.text);
    show(E.ctx, !!c.text);
    at(E.ctx, 'title', c.tip || null);
    // "41% context" next to "Compact…" in the title line (the session list no longer shows this)
    txt(E.headCtx, c.shortText);
    show(E.headCtx, !!c.shortText);
    at(E.headCtx, 'title', c.tip || null);
    show(E.ctxline, c.pct != null || !!c.pctText || !!c.remainText);
    // Share of the window and distance to auto-compact: each is its own block, wrapping as a whole in a narrow panel instead of being cut off by an ellipsis
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

    // Auto-compact: {value} (source) ▾; clicking it makes the extension show the level picker
    const ac = s.autoCompact;
    show(E.autocompact, !!ac);
    if (ac) {
      txt(E.autocompact.children[0], ac.text);
      txt(E.autocompact.children[1], ac.detailText);
      show(E.autocompact.children[1], !!ac.detailText);
      at(E.autocompact, 'title', ac.tip || null);
    }
    show(E.acline, !!ac || !!c.compactText); // the cache countdown is in the summary line

    // Storage location: path, sizes, Reveal in file manager, Copy path
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
    show(E.costline, !!s.todayText); // this session's cost is in the summary line; today's total is in the details

    // Usage-limit, error and hint banners: text may wrap, never truncated
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

    // Resume hints: one per line (name + copy button + cost note); the note wraps to the next line when it doesn't fit
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

    const ar = s.autoResume || null;
    renderAutoResume(ar);
    // [Resume] in the summary line also leads to an auto-resume plan or "Continue in background"; the plan line is in its tooltip
    const arAction = !!(ar && (ar.planText || ar.canNow || ar.canCancel));
    at(E.resumeBtn, 'title', [t('webview.resumeShort'), ar ? ar.planText : ''].filter(Boolean).join('\n'));

    // Urgent banner: error / warning banners and compaction loops, one line only; full text is in the hover tooltip and details
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
    show(E.resumeBtn, resume.length > 0 || arAction);
    applyDetails();
  }

  // Auto-resume block: "Auto-resume is on for <project>  Turn off", the plan line with [Continue in background] [Cancel], the copy note
  function renderAutoResume(ar) {
    show(AR.el, !!ar);
    if (!ar) return;
    at(AR.el, 'aria-label', ar.heading);
    txt(AR.project, ar.projectText);
    at(AR.project, 'title', ar.projectTip || null);
    txt(AR.toggle.children[0], ar.toggleText);
    at(AR.toggle, 'title', ar.toggleTip || null);
    show(AR.planLine, !!(ar.planText || ar.canNow || ar.canCancel));
    cn(AR.icon, 'codicon codicon-' + (ar.icon || 'clock') + (ar.tone ? ' tone-' + ar.tone : ''));
    show(AR.icon, !!ar.planText);
    txt(AR.plan, ar.planText);
    show(AR.plan, !!ar.planText);
    at(AR.plan, 'title', ar.planTip || null);
    show(AR.now, !!ar.canNow);
    txt(AR.now.children[1], ar.nowText);
    at(AR.now, 'title', ar.nowTip || null);
    show(AR.cancel, !!ar.canCancel);
    txt(AR.cancel.children[1], ar.cancelText);
    txt(AR.note, ar.noteText);
    show(AR.note, !!ar.noteText);
  }

  // [Resume] in the summary line: open "Details" and bring the resume hints and the auto-resume block into view (hints first when both don't fit)
  function revealResume() {
    const els = [E.resume, AR.el].filter((el) => !el.hidden);
    if (!els.length) return;
    els[els.length - 1].scrollIntoView({ block: 'nearest' });
    els[0].scrollIntoView({ block: 'nearest' });
  }

  // "Details" collapsible section: collapsed by default, remembered per session
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

  // In a short panel (< 400px) hide the cost and time columns, keeping "name · status · current step · context"
  function applyShort() { document.body.classList.toggle('short', window.innerHeight < 400); }
  applyShort();
  window.addEventListener('resize', applyShort);

  // Cache countdown: refresh this one spot every 30 seconds from cacheExpiresMs, without touching the table
  function updateCache() {
    const c = vm && vm.session && vm.session.cache;
    show(E.cache, !!c);
    if (!c) return;
    const left = c.expiresMs - (Date.now() + skew);
    txt(E.cache, left <= 0 ? t('session.cacheExpired') : t('session.cacheLeft', { m: Math.max(1, Math.ceil(left / 60000)) }));
    E.cache.classList.toggle('expired', left <= 0);
  }
  setInterval(updateCache, 30000);

  // ---------- Table rows ----------
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
    // Wide panel: cells sit in one row in the columns set by CSS; narrow panel: c-line2 becomes a second line (step + tokens + cost + time),
    // and the first line holds only the name and status, so the status sentence (e.g. "Waiting for your approval") isn't truncated
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
    at(u.tok, 'title', r.tokensTip || null);
    txt(u.cost, r.costText);
    at(u.cost, 'title', r.costTip || null);
    txt(u.time, r.durText);

    // Toggle button: agent row = expand details; workflow row = collapse the agents in the group
    const open = isWf ? !isCollapsed(r.id) : isExpanded(r.id);
    cn(u.twisty, 'twisty codicon codicon-chevron-' + (open ? 'down' : 'right'));
    at(u.twisty, 'aria-expanded', String(open));
    at(u.twisty, 'aria-label', t(isWf ? (open ? 'webview.group.collapse' : 'webview.group.expand') : (open ? 'webview.collapse' : 'webview.expand'), { name: r.name }));
    at(u.row, 'aria-expanded', isWf || r.expandable ? String(open) : null);
    if (!isWf) setDetail(u, open);
    // Hidden while its workflow is collapsed (not removed, so node identity is unchanged)
    show(el, !(r.parentId && isCollapsed(r.parentId)));
  }

  const isExpanded = (id) => listOf(state.expanded, shownKey).includes(id);
  const isCollapsed = (id) => listOf(state.collapsed, shownKey).includes(id);

  // ---------- Detail panel (recent steps, result, changed files, errors) ----------
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
    if (res) txt(d.result, res.text); // write only when changed, so the result box keeps its scroll position
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

  // ---------- Rendering the whole content area ----------
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
      // Scoped to the workspace and the workspace has no sessions: offer "Show all sessions"
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
      // Switching sessions: replace the whole table (rows of different sessions are never the same set anyway), remembering the old session's scroll position
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
    // Cost column header: "Credits" for Copilot sessions (plain credit numbers in the cells), otherwise the default "Cost"
    if (E.costHead) {
      txt(E.costHead, m.costHead ? m.costHead.text : t('webview.col.cost'));
      at(E.costHead, 'title', m.costHead ? m.costHead.tip : null);
    }
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

  // The content area scrolls on its own (list and content scroll independently, like the terminal); remember each session's scroll position
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

  // ---------- Session list (modeled on the terminal tab list) ----------
  let listSel = null;       // selection pushed by the extension
  let pendingSel = null;    // { key, until }: just clicked on the page, awaiting confirmation from the extension (not reverted by stale messages meanwhile)
  let focusKey = null;      // row with keyboard focus (aria-activedescendant)
  let position = 'right';  // matches the initial layout in the HTML (content, sash, list)
  let savedWidth = state.listWidth; // the width remembered by the page wins; otherwise use the one saved by the extension (globalState)
  let dragging = false;
  let dragW = null;
  let typed = '';
  let typedAt = 0;
  let optSeq = 0;
  let rowEls = new Map();   // key -> row element

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
    // After the pointer leaves, apply the new tooltip that accumulated while hovering
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
    // Hover tooltip (in narrow-strip mode it also holds the name): nothing that changes every second, but it follows status and token updates.
    // Don't change it while the pointer is on this row (that would close the tooltip being read); swap it after the pointer leaves, matching how native tree tooltips are computed on hover
    if (el.matches(':hover') && el.getAttribute('title') !== it.tip) el._tip = it.tip;
    else { el._tip = null; at(el, 'title', it.tip); }
    at(el, 'aria-label', it.a11y);
    // VS Code's webview context menu reads this attribute (webviewSection / sessionKey / compactable / resumable)
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

  // Scroll a row into view (only the list scrolls, not the whole page)
  function reveal(el) {
    if (!el) return;
    const box = E.slist;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  }

  // Left = list, sash, content; right = content, sash, list. DOM order matches what is shown, so Tab order is correct too
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

  // Actual width: automatic narrow strip when the panel is narrower than 500; below 80 collapse to the 46px narrow strip (icons only, names in the tooltip); leave room for the content area
  function applyWidth(raw) {
    const panel = window.innerWidth || document.documentElement.clientWidth;
    const eff = LS.effectiveWidth(raw != null ? raw : savedWidth, panel);
    const w = eff.width + 'px';
    if (E.slist.style.width !== w) E.slist.style.width = w; // setting styles via CSSOM is not restricted by the CSP
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
    // The extension confirmed the row just clicked, or we waited too long: the extension's selection wins
    if (pendingSel && (pendingSel.key === listSel || Date.now() > pendingSel.until)) pendingSel = null;
    const items = Array.isArray(m.items) ? m.items : [];
    syncKeyed(E.box, items,
      (it) => (it.kind === 'group' ? it.id : 's:' + it.key),
      (it) => (it.kind === 'group' ? makeGroup(it) : makeRow(it)),
      (el, it) => (it.kind === 'group' ? updateGroup(el, it) : updateRow(el, it)));
    rowEls = new Map(sessionRows().map((el) => [el._data.key, el]));
    if (focusKey && !rowEls.has(focusKey)) focusKey = null;
    paintAll();
    // The extension changed the selection (follows when switching to another conversation tab): scroll it into view
    const after = currentSel();
    if (after && after !== before) reveal(rowEls.get(after));
  }

  // User selection: mark it on the page first, then tell the extension (which marks it seen, switches the content area and sends focus)
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

  // Keyboard: ↑ ↓ Home End PageUp PageDown move focus, Enter / Space selects, Shift+F10 / Menu key opens "…", typing jumps by title prefix
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
  // Tab into the list: focus lands on the selected row (or the first row if none)
  E.box.addEventListener('focus', () => {
    if (!focusKey || !rowEls.has(focusKey)) {
      const first = sessionRows()[0];
      focusKey = currentSel() || (first ? first._data.key : null);
    }
    paintAll();
  });
  // Row-end buttons don't take focus (the list keeps its "focused" selection color)
  E.box.addEventListener('mousedown', (e) => { if (e.target.closest('.sl-act')) e.preventDefault(); });
  // Double-click a row: go to where that session runs (the first click has already selected it); not on the row-end buttons
  E.box.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.sl-row');
    if (!row || !row._data || e.target.closest('.sl-act')) return;
    clearSelection();
    vscode.postMessage({ type: 'goTo', sessionKey: row._data.key });
  });
  // Right-click: focus follows to this row (selection unchanged; VS Code shows the menu from data-vscode-context, so the default is not prevented here)
  E.box.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.sl-row');
    if (row && row._data) { focusKey = row._data.key; paintAll(); }
  });

  // Sash: drag to change width (snapped by the terminal's rules), double-click to reset; not draggable when the panel is too narrow and the strip is automatic
  E.sash.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || E.app.classList.contains('auto-narrow')) return;
    e.preventDefault();
    dragging = true;
    dragW = null;
    try { E.sash.setPointerCapture(e.pointerId); } catch (err) { /* dragging works without capture too */ }
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

  // ---------- Interaction ----------
  function toggle(u) {
    if (!u || !u.data) return;
    const r = u.data;
    if (r.kind === 'workflow') {
      setIn(state.collapsed, shownKey, r.id, !isCollapsed(r.id));
      for (const x of units.values()) if (x.data) updateUnit(x.el, x.data); // rows in the group show/hide along with it
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
    // Buttons at the end of a list row: compact, "…" (the extension shows a QuickPick with the same items as the context menu); selection unchanged
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
    if (act === 'showResume') { setDetails(true); revealResume(); return; }
    if (act === 'compact' || btn === E.compact) { if (key) vscode.postMessage({ type: 'compact', sessionKey: key }); return; }
    if (act === 'goTo') { if (key) vscode.postMessage({ type: 'goTo', sessionKey: key }); return; }
    if (act === 'setAutoCompact' || act === 'revealTranscript' || act === 'copyTranscriptPath') {
      if (key) vscode.postMessage({ type: act, sessionKey: key });
      return;
    }
    if (act === 'resume') {
      vscode.postMessage({ type: 'copyResume', sessionKey: key, hintIndex: Number(btn.dataset.index), variant: btn.dataset.variant });
      return;
    }
    // Auto-resume: only the session key goes out (the switch also says which way); the extension checks the current state again
    if (act === 'autoResumeNow' || act === 'autoResumeCancel') {
      if (key) vscode.postMessage({ type: act, sessionKey: key });
      return;
    }
    if (act === 'autoResumeProject') {
      const ar = vm && vm.session && vm.session.autoResume;
      if (key && ar) vscode.postMessage({ type: 'autoResumeProject', sessionKey: key, on: !ar.projectOn });
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
    // Clicking elsewhere on the row also expands / collapses (like a native tree); drag-selecting text, clicking inside the detail
    // panel and the second click of a double-click (which goes to the session instead) don't count
    const row = e.target.closest('.row');
    if (!row || row.classList.contains('head') || e.detail > 1 || String(window.getSelection() || '')) return;
    toggle(unitOf(row));
  });

  // Double-click an agent row (not its buttons, not the detail panel): go to where the session runs (the first click has
  // toggled the row, the second one is ignored)
  E.rows.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (!row || row.classList.contains('head') || e.target.closest('button') || !shownKey) return;
    clearSelection();
    vscode.postMessage({ type: 'goTo', sessionKey: shownKey });
  });
  // A double-click selects a word; drop it, since the double-click was meant as a command
  function clearSelection() {
    const sel = window.getSelection && window.getSelection();
    if (sel && typeof sel.removeAllRanges === 'function') sel.removeAllRanges();
  }

  // ←/→ on the toggle button collapses / expands (Enter and Space are handled by the button itself)
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
  applyWidth(); // before the first list message arrives, lay out with the remembered width (or the default 200) to avoid a jump
  const ready = { type: 'ready', expanded: state.expanded };
  if (state.listWidth != null) ready.listWidth = state.listWidth;
  vscode.postMessage(ready);
})();
