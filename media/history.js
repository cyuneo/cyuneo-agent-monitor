'use strict';
// Script for the "Usage history" page.
// - Only renders the view model computed by the extension (lib/history-view.js); all text is already localized and formatted.
// - Draws the stacked daily bars with plain elements (heights set through the CSSOM, which the CSP allows), a hover / focus
//   tooltip, and a table view of the same numbers. The chart is one tab stop; arrow keys, Home and End move between days.
// - The cost / tokens toggle and the table view's open state live in vscode.setState; the only messages sent are ready and refresh.
(function () {
  const vscode = acquireVsCodeApi();

  let dict = {};
  try { dict = (JSON.parse(document.getElementById('l10n').textContent) || {}).dict || {}; } catch (e) { dict = {}; }
  const t = (key) => (Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key);

  const saved = vscode.getState() || {};
  const state = { mode: saved.mode === 'tokens' ? 'tokens' : 'cost', table: saved.table === true };
  const save = () => vscode.setState(state);

  const $ = (id) => document.getElementById(id);
  const root = $('root');
  const status = $('status');
  const live = $('live');
  const APPS = ['claude', 'codex'];
  let vm = null;
  let bodyKey = '';      // what the page body was last built from (header-only changes skip the rebuild)
  let active = -1;       // day with the chart's tab stop (-1: today)
  let hoverDate = null;  // day under the pointer, so the tooltip survives a re-render

  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (kids) for (const c of kids) if (c != null && c !== false) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  }
  const icon = (name, cls) => h('i', { class: 'codicon codicon-' + name + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
  const swatch = (app) => h('span', { class: 'sw sw-' + app, 'aria-hidden': 'true' });
  function banner(tone, iconName, text) {
    return h('div', { class: 'banner b-' + tone, role: tone === 'error' ? 'alert' : null }, [icon(iconName), h('div', { class: 'b-body', text })]);
  }

  // ---------- Blocks ----------

  function progressBlock(p) {
    const bar = h('div', { class: 'pbar', role: 'progressbar', 'aria-label': p.label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(p.pct), 'aria-valuetext': p.text }, [
      h('div', { class: 'pbar-fill' }),
    ]);
    bar.firstChild.style.width = p.pct + '%';
    return h('div', { class: 'progress' }, [
      h('p', { class: 'p-text' }, [icon('loading', 'codicon-modifier-spin'), h('span', { text: p.text }), p.detail ? h('span', { class: 'muted', text: p.detail }) : null]),
      bar,
    ]);
  }

  function totalsBlock(list) {
    return h('dl', { class: 'tiles' }, list.map((x) => h('div', { class: 'tile' }, [
      h('dt', null, [x.swatch ? swatch(x.swatch) : null, h('span', { text: x.label })]),
      h('dd', { class: 'v', text: x.value }),
      h('dd', { class: 'sub muted', text: x.sub }),
    ])));
  }

  function modeToggle(L) {
    return h('div', { class: 'toggle', role: 'group', 'aria-label': L.mode }, ['cost', 'tokens'].map((m) => h('button', {
      type: 'button', class: 'tg', 'aria-pressed': state.mode === m ? 'true' : 'false', 'data-act': 'mode', 'data-mode': m, 'data-fk': 'mode:' + m,
    }, [icon(m === 'cost' ? 'credit-card' : 'symbol-numeric'), h('span', { text: L[m] })])));
  }

  function legend(c, L) {
    return h('ul', { class: 'legend', 'aria-label': L.legend }, c.legend.map((x) => h('li', null, [swatch(x.key), h('span', { text: x.label })])));
  }

  function chartBlock(c, L) {
    const mode = state.mode;
    const ax = c.axis[mode];
    const n = c.bars.length;
    if (active < 0 || active >= n) active = n - 1;
    const pct = (v) => (ax.top > 0 ? Math.max(0, Math.min(100, (v / ax.top) * 100)) : 0);

    const yAxis = h('div', { class: 'y-axis', 'aria-hidden': 'true' }, ax.ticks.map((tk) => {
      const s = h('span', { text: tk.text });
      s.style.bottom = pct(tk.value) + '%';
      return s;
    }));
    const grid = ax.ticks.map((tk) => {
      const g = h('div', { class: 'gl' + (tk.value === 0 ? ' base' : ''), 'aria-hidden': 'true' });
      g.style.bottom = pct(tk.value) + '%';
      return g;
    });
    const cols = h('div', { class: 'cols' }, c.bars.map((b, i) => {
      const segs = [];
      APPS.forEach((a, k) => {
        const v = b[mode][k];
        if (!(v > 0)) return;
        const s = h('span', { class: 'seg seg-' + a });
        s.style.height = pct(v) + '%';
        segs.push(s);
      });
      return h('div', {
        class: 'col' + (b.today ? ' today' : ''), role: 'img', tabindex: i === active ? '0' : '-1',
        'aria-label': b.aria[mode], 'data-i': String(i), 'data-fk': 'bar:' + b.date,
      }, segs);
    }));
    cols.style.setProperty('--n', String(n));
    const tip = h('div', { class: 'tip', id: 'tip', hidden: true, 'aria-hidden': 'true' });
    const plot = h('div', { class: 'plot', role: 'group', 'aria-label': c.label[mode] }, [...grid, cols, tip]);
    const xAxis = h('div', { class: 'x-axis', 'aria-hidden': 'true' }, c.bars.map((b, i) => h('span', {
      class: (b.tick ? 'tick' : '') + (i === n - 1 ? ' last' : '') + (b.today ? ' today' : ''), text: b.tick ? b.short : '',
    })));
    xAxis.style.setProperty('--n', String(n));

    // The same numbers as a table (the accessible and exact view)
    const rows = c.bars.map((b) => h('tr', null, [
      h('th', { scope: 'row', text: b.long }),
      h('td', { class: 'num', text: b.text[mode].claude }),
      h('td', { class: 'num', text: b.text[mode].codex }),
      h('td', { class: 'num', text: b.text[mode].total }),
    ]));
    const table = h('table', { class: 'dtable' }, [
      h('caption', { class: 'sr-only', text: c.tableCaption[mode] }),
      h('thead', null, [h('tr', null, [
        h('th', { scope: 'col', text: L.date }),
        h('th', { scope: 'col', class: 'num' }, [swatch('claude'), h('span', { text: L.claude })]),
        h('th', { scope: 'col', class: 'num' }, [swatch('codex'), h('span', { text: L.codex })]),
        h('th', { scope: 'col', class: 'num', text: L.total }),
      ])]),
      h('tbody', null, rows.reverse()),
    ]);
    const details = h('details', { class: 'dtable-wrap', open: state.table }, [h('summary', { 'data-fk': 'table', text: L.showTable }), table]);

    return h('section', { class: 'sec', 'aria-labelledby': 'chart-h' }, [
      h('div', { class: 'sec-head' }, [h('h2', { id: 'chart-h', text: c.heading[mode] }), modeToggle(L), legend(c, L)]),
      h('div', { class: 'chart' }, [yAxis, plot, xAxis]),
      details,
    ]);
  }

  function modelsBlock(m) {
    const colAttrs = (c) => ({ class: c.num ? 'num' : 'c-model' });
    const head = h('tr', { role: 'row' }, m.cols.map((c) => h('th', { scope: 'col', role: 'columnheader', ...colAttrs(c), text: c.label })));
    const body = m.rows.map((r) => h('tr', { role: 'row' }, [
      h('th', { scope: 'row', role: 'rowheader', class: 'c-model' }, [
        h('span', { class: 'mname', text: r.model }),
        h('span', { class: 'prov muted' }, [swatch(r.provider), h('span', { text: r.providerLabel })]),
      ]),
      ...m.cols.slice(1).map((c) => h('td', { role: 'cell', class: 'num', 'data-label': c.label, title: r.cells[c.key].title || null, text: r.cells[c.key].text })),
    ]));
    const foot = h('tr', { role: 'row' }, [
      h('th', { scope: 'row', role: 'rowheader', class: 'c-model', text: m.total.label }),
      ...m.cols.slice(1).map((c) => h('td', { role: 'cell', class: 'num', 'data-label': c.label, title: m.total.cells[c.key].title || null, text: m.total.cells[c.key].text })),
    ]);
    return h('section', { class: 'sec', 'aria-labelledby': 'models-h' }, [
      h('h2', { id: 'models-h', text: m.heading }),
      h('table', { class: 'mtable', role: 'table' }, [
        h('caption', { class: 'sr-only', text: m.caption }),
        h('thead', { role: 'rowgroup' }, [head]),
        h('tbody', { role: 'rowgroup' }, body),
        h('tfoot', { role: 'rowgroup' }, [foot]),
      ]),
    ]);
  }

  // ---------- Tooltip ----------

  function hideTip() {
    const tip = $('tip');
    if (tip) tip.hidden = true;
  }

  function showTip(col) {
    const tip = $('tip');
    if (!tip || !vm || !vm.chart || !col) return;
    const b = vm.chart.bars[Number(col.getAttribute('data-i'))];
    if (!b) return;
    const txt = b.text[state.mode];
    tip.replaceChildren(
      h('div', { class: 'tip-date', text: b.long }),
      ...APPS.map((a) => h('div', { class: 'tip-row' }, [swatch(a), h('span', { text: vm.labels[a] }), h('span', { class: 'num', text: txt[a] })])),
      h('div', { class: 'tip-row tip-total' }, [h('span'), h('span', { text: vm.labels.total }), h('span', { class: 'num', text: txt.total })]),
    );
    tip.hidden = false;
    const plot = tip.parentElement;
    const top = col.lastElementChild ? col.offsetTop + col.lastElementChild.offsetTop : col.offsetTop + col.offsetHeight;
    const center = col.offsetLeft + col.offsetWidth / 2;
    const left = Math.max(0, Math.min(plot.clientWidth - tip.offsetWidth, center - tip.offsetWidth / 2));
    tip.style.left = left + 'px';
    tip.style.top = Math.max(0, top - tip.offsetHeight - 6) + 'px';
  }

  // ---------- Page ----------

  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };

  function render(force) {
    if (!vm) return;
    const L = vm.labels;
    setText(status, vm.statusText || '');
    // Polite announcement only when the text really changes (scan started / finished / failed)
    setText(live, vm.liveText || '');
    const refresh = $('refresh');
    setText(refresh.querySelector('span'), L.refresh);
    refresh.querySelector('.codicon').className = 'codicon ' + (vm.busy ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh');
    refresh.setAttribute('aria-busy', vm.busy ? 'true' : 'false');
    // The minute-by-minute refresh usually changes only the "updated" time: keep the body (and a screen reader's place in it)
    const key = JSON.stringify([vm.errorText, vm.progress, vm.empty, vm.totals, vm.unpricedText, vm.chart, vm.models, vm.cacheText, vm.notes, vm.footer, L]);
    if (!force && key === bodyKey) return;
    bodyKey = key;
    const fe = document.activeElement;
    const focusKey = fe && fe.getAttribute && fe.getAttribute('data-fk');
    const kids = [];
    if (vm.errorText) kids.push(banner('error', 'error', vm.errorText));
    if (vm.progress) kids.push(progressBlock(vm.progress));
    if (vm.empty) {
      kids.push(h('div', { class: 'empty' }, [icon('graph'), h('p', { class: 'e-title', text: vm.empty.title }), h('p', { class: 'muted', text: vm.empty.hint })]));
    }
    if (vm.totals.length && !vm.empty) kids.push(totalsBlock(vm.totals));
    if (vm.unpricedText) kids.push(banner('info', 'info', vm.unpricedText));
    if (vm.chart) kids.push(chartBlock(vm.chart, L));
    if (vm.models) kids.push(modelsBlock(vm.models));
    if (vm.cacheText) kids.push(banner('warning', 'warning', vm.cacheText));
    if (vm.notes) {
      kids.push(h('section', { class: 'sec notes', 'aria-labelledby': 'notes-h' }, [
        h('h2', { id: 'notes-h', text: vm.notes.heading }),
        h('ul', null, vm.notes.items.map((x) => h('li', { text: x }))),
      ]));
    }
    if (vm.footer && vm.notes) kids.push(h('p', { class: 'foot muted', text: vm.footer }));
    root.replaceChildren(...kids);
    const byKey = (k) => Array.prototype.find.call(document.querySelectorAll('[data-fk]'), (x) => x.getAttribute('data-fk') === k);
    if (focusKey) {
      const el = byKey(focusKey);
      if (el) el.focus();
    }
    if (hoverDate) {
      const col = byKey('bar:' + hoverDate);
      if (col) showTip(col); else hoverDate = null;
    } else if (focusKey && focusKey.indexOf('bar:') === 0 && document.activeElement && document.activeElement.classList.contains('col')) {
      showTip(document.activeElement);
    }
  }

  // ---------- Events ----------

  document.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!b || b.disabled) return;
    const d = b.dataset;
    switch (d.act) {
      case 'refresh': vscode.postMessage({ type: 'refresh' }); break;
      case 'mode':
        state.mode = d.mode === 'tokens' ? 'tokens' : 'cost';
        save();
        render(true);
        break;
      default:
    }
  });

  // Table view open / closed is remembered
  document.addEventListener('toggle', (ev) => {
    const el = ev.target;
    if (!el || !el.classList || !el.classList.contains('dtable-wrap')) return;
    state.table = !!el.open;
    save();
  }, true);

  document.addEventListener('mouseover', (ev) => {
    const col = ev.target && ev.target.closest ? ev.target.closest('.col') : null;
    if (!col) return;
    hoverDate = (col.getAttribute('data-fk') || '').slice(4) || null;
    showTip(col);
  });
  document.addEventListener('mouseout', (ev) => {
    const from = ev.target && ev.target.closest ? ev.target.closest('.plot') : null;
    const to = ev.relatedTarget && ev.relatedTarget.closest ? ev.relatedTarget.closest('.plot') : null;
    if (from && !to) { hoverDate = null; hideTip(); }
  });
  document.addEventListener('focusin', (ev) => {
    const col = ev.target && ev.target.classList && ev.target.classList.contains('col') ? ev.target : null;
    if (col) showTip(col);
  });
  document.addEventListener('focusout', (ev) => {
    if (ev.target && ev.target.classList && ev.target.classList.contains('col') && !hoverDate) hideTip();
  });

  // The chart is one tab stop: arrow keys, Home and End move between days
  document.addEventListener('keydown', (ev) => {
    const col = ev.target;
    if (!col || !col.classList || !col.classList.contains('col')) return;
    const cols = Array.prototype.slice.call(col.parentElement.children);
    const i = cols.indexOf(col);
    let j = i;
    if (ev.key === 'ArrowLeft') j = Math.max(0, i - 1);
    else if (ev.key === 'ArrowRight') j = Math.min(cols.length - 1, i + 1);
    else if (ev.key === 'Home') j = 0;
    else if (ev.key === 'End') j = cols.length - 1;
    else if (ev.key === 'Escape') { hideTip(); return; }
    else return;
    ev.preventDefault();
    if (j === i) return;
    active = j;
    col.setAttribute('tabindex', '-1');
    cols[j].setAttribute('tabindex', '0');
    cols[j].focus();
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || m.type !== 'vm' || !m.vm) return;
    vm = m.vm;
    render();
  });

  status.textContent = t('history.page.loading');
  vscode.postMessage({ type: 'ready' });
})();
