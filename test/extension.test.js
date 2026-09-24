'use strict';
// Tests for the extension entry point (extension.js) and package.json. Run with plain Node: node test/extension.test.js
// - Built-in vscode stub (including l10n, window.tabGroups, TabInputWebview, TabInputCustom, globalState, QuickPick) and a fake worker.
// - lib/agents-view.js and lib/compact.js are the real modules, wrapped only to record calls; no real dialogs are shown and the claude CLI is never called.
// - All data is synthetic; nothing is read from ~/.claude or ~/.codex. Temp files go under AGENT_MONITOR_TEST_TMP (or the system temp dir if unset) and are deleted afterwards.

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
// vscode stub
// ---------------------------------------------------------------------------

const log = {
  contexts: {}, executed: [], opened: [], updates: [], output: [], workers: [], progress: [],
  info: [], warn: [], error: [], clipboard: [], quickPicks: [], agentInputs: [], compactSnapshots: [],
  compactDeps: null, reveals: [], treeViews: {}, webviews: {}, statusItem: null,
  handoffs: [], autoDeps: null, storageOpens: [],
};
const config = {}; // setting name -> { globalValue, workspaceValue }
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

// position of the terminal tab list (terminal.integrated.tabs.location): kept in the same config table under the tabs.location key; the event carries the terminal setting name
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
    // test helpers: simulate a user click and visibility changes
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
      assert.ok(!registered.has(id), `command registered twice: ${id}`);
      registered.set(id, fn);
      return { dispose() { registered.delete(id); } };
    },
    // only records; does not call the registered handler (the compact command would open a QuickPick; tests call registered.get(id) directly)
    executeCommand: async (id, ...args) => {
      log.executed.push([id, ...args]);
      if (id === 'setContext') log.contexts[args[0]] = args[1];
    },
  },
};

// fake worker: tests send snapshots by hand and simulate crashes; after terminate it exits with 1, like the real one
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

// agents view and compaction: real modules wrapped to record calls
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
    // handoff notes only record the call (the real flow is tested in compact.test.js)
    api.runHandoff = async (arg) => { log.handoffs.push(arg); };
    return api;
  },
};
// auto-compact capacity: the real module (registers agentMonitor.setAutoCompact itself), wrapped to record the deps it receives
let realAuto = null;
try { realAuto = require(path.join(ROOT, 'lib', 'autocompact')); } catch { realAuto = null; }
const autoWrap = realAuto && {
  ...realAuto,
  activateAutoCompact(context, deps) {
    log.autoDeps = deps;
    return realAuto.activateAutoCompact(context, deps);
  },
};
// simulate a missing module: when set to {}, the extension should register placeholder commands
const modOverride = { autocompact: null, storage: null };
// storage page: only records the deps passed when it opens (the page itself is covered by the storage tests)
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
// Helpers
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
// synthetic data (Snapshot v2)
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

// four sessions: two "open" (alpha: Claude running; gamma: Codex maybe waiting for approval) and two "recent"
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
// Extension entry point
// ---------------------------------------------------------------------------

// simulate the bottom-panel page: resolve the real AgentsViewProvider onto a fake webview view, record messages sent to the page,
// and send ready / select / resizeList / more like the page does
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

  await test('activation: the bottom panel has a single webview (no native session tree) + the sidebar overview tree; the worker starts with the v2 config; context keys before loading', () => {
    assert.deepStrictEqual(Object.keys(log.treeViews), ['agentMonitor.tree'], 'bottom panel no longer registers a native tree');
    assert.strictEqual(tv.opts.showCollapseAll, true);
    assert.ok(log.webviews['agentMonitor.agents'], 'webview not registered');
    assert.ok(log.webviews['agentMonitor.agents'].provider instanceof RecordingAgentsView);
    assert.strictEqual(w0.file, path.join(ROOT, 'lib', 'worker.js'));
    const cfg = w0.opts.workerData;
    assert.deepStrictEqual(Object.keys(cfg).sort(), ['activeWindowMinutes', 'approvalGuess', 'approvalGuessSeconds', 'claude', 'codex', 'intervalMs', 'observedCompact', 'staleMinutes']);
    assert.deepStrictEqual(Object.keys(cfg.claude).sort(), ['configDir', 'configDirSource', 'enabled', 'home', 'projectsDir', 'settingsPath']);
    assert.deepStrictEqual(Object.keys(cfg.codex).sort(), ['enabled', 'home', 'homeSource']);
    assert.strictEqual(cfg.claude.home, path.dirname(cfg.claude.projectsDir));
    // CLAUDE_CONFIG_DIR wins, otherwise ~/.claude; the registry and settings.json both live under it
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
    // not loaded: content area shows "loading", the list is empty, position follows the terminal by default (right), width defaults to 200
    assert.strictEqual(last(log.agentInputs).loaded, false);
    const l = page.list();
    assert.ok(l, 'no list posted after ready');
    assert.deepStrictEqual([l.items.length, l.position, l.width, l.selectedKey], [0, 'right', 200, null]);
    assert.ok(/Content-Security-Policy/.test(page.view.webview.html));
  });

  await test('first activation focuses the bottom panel once (remembered in globalState); status bar click / show command focuses this webview', async () => {
    assert.ok(log.executed.some((x) => x[0] === 'agentMonitor.agents.focus'));
    assert.ok(globalState.get('agentMonitor.panelIntro.v1'));
    const n = log.executed.length;
    await registered.get('agentMonitor.show')();
    assert.deepStrictEqual(log.executed.slice(n), [['agentMonitor.agents.focus']]);
  });

  await test('registered commands match package.json one to one (including compact from compact.js and setAutoCompact from autocompact.js)', () => {
    const declared = pkg.contributes.commands.map((c) => c.command).sort();
    assert.deepStrictEqual([...registered.keys()].sort(), declared);
    for (const id of ['revealTranscript', 'copyTranscriptPath', 'handoff', 'setAutoCompact', 'storage']) {
      assert.ok(registered.has('agentMonitor.' + id), 'not registered: ' + id);
    }
  });

  await test('auto-compact module: activateAutoCompact receives getSession / getSessions / i18n / claudeHome / codexHome / output / getSelectedKey', () => {
    if (!realAuto) { console.log('        (lib/autocompact.js missing, skipped)'); return; }
    const d = log.autoDeps;
    assert.ok(d, 'activateAutoCompact was not called');
    for (const k of ['getSession', 'getSessions', 'getSelectedKey']) assert.strictEqual(typeof d[k], 'function', k);
    assert.strictEqual(typeof d.i18n.t, 'function');
    assert.strictEqual(typeof d.output.appendLine, 'function');
    assert.strictEqual(d.claudeHome, w0.opts.workerData.claude.configDir, 'claudeHome = Claude config dir (where settings.json is)');
    // codexHome must follow the agentMonitor.codex.home setting (without it the module only knows CODEX_HOME / ~/.codex)
    assert.strictEqual(d.codexHome, w0.opts.workerData.codex.home, 'codexHome = Codex dir (where config.toml is)');
  });

  await test('compact module: activateCompact receives getSession / i18n / claudeHome / output / getSelectedKey', () => {
    const d = log.compactDeps;
    assert.ok(d, 'activateCompact was not called');
    assert.strictEqual(typeof d.getSession, 'function');
    assert.strictEqual(typeof d.i18n.t, 'function');
    const home = typeof d.claudeHome === 'function' ? d.claudeHome() : d.claudeHome;
    assert.strictEqual(home, w0.opts.workerData.claude.configDir, 'registry lives under the Claude config dir');
    assert.strictEqual(typeof d.output.appendLine, 'function');
    assert.strictEqual(typeof d.getSelectedKey, 'function', 'called without arguments, the selected session comes first');
  });

  await test('first snapshot: the list has "open / recent" groups, each by start time descending; content area shows the first row and sends focus; selection is pushed to the page', async () => {
    send(fixtures());
    await tick();
    assert.strictEqual(log.contexts['agentMonitor.loaded'], true);
    const l = page.list();
    assert.deepStrictEqual(l.items.map((x) => x.id || x.key), ['g:open', GAMMA, ALPHA, 'g:recent', BETA, DELTA]);
    // nothing selected before and no current chat → select the first row and push it to the page
    assert.strictEqual(ctl.selectedKey, GAMMA);
    assert.strictEqual(agentsShown(), GAMMA);
    assert.strictEqual(l.selectedKey, GAMMA);
    assert.deepStrictEqual(last(focusMsgs()).keys, [GAMMA]);
    // the compaction reminder received the snapshot
    assert.strictEqual(log.compactSnapshots.length, 1);
    assert.strictEqual(log.compactDeps.getSession(ALPHA).title, 'Alpha chat');
  });

  await test('selection round trip: page sends select → content area switches, sends focus, marks as seen (Beta goes from unseen to seen), extension pushes the selection back to the page', async () => {
    assert.strictEqual(page.row(BETA).lamp, 'doneUnseen');
    page.select(BETA);
    await tick();
    assert.strictEqual(ctl.selectedKey, BETA);
    assert.strictEqual(agentsShown(), BETA);
    assert.deepStrictEqual(last(focusMsgs()).keys, [BETA]);
    assert.ok(globalState.get('agentMonitor.seen.v1')[BETA] > 0, 'not marked as seen');
    assert.strictEqual(page.list().selectedKey, BETA);
    assert.strictEqual(page.row(BETA).lamp, 'doneSeen');
    // the content area gets this session's lamp (seen)
    const input = last(log.agentInputs);
    assert.strictEqual(input.lamps.lamp, 'doneSeen');
    assert.strictEqual(input.loaded, true);
    // key not in the list: ignored
    page.select('claude:nope');
    await tick();
    assert.strictEqual(ctl.selectedKey, BETA);
  });

  await test('data refresh keeps the selection; the new snapshot carries the details of this session', async () => {
    const sessions = fixtures();
    sessions[0].updatedMs = Date.now(); // Alpha has activity
    send(sessions, { details: { [BETA]: { key: BETA, agents: { main: { timeline: [], result: null, files: [], errors: [] } } } } });
    await tick();
    assert.strictEqual(ctl.selectedKey, BETA);
    assert.strictEqual(agentsShown(), BETA);
    assert.strictEqual(page.list().selectedKey, BETA);
    assert.ok(last(log.agentInputs).detail, 'details not passed to the content area');
  });

  await test('follow: switching to a Claude tab → selects that session and pushes it to the page; focus events on the same tab do not move it again', async () => {
    tabState.active = { label: 'Alpha chat', input: new TabInputWebview('mainThreadWebview-claudeVSCodePanel') };
    for (const fn of listeners.tabs) fn({ opened: [], closed: [], changed: [tabState.active] });
    await tick();
    assert.strictEqual(ctl.selectedKey, ALPHA);
    assert.strictEqual(agentsShown(), ALPHA);
    assert.strictEqual(page.list().selectedKey, ALPHA);
    assert.deepStrictEqual(last(focusMsgs()).keys, [ALPHA]);
    // a selection made by following is not marked as seen right away (left to the 1.5-second dwell timer)
    assert.ok(!(globalState.get('agentMonitor.seen.v1') || {})[ALPHA]);
    // the user clicks back to Beta; window focus events on the same Claude tab do not take the selection back
    page.select(BETA);
    for (const fn of listeners.windowState) fn({ focused: true });
    await tick();
    assert.strictEqual(ctl.selectedKey, BETA);
    // neither does a data refresh
    send(fixtures());
    await tick();
    assert.strictEqual(ctl.selectedKey, BETA);
    assert.strictEqual(page.list().selectedKey, BETA);
  });

  await test('follow: switching to a code tab keeps the selection; switching to a Codex tab follows the id in the URI', async () => {
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

  await test('follow: no messages to the page while the panel is hidden (the panel is not forced open); the current selection is sent once visible again and the page is ready', async () => {
    page.setVisible(false);
    const before = page.posted.length;
    const focusCount = () => log.executed.filter((x) => x[0] === 'agentMonitor.agents.focus').length;
    const focus0 = focusCount();
    tabState.active = { label: 'Alpha chat', input: new TabInputWebview('mainThreadWebview-claudeVSCodePanel') };
    for (const fn of listeners.tabs) fn({});
    await tick();
    assert.strictEqual(ctl.selectedKey, ALPHA);
    assert.strictEqual(agentsShown(), ALPHA);
    assert.strictEqual(page.posted.length, before, 'should not post while hidden');
    assert.strictEqual(focusCount(), focus0, 'following does not focus (open) the panel');
    page.setVisible(true);
    page.ready();
    await tick();
    assert.strictEqual(page.list().selectedKey, ALPHA);
    assert.strictEqual(last(page.posted.filter((m) => m.type === 'render')).sessionKey, ALPHA);
  });

  await test('followActiveChat off: switching tabs does not move the selection', async () => {
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

  await test('status bar overall lamp: NeedsYou → magenta + warning background; text counts by urgency', () => {
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

  await test('status bar overall lamp: errors only → red + error background; no background when that setting is off; all done → green', async () => {
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

  await test('"seen" changes and badge: the badge sits on the bottom-panel webview view; markSeen({ sessionKey }) → lamp turns dim green, badge clears, status bar follows', async () => {
    const s = fixtures()[1];
    s.doneAtMs = Date.now() + 1000; // later than the click just now: there is a new result
    s.main.status = st('done', s.doneAtMs);
    send([s]);
    await tick();
    assert.strictEqual(page.row(BETA).lamp, 'doneUnseen');
    assert.deepStrictEqual(page.view.badge && page.view.badge.value, 1);
    assert.ok(page.view.badge.tooltip.includes(i18n.t('badge.doneUnseen', { n: 1 })));
    assert.strictEqual(tv.badge.value, 1);
    // argument shape passed by the webview context menu
    await registered.get('agentMonitor.markSeen')({ webviewSection: 'session', sessionKey: BETA, compactable: false, resumable: true, webview: 'agentMonitor.agents' });
    // seenAtMs = now, 1 second before doneAtMs → still unseen; mark again with a later time (a string key works too)
    globalState.update('agentMonitor.seen.v1', { [BETA]: Date.now() + 5000 });
    await registered.get('agentMonitor.markSeen')(BETA);
    assert.strictEqual(page.row(BETA).lamp, 'doneSeen');
    assert.strictEqual(page.view.badge, undefined);
    assert.strictEqual(tv.badge, undefined);
    assert.strictEqual(log.statusItem.color.id, 'agentMonitor.lampDoneSeen');
  });

  await test('markAllSeen: everything in scope is marked as seen', async () => {
    const f = fixtures();
    send(f);
    await tick();
    await registered.get('agentMonitor.markAllSeen')();
    const seen = globalState.get('agentMonitor.seen.v1');
    for (const k of KEYS) assert.ok(seen[k] > 0, `not marked: ${k}`);
  });

  await test('list order is stable across 20 snapshots: alternating activity, lamps flipping, shuffled input; in list messages only the row whose lamp changed differs', async () => {
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
      // Alpha and Beta take turns being newest; Alpha switches between "tool / thinking" (both Working), Beta between "done / running" (lamp changes)
      f[0].updatedMs = i % 2 ? t : t - 60e3;
      f[1].updatedMs = i % 2 ? t - 60e3 : t;
      f[0].main.status = st(i % 2 ? 'thinking' : 'tool', t - 1000, { pendingTool: i % 2 ? null : 'Bash' });
      f[1].main.status = i % 2 ? st('thinking', t - 1000) : st('done', t - 1000);
      f[0].main.tokens = tokens(84000 + i * 10); // tokens grow but the percentage stays the same
      // shuffle the order in the snapshot
      const shuffled = i % 3 === 0 ? f.reverse() : i % 3 === 1 ? [f[2], f[0], f[3], f[1]] : f;
      send(shuffled);
      await tick();
      assert.deepStrictEqual(page.keys(), want, `order changed at snapshot ${i + 1}`);
      const cur = page.list();
      const before = new Map(prev.items.filter((x) => x.kind === 'session').map((r) => [r.key, vis(r)]));
      const changed = page.rows().filter((r) => before.get(r.key) !== vis(r)).map((r) => r.key);
      for (const k of changed) assert.strictEqual(k, BETA, `should not change: ${k}`);
      prev = cur;
    }
    assert.ok(page.lists().length > n0, 'the Beta lamp changes, so the list should be reposted');
  });

  await test('a new session appears at the top of its group; a session only moves when it goes from "recent" to "open"', async () => {
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

  await test('scope switch: workspace only → list, overview and status bar all follow the workspace; written to user settings; view description; empty state offers "show all sessions"', async () => {
    send(fixtures());
    await tick();
    page.select(BETA);
    await tick();
    assert.strictEqual(agentsShown(), BETA);
    await registered.get('agentMonitor.scope.workspace')();
    assert.deepStrictEqual(log.updates.pop(), ['scope', 'workspace', ConfigurationTarget.Global]);
    const keys = page.keys();
    assert.ok(!keys.includes(BETA), 'Beta is in another directory and should be filtered out');
    assert.deepStrictEqual([...keys].sort(), [ALPHA, GAMMA, DELTA].sort());
    assert.deepStrictEqual(overview.getChildren().map((n) => n.key).sort(), [ALPHA, GAMMA, DELTA].sort());
    assert.strictEqual(page.view.description, i18n.t('scope.workspace'));
    assert.ok(tv.description.includes(i18n.t('scope.workspace')));
    // the selected Beta is filtered out → select again by the rules: the content area switches to a session in scope and the page highlights the same one
    assert.ok(keys.includes(agentsShown()));
    assert.strictEqual(ctl.selectedKey, agentsShown());
    assert.strictEqual(page.list().selectedKey, agentsShown());
    // no sessions in the workspace → filteredOut; the content empty state offers "show all sessions", and clicking it on the page runs scope.all
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
    // scope set in the workspace → the button writes to the workspace layer
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

  await test('list position: auto follows the terminal tab list (terminal.integrated.tabs.location) and changes are pushed to the page at once; a left / right setting takes precedence', async () => {
    assert.strictEqual(page.list().position, 'right', 'terminal defaults to the right');
    setTerminalTabs('left');
    await tick();
    assert.strictEqual(page.list().position, 'left');
    setConfig('sessionListPosition', 'right');
    await tick();
    assert.strictEqual(page.list().position, 'right', 'setting takes precedence');
    setConfig('sessionListPosition', 'auto');
    await tick();
    assert.strictEqual(page.list().position, 'left');
    setTerminalTabs('right');
    await tick();
    assert.strictEqual(page.list().position, 'right');
    // another terminal setting changed: not reposted
    const n = page.posted.length;
    for (const fn of [...listeners.config]) fn({ affectsConfiguration: (x) => x === 'terminal.integrated.fontSize' || x === 'terminal.integrated' });
    await tick();
    assert.strictEqual(page.posted.length, n);
  });

  await test('list width: the page sends resizeList after dragging → snapped, stored in globalState and pushed back to the page; the same width is not written twice; kept after reactivation', async () => {
    const writes = [];
    const orig = globalState.update;
    globalState.update = (k, v) => { if (k === 'agentMonitor.sessionListWidth') writes.push(v); return orig(k, v); };
    page.msg({ type: 'resizeList', width: 263.6 });
    await tick();
    assert.deepStrictEqual(writes, [264]);
    assert.strictEqual(page.list().width, 264);
    page.msg({ type: 'resizeList', width: 264 });
    await tick();
    assert.deepStrictEqual(writes, [264], 'unchanged: not written');
    // dragged below the midpoint: snaps to the narrow strip
    page.msg({ type: 'resizeList', width: 50 });
    await tick();
    assert.deepStrictEqual(writes, [264, 46]);
    assert.strictEqual(page.list().width, 46);
    // double-click resets (the page sends the default width)
    page.msg({ type: 'resizeList', width: 200 });
    await tick();
    assert.strictEqual(globalState.get('agentMonitor.sessionListWidth'), 200);
    // the width the page remembers (webview state) is reported on ready: the page wins
    page.ready({ listWidth: 240 });
    await tick();
    assert.strictEqual(globalState.get('agentMonitor.sessionListWidth'), 240);
    assert.strictEqual(page.list().width, 240);
    page.msg({ type: 'resizeList', width: 'wide' });
    await tick();
    assert.strictEqual(globalState.get('agentMonitor.sessionListWidth'), 240, 'non-numbers are ignored');
    globalState.update = orig;
  });

  await test('row-end "…": opens a QuickPick with the same items as the context menu (titles from package.nls, filtered by compactable / resumable) and runs the pick with { sessionKey }', async () => {
    send(fixtures());
    await tick();
    const titleOf = (id) => nls[pkg.contributes.commands.find((c) => c.command === id).title.slice(1, -1)];
    let items = null;
    quickPickAnswer = (it) => { items = it; return it.find((x) => x.command === 'agentMonitor.copyTranscriptPath'); };
    page.msg({ type: 'more', sessionKey: ALPHA });
    await tick();
    await tick();
    const cmds = items.filter((x) => x.command).map((x) => x.command.replace('agentMonitor.', ''));
    // Alpha: 84K context (compactable), no resume hint
    assert.deepStrictEqual(cmds, ['compact', 'handoff', 'setAutoCompact', 'markSeen', 'openTranscript', 'revealTranscript', 'copyTranscriptPath']);
    assert.strictEqual(items.filter((x) => x.kind === vscode.QuickPickItemKind.Separator).length, 1, 'one separator between the two groups');
    const compact = items.find((x) => x.command === 'agentMonitor.compact');
    assert.strictEqual(compact.label, '$(screen-normal) ' + titleOf('agentMonitor.compact'));
    assert.strictEqual(last(log.quickPicks).o.placeHolder, 'Alpha chat');
    assert.deepStrictEqual(last(log.executed), ['agentMonitor.copyTranscriptPath', { webviewSection: 'session', sessionKey: ALPHA }]);
    // Beta: has a resume hint and under 20K context → copyResume but no compact; cancelling runs nothing
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

  await test('commands accept { sessionKey } from the webview context menu: compact and setAutoCompact go straight to that session (no session picker first)', async () => {
    const arg = { webviewSection: 'session', sessionKey: ALPHA, compactable: true, resumable: false, preventDefaultContextMenuItems: true, webview: 'agentMonitor.agents' };
    const errs = log.error.length;
    const qps = log.quickPicks.length;
    await registered.get('agentMonitor.compact')(arg);
    assert.strictEqual(log.error.length, errs);
    const qp = log.quickPicks[qps];
    assert.ok(qp && qp.qp && String(qp.qp.title).includes('Alpha chat'), 'compact options title includes the session name: ' + (qp && qp.qp && qp.qp.title));
    if (realAuto) {
      const n = log.quickPicks.length;
      await registered.get('agentMonitor.setAutoCompact')(arg);
      assert.strictEqual(log.error.length, errs);
      const q = log.quickPicks[n];
      assert.ok(q, 'no level picker shown');
      assert.ok(!(q.items || []).some((it) => it && typeof it.key === 'string' && it.key.includes(':')), 'should not show the session picker first');
    }
  });

  await test('hide completed: recomputed locally, not sent to the worker; the content area receives the setting', async () => {
    const sent = w0.messages.length;
    await registered.get('agentMonitor.hideCompleted')();
    assert.strictEqual(last(log.agentInputs).settings.hideCompleted, true);
    assert.strictEqual(tv.description, i18n.t('tree.hideCompleted'));
    const alpha = overview.getChildren().find((n) => n.key === ALPHA);
    assert.ok(!overview.getChildren(alpha).some((n) => n.id.endsWith('/a/sub2')), 'completed subagent not hidden');
    await registered.get('agentMonitor.showCompleted')();
    assert.strictEqual(last(log.agentInputs).settings.hideCompleted, false);
    assert.ok(overview.getChildren(overview.getChildren().find((n) => n.key === ALPHA)).some((n) => n.id.endsWith('/a/sub2')));
    assert.strictEqual(w0.messages.filter((m) => m.type === 'config').length, w0.messages.slice(0, sent).filter((m) => m.type === 'config').length);
  });

  await test('scan setting changes send config (v2 config); the refresh command sends refresh, and the progress bar (bottom panel) waits for the next snapshot', async () => {
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

  await test('content area: compact from the session bar only goes to the current session; compact at a list row end can target any session in the list', async () => {
    const shown = agentsShown();
    page.msg({ type: 'compact', sessionKey: shown });
    await tick();
    assert.deepStrictEqual(last(log.executed), ['agentMonitor.compact', shown]);
    const other = [ALPHA, BETA, GAMMA, DELTA].find((k) => k !== shown);
    page.msg({ type: 'compact', sessionKey: other });
    await tick();
    assert.deepStrictEqual(last(log.executed), ['agentMonitor.compact', other]);
    // not in the list: ignored
    const n = log.executed.length;
    page.msg({ type: 'compact', sessionKey: 'claude:not-listed' });
    await tick();
    assert.strictEqual(log.executed.length, n);
  });

  await test('resume: argument is { sessionKey }; a hint with one form is copied directly; several forms open a QuickPick and the text regenerated by the extension is copied', async () => {
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

  await test('open transcript: { sessionKey }, a string key or an overview tree node all work; only existing .jsonl files seen in a snapshot are opened', async () => {
    const open = registered.get('agentMonitor.openTranscript');
    await open({ webviewSection: 'session', sessionKey: ALPHA });
    assert.deepStrictEqual(log.opened.splice(0), [TRANSCRIPT]);
    await open(ALPHA);
    assert.deepStrictEqual(log.opened.splice(0), [TRANSCRIPT]);
    const alphaTree = overview.getChildren().find((n) => n.key === ALPHA);
    await open(overview.getChildren(alphaTree)[0]); // main agent
    assert.deepStrictEqual(log.opened.splice(0), [TRANSCRIPT]);
    await open({ kind: 'agent', data: { file: '/etc/passwd' } });
    await open({ kind: 'agent', data: { file: path.join(TMP, 'unknown.jsonl') } });
    await open({ sessionKey: 'claude:nope' });
    await open(undefined);
    assert.deepStrictEqual(log.opened, []);
    // in the snapshot but the file is gone: warn
    await open({ webviewSection: 'session', sessionKey: BETA });
    assert.strictEqual(last(log.warn), i18n.t('ext.transcriptMissing'));
  });

  await test('transcript location: revealTranscript shows the main transcript with revealFileInOS; copyTranscriptPath copies the path; only paths from the snapshot are used', async () => {
    send(fixtures());
    await tick();
    const reveal = registered.get('agentMonitor.revealTranscript');
    const copy = registered.get('agentMonitor.copyTranscriptPath');
    const n = log.executed.length;
    await reveal({ webviewSection: 'session', sessionKey: ALPHA });
    let x = log.executed.slice(n).find((e) => e[0] === 'revealFileInOS');
    assert.ok(x, 'revealFileInOS not executed');
    assert.strictEqual(x[1].fsPath, TRANSCRIPT);
    // an overview tree session node or a sessionKey string (sent by the content-area session bar) both work
    const alphaTree = overview.getChildren().find((node) => node.key === ALPHA);
    await copy(alphaTree);
    assert.strictEqual(last(log.clipboard), TRANSCRIPT);
    assert.strictEqual(last(log.info), i18n.t('ext.transcriptPathCopied'));
    await copy(ALPHA);
    assert.strictEqual(last(log.clipboard), TRANSCRIPT);
    await copy({ webviewSection: 'session', sessionKey: ALPHA });
    assert.strictEqual(last(log.clipboard), TRANSCRIPT);
    // use the transcript field when the provider supplies it
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
    // unknown session or forged path: do nothing
    const k = log.executed.length;
    const clips = log.clipboard.length;
    await reveal({ kind: 'session', key: 'claude:nope', transcript: '/etc/passwd' });
    await reveal({ sessionKey: 'claude:nope', file: '/etc/passwd' });
    await copy('claude:nope');
    await reveal({ file: '/etc/passwd' });
    assert.strictEqual(log.executed.length, k);
    assert.strictEqual(log.clipboard.length, clips);
    // file is gone: warn, do not execute
    await reveal(BETA);
    assert.strictEqual(last(log.warn), i18n.t('ext.transcriptMissing'));
    assert.strictEqual(log.executed.length, k);
  });

  await test('handoff: with an argument ({ sessionKey } or key) it goes straight to runHandoff in compact.js; from the Command Palette without one, a session is picked first (the selected one comes first)', async () => {
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
    assert.strictEqual(seenItems[0].key, BETA, 'selected session comes first');
    assert.ok(seenItems[0].description.includes(i18n.t('ext.pickSession.selected')));
    assert.deepStrictEqual(seenItems.map((it) => it.key).sort(), [...KEYS].sort());
    assert.deepStrictEqual(log.handoffs, [DELTA, seenItems[1].key]);
    // picker cancelled: not called
    quickPickAnswer = () => undefined;
    await handoff();
    assert.strictEqual(log.handoffs.length, 2);
    quickPickAnswer = null;
  });

  await test('storage: the command opens the storage page; requestStorage sends { type: storage, force } to the worker, and the returned report goes to the page without type', async () => {
    await registered.get('agentMonitor.storage')();
    const deps = last(log.storageOpens);
    assert.ok(deps, 'openStorageView was not called');
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
    assert.deepStrictEqual(await p1, report, 'report has no type');
    assert.deepStrictEqual(await p2, report, 'concurrent pending requests resolve together');
    // worker gone while requests are pending: the next request starts a new worker, which sends the pending requests in one go
    const p3 = deps.requestStorage(false);
    ctl.stopWorker();
    const p4 = deps.requestStorage(false);
    const w2 = last(log.workers);
    assert.notStrictEqual(w2, w);
    assert.strictEqual(w2.messages.filter((m) => m.type === 'storage').length, 1, 'new worker receives one storage request');
    w2.emit('message', { type: 'storage', ...report, at: 2 });
    assert.strictEqual((await p3).at, 2);
    assert.strictEqual((await p4).at, 2);
    await tick();
    assert.strictEqual(last(log.workers), w2, 'a stopped old worker does not restart by itself');
    // open sessions (checked before migration): Claude uses the registry, Codex uses turns in progress
    send(fixtures());
    await tick();
    assert.deepStrictEqual(deps.liveSessions().map((x) => x.sessionId).sort(), [fixtures()[0].id, fixtures()[2].id].sort());
    assert.deepStrictEqual(Object.keys(deps.liveSessions()[0]).sort(), ['provider', 'sessionId', 'title']);
  });

  await test('observed compaction point: a new auto-compaction is written to globalState keyed by "model|window" and sent to the worker in config right away; old, manual and settings-overridden ones do not count', async () => {
    const w = last(log.workers);
    const f = fixtures();
    const t0 = Date.now() - 10 * MIN;
    f[1].contextWindow = 1000000;
    f[1].main.lastCompact = { ms: t0, trigger: 'auto', preTokens: 955123, postTokens: 30000, model: 'claude-opus-5-5' };
    f[3].main.lastCompact = { ms: t0 + 1000, trigger: 'manual', preTokens: 400000, postTokens: 20000, model: 'claude-opus-5-5' }; // manual: ignored
    f[2].main.lastCompact = { ms: t0 + 2000, trigger: 'auto', preTokens: 200000, postTokens: 20000, model: 'gpt-5.5' };        // Codex: ignored
    const sent = w.messages.length;
    send(f);
    await tick();
    assert.deepStrictEqual(globalState.get('agentMonitor.observedCompact'), { 'claude-opus-5-5|1000000': 955123 });
    const cfgs = w.messages.slice(sent).filter((m) => m.type === 'config');
    assert.strictEqual(cfgs.length, 1);
    assert.deepStrictEqual(cfgs[0].cfg.observedCompact, { 'claude-opus-5-5|1000000': 955123 });
    // same snapshot again: no config sent and no globalState write (a snapshot arrives every 2 seconds, so do not write every time)
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
    assert.strictEqual(writes, 0, 'no globalState write without a new observation');
    // an earlier one (another session) does not overwrite; sessions whose compaction point comes from settings are not learned from
    const g = fixtures();
    g[1].contextWindow = 1000000;
    g[1].main.lastCompact = { ms: t0 - HOUR, trigger: 'auto', preTokens: 900000, model: 'claude-opus-5-5' };
    g[3].contextWindow = 1000000;
    g[3].compactAtSource = 'settings-user';
    g[3].main.lastCompact = { ms: t0 + HOUR, trigger: 'auto', preTokens: 367000, model: 'claude-opus-5-5' };
    send(g);
    await tick();
    assert.deepStrictEqual(globalState.get('agentMonitor.observedCompact'), { 'claude-opus-5-5|1000000': 955123 });
    // a later one overwrites; a different window is recorded separately
    const h = fixtures();
    h[1].contextWindow = 1000000;
    h[1].main.lastCompact = { ms: t0 + 5 * MIN, trigger: 'auto', preTokens: 961000, model: 'claude-opus-5-5' };
    h[3].main.lastCompact = { ms: t0 + 5 * MIN, trigger: 'auto', preTokens: 166500, model: 'claude-opus-4-8' };
    h[3].contextWindow = 200000; // the session-level window takes precedence over the 1M in the main agent tokens
    const sent3 = w.messages.length;
    send(h);
    await tick();
    const want = { 'claude-opus-5-5|1000000': 961000, 'claude-opus-4-8|200000': 166500 };
    assert.deepStrictEqual(globalState.get('agentMonitor.observedCompact'), want);
    assert.deepStrictEqual(last(w.messages.slice(sent3).filter((m) => m.type === 'config')).cfg.observedCompact, want);
    assert.ok(log.output.some((l) => l.includes('claude-opus-4-8')), 'one line logged to the output panel');
    // later config messages from other setting changes carry it too
    setConfig('staleMinutes', 6);
    assert.deepStrictEqual(last(w.messages).cfg.observedCompact, want);
    setConfig('staleMinutes', 5);
    // pure function
    const { observedCompactsOf } = ext._internal;
    assert.strictEqual(observedCompactsOf([{ provider: 'claude', main: { model: 'm', lastCompact: { ms: 1, trigger: 'auto', preTokens: 0 }, tokens: { contextWindow: 1 } } }]).size, 0, 'preTokens of 0 is not learned');
    assert.strictEqual(observedCompactsOf([{ provider: 'claude', compactAtSource: 'disabled', main: { model: 'm', lastCompact: { ms: 1, trigger: 'auto', preTokens: 5 }, tokens: { contextWindow: 9 } } }]).size, 0);
    assert.strictEqual(observedCompactsOf(null).size, 0);
    // model and window at compaction time come from lastCompact (the provider computes contextWindow for that model); keys have the same shape as observedKey in core/context.js
    const switched = observedCompactsOf([{ provider: 'claude', contextWindow: 1000000,
      main: { model: 'claude-opus-5-5', tokens: { contextWindow: 1000000 }, lastCompact: { ms: 5, trigger: 'auto', preTokens: 166000, model: 'claude-opus-4-8', contextWindow: 200000 } } }]);
    const { observedKey } = require(path.join(ROOT, 'lib', 'core', 'context'));
    assert.deepStrictEqual([...switched.keys()], [observedKey('claude-opus-4-8', 200000)]);
  });

  await test('settings no longer include staleAsNeedsYou; the agents view receives only these settings', () => {
    const settings = last(log.agentInputs).settings;
    assert.deepStrictEqual(Object.keys(settings).sort(), ['contextHintAct', 'contextHintStart', 'hideCompleted', 'showCost']);
  });

  await test('a crashed worker restarts automatically up to 3 times; focus is resent after restart; a later refresh can start another', async () => {
    let w = log.workers[log.workers.length - 1];
    for (let i = 0; i < 3; i++) {
      const count = log.workers.length;
      w.emit('exit', 1);
      assert.strictEqual(log.workers.length, count + 1, `no restart after crash ${i + 1}`);
      w = last(log.workers);
      assert.ok(w.messages.some((m) => m.type === 'focus'), 'new worker did not receive focus');
    }
    const count = log.workers.length;
    w.emit('exit', 1);
    assert.strictEqual(log.workers.length, count, 'still restarting after 3 times');
    const done = registered.get('agentMonitor.refresh')();
    assert.strictEqual(log.workers.length, count + 1, 'refresh did not restart the dead worker');
    last(log.workers).emit('message', snapshot(fixtures()));
    await done;
  });

  await test('deactivation: the worker is terminated and the following exit does not trigger a restart; no errors in the output panel', async () => {
    const w = last(log.workers);
    const count = log.workers.length;
    for (const d of context.subscriptions) d.dispose();
    assert.strictEqual(w.terminated, true);
    await tick();
    await tick();
    assert.strictEqual(log.workers.length, count);
    ext.deactivate();
    // only two kinds of info lines are allowed: worker restarts and "recorded an observed compaction point"
    const bad = log.output.filter((l) => !/Background reader stopped|Measured auto-compact point/.test(l));
    assert.deepStrictEqual(bad, [], bad.join('\n'));
  });

  await test('reactivation: the bottom panel is not focused again; the legacy onlyWorkspace=true setting migrates to scope=workspace; observed compaction points go from globalState to the worker; placeholder commands when modules are missing', () => {
    for (const k of Object.keys(config)) delete config[k];
    config.onlyWorkspace = { globalValue: true };
    registered.clear();
    const executed = log.executed.length;
    const context2 = { subscriptions: [], extensionPath: ROOT, extensionUri: Uri.file(ROOT), globalState, workspaceState: memento() };
    // this time the auto-compact and storage modules fail to load: commands are still registered and explain the problem when run
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
    // list width is carried from globalState into the new controller
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

  await test('background thread has memory limits: small young generation, old generation only as a safety net', () => {
    const src = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
    const m = src.match(/const WORKER_LIMITS = Object\.freeze\(\{ maxYoungGenerationSizeMb: (\d+), maxOldGenerationSizeMb: (\d+) \}\);/);
    assert.ok(m, 'WORKER_LIMITS exists');
    assert.ok(Number(m[1]) <= 8 && Number(m[2]) >= 256, m[0]);
    assert.ok(/new Worker\(.*resourceLimits: WORKER_LIMITS \}\);/.test(src), 'passed when starting the worker');
  });

  await test('publishing fields: name, version, preview, license, publisher, repository, icon, categories', () => {
    assert.strictEqual(pkg.name, 'cyuneo-agent-monitor');
    assert.strictEqual(pkg.version, '0.3.1');
    assert.strictEqual(pkg.preview, true);
    assert.strictEqual(pkg.publisher, 'cyuneo');
    assert.strictEqual(pkg.license, 'PolyForm-Noncommercial-1.0.0');
    assert.strictEqual(pkg.displayName, '%displayName%');
    assert.strictEqual(nls.displayName, 'CYUNEO Agent Monitor');
    assert.strictEqual(pkg.description, '%description%');
    assert.ok(!('private' in pkg), 'private must be removed');
    assert.deepStrictEqual(pkg.author, { name: 'Chenyu Guo', url: 'https://github.com/cyuneo' });
    assert.strictEqual(pkg.repository.url, 'https://github.com/cyuneo/cyuneo-agent-monitor.git');
    assert.strictEqual(pkg.bugs.url, 'https://github.com/cyuneo/cyuneo-agent-monitor/issues');
    assert.ok(pkg.homepage.startsWith('https://github.com/cyuneo/cyuneo-agent-monitor'));
    assert.ok(pkg.qna);
    // categories include the official Marketplace category AI
    assert.deepStrictEqual(pkg.categories, ['AI', 'Visualization', 'Other']);
    assert.ok(/\.png$/.test(pkg.icon), 'extension icon must be a PNG');
    if (!fs.existsSync(path.join(ROOT, pkg.icon))) console.log(`        (${pkg.icon} not generated yet; it comes with the release assets)`);
    assert.deepStrictEqual(pkg.galleryBanner, { color: '#080808', theme: 'dark' });
    assert.ok(pkg.keywords.length > 0 && pkg.keywords.length <= 30);
    assert.ok(pkg.engines.vscode);
  });

  await test('name, keywords and icon path do not contain Claude / Anthropic / Codex / OpenAI; the description carries an unofficial disclaimer', () => {
    const banned = /claude|anthropic|codex|openai/i;
    for (const s of [pkg.name, nls.displayName, pkg.icon, ...pkg.keywords]) assert.ok(!banned.test(s), `third-party name found: ${s}`);
    assert.ok(/Unofficial; not affiliated with Anthropic or OpenAI\./.test(nls.description));
    assert.ok(/session logs/.test(nls.description) && /Claude Code/.test(nls.description) && /Codex/.test(nls.description));
  });

  await test('every %key% has a value in package.nls.json, with no extra keys', () => {
    const used = new Set();
    JSON.stringify(pkg).replace(/%([\w.-]+)%/g, (m, k) => used.add(k));
    const missing = [...used].filter((k) => typeof nls[k] !== 'string' || !nls[k].trim());
    assert.deepStrictEqual(missing, []);
    const unused = Object.keys(nls).filter((k) => !used.has(k));
    assert.deepStrictEqual(unused, []);
    // command titles, setting descriptions and view names all use %key%
    for (const x of c.commands) assert.ok(/^%[\w.]+%$/.test(x.title) && /^%[\w.]+%$/.test(x.category), x.command);
    for (const [k, v] of Object.entries(c.configuration.properties)) {
      const d = v.description || v.markdownDescription;
      assert.ok(/^%[\w.]+%$/.test(d), `description of setting ${k} does not use nls`);
    }
    // translation files: must not contain keys that English no longer has; new English keys not yet translated fall back to English in VS Code, so they are only reported here
    for (const loc of ['zh-cn', 'zh-tw', 'ko', 'ja']) {
      const f = path.join(ROOT, `package.nls.${loc}.json`);
      if (!fs.existsSync(f)) continue;
      const t = JSON.parse(fs.readFileSync(f, 'utf8'));
      const stale = Object.keys(t).filter((k) => !(k in nls));
      assert.deepStrictEqual(stale, [], `${loc} has extra keys`);
      const pending = Object.keys(nls).filter((k) => !(k in t));
      if (pending.length) console.log(`        (package.nls.${loc}.json has ${pending.length} untranslated keys: ${pending.join(', ')})`);
      for (const [k, v] of Object.entries(t)) assert.ok(typeof v === 'string' && v.trim(), `${loc} ${k} is empty`);
    }
  });

  await test('views and containers: the bottom panel has a single webview view (title merged into the panel tab, like the terminal), plus the sidebar overview tree', () => {
    for (const v of views.values()) assert.ok(containers.has(v.container), `container ${v.container} not declared`);
    assert.deepStrictEqual(c.views.agentMonitor.map((v) => v.id), ['agentMonitor.agents'], 'bottom panel keeps a single view');
    assert.ok(!views.has('agentMonitor.sessions'), 'native session tree must be removed');
    assert.strictEqual(views.get('agentMonitor.agents').container, 'agentMonitor');
    assert.strictEqual(views.get('agentMonitor.agents').type, 'webview');
    // with a single view, the panel tab shows contextualTitle (container name Agent Monitor)
    assert.strictEqual(views.get('agentMonitor.agents').contextualTitle, '%container.title%');
    assert.ok(!c.viewsWelcome.some((w) => w.view === 'agentMonitor.sessions'));
    assert.strictEqual(views.get('agentMonitor.tree').container, 'agentMonitorSidebar');
    assert.ok(!views.has('agentMonitor.view'), 'old table view must be removed');
    assert.ok(c.viewsContainers.panel.some((p) => p.id === 'agentMonitor'));
    for (const x of [...c.viewsContainers.activitybar, ...c.viewsContainers.panel, ...views.values()]) {
      if (x.icon) assert.ok(fs.existsSync(path.join(ROOT, x.icon)), `icon missing: ${x.icon}`);
    }
  });

  await test('command table: commands and icons match; no pin / unpin / conversation / pinned', () => {
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
    // every codicon used exists in the bundled codicons
    const css = fs.readFileSync(path.join(ROOT, 'media', 'codicons', 'codicon.css'), 'utf8');
    for (const icon of Object.values(want).filter(Boolean)) assert.ok(css.includes('.codicon-' + icon.slice(2, -1) + ':'), icon);
  });

  await test('menus: transcript location, handoff notes and auto-compact are in the overview tree session context menu; storage is in the … menu of the bottom panel title bar', () => {
    const ctxMenu = c.menus['view/item/context'];
    const sessionMenu = (cmd) => ctxMenu.find((m) => m.command === cmd && !m.group.startsWith('inline'));
    for (const id of ['revealTranscript', 'copyTranscriptPath', 'handoff', 'setAutoCompact']) {
      const m = sessionMenu('agentMonitor.' + id);
      assert.ok(m, id + ' is not in the context menu');
      assert.ok(m.when.includes('view == agentMonitor.tree') && m.when.includes('viewItem =~ /\\bsession\\b/'), id + ': ' + m.when);
      const re = /viewItem =~ \/(.+?)\//.exec(m.when);
      const rx = new RegExp(re[1].replace(/\\\\/g, '\\'));
      assert.ok(rx.test(fmt.sessionContextValue(fixtures()[1], 'doneSeen')), 'session node matches');
      assert.ok(!rx.test('agent') && !rx.test('mainAgent') && !rx.test('workflow') && !rx.test('group'), 'agent, workflow and group header nodes do not match');
    }
    // context menu group order: session actions (compact, handoff, auto-compact, resume, seen) → open (transcript, reveal, copy path)
    const order = ctxMenu.filter((m) => !m.group.startsWith('inline')).map((m) => m.group + ' ' + m.command.replace('agentMonitor.', ''));
    assert.deepStrictEqual(order.filter((x) => x.startsWith('1_session')), [
      '1_session@1 compact', '1_session@2 handoff', '1_session@3 setAutoCompact', '1_session@4 copyResume', '1_session@5 markSeen']);
    assert.deepStrictEqual(order.filter((x) => x.startsWith('2_open')), ['2_open@1 openTranscript', '2_open@2 revealTranscript', '2_open@3 copyTranscriptPath']);
    // storage: the … menu in the bottom panel title bar (not in the navigation group)
    const st = c.menus['view/title'].filter((m) => m.command === 'agentMonitor.storage');
    assert.strictEqual(st.length, 1);
    assert.strictEqual(st[0].when, 'view == agentMonitor.agents');
    assert.ok(!st[0].group.startsWith('navigation'), 'must be in the … menu');
    assert.ok(!JSON.stringify(c.menus).includes('agentMonitor.sessions'), 'menus no longer reference the native session tree');
  });

  await test('bottom panel title bar: scope switch, hide completed, mark all seen and refresh are buttons; storage and settings are in the … overflow menu', () => {
    const items = c.menus['view/title'].filter((m) => /view == agentMonitor\.agents\b/.test(m.when));
    const nav = items.filter((m) => m.group.startsWith('navigation')).map((m) => `${m.group} ${m.command || m.submenu}`);
    assert.deepStrictEqual(nav, [
      'navigation@1 agentMonitor.scopeMenu.all', 'navigation@1 agentMonitor.scopeMenu.workspace',
      'navigation@2 agentMonitor.hideCompleted', 'navigation@2 agentMonitor.showCompleted',
      'navigation@3 agentMonitor.markAllSeen', 'navigation@4 agentMonitor.refresh',
    ]);
    const overflow = items.filter((m) => !m.group.startsWith('navigation')).map((m) => m.command);
    assert.deepStrictEqual(overflow, ['agentMonitor.storage', 'agentMonitor.openSettings']);
    // the two scope submenus are mutually exclusive; the icon reflects the current scope
    const scope = items.filter((m) => m.submenu);
    assert.ok(scope[0].when.includes("config.agentMonitor.scope != 'workspace'") && scope[1].when.includes("config.agentMonitor.scope == 'workspace'"));
  });

  await test('webview context menu: when = webviewId + webviewSection + compactable / resumable; evaluated against the data-vscode-context of the row', () => {
    const menu = c.menus['webview/context'];
    assert.ok(Array.isArray(menu) && menu.length === 8);
    // minimal when evaluator: only supports key == 'v' / key / !key joined by && (all that is used here)
    const evalWhen = (when, ctx) => when.split('&&').map((x) => x.trim()).every((cl) => {
      let m = /^(\w+) == '([^']*)'$/.exec(cl);
      if (m) return ctx[m[1]] === m[2];
      m = /^!(\w+)$/.exec(cl);
      if (m) return !ctx[m[1]];
      assert.ok(/^\w+$/.test(cl), 'unsupported clause: ' + cl);
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
    assert.deepStrictEqual(shown({}), [], 'no session menu in the content area (no webviewSection)');
    assert.deepStrictEqual(menu.filter((m) => evalWhen(m.when, { webviewId: 'other.view', webviewSection: 'session', compactable: true })), [], 'not shown in other webviews');
    // group order: session actions → open
    assert.deepStrictEqual(menu.map((m) => m.group), ['1_session@1', '1_session@2', '1_session@3', '1_session@4', '1_session@5', '2_open@1', '2_open@2', '2_open@3']);
  });

  await test('menus: compact is in the overview tree context menu (viewItem =~ /\\bcompactable\\b/) and the webview context menu (compactable); only declared commands, views and settings are referenced', () => {
    const tree = c.menus['view/item/context'].filter((m) => m.command === 'agentMonitor.compact');
    assert.ok(tree.some((m) => !m.group.startsWith('inline') && /view == agentMonitor\.tree/.test(m.when) && m.when.includes('viewItem =~ /\\bcompactable\\b/')));
    assert.ok(c.menus['webview/context'].some((m) => m.command === 'agentMonitor.compact' && / && compactable$/.test(m.when)));
    const contextValues = ['session', 'provider-claude', 'lamp-doneUnseen', 'resumable', 'compactable', 'agent', 'mainAgent', 'workflow'];
    for (const [menu, items] of Object.entries(c.menus)) {
      if (menu !== 'commandPalette' && !menu.startsWith('view/') && !menu.startsWith('webview/')) assert.ok(submenus.has(menu), `undeclared submenu ${menu}`);
      for (const it of items) {
        if (it.command) assert.ok(commands.has(it.command), `${menu} references undeclared command ${it.command}`);
        if (it.submenu) assert.ok(submenus.has(it.submenu), `undeclared submenu ${it.submenu}`);
        const when = it.when || '';
        for (const m of when.matchAll(/\bview == ([\w.]+)/g)) assert.ok(views.has(m[1]), `unknown view ${m[1]}`);
        for (const m of when.matchAll(/\bwebviewId == '([\w.]+)'/g)) assert.ok(views.has(m[1]) && views.get(m[1]).type === 'webview', `unknown webview ${m[1]}`);
        for (const m of when.matchAll(/\bconfig\.([\w.]+)/g)) assert.ok(settings.has(m[1]), `unknown setting ${m[1]}`);
        for (const m of when.matchAll(/viewItem =~ \/(.+?)\/(?:\s|$)/g)) {
          const re = new RegExp(m[1].replace(/\\\\/g, '\\'));
          assert.ok(contextValues.some((v) => re.test(v)), `viewItem regex matches no contextValue: ${m[1]}`);
        }
        assert.ok(!/[^=!<>]=[^=~]/.test(when), `when uses a single =: ${when}`);
      }
    }
    // the contextValue produced by format.js matches the compact when clause
    const re = /\bcompactable\b/;
    assert.ok(re.test(fmt.sessionContextValue(fixtures()[0], 'working')));
    assert.ok(!re.test(fmt.sessionContextValue(fixtures()[1], 'doneSeen')), '12K context should not get a compact button');
  });

  await test('Command Palette: commands that need a node argument are hidden; compact / handoff / setAutoCompact / storage are available', () => {
    const hidden = c.menus.commandPalette.filter((x) => x.when === 'false').map((x) => x.command);
    assert.deepStrictEqual(hidden.sort(), ['openTranscript', 'revealTranscript', 'copyTranscriptPath', 'markSeen', 'copyResume'].map((x) => 'agentMonitor.' + x).sort());
    for (const id of ['compact', 'handoff', 'setAutoCompact', 'storage']) {
      assert.ok(!c.menus.commandPalette.some((x) => x.command === 'agentMonitor.' + id), id + ' should be visible in the Command Palette');
    }
  });

  await test('settings table: matches the reference list, no leftover staleAsNeedsYou', () => {
    assert.ok(!('agentMonitor.staleAsNeedsYou' in c.configuration.properties));
    assert.ok(!Object.keys(nls).some((k) => /staleAsNeedsYou/.test(k)));
    assert.ok(!/staleAsNeedsYou/.test(fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8')), 'extension.js still mentions staleAsNeedsYou');
  });

  await test('settings: keys, types and defaults', () => {
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
    // which side the session list is on; auto follows the terminal tab list
    assert.deepStrictEqual(props['agentMonitor.sessionListPosition'].enum, ['auto', 'left', 'right']);
    assert.strictEqual(props['agentMonitor.sessionListPosition'].enumDescriptions.length, 3);
    assert.ok(nls['config.sessionListPosition'].includes('#terminal.integrated.tabs.location#'), 'description links to the terminal setting');
    assert.ok(props['agentMonitor.onlyWorkspace'].deprecationMessage);
    // settings that point to programs / directories can only be set in user settings (machine scope), so workspace settings cannot swap the program that gets executed
    for (const k of ['claude.cliPath', 'claude.projectsDir', 'codex.home']) assert.strictEqual(props['agentMonitor.' + k].scope, 'machine', k);
    // defaults in compact.js match these
    for (const [k, v] of Object.entries(realCompact.DEFAULTS)) assert.deepStrictEqual(props['agentMonitor.' + k].default, v, `compact default mismatch: ${k}`);
  });

  await test('color contributions match status.LAMP_COLORS, and ids contain a single dot', () => {
    const byId = new Map(c.colors.map((x) => [x.id, x]));
    assert.strictEqual(c.colors.length, 6);
    for (const lamp of S.LAMPS) {
      const id = S.LAMP_COLOR_ID[lamp];
      assert.ok(byId.has(id), `missing color ${id}`);
      assert.deepStrictEqual(byId.get(id).defaults, { ...S.LAMP_COLORS[lamp] }, id);
      assert.strictEqual(id.split('.').length, 2);
    }
  });

  await test('viewsWelcome points to existing views, linked commands are declared, and context keys in when are set by the extension', () => {
    const known = new Set(['agentMonitor.loaded', 'agentMonitor.filteredOut', 'agentMonitor.noFolder']);
    for (const w of c.viewsWelcome) {
      assert.ok(views.has(w.view), `unknown view ${w.view}`);
      for (const m of w.contents.matchAll(/\(command:([\w.]+)\)/g)) assert.ok(commands.has(m[1]), `undeclared ${m[1]}`);
      for (const m of w.when.matchAll(/agentMonitor\.\w+/g)) assert.ok(known.has(m[0]), `unknown context key ${m[0]}`);
      for (const k of known) assert.ok(k in log.contexts, `not set by the extension: ${k}`);
    }
  });

  await test('no hard-coded CJK text in UI code (comments excluded)', () => {
    for (const f of ['extension.js', 'lib/agents-view.js', 'lib/tree.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
      const hit = src.split('\n').find((l) => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(l));
      assert.ok(!hit, `${f} contains CJK text: ${hit}`);
    }
  });

  await test('views strings do not collide with core; keys used by ext / tree are all in the English dictionary', () => {
    const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'core.en.json'), 'utf8'));
    const views = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'views.en.json'), 'utf8'));
    for (const k of Object.keys(views)) assert.ok(!(k in core), `duplicate of core: ${k}`);
    const used = new Set();
    for (const f of ['extension.js', 'lib/agents-view.js', 'lib/tree.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of src.matchAll(/\bt\('((?:ext|tree|bar|scope|tip|session|resume|cost|ctx|count|workflow)\.[\w.]*\w)'\s*[,)]/g)) used.add(m[1]);
    }
    for (const k of used) assert.ok(i18n.has(k), `missing from the dictionary: ${k}`);
    assert.ok(used.size >= 10);
  });

  await test('.vscodeignore excludes test/ from the package', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignore.includes('test/**'));
  });
}

(async () => {
  console.log('Extension entry point');
  try {
    await extensionTests();
  } catch (err) {
    results.push(false);
    console.log('  FAIL  (extension tests aborted)', err && err.stack);
  }
  console.log('\npackage.json');
  await manifestTests();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
