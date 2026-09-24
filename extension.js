'use strict';
// VS Code 入口（DESIGN §1.1、§8、§11）：装配各模块。
// - 底部面板做成终端面板那样（§11.13）：只有一个 webview 视图 agentMonitor.agents（lib/agents-view.js），
//   一侧是会话列表（仿终端标签列表），另一块是选中会话的智能体。列表在哪边跟随终端标签列表的位置（可设置），
//   宽度可拖动并存进 globalState。选中状态由扩展持有、推给页面；点哪个会话，内容区就显示它，
//   选中一直保持，直到用户点别的（或切到别的对话标签，followActiveChat）。
// - 侧边栏总览树 agentMonitor.tree（lib/tree.js）保留；状态栏总灯；查看范围两档（all / workspace）。
// - 扫描放在 worker 线程（lib/worker.js，消息协议 §1.4 v2 + §11.12.3：config / focus / refresh / storage）。
// - 压缩按钮由 lib/compact.js 自己注册命令 agentMonitor.compact；这里只在激活时调用 activateCompact 并每份快照转给它。
//   交接笔记 agentMonitor.handoff 在这里注册，调用 compact.js 导出的 runHandoff。
// - 自动压缩容量 agentMonitor.setAutoCompact 由 lib/autocompact.js 自己注册（§11.9）。
// - 存储位置与占用 agentMonitor.storage 打开 lib/storage-view.js 的页面；统计在 worker 里做（§11.11）。
// - 实测压缩点（§11.10、§11.12.2）：快照里出现新的自动压缩就按“模型|窗口”记进 globalState，下一次 config 带给 worker。
// 界面文字一律走 lib/i18n.js + lib/format.js，不在这里拼中文或英文句子。

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
const INTRO_KEY = 'agentMonitor.panelIntro.v1';     // globalState：第一次激活时聚焦过底部面板
const LIST_WIDTH_KEY = 'agentMonitor.sessionListWidth';   // globalState：底部面板会话列表的宽度（§11.13）
const OBSERVED_KEY = 'agentMonitor.observedCompact';       // globalState：{ '模型|窗口': 实测自动压缩点 }
const OBSERVED_AT_KEY = 'agentMonitor.observedCompactAt';  // globalState：{ '模型|窗口': 那次压缩的时间 }，只让更新的实测覆盖旧的
const COMPACT_CMD = 'agentMonitor.compact';
const AUTOCOMPACT_CMD = 'agentMonitor.setAutoCompact';
const HANDOFF_CMD = 'agentMonitor.handoff';
const STORAGE_CMD = 'agentMonitor.storage';
const STORAGE_WAIT_MS = 120000; // 存储统计要递归 stat，大目录可能要几十秒
// 需要重建 worker 的设置（§8.6）；其余设置只在主线程用上一份快照重算
const MONITOR_KEYS = [
  'refreshSeconds', 'activeWindowMinutes', 'staleMinutes',
  'claude.enabled', 'claude.projectsDir', 'codex.enabled', 'codex.home',
  'approvalGuess', 'approvalGuessSeconds',
];
const WORKER_RETRIES = 3;
// 后台线程的内存限制：解析记录产生的几乎都是马上就扔的临时对象，新生代压到 6MB，堆就不会被撑大
// （实测扫描时整个进程少占十几 MB，速度不变）；老生代 512MB 只是保险（正常十几 MB），超了由 V8 结束线程、按上面的次数重起
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
    this.last = null;            // 最近一次快照消息（v2）
    this.byKey = new Map();      // 全部会话（未按范围过滤）key → Session
    this.scoped = [];            // 当前范围内的会话
    this.lamps = null;           // computeLamps 的结果（按范围）
    this.sessionOrder = createSessionOrder(); // 会话列表的顺序（§11.3，锁定后不跳）
    this.arranged = null;        // 最近一次排好的会话（分组 + 顺序）
    this.leftKeys = [];          // 会话列表按显示顺序的 key
    this.selectedKey = null;     // 列表里选中的会话（用户点的，或按规则自动选的）；扩展持有，推给页面
    this.shownKey = null;        // 内容区正在显示的会话
    this.listWidth = null;       // 会话列表宽度（globalState，页面拖动后发回来）
    this.cmdTitles = null;       // 命令标题（package.nls，“…”弹出的 QuickPick 用，和右键菜单一致）
    this.focusSig = null;
    this.waiters = [];
    this.compactApi = null;
    this.compactMod = null;
    this.storageWaiters = [];    // requestStorage 等 worker 回 storage 消息
    this.storageForce = false;
    this.observed = {};          // 实测压缩点（与 globalState 同步）
    this.observedAt = {};
    this.agentsView = null;
    this.agentsMod = null;
    this.chrome = { contexts: {}, sBadge: null, tBadge: null, sDesc: null, tDesc: null, barSig: null };
    this.tabTypes = { TabInputWebview: vscode.TabInputWebview, TabInputCustom: vscode.TabInputCustom };
  }

  t(key, vars) { return this.i18n.t(key, vars); }

  cfg() { return vscode.workspace.getConfiguration('agentMonitor'); }

  log(line) {
    try { this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`); } catch { /* 输出面板已关 */ }
  }

  guard(what, fn) {
    try { return fn(); } catch (err) {
      this.log(this.t('ext.log.failed', { what, error: errText(err) }));
      return undefined;
    }
  }

  // ---------- 激活 ----------

  activate() {
    const context = this.context;
    const sub = (...d) => context.subscriptions.push(...d);
    this.output = vscode.window.createOutputChannel(this.t('bar.title'));
    sub(this.output);

    // 已看过（§3.4）：globalState，激活时清理一次
    this.seen = seenLib.createSeenStore(context.globalState);
    Promise.resolve(this.seen.prune()).catch(noop);
    this.dwell = seenLib.createDwellTracker(this.seen, { onMarked: () => this.render() });
    sub({ dispose: () => this.dwell.dispose() });

    this.migrateScope();
    this.loadObserved();
    this.listWidth = this.loadListWidth();

    // 侧边栏总览
    this.overview = new AgentTreeProvider({ i18n: this.i18n, hideCompleted: this.cfg().get('hideCompleted', false) });
    this.treeView = vscode.window.createTreeView(TREE_VIEW, { treeDataProvider: this.overview, showCollapseAll: true });
    sub(this.overview, this.treeView);

    // 底部面板：会话列表 + 智能体（一个 webview）
    this.setupAgentsView();

    // 状态栏总灯
    this.statusItem = vscode.window.createStatusBarItem('agentMonitor.status', vscode.StatusBarAlignment.Left, 50);
    this.statusItem.name = this.t('bar.title');
    this.statusItem.command = 'agentMonitor.show';
    sub(this.statusItem);

    // 当前对话跟随（§8.4）：只在标签切换事件里移动选中
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
          claudeHome: () => this.workerConfig().claude.configDir, // 登记表 sessions/ 所在（§11.11 第 4 条）
          output: this.output,
          inWorkspace: (s) => scopeLib.inWorkspace(s, this.ws()),
          getSelectedKey: () => this.selectedKey || this.shownKey || null, // 无参数调用时当前选中的会话排第一
        });
        this.compactApi = api || null;
        if (api && typeof api.dispose === 'function') this.context.subscriptions.push(api);
        return;
      } catch (err) {
        this.log(this.t('ext.log.moduleFailed', { module: 'compact', error: errText(err) }));
      }
    }
    // 压缩模块加载失败：命令照样存在，点了给出说明，不让按钮“点了没反应”
    this.context.subscriptions.push(vscode.commands.registerCommand(COMPACT_CMD,
      () => vscode.window.showErrorMessage(this.t('ext.compactUnavailable'))));
  }

  // 自动压缩容量（§11.9）：lib/autocompact.js 自己注册 agentMonitor.setAutoCompact；加载失败时占位
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
          // Claude 的配置目录（settings.json 所在）、Codex 目录（config.toml 所在），都按当前设置现算
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
    // 模块出错时占位（模块若已注册了命令再出错，这里注册会重名，guard 住不让激活失败）
    this.guard('autocompact', () => this.context.subscriptions.push(vscode.commands.registerCommand(AUTOCOMPACT_CMD,
      () => vscode.window.showErrorMessage(this.t('ext.autoCompactUnavailable')))));
  }

  // 存储位置与占用（§11.11）：页面在 lib/storage-view.js，统计由 worker 做
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

  // 第一次激活时聚焦一次底部面板（§11.2），让用户知道它在哪；之后不再打扰
  introFocus() {
    const gs = this.context.globalState;
    if (!gs || gs.get(INTRO_KEY)) return;
    Promise.resolve(gs.update(INTRO_KEY, Date.now())).catch(noop);
    const hadEditor = !!this.activeTab();
    Promise.resolve(vscode.commands.executeCommand(`${AGENTS_VIEW}.focus`))
      .then(() => (hadEditor ? vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup') : undefined))
      .catch(noop);
  }

  // ---------- 设置 ----------

  // 旧设置迁移（§8.3、§11.2）：scope 的旧档 conversation / pinned，onlyWorkspace → scope
  migrateScope() {
    const c = this.cfg();
    let plan = [];
    try { plan = scopeLib.planScopeMigration(c.inspect('scope'), c.inspect('onlyWorkspace')); } catch { plan = []; }
    const targets = { global: vscode.ConfigurationTarget.Global, workspace: vscode.ConfigurationTarget.Workspace };
    for (const p of plan) {
      const target = targets[p.target];
      if (target === undefined) continue; // 文件夹层没有资源参数写不了（不带资源的 inspect 也读不到这一层）
      Promise.resolve(c.update(p.key, p.value, target)).catch((err) => this.log(errText(err)));
    }
  }

  // 写到当前生效的那一层：工作区里设过就改工作区，否则改用户设置
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

  /** WorkerConfig（§1.4、§11.12.3）：路径默认值在主线程算好传进去 */
  workerConfig() {
    const c = this.cfg();
    const env = process.env;
    const home = os.homedir();
    const projectsSetting = expandHome(c.get('claude.projectsDir', ''), home);
    // Claude 配置目录（§11.11 第 4 条）：CLAUDE_CONFIG_DIR 优先，其次按 claude.projectsDir 反推，再次 ~/.claude；
    // 也是登记表 sessions/ 与 settings.json 的父目录
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
    // 会话列表在哪边：auto 跟随终端标签列表的位置（§11.13），终端这个设置变了也要推给页面
    if (!e.affectsConfiguration('agentMonitor')) {
      if (e.affectsConfiguration('terminal.integrated.tabs.location')) this.updateAgents(Date.now());
      return;
    }
    const hit = (keys) => keys.some((k) => e.affectsConfiguration(`agentMonitor.${k}`));
    if (hit(MONITOR_KEYS) && this.worker) this.worker.postMessage({ type: 'config', cfg: this.workerConfig() });
    if (e.affectsConfiguration('agentMonitor.onlyWorkspace')) this.migrateScope();
    this.render(); // 范围、隐藏已完成、费用、状态栏等：用上一份快照立即重算，不等下次扫描
  }

  // ---------- worker ----------

  startWorker(retries = 0) {
    const w = new Worker(path.join(this.context.extensionPath, 'lib', 'worker.js'), { workerData: this.workerConfig(), resourceLimits: WORKER_LIMITS });
    this.worker = w;
    this.focusSig = null; // 新 worker：重新告诉它要细节的会话
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
      if (w !== this.worker) return; // 主动停掉或已被替换
      this.worker = null;
      if (code !== 0 && retries < WORKER_RETRIES) {
        this.log(this.t('ext.log.workerExit', { code }));
        this.startWorker(retries + 1);
      }
    });
    this.sendFocus();
    // 换了 worker 时还有人在等存储统计：向新 worker 再要一次
    if (this.storageWaiters.length) w.postMessage({ type: 'storage', force: this.storageForce });
  }

  stopWorker() {
    const w = this.worker;
    this.worker = null;
    if (w) w.terminate();
  }

  // 让 worker 立即再扫一遍；worker 挂了就重新起一个。进度条转到下一份快照到来
  refresh() {
    if (this.worker) this.worker.postMessage({ type: 'refresh' });
    else this.startWorker();
    const next = new Promise((resolve) => {
      const timer = setTimeout(resolve, REFRESH_WAIT_MS); // worker 一直没回也别让进度条转个不停
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
    // 跟随：第一份快照时按当前标签匹配一次；之后只处理“切标签时会话还没出现”的补跟随
    if (first) this.onTabs(true);
    else this.followOnSnapshot();
    // 一直盯着看的会话里新出的结果也算看过（先记再算灯）
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

  // ---------- 实测压缩点（§11.10 第 2 条、§11.12.2） ----------

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
   * 快照里出现新的自动压缩（主对话 lastCompact.trigger === 'auto'）就按“模型|窗口”记下 preTokens。
   * 只学没有被设置覆盖的会话（有设置时压缩点反映的是设置，不是模型默认）；只让更晚的实测覆盖旧值。
   * 值变了就写 globalState，并马上发一次 config，让 worker 用上。
   * @returns {boolean} 有没有更新
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
    // 没有更新的实测就不写 globalState（每 2 秒一份快照，不能每次都写）
    if (!newer) return false;
    const gs = this.context.globalState;
    if (gs) {
      Promise.resolve(gs.update(OBSERVED_AT_KEY, { ...this.observedAt })).catch(noop);
      if (changed) Promise.resolve(gs.update(OBSERVED_KEY, { ...this.observed })).catch(noop);
    }
    if (changed && this.worker) this.worker.postMessage({ type: 'config', cfg: this.workerConfig() });
    return changed;
  }

  // ---------- 存储位置与占用（§11.11、§11.12.3） ----------

  /** 向 worker 要存储统计（非 force 时 worker 10 分钟内返回缓存）；worker 不在就先起一个 */
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
      if (!this.worker) this.startWorker(); // 新 worker 会把等着的请求发出去
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

  /** 打开中的会话（迁移前检查用）：Claude 看登记表存活，Codex 看有没有进行中的回合 */
  liveSessions() {
    const out = [];
    for (const s of this.byKey.values()) {
      if (s && s.live) out.push({ provider: s.provider, sessionId: String(s.id || ''), title: String(s.title || s.id || '') });
    }
    return out;
  }

  // ---------- 渲染 ----------

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
    // 会话列表的顺序：分“打开中 / 最近”，组内按开始时间倒序，锁定后不因活动换位（§11.3）
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

  // 内容区显示哪个（§11.2）：选中的 → 当前对话 → 第一行。从没选过时按同样的规则“选上”，之后一直保持
  resolveShown() {
    const keys = this.leftKeys;
    if (this.selectedKey && !keys.includes(this.selectedKey)) this.selectedKey = null; // 被范围滤掉或已消失
    const r = scopeLib.resolveSelection({ selectedKey: this.selectedKey, conversationKey: this.follower.key, keys });
    if (!this.selectedKey && r.key) this.select(r.key);
    this.shownKey = r.key;
  }

  /** 程序触发的选中（跟随、自动选第一行）：不立即记已看过（交给 1.5 秒停留计时），下次渲染推给页面 */
  select(key) {
    this.selectedKey = key;
  }

  /**
   * 用户在列表里选中（页面发来 select：点行、Enter、空格）→ 记为看过（§3.4 第 1 条）、换内容区、发 focus。
   * 只认当前列表里有的会话。
   */
  userSelect(key) {
    if (typeof key !== 'string' || !this.byKey.has(key) || !this.leftKeys.includes(key)) return;
    this.selectedKey = key;
    Promise.resolve(this.seen.mark(key)).then((changed) => { if (changed) this.render(); }, noop);
    this.render();
  }

  // ---------- 会话列表的位置与宽度（§11.13） ----------

  /** 列表在哪边：设置 sessionListPosition；auto 跟随 terminal.integrated.tabs.location（缺省 right） */
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

  /** 页面拖完分隔线（宽度已吸附）：存进 globalState，重载后保持；只在变了时写 */
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
      // 只看工作区而工作区里没有会话：空状态里给“显示所有会话”（原来原生树空状态里的链接）
      emptyAction: empty && scope === scopeLib.SCOPE.WORKSPACE ? 'showAll' : null,
    }));
  }

  // 状态栏总灯（§8.5）：颜色 = 总灯；NeedsYou / Error 时加警告 / 错误底色（可关）
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

  // 视图外框：徽标（底部面板挂在 webview 视图上，§11.13）、标题旁说明、空状态上下文键（总览树的欢迎页用）
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

  // ---------- 当前对话跟随与“已看过”停留计时 ----------

  activeTab() {
    const tg = vscode.window.tabGroups;
    const g = tg && tg.activeTabGroup;
    return (g && g.activeTab) || null;
  }

  windowFocused() {
    const s = vscode.window.state;
    return !s || s.focused !== false;
  }

  // 标签切换事件（onDidChangeTabs / onDidChangeTabGroups / onDidChangeWindowState），以及第一份快照
  onTabs(initial = false) {
    if (!this.last || !this.follower) return;
    const before = this.follower.key;
    const r = this.guard('follow', () => this.follower.onTabEvent(this.activeTab(), this.currentScoped(), this.ws()));
    let moved = false;
    if (r && r.follow && r.key && this.cfg().get('followActiveChat', true) !== false) {
      // 即使 key 没变也要选：用户可能刚点过别的会话
      this.select(r.key);
      moved = true;
    }
    if (initial) return; // 第一份快照时由 onSnapshot 随后统一渲染
    // 标签事件很多（改标题、脏标记…）：选中或当前对话变了才整体重算，否则只更新停留计时
    if (moved || this.follower.key !== before) this.render();
    else this.updateTabDwell();
  }

  followOnSnapshot() {
    const r = this.guard('follow', () => this.follower.onSnapshot(this.activeTab(), this.currentScoped(), this.ws()));
    if (r && r.follow && r.key && this.cfg().get('followActiveChat', true) !== false) this.select(r.key);
  }

  // §3.4 第 2 条：对话标签是活动标签且窗口有焦点，持续 1.5 秒 → 看过
  updateTabDwell() {
    let key = null;
    if (this.last && this.windowFocused()) {
      const info = scopeLib.classifyTab(this.activeTab(), this.tabTypes);
      if (info) key = scopeLib.matchChatTab(info, this.scoped, this.ws());
    }
    this.dwell.set('tab', key);
  }

  // §3.4 第 3 条：右侧视图显示该会话、可见、窗口有焦点，持续 1.5 秒 → 看过
  updateViewDwell() {
    if (!this.dwell) return;
    const visible = !!(this.agentsView && this.agentsView.visible);
    this.dwell.set('view', visible && this.windowFocused() ? this.shownKey : null);
  }

  // ---------- 命令 ----------

  /** 命令参数 → 会话 key：总览树节点、webview 右键菜单传来的 { sessionKey }（data-vscode-context）、sessionKey 字符串 */
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

  // 当前快照里出现过的记录文件（打开前核对，不打开任意路径）
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
      // 底部面板会话列表的右键菜单 / “…”：参数是 data-vscode-context 对象 { webviewSection, sessionKey, … }
      const s = this.byKey.get(arg.sessionKey);
      file = s && s.main && s.main.file;
    } else if (arg && typeof arg === 'object') {
      if (arg.kind === 'session' && arg.data) file = arg.data.main && arg.data.main.file;               // 总览树的会话
      else if ((arg.kind === 'main' || arg.kind === 'agent') && arg.data) file = arg.data.file;         // 总览树的智能体
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

  /** 命令参数 → 会话的主记录路径（只用快照里的数据，不接受外面传来的路径） */
  transcriptFor(arg) {
    const key = this.keyOf(arg) || (arg == null ? this.shownKey : null);
    const s = key ? this.byKey.get(key) : null;
    const file = transcriptOf(s);
    return file ? { key, session: s, file } : null;
  }

  // 在 Finder / 资源管理器中显示主记录（§11.11）
  revealTranscript(arg) {
    const r = this.transcriptFor(arg);
    if (!r) return undefined;
    if (!isFile(r.file)) {
      vscode.window.showWarningMessage(this.t('ext.transcriptMissing'));
      return undefined;
    }
    return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(r.file));
  }

  // 复制主记录路径（§11.11）
  async copyTranscriptPath(arg) {
    const r = this.transcriptFor(arg);
    if (!r) return;
    await vscode.env.clipboard.writeText(r.file);
    vscode.window.showInformationMessage(this.t('ext.transcriptPathCopied'));
  }

  /**
   * 没有参数时（命令面板）先选会话：当前选中的排第一并标出来。
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
    list.sort((a, b) => Number(b.key === current) - Number(a.key === current)); // 稳定排序：只把当前的挪到最前
    const items = list.map((s) => ({
      label: String(s.title || s.id || ''),
      description: [s.key === current ? this.t('ext.pickSession.selected') : '', fmt.providerLabel(s.provider, this.i18n)].filter(Boolean).join(fmt.SEP),
      key: s.key,
    }));
    const it = await vscode.window.showQuickPick(items, { placeHolder: this.t('ext.pickSession'), matchOnDescription: true });
    return it ? it.key : null;
  }

  /**
   * 命令标题（和右键菜单里显示的一样）：package.nls.json，再用界面语言的 package.nls.<locale>.json 覆盖。
   * VS Code 不提供读取贡献点标题的 API，这里按它的规则自己读一次（只读扩展自己目录里的文件）。
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
   * 会话行尾的“…”（§11.13）：弹出与右键菜单同样内容的 QuickPick（同一份清单 SESSION_MENU、同样的 compactable / resumable 条件），
   * 选中后执行命令，参数和右键菜单一样是 { webviewSection, sessionKey }。
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

  // 换任务：写交接笔记后开新会话（§11.8 第 4 条）。流程在 compact.js 的 runHandoff 里
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

  // 续跑（§7.2）：由扩展端按当前数据重新生成文本再写剪贴板
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
// 小工具
// ---------------------------------------------------------------------------

function emptyText(scope, ws, i18n) {
  if (scope === scopeLib.SCOPE.WORKSPACE && !ws.paths.length) return i18n.t('scope.noFolder');
  return fmt.formatScope(scope, i18n).empty;
}

// 右侧视图模块加载失败时的占位页：只显示一句说明（纯文本，不执行脚本）
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

/** 会话的主记录路径：provider 给的 transcript，没有时用主对话的记录文件；必须是绝对路径 */
function transcriptOf(s) {
  if (!s) return '';
  const p = typeof s.transcript === 'string' && s.transcript ? s.transcript
    : s.main && typeof s.main.file === 'string' ? s.main.file : '';
  return p && path.isAbsolute(p) ? p : '';
}

/**
 * 快照里的实测自动压缩点（§11.10 第 2 条）：Claude 主对话最近一次 trigger === 'auto' 的 preTokens，
 * 按 `${模型}|${窗口}` 分组（与 core/context.js 的 observedKey 同形），同组取最晚的一次。
 * 压缩点来自设置的会话不算（那是设置值，不是模型默认）。
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
    // 窗口：provider 按压缩时的模型算好的 lastCompact.contextWindow 优先（中途换过模型时和会话当前窗口不同）
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
