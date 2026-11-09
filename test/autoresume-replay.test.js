'use strict';
// Replays of the auto-resume loop of 2026-11-06 (docs/DESIGN.md §12) through the real runtime and the real status
// derivation: lib/autoresume-runtime.js on a real state file, fed by lib/providers/claude.js scanning transcripts and
// registry files in a temp home. The clock, the spawn and the account switcher are fakes; no process is ever started.
// Transcript records have the shape Claude Code really writes for a --bg copy that hits a limit (a copy of the parent's
// records with their old timestamps, the prompt, a synthetic rate_limit record with quotaLimits, turn_duration,
// last-prompt, cost-state); the content is synthetic. Plain node: node test/autoresume-replay.test.js.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const childProcess = require('child_process');
childProcess.spawn = () => { throw new Error('tests never spawn processes'); };
childProcess.execFile = () => { throw new Error('tests never spawn processes'); };

const core = require('../lib/core/autoresume');
const { createAutoResumeRuntime } = require('../lib/autoresume-runtime');
const { ClaudeProvider } = require('../lib/providers/claude');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-replay-'));

const results = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const MIN = 60e3;
const KST = (hms) => Date.parse(`2026-11-06T${hms}+09:00`);
const SWITCH4 = KST('01:16:00');
const STOP = KST('01:24:56');
const SWITCH8 = KST('01:30:22');
const RESETS = KST('05:01:00');
const ORIGINAL = 'bfaaebcf-1111-4222-8333-444444444444';
const HELP = 'Options:\n  --bg   Run in the background\n';
const SPEND_TEXT = "You've hit your monthly spend limit. Raise it in your settings to keep working now, or wait. Your session limit resets 5:01am (Asia/Seoul).";
const SESSION_TEXT = "You've hit your session limit · resets 5:01am (Asia/Seoul)";

const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function fakeClock(start) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
    setTimeout: (fn, ms) => { const h = ++seq; timers.set(h, { at: now + Math.max(0, Number(ms) || 0), fn }); return h; },
    clearTimeout: (h) => { timers.delete(h); },
    async runUntil(end) {
      for (;;) {
        await flush();
        let pick = null;
        for (const [h, x] of timers) if (x.at <= end && (!pick || x.at < pick.x.at)) pick = { h, x };
        if (!pick) break;
        timers.delete(pick.h);
        if (pick.x.at > now) now = pick.x.at;
        pick.x.fn();
      }
      if (end > now) now = end;
      await flush();
    },
  };
}

const iso = (ms) => new Date(ms).toISOString();

/** The records of the limit error, in the order and shape Claude Code writes them */
function limitRecords(sid, ms, text, o = {}) {
  const base = { sessionId: sid, cwd: o.cwd, version: '2.1.318', entrypoint: o.entrypoint || 'cli', sessionKind: o.kind };
  const error = o.error || 'rate_limit';
  return [
    {
      ...base, type: 'assistant', timestamp: iso(ms), isApiErrorMessage: true, error, apiErrorStatus: error === 'rate_limit' ? 429 : 400, isSidechain: false,
      ...(error === 'rate_limit' ? { quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.round(RESETS / 1000), isUsingOverage: false } } : {}),
      message: { id: `synthetic-${ms}`, model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] },
    },
    { ...base, type: 'system', subtype: 'turn_duration', timestamp: iso(ms + 80), durationMs: 900, isMeta: false, isSidechain: false },
    { type: 'last-prompt', lastPrompt: 'synthetic', sessionId: sid },
    { type: 'cost-state', sessionId: sid, totalCostUSD: 0, modelUsage: {} },
  ];
}
let uuidSeq = 0;
const nextUuid = () => `uuid-${++uuidSeq}`;
const userRecord = (sid, ms, cwd, o = {}) => ({
  uuid: nextUuid(), type: 'user', sessionId: sid, timestamp: iso(ms), cwd, version: '2.1.318', entrypoint: o.entrypoint || 'cli', sessionKind: o.kind, isSidechain: false,
  message: { role: 'user', content: o.text || 'Continue the task.' },
});
const endTurn = (sid, ms, cwd, o = {}) => ({
  uuid: nextUuid(), type: 'assistant', sessionId: sid, timestamp: iso(ms), cwd, version: '2.1.318', entrypoint: o.entrypoint || 'cli', sessionKind: o.kind, isSidechain: false,
  message: { id: `m-${ms}`, model: o.model || 'claude-sonnet-4-5', role: 'assistant', stop_reason: o.stop || 'end_turn', content: [{ type: 'text', text: 'Synthetic answer.' }], usage: { input_tokens: 10, output_tokens: 10 } },
});

/**
 * The machine: a temp home with the chat's transcript, a registry, a scheduled list of what the copies write, and one or
 * more windows (runtimes) sharing a state file and a claim dir.
 * o.text: the limit's message; o.account(now, world): the switcher; o.copy: how a copy behaves ('limit' | 'works');
 * o.workMs: how long a working copy works before its turn ends; o.failMs: when a failing copy gets its limit, after it starts;
 * o.error: the record's error (rate_limit by default); o.idleRace: the registry says idle 1 s before the limit record lands;
 * o.quietCli: --bg prints nothing it can parse; o.exitCode: --bg exits with this; o.freshOpening: a copy's records don't
 * keep their parent's ids, so nothing ties it to its parent;
 * o.fsx: the fs of the first window; o.copiedTail: the parent's last record is an old end_turn, not the limit;
 * o.windows: the account switcher of each window; o.skews: how far each window's clock is ahead (ms)
 */
function world(o = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'w-'));
  const home = path.join(dir, 'home');
  const projectsDir = path.join(home, 'projects');
  const pdir = path.join(projectsDir, '-synthetic');
  const cwd = path.join(dir, 'work', 'project');
  const regDir = path.join(home, 'sessions');
  for (const d of [pdir, cwd, regDir, path.join(dir, 'bin'), path.join(dir, 'share')]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(dir, 'bin', 'claude');
  fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n');
  const clock = fakeClock(o.start || STOP - 10e3);
  const fileOf = (sid) => path.join(pdir, `${sid}.jsonl`);
  const append = (sid, recs) => fs.appendFileSync(fileOf(sid), recs.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const pids = new Map();
  const register = (sid, kind, entrypoint, status, atMs) => {
    if (!pids.has(sid)) pids.set(sid, 100000 + pids.size);
    const pid = pids.get(sid);
    fs.writeFileSync(path.join(regDir, `${pid}.json`), JSON.stringify({
      pid, sessionId: sid, cwd, startedAt: atMs, procStart: 'synthetic', version: '2.1.318', kind, entrypoint, status, updatedAt: atMs, statusUpdatedAt: atMs,
    }));
  };
  const scanner = new ClaudeProvider({ projectsDir, home, activeWindowMinutes: 1e7, staleMinutes: 5, discoverMs: 0, env: {}, isAlive: () => true });
  const events = [];
  const at = (ms, fn) => events.push({ ms, fn });
  const w = { dir, clock, cwd, spawned: [], logs: [], warned: [], outcomes: [], lastStopMs: null, copies: [], text: o.text || SPEND_TEXT };

  /** The user back in a chat: a prompt now, a real answer `turnMs` later (null: still running) */
  w.userPrompt = (sid, ms, turnMs = 5000, kind, entrypoint = 'claude-vscode') => {
    append(sid, [userRecord(sid, ms, cwd, { entrypoint, kind, text: 'From the user.' })]);
    register(sid, 'interactive', entrypoint, 'busy', ms);
    if (turnMs == null) return;
    at(ms + turnMs, () => {
      append(sid, [endTurn(sid, ms + turnMs, cwd, { entrypoint, kind })]);
      register(sid, 'interactive', entrypoint, 'idle', ms + turnMs + 50);
    });
  };
  w.at = at;
  /** A chat's limit stop now */
  w.limit = (sid, ms, kind, entrypoint) => {
    append(sid, limitRecords(sid, ms, w.text, { cwd, kind, entrypoint, error: o.error }));
    register(sid, kind === 'bg' ? 'bg' : 'interactive', entrypoint || 'cli', 'idle', ms + 90);
    w.lastStopMs = ms;
  };

  let nth = 0;
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.destroy = () => {};
    child.stderr.destroy = () => {};
    child.kill = () => true;
    child.pid = 5000;
    let out = '';
    let err = '';
    if (args[0] === '--help') out = HELP;
    else if (args[0] === '--bg') {
      const parent = args[2];
      const t0 = clock.now();
      w.spawned.push({ atMs: t0, parent, cwd: opts.cwd });
      const copy = `${String(++nth).padStart(8, '0').replace(/0/g, 'a')}-1111-4222-8333-444444444444`;
      w.copies.push(copy);
      const job = copy.slice(0, 8);
      if (!o.quietCli) {
        out = `backgrounded · ${job}\n  claude agents             list sessions\n`;
        err = `note: session ${parent.slice(0, 8)} is open in another Claude Code process, so this started a copy as ${job}. The original conversation is unchanged.\n`;
      }
      at(t0 + 1000, () => {
        const lines = fs.readFileSync(fileOf(parent), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const recs = lines.map((r) => ({ ...r, sessionId: copy, ...(o.freshOpening && r.uuid ? { uuid: nextUuid() } : {}) }));
        if (o.copiedTail) recs.push(endTurn(copy, w.lastStopMs + 1, cwd, { kind: 'bg' }));
        append(copy, recs);
        const promptAt = t0 + 1000;
        register(copy, 'bg', 'cli', 'busy', promptAt);
        append(copy, [userRecord(copy, promptAt, cwd, { kind: 'bg' })]);
        if (o.copy === 'synthetic') {
          at(t0 + 3000, () => {
            append(copy, [endTurn(copy, clock.now(), cwd, { kind: 'bg', model: '<synthetic>' })]);
            register(copy, 'bg', 'cli', 'idle', clock.now() + 50);
          });
          return;
        }
        if (typeof o.copy === 'function' ? o.copy(clock.now()) === 'works' : o.copy === 'works') {
          at(t0 + (o.workMs || 30 * MIN), () => {
            append(copy, [endTurn(copy, clock.now(), cwd, { kind: 'bg' })]);
            register(copy, 'bg', 'cli', 'idle', clock.now() + 50);
          });
          return;
        }
        // One candidate for the count staying at 1 that night, not verified on the server: the registry's idle landing before
        // the limit record is read, which shows done for a moment
        const failAt = t0 + (o.failMs || 4000);
        if (o.idleRace) at(failAt - 1000, () => register(copy, 'bg', 'cli', 'idle', clock.now()));
        at(failAt, () => w.limit(copy, clock.now(), 'bg'));
      });
    }
    setImmediate(() => {
      if (out) child.stdout.emit('data', Buffer.from(out));
      if (err) child.stderr.emit('data', Buffer.from(err));
      const code = args[0] === '--bg' && o.exitCode ? o.exitCode : 0;
      child.emit('exit', code, null);
      child.emit('close', code, null);
    });
    return child;
  };
  w.spawn = spawn;

  const accounts = o.windows || [o.account];
  const makeRuntime = (acc, i) => {
    const map = new Map([[core.PROJECTS_KEY, [cwd]]]);
    const rt = createAutoResumeRuntime({
      store: { get: (k) => map.get(k), update: async (k, v) => { map.set(k, v); } },
      stateFile: () => path.join(dir, 'share', 'globalStorage', 'autoresume.json'),
      claimDir: () => path.join(dir, 'share', 'claims'),
      findCli: () => ({ path: cli }),
      spawn,
      fs: i === 0 && o.fsx ? o.fsx : fs,
      now: o.skews ? () => clock.now() + (o.skews[i] || 0) : clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      claudeSettingsPath: () => null,
      prompt: () => 'Continue the task.',
      settings: () => o.settings || {},
      log: (l) => w.logs.push(l),
      t: (k, v) => (v ? `${k} ${JSON.stringify(v)}` : k),
      account: () => Promise.resolve(acc ? acc(clock.now(), w) : null),
      warn: (l) => w.warned.push(l),
      ...(o.deps ? o.deps({ home, projectsDir, dir, window: i }) : {}),
    });
    rt.onOutcome((x) => w.outcomes.push(x));
    return rt;
  };
  w.runtimes = accounts.map(makeRuntime);

  w.home = home;
  w.scan = (now) => scanner.scan(now, {}).sessions;
  /** Every snapshot goes to every window, as the shared scan does */
  w.run = async (until, tick = 1000) => {
    while (clock.now() < until) {
      const t = clock.now() + tick;
      const due = events.filter((e) => e.ms <= t).sort((a, b) => a.ms - b.ms);
      for (const e of due) { events.splice(events.indexOf(e), 1); e.fn(); }
      await clock.runUntil(t);
      const sessions = w.scan(t);
      w.runtimes.forEach((rt, i) => rt.update({ sessions, now: t + (o.skews ? o.skews[i] || 0 : 0) }));
      await flush();
    }
  };
  w.started = () => w.logs.filter((l) => l.startsWith('autoresume.log.started')).map((l) => JSON.parse(l.slice(l.indexOf('{'))).n);
  w.logged = (key) => w.logs.filter((l) => l.startsWith(key));
  w.stateFile = path.join(dir, 'share', 'globalStorage', 'autoresume.json');
  w.state = () => JSON.parse(fs.readFileSync(w.stateFile, 'utf8'));
  w.claims = path.join(dir, 'share', 'claims');
  /** A new window on the same files (a reload) */
  w.reload = () => {
    for (const rt of w.runtimes) rt.dispose();
    w.runtimes = [makeRuntime(accounts[0], 0)];
  };
  w.before = (ms) => w.spawned.filter((s) => s.atMs < ms).length;
  w.after = (ms) => w.spawned.filter((s) => s.atMs >= ms).length;
  w.dispose = () => { for (const rt of w.runtimes) rt.dispose(); };

  // The chat, open in a VS Code window, on its way to the limit
  append(ORIGINAL, [userRecord(ORIGINAL, STOP - 5 * MIN, cwd, { entrypoint: 'claude-vscode' }), endTurn(ORIGINAL, STOP - 4 * MIN, cwd, { entrypoint: 'claude-vscode' }),
    userRecord(ORIGINAL, STOP - 1000, cwd, { entrypoint: 'claude-vscode', text: 'A workflow finished.' })]);
  register(ORIGINAL, 'interactive', 'claude-vscode', 'busy', STOP - 1000);
  at(STOP, () => w.limit(ORIGINAL, STOP, undefined, 'claude-vscode'));
  return w;
}

/** cswap as it was that night: #4 from 01:16 "with room", #8 from 01:30:22 */
const nightOf = (now) => (now >= SWITCH8 ? { switchedAtMs: SWITCH8, hasRoom: true, label: '#8' } : { switchedAtMs: SWITCH4, hasRoom: true, label: '#4' });
/** A switcher that has just moved again after every stop, always "with room": only the attempt count can stop the chain */
const alwaysSwitching = (now, w) => ({ switchedAtMs: Math.min(now, (w.lastStopMs || now) + 1000), hasRoom: true, label: '#3' });
const worksAfter8 = (now) => (now >= SWITCH8 ? 'works' : 'limit');
const line = (w, key) => w.logged(key)[0] || '';

// ---------- The incident ----------

test('replay, spend limit: 0 spawns before the switch to #8, exactly 1 after it, promptly; the log says why, once', async () => {
  const w = world({ account: nightOf, copy: worksAfter8 });
  await w.run(KST('01:40:00'));
  assert.strictEqual(w.before(SWITCH8), 0, `spawns before #8: ${w.spawned.map((s) => iso(s.atMs)).join(' ')}`);
  assert.strictEqual(w.after(SWITCH8), 1);
  assert.ok(w.spawned[0].atMs <= SWITCH8 + 62e3, 'within a poll and the 30 s pad');
  assert.strictEqual(w.logged('autoresume.log.held.spend').length, 1);
  assert.deepStrictEqual(w.started(), [1]);
  w.dispose();
});

test('replay, session limit with cswap wrongly claiming room: nothing before #8 (the switch was long before the stop), 1 after', async () => {
  const w = world({ text: SESSION_TEXT, account: nightOf, copy: worksAfter8 });
  await w.run(KST('01:40:00'));
  assert.strictEqual(w.before(SWITCH8), 0, `spawns before #8: ${w.spawned.length}`);
  assert.strictEqual(w.after(SWITCH8), 1);
  assert.strictEqual(w.logged('autoresume.log.held.refused').length, 1);
  w.dispose();
});

test('replay, session limit, the switch just before the stop: at most 1 spawn (the breaker), then 1 after #8', async () => {
  const lateSwitch = (now) => (now >= SWITCH8 ? { switchedAtMs: SWITCH8, hasRoom: true, label: '#8' } : { switchedAtMs: STOP - 40e3, hasRoom: true, label: '#4' });
  const w = world({ text: SESSION_TEXT, account: lateSwitch, copy: worksAfter8 });
  await w.run(KST('01:40:00'));
  assert.strictEqual(w.before(SWITCH8), 1, `spawns before #8: ${w.spawned.length}`);
  assert.strictEqual(w.after(SWITCH8), 1);
  assert.strictEqual(w.logged('autoresume.log.held.fastFail').length, 1);
  w.dispose();
});

test('replay, two windows on one state file, one optimistic and one not: the same bound; the spend limit holds in both', async () => {
  const lateSwitch = (now) => (now >= SWITCH8 ? { switchedAtMs: SWITCH8, hasRoom: true, label: '#8' } : { switchedAtMs: STOP - 40e3, hasRoom: true, label: '#4' });
  const pessimist = (now) => (now >= SWITCH8 ? { switchedAtMs: SWITCH8, hasRoom: true, label: '#8' } : { switchedAtMs: STOP - 40e3, hasRoom: false, label: '#4' });
  const w = world({ text: SESSION_TEXT, windows: [pessimist, lateSwitch], copy: worksAfter8 });
  await w.run(KST('01:40:00'));
  assert.strictEqual(w.before(SWITCH8), 1, `spawns before #8: ${w.spawned.length}`);
  assert.strictEqual(w.after(SWITCH8), 1);
  w.dispose();
  const s = world({ windows: [() => null, nightOf], copy: worksAfter8 });
  await s.run(KST('01:40:00'));
  assert.strictEqual(s.before(SWITCH8), 0);
  assert.strictEqual(s.after(SWITCH8), 1);
  s.dispose();
});

test('a breaker recorded by one window binds the other, and its fresh account answer cannot override it', async () => {
  // The second window's switcher answers "room" and only starts to after the first window's resume was recorded
  const w = world({ text: SESSION_TEXT, windows: [(now) => ({ switchedAtMs: STOP - 40e3, hasRoom: now < STOP + 45e3, label: '#4' }), (now) => ({ switchedAtMs: STOP - 40e3, hasRoom: now >= STOP + 45e3, label: '#4' })] });
  await w.run(KST('01:29:00'));
  assert.strictEqual(w.spawned.length, 1, 'only the resume before the breaker');
  w.dispose();
});

test('replay, a healthy chain: the resume works for 30 min and is done, the count really resets (one log line); a later limit resumes as attempt 1', async () => {
  const w = world({ account: nightOf, copy: 'works' });
  await w.run(KST('01:31:30'));
  assert.strictEqual(w.spawned.length, 1);
  const copy = w.copies[0];
  await w.run(KST('02:02:00'), 5000);
  assert.strictEqual(w.logged('autoresume.log.reset').length, 1);
  const line = w.logged('autoresume.log.reset')[0];
  assert.ok(line.includes(copy) && line.includes('"n":1'), line);
  assert.strictEqual((w.state().lineages[ORIGINAL] || { attempts: 0 }).attempts, 0);
  w.dispose();
});

test('replay, a healthy chain resumes again after a later switch, and its attempt number starts over', async () => {
  const LATER = KST('02:31:00');
  const account = (now) => (now >= LATER ? { switchedAtMs: LATER, hasRoom: true, label: '#9' } : nightOf(now));
  const w = world({ windows: [account, account], copy: 'works' });
  await w.run(KST('02:02:00'), 2000);
  assert.strictEqual(w.spawned.length, 1);
  const copy = w.copies[0];
  w.limit(copy, KST('02:30:00'), 'bg');
  await w.run(KST('02:33:00'), 2000);
  assert.strictEqual(w.spawned.length, 2);
  assert.deepStrictEqual(w.started(), [1, 1]);
  assert.strictEqual(w.logged('autoresume.log.reset').length, 1, 'one line for the whole chain, across both windows');
  assert.strictEqual(w.spawned[1].parent, copy);
  w.dispose();
});

// ---------- What can make the count stay at 1 (the report's "第 1/3 every time") ----------

test('count: a well-ordered chain counts 1, 2, 3 and stops, with real output, real aliases and a real state file', async () => {
  const w = world({ account: alwaysSwitching });
  await w.run(STOP + 8 * MIN);
  assert.deepStrictEqual(w.started(), [1, 2, 3]);
  const st = w.state();
  assert.strictEqual(st.lineages[ORIGINAL].attempts, 3);
  for (const c of w.copies) assert.strictEqual(st.aliases[c.slice(0, 8)], ORIGINAL, 'the copy\'s job id, the first 8 characters of its session');
  w.dispose();
});

test('count: a copied transcript ending in an old end_turn does not reset it (done, but before the last resume)', async () => {
  const w = world({ account: alwaysSwitching, copiedTail: true });
  await w.run(STOP + 8 * MIN);
  assert.deepStrictEqual(w.started(), [1, 2, 3]);
  w.dispose();
});

test('count: two windows taking turns on one state file both see each other\'s updates', async () => {
  const w = world({ windows: [alwaysSwitching, alwaysSwitching] });
  await w.run(STOP + 8 * MIN);
  assert.deepStrictEqual(w.started(), [1, 2, 3]);
  w.dispose();
});

test('count: the registry idle before the limit record lands (one unverified candidate for that night) must not reset it', async () => {
  const w = world({ account: alwaysSwitching, idleRace: true });
  await w.run(STOP + 8 * MIN);
  assert.deepStrictEqual(w.started(), [1, 2, 3]);
  assert.strictEqual(w.logged('autoresume.log.reset').length, 0);
  w.dispose();
});

test('count: a slow-failing copy (the record at 150 s, the registry idle before it) never resets: not real work', async () => {
  const w = world({ account: alwaysSwitching, idleRace: true, failMs: 150e3 });
  await w.run(STOP + 30 * MIN);
  assert.deepStrictEqual(w.started(), [1, 2, 3]);
  assert.strictEqual(w.logged('autoresume.log.reset').length, 0);
  assert.ok(w.outcomes.some((o) => o.outcome === 'gaveUp'));
  w.dispose();
});

test('count: a real 60 s turn does reset it, however quick: a chat doing short real turns is never given up', async () => {
  const account = (now, w) => ({ switchedAtMs: Math.min(now, (w.lastStopMs || now) + 1000), hasRoom: true, label: '#3' });
  const w = world({ text: SESSION_TEXT, account, copy: 'works', workMs: 60e3 });
  await w.run(STOP + 5 * MIN);
  for (let hit = 1; hit <= 4; hit++) {
    const copy = w.copies[w.copies.length - 1];
    w.limit(copy, w.clock.now(), 'bg');
    await w.run(w.clock.now() + 60 * MIN, 5000);
  }
  assert.deepStrictEqual(w.started(), [1, 1, 1, 1, 1], 'every resume did real work');
  assert.strictEqual(w.logged('autoresume.log.reset').length, 5);
  assert.ok(!w.outcomes.some((o) => o.outcome === 'gaveUp'));
  w.dispose();
});

test('count: a state file that cannot be written: no resume runs uncounted; it goes on where it was when writes work again', async () => {
  let broken = false;
  const fsx = Object.create(fs);
  fsx.renameSync = (a, b) => {
    if (broken && String(b).endsWith('autoresume.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return fs.renameSync(a, b);
  };
  const w = world({ account: alwaysSwitching, fsx });
  await w.run(STOP + 40e3);
  assert.deepStrictEqual(w.started(), [1]);
  broken = true;
  await w.run(STOP + 8 * MIN);
  assert.deepStrictEqual(w.started(), [1], 'nothing runs that the other windows could not count');
  assert.strictEqual(w.logged('autoresume.log.unwritable').length, 1, 'said once');
  broken = false;
  await w.run(STOP + 16 * MIN);
  assert.deepStrictEqual(w.started().slice(0, 3), [1, 2, 3]);
  w.dispose();
});

test('count: two windows that both cannot write: no spawns between them, whatever the switcher does; by hand still works', async () => {
  let broken = false;
  const fsx = Object.create(fs);
  fsx.renameSync = (a, b) => {
    if (broken && String(b).endsWith('autoresume.json')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    return fs.renameSync(a, b);
  };
  const w = world({ text: SESSION_TEXT, windows: [alwaysSwitching, alwaysSwitching], deps: () => ({ fs: fsx }) });
  await w.run(STOP + 2000);
  broken = true;
  await w.run(STOP + 30 * MIN);
  assert.strictEqual(w.spawned.length, 0);
  assert.strictEqual(w.logged('autoresume.log.unwritable').length, 2, 'once per window');
  const out = await w.runtimes[0].resumeNow(`claude:${ORIGINAL}`);
  assert.ok(out && out.manual === true, JSON.stringify(out));
  assert.strictEqual(w.spawned.length, 1);
  w.dispose();
});

test('count: a claim that cannot be written is not a win: no spawns from any window; by hand still works', async () => {
  const fsx = Object.create(fs);
  fsx.openSync = (p, flags, ...rest) => {
    if (flags === 'wx' && String(p).endsWith('.claim')) throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
    return fs.openSync(p, flags, ...rest);
  };
  const w = world({ text: SESSION_TEXT, windows: [alwaysSwitching, alwaysSwitching, alwaysSwitching], deps: () => ({ fs: fsx }) });
  await w.run(STOP + 20 * MIN);
  assert.strictEqual(w.spawned.length, 0);
  assert.strictEqual(w.logged('autoresume.log.unwritable').length, 3);
  const out = await w.runtimes[0].resumeNow(`claude:${ORIGINAL}`);
  assert.ok(out && out.manual === true, JSON.stringify(out));
  w.dispose();
});

test('a window whose writes fail still honours a Cancel from another window, and goes back to reading the file after a write works', async () => {
  let broken = false;
  const failing = Object.create(fs);
  failing.renameSync = (x, y) => {
    if (broken && String(y).endsWith('autoresume.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return fs.renameSync(x, y);
  };
  const late = () => ({ switchedAtMs: STOP + 60e3, hasRoom: true, label: '#5' });
  const w = world({ text: SESSION_TEXT, windows: [late, late], deps: ({ window }) => (window === 0 ? { fs: failing } : {}) });
  await w.run(STOP + 2000);
  const key = `claude:${ORIGINAL}`;
  // A write of window 0 fails, so its memory is ahead of the file; then window 1, which can write, cancels
  broken = true;
  await w.runtimes[0].setProject(w.cwd, false);
  await w.runtimes[0].setProject(w.cwd, true);
  w.runtimes[1].cancel(key);
  assert.strictEqual(Object.keys(w.state().cancelled).length, 1);
  await w.run(STOP + 50e3);
  assert.strictEqual(w.runtimes[0].plansByKey().has(key), false, 'the failing window read it');
  // The write works again: window 0's memory must not take the Cancel back
  broken = false;
  await w.run(STOP + 4 * MIN);
  assert.strictEqual(Object.keys(w.state().cancelled).length, 1);
  assert.strictEqual(w.spawned.length, 0);
  // And it reads the file as usual again: another window's next Cancel of a new stop is taken over, not merged away
  w.limit(ORIGINAL, w.clock.now(), undefined, 'claude-vscode');
  await w.run(w.clock.now() + 2000);
  assert.ok(w.runtimes[0].plansByKey().has(key));
  w.runtimes[1].cancel(key);
  await w.run(w.clock.now() + 2000);
  assert.strictEqual(w.runtimes[0].plansByKey().has(key), false);
  await w.run(w.clock.now() + 3 * MIN);
  assert.strictEqual(w.spawned.length, 0);
  w.dispose();
});

test('a synthetic assistant record is no real turn: done, but the count stays', async () => {
  const w = world({ account: nightOf, copy: 'synthetic' });
  await w.run(SWITCH8 + 90e3);
  assert.strictEqual(w.spawned.length, 1);
  await w.run(SWITCH8 + 30 * MIN, 5000);
  const copy = w.scan(w.clock.now()).find((x) => x.id === w.copies[0]);
  assert.strictEqual(copy.main.status.code, 'done');
  assert.ok(copy.lastRealTurnMs < w.spawned[0].atMs, 'only the records copied from its parent');
  assert.strictEqual(w.logged('autoresume.log.reset').length, 0);
  assert.strictEqual(w.state().lineages[ORIGINAL].attempts, 1);
  w.dispose();
});

test('hard cap: copies nothing ties to their parent stop at the project cap, and it says why once', async () => {
  const w = world({ account: alwaysSwitching, quietCli: true, freshOpening: true });
  await w.run(STOP + 9 * MIN);
  assert.ok(w.spawned.length <= core.PROJECT_CAP, `spawns: ${w.spawned.length}`);
  assert.strictEqual(w.logged('autoresume.log.held.projectCap').length, 1);
  w.dispose();
});

test('brake: with lineage lost and a switch every minute, the chain ends at the brake and does not start again; one push; by hand clears it', async () => {
  const w = world({ account: alwaysSwitching, quietCli: true, freshOpening: true });
  await w.run(STOP + 2 * 60 * MIN, 5000);
  const limit = core.brakeLimit(3);
  assert.strictEqual(w.spawned.length, limit, `spawns in 2 h: ${w.spawned.length}`);
  assert.deepStrictEqual([...new Set(w.started())], [1], 'every one logged as attempt 1: only the brake could end it');
  const gave = w.outcomes.filter((o) => o.outcome === 'gaveUp');
  assert.strictEqual(gave.length, 1, 'one push, not one per chat');
  assert.strictEqual(gave[0].brake, true);
  assert.strictEqual(w.logged('autoresume.log.brake').length, 1);
  assert.ok(w.state().brake.tripped[w.cwd]);
  await w.run(STOP + 5 * 60 * MIN, 5000);
  assert.strictEqual(w.spawned.length, limit, 'long after the caps have refilled');
  // The user acts: a manual resume clears it, and it counts afresh
  const last = w.scan(w.clock.now()).find((s) => s.id === w.copies[w.copies.length - 1]);
  const out = await w.runtimes[0].resumeNow(last.key);
  assert.ok(out && out.manual === true);
  assert.strictEqual(w.state().brake.tripped[w.cwd], undefined);
  w.dispose();
});

test('brake: API errors with lineage lost end the same way, and turning the project off and on clears it', async () => {
  const w = world({ text: 'Overloaded', error: 'overloaded', quietCli: true, freshOpening: true });
  await w.run(STOP + 3 * 60 * MIN, 5000);
  assert.strictEqual(w.spawned.length, core.brakeLimit(3));
  assert.strictEqual(w.outcomes.filter((o) => o.brake).length, 1);
  await w.runtimes[0].setProject(w.cwd, false);
  assert.strictEqual(w.state().brake.tripped[w.cwd], undefined);
  w.dispose();
});

test('lineage recovered: --bg prints no id, a new session opening like the chat is its copy: 1, 2, 3 and gaveUp', async () => {
  const w = world({ account: alwaysSwitching, quietCli: true });
  await w.run(STOP + 12 * MIN);
  assert.deepStrictEqual(w.started(), [1, 2, 3]);
  assert.strictEqual(w.logged('autoresume.log.recovered').length, 3);
  assert.strictEqual(w.state().aliases[w.copies[0]], ORIGINAL);
  assert.ok(w.outcomes.some((o) => o.outcome === 'gaveUp'));
  w.dispose();
});

test('lineage recovered: --bg exits 1 after the copy started: the same', async () => {
  const w = world({ account: alwaysSwitching, exitCode: 1 });
  await w.run(STOP + 12 * MIN);
  assert.deepStrictEqual(w.started(), [1, 2, 3]);
  assert.strictEqual(w.outcomes.filter((o) => o.outcome === 'failed').length, 3);
  w.dispose();
});

test('a billing error is treated as a spend limit: no timed retries, a switch after the stop resumes it, the status says quota', async () => {
  const text = 'spend limit reached (daily)';
  const w = world({ text, error: 'billing_error', account: nightOf, copy: worksAfter8 });
  await w.run(SWITCH8 - 1000);
  assert.strictEqual(w.spawned.length, 0, 'the 2, 4, 8 minute retries of an API error are gone');
  const s = w.scan(w.clock.now()).find((x) => x.id === ORIGINAL);
  assert.deepStrictEqual([s.main.status.code, s.main.status.quota.kind], ['quota', 'spend']);
  const plan = w.runtimes[0].plansByKey().get(s.key);
  assert.deepStrictEqual([plan.state, plan.held], ['noReset', 'spend']);
  await w.run(KST('01:32:00'));
  assert.strictEqual(w.spawned.length, 1);
  w.dispose();
});

test('the user back in the original: failed copies get no further resumes, and the count there resets once for real', async () => {
  // A session limit, a switch 40 s before the stop, then #9 well after: C1 fails; a switch would have forked it again
  const account = (now) => (now >= KST('01:36:00') ? { switchedAtMs: KST('01:36:00'), hasRoom: true, label: '#9' } : { switchedAtMs: STOP - 40e3, hasRoom: true, label: '#4' });
  const w = world({ text: SESSION_TEXT, account });
  await w.run(KST('01:30:00'));
  assert.strictEqual(w.spawned.length, 1);
  w.at(KST('01:31:00'), () => w.userPrompt(ORIGINAL, KST('01:31:00'), 5 * MIN));
  await w.run(KST('05:10:00'), 5000);
  assert.strictEqual(w.spawned.length, 1, `no copy next to the user: ${w.spawned.map((s) => iso(s.atMs)).join(' ')}`);
  assert.strictEqual(w.logged('autoresume.log.dropped.active').length, 1);
  assert.strictEqual(w.logged('autoresume.log.reset').length, 1);
  assert.ok(line(w, 'autoresume.log.reset').includes(ORIGINAL));
  assert.ok(w.state().lineages[ORIGINAL], 'the entry is still in the file');
  w.dispose();
});

test('after gaveUp a finished turn in the original does not start the chain again; the original\'s own next limit is attempt 1', async () => {
  const w = world({ text: SESSION_TEXT, account: alwaysSwitching });
  await w.run(STOP + 12 * MIN);
  assert.deepStrictEqual(w.started(), [1, 2, 3]);
  assert.strictEqual(w.outcomes.filter((o) => o.outcome === 'gaveUp').length, 1);
  w.at(w.clock.now() + 1000, () => w.userPrompt(ORIGINAL, w.clock.now(), 60e3));
  await w.run(STOP + 60 * MIN, 5000);
  assert.strictEqual(w.spawned.length, 3, 'no more copies');
  assert.strictEqual(w.outcomes.filter((o) => o.outcome === 'gaveUp').length, 1);
  w.limit(ORIGINAL, w.clock.now(), undefined, 'claude-vscode');
  await w.run(w.clock.now() + 3 * MIN, 5000);
  assert.deepStrictEqual(w.started().slice(0, 4), [1, 2, 3, 1], 'the user\'s chat is not stuck at gaveUp');
  assert.strictEqual(w.spawned[3].parent, ORIGINAL);
  w.dispose();
});

test('a resume just before the user came back cannot be recalled: one log line and one parallel outcome, across windows', async () => {
  const w = world({ windows: [nightOf, nightOf], copy: worksAfter8 });
  await w.run(SWITCH8 + 33e3);
  assert.strictEqual(w.spawned.length, 1);
  const t = w.spawned[0].atMs + 8000;
  w.at(t, () => w.userPrompt(ORIGINAL, t, null));
  await w.run(t + 5000);
  const par = w.outcomes.filter((o) => o.outcome === 'parallel');
  assert.strictEqual(par.length, 1);
  assert.strictEqual(par[0].sessionId, w.copies[0]);
  assert.strictEqual(w.logged('autoresume.log.parallel').length, 1);
  assert.strictEqual(w.spawned.length, 1);
  w.dispose();
});

test('a parallel copy stopping before the original\'s resume: its plan is dropped, and the log says so once', async () => {
  const PARALLEL = 'dddddddd-1111-4222-8333-444444444444';
  const w = world({ account: () => ({ switchedAtMs: STOP + 1000, hasRoom: true, label: '#3' }), copy: 'works' });
  fs.mkdirSync(path.dirname(w.stateFile), { recursive: true });
  fs.writeFileSync(w.stateFile, JSON.stringify({ v: 1, aliases: { [PARALLEL.slice(0, 8)]: ORIGINAL } }));
  await w.run(STOP + 2000);
  const stopAt = STOP + 10e3;
  w.at(stopAt, () => w.limit(PARALLEL, stopAt, 'bg'));
  await w.run(STOP + 60e3);
  assert.strictEqual(w.logged('autoresume.log.dropped.older').length, 1);
  w.dispose();
});

test('a new copy\'s moment on its parent\'s stop is not logged as dropped', async () => {
  const w = world({ account: alwaysSwitching, copy: 'works' });
  await w.run(STOP + 2 * MIN);
  assert.strictEqual(w.logged('autoresume.log.dropped.older').length, 0);
  w.dispose();
});

test('a lost state file: truncated, then a reload: nothing replays; set aside; one warning; a new stop still resumes', async () => {
  const w = world({ text: SESSION_TEXT, account: alwaysSwitching });
  await w.run(STOP + 12 * MIN);
  const n = w.spawned.length;
  assert.strictEqual(n, 3);
  w.outcomes.length = 0;
  fs.writeFileSync(w.stateFile, '{"v":1,"lineages":{"tr');
  w.reload();
  await w.run(STOP + 40 * MIN, 5000);
  assert.strictEqual(w.spawned.length, n, `replayed: ${w.spawned.length}`);
  assert.strictEqual(w.warned.length, 1);
  assert.ok(fs.readdirSync(path.dirname(w.stateFile)).some((f) => f.startsWith('autoresume.json.unreadable-')));
  assert.ok(w.state().lostBefore, 'written, for the other windows');
  w.limit(ORIGINAL, w.clock.now(), undefined, 'claude-vscode');
  await w.run(w.clock.now() + 2 * MIN, 5000);
  assert.strictEqual(w.spawned[n].parent, ORIGINAL, 'stops after the loss are new');
  w.dispose();
});

test('a lost state file: deleted, then a reload: the same, because a state file was written lately; a first start stays quiet', async () => {
  const w = world({ text: SESSION_TEXT, account: alwaysSwitching });
  await w.run(STOP + 12 * MIN);
  const n = w.spawned.length;
  fs.rmSync(w.stateFile);
  w.reload();
  await w.run(STOP + 40 * MIN, 5000);
  assert.strictEqual(w.spawned.length, n);
  assert.strictEqual(w.warned.length, 1);
  w.dispose();
  const fresh = world({ account: alwaysSwitching, copy: 'works' });
  await fresh.run(STOP + 60e3);
  assert.deepStrictEqual([fresh.warned.length, fresh.spawned.length], [0, 1]);
  fresh.dispose();
});

test('a window still on 0.11.0 drops the cap: a new window notices once, warns, and keeps the cap in force', async () => {
  const w = world({ text: SESSION_TEXT, account: alwaysSwitching });
  await w.run(STOP + 8 * MIN);
  assert.ok(w.state().cap.lineages[ORIGINAL].length === 3);
  const st = w.state();
  const old = { v: 1, lineages: { [ORIGINAL]: { attempts: st.lineages[ORIGINAL].attempts, lastMs: st.lineages[ORIGINAL].lastMs } }, aliases: st.aliases, executed: st.executed, cancelled: st.cancelled };
  fs.writeFileSync(w.stateFile, JSON.stringify(old));
  await w.run(w.clock.now() + 3000);
  assert.strictEqual(w.warned.length, 1);
  w.runtimes[0].update({ sessions: w.scan(w.clock.now()), now: w.clock.now() });
  fs.writeFileSync(w.stateFile, JSON.stringify(old));
  await w.run(w.clock.now() + 3000);
  assert.strictEqual(w.warned.length, 1, 'once');
  w.runtimes[0].cancel('claude:nothing'); // no stop: no write
  assert.strictEqual(w.runtimes[0].plansByKey().size > 0, true);
  // A file of 0.11.0 before this window ever wrote one is merely an old file: no warning
  const fresh = world({ text: SESSION_TEXT });
  fs.mkdirSync(path.dirname(fresh.stateFile), { recursive: true });
  fs.writeFileSync(fresh.stateFile, JSON.stringify({ v: 1, lineages: {}, aliases: {}, executed: {}, cancelled: {} }));
  await fresh.run(STOP + 2000);
  assert.strictEqual(fresh.warned.length, 0);
  w.dispose();
  fresh.dispose();
});

test('hard cap: copies are held under the chain\'s root; a reset does not free it, and it is the reason in the log', async () => {
  // Real short turns reset the count, so only the lineage cap stands in the way: three resumes in 10 minutes, the fourth waits
  const w = world({ text: SESSION_TEXT, account: alwaysSwitching, copy: 'works', workMs: 20e3 });
  await w.run(STOP + 60e3, 2000);
  for (let i = 0; i < 3; i++) {
    const copy = w.copies[w.copies.length - 1];
    await w.run(w.clock.now() + 30e3, 2000);
    w.limit(copy, w.clock.now(), 'bg');
    await w.run(w.clock.now() + 50e3, 2000);
  }
  assert.ok(w.logged('autoresume.log.reset').length >= 2);
  assert.strictEqual(w.spawned.length, 3, 'not a fourth within the 10 minutes');
  const last = w.logged('autoresume.log.held.lineageCap');
  assert.strictEqual(last.length, 1);
  assert.ok(last[0].includes(w.copies[2].slice(0, 8)));
  w.dispose();
});

test('two windows: one held line and one reset line between them', async () => {
  const w = world({ text: SESSION_TEXT, windows: [nightOf, nightOf], copy: worksAfter8 });
  await w.run(STOP + 60e3);
  assert.strictEqual(w.logged('autoresume.log.held.refused').length, 1);
  await w.run(SWITCH8 + 90e3);
  await w.run(SWITCH8 + 32 * MIN, 5000);
  assert.strictEqual(w.logged('autoresume.log.reset').length, 1);
  w.dispose();
});

test('the resume is timed from when it really starts: the breaker measures from there, not from a slow account answer', async () => {
  // The question right before the send takes 5 s; the polls before it stopped once the plan moved up
  const slow = (now, x) => {
    if (now >= STOP + 20e3) x.clock.advance(5000);
    return { switchedAtMs: STOP + 1000, hasRoom: true, label: '#3' };
  };
  const w = world({ text: SESSION_TEXT, account: slow, copy: 'works' });
  await w.run(STOP + 90e3);
  assert.strictEqual(w.spawned.length, 1);
  assert.ok(w.spawned[0].atMs >= STOP + 36e3, iso(w.spawned[0].atMs));
  assert.strictEqual(w.state().lineages[ORIGINAL].lastMs, w.spawned[0].atMs);
  w.dispose();
});

test('hard cap: a reset cannot clear it: the attempt count is back at 0, the plan still waits', async () => {
  const st = core.recordAttempt(core.recordAttempt(core.recordAttempt(core.emptyState(), ORIGINAL, null, STOP - 8 * MIN, '/p'), ORIGINAL, null, STOP - 6 * MIN, '/p'), ORIGINAL, null, STOP - 4 * MIN, '/p');
  const done = { provider: 'claude', id: ORIGINAL, lastRealTurnMs: STOP - MIN, main: { status: { code: 'done', sinceMs: STOP - MIN } } };
  const r = core.resetOnDone(st, [done]);
  assert.strictEqual(r.state.lineages[ORIGINAL].attempts, 0);
  assert.deepStrictEqual(r.resets, [{ root: ORIGINAL, sessionId: ORIGINAL, attempts: 3 }]);
  assert.strictEqual(r.state.cap.lineages[ORIGINAL].length, 3);
  const s = { key: `claude:${ORIGINAL}`, provider: 'claude', id: ORIGINAL, cwd: '/p', main: { status: { code: 'quota', sinceMs: STOP, quota: { kind: 'session', resetsAtMs: STOP } } } };
  const p = core.planFor(s, core.lineageOf(r.state, ORIGINAL, STOP), { projects: ['/p'], now: STOP, cap: r.state.cap });
  assert.deepStrictEqual([p.state, p.held, p.atMs], ['scheduled', 'lineageCap', STOP - 8 * MIN + core.CAP_WINDOW_MS]);
});

// ---------- What must not undo the guards ----------

test('brake: the user working in the original, while copies nothing ties to it loop, does not clear it: the copies are their own count', async () => {
  // --bg prints no id and the copies open with fresh record ids, so the original stays the head of its lineage; the user's
  // real turns there are the original's own, and must not wipe the resumes of the lost copies from the project's count
  const w = world({ text: SESSION_TEXT, account: alwaysSwitching, quietCli: true, freshOpening: true });
  for (let t = STOP + 90e3; t < STOP + 2 * 60 * MIN; t += 10 * MIN) { const at = t; w.at(at, () => w.userPrompt(ORIGINAL, at, 20e3)); }
  await w.run(STOP + 2 * 60 * MIN, 5000);
  assert.ok(w.spawned.length <= core.brakeLimit(3) + 1, `spawns: ${w.spawned.length}`);
  assert.strictEqual(w.logged('autoresume.log.brake').length, 1);
  assert.strictEqual(w.outcomes.filter((o) => o.brake).length, 1);
  w.dispose();
});

test('a day later: a dead chain\'s last stop is not resumed again when its count or the brake expires', async () => {
  // The last copy's limit lands 150 s after its resume, so a day after the last resume it is still under a day old
  const w = world({ text: SESSION_TEXT, account: alwaysSwitching, failMs: 150e3 });
  await w.run(STOP + 26 * 60 * MIN, 30e3);
  assert.deepStrictEqual(w.started(), [1, 2, 3], w.spawned.map((x) => iso(x.atMs)).join(' '));
  assert.strictEqual(w.outcomes.filter((o) => o.outcome === 'gaveUp').length, 1);
  w.dispose();
  const lost = world({ text: SESSION_TEXT, account: alwaysSwitching, failMs: 150e3, quietCli: true, freshOpening: true });
  await lost.run(STOP + 26 * 60 * MIN, 30e3);
  assert.strictEqual(lost.spawned.length, core.brakeLimit(3));
  assert.strictEqual(lost.logged('autoresume.log.brake').length, 1);
  lost.dispose();
});

test('a window whose clock runs ahead does not erase the cap and the brake the others recorded', async () => {
  const w = world({ text: SESSION_TEXT, windows: [alwaysSwitching, alwaysSwitching], quietCli: true, freshOpening: true, skews: [0, 3 * MIN] });
  await w.run(STOP + 11 * MIN);
  assert.ok(w.spawned.filter((x) => x.atMs < STOP + 10 * MIN).length <= core.PROJECT_CAP, `spawns: ${w.spawned.length}`);
  assert.ok(w.spawned.length <= core.brakeLimit(3), `spawns: ${w.spawned.length}`);
  w.dispose();
});

test('a clock set back: the window that recorded a resume at the wrong time still resumes the chat\'s next stop', async () => {
  const skews = [2 * 60 * MIN];
  const w = world({ text: 'Overloaded', error: 'overloaded', copy: 'works', workMs: 60e3, skews });
  await w.run(STOP + 5 * MIN, 2000);
  assert.strictEqual(w.spawned.length, 1);
  skews[0] = 0;
  const t = w.clock.now() + 20 * MIN;
  w.at(t - 30e3, () => w.userPrompt(ORIGINAL, t - 30e3, 10e3));
  w.at(t, () => w.limit(ORIGINAL, t, undefined, 'claude-vscode'));
  await w.run(t + 10 * MIN, 2000);
  assert.strictEqual(w.spawned.length, 2, 'not dropped as older than the resume');
  assert.strictEqual(w.logged('autoresume.log.dropped.older').length, 0);
  w.dispose();
});

test('the count that cannot be written after the claim: nothing runs then, and the stop is not used up: it runs once when a write works', async () => {
  let fails = 0;
  const fsx = Object.create(fs);
  fsx.renameSync = (a, b) => {
    // Only the write of the attempt (the first with a stop marked run), once
    if (!fails && String(b).endsWith('autoresume.json') && Object.keys(JSON.parse(fs.readFileSync(a, 'utf8')).executed || {}).length) {
      fails++;
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    }
    return fs.renameSync(a, b);
  };
  const w = world({ text: 'Overloaded', error: 'overloaded', copy: 'works', fsx });
  await w.run(STOP + 2 * MIN + 5000, 1000);
  assert.strictEqual(fails, 1);
  assert.strictEqual(w.spawned.length, 0, 'not run uncounted');
  assert.strictEqual(w.runtimes[0].plansByKey().get(`claude:${ORIGINAL}`).held, 'unwritable');
  await w.run(STOP + 10 * MIN, 1000);
  assert.strictEqual(w.spawned.length, 1);
  assert.deepStrictEqual(w.started(), [1]);
  assert.strictEqual(w.state().lineages[ORIGINAL].attempts, 1);
  assert.deepStrictEqual(w.outcomes.map((o) => o.outcome), ['copied']);
  w.dispose();
});

test('a read error at a window\'s first look is not a lost file: nothing set aside, the count and a plan made meanwhile stand', async () => {
  let busy = 0;
  const fsx = Object.create(fs);
  fsx.readFileSync = (p, ...r) => {
    if (busy > 0 && String(p).endsWith('autoresume.json')) { busy--; throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); }
    return fs.readFileSync(p, ...r);
  };
  const w = world({ text: SESSION_TEXT, account: alwaysSwitching, fsx });
  await w.run(STOP + 8 * MIN);
  assert.deepStrictEqual(w.started(), [1, 2, 3]);
  busy = 2;
  w.reload();
  await w.run(STOP + 9 * MIN);
  const st = w.state();
  assert.deepStrictEqual([st.lineages[ORIGINAL].attempts, st.cap.lineages[ORIGINAL].length, st.lostBefore], [3, 3, undefined]);
  assert.strictEqual(w.warned.length, 0);
  assert.ok(!fs.readdirSync(path.dirname(w.stateFile)).some((f) => f.startsWith('autoresume.json.unreadable-')));
  assert.strictEqual(w.spawned.length, 3, 'still given up');
  // A write before the first read that works is not written over the file: merged in once it can be read
  busy = 2;
  w.reload();
  const now = w.clock.now();
  const sessions = w.scan(now);
  w.runtimes[0].update({ sessions, now });
  const last = sessions.find((x) => x.id === w.copies[2]);
  w.runtimes[0].cancel(last.key);
  await w.run(STOP + 10 * MIN);
  const merged = w.state();
  assert.deepStrictEqual([merged.lineages[ORIGINAL].attempts, Object.keys(merged.cancelled).length, w.warned.length], [3, 1, 0]);
  // A stat error other than "not there" is not a missing file either
  const fresh = world({ text: SESSION_TEXT, account: alwaysSwitching, copy: 'works' });
  await fresh.run(STOP + 60e3);
  const statFail = Object.create(fs);
  let statBusy = 3;
  statFail.statSync = (p, ...r) => {
    if (statBusy > 0 && String(p).endsWith('autoresume.json')) { statBusy--; throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }
    return fs.statSync(p, ...r);
  };
  fresh.runtimes[0].dispose();
  const before = fresh.state();
  fresh.runtimes = [createAutoResumeRuntime({
    store: { get: (k) => (k === core.PROJECTS_KEY ? [fresh.cwd] : undefined), update: async () => {} },
    stateFile: () => fresh.stateFile, claimDir: () => fresh.claims, findCli: () => ({ path: '/nonexistent' }), spawn: fresh.spawn, fs: statFail,
    now: fresh.clock.now, setTimeout: fresh.clock.setTimeout, clearTimeout: fresh.clock.clearTimeout, claudeSettingsPath: () => null,
    log: (l) => fresh.logs.push(l), warn: (l) => fresh.warned.push(l),
  })];
  await fresh.run(STOP + 2 * MIN);
  assert.strictEqual(fresh.warned.length, 0);
  assert.deepStrictEqual(fresh.state().lineages, before.lineages);
  fresh.dispose();
  w.dispose();
});

test('a state file that cannot be written: the failure is logged once, not every 30 s', async () => {
  let broken = false;
  const fsx = Object.create(fs);
  fsx.renameSync = (a, b) => {
    if (broken && String(b).endsWith('autoresume.json')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    return fs.renameSync(a, b);
  };
  const w = world({ text: SESSION_TEXT, windows: [alwaysSwitching, alwaysSwitching], deps: () => ({ fs: fsx }) });
  await w.run(STOP + 2000);
  broken = true;
  const n = w.logs.length;
  await w.run(STOP + 60 * MIN, 2000);
  const lines = w.logs.slice(n);
  assert.strictEqual(lines.filter((l) => l.includes('could not write')).length, 2, 'once per window');
  assert.strictEqual(w.warned.length, 2, 'and shown once per window');
  assert.ok(lines.length <= 6, lines.join('\n'));
  w.dispose();
});

test('a claim that cannot be written: the plan says why, not just a time long past', async () => {
  const fsx = Object.create(fs);
  fsx.openSync = (p, flags, ...rest) => {
    if (flags === 'wx' && String(p).endsWith('.claim')) throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
    return fs.openSync(p, flags, ...rest);
  };
  const w = world({ text: 'Overloaded', error: 'overloaded', fsx });
  await w.run(STOP + 60 * MIN, 60e3);
  assert.strictEqual(w.spawned.length, 0);
  const p = w.runtimes[0].plansByKey().get(`claude:${ORIGINAL}`);
  assert.deepStrictEqual([p.state, p.held], ['scheduled', 'unwritable']);
  assert.strictEqual(w.warned.length, 1);
  w.dispose();
});

test('a manual resume while writes fail survives another window\'s write, and is not resumed again once writes work', async () => {
  let broken = false;
  const fsx = Object.create(fs);
  fsx.renameSync = (a, b) => {
    if (broken && String(b).endsWith('autoresume.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return fs.renameSync(a, b);
  };
  const w = world({ text: SESSION_TEXT, fsx, copy: 'works', workMs: 10 * 60 * MIN });
  fs.mkdirSync(path.dirname(w.stateFile), { recursive: true });
  fs.writeFileSync(w.stateFile, JSON.stringify(core.emptyState()));
  await w.run(STOP + 2000);
  broken = true;
  const key = `claude:${ORIGINAL}`;
  const out = await w.runtimes[0].resumeNow(key);
  assert.ok(out && out.manual && out.outcome === 'copied', JSON.stringify(out));
  // Another window writes the file meanwhile (a Cancel of something else)
  const other = { ...w.state(), cancelled: { 'cccccccc-1111-4222-8333-444444444444|apiError|1': w.clock.now() } };
  fs.writeFileSync(w.stateFile, JSON.stringify(other));
  await w.run(STOP + 2 * MIN);
  broken = false;
  await w.run(RESETS + 5 * MIN, 5000);
  assert.strictEqual(w.spawned.length, 1, 'only the manual one');
  assert.ok(Object.keys(w.state().executed).some((k) => k.startsWith(ORIGINAL)));
  w.dispose();
});

// ---------- In the original window, and by hand ----------

test('in-window on (the default): the guards hold before any helper or copy; the manual path is never blocked', async () => {
  // The chat open in a window with no registry name: not sendable, and not this window's own: the fallback is --bg
  const w = world({
    account: nightOf,
    copy: 'works',
    deps: ({ home, projectsDir, dir }) => ({
      claudeHome: () => home, projectsDir: () => projectsDir, storageDir: () => dir, inWindow: () => true, isAlive: () => true, hostPid: 999999, processChain: async () => [1],
    }),
  });
  await w.run(STOP + 60e3);
  assert.strictEqual(w.spawned.length, 0, 'held: no copy, and no helper was spawned');
  const key = `claude:${ORIGINAL}`;
  assert.ok(w.runtimes[0].plansByKey().get(key).held === 'spend');
  const out = await w.runtimes[0].resumeNow(key);
  assert.ok(out && out.manual === true && out.outcome === 'copied', JSON.stringify(out));
  assert.strictEqual(w.spawned.length, 1, 'by hand it goes ahead, as a copy');
  assert.strictEqual((w.state().lineages[ORIGINAL] || { attempts: 0 }).attempts, 0, 'not counted');
  assert.ok(!(w.state().cap.lineages || {})[ORIGINAL], 'not in the cap');
  w.dispose();
});

test('manual: a chain at its cap and at gaveUp can still be resumed by hand', async () => {
  const w = world({ account: alwaysSwitching });
  await w.run(STOP + 8 * MIN);
  assert.deepStrictEqual(w.started(), [1, 2, 3]);
  const sessions = w.scan(w.clock.now());
  const last = sessions.find((s) => s.id === w.copies[2]);
  assert.strictEqual(w.runtimes[0].plansByKey().get(last.key).state, 'gaveUp');
  const out = await w.runtimes[0].resumeNow(last.key);
  assert.ok(out && out.outcome === 'copied' && out.manual === true, JSON.stringify(out));
  w.dispose();
});

(async () => {
  for (const q of queue) {
    try {
      await q.fn();
      results.push(true);
      console.log(`  ok    ${q.name}`);
    } catch (err) {
      results.push(false);
      console.log(`  FAIL  ${q.name}\n        ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n        ')}`);
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 });
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
