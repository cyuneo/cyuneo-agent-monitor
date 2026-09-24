'use strict';
// VS Code entry point: wires the modules together.
// - The bottom panel works like the terminal panel: a single webview view agentMonitor.agents (lib/agents-view.js),
//   with a session list on one side (like the terminal tab list) and the selected session's agents in the other part.
//   The list's side follows the terminal tab list's position (configurable); its width is draggable and saved in
//   globalState. The extension owns the selection and pushes it to the page; clicking a session shows it in the
//   content area, and the selection sticks until the user clicks another one (or switches to another chat tab, followActiveChat).
// - Sidebar overview tree agentMonitor.tree (lib/tree.js); overall lamp in the status bar; two viewing scopes (all / workspace).
// - Scanning runs on a worker thread (lib/worker.js; messages: config / focus / refresh / storage).
// - lib/compact.js registers the compact command agentMonitor.compact itself; here we only call activateCompact on
//   activation and forward every snapshot to it. The handoff-note command agentMonitor.handoff is registered here and
//   calls runHandoff exported by compact.js.
// - lib/autocompact.js registers the auto-compact capacity command agentMonitor.setAutoCompact itself.
// - Storage locations and usage: agentMonitor.storage opens the page in lib/storage-view.js; the scan runs in the worker.
// - Observed compaction points: whenever a snapshot shows a new auto-compaction, record it in globalState under
//   "model|window" and pass it to the worker with the next config.
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

const PKG = require('./package.json');
const VERSION = PKG.version;
const EXT_ID = 'cyuneo.cyuneo-agent-monitor';
const AGENTS_VIEW = 'agentMonitor.agents';
const TREE_VIEW = 'agentMonitor.tree';
const INTRO_KEY = 'agentMonitor.panelIntro.v1';     // globalState: the bottom panel was focused on first activation
const LIST_WIDTH_KEY = 'agentMonitor.sessionListWidth';   // globalState: width of the session list in the bottom panel
const OBSERVED_KEY = 'agentMonitor.observedCompact';       // globalState: { 'model|window': observed auto-compaction point }
const OBSERVED_AT_KEY = 'agentMonitor.observedCompactAt';  // globalState: { 'model|window': time of that compaction }, so only newer observations replace older ones
const COMPACT_CMD = 'agentMonitor.compact';
const AUTOCOMPACT_CMD = 'agentMonitor.setAutoCompact';
const HANDOFF_CMD = 'agentMonitor.handoff';
const STORAGE_CMD = 'agentMonitor.storage';
const STORAGE_WAIT_MS = 120000; // the storage scan stats recursively; large dirs can take tens of seconds
// Settings that require rebuilding the worker; other settings just recompute from the last snapshot on the main thread
const MONITOR_KEYS = [
  'refreshSeconds', 'activeWindowMinutes', 'staleMinutes',
  'claude.enabled', 'claude.projectsDir', 'codex.enabled', 'codex.home',
  'approvalGuess', 'approvalGuessSeconds',
];
const WORKER_RETRIES = 3;
// Memory limits for the worker thread: parsing transcripts creates almost only short-lived temporary objects, so capping
// the young generation at 6MB keeps the heap from ballooning during scans without slowing them down; the 512MB old
// generation is only a safety net (normal use is far below it); if exceeded, V8 terminates the thread and it is
// restarted up to WORKER_RETRIES times
const WORKER_LIMITS = Object.freeze({ maxYoungGenerationSizeMb: 6, maxOldGenerationSizeMb: 512 });
const REFRESH_WAIT_MS = 10000;
const noop = () => {};

let ctl = null;

function activate(context) {
  ctl = new Controller(context);
  ctl.activate();
}

function deactivate() {
  if (ctl) ctl.stopWorker();
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
    this.setupCompact();
    this.setupAutoCompact();
    this.setupStorage();
    this.listen();

    this.updateChrome();
    this.updateAgents(Date.now());
    this.introFocus();
    this.startWorker();
    sub({ dispose: () => this.stopWorker() });
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
  }

  listen() {
    const sub = (...d) => this.context.subscriptions.push(...d);
    sub(
      vscode.workspace.onDidChangeConfiguration((e) => this.onConfig(e)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.render()),
      vscode.window.onDidChangeWindowState(() => { this.onTabs(); this.updateViewDwell(); }),
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

  ws() { return scopeLib.workspaceInfo(vscode.workspace.workspaceFolders); }

  settings() {
    const c = this.cfg();
    return {
      hideCompleted: !!c.get('hideCompleted', false),
      showCost: c.get('showCost', true) !== false,
      contextHintStart: num(c.get('contextHintStart', 200000), 200000),
      contextHintAct: num(c.get('contextHintAct', 500000), 500000),
    };
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
    return {
      intervalMs: Math.max(1, num(c.get('refreshSeconds', 2), 2)) * 1000,
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
      approvalGuess: c.get('approvalGuess', S.APPROVAL_GUESS.FAST_TOOLS),
      approvalGuessSeconds: num(c.get('approvalGuessSeconds', S.APPROVAL_GUESS_DEFAULT_SECONDS), S.APPROVAL_GUESS_DEFAULT_SECONDS),
      observedCompact: { ...this.observed },
    };
  }

  onConfig(e) {
    // Which side the session list is on: auto follows the terminal tab list position, so changes to that terminal setting are pushed to the page too
    if (!e.affectsConfiguration('agentMonitor')) {
      if (e.affectsConfiguration('terminal.integrated.tabs.location')) this.updateAgents(Date.now());
      return;
    }
    const hit = (keys) => keys.some((k) => e.affectsConfiguration(`agentMonitor.${k}`));
    if (hit(MONITOR_KEYS) && this.worker) this.worker.postMessage({ type: 'config', cfg: this.workerConfig() });
    if (e.affectsConfiguration('agentMonitor.onlyWorkspace')) this.migrateScope();
    this.render(); // scope, hide-completed, cost, status bar, etc.: recompute from the last snapshot now instead of waiting for the next scan
  }

  // ---------- worker ----------

  startWorker(retries = 0) {
    const w = new Worker(path.join(this.context.extensionPath, 'lib', 'worker.js'), { workerData: this.workerConfig(), resourceLimits: WORKER_LIMITS });
    this.worker = w;
    this.focusSig = null; // new worker: tell it again which sessions need details
    w.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'snapshot') {
        this.guard('snapshot', () => this.onSnapshot(m));
        for (const done of this.waiters.splice(0)) done();
      } else if (m.type === 'storage') this.onStorage(m);
      else if (m.type === 'error') this.log(this.t('ext.log.source', { source: String(m.source || 'worker'), message: String(m.message || '') }));
    });
    w.on('error', (err) => this.log(this.t('ext.log.workerError', { error: errText(err) })));
    w.on('exit', (code) => {
      if (w !== this.worker) return; // stopped on purpose or already replaced
      this.worker = null;
      if (code !== 0 && retries < WORKER_RETRIES) {
        this.log(this.t('ext.log.workerExit', { code }));
        this.startWorker(retries + 1);
      }
    });
    this.sendFocus();
    // If someone is still waiting for a storage scan when the worker was replaced, ask the new worker again
    if (this.storageWaiters.length) w.postMessage({ type: 'storage', force: this.storageForce });
  }

  stopWorker() {
    const w = this.worker;
    this.worker = null;
    if (w) w.terminate();
  }

  // Ask the worker to rescan now; restart it if it died. The progress indicator spins until the next snapshot arrives
  refresh() {
    if (this.worker) this.worker.postMessage({ type: 'refresh' });
    else this.startWorker();
    const next = new Promise((resolve) => {
      const timer = setTimeout(resolve, REFRESH_WAIT_MS); // don't let the progress indicator spin forever if the worker never answers
      if (timer && typeof timer.unref === 'function') timer.unref();
      this.waiters.push(() => { clearTimeout(timer); resolve(); });
    });
    const panelVisible = !!(this.agentsView && this.agentsView.visible);
    const viewId = panelVisible || !this.treeView.visible ? AGENTS_VIEW : TREE_VIEW;
    return vscode.window.withProgress({ location: { viewId } }, () => next);
  }

  sendFocus() {
    const keys = [...new Set([this.shownKey, this.follower && this.follower.key].filter(Boolean))];
    const sig = keys.join('\n');
    if (sig === this.focusSig) return;
    this.focusSig = sig;
    if (this.worker) this.worker.postMessage({ type: 'focus', keys });
  }

  onSnapshot(m) {
    const first = !this.last;
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
    if (changed && this.worker) this.worker.postMessage({ type: 'config', cfg: this.workerConfig() });
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

  /** Open sessions (checked before migrating): Claude by liveness in the registry, Codex by a turn in progress */
  liveSessions() {
    const out = [];
    for (const s of this.byKey.values()) {
      if (s && s.live) out.push({ provider: s.provider, sessionId: String(s.id || ''), title: String(s.title || s.id || '') });
    }
    return out;
  }

  // ---------- Rendering ----------

  currentScoped() {
    return this.last ? scopeLib.filterByScope(this.last.sessions, this.scope(), this.ws()) : [];
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
    this.selectedKey = key;
    Promise.resolve(this.seen.mark(key)).then((changed) => { if (changed) this.render(); }, noop);
    this.render();
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
    const hit = q.claude && fmt.formatClaudeLastHit(q.claude.lastHit, i18n, now);
    if (hit) parts.push(esc(hit));
    if (showCost && this.last.today) {
      const today = fmt.formatToday(this.last.today, i18n);
      parts.push(esc([i18n.t('bar.today', { usd: today.text }), today.partialText].filter(Boolean).join(fmt.SEP)));
    }
    return parts.join('\n\n');
  }

  // View chrome: badge (on the bottom panel's webview view), description next to the title, empty-state context key (used by the overview tree's welcome view)
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
    if (bSig !== this.chrome.sBadge && av && typeof av.setBadge === 'function') { this.chrome.sBadge = bSig; av.setBadge(badge); }
    if (bSig !== this.chrome.tBadge) { this.chrome.tBadge = bSig; this.treeView.badge = badge; }

    const scopeText = scope === scopeLib.SCOPE.WORKSPACE ? fmt.formatScope(scope, i18n).label : '';
    const sDesc = scopeText || undefined;
    if (sDesc !== this.chrome.sDesc && av && typeof av.setDescription === 'function') { this.chrome.sDesc = sDesc; av.setDescription(sDesc); }
    const tDesc = [scopeText, this.settings().hideCompleted ? i18n.t('tree.hideCompleted') : ''].filter(Boolean).join(fmt.SEP) || undefined;
    if (tDesc !== this.chrome.tDesc) { this.chrome.tDesc = tDesc; this.treeView.description = tDesc; }
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

module.exports = { activate, deactivate, _controller: () => ctl, _internal: { observedCompactsOf, transcriptOf } };
