'use strict';
// VS Code entry point: wires the modules together.
// - The bottom panel works like the terminal panel: a single webview view agentMonitor.agents (lib/agents-view.js),
//   with a session list on one side (like the terminal tab list) and the selected session's agents in the other part.
//   The list's side follows the terminal tab list's position (configurable); its width is draggable and saved in
//   globalState. The extension owns the selection and pushes it to the page; clicking a session shows it in the
//   content area, and the selection sticks until the user clicks another one (or switches to another chat tab, followActiveChat).
// - Sidebar overview tree agentMonitor.tree (lib/tree.js); overall lamp in the status bar; two viewing scopes (all / workspace).
// - Scanning runs on a worker thread (lib/worker.js; messages: config / focus / refresh / storage / history / pause / resume / interval).
// - Windows share one scan (lib/shared-scan.js, agentMonitor.shareScanAcrossWindows): the leader window's worker scans and
//   publishes its snapshots, the other windows (followers) keep their worker paused and render the leader's snapshots.
//   While no VS Code window has focus, the scanning worker slows to agentMonitor.backgroundRefreshSeconds.
// - "Needs you" notifications (lib/notify.js, agentMonitor.notifyNeedsYou): a toast in the focused window (not for the
//   chat the user is looking at), or a system notification when no window has focus (Windows and remote windows: a toast
//   in the window that gets focus next); a claim file makes sure only one window reports each wait.
// - Threshold alerts, sounds and quiet hours (lib/alerts.js): after each render a threshold tracker gets all sessions,
//   the quota snapshot and today's totals (agentMonitor.alerts.*); each crossing is claimed once across windows and shown
//   like "needs you". Sounds (agentMonitor.sound.*, off by default) go with the needs-you notification and the alerts,
//   and play for errors and for finished work (notify.createLampEventTracker); each is claimed once ('sound|' + id).
//   Quiet hours (agentMonitor.quietHours.*) mute sounds, system notifications (then the message waits for the window
//   that gets focus next) and push; the status bar tooltip says while they are on.
// - Remote push (lib/push.js, lib/push-runtime.js, setup in lib/push-setup.js; off by default): after each render the
//   push runtime gets all sessions, the quota snapshot and the threshold alerts; it claims each event in the same shared
//   claim dir, so one window sends it whatever its role in the shared scan. agentMonitor.push.* settings are read from
//   user settings only.
// - Network access (lib/network.js, agentMonitor.network.allow, off by default, user settings only): every request goes
//   through network.request(), which reads the switch here at call time; while it is off the extension makes no network
//   request at all. The commands agentMonitor.network.allow / .block (swapped by the context key
//   agentMonitor.networkAllowed) and agentMonitor.network.toggle change it.
// - lib/compact.js registers the compact command agentMonitor.compact itself; here we only call activateCompact on
//   activation and forward every snapshot to it. The handoff-note command agentMonitor.handoff is registered here and
//   calls runHandoff exported by compact.js.
// - lib/autocompact.js registers the auto-compact capacity command agentMonitor.setAutoCompact itself.
// - Storage locations and usage: agentMonitor.storage opens the page in lib/storage-view.js; the scan runs in the worker.
// - Usage history: agentMonitor.history opens the page in lib/history-view.js; the page asks the worker ({ type: 'history' })
//   and gets its replies through onHistory. A follower window asks its own (paused) worker, which answers history anyway.
// - Observed compaction points: whenever a snapshot shows a new auto-compaction, record it in globalState under
//   "model|window" and pass it to the worker with the next config.
// - Go to Chat (agentMonitor.goToChat, lib/jump.js): brings up the chat panel, editor tab or terminal a session runs in.
//   This window's extension-host pid, terminal shell pids, folders and workspace storage go into its shared-scan record; a
//   session owned by another window becomes a jump request that window performs, raising itself and replying
//   (onJumpRequest). Selecting a tab of Terminal.app / iTerm2 asks once per app first (confirmAutomation).
// All UI text goes through lib/i18n.js + lib/format.js; no sentences in any language are built here.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { createI18n } = require('./lib/i18n');
const S = require('./lib/core/status');
const fmt = require('./lib/format');
const lampLib = require('./lib/lamp');
const seenLib = require('./lib/seen');
const scopeLib = require('./lib/scope');
const { createSessionOrder } = require('./lib/order');
const { AgentTreeProvider, esc } = require('./lib/tree');
const notifyLib = require('./lib/notify');
const alertsLib = require('./lib/alerts');
const sharedScanLib = require('./lib/shared-scan');
const jumpLib = require('./lib/jump');
const network = require('./lib/network');

const PKG = require('./package.json');
const VERSION = PKG.version;
const EXT_ID = 'cyuneo.cyuneo-agent-monitor';
const AGENTS_VIEW = 'agentMonitor.agents';
const TREE_VIEW = 'agentMonitor.tree';
// Hidden overview tree in the bottom panel. Tree views exist from activation (webview views only after first shown),
// so its badge is what puts the count on the panel tab even before the panel has been opened.
const PANEL_TREE_VIEW = 'agentMonitor.panelOverview';
const INTRO_KEY = 'agentMonitor.panelIntro.v1';     // globalState: the bottom panel was focused on first activation
const LIST_WIDTH_KEY = 'agentMonitor.sessionListWidth';   // globalState: width of the session list in the bottom panel
const OBSERVED_KEY = 'agentMonitor.observedCompact';       // globalState: { 'model|window': observed auto-compaction point }
const OBSERVED_AT_KEY = 'agentMonitor.observedCompactAt';  // globalState: { 'model|window': time of that compaction }, so only newer observations replace older ones
const COMPACT_CMD = 'agentMonitor.compact';
const AUTOCOMPACT_CMD = 'agentMonitor.setAutoCompact';
const HANDOFF_CMD = 'agentMonitor.handoff';
const STORAGE_CMD = 'agentMonitor.storage';
const HISTORY_CMD = 'agentMonitor.history';
const HISTORY_FILE = 'usage-history.jsonl'; // under globalStorageUri: the worker's usage-history cache
const PUSH_CMD = 'agentMonitor.push.setup';
const GOTO_CMD = 'agentMonitor.goToChat';
const AUTOMATION_KEY = 'agentMonitor.jump.automation'; // globalState: { [terminal app id]: true } once the user agreed to AppleScript
const HOST_PID_WAIT_MS = 10000; // presence: how long to wait for a new terminal's shell pid
// Push settings (application scope, read with inspect().globalValue so a workspace can neither turn push on nor redirect it)
const PUSH_KEYS = ['push.enabled', 'push.events', 'push.delaySeconds', 'push.includeTitle', 'push.channels'];
// The network switch (application scope, read the same way): off, lib/network.js refuses every request
const NETWORK_KEY = 'network.allow';
const STORAGE_WAIT_MS = 120000; // the storage scan stats recursively; large dirs can take tens of seconds
// Settings that require rebuilding the worker; other settings just recompute from the last snapshot on the main thread
const MONITOR_KEYS = [
  'refreshSeconds', 'activeWindowMinutes', 'staleMinutes',
  'claude.enabled', 'claude.projectsDir', 'codex.enabled', 'codex.home',
  'copilot.enabled', 'gemini.enabled', 'gemini.home', 'qwen.enabled', 'qwen.home',
  'approvalGuess', 'approvalGuessSeconds',
];
const NOTIFY_DIR = 'notify';           // under globalStorageUri: claim markers, so one window reports each wait
const SHARED_DIR = 'shared-scan';      // under globalStorageUri: leader election and the leader's snapshots
const BACKGROUND_SECONDS = Object.freeze({ dflt: 5, min: 2, max: 60 }); // agentMonitor.backgroundRefreshSeconds
const WORKER_RETRIES = 3;
const WORKER_HEALTHY_MS = 10 * 60e3; // a worker that still sends snapshots this long after starting gets its retry budget back
// "Needs you" in an unfocused window: rescan this long before the claim delay is up, so the check sees current data; if no
// newer snapshot has arrived by then, the check waits for one, at most NOTIFY_FRESH_WAIT_MS more
const NOTIFY_RESCAN_LEAD_MS = 1200;
const NOTIFY_FRESH_WAIT_MS = 10000;
// Sounds are claimed under their own ids in the notify claim dir, so one window plays each event
const SOUND_CLAIM_PREFIX = 'sound|';
// Threshold alerts kept for the window that gets focus next (no system notification here, or quiet hours): at most this
// many, and dropped when older than ALERT_DEFERRED_MAX_MS (or, for a usage window, once it has reset)
const ALERT_DEFERRED_MAX = 20;
const ALERT_DEFERRED_MAX_MS = 12 * 3600e3;
// Memory limits for the worker thread: parsing transcripts creates almost only short-lived temporary objects, so capping
// the young generation at 6MB keeps the heap from ballooning during scans without slowing them down; the 512MB old
// generation is only a safety net (normal use is far below it); if exceeded, V8 terminates the thread and it is
// restarted up to WORKER_RETRIES times
const WORKER_LIMITS = Object.freeze({ maxYoungGenerationSizeMb: 6, maxOldGenerationSizeMb: 512 });
const REFRESH_WAIT_MS = 10000;
const noop = () => {};
// Signature of the live Claude sessions (compact.js confirms a closed window from these)
const liveSig = (sessions) => (Array.isArray(sessions) ? sessions : [])
  .filter((s) => s && s.provider === 'claude' && s.live).map((s) => String(s.key)).sort().join('\n');

let ctl = null;

function activate(context) {
  ctl = new Controller(context);
  ctl.activate();
}

function deactivate() {
  if (ctl) ctl.shutdown();
}

// ---------------------------------------------------------------------------

class Controller {
  constructor(context) {
    this.context = context;
    this.i18n = createI18n(vscode.env.language);
    this.output = null;
    this.worker = null;
    this.last = null;            // latest snapshot message (v2)
    this.byKey = new Map();      // all sessions (not scope-filtered) key -> Session
    this.scoped = [];            // sessions in the current scope
    this.lamps = null;           // result of computeLamps (scoped)
    this.sessionOrder = createSessionOrder(); // session list order (locked once assigned, never jumps)
    this.arranged = null;        // last arranged sessions (groups + order)
    this.leftKeys = [];          // session list keys in display order
    this.selectedKey = null;     // selected session in the list (clicked by the user or auto-selected by the rules); owned by the extension, pushed to the page
    this.shownKey = null;        // session currently shown in the content area
    this.listWidth = null;       // session list width (globalState; sent back by the page after dragging)
    this.cmdTitles = null;       // command titles (package.nls; used by the "..." QuickPick, matching the context menu)
    this.focusSig = null;
    this.waiters = [];
    this.compactApi = null;
    this.compactMod = null;
    this.storageWaiters = [];    // requestStorage callers waiting for the worker's storage message
    this.storageForce = false;
    this.observed = {};          // observed compaction points (kept in sync with globalState)
    this.observedAt = {};
    this.agentsView = null;
    this.agentsMod = null;
    this.chrome = { contexts: {}, sBadge: null, tBadge: null, sDesc: null, tDesc: null, barSig: null };
    this.tabTypes = { TabInputWebview: vscode.TabInputWebview, TabInputCustom: vscode.TabInputCustom };
    this.shared = null;          // lib/shared-scan.js while windows share one scan; null = this window scans alone
    this.sharedErr = null;       // last shared-scan error logged (the same one is not logged again)
    this.replayTimer = null;     // follower: re-runs the last snapshot while the leader has nothing new to publish
    this.intervalMs = null;      // background slowdown sent to the worker ({ type: 'interval' }); null = refreshSeconds
    this.workerRetries = 0;      // automatic restarts of the worker since it was last started on purpose
    this.workerStartedAt = 0;
    this.cfgGen = 0;             // bumped when a setting changes what is scanned; the worker echoes it in its snapshots
    this.pubLive = null;         // leader: liveSig of the last published snapshot
    this.echoNext = false;       // leader: publish the next snapshot even if unchanged (see publishShared)
    this.dataSeq = 0;            // real snapshots rendered (replays not counted)
    this.revealKeys = new Set(); // sessions shown although outside the scope, after "Show" in a notification
    this.needsYou = notifyLib.createNeedsYouTracker(); // fed all sessions, not just this window's scope
    this.notifyReseed = false;   // the next snapshot built with the current settings seeds a new tracker
    this.needsLamps = null;      // lamps of all sessions (key -> sessionLamps) from the last render
    this.notifyPending = new Map(); // key -> transitionId waiting CLAIM_DELAY_MS in an unfocused window
    this.notifyAwaiting = new Map(); // key -> item whose check waits for a snapshot newer than the one that showed it
    this.notifyDeferred = new Map(); // key -> item: no system notification here; shown when a window gets focus
    this.notifyTimers = new Set();
    this.thresholds = alertsLib.createThresholdTracker(); // usage %, today's cost, context (fed all sessions)
    this.lampEvents = notifyLib.createLampEventTracker(); // errors and finished work, for their sounds
    this.alertDeferred = new Map(); // transitionId -> { ev, at }: shown when a window gets focus
    this.historyReq = null;      // last history request of an open page ({ type: 'history', days?, force? }); resent to a new worker
    this.historyListeners = new Set(); // onHistory listeners (the history page)
    this.push = null;            // lib/push-runtime.js (null when it failed to load)
    this.jumper = null;          // lib/jump.js createJumper (Go to Chat)
    this.jumping = new Set();    // session keys whose jump is being worked out
    this.hostInfo = null;        // presence fields in this window's shared-scan record (hostFields)
    this.hostSeq = 0;
    this.stopped = false;
  }

  t(key, vars) { return this.i18n.t(key, vars); }

  cfg() { return vscode.workspace.getConfiguration('agentMonitor'); }

  log(line) {
    try { this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`); } catch { /* output channel already closed */ }
  }

  guard(what, fn) {
    try { return fn(); } catch (err) {
      this.log(this.t('ext.log.failed', { what, error: errText(err) }));
      return undefined;
    }
  }

  // ---------- Activation ----------

  activate() {
    const context = this.context;
    const sub = (...d) => context.subscriptions.push(...d);
    this.output = vscode.window.createOutputChannel(this.t('bar.title'));
    sub(this.output);

    // The network switch, read at the time of each request; back to off when the extension stops
    this.releaseNetwork = network.setAllowed(() => this.networkAllowed());
    this.setContext('networkAllowed', this.networkAllowed());

    // Seen state: globalState, pruned once on activation
    this.seen = seenLib.createSeenStore(context.globalState);
    Promise.resolve(this.seen.prune()).catch(noop);
    this.dwell = seenLib.createDwellTracker(this.seen, { onMarked: () => this.render() });
    sub({ dispose: () => this.dwell.dispose() });

    this.migrateScope();
    this.loadObserved();
    this.listWidth = this.loadListWidth();

    // Sidebar overview
    this.overview = new AgentTreeProvider({ i18n: this.i18n, hideCompleted: this.cfg().get('hideCompleted', false) });
    this.treeView = vscode.window.createTreeView(TREE_VIEW, { treeDataProvider: this.overview, showCollapseAll: true });
    sub(this.overview, this.treeView);
    this.panelTree = vscode.window.createTreeView(PANEL_TREE_VIEW, { treeDataProvider: this.overview, showCollapseAll: true });
    sub(this.panelTree);

    // Bottom panel: session list + agents (one webview)
    this.setupAgentsView();

    // Status-bar overall lamp
    this.statusItem = vscode.window.createStatusBarItem('agentMonitor.status', vscode.StatusBarAlignment.Left, 50);
    this.statusItem.name = this.t('bar.title');
    this.statusItem.command = 'agentMonitor.show';
    sub(this.statusItem);

    // Follow the current conversation: the selection moves only on tab-switch events
    this.follower = scopeLib.createChatFollower({ types: this.tabTypes });

    this.registerCommands();
    this.setupJump();
    this.setupCompact();
    this.setupAutoCompact();
    this.setupStorage();
    this.setupHistory();
    this.setupPush();
    this.listen();

    this.updateChrome();
    this.updateAgents(Date.now());
    this.introFocus();
    // With a shared scan the worker starts paused and resumes once this window leads (or scans alone)
    this.shared = this.createShared();
    this.startWorker();
    this.startShared();
    this.updateInterval();
    sub({ dispose: () => this.shutdown() });
  }

  // Deactivation: leave the shared scan first (another window takes over at once), then stop the worker
  shutdown() {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.notifyTimers) clearTimeout(timer);
    this.notifyTimers.clear();
    if (this.push) this.guard('push', () => this.push.dispose());
    if (this.releaseNetwork) this.releaseNetwork();
    this.stopShared();
    this.stopWorker();
  }

  setupAgentsView() {
    let Provider = null;
    try {
      const mod = require('./lib/agents-view');
      this.agentsMod = mod || null;
      Provider = mod && (mod.AgentsViewProvider || mod.default);
    } catch (err) {
      this.log(this.t('ext.log.moduleFailed', { module: 'agents-view', error: errText(err) }));
    }
    if (typeof Provider === 'function') {
      try {
        this.agentsView = new Provider(this.context, {
          i18n: this.i18n,
          version: VERSION,
          log: (line) => this.log(line),
          onDidChangeVisibility: () => this.updateViewDwell(),
          onSelect: (key) => this.guard('select', () => this.userSelect(key)),
          onResizeList: (width) => this.guard('resizeList', () => this.setListWidth(width)),
          onMore: (key) => { Promise.resolve(this.sessionMenu(key)).catch((err) => this.log(this.t('ext.log.failed', { what: 'sessionMenu', error: errText(err) }))); },
        });
      } catch (err) {
        this.agentsView = null;
        this.log(this.t('ext.log.moduleFailed', { module: 'agents-view', error: errText(err) }));
      }
    }
    const provider = this.agentsView || fallbackAgentsView(this.t('ext.agentsUnavailable'));
    this.context.subscriptions.push(vscode.window.registerWebviewViewProvider(AGENTS_VIEW, provider));
    if (this.agentsView && typeof this.agentsView.dispose === 'function') this.context.subscriptions.push(this.agentsView);
  }

  setupCompact() {
    let mod = null;
    try {
      mod = require('./lib/compact');
    } catch (err) {
      this.log(this.t('ext.log.moduleFailed', { module: 'compact', error: errText(err) }));
    }
    this.compactMod = mod || null;
    if (mod && typeof mod.activateCompact === 'function') {
      try {
        const api = mod.activateCompact(this.context, {
          getSession: (key) => this.byKey.get(key) || null,
          listSessions: () => this.scoped.slice(),
          i18n: this.i18n,
          claudeHome: () => this.workerConfig().claude.configDir, // parent of the session registry sessions/
          output: this.output,
          inWorkspace: (s) => scopeLib.inWorkspace(s, this.ws()),
          getSelectedKey: () => this.selectedKey || this.shownKey || null, // when invoked without arguments, list the currently selected session first
        });
        this.compactApi = api || null;
        if (api && typeof api.dispose === 'function') this.context.subscriptions.push(api);
        return;
      } catch (err) {
        this.log(this.t('ext.log.moduleFailed', { module: 'compact', error: errText(err) }));
      }
    }
    // The compact module failed to load: keep the command and show an explanation, so the button never silently does nothing
    this.context.subscriptions.push(vscode.commands.registerCommand(COMPACT_CMD,
      () => vscode.window.showErrorMessage(this.t('ext.compactUnavailable'))));
  }

  // Auto-compact capacity: lib/autocompact.js registers agentMonitor.setAutoCompact itself; register a placeholder if loading fails
  setupAutoCompact() {
    const self = this;
    let mod = null;
    try {
      mod = require('./lib/autocompact');
    } catch (err) {
      this.log(this.t('ext.log.moduleFailed', { module: 'autocompact', error: errText(err) }));
    }
    if (mod && typeof mod.activateAutoCompact === 'function') {
      try {
        const d = mod.activateAutoCompact(this.context, {
          getSession: (key) => this.byKey.get(key) || null,
          getSessions: () => this.scoped.slice(),
          i18n: this.i18n,
          // Claude's config dir (holds settings.json) and the Codex dir (holds config.toml), both resolved from current settings
          get claudeHome() { return self.workerConfig().claude.configDir; },
          get codexHome() { return self.workerConfig().codex.home; },
          output: this.output,
          getSelectedKey: () => this.selectedKey || this.shownKey || null,
        });
        if (d && typeof d.dispose === 'function') this.context.subscriptions.push(d);
        return;
      } catch (err) {
        this.log(this.t('ext.log.moduleFailed', { module: 'autocompact', error: errText(err) }));
      }
    }
    // Placeholder when the module fails (if it had already registered the command, registering again would clash; guarded so activation doesn't fail)
    this.guard('autocompact', () => this.context.subscriptions.push(vscode.commands.registerCommand(AUTOCOMPACT_CMD,
      () => vscode.window.showErrorMessage(this.t('ext.autoCompactUnavailable')))));
  }

  // Storage locations and usage: the page lives in lib/storage-view.js, the scan runs in the worker
  setupStorage() {
    const cmd = (fn) => this.context.subscriptions.push(vscode.commands.registerCommand(STORAGE_CMD, fn));
    let mod = null;
    try {
      mod = require('./lib/storage-view');
    } catch (err) {
      this.log(this.t('ext.log.moduleFailed', { module: 'storage-view', error: errText(err) }));
    }
    if (!mod || typeof mod.openStorageView !== 'function') {
      cmd(() => vscode.window.showErrorMessage(this.t('ext.storageUnavailable')));
      return;
    }
    cmd(() => this.guard('storage', () => mod.openStorageView(this.context, {
      requestStorage: (force) => this.requestStorage(force),
      liveSessions: () => this.liveSessions(),
      i18n: this.i18n,
      platform: process.platform,
      log: (line) => this.log(line),
    })));
  }

  // Usage history: the page lives in lib/history-view.js, the scan runs in the worker (requestHistory / onHistory)
  setupHistory() {
    const cmd = (fn) => this.context.subscriptions.push(vscode.commands.registerCommand(HISTORY_CMD, fn));
    let mod = null;
    try {
      mod = require('./lib/history-view');
    } catch (err) {
      this.log(this.t('ext.log.moduleFailed', { module: 'history-view', error: errText(err) }));
    }
    const open = mod && (mod.openHistory || mod.openHistoryView);
    if (typeof open !== 'function') {
      cmd(() => vscode.window.showErrorMessage(this.t('ext.historyUnavailable')));
      return;
    }
    cmd(() => this.guard('history', () => open(this.context, {
      requestHistory: (req) => this.requestHistory(req),
      onHistory: (listener) => this.onHistory(listener),
      i18n: this.i18n,
      log: (line) => this.log(line),
    })));
  }

  registerCommands() {
    const exec = (command, ...args) => vscode.commands.executeCommand(command, ...args);
    const cmd = (id, fn) => this.context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    cmd('agentMonitor.show', () => exec(`${AGENTS_VIEW}.focus`));
    cmd('agentMonitor.showTree', () => exec(`${TREE_VIEW}.focus`));
    cmd('agentMonitor.refresh', () => this.refresh());
    cmd('agentMonitor.openSettings', () => exec('workbench.action.openSettings', `@ext:${EXT_ID}`));
    cmd('agentMonitor.scope.all', () => this.setFlag('scope', scopeLib.SCOPE.ALL));
    cmd('agentMonitor.scope.workspace', () => this.setFlag('scope', scopeLib.SCOPE.WORKSPACE));
    cmd('agentMonitor.hideCompleted', () => this.setFlag('hideCompleted', true));
    cmd('agentMonitor.showCompleted', () => this.setFlag('hideCompleted', false));
    cmd('agentMonitor.markSeen', (arg) => this.markSeen(arg));
    cmd('agentMonitor.markAllSeen', () => this.markAllSeen());
    cmd('agentMonitor.openTranscript', (arg) => this.openTranscript(arg));
    cmd('agentMonitor.revealTranscript', (arg) => this.revealTranscript(arg));
    cmd('agentMonitor.copyTranscriptPath', (arg) => this.copyTranscriptPath(arg));
    cmd('agentMonitor.copyResume', (arg) => this.copyResume(arg));
    cmd(HANDOFF_CMD, (arg) => this.handoff(arg).catch((err) => this.log(this.t('ext.log.failed', { what: 'handoff', error: errText(err) }))));
    cmd('agentMonitor.network.allow', () => this.setNetwork(true));
    cmd('agentMonitor.network.block', () => this.setNetwork(false));
    cmd('agentMonitor.network.toggle', () => this.setNetwork(!this.networkAllowed()));
    cmd(GOTO_CMD, (arg) => this.goToChat(arg).catch((err) => this.log(this.t('ext.log.failed', { what: 'goToChat', error: errText(err) }))));
  }

  // "Go to agent" (lib/jump.js): finds the chat panel, editor tab or terminal a session runs in, here or in another window;
  // this window's presence fields go into its shared-scan record for the other windows
  setupJump() {
    this.jumper = jumpLib.createJumper({
      vscode,
      platform: process.platform,
      claudeHome: () => this.workerConfig().claude.configDir,
      localInfo: () => this.hostFields([]),
      windows: () => (this.shared ? this.shared.windows() : []),
      requestJump: (id, action) => (this.shared ? this.shared.requestJump(id, action, { ttlMs: jumpLib.REQUEST_TTL_MS }) : null),
      cancelJump: (id, reqId) => (this.shared ? this.shared.cancelJump(id, reqId) : false),
      confirmAutomation: (app) => this.confirmAutomation(app),
      log: (line) => this.log(line),
    });
    this.hostInfo = this.hostFields([]);
    const w = vscode.window;
    const sub = (...d) => this.context.subscriptions.push(...d);
    if (typeof w.onDidOpenTerminal === 'function') sub(w.onDidOpenTerminal(() => this.updateHost()));
    if (typeof w.onDidCloseTerminal === 'function') sub(w.onDidCloseTerminal(() => this.updateHost()));
    this.updateHost();
  }

  // Presence fields for the other windows; terminal pids resolve asynchronously, and only the latest call writes
  updateHost() {
    const seq = ++this.hostSeq;
    Promise.resolve(jumpLib.terminalsByPid(vscode, HOST_PID_WAIT_MS)).then((terms) => {
      if (this.stopped || seq !== this.hostSeq) return;
      this.hostInfo = this.hostFields([...terms.keys()]);
      if (this.shared) this.guard('sharedScan', () => this.shared.setHost(this.hostInfo));
    }).catch(noop);
  }

  // Presence fields: extension-host pid, terminal shell pids, folders, and what tells which Copilot chats this window can load
  hostFields(terminals) {
    const ws = this.ws();
    return {
      hostPid: process.pid, terminals, folders: ws.paths,
      storageDir: ws.storageDir || null, workspaceFile: ws.workspaceFile || null, empty: ws.empty === true,
    };
  }

  /**
   * Before the first AppleScript call to a terminal app: macOS will ask whether this editor may control that app, so say
   * that first (once per app; a modal, so it is never answered by accident).
   */
  async confirmAutomation(app) {
    const gs = this.context.globalState;
    const agreed = (gs && gs.get(AUTOMATION_KEY)) || {};
    if (agreed && agreed[app.id] === true) return true;
    const go = this.t('ext.jump.automation.continue');
    const pick = await vscode.window.showInformationMessage(
      this.t('ext.jump.automation.confirm', { app: app.name }),
      { modal: true, detail: this.t('ext.jump.automation.detail', { app: app.name, editor: vscode.env.appName || 'VS Code' }) },
      go,
    );
    if (pick !== go) return false;
    if (gs) await Promise.resolve(gs.update(AUTOMATION_KEY, { ...(agreed && typeof agreed === 'object' ? agreed : {}), [app.id]: true })).catch(noop);
    return true;
  }

  // Another window found that a session runs here and asks this window to bring it up (or answers one of our requests)
  onJumpRequest(req) {
    if (this.stopped || !this.jumper) return;
    Promise.resolve(this.jumper.handleRequest(req)).catch((err) => this.log(this.t('ext.log.failed', { what: 'goToChat', error: errText(err) })));
  }

  /**
   * Go to Chat: the panel's Go to button and double-click, the context menus and the tree's inline action pass the
   * session; from the Command Palette a session is picked first. Says why when the jump is not possible.
   */
  async goToChat(arg) {
    const key = this.keyOf(arg) || (arg == null ? await this.pickSessionKey() : null);
    const s = key ? this.byKey.get(key) : null;
    if (!s || !this.jumper) return;
    if (this.jumping.has(key)) return; // a double-click while the processes are still being listed
    this.jumping.add(key);
    let out;
    try {
      out = await this.jumper.goTo(s);
    } finally {
      this.jumping.delete(key);
    }
    if (out && !out.ok && out.reason === jumpLib.REASON.FAILED) this.log(this.t('ext.log.failed', { what: 'goToChat', error: String(out.error || '') }));
    const msg = jumpLib.messageOf(out, this.i18n, s, { appName: vscode.env.appName });
    if (!msg) return;
    const show = msg.level === 'warn' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const buttons = msg.button ? [msg.button.label] : [];
    const pick = await show.call(vscode.window, msg.text, ...buttons);
    if (msg.button && pick === msg.button.label) await vscode.env.openExternal(vscode.Uri.parse(msg.button.url));
  }

  listen() {
    const sub = (...d) => this.context.subscriptions.push(...d);
    sub(
      vscode.workspace.onDidChangeConfiguration((e) => this.onConfig(e)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.render(); this.updateHost(); }),
      vscode.window.onDidChangeWindowState(() => {
        this.onTabs();
        this.updateViewDwell();
        if (this.shared) this.shared.setWindowFocused(this.windowFocused()); // onPresence updates the interval
        else this.updateInterval();
        this.guard('notify', () => this.deliverDeferred());
      }),
    );
    const tg = vscode.window.tabGroups;
    if (tg) {
      if (typeof tg.onDidChangeTabs === 'function') sub(tg.onDidChangeTabs(() => this.onTabs()));
      if (typeof tg.onDidChangeTabGroups === 'function') sub(tg.onDidChangeTabGroups(() => this.onTabs()));
    }
  }

  // On first activation, focus the bottom panel once so users know where it is; never again after that
  introFocus() {
    const gs = this.context.globalState;
    if (!gs || gs.get(INTRO_KEY)) return;
    Promise.resolve(gs.update(INTRO_KEY, Date.now())).catch(noop);
    const hadEditor = !!this.activeTab();
    Promise.resolve(vscode.commands.executeCommand(`${AGENTS_VIEW}.focus`))
      .then(() => (hadEditor ? vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup') : undefined))
      .catch(noop);
  }

  // ---------- Settings ----------

  // Legacy settings migration: old scope values conversation / pinned, and onlyWorkspace -> scope
  migrateScope() {
    const c = this.cfg();
    let plan = [];
    try { plan = scopeLib.planScopeMigration(c.inspect('scope'), c.inspect('onlyWorkspace')); } catch { plan = []; }
    const targets = { global: vscode.ConfigurationTarget.Global, workspace: vscode.ConfigurationTarget.Workspace };
    for (const p of plan) {
      const target = targets[p.target];
      if (target === undefined) continue; // the folder level can't be written without a resource (and inspect without a resource can't read it either)
      Promise.resolve(c.update(p.key, p.value, target)).catch((err) => this.log(errText(err)));
    }
  }

  // Write to the effective level: the workspace if set there, otherwise user settings
  setFlag(key, value) {
    const c = this.cfg();
    const i = c.inspect(key);
    const target = i && i.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    return c.update(key, value, target);
  }

  scope() { return scopeLib.normalizeScope(this.cfg().get('scope', 'all')); }

  ws() {
    const su = this.context && this.context.storageUri;
    return scopeLib.workspaceInfo(vscode.workspace.workspaceFolders, {
      workspaceFile: vscode.workspace.workspaceFile,
      // storageUri = <User>/workspaceStorage/<hash>/<extension id>: this window's Copilot chats live under <hash>/chatSessions
      storageDir: su && (!su.scheme || su.scheme === 'file') && su.fsPath ? path.dirname(su.fsPath) : null,
    });
  }

  settings() {
    const c = this.cfg();
    return {
      hideCompleted: !!c.get('hideCompleted', false),
      showCost: c.get('showCost', true) !== false,
      contextHintStart: num(c.get('contextHintStart', 200000), 200000),
      contextHintAct: num(c.get('contextHintAct', 500000), 500000),
    };
  }

  refreshMs() { return Math.max(1, num(this.cfg().get('refreshSeconds', 2), 2)) * 1000; }

  backgroundMs() {
    const B = BACKGROUND_SECONDS;
    return Math.min(B.max, Math.max(B.min, num(this.cfg().get('backgroundRefreshSeconds', B.dflt), B.dflt))) * 1000;
  }

  /**
   * Windows share a scan only when this matches: the extension version (windows not yet reloaded after an update scan on
   * their own) and the WorkerConfig without observedCompact (learned per window, and swapped without a rebuild),
   * intervalMs (so a different refresh speed does not split windows; the leader's applies) and historyCacheFile (each
   * window's own history requests use it, never the shared snapshots).
   */
  cfgKey() {
    const { observedCompact, intervalMs, historyCacheFile, ...rest } = this.workerConfig(); // eslint-disable-line no-unused-vars
    return JSON.stringify({ version: VERSION, ...rest });
  }

  /** WorkerConfig: default paths are resolved on the main thread and passed in */
  workerConfig() {
    const c = this.cfg();
    const env = process.env;
    const home = os.homedir();
    const projectsSetting = expandHome(c.get('claude.projectsDir', ''), home);
    // Claude config dir: CLAUDE_CONFIG_DIR first, then derived from claude.projectsDir, then ~/.claude;
    // it is also the parent of the session registry sessions/ and of settings.json
    const configDir = env.CLAUDE_CONFIG_DIR ? expandHome(env.CLAUDE_CONFIG_DIR, home)
      : projectsSetting ? path.dirname(projectsSetting) : path.join(home, '.claude');
    const configDirSource = env.CLAUDE_CONFIG_DIR ? 'env' : projectsSetting ? 'setting' : 'default';
    const projectsDir = projectsSetting || path.join(configDir, 'projects');
    const claudeHome = path.dirname(projectsDir);
    const codexSetting = expandHome(c.get('codex.home', ''), home);
    const codexHome = codexSetting || (env.CODEX_HOME ? expandHome(env.CODEX_HOME, home) : path.join(home, '.codex'));
    const codexHomeSource = codexSetting ? 'setting' : env.CODEX_HOME ? 'env' : 'default';
    // Gemini CLI: the setting, else $GEMINI_CLI_HOME/.gemini, else ~/.gemini
    const geminiSetting = expandHome(c.get('gemini.home', ''), home);
    const geminiHome = geminiSetting || path.join(env.GEMINI_CLI_HOME ? expandHome(env.GEMINI_CLI_HOME, home) : home, '.gemini');
    const geminiHomeSource = geminiSetting ? 'setting' : env.GEMINI_CLI_HOME ? 'env' : 'default';
    // Qwen Code: the setting, else $QWEN_RUNTIME_DIR, $QWEN_HOME, else ~/.qwen
    const qwenSetting = expandHome(c.get('qwen.home', ''), home);
    const qwenEnv = env.QWEN_RUNTIME_DIR || env.QWEN_HOME || '';
    const qwenHome = qwenSetting || (qwenEnv ? expandHome(qwenEnv, home) : path.join(home, '.qwen'));
    const qwenHomeSource = qwenSetting ? 'setting' : qwenEnv ? 'env' : 'default';
    const storage = this.context.globalStorageUri;
    return {
      intervalMs: this.refreshMs(),
      activeWindowMinutes: num(c.get('activeWindowMinutes', 30), 30),
      staleMinutes: num(c.get('staleMinutes', 5), 5),
      claude: {
        enabled: c.get('claude.enabled', true) !== false,
        projectsDir,
        settingsPath: path.join(claudeHome, 'settings.json'),
        home: claudeHome,
        configDir,
        configDirSource,
      },
      codex: { enabled: c.get('codex.enabled', true) !== false, home: codexHome, homeSource: codexHomeSource },
      // Copilot Chat logs live in this VS Code's user dir (null: the provider's defaults, e.g. when it cannot be derived)
      copilot: { enabled: c.get('copilot.enabled', true) !== false, userDir: vscodeUserDir(storage) },
      gemini: { enabled: c.get('gemini.enabled', true) !== false, home: geminiHome, homeSource: geminiHomeSource },
      qwen: { enabled: c.get('qwen.enabled', true) !== false, home: qwenHome, homeSource: qwenHomeSource },
      approvalGuess: c.get('approvalGuess', S.APPROVAL_GUESS.FAST_TOOLS),
      approvalGuessSeconds: num(c.get('approvalGuessSeconds', S.APPROVAL_GUESS_DEFAULT_SECONDS), S.APPROVAL_GUESS_DEFAULT_SECONDS),
      observedCompact: { ...this.observed },
      // Usage-history cache, so reopening the history page reads only what's new (null: no global storage, no cache)
      historyCacheFile: storage && storage.fsPath ? path.join(storage.fsPath, HISTORY_FILE) : null,
    };
  }

  onConfig(e) {
    // Which side the session list is on: auto follows the terminal tab list position, so changes to that terminal setting are pushed to the page too
    if (!e.affectsConfiguration('agentMonitor')) {
      if (e.affectsConfiguration('terminal.integrated.tabs.location')) this.updateAgents(Date.now());
      return;
    }
    const hit = (keys) => keys.some((k) => e.affectsConfiguration(`agentMonitor.${k}`));
    if (hit(MONITOR_KEYS)) {
      this.cfgGen++;
      // Sessions that only show up under the new settings (another folder, a provider turned on, ...) are not new waits
      if (hit(MONITOR_KEYS.filter((k) => k !== 'refreshSeconds'))) this.notifyReseed = true;
      if (this.worker) this.worker.postMessage({ type: 'config', cfg: this.workerConfig(), gen: this.cfgGen });
      if (this.shared) this.shared.setCfgKey(this.cfgKey());
    }
    if (hit(['scope'])) this.revealKeys.clear();
    if (hit([NETWORK_KEY])) this.setContext('networkAllowed', this.networkAllowed());
    if (hit([...PUSH_KEYS, NETWORK_KEY]) && this.push) this.guard('push', () => this.push.onSettings());
    if (hit(['shareScanAcrossWindows'])) this.guard('sharedScan', () => this.applySharing());
    if (hit(['backgroundRefreshSeconds']) && this.shared) this.shared.setIdleHeartbeatMs(this.backgroundMs());
    if (hit(['refreshSeconds', 'backgroundRefreshSeconds'])) this.updateInterval();
    if (e.affectsConfiguration('agentMonitor.onlyWorkspace')) this.migrateScope();
    this.render(); // scope, hide-completed, cost, status bar, etc.: recompute from the last snapshot now instead of waiting for the next scan
  }

  // ---------- worker ----------

  /**
   * restart: an automatic restart after a crash (counts against WORKER_RETRIES); otherwise the worker is started on purpose
   * (activation, Refresh, a storage request, becoming leader) and gets a full retry budget.
   */
  startWorker(restart = false) {
    if (!restart) this.workerRetries = 0;
    // A new worker comes back paused unless this window scans (alone, or as the shared scan's leader / solo)
    const scan = this.scanning();
    const cfg = { ...this.workerConfig(), cfgGen: this.cfgGen };
    const w = new Worker(path.join(this.context.extensionPath, 'lib', 'worker.js'), { workerData: scan ? cfg : { ...cfg, paused: true }, resourceLimits: WORKER_LIMITS });
    this.worker = w;
    this.workerStartedAt = Date.now();
    this.focusSig = null; // new worker: tell it again which sessions need details
    w.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'snapshot') this.onWorkerSnapshot(m);
      else if (m.type === 'storage') this.onStorage(m);
      else if (m.type === 'history') this.onHistoryReport(m);
      else if (m.type === 'error') this.log(this.t('ext.log.source', { source: String(m.source || 'worker'), message: String(m.message || '') }));
    });
    w.on('error', (err) => this.log(this.t('ext.log.workerError', { error: errText(err) })));
    w.on('exit', (code) => {
      if (w !== this.worker) return; // stopped on purpose or already replaced
      this.worker = null;
      if (code === 0) return;
      this.log(this.t('ext.log.workerExit', { code }));
      if (this.workerRetries < WORKER_RETRIES) {
        this.workerRetries++;
        this.startWorker(true);
        return;
      }
      // Given up: with a shared scan, leave the scanning to a window whose worker works and show its snapshots
      // (a leader would otherwise keep beating and freeze every window); Refresh starts a worker and allows leading again
      if (this.shared) this.guard('sharedScan', () => this.shared.setCanLead(false));
    });
    // Shared scan: the worker scans for the union of all windows' focus (an unchanged union is not reported again)
    if (this.shared && scan) w.postMessage({ type: 'focus', keys: this.shared.focusKeys() });
    this.sendFocus();
    if (this.intervalMs) w.postMessage({ type: 'interval', ms: this.intervalMs });
    // If someone is still waiting for a storage scan when the worker was replaced, ask the new worker again
    if (this.storageWaiters.length) w.postMessage({ type: 'storage', force: this.storageForce });
    // The history page is open: ask the new worker again (its replies go to the page as before)
    if (this.historyReq) w.postMessage({ ...this.historyReq });
    // Last, since it may make this window leader at once (onRole then resumes this worker)
    if (!restart && this.shared) this.guard('sharedScan', () => this.shared.setCanLead(true));
  }

  stopWorker() {
    const w = this.worker;
    this.worker = null;
    if (w) w.terminate();
  }

  /** Whether this window's worker scans: always when scanning alone; with a shared scan only as leader or solo */
  scanning() {
    if (!this.shared) return true;
    const role = this.shared.role;
    return role === sharedScanLib.ROLES.LEADER || role === sharedScanLib.ROLES.SOLO;
  }

  onWorkerSnapshot(m) {
    // Only crashes in a row count: a worker that has run for a while gets its retry budget back
    if (this.workerRetries && Date.now() - this.workerStartedAt >= WORKER_HEALTHY_MS) this.workerRetries = 0;
    const current = m.cfgGen === this.cfgGen; // built with the current settings (not one scanned just before a change)
    if (this.shared) {
      const role = this.shared.role;
      if (role === sharedScanLib.ROLES.FOLLOWER) return; // a scan that finished just before the pause; the leader's snapshots are shown instead
      if (role === sharedScanLib.ROLES.LEADER && current) this.guard('sharedScan', () => this.publishShared(m));
    }
    if (current && this.notifyReseed) this.reseedNeedsYou();
    this.guard('snapshot', () => this.onSnapshot(m));
    for (const done of this.waiters.splice(0)) done();
  }

  /**
   * Leader: publish the snapshot (skipped when only now changed). After a publish that changed which Claude sessions are
   * live, the next one is published even if unchanged: compact.js confirms a closed window only after two snapshots in a
   * row, and in a follower only real snapshots count (not its replays).
   */
  publishShared(m) {
    if (!this.shared.publish(m, { force: this.echoNext })) return;
    const live = liveSig(m.sessions);
    this.echoNext = this.pubLive !== null && live !== this.pubLive;
    this.pubLive = live;
  }

  // Ask the worker to rescan now; restart it if it died. The progress indicator spins until the next snapshot arrives.
  // With a shared scan a follower asks the leader, whose next publish carries the result even if nothing changed
  refresh() {
    if (!this.worker) this.startWorker();
    else if (!this.shared) this.worker.postMessage({ type: 'refresh' });
    if (this.shared) this.shared.requestRefresh(); // leader / solo: onRefreshRequest -> refreshWorker
    const next = new Promise((resolve) => {
      const timer = setTimeout(resolve, REFRESH_WAIT_MS); // don't let the progress indicator spin forever if the worker never answers
      if (timer && typeof timer.unref === 'function') timer.unref();
      this.waiters.push(() => { clearTimeout(timer); resolve(); });
    });
    const panelVisible = !!(this.agentsView && this.agentsView.visible);
    const viewId = panelVisible || !this.treeView.visible ? AGENTS_VIEW : TREE_VIEW;
    return vscode.window.withProgress({ location: { viewId } }, () => next);
  }

  /** Scan now in this window's worker, starting one if it died */
  refreshWorker() {
    if (this.worker) this.worker.postMessage({ type: 'refresh' });
    else this.startWorker();
  }

  sendFocus() {
    const keys = [...new Set([this.shownKey, this.follower && this.follower.key].filter(Boolean))];
    const sig = keys.join('\n');
    if (sig === this.focusSig) return;
    this.focusSig = sig;
    if (this.shared) this.shared.setFocus(keys); // the scanning window's worker gets the union through onFocusUnion
    else if (this.worker) this.worker.postMessage({ type: 'focus', keys });
  }

  /**
   * Background slowdown: while no VS Code window has focus (any window when sharing a scan, else this one), the worker scans
   * every max(refreshSeconds, backgroundRefreshSeconds); back to refreshSeconds as soon as a window has focus.
   */
  updateInterval() {
    const anyFocused = this.shared ? this.shared.anyWindowFocused() : this.windowFocused();
    const bg = this.backgroundMs();
    const ms = !anyFocused && bg > this.refreshMs() ? bg : null;
    if (ms === this.intervalMs) return;
    this.intervalMs = ms;
    if (this.worker) this.worker.postMessage({ type: 'interval', ms });
  }

  // ---------- Shared scan across windows ----------

  sharingWanted() {
    const u = this.context.globalStorageUri;
    return !!(u && u.fsPath) && this.cfg().get('shareScanAcrossWindows', true) !== false;
  }

  /** A shared scan (not started yet), or null when the setting is off or there is no global storage dir */
  createShared() {
    if (!this.sharingWanted()) return null;
    const shared = sharedScanLib.createSharedScan({
      dir: path.join(this.context.globalStorageUri.fsPath, SHARED_DIR),
      cfgKey: this.cfgKey(),
      idleHeartbeatMs: this.backgroundMs(), // while no window has focus, the windows check on each other less often too
      host: this.hostInfo, // presence fields for "Go to agent"
      onRole: (role) => this.guard('sharedScan', () => this.onRole(role)),
      onSnapshot: (snap) => this.guard('snapshot', () => this.onSharedSnapshot(snap)),
      onFocusUnion: (keys) => { if (this.worker) this.worker.postMessage({ type: 'focus', keys }); },
      onRefreshRequest: () => this.guard('sharedScan', () => this.refreshWorker()),
      onPresence: () => this.guard('sharedScan', () => this.updateInterval()),
      onJump: (req) => this.guard('goToChat', () => this.onJumpRequest(req)),
      onError: (err) => this.logSharedError(err),
    });
    shared.setWindowFocused(this.windowFocused()); // before anyone asks anyWindowFocused()
    return shared;
  }

  startShared() {
    const shared = this.shared;
    if (!shared) return;
    this.focusSig = null;
    this.sendFocus(); // kept until start writes this window's file
    shared.start(); // may already pick the role (and render the leader's snapshot) before returning
    this.updateInterval();
  }

  stopShared() {
    const shared = this.shared;
    if (!shared) return;
    this.shared = null;
    this.scheduleReplay(); // clears the follower's timer
    shared.stop();
  }

  /** agentMonitor.shareScanAcrossWindows changed: join the shared scan, or leave it and scan alone again */
  applySharing() {
    if (this.stopped || this.sharingWanted() === !!this.shared) return;
    if (!this.shared) {
      this.shared = this.createShared();
      this.startShared();
      return;
    }
    this.stopShared();
    this.focusSig = null;
    this.sendFocus();
    if (this.worker) this.worker.postMessage({ type: 'resume' });
    else this.startWorker();
    this.updateInterval();
  }

  // Leader / solo: this window's worker scans (onFocusUnion has just given it its focus); follower: pause it and show the leader's snapshots
  onRole(role) {
    const scan = role === sharedScanLib.ROLES.LEADER || role === sharedScanLib.ROLES.SOLO;
    if (role === sharedScanLib.ROLES.LEADER) { this.pubLive = null; this.echoNext = false; }
    if (this.worker) this.worker.postMessage({ type: scan ? 'resume' : 'pause' });
    else if (scan) this.startWorker();
    this.scheduleReplay();
  }

  // Follower: a snapshot published by the leader. Its content is current, but its now is from when the leader last wrote it
  // (publishing is skipped while only now changes), so the local clock is used instead
  onSharedSnapshot(snap) {
    if (this.notifyReseed) this.reseedNeedsYou(); // only the current leader's snapshots under this window's cfgKey get here
    this.onSnapshot({ ...snap, now: Date.now() });
    for (const done of this.waiters.splice(0)) done();
  }

  /**
   * Follower: while the leader has nothing new to publish, re-run the last snapshot with the local clock at the scan interval,
   * as a local worker would send it. Relative times ("5 min ago", durations, cache countdowns), the dwell timers and
   * compact.js' cache reminders then advance as without sharing. Replays carry replay: true: they are not new data, so
   * compact.js does not count them towards confirming a closed window and they do not count as a fresh look for the
   * "needs you" check. Changes that depend on time (stale, approval guess, leaving the activity window) are computed by
   * the leader's worker, change its snapshot and are published. Called after every snapshot and role change; clears the
   * timer otherwise.
   */
  scheduleReplay() {
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.replayTimer = null;
    if (this.stopped || !this.last || !this.shared || this.shared.role !== sharedScanLib.ROLES.FOLLOWER) return;
    this.replayTimer = setTimeout(() => {
      this.replayTimer = null;
      this.guard('snapshot', () => this.onSnapshot({ ...this.last, now: Date.now(), replay: true }));
    }, this.intervalMs || this.refreshMs());
    if (typeof this.replayTimer.unref === 'function') this.replayTimer.unref();
  }

  logSharedError(err) {
    const text = String((err && err.message) || err);
    if (text === this.sharedErr) return; // e.g. an unwritable dir fails on every heartbeat
    this.sharedErr = text;
    this.log(this.t('ext.log.failed', { what: 'sharedScan', error: errText(err) }));
  }

  onSnapshot(m) {
    const first = !this.last;
    if (!m.replay) this.dataSeq++;
    this.last = { ...m, sessions: Array.isArray(m.sessions) ? m.sessions : [] };
    this.byKey = new Map(this.last.sessions.filter((s) => s && typeof s.key === 'string').map((s) => [s.key, s]));
    // Following: match against the current tab once on the first snapshot; afterwards only handle the late follow for a session that didn't exist yet at tab switch
    if (first) this.onTabs(true);
    else this.followOnSnapshot();
    // New results in a session you keep watching also count as seen (mark first, then compute lamps)
    const doneAfterSeen = (k) => {
      const s = this.byKey.get(k);
      return !!s && (s.doneAtMs || 0) > this.seen.get(k);
    };
    Promise.resolve(this.dwell.refresh(doneAfterSeen)).then((changed) => { if (changed) this.render(); }, noop);
    this.render();
    if (this.compactApi && typeof this.compactApi.onSnapshot === 'function') {
      this.guard('compact', () => this.compactApi.onSnapshot(this.last));
    }
    this.guard('observedCompact', () => this.learnObservedCompact(this.last.sessions));
    this.scheduleReplay();
  }

  // ---------- Observed compaction points ----------

  loadObserved() {
    const gs = this.context.globalState;
    const clean = (o) => {
      const out = {};
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (typeof k === 'string' && Number.isFinite(v) && v > 0) out[k] = v;
      return out;
    };
    this.observed = clean(gs && gs.get(OBSERVED_KEY));
    this.observedAt = clean(gs && gs.get(OBSERVED_AT_KEY));
  }

  /**
   * When a snapshot shows a new auto-compaction (main conversation lastCompact.trigger === 'auto'), record preTokens under "model|window".
   * Learn only from sessions not overridden by settings (with an override, the compaction point reflects the setting, not the
   * model default); only a later observation replaces an older value.
   * If a value changed, write globalState and send a config right away so the worker uses it.
   * @returns {boolean} whether anything was updated
   */
  learnObservedCompact(sessions) {
    const found = observedCompactsOf(sessions);
    let changed = false;
    let newer = false;
    for (const [key, v] of found) {
      const at = this.observedAt[key] || 0;
      if (v.ms <= at) continue;
      this.observedAt[key] = v.ms;
      newer = true;
      if (this.observed[key] !== v.tokens) {
        this.observed[key] = v.tokens;
        changed = true;
        this.log(this.t('ext.log.learnedCompact', { model: v.model, window: this.i18n.fmtTokens(v.window), tokens: this.i18n.fmtTokens(v.tokens) }));
      }
    }
    // Skip writing globalState when there is no newer observation (a snapshot arrives every 2 s; can't write every time)
    if (!newer) return false;
    const gs = this.context.globalState;
    if (gs) {
      Promise.resolve(gs.update(OBSERVED_AT_KEY, { ...this.observedAt })).catch(noop);
      if (changed) Promise.resolve(gs.update(OBSERVED_KEY, { ...this.observed })).catch(noop);
    }
    if (changed && this.worker) this.worker.postMessage({ type: 'config', cfg: this.workerConfig(), gen: this.cfgGen });
    return changed;
  }

  // ---------- Storage locations and usage ----------

  /** Request a storage scan from the worker (without force, the worker returns a cache under 10 minutes old); starts a worker if none is running */
  requestStorage(force) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.storageWaiters = this.storageWaiters.filter((x) => x !== waiter);
        reject(new Error('storage: timeout'));
      }, STORAGE_WAIT_MS);
      if (waiter.timer && typeof waiter.timer.unref === 'function') waiter.timer.unref();
      this.storageWaiters.push(waiter);
      this.storageForce = this.storageForce || !!force;
      if (!this.worker) this.startWorker(); // the new worker will send the pending requests
      else this.worker.postMessage({ type: 'storage', force: !!force });
    });
  }

  onStorage(m) {
    const { type, ...report } = m; // eslint-disable-line no-unused-vars
    this.storageForce = false;
    for (const w of this.storageWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(report);
    }
  }

  // ---------- Usage history ----------

  /**
   * The history page asks the worker: { days?, force? } starts or refreshes the scan (replies stream to onHistory until
   * one is complete); { release: true } (the page closed) saves the cache and frees the scanner. Starts a worker if none
   * runs; a worker started later (crash, Refresh) gets the last request again until the page releases it. A follower
   * window's worker is paused, but still answers its own page.
   * @param {{ days?: number, force?: boolean, release?: boolean }} [req]
   */
  requestHistory(req) {
    if (this.stopped) return;
    const r = req && typeof req === 'object' ? req : {};
    if (r.release === true) {
      this.historyReq = null;
      if (this.worker) this.worker.postMessage({ type: 'history', release: true });
      return;
    }
    const msg = { type: 'history' };
    if (Number.isFinite(r.days)) msg.days = r.days;
    if (r.force === true) msg.force = true;
    this.historyReq = msg;
    if (!this.worker) this.startWorker(); // the new worker gets historyReq
    else this.worker.postMessage({ ...msg });
  }

  /**
   * Replies from the worker ({ type: 'history', ...HistoryReport }) go to every listener.
   * @param {(report: any) => void} listener
   * @returns {{ dispose: () => void }}
   */
  onHistory(listener) {
    if (typeof listener !== 'function') return { dispose: noop };
    this.historyListeners.add(listener);
    return { dispose: () => { this.historyListeners.delete(listener); } };
  }

  onHistoryReport(m) {
    // A complete reply means a forced re-check is done: a later worker is asked again without force
    if (!m.partial && this.historyReq && this.historyReq.force) {
      const { force, ...rest } = this.historyReq; // eslint-disable-line no-unused-vars
      this.historyReq = rest;
    }
    for (const fn of [...this.historyListeners]) this.guard('history', () => fn(m));
  }

  /** Open sessions (checked before migrating): Claude by liveness in the registry, Codex by a turn in progress */
  liveSessions() {
    const out = [];
    for (const s of this.byKey.values()) {
      if (s && s.live) out.push({ provider: s.provider, sessionId: String(s.id || ''), title: String(s.title || s.id || '') });
    }
    return out;
  }

  // ---------- Rendering ----------

  // Sessions in this window's scope, plus any revealed from a notification ("Show") until the user selects another row
  // or changes the scope
  currentScoped() {
    if (!this.last) return [];
    const scoped = scopeLib.filterByScope(this.last.sessions, this.scope(), this.ws());
    if (!this.revealKeys.size) return scoped;
    const have = new Set(scoped.map((s) => s.key));
    const extra = this.last.sessions.filter((s) => s && this.revealKeys.has(s.key) && !have.has(s.key));
    return extra.length ? scoped.concat(extra) : scoped;
  }

  render() {
    if (!this.last) { this.updateChrome(); return; }
    const now = Date.now();
    const st = this.settings();
    this.scoped = this.currentScoped();
    this.lamps = lampLib.computeLamps(this.scoped, { seen: this.seen.reader() });
    const bySession = this.lamps.bySession;
    const hints = { start: st.contextHintStart, act: st.contextHintAct };
    // Session list order: "open" / "recent" groups, newest start first within each; once locked, activity never reorders it
    const arranged = this.guard('sessions', () => this.sessionOrder.arrange(this.scoped));
    this.arranged = arranged || null;
    this.leftKeys = arranged ? arranged.keys : [];
    this.guard('overview', () => this.overview.update({
      sessions: this.scoped, lamps: bySession, now, hideCompleted: st.hideCompleted, showCost: st.showCost, hints,
    }));
    this.resolveShown();
    this.updateAgents(now);
    this.guard('statusBar', () => this.updateStatusBar(now));
    this.updateChrome();
    this.sendFocus();
    this.updateTabDwell();
    this.updateViewDwell();
    this.guard('notify', () => this.checkNeedsYou());
  }

  // What the content area shows: the selection -> current conversation -> first row. If nothing was ever selected, select by the same rules and keep it
  resolveShown() {
    const keys = this.leftKeys;
    if (this.selectedKey && !keys.includes(this.selectedKey)) this.selectedKey = null; // filtered out by scope or gone
    const r = scopeLib.resolveSelection({ selectedKey: this.selectedKey, conversationKey: this.follower.key, keys });
    if (!this.selectedKey && r.key) this.select(r.key);
    this.shownKey = r.key;
  }

  /** Programmatic selection (following, auto-selecting the first row): not marked seen right away (left to the 1.5 s dwell timer); pushed to the page on the next render */
  select(key) {
    this.selectedKey = key;
  }

  /**
   * User selection in the list (the page sends select: row click, Enter, Space) -> mark as seen, switch the content area, send focus.
   * Only sessions currently in the list are accepted.
   */
  userSelect(key) {
    if (typeof key !== 'string' || !this.byKey.has(key) || !this.leftKeys.includes(key)) return;
    if (this.revealKeys.size && !this.revealKeys.has(key)) this.revealKeys.clear(); // back to the scope alone
    this.selectedKey = key;
    Promise.resolve(this.seen.mark(key)).then((changed) => { if (changed) this.render(); }, noop);
    this.render();
  }

  // ---------- "Needs you" notifications ----------

  notifyEnabled() { return this.cfg().get('notifyNeedsYou', true) !== false; }

  /**
   * Claim markers, so one window reports each wait: a private folder under the system temp dir that every VS Code-family
   * app of this user shares (so VS Code and Cursor, say, do not both report it), else this app's global storage.
   * No dir: claimOnce lets every window report.
   */
  notifyDir() {
    const shared = notifyLib.sharedClaimDir();
    if (shared) return shared;
    const u = this.context.globalStorageUri;
    return u && u.fsPath ? path.join(u.fsPath, NOTIFY_DIR) : '';
  }

  /** A system notification can be shown from here: not in a remote window (it would appear on the remote machine) */
  systemNotifier() {
    return !vscode.env.remoteName && notifyLib.hasSystemNotifier();
  }

  reseedNeedsYou() {
    this.notifyReseed = false;
    this.needsYou = notifyLib.createNeedsYouTracker();
    this.thresholds = alertsLib.createThresholdTracker();
    this.lampEvents = notifyLib.createLampEventTracker();
    if (this.push) this.guard('push', () => this.push.reseed());
  }

  /**
   * After each render: the tracker gets all sessions (not the scoped list, so switching scope never reports a wait that
   * began earlier) and reports the ones that just started waiting; the first call only seeds it. It is updated even while
   * notifications are off, so turning them on does not report waits that were already there.
   */
  checkNeedsYou() {
    const sessions = this.last.sessions;
    const lamps = lampLib.computeLamps(sessions, { seen: this.seen.reader() });
    this.needsLamps = lamps.bySession;
    for (const item of this.needsYou.update(sessions, lamps)) this.notifyNeedsYou(item);
    // Errors and finished work have no notification of their own, only a sound
    for (const ev of this.lampEvents.update(sessions, lamps, Date.now())) this.guard('sound', () => this.lampSound(ev));
    // Threshold alerts on the same data (the tracker is fed even while every threshold is off, so setting one never
    // reports what is already over it)
    const alerts = this.guard('alerts', () => this.checkAlerts(sessions)) || [];
    // Remote push: the same sessions and lamps, plus the quota snapshot (usage limits) and the threshold alerts; seq
    // counts real snapshots only
    if (this.push) this.guard('push', () => this.push.update({ sessions, lamps, quota: this.last.quota, seq: this.dataSeq, alerts }));
    for (const key of [...this.notifyDeferred.keys()]) if (!this.currentWait(key)) this.notifyDeferred.delete(key);
    if (this.notifyAwaiting.size && !this.last.replay) {
      for (const item of [...this.notifyAwaiting.values()]) {
        if (this.dataSeq <= item.seq) continue;
        this.notifyAwaiting.delete(item.key);
        this.notifyLater(item).catch((err) => this.log(this.t('ext.log.failed', { what: 'notify', error: errText(err) })));
      }
    }
  }

  /** The item for the session's current wait, from the last rendered data; null when it does not wait */
  currentWait(key) {
    const s = this.byKey.get(key);
    const L = this.needsLamps && this.needsLamps.get(key);
    return s && L && L.lamp === S.LAMP.NEEDS_YOU ? notifyLib.itemFor(s, L) : null;
  }

  /** The user is looking at this chat in this focused window: its tab is the active editor tab, or the panel shows it */
  lookingAt(key) {
    if (!this.windowFocused() || !this.last) return false;
    if (this.agentsView && this.agentsView.visible && this.shownKey === key) return true;
    const info = scopeLib.classifyTab(this.activeTab(), this.tabTypes);
    return !!info && scopeLib.matchChatTab(info, this.last.sessions, this.ws()) === key;
  }

  // Focused window: claim now and show a toast (claimed but not shown for the chat the user is looking at, so no other
  // window reports it either). Unfocused: give a focused window CLAIM_DELAY_MS to claim it first
  notifyNeedsYou(item) {
    if (this.stopped) return;
    const how = notifyLib.plan({ enabled: this.notifyEnabled(), windowFocused: this.windowFocused() });
    if (how === 'toast') {
      if (!notifyLib.claimOnce(this.notifyDir(), item.transitionId, Date.now())) return;
      if (this.lookingAt(item.key)) {
        this.claimSound(item.transitionId); // not shown, and no other window plays it
        return;
      }
      this.needsYouToast(item);
      this.eventSound('needsYou', item.transitionId);
    } else if (how === 'claimLater') {
      this.notifyPending.set(item.key, item.transitionId); // a newer wait of the same session replaces this one
      const pending = { ...item, seq: this.dataSeq, until: Date.now() + notifyLib.CLAIM_DELAY_MS + NOTIFY_FRESH_WAIT_MS };
      // The snapshot that showed the wait can be a background interval old, and nothing new would arrive before the check
      // below: rescan shortly before it (a follower asks the leader, whose next publish is then written even if unchanged)
      this.later(() => {
        if (this.notifyPending.get(item.key) === item.transitionId) this.rescan();
      }, Math.max(0, notifyLib.CLAIM_DELAY_MS - NOTIFY_RESCAN_LEAD_MS));
      this.later(() => this.notifyLater(pending), notifyLib.CLAIM_DELAY_MS);
    }
  }

  /** Scan now, for a check that wants current data: a follower asks the leader, whose next publish is written even if unchanged */
  rescan() {
    if (this.stopped) return;
    if (this.shared) this.shared.requestRefresh();
    else if (this.worker) this.worker.postMessage({ type: 'refresh' });
  }

  /** A notification timer, cleared on shutdown; errors are logged */
  later(fn, ms) {
    const timer = setTimeout(() => {
      this.notifyTimers.delete(timer);
      try {
        Promise.resolve(fn()).catch((err) => this.log(this.t('ext.log.failed', { what: 'notify', error: errText(err) })));
      } catch (err) {
        this.log(this.t('ext.log.failed', { what: 'notify', error: errText(err) }));
      }
    }, ms);
    this.notifyTimers.add(timer);
  }

  // CLAIM_DELAY_MS later, on data scanned after the wait was seen (waits for it, up to NOTIFY_FRESH_WAIT_MS): only if
  // notifications are still on, the session still waits and no window claimed that wait. A system notification unless
  // this window got focus meanwhile (then a toast). Where there is no system notification (Windows, remote windows) or
  // quiet hours mute it, the wait is kept, unclaimed, and shown by the window that gets focus first (the sound, if any,
  // plays now); a failed command falls back to a toast.
  async notifyLater(item) {
    if (this.stopped || this.notifyPending.get(item.key) !== item.transitionId) return;
    if (this.dataSeq <= item.seq && Date.now() < item.until) {
      if (!this.notifyAwaiting.has(item.key)) this.later(() => this.notifyLater(item), item.until - Date.now());
      this.notifyAwaiting.set(item.key, item); // checked again as soon as a newer snapshot is rendered
      return;
    }
    this.notifyAwaiting.delete(item.key);
    this.notifyPending.delete(item.key);
    const cur = this.currentWait(item.key); // its id may have changed meanwhile (e.g. answered, then asked again)
    if (!this.notifyEnabled() || !cur) return;
    const focused = this.windowFocused();
    if (!focused && !this.systemNotice('needsYou')) {
      this.notifyDeferred.set(cur.key, cur);
      this.eventSound('needsYou', cur.transitionId);
      return;
    }
    if (!notifyLib.claimOnce(this.notifyDir(), cur.transitionId, Date.now())) return;
    const msg = notifyLib.formatNeedsYou(cur, this.i18n);
    if (focused) {
      if (this.lookingAt(cur.key)) {
        this.claimSound(cur.transitionId);
        return;
      }
      this.needsYouToast(cur, msg);
      this.eventSound('needsYou', cur.transitionId);
      return;
    }
    this.eventSound('needsYou', cur.transitionId);
    if (!(await notifyLib.sendSystemNotification(msg))) this.needsYouToast(cur, msg);
  }

  /** This window got focus: show the waits kept for lack of a system notification, if they still wait and no window has yet */
  deliverDeferred() {
    if (this.stopped || !this.windowFocused()) return;
    this.deliverDeferredAlerts();
    if (!this.notifyDeferred.size) return;
    const keys = [...this.notifyDeferred.keys()];
    this.notifyDeferred.clear();
    if (!this.notifyEnabled()) return;
    for (const key of keys) {
      const cur = this.currentWait(key);
      if (cur && notifyLib.claimOnce(this.notifyDir(), cur.transitionId, Date.now()) && !this.lookingAt(key)) this.needsYouToast(cur);
    }
  }

  needsYouToast(item, msg = notifyLib.formatNeedsYou(item, this.i18n)) {
    const show = this.t('ext.notify.show');
    Promise.resolve(vscode.window.showInformationMessage(msg.toast, show))
      .then((pick) => (pick === show && !this.stopped ? this.revealSession(item.key) : undefined))
      .catch((err) => this.log(this.t('ext.log.failed', { what: 'notify', error: errText(err) })));
  }

  // "Show": select the session in the bottom panel and reveal it. When this window's scope hides it, it is added to this
  // window's list until the user selects another row or changes the scope (no setting is written)
  async revealSession(key) {
    if (this.byKey.has(key) && !this.currentScoped().some((s) => s.key === key)) {
      this.revealKeys.add(key);
      this.render();
    }
    this.userSelect(key);
    await vscode.commands.executeCommand(`${AGENTS_VIEW}.focus`);
  }

  // ---------- Threshold alerts, sounds and quiet hours ----------

  /** agentMonitor.sound.*: off unless enabled; per event 'default' | 'off' | a sound name (lib/alerts.js SOUND_CHOICES) */
  soundSettings() {
    const c = this.cfg();
    const out = { enabled: c.get('sound.enabled', false) === true };
    for (const e of alertsLib.SOUND_EVENTS) out[e] = c.get(`sound.${e}`, 'default');
    return out;
  }

  /** agentMonitor.quietHours.* in the shape lib/alerts.js reads (days: empty = every day) */
  quietSettings() {
    const c = this.cfg();
    const days = c.get('quietHours.days', []);
    return {
      enabled: c.get('quietHours.enabled', false) === true,
      start: String(c.get('quietHours.start', '22:00')),
      end: String(c.get('quietHours.end', '08:00')),
      days: Array.isArray(days) ? days : [],
      allowErrors: c.get('quietHours.allowErrors', false) === true,
    };
  }

  /** agentMonitor.alerts.*: 0 turns a check off */
  thresholdSettings() {
    const c = this.cfg();
    return alertsLib.normalizeThresholds({
      usagePercent: c.get('alerts.usagePercent', alertsLib.DEFAULT_THRESHOLDS.usagePercent),
      dailyCost: c.get('alerts.dailyCost', alertsLib.DEFAULT_THRESHOLDS.dailyCost),
      contextPercent: c.get('alerts.contextPercent', alertsLib.DEFAULT_THRESHOLDS.contextPercent),
    });
  }

  /** Quiet hours mute this channel ('sound' | 'system' | 'push') for this event type now */
  muted(channel, type) {
    return alertsLib.shouldMute(channel, type, Date.now(), this.quietSettings());
  }

  /** A system notification for this event type can be shown from here now (a notifier, and quiet hours don't mute it) */
  systemNotice(type) {
    return this.systemNotifier() && !this.muted('system', type);
  }

  /**
   * Plays the sound of an event (needsYou, error, done, or a threshold alert type) once across windows: sounds on, the
   * event's sound not 'off', not muted by quiet hours, not a remote window (it would play on the remote machine), and
   * this window claims 'sound|<transitionId>'. playSound adds its own cross-window gap between sounds.
   * @returns {boolean} whether this window plays it
   */
  eventSound(type, transitionId) {
    if (this.stopped || vscode.env.remoteName) return false;
    const event = alertsLib.soundEventOf(type);
    const s = this.soundSettings();
    if (!event || !s.enabled || !alertsLib.resolveSound(event, s[event])) return false;
    if (this.muted('sound', type)) return false;
    const dir = this.notifyDir();
    if (!notifyLib.claimOnce(dir, SOUND_CLAIM_PREFIX + transitionId, Date.now())) return false;
    alertsLib.playSound(event, { sound: s[event], claimDir: dir }).catch(noop); // never rejects; false is not an error here
    return true;
  }

  /** Claims an event's sound without playing it (the user is looking at that chat), so no other window plays it either */
  claimSound(transitionId) {
    notifyLib.claimOnce(this.notifyDir(), SOUND_CLAIM_PREFIX + transitionId, Date.now());
  }

  /**
   * An error or finished work (notify.createLampEventTracker): only a sound; none for finished work in a chat the user is
   * looking at. An unfocused window plays finished work only after CLAIM_DELAY_MS, like "needs you": the window that
   * sees the data first is often not the one the user is in (the leader's own scan comes before the followers' copy), and
   * the focused window must get the chance to claim it silently. After the delay it is checked again here (this window
   * may have got focus and show that chat by then).
   * @param {{ type: 'error'|'done', key: string, transitionId: string }} ev
   * @param {boolean} [delayed] the claim delay is over
   */
  lampSound(ev, delayed = false) {
    if (ev.type === 'done' && !delayed && !this.windowFocused()) {
      this.later(() => this.lampSound(ev, true), notifyLib.CLAIM_DELAY_MS);
      return;
    }
    if (ev.type === 'done' && this.lookingAt(ev.key)) this.claimSound(ev.transitionId);
    else this.eventSound(ev.type, ev.transitionId);
  }

  /**
   * After each render: the threshold tracker gets all sessions, the quota snapshot and today's totals. The first update of
   * each source and every threshold change only seed. Each crossing is reported like a "needs you" wait (notifyAlert).
   * @returns {any[]} the events, also handed to the push runtime
   */
  checkAlerts(sessions) {
    const events = this.thresholds.update({
      sessions, quota: this.last.quota, today: this.last.today, now: Date.now(), cfg: this.thresholdSettings(),
    });
    for (const ev of events) this.notifyAlert(ev);
    return events;
  }

  /**
   * The same path as "needs you": the focused window claims the alert at once and shows a toast; unfocused windows give a
   * focused one CLAIM_DELAY_MS to claim it first, then show a system notification (a toast if that fails). Where there is
   * no system notification, or quiet hours mute it, the alert waits unclaimed for the window that gets focus next.
   */
  notifyAlert(ev) {
    if (this.stopped || !ev || typeof ev.transitionId !== 'string') return;
    if (this.windowFocused()) {
      this.deliverAlert(ev).catch((err) => this.log(this.t('ext.log.failed', { what: 'alerts', error: errText(err) })));
      return;
    }
    this.later(() => this.deliverAlert(ev), notifyLib.CLAIM_DELAY_MS);
  }

  async deliverAlert(ev) {
    if (this.stopped) return;
    const focused = this.windowFocused();
    if (!focused && !this.systemNotice(ev.type)) {
      this.deferAlert(ev);
      this.eventSound(ev.type, ev.transitionId);
      return;
    }
    if (!notifyLib.claimOnce(this.notifyDir(), ev.transitionId, Date.now())) return;
    const msg = alertsLib.formatAlert(ev, this.i18n);
    this.eventSound(ev.type, ev.transitionId);
    if (focused) this.alertToast(ev, msg);
    else if (!(await notifyLib.sendSystemNotification(msg))) this.alertToast(ev, msg);
  }

  deferAlert(ev) {
    this.alertDeferred.delete(ev.transitionId);
    this.alertDeferred.set(ev.transitionId, { ev, at: Date.now() });
    while (this.alertDeferred.size > ALERT_DEFERRED_MAX) this.alertDeferred.delete(this.alertDeferred.keys().next().value);
  }

  /** This window got focus: show the alerts kept for it that no window has shown yet (and that still apply) */
  deliverDeferredAlerts() {
    if (!this.alertDeferred.size) return;
    const list = [...this.alertDeferred.values()];
    this.alertDeferred.clear();
    const now = Date.now();
    for (const { ev, at } of list) {
      if (now - at > ALERT_DEFERRED_MAX_MS) continue;
      if (ev.type === 'usageHigh' && Number.isFinite(ev.resetAt) && ev.resetAt <= now) continue; // that window has reset
      if (!notifyLib.claimOnce(this.notifyDir(), ev.transitionId, now)) continue;
      this.alertToast(ev, alertsLib.formatAlert(ev, this.i18n));
    }
  }

  /** In-window message of an alert; a context alert offers "Show" for its chat */
  alertToast(ev, msg) {
    const show = ev.type === 'contextHigh' && this.byKey.has(ev.key) ? this.t('ext.notify.show') : null;
    Promise.resolve(show ? vscode.window.showInformationMessage(msg.toast, show) : vscode.window.showInformationMessage(msg.toast))
      .then((pick) => (show && pick === show && !this.stopped ? this.revealSession(ev.key) : undefined))
      .catch((err) => this.log(this.t('ext.log.failed', { what: 'alerts', error: errText(err) })));
  }

  // ---------- Remote push ----------

  // The runtime (lib/push-runtime.js) and the agentMonitor.push.setup command (lib/push-setup.js); if either fails to
  // load, the command explains that push is unavailable and nothing is ever sent
  setupPush() {
    const context = this.context;
    let runtimeLib = null;
    let setupLib = null;
    try {
      runtimeLib = require('./lib/push-runtime');
      setupLib = require('./lib/push-setup');
    } catch (err) {
      this.log(this.t('ext.log.moduleFailed', { module: 'push', error: errText(err) }));
    }
    const secrets = context.secrets || null;
    if (runtimeLib && typeof runtimeLib.createPushRuntime === 'function') {
      try {
        this.push = runtimeLib.createPushRuntime({
          read: () => this.pushSettings(),
          secret: (key) => (secrets ? secrets.get(key) : undefined),
          claimDir: () => this.notifyDir(),
          i18n: this.i18n,
          log: (line) => this.log(line),
          warn: (text) => this.pushWarn(text),
          notice: (text) => { Promise.resolve(vscode.window.showInformationMessage(text)).catch(noop); },
          rescan: () => this.rescan(),
          mute: (type) => this.muted('push', type), // quiet hours
        });
      } catch (err) {
        this.push = null;
        this.log(this.t('ext.log.moduleFailed', { module: 'push', error: errText(err) }));
      }
    }
    context.subscriptions.push(vscode.commands.registerCommand(PUSH_CMD, () => {
      if (!this.push || !setupLib || typeof setupLib.runPushSetup !== 'function') {
        vscode.window.showErrorMessage(this.t('ext.pushUnavailable'));
        return undefined;
      }
      return Promise.resolve(setupLib.runPushSetup({
        i18n: this.i18n,
        secrets,
        globalState: context.globalState,
        read: () => this.pushSettings(),
        write: (key, value) => this.cfg().update(key, value, vscode.ConfigurationTarget.Global),
        runtime: this.push,
        openSettings: () => vscode.commands.executeCommand('workbench.action.openSettings', 'agentMonitor.push'),
      })).catch((err) => this.pushSetupFailed(err));
    }));
  }

  /** The setup flow failed (e.g. settings.json can't be written, or the keychain refused): say so, not only in the log */
  pushSetupFailed(err) {
    this.log(this.t('ext.log.failed', { what: 'push', error: errText(err) }));
    if (this.stopped) return;
    const show = this.t('push.ui.showOutput');
    const error = String((err && err.message) || err).split('\n')[0].slice(0, 300); // the stack is in the output
    Promise.resolve(vscode.window.showErrorMessage(this.t('push.ui.setupFailed', { error }), show))
      .then((pick) => { if (pick === show && this.output) this.output.show(true); })
      .catch(noop);
  }

  /** Push settings from user settings only: a workspace value is ignored (inspect().globalValue), defaults in lib/push.js */
  pushSettings() {
    const c = this.cfg();
    const g = (k) => {
      try {
        const i = c.inspect(k);
        return i ? i.globalValue : undefined;
      } catch {
        return undefined;
      }
    };
    const channels = g('push.channels');
    return {
      enabled: g('push.enabled') === true,
      events: g('push.events'),
      delaySeconds: g('push.delaySeconds'),
      includeTitle: g('push.includeTitle') === true,
      channels: Array.isArray(channels) ? channels : [],
    };
  }

  /** The network switch, from user settings only: a workspace value is ignored (inspect().globalValue); off unless exactly true */
  networkAllowed() {
    try {
      const i = this.cfg().inspect(NETWORK_KEY);
      return !!i && i.globalValue === true;
    } catch {
      return false;
    }
  }

  /**
   * agentMonitor.network.allow / .block / .toggle: writes the switch to user settings and says what it means now.
   * Blocking keeps push.enabled as it is (push is paused until the network is allowed again).
   */
  async setNetwork(allow) {
    try {
      await this.cfg().update(NETWORK_KEY, !!allow, vscode.ConfigurationTarget.Global);
    } catch (err) {
      this.log(this.t('ext.log.failed', { what: 'network', error: errText(err) }));
      const error = String((err && err.message) || err).split('\n')[0].slice(0, 300);
      Promise.resolve(vscode.window.showErrorMessage(this.t('push.net.failed', { error }))).catch(noop);
      return;
    }
    this.setContext('networkAllowed', this.networkAllowed());
    const paused = !allow && this.pushSettings().enabled;
    const key = allow ? 'push.net.allowed' : paused ? 'push.net.blockedPaused' : 'push.net.blocked';
    Promise.resolve(vscode.window.showInformationMessage(this.t(key))).catch(noop);
  }

  /** A channel keeps failing: one warning (the runtime does not repeat it until a send works again) */
  pushWarn(text) {
    if (this.stopped) return;
    const open = this.t('push.ui.openSetup');
    Promise.resolve(vscode.window.showWarningMessage(text, open))
      .then((pick) => (pick === open && !this.stopped ? vscode.commands.executeCommand(PUSH_CMD) : undefined))
      .catch((err) => this.log(this.t('ext.log.failed', { what: 'push', error: errText(err) })));
  }

  // ---------- Session list position and width ----------

  /** Which side the list is on: setting sessionListPosition; auto follows terminal.integrated.tabs.location (default right) */
  listPosition() {
    const setting = String(this.cfg().get('sessionListPosition', 'auto'));
    const term = String(vscode.workspace.getConfiguration('terminal.integrated').get('tabs.location', 'right'));
    const m = this.agentsMod;
    if (m && typeof m.resolveListPosition === 'function') return m.resolveListPosition(setting, term);
    return setting === 'left' || setting === 'right' ? setting : (term === 'left' ? 'left' : 'right');
  }

  loadListWidth() {
    const gs = this.context.globalState;
    const v = gs && gs.get(LIST_WIDTH_KEY);
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  }

  /** The page finished dragging the divider (width already snapped): save to globalState so it survives reloads; write only if changed */
  setListWidth(width) {
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return;
    if (width === this.listWidth) return;
    this.listWidth = width;
    const gs = this.context.globalState;
    if (gs) Promise.resolve(gs.update(LIST_WIDTH_KEY, width)).catch(noop);
    this.updateAgents(Date.now());
  }

  updateAgents(now) {
    const v = this.agentsView;
    if (!v || typeof v.update !== 'function') return;
    const st = this.settings();
    if (typeof v.updateList === 'function') {
      this.guard('list', () => v.updateList({
        arranged: this.last ? this.arranged : null,
        lamps: this.lamps ? this.lamps.bySession : undefined,
        now,
        hints: { start: st.contextHintStart, act: st.contextHintAct },
        showCost: st.showCost,
        selectedKey: this.selectedKey,
        position: this.listPosition(),
        width: this.listWidth,
      }));
    }
    if (!this.last) {
      this.guard('agents', () => v.update({ session: null, loaded: false, now, settings: st }));
      return;
    }
    const key = this.shownKey;
    const s = key ? this.byKey.get(key) || null : null;
    const scope = this.scope();
    const empty = !this.scoped.length;
    this.guard('agents', () => v.update({
      session: s,
      detail: (s && this.last.details && this.last.details[key]) || null,
      lamps: s && this.lamps ? this.lamps.bySession.get(key) : undefined,
      now,
      today: this.last.today || null,
      quota: this.last.quota || null,
      settings: st,
      loaded: true,
      emptyText: empty ? emptyText(scope, this.ws(), this.i18n) : undefined,
      // Workspace scope but no sessions in the workspace: offer "Show all sessions" in the empty state
      emptyAction: empty && scope === scopeLib.SCOPE.WORKSPACE ? 'showAll' : null,
    }));
  }

  // Status-bar overall lamp: color = overall lamp; warning / error background on NeedsYou / Error (can be turned off)
  updateStatusBar(now) {
    const item = this.statusItem;
    const c = this.cfg();
    if (!c.get('showStatusBar', true)) {
      item.hide();
      this.chrome.barSig = null;
      return;
    }
    const L = this.lamps;
    const i18n = this.i18n;
    const text = fmt.formatStatusBarText(L.counts, i18n);
    const colorId = S.LAMP_COLOR_ID[L.overall] || S.LAMP_COLOR_ID.idle;
    let bg = null;
    if (c.get('statusBarBackground', true) !== false) {
      if (L.overall === S.LAMP.NEEDS_YOU) bg = 'statusBarItem.warningBackground';
      else if (L.overall === S.LAMP.ERROR) bg = 'statusBarItem.errorBackground';
    }
    const md = this.statusTooltip(now, c.get('showCost', true) !== false);
    const sig = [text, colorId, bg, md].join('\u0001');
    if (sig !== this.chrome.barSig) {
      this.chrome.barSig = sig;
      item.text = text;
      item.color = new vscode.ThemeColor(colorId);
      item.backgroundColor = bg ? new vscode.ThemeColor(bg) : undefined;
      item.tooltip = new vscode.MarkdownString(md, true);
      item.accessibilityInformation = { label: text.replace(/\$\([^)]*\)\s*/g, '') };
    }
    item.show();
  }

  statusTooltip(now, showCost) {
    const i18n = this.i18n;
    const ordered = this.leftKeys.map((k) => this.byKey.get(k)).filter(Boolean);
    const parts = [`**${esc(i18n.t('bar.title'))}**`];
    const lines = fmt.formatStatusBarLines(ordered, this.lamps.bySession, i18n, now);
    if (lines.length) parts.push(lines.map((l) => '- ' + esc(l)).join('\n'));
    const q = this.last.quota || {};
    if (q.codex && ((q.codex.windows && q.codex.windows.length) || q.codex.reachedType)) {
      const cq = fmt.formatCodexQuota(q.codex, i18n, now);
      parts.push(`${esc(cq.title)}  \n${cq.lines.map(esc).join('  \n')}`);
    }
    for (const hit of fmt.formatLastHits(q, i18n, now)) parts.push(esc(hit));
    if (showCost && this.last.today) {
      const today = fmt.formatToday(this.last.today, i18n);
      parts.push(esc([i18n.t('bar.today', { usd: today.text }), today.partialText].filter(Boolean).join(fmt.SEP)));
    }
    // Quiet hours: say so while they are on (sounds, system notifications and push are held)
    const quiet = this.guard('quietHours', () => alertsLib.formatQuietStatus(now, this.quietSettings(), i18n));
    if (quiet) parts.push(`$(bell-slash) ${esc(quiet)}`);
    return parts.join('\n\n');
  }

  // View chrome: badge (sidebar tree, and the hidden panel tree so it shows on the panel tab), description next to the title, empty-state context key (used by the overview tree's welcome view)
  updateChrome() {
    const i18n = this.i18n;
    const loaded = !!this.last;
    const scope = this.scope();
    const noFolder = !(vscode.workspace.workspaceFolders || []).length;
    this.setContext('loaded', loaded);
    this.setContext('filteredOut', loaded && scope === scopeLib.SCOPE.WORKSPACE && this.scoped.length === 0);
    this.setContext('noFolder', noFolder);

    const b = loaded && this.lamps ? fmt.formatBadge(this.lamps.counts, i18n) : { value: 0, tooltip: '' };
    const badge = b.value ? { value: b.value, tooltip: b.tooltip } : undefined;
    const bSig = badge ? `${badge.value}\u0001${badge.tooltip}` : '';
    const av = this.agentsView;
    if (bSig !== this.chrome.sBadge) { this.chrome.sBadge = bSig; this.panelTree.badge = badge; }
    if (bSig !== this.chrome.tBadge) { this.chrome.tBadge = bSig; this.treeView.badge = badge; }

    const scopeText = scope === scopeLib.SCOPE.WORKSPACE ? fmt.formatScope(scope, i18n).label : '';
    const sDesc = scopeText || undefined;
    if (sDesc !== this.chrome.sDesc && av && typeof av.setDescription === 'function') { this.chrome.sDesc = sDesc; av.setDescription(sDesc); }
    const tDesc = [scopeText, this.settings().hideCompleted ? i18n.t('tree.hideCompleted') : ''].filter(Boolean).join(fmt.SEP) || undefined;
    if (tDesc !== this.chrome.tDesc) { this.chrome.tDesc = tDesc; this.treeView.description = tDesc; this.panelTree.description = tDesc; }
  }

  setContext(key, value) {
    if (this.chrome.contexts[key] === value) return;
    this.chrome.contexts[key] = value;
    Promise.resolve(vscode.commands.executeCommand('setContext', `agentMonitor.${key}`, value)).catch(noop);
  }

  // ---------- Current-conversation following and "seen" dwell timers ----------

  activeTab() {
    const tg = vscode.window.tabGroups;
    const g = tg && tg.activeTabGroup;
    return (g && g.activeTab) || null;
  }

  windowFocused() {
    const s = vscode.window.state;
    return !s || s.focused !== false;
  }

  // Tab-switch events (onDidChangeTabs / onDidChangeTabGroups / onDidChangeWindowState) and the first snapshot
  onTabs(initial = false) {
    if (!this.last || !this.follower) return;
    const before = this.follower.key;
    const r = this.guard('follow', () => this.follower.onTabEvent(this.activeTab(), this.currentScoped(), this.ws()));
    let moved = false;
    if (r && r.follow && r.key && this.cfg().get('followActiveChat', true) !== false) {
      // select even if the key didn't change: the user may have just clicked another session
      this.select(r.key);
      moved = true;
    }
    if (initial) return; // on the first snapshot, onSnapshot renders everything right after
    // Tab events are frequent (title changes, dirty markers, ...): recompute everything only if the selection or current conversation changed; otherwise just update the dwell timers
    if (moved || this.follower.key !== before) this.render();
    else this.updateTabDwell();
  }

  followOnSnapshot() {
    const r = this.guard('follow', () => this.follower.onSnapshot(this.activeTab(), this.currentScoped(), this.ws()));
    if (r && r.follow && r.key && this.cfg().get('followActiveChat', true) !== false) this.select(r.key);
  }

  // A chat tab is the active tab and the window is focused for 1.5 s -> seen
  updateTabDwell() {
    let key = null;
    if (this.last && this.windowFocused()) {
      const info = scopeLib.classifyTab(this.activeTab(), this.tabTypes);
      if (info) key = scopeLib.matchChatTab(info, this.scoped, this.ws());
    }
    this.dwell.set('tab', key);
  }

  // The agents view shows that session, is visible, and the window is focused for 1.5 s -> seen
  updateViewDwell() {
    if (!this.dwell) return;
    const visible = !!(this.agentsView && this.agentsView.visible);
    this.dwell.set('view', visible && this.windowFocused() ? this.shownKey : null);
  }

  // ---------- Commands ----------

  /** Command argument -> session key: an overview tree node, { sessionKey } from the webview context menu (data-vscode-context), or a sessionKey string */
  keyOf(arg) {
    if (typeof arg === 'string') return this.byKey.has(arg) ? arg : null;
    if (!arg || typeof arg !== 'object') return null;
    for (const v of [arg.key, arg.sessionKey, arg.session && arg.session.key, arg.extra && arg.extra.session && arg.extra.session.key]) {
      if (typeof v === 'string' && this.byKey.has(v)) return v;
    }
    return null;
  }

  markSeen(arg) {
    const key = this.keyOf(arg) || this.shownKey;
    if (!key) return undefined;
    return Promise.resolve(this.seen.mark(key)).then(() => this.render());
  }

  markAllSeen() {
    const keys = this.scoped.map((s) => s.key);
    if (!keys.length) return undefined;
    return Promise.resolve(this.seen.markMany(keys)).then(() => this.render());
  }

  // Transcript files present in the current snapshot (checked before opening; arbitrary paths are never opened)
  knownTranscripts() {
    const set = new Set();
    for (const s of this.byKey.values()) {
      const add = (a) => { if (a && typeof a.file === 'string') set.add(a.file); };
      add(s.main);
      for (const a of s.agents || []) add(a);
      for (const w of s.workflows || []) for (const a of w.agents || []) add(a);
    }
    return set;
  }

  openTranscript(arg) {
    let file = null;
    if (arg && typeof arg === 'object' && typeof arg.sessionKey === 'string') {
      // Context menu / "..." of the bottom panel's session list: the argument is the data-vscode-context object { webviewSection, sessionKey, ... }
      const s = this.byKey.get(arg.sessionKey);
      file = s && s.main && s.main.file;
    } else if (arg && typeof arg === 'object') {
      if (arg.kind === 'session' && arg.data) file = arg.data.main && arg.data.main.file;               // overview tree session
      else if ((arg.kind === 'main' || arg.kind === 'agent') && arg.data) file = arg.data.file;         // overview tree agent
    } else if (typeof arg === 'string') {
      const s = this.byKey.get(arg);
      file = s && s.main && s.main.file;
    }
    if (typeof file !== 'string' || !file.endsWith('.jsonl') || !path.isAbsolute(file)) return undefined;
    if (!this.knownTranscripts().has(file)) return undefined;
    if (!isFile(file)) {
      vscode.window.showWarningMessage(this.t('ext.transcriptMissing'));
      return undefined;
    }
    return vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
  }

  /** Command argument -> the session's main transcript path (uses snapshot data only; never accepts a path from outside) */
  transcriptFor(arg) {
    const key = this.keyOf(arg) || (arg == null ? this.shownKey : null);
    const s = key ? this.byKey.get(key) : null;
    const file = transcriptOf(s);
    return file ? { key, session: s, file } : null;
  }

  // Reveal the main transcript in Finder / Explorer
  revealTranscript(arg) {
    const r = this.transcriptFor(arg);
    if (!r) return undefined;
    if (!isFile(r.file)) {
      vscode.window.showWarningMessage(this.t('ext.transcriptMissing'));
      return undefined;
    }
    return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(r.file));
  }

  // Copy the main transcript path
  async copyTranscriptPath(arg) {
    const r = this.transcriptFor(arg);
    if (!r) return;
    await vscode.env.clipboard.writeText(r.file);
    vscode.window.showInformationMessage(this.t('ext.transcriptPathCopied'));
  }

  /**
   * Without an argument (Command Palette), pick a session first: the currently selected one is listed first and marked.
   * @param {(s: any) => boolean} [filter]
   * @returns {Promise<string|null>}
   */
  async pickSessionKey(filter) {
    const list = this.leftKeys.map((k) => this.byKey.get(k)).filter((s) => s && (!filter || filter(s)));
    if (!list.length) {
      vscode.window.showInformationMessage(this.t('ext.noSessions'));
      return null;
    }
    const current = this.selectedKey || this.shownKey;
    list.sort((a, b) => Number(b.key === current) - Number(a.key === current)); // stable sort: only moves the current one to the front
    const items = list.map((s) => ({
      label: String(s.title || s.id || ''),
      description: [s.key === current ? this.t('ext.pickSession.selected') : '', fmt.providerLabel(s.provider, this.i18n)].filter(Boolean).join(fmt.SEP),
      key: s.key,
    }));
    const it = await vscode.window.showQuickPick(items, { placeHolder: this.t('ext.pickSession'), matchOnDescription: true });
    return it ? it.key : null;
  }

  /**
   * Command titles (as shown in the context menu): package.nls.json, overridden by package.nls.<locale>.json for the UI language.
   * VS Code has no API for reading contributed command titles, so we read them once following its rules (only files in the extension's own directory).
   */
  commandTitles() {
    if (this.cmdTitles) return this.cmdTitles;
    const out = new Map();
    const root = this.context.extensionPath;
    const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch { return {}; } };
    const nls = { ...read('package.nls.json') };
    const loc = this.i18n.locale;
    if (loc && loc !== 'en') Object.assign(nls, read(`package.nls.${loc}.json`));
    const cmds = (PKG.contributes && PKG.contributes.commands) || [];
    const val = (v) => String(v || '').replace(/^%([\w.-]+)%$/, (m, k) => (typeof nls[k] === 'string' ? nls[k] : m));
    for (const c of cmds) out.set(c.command, { title: val(c.title), icon: typeof c.icon === 'string' ? c.icon : '' });
    this.cmdTitles = out;
    return out;
  }

  /**
   * The "..." at the end of a session row: shows a QuickPick with the same items as the context menu (same SESSION_MENU list,
   * same compactable / resumable conditions), then runs the chosen command with the same argument as the context menu, { webviewSection, sessionKey }.
   */
  async sessionMenu(key) {
    const s = typeof key === 'string' ? this.byKey.get(key) : null;
    const m = this.agentsMod;
    if (!s || !m || typeof m.sessionMenuItems !== 'function') return;
    const L = this.lamps && this.lamps.bySession.get(key);
    const flags = m._internal && typeof m._internal.flagsOf === 'function'
      ? m._internal.flagsOf(fmt.sessionContextValue(s, L ? L.lamp : undefined)) : {};
    const titles = this.commandTitles();
    const items = [];
    let group = null;
    for (const it of m.sessionMenuItems(flags)) {
      if (group !== null && it.group !== group) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      group = it.group;
      const c = titles.get(it.command) || { title: it.command, icon: '' };
      items.push({ label: (c.icon ? c.icon + ' ' : '') + c.title, command: it.command });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: String(s.title || s.id || '') });
    if (!pick || !pick.command) return;
    await vscode.commands.executeCommand(pick.command, { webviewSection: 'session', sessionKey: key });
  }

  // Switch task: write a handoff note, then start a new session. The flow lives in runHandoff in compact.js
  async handoff(arg) {
    const api = this.compactApi;
    const run = (api && typeof api.runHandoff === 'function' && api.runHandoff.bind(api))
      || (this.compactMod && typeof this.compactMod.runHandoff === 'function' && this.compactMod.runHandoff);
    if (!run) {
      vscode.window.showErrorMessage(this.t('ext.handoffUnavailable'));
      return;
    }
    const key = this.keyOf(arg) || await this.pickSessionKey((s) => s.provider === 'claude' || s.provider === 'codex');
    if (!key) return;
    await run(key);
  }

  // Resume: the extension regenerates the text from current data, then writes it to the clipboard
  async copyResume(arg) {
    const i18n = this.i18n;
    const key = this.keyOf(arg) || this.shownKey;
    const s = key ? this.byKey.get(key) : null;
    const hints = (s && s.resume) || [];
    if (!hints.length) {
      vscode.window.showInformationMessage(this.t('ext.noResume'));
      return;
    }
    const now = Date.now();
    const items = [];
    hints.forEach((hint, index) => {
      const f = fmt.formatResumeHint(hint, i18n, { now, platform: process.platform });
      const detail = [f.noteText, f.estimateText].filter(Boolean).join(' ');
      if (!f.variants.length) { items.push({ label: f.label, detail, f, variant: null, index }); return; }
      for (const variant of f.variants) {
        items.push({ label: f.label, description: this.t('resume.variant.' + variant), detail, f, variant, index });
      }
    });
    const chosen = items.length === 1
      ? items[0]
      : await vscode.window.showQuickPick(items, { placeHolder: this.t('ext.pickResume'), matchOnDetail: true });
    if (!chosen) return;
    if (!chosen.variant) {
      if (chosen.f.noteText) vscode.window.showInformationMessage(chosen.f.noteText);
      return;
    }
    const text = chosen.variant === 'cli' ? chosen.f.command : chosen.f.prompt;
    if (!text) return;
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(this.t(chosen.variant === 'cli' ? 'resume.copied.cli' : 'resume.copied'));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyText(scope, ws, i18n) {
  if (scope === scopeLib.SCOPE.WORKSPACE && !ws.paths.length) return i18n.t('scope.noFolder');
  return fmt.formatScope(scope, i18n).empty;
}

// Placeholder page when the agents-view module fails to load: a single line of explanation (plain text, no scripts)
function fallbackAgentsView(message) {
  return {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: false };
      const text = String(message).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      view.webview.html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
        + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\';"></head>'
        + `<body><p>${text}</p></body></html>`;
    },
  };
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** The session's main transcript path: the provider's transcript, else the main conversation's file; must be absolute */
function transcriptOf(s) {
  if (!s) return '';
  const p = typeof s.transcript === 'string' && s.transcript ? s.transcript
    : s.main && typeof s.main.file === 'string' ? s.main.file : '';
  return p && path.isAbsolute(p) ? p : '';
}

/**
 * Observed auto-compaction points in a snapshot: preTokens of the Claude main conversation's latest trigger === 'auto',
 * grouped by `${model}|${window}` (same shape as observedKey in core/context.js), keeping the latest per group.
 * Sessions whose compaction point comes from settings are skipped (that is a configured value, not the model default).
 * @param {any[]} sessions
 * @returns {Map<string, { tokens: number, ms: number, model: string, window: number }>}
 */
function observedCompactsOf(sessions) {
  const out = new Map();
  for (const s of sessions || []) {
    if (!s || s.provider !== 'claude') continue;
    if (typeof s.compactAtSource === 'string' && (s.compactAtSource.startsWith('settings') || s.compactAtSource === 'disabled')) continue;
    const main = s.main || {};
    const lc = main.lastCompact;
    if (!lc || lc.trigger !== 'auto') continue;
    const tokens = Number(lc.preTokens);
    const ms = Number(lc.ms);
    const model = String(lc.model || main.model || s.model || '');
    const tk = main.tokens || {};
    // Window: prefer lastCompact.contextWindow computed by the provider for the model at compaction time (differs from the session's current window if the model was switched mid-session)
    const window = Number(lc.contextWindow) > 0 ? Number(lc.contextWindow)
      : Number(s.contextWindow) > 0 ? Number(s.contextWindow) : Number(tk.contextWindow);
    if (!model || !(tokens > 0) || !Number.isFinite(ms) || !(window > 0)) continue;
    const key = `${model}|${window}`;
    const prev = out.get(key);
    if (!prev || ms > prev.ms) out.set(key, { tokens: Math.round(tokens), ms, model, window });
  }
  return out;
}

/**
 * The VS Code user dir (…/Code/User) derived from the extension's global storage: <User>/globalStorage/<extension id>, or
 * <User>/profiles/<profile>/globalStorage/<extension id> in a profile. null when the path does not look like that (the
 * Copilot provider then uses its default dirs).
 * @param {{ scheme?: string, fsPath?: string }|undefined} globalStorageUri
 * @returns {string|null}
 */
function vscodeUserDir(globalStorageUri) {
  const u = globalStorageUri;
  if (!u || (u.scheme && u.scheme !== 'file') || typeof u.fsPath !== 'string' || !u.fsPath) return null;
  const gs = path.dirname(u.fsPath);
  if (path.basename(gs) !== 'globalStorage') return null;
  let user = path.dirname(gs);
  if (path.basename(path.dirname(user)) === 'profiles') user = path.dirname(path.dirname(user));
  return user && user !== gs ? user : null;
}

function expandHome(p, home) {
  const s = typeof p === 'string' ? p.trim() : '';
  if (!s) return '';
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2));
  return s;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function errText(err) {
  return (err instanceof Error && err.stack) || String(err);
}

module.exports = { activate, deactivate, _controller: () => ctl, _internal: { observedCompactsOf, transcriptOf, vscodeUserDir } };
