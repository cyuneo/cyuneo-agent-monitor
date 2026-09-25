'use strict';
// Sidebar overview tree: session → main agent / subagents / workflows → workflow agents.
// Consumes Snapshot v2: lamps come from lib/lamp.js, and all text goes through lib/format.js + i18n (no hard-coded UI strings).
// Ordering is fixed by lib/order.js: sessions by start time, newest first; agents by start time, oldest first; never reordered by status.
// Node objects are cached by id and keep their identity; each update fires only for nodes whose rendered output changed.
// Hover tooltips are built on demand in resolveTreeItem and are not part of the signature.
// Session row text (sessionRowVm) is shared with the session list in the bottom panel and is defined in lib/agents-view.js.
// Also exports Markdown escaping and table helpers, shared with the status bar.

const vscode = require('vscode');
const fmt = require('./format');
const { lampVisual, sessionLamps } = require('./lamp');
const { createSessionOrder, createAgentOrder, ROW_MAIN } = require('./order');
const S = require('./core/status');
const { contextZone, sessionRowVm, ZONE_MARK } = require('./agents-view');
const { worthTrying } = require('./jump');

const None = vscode.TreeItemCollapsibleState.None;
const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;
const Expanded = vscode.TreeItemCollapsibleState.Expanded;
const SEP = fmt.SEP;
const ACTIVE = new Set([S.LAMP.WORKING, S.LAMP.NEEDS_YOU]);

class AgentTreeProvider {
  /**
   * @param {{ i18n: any, now?: () => number, hideCompleted?: boolean, showCost?: boolean }} o
   */
  constructor(o) {
    this.i18n = o.i18n;
    this.now = o.now || Date.now;
    this.hideCompleted = !!o.hideCompleted;
    this.showCost = o.showCost !== false;
    this.sessionOrder = createSessionOrder({ now: this.now });
    this.agentOrder = createAgentOrder({ now: this.now });
    this.last = null;       // { sessions, lamps, now }
    this.nodes = new Map(); // id -> node
    this.roots = [];
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  dispose() { this.emitter.dispose(); }

  /**
   * @param {{ sessions: any[], lamps?: Map<string, any>, now?: number, hideCompleted?: boolean, showCost?: boolean,
   *   hints?: { start?: number, act?: number } }} data
   *   sessions are already filtered by the view scope; lamps is computeLamps(...).bySession; hints are contextHintStart / contextHintAct
   */
  update(data) {
    if (data.hideCompleted != null) this.hideCompleted = !!data.hideCompleted;
    if (data.showCost != null) this.showCost = data.showCost !== false;
    if (data.hints) this.hints = data.hints;
    this.last = { sessions: data.sessions || [], lamps: data.lamps || new Map(), now: data.now };
    this.rebuild();
  }

  setFilter(filter) {
    if (filter && filter.hideCompleted != null) this.hideCompleted = !!filter.hideCompleted;
    this.rebuild();
  }

  // Rebuild the whole tree from the latest data and notify VS Code only about nodes that changed
  rebuild() {
    if (!this.last) return;
    const i18n = this.i18n;
    const now = this.last.now ?? this.now();
    const next = new Map();
    const dirty = new Set();
    const oldRoots = this.roots;

    const sync = (id, kind, parent, data, vmOf, kids) => {
      let node = this.nodes.get(id);
      const isNew = !node || node.kind !== kind;
      if (isNew) node = { id, kind, parent, children: [], data, extra: null, vm: null, sig: '', open: null };
      node.parent = parent;
      node.data = data;
      next.set(id, node);
      const oldKids = node.children;
      node.children = kids ? kids(node) : [];
      const vm = vmOf(node);
      const sig = sigOf(vm);
      if (!isNew && (sig !== node.sig || !sameIds(oldKids, node.children))) dirty.add(node);
      node.vm = vm;
      node.sig = sig;
      return node;
    };

    const agentNode = (id, parent, s, rowId, agent, L) => sync(id, rowId === ROW_MAIN ? 'main' : 'agent', parent, agent, (node) => {
      node.extra = { session: s, rowId, lamps: L };
      return agentVm(agent, L.rows.get(rowId), rowId === ROW_MAIN, i18n, now, s.provider);
    });

    const sessNode = (s) => {
      const L = this.last.lamps.get(s.key) || sessionLamps(s);
      return sync(s.key, 'session', null, s, (node) => {
        node.key = s.key; // command arguments (compact, resume, mark as seen) look up the session by key
        node.extra = { lamps: L };
        if (node.open == null) node.open = ACTIVE.has(L.lamp) ? Expanded : Collapsed;
        return sessionVm(s, L, node.open, i18n, now, this.hints);
      }, (node) => {
        const rows = this.agentOrder.arrange(s, { hideCompleted: this.hideCompleted });
        const kids = [];
        let wf = null;
        for (const row of rows) {
          const id = `${s.key}/${row.id}`;
          if (row.kind === 'workflow') {
            wf = { row, id, agents: [] };
            kids.push(wf);
          } else if (row.kind === 'workflowAgent') {
            if (wf && row.parentId === wf.row.id) wf.agents.push(row);
          } else {
            kids.push(agentNode(id, node, s, row.id, row.agent, L));
          }
        }
        return kids.map((k) => (k && k.row ? workflowNode(k, node, s, L) : k));
      });
    };

    const workflowNode = (k, parent, s, L) => sync(k.id, 'workflow', parent, k.row.workflow, (node) => {
      node.extra = { session: s, rowId: k.row.id, lamps: L };
      if (node.open == null) node.open = k.row.workflow.state === 'running' ? Expanded : Collapsed;
      return workflowVm(k.row.workflow, L.rows.get(k.row.id), node.children.length ? node.open : None, i18n);
    }, (node) => k.agents.map((row) => agentNode(`${s.key}/${row.id}`, node, s, row.id, row.agent, L)));

    const arranged = this.sessionOrder.arrange(this.last.sessions, { grouped: false });
    const roots = arranged.list.map(sessNode);

    this.nodes = next; // nodes that disappeared are dropped along with the old Map
    this.roots = roots;
    if (!sameIds(oldRoots, roots)) { this.emitter.fire(undefined); return; }
    // If an ancestor is already being refreshed, skip this one (refreshing a parent re-fetches its children)
    const list = [...dirty].filter((n) => {
      for (let p = n.parent; p; p = p.parent) if (dirty.has(p)) return false;
      return true;
    });
    if (list.length) this.emitter.fire(list);
  }

  getTreeItem(node) {
    const vm = node.vm;
    const item = new vscode.TreeItem(vm.label, vm.collapsible);
    item.id = node.id;
    item.description = vm.description;
    item.iconPath = new vscode.ThemeIcon(vm.icon, new vscode.ThemeColor(vm.color));
    item.contextValue = vm.contextValue;
    item.accessibilityInformation = { label: vm.a11y };
    return item;
  }

  resolveTreeItem(item, node) {
    if (node) item.tooltip = this.tooltip(node);
    return item;
  }

  /** Hover tooltip: computed from the latest data, may include elapsed time */
  tooltip(node, now = this.now()) {
    const i18n = this.i18n;
    if (node.kind === 'session') {
      return sessionTooltip(node.data, node.extra && node.extra.lamps, i18n, { now, showCost: this.showCost, hints: this.hints });
    }
    if (node.kind === 'workflow') return workflowTooltip(node.data, node.extra, i18n);
    return agentTooltip(node.data, node.extra, i18n, { now, showCost: this.showCost });
  }

  getChildren(node) { return node ? node.children : this.roots; }

  getParent(node) { return node.parent || undefined; }
}

// ---------- Render data for each node type (also the source of the signature; nothing that changes every second) ----------

// contextValue gets "goTo" when the inline Go to Chat action is offered (lib/jump.js worthTrying; the context menu always has it)
function sessionVm(s, L, open, i18n, now, hints) {
  const vm = sessionRowVm(s, L, i18n, now, hints);
  return { ...vm, contextValue: worthTrying(s, now) ? vm.contextValue + ' goTo' : vm.contextValue, collapsible: open };
}

// Agent row: context tokens · current step (while running) or one-line status
function agentStateText(agent, rowLamp, isMain, i18n, now) {
  const st = (rowLamp && rowLamp.status) || agent.status;
  const lamp = rowLamp ? rowLamp.lamp : S.LAMP.IDLE;
  const status = fmt.formatStatus(st, agent, i18n, now, { stable: true, isMain });
  if (lamp !== S.LAMP.WORKING) return status;
  return fmt.formatStep(agent.step, st, i18n, now) || status;
}

function agentVm(agent, rowLamp, isMain, i18n, now, provider) {
  const lamp = rowLamp ? rowLamp.lamp : S.LAMP.IDLE;
  const look = lampVisual(lamp);
  const label = fmt.formatAgentName(agent, i18n);
  // Token counts never recorded (Copilot sub-agents, Copilot chats without usage): "—", not "0"
  const unknown = fmt.tokensUnknown(agent, provider);
  const tokens = unknown ? i18n.fmtTokens(null) : i18n.fmtTokens(agent.tokens ? agent.tokens.display : 0);
  const state = agentStateText(agent, rowLamp, isMain, i18n, now);
  return {
    label,
    description: [tokens, state].filter(Boolean).join(SEP),
    icon: look.shape,
    color: look.colorId,
    collapsible: None,
    contextValue: isMain ? 'mainAgent' : 'agent',
    a11y: [label, fmt.lampLabel(lamp, i18n), state, unknown ? i18n.t('ctx.unknown') : i18n.t('count.tokens', { n: tokens })].join(', '),
  };
}

function workflowVm(w, rowLamp, collapsible, i18n) {
  const lamp = rowLamp ? rowLamp.lamp : S.LAMP.IDLE;
  const look = lampVisual(lamp);
  const f = fmt.formatWorkflow(w, i18n);
  const parts = [f.stateText, f.progressText, f.phaseText, i18n.fmtTokens(w.tokens || 0)].filter(Boolean);
  return {
    label: f.name,
    description: parts.join(SEP),
    icon: look.shape,
    color: look.colorId,
    collapsible,
    contextValue: 'workflow',
    a11y: [i18n.t('workflow.label'), f.name, fmt.lampLabel(lamp, i18n), ...parts].join(', '),
  };
}

// ---------- Hover tooltips (MarkdownString; all user text escaped) ----------

function badge(lamp) {
  const icon = S.LAMP_BADGE_ICON[lamp];
  return icon ? `$(${icon}) ` : '';
}

/**
 * Session hover tooltip (overview tree; the session list in the bottom panel uses the plain-text sessionTipText from agents-view.js).
 * @param {any} s Session
 * @param {any} [L] result of sessionLamps
 */
function sessionTooltip(s, L, i18n, o = {}) {
  const lamps = L || sessionLamps(s);
  const rows = fmt.formatSessionTooltip(s, i18n, { lamps, now: o.now, showCost: o.showCost });
  const cells = rows.map(([k, v], i) => [esc(k), (i === 0 ? badge(lamps.lamp) : '') + esc(v)]);
  let text = `**${esc(s.title || s.id)}**\n\n${mdTable(cells)}`;
  const zone = contextZone(fmt.sessionContextTokens(s), o.hints || {});
  if (zone) {
    // Explanation of the context zone marker: what to do, start a new session for a new task, and the basis for the advice
    text += `\n\n${ZONE_MARK[zone]} **${esc(i18n.t('webview.zone.' + zone))}**: ${esc(i18n.t('webview.zone.' + zone + '.tip'))}  \n`
      + `${esc(i18n.t('webview.zone.newTask'))}  \n*${esc(i18n.t('webview.zone.basis'))}*`;
  }
  if (o.showCost !== false && rows.some(([k]) => k === i18n.t('cost.label') || k === i18n.t('cost.credits.label'))) {
    text += `\n\n*${esc(fmt.formatCostNote(i18n, s.provider))}*`;
  }
  return new vscode.MarkdownString(text, true);
}

function agentTooltip(agent, extra, i18n, o = {}) {
  const now = o.now ?? Date.now();
  const rowId = extra && extra.rowId;
  const provider = extra && extra.session ? extra.session.provider : undefined;
  const L = extra && extra.lamps;
  const rowLamp = L && L.rows.get(rowId);
  const isMain = rowId === ROW_MAIN;
  const st = (rowLamp && rowLamp.status) || agent.status;
  const lamp = rowLamp ? rowLamp.lamp : S.LAMP.IDLE;
  const rows = [[fmt.lampLabel(lamp, i18n), fmt.formatStatus(st, agent, i18n, now, { isMain })]];
  const note = fmt.formatStatusNote(st, i18n);
  if (note) rows.push([i18n.t('tip.note'), note]);
  const step = fmt.formatStep(agent.step, st, i18n, now, { withDur: true });
  if (step) rows.push([i18n.t('tree.tip.step'), step]);
  const ctx = fmt.formatContext(fmt.agentContextTokens(agent, provider), i18n);
  const ctxText = [ctx.usageText, ctx.remainText, ctx.pctOfWindowText].filter(Boolean).join(SEP);
  if (ctxText) rows.push([i18n.t('ctx.label'), ctxText]);
  if (agent.model) rows.push([i18n.t('tip.model'), String(agent.model)]);
  rows.push([i18n.t('tree.tip.kind'), fmt.formatAgentKind(agent, i18n)]);
  // Copilot always gets a row: its credits, or where they are counted
  if (o.showCost !== false && (Number.isFinite(agent.costUsd) || agent.unpricedModel || provider === 'copilot')) {
    const c = fmt.formatAgentCost(agent, i18n, { provider });
    rows.push([c.label, c.full]);
  }
  const t = agent.tokens || {};
  // Token counts never recorded (Copilot sub-agents, Copilot chats without usage): say so instead of "0 output · 0 processed"
  const unknown = ctx.unknown;
  const counts = [
    unknown ? fmt.formatTokensUnknownNote(agent, provider, i18n)
      : i18n.t('tree.tip.tokens', { output: i18n.fmtTokens(t.output || 0), processed: i18n.fmtTokens(t.processed || 0) }),
    i18n.t('count.apiCalls', { n: i18n.fmtNum(unknown && !(t.apiCalls > 0) ? null : t.apiCalls || 0) }),
    i18n.t('count.toolCalls', { n: i18n.fmtNum(agent.toolCalls || 0) }),
    agent.toolErrors ? i18n.t('count.toolErrors', { n: i18n.fmtNum(agent.toolErrors) }) : '',
    agent.filesChanged ? i18n.t('count.filesChanged', { n: i18n.fmtNum(agent.filesChanged) }) : '',
  ].filter(Boolean);
  const cells = rows.map(([k, v], i) => [esc(k), (i === 0 ? badge(lamp) : '') + esc(v)]);
  const text = `**${esc(fmt.formatAgentName(agent, i18n))}**\n\n${mdTable(cells)}\n\n${esc(counts.join(SEP))}`;
  return new vscode.MarkdownString(text, true);
}

function workflowTooltip(w, extra, i18n) {
  const L = extra && extra.lamps;
  const rowLamp = L && L.rows.get(extra.rowId);
  const lamp = rowLamp ? rowLamp.lamp : S.LAMP.IDLE;
  const f = fmt.formatWorkflow(w, i18n);
  const rows = [
    [fmt.lampLabel(lamp, i18n), [f.stateText, f.progressText].filter(Boolean).join(SEP)],
    f.phaseText && [i18n.t('workflow.label'), f.phaseText],
    [i18n.t('ctx.label'), i18n.t('tree.tip.workflowTokens', { tokens: i18n.fmtTokens(w.tokens || 0), out: i18n.fmtTokens(w.outTokens || 0) })],
    [i18n.t('tip.id'), String(w.id || '')],
  ].filter(Boolean);
  const cells = rows.map(([k, v], i) => [esc(k), (i === 0 ? badge(lamp) : '') + esc(v)]);
  return new vscode.MarkdownString(`**${esc(f.name)}**\n\n${mdTable(cells)}`, true);
}

// ---------- Helpers ----------

function sigOf(vm) {
  return [vm.label, vm.description, vm.icon, vm.color, vm.collapsible, vm.contextValue, vm.a11y].join('\u0001');
}

function sameIds(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

/**
 * Two-column Markdown table: the first row is the header (bold) and holds the most important item, "Status". Cells must already be escaped.
 * @param {[string, string][]} rows
 */
function mdTable(rows) {
  if (!rows.length) return '';
  const line = ([k, v]) => `| ${k} | ${v} |`;
  return [line(rows[0]), '| :-- | :-- |', ...rows.slice(1).map(line)].join('\n');
}

// Markdown escaping: markup characters, table separators and $(icon) syntax in user text are shown literally.
// VS Code renders Markdown to HTML first and then replaces $(name) with icons, so \$\(x\) still renders
// as $(x) and still turns into an icon (a common Bash $(pwd) would simply vanish). Following its rules, write \$(x) and leave the parentheses unescaped.
const ICON_RE = /\$\([A-Za-z0-9-]+(?:~[A-Za-z]+)?\)/g;
function esc(t) {
  const s = String(t == null ? '' : t).replace(/\s+/g, ' ');
  let out = '';
  let at = 0;
  for (const m of s.matchAll(ICON_RE)) {
    out += escMd(s.slice(at, m.index)) + '\\' + m[0];
    at = m.index + m[0].length;
  }
  return out + escMd(s.slice(at));
}

function escMd(t) {
  return t.replace(/[\\`*_{}[\]()#+\-.!|<>~$&]/g, '\\$&');
}

module.exports = { AgentTreeProvider, sessionRowVm, sessionTooltip, agentTooltip, workflowTooltip, esc, mdTable };
