'use strict';
// Script for the "Storage locations and usage" page.
// - Only renders the view model computed by the extension (lib/storage-view.js); all text is already localized and formatted. It never builds commands or touches paths itself.
// - Buttons only postMessage an entry id / app / plan / command-step name; the extension looks them up again in its current data and acts. The webview never runs commands.
// - The selected plan is kept in vscode.setState; after a re-render, focus returns to the previously focused button.
(function () {
  const vscode = acquireVsCodeApi();

  let dict = {};
  try { dict = (JSON.parse(document.getElementById('l10n').textContent) || {}).dict || {}; } catch (e) { dict = {}; }
  const t = (key) => (Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key);

  const saved = vscode.getState() || {};
  const state = { plan: saved.plan && typeof saved.plan === 'object' ? saved.plan : {} };
  const save = () => vscode.setState(state);
  // Whether the user ticked "migration plans are for reference only; I will check them myself and accept the consequences". Lasts only while this page is open; never saved
  let ack = false;

  const $ = (id) => document.getElementById(id);
  const root = $('root');
  const status = $('status');
  let vm = null;

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

  // Button with a text label
  function btn(label, iconName, data, o) {
    const locked = o && o.locked != null;
    const a = { type: 'button', class: 'btn' + (o && o.primary ? '' : ' secondary'), title: locked ? o.locked : o && o.title, disabled: locked };
    for (const k of Object.keys(data)) a['data-' + k] = data[k];
    return h('button', a, [iconName ? icon(iconName) : null, h('span', { text: label })]);
  }
  // Icon-only button (the label goes to screen readers and the hover tooltip)
  function iconBtn(label, iconName, data) {
    const a = { type: 'button', class: 'ibtn', title: label, 'aria-label': label };
    for (const k of Object.keys(data)) a['data-' + k] = data[k];
    return h('button', a, [icon(iconName)]);
  }
  function banner(tone, iconName, text, extra) {
    return h('div', { class: 'banner b-' + tone, role: tone === 'error' ? 'alert' : null }, [
      icon(iconName),
      h('div', { class: 'b-body' }, [h('span', { text }), extra || null]),
    ]);
  }

  // ---------- Blocks ----------

  function dirSection(d, L) {
    const head = h('div', { class: 'dline' }, [
      h('code', { class: 'path', text: d.pathText, title: d.pathText }),
      h('span', { class: 'muted', text: d.sourceText }),
      d.totalText ? h('span', { class: 'total', text: d.totalText }) : null,
      d.pathId ? h('span', { class: 'acts' }, [
        iconBtn(L.reveal, 'folder-opened', { act: 'reveal', id: d.pathId, fk: 'reveal:' + d.app }),
        iconBtn(L.copyPath, 'copy', { act: 'copyPath', id: d.pathId, fk: 'copy:' + d.app }),
      ]) : null,
    ]);
    const kids = [h('h2', { text: d.heading }), head];
    if (d.linkText) kids.push(banner('info', 'link', d.linkText));
    if (d.missingText) kids.push(banner('info', 'info', d.missingText));
    if (d.errorText) kids.push(banner('error', 'error', d.errorText));
    if (d.entries && d.entries.length) {
      const rows = [h('div', { class: 'erow ehead', role: 'row' }, [
        h('span', { class: 'c-name', role: 'columnheader', text: L.colItem }),
        h('span', { class: 'c-size num', role: 'columnheader', text: L.colSize }),
        h('span', { class: 'c-files num', role: 'columnheader', text: L.colFiles }),
        h('span', { class: 'c-where', role: 'columnheader', text: L.colWhere }),
        h('span', { class: 'c-acts', role: 'columnheader' }, [h('span', { class: 'sr-only', text: L.reveal + ' / ' + L.copyPath })]),
      ])];
      for (const e of d.entries) {
        const where = [];
        if (e.link) where.push(h('button', { type: 'button', class: 'link', 'data-act': 'reveal', 'data-id': e.link.id, 'data-fk': 'link:' + e.key, title: L.reveal }, [icon('link'), h('span', { text: e.link.text })]));
        if (e.whereText) where.push(h('span', { class: e.tone === 'error' ? 'tone-error' : 'muted', text: e.whereText }));
        if (e.errorsText && e.tone !== 'error') where.push(h('span', { class: 'tone-warn', text: e.errorsText }));
        rows.push(h('div', { class: 'erow' + (e.exists ? '' : ' missing') + (e.rest ? ' rest' : ''), role: 'row', title: e.tip || null }, [
          h('span', { class: 'c-name', role: 'cell' }, [e.rest ? h('span', { text: e.name }) : h('code', { class: 'ename', text: e.name })]),
          h('span', { class: 'c-size num', role: 'cell', text: e.sizeText }),
          h('span', { class: 'c-files num', role: 'cell', 'data-label': e.filesText ? L.colFiles + ': ' : null, title: e.filesTip || null, text: e.filesText }),
          h('span', { class: 'c-where', role: 'cell' }, where),
          h('span', { class: 'c-acts', role: 'cell' }, e.pathId ? [
            iconBtn(L.reveal, 'folder-opened', { act: 'reveal', id: e.pathId, fk: 'reveal:' + e.key }),
            iconBtn(L.copyPath, 'copy', { act: 'copyPath', id: e.pathId, fk: 'copy:' + e.key }),
          ] : []),
        ]));
      }
      kids.push(h('div', { class: 'etable', role: 'table', 'aria-label': d.heading }, rows));
    }
    if (d.app === 'claude' && vm.retention) {
      kids.push(h('p', { class: 'retention', title: vm.retention.tip }, [
        icon('history'),
        h('span', { class: 'r-label', text: vm.retention.label }),
        h('span', { text: vm.retention.text }),
        h('span', { class: 'muted r-tip', text: vm.retention.tip }),
      ]));
    }
    return h('section', { class: 'sec', 'aria-label': d.heading }, kids);
  }

  function volumesSection(v, L) {
    const items = v.rows.map((r) => h('li', { class: 'vol' + (r.low ? ' low' : '') }, [
      h('span', { class: 'v-name' }, [icon('server'), h('span', { class: 'v-title', text: r.name }), r.mountText ? h('code', { class: 'muted', text: r.mountText }) : null]),
      r.usedPct == null ? h('span') : h('span', { class: 'meter', role: 'meter', 'aria-label': r.meterLabel, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(r.usedPct), title: r.usedText }, [
        h('span', { class: 'meter-fill', style: null }),
      ]),
      h('span', { class: 'v-free', text: r.freeText }),
      h('span', { class: 'v-tags' }, r.tags.map((x) => h('span', { class: 'tag', text: x }))),
      h('span', { class: 'c-acts' }, [iconBtn(L.reveal, 'folder-opened', { act: 'reveal', id: r.pathId, fk: 'reveal:' + r.key })]),
    ]));
    const list = h('ul', { class: 'vols' }, items);
    // CSP disallows inline style attributes, so set widths via the CSSOM
    v.rows.forEach((r, i) => {
      const fill = items[i].querySelector('.meter-fill');
      if (fill) fill.style.width = r.usedPct + '%';
    });
    return h('section', { class: 'sec', 'aria-label': v.heading }, [h('h2', { text: v.heading }), list]);
  }

  function stepItem(app, kind, s, L) {
    const kids = [h('p', { class: 'st-text', text: s.text })];
    if (s.code) {
      kids.push(h('pre', { class: 'code', tabindex: '0' }, [h('code', { text: s.code })]));
      const acts = [];
      // Until the confirmation is ticked, copy and send-to-terminal are disabled (the tooltip explains why)
      const lock = ack || !vm.migrate.disclaimer ? null : vm.migrate.disclaimer.locked;
      if (s.actions.indexOf('copy') >= 0) {
        acts.push(btn(s.part === 'commands' ? L.copy : L.copyOne, 'copy', { act: 'copy', app, kind, part: s.part, fk: 'copy:' + app + kind + s.part }, { primary: s.part === 'commands', locked: lock }));
      }
      if (s.actions.indexOf('terminal') >= 0) {
        acts.push(btn(L.terminal, 'terminal', { act: 'terminal', app, kind, fk: 'term:' + app + kind }, { title: L.terminalTip, locked: lock }));
      }
      kids.push(h('div', { class: 'st-acts' }, acts));
    }
    return h('li', { class: 'step' }, kids);
  }

  // Migration plan disclaimer and confirmation checkbox
  function disclaimer(D) {
    const box = h('input', { type: 'checkbox', id: 'ack', 'data-fk': 'ack', checked: ack });
    return h('div', { class: 'disclaimer', role: 'note', 'aria-labelledby': 'disc-title' }, [
      h('h3', { id: 'disc-title' }, [icon('warning'), h('span', { text: D.title })]),
      h('ul', null, D.items.map((x) => h('li', { text: x }))),
      h('label', { class: 'ack', for: 'ack' }, [box, h('span', { text: D.ack })]),
    ]);
  }

  function card(c, L) {
    const sel = state.plan[c.app] === 'env' ? 'env' : 'symlink';
    const kids = [h('h3', null, [h('span', { text: c.heading }), c.sizeText ? h('span', { class: 'muted size', text: c.sizeText }) : null])];
    if (c.live) {
      kids.push(banner('warning', 'warning', c.live.text,
        h('ul', { class: 'live' }, c.live.items.map((x) => h('li', { text: x })))));
    }
    // Target folder
    kids.push(h('div', { class: 'target' }, [
      h('span', { class: 'f-label', text: L.base }),
      h('span', { class: 'f-val' }, [
        c.target.text ? h('code', { class: 'path', text: c.target.text, title: c.target.text }) : null,
        h('span', { class: 'muted', text: c.target.note }),
      ]),
      h('span', { class: 'f-acts' }, [
        btn(L.choose, 'folder', { act: 'pick', app: c.app, fk: 'pick:' + c.app }),
        c.target.custom ? btn(L.reset, 'discard', { act: 'reset', app: c.app, fk: 'reset:' + c.app }) : null,
      ]),
    ]));
    kids.push(h('p', { class: 'hint muted', text: c.target.hint }));
    for (const w of c.warnings) kids.push(banner('warning', 'warning', w));
    // Plan switcher
    const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': L.plans }, c.plans.map((p) => h('button', {
      type: 'button', class: 'tab', role: 'tab', id: 'tab-' + c.app + '-' + p.kind, 'aria-selected': p.kind === sel ? 'true' : 'false',
      'aria-controls': 'panel-' + c.app, 'data-act': 'plan', 'data-app': c.app, 'data-kind': p.kind, 'data-fk': 'tab:' + c.app + p.kind,
    }, [h('span', { text: p.label }), h('span', { class: 'badge', text: p.badge })])));
    kids.push(tabs);
    const p = c.plans.find((x) => x.kind === sel) || c.plans[0];
    const pk = [h('p', { class: 'desc', text: p.desc })];
    if (p.info) {
      pk.push(banner('info', 'info', p.info, p.infoId ? h('span', { class: 'b-acts' }, [
        iconBtn(L.reveal, 'folder-opened', { act: 'reveal', id: p.infoId, fk: 'reveal:info' + c.app }),
        iconBtn(L.copyPath, 'copy', { act: 'copyPath', id: p.infoId, fk: 'copy:info' + c.app }),
      ]) : null));
    }
    if (p.errorText) pk.push(banner('error', 'error', p.errorText));
    if (p.fromText) {
      pk.push(h('dl', { class: 'fromto' }, [
        h('dt', { text: L.from }), h('dd', null, [h('code', { class: 'path', text: p.fromText, title: p.fromText })]),
        h('dt', { text: L.to }), h('dd', null, [h('code', { class: 'path', text: p.toText, title: p.toText })]),
      ]));
    }
    for (const w of p.warnings) pk.push(banner('warning', 'warning', w));
    if (p.steps.length) pk.push(h('ol', { class: 'steps' }, p.steps.map((s) => stepItem(c.app, p.kind, s, L))));
    if (p.notes.length) pk.push(h('ul', { class: 'pnotes' }, p.notes.map((x) => h('li', { text: x }))));
    kids.push(h('div', { class: 'panel', role: 'tabpanel', id: 'panel-' + c.app, 'aria-labelledby': 'tab-' + c.app + '-' + p.kind }, pk));
    return h('article', { class: 'card', 'aria-label': c.heading }, kids);
  }

  function render() {
    if (!vm) return;
    const L = vm.labels;
    const focusKey = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-fk');
    status.textContent = vm.statusText || '';
    // While scanning, keep the refresh button enabled (disabled colors have too little contrast); just swap its icon for a spinner
    const refresh = $('refresh');
    refresh.querySelector('span').textContent = L.refresh;
    refresh.querySelector('.codicon').className = 'codicon ' + (vm.loading ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh');
    refresh.setAttribute('aria-busy', vm.loading ? 'true' : 'false');
    const kids = [];
    kids.push(h('p', { class: 'intro', text: vm.intro }));
    if (vm.errorText) kids.push(banner('error', 'error', vm.errorText));
    if (vm.partialText) kids.push(banner('warning', 'warning', vm.partialText));
    for (const d of vm.dirs) kids.push(dirSection(d, L));
    if (vm.volumes && vm.volumes.rows.length) kids.push(volumesSection(vm.volumes, L));
    if (vm.migrate && vm.migrate.cards.length) {
      kids.push(h('section', { class: 'sec mig', 'aria-label': vm.migrate.heading }, [
        h('h2', { text: vm.migrate.heading }),
        h('p', { text: vm.migrate.why }),
        vm.migrate.disclaimer ? disclaimer(vm.migrate.disclaimer) : null,
        ...vm.migrate.cards.map((c) => card(c, L)),
      ]));
    }
    if (vm.notes) {
      kids.push(h('section', { class: 'sec notes', 'aria-label': vm.notes.heading }, [
        h('h2', { text: vm.notes.heading }),
        h('ul', null, vm.notes.items.map((x) => h('li', { text: x }))),
      ]));
    }
    if (vm.footer && vm.dirs.length) kids.push(h('p', { class: 'foot muted', text: vm.footer }));
    root.replaceChildren(...kids);
    if (focusKey) {
      const el = Array.prototype.find.call(document.querySelectorAll('[data-fk]'), (x) => x.getAttribute('data-fk') === focusKey);
      if (el) el.focus();
    }
  }

  // ---------- Events ----------

  document.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!b || b.disabled) return;
    const d = b.dataset;
    switch (d.act) {
      case 'refresh': vscode.postMessage({ type: 'refresh' }); break;
      case 'reveal': vscode.postMessage({ type: 'reveal', id: d.id }); break;
      case 'copyPath': vscode.postMessage({ type: 'copyPath', id: d.id }); break;
      case 'pick': vscode.postMessage({ type: 'pickTarget', app: d.app }); break;
      case 'reset': vscode.postMessage({ type: 'resetTarget', app: d.app }); break;
      case 'copy': vscode.postMessage({ type: 'copy', app: d.app, kind: d.kind, part: d.part, ack }); break;
      case 'terminal': vscode.postMessage({ type: 'terminal', app: d.app, kind: d.kind, ack }); break;
      case 'plan':
        state.plan[d.app] = d.kind === 'env' ? 'env' : 'symlink';
        save();
        render();
        break;
      default:
    }
  });

  // Ticking / unticking the confirmation re-renders, enabling or disabling the buttons accordingly
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el || el.id !== 'ack') return;
    ack = !!el.checked;
    render();
  });

  // Plan switcher: left / right arrow keys
  document.addEventListener('keydown', (ev) => {
    const b = ev.target;
    if (!b || !b.classList || !b.classList.contains('tab')) return;
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    const tabs = Array.prototype.slice.call(b.parentElement.querySelectorAll('.tab'));
    const i = tabs.indexOf(b);
    const next = tabs[(i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    if (next) { ev.preventDefault(); next.click(); const again = document.getElementById(next.id); if (again) again.focus(); }
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || m.type !== 'vm' || !m.vm) return;
    vm = m.vm;
    render();
  });

  status.textContent = t('storage.page.loading');
  vscode.postMessage({ type: 'ready' });
})();
