'use strict';
// Tests for lib/providers/gemini.js (and the Gemini rows of lib/core/pricing.js). Run with plain node: node test/gemini.test.js
// All data is synthetic and built at runtime in a temp directory (AGENT_MONITOR_TEST_TMP, else the system temp directory);
// the directory is deleted after the run. Never reads ~/.gemini.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gemini = require('../lib/providers/gemini');
const { GeminiProvider, newSessionState, ingestGemini, aggregate, classifySession, stepOf, timelineOf, resultOf,
  guessGeminiApproval, describeGeminiCall } = gemini;
const pricing = require('../lib/core/pricing');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-gemini-'));

// ---------- Helpers ----------

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(true);
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`  FAIL  ${name}\n        ${String((err && err.stack) || err).split('\n').slice(0, 5).join('\n        ')}`);
  }
}
const approx = (a, b, eps = 1e-9, msg) => assert.ok(a != null && Math.abs(a - b) <= eps, msg || `${a} ≠ ${b}`);
const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const S = (s) => T0 + s * 1000;
const iso = (s) => new Date(S(s)).toISOString();
const line = (o) => JSON.stringify(o) + '\n';
const SID = (n) => `9e0e0000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const meta = (sid, s, extra = {}) => ({ sessionId: sid, projectHash: 'ph', startTime: iso(s), lastUpdated: iso(s), kind: 'main', ...extra });
const user = (id, s, text) => ({ id, timestamp: iso(s), type: 'user', content: [{ text }] });
const fnResp = (id, s, callId, name) => ({ id, timestamp: iso(s), type: 'user',
  content: [{ functionResponse: { id: callId, name, response: { output: 'ok' } } }] });
const gem = (id, s, content, extra = {}) => ({ id, timestamp: iso(s), type: 'gemini', content, model: 'gemini-2.5-pro', ...extra });
const tok = (input, output, cached = 0, thoughts = 0, tool = 0) => ({ input, output, cached, thoughts, tool, total: input + output + thoughts + tool });
const call = (id, name, args, s, extra = {}) => ({ id, name, args, status: 'success', timestamp: iso(s), ...extra });
const upd = (s) => ({ $set: { lastUpdated: iso(s) } });

function stateOf(records, limits) {
  const s = newSessionState(limits);
  for (const r of records) ingestGemini(s, JSON.parse(JSON.stringify(r)));
  return s;
}
// Classify with the file last written at second `writtenS` and "now" at second `nowS`
function cls(s, writtenS, nowS, extra = {}) {
  return classifySession(s, { now: S(nowS), mtimeMs: S(writtenS), staleMs: 5 * 60e3, staleMinutes: 5, settleMs: 30e3, ...extra });
}

function chatsDir(home, slug, root) {
  const pd = path.join(home, 'tmp', slug);
  const d = path.join(pd, 'chats');
  fs.mkdirSync(d, { recursive: true });
  if (root) fs.writeFileSync(path.join(pd, '.project_root'), root);
  return d;
}
function writeRecs(file, recs, mtimeS) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map(line).join(''));
  if (mtimeS != null) touch(file, mtimeS);
}
function appendRecs(file, recs, mtimeS) {
  fs.appendFileSync(file, recs.map(line).join(''));
  if (mtimeS != null) touch(file, mtimeS);
}
function touch(file, s) { fs.utimesSync(file, new Date(S(s)), new Date(S(s))); }
function provider(home, extra = {}) {
  return new GeminiProvider({ geminiHome: home, activeWindowMinutes: 30, staleMinutes: 5, ...extra });
}

// ---------- Pricing ----------

console.log('pricing (Gemini)');

test('Gemini prices: short / long context, cached and thoughts', () => {
  // 2.5 Pro ≤200k: (60000 × 1.25 + 40000 × 0.125 + (1000 + 500) × 10) / 1e6
  approx(pricing.priceGeminiTokens('gemini-2.5-pro', tok(100000, 1000, 40000, 500)), 0.095);
  // > 200k prompt → long-context prices for the whole request
  approx(pricing.priceGeminiTokens('gemini-2.5-pro', tok(300000, 1000)), (300000 * 2.5 + 1000 * 15) / 1e6);
  approx(pricing.priceGeminiTokens('gemini-3.1-pro-preview', tok(1e6, 1e6)), 4 + 18);
  approx(pricing.priceGeminiTokens('gemini-3.1-pro-preview', tok(100, 0)), 100 * 2 / 1e6);
  approx(pricing.priceGeminiTokens('gemini-2.5-flash-lite', tok(1e6, 1e6, 5e5)), 0.05 + 0.005 + 0.4);
  approx(pricing.priceGeminiTokens('gemini-3.5-flash', tok(0, 1e6)), 9);
  approx(pricing.priceGeminiTokens('gemini-3-flash-preview', tok(1e6, 0)), 0.5);
});

test('Gemini prices: dated intro price, aliases, tool tokens, unknown models', () => {
  const before = Date.UTC(2026, 8, 24);
  const after = Date.UTC(2027, 0, 1);
  approx(pricing.priceGeminiTokens('gemini-3.8-flash', tok(1e6, 1e6), { atMs: before }), 0.75 + 3.75);
  approx(pricing.priceGeminiTokens('gemini-3.8-flash', tok(1e6, 1e6), { atMs: after }), 1.5 + 7.5);
  approx(pricing.priceGeminiTokens('gemini-3.6-flash', tok(1e6, 0, 1e6), { atMs: before }), 0.075);
  approx(pricing.priceGeminiTokens('models/Gemini-2.5-Flash', tok(1e6, 0)), 0.3);
  approx(pricing.priceGeminiTokens('gemini-3.1-pro-preview-customtools', tok(100000, 0)), 0.2);
  // tool-use prompt tokens are priced as input
  approx(pricing.priceGeminiTokens('gemini-2.5-flash', { input: 0, output: 0, tool: 1e6 }), 0.3);
  assert.strictEqual(pricing.priceGeminiTokens('gemini-3-pro-preview', tok(10, 10)), null);
  assert.strictEqual(pricing.priceGeminiTokens('gemini-2.5-pro-preview-05-06', tok(10, 10)), null);
  assert.strictEqual(pricing.priceGeminiTokens(null, tok(10, 10)), null);
  assert.strictEqual(pricing.GEMINI_PRICES_UPDATED, '2026-09-24');
  const t = pricing.geminiUsageTokens({ input: 10, cached: 50, output: 2 });
  assert.deepStrictEqual(t, { input: 10, cached: 10, output: 2, thoughts: 0, tool: 0, total: 12 });
});

// ---------- Recording state ----------

console.log('recording state');

test('same message id appended again: last copy wins, tokens counted once, place kept', () => {
  const s = stateOf([
    meta(SID(1), 0),
    user('u-1', 1, 'run the tests'),
    upd(1),
    gem('g-1', 5, 'I will run the tests.', { thoughts: [{ subject: 'Plan', description: 'x', timestamp: iso(4) }] }),
    // tokens arrive after the message (recordMessageTokens appends the same id again)
    gem('g-1', 5, 'I will run the tests.', { tokens: tok(18000, 100, 12000, 200) }),
    gem('g-1', 5, 'I will run the tests.', { tokens: tok(18000, 100, 12000, 200),
      toolCalls: [call('c-1', 'run_shell_command', { command: 'npm test' }, 30)] }),
    fnResp('u-2', 30, 'c-1', 'run_shell_command'),
    upd(30),
  ]);
  assert.deepStrictEqual(s.order, ['u-1', 'g-1', 'u-2']);
  const a = aggregate(s);
  assert.strictEqual(a.apiCalls, 1);
  assert.strictEqual(a.input, 18000);
  assert.strictEqual(a.cached, 12000);
  assert.strictEqual(a.output, 300);
  assert.strictEqual(a.thoughts, 200);
  assert.strictEqual(a.processed, 18300);
  assert.strictEqual(a.toolCalls, 1);
  assert.strictEqual(s.msgs.get('g-1').toolCalls[0].detail, 'npm test');
  assert.strictEqual(s.firstPrompt, 'run the tests');
  assert.strictEqual(s.meta.sessionId, SID(1));
  // tool results sent back → the model is working again
  const st = cls(s, 30, 40);
  assert.strictEqual(st.code, 'thinking');
  assert.strictEqual(st.certainty, 'guess');
  assert.deepStrictEqual(stepOf(s).kind, 'toolResult');
  assert.strictEqual(stepOf(s).tool, 'run_shell_command');
});

test('$rewindTo drops the message and everything after it; spent tokens stay counted', () => {
  const recs = [
    meta(SID(2), 0),
    user('u-1', 1, 'first question'),
    gem('g-1', 3, 'first answer', { tokens: tok(1000, 10) }),
    user('u-2', 10, 'second question'),
    gem('g-2', 12, 'second answer', { tokens: tok(2000, 20) }),
    { $rewindTo: 'u-2' },
  ];
  const s = stateOf(recs);
  assert.deepStrictEqual(s.order, ['u-1', 'g-1']);
  assert.strictEqual(s.rewinds, 1);
  const a = aggregate(s);
  assert.strictEqual(a.apiCalls, 2);
  assert.strictEqual(a.processed, 3030);
  // the conversation now ends with the first answer
  assert.strictEqual(resultOf(s).text, 'first answer');
  assert.ok(!timelineOf(s, 30).some((e) => e.detail === 'second question'));
  assert.strictEqual(cls(s, 12, 100).code, 'done');
  // unknown id: the conversation is cleared (as the CLI loader does)
  const s2 = stateOf([...recs, { $rewindTo: 'nope' }]);
  assert.deepStrictEqual(s2.order, []);
  assert.strictEqual(aggregate(s2).apiCalls, 2);
  assert.strictEqual(s2.firstPrompt, 'first question');
});

test('$set: summary / lastUpdated merge, messages checkpoint rebuilds the conversation', () => {
  const s = stateOf([
    meta(SID(3), 0),
    user('u-1', 1, 'read the config'),
    gem('g-1', 4, '', { tokens: tok(500, 5) }),
    { $set: { summary: '  Read the config file  ', lastUpdated: iso(4) } },
    // checkpoint (updateMessagesFromHistory): content now carries the functionCall parts
    { $set: { messages: [
      user('u-1', 1, 'read the config'),
      gem('g-1', 4, [{ functionCall: { name: 'read_file', args: { file_path: '/repo/src/config/app.json' } } }], { tokens: tok(500, 5) }),
    ], lastUpdated: iso(4) } },
  ]);
  assert.strictEqual(s.meta.summary, 'Read the config file');
  assert.strictEqual(s.lastUpdatedMs, S(4));
  assert.strictEqual(s.checkpoints, 1);
  assert.deepStrictEqual(s.order, ['u-1', 'g-1']);
  assert.strictEqual(aggregate(s).apiCalls, 1);
  const step = stepOf(s);
  assert.strictEqual(step.kind, 'tool');
  assert.strictEqual(step.tool, 'read_file');
  assert.strictEqual(step.detail, '…/config/app.json');
  // read_file is a fast tool: after 60 s without a result it may be waiting for approval
  assert.strictEqual(cls(s, 4, 30).code, 'tool');
  const st = cls(s, 4, 70);
  assert.strictEqual(st.code, 'maybeAwaitingApproval');
  assert.strictEqual(st.pendingTool, 'read_file');
  assert.strictEqual(st.certainty, 'guess');
  assert.strictEqual(st.sinceMs, S(4));
  assert.strictEqual(cls(s, 4, 70, { approvalGuess: 'off' }).code, 'tool');
});

test('malformed and unknown records are skipped', () => {
  const s = newSessionState();
  for (const e of [null, [], 42, { foo: 1 }, { $set: [] }, { $rewindTo: 5 }, { id: 'x1', type: 'user', content: 'hi', timestamp: 'bad' }]) {
    ingestGemini(s, e);
  }
  assert.deepStrictEqual(s.order, ['x1']);
  assert.strictEqual(s.meta, null);
});

// ---------- Guessed status ----------

console.log('guessed status');

test('prompt → thinking (guess) → stale; metadata only → starting / stale', () => {
  const s0 = stateOf([meta(SID(4), 0)]);
  assert.strictEqual(cls(s0, 0, 10).code, 'starting');
  assert.strictEqual(cls(s0, 0, 10).certainty, 'guess');
  assert.strictEqual(cls(s0, 0, 400).code, 'stale');
  const s = stateOf([meta(SID(4), 0), user('u-1', 2, 'hello'), upd(2)]);
  const st = cls(s, 2, 100);
  assert.strictEqual(st.code, 'thinking');
  assert.strictEqual(st.sinceMs, S(2));
  assert.strictEqual(st.certainty, 'guess');
  assert.strictEqual(stepOf(s).kind, 'prompt');
  assert.strictEqual(cls(s, 2, 2 + 301).code, 'stale');
});

test('text answer: working while recent, done (guess) once quiet for settleSeconds', () => {
  const s = stateOf([meta(SID(5), 0), user('u-1', 1, 'hi'), gem('g-1', 5, 'Hello there!', { tokens: tok(100, 5) }), upd(5)]);
  assert.strictEqual(cls(s, 5, 20).code, 'thinking');
  const done = cls(s, 5, 40);
  assert.strictEqual(done.code, 'done');
  assert.strictEqual(done.certainty, 'guess');
  assert.strictEqual(done.sinceMs, S(5));
  assert.strictEqual(cls(s, 5, 20, { settleMs: 10e3 }).code, 'done');
  // a sub-agent still writing: the invoking tool is running
  assert.strictEqual(cls(s, 5, 40, { childWorking: true }).code, 'tool');
  // notices and slash commands after the answer do not change it
  const s2 = stateOf([meta(SID(5), 0), user('u-1', 1, 'hi'), gem('g-1', 5, 'Hello'),
    user('u-2', 50, '/stats'), { id: 'i-1', timestamp: iso(51), type: 'info', content: 'Session stats…' }]);
  assert.strictEqual(cls(s2, 51, 100).code, 'done');
  assert.strictEqual(s2.firstPrompt, 'hi');
});

test('pending tool call: unknown name stays tool then stale; allTools / off modes', () => {
  // tool-call-only response: the CLI records content '' before the tools run
  const s = stateOf([meta(SID(6), 0), user('u-1', 1, 'fix it'), gem('g-1', 3, '', { tokens: tok(100, 5) }), upd(3)]);
  const st = cls(s, 3, 70);
  assert.strictEqual(st.code, 'tool');
  assert.strictEqual(st.pendingTool, null);
  assert.strictEqual(st.certainty, 'guess');
  const stale = cls(s, 3, 3 + 301);
  assert.strictEqual(stale.code, 'stale');
  assert.strictEqual(stale.stalePending, true);
  const all = cls(s, 3, 3 + 301, { approvalGuess: 'allTools' });
  assert.strictEqual(all.code, 'maybeAwaitingApproval');
  assert.strictEqual(all.certainty, 'guess');
  // a visible slow tool is never guessed in fastTools mode
  const sh = stateOf([meta(SID(6), 0), user('u-1', 1, 'test'),
    gem('g-1', 3, [{ functionCall: { name: 'run_shell_command', args: { command: 'npm test' } } }])]);
  const t = cls(sh, 3, 100);
  assert.strictEqual(t.code, 'tool');
  assert.strictEqual(t.pendingTool, 'run_shell_command');
  assert.strictEqual(stepOf(sh).detail, 'npm test');
  assert.strictEqual(guessGeminiApproval({ pending: [{ tool: 'write_file', sinceMs: 0 }], now: 59e3 }), null);
  assert.deepStrictEqual(guessGeminiApproval({ pending: [{ tool: 'write_file', sinceMs: 0 }], now: 60e3 }), { tool: 'write_file', sinceMs: 0 });
  assert.strictEqual(guessGeminiApproval({ pending: [{ tool: 'write_file', sinceMs: 0 }], now: 1e9, mode: 'off' }), null);
});

test('certain states: error record, quota error, cancelled tools, ask_user, complete_task', () => {
  const base = [meta(SID(7), 0), user('u-1', 1, 'go')];
  const err = cls(stateOf([...base, { id: 'e-1', timestamp: iso(4), type: 'error', content: '[API Error: 500 Internal error]\nmore' }]), 4, 500);
  assert.strictEqual(err.code, 'apiError');
  assert.strictEqual(err.certainty, 'certain');
  assert.strictEqual(err.error.http, 500);
  assert.strictEqual(err.error.message, '[API Error: 500 Internal error]');
  const q = cls(stateOf([...base, { id: 'e-1', timestamp: iso(4), type: 'error', content: 'RESOURCE_EXHAUSTED: Quota exceeded' }]), 4, 10);
  assert.strictEqual(q.code, 'quota');
  assert.strictEqual(q.quota.source, 'text');
  const cancelled = stateOf([...base, gem('g-1', 3, '', { toolCalls: [call('c-1', 'replace', { file_path: '/a/b.js' }, 9, { status: 'cancelled' })] })]);
  assert.strictEqual(cls(cancelled, 9, 10).code, 'interrupted');
  const cancelled2 = stateOf([...base, gem('g-1', 3, '', { toolCalls: [call('c-1', 'replace', {}, 9, { status: 'cancelled' })] }),
    fnResp('u-2', 9, 'c-1', 'replace')]);
  assert.strictEqual(cls(cancelled2, 9, 10).code, 'interrupted');
  const ask = cls(stateOf([...base, gem('g-1', 3, [{ functionCall: { name: 'ask_user', args: { questions: [] } } }])]), 3, 200);
  assert.strictEqual(ask.code, 'awaitingInput');
  assert.strictEqual(ask.question, 'askUser');
  assert.strictEqual(ask.certainty, 'certain');
  const fin = stateOf([meta('sub-x', 0, { kind: 'subagent' }), user('u-1', 1, 'investigate'),
    gem('g-1', 3, '', { toolCalls: [call('c-9', 'complete_task', { result: 'done' }, 4)] })]);
  const d = cls(fin, 4, 5);
  assert.strictEqual(d.code, 'done');
  assert.strictEqual(d.certainty, 'certain');
});

test('result keeps the latest answer up to resultChars; older answers keep a short excerpt', () => {
  const long = 'x'.repeat(5000);
  const s = stateOf([meta(SID(9), 0), user('u-1', 1, 'a'), gem('g-1', 2, 'y'.repeat(1000)), user('u-2', 3, 'b'),
    gem('g-2', 4, [{ text: long }, { text: 'hidden thought', thought: true }])], { ...gemini.DEFAULT_LIMITS, resultChars: 4000 });
  assert.strictEqual(resultOf(s).text.length, 4000);
  assert.strictEqual(s.msgs.get('g-2').text.length, 300);
  assert.ok(!resultOf(s).text.includes('hidden'));
  ingestGemini(s, { $rewindTo: 'u-2' });
  assert.strictEqual(resultOf(s).text.length, 300);
});

test('tool errors, file changes and timeline', () => {
  const s = stateOf([
    meta(SID(8), 0),
    user('u-1', 1, 'write files'),
    gem('g-1', 2, 'Writing.', { tokens: tok(100, 5), toolCalls: [
      call('c-1', 'write_file', { file_path: '/r/new.txt', content: 'x' }, 3, { resultDisplay: { fileDiff: '', originalContent: null, newContent: 'x' } }),
      call('c-2', 'replace', { file_path: '/r/old.txt' }, 4),
      call('c-3', 'run_shell_command', { command: 'false' }, 5, { status: 'error',
        result: [{ functionResponse: { id: 'c-3', name: 'run_shell_command', response: { error: 'Command failed\nexit 1' } } }] }),
    ] }),
    fnResp('u-2', 5, 'c-1', 'write_file'),
  ]);
  const a = aggregate(s);
  assert.strictEqual(a.toolCalls, 3);
  assert.strictEqual(a.toolErrors, 1);
  assert.deepStrictEqual([...a.files.values()].map((f) => [f.path, f.op]), [['/r/new.txt', 'create'], ['/r/old.txt', 'edit']]);
  assert.deepStrictEqual(a.errors, [{ ms: S(5), tool: 'run_shell_command', text: 'Command failed' }]);
  const tl = timelineOf(s, 30);
  assert.deepStrictEqual(tl.map((e) => e.kind), ['prompt', 'text', 'toolDone', 'toolDone', 'toolError']);
  assert.deepStrictEqual(timelineOf(s, 2).map((e) => e.kind), ['toolDone', 'toolError']);
  assert.deepStrictEqual(describeGeminiCall({ name: 'mcp_tool', args: {}, description: 'Do a thing' }), { tool: 'mcp_tool', detail: 'Do a thing' });
});

// ---------- Provider ----------

console.log('provider');

test('scan: tokens, cost, context, title, cwd, guessed live status', () => {
  const home = path.join(TMP, 'h-scan');
  const d = chatsDir(home, 'my-app', '/work/my-app');
  const f = path.join(d, `session-2026-09-20T09-59-${SID(10).slice(0, 8)}.jsonl`);
  writeRecs(f, [
    meta(SID(10), -60),
    user('u-1', -50, 'Run the test suite please'),
    gem('g-1', -40, '', { tokens: tok(100000, 1000, 40000, 500), toolCalls: [call('c-1', 'run_shell_command', { command: 'npm test' }, -20)] }),
    fnResp('u-2', -20, 'c-1', 'run_shell_command'),
    gem('g-2', -10, 'All tests pass.', { tokens: tok(120000, 200, 100000, 0), model: 'gemini-3.8-flash' }),
    upd(-10),
  ], -10);
  const p = provider(home);
  let [s] = p.scan(S(0));
  assert.ok(s);
  assert.strictEqual(s.key, `gemini:${SID(10)}`);
  assert.strictEqual(s.provider, 'gemini');
  assert.strictEqual(s.title, 'Run the test suite please');
  assert.strictEqual(s.titleSource, 'prompt');
  assert.strictEqual(s.cwd, '/work/my-app');
  assert.strictEqual(s.projectDir, path.join(home, 'tmp', 'my-app'));
  assert.strictEqual(s.entry, 'cli');
  assert.strictEqual(s.model, 'gemini-3.8-flash');
  assert.strictEqual(s.createdMs, S(-60));
  assert.strictEqual(s.transcript, f);
  assert.strictEqual(s.main.kind, 'main');
  assert.strictEqual(s.main.tokens.contextUsed, 120000);
  assert.strictEqual(s.main.tokens.contextWindow, 1048576);
  assert.strictEqual(s.contextWindowSource, 'model-rule');
  assert.strictEqual(s.contextPct, Math.round(120000 / 1048576 * 100));
  assert.strictEqual(s.main.tokens.output, 1700);
  assert.strictEqual(s.main.tokens.processed, 101500 + 120200);
  assert.strictEqual(s.main.tokens.apiCalls, 2);
  assert.strictEqual(s.main.tokens.cached, 140000);
  assert.strictEqual(s.main.tokens.thoughts, 500);
  const expected = 0.095 + (20000 * 0.75 + 100000 * 0.075 + 200 * 3.75) / 1e6;
  approx(s.costUsd, expected, 1e-12);
  approx(s.main.costUsd, expected, 1e-12);
  assert.strictEqual(s.unpricedModel, null);
  assert.strictEqual(s.main.toolCalls, 1);
  assert.strictEqual(s.lastApiMs, S(-10));
  // written 10 s ago: still working (guess), live
  assert.strictEqual(s.main.status.code, 'thinking');
  assert.strictEqual(s.live, true);
  assert.strictEqual(s.liveStatus, 'busy');
  assert.strictEqual(s.liveCertainty, 'guess');
  assert.strictEqual(s.counts.running, 1);
  // quiet for longer than settleSeconds: done (guess), no longer live
  [s] = p.scan(S(60));
  assert.strictEqual(s.main.status.code, 'done');
  assert.strictEqual(s.main.status.certainty, 'guess');
  assert.strictEqual(s.doneAtMs, S(-10));
  assert.strictEqual(s.live, false);
  assert.strictEqual(s.liveStatus, null);
  // $set summary → AI title
  appendRecs(f, [{ $set: { summary: 'Run tests' } }], 60);
  [s] = p.scan(S(66));
  assert.strictEqual(s.title, 'Run tests');
  assert.strictEqual(s.titleSource, 'ai');
  // outside the activity window it disappears; keepKeys keeps it
  assert.strictEqual(p.scan(S(60 + 31 * 60)).length, 0);
  assert.strictEqual(p.scan(S(60 + 31 * 60 + 6), { keepKeys: [`gemini:${SID(10)}`] }).length, 1);
});

test('unpriced models: partial cost with unpricedModel, all unpriced → null', () => {
  const home = path.join(TMP, 'h-unpriced');
  const d = chatsDir(home, 'p1', '/w/p1');
  writeRecs(path.join(d, `session-2026-09-20T09-59-${SID(11).slice(0, 8)}.jsonl`), [
    meta(SID(11), -60), user('u-1', -50, 'a'),
    gem('g-1', -40, 'x', { tokens: tok(1000, 10), model: 'gemini-2.5-flash' }),
    gem('g-2', -30, 'y', { tokens: tok(1000, 10), model: 'gemini-9-ultra' }),
  ], -30);
  writeRecs(path.join(d, `session-2026-09-20T09-58-${SID(12).slice(0, 8)}.jsonl`), [
    meta(SID(12), -60), user('u-1', -50, 'b'), gem('g-1', -40, 'z', { tokens: tok(1000, 10), model: 'gemini-9-ultra' }),
  ], -40);
  const sessions = provider(home).scan(S(0));
  const a = sessions.find((x) => x.id === SID(11));
  const b = sessions.find((x) => x.id === SID(12));
  approx(a.costUsd, (1000 * 0.3 + 10 * 2.5) / 1e6);
  assert.strictEqual(a.unpricedModel, 'gemini-9-ultra');
  assert.strictEqual(b.costUsd, null);
  assert.strictEqual(b.main.costUsd, null);
  assert.strictEqual(b.main.tokens.contextWindow, null);
  assert.strictEqual(b.contextPct, null);
});

test('incremental tail: appended lines read once, repeated ids deduped, rewrite starts over', () => {
  const home = path.join(TMP, 'h-tail');
  const d = chatsDir(home, 'p', '/w/p');
  const f = path.join(d, `session-2026-09-20T10-00-${SID(13).slice(0, 8)}.jsonl`);
  writeRecs(f, [meta(SID(13), 0), user('u-1', 1, 'hi'), gem('g-1', 2, 'Hello', { tokens: tok(100, 5) })], 2);
  const p = provider(home);
  let [s] = p.scan(S(3));
  const r = p.readers.get(f);
  assert.strictEqual(r.tail.lines, 3);
  const added = [gem('g-1', 2, 'Hello', { tokens: tok(100, 5) }), user('u-2', 10, 'more'), gem('g-2', 12, 'Sure', { tokens: tok(200, 7) })];
  appendRecs(f, added, 12);
  [s] = p.scan(S(13));
  assert.strictEqual(r.tail.bytesRead, Buffer.byteLength(added.map(line).join('')));
  assert.strictEqual(r.tail.lines, 6);
  assert.strictEqual(s.main.tokens.apiCalls, 2);
  assert.strictEqual(s.main.tokens.processed, 105 + 207);
  // partial line waits for its newline
  fs.appendFileSync(f, '{"id":"u-3","timestamp":"' + iso(20) + '","type":"user","content":"par');
  touch(f, 20);
  [s] = p.scan(S(21));
  assert.strictEqual(r.tail.lines, 6);
  fs.appendFileSync(f, 'tial"}\n');
  touch(f, 21);
  [s] = p.scan(S(22));
  assert.strictEqual(r.tail.lines, 7);
  assert.strictEqual(s.main.status.code, 'thinking');
  assert.strictEqual(s.main.step.detail, 'partial');
  // atomic rewrite to a smaller file: read again from the start
  writeRecs(f, [meta(SID(13), 0), user('u-1', 1, 'hi')], 30);
  [s] = p.scan(S(31));
  assert.strictEqual(r.tail.resets, 1);
  assert.strictEqual(s.main.tokens.apiCalls, 0);
});

test('legacy session-*.json: whole-file parse only on change; migrated .json skipped', () => {
  const home = path.join(TMP, 'h-legacy');
  const d = chatsDir(home, 'old', '/w/old');
  const f = path.join(d, `session-2026-09-20T09-50-${SID(14).slice(0, 8)}.json`);
  const record = {
    sessionId: SID(14), projectHash: 'ph', startTime: iso(-600), lastUpdated: iso(-30),
    messages: [user('u-1', -600, 'legacy prompt'), gem('g-1', -590, 'legacy answer', { tokens: tok(1000, 10, 0, 5) })],
  };
  fs.writeFileSync(f, JSON.stringify(record, null, 2));
  touch(f, -30);
  const p = provider(home);
  let [s] = p.scan(S(0));
  const r = p.readers.get(f);
  assert.strictEqual(r.tail.parses, 1);
  assert.strictEqual(s.id, SID(14));
  assert.strictEqual(s.title, 'legacy prompt');
  assert.strictEqual(s.main.tokens.output, 15);
  assert.strictEqual(s.main.status.code, 'done');
  p.scan(S(6));
  assert.strictEqual(r.tail.parses, 1);
  record.messages.push(user('u-2', -5, 'next'));
  fs.writeFileSync(f, JSON.stringify(record, null, 2));
  touch(f, -5);
  [s] = p.scan(S(12));
  assert.strictEqual(r.tail.parses, 2);
  assert.strictEqual(s.main.status.code, 'thinking');
  // the CLI resumed it and migrated it to .jsonl next to it: only the .jsonl is read
  writeRecs(f + 'l', [meta(SID(14), -600), ...record.messages, gem('g-2', 20, 'migrated', { tokens: tok(10, 1) })], 20);
  const all = p.scan(S(21));
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].transcript, f + 'l');
  assert.ok(!p.readers.has(f));
  assert.strictEqual(all[0].main.tokens.apiCalls, 2);
});

test('sub-agents: child recordings under chats/<parentId>/, parent outside the window, names from agentId', () => {
  const home = path.join(TMP, 'h-sub');
  const d = chatsDir(home, 'proj', '/w/proj');
  const main = path.join(d, `session-2026-09-20T08-00-${SID(20).slice(0, 8)}.jsonl`);
  writeRecs(main, [
    meta(SID(20), -7200),
    user('u-1', -7200, 'investigate the codebase'),
    gem('g-1', -7190, '', { tokens: tok(5000, 50) }), // tool-call-only response: invoke_agent is running
  ], -7190);
  const sub = path.join(d, SID(20), 'sub-a.jsonl');
  writeRecs(sub, [
    meta('sub-a', -100, { kind: 'subagent', directories: ['/w/proj'] }),
    user('s-u1', -100, 'Investigate the auth module'),
    gem('s-g1', -90, '', { tokens: tok(3000, 30), model: 'gemini-2.5-flash', toolCalls: [call('s-c1', 'read_file', { file_path: '/w/proj/auth.js' }, -80)] }),
    fnResp('s-u2', -80, 's-c1', 'read_file'),
  ], -80);
  // an orphan sub-agent whose parent recording does not exist becomes its own session
  writeRecs(path.join(d, SID(99), 'orphan.jsonl'), [meta('orphan', -50, { kind: 'subagent' }), user('o-1', -50, 'orphan task')], -50);
  const p = provider(home);
  let sessions = p.scan(S(0));
  let s = sessions.find((x) => x.id === SID(20));
  assert.ok(s, 'parent outside the window is included because its sub-agent is active');
  assert.strictEqual(sessions.length, 2);
  assert.strictEqual(sessions.find((x) => x.id === 'orphan').main.kind, 'main');
  assert.strictEqual(s.agents.length, 1);
  const child = s.agents[0];
  assert.strictEqual(child.id, 'sub-a');
  assert.strictEqual(child.kind, 'geminiSubagent');
  assert.strictEqual(child.status.code, 'thinking');
  assert.strictEqual(child.model, 'gemini-2.5-flash');
  assert.strictEqual(child.tokens.apiCalls, 1);
  assert.strictEqual(s.updatedMs, S(-80));
  // parent: its pending call is being run by the sub-agent, not waiting for approval
  assert.strictEqual(s.main.status.code, 'tool');
  assert.strictEqual(s.live, true);
  approx(s.costUsd, s.main.costUsd + child.costUsd);
  // the sub-agent finishes, then the parent records the finished call with agentId
  appendRecs(sub, [gem('s-g2', 10, 'Found it.', { toolCalls: [call('s-c2', 'complete_task', { result: 'ok' }, 11)] })], 11);
  appendRecs(main, [
    gem('g-1', -7190, '', { tokens: tok(5000, 50), toolCalls: [call('c-1', 'invoke_agent', { agent_name: 'codebase_investigator' }, 12, { agentId: 'sub-a' })] }),
    fnResp('u-2', 12, 'c-1', 'invoke_agent'),
  ], 12);
  sessions = p.scan(S(13));
  s = sessions.find((x) => x.id === SID(20));
  assert.strictEqual(s.agents[0].status.code, 'done');
  assert.strictEqual(s.agents[0].name, 'codebase_investigator');
  assert.strictEqual(s.agents[0].agentType, 'invoke_agent');
  assert.strictEqual(s.main.status.code, 'thinking');
  assert.strictEqual(s.counts.total, 2);
  // details for both agents
  const det = p.details([s.key, 'codex:whatever']);
  assert.deepStrictEqual(Object.keys(det), [s.key]);
  assert.deepStrictEqual(Object.keys(det[s.key].agents).sort(), [SID(20), 'sub-a'].sort());
  assert.strictEqual(det[s.key].agents['sub-a'].result.text, 'Found it.');
  assert.ok(p.has(SID(20)));
  assert.ok(p.has(`gemini:${SID(20)}`));
  assert.ok(!p.has(`codex:${SID(20)}`));
  assert.strictEqual(p.detail('gemini:nope'), null);
});

test('maybeAwaitingApproval end to end, quota snapshot, detail timeline', () => {
  const home = path.join(TMP, 'h-approval');
  const d = chatsDir(home, 'p', '/w/p');
  const f = path.join(d, `session-2026-09-20T10-00-${SID(30).slice(0, 8)}.jsonl`);
  writeRecs(f, [
    meta(SID(30), 0), user('u-1', 1, 'edit it'),
    { $set: { messages: [user('u-1', 1, 'edit it'), gem('g-1', 2, [{ text: 'Editing.' }, { functionCall: { name: 'replace', args: { file_path: '/w/p/a.js' } } }])] } },
  ], 2);
  const p = provider(home, { approvalGuessSeconds: 30 });
  let [s] = p.scan(S(10));
  assert.strictEqual(s.main.status.code, 'tool');
  [s] = p.scan(S(40));
  assert.strictEqual(s.main.status.code, 'maybeAwaitingApproval');
  assert.strictEqual(s.main.status.pendingTool, 'replace');
  assert.strictEqual(s.liveStatus, 'waiting');
  assert.strictEqual(s.counts.awaiting, 1);
  const tl = p.detail(s.key).agents[SID(30)].timeline;
  assert.deepStrictEqual(tl.map((e) => [e.kind, e.tool]), [['prompt', null], ['text', null], ['tool', 'replace']]);
  assert.deepStrictEqual(p.quota(), { lastHit: null });
  appendRecs(f, [{ id: 'e-1', timestamp: iso(50), type: 'error', content: 'Quota exceeded (429)' }], 50);
  [s] = p.scan(S(51));
  assert.strictEqual(s.main.status.code, 'quota');
  assert.strictEqual(s.counts.error, 1);
  const q = p.quota().lastHit;
  assert.strictEqual(q.sessionKey, s.key);
  assert.strictEqual(q.ms, S(50));
  assert.strictEqual(p.detail(s.key).agents[SID(30)].errors[0].text, 'Quota exceeded (429)');
});

test('home resolution: GEMINI_CLI_HOME, sandbox runtime dir, projects.json / hash cwd', () => {
  const base = path.join(TMP, 'envbase');
  const p = new GeminiProvider({ env: { GEMINI_CLI_HOME: base }, activeWindowMinutes: 30 });
  assert.strictEqual(p.home, path.join(base, '.gemini'));
  assert.strictEqual(p.homeSource, 'env');
  assert.deepStrictEqual(p.runtimeDirs, [path.join(base, '.gemini'), path.join(base, '.cache', '.gemini')]);
  assert.strictEqual(new GeminiProvider({ geminiHome: '/x/y', env: { GEMINI_CLI_HOME: base } }).homeSource, 'setting');
  assert.deepStrictEqual(new GeminiProvider({ geminiHome: '/x/y' }).runtimeDirs, ['/x/y']);
  assert.strictEqual(new GeminiProvider({ env: {} }).homeSource, 'default');
  // sandbox runtime dir with a slug from projects.json (no .project_root marker)
  const rt = path.join(base, '.cache', '.gemini');
  const d = chatsDir(rt, 'web', null);
  fs.writeFileSync(path.join(rt, 'projects.json'), JSON.stringify({ projects: { '/w/web': 'web', '/w/api': 'api' } }));
  writeRecs(path.join(d, `session-2026-09-20T10-00-${SID(40).slice(0, 8)}.jsonl`), [meta(SID(40), 0), user('u-1', 1, 'x')], 1);
  // legacy sha256 directory name
  const hash = crypto.createHash('sha256').update('/w/api').digest('hex');
  const d2 = chatsDir(rt, hash, null);
  writeRecs(path.join(d2, `session-2026-09-20T10-00-${SID(41).slice(0, 8)}.jsonl`), [meta(SID(41), 0), user('u-1', 1, 'y')], 1);
  // unknown dir: projectHash matched against the registry paths
  const d3 = chatsDir(rt, 'zzz', null);
  writeRecs(path.join(d3, `session-2026-09-20T10-00-${SID(42).slice(0, 8)}.jsonl`),
    [meta(SID(42), 0, { projectHash: crypto.createHash('sha256').update('/w/web').digest('hex') }), user('u-1', 1, 'z')], 1);
  const sessions = p.scan(S(5));
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  assert.strictEqual(byId[SID(40)].cwd, '/w/web');
  assert.strictEqual(byId[SID(41)].cwd, '/w/api');
  assert.strictEqual(byId[SID(42)].cwd, '/w/web');
});

test('bounded work: at most maxTracked recordings read per scan; discovery cached between scans', () => {
  const home = path.join(TMP, 'h-many');
  const d = chatsDir(home, 'p', '/w/p');
  for (let i = 0; i < 6; i++) {
    writeRecs(path.join(d, `session-2026-09-20T10-0${i}-${SID(50 + i).slice(0, 8)}.jsonl`), [meta(SID(50 + i), 0), user('u-1', 1, `q${i}`)], i);
  }
  // not session files: ignored
  fs.writeFileSync(path.join(d, `session-x.jsonl.tmp-123`), '{}\n');
  fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
  const p = provider(home, { maxTracked: 2 });
  const sessions = p.scan(S(10));
  assert.strictEqual(p.files.size, 6);
  assert.strictEqual(p.readers.size, 2);
  assert.deepStrictEqual(sessions.map((s) => s.id), [SID(55), SID(54)]);
  // a new file is picked up only at the next discovery (every 5 s)
  writeRecs(path.join(d, `session-2026-09-20T10-09-${SID(60).slice(0, 8)}.jsonl`), [meta(SID(60), 0), user('u-1', 1, 'new')], 9);
  assert.ok(!p.scan(S(11)).some((s) => s.id === SID(60)));
  assert.ok(p.scan(S(16)).some((s) => s.id === SID(60)));
  p.dispose();
  assert.strictEqual(p.readers.size, 0);
});

// ---------- Done ----------

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
