'use strict';
// Tests for the usage history: lib/core/history.js, its worker / monitor plumbing, lib/history-view.js, media/history.{js,css}
// and l10n/history.*.json. Plain node: node test/history.test.js
// All transcripts are synthetic and written to a temp directory (AGENT_MONITOR_TEST_TMP, or the system temp dir); ~/.claude
// and ~/.codex are never read. The time zone is pinned so local-day boundaries differ from UTC ones.

process.env.TZ = 'America/Los_Angeles';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
const H = require('../lib/core/history');
const { DailyScanner } = require('../lib/core/daily');
const pricing = require('../lib/core/pricing');
const { Monitor, normalizeConfig } = require('../lib/monitor');
const i18nLib = require('../lib/i18n');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'am-history-')));

// ---------- Helpers ----------

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function approx(a, b, eps = 1e-9, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg ? msg + ': ' : ''}${a} ≈ ${b}`);
}

// Local time: NOW is 2026-09-24 15:00 in Los Angeles; at(-n, h, m) is n days earlier at h:m local
const NOW = new Date(2026, 8, 24, 15, 0, 0).getTime();
const at = (daysAgo, h = 12, m = 0) => new Date(2026, 8, 24 - daysAgo, h, m, 0).getTime();
const day = (daysAgo) => H.dayKeyOf(at(daysAgo));
const iso = (ms) => new Date(ms).toISOString();

let homeNo = 0;
function makeHome() {
  const base = path.join(TMP, `home-${++homeNo}`);
  const claudeDir = path.join(base, 'claude', 'projects');
  const proj = path.join(claudeDir, 'p');
  fs.mkdirSync(path.join(proj, 'sess1', 'subagents'), { recursive: true });
  const codexHome = path.join(base, 'codex');
  const codexDay = path.join(codexHome, 'sessions', '2026', '09', '20');
  fs.mkdirSync(codexDay, { recursive: true });
  return { base, claudeDir, proj, codexHome, codexDay, cache: path.join(base, 'state', 'history-cache.jsonl') };
}

function setMtime(file, ms) { fs.utimesSync(file, new Date(ms), new Date(ms)); }
function writeRows(file, rows, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r) + '\n').join(''));
  if (mtime != null) setMtime(file, mtime);
}
function appendRows(file, rows, mtime) {
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r) + '\n').join(''));
  if (mtime != null) setMtime(file, mtime);
}

function cl(id, ts, model, u, extra = {}) {
  return { type: 'assistant', timestamp: iso(ts), sessionId: 's', message: { id, role: 'assistant', model, content: [{ type: 'text', text: 'x' }], stop_reason: null, usage: u }, ...extra };
}
const u = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });

const ev = (ts, payload) => ({ timestamp: iso(ts), type: 'event_msg', payload });
const tc = (ts, input, cached, output, reasoning = 0) => ev(ts, { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output }, last_token_usage: {} } });
const ctx = (ts, model) => ({ timestamp: iso(ts), type: 'turn_context', payload: { model, cwd: '/tmp/x' } });
const rec = (ts, rid, input, cached, output) => ({ timestamp: iso(ts), type: 'token_usage_record', payload: { response_id: rid, usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } } });

// A multi-day fixture: Claude main + subagent transcripts, one old-format and one per-response Codex rollout
function fixture(h) {
  const main = path.join(h.proj, 'sess1.jsonl');
  writeRows(main, [
    cl('old', at(40), 'claude-opus-5-5', u(999, 999)),              // outside any window
    cl('d5a', at(5, 9), 'claude-opus-5-5', u(100, 10, 1000, 200)),
    cl('d5a', at(5, 9, 1), 'claude-opus-5-5', u(100, 40, 1000, 200)), // same message, usage grows: only +30 output
    cl('d2a', at(2, 23, 30), 'claude-sonnet-5', u(50, 5)),
    cl('t1', at(0, 1), 'claude-opus-5-5', u(10, 5, 500, 100)),
    cl('syn', at(0, 1, 1), '<synthetic>', u(0, 0)),
    cl('err', at(0, 1, 2), 'claude-opus-5-5', u(7, 7), { isApiErrorMessage: true }),
    { type: 'user', timestamp: iso(at(0, 2)), message: { role: 'user', content: 'mentions "usage" in text' } },
    cl('t2', at(0, 3), 'claude-mystery-9', u(20, 2)),               // no public price
  ], at(0, 3));
  const sub = path.join(h.proj, 'sess1', 'subagents', 'agent-a.jsonl');
  writeRows(sub, [
    cl('s1', at(1, 10), 'claude-haiku-4-5', u(300, 30)),
    cl('t1', at(0, 1), 'claude-opus-5-5', u(10, 5, 500, 100)),       // copied message: de-duplicated globally
    cl('t3', at(0, 4), 'claude-haiku-4-5', u(40, 4)),
  ], at(0, 4));
  const oldRollout = path.join(h.codexDay, 'rollout-2026-09-20T10-00-00-old.jsonl');
  writeRows(oldRollout, [
    ctx(at(3, 8), 'gpt-5.5'),
    tc(at(3, 8, 1), 100, 40, 10, 2),
    tc(at(3, 8, 2), 100, 40, 10, 2),   // identical: skipped
    tc(at(0, 5), 250, 100, 30, 6),     // today: +150/60/20
  ], at(0, 5));
  const newRollout = path.join(h.codexDay, 'rollout-2026-09-20T11-00-00-new.jsonl');
  writeRows(newRollout, [
    ctx(at(1, 9), 'gpt-5.6-sol'),
    tc(at(1, 9, 1), 1000, 0, 100),      // rolled back once per-response records appear
    rec(at(1, 9, 2), 'resp_1', 1000, 0, 100),
    rec(at(0, 6), 'resp_2', 500, 400, 20),
    rec(at(0, 6, 1), 'resp_2', 500, 400, 20), // duplicate response_id
  ], at(0, 6));
  return { main, sub, oldRollout, newRollout };
}

const roots = (h) => [path.join(h.base, 'claude'), path.join(h.base, 'codex')];

function scanner(h, extra = {}) {
  return new H.HistoryScanner({ claudeProjectsDir: h.claudeDir, codexHome: h.codexHome, sliceMs: 60e3, ...extra });
}

function runToEnd(sc, now = NOW, max = 500) {
  let r = sc.step(now);
  let n = 1;
  while (r.partial && n < max) { r = sc.step(now); n++; }
  assert.strictEqual(r.partial, false, 'scan completes');
  return { r, steps: n };
}

const dayRow = (r, key) => r.days.find((d) => d.date === key);

// Transcript opens/reads under the given directories (the cache file and everything else are ignored)
function spyFs(...dirs) {
  const under = (p) => dirs.some((d) => String(p).startsWith(d + path.sep));
  const orig = { openSync: fs.openSync, readSync: fs.readSync, readFileSync: fs.readFileSync };
  const opened = [];
  const fdPath = new Map();
  let reads = 0;
  fs.openSync = function (p, ...rest) {
    const fd = orig.openSync.call(fs, p, ...rest);
    if (under(p)) { opened.push(String(p)); fdPath.set(fd, String(p)); }
    return fd;
  };
  fs.readSync = function (fd, ...rest) {
    const n = orig.readSync.call(fs, fd, ...rest);
    if (fdPath.has(fd)) reads += n;
    return n;
  };
  fs.readFileSync = function (p, ...rest) {
    if (under(p)) opened.push(String(p));
    return orig.readFileSync.call(fs, p, ...rest);
  };
  return {
    opened,
    get bytes() { return reads; },
    restore() { Object.assign(fs, orig); },
  };
}

// ---------- Core: counting ----------

test('multi-day Claude and Codex: per-day buckets, message.id / response_id de-duplication, synthetic and error lines skipped, unpriced model kept apart', () => {
  const h = makeHome();
  fixture(h);
  const { r } = runToEnd(scanner(h));
  assert.strictEqual(r.windowDays, 30);
  assert.strictEqual(r.days.length, 30);
  assert.strictEqual(r.start, day(29));
  assert.strictEqual(r.end, day(0));
  assert.ok(!r.days.some((d) => d.date < day(29)), 'nothing before the window');
  const opus = (i, o, cr, cw) => pricing.priceClaudeTokens('claude-opus-5-5', { input: i, output: o, cacheRead: cr, cacheWrite5m: cw });
  // Five days ago: one message written over two lines = 100 in / 40 out / 1000 read / 200 write
  const d5 = dayRow(r, day(5));
  assert.strictEqual(d5.claude.tokens, 100 + 40 + 1000 + 200);
  approx(d5.claude.usd, opus(100, 40, 1000, 200), 1e-12);
  // Today: t1 once (copied into the subagent file), t3, and the unpriced t2
  const d0 = dayRow(r, day(0));
  assert.strictEqual(d0.claude.tokens, (10 + 5 + 500 + 100) + (40 + 4) + (20 + 2));
  assert.strictEqual(d0.claude.unpricedTokens, 22);
  approx(d0.claude.usd, opus(10, 5, 500, 100) + pricing.priceClaudeTokens('claude-haiku-4-5', { input: 40, output: 4 }), 1e-12);
  // Codex: old file counts deltas of cumulative values; the new file counts per-response records only
  assert.strictEqual(dayRow(r, day(3)).codex.tokens, 110);
  assert.strictEqual(dayRow(r, day(1)).codex.tokens, 1100, 'token_count rolled back, resp_1 counted');
  assert.strictEqual(d0.codex.tokens, 170 + 520);
  // byModel: normalized columns; Codex input excludes cached input, reasoning is kept
  const m = (p, id) => r.byModel.find((x) => x.provider === p && x.model === id);
  assert.deepStrictEqual(m('codex', 'gpt-5.5').tokens, { input: 60 + 90, output: 10 + 20, cacheRead: 40 + 60, cacheWrite: 0, reasoning: 2 + 4, total: 110 + 170 });
  assert.deepStrictEqual(m('claude', 'claude-opus-5-5').tokens, { input: 110, output: 45, cacheRead: 1500, cacheWrite: 300, reasoning: null, total: 110 + 45 + 1500 + 300 });
  assert.strictEqual(m('claude', 'claude-mystery-9').usd, null);
  assert.strictEqual(r.byModel[r.byModel.length - 1].model, 'claude-mystery-9', 'unpriced models sort last');
  // Totals add up
  approx(r.totals.usd, r.days.reduce((s, d) => s + d.claude.usd + d.codex.usd, 0), 1e-12);
  assert.strictEqual(r.totals.tokens, r.byModel.reduce((s, x) => s + x.tokens.total, 0));
  assert.strictEqual(r.totals.unpricedTokens, 22);
  assert.strictEqual(r.totals.activeDays, 5);
  assert.strictEqual(r.pricesUpdated, pricing.PRICES_UPDATED);
  assert.deepStrictEqual(r.progress.filesDone, r.progress.filesTotal);
  assert.strictEqual(r.progress.doneBytes, r.progress.totalBytes);
});

test('today\'s column equals DailyScanner for the same files and time (tokens by category, cost, cost by model)', () => {
  const h = makeHome();
  fixture(h);
  const { r } = runToEnd(scanner(h));
  const t = new DailyScanner({ claudeProjectsDir: h.claudeDir, codexHome: h.codexHome }).tick(NOW);
  assert.strictEqual(t.partial, false);
  const d0 = dayRow(r, day(0));
  const claudeTotal = t.claude.input + t.claude.cacheWrite5m + t.claude.cacheWrite1h + t.claude.cacheRead + t.claude.output;
  assert.strictEqual(d0.claude.tokens, claudeTotal);
  approx(d0.claude.usd, t.claude.costUsd, 1e-12, 'claude cost');
  assert.strictEqual(d0.claude.unpricedTokens, t.claude.unpricedTokens);
  assert.strictEqual(d0.codex.tokens, t.codex.input + t.codex.output);
  approx(d0.codex.usd, t.codex.costUsd, 1e-12, 'codex cost');
  // A one-day window lists the same models with the same tokens and cost
  const one = runToEnd(scanner(h, { days: 1 })).r;
  for (const p of ['claude', 'codex']) {
    const mine = Object.fromEntries(one.byModel.filter((x) => x.provider === p).map((x) => [x.model, x]));
    assert.deepStrictEqual(Object.keys(mine).sort(), Object.keys(t[p].byModel).sort(), p + ' models');
    for (const [model, b] of Object.entries(t[p].byModel)) {
      assert.strictEqual(mine[model].tokens.total, b.tokens, `${p} ${model} tokens`);
      if (b.costUsd == null) assert.strictEqual(mine[model].usd, null);
      else approx(mine[model].usd, b.costUsd, 1e-12, `${p} ${model} cost`);
    }
  }
});

test('day boundaries follow local time, not UTC (23:59 and 00:01 local fall on different days in the same UTC day)', () => {
  const h = makeHome();
  const f = path.join(h.proj, 'midnight.jsonl');
  const late = at(3, 23, 59);
  const early = at(2, 0, 1);
  assert.strictEqual(iso(late).slice(0, 10), iso(early).slice(0, 10), 'same UTC date');
  writeRows(f, [cl('a', late, 'claude-haiku-4-5', u(1, 1)), cl('b', early, 'claude-haiku-4-5', u(2, 2))], early);
  const { r } = runToEnd(scanner(h, { codexHome: null }));
  assert.strictEqual(dayRow(r, day(3)).claude.tokens, 2);
  assert.strictEqual(dayRow(r, day(2)).claude.tokens, 4);
  assert.strictEqual(H.dayKeyOf(late), day(3));
  // The window starts at local midnight 29 days ago
  const r2 = runToEnd(scanner(h, { codexHome: null }), at(0, 0, 0) + 1).r;
  assert.strictEqual(r2.start, day(29));
});

test('window cutoff: only files modified inside the window are opened; lines before it are dropped; a shorter request is a slice', () => {
  const h = makeHome();
  fixture(h);
  const stale = path.join(h.proj, 'stale.jsonl');
  writeRows(stale, [cl('z', at(45), 'claude-opus-5-5', u(5000, 5000))], at(45));
  const spy = spyFs(...roots(h));
  let r;
  try { r = runToEnd(scanner(h)).r; } finally { spy.restore(); }
  assert.ok(!spy.opened.includes(stale), 'a file untouched since before the window is never opened');
  assert.ok(!r.days.some((d) => d.claude.tokens >= 5000));
  // days: 7 → same scanner, only the last 7 days reported
  const sc = scanner(h);
  runToEnd(sc);
  sc.request({ days: 7 });
  const r7 = sc.step(NOW);
  assert.strictEqual(r7.days.length, 7);
  assert.strictEqual(r7.start, day(6));
  assert.strictEqual(r7.totals.tokens, r.days.slice(-7).reduce((s, d) => s + d.claude.tokens + d.codex.tokens, 0));
  assert.strictEqual(H.clampDays(500), H.MAX_DAYS);
  assert.strictEqual(H.clampDays('x'), H.DEFAULT_DAYS);
});

test('the window moves: days that fall out are dropped, together with their de-duplication state', () => {
  const h = makeHome();
  fixture(h);
  const sc = scanner(h, { days: 7 });
  runToEnd(sc);
  assert.ok(sc.msgs.get('d5a'), 'seen five days ago');
  const later = NOW + 3 * 86400e3;
  const r = runToEnd(sc, later).r;
  assert.strictEqual(r.start, H.dayKeyOf(H.addDays(later, -6)));
  assert.ok(!r.days.some((d) => d.date === day(5)));
  assert.strictEqual(sc.msgs.get('d5a'), undefined, 'message ids from dropped days are pruned');
  assert.ok(!sc.agg.has(day(5)));
  for (const e of sc.entries.values()) assert.ok(!Object.keys(e.perDay).some((d) => d < r.start));
  // A longer window than was scanned means a rebuild (older lines were never read)
  sc.request({ days: 30 });
  const r30 = runToEnd(sc, later).r;
  assert.ok(dayRow(r30, H.dayKeyOf(at(5))).claude.tokens > 0, 'older days are read again');
});

// ---------- Core: incremental reads and cache ----------

test('budget and progress: tiny slices finish step by step with the same result as one full read; progress only grows', () => {
  const h = makeHome();
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(cl('k' + i, at(i % 10, 10, i), 'claude-haiku-4-5', u(i, 1)));
  writeRows(path.join(h.proj, 'big.jsonl'), rows, at(0, 10));
  fixture(h);
  const small = scanner(h, { budgetBytes: 700 });
  let r = small.step(NOW);
  assert.strictEqual(r.partial, true);
  const p0 = r.progress;
  assert.ok(p0.totalBytes > 0 && p0.doneBytes > 0 && p0.doneBytes < p0.totalBytes);
  assert.ok(p0.filesTotal === 5 && p0.filesDone < 5, JSON.stringify(p0));
  let last = p0.doneBytes;
  let n = 0;
  while (r.partial && n++ < 500) {
    r = small.step(NOW);
    assert.ok(r.progress.doneBytes >= last, 'progress never goes back');
    last = r.progress.doneBytes;
  }
  assert.strictEqual(r.partial, false);
  assert.ok(n > 5, 'needed several slices');
  const full = runToEnd(scanner(h)).r;
  assert.deepStrictEqual(r.days, full.days);
  assert.deepStrictEqual(r.byModel, full.byModel);
  assert.deepStrictEqual(r.progress, { doneBytes: full.progress.totalBytes, totalBytes: full.progress.totalBytes, filesDone: 5, filesTotal: 5 });
});

test('cache: a second scanner reuses the persisted cache without opening any unchanged transcript; same result', () => {
  const h = makeHome();
  fixture(h);
  const a = scanner(h, { cacheFile: h.cache });
  const ra = runToEnd(a).r;
  assert.ok(fs.existsSync(h.cache), 'saved when the pass completed');
  assert.strictEqual(ra.cache.state, 'missing');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(h.cache)), [path.basename(h.cache)], 'no temp files left behind');
  const spy = spyFs(...roots(h));
  let rb;
  try {
    rb = scanner(h, { cacheFile: h.cache }).step(NOW);
  } finally { spy.restore(); }
  assert.deepStrictEqual(spy.opened, [], 'no transcript opened');
  assert.strictEqual(rb.partial, false);
  assert.strictEqual(rb.cache.state, 'loaded');
  assert.deepStrictEqual(rb.days, ra.days);
  assert.deepStrictEqual(rb.byModel, ra.byModel);
  // The same scanner, stepping again with force: re-lists (stat only), still reads nothing
  const sc = scanner(h, { cacheFile: h.cache });
  sc.step(NOW);
  const spy2 = spyFs(...roots(h));
  try { sc.request({ force: true }); sc.step(NOW + 1000); } finally { spy2.restore(); }
  assert.deepStrictEqual(spy2.opened, []);
});

test('incremental append: only the new bytes are read, a message continued across reads counts only its increment, also after a reload', () => {
  const h = makeHome();
  const { main } = fixture(h);
  const sc = scanner(h, { cacheFile: h.cache });
  const before = runToEnd(sc).r;
  const size0 = fs.statSync(main).size;
  appendRows(main, [
    cl('t2', at(0, 3, 5), 'claude-mystery-9', u(20, 12)), // same message id: +10 output
    cl('n1', at(0, 7), 'claude-opus-5-5', u(1000, 100)),
  ], at(0, 7));
  const spy = spyFs(...roots(h));
  let r;
  try {
    sc.request({ force: true });
    r = runToEnd(sc, NOW + 1000).r;
  } finally { spy.restore(); }
  assert.deepStrictEqual(spy.opened, [main], 'only the appended file');
  assert.strictEqual(spy.bytes, fs.statSync(main).size - size0, 'only the appended bytes');
  const d0 = dayRow(r, day(0));
  assert.strictEqual(d0.claude.tokens - dayRow(before, day(0)).claude.tokens, 10 + 1100);
  assert.strictEqual(d0.claude.unpricedTokens, 32);
  // After a reload from the cache, the de-duplication state is still there
  appendRows(main, [cl('n1', at(0, 7, 1), 'claude-opus-5-5', u(1000, 150))], at(0, 8));
  const again = runToEnd(scanner(h, { cacheFile: h.cache }), NOW + 2000).r;
  assert.strictEqual(dayRow(again, day(0)).claude.tokens, d0.claude.tokens + 50);
  // A partial last line is not lost across a save: it is read again once completed
  const f = path.join(h.proj, 'partial.jsonl');
  const line = JSON.stringify(cl('pp', at(0, 9), 'claude-haiku-4-5', u(3, 3)));
  fs.writeFileSync(f, line.slice(0, 40));
  setMtime(f, at(0, 9));
  const sc2 = scanner(h, { cacheFile: h.cache });
  runToEnd(sc2, NOW + 3000);
  sc2.flush(NOW + 3000);
  fs.appendFileSync(f, line.slice(40) + '\n');
  setMtime(f, at(0, 9, 1));
  const done = runToEnd(scanner(h, { cacheFile: h.cache }), NOW + 4000).r;
  assert.strictEqual(dayRow(done, day(0)).claude.tokens, dayRow(again, day(0)).claude.tokens + 6);
});

test('truncated or replaced files are read again without double-counting (Claude by message.id, Codex by its high-water mark)', () => {
  const h = makeHome();
  const { main, oldRollout } = fixture(h);
  const sc = scanner(h, { cacheFile: h.cache });
  const before = runToEnd(sc).r;
  const d0 = dayRow(before, day(0));
  // Claude: rewritten shorter with an old line plus a new one
  writeRows(main, [cl('t1', at(0, 1), 'claude-opus-5-5', u(10, 5, 500, 100)), cl('n2', at(0, 8), 'claude-haiku-4-5', u(5, 5))], at(0, 8));
  // Codex old format: rewritten; only what exceeds the previous maximum counts
  writeRows(oldRollout, [ctx(at(0, 5), 'gpt-5.5'), tc(at(0, 5), 100, 40, 10), tc(at(0, 9), 300, 100, 40)], at(0, 9));
  sc.request({ force: true });
  const r = runToEnd(sc, NOW + 1000).r;
  assert.strictEqual(dayRow(r, day(0)).claude.tokens, d0.claude.tokens + 10);
  assert.strictEqual(dayRow(r, day(0)).codex.tokens, d0.codex.tokens + (340 - 280));
  assert.deepStrictEqual(dayRow(r, day(5)), dayRow(before, day(5)), 'earlier days keep what was counted');
  // Same through a reload: the next scanner sees the same numbers
  const r2 = runToEnd(scanner(h, { cacheFile: h.cache }), NOW + 2000).r;
  assert.deepStrictEqual(r2.days, r.days);
});

test('corrupt, truncated or foreign caches are ignored and rebuilt; saves are atomic and throttled', () => {
  const h = makeHome();
  fixture(h);
  const fresh = runToEnd(scanner(h)).r;
  const good = () => { const sc = scanner(h, { cacheFile: h.cache }); runToEnd(sc); return fs.readFileSync(h.cache, 'utf8'); };
  const text = good();
  const lines = text.trimEnd().split('\n');
  assert.strictEqual(JSON.parse(lines[0]).kind, 'agent-monitor-history');
  assert.strictEqual(JSON.parse(lines[lines.length - 1]).end, true);
  const cases = {
    garbage: 'not json at all\n{{{',
    empty: '',
    truncated: text.slice(0, Math.floor(text.length * 0.6)),
    badLine: lines.map((l, i) => (i === 2 ? l.slice(0, 20) : l)).join('\n') + '\n',
    missingLine: lines.filter((_l, i) => i !== 1).join('\n') + '\n',
    otherRoots: [JSON.stringify({ ...JSON.parse(lines[0]), roots: { claude: '/elsewhere', codex: null } }), ...lines.slice(1)].join('\n') + '\n',
    oldPrices: [JSON.stringify({ ...JSON.parse(lines[0]), pricing: 'stale' }), ...lines.slice(1)].join('\n') + '\n',
    badNumbers: lines.map((l, i) => (i === 1 ? l.replace(/"offset":\d+/, '"offset":"x"') : l)).join('\n') + '\n',
  };
  for (const [name, body] of Object.entries(cases)) {
    fs.writeFileSync(h.cache, body);
    const sc = scanner(h, { cacheFile: h.cache });
    const r = runToEnd(sc).r;
    assert.strictEqual(r.cache.state, 'rebuilt', name);
    assert.deepStrictEqual(r.days, fresh.days, name);
    assert.deepStrictEqual(r.byModel, fresh.byModel, name);
    assert.strictEqual(JSON.parse(fs.readFileSync(h.cache, 'utf8').split('\n')[0]).kind, 'agent-monitor-history', name + ': rewritten');
  }
  // A cache path that cannot be written: the scan still works, the error is reported
  const blocker = path.join(h.base, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const r = runToEnd(scanner(h, { cacheFile: path.join(blocker, 'c.jsonl') })).r;
  assert.ok(r.cache.error, 'write error reported');
  assert.deepStrictEqual(r.days, fresh.days);
  // Throttle: while a pass is running, at most one save per saveMs
  const renames = [];
  const orig = fs.renameSync;
  fs.renameSync = function (a, b) { renames.push(b); return orig.call(fs, a, b); };
  try {
    fs.rmSync(h.cache, { force: true });
    const sc = scanner(h, { cacheFile: h.cache, budgetBytes: 300, saveMs: 60e3 });
    let x = sc.step(NOW);
    let n = 0;
    while (x.partial && n++ < 500) x = sc.step(NOW + n);
    assert.ok(n > 3);
    assert.strictEqual(renames.length, 2, 'once at the first slice, once when the pass completed');
    sc.step(NOW + n + 1);
    assert.strictEqual(renames.length, 2, 'nothing changed: no save');
  } finally { fs.renameSync = orig; }
});

// ---------- Monitor and worker plumbing ----------

test('normalizeConfig: historyCacheFile defaults to null (no persistence), history budget to 16 MB', () => {
  const c = normalizeConfig({}, {});
  assert.strictEqual(c.historyCacheFile, null);
  assert.strictEqual(c.historyBudgetBytesPerTick, 16 * 1024 * 1024);
  const d = normalizeConfig({ historyCacheFile: '/x/history.jsonl', historyBudgetBytesPerTick: 1000 }, {});
  assert.deepStrictEqual([d.historyCacheFile, d.historyBudgetBytesPerTick], ['/x/history.jsonl', 1000]);
  assert.strictEqual(normalizeConfig({ historyCacheFile: 42 }, {}).historyCacheFile, null);
});

function monitorCfg(h, extra = {}) {
  return {
    claude: { projectsDir: h.claudeDir, home: path.join(h.base, 'claude') },
    codex: { home: h.codexHome },
    // Point the other providers at missing dirs so the real VS Code / ~/.gemini / ~/.qwen folders are never read
    copilot: { userDir: path.join(h.base, 'no-vscode', 'User') },
    gemini: { home: path.join(h.base, 'no-gemini'), homeSource: 'setting' },
    qwen: { home: path.join(h.base, 'no-qwen') },
    daily: false,
    historyCacheFile: h.cache,
    ...extra,
  };
}

test('Monitor.history: steps until complete, same numbers as the scanner; release / dispose saves the cache and frees the scanner', () => {
  const h = makeHome();
  fixture(h);
  const mon = new Monitor(monitorCfg(h, { historyBudgetBytesPerTick: 400 }));
  assert.strictEqual(mon.historyScanner, null, 'nothing is built until asked');
  let r = mon.history({ now: NOW });
  let n = 0;
  while (r.partial && n++ < 500) r = mon.history({ now: NOW });
  assert.strictEqual(r.partial, false);
  assert.ok(n > 2);
  const direct = runToEnd(scanner(h)).r;
  assert.deepStrictEqual(r.days, direct.days);
  assert.deepStrictEqual(r.byModel, direct.byModel);
  mon.historyRelease();
  assert.strictEqual(mon.historyScanner, null);
  assert.ok(fs.existsSync(h.cache), 'saved on release');
  const r7 = mon.history({ now: NOW, days: 7 });
  assert.strictEqual(r7.cache.state, 'loaded');
  assert.strictEqual(r7.days.length, 7);
  mon.dispose();
  assert.strictEqual(mon.historyScanner, null);
  // Codex disabled: only Claude is scanned
  const only = new Monitor(monitorCfg(h, { codex: { enabled: false, home: h.codexHome }, historyCacheFile: null }));
  let x = only.history({ now: NOW });
  while (x.partial) x = only.history({ now: NOW });
  assert.deepStrictEqual(x.sources, { claude: true, codex: false });
  assert.strictEqual(x.totals.codex.tokens, 0);
  only.dispose();
});

// Collect worker messages; next(pred) waits for the next matching one
function messages(w) {
  const seen = [];
  const waiters = [];
  w.on('message', (m) => {
    seen.push(m);
    for (const x of waiters.splice(0)) if (!x.done(m)) waiters.push(x);
  });
  return {
    seen,
    next(pred, ms = 30000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a worker message')), ms);
        waiters.push({ done: (m) => { if (!pred(m)) return false; clearTimeout(timer); resolve(m); return true; } });
      });
    },
  };
}

// Transcripts relative to the real clock (the worker uses Date.now())
function liveHome() {
  const h = makeHome();
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(cl('w' + i, now - 3600e3 + i * 1000, 'claude-haiku-4-5', u(100, 10)));
  writeRows(path.join(h.proj, 'live.jsonl'), rows, now - 1000);
  return h;
}

test('worker: history replies after every slice until complete, without slowing snapshots; release saves the cache', async () => {
  const h = liveHome();
  const w = new Worker(path.join(ROOT, 'lib', 'worker.js'), { workerData: { ...monitorCfg(h), intervalMs: 60000, historyBudgetBytesPerTick: 1500, codex: { enabled: false, home: h.codexHome } } });
  const q = messages(w);
  try {
    await q.next((m) => m.type === 'snapshot');
    w.postMessage({ type: 'history', days: 7 });
    const first = await q.next((m) => m.type === 'history');
    assert.strictEqual(first.partial, true, 'a small budget needs several slices');
    assert.ok(first.progress.totalBytes > 0);
    const done = await q.next((m) => m.type === 'history' && !m.partial);
    assert.strictEqual(done.days.length, 7);
    assert.strictEqual(done.totals.claude.tokens, 40 * 110);
    assert.ok(q.seen.filter((m) => m.type === 'history').length >= 3);
    assert.ok(!q.seen.some((m) => m.type === 'error'), JSON.stringify(q.seen.filter((m) => m.type === 'error')));
    // A later request is answered at once from memory
    w.postMessage({ type: 'history', days: 7 });
    const again = await q.next((m) => m.type === 'history');
    assert.strictEqual(again.partial, false);
    assert.deepStrictEqual(again.days, done.days);
    w.postMessage({ type: 'history', release: true });
    w.postMessage({ type: 'refresh' });
    await q.next((m) => m.type === 'snapshot');
    assert.ok(fs.existsSync(h.cache), 'release saved the cache');
  } finally {
    await w.terminate();
  }
});

test('worker: a paused follower still answers history (from the shared cache) and stays paused', async () => {
  const h = liveHome();
  const w = new Worker(path.join(ROOT, 'lib', 'worker.js'), { workerData: { ...monitorCfg(h), intervalMs: 60000, paused: true, codex: { enabled: false, home: h.codexHome } } });
  const q = messages(w);
  try {
    w.postMessage({ type: 'history', force: true });
    const done = await q.next((m) => m.type === 'history' && !m.partial);
    assert.strictEqual(done.windowDays, 30);
    assert.strictEqual(done.totals.claude.tokens, 40 * 110);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!q.seen.some((m) => m.type === 'snapshot'), 'no snapshot while paused');
    w.postMessage({ type: 'history', release: true });
    const w2 = new Worker(path.join(ROOT, 'lib', 'worker.js'), { workerData: { ...monitorCfg(h), intervalMs: 60000, paused: true, codex: { enabled: false, home: h.codexHome } } });
    try {
      const q2 = messages(w2);
      await new Promise((r) => setTimeout(r, 200));
      w2.postMessage({ type: 'history' });
      const r2 = await q2.next((m) => m.type === 'history');
      assert.strictEqual(r2.cache.state, 'loaded', 'another window reuses the saved cache');
      assert.strictEqual(r2.totals.claude.tokens, 40 * 110);
    } finally {
      await w2.terminate();
    }
  } finally {
    await w.terminate();
  }
});

// ---------- View model, page HTML and panel ----------

const HV = require('../lib/history-view');
const en = i18nLib.createI18n('en', { timeZone: 'America/Los_Angeles' });
const LOCALES = ['en', 'zh-cn', 'zh-tw', 'ko', 'ja'];

function fullReport() {
  const h = makeHome();
  fixture(h);
  return runToEnd(scanner(h)).r;
}

test('view model: totals, stacked bars with round axis ticks, table rows by model, price-date note', () => {
  const r = fullReport();
  const vm = HV.buildHistoryVm({ report: r, i18n: en, now: NOW });
  assert.strictEqual(vm.busy, false);
  assert.ok(vm.statusText.startsWith('Last 30 days'), vm.statusText);
  assert.strictEqual(vm.progress, null);
  assert.strictEqual(vm.empty, null);
  assert.deepStrictEqual(vm.totals.map((x) => x.key), ['cost', 'tokens', 'claude', 'codex', 'avg']);
  assert.ok(vm.totals[0].value.endsWith('+'), 'part of the usage has no public price: marked with +');
  assert.ok(vm.unpricedText.includes('22'));
  const c = vm.chart;
  assert.strictEqual(c.bars.length, 30);
  assert.strictEqual(c.bars[29].today, true);
  assert.ok(c.bars[29].long.includes('today'));
  assert.deepStrictEqual(c.bars.filter((b) => b.tick).length, 5);
  for (const m of ['cost', 'tokens']) {
    const max = Math.max(...c.bars.map((b) => b[m][0] + b[m][1]));
    assert.ok(c.axis[m].top >= max && c.axis[m].top < max * 2.6, `${m} axis top ${c.axis[m].top} for max ${max}`);
    assert.strictEqual(c.axis[m].ticks[0].value, 0);
    assert.ok(c.label[m].includes('Highest'));
  }
  const today = c.bars[29];
  assert.strictEqual(today.tokens[0], dayRow(r, day(0)).claude.tokens);
  assert.ok(today.aria.cost.includes('Claude Code') && today.aria.cost.includes('Codex'));
  const m = vm.models;
  assert.deepStrictEqual(m.cols.map((x) => x.key), ['model', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'cost']);
  assert.strictEqual(m.rows.length, r.byModel.length);
  const mystery = m.rows.find((x) => x.model === 'claude-mystery-9');
  assert.strictEqual(mystery.cells.cost.text, en.t('cost.unpriced'));
  assert.strictEqual(m.rows.find((x) => x.model === 'claude-opus-5-5').cells.reasoning.text, '—');
  assert.ok(vm.notes.items[0].includes(pricing.PRICES_UPDATED), 'estimate note with the price table date');
  assert.deepStrictEqual(HV._internal.niceTicks(0.37), { top: 0.4, ticks: [0, 0.1, 0.2, 0.3, 0.4] });
  assert.deepStrictEqual(HV._internal.niceTicks(930).ticks, [0, 250, 500, 750, 1000]);
  assert.strictEqual(HV._internal.fmtDate('2026-09-24', en, { month: 'short', day: 'numeric' }), 'Sep 24');
  // Neighbouring cost ticks never print the same label (0.005 steps used to show "$0.01" twice)
  for (const max of [0.012, 0.0004, 0.37, 2.4, 13, 930, 18000]) {
    const { ticks } = HV._internal.niceTicks(max);
    const step = ticks[1] - ticks[0];
    const labels = ticks.map((v) => HV._internal.fmtAxisUsd(v, en, step));
    assert.strictEqual(new Set(labels).size, labels.length, `distinct labels for max ${max}: ${labels.join(' ')}`);
  }
  assert.deepStrictEqual(HV._internal.niceTicks(0.012).ticks.map((v) => HV._internal.fmtAxisUsd(v, en, 0.005)), ['$0', '$0.005', '$0.01', '$0.015']);
});

test('view model: loading, still scanning, empty and error states', () => {
  const loading = HV.buildHistoryVm({ report: null, loading: true, i18n: en, now: NOW });
  assert.strictEqual(loading.statusText, en.t('history.page.loading'));
  assert.strictEqual(loading.chart, null);
  const r = fullReport();
  const partial = HV.buildHistoryVm({ report: { ...r, partial: true, progress: { doneBytes: 999, totalBytes: 1000, filesDone: 1, filesTotal: 3 } }, i18n: en, now: NOW });
  assert.strictEqual(partial.busy, true);
  assert.strictEqual(partial.progress.pct, 99, 'never 100% while scanning');
  assert.strictEqual(partial.progress.text, 'Still scanning… 99%');
  assert.strictEqual(partial.progress.detail, '1 of 3 files');
  const empty = HV.buildHistoryVm({ report: H.emptyHistoryReport(30, NOW), i18n: en, now: NOW });
  assert.ok(empty.empty && empty.empty.title.includes('30'));
  assert.strictEqual(empty.chart, null);
  assert.strictEqual(empty.models, null);
  const off = HV.buildHistoryVm({ report: { ...H.emptyHistoryReport(30, NOW), sources: { claude: false, codex: false } }, i18n: en, now: NOW });
  assert.strictEqual(off.empty.hint, en.t('history.empty.disabled'));
  const scanningEmpty = HV.buildHistoryVm({ report: { ...H.emptyHistoryReport(30, NOW), partial: true }, i18n: en, now: NOW });
  assert.strictEqual(scanningEmpty.empty, null, 'no "empty" while still scanning');
  const err = HV.buildHistoryVm({ report: { at: NOW, days: [], byModel: [], totals: null, partial: false, error: 'boom\nstack' }, i18n: en, now: NOW });
  assert.strictEqual(err.errorText, "Couldn't read the usage history: boom");
  const err2 = HV.buildHistoryVm({ report: null, error: 'timeout', i18n: en, now: NOW });
  assert.ok(err2.errorText.includes('timeout'));
  // Every language builds without missing keys (a missing key would show up as its name)
  for (const loc of LOCALES) {
    const i18n = i18nLib.createI18n(loc);
    const json = JSON.stringify(HV.buildHistoryVm({ report: { ...r, partial: true }, i18n, now: NOW }));
    assert.ok(!/"history\.[\w.]+"/.test(json.replace(/"(?:history\.[\w.]+)":/g, '')), `${loc}: untranslated key in the view model`);
  }
});

test('view model: screen-reader announcements only on scan start / finish; an error stops the spinner and progress; zero reads $0.00; scope note', () => {
  const r = fullReport();
  const loading = HV.buildHistoryVm({ report: null, loading: true, i18n: en, now: NOW });
  assert.strictEqual(loading.liveText, en.t('history.page.loading'));
  const partialRep = { ...r, partial: true, progress: { doneBytes: 5, totalBytes: 10, filesDone: 1, filesTotal: 2 } };
  const partial = HV.buildHistoryVm({ report: partialRep, i18n: en, now: NOW });
  assert.strictEqual(partial.liveText, en.t('history.page.loading'), 'the same text for every progress step: announced once');
  assert.strictEqual(HV.buildHistoryVm({ report: { ...partialRep, progress: { doneBytes: 9, totalBytes: 10 } }, i18n: en, now: NOW }).liveText, partial.liveText);
  const done = HV.buildHistoryVm({ report: r, i18n: en, now: NOW });
  const later = HV.buildHistoryVm({ report: { ...r, at: r.at + 60e3 }, loading: true, i18n: en, now: NOW + 60e3 });
  assert.strictEqual(done.liveText, en.t('history.live.done'));
  assert.strictEqual(later.liveText, done.liveText, 'the minute-by-minute refresh is not announced again');
  // The scanner stopped answering in the middle of a scan: no endless spinner or progress bar next to the error
  const stuck = HV.buildHistoryVm({ report: partialRep, error: en.t('history.page.noReply'), i18n: en, now: NOW });
  assert.strictEqual(stuck.busy, false);
  assert.strictEqual(stuck.progress, null);
  assert.strictEqual(stuck.liveText, '', 'the error banner (role=alert) speaks instead');
  assert.ok(stuck.errorText.includes(en.t('history.page.noReply')));
  assert.ok(stuck.chart, 'numbers read so far stay visible');
  // Nothing spent: "$0.00", not "$0.000"
  const codexOnly = { ...r, days: r.days.map((d) => ({ ...d, codex: { usd: 0, tokens: 0, unpricedTokens: 0 } })) };
  const vm = HV.buildHistoryVm({ report: codexOnly, i18n: en, now: NOW });
  assert.ok(vm.chart.bars.every((b) => b.text.cost.codex === '$0.00'), vm.chart.bars[0].text.cost.codex);
  const empty = HV.buildHistoryVm({ report: H.emptyHistoryReport(30, NOW), i18n: en, now: NOW });
  assert.deepStrictEqual(empty.totals.filter((x) => x.key !== 'tokens').map((x) => x.value), ['$0.00', '$0.00', '$0.00', '$0.00']);
  assert.ok(done.notes.items.includes(en.t('history.note.scope')), 'says Copilot / Gemini CLI / Qwen Code are not counted');
  for (const loc of LOCALES) {
    const i18n = i18nLib.createI18n(loc);
    for (const k of ['history.live.done', 'history.note.scope']) assert.ok(i18n.t(k) !== k, `${loc}: ${k}`);
  }
});

test('page HTML: CSP with a nonce, no inline handlers or inline styles; the webview script renders only text', () => {
  const html = HV.historyHtml({ cspSource: 'vscode-resource:', nonce: 'abc123', i18n: en, asset: (p) => 'vscode-resource:/media/' + p });
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(csp, 'CSP present');
  csp[1] = csp[1].replace(/&#39;/g, "'");
  assert.ok(csp[1].includes("default-src 'none'") && csp[1].includes("script-src 'nonce-abc123'"), csp[1]);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp[1]));
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handlers');
  assert.ok(!/\sstyle\s*=/i.test(html), 'no inline style attributes');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  for (const a of scripts) assert.ok(a.includes('nonce="abc123"') || a.includes('type="application/json"'), a);
  assert.ok(html.includes('media/history.js') && html.includes('media/history.css') && html.includes('codicons/codicon.css'));
  const l10n = JSON.parse(/<script type="application\/json" id="l10n">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.strictEqual(l10n.dict['history.page.loading'], en.t('history.page.loading'));
  const js = fs.readFileSync(path.join(ROOT, 'media', 'history.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), 'DOM built from text only');
  assert.ok(!/setAttribute\(\s*['"]style['"]/.test(js), 'styles only through the CSSOM');
  assert.ok(!/querySelector(All)?\([^)]*\+/.test(js), 'no selectors built from data (dates, model names)');
  // One polite live region for scan start / finish; the header line (its "updated" time changes every minute) is not live
  assert.ok(/<p id="live" class="sr-only" role="status" aria-live="polite"/.test(html));
  assert.ok(!/<span id="status"[^>]*role=/.test(html) && !/id="root"[^>]*aria-live/.test(html));
  assert.ok(/bodyKey/.test(js), 'a header-only change keeps the page body (focus and a screen reader\'s place)');
  const css = fs.readFileSync(path.join(ROOT, 'media', 'history.css'), 'utf8');
  assert.ok(!/url\(\s*['"]?https?:/i.test(css), 'no remote resources');
  assert.ok(/vscode-high-contrast/.test(css) && /max-width:\s*640px/.test(css), 'high-contrast and narrow rules');
});

function fakeVscode() {
  const posted = [];
  const h = { onMsg: null, onDispose: null, onView: null };
  const panel = {
    visible: true,
    webview: {
      cspSource: 'vscode-resource:', html: '',
      asWebviewUri: (u) => ({ toString: () => 'vscode-resource:' + u.path }),
      postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: (fn) => { h.onMsg = fn; return { dispose() {} }; },
    },
    onDidDispose: (fn) => { h.onDispose = fn; return { dispose() {} }; },
    onDidChangeViewState: (fn) => { h.onView = fn; return { dispose() {} }; },
    reveal() {},
    dispose() { if (h.onDispose) h.onDispose(); },
  };
  const vscode = {
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/') }) },
    ViewColumn: { Active: 1 },
    window: { createWebviewPanel: () => panel },
  };
  return { vscode, panel, posted, h };
}

test('panel: asks on open, posts the view model after ready, throttles progress, refresh forces, closing releases the scanner', async () => {
  const f = fakeVscode();
  const requests = [];
  let listener = null;
  let unsubscribed = false;
  const deps = {
    vscode: f.vscode, i18n: en,
    requestHistory: (req) => requests.push(req),
    onHistory: (fn) => { listener = fn; return { dispose() { unsubscribed = true; } } },
  };
  const panel = HV.openHistory({ extensionUri: { path: '/ext' } }, deps);
  assert.deepStrictEqual(requests, [{ days: 30, force: false }]);
  assert.ok(f.panel.webview.html.includes('Content-Security-Policy'));
  assert.strictEqual(f.posted.length, 0, 'nothing posted before the page is ready');
  await f.h.onMsg({ type: 'ready' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(f.posted.length, 1);
  assert.strictEqual(f.posted[0].vm.statusText, en.t('history.page.loading'));
  const r = fullReport();
  listener({ type: 'history', ...r, partial: true, progress: { doneBytes: 1, totalBytes: 10, filesDone: 0, filesTotal: 2 } });
  listener({ type: 'history', ...r, partial: true, progress: { doneBytes: 5, totalBytes: 10, filesDone: 1, filesTotal: 2 } });
  const burst = f.posted.length;
  assert.ok(burst <= 2, 'progress posts are throttled');
  await new Promise((r) => setTimeout(r, 320));
  assert.strictEqual(f.posted[f.posted.length - 1].vm.progress.pct, 50, 'the latest progress arrives');
  listener({ type: 'history', ...r });
  const last = f.posted[f.posted.length - 1].vm;
  assert.strictEqual(last.progress, null);
  assert.strictEqual(last.busy, false);
  assert.strictEqual(HV.openHistory({ extensionUri: { path: '/ext' } }, deps), panel, 'singleton: reveal instead of a second panel');
  await f.h.onMsg({ type: 'refresh' });
  assert.deepStrictEqual(requests[requests.length - 1], { days: 30, force: true });
  await f.h.onMsg({ type: 'unknown', path: '/etc/passwd' });
  f.panel.dispose();
  assert.deepStrictEqual(requests[requests.length - 1], { release: true });
  assert.strictEqual(unsubscribed, true);
  assert.strictEqual(panel.disposed, true);
});

test('l10n: every history key used by the page exists in English, placeholders are {word}, no CJK in English', () => {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'history.en.json'), 'utf8'));
  for (const [k, v] of Object.entries(dict)) {
    assert.ok(k.startsWith('history.'), k);
    assert.ok(typeof v === 'string' && v.trim(), k);
    for (const m of v.matchAll(/\{([^{}]*)\}/g)) assert.ok(/^\w+$/.test(m[1]), `${k} placeholder {${m[1]}}`);
  }
  assert.ok(!/[぀-ヿ㐀-鿿가-힯]/.test(JSON.stringify(dict)));
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'history-view.js'), 'utf8');
  const keys = new Set([...src.matchAll(/'(history\.[\w.]+[\w])'/g)].map((m) => m[1]).filter((k) => !/\.(js|css)$/.test(k)));
  const dyn = ['history.app.claude', 'history.app.codex', 'history.chart.summary.cost', 'history.chart.summary.tokens'];
  const missing = [...keys, ...dyn].filter((k) => !(k in dict));
  assert.deepStrictEqual(missing, []);
  for (const loc of LOCALES.slice(1)) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', `history.${loc}.json`), 'utf8'));
    assert.deepStrictEqual(Object.keys(d).sort(), Object.keys(dict).sort(), loc);
  }
});

// ---------- Run ----------

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name}\n        ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n        ')}`);
    }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch { /* ignore */ }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
