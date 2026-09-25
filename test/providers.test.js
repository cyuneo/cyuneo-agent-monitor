'use strict';
// End-to-end tests for the Copilot provider wired into lib/monitor.js (the provider registry), plus the pieces around
// it: status.js, pricing hooks, workspace scope, push limit hits and the terminal version's options.
// Run with plain node: node test/providers.test.js
// All data is synthetic and built at runtime in a temp directory (a fake VS Code user dir); every Monitor gets explicit
// dirs and an empty environment, so nothing is read from the real ones.
// Temp directory: AGENT_MONITOR_TEST_TMP (falls back to the system temp directory); deleted after the run.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { Monitor, normalizeConfig, sameExceptObserved, createProvider, PROVIDER_NAMES, LAZY_PROVIDERS, PROBE_MS } = require('../lib/monitor');
const S = require('../lib/core/status');
const pricing = require('../lib/core/pricing');
const scope = require('../lib/scope');
const push = require('../lib/push');
const i18nLib = require('../lib/i18n');
const cli = require('../bin/agent-monitor');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-providers-'));

// ---------- Helpers ----------

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`  FAIL  ${name}\n        ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n        ')}`);
  }
}
const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const S0 = (s) => T0 + s * 1000;
const iso = (s) => new Date(S0(s)).toISOString();
const line = (o) => JSON.stringify(o) + '\n';
const touch = (f, s) => fs.utimesSync(f, new Date(S0(s)), new Date(S0(s)));
const settle = () => new Promise((r) => setTimeout(r, 30));
const CWD = path.join(TMP, 'repos', 'app');
fs.mkdirSync(CWD, { recursive: true });

// ---------- Synthetic Copilot chat logs (VS Code chat session shape, reduced) ----------

const CP_ID = (n) => `c0p11070-0000-4000-8000-${String(n).padStart(12, '0')}`;
function cpRequest(n, o = {}) {
  const r = {
    requestId: `request_${n}`, timestamp: o.ts ?? S0(-60 + n), message: { text: o.text ?? `prompt ${n}`, parts: [] },
    modelId: 'copilot/claude-sonnet-4.5', agent: { id: 'github.copilot.editsAgent', name: 'agent', extensionVersion: '0.40.1' },
    response: [{ value: 'done', supportThemeIcons: false }],
  };
  const state = o.state ?? 1;
  r.modelState = state === 0 ? { value: 0 } : { value: state, completedAt: o.doneAt ?? S0(-50 + n) };
  r.result = o.result || { timings: { totalElapsed: 5000 }, usage: { promptTokens: 1000 * n, completionTokens: 10 * n, promptTokenDetails: [] } };
  return r;
}
function cpRoot(id, requests) {
  return {
    version: 3, sessionId: id, creationDate: S0(-120), initialLocation: 'panel', requests, pendingRequests: [],
    inputState: { mode: { id: 'agent', kind: 'agent' }, permissionLevel: 'default',
      selectedModel: { identifier: 'copilot/claude-sonnet-4.5', metadata: { id: 'claude-sonnet-4.5', maxInputTokens: 128000, multiplierNumeric: 1 } } },
  };
}
/** A VS Code user dir with one workspace (hash) whose chatSessions hold the given sessions */
function copilotUser(name, sessions, hash = 'ws1') {
  const u = path.join(TMP, name, 'User');
  const ws = path.join(u, 'workspaceStorage', hash);
  fs.mkdirSync(path.join(ws, 'chatSessions'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(CWD).href }));
  const files = {};
  for (const [id, requests, mtimeS] of sessions) {
    const f = path.join(ws, 'chatSessions', `${id}.jsonl`);
    fs.writeFileSync(f, line({ kind: 0, v: cpRoot(id, requests) }));
    touch(f, mtimeS);
    files[id] = f;
  }
  return { u, ws, files };
}

// ---------- Monitor config: only the dirs given here, never the real ones ----------

function monitorCfg(o = {}) {
  return {
    activeWindowMinutes: 30, staleMinutes: 5, daily: false,
    claude: { enabled: false, projectsDir: path.join(TMP, 'no-claude', 'projects') },
    codex: { enabled: false, home: path.join(TMP, 'no-codex') },
    // off by default, and never the real VS Code dir even when a test only flips enabled
    copilot: { enabled: false, userDir: path.join(TMP, 'no-vscode', 'User') },
    ...o,
  };
}
const monitor = (o, deps = {}) => new Monitor(monitorCfg(o), { env: {}, ...deps });

// A fake provider module that records what the Monitor does with it
function fakeModule(name, behaviour = {}) {
  const calls = { ctor: 0, scan: 0, quota: 0, dispose: 0, opts: null };
  const Ctor = class {
    constructor(opts) {
      calls.ctor++;
      calls.opts = opts;
      if (behaviour.ctorThrows) throw new Error(`synthetic ${name} init failure`);
    }
    scan(now, o) {
      calls.scan++;
      calls.keepKeys = o && o.keepKeys;
      if (behaviour.scanThrows) throw new Error(`synthetic ${name} scan failure`);
      return (behaviour.sessions || []).map((s) => ({ ...s }));
    }
    quota() {
      calls.quota++;
      if (behaviour.quotaThrows) throw new Error(`synthetic ${name} quota failure`);
      return { lastHit: behaviour.lastHit || null };
    }
    detail(key) { return { key, agents: {} }; }
    dispose() { calls.dispose++; }
  };
  const ctorName = { copilot: 'CopilotProvider' }[name];
  return { mod: { [ctorName]: Ctor }, calls };
}
const fakeSession = (provider, id, now, extra = {}) => ({
  key: `${provider}:${id}`, provider, id, title: id, titleSource: 'ai', cwd: CWD, updatedMs: now - 1000, startedMs: now - 60e3,
  live: false, main: { kind: 'main', status: S.makeStatus('done', now - 1000) }, agents: [], workflows: [], ...extra,
});

(async () => {
  // ---------- normalizeConfig ----------
  console.log('config');

  await test('normalizeConfig: Copilot default on with the provider\'s default dirs; sameExceptObserved sees it', () => {
    const c = normalizeConfig({}, {});
    assert.deepStrictEqual(c.copilot, { enabled: true, userDir: null });
    const s = normalizeConfig({ copilot: { enabled: false, userDir: '/U' } }, {});
    assert.deepStrictEqual(s.copilot, { enabled: false, userDir: '/U' });
    assert.strictEqual(normalizeConfig({ copilot: { userDir: 42 } }, {}).copilot.userDir, null);
    assert.ok(!sameExceptObserved(normalizeConfig({}, {}), normalizeConfig({ copilot: { enabled: false } }, {})), 'a provider switch needs a rebuild');
    assert.deepStrictEqual([...PROVIDER_NAMES], ['codex', 'copilot']);
    assert.deepStrictEqual([...LAZY_PROVIDERS], ['copilot']);
  });

  await test('a leading ~ (~/ or ~\\) in the dir settings and env vars is the home dir, in normalizeConfig and in the provider alike', () => {
    const H = os.homedir();
    const { CopilotProvider } = require('../lib/providers/copilot');
    const { expandHome } = require('../lib/monitor');
    assert.deepStrictEqual([expandHome('~'), expandHome(' ~/a/b '), expandHome('~\\a'), expandHome('/x/~/y'), expandHome('~user/x'), expandHome(''), expandHome(null)],
      [H, path.join(H, 'a', 'b'), path.join(H, 'a'), '/x/~/y', '~user/x', '', '']);
    // env vars
    const e = normalizeConfig({}, { CODEX_HOME: '~/cx', CLAUDE_CONFIG_DIR: '~/cl' });
    assert.deepStrictEqual([e.claude.projectsDir, e.claude.configDir, e.claude.configDirSource], [path.join(H, 'cl', 'projects'), path.join(H, 'cl'), 'env']);
    assert.deepStrictEqual([e.codex.home, e.codex.homeSource], [path.join(H, 'cx'), 'env']);
    // settings
    const s = normalizeConfig({ copilot: { userDir: '~/Code/User' }, codex: { home: '~' } }, {});
    assert.deepStrictEqual([s.copilot.userDir, s.codex.home], [path.join(H, 'Code', 'User'), H]);
    assert.deepStrictEqual(new CopilotProvider({ userDir: '~/Code/User' }).userDirs, [s.copilot.userDir]);
  });

  // ---------- Monitor end to end with the real provider ----------
  console.log('Monitor with the real Copilot provider (synthetic data)');

  const cp = copilotUser('e2e-copilot', [
    [CP_ID(1), [cpRequest(1), cpRequest(2)], -20],
    [CP_ID(2), [cpRequest(1, { state: 3, doneAt: S0(-30), result: { errorDetails: { message: 'You have exceeded your premium request allowance', isQuotaExceeded: true } } })], -25],
  ]);
  const e2eCfg = { copilot: { enabled: true, userDir: cp.u } };
  const KEYS = { cp1: `copilot:${CP_ID(1)}`, cp2: `copilot:${CP_ID(2)}` };

  await test('snapshot: Copilot sessions sorted; source found / ok; quota lastHit; details for focused keys', async () => {
    const mon = monitor(e2eCfg);
    mon.setFocus([KEYS.cp1]);
    const snap = mon.snapshot(S0(0));
    const byKey = new Map(snap.sessions.map((s) => [s.key, s]));
    assert.deepStrictEqual([...byKey.keys()].sort(), Object.values(KEYS).sort());
    const st = snap.sessions.map((s) => s.startedMs);
    assert.deepStrictEqual(st, [...st].sort((a, b) => b - a), 'newest start first');
    assert.deepStrictEqual(snap.sources.copilot, { enabled: true, ok: true, error: null, found: true });
    assert.ok(mon.provider('copilot'));
    assert.deepStrictEqual(mon.takeErrors(), []);
    // provider-specific fields come through untouched
    const c1 = byKey.get(KEYS.cp1);
    assert.strictEqual(c1.provider, 'copilot');
    assert.strictEqual(c1.cwd, CWD);
    assert.strictEqual(c1.copilot.storage, 'workspace');
    assert.strictEqual(c1.contextWindowSource, 'copilot-model');
    assert.strictEqual(byKey.get(KEYS.cp2).main.status.code, 'quota');
    // quota: { lastHit }, same shape as Claude's
    assert.strictEqual(snap.quota.copilot.lastHit.sessionKey, KEYS.cp2);
    assert.strictEqual(snap.quota.copilot.lastHit.ms, S0(-30));
    // details for the focused key (storage not measured yet on the first call), dispatched by provider
    assert.deepStrictEqual(Object.keys(snap.details), [KEYS.cp1]);
    assert.ok(snap.details[KEYS.cp1].agents && Object.keys(snap.details[KEYS.cp1].agents).length);
    assert.strictEqual(snap.details[KEYS.cp1].storage, null);
    assert.strictEqual(mon.detail('copilot:nope'), null);
    // the whole snapshot survives the worker's structured clone
    assert.strictEqual(structuredClone(snap).sessions.length, 2);
    // per-session storage: the session file
    await settle();
    const again = mon.snapshot(S0(1));
    const cs = again.details[KEYS.cp1].storage;
    assert.deepStrictEqual([cs.transcriptBytes, cs.fileHistoryBytes, cs.transcript], [fs.statSync(cp.files[CP_ID(1)]).size, null, cp.files[CP_ID(1)]]);
    mon.dispose();
    assert.strictEqual(mon.provider('copilot').readers.size, 0, 'dispose reaches the provider');
  });

  await test('with Claude and Codex (fake) on as well: every provider is merged, Codex behaves as before', () => {
    const now = S0(0);
    const codex = { CodexProvider: class { scan(n) { return [fakeSession('codex', 'cx1', n)]; } quota() { return { observedMs: 1, planType: 'plus', limitId: 'codex', windows: [], reachedType: null, credits: null }; } } };
    const mon = monitor({ ...e2eCfg, codex: { enabled: true, home: path.join(TMP, 'no-codex') } }, { codexModule: codex });
    const snap = mon.snapshot(now);
    assert.deepStrictEqual(snap.sessions.map((s) => s.provider).sort(), ['codex', 'copilot', 'copilot']);
    assert.strictEqual(snap.quota.codex.planType, 'plus');
    assert.strictEqual(snap.sources.codex.ok, true);
    assert.deepStrictEqual(Object.keys(snap.sources).sort(), ['claude', 'codex', 'copilot']);
  });

  // ---------- Isolation ----------
  console.log('error isolation');

  await test('a provider failing to read its quota keeps its sessions; Codex failing never breaks Copilot; errors are named after the provider', () => {
    const now = S0(0);
    const dir = copilotUser('iso-copilot', []).u;
    const cpF = fakeModule('copilot', { quotaThrows: true, sessions: [fakeSession('copilot', 'c1', now)] });
    const mon = monitor({
      copilot: { enabled: true, userDir: dir },
      codex: { enabled: true, home: path.join(TMP, 'no-codex') },
    }, {
      modules: { copilot: cpF.mod },
      codexModule: { CodexProvider: class { scan() { throw new Error('codex boom'); } } },
    });
    const snap = mon.snapshot(now);
    assert.deepStrictEqual(snap.sessions.map((s) => s.key), ['copilot:c1'], 'the Copilot sessions survive its failing quota read');
    assert.deepStrictEqual([snap.sources.copilot.ok, snap.sources.codex.ok], [true, false]);
    const errs = new Map(mon.takeErrors());
    assert.deepStrictEqual([...errs.keys()].sort(), ['codex', 'copilot']);
    assert.ok(/quota: synthetic copilot quota failure/.test(errs.get('copilot')));
    assert.deepStrictEqual(snap.quota.copilot, { lastHit: null });
    // focus keys go to their own provider only
    mon.setFocus(['copilot:c1', 'codex:x1', 'claude:c1']);
    mon.snapshot(now + PROBE_MS);
    assert.deepStrictEqual(cpF.calls.keepKeys, ['copilot:c1']);
    mon.dispose();
    assert.strictEqual(cpF.calls.dispose, 1);
  });

  await test('a constructor that failed is not retried; a scan that failed is retried on the next tick', () => {
    const now = S0(0);
    const dir = copilotUser('iso-copilot-2', []).u;
    const bad = fakeModule('copilot', { ctorThrows: true });
    const m1 = monitor({ copilot: { enabled: true, userDir: dir } }, { modules: { copilot: bad.mod } });
    const s1 = m1.snapshot(now);
    assert.strictEqual(s1.sources.copilot.ok, false);
    assert.ok(/init: synthetic copilot init failure/.test(s1.sources.copilot.error));
    m1.snapshot(now + PROBE_MS + 1);
    assert.strictEqual(bad.calls.ctor, 1);
    const flaky = fakeModule('copilot', { scanThrows: true });
    const m2 = monitor({ copilot: { enabled: true, userDir: dir } }, { modules: { copilot: flaky.mod } });
    const s2 = m2.snapshot(now);
    assert.ok(/synthetic copilot scan failure/.test(s2.sources.copilot.error));
    m2.snapshot(now + 2000);
    assert.deepStrictEqual([flaky.calls.ctor, flaky.calls.scan], [1, 2]);
  });

  await test('createProvider: a module without a usable constructor, or an unknown name, is an error, not a crash', () => {
    const r = createProvider('copilot', normalizeConfig({ copilot: { userDir: path.join(TMP, 'u') } }, {}), { nothing: true });
    assert.deepStrictEqual(r, { inst: null, error: 'copilot provider has no usable constructor' });
    assert.strictEqual(createProvider('nope', normalizeConfig({}, {})).error, 'unknown provider nope');
  });

  // ---------- Cost when off or absent ----------
  console.log('disabled / missing folders');

  await test('a disabled provider is never loaded, built or scanned; the snapshot still carries its (empty) quota and source', () => {
    const f = fakeModule('copilot');
    const mon = monitor({}, { modules: { copilot: f.mod } });
    const snap = mon.snapshot(S0(0));
    assert.deepStrictEqual(f.calls.ctor + f.calls.scan, 0);
    assert.deepStrictEqual(snap.quota.copilot, { lastHit: null });
    assert.deepStrictEqual(snap.sources.copilot, { enabled: false, ok: true, error: null, found: false });
    assert.deepStrictEqual(mon.slots, []);
  });

  await test('a missing data folder costs one stat every PROBE_MS and nothing in between; the provider is built once the folder appears', () => {
    const base = path.join(TMP, 'late');
    const dir = path.join(base, 'User');
    const f = fakeModule('copilot');
    const mon = monitor({ copilot: { enabled: true, userDir: dir } }, { modules: { copilot: f.mod } });
    const realStat = fs.statSync;
    const stats = [];
    fs.statSync = function (p, ...rest) { stats.push(String(p)); return realStat.call(fs, p, ...rest); };
    try {
      const t = S0(0);
      mon.snapshot(t);
      assert.deepStrictEqual(stats, [dir]);
      stats.length = 0;
      for (let i = 1; i <= 10; i++) mon.snapshot(t + i * 2000);
      assert.deepStrictEqual(stats, [], 'no file system work between probes');
      mon.snapshot(t + PROBE_MS);
      assert.strictEqual(stats.length, 1, 'probed again after PROBE_MS');
      assert.strictEqual(f.calls.ctor + f.calls.scan, 0);
      // the folder shows up: built and scanned on the next probe, never before
      fs.mkdirSync(dir, { recursive: true });
      mon.snapshot(t + PROBE_MS + 2000);
      assert.strictEqual(f.calls.ctor, 0);
      const snap = mon.snapshot(t + 2 * PROBE_MS);
      assert.deepStrictEqual([f.calls.ctor, f.calls.scan], [1, 1]);
      assert.strictEqual(snap.sources.copilot.found, true);
      stats.length = 0;
      mon.snapshot(t + 2 * PROBE_MS + 2000);
      assert.ok(!stats.includes(dir), 'a built provider is not probed again');
    } finally {
      fs.statSync = realStat;
    }
    // the clock going back probes at once
    const dir2 = path.join(TMP, 'late-2', 'User');
    const f2 = fakeModule('copilot');
    const m2 = monitor({ copilot: { enabled: true, userDir: dir2 } }, { modules: { copilot: f2.mod } });
    m2.snapshot(S0(0));
    fs.mkdirSync(dir2, { recursive: true });
    m2.snapshot(S0(0) - 1000);
    assert.strictEqual(f2.calls.ctor, 1);
  });

  await test('the real provider over a missing folder: no sessions, no errors, nothing built', () => {
    const mon = monitor({ copilot: { enabled: true, userDir: path.join(TMP, 'none', 'User') } });
    const snap = mon.snapshot(S0(0));
    assert.deepStrictEqual(snap.sessions, []);
    assert.deepStrictEqual(mon.takeErrors(), []);
    assert.strictEqual(mon.provider('copilot'), null);
    assert.deepStrictEqual([snap.sources.copilot.ok, snap.sources.copilot.found], [true, false]);
  });

  await test('provider options: dir, window, stale minutes, limits and the approval guess reach the provider', () => {
    const dir = copilotUser('opts-copilot', []).u;
    const f = fakeModule('copilot');
    const mon = monitor({
      activeWindowMinutes: 45, staleMinutes: 7, approvalGuess: 'allTools', approvalGuessSeconds: 90,
      copilot: { enabled: true, userDir: dir },
    }, { modules: { copilot: f.mod } });
    mon.snapshot(S0(0));
    const o = f.calls.opts;
    assert.strictEqual(o.userDir, dir);
    assert.deepStrictEqual([o.activeWindowMinutes, o.staleMinutes, o.approvalGuess, o.approvalGuessSeconds, o.limits.timeline], [45, 7, 'allTools', 90, 30]);
    assert.deepStrictEqual(o.env, {}, 'the Monitor environment, never process.env');
    assert.ok(!('home' in o) && !('claude' in o), 'no WorkerConfig fields that a provider would misread');
  });

  // ---------- status.js, pricing, resume ----------
  console.log('shared tables');

  await test('status.js: Copilot records its waits (no guessing list); its context-window source', () => {
    assert.ok(!S.isFastTool('copilot', 'read_file'), 'Copilot records its waits: no guessing list');
    assert.strictEqual(S.WINDOW_SOURCE.COPILOT_MODEL, 'copilot-model');
  });

  await test('pricing: no re-read cost for Copilot (credits, not USD)', () => {
    assert.deepStrictEqual(pricing.rereadCost('copilot', 'copilot/claude-sonnet-4.5', 1000), { usdIfMiss: null, usdIfHit: null });
  });

  await test('resume: no hints for Copilot (no confirmed resume command), even after an error', () => {
    const { resumeHints } = require('../lib/core/resume');
    const s = fakeSession('copilot', 'x', S0(0), { main: { kind: 'main', status: S.makeStatus('apiError', S0(0)), tokens: { contextUsed: 10 } } });
    assert.deepStrictEqual(resumeHints(s, { now: S0(1) }), []);
  });

  // ---------- Scope ----------
  console.log('workspace scope');

  await test('scope: Copilot by workspace storage, .code-workspace file or empty window, else cwd', () => {
    const U = '/U/User';
    const ws = scope.workspaceInfo(['/w/app'], { storageDir: `${U}/workspaceStorage/h1`, workspaceFile: '/w/app.code-workspace' });
    const cp = (o) => ({ provider: 'copilot', cwd: null, transcript: null, copilot: { storage: 'workspace', workspaceFile: null }, ...o });
    assert.ok(scope.inWorkspace(cp({ transcript: `${U}/workspaceStorage/h1/chatSessions/a.jsonl` }), ws));
    assert.ok(!scope.inWorkspace(cp({ transcript: `${U}/workspaceStorage/h2/chatSessions/a.jsonl` }), ws));
    assert.ok(scope.inWorkspace(cp({ transcript: `${U}/workspaceStorage/h2/chatSessions/a.jsonl`, copilot: { storage: 'workspace', workspaceFile: '/w/app.code-workspace' } }), ws));
    assert.ok(scope.inWorkspace(cp({ transcript: `${U}/workspaceStorage/h3/chatSessions/a.jsonl`, cwd: '/w/app/pkg' }), ws), 'cwd fallback');
    const empty = cp({ transcript: `${U}/globalStorage/emptyWindowChatSessions/a.jsonl`, copilot: { storage: 'emptyWindow', workspaceFile: null }, cwd: '/w/app' });
    assert.ok(!scope.inWorkspace(empty, ws), 'an empty-window chat is not in a folder window, whatever its cwd');
    assert.ok(scope.inWorkspace(empty, scope.workspaceInfo([])), 'but belongs to an empty window');
    assert.ok(!scope.inWorkspace(cp({ transcript: `${U}/workspaceStorage/h1/chatSessions/a.jsonl` }), scope.workspaceInfo(['/w/app'])), 'no storage dir: cwd only');
    // an untitled workspace file (not file:) is ignored
    assert.strictEqual(scope.workspaceInfo([], { workspaceFile: { scheme: 'untitled', fsPath: '/x' } }).workspaceFile, null);
    // Windows: case-insensitive, either separator
    const win = scope.workspaceInfo(['C:\\W\\App'], { storageDir: 'C:\\Users\\Me\\AppData\\Roaming\\Code\\User\\workspaceStorage\\H1' });
    assert.ok(scope.inWorkspace(cp({ transcript: 'c:/users/me/appdata/roaming/code/user/workspaceStorage/h1/chatSessions/a.jsonl' }), win));
  });

  // ---------- Push ----------
  console.log('push');

  await test('push: a Copilot wait is a needsYou event with its provider; its usage limit names the tool', () => {
    const now = S0(0);
    const tr = push.createPushTracker();
    const s = (status) => ({ ...fakeSession('copilot', 'c', now), main: { kind: 'main', id: 'c', status } });
    tr.update({ sessions: [s(S.makeStatus('tool', now - 5000))], quota: { copilot: { lastHit: null } }, now });
    const out = tr.update({
      sessions: [s(S.makeStatus('awaitingApproval', now - 1000))],
      quota: { copilot: { lastHit: { kind: 'unknown', model: null, resetsAtMs: null, resetsText: null, source: 'turnError', autoContinue: null, ms: now - 500, sessionKey: 'copilot:c' } } },
      now,
    });
    assert.deepStrictEqual(out.map((e) => [e.type, e.provider]), [['needsYou', 'copilot'], ['limitHit', 'copilot']]);
    const msg = push.formatPush([out[1]], i18nLib.createI18n('en'));
    assert.ok(msg.title.includes('Copilot'), msg.title);
  });

  // ---------- Terminal version ----------
  console.log('terminal version');

  await test('terminal: --provider accepts copilot; all turns every provider on with its defaults, a name only that one', () => {
    const { opts, errors } = cli.parseArgs(['--provider', 'Copilot']);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(opts.provider, 'copilot');
    const on = (cfg) => ['claude', 'codex', 'copilot'].filter((k) => cfg[k].enabled);
    assert.deepStrictEqual(on(cli.monitorConfig(opts)), ['copilot']);
    assert.deepStrictEqual(on(cli.monitorConfig(cli.parseArgs([]).opts)), ['claude', 'codex', 'copilot']);
    assert.deepStrictEqual(on(cli.monitorConfig({ window: 30, stale: 5, interval: 2 })), ['claude', 'codex', 'copilot'], 'no provider option: all');
    const c = normalizeConfig(cli.monitorConfig(opts), {});
    assert.deepStrictEqual(c.copilot, { enabled: true, userDir: null }, 'the provider\'s default VS Code dirs');
    assert.deepStrictEqual(cli.parseArgs(['--provider', 'bard']).errors.map((e) => e.key), ['cli.error.badProvider']);
    const help = cli.helpLines(i18nLib.createI18n('en'), false).join('\n');
    assert.ok(/claude, codex or copilot/.test(help), help);
  });

  await test('terminal: the footer names Copilot\'s latest usage-limit hit, not only Claude\'s', () => {
    const i18n = i18nLib.createI18n('en');
    const view = cli.createView({ i18n, color: false });
    const now = S0(0);
    const hit = (ms) => ({ kind: 'unknown', model: null, resetsAtMs: null, resetsText: null, source: 'turnError', autoContinue: false, ms, sessionKey: 'x:1' });
    const snap = { v: 2, now, sessions: [], details: {}, today: null, sources: {},
      quota: { claude: { lastHit: null }, copilot: { lastHit: hit(now - 60e3) } } };
    const out = cli.renderList(view, snap, { now }).join('\n');
    const lines = require('../lib/format').formatLastHits(snap.quota, i18n, now);
    assert.strictEqual(lines.length, 1);
    for (const l of lines) assert.ok(out.includes(l), `${l}\n---\n${out}`);
    assert.doesNotThrow(() => cli.renderList(view, { ...snap, quota: undefined }, { now }), 'no quota at all');
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
