'use strict';
// Tests for the compact feature: lib/compact.js, l10n/compact.en.json, test/fixtures/fake-claude.js.
// Run with plain node: node test/compact.test.js
// Never calls the real claude and never reads or writes ~/.claude: transcripts, the live-session registry and the CLI are all synthetic, in a temp dir;
// every spawn goes through a wrapper that asserts the executable is inside the temp dir. The temp dir is AGENT_MONITOR_TEST_TMP, or the system temp dir if unset.

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

// ---------- vscode stub ----------

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

// ---------- helpers ----------

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

/** Synthetic Claude session (same fields as Session in lib/providers/claude.js) */
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

// Synthetic transcript: one prompt + one assistant reply (its usage gives a 400K context)
function writeTranscript(file, sid, used = 400000) {
  mkdirp(path.dirname(file));
  const rows = [
    { type: 'user', timestamp: '2026-09-24T09:00:00.000Z', sessionId: sid, cwd: '/work/demo', entrypoint: 'claude-vscode', version: '2.1.280', message: { role: 'user', content: 'Synthetic prompt' } },
    { type: 'assistant', timestamp: '2026-09-24T09:00:05.000Z', sessionId: sid, message: { id: 'msg_fake_1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Synthetic reply.' }], stop_reason: 'end_turn', usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: used - 1100, output_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } } } },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// Synthetic live-session registry entry
function writeRegistry(home, pid, sid, o = {}) {
  const dir = mkdirp(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId: sid, cwd: '/work/demo', startedAt: NOW - HOUR, version: o.version || '2.1.280', kind: 'interactive',
    entrypoint: o.entrypoint || 'claude-vscode', status: o.status || 'idle', updatedAt: NOW, statusUpdatedAt: NOW,
  }));
}

// Copy the fake CLI into the temp dir and make it executable (chmod only toggles the read-only bit on Windows)
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
  // Windows cannot start a script from its shebang line. There the product spawns claude.exe directly (a .cmd shim is refused
  // before spawn), so the equivalent is running the fake CLI with this Node binary: still no shell, same args and options.
  if (process.platform === 'win32') return cp.spawn(process.execPath, [cli, ...args], opts);
  return cp.spawn(cli, args, opts);
}

/** A background-compact scenario: temp claudeHome, transcript, cwd and registry (with a single dead-process entry, so the registry counts as readable) */
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
// Cost estimates
// ===========================================================================

test('estimate: matches the reference price table (1-hour cache tier corrected for TTL, 5-minute tier unchanged)', () => {
  const warm = claudeSession({ lastApiMs: NOW - 10 * MIN });
  const cold = claudeSession({ lastApiMs: NOW - 2 * HOUR });
  approx(compact.estimateFor(warm, 'claude-opus-5-5', NOW).usd, 0.40, 'warm');
  approx(compact.estimateFor(cold, 'claude-opus-5-5', NOW).usd, 3.52, 'cold 1h');
  approx(compact.estimateFor(cold, 'claude-sonnet-5', NOW).usd, 1.76, 'sonnet 1h');
  const cold5 = claudeSession({ lastApiMs: NOW - 2 * HOUR, cacheTtl: '5m' });
  approx(compact.estimateFor(cold5, 'claude-opus-5-5', NOW).usd, 2.32, 'cold 5m');
  approx(compact.estimateFor(cold5, 'claude-sonnet-5', NOW).usd, 1.16, 'sonnet 5m');
  assert.strictEqual(compact.estimateFor(cold, 'claude-haiku-4-5', NOW).available, false);
  // Compacting after the cache has expired (used by reminders)
  approx(compact.estimateFor(warm, 'claude-opus-5-5', NOW, { expired: true }).usd, 3.52, 'forced expired');
});

test('estimate: applyTtl only corrects results that exactly match the 5-minute tier, so it never converts twice once the base estimator handles TTL', () => {
  const est = pricing.estimateCompact({ contextUsed: 400000, model: 'claude-opus-5-5', targetModel: 'claude-sonnet-5', ttl: '1h', lastActivityMs: null, now: NOW });
  const fixed = compact.applyTtl(est, '1h');
  approx(fixed.usd, 1.76);
  approx(compact.applyTtl(fixed, '1h').usd, 1.76, 'idempotent');
  const already = { ...est, readUsd: 400000 * 4 / 1e6, usd: 400000 * 4 / 1e6 + est.writeUsd };
  approx(compact.applyTtl(already, '1h').usd, 1.76, 'already 1h');
  const est5 = pricing.estimateCompact({ contextUsed: 400000, model: 'claude-opus-5-5', targetModel: 'claude-sonnet-5', ttl: '5m', lastActivityMs: null, now: NOW });
  approx(compact.applyTtl(est5, '5m').usd, 1.16, '5m untouched');
});

test('recommendation: the cheapest option is marked recommended; on a tie the original model wins; options without an id are never recommended', () => {
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
// QuickPick items
// ===========================================================================

test('items: open Claude session → two info rows at the top + compact in session / with keep instructions / handoff note, no background items', () => {
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

test('items: when busy, the first item detail is prefixed with "running"', () => {
  const s = claudeSession({ live: true, liveStatus: 'busy', lastApiMs: NOW - 1 * MIN });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: true, liveStatus: 'busy' });
  assert.ok(b.active.detail.startsWith(t('compact.detail.busy')), b.active.detail);
  const idle = compact.buildPickItems(s, { i18n, now: NOW, live: true, liveStatus: 'idle' });
  assert.ok(!idle.active.detail.includes(t('compact.detail.busy')));
});

test('items: cache expired and switching to Sonnet 5 saves ≥30% → info item below a separator (picking it only shows the explanation)', () => {
  const s = claudeSession({ live: true, liveStatus: 'idle', lastApiMs: NOW - 2 * HOUR });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: true, liveStatus: 'idle' });
  assert.ok(b.active.detail.includes(t('compact.detail.cacheExpired')));
  assert.ok(b.active.detail.includes(usd(3.52)), b.active.detail);
  const last = b.items[b.items.length - 1];
  assert.ok(isSep(b.items[b.items.length - 2]));
  assert.ok(last.label.includes('$(lightbulb)'));
  assert.strictEqual(last.action.type, 'info');
  assert.ok(last.action.text.includes(usd(1.76)), last.action.text);
  // Original model is already Sonnet 5: no such item
  const son = claudeSession({ live: true, model: 'claude-sonnet-5', lastApiMs: NOW - 2 * HOUR });
  const b2 = compact.buildPickItems(son, { i18n, now: NOW, live: true });
  assert.ok(!b2.items.some((it) => /lightbulb/.test(it.label || '')));
});

test('items: not open + cache expired → recommended Sonnet 5 first, original model second, Haiku disabled (context exceeds its window)', () => {
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
  // Info items at the top, handoff note after the compact items
  assert.strictEqual(b.items[0].action.type, 'info');
  assert.ok(b.items.indexOf(acts[2]) > b.items.indexOf(acts[1]));
});

test('items: not open + cache warm → original model recommended (cheapest while warm), with a note that a background run may miss the cache', () => {
  const s = claudeSession({ lastApiMs: NOW - 10 * MIN });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: false });
  const acts = actionItems(b);
  assert.strictEqual(acts[0].action.model, 'claude-opus-5-5');
  assert.strictEqual(acts[0].description, t('compact.recommended'));
  assert.ok(acts[0].detail.includes(usd(0.4)));
  assert.ok(acts[0].detail.includes(t('compact.detail.warmBest')));
  assert.ok(acts[0].detail.includes(t('compact.detail.bgMayMiss', { usd: usd(3.52) })), acts[0].detail);
});

test('items: 100K context → Haiku is selectable and cheapest, with a "summary may lose detail" note', () => {
  const s = claudeSession({ contextUsed: 100000, lastApiMs: NOW - 2 * HOUR });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: false });
  const acts = actionItems(b).filter((it) => it.action.type === 'background');
  assert.deepStrictEqual(acts.map((it) => it.action.model), ['claude-haiku-4-5', 'claude-opus-5-5', 'claude-sonnet-5']);
  assert.strictEqual(acts[0].description, t('compact.recommended'));
  assert.ok(acts[0].detail.includes(t('compact.detail.haiku')));
  assert.ok(!b.items.some((it) => /circle-slash/.test(it.label || '')));
});

test('items: unknown session model → no original-model item, only Sonnet 5 / Haiku, plus an explanation', () => {
  const s = claudeSession({ model: null, contextUsed: 100000, lastApiMs: NOW - 2 * HOUR });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: false });
  const models = actionItems(b).filter((it) => it.action.type === 'background').map((it) => it.action.model);
  assert.deepStrictEqual(models.sort(), ['claude-haiku-4-5', 'claude-sonnet-5']);
  assert.ok(b.items.some((it) => it.action && it.action.type === 'info' && it.action.text === t('compact.detail.noModel')));
});

test('items: 200K model running with 1M context (usage >200K) → original model passed as [1m], allowlist agrees', () => {
  const s = claudeSession({ model: 'claude-opus-4-6', contextUsed: 400000, lastApiMs: NOW - 2 * HOUR });
  const b = compact.buildPickItems(s, { i18n, now: NOW, live: false });
  const models = actionItems(b).filter((it) => it.action.type === 'background').map((it) => it.action.model);
  assert.ok(models.includes('claude-opus-4-6[1m]'), models.join());
  assert.ok(compact.allowedModels(s, NOW).includes('claude-opus-4-6[1m]'));
  assert.strictEqual(compact.cliModelFor('claude-opus-4-6', claudeSession({ model: 'claude-opus-4-6', contextUsed: 150000 })), 'claude-opus-4-6');
});

test('items: Codex session → open + copy /compact, handoff note, no background items', () => {
  const b = compact.buildPickItems(codexSession(), { i18n, now: NOW, live: false });
  assert.deepStrictEqual(actionItems(b).map((it) => it.action.type), ['codexOpen', 'handoff']);
  assert.strictEqual(b.active.action.type, 'codexOpen');
  assert.strictEqual(b.placeholder, t('compact.pick.placeholder.codex'));
  assert.ok(b.items[0].action.text.includes('AGENTS.md'));
});

// ===========================================================================
// Text, validation, arguments, CLI lookup, result parsing
// ===========================================================================

test('text: template comes from settings or the dictionary; /compact prefix and newlines are normalized', () => {
  assert.strictEqual(compact.resolveTemplate('', i18n), EN['compact.template']);
  assert.strictEqual(compact.resolveTemplate('  /compact keep A\nand B ', i18n), 'keep A and B');
  assert.strictEqual(compact.compactPrompt(''), '/compact');
  assert.strictEqual(compact.compactPrompt('/compact   '), '/compact');
  assert.strictEqual(compact.compactPrompt('keep paths'), '/compact keep paths');
  assert.strictEqual(compact.compactPrompt('x'.repeat(5000)).length, '/compact '.length + 2000);
  assert.deepStrictEqual(compact.tailLines('a\n\nb\nc\nd\ne\nf\ng\n'), ['c', 'd', 'e', 'f', 'g']);
});

test('args: the command argument can be a sessionKey or a session tree node', () => {
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

test('args: spawn argument order is fixed', () => {
  assert.deepStrictEqual(compact.buildSpawnArgs(SID, 'claude-sonnet-5', '/compact keep'),
    ['-p', '--resume', SID, '--model', 'claude-sonnet-5', '--output-format', 'json', '/compact keep']);
});

test('validation: rejects an invalid sessionId, a model outside the allowlist, and a missing cwd', () => {
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
  // Even an allowlisted value must have a valid shape
  assert.strictEqual(v({ model: 'bad model', allowed: ['bad model'] }), 'compact.error.badModel');
  for (const bad of [path.join(TMP, 'nope'), 'relative/dir', file, '', null]) {
    assert.strictEqual(v({ cwd: bad }), 'compact.error.cwd', String(bad));
  }
});

test('CLI lookup order: cliPath setting → PATH (pure JS) → binary bundled with the Claude extension → error', () => {
  const root = mkdirp(path.join(TMP, 'which'));
  const mk = (p, mode = 0o755) => { mkdirp(path.dirname(p)); fs.writeFileSync(p, '#!/bin/sh\n'); fs.chmodSync(p, mode); return p; };
  const dirA = mkdirp(path.join(root, 'a'));
  const dirB = mkdirp(path.join(root, 'b'));
  const dirN = mkdirp(path.join(root, 'noexec'));
  mk(path.join(dirN, 'claude'), 0o644);                 // not executable: skipped
  const inA = mk(path.join(dirA, 'claude'));
  mk(path.join(dirB, 'claude'));
  const ext = path.join(root, 'ext');
  const extBin = mk(path.join(ext, 'resources', 'native-binary', 'claude'));
  const setting = mk(path.join(root, 'custom', 'my-claude'));
  const env = { HOME: root };
  const f = (o) => compact.findCli({ platform: 'darwin', env, extensionPath: ext, ...o });

  assert.deepStrictEqual(f({ cliPath: setting }), { path: setting, source: 'setting' });
  assert.deepStrictEqual(f({ cliPath: '~/custom/my-claude' }), { path: setting, source: 'setting' });
  assert.deepStrictEqual(f({ cliPath: path.join(root, 'missing') }), { error: 'cliPath', path: path.join(root, 'missing') });
  assert.strictEqual(f({ cliPath: 'claude' }).error, 'cliPath', 'relative');
  assert.deepStrictEqual(f({ env: { PATH: '' }, extensionPath: path.join(root, 'no-ext') }), { error: 'notFound' });
  // The POSIX lookup needs a real execute bit and a ':'-separated PATH. A Windows host has neither: X_OK only checks
  // that the file exists, and drive letters (C:\...) contain ':'. The Windows lookup below runs on every host.
  if (process.platform !== 'win32') {
    const PATH = ['relative/bin', dirN, dirA, dirB].join(':');
    assert.strictEqual(f({ cliPath: path.join(dirN, 'claude') }).error, 'cliPath', 'not executable');
    assert.deepStrictEqual(f({ cliPath: '', env: { PATH, HOME: root } }), { path: inA, source: 'path' });
    assert.deepStrictEqual(f({ env: { PATH: dirN } }), { path: extBin, source: 'extension' });
    assert.deepStrictEqual(f({ env: { PATH: dirN }, extensionPath: null }), { error: 'notFound' });
  }

  // Windows: .exe wins; a lone .cmd ranks after the extension's bundled .exe; .cmd needs a shell, so it is blocked before spawn
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

test('CLI path setting: ~ is HOME on macOS/Linux; on Windows it is USERPROFILE (HOME may be a Git Bash path), then the OS home dir', () => {
  const root = mkdirp(path.join(TMP, 'home-expand'));
  const posixHome = mkdirp(path.join(root, 'posix'));
  const winHome = mkdirp(path.join(root, 'win'));
  const mk = (p) => { mkdirp(path.dirname(p)); fs.writeFileSync(p, '#!/bin/sh\n'); fs.chmodSync(p, 0o755); return p; };
  const inPosix = mk(path.join(posixHome, 'bin', 'claude'));
  const inWin = mk(path.join(winHome, 'bin', 'claude.exe'));
  const both = { HOME: posixHome, USERPROFILE: winHome };
  // macOS / Linux: unchanged, HOME wins and USERPROFILE is ignored
  assert.strictEqual(compact.homeFor(both, 'darwin'), posixHome);
  assert.strictEqual(compact.homeFor(both, 'linux'), posixHome);
  assert.strictEqual(compact.homeFor({ USERPROFILE: winHome }, 'linux'), os.homedir());
  assert.deepStrictEqual(compact.findCli({ platform: 'darwin', env: both, cliPath: '~/bin/claude' }), { path: inPosix, source: 'setting' });
  // Windows: USERPROFILE wins over a POSIX-style HOME; without USERPROFILE, the OS home dir (HOME is not used)
  const gitBash = { HOME: '/c/Users/someone', USERPROFILE: winHome };
  assert.strictEqual(compact.homeFor(gitBash, 'win32'), winHome);
  assert.strictEqual(compact.homeFor({ HOME: '/c/Users/someone' }, 'win32'), os.homedir());
  assert.strictEqual(compact.homeFor(null, 'win32'), os.homedir());
  assert.deepStrictEqual(compact.findCli({ platform: 'win32', env: gitBash, cliPath: '~/bin/claude.exe' }), { path: inWin, source: 'setting' });
  if (process.platform === 'win32') {
    assert.deepStrictEqual(compact.findCli({ platform: 'win32', env: gitBash, cliPath: '~\\bin\\claude.exe' }), { path: inWin, source: 'setting' });
  }
});

test('result parsing: whole-output JSON, last result line among many, garbage output', () => {
  assert.strictEqual(compact.parseResultJson('{"type":"result","is_error":false,"total_cost_usd":0.5}').total_cost_usd, 0.5);
  assert.strictEqual(compact.parseResultJson('noise\n{"type":"system"}\n{"type":"result","is_error":true}\n').is_error, true);
  assert.strictEqual(compact.parseResultJson('not json'), null);
  assert.strictEqual(compact.parseResultJson(''), null);
});

test('transcript: finds only the last compact_boundary after the offset; rescans from the start if the file got shorter', () => {
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
// Command flows (vscode stub)
// ===========================================================================

test('flow: registry shows the session open (snapshot not updated yet) → compact in session: prefill the template and copy it', async () => {
  resetUi();
  const sc = scenario('live-vscode', { session: { live: false } });
  writeRegistry(sc.home, process.pid, SID, { status: 'idle' });
  ui.onExecute = () => undefined; // the Claude extension command exists
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

test('flow: Claude extension command missing or throws → copy only and notify', async () => {
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

test('flow: open session started from a terminal → skip the Claude extension, copy and tell the user to switch to that window', async () => {
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

test('flow: picking an info item only shows it and keeps the QuickPick open; then "with keep instructions" → edit in an InputBox, then prefill', async () => {
  resetUi();
  const sc = scenario('live-custom', { session: { live: true } });
  writeRegistry(sc.home, process.pid, SID);
  ui.onExecute = () => undefined;
  ui.onQuickPick = (qp) => {
    qp.accept(qp.items[0]);                     // info item
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

test('flow: the compactTemplate setting overrides the default template', async () => {
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

test('flow: Codex → open vscode://openai.chatgpt/local/<id> and copy /compact; if opening fails, copy only', async () => {
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

test('flow: write handoff note → prefill the prompt; the notification can copy a resume prompt', async () => {
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

test('handoff command: runHandoff(sessionKey) shares its code path with "write handoff note" in the QuickPick; module-level runHandoff forwards to the active instance', async () => {
  resetUi();
  const sc = scenario('handoff-cmd', { session: { live: true } });
  writeRegistry(sc.home, process.pid, SID);
  ui.onExecute = () => undefined;
  try {
    await sc.handle.runHandoff(sc.session.key);
    assert.strictEqual(log.quickPicks.length, 0, 'no picker when an argument is given');
    assert.deepStrictEqual(log.executed.find((e) => e[0] === 'claude-vscode.editor.open'), ['claude-vscode.editor.open', SID, t('compact.handoff.prompt')]);
    assert.ok(log.messages.pop().msg.includes(t('compact.handoff.next')));
    // Module-level entry point (extension.js can require and call it directly); the argument can also be a session tree node
    log.executed = [];
    await compact.runHandoff({ key: sc.session.key });
    assert.ok(log.executed.some((e) => e[0] === 'claude-vscode.editor.open' && e[2] === t('compact.handoff.prompt')));
  } finally { sc.handle.dispose(); }
  await assert.rejects(() => compact.runHandoff(SID), /not active/, 'module-level entry point is unavailable after dispose');
});

test('handoff command: no argument → pick a session first (all sessions listed, the selected one first); session closed → copy only; session not listed → error', async () => {
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
    assert.deepStrictEqual(qp.items.map((it) => it.key), [cx.key, sc.session.key], 'sessions with a small context are listed too; the selected one comes first');
    assert.deepStrictEqual(log.clipboard, [t('compact.handoff.prompt')]);
    assert.ok(log.messages.pop().msg.includes(t('compact.handoff.next.codex')));
    // Claude session closed (registry readable, session not in it): the claude-vscode entry point still reopens it with editor.open and prefills;
    // falls back to copy only when the Claude extension command is unavailable
    resetUi();
    await sc.handle.runHandoff(sc.session.key);
    assert.ok(log.executed.some((e) => e[0] === 'claude-vscode.editor.open' && e[1] === SID));
    assert.deepStrictEqual(log.clipboard, [t('compact.handoff.prompt')]);
    assert.ok(log.messages.pop().msg.startsWith(t('compact.deliver.copied')));
    // not in the list
    resetUi();
    await sc.handle.runHandoff('claude:' + SID2);
    assert.strictEqual(log.messages.pop().msg, t('compact.error.noSession'));
    // no sessions
    resetUi();
    sc.sessions.clear();
    await sc.handle.runHandoff();
    assert.strictEqual(log.messages.pop().msg, t('compact.handoff.noSessions'));
  } finally { sc.handle.dispose(); }
});

test('compact command: with no argument, the selected session comes first (when getSelectedKey is provided)', async () => {
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

test('flow: background compact (fake CLI) → args, cwd, stdin, transcript append, completion notice with pre → post and cost', async () => {
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
    // The input box is prefilled with the template; the confirm dialog is modal and shows the model and estimate
    assert.strictEqual(log.inputs[0].value, EN['compact.template']);
    const confirm = log.messages.find((m) => m.opts && m.opts.modal);
    assert.ok(confirm.opts.detail.includes('claude-sonnet-5') && confirm.opts.detail.includes(usd(1.76)), confirm.opts.detail);
    assert.ok(!confirm.opts.detail.includes(t('compact.confirm.unverified')));
    assert.strictEqual(log.progress[0].opts.cancellable, true);
    assert.strictEqual(log.progress[0].opts.location, vscode.ProgressLocation.Notification);
    // The transcript gained a compact_boundary (400000 → 12000)
    const done = log.messages[log.messages.length - 1];
    assert.strictEqual(done.msg, t('compact.done', { title: sc.session.title, pre: i18n.fmtTokens(400000), post: i18n.fmtTokens(12000), usd: usd(0.0123), model: 'claude-sonnet-5' }));
    assert.ok(fs.readFileSync(sc.file, 'utf8').includes('compact_boundary'));
    assert.ok(log.output.some((l) => /ok code=0/.test(l)));
  } finally { sc.handle.dispose(); }
});

test('flow: compactConfirm off and registry readable → no confirmation; registry unreadable → still confirms and says it cannot verify', async () => {
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
  fs.rmSync(path.join(sc2.home, 'sessions'), { recursive: true, force: true, maxRetries: 5 });
  config.compactConfirm = false;
  ui.onQuickPick = pickBackground('claude-sonnet-5');
  try {
    await sc2.handle.compact(sc2.session.key);   // not confirmed → does not run
    const confirm = log.messages.find((m) => m.opts && m.opts.modal);
    assert.ok(confirm && confirm.opts.detail.includes(t('compact.confirm.unverified')));
    assert.strictEqual(readFakeLog(sc2), null);
  } finally { sc2.handle.dispose(); }
});

test('flow: registry is rechecked before running; session was just opened → abort without starting the CLI; offer to compact in the session instead', async () => {
  resetUi();
  const sc = scenario('bg-recheck');
  const before = spawned.length;
  ui.onQuickPick = pickBackground('claude-sonnet-5');
  ui.onInputBox = (o) => { writeRegistry(sc.home, process.pid, SID); return o.value; }; // the session gets opened in the meantime
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

test('flow: CLI fails → modal error whose detail is the exit code and the last 5 stderr lines', async () => {
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

test('flow: result JSON has is_error → treated as a failure, shows the first error line', async () => {
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

test('flow: cancel → kills the child process and reports it was cancelled', async () => {
  resetUi();
  // Timeout set to 15 s: cancelling must finish within a few seconds, not rely on the timeout
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

test('flow: timeout → kills the child process and reports the timeout', async () => {
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

test('flow: dispose kills a still-running child process', async () => {
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

test('flow: missing cwd, invalid sessionId, or session no longer listed → error, CLI not started', async () => {
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

test('flow: CLI not found → error with an option to open settings', async () => {
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

test('flow: no argument → pick a session first (only compactable sessions listed)', async () => {
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
// Reminders
// ===========================================================================

test('reminder check: cache about to expire (1-hour tier, idle, large enough, saves ≥ $0.50)', () => {
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
  // 5-minute tier: silent by default, shown only when cacheReminderShortTtl is on
  const short = claudeSession({ ...base, cacheTtl: '5m', lastApiMs: NOW - 2 * MIN });
  assert.strictEqual(compact.cacheReminderDue(short, NOW, {}), null);
  assert.ok(compact.cacheReminderDue(short, NOW, { shortTtl: true }));
  // Saves less than $0.50: Haiku at 150K
  assert.strictEqual(compact.cacheReminderDue(claudeSession({ ...base, model: 'claude-haiku-4-5', contextUsed: 150000 }), NOW, {}), null);
  assert.strictEqual(compact.cacheReminderDue(codexSession(), NOW, {}), null);
});

test('reminder check: window closed (cache warm, large enough; only the claude-vscode entry point offers "reopen")', () => {
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

test('reminder: cache about to expire → shown once per cache window; the "compact with keep instructions" button prefills the template', async () => {
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
    // No reminder for sessions outside this window's workspace
    resetUi();
    const other = claudeSession({ id: SID2, live: true, lastApiMs: now - 55 * MIN, extra: { notInWs: true } });
    h.onSnapshot({ now, sessions: [other] });
    await tick(10);
    assert.strictEqual(log.messages.length, 0);
  } finally { h.dispose(); }
});

test('reminder: window closed (live → gone) shows once; closing several at once shows nothing; "do not remind" is saved to workspaceState', async () => {
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
    // "Do not remind" is set: closing again shows nothing
    resetUi();
    h.onSnapshot({ now, sessions: [open] });
    h.onSnapshot({ now: now + 2000, sessions: [closed] });
    h.onSnapshot({ now: now + 4000, sessions: [closed] });
    await tick(10);
    assert.strictEqual(log.messages.length, 0);
    // Gone for only one snapshot (registry file being rewritten) → not counted as closed
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

test('reminder: a replayed snapshot (replay: true, a follower window re-running the last one) never confirms a closed window; the next real one does', async () => {
  resetUi();
  const now = Date.now();
  const open = claudeSession({ live: true, liveStatus: 'busy', lastApiMs: now - 20 * MIN });
  const closed = { ...open, live: false, liveStatus: null };
  const { h } = reminderRig([open]);
  try {
    h.onSnapshot({ now, sessions: [open] });
    h.onSnapshot({ now: now + 2000, sessions: [closed] }); // one failed registry read
    h.onSnapshot({ now: now + 4000, sessions: [closed], replay: true });
    h.onSnapshot({ now: now + 6000, sessions: [closed], replay: true });
    await tick(10);
    assert.strictEqual(log.messages.length, 0, 'replays counted as a second look');
    h.onSnapshot({ now: now + 7000, sessions: [open] }); // the next real scan sees it live again
    await tick(10);
    assert.strictEqual(log.messages.length, 0);
    h.onSnapshot({ now: now + 9000, sessions: [closed] });
    h.onSnapshot({ now: now + 11000, sessions: [closed], replay: true });
    h.onSnapshot({ now: now + 13000, sessions: [closed] });
    await tick(10);
    assert.strictEqual(log.messages.filter((m) => m.items.includes(t('compact.remind.close.compact'))).length, 1, 'two real snapshots confirm it');
  } finally { h.dispose(); }
});

test('reminder: compact count goes up → prompt once to check constraints; no prompt on first sight; nothing more after "do not show again"', async () => {
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
// Dictionary
// ===========================================================================

test('dictionary: every compact.* / autocompact.* key used in code is in compact.en.json and vice versa; only these two prefixes; no CJK characters', () => {
  // The compact section is shared by three files: compact.js, autocompact.js, compact-presets.js
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
  // Keys from other sections (entry.*, provider.*) live in core
  assert.notStrictEqual(i18n.t('entry.cli'), 'entry.cli');
  assert.notStrictEqual(i18n.t('provider.claude'), 'provider.claude');
});

test('safety: every spawn in these tests runs the fake CLI from the temp dir', () => {
  assert.ok(spawned.length >= 5);
  for (const s of spawned) {
    assert.strictEqual(s.cli, FAKE);
    assert.strictEqual(s.opts.shell, false);
  }
});

// ---------- run ----------

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
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch { /* ignore */ }
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exitCode = passed === results.length ? 0 : 1;
})();
