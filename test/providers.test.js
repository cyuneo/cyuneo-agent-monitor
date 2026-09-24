'use strict';
// End-to-end tests for the Copilot, Gemini CLI and Qwen Code providers wired into lib/monitor.js (the provider registry),
// plus the pieces around them: status.js fast tools, pricing hooks, workspace scope, the guessed-done sound rule, push
// limit hits and the terminal version's options. Run with plain node: node test/providers.test.js
// All data is synthetic and built at runtime in a temp directory (a fake VS Code user dir, a fake ~/.gemini and ~/.qwen);
// every Monitor gets explicit dirs and an empty environment, so nothing is read from the real ones.
// Temp directory: AGENT_MONITOR_TEST_TMP (falls back to the system temp directory); deleted after the run.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { Monitor, normalizeConfig, sameExceptObserved, createProvider, PROVIDER_NAMES, LAZY_PROVIDERS, PROBE_MS } = require('../lib/monitor');
const S = require('../lib/core/status');
const pricing = require('../lib/core/pricing');
const pricingQwen = require('../lib/core/pricing-qwen');
const scope = require('../lib/scope');
const notify = require('../lib/notify');
const push = require('../lib/push');
const i18nLib = require('../lib/i18n');
const { sanitizeCwd, QWEN_FAST_TOOLS } = require('../lib/providers/qwen');
const { GEMINI_FAST_TOOLS } = require('../lib/providers/gemini');
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

// ---------- Synthetic Gemini CLI recordings ----------

const GM_ID = (n) => `9e0e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const gmTok = (input, output) => ({ input, output, cached: 0, thoughts: 0, tool: 0, total: input + output });
function geminiHome(name, sessions) {
  const home = path.join(TMP, name, '.gemini');
  const pd = path.join(home, 'tmp', 'app');
  fs.mkdirSync(path.join(pd, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(pd, '.project_root'), CWD);
  const files = {};
  for (const [sid, recs, mtimeS] of sessions) {
    const f = path.join(pd, 'chats', `session-2026-09-20T09-59-${sid.slice(0, 8)}.jsonl`);
    fs.writeFileSync(f, recs.map(line).join(''));
    touch(f, mtimeS);
    files[sid] = f;
  }
  return { home, files };
}
const gmSession = (sid, extra = []) => [
  { sessionId: sid, projectHash: 'ph', startTime: iso(-60), lastUpdated: iso(-10), kind: 'main' },
  { id: 'u-1', timestamp: iso(-50), type: 'user', content: [{ text: 'Run the tests' }] },
  { id: 'g-1', timestamp: iso(-10), type: 'gemini', content: 'All tests pass.', model: 'gemini-2.5-pro', tokens: gmTok(20000, 200) },
  ...extra,
];

// ---------- Synthetic Qwen Code chat records ----------

const QW_ID = (n) => `5e55a000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let qn = 0;
const qrec = (sid, sec, type, extra = {}) => ({ uuid: `q-${++qn}`, parentUuid: null, sessionId: sid, timestamp: iso(sec), type, cwd: CWD, version: '0.9.0', ...extra });
const qUser = (sid, sec, text, extra) => qrec(sid, sec, 'user', { message: { role: 'user', parts: [{ text }] }, ...extra });
const qAsst = (sid, sec, parts, extra = {}) => qrec(sid, sec, 'assistant', {
  message: { role: 'model', parts }, model: 'qwen3-coder-plus', contextWindowSize: 1000000,
  usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 50, cachedContentTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 3050 }, ...extra,
});
const qQuota = (sid, sec) => qrec(sid, sec, 'system', { subtype: 'ui_telemetry',
  systemPayload: { uiEvent: { 'event.name': 'qwen-code.api_error', error: 'Insufficient balance', status_code: 402 } } });
function qwenHome(name, sessions) {
  const home = path.join(TMP, name, '.qwen');
  const chats = path.join(home, 'projects', sanitizeCwd(CWD), 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const files = {};
  for (const [sid, recs, mtimeS] of sessions) {
    const f = path.join(chats, `${sid}.jsonl`);
    fs.writeFileSync(f, recs.map(line).join(''));
    touch(f, mtimeS);
    files[sid] = f;
  }
  return { home, files };
}

// ---------- Monitor config: only the dirs given here, never the real ones ----------

function monitorCfg(o = {}) {
  return {
    activeWindowMinutes: 30, staleMinutes: 5, daily: false,
    claude: { enabled: false, projectsDir: path.join(TMP, 'no-claude', 'projects') },
    codex: { enabled: false, home: path.join(TMP, 'no-codex') },
    // off by default, and never the real VS Code / ~/.gemini / ~/.qwen dirs even when a test only flips enabled
    copilot: { enabled: false, userDir: path.join(TMP, 'no-vscode', 'User') },
    gemini: { enabled: false, home: path.join(TMP, 'no-gemini'), homeSource: 'setting' },
    qwen: { enabled: false, home: path.join(TMP, 'no-qwen') },
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
  const ctorName = { copilot: 'CopilotProvider', gemini: 'GeminiProvider', qwen: 'QwenProvider' }[name];
  return { mod: { [ctorName]: Ctor }, calls };
}
const fakeSession = (provider, id, now, extra = {}) => ({
  key: `${provider}:${id}`, provider, id, title: id, titleSource: 'ai', cwd: CWD, updatedMs: now - 1000, startedMs: now - 60e3,
  live: false, main: { kind: 'main', status: S.makeStatus('done', now - 1000) }, agents: [], workflows: [], ...extra,
});

(async () => {
  // ---------- normalizeConfig ----------
  console.log('config');

  await test('normalizeConfig: Copilot / Gemini / Qwen default on, dirs from the env or the defaults, sources; sameExceptObserved sees them', () => {
    const c = normalizeConfig({}, {});
    assert.deepStrictEqual(c.copilot, { enabled: true, userDir: null });
    assert.deepStrictEqual(c.gemini, { enabled: true, home: path.join(os.homedir(), '.gemini'), homeSource: 'default' });
    assert.deepStrictEqual(c.qwen, { enabled: true, home: path.join(os.homedir(), '.qwen'), homeSource: 'default' });
    const e = normalizeConfig({}, { GEMINI_CLI_HOME: '/gh', QWEN_HOME: '/qh', QWEN_RUNTIME_DIR: '/qr' });
    assert.deepStrictEqual([e.gemini.home, e.gemini.homeSource], [path.join('/gh', '.gemini'), 'env']);
    assert.deepStrictEqual([e.qwen.home, e.qwen.homeSource], ['/qr', 'env'], 'QWEN_RUNTIME_DIR comes before QWEN_HOME');
    const s = normalizeConfig({ copilot: { enabled: false, userDir: '/U' }, gemini: { home: '/g' }, qwen: { enabled: false, home: '/q', homeSource: 'setting' } }, {});
    assert.deepStrictEqual(s.copilot, { enabled: false, userDir: '/U' });
    assert.deepStrictEqual(s.gemini, { enabled: true, home: '/g', homeSource: 'setting' });
    assert.deepStrictEqual(s.qwen, { enabled: false, home: '/q', homeSource: 'setting' });
    assert.strictEqual(normalizeConfig({ copilot: { userDir: 42 } }, {}).copilot.userDir, null);
    assert.ok(!sameExceptObserved(normalizeConfig({}, {}), normalizeConfig({ gemini: { enabled: false } }, {})), 'a provider switch needs a rebuild');
    assert.deepStrictEqual([...PROVIDER_NAMES], ['codex', 'copilot', 'gemini', 'qwen']);
    assert.deepStrictEqual([...LAZY_PROVIDERS], ['copilot', 'gemini', 'qwen']);
  });

  await test('a leading ~ (~/ or ~\\) in the dir settings and env vars is the home dir, in normalizeConfig and in the providers alike', () => {
    const H = os.homedir();
    const { GeminiProvider } = require('../lib/providers/gemini');
    const { QwenProvider } = require('../lib/providers/qwen');
    const { CopilotProvider } = require('../lib/providers/copilot');
    const { expandHome } = require('../lib/monitor');
    assert.deepStrictEqual([expandHome('~'), expandHome(' ~/a/b '), expandHome('~\\a'), expandHome('/x/~/y'), expandHome('~user/x'), expandHome(''), expandHome(null)],
      [H, path.join(H, 'a', 'b'), path.join(H, 'a'), '/x/~/y', '~user/x', '', '']);
    // env vars
    const e = normalizeConfig({}, { GEMINI_CLI_HOME: '~/gh', QWEN_RUNTIME_DIR: '~\\qr', CODEX_HOME: '~/cx', CLAUDE_CONFIG_DIR: '~/cl' });
    assert.deepStrictEqual([e.claude.projectsDir, e.claude.configDir, e.claude.configDirSource], [path.join(H, 'cl', 'projects'), path.join(H, 'cl'), 'env']);
    assert.deepStrictEqual([e.gemini.home, e.gemini.homeSource], [path.join(H, 'gh', '.gemini'), 'env']);
    assert.deepStrictEqual([e.qwen.home, e.qwen.homeSource], [path.join(H, 'qr'), 'env']);
    assert.deepStrictEqual([e.codex.home, e.codex.homeSource], [path.join(H, 'cx'), 'env']);
    assert.strictEqual(normalizeConfig({}, { QWEN_HOME: '~' }).qwen.home, H);
    // settings
    const s = normalizeConfig({ copilot: { userDir: '~/Code/User' }, gemini: { home: '~/g' }, qwen: { home: '~/q' }, codex: { home: '~' } }, {});
    assert.deepStrictEqual([s.copilot.userDir, s.gemini.home, s.gemini.homeSource, s.qwen.home, s.qwen.homeSource, s.codex.home],
      [path.join(H, 'Code', 'User'), path.join(H, 'g'), 'setting', path.join(H, 'q'), 'setting', H]);
    // the providers resolve the same dirs when they read the env themselves (the Monitor passes only a configured Gemini dir)
    const g = new GeminiProvider({ env: { GEMINI_CLI_HOME: '~/gh' } });
    assert.deepStrictEqual([g.home, g.homeSource, g.runtimeDirs[1]], [e.gemini.home, 'env', path.join(H, 'gh', '.cache', '.gemini')]);
    assert.deepStrictEqual([new GeminiProvider({ geminiHome: '~/g', env: {} }).home, new GeminiProvider({ geminiHome: '~/g', env: {} }).homeSource], [s.gemini.home, 'setting']);
    assert.strictEqual(new QwenProvider({ env: { QWEN_RUNTIME_DIR: '~\\qr' } }).home, e.qwen.home);
    assert.strictEqual(new QwenProvider({ qwenHome: '~/q', env: {} }).home, s.qwen.home);
    assert.strictEqual(new QwenProvider({ qwenHome: ' ', env: { QWEN_HOME: '~/qh' } }).home, path.join(H, 'qh'), 'a blank setting falls through to the env');
    assert.deepStrictEqual(new CopilotProvider({ userDir: '~/Code/User' }).userDirs, [s.copilot.userDir]);
  });

  // ---------- Monitor end to end with the real providers ----------
  console.log('Monitor with the real providers (synthetic data)');

  const cp = copilotUser('e2e-copilot', [
    [CP_ID(1), [cpRequest(1), cpRequest(2)], -20],
    [CP_ID(2), [cpRequest(1, { state: 3, doneAt: S0(-30), result: { errorDetails: { message: 'You have exceeded your premium request allowance', isQuotaExceeded: true } } })], -25],
  ]);
  const gm = geminiHome('e2e-gemini', [[GM_ID(1), gmSession(GM_ID(1)), -10]]);
  const qw = qwenHome('e2e-qwen', [
    [QW_ID(1), [
      qUser(QW_ID(1), -40, 'research'),
      qAsst(QW_ID(1), -39, [{ functionCall: { id: 't1', name: 'task', args: { description: 'Explore' } } }]),
      qUser(QW_ID(1), -38, 'Explore the repo', { isSidechain: true, agentId: 'agent-1', agentName: 'general-purpose' }),
      qAsst(QW_ID(1), -37, [{ text: 'Explored.' }], { isSidechain: true, agentId: 'agent-1', agentName: 'general-purpose' }),
      qQuota(QW_ID(1), -30),
    ], -30],
  ]);
  const e2eCfg = {
    copilot: { enabled: true, userDir: cp.u },
    gemini: { enabled: true, home: gm.home, homeSource: 'setting' },
    qwen: { enabled: true, home: qw.home },
  };
  const KEYS = { cp1: `copilot:${CP_ID(1)}`, cp2: `copilot:${CP_ID(2)}`, gm1: `gemini:${GM_ID(1)}`, qw1: `qwen:${QW_ID(1)}` };

  await test('snapshot: sessions of all three providers merged and sorted; sources found / ok; quota lastHit per provider; details for focused keys', async () => {
    const mon = monitor(e2eCfg);
    mon.setFocus([KEYS.cp1, KEYS.gm1, KEYS.qw1]);
    const snap = mon.snapshot(S0(0));
    const byKey = new Map(snap.sessions.map((s) => [s.key, s]));
    assert.deepStrictEqual([...byKey.keys()].sort(), Object.values(KEYS).sort());
    const st = snap.sessions.map((s) => s.startedMs);
    assert.deepStrictEqual(st, [...st].sort((a, b) => b - a), 'newest start first');
    for (const name of ['copilot', 'gemini', 'qwen']) {
      assert.deepStrictEqual(snap.sources[name], { enabled: true, ok: true, error: null, found: true }, name);
      assert.ok(mon.provider(name), name);
    }
    assert.deepStrictEqual(mon.takeErrors(), []);
    // provider-specific fields come through untouched
    const c1 = byKey.get(KEYS.cp1);
    assert.strictEqual(c1.provider, 'copilot');
    assert.strictEqual(c1.cwd, CWD);
    assert.strictEqual(c1.copilot.storage, 'workspace');
    assert.strictEqual(c1.contextWindowSource, 'copilot-model');
    assert.strictEqual(byKey.get(KEYS.cp2).main.status.code, 'quota');
    const g1 = byKey.get(KEYS.gm1);
    assert.deepStrictEqual([g1.liveCertainty, g1.main.status.certainty, g1.cwd], ['guess', 'guess', CWD]);
    assert.strictEqual(g1.main.tokens.input, 20000);
    const q1 = byKey.get(KEYS.qw1);
    assert.deepStrictEqual([q1.main.status.code, q1.agents.map((a) => a.kind)], ['quota', ['qwenSubagent']]);
    assert.strictEqual(q1.contextWindowSource, 'qwen-record');
    // quota: { lastHit } per provider, same shape as Claude's
    assert.strictEqual(snap.quota.copilot.lastHit.sessionKey, KEYS.cp2);
    assert.strictEqual(snap.quota.copilot.lastHit.ms, S0(-30));
    assert.strictEqual(snap.quota.qwen.lastHit.sessionKey, KEYS.qw1);
    assert.deepStrictEqual(snap.quota.gemini, { lastHit: null });
    // details for each focused key (storage not measured yet on the first call), dispatched by provider
    assert.deepStrictEqual(Object.keys(snap.details).sort(), [KEYS.cp1, KEYS.gm1, KEYS.qw1].sort());
    for (const k of [KEYS.cp1, KEYS.gm1, KEYS.qw1]) {
      assert.ok(snap.details[k].agents && Object.keys(snap.details[k].agents).length, k);
      assert.strictEqual(snap.details[k].storage, null, k);
    }
    assert.ok(mon.detail(KEYS.qw1).agents['agent-1'], 'qwen sub-agent detail');
    assert.strictEqual(mon.detail('gemini:nope'), null);
    // the whole snapshot survives the worker's structured clone
    assert.strictEqual(structuredClone(snap).sessions.length, 4);
    // per-session storage: the main file, sub-agent files counted once (Qwen keeps sub-agents in the same file)
    await settle();
    const again = mon.snapshot(S0(1));
    const qs = again.details[KEYS.qw1].storage;
    assert.deepStrictEqual([qs.transcriptBytes, qs.subagentsBytes, qs.fileHistoryBytes, qs.transcript],
      [fs.statSync(qw.files[QW_ID(1)]).size, null, null, qw.files[QW_ID(1)]]);
    assert.strictEqual(again.details[KEYS.cp1].storage.transcriptBytes, fs.statSync(cp.files[CP_ID(1)]).size);
    mon.dispose();
    assert.strictEqual(mon.provider('copilot').readers.size, 0, 'dispose reaches every provider');
  });

  await test('Gemini guesses: running while recent writes, then a guessed done; the window filter and keepKeys still apply', () => {
    const mon = monitor({ gemini: e2eCfg.gemini });
    let s = mon.snapshot(S0(0)).sessions[0];
    assert.deepStrictEqual([s.main.status.code, s.live, s.liveCertainty], ['thinking', true, 'guess']);
    s = mon.snapshot(S0(60)).sessions[0];
    assert.deepStrictEqual([s.main.status.code, s.main.status.certainty, s.live], ['done', 'guess', false]);
    const late = S0(60 + 31 * 60);
    assert.strictEqual(mon.snapshot(late).sessions.length, 0, 'outside the activity window');
    mon.setFocus([KEYS.gm1]);
    assert.deepStrictEqual(mon.snapshot(late + 6000).sessions.map((x) => x.key), [KEYS.gm1], 'a focused session stays');
  });

  await test('with Claude and Codex (fake) on as well: every provider is merged, Codex behaves as before', () => {
    const now = S0(0);
    const codex = { CodexProvider: class { scan(n) { return [fakeSession('codex', 'cx1', n)]; } quota() { return { observedMs: 1, planType: 'plus', limitId: 'codex', windows: [], reachedType: null, credits: null }; } } };
    const mon = monitor({ ...e2eCfg, codex: { enabled: true, home: path.join(TMP, 'no-codex') } }, { codexModule: codex });
    const snap = mon.snapshot(now);
    assert.deepStrictEqual(snap.sessions.map((s) => s.provider).sort(), ['codex', 'copilot', 'copilot', 'gemini', 'qwen']);
    assert.strictEqual(snap.quota.codex.planType, 'plus');
    assert.strictEqual(snap.sources.codex.ok, true);
    assert.deepStrictEqual(Object.keys(snap.sources).sort(), ['claude', 'codex', 'copilot', 'gemini', 'qwen']);
  });

  // ---------- Isolation ----------
  console.log('error isolation');

  await test('one provider failing to construct, to scan or to read its quota never breaks the others; errors are named after it', () => {
    const now = S0(0);
    const dirs = { copilot: copilotUser('iso-copilot', []).u, gemini: path.join(TMP, 'iso-gemini'), qwen: path.join(TMP, 'iso-qwen') };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    const cpF = fakeModule('copilot', { ctorThrows: true });
    const gmF = fakeModule('gemini', { scanThrows: true });
    const qwF = fakeModule('qwen', { quotaThrows: true, sessions: [fakeSession('qwen', 'q1', now)] });
    const mon = monitor({
      copilot: { enabled: true, userDir: dirs.copilot },
      gemini: { enabled: true, home: dirs.gemini, homeSource: 'setting' },
      qwen: { enabled: true, home: dirs.qwen },
      codex: { enabled: true, home: path.join(TMP, 'no-codex') },
    }, {
      modules: { copilot: cpF.mod, gemini: gmF.mod, qwen: qwF.mod },
      codexModule: { CodexProvider: class { scan() { throw new Error('codex boom'); } } },
    });
    const snap = mon.snapshot(now);
    assert.deepStrictEqual(snap.sessions.map((s) => s.key), ['qwen:q1'], 'the Qwen sessions survive its failing quota read');
    assert.deepStrictEqual([snap.sources.copilot.ok, snap.sources.gemini.ok, snap.sources.qwen.ok, snap.sources.codex.ok], [false, false, true, false]);
    assert.ok(/init: synthetic copilot init failure/.test(snap.sources.copilot.error));
    assert.ok(/synthetic gemini scan failure/.test(snap.sources.gemini.error));
    const errs = new Map(mon.takeErrors());
    assert.deepStrictEqual([...errs.keys()].sort(), ['codex', 'copilot', 'gemini', 'qwen']);
    assert.ok(/quota: synthetic qwen quota failure/.test(errs.get('qwen')));
    assert.deepStrictEqual(snap.quota.qwen, { lastHit: null });
    // a constructor that failed is not retried; a scan that failed is retried on the next tick
    mon.snapshot(now + PROBE_MS + 1);
    assert.deepStrictEqual([cpF.calls.ctor, gmF.calls.ctor, gmF.calls.scan], [1, 1, 2]);
    // focus keys go to their own provider only
    mon.setFocus(['qwen:q1', 'gemini:g1', 'claude:c1']);
    mon.snapshot(now + 2 * PROBE_MS);
    assert.deepStrictEqual(qwF.calls.keepKeys, ['qwen:q1']);
    mon.dispose();
    assert.strictEqual(qwF.calls.dispose, 1);
  });

  await test('createProvider: a module without a usable constructor, or an unknown name, is an error, not a crash', () => {
    const r = createProvider('gemini', normalizeConfig({ gemini: { home: path.join(TMP, 'g'), homeSource: 'setting' } }, {}), { nothing: true });
    assert.deepStrictEqual(r, { inst: null, error: 'gemini provider has no usable constructor' });
    assert.strictEqual(createProvider('nope', normalizeConfig({}, {})).error, 'unknown provider nope');
  });

  // ---------- Cost when off or absent ----------
  console.log('disabled / missing folders');

  await test('disabled providers are never loaded, built or scanned; the snapshot still carries their (empty) quota and sources', () => {
    const f = { copilot: fakeModule('copilot'), gemini: fakeModule('gemini'), qwen: fakeModule('qwen') };
    const mon = monitor({}, { modules: { copilot: f.copilot.mod, gemini: f.gemini.mod, qwen: f.qwen.mod } });
    const snap = mon.snapshot(S0(0));
    for (const name of ['copilot', 'gemini', 'qwen']) {
      assert.deepStrictEqual(f[name].calls.ctor + f[name].calls.scan, 0, name);
      assert.deepStrictEqual(snap.quota[name], { lastHit: null }, name);
      assert.deepStrictEqual(snap.sources[name], { enabled: false, ok: true, error: null, found: false }, name);
    }
    assert.deepStrictEqual(mon.slots, []);
  });

  await test('a missing data folder costs one stat per root every PROBE_MS and nothing in between; the provider is built once the folder appears', () => {
    const base = path.join(TMP, 'late');
    const dirs = { copilot: path.join(base, 'User'), gemini: path.join(base, '.gemini'), qwen: path.join(base, '.qwen') };
    const f = { copilot: fakeModule('copilot'), gemini: fakeModule('gemini'), qwen: fakeModule('qwen') };
    const mon = monitor({
      copilot: { enabled: true, userDir: dirs.copilot },
      gemini: { enabled: true, home: dirs.gemini, homeSource: 'env' }, // env / default: the sandbox dir <base>/.cache/.gemini is a root too
      qwen: { enabled: true, home: dirs.qwen },
    }, { modules: { copilot: f.copilot.mod, gemini: f.gemini.mod, qwen: f.qwen.mod } });
    const realStat = fs.statSync;
    const stats = [];
    fs.statSync = function (p, ...rest) { stats.push(String(p)); return realStat.call(fs, p, ...rest); };
    try {
      const t = S0(0);
      mon.snapshot(t);
      assert.deepStrictEqual(stats.sort(), [dirs.copilot, path.join(base, '.cache', '.gemini'), dirs.gemini, dirs.qwen].sort());
      stats.length = 0;
      for (let i = 1; i <= 10; i++) mon.snapshot(t + i * 2000);
      assert.deepStrictEqual(stats, [], 'no file system work between probes');
      mon.snapshot(t + PROBE_MS);
      assert.strictEqual(stats.length, 4, 'probed again after PROBE_MS');
      assert.deepStrictEqual(Object.values(f).map((x) => x.calls.ctor + x.calls.scan), [0, 0, 0]);
      // the Gemini sandbox dir shows up: built and scanned on the next probe, never before
      fs.mkdirSync(path.join(base, '.cache', '.gemini'), { recursive: true });
      mon.snapshot(t + PROBE_MS + 2000);
      assert.strictEqual(f.gemini.calls.ctor, 0);
      const snap = mon.snapshot(t + 2 * PROBE_MS);
      assert.deepStrictEqual([f.gemini.calls.ctor, f.gemini.calls.scan], [1, 1]);
      assert.strictEqual(snap.sources.gemini.found, true);
      assert.strictEqual(f.gemini.calls.opts.geminiHome, undefined, 'a home from the env / default is resolved by the provider itself');
      stats.length = 0;
      mon.snapshot(t + 2 * PROBE_MS + 2000);
      assert.ok(!stats.some((p) => p.includes('.gemini')), 'a built provider is not probed again');
      // the clock going back probes at once
      const n = f.qwen.calls.ctor;
      fs.mkdirSync(dirs.qwen, { recursive: true });
      mon.snapshot(t - 1000);
      assert.strictEqual(f.qwen.calls.ctor, n + 1);
    } finally {
      fs.statSync = realStat;
    }
  });

  await test('real providers over missing folders: no sessions, no errors, nothing built', () => {
    const none = path.join(TMP, 'none');
    const mon = monitor({
      copilot: { enabled: true, userDir: path.join(none, 'User') },
      gemini: { enabled: true, home: path.join(none, '.gemini'), homeSource: 'setting' },
      qwen: { enabled: true, home: path.join(none, '.qwen') },
    });
    const snap = mon.snapshot(S0(0));
    assert.deepStrictEqual(snap.sessions, []);
    assert.deepStrictEqual(mon.takeErrors(), []);
    for (const name of ['copilot', 'gemini', 'qwen']) {
      assert.strictEqual(mon.provider(name), null, name);
      assert.deepStrictEqual([snap.sources[name].ok, snap.sources[name].found], [true, false], name);
    }
  });

  await test('provider options: dirs, window, stale minutes, limits and the approval guess reach the provider', () => {
    const dirs = { copilot: copilotUser('opts-copilot', []).u, gemini: path.join(TMP, 'opts-gemini'), qwen: path.join(TMP, 'opts-qwen') };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    const f = { copilot: fakeModule('copilot'), gemini: fakeModule('gemini'), qwen: fakeModule('qwen') };
    const mon = monitor({
      activeWindowMinutes: 45, staleMinutes: 7, approvalGuess: 'allTools', approvalGuessSeconds: 90,
      copilot: { enabled: true, userDir: dirs.copilot },
      gemini: { enabled: true, home: dirs.gemini, homeSource: 'setting' },
      qwen: { enabled: true, home: dirs.qwen },
    }, { modules: { copilot: f.copilot.mod, gemini: f.gemini.mod, qwen: f.qwen.mod } });
    mon.snapshot(S0(0));
    assert.strictEqual(f.copilot.calls.opts.userDir, dirs.copilot);
    assert.strictEqual(f.gemini.calls.opts.geminiHome, dirs.gemini);
    assert.strictEqual(f.qwen.calls.opts.qwenHome, dirs.qwen);
    for (const x of Object.values(f)) {
      const o = x.calls.opts;
      assert.deepStrictEqual([o.activeWindowMinutes, o.staleMinutes, o.approvalGuess, o.approvalGuessSeconds, o.limits.timeline], [45, 7, 'allTools', 90, 30]);
      assert.deepStrictEqual(o.env, {}, 'the Monitor environment, never process.env');
      assert.ok(!('home' in o) && !('claude' in o), 'no WorkerConfig fields that a provider would misread');
    }
  });

  // ---------- status.js, pricing, resume ----------
  console.log('shared tables');

  await test('status.js: Gemini / Qwen fast tools match the providers; the approval guess uses them', () => {
    assert.deepStrictEqual([...S.FAST_TOOLS.gemini], [...GEMINI_FAST_TOOLS]);
    assert.deepStrictEqual([...S.FAST_TOOLS.qwen], [...QWEN_FAST_TOOLS]);
    assert.ok(S.isFastTool('gemini', 'replace') && !S.isFastTool('gemini', 'run_shell_command'));
    assert.ok(S.isFastTool('qwen', 'edit') && !S.isFastTool('qwen', 'run_shell_command'));
    assert.ok(!S.isFastTool('copilot', 'read_file'), 'Copilot records its waits: no guessing list');
    const hit = S.guessAwaitingApproval({ provider: 'gemini', pending: [{ tool: 'write_file', sinceMs: 0 }], now: 61e3 });
    assert.deepStrictEqual(hit, { tool: 'write_file', sinceMs: 0 });
    assert.strictEqual(S.guessAwaitingApproval({ provider: 'gemini', pending: [{ tool: 'run_shell_command', sinceMs: 0 }], now: 61e3 }), null);
    assert.deepStrictEqual([S.WINDOW_SOURCE.COPILOT_MODEL, S.WINDOW_SOURCE.QWEN_RECORD], ['copilot-model', 'qwen-record']);
  });

  await test('pricing: Qwen rates re-exported; re-read cost for Gemini / Qwen, none for Copilot', () => {
    assert.strictEqual(pricing.qwenRates, pricingQwen.qwenRates);
    assert.strictEqual(pricing.QWEN_PRICES_UPDATED, pricingQwen.QWEN_PRICES_UPDATED);
    const g = pricing.geminiRates('gemini-2.5-pro');
    assert.deepStrictEqual(pricing.rereadCost('gemini', 'gemini-2.5-pro', 100000), { usdIfMiss: 100000 * g.input / 1e6, usdIfHit: 100000 * g.cached / 1e6 });
    const gl = pricing.geminiRates('gemini-2.5-pro', { long: true });
    assert.strictEqual(pricing.rereadCost('gemini', 'gemini-2.5-pro', 300000).usdIfMiss, 300000 * gl.input / 1e6, 'long-context price above 200k');
    const q = pricingQwen.qwenRates('qwen3-coder-plus', 50000);
    assert.deepStrictEqual(pricing.rereadCost('qwen', 'qwen3-coder-plus', 50000), { usdIfMiss: 50000 * q.input / 1e6, usdIfHit: 50000 * q.cacheRead / 1e6 });
    for (const [p, m] of [['copilot', 'copilot/claude-sonnet-4.5'], ['gemini', 'gemini-9-ultra'], ['qwen', 'coder-model']]) {
      assert.deepStrictEqual(pricing.rereadCost(p, m, 1000), { usdIfMiss: null, usdIfHit: null }, p);
    }
  });

  await test('resume: no hints for Copilot / Gemini / Qwen (no confirmed resume command), even after an error', () => {
    const { resumeHints } = require('../lib/core/resume');
    for (const provider of ['copilot', 'gemini', 'qwen']) {
      const s = fakeSession(provider, 'x', S0(0), { main: { kind: 'main', status: S.makeStatus('apiError', S0(0)), tokens: { contextUsed: 10 } } });
      assert.deepStrictEqual(resumeHints(s, { now: S0(1) }), [], provider);
    }
  });

  // ---------- Scope ----------
  console.log('workspace scope');

  await test('scope: Copilot by workspace storage, .code-workspace file or empty window, else cwd; Gemini / Qwen by cwd', () => {
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
    for (const provider of ['gemini', 'qwen']) {
      assert.ok(scope.inWorkspace({ provider, cwd: '/w/app/src', projectDir: '/home/.gemini/tmp/app' }, ws), provider);
      assert.ok(!scope.inWorkspace({ provider, cwd: '/w/other', projectDir: '-w-app' }, ws), `${provider}: the project dir name is Claude's rule only`);
    }
  });

  // ---------- Sounds and push ----------
  console.log('sounds and push');

  await test('sounds: a guessed done (Gemini) plays nothing; a certain done still does; a guessed wait still counts as needs-you', () => {
    const now = S0(0);
    const mk = (id, status) => ({ ...fakeSession('gemini', id, now), main: { kind: 'main', id, status }, doneAtMs: status.code === 'done' ? status.sinceMs : null });
    const tr = notify.createLampEventTracker();
    const working = S.makeStatus('thinking', now - 5000, { certainty: 'guess' });
    tr.update([mk('g', working), mk('c', S.makeStatus('thinking', now - 5000))], undefined, now);
    const ev = tr.update([mk('g', S.makeStatus('done', now - 1000, { certainty: 'guess' })), mk('c', S.makeStatus('done', now - 1000))], undefined, now);
    assert.deepStrictEqual(ev.map((e) => [e.type, e.key]), [['done', 'gemini:c']]);
    assert.strictEqual(notify.guessedDone(null, mk('g', S.makeStatus('done', now, { certainty: 'guess' }))), true);
    // the real Gemini provider: working → guessed done, no sound
    const mon = monitor({ gemini: e2eCfg.gemini });
    const tr2 = notify.createLampEventTracker();
    tr2.update(mon.snapshot(S0(0)).sessions, undefined, S0(0));
    const after = mon.snapshot(S0(60)).sessions;
    assert.strictEqual(after[0].main.status.certainty, 'guess');
    assert.deepStrictEqual(tr2.update(after, undefined, S0(60)), []);
    // needs-you guesses keep their notification
    const ny = notify.createNeedsYouTracker();
    ny.update([mk('w', working)]);
    const items = ny.update([mk('w', S.makeStatus('maybeAwaitingApproval', now - 70e3, { pendingTool: 'replace' }))]);
    assert.deepStrictEqual(items.map((i) => i.key), ['gemini:w']);
  });

  await test('push: a new provider\'s wait is a needsYou event with its provider; its usage limit names the tool', () => {
    const now = S0(0);
    const tr = push.createPushTracker();
    const s = (status) => ({ ...fakeSession('qwen', 'q', now), main: { kind: 'main', id: 'q', status } });
    tr.update({ sessions: [s(S.makeStatus('tool', now - 5000))], quota: { qwen: { lastHit: null } }, now });
    const out = tr.update({
      sessions: [s(S.makeStatus('maybeAwaitingApproval', now - 1000, { pendingTool: 'edit' }))],
      quota: { qwen: { lastHit: { kind: 'unknown', model: null, resetsAtMs: null, resetsText: null, source: 'text', autoContinue: null, ms: now - 500, sessionKey: 'qwen:q' } } },
      now,
    });
    assert.deepStrictEqual(out.map((e) => [e.type, e.provider]), [['needsYou', 'qwen'], ['limitHit', 'qwen']]);
    const msg = push.formatPush([out[1]], i18nLib.createI18n('en'));
    assert.ok(msg.title.includes('Qwen Code'), msg.title);
  });

  // ---------- Terminal version ----------
  console.log('terminal version');

  await test('terminal: --provider accepts copilot / gemini / qwen; all turns every provider on with its defaults, a name only that one', () => {
    const { opts, errors } = cli.parseArgs(['--provider', 'Gemini']);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(opts.provider, 'gemini');
    const on = (cfg) => ['claude', 'codex', 'copilot', 'gemini', 'qwen'].filter((k) => cfg[k].enabled);
    assert.deepStrictEqual(on(cli.monitorConfig(opts)), ['gemini']);
    assert.deepStrictEqual(on(cli.monitorConfig(cli.parseArgs([]).opts)), ['claude', 'codex', 'copilot', 'gemini', 'qwen']);
    assert.deepStrictEqual(on(cli.monitorConfig({ window: 30, stale: 5, interval: 2 })), ['claude', 'codex', 'copilot', 'gemini', 'qwen'], 'no provider option: all');
    const c = normalizeConfig(cli.monitorConfig(cli.parseArgs(['--provider', 'copilot']).opts), {});
    assert.deepStrictEqual(c.copilot, { enabled: true, userDir: null }, 'the provider\'s default VS Code dirs');
    assert.deepStrictEqual(cli.parseArgs(['--provider', 'bard']).errors.map((e) => e.key), ['cli.error.badProvider']);
    const help = cli.helpLines(i18nLib.createI18n('en'), false).join('\n');
    assert.ok(/copilot, gemini or qwen/.test(help), help);
  });

  await test('terminal: the footer names every provider\'s latest usage-limit hit, not only Claude\'s', () => {
    const i18n = i18nLib.createI18n('en');
    const view = cli.createView({ i18n, color: false });
    const now = S0(0);
    const hit = (ms) => ({ kind: 'unknown', model: null, resetsAtMs: null, resetsText: null, source: 'turnError', autoContinue: false, ms, sessionKey: 'x:1' });
    const snap = { v: 2, now, sessions: [], details: {}, today: null, sources: {},
      quota: { claude: { lastHit: null }, copilot: { lastHit: hit(now - 60e3) }, gemini: { lastHit: null }, qwen: { lastHit: hit(now - 120e3) } } };
    const out = cli.renderList(view, snap, { now }).join('\n');
    const lines = require('../lib/format').formatLastHits(snap.quota, i18n, now);
    assert.strictEqual(lines.length, 2);
    for (const l of lines) assert.ok(out.includes(l), `${l}\n---\n${out}`);
    assert.doesNotThrow(() => cli.renderList(view, { ...snap, quota: undefined }, { now }), 'no quota at all');
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
