'use strict';
// Tests for lib/providers/qwen.js and lib/core/pricing-qwen.js. Run with plain node: node test/qwen.test.js
// All data is synthetic and built at runtime in a temp directory (record shapes follow Qwen Code's chat-record contract fixtures);
// nothing in the repo or the real ~/.qwen is touched.
// Temp directory: AGENT_MONITOR_TEST_TMP (falls back to the system temp directory); deleted after the run.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const qwen = require('../lib/providers/qwen');
const { QwenProvider, newFileState, ingestQwen, classifyAgent, stepOf, describeArgs, isPidAlive, aliveOf, readRuntime,
  sanitizeCwd, CHAT_RE } = qwen;
const pq = require('../lib/core/pricing-qwen');
const { STATUS, STEP, isGuessCode } = require('../lib/core/status');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-qwen-'));

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
const ISO = (s) => new Date(S(s)).toISOString();
const CWD = '/workspace/project';
const SID = (n) => `5e55a000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const KEY = (n) => `qwen:${SID(n)}`;
const HOST = os.hostname();

let uuidN = 0;
function rec(sid, sec, type, extra = {}) {
  return { uuid: `u-${++uuidN}`, parentUuid: null, sessionId: sid, timestamp: ISO(sec), type, cwd: CWD, version: '0.9.0', ...extra };
}
const user = (sid, sec, text, extra) => rec(sid, sec, 'user', { message: { role: 'user', parts: [{ text }] }, ...extra });
const call = (id, name, args = {}) => ({ functionCall: { id, name, args } });
function asst(sid, sec, parts, o = {}) {
  const e = rec(sid, sec, 'assistant', { message: { role: 'model', parts }, ...(o.extra || {}) });
  if (o.model !== undefined) e.model = o.model; else e.model = 'qwen3-coder-plus';
  if (o.usage) e.usageMetadata = o.usage;
  if (o.ctx !== undefined) e.contextWindowSize = o.ctx; else e.contextWindowSize = 1000000;
  return e;
}
function result(sid, sec, id, name, status = 'success', extra = {}) {
  const response = status === 'error' ? { error: 'boom: file not found\nstack…' } : { output: 'ok' };
  return rec(sid, sec, 'tool_result', {
    message: { role: 'user', parts: [{ functionResponse: { id, name, response } }] },
    toolCallResult: { callId: id, status, resultDisplay: extra.resultDisplay ?? null, ...(extra.tcr || {}) },
    ...(extra.rec || {}),
  });
}
const sys = (sid, sec, subtype, systemPayload, extra) => rec(sid, sec, 'system', { subtype, systemPayload, ...extra });
const usage = (prompt, cand, o = {}) => ({
  promptTokenCount: prompt, candidatesTokenCount: cand, cachedContentTokenCount: o.cached || 0,
  thoughtsTokenCount: o.thoughts || 0, totalTokenCount: o.total ?? prompt + cand + (o.thoughts || 0),
});

function stateOf(recs) {
  const f = newFileState();
  for (const r of recs) ingestQwen(f, r);
  return f;
}
const CL = (now, extra = {}) => ({ now, staleMs: 5 * 60e3, staleMinutes: 5, approvalGuessSeconds: 60, ...extra });

// A fresh Qwen home with helpers to write transcripts and runtime sidecars
let homeN = 0;
function makeHome() {
  const home = path.join(TMP, `home-${++homeN}`);
  const chats = path.join(home, 'projects', sanitizeCwd(CWD), 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const fileOf = (sid) => path.join(chats, `${sid}.jsonl`);
  return {
    home, chats, fileOf,
    write(sid, recs, mtimeSec, append = false) {
      const body = recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r) + '\n')).join('');
      if (append) fs.appendFileSync(fileOf(sid), body); else fs.writeFileSync(fileOf(sid), body);
      const t = S(mtimeSec) / 1000;
      fs.utimesSync(fileOf(sid), t, t);
    },
    runtime(sid, o = {}) {
      const rt = { schema_version: 1, pid: o.pid ?? process.pid, session_id: o.sessionId ?? sid, work_dir: CWD,
        hostname: o.hostname ?? HOST, started_at: o.startedAt ?? ISO(0), qwen_version: '0.9.0' };
      fs.writeFileSync(path.join(chats, `${sid}.runtime.json`), JSON.stringify(rt));
    },
  };
}
function provider(h, opts = {}) {
  return new QwenProvider({ qwenHome: h.home, activeWindowMinutes: 30, staleMinutes: 5, approvalGuessSeconds: 60, ...opts });
}
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return r.pid;
}

// ---------- Parsing, pairing, tokens ----------

function parseTests() {
  test('contract fixture: functionCall paired with tool_result by id', () => {
    const f = stateOf([
      user('s', 0, 'read the index'),
      rec('s', 2, 'assistant', { message: { role: 'model', parts: [{ functionCall: { id: 'read-1', name: 'read_file', args: { path: '/workspace/project/src/index.ts' } } }] } }),
      rec('s', 3, 'tool_result', { message: { role: 'user', parts: [{ functionResponse: { id: 'read-1', name: 'read_file', response: { output: '…' } } }] },
        toolCallResult: { callId: 'read-1', status: 'success' } }),
    ]);
    const s = f.main;
    assert.strictEqual(s.toolCalls, 1);
    assert.strictEqual(s.pending.size, 0);
    assert.strictEqual(s.lastEvent.kind, 'toolResult');
    assert.strictEqual(s.lastEvent.tool, 'read_file');
    assert.strictEqual(f.cwd, CWD);
    assert.strictEqual(f.version, '0.9.0');
    const st = stepOf(s);
    assert.strictEqual(st.kind, STEP.TOOL_RESULT);
    assert.strictEqual(st.detail, '…/src/index.ts');
  });

  test('parallel calls: one result leaves the other pending; step shows parallel count', () => {
    const f = stateOf([
      user('s', 0, 'go'),
      asst('s', 1, [call('a', 'read_file', { absolute_path: '/x/y/a.js' }), call('b', 'run_shell_command', { command: 'npm test' })]),
      result('s', 2, 'a', 'read_file'),
    ]);
    const s = f.main;
    assert.deepStrictEqual([...s.pending.keys()], ['b']);
    const st = stepOf(s);
    assert.strictEqual(st.kind, STEP.TOOL);
    assert.strictEqual(st.tool, 'run_shell_command');
    assert.strictEqual(st.detail, 'npm test');
    assert.strictEqual(st.parallel, 1);
    const cs = classifyAgent(s, CL(S(10)));
    assert.strictEqual(cs.code, STATUS.TOOL);
    assert.strictEqual(cs.pendingTool, 'run_shell_command');
  });

  test('calls without ids pair by tool name; duplicate call ids count once', () => {
    const f = stateOf([
      user('s', 0, 'go'),
      asst('s', 1, [{ functionCall: { name: 'glob', args: { pattern: '*.ts' } } }, { functionCall: { name: 'glob', args: { pattern: '*.js' } } }]),
      rec('s', 2, 'tool_result', { message: { role: 'user', parts: [{ functionResponse: { name: 'glob', response: { output: '' } } }] } }),
      asst('s', 3, [call('dup', 'list_directory', { path: '/a/b/c' })]),
      asst('s', 3, [call('dup', 'list_directory', { path: '/a/b/c' })]),
    ]);
    const s = f.main;
    assert.strictEqual(s.toolCalls, 3);
    assert.strictEqual(s.pending.size, 2); // one glob + the dedup'ed list_directory
    assert.ok([...s.pending.values()].some((p) => p.tool === 'glob' && p.detail === '*.js'));
  });

  test('error result → toolErrors, errors[] and toolError timeline; cancelled → interrupted', () => {
    const f = stateOf([
      user('s', 0, 'go'),
      asst('s', 1, [call('e1', 'read_file', { file_path: '/nope' })]),
      result('s', 2, 'e1', 'read_file', 'error', { tcr: { error: { message: 'File not found: /nope' } } }),
      asst('s', 3, [call('c1', 'run_shell_command', { command: 'rm -rf build' })]),
      result('s', 4, 'c1', 'run_shell_command', 'cancelled'),
    ]);
    const s = f.main;
    assert.strictEqual(s.toolErrors, 1);
    assert.deepStrictEqual(s.errors[0], { ms: S(2), tool: 'read_file', text: 'File not found: /nope' });
    assert.ok(s.timeline.some((e) => e.kind === 'toolError'));
    assert.strictEqual(classifyAgent(s, CL(S(10))).code, STATUS.INTERRUPTED);
    assert.strictEqual(classifyAgent(s, CL(S(10))).sinceMs, S(4));
  });

  test('text-only assistant ends the turn → done, with result text', () => {
    const f = stateOf([
      user('s', 0, 'hello'),
      asst('s', 1, [{ text: 'thinking…', thought: true }]),
      asst('s', 2, [{ text: 'All done.' }]),
    ]);
    const s = f.main;
    const st = classifyAgent(s, CL(S(3)));
    assert.strictEqual(st.code, STATUS.DONE);
    assert.strictEqual(st.sinceMs, S(2));
    assert.strictEqual(s.result.text, 'All done.');
    assert.strictEqual(s.lastDoneMs, S(2));
    // Only a thought so far: thinking, not done
    const g = stateOf([user('s', 0, 'hello'), asst('s', 1, [{ text: 'hmm', thought: true }])]).main;
    assert.strictEqual(classifyAgent(g, CL(S(2))).code, STATUS.THINKING);
    // Prompt only: starting
    assert.strictEqual(classifyAgent(stateOf([user('s', 0, 'hi')]).main, CL(S(1))).code, STATUS.STARTING);
  });

  test('tokens: sums per call, context from the last promptTokenCount, pct from contextWindowSize', () => {
    const f = stateOf([
      user('s', 0, 'go'),
      asst('s', 1, [call('a', 'read_file', { file_path: '/a' })], { usage: usage(20000, 500), ctx: 262144 }),
      result('s', 2, 'a', 'read_file'),
      asst('s', 3, [{ text: 'ok' }], { usage: usage(40000, 1000, { thoughts: 200 }), ctx: 262144 }),
    ]);
    const s = f.main;
    assert.strictEqual(s.usage.apiCalls, 2);
    assert.strictEqual(s.usage.output, 500 + 1200);        // total − prompt
    assert.strictEqual(s.usage.processed, 20500 + 41200);
    assert.strictEqual(s.ctxUsed, 40000);
    assert.strictEqual(s.ctxWindow, 262144);
    assert.strictEqual(s.lastApiMs, S(3));
  });

  test('cost: qwen3-coder-plus priced by tier; Qwen OAuth alias stays unpriced', () => {
    const f = stateOf([
      user('s', 0, 'go'),
      asst('s', 1, [{ text: 'ok' }], { usage: usage(20000, 500) }),
    ]);
    approx(f.main.usage.costUsd, (20000 * 1 + 500 * 5) / 1e6);
    assert.strictEqual(f.main.usage.pricedAny, true);
    const g = stateOf([user('s', 0, 'go'), asst('s', 1, [{ text: 'ok' }], { usage: usage(1000, 10), model: 'coder-model' })]);
    assert.strictEqual(g.main.usage.pricedAny, false);
    assert.strictEqual(g.main.usage.unpricedTokens, 1010);
    assert.strictEqual(g.main.usage.unpricedModel, 'coder-model');
  });

  test('describeArgs: Qwen tool names', () => {
    assert.strictEqual(describeArgs('write_file', { file_path: '/a/b/c/d.ts' }), '…/c/d.ts');
    assert.strictEqual(describeArgs('run_shell_command', { command: 'ls', description: 'List files' }), 'List files');
    assert.strictEqual(describeArgs('grep_search', { pattern: 'TODO' }), 'TODO');
    assert.strictEqual(describeArgs('read_many_files', { paths: ['/a/b/x.md', '/a/b/y.md'] }), '…/b/x.md +1');
    assert.strictEqual(describeArgs('task', { description: 'Explore repo', subagent_type: 'general' }), 'Explore repo');
    assert.strictEqual(describeArgs('todo_write', { todos: [] }), null);
    assert.strictEqual(describeArgs('mcp_tool', { foo: 'bar' }), 'bar');
  });

  test('chat_compression: counted, manual after /compress, context drops to newTokenCount', () => {
    const f = stateOf([
      user('s', 0, 'go'),
      asst('s', 1, [{ text: 'ok' }], { usage: usage(90000, 10) }),
      sys('s', 10, 'slash_command', { phase: 'invocation', rawCommand: '/compress' }),
      sys('s', 12, 'chat_compression', { info: { originalTokenCount: 90000, newTokenCount: 12000, compressionStatus: 1 } }),
      sys('s', 20, 'chat_compression', { info: { originalTokenCount: 12000, newTokenCount: 15000 } }), // inflated: ignored
    ]);
    const s = f.main;
    assert.strictEqual(s.compactCount, 1);
    assert.deepStrictEqual(s.lastCompact, { ms: S(12), trigger: 'manual', preTokens: 90000, postTokens: 12000, model: 'qwen3-coder-plus' });
    assert.strictEqual(s.ctxUsed, 12000);
  });

  test('turn_result states and unknown subtypes', () => {
    const base = [user('s', 0, 'go'), asst('s', 1, [call('a', 'run_shell_command', { command: 'x' })])];
    const done = stateOf([...base, sys('s', 2, 'turn_result', { state: 'completed', stopReason: 'end_turn' })]).main;
    assert.strictEqual(classifyAgent(done, CL(S(3))).code, STATUS.DONE);
    const cancel = stateOf([...base, sys('s', 2, 'turn_result', { state: 'cancelled' })]).main;
    assert.strictEqual(classifyAgent(cancel, CL(S(3))).code, STATUS.INTERRUPTED);
    const err = stateOf([...base, sys('s', 2, 'turn_result', { state: 'error', error: { message: 'Connection reset\nmore', code: 'ECONNRESET' } })]).main;
    const st = classifyAgent(err, CL(S(3), { alive: true }));
    assert.strictEqual(st.code, STATUS.API_ERROR);
    assert.deepStrictEqual(st.error, { kind: 'ECONNRESET', http: null, message: 'Connection reset' });
    const odd = stateOf([...base, sys('s', 2, 'agent_retry', {}), sys('s', 2, 'something_new', null), { type: 'weird' }, null]).main;
    assert.strictEqual(odd.pending.size, 1);
  });

  test('ui_telemetry api_error: retrying while alive and recent, then apiError; quota wording → quota', () => {
    const base = [user('s', 0, 'go')];
    const ev = (sec, extra) => sys('s', sec, 'ui_telemetry', { uiEvent: { 'event.name': 'qwen-code.api_error', model: 'qwen3-coder-plus', ...extra } });
    const s = stateOf([...base, ev(1, { error: 'Request timed out', status_code: 504, error_type: 'TimeoutError' }), ev(5, { error: 'Request timed out', status_code: 504 })]).main;
    const r = classifyAgent(s, CL(S(10), { alive: true }));
    assert.strictEqual(r.code, STATUS.RETRYING);
    assert.strictEqual(r.retry.attempt, 2);
    const late = classifyAgent(s, CL(S(400), { alive: true }));
    assert.strictEqual(late.code, STATUS.API_ERROR);
    assert.strictEqual(late.error.http, 504);
    assert.strictEqual(classifyAgent(s, CL(S(10), { alive: false })).code, STATUS.API_ERROR);
    const q = stateOf([...base, ev(1, { error: 'Qwen OAuth quota exceeded: free daily quota used up', status_code: 429 })]).main;
    const qs = classifyAgent(q, CL(S(2), { alive: true }));
    assert.strictEqual(qs.code, STATUS.QUOTA);
    assert.strictEqual(qs.quota.source, 'text');
    // A later assistant record clears the error
    const ok = stateOf([...base, ev(1, { error: 'x', status_code: 500 }), asst('s', 3, [{ text: 'fine' }])]).main;
    assert.strictEqual(classifyAgent(ok, CL(S(4))).code, STATUS.DONE);
    // An error after the turn ended (utility call) is ignored
    const after = stateOf([...base, asst('s', 1, [{ text: 'fine' }]), ev(2, { error: 'x', status_code: 500 })]).main;
    assert.strictEqual(classifyAgent(after, CL(S(3))).code, STATUS.DONE);
  });
}

// ---------- Guessed needs-you ----------

function guessTests() {
  const pendingOf = (tool, args = {}) => stateOf([user('s', 0, 'go'), asst('s', 1, [call('p', tool, args)])]).main;

  test('fast tool without a result for ≥ 60 s → maybeAwaitingApproval, marked as a guess', () => {
    const s = pendingOf('edit', { file_path: '/a/b.ts' });
    const early = classifyAgent(s, CL(S(30)));
    assert.strictEqual(early.code, STATUS.TOOL);
    const st = classifyAgent(s, CL(S(90)));
    assert.strictEqual(st.code, STATUS.MAYBE_AWAITING_APPROVAL);
    assert.strictEqual(st.certainty, 'guess');
    assert.ok(isGuessCode(st.code));
    assert.strictEqual(st.pendingTool, 'edit');
    assert.strictEqual(st.sinceMs, S(1));
  });

  test('slow tool is not guessed in fastTools mode; allTools guesses after staleMinutes; off never guesses', () => {
    const s = pendingOf('run_shell_command', { command: 'npm test' });
    assert.strictEqual(classifyAgent(s, CL(S(90))).code, STATUS.TOOL);
    assert.strictEqual(classifyAgent(s, CL(S(200), { approvalGuess: 'allTools', staleMinutes: 3 })).code, STATUS.MAYBE_AWAITING_APPROVAL);
    assert.strictEqual(classifyAgent(s, CL(S(90), { approvalGuess: 'allTools', staleMinutes: 3 })).code, STATUS.TOOL);
    const f = pendingOf('read_file', { file_path: '/a' });
    assert.strictEqual(classifyAgent(f, CL(S(90), { approvalGuess: 'off' })).code, STATUS.TOOL);
  });

  test('no guess once the process is gone (killed wins)', () => {
    const s = pendingOf('edit', { file_path: '/a' });
    assert.strictEqual(classifyAgent(s, CL(S(90), { alive: false })).code, STATUS.KILLED);
  });

  test('open turn with no writes past staleMinutes → stale with stalePending', () => {
    const s = pendingOf('run_shell_command', { command: 'sleep 999' });
    const st = classifyAgent(s, CL(S(400)));
    assert.strictEqual(st.code, STATUS.STALE);
    assert.strictEqual(st.stalePending, true);
    assert.strictEqual(st.pendingTool, 'run_shell_command');
  });
}

// ---------- Provider: scan, tail, liveness ----------

function scanTests() {
  test('scan: session fields, tokens, context %, cost, title from first prompt', () => {
    const h = makeHome();
    const sid = SID(1);
    h.write(sid, [
      user(sid, 0, 'Fix the failing build please'),
      asst(sid, 1, [call('w', 'write_file', { file_path: '/workspace/project/new.ts' })], { usage: usage(50000, 100), ctx: 200000 }),
      result(sid, 2, 'w', 'write_file', 'success', { resultDisplay: { fileName: 'new.ts', originalContent: null, newContent: 'x' } }),
      asst(sid, 3, [{ text: 'Build fixed.' }], { usage: usage(51000, 300), ctx: 200000 }),
    ], 3);
    const p = provider(h);
    const out = p.scan(S(10));
    assert.strictEqual(out.length, 1);
    const s = out[0];
    assert.strictEqual(s.key, KEY(1));
    assert.strictEqual(s.provider, 'qwen');
    assert.strictEqual(s.title, 'Fix the failing build please');
    assert.strictEqual(s.titleSource, 'prompt');
    assert.strictEqual(s.cwd, CWD);
    assert.strictEqual(s.projectDir, path.dirname(h.chats));
    assert.strictEqual(s.entry, 'cli');
    assert.strictEqual(s.version, '0.9.0');
    assert.strictEqual(s.model, 'qwen3-coder-plus');
    assert.strictEqual(s.main.status.code, STATUS.DONE);
    assert.strictEqual(s.doneAtMs, S(3));
    assert.strictEqual(s.contextUsed, 51000);
    assert.strictEqual(s.contextWindow, 200000);
    assert.strictEqual(s.contextWindowSource, 'qwen-record');
    assert.strictEqual(s.contextPct, 26); // round(51000 / 200000 × 100)
    assert.strictEqual(s.main.tokens.output, 400);
    assert.strictEqual(s.main.tokens.apiCalls, 2);
    approx(s.costUsd, (50000 * 1.8 + 100 * 9 + 51000 * 1.8 + 300 * 9) / 1e6); // 32K–128K tier
    assert.strictEqual(s.main.filesChanged, 1);
    assert.strictEqual(s.transcript, h.fileOf(sid));
    assert.strictEqual(s.live, false);          // no runtime.json
    assert.strictEqual(s.liveStatus, null);
    assert.deepStrictEqual(s.resume, []);
    assert.strictEqual(s.createdMs, S(0));
    assert.strictEqual(s.startedMs, S(0));
  });

  test('incremental tail: partial lines wait, appended records advance the status', () => {
    const h = makeHome();
    const sid = SID(2);
    h.write(sid, [user(sid, 0, 'go'), asst(sid, 1, [call('r', 'run_shell_command', { command: 'make' })])], 1);
    const p = provider(h);
    let s = p.scan(S(5))[0];
    assert.strictEqual(s.main.status.code, STATUS.TOOL);
    const tail = p.tails.get(sid);
    const off1 = tail.offset;
    const res = JSON.stringify(result(sid, 6, 'r', 'run_shell_command')) + '\n';
    const fin = JSON.stringify(asst(sid, 7, [{ text: 'Built.' }]));
    // Partial line: only the first half of the result is written
    h.write(sid, [res.slice(0, 40)], 6, true);
    s = p.scan(S(6))[0];
    assert.strictEqual(s.main.status.code, STATUS.TOOL);
    assert.strictEqual(tail.state.lines, 2);
    h.write(sid, [res.slice(40), fin + '\n'], 7, true);
    s = p.scan(S(8))[0];
    assert.strictEqual(s.main.status.code, STATUS.DONE);
    assert.strictEqual(tail.state.lines, 4);
    assert.strictEqual(tail.resets, 0);
    assert.ok(tail.offset > off1);
    assert.strictEqual(p.tails.get(sid), tail); // same reader, not re-created
  });

  test('liveness: runtime pid alive → live, liveStatus busy / waiting / idle', () => {
    const h = makeHome();
    const sid = SID(3);
    h.write(sid, [user(sid, 0, 'go'), asst(sid, 1, [call('e', 'edit', { file_path: '/a/b.ts' })])], 1);
    h.runtime(sid, { pid: process.pid });
    const p = provider(h);
    let s = p.scan(S(10))[0];
    assert.strictEqual(s.live, true);
    assert.strictEqual(s.main.status.code, STATUS.TOOL);
    assert.strictEqual(s.liveStatus, 'busy');
    s = p.scan(S(120))[0];
    assert.strictEqual(s.main.status.code, STATUS.MAYBE_AWAITING_APPROVAL);
    assert.strictEqual(s.main.status.certainty, 'guess');
    assert.strictEqual(s.liveStatus, 'waiting');
    assert.strictEqual(s.counts.awaiting, 1);
    h.write(sid, [result(sid, 121, 'e', 'edit'), asst(sid, 122, [{ text: 'done' }])], 122, true);
    s = p.scan(S(130))[0];
    assert.strictEqual(s.main.status.code, STATUS.DONE);
    assert.strictEqual(s.live, true);
    assert.strictEqual(s.liveStatus, 'idle');
  });

  test('liveness: dead pid with an open turn → killed; finished turn stays done', () => {
    const h = makeHome();
    const pid = deadPid();
    assert.strictEqual(isPidAlive(pid), false);
    const a = SID(4);
    const b = SID(5);
    h.write(a, [user(a, 0, 'go'), asst(a, 1, [call('r', 'run_shell_command', { command: 'make' })])], 1);
    h.write(b, [user(b, 0, 'go'), asst(b, 1, [{ text: 'bye' }])], 1);
    h.runtime(a, { pid });
    h.runtime(b, { pid });
    const out = provider(h).scan(S(10));
    const sa = out.find((x) => x.id === a);
    const sb = out.find((x) => x.id === b);
    assert.strictEqual(sa.live, false);
    assert.strictEqual(sa.main.status.code, STATUS.KILLED);
    assert.strictEqual(sa.main.status.certainty, 'certain');
    assert.strictEqual(sb.main.status.code, STATUS.DONE);
    assert.strictEqual(sb.live, false);
  });

  test('liveness: missing runtime.json, other host or other session id → unknown (not live, transcript decides)', () => {
    const h = makeHome();
    const a = SID(6);
    const b = SID(7);
    const c = SID(8);
    for (const id of [a, b, c]) h.write(id, [user(id, 0, 'go'), asst(id, 1, [call('r', 'run_shell_command', { command: 'x' })])], 1);
    h.runtime(b, { hostname: 'some-other-host.example' });
    h.runtime(c, { sessionId: 'another-session' });
    const out = provider(h).scan(S(10));
    for (const s of out) {
      assert.strictEqual(s.live, false, s.id);
      assert.strictEqual(s.main.status.code, STATUS.TOOL, s.id);
    }
    assert.strictEqual(aliveOf({ pid: process.pid, hostname: 'other' }, 'x', HOST), null);
    assert.strictEqual(aliveOf({ pid: 'nope' }, 'x', HOST), null);
    assert.strictEqual(aliveOf(null, 'x', HOST), null);
    assert.strictEqual(aliveOf({ pid: process.pid, hostname: HOST, session_id: 'x' }, 'x', HOST), true);
    assert.strictEqual(readRuntime(path.join(h.chats, 'missing.runtime.json')), null);
    fs.writeFileSync(path.join(h.chats, 'bad.runtime.json'), '{not json');
    assert.strictEqual(readRuntime(path.join(h.chats, 'bad.runtime.json')), null);
  });

  test('liveness: one pid in two sidecars (session switched) → only the newest session is live', () => {
    const h = makeHome();
    const a = SID(9);
    const b = SID(10);
    h.write(a, [user(a, 0, 'old'), asst(a, 1, [call('r', 'run_shell_command', { command: 'x' })])], 1);
    h.write(b, [user(b, 5, 'new'), asst(b, 6, [{ text: 'hi' }])], 6);
    h.runtime(a, { startedAt: ISO(0) });
    h.runtime(b, { startedAt: ISO(5) });
    const out = provider(h).scan(S(10));
    assert.strictEqual(out.find((x) => x.id === b).live, true);
    const sa = out.find((x) => x.id === a);
    assert.strictEqual(sa.live, false);
    assert.strictEqual(sa.main.status.code, STATUS.KILLED);
  });

  test('isPidAlive: EPERM counts as alive (pid 1)', () => {
    if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return; // no EPERM there
    assert.strictEqual(isPidAlive(1), true);
    assert.strictEqual(isPidAlive(process.pid), true);
    assert.strictEqual(isPidAlive(-5), false);
  });

  test('sub-agents: sidechain records become qwenSubagent agents; parent ended → interrupted', () => {
    const h = makeHome();
    const sid = SID(11);
    const side = (n, name) => ({ extra: { isSidechain: true, agentId: `agent-${n}`, agentName: name } });
    h.write(sid, [
      user(sid, 0, 'research'),
      asst(sid, 1, [call('t1', 'task', { description: 'Explore', subagent_type: 'general-purpose' })]),
      user(sid, 2, 'Explore the repo', { isSidechain: true, agentId: 'agent-1', agentName: 'general-purpose' }),
      asst(sid, 3, [call('g', 'glob', { pattern: '**/*.ts' })], { ...side(1, 'general-purpose'), usage: usage(3000, 50) }),
      user(sid, 4, 'Second', { isSidechain: true, agentId: 'agent-2', agentName: 'reviewer' }),
      asst(sid, 5, [{ text: 'Reviewed.' }], side(2, 'reviewer')),
    ], 5);
    const p = provider(h);
    let s = p.scan(S(10))[0];
    assert.strictEqual(s.agents.length, 2);
    const [g1, g2] = s.agents;
    assert.strictEqual(g1.kind, 'qwenSubagent');
    assert.strictEqual(g1.id, 'agent-1');
    assert.strictEqual(g1.agentType, 'general-purpose');
    assert.strictEqual(g1.status.code, STATUS.TOOL);
    assert.strictEqual(g1.tokens.contextUsed, 3000);
    assert.strictEqual(g2.status.code, STATUS.DONE);
    assert.strictEqual(s.main.status.code, STATUS.TOOL);   // waiting on its task call
    assert.strictEqual(s.main.status.pendingTool, 'task');
    assert.strictEqual(s.main.tokens.contextUsed, 0);      // sidechain usage is not the main context
    assert.strictEqual(s.counts.total, 3);
    // The parent's task call returns and the turn ends while agent-1 never finished
    h.write(sid, [result(sid, 6, 't1', 'task'), asst(sid, 7, [{ text: 'Summary.' }])], 7, true);
    s = p.scan(S(12))[0];
    assert.strictEqual(s.main.status.code, STATUS.DONE);
    assert.strictEqual(s.agents[0].status.code, STATUS.INTERRUPTED);
    const d = p.detail(KEY(11));
    assert.ok(d.agents['agent-1'] && d.agents['agent-2'] && d.agents[sid]);
  });

  test('title: custom_title wins; ai-generated source maps to ai', () => {
    const h = makeHome();
    const a = SID(12);
    const b = SID(13);
    h.write(a, [user(a, 0, 'long prompt text'), sys(a, 1, 'custom_title', { customTitle: 'My Title', titleSource: 'user' })], 1);
    h.write(b, [user(b, 0, 'x'), sys(b, 1, 'custom_title', { customTitle: 'Auto Title', titleSource: 'auto' })], 1);
    const out = provider(h).scan(S(5));
    const sa = out.find((x) => x.id === a);
    const sb = out.find((x) => x.id === b);
    assert.deepStrictEqual([sa.title, sa.titleSource], ['My Title', 'custom']);
    assert.deepStrictEqual([sb.title, sb.titleSource], ['Auto Title', 'ai']);
  });

  test('details / has / keys; quota lastHit', () => {
    const h = makeHome();
    const sid = SID(14);
    h.write(sid, [
      user(sid, 0, 'go'),
      asst(sid, 1, [call('e', 'read_file', { file_path: '/nope' })]),
      result(sid, 2, 'e', 'read_file', 'error'),
      sys(sid, 3, 'ui_telemetry', { uiEvent: { 'event.name': 'qwen-code.api_error', error: 'Insufficient balance', status_code: 402 } }),
    ], 3);
    const p = provider(h);
    const s = p.scan(S(5))[0];
    assert.strictEqual(s.main.status.code, STATUS.QUOTA);
    assert.strictEqual(p.has(KEY(14)), true);
    assert.strictEqual(p.has(SID(14)), true);
    assert.strictEqual(p.has(`codex:${SID(14)}`), false);
    assert.strictEqual(p.detail(`codex:${SID(14)}`), null);
    const ds = p.details([KEY(14), KEY(99)]);
    assert.deepStrictEqual(Object.keys(ds), [KEY(14)]);
    const a = ds[KEY(14)].agents[sid];
    assert.strictEqual(a.errors[0].text, 'boom: file not found');
    assert.ok(a.timeline.some((e) => e.kind === 'quota'));
    const q = p.quota();
    assert.strictEqual(q.lastHit.sessionKey, KEY(14));
    assert.strictEqual(q.lastHit.ms, S(3));
  });

  test('window, keepKeys, maxSessions cap and read budget', () => {
    const h = makeHome();
    const old = SID(20);
    h.write(old, [user(old, 0, 'old'), asst(old, 1, [{ text: 'x' }])], 1);
    for (let i = 21; i <= 24; i++) h.write(SID(i), [user(SID(i), 0, 'n'), asst(SID(i), i, [{ text: 'x' }])], 3600 + i);
    const now = S(3700);
    let p = provider(h);
    let out = p.scan(now);
    assert.deepStrictEqual(out.map((x) => x.id), [SID(24), SID(23), SID(22), SID(21)]);
    p = provider(h);
    out = p.scan(now, { keepKeys: [KEY(20), `codex:${SID(21)}`] });
    assert.ok(out.some((x) => x.id === old));
    p = provider(h, { maxSessions: 2 });
    assert.deepStrictEqual(p.scan(now).map((x) => x.id), [SID(24), SID(23)]);
    // Budget: a big transcript is read over several scans and only shown once complete
    const big = SID(25);
    const pad = 'x'.repeat(2000);
    const recs = [user(big, 3600, 'big')];
    for (let i = 0; i < 40; i++) recs.push(asst(big, 3600, [{ text: pad }]));
    h.write(big, recs, 3699);
    p = provider(h, { readBudgetBytes: 30000 });
    out = p.scan(now);
    assert.ok(!out.some((x) => x.id === big));
    for (let i = 1; i < 10 && !out.some((x) => x.id === big); i++) out = p.scan(now + i);
    assert.ok(out.some((x) => x.id === big));
    assert.strictEqual(p.tails.get(big).state.lines, 41);
  });

  test('never writes into the Qwen home', () => {
    const h = makeHome();
    const sid = SID(30);
    h.write(sid, [user(sid, 0, 'go'), asst(sid, 1, [{ text: 'x' }])], 1);
    h.runtime(sid);
    const snap = () => {
      const out = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f);
          else { const st = fs.statSync(f); out.push(`${f}|${st.size}|${st.mtimeMs}`); }
        }
      };
      walk(h.home);
      return out.sort();
    };
    const before = snap();
    const p = provider(h);
    p.scan(S(5));
    p.details([KEY(30)]);
    p.scan(S(20));
    assert.deepStrictEqual(snap(), before);
    p.dispose();
    assert.strictEqual(p.tails.size, 0);
  });

  test('home resolution: qwenHome → qwen.home → env QWEN_RUNTIME_DIR → QWEN_HOME → ~/.qwen; sanitizeCwd; CHAT_RE', () => {
    assert.strictEqual(new QwenProvider({ qwenHome: '/a' }).home, '/a');
    assert.strictEqual(new QwenProvider({ qwen: { home: '/b' } }).home, '/b');
    assert.strictEqual(new QwenProvider({ env: { QWEN_RUNTIME_DIR: '/c', QWEN_HOME: '/d' } }).home, '/c');
    assert.strictEqual(new QwenProvider({ env: { QWEN_HOME: '/d' } }).home, '/d');
    assert.strictEqual(new QwenProvider({ env: {} }).home, path.join(os.homedir(), '.qwen'));
    assert.strictEqual(sanitizeCwd('/Users/me/my proj.v2', 'darwin'), '-Users-me-my-proj-v2');
    assert.strictEqual(sanitizeCwd('C:\\Work\\App', 'win32'), 'c--work-app');
    assert.ok(CHAT_RE.test(`${SID(1)}.jsonl`));
    assert.ok(!CHAT_RE.test(`${SID(1)}.runtime.json`));
  });
}

// ---------- Pricing ----------

function pricingTests() {
  test('pricing-qwen: tiers, snapshots, vendor prefix, cache, thinking price, unknown models', () => {
    assert.strictEqual(pq.qwenRates('qwen3-coder-plus', 32000).input, 1);
    assert.strictEqual(pq.qwenRates('qwen3-coder-plus', 32001).input, 1.8);
    assert.strictEqual(pq.qwenRates('qwen3-coder-plus', 300000).output, 60);
    assert.strictEqual(pq.qwenRates('qwen3-coder-plus', 2e6).overLimit, true);
    assert.strictEqual(pq.qwenPriceRow('qwen3-coder-plus-2025-09-23').prefix, 'qwen3-coder-plus');
    assert.strictEqual(pq.qwenPriceRow('Qwen/Qwen3-Coder-Flash').prefix, 'qwen3-coder-flash');
    assert.strictEqual(pq.qwenPriceRow('qwen3.6-max-preview').prefix, 'qwen3.6-max-preview');
    assert.strictEqual(pq.qwenPriceRow('qwen3-coder-plusX'), null);
    assert.strictEqual(pq.qwenPriceRow('coder-model'), null);
    assert.strictEqual(pq.priceQwen('coder-model', usage(10, 10)), null);
    // Cached hits at 10 % of input, flagged estimated
    const c = pq.priceQwen('qwen3-coder-plus', usage(20000, 1000, { cached: 15000 }));
    approx(c.usd, (5000 * 1 + 15000 * 0.1 + 1000 * 5) / 1e6);
    assert.strictEqual(c.estimated, true);
    assert.strictEqual(pq.priceQwen('qwen3-coder-plus', usage(1000, 10)).estimated, false);
    // qwen-plus: thinking output price when thoughts are present
    approx(pq.priceQwen('qwen-plus', usage(1000, 100, { thoughts: 100 })).usd, (1000 * 0.4 + 200 * 4) / 1e6);
    approx(pq.priceQwen('qwen-plus', usage(1000, 100)).usd, (1000 * 0.4 + 100 * 1.2) / 1e6);
    // Billed output without totalTokenCount: candidates + thoughts
    assert.strictEqual(pq.qwenUsageTokens({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 }).output, 7);
  });
}

// ---------- Run ----------

console.log('qwen provider');
try {
  parseTests();
  guessTests();
  scanTests();
  pricingTests();
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch { /* ignore */ }
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
