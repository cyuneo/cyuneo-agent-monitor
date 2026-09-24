'use strict';
// Tests for "needs you" notifications: lib/notify.js and the ext.notify.* keys in l10n/views.*.json.
// Plain node: node test/notify.test.js. All sessions are synthetic; ~/.claude and ~/.codex are never read.
// Claim markers go under AGENT_MONITOR_TEST_TMP (system temp dir if unset) and are removed afterwards.
// System notifications only go through a fake execFile; no command is ever executed.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const S = require('../lib/core/status');
const i18nLib = require('../lib/i18n');
const lampLib = require('../lib/lamp');
const notify = require('../lib/notify');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-notify-'));

// ---------- Helpers ----------

const results = [];
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { results.push(true); console.log(`  ok    ${name}`); },
        (err) => fail(name, err)));
      return;
    }
    results.push(true);
    console.log(`  ok    ${name}`);
  } catch (err) {
    fail(name, err);
  }
}
function fail(name, err) {
  results.push(false);
  console.log(`  FAIL  ${name}\n        ${String((err && err.stack) || err).split('\n').slice(0, 5).join('\n        ')}`);
}

const NOW = Date.parse('2026-09-24T10:00:00Z');
const MIN = 60e3;
const HOUR = 3600e3;
const LOCALES = ['en', 'zh-cn', 'zh-tw', 'ko', 'ja'];
const NOTIFY_KEYS = ['ext.notify.title', 'ext.notify.titleProject', 'ext.notify.body', 'ext.notify.bodyAgent', 'ext.notify.toast', 'ext.notify.show'];

const st = (code, sinceMs, extra) => S.makeStatus(code, sinceMs, extra);
function agent(o = {}) {
  return {
    id: 'main', kind: 'main', name: null, agentType: null, phase: null, background: false, model: 'claude-opus-5-5',
    status: st('thinking', NOW - 5000), step: null, startedMs: NOW - HOUR, lastActivityMs: NOW - 5000, mtimeMs: NOW - 5000,
    file: '/synthetic/main.jsonl', ...o,
  };
}
function session(o = {}) {
  const id = o.id || 'aaaaaaaa-1111-2222-3333-444444444444';
  return {
    key: 'claude:' + id, provider: 'claude', id, title: 'Refactor the parser', titleSource: 'ai',
    cwd: '/work/demo-app', projectDir: '-work-demo-app', live: false, liveStatus: null, waitingFor: null,
    startedMs: NOW - HOUR, updatedMs: NOW - 1000, doneAtMs: null, lastActivityMs: NOW - 1000,
    main: agent(), agents: [], workflows: [], ...o,
  };
}
const working = (o) => session({ main: agent({ status: st('tool', NOW - 3000, { pendingTool: 'Bash' }) }), ...o });
const asking = (since, o) => session({ main: agent({ status: st('awaitingInput', since, { question: 'askUser', pendingTool: 'AskUserQuestion' }) }), ...o });
// Tracker fed the same way the extension does: lamps from computeLamps over the same list
const feed = (tracker, sessions) => tracker.update(sessions, lampLib.computeLamps(sessions, { seen: 0 }));

// ---------- Tracker ----------

function trackerTests() {
  test('the first update only seeds: sessions already waiting are not reported, nor while they keep waiting', () => {
    const tr = notify.createNeedsYouTracker();
    const list = [asking(NOW - 10 * MIN), working({ id: 'bbbbbbbb-1111-2222-3333-444444444444' })];
    assert.deepStrictEqual(feed(tr, list), []);
    assert.deepStrictEqual(feed(tr, list), []);
  });

  test('transition into NeedsYou is reported once with key, transitionId, title, project and agentName', () => {
    const tr = notify.createNeedsYouTracker();
    feed(tr, [working()]);
    const out = feed(tr, [asking(NOW)]);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0], {
      key: 'claude:aaaaaaaa-1111-2222-3333-444444444444',
      transitionId: `claude:aaaaaaaa-1111-2222-3333-444444444444|main|${NOW}`,
      title: 'Refactor the parser', project: 'demo-app', agentName: null,
    });
    assert.deepStrictEqual(feed(tr, [asking(NOW)]), [], 'no second report while it stays waiting');
    assert.deepStrictEqual(feed(tr, [asking(NOW)]), []);
  });

  test('leaving NeedsYou and coming back reports again; a flicker of the same wait does not', () => {
    const tr = notify.createNeedsYouTracker();
    feed(tr, [working()]);
    const a = feed(tr, [asking(NOW)]);
    assert.deepStrictEqual(feed(tr, [working()]), []);
    const b = feed(tr, [asking(NOW + 2 * MIN)]);
    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 1);
    assert.notStrictEqual(a[0].transitionId, b[0].transitionId);
    feed(tr, [working()]);
    assert.deepStrictEqual(feed(tr, [asking(NOW + 2 * MIN)]), [], 'same wait (same transitionId) is not reported twice');
  });

  test('a waiting subagent names the agent; registry waiting uses the registry time; new sessions after seeding are reported', () => {
    const tr = notify.createNeedsYouTracker();
    feed(tr, []);
    const sub = agent({ id: 'agent-7f3a', kind: 'subagent', name: 'code-reviewer', agentType: 'Explore', status: st('awaitingApproval', NOW - 4000, { pendingTool: 'Bash' }) });
    const s1 = session({ agents: [sub], main: agent({ status: st('tool', NOW - 9000, { pendingTool: 'Agent' }) }) });
    const out = feed(tr, [s1]);
    assert.strictEqual(out.length, 1, 'new session already waiting after seeding');
    assert.strictEqual(out[0].agentName, 'code-reviewer');
    assert.strictEqual(out[0].transitionId, `${s1.key}|a/agent-7f3a|${NOW - 4000}`);
    const L = lampLib.sessionLamps(s1);
    assert.strictEqual(notify.transitionIdOf(s1, L), out[0].transitionId, 'the extension re-checks a wait by this id');
    assert.deepStrictEqual(notify.itemFor(s1, L), out[0]);

    // Live Claude session: the registry says waiting; the time comes from the registry-corrected status
    const id2 = 'cccccccc-1111-2222-3333-444444444444';
    const tr2 = notify.createNeedsYouTracker();
    const busy = session({ id: id2, cwd: 'C:\\work\\win-app\\', live: true, liveStatus: 'busy' });
    feed(tr2, [busy]);
    const waiting = session({
      id: id2, cwd: 'C:\\work\\win-app\\', live: true, liveStatus: 'waiting', waitingFor: 'permission prompt',
      main: agent({ status: st('awaitingApproval', NOW - 1500, { waitingFor: 'permission prompt', pendingTool: 'Bash' }) }),
    });
    const o2 = feed(tr2, [waiting]);
    assert.strictEqual(o2.length, 1);
    assert.strictEqual(o2[0].transitionId, `claude:${id2}|main|${NOW - 1500}`);
    assert.strictEqual(o2[0].project, 'win-app', 'Windows paths and trailing separators');
    assert.strictEqual(o2[0].agentName, null);
  });

  test('lamps may be omitted, or given as the bySession Map; bad input returns [] without seeding', () => {
    const tr = notify.createNeedsYouTracker();
    assert.deepStrictEqual(tr.update(undefined), []);
    assert.deepStrictEqual(tr.update(null, null), []);
    assert.deepStrictEqual(tr.update([asking(NOW - MIN)]), [], 'first real list seeds');
    assert.deepStrictEqual(tr.update([working()]), []);
    const list = [asking(NOW)];
    const out = tr.update(list, lampLib.computeLamps(list).bySession);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(tr.update([null, { key: 5 }, asking(NOW)]), []);
  });

  test('transitionId is stable across two trackers (windows) fed the same data at different times', () => {
    const a = notify.createNeedsYouTracker();
    const b = notify.createNeedsYouTracker();
    const realNow = Date.now;
    try {
      feed(a, [working()]);
      const ia = feed(a, [asking(NOW - 20e3)]);
      Date.now = () => realNow() + 7 * MIN; // the second window ticks later; the id must not depend on the clock
      feed(b, [working(), working({ id: 'dddddddd-1111-2222-3333-444444444444' })]);
      const ib = feed(b, [asking(NOW - 20e3), working({ id: 'dddddddd-1111-2222-3333-444444444444' })]);
      assert.strictEqual(ia.length, 1);
      assert.strictEqual(ib.length, 1);
      assert.strictEqual(ia[0].transitionId, ib[0].transitionId);
      // Computed without lamps gives the same id too
      const c = notify.createNeedsYouTracker();
      c.update([working()]);
      assert.strictEqual(c.update([asking(NOW - 20e3)])[0].transitionId, ia[0].transitionId);
    } finally {
      Date.now = realNow;
    }
  });
}

// ---------- Cross-window claim ----------

function claimTests() {
  test('claimOnce: only the first caller wins; different transitions are independent; marker name is a hash', () => {
    const dir = path.join(TMP, 'claims-a', 'nested');
    const id = 'claude:aaaa|main|1790000000000';
    assert.strictEqual(notify.claimOnce(dir, id, NOW), true, 'creates the directory and wins');
    assert.strictEqual(notify.claimOnce(dir, id, NOW + 10), false, 'second window loses');
    assert.strictEqual(notify.claimOnce(dir, id, NOW + 20), false);
    assert.strictEqual(notify.claimOnce(dir, 'claude:aaaa|main|1790000060000', NOW), true);
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.claim'));
    assert.strictEqual(names.length, 2);
    for (const n of names) assert.match(n, /^[0-9a-f]{40}\.claim$/);
    assert.ok(names.includes(notify.markerName(id)));
    assert.ok(!names.some((n) => n.includes('claude')), 'the id never appears in the file name');
  });

  test('claimOnce prunes markers older than 24 h, at most once an hour, and leaves other files alone', () => {
    const dir = path.join(TMP, 'claims-prune');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const mk = (id, ageMs) => {
      const p = path.join(dir, notify.markerName(id));
      fs.writeFileSync(p, '0');
      const t = (now - ageMs) / 1000;
      fs.utimesSync(p, t, t);
      return p;
    };
    const old = mk('old', 25 * HOUR);
    const fresh = mk('fresh', 23 * HOUR);
    const other = path.join(dir, 'notes.txt');
    fs.writeFileSync(other, 'keep');
    fs.utimesSync(other, (now - 48 * HOUR) / 1000, (now - 48 * HOUR) / 1000);
    assert.strictEqual(notify.claimOnce(dir, 'x1', now), true);
    assert.ok(!fs.existsSync(old), 'old marker removed');
    assert.ok(fs.existsSync(fresh), 'fresh marker kept');
    assert.ok(fs.existsSync(other), 'files that are not markers are never touched');
    assert.strictEqual(notify.claimOnce(dir, 'fresh', now), false, 'a kept marker still blocks');

    // Within the hour: no second pass even though another marker has aged
    const old2 = mk('old2', 30 * HOUR);
    assert.strictEqual(notify.claimOnce(dir, 'x2', now + 30 * MIN), true);
    assert.ok(fs.existsSync(old2), 'not pruned again within an hour');
    assert.strictEqual(notify.claimOnce(dir, 'x3', now + 61 * MIN), true);
    assert.ok(!fs.existsSync(old2), 'pruned again after an hour');
  });

  test('sharedClaimDir: a private folder under the temp dir that every VS Code-family app shares; refused when someone else could have made or opened it', () => {
    const base = path.join(TMP, 'claim-base');
    const dir = notify.sharedClaimDir({ base, uid: 501, fs: { ...fs, lstatSync: (p) => ({ ...fs.lstatSync(p), uid: 501, isDirectory: () => fs.lstatSync(p).isDirectory() }) } });
    assert.strictEqual(dir, path.join(base, 'cyuneo-agent-monitor-501', 'notify'));
    assert.ok(fs.statSync(dir).isDirectory());
    // two apps (two calls) get the same folder, so a claim by one blocks the other
    const again = notify.sharedClaimDir({ base, uid: 501, fs: { ...fs, lstatSync: (p) => ({ ...fs.lstatSync(p), uid: 501, isDirectory: () => fs.lstatSync(p).isDirectory() }) } });
    assert.strictEqual(again, dir);
    assert.strictEqual(notify.claimOnce(dir, 'shared-id', NOW), true);
    assert.strictEqual(notify.claimOnce(again, 'shared-id', NOW), false);
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(path.dirname(dir)).mode & 0o077, 0, 'the folder is closed to other users');
      const own = notify.sharedClaimDir({ base });
      assert.strictEqual(own, path.join(base, `cyuneo-agent-monitor-${process.getuid()}`, 'notify'));
      // another user's folder
      const stranger = { ...fs, lstatSync: (p) => ({ ...fs.lstatSync(p), uid: process.getuid() + 1, isDirectory: () => true, mode: 0o40700 }) };
      assert.strictEqual(notify.sharedClaimDir({ base, fs: stranger }), null);
      // a folder others can write that cannot be closed
      const open = { ...fs, chmodSync() {}, lstatSync: (p) => ({ ...fs.lstatSync(p), mode: 0o40777 }) };
      assert.strictEqual(notify.sharedClaimDir({ base, fs: open }), null);
      // a symlink planted where the folder should be
      const planted = path.join(TMP, 'claim-planted');
      fs.mkdirSync(path.join(planted, 'target'), { recursive: true });
      fs.symlinkSync(path.join(planted, 'target'), path.join(planted, `cyuneo-agent-monitor-${process.getuid()}`));
      assert.strictEqual(notify.sharedClaimDir({ base: planted }), null);
    }
    // a file in the way
    const blocked = path.join(TMP, 'claim-blocked');
    fs.mkdirSync(blocked, { recursive: true });
    fs.writeFileSync(path.join(blocked, 'cyuneo-agent-monitor-7'), 'x');
    assert.strictEqual(notify.sharedClaimDir({ base: blocked, uid: 7 }), null);
  });

  test('claimOnce never throws: EEXIST → false, other errors fail open → true', () => {
    const exist = Object.assign(new Error('exists'), { code: 'EEXIST' });
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const boom = () => { throw denied; };
    const fake = (openErr) => ({
      mkdirSync: boom, readFileSync: boom, writeFileSync: boom, readdirSync: boom, statSync: boom, unlinkSync: boom,
      openSync: () => { throw openErr; }, writeSync: boom, closeSync: boom,
    });
    assert.strictEqual(notify.claimOnce('/synthetic/dir', 'id', NOW, fake(exist)), false);
    assert.strictEqual(notify.claimOnce('/synthetic/dir', 'id', NOW, fake(denied)), true);
    let wrote = null;
    const ok = { ...fake(null), openSync: () => 7, writeSync: (fd, s) => { wrote = [fd, s]; }, closeSync: () => {} };
    assert.strictEqual(notify.claimOnce('/synthetic/dir', 'id', NOW, ok), true);
    assert.deepStrictEqual(wrote, [7, String(NOW)]);
    assert.strictEqual(notify.claimOnce(undefined, 'id', NOW), true);
    assert.strictEqual(notify.claimOnce('', 'id', NOW), true);
  });
}

// ---------- System notification ----------

function fakeExec(result) {
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    if (result === 'hang') return {};
    if (result === 'throw') throw new Error('spawn failed');
    setImmediate(() => cb(result || null, '', ''));
    return { on() {} };
  };
  fn.calls = calls;
  return fn;
}

function systemTests() {
  test('darwin: osascript with a fixed script; title and body only as separate argv after --, no shell', async () => {
    const exec = fakeExec(null);
    const title = 'Agent "needs" you\nend tell\ndo shell script "rm -rf ~"';
    const body = '-e evil \u0007 body\twith\r\ncontrols \u202eoverride';
    assert.strictEqual(await notify.sendSystemNotification({ title, body }, { platform: 'darwin', execFile: exec }), true);
    assert.strictEqual(exec.calls.length, 1);
    const { cmd, args, opts } = exec.calls[0];
    assert.strictEqual(cmd, 'osascript');
    assert.deepStrictEqual(args.slice(0, 7), ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', '--']);
    assert.strictEqual(args.length, 9, 'exactly two user argv items');
    assert.strictEqual(args[7], 'Agent "needs" you end tell do shell script "rm -rf ~"', 'quotes kept, newlines flattened, still one argv item');
    assert.strictEqual(args[8], '-e evil body with controls override');
    assert.ok(!/[\u0000-\u001f\u007f\u202e]/.test(args[7] + args[8]), 'no control characters');
    assert.ok(!opts.shell, 'no shell');
    assert.ok(opts.timeout >= 4000 && opts.timeout <= 6000, 'about 5 s timeout');
  });

  test('long text is truncated; an empty title falls back to the app name', async () => {
    const exec = fakeExec(null);
    await notify.sendSystemNotification({ title: '', body: '字'.repeat(500) }, { platform: 'darwin', execFile: exec });
    const args = exec.calls[0].args;
    assert.strictEqual(args[7], notify.APP_NAME);
    assert.ok(Array.from(args[8]).length <= 200 && args[8].endsWith('…'), args[8].length);
    assert.strictEqual(notify.cleanText('😀'.repeat(10), 5), '😀😀😀😀…', 'no split surrogate pairs');
  });

  test('linux: notify-send with --app-name; missing command or failure → false', async () => {
    const exec = fakeExec(null);
    assert.strictEqual(await notify.sendSystemNotification({ title: 'T', body: 'B' }, { platform: 'linux', execFile: exec }), true);
    assert.strictEqual(exec.calls[0].cmd, 'notify-send');
    assert.deepStrictEqual(exec.calls[0].args, ['--app-name', 'CYUNEO Agent Monitor', '--', 'T', 'B']);
    const missing = fakeExec(Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' }));
    assert.strictEqual(await notify.sendSystemNotification({ title: 'T', body: 'B' }, { platform: 'linux', execFile: missing }), false);
    const thrown = fakeExec('throw');
    assert.strictEqual(await notify.sendSystemNotification({ title: 'T', body: 'B' }, { platform: 'linux', execFile: thrown }), false);
  });

  test('linux: the body is escaped for daemons that parse markup (<b>, <a href>, entities); the summary stays plain text', async () => {
    const exec = fakeExec(null);
    const body = 'Fix Vec<String> & <a href="https://x">here</a>';
    await notify.sendSystemNotification({ title: 'A & <B>', body }, { platform: 'linux', execFile: exec });
    assert.deepStrictEqual(exec.calls[0].args.slice(-2), ['A & <B>', 'Fix Vec&lt;String&gt; &amp; &lt;a href="https://x"&gt;here&lt;/a&gt;']);
    const mac = fakeExec(null);
    await notify.sendSystemNotification({ title: 'T', body }, { platform: 'darwin', execFile: mac });
    assert.strictEqual(mac.calls[0].args[mac.calls[0].args.length - 1], body, 'osascript shows plain text: nothing to escape');
    assert.deepStrictEqual(['darwin', 'linux', 'win32', 'freebsd'].map((p) => notify.hasSystemNotifier(p)), [true, true, false, false]);
  });

  test('win32 and other platforms resolve false without running anything; a hung command times out to false', async () => {
    for (const platform of ['win32', 'freebsd', 'aix']) {
      const exec = fakeExec(null);
      assert.strictEqual(await notify.sendSystemNotification({ title: 'T', body: 'B' }, { platform, execFile: exec }), false, platform);
      assert.strictEqual(exec.calls.length, 0, platform);
    }
    const hang = fakeExec('hang');
    const t0 = Date.now();
    assert.strictEqual(await notify.sendSystemNotification({ title: 'T', body: 'B' }, { platform: 'darwin', execFile: hang, timeoutMs: 20 }), false);
    assert.ok(Date.now() - t0 < 3000);
    assert.strictEqual(await notify.sendSystemNotification(null, { platform: 'darwin', execFile: fakeExec(null) }), true, 'null message still never throws');
  });
}

// ---------- Plan ----------

function planTests() {
  test('plan: disabled → none; focused → toast; unfocused → claimLater', () => {
    assert.strictEqual(notify.plan({ enabled: false, windowFocused: true }), 'none');
    assert.strictEqual(notify.plan({ enabled: false, windowFocused: false }), 'none');
    assert.strictEqual(notify.plan({ enabled: true, windowFocused: true }), 'toast');
    assert.strictEqual(notify.plan({ enabled: true, windowFocused: false }), 'claimLater');
    assert.strictEqual(notify.plan(), 'none');
    assert.strictEqual(notify.plan(null), 'none');
    assert.ok(notify.CLAIM_DELAY_MS >= 2000 && notify.CLAIM_DELAY_MS <= 3000);
  });

  test('flow: the focused window claims first, so exactly one notification across windows', async () => {
    const dir = path.join(TMP, 'claims-flow');
    const shown = [];
    const windows = [{ name: 'A', focused: false }, { name: 'B', focused: true }, { name: 'C', focused: false }];
    const item = { transitionId: 'claude:flow|main|' + NOW };
    const jobs = windows.map(async (w) => {
      const p = notify.plan({ enabled: true, windowFocused: w.focused });
      if (p === 'claimLater') await new Promise((r) => setTimeout(r, 30)); // stands in for CLAIM_DELAY_MS
      if (p !== 'none' && notify.claimOnce(dir, item.transitionId, Date.now())) shown.push(w.name + ':' + p);
    });
    await Promise.all(jobs);
    assert.deepStrictEqual(shown, ['B:toast']);
  });
}

// ---------- Format ----------

function formatTests() {
  const item = { key: 'claude:x', transitionId: 'claude:x|main|1', title: 'Refactor the parser', project: 'demo-app', agentName: null };

  test('format in English: main agent, subagent, no project', () => {
    const i18n = i18nLib.createI18n('en');
    const m = notify.formatNeedsYou(item, i18n.t);
    assert.deepStrictEqual(m, {
      title: 'Agent needs you · demo-app',
      body: 'Refactor the parser is waiting for your reply or approval',
      toast: 'Agent needs you · demo-app: Refactor the parser is waiting for your reply or approval',
    });
    const s = notify.formatNeedsYou({ ...item, project: null, agentName: 'code-reviewer' }, i18n);
    assert.strictEqual(s.title, 'Agent needs you');
    assert.strictEqual(s.body, 'Refactor the parser · code-reviewer is waiting for your reply or approval');
    assert.strictEqual(i18n.t('ext.notify.show'), 'Show');
  });

  test('format in Simplified Chinese; long or multi-line titles are cleaned and clipped', () => {
    const i18n = i18nLib.createI18n('zh-cn');
    const m = notify.formatNeedsYou({ ...item, agentName: 'code-reviewer' }, (k, v) => i18n.t(k, v));
    assert.deepStrictEqual(m, {
      title: '智能体需要你 · demo-app',
      body: 'Refactor the parser · code-reviewer 正在等你回复或批准',
      toast: '智能体需要你 · demo-app：Refactor the parser · code-reviewer 正在等你回复或批准',
    });
    assert.strictEqual(i18n.t('ext.notify.show'), '查看');
    const long = notify.formatNeedsYou({ ...item, title: '第一行\n' + '很长'.repeat(80) }, i18n);
    assert.ok(!long.body.includes('\n'));
    assert.ok(long.body.startsWith('第一行 很长'), long.body);
    assert.ok(long.body.includes('…'));
  });

  test('toast: link syntax in a chat title, project or agent name is broken, so VS Code never renders it as a clickable link', () => {
    const i18n = i18nLib.createI18n('en');
    const evil = '[Show](command:workbench.action.reloadWindow)';
    const m = notify.formatNeedsYou({ ...item, title: evil, project: '[p](https://x.test)', agentName: '[a] (file:///etc)' }, i18n);
    assert.ok(!/\]\s*\(/.test(m.toast), m.toast);
    assert.ok(m.toast.includes('[Show]\u200b(command:workbench.action.reloadWindow)'), 'the text itself is kept');
    assert.strictEqual(m.body, `${evil} · [a] (file:///etc) is waiting for your reply or approval`, 'the system notification text is unchanged');
  });

  test('ext.notify.* keys exist in all five languages with the same placeholders', () => {
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'views.en.json'), 'utf8'));
    const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const loc of LOCALES) {
      const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', `views.${loc}.json`), 'utf8'));
      for (const k of NOTIFY_KEYS) {
        assert.ok(typeof d[k] === 'string' && d[k].trim(), `${loc} ${k}`);
        assert.strictEqual(ph(d[k]), ph(en[k]), `${loc} ${k} placeholders`);
      }
      const i18n = i18nLib.createI18n(loc);
      const m = notify.formatNeedsYou({ ...item, agentName: 'helper' }, i18n);
      for (const v of Object.values(m)) assert.ok(v && !/\{\w+\}/.test(v) && !v.includes('ext.notify'), `${loc}: ${v}`);
      if (loc !== 'en') assert.notStrictEqual(m.title, 'Agent needs you · demo-app', `${loc} is translated`);
    }
  });
}

// ---------- Run ----------

console.log('tracker');
trackerTests();
console.log('claim');
claimTests();
console.log('system notification');
systemTests();
console.log('plan');
planTests();
console.log('format');
formatTests();

Promise.all(pending).then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
});
