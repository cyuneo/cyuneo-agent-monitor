'use strict';
// Unit tests for lib/core/* and lib/i18n.js. Run with plain Node: node test/core.test.js
// All data is synthetic; nothing is read from ~/.claude or ~/.codex. Temp files go under AGENT_MONITOR_TEST_TMP (or the system temp dir if unset) and are deleted afterwards.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { JsonlTail, substringFilter, readJsonlSync } = require('../lib/core/jsonl');
const status = require('../lib/core/status');
const pricing = require('../lib/core/pricing');
const quota = require('../lib/core/quota');
const context = require('../lib/core/context');
const resume = require('../lib/core/resume');
const i18n = require('../lib/i18n');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-core-'));

// ---------- Helpers ----------

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(true);
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`  FAIL  ${name}\n        ${String((err && err.stack) || err).split('\n').slice(0, 4).join('\n        ')}`);
  }
}
const approx = (a, b, eps = 1e-9, msg) => assert.ok(a != null && Math.abs(a - b) <= eps, msg || `${a} ≠ ${b}`);
const cents = (a, b, msg) => assert.strictEqual(a == null ? a : Number(a.toFixed(2)), b, msg);
const T = (iso) => Date.parse(iso);
const line = (o) => JSON.stringify(o) + '\n';
let fileNo = 0;
const tmpFile = (name) => path.join(TMP, `${++fileNo}-${name}`);

// ---------- JsonlTail ----------

function jsonlTests() {
  const push = (arr, e) => { arr.push(e); };

  test('incremental read: only new bytes are read; a partial line waits for the next poll', () => {
    const f = tmpFile('a.jsonl');
    fs.writeFileSync(f, line({ n: 1 }) + '{"n":');
    const r = new JsonlTail(f, () => [], push);
    assert.strictEqual(r.poll(), true);
    assert.deepStrictEqual(r.state.map((e) => e.n), [1]);
    assert.strictEqual(r.poll(), false, 'no read when nothing changed');
    fs.appendFileSync(f, '2}\n' + line({ n: 3 }));
    assert.strictEqual(r.poll(), true);
    assert.deepStrictEqual(r.state.map((e) => e.n), [1, 2, 3]);
    assert.strictEqual(r.offset, fs.statSync(f).size);
  });

  test('bad lines are skipped without affecting later lines', () => {
    const f = tmpFile('bad.jsonl');
    fs.writeFileSync(f, '{oops\n' + line({ n: 1 }) + '\nnull\n123\n' + line({ n: 2 }));
    const r = new JsonlTail(f, () => [], push);
    r.poll();
    assert.deepStrictEqual(r.state.map((e) => e.n), [1, 2]);
  });

  test('file got shorter (truncated/rewritten): restart from the beginning and rebuild state', () => {
    const f = tmpFile('trunc.jsonl');
    fs.writeFileSync(f, line({ n: 1 }) + line({ n: 2 }) + line({ n: 3 }));
    let inits = 0;
    const r = new JsonlTail(f, () => { inits++; return []; }, push);
    r.poll();
    assert.strictEqual(r.state.length, 3);
    fs.writeFileSync(f, line({ n: 9 }));
    r.poll();
    assert.deepStrictEqual(r.state.map((e) => e.n), [9]);
    assert.strictEqual(inits, 2);
    assert.strictEqual(r.resets, 1);
  });

  test('file replaced by a new one (inode changed, not shorter): also restart from the beginning', () => {
    const f = tmpFile('swap.jsonl');
    fs.writeFileSync(f, line({ n: 1 }));
    const r = new JsonlTail(f, () => [], push);
    r.poll();
    const g = f + '.new';
    fs.writeFileSync(g, line({ n: 7 }) + line({ n: 8 }));
    fs.renameSync(g, f);
    r.poll();
    assert.deepStrictEqual(r.state.map((e) => e.n), [7, 8]);
  });

  test('prefilter: lines without the substring are neither decoded nor parsed', () => {
    const f = tmpFile('pf.jsonl');
    fs.writeFileSync(f, line({ type: 'user', usage: null }) + '{not json but skipped}\n'
      + line({ type: 'assistant', message: { usage: { output_tokens: 3 } } }) + line({ type: 'x' }));
    const r = new JsonlTail(f, () => [], push, { prefilter: substringFilter('"usage"') });
    r.poll();
    assert.strictEqual(r.state.length, 2);
    assert.strictEqual(r.skipped, 2);
    assert.strictEqual(r.lines, 2);
    const multi = substringFilter('"token_count"', '"turn_context"');
    assert.ok(multi(Buffer.from('{"type":"turn_context"}')));
    assert.ok(!multi(Buffer.from('{"type":"response_item"}')));
  });

  test('large files are read in 1MB chunks: a very long line spanning several chunks, chunk boundaries inside multibyte characters and a trailing partial line all match line-by-line parsing', () => {
    const f = tmpFile('big.jsonl');
    const rows = [];
    for (let i = 0; i < 3000; i++) rows.push({ i, s: '中文テスト한국어'.repeat(1 + (i % 13)), usage: i % 3 === 0 ? { n: i } : undefined });
    rows.splice(1500, 0, { i: -1, big: '长'.repeat(1200000), usage: { n: -1 } }); // one line of about 3.6MB, spanning 4 chunks
    const text = rows.map((o) => JSON.stringify(o)).join('\n') + '\n';
    fs.writeFileSync(f, text + '{"i":9999,"s":"半');
    assert.ok(Buffer.byteLength(text) > 3.5 * 1048576, 'file must span several chunks');
    const all = new JsonlTail(f, () => [], push);
    assert.strictEqual(all.poll(), true);
    assert.deepStrictEqual(all.state.map((e) => e.i), rows.map((o) => o.i));
    assert.strictEqual(all.state[1500].big.length, 1200000);
    assert.strictEqual(all.bytesRead, fs.statSync(f).size);
    fs.appendFileSync(f, '行"}\n');
    all.poll();
    assert.deepStrictEqual(all.state[all.state.length - 1], { i: 9999, s: '半行' }, 'trailing partial line is completed');
    assert.strictEqual(all.carry, null);
    // with a prefilter: skipped lines are chunked the same way
    const pf = new JsonlTail(f, () => [], push, { prefilter: substringFilter('"usage"') });
    pf.poll();
    assert.deepStrictEqual(pf.state.map((e) => e.i), rows.filter((o) => o.usage).map((o) => o.i));
    assert.strictEqual(pf.lines + pf.skipped, rows.length + 1);
  });

  test('an over-long line (beyond maxLine) is skipped whole while the lines around it are read normally, also across two polls', () => {
    const f = tmpFile('huge-line.jsonl');
    const huge = JSON.stringify({ n: 'huge', x: 'y'.repeat(3 * 1048576) });
    fs.writeFileSync(f, line({ n: 1 }) + huge.slice(0, 2500000));
    const r = new JsonlTail(f, () => [], push, { maxLine: 2 * 1048576 });
    r.poll();
    assert.deepStrictEqual(r.state.map((e) => e.n), [1]);
    assert.strictEqual(r.dropping, true, 'over the limit: discard up to the next newline');
    assert.strictEqual(r.carry, null, 'stops buffering this line');
    fs.appendFileSync(f, huge.slice(2500000) + '\n' + line({ n: 2 }));
    r.poll();
    assert.deepStrictEqual(r.state.map((e) => e.n), [1, 2]);
    assert.strictEqual(r.dropping, false);
    assert.strictEqual(r.skipped, 1);
    // the default limit is large enough: the same file yields the long line normally
    const d = new JsonlTail(f, () => [], push);
    d.poll();
    assert.deepStrictEqual(d.state.map((e) => e.n), [1, 'huge', 2]);
  });

  test('poll(maxBytes): reading in slices gives the same result as one full read (including multibyte characters split across slices)', () => {
    const f = tmpFile('budget.jsonl');
    let text = '';
    for (let i = 0; i < 40; i++) text += line({ i, s: '中文テスト한국어' + 'x'.repeat(i % 7) });
    fs.writeFileSync(f, text);
    const whole = new JsonlTail(f, () => [], push);
    whole.poll();
    const part = new JsonlTail(f, () => [], push, { prefilter: () => true });
    let rounds = 0;
    while (part.remaining() > 0 || rounds === 0) { part.poll(37); rounds++; if (rounds > 1000) break; }
    assert.ok(rounds > 10);
    const zero = new JsonlTail(f, () => [], push);
    assert.strictEqual(zero.poll(0), false, 'no read with a budget of 0');
    assert.strictEqual(zero.offset, 0);
    assert.strictEqual(zero.remaining(), fs.statSync(f).size);
    assert.deepStrictEqual(part.state, whole.state);
    assert.strictEqual(part.remaining(), 0);
  });

  test('missing file: poll returns false without throwing; readJsonlSync reads a small file', () => {
    const r = new JsonlTail(path.join(TMP, 'nope.jsonl'));
    assert.strictEqual(r.poll(), false);
    const f = tmpFile('idx.jsonl');
    fs.writeFileSync(f, line({ id: 'a', thread_name: 'x' }) + line({ id: 'a', thread_name: 'y' }));
    assert.deepStrictEqual(readJsonlSync(f).map((e) => e.thread_name), ['x', 'y']);
  });
}

// ---------- Status codes and lamps ----------

function statusTests() {
  const { STATUS, LAMP } = status;

  test('status code → lamp', () => {
    const lamp = (code, extra, opts) => status.lampForStatus(status.makeStatus(code, 0, extra), opts);
    for (const c of ['starting', 'thinking', 'tool', 'retrying', 'idleBackground']) assert.strictEqual(lamp(c), LAMP.WORKING, c);
    for (const c of ['awaitingApproval', 'awaitingInput', 'dialogOpen', 'maybeAwaitingApproval']) assert.strictEqual(lamp(c), LAMP.NEEDS_YOU, c);
    assert.strictEqual(lamp('done'), LAMP.DONE_UNSEEN);
    assert.strictEqual(lamp('done', {}, { seen: true }), LAMP.DONE_SEEN);
    assert.strictEqual(lamp('interrupted'), LAMP.IDLE);
    assert.strictEqual(lamp('killed'), LAMP.IDLE);
    assert.strictEqual(lamp('quota'), LAMP.ERROR);
    assert.strictEqual(lamp('apiError'), LAMP.ERROR);
    // stale defaults to Idle; the legacy staleAsNeedsYou setting can still turn a stale agent with a pending call into NeedsYou
    assert.strictEqual(lamp('stale', { stalePending: true }), LAMP.IDLE);
    assert.strictEqual(lamp('stale', { stalePending: true }, { staleAsNeedsYou: true }), LAMP.NEEDS_YOU);
    assert.strictEqual(lamp('stale', { stalePending: false }, { staleAsNeedsYou: true }), LAMP.IDLE);
    assert.strictEqual(status.lampForStatus(null), LAMP.IDLE);
    for (const c of status.STATUS_CODES) assert.ok(c in status.STATUS_LAMP, `STATUS_LAMP is missing ${c}`);
  });

  test('certain vs. guessed: registry signals are certain, the fast-tool heuristic is a guess', () => {
    assert.strictEqual(status.makeStatus(STATUS.MAYBE_AWAITING_APPROVAL, 1).certainty, 'guess');
    assert.strictEqual(status.makeStatus(STATUS.AWAITING_APPROVAL, 1).certainty, 'certain');
    assert.ok(status.isGuessCode('maybeAwaitingApproval'));
    assert.ok(!status.isGuessCode('awaitingApproval'));
    assert.ok(status.isNeedsYouCode('dialogOpen') && status.isNeedsYouCode('maybeAwaitingApproval'));
    const reg = (s, w) => status.statusFromRegistry({ status: s, waitingFor: w, statusUpdatedAt: 1789405200123 });
    assert.strictEqual(reg('waiting', 'permission prompt').code, 'awaitingApproval');
    assert.strictEqual(reg('waiting', 'input needed').code, 'awaitingInput');
    assert.strictEqual(reg('waiting', 'dialog open').code, 'dialogOpen');
    assert.strictEqual(reg('waiting', 'permission prompt').certainty, 'certain');
    assert.strictEqual(reg('waiting', 'dialog open').sinceMs, 1789405200123);
    assert.strictEqual(reg('waiting', 'dialog open').waitingFor, 'dialog open');
    assert.strictEqual(reg('busy', null), null);
    assert.strictEqual(reg('idle', null), null);
    assert.strictEqual(status.statusFromRegistry(null), null);
    assert.strictEqual(status.statusFromRegistry({ status: 'waiting', waitingFor: 'input needed', updatedAt: 1789405200 }).sinceMs, 1789405200000, 'seconds are converted to milliseconds');
  });

  test('fast-tool list', () => {
    assert.deepStrictEqual([...status.FAST_TOOLS.claude],
      ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'TodoWrite', 'WebFetch']);
    assert.ok(status.isFastTool('codex', 'apply_patch'));
    assert.ok(!status.isFastTool('claude', 'Bash'));
    assert.ok(!status.isFastTool('codex', 'exec_command'));
    assert.ok(!status.isFastTool('claude', 'apply_patch'));
  });

  test('"may be waiting for your approval" heuristic: fastTools / allTools / off / registry present', () => {
    const now = 1_000_000_000;
    const g = (o) => status.guessAwaitingApproval({ provider: 'claude', now, ...o });
    assert.deepStrictEqual(g({ pending: [{ tool: 'Edit', sinceMs: now - 61e3 }] }), { tool: 'Edit', sinceMs: now - 61e3 });
    assert.strictEqual(g({ pending: [{ tool: 'Edit', sinceMs: now - 59e3 }] }), null, 'under 60 seconds');
    assert.strictEqual(g({ pending: [{ tool: 'Bash', sinceMs: now - 3600e3 }] }), null, 'Bash is never guessed');
    assert.strictEqual(g({ pending: [{ tool: 'Edit', sinceMs: now - 61e3 }], hasRegistry: true }), null, 'no guessing when a registry entry exists');
    assert.strictEqual(g({ pending: [{ tool: 'Edit', sinceMs: now - 61e3 }], mode: 'off' }), null);
    assert.ok(g({ pending: [{ tool: 'Read', sinceMs: now - 20e3 }], seconds: 15 }), 'custom seconds');
    // several pending calls: pick the earliest one that matches
    const hit = g({ pending: [{ tool: 'Bash', sinceMs: now - 900e3 }, { tool: 'Grep', sinceMs: now - 70e3 }, { tool: 'Read', sinceMs: now - 90e3 }] });
    assert.strictEqual(hit.tool, 'Read');
    // allTools uses staleMinutes
    assert.ok(g({ mode: 'allTools', staleMinutes: 5, pending: [{ tool: 'Bash', sinceMs: now - 301e3 }] }));
    assert.strictEqual(g({ mode: 'allTools', staleMinutes: 5, pending: [{ tool: 'Bash', sinceMs: now - 240e3 }] }), null);
    // Codex
    const c = (tool) => status.guessAwaitingApproval({ provider: 'codex', now, pending: [{ tool, sinceMs: now - 120e3 }] });
    assert.ok(c('apply_patch'));
    assert.strictEqual(c('exec_command'), null);
    assert.strictEqual(g({ pending: [] }), null);
  });

  test('session lamp follows derivation priority; overall lamp follows display urgency', () => {
    assert.strictEqual(status.pickDerived(['doneUnseen', 'working']), 'working');
    assert.strictEqual(status.pickSevere(['doneUnseen', 'working']), 'doneUnseen');
    assert.strictEqual(status.pickDerived(['idle', 'error', 'needsYou']), 'needsYou');
    assert.strictEqual(status.pickSevere([]), 'idle');
    assert.strictEqual(status.pickDerived([]), 'idle');
  });

  test('color ids, CSS variables, palette', () => {
    assert.strictEqual(status.LAMP_CSS_VAR.working, '--vscode-agentMonitor-lampWorking');
    assert.strictEqual(status.LAMP_COLOR_ID.needsYou, 'agentMonitor.lampNeedsYou');
    assert.strictEqual(status.LAMP_COLORS.working.dark, '#00AFFF');
    assert.strictEqual(status.LAMP_COLORS.needsYou.dark, '#EE2B7B');
    assert.strictEqual(status.LAMP_COLORS.doneUnseen.light, '#2E9E00');
    assert.strictEqual(status.LAMP_XTERM.needsYou, 161);
    assert.strictEqual(status.LAMP_SHAPE.doneSeen, 'circle-large-outline');
    for (const l of status.LAMPS) {
      assert.ok(status.LAMP_COLORS[l] && status.LAMP_XTERM[l] && status.LAMP_SHAPE[l] && status.LAMP_COLOR_ID[l], l);
    }
  });

  test('session key and UUID', () => {
    assert.strictEqual(status.sessionKey('codex', 'abc'), 'codex:abc');
    assert.deepStrictEqual(status.parseSessionKey('claude:1234:x'), { provider: 'claude', id: '1234:x' });
    assert.strictEqual(status.parseSessionKey('bad'), null);
    assert.ok(status.isUuid('0b7c1f7e-2a4d-4c3b-9f11-0123456789ab'));
    assert.ok(!status.isUuid('0b7c1f7e-2a4d-4c3b-9f11-0123456789ab; rm -rf /'));
  });
}

// ---------- Pricing ----------

function pricingTests() {
  test('Claude: 5-minute and 1-hour cache writes are priced separately', () => {
    const usage = {
      input_tokens: 1000, cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
      cache_read_input_tokens: 10000, output_tokens: 500,
    };
    // Opus 5: 1000×5 + 1000×6.25 + 2000×10 + 10000×0.5 + 500×25 = 48750 / 1e6
    approx(pricing.priceClaude('claude-opus-5', usage), 0.04875);
    // the same 3000 tokens all at the 5-minute rate is cheaper
    const all5m = { ...usage, cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 0 } };
    approx(pricing.priceClaude('claude-opus-5', all5m), (5000 + 3000 * 6.25 + 5000 + 12500) / 1e6);
    // cache_creation missing → everything at the 5-minute rate
    const noSplit = { input_tokens: 0, cache_creation_input_tokens: 4000, output_tokens: 0 };
    approx(pricing.priceClaude('claude-sonnet-5', noSplit), 4000 * 2.5 / 1e6);
    const t = pricing.claudeUsageTokens(noSplit);
    assert.deepStrictEqual([t.cacheWrite5m, t.cacheWrite1h], [4000, 0]);
  });

  test('Claude: special cache-read prices for Opus 5.5 and Fable 5.1', () => {
    const read = { cache_read_input_tokens: 1_000_000 };
    approx(pricing.priceClaude('claude-opus-5-5', read), 0.20);
    approx(pricing.priceClaude('claude-opus-5', read), 0.50);
    approx(pricing.priceClaude('claude-fable-5-1', read), 0.25);
    approx(pricing.priceClaude('claude-fable-5', read), 1.00);
    approx(pricing.priceClaude('claude-mythos-5-1', read), 0.25);
    approx(pricing.priceClaude('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6 }), 24);
  });

  test('Claude: model id normalization and longest-prefix match', () => {
    assert.strictEqual(pricing.claudePriceRow('claude-opus-5-5').prefix, 'claude-opus-5-5');
    assert.strictEqual(pricing.claudePriceRow('claude-opus-5').prefix, 'claude-opus-5');
    assert.strictEqual(pricing.claudePriceRow('claude-haiku-4-5-20251001').prefix, 'claude-haiku-4-5');
    assert.strictEqual(pricing.claudePriceRow('claude-opus-4-6[1m]').prefix, 'claude-opus-4-6');
    assert.strictEqual(pricing.claudePriceRow('claude-fable-5-1').prefix, 'claude-fable-5-1');
    assert.strictEqual(pricing.claudePriceRow('us.anthropic.claude-sonnet-4-5-20250929-v1:0').prefix, 'claude-sonnet-4-5');
    assert.strictEqual(pricing.priceClaude('<synthetic>', { input_tokens: 10 }), null);
    assert.strictEqual(pricing.priceClaude('claude-3-opus', { input_tokens: 10 }), null);
    assert.strictEqual(pricing.priceClaude(null, { input_tokens: 10 }), null);
  });

  test('Claude: fast mode uses fast prices; cache prices are derived and marked as estimated', () => {
    const d = pricing.priceClaudeDetail('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6, speed: 'fast' });
    approx(d.usd, 48);
    assert.strictEqual(d.estimated, true);
    const r = pricing.claudeRates('claude-opus-5', 'fast');
    assert.deepStrictEqual([r.input, r.output, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead], [10, 50, 12.5, 20, 1]);
    assert.strictEqual(pricing.priceClaudeDetail('claude-opus-5', { input_tokens: 1 }).estimated, false);
  });

  test('OpenAI: input includes cached tokens, so the cached part is subtracted first', () => {
    const usage = { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 2000, reasoning_output_tokens: 500, total_tokens: 102000 };
    // (100000−80000)×4 + 80000×0.4 + 2000×20 = 152000 / 1e6
    approx(pricing.priceOpenAI('gpt-5.6-sol', usage), 0.152);
    assert.notStrictEqual(Number(pricing.priceOpenAI('gpt-5.6-sol', usage).toFixed(6)), (100000 * 4 + 80000 * 0.4 + 2000 * 20) / 1e6);
    // Fast tier (priority is the same as fast)
    approx(pricing.priceOpenAI('gpt-5.6-sol', usage, 'priority'), 0.304);
    approx(pricing.priceOpenAI('gpt-5.6-sol', usage, 'fast'), 0.304);
    approx(pricing.priceOpenAI('gpt-5.6-sol', usage, 'default'), 0.152);
    // cache write
    approx(pricing.priceOpenAI('gpt-6-astra', { input_tokens: 0, cache_write_input_tokens: 1e6 }), 12.5);
    // long context (input > 272K)
    approx(pricing.priceOpenAI('gpt-5.6-sol', { input_tokens: 300000 }), 2.4);
    approx(pricing.priceOpenAI('gpt-5.5', { input_tokens: 100000, output_tokens: 1000 }), 0.53);
    // not priced
    assert.strictEqual(pricing.priceOpenAI('codex-auto-review', usage), null);
    assert.strictEqual(pricing.priceOpenAI('gpt-reserve', usage), null);
    // token breakdown
    assert.deepStrictEqual(pricing.openaiUsageTokens(usage), { input: 100000, cachedInput: 80000, cacheWrite: 0, output: 2000, reasoning: 500 });
  });

  test('price table date', () => {
    assert.strictEqual(pricing.PRICES_UPDATED, '2026-09-23');
  });

  test('re-read cost when resuming', () => {
    const c = pricing.rereadCost('claude', 'claude-opus-5', 100000, '1h');
    approx(c.usdIfMiss, 1.0);
    approx(c.usdIfHit, 0.05);
    approx(pricing.rereadCost('claude', 'claude-opus-5', 100000, '5m').usdIfMiss, 0.625);
    const x = pricing.rereadCost('codex', 'gpt-5.6-sol', 100000);
    approx(x.usdIfMiss, 0.4);
    approx(x.usdIfHit, 0.04);
    assert.deepStrictEqual(pricing.rereadCost('codex', 'codex-auto-review', 1), { usdIfMiss: null, usdIfHit: null });
  });
}

// ---------- Compaction cost estimate ----------

function compactTests() {
  const now = T('2026-09-24T12:00:00Z');
  const base = { contextUsed: 400000, model: 'claude-opus-5-5', ttl: '1h', now };
  const alive = { ...base, lastActivityMs: now - 10 * 60e3 };
  const expired = { ...base, lastActivityMs: now - 2 * 3600e3 };

  test('reference table: $0.40; 5-minute tier $2.32 / $1.16; 1-hour tier $3.52 / $1.76; Haiku unavailable', () => {
    const hit = pricing.estimateCompact(alive);
    assert.strictEqual(hit.outTokens, 16000);
    assert.strictEqual(hit.pricing, 'hit');
    cents(hit.readUsd, 0.08);
    cents(hit.writeUsd, 0.32);
    cents(hit.usd, 0.40);
    // 5-minute tier (API key): cache writes at the 5m rate
    const miss = pricing.estimateCompact({ ...expired, ttl: '5m' });
    assert.strictEqual(miss.cacheLikelyExpired, true);
    cents(miss.readUsd, 2.00);
    cents(miss.usd, 2.32);
    const sonnet = pricing.estimateCompact({ ...alive, ttl: '5m', targetModel: 'claude-sonnet-5' });
    assert.strictEqual(sonnet.pricing, 'miss', 'switching models always pays for a cache write');
    cents(sonnet.readUsd, 1.00);
    cents(sonnet.writeUsd, 0.16);
    cents(sonnet.usd, 1.16);
    // 1-hour tier (subscription main conversation): cache writes at the 1h rate
    cents(pricing.estimateCompact(expired).usd, 3.52);
    cents(pricing.estimateCompact({ ...alive, targetModel: 'claude-sonnet-5' }).usd, 1.76);
    cents(pricing.estimateCompact({ ...alive, ttl: '1h' }).usd, 0.40);
    const haiku = pricing.estimateCompact({ ...alive, targetModel: 'claude-haiku-4-5' });
    assert.strictEqual(haiku.available, false);
    assert.strictEqual(haiku.unavailableReason, 'window');
    assert.strictEqual(haiku.usd, null);
  });

  test('output estimate clamp(round(ctx×0.04), 2000, 20000)', () => {
    assert.strictEqual(pricing.compactOutputTokens(31201), 2000);
    assert.strictEqual(pricing.compactOutputTokens(100000), 4000);
    assert.strictEqual(pricing.compactOutputTokens(900000), 20000);
    assert.strictEqual(pricing.compactOutputTokens(0), 2000);
  });

  test('Haiku is only available when contextUsed + 20000 ≤ 200000', () => {
    const h = (n) => pricing.estimateCompact({ ...alive, contextUsed: n, targetModel: 'claude-haiku-4-5' }).available;
    assert.strictEqual(h(180000), true);
    assert.strictEqual(h(180001), false);
  });

  test('TTL: a 5-minute cache counts as expired after 6 minutes; a main agent without a TTL uses 1 hour', () => {
    assert.strictEqual(pricing.estimateCompact({ ...base, ttl: '5m', lastActivityMs: now - 6 * 60e3 }).pricing, 'miss');
    assert.strictEqual(pricing.estimateCompact({ ...base, ttl: null, lastActivityMs: now - 30 * 60e3 }).pricing, 'hit');
    assert.strictEqual(pricing.estimateCompact({ ...base, ttl: null, lastActivityMs: null }).pricing, 'miss');
  });

  test('compaction loop: the last two compactions are ≤ 10 minutes apart and nothing else happened in the 10 minutes after', () => {
    const M = 60e3;
    const times = [];
    status.noteCompact(times, 0);
    assert.strictEqual(status.compactLoopOf(times, 0), false, 'only one compaction');
    status.noteCompact(times, 9 * M);
    assert.strictEqual(status.compactLoopOf(times, 12 * M), true);
    assert.strictEqual(status.compactLoopOf(times, 40 * M), false, 'plenty of work happened afterwards');
    status.noteCompact(times, 30 * M);
    assert.strictEqual(status.compactLoopOf(times, 30 * M), false, '21 minutes apart');
    for (let i = 0; i < 6; i++) status.noteCompact(times, (40 + i) * M);
    assert.strictEqual(times.length, 4);
  });

  test('candidates and recommendation: cache alive → original model; expired → Sonnet 5; Haiku unavailable; no duplicates', () => {
    const a = pricing.compactCandidates(alive);
    assert.deepStrictEqual(a.candidates.map((c) => c.id), ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
    assert.strictEqual(a.recommended, 'claude-opus-5-5');
    const b = pricing.compactCandidates(expired);
    assert.strictEqual(b.recommended, 'claude-sonnet-5');
    const s = b.candidates.find((c) => c.id === 'claude-sonnet-5');
    assert.ok(s.savingVsOriginal > 0.49 && s.savingVsOriginal < 0.51, 'with an expired cache, Sonnet 5 saves about half');
    assert.strictEqual(b.candidates.find((c) => c.id === 'claude-haiku-4-5').recommended, false);
    // small context: Haiku is available and cheapest
    const small = pricing.compactCandidates({ ...expired, contextUsed: 50000 });
    assert.strictEqual(small.recommended, 'claude-haiku-4-5');
    // no duplicate when the original model is already Sonnet 5
    const dup = pricing.compactCandidates({ ...alive, model: 'claude-sonnet-5' });
    assert.deepStrictEqual(dup.candidates.map((c) => c.id), ['claude-sonnet-5', 'claude-haiku-4-5']);
  });
}

// ---------- Quota ----------

function quotaTests() {
  const ref = T('2026-09-14T10:00:00Z'); // 19:00 in Seoul (Monday)
  const parse = (text, at = ref, tz) => quota.parseClaudeLimitText(text, at, tz);
  const iso = (ms) => new Date(ms).toISOString();

  test('the four text formats of the reset time, and time zones', () => {
    const a = parse("You've hit your session limit · resets 3:30am (Asia/Seoul)");
    assert.strictEqual(a.kind, 'session');
    assert.strictEqual(iso(a.resetsAtMs), '2026-09-14T18:30:00.000Z');
    const b = parse("You've hit your session limit · resets 11:15pm (Asia/Seoul)");
    assert.strictEqual(iso(b.resetsAtMs), '2026-09-14T14:15:00.000Z');
    const c = parse("You've hit your session limit · resets 2am (Asia/Seoul)");
    assert.strictEqual(iso(c.resetsAtMs), '2026-09-14T17:00:00.000Z');
    assert.strictEqual(c.resetsText, 'resets 2am (Asia/Seoul)');
    // weekday without a time zone in parentheses → use the given (local) time zone; 2026-09-16 is a Wednesday
    const d = parse("You've hit your weekly limit · resets Mon 12:00am", T('2026-09-16T12:00:00Z'), 'America/New_York');
    assert.strictEqual(d.kind, 'weekly');
    assert.strictEqual(iso(d.resetsAtMs), '2026-09-21T04:00:00.000Z');
    // 12pm is noon
    assert.strictEqual(iso(parse('resets 12pm (UTC)', T('2026-09-14T13:00:00Z')).resetsAtMs), '2026-09-15T12:00:00.000Z');
  });

  test('reset time is strictly after the record time, also on the day DST ends', () => {
    // a record written at exactly 2am Seoul (17:00Z) → the next 2am is the following day
    assert.strictEqual(iso(parse('resets 2am (Asia/Seoul)', T('2026-09-14T17:00:00Z')).resetsAtMs), '2026-09-15T17:00:00.000Z');
    // 2026-11-01 New York: DST ends at 2am → 2am EST = 07:00Z
    assert.strictEqual(iso(parse('resets 2am (America/New_York)', T('2026-10-31T12:00:00Z')).resetsAtMs), '2026-11-01T07:00:00.000Z');
    // invalid time zone → fall back to the given time zone
    assert.strictEqual(iso(parse('resets 2am (Mars/Base)', ref, 'Asia/Seoul').resetsAtMs), '2026-09-14T17:00:00.000Z');
  });

  test('quota kinds: model, spend, unknown; no reset time', () => {
    const m = parse("You've hit your Opus limit · resets 3:45pm", ref, 'UTC');
    assert.strictEqual(m.kind, 'model');
    assert.strictEqual(m.model, 'Opus');
    assert.strictEqual(iso(m.resetsAtMs), '2026-09-14T15:45:00.000Z');
    const n = parse("You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.");
    assert.deepStrictEqual([n.kind, n.model, n.resetsAtMs, n.resetsText], ['model', 'Fable 5', null, null]);
    assert.strictEqual(parse("You've hit your spend limit").kind, 'spend');
    assert.strictEqual(parse("You've hit your usage limit").kind, 'unknown');
    assert.strictEqual(parse('').kind, 'unknown');
  });

  const quotaLine = (text, extra = {}) => ({
    type: 'assistant', timestamp: '2026-09-14T10:00:00Z', isApiErrorMessage: true, error: 'rate_limit',
    apiErrorStatus: 429, version: '2.1.270', entrypoint: 'claude-vscode',
    message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] },
    ...extra,
  });

  test('quotaLimits (epoch seconds) take precedence over the text', () => {
    const e = quotaLine("You've hit your weekly limit · resets 5am (Asia/Seoul)", {
      quotaLimits: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1789405200 },
    });
    assert.ok(quota.isClaudeQuotaLine(e));
    const h = quota.parseClaudeQuota(e);
    assert.strictEqual(h.source, 'quotaLimits');
    assert.strictEqual(h.kind, 'weekly');
    assert.strictEqual(h.resetsAtMs, 1789405200 * 1000);
    assert.strictEqual(h.resetsText, 'resets 5am (Asia/Seoul)');
    const five = quota.parseClaudeQuota(quotaLine('x', { quotaLimits: { rateLimitType: 'five_hour', resetsAt: 1789405200 } }));
    assert.strictEqual(five.kind, 'session');
    const other = quota.parseClaudeQuota(quotaLine("You've hit your session limit", { quotaLimits: { rateLimitType: 'odd', resetsAt: 1789405200 } }));
    assert.strictEqual(other.kind, 'session', 'an unrecognized rateLimitType falls back to the kind from the text');
    const textOnly = quota.parseClaudeQuota(quotaLine("You've hit your session limit · resets 2am (Asia/Seoul)"));
    assert.strictEqual(textOnly.source, 'text');
    assert.strictEqual(textOnly.resetsAtMs, 1789405200 * 1000);
  });

  test('autoContinue: ≥2.1.234 and not sdk → null; otherwise false', () => {
    assert.strictEqual(quota.parseClaudeQuota(quotaLine('x')).autoContinue, null);
    assert.strictEqual(quota.parseClaudeQuota(quotaLine('x', { version: '2.1.215' })).autoContinue, false);
    assert.strictEqual(quota.parseClaudeQuota(quotaLine('x', { entrypoint: 'sdk-cli' })).autoContinue, false);
    assert.strictEqual(quota.parseClaudeQuota(quotaLine('x', { version: undefined })).autoContinue, false);
    assert.ok(quota.versionAtLeast('2.1.280', '2.1.234'));
    assert.ok(!quota.versionAtLeast('2.1.99', '2.1.234'));
    assert.ok(quota.versionAtLeast('3.0.0', '2.1.234'));
  });

  test('non-quota API errors', () => {
    const e = { isApiErrorMessage: true, error: 'server_error', apiErrorStatus: 529, message: { content: [{ type: 'text', text: '\nAPI Error: 529 Overloaded\nmore' }] } };
    assert.deepStrictEqual(quota.claudeApiError(e), { kind: 'server_error', http: 529, message: 'API Error: 529 Overloaded' });
    assert.ok(!quota.isClaudeQuotaLine({ ...e, type: 'assistant' }));
  });

  const observed = T('2026-09-20T00:00:00Z');
  const rl = {
    limit_id: 'codex', limit_name: null,
    primary: { used_percent: 81, window_minutes: 300, resets_at: 1789871400 },
    secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1790300000 },
    credits: { has_credits: false, unlimited: false, balance: null },
    plan_type: 'plus', rate_limit_reached_type: null,
  };

  test('Codex rate_limits normalization', () => {
    const ws = quota.codexWindows(rl, observed);
    assert.deepStrictEqual(ws, [
      { minutes: 300, usedPct: 81, resetsAtMs: 1789871400000, label: '5h' },
      { minutes: 10080, usedPct: 100, resetsAtMs: 1790300000000, label: 'weekly' },
    ]);
    assert.strictEqual(quota.codexWindowLabel(60), '60m');
    const old = quota.codexWindows({ primary: { used_percent: 5, window_minutes: 60, resets_in_seconds: 120 } }, observed);
    assert.strictEqual(old[0].resetsAtMs, observed + 120e3);
    const snap = quota.codexQuota(rl, observed);
    assert.strictEqual(snap.planType, 'plus');
    assert.strictEqual(snap.limitId, 'codex');
    assert.strictEqual(snap.observedMs, observed);
    assert.deepStrictEqual(snap.credits, { hasCredits: false, unlimited: false, balance: null });
    assert.strictEqual(snap.reachedType, null);
    assert.deepStrictEqual(quota.codexQuota(null, 1), quota.emptyQuotaSnapshot().codex);
    assert.ok(quota.isWindowReset(ws[0], 1789871400000));
    assert.ok(!quota.isWindowReset(ws[0], 1789871399999));
  });

  test('Codex limit-hit detection and error enum', () => {
    assert.ok(quota.codexLimitReached(rl));
    assert.ok(!quota.codexLimitReached({ ...rl, secondary: { used_percent: 50, window_minutes: 10080 } }));
    assert.ok(quota.codexLimitReached({ primary: { used_percent: 1 }, rate_limit_reached_type: 'rate_limit_reached' }));
    const hit = quota.codexQuotaHit(rl, observed);
    assert.deepStrictEqual([hit.kind, hit.resetsAtMs, hit.source], ['window', 1790300000000, 'turnError']);
    assert.strictEqual(quota.codexErrorKind('usage_limit_exceeded'), 'usage_limit_exceeded');
    assert.ok(quota.isCodexUsageLimit('usage_limit_exceeded'));
    assert.strictEqual(quota.codexErrorKind({ http_connection_failed: { http_status_code: 502 } }), 'http_connection_failed');
    assert.strictEqual(quota.codexErrorHttp({ http_connection_failed: { http_status_code: 502 } }), 502);
    assert.strictEqual(quota.codexErrorKind(null), null);
  });
}

// ---------- Context ----------

function contextTests() {
  test('Claude window and default compaction threshold (default = window − 33K; 1M → 967K, 200K → 167K)', () => {
    const a = context.claudeContext('claude-opus-5-5', 500000);
    assert.deepStrictEqual([a.contextWindow, a.compactAt, a.toCompact, a.compactAtSource, a.contextWindowSource, a.autoCompactWindow],
      [1000000, 967000, 467000, 'default', 'model-rule', 1000000]);
    const b = context.claudeContext('claude-haiku-4-5-20251001', 150000);
    assert.deepStrictEqual([b.contextWindow, b.compactAt, b.toCompact, b.autoCompactWindow], [200000, 167000, 17000, 200000]);
    assert.strictEqual(context.COMPACT_1M_DEFAULT, 967000);
    assert.strictEqual(context.claudeContext('claude-sonnet-5', 1).contextWindow, 1000000);
    assert.strictEqual(context.claudeContext('claude-fable-5-1', 1).contextWindow, 1000000);
    assert.strictEqual(context.claudeContext('claude-opus-4-7', 1).contextWindow, 1000000);
    assert.strictEqual(context.claudeContext('claude-opus-4-6', 1).contextWindow, 200000);
    // 4.6 with [1m] enabled but no cost-state: the record has no suffix, so switch to 1M once usage exceeds 200K
    assert.strictEqual(context.claudeContext('claude-opus-4-6', 250000).contextWindow, 1000000);
    assert.strictEqual(context.claudeContext('claude-opus-4-6', 190000).toCompact, 0, 'past the compaction point: show 0');
    assert.strictEqual(context.claudeContext('claude-opus-4-6', 210000).toCompact, 757000);
    // no replies yet: don't guess the window
    const empty = context.claudeContext(null, 0);
    assert.deepStrictEqual([empty.contextWindow, empty.compactAt, empty.contextPct, empty.compactAtSource], [null, null, null, null]);
  });

  test('Claude settings override: min(setting, window) minus 33K; range 100K–1M; disabled; env vars of the extension process are not read', () => {
    const user = (v) => ({ autoCompactWindow: v, windowSource: 'settings-user' });
    const a = context.claudeContext('claude-opus-5', 1, user(500000));
    assert.deepStrictEqual([a.compactAt, a.compactAtSource, a.autoCompactWindow], [467000, 'settings-user', 500000]);
    const small = context.claudeContext('claude-haiku-4-5', 1, user(500000));
    assert.deepStrictEqual([small.compactAt, small.autoCompactWindow], [167000, 200000], 'not above the window');
    assert.strictEqual(context.claudeContext('claude-opus-5', 1, user(5000)).compactAt, 67000, 'lower bound 100K');
    assert.strictEqual(context.claudeContext('claude-opus-5', 1, user(5000000)).compactAt, 967000, 'upper bound 1M');
    // legacy shape (readClaudeSettings result without a source) counts as user settings
    assert.strictEqual(context.claudeContext('claude-opus-5', 1, { autoCompactWindow: 400000 }).compactAtSource, 'settings-user');
    const off = context.claudeContext('claude-opus-5', 1, { autoCompactEnabled: false, autoCompactWindow: 400000 });
    assert.deepStrictEqual([off.compactAt, off.toCompact, off.autoCompactOff, off.compactAtSource, off.autoCompactWindow], [null, null, true, 'disabled', null]);
    const saved = { ...process.env };
    try {
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '300000';
      process.env.DISABLE_AUTO_COMPACT = '1';
      process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '50';
      const e = context.claudeContext('claude-opus-5', 1);
      assert.deepStrictEqual([e.compactAt, e.compactAtSource], [967000, 'default'], 'env vars of the Claude process are invisible to the extension, so they are not used');
    } finally {
      for (const k of ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'DISABLE_AUTO_COMPACT', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE']) {
        if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
      }
    }
  });

  test('percentage matches Claude Code: round(used / window × 100), clamped to 0–100', () => {
    assert.strictEqual(context.usedPercent(412000, 1000000), 41);
    assert.strictEqual(context.usedPercent(4999, 1000000), 0, '0.4999% → 0 ("<1%" is decided by the formatter)');
    assert.strictEqual(context.usedPercent(5000, 1000000), 1, '0.5% rounds to 1');
    assert.strictEqual(context.usedPercent(199000, 200000), 100, '99.5% → 100');
    assert.strictEqual(context.usedPercent(250000, 200000), 100, 'clamped to 100');
    assert.strictEqual(context.usedPercent(-5, 200000), 0);
    assert.strictEqual(context.usedPercent(0, 200000), 0);
    assert.strictEqual(context.usedPercent(100, null), null);
    assert.strictEqual(context.usedPercent(100, 0), null);
    assert.strictEqual(context.claudeContext('claude-opus-5-5', 412000).contextPct, 41, 'the denominator is the window, not the compaction point');
    assert.strictEqual(context.claudeContext('claude-haiku-4-5', 150000).contextPct, 75);
  });

  test('cost-state key matching: same name with [1m] → 1M (cost-state); only the plain key → model rule; date suffixes, letter case', () => {
    const keys = ['claude-haiku-4-5-20251001', 'claude-opus-4-6[1m]', 'claude-opus-5-5', 'Claude-Sonnet-4-6'];
    assert.deepStrictEqual(context.costStateVariant('claude-opus-4-6', keys), { variant: 'claude-opus-4-6[1m]', is1m: true });
    assert.deepStrictEqual(context.costStateVariant('claude-opus-4-6-20260101', keys), { variant: 'claude-opus-4-6[1m]', is1m: true });
    assert.deepStrictEqual(context.costStateVariant('claude-opus-5-5', keys), { variant: 'claude-opus-5-5', is1m: false });
    assert.deepStrictEqual(context.costStateVariant('claude-sonnet-4-6', keys), { variant: 'Claude-Sonnet-4-6', is1m: false });
    assert.deepStrictEqual(context.costStateVariant('claude-opus-5', keys), { variant: null, is1m: false });
    assert.deepStrictEqual(context.costStateVariant('claude-opus-5', null), { variant: null, is1m: false });
    assert.deepStrictEqual(context.costStateVariant(null, keys), { variant: null, is1m: false });
    // window
    assert.deepStrictEqual(context.resolveClaudeWindow('claude-opus-4-6', 1000, keys),
      { contextWindow: 1000000, contextWindowSource: 'cost-state', modelVariant: 'claude-opus-4-6[1m]' });
    assert.deepStrictEqual(context.resolveClaudeWindow('claude-opus-5-5', 1000, keys),
      { contextWindow: 1000000, contextWindowSource: 'model-rule', modelVariant: 'claude-opus-5-5' }, 'natively 1M: 1M even without the suffix');
    assert.deepStrictEqual(context.resolveClaudeWindow('claude-sonnet-4-6', 1000, keys),
      { contextWindow: 200000, contextWindowSource: 'model-rule', modelVariant: 'Claude-Sonnet-4-6' });
    assert.deepStrictEqual(context.resolveClaudeWindow('claude-haiku-4-5-20251001', 1000, keys),
      { contextWindow: 200000, contextWindowSource: 'model-rule', modelVariant: 'claude-haiku-4-5-20251001' });
    const c = context.claudeContext('claude-opus-4-6', 150000, {}, { costKeys: keys });
    assert.deepStrictEqual([c.contextWindow, c.contextWindowSource, c.modelVariant, c.compactAt, c.contextPct], [1000000, 'cost-state', 'claude-opus-4-6[1m]', 967000, 15]);
  });

  test('compaction point source order: settings → observed → default; observed uses preTokens as is; when disabled, observed is ignored too', () => {
    const r = (o) => context.resolveClaudeCompact(o);
    assert.deepStrictEqual(r({ contextWindow: 1000000, settings: { autoCompactWindow: 400000, windowSource: 'settings-local' }, observed: 955000 }),
      { compactAt: 367000, compactAtSource: 'settings-local', autoCompactWindow: 400000 });
    assert.deepStrictEqual(r({ contextWindow: 1000000, settings: {}, observed: 955000 }),
      { compactAt: 955000, compactAtSource: 'observed', autoCompactWindow: null });
    assert.deepStrictEqual(r({ contextWindow: 200000, observed: 250000 }).compactAt, 200000, 'observed value is capped at the window');
    assert.deepStrictEqual(r({ contextWindow: 1000000 }), { compactAt: 967000, compactAtSource: 'default', autoCompactWindow: 1000000 });
    assert.deepStrictEqual(r({ contextWindow: 200000 }), { compactAt: 167000, compactAtSource: 'default', autoCompactWindow: 200000 });
    assert.deepStrictEqual(r({ contextWindow: 1000000, settings: { autoCompactEnabled: false }, observed: 955000 }),
      { compactAt: null, compactAtSource: 'disabled', autoCompactWindow: null });
    assert.deepStrictEqual(r({ contextWindow: null }), { compactAt: null, compactAtSource: null, autoCompactWindow: null });
    // the observed table is keyed by `${model}|${contextWindow}`
    assert.strictEqual(context.observedKey('claude-opus-5-5', 1000000), 'claude-opus-5-5|1000000');
    const obs = { 'claude-opus-5-5|1000000': 958000, 'claude-opus-5-5|200000': 1 };
    const c = context.claudeContext('claude-opus-5-5', 100000, {}, { observed: obs });
    assert.deepStrictEqual([c.compactAt, c.compactAtSource, c.toCompact], [958000, 'observed', 858000]);
    const s = context.claudeContext('claude-opus-5-5', 100000, { autoCompactWindow: 600000, windowSource: 'settings-project' }, { observed: obs });
    assert.deepStrictEqual([s.compactAt, s.compactAtSource], [567000, 'settings-project'], 'settings take precedence over observed');
  });

  test('three settings layers: each key comes from the highest-priority layer that sets it; project settings are not counted twice when the session dir is the home dir', () => {
    const m = context.mergeCompactSettings([
      { source: 'settings-local', value: { autoCompactEnabled: true } },
      { source: 'settings-project', value: { autoCompactWindow: 300000 } },
      { source: 'settings-user', value: { autoCompactWindow: 500000, autoCompactEnabled: false } },
    ]);
    assert.deepStrictEqual(m, { autoCompactWindow: 300000, windowSource: 'settings-project', autoCompactEnabled: true, enabledSource: 'settings-local' });
    assert.deepStrictEqual(context.mergeCompactSettings([]), { autoCompactWindow: null, windowSource: null, autoCompactEnabled: null, enabledSource: null });
    const user = path.join('/h', '.claude', 'settings.json');
    assert.deepStrictEqual(context.claudeSettingsFiles('/w/p q', user).map((x) => [x.source, x.file]), [
      ['settings-local', path.join('/w/p q', '.claude', 'settings.local.json')],
      ['settings-project', path.join('/w/p q', '.claude', 'settings.json')],
      ['settings-user', user],
    ]);
    assert.deepStrictEqual(context.claudeSettingsFiles('/h', user).map((x) => x.source), ['settings-local', 'settings-user']);
    assert.deepStrictEqual(context.claudeSettingsFiles(null, user).map((x) => x.source), ['settings-user']);
  });

  test('settings file cache: no stat within the check interval; re-read only when mtime / size changes; a missing file or bad JSON counts as unset', () => {
    const f = tmpFile('settings.local.json');
    const cache = new context.SettingsCache({ checkMs: 5000 });
    assert.deepStrictEqual(cache.get(f, 1000), {}, 'no file');
    fs.writeFileSync(f, JSON.stringify({ autoCompactWindow: 400000 }));
    assert.deepStrictEqual(cache.get(f, 2000), {}, 'cached within 5 seconds');
    assert.deepStrictEqual(cache.get(f, 6000), { autoCompactWindow: 400000 });
    assert.strictEqual(cache.reads, 1);
    assert.deepStrictEqual(cache.get(f, 12000), { autoCompactWindow: 400000 });
    assert.strictEqual(cache.reads, 1, 'unchanged: not re-read');
    fs.writeFileSync(f, JSON.stringify({ autoCompactWindow: 450000, autoCompactEnabled: false, x: 1 }));
    assert.deepStrictEqual(cache.get(f, 18000), { autoCompactWindow: 450000, autoCompactEnabled: false });
    fs.writeFileSync(f, '{ broken');
    assert.deepStrictEqual(cache.get(f, 24000), {}, 'bad JSON');
    fs.writeFileSync(f, '[1, 2]');
    assert.deepStrictEqual(cache.get(f, 30000), {}, 'not an object');
    fs.rmSync(f);
    assert.deepStrictEqual(cache.get(f, 36000), {}, 'deleted');
  });

  test('read settings.json (only two keys)', () => {
    const f = tmpFile('settings.json');
    fs.writeFileSync(f, JSON.stringify({ autoCompactWindow: 400000, autoCompactEnabled: true, other: 1 }));
    assert.deepStrictEqual(context.readClaudeSettings(f), { autoCompactWindow: 400000, autoCompactEnabled: true });
    assert.deepStrictEqual(context.readClaudeSettings(path.join(TMP, 'missing.json')), {});
  });

  test('Codex: models_cache × 0.9, the smaller config value wins, unknown models are back-computed at 95%, body_after_prefix', () => {
    const models = context.codexModelsIndex({ models: [{ slug: 'gpt-5.6-sol', context_window: 272000, max_context_window: 872000, effective_context_window_percent: 95 }] });
    const th = { model: 'gpt-5.6-sol', contextUsed: 100000, modelContextWindow: 258400 };
    const a = context.codexContext(th, models, {});
    assert.deepStrictEqual([a.contextWindow, a.compactAt, a.toCompact], [258400, 244800, 144800]);
    assert.strictEqual(context.codexContext(th, models, { modelAutoCompactTokenLimit: 250000 }).compactAt, 244800);
    assert.strictEqual(context.codexContext(th, models, { modelAutoCompactTokenLimit: 200000 }).compactAt, 200000);
    const u = context.codexContext({ model: 'unknown', contextUsed: 1, modelContextWindow: 258400 }, models, {});
    assert.strictEqual(u.compactAt, 244800);
    const noWin = context.codexContext({ model: 'gpt-5.6-sol', contextUsed: 1 }, models, {});
    assert.strictEqual(noWin.contextWindow, 258400, 'without model_context_window: cw × effective percent');
    const rel = context.codexContext(th, models, { autoCompactScope: 'body_after_prefix' });
    assert.strictEqual(rel.toCompact, null);
    assert.strictEqual(rel.scopeRelative, true);
  });

  test('Codex sources: window from the record → codex-record; derived from the model catalog → model-rule; smaller config value → settings-user; same percentage formula', () => {
    const models = context.codexModelsIndex({ models: [{ slug: 'gpt-5.6-sol', context_window: 272000, effective_context_window_percent: 95 }] });
    const th = { model: 'gpt-5.6-sol', contextUsed: 100000, modelContextWindow: 258400 };
    const a = context.codexContext(th, models, {});
    assert.deepStrictEqual([a.contextWindowSource, a.compactAtSource, a.contextPct], ['codex-record', 'default', 39]);
    assert.strictEqual(context.codexContext(th, models, { modelAutoCompactTokenLimit: 200000 }).compactAtSource, 'settings-user');
    assert.strictEqual(context.codexContext(th, models, { modelAutoCompactTokenLimit: 250000 }).compactAtSource, 'default', 'a larger config value has no effect');
    const derived = context.codexContext({ model: 'gpt-5.6-sol', contextUsed: 1 }, models, {});
    assert.deepStrictEqual([derived.contextWindow, derived.contextWindowSource], [258400, 'model-rule']);
    const none = context.codexContext({ model: 'unknown', contextUsed: 1 }, models, {});
    assert.deepStrictEqual([none.contextWindow, none.contextWindowSource, none.compactAt, none.compactAtSource, none.contextPct], [null, null, null, null, null]);
    const onlyLimit = context.codexContext({ model: 'unknown', contextUsed: 1 }, models, { modelAutoCompactTokenLimit: 100000 });
    assert.deepStrictEqual([onlyLimit.compactAt, onlyLimit.compactAtSource], [100000, 'settings-user']);
  });

  test('config.toml: only top-level keys are read', () => {
    const c = context.parseCodexConfig([
      'model = "gpt-5.6-sol"',
      'model_auto_compact_token_limit = 200_000 # 注释',
      'model_auto_compact_token_limit_scope = "body_after_prefix"',
      '[profiles.x]',
      'model_context_window = 999',
    ].join('\n'));
    assert.deepStrictEqual(c, { modelAutoCompactTokenLimit: 200000, modelContextWindow: null, autoCompactScope: 'body_after_prefix' });
    assert.deepStrictEqual(context.parseCodexConfig(''), { modelAutoCompactTokenLimit: null, modelContextWindow: null, autoCompactScope: null });
  });
}

// ---------- Resume ----------

function resumeTests() {
  const now = T('2026-09-24T12:00:00Z');
  const agent = (o) => ({
    id: 'main', kind: 'main', name: null, agentType: null, model: 'claude-opus-5',
    status: status.makeStatus('done', now), tokens: { contextUsed: 100000 },
    cacheTtl: null, lastActivityMs: now - 60e3, ...o,
  });

  test('cache TTL inference', () => {
    assert.deepStrictEqual(resume.cacheTtlFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 } }, false), { ttl: '1h', inferred: false });
    assert.deepStrictEqual(resume.cacheTtlFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 5 } }, true), { ttl: '5m', inferred: false });
    assert.deepStrictEqual(resume.cacheTtlFromUsage({}, true), { ttl: '1h', inferred: true });
    assert.deepStrictEqual(resume.cacheTtlFromUsage(null, false), { ttl: '5m', inferred: true });
  });

  test('resume cost: after hitting a quota, cache expiry is judged at the reset time', () => {
    const e = resume.resumeEstimate({ provider: 'claude', model: 'claude-opus-5', contextTokens: 100000, ttl: '1h', lastActivityMs: now - 60e3, now });
    assert.deepStrictEqual([e.ttl, e.cacheLikelyExpired], ['1h', false]);
    approx(e.usdIfMiss, 1.0);
    approx(e.usdIfHit, 0.05);
    const q = resume.resumeEstimate({ provider: 'claude', model: 'claude-opus-5', contextTokens: 100000, ttl: '1h', lastActivityMs: now - 60e3, resetsAtMs: now + 3 * 3600e3, now });
    assert.strictEqual(q.cacheLikelyExpired, true);
    const c = resume.resumeEstimate({ provider: 'codex', model: 'gpt-5.6-sol', contextTokens: 100000, now });
    assert.deepStrictEqual([c.ttl, c.cacheLikelyExpired], ['unknown', null]);
    approx(c.usdIfMiss, 0.4);
  });

  test('hints generated per session', () => {
    const qh = { kind: 'session', model: null, resetsAtMs: now + 3600e3, resetsText: null, source: 'text', autoContinue: null };
    const session = {
      provider: 'claude', id: 'sess-1', cwd: '/tmp/p', entry: 'vscode',
      main: agent({ status: status.makeStatus('quota', now, { quota: qh }) }),
      agents: [
        agent({ id: 'a1', kind: 'subagent', name: 'Look around', agentType: 'Explore', status: status.makeStatus('apiError', now) }),
        agent({ id: 'a2', kind: 'subagent', name: 'Fix it', agentType: 'general-purpose', status: status.makeStatus('quota', now) }),
        agent({ id: 'a3', kind: 'subagent', status: status.makeStatus('stale', now) }),
      ],
      workflows: [
        { id: 'wf_1-2', name: 'build', scriptPath: '/x/build.js', state: 'killed', agents: [
          agent({ id: 'w1', kind: 'workflowAgent', status: status.makeStatus('done', now) }),
          agent({ id: 'w2', kind: 'workflowAgent', status: status.makeStatus('killed', now), tokens: { contextUsed: 30000 } }),
          agent({ id: 'w3', kind: 'workflowAgent', status: status.makeStatus('killed', now), tokens: { contextUsed: 20000 } }),
        ] },
        { id: 'wf_3-4', name: 'ok', state: 'completed', agents: [agent({ id: 'w4', kind: 'workflowAgent' })] },
        { id: 'wf_5-6', name: 'paused', state: 'paused', agents: [agent({ id: 'w5', kind: 'workflowAgent', status: status.makeStatus('quota', now) })] },
      ],
    };
    const hints = resume.resumeHints(session, { now });
    assert.deepStrictEqual(hints.map((h) => h.kind), ['claudeSession', 'claudeSubagent', 'claudeSubagent', 'claudeWorkflow', 'claudeWorkflow']);
    assert.strictEqual(hints[0].autoContinue, null);
    assert.strictEqual(hints[0].quota, qh);
    assert.strictEqual(hints[1].resumable, false, 'Explore cannot be resumed');
    assert.strictEqual(hints[2].resumable, true);
    assert.strictEqual(hints[3].estimate.contextTokens, 50000, 'only counts agents that need to rerun');
    assert.strictEqual(hints[3].paused, false);
    assert.strictEqual(hints[4].paused, true);
    assert.deepStrictEqual(resume.resumeVariants(hints[0]), ['prompt']);
    assert.deepStrictEqual(resume.resumeVariants(hints[4]), [], 'no copy action while paused on a quota');
    assert.deepStrictEqual(resume.resumeVariants(hints[1]), ['prompt']);
    assert.strictEqual(resume.resumeHints({ ...session, main: agent({}), agents: [], workflows: [] }, { now }).length, 0);
  });

  test('Codex session: a stale main thread gets a hint, reviewer threads do not', () => {
    const s = {
      provider: 'codex', id: 'th-1', cwd: '/w', entry: 'cli',
      main: agent({ model: 'gpt-5.6-sol', status: status.makeStatus('stale', now) }),
      agents: [
        agent({ id: 'th-2', kind: 'codexSubagent', name: 'Ada', status: status.makeStatus('apiError', now) }),
        agent({ id: 'th-3', kind: 'codexReviewer', status: status.makeStatus('quota', now) }),
      ],
      workflows: [],
    };
    const h = resume.resumeHints(s, { now });
    assert.deepStrictEqual(h.map((x) => x.kind), ['codexThread', 'codexSubagent']);
    assert.strictEqual(h[1].parentThreadId, 'th-1');
    assert.deepStrictEqual(resume.resumeVariants(h[0]), ['cli', 'prompt']);
    assert.strictEqual(h[0].estimate.ttl, 'unknown');
  });

  test('all prompt keys exist in the English dictionary', () => {
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'core.en.json'), 'utf8'));
    const hints = [
      { kind: 'claudeSession' }, { kind: 'codexThread' },
      { kind: 'claudeSubagent', resumable: true, agentId: 'a' }, { kind: 'claudeSubagent', resumable: false, agentId: 'a' },
      { kind: 'claudeWorkflow', workflowName: 'w', runId: 'r', scriptPath: '/s.js' }, { kind: 'claudeWorkflow', workflowName: 'w', runId: 'r' },
      { kind: 'codexSubagent', threadId: 't' },
    ];
    for (const h of hints) {
      const p = resume.resumePrompt(h);
      assert.ok(en[p.key], p.key);
      for (const m of en[p.key].matchAll(/\{(\w+)\}/g)) assert.ok(m[1] in p.vars, `${p.key} is missing ${m[1]}`);
    }
  });

  test('terminal commands: POSIX escaping, PowerShell, id validation', () => {
    const h = { kind: 'claudeSession', sessionId: '0b7c1f7e-2a4d-4c3b-9f11-0123456789ab', cwd: "/Users/me/My Proj's" };
    assert.strictEqual(resume.resumeCommand(h, 'Say "hi" $HOME `x` \\', { platform: 'darwin' }),
      "cd '/Users/me/My Proj'\\''s' && claude --resume 0b7c1f7e-2a4d-4c3b-9f11-0123456789ab \"Say \\\"hi\\\" \\$HOME \\`x\\` \\\\\"");
    assert.strictEqual(resume.resumeCommand({ ...h, cwd: '/simple/path' }, 'Go on!', { platform: 'linux' }),
      "cd /simple/path && claude --resume 0b7c1f7e-2a4d-4c3b-9f11-0123456789ab 'Go on!'");
    assert.strictEqual(resume.resumeCommand({ ...h, cwd: "C:\\a'b" }, 'x "y" $z', { platform: 'win32' }),
      "Set-Location -LiteralPath 'C:\\a''b'; claude --resume 0b7c1f7e-2a4d-4c3b-9f11-0123456789ab \"x `\"y`\" `$z\"");
    assert.strictEqual(resume.resumeCommand({ kind: 'codexThread', threadId: 't-1', cwd: null }, 'go', { platform: 'darwin' }), 'codex resume t-1 "go"');
    assert.strictEqual(resume.resumeCommand({ ...h, sessionId: 'x; rm -rf /' }, 'go', { platform: 'darwin' }), null);
    assert.strictEqual(resume.resumeCommand({ kind: 'claudeSubagent' }, 'go'), null);
  });
}

// ---------- i18n and formatting ----------

function i18nTests() {
  test('locale normalization', () => {
    const cases = {
      'zh-hk': 'zh-tw', 'zh-hant-tw': 'zh-tw', 'zh-Hant': 'zh-tw', 'zh-mo': 'zh-tw', 'zh-TW': 'zh-tw',
      'zh-cn': 'zh-cn', 'zh_CN.UTF-8': 'zh-cn', 'zh-sg': 'zh-cn', zh: 'zh-cn', 'zh-hans': 'zh-cn',
      'en-gb': 'en', 'ko-kr': 'ko', ko: 'ko', 'ja-jp': 'ja', 'ja_JP.UTF-8': 'ja', fr: 'en', '': 'en',
    };
    for (const [raw, want] of Object.entries(cases)) assert.strictEqual(i18n.normalizeLocale(raw), want, raw);
    assert.strictEqual(i18n.normalizeLocale(null), 'en');
    assert.strictEqual(i18n.normalizeLocale(undefined), 'en');
    assert.strictEqual(i18n.intlLocaleOf('zh-hk'), 'zh-TW');
    assert.strictEqual(i18n.intlLocaleOf('ko'), 'ko-KR');
  });

  test('CLI locale sources: --lang → LC_ALL → LC_MESSAGES → LANG', () => {
    assert.strictEqual(i18n.resolveCliLocale(['--lang', 'ko'], {}), 'ko');
    assert.strictEqual(i18n.resolveCliLocale(['--watch', '--lang=ja'], { LANG: 'zh_CN.UTF-8' }), 'ja');
    assert.strictEqual(i18n.resolveCliLocale([], { LC_ALL: 'C', LANG: 'zh_TW.UTF-8' }), 'zh_TW.UTF-8');
    assert.strictEqual(i18n.resolveCliLocale([], { LC_MESSAGES: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' }), 'ko_KR.UTF-8');
    assert.ok(typeof i18n.resolveCliLocale([], {}) === 'string');
  });

  test('dictionaries are merged per region; missing keys fall back to English, then to the key name', () => {
    const dir = path.join(TMP, 'l10n');
    fs.mkdirSync(dir, { recursive: true });
    const w = (f, o) => fs.writeFileSync(path.join(dir, f), typeof o === 'string' ? o : JSON.stringify(o));
    w('core.en.json', { a: 'A', b: 'B {x}', 'dur.m': 'm', 'dur.s': 's' });
    w('views.en.json', { c: 'C' });
    w('cli.en.json', { d: 'D' });
    w('core.zh-cn.json', { a: '甲', 'dur.m': '分', 'dur.s': '秒' });
    w('compact.zh-cn.json', { c: '丙' });
    w('webview.zh-cn.json', '{ broken');
    i18n.clearCache();
    const zh = i18n.createI18n('zh-CN', { dir });
    assert.strictEqual(zh.locale, 'zh-cn');
    assert.strictEqual(zh.t('a'), '甲');
    assert.strictEqual(zh.t('b', { x: 1 }), 'B 1', 'falls back to English');
    assert.strictEqual(zh.t('c'), '丙', 'files from other regions are merged too');
    assert.strictEqual(zh.t('d'), 'D');
    assert.strictEqual(zh.t('nope.key'), 'nope.key');
    assert.ok(zh.has('d') && !zh.has('nope.key'));
    assert.strictEqual(zh.fmtDur(63000), '1分03秒');
    assert.ok(i18n.loadErrors.some((e) => e.file.endsWith('webview.zh-cn.json')), 'a bad file is recorded instead of throwing');
    const ja = i18n.createI18n('ja-JP', { dir });
    assert.strictEqual(ja.t('a'), 'A', 'no files for this language: everything falls back to English');
    assert.deepStrictEqual(Object.keys(zh.dict(['a', 'b'])).sort(), ['a', 'b']);
  });

  test('interpolation: missing placeholders are kept, null becomes an empty string', () => {
    assert.strictEqual(i18n.interpolate('{a}-{b}-{c}', { a: 1, b: null }), '1--{c}');
    assert.strictEqual(i18n.interpolate('x {a}', undefined), 'x {a}');
  });

  test('English runtime dictionary has all status, lamp, quota, entry, etc. keys', () => {
    i18n.clearCache();
    const en = i18n.createI18n('en');
    for (const c of status.STATUS_CODES) assert.ok(en.has('status.' + c), 'status.' + c);
    for (const l of status.LAMPS) { assert.ok(en.has('lamp.' + l), 'lamp.' + l); assert.ok(en.has('lamp.' + l + '.short')); }
    for (const k of ['session', 'weekly', 'model', 'spend', 'window', 'unknown']) assert.ok(en.has('quota.' + k), 'quota.' + k);
    for (const k of ['vscode', 'cli', 'desktop', 'sdk', 'exec', 'other']) assert.ok(en.has('entry.' + k), 'entry.' + k);
    for (const k of ['main', 'subagent', 'workflowAgent', 'codexSubagent', 'reviewer']) assert.ok(en.has('agent.' + k), 'agent.' + k);
    for (const k of ['s', 'm', 'h', 'd']) assert.ok(en.has('dur.' + k));
    assert.strictEqual(en.t('status.awaitingApproval'), 'Waiting for your approval');
    assert.strictEqual(en.t('status.maybeAwaitingApproval'), 'May be waiting for your approval');
    assert.strictEqual(en.t('cost.label'), 'API-equivalent cost');
    // every entry is a string and placeholders only use {word}
    const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'core.en.json'), 'utf8'));
    for (const [k, v] of Object.entries(all)) {
      assert.strictEqual(typeof v, 'string', k);
      for (const m of v.matchAll(/\{([^{}]*)\}/g)) assert.ok(/^\w+$/.test(m[1]), `${k} malformed placeholder {${m[1]}}`);
    }
    // no hard-coded CJK text
    assert.ok(!/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(JSON.stringify(all)));
  });

  test('nine regions × five languages: key sets match English and each key has the same placeholders; same for package.nls', () => {
    const ph = (s) => (String(s).match(/\{\w+\}/g) || []).slice().sort().join(',');
    // no exemptions for untranslated keys: any missing key fails
    const same = (en, loc, label) => {
      const missing = Object.keys(en).filter((k) => !(k in loc));
      const extra = Object.keys(loc).filter((k) => !(k in en));
      assert.deepStrictEqual([missing, extra], [[], []], `${label}: ${missing.length} missing, ${extra.length} extra`);
      const bad = Object.keys(en).filter((k) => k in loc && ph(en[k]) !== ph(loc[k]));
      assert.deepStrictEqual(bad, [], `${label}: placeholders differ`);
    };
    const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.deepStrictEqual([...i18n.REGIONS], ['core', 'views', 'webview', 'cli', 'compact', 'storage', 'push', 'alerts', 'history']);
    for (const region of i18n.REGIONS) {
      const en = read(`l10n/${region}.en.json`);
      for (const loc of ['zh-cn', 'zh-tw', 'ko', 'ja']) same(en, read(`l10n/${region}.${loc}.json`), `${region}.${loc}`);
    }
    const nls = read('package.nls.json');
    for (const loc of ['zh-cn', 'zh-tw', 'ko', 'ja']) same(nls, read(`package.nls.${loc}.json`), `package.nls.${loc}`);
  });

  test('session list side is configurable (default follows the terminal, on the right): the extension description and the "pick a session" hint do not hard-code left/right', () => {
    const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    // how "left / right" is written in each language (the left / right options of the sessionListPosition setting are about sides by definition, so they are not checked)
    const side = /\b(left|right)\b|左|右|왼쪽|오른쪽/i;
    for (const loc of ['en', 'zh-cn', 'zh-tw', 'ko', 'ja']) {
      const nls = read(loc === 'en' ? 'package.nls.json' : `package.nls.${loc}.json`);
      assert.ok(!side.test(nls.description), `package.nls.${loc} description hard-codes left/right: ${nls.description}`);
      const views = read(`l10n/views.${loc}.json`);
      assert.ok(!side.test(views['session.none']), `views.${loc} session.none hard-codes left/right: ${views['session.none']}`);
    }
  });

  test('formatting: durations', () => {
    const en = i18n.createI18n('en', { dicts: { en: { 'dur.s': 's', 'dur.m': 'm', 'dur.h': 'h', 'dur.d': 'd' } } });
    assert.strictEqual(en.fmtDur(5000), '5s');
    assert.strictEqual(en.fmtDur(63000), '1m03s');
    assert.strictEqual(en.fmtDur(3723000), '1h02m');
    assert.strictEqual(en.fmtDur(25 * 3600e3 + 60e3), '1d01h');
    assert.strictEqual(en.fmtDur(-1), '');
    assert.strictEqual(en.fmtDur(null), '');
    assert.strictEqual(en.fmtDur(NaN), '');
  });

  test('formatting: tokens, percentages, money (Intl)', () => {
    const en = i18n.createI18n('en', { dicts: { en: {} } });
    const zh = i18n.createI18n('zh-cn', { dicts: { en: {} } });
    const ko = i18n.createI18n('ko', { dicts: { en: {} } });
    assert.strictEqual(en.fmtTokens(412345), '412.3K');
    assert.strictEqual(en.fmtTokens(999), '999');
    assert.strictEqual(zh.fmtTokens(412345), '41.2万');
    assert.strictEqual(ko.fmtTokens(412345), '41.2만');
    assert.strictEqual(en.fmtTokens(null), '—');
    assert.strictEqual(en.fmtPct(0.423), '42%');
    assert.strictEqual(en.fmtPct(null), '—');
    assert.strictEqual(en.fmtUsd(0.4), '$0.400');
    assert.strictEqual(en.fmtUsd(2.32), '$2.32');
    assert.strictEqual(en.fmtUsd(0.0004), '<$0.001');
    assert.strictEqual(en.fmtUsd(0), '$0.000');
    assert.strictEqual(en.fmtUsd(null), '—');
    assert.strictEqual(zh.fmtUsd(1234.5), '$1,234.50');
    assert.strictEqual(en.fmtNum(1234567), '1,234,567');
  });

  test('formatting: clock times and relative times (fixed time zone)', () => {
    const now = T('2026-09-14T03:00:00Z'); // 12:00 in Seoul
    const en = i18n.createI18n('en', { dicts: { en: {} }, timeZone: 'Asia/Seoul' });
    const zh = i18n.createI18n('zh-cn', { dicts: { en: {} }, timeZone: 'Asia/Seoul' });
    assert.match(en.fmtClock(T('2026-09-14T05:30:00Z'), now), /^2:30\sPM$/u);
    assert.strictEqual(zh.fmtClock(T('2026-09-14T05:30:00Z'), now), '14:30');
    assert.match(en.fmtClock(T('2026-09-15T17:00:00Z'), now), /^Wed/, 'a different day includes the weekday');
    assert.match(en.fmtClock(T('2026-10-20T17:00:00Z'), now), /Oct/, 'further away includes month and day');
    assert.strictEqual(en.fmtAgo(now - 3000, now), 'now');
    assert.strictEqual(zh.fmtAgo(now - 3 * 60e3, now), '3分钟前');
    assert.match(en.fmtAgo(now - 2 * 3600e3, now), /2/);
    assert.match(en.fmtAgo(now + 5 * 60e3, now), /^in /);
    assert.ok(en.fmtDateTime(now).length > 5);
    assert.strictEqual(en.fmtClock(null, now), '');
  });

  test('injection into the webview: JSON is safely escaped and can be restored in a browser environment', () => {
    const inst = i18n.createI18n('ko', { dicts: { en: { 'wv.a': 'A', 'wv.b': 'B', other: 'x' }, ko: { 'wv.a': '</script><b>가' } } });
    const json = inst.webviewJson(['wv.']);
    assert.ok(!json.includes('</script>'));
    assert.ok(!json.includes('<'));
    const p = JSON.parse(json);
    assert.deepStrictEqual(p, { locale: 'ko', intlLocale: 'ko-KR', dict: { 'wv.a': '</script><b>가', 'wv.b': 'B' } });
    // simulate the webview: no require / module, run the file directly
    const sandbox = { Intl, console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'i18n.js'), 'utf8'), sandbox);
    const W = sandbox.AgentMonitorI18n;
    assert.ok(W && typeof W.fromPayload === 'function');
    const w = W.fromPayload(p);
    assert.strictEqual(w.t('wv.a'), '</script><b>가');
    assert.strictEqual(w.t('wv.b'), 'B');
    assert.strictEqual(w.locale, 'ko');
    assert.strictEqual(w.fmtTokens(41234), '4.1만');
  });
}

// ---------- Run ----------

try {
  console.log('JsonlTail');
  jsonlTests();
  console.log('\nStatus codes and lamps');
  statusTests();
  console.log('\nPricing');
  pricingTests();
  console.log('\nCompaction estimate');
  compactTests();
  console.log('\nQuota');
  quotaTests();
  console.log('\nContext');
  contextTests();
  console.log('\nResume');
  resumeTests();
  console.log('\ni18n and formatting');
  i18nTests();
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
