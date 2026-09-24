'use strict';
// 侧边栏总览树（DESIGN §1.3、§8.1）：会话 → 主智能体 / 子智能体 / 工作流 → 工作流智能体。
// 吃 Snapshot v2：灯用 lib/lamp.js，文字全部走 lib/format.js + i18n，没有中文硬编码。
// 顺序用 lib/order.js 锁定（§11.3）：会话按开始时间倒序，智能体按开始时间正序，永不按状态重排。
// 节点对象按 id 缓存、身份不变；每次只对渲染结果变了的节点 fire；
// 悬停提示在 resolveTreeItem 里按需生成，不进签名。
// 会话行的文字（sessionRowVm）和底部面板的会话列表共用，定义在 lib/agents-view.js（§11.13）。
// 另导出 Markdown 转义与表格小工具，状态栏共用。

const vscode = require('vscode');
const fmt = require('./format');
const { lampVisual, sessionLamps } = require('./lamp');
const { createSessionOrder, createAgentOrder, ROW_MAIN } = require('./order');
const S = require('./core/status');
const { contextZone, sessionRowVm, ZONE_MARK } = require('./agents-view');

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
    this.nodes = new Map(); // id -> 节点
    this.roots = [];
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  dispose() { this.emitter.dispose(); }

  /**
   * @param {{ sessions: any[], lamps?: Map<string, any>, now?: number, hideCompleted?: boolean, showCost?: boolean,
   *   hints?: { start?: number, act?: number } }} data
   *   sessions 已按查看范围过滤；lamps 是 computeLamps(...).bySession；hints 是 contextHintStart / contextHintAct
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

  // 用最近一次数据重算整棵树，只把变了的节点通知给 VS Code
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
      return agentVm(agent, L.rows.get(rowId), rowId === ROW_MAIN, i18n, now);
    });

    const sessNode = (s) => {
      const L = this.last.lamps.get(s.key) || sessionLamps(s);
      return sync(s.key, 'session', null, s, (node) => {
        node.key = s.key; // 命令参数（压缩、续跑、已看过）按 key 找会话
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

    this.nodes = next; // 消失的节点随旧 Map 一起丢掉
    this.roots = roots;
    if (!sameIds(oldRoots, roots)) { this.emitter.fire(undefined); return; }
    // 祖先已经要刷新的，就不用再单独刷（刷父节点会连带重取子节点）
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

  /** 悬停提示：按最新数据现算，可以带用时 */
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

// ---------- 各类节点的渲染数据（也是签名的来源；不含逐秒变化的内容） ----------

function sessionVm(s, L, open, i18n, now, hints) {
  return { ...sessionRowVm(s, L, i18n, now, hints), collapsible: open };
}

// 智能体一行：上下文 token · 当前步骤（在跑时）或一句状态
function agentStateText(agent, rowLamp, isMain, i18n, now) {
  const st = (rowLamp && rowLamp.status) || agent.status;
  const lamp = rowLamp ? rowLamp.lamp : S.LAMP.IDLE;
  const status = fmt.formatStatus(st, agent, i18n, now, { stable: true, isMain });
  if (lamp !== S.LAMP.WORKING) return status;
  return fmt.formatStep(agent.step, st, i18n, now) || status;
}

function agentVm(agent, rowLamp, isMain, i18n, now) {
  const lamp = rowLamp ? rowLamp.lamp : S.LAMP.IDLE;
  const look = lampVisual(lamp);
  const label = fmt.formatAgentName(agent, i18n);
  const tokens = i18n.fmtTokens(agent.tokens ? agent.tokens.display : 0);
  const state = agentStateText(agent, rowLamp, isMain, i18n, now);
  return {
    label,
    description: [tokens, state].filter(Boolean).join(SEP),
    icon: look.shape,
    color: look.colorId,
    collapsible: None,
    contextValue: isMain ? 'mainAgent' : 'agent',
    a11y: [label, fmt.lampLabel(lamp, i18n), state, i18n.t('count.tokens', { n: tokens })].join(', '),
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

// ---------- 悬停提示（MarkdownString，用户文本全部转义） ----------

function badge(lamp) {
  const icon = S.LAMP_BADGE_ICON[lamp];
  return icon ? `$(${icon}) ` : '';
}

/**
 * 会话的悬停提示（总览树；底部面板会话列表用 agents-view.js 的纯文本版 sessionTipText）。
 * @param {any} s Session
 * @param {any} [L] sessionLamps 的结果
 */
function sessionTooltip(s, L, i18n, o = {}) {
  const lamps = L || sessionLamps(s);
  const rows = fmt.formatSessionTooltip(s, i18n, { lamps, now: o.now, showCost: o.showCost });
  const cells = rows.map(([k, v], i) => [esc(k), (i === 0 ? badge(lamps.lamp) : '') + esc(v)]);
  let text = `**${esc(s.title || s.id)}**\n\n${mdTable(cells)}`;
  const zone = contextZone(fmt.sessionContextTokens(s), o.hints || {});
  if (zone) {
    // 区标记的说明（§11.8 第 1、4 条）：做法、换任务开新会话、依据
    text += `\n\n${ZONE_MARK[zone]} **${esc(i18n.t('webview.zone.' + zone))}**: ${esc(i18n.t('webview.zone.' + zone + '.tip'))}  \n`
      + `${esc(i18n.t('webview.zone.newTask'))}  \n*${esc(i18n.t('webview.zone.basis'))}*`;
  }
  if (o.showCost !== false && rows.some(([k]) => k === i18n.t('cost.label'))) {
    text += `\n\n*${esc(fmt.formatCostNote(i18n))}*`;
  }
  return new vscode.MarkdownString(text, true);
}

function agentTooltip(agent, extra, i18n, o = {}) {
  const now = o.now ?? Date.now();
  const rowId = extra && extra.rowId;
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
  const ctx = fmt.formatContext(agent.tokens, i18n);
  const ctxText = [ctx.usageText, ctx.remainText, ctx.pctOfWindowText].filter(Boolean).join(SEP);
  if (ctxText) rows.push([i18n.t('ctx.label'), ctxText]);
  if (agent.model) rows.push([i18n.t('tip.model'), String(agent.model)]);
  rows.push([i18n.t('tree.tip.kind'), fmt.formatAgentKind(agent, i18n)]);
  if (o.showCost !== false && (Number.isFinite(agent.costUsd) || agent.unpricedModel)) {
    rows.push([i18n.t('cost.label'), fmt.formatCost(agent.costUsd, i18n, { unpriced: agent.unpricedModel, estimated: agent.costEstimated })]);
  }
  const t = agent.tokens || {};
  const counts = [
    i18n.t('tree.tip.tokens', { output: i18n.fmtTokens(t.output || 0), processed: i18n.fmtTokens(t.processed || 0) }),
    i18n.t('count.apiCalls', { n: i18n.fmtNum(t.apiCalls || 0) }),
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

// ---------- 小工具 ----------

function sigOf(vm) {
  return [vm.label, vm.description, vm.icon, vm.color, vm.collapsible, vm.contextValue, vm.a11y].join('\u0001');
}

function sameIds(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

/**
 * 两列 Markdown 表：第一行当表头（加粗），放最重要的“状态”。单元格要事先转义好。
 * @param {[string, string][]} rows
 */
function mdTable(rows) {
  if (!rows.length) return '';
  const line = ([k, v]) => `| ${k} | ${v} |`;
  return [line(rows[0]), '| :-- | :-- |', ...rows.slice(1).map(line)].join('\n');
}

// Markdown 转义：用户文本里的标记符、表格分隔符、$(图标) 语法都原样显示。
// VS Code 先把 Markdown 渲染成 HTML，再把其中的 $(名字) 换成图标，所以 \$\(x\) 渲染后
// 仍是 $(x)、照样变图标（Bash 里常见的 $(pwd) 会直接消失）。按它的规矩写成 \$(x)，括号不转义。
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
