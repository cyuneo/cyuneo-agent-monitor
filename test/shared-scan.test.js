'use strict';
// Tests for lib/shared-scan.js (one scan shared by all VS Code windows) and the worker's pause / resume / interval messages.
// Plain node: node test/shared-scan.test.js
// - Coordinators share one temp directory and a fake clock (timers injected, fs.watch off), except one test that uses real
//   timers and fs.watch to check the low-latency path.
// - Worker tests start lib/worker.js on a real thread over a copy of the synthetic test/fixtures/claude samples.
// - Temp files go to AGENT_MONITOR_TEST_TMP (falls back to the system temp directory) and are deleted after the run.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
const { createSharedScan, ROLES } = require('../lib/shared-scan');

const FIX = path.join(__dirname, 'fixtures', 'claude', 'projects');
const KEY_A = 'claude:aaaaaaaa-0000-4000-8000-000000000001';
const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-shared-'));

const HB = 1000;     // heartbeat
const STALE = 4000;  // a leader / window whose beat is older than this is gone
const SETTLE = 100;  // a claim is confirmed this long after writing
const GRACE = 1500;  // a follower waits this long before going solo on a cfgKey mismatch

// ---------- Helpers ----------

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Fake clock: timers belong to an owner; a frozen owner's timers do not fire (a hung or crashed window)
function fakeClock(start = 1e6) {
  const c = { t: start, seq: 0, list: [] };
  c.now = () => c.t;
  const add = (fn, ms, repeat, owner) => {
    const e = { id: ++c.seq, at: c.t + Math.max(0, ms || 0), ms: Math.max(1, ms || 0), fn, repeat, owner };
    c.list.push(e);
    return e;
  };
  const remove = (e) => { c.list = c.list.filter((x) => x !== e); };
  c.timers = (owner) => ({
    setTimeout: (fn, ms) => add(fn, ms, false, owner),
    clearTimeout: remove,
    setInterval: (fn, ms) => add(fn, ms, true, owner),
    clearInterval: remove,
  });
  c.pending = (owner) => c.list.filter((e) => e.owner === owner).length;
  c.advance = (ms) => {
    const end = c.t + ms;
    for (;;) {
      const due = c.list.filter((e) => e.at <= end && !e.owner.frozen).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      c.t = Math.max(c.t, due.at);
      if (due.repeat) due.at = c.t + due.ms;
      else remove(due);
      due.fn();
    }
    c.t = end;
  };
  return c;
}

let dirNo = 0;
function newDir() {
  const d = path.join(TMP, `dir-${++dirNo}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const readJ = (dir, name) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; } };
const exists = (dir, name) => fs.existsSync(path.join(dir, name));
const last = (arr) => arr[arr.length - 1];

// A coordinator on the fake clock that records every callback in .log
function coord(clock, dir, id, extra = {}) {
  const owner = { frozen: false };
  const log = { roles: [], snaps: [], unions: [], refresh: 0, presence: [], errors: [] };
  const s = createSharedScan({
    dir, windowId: id, cfgKey: 'k1', watch: false, now: clock.now, ...clock.timers(owner),
    heartbeatMs: HB, staleMs: STALE, settleMs: SETTLE, soloGraceMs: GRACE,
    onRole: (r) => log.roles.push(r),
    onSnapshot: (x) => log.snaps.push(x),
    onFocusUnion: (k) => log.unions.push(k),
    onRefreshRequest: () => { log.refresh++; },
    onPresence: (p) => log.presence.push(p.anyFocused),
    onError: (e) => log.errors.push(e),
    ...extra,
  });
  s.log = log;
  s.owner = owner;
  return s;
}

// a becomes leader, the rest follow
function startAll(clock, first, ...rest) {
  first.start();
  clock.advance(SETTLE);
  for (const s of rest) s.start();
  assert.strictEqual(first.role, ROLES.LEADER);
  for (const s of rest) assert.strictEqual(s.role, ROLES.FOLLOWER);
}

const SNAP = (n, extra = {}) => ({ type: 'snapshot', v: 2, now: n, sessions: [{ key: 'claude:s1', live: true }], quota: null, today: null, details: {}, sources: {}, ...extra });

// ---------- Election ----------

test('election: the first window claims after settling, the rest follow; the leader refreshes its beat; last writer wins', () => {
  const clock = fakeClock();
  const dir = newDir();
  const [a, b, c] = ['a', 'b', 'c'].map((id) => coord(clock, dir, id));
  a.start();
  assert.strictEqual(a.role, null, 'a claim settles before it counts');
  assert.strictEqual(readJ(dir, 'leader.json').id, 'a');
  clock.advance(SETTLE);
  assert.strictEqual(a.role, ROLES.LEADER);
  b.start();
  c.start();
  assert.deepStrictEqual([a.role, b.role, c.role], ['leader', 'follower', 'follower']);
  clock.advance(HB * 5);
  assert.deepStrictEqual([a.role, b.role, c.role], ['leader', 'follower', 'follower']);
  const L = readJ(dir, 'leader.json');
  assert.deepStrictEqual([L.id, L.cfgKey], ['a', 'k1']);
  assert.ok(clock.t - L.beat < HB, 'beat refreshed every heartbeat');
  assert.deepStrictEqual([a.log.roles, b.log.roles, c.log.roles], [['leader'], ['follower'], ['follower']]);
  const W = readJ(dir, 'win-b.json');
  assert.deepStrictEqual({ ...W, beat: 0 }, { id: 'b', cfgKey: 'k1', focus: [], focused: false, beat: 0, hb: HB });
  assert.ok(clock.t - W.beat < HB);
  // Another window's claim lands after the leader's beat: the leader reads another fresh id and steps down
  fs.writeFileSync(path.join(dir, 'leader.json'), JSON.stringify({ id: 'x', cfgKey: 'k1', beat: clock.t }));
  clock.advance(HB);
  assert.deepStrictEqual([a.role, b.role, c.role], ['follower', 'follower', 'follower']);
  assert.strictEqual(readJ(dir, 'leader.json').id, 'x', 'the stepped-down leader does not overwrite the new claim');
  // A later writer also wins while a claim is still settling
  const dir2 = newDir();
  const d = coord(clock, dir2, 'd');
  d.start();
  fs.writeFileSync(path.join(dir2, 'leader.json'), JSON.stringify({ id: 'y', cfgKey: 'k1', beat: clock.t }));
  clock.advance(SETTLE);
  assert.strictEqual(d.role, ROLES.FOLLOWER);
  assert.deepStrictEqual(d.log.roles, ['follower'], 'never reported leader');
  for (const s of [a, b, c, d]) s.stop();
  assert.deepStrictEqual([a, b, c, d].flatMap((s) => s.log.errors), []);
});

test('takeover: when the leader stops, exactly one follower takes over on the next heartbeat', () => {
  const clock = fakeClock();
  const dir = newDir();
  const [a, b, c] = ['a', 'b', 'c'].map((id) => coord(clock, dir, id));
  startAll(clock, a, b, c);
  a.stop();
  assert.ok(!exists(dir, 'leader.json') && !exists(dir, 'win-a.json'));
  clock.advance(HB + SETTLE);
  assert.deepStrictEqual([b.role, c.role].sort(), ['follower', 'leader']);
  const lead = b.role === ROLES.LEADER ? b : c;
  assert.strictEqual(readJ(dir, 'leader.json').id, lead.id);
  assert.deepStrictEqual(lead.log.roles, ['follower', 'leader']);
  clock.advance(HB * 5);
  assert.deepStrictEqual([b.role, c.role].sort(), ['follower', 'leader'], 'stable afterwards');
  b.stop();
  c.stop();
});

test('takeover: a leader that stops beating is replaced once stale (after one extra heartbeat); when it wakes up it steps down', () => {
  const clock = fakeClock();
  const dir = newDir();
  const a = coord(clock, dir, 'a');
  const b = coord(clock, dir, 'b');
  startAll(clock, a, b);
  a.owner.frozen = true; // hung or crashed without cleanup: leader.json stays
  clock.advance(STALE);
  assert.strictEqual(b.role, ROLES.FOLLOWER, 'not stale yet');
  clock.advance(HB);
  assert.strictEqual(b.role, ROLES.FOLLOWER, 'stale, but the leader gets one more heartbeat');
  clock.advance(HB * 2 + SETTLE);
  assert.strictEqual(b.role, ROLES.LEADER);
  assert.strictEqual(readJ(dir, 'leader.json').id, 'b');
  a.owner.frozen = false;
  clock.advance(HB);
  assert.strictEqual(a.role, ROLES.FOLLOWER, 'the old leader read a fresh claim by b');
  assert.strictEqual(b.role, ROLES.LEADER);
  assert.strictEqual(readJ(dir, 'leader.json').id, 'b');
  a.stop();
  b.stop();
});

// ---------- Snapshots ----------

test('follower: receives each published snapshot once; a window that joins later gets the current one at once', () => {
  const clock = fakeClock();
  const dir = newDir();
  const a = coord(clock, dir, 'a');
  const b = coord(clock, dir, 'b');
  startAll(clock, a, b);
  assert.strictEqual(a.publish(SNAP(1)), true);
  assert.deepStrictEqual(readJ(dir, 'snapshot.json'), { leaderId: 'a', cfgKey: 'k1', at: clock.t, snap: SNAP(1) });
  assert.strictEqual(b.log.snaps.length, 0, 'read on the next poll');
  clock.advance(HB);
  assert.deepStrictEqual(b.log.snaps, [SNAP(1)]);
  const c = coord(clock, dir, 'c');
  c.start();
  assert.deepStrictEqual(c.log.snaps, [SNAP(1)], 'the joining follower reads the current file');
  const two = SNAP(2, { sessions: [{ key: 'claude:s1', live: false }] });
  assert.strictEqual(a.publish(two), true);
  clock.advance(HB * 3);
  assert.deepStrictEqual(b.log.snaps, [SNAP(1), two]);
  assert.deepStrictEqual(c.log.snaps, [SNAP(1), two]);
  assert.strictEqual(a.log.snaps.length, 0, 'the leader does not read its own snapshots');
  for (const s of [a, b, c]) s.stop();
});

test('publish: skipped when nothing except now changed; only the leader writes', () => {
  const clock = fakeClock();
  const dir = newDir();
  const a = coord(clock, dir, 'a');
  const b = coord(clock, dir, 'b');
  startAll(clock, a, b);
  assert.strictEqual(a.publish(SNAP(1)), true);
  const st1 = fs.statSync(path.join(dir, 'snapshot.json'));
  clock.advance(HB);
  assert.strictEqual(a.publish(SNAP(2)), false);
  assert.strictEqual(a.publish(SNAP(3)), false);
  const st2 = fs.statSync(path.join(dir, 'snapshot.json'));
  assert.deepStrictEqual([st2.ino, st2.mtimeMs], [st1.ino, st1.mtimeMs], 'file not rewritten');
  assert.strictEqual(readJ(dir, 'snapshot.json').snap.now, 1);
  const changed = SNAP(4, { quota: { pct: 5 } });
  assert.strictEqual(a.publish(changed), true);
  assert.strictEqual(b.publish(SNAP(5, { quota: { pct: 9 } })), false, 'a follower never writes');
  assert.strictEqual(a.publish(null), false);
  clock.advance(HB);
  assert.deepStrictEqual(b.log.snaps, [SNAP(1), changed]);
  a.stop();
  b.stop();
});

// ---------- Focus, refresh, config ----------

test('focus union: the leader gets the union of fresh same-config windows, only when it changes; solo gets its own keys', () => {
  const clock = fakeClock();
  const dir = newDir();
  const [a, b, c] = ['a', 'b', 'c'].map((id) => coord(clock, dir, id));
  startAll(clock, a, b, c);
  assert.deepStrictEqual(a.log.unions, [[]], 'called once on becoming leader');
  a.setFocus(['k0']);
  assert.deepStrictEqual(last(a.log.unions), ['k0'], 'own change applies at once');
  b.setFocus(['k1']);
  c.setFocus(['k2', 'k1', 'k2', '', 7]);
  assert.deepStrictEqual(readJ(dir, 'win-c.json').focus, ['k1', 'k2']);
  const n = a.log.unions.length;
  clock.advance(HB);
  assert.deepStrictEqual(a.log.unions.slice(n), [['k0', 'k1', 'k2']]);
  assert.deepStrictEqual(a.focusKeys(), ['k0', 'k1', 'k2']);
  clock.advance(HB * 3);
  assert.strictEqual(a.log.unions.length, n + 1, 'unchanged: not called again');
  // A window with another cfgKey scans for itself and does not add to the union
  const s = coord(clock, dir, 's', { cfgKey: 'k2' });
  s.setFocus(['sx']);
  s.start();
  assert.strictEqual(s.role, ROLES.SOLO);
  assert.deepStrictEqual(s.log.unions, [['sx']]);
  clock.advance(HB);
  assert.deepStrictEqual(last(a.log.unions), ['k0', 'k1', 'k2']);
  // A stale window's keys drop out (c had k1 and k2; b still has k1)
  c.owner.frozen = true;
  clock.advance(STALE + HB);
  assert.deepStrictEqual(last(a.log.unions), ['k0', 'k1']);
  assert.deepStrictEqual([b.log.unions, c.log.unions], [[], []], 'followers never get a union');
  c.owner.frozen = false;
  for (const x of [a, b, c, s]) x.stop();
});

test('refresh request: a follower asks, the leader is called once and its next publish is written even if unchanged', () => {
  const clock = fakeClock();
  const dir = newDir();
  const a = coord(clock, dir, 'a');
  const b = coord(clock, dir, 'b');
  startAll(clock, a, b);
  a.publish(SNAP(1));
  clock.advance(HB);
  assert.strictEqual(b.log.snaps.length, 1);
  assert.strictEqual(b.requestRefresh(), true);
  assert.strictEqual(a.log.refresh, 0);
  clock.advance(HB);
  assert.strictEqual(a.log.refresh, 1);
  clock.advance(HB * 2);
  assert.strictEqual(a.log.refresh, 1, 'one request, one call');
  assert.strictEqual(b.log.refresh, 0);
  assert.strictEqual(a.publish(SNAP(9)), true, 'forced after a refresh request');
  assert.strictEqual(a.publish(SNAP(10)), false, 'only once');
  clock.advance(HB);
  assert.deepStrictEqual(b.log.snaps.map((x) => x.now), [1, 9]);
  // The leader's own request is handled locally at once
  assert.strictEqual(a.requestRefresh(), true);
  assert.strictEqual(a.log.refresh, 2);
  // A new leader does not answer a request made before it led
  a.stop();
  clock.advance(HB + SETTLE);
  assert.strictEqual(b.role, ROLES.LEADER);
  clock.advance(HB);
  assert.strictEqual(b.log.refresh, 0);
  b.stop();
});

test('solo: a different cfgKey neither follows nor claims; a follower waits a grace period before going solo', () => {
  const clock = fakeClock();
  const dir = newDir();
  const a = coord(clock, dir, 'a');
  const b = coord(clock, dir, 'b');
  const c = coord(clock, dir, 'c');
  startAll(clock, a, b, c);
  a.publish(SNAP(1));
  const s = coord(clock, dir, 's', { cfgKey: 'k2' });
  s.start();
  assert.strictEqual(s.role, ROLES.SOLO, 'solo at once when starting');
  clock.advance(HB * 3);
  assert.deepStrictEqual([s.role, readJ(dir, 'leader.json').id, s.log.snaps.length], ['solo', 'a', 0]);
  assert.strictEqual(s.requestRefresh(), true);
  assert.strictEqual(s.log.refresh, 1, 'solo scans itself: refresh handled locally');
  s.setCfgKey('k1');
  assert.strictEqual(s.role, ROLES.FOLLOWER);
  assert.deepStrictEqual(s.log.snaps, [SNAP(1)]);
  // Only this window's config changed: solo after the grace period, and the old key's snapshots are ignored meanwhile
  b.setCfgKey('k3');
  assert.strictEqual(b.role, ROLES.FOLLOWER);
  a.publish(SNAP(2, { quota: { pct: 1 } }));
  clock.advance(HB);
  assert.strictEqual(b.role, ROLES.FOLLOWER, 'within grace');
  assert.strictEqual(b.log.snaps.length, 1);
  clock.advance(HB * 2);
  assert.strictEqual(b.role, ROLES.SOLO);
  // The leader's config changes first, then the follower's within the grace period: the follower never goes solo
  a.setCfgKey('k4');
  assert.strictEqual(readJ(dir, 'leader.json').cfgKey, 'k4');
  clock.advance(HB);
  c.setCfgKey('k4');
  assert.strictEqual(c.role, ROLES.FOLLOWER);
  assert.ok(!c.log.roles.includes('solo'));
  a.publish(SNAP(3, { quota: { pct: 1 } }));
  clock.advance(HB);
  assert.deepStrictEqual(last(c.log.snaps), SNAP(3, { quota: { pct: 1 } }), 'written under the new key although only now changed');
  for (const x of [a, b, c, s]) x.stop();
});

// ---------- Robustness ----------

test('corrupt JSON: damaged leader, snapshot, window and refresh files are tolerated; callbacks that throw do not break it', () => {
  const clock = fakeClock();
  const dir = newDir();
  const w = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  w('leader.json', '{"id":"zz","cfgKey":"k1","be');
  w('snapshot.json', 'not json');
  w('win-bad.json', '{');
  w('win-arr.json', '[1,2,3]');
  const a = coord(clock, dir, 'a');
  const thrown = [];
  const b = coord(clock, dir, 'b', { onSnapshot: (x) => { thrown.push(x); throw new Error('boom'); } });
  startAll(clock, a, b);
  assert.strictEqual(readJ(dir, 'leader.json').id, 'a', 'a damaged leader file counts as missing');
  assert.strictEqual(thrown.length, 0, 'the damaged snapshot was ignored');
  clock.advance(HB);
  assert.ok(!exists(dir, 'win-bad.json') && !exists(dir, 'win-arr.json'), 'the leader sweeps damaged window files');
  w('snapshot.json', '{"leaderId":"a","cfgKey":"k1","snap":{"v":2');
  clock.advance(HB);
  w('snapshot.json', '{"leaderId":"a","cfgKey":"k1","snap":"text"}');
  clock.advance(HB);
  assert.strictEqual(thrown.length, 0);
  assert.strictEqual(a.publish(SNAP(1)), true);
  clock.advance(HB);
  assert.deepStrictEqual(thrown, [SNAP(1)]);
  assert.strictEqual(b.log.errors.length, 1, 'the throw went to onError');
  // A leader file that parses to something else is written back by the leader
  w('leader.json', '[1,2]');
  clock.advance(HB);
  assert.deepStrictEqual([a.role, b.role, readJ(dir, 'leader.json').id], ['leader', 'follower', 'a']);
  w('refresh.json', '\u0000garbage');
  clock.advance(HB);
  assert.strictEqual(a.log.refresh, 1, 'any new refresh content counts as a request');
  // The directory disappears: files are recreated
  fs.rmSync(dir, { recursive: true, force: true });
  clock.advance(HB);
  assert.strictEqual(readJ(dir, 'leader.json').id, 'a');
  assert.ok(exists(dir, 'win-a.json') && exists(dir, 'win-b.json'));
  assert.deepStrictEqual([a.role, b.role], ['leader', 'follower']);
  a.stop();
  b.stop();
});

test('stop: removes my window file, leader.json and the snapshot only if I lead, tmp files and all timers; nothing is called afterwards', () => {
  const clock = fakeClock();
  const dir = newDir();
  const a = coord(clock, dir, 'a');
  const b = coord(clock, dir, 'b');
  startAll(clock, a, b);
  a.publish(SNAP(1));
  clock.advance(HB);
  b.stop();
  assert.ok(!exists(dir, 'win-b.json'));
  assert.strictEqual(readJ(dir, 'leader.json').id, 'a', 'a follower leaves leader.json alone');
  assert.strictEqual(clock.pending(b.owner), 0);
  a.stop();
  assert.strictEqual(clock.pending(a.owner), 0);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'the last snapshot is useless to the next leader\'s followers and is not kept');
  assert.deepStrictEqual([a.role, b.role], [null, null]);
  const before = JSON.stringify([a.log, b.log]);
  clock.advance(HB * 10);
  assert.strictEqual(JSON.stringify([a.log, b.log]), before);
  assert.deepStrictEqual([a.publish(SNAP(2, { quota: 1 })), a.requestRefresh(), b.requestRefresh()], [false, false, false]);
  a.setFocus(['k']);
  a.setWindowFocused(true);
  a.setCfgKey('k9');
  a.setIdleHeartbeatMs(HB * 5);
  a.setCanLead(false);
  a.setCanLead(true);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'setters after stop write nothing');
  // A stopped coordinator can start again
  a.start();
  clock.advance(SETTLE);
  assert.strictEqual(a.role, ROLES.LEADER);
  a.stop();
});

test('anyWindowFocused: this window or any fresh window file; onPresence only on change', () => {
  const clock = fakeClock();
  const dir = newDir();
  const a = coord(clock, dir, 'a');
  const b = coord(clock, dir, 'b');
  startAll(clock, a, b);
  assert.deepStrictEqual([a.log.presence, b.log.presence], [[false], [false]]);
  b.setWindowFocused(true);
  assert.strictEqual(b.anyWindowFocused(), true);
  assert.deepStrictEqual(b.log.presence, [false, true]);
  assert.strictEqual(a.anyWindowFocused(), false, 'seen on the next poll');
  clock.advance(HB);
  assert.strictEqual(a.anyWindowFocused(), true);
  assert.deepStrictEqual(a.log.presence, [false, true]);
  clock.advance(HB * 3);
  assert.deepStrictEqual(a.log.presence, [false, true]);
  b.setWindowFocused(false);
  clock.advance(HB);
  assert.deepStrictEqual([a.anyWindowFocused(), b.anyWindowFocused()], [false, false]);
  assert.deepStrictEqual(a.log.presence, [false, true, false]);
  // A focused window that stops beating no longer counts
  b.setWindowFocused(true);
  clock.advance(HB);
  assert.strictEqual(a.anyWindowFocused(), true);
  b.owner.frozen = true;
  clock.advance(STALE + HB);
  assert.strictEqual(a.anyWindowFocused(), false);
  assert.strictEqual(last(a.log.presence), false);
  a.setWindowFocused(true);
  assert.strictEqual(a.anyWindowFocused(), true);
  b.owner.frozen = false;
  a.stop();
  b.stop();
});

// An fs whose writes fail while fail(path) is true, like a full disk or a read-only folder
function failingFs(fail) {
  return {
    ...fs,
    writeFileSync(p, ...rest) {
      if (fail(String(p))) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return fs.writeFileSync(p, ...rest);
    },
  };
}

test('unwritable folder: a window that cannot write its claim scans alone (solo) and leads once writes work again; followers of a leader that stopped beating do not freeze', () => {
  const clock = fakeClock();
  const dir = newDir();
  let full = true;
  const a = coord(clock, dir, 'a', { fs: failingFs(() => full) });
  a.start();
  assert.strictEqual(a.role, ROLES.SOLO, 'nothing could be written: scan alone');
  assert.deepStrictEqual(a.log.unions, [[]], 'solo gets its focus before it scans');
  clock.advance(HB * 3);
  assert.strictEqual(a.role, ROLES.SOLO);
  assert.ok(a.log.errors.length > 0, 'the failed writes are reported');
  full = false;
  clock.advance(HB + SETTLE);
  assert.strictEqual(a.role, ROLES.LEADER, 'the claim is retried every heartbeat');
  assert.deepStrictEqual(a.log.roles, ['solo', 'leader']);
  a.stop();

  // Leader and follower run, then the disk fills up: the leader keeps scanning, the follower scans alone instead of
  // rendering the leader's last snapshot for good; both settle back once there is space again
  const dir2 = newDir();
  let full2 = false;
  const ffs = failingFs(() => full2);
  const b = coord(clock, dir2, 'b', { fs: ffs });
  const c = coord(clock, dir2, 'c', { fs: ffs });
  startAll(clock, b, c);
  full2 = true;
  clock.advance(STALE + HB * 3 + SETTLE);
  assert.deepStrictEqual([b.role, c.role], ['leader', 'solo']);
  full2 = false;
  clock.advance(HB * 2);
  assert.deepStrictEqual([b.role, c.role], ['leader', 'follower']);
  b.stop();
  c.stop();
});

test('publish failures: after 3 failed snapshot writes in a row leader.json says publishing: false and followers scan alone; the next good write brings them back', () => {
  const clock = fakeClock();
  const dir = newDir();
  let full = false;
  const a = coord(clock, dir, 'a', { fs: failingFs((p) => full && p.includes('snapshot.json')) });
  const b = coord(clock, dir, 'b');
  startAll(clock, a, b);
  assert.strictEqual(a.publish(SNAP(1)), true);
  clock.advance(HB);
  full = true;
  for (let i = 2; i <= 3; i++) assert.strictEqual(a.publish(SNAP(i, { quota: { pct: i } })), false);
  assert.strictEqual(readJ(dir, 'leader.json').publishing, undefined, 'two failures are not enough');
  assert.strictEqual(a.publish(SNAP(4, { quota: { pct: 4 } })), false);
  assert.strictEqual(readJ(dir, 'leader.json').publishing, false);
  clock.advance(HB);
  assert.deepStrictEqual([a.role, b.role], ['leader', 'solo']);
  clock.advance(HB * 3);
  assert.strictEqual(readJ(dir, 'leader.json').publishing, false, 'kept on every heartbeat');
  full = false;
  assert.strictEqual(a.publish(SNAP(5, { quota: { pct: 5 } })), true);
  assert.strictEqual(readJ(dir, 'leader.json').publishing, undefined);
  clock.advance(HB);
  assert.strictEqual(b.role, ROLES.FOLLOWER);
  assert.deepStrictEqual(last(b.log.snaps), SNAP(5, { quota: { pct: 5 } }));
  a.stop();
  b.stop();
});

test('stale snapshot: a follower renders only its current leader\'s snapshots, not a file an earlier leader left behind', () => {
  const clock = fakeClock();
  const dir = newDir();
  // Yesterday's leader crashed and left its last snapshot
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ leaderId: 'old', cfgKey: 'k1', at: 1, snap: SNAP(0) }));
  const a = coord(clock, dir, 'a');
  const b = coord(clock, dir, 'b');
  startAll(clock, a, b);
  clock.advance(HB * 2);
  assert.deepStrictEqual(b.log.snaps, [], 'the old file was rendered');
  assert.strictEqual(a.publish(SNAP(1)), true);
  clock.advance(HB);
  assert.deepStrictEqual(b.log.snaps, [SNAP(1)]);
  // Leadership moves to c, whose first publish lands before b has noticed the new leader: b still reads it
  const c = coord(clock, dir, 'c');
  c.start();
  fs.writeFileSync(path.join(dir, 'leader.json'), JSON.stringify({ id: 'c', cfgKey: 'k1', beat: clock.t, hb: HB }));
  a.stop();
  clock.advance(HB);
  assert.strictEqual(c.role, ROLES.LEADER);
  assert.strictEqual(c.publish(SNAP(2)), true);
  clock.advance(HB);
  assert.deepStrictEqual(b.log.snaps, [SNAP(1), SNAP(2)]);
  b.stop();
  c.stop();
});

test('setCanLead(false): the leader steps down at once and follows the window that takes over; with no leader it waits (role null); true lets it claim again', () => {
  const clock = fakeClock();
  const dir = newDir();
  const a = coord(clock, dir, 'a');
  const b = coord(clock, dir, 'b');
  startAll(clock, a, b);
  a.setCanLead(false);
  assert.strictEqual(a.role, null);
  assert.ok(!exists(dir, 'leader.json'), 'leader.json left behind');
  clock.advance(HB + SETTLE);
  assert.strictEqual(b.role, ROLES.LEADER);
  clock.advance(HB);
  assert.strictEqual(a.role, ROLES.FOLLOWER);
  assert.strictEqual(b.publish(SNAP(1)), true);
  clock.advance(HB);
  assert.deepStrictEqual(a.log.snaps, [SNAP(1)]);
  // The leader leaves: a may not lead, so it waits instead of claiming
  b.stop();
  clock.advance(HB * 3);
  assert.strictEqual(a.role, null);
  assert.ok(!exists(dir, 'leader.json'));
  assert.deepStrictEqual(a.log.roles, ['leader', null, 'follower', null]);
  a.setCanLead(true);
  clock.advance(SETTLE);
  assert.strictEqual(a.role, ROLES.LEADER);
  // A window that may not lead does not go solo either
  const s = coord(clock, dir, 's', { cfgKey: 'k2', canLead: false });
  s.start();
  clock.advance(HB);
  assert.strictEqual(s.role, null);
  a.stop();
  s.stop();
});

test('idle heartbeat: while no window has focus the windows beat every idleHeartbeatMs, announce it in their files and are not taken for gone; focus restores the fast beat', () => {
  const clock = fakeClock();
  const dir = newDir();
  const IDLE = HB * 5;
  const writes = new Map();
  const countFs = {
    ...fs,
    renameSync(from, to) {
      writes.set(path.basename(to), (writes.get(path.basename(to)) || 0) + 1);
      return fs.renameSync(from, to);
    },
  };
  const mk = (id) => coord(clock, dir, id, { fs: countFs, idleHeartbeatMs: IDLE });
  const a = mk('a');
  const b = mk('b');
  a.setWindowFocused(true);
  startAll(clock, a, b);
  writes.clear();
  clock.advance(HB * 10);
  assert.ok(writes.get('win-b.json') >= 9, 'fast while a window has focus');
  a.setWindowFocused(false);
  clock.advance(HB);
  assert.deepStrictEqual([readJ(dir, 'leader.json').hb, readJ(dir, 'win-a.json').hb, readJ(dir, 'win-b.json').hb], [IDLE, IDLE, IDLE]);
  writes.clear();
  clock.advance(IDLE * 4);
  assert.deepStrictEqual([writes.get('win-a.json'), writes.get('win-b.json'), writes.get('leader.json')], [4, 4, 4]);
  // Longer than staleMs between beats, yet nobody took over
  assert.deepStrictEqual([a.role, b.role], ['leader', 'follower']);
  assert.deepStrictEqual(b.log.roles, ['follower']);
  // A slow leader that stops beating is still replaced, after its scaled stale time
  a.owner.frozen = true;
  clock.advance(STALE * 5 + IDLE * 2 + SETTLE);
  assert.strictEqual(b.role, ROLES.LEADER);
  a.owner.frozen = false;
  clock.advance(IDLE);
  assert.strictEqual(a.role, ROLES.FOLLOWER);
  // Focus comes back: fast beats again, announced in the files
  a.setWindowFocused(true);
  assert.strictEqual(readJ(dir, 'win-a.json').hb, HB);
  clock.advance(IDLE);
  assert.strictEqual(readJ(dir, 'leader.json').hb, HB, 'the leader noticed the focus on its next beat');
  a.stop();
  b.stop();
});

test('publish { force }: written even when nothing except now changed', () => {
  const clock = fakeClock();
  const dir = newDir();
  const a = coord(clock, dir, 'a');
  const b = coord(clock, dir, 'b');
  startAll(clock, a, b);
  assert.strictEqual(a.publish(SNAP(1)), true);
  clock.advance(HB);
  assert.strictEqual(a.publish(SNAP(2)), false);
  assert.strictEqual(a.publish(SNAP(3), { force: true }), true);
  clock.advance(HB);
  assert.deepStrictEqual(b.log.snaps.map((x) => x.now), [1, 3]);
  a.stop();
  b.stop();
});

test('fs.watch: with a 60 s heartbeat, a follower still gets snapshots and takes over at once (real timers)', async () => {
  const dir = newDir();
  const mk = (id) => {
    const log = { snaps: [], roles: [] };
    const s = createSharedScan({ dir, windowId: id, cfgKey: 'k1', heartbeatMs: 60e3, staleMs: 180e3, settleMs: 0, debounceMs: 10,
      onSnapshot: (x) => log.snaps.push(x), onRole: (r) => log.roles.push(r) });
    s.log = log;
    return s;
  };
  const a = mk('a');
  const b = mk('b');
  try {
    a.start();
    b.start();
    assert.deepStrictEqual([a.role, b.role], ['leader', 'follower']);
    await new Promise((r) => setTimeout(r, 200)); // macOS FSEvents can miss changes made right after the watch starts
    a.publish(SNAP(1));
    assert.ok(await waitUntil(() => b.log.snaps.length === 1), 'snapshot seen through fs.watch');
    a.stop();
    assert.ok(await waitUntil(() => b.role === ROLES.LEADER), 'took over through fs.watch');
  } finally {
    a.stop();
    b.stop();
  }
});

async function waitUntil(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

// ---------- worker (real thread) ----------

let homeNo = 0;
function makeHome() {
  const home = path.join(TMP, `home-${++homeNo}`);
  const projects = path.join(home, 'projects');
  fs.cpSync(FIX, projects, { recursive: true });
  return { home, projects };
}

function workerCfg(h, extra = {}) {
  return {
    intervalMs: 60000,
    activeWindowMinutes: 1e7, // synthetic data lies in the past: widen the window
    staleMinutes: 5,
    claude: { projectsDir: h.projects, home: h.home, configDir: h.home },
    codex: { enabled: false, home: path.join(TMP, 'no-codex') },
    daily: false,
    ...extra,
  };
}

// Collect worker messages; next(pred) waits for the next matching one, count(pred) counts all seen so far
function messages(w) {
  const seen = [];
  const waiters = [];
  w.on('message', (m) => {
    seen.push(m);
    for (const x of waiters.splice(0)) if (!x.done(m)) waiters.push(x);
  });
  return {
    seen,
    count: (pred) => seen.filter(pred).length,
    next(pred, ms = 30000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a worker message')), ms);
        waiters.push({ done: (m) => { if (!pred(m)) return false; clearTimeout(timer); resolve(m); return true; } });
      });
    },
  };
}

const isSnap = (m) => m.type === 'snapshot';
const isStorage = (m) => m.type === 'storage';

test('worker: interval changes the pace without rebuilding; pause stops scanning and frees the Monitor (storage still answers); resume scans at once', async () => {
  const h = makeHome();
  const w = new Worker(path.join(ROOT, 'lib', 'worker.js'), { workerData: workerCfg(h) });
  const q = messages(w);
  try {
    const first = await q.next(isSnap);
    assert.ok(first.sessions.length > 0);
    w.postMessage({ type: 'storage' });
    const r1 = await q.next(isStorage);
    const ok = !r1.error;
    // A fast pace: several snapshots in quick succession, same Monitor (storage cache survives)
    const n0 = q.count(isSnap);
    w.postMessage({ type: 'interval', ms: 30 });
    for (let i = 0; i < 3; i++) await q.next(isSnap, 5000);
    w.postMessage({ type: 'storage' });
    const r2 = await q.next(isStorage);
    if (ok) assert.strictEqual(r2.cached, true, 'interval did not rebuild the Monitor');
    // Back to cfg.intervalMs (60 s): quiet. The storage reply marks the point after which no snapshot may arrive
    w.postMessage({ type: 'interval', ms: null });
    w.postMessage({ type: 'storage' });
    await q.next(isStorage);
    const n1 = q.count(isSnap);
    assert.ok(n1 - n0 >= 3);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(q.count(isSnap), n1, 'no scans at the 60 s pace');
    // Pause: refresh, focus and config do not scan; storage still answers from a Monitor built afresh (cache lost)
    w.postMessage({ type: 'pause' });
    w.postMessage({ type: 'refresh' });
    w.postMessage({ type: 'focus', keys: [KEY_A] });
    w.postMessage({ type: 'config', cfg: workerCfg(h, { staleMinutes: 6 }) });
    w.postMessage({ type: 'storage' });
    const r3 = await q.next(isStorage);
    if (ok) assert.strictEqual(r3.cached, false, 'pause disposed the Monitor');
    w.postMessage({ type: 'interval', ms: 20 });
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(q.count(isSnap), n1, 'no scans while paused, whatever the interval');
    // Resume: scans at once with the focus sent while paused, then at the 20 ms pace
    w.postMessage({ type: 'resume' });
    const r = await q.next(isSnap, 5000);
    assert.ok(r.details[KEY_A], 'focus received while paused is kept');
    await q.next(isSnap, 5000);
    w.postMessage({ type: 'interval', ms: 0 });
  } finally {
    await w.terminate();
  }
});

test('worker: started with workerData.paused it does not scan until resume, but answers storage', async () => {
  const h = makeHome();
  const w = new Worker(path.join(ROOT, 'lib', 'worker.js'), { workerData: { ...workerCfg(h), paused: true } });
  const q = messages(w);
  try {
    w.postMessage({ type: 'storage' });
    const s = await q.next(isStorage);
    assert.ok(Array.isArray(s.volumes));
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(q.count(isSnap), 0);
    w.postMessage({ type: 'resume' });
    const snap = await q.next(isSnap, 5000);
    assert.strictEqual(snap.v, 2);
    assert.ok(snap.sessions.length > 0);
  } finally {
    await w.terminate();
  }
});

// ---------- Run ----------

(async () => {
  let ok = 0;
  let fail = 0;
  console.log('test/shared-scan.test.js');
  for (const t of tests) {
    try {
      await t.fn();
      ok++;
      console.log(`  ok    ${t.name}`);
    } catch (err) {
      fail++;
      console.log(`  FAIL  ${t.name}\n        ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n        ')}`);
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${ok}/${ok + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})();
