'use strict';
// 扩展入口（extension.js）与 package.json 的测试。纯 node 运行：node test/extension.test.js
// - 内置 vscode 桩（含 l10n、window.tabGroups、TabInputWebview、TabInputCustom、globalState、QuickPick）和假 worker。
// - 右侧 lib/agents-view.js、压缩 lib/compact.js 用真实模块，只在外面包一层记录调用；不会真的弹框或调用 claude CLI。
// - 数据全部是合成的；不读 ~/.claude、~/.codex。临时文件放在 AGENT_MONITOR_TEST_TMP（没设就用系统临时目录），跑完删除。

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const NodeEmitter = require('events');

const ROOT = path.join(__dirname, '..');
const EXT_FILE = path.join(ROOT, 'extension.js');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const nls = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir(), 'am-ext-'));

// ---------------------------------------------------------------------------
// vscode 桩
// ---------------------------------------------------------------------------

const log = {
  contexts: {}, executed: [], opened: [], updates: [], output: [], workers: [], progress: [],
  info: [], warn: [], error: [], clipboard: [], quickPicks: [], agentInputs: [], compactSnapshots: [],
  compactDeps: null, reveals: [], treeViews: {}, webviews: {}, statusItem: null,
  handoffs: [], autoDeps: null, storageOpens: [],
};
const config = {}; // 设置名 -> { globalValue, workspaceValue }
const listeners = { config: [], folders: [], tabs: [], tabGroups: [], windowState: [] };
let quickPickAnswer = null; // (items) => item

class EventEmitter {
  constructor() {
    this.fns = [];
    this.event = (fn) => { this.fns.push(fn); return { dispose: () => { this.fns = this.fns.filter((f) => f !== fn); } }; };
  }
  fire(e) { for (const fn of [...this.fns]) fn(e); }
  dispose() { this.fns = []; }
}
const on = (list) => (fn) => { list.push(fn); return { dispose() { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); } }; };
class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString {
  constructor(value = '', supportThemeIcons = false) { this.value = value; this.supportThemeIcons = supportThemeIcons; }
  appendMarkdown(v) { this.value += v; return this; }
}
class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }
class TabInputText { constructor(uri) { this.uri = uri; } }
const mkUri = (scheme, p) => ({ scheme, fsPath: p, path: p, toString: () => `${scheme}://${p}` });
const Uri = {
  file: (p) => mkUri('file', p),
  joinPath: (u, ...ps) => mkUri(u.scheme, path.join(u.fsPath, ...ps)),
  parse: (s) => { const m = /^([\w+.-]+):\/\/[^/]*(\/.*)?$/.exec(s); return mkUri(m ? m[1] : 'file', m ? m[2] || '/' : s); },
};
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

function effective(key, dflt) {
  const c = config[key] || {};
  if (c.workspaceValue !== undefined) return c.workspaceValue;
  if (c.globalValue !== undefined) return c.globalValue;
  return dflt;
}
function setConfig(key, value, target = ConfigurationTarget.Global) {
  const c = config[key] || (config[key] = {});
  c[target === ConfigurationTarget.Workspace ? 'workspaceValue' : 'globalValue'] = value;
  const e = { affectsConfiguration: (s) => s === 'agentMonitor' || s === `agentMonitor.${key}` };
  for (const fn of [...listeners.config]) fn(e);
}

// 终端标签列表的位置（terminal.integrated.tabs.location）：同一个 config 表里用 tabs.location 这个键，事件带终端的设置名
function setTerminalTabs(value) {
  const c = config['tabs.location'] || (config['tabs.location'] = {});
  c.globalValue = value;
  const e = { affectsConfiguration: (x) => x === 'terminal.integrated.tabs.location' || x === 'terminal.integrated' || x === 'terminal' };
  for (const fn of [...listeners.config]) fn(e);
}

function memento(init = {}) {
  const data = new Map(Object.entries(init));
  return {
    get: (k, d) => (data.has(k) ? data.get(k) : d),
    update: (k, v) => { if (v === undefined) data.delete(k); else data.set(k, v); return Promise.resolve(); },
    keys: () => [...data.keys()],
    setKeysForSync() {},
  };
}

function makeTreeView(id, opts) {
  const sel = new EventEmitter();
  const vis = new EventEmitter();
  const tv = {
    id, opts, visible: true, selection: [], badge: undefined, description: undefined, message: undefined,
    onDidChangeSelection: sel.event,
    onDidChangeVisibility: vis.event,
    onDidExpandElement: () => ({ dispose() {} }),
    onDidCollapseElement: () => ({ dispose() {} }),
    reveal: async (node, o) => {
      log.reveals.push({ view: id, key: node.key || node.id, o });
      if (o && o.select !== false) { tv.selection = [node]; sel.fire({ selection: [node] }); }
    },
    // 测试用：模拟用户点选、切换可见
    userSelect: (node) => { tv.selection = [node]; sel.fire({ selection: [node] }); },
    setVisible: (v) => { tv.visible = v; vis.fire({ visible: v }); },
    dispose() {},
  };
  log.treeViews[id] = tv;
  return tv;
}

const registered = new Map();
const tabState = { active: null };
const windowState = { focused: true };

const vscode = {
  EventEmitter, TreeItem, ThemeIcon, ThemeColor, MarkdownString, Uri, ConfigurationTarget,
  TabInputWebview, TabInputCustom, TabInputText,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  Disposable: class { constructor(fn) { this.fn = fn; } dispose() { if (this.fn) this.fn(); } static from(...d) { return { dispose: () => d.forEach((x) => x.dispose()) }; } },
  l10n: { t: (s) => s, bundle: undefined, uri: undefined },
  env: {
    language: 'en', uriScheme: 'vscode', appName: 'Visual Studio Code',
    clipboard: { writeText: async (t) => { log.clipboard.push(t); }, readText: async () => log.clipboard[log.clipboard.length - 1] || '' },
    openExternal: async () => true,
  },
  extensions: { getExtension: () => undefined },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: (section) => ({
      get: (k, d) => effective(k, d),
      inspect: (k) => ({ key: `${section}.${k}`, ...(config[k] || {}) }),
      update: async (k, v, t) => { log.updates.push([k, v, t]); setConfig(k, v, t); },
      has: (k) => k in config,
    }),
    onDidChangeConfiguration: on(listeners.config),
    onDidChangeWorkspaceFolders: on(listeners.folders),
  },
  window: {
    state: windowState,
    tabGroups: {
      get activeTabGroup() { return { activeTab: tabState.active, tabs: tabState.active ? [tabState.active] : [] }; },
      get all() { return [this.activeTabGroup]; },
      onDidChangeTabs: on(listeners.tabs),
      onDidChangeTabGroups: on(listeners.tabGroups),
    },
    onDidChangeWindowState: on(listeners.windowState),
    createOutputChannel: () => ({ appendLine: (l) => log.output.push(l), append() {}, show() {}, dispose() {} }),
    createStatusBarItem: (id, align, prio) => {
      const s = { id, align, prio, shown: false, text: '', show() { s.shown = true; }, hide() { s.shown = false; }, dispose() {} };
      log.statusItem = s;
      return s;
    },
    createTreeView: (id, opts) => makeTreeView(id, opts),
    registerWebviewViewProvider: (id, provider, opts) => { log.webviews[id] = { provider, opts }; return { dispose() {} }; },
    showTextDocument: async (u) => { log.opened.push(u.fsPath); },
    withProgress: async (o, fn) => { log.progress.push(o); return fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }); },
    showInformationMessage: async (m) => { log.info.push(m); return undefined; },
    showWarningMessage: async (m) => { log.warn.push(m); return undefined; },
    showErrorMessage: async (m) => { log.error.push(m); return undefined; },
    showQuickPick: async (items, o) => { log.quickPicks.push({ items, o }); return quickPickAnswer ? quickPickAnswer(items) : undefined; },
    showInputBox: async () => undefined,
    createQuickPick: () => {
      const accept = new EventEmitter();
      const hide = new EventEmitter();
      const qp = {
        items: [], activeItems: [], selectedItems: [], title: '', placeholder: '',
        onDidAccept: accept.event, onDidHide: hide.event, onDidChangeActive: () => ({ dispose() {} }),
        show() { log.quickPicks.push({ items: qp.items, qp }); setImmediate(() => hide.fire()); },
        hide() { hide.fire(); }, dispose() {},
      };
      return qp;
    },
  },
  commands: {
    registerCommand: (id, fn) => {
      assert.ok(!registered.has(id), `命令重复注册：${id}`);
      registered.set(id, fn);
      return { dispose() { registered.delete(id); } };
    },
    // 只记录，不去调用注册的处理函数（压缩命令会弹 QuickPick；测试里直接调 registered.get(id)）
    executeCommand: async (id, ...args) => {
      log.executed.push([id, ...args]);
      if (id === 'setContext') log.contexts[args[0]] = args[1];
    },
  },
};

// 假 worker：测试里手动发快照、模拟崩溃；terminate 后和真的一样以 1 退出
class FakeWorker extends NodeEmitter {
  constructor(file, opts) {
    super();
    this.file = file;
    this.opts = opts;
    this.messages = [];
    this.terminated = false;
    log.workers.push(this);
  }
  postMessage(m) { this.messages.push(JSON.parse(JSON.stringify(m))); }
  terminate() { this.terminated = true; setImmediate(() => this.emit('exit', 1)); return Promise.resolve(1); }
}

// 右侧视图与压缩：真实模块外面包一层记录调用
const realAgents = require(path.join(ROOT, 'lib', 'agents-view'));
class RecordingAgentsView extends realAgents.AgentsViewProvider {
  update(input) { log.agentInputs.push(input); return super.update(input); }
}
const agentsWrap = { ...realAgents, AgentsViewProvider: RecordingAgentsView };
const realCompact = require(path.join(ROOT, 'lib', 'compact'));
const compactWrap = {
  ...realCompact,
  activateCompact(context, deps) {
    log.compactDeps = deps;
    const api = realCompact.activateCompact(context, deps);
    const inner = api.onSnapshot;
    api.onSnapshot = (snap) => { log.compactSnapshots.push(snap); return inner(snap); };
    // 交接笔记只记录调用（真实流程在 compact.test.js 里测）
    api.runHandoff = async (arg) => { log.handoffs.push(arg); };
    return api;
  },
};
// 自动压缩容量：真实模块（自己注册 agentMonitor.setAutoCompact），外面记下拿到的依赖
let realAuto = null;
try { realAuto = require(path.join(ROOT, 'lib', 'autocompact')); } catch { realAuto = null; }
const autoWrap = realAuto && {
  ...realAuto,
  activateAutoCompact(context, deps) {
    log.autoDeps = deps;
    return realAuto.activateAutoCompact(context, deps);
  },
};
// 模拟模块缺失：设成 {} 时扩展应注册占位命令
const modOverride = { autocompact: null, storage: null };
// 存储页面：只记录打开时拿到的依赖（页面本身在 storage 的测试里测）
const storageWrap = {
  openStorageView(context, deps) { log.storageOpens.push(deps); return { reveal() {} }; },
};

const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === 'vscode') return vscode;
  const fromExt = parent && parent.filename === EXT_FILE;
  if (fromExt && request === 'worker_threads') return { Worker: FakeWorker };
  if (fromExt && request === './lib/agents-view') return agentsWrap;
  if (fromExt && request === './lib/compact') return compactWrap;
  if (fromExt && request === './lib/autocompact' && modOverride.autocompact) return modOverride.autocompact;
  if (fromExt && request === './lib/autocompact' && autoWrap) return autoWrap;
  if (fromExt && request === './lib/storage-view') return modOverride.storage || storageWrap;
  return origLoad.apply(this, arguments);
};

const S = require(path.join(ROOT, 'lib', 'core', 'status'));
const fmt = require(path.join(ROOT, 'lib', 'format'));
const { createI18n } = require(path.join(ROOT, 'lib', 'i18n'));
const { emptyQuotaSnapshot } = require(path.join(ROOT, 'lib', 'core', 'quota'));
const { emptyDailyTotals } = require(path.join(ROOT, 'lib', 'core', 'daily'));
const i18n = createI18n('en');

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

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
const tick = () => new Promise((r) => setImmediate(r));
const clone = (x) => JSON.parse(JSON.stringify(x));
const last = (a) => a[a.length - 1];

// ---------------------------------------------------------------------------
// 合成数据（Snapshot v2）
// ---------------------------------------------------------------------------

const NOW = Date.now();
const MIN = 60e3;
const HOUR = 3600e3;
const WS = path.join(TMP, 'workspace');
const OTHER = path.join(TMP, 'other');
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(OTHER, { recursive: true });
const TRANSCRIPT = path.join(TMP, 'alpha.jsonl');
fs.writeFileSync(TRANSCRIPT, '{"type":"synthetic"}\n');

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
    startedMs: NOW - HOUR, lastActivityMs: NOW - 5000, mtimeMs: NOW - 5000, file: path.join(TMP, 'x.jsonl'),
    ...o,
  };
}
function session(o = {}) {
  const provider = o.provider || 'claude';
  const id = o.id;
  return {
    provider, id, key: `${provider}:${id}`,
    title: `Synthetic ${id}`, titleSource: 'ai',
    cwd: WS, projectDir: WS.replace(/[^a-zA-Z0-9]/g, '-'),
    entry: 'vscode', entryRaw: 'claude-vscode', entrypoint: provider === 'claude' ? 'claude-vscode' : null,
    model: 'claude-opus-5-5', createdMs: NOW - HOUR, updatedMs: NOW - 5000, startedMs: NOW - HOUR,
    doneAtMs: null, live: false, liveStatus: null, waitingFor: null,
    main: agent(), agents: [], workflows: [],
    counts: { running: 1, awaiting: 0, error: 0, done: 0, total: 1 },
    costUsd: 0.5, resume: [],
    ...o,
  };
}

// 四个会话：两个“打开中”（alpha：Claude 在跑；gamma：Codex 可能在等批准），两个“最近”
function fixtures() {
  return [
    session({
      id: '11111111-1111-4111-8111-111111111111', title: 'Alpha chat', live: true, liveStatus: 'busy', startedMs: NOW - 2 * HOUR,
      main: agent({ status: st('tool', NOW - 4000, { pendingTool: 'Bash' }), step: { kind: 'tool', tool: 'Bash', detail: 'npm test', parallel: 1, sinceMs: NOW - 4000 }, tokens: tokens(84000), file: TRANSCRIPT }),
      agents: [
        agent({ id: 'sub1', kind: 'subagent', name: 'Explorer', startedMs: NOW - 50 * MIN }),
        agent({ id: 'sub2', kind: 'subagent', name: 'Reviewer', startedMs: NOW - 40 * MIN, status: st('done', NOW - 30 * MIN) }),
      ],
      counts: { running: 2, awaiting: 0, error: 0, done: 1, total: 3 },
    }),
    session({
      id: '22222222-2222-4222-8222-222222222222', title: 'Beta chat', cwd: OTHER, projectDir: OTHER.replace(/[^a-zA-Z0-9]/g, '-'),
      startedMs: NOW - 3 * HOUR, doneAtMs: NOW - 10 * MIN, entry: 'cli', entryRaw: 'cli', entrypoint: 'cli',
      main: agent({ status: st('done', NOW - 10 * MIN), tokens: tokens(12000) }),
      resume: [{ kind: 'claudeSession', sessionId: '22222222-2222-4222-8222-222222222222', cwd: OTHER, entry: 'cli', autoContinue: null, quota: null,
        estimate: { contextTokens: 12000, ttl: '1h', cacheLikelyExpired: true, usdIfMiss: 0.1, usdIfHit: 0.01 } }],
    }),
    session({
      provider: 'codex', id: '0c0de000-0000-4000-8000-000000000001', title: 'Gamma thread', titleSource: 'index', live: true, liveStatus: 'busy',
      startedMs: NOW - 30 * MIN, entry: 'vscode', entryRaw: 'codex_vscode', model: 'gpt-5.5',
      main: agent({ model: 'gpt-5.5', status: st('maybeAwaitingApproval', NOW - 2 * MIN, { pendingTool: 'apply_patch' }), cacheTtl: null }),
    }),
    session({
      id: '33333333-3333-4333-8333-333333333333', title: 'Delta chat', startedMs: NOW - 4 * HOUR,
      main: agent({ status: st('quota', NOW - 20 * MIN, { quota: { kind: 'session', model: null, resetsAtMs: NOW + HOUR, resetsText: null, source: 'text', autoContinue: null } }) }),
    }),
  ];
}
const KEYS = fixtures().map((s) => s.key);
const [ALPHA, BETA, GAMMA, DELTA] = KEYS;

function snapshot(sessions, extra = {}) {
  return { type: 'snapshot', v: 2, now: Date.now(), sessions, quota: emptyQuotaSnapshot(), today: emptyDailyTotals(NOW - 10 * HOUR), details: {}, sources: {}, ...extra };
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

// 模拟底部面板的页面：把真实 AgentsViewProvider 解析到一个假 webview 视图上，记下发给页面的消息，
// 并能像页面一样发 ready / select / resizeList / more（§11.13）
function openPanel() {
  const provider = log.webviews['agentMonitor.agents'].provider;
  const posted = [];
  let onMsg = null;
  const vis = new EventEmitter();
  const view = {
    visible: true, badge: undefined, description: undefined,
    webview: {
      options: null, html: '', cspSource: 'vscode-resource:',
      asWebviewUri: (u) => ({ toString: () => 'webview:' + u.fsPath }),
      onDidReceiveMessage: (fn) => { onMsg = fn; return { dispose() {} }; },
      postMessage: async (msg) => { posted.push(JSON.parse(JSON.stringify(msg))); return true; },
    },
    onDidChangeVisibility: vis.event,
    onDidDispose: () => ({ dispose() {} }),
  };
  provider.resolveWebviewView(view);
  const page = {
    provider, view, posted,
    msg: (m) => onMsg(m),
    ready: (extra) => onMsg({ type: 'ready', expanded: {}, ...extra }),
    select: (key) => onMsg({ type: 'select', sessionKey: key }),
    lists: () => posted.filter((m) => m.type === 'list'),
    list: () => last(posted.filter((m) => m.type === 'list')),
    rows: () => { const l = page.list(); return l ? l.items.filter((x) => x.kind === 'session') : []; },
    keys: () => page.rows().map((r) => r.key),
    row: (key) => page.rows().find((r) => r.key === key),
    setVisible: (v) => { view.visible = v; vis.fire(); },
  };
  page.ready();
  return page;
}

async function extensionTests() {
  const ext = require(EXT_FILE);
  const globalState = memento();
  const workspaceState = memento();
  const context = { subscriptions: [], extensionPath: ROOT, extensionUri: Uri.file(ROOT), globalState, workspaceState, globalStorageUri: Uri.file(TMP) };
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(WS), name: 'ws', index: 0 }];
  ext.activate(context);
  const ctl = ext._controller();
  const tv = log.treeViews['agentMonitor.tree'];
  const overview = tv.opts.treeDataProvider;
  const w0 = log.workers[0];
  const send = (sessions, extra) => { w0.emit('message', snapshot(clone(sessions), extra)); };
  const agentsShown = () => { const i = last(log.agentInputs); return i && i.session ? i.session.key : null; };
  const focusMsgs = () => w0.messages.filter((m) => m.type === 'focus');
  const page = openPanel();

  await test('激活：底部面板只有一个 webview（没有会话原生树）+ 侧边栏总览树；worker 用 v2 配置启动；未加载时的上下文键', () => {
    assert.deepStrictEqual(Object.keys(log.treeViews), ['agentMonitor.tree'], '底部面板不再注册原生树');
    assert.strictEqual(tv.opts.showCollapseAll, true);
    assert.ok(log.webviews['agentMonitor.agents'], 'webview 没注册');
    assert.ok(log.webviews['agentMonitor.agents'].provider instanceof RecordingAgentsView);
    assert.strictEqual(w0.file, path.join(ROOT, 'lib', 'worker.js'));
    const cfg = w0.opts.workerData;
    assert.deepStrictEqual(Object.keys(cfg).sort(), ['activeWindowMinutes', 'approvalGuess', 'approvalGuessSeconds', 'claude', 'codex', 'intervalMs', 'observedCompact', 'staleMinutes']);
    assert.deepStrictEqual(Object.keys(cfg.claude).sort(), ['configDir', 'configDirSource', 'enabled', 'home', 'projectsDir', 'settingsPath']);
    assert.deepStrictEqual(Object.keys(cfg.codex).sort(), ['enabled', 'home', 'homeSource']);
    assert.strictEqual(cfg.claude.home, path.dirname(cfg.claude.projectsDir));
    // §11.11 第 4 条：CLAUDE_CONFIG_DIR 优先，否则 ~/.claude；登记表与 settings.json 都在它下面
    if (process.env.CLAUDE_CONFIG_DIR) {
      assert.strictEqual(cfg.claude.configDir, process.env.CLAUDE_CONFIG_DIR);
      assert.strictEqual(cfg.claude.configDirSource, 'env');
    } else {
      assert.strictEqual(cfg.claude.configDir, path.join(os.homedir(), '.claude'));
      assert.strictEqual(cfg.claude.configDirSource, 'default');
    }
    assert.deepStrictEqual(cfg.observedCompact, {});
    assert.strictEqual(cfg.approvalGuess, 'fastTools');
    assert.strictEqual(cfg.approvalGuessSeconds, 60);
    assert.strictEqual(cfg.intervalMs, 2000);
    assert.strictEqual(log.contexts['agentMonitor.loaded'], false);
    assert.strictEqual(log.statusItem.id, 'agentMonitor.status');
    assert.strictEqual(log.statusItem.command, 'agentMonitor.show');
    // 未加载：内容区“正在读取”，列表是空的，位置默认跟随终端（右），宽度默认 200
    assert.strictEqual(last(log.agentInputs).loaded, false);
    const l = page.list();
    assert.ok(l, 'ready 之后没发列表');
    assert.deepStrictEqual([l.items.length, l.position, l.width, l.selectedKey], [0, 'right', 200, null]);
    assert.ok(/Content-Security-Policy/.test(page.view.webview.html));
  });

  await test('第一次激活聚焦一次底部面板（globalState 记一次）；状态栏点击 / 显示命令聚焦这个 webview', async () => {
    assert.ok(log.executed.some((x) => x[0] === 'agentMonitor.agents.focus'));
    assert.ok(globalState.get('agentMonitor.panelIntro.v1'));
    const n = log.executed.length;
    await registered.get('agentMonitor.show')();
    assert.deepStrictEqual(log.executed.slice(n), [['agentMonitor.agents.focus']]);
  });

  await test('注册的命令与 package.json 声明一一对应（含 compact.js 的 compact、autocompact.js 的 setAutoCompact）', () => {
    const declared = pkg.contributes.commands.map((c) => c.command).sort();
    assert.deepStrictEqual([...registered.keys()].sort(), declared);
    for (const id of ['revealTranscript', 'copyTranscriptPath', 'handoff', 'setAutoCompact', 'storage']) {
      assert.ok(registered.has('agentMonitor.' + id), '没注册 ' + id);
    }
  });

  await test('自动压缩模块：activateAutoCompact 拿到 getSession / getSessions / i18n / claudeHome / codexHome / output / getSelectedKey', () => {
    if (!realAuto) { console.log('        （lib/autocompact.js 不在，跳过）'); return; }
    const d = log.autoDeps;
    assert.ok(d, 'activateAutoCompact 没被调用');
    for (const k of ['getSession', 'getSessions', 'getSelectedKey']) assert.strictEqual(typeof d[k], 'function', k);
    assert.strictEqual(typeof d.i18n.t, 'function');
    assert.strictEqual(typeof d.output.appendLine, 'function');
    assert.strictEqual(d.claudeHome, w0.opts.workerData.claude.configDir, 'claudeHome = Claude 配置目录（settings.json 所在）');
    // codexHome 要跟着设置 agentMonitor.codex.home 走（不传时模块只认 CODEX_HOME / ~/.codex）
    assert.strictEqual(d.codexHome, w0.opts.workerData.codex.home, 'codexHome = Codex 目录（config.toml 所在）');
  });

  await test('压缩模块：activateCompact 拿到 getSession / i18n / claudeHome / output / getSelectedKey', () => {
    const d = log.compactDeps;
    assert.ok(d, 'activateCompact 没被调用');
    assert.strictEqual(typeof d.getSession, 'function');
    assert.strictEqual(typeof d.i18n.t, 'function');
    const home = typeof d.claudeHome === 'function' ? d.claudeHome() : d.claudeHome;
    assert.strictEqual(home, w0.opts.workerData.claude.configDir, '登记表在 Claude 配置目录下');
    assert.strictEqual(typeof d.output.appendLine, 'function');
    assert.strictEqual(typeof d.getSelectedKey, 'function', '无参数调用时当前选中的会话排第一');
  });

  await test('首份快照：列表“打开中 / 最近”两组，组内按开始时间倒序；内容区显示第一行并发 focus；选中推给页面', async () => {
    send(fixtures());
    await tick();
    assert.strictEqual(log.contexts['agentMonitor.loaded'], true);
    const l = page.list();
    assert.deepStrictEqual(l.items.map((x) => x.id || x.key), ['g:open', GAMMA, ALPHA, 'g:recent', BETA, DELTA]);
    // 从没选过、没有当前对话 → 选第一行，并推给页面
    assert.strictEqual(ctl.selectedKey, GAMMA);
    assert.strictEqual(agentsShown(), GAMMA);
    assert.strictEqual(l.selectedKey, GAMMA);
    assert.deepStrictEqual(last(focusMsgs()).keys, [GAMMA]);
    // 压缩提醒拿到了快照
    assert.strictEqual(log.compactSnapshots.length, 1);
    assert.strictEqual(log.compactDeps.getSession(ALPHA).title, 'Alpha chat');
  });

  await test('选中往返：页面发 select → 内容区切过去、发 focus、记为看过（Beta 从未查看变成已查看），扩展把选中推回页面', async () => {
    assert.strictEqual(page.row(BETA).lamp, 'doneUnseen');
    page.select(BETA);
    await tick();
    assert.strictEqual(ctl.selectedKey, BETA);
    assert.strictEqual(agentsShown(), BETA);
    assert.deepStrictEqual(last(focusMsgs()).keys, [BETA]);
    assert.ok(globalState.get('agentMonitor.seen.v1')[BETA] > 0, '没有记已看过');
    assert.strictEqual(page.list().selectedKey, BETA);
    assert.strictEqual(page.row(BETA).lamp, 'doneSeen');
    // 内容区拿到的是该会话的灯（已看过）
    const input = last(log.agentInputs);
    assert.strictEqual(input.lamps.lamp, 'doneSeen');
    assert.strictEqual(input.loaded, true);
    // 不在列表里的 key：不理
    page.select('claude:nope');
    await tick();
    assert.strictEqual(ctl.selectedKey, BETA);
  });

  await test('数据刷新不移动选中；新快照带上该会话的细节', async () => {
    const sessions = fixtures();
    sessions[0].updatedMs = Date.now(); // Alpha 有活动
    send(sessions, { details: { [BETA]: { key: BETA, agents: { main: { timeline: [], result: null, files: [], errors: [] } } } } });
    await tick();
    assert.strictEqual(ctl.selectedKey, BETA);
    assert.strictEqual(agentsShown(), BETA);
    assert.strictEqual(page.list().selectedKey, BETA);
    assert.ok(last(log.agentInputs).detail, '细节没传给内容区');
  });

  await test('跟随：切到 Claude 标签 → 选中对应会话并推给页面；同一标签上的焦点事件不再移动', async () => {
    tabState.active = { label: 'Alpha chat', input: new TabInputWebview('mainThreadWebview-claudeVSCodePanel') };
    for (const fn of listeners.tabs) fn({ opened: [], closed: [], changed: [tabState.active] });
    await tick();
    assert.strictEqual(ctl.selectedKey, ALPHA);
    assert.strictEqual(agentsShown(), ALPHA);
    assert.strictEqual(page.list().selectedKey, ALPHA);
    assert.deepStrictEqual(last(focusMsgs()).keys, [ALPHA]);
    // 程序跟随的选中不立即记已看过（交给 1.5 秒停留计时）
    assert.ok(!(globalState.get('agentMonitor.seen.v1') || {})[ALPHA]);
    // 用户点回 Beta；同一个 Claude 标签上的窗口焦点事件不会把选中抢回去
    page.select(BETA);
    for (const fn of listeners.windowState) fn({ focused: true });
    await tick();
    assert.strictEqual(ctl.selectedKey, BETA);
    // 数据刷新也不会
    send(fixtures());
    await tick();
    assert.strictEqual(ctl.selectedKey, BETA);
    assert.strictEqual(page.list().selectedKey, BETA);
  });

  await test('跟随：切去看代码标签保持不变；切到 Codex 标签按 URI 里的 id 跟随', async () => {
    tabState.active = { label: 'a.js', input: new TabInputText(Uri.file('/tmp/a.js')) };
    for (const fn of listeners.tabs) fn({});
    await tick();
    assert.strictEqual(ctl.selectedKey, BETA);
    tabState.active = { label: 'whatever', input: new TabInputCustom(Uri.parse('openai-codex://route/local/0c0de000-0000-4000-8000-000000000001'), 'chatgpt.conversationEditor') };
    for (const fn of listeners.tabs) fn({});
    await tick();
    assert.strictEqual(ctl.selectedKey, GAMMA);
    assert.deepStrictEqual(last(focusMsgs()).keys, [GAMMA]);
  });

  await test('跟随：面板不可见时不给页面发消息（不去强行打开面板），重新可见、页面 ready 后补发当前选中', async () => {
    page.setVisible(false);
    const before = page.posted.length;
    const focusCount = () => log.executed.filter((x) => x[0] === 'agentMonitor.agents.focus').length;
    const focus0 = focusCount();
    tabState.active = { label: 'Alpha chat', input: new TabInputWebview('mainThreadWebview-claudeVSCodePanel') };
    for (const fn of listeners.tabs) fn({});
    await tick();
    assert.strictEqual(ctl.selectedKey, ALPHA);
    assert.strictEqual(agentsShown(), ALPHA);
    assert.strictEqual(page.posted.length, before, '不可见时不该发');
    assert.strictEqual(focusCount(), focus0, '跟随不去聚焦（打开）面板');
    page.setVisible(true);
    page.ready();
    await tick();
    assert.strictEqual(page.list().selectedKey, ALPHA);
    assert.strictEqual(last(page.posted.filter((m) => m.type === 'render')).sessionKey, ALPHA);
  });

  await test('followActiveChat 关掉：切标签不移动选中', async () => {
    setConfig('followActiveChat', false);
    page.select(DELTA);
    tabState.active = { label: 'Beta chat', input: new TabInputWebview('mainThreadWebview-claudeVSCodePanel') };
    for (const fn of listeners.tabs) fn({});
    await tick();
    assert.strictEqual(ctl.selectedKey, DELTA);
    setConfig('followActiveChat', true);
    tabState.active = null;
    for (const fn of listeners.tabs) fn({});
  });

  await test('状态栏总灯：NeedsYou → 品红 + 警告底色；文字按紧急度计数', () => {
    const item = log.statusItem;
    assert.ok(item.shown);
    assert.strictEqual(item.color.id, 'agentMonitor.lampNeedsYou');
    assert.strictEqual(item.backgroundColor.id, 'statusBarItem.warningBackground');
    const L = ctl.lamps;
    assert.strictEqual(L.overall, 'needsYou');
    assert.strictEqual(item.text, fmt.formatStatusBarText(L.counts, i18n));
    assert.ok(item.text.startsWith('$(circle-large-filled) '));
    assert.ok(item.tooltip instanceof MarkdownString && item.tooltip.supportThemeIcons);
    assert.ok(!/\$\(/.test(item.accessibilityInformation.label));
  });

  await test('状态栏总灯：只有报错 → 红 + 错误底色；关掉底色设置就不加；全部完成 → 绿', async () => {
    const f = fixtures();
    send([f[3]]);
    await tick();
    assert.strictEqual(log.statusItem.color.id, 'agentMonitor.lampError');
    assert.strictEqual(log.statusItem.backgroundColor.id, 'statusBarItem.errorBackground');
    setConfig('statusBarBackground', false);
    assert.strictEqual(log.statusItem.backgroundColor, undefined);
    setConfig('statusBarBackground', true);
    const done = f[1];
    done.doneAtMs = Date.now();
    done.main.status = st('done', Date.now());
    send([done]);
    await tick();
    assert.strictEqual(log.statusItem.color.id, 'agentMonitor.lampDoneUnseen');
    assert.strictEqual(log.statusItem.backgroundColor, undefined);
    setConfig('showStatusBar', false);
    assert.strictEqual(log.statusItem.shown, false);
    setConfig('showStatusBar', true);
    assert.strictEqual(log.statusItem.shown, true);
  });

  await test('“已看过”变化与徽标：徽标挂在底部面板的 webview 视图上；markSeen({ sessionKey }) → 灯变暗绿、徽标清掉、状态栏跟着变', async () => {
    const s = fixtures()[1];
    s.doneAtMs = Date.now() + 1000; // 比刚才点选的时间晚：又有新结果
    s.main.status = st('done', s.doneAtMs);
    send([s]);
    await tick();
    assert.strictEqual(page.row(BETA).lamp, 'doneUnseen');
    assert.deepStrictEqual(page.view.badge && page.view.badge.value, 1);
    assert.ok(page.view.badge.tooltip.includes(i18n.t('badge.doneUnseen', { n: 1 })));
    assert.strictEqual(tv.badge.value, 1);
    // webview 右键菜单传来的参数形态
    await registered.get('agentMonitor.markSeen')({ webviewSection: 'session', sessionKey: BETA, compactable: false, resumable: true, webview: 'agentMonitor.agents' });
    // seenAtMs = 现在，比 doneAtMs 早 1 秒 → 仍未看过；再用晚一点的时间标一次（字符串 key 也行）
    globalState.update('agentMonitor.seen.v1', { [BETA]: Date.now() + 5000 });
    await registered.get('agentMonitor.markSeen')(BETA);
    assert.strictEqual(page.row(BETA).lamp, 'doneSeen');
    assert.strictEqual(page.view.badge, undefined);
    assert.strictEqual(tv.badge, undefined);
    assert.strictEqual(log.statusItem.color.id, 'agentMonitor.lampDoneSeen');
  });

  await test('markAllSeen：范围内全部记为看过', async () => {
    const f = fixtures();
    send(f);
    await tick();
    await registered.get('agentMonitor.markAllSeen')();
    const seen = globalState.get('agentMonitor.seen.v1');
    for (const k of KEYS) assert.ok(seen[k] > 0, `没记：${k}`);
  });

  await test('列表顺序在 20 份快照间不变：活动交替、灯来回切、输入顺序打乱；列表消息里只有灯变了的那一行在变', async () => {
    send(fixtures());
    await tick();
    const want = page.keys();
    assert.deepStrictEqual(want, [GAMMA, ALPHA, BETA, DELTA]);
    const vis = (r) => JSON.stringify([r.title, r.desc, r.lamp, r.shape, r.a11y, r.context, r.group]);
    let prev = page.list();
    const n0 = page.lists().length;
    for (let i = 0; i < 20; i++) {
      const f = fixtures();
      const t = Date.now();
      // Alpha 与 Beta 交替最新；Alpha 在“工具 / 思考”之间切（都是 Working），Beta 在“完成 / 在跑”之间切（灯变）
      f[0].updatedMs = i % 2 ? t : t - 60e3;
      f[1].updatedMs = i % 2 ? t - 60e3 : t;
      f[0].main.status = st(i % 2 ? 'thinking' : 'tool', t - 1000, { pendingTool: i % 2 ? null : 'Bash' });
      f[1].main.status = i % 2 ? st('thinking', t - 1000) : st('done', t - 1000);
      f[0].main.tokens = tokens(84000 + i * 10); // token 在涨，但百分比不变
      // 快照里的顺序打乱
      const shuffled = i % 3 === 0 ? f.reverse() : i % 3 === 1 ? [f[2], f[0], f[3], f[1]] : f;
      send(shuffled);
      await tick();
      assert.deepStrictEqual(page.keys(), want, `第 ${i + 1} 次顺序变了`);
      const cur = page.list();
      const before = new Map(prev.items.filter((x) => x.kind === 'session').map((r) => [r.key, vis(r)]));
      const changed = page.rows().filter((r) => before.get(r.key) !== vis(r)).map((r) => r.key);
      for (const k of changed) assert.strictEqual(k, BETA, `不该变 ${k}`);
      prev = cur;
    }
    assert.ok(page.lists().length > n0, 'Beta 的灯在变，列表应该重发');
  });

  await test('新会话出现在它那一组的最上面；会话从“最近”变成“打开中”才换位置', async () => {
    const f = fixtures();
    const fresh = session({ id: '44444444-4444-4444-8444-444444444444', title: 'Epsilon', startedMs: Date.now() });
    send([...f, fresh]);
    await tick();
    const grp = (g) => page.rows().filter((r) => r.group === g).map((r) => r.key);
    assert.deepStrictEqual(grp('recent'), [fresh.key, BETA, DELTA]);
    f[1].live = true;
    f[1].liveStatus = 'idle';
    send([...f, fresh]);
    await tick();
    assert.deepStrictEqual(grp('open'), [GAMMA, ALPHA, BETA]);
    assert.deepStrictEqual(grp('recent'), [fresh.key, DELTA]);
  });

  await test('范围切换：只看工作区 → 列表、总览、状态栏都按工作区；写到用户设置；视图说明；空状态给“显示所有会话”', async () => {
    send(fixtures());
    await tick();
    page.select(BETA);
    await tick();
    assert.strictEqual(agentsShown(), BETA);
    await registered.get('agentMonitor.scope.workspace')();
    assert.deepStrictEqual(log.updates.pop(), ['scope', 'workspace', ConfigurationTarget.Global]);
    const keys = page.keys();
    assert.ok(!keys.includes(BETA), 'Beta 在别的目录，应该被滤掉');
    assert.deepStrictEqual([...keys].sort(), [ALPHA, GAMMA, DELTA].sort());
    assert.deepStrictEqual(overview.getChildren().map((n) => n.key).sort(), [ALPHA, GAMMA, DELTA].sort());
    assert.strictEqual(page.view.description, i18n.t('scope.workspace'));
    assert.ok(tv.description.includes(i18n.t('scope.workspace')));
    // 选中的 Beta 被滤掉 → 重新按规则选：内容区换成范围内的会话，页面上高亮同一个
    assert.ok(keys.includes(agentsShown()));
    assert.strictEqual(ctl.selectedKey, agentsShown());
    assert.strictEqual(page.list().selectedKey, agentsShown());
    // 工作区里一个会话都没有 → filteredOut；内容区空状态带“显示所有会话”，页面点了执行 scope.all
    vscode.workspace.workspaceFolders = [{ uri: Uri.file(path.join(TMP, 'nothing-here')), name: 'x', index: 0 }];
    for (const fn of listeners.folders) fn({});
    assert.strictEqual(log.contexts['agentMonitor.filteredOut'], true);
    assert.strictEqual(page.rows().length, 0);
    assert.strictEqual(last(log.agentInputs).session, null);
    assert.strictEqual(last(log.agentInputs).emptyText, i18n.t('scope.empty.workspace'));
    assert.strictEqual(last(log.agentInputs).emptyAction, 'showAll');
    const render = last(page.posted.filter((m) => m.type === 'render'));
    assert.deepStrictEqual(render.emptyAction, { act: 'showAll', text: i18n.t('scope.showAll') });
    const n = log.executed.length;
    page.msg({ type: 'showAll' });
    await tick();
    assert.deepStrictEqual(log.executed.slice(n), [['agentMonitor.scope.all']]);
    vscode.workspace.workspaceFolders = [{ uri: Uri.file(WS), name: 'ws', index: 0 }];
    for (const fn of listeners.folders) fn({});
    // 工作区里设过 scope → 按钮写工作区那一层
    config.scope.workspaceValue = 'workspace';
    await registered.get('agentMonitor.scope.all')();
    assert.deepStrictEqual(log.updates.pop(), ['scope', 'all', ConfigurationTarget.Workspace]);
    assert.strictEqual(page.keys().length, 4);
    assert.strictEqual(page.view.description, undefined);
    assert.strictEqual(log.contexts['agentMonitor.filteredOut'], false);
    assert.strictEqual(last(log.agentInputs).emptyAction, null);
    delete config.scope;
    setConfig('scope', 'all');
  });

  await test('列表位置：auto 跟随终端标签列表（terminal.integrated.tabs.location），变了立即推给页面；设置 left / right 优先', async () => {
    assert.strictEqual(page.list().position, 'right', '终端默认在右');
    setTerminalTabs('left');
    await tick();
    assert.strictEqual(page.list().position, 'left');
    setConfig('sessionListPosition', 'right');
    await tick();
    assert.strictEqual(page.list().position, 'right', '设置优先');
    setConfig('sessionListPosition', 'auto');
    await tick();
    assert.strictEqual(page.list().position, 'left');
    setTerminalTabs('right');
    await tick();
    assert.strictEqual(page.list().position, 'right');
    // 别的终端设置变了：不重发
    const n = page.posted.length;
    for (const fn of [...listeners.config]) fn({ affectsConfiguration: (x) => x === 'terminal.integrated.fontSize' || x === 'terminal.integrated' });
    await tick();
    assert.strictEqual(page.posted.length, n);
  });

  await test('列表宽度：页面拖完发 resizeList → 吸附后存 globalState 并推回页面；同样的宽度不重复写；重新激活后保持', async () => {
    const writes = [];
    const orig = globalState.update;
    globalState.update = (k, v) => { if (k === 'agentMonitor.sessionListWidth') writes.push(v); return orig(k, v); };
    page.msg({ type: 'resizeList', width: 263.6 });
    await tick();
    assert.deepStrictEqual(writes, [264]);
    assert.strictEqual(page.list().width, 264);
    page.msg({ type: 'resizeList', width: 264 });
    await tick();
    assert.deepStrictEqual(writes, [264], '没变不写');
    // 拖到中点以下：吸附成窄条
    page.msg({ type: 'resizeList', width: 50 });
    await tick();
    assert.deepStrictEqual(writes, [264, 46]);
    assert.strictEqual(page.list().width, 46);
    // 双击复位（页面发默认宽度）
    page.msg({ type: 'resizeList', width: 200 });
    await tick();
    assert.strictEqual(globalState.get('agentMonitor.sessionListWidth'), 200);
    // 页面自己记着的宽度（webview state）在 ready 时报上来：以页面为准
    page.ready({ listWidth: 240 });
    await tick();
    assert.strictEqual(globalState.get('agentMonitor.sessionListWidth'), 240);
    assert.strictEqual(page.list().width, 240);
    page.msg({ type: 'resizeList', width: 'wide' });
    await tick();
    assert.strictEqual(globalState.get('agentMonitor.sessionListWidth'), 240, '不是数字不理');
    globalState.update = orig;
  });

  await test('行尾“…”：弹出与右键菜单同样内容的 QuickPick（标题来自 package.nls，按 compactable / resumable 过滤），选中后用 { sessionKey } 执行', async () => {
    send(fixtures());
    await tick();
    const titleOf = (id) => nls[pkg.contributes.commands.find((c) => c.command === id).title.slice(1, -1)];
    let items = null;
    quickPickAnswer = (it) => { items = it; return it.find((x) => x.command === 'agentMonitor.copyTranscriptPath'); };
    page.msg({ type: 'more', sessionKey: ALPHA });
    await tick();
    await tick();
    const cmds = items.filter((x) => x.command).map((x) => x.command.replace('agentMonitor.', ''));
    // Alpha：上下文 8.4 万（可压缩），没有续跑提示
    assert.deepStrictEqual(cmds, ['compact', 'handoff', 'setAutoCompact', 'markSeen', 'openTranscript', 'revealTranscript', 'copyTranscriptPath']);
    assert.strictEqual(items.filter((x) => x.kind === vscode.QuickPickItemKind.Separator).length, 1, '两组之间一条分隔线');
    const compact = items.find((x) => x.command === 'agentMonitor.compact');
    assert.strictEqual(compact.label, '$(screen-normal) ' + titleOf('agentMonitor.compact'));
    assert.strictEqual(last(log.quickPicks).o.placeHolder, 'Alpha chat');
    assert.deepStrictEqual(last(log.executed), ['agentMonitor.copyTranscriptPath', { webviewSection: 'session', sessionKey: ALPHA }]);
    // Beta：有续跑提示、上下文不到 2 万 → 有 copyResume、没有 compact；取消就什么都不执行
    const n = log.executed.length;
    quickPickAnswer = (it) => { items = it; return undefined; };
    page.msg({ type: 'more', sessionKey: BETA });
    await tick();
    await tick();
    const beta = items.filter((x) => x.command).map((x) => x.command.replace('agentMonitor.', ''));
    assert.ok(beta.includes('copyResume') && !beta.includes('compact'), beta.join());
    assert.strictEqual(log.executed.length, n);
    quickPickAnswer = null;
  });

  await test('命令都接受 webview 右键菜单传来的 { sessionKey }：compact、setAutoCompact 直接进该会话（不先选会话）', async () => {
    const arg = { webviewSection: 'session', sessionKey: ALPHA, compactable: true, resumable: false, preventDefaultContextMenuItems: true, webview: 'agentMonitor.agents' };
    const errs = log.error.length;
    const qps = log.quickPicks.length;
    await registered.get('agentMonitor.compact')(arg);
    assert.strictEqual(log.error.length, errs);
    const qp = log.quickPicks[qps];
    assert.ok(qp && qp.qp && String(qp.qp.title).includes('Alpha chat'), '压缩选项的标题带会话名：' + (qp && qp.qp && qp.qp.title));
    if (realAuto) {
      const n = log.quickPicks.length;
      await registered.get('agentMonitor.setAutoCompact')(arg);
      assert.strictEqual(log.error.length, errs);
      const q = log.quickPicks[n];
      assert.ok(q, '没弹档位选择');
      assert.ok(!(q.items || []).some((it) => it && typeof it.key === 'string' && it.key.includes(':')), '不该先弹会话选择');
    }
  });

  await test('隐藏已完成：只重算，不发给 worker；内容区拿到设置', async () => {
    const sent = w0.messages.length;
    await registered.get('agentMonitor.hideCompleted')();
    assert.strictEqual(last(log.agentInputs).settings.hideCompleted, true);
    assert.strictEqual(tv.description, i18n.t('tree.hideCompleted'));
    const alpha = overview.getChildren().find((n) => n.key === ALPHA);
    assert.ok(!overview.getChildren(alpha).some((n) => n.id.endsWith('/a/sub2')), '已完成的子智能体没隐藏');
    await registered.get('agentMonitor.showCompleted')();
    assert.strictEqual(last(log.agentInputs).settings.hideCompleted, false);
    assert.ok(overview.getChildren(overview.getChildren().find((n) => n.key === ALPHA)).some((n) => n.id.endsWith('/a/sub2')));
    assert.strictEqual(w0.messages.filter((m) => m.type === 'config').length, w0.messages.slice(0, sent).filter((m) => m.type === 'config').length);
  });

  await test('扫描设置变了发 config（v2 配置）；刷新命令发 refresh，进度条（底部面板）等到下一份快照', async () => {
    setConfig('refreshSeconds', 3);
    let m = last(w0.messages);
    assert.strictEqual(m.type, 'config');
    assert.strictEqual(m.cfg.intervalMs, 3000);
    setConfig('approvalGuess', 'off');
    m = last(w0.messages);
    assert.strictEqual(m.type, 'config');
    assert.strictEqual(m.cfg.approvalGuess, 'off');
    const done = registered.get('agentMonitor.refresh')();
    assert.deepStrictEqual(last(w0.messages), { type: 'refresh' });
    assert.deepStrictEqual(last(log.progress), { location: { viewId: 'agentMonitor.agents' } });
    let finished = false;
    done.then(() => { finished = true; });
    await tick();
    assert.strictEqual(finished, false);
    send(fixtures());
    await tick();
    assert.strictEqual(finished, true);
  });

  await test('内容区：会话条的压缩只转给当前会话；列表行尾的压缩可以是列表里的任一会话', async () => {
    const shown = agentsShown();
    page.msg({ type: 'compact', sessionKey: shown });
    await tick();
    assert.deepStrictEqual(last(log.executed), ['agentMonitor.compact', shown]);
    const other = [ALPHA, BETA, GAMMA, DELTA].find((k) => k !== shown);
    page.msg({ type: 'compact', sessionKey: other });
    await tick();
    assert.deepStrictEqual(last(log.executed), ['agentMonitor.compact', other]);
    // 不在列表里：不理
    const n = log.executed.length;
    page.msg({ type: 'compact', sessionKey: 'claude:not-listed' });
    await tick();
    assert.strictEqual(log.executed.length, n);
  });

  await test('续跑：参数是 { sessionKey }；一条提示一种写法时直接复制；多种写法弹 QuickPick，复制扩展端重新生成的文本', async () => {
    send(fixtures());
    await tick();
    quickPickAnswer = (items) => items.find((it) => it.variant === 'cli');
    await registered.get('agentMonitor.copyResume')({ webviewSection: 'session', sessionKey: BETA, resumable: true });
    const hint = fixtures()[1].resume[0];
    const f = fmt.formatResumeHint(hint, i18n, { platform: process.platform });
    assert.strictEqual(last(log.clipboard), f.command);
    assert.strictEqual(last(log.info), i18n.t('resume.copied.cli'));
    assert.ok(last(log.quickPicks).items.length === 2);
    quickPickAnswer = null;
    await registered.get('agentMonitor.copyResume')(ALPHA);
    assert.strictEqual(last(log.info), i18n.t('ext.noResume'));
  });

  await test('打开记录：{ sessionKey }、字符串 key、总览树节点都行；只打开快照里出现过、存在的 .jsonl', async () => {
    const open = registered.get('agentMonitor.openTranscript');
    await open({ webviewSection: 'session', sessionKey: ALPHA });
    assert.deepStrictEqual(log.opened.splice(0), [TRANSCRIPT]);
    await open(ALPHA);
    assert.deepStrictEqual(log.opened.splice(0), [TRANSCRIPT]);
    const alphaTree = overview.getChildren().find((n) => n.key === ALPHA);
    await open(overview.getChildren(alphaTree)[0]); // 主智能体
    assert.deepStrictEqual(log.opened.splice(0), [TRANSCRIPT]);
    await open({ kind: 'agent', data: { file: '/etc/passwd' } });
    await open({ kind: 'agent', data: { file: path.join(TMP, 'unknown.jsonl') } });
    await open({ sessionKey: 'claude:nope' });
    await open(undefined);
    assert.deepStrictEqual(log.opened, []);
    // 快照里有但文件不在了：提示
    await open({ webviewSection: 'session', sessionKey: BETA });
    assert.strictEqual(last(log.warn), i18n.t('ext.transcriptMissing'));
  });

  await test('§11.11 记录位置：revealTranscript 用 revealFileInOS 显示主记录；copyTranscriptPath 复制路径；只用快照里的路径', async () => {
    send(fixtures());
    await tick();
    const reveal = registered.get('agentMonitor.revealTranscript');
    const copy = registered.get('agentMonitor.copyTranscriptPath');
    const n = log.executed.length;
    await reveal({ webviewSection: 'session', sessionKey: ALPHA });
    let x = log.executed.slice(n).find((e) => e[0] === 'revealFileInOS');
    assert.ok(x, '没执行 revealFileInOS');
    assert.strictEqual(x[1].fsPath, TRANSCRIPT);
    // 总览树的会话节点、sessionKey 字符串（内容区会话条发来的）都行
    const alphaTree = overview.getChildren().find((node) => node.key === ALPHA);
    await copy(alphaTree);
    assert.strictEqual(last(log.clipboard), TRANSCRIPT);
    assert.strictEqual(last(log.info), i18n.t('ext.transcriptPathCopied'));
    await copy(ALPHA);
    assert.strictEqual(last(log.clipboard), TRANSCRIPT);
    await copy({ webviewSection: 'session', sessionKey: ALPHA });
    assert.strictEqual(last(log.clipboard), TRANSCRIPT);
    // provider 给了 transcript 字段时用它（§11.12.2）
    const f = fixtures();
    const other = path.join(TMP, 'alpha-transcript.jsonl');
    fs.writeFileSync(other, '{}\n');
    f[0].transcript = other;
    send(f);
    await tick();
    const m = log.executed.length;
    await reveal(ALPHA);
    x = log.executed.slice(m).find((e) => e[0] === 'revealFileInOS');
    assert.strictEqual(x[1].fsPath, other);
    // 不认识的会话、伪造的路径：什么都不做
    const k = log.executed.length;
    const clips = log.clipboard.length;
    await reveal({ kind: 'session', key: 'claude:nope', transcript: '/etc/passwd' });
    await reveal({ sessionKey: 'claude:nope', file: '/etc/passwd' });
    await copy('claude:nope');
    await reveal({ file: '/etc/passwd' });
    assert.strictEqual(log.executed.length, k);
    assert.strictEqual(log.clipboard.length, clips);
    // 文件已不在：提示，不执行
    await reveal(BETA);
    assert.strictEqual(last(log.warn), i18n.t('ext.transcriptMissing'));
    assert.strictEqual(log.executed.length, k);
  });

  await test('§11.8 第 4 条 handoff：有参数（{ sessionKey } 或 key）直接交给 compact.js 的 runHandoff；命令面板里没参数先选会话（当前选中的排第一）', async () => {
    send(fixtures());
    await tick();
    const handoff = registered.get('agentMonitor.handoff');
    log.handoffs.length = 0;
    await handoff({ webviewSection: 'session', sessionKey: DELTA });
    assert.deepStrictEqual(log.handoffs, [DELTA]);
    page.select(BETA);
    await tick();
    let seenItems = null;
    quickPickAnswer = (items) => { seenItems = items; return items[1]; };
    await handoff();
    assert.strictEqual(seenItems[0].key, BETA, '当前选中的排第一');
    assert.ok(seenItems[0].description.includes(i18n.t('ext.pickSession.selected')));
    assert.deepStrictEqual(seenItems.map((it) => it.key).sort(), [...KEYS].sort());
    assert.deepStrictEqual(log.handoffs, [DELTA, seenItems[1].key]);
    // 取消选择：不调用
    quickPickAnswer = () => undefined;
    await handoff();
    assert.strictEqual(log.handoffs.length, 2);
    quickPickAnswer = null;
  });

  await test('§11.12.3 存储：命令打开存储页，requestStorage 发 { type: storage, force } 给 worker，回来的报告去掉 type 交给页面', async () => {
    await registered.get('agentMonitor.storage')();
    const deps = last(log.storageOpens);
    assert.ok(deps, 'openStorageView 没被调用');
    assert.strictEqual(deps.platform, process.platform);
    assert.strictEqual(typeof deps.i18n.t, 'function');
    const w = last(log.workers);
    const p1 = deps.requestStorage(false);
    assert.deepStrictEqual(last(w.messages), { type: 'storage', force: false });
    const p2 = deps.requestStorage(true);
    assert.deepStrictEqual(last(w.messages), { type: 'storage', force: true });
    const report = { at: Date.now(), claude: { dir: '/synthetic/.claude', dirSource: 'default', entries: [] }, codex: { dir: '/synthetic/.codex', dirSource: 'default', entries: [] },
      volumes: [{ mount: '/', freeBytes: 1, totalBytes: 2 }], cleanupPeriodDays: null };
    w.emit('message', { type: 'storage', ...report });
    assert.deepStrictEqual(await p1, report, '报告里不带 type');
    assert.deepStrictEqual(await p2, report, '同时等着的请求一起返回');
    // worker 不在了还有人在等：再要一次时先起一个新 worker，新 worker 把等着的请求一次发出去
    const p3 = deps.requestStorage(false);
    ctl.stopWorker();
    const p4 = deps.requestStorage(false);
    const w2 = last(log.workers);
    assert.notStrictEqual(w2, w);
    assert.strictEqual(w2.messages.filter((m) => m.type === 'storage').length, 1, '新 worker 收到一次存储请求');
    w2.emit('message', { type: 'storage', ...report, at: 2 });
    assert.strictEqual((await p3).at, 2);
    assert.strictEqual((await p4).at, 2);
    await tick();
    assert.strictEqual(last(log.workers), w2, '旧 worker 被停掉后不会自己重启');
    // 打开中的会话（迁移前检查）：Claude 看登记表，Codex 看进行中的回合
    send(fixtures());
    await tick();
    assert.deepStrictEqual(deps.liveSessions().map((x) => x.sessionId).sort(), [fixtures()[0].id, fixtures()[2].id].sort());
    assert.deepStrictEqual(Object.keys(deps.liveSessions()[0]).sort(), ['provider', 'sessionId', 'title']);
  });

  await test('§11.10 实测压缩点：新的自动压缩按“模型|窗口”写 globalState，并马上在 config 里带给 worker；旧的、手动的、设置覆盖的不算', async () => {
    const w = last(log.workers);
    const f = fixtures();
    const t0 = Date.now() - 10 * MIN;
    f[1].contextWindow = 1000000;
    f[1].main.lastCompact = { ms: t0, trigger: 'auto', preTokens: 955123, postTokens: 30000, model: 'claude-opus-5-5' };
    f[3].main.lastCompact = { ms: t0 + 1000, trigger: 'manual', preTokens: 400000, postTokens: 20000, model: 'claude-opus-5-5' }; // 手动：不算
    f[2].main.lastCompact = { ms: t0 + 2000, trigger: 'auto', preTokens: 200000, postTokens: 20000, model: 'gpt-5.5' };        // Codex：不算
    const sent = w.messages.length;
    send(f);
    await tick();
    assert.deepStrictEqual(globalState.get('agentMonitor.observedCompact'), { 'claude-opus-5-5|1000000': 955123 });
    const cfgs = w.messages.slice(sent).filter((m) => m.type === 'config');
    assert.strictEqual(cfgs.length, 1);
    assert.deepStrictEqual(cfgs[0].cfg.observedCompact, { 'claude-opus-5-5|1000000': 955123 });
    // 同一份再来：不再发 config，也不再写 globalState（每 2 秒一份快照，不能每次都写）
    const sent2 = w.messages.length;
    const origUpdate = globalState.update;
    let writes = 0;
    globalState.update = (k, v) => { writes++; return origUpdate(k, v); };
    send(f);
    await tick();
    send(f);
    await tick();
    globalState.update = origUpdate;
    assert.strictEqual(w.messages.slice(sent2).filter((m) => m.type === 'config').length, 0);
    assert.strictEqual(writes, 0, '没有新的实测时不写 globalState');
    // 更早的一次（另一个会话）不覆盖；压缩点来自设置的会话不学
    const g = fixtures();
    g[1].contextWindow = 1000000;
    g[1].main.lastCompact = { ms: t0 - HOUR, trigger: 'auto', preTokens: 900000, model: 'claude-opus-5-5' };
    g[3].contextWindow = 1000000;
    g[3].compactAtSource = 'settings-user';
    g[3].main.lastCompact = { ms: t0 + HOUR, trigger: 'auto', preTokens: 367000, model: 'claude-opus-5-5' };
    send(g);
    await tick();
    assert.deepStrictEqual(globalState.get('agentMonitor.observedCompact'), { 'claude-opus-5-5|1000000': 955123 });
    // 更晚的一次：覆盖；另一个窗口单独记
    const h = fixtures();
    h[1].contextWindow = 1000000;
    h[1].main.lastCompact = { ms: t0 + 5 * MIN, trigger: 'auto', preTokens: 961000, model: 'claude-opus-5-5' };
    h[3].main.lastCompact = { ms: t0 + 5 * MIN, trigger: 'auto', preTokens: 166500, model: 'claude-opus-4-8' };
    h[3].contextWindow = 200000; // 会话级窗口优先于主智能体 tokens 里的 1M
    const sent3 = w.messages.length;
    send(h);
    await tick();
    const want = { 'claude-opus-5-5|1000000': 961000, 'claude-opus-4-8|200000': 166500 };
    assert.deepStrictEqual(globalState.get('agentMonitor.observedCompact'), want);
    assert.deepStrictEqual(last(w.messages.slice(sent3).filter((m) => m.type === 'config')).cfg.observedCompact, want);
    assert.ok(log.output.some((l) => l.includes('claude-opus-4-8')), '输出面板记一行');
    // 之后别的设置变化发的 config 也带着它
    setConfig('staleMinutes', 6);
    assert.deepStrictEqual(last(w.messages).cfg.observedCompact, want);
    setConfig('staleMinutes', 5);
    // 纯函数
    const { observedCompactsOf } = ext._internal;
    assert.strictEqual(observedCompactsOf([{ provider: 'claude', main: { model: 'm', lastCompact: { ms: 1, trigger: 'auto', preTokens: 0 }, tokens: { contextWindow: 1 } } }]).size, 0, 'preTokens 为 0 不学');
    assert.strictEqual(observedCompactsOf([{ provider: 'claude', compactAtSource: 'disabled', main: { model: 'm', lastCompact: { ms: 1, trigger: 'auto', preTokens: 5 }, tokens: { contextWindow: 9 } } }]).size, 0);
    assert.strictEqual(observedCompactsOf(null).size, 0);
    // 压缩时的模型和窗口以 lastCompact 上的为准（provider 按那次的模型算好 contextWindow）；键与 core/context.js 的 observedKey 同形
    const switched = observedCompactsOf([{ provider: 'claude', contextWindow: 1000000,
      main: { model: 'claude-opus-5-5', tokens: { contextWindow: 1000000 }, lastCompact: { ms: 5, trigger: 'auto', preTokens: 166000, model: 'claude-opus-4-8', contextWindow: 200000 } } }]);
    const { observedKey } = require(path.join(ROOT, 'lib', 'core', 'context'));
    assert.deepStrictEqual([...switched.keys()], [observedKey('claude-opus-4-8', 200000)]);
  });

  await test('设置里不再有 staleAsNeedsYou；右侧拿到的设置只有这几项', () => {
    const settings = last(log.agentInputs).settings;
    assert.deepStrictEqual(Object.keys(settings).sort(), ['contextHintAct', 'contextHintStart', 'hideCompleted', 'showCost']);
  });

  await test('worker 崩溃自动重启最多 3 次；重启后重发 focus；之后刷新能再起一个', async () => {
    let w = log.workers[log.workers.length - 1];
    for (let i = 0; i < 3; i++) {
      const count = log.workers.length;
      w.emit('exit', 1);
      assert.strictEqual(log.workers.length, count + 1, `第 ${i + 1} 次崩溃没有重启`);
      w = last(log.workers);
      assert.ok(w.messages.some((m) => m.type === 'focus'), '新 worker 没收到 focus');
    }
    const count = log.workers.length;
    w.emit('exit', 1);
    assert.strictEqual(log.workers.length, count, '超过 3 次还在重启');
    const done = registered.get('agentMonitor.refresh')();
    assert.strictEqual(log.workers.length, count + 1, 'worker 挂了之后刷新没有重起');
    last(log.workers).emit('message', snapshot(fixtures()));
    await done;
  });

  await test('停用：worker 被 terminate，随后的退出不会触发重启；输出面板没有报错', async () => {
    const w = last(log.workers);
    const count = log.workers.length;
    for (const d of context.subscriptions) d.dispose();
    assert.strictEqual(w.terminated, true);
    await tick();
    await tick();
    assert.strictEqual(log.workers.length, count);
    ext.deactivate();
    // 只允许 worker 重启和“记下实测压缩点”这两类信息行
    const bad = log.output.filter((l) => !/Background reader stopped|Measured auto-compact point/.test(l));
    assert.deepStrictEqual(bad, [], bad.join('\n'));
  });

  await test('再次激活：不再聚焦底部面板；旧设置 onlyWorkspace=true 迁移成 scope=workspace；实测压缩点从 globalState 带进 worker；缺模块时有占位命令', () => {
    for (const k of Object.keys(config)) delete config[k];
    config.onlyWorkspace = { globalValue: true };
    registered.clear();
    const executed = log.executed.length;
    const context2 = { subscriptions: [], extensionPath: ROOT, extensionUri: Uri.file(ROOT), globalState, workspaceState: memento() };
    // 这次模拟自动压缩、存储页模块都加载不到：命令照样注册，点了给出说明
    modOverride.autocompact = {};
    modOverride.storage = {};
    ext.activate(context2);
    modOverride.autocompact = null;
    modOverride.storage = null;
    assert.deepStrictEqual([...registered.keys()].sort(), pkg.contributes.commands.map((c) => c.command).sort());
    const errs = log.error.length;
    registered.get('agentMonitor.setAutoCompact')();
    registered.get('agentMonitor.storage')();
    assert.deepStrictEqual(log.error.slice(errs), [i18n.t('ext.autoCompactUnavailable'), i18n.t('ext.storageUnavailable')]);
    assert.ok(!log.executed.slice(executed).some((x) => x[0] === 'agentMonitor.agents.focus'));
    // 列表宽度从 globalState 带进新的控制器
    assert.strictEqual(ext._controller().listWidth, 240);
    assert.ok(log.updates.some(([k, v, t]) => k === 'scope' && v === 'workspace' && t === ConfigurationTarget.Global));
    assert.deepStrictEqual(last(log.workers).opts.workerData.observedCompact, globalState.get('agentMonitor.observedCompact'));
    assert.ok(Object.keys(last(log.workers).opts.workerData.observedCompact).length >= 1);
    for (const d of context2.subscriptions) d.dispose();
    ext.deactivate();
  });
}

// ---------------------------------------------------------------------------
// package.json / package.nls.json
// ---------------------------------------------------------------------------

async function manifestTests() {
  const c = pkg.contributes;
  const commands = new Set(c.commands.map((x) => x.command));
  const submenus = new Set((c.submenus || []).map((x) => x.id));
  const views = new Map();
  for (const [container, list] of Object.entries(c.views)) for (const v of list) views.set(v.id, { container, ...v });
  const containers = new Set([...c.viewsContainers.activitybar, ...c.viewsContainers.panel].map((x) => x.id));
  const settings = new Set(Object.keys(c.configuration.properties));

  await test('后台线程带内存限制：新生代压小，老生代只作保险', () => {
    const src = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
    const m = src.match(/const WORKER_LIMITS = Object\.freeze\(\{ maxYoungGenerationSizeMb: (\d+), maxOldGenerationSizeMb: (\d+) \}\);/);
    assert.ok(m, '有 WORKER_LIMITS');
    assert.ok(Number(m[1]) <= 8 && Number(m[2]) >= 256, m[0]);
    assert.ok(/new Worker\(.*resourceLimits: WORKER_LIMITS \}\);/.test(src), '起 worker 时带上');
  });

  await test('发布字段：名字、版本、预览、许可、发布者、仓库、图标、分类', () => {
    assert.strictEqual(pkg.name, 'cyuneo-agent-monitor');
    assert.strictEqual(pkg.version, '0.3.1');
    assert.strictEqual(pkg.preview, true);
    assert.strictEqual(pkg.publisher, 'cyuneo');
    assert.strictEqual(pkg.license, 'PolyForm-Noncommercial-1.0.0');
    assert.strictEqual(pkg.displayName, '%displayName%');
    assert.strictEqual(nls.displayName, 'CYUNEO Agent Monitor');
    assert.strictEqual(pkg.description, '%description%');
    assert.ok(!('private' in pkg), '要删掉 private');
    assert.deepStrictEqual(pkg.author, { name: 'Chenyu Guo', url: 'https://github.com/cyuneo' });
    assert.strictEqual(pkg.repository.url, 'https://github.com/cyuneo/cyuneo-agent-monitor.git');
    assert.strictEqual(pkg.bugs.url, 'https://github.com/cyuneo/cyuneo-agent-monitor/issues');
    assert.ok(pkg.homepage.startsWith('https://github.com/cyuneo/cyuneo-agent-monitor'));
    assert.ok(pkg.qna);
    // §11.12.7a：categories 加上商店的正式分类 AI
    assert.deepStrictEqual(pkg.categories, ['AI', 'Visualization', 'Other']);
    assert.ok(/\.png$/.test(pkg.icon), '扩展图标必须是 PNG');
    if (!fs.existsSync(path.join(ROOT, pkg.icon))) console.log(`        （${pkg.icon} 还没生成，由发布材料阶段提供）`);
    assert.deepStrictEqual(pkg.galleryBanner, { color: '#080808', theme: 'dark' });
    assert.ok(pkg.keywords.length > 0 && pkg.keywords.length <= 30);
    assert.ok(pkg.engines.vscode);
  });

  await test('名称、关键词、图标路径里不出现 Claude / Anthropic / Codex / OpenAI；描述带非官方声明', () => {
    const banned = /claude|anthropic|codex|openai/i;
    for (const s of [pkg.name, nls.displayName, pkg.icon, ...pkg.keywords]) assert.ok(!banned.test(s), `出现了第三方名称：${s}`);
    assert.ok(/Unofficial; not affiliated with Anthropic or OpenAI\./.test(nls.description));
    assert.ok(/session logs/.test(nls.description) && /Claude Code/.test(nls.description) && /Codex/.test(nls.description));
  });

  await test('每个 %key% 在 package.nls.json 里都有值，且没有多余的键', () => {
    const used = new Set();
    JSON.stringify(pkg).replace(/%([\w.-]+)%/g, (m, k) => used.add(k));
    const missing = [...used].filter((k) => typeof nls[k] !== 'string' || !nls[k].trim());
    assert.deepStrictEqual(missing, []);
    const unused = Object.keys(nls).filter((k) => !used.has(k));
    assert.deepStrictEqual(unused, []);
    // 命令标题、设置描述、视图名一律走 %key%
    for (const x of c.commands) assert.ok(/^%[\w.]+%$/.test(x.title) && /^%[\w.]+%$/.test(x.category), x.command);
    for (const [k, v] of Object.entries(c.configuration.properties)) {
      const d = v.description || v.markdownDescription;
      assert.ok(/^%[\w.]+%$/.test(d), `设置 ${k} 的描述没走 nls`);
    }
    // 译文文件（翻译阶段生成）：不能有英文里已经没有的键；英文新加、还没翻译的键 VS Code 会退回英文，这里只提示
    for (const loc of ['zh-cn', 'zh-tw', 'ko', 'ja']) {
      const f = path.join(ROOT, `package.nls.${loc}.json`);
      if (!fs.existsSync(f)) continue;
      const t = JSON.parse(fs.readFileSync(f, 'utf8'));
      const stale = Object.keys(t).filter((k) => !(k in nls));
      assert.deepStrictEqual(stale, [], `${loc} 有多余的键`);
      const pending = Object.keys(nls).filter((k) => !(k in t));
      if (pending.length) console.log(`        （package.nls.${loc}.json 还有 ${pending.length} 个键待翻译：${pending.join(', ')}）`);
      for (const [k, v] of Object.entries(t)) assert.ok(typeof v === 'string' && v.trim(), `${loc} ${k} 为空`);
    }
  });

  await test('视图与容器（§11.13）：底部面板只有一个 webview 视图（标题并进面板标签，像终端），侧边栏总览树', () => {
    for (const v of views.values()) assert.ok(containers.has(v.container), `容器 ${v.container} 未声明`);
    assert.deepStrictEqual(c.views.agentMonitor.map((v) => v.id), ['agentMonitor.agents'], '底部面板只留一个视图');
    assert.ok(!views.has('agentMonitor.sessions'), '会话原生树要删掉');
    assert.strictEqual(views.get('agentMonitor.agents').container, 'agentMonitor');
    assert.strictEqual(views.get('agentMonitor.agents').type, 'webview');
    // 只有一个视图时，面板标签显示 contextualTitle（容器名 Agent Monitor）
    assert.strictEqual(views.get('agentMonitor.agents').contextualTitle, '%container.title%');
    assert.ok(!c.viewsWelcome.some((w) => w.view === 'agentMonitor.sessions'));
    assert.strictEqual(views.get('agentMonitor.tree').container, 'agentMonitorSidebar');
    assert.ok(!views.has('agentMonitor.view'), '旧的表格视图要删掉');
    assert.ok(c.viewsContainers.panel.some((p) => p.id === 'agentMonitor'));
    for (const x of [...c.viewsContainers.activitybar, ...c.viewsContainers.panel, ...views.values()]) {
      if (x.icon) assert.ok(fs.existsSync(path.join(ROOT, x.icon)), `图标不存在 ${x.icon}`);
    }
  });

  await test('命令总表（§11.12.4）：命令与图标一致，没有 pin / unpin / conversation / pinned', () => {
    const want = {
      show: undefined, showTree: '$(list-tree)', refresh: '$(refresh)', openSettings: '$(gear)',
      'scope.all': '$(globe)', 'scope.workspace': '$(root-folder)', markSeen: '$(check)', markAllSeen: '$(check-all)',
      hideCompleted: '$(eye)', showCompleted: '$(eye-closed)', openTranscript: '$(go-to-file)',
      revealTranscript: '$(folder-opened)', copyTranscriptPath: '$(copy)', copyResume: '$(copy)',
      compact: '$(screen-normal)', handoff: '$(export)', setAutoCompact: '$(settings)', storage: '$(database)',
    };
    assert.deepStrictEqual([...commands].sort(), Object.keys(want).map((x) => 'agentMonitor.' + x).sort());
    for (const [id, icon] of Object.entries(want)) assert.strictEqual(c.commands.find((x) => x.command === 'agentMonitor.' + id).icon, icon, id);
    for (const x of c.commands) if (x.icon) assert.ok(/^\$\([a-z0-9-]+\)$/.test(x.icon), x.icon);
    // 用到的 codicon 在打包进来的 codicons 里都有
    const css = fs.readFileSync(path.join(ROOT, 'media', 'codicons', 'codicon.css'), 'utf8');
    for (const icon of Object.values(want).filter(Boolean)) assert.ok(css.includes('.codicon-' + icon.slice(2, -1) + ':'), icon);
  });

  await test('菜单（§11.12.4）：记录位置、交接笔记、自动压缩在总览树的会话右键；存储在底部面板标题栏 … 菜单', () => {
    const ctxMenu = c.menus['view/item/context'];
    const sessionMenu = (cmd) => ctxMenu.find((m) => m.command === cmd && !m.group.startsWith('inline'));
    for (const id of ['revealTranscript', 'copyTranscriptPath', 'handoff', 'setAutoCompact']) {
      const m = sessionMenu('agentMonitor.' + id);
      assert.ok(m, id + ' 不在右键菜单');
      assert.ok(m.when.includes('view == agentMonitor.tree') && m.when.includes('viewItem =~ /\\bsession\\b/'), id + ': ' + m.when);
      const re = /viewItem =~ \/(.+?)\//.exec(m.when);
      const rx = new RegExp(re[1].replace(/\\\\/g, '\\'));
      assert.ok(rx.test(fmt.sessionContextValue(fixtures()[1], 'doneSeen')), '会话节点能命中');
      assert.ok(!rx.test('agent') && !rx.test('mainAgent') && !rx.test('workflow') && !rx.test('group'), '智能体、工作流、组头不命中');
    }
    // 右键菜单的分组顺序：会话操作（压缩、交接、自动压缩、续跑、已看过）→ 打开（记录、显示、复制路径）
    const order = ctxMenu.filter((m) => !m.group.startsWith('inline')).map((m) => m.group + ' ' + m.command.replace('agentMonitor.', ''));
    assert.deepStrictEqual(order.filter((x) => x.startsWith('1_session')), [
      '1_session@1 compact', '1_session@2 handoff', '1_session@3 setAutoCompact', '1_session@4 copyResume', '1_session@5 markSeen']);
    assert.deepStrictEqual(order.filter((x) => x.startsWith('2_open')), ['2_open@1 openTranscript', '2_open@2 revealTranscript', '2_open@3 copyTranscriptPath']);
    // 存储：底部面板标题栏的 … 菜单（不在 navigation 组）
    const st = c.menus['view/title'].filter((m) => m.command === 'agentMonitor.storage');
    assert.strictEqual(st.length, 1);
    assert.strictEqual(st[0].when, 'view == agentMonitor.agents');
    assert.ok(!st[0].group.startsWith('navigation'), '要在 … 菜单里');
    assert.ok(!JSON.stringify(c.menus).includes('agentMonitor.sessions'), '菜单里不再引用会话原生树');
  });

  await test('底部面板标题栏（§11.13）：范围切换、隐藏已完成、全部标为已看、刷新在按钮上；存储、设置在 … 溢出菜单', () => {
    const items = c.menus['view/title'].filter((m) => /view == agentMonitor\.agents\b/.test(m.when));
    const nav = items.filter((m) => m.group.startsWith('navigation')).map((m) => `${m.group} ${m.command || m.submenu}`);
    assert.deepStrictEqual(nav, [
      'navigation@1 agentMonitor.scopeMenu.all', 'navigation@1 agentMonitor.scopeMenu.workspace',
      'navigation@2 agentMonitor.hideCompleted', 'navigation@2 agentMonitor.showCompleted',
      'navigation@3 agentMonitor.markAllSeen', 'navigation@4 agentMonitor.refresh',
    ]);
    const overflow = items.filter((m) => !m.group.startsWith('navigation')).map((m) => m.command);
    assert.deepStrictEqual(overflow, ['agentMonitor.storage', 'agentMonitor.openSettings']);
    // 两个范围子菜单互斥，按当前档显示图标
    const scope = items.filter((m) => m.submenu);
    assert.ok(scope[0].when.includes("config.agentMonitor.scope != 'workspace'") && scope[1].when.includes("config.agentMonitor.scope == 'workspace'"));
  });

  await test('webview 右键菜单（§11.13）：when = webviewId + webviewSection + compactable / resumable；按行上的 data-vscode-context 求值', () => {
    const menu = c.menus['webview/context'];
    assert.ok(Array.isArray(menu) && menu.length === 8);
    // 极简的 when 求值：只支持 && 连接的 key == 'v' / key / !key（这里用到的就这几种）
    const evalWhen = (when, ctx) => when.split('&&').map((x) => x.trim()).every((cl) => {
      let m = /^(\w+) == '([^']*)'$/.exec(cl);
      if (m) return ctx[m[1]] === m[2];
      m = /^!(\w+)$/.exec(cl);
      if (m) return !ctx[m[1]];
      assert.ok(/^\w+$/.test(cl), '不认识的写法：' + cl);
      return !!ctx[cl];
    });
    for (const m of menu) {
      assert.ok(m.when.startsWith("webviewId == 'agentMonitor.agents' && webviewSection == 'session'"), m.when);
      assert.ok(commands.has(m.command), m.command);
    }
    const shown = (ctx) => menu.filter((m) => evalWhen(m.when, { webviewId: 'agentMonitor.agents', ...ctx })).map((m) => m.command.replace('agentMonitor.', ''));
    const row = (flags) => JSON.parse(JSON.stringify({ webviewSection: 'session', sessionKey: 'claude:x', preventDefaultContextMenuItems: true, ...flags }));
    assert.deepStrictEqual(shown(row({ compactable: true, resumable: false })),
      ['compact', 'handoff', 'setAutoCompact', 'markSeen', 'openTranscript', 'revealTranscript', 'copyTranscriptPath']);
    assert.deepStrictEqual(shown(row({ compactable: false, resumable: true })),
      ['handoff', 'setAutoCompact', 'copyResume', 'markSeen', 'openTranscript', 'revealTranscript', 'copyTranscriptPath']);
    assert.deepStrictEqual(shown({}), [], '内容区（没有 webviewSection）不出会话菜单');
    assert.deepStrictEqual(menu.filter((m) => evalWhen(m.when, { webviewId: 'other.view', webviewSection: 'session', compactable: true })), [], '别的 webview 不出');
    // 分组顺序：会话操作 → 打开
    assert.deepStrictEqual(menu.map((m) => m.group), ['1_session@1', '1_session@2', '1_session@3', '1_session@4', '1_session@5', '2_open@1', '2_open@2', '2_open@3']);
  });

  await test('菜单：compact 在总览树右键（viewItem =~ /\\bcompactable\\b/）与 webview 右键（compactable）；只引用声明过的命令、视图、设置', () => {
    const tree = c.menus['view/item/context'].filter((m) => m.command === 'agentMonitor.compact');
    assert.ok(tree.some((m) => !m.group.startsWith('inline') && /view == agentMonitor\.tree/.test(m.when) && m.when.includes('viewItem =~ /\\bcompactable\\b/')));
    assert.ok(c.menus['webview/context'].some((m) => m.command === 'agentMonitor.compact' && / && compactable$/.test(m.when)));
    const contextValues = ['session', 'provider-claude', 'lamp-doneUnseen', 'resumable', 'compactable', 'agent', 'mainAgent', 'workflow'];
    for (const [menu, items] of Object.entries(c.menus)) {
      if (menu !== 'commandPalette' && !menu.startsWith('view/') && !menu.startsWith('webview/')) assert.ok(submenus.has(menu), `未声明的子菜单 ${menu}`);
      for (const it of items) {
        if (it.command) assert.ok(commands.has(it.command), `${menu} 引用了未声明的命令 ${it.command}`);
        if (it.submenu) assert.ok(submenus.has(it.submenu), `未声明的子菜单 ${it.submenu}`);
        const when = it.when || '';
        for (const m of when.matchAll(/\bview == ([\w.]+)/g)) assert.ok(views.has(m[1]), `未知视图 ${m[1]}`);
        for (const m of when.matchAll(/\bwebviewId == '([\w.]+)'/g)) assert.ok(views.has(m[1]) && views.get(m[1]).type === 'webview', `未知 webview ${m[1]}`);
        for (const m of when.matchAll(/\bconfig\.([\w.]+)/g)) assert.ok(settings.has(m[1]), `未知设置 ${m[1]}`);
        for (const m of when.matchAll(/viewItem =~ \/(.+?)\/(?:\s|$)/g)) {
          const re = new RegExp(m[1].replace(/\\\\/g, '\\'));
          assert.ok(contextValues.some((v) => re.test(v)), `viewItem 正则匹配不到任何 contextValue：${m[1]}`);
        }
        assert.ok(!/[^=!<>]=[^=~]/.test(when), `when 写成了单个 = ：${when}`);
      }
    }
    // format.js 产出的 contextValue 能被 compact 的 when 命中
    const re = /\bcompactable\b/;
    assert.ok(re.test(fmt.sessionContextValue(fixtures()[0], 'working')));
    assert.ok(!re.test(fmt.sessionContextValue(fixtures()[1], 'doneSeen')), '上下文 1.2 万不该给压缩按钮');
  });

  await test('命令面板（§11.12.4、§11.12.7a）：需要节点参数的隐藏；compact / handoff / setAutoCompact / storage 可用', () => {
    const hidden = c.menus.commandPalette.filter((x) => x.when === 'false').map((x) => x.command);
    assert.deepStrictEqual(hidden.sort(), ['openTranscript', 'revealTranscript', 'copyTranscriptPath', 'markSeen', 'copyResume'].map((x) => 'agentMonitor.' + x).sort());
    for (const id of ['compact', 'handoff', 'setAutoCompact', 'storage']) {
      assert.ok(!c.menus.commandPalette.some((x) => x.command === 'agentMonitor.' + id), id + ' 在命令面板里应该可见');
    }
  });

  await test('设置总表（§11.12.5）：和总表一致，没有 staleAsNeedsYou 残留', () => {
    assert.ok(!('agentMonitor.staleAsNeedsYou' in c.configuration.properties));
    assert.ok(!Object.keys(nls).some((k) => /staleAsNeedsYou/.test(k)));
    assert.ok(!/staleAsNeedsYou/.test(fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8')), 'extension.js 里还有 staleAsNeedsYou');
  });

  await test('设置清单（§8.6、§11.6、§11.8、决定 4）', () => {
    const want = {
      scope: ['string', 'all'], followActiveChat: ['boolean', true], hideCompleted: ['boolean', false],
      showStatusBar: ['boolean', true], statusBarBackground: ['boolean', true], showCost: ['boolean', true],
      refreshSeconds: ['number', 2], activeWindowMinutes: ['number', 30], staleMinutes: ['number', 5],
      approvalGuess: ['string', 'fastTools'], approvalGuessSeconds: ['number', 60],
      'claude.enabled': ['boolean', true], 'claude.projectsDir': ['string', ''], 'claude.cliPath': ['string', ''],
      'codex.enabled': ['boolean', true], 'codex.home': ['string', ''],
      compactConfirm: ['boolean', true], compactTemplate: ['string', ''],
      contextHintStart: ['number', 200000], contextHintAct: ['number', 500000],
      sessionListPosition: ['string', 'auto'],
      cacheReminder: ['boolean', true], cacheReminderMinutes: ['number', 8], cacheReminderMinContext: ['number', 150000],
      cacheReminderShortTtl: ['boolean', false], closeReminder: ['boolean', true], postCompactHint: ['boolean', true],
      onlyWorkspace: ['boolean', false],
    };
    const props = c.configuration.properties;
    assert.deepStrictEqual(Object.keys(props).map((k) => k.replace(/^agentMonitor\./, '')).sort(), Object.keys(want).sort());
    for (const [k, [type, dflt]] of Object.entries(want)) {
      const p = props['agentMonitor.' + k];
      assert.strictEqual(p.type, type, k);
      assert.deepStrictEqual(p.default, dflt, k);
    }
    assert.deepStrictEqual(props['agentMonitor.scope'].enum, ['all', 'workspace']);
    assert.deepStrictEqual(props['agentMonitor.approvalGuess'].enum, ['fastTools', 'allTools', 'off']);
    // §11.13：会话列表在哪边；auto 跟随终端标签列表
    assert.deepStrictEqual(props['agentMonitor.sessionListPosition'].enum, ['auto', 'left', 'right']);
    assert.strictEqual(props['agentMonitor.sessionListPosition'].enumDescriptions.length, 3);
    assert.ok(nls['config.sessionListPosition'].includes('#terminal.integrated.tabs.location#'), '说明里链到终端的设置');
    assert.ok(props['agentMonitor.onlyWorkspace'].deprecationMessage);
    // 指向程序 / 目录的设置只能在用户设置里改（防工作区设置换掉要执行的程序）
    for (const k of ['claude.cliPath', 'claude.projectsDir', 'codex.home']) assert.strictEqual(props['agentMonitor.' + k].scope, 'machine', k);
    // compact.js 的默认值与这里一致
    for (const [k, v] of Object.entries(realCompact.DEFAULTS)) assert.deepStrictEqual(props['agentMonitor.' + k].default, v, `compact 默认值不一致：${k}`);
  });

  await test('颜色贡献点（§3.5）与 status.LAMP_COLORS 一致，id 只有一个点', () => {
    const byId = new Map(c.colors.map((x) => [x.id, x]));
    assert.strictEqual(c.colors.length, 6);
    for (const lamp of S.LAMPS) {
      const id = S.LAMP_COLOR_ID[lamp];
      assert.ok(byId.has(id), `缺颜色 ${id}`);
      assert.deepStrictEqual(byId.get(id).defaults, { ...S.LAMP_COLORS[lamp] }, id);
      assert.strictEqual(id.split('.').length, 2);
    }
  });

  await test('viewsWelcome 指向存在的视图，链接的命令已声明，when 里的上下文键由扩展设置', () => {
    const known = new Set(['agentMonitor.loaded', 'agentMonitor.filteredOut', 'agentMonitor.noFolder']);
    for (const w of c.viewsWelcome) {
      assert.ok(views.has(w.view), `未知视图 ${w.view}`);
      for (const m of w.contents.matchAll(/\(command:([\w.]+)\)/g)) assert.ok(commands.has(m[1]), `未声明 ${m[1]}`);
      for (const m of w.when.matchAll(/agentMonitor\.\w+/g)) assert.ok(known.has(m[0]), `未知上下文键 ${m[0]}`);
      for (const k of known) assert.ok(k in log.contexts, `扩展没设置 ${k}`);
    }
  });

  await test('界面代码里没有中文硬编码（注释除外）', () => {
    for (const f of ['extension.js', 'lib/agents-view.js', 'lib/tree.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
      const hit = src.split('\n').find((l) => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(l));
      assert.ok(!hit, `${f} 里有中日韩文字：${hit}`);
    }
  });

  await test('新增的 views 词条不和 core 的前缀冲突；ext / tree 用到的键都在英文词典里', () => {
    const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'core.en.json'), 'utf8'));
    const views = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'views.en.json'), 'utf8'));
    for (const k of Object.keys(views)) assert.ok(!(k in core), `和 core 重复：${k}`);
    const used = new Set();
    for (const f of ['extension.js', 'lib/agents-view.js', 'lib/tree.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of src.matchAll(/\bt\('((?:ext|tree|bar|scope|tip|session|resume|cost|ctx|count|workflow)\.[\w.]*\w)'\s*[,)]/g)) used.add(m[1]);
    }
    for (const k of used) assert.ok(i18n.has(k), `词典里没有 ${k}`);
    assert.ok(used.size >= 10);
  });

  await test('.vscodeignore 把 test/ 排除出打包', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignore.includes('test/**'));
  });
}

(async () => {
  console.log('扩展入口');
  try {
    await extensionTests();
  } catch (err) {
    results.push(false);
    console.log('  FAIL  （扩展测试中断）', err && err.stack);
  }
  console.log('\npackage.json');
  await manifestTests();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
})();
