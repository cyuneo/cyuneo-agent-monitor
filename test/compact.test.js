'use strict';
// 压缩功能的测试：lib/compact.js、l10n/compact.en.json、test/fixtures/fake-claude.js。
// 纯 node 运行：node test/compact.test.js
// 绝不调用真实的 claude、不读写 ~/.claude：会话记录、在线登记表、CLI 全是临时目录里的合成品；
// 每次 spawn 都经过断言“可执行文件在临时目录里”的包装。临时目录取 AGENT_MONITOR_TEST_TMP，没设就用系统临时目录。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const TMP_BASE = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_BASE, { recursive: true });
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(TMP_BASE, 'am-compact-')));

// ---------- vscode 桩 ----------

class Emitter {
  constructor() {
    this.fns = [];
    this.event = (fn) => { this.fns.push(fn); return { dispose: () => { this.fns = this.fns.filter((f) => f !== fn); } }; };
  }
  fire(e) { for (const fn of [...this.fns]) fn(e); }
}

const log = { messages: [], executed: [], clipboard: [], opened: [], quickPicks: [], inputs: [], progress: [], output: [] };
const ui = {};
const config = {};
const commands = new Map();

function resetUi() {
  for (const k of Object.keys(log)) log[k] = [];
  ui.onQuickPick = (qp) => qp.accept(qp.activeItems[0]);
  ui.onShowQuickPick = (items) => items[0];
  ui.onInputBox = (o) => o.value;
  ui.onMessage = () => undefined;
  ui.onExecute = () => { throw new Error('command not found'); };
  ui.onProgress = null;
  ui.openExternal = true;
  ui.extensionPath = null;
  for (const k of Object.keys(config)) delete config[k];
}

function createQuickPick() {
  const acc = new Emitter();
  const hide = new Emitter();
  const qp = {
    items: [], activeItems: [], selectedItems: [], title: '', placeholder: '', disposed: false,
    onDidAccept: acc.event,
    onDidHide: hide.event,
    show() { log.quickPicks.push(qp); setImmediate(() => ui.onQuickPick(qp)); },
    dispose() { if (!qp.disposed) { qp.disposed = true; hide.fire(); } },
    accept(item) { qp.selectedItems = item ? [item] : []; acc.fire(); },
    hide() { hide.fire(); },
    find(re) { return qp.items.find((it) => re.test(it.label || '')); },
  };
  return qp;
}

function message(kind, msg, rest) {
  let opts = null;
  let items = rest;
  if (rest.length && rest[0] && typeof rest[0] === 'object') { opts = rest[0]; items = rest.slice(1); }
  const rec = { kind, msg, opts, items };
  log.messages.push(rec);
  return Promise.resolve(ui.onMessage(rec));
}

const vscode = {
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Uri: { parse: (s) => ({ scheme: String(s).split(':')[0], toString: () => String(s) }) },
  env: {
    uriScheme: 'vscode',
    clipboard: { writeText: async (t) => { log.clipboard.push(t); } },
    openExternal: async (uri) => { log.opened.push(uri.toString()); return ui.openExternal; },
  },
  extensions: { getExtension: (id) => (id === 'anthropic.claude-code' && ui.extensionPath ? { extensionPath: ui.extensionPath } : undefined) },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (k) => config[k] }),
  },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return { dispose: () => commands.delete(id) }; },
    executeCommand: async (id, ...args) => {
      log.executed.push([id, ...args]);
      if (commands.has(id)) return commands.get(id)(...args);
      return ui.onExecute(id, args);
    },
  },
  window: {
    createQuickPick,
    showQuickPick: async (items, opts) => { log.quickPicks.push({ items, opts }); return ui.onShowQuickPick(items, opts); },
    showInputBox: async (o) => { log.inputs.push(o); return ui.onInputBox(o); },
    showInformationMessage: (msg, ...rest) => message('info', msg, rest),
    showErrorMessage: (msg, ...rest) => message('error', msg, rest),
    showWarningMessage: (msg, ...rest) => message('warn', msg, rest),
    withProgress: async (opts, task) => {
      const cancel = new Emitter();
      const token = { isCancellationRequested: false, onCancellationRequested: cancel.event };
      const doCancel = () => { token.isCancellationRequested = true; cancel.fire(); };
      const rec = { opts, reports: [] };
      log.progress.push(rec);
      if (ui.onProgress) ui.onProgress(rec, doCancel);
      return task({ report: (r) => rec.reports.push(r) }, token);
    },
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return origLoad.call(this, request, parent, isMain);
};

const compact = require('../lib/compact');
const S = require('../lib/core/status');
const pricing = require('../lib/core/pricing');
const i18nLib = require('../lib/i18n');

const i18n = i18nLib.createI18n('en', { timeZone: 'UTC' });
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'compact.en.json'), 'utf8'));
const t = (k, v) => i18n.t(k, v);

// ---------- 小工具 ----------

const results = [];
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const MIN = 60e3;
const HOUR = 3600e3;
const NOW = Date.parse('2026-09-24T10:00:00Z');
const SID = 'c0ffee00-0000-4000-8000-000000000001';
const SID2 = 'c0ffee00-0000-4000-8000-000000000002';
const CODEX_ID = '0c0de000-0000-4000-8000-0000000000aa';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const approx = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} ${a} ≈ ${b}`);
const usd = (n) => i18n.fmtUsd(n);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); return p; }

/** 合成的 Claude 会话（字段形状同 lib/providers/claude.js 的 Session） */
function claudeSession(o = {}) {
  const id = o.id || SID;
  const lastApiMs = o.lastApiMs ?? NOW - 10 * MIN;
  const ttl = o.cacheTtl || '1h';
  const used = o.contextUsed ?? 400000;
  return {
    key: 'claude:' + id,
    provider: 'claude',
    id,
    title: o.title || 'Synthetic refactor task',
    titleSource: 'custom',
    cwd: o.cwd === undefined ? '/tmp/am-compact-missing' : o.cwd,
    projectDir: o.projectDir || '-tmp-am-compact',
    entry: o.entry || 'vscode',
    entrypoint: o.entrypoint === undefined ? 'claude-vscode' : o.entrypoint,
    version: o.version || '2.1.280',
    model: o.model === undefined ? 'claude-opus-5-5' : o.model,
    live: !!o.live,
    liveStatus: o.liveStatus || null,
    contextUsed: used,
    cacheTtl: ttl,
    cacheTtlMs: pricing.TTL_MS[ttl],
    lastApiMs,
    lastActivityMs: lastApiMs,
    cacheExpiresMs: lastApiMs + pricing.TTL_MS[ttl],
    main: { id: 'main', kind: 'main', file: o.file || null, tokens: { contextUsed: used }, lastCompact: o.lastCompact || null },
    agents: [],
    workflows: [],
    ...(o.extra || {}),
  };
}

function codexSession(o = {}) {
  return {
    key: 'codex:' + CODEX_ID, provider: 'codex', id: CODEX_ID, title: 'Synthetic codex thread', cwd: '/work/demo',
    entry: 'vscode', entrypoint: null, model: 'gpt-5.6-sol', live: !!o.live, liveStatus: null, contextUsed: 120000,
    cacheTtl: null, lastApiMs: NOW - 5 * MIN, main: { tokens: { contextUsed: 120000 }, lastCompact: o.lastCompact || null }, agents: [], workflows: [],
  };
}

const actionItems = (built) => built.items.filter((it) => it.kind !== -1 && it.action && it.action.type !== 'info');
const isSep = (it) => it.kind === -1;

// 合成会话记录：一条提示 + 一条 assistant（usage 给出 400K 上下文）
function writeTranscript(file, sid, used = 400000) {
  mkdirp(path.dirname(file));
  const rows = [
    { type: 'user', timestamp: '2026-09-24T09:00:00.000Z', sessionId: sid, cwd: '/work/demo', entrypoint: 'claude-vscode', version: '2.1.280', message: { role: 'user', content: 'Synthetic prompt' } },
    { type: 'assistant', timestamp: '2026-09-24T09:00:05.000Z', sessionId: sid, message: { id: 'msg_fake_1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Synthetic reply.' }], stop_reason: 'end_turn', usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: used - 1100, output_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } } } },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// 合成在线登记表条目
function writeRegistry(home, pid, sid, o = {}) {
  const dir = mkdirp(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId: sid, cwd: '/work/demo', startedAt: NOW - HOUR, version: o.version || '2.1.280', kind: 'interactive',
    entrypoint: o.entrypoint || 'claude-vscode', status: o.status || 'idle', updatedAt: NOW, statusUpdatedAt: NOW,
  }));
}

// 假 CLI 复制到临时目录并加执行位
const BIN = mkdirp(path.join(TMP, 'bin'));
const FAKE = path.join(BIN, 'claude-fake');
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), FAKE);
fs.chmodSync(FAKE, 0o755);

const spawned = [];
function guardedSpawn(cli, args, opts) {
  assert.ok(String(cli).startsWith(TMP + path.sep), `spawn outside temp dir: ${cli}`);
  assert.strictEqual(opts.shell, false);
  assert.deepStrictEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
  spawned.push({ cli, args, opts });
  return cp.spawn(cli, args, opts);
}

/** 一套后台压缩的场景：临时 claudeHome、会话记录、cwd、登记表（只有一个死进程条目，说明登记表可用） */
function scenario(name, o = {}) {
  const dir = mkdirp(path.join(TMP, name));
  const home = mkdirp(path.join(dir, 'claude-home'));
  const cwd = mkdirp(path.join(dir, 'work'));
  const file = path.join(home, 'projects', '-work-demo', SID + '.jsonl');
  writeTranscript(file, SID);
  writeRegistry(home, 99999999, 'deadbeef-0000-4000-8000-000000000000');
  const session = claudeSession({ cwd, file, lastApiMs: Date.now() - 3 * HOUR, ...o.session });
  const env = {
    ...process.env,
    FAKE_CLAUDE_PROJECTS: path.join(home, 'projects'),
    FAKE_CLAUDE_LOG: path.join(dir, 'fake-log.json'),
    FAKE_CLAUDE_PIDFILE: path.join(dir, 'fake.pid'),
    FAKE_CLAUDE_MODE: o.mode || 'ok',
  };
  const sessions = new Map([[session.key, session]]);
  const ctx = { globalState: memento(), workspaceState: memento() };
  const deps = {
    getSession: (k) => sessions.get(k) || null,
    listSessions: () => [...sessions.values()],
    i18n,
    claudeHome: home,
    output: { appendLine: (l) => log.output.push(l) },
    spawn: guardedSpawn,
    env,
    ...(o.deps || {}),
  };
  config['claude.cliPath'] = FAKE;
  const handle = compact.activateCompact(ctx, deps);
  return { dir, home, cwd, file, session, sessions, env, ctx, deps, handle };
}

function memento() {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => [...m.keys()] };
}

const readFakeLog = (sc) => (fs.existsSync(sc.env.FAKE_CLAUDE_LOG) ? JSON.parse(fs.readFileSync(sc.env.FAKE_CLAUDE_LOG, 'utf8')) : null);
const pickBackground = (model) => (qp) => qp.accept(qp.items.find((it) => it.action && it.action.type === 'background' && it.action.model === model));
const confirmGo = (rec) => (rec.opts && rec.opts.modal && rec.items.includes(t('compact.confirm.go')) ? t('compact.confirm.go') : undefined);

// ===========================================================================
// 估价（§11.5）
// ===========================================================================

test('估价：§11.5 表里的数（1 小时档按 TTL 修正，5 分钟档照原值）', () => {
  const warm = claudeSession({ lastApiMs: NOW - 10 * MIN });
  const cold = claudeSession({ lastApiMs: NOW - 2 * HOUR });
  approx(compact.estimateFor(warm, 'claude-opus-5-5', NOW).usd, 0.40, 'warm');
  approx(compact.estimateFor(cold, 'claude-opus-5-5', NOW).usd, 3.52, 'cold 1h');
  approx(compact.estimateFor(cold, 'claude-sonnet-5', NOW).usd, 1.76, 'sonnet 1h');
  const cold5 = claudeSession({ lastApiMs: NOW - 2 * HOUR, cacheTtl: '5m' });
  approx(compact.estimateFor(cold5, 'claude-opus-5-5', NOW).usd, 2.32, 'cold 5m');
  approx(compact.estimateFor(cold5, 'claude-sonnet-5', NOW).usd, 1.16, 'sonnet 5m');
  assert.strictEqual(compact.estimateFor(cold, 'claude-haiku-4-5', NOW).available, false);
  // 过期后再压缩（提醒用）
  approx(compact.estimateFor(warm, 'claude-opus-5-5', NOW, { expired: true }).usd, 3.52, 'forced expired');
});

test('估价：applyTtl 只修正“恰好等于 5 分钟档”的结果，基座修好后不重复换算', () => {
  const est = pricing.estimateCompact({ contextUsed: 400000, model: 'claude-opus-5-5', targetModel: 'claude-sonnet-5', ttl: '1h', lastActivityMs: null, now: NOW });
  const fixed = compact.applyTtl(est, '1h');
  approx(fixed.usd, 1.76);
  approx(compact.applyTtl(fixed, '1h').usd, 1.76, 'idempotent');
  const already = { ...est, readUsd: 400000 * 4 / 1e6, usd: 400000 * 4 / 1e6 + est.writeUsd };
  approx(compact.applyTtl(already, '1h').usd, 1.76, 'already 1h');
  const est5 = pricing.estimateCompact({ contextUsed: 400000, model: 'claude-opus-5-5', targetModel: 'claude-sonnet-5', ttl: '5m', lastActivityMs: null, now: NOW });
  approx(compact.applyTtl(est5, '5m').usd, 1.16, '5m untouched');
});

test('推荐：最便宜的标推荐；同价原模型优先；没有 id 的不推荐', () => {
  const a = { id: 'orig', available: true, usd: 1 };
  const b = { id: 'x', available: true, usd: 1 };
  const c = { id: 'y', available: false, usd: null };
  assert.strictEqual(compact.pickRecommended([a, b, c]), a);
  assert.strictEqual(compact.pickRecommended([{ id: null, available: true, usd: 0.1 }, b]), b);
  assert.strictEqual(compact.pickRecommended([{ id: 'z', available: true, usd: null }]), null);
  const r = compact.candidatesFor(claudeSession({ lastApiMs: NOW - 2 * HOUR }), NOW);
  assert.strictEqual(r.recommended, 'claude-sonnet-5');
  approx(r.candidates.find((x) => x.id === 'claude-sonnet-5').savingVsOriginal, 0.5, 'saving');
});

// ===========================================================================
// QuickPick 选项
// ===========================================================================

test('选项：打开中的 Claude 会话 → 顶部两行说明 + 在会话里压缩 / 带保留要求 / 交接笔记，没有后台项', () => {
  const s = claudeSession({ live: true, liveStatus: 'idle', lastApiMs: NOW - 10 * MIN });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: true, liveStatus: 'idle' });
  assert.strictEqual(b.title, t('compact.pick.title', { title: s.title, tokens: i18n.fmtTokens(400000) }));
  assert.ok(b.items[0].label.startsWith('$(info) ') && b.items[0].label.includes(t('compact.info.rules')));
  assert.ok(b.items[1].label.startsWith('$(discard) ') && b.items[1].label.includes(t('compact.info.rewind')));
  assert.strictEqual(b.items[0].action.type, 'info');
  assert.ok(isSep(b.items[2]));
  const acts = actionItems(b).map((it) => it.action.type);
  assert.deepStrictEqual(acts, ['inSession', 'custom', 'handoff']);
  assert.strictEqual(b.active.action.type, 'inSession');
  assert.ok(b.active.label.includes('claude-opus-5-5'));
  assert.ok(b.active.detail.includes(t('compact.detail.cacheWarmLeft', { m: 50 })), b.active.detail);
  assert.ok(b.active.detail.includes(usd(0.4)), b.active.detail);
  assert.ok(!b.items.some((it) => it.action && it.action.type === 'background'));
  assert.ok(b.placeholder.includes(pricing.PRICES_UPDATED));
  assert.ok(!b.items.some((it) => /lightbulb/.test(it.label || '')), 'no cheaper tip while warm');
});

test('选项：忙碌时第一项 detail 前加“正在运行”', () => {
  const s = claudeSession({ live: true, liveStatus: 'busy', lastApiMs: NOW - 1 * MIN });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: true, liveStatus: 'busy' });
  assert.ok(b.active.detail.startsWith(t('compact.detail.busy')), b.active.detail);
  const idle = compact.buildPickItems(s, { i18n, now: NOW, live: true, liveStatus: 'idle' });
  assert.ok(!idle.active.detail.includes(t('compact.detail.busy')));
});

test('选项：缓存过期且换 Sonnet 5 省 ≥30% → 分隔线下加说明项（选它只弹说明）', () => {
  const s = claudeSession({ live: true, liveStatus: 'idle', lastApiMs: NOW - 2 * HOUR });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: true, liveStatus: 'idle' });
  assert.ok(b.active.detail.includes(t('compact.detail.cacheExpired')));
  assert.ok(b.active.detail.includes(usd(3.52)), b.active.detail);
  const last = b.items[b.items.length - 1];
  assert.ok(isSep(b.items[b.items.length - 2]));
  assert.ok(last.label.includes('$(lightbulb)'));
  assert.strictEqual(last.action.type, 'info');
  assert.ok(last.action.text.includes(usd(1.76)), last.action.text);
  // 原模型已是 Sonnet 5：没有这条
  const son = claudeSession({ live: true, model: 'claude-sonnet-5', lastApiMs: NOW - 2 * HOUR });
  const b2 = compact.buildPickItems(son, { i18n, now: NOW, live: true });
  assert.ok(!b2.items.some((it) => /lightbulb/.test(it.label || '')));
});

test('选项：未打开 + 缓存过期 → Sonnet 5 推荐排第一，原模型其次，Haiku 超窗口不可选', () => {
  const s = claudeSession({ lastApiMs: NOW - 2 * HOUR });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: false });
  const acts = actionItems(b);
  assert.deepStrictEqual(acts.map((it) => it.action.type), ['background', 'background', 'handoff']);
  assert.strictEqual(acts[0].action.model, 'claude-sonnet-5');
  assert.strictEqual(acts[0].description, t('compact.recommended'));
  assert.strictEqual(acts[1].action.model, 'claude-opus-5-5');
  assert.strictEqual(acts[1].description, undefined);
  assert.strictEqual(b.active, acts[0]);
  assert.ok(acts[0].detail.includes(usd(1.76)) && acts[0].detail.includes(t('compact.detail.newModel')), acts[0].detail);
  assert.ok(acts[0].detail.includes(t('compact.detail.saving', { pct: i18n.fmtPct(0.5) })), acts[0].detail);
  assert.ok(acts[1].detail.includes(usd(3.52)) && acts[1].detail.includes(t('compact.detail.cacheExpired')));
  const haiku = b.items.find((it) => /claude-haiku-4-5/.test(it.label || ''));
  assert.ok(haiku && haiku.label.startsWith('$(circle-slash)'));
  assert.strictEqual(haiku.action.type, 'info');
  assert.ok(haiku.detail.includes(i18n.fmtTokens(200000)), haiku.detail);
  // 说明项在顶部，交接笔记在压缩项之后
  assert.strictEqual(b.items[0].action.type, 'info');
  assert.ok(b.items.indexOf(acts[2]) > b.items.indexOf(acts[1]));
});

test('选项：未打开 + 缓存还在 → 原模型推荐（缓存还在时最省），并注明后台可能用不上缓存', () => {
  const s = claudeSession({ lastApiMs: NOW - 10 * MIN });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: false });
  const acts = actionItems(b);
  assert.strictEqual(acts[0].action.model, 'claude-opus-5-5');
  assert.strictEqual(acts[0].description, t('compact.recommended'));
  assert.ok(acts[0].detail.includes(usd(0.4)));
  assert.ok(acts[0].detail.includes(t('compact.detail.warmBest')));
  assert.ok(acts[0].detail.includes(t('compact.detail.bgMayMiss', { usd: usd(3.52) })), acts[0].detail);
});

test('选项：上下文 100K → Haiku 可选且最便宜，写“摘要可能丢细节”', () => {
  const s = claudeSession({ contextUsed: 100000, lastApiMs: NOW - 2 * HOUR });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: false });
  const acts = actionItems(b).filter((it) => it.action.type === 'background');
  assert.deepStrictEqual(acts.map((it) => it.action.model), ['claude-haiku-4-5', 'claude-opus-5-5', 'claude-sonnet-5']);
  assert.strictEqual(acts[0].description, t('compact.recommended'));
  assert.ok(acts[0].detail.includes(t('compact.detail.haiku')));
  assert.ok(!b.items.some((it) => /circle-slash/.test(it.label || '')));
});

test('选项：会话模型未知 → 不给原模型项，只给 Sonnet 5 / Haiku，并有说明', () => {
  const s = claudeSession({ model: null, contextUsed: 100000, lastApiMs: NOW - 2 * HOUR });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: false });
  const models = actionItems(b).filter((it) => it.action.type === 'background').map((it) => it.action.model);
  assert.deepStrictEqual(models.sort(), ['claude-haiku-4-5', 'claude-sonnet-5']);
  assert.ok(b.items.some((it) => it.action && it.action.type === 'info' && it.action.text === t('compact.detail.noModel')));
});

test('选项：200K 模型开了 1M（占用 >200K）→ 原模型传 [1m]，白名单一致', () => {
  const s = claudeSession({ model: 'claude-opus-4-6', contextUsed: 400000, lastApiMs: NOW - 2 * HOUR });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: false });
  const models = actionItems(b).filter((it) => it.action.type === 'background').map((it) => it.action.model);
  assert.ok(models.includes('claude-opus-4-6[1m]'), models.join());
  assert.ok(compact.allowedModels(s, NOW).includes('claude-opus-4-6[1m]'));
  assert.strictEqual(compact.cliModelFor('claude-opus-4-6', claudeSession({ model: 'claude-opus-4-6', contextUsed: 150000 })), 'claude-opus-4-6');
});

test('选项：Codex 会话 → 打开 + 复制 /compact、交接笔记，没有后台项', () => {
  const b = compact.buildPickItems(codexSession(), { i18n, now: NOW, live: false });
  assert.deepStrictEqual(actionItems(b).map((it) => it.action.type), ['codexOpen', 'handoff']);
  assert.strictEqual(b.active.action.type, 'codexOpen');
  assert.strictEqual(b.placeholder, t('compact.pick.placeholder.codex'));
  assert.ok(b.items[0].action.text.includes('AGENTS.md'));
});

// ===========================================================================
// 文本、校验、参数、CLI 查找、结果解析
// ===========================================================================

test('文本：模板来自设置或词典；/compact 前缀与换行被规整', () => {
  assert.strictEqual(compact.resolveTemplate('', i18n), EN['compact.template']);
  assert.strictEqual(compact.resolveTemplate('  /compact keep A\nand B ', i18n), 'keep A and B');
  assert.strictEqual(compact.compactPrompt(''), '/compact');
  assert.strictEqual(compact.compactPrompt('/compact   '), '/compact');
  assert.strictEqual(compact.compactPrompt('keep paths'), '/compact keep paths');
  assert.strictEqual(compact.compactPrompt('x'.repeat(5000)).length, '/compact '.length + 2000);
  assert.deepStrictEqual(compact.tailLines('a\n\nb\nc\nd\ne\nf\ng\n'), ['c', 'd', 'e', 'f', 'g']);
});

test('参数：命令参数可以是 sessionKey 或会话树节点', () => {
  const key = 'claude:' + SID;
  assert.strictEqual(compact.keyFromArg(key), key);
  assert.strictEqual(compact.keyFromArg({ key }), key);
  assert.strictEqual(compact.keyFromArg({ sessionKey: key }), key);
  assert.strictEqual(compact.keyFromArg({ session: { key } }), key);
  assert.strictEqual(compact.keyFromArg({ provider: 'claude', id: SID }), key);
  assert.strictEqual(compact.keyFromArg({ id: key }), key);
  assert.strictEqual(compact.keyFromArg({ id: 'main' }), null);
  assert.strictEqual(compact.keyFromArg(undefined), null);
  assert.strictEqual(compact.keyFromArg(42), null);
});

test('参数：spawn 参数顺序固定', () => {
  assert.deepStrictEqual(compact.buildSpawnArgs(SID, 'claude-sonnet-5', '/compact keep'),
    ['-p', '--resume', SID, '--model', 'claude-sonnet-5', '--output-format', 'json', '/compact keep']);
});

test('校验：非法 sessionId、白名单外的模型、不存在的 cwd 一律拒绝', () => {
  const cwd = mkdirp(path.join(TMP, 'cwd-ok'));
  const file = path.join(cwd, 'afile');
  fs.writeFileSync(file, '');
  const allowed = ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
  const v = (o) => compact.validateBackground({ sessionId: SID, model: 'claude-sonnet-5', allowed, cwd, ...o });
  assert.strictEqual(v({}), null);
  for (const bad of ['../etc/passwd', 'abc', SID + '\n', SID + ' --model x', `${SID};rm -rf /`, '', null, 42]) {
    assert.strictEqual(v({ sessionId: bad }), 'compact.error.badId', String(bad));
  }
  for (const bad of ['claude-opus-4-1', 'claude-sonnet-5 --dangerously-skip-permissions', '--help', '<synthetic>', '', null]) {
    assert.strictEqual(v({ model: bad }), 'compact.error.badModel', String(bad));
  }
  // 白名单里的值形状也要对
  assert.strictEqual(v({ model: 'bad model', allowed: ['bad model'] }), 'compact.error.badModel');
  for (const bad of [path.join(TMP, 'nope'), 'relative/dir', file, '', null]) {
    assert.strictEqual(v({ cwd: bad }), 'compact.error.cwd', String(bad));
  }
});

test('CLI 查找顺序：cliPath 设置 → PATH（纯 JS）→ Claude 扩展自带 → 报错', () => {
  const root = mkdirp(path.join(TMP, 'which'));
  const mk = (p, mode = 0o755) => { mkdirp(path.dirname(p)); fs.writeFileSync(p, '#!/bin/sh\n'); fs.chmodSync(p, mode); return p; };
  const dirA = mkdirp(path.join(root, 'a'));
  const dirB = mkdirp(path.join(root, 'b'));
  const dirN = mkdirp(path.join(root, 'noexec'));
  mk(path.join(dirN, 'claude'), 0o644);                 // 没有执行位：跳过
  const inA = mk(path.join(dirA, 'claude'));
  mk(path.join(dirB, 'claude'));
  const ext = path.join(root, 'ext');
  const extBin = mk(path.join(ext, 'resources', 'native-binary', 'claude'));
  const setting = mk(path.join(root, 'custom', 'my-claude'));
  const PATH = ['relative/bin', dirN, dirA, dirB].join(':');
  const env = { PATH, HOME: root };
  const f = (o) => compact.findCli({ platform: 'darwin', env, extensionPath: ext, ...o });

  assert.deepStrictEqual(f({ cliPath: setting }), { path: setting, source: 'setting' });
  assert.deepStrictEqual(f({ cliPath: '~/custom/my-claude' }), { path: setting, source: 'setting' });
  assert.deepStrictEqual(f({ cliPath: path.join(root, 'missing') }), { error: 'cliPath', path: path.join(root, 'missing') });
  assert.strictEqual(f({ cliPath: path.join(dirN, 'claude') }).error, 'cliPath', 'not executable');
  assert.strictEqual(f({ cliPath: 'claude' }).error, 'cliPath', 'relative');
  assert.deepStrictEqual(f({ cliPath: '' }), { path: inA, source: 'path' });
  assert.deepStrictEqual(f({ env: { PATH: dirN } }), { path: extBin, source: 'extension' });
  assert.deepStrictEqual(f({ env: { PATH: dirN }, extensionPath: null }), { error: 'notFound' });
  assert.deepStrictEqual(f({ env: { PATH: '' }, extensionPath: path.join(root, 'no-ext') }), { error: 'notFound' });

  // Windows：.exe 优先；只有 .cmd 时排在扩展自带的 .exe 之后；.cmd 需要 shell，spawn 前拦下
  const w = mkdirp(path.join(root, 'win'));
  const wExe = mkdirp(path.join(w, 'exe'));
  const wCmd = mkdirp(path.join(w, 'cmd'));
  mk(path.join(wExe, 'claude.exe'), 0o644);
  mk(path.join(wCmd, 'claude.cmd'), 0o644);
  const wExt = path.join(w, 'ext');
  mk(path.join(wExt, 'resources', 'native-binary', 'claude.exe'), 0o644);
  const g = (o) => compact.findCli({ platform: 'win32', extensionPath: wExt, ...o });
  assert.deepStrictEqual(g({ env: { Path: `${wCmd};${wExe}` } }), { path: path.join(wExe, 'claude.exe'), source: 'path' });
  assert.deepStrictEqual(g({ env: { Path: wCmd } }), { path: path.join(wExt, 'resources', 'native-binary', 'claude.exe'), source: 'extension' });
  const shim = g({ env: { Path: wCmd }, extensionPath: null });
  assert.strictEqual(shim.path, path.join(wCmd, 'claude.cmd'));
  assert.strictEqual(compact.needsShell(shim.path), true);
  assert.strictEqual(compact.needsShell(inA), false);
});

test('结果解析：整段 JSON、多行里最后的 result 行、垃圾输出', () => {
  assert.strictEqual(compact.parseResultJson('{"type":"result","is_error":false,"total_cost_usd":0.5}').total_cost_usd, 0.5);
  assert.strictEqual(compact.parseResultJson('noise\n{"type":"system"}\n{"type":"result","is_error":true}\n').is_error, true);
  assert.strictEqual(compact.parseResultJson('not json'), null);
  assert.strictEqual(compact.parseResultJson(''), null);
});

test('记录：只找偏移之后最后一条 compact_boundary；文件变短就从头找', () => {
  const f = path.join(TMP, 'boundary', 'x.jsonl');
  mkdirp(path.dirname(f));
  const b = (pre, post) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-09-24T10:00:00.000Z', compactMetadata: { trigger: 'manual', preTokens: pre, postTokens: post } });
  fs.writeFileSync(f, b(100, 10) + '\n' + JSON.stringify({ type: 'user' }) + '\n');
  const size = fs.statSync(f).size;
  assert.strictEqual(compact.readCompactBoundary(f, size), null);
  fs.appendFileSync(f, b(300, 30) + '\n' + b(400, 40) + '\n{"type":"user"}\n');
  assert.deepStrictEqual(compact.readCompactBoundary(f, size), { preTokens: 400, postTokens: 40, trigger: 'manual', ms: NOW });
  assert.strictEqual(compact.readCompactBoundary(f, 10 ** 9).preTokens, 400);
  assert.strictEqual(compact.readCompactBoundary(path.join(TMP, 'nope.jsonl'), 0), null);
});

// ===========================================================================
// 命令流程（vscode 桩）
// ===========================================================================

test('流程：登记表显示会话打开中（快照还没更新）→ 在会话里压缩：预填模板并复制', async () => {
  resetUi();
  const sc = scenario('live-vscode', { session: { live: false } });
  writeRegistry(sc.home, process.pid, SID, { status: 'idle' });
  ui.onExecute = () => undefined; // Claude 扩展的命令存在
  try {
    await vscode.commands.executeCommand('agentMonitor.compact', { key: sc.session.key });
    const qp = log.quickPicks[0];
    assert.strictEqual(qp.activeItems[0].action.type, 'inSession');
    const text = '/compact ' + EN['compact.template'];
    assert.deepStrictEqual(log.executed.find((e) => e[0] === 'claude-vscode.editor.open'), ['claude-vscode.editor.open', SID, text]);
    assert.deepStrictEqual(log.clipboard, [text]);
    assert.strictEqual(log.messages.pop().msg, t('compact.deliver.opened'));
    assert.strictEqual(spawned.length, 0);
  } finally { sc.handle.dispose(); }
});

test('流程：Claude 扩展命令不存在或抛错 → 只复制并提示', async () => {
  resetUi();
  const sc = scenario('live-nocmd', { session: { live: true, liveStatus: 'idle' } });
  writeRegistry(sc.home, process.pid, SID);
  try {
    await sc.handle.compact(sc.session.key);
    assert.ok(log.executed.some((e) => e[0] === 'claude-vscode.editor.open'));
    assert.strictEqual(log.clipboard.length, 1);
    assert.strictEqual(log.messages.pop().msg, t('compact.deliver.copied'));
  } finally { sc.handle.dispose(); }
});

test('流程：终端入口的打开中会话 → 不调 Claude 扩展，复制并提示去那个窗口', async () => {
  resetUi();
  const sc = scenario('live-cli', { session: { live: true, entry: 'cli', entrypoint: 'cli' } });
  writeRegistry(sc.home, process.pid, SID, { entrypoint: 'cli' });
  try {
    await sc.handle.compact(sc.session.key);
    assert.ok(!log.executed.some((e) => e[0] === 'claude-vscode.editor.open'));
    assert.strictEqual(log.clipboard[0], '/compact ' + EN['compact.template']);
    assert.strictEqual(log.messages.pop().msg, t('compact.deliver.copiedOther', { where: t('entry.cli') }));
  } finally { sc.handle.dispose(); }
});

test('流程：选说明项只弹说明、QuickPick 不关；再选“带保留要求”→ InputBox 改完预填', async () => {
  resetUi();
  const sc = scenario('live-custom', { session: { live: true } });
  writeRegistry(sc.home, process.pid, SID);
  ui.onExecute = () => undefined;
  ui.onQuickPick = (qp) => {
    qp.accept(qp.items[0]);                     // 说明项
    assert.strictEqual(qp.disposed, false);
    qp.accept(qp.items.find((it) => it.action && it.action.type === 'custom'));
  };
  ui.onInputBox = (o) => { assert.strictEqual(o.value, EN['compact.template']); return 'keep the file paths'; };
  try {
    await sc.handle.compact(sc.session.key);
    assert.strictEqual(log.messages[0].msg, t('compact.info.rules'));
    assert.deepStrictEqual(log.executed.find((e) => e[0] === 'claude-vscode.editor.open'), ['claude-vscode.editor.open', SID, '/compact keep the file paths']);
  } finally { sc.handle.dispose(); }
});

test('流程：设置 compactTemplate 覆盖默认模板', async () => {
  resetUi();
  const sc = scenario('live-template', { session: { live: true } });
  writeRegistry(sc.home, process.pid, SID);
  config.compactTemplate = '/compact keep only the TODO list';
  ui.onExecute = () => undefined;
  try {
    await sc.handle.compact(sc.session.key);
    assert.strictEqual(log.clipboard[0], '/compact keep only the TODO list');
  } finally { sc.handle.dispose(); }
});

test('流程：Codex → 打开 vscode://openai.chatgpt/local/<id> 并复制 /compact；打开失败只复制', async () => {
  resetUi();
  const ctx = { globalState: memento(), workspaceState: memento() };
  const s = codexSession();
  const h = compact.activateCompact(ctx, { getSession: (k) => (k === s.key ? s : null), i18n, claudeHome: path.join(TMP, 'none') });
  try {
    await h.compact(s.key);
    assert.deepStrictEqual(log.opened, [`vscode://openai.chatgpt/local/${CODEX_ID}`]);
    assert.deepStrictEqual(log.clipboard, ['/compact']);
    assert.strictEqual(log.messages.pop().msg, t('compact.deliver.codexOpened'));
    ui.openExternal = false;
    await h.compact(s.key);
    assert.strictEqual(log.messages.pop().msg, t('compact.deliver.codexCopied'));
  } finally { h.dispose(); }
});

test('流程：写交接笔记 → 预填提示，通知里可复制续接提示', async () => {
  resetUi();
  const sc = scenario('handoff', { session: { live: true } });
  writeRegistry(sc.home, process.pid, SID);
  ui.onExecute = () => undefined;
  ui.onQuickPick = (qp) => qp.accept(qp.items.find((it) => it.action && it.action.type === 'handoff'));
  ui.onMessage = (rec) => (rec.items.includes(t('compact.handoff.copyContinue')) ? t('compact.handoff.copyContinue') : undefined);
  try {
    await sc.handle.compact(sc.session.key);
    assert.deepStrictEqual(log.executed.find((e) => e[0] === 'claude-vscode.editor.open'), ['claude-vscode.editor.open', SID, t('compact.handoff.prompt')]);
    const m = log.messages.pop();
    assert.ok(m.msg.includes(t('compact.handoff.next')));
    assert.deepStrictEqual(log.clipboard, [t('compact.handoff.prompt'), t('compact.handoff.continue')]);
  } finally { sc.handle.dispose(); }
});

test('交接命令：runHandoff(sessionKey) 与 QuickPick 里的“写交接笔记”走同一个函数；模块级 runHandoff 转给当前实例', async () => {
  resetUi();
  const sc = scenario('handoff-cmd', { session: { live: true } });
  writeRegistry(sc.home, process.pid, SID);
  ui.onExecute = () => undefined;
  try {
    await sc.handle.runHandoff(sc.session.key);
    assert.strictEqual(log.quickPicks.length, 0, '给了参数就不弹选择');
    assert.deepStrictEqual(log.executed.find((e) => e[0] === 'claude-vscode.editor.open'), ['claude-vscode.editor.open', SID, t('compact.handoff.prompt')]);
    assert.ok(log.messages.pop().msg.includes(t('compact.handoff.next')));
    // 模块级入口（extension.js 可直接 require 调用），参数也可以是会话树节点
    log.executed = [];
    await compact.runHandoff({ key: sc.session.key });
    assert.ok(log.executed.some((e) => e[0] === 'claude-vscode.editor.open' && e[2] === t('compact.handoff.prompt')));
  } finally { sc.handle.dispose(); }
  await assert.rejects(() => compact.runHandoff(SID), /not active/, 'dispose 后模块级入口不再可用');
});

test('交接命令：没有参数 → 先选会话（列全部会话，当前选中的排第一）；会话已关闭 → 只复制；会话不在列表 → 报错', async () => {
  resetUi();
  const sc = scenario('handoff-pick', {
    session: { live: false, contextUsed: 5000 },
    deps: { getSelectedKey: () => 'codex:' + CODEX_ID },
  });
  const cx = codexSession();
  sc.sessions.set(cx.key, cx);
  ui.onShowQuickPick = (items) => items[0];
  try {
    await sc.handle.runHandoff();
    const qp = log.quickPicks[0];
    assert.strictEqual(qp.opts.placeHolder, t('compact.handoff.pickSession'));
    assert.deepStrictEqual(qp.items.map((it) => it.key), [cx.key, sc.session.key], '小上下文的会话也列出；选中的排第一');
    assert.deepStrictEqual(log.clipboard, [t('compact.handoff.prompt')]);
    assert.ok(log.messages.pop().msg.includes(t('compact.handoff.next.codex')));
    // Claude 会话已关闭（登记表可用、里面没有它）：claude-vscode 入口照样用 editor.open 重新打开并预填；
    // Claude 扩展命令不可用时退回只复制
    resetUi();
    await sc.handle.runHandoff(sc.session.key);
    assert.ok(log.executed.some((e) => e[0] === 'claude-vscode.editor.open' && e[1] === SID));
    assert.deepStrictEqual(log.clipboard, [t('compact.handoff.prompt')]);
    assert.ok(log.messages.pop().msg.startsWith(t('compact.deliver.copied')));
    // 不在列表
    resetUi();
    await sc.handle.runHandoff('claude:' + SID2);
    assert.strictEqual(log.messages.pop().msg, t('compact.error.noSession'));
    // 没有会话
    resetUi();
    sc.sessions.clear();
    await sc.handle.runHandoff();
    assert.strictEqual(log.messages.pop().msg, t('compact.handoff.noSessions'));
  } finally { sc.handle.dispose(); }
});

test('压缩命令：没有参数时当前选中的会话排第一（给了 getSelectedKey 时）', async () => {
  resetUi();
  const sc = scenario('compact-pick-selected', { deps: { getSelectedKey: () => 'claude:' + SID2 } });
  const other = claudeSession({ id: SID2, title: 'Second synthetic task', cwd: sc.cwd });
  sc.sessions.set(other.key, other);
  ui.onShowQuickPick = () => undefined;
  try {
    await sc.handle.compact();
    assert.deepStrictEqual(log.quickPicks[0].items.map((it) => it.key), [other.key, sc.session.key]);
  } finally { sc.handle.dispose(); }
});

test('流程：后台压缩（假 CLI）→ 参数、cwd、stdin、记录追加、完成提示 pre → post 与花费', async () => {
  resetUi();
  const sc = scenario('bg-ok');
  ui.onQuickPick = pickBackground('claude-sonnet-5');
  ui.onMessage = confirmGo;
  const before = spawned.length;
  try {
    await vscode.commands.executeCommand('agentMonitor.compact', sc.session.key);
    assert.strictEqual(spawned.length, before + 1);
    const lg = readFakeLog(sc);
    assert.deepStrictEqual(lg.argv, ['-p', '--resume', SID, '--model', 'claude-sonnet-5', '--output-format', 'json', '/compact ' + EN['compact.template']]);
    assert.strictEqual(fs.realpathSync(lg.cwd), fs.realpathSync(sc.cwd));
    assert.strictEqual(lg.stdin, 'devnull');
    // 输入框预填模板；确认框是模态、带模型和估价
    assert.strictEqual(log.inputs[0].value, EN['compact.template']);
    const confirm = log.messages.find((m) => m.opts && m.opts.modal);
    assert.ok(confirm.opts.detail.includes('claude-sonnet-5') && confirm.opts.detail.includes(usd(1.76)), confirm.opts.detail);
    assert.ok(!confirm.opts.detail.includes(t('compact.confirm.unverified')));
    assert.strictEqual(log.progress[0].opts.cancellable, true);
    assert.strictEqual(log.progress[0].opts.location, vscode.ProgressLocation.Notification);
    // 记录里多了 compact_boundary（400000 → 12000）
    const done = log.messages[log.messages.length - 1];
    assert.strictEqual(done.msg, t('compact.done', { title: sc.session.title, pre: i18n.fmtTokens(400000), post: i18n.fmtTokens(12000), usd: usd(0.0123), model: 'claude-sonnet-5' }));
    assert.ok(fs.readFileSync(sc.file, 'utf8').includes('compact_boundary'));
    assert.ok(log.output.some((l) => /ok code=0/.test(l)));
  } finally { sc.handle.dispose(); }
});

test('流程：compactConfirm 关掉且登记表可用 → 不弹确认；登记表不可用 → 仍要确认并说明核实不了', async () => {
  resetUi();
  const sc = scenario('bg-noconfirm', { mode: 'noBoundary' });
  config.compactConfirm = false;
  ui.onQuickPick = pickBackground('claude-sonnet-5');
  try {
    await sc.handle.compact(sc.session.key);
    assert.ok(!log.messages.some((m) => m.opts && m.opts.modal));
    assert.strictEqual(log.messages.pop().msg, t('compact.done.noRecord', { title: sc.session.title, usd: usd(0.0123), model: 'claude-sonnet-5' }));
  } finally { sc.handle.dispose(); }

  resetUi();
  const sc2 = scenario('bg-unverified');
  fs.rmSync(path.join(sc2.home, 'sessions'), { recursive: true, force: true });
  config.compactConfirm = false;
  ui.onQuickPick = pickBackground('claude-sonnet-5');
  try {
    await sc2.handle.compact(sc2.session.key);   // 不点确认 → 不运行
    const confirm = log.messages.find((m) => m.opts && m.opts.modal);
    assert.ok(confirm && confirm.opts.detail.includes(t('compact.confirm.unverified')));
    assert.strictEqual(readFakeLog(sc2), null);
  } finally { sc2.handle.dispose(); }
});

test('流程：执行前复查登记表，会话刚被打开 → 中止，不启动 CLI；可改为在会话里压缩', async () => {
  resetUi();
  const sc = scenario('bg-recheck');
  const before = spawned.length;
  ui.onQuickPick = pickBackground('claude-sonnet-5');
  ui.onInputBox = (o) => { writeRegistry(sc.home, process.pid, SID); return o.value; }; // 用户在这期间打开了会话
  ui.onExecute = () => undefined;
  ui.onMessage = (rec) => confirmGo(rec) || (rec.items.includes(t('compact.nowOpen.action')) ? t('compact.nowOpen.action') : undefined);
  try {
    await sc.handle.compact(sc.session.key);
    assert.strictEqual(spawned.length, before);
    assert.strictEqual(readFakeLog(sc), null);
    assert.ok(log.messages.some((m) => m.msg === t('compact.nowOpen', { title: sc.session.title })));
    assert.deepStrictEqual(log.executed.find((e) => e[0] === 'claude-vscode.editor.open'), ['claude-vscode.editor.open', SID, '/compact ' + EN['compact.template']]);
  } finally { sc.handle.dispose(); }
});

test('流程：CLI 失败 → 模态错误，detail 是退出码和 stderr 最后 5 行', async () => {
  resetUi();
  const sc = scenario('bg-error', { mode: 'error' });
  ui.onQuickPick = pickBackground('claude-opus-5-5');
  ui.onMessage = confirmGo;
  try {
    await sc.handle.compact(sc.session.key);
    const err = log.messages.find((m) => m.kind === 'error');
    assert.strictEqual(err.msg, t('compact.failed', { title: sc.session.title }));
    assert.ok(err.opts.modal);
    const lines = err.opts.detail.split('\n');
    assert.deepStrictEqual(lines, [t('compact.failed.exit', { code: 1 }), 'fake error line 4', 'fake error line 5', 'fake error line 6', 'fake error line 7', 'fake error line 8']);
  } finally { sc.handle.dispose(); }
});

test('流程：结果 JSON 带 is_error → 按失败处理，显示报错首行', async () => {
  resetUi();
  const sc = scenario('bg-iserror', { mode: 'isError' });
  ui.onQuickPick = pickBackground('claude-sonnet-5');
  ui.onMessage = confirmGo;
  try {
    await sc.handle.compact(sc.session.key);
    const err = log.messages.find((m) => m.kind === 'error');
    assert.ok(err.opts.detail.includes('Prompt is too long'), err.opts.detail);
  } finally { sc.handle.dispose(); }
});

test('流程：取消 → 结束子进程，提示已取消', async () => {
  resetUi();
  // 超时设成 15 秒：取消后要在几秒内结束，不能靠超时兜底
  const sc = scenario('bg-cancel', { mode: 'hang', deps: { timeoutMs: 15000 } });
  ui.onQuickPick = pickBackground('claude-sonnet-5');
  ui.onMessage = confirmGo;
  let cancelledAt = 0;
  ui.onProgress = (rec, cancel) => {
    (async () => {
      for (let i = 0; i < 200 && !fs.existsSync(sc.env.FAKE_CLAUDE_PIDFILE); i++) await sleep(20);
      cancelledAt = Date.now();
      cancel();
    })();
  };
  try {
    await sc.handle.compact(sc.session.key);
    assert.ok(cancelledAt > 0 && Date.now() - cancelledAt < 4000, 'child ends soon after cancel');
    const pid = Number(fs.readFileSync(sc.env.FAKE_CLAUDE_PIDFILE, 'utf8'));
    assert.strictEqual(pidAlive(pid), false, 'child still alive');
    assert.strictEqual(log.messages.pop().msg, t('compact.cancelled', { title: sc.session.title }));
  } finally { sc.handle.dispose(); }
});

test('流程：超时 → 结束子进程，提示超时', async () => {
  resetUi();
  const sc = scenario('bg-timeout', { mode: 'hang', deps: { timeoutMs: 600 } });
  ui.onQuickPick = pickBackground('claude-sonnet-5');
  ui.onMessage = confirmGo;
  try {
    await sc.handle.compact(sc.session.key);
    const pid = Number(fs.readFileSync(sc.env.FAKE_CLAUDE_PIDFILE, 'utf8'));
    assert.strictEqual(pidAlive(pid), false);
    const m = log.messages.pop();
    assert.strictEqual(m.kind, 'error');
    assert.strictEqual(m.msg, t('compact.timeout', { title: sc.session.title, min: 0 }));
  } finally { sc.handle.dispose(); }
});

test('流程：dispose 时结束还在跑的子进程', async () => {
  resetUi();
  const sc = scenario('bg-dispose', { mode: 'hang' });
  ui.onQuickPick = pickBackground('claude-sonnet-5');
  ui.onMessage = confirmGo;
  const p = sc.handle.compact(sc.session.key);
  for (let i = 0; i < 200 && !fs.existsSync(sc.env.FAKE_CLAUDE_PIDFILE); i++) await sleep(20);
  const pid = Number(fs.readFileSync(sc.env.FAKE_CLAUDE_PIDFILE, 'utf8'));
  sc.handle.dispose();
  await p;
  assert.strictEqual(pidAlive(pid), false);
  assert.ok(!commands.has('agentMonitor.compact'));
});

test('流程：cwd 不存在、sessionId 非法、会话已不在列表 → 报错且不启动 CLI', async () => {
  resetUi();
  const sc = scenario('bg-nocwd', { session: { cwd: path.join(TMP, 'gone-dir') } });
  const before = spawned.length;
  ui.onQuickPick = pickBackground('claude-sonnet-5');
  ui.onMessage = confirmGo;
  try {
    await sc.handle.compact(sc.session.key);
    assert.strictEqual(log.messages.pop().msg, t('compact.error.cwd'));
    assert.strictEqual(log.inputs.length, 0, 'fails before asking');
    const bad = claudeSession({ id: 'not-a-uuid' });
    sc.sessions.set(bad.key, bad);
    await sc.handle.compact(bad.key);
    assert.strictEqual(log.messages.pop().msg, t('compact.error.badId'));
    await sc.handle.compact('claude:' + SID2);
    assert.strictEqual(log.messages.pop().msg, t('compact.error.noSession'));
    assert.strictEqual(spawned.length, before);
  } finally { sc.handle.dispose(); }
});

test('流程：找不到 CLI → 报错并可打开设置', async () => {
  resetUi();
  const sc = scenario('bg-nocli', { deps: { env: { PATH: '' } } });
  config['claude.cliPath'] = '';
  ui.onQuickPick = pickBackground('claude-sonnet-5');
  ui.onMessage = (rec) => confirmGo(rec) || (rec.items.includes(t('compact.openSettings')) ? t('compact.openSettings') : undefined);
  ui.onExecute = () => undefined;
  try {
    await sc.handle.compact(sc.session.key);
    assert.ok(log.messages.some((m) => m.msg === t('compact.error.noCli')));
    assert.deepStrictEqual(log.executed.find((e) => e[0] === 'workbench.action.openSettings'), ['workbench.action.openSettings', 'agentMonitor.claude.cliPath']);
  } finally { sc.handle.dispose(); }
});

test('流程：没有参数 → 先选会话（只列可压缩的）', async () => {
  resetUi();
  const sc = scenario('noarg', { session: { live: true } });
  writeRegistry(sc.home, process.pid, SID);
  const small = claudeSession({ id: SID2, contextUsed: 5000 });
  sc.sessions.set(small.key, small);
  ui.onExecute = () => undefined;
  try {
    await sc.handle.compact();
    const sp = log.quickPicks[0];
    assert.deepStrictEqual(sp.items.map((it) => it.key), [sc.session.key]);
    assert.ok(log.executed.some((e) => e[0] === 'claude-vscode.editor.open'));
  } finally { sc.handle.dispose(); }
});

// ===========================================================================
// 提醒
// ===========================================================================

test('提醒判定：缓存快过期（1 小时档、空闲、够大、省 ≥ $0.50）', () => {
  const base = { live: true, liveStatus: 'idle', lastApiMs: NOW - 55 * MIN };
  const s = claudeSession(base);
  const due = compact.cacheReminderDue(s, NOW, {});
  assert.ok(due);
  assert.strictEqual(due.minutes, 5);
  approx(due.warm, 0.40);
  approx(due.cold, 3.52);
  assert.strictEqual(due.key, `${SID}:${s.cacheExpiresMs}`);
  assert.strictEqual(compact.cacheReminderDue(claudeSession({ ...base, liveStatus: 'busy' }), NOW, {}), null);
  assert.strictEqual(compact.cacheReminderDue(claudeSession({ ...base, liveStatus: 'waiting' }), NOW, {}), null);
  assert.strictEqual(compact.cacheReminderDue(claudeSession({ ...base, live: false }), NOW, {}), null);
  assert.strictEqual(compact.cacheReminderDue(claudeSession({ ...base, contextUsed: 100000 }), NOW, {}), null);
  assert.strictEqual(compact.cacheReminderDue(claudeSession({ ...base, lastApiMs: NOW - 30 * MIN }), NOW, {}), null, '30 min left');
  assert.strictEqual(compact.cacheReminderDue(claudeSession({ ...base, lastApiMs: NOW - 2 * HOUR }), NOW, {}), null, 'expired');
  assert.strictEqual(compact.cacheReminderDue(s, NOW, { reminded: new Set([due.key]) }), null);
  assert.strictEqual(compact.cacheReminderDue(s, NOW, { muted: () => true }), null);
  assert.strictEqual(compact.cacheReminderDue(s, NOW, { enabled: false }), null);
  // 5 分钟档：默认不弹，打开 cacheReminderShortTtl 才弹
  const short = claudeSession({ ...base, cacheTtl: '5m', lastApiMs: NOW - 2 * MIN });
  assert.strictEqual(compact.cacheReminderDue(short, NOW, {}), null);
  assert.ok(compact.cacheReminderDue(short, NOW, { shortTtl: true }));
  // 省得不到 $0.50：Haiku 150K
  assert.strictEqual(compact.cacheReminderDue(claudeSession({ ...base, model: 'claude-haiku-4-5', contextUsed: 150000 }), NOW, {}), null);
  assert.strictEqual(compact.cacheReminderDue(codexSession(), NOW, {}), null);
});

test('提醒判定：关窗口（缓存还在、够大、只有 claude-vscode 入口给“重新打开”）', () => {
  const s = claudeSession({ live: false, lastApiMs: NOW - 20 * MIN });
  const due = compact.closeReminderDue(s, NOW, {});
  assert.ok(due && due.reopen === true && due.minutes === 40);
  assert.strictEqual(compact.closeReminderDue(claudeSession({ live: false, entrypoint: 'cli', lastApiMs: NOW - 20 * MIN }), NOW, {}).reopen, false);
  assert.strictEqual(compact.closeReminderDue(claudeSession({ live: true, lastApiMs: NOW - 20 * MIN }), NOW, {}), null);
  assert.strictEqual(compact.closeReminderDue(claudeSession({ live: false, lastApiMs: NOW - 2 * HOUR }), NOW, {}), null);
  assert.strictEqual(compact.closeReminderDue(s, NOW, { muted: () => true }), null);
});

function reminderRig(sessionsNow) {
  const ctx = { globalState: memento(), workspaceState: memento() };
  const store = { sessions: sessionsNow };
  const h = compact.activateCompact(ctx, {
    getSession: (k) => store.sessions.find((s) => s.key === k) || null,
    i18n, claudeHome: path.join(TMP, 'no-home'), inWorkspace: (s) => !s.notInWs,
  });
  return { ctx, h, store };
}

test('提醒：缓存快过期 → 每个缓存窗口只弹一次；按钮“带保留要求压缩”预填模板', async () => {
  resetUi();
  const now = Date.now();
  const s = claudeSession({ live: true, liveStatus: 'idle', lastApiMs: now - 55 * MIN });
  const { h } = reminderRig([s]);
  ui.onExecute = () => undefined;
  ui.onMessage = (rec) => (rec.items.includes(t('compact.remind.cache.compact')) ? t('compact.remind.cache.compact') : undefined);
  try {
    h.onSnapshot({ now, sessions: [s] });
    h.onSnapshot({ now: now + 2000, sessions: [s] });
    await tick(10);
    const reminders = log.messages.filter((m) => m.items.includes(t('compact.remind.mute')));
    assert.strictEqual(reminders.length, 1);
    assert.deepStrictEqual(reminders[0].items, [t('compact.remind.cache.compact'), t('compact.remind.handoff'), t('compact.remind.mute')]);
    assert.ok(reminders[0].msg.includes(usd(0.4)) && reminders[0].msg.includes(usd(3.52)), reminders[0].msg);
    assert.deepStrictEqual(log.executed.find((e) => e[0] === 'claude-vscode.editor.open'), ['claude-vscode.editor.open', SID, '/compact ' + EN['compact.template']]);
    // 不在本窗口工作区的会话不提醒
    resetUi();
    const other = claudeSession({ id: SID2, live: true, lastApiMs: now - 55 * MIN, extra: { notInWs: true } });
    h.onSnapshot({ now, sessions: [other] });
    await tick(10);
    assert.strictEqual(log.messages.length, 0);
  } finally { h.dispose(); }
});

test('提醒：关窗口（存活 → 消失）弹一次；一次关掉多个不弹；“不再提醒”写 workspaceState', async () => {
  resetUi();
  const now = Date.now();
  const open = claudeSession({ live: true, liveStatus: 'busy', lastApiMs: now - 20 * MIN });
  const closed = { ...open, live: false, liveStatus: null };
  const { h, ctx } = reminderRig([open]);
  ui.onMessage = (rec) => (rec.items.includes(t('compact.remind.mute')) ? t('compact.remind.mute') : undefined);
  try {
    h.onSnapshot({ now, sessions: [open] });
    h.onSnapshot({ now: now + 2000, sessions: [closed] });
    await tick(10);
    assert.strictEqual(log.messages.length, 0, 'one snapshot is not enough');
    h.onSnapshot({ now: now + 4000, sessions: [closed] });
    h.onSnapshot({ now: now + 6000, sessions: [closed] });
    await tick(10);
    const r = log.messages.filter((m) => m.items.includes(t('compact.remind.close.compact')));
    assert.strictEqual(r.length, 1);
    assert.deepStrictEqual(r[0].items, [t('compact.remind.close.compact'), t('compact.remind.close.handoff'), t('compact.remind.mute')]);
    assert.ok(ctx.workspaceState.get(compact.MUTE_KEY)[SID]);
    // 已设“不再提醒”：再关一次也不弹
    resetUi();
    h.onSnapshot({ now, sessions: [open] });
    h.onSnapshot({ now: now + 2000, sessions: [closed] });
    h.onSnapshot({ now: now + 4000, sessions: [closed] });
    await tick(10);
    assert.strictEqual(log.messages.length, 0);
    // 只消失一份快照（登记表文件正在改写）→ 不算关掉
    resetUi();
    const other = { ...open, id: SID2, key: 'claude:' + SID2 };
    h.onSnapshot({ now, sessions: [other] });
    h.onSnapshot({ now: now + 2000, sessions: [{ ...other, live: false }] });
    h.onSnapshot({ now: now + 4000, sessions: [other] });
    h.onSnapshot({ now: now + 6000, sessions: [other] });
    await tick(10);
    assert.strictEqual(log.messages.length, 0, 'flicker is not a close');
  } finally { h.dispose(); }

  resetUi();
  const a = claudeSession({ live: true, lastApiMs: now - 20 * MIN });
  const b = claudeSession({ id: SID2, live: true, lastApiMs: now - 20 * MIN });
  const rig = reminderRig([a, b]);
  try {
    rig.h.onSnapshot({ now, sessions: [a, b] });
    rig.h.onSnapshot({ now: now + 2000, sessions: [{ ...a, live: false }, { ...b, live: false }] });
    rig.h.onSnapshot({ now: now + 4000, sessions: [{ ...a, live: false }, { ...b, live: false }] });
    await tick(10);
    assert.strictEqual(log.messages.length, 0, 'window closing: no reminder');
  } finally { rig.h.dispose(); }
});

test('提醒：压缩次数增加 → 提示检查约束一次；首次看到不提示；“不再提示”后不再弹', async () => {
  resetUi();
  const now = Date.now();
  const s0 = claudeSession({ lastApiMs: now - 3 * HOUR });
  const s1 = claudeSession({ lastApiMs: now - 3 * HOUR, lastCompact: { ms: now - 1000, trigger: 'manual', preTokens: 400000 } });
  const fresh = claudeSession({ id: SID2, lastApiMs: now - 3 * HOUR, lastCompact: { ms: now - 5000 } });
  const { h, ctx } = reminderRig([s0]);
  ui.onMessage = (rec) => (rec.items.includes(t('compact.postCompact.off')) ? t('compact.postCompact.off') : undefined);
  try {
    h.onSnapshot({ now, sessions: [s0, fresh] });
    await tick();
    assert.strictEqual(log.messages.length, 0);
    h.onSnapshot({ now, sessions: [s1, fresh] });
    h.onSnapshot({ now, sessions: [s1, fresh] });
    await tick(10);
    const hints = log.messages.filter((m) => m.items.includes(t('compact.postCompact.off')));
    assert.strictEqual(hints.length, 1);
    assert.strictEqual(hints[0].msg, t('compact.postCompact', { title: s1.title }));
    assert.strictEqual(ctx.globalState.get(compact.HINT_OFF_KEY), true);
    const s2 = { ...s1, compactCount: 3 };
    h.onSnapshot({ now, sessions: [s2] });
    h.onSnapshot({ now, sessions: [{ ...s2, compactCount: 4 }] });
    await tick(10);
    assert.strictEqual(log.messages.filter((m) => m.items.includes(t('compact.postCompact.off'))).length, 1);
  } finally { h.dispose(); }
});

// ===========================================================================
// 词典
// ===========================================================================

test('词典：代码里用到的 compact.* / autocompact.* 键都在 compact.en.json 里，反之亦然；只用这两个前缀、无中日韩字符', () => {
  // compact 区由三个文件共用：compact.js、autocompact.js、compact-presets.js（§11.12.6）
  const src = ['compact.js', 'autocompact.js', 'compact-presets.js']
    .map((f) => fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8')).join('\n');
  const used = new Set(src.match(/'(?:auto)?compact\.[A-Za-z0-9.]+'/g).map((s) => s.slice(1, -1)));
  const keys = Object.keys(EN);
  for (const k of used) assert.ok(k in EN, `missing key ${k}`);
  for (const k of keys) {
    assert.ok(k.startsWith('compact.') || k.startsWith('autocompact.'), k);
    assert.ok(used.has(k), `unused key ${k}`);
    assert.ok(!/[　-鿿가-힯＀-￯]/.test(EN[k]), `CJK in ${k}`);
    assert.strictEqual(i18n.t(k), EN[k], `i18n resolves ${k}`);
  }
  // 其它区的键（entry.*、provider.*）在 core 里
  assert.notStrictEqual(i18n.t('entry.cli'), 'entry.cli');
  assert.notStrictEqual(i18n.t('provider.claude'), 'provider.claude');
});

test('安全：测试里每次 spawn 的都是临时目录里的假 CLI', () => {
  assert.ok(spawned.length >= 5);
  for (const s of spawned) {
    assert.strictEqual(s.cli, FAKE);
    assert.strictEqual(s.opts.shell, false);
  }
});

// ---------- 运行 ----------

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      results.push(true);
      console.log(`  ok    ${name}`);
    } catch (err) {
      results.push(false);
      console.log(`  FAIL  ${name}\n        ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n        ')}`);
    }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exitCode = passed === results.length ? 0 : 1;
})();
