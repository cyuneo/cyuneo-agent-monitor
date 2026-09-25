'use strict';
// Tests for the extension entry point (extension.js) and package.json. Run with plain Node: node test/extension.test.js
// - Built-in vscode stub (including l10n, window.tabGroups, TabInputWebview, TabInputCustom, globalState, QuickPick) and a fake worker.
// - lib/agents-view.js and lib/compact.js are the real modules, wrapped only to record calls; no real dialogs are shown and the claude CLI is never called.
// - lib/notify.js and lib/shared-scan.js are the real modules with injected timers / commands: no system notification is ever shown,
//   and other VS Code windows are simulated with extra shared-scan instances in a temp dir.
// - Remote push: lib/push-runtime.js is the real module with short delays and a movable clock; SecretStorage is an in-memory fake
//   and globalThis.fetch is a fake that only records requests, so nothing ever goes out on the network.
// - Sounds, quiet hours and threshold alerts: lib/alerts.js is the real module, but playSound runs a fake execFile that only
//   records the command, so no sound is ever played. The usage-history page (lib/history-view.js) only records how it is opened.
// - Go to Chat: lib/jump.js is the real module, but its process list, open-file holders, Claude live registry, Qwen pid,
//   window raising and osascript calls come from fakes (jumpFake), so no process is ever listed or run; terminals are fake
//   objects in window.terminals.
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
  handoffs: [], autoDeps: null, storageOpens: [], inputs: [], historyOpens: [], external: [],
};
const config = {}; // setting name -> { globalValue, workspaceValue }
const listeners = { config: [], folders: [], tabs: [], tabGroups: [], windowState: [], terminals: [] };
let quickPickAnswer = null; // (items) => item
let infoAnswer = null;      // (message, items) => item: the button picked on an information message
let warnAnswer = null;      // (message, items) => item: the button picked on a warning message
let inputAnswer = null;     // (options) => string|undefined: what the user types into an input box

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
  from: (c) => ({ scheme: c.scheme, authority: c.authority || '', path: c.path || '', fsPath: c.path || '', toString: () => `${c.scheme}://${c.authority || ''}${c.path || ''}` }),
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
    openExternal: async (u) => { log.external.push(String(u)); return true; },
  },
  // extensions other than this one are missing, except the ids tests put in extraExtensions
  extensions: { getExtension: (id) => (extraExtensions.has(id) ? { id, isActive: true } : undefined) },
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
    terminals: [], // fake integrated terminals: { name, processId: Promise<pid>, show() }
    onDidOpenTerminal: on(listeners.terminals),
    onDidCloseTerminal: on(listeners.terminals),
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
    showInformationMessage: async (m, ...items) => { log.info.push(m); return infoAnswer ? infoAnswer(m, items) : undefined; },
    showWarningMessage: async (m, ...items) => { log.warn.push(m); return warnAnswer ? warnAnswer(m, items) : undefined; },
    showErrorMessage: async (m) => { log.error.push(m); return undefined; },
    showQuickPick: async (items, o) => { log.quickPicks.push({ items, o }); return quickPickAnswer ? quickPickAnswer(items) : undefined; },
    showInputBox: async (o) => { log.inputs.push(o); return inputAnswer ? inputAnswer(o) : undefined; },
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
    // registered commands plus the ones other extensions would contribute (extraCommands)
    getCommands: async () => [...registered.keys(), ...extraCommands],
  },
};
const extraCommands = new Set();
const extraExtensions = new Set();

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
  // Like the real worker, a snapshot carries the config generation of the last config message (or of workerData)
  cfgGen() {
    const c = this.messages.filter((m) => m.type === 'config' && Number.isFinite(m.gen));
    return c.length ? last(c).gen : (this.opts.workerData.cfgGen || 0);
  }
  emit(ev, m, ...rest) {
    if (ev === 'message' && m && m.type === 'snapshot' && !('cfgGen' in m)) m = { ...m, cfgGen: this.cfgGen() };
    return super.emit(ev, m, ...rest);
  }
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
const modOverride = { autocompact: null, storage: null, history: null };
// storage page: only records the deps passed when it opens (the page itself is covered by the storage tests)
const storageWrap = {
  openStorageView(context, deps) { log.storageOpens.push(deps); return { reveal() {} }; },
};
// usage-history page: only records the deps passed when it opens (the page itself is covered by test/history.test.js)
const historyWrap = {
  openHistory(context, deps) { log.historyOpens.push(deps); return { reveal() {} }; },
};
// sounds: the real lib/alerts.js, but playSound gets a fake execFile that only records the command (nothing is ever
// played) and skips the 3 s gap between sounds (covered by test/alerts.test.js), so every sound the extension plays shows
const realAlerts = require(path.join(ROOT, 'lib', 'alerts'));
const sounds = { calls: [], opts: [] };
const alertsWrap = {
  ...realAlerts,
  playSound: (event, o) => {
    sounds.opts.push({ event, ...o });
    return realAlerts.playSound(event, {
      ...o,
      platform: 'darwin',
      debounce: false,
      execFile: (cmd, args, opts, cb) => {
        sounds.calls.push({ event, cmd, args });
        setImmediate(() => cb(null));
        return { on() {} };
      },
    });
  },
};

// Safety net: a sound or a system notification that reaches the real child_process.execFile is a test bug (counted, and
// the run fails at the end); every one must go through the fake execFile of alertsWrap / notifyWrap
const childProcess = require('child_process');
let realExecs = 0;
childProcess.execFile = () => { realExecs++; throw new Error('tests never run commands'); };

// "needs you" notifications: the real module with a short claim delay; system notifications go to a fake execFile that only
// records them; the claim folder every window shares is under TMP instead of the system temp dir
const realNotify = require(path.join(ROOT, 'lib', 'notify'));
const sysNotify = { platform: 'darwin', fail: false, calls: [] };
const notifyWrap = {
  ...realNotify,
  CLAIM_DELAY_MS: 20,
  sharedClaimDir: () => realNotify.sharedClaimDir({ base: TMP }),
  hasSystemNotifier: () => realNotify.hasSystemNotifier(sysNotify.platform),
  sendSystemNotification: (msg, o) => realNotify.sendSystemNotification(msg, {
    ...o,
    platform: sysNotify.platform,
    execFile: (cmd, args, opts, cb) => {
      sysNotify.calls.push({ cmd, args });
      setImmediate(() => cb(sysNotify.fail ? new Error('synthetic failure') : null));
      return { on() {} };
    },
  }),
};
// shared scan: the real module, without fs.watch or a settle delay; heartbeats run only when a test calls beat()
const realShared = require(path.join(ROOT, 'lib', 'shared-scan'));
const sharedLog = []; // { o, inst, beat() } per createSharedScan call from the extension
const sharedClock = { offset: 0 }; // moves the shared scan's clock ahead of Date.now (e.g. past a grace period)
function sharedOpts(rec) {
  return {
    watch: false, settleMs: 0, now: () => Date.now() + sharedClock.offset,
    setInterval: (fn) => { const h = { fn, unref() {} }; rec.beats.push(h); return h; },
    clearInterval: (h) => { const i = rec.beats.indexOf(h); if (i >= 0) rec.beats.splice(i, 1); },
  };
}
const sharedWrap = {
  ...realShared,
  createSharedScan(o) {
    const rec = { o, beats: [], beat: () => rec.beats.slice().forEach((h) => h.fn()) };
    rec.inst = realShared.createSharedScan({ ...o, ...sharedOpts(rec) });
    sharedLog.push(rec);
    return rec.inst;
  },
};
// another VS Code window in the same shared dir (a shared-scan instance driven by hand)
function peerWindow(dir, cfgKey, extra = {}) {
  const rec = { beats: [], snaps: [], roles: [], unions: [], refreshes: 0 };
  rec.inst = realShared.createSharedScan({
    dir, cfgKey, windowId: 'peer', ...sharedOpts(rec),
    onRole: (r) => rec.roles.push(r),
    onSnapshot: (snap) => rec.snaps.push(snap),
    onFocusUnion: (keys) => rec.unions.push(keys),
    onRefreshRequest: () => { rec.refreshes++; },
    ...extra,
  });
  rec.beat = () => rec.beats.slice().forEach((h) => h.fn());
  return rec;
}

// Go to Chat: the real lib/jump.js with a fake process list, Claude live registry and Qwen pid (tests fill jumpFake)
const realJump = require(path.join(ROOT, 'lib', 'jump'));
// platform is darwin everywhere, so the Terminal.app / iTerm2 path runs the same on every OS (osascript is jumpFake.osa)
const jumpFake = { procs: [], live: new Map(), holders: null, lists: 0, raised: 0, raise: true, osa: [], osaOut: 'ok', replyWaitMs: 40 };
const jumpWrap = {
  ...realJump,
  createJumper: (deps) => realJump.createJumper({
    ...deps,
    platform: 'darwin',
    listProcesses: async () => { jumpFake.lists++; return jumpFake.procs; },
    processCwds: async () => new Map(),
    fileHolders: async (file, pids) => (jumpFake.holders ? new Set(pids.filter((p) => jumpFake.holders.has(p))) : null),
    claudeLive: (id) => jumpFake.live.get(id) || null,
    qwenPid: () => null,
    raiseWindow: async () => { jumpFake.raised++; return jumpFake.raise; },
    execFile: (cmd, args, opts, cb) => {
      jumpFake.osa.push([cmd, ...args]);
      const out = jumpFake.osaOut;
      setImmediate(() => (out instanceof Error ? cb(out, '', out.message) : cb(null, out + '\n', '')));
    },
    replyWaitMs: jumpFake.replyWaitMs,
  }),
};
// A fake integrated terminal whose shell has this pid
function fakeTerminal(name, pid) {
  const t = { name, processId: Promise.resolve(pid), shown: 0, show() { t.shown++; }, dispose() {} };
  return t;
}
function openTerminal(t) {
  vscode.window.terminals.push(t);
  for (const fn of [...listeners.terminals]) fn(t);
}
// VS Code removes a closed terminal from window.terminals before it fires onDidCloseTerminal
function closeTerminal(t) {
  const i = vscode.window.terminals.indexOf(t);
  if (i >= 0) vscode.window.terminals.splice(i, 1);
  for (const fn of [...listeners.terminals]) fn(t);
}

// Remote push: the real runtime with short delays (needsYou waits 60 ms, the rescan 40 ms before that, the batch 10 ms) and a
// clock tests can move ahead (a usage limit's reset time is rounded up to the minute)
const realPushRt = require(path.join(ROOT, 'lib', 'push-runtime'));
const realPush = require(path.join(ROOT, 'lib', 'push'));
const pushClock = { offset: 0 };
const PUSH_TIMING = Object.freeze({ wait: () => 60, rescanLeadMs: 40, freshWaitMs: 1000, limiter: { coalesceMs: 10, perChannelMinMs: 0, perHourMax: 1000 } });
const pushNow = () => Date.now() + pushClock.offset;
const pushRtWrap = {
  ...realPushRt,
  createPushRuntime: (deps) => realPushRt.createPushRuntime({ ...deps, clock: pushNow, timing: PUSH_TIMING }),
};
// Network: every request lands here and is only recorded (a real request would be a test bug); tests set the answer
const net = { calls: [], answer: null };
globalThis.fetch = async (url, init) => {
  net.calls.push({ url: String(url), init });
  const a = net.answer ? await net.answer(String(url), init) : { status: 200, text: '' };
  if (a instanceof Error) throw a;
  return { status: a.status, text: async () => a.text || '' };
};
// SecretStorage: in memory
function fakeSecrets() {
  const data = new Map();
  return {
    data,
    get: async (k) => data.get(k),
    store: async (k, v) => { data.set(k, String(v)); },
    delete: async (k) => { data.delete(k); },
    onDidChange: () => ({ dispose() {} }),
  };
}

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
  if (fromExt && request === './lib/history-view') return modOverride.history || historyWrap;
  if (fromExt && request === './lib/alerts') return alertsWrap;
  if (fromExt && request === './lib/notify') return notifyWrap;
  if (fromExt && request === './lib/shared-scan') return sharedWrap;
  if (fromExt && request === './lib/push-runtime') return pushRtWrap;
  if (fromExt && request === './lib/jump') return jumpWrap;
  return origLoad.apply(this, arguments);
};

const S = require(path.join(ROOT, 'lib', 'core', 'status'));
const fmt = require(path.join(ROOT, 'lib', 'format'));
const { createI18n } = require(path.join(ROOT, 'lib', 'i18n'));
const { emptyQuotaSnapshot } = require(path.join(ROOT, 'lib', 'core', 'quota'));
const { emptyDailyTotals } = require(path.join(ROOT, 'lib', 'core', 'daily'));
const lampLib = require(path.join(ROOT, 'lib', 'lamp'));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    assert.deepStrictEqual(Object.keys(log.treeViews), ['agentMonitor.tree', 'agentMonitor.panelOverview'], 'only the sidebar tree and the hidden panel badge carrier (no native session tree)');
    assert.strictEqual(tv.opts.showCollapseAll, true);
    assert.ok(log.webviews['agentMonitor.agents'], 'webview not registered');
    assert.ok(log.webviews['agentMonitor.agents'].provider instanceof RecordingAgentsView);
    assert.strictEqual(w0.file, path.join(ROOT, 'lib', 'worker.js'));
    const cfg = w0.opts.workerData;
    assert.deepStrictEqual(Object.keys(cfg).sort(), ['activeWindowMinutes', 'approvalGuess', 'approvalGuessSeconds', 'cfgGen', 'claude', 'codex', 'copilot', 'gemini', 'historyCacheFile', 'intervalMs', 'observedCompact', 'paused', 'qwen', 'staleMinutes']);
    assert.strictEqual(cfg.historyCacheFile, path.join(TMP, 'usage-history.jsonl'), 'the usage-history cache lives in global storage');
    // windows share one scan by default: the worker starts paused and resumes once this window leads (the only window here)
    assert.strictEqual(cfg.paused, true);
    assert.strictEqual(sharedLog.length, 1);
    assert.strictEqual(sharedLog[0].o.dir, path.join(TMP, 'shared-scan'));
    assert.strictEqual(sharedLog[0].inst.role, 'leader');
    assert.ok(w0.messages.some((m) => m.type === 'resume'), 'leader did not resume its worker');
    assert.ok(!w0.messages.some((m) => m.type === 'interval'), 'a focused window must not slow down, not even briefly at start');
    assert.deepStrictEqual(Object.keys(cfg.claude).sort(), ['configDir', 'configDirSource', 'enabled', 'home', 'projectsDir', 'settingsPath']);
    assert.deepStrictEqual(Object.keys(cfg.codex).sort(), ['enabled', 'home', 'homeSource']);
    assert.deepStrictEqual(cfg.copilot, { enabled: true, userDir: null }, 'TMP is no …/User/globalStorage/<id> path: the provider keeps its default dirs');
    for (const k of ['gemini', 'qwen']) {
      assert.deepStrictEqual(Object.keys(cfg[k]).sort(), ['enabled', 'home', 'homeSource'], k);
      assert.strictEqual(cfg[k].enabled, true, k);
    }
    if (!process.env.GEMINI_CLI_HOME) assert.deepStrictEqual([cfg.gemini.home, cfg.gemini.homeSource], [path.join(os.homedir(), '.gemini'), 'default']);
    if (!process.env.QWEN_RUNTIME_DIR && !process.env.QWEN_HOME) assert.deepStrictEqual([cfg.qwen.home, cfg.qwen.homeSource], [path.join(os.homedir(), '.qwen'), 'default']);
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

  await test('"seen" changes and badge: the panel badge sits on the hidden panel tree (so the tab shows it before the panel is opened); markSeen({ sessionKey }) → lamp turns dim green, badge clears, status bar follows', async () => {
    const s = fixtures()[1];
    s.doneAtMs = Date.now() + 1000; // later than the click just now: there is a new result
    s.main.status = st('done', s.doneAtMs);
    send([s]);
    await tick();
    assert.strictEqual(page.row(BETA).lamp, 'doneUnseen');
    const ptv = log.treeViews['agentMonitor.panelOverview'];
    assert.deepStrictEqual(ptv.badge && ptv.badge.value, 1);
    assert.ok(ptv.badge.tooltip.includes(i18n.t('badge.doneUnseen', { n: 1 })));
    assert.strictEqual(ptv.opts.treeDataProvider, tv.opts.treeDataProvider, 'panel tree shares the overview provider');
    assert.strictEqual(page.view.badge, undefined, 'no second badge on the webview view');
    assert.strictEqual(tv.badge.value, 1);
    // argument shape passed by the webview context menu
    await registered.get('agentMonitor.markSeen')({ webviewSection: 'session', sessionKey: BETA, compactable: false, resumable: true, webview: 'agentMonitor.agents' });
    // seenAtMs = now, 1 second before doneAtMs → still unseen; mark again with a later time (a string key works too)
    globalState.update('agentMonitor.seen.v1', { [BETA]: Date.now() + 5000 });
    await registered.get('agentMonitor.markSeen')(BETA);
    assert.strictEqual(page.row(BETA).lamp, 'doneSeen');
    assert.strictEqual(ptv.badge, undefined);
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
    assert.deepStrictEqual(cmds, ['goToChat', 'compact', 'handoff', 'setAutoCompact', 'markSeen', 'openTranscript', 'revealTranscript', 'copyTranscriptPath']);
    assert.strictEqual(items.filter((x) => x.kind === vscode.QuickPickItemKind.Separator).length, 2, 'separators between the three groups');
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
    // the shared scan was left before the worker stopped: leader.json is gone, so another window takes over at once
    assert.ok(!fs.existsSync(path.join(TMP, 'shared-scan', 'leader.json')), 'leader.json left behind');
    assert.strictEqual(ctl.replayTimer, null);
    // only two kinds of info lines are allowed: worker restarts and "recorded an observed compaction point"
    const bad = log.output.filter((l) => !/Background reader stopped|Measured auto-compact point/.test(l));
    assert.deepStrictEqual(bad, [], bad.join('\n'));
  });

  await test('reactivation: the bottom panel is not focused again; the legacy onlyWorkspace=true setting migrates to scope=workspace; observed compaction points go from globalState to the worker; placeholder commands when modules are missing; no global storage → scans alone', () => {
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
    // no globalStorageUri: nowhere to share a scan, so the worker is not paused and no shared scan is created
    assert.strictEqual(ext._controller().shared, null);
    assert.strictEqual(last(log.workers).opts.workerData.paused, undefined);
    for (const d of context2.subscriptions) d.dispose();
    ext.deactivate();
  });
}

// ---------------------------------------------------------------------------
// "Needs you" notifications, shared scan across windows, background slowdown
// ---------------------------------------------------------------------------

/**
 * A fresh activation, as another VS Code window would do it: settings reset to the given ones, its own globalStorageUri
 * under TMP/<name> (the shared-scan and notify dirs go there), the bottom-panel intro already done.
 */
function activateWindow(name, settings = {}, extra = {}) {
  const ext = require(EXT_FILE);
  for (const k of Object.keys(config)) delete config[k];
  for (const [k, v] of Object.entries(settings)) config[k] = { globalValue: v };
  registered.clear();
  const gs = path.join(TMP, name);
  fs.mkdirSync(gs, { recursive: true });
  const context = {
    subscriptions: [], extensionPath: ROOT, extensionUri: Uri.file(ROOT), globalStorageUri: Uri.file(gs),
    globalState: memento({ 'agentMonitor.panelIntro.v1': 1 }), workspaceState: memento(),
    secrets: extra.secrets || fakeSecrets(),
    ...(extra.storageUri ? { storageUri: extra.storageUri } : {}),
  };
  const workers = log.workers.length;
  const shares = sharedLog.length;
  ext.activate(context);
  const win = {
    ctl: ext._controller(), gs, sharedDir: path.join(gs, 'shared-scan'), notifyDir: ext._controller().notifyDir(),
    context, secrets: context.secrets,
    worker: log.workers[workers],
    shared: sharedLog.length > shares ? sharedLog[shares] : null,
    w: () => last(log.workers),
    // To this window's own worker (with several windows open, the newest worker may be another window's)
    send: (sessions, extra) => (ext._controller() === win.ctl || !win.ctl.worker ? last(log.workers) : win.ctl.worker)
      .emit('message', snapshot(clone(sessions), extra)),
    close: () => { for (const d of context.subscriptions) d.dispose(); ext.deactivate(); },
  };
  return win;
}

function setWindowFocused(v) {
  windowState.focused = v;
  for (const fn of [...listeners.windowState]) fn({ focused: v });
}

// The session starts waiting for an answer at sinceMs (not live, so the registry does not override the transcript)
function waiting(s, sinceMs) {
  return { ...s, live: false, liveStatus: null, main: { ...s.main, status: st('awaitingInput', sinceMs) } };
}

// A Claude Code chat editor tab with this title
const chatTab = (label) => ({ label, input: new TabInputWebview('mainThreadWebview-claudeVSCodePanel') });

async function notifyTests() {
  const win = activateWindow('win-notify');
  const toasts = () => log.info.filter((m) => m.startsWith(i18n.t('ext.notify.title')));
  const text = (title, project) => realNotify.formatNeedsYou({ title, project }, i18n);
  const settle = () => sleep(notifyWrap.CLAIM_DELAY_MS * 5); // well past the claim delay, even on a slow machine
  let t = Date.now() - 60e3; // start of each new wait (unique, so every transition has its own id)

  try {
    await test('notifications: the first snapshot only seeds (a chat already waiting is not reported); a later transition gives exactly one toast in the focused window, and the same wait is never reported twice', async () => {
      const n = toasts().length;
      const f = fixtures();
      f[3] = waiting(f[3], t += 1000); // Delta already waits when the window opens
      win.send(f);
      await tick();
      assert.ok(win.ctl.needsLamps.get(DELTA).lamp === 'needsYou' && win.ctl.needsLamps.get(GAMMA).lamp === 'needsYou');
      assert.deepStrictEqual(toasts().slice(n), [], 'seeding must not notify');
      f[1] = waiting(f[1], t += 1000); // Beta starts waiting
      win.send(f);
      await tick();
      assert.deepStrictEqual(toasts().slice(n), [text('Beta chat', 'other').toast]);
      win.send(f);
      win.send(f);
      await tick();
      assert.strictEqual(toasts().length, n + 1, 'the same wait was reported again');
      // the claim marker is what keeps other windows from reporting it too
      assert.strictEqual(fs.readdirSync(win.notifyDir).filter((x) => x.endsWith('.claim')).length, 1);
      assert.strictEqual(sysNotify.calls.length, 0, 'a focused window shows no system notification');
    });

    await test('notifications: no window focused → after the claim delay, on a fresh scan, a system notification (osascript, text as separate argv items); none when the wait ended, another window claimed it, or the setting is off', async () => {
      win.send(fixtures()); // the waits end (a new one is reported only after the session stopped waiting)
      setWindowFocused(false);
      const n = toasts().length;
      const refreshes = () => win.w().messages.filter((m) => m.type === 'refresh').length;
      const r0 = refreshes();
      const f = fixtures();
      f[3] = waiting(f[3], t += 1000);
      win.send(f);
      await tick();
      assert.strictEqual(sysNotify.calls.length, 0, 'unfocused windows wait for a focused one to claim first');
      await settle();
      assert.strictEqual(refreshes(), r0 + 1, 'no rescan before the check');
      assert.strictEqual(sysNotify.calls.length, 0, 'decided on the snapshot that showed the wait, not on a newer one');
      win.send(f); // the rescan: still waiting
      await settle();
      assert.strictEqual(sysNotify.calls.length, 1);
      const msg = text('Delta chat', 'workspace');
      assert.strictEqual(sysNotify.calls[0].cmd, 'osascript');
      assert.deepStrictEqual(sysNotify.calls[0].args.slice(-3), ['--', msg.title, msg.body]);
      assert.strictEqual(toasts().length, n, 'no toast when the system notification worked');

      // The wait ends before the check: with the background interval no snapshot arrives within the delay, so the check
      // waits for the rescan, which shows it answered
      const g = fixtures();
      g[0] = waiting(g[0], t += 1000);
      win.send(g);
      await settle();
      win.send(fixtures());
      await settle();
      // another window already reported this wait
      const h = fixtures();
      h[0] = waiting(h[0], t += 1000);
      realNotify.claimOnce(win.notifyDir, `${ALPHA}|main|${t}`);
      win.send(h);
      win.send(h);
      await settle();
      // notifications turned off while waiting (and while focused): nothing; turning them on later does not report that wait
      const k = fixtures();
      k[1] = waiting(k[1], t += 1000);
      win.send(k);
      setConfig('notifyNeedsYou', false);
      win.send(k);
      await settle();
      setWindowFocused(true);
      const m = fixtures();
      m[3] = waiting(m[3], t += 1000);
      win.send(m);
      setConfig('notifyNeedsYou', true);
      win.send(m);
      await tick();
      assert.strictEqual(sysNotify.calls.length, 1, 'notified although nothing should have been');
      assert.strictEqual(toasts().length, n);
    });

    await test('notifications: the chat is answered and asks again within the delay → the new wait is reported (once), not the old one; two waits in a row for one session report only the newer', async () => {
      win.send(fixtures());
      setWindowFocused(false);
      try {
        const calls = sysNotify.calls.length;
        const first = t += 1000;
        const f = fixtures();
        f[1] = waiting(f[1], first);
        win.send(f);
        const second = t += 1000;
        const g = fixtures();
        g[1] = waiting(g[1], second); // answered and asked again: same lamp, a new wait
        win.send(g);
        await settle();
        win.send(g);
        await settle();
        assert.strictEqual(sysNotify.calls.length, calls + 1);
        assert.ok(fs.existsSync(path.join(win.notifyDir, realNotify.markerName(`${BETA}|main|${second}`))), 'the current wait was claimed');
        assert.ok(!fs.existsSync(path.join(win.notifyDir, realNotify.markerName(`${BETA}|main|${first}`))), 'the old wait was claimed');
        // two transitions for one key within the delay: only the newer one is notified
        win.send(fixtures());
        const h = fixtures();
        h[1] = waiting(h[1], t += 1000);
        win.send(h);
        win.send(fixtures());
        const k = fixtures();
        k[1] = waiting(k[1], t += 1000);
        win.send(k);
        await settle();
        win.send(k);
        await settle();
        assert.strictEqual(sysNotify.calls.length, calls + 2);
        assert.ok(fs.existsSync(path.join(win.notifyDir, realNotify.markerName(`${BETA}|main|${t}`))));
        assert.ok(!fs.existsSync(path.join(win.notifyDir, realNotify.markerName(`${BETA}|main|${t - 1000}`))));
      } finally {
        setWindowFocused(true);
      }
    });

    await test('notifications: a window that gets focus during the delay shows a toast instead of a system notification', async () => {
      win.send(fixtures());
      setWindowFocused(false);
      const n = toasts().length;
      const calls = sysNotify.calls.length;
      const f = fixtures();
      f[3] = waiting(f[3], t += 1000);
      win.send(f);
      setWindowFocused(true);
      win.send(f);
      await settle();
      assert.strictEqual(sysNotify.calls.length, calls);
      assert.deepStrictEqual(toasts().slice(n), [text('Delta chat', 'workspace').toast]);
    });

    await test('notifications: Windows and remote windows have no system notification here → the wait is kept, unclaimed, and shown as a toast in the window that gets focus first (if it still waits); a failed command (Linux without notify-send) gets a toast at once', async () => {
      win.send(fixtures());
      const n = toasts().length;
      const calls = sysNotify.calls.length;
      setWindowFocused(false);
      sysNotify.platform = 'win32';
      try {
        const w = fixtures();
        w[1] = waiting(w[1], t += 1000);
        win.send(w);
        win.send(w);
        await settle();
        assert.deepStrictEqual(toasts().slice(n), [], 'a toast in a window without focus is easily missed');
        assert.ok(!fs.existsSync(path.join(win.notifyDir, realNotify.markerName(`${BETA}|main|${t}`))), 'claimed without being shown');
        setWindowFocused(true);
        assert.deepStrictEqual(toasts().slice(n), [text('Beta chat', 'other').toast]);
        // a kept wait that ended before any window got focus is dropped
        win.send(fixtures());
        setWindowFocused(false);
        const x = fixtures();
        x[3] = waiting(x[3], t += 1000);
        win.send(x);
        win.send(x);
        await settle();
        win.send(fixtures());
        setWindowFocused(true);
        assert.strictEqual(toasts().length, n + 1);
        // remote window (the extension host runs on another machine): the same, whatever the platform
        sysNotify.platform = 'darwin';
        vscode.env.remoteName = 'ssh-remote';
        setWindowFocused(false);
        const r = fixtures();
        r[1] = waiting(r[1], t += 1000);
        win.send(r);
        win.send(r);
        await settle();
        assert.strictEqual(sysNotify.calls.length, calls, 'osascript would run on the remote machine');
        setWindowFocused(true);
        assert.deepStrictEqual(toasts().slice(n), [text('Beta chat', 'other').toast, text('Beta chat', 'other').toast]);
        delete vscode.env.remoteName;
        // Linux without a working notify-send: the toast is shown instead
        win.send(fixtures());
        setWindowFocused(false);
        sysNotify.platform = 'linux';
        sysNotify.fail = true;
        const y = fixtures();
        y[3] = waiting(y[3], t += 1000);
        win.send(y);
        win.send(y);
        await settle();
        assert.strictEqual(sysNotify.calls.length, calls + 1);
        assert.strictEqual(last(sysNotify.calls).cmd, 'notify-send');
        assert.deepStrictEqual(toasts().slice(n + 2), [text('Delta chat', 'workspace').toast]);
      } finally {
        delete vscode.env.remoteName;
        sysNotify.platform = 'darwin';
        sysNotify.fail = false;
        setWindowFocused(true);
      }
    });

    await test('notifications: no toast for the chat the user is looking at (its tab is active in the focused window), but it is still claimed so no other window reports it', async () => {
      win.send(fixtures());
      const n = toasts().length;
      const before = tabState.active;
      try {
        tabState.active = chatTab('Beta chat');
        const f = fixtures();
        f[1] = waiting(f[1], t += 1000);
        win.send(f);
        await tick();
        assert.deepStrictEqual(toasts().slice(n), []);
        assert.ok(fs.existsSync(path.join(win.notifyDir, realNotify.markerName(`${BETA}|main|${t}`))), 'not claimed');
        // another chat starts waiting meanwhile: that one is shown
        f[3] = waiting(f[3], t += 1000);
        win.send(f);
        await tick();
        assert.deepStrictEqual(toasts().slice(n), [text('Delta chat', 'workspace').toast]);
      } finally {
        tabState.active = before;
      }
    });

    await test('notifications: sessions outside this window\'s scope are reported too, and switching scope never reports an old wait; "Show" adds the session to this window\'s list without writing a setting, selects it and reveals the panel', async () => {
      win.send(fixtures());
      setConfig('scope', 'workspace');
      assert.ok(!win.ctl.scoped.some((s) => s.key === BETA), 'Beta (another folder) is outside the workspace scope');
      const n = toasts().length;
      const executed = log.executed.length;
      const updates = log.updates.length;
      infoAnswer = (msg, items) => items[0];
      const f = fixtures();
      f[1] = waiting(f[1], t += 1000);
      win.send(f);
      for (let i = 0; i < 5; i++) await tick();
      infoAnswer = null;
      assert.deepStrictEqual(toasts().slice(n), [text('Beta chat', 'other').toast]);
      assert.strictEqual(effective('scope'), 'workspace', 'the scope setting (shared by every window) is left alone');
      assert.deepStrictEqual(log.updates.slice(updates), [], 'a setting was written');
      assert.ok(win.ctl.scoped.some((s) => s.key === BETA), 'Beta is not in the list');
      assert.strictEqual(win.ctl.selectedKey, BETA);
      assert.strictEqual(win.ctl.shownKey, BETA);
      assert.ok(log.executed.slice(executed).some((x) => x[0] === 'agentMonitor.agents.focus'), 'panel not revealed');
      win.send(f);
      await tick();
      assert.strictEqual(toasts().length, n + 1, 'switching scope reported the wait again');
      assert.ok(win.ctl.scoped.some((s) => s.key === BETA), 'kept while it stays selected');
      // selecting another row puts the list back to the scope alone
      win.ctl.userSelect(DELTA);
      assert.ok(!win.ctl.scoped.some((s) => s.key === BETA));
      // so does changing the scope
      win.ctl.revealSession(BETA);
      assert.ok(win.ctl.scoped.some((s) => s.key === BETA));
      setConfig('scope', 'all');
      setConfig('scope', 'workspace');
      assert.ok(!win.ctl.scoped.some((s) => s.key === BETA));
    });
    await test('notifications: chats that only show up because a scan setting changed (e.g. a provider turned on) are not reported, however long they have waited; later waits are', async () => {
      win.send(fixtures());
      const n = toasts().length;
      const epsilon = waiting(session({ id: '44444444-4444-4444-8444-444444444444', title: 'Epsilon chat' }), t += 1000);
      setConfig('codex.enabled', false);
      // a scan from before the change arrives late: no new chat in it
      win.send(fixtures(), { cfgGen: win.w().cfgGen() - 1 });
      // the first scan with the new settings shows a chat that has been waiting all along
      win.send([...fixtures(), epsilon]);
      await tick();
      assert.deepStrictEqual(toasts().slice(n), []);
      const g = [...fixtures(), epsilon];
      g[1] = waiting(g[1], t += 1000);
      win.send(g);
      await tick();
      assert.deepStrictEqual(toasts().slice(n), [text('Beta chat', 'other').toast]);
      setConfig('codex.enabled', true);
    });
  } finally {
    infoAnswer = null;
    setWindowFocused(true);
    win.close();
  }
}

async function sharedScanTests() {
  let cfgKey = null;
  const paths = (dir) => ({ leader: path.join(dir, 'leader.json'), snapshot: path.join(dir, 'snapshot.json') });

  await test('shared scan: the first window leads, publishes each worker snapshot (not when only now changed) and scans for the union of every window\'s focus; a follower\'s refresh reaches its worker; leaving hands over at once', async () => {
    const A = activateWindow('win-lead');
    const peer = peerWindow(A.sharedDir, A.shared.o.cfgKey);
    try {
      cfgKey = A.ctl.cfgKey();
      assert.strictEqual(A.shared.o.cfgKey, cfgKey);
      const parsed = JSON.parse(cfgKey);
      assert.ok(!('intervalMs' in parsed) && !('observedCompact' in parsed), 'refresh speed and learned compaction points do not split windows');
      assert.strictEqual(A.shared.inst.role, 'leader');
      const w = A.worker;
      assert.strictEqual(w.opts.workerData.paused, true);
      assert.ok(w.messages.some((m) => m.type === 'resume'));
      peer.inst.start();
      assert.strictEqual(peer.inst.role, 'follower');
      A.send(fixtures());
      await tick();
      assert.ok(fs.existsSync(paths(A.sharedDir).snapshot));
      peer.beat();
      assert.strictEqual(peer.snaps.length, 1);
      assert.deepStrictEqual(peer.snaps[0].sessions.map((s) => s.key), KEYS);
      // same content, later now: not written again
      A.send(fixtures(), { now: Date.now() + 5000 });
      peer.beat();
      assert.strictEqual(peer.snaps.length, 1);
      // the other window's focus reaches the leader's worker
      peer.inst.setFocus([DELTA]);
      A.shared.beat();
      assert.ok(last(w.messages.filter((m) => m.type === 'focus')).keys.includes(DELTA));
      assert.ok(last(w.messages.filter((m) => m.type === 'focus')).keys.includes(A.ctl.shownKey));
      // a refresh requested by the other window
      const sent = w.messages.length;
      peer.inst.requestRefresh();
      A.shared.beat();
      assert.deepStrictEqual(w.messages.slice(sent).filter((m) => m.type === 'refresh'), [{ type: 'refresh' }]);
      A.close();
      assert.strictEqual(w.terminated, true);
      assert.ok(!fs.existsSync(paths(A.sharedDir).leader), 'leader.json left behind');
      peer.beat();
      assert.strictEqual(peer.inst.role, 'leader', 'the other window did not take over');
    } finally {
      peer.inst.stop();
    }
  });

  const dir = path.join(TMP, 'win-follow', 'shared-scan');
  let leader = null;
  let B = null;
  try {
    await test('shared scan: a window that finds a leader follows: its worker stays paused, its own snapshots are ignored, the leader\'s are rendered, its selection reaches the leader and refresh asks the leader', async () => {
      fs.mkdirSync(dir, { recursive: true });
      leader = peerWindow(dir, cfgKey);
      leader.inst.start();
      assert.strictEqual(leader.inst.role, 'leader');
      assert.ok(leader.inst.publish(snapshot(clone(fixtures()))));
      // a different refresh speed still follows (intervalMs is not part of cfgKey)
      B = activateWindow('win-follow', { refreshSeconds: 1 });
      assert.strictEqual(B.shared.inst.role, 'follower');
      const w = B.worker;
      assert.strictEqual(w.opts.workerData.paused, true);
      assert.ok(w.messages.some((m) => m.type === 'pause') && !w.messages.some((m) => m.type === 'resume'));
      assert.deepStrictEqual([...B.ctl.byKey.keys()], KEYS, 'the leader\'s snapshot was not rendered');
      assert.strictEqual(log.contexts['agentMonitor.loaded'], true);
      B.send([]);
      assert.strictEqual(B.ctl.byKey.size, 4, 'a paused worker\'s late snapshot must not replace the leader\'s');
      const f = fixtures().slice(0, 2);
      assert.ok(leader.inst.publish(snapshot(clone(f), { now: Date.now() - HOUR }))); // written an hour ago, unchanged since
      B.shared.beat();
      assert.deepStrictEqual([...B.ctl.byKey.keys()], [ALPHA, BETA]);
      assert.ok(Date.now() - B.ctl.last.now < 1000, 'the follower renders with its own clock');
      leader.beat();
      assert.ok(last(leader.unions).includes(B.ctl.shownKey), 'the follower\'s selection is not in the leader\'s focus');
      // refresh: the follower asks the leader, whose next publish (even if unchanged) ends the progress
      const done = registered.get('agentMonitor.refresh')();
      let finished = false;
      done.then(() => { finished = true; });
      assert.ok(!w.messages.some((m) => m.type === 'refresh'));
      leader.beat();
      assert.strictEqual(leader.refreshes, 1);
      assert.ok(leader.inst.publish(snapshot(clone(f))), 'the answer to a refresh is published even if unchanged');
      B.shared.beat();
      await tick();
      assert.strictEqual(finished, true);
    });

    await test('shared scan: while the leader has nothing new to publish, the follower re-runs the last snapshot with its own clock at the scan interval (times, reminders); when the leader leaves it takes over', async () => {
      assert.ok(B && B.shared && B.shared.inst.role === 'follower', 'needs the follower from the previous test');
      const n = log.compactSnapshots.length;
      const before = B.ctl.last.now;
      await sleep(1400); // refreshSeconds is 1 in this window
      assert.ok(log.compactSnapshots.length > n, 'no snapshot re-run while the leader was idle');
      const re = last(log.compactSnapshots);
      assert.ok(re.now >= before + 900, 'the re-run carries the current time');
      assert.strictEqual(re.replay, true, 'a re-run must be marked, so it never confirms a closed window');
      assert.deepStrictEqual(re.sessions.map((s) => s.key), [ALPHA, BETA]);
      // the leader goes away: the follower claims, resumes its worker with the union focus and stops re-running
      const w = B.worker;
      leader.inst.stop();
      B.shared.beat();
      assert.strictEqual(B.shared.inst.role, 'leader');
      assert.strictEqual(last(w.messages.filter((m) => m.type === 'pause' || m.type === 'resume')).type, 'resume');
      assert.strictEqual(B.ctl.replayTimer, null);
      B.send(fixtures());
      assert.strictEqual(B.ctl.byKey.size, 4, 'the new leader renders its own worker\'s snapshots');
      assert.ok(fs.readFileSync(paths(dir).snapshot, 'utf8').includes(DELTA), 'and publishes them');
    });
  } finally {
    if (B) B.close();
    if (leader) leader.inst.stop();
  }

  await test('shared scan off: the window scans alone as before; turning it on joins at once, turning it off leaves and resumes the worker', async () => {
    const C = activateWindow('win-solo', { shareScanAcrossWindows: false });
    try {
      assert.strictEqual(C.shared, null);
      assert.strictEqual(C.ctl.shared, null);
      const w = C.worker;
      assert.strictEqual(w.opts.workerData.paused, undefined);
      C.send(fixtures());
      await tick();
      assert.ok(!w.messages.some((m) => m.type === 'pause' || m.type === 'resume'));
      assert.deepStrictEqual(last(w.messages.filter((m) => m.type === 'focus')).keys, [C.ctl.shownKey], 'focus goes straight to the worker');
      assert.ok(!fs.existsSync(C.sharedDir));
      setConfig('shareScanAcrossWindows', true);
      assert.ok(C.ctl.shared, 'did not join');
      assert.strictEqual(C.ctl.shared.role, 'leader');
      assert.ok(fs.existsSync(paths(C.sharedDir).leader));
      setConfig('shareScanAcrossWindows', false);
      assert.strictEqual(C.ctl.shared, null);
      assert.ok(!fs.existsSync(paths(C.sharedDir).leader), 'leader.json left behind');
      assert.strictEqual(last(w.messages).type, 'resume');
      const n = w.messages.length;
      registered.get('agentMonitor.refresh')();
      assert.deepStrictEqual(w.messages.slice(n), [{ type: 'refresh' }]);
    } finally {
      C.close();
    }
  });
}

async function jumpTests() {
  const en = createI18n('en');
  const [alpha, beta, gamma] = fixtures();
  const go = (win, arg) => win.ctl.goToChat(arg);
  const resetJump = () => {
    vscode.window.terminals.length = 0;
    jumpFake.procs = [];
    jumpFake.live.clear();
    jumpFake.holders = null;
    jumpFake.raised = 0;
    jumpFake.raise = true;
    jumpFake.osa.length = 0;
    jumpFake.osaOut = 'ok';
    extraCommands.clear();
    extraExtensions.clear();
  };
  const readWin = (win) => JSON.parse(fs.readFileSync(path.join(win.sharedDir, `win-${win.shared.inst.id}.json`), 'utf8'));
  const CODE = '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility';
  const PTY = '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper --type=utility ptyHost';
  const proc = (pid, ppid, cmd) => ({ pid, ppid, startMs: NOW - HOUR, cmd });

  await test('Go to Chat: this window\'s presence record carries its extension-host pid, its terminals\' shell pids and its folders, and follows terminals opening', async () => {
    resetJump();
    const win = activateWindow('win-jump-presence');
    try {
      await sleep(5);
      let W = readWin(win);
      assert.strictEqual(W.hostPid, process.pid);
      assert.deepStrictEqual(W.terminals, []);
      assert.deepStrictEqual(W.folders, (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath));
      const zsh = fakeTerminal('zsh', 4242);
      openTerminal(zsh);
      openTerminal(fakeTerminal('bash', 4141));
      await sleep(5);
      W = readWin(win);
      assert.deepStrictEqual(W.terminals, [4141, 4242]);
      // closed terminals leave the record, so it never grows with terminals opened and closed over a day
      closeTerminal(zsh);
      for (let i = 0; i < 20; i++) { const t = fakeTerminal('tmp', 5000 + i); openTerminal(t); closeTerminal(t); }
      await sleep(5);
      assert.deepStrictEqual(readWin(win).terminals, [4141]);
      assert.strictEqual(jumpFake.lists, 0, 'processes are never listed except on a click');
    } finally {
      win.close();
      resetJump();
    }
  });

  await test('Go to Chat: a Claude VS Code chat under this window\'s extension host opens with claude-vscode.editor.open honoring the preferred location (only if that command exists); a Codex extension thread opens as its editor tab; not running → a short message', async () => {
    resetJump();
    const win = activateWindow('win-jump-local');
    try {
      win.send(fixtures());
      await tick();
      jumpFake.procs = [proc(1, 0, '/sbin/launchd'), proc(process.pid, 1, CODE), proc(5001, process.pid, '/x/native-binary/claude --output-format stream-json')];
      jumpFake.live.set(alpha.id, { pid: 5001, sessionId: alpha.id, entrypoint: 'claude-vscode' });
      await go(win, ALPHA);
      assert.strictEqual(last(log.info), en.t('ext.jump.noCommand', { tool: en.t('ext.jump.tool.claudeVscode') }), 'no Claude Code extension in this window');
      extraCommands.add('claude-vscode.editor.open');
      const n = log.info.length;
      await go(win, { webviewSection: 'session', sessionKey: ALPHA });
      // the 6th argument keeps the user's preferred Claude location (without it the command switches it to "panel")
      assert.deepStrictEqual(last(log.executed), ['claude-vscode.editor.open', alpha.id, undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' }]);
      assert.strictEqual(log.info.length, n, 'nothing to say when it worked');
      assert.strictEqual(jumpFake.raised, 0, 'this window is not raised for a jump inside it');
      // Beta: a Claude CLI that is not running
      await go(win, BETA);
      assert.strictEqual(last(log.info), en.t('ext.jump.notRunning'));
      // Gamma: a thread of the Codex extension, whose app-server runs under this window's extension host
      assert.ok(gamma.entry === 'vscode');
      jumpFake.procs.push(proc(5100, process.pid, '/Users/x/.vscode/extensions/openai.chatgpt-1.0.0/bin/codex app-server --analytics-default-enabled'));
      await go(win, GAMMA);
      assert.strictEqual(last(log.info), en.t('ext.jump.noCommand', { tool: en.t('ext.jump.tool.codexVscode') }), 'the Codex extension is not installed here');
      extraExtensions.add('openai.chatgpt');
      await go(win, GAMMA);
      const [cmd, uri, viewType] = last(log.executed);
      assert.deepStrictEqual([cmd, uri.scheme, uri.authority, uri.path, viewType], ['vscode.openWith', 'openai-codex', 'route', `/local/${gamma.id}`, 'chatgpt.conversationEditor']);
    } finally {
      win.close();
      resetJump();
    }
  });

  await test('Go to Chat: a Claude CLI in an integrated terminal of this window shows that terminal (from the panel, a tree agent node or a key)', async () => {
    resetJump();
    const win = activateWindow('win-jump-term');
    try {
      win.send(fixtures());
      await tick();
      const other = fakeTerminal('other', 7101);
      const t = fakeTerminal('zsh', 7001);
      openTerminal(other);
      openTerminal(t);
      jumpFake.procs = [proc(1, 0, '/sbin/launchd'), proc(7000, 1, PTY), proc(7001, 7000, '/bin/zsh -il'), proc(7101, 7000, '/bin/zsh -il'),
        proc(7002, 7001, '/Users/x/.local/bin/claude')];
      jumpFake.live.set(beta.id, { pid: 7002, sessionId: beta.id, entrypoint: 'cli' });
      await go(win, BETA);
      assert.deepStrictEqual([t.shown, other.shown], [1, 0]);
      await go(win, { kind: 'agent', extra: { session: { key: BETA } } }); // a tree agent node
      assert.strictEqual(t.shown, 2);
      // the panel's Go to button / double-click run the command with the key
      const page = openPanel();
      page.msg({ type: 'goTo', sessionKey: BETA });
      await tick();
      assert.deepStrictEqual(last(log.executed), ['agentMonitor.goToChat', BETA]);
    } finally {
      win.close();
      resetJump();
    }
  });

  await test('Go to Chat: a CLI in iTerm2 / Terminal.app selects its tab by tty with osascript, only after a one-time confirmation (remembered per app); a refusal by macOS offers the Automation settings; other terminal apps are named', async () => {
    resetJump();
    const win = activateWindow('win-jump-external');
    const answers = [];
    try {
      win.send(fixtures());
      await tick();
      const iterm = (tty) => [proc(1, 0, '/sbin/launchd'), proc(8000, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2'),
        { ...proc(8001, 8000, '/bin/zsh -l'), tty }, { ...proc(8002, 8001, '/Users/x/.local/bin/claude'), tty }];
      jumpFake.procs = iterm('/dev/ttys004');
      jumpFake.live.set(beta.id, { pid: 8002, sessionId: beta.id, entrypoint: 'cli' });
      const confirm = en.t('ext.jump.automation.confirm', { app: 'iTerm2' });
      // declined: nothing runs, nothing more is said
      infoAnswer = (m, items) => { answers.push(m); return undefined; };
      const n = log.info.length;
      await go(win, BETA);
      assert.deepStrictEqual(log.info.slice(n), [confirm]);
      assert.deepStrictEqual(jumpFake.osa, []);
      // agreed: osascript gets the script lines and the tty
      infoAnswer = (m, items) => { answers.push(m); return m === confirm ? items.find((x) => typeof x === 'string') : undefined; };
      await go(win, BETA);
      const call = last(jumpFake.osa);
      assert.strictEqual(call[0], '/usr/bin/osascript');
      assert.strictEqual(last(call), '/dev/ttys004');
      assert.ok(call.includes('  if application id "com.googlecode.iterm2" is not running then return "not-running"'));
      assert.strictEqual(answers.filter((m) => m === confirm).length, 2);
      // remembered: no confirmation the next time
      await go(win, BETA);
      assert.strictEqual(answers.filter((m) => m === confirm).length, 2);
      assert.strictEqual(jumpFake.osa.length, 2);
      // the tab is gone / macOS refused (-1743) → the Automation settings button opens System Settings
      jumpFake.osaOut = 'not-found';
      await go(win, BETA);
      assert.strictEqual(last(log.info), en.t('ext.jump.tabNotFound', { app: 'iTerm2' }));
      jumpFake.osaOut = Object.assign(new Error('Command failed: osascript\nexecution error: Not authorized to send Apple events to iTerm2. (-1743)'), { code: 1 });
      warnAnswer = (m, items) => items[0];
      await go(win, BETA);
      assert.strictEqual(last(log.warn), en.t('ext.jump.automationDenied', { editor: 'Visual Studio Code', app: 'iTerm2' }));
      assert.match(last(log.external), /x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_Automation$/);
      // Warp is only named
      jumpFake.procs = [proc(1, 0, '/sbin/launchd'), proc(8100, 1, '/Applications/Warp.app/Contents/MacOS/stable'), { ...proc(8101, 8100, '/bin/zsh'), tty: '/dev/ttys009' },
        { ...proc(8102, 8101, '/Users/x/.local/bin/claude'), tty: '/dev/ttys009' }];
      jumpFake.live.set(beta.id, { pid: 8102, sessionId: beta.id, entrypoint: 'cli' });
      await go(win, BETA);
      assert.strictEqual(last(log.info), en.t('ext.jump.externalApp', { app: 'Warp' }));
      assert.strictEqual(jumpFake.osa.length, 4);
    } finally {
      infoAnswer = null;
      warnAnswer = null;
      win.close();
      resetJump();
    }
  });

  await test('Go to Chat across windows: a chat owned by another window becomes a jump request; that window performs it, raises itself and replies, so the requester says nothing (or where to look when it was not raised / did not answer); requests to this window are performed here, invalid ones ignored', async () => {
    resetJump();
    jumpFake.replyWaitMs = 3000; // replies arrive within the test; the no-reply case uses the short wait of another jumper below
    const A = activateWindow('win-jump-a');
    jumpFake.replyWaitMs = 40;
    const peerJumps = [];
    let reply = null; // how the peer answers: (request) => result fields | null
    const peer = peerWindow(A.sharedDir, A.shared.o.cfgKey, {
      host: { hostPid: 9100, terminals: [9200], folders: ['/work/peer-folder'] },
      onJump: (r) => {
        peerJumps.push(r);
        const out = reply && r.action.kind !== 'result' ? reply(r) : null;
        if (out) peer.inst.requestJump(r.from, { kind: 'result', reqId: r.id, ...out });
      },
    });
    // until the requester's reply wait ends: let the peer take its requests and this window take the replies
    const pump = (p) => {
      let done = false;
      p.then(() => { done = true; }, () => { done = true; });
      return (async () => {
        for (let i = 0; i < 200 && !done; i++) {
          await sleep(5);
          peer.beat();
          A.shared.beat();
        }
        return p;
      })();
    };
    try {
      peer.inst.start();
      A.send(fixtures());
      await tick();
      extraCommands.add('claude-vscode.editor.open');
      jumpFake.procs = [proc(1, 0, '/sbin/launchd'), proc(process.pid, 1, CODE), proc(9100, 1, CODE), proc(9101, 9100, '/x/claude'),
        proc(9000, 1, PTY), proc(9200, 9000, '/bin/zsh'), proc(9201, 9200, '/x/claude')];
      jumpFake.live.set(alpha.id, { pid: 9101, sessionId: alpha.id, entrypoint: 'claude-vscode' });
      jumpFake.live.set(beta.id, { pid: 9201, sessionId: beta.id, entrypoint: 'cli' });
      const executed = log.executed.length;
      // raised there: nothing to say here
      reply = () => ({ ok: true, raised: true });
      let n = log.info.length;
      await pump(go(A, ALPHA));
      assert.deepStrictEqual(log.info.slice(n), []);
      assert.ok(!log.executed.slice(executed).some((x) => x[0] === 'claude-vscode.editor.open'), 'not opened in this window (it would open a duplicate)');
      assert.deepStrictEqual(peerJumps.map((r) => r.action), [{ kind: 'claudeVscode', sessionId: alpha.id }]);
      // performed there but not raised: say where; failed there: say why
      reply = () => ({ ok: true, raised: false });
      await pump(go(A, BETA));
      assert.strictEqual(last(log.info), en.t('ext.jump.sentToWindow', { folder: 'peer-folder' }));
      assert.deepStrictEqual(last(peerJumps).action, { kind: 'terminal', pid: 9200 });
      reply = () => ({ ok: false, reason: 'noCommand', tool: 'claudeVscode' });
      await pump(go(A, ALPHA));
      assert.strictEqual(last(log.info), en.t('ext.jump.noCommandThere', { folder: 'peer-folder', tool: en.t('ext.jump.tool.claudeVscode') }), 'it is the other window that lacks it');
      // the other way round: the peer asks this window to show one of its terminals; this window shows it, raises itself
      // and replies
      const t = fakeTerminal('zsh', 6100);
      openTerminal(t);
      await sleep(5);
      const req = peer.inst.requestJump(A.shared.inst.id, { kind: 'terminal', pid: 6100 });
      peer.inst.requestJump(A.shared.inst.id, { kind: 'terminal', pid: 'x' });
      peer.inst.requestJump(A.shared.inst.id, { kind: 'run', command: 'workbench.action.quit' });
      peer.inst.requestJump(A.shared.inst.id, { kind: 'externalTerminal', app: 'iterm2', tty: '/dev/ttys001' });
      const before = log.executed.length;
      A.shared.beat();
      await sleep(10);
      assert.strictEqual(t.shown, 1);
      assert.strictEqual(jumpFake.raised, 1, 'the owning window raised itself');
      assert.strictEqual(log.executed.length, before, 'invalid requests run nothing');
      assert.deepStrictEqual(jumpFake.osa, [], 'another window cannot make this one run AppleScript');
      peer.beat();
      assert.deepStrictEqual(last(peerJumps).action, { kind: 'result', reqId: req, ok: true, raised: true });
      // sharing off: a chat under another VS Code window can only be named
      A.close();
      const B = activateWindow('win-jump-solo', { shareScanAcrossWindows: false });
      try {
        B.send(fixtures());
        await tick();
        await go(B, ALPHA);
        assert.strictEqual(last(log.info), en.t('ext.jump.otherWindow'));
      } finally {
        B.close();
      }
      // no reply within the wait: say where to look
      const C = activateWindow('win-jump-c');
      const quiet = peerWindow(C.sharedDir, C.shared.o.cfgKey, { host: { hostPid: 9100, terminals: [9200], folders: ['/work/peer-folder'] } });
      try {
        quiet.inst.start();
        C.send(fixtures());
        await tick();
        await go(C, ALPHA);
        assert.strictEqual(last(log.info), en.t('ext.jump.noReply', { folder: 'peer-folder' }));
        assert.deepStrictEqual(fs.readdirSync(C.sharedDir).filter((n) => /^jump\..*\.peer\.json$/.test(n)), [], 'the unanswered request is withdrawn, so the peer never performs it late');
      } finally {
        quiet.inst.stop();
        C.close();
      }
    } finally {
      peer.inst.stop();
      resetJump();
    }
  });
}

async function sharedScanRobustnessTests() {
  const exists = (dir, name) => fs.existsSync(path.join(dir, name));

  await test('shared scan: a leader with other settings (another cfgKey) → this window scans alone (solo): its worker resumes and renders its own snapshots, which are not published', async () => {
    const dir = path.join(TMP, 'win-solo2', 'shared-scan');
    fs.mkdirSync(dir, { recursive: true });
    const leader = peerWindow(dir, 'another-config');
    leader.inst.start();
    const W = activateWindow('win-solo2');
    try {
      assert.strictEqual(W.shared.inst.role, 'solo');
      assert.ok(W.worker.messages.some((m) => m.type === 'resume'), 'the worker stayed paused');
      W.send(fixtures());
      assert.deepStrictEqual([...W.ctl.byKey.keys()], KEYS);
      assert.ok(!exists(dir, 'snapshot.json'), 'solo does not publish');
    } finally {
      W.close();
      leader.inst.stop();
    }
  });

  await test('shared scan: a follower whose scan settings change (staleMinutes) updates its cfgKey at once and scans alone after the grace period, unless the leader follows', async () => {
    const dir = path.join(TMP, 'win-grace', 'shared-scan');
    fs.mkdirSync(dir, { recursive: true });
    const leader = peerWindow(dir, 'placeholder');
    leader.inst.start();
    const B = activateWindow('win-grace');
    try {
      leader.inst.setCfgKey(B.ctl.cfgKey());
      B.shared.beat();
      assert.strictEqual(B.shared.inst.role, 'follower');
      const w = B.worker;
      const before = B.ctl.cfgKey();
      setConfig('staleMinutes', 6);
      const after = B.ctl.cfgKey();
      assert.notStrictEqual(after, before);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, `win-${B.shared.inst.id}.json`), 'utf8')).cfgKey, after, 'the new key was not announced');
      leader.beat();
      B.shared.beat();
      assert.strictEqual(B.shared.inst.role, 'follower', 'within the grace period');
      sharedClock.offset += 3500; // past soloGraceMs (3 s)
      leader.beat();
      B.shared.beat();
      assert.strictEqual(B.shared.inst.role, 'solo');
      assert.strictEqual(last(w.messages.filter((m) => m.type === 'pause' || m.type === 'resume')).type, 'resume');
      // the leader's settings change the same way: follow again
      leader.inst.setCfgKey(after);
      B.shared.beat();
      assert.strictEqual(B.shared.inst.role, 'follower');
    } finally {
      sharedClock.offset = 0;
      B.close();
      leader.inst.stop();
    }
  });

  await test('shared scan: the shared folder cannot be written (a file is in its way) → the window scans alone instead of loading forever', async () => {
    const gs = path.join(TMP, 'win-ro');
    fs.mkdirSync(gs, { recursive: true });
    fs.writeFileSync(path.join(gs, 'shared-scan'), 'not a folder');
    const W = activateWindow('win-ro');
    try {
      assert.strictEqual(W.shared.inst.role, 'solo');
      assert.ok(W.worker.messages.some((m) => m.type === 'resume'), 'the worker stayed paused');
      W.send(fixtures());
      assert.strictEqual(log.contexts['agentMonitor.loaded'], true);
      assert.strictEqual(W.ctl.byKey.size, 4);
    } finally {
      W.close();
    }
  });

  await test('shared scan: a leader whose worker keeps crashing hands the scan to another window and follows it; Refresh starts a worker and lets it lead again', async () => {
    const A = activateWindow('win-crash');
    const peer = peerWindow(A.sharedDir, A.shared.o.cfgKey);
    try {
      assert.strictEqual(A.shared.inst.role, 'leader');
      peer.inst.start();
      assert.strictEqual(peer.inst.role, 'follower');
      const workers = log.workers.length;
      for (let i = 0; i < 4; i++) A.w().emit('exit', 1);
      assert.strictEqual(log.workers.length, workers + 3, 'restarted 3 times');
      assert.strictEqual(A.ctl.worker, null);
      assert.strictEqual(A.shared.inst.role, null, 'still leading without a worker');
      assert.ok(!exists(A.sharedDir, 'leader.json'));
      peer.beat();
      assert.strictEqual(peer.inst.role, 'leader');
      A.shared.beat();
      assert.strictEqual(A.shared.inst.role, 'follower');
      assert.ok(peer.inst.publish(snapshot(clone(fixtures().slice(0, 1)))));
      A.shared.beat();
      assert.deepStrictEqual([...A.ctl.byKey.keys()], [ALPHA], 'the new leader\'s snapshot was not rendered');
      // Refresh: a new (paused) worker, and this window may lead again when the other leaves
      registered.get('agentMonitor.refresh')();
      const w = A.w();
      assert.strictEqual(w.opts.workerData.paused, true);
      peer.inst.stop();
      A.shared.beat();
      assert.strictEqual(A.shared.inst.role, 'leader');
      assert.strictEqual(last(w.messages.filter((m) => m.type === 'pause' || m.type === 'resume')).type, 'resume');
    } finally {
      peer.inst.stop();
      A.close();
    }
  });

  await test('worker restarts: only crashes in a row count; a worker that has run for a while gets its retry budget back', async () => {
    const D = activateWindow('win-retry', { shareScanAcrossWindows: false });
    try {
      const workers = log.workers.length;
      for (let i = 0; i < 3; i++) D.w().emit('exit', 1);
      assert.strictEqual(log.workers.length, workers + 3);
      D.ctl.workerStartedAt -= 11 * MIN; // this one has been scanning for 11 minutes
      D.send(fixtures());
      for (let i = 0; i < 3; i++) D.w().emit('exit', 1);
      assert.strictEqual(log.workers.length, workers + 6, 'three crashes days apart used up the budget');
      D.w().emit('exit', 1);
      assert.strictEqual(D.ctl.worker, null, 'crashes in a row are still capped');
    } finally {
      D.close();
    }
  });

  await test('shared scan: after a publish that changed which Claude chats are live, the leader publishes the next snapshot even if unchanged (followers confirm a closed window only with two real snapshots; their replays are marked and do not count)', async () => {
    const A = activateWindow('win-echo');
    const peer = peerWindow(A.sharedDir, A.shared.o.cfgKey);
    try {
      peer.inst.start();
      const got = () => { peer.beat(); return peer.snaps.length; };
      A.send(fixtures());
      assert.strictEqual(got(), 1);
      A.send(fixtures());
      assert.strictEqual(got(), 1, 'unchanged: not published');
      const f = fixtures();
      f[0] = { ...f[0], live: false, liveStatus: null }; // Alpha's window closed, or one registry read failed
      A.send(f);
      assert.strictEqual(got(), 2);
      A.send(f);
      assert.strictEqual(got(), 3, 'the second look was not published');
      A.send(f);
      assert.strictEqual(got(), 3, 'only once');
      // a snapshot scanned with the old settings, arriving after a change, is not published under the new key
      setConfig('activeWindowMinutes', 45);
      A.send(fixtures(), { cfgGen: A.w().cfgGen() - 1 });
      const file = JSON.parse(fs.readFileSync(path.join(A.sharedDir, 'snapshot.json'), 'utf8'));
      assert.strictEqual(file.snap.sessions.find((x) => x.key === ALPHA).live, false, 'published');
      assert.notStrictEqual(file.cfgKey, A.ctl.cfgKey());
    } finally {
      peer.inst.stop();
      A.close();
    }
  });
}

async function backgroundTests() {
  const intervals = (w) => w.messages.filter((m) => m.type === 'interval');

  await test('background slowdown: with no VS Code window focused the worker scans every backgroundRefreshSeconds (5 s by default, 2–60, never faster than refreshSeconds); focus clears it; a restarted worker gets it again', async () => {
    const D = activateWindow('win-bg', { shareScanAcrossWindows: false });
    try {
      const w = D.worker;
      assert.deepStrictEqual(intervals(w), [], 'focused: no override');
      setWindowFocused(false);
      assert.deepStrictEqual(intervals(w), [{ type: 'interval', ms: 5000 }]);
      setConfig('backgroundRefreshSeconds', 30);
      assert.deepStrictEqual(last(intervals(w)), { type: 'interval', ms: 30000 });
      setConfig('backgroundRefreshSeconds', 600);
      assert.deepStrictEqual(last(intervals(w)), { type: 'interval', ms: 60000 });
      setConfig('backgroundRefreshSeconds', 1); // raised to 2 s, which is not slower than refreshSeconds (2 s)
      assert.deepStrictEqual(last(intervals(w)), { type: 'interval', ms: null });
      setConfig('backgroundRefreshSeconds', 5);
      setConfig('refreshSeconds', 10);
      assert.deepStrictEqual(last(intervals(w)), { type: 'interval', ms: null }, 'refreshSeconds is already slower');
      setConfig('refreshSeconds', 2);
      assert.deepStrictEqual(last(intervals(w)), { type: 'interval', ms: 5000 });
      const count = intervals(w).length;
      w.emit('exit', 1);
      const w2 = D.w();
      assert.notStrictEqual(w2, w);
      assert.deepStrictEqual(intervals(w2), [{ type: 'interval', ms: 5000 }], 'a new worker did not get the override');
      setWindowFocused(true);
      assert.deepStrictEqual(intervals(w2), [{ type: 'interval', ms: 5000 }, { type: 'interval', ms: null }]);
      assert.strictEqual(intervals(w).length, count);
    } finally {
      setWindowFocused(true);
      D.close();
    }
  });

  await test('background slowdown with a shared scan: the leader keeps full speed while any window is focused, and slows once none is', async () => {
    const E = activateWindow('win-bg-shared');
    const peer = peerWindow(E.sharedDir, E.shared.o.cfgKey);
    try {
      assert.strictEqual(E.shared.inst.role, 'leader');
      const w = E.worker;
      peer.inst.setWindowFocused(true);
      peer.inst.start();
      E.shared.beat();
      setWindowFocused(false);
      assert.deepStrictEqual(intervals(w), [], 'another window has focus');
      peer.inst.setWindowFocused(false);
      E.shared.beat();
      assert.deepStrictEqual(intervals(w), [{ type: 'interval', ms: 5000 }]);
      // the windows also check on each other at that pace (announced in leader.json), and follow its setting
      assert.strictEqual(E.shared.o.idleHeartbeatMs, 5000);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(E.sharedDir, 'leader.json'), 'utf8')).hb, 5000);
      setConfig('backgroundRefreshSeconds', 30);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(E.sharedDir, 'leader.json'), 'utf8')).hb, 30000);
      setWindowFocused(true);
      assert.deepStrictEqual(last(intervals(w)), { type: 'interval', ms: null });
      E.shared.beat();
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(E.sharedDir, 'leader.json'), 'utf8')).hb, 2000);
    } finally {
      setWindowFocused(true);
      peer.inst.stop();
      E.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Usage history (lib/history-view.js page, worker { type: 'history' })
// ---------------------------------------------------------------------------

async function historyTests() {
  const hist = (w) => w.messages.filter((m) => m.type === 'history');

  await test('usage history: the command opens the page with requestHistory / onHistory / i18n; requests go to the worker as { type: history }; replies reach the listeners; the cache file is in global storage and not part of the shared-scan key', async () => {
    const win = activateWindow('win-history');
    try {
      assert.strictEqual(win.worker.opts.workerData.historyCacheFile, path.join(win.gs, 'usage-history.jsonl'));
      assert.ok(!('historyCacheFile' in JSON.parse(win.ctl.cfgKey())), 'each window\'s own cache path must not split the shared scan');
      const n = log.historyOpens.length;
      registered.get('agentMonitor.history')();
      assert.strictEqual(log.historyOpens.length, n + 1);
      const deps = last(log.historyOpens);
      assert.strictEqual(deps.i18n, win.ctl.i18n);
      assert.strictEqual(typeof deps.log, 'function');
      const got = [];
      const sub = deps.onHistory((m) => got.push(m));
      const w = win.w();
      const before = w.messages.length;
      deps.requestHistory({ days: 30 });
      deps.requestHistory({ days: 60, force: true, junk: '/etc/passwd' });
      assert.deepStrictEqual(w.messages.slice(before), [{ type: 'history', days: 30 }, { type: 'history', days: 60, force: true }]);
      w.emit('message', { type: 'history', days: [], byModel: [], totals: null, partial: true, progress: { done: 1, total: 4 } });
      w.emit('message', { type: 'history', days: [{ date: '2026-09-24' }], byModel: [], totals: null, partial: false });
      assert.deepStrictEqual(got.map((m) => [m.type, m.partial]), [['history', true], ['history', false]]);
      assert.strictEqual(win.ctl.byKey.size, 0, 'a history reply is not a snapshot');
      // a listener that throws does not stop the others
      const bad = deps.onHistory(() => { throw new Error('synthetic'); });
      w.emit('message', { type: 'history', days: [], partial: false });
      assert.strictEqual(got.length, 3);
      bad.dispose();
      sub.dispose();
      w.emit('message', { type: 'history', days: [], partial: false });
      assert.strictEqual(got.length, 3, 'a disposed listener still gets replies');
    } finally {
      win.close();
    }
  });

  await test('usage history: a worker started later (crash) is asked again, without force once a forced scan completed; after the page releases it, no worker is asked again; with no worker a request starts one', async () => {
    const win = activateWindow('win-history-restart');
    try {
      registered.get('agentMonitor.history')();
      const deps = last(log.historyOpens);
      deps.requestHistory({ days: 45, force: true });
      const w1 = win.w();
      w1.emit('exit', 1); // crashed before answering: the new worker gets the same request, force included
      const w2 = win.w();
      assert.notStrictEqual(w2, w1);
      assert.deepStrictEqual(hist(w2), [{ type: 'history', days: 45, force: true }]);
      w2.emit('message', { type: 'history', days: [], partial: false });
      w2.emit('exit', 1);
      const w3 = win.w();
      assert.deepStrictEqual(hist(w3), [{ type: 'history', days: 45 }], 'the forced scan was done: ask again without force');
      // the page closes
      deps.requestHistory({ release: true });
      assert.deepStrictEqual(last(w3.messages), { type: 'history', release: true });
      w3.emit('exit', 1);
      assert.deepStrictEqual(hist(win.w()), [], 'a released page is not asked for again');
      // no worker at all (stopped on purpose): a request starts one that carries it
      win.ctl.stopWorker();
      const count = log.workers.length;
      deps.requestHistory({ days: 30 });
      assert.strictEqual(log.workers.length, count + 1);
      assert.deepStrictEqual(hist(win.w()), [{ type: 'history', days: 30 }]);
      // release with no worker running: nothing to start
      win.ctl.stopWorker();
      deps.requestHistory({ release: true });
      assert.strictEqual(log.workers.length, count + 1);
    } finally {
      win.close();
    }
  });

  await test('usage history in a follower window: asked of its own paused worker (the worker answers history while paused), never of the leader, and the worker stays paused', async () => {
    const probe = activateWindow('win-history-probe');
    const key = probe.ctl.cfgKey();
    probe.close();
    const dir = path.join(TMP, 'win-history-follow', 'shared-scan');
    fs.mkdirSync(dir, { recursive: true });
    const leader = peerWindow(dir, key);
    leader.inst.start();
    let B = null;
    try {
      assert.ok(leader.inst.publish(snapshot(clone(fixtures()))));
      B = activateWindow('win-history-follow');
      assert.strictEqual(B.shared.inst.role, 'follower');
      const w = B.worker;
      registered.get('agentMonitor.history')();
      const deps = last(log.historyOpens);
      const got = [];
      deps.onHistory((m) => got.push(m));
      deps.requestHistory({ days: 30 });
      assert.deepStrictEqual(hist(w), [{ type: 'history', days: 30 }]);
      assert.ok(!w.messages.some((m) => m.type === 'resume'), 'the follower\'s worker must stay paused');
      B.shared.beat();
      leader.beat();
      assert.strictEqual(leader.refreshes, 0, 'the leader was asked');
      w.emit('message', { type: 'history', days: [], partial: false });
      assert.strictEqual(got.length, 1);
    } finally {
      if (B) B.close();
      leader.inst.stop();
    }
  });

  await test('usage history: when lib/history-view.js fails to load, the command still exists and says the page is unavailable', async () => {
    modOverride.history = {};
    const win = activateWindow('win-history-missing');
    try {
      const n = log.error.length;
      await registered.get('agentMonitor.history')();
      assert.deepStrictEqual(log.error.slice(n), [i18n.t('ext.historyUnavailable')]);
    } finally {
      modOverride.history = null;
      win.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Threshold alerts, sounds and quiet hours (lib/alerts.js)
// ---------------------------------------------------------------------------

const hm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// quiet hours that are on right now (an hour either side), or off right now
const quietNow = (o = {}) => ({ 'quietHours.enabled': true, 'quietHours.start': hm(Date.now() - HOUR), 'quietHours.end': hm(Date.now() + HOUR), ...o });
const quietLater = () => ({ 'quietHours.enabled': true, 'quietHours.start': hm(Date.now() + 2 * HOUR), 'quietHours.end': hm(Date.now() + 3 * HOUR) });
function applyConfig(settings) {
  for (const [k, v] of Object.entries(settings)) setConfig(k, v);
}
// A Codex usage window at usedPct that resets at resetsAtMs
const codexQuota = (usedPct, resetsAtMs) => ({
  ...emptyQuotaSnapshot(),
  codex: { observedMs: Date.now(), planType: 'plus', limitId: 'codex', windows: [{ label: '5h', minutes: 300, usedPct, resetsAtMs }], reachedType: null, credits: null },
});
// Today's totals with this much estimated Claude cost
const todayCost = (usd) => {
  const d = emptyDailyTotals(NOW - 10 * HOUR);
  return { ...d, claude: { ...d.claude, costUsd: usd } };
};
// The session's run ends at atMs (every agent done, nothing live)
function finished(s, atMs) {
  return {
    ...s, live: false, liveStatus: null, doneAtMs: atMs,
    main: { ...s.main, status: st('done', atMs) },
    agents: (s.agents || []).map((a) => ({ ...a, status: st('done', atMs - 1000) })),
  };
}
// The session works again (a new turn) from atMs
function running(s, atMs) {
  return { ...s, live: false, liveStatus: null, doneAtMs: null, main: { ...s.main, status: st('tool', atMs, { pendingTool: 'Bash' }) }, agents: [] };
}
const soundMarker = (dir, id) => path.join(dir, realNotify.markerName('sound|' + id));
const usageTitle = (pct) => i18n.t('alerts.usageHigh.title', { provider: 'Codex', window: i18n.t('alerts.window.5h'), pct: i18n.fmtPct(pct / 100) });

async function alertTests() {
  let t = Date.now() - 120e3; // start of each new wait, error or run (unique, so every transition has its own id)
  const since = () => (t += 1000);
  const settle = () => sleep(notifyWrap.CLAIM_DELAY_MS * 5);

  await test('lamp events (notify.createLampEventTracker): the first sight of a session only seeds; error on entering Error, done only from Working to Done-unseen; old transitions are not reported; ids derive from the data', () => {
    const tr = realNotify.createLampEventTracker();
    const lampsOf = (list) => lampLib.computeLamps(list, { seen: 0 });
    const upd = (list, now = Date.now()) => tr.update(list, lampsOf(list), now);
    const a = fixtures()[0];
    const at = Date.now() - 5000;
    assert.deepStrictEqual(upd([finished(a, at)]), [], 'a chat already done when first seen');
    assert.deepStrictEqual(upd([running(a, at + 1)]), []);
    const done = upd([finished(a, at + 2)]);
    assert.deepStrictEqual(done.map((e) => [e.type, e.key]), [['done', ALPHA]]);
    assert.ok(done[0].transitionId.startsWith(`done|${ALPHA}|main|`), done[0].transitionId);
    const other = realNotify.createLampEventTracker();
    other.update([running(a, at + 1)], lampsOf([running(a, at + 1)]), Date.now());
    assert.strictEqual(other.update([finished(a, at + 2)], lampsOf([finished(a, at + 2)]), Date.now())[0].transitionId, done[0].transitionId, 'another window names it alike');
    assert.deepStrictEqual(upd([finished(a, at + 2)]), [], 'reported once');
    const err = upd([errored(a, at + 3)]);
    assert.deepStrictEqual(err.map((e) => e.type), ['error']);
    assert.deepStrictEqual(upd([finished(a, at + 4)]), [], 'done after an error is not "finished work"');
    assert.deepStrictEqual(upd([waiting(a, at + 5)]), [], 'needs you has its own notification');
    // a laptop that slept through it: a transition from long ago is not reported
    upd([running(a, at - 2 * HOUR)]);
    assert.deepStrictEqual(upd([finished(a, at - HOUR)]), []);
    // a session gone from the list and back is seen anew
    upd([]);
    assert.deepStrictEqual(upd([errored(a, at + 6)]), []);
  });

  await test('threshold alerts: a usage window crossing agentMonitor.alerts.usagePercent (90 by default) → one toast in the focused window, once across windows; the first data only seeds; 0 turns it off; a threshold change never reports what is already over it', async () => {
    tabState.active = null;
    const A = activateWindow('win-alert-a');
    const B = activateWindow('win-alert-b');
    try {
      const n = log.info.length;
      const resetAt = Date.now() + 2 * HOUR;
      for (const w of [A, B]) w.send(fixtures(), { quota: codexQuota(95, resetAt) }); // already over it when the windows open
      await tick();
      assert.deepStrictEqual(log.info.slice(n), [], 'seeding must not alert');
      const reset2 = resetAt + 5 * HOUR; // the next 5-hour window
      for (const w of [A, B]) w.send(fixtures(), { quota: codexQuota(40, reset2) });
      for (const w of [A, B]) w.send(fixtures(), { quota: codexQuota(92, reset2) });
      await tick();
      const shown = log.info.slice(n).filter((m) => m.startsWith(usageTitle(92)));
      assert.strictEqual(shown.length, 1, log.info.slice(n).join('\n'));
      assert.ok(shown[0].includes(i18n.t('alerts.usageHigh.body', { reset: i18n.fmtClock(reset2) })), shown[0]);
      for (const w of [A, B]) w.send(fixtures(), { quota: codexQuota(96, reset2) });
      await tick();
      assert.strictEqual(log.info.slice(n).length, 1, 'the same window alerted twice');
      // off
      setConfig('alerts.usagePercent', 0);
      const reset3 = reset2 + 5 * HOUR;
      for (const w of [A, B]) { w.send(fixtures(), { quota: codexQuota(10, reset3) }); w.send(fixtures(), { quota: codexQuota(99, reset3) }); }
      await tick();
      assert.strictEqual(log.info.slice(n).length, 1, 'alerted with the threshold at 0');
      // turned on again at 50: the window already at 99 is not reported
      setConfig('alerts.usagePercent', 50);
      for (const w of [A, B]) w.send(fixtures(), { quota: codexQuota(99, reset3) });
      await tick();
      assert.strictEqual(log.info.slice(n).length, 1);
    } finally {
      A.close();
      B.close();
    }
  });

  await test('threshold alerts in an unfocused window: after the claim delay, a system notification with the alert text (today\'s cost over agentMonitor.alerts.dailyCost); a context alert in the focused window offers "Show" for its chat', async () => {
    tabState.active = null;
    const win = activateWindow('win-alert-cost', { 'alerts.dailyCost': 5, 'alerts.contextPercent': 80 });
    try {
      win.send(fixtures(), { today: todayCost(1) });
      setWindowFocused(false);
      const calls = sysNotify.calls.length;
      win.send(fixtures(), { today: todayCost(7.5) });
      await tick();
      assert.strictEqual(sysNotify.calls.length, calls, 'unfocused windows give a focused one the claim delay first');
      await settle();
      assert.strictEqual(sysNotify.calls.length, calls + 1);
      const title = i18n.t('alerts.costDaily.title', { budget: i18n.fmtUsd(5) });
      const body = i18n.t('alerts.costDaily.body', { cost: i18n.fmtUsd(7.5) });
      assert.deepStrictEqual(last(sysNotify.calls).args.slice(-3), ['--', title, body]);
      setWindowFocused(true);
      // context: 84 % of the auto-compact point (967000) in a chat updated just now
      const n = log.info.length;
      const f = fixtures();
      win.send(f);
      const g = fixtures();
      g[0] = { ...g[0], updatedMs: Date.now(), compactAt: 967000, contextUsed: 812000, contextPct: 81, main: { ...g[0].main, lastCompact: null } };
      infoAnswer = (m, items) => items[0];
      win.send(g);
      await tick();
      await tick();
      const toast = log.info.slice(n);
      assert.strictEqual(toast.length, 1, toast.join('\n'));
      assert.ok(toast[0].startsWith(i18n.t('alerts.contextHigh.titleProject', { project: 'workspace' })), toast[0]);
      assert.strictEqual(win.ctl.selectedKey, ALPHA, '"Show" selects the chat');
    } finally {
      infoAnswer = null;
      setWindowFocused(true);
      win.close();
    }
  });

  await test('quiet hours: no system notification (the alert and the needs-you wait go to the window that gets focus next, once), no sound; the status bar tooltip says until when; outside the hours everything is back', async () => {
    tabState.active = null;
    const win = activateWindow('win-quiet', { 'sound.enabled': true, ...quietNow() });
    try {
      const resetAt = Date.now() + 3 * HOUR;
      win.send(fixtures(), { quota: codexQuota(20, resetAt) });
      const tip = () => log.statusItem.tooltip.value;
      const until = realAlerts.formatQuietStatus(Date.now(), win.ctl.quietSettings(), i18n);
      assert.ok(until && tip().includes(`$(bell-slash) ${until}`), tip());
      setWindowFocused(false);
      const calls = sysNotify.calls.length;
      const s0 = sounds.calls.length;
      const n = log.info.length;
      const f = fixtures();
      f[1] = waiting(f[1], since());
      win.send(f, { quota: codexQuota(95, resetAt) });
      await settle();
      win.send(f, { quota: codexQuota(95, resetAt) }); // the needs-you check's rescan
      await settle();
      assert.strictEqual(sysNotify.calls.length, calls, 'a system notification during quiet hours');
      assert.strictEqual(sounds.calls.length, s0, 'a sound during quiet hours');
      assert.deepStrictEqual(log.info.slice(n), [], 'a toast in a window without focus is easily missed');
      assert.strictEqual(win.ctl.alertDeferred.size, 1);
      setWindowFocused(true);
      const shown = log.info.slice(n);
      assert.strictEqual(shown.length, 2, shown.join('\n'));
      assert.ok(shown.some((m) => m.startsWith(usageTitle(95))) && shown.some((m) => m.startsWith(i18n.t('ext.notify.titleProject', { project: 'other' }))));
      setWindowFocused(false);
      setWindowFocused(true);
      assert.strictEqual(log.info.length, n + 2, 'shown again on the next focus');
      // outside quiet hours: the tooltip says nothing, and an unfocused window notifies the system again, with sound
      applyConfig(quietLater());
      win.send(fixtures(), { quota: codexQuota(95, resetAt) });
      assert.ok(!tip().includes('$(bell-slash)'), tip());
      setWindowFocused(false);
      const g = fixtures();
      g[3] = waiting(g[3], since());
      win.send(g);
      await settle();
      win.send(g);
      await settle();
      assert.strictEqual(sysNotify.calls.length, calls + 1);
      assert.deepStrictEqual(sounds.calls.slice(s0).map((c) => c.event), ['needsYou']);
    } finally {
      setWindowFocused(true);
      win.close();
    }
  });

  await test('sounds: off by default; with agentMonitor.sound.enabled one sound per event across windows (claimed "sound|" + id): needs you with its toast (Glass), an error (Basso), finished work (Hero), a threshold alert (Funk); "off", a chat you are looking at, quiet hours (errors pass with allowErrors) and remote windows play nothing', async () => {
    tabState.active = null;
    const win = activateWindow('win-sound');
    const peer = activateWindow('win-sound-peer', { 'sound.enabled': true }); // a second window seeing the same data
    const both = (list, extra) => { win.send(list, extra); peer.send(list, extra); };
    const played = (from) => sounds.calls.slice(from).map((c) => `${c.event} ${path.basename(c.args[0])}`);
    try {
      setConfig('sound.enabled', false);
      const s0 = sounds.calls.length;
      both(fixtures());
      const f = fixtures();
      f[1] = waiting(f[1], since());
      both(f);
      await settle();
      assert.deepStrictEqual(played(s0), [], 'sounds are off by default');
      // on: needs you (a toast in the focused window, and its sound), once for both windows
      setConfig('sound.enabled', true);
      both(fixtures());
      const w = fixtures();
      const waitAt = since();
      w[1] = waiting(w[1], waitAt);
      both(w);
      await settle();
      assert.deepStrictEqual(played(s0), ['needsYou Glass.aiff']);
      assert.strictEqual(sounds.calls[s0].cmd, 'afplay');
      assert.strictEqual(last(sounds.opts).claimDir, win.notifyDir, 'the gap between sounds holds across windows');
      assert.ok(fs.existsSync(soundMarker(win.notifyDir, `${BETA}|main|${waitAt}`)));
      // an error, then finished work
      const errAt = since();
      const e = fixtures();
      e[0] = errored(e[0], errAt);
      both(e);
      await tick();
      assert.deepStrictEqual(played(s0).slice(1), ['error Basso.aiff']);
      both([running(fixtures()[0], since()), ...fixtures().slice(1)]);
      const doneAt = since();
      both([finished(fixtures()[0], doneAt), ...fixtures().slice(1)]);
      await tick();
      assert.deepStrictEqual(played(s0).slice(2), ['done Hero.aiff']);
      // a threshold alert
      const resetAt = Date.now() + 4 * HOUR;
      both(fixtures(), { quota: codexQuota(10, resetAt) });
      both(fixtures(), { quota: codexQuota(93, resetAt) });
      await tick();
      assert.deepStrictEqual(played(s0).slice(3), ['alert Funk.aiff']);
      // a chosen sound; and "off"
      setConfig('sound.done', 'pop');
      both([running(fixtures()[0], since()), ...fixtures().slice(1)]);
      both([finished(fixtures()[0], since()), ...fixtures().slice(1)]);
      await tick();
      assert.deepStrictEqual(played(s0).slice(4), ['done Pop.aiff']);
      setConfig('sound.error', 'off');
      const e2 = fixtures();
      e2[0] = errored(e2[0], since());
      both(fixtures());
      both(e2);
      await tick();
      assert.strictEqual(played(s0).length, 5, 'played with the sound "off"');
      setConfig('sound.error', 'default');
      // finished while you look at that chat: no sound, and no other window plays it
      tabState.active = chatTab('Alpha chat');
      both([running(fixtures()[0], since()), ...fixtures().slice(1)]);
      const seenAt = since();
      both([finished(fixtures()[0], seenAt), ...fixtures().slice(1)]);
      await tick();
      tabState.active = null;
      assert.strictEqual(played(s0).length, 5, 'a sound for the chat you are looking at');
      // quiet hours: nothing, except errors with allowErrors
      applyConfig(quietNow());
      both(fixtures());
      const q = fixtures();
      q[3] = waiting(q[3], since());
      both(q);
      await settle();
      const qe = fixtures();
      qe[0] = errored(qe[0], since());
      both(qe);
      await tick();
      assert.strictEqual(played(s0).length, 5, 'a sound during quiet hours');
      setConfig('quietHours.allowErrors', true);
      const qe2 = fixtures();
      qe2[0] = errored(qe2[0], since());
      both(fixtures());
      both(qe2);
      await tick();
      assert.deepStrictEqual(played(s0).slice(5), ['error Basso.aiff'], 'allowErrors lets the error sound through');
      setConfig('quietHours.enabled', false);
      // remote windows: the sound would play on the remote machine
      vscode.env.remoteName = 'ssh-remote';
      try {
        const r = fixtures();
        r[0] = errored(r[0], since());
        both(fixtures());
        both(r);
        await tick();
        assert.strictEqual(played(s0).length, 6, 'a sound in a remote window');
      } finally {
        delete vscode.env.remoteName;
      }
    } finally {
      tabState.active = null;
      win.close();
      peer.close();
    }
  });

  await test('sounds: finished work seen first by an unfocused window waits the claim delay, so the focused window showing that chat keeps it silent; nobody looking → one sound (at once from the focused window, else after the delay); errors play at once', async () => {
    tabState.active = null;
    const settings = { 'sound.enabled': true };
    const back = activateWindow('win-sound-back', settings); // e.g. the leader, whose own scan comes first
    const front = activateWindow('win-sound-front', settings); // the window the user is in
    back.ctl.windowFocused = () => false;
    const played = (from) => sounds.calls.slice(from).map((c) => c.event);
    const a = () => fixtures()[0];
    const rest = () => fixtures().slice(1);
    const run = (list, wins) => { for (const w of wins) w.send(list); };
    try {
      run(fixtures(), [back, front]);
      // the user looks at Alpha in the focused window; the unfocused one sees it finish first
      tabState.active = chatTab('Alpha chat');
      const s0 = sounds.calls.length;
      run([running(a(), since()), ...rest()], [back, front]);
      const doneAt = since();
      back.send([finished(a(), doneAt), ...rest()]);
      await tick();
      assert.deepStrictEqual(played(s0), [], 'the unfocused window played before the focused one could claim it');
      front.send([finished(a(), doneAt), ...rest()]);
      await settle();
      assert.deepStrictEqual(played(s0), [], 'a sound for the chat the user is looking at');
      assert.ok(fs.existsSync(soundMarker(back.notifyDir, `done|${ALPHA}|main|${doneAt}`)), 'claimed silently');
      // nobody looks at it: the focused window plays it at once, the unfocused one not again after its delay
      tabState.active = null;
      run([running(a(), since()), ...rest()], [back, front]);
      const done2 = since();
      back.send([finished(a(), done2), ...rest()]);
      front.send([finished(a(), done2), ...rest()]);
      await tick();
      assert.deepStrictEqual(played(s0), ['done']);
      await settle();
      assert.deepStrictEqual(played(s0), ['done'], 'played twice');
      // no window has focus: the one that sees it plays it after the claim delay
      front.ctl.windowFocused = () => false;
      run([running(a(), since()), ...rest()], [back, front]);
      const done3 = since();
      run([finished(a(), done3), ...rest()], [back, front]);
      await tick();
      assert.deepStrictEqual(played(s0), ['done'], 'no delay in an unfocused window');
      await settle();
      assert.deepStrictEqual(played(s0), ['done', 'done']);
      // the unfocused window gets focus and shows that chat before its delay is over: checked again, silent
      run([running(a(), since()), ...rest()], [back]);
      back.send([finished(a(), since()), ...rest()]);
      back.ctl.windowFocused = () => true;
      tabState.active = chatTab('Alpha chat');
      await settle();
      tabState.active = null;
      assert.deepStrictEqual(played(s0), ['done', 'done'], 'a sound for the chat the user looks at by then');
      // an error has no "looking at it" exception: it plays at once, once
      const e = fixtures();
      e[0] = errored(e[0], since());
      run(e, [back, front]);
      await tick();
      assert.deepStrictEqual(played(s0), ['done', 'done', 'error']);
    } finally {
      tabState.active = null;
      back.close();
      front.close();
    }
  });
}

// ---------------------------------------------------------------------------
// package.json / package.nls.json
// ---------------------------------------------------------------------------

// The overview tree's menus apply to the side bar tree and its (hidden) copy in the bottom panel
const TREE_VIEWS = 'view =~ /^agentMonitor\\.(tree|panelOverview)$/';

// ---------------------------------------------------------------------------
// Remote push
// ---------------------------------------------------------------------------

const NTFY_TOPIC = 'am-synthetic0topic01';
const NTFY_TOKEN = 'tk_synthetic0push0token000';
const NTFY_URL = `https://ntfy.sh/${NTFY_TOPIC}`;
const ntfyConfig = (o = {}) => ({ channel: 'ntfy', key: 'ntfy', server: 'https://ntfy.sh', topic: NTFY_TOPIC, token: NTFY_TOKEN, dailyMax: 0, ...o });

/** Stores a channel the way the setup command does: secrets in SecretStorage; returns the settings half */
async function storeChannel(secrets, cfg) {
  const { settings, secrets: sec } = realPush.splitConfig(cfg);
  await secrets.store(realPushRt.secretKeyOf(cfg.key), JSON.stringify(sec));
  return settings;
}
// The session stops with an API error at sinceMs
function errored(s, sinceMs) {
  return { ...s, live: false, liveStatus: null, main: { ...s.main, status: st('apiError', sinceMs, { error: { kind: 'server_error', http: 500, message: 'synthetic' } }) } };
}
const claudeHit = (ms, resetsAtMs) => ({
  ...emptyQuotaSnapshot(),
  claude: { lastHit: { kind: 'session', model: null, resetsAtMs, resetsText: null, source: 'text', autoContinue: false, ms, sessionKey: null } },
});
// ntfy sends the title in X-Title, as RFC 2047 encoded words when it is not plain ASCII
function titleOf(call) {
  const h = String(call.init.headers['X-Title'] || '');
  if (!/=\?UTF-8\?B\?/.test(h)) return h;
  return h.split(' ').map((w) => Buffer.from(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(w)[1], 'base64').toString('utf8')).join('');
}
const pushSettle = () => sleep(80); // well past the 10 ms batch delay
const pushMarker = (dir, transitionId) => path.join(dir, realNotify.markerName(realPush.CLAIM_PREFIX + transitionId));
const outputHas = (text) => log.output.some((l) => l.endsWith(text));

async function pushTests() {
  let t = Date.now() - 60e3; // start of each new wait or error (unique, so every transition has its own id)
  const since = () => (t += 1000);
  let cfgKey = null;

  await test('push: off by default, and with no usable channel: needsYou, error and usage-limit events make no request, start no timer and claim nothing', async () => {
    const secrets = fakeSecrets();
    const entry = await storeChannel(secrets, ntfyConfig());
    const win = activateWindow('win-push-off', { 'network.allow': true, 'push.channels': [entry] }, { secrets }); // a channel, but push never turned on
    cfgKey = win.ctl.cfgKey();
    const n = net.calls.length;
    try {
      const round = async () => {
        win.send(fixtures(), { quota: emptyQuotaSnapshot() });
        const f = fixtures();
        const waitAt = since();
        const errAt = since();
        f[1] = waiting(f[1], waitAt);
        f[0] = errored(f[0], errAt);
        win.send(f, { quota: claudeHit(pushNow(), pushNow() + HOUR) });
        await sleep(150); // past the needsYou delay
        win.send(f, { quota: claudeHit(pushNow(), pushNow() + HOUR) });
        await pushSettle();
        assert.strictEqual(net.calls.length, n, 'a request went out');
        assert.deepStrictEqual([win.ctl.push._state().waits, win.ctl.push._state().flushTimer], [0, false], 'a push timer is running');
        assert.ok(!fs.existsSync(pushMarker(win.notifyDir, `error|${ALPHA}|main|${errAt}`)), 'the error was claimed');
        assert.ok(!fs.existsSync(pushMarker(win.notifyDir, `${BETA}|main|${waitAt}`)), 'the wait was claimed');
      };
      assert.strictEqual(pkg.contributes.configuration.properties['agentMonitor.push.enabled'].default, false);
      await round();
      // on, but no channel at all
      setConfig('push.channels', []);
      setConfig('push.enabled', true);
      await round();
      // on, with a channel whose secrets are not on this computer (e.g. settings synced from another machine)
      setConfig('push.channels', [{ ...entry, key: 'ntfy-elsewhere' }]);
      await round();
    } finally {
      win.close();
    }
  });

  await test('push setup: add ntfy from the QuickPick (privacy notice once, random topic, each field checked, the token before the topic); the secrets go to SecretStorage, never to settings; Copy topic, Send test, a failed test, turning off and choosing events', async () => {
    const win = activateWindow('win-push-setup', { 'network.allow': true });
    const run = () => registered.get('agentMonitor.push.setup')();
    const picks = [];
    const byAction = (a) => (items) => items.find((i) => i.action === a);
    const byChannel = (key) => (items) => items.find((i) => i.channel && i.channel.key === key);
    const privacy = [];
    const saved = [];
    const boxes = {};
    quickPickAnswer = (items) => { const f = picks.shift(); return f ? f(items) : undefined; };
    infoAnswer = (m, items) => {
      if (m === i18n.t('push.ui.privacy', { channel: 'ntfy' })) { privacy.push(items); return i18n.t('push.ui.turnOn'); }
      if (m === i18n.t('push.ui.savedNtfy', { channel: 'ntfy' })) {
        saved.push(items);
        return saved.length === 1 ? i18n.t('push.ui.copyTopic') : i18n.t('push.ui.testChannel');
      }
      return undefined;
    };
    inputAnswer = (o) => {
      const field = o.title.replace(/^ntfy: /, '');
      boxes[field] = o;
      if (field === i18n.t('push.field.topic')) return boxes.second ? o.value : NTFY_TOPIC;
      if (field === i18n.t('push.field.token')) return boxes.second ? '' : NTFY_TOKEN;
      if (field === i18n.t('push.field.dailyMax')) return boxes.second ? '3' : o.value;
      return o.value;
    };
    const n = net.calls.length;
    const qp = log.quickPicks.length;
    const inputs = log.inputs.length;
    try {
      picks.push(byAction('add'), (items) => items.find((i) => i.id === 'ntfy'));
      await run();
      assert.strictEqual(log.quickPicks[qp].o.title, 'Push notifications · Off · Channels in use: 0 · Network: allowed');
      assert.deepStrictEqual(log.inputs.slice(inputs).map((o) => o.title.replace(/^ntfy: /, '')),
        ['server', 'token', 'topic', 'dailyMax'].map((k) => i18n.t(`push.field.${k}`)), 'the token is asked before the topic');
      assert.strictEqual(privacy.length, 1, 'privacy notice');
      assert.strictEqual(privacy[0][0].modal, true, 'the privacy notice is modal');
      // the fields: server prefilled; the topic prefilled with a random one and shown (it goes into the ntfy app too); the token masked
      const server = boxes[i18n.t('push.field.server')];
      const topic = boxes[i18n.t('push.field.topic')];
      const token = boxes[i18n.t('push.field.token')];
      assert.strictEqual(server.value, 'https://ntfy.sh');
      assert.strictEqual(server.validateInput('http://example.com'), `${i18n.t('push.field.server')}: ${i18n.t('push.err.httpPublic')}`);
      assert.strictEqual(server.validateInput('https://ntfy.example.com'), null);
      assert.ok(/^am-[A-Za-z0-9_-]{16}$/.test(topic.value) && topic.password === false, topic.value);
      assert.strictEqual(topic.validateInput('alerts'), null, 'with an access token a short topic is fine');
      assert.strictEqual(topic.validateInput(''), i18n.t('push.err.required'));
      assert.strictEqual(token.password, true);
      assert.strictEqual(token.validateInput(''), null, 'the token is optional');
      // saved: settings hold only the non-secret half; SecretStorage the rest; the notice turned push on
      const settings = config['push.channels'].globalValue;
      const key1 = settings[0].key;
      assert.ok(/^ntfy-[A-Za-z0-9_-]{8}$/.test(key1), `a fresh random key: ${key1}`);
      assert.deepStrictEqual(settings, [{ channel: 'ntfy', key: key1, server: 'https://ntfy.sh', dailyMax: 0 }]);
      assert.ok(!JSON.stringify(config).includes(NTFY_TOPIC) && !JSON.stringify(config).includes(NTFY_TOKEN), 'a secret reached settings');
      assert.deepStrictEqual(JSON.parse(win.secrets.data.get(`agentMonitor.push.${key1}`)), { channel: 'ntfy', server: 'https://ntfy.sh', token: NTFY_TOKEN, topic: NTFY_TOPIC });
      assert.strictEqual(config['push.enabled'].globalValue, true);
      assert.deepStrictEqual(win.context.globalState.get('agentMonitor.push.privacyAck'), ['ntfy']);
      // the saved message says to subscribe and offers "Copy topic" (then comes back), then "Send a test message"
      assert.deepStrictEqual(saved, [[i18n.t('push.ui.copyTopic'), i18n.t('push.ui.testChannel')], [i18n.t('push.ui.testChannel')]]);
      assert.strictEqual(last(log.clipboard), NTFY_TOPIC);
      assert.strictEqual(net.calls.length, n + 1);
      assert.strictEqual(last(net.calls).url, NTFY_URL);
      assert.strictEqual(last(net.calls).init.headers.Authorization, `Bearer ${NTFY_TOKEN}`);
      assert.strictEqual(titleOf(last(net.calls)), i18n.t('push.msg.test.title'));
      assert.strictEqual(last(log.info), i18n.t('push.ui.testOkNtfy', { channel: 'ntfy' }));
      assert.ok(/subscribed/.test(last(log.info)), 'a test that ntfy accepts says to check the subscription');

      // a second ntfy channel: no notice this time; numbered; then removed with its secrets
      boxes.second = true;
      picks.push(byAction('add'), (items) => items.find((i) => i.id === 'ntfy'));
      await run();
      assert.ok(/12/.test(boxes[i18n.t('push.field.topic')].validateInput('alerts')), 'without a token a short topic is refused');
      assert.strictEqual(privacy.length, 1, 'the privacy notice came again');
      assert.strictEqual(log.quickPicks[log.quickPicks.length - 2].o.title, 'Push notifications · On · Channels in use: 1 · Network: allowed');
      const key2 = config['push.channels'].globalValue[1].key;
      assert.ok(/^ntfy-[A-Za-z0-9_-]{8}$/.test(key2) && key2 !== key1, key2);
      assert.deepStrictEqual(config['push.channels'].globalValue.map((e) => [e.key, e.dailyMax]), [[key1, 0], [key2, 3]]);
      assert.ok(win.secrets.data.has(`agentMonitor.push.${key2}`));
      warnAnswer = (m, items) => (m === i18n.t('push.ui.removeConfirm', { channel: 'ntfy 2' }) ? items[1] : undefined);
      picks.push(byChannel(key2), byAction('remove'));
      await run();
      assert.deepStrictEqual(config['push.channels'].globalValue.map((e) => e.key), [key1]);
      assert.ok(!win.secrets.data.has(`agentMonitor.push.${key2}`), 'its secrets were left behind');
      assert.strictEqual(last(log.info), i18n.t('push.ui.removed', { channel: 'ntfy 2' }));

      // a failed test: the described error, redacted
      net.answer = () => ({ status: 403, text: JSON.stringify({ error: `forbidden for ${NTFY_TOKEN}` }) });
      picks.push(byChannel(key1), byAction('test'));
      const errors = log.error.length;
      await run();
      assert.strictEqual(log.error.length, errors + 1);
      assert.ok(last(log.error).startsWith(i18n.t('push.ui.testFailed', { error: 'the server answered HTTP 403: forbidden for ' })), last(log.error));
      assert.ok(!last(log.error).includes(NTFY_TOKEN), 'the token was shown');
      net.answer = null;

      // turn push off (the menu comes back with the new state), then choose events
      picks.push(byAction('off'), byAction('events'), (items) => {
        assert.ok(items.every((i) => i.picked), 'every event is on by default');
        assert.deepStrictEqual(items.map((i) => i.label), realPush.EVENT_TYPES.map((e) => i18n.t(`push.event.${e}`)), 'threshold alerts can be chosen too');
        return items.filter((i) => i.type !== 'limitReset' && i.type !== 'costDaily');
      });
      const before = log.quickPicks.length;
      await run();
      assert.strictEqual(config['push.enabled'].globalValue, false);
      assert.strictEqual(log.quickPicks[before + 1].o.title, 'Push notifications · Off · Channels in use: 1 · Network: allowed');
      assert.strictEqual(log.quickPicks[before + 2].o.canPickMany, true);
      assert.deepStrictEqual(config['push.events'].globalValue, {
        needsYou: true, error: true, limitHit: true, limitReset: false, usageHigh: true, costDaily: false, contextHigh: true,
      });
    } finally {
      quickPickAnswer = null;
      infoAnswer = null;
      inputAnswer = null;
      warnAnswer = null;
      net.answer = null;
      win.close();
    }
  });

  await test('push setup: edit keeps a secret left empty and removes an optional one given "-"; test all skips channels turned off; unknown entries survive every write; "Turn on push" with no channel in use; cancelling goes back to the menu; a failed settings write is shown and the secret put back', async () => {
    const secrets = fakeSecrets();
    const TOPIC_B = 'am-synthetic0topic02';
    const a = await storeChannel(secrets, ntfyConfig({ key: 'ntfy-aaaaaaaa' }));
    const b = { ...(await storeChannel(secrets, ntfyConfig({ key: 'ntfy-bbbbbbbb', topic: TOPIC_B }))), enabled: false };
    const future = { channel: 'future-chat', key: 'future-1', room: 'synthetic' }; // a newer version's channel, synced here
    const win = activateWindow('win-push-setup-edit', { 'network.allow': true, 'push.channels': [a, future, b] }, { secrets });
    const run = () => registered.get('agentMonitor.push.setup')();
    const picks = [];
    const byAction = (x) => (items) => items.find((i) => i.action === x);
    const byChannel = (key) => (items) => items.find((i) => i.channel && i.channel.key === key);
    const answers = {};
    const boxes = {};
    quickPickAnswer = (items) => { const f = picks.shift(); return f ? f(items) : undefined; };
    inputAnswer = (o) => {
      const field = realPush.CHANNELS.ntfy.fields.map((f) => f.key).find((k) => o.title === `ntfy: ${i18n.t(`push.field.${k}`)}`);
      boxes[field] = o;
      return field in answers ? answers[field] : o.value;
    };
    const secretOf = (key) => JSON.parse(win.secrets.data.get(`agentMonitor.push.${key}`));
    const channels = () => config['push.channels'].globalValue;
    const getConfiguration = vscode.workspace.getConfiguration;
    try {
      // test all: only the channel in use; the one turned off is left alone
      let n = net.calls.length;
      picks.push(byAction('testAll'));
      await run();
      assert.deepStrictEqual(net.calls.slice(n).map((c) => c.url), [NTFY_URL]);
      assert.strictEqual(last(log.info), i18n.t('push.ui.testOkNtfy', { channel: 'ntfy 1' }));

      // edit, token left empty: kept
      picks.push(byChannel('ntfy-aaaaaaaa'), byAction('edit'));
      answers.token = '';
      await run();
      assert.strictEqual(boxes.token.placeHolder, i18n.t('push.ui.keepOrClearSecret', { clear: '-' }));
      assert.strictEqual(boxes.token.validateInput('-'), null);
      assert.strictEqual(boxes.topic.value, NTFY_TOPIC, 'the topic is shown, to be typed into the app');
      assert.strictEqual(secretOf('ntfy-aaaaaaaa').token, NTFY_TOKEN);
      // edit, token "-": removed; the topic is then checked without it
      picks.push(byChannel('ntfy-aaaaaaaa'), byAction('edit'));
      answers.token = '-';
      await run();
      assert.deepStrictEqual(secretOf('ntfy-aaaaaaaa'), { channel: 'ntfy', server: 'https://ntfy.sh', topic: NTFY_TOPIC });
      assert.ok(/12/.test(boxes.topic.validateInput('alerts')), 'a short topic without a token');
      assert.deepStrictEqual(channels(), [a, future, b], 'every write keeps the other entries, unknown ones included, in place');

      // the settings can't be written: the error is shown, and the secret is put back as it was
      const before = win.secrets.data.get('agentMonitor.push.ntfy-aaaaaaaa');
      vscode.workspace.getConfiguration = (section) => {
        const c = getConfiguration(section);
        return { ...c, update: async (k, v, t) => { if (k === 'push.channels') throw new Error('Unable to write into user settings (synthetic)'); return c.update(k, v, t); } };
      };
      picks.push(byChannel('ntfy-aaaaaaaa'), byAction('edit'));
      answers.token = 'tk_synthetic0other0token00';
      const errors = log.error.length;
      await run();
      vscode.workspace.getConfiguration = getConfiguration;
      assert.deepStrictEqual(log.error.slice(errors), [i18n.t('push.ui.setupFailed', { error: 'Unable to write into user settings (synthetic)' })]);
      assert.strictEqual(win.secrets.data.get('agentMonitor.push.ntfy-aaaaaaaa'), before);
      delete answers.token;

      // turn the other channel on: test all now lists both, joined the way the UI language lists things
      picks.push(byChannel('ntfy-bbbbbbbb'), byAction('resume'), byAction('testAll'));
      n = net.calls.length;
      await run();
      assert.strictEqual(net.calls.length, n + 2);
      assert.strictEqual(last(log.info), i18n.t('push.ui.testOkNtfy', { channel: 'ntfy 1 and ntfy 2' }));
      assert.deepStrictEqual(channels(), [a, future, { ...b, enabled: undefined }].map((e) => JSON.parse(JSON.stringify(e))));

      // both turned off, push off: "Turn on push" turns it on and says no channel is in use (no Add picker); the menu comes back
      picks.push(byChannel('ntfy-aaaaaaaa'), byAction('pause'), byChannel('ntfy-bbbbbbbb'), byAction('pause'), (items) => {
        const on = items.find((i) => i.action === 'on');
        assert.strictEqual(on.description, i18n.t('push.ui.noChannelInUse'));
        assert.ok(!items.some((i) => i.action === 'testAll'), 'test all with no channel in use');
        return on;
      }, (items) => { assert.ok(items.some((i) => i.action === 'off'), 'the menu came back, push on'); return undefined; });
      await run();
      assert.strictEqual(config['push.enabled'].globalValue, true);
      assert.ok(log.info.includes(i18n.t('push.ui.onNoChannel')));
      assert.deepStrictEqual(channels().map((e) => [e.key, e.enabled]), [['ntfy-aaaaaaaa', false], ['future-1', undefined], ['ntfy-bbbbbbbb', false]]);
      assert.strictEqual(picks.length, 0);

      // Add, then Escape at the service picker: back to the menu; needsYou with no delay reads "right away"
      setConfig('push.delaySeconds', 0);
      const qp = log.quickPicks.length;
      picks.push(byAction('add'), () => undefined, byAction('events'), (items) => {
        assert.strictEqual(items.find((i) => i.type === 'needsYou').description, i18n.t('push.ui.noDelay'));
        return undefined;
      });
      await run();
      assert.strictEqual(log.quickPicks.length - qp, 5, 'menu, service picker, menu again, events, menu again');
      assert.strictEqual(picks.length, 0);
    } finally {
      vscode.workspace.getConfiguration = getConfiguration;
      quickPickAnswer = null;
      inputAnswer = null;
      infoAnswer = null;
      win.close();
    }
  });

  await test('push: settings are read from user settings only: a workspace value can neither turn push on nor point a channel elsewhere', async () => {
    const secrets = fakeSecrets();
    const entry = await storeChannel(secrets, ntfyConfig());
    const win = activateWindow('win-push-ws', { 'network.allow': true, 'push.channels': [entry] }, { secrets });
    const n = net.calls.length;
    try {
      setConfig('push.enabled', true, ConfigurationTarget.Workspace);
      win.send(fixtures());
      const f = fixtures();
      f[0] = errored(f[0], since());
      win.send(f);
      await pushSettle();
      assert.strictEqual(net.calls.length, n, 'a workspace turned push on');
      // on in user settings; the workspace, and even a hand-edited user entry, name another server: the stored one is used
      setConfig('push.enabled', true);
      setConfig('push.channels', [{ ...entry, server: 'https://attacker.example' }], ConfigurationTarget.Workspace);
      config['push.channels'].globalValue = [{ ...entry, server: 'https://edited.example' }];
      win.send(fixtures());
      const g = fixtures();
      g[0] = errored(g[0], since());
      win.send(g);
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 1);
      assert.strictEqual(last(net.calls).url, NTFY_URL);
    } finally {
      win.close();
    }
  });

  await test('push: needsYou waits for the delay, asks for a rescan shortly before it and decides on the fresh data; a chat answered in time is not pushed', async () => {
    const secrets = fakeSecrets();
    const entry = await storeChannel(secrets, ntfyConfig());
    const win = activateWindow('win-push-wait', { 'network.allow': true, 'push.enabled': true, 'push.channels': [entry] }, { secrets });
    const refreshes = () => win.w().messages.filter((m) => m.type === 'refresh').length;
    try {
      win.send(fixtures());
      const n = net.calls.length;
      const r0 = refreshes();
      const f = fixtures();
      f[1] = waiting(f[1], since());
      win.send(f);
      await tick();
      assert.strictEqual(net.calls.length, n, 'pushed before the delay');
      assert.strictEqual(win.ctl.push._state().waits, 1);
      await sleep(100); // past the delay; nothing scanned since the rescan request
      assert.ok(refreshes() > r0, 'no rescan before the check');
      assert.strictEqual(net.calls.length, n, 'decided on the snapshot that showed the wait');
      win.send(f); // the rescan: still waiting
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 1);
      const call = last(net.calls);
      assert.strictEqual(titleOf(call), i18n.t('push.msg.needsYou.titleProject', { project: 'other' }));
      assert.strictEqual(call.init.body, i18n.t('push.msg.needsYou.body'));
      assert.ok(!JSON.stringify(call).includes('Beta chat'), 'the chat title went out without includeTitle');
      // answered before the delay is up: nothing
      win.send(fixtures());
      const g = fixtures();
      g[3] = waiting(g[3], since());
      win.send(g);
      await sleep(45); // the rescan has been asked for
      win.send(fixtures()); // and shows the chat answered
      await sleep(100);
      assert.strictEqual(net.calls.length, n + 1, 'an answered chat was pushed');
      assert.strictEqual(win.ctl.push._state().waits, 0);
    } finally {
      win.close();
    }
  });

  await test('push: an API error goes out right away (no delay), with the project and the state only; the chat title only with includeTitle', async () => {
    const secrets = fakeSecrets();
    const entry = await storeChannel(secrets, ntfyConfig());
    const win = activateWindow('win-push-error', { 'network.allow': true, 'push.enabled': true, 'push.channels': [entry] }, { secrets });
    try {
      win.send(fixtures());
      const n = net.calls.length;
      const f = fixtures();
      f[0] = errored(f[0], since());
      win.send(f);
      assert.strictEqual(win.ctl.push._state().waits, 0, 'an error does not wait');
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 1);
      assert.strictEqual(titleOf(last(net.calls)), i18n.t('push.msg.error.titleProject', { project: 'workspace' }));
      assert.strictEqual(last(net.calls).init.headers['X-Priority'], 'high');
      assert.ok(!JSON.stringify(last(net.calls)).includes('Alpha chat'));
      setConfig('push.includeTitle', true);
      win.send(fixtures());
      const g = fixtures();
      g[1] = errored(g[1], since());
      win.send(g);
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 2);
      assert.strictEqual(last(net.calls).init.body, i18n.t('push.msg.error.bodyTitle', { title: 'Beta chat' }));
      assert.ok(outputHas(i18n.t('push.log.sent', { channel: 'ntfy', n: 1 })), 'sends are logged');
    } finally {
      win.close();
    }
  });

  await test('push: a follower window (showing the leader\'s snapshots) pushes too, and its needsYou rescan is asked of the leader', async () => {
    const secrets = fakeSecrets();
    const entry = await storeChannel(secrets, ntfyConfig());
    const dir = path.join(TMP, 'win-push-follow', 'shared-scan');
    fs.mkdirSync(dir, { recursive: true });
    const leader = peerWindow(dir, cfgKey);
    let B = null;
    try {
      leader.inst.start();
      assert.ok(leader.inst.publish(snapshot(clone(fixtures()))));
      B = activateWindow('win-push-follow', { 'network.allow': true, 'push.enabled': true, 'push.channels': [entry] }, { secrets });
      assert.strictEqual(B.shared.inst.role, 'follower');
      const n = net.calls.length;
      const f = fixtures();
      f[0] = errored(f[0], since());
      assert.ok(leader.inst.publish(snapshot(clone(f))));
      B.shared.beat();
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 1, 'the follower did not push');
      const r0 = leader.refreshes;
      const g = fixtures();
      g[1] = waiting(g[1], since());
      assert.ok(leader.inst.publish(snapshot(clone(g))));
      B.shared.beat();
      await sleep(100);
      leader.beat();
      assert.ok(leader.refreshes > r0, 'the rescan did not reach the leader');
      assert.strictEqual(net.calls.length, n + 1);
      assert.ok(leader.inst.publish(snapshot(clone(g)), { force: true })); // the leader's rescan: still waiting
      B.shared.beat();
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 2);
      assert.strictEqual(titleOf(last(net.calls)), i18n.t('push.msg.needsYou.titleProject', { project: 'other' }));
    } finally {
      if (B) B.close();
      leader.inst.stop();
    }
  });

  await test('push: two windows see the same error; the claim in the shared dir lets exactly one of them send it', async () => {
    const secrets = fakeSecrets();
    const entry = await storeChannel(secrets, ntfyConfig());
    const win = activateWindow('win-push-a', { 'network.allow': true, 'push.enabled': true, 'push.channels': [entry] }, { secrets });
    const peerCalls = [];
    // the other window: its own runtime, the same user settings, SecretStorage and shared claim dir
    const peer = realPushRt.createPushRuntime({
      read: () => win.ctl.pushSettings(), secret: (k) => secrets.get(k), claimDir: () => win.notifyDir, i18n,
      clock: pushNow, timing: PUSH_TIMING,
      fetch: async (url, init) => { peerCalls.push({ url, init }); return { status: 200, text: async () => '' }; },
    });
    let seq = 0;
    const feedPeer = (sessions) => peer.update({ sessions, lamps: lampLib.computeLamps(sessions), quota: emptyQuotaSnapshot(), seq: ++seq });
    try {
      win.send(fixtures());
      feedPeer(fixtures());
      const n = net.calls.length;
      for (const who of ['peer first', 'window first']) {
        const f = fixtures();
        f[0] = errored(f[0], since());
        if (who === 'peer first') { feedPeer(clone(f)); win.send(f); } else { win.send(f); feedPeer(clone(f)); }
        await pushSettle();
        win.send(fixtures());
        feedPeer(fixtures());
      }
      assert.strictEqual(net.calls.length - n + peerCalls.length, 2, `window ${net.calls.length - n}, peer ${peerCalls.length}`);
    } finally {
      peer.dispose();
      win.close();
    }
  });

  await test('push: a channel\'s daily limit drops what is over it (logged) and says so once; a failing channel gets one warning after 3 failures in a row, not repeated until a send works', async () => {
    const secrets = fakeSecrets();
    const capped = await storeChannel(secrets, ntfyConfig({ key: 'ntfy-cap', topic: 'am-synthetic0capped01', dailyMax: 1 }));
    const win = activateWindow('win-push-limits', { 'network.allow': true, 'push.enabled': true, 'push.channels': [capped] }, { secrets });
    const error = async () => {
      const f = fixtures();
      f[0] = errored(f[0], since());
      win.send(f);
      await pushSettle();
      win.send(fixtures());
    };
    try {
      win.send(fixtures());
      const n = net.calls.length;
      const notices = () => log.info.filter((m) => m === i18n.t('push.ui.capped', { channel: 'ntfy' })).length;
      for (let i = 0; i < 3; i++) await error();
      assert.strictEqual(net.calls.length, n + 1, 'the daily limit did not hold');
      assert.strictEqual(notices(), 1);
      assert.ok(outputHas(i18n.t('push.log.dropped', { channel: 'ntfy', n: 1, reason: i18n.t('push.log.reason.daily') })));

      // failures: an HTTP error, a network error (its URL holds the topic), another HTTP error → one warning
      setConfig('push.channels', [await storeChannel(secrets, ntfyConfig())]);
      const warns = () => log.warn.filter((m) => m.startsWith('Push to ntfy failed: ')).length;
      let answers = [{ status: 500, text: 'synthetic outage' }, new Error(`connect ECONNREFUSED ${NTFY_URL}`), { status: 502, text: '' }];
      net.answer = () => answers.shift() || { status: 500, text: 'synthetic outage' };
      warnAnswer = (m, items) => items[0];
      const executed = log.executed.length;
      for (let i = 0; i < 4; i++) await error();
      assert.strictEqual(warns(), 1, 'warned once after three failures, not again after the fourth');
      assert.strictEqual(last(log.warn), i18n.t('push.ui.sendFailed', { channel: 'ntfy', error: i18n.t('push.err.http', { status: 502 }) }));
      await tick();
      assert.ok(log.executed.slice(executed).some((x) => x[0] === 'agentMonitor.push.setup'), '"Open push setup" did not open it');
      assert.ok(!log.output.some((l) => l.includes(NTFY_TOPIC) || l.includes(NTFY_TOKEN)), 'a secret reached the output');
      // a good send clears it; three new failures warn again
      net.answer = null;
      await error();
      answers = [];
      net.answer = () => ({ status: 500, text: 'synthetic outage' });
      for (let i = 0; i < 3; i++) await error();
      assert.strictEqual(warns(), 2);
    } finally {
      net.answer = null;
      warnAnswer = null;
      win.close();
    }
  });

  await test('push: closing the window drops a pending needsYou; nothing is sent afterwards', async () => {
    const secrets = fakeSecrets();
    const entry = await storeChannel(secrets, ntfyConfig());
    const win = activateWindow('win-push-close', { 'network.allow': true, 'push.enabled': true, 'push.channels': [entry] }, { secrets });
    win.send(fixtures());
    const n = net.calls.length;
    const f = fixtures();
    f[1] = waiting(f[1], since());
    win.send(f);
    const rt = win.ctl.push;
    assert.strictEqual(rt._state().waits, 1);
    win.close();
    assert.deepStrictEqual([rt._state().waits, rt._state().flushTimer], [0, false]);
    await sleep(150);
    assert.strictEqual(net.calls.length, n);
  });

  // last: moves the push clock ahead
  await test('push: usage limits: limitHit when a new hit shows up, limitReset once its reset time has passed', async () => {
    const secrets = fakeSecrets();
    const entry = await storeChannel(secrets, ntfyConfig());
    const win = activateWindow('win-push-limit', { 'network.allow': true, 'push.enabled': true, 'push.channels': [entry] }, { secrets });
    try {
      win.send(fixtures(), { quota: emptyQuotaSnapshot() }); // seeds
      const n = net.calls.length;
      const hitAt = pushNow();
      const resetAt = hitAt + 5 * MIN;
      win.send(fixtures(), { quota: claudeHit(hitAt, resetAt) });
      await pushSettle();
      win.send(fixtures(), { quota: claudeHit(hitAt, resetAt) });
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 1);
      assert.strictEqual(titleOf(last(net.calls)), i18n.t('push.msg.limitHit.title', { provider: 'Claude Code' }));
      assert.ok(last(net.calls).init.body.startsWith('Resets '), last(net.calls).init.body);
      pushClock.offset += 10 * MIN;
      win.send(fixtures(), { quota: claudeHit(hitAt, resetAt) });
      await pushSettle();
      win.send(fixtures(), { quota: claudeHit(hitAt, resetAt) });
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 2);
      assert.strictEqual(titleOf(last(net.calls)), i18n.t('push.msg.limitReset.title', { provider: 'Claude Code' }));
    } finally {
      win.close();
    }
  });

  await test('push: quiet hours hold a usage-limit hit; with allowErrors it goes out (like its error sound), while its reset stays held', async () => {
    const secrets = fakeSecrets();
    const entry = await storeChannel(secrets, ntfyConfig());
    const settings = { 'network.allow': true, 'push.enabled': true, 'push.channels': [entry], ...quietNow() };
    const win = activateWindow('win-push-quiet-limit', settings, { secrets });
    const offset = pushClock.offset;
    try {
      win.send(fixtures(), { quota: emptyQuotaSnapshot() }); // seeds
      const n = net.calls.length;
      const hit1 = pushNow();
      win.send(fixtures(), { quota: claudeHit(hit1, hit1 + 5 * MIN) });
      await pushSettle();
      assert.strictEqual(net.calls.length, n, 'a usage limit pushed during quiet hours');
      setConfig('quietHours.allowErrors', true);
      const hit2 = hit1 + 1000;
      const reset2 = hit2 + HOUR;
      win.send(fixtures(), { quota: claudeHit(hit2, reset2) });
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 1, 'allowErrors held a usage limit');
      assert.strictEqual(titleOf(last(net.calls)), i18n.t('push.msg.limitHit.title', { provider: 'Claude Code' }));
      // the reset is good news, not an error
      pushClock.offset += HOUR + MIN;
      win.send(fixtures(), { quota: claudeHit(hit2, reset2) });
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 1, 'a limit reset pushed during quiet hours');
    } finally {
      pushClock.offset = offset; // later tests date their events by the real clock
      win.close();
    }
  });

  await test('push: a threshold alert (usage %) goes out at once, once across windows, at normal priority; quiet hours hold push without claiming it; allowErrors lets errors through', async () => {
    const secrets = fakeSecrets();
    const entry = await storeChannel(secrets, ntfyConfig());
    const settings = { 'network.allow': true, 'push.enabled': true, 'push.delaySeconds': 600, 'push.channels': [entry] };
    const A = activateWindow('win-push-alert-a', settings, { secrets });
    const B = activateWindow('win-push-alert-b', settings, { secrets });
    const both = (list, extra) => { A.send(list, extra); B.send(list, extra); };
    try {
      const resetAt = Date.now() + 6 * HOUR;
      both(fixtures(), { quota: codexQuota(30, resetAt) });
      const n = net.calls.length;
      both(fixtures(), { quota: codexQuota(91, resetAt) });
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 1, 'sent twice or not at all');
      const call = last(net.calls);
      assert.strictEqual(titleOf(call), usageTitle(91));
      assert.deepStrictEqual([call.init.headers['X-Priority'], call.init.headers['X-Tags']], ['default', 'bar_chart']);
      // quiet hours: an error is neither pushed nor claimed
      applyConfig(quietNow());
      const errAt = since();
      const f = fixtures();
      f[0] = errored(f[0], errAt);
      both(fixtures());
      both(f);
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 1, 'pushed during quiet hours');
      assert.ok(!fs.existsSync(pushMarker(A.notifyDir, `error|${ALPHA}|main|${errAt}`)), 'a muted push was claimed');
      // allowErrors: errors get through, other events stay muted
      setConfig('quietHours.allowErrors', true);
      const err2 = since();
      const g = fixtures();
      g[0] = errored(g[0], err2);
      both(fixtures(), { quota: codexQuota(10, resetAt + 5 * HOUR) });
      both(g, { quota: codexQuota(97, resetAt + 5 * HOUR) });
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 2);
      assert.strictEqual(titleOf(last(net.calls)), i18n.t('push.msg.error.titleProject', { project: 'workspace' }));
    } finally {
      A.close();
      B.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Network access switch (agentMonitor.network.allow, lib/network.js)
// ---------------------------------------------------------------------------

async function networkTests() {
  const network = require(path.join(ROOT, 'lib', 'network'));
  const run = () => registered.get('agentMonitor.push.setup')();
  const byAction = (a) => (items) => items.find((i) => i.action === a);
  const byChannel = (key) => (items) => items.find((i) => i.channel && i.channel.key === key);
  const ASK = i18n.t('push.net.askTitle');
  const ALLOW = i18n.t('push.net.allow');
  const CTX = 'agentMonitor.networkAllowed';
  let t = Date.now() - 30e3;
  const since = () => (t += 1000);
  const reset = () => { quickPickAnswer = null; infoAnswer = null; inputAnswer = null; warnAnswer = null; net.answer = null; };

  await test('network: off by default; read from user settings only (a workspace value is ignored, only an exact true counts); the context key and the gate follow it at once; off again once the extension stops', async () => {
    const win = activateWindow('win-net-default');
    try {
      assert.strictEqual(pkg.contributes.configuration.properties['agentMonitor.network.allow'].default, false);
      assert.strictEqual(network.isAllowed(), false);
      assert.strictEqual(log.contexts[CTX], false);
      setConfig('network.allow', true, ConfigurationTarget.Workspace);
      assert.strictEqual(win.ctl.networkAllowed(), false, 'a workspace turned the network on');
      assert.strictEqual(network.isAllowed(), false);
      assert.strictEqual(log.contexts[CTX], false);
      setConfig('network.allow', true);
      assert.strictEqual(network.isAllowed(), true);
      assert.strictEqual(log.contexts[CTX], true);
      config['network.allow'].globalValue = 'true'; // hand-edited settings.json: not a boolean
      assert.strictEqual(network.isAllowed(), false);
      config['network.allow'].globalValue = true;
    } finally {
      win.close();
    }
    assert.strictEqual(network.isAllowed(), false, 'the switch outlived the extension');
  });

  await test('network off: zero requests on every path while push is on with a channel set up (errors, waits, usage limits, Send a test message, test all, turning push on, adding a channel); each action asks first and a dismissed modal changes nothing', async () => {
    const secrets = fakeSecrets();
    const entry = await storeChannel(secrets, ntfyConfig());
    const win = activateWindow('win-net-off', { 'push.enabled': true, 'push.channels': [entry] }, { secrets });
    setConfig('network.allow', true, ConfigurationTarget.Workspace); // ignored
    const n = net.calls.length;
    const asks = [];
    const picks = [];
    quickPickAnswer = (items) => { const f = picks.shift(); return f ? f(items) : undefined; };
    infoAnswer = (m, items) => { if (m === ASK) asks.push(items); return undefined; }; // dismissed
    const inputs = log.inputs.length;
    const infos = log.info.length;
    try {
      // events: an error, a wait past its delay and a usage limit
      win.send(fixtures(), { quota: emptyQuotaSnapshot() });
      const f = fixtures();
      f[0] = errored(f[0], since());
      f[1] = waiting(f[1], since());
      win.send(f, { quota: claudeHit(pushNow(), pushNow() + HOUR) });
      await sleep(150);
      win.send(f, { quota: claudeHit(pushNow(), pushNow() + HOUR) });
      await pushSettle();
      assert.deepStrictEqual([win.ctl.push._state().waits, win.ctl.push._state().flushTimer], [0, false], 'a push timer is running');
      // the setup: paused, network off; test all, a channel's test, push off then on, add: each asks, dismissed
      const qp = log.quickPicks.length;
      picks.push(byAction('testAll'));
      await run();
      assert.strictEqual(log.quickPicks[qp].o.title, 'Push notifications · Paused · Channels in use: 1 · Network: off');
      const netItem = log.quickPicks[qp].items.find((i) => i.action === 'netAllow');
      assert.ok(netItem && netItem.label.endsWith(ALLOW) && netItem.description === i18n.t('push.net.pausedHint'), JSON.stringify(netItem));
      picks.push(byChannel('ntfy'), byAction('test'));
      await run();
      picks.push(byAction('off'), byAction('on'), () => undefined);
      await run();
      picks.push(byAction('add'), (items) => items.find((i) => i.id === 'ntfy'), () => undefined);
      await run();
      assert.strictEqual(picks.length, 0);
      const r = await win.ctl.push.test('ntfy');
      assert.strictEqual(r.code, 'networkOff');
      assert.strictEqual(net.calls.length, n, 'a request went out');
      // four modals, each saying what would go where, with one button
      assert.strictEqual(asks.length, 4);
      for (const a of asks) assert.ok(a[0].modal === true && a.length === 2 && a[1] === ALLOW && a[0].detail.endsWith(i18n.t('push.net.askDetail')), JSON.stringify(a));
      assert.ok(asks[0][0].detail.startsWith(i18n.t('push.net.test', { channel: 'ntfy' })));
      assert.ok(asks[1][0].detail.startsWith(i18n.t('push.net.test', { channel: 'ntfy' })));
      assert.ok(asks[2][0].detail.startsWith(i18n.t('push.net.sends', { channel: 'ntfy' })));
      assert.ok(asks[3][0].detail.startsWith(i18n.t('push.net.sends', { channel: 'ntfy' })));
      // nothing changed: the switch never written, push stays off (turned off above), no channel added, no field asked
      assert.ok(!log.updates.some((u) => u[0] === 'network.allow'), 'the switch was written');
      assert.strictEqual(config['push.enabled'].globalValue, false);
      assert.strictEqual(config['push.channels'].globalValue.length, 1);
      assert.strictEqual(log.inputs.length, inputs);
      assert.ok(!log.info.slice(infos).includes(i18n.t('push.ui.privacy', { channel: 'ntfy' })), 'the privacy notice came as well');
    } finally {
      reset();
      win.close();
    }
  });

  await test('network: only "Allow network access" in the modal turns the switch on (in user settings), then the test goes out; adding a channel shows one modal instead of the privacy notice; "Turn on push" asks too', async () => {
    const secrets = fakeSecrets();
    const entry = await storeChannel(secrets, ntfyConfig());
    const win = activateWindow('win-net-allow', { 'push.channels': [entry] }, { secrets });
    const asks = [];
    const picks = [];
    const saved = [];
    quickPickAnswer = (items) => { const f = picks.shift(); return f ? f(items) : undefined; };
    infoAnswer = (m, items) => {
      if (m === ASK) { asks.push(items); return ALLOW; }
      if (m === i18n.t('push.ui.savedNtfy', { channel: 'ntfy 2' })) saved.push(items);
      return undefined;
    };
    inputAnswer = (o) => o.value; // the prefilled server, a random topic, the default daily limit; no token
    const n = net.calls.length;
    const infos = log.info.length;
    try {
      picks.push(byChannel('ntfy'), byAction('test'));
      await run();
      assert.strictEqual(asks.length, 1);
      assert.deepStrictEqual(log.updates.filter((u) => u[0] === 'network.allow'), [['network.allow', true, ConfigurationTarget.Global]]);
      assert.strictEqual(network.isAllowed(), true);
      assert.strictEqual(log.contexts[CTX], true);
      assert.strictEqual(net.calls.length, n + 1, 'the test did not go out after allowing');
      assert.strictEqual(last(log.info), i18n.t('push.ui.testOkNtfy', { channel: 'ntfy' }));
      assert.strictEqual(config['push.enabled'], undefined, 'push was turned on');
      // allowed: no more modal; "Block network access" from the menu, which comes back with "Allow network access"
      picks.push(byChannel('ntfy'), byAction('test'));
      await run();
      assert.strictEqual(asks.length, 1);
      assert.strictEqual(net.calls.length, n + 2);
      const qp = log.quickPicks.length;
      picks.push(byAction('netBlock'), () => undefined);
      await run();
      assert.strictEqual(log.quickPicks[qp].o.title, 'Push notifications · Off · Channels in use: 1 · Network: allowed');
      assert.strictEqual(log.quickPicks[qp + 1].o.title, 'Push notifications · Off · Channels in use: 1 · Network: off');
      assert.ok(log.quickPicks[qp + 1].items.some((i) => i.action === 'netAllow') && !log.quickPicks[qp + 1].items.some((i) => i.action === 'netBlock'));
      assert.strictEqual(config['network.allow'].globalValue, false);
      // add a channel with the network off: one modal (not the privacy notice), the switch on, the notice counted as read
      picks.push(byAction('add'), (items) => items.find((i) => i.id === 'ntfy'));
      await run();
      assert.strictEqual(asks.length, 2);
      assert.ok(asks[1][0].detail.startsWith(i18n.t('push.net.sends', { channel: 'ntfy' })));
      assert.ok(!log.info.slice(infos).includes(i18n.t('push.ui.privacy', { channel: 'ntfy' })), 'the privacy notice came as well');
      assert.strictEqual(config['network.allow'].globalValue, true);
      assert.strictEqual(config['push.channels'].globalValue.length, 2);
      assert.deepStrictEqual(win.context.globalState.get('agentMonitor.push.privacyAck'), ['ntfy']);
      assert.strictEqual(config['push.enabled'], undefined, 'allowing the network turned push on');
      assert.ok(saved.length === 1 && saved[0].includes(i18n.t('push.ui.turnOn')), 'the saved message offers to turn push on');
      // "Turn on push" with the network off: asks; allowed, push goes on
      setConfig('network.allow', false);
      picks.push(byAction('on'), () => undefined);
      await run();
      assert.strictEqual(asks.length, 3);
      assert.ok(asks[2][0].detail.startsWith(i18n.t('push.net.sends', { channel: 'ntfy 1 and ntfy 2' })), asks[2][0].detail);
      assert.deepStrictEqual([config['network.allow'].globalValue, config['push.enabled'].globalValue], [true, true]);
    } finally {
      reset();
      win.close();
    }
  });

  await test('network: Allow / Block / Toggle commands write user settings and set the context key; blocking keeps push on (shown as paused) and says so; a failed write is shown', async () => {
    const win = activateWindow('win-net-cmd', { 'push.enabled': true });
    const getConfiguration = vscode.workspace.getConfiguration;
    try {
      assert.strictEqual(log.contexts[CTX], false);
      await registered.get('agentMonitor.network.toggle')();
      assert.deepStrictEqual(last(log.updates), ['network.allow', true, ConfigurationTarget.Global]);
      assert.strictEqual(log.contexts[CTX], true);
      assert.strictEqual(last(log.info), i18n.t('push.net.allowed'));
      await registered.get('agentMonitor.network.block')();
      assert.deepStrictEqual([config['network.allow'].globalValue, log.contexts[CTX]], [false, false]);
      assert.strictEqual(config['push.enabled'].globalValue, true, 'push was turned off');
      assert.strictEqual(last(log.info), i18n.t('push.net.blockedPaused'));
      await registered.get('agentMonitor.network.allow')();
      assert.deepStrictEqual([config['network.allow'].globalValue, log.contexts[CTX]], [true, true]);
      await registered.get('agentMonitor.network.toggle')();
      assert.deepStrictEqual([config['network.allow'].globalValue, log.contexts[CTX]], [false, false]);
      // the setup shows push paused while the network is off, and on once it is allowed
      const qp = log.quickPicks.length;
      quickPickAnswer = () => undefined;
      await run();
      setConfig('network.allow', true);
      await run();
      assert.strictEqual(log.quickPicks[qp].o.title, 'Push notifications · Paused · Channels in use: 0 · Network: off');
      assert.strictEqual(log.quickPicks[qp + 1].o.title, 'Push notifications · On · Channels in use: 0 · Network: allowed');
      assert.ok(log.quickPicks[qp + 1].items.some((i) => i.action === 'netBlock'));
      setConfig('push.enabled', false);
      await registered.get('agentMonitor.network.block')();
      assert.strictEqual(last(log.info), i18n.t('push.net.blocked'));
      // settings.json can't be written: the error is shown and the switch stays as it was
      vscode.workspace.getConfiguration = (section) => {
        const c = getConfiguration(section);
        return { ...c, update: async () => { throw new Error('Unable to write into user settings (synthetic)'); } };
      };
      const errors = log.error.length;
      await registered.get('agentMonitor.network.allow')();
      assert.deepStrictEqual(log.error.slice(errors), [i18n.t('push.net.failed', { error: 'Unable to write into user settings (synthetic)' })]);
      assert.deepStrictEqual([config['network.allow'].globalValue, log.contexts[CTX]], [false, false]);
    } finally {
      vscode.workspace.getConfiguration = getConfiguration;
      reset();
      win.close();
    }
  });

  await test('network: turning it off drops a pending push; turning it on again does not send what happened while it was off', async () => {
    const secrets = fakeSecrets();
    const entry = await storeChannel(secrets, ntfyConfig());
    const win = activateWindow('win-net-flip', { 'network.allow': true, 'push.enabled': true, 'push.channels': [entry] }, { secrets });
    try {
      win.send(fixtures());
      const n = net.calls.length;
      const f = fixtures();
      f[1] = waiting(f[1], since());
      win.send(f);
      assert.strictEqual(win.ctl.push._state().waits, 1);
      setConfig('network.allow', false);
      assert.strictEqual(win.ctl.push._state().waits, 0, 'the pending wait survived');
      const g = fixtures();
      g[0] = errored(g[0], since());
      win.send(g);
      await sleep(150);
      win.send(g);
      setConfig('network.allow', true);
      win.send(g);
      await pushSettle();
      assert.strictEqual(net.calls.length, n, 'an event from while the network was off went out');
      win.send(fixtures());
      const h = fixtures();
      h[3] = errored(h[3], since());
      win.send(h);
      await pushSettle();
      assert.strictEqual(net.calls.length, n + 1);
    } finally {
      win.close();
    }
  });

  await test('network strings: every push.net.* key and push.err.networkOff in all five languages with the same placeholders and translated; the command titles and the setting description too', () => {
    const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const src = ['lib/push-setup.js', 'extension.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    const used = new Set([...src.matchAll(/'(push\.net\.[\w.]*\w)'/g)].map((m) => m[1]));
    used.add('push.err.networkOff');
    for (const k of ['allow', 'block', 'askTitle', 'askDetail', 'sends', 'test', 'allowed', 'blocked', 'blockedPaused', 'failed', 'stateAllowed', 'stateOff', 'statePaused']) {
      assert.ok(used.has(`push.net.${k}`), `not used: push.net.${k}`);
    }
    const en = read('l10n/push.en.json');
    const ph = (x) => [...String(x).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const nlsKeys = ['cmd.network.allow', 'cmd.network.block', 'cmd.network.toggle', 'config.network.allow'];
    for (const loc of ['zh-cn', 'zh-tw', 'ko', 'ja']) {
      const d = read(`l10n/push.${loc}.json`);
      for (const k of [...used, 'push.ui.menuTitle']) {
        assert.ok(typeof d[k] === 'string' && d[k].trim() && typeof en[k] === 'string', `${loc}: ${k}`);
        assert.strictEqual(ph(d[k]), ph(en[k]), `${loc}: placeholders of ${k}`);
        assert.notStrictEqual(d[k], en[k], `${loc}: ${k} is not translated`);
      }
      const n = read(`package.nls.${loc}.json`);
      for (const k of nlsKeys) assert.ok(typeof n[k] === 'string' && n[k].trim() && n[k] !== nls[k], `package.nls.${loc}: ${k}`);
      assert.ok(n['config.network.allow'].includes('#agentMonitor.push.enabled#'), `package.nls.${loc}: the setting links to push`);
    }
    assert.ok(en['push.ui.menuTitle'].includes('{network}'));
  });
}

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
    assert.strictEqual(pkg.version, '0.5.0');
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
    const banned = /claude|anthropic|codex|openai|copilot|github|gemini|google|qwen|alibaba/i;
    for (const s of [pkg.name, nls.displayName, pkg.icon, ...pkg.keywords]) assert.ok(!banned.test(s), `third-party name found: ${s}`);
    assert.ok(/Unofficial; not affiliated with Anthropic, OpenAI, GitHub, Google or Alibaba Cloud\./.test(nls.description), nls.description);
    assert.ok(/session logs/.test(nls.description) && /Claude Code/.test(nls.description) && /Codex/.test(nls.description));
    for (const name of ['Copilot', 'Gemini CLI', 'Qwen Code']) assert.ok(nls.description.includes(name), name);
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

  await test('views and containers: the bottom panel shows a single webview view (title merged into the panel tab, like the terminal) plus a hidden badge-carrying tree; the sidebar has the overview tree', () => {
    for (const v of views.values()) assert.ok(containers.has(v.container), `container ${v.container} not declared`);
    assert.deepStrictEqual(c.views.agentMonitor.map((v) => v.id), ['agentMonitor.agents', 'agentMonitor.panelOverview']);
    assert.deepStrictEqual(c.views.agentMonitor.filter((v) => v.visibility !== 'hidden').map((v) => v.id), ['agentMonitor.agents'], 'bottom panel shows a single view by default');
    assert.strictEqual(views.get('agentMonitor.panelOverview').type, undefined, 'the badge carrier must be a tree view (created at activation)');
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
      compact: '$(screen-normal)', handoff: '$(export)', setAutoCompact: '$(settings)', storage: '$(database)', history: '$(graph)',
      'push.setup': '$(bell)', 'network.allow': '$(globe)', 'network.block': '$(circle-slash)', 'network.toggle': undefined,
      goToChat: '$(link-external)',
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
      assert.ok(m.when.includes(TREE_VIEWS) && m.when.includes('viewItem =~ /\\bsession\\b/'), id + ': ' + m.when);
      const re = /viewItem =~ \/(.+?)\//.exec(m.when);
      const rx = new RegExp(re[1].replace(/\\\\/g, '\\'));
      assert.ok(rx.test(fmt.sessionContextValue(fixtures()[1], 'doneSeen')), 'session node matches');
      assert.ok(!rx.test('agent') && !rx.test('mainAgent') && !rx.test('workflow') && !rx.test('group'), 'agent, workflow and group header nodes do not match');
    }
    // context menu group order: session actions (compact, handoff, auto-compact, resume, seen) → open (transcript, reveal, copy path)
    const order = ctxMenu.filter((m) => !m.group.startsWith('inline')).map((m) => m.group + ' ' + m.command.replace('agentMonitor.', ''));
    assert.deepStrictEqual(order[0], '0_goto@1 goToChat', 'Go to Chat comes first');
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

  await test('bottom panel title bar: scope switch, hide completed, mark all seen and refresh are buttons; storage, usage history, push notifications, network access and settings are in the … overflow menu', () => {
    const items = c.menus['view/title'].filter((m) => /view == agentMonitor\.agents\b/.test(m.when));
    const nav = items.filter((m) => m.group.startsWith('navigation')).map((m) => `${m.group} ${m.command || m.submenu}`);
    assert.deepStrictEqual(nav, [
      'navigation@1 agentMonitor.scopeMenu.all', 'navigation@1 agentMonitor.scopeMenu.workspace',
      'navigation@2 agentMonitor.hideCompleted', 'navigation@2 agentMonitor.showCompleted',
      'navigation@3 agentMonitor.markAllSeen', 'navigation@4 agentMonitor.refresh',
    ]);
    const overflow = items.filter((m) => !m.group.startsWith('navigation')).map((m) => m.command);
    assert.deepStrictEqual(overflow, ['agentMonitor.storage', 'agentMonitor.history', 'agentMonitor.push.setup', 'agentMonitor.network.allow', 'agentMonitor.network.block', 'agentMonitor.openSettings']);
    assert.strictEqual(items.find((m) => m.command === 'agentMonitor.history').group, '8_storage@2', 'next to storage');
    // the two scope submenus are mutually exclusive; the icon reflects the current scope
    const scope = items.filter((m) => m.submenu);
    assert.ok(scope[0].when.includes("config.agentMonitor.scope != 'workspace'") && scope[1].when.includes("config.agentMonitor.scope == 'workspace'"));
  });

  await test('webview context menu: when = webviewId + webviewSection + compactable / resumable / handoff / autoCompact; evaluated against the data-vscode-context of the row', () => {
    const menu = c.menus['webview/context'];
    assert.ok(Array.isArray(menu) && menu.length === 9);
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
    const cc = { handoff: true, autoCompact: true };
    assert.deepStrictEqual(shown(row({ compactable: true, resumable: false, ...cc })),
      ['goToChat', 'compact', 'handoff', 'setAutoCompact', 'markSeen', 'openTranscript', 'revealTranscript', 'copyTranscriptPath']);
    assert.deepStrictEqual(shown(row({ compactable: false, resumable: true, ...cc })),
      ['goToChat', 'handoff', 'setAutoCompact', 'copyResume', 'markSeen', 'openTranscript', 'revealTranscript', 'copyTranscriptPath']);
    // Copilot / Gemini CLI / Qwen Code rows: no handoff note and no auto-compact setting (Go to Chat is always there and says why when it can't)
    assert.deepStrictEqual(shown(row({ compactable: false, resumable: false, handoff: false, autoCompact: false })),
      ['goToChat', 'markSeen', 'openTranscript', 'revealTranscript', 'copyTranscriptPath']);
    assert.deepStrictEqual(shown({}), [], 'no session menu in the content area (no webviewSection)');
    assert.deepStrictEqual(menu.filter((m) => evalWhen(m.when, { webviewId: 'other.view', webviewSection: 'session', compactable: true })), [], 'not shown in other webviews');
    // group order: session actions → open
    assert.deepStrictEqual(menu.map((m) => m.group), ['0_goto@1', '1_session@1', '1_session@2', '1_session@3', '1_session@4', '1_session@5', '2_open@1', '2_open@2', '2_open@3']);
  });

  await test('menus: compact is in the overview tree context menu (viewItem =~ /\\bcompactable\\b/) and the webview context menu (compactable); only declared commands, views and settings are referenced', () => {
    const tree = c.menus['view/item/context'].filter((m) => m.command === 'agentMonitor.compact');
    assert.ok(tree.some((m) => !m.group.startsWith('inline') && m.when.includes(TREE_VIEWS) && m.when.includes('viewItem =~ /\\bcompactable\\b/')));
    assert.ok(c.menus['webview/context'].some((m) => m.command === 'agentMonitor.compact' && / && compactable$/.test(m.when)));
    const contextValues = ['session', 'provider-claude', 'lamp-doneUnseen', 'resumable', 'compactable', 'goTo', 'agent', 'mainAgent', 'workflow'];
    for (const [menu, items] of Object.entries(c.menus)) {
      if (menu !== 'commandPalette' && !menu.startsWith('view/') && !menu.startsWith('webview/')) assert.ok(submenus.has(menu), `undeclared submenu ${menu}`);
      for (const it of items) {
        if (it.command) assert.ok(commands.has(it.command), `${menu} references undeclared command ${it.command}`);
        if (it.submenu) assert.ok(submenus.has(it.submenu), `undeclared submenu ${it.submenu}`);
        const when = it.when || '';
        for (const m of when.matchAll(/\bview == ([\w.]+)/g)) assert.ok(views.has(m[1]), `unknown view ${m[1]}`);
        for (const m of when.matchAll(/\bview =~ \/(.+?)\/(?:\s|$)/g)) {
          const re = new RegExp(m[1]);
          assert.ok([...views.keys()].some((v) => re.test(v)) && !re.test('agentMonitor.agents'), `view regex matches no tree view: ${m[1]}`);
        }
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
    // handoff / setAutoCompact in the tree: Claude Code and Codex sessions only
    for (const cmd of ['agentMonitor.handoff', 'agentMonitor.setAutoCompact']) {
      const it = c.menus['view/item/context'].find((m) => m.command === cmd);
      const clauses = [...it.when.matchAll(/viewItem =~ \/(.+?)\/(?:\s|$)/g)].map((m) => new RegExp(m[1].replace(/\\\\/g, '\\')));
      const ok = (provider) => clauses.every((r) => r.test(fmt.sessionContextValue({ ...fixtures()[0], provider }, 'idle')));
      assert.ok(ok('claude') && ok('codex'), cmd);
      for (const p of ['copilot', 'gemini', 'qwen']) assert.ok(!ok(p), cmd + ' hidden for ' + p);
    }
  });

  await test('Command Palette: commands that need a node argument are hidden; compact / handoff / setAutoCompact / storage / usage history / push setup are available', () => {
    // network.toggle is for key bindings: the palette shows Allow / Block Network Access, whichever applies
    const hidden = c.menus.commandPalette.filter((x) => x.when === 'false' && x.command !== 'agentMonitor.network.toggle').map((x) => x.command);
    assert.deepStrictEqual(hidden.sort(), ['openTranscript', 'revealTranscript', 'copyTranscriptPath', 'markSeen', 'copyResume'].map((x) => 'agentMonitor.' + x).sort());
    assert.strictEqual(nls['cmd.history'], 'Show Usage History');
    for (const id of ['compact', 'handoff', 'setAutoCompact', 'storage', 'history', 'push.setup', 'goToChat']) {
      assert.ok(!c.menus.commandPalette.some((x) => x.command === 'agentMonitor.' + id), id + ' should be visible in the Command Palette');
    }
  });

  await test('network access: one user-only switch (application scope, restricted, not synced, off); Allow / Block swap on the agentMonitor.networkAllowed context key in the palette and the … menu; Toggle is for key bindings', () => {
    const p = c.configuration.properties['agentMonitor.network.allow'];
    assert.deepStrictEqual([p.type, p.default, p.scope], ['boolean', false, 'application']);
    assert.strictEqual(p.ignoreSync, true, 'allowing it on one machine must not allow it on others through Settings Sync');
    assert.ok(pkg.capabilities.untrustedWorkspaces.restrictedConfigurations.includes('agentMonitor.network.allow'));
    assert.ok(/\*\*Off by default\*\*/.test(nls['config.network.allow']) && nls['config.network.allow'].includes('#agentMonitor.push.enabled#'));
    assert.ok(nls['config.push.enabled'].includes('#agentMonitor.network.allow#'), 'push says it needs the switch');
    assert.ok(/unless you allow network access \(off by default\)/.test(nls.description), nls.description);
    const titles = Object.fromEntries(c.commands.filter((x) => x.command.startsWith('agentMonitor.network.')).map((x) => [x.command, nls[x.title.slice(1, -1)]]));
    assert.deepStrictEqual(titles, {
      'agentMonitor.network.allow': 'Allow Network Access', 'agentMonitor.network.block': 'Block Network Access', 'agentMonitor.network.toggle': 'Toggle Network Access',
    });
    const when = (menu, cmd) => c.menus[menu].filter((m) => m.command === cmd).map((m) => m.when);
    assert.deepStrictEqual(when('commandPalette', 'agentMonitor.network.allow'), ['!agentMonitor.networkAllowed']);
    assert.deepStrictEqual(when('commandPalette', 'agentMonitor.network.block'), ['agentMonitor.networkAllowed']);
    assert.deepStrictEqual(when('commandPalette', 'agentMonitor.network.toggle'), ['false']);
    assert.deepStrictEqual(when('view/title', 'agentMonitor.network.allow'), ['view == agentMonitor.agents && !agentMonitor.networkAllowed']);
    assert.deepStrictEqual(when('view/title', 'agentMonitor.network.block'), ['view == agentMonitor.agents && agentMonitor.networkAllowed']);
    const ext = fs.readFileSync(EXT_FILE, 'utf8');
    for (const id of ['allow', 'block', 'toggle']) assert.ok(ext.includes(`cmd('agentMonitor.network.${id}'`), `${id} is not registered`);
    assert.ok('agentMonitor.networkAllowed' in log.contexts, 'the context key is never set');
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
      'copilot.enabled': ['boolean', true], 'gemini.enabled': ['boolean', true], 'gemini.home': ['string', ''],
      'qwen.enabled': ['boolean', true], 'qwen.home': ['string', ''],
      compactConfirm: ['boolean', true], compactTemplate: ['string', ''],
      contextHintStart: ['number', 200000], contextHintAct: ['number', 500000],
      sessionListPosition: ['string', 'auto'],
      cacheReminder: ['boolean', true], cacheReminderMinutes: ['number', 8], cacheReminderMinContext: ['number', 150000],
      cacheReminderShortTtl: ['boolean', false], closeReminder: ['boolean', true], postCompactHint: ['boolean', true],
      onlyWorkspace: ['boolean', false],
      notifyNeedsYou: ['boolean', true], backgroundRefreshSeconds: ['number', 5], shareScanAcrossWindows: ['boolean', true],
      'push.enabled': ['boolean', false],
      'push.events': ['object', { needsYou: true, error: true, limitHit: true, limitReset: true, usageHigh: true, costDaily: true, contextHigh: true }],
      'push.delaySeconds': ['number', 30], 'push.includeTitle': ['boolean', false], 'push.channels': ['array', []],
      'network.allow': ['boolean', false],
      'sound.enabled': ['boolean', false], 'sound.needsYou': ['string', 'default'], 'sound.error': ['string', 'default'],
      'sound.done': ['string', 'default'], 'sound.alert': ['string', 'default'],
      'quietHours.enabled': ['boolean', false], 'quietHours.start': ['string', '22:00'], 'quietHours.end': ['string', '08:00'],
      'quietHours.days': ['array', []], 'quietHours.allowErrors': ['boolean', false],
      'alerts.usagePercent': ['number', 90], 'alerts.dailyCost': ['number', 0], 'alerts.contextPercent': ['number', 0],
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
    for (const k of ['claude.cliPath', 'claude.projectsDir', 'codex.home', 'gemini.home', 'qwen.home']) {
      assert.strictEqual(props['agentMonitor.' + k].scope, 'machine', k);
      assert.ok(pkg.capabilities.untrustedWorkspaces.restrictedConfigurations.includes('agentMonitor.' + k), `${k} is not restricted`);
    }
    // the shared scan and the background interval concern every window on this machine, so they are user settings too
    for (const k of ['backgroundRefreshSeconds', 'shareScanAcrossWindows']) assert.strictEqual(props['agentMonitor.' + k].scope, 'machine', k);
    // notifications keep the default (window) scope: a window with them off simply never claims, and a machine setting would
    // neither sync nor apply from user settings in remote windows
    assert.strictEqual(props['agentMonitor.notifyNeedsYou'].scope, undefined);
    // sounds, quiet hours and threshold alerts: window scope too (a workspace can only make them quieter or louder in
    // its own window; nothing leaves the computer through them), and their values match lib/alerts.js
    for (const k of Object.keys(want).filter((x) => /^(sound|quietHours|alerts)\./.test(x))) assert.strictEqual(props['agentMonitor.' + k].scope, undefined, k);
    for (const e of realAlerts.SOUND_EVENTS) assert.deepStrictEqual(props['agentMonitor.sound.' + e].enum, realAlerts.SOUND_CHOICES.slice(), e);
    assert.deepStrictEqual(props['agentMonitor.quietHours.days'].items.enum, realAlerts.DAY_NAMES.slice());
    for (const k of ['start', 'end']) {
      const p = props['agentMonitor.quietHours.' + k];
      const re = new RegExp(p.pattern);
      for (const v of ['22:00', '8:00', '07:30', '23:59', '00:00']) assert.ok(re.test(v) && realAlerts.parseHm(v) != null, `${k} ${v}`);
      for (const v of ['24:00', '7', '7:5', 'noon', '']) assert.ok(!re.test(v) && realAlerts.parseHm(v) == null, `${k} ${v}`);
      assert.strictEqual(p.default, realAlerts.parseHm(p.default) != null ? p.default : null);
    }
    assert.deepStrictEqual({ usagePercent: props['agentMonitor.alerts.usagePercent'].default, dailyCost: props['agentMonitor.alerts.dailyCost'].default,
      contextPercent: props['agentMonitor.alerts.contextPercent'].default }, { ...realAlerts.DEFAULT_THRESHOLDS });
    for (const k of ['sound.enabled', 'quietHours.enabled']) assert.ok(nls[props['agentMonitor.' + k].markdownDescription.slice(1, -1)].length > 40, k);
    assert.deepStrictEqual([props['agentMonitor.backgroundRefreshSeconds'].minimum, props['agentMonitor.backgroundRefreshSeconds'].maximum], [2, 60]);
    assert.ok(nls['config.backgroundRefreshSeconds'].includes('#agentMonitor.refreshSeconds#'), 'description links to refreshSeconds');
    // push: application scope (a workspace can never turn it on or redirect it) and restricted in untrusted workspaces;
    // the events render as checkboxes; the delay matches lib/push.js' default and stays within 0–600 s
    const restricted = pkg.capabilities.untrustedWorkspaces.restrictedConfigurations;
    for (const k of Object.keys(want).filter((x) => x.startsWith('push.') || x.startsWith('network.'))) {
      assert.strictEqual(props['agentMonitor.' + k].scope, 'application', k);
      assert.ok(restricted.includes('agentMonitor.' + k), `${k} is not restricted`);
    }
    const ev = props['agentMonitor.push.events'];
    assert.deepStrictEqual(Object.keys(ev.properties), realPush.EVENT_TYPES.slice());
    assert.ok(Object.values(ev.properties).every((p) => p.type === 'boolean' && p.default === true) && ev.additionalProperties === false);
    assert.deepStrictEqual([props['agentMonitor.push.delaySeconds'].minimum, props['agentMonitor.push.delaySeconds'].maximum], [0, 600]);
    assert.strictEqual(props['agentMonitor.push.delaySeconds'].default, realPush.DEFAULT_DELAY_SECONDS);
    assert.ok(nls['config.push.channels'].includes('(command:agentMonitor.push.setup)'), 'the channel list points to the setup command');
    const orders = Object.values(props).map((p) => p.order);
    assert.strictEqual(new Set(orders).size, orders.length, 'every setting has its own order');
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
    for (const f of ['extension.js', 'lib/agents-view.js', 'lib/tree.js', 'lib/push-runtime.js', 'lib/push-setup.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/).map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
      const hit = src.split(/\r?\n/).find((l) => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(l));
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

  await test('push setup and runtime: every push.* / ext.* string they use exists in all five languages, with the same placeholders', () => {
    const settingKeys = new Set(['push.enabled', 'push.events', 'push.delaySeconds', 'push.includeTitle', 'push.channels']);
    const used = new Set(['push.log.reason.hourly', 'push.log.reason.daily', 'push.log.reason.stale']); // built from the drop reason
    for (const e of realPush.EVENT_TYPES) used.add(`push.event.${e}`);
    for (const f of ['lib/push-setup.js', 'lib/push-runtime.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of src.matchAll(/'((?:push|ext)\.[a-zA-Z][\w.]*\w)'/g)) if (!settingKeys.has(m[1])) used.add(m[1]);
    }
    const ext = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
    for (const m of ext.matchAll(/\bt\('((?:push|ext)\.[\w.]*\w)'/g)) used.add(m[1]);
    assert.ok(used.size >= 50, `only ${used.size} keys found`);
    const dict = (loc) => ({
      ...JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', `views.${loc}.json`), 'utf8')),
      ...JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', `push.${loc}.json`), 'utf8')),
    });
    const en = dict('en');
    const ph = (x) => [...String(x).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const loc of ['en', 'zh-cn', 'zh-tw', 'ko', 'ja']) {
      const d = dict(loc);
      for (const k of used) {
        assert.ok(typeof d[k] === 'string' && d[k].trim(), `${loc}: missing ${k}`);
        assert.strictEqual(ph(d[k]), ph(en[k]), `${loc}: placeholders of ${k}`);
      }
    }
  });

  await test('.vscodeignore excludes test/ from the package', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignore.includes('test/**'));
  });
}

// ---------------------------------------------------------------------------
// Copilot, Gemini CLI, Qwen Code: settings → worker config, Copilot's user dir, workspace scope
// ---------------------------------------------------------------------------

async function providerTests() {
  const { vscodeUserDir } = require(EXT_FILE)._internal;

  await test('provider settings: Copilot user dir from global storage (profiles too), else null; Gemini / Qwen homes from the settings (~ expanded) or the defaults', () => {
    const U = path.join(TMP, 'Code', 'User');
    const id = 'cyuneo.cyuneo-agent-monitor';
    assert.strictEqual(vscodeUserDir(Uri.file(path.join(U, 'globalStorage', id))), U);
    assert.strictEqual(vscodeUserDir(Uri.file(path.join(U, 'profiles', '5f3a', 'globalStorage', id))), U, 'a profile\'s storage maps to the same User dir');
    for (const bad of [Uri.file(path.join(TMP, 'elsewhere', id)), mkUri('vscode-remote', path.join(U, 'globalStorage', id)), undefined, null, {}]) {
      assert.strictEqual(vscodeUserDir(bad), null, JSON.stringify(bad));
    }
    const name = path.join('Code', 'User', 'globalStorage', id);
    const win = activateWindow(name, { 'gemini.home': '~/gem-home', 'qwen.enabled': false, 'qwen.home': '/data/qwen' });
    try {
      const cfg = win.worker.opts.workerData;
      assert.deepStrictEqual(cfg.copilot, { enabled: true, userDir: U });
      assert.deepStrictEqual(cfg.gemini, { enabled: true, home: path.join(os.homedir(), 'gem-home'), homeSource: 'setting' });
      assert.deepStrictEqual(cfg.qwen, { enabled: false, home: '/data/qwen', homeSource: 'setting' });
    } finally {
      win.close();
    }
  });

  await test('provider settings: each change rebuilds the worker config (and the shared-scan key); other windows with other dirs do not share a scan', () => {
    const win = activateWindow('win-providers');
    try {
      const w = win.w();
      const key0 = win.ctl.cfgKey();
      const cases = [['copilot.enabled', false, (c) => c.copilot.enabled === false], ['gemini.enabled', false, (c) => c.gemini.enabled === false],
        ['gemini.home', '/g/home', (c) => c.gemini.home === '/g/home'], ['qwen.enabled', false, (c) => c.qwen.enabled === false],
        ['qwen.home', '/q/home', (c) => c.qwen.home === '/q/home' && c.qwen.homeSource === 'setting']];
      for (const [k, v, ok] of cases) {
        const n = w.messages.length;
        setConfig(k, v);
        const msgs = w.messages.slice(n).filter((m) => m.type === 'config');
        assert.strictEqual(msgs.length, 1, `${k}: no config message`);
        assert.ok(ok(msgs[0].cfg), `${k}: ${JSON.stringify(msgs[0].cfg)}`);
      }
      assert.notStrictEqual(win.ctl.cfgKey(), key0, 'windows with other provider settings must not share one scan');
    } finally {
      win.close();
    }
  });

  await test('workspace scope: a Copilot chat belongs to the window whose workspace storage holds it, or by cwd; Gemini / Qwen by cwd', () => {
    const U = path.join(TMP, 'Code', 'User');
    const here = path.join(U, 'workspaceStorage', 'aaa111');
    const win = activateWindow('win-provider-scope', { scope: 'workspace' }, { storageUri: Uri.file(path.join(here, 'cyuneo.cyuneo-agent-monitor')) });
    try {
      assert.strictEqual(win.ctl.ws().storageDir, here);
      const mk = (provider, id, o) => session({ provider, id, cwd: '/nowhere', projectDir: null, ...o });
      const list = [
        mk('copilot', 'cp-here', { transcript: path.join(here, 'chatSessions', 'cp-here.jsonl'), copilot: { storage: 'workspace', workspaceFile: null } }),
        mk('copilot', 'cp-other', { transcript: path.join(U, 'workspaceStorage', 'bbb222', 'chatSessions', 'cp-other.jsonl'), copilot: { storage: 'workspace', workspaceFile: null } }),
        mk('copilot', 'cp-cwd', { cwd: WS, transcript: path.join(U, 'workspaceStorage', 'ccc333', 'chatSessions', 'cp-cwd.jsonl'), copilot: { storage: 'workspace', workspaceFile: null } }),
        mk('copilot', 'cp-empty', { transcript: path.join(U, 'globalStorage', 'emptyWindowChatSessions', 'cp-empty.jsonl'), copilot: { storage: 'emptyWindow', workspaceFile: null } }),
        mk('gemini', 'gm-here', { cwd: path.join(WS, 'pkg') }),
        mk('qwen', 'qw-other', { cwd: '/elsewhere' }),
      ];
      win.send(list);
      assert.deepStrictEqual(win.ctl.scoped.map((s) => s.id).sort(), ['cp-cwd', 'cp-here', 'gm-here']);
    } finally {
      win.close();
    }
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
  for (const [title, fn] of [['"Needs you" notifications', notifyTests], ['Shared scan across windows', sharedScanTests], ['Shared scan: robustness', sharedScanRobustnessTests], ['Go to Chat', jumpTests], ['Background slowdown', backgroundTests], ['Usage history', historyTests], ['Threshold alerts, sounds and quiet hours', alertTests], ['Remote push', pushTests], ['Network access', networkTests], ['Copilot, Gemini CLI, Qwen Code', providerTests]]) {
    console.log(`\n${title}`);
    try {
      await fn();
    } catch (err) {
      results.push(false);
      console.log(`  FAIL  (${title} aborted)`, err && err.stack);
    }
  }
  console.log('\npackage.json');
  await manifestTests();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  if (realExecs) { results.push(false); console.log(`  FAIL  ${realExecs} command(s) reached the real child_process.execFile`); }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
