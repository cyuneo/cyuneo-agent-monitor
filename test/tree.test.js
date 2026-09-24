'use strict';
// 会话列表与总览树的行为测试：底部面板的会话列表（§11.13，lib/agents-view.js buildSessionList + media/session-list.js
// 的增量同步；原来左侧原生树 lib/sessions-tree.js 的测试改写到这里，覆盖面不减）与 lib/tree.js（侧边栏总览）。
// 纯 node 运行：node test/tree.test.js。数据全部是合成的 Snapshot v2 会话，不读 ~/.claude、~/.codex。
// 重点：顺序固定（§11.3）、只有真变了的行才变（列表消息不含逐秒变化的内容，§11.2）、按 key 增量更新、悬停提示原样。

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---------- vscode 桩（含 §1.3 列出的 l10n、tabGroups、TabInputWebview、TabInputCustom） ----------

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

// ---------- 小工具 ----------

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

// 记录 provider 每次 fire 的内容：'ROOT' 表示整树，否则是节点 id 数组
function recorder(p) {
  const r = { list: [] };
  p.onDidChangeTreeData((e) => r.list.push(e === undefined ? 'ROOT' : e.map((n) => n.id)));
  r.take = () => r.list.splice(0);
  return r;
}

// 从根走一遍：父子关系、id、缓存都要对得上，缓存里不能有走不到的节点
function walk(p) {
  const seen = new Map();
  const visit = (node, parent) => {
    assert.ok(!seen.has(node.id), `重复 id ${node.id}`);
    seen.set(node.id, node);
    assert.strictEqual(p.nodes.get(node.id), node, `缓存里的节点不是树上的那个：${node.id}`);
    assert.strictEqual(p.getParent(node), parent, `getParent 不对：${node.id}`);
    const item = p.getTreeItem(node);
    assert.strictEqual(item.id, node.id);
    if (item.collapsibleState === None) assert.strictEqual(p.getChildren(node).length, 0, `无折叠箭头却有子节点：${node.id}`);
    for (const c of p.getChildren(node)) visit(c, node);
  };
  for (const r of p.getChildren()) visit(r, undefined);
  assert.strictEqual(seen.size, p.nodes.size, '缓存里有走不到的旧节点');
  return seen;
}

// 两次都在的节点，对象身份必须不变
function assertStable(before, after) {
  let same = 0;
  for (const [id, node] of before) {
    if (!after.has(id)) continue;
    assert.strictEqual(after.get(id), node, `节点对象变了：${id}`);
    same++;
  }
  return same;
}

// 模拟 VS Code 渲染悬停提示：先 markdownEscapeEscapedIcons，再按 Markdown 去掉反斜杠转义，
// 最后把 HTML 文本里的 $(名字) 换成图标（带反斜杠的原样显示）。返回用户最终看到的文字。
const ICON_SRC = '\\$\\([A-Za-z0-9-]+(?:~[A-Za-z]+)?\\)';
function hoverText(md) {
  let v = md.replace(new RegExp('\\\\' + ICON_SRC, 'g'), (m) => '\\' + m);
  v = v.replace(/\\([!-/:-@[-`{-~])/g, '$1');
  return v.replace(new RegExp('(\\\\)?(' + ICON_SRC + ')', 'g'), (m, e, icon) => (e ? icon : `[icon ${icon.slice(2, -1)}]`));
}

// ---------- 合成数据（Snapshot v2） ----------

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

// ---------- 底部面板的会话列表（§11.13） ----------

// 有状态的列表：和扩展一样持有一个排序器，每份快照 arrange 一次再拼视图模型
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
// 两份视图模型之间看得见的部分变了的会话行（按 key 比较）。悬停提示单独算：它跟着状态和 token 更新，
// 页面在鼠标停在那一行上时先不改 title（离开后再换），和原来原生树 resolveTreeItem 按需生成的效果一样
const VISIBLE = ['kind', 'key', 'group', 'title', 'desc', 'lamp', 'shape', 'a11y', 'compactable', 'resumable', 'context'];
const visibleOf = (r) => JSON.stringify(VISIBLE.map((k) => r[k]));
function changedRows(a, b) {
  const before = new Map(rowsOf(a).map((r) => [r.key, visibleOf(r)]));
  return rowsOf(b).filter((r) => before.get(r.key) !== visibleOf(r)).map((r) => r.key);
}

// 假 DOM 节点：只有 media/session-list.js syncKeyed 用到的那几样；记下 insertBefore 次数和新建了哪些节点
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
// 按页面（media/agents.js renderList）的做法把视图模型同步进假列表
function pageSync(box, vm, made) {
  LS.syncKeyed(box, vm.items,
    (it) => (it.kind === 'group' ? it.id : 's:' + it.key),
    (it) => { const n = new FakeNode(it.kind === 'group' ? it.id : it.key); made.push(n.label); return n; },
    (node, it) => { node.data = it; });
}

async function sessionsTests() {
  const feed = listFeeder();
  let prev;

  await test('首份数据：“打开中 / 最近”两个组标签（带计数），组内按开始时间倒序', () => {
    const vm = feed(fixtures());
    assert.strictEqual(vm.type, 'list');
    assert.strictEqual(vm.showGroups, true);
    const groups = vm.items.filter((x) => x.kind === 'group');
    assert.deepStrictEqual(groups.map((g) => [g.id, g.text, g.count]), [['g:open', i18n.t('group.open'), '2'], ['g:recent', i18n.t('group.recent'), '2']]);
    assert.deepStrictEqual(vm.items.map((x) => x.id || x.key), ['g:open', 'codex:gamma', 'claude:alpha', 'g:recent', 'claude:beta', 'claude:delta']);
    assert.deepStrictEqual(rowsOf(vm).map((r) => r.group), ['open', 'open', 'recent', 'recent']);
    prev = vm;
  });

  await test('行：灯（形状 + 灯名）、短状态 = 来源 · 状态 · 上下文、a11y、data-vscode-context 带 compactable / resumable', () => {
    const vm = prev;
    const L = lampsOf(fixtures());
    for (const r of rowsOf(vm)) {
      const lamp = L.get(r.key).lamp;
      assert.strictEqual(r.lamp, lamp, r.key);
      assert.strictEqual(r.shape, S.LAMP_SHAPE[lamp], r.key);
      assert.ok(r.a11y.includes(r.title), r.a11y);
      assert.ok(r.tip.startsWith(r.title + '\n'), '悬停提示第一行是标题');
      const ctx = JSON.parse(r.context);
      assert.deepStrictEqual(Object.keys(ctx).sort(), ['compactable', 'preventDefaultContextMenuItems', 'resumable', 'sessionKey', 'webviewSection']);
      assert.strictEqual(ctx.webviewSection, 'session');
      assert.strictEqual(ctx.sessionKey, r.key);
      assert.strictEqual(ctx.preventDefaultContextMenuItems, true);
      assert.strictEqual(ctx.compactable, r.compactable);
      assert.strictEqual(ctx.resumable, r.resumable);
    }
    const alpha = rowOf(vm, 'claude:alpha');
    // 百分比按 Claude Code 的公式：已用 / 窗口（§11.10）；在跑时只写“运行中”，不随每一步变
    assert.strictEqual(alpha.title, 'Alpha chat');
    // 列表一行只留灯、标题和区标记；来源、状态、上下文在读屏文字和悬停提示里（内容区会话条也有）
    assert.strictEqual(alpha.desc, '', '84K 不到提示区，没有标记');
    assert.ok(alpha.a11y.includes(['Claude', i18n.t('lamp.working'), i18n.t('row.context', { pct: i18n.fmtPct(84000 / 1000000) })].join(', ')), alpha.a11y);
    assert.strictEqual(alpha.compactable, true);
    const gamma = rowOf(vm, 'codex:gamma');
    assert.ok(gamma.a11y.includes('Codex, ' + i18n.t('status.maybeAwaitingApproval')), gamma.a11y);
    assert.strictEqual(gamma.lamp, 'needsYou');
    const beta = rowOf(vm, 'claude:beta');
    assert.strictEqual(beta.compactable, false, '上下文不到 2 万不给压缩按钮');
    assert.ok(beta.a11y.includes(i18n.t('status.done.main')));
    assert.strictEqual(rowOf(vm, 'claude:delta').lamp, 'error');
    // 有续跑提示 → resumable
    const f = fixtures();
    f[1].resume = [{ kind: 'claudeSession', sessionId: 'beta', cwd: '/work/other', entry: 'cli', autoContinue: null, quota: null, estimate: null }];
    assert.strictEqual(rowOf(listFeeder()(f), 'claude:beta').resumable, true);
  });

  await test('同一份数据再来一次、以及 1 / 7 / 29 秒后再来：列表视图模型一字不差（扩展不会重发，悬停提示不被关掉）', () => {
    const json = JSON.stringify(prev);
    for (const dt of [0, 1000, 7000, 29000]) {
      assert.strictEqual(JSON.stringify(feed(fixtures(), { now: NOW + dt })), json, `+${dt}ms 时变了`);
    }
  });

  await test('在跑的会话在“思考 / 执行工具”之间切换、token 小涨：行上看得见的都不变；上下文百分比变了才只变那一行', () => {
    const f = fixtures();
    f[0].main.status = st('thinking', NOW - 1000);
    f[0].main.step = { kind: 'thinking', tool: null, detail: null, parallel: 0, sinceMs: NOW - 1000 };
    f[0].main.tokens = tokens(84100);
    const same = feed(f);
    assert.deepStrictEqual(changedRows(prev, same), []);
    // 悬停提示是最新的状态（原来原生树悬停时现算，这里随数据更新，页面悬停期间暂不替换）
    assert.ok(rowOf(same, 'claude:alpha').tip.includes(i18n.t('status.thinking')), rowOf(same, 'claude:alpha').tip);
    f[0].main.tokens = tokens(120000);
    const next = feed(f);
    assert.deepStrictEqual(changedRows(prev, next), ['claude:alpha']);
    prev = next;
  });

  await test('20 份快照（活动交替、灯来回切、输入顺序打乱）：顺序不变，只有灯变了的那一行在变；页面按 key 增量更新，不重建', () => {
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
      assert.deepStrictEqual(keysOf(vm), want, `第 ${i + 1} 次顺序变了`);
      const ch = changedRows(last, vm);
      for (const k of ch) assert.strictEqual(k, 'claude:beta', `不该变 ${k}`);
      changes += ch.length;
      pageSync(box, vm, made);
      // 同一个 key 始终是同一个节点；顺序没变就一次也不挪
      for (const n of box.kids) assert.strictEqual(nodes.get(n.label), n, `节点被重建：${n.label}`);
      last = vm;
    }
    assert.ok(changes >= 10, '灯来回切，Beta 那一行应该跟着变');
    assert.strictEqual(made.length, 6, '只在第一次新建（4 行 + 2 个组标签）');
    assert.strictEqual(box.moves, moves0, '顺序没变时不挪节点');
    prev = last;
  });

  await test('新会话出现在它那一组的最上面：页面只新建这一行、插在规定位置，老节点身份不变', () => {
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

  await test('会话从“最近”变成“打开中”：只在换组时移动（节点挪过去，不重建），组内仍按开始时间倒序', () => {
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

  await test('只剩一组：不出组标签', () => {
    const vm = listFeeder()(fixtures().map((s) => ({ ...s, live: false, liveStatus: null })));
    assert.strictEqual(vm.showGroups, false);
    assert.ok(vm.items.every((x) => x.kind === 'session'));
    assert.deepStrictEqual(keysOf(vm), ['codex:gamma', 'claude:alpha', 'claude:beta', 'claude:delta']);
  });

  await test('会话消失：列表里不再有它，页面删掉那一个节点；选中的 key 不在列表里时为 null', () => {
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

  await test('位置与宽度：只认 left / right（其它当 right）；宽度按终端规则吸附（< 63 → 46，63–80 → 80，最宽 500）', () => {
    assert.strictEqual(feed(fixtures(), { position: 'left' }).position, 'left');
    assert.strictEqual(feed(fixtures(), { position: 'top' }).position, 'right');
    assert.strictEqual(feed(fixtures()).width, 200);
    assert.strictEqual(feed(fixtures()).defaultWidth, 200);
    assert.deepStrictEqual([50, 70, 180, 900].map((w) => feed(fixtures(), { width: w }).width), [46, 80, 180, 500]);
  });

  await test('悬停提示：纯文本、用户文本原样（含 $(…)、竖线、Markdown 标记、尖括号）；每行一个“标签: 值”，NeedsYou 写灯名', () => {
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
    // 行数与 formatSessionTooltip 一致（外加标题一行）
    const rows = fmt.formatSessionTooltip(f[2], i18n, { now: NOW, lamps: lampsOf(f).get('codex:gamma') });
    assert.deepStrictEqual(lines.slice(1, rows.length + 1), rows.map(([k, v]) => k + ': ' + v));
    // showCost=false：提示里没有费用那一行
    const nc = rowOf(listFeeder()(f, { showCost: false }), 'claude:alpha');
    assert.ok(!nc.tip.includes(i18n.t('cost.label') + ':'), nc.tip);
  });
}

// ---------- 侧边栏总览树 ----------

async function overviewTests() {
  const p = new AgentTreeProvider({ i18n, now: () => NOW });
  const rec = recorder(p);
  let prev;
  const feed = (sessions, o = {}) => p.update({ sessions, lamps: lampsOf(sessions, o.seen || 0), now: o.now ?? NOW, hideCompleted: o.hideCompleted });
  const kids = (id) => p.getChildren(p.nodes.get(id)).map((n) => n.id);

  await test('结构：会话 → 主智能体 / 子智能体（按开始时间正序）/ 工作流 → 工作流智能体；会话按开始时间倒序', () => {
    feed(fixtures());
    assert.deepStrictEqual(rec.take(), ['ROOT']);
    assert.deepStrictEqual(p.getChildren().map((n) => n.id), ['codex:gamma', 'claude:alpha', 'claude:beta', 'claude:delta']);
    // 工作流没有开始时间时取它最早的智能体：wf_done −45 分、wf_run −20 分；子智能体 −50、−40 分
    assert.deepStrictEqual(kids('claude:alpha'), [
      'claude:alpha/main', 'claude:alpha/a/sub1', 'claude:alpha/wf/wf_done', 'claude:alpha/a/sub2', 'claude:alpha/wf/wf_run',
    ]);
    assert.deepStrictEqual(kids('claude:alpha/wf/wf_run'), ['claude:alpha/wf/wf_run/w1', 'claude:alpha/wf/wf_run/w2']);
    assert.strictEqual(p.nodes.get('claude:alpha').key, 'claude:alpha');
    prev = walk(p);
  });

  await test('图标、颜色、contextValue：灯的形状 + 颜色 id，codicon 里都有', () => {
    const css = fs.readFileSync(path.join(ROOT, 'media', 'codicons', 'codicon.css'), 'utf8');
    const colors = new Set(Object.values(S.LAMP_COLOR_ID));
    for (const node of p.nodes.values()) {
      const it = p.getTreeItem(node);
      assert.ok(['circle-large-filled', 'circle-large-outline'].includes(it.iconPath.id), it.iconPath.id);
      assert.ok(css.includes(`.codicon-${it.iconPath.id}:before`), `codicon 里没有 ${it.iconPath.id}`);
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

  await test('折叠：在跑 / 需要你处理的会话、在跑的工作流展开，其余折叠；主智能体没有箭头', () => {
    const state = (id) => p.getTreeItem(p.nodes.get(id)).collapsibleState;
    assert.strictEqual(state('claude:alpha'), Expanded);
    assert.strictEqual(state('codex:gamma'), Expanded);
    assert.strictEqual(state('claude:beta'), Collapsed);
    assert.strictEqual(state('claude:alpha/wf/wf_run'), Expanded);
    assert.strictEqual(state('claude:alpha/wf/wf_done'), Collapsed);
    assert.strictEqual(state('claude:alpha/main'), None);
  });

  await test('同一份数据再喂一次：不 fire', () => {
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

  await test('子智能体的步骤变了：只 fire 这一个节点', () => {
    const fired = step((f) => { byId(f, 'sub1').step = { kind: 'tool', tool: 'Read', detail: 'lib/a.js', parallel: 1, sinceMs: NOW }; });
    assert.deepStrictEqual(fired, [['claude:alpha/a/sub1']]);
  });

  await test('工作流里智能体 token 变了：只 fire 它自己', () => {
    const fired = step((f) => { f[0].workflows[0].agents[0].tokens = tokens(99000); });
    assert.deepStrictEqual(fired, [['claude:alpha/wf/wf_run/w1']]);
  });

  await test('新子智能体：只 fire 它的会话，追加在最后（按开始时间）', () => {
    const fired = step((f) => { f[0].agents.unshift(agent({ id: 'sub3', kind: 'subagent', name: 'Late', startedMs: NOW - MIN })); });
    assert.deepStrictEqual(fired, [['claude:alpha']]);
    assert.strictEqual(kids('claude:alpha').slice(-1)[0], 'claude:alpha/a/sub3');
  });

  await test('智能体交替活动 20 次：兄弟顺序始终不变（§11.3）', () => {
    const want = kids('claude:alpha');
    for (let i = 0; i < 20; i++) {
      step((f) => {
        const a = byId(f, 'sub1');
        const b = byId(f, 'sub2');
        a.status = st(i % 2 ? 'tool' : 'done', NOW + i);
        b.status = st(i % 2 ? 'done' : 'thinking', NOW + i);
        a.lastActivityMs = NOW + (i % 2 ? i * 1000 : 0);
        b.lastActivityMs = NOW + (i % 2 ? 0 : i * 1000);
        f[0].agents.reverse(); // 输入顺序也打乱
      });
      assert.deepStrictEqual(kids('claude:alpha'), want, `第 ${i + 1} 次顺序变了`);
    }
  });

  await test('hideCompleted：隐藏完成的智能体和已完成的工作流（主智能体保留），顺序不变；关掉后恢复', () => {
    const before = kids('claude:alpha');
    p.setFilter({ hideCompleted: true });
    const fired = rec.take();
    assert.ok(fired.length === 1 && fired[0] !== 'ROOT', JSON.stringify(fired));
    const hidden = kids('claude:alpha');
    assert.strictEqual(hidden[0], 'claude:alpha/main');
    assert.ok(!hidden.includes('claude:alpha/wf/wf_done'));
    for (const n of p.nodes.values()) {
      if (n.kind === 'agent') assert.notStrictEqual(n.data.status.code, 'done', `已完成的还在：${n.id}`);
    }
    // 留下的相对顺序与之前一致
    assert.deepStrictEqual(hidden, before.filter((id) => hidden.includes(id)));
    p.setFilter({ hideCompleted: false });
    rec.take();
    assert.deepStrictEqual(kids('claude:alpha'), before);
    prev = walk(p);
  });

  await test('会话消失：fire 整树一次，缓存里不留它的节点', () => {
    const fired = step((f) => { f.splice(f.findIndex((s) => s.id === 'beta'), 1); });
    assert.deepStrictEqual(fired, ['ROOT']);
    assert.ok(![...p.nodes.keys()].some((id) => id.startsWith('claude:beta')));
  });

  await test('悬停提示：智能体 / 工作流 / 会话都按需生成，用户文本原样显示', () => {
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

// §11.8 第 1 条：会话行 description 末尾一个字的区标记；悬停提示写明做法与依据
async function zoneTests() {
  await test('上下文分区标记：1M 窗口按绝对数（默认 200K / 500K，可设），200K 窗口按占压缩阈值的比例；两棵树一致', () => {
    const mk = (id, used, extra = {}) => session({ id, title: `Zone ${id}`, main: agent({ status: st('done', NOW - MIN), tokens: { ...tokens(used), ...extra } }), doneAtMs: NOW - MIN });
    const small = { contextWindow: 200000, compactAt: 167000 };
    const list = [mk('z0', 150000), mk('z1', 300000), mk('z2', 600000), mk('z3', 90000, small), mk('z4', 110000, small), mk('z5', 140000, small)];
    const feed = listFeeder();
    const ov = new AgentTreeProvider({ i18n, now: () => NOW });
    const lamps = lampsOf(list);
    let left = feed(list, { hints: { start: 200000, act: 500000 } });
    ov.update({ sessions: list, lamps, now: NOW, hints: { start: 200000, act: 500000 } });
    // 总览树的说明文字以“ ◔”结尾；列表的 desc 就是这一个字
    const markOf = (d) => (/\u25D4$/.test(d) ? 'consider' : /\u25D5$/.test(d) ? 'act' : null);
    const mark = (vm, id) => markOf(rowOf(vm, 'claude:' + id).desc);
    const got = ['z0', 'z1', 'z2', 'z3', 'z4', 'z5'].map((id) => mark(left, id));
    assert.deepStrictEqual(got, [null, 'consider', 'act', null, 'consider', 'act']);
    assert.deepStrictEqual(['z0', 'z1', 'z2', 'z3', 'z4', 'z5'].map((id) => markOf(ov.getTreeItem(ov.nodes.get('claude:' + id)).description)), got);
    const r = rowOf(left, 'claude:z1');
    assert.ok(r.a11y.includes(i18n.t('webview.zone.consider')));
    for (const k of ['webview.zone.consider', 'webview.zone.consider.tip', 'webview.zone.newTask', 'webview.zone.basis']) assert.ok(r.tip.includes(i18n.t(k)), k);
    // 总览树的 Markdown 提示也有同样的说明
    const n = ov.nodes.get('claude:z1');
    const text = hoverText(ov.resolveTreeItem(ov.getTreeItem(n), n).tooltip.value);
    for (const k of ['webview.zone.consider', 'webview.zone.consider.tip', 'webview.zone.newTask', 'webview.zone.basis']) assert.ok(text.includes(i18n.t(k)), k);
    // 调高阈值：300K 不再标记
    left = feed(list, { hints: { start: 400000, act: 800000 } });
    assert.strictEqual(mark(left, 'z1'), null);
    assert.strictEqual(mark(left, 'z2'), 'consider');
  });

  await test('§11.10 会话级窗口与压缩点：分区、百分比、悬停提示里的来源，两棵树一致', () => {
    // 主智能体 tokens 按 1M 算，但 provider 认定会话是 200K 窗口、默认约 167K 压缩 → 140K 在“建议处理”区
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
    assert.ok(it.description.endsWith(' \u25D5'), '按 200K 窗口的比例分区：' + it.description);
    assert.strictEqual(row.desc, '\u25D5', '列表同一个区标记');
  });
}

(async () => {
  console.log('会话列表（agents-view.js buildSessionList + session-list.js）');
  await sessionsTests();
  console.log('\n总览树（tree.js）');
  await overviewTests();
  console.log('\n上下文分区标记');
  await zoneTests();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
})();
