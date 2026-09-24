'use strict';
// Tests for sounds, quiet hours and threshold alerts: lib/alerts.js and l10n/alerts.*.json.
// Plain node: node test/alerts.test.js. All sessions, quota snapshots and daily totals are synthetic; ~/.claude and
// ~/.codex are never read. Sounds only go through a fake execFile; no command is ever executed.
// Debounce claim markers go under AGENT_MONITOR_TEST_TMP (system temp dir if unset) and are removed afterwards.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Safety net: a call that forgets to inject execFile must never reach a real process
const childProcess = require('child_process');
let realSpawns = 0;
childProcess.execFile = () => { realSpawns++; throw new Error('tests never spawn processes'); };
const i18nLib = require('../lib/i18n');
const alerts = require('../lib/alerts');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-alerts-'));

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
const SEC = 1000;
const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const LOCALES = ['en', 'zh-cn', 'zh-tw', 'ko', 'ja'];

/**
 * Fake execFile: records calls; behaviors[i] decides call i: 'ok' (default), 'fail' (non-zero exit), 'throw' (spawn
 * throws), 'error' (the child emits 'error'), 'hang' (never calls back).
 */
function fakeExec(behaviors = []) {
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    const b = behaviors[calls.length] || 'ok';
    calls.push({ cmd, args, opts });
    if (b === 'throw') throw new Error('spawn failed');
    if (b === 'hang') return { on() {} };
    const listeners = {};
    if (b === 'error') setImmediate(() => listeners.error && listeners.error(new Error('ENOENT')));
    else setImmediate(() => cb(b === 'ok' ? null : Object.assign(new Error('exit 1'), { code: 1 })));
    return { on: (ev, f) => { listeners[ev] = f; } };
  };
  fn.calls = calls;
  return fn;
}

/** Runs fn with process.env.TZ set to tz, then restores it */
function withTz(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

/** Local wall-clock instant (whatever time zone this process runs in) */
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const localMidnight = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const ws = (s) => String(s).replace(/\s+/g, ' ');

function quotaOf(windows) {
  return {
    claude: { lastHit: null },
    codex: { observedMs: NOW, planType: 'plus', limitId: null, windows, reachedType: null, credits: null },
  };
}
const w5h = (usedPct, resetsAtMs) => ({ minutes: 300, usedPct, resetsAtMs, label: '5h' });
const wWeek = (usedPct, resetsAtMs) => ({ minutes: 10080, usedPct, resetsAtMs, label: 'weekly' });
function todayOf(claudeCost, codexCost, o = {}) {
  return {
    dayStartMs: localMidnight(o.now || NOW), partial: false, progress: 1,
    claude: { costUsd: claudeCost }, codex: { costUsd: codexCost }, ...o,
  };
}
function session(o = {}) {
  const id = o.id || 'aaaaaaaa-1111-2222-3333-444444444444';
  const provider = o.provider || 'claude';
  return {
    key: `${provider}:${id}`, provider, id, title: 'Fix login bug', titleSource: 'ai', cwd: '/synthetic/work/demo-app',
    updatedMs: NOW - 5 * SEC, contextUsed: 100000, compactAt: 167000, contextPct: 50, compactCount: 0,
    main: { tokens: { toCompact: 67000 }, lastCompact: null },
    ...o,
  };
}
const CFG = { usagePercent: 90, dailyCost: 10, contextPercent: 80 };

// ---------- Sounds ----------

function soundTests() {
  test('macOS: afplay plays a built-in sound file, no shell, about 5 s timeout', async () => {
    const exec = fakeExec();
    const ok = await alerts.playSound('needsYou', { platform: 'darwin', execFile: exec, debounce: false });
    assert.strictEqual(ok, true);
    assert.strictEqual(exec.calls.length, 1);
    const c = exec.calls[0];
    assert.strictEqual(c.cmd, 'afplay');
    assert.deepStrictEqual(c.args, ['/System/Library/Sounds/Glass.aiff']);
    assert.strictEqual(c.opts.shell, false);
    assert.ok(c.opts.timeout > 4000 && c.opts.timeout <= 5000, String(c.opts.timeout));
  });

  test('per-event defaults (needsYou Glass, error Basso, done Hero, alert Funk); a chosen name wins, in any case', async () => {
    const exec = fakeExec();
    for (const ev of ['needsYou', 'error', 'done', 'alert']) {
      await alerts.playSound(ev, { platform: 'darwin', execFile: exec, debounce: false, sound: 'default' });
    }
    await alerts.playSound('needsYou', { platform: 'darwin', execFile: exec, debounce: false, sound: 'submarine' });
    await alerts.playSound('error', { platform: 'darwin', execFile: exec, debounce: false, sound: 'PING' });
    assert.deepStrictEqual(exec.calls.map((c) => path.basename(c.args[0])),
      ['Glass.aiff', 'Basso.aiff', 'Hero.aiff', 'Funk.aiff', 'Submarine.aiff', 'Ping.aiff']);
    assert.deepStrictEqual(alerts.DEFAULT_SOUNDS, { needsYou: 'Glass', error: 'Basso', done: 'Hero', alert: 'Funk' });
    assert.deepStrictEqual([...alerts.SOUND_CHOICES].slice(0, 2), ['default', 'off']);
    for (const n of alerts.SOUND_NAMES) assert.ok(fs.existsSync(`/System/Library/Sounds/${n}.aiff`) || process.platform !== 'darwin', n);
  });

  test('"off", unknown names, paths and prototype names never run a command', async () => {
    const exec = fakeExec();
    const bad = ['off', 'none', false, '../../../etc/passwd', '/System/Library/Sounds/Glass.aiff', 'Glass.aiff',
      'Glass; say hi', '$(say hi)', 'Glass\n', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 42, {}, ['Glass']];
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const sound of bad) {
        assert.strictEqual(await alerts.playSound('needsYou', { platform, execFile: exec, debounce: false, sound }), false,
          `${platform} ${JSON.stringify(sound)}`);
      }
    }
    assert.strictEqual(await alerts.playSound('unknownEvent', { platform: 'darwin', execFile: exec, debounce: false }), false);
    assert.strictEqual(exec.calls.length, 0);
    for (const name of ['__proto__', 'constructor', '../Glass', 'glass']) assert.deepStrictEqual(alerts.soundCommands('darwin', name), []);
  });

  test('every command argument comes from the fixed table (no user text can reach a command line)', () => {
    const env = { SystemRoot: 'C:\\Windows' };
    for (const name of alerts.SOUND_NAMES) {
      for (const platform of ['darwin', 'linux', 'win32']) {
        const cmds = alerts.soundCommands(platform, name, env);
        assert.ok(cmds.length >= 1, `${platform} ${name}`);
        for (const c of cmds) {
          for (const a of c.args) assert.ok(a === alerts.WIN_SCRIPT || /^[A-Za-z0-9 ./=_-]+$/.test(a), `${platform} ${name}: ${a}`);
        }
      }
    }
    assert.deepStrictEqual(alerts.soundCommands('aix', 'Glass'), []);
  });

  test('Linux: canberra-gtk-play by freedesktop id first, then paplay with the .oga file', async () => {
    const exec = fakeExec(['fail', 'ok']);
    const ok = await alerts.playSound('needsYou', { platform: 'linux', execFile: exec, debounce: false });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(exec.calls.map((c) => [c.cmd, c.args]), [
      ['canberra-gtk-play', ['--id=message-new-instant']],
      ['paplay', ['/usr/share/sounds/freedesktop/stereo/message-new-instant.oga']],
    ]);
    const exec2 = fakeExec(['ok']);
    assert.strictEqual(await alerts.playSound('error', { platform: 'linux', execFile: exec2, debounce: false }), true);
    assert.deepStrictEqual(exec2.calls.map((c) => c.args[0]), ['--id=dialog-warning']);
    const exec3 = fakeExec(['error', 'fail']);
    assert.strictEqual(await alerts.playSound('done', { platform: 'linux', execFile: exec3, debounce: false }), false);
    assert.strictEqual(exec3.calls.length, 2);
  });

  test('Windows: a fixed PowerShell script; the file under %SystemRoot%\\Media only travels in an environment variable', async () => {
    const exec = fakeExec();
    const env = { SystemRoot: 'D:\\Win', PATH: 'x' };
    assert.strictEqual(await alerts.playSound('done', { platform: 'win32', execFile: exec, debounce: false, env }), true);
    const c = exec.calls[0];
    assert.strictEqual(c.cmd, 'powershell.exe');
    assert.deepStrictEqual(c.args, ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', alerts.WIN_SCRIPT]);
    assert.strictEqual(c.opts.env[alerts.WIN_SOUND_ENV], 'D:\\Win\\Media\\tada.wav');
    assert.strictEqual(c.opts.env.PATH, 'x');
    assert.strictEqual(c.opts.shell, false);
    assert.strictEqual(c.opts.windowsHide, true);
    assert.ok(/PlaySync\(\)/.test(alerts.WIN_SCRIPT) && alerts.WIN_SCRIPT.includes(`$env:${alerts.WIN_SOUND_ENV}`));
    // The script is the same for every sound: nothing about the sound is ever put into it
    const scripts = new Set(alerts.SOUND_NAMES.map((n) => alerts.soundCommands('win32', n, env)[0].args.join(' ')));
    assert.strictEqual(scripts.size, 1);
    assert.ok(alerts.soundCommands('win32', 'Glass', {})[0].env[alerts.WIN_SOUND_ENV].startsWith('C:\\Windows\\Media\\'));
  });

  test('unsupported platform, a spawn that throws, an error event or a failing command → false, never a throw', async () => {
    assert.strictEqual(await alerts.playSound('needsYou', { platform: 'aix', execFile: fakeExec(), debounce: false }), false);
    assert.strictEqual(await alerts.playSound('needsYou', { platform: 'darwin', execFile: fakeExec(['throw']), debounce: false }), false);
    assert.strictEqual(await alerts.playSound('needsYou', { platform: 'darwin', execFile: fakeExec(['error']), debounce: false }), false);
    assert.strictEqual(await alerts.playSound('needsYou', { platform: 'darwin', execFile: fakeExec(['fail']), debounce: false }), false);
    assert.strictEqual(await alerts.playSound(undefined, { platform: 'darwin', execFile: fakeExec(), debounce: false }), false);
    // Without an injected execFile the module uses child_process.execFile (stubbed above): still false, no throw
    assert.strictEqual(await alerts.playSound('needsYou', { platform: 'darwin', debounce: false }), false);
    assert.strictEqual(realSpawns, 1);
  });

  test('a command that never returns resolves false after the timeout', async () => {
    const t0 = Date.now();
    const exec = fakeExec(['hang']);
    const ok = await alerts.playSound('needsYou', { platform: 'darwin', execFile: exec, debounce: false, timeoutMs: 20 });
    assert.strictEqual(ok, false);
    assert.strictEqual(exec.calls[0].opts.timeout <= 20, true);
    assert.ok(Date.now() - t0 < 3000);
  });

  test('soundEventOf: threshold alerts play "alert", a usage-limit hit plays "error"', () => {
    assert.strictEqual(alerts.soundEventOf('needsYou'), 'needsYou');
    assert.strictEqual(alerts.soundEventOf('error'), 'error');
    assert.strictEqual(alerts.soundEventOf('done'), 'done');
    assert.strictEqual(alerts.soundEventOf('limitHit'), 'error');
    for (const t of alerts.ALERT_TYPES) assert.strictEqual(alerts.soundEventOf(t), 'alert');
    assert.strictEqual(alerts.soundEventOf('limitReset'), null);
  });

  test('debounce without a shared dir: at most one sound per 3 s in this process', () => {
    const T = NOW + 1000 * DAY;
    assert.strictEqual(alerts.claimSoundSlot(null, T), true);
    assert.strictEqual(alerts.claimSoundSlot(null, T + 1000), false);
    assert.strictEqual(alerts.claimSoundSlot(null, T + 2999), false);
    assert.strictEqual(alerts.claimSoundSlot(null, T + 3000), true);
  });

  test('debounce across windows: one claim per 3 s through the shared dir, also across a bucket edge', () => {
    const dir = path.join(TMP, 'claims-a');
    const G = alerts.SOUND_GAP_MS;
    const T = Math.floor(NOW / G) * G + 2900; // 100 ms before a bucket edge
    assert.strictEqual(alerts.claimSoundSlot(dir, T), true);        // window A plays
    assert.strictEqual(alerts.claimSoundSlot(dir, T + 50), false);  // window B, same bucket
    assert.strictEqual(alerts.claimSoundSlot(dir, T + 200), false); // next bucket, but only 200 ms after A's sound
    assert.strictEqual(alerts.claimSoundSlot(dir, T + 1500), false); // that bucket is taken
    assert.strictEqual(alerts.claimSoundSlot(dir, T + 3100), true);  // 3.1 s after the last sound actually played
    assert.strictEqual(alerts.claimSoundSlot(dir, T + 3200), false);
    // Far apart: fine again
    assert.strictEqual(alerts.claimSoundSlot(dir, T + 60e3), true);
    // No dir we can write: fails open like notify.claimOnce
    fs.writeFileSync(path.join(TMP, 'file-not-dir'), '');
    assert.strictEqual(alerts.claimSoundSlot(path.join(TMP, 'file-not-dir', 'x'), T), true);
  });

  test('playSound with a shared dir: a burst of events plays one sound; debounce: false (a preview) always plays', async () => {
    const dir = path.join(TMP, 'claims-b');
    const exec = fakeExec();
    const T = NOW + 2000 * DAY;
    const o = { platform: 'darwin', execFile: exec, claimDir: dir };
    const r = [];
    r.push(await alerts.playSound('needsYou', { ...o, now: T }));
    r.push(await alerts.playSound('error', { ...o, now: T + 500 }));
    r.push(await alerts.playSound('alert', { ...o, now: T + 2500 }));
    r.push(await alerts.playSound('done', { ...o, now: T + 4000 }));
    assert.deepStrictEqual(r, [true, false, false, true]);
    assert.deepStrictEqual(exec.calls.map((c) => path.basename(c.args[0])), ['Glass.aiff', 'Hero.aiff']);
    assert.strictEqual(await alerts.playSound('done', { ...o, now: T + 4001, debounce: false }), true);
    // A sound that is off takes no slot
    assert.strictEqual(await alerts.playSound('needsYou', { ...o, now: T + 9000, sound: 'off' }), false);
    assert.strictEqual(await alerts.playSound('needsYou', { ...o, now: T + 9001 }), true);
  });
}

// ---------- Quiet hours ----------

function quietTests() {
  const Q = (start, end, extra) => ({ enabled: true, start, end, ...extra });

  test('disabled, invalid times, start == end or no valid day → off', () => {
    const t = local(2026, 9, 24, 23, 0);
    const offs = [null, undefined, {}, { ...Q('22:00', '07:00'), enabled: false }, Q('25:00', '07:00'), Q('22:00', '7:60'),
      Q('abc', '07:00'), Q('22:00', ''), Q('22', '07'), Q(2200, 700), Q('22:00', '22:00'), Q('00:00', '0:00'),
      Q('22:00', '07:00', { days: ['xyz', 9, -1] }), Q('22:00', '07:00', { days: 'fri' }), { ...Q('22:00', '07:00'), enabled: 'true' }];
    for (const cfg of offs) {
      assert.strictEqual(alerts.isQuiet(t, cfg), false, JSON.stringify(cfg));
      assert.strictEqual(alerts.nextQuietChange(t, cfg), null, JSON.stringify(cfg));
      assert.strictEqual(alerts.quietRule(cfg), null, JSON.stringify(cfg));
    }
    assert.strictEqual(alerts.parseHm('7:05'), 425);
    assert.strictEqual(alerts.parseHm(' 23:59 '), 1439);
    assert.strictEqual(alerts.parseHm('24:00'), null);
  });

  test('same-day range: start inclusive, end exclusive', () => {
    const cfg = Q('13:00', '14:00');
    const at = (h, m) => alerts.isQuiet(local(2026, 9, 24, h, m), cfg);
    assert.deepStrictEqual([at(12, 59), at(13, 0), at(13, 59), at(14, 0), at(0, 0)], [false, true, true, false, false]);
  });

  test('range past midnight: 22:00–07:00', () => {
    const cfg = Q('22:00', '07:00');
    const at = (d, h, m) => alerts.isQuiet(local(2026, 9, d, h, m), cfg);
    assert.deepStrictEqual([at(24, 21, 59), at(24, 22, 0), at(24, 23, 59), at(25, 0, 0), at(25, 6, 59), at(25, 7, 0), at(25, 12, 0)],
      [false, true, true, true, true, false, false]);
    assert.strictEqual(alerts.isQuiet(new Date(local(2026, 9, 25, 3, 0)), cfg), true, 'a Date works too');
  });

  test('days name the day a quiet period starts on (names, full names or numbers)', () => {
    // 2026-09-25 is a Friday
    assert.strictEqual(new Date(local(2026, 9, 25)).getDay(), 5);
    for (const days of [['fri'], ['Friday'], [5], ['FRI', 'nonsense']]) {
      const cfg = Q('22:00', '07:00', { days });
      const at = (d, h) => alerts.isQuiet(local(2026, 9, d, h, 0), cfg);
      assert.deepStrictEqual([at(25, 23), at(26, 6), at(26, 23), at(25, 6), at(24, 23)], [true, true, false, false, false], JSON.stringify(days));
    }
    // Empty list = every day
    assert.strictEqual(alerts.isQuiet(local(2026, 9, 27, 23, 0), Q('22:00', '07:00', { days: [] })), true);
    // Weekday daytime range
    const work = Q('09:00', '17:00', { days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
    assert.strictEqual(alerts.isQuiet(local(2026, 9, 25, 10, 0), work), true);
    assert.strictEqual(alerts.isQuiet(local(2026, 9, 26, 10, 0), work), false);
  });

  test('local wall clock: the same instant is quiet in one time zone and not in another', () => {
    const cfg = Q('22:00', '07:00');
    const instant = Date.parse('2026-09-24T15:00:00Z'); // 00:00 in Seoul, 15:00 in UTC, 08:00 in Los Angeles
    assert.strictEqual(withTz('Asia/Seoul', () => alerts.isQuiet(instant, cfg)), true);
    assert.strictEqual(withTz('UTC', () => alerts.isQuiet(instant, cfg)), false);
    assert.strictEqual(withTz('America/Los_Angeles', () => alerts.isQuiet(instant, cfg)), false);
    const offset = new Date(2026, 0, 1).getTimezoneOffset();
    withTz('Asia/Kolkata', () => assert.strictEqual(new Date(2026, 0, 1).getTimezoneOffset(), -330));
    assert.strictEqual(new Date(2026, 0, 1).getTimezoneOffset(), offset, 'TZ restored');
  });

  test('DST: boundaries follow the wall clock; one inside the spring-forward gap moves to the end of the gap', () => {
    withTz('America/New_York', () => {
      // 2026-03-08: clocks go from 02:00 EST to 03:00 EDT
      const night = Q('22:00', '07:00');
      const from = local(2026, 3, 7, 23, 0); // 04:00Z
      assert.strictEqual(from, Date.parse('2026-03-08T04:00:00Z'));
      const end = alerts.nextQuietChange(from, night);
      assert.strictEqual(end, Date.parse('2026-03-08T11:00:00Z')); // 07:00 EDT
      assert.strictEqual((end - from) / HOUR, 7, 'the night is an hour shorter');
      const gap = Q('02:30', '06:00');
      const next = alerts.nextQuietChange(Date.parse('2026-03-08T06:00:00Z'), gap); // 01:00 EST
      assert.strictEqual(next, Date.parse('2026-03-08T07:00:00Z')); // 03:00 EDT, where the wall clock passes 02:30
      assert.strictEqual(alerts.isQuiet(next, gap), true);
      assert.strictEqual(alerts.isQuiet(next - MIN, gap), false);
      // 2026-11-01: clocks go back; 22:00–07:00 is an hour longer
      const fall = local(2026, 10, 31, 23, 0);
      assert.strictEqual((alerts.nextQuietChange(fall, night) - fall) / HOUR, 9);
    });
  });

  test('nextQuietChange: next start, next end, next listed day', () => {
    const cfg = Q('22:00', '07:00');
    assert.strictEqual(alerts.nextQuietChange(local(2026, 9, 24, 21, 0), cfg), local(2026, 9, 24, 22, 0));
    assert.strictEqual(alerts.nextQuietChange(local(2026, 9, 24, 22, 0), cfg), local(2026, 9, 25, 7, 0));
    assert.strictEqual(alerts.nextQuietChange(local(2026, 9, 25, 3, 30) + 12345, cfg), local(2026, 9, 25, 7, 0));
    const fri = Q('22:00', '07:00', { days: ['fri'] });
    assert.strictEqual(alerts.nextQuietChange(local(2026, 9, 21, 10, 0), fri), local(2026, 9, 25, 22, 0)); // Monday → Friday
    assert.strictEqual(alerts.nextQuietChange(local(2026, 9, 25, 23, 0), fri), local(2026, 9, 26, 7, 0));
    assert.strictEqual(alerts.nextQuietChange(local(2026, 9, 26, 7, 0), fri), local(2026, 10, 2, 22, 0));
  });

  test('shouldMute: sounds, system notifications and push only; allowErrors lets errors and usage-limit hits through', () => {
    const t = local(2026, 9, 24, 23, 0);
    const cfg = Q('22:00', '07:00');
    for (const ch of ['sound', 'system', 'push']) {
      assert.strictEqual(alerts.shouldMute(ch, 'needsYou', t, cfg), true, ch);
      assert.strictEqual(alerts.shouldMute(ch, 'error', t, cfg), true, ch);
      assert.strictEqual(alerts.shouldMute(ch, 'error', t, { ...cfg, allowErrors: true }), false, ch);
      // a usage-limit hit is an error too (its sound is the error sound); its reset and threshold alerts are not
      assert.strictEqual(alerts.shouldMute(ch, 'limitHit', t, cfg), true, ch);
      assert.strictEqual(alerts.shouldMute(ch, 'limitHit', t, { ...cfg, allowErrors: true }), false, ch);
      assert.strictEqual(alerts.shouldMute(ch, 'limitReset', t, { ...cfg, allowErrors: true }), true, ch);
      assert.strictEqual(alerts.shouldMute(ch, 'usageHigh', t, { ...cfg, allowErrors: true }), true, ch);
      assert.strictEqual(alerts.shouldMute(ch, 'needsYou', local(2026, 9, 24, 12, 0), cfg), false, ch);
    }
    for (const ch of ['toast', 'panel', 'badge', 'statusBar']) assert.strictEqual(alerts.shouldMute(ch, 'needsYou', t, cfg), false, ch);
    assert.strictEqual(alerts.shouldMute('sound', 'needsYou', t, { ...cfg, enabled: false }), false);
  });

  test('formatQuietStatus: "Quiet hours until …" only while quiet', () => {
    const en = i18nLib.createI18n('en');
    const cfg = Q('22:00', '07:00');
    assert.strictEqual(ws(alerts.formatQuietStatus(local(2026, 9, 25, 1, 0), cfg, en)), 'Quiet hours until 7:00 AM');
    assert.strictEqual(ws(alerts.formatQuietStatus(local(2026, 9, 24, 23, 0), cfg, en)), 'Quiet hours until Fri 7:00 AM');
    assert.strictEqual(alerts.formatQuietStatus(local(2026, 9, 24, 12, 0), cfg, en), '');
    const zh = i18nLib.createI18n('zh-cn');
    assert.strictEqual(alerts.formatQuietStatus(local(2026, 9, 25, 1, 0), cfg, zh), '勿扰时段，到 7:00 结束');
    assert.strictEqual(alerts.formatQuietStatus(local(2026, 9, 25, 1, 0), cfg, (k, v) => `${k}|${v.time}`, { fmtClock: () => 'T' }), 'alerts.quiet.until|T');
  });
}

// ---------- Threshold alerts ----------

function thresholdTests() {
  test('settings: defaults (usage 90 %, cost and context off), clamping, 0 = off', () => {
    assert.deepStrictEqual(alerts.normalizeThresholds(), { usagePercent: 90, dailyCost: 0, contextPercent: 0 });
    assert.deepStrictEqual(alerts.normalizeThresholds({ usagePercent: 150, dailyCost: -3, contextPercent: '85' }),
      { usagePercent: 100, dailyCost: 0, contextPercent: 85 });
    assert.deepStrictEqual(alerts.normalizeThresholds({ usagePercent: 0, dailyCost: 12.345, contextPercent: 'x' }),
      { usagePercent: 0, dailyCost: 12.35, contextPercent: 0 });
  });

  test('usageHigh: the first update seeds; a crossing fires once and not again while the window lasts', () => {
    const tr = alerts.createThresholdTracker();
    const reset = NOW + 3 * HOUR;
    assert.deepStrictEqual(tr.update({ quota: quotaOf([w5h(95, reset)]), now: NOW, cfg: CFG }), [], 'already over when opened');
    const tr2 = alerts.createThresholdTracker();
    assert.deepStrictEqual(tr2.update({ quota: quotaOf([w5h(80, reset), wWeek(40, NOW + 4 * DAY)]), now: NOW, cfg: CFG }), []);
    const ev = tr2.update({ quota: quotaOf([w5h(91.5, reset), wWeek(40, NOW + 4 * DAY)]), now: NOW + MIN, cfg: CFG });
    assert.strictEqual(ev.length, 1);
    assert.deepStrictEqual(ev[0], {
      type: 'usageHigh', key: 'quota:codex:5h', transitionId: `usageHigh|codex|5h|${Math.ceil(reset / 600e3) * 600e3}|90`,
      provider: 'codex', window: '5h', windowMinutes: 300, percent: 91.5, threshold: 90, resetAt: reset, atLimit: false,
    });
    assert.deepStrictEqual(tr2.update({ quota: quotaOf([w5h(97, reset)]), now: NOW + 2 * MIN, cfg: CFG }), []);
    const full = tr2.update({ quota: quotaOf([w5h(100, reset)]), now: NOW + 3 * MIN, cfg: CFG });
    assert.deepStrictEqual(full, [], 'the same window does not fire again, even when full');
  });

  test('usageHigh: a new window (new reset time) fires again; a reset time drifting by seconds does not', () => {
    const tr = alerts.createThresholdTracker();
    const reset = NOW + 3 * HOUR + 17 * SEC;
    tr.update({ quota: quotaOf([w5h(10, reset)]), now: NOW, cfg: CFG });
    assert.strictEqual(tr.update({ quota: quotaOf([w5h(92, reset)]), now: NOW + MIN, cfg: CFG }).length, 1);
    // resets_in_seconds resolved against another line's time: the same reset, a second or two off
    assert.deepStrictEqual(tr.update({ quota: quotaOf([w5h(93, reset + 1500)]), now: NOW + 2 * MIN, cfg: CFG }), []);
    assert.deepStrictEqual(tr.update({ quota: quotaOf([w5h(94, reset - 2000)]), now: NOW + 3 * MIN, cfg: CFG }), []);
    // The window resets; old data is ignored until the next window reports
    assert.deepStrictEqual(tr.update({ quota: quotaOf([w5h(99, reset)]), now: reset + MIN, cfg: CFG }), []);
    const next = reset + 5 * HOUR;
    assert.deepStrictEqual(tr.update({ quota: quotaOf([w5h(20, next)]), now: reset + 2 * MIN, cfg: CFG }), []);
    const ev = tr.update({ quota: quotaOf([w5h(90, next)]), now: reset + 3 * HOUR, cfg: CFG });
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].resetAt, next);
    // The weekly window has its own id
    const wk = NOW + 5 * DAY;
    assert.strictEqual(tr.update({ quota: quotaOf([w5h(90, next), wWeek(90, wk)]), now: reset + 3 * HOUR + MIN, cfg: CFG })[0].window, 'weekly');
  });

  test('usageHigh: Claude has no percentages (lastHit only), threshold 0 is off, a window without a reset still fires once', () => {
    const tr = alerts.createThresholdTracker();
    const claudeOnly = { claude: { lastHit: { kind: 'session', ms: NOW, resetsAtMs: NOW + HOUR, sessionKey: 'claude:x' } }, codex: null };
    tr.update({ quota: claudeOnly, now: NOW, cfg: CFG });
    assert.deepStrictEqual(tr.update({ quota: claudeOnly, now: NOW + MIN, cfg: CFG }), []);
    assert.deepStrictEqual(alerts.usageWindowsOf(claudeOnly), []);
    const off = alerts.createThresholdTracker();
    off.update({ quota: quotaOf([w5h(10, NOW + HOUR)]), now: NOW, cfg: { ...CFG, usagePercent: 0 } });
    assert.deepStrictEqual(off.update({ quota: quotaOf([w5h(99, NOW + HOUR)]), now: NOW + MIN, cfg: { ...CFG, usagePercent: 0 } }), []);
    const noReset = alerts.createThresholdTracker();
    noReset.update({ quota: quotaOf([w5h(10, null)]), now: NOW, cfg: CFG });
    const ev = noReset.update({ quota: quotaOf([w5h(95, null)]), now: NOW + MIN, cfg: CFG });
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].transitionId, 'usageHigh|codex|5h|unknown|90');
    assert.deepStrictEqual(noReset.update({ quota: quotaOf([w5h(96, null)]), now: NOW + 2 * MIN, cfg: CFG }), []);
    // A provider that one day exposes windows is picked up the same way
    assert.strictEqual(alerts.usageWindowsOf({ claude: { lastHit: null, windows: [{ label: 'session', usedPct: 50, resetsAtMs: null }] } }).length, 1);
  });

  test('costDaily: seeding, a crossing fires once per day, the next day fires again; partial totals are skipped', () => {
    const tr = alerts.createThresholdTracker();
    assert.deepStrictEqual(tr.update({ today: todayOf(3, 2), now: NOW, cfg: CFG }), []);
    const ev = tr.update({ today: todayOf(7.5, 3.1), now: NOW + MIN, cfg: CFG });
    assert.strictEqual(ev.length, 1);
    const date = new Date(localMidnight(NOW));
    const ymd = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    assert.strictEqual(ev[0].transitionId, `costDaily|${ymd}|10`);
    assert.strictEqual(ev[0].date, ymd);
    assert.ok(Math.abs(ev[0].cost - 10.6) < 1e-9);
    assert.deepStrictEqual([ev[0].type, ev[0].key, ev[0].threshold, ev[0].claudeCost, ev[0].codexCost], ['costDaily', 'today', 10, 7.5, 3.1]);
    assert.deepStrictEqual(tr.update({ today: todayOf(20, 3), now: NOW + 2 * MIN, cfg: CFG }), []);
    // Next day: the scanner starts over (partial while it catches up), then crosses again
    const tomorrow = NOW + DAY;
    assert.deepStrictEqual(tr.update({ today: todayOf(50, 0, { now: tomorrow, partial: true, progress: 0.3 }), now: tomorrow, cfg: CFG }), []);
    const ev2 = tr.update({ today: todayOf(11, 0, { now: tomorrow }), now: tomorrow + MIN, cfg: CFG });
    assert.strictEqual(ev2.length, 1);
    assert.notStrictEqual(ev2[0].transitionId, ev[0].transitionId);
    // Opening a window while totals are still being read: no seeding until they are complete, so no false crossing
    const late = alerts.createThresholdTracker();
    assert.deepStrictEqual(late.update({ today: todayOf(2, 0, { partial: true }), now: NOW, cfg: CFG }), []);
    assert.deepStrictEqual(late.update({ today: todayOf(25, 0), now: NOW + MIN, cfg: CFG }), [], 'first complete totals seed');
    // Off by default
    const off = alerts.createThresholdTracker();
    off.update({ today: todayOf(0, 0), now: NOW, cfg: {} });
    assert.deepStrictEqual(off.update({ today: todayOf(999, 0), now: NOW + MIN, cfg: {} }), []);
  });

  test('contextHigh: off by default; seeding; a crossing fires once; after a compaction it can fire again', () => {
    const off = alerts.createThresholdTracker();
    off.update({ sessions: [session({ contextUsed: 10000 })], now: NOW, cfg: {} });
    assert.deepStrictEqual(off.update({ sessions: [session({ contextUsed: 160000 })], now: NOW + MIN, cfg: {} }), []);

    const tr = alerts.createThresholdTracker();
    assert.deepStrictEqual(tr.update({ sessions: [session({ contextUsed: 150000, id: 'bbbbbbbb-0000' })], now: NOW, cfg: CFG }), [], 'seeded');
    const s1 = session({ contextUsed: 120000 });
    tr.update({ sessions: [s1], now: NOW, cfg: CFG });
    const s2 = session({ contextUsed: 140000, contextPct: 70, main: { tokens: { toCompact: 27000 }, lastCompact: null } });
    const ev = tr.update({ sessions: [s2], now: NOW + MIN, cfg: CFG });
    assert.strictEqual(ev.length, 1);
    assert.deepStrictEqual(ev[0], {
      type: 'contextHigh', key: s2.key, transitionId: `contextHigh|${s2.key}|c0|80`, provider: 'claude',
      title: 'Fix login bug', titleSource: 'ai', project: 'demo-app', percent: 83, threshold: 80, contextPct: 70,
      contextUsed: 140000, compactAt: 167000, toCompact: 27000,
    });
    assert.deepStrictEqual(tr.update({ sessions: [{ ...s2, contextUsed: 160000 }], now: NOW + 2 * MIN, cfg: CFG }), []);
    // Auto-compaction: context drops, then grows back past the threshold in the new cycle
    const lc = { ms: NOW + 3 * MIN, trigger: 'auto', preTokens: 166000, postTokens: 30000, model: 'claude-opus-5-5' };
    const after = { ...s2, contextUsed: 30000, compactCount: 1, main: { tokens: { toCompact: 137000 }, lastCompact: lc } };
    assert.deepStrictEqual(tr.update({ sessions: [after], now: NOW + 3 * MIN, cfg: CFG }), []);
    const ev2 = tr.update({ sessions: [{ ...after, contextUsed: 150000, updatedMs: NOW + 40 * MIN }], now: NOW + 40 * MIN, cfg: CFG });
    assert.strictEqual(ev2.length, 1);
    assert.strictEqual(ev2[0].transitionId, `contextHigh|${s2.key}|c${lc.ms}|80`);
  });

  test('contextHigh: no compact point or Codex relative scope → nothing; an old chat coming into scope is not reported, a fresh one is', () => {
    const tr = alerts.createThresholdTracker();
    tr.update({ sessions: [], now: NOW, cfg: CFG });
    const noCompact = session({ id: 'n1', compactAt: null, contextUsed: 190000 });
    const relative = session({ id: 'x1', provider: 'codex', compactAt: 244800, contextUsed: 240000, main: { tokens: { toCompact: null }, lastCompact: null } });
    const old = session({ id: 'o1', contextUsed: 160000, updatedMs: NOW - 2 * HOUR });
    const fresh = session({ id: 'f1', contextUsed: 160000, updatedMs: NOW - 10 * SEC });
    const ev = tr.update({ sessions: [noCompact, relative, old, fresh, fresh], now: NOW + MIN, cfg: CFG });
    assert.deepStrictEqual(ev.map((e) => e.key), [fresh.key]);
    // The old chat was remembered, so resuming it does not report it for this cycle either
    assert.deepStrictEqual(tr.update({ sessions: [{ ...old, updatedMs: NOW + 2 * MIN }], now: NOW + 2 * MIN, cfg: CFG }), []);
    // A Codex session with an absolute compact point works like Claude
    const cx = session({ id: 'c2', provider: 'codex', compactAt: 244800, contextUsed: 100000, main: { tokens: { toCompact: 144800 }, lastCompact: null } });
    tr.update({ sessions: [cx], now: NOW + 3 * MIN, cfg: CFG });
    const ev2 = tr.update({ sessions: [{ ...cx, contextUsed: 200000 }], now: NOW + 4 * MIN, cfg: CFG });
    assert.deepStrictEqual(ev2.map((e) => [e.provider, e.percent]), [['codex', 81]]);
  });

  test('changing a threshold seeds again: typing 9 then 90 never reports what is already over it', () => {
    const tr = alerts.createThresholdTracker();
    const reset = NOW + HOUR;
    tr.update({ quota: quotaOf([w5h(50, reset)]), now: NOW, cfg: CFG });
    assert.deepStrictEqual(tr.update({ quota: quotaOf([w5h(50, reset)]), now: NOW + SEC, cfg: { ...CFG, usagePercent: 9 } }), []);
    assert.deepStrictEqual(tr.update({ quota: quotaOf([w5h(50, reset)]), now: NOW + 2 * SEC, cfg: { ...CFG, usagePercent: 40 } }), []);
    // A real crossing of the new threshold still fires
    const t2 = { ...CFG, usagePercent: 60 };
    assert.deepStrictEqual(tr.update({ quota: quotaOf([w5h(50, reset)]), now: NOW + 3 * SEC, cfg: t2 }), []);
    assert.strictEqual(tr.update({ quota: quotaOf([w5h(61, reset)]), now: NOW + MIN, cfg: t2 }).length, 1);
    // Same for cost and context
    tr.update({ today: todayOf(5, 0), sessions: [session({ contextUsed: 100000 })], now: NOW, cfg: CFG });
    assert.deepStrictEqual(tr.update({ today: todayOf(5, 0), sessions: [session({ contextUsed: 100000 })], now: NOW + SEC,
      cfg: { ...CFG, dailyCost: 1, contextPercent: 50 } }), []);
  });

  test('sources seed separately: sessions first, quota later', () => {
    const tr = alerts.createThresholdTracker();
    tr.update({ sessions: [session()], now: NOW, cfg: CFG });
    assert.deepStrictEqual(tr.update({ quota: quotaOf([w5h(99, NOW + HOUR)]), now: NOW + SEC, cfg: CFG }), [], 'quota seeds on its first update');
    assert.deepStrictEqual(tr.update({ today: todayOf(99, 0), now: NOW + SEC, cfg: CFG }), [], 'today seeds on its first update');
  });

  test('two windows (trackers) name the same crossing with the same transitionId', () => {
    const a = alerts.createThresholdTracker();
    const b = alerts.createThresholdTracker();
    const reset = NOW + 2 * HOUR + 41 * SEC;
    const lc = { ms: NOW - HOUR, trigger: 'auto', preTokens: 1, postTokens: 1, model: null };
    const s = (used) => session({ contextUsed: used, main: { tokens: { toCompact: 1 }, lastCompact: lc } });
    a.update({ quota: quotaOf([w5h(10, reset)]), today: todayOf(1, 0), sessions: [s(1000)], now: NOW, cfg: CFG });
    const ea = a.update({ quota: quotaOf([w5h(90, reset)]), today: todayOf(11, 0), sessions: [s(150000)], now: NOW + 5 * MIN, cfg: CFG });
    // Window B opened later and saw the data from a slightly different line (reset drifted by a second)
    b.update({ quota: quotaOf([w5h(10, reset + 900)]), today: todayOf(1, 0), sessions: [s(1000)], now: NOW + 2 * MIN, cfg: CFG });
    const eb = b.update({ quota: quotaOf([w5h(91, reset + 900)]), today: todayOf(12, 0), sessions: [s(151000)], now: NOW + 6 * MIN, cfg: CFG });
    assert.strictEqual(ea.length, 3);
    assert.deepStrictEqual(ea.map((e) => e.transitionId).sort(), eb.map((e) => e.transitionId).sort());
  });
}

// ---------- Formatting ----------

function formatTests() {
  const reset = NOW + 5 * HOUR; // 15:00 UTC
  const usage = { type: 'usageHigh', key: 'quota:codex:5h', transitionId: 'x', provider: 'codex', window: '5h', windowMinutes: 300, percent: 92.7, threshold: 90, resetAt: reset, atLimit: false };
  const cost = { type: 'costDaily', key: 'today', transitionId: 'y', date: '2026-09-24', cost: 12.345, threshold: 10, claudeCost: 10, codexCost: 2.345 };
  const ctx = { type: 'contextHigh', key: 'claude:s1', transitionId: 'z', provider: 'claude', title: 'Fix login bug', titleSource: 'ai', project: 'demo-app', percent: 91, threshold: 80, contextPct: 76, contextUsed: 152000, compactAt: 167000, toCompact: 15000 };

  test('en: usage, cost and context alerts', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    const u = alerts.formatAlert(usage, en, { now: NOW });
    assert.deepStrictEqual([u.title, ws(u.body), ws(u.toast)], ['Codex 5-hour limit at 92%', 'Resets 3:00 PM.', 'Codex 5-hour limit at 92%: Resets 3:00 PM.']);
    const wk = alerts.formatAlert({ ...usage, window: 'weekly', windowMinutes: 10080, resetAt: null }, en, { now: NOW });
    assert.deepStrictEqual([wk.title, wk.body], ['Codex weekly limit at 92%', "The reset time isn't known."]);
    assert.strictEqual(alerts.formatAlert({ ...usage, window: '60m', windowMinutes: 60 }, en, { now: NOW }).title, 'Codex 60-minute limit at 92%');
    const c = alerts.formatAlert(cost, en);
    assert.deepStrictEqual([c.title, c.body], ["Today's cost passed $10.00", 'Estimated API-equivalent cost so far today: $12.35.']);
    const x = alerts.formatAlert(ctx, en);
    assert.deepStrictEqual([x.title, x.body], ['Context nearly full · demo-app', 'Fix login bug has reached 91% of its auto-compact point.']);
    assert.strictEqual(x.toast, 'Context nearly full · demo-app: Fix login bug has reached 91% of its auto-compact point.');
    const bare = alerts.formatAlert({ ...ctx, project: null, title: '' }, en);
    assert.deepStrictEqual([bare.title, bare.body], ['Context nearly full', 'A chat has reached 91% of its auto-compact point.']);
    assert.deepStrictEqual(alerts.formatAlert({ type: 'nope' }, en), { title: 'CYUNEO Agent Monitor', body: '', toast: '' });
  });

  test('zh-cn: translated text with Chinese punctuation', () => {
    const zh = i18nLib.createI18n('zh-cn', { timeZone: 'UTC' });
    const u = alerts.formatAlert(usage, zh, { now: NOW });
    assert.deepStrictEqual([u.title, u.body, u.toast], ['Codex 5 小时额度已用 92%', '15:00 重置。', 'Codex 5 小时额度已用 92%：15:00 重置。']);
    const c = alerts.formatAlert(cost, zh);
    assert.deepStrictEqual([c.title, c.body], [`今日费用已超过 ${zh.fmtUsd(10)}`, `今日目前的等价 API 费用估算：${zh.fmtUsd(12.345)}。`]);
    assert.ok(/10\.00/.test(c.title) && /12\.35/.test(c.body));
    const x = alerts.formatAlert(ctx, zh);
    assert.deepStrictEqual([x.title, x.body], ['上下文快满了 · demo-app', 'Fix login bug 已到自动压缩点的 91%。']);
  });

  test('forPush: no cost amounts; a chat title only with includeTitle and a real title', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    const c = alerts.formatAlert(cost, en, { forPush: true, includeTitle: true });
    assert.deepStrictEqual([c.title, c.body], ["Today's cost passed your daily budget", "Today's estimated API-equivalent cost is over the budget you set."]);
    assert.ok(!/\d/.test(c.title + c.body + c.toast));
    assert.strictEqual(alerts.formatAlert(ctx, en, { forPush: true, includeTitle: false }).body, 'A chat has reached 91% of its auto-compact point.');
    assert.strictEqual(alerts.formatAlert(ctx, en, { forPush: true, includeTitle: true }).body, 'Fix login bug has reached 91% of its auto-compact point.');
    const fromPrompt = { ...ctx, title: 'please rotate the API key sk-123', titleSource: 'prompt' };
    assert.ok(!alerts.formatAlert(fromPrompt, en, { forPush: true, includeTitle: true }).body.includes('sk-123'));
    assert.ok(alerts.formatAlert(fromPrompt, en).body.includes('rotate'), 'desktop notifications show the title like notify does');
    assert.strictEqual(alerts.formatAlert(ctx, en, { includeTitle: false }).body, 'A chat has reached 91% of its auto-compact point.');
  });

  test('titles are cleaned and [label](link) syntax is broken in the toast', () => {
    const en = i18nLib.createI18n('en');
    const m = alerts.formatAlert({ ...ctx, title: '[click](command:workbench.action.quit)\u202e\nx', project: 'p\u0007q' }, en);
    assert.ok(!/[\u0000-\u001f\u202e]/.test(m.title + m.body + m.toast));
    assert.ok(m.toast.includes(']\u200b('), m.toast);
    assert.ok(m.title.includes('p q'));
  });

  test('a plain translate function works too (fallback number and time formatting)', () => {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'alerts.en.json'), 'utf8'));
    const tr = (k, v) => i18nLib.createI18n('en', { dicts: { en: dict } }).t(k, v);
    assert.strictEqual(alerts.formatAlert(cost, tr).title, "Today's cost passed $10.00");
    assert.strictEqual(alerts.formatAlert(usage, tr, { fmtClock: () => '15:00' }).body, 'Resets 15:00.');
    assert.strictEqual(alerts.formatAlert(usage, tr).body, "The reset time isn't known.");
  });

  test('five languages: same keys and placeholders as English; every alert formats with nothing left over', () => {
    const ph = (s) => (String(s).match(/\{\w+\}/g) || []).slice().sort().join(',');
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'alerts.en.json'), 'utf8'));
    assert.ok(Object.keys(en).length >= 20);
    for (const k of Object.keys(en)) assert.ok(k.startsWith('alerts.'), k);
    for (const loc of LOCALES) {
      const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', `alerts.${loc}.json`), 'utf8'));
      assert.deepStrictEqual(Object.keys(d).sort(), Object.keys(en).sort(), loc);
      for (const k of Object.keys(en)) {
        assert.ok(typeof d[k] === 'string' && d[k].trim(), `${loc} ${k}`);
        assert.strictEqual(ph(d[k]), ph(en[k]), `${loc} ${k} placeholders`);
      }
      const i18n = i18nLib.createI18n(loc, { timeZone: 'UTC' });
      for (const ev of [usage, { ...usage, resetAt: null }, { ...usage, window: '30m', windowMinutes: 30 }, cost, ctx, { ...ctx, project: null, title: '' }]) {
        for (const o of [{}, { forPush: true }, { includeTitle: false }]) {
          const m = alerts.formatAlert(ev, i18n, { now: NOW, ...o });
          for (const v of Object.values(m)) assert.ok(v && !/\{\w+\}/.test(v) && !v.includes('alerts.'), `${loc}: ${v}`);
        }
      }
      for (const c of alerts.SOUND_CHOICES) assert.ok(!alerts.soundLabel(c, i18n).startsWith('alerts.'), `${loc} ${c}`);
      for (const e of alerts.SOUND_EVENTS) assert.ok(!alerts.soundEventLabel(e, i18n).startsWith('alerts.'), `${loc} ${e}`);
      if (loc !== 'en') assert.notStrictEqual(alerts.formatAlert(ctx, i18n).title, 'Context nearly full · demo-app', `${loc} is translated`);
    }
    const en1 = i18nLib.createI18n('en');
    assert.strictEqual(alerts.soundLabel('default', en1), 'Default');
    assert.strictEqual(alerts.soundLabel('off', en1), 'No sound');
    assert.strictEqual(alerts.soundLabel('glass', en1), 'Glass');
    assert.strictEqual(alerts.soundEventLabel('needsYou', en1), 'Agent needs you');
  });
}

// ---------- Run ----------

console.log('sounds');
soundTests();
console.log('quiet hours');
quietTests();
console.log('thresholds');
thresholdTests();
console.log('format');
formatTests();

Promise.all(pending).then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
});
