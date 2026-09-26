'use strict';
// Tests for auto-resume (0.6.0, docs/DESIGN.md §12): lib/core/autoresume.js and lib/autoresume-runtime.js.
// Plain node: node test/autoresume.test.js. Sessions, settings and CLI output are synthetic; ~/.claude is never read and
// no process is ever started (spawn is a fake, timers run on a fake clock). State files and claim markers go under
// AGENT_MONITOR_TEST_TMP (system temp dir if unset) and are removed afterwards.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// Safety net: a call that forgets to inject spawn must never reach a real process
const childProcess = require('child_process');
childProcess.spawn = () => { throw new Error('tests never spawn processes'); };
childProcess.execFile = () => { throw new Error('tests never spawn processes'); };

const core = require('../lib/core/autoresume');
const { createAutoResumeRuntime, RUN_TIMEOUT_MS, KILL_GRACE_MS, CLOSE_GRACE_MS } = require('../lib/autoresume-runtime');
const notify = require('../lib/notify');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-autoresume-'));

// ---------- Helpers ----------

const results = [];
const queue = [];
function section(name) { queue.push({ section: name }); }
function test(name, fn) { queue.push({ name, fn }); }
function fail(name, err) {
  results.push(false);
  console.log(`  FAIL  ${name}\n        ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n        ')}`);
}
async function runAll() {
  for (const q of queue) {
    if (q.section) { console.log(q.section); continue; }
    try {
      await q.fn();
      results.push(true);
      console.log(`  ok    ${q.name}`);
    } catch (err) {
      fail(q.name, err);
    }
  }
}

const NOW = Date.parse('2026-09-26T10:00:00Z');
const SEC = 1000;
const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';
const C = 'cccccccc-1111-2222-3333-444444444444';
const PROJ = '/synthetic/work/demo-app';
const KEY = core.PROJECTS_KEY;
const PLAN_KEYS = ['key', 'sessionId', 'project', 'projectName', 'stopId', 'trigger', 'state', 'atMs', 'attempt', 'max', 'unavailable'];
const OUTCOME_KEYS = ['type', 'outcome', 'key', 'sessionId', 'project', 'projectName', 'attempt', 'max', 'copySessionId', 'error', 'atMs', 'manual'];

const status = (code, sinceMs, quota = null) => ({ code, sinceMs, quota });
const quotaHit = (resetsAtMs, autoContinue = null) => ({ kind: 'session', model: null, resetsAtMs, resetsText: null, source: 'quotaLimits', autoContinue });
function session(o = {}) {
  const { status: st, ...rest } = o;
  const id = rest.id || A;
  return { key: `claude:${id}`, provider: 'claude', id, cwd: PROJ, entry: 'cli', live: false, ...rest, main: { status: st || status('apiError', NOW) } };
}
const plan = (s, used = 0, o = {}) => core.planFor(s, { attempts: used }, { projects: [PROJ], now: NOW, ...o });
const copyNote = (x, y) => `note: session ${x} is already running in the background, so this started a copy as ${y}. \`claude attach ${x}\` opens the original.\n`;
const openNote = (x, y) => `${x} is open in another Claude Code process, so this started a copy as ${y}. The original conversation is unchanged.\n`;
// What Claude Code 2.1.283 prints for `--bg --resume` (real output, §12.2): the job id is the first 8 characters of the
// session that now runs; a copy also gets a note on stderr, naming both by job id
const bgOut = (job) => `backgrounded · ${job}\n  claude agents             list sessions\n  claude attach ${job}    open in this terminal\n  claude logs ${job}      show recent output\n  claude stop ${job}      stop this session\n`;
const runningNote = (x, y) => `note: session ${x} is already running in the background, so this started a copy as ${y}. \`claude attach ${x}\` opens the original.\n`;
const untrusted = (dir) => `Workspace not trusted. Run \`claude\` in ${dir} once and accept the trust prompt, then retry.\n`;

const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** Fake timers: advance() fires due timers in order and lets async work settle between them; sleep() jumps first */
function fakeClock(start = NOW) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const c = {
    now: () => now,
    setTimeout: (fn, ms) => { const h = ++seq; timers.set(h, { at: now + Math.max(0, Number(ms) || 0), fn }); return h; },
    clearTimeout: (h) => { timers.delete(h); },
    pending: () => timers.size,
    async runUntil(end) {
      for (;;) {
        await flush();
        let pick = null;
        for (const [h, x] of timers) if (x.at <= end && (!pick || x.at < pick.x.at || (x.at === pick.x.at && h < pick.h))) pick = { h, x };
        if (!pick) break;
        timers.delete(pick.h);
        if (pick.x.at > now) now = pick.x.at;
        pick.x.fn();
      }
      if (end > now) now = end;
      await flush();
    },
    advance: (ms) => c.runUntil(now + ms),
    async sleep(ms) { now += ms; await c.runUntil(now); },
  };
  return c;
}

const HELP_BG = 'Usage: claude [options] [command] [prompt]\n\nOptions:\n  --bg   Run in the background. With --resume <session-id>, continues that session in the background under the same ID, or starts a copy and says so when the session is already running\n  -r, --resume [value]  Resume a conversation by session ID\n';
const HELP_OLD = 'Usage: claude [options] [command] [prompt]\n\nOptions:\n  -r, --resume [value]  Resume a conversation by session ID\n  --bg-color <c>  not the flag\n';

/**
 * Fake spawn. script(call, n) → { stdout, stderr, code (default 0), exitOnly, hang, throws, error, onSpawn };
 * default: `--help` prints a help text with --bg, the resume prints nothing and exits 0.
 */
function fakeSpawn(script) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const call = { cmd, args: args.slice(), opts: { ...opts }, kills: [] };
    calls.push(call);
    const b = (script && script(call, calls.length - 1)) || (args[0] === '--help' ? { stdout: HELP_BG } : {});
    if (b.throws) throw Object.assign(new Error(`spawn ${b.throws}`), { code: b.throws });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.destroy = () => {};
    child.stderr.destroy = () => {};
    child.pid = 4000 + calls.length;
    child.kill = (sig) => { call.kills.push(sig); return true; };
    if (typeof b.onSpawn === 'function') b.onSpawn(call);
    setImmediate(() => {
      if (b.error) { child.emit('error', Object.assign(new Error(`spawn ${cmd} ${b.error}`), { code: b.error })); return; }
      if (b.hang) return;
      if (b.stdout) child.stdout.emit('data', Buffer.from(b.stdout));
      if (b.stderr) child.stderr.emit('data', Buffer.from(b.stderr));
      const code = b.code == null ? 0 : b.code;
      child.emit('exit', code, null);
      if (!b.exitOnly) child.emit('close', code, null);
    });
    return child;
  };
  fn.calls = calls;
  fn.resumes = () => calls.filter((c) => c.args[0] === '--bg');
  fn.helps = () => calls.filter((c) => c.args[0] === '--help');
  return fn;
}
/** Resume calls answered by res(call); --help as usual */
const onResume = (res) => (call, n) => (call.args[0] === '--help' ? { stdout: HELP_BG } : res(call, n));

function memStore(init = {}) {
  const map = new Map(Object.entries(init));
  return { get: (k) => map.get(k), update: async (k, v) => { map.set(k, v); }, map };
}

/**
 * A runtime on a temp dir: dir holds the project folder and a CLI file; share holds the state file and the claim dir
 * (two runtimes with the same share act like two windows of one app).
 */
function harness(o = {}) {
  const dir = o.dir || fs.mkdtempSync(path.join(TMP, 'rt-'));
  const share = o.share || dir;
  const project = path.join(dir, 'work', 'demo-app');
  fs.mkdirSync(project, { recursive: true });
  const cli = path.join(dir, 'bin', 'claude');
  if (!fs.existsSync(cli)) {
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n');
  }
  const clock = o.clock || fakeClock();
  const store = o.store || memStore({ [KEY]: o.projects !== undefined ? o.projects : [project] });
  const spawn = o.spawn || fakeSpawn(o.script);
  const logs = [];
  const outcomes = [];
  const claudeSettingsFile = path.join(dir, 'claude-settings.json');
  let settings = o.settings || {};
  const deps = {
    store,
    stateFile: () => path.join(share, 'globalStorage', 'autoresume.json'),
    claimDir: () => path.join(share, 'claims'),
    findCli: () => ({ path: cli, source: 'path' }),
    spawn,
    fs,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    claudeSettingsPath: () => claudeSettingsFile,
    prompt: () => 'Continue the task you were working on.',
    settings: () => settings,
    log: (l) => logs.push(l),
    t: (k, v) => (v ? `${k} ${JSON.stringify(v)}` : k),
    ...(o.deps || {}),
  };
  const rt = createAutoResumeRuntime(deps);
  rt.onOutcome((x) => outcomes.push(x));
  let stateFile = null;
  try { stateFile = deps.stateFile(); } catch { /* a test of throwing deps */ }
  return {
    rt, clock, dir, share, project, cli, store, spawn, logs, outcomes, deps, claudeSettingsFile, stateFile,
    setSettings: (v) => { settings = v; },
    writeState: (v) => { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, typeof v === 'string' ? v : JSON.stringify(v)); },
    readState: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    sess: (so = {}) => session({ cwd: project, ...so }),
    update(list, now) { rt.update({ sessions: list, now: now == null ? clock.now() : now }); },
    logged: (prefix) => logs.filter((l) => l.startsWith(prefix)),
    plan: (key) => rt.plansByKey().get(key),
  };
}
const stopIdOf = (s) => `${s.id}|${s.main.status.code}|${s.main.status.sinceMs}`;

// ---------- Core: settings, projects ----------

section('core: settings and projects');

test('normalizeSettings: defaults, ranges, whole attempts; only false turns afterLimit off', () => {
  assert.deepStrictEqual(core.normalizeSettings(undefined), { maxAttempts: 3, errorDelayMinutes: 2, afterLimit: true });
  assert.deepStrictEqual(core.DEFAULTS, { maxAttempts: 3, errorDelayMinutes: 2, afterLimit: true });
  assert.deepStrictEqual(core.normalizeSettings({ maxAttempts: 0, errorDelayMinutes: 0, afterLimit: false }), { maxAttempts: 1, errorDelayMinutes: 1, afterLimit: false });
  assert.deepStrictEqual(core.normalizeSettings({ maxAttempts: 11, errorDelayMinutes: 61 }), { maxAttempts: 10, errorDelayMinutes: 60, afterLimit: true });
  assert.deepStrictEqual(core.normalizeSettings({ maxAttempts: 2.6, errorDelayMinutes: 1.5 }), { maxAttempts: 3, errorDelayMinutes: 1.5, afterLimit: true });
  assert.deepStrictEqual(core.normalizeSettings({ maxAttempts: '5', errorDelayMinutes: NaN, afterLimit: 'no' }), { maxAttempts: 3, errorDelayMinutes: 2, afterLimit: true });
  assert.deepStrictEqual(core.normalizeSettings({ maxAttempts: -Infinity, errorDelayMinutes: null, afterLimit: 0 }), { maxAttempts: 3, errorDelayMinutes: 2, afterLimit: true });
});

test('projectOf: equal or inside on a separator boundary; the innermost folder wins; Windows paths ignore case; darwin opt-in', () => {
  assert.strictEqual(core.projectOf(PROJ, [PROJ]), PROJ);
  assert.strictEqual(core.projectOf(`${PROJ}/src/lib`, [PROJ]), PROJ);
  assert.strictEqual(core.projectOf(`${PROJ}/`, [`${PROJ}/`]), `${PROJ}/`);
  assert.strictEqual(core.projectOf(`${PROJ}2`, [PROJ]), null, 'a sibling with the same prefix is not inside');
  assert.strictEqual(core.projectOf('/synthetic/work', [PROJ]), null, 'a parent is not inside');
  assert.strictEqual(core.projectOf(`${PROJ}/src`, ['/synthetic', `${PROJ}/src`, '/synthetic/work']), `${PROJ}/src`);
  assert.strictEqual(core.projectOf(`${PROJ}/x`, ['/synthetic/work', PROJ]), PROJ);
  assert.strictEqual(core.projectOf('C:\\Users\\me\\App\\src', ['c:/users/me/app']), 'c:/users/me/app');
  assert.strictEqual(core.projectOf('/Volumes/Disk/App/src', ['/volumes/disk/app']), null, 'scope.js: case counts on POSIX');
  assert.strictEqual(core.projectOf('/Volumes/Disk/App/src', ['/volumes/disk/app'], { platform: 'darwin' }), '/volumes/disk/app');
  assert.strictEqual(core.projectOf(null, [PROJ]), null);
  assert.strictEqual(core.projectOf(PROJ, [null, 5, '', PROJ]), PROJ);
  assert.strictEqual(core.projectOf(PROJ, 'not a list'), null);
});

test('sameDir and projectName', () => {
  assert.ok(core.sameDir(PROJ, `${PROJ}/`));
  assert.ok(!core.sameDir(PROJ, `${PROJ}/src`));
  assert.ok(core.sameDir('C:\\A\\B', 'c:/a/b/'));
  assert.ok(core.sameDir('/A/b', '/a/B', { platform: 'darwin' }) && !core.sameDir('/A/b', '/a/B', { platform: 'linux' }));
  assert.strictEqual(core.projectName(PROJ), 'demo-app');
  assert.strictEqual(core.projectName(`${PROJ}/`), 'demo-app');
  assert.strictEqual(core.projectName('C:\\work\\demo'), 'demo');
  assert.strictEqual(core.projectName('/'), '/');
  assert.strictEqual(core.projectName(null), null);
});

// ---------- Core: stops and the rules table ----------

section('core: stops and the rules (§12.3)');

test('stopOf: only a Claude main agent at apiError / quota with a known time; stopId = id|code|sinceMs', () => {
  const e = core.stopOf(session({ status: status('apiError', NOW - 5 * SEC) }));
  assert.deepStrictEqual({ ...e, quota: undefined }, { stopId: `${A}|apiError|${NOW - 5 * SEC}`, sessionId: A, code: 'apiError', trigger: 'error', sinceMs: NOW - 5 * SEC, quota: undefined, resetsAtMs: null });
  const q = core.stopOf(session({ status: status('quota', NOW, quotaHit(NOW + HOUR)) }));
  assert.strictEqual(q.trigger, 'limit');
  assert.strictEqual(q.resetsAtMs, NOW + HOUR);
  assert.strictEqual(q.stopId, `${A}|quota|${NOW}`);
  assert.strictEqual(core.stopOf(session({ provider: 'codex' })), null);
  assert.strictEqual(core.stopOf(session({ id: 'not-a-uuid', key: 'claude:not-a-uuid' })), null);
  assert.strictEqual(core.stopOf(session({ status: status('apiError', undefined) })), null);
  assert.strictEqual(core.stopOf({ provider: 'claude', id: A, main: null }), null);
  assert.strictEqual(core.stopOf(null), null);
  assert.strictEqual(core.stopIdOf(session({ status: status('interrupted', 7) })), `${A}|interrupted|7`);
});

test('the table: apiError → error, quota → limit (or noReset), every other status → no plan', () => {
  const since = NOW - 30 * SEC;
  const reset = NOW + HOUR;
  const p1 = plan(session({ status: status('apiError', since) }));
  assert.deepStrictEqual([p1.trigger, p1.state, p1.atMs, p1.attempt, p1.max], ['error', 'scheduled', since + 2 * MIN, 1, 3]);
  const p2 = plan(session({ status: status('quota', since, quotaHit(reset)) }));
  assert.deepStrictEqual([p2.trigger, p2.state, p2.atMs], ['limit', 'scheduled', reset + 60 * SEC]);
  const p3 = plan(session({ status: status('quota', since, quotaHit(null)) }));
  assert.deepStrictEqual([p3.trigger, p3.state, p3.atMs], ['limit', 'noReset', null]);
  const p4 = plan(session({ status: status('quota', since, null) }));
  assert.deepStrictEqual([p4.state, p4.atMs], ['noReset', null], 'no QuotaHit at all: reset unknown');
  for (const code of ['interrupted', 'stale', 'awaitingInput', 'awaitingApproval', 'dialogOpen', 'maybeAwaitingApproval',
    'starting', 'thinking', 'tool', 'retrying', 'idleBackground', 'done', 'killed']) {
    assert.strictEqual(plan(session({ status: status(code, since) })), null, code);
  }
});

test('plan shape (§12.5): exact fields; key, project folder and its name', () => {
  const p = plan(session({ cwd: `${PROJ}/src` }));
  assert.deepStrictEqual(Object.keys(p).sort(), PLAN_KEYS.slice().sort());
  assert.deepStrictEqual({ key: p.key, sessionId: p.sessionId, project: p.project, projectName: p.projectName, stopId: p.stopId, unavailable: p.unavailable },
    { key: `claude:${A}`, sessionId: A, project: PROJ, projectName: 'demo-app', stopId: `${A}|apiError|${NOW}`, unavailable: null });
  assert.ok(core.PLAN_STATES.includes(p.state));
});

test('error backoff: sinceMs + errorDelayMinutes × 2^(n−1) minutes', () => {
  const s = session({ status: status('apiError', NOW) });
  assert.deepStrictEqual([0, 1, 2].map((u) => (plan(s, u).atMs - NOW) / MIN), [2, 4, 8]);
  assert.deepStrictEqual([0, 1, 2].map((u) => (plan(s, u, { settings: { errorDelayMinutes: 5 } }).atMs - NOW) / MIN), [5, 10, 20]);
  assert.strictEqual(plan(s, 0, { settings: { errorDelayMinutes: 1.5 } }).atMs, NOW + 90 * SEC);
  assert.strictEqual(plan(s, 1).attempt, 2);
  assert.strictEqual(plan(s, 2).attempt, 3);
});

test('limit: reset + 60 s; afterLimit off → no plan for limits only', () => {
  const lim = session({ status: status('quota', NOW, quotaHit(NOW + 3 * HOUR)) });
  assert.strictEqual(plan(lim).atMs, NOW + 3 * HOUR + MIN);
  assert.strictEqual(plan(lim, 0, { settings: { afterLimit: false } }), null);
  assert.strictEqual(plan(session({ status: status('quota', NOW, quotaHit(null)) }), 0, { settings: { afterLimit: false } }), null);
  assert.strictEqual(plan(session(), 0, { settings: { afterLimit: false } }).state, 'scheduled');
  assert.strictEqual(plan(lim, 2).atMs, NOW + 3 * HOUR + MIN, 'no backoff for limits');
});

test('self: live, not the panel, the SDK or a background session, autoContinue !== false, autoContinueAtUsageLimit !== false', () => {
  const reset = NOW + HOUR;
  const base = { live: true, entry: 'cli', status: status('quota', NOW, quotaHit(reset, null)) };
  const s = session(base);
  const stop = core.stopOf(s);
  assert.strictEqual(core.claudeContinuesItself(s, stop, {}), true);
  assert.strictEqual(core.claudeContinuesItself(s, stop, null), true);
  assert.strictEqual(core.claudeContinuesItself(s, stop, { autoContinueAtUsageLimit: true }), true);
  assert.strictEqual(core.claudeContinuesItself(s, stop, { autoContinueAtUsageLimit: false }), false);
  const p = plan(s);
  assert.deepStrictEqual([p.state, p.atMs, p.trigger], ['self', reset, 'limit']);
  assert.strictEqual(plan(session({ ...base, entry: 'desktop' })).state, 'self');
  assert.strictEqual(plan(session({ ...base, entry: 'other' })).state, 'self');
  assert.strictEqual(plan(session({ ...base, liveKind: 'interactive' })).state, 'self');
  // each condition broken → we plan it ourselves
  for (const [label, o, cs] of [
    ['not live', { live: false }], ['VS Code panel', { entry: 'vscode' }], ['SDK', { entry: 'sdk' }],
    ['panel, entry only as entrypoint', { entry: undefined, entrypoint: 'claude-vscode' }],
    ['a background session (--bg)', { liveKind: 'bg' }],
    ['QuotaHit.autoContinue false', { status: status('quota', NOW, quotaHit(reset, false)) }],
    ['user setting off', {}, { autoContinueAtUsageLimit: false }],
  ]) {
    const x = plan(session({ ...base, ...o }), 0, { claudeSettings: cs || {} });
    assert.deepStrictEqual([x.state, x.atMs], ['scheduled', reset + MIN], label);
  }
  assert.strictEqual(core.claudeContinuesItself(session({ ...base, status: status('apiError', NOW) }), core.stopOf(session({ ...base, status: status('apiError', NOW) })), {}), false, 'errors never');
  const selfNoReset = plan(session({ ...base, status: status('quota', NOW, quotaHit(null, null)) }));
  assert.deepStrictEqual([selfNoReset.state, selfNoReset.atMs], ['self', null]);
  assert.strictEqual(plan(s, 3).state, 'self', 'self even when the attempts are used up');
});

test('a planned time already past → now + 5 s, kept stable across snapshots via prev', () => {
  const s = session({ status: status('apiError', NOW - 10 * MIN) });
  const p = plan(s);
  assert.strictEqual(p.atMs, NOW + 5 * SEC);
  const again = plan(s, 0, { now: NOW + 3 * SEC, prev: p });
  assert.strictEqual(again.atMs, NOW + 5 * SEC, 'not pushed back by a later snapshot');
  const overdue = plan(s, 0, { now: NOW + 9 * SEC, prev: p });
  assert.strictEqual(overdue.atMs, NOW + 5 * SEC, 'an overdue time stays (fires at once)');
  assert.strictEqual(plan(s, 0, { now: NOW + 9 * SEC, prev: { ...p, attempt: 2 } }).atMs, NOW + 14 * SEC, 'another attempt: new clamp');
  assert.strictEqual(plan(s, 0, { now: NOW + 9 * SEC, prev: { ...p, stopId: 'x' } }).atMs, NOW + 14 * SEC, 'another stop: new clamp');
  const lim = session({ status: status('quota', NOW - HOUR, quotaHit(NOW - 30 * MIN)) });
  assert.strictEqual(plan(lim).atMs, NOW + 5 * SEC, 'reset passed');
});

test('24 h cutoff: stops older than 24 h, and plans that would fire more than 24 h after the stop, are not resumed', () => {
  assert.strictEqual(plan(session({ status: status('apiError', NOW - DAY) })).atMs, NOW + 5 * SEC, 'exactly 24 h: still');
  assert.strictEqual(plan(session({ status: status('apiError', NOW - DAY - 1) })), null);
  assert.strictEqual(plan(session({ status: status('quota', NOW - DAY - MIN, quotaHit(NOW + HOUR)) })), null);
  assert.strictEqual(plan(session({ status: status('quota', NOW, quotaHit(NOW + 3 * DAY)) })), null, 'weekly limit resetting in 3 days');
  assert.strictEqual(plan(session({ status: status('quota', NOW, quotaHit(NOW + DAY - MIN)) })).atMs, NOW + DAY, 'reset + 60 s = exactly 24 h');
  const s = session({ status: status('apiError', NOW) });
  assert.strictEqual(plan(s, 9, { settings: { maxAttempts: 10, errorDelayMinutes: 60 } }), null, '60 min × 2^9 is past 24 h');
  assert.strictEqual(plan(s, 4, { settings: { maxAttempts: 10, errorDelayMinutes: 60 } }).atMs, NOW + 16 * HOUR);
});

test('attempts used up → gaveUp (attempt = max, no time); cancelled or already run stops → no plan', () => {
  const s = session();
  const g = plan(s, 3);
  assert.deepStrictEqual([g.state, g.atMs, g.attempt, g.max], ['gaveUp', null, 3, 3]);
  assert.strictEqual(plan(s, 5).state, 'gaveUp');
  assert.strictEqual(plan(s, 2).state, 'scheduled');
  assert.strictEqual(plan(s, 2, { settings: { maxAttempts: 2 } }).state, 'gaveUp');
  assert.strictEqual(plan(session({ status: status('quota', NOW, quotaHit(null)) }), 3).state, 'gaveUp', 'gaveUp before noReset');
  assert.strictEqual(core.planFor(s, 2, { projects: [PROJ], now: NOW }).attempt, 3, 'lineage as a plain number');
  const id = `${A}|apiError|${NOW}`;
  for (const coll of [new Set([id]), [id], { [id]: NOW }]) {
    assert.strictEqual(plan(s, 0, { cancelled: coll }), null);
    assert.strictEqual(plan(s, 0, { executed: coll }), null);
  }
  assert.strictEqual(plan(s, 0, { executed: { [`${A}|apiError|${NOW - 1}`]: NOW } }).state, 'scheduled', 'another stop of the same chat');
});

test('no plan outside an opted-in project, for other providers, or without a usable id', () => {
  assert.strictEqual(plan(session({ cwd: '/elsewhere' })), null);
  assert.strictEqual(plan(session({ cwd: null })), null);
  assert.strictEqual(core.planFor(session(), 0, { projects: [], now: NOW }), null);
  assert.strictEqual(plan(session({ provider: 'codex' })), null);
  assert.strictEqual(plan(session({ id: 'abc', key: 'claude:abc' })), null);
  assert.strictEqual(plan(null), null);
});

// ---------- Core: lineage ----------

section('core: lineage and state');

test('attempts count per lineage: a copy counts under its original, chains follow to the root', () => {
  let st = core.emptyState();
  st = core.recordAttempt(st, A, `${A}|apiError|1`, NOW);
  assert.deepStrictEqual(core.lineageOf(st, A, NOW), { root: A, attempts: 1, lastMs: NOW });
  st = core.recordCopy(st, B, A);
  assert.strictEqual(core.rootOf(st, B), A);
  st = core.recordAttempt(st, B, `${B}|apiError|2`, NOW + MIN);
  assert.deepStrictEqual(core.lineageOf(st, A, NOW + MIN), { root: A, attempts: 2, lastMs: NOW + MIN });
  st = core.recordCopy(st, C, B);
  assert.strictEqual(st.aliases[C], A, 'a copy of a copy maps straight to the root');
  assert.strictEqual(core.lineageOf(st, C, NOW + MIN).attempts, 2);
  assert.deepStrictEqual(Object.keys(st.executed).sort(), [`${A}|apiError|1`, `${B}|apiError|2`]);
  // no cycles, no self-alias
  assert.strictEqual(core.recordCopy(st, A, C).aliases[A], undefined);
  assert.strictEqual(core.recordCopy(st, A, A).aliases[A], undefined);
  const loop = core.normalizeState({ aliases: { [A]: B, [B]: A } });
  assert.ok([A, B].includes(core.rootOf(loop, A)), 'a hand-made loop still ends');
  // the originals are never mutated
  const before = JSON.stringify(st);
  core.recordAttempt(st, A, 'x|y|1', NOW);
  core.addCancelled(st, `${A}|quota|5`, NOW);
  core.markExecuted(st, `${A}|quota|6`, NOW);
  assert.strictEqual(JSON.stringify(st), before);
});

test('reset: done after the last resume (in any lineage session), or 24 h since the last resume', () => {
  let st = core.recordAttempt(core.recordAttempt(core.emptyState(), A, null, NOW - 20 * MIN), A, null, NOW - 10 * MIN);
  st = core.recordCopy(st, B, A);
  const done = (id, ms) => session({ id, key: `claude:${id}`, status: status('done', ms) });
  assert.strictEqual(core.resetOnDone(st, [done(A, NOW - 11 * MIN)]).changed, false, 'done before the last resume');
  assert.strictEqual(core.resetOnDone(st, [done(A, NOW - 10 * MIN)]).changed, false, 'not later than it');
  assert.strictEqual(core.resetOnDone(st, [session({ status: status('apiError', NOW) })]).changed, false);
  const r = core.resetOnDone(st, [done(B, NOW - 5 * MIN)]);
  assert.strictEqual(r.changed, true, 'the copy finished');
  assert.strictEqual(core.lineageOf(r.state, A, NOW).attempts, 0);
  assert.strictEqual(core.lineageOf(st, A, NOW).attempts, 2, 'input untouched');
  assert.strictEqual(core.resetOnDone(r.state, [done(B, NOW - 5 * MIN)]).changed, false, 'once');
  assert.strictEqual(core.lineageOf(st, A, NOW - 10 * MIN + DAY).attempts, 2);
  assert.strictEqual(core.lineageOf(st, A, NOW - 10 * MIN + DAY + 1).attempts, 0, '24 h after the last resume');
  assert.strictEqual(core.recordAttempt(st, A, null, NOW + 2 * DAY).lineages[A].attempts, 1, 'counting starts over');
});

test('state: garbage in → clean state out; bounded; old entries pruned', () => {
  assert.deepStrictEqual(core.normalizeState('nope'), core.emptyState());
  assert.deepStrictEqual(core.normalizeState(null), core.emptyState());
  const raw = JSON.parse(`{"lineages":{"__proto__":{"attempts":9},"${A}":{"attempts":2.7,"lastMs":5},"bad id!":{"attempts":1},"${B}":"x"},`
    + `"aliases":{"${C}":"${A}","${A}":"${A}","x y":"${A}"},"executed":{"__proto__":1,"${A}|apiError|1":1,"a b":2},"cancelled":[1,2]}`);
  const st = core.normalizeState(raw);
  assert.deepStrictEqual(st.lineages, { [A]: { attempts: 2, lastMs: 5 } });
  assert.deepStrictEqual(st.aliases, { [C]: A });
  assert.deepStrictEqual(st.executed, { [`${A}|apiError|1`]: 1 });
  assert.deepStrictEqual(st.cancelled, {});
  assert.strictEqual(Object.getPrototypeOf(st.lineages), Object.prototype);
  let big = core.emptyState();
  for (let i = 0; i < core.EXECUTED_MAX + 50; i++) big = core.markExecuted(big, `${A}|apiError|${i}`, NOW + i);
  assert.strictEqual(Object.keys(big.executed).length, core.EXECUTED_MAX);
  assert.ok(!(`${A}|apiError|0` in big.executed) && `${A}|apiError|${core.EXECUTED_MAX + 49}` in big.executed, 'the oldest go');
  let al = core.emptyState();
  for (let i = 0; i < core.ALIASES_MAX + 5; i++) al = core.recordCopy(al, `copy${String(i).padStart(4, '0')}`, A);
  assert.strictEqual(Object.keys(al.aliases).length, core.ALIASES_MAX);
  let old = core.addCancelled(core.recordAttempt(core.emptyState(), A, `${A}|apiError|1`, NOW - 2 * DAY), `${A}|quota|2`, NOW - 2 * DAY);
  old = core.recordAttempt(old, B, `${B}|apiError|3`, NOW);
  const pr = core.pruneState(old, NOW);
  assert.deepStrictEqual(Object.keys(pr.lineages), [B]);
  assert.deepStrictEqual(Object.keys(pr.executed), [`${B}|apiError|3`]);
  assert.deepStrictEqual(pr.cancelled, {});
});

// ---------- Core: command line ----------

section('core: command line');

test('buildArgs: UUID only; the prompt is one line, capped, never an option', () => {
  assert.deepStrictEqual(core.buildArgs(A, 'Continue.'), ['--bg', '--resume', A, 'Continue.']);
  assert.strictEqual(core.buildArgs('abc', 'Continue.'), null);
  assert.strictEqual(core.buildArgs(`${A} --dangerously-skip-permissions`, 'x'), null);
  assert.strictEqual(core.buildArgs(null, 'x'), null);
  assert.deepStrictEqual(core.buildArgs(A, '  Go on\r\nwith\tthe\u0007task  ')[3], 'Go on with the task');
  assert.deepStrictEqual(core.buildArgs(A, '--help me')[3], 'help me');
  assert.deepStrictEqual(core.buildArgs(A, ' - - x')[3], 'x');
  assert.strictEqual(core.buildArgs(A, ''), null);
  assert.strictEqual(core.buildArgs(A, ' \n '), null);
  assert.strictEqual(core.buildArgs(A, '---'), null);
  assert.strictEqual(Array.from(core.buildArgs(A, '继'.repeat(5000))[3]).length, core.PROMPT_MAX);
});

test('parseOutput: both notes (§12.2), stdout or stderr, colors and quotes; nothing else is a copy', () => {
  assert.deepStrictEqual(core.parseOutput(copyNote(A, B), ''), { copySessionId: B });
  assert.deepStrictEqual(core.parseOutput('', openNote(A, C)), { copySessionId: C });
  assert.deepStrictEqual(core.parseOutput(`\u001b[33mnote:\u001b[0m session ${A} is already running in the background, so this started a copy as \u001b[1m${B}\u001b[0m.`, null), { copySessionId: B });
  assert.deepStrictEqual(core.parseOutput(`Started a copy as "${C}"`, undefined), { copySessionId: C });
  assert.deepStrictEqual(core.parseOutput(`started a copy as \`${B}\`,`, ''), { copySessionId: B });
  assert.deepStrictEqual(core.parseOutput('started a copy as 0123456789abcdef0123456789abcdef', ''), { copySessionId: '0123456789abcdef0123456789abcdef' }, 'a job id is kept as is');
  assert.deepStrictEqual(core.parseOutput(`Resumed ${A} in the background.`, ''), { copySessionId: null });
  assert.deepStrictEqual(core.parseOutput('started a copy as .', ''), { copySessionId: null });
  assert.deepStrictEqual(core.parseOutput(null, null), { copySessionId: null });
});

test('parseOutput with the chat id (2.1.283): its own job id → itself; another job id → a copy, with or without the note', () => {
  const job = A.slice(0, 8);
  assert.deepStrictEqual(core.parseOutput(bgOut(job), 'Starting background service…\n', A), { copySessionId: null });
  assert.deepStrictEqual(core.parseOutput(bgOut('ec451a24'), runningNote(job, 'ec451a24'), A), { copySessionId: 'ec451a24' });
  assert.deepStrictEqual(core.parseOutput(bgOut('ec451a24'), `note: session ${job} is open in another Claude Code process, so this started a copy as ec451a24. The original conversation is unchanged.\n`, A), { copySessionId: 'ec451a24' });
  assert.deepStrictEqual(core.parseOutput(bgOut('ec451a24'), '', A), { copySessionId: 'ec451a24' }, 'the job id alone tells');
  assert.deepStrictEqual(core.parseOutput(bgOut('EC451A24'), '', A), { copySessionId: 'ec451a24' });
  assert.deepStrictEqual(core.parseOutput(bgOut('ec451a24'), ''), { copySessionId: null }, 'without the chat id only the note counts');
  assert.deepStrictEqual(core.parseOutput('', 'note: started a copy of that conversation as 0a1b2c3d. To continue a session under its own id, pass its full session id to --resume.', A), { copySessionId: '0a1b2c3d' });
  assert.deepStrictEqual(core.parseOutput('', `note: a restricted shell does not wake background session ${job} in place, so this started a restricted copy as 0a1b2c3d.`, A), { copySessionId: '0a1b2c3d' });
});

test('failureOf: Claude Code refusing a folder it does not trust yet → untrusted; any other failure → exit', () => {
  assert.strictEqual(core.failureOf('', untrusted('/synthetic/work/demo-app')), 'untrusted');
  assert.strictEqual(core.failureOf('', 'Workspace not trusted. The home directory is trusted one session at a time \u2014 start this from an interactive terminal there, or from a project directory.'), 'untrusted');
  assert.strictEqual(core.failureOf('\u001b[31mWorkspace not trusted.\u001b[0m', ''), 'untrusted');
  assert.strictEqual(core.failureOf('Error: No conversation found', ''), 'exit');
  assert.strictEqual(core.failureOf(null, undefined), 'exit');
});

test('lineage by job id: a copy recorded by its job id; its full session id resolves to the original', () => {
  const job = 'ec451a24';
  const full = `${job}-adb2-46cc-8952-283d4f2675d9`;
  let st = core.recordCopy(core.emptyState(), job, A);
  assert.deepStrictEqual([core.rootOf(st, full), core.rootOf(st, job), core.rootOf(st, A)], [A, A, A]);
  assert.strictEqual(core.recordCopy(st, A.slice(0, 8), A).aliases[A.slice(0, 8)], undefined, "the chat's own job id is not a copy");
  st = core.recordCopy(st, '0a1b2c3d', full);
  assert.strictEqual(core.rootOf(st, '0a1b2c3d-0000-4000-8000-000000000000'), A, 'a copy of the copy');
  st = core.recordAttempt(st, full, `${full}|apiError|${NOW}`, NOW);
  assert.strictEqual(core.lineageOf(st, A, NOW).attempts, 1);
});

test('trustCommand: the CLI quoted for the shell (PowerShell on Windows), else claude', () => {
  assert.strictEqual(core.trustCommand('/Users/x/.local/bin/claude', 'darwin'), '/Users/x/.local/bin/claude');
  assert.strictEqual(core.trustCommand('/Users/x/My Tools/claude', 'linux'), "'/Users/x/My Tools/claude'");
  assert.strictEqual(core.trustCommand("C:\\Users\\o'k\\claude.exe", 'win32'), "& 'C:\\Users\\o''k\\claude.exe'");
  assert.strictEqual(core.trustCommand(null, 'darwin'), 'claude');
  assert.strictEqual(core.trustCommand('/a\nb', 'darwin'), 'claude');
});

test('makeOutcome: §12.5 shape', () => {
  const p = plan(session());
  const o = core.makeOutcome(p, 'failed', { error: 'exit', atMs: NOW });
  assert.deepStrictEqual(Object.keys(o), OUTCOME_KEYS);
  assert.deepStrictEqual(o, { type: 'autoResume', outcome: 'failed', key: `claude:${A}`, sessionId: A, project: PROJ, projectName: 'demo-app', attempt: 1, max: 3, copySessionId: null, error: 'exit', atMs: NOW, manual: false });
  assert.strictEqual(core.makeOutcome(p, 'failed', { error: 'weird' }).error, 'spawn');
  assert.strictEqual(core.makeOutcome(p, 'resumed', { error: 'exit', copySessionId: B }).error, null);
  assert.strictEqual(core.makeOutcome(p, 'resumed', { copySessionId: B }).copySessionId, null);
  assert.strictEqual(core.makeOutcome(p, 'copied', { copySessionId: B }).copySessionId, B);
});

// ---------- Runtime ----------

section('runtime: running');

test('error stop: planned at sinceMs + 2 min, --help checked once, one spawn with the exact argv, cwd and options', async () => {
  const h = harness();
  const s = h.sess({ status: status('apiError', NOW - 30 * SEC) });
  h.update([s]);
  const p = h.plan(s.key);
  assert.deepStrictEqual([p.state, p.trigger, p.atMs, p.attempt, p.max, p.project, p.projectName], ['scheduled', 'error', NOW + 90 * SEC, 1, 3, h.project, 'demo-app']);
  assert.strictEqual(h.logged('autoresume.log.planned').length, 1);
  assert.ok(h.logs[0].includes('"trigger":"autoresume.trigger.error"') && h.logs[0].includes('"n":1') && h.logs[0].includes('"max":3'), h.logs[0]);
  await flush();
  assert.strictEqual(h.spawn.helps().length, 1, 'checked when planned');
  assert.deepStrictEqual(h.spawn.helps()[0].args, ['--help']);
  assert.strictEqual(h.spawn.helps()[0].opts.shell, false);
  assert.strictEqual(h.plan(s.key).unavailable, null);
  assert.strictEqual(h.clock.pending(), 1, 'one timer');
  h.update([s]);
  assert.strictEqual(h.logged('autoresume.log.planned').length, 1, 'logged once');
  await h.clock.advance(89 * SEC);
  assert.strictEqual(h.spawn.resumes().length, 0, 'not yet');
  await h.clock.advance(SEC);
  const r = h.spawn.resumes();
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].cmd, h.cli);
  assert.deepStrictEqual(r[0].args, ['--bg', '--resume', A, 'Continue the task you were working on.']);
  assert.strictEqual(r[0].opts.cwd, h.project);
  assert.strictEqual(r[0].opts.shell, false);
  assert.deepStrictEqual(r[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.strictEqual(h.spawn.helps().length, 1, '--help cached per path + mtime');
  assert.strictEqual(h.outcomes.length, 1);
  assert.deepStrictEqual(h.outcomes[0], { type: 'autoResume', outcome: 'resumed', key: s.key, sessionId: A, project: h.project, projectName: 'demo-app', attempt: 1, max: 3, copySessionId: null, error: null, atMs: NOW + 90 * SEC, manual: false });
  const st = h.readState();
  assert.deepStrictEqual(st.lineages[A], { attempts: 1, lastMs: NOW + 90 * SEC });
  assert.ok(stopIdOf(s) in st.executed);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(h.stateFile)).filter((f) => f.endsWith('.tmp')), [], 'atomic write leaves no temp file');
  assert.strictEqual(h.plan(s.key), undefined, 'a stop is resumed once');
  h.update([s]);
  await h.clock.advance(HOUR);
  assert.strictEqual(h.spawn.resumes().length, 1);
  assert.deepStrictEqual(h.logs.map((l) => l.split(' ')[0]), ['autoresume.log.planned', 'autoresume.log.started', 'autoresume.log.result']);
  assert.ok(h.logs[2].includes('"outcome":"autoresume.outcome.resumed"'), h.logs[2]);
});

test('the attempt is written to the state file before the CLI starts', async () => {
  let seen = null;
  const h = harness({ script: onResume((call) => ({ onSpawn: () => { seen = JSON.parse(fs.readFileSync(path.join(path.dirname(call.opts.cwd), '..', 'globalStorage', 'autoresume.json'), 'utf8')); } })) });
  const s = h.sess();
  h.update([s]);
  await h.clock.advance(3 * MIN);
  assert.ok(seen, 'spawned');
  assert.strictEqual(seen.lineages[A].attempts, 1);
  assert.ok(stopIdOf(s) in seen.executed);
});

test('copied ("already running in the background", stdout): the copy joins the lineage; its next stop is attempt 2', async () => {
  const h = harness({ script: onResume(() => ({ stdout: copyNote(A, B) })) });
  const s = h.sess();
  h.update([s]);
  await h.clock.advance(2 * MIN);
  assert.strictEqual(h.outcomes.length, 1);
  assert.deepStrictEqual([h.outcomes[0].outcome, h.outcomes[0].copySessionId, h.outcomes[0].error], ['copied', B, null]);
  assert.ok(h.logs.some((l) => l.includes(`"outcome":"autoresume.outcome.copied {\\"copy\\":\\"${B}\\"}"`)), h.logs.join('\n'));
  assert.strictEqual(h.readState().aliases[B], A);
  const copy = h.sess({ id: B, key: `claude:${B}`, status: status('apiError', NOW + 10 * MIN) });
  h.update([s, copy]);
  assert.strictEqual(h.plan(s.key), undefined, 'the original stop was run');
  const p = h.plan(copy.key);
  assert.deepStrictEqual([p.attempt, p.atMs], [2, NOW + 14 * MIN]);
});

test('copied ("open in another Claude Code process", stderr)', async () => {
  const h = harness({ script: onResume(() => ({ stderr: openNote(A, C) })) });
  h.update([h.sess()]);
  await h.clock.advance(2 * MIN);
  assert.deepStrictEqual([h.outcomes[0].outcome, h.outcomes[0].copySessionId], ['copied', C]);
  assert.strictEqual(h.readState().aliases[C], A);
});

test('Claude Code 2.1.283 output: resumed under its own job id; copied as another job id, whose full id counts under the original', async () => {
  let h = harness({ script: onResume(() => ({ stdout: bgOut(A.slice(0, 8)), stderr: 'Starting background service…\n' })) });
  h.update([h.sess()]);
  await h.clock.advance(2 * MIN);
  assert.deepStrictEqual([h.outcomes[0].outcome, h.outcomes[0].copySessionId], ['resumed', null]);
  const job = 'ec451a24';
  h = harness({ script: onResume(() => ({ stdout: bgOut(job), stderr: runningNote(A.slice(0, 8), job) })) });
  const s = h.sess();
  h.update([s]);
  await h.clock.advance(2 * MIN);
  assert.deepStrictEqual([h.outcomes[0].outcome, h.outcomes[0].copySessionId], ['copied', job]);
  assert.strictEqual(h.readState().aliases[job], A);
  const copyId = `${job}-adb2-46cc-8952-283d4f2675d9`;
  const copy = h.sess({ id: copyId, key: `claude:${copyId}`, status: status('apiError', NOW + 10 * MIN) });
  h.update([s, copy]);
  assert.deepStrictEqual([h.plan(copy.key).attempt, h.plan(copy.key).atMs], [2, NOW + 14 * MIN]);
});

test('a folder Claude Code does not trust yet: exit 1 → failed/untrusted, its line in the log; the stop is not retried', async () => {
  const h = harness({ script: onResume((call) => ({ stderr: untrusted(call.opts.cwd), code: 1 })) });
  const s = h.sess();
  h.update([s]);
  await h.clock.advance(2 * MIN);
  assert.deepStrictEqual([h.outcomes[0].outcome, h.outcomes[0].error], ['failed', 'untrusted']);
  assert.ok(h.logs.some((l) => l.includes('Workspace not trusted')), h.logs.join('\n'));
  assert.ok(h.logs.some((l) => l.includes('autoresume.error.untrusted')), h.logs.join('\n'));
  h.update([s]);
  await h.clock.advance(30 * MIN);
  assert.strictEqual(h.spawn.resumes().length, 1);
});

test('a child that keeps its pipes open: exit without close still finishes after the grace period', async () => {
  const h = harness({ script: onResume(() => ({ stdout: copyNote(A, B), exitOnly: true })) });
  h.update([h.sess()]);
  await h.clock.advance(2 * MIN);
  assert.strictEqual(h.outcomes.length, 0, 'waiting for the pipes');
  await h.clock.advance(CLOSE_GRACE_MS);
  assert.deepStrictEqual([h.outcomes.length, h.outcomes[0].outcome, h.outcomes[0].copySessionId], [1, 'copied', B]);
});

test('two plans: one timer for the earliest; both run in order', async () => {
  const h = harness();
  const s1 = h.sess({ status: status('quota', NOW, quotaHit(NOW + 10 * MIN)) });
  const s2 = h.sess({ id: B, key: `claude:${B}`, status: status('apiError', NOW) });
  h.update([s1, s2]);
  await flush();
  assert.strictEqual(h.clock.pending(), 1);
  await h.clock.advance(2 * MIN);
  assert.deepStrictEqual(h.spawn.resumes().map((c) => c.args[2]), [B]);
  assert.strictEqual(h.clock.pending(), 1, 're-armed for the next');
  await h.clock.advance(9 * MIN);
  assert.deepStrictEqual(h.spawn.resumes().map((c) => c.args[2]), [B, A]);
  assert.deepStrictEqual(h.outcomes.map((o) => [o.sessionId, o.outcome]), [[B, 'resumed'], [A, 'resumed']]);
  assert.strictEqual(h.clock.pending(), 0);
});

test('backoff over a lineage: the 3rd attempt waits 8 min; the next stop is gaveUp, announced once', async () => {
  const h = harness();
  h.writeState({ lineages: { [A]: { attempts: 2, lastMs: NOW - 10 * MIN } } });
  const s = h.sess({ status: status('apiError', NOW) });
  h.update([s]);
  assert.deepStrictEqual([h.plan(s.key).attempt, h.plan(s.key).atMs], [3, NOW + 8 * MIN]);
  await h.clock.advance(8 * MIN);
  assert.strictEqual(h.spawn.resumes().length, 1);
  assert.strictEqual(h.outcomes[0].attempt, 3);
  assert.strictEqual(h.readState().lineages[A].attempts, 3);
  const again = h.sess({ status: status('apiError', NOW + 12 * MIN) });
  h.update([again]);
  const g = h.plan(again.key);
  assert.deepStrictEqual([g.state, g.atMs, g.attempt, g.max], ['gaveUp', null, 3, 3]);
  assert.strictEqual(h.outcomes.length, 2);
  assert.deepStrictEqual({ ...h.outcomes[1] }, { type: 'autoResume', outcome: 'gaveUp', key: again.key, sessionId: A, project: h.project, projectName: 'demo-app', attempt: 3, max: 3, copySessionId: null, error: null, atMs: NOW + 8 * MIN, manual: false });
  h.update([again]);
  h.update([again]);
  assert.strictEqual(h.outcomes.length, 2, 'gaveUp once');
  assert.ok(h.logs.some((l) => l.includes('autoresume.outcome.gaveUp {\\"max\\":3}')));
  await h.clock.advance(HOUR);
  assert.strictEqual(h.spawn.resumes().length, 1);
});

test('gaveUp: once across windows; not for a stop that is not fresh (a restart)', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'rt-'));
  const clock = fakeClock();
  const h1 = harness({ dir, clock });
  const h2 = harness({ dir, clock });
  h1.writeState({ lineages: { [A]: { attempts: 3, lastMs: NOW - 5 * MIN } } });
  const s = h1.sess({ status: status('apiError', NOW - MIN) });
  h1.update([s]);
  h2.update([s]);
  assert.strictEqual(h1.plan(s.key).state, 'gaveUp');
  assert.strictEqual(h2.plan(s.key).state, 'gaveUp');
  assert.strictEqual(h1.outcomes.length + h2.outcomes.length, 1);
  const h3 = harness({ clock });
  h3.writeState({ lineages: { [A]: { attempts: 3, lastMs: NOW - 2 * HOUR } } });
  const old = h3.sess({ status: status('apiError', NOW - HOUR) });
  h3.update([old]);
  assert.strictEqual(h3.plan(old.key).state, 'gaveUp');
  assert.strictEqual(h3.outcomes.length, 0);
});

test('reset: a lineage session done after the last attempt, or 24 h, starts the count again', async () => {
  const h = harness();
  h.writeState({ lineages: { [A]: { attempts: 3, lastMs: NOW - 30 * MIN } }, aliases: { [B]: A } });
  const copyDone = h.sess({ id: B, key: `claude:${B}`, status: status('done', NOW - 40 * MIN) });
  h.update([copyDone]);
  assert.strictEqual(h.readState().lineages[A].attempts, 3, 'done before the last resume');
  const later = h.sess({ id: B, key: `claude:${B}`, status: status('done', NOW - 10 * MIN) });
  h.update([later]);
  assert.strictEqual(h.readState().lineages[A], undefined, 'reset (and pruned)');
  const s = h.sess({ status: status('apiError', NOW) });
  h.update([later, s]);
  assert.deepStrictEqual([h.plan(s.key).state, h.plan(s.key).attempt], ['scheduled', 1]);
  const h2 = harness();
  h2.writeState({ lineages: { [A]: { attempts: 3, lastMs: NOW - DAY - MIN } } });
  const s2 = h2.sess();
  h2.update([s2]);
  assert.deepStrictEqual([h2.plan(s2.key).state, h2.plan(s2.key).attempt], ['scheduled', 1]);
});

section('runtime: windows, re-checks, cancel');

test('two windows sharing the claim dir → exactly one spawn (shared state file, and separate ones)', async () => {
  for (const sharedState of [true, false]) {
    const dir = fs.mkdtempSync(path.join(TMP, 'rt-'));
    const clock = fakeClock();
    const spawn = fakeSpawn();
    const h1 = harness({ dir, clock, spawn });
    const h2 = harness({ dir, clock, spawn, share: sharedState ? dir : path.join(dir, 'other-app'), deps: { claimDir: h1.deps.claimDir } });
    const s = h1.sess();
    h1.update([s]);
    h2.update([s]);
    await h1.clock.advance(3 * MIN);
    assert.strictEqual(spawn.resumes().length, 1, `sharedState=${sharedState}`);
    assert.strictEqual(h1.outcomes.length + h2.outcomes.length, 1);
    const loser = h1.outcomes.length ? h2 : h1;
    assert.strictEqual(loser.logged('autoresume.log.skipped').length, 1);
    assert.ok(loser.logs.some((l) => l.includes('autoresume.skip.claimed')), loser.logs.join('\n'));
    h1.update([s]);
    h2.update([s]);
    assert.strictEqual(h1.plan(s.key), undefined);
    assert.strictEqual(h2.plan(s.key), undefined);
    await clock.advance(HOUR);
    assert.strictEqual(spawn.resumes().length, 1);
  }
});

test('claim ids: autoresume|stopId|attempt (lost → skipped, nothing starts)', async () => {
  const h = harness();
  const s = h.sess();
  assert.strictEqual(notify.claimOnce(h.deps.claimDir(), `autoresume|${stopIdOf(s)}|1`, NOW), true);
  h.update([s]);
  await h.clock.advance(3 * MIN);
  assert.strictEqual(h.spawn.resumes().length, 0);
  assert.ok(h.logs.some((l) => l.includes('autoresume.skip.claimed')));
  assert.strictEqual(h.plan(s.key), undefined, 'not fired again in this window');
  await h.clock.advance(HOUR);
  assert.strictEqual(h.spawn.resumes().length, 0);
});

test('re-check at fire time: status changed / project off / cancelled elsewhere / older than 24 h → skipped and logged', async () => {
  // status changed (the latest snapshot no longer has this stop)
  const h1 = harness();
  const s1 = h1.sess();
  h1.update([s1]);
  s1.main.status = status('thinking', NOW + MIN);
  await h1.clock.advance(3 * MIN);
  assert.strictEqual(h1.spawn.resumes().length, 0);
  assert.ok(h1.logs.some((l) => l.startsWith('autoresume.log.skipped') && l.includes('autoresume.skip.changed')), h1.logs.join('\n'));
  // project turned off (globalState changed by another window)
  const h2 = harness();
  const s2 = h2.sess();
  h2.update([s2]);
  h2.store.map.set(KEY, []);
  await h2.clock.advance(3 * MIN);
  assert.strictEqual(h2.spawn.resumes().length, 0);
  assert.ok(h2.logs.some((l) => l.includes('autoresume.skip.off')));
  // cancelled in another window (shared state file)
  const dir = fs.mkdtempSync(path.join(TMP, 'rt-'));
  const clock = fakeClock();
  const w1 = harness({ dir, clock });
  const w2 = harness({ dir, clock });
  const s3 = w1.sess();
  w1.update([s3]);
  w2.update([s3]);
  w2.rt.cancel(s3.key);
  await clock.advance(3 * MIN);
  assert.strictEqual(w1.spawn.resumes().length + w2.spawn.resumes().length, 0);
  assert.ok(w1.logs.some((l) => l.includes('autoresume.skip.cancelled')), w1.logs.join('\n'));
  // the computer slept past the 24 h cutoff
  const h4 = harness();
  const s4 = h4.sess({ status: status('apiError', NOW - DAY + MIN) });
  h4.update([s4]);
  assert.strictEqual(h4.plan(s4.key).atMs, NOW + 5 * SEC, 'already due');
  await h4.clock.sleep(2 * MIN);
  assert.strictEqual(h4.spawn.resumes().length, 0);
  assert.ok(h4.logs.some((l) => l.includes('autoresume.skip.late')));
  // settings changed so the same attempt is due later: re-planned, runs at the new time
  const h5 = harness();
  const s5 = h5.sess();
  h5.update([s5]);
  h5.setSettings({ errorDelayMinutes: 10 });
  await h5.clock.advance(3 * MIN);
  assert.strictEqual(h5.spawn.resumes().length, 0);
  assert.strictEqual(h5.plan(s5.key).atMs, NOW + 10 * MIN);
  assert.strictEqual(h5.logged('autoresume.log.skipped').length, 0, 'not a skip: planned again');
  assert.strictEqual(h5.logged('autoresume.log.planned').length, 2);
  await h5.clock.advance(7 * MIN);
  assert.strictEqual(h5.spawn.resumes().length, 1);
  // Claude now continues by itself (user setting changed): no run
  const h6 = harness();
  const s6 = h6.sess({ live: true, status: status('quota', NOW, quotaHit(NOW + 10 * MIN)) });
  fs.writeFileSync(h6.claudeSettingsFile, JSON.stringify({ autoContinueAtUsageLimit: false }));
  h6.update([s6]);
  assert.strictEqual(h6.plan(s6.key).state, 'scheduled');
  fs.writeFileSync(h6.claudeSettingsFile, '{}');
  await h6.clock.advance(12 * MIN);
  assert.strictEqual(h6.spawn.resumes().length, 0);
  assert.ok(h6.logs.some((l) => l.includes('autoresume.skip.changed')));
});

test('cancel(): the plan goes away for every window, nothing starts', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'rt-'));
  const clock = fakeClock();
  const h = harness({ dir, clock });
  const other = harness({ dir, clock });
  const s = h.sess();
  h.update([s]);
  other.update([s]);
  h.rt.cancel(s.key);
  assert.strictEqual(h.plan(s.key), undefined);
  assert.ok(stopIdOf(s) in h.readState().cancelled);
  assert.ok(h.logs.some((l) => l.startsWith('autoresume.log.skipped') && l.includes('autoresume.skip.cancelled')));
  other.update([s]);
  assert.strictEqual(other.plan(s.key), undefined);
  await clock.advance(HOUR);
  assert.strictEqual(h.spawn.resumes().length + other.spawn.resumes().length, 0);
  h.rt.cancel('claude:unknown');
  h.rt.cancel(undefined);
  const next = h.sess({ status: status('apiError', NOW + 2 * HOUR) });
  h.update([next]);
  assert.strictEqual(h.plan(next.key).state, 'scheduled', 'only that stop was cancelled');
});

section('runtime: resume now');

test('resumeNow: no project needed, same argv, not an auto attempt; returned, not sent to onOutcome', async () => {
  const h = harness({ projects: [] });
  const s = h.sess({ status: status('interrupted', NOW - MIN) });
  h.update([s]);
  assert.strictEqual(h.plan(s.key), undefined);
  const o = await h.rt.resumeNow(s.key);
  assert.deepStrictEqual(o, { type: 'autoResume', outcome: 'resumed', key: s.key, sessionId: A, project: null, projectName: 'demo-app', attempt: 0, max: 3, copySessionId: null, error: null, atMs: NOW, manual: true });
  assert.deepStrictEqual(h.spawn.resumes().map((c) => [c.args, c.opts.cwd, c.opts.shell]), [[['--bg', '--resume', A, 'Continue the task you were working on.'], h.project, false]]);
  assert.strictEqual(h.outcomes.length, 0);
  const st = h.readState();
  assert.strictEqual(st.lineages[A], undefined, 'no attempt counted');
  assert.ok(stopIdOf(s) in st.executed);
  assert.ok(h.logs.some((l) => l.startsWith('autoresume.log.result')));
});

test('resumeNow on a planned stop: the auto plan is dropped; concurrent calls share one run; the same stop again → null', async () => {
  const h = harness();
  const s = h.sess();
  h.update([s]);
  assert.strictEqual(h.plan(s.key).state, 'scheduled');
  const [a, b] = await Promise.all([h.rt.resumeNow(s.key), h.rt.resumeNow(s.key)]);
  assert.strictEqual(a, b);
  assert.strictEqual(h.spawn.resumes().length, 1);
  assert.strictEqual(h.plan(s.key), undefined);
  assert.strictEqual(await h.rt.resumeNow(s.key), null, 'already resumed by hand');
  assert.ok(h.logs.some((l) => l.includes('autoresume.skip.claimed')));
  await h.clock.advance(HOUR);
  assert.strictEqual(h.spawn.resumes().length, 1, 'no auto run after it');
  assert.strictEqual(h.readState().lineages[A], undefined);
});

test('resumeNow: claim id autoresume-now|stopId; a failed try can be retried; running or unknown chats → null', async () => {
  let n = 0;
  const h = harness({ projects: [], script: onResume(() => (++n === 1 ? { code: 1, stderr: 'boom' } : {})) });
  const s = h.sess({ status: status('stale', NOW - HOUR) });
  h.update([s]);
  const first = await h.rt.resumeNow(s.key);
  assert.deepStrictEqual([first.outcome, first.error], ['failed', 'exit']);
  const second = await h.rt.resumeNow(s.key);
  assert.strictEqual(second.outcome, 'resumed', 'retry after a failure');
  assert.strictEqual(h.spawn.resumes().length, 2);
  const h2 = harness({ projects: [] });
  const s2 = h2.sess({ status: status('quota', NOW, quotaHit(null)) });
  assert.strictEqual(notify.claimOnce(h2.deps.claimDir(), `autoresume-now|${stopIdOf(s2)}`, NOW), true);
  h2.update([s2]);
  assert.strictEqual(await h2.rt.resumeNow(s2.key), null);
  assert.strictEqual(h2.spawn.resumes().length, 0);
  for (const code of ['thinking', 'done', 'awaitingInput']) {
    const x = h2.sess({ id: C, key: `claude:${C}`, status: status(code, NOW) });
    h2.update([x]);
    assert.strictEqual(await h2.rt.resumeNow(x.key), null, code);
  }
  assert.strictEqual(await h2.rt.resumeNow('claude:nope'), null);
  const codex = { ...h2.sess({ status: status('apiError', NOW) }), provider: 'codex', key: 'codex:x' };
  h2.update([codex]);
  assert.strictEqual(await h2.rt.resumeNow('codex:x'), null);
  assert.strictEqual(h2.spawn.resumes().length, 0);
});

test('canResumeNow: stopped Claude chats only (apiError, quota, interrupted, stale, UUID id); not while one is starting', async () => {
  const h = harness({ projects: [] });
  for (const code of ['apiError', 'quota', 'interrupted', 'stale']) {
    assert.strictEqual(h.rt.canResumeNow(h.sess({ status: status(code, NOW - MIN) })), true, code);
  }
  for (const code of ['thinking', 'tool', 'done', 'awaitingInput', 'killed']) {
    assert.strictEqual(h.rt.canResumeNow(h.sess({ status: status(code, NOW - MIN) })), false, code);
  }
  assert.strictEqual(h.rt.canResumeNow({ ...h.sess({ status: status('apiError', NOW) }), provider: 'codex' }), false);
  assert.strictEqual(h.rt.canResumeNow(h.sess({ id: 'not-a-uuid', status: status('apiError', NOW) })), false);
  assert.strictEqual(h.rt.canResumeNow(null), false);
  const s = h.sess({ status: status('interrupted', NOW - MIN) });
  h.update([s]);
  const run = h.rt.resumeNow(s.key);
  assert.strictEqual(h.rt.canResumeNow(s), false, 'already starting');
  assert.strictEqual((await run).outcome, 'resumed');
});

section('runtime: failures');

test('a cliPath setting that is not a program (compact.findCli: { error: "cliPath", path }) counts as not found: nothing starts', async () => {
  const { h, planned } = await failCase({ deps: { findCli: () => ({ error: 'cliPath', path: '/nowhere/claude' }) } });
  assert.strictEqual(planned.unavailable, 'cliNotFound');
  assert.strictEqual(h.spawn.calls.length, 0);
  assert.deepStrictEqual([h.outcomes[0].outcome, h.outcomes[0].error], ['failed', 'cliNotFound']);
});

async function failCase(o, sessOverrides = {}) {
  const h = harness(o);
  const s = h.sess(sessOverrides);
  h.update([s]);
  await flush();
  const planned = { ...h.plan(s.key) };
  await h.clock.advance(3 * MIN);
  return { h, s, planned };
}

test('cliNotFound: no CLI → shown on the plan, then failed; nothing started; the attempt counts', async () => {
  const { h, s, planned } = await failCase({ deps: { findCli: () => ({ error: 'notFound' }) } });
  assert.strictEqual(planned.unavailable, 'cliNotFound');
  assert.strictEqual(h.spawn.calls.length, 0);
  assert.deepStrictEqual([h.outcomes[0].outcome, h.outcomes[0].error], ['failed', 'cliNotFound']);
  assert.ok(h.logs.some((l) => l.includes('autoresume.error.cliNotFound')));
  assert.strictEqual(h.readState().lineages[A].attempts, 1);
  assert.ok(stopIdOf(s) in h.readState().executed);
});

test('a Windows .cmd shim is refused (needs a shell): failed/cliNotFound, never spawned', async () => {
  const { h, planned } = await failCase({ deps: { findCli: () => ({ path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', source: 'path' }) } });
  assert.strictEqual(planned.unavailable, 'cliNotFound');
  assert.strictEqual(h.spawn.calls.length, 0);
  assert.deepStrictEqual([h.outcomes[0].outcome, h.outcomes[0].error], ['failed', 'cliNotFound']);
  const bat = await failCase({ deps: { findCli: () => ({ path: '/x/claude.BAT' }) } });
  assert.strictEqual(bat.h.spawn.calls.length, 0);
});

test('cliTooOld: --help without --bg → shown, failed, resume never spawned; cached per path + mtime', async () => {
  const { h, planned } = await failCase({ script: (call) => (call.args[0] === '--help' ? { stdout: HELP_OLD } : {}) });
  assert.strictEqual(planned.unavailable, 'cliTooOld');
  assert.strictEqual(h.spawn.resumes().length, 0);
  assert.strictEqual(h.spawn.helps().length, 1);
  assert.deepStrictEqual([h.outcomes[0].outcome, h.outcomes[0].error], ['failed', 'cliTooOld']);
  const s2 = h.sess({ status: status('apiError', NOW + 10 * MIN) });
  h.update([s2]);
  await flush();
  assert.strictEqual(h.plan(s2.key).unavailable, 'cliTooOld');
  assert.strictEqual(h.spawn.helps().length, 1, 'cached');
  const t = new Date(Date.now() + 60e3);
  fs.utimesSync(h.cli, t, t);
  const s3 = h.sess({ status: status('apiError', NOW + 20 * MIN) });
  h.update([s3]);
  await flush();
  assert.strictEqual(h.spawn.helps().length, 2, 'a new CLI build is checked again');
});

test('cliTooOld only when --help worked: a failing --help is not cached and the run goes ahead', async () => {
  let helps = 0;
  const { h } = await failCase({ script: (call) => (call.args[0] === '--help' ? (++helps === 1 ? { code: 2, stderr: 'weird' } : { stdout: HELP_BG }) : {}) });
  assert.strictEqual(h.spawn.helps().length, 2);
  assert.strictEqual(h.outcomes[0].outcome, 'resumed');
});

test('noCwd: the folder is gone → shown, failed, nothing started', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'rt-'));
  const { h, planned } = await failCase({ dir }, { cwd: path.join(dir, 'work', 'demo-app', 'deleted-subdir') });
  assert.strictEqual(planned.unavailable, 'noCwd');
  assert.strictEqual(h.spawn.calls.length, 0, 'not even --help');
  assert.deepStrictEqual([h.outcomes[0].outcome, h.outcomes[0].error], ['failed', 'noCwd']);
  assert.strictEqual(h.readState().lineages[A].attempts, 1);
});

test('exit ≠ 0: failed/exit; the first output line goes to the log, redacted', async () => {
  const { h } = await failCase({ script: onResume(() => ({ code: 1, stderr: '\n  Error: 401 invalid x-api-key sk-ant-api03-SECRETSECRETSECRET\n    at request (cli.js:1:1)\n' })) });
  assert.deepStrictEqual([h.outcomes[0].outcome, h.outcomes[0].error], ['failed', 'exit']);
  const out = h.logged('autoresume.log.output');
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].includes('Error: 401 invalid x-api-key sk-ant-***') && !out[0].includes('SECRET') && !out[0].includes('cli.js'), out[0]);
  assert.strictEqual(h.readState().lineages[A].attempts, 1);
});

test('timeout: no exit within 60 s → SIGTERM, then SIGKILL; failed/timeout', async () => {
  const h = harness({ script: onResume(() => ({ hang: true })) });
  h.update([h.sess()]);
  await h.clock.advance(2 * MIN);
  assert.strictEqual(h.spawn.resumes().length, 1);
  await h.clock.advance(RUN_TIMEOUT_MS - 1);
  assert.strictEqual(h.outcomes.length, 0, 'still waiting');
  assert.deepStrictEqual(h.spawn.resumes()[0].kills, []);
  await h.clock.advance(1);
  assert.deepStrictEqual([h.outcomes.length, h.outcomes[0].outcome, h.outcomes[0].error], [1, 'failed', 'timeout']);
  assert.deepStrictEqual(h.spawn.resumes()[0].kills, ['SIGTERM']);
  await h.clock.advance(KILL_GRACE_MS);
  assert.deepStrictEqual(h.spawn.resumes()[0].kills, ['SIGTERM', 'SIGKILL']);
});

test('spawn: throws, or emits error → failed/spawn', async () => {
  const a = await failCase({ script: onResume(() => ({ throws: 'EACCES' })) });
  assert.deepStrictEqual([a.h.outcomes[0].outcome, a.h.outcomes[0].error], ['failed', 'spawn']);
  const b = await failCase({ script: onResume(() => ({ error: 'ENOENT' })) });
  assert.deepStrictEqual([b.h.outcomes[0].outcome, b.h.outcomes[0].error], ['failed', 'spawn']);
  assert.ok(b.h.logged('autoresume.log.output').some((l) => l.includes('ENOENT')));
  assert.strictEqual(b.h.readState().lineages[A].attempts, 1);
});

section('runtime: limits, projects, robustness');

test('limit: reset + 60 s; self when Claude continues; the user setting is read at most once a minute; broken → {}', async () => {
  const h = harness();
  const s = h.sess({ live: true, status: status('quota', NOW, quotaHit(NOW + 30 * MIN)) });
  h.update([s]);
  assert.deepStrictEqual([h.plan(s.key).state, h.plan(s.key).atMs], ['self', NOW + 30 * MIN], 'no settings file');
  assert.strictEqual(h.clock.pending(), 0, 'nothing armed for self');
  fs.writeFileSync(h.claudeSettingsFile, JSON.stringify({ autoContinueAtUsageLimit: false, env: { SECRET: 'x' } }));
  h.update([s]);
  assert.strictEqual(h.plan(s.key).state, 'self', 'cached for a minute');
  await h.clock.advance(61 * SEC);
  h.update([s]);
  assert.deepStrictEqual([h.plan(s.key).state, h.plan(s.key).atMs], ['scheduled', NOW + 31 * MIN]);
  fs.writeFileSync(h.claudeSettingsFile, '{ broken');
  await h.clock.advance(61 * SEC);
  h.update([s]);
  assert.strictEqual(h.plan(s.key).state, 'self');
  const panel = h.sess({ id: B, key: `claude:${B}`, live: true, entry: 'vscode', status: status('quota', NOW, quotaHit(NOW + 30 * MIN)) });
  const unknown = h.sess({ id: C, key: `claude:${C}`, status: status('quota', NOW, quotaHit(null)) });
  h.update([s, panel, unknown]);
  assert.strictEqual(h.plan(panel.key).state, 'scheduled');
  assert.deepStrictEqual([h.plan(unknown.key).state, h.plan(unknown.key).atMs], ['noReset', null]);
  h.setSettings({ afterLimit: false });
  h.update([s, panel, unknown]);
  assert.strictEqual(h.rt.plansByKey().size, 0);
  assert.strictEqual(h.clock.pending(), 0);
});

test('projects: setProject / isProjectOn / projects / projectFor; the innermost folder; a plan appears when turned on', async () => {
  const h = harness({ projects: [] });
  const s = h.sess({ cwd: path.join(h.project, 'src') });
  fs.mkdirSync(s.cwd, { recursive: true });
  h.update([s]);
  assert.strictEqual(h.plan(s.key), undefined);
  assert.strictEqual(h.rt.projectFor(s), null);
  await h.rt.setProject(h.project, true);
  assert.deepStrictEqual(h.store.map.get(KEY), [h.project]);
  assert.deepStrictEqual(h.rt.projects(), [h.project]);
  assert.ok(h.rt.isProjectOn(`${h.project}/`));
  assert.ok(!h.rt.isProjectOn(path.dirname(h.project)));
  assert.strictEqual(h.plan(s.key).state, 'scheduled', 're-planned at once');
  assert.strictEqual(h.plan(s.key).project, h.project);
  await h.rt.setProject(`${h.project}/`, true);
  assert.deepStrictEqual(h.store.map.get(KEY), [h.project], 'no duplicate');
  await h.rt.setProject(path.dirname(h.project), true);
  assert.strictEqual(h.rt.projectFor(s), h.project, 'innermost');
  await h.rt.setProject(h.project, false);
  assert.deepStrictEqual(h.store.map.get(KEY), [path.dirname(h.project)]);
  assert.strictEqual(h.rt.projectFor(s), path.dirname(h.project));
  await h.rt.setProject(path.dirname(h.project), false);
  assert.deepStrictEqual(h.store.map.get(KEY), []);
  assert.strictEqual(h.plan(s.key), undefined);
  await flush();
  assert.strictEqual(h.clock.pending(), 0);
  await h.rt.setProject('relative/dir', true);
  await h.rt.setProject('', true);
  await h.rt.setProject(null, true);
  assert.deepStrictEqual(h.store.map.get(KEY), []);
  h.store.map.set(KEY, [h.project, `${h.project}/`, 7, null, '']);
  assert.deepStrictEqual(h.rt.projects(), [h.project], 'stored junk is ignored');
});

test('never throws: garbage snapshots, throwing deps, a broken state file; dispose stops everything', async () => {
  const boom = () => { throw new Error('boom'); };
  const h = harness({ deps: { settings: boom, claudeSettingsPath: boom, prompt: boom, log: boom, t: boom } });
  for (const arg of [undefined, null, {}, { sessions: 5 }, { sessions: [null, 5, 'x', { key: 7 }, { key: 'claude:x', provider: 'claude', main: null }, { key: 'claude:y', provider: 'claude', id: A, main: { status: null } }] }]) {
    h.rt.update(arg);
  }
  const s = h.sess();
  h.rt.update({ sessions: new Map([[s.key, s]]), now: NOW });
  assert.strictEqual(h.plan(s.key).state, 'scheduled', 'a Map works too; defaults when settings throw');
  await h.clock.advance(3 * MIN);
  assert.deepStrictEqual(h.spawn.resumes()[0].args[3], "Continue the task you were working on before you were interrupted. Pick up from the last completed step and don't redo finished work.", 'fallback prompt');
  const h2 = harness({ deps: { stateFile: boom, claimDir: boom, now: boom } });
  h2.update([h2.sess()]);
  assert.strictEqual(h2.rt.plansByKey().size, 1);
  const h3 = harness({ store: { get: boom, update: boom } });
  h3.update([h3.sess()]);
  assert.strictEqual(h3.rt.plansByKey().size, 0);
  assert.deepStrictEqual(h3.rt.projects(), []);
  const h4 = harness();
  h4.writeState('not json {');
  h4.update([h4.sess()]);
  assert.strictEqual(h4.plan(`claude:${A}`).attempt, 1);
  await h4.clock.advance(3 * MIN);
  assert.strictEqual(h4.readState().lineages[A].attempts, 1, 'rewritten as valid JSON');
  assert.ok(h4.logs.some((l) => l.includes('unreadable')));
  const h5 = harness();
  h5.rt.onOutcome(boom);
  const s5 = h5.sess();
  h5.update([s5]);
  await h5.clock.advance(3 * MIN);
  assert.strictEqual(h5.outcomes.length, 1, 'a throwing listener does not stop the others');
  const h6 = harness();
  h6.update([h6.sess()]);
  await flush();
  assert.strictEqual(h6.clock.pending(), 1);
  h6.rt.dispose();
  assert.strictEqual(h6.clock.pending(), 0);
  h6.update([h6.sess({ status: status('apiError', NOW + 1) })]);
  await h6.clock.advance(HOUR);
  assert.strictEqual(h6.spawn.resumes().length, 0);
  assert.strictEqual(await h6.rt.resumeNow(`claude:${A}`), null);
});

// ---------- Run ----------

runAll().then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
});
