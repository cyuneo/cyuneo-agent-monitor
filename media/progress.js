'use strict';
// Page script for the side-bar Progress view (agentMonitor.progress).
// - One card per session, in the order the extension sends (never re-sorted here). The selected session's card (shared with
//   the bottom panel) opens in place: workflow phases, the plan, and the main conversation's steps folded into groups.
// - Only renders the view model computed by the extension (lib/progress-view.js); text is either preformatted or looked up in
//   the injected dictionary. DOM is built from text only and updated in place by key (media/session-list.js syncKeyed);
//   step blocks come from media/steps.js.
// - Every action posts only a session key (plus the row id and call id for a step); the extension looks everything up again.
// - Remembered in vscode.setState: cards folded by the user, groups opened or closed by the user (at most 200), scroll position.
(function () {
  const vscode = acquireVsCodeApi();
  const LS = window.AgentMonitorList;
  const syncKeyed = LS.syncKeyed;
  const STATE_ICON = window.AgentMonitorSteps.STATE_ICON;

  // ---------- Dictionary (JSON data block injected by the extension) ----------
  let dict = {};
  try { dict = (JSON.parse(document.getElementById('l10n').textContent) || {}).dict || {}; } catch (e) { dict = {}; }
  const t = (key, vars) => {
    const s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    return !vars ? s : s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] == null ? '' : vars[k]) : m));
  };

  // ---------- Persistent state ----------
  const MAX_OPEN = 200;
  const MAX_CLOSED = 50;
  let saved = {};
  try { saved = vscode.getState() || {}; } catch (e) { saved = {}; }
  const state = {
    closed: Array.isArray(saved.closed) ? saved.closed.filter((k) => typeof k === 'string').slice(-MAX_CLOSED) : [],
    open: saved.open && typeof saved.open === 'object' && !Array.isArray(saved.open) ? saved.open : {},
    scroll: typeof saved.scroll === 'number' && Number.isFinite(saved.scroll) ? saved.scroll : 0,
  };
  const save = () => { try { vscode.setState(state); } catch (e) { /* state is a convenience */ } };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  /** A group (or earlier turn, or plan list) the user opened or closed; otherwise its default */
  function isOpen(sessionKey, key, dflt) {
    const k = sessionKey + '\n' + key;
    return has(state.open, k) ? !!state.open[k] : !!dflt;
  }
  function setOpen(sessionKey, key, on) {
    const k = sessionKey + '\n' + key;
    delete state.open[k]; // re-inserting = most recent; the oldest go first when over the limit
    state.open[k] = !!on;
    const keys = Object.keys(state.open);
    if (keys.length > MAX_OPEN) for (const x of keys.slice(0, keys.length - MAX_OPEN)) delete state.open[x];
    save();
  }
  const isClosed = (key) => state.closed.includes(key);
  function setClosed(key, on) {
    state.closed = state.closed.filter((k) => k !== key);
    if (on) state.closed.push(key);
    if (state.closed.length > MAX_CLOSED) state.closed = state.closed.slice(-MAX_CLOSED);
    save();
  }

  // ---------- DOM helpers: write only when the value changed ----------
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
  const icon = (name) => h('i', { class: 'codicon codicon-' + name, 'aria-hidden': 'true' });
  const lampClass = (x) => `lamp codicon codicon-${x.shape || 'circle-large-outline'} lamp-${x.lamp || 'idle'}`;

  const E = { empty: $('empty'), cards: $('cards') };
  const post = (m) => vscode.postMessage(m);
  let cards = null;        // last cards message
  let expanded = null;     // last expanded message
  let bodyKey = null;      // session whose card is open on the page (its steps are on screen)
  let seq = 0;             // element ids
  let restored = false;    // scroll position put back after the page was rebuilt
  const Steps = window.AgentMonitorSteps.createSteps({ post, t, h, getSessionKey: () => bodyKey, syncKeyed });

  // ---------- Cards ----------
  function makeCard() {
    const head = h('button', { type: 'button', class: 'c-head', 'data-act': 'card', 'aria-expanded': 'false' }, [
      h('i', { class: 'lamp codicon', 'aria-hidden': 'true' }),
      h('span', { class: 'c-title' }),
      h('span', { class: 'c-cost muted' }),
      h('span', { class: 'c-ago muted' }),
    ]);
    const now = h('div', { class: 'c-line c-now' }, [h('i', { class: 'codicon', 'aria-hidden': 'true' }), h('span', { class: 'c-text' })]);
    const prog = h('div', { class: 'c-line c-prog' }, [h('span', { class: 'c-text' }), h('progress', { class: 'bar', 'aria-hidden': 'true' })]);
    const el = h('div', { class: 'card', role: 'listitem' }, [head, now, prog]);
    el._c = { head, now, prog, body: null };
    return el;
  }

  function updateCard(el, x) {
    const C = el._c;
    const selected = !!x.expanded;
    const open = selected && !isClosed(x.key);
    cn(el, 'card' + (x.compact ? ' compact' : '') + (selected ? ' selected' : '') + (open ? ' open' : ''));
    at(el, 'data-vscode-context', x.context);
    const [lamp, title, cost, ago] = C.head.children;
    cn(lamp, lampClass(x));
    txt(title, x.title);
    txt(cost, x.cost);
    show(cost, !!x.cost);
    txt(ago, x.ago);
    at(C.head, 'title', x.tip);
    at(C.head, 'aria-label', x.a11y);
    at(C.head, 'aria-expanded', String(open));
    const now = x.now;
    show(C.now, !!(now && now.text));
    if (now) {
      const [i, s] = C.now.children;
      cn(i, 'codicon' + (now.icon ? ' codicon-' + now.icon : '') + (now.spin ? ' codicon-modifier-spin' : ''));
      show(i, !!now.icon);
      txt(s, now.text);
      at(s, 'title', now.text);
    }
    const p = x.prog;
    show(C.prog, !!p);
    if (p) {
      const [s, bar] = C.prog.children;
      txt(s, p.text);
      at(s, 'title', p.text);
      const hasBar = typeof p.value === 'number' && typeof p.max === 'number' && p.max > 0;
      show(bar, hasBar);
      if (hasBar) { at(bar, 'max', p.max); at(bar, 'value', Math.min(p.value, p.max)); }
    }
    if (open) {
      if (!C.body) {
        C.body = makeBody();
        el.appendChild(C.body);
      }
      at(C.head, 'aria-controls', C.body.id);
      bodyKey = x.key;
      fillBody(C.body, expanded && expanded.key === x.key ? expanded : null);
    } else if (C.body) {
      C.body.remove();
      C.body = null;
      at(C.head, 'aria-controls', null);
      if (bodyKey === x.key) bodyKey = null;
    }
  }

  // ---------- Expanded card ----------
  function makeBody() {
    const loading = h('p', { class: 'c-loading muted', role: 'status' }, [t('session.loading')]);
    const wfs = h('div', { class: 'c-wfs' });
    const plan = makePlan();
    const stream = h('ol', { class: 'steps c-stream', 'aria-label': t('webview.steps') });
    const openLog = h('button', { type: 'button', class: 'link', 'data-act': 'openTranscript' }, [icon('go-to-file'), h('span', null, [t('webview.openTranscript')])]);
    const foot = h('div', { class: 'c-foot' }, [
      h('button', { type: 'button', class: 'link', 'data-act': 'show' }, [icon('layout-panel'), h('span', null, [t('webview.progress.openPanel')])]),
      openLog,
    ]);
    const body = h('div', { class: 'c-body', id: 'cb' + (++seq) }, [loading, wfs, plan.el, stream, foot]);
    body._b = { loading, wfs, plan, stream, openLog, filled: false };
    return body;
  }

  function fillBody(body, ex) {
    const B = body._b;
    show(B.loading, !ex || ex.loading);
    const wfs = ex ? ex.workflows || [] : [];
    show(B.wfs, wfs.length > 0);
    syncKeyed(B.wfs, wfs, (w) => w.key, makeWorkflow, updateWorkflow);
    updatePlan(B.plan, ex ? ex.plan : null);
    const items = ex ? ex.stream || [] : [];
    show(B.stream, items.length > 0);
    syncStream(B.stream, items, B.filled);
    if (items.length) B.filled = true;
    show(B.openLog, !!(ex && ex.canOpen));
  }

  function makeWorkflow() {
    return h('div', { class: 'wf' }, [
      h('div', { class: 'wf-head' }, [icon('type-hierarchy'), h('span', { class: 'wf-name' }), h('span', { class: 'wf-state muted' })]),
      h('ol', { class: 'phases', 'aria-label': t('webview.progress.phases') }),
      h('div', { class: 'wf-line muted' }),
    ]);
  }
  function updateWorkflow(el, w) {
    const [head, phases, line] = el.children;
    cn(el, 'wf' + (w.phases.length ? ' has-phases' : ''));
    txt(head.children[1], w.name);
    at(head.children[1], 'title', w.name);
    txt(head.children[2], w.stateText);
    txt(line, w.lineText);
    show(phases, w.phases.length > 0);
    syncKeyed(phases, w.phases, (p) => p.key, () => h('li', { class: 'ph' }, [
      h('i', { class: 'codicon', 'aria-hidden': 'true' }), h('span', { class: 'ph-title' }), h('span', { class: 'ph-count muted' }), h('span', { class: 'sr-only' }),
    ]), (li, p) => {
      cn(li, 'ph ph-' + p.state);
      const [i, title, count, sr] = li.children;
      cn(i, 'codicon codicon-' + (p.state === 'done' ? 'check' : p.state === 'current' ? 'circle-filled' : 'circle-outline'));
      txt(title, p.title);
      txt(count, p.count);
      show(count, !!p.count);
      txt(sr, p.stateText);
      at(li, 'title', [p.title, p.stateText, p.count].filter(Boolean).join(' · '));
    });
  }

  function makePlan() {
    const chev = () => h('i', { class: 'codicon codicon-chevron-right', 'aria-hidden': 'true' });
    const P = {
      title: h('span', { class: 'plan-title' }),
      prog: h('span', { class: 'plan-prog muted' }),
      bar: h('progress', { class: 'bar', 'aria-hidden': 'true' }),
      doneBtn: h('button', { type: 'button', class: 'link plan-fold', 'data-act': 'plan', 'data-key': 'plan:done', 'aria-expanded': 'false' }, [chev(), h('span')]),
      done: h('ul', { class: 'plan-items' }),
      shown: h('ul', { class: 'plan-items' }),
      moreBtn: h('button', { type: 'button', class: 'link plan-fold', 'data-act': 'plan', 'data-key': 'plan:more', 'aria-expanded': 'false' }, [chev(), h('span')]),
      more: h('ul', { class: 'plan-items' }),
    };
    P.el = h('section', { class: 'plan' }, [
      h('div', { class: 'plan-head' }, [P.title, P.prog, P.bar]), P.doneBtn, P.done, P.shown, P.moreBtn, P.more,
    ]);
    return P;
  }
  function updatePlan(P, plan) {
    show(P.el, !!plan);
    if (!plan) return;
    txt(P.title, plan.title);
    txt(P.prog, plan.progressText);
    at(P.bar, 'max', plan.max);
    at(P.bar, 'value', plan.value);
    const fold = (btn, list, items, text, key) => {
      const open = isOpen(bodyKey, key, false);
      show(btn, !!text);
      txt(btn.children[1], text);
      at(btn, 'aria-expanded', String(open));
      cn(btn.children[0], 'codicon codicon-chevron-' + (open ? 'down' : 'right'));
      show(list, !!text && open);
      planItems(list, open ? items : []);
    };
    fold(P.doneBtn, P.done, plan.done, plan.doneText, 'plan:done');
    planItems(P.shown, plan.shown);
    fold(P.moreBtn, P.more, plan.more, plan.moreText, 'plan:more');
  }
  function planItems(list, items) {
    syncKeyed(list, items || [], (x, i) => i + '|' + x.text, () => h('li', { class: 'pi' }, [
      h('i', { class: 'codicon', 'aria-hidden': 'true' }), h('span', { class: 'pi-text' }), h('span', { class: 'sr-only' }),
    ]), (li, x) => {
      cn(li, 'pi pi-' + x.status);
      const [i, s, sr] = li.children;
      cn(i, 'codicon codicon-' + (x.status === 'completed' ? 'check' : x.status === 'in_progress' ? 'circle-filled' : 'circle-outline'));
      txt(s, x.text);
      at(s, 'title', x.text);
      txt(sr, t('webview.progress.phase.' + (x.status === 'completed' ? 'done' : x.status === 'in_progress' ? 'current' : 'pending')));
    });
  }

  // ---------- Step stream: groups, blocks, lines, the quoted prompt, notes, earlier turns ----------
  // A lone block that the next call turns into a group: its element moves into the group (kept open, keeps focus)
  const adopt = new Map(); // block key -> its element, until the group that took it is drawn
  function syncStream(list, items, animate) {
    let fresh = 0;
    const lone = new Set(items.filter((x) => x.type === 'block').map((x) => x.key));
    let focused = null;
    const mine = [];
    for (const li of Array.from(list.children)) {
      const S = li._s;
      if (!S || !S.data || typeof li._key !== 'string' || li._key.indexOf('block|') !== 0 || lone.has(S.data.key)) continue;
      const hasFocus = document.activeElement === S.head;
      const g = S.open || hasFocus ? items.find((x) => x.type === 'group' && x.items.some((b) => b.key === S.data.key)) : null;
      if (!g) continue;
      adopt.set(S.data.key, li);
      mine.push(S.data.key);
      if (!isOpen(bodyKey, g.key, g.defaultOpen)) setOpen(bodyKey, g.key, true);
      if (hasFocus) focused = S.head;
    }
    syncKeyed(list, items, (x) => x.type + '|' + x.key, (x) => {
      const li = makeItem(x);
      if (animate) {
        li.classList.add('enter');
        li.style.animationDelay = Math.min(fresh++, 8) * 70 + 'ms';
        li.addEventListener('animationend', () => { li.classList.remove('enter'); li.style.animationDelay = ''; }, { once: true });
      }
      return li;
    }, updateItem);
    for (const k of mine) adopt.delete(k);
    if (focused && focused.isConnected !== false) focused.focus();
  }
  function makeItem(x) {
    switch (x.type) {
      case 'block': return Steps.makeStep();
      case 'group': return makeFold('group');
      case 'turn': return makeFold('turn');
      case 'quote': return h('li', { class: 'step line quote' }, [icon('comment'), h('span', { class: 'st-text' }), h('span', { class: 'ago muted' })]);
      case 'note': return h('li', { class: 'step line note' }, [icon('history'), h('span', { class: 'st-text muted' })]);
      default: return Steps.makeLine();
    }
  }
  function updateItem(li, x) {
    switch (x.type) {
      case 'block':
        Steps.updateStep(li, x, 'main');
        blockExtras(li, x);
        return;
      case 'group':
      case 'turn':
        updateFold(li, x);
        return;
      case 'quote':
        txt(li.children[1], x.text);
        at(li.children[1], 'title', x.text);
        txt(li.children[2], x.ago);
        return;
      case 'note':
        txt(li.children[1], x.text);
        return;
      default:
        Steps.updateLine(li, x);
    }
  }
  /** A block in the side bar: the highlight while it runs, and the line for the subagent or workflow run it started */
  function blockExtras(li, x) {
    li.classList.toggle('current', !!x.current);
    const n = x.nest;
    let el = li._nest;
    if (!n) { if (el) show(el, false); return; }
    if (!el) {
      el = h('div', { class: 'st-nest' }, [h('i', { class: 'lamp codicon', 'aria-hidden': 'true' }), h('span', { class: 'st-text' })]);
      li.insertBefore(el, li._s.body);
      li._nest = el;
    }
    show(el, true);
    cn(el.children[0], lampClass(n));
    txt(el.children[1], n.text);
    at(el, 'title', n.text);
  }

  // A group of tool calls ("Ran 5 tools · now Running command") or an earlier turn: a head that opens to its items
  function makeFold(kind) {
    const id = 'f' + (++seq);
    const head = h('button', { type: 'button', class: 'f-head', 'data-act': 'fold', 'aria-expanded': 'false', 'aria-controls': id }, [
      h('i', { class: 'st-chev codicon codicon-chevron-right', 'aria-hidden': 'true' }),
      h('i', { class: 'st-state codicon', 'aria-hidden': 'true' }),
      h('span', { class: 'f-text' }, [h('span', { class: 'f-title' }), h('span', { class: 'f-cats muted' })]),
      h('span', { class: 'sr-only' }),
    ]);
    const items = h('ol', { class: 'steps f-items', id, hidden: '' });
    const li = h('li', { class: 'step ' + kind }, [head, items]);
    li._f = { head, items, kind, data: null, filled: false };
    return li;
  }
  function updateFold(li, x) {
    const F = li._f;
    F.data = x;
    const isGroup = F.kind === 'group';
    const open = isOpen(bodyKey, x.key, isGroup ? x.defaultOpen : false);
    cn(li, 'step ' + F.kind + (isGroup && x.state ? ' s-' + x.state : '') + (x.current ? ' current' : '')
      + (open ? ' open' : '') + (li.classList.contains('enter') ? ' enter' : ''));
    const [chev, state, text, sr] = F.head.children;
    cn(chev, 'st-chev codicon codicon-chevron-' + (open ? 'down' : 'right'));
    cn(state, 'st-state codicon codicon-' + (isGroup ? STATE_ICON[x.state] || 'circle-small' : 'history'));
    const [title, cats] = text.children;
    txt(title, isGroup ? x.title : x.text);
    // Screen readers hear the running group's head change; nothing else in the stream is live
    at(title, 'aria-live', x.current ? 'polite' : null);
    txt(cats, isGroup ? x.cats : '');
    show(cats, !!(isGroup && x.cats));
    txt(sr, isGroup ? x.stateText : '');
    at(F.head, 'title', [isGroup ? x.title : x.text, isGroup ? x.cats : ''].filter(Boolean).join('\n'));
    at(F.head, 'aria-expanded', String(open));
    show(F.items, open);
    if (!open) { F.filled = false; return; }
    if (isGroup) {
      Steps.sync(F.items, x.items, 'main', F.filled, (k) => {
        const li = adopt.get(k);
        if (li) { adopt.delete(k); li._key = k; }
        return li || null;
      });
      const kids = F.items.children;
      x.items.forEach((b, i) => { if (kids[i]) blockExtras(kids[i], b); });
    } else {
      syncStream(F.items, x.items || [], F.filled);
    }
    F.filled = true;
  }

  // ---------- Render ----------
  function render() {
    if (!cards) return;
    txt(E.empty, cards.emptyText);
    show(E.empty, !!cards.emptyText);
    const items = cards.items || [];
    show(E.cards, items.length > 0);
    if (!items.some((c) => c.expanded && !isClosed(c.key))) bodyKey = null;
    syncKeyed(E.cards, items, (c) => c.key, makeCard, updateCard);
    restoreScroll();
  }

  // Put the scroll position back once the page has its content again (the view is rebuilt each time it is shown)
  function restoreScroll() {
    if (restored) return;
    const sel = (cards.items || []).find((c) => c.expanded && !isClosed(c.key));
    if (sel && !(expanded && expanded.key === sel.key)) return; // wait for the open card's part
    restored = true;
    const se = document.scrollingElement || document.documentElement;
    if (state.scroll > 0) se.scrollTop = state.scroll;
  }
  let scrollTimer = 0;
  window.addEventListener('scroll', () => {
    if (!restored) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      state.scroll = (document.scrollingElement || document.documentElement).scrollTop;
      save();
    }, 200);
  }, { passive: true });

  // ---------- Actions ----------
  function rerenderFold(li) {
    if (li && li._f && li._f.data) updateItem(li, li._f.data);
  }
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const card = btn.closest('.card');
    const key = card ? card._key : null;
    if (act === 'card' && key && cards) {
      const x = (cards.items || []).find((c) => c.key === key);
      if (x && x.expanded) {
        // The selected card folds and unfolds on the page; the selection stays
        const fold = !isClosed(key);
        setClosed(key, fold);
        post({ type: 'toggle', sessionKey: key, open: !fold });
        render();
      } else {
        setClosed(key, false);
        post({ type: 'select', sessionKey: key });
      }
      return;
    }
    if (!bodyKey) return;
    if (act === 'step') { Steps.toggleStep(btn.closest('.step')); return; }
    if (act === 'fold') {
      const li = btn.closest('.step');
      const F = li && li._f;
      if (!F || !F.data) return;
      const open = btn.getAttribute('aria-expanded') === 'true';
      setOpen(bodyKey, F.data.key, !open);
      rerenderFold(li);
      return;
    }
    if (act === 'plan') {
      const k = btn.getAttribute('data-key');
      setOpen(bodyKey, k, btn.getAttribute('aria-expanded') !== 'true');
      render();
      return;
    }
    if (act === 'show') { post({ type: 'show' }); return; }
    if (act === 'openTranscript') post({ type: 'openTranscript', sessionKey: bodyKey });
  });

  // ↑ ↓ Home End move between card heads (Enter and Space click the focused head)
  E.cards.addEventListener('keydown', (e) => {
    const head = e.target && e.target.classList && e.target.classList.contains('c-head') ? e.target : null;
    if (!head || e.altKey || e.ctrlKey || e.metaKey) return;
    const heads = Array.from(E.cards.querySelectorAll('.c-head'));
    const j = LS.moveIndex(e.key, heads.indexOf(head), heads.length, 10);
    if (j < 0 || e.key === 'PageUp' || e.key === 'PageDown') return;
    e.preventDefault();
    heads[j].focus();
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'cards') { cards = m; render(); }
    else if (m.type === 'expanded') { expanded = m; render(); }
    else if (m.type === 'step') Steps.onStepLog(m, E.cards);
  });

  post({ type: 'ready', closed: state.closed });
})();
