'use strict';
// Tests for lib/providers/copilot.js. Run with plain node: node test/copilot.test.js
// All data is synthetic and built at runtime in a temp directory (a fake VS Code user dir); nothing is read from the real one.
// Temp directory: AGENT_MONITOR_TEST_TMP (falls back to the system temp directory); deleted after the run.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const copilot = require('../lib/providers/copilot');
const {
  CopilotProvider, SessionReader, newReplayState, applyEntry, modelStateOf, defaultUserDirs, normalizeUserDir,
  DEFAULT_LIMITS, MODEL_STATE, SUBAGENT_KIND, WINDOW_SOURCE_MODEL,
} = copilot;

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-copilot-'));

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
const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const S = (s) => T0 + s * 1000;
const MIN = 60e3;
const SID = (n) => `5e55a000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const line = (o) => JSON.stringify(o) + '\n';
const TERMINAL = new Set([MODEL_STATE.COMPLETE, MODEL_STATE.CANCELLED, MODEL_STATE.FAILED]);

// ---------- Synthetic session builders (shape reconstructed from the VS Code chat schema, not user data) ----------

const md = (t) => ({ value: t, supportThemeIcons: false, supportHtml: false });
const thinking = () => ({ kind: 'thinking', value: 'internal reasoning', id: 'th' });
function tool(callId, o = {}) {
  return {
    kind: 'toolInvocationSerialized',
    toolId: o.toolId || 'run_in_terminal',
    toolCallId: callId,
    invocationMessage: md(o.msg || `Running \`${callId}\``),
    pastTenseMessage: md(`Ran ${callId}`),
    isConfirmed: 'conf' in o ? o.conf : { type: 1 },
    isComplete: o.complete ?? true,
    source: { type: 'internal', label: 'Built-In' },
    resultDetails: { input: 'x'.repeat(500), output: [{ type: 'embed', isText: true, value: 'y'.repeat(500) }] },
    ...(o.extra || {}),
  };
}
function subTool(callId, o = {}) {
  return tool(callId, { toolId: 'runSubagent', msg: 'Delegating', ...o,
    extra: { toolSpecificData: { kind: 'subagent', agentName: o.name || 'Explore', description: 'Survey the repo', prompt: 'secret prompt', ...(o.tsd || {}) }, ...(o.extra || {}) } });
}
const nested = (callId, parent, o = {}) => tool(callId, { ...o, extra: { subAgentInvocationId: parent, ...(o.extra || {}) } });

function req(n, o = {}) {
  const r = {
    requestId: `request_${n}`,
    timestamp: o.ts ?? S(n * 10),
    message: { text: o.text ?? `prompt number ${n}`, parts: [{ kind: 'text', text: 'dup' }] },
    modelId: o.model ?? 'copilot/claude-sonnet-4.5',
    agent: { id: 'github.copilot.editsAgent', name: 'agent', extensionVersion: o.version || '0.40.1', description: 'long text' },
    response: o.parts || [],
    variableData: { variables: [{ id: 'img', value: 'z'.repeat(2000) }] },
    contentReferences: [{ reference: 'r' }],
    followups: [],
  };
  const st = o.state === undefined ? MODEL_STATE.COMPLETE : o.state;
  if (st !== null) r.modelState = TERMINAL.has(st) ? { value: st, completedAt: o.doneAt ?? S(n * 10 + 5) } : { value: st };
  if (o.result !== undefined) r.result = o.result;
  else if (st === MODEL_STATE.COMPLETE) r.result = { timings: { totalElapsed: 5000 }, usage: { promptTokens: 1000 * n, completionTokens: 10 * n, promptTokenDetails: [] }, metadata: { toolCallRounds: [{}, {}], renderedUserMessage: ['big'] } };
  Object.assign(r, o.extra || {});
  return r;
}
function root(id, requests, o = {}) {
  return {
    version: 3, sessionId: id, creationDate: S(0), initialLocation: 'panel', responderUsername: 'GitHub Copilot',
    requests, pendingRequests: [], hasPendingEdits: false,
    inputState: {
      mode: { id: 'agent', kind: 'agent' }, permissionLevel: 'default', inputText: 'draft text', attachments: [], selections: [],
      selectedModel: { identifier: 'copilot/claude-sonnet-4.5', metadata: { id: 'claude-sonnet-4.5', family: 'claude-sonnet-4.5', maxInputTokens: 128000, maxOutputTokens: 16000, multiplierNumeric: 1, name: 'Claude Sonnet 4.5' } },
    },
    repoData: { big: 'r'.repeat(1000) },
    ...o,
  };
}
const init = (v) => ({ kind: 0, v });
const set = (k, v) => ({ kind: 1, k, v });
const push = (k, v, i) => (i === undefined ? { kind: 2, k, v } : { kind: 2, k, v, i });
const del = (k) => ({ kind: 3, k });

// ---------- Fake VS Code user dir ----------

let seq = 0;
function mkUser(name = `u${++seq}`) {
  const u = path.join(TMP, name, 'User');
  fs.mkdirSync(u, { recursive: true });
  return u;
}
function repoDir(name) {
  const d = path.join(TMP, 'repos', name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function chatDir(u, hash, folder) {
  const d = path.join(u, 'workspaceStorage', hash);
  fs.mkdirSync(path.join(d, 'chatSessions'), { recursive: true });
  if (folder) fs.writeFileSync(path.join(d, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(folder).href }));
  return path.join(d, 'chatSessions');
}
function setM(f, ms) { fs.utimesSync(f, new Date(ms), new Date(ms)); }
function writeSession(dir, id, entries, mtimeMs, ext = 'jsonl') {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.${ext}`);
  fs.writeFileSync(f, ext === 'json' ? JSON.stringify(entries, null, 2) : entries.map(line).join(''));
  if (mtimeMs != null) setM(f, mtimeMs);
  return f;
}
function appendSession(f, entries, mtimeMs) {
  fs.appendFileSync(f, entries.map(line).join(''));
  if (mtimeMs != null) setM(f, mtimeMs);
}
const provider = (u, extra = {}) => new CopilotProvider({ userDir: u, activeWindowMinutes: 30, staleMinutes: 5, ...extra });

// One session in a fresh user dir, scanned once
function single(entries, o = {}) {
  const u = mkUser();
  const dir = chatDir(u, 'ws1', o.folder === undefined ? repoDir('app') : o.folder);
  const id = o.id || SID(seq);
  const mt = o.mtime ?? S(100);
  const file = writeSession(dir, id, entries, mt);
  const p = provider(u, o.popts);
  const sessions = p.scan(o.now ?? mt + 10e3, o.scan || {});
  return { p, s: sessions.find((x) => x.id === id) || null, sessions, file, id, u, dir };
}

// ---------- Replay ----------

function replayTests() {
  const fresh = (v) => { const st = newReplayState(); applyEntry(st, init(v)); return st; };

  test('replay: set replaces values and creates missing nested paths', () => {
    const st = fresh(root('a', [req(1)]));
    applyEntry(st, set(['customTitle'], 'Named'));
    applyEntry(st, set(['requests', 0, 'modelState'], { value: 2, completedAt: S(9) }));
    applyEntry(st, set(['requests', 3, 'modelState', 'value'], 4));
    assert.strictEqual(st.root.customTitle, 'Named');
    assert.deepStrictEqual(st.root.requests[0].modelState, { value: 2, completedAt: S(9) });
    assert.strictEqual(st.root.requests[3].modelState.value, 4);
    assert.strictEqual(st.ops, 3);
  });

  test('replay: nested sets under inputState are slimmed too (model switch, attachments, draft text)', () => {
    const st = fresh(root('a', [req(1)]));
    applyEntry(st, set(['inputState', 'selectedModel'], { identifier: 'copilot/gpt-5-mini', metadata: { maxInputTokens: 64000, multiplier: '0.33x', name: 'x'.repeat(100) } }));
    applyEntry(st, set(['inputState', 'attachments'], [{ kind: 'image', value: 'b'.repeat(10000) }]));
    applyEntry(st, set(['inputState', 'inputText'], 'draft'));
    const inp = st.root.inputState;
    assert.deepStrictEqual(Object.keys(inp).sort(), ['mode', 'permissionLevel', 'selectedModel']);
    assert.strictEqual(inp.selectedModel.metadata.multiplierNumeric, 0.33);
    assert.strictEqual(inp.mode.kind, 'agent', 'kept through the re-slim');
    const a = copilot.analyze(st.root);
    assert.deepStrictEqual(a.selected, { identifier: 'copilot/gpt-5-mini', maxInputTokens: 64000, multiplier: 0.33 });
  });

  test('replay: push appends; push with i truncates to i first', () => {
    const st = fresh(root('a', [req(1, { parts: [md('a'), md('b'), md('c')] })]));
    applyEntry(st, push(['requests', 0, 'response'], [md('d')]));
    assert.strictEqual(st.root.requests[0].response.length, 4);
    applyEntry(st, push(['requests', 0, 'response'], [md('B2'), thinking()], 1));
    const resp = st.root.requests[0].response;
    assert.deepStrictEqual(resp.map((p) => p.value || p.kind), ['a', 'B2', 'thinking']);
    applyEntry(st, push(['requests', 0, 'response'], [], 0));
    assert.strictEqual(st.root.requests[0].response.length, 0);
    applyEntry(st, push(['requests'], [req(2), req(3)]));
    assert.strictEqual(st.root.requests.length, 3);
    applyEntry(st, push(['pendingRequests'], [{ kind: 'queued', request: { big: 'x' } }]));
    assert.deepStrictEqual(st.root.pendingRequests, [{ kind: 'queued' }]);
  });

  test('replay: delete removes object keys and trailing array items', () => {
    const st = fresh(root('a', [req(1), req(2)], { customTitle: 'T' }));
    applyEntry(st, del(['customTitle']));
    applyEntry(st, del(['requests', 1]));
    applyEntry(st, del(['missing', 'deep', 'path']));
    assert.ok(!('customTitle' in st.root));
    assert.strictEqual(st.root.requests.length, 1);
    assert.strictEqual(st.badOps, 0);
  });

  test('replay: an initial line mid-stream replaces the whole state', () => {
    const st = fresh(root('a', [req(1), req(2)]));
    applyEntry(st, init(root('a', [req(7, { text: 'after rewrite' })])));
    assert.strictEqual(st.root.requests.length, 1);
    assert.strictEqual(st.root.requests[0].message.text, 'after rewrite');
    assert.strictEqual(st.initials, 2);
  });

  test('replay: unknown kinds, bad paths and __proto__ keys are ignored and counted', () => {
    const st = fresh(root('a', [req(1)]));
    applyEntry(st, { kind: 9, k: ['x'], v: 1 });
    applyEntry(st, { kind: 1, k: 'notArray', v: 1 });
    applyEntry(st, { kind: 1, k: ['__proto__', 'polluted'], v: true });
    applyEntry(st, { kind: 1, k: ['requests', -1], v: 1 });
    assert.strictEqual(st.badOps, 4);
    assert.strictEqual({}.polluted, undefined);
    const orphan = newReplayState();
    applyEntry(orphan, set(['customTitle'], 'x'));
    assert.strictEqual(orphan.orphanOps, 1);
    assert.strictEqual(orphan.root, null);
  });

  test('replay: heavy fields are slimmed, parts keep their positions', () => {
    const st = fresh(root('a', [req(1, { parts: ['plain string', md('m'), tool('t1'), { kind: 'textEditGroup', uri: { scheme: 'file', path: '/r/a.js', fsPath: '/r/a.js' }, edits: [[{ text: 'x'.repeat(100) }]] }] })]));
    const r = st.root.requests[0];
    assert.ok(!('variableData' in r) && !('contentReferences' in r));
    assert.deepStrictEqual(Object.keys(r.message), ['text']);
    assert.strictEqual(r.response.length, 4);
    assert.strictEqual(r.response[0].kind, 'markdownContent');
    assert.strictEqual(r.response[1].value, 'm');
    assert.ok(!('resultDetails' in r.response[2]) && r.response[2].invocationMessage === 'Running `t1`');
    assert.strictEqual(r.response[3].uri, '/r/a.js');
    assert.ok(!('repoData' in st.root) && !('inputText' in st.root.inputState));
    assert.strictEqual(st.root.inputState.selectedModel.metadata.maxInputTokens, 128000);
    assert.strictEqual(r.result.promptTokens, 1000);
    assert.strictEqual(r.result.rounds, 2);
    // A later set into a slimmed part still lands on it
    applyEntry(st, set(['requests', 0, 'response', 2, 'isComplete'], false));
    assert.strictEqual(st.root.requests[0].response[2].isComplete, false);
  });

  test('replay: modelState mapping incl. logs without modelState', () => {
    assert.strictEqual(modelStateOf({ modelState: { value: 4 } }), 4);
    assert.strictEqual(modelStateOf({ modelState: 3 }), 3);
    assert.strictEqual(modelStateOf({ isCanceled: true }), MODEL_STATE.CANCELLED);
    assert.strictEqual(modelStateOf({ result: {} }), MODEL_STATE.COMPLETE);
    assert.strictEqual(modelStateOf({ result: { errorDetails: { message: 'x' } } }), MODEL_STATE.FAILED);
    assert.strictEqual(modelStateOf({}), MODEL_STATE.PENDING);
  });
}

// ---------- Reader ----------

function readerTests() {
  const rd = (f) => new SessionReader({ id: path.basename(f, '.jsonl'), file: f, fmt: f.endsWith('.json') ? 'json' : 'jsonl' }, DEFAULT_LIMITS);
  const dir = path.join(TMP, 'reader');
  fs.mkdirSync(dir, { recursive: true });

  test('reader: incremental tail reads only the appended bytes', () => {
    const f = writeSession(dir, 'inc', [init(root('inc', [req(1, { state: 0 })])), set(['customTitle'], 'A')]);
    const r = rd(f);
    assert.strictEqual(r.poll(Infinity), fs.statSync(f).size);
    assert.ok(r.caughtUp);
    const v = r.version;
    const add = [set(['requests', 0, 'modelState'], { value: 1, completedAt: S(20) })];
    appendSession(f, add);
    assert.strictEqual(r.poll(Infinity), Buffer.byteLength(add.map(line).join('')));
    assert.strictEqual(r.root.requests[0].modelState.value, 1);
    assert.ok(r.version > v);
    assert.strictEqual(r.poll(Infinity), 0, 'unchanged file reads nothing');
  });

  test('reader: a partial trailing line waits for the next poll', () => {
    const f = writeSession(dir, 'partial', [init(root('partial', [req(1, { state: 0 })]))]);
    const r = rd(f);
    r.poll(Infinity);
    const l = line(set(['customTitle'], 'Later'));
    fs.appendFileSync(f, l.slice(0, 10));
    r.poll(Infinity);
    assert.strictEqual(r.root.customTitle, undefined);
    fs.appendFileSync(f, l.slice(10));
    r.poll(Infinity);
    assert.strictEqual(r.root.customTitle, 'Later');
  });

  test('reader: file shrunk by a rewrite replays from the start', () => {
    const f = writeSession(dir, 'shrink', [init(root('shrink', [req(1), req(2)])), ...Array.from({ length: 20 }, (_, i) => set(['customTitle'], `t${i}`))]);
    const r = rd(f);
    r.poll(Infinity);
    assert.strictEqual(r.root.customTitle, 't19');
    writeSession(dir, 'shrink', [init(root('shrink', [req(1)], { customTitle: 'compacted' }))]);
    r.poll(Infinity);
    assert.strictEqual(r.root.customTitle, 'compacted');
    assert.strictEqual(r.root.requests.length, 1);
    assert.ok(r.tail.resets >= 1);
  });

  test('reader: in-place rewrite at least as large as the offset is detected and replayed', () => {
    const f = writeSession(dir, 'grow', [init(root('grow', [req(1)])), set(['customTitle'], 'old')]);
    const r = rd(f);
    r.poll(Infinity);
    const offset = r.tail.offset;
    const bigger = [init(root('grow', [req(1), req(2), req(3, { text: 'q'.repeat(3000) })], { customTitle: 'new' }))];
    writeSession(dir, 'grow', bigger);
    assert.ok(fs.statSync(f).size > offset);
    r.poll(Infinity);
    assert.strictEqual(r.rewrites, 1);
    assert.strictEqual(r.root.customTitle, 'new');
    assert.strictEqual(r.root.requests.length, 3);
    // Replaced by rename (new inode): also starts over
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, line(init(root('grow', [req(9)], { customTitle: 'renamed', padding: 'p'.repeat(5000) }))));
    fs.renameSync(tmp, f);
    r.poll(Infinity);
    assert.strictEqual(r.root.customTitle, 'renamed');
  });

  test('reader: a byte budget spreads a backlog over several polls', () => {
    const entries = [init(root('budget', [req(1, { state: 0 })])), set(['requests', 0, 'modelState'], { value: 1, completedAt: S(9) }), set(['customTitle'], 'done')];
    const f = writeSession(dir, 'budget', entries);
    const r = rd(f);
    const first = Buffer.byteLength(line(entries[0]));
    assert.strictEqual(r.poll(first + 3), first + 3);
    assert.ok(!r.caughtUp);
    assert.strictEqual(r.root.requests[0].modelState.value, 0);
    r.poll(Infinity);
    assert.ok(r.caughtUp);
    assert.strictEqual(r.root.customTitle, 'done');
    assert.strictEqual(r.root.requests[0].modelState.value, 1);
  });

  test('reader: legacy whole-file .json snapshot', () => {
    const f = writeSession(dir, 'legacy', root('legacy', [req(1, { state: null, result: {} })]), null, 'json');
    const r = rd(f);
    assert.strictEqual(r.poll(10, false), 0, 'over budget and not forced: deferred');
    assert.ok(!r.caughtUp);
    assert.strictEqual(r.poll(10, false), 0);
    assert.ok(r.poll(10, false) > 0, 'read anyway after two deferrals');
    assert.ok(r.caughtUp && r.root.requests.length === 1);
    // Caught mid-write: the previous snapshot stays until the file changes again
    fs.writeFileSync(f, '{broken');
    const v = r.version;
    r.poll(Infinity);
    assert.strictEqual(r.parseErrors, 1);
    assert.ok(r.caughtUp && r.root.requests.length === 1 && r.version === v, 'previous snapshot kept');
    writeSession(dir, 'legacy', root('legacy', [req(1), req(2)]), Date.now() + 5000, 'json');
    r.poll(Infinity);
    assert.strictEqual(r.root.requests.length, 2);
    // A file that never parsed has no snapshot
    const bad = path.join(dir, 'never.json');
    fs.writeFileSync(bad, '{broken');
    const rb = rd(bad);
    rb.poll(Infinity);
    assert.deepStrictEqual([rb.parseErrors, rb.root, rb.caughtUp], [1, null, true]);
  });
}

// ---------- Status mapping ----------

function statusTests() {
  const one = (requests, o = {}) => single([init(root(o.id || SID(900 + seq), requests, o.rootExtra || {})), ...(o.ops || [])], o);

  test('status: modelState 1 → done, doneAtMs = completedAt', () => {
    const { s } = one([req(1), req(2, { doneAt: S(33) })]);
    assert.strictEqual(s.main.status.code, 'done');
    assert.strictEqual(s.main.status.sinceMs, S(33));
    assert.strictEqual(s.doneAtMs, S(33));
    assert.strictEqual(s.live, false);
    assert.strictEqual(s.liveStatus, null);
  });

  test('status: modelState 2 → interrupted', () => {
    const { s } = one([req(1, { state: MODEL_STATE.CANCELLED, parts: [tool('c1')] })]);
    assert.strictEqual(s.main.status.code, 'interrupted');
    assert.strictEqual(s.copilot.modelState, 2);
  });

  test('status: modelState 3 → apiError with first error line; quota when quota exceeded or rate limited', () => {
    let r = one([req(1, { state: MODEL_STATE.FAILED, result: { errorDetails: { message: 'Request failed\nstack line', code: 'server_error' } } })]).s;
    assert.strictEqual(r.main.status.code, 'apiError');
    assert.deepStrictEqual(r.main.status.error, { kind: 'server_error', http: null, message: 'Request failed' });
    r = one([req(1, { state: MODEL_STATE.FAILED, result: { errorDetails: { message: 'filtered', responseIsFiltered: true } } })]).s;
    assert.strictEqual(r.main.status.error.kind, 'filtered');
    r = one([req(1, { state: MODEL_STATE.FAILED, result: { errorDetails: { message: 'You have exceeded your premium request allowance', isQuotaExceeded: true } } })]).s;
    assert.strictEqual(r.main.status.code, 'quota');
    assert.strictEqual(r.main.status.quota.source, 'turnError');
    assert.strictEqual(r.main.status.quota.model, 'copilot/claude-sonnet-4.5');
    r = one([req(1, { state: MODEL_STATE.FAILED, result: { errorDetails: { message: 'slow down', isRateLimited: true } } })]).s;
    assert.strictEqual(r.main.status.code, 'quota');
    r = one([req(1, { state: MODEL_STATE.FAILED })]).s;
    assert.strictEqual(r.main.status.code, 'apiError');
    assert.strictEqual(r.main.status.error.kind, 'unknown');
  });

  test('status: modelState 0 → starting / thinking / tool, live and busy', () => {
    let r = one([req(1), req(2, { state: 0 })]).s;
    assert.strictEqual(r.main.status.code, 'starting');
    assert.strictEqual(r.main.step.kind, 'prompt');
    r = one([req(2, { state: 0, parts: [thinking()] })]).s;
    assert.strictEqual(r.main.status.code, 'thinking');
    assert.strictEqual(r.main.step.kind, 'thinking');
    r = one([req(2, { state: 0, parts: [thinking(), md('text')] })]).s;
    assert.strictEqual(r.main.status.code, 'thinking');
    assert.strictEqual(r.main.step.kind, 'text');
    r = one([req(2, { state: 0, parts: [thinking(), tool('t9', { toolId: 'run_in_terminal', complete: false, msg: 'Running `npm test`' })] })]).s;
    assert.strictEqual(r.main.status.code, 'tool');
    assert.strictEqual(r.main.status.pendingTool, 'run_in_terminal');
    assert.deepStrictEqual([r.main.step.kind, r.main.step.tool, r.main.step.detail], ['tool', 'run_in_terminal', 'Running `npm test`']);
    assert.strictEqual(r.live, true);
    assert.strictEqual(r.liveStatus, 'busy');
    // A confirmed, completed tool as the last part: the model's turn again
    r = one([req(2, { state: 0, parts: [tool('t8')] })]).s;
    assert.strictEqual(r.main.status.code, 'thinking');
    assert.strictEqual(r.main.step.kind, 'toolResult');
  });

  test('status: modelState 0 with no write for longer than staleMinutes → stale, not live', () => {
    const { s } = one([req(2, { state: 0, parts: [tool('t1', { complete: false })] })], { mtime: S(100), now: S(100) + 6 * MIN });
    assert.strictEqual(s.main.status.code, 'stale');
    assert.strictEqual(s.main.status.stalePending, true);
    assert.strictEqual(s.main.status.pendingTool, 'run_in_terminal');
    assert.strictEqual(s.live, false);
  });

  test('status: modelState 4 → certain awaitingApproval on the last unconfirmed tool', () => {
    const { s } = one([req(1), req(2, { state: MODEL_STATE.NEEDS_INPUT, parts: [tool('a', { conf: { type: 1 } }), md('about to run'), tool('b', { toolId: 'create_file', conf: undefined, msg: 'Create file' })] })]);
    const st = s.main.status;
    assert.strictEqual(st.code, 'awaitingApproval');
    assert.strictEqual(st.certainty, 'certain');
    assert.strictEqual(st.pendingTool, 'create_file');
    assert.deepStrictEqual([s.main.step.kind, s.main.step.tool], ['tool', 'create_file']);
    assert.strictEqual(s.live, true);
    assert.strictEqual(s.liveStatus, 'waiting');
    assert.strictEqual(s.counts.awaiting, 1);
  });

  test('status: modelState 4 with a question / plan review / no clue', () => {
    let s = one([req(1, { state: 4, parts: [tool('a'), { kind: 'questionCarousel', questions: [{ q: 'x' }] }] })]).s;
    assert.deepStrictEqual([s.main.status.code, s.main.status.question, s.main.status.certainty], ['awaitingInput', 'askUser', 'certain']);
    s = one([req(1, { state: 4, parts: [{ kind: 'planReview', plan: 'steps' }] })]).s;
    assert.deepStrictEqual([s.main.status.code, s.main.status.question], ['awaitingInput', 'planApproval']);
    s = one([req(1, { state: 4, parts: [{ kind: 'elicitationSerialized', state: 'accepted' }, tool('z', { conf: null, toolId: 'fetch_webpage' })] })]).s;
    assert.deepStrictEqual([s.main.status.code, s.main.status.pendingTool], ['awaitingApproval', 'fetch_webpage']);
    s = one([req(1, { state: 4, parts: [{ kind: 'elicitationSerialized', state: 'pending' }] })]).s;
    assert.deepStrictEqual([s.main.status.code, s.main.status.question], ['awaitingInput', 'askUser']);
    s = one([req(1, { state: 4, parts: [md('text only')] })]).s;
    assert.deepStrictEqual([s.main.status.code, s.main.status.pendingTool, s.main.status.certainty], ['awaitingApproval', null, 'certain']);
  });

  test('status: modelState 4 stays needs-you after staleMinutes (nothing is written while waiting)', () => {
    const { s } = one([req(1, { state: 4, parts: [tool('b', { conf: undefined })] })], { mtime: S(100), now: S(100) + 20 * MIN });
    assert.strictEqual(s.main.status.code, 'awaitingApproval');
    assert.strictEqual(s.main.status.sinceMs, S(100));
    assert.strictEqual(s.live, true);
  });

  test('status: only the last request decides; older pending requests are ignored', () => {
    const { s } = one([req(1, { state: 0 }), req(2, { state: 4 }), req(3)]);
    assert.strictEqual(s.main.status.code, 'done');
  });
}

// ---------- Session fields ----------

function sessionTests() {
  test('scan: workspace, no-workspace, empty-window and profile sessions; empty chats skipped', () => {
    const u = mkUser();
    const now = S(200);
    writeSession(chatDir(u, 'aaa', repoDir('one')), SID(1), [init(root(SID(1), [req(1)]))], S(150));
    writeSession(chatDir(u, 'no-workspace'), SID(2), [init(root(SID(2), [req(1)]))], S(150));
    writeSession(path.join(u, 'globalStorage', 'emptyWindowChatSessions'), SID(3), [init(root(SID(3), [req(1)]))], S(150));
    writeSession(path.join(u, 'profiles', 'p1', 'globalStorage', 'emptyWindowChatSessions'), SID(4), [init(root(SID(4), [req(1)]))], S(150));
    writeSession(chatDir(u, 'bbb'), SID(5), [init(root(SID(5), []))], S(150)); // never asked anything
    fs.writeFileSync(path.join(chatDir(u, 'bbb'), 'notes.txt'), 'ignored');
    const p = provider(u);
    const ss = p.scan(now);
    assert.deepStrictEqual(ss.map((s) => s.id).sort(), [SID(1), SID(2), SID(3), SID(4)]);
    const byId = Object.fromEntries(ss.map((s) => [s.id, s]));
    assert.strictEqual(byId[SID(1)].copilot.storage, 'workspace');
    assert.strictEqual(byId[SID(3)].copilot.storage, 'emptyWindow');
    assert.strictEqual(byId[SID(3)].cwd, null);
    assert.strictEqual(p.stats.files, 5);
    // Same user dir given as a profile folder
    const p2 = provider(path.join(u, 'profiles', 'p1'));
    assert.strictEqual(p2.scan(now).length, 4);
  });

  test('scan: title, cwd, model, version, entry, key', () => {
    const folder = repoDir('titled');
    let r = single([init(root('t-1', [req(1, { text: '  Fix the\nflaky   test in parser module please now', version: '0.41.0' })]))], { id: 't-1', folder });
    assert.strictEqual(r.s.key, 'copilot:t-1');
    assert.strictEqual(r.s.provider, 'copilot');
    assert.strictEqual(r.s.titleSource, 'prompt');
    assert.strictEqual(r.s.title, 'Fix the flaky test in parser module ple…');
    assert.strictEqual(r.s.cwd, folder);
    assert.strictEqual(r.s.model, 'copilot/claude-sonnet-4.5');
    assert.strictEqual(r.s.version, '0.41.0');
    assert.deepStrictEqual([r.s.entry, r.s.entryRaw], ['vscode', 'panel']);
    assert.strictEqual(r.s.createdMs, S(0));
    assert.strictEqual(r.s.startedMs, S(0));
    assert.strictEqual(r.s.transcript, r.file);
    assert.deepStrictEqual(r.s.resume, []);
    r = single([init(root('t-2', [req(1)], { customTitle: 'My chat', workingDirectory: pathToFileURL(path.join(folder, 'sub')).href }))], { id: 't-2', folder });
    assert.deepStrictEqual([r.s.title, r.s.titleSource], ['My chat', 'custom']);
    assert.strictEqual(r.s.cwd, path.join(folder, 'sub'));
    r = single([init(root('t-3', [req(1, { text: '' })]))], { id: 't-3' });
    assert.deepStrictEqual([r.s.title, r.s.titleSource], ['t-3', 'id']);
  });

  test('scan: tokens from result.usage / metadata, context window from the selected model', () => {
    const { s } = single([init(root('tok', [req(1), req(2), req(3, { result: { metadata: { promptTokens: 64000, outputTokens: 7, toolCallRounds: [{}, {}, {}] } } })]))], { id: 'tok' });
    const t = s.main.tokens;
    assert.strictEqual(t.contextUsed, 64000);
    assert.strictEqual(t.display, 64000);
    assert.strictEqual(t.output, 10 + 20 + 7);
    assert.strictEqual(t.processed, 1000 + 2000 + 64000);
    assert.strictEqual(t.apiCalls, 2 + 2 + 3);
    assert.strictEqual(t.contextWindow, 128000);
    assert.strictEqual(t.contextPct, 50);
    assert.strictEqual(s.contextWindowSource, WINDOW_SOURCE_MODEL);
    assert.strictEqual(s.contextUsed, 64000);
    assert.strictEqual(s.costUsd, null);
    assert.strictEqual(s.copilot.multiplier, 1);
    assert.strictEqual(s.copilot.credits, null);
  });

  test('scan: request-level tokens and credits (newer VS Code) take precedence', () => {
    const r2 = req(2, { extra: { promptTokens: 48213, completionTokens: 812, copilotCredits: 1.5 } });
    const r3 = req(3, { extra: { promptTokens: 50000, completionTokens: 100, copilotCredits: 0.5, modelTotals: [{ model: 'm', inputTokens: 90000, cachedTokens: 40000, outputTokens: 300 }] } });
    let s = single([init(root('cred', [req(1), r2, r3]))], { id: 'cred' }).s;
    assert.strictEqual(s.main.tokens.contextUsed, 50000);
    assert.strictEqual(s.main.tokens.output, 10 + 812 + 300);
    assert.strictEqual(s.main.tokens.processed, 1000 + 48213 + 90000);
    assert.strictEqual(s.copilot.cachedTokens, 40000);
    assert.strictEqual(s.copilot.credits, 2);
    assert.strictEqual(s.main.copilotCredits, 2);
    s = single([init(root('cred2', [req(1, { extra: { copilotCredits: 1, sessionCopilotCredits: 7 } })]))], { id: 'cred2' }).s;
    assert.strictEqual(s.copilot.credits, 7);
  });

  test('scan: model differing from the selected one uses a window learned from another session, else null', () => {
    const u = mkUser();
    const dir = chatDir(u, 'w');
    const other = root(SID(11), [req(1)]);
    other.inputState.selectedModel = { identifier: 'copilot/gpt-5', metadata: { maxInputTokens: 200000 } };
    writeSession(dir, SID(11), [init(other)], S(140)); // older than the session that needs its window
    writeSession(dir, SID(12), [init(root(SID(12), [req(1, { model: 'copilot/gpt-5' })]))], S(150));
    writeSession(dir, SID(13), [init(root(SID(13), [req(1, { model: 'copilot/unknown' })]))], S(150));
    const ss = provider(u).scan(S(200));
    const by = Object.fromEntries(ss.map((s) => [s.id, s]));
    assert.strictEqual(by[SID(12)].contextWindow, 200000);
    assert.strictEqual(by[SID(13)].contextWindow, null);
    assert.strictEqual(by[SID(13)].contextPct, null);
    // No prompt token count recorded: context use unknown (null), not 0 %
    const noTok = root(SID(14), [req(1, { result: { timings: { totalElapsed: 10 } } })]);
    writeSession(dir, SID(14), [init(noTok)], S(150));
    const t14 = provider(u).scan(S(200)).find((s) => s.id === SID(14));
    assert.deepStrictEqual([t14.contextUsed, t14.contextWindow, t14.contextPct, t14.main.tokens.contextPct], [0, 128000, null, null]);
    assert.strictEqual(t14.main.tokens.unknown, true, 'no counts recorded: shown as "—", not 0');
    assert.ok(!('unknown' in by[SID(12)].main.tokens), 'counts recorded: known');
    assert.strictEqual(by[SID(13)].contextWindowSource, null);
    const st = newReplayState();
    const withString = root('m', [req(1)]);
    withString.inputState.selectedModel.metadata = { maxInputTokens: 1, multiplier: '0.33x' };
    applyEntry(st, init(withString));
    assert.strictEqual(st.root.inputState.selectedModel.metadata.multiplierNumeric, 0.33);
  });

  test('scan: tool calls, tool errors and changed files', () => {
    const parts = [
      tool('a'), tool('b', { extra: { resultError: 'ENOENT: no such file\nat x' } }), tool('c', { extra: { resultDetails: { isError: true } } }),
      { kind: 'textEditGroup', uri: { scheme: 'file', fsPath: '/r/a.js', path: '/r/a.js' }, edits: [] },
      { kind: 'textEditGroup', uri: { scheme: 'file', fsPath: '/r/a.js', path: '/r/a.js' }, edits: [] },
      { kind: 'notebookEditGroup', uri: { scheme: 'file', path: '/r/n.ipynb' }, edits: [] },
      { kind: 'codeblockUri', uri: { scheme: 'file', path: '/r/a.js' }, isEdit: true },
    ];
    const r = single([init(root('files', [req(1, { parts })]))], { id: 'files' });
    assert.strictEqual(r.s.main.toolCalls, 3);
    assert.strictEqual(r.s.main.toolErrors, 2);
    assert.strictEqual(r.s.main.filesChanged, 2);
    const d = r.p.detail('copilot:files').agents.files;
    assert.deepStrictEqual(d.files.map((f) => [f.path, f.count]).sort(), [['/r/a.js', 2], ['/r/n.ipynb', 1]]);
    assert.strictEqual(d.errors[0].text, 'ENOENT: no such file');
    assert.strictEqual(d.errors[0].tool, 'run_in_terminal');
  });
}

// ---------- Sub-agents ----------

function subagentTests() {
  test('subagents: a running sub-agent becomes a copilotSubagent child; main shows the sub-agent tool', () => {
    const parts = [thinking(), subTool('sa1', { name: 'Explore', tsd: { agentDisplayName: 'Explorer', modelName: 'claude-haiku-4.5' } }),
      nested('n1', 'sa1', { toolId: 'read_file' }), nested('n2', 'sa1', { toolId: 'grep_search', complete: false })];
    const { s } = single([init(root('sub', [req(1), req(2, { state: 0, parts })]))], { id: 'sub' });
    assert.strictEqual(s.agents.length, 1);
    const c = s.agents[0];
    assert.strictEqual(c.kind, SUBAGENT_KIND);
    assert.deepStrictEqual([c.id, c.name, c.agentType, c.model], ['sa1', 'Explorer', 'Explore', 'claude-haiku-4.5']);
    assert.strictEqual(c.tokens.unknown, true, 'Copilot keeps no token counts for sub-agents');
    assert.ok(!s.main.tokens.unknown);
    assert.strictEqual(c.status.code, 'tool');
    assert.strictEqual(c.status.pendingTool, 'grep_search');
    assert.strictEqual(c.toolCalls, 2);
    assert.strictEqual(s.main.status.code, 'tool');
    assert.strictEqual(s.main.status.pendingTool, 'runSubagent');
    assert.strictEqual(s.main.step.tool, 'runSubagent');
    assert.strictEqual(s.main.toolCalls, 1, 'nested calls belong to the child');
    assert.strictEqual(s.counts.running, 2);
    assert.strictEqual(s.counts.total, 2);
  });

  test('subagents: a sub-agent the main agent moved past is done, with its result in detail', () => {
    const parts = [subTool('sa2', { tsd: { result: 'Found 3 call sites' } }), nested('m1', 'sa2', { extra: { resultError: 'boom' } }), md('Summary')];
    const r = single([init(root('sub2', [req(1, { parts })]))], { id: 'sub2' });
    const c = r.s.agents[0];
    assert.strictEqual(c.status.code, 'done');
    assert.strictEqual(c.toolErrors, 1);
    const d = r.p.detail('sub2');
    assert.strictEqual(d.agents.sa2.result.text, 'Found 3 call sites');
    assert.strictEqual(d.agents.sa2.errors[0].text, 'boom');
    assert.strictEqual(d.agents.sub2.result.text, 'Summary');
    assert.ok(!JSON.stringify(d).includes('secret prompt'), 'sub-agent prompt is not kept');
  });

  test('subagents: parallel sub-agent calls in a running request are all open', () => {
    const parts = [subTool('p1'), subTool('p2'), nested('x1', 'p1', { toolId: 'read_file' })];
    const { s } = single([init(root('par', [req(1, { state: 0, parts })]))], { id: 'par' });
    assert.deepStrictEqual(s.agents.map((a) => [a.id, a.status.code]), [['p1', 'thinking'], ['p2', 'thinking']]);
  });

  test('subagents: approval pending inside a sub-agent → child and main both awaitingApproval', () => {
    const parts = [subTool('sa3'), nested('k1', 'sa3', { toolId: 'run_in_terminal', conf: undefined, msg: 'Run rm -rf build' })];
    const { s } = single([init(root('sub3', [req(1, { state: 4, parts })]))], { id: 'sub3' });
    assert.strictEqual(s.main.status.code, 'awaitingApproval');
    assert.strictEqual(s.main.status.pendingTool, 'run_in_terminal');
    assert.strictEqual(s.agents[0].status.code, 'awaitingApproval');
    assert.strictEqual(s.agents[0].status.certainty, 'certain');
    assert.strictEqual(s.agents[0].step.detail, 'Run rm -rf build');
    assert.strictEqual(s.counts.awaiting, 2);
  });

  test('subagents: cancelled / failed request → unfinished child interrupted / apiError; isActive wins', () => {
    let s = single([init(root('sub4', [req(1, { state: 2, parts: [subTool('c1')] })]))], { id: 'sub4' }).s;
    assert.strictEqual(s.agents[0].status.code, 'interrupted');
    s = single([init(root('sub5', [req(1, { state: 3, parts: [subTool('c2')], result: { errorDetails: { message: 'bad gateway' } } })]))], { id: 'sub5' }).s;
    assert.strictEqual(s.agents[0].status.code, 'apiError');
    s = single([init(root('sub6', [req(1, { state: 0, parts: [subTool('c3', { tsd: { isActive: false } }), subTool('c4', { tsd: { isActive: true } }), md('later')] })]))], { id: 'sub6' }).s;
    assert.deepStrictEqual(s.agents.map((a) => a.status.code), ['done', 'thinking']);
  });

  test('subagents: old runs outside the window are dropped, running ones kept', () => {
    const old = req(1, { ts: S(0), doneAt: S(5), parts: [subTool('old1', { tsd: { result: 'r' } })] });
    const cur = req(2, { ts: S(100) * 1 + 0, state: 0, parts: [subTool('new1')] });
    const { s } = single([init(root('sub7', [old, cur]))], { id: 'sub7', mtime: S(100) + 40 * MIN - 5 * 1000, now: S(100) + 40 * MIN });
    assert.deepStrictEqual(s.agents.map((a) => a.id), ['new1']);
  });
}

// ---------- Bounds ----------

function boundsTests() {
  test('bounds: files outside the activity window are not read; keepKeys reads them', () => {
    const u = mkUser();
    const dir = chatDir(u, 'w');
    writeSession(dir, SID(21), [init(root(SID(21), [req(1)]))], S(0));
    writeSession(dir, SID(22), [init(root(SID(22), [req(1)]))], S(0) + 2 * 3600e3);
    const p = provider(u);
    const now = S(0) + 2 * 3600e3 + 1000;
    assert.deepStrictEqual(p.scan(now).map((s) => s.id), [SID(22)]);
    assert.strictEqual(p.readers.size, 1);
    const kept = p.scan(now + 6000, { keepKeys: [`copilot:${SID(21)}`, `codex:${SID(22)}`] });
    assert.deepStrictEqual(kept.map((s) => s.id).sort(), [SID(21), SID(22)]);
    p.scan(now + 12000);
    assert.strictEqual(p.readers.size, 1, 'released once no longer kept');
  });

  test('bounds: maxSessions caps the files read (newest first); oversized files are skipped', () => {
    const u = mkUser();
    const dir = chatDir(u, 'w');
    for (let i = 0; i < 5; i++) writeSession(dir, SID(30 + i), [init(root(SID(30 + i), [req(1)]))], S(100 + i));
    const p = provider(u, { limits: { maxSessions: 2 } });
    assert.deepStrictEqual(p.scan(S(200)).map((s) => s.id), [SID(34), SID(33)]);
    assert.strictEqual(p.readers.size, 2);
    const big = writeSession(dir, SID(40), [init(root(SID(40), [req(1, { text: 'b'.repeat(4000) })]))], S(150));
    const p2 = provider(u, { limits: { maxFileBytes: fs.statSync(big).size - 1 } });
    const ids = p2.scan(S(200)).map((s) => s.id);
    assert.ok(!ids.includes(SID(40)));
    assert.strictEqual(p2.stats.oversized, 1);
  });

  test('bounds: empty chats do not count toward maxSessions; a known-empty file is not reopened until it changes', () => {
    const u = mkUser();
    const dir = chatDir(u, 'w');
    // Two real sessions, then five newer empty chats (VS Code writes one per chat view it opens)
    writeSession(dir, SID(60), [init(root(SID(60), [req(1)]))], S(100));
    writeSession(dir, SID(61), [init(root(SID(61), [req(1)]))], S(101));
    const empties = [];
    for (let i = 0; i < 5; i++) empties.push(writeSession(dir, SID(70 + i), [init(root(SID(70 + i), []))], S(110 + i)));
    const p = provider(u, { limits: { maxSessions: 2 } });
    assert.deepStrictEqual(p.scan(S(200)).map((s) => s.id), [SID(61), SID(60)], 'the newer empty chats do not crowd them out');
    assert.strictEqual(p.readers.size, 2, 'empty chats are not kept open');
    assert.strictEqual(p.stats.empty, 5);
    // Unchanged empty files are skipped without being read
    const read = p.stats.bytesRead;
    p.scan(S(203));
    assert.strictEqual(p.stats.bytesRead, read);
    // The first request lands in an empty chat: it is read again and counts now (the oldest real session drops out)
    appendSession(empties[4], [push(['requests'], [req(2, { text: 'first question' })])], S(210));
    const ids = p.scan(S(216)).map((s) => s.id);
    assert.deepStrictEqual(ids, [SID(74), SID(61)]);
    assert.strictEqual(p.stats.empty, 4);
    // A known-empty file that is deleted is forgotten at the next discovery
    fs.rmSync(empties[0]);
    p.scan(S(222));
    assert.strictEqual(p.stats.empty, 3);
  });

  test('bounds: with the default limits, 6 real sessions behind 41 newer empty chats all show in the first scan', () => {
    const u = mkUser();
    const dir = chatDir(u, 'w');
    for (let i = 0; i < 6; i++) writeSession(dir, SID(100 + i), [init(root(SID(100 + i), [req(1)]))], S(100 + i));
    for (let i = 0; i < 41; i++) writeSession(chatDir(u, `e${i % 7}`), SID(200 + i), [init(root(SID(200 + i), []))], S(120 + i));
    const p = provider(u);
    assert.strictEqual(p.scan(S(200)).length, 6);
    assert.deepStrictEqual([p.readers.size, p.stats.empty], [6, 41]);
  });

  test('bounds: emptyPerScan limits how many unread empty chats one scan opens', () => {
    const u = mkUser();
    const dir = chatDir(u, 'w');
    writeSession(dir, SID(80), [init(root(SID(80), [req(1)]))], S(100));
    for (let i = 0; i < 6; i++) writeSession(dir, SID(81 + i), [init(root(SID(81 + i), []))], S(110 + i));
    const p = provider(u, { limits: { emptyPerScan: 4 } });
    assert.deepStrictEqual(p.scan(S(200)), [], 'first scan: four empty chats opened, the rest wait');
    assert.strictEqual(p.stats.empty, 4);
    assert.deepStrictEqual(p.scan(S(202)).map((s) => s.id), [SID(80)]);
    assert.strictEqual(p.stats.empty, 6);
  });

  test('bounds: the per-scan byte budget defers a backlog to later scans', () => {
    const u = mkUser();
    const dir = chatDir(u, 'w');
    const f = writeSession(dir, SID(41), [init(root(SID(41), [req(1, { text: 'x'.repeat(300) })]))], S(150));
    const size = fs.statSync(f).size;
    const p = provider(u, { limits: { scanBytes: 1000 } });
    assert.deepStrictEqual(p.scan(S(200)), [], 'not shown while catching up');
    assert.strictEqual(p.stats.deferred, 1);
    let got = [];
    let scans = 1;
    while (!got.length && scans < 100) got = p.scan(S(200) + scans++ * 1000);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(scans, Math.ceil(size / 1000));
    assert.strictEqual(p.stats.bytesRead, size);
  });

  test('bounds: with many files, directories without recent files are re-listed only every 30 s', () => {
    const u = mkUser();
    const cold = chatDir(u, 'cold');
    for (let i = 0; i < 505; i++) {
      const f = path.join(cold, `old-${i}.jsonl`);
      fs.writeFileSync(f, '');
      setM(f, S(0));
    }
    const hot = chatDir(u, 'hot');
    const now = S(0) + 3 * 3600e3;
    writeSession(hot, SID(50), [init(root(SID(50), [req(1)]))], now - 1000);
    const p = provider(u);
    assert.strictEqual(p.scan(now).length, 1);
    writeSession(cold, SID(51), [init(root(SID(51), [req(1)]))], now + 1000);
    writeSession(hot, SID(52), [init(root(SID(52), [req(1)]))], now + 1000);
    const mid = p.scan(now + 6000).map((s) => s.id);
    assert.ok(mid.includes(SID(52)) && !mid.includes(SID(51)), 'hot dir re-listed, cold dir not yet');
    assert.ok(p.scan(now + 31000).map((s) => s.id).includes(SID(51)));
  });

  test('bounds: never writes into the user dir', () => {
    const r = single([init(root('ro', [req(1)]))], { id: 'ro' });
    const before = fs.readFileSync(r.file, 'utf8');
    const list = (d) => fs.readdirSync(d, { recursive: true }).sort();
    const entries = list(r.u);
    r.p.scan(S(120));
    r.p.details(['copilot:ro']);
    assert.strictEqual(fs.readFileSync(r.file, 'utf8'), before);
    assert.deepStrictEqual(list(r.u), entries);
  });
}

// ---------- Incremental ----------

function incrementalTests() {
  test('incremental: appended entries move the status 0 → 4 → 1 across scans', () => {
    const u = mkUser();
    const dir = chatDir(u, 'w');
    const id = SID(60);
    const f = writeSession(dir, id, [init(root(id, [req(1)])), push(['requests'], [req(2, { state: 0 })])], S(100));
    const p = provider(u);
    let s = p.scan(S(105))[0];
    assert.strictEqual(s.main.status.code, 'starting');
    appendSession(f, [push(['requests', 1, 'response'], [thinking(), tool('w1', { toolId: 'replace_string_in_file', conf: undefined })]), set(['requests', 1, 'modelState'], { value: 4 })], S(160));
    s = p.scan(S(170))[0];
    assert.strictEqual(s.main.status.code, 'awaitingApproval');
    assert.strictEqual(s.main.status.pendingTool, 'replace_string_in_file');
    assert.strictEqual(s.main.status.sinceMs, S(160));
    const bytesBefore = p.stats.bytesRead;
    const add = [set(['requests', 1, 'response', 1, 'isConfirmed'], { type: 4 }), push(['requests', 1, 'response'], [md('Done.')]),
      set(['requests', 1, 'result'], { usage: { promptTokens: 9000, completionTokens: 50 } }), set(['requests', 1, 'modelState'], { value: 1, completedAt: S(230) })];
    appendSession(f, add, S(231));
    s = p.scan(S(240))[0];
    assert.strictEqual(p.stats.bytesRead - bytesBefore, Buffer.byteLength(add.map(line).join('')), 'only appended bytes read');
    assert.strictEqual(s.main.status.code, 'done');
    assert.strictEqual(s.main.status.sinceMs, S(230));
    assert.strictEqual(s.main.tokens.contextUsed, 9000);
    assert.strictEqual(p.detail(id).agents[id].result.text, 'Done.');
    // Truncating push: the response is replaced from index 1
    appendSession(f, [push(['requests', 1, 'response'], [md('Rewritten answer')], 1)], S(250));
    s = p.scan(S(255))[0];
    assert.strictEqual(p.detail(id).agents[id].result.text, 'Rewritten answer');
    assert.strictEqual(s.main.toolCalls, 0);
  });

  test('incremental: a log compacted into one snapshot line between scans is replayed from the start', () => {
    const u = mkUser();
    const dir = chatDir(u, 'w');
    const id = SID(61);
    const ops = Array.from({ length: 40 }, (_, i) => set(['requests', 0, 'modelState'], { value: 0, n: i }));
    const f = writeSession(dir, id, [init(root(id, [req(1, { state: 0 })])), ...ops], S(100));
    const p = provider(u);
    assert.strictEqual(p.scan(S(105))[0].main.status.code, 'starting');
    writeSession(dir, id, [init(root(id, [req(1), req(2, { state: 3, result: { errorDetails: { message: 'net' } } })], { customTitle: 'Compacted' }))], S(160));
    const s = p.scan(S(170))[0];
    assert.strictEqual(s.title, 'Compacted');
    assert.strictEqual(s.main.status.code, 'apiError');
    assert.strictEqual(s.copilot.requests, 2);
    assert.ok(fs.statSync(f).size > 0);
  });
}

// ---------- API ----------

function apiTests() {
  test('api: uriToPath turns serialized URIs into paths (Windows drive letters and UNC shares included)', () => {
    const { uriToPath } = copilot;
    assert.strictEqual(uriToPath({ $mid: 1, scheme: 'file', path: '/C:/Users/Me/proj' }), 'c:\\Users\\Me\\proj');
    assert.strictEqual(uriToPath({ scheme: 'file', authority: 'server', path: '/share/proj' }), '\\\\server\\share\\proj');
    assert.strictEqual(uriToPath({ scheme: 'file', path: '/home/me/proj' }), '/home/me/proj');
    assert.strictEqual(uriToPath({ scheme: 'file', fsPath: 'd:\\x', path: '/d:/x' }), 'd:\\x', 'fsPath wins');
    assert.strictEqual(uriToPath({ scheme: 'vscode-remote', authority: 'wsl+Ubuntu', path: '/home/me' }), 'vscode-remote://wsl+Ubuntu/home/me');
    assert.strictEqual(uriToPath(pathToFileURL(path.join(TMP, 'a b')).href), path.join(TMP, 'a b'));
    assert.strictEqual(uriToPath(null), null);
  });

  test('api: detail / details / has / quota / dispose', () => {
    const u = mkUser();
    const dir = chatDir(u, 'w');
    writeSession(dir, SID(70), [init(root(SID(70), [req(1, { parts: [tool('q1'), md('ok')] })]))], S(150));
    writeSession(dir, SID(71), [init(root(SID(71), [req(1, { state: 3, doneAt: S(140), result: { errorDetails: { message: 'quota', isQuotaExceeded: true } } })]))], S(150));
    const p = provider(u);
    assert.deepStrictEqual(p.quota(), { lastHit: null });
    const ss = p.scan(S(200));
    assert.strictEqual(ss.length, 2);
    assert.ok(p.has(SID(70)) && p.has(`copilot:${SID(70)}`));
    assert.ok(!p.has(`codex:${SID(70)}`) && !p.has('copilot:nope'));
    const d = p.detail(`copilot:${SID(70)}`);
    assert.strictEqual(d.key, `copilot:${SID(70)}`);
    const tl = d.agents[SID(70)].timeline;
    assert.deepStrictEqual(tl.map((e) => e.kind), ['prompt', 'tool', 'text', 'done']);
    assert.strictEqual(tl[0].detail, 'prompt number 1');
    assert.strictEqual(tl[1].tool, 'run_in_terminal');
    assert.deepStrictEqual(Object.keys(p.details([`copilot:${SID(70)}`, `copilot:${SID(71)}`, 'claude:x'])).sort(), [`copilot:${SID(70)}`, `copilot:${SID(71)}`]);
    const q = p.quota();
    assert.strictEqual(q.lastHit.sessionKey, `copilot:${SID(71)}`);
    assert.strictEqual(q.lastHit.ms, S(140));
    p.dispose();
    assert.strictEqual(p.readers.size, 0);
    assert.strictEqual(p.detail(SID(70)), null);
  });

  test('api: stable startedMs and sort order across scans', () => {
    const u = mkUser();
    const dir = chatDir(u, 'w');
    writeSession(dir, SID(80), [init(root(SID(80), [req(1)], { creationDate: S(10) }))], S(150));
    writeSession(dir, SID(81), [init(root(SID(81), [req(1)], { creationDate: S(20) }))], S(160));
    const p = provider(u);
    const a = p.scan(S(200));
    assert.deepStrictEqual(a.map((s) => s.id), [SID(81), SID(80)]);
    assert.deepStrictEqual(a.map((s) => s.startedMs), [S(20), S(10)]);
    const b = p.scan(S(210));
    assert.deepStrictEqual(b.map((s) => s.startedMs), a.map((s) => s.startedMs));
  });

  test('paths: default user dirs per platform; profile folders map back to User', () => {
    const h = path.join(TMP, 'home');
    assert.deepStrictEqual(defaultUserDirs({}, 'darwin', h), [
      path.join(h, 'Library', 'Application Support', 'Code', 'User'), path.join(h, 'Library', 'Application Support', 'Code - Insiders', 'User')]);
    assert.strictEqual(defaultUserDirs({}, 'linux', h)[0], path.join(h, '.config', 'Code', 'User'));
    assert.strictEqual(defaultUserDirs({ XDG_CONFIG_HOME: path.join(h, 'x') }, 'linux', h)[0], path.join(h, 'x', 'Code', 'User'));
    assert.strictEqual(defaultUserDirs({ APPDATA: path.join(h, 'AppData') }, 'win32', h)[0], path.join(h, 'AppData', 'Code', 'User'));
    assert.deepStrictEqual(defaultUserDirs({ VSCODE_PORTABLE: path.join(h, 'port') }, 'win32', h), [path.join(h, 'port', 'user-data', 'User')]);
    assert.strictEqual(normalizeUserDir(path.join(h, 'User', 'profiles', 'abc')), path.join(h, 'User'));
    assert.strictEqual(normalizeUserDir(path.join(h, 'User')), path.join(h, 'User'));
    const p = new CopilotProvider({ copilot: { userDir: path.join(h, 'User') } });
    assert.deepStrictEqual(p.userDirs, [path.join(h, 'User')]);
    assert.deepStrictEqual(new CopilotProvider({ userDirs: [path.join(h, 'A'), path.join(h, 'A')] }).userDirs, [path.join(h, 'A')]);
    assert.deepStrictEqual(new CopilotProvider({ userDir: path.join(TMP, 'missing') }).scan(S(0)), []);
  });
}

// ---------- Run ----------

console.log('copilot provider');
try {
  replayTests();
  readerTests();
  statusTests();
  sessionTests();
  subagentTests();
  boundsTests();
  incrementalTests();
  apiTests();
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch { /* ignore */ }
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
