'use strict';
// Behavior tests for the session list and the overview tree: the session list in the bottom panel (lib/agents-view.js
// buildSessionList + incremental sync in media/session-list.js) and lib/tree.js (the sidebar overview).
// Plain node: node test/tree.test.js. All data is synthetic Snapshot v2 sessions; ~/.claude and ~/.codex are never read.
// Focus: stable order, only rows that really changed are updated (list messages carry nothing that changes every second),
// incremental updates by key, and tooltips that show user text verbatim.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---------- vscode stub (including l10n, tabGroups, TabInputWebview, TabInputCustom) ----------

class EventEmitter {
  constructor() {
    this.fns = [];
    this.event = (fn) => { this.fns.push(fn); return { dispose: () => { this.fns = this.fns.filter((f) => f !== fn); } }; };
  }
  fire(e) { for (const fn of [...this.fns]) fn(e); }
  dispose() { this.fns = []; }
}
class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString {
  constructor(value = '', supportThemeIcons = false) { this.value = value; this.supportThemeIcons = supportThemeIcons; }
  appendMarkdown(v) { this.value += v; return this; }
}
const vscode = {
  EventEmitter, TreeItem, ThemeIcon, ThemeColor, MarkdownString,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TabInputWebview: class { constructor(viewType) { this.viewType = viewType; } },
  TabInputCustom: class { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } },
  l10n: { t: (s) => s },
  env: { language: 'en' },
  window: { tabGroups: { activeTabGroup: { activeTab: null }, onDidChangeTabs: () => ({ dispose() {} }) } },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscode;
  return origLoad.apply(this, arguments);
};

const S = require(path.join(ROOT, 'lib', 'core', 'status'));
const lampLib = require(path.join(ROOT, 'lib', 'lamp'));
const fmt = require(path.join(ROOT, 'lib', 'format'));
const { createI18n } = require(path.join(ROOT, 'lib', 'i18n'));
const AV = require(path.join(ROOT, 'lib', 'agents-view'));
const LS = require(path.join(ROOT, 'media', 'session-list'));
const { createSessionOrder } = require(path.join(ROOT, 'lib', 'order'));
const { AgentTreeProvider, esc } = require(path.join(ROOT, 'lib', 'tree'));
const i18n = createI18n('en');
const { None, Collapsed, Expanded } = vscode.TreeItemCollapsibleState;

// ---------- Helpers ----------

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`  FAIL  ${name}\n        ${String((err && err.stack) || err).split('\n').slice(0, 5).join('\n        ')}`);
  }
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// Records each provider fire: 'ROOT' means the whole tree, otherwise an array of node ids
function recorder(p) {
  const r = { list: [] };
  p.onDidChangeTreeData((e) => r.list.push(e === undefined ? 'ROOT' : e.map((n) => n.id)));
  r.take = () => r.list.splice(0);
  return r;
}

// Walk from the root: parents, ids and the node cache must all agree, and the cache must hold no unreachable nodes
function walk(p) {
  const seen = new Map();
  const visit = (node, parent) => {
    assert.ok(!seen.has(node.id), `duplicate id ${node.id}`);
    seen.set(node.id, node);
    assert.strictEqual(p.nodes.get(node.id), node, `cached node is not the one in the tree: ${node.id}`);
    assert.strictEqual(p.getParent(node), parent, `wrong getParent: ${node.id}`);
    const item = p.getTreeItem(node);
    assert.strictEqual(item.id, node.id);
    if (item.collapsibleState === None) assert.strictEqual(p.getChildren(node).length, 0, `no expand arrow but has children: ${node.id}`);
    for (const c of p.getChildren(node)) visit(c, node);
  };
  for (const r of p.getChildren()) visit(r, undefined);
  assert.strictEqual(seen.size, p.nodes.size, 'cache holds stale unreachable nodes');
  return seen;
}

// Nodes present in both passes must keep the same object identity
function assertStable(before, after) {
  let same = 0;
  for (const [id, node] of before) {
    if (!after.has(id)) continue;
    assert.strictEqual(after.get(id), node, `node object changed: ${id}`);
    same++;
  }
  return same;
}

// Simulates how VS Code renders a tooltip: markdownEscapeEscapedIcons first, then Markdown backslash-unescaping,
// then $(name) in the HTML text becomes an icon (a backslash-escaped one is shown as is). Returns the text the user sees.
const ICON_SRC = '\\$\\([A-Za-z0-9-]+(?:~[A-Za-z]+)?\\)';
function hoverText(md) {
  let v = md.replace(new RegExp('\\\\' + ICON_SRC, 'g'), (m) => '\\' + m);
  v = v.replace(/\\([!-/:-@[-`{-~])/g, '$1');
  return v.replace(new RegExp('(\\\\)?(' + ICON_SRC + ')', 'g'), (m, e, icon) => (e ? icon : `[icon ${icon.slice(2, -1)}]`));
}

// ---------- Synthetic data (Snapshot v2) ----------

const NOW = Date.parse('2026-09-24T10:00:00Z');
const MIN = 60e3;
const HOUR = 3600e3;
const st = (code, sinceMs, extra) => S.makeStatus(code, sinceMs, extra);
function tokens(used) {
  return { display: used + 500, contextUsed: used, contextWindow: 1000000, compactAt: 967000, toCompact: 967000 - used, output: 900, processed: 40000, apiCalls: 6 };
}
function agent(o = {}) {
  return {
    id: 'main', kind: 'main', name: null, agentType: null, phase: null, background: false,
    model: 'claude-opus-5-5', status: st('thinking', NOW - 5000), step: null,
    tokens: tokens(30000), toolCalls: 2, toolErrors: 0, filesChanged: 0,
    costUsd: 0.12, unpricedModel: null, lastCompact: null, cacheTtl: '1h',
    startedMs: NOW - HOUR, lastActivityMs: NOW - 5000, mtimeMs: NOW - 5000, file: '/synthetic/x.jsonl',
    ...o,
  };
}
function session(o = {}) {
  const provider = o.provider || 'claude';
  return {
    provider, id: o.id, key: `${provider}:${o.id}`,
    title: `Synthetic ${o.id}`, titleSource: 'ai', cwd: '/work/demo', projectDir: '-work-demo',
    entry: 'vscode', entryRaw: 'claude-vscode', entrypoint: 'claude-vscode',
    model: 'claude-opus-5-5', createdMs: NOW - HOUR, updatedMs: NOW - 5000, startedMs: NOW - HOUR,
    doneAtMs: null, live: false, liveStatus: null, waitingFor: null,
    main: agent(), agents: [], workflows: [],
    counts: { running: 1, awaiting: 0, error: 0, done: 0, total: 1 },
    costUsd: 0.5, resume: [],
    ...o,
  };
}
function wf(id, state, agents, o = {}) {
  return {
    id, taskId: null, name: `Workflow ${id}`, scriptPath: null, state, phases: [],
    done: agents.filter((a) => a.status.code === 'done').length, total: agents.length,
    running: agents.filter((a) => S.isRunningCode(a.status.code)).length,
    tokens: 50000, outTokens: 3000, costUsd: 0.2, agents, startedMs: null, ...o,
  };
}

function fixtures() {
  return [
    session({
      id: 'alpha', title: 'Alpha chat', live: true, liveStatus: 'busy', startedMs: NOW - 2 * HOUR,
      main: agent({ status: st('tool', NOW - 4000, { pendingTool: 'Bash' }), step: { kind: 'tool', tool: 'Bash', detail: 'npm test', parallel: 1, sinceMs: NOW - 4000 }, tokens: tokens(84000) }),
      agents: [
        agent({ id: 'sub1', kind: 'subagent', name: 'Explorer', startedMs: NOW - 50 * MIN }),
        agent({ id: 'sub2', kind: 'subagent', name: 'Reviewer', startedMs: NOW - 40 * MIN, status: st('done', NOW - 30 * MIN) }),
      ],
      workflows: [
        wf('wf_run', 'running', [
          agent({ id: 'w1', kind: 'workflowAgent', name: 'Build', startedMs: NOW - 20 * MIN, status: st('tool', NOW - 3000), step: { kind: 'tool', tool: 'Bash', detail: 'make', parallel: 1, sinceMs: NOW - 3000 } }),
          agent({ id: 'w2', kind: 'workflowAgent', name: 'Lint', startedMs: NOW - 19 * MIN, status: st('done', NOW - 10 * MIN) }),
        ]),
        wf('wf_done', 'completed', [agent({ id: 'w3', kind: 'workflowAgent', name: 'Docs', startedMs: NOW - 45 * MIN, status: st('done', NOW - 35 * MIN) })]),
      ],
    }),
    session({
      id: 'beta', title: 'Beta chat', startedMs: NOW - 3 * HOUR, doneAtMs: NOW - 10 * MIN, cwd: '/work/other',
      main: agent({ status: st('done', NOW - 10 * MIN), tokens: tokens(12000) }),
    }),
    session({
      provider: 'codex', id: 'gamma', title: 'Gamma thread', titleSource: 'index', live: true, liveStatus: 'busy', startedMs: NOW - 30 * MIN,
      model: 'gpt-5.5', entryRaw: 'codex_vscode', entrypoint: null,
      main: agent({ model: 'gpt-5.5', status: st('maybeAwaitingApproval', NOW - 2 * MIN, { pendingTool: 'apply_patch' }), cacheTtl: null }),
    }),
    session({
      id: 'delta', title: 'Delta chat', startedMs: NOW - 4 * HOUR,
      main: agent({ status: st('quota', NOW - 20 * MIN, { quota: { kind: 'session', model: null, resetsAtMs: NOW + HOUR, resetsText: null, source: 'text', autoContinue: null } }) }),
    }),
  ];
}
const lampsOf = (sessions, seen = 0) => lampLib.computeLamps(sessions, { seen }).bySession;

// ---------- Session list in the bottom panel ----------

// Stateful list: like the extension, it holds one sorter, arranges each snapshot once, then builds the view model
function listFeeder() {
  const order = createSessionOrder({ now: () => NOW });
  return (sessions, o = {}) => AV.buildSessionList({
    arranged: order.arrange(sessions), lamps: lampsOf(sessions, o.seen || 0), i18n, now: o.now ?? NOW,
    hints: o.hints || {}, showCost: o.showCost, selectedKey: o.selectedKey, position: o.position, width: o.width,
  });
}
const rowsOf = (vm) => vm.items.filter((x) => x.kind === 'session');
const keysOf = (vm) => rowsOf(vm).map((x) => x.key);
const rowOf = (vm, key) => rowsOf(vm).find((x) => x.key === key);
// Session rows whose visible parts differ between two view models (compared by key). Tooltips are left out: they follow
// status and token updates, and the page holds off replacing a row's title while the mouse is over it (swapping it once
// the mouse leaves), which matches a native tree that builds tooltips on demand in resolveTreeItem
const VISIBLE = ['kind', 'key', 'group', 'title', 'desc', 'lamp', 'shape', 'a11y', 'compactable', 'resumable', 'context'];
const visibleOf = (r) => JSON.stringify(VISIBLE.map((k) => r[k]));
function changedRows(a, b) {
  const before = new Map(rowsOf(a).map((r) => [r.key, visibleOf(r)]));
  return rowsOf(b).filter((r) => before.get(r.key) !== visibleOf(r)).map((r) => r.key);
}

// Fake DOM node: only what syncKeyed in media/session-list.js uses; records insertBefore calls and which nodes were created
class FakeNode {
  constructor(label) { this.label = label; this.parent = null; this.kids = []; this.moves = 0; }
  get children() { return this.kids.slice(); }
  get firstChild() { return this.kids[0] || null; }
  get nextSibling() {
    if (!this.parent) return null;
    const k = this.parent.kids;
    return k[k.indexOf(this) + 1] || null;
  }
  insertBefore(node, ref) {
    if (node.parent) node.parent.kids.splice(node.parent.kids.indexOf(node), 1);
    const i = ref ? this.kids.indexOf(ref) : -1;
    this.kids.splice(i < 0 ? this.kids.length : i, 0, node);
    node.parent = this;
    this.moves++;
    return node;
  }
  remove() {
    if (!this.parent) return;
    this.parent.kids.splice(this.parent.kids.indexOf(this), 1);
    this.parent = null;
  }
}
// Syncs the view model into the fake list the same way the page does (media/agents.js renderList)
function pageSync(box, vm, made) {
  LS.syncKeyed(box, vm.items,
    (it) => (it.kind === 'group' ? it.id : 's:' + it.key),
    (it) => { const n = new FakeNode(it.kind === 'group' ? it.id : it.key); made.push(n.label); return n; },
    (node, it) => { node.data = it; });
}

async function sessionsTests() {
  const feed = listFeeder();
  let prev;

  await test('First snapshot: two group labels "Open / Recent" (with counts); rows in each group sorted by start time, newest first', () => {
    const vm = feed(fixtures());
    assert.strictEqual(vm.type, 'list');
    assert.strictEqual(vm.showGroups, true);
    const groups = vm.items.filter((x) => x.kind === 'group');
    assert.deepStrictEqual(groups.map((g) => [g.id, g.text, g.count]), [['g:open', i18n.t('group.open'), '2'], ['g:recent', i18n.t('group.recent'), '2']]);
    assert.deepStrictEqual(vm.items.map((x) => x.id || x.key), ['g:open', 'codex:gamma', 'claude:alpha', 'g:recent', 'claude:beta', 'claude:delta']);
    assert.deepStrictEqual(rowsOf(vm).map((r) => r.group), ['open', 'open', 'recent', 'recent']);
    prev = vm;
  });

  await test('Row: lamp (shape + lamp name), short status = source · status · context, a11y, data-vscode-context carries compactable / resumable / handoff / autoCompact', () => {
    const vm = prev;
    const L = lampsOf(fixtures());
    for (const r of rowsOf(vm)) {
      const lamp = L.get(r.key).lamp;
      assert.strictEqual(r.lamp, lamp, r.key);
      assert.strictEqual(r.shape, S.LAMP_SHAPE[lamp], r.key);
      assert.ok(r.a11y.includes(r.title), r.a11y);
      assert.ok(r.tip.startsWith(r.title + '\n'), 'first tooltip line is the title');
      const ctx = JSON.parse(r.context);
      assert.deepStrictEqual(Object.keys(ctx).sort(), ['autoCompact', 'compactable', 'handoff', 'preventDefaultContextMenuItems', 'resumable', 'sessionKey', 'webviewSection']);
      assert.strictEqual(ctx.webviewSection, 'session');
      assert.strictEqual(ctx.sessionKey, r.key);
      assert.strictEqual(ctx.preventDefaultContextMenuItems, true);
      assert.strictEqual(ctx.compactable, r.compactable);
      assert.strictEqual(ctx.resumable, r.resumable);
      const cc = /^(claude|codex):/.test(r.key);
      assert.strictEqual(ctx.handoff, cc, r.key);
      assert.strictEqual(ctx.autoCompact, cc, r.key);
    }
    const alpha = rowOf(vm, 'claude:alpha');
    // Percentage uses Claude Code's formula: used / window. While running, the status is just "working" and does not change with every step
    assert.strictEqual(alpha.title, 'Alpha chat');
    // A list row shows only the lamp, title and zone mark; source, status and context go in the screen-reader text and tooltip (the session bar in the content area has them too)
    assert.strictEqual(alpha.desc, '', '84K is below the hint zone, so no mark');
    assert.ok(alpha.a11y.includes(['Claude', i18n.t('lamp.working'), i18n.t('row.context', { pct: i18n.fmtPct(84000 / 1000000) })].join(', ')), alpha.a11y);
    assert.strictEqual(alpha.compactable, true);
    const gamma = rowOf(vm, 'codex:gamma');
    assert.ok(gamma.a11y.includes('Codex, ' + i18n.t('status.maybeAwaitingApproval')), gamma.a11y);
    assert.strictEqual(gamma.lamp, 'needsYou');
    const beta = rowOf(vm, 'claude:beta');
    assert.strictEqual(beta.compactable, false, 'no compact button when context is under 20K');
    assert.ok(beta.a11y.includes(i18n.t('status.done.main')));
    assert.strictEqual(rowOf(vm, 'claude:delta').lamp, 'error');
    // Has a resume hint -> resumable
    const f = fixtures();
    f[1].resume = [{ kind: 'claudeSession', sessionId: 'beta', cwd: '/work/other', entry: 'cli', autoContinue: null, quota: null, estimate: null }];
    assert.strictEqual(rowOf(listFeeder()(f), 'claude:beta').resumable, true);
  });

  await test('Same data again, and again after 1 / 7 / 29 seconds: the list view model is identical (the extension does not resend, so tooltips are not closed)', () => {
    const json = JSON.stringify(prev);
    for (const dt of [0, 1000, 7000, 29000]) {
      assert.strictEqual(JSON.stringify(feed(fixtures(), { now: NOW + dt })), json, `changed at +${dt}ms`);
    }
  });

  await test('A running session switching between "thinking / running a tool" with a small token increase: nothing visible on the row changes; only a context percentage change updates that one row', () => {
    const f = fixtures();
    f[0].main.status = st('thinking', NOW - 1000);
    f[0].main.step = { kind: 'thinking', tool: null, detail: null, parallel: 0, sinceMs: NOW - 1000 };
    f[0].main.tokens = tokens(84100);
    const same = feed(f);
    assert.deepStrictEqual(changedRows(prev, same), []);
    // The tooltip shows the latest status (it updates with the data; the page holds off replacing it while hovered)
    assert.ok(rowOf(same, 'claude:alpha').tip.includes(i18n.t('status.thinking')), rowOf(same, 'claude:alpha').tip);
    f[0].main.tokens = tokens(120000);
    const next = feed(f);
    assert.deepStrictEqual(changedRows(prev, next), ['claude:alpha']);
    prev = next;
  });

  await test('20 snapshots (alternating activity, lamp toggling, shuffled input order): order is stable, only the row whose lamp changed updates; the page updates incrementally by key without rebuilding', () => {
    const want = keysOf(prev);
    const box = new FakeNode('box');
    const made = [];
    pageSync(box, prev, made);
    const nodes = new Map(box.kids.map((n) => [n.label, n]));
    const moves0 = box.moves;
    let last = prev;
    let changes = 0;
    for (let i = 0; i < 20; i++) {
      const f = fixtures();
      f[0].main.tokens = tokens(120000);
      f[0].updatedMs = NOW + i * 1000;
      f[1].updatedMs = NOW + (20 - i) * 1000;
      f[1].main.status = i % 2 ? st('thinking', NOW + i) : st('done', NOW - 10 * MIN);
      const shuffled = i % 3 === 0 ? [...f].reverse() : i % 3 === 1 ? [f[2], f[0], f[3], f[1]] : f;
      const vm = feed(shuffled, { now: NOW + i * 2000 });
      assert.deepStrictEqual(keysOf(vm), want, `order changed on pass ${i + 1}`);
      const ch = changedRows(last, vm);
      for (const k of ch) assert.strictEqual(k, 'claude:beta', `should not change: ${k}`);
      changes += ch.length;
      pageSync(box, vm, made);
      // The same key is always the same node; if the order did not change, nothing moves
      for (const n of box.kids) assert.strictEqual(nodes.get(n.label), n, `node was rebuilt: ${n.label}`);
      last = vm;
    }
    assert.ok(changes >= 10, 'the lamp toggles, so the Beta row should change with it');
    assert.strictEqual(made.length, 6, 'nodes are created only the first time (4 rows + 2 group labels)');
    assert.strictEqual(box.moves, moves0, 'no node moves when the order is unchanged');
    prev = last;
  });

  await test('A new session appears at the top of its group: the page creates only that row at the right position, and existing nodes keep their identity', () => {
    const box = new FakeNode('box');
    const made = [];
    pageSync(box, prev, made);
    const before = new Map(box.kids.map((n) => [n.label, n]));
    made.length = 0;
    const f = fixtures();
    f[0].main.tokens = tokens(120000);
    const fresh = session({ id: 'eps', title: 'Epsilon', startedMs: NOW + 5 * MIN });
    const vm = feed([...f, fresh]);
    assert.deepStrictEqual(keysOf(vm), ['codex:gamma', 'claude:alpha', 'claude:eps', 'claude:beta', 'claude:delta']);
    assert.strictEqual(rowsOf(vm).find((r) => r.key === 'claude:eps').group, 'recent');
    pageSync(box, vm, made);
    assert.deepStrictEqual(made, ['claude:eps']);
    assert.deepStrictEqual(box.kids.map((n) => n.label), ['g:open', 'codex:gamma', 'claude:alpha', 'g:recent', 'claude:eps', 'claude:beta', 'claude:delta']);
    for (const n of box.kids) if (before.has(n.label)) assert.strictEqual(before.get(n.label), n);
    assert.strictEqual(vm.items.find((x) => x.id === 'g:recent').count, '3');
  });

  await test('A session moving from "Recent" to "Open": it moves only when changing groups (the node is moved, not rebuilt); each group stays sorted by start time, newest first', () => {
    const f = fixtures();
    f[0].main.tokens = tokens(120000);
    const box = new FakeNode('box');
    const made = [];
    pageSync(box, feed(f), made);
    const delta0 = box.kids.find((n) => n.label === 'claude:delta');
    f[3].live = true;
    f[3].liveStatus = 'idle';
    const vm = feed(f);
    assert.deepStrictEqual(keysOf(vm), ['codex:gamma', 'claude:alpha', 'claude:delta', 'claude:beta']);
    assert.strictEqual(rowOf(vm, 'claude:delta').group, 'open');
    made.length = 0;
    pageSync(box, vm, made);
    assert.deepStrictEqual(made, []);
    assert.strictEqual(box.kids.find((n) => n.label === 'claude:delta'), delta0);
    assert.deepStrictEqual(box.kids.map((n) => n.label), ['g:open', 'codex:gamma', 'claude:alpha', 'claude:delta', 'g:recent', 'claude:beta']);
  });

  await test('Only one group left: no group labels', () => {
    const vm = listFeeder()(fixtures().map((s) => ({ ...s, live: false, liveStatus: null })));
    assert.strictEqual(vm.showGroups, false);
    assert.ok(vm.items.every((x) => x.kind === 'session'));
    assert.deepStrictEqual(keysOf(vm), ['codex:gamma', 'claude:alpha', 'claude:beta', 'claude:delta']);
  });

  await test('A session disappears: it is gone from the list and the page removes that one node; the selected key becomes null when it is no longer in the list', () => {
    const box = new FakeNode('box');
    const made = [];
    pageSync(box, feed(fixtures(), { selectedKey: 'claude:beta' }), made);
    const vm = feed(fixtures().filter((s) => s.id !== 'beta'), { selectedKey: 'claude:beta' });
    assert.ok(!keysOf(vm).includes('claude:beta'));
    assert.strictEqual(vm.selectedKey, null);
    pageSync(box, vm, made);
    assert.ok(!box.kids.some((n) => n.label === 'claude:beta'));
    assert.strictEqual(feed(fixtures(), { selectedKey: 'claude:alpha' }).selectedKey, 'claude:alpha');
    assert.strictEqual(feed(fixtures(), { selectedKey: 42 }).selectedKey, null);
  });

  await test('Position and width: only left / right are accepted (anything else means right); width snaps like the terminal panel (< 63 -> 46, 63-80 -> 80, max 500)', () => {
    assert.strictEqual(feed(fixtures(), { position: 'left' }).position, 'left');
    assert.strictEqual(feed(fixtures(), { position: 'top' }).position, 'right');
    assert.strictEqual(feed(fixtures()).width, 200);
    assert.strictEqual(feed(fixtures()).defaultWidth, 200);
    assert.deepStrictEqual([50, 70, 180, 900].map((w) => feed(fixtures(), { width: w }).width), [46, 80, 180, 500]);
  });

  await test('Tooltip: plain text, user text verbatim (including $(…), pipes, Markdown syntax, angle brackets); one "label: value" per line; NeedsYou shows the lamp name', () => {
    const f = fixtures();
    f[2].title = 'Fix $(pwd) | *bold* _x_ [l](http://e.com) <b>t</b>';
    f[2].cwd = '/work/a|b $(whoami)';
    const vm = listFeeder()(f);
    const r = rowOf(vm, 'codex:gamma');
    assert.strictEqual(r.title, 'Fix $(pwd) | *bold* _x_ [l](http://e.com) <b>t</b>');
    const lines = r.tip.split('\n');
    assert.strictEqual(lines[0], r.title);
    assert.ok(lines.includes(i18n.t('tip.folder') + ': /work/a|b $(whoami)'), r.tip);
    assert.ok(lines[1].startsWith(i18n.t('tip.status') + ': ' + i18n.t('lamp.needsYou')), lines[1]);
    // Lines match formatSessionTooltip (plus one title line)
    const rows = fmt.formatSessionTooltip(f[2], i18n, { now: NOW, lamps: lampsOf(f).get('codex:gamma') });
    assert.deepStrictEqual(lines.slice(1, rows.length + 1), rows.map(([k, v]) => k + ': ' + v));
    // showCost=false: no cost line in the tooltip
    const nc = rowOf(listFeeder()(f, { showCost: false }), 'claude:alpha');
    assert.ok(!nc.tip.includes(i18n.t('cost.label') + ':'), nc.tip);
  });
}

// ---------- Sidebar overview tree ----------

async function overviewTests() {
  const p = new AgentTreeProvider({ i18n, now: () => NOW });
  const rec = recorder(p);
  let prev;
  const feed = (sessions, o = {}) => p.update({ sessions, lamps: lampsOf(sessions, o.seen || 0), now: o.now ?? NOW, hideCompleted: o.hideCompleted });
  const kids = (id) => p.getChildren(p.nodes.get(id)).map((n) => n.id);

  await test('Structure: session -> main agent / subagents (by start time, oldest first) / workflows -> workflow agents; sessions by start time, newest first', () => {
    feed(fixtures());
    assert.deepStrictEqual(rec.take(), ['ROOT']);
    assert.deepStrictEqual(p.getChildren().map((n) => n.id), ['codex:gamma', 'claude:alpha', 'claude:beta', 'claude:delta']);
    // A workflow without a start time uses its earliest agent: wf_done -45 min, wf_run -20 min; subagents -50 and -40 min
    assert.deepStrictEqual(kids('claude:alpha'), [
      'claude:alpha/main', 'claude:alpha/a/sub1', 'claude:alpha/wf/wf_done', 'claude:alpha/a/sub2', 'claude:alpha/wf/wf_run',
    ]);
    assert.deepStrictEqual(kids('claude:alpha/wf/wf_run'), ['claude:alpha/wf/wf_run/w1', 'claude:alpha/wf/wf_run/w2']);
    assert.strictEqual(p.nodes.get('claude:alpha').key, 'claude:alpha');
    prev = walk(p);
  });

  await test('Icons, colors, contextValue: lamp shape + color id, all present in codicons', () => {
    const css = fs.readFileSync(path.join(ROOT, 'media', 'codicons', 'codicon.css'), 'utf8');
    const colors = new Set(Object.values(S.LAMP_COLOR_ID));
    for (const node of p.nodes.values()) {
      const it = p.getTreeItem(node);
      assert.ok(['circle-large-filled', 'circle-large-outline'].includes(it.iconPath.id), it.iconPath.id);
      assert.ok(css.includes(`.codicon-${it.iconPath.id}:before`), `not in codicons: ${it.iconPath.id}`);
      assert.ok(colors.has(it.iconPath.color.id), it.iconPath.color.id);
      assert.ok(it.accessibilityInformation && it.accessibilityInformation.label);
      if (node.kind === 'session') assert.ok(it.contextValue.startsWith('session '));
      else assert.ok(['mainAgent', 'agent', 'workflow'].includes(it.contextValue), it.contextValue);
    }
    const w1 = p.getTreeItem(p.nodes.get('claude:alpha/wf/wf_run/w1'));
    assert.strictEqual(w1.iconPath.color.id, 'agentMonitor.lampWorking');
    assert.ok(w1.description.endsWith('Bash make'), w1.description);
    const sub2 = p.getTreeItem(p.nodes.get('claude:alpha/a/sub2'));
    assert.strictEqual(sub2.iconPath.color.id, 'agentMonitor.lampDoneUnseen');
    assert.ok(sub2.description.endsWith(i18n.t('status.done')));
    const main = p.getTreeItem(p.nodes.get('claude:alpha/main'));
    assert.strictEqual(main.label, i18n.t('agent.main'));
    assert.strictEqual(main.contextValue, 'mainAgent');
    const wfIt = p.getTreeItem(p.nodes.get('claude:alpha/wf/wf_run'));
    assert.ok(wfIt.description.startsWith(i18n.t('workflow.running')));
  });

  await test('Go to Chat: session contextValue gets "goTo" (the inline action) when the jump is worth trying: a running Claude chat or a Codex extension thread, not a Claude chat that is not running', () => {
    const cv = (id) => p.getTreeItem(p.nodes.get(id)).contextValue.split(' ');
    assert.ok(cv('claude:alpha').includes('goTo'), 'running Claude');
    assert.ok(cv('codex:gamma').includes('goTo'), 'Codex extension, recently active');
    assert.ok(!cv('claude:beta').includes('goTo'), 'Claude, not running');
    assert.ok(!cv('claude:delta').includes('goTo'), 'Claude, not running');
    assert.strictEqual(p.getTreeItem(p.nodes.get('claude:alpha/main')).contextValue, 'mainAgent', 'agent nodes keep their contextValue (the menu uses the session)');
  });

  await test('Collapsing: running / needs-you sessions and running workflows are expanded, the rest collapsed; the main agent has no arrow', () => {
    const state = (id) => p.getTreeItem(p.nodes.get(id)).collapsibleState;
    assert.strictEqual(state('claude:alpha'), Expanded);
    assert.strictEqual(state('codex:gamma'), Expanded);
    assert.strictEqual(state('claude:beta'), Collapsed);
    assert.strictEqual(state('claude:alpha/wf/wf_run'), Expanded);
    assert.strictEqual(state('claude:alpha/wf/wf_done'), Collapsed);
    assert.strictEqual(state('claude:alpha/main'), None);
  });

  await test('Feeding the same data again: no fire', () => {
    feed(fixtures());
    assert.deepStrictEqual(rec.take(), []);
  });

  let cur = fixtures();
  const byId = (f, id) => f[0].agents.find((a) => a.id === id);
  const step = (mutate, o) => {
    cur = clone(cur);
    mutate(cur);
    feed(clone(cur), o);
    const fired = rec.take();
    const now = walk(p);
    assertStable(prev, now);
    prev = now;
    return fired;
  };

  await test('A subagent step changes: only that node fires', () => {
    const fired = step((f) => { byId(f, 'sub1').step = { kind: 'tool', tool: 'Read', detail: 'lib/a.js', parallel: 1, sinceMs: NOW }; });
    assert.deepStrictEqual(fired, [['claude:alpha/a/sub1']]);
  });

  await test('A workflow agent token count changes: only that agent fires', () => {
    const fired = step((f) => { f[0].workflows[0].agents[0].tokens = tokens(99000); });
    assert.deepStrictEqual(fired, [['claude:alpha/wf/wf_run/w1']]);
  });

  await test('New subagent: only its session fires; it is appended at the end (by start time)', () => {
    const fired = step((f) => { f[0].agents.unshift(agent({ id: 'sub3', kind: 'subagent', name: 'Late', startedMs: NOW - MIN })); });
    assert.deepStrictEqual(fired, [['claude:alpha']]);
    assert.strictEqual(kids('claude:alpha').slice(-1)[0], 'claude:alpha/a/sub3');
  });

  await test('Agents alternate activity 20 times: sibling order never changes', () => {
    const want = kids('claude:alpha');
    for (let i = 0; i < 20; i++) {
      step((f) => {
        const a = byId(f, 'sub1');
        const b = byId(f, 'sub2');
        a.status = st(i % 2 ? 'tool' : 'done', NOW + i);
        b.status = st(i % 2 ? 'done' : 'thinking', NOW + i);
        a.lastActivityMs = NOW + (i % 2 ? i * 1000 : 0);
        b.lastActivityMs = NOW + (i % 2 ? 0 : i * 1000);
        f[0].agents.reverse(); // shuffle the input order too
      });
      assert.deepStrictEqual(kids('claude:alpha'), want, `order changed on pass ${i + 1}`);
    }
  });

  await test('hideCompleted: hides finished agents and completed workflows (the main agent stays), order unchanged; restored when turned off', () => {
    const before = kids('claude:alpha');
    p.setFilter({ hideCompleted: true });
    const fired = rec.take();
    assert.ok(fired.length === 1 && fired[0] !== 'ROOT', JSON.stringify(fired));
    const hidden = kids('claude:alpha');
    assert.strictEqual(hidden[0], 'claude:alpha/main');
    assert.ok(!hidden.includes('claude:alpha/wf/wf_done'));
    for (const n of p.nodes.values()) {
      if (n.kind === 'agent') assert.notStrictEqual(n.data.status.code, 'done', `finished agent still shown: ${n.id}`);
    }
    // Remaining items keep their previous relative order
    assert.deepStrictEqual(hidden, before.filter((id) => hidden.includes(id)));
    p.setFilter({ hideCompleted: false });
    rec.take();
    assert.deepStrictEqual(kids('claude:alpha'), before);
    prev = walk(p);
  });

  await test('A session disappears: the whole tree fires once and none of its nodes remain in the cache', () => {
    const fired = step((f) => { f.splice(f.findIndex((s) => s.id === 'beta'), 1); });
    assert.deepStrictEqual(fired, ['ROOT']);
    assert.ok(![...p.nodes.keys()].some((id) => id.startsWith('claude:beta')));
  });

  await test('Tooltips: built on demand for agents / workflows / sessions; user text shown verbatim', () => {
    const f = clone(cur);
    const sub1 = byId(f, 'sub1');
    sub1.step = { kind: 'tool', tool: 'Bash', detail: 'rm -rf $(pwd)/tmp | grep *.log', parallel: 2, sinceMs: NOW - 3000 };
    sub1.status = st('tool', NOW - 3000, { pendingTool: 'Bash' });
    sub1.name = 'Name with `ticks` and $(icon)';
    feed(f);
    const node = p.nodes.get('claude:alpha/a/sub1');
    const it = p.resolveTreeItem(p.getTreeItem(node), node);
    const text = hoverText(it.tooltip.value);
    assert.ok(text.includes('rm -rf $(pwd)/tmp | grep *.log'), text);
    assert.ok(text.includes('Name with `ticks` and $(icon)'), text);
    assert.ok(text.includes(i18n.t('count.apiCalls', { n: 6 })));
    for (const id of ['claude:alpha', 'claude:alpha/wf/wf_run', 'claude:alpha/main']) {
      const n = p.nodes.get(id);
      const t = p.resolveTreeItem(p.getTreeItem(n), n).tooltip;
      assert.ok(t instanceof MarkdownString && t.supportThemeIcons && t.value.length > 20, id);
    }
    assert.strictEqual(hoverText(esc('C:\\dir\\$(x) \\$(y) $(loading~spin)')), 'C:\\dir\\$(x) \\$(y) $(loading~spin)');
  });
}

// A one-character zone mark at the end of a session row's description; the tooltip explains the rule and its basis
async function zoneTests() {
  await test('Context zone marks: 1M windows use absolute counts (default 200K / 500K, configurable), 200K windows use the share of the compact threshold; both trees agree', () => {
    const mk = (id, used, extra = {}) => session({ id, title: `Zone ${id}`, main: agent({ status: st('done', NOW - MIN), tokens: { ...tokens(used), ...extra } }), doneAtMs: NOW - MIN });
    const small = { contextWindow: 200000, compactAt: 167000 };
    const list = [mk('z0', 150000), mk('z1', 300000), mk('z2', 600000), mk('z3', 90000, small), mk('z4', 110000, small), mk('z5', 140000, small)];
    const feed = listFeeder();
    const ov = new AgentTreeProvider({ i18n, now: () => NOW });
    const lamps = lampsOf(list);
    let left = feed(list, { hints: { start: 200000, act: 500000 } });
    ov.update({ sessions: list, lamps, now: NOW, hints: { start: 200000, act: 500000 } });
    // The overview tree description ends with " ◔"; the list desc is just that one character
    const markOf = (d) => (/\u25D4$/.test(d) ? 'consider' : /\u25D5$/.test(d) ? 'act' : null);
    const mark = (vm, id) => markOf(rowOf(vm, 'claude:' + id).desc);
    const got = ['z0', 'z1', 'z2', 'z3', 'z4', 'z5'].map((id) => mark(left, id));
    assert.deepStrictEqual(got, [null, 'consider', 'act', null, 'consider', 'act']);
    assert.deepStrictEqual(['z0', 'z1', 'z2', 'z3', 'z4', 'z5'].map((id) => markOf(ov.getTreeItem(ov.nodes.get('claude:' + id)).description)), got);
    const r = rowOf(left, 'claude:z1');
    assert.ok(r.a11y.includes(i18n.t('webview.zone.consider')));
    for (const k of ['webview.zone.consider', 'webview.zone.consider.tip', 'webview.zone.newTask', 'webview.zone.basis']) assert.ok(r.tip.includes(i18n.t(k)), k);
    // The overview tree's Markdown tooltip has the same explanation
    const n = ov.nodes.get('claude:z1');
    const text = hoverText(ov.resolveTreeItem(ov.getTreeItem(n), n).tooltip.value);
    for (const k of ['webview.zone.consider', 'webview.zone.consider.tip', 'webview.zone.newTask', 'webview.zone.basis']) assert.ok(text.includes(i18n.t(k)), k);
    // Raise the thresholds: 300K is no longer marked
    left = feed(list, { hints: { start: 400000, act: 800000 } });
    assert.strictEqual(mark(left, 'z1'), null);
    assert.strictEqual(mark(left, 'z2'), 'consider');
  });

  await test('Session-level window and compact point: zone, percentage and source in the tooltip; both trees agree', () => {
    // Main agent tokens assume 1M, but the provider says the session has a 200K window with the default ~167K compact point -> 140K is in the "act" zone
    const s = session({ id: 'cw', title: 'Session window', contextWindow: 200000, contextWindowSource: 'model-rule', compactAt: 167000, compactAtSource: 'default',
      ccCostUsd: 1.234, main: agent({ status: st('done', NOW - MIN), tokens: tokens(140000) }), doneAtMs: NOW - MIN });
    const lamps = lampsOf([s]);
    const ov = new AgentTreeProvider({ i18n, now: () => NOW });
    ov.update({ sessions: [s], lamps, now: NOW, hints: {} });
    const n = ov.nodes.get('claude:cw');
    const it = ov.resolveTreeItem(ov.getTreeItem(n), n);
    const row = rowOf(listFeeder()([s]), 'claude:cw');
    for (const [desc, text] of [[it.description, hoverText(it.tooltip.value)], [row.a11y, row.tip]]) {
      assert.ok(desc.includes(i18n.t('row.context', { pct: '70%' })), desc);
      assert.ok(text.includes(i18n.t('tip.autoCompact')) && text.includes('About 167K · official default'), text);
      assert.ok(text.includes('140K / 167K · 27K until auto-compact · 70% of the 200K window'), text);
      assert.ok(text.includes("$1.23 (Claude Code's count)"), text);
    }
    assert.ok(it.description.endsWith(' \u25D5'), 'zone based on the share of the 200K window: ' + it.description);
    assert.strictEqual(row.desc, '\u25D5', 'list shows the same zone mark');
  });
}

// Copilot / Gemini CLI / Qwen Code sessions (shapes as lib/providers/{copilot,gemini,qwen}.js produce them)
async function providerTests() {
  const noCompact = (used, window, o = {}) => ({ display: used, contextUsed: used, contextWindow: window, compactAt: null, toCompact: null,
    output: 900, processed: 50000, apiCalls: 4, ...o });
  const cop = session({
    id: 'cop', provider: 'copilot', title: 'Refactor auth', entry: 'vscode', entryRaw: 'panel', entrypoint: null, model: 'copilot/claude-sonnet-4.5',
    live: true, liveStatus: 'waiting', contextWindow: 128000, contextWindowSource: 'copilot-model', compactAt: null, compactAtSource: null, costUsd: null,
    main: agent({ model: 'copilot/claude-sonnet-4.5', status: st('awaitingInput', NOW - 30000, { question: 'askUser' }),
      step: { kind: 'tool', tool: 'questionCarousel', detail: null, parallel: 0, sinceMs: NOW - 30000 },
      tokens: noCompact(90000, 128000), costUsd: null, copilotCredits: 1.5 }),
    agents: [agent({ id: 'sa1', kind: 'copilotSubagent', name: 'Explorer', agentType: 'Explore', description: 'Survey the repo', model: 'claude-haiku-4.5',
      status: st('thinking', NOW - 5000), tokens: noCompact(0, null), costUsd: null, startedMs: NOW - MIN })],
    copilot: { credits: 1.5, multiplier: 1, cachedTokens: 0, requests: 2, queued: 0, modelState: 4, mode: 'agent', permissionLevel: 'default', storage: 'workspace', workspaceFile: null },
  });
  const gem = session({
    id: 'gem', provider: 'gemini', title: 'Fix the flaky test', entry: 'cli', entryRaw: null, entrypoint: null, model: 'gemini-2.5-pro',
    liveCertainty: 'guess', contextWindow: 1048576, contextWindowSource: 'model-rule', compactAt: null, compactAtSource: null, costUsd: 0.05, doneAtMs: NOW - 2 * MIN,
    main: agent({ model: 'gemini-2.5-pro', status: st('done', NOW - 2 * MIN, { certainty: 'guess' }),
      tokens: noCompact(52000, 1048576, { input: 52000, cached: 30000, thoughts: 1200, tool: 300 }), costUsd: 0.05, costEstimated: true }),
  });
  const qw = session({
    id: 'qw', provider: 'qwen', title: 'Summarise the repo', entry: 'cli', entryRaw: null, entrypoint: null, model: 'coder-model',
    contextWindow: 1000000, contextWindowSource: 'qwen-record', compactAt: null, compactAtSource: null, costUsd: null, unpricedModel: 'coder-model', doneAtMs: NOW - MIN,
    main: agent({ model: 'coder-model', status: st('done', NOW - MIN), tokens: noCompact(300000, 1000000), costUsd: null, unpricedModel: 'coder-model' }),
    agents: [agent({ id: 'q1', kind: 'qwenSubagent', agentType: 'reviewer', status: st('maybeAwaitingApproval', NOW - 70000, { pendingTool: 'run_shell_command' }),
      tokens: noCompact(2000, 1000000), costUsd: 0.001, costEstimated: true, startedMs: NOW - 2 * MIN })],
  });
  const all = [cop, gem, qw];
  const tree = new AgentTreeProvider({ i18n, now: () => NOW });
  tree.update({ sessions: all, lamps: lampsOf(all), now: NOW, hints: {} });
  const item = (id) => { const n = tree.nodes.get(id); return tree.resolveTreeItem(tree.getTreeItem(n), n); };
  const list = listFeeder()(all);

  await test('Copilot / Gemini CLI / Qwen Code rows: product name first, Copilot waiting parts by name, sub-agents named like Claude ones, guessed statuses marked "~"', () => {
    walk(tree);
    assert.strictEqual(item('copilot:cop').description, 'Copilot · Waiting for your answer · 70% context \u25D4', 'zones use the share of the window');
    assert.strictEqual(item('gemini:gem').description, 'Gemini CLI · ~Turn finished · 5% context');
    assert.ok(item('qwen:qw').description.startsWith('Qwen Code · reviewer: May be waiting for your approval'), item('qwen:qw').description);
    assert.strictEqual(item('copilot:cop/main').description, '90K · Waiting for your answer');
    assert.strictEqual(item('copilot:cop/a/sa1').label, 'Survey the repo');
    assert.strictEqual(item('gemini:gem/main').description, '52K · ~Turn finished');
    const tip = hoverText(item('copilot:cop/main').tooltip.value);
    assert.ok(tip.includes('Question for you'), tip);
    for (const key of ['copilot:cop', 'gemini:gem', 'qwen:qw']) {
      assert.ok(!/\bcompactable\b/.test(item(key).contextValue), key + ': no compact command');
      assert.ok(rowOf(list, key).a11y.startsWith(all.find((x) => x.key === key).title), key);
      assert.strictEqual(rowOf(list, key).compactable, false);
    }
  });

  await test('Tooltips: Copilot credits and the lag / billing notes; Gemini guess note, "probably not open" and token breakdown; Qwen unpriced; never "auto-compact is off"', () => {
    const copS = hoverText(item('copilot:cop').tooltip.value);
    assert.ok(copS.includes('Copilot credits | 1.5 credits'), copS);
    assert.ok(copS.includes('60 seconds') && copS.includes('Copilot bills in credits') && !copS.includes('list API prices'), copS);
    const copMain = hoverText(item('copilot:cop/main').tooltip.value);
    assert.ok(copMain.includes('Copilot credits | 1.5 credits'), copMain);
    const copSub = hoverText(item('copilot:cop/a/sa1').tooltip.value);
    assert.ok(copSub.includes("Counted in the session's Copilot credits") && copSub.includes('Subagent · Explorer'), copSub);
    const gemS = hoverText(item('gemini:gem').tooltip.value);
    assert.ok(gemS.includes('Gemini CLI · Terminal · probably not open'), gemS);
    assert.ok(gemS.includes('Guessed from when the session log was last written'), gemS);
    assert.ok(gemS.includes('2026-09-24'), 'Gemini price date');
    const gemMain = hoverText(item('gemini:gem/main').tooltip.value);
    assert.ok(gemMain.includes('Input 52K (cached 30K) · thoughts 1.2K · tool use 300'), gemMain);
    assert.ok(gemMain.includes('$0.050 est.'), gemMain);
    const qwMain = hoverText(item('qwen:qw/main').tooltip.value);
    assert.ok(qwMain.includes('API-equivalent cost | No public price'), qwMain);
    for (const id of ['copilot:cop', 'copilot:cop/main', 'gemini:gem', 'gemini:gem/main', 'qwen:qw', 'qwen:qw/main']) {
      const t = hoverText(item(id).tooltip.value);
      assert.ok(!t.includes('Auto-compact is off') && !t.includes(i18n.t('tip.autoCompact') + ' |'), id + ': ' + t);
    }
    for (const key of ['copilot:cop', 'gemini:gem', 'qwen:qw']) {
      const t = rowOf(list, key).tip;
      assert.ok(!t.includes('Auto-compact') && !/\{\w+\}/.test(t), t);
    }
  });

  await test('Copilot token counts never recorded: "—" on the row (not "0"), "tokens not recorded" for screen readers, the reason in the tooltip, no "0% context"', () => {
    const sa = tree.getTreeItem(tree.nodes.get('copilot:cop/a/sa1'));
    assert.ok(sa.description.startsWith('— · '), sa.description);
    assert.ok(sa.accessibilityInformation.label.includes(i18n.t('ctx.unknown')) && !sa.accessibilityInformation.label.includes('— tokens'), sa.accessibilityInformation.label);
    const subTip = hoverText(item('copilot:cop/a/sa1').tooltip.value);
    assert.ok(subTip.includes(i18n.t('ctx.unknown.sub')) && !subTip.includes('0 output'), subTip);
    assert.ok(subTip.includes('Context | —'), subTip);
    // A Copilot chat whose requests carry no usage at all
    const bare = { ...cop, id: 'bare', key: 'copilot:bare', title: 'No usage yet',
      main: { ...cop.main, tokens: noCompact(0, 128000, { output: 0, processed: 0, apiCalls: 0 }) }, agents: [] };
    const t2 = new AgentTreeProvider({ i18n, now: () => NOW });
    t2.update({ sessions: [bare], lamps: lampsOf([bare]), now: NOW, hints: {} });
    const it2 = (id) => { const n = t2.nodes.get(id); return t2.resolveTreeItem(t2.getTreeItem(n), n); };
    walk(t2);
    assert.ok(!it2('copilot:bare').description.includes('context'), it2('copilot:bare').description);
    assert.ok(it2('copilot:bare/main').description.startsWith('— · '), it2('copilot:bare/main').description);
    const s = hoverText(it2('copilot:bare').tooltip.value);
    assert.ok(s.includes('Context | — / 128K') && !s.includes('0%'), s);
    const m = hoverText(it2('copilot:bare/main').tooltip.value);
    assert.ok(m.includes('Context | — / 128K') && m.includes(i18n.t('ctx.unknown.note')) && m.includes('API calls: —'), m);
  });
}

(async () => {
  console.log('Session list (agents-view.js buildSessionList + session-list.js)');
  await sessionsTests();
  console.log('\nOverview tree (tree.js)');
  await overviewTests();
  console.log('\nContext zone marks');
  await zoneTests();
  console.log('\nCopilot / Gemini CLI / Qwen Code');
  await providerTests();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
