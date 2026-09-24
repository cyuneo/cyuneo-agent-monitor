'use strict';
// Tests for lib/providers/codex.js. Run with plain node: node test/codex.test.js
// All data is synthetic (test/fixtures/codex/home); tests copy it to a temp directory and set mtimes there, never touching the repo files.
// Temp directory: AGENT_MONITOR_TEST_TMP (falls back to the system temp directory); deleted after the run.
// Optional smoke test: node test/codex.test.js --real (or AGENT_MONITOR_REAL=1) reads the local ~/.codex read-only and prints only counts and distributions.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const codex = require('../lib/providers/codex');
const { CodexProvider, newThreadState, ingestCodex, classifyThread, describeExecCode, describeCodexCall,
  parsePatchHeaders, metaOf, entryOf, guessToolOf, stepOf, limitReachedNow } = codex;
const { resumeVariants } = require('../lib/core/resume');

const FIX = path.join(__dirname, 'fixtures', 'codex', 'home');
const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-codex-'));

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
const ID = (n) => `0c0de000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const KEY = (n) => `codex:${ID(n)}`;
const line = (o) => JSON.stringify(o) + '\n';
const iso = (s) => new Date(S(s)).toISOString();

// Set a rollout's mtime to the timestamp of its last line (simulates Codex having just written that line)
function touchToLastLine(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const ts = Date.parse(JSON.parse(lines[lines.length - 1]).timestamp);
  fs.utimesSync(file, new Date(ts), new Date(ts));
}

function rollouts(home) {
  const out = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/^rollout-.*\.jsonl$/.test(f.name)) out.push(p);
    }
  })(path.join(home, 'sessions'));
  return out;
}

let homeNo = 0;
// Copy the synthetic CODEX_HOME; when `only` lists thread numbers, copy just those rollouts
function makeHome(only) {
  const home = path.join(TMP, `home-${++homeNo}`);
  fs.cpSync(FIX, home, { recursive: true });
  for (const f of rollouts(home)) {
    if (only && !only.some((n) => f.endsWith(ID(n) + '.jsonl'))) { fs.rmSync(f); continue; }
    touchToLastLine(f);
  }
  return home;
}
const fileOf = (home, n) => rollouts(home).find((f) => f.endsWith(ID(n) + '.jsonl'));

const SHARED = makeHome();
// Home without the limit-hit threads (0005, 000e): the account-level quota is not full, so an in-progress thread that times out is stale
const NO_LIMIT = makeHome([1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 15]);
function scanAt(sec, opts = {}, home = SHARED) {
  const p = new CodexProvider({ home, activeWindowMinutes: 60, staleMinutes: 5, ...opts });
  const sessions = p.scan(S(sec));
  const by = new Map(sessions.map((s) => [s.key, s]));
  return { p, sessions, by };
}

// Feed lines into a single thread state (without going through files)
function feed(lines, fileId = null) {
  const s = newThreadState(undefined, fileId);
  for (const e of lines) ingestCodex(s, e);
  return s;
}
const ev = (sec, type, payload) => ({ timestamp: iso(sec), type, payload });
const baseOpts = (sec, extra = {}) => ({ now: S(sec), mtimeMs: 0, staleMs: 5 * 60e3, staleMinutes: 5, ...extra });

// ---------- Parsing: tool calls → steps ----------

function parseTests() {
  test('exec code: tool name, cmd as a JSON-style key, parallel count', () => {
    const a = describeExecCode('const r = await tools.exec_command({"cmd":"git status --short","workdir":"/w"});');
    assert.deepStrictEqual([a.tool, a.detail, a.parallel], ['exec_command', 'git status --short', 1]);
    const b = describeExecCode("await Promise.all([tools.exec_command({ cmd: 'npm test' }), tools.exec_command({ cmd: 'npm run lint' })]);");
    assert.deepStrictEqual([b.tool, b.detail, b.parallel, b.tools], ['exec_command', 'npm test', 2, ['exec_command']]);
    const c = describeExecCode('await tools.exec_command({cmd:`ls ${dir}`});');
    assert.strictEqual(c.detail, 'ls ${dir}');
    const d = describeExecCode('const {cmd, workdir} = x; await tools.exec_command({cmd, workdir});');
    assert.deepStrictEqual([d.tool, d.detail], ['exec_command', null], 'shorthand property gives no command');
  });

  test('exec code: apply_patch takes the patch path (real newlines and \\n escapes); web__run takes query; no tool → exec', () => {
    const a = describeExecCode('const p = `*** Begin Patch\n*** Update File: /a/b/c/app.js\n@@\n*** End Patch`;\nawait tools.apply_patch(p);');
    assert.deepStrictEqual([a.tool, a.detail], ['apply_patch', '…/c/app.js']);
    const b = describeExecCode('await tools.apply_patch("*** Begin Patch\\n*** Add File: /x/y/z.md\\n+hi\\n*** End Patch");');
    assert.deepStrictEqual(b.patch, [{ path: '/x/y/z.md', op: 'create', movedTo: null }]);
    const w = describeExecCode("await tools.web__run({ search_query: [{ q: 'codex rollout format' }] });");
    assert.deepStrictEqual([w.tool, w.detail], ['web__run', 'codex rollout format']);
    const n = describeExecCode('const x = 1 + 1; text(String(x));');
    assert.deepStrictEqual([n.tool, n.detail, n.tools], ['exec', null, []]);
    const m = describeExecCode('await tools.mcp__codex_apps__github_fetch({ url: "u" });');
    assert.strictEqual(m.tool, 'mcp__codex_apps__github_fetch');
  });

  test('patch headers: Add / Update / Update+Move to / Delete', () => {
    const got = parsePatchHeaders('*** Begin Patch\n*** Add File: a.js\n+x\n*** Update File: b.js\n*** Move to: c.js\n@@\n*** Update File: d.js\n@@\n*** Delete File: e.js\n*** End Patch');
    assert.deepStrictEqual(got.map((f) => [f.path, f.op, f.movedTo]),
      [['a.js', 'create', null], ['b.js', 'move', 'c.js'], ['d.js', 'edit', null], ['e.js', 'delete', null]]);
  });

  test('function_call: shell command array, wait cell_id, apply_patch function form; local_shell_call', () => {
    const sh = describeCodexCall({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la'] }), call_id: 'c' });
    assert.deepStrictEqual([sh.tool, sh.detail], ['shell', 'bash -lc ls -la']);
    const w = describeCodexCall({ type: 'function_call', name: 'wait', arguments: '{"cell_id":12,"yield_time_ms":1000}', call_id: 'w' });
    assert.deepStrictEqual([w.tool, w.cellId, w.detail], ['wait', '12', null]);
    const ap = describeCodexCall({ type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** Update File: /p/q/r.js\n*** End Patch' }) });
    assert.deepStrictEqual([ap.tool, ap.detail, ap.patch.length], ['apply_patch', '…/q/r.js', 1]);
    const ls = describeCodexCall({ type: 'local_shell_call', call_id: 'l', action: { type: 'exec', command: ['echo', 'hi'] } });
    assert.deepStrictEqual([ls.tool, ls.detail], ['local_shell', 'echo hi']);
  });

  test('tool name used for guessing: fast only if all tools in the code are fast; a long command mixed in makes it not fast', () => {
    const fast = describeCodexCall({ type: 'custom_tool_call', name: 'exec', input: 'await tools.apply_patch(p); await tools.update_plan({});' });
    assert.strictEqual(guessToolOf(fast), 'apply_patch');
    const mixed = describeCodexCall({ type: 'custom_tool_call', name: 'exec', input: 'await tools.apply_patch(p); await tools.exec_command({cmd:"make"});' });
    assert.strictEqual(guessToolOf(mixed), 'exec_command');
    assert.strictEqual(guessToolOf({ tool: 'wait', tools: ['wait'], cell: fast }), 'apply_patch', 'wait is judged by the code cell it waits on');
  });

  test('session_meta: three forms of review thread, subagent nickname and role, memory-consolidation thread hidden, root thread id', () => {
    const r1 = metaOf({ id: 'c', parent_thread_id: 'p', source: { subagent: { other: 'guardian' } } }, 0);
    const r2 = metaOf({ id: 'c', parent_thread_id: 'p', thread_source: 'guardian_review', source: { subagent: 'review' } }, 0);
    const r3 = metaOf({ id: 'c', source: { internal: 'guardian' } }, 0);
    assert.deepStrictEqual([r1.reviewer, r2.reviewer, r3.reviewer], [true, true, true]);
    const sp = metaOf({ id: 'c', session_id: 'root', source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 2, agent_nickname: 'Ada', agent_type: 'explorer' } } } }, 0);
    assert.deepStrictEqual([sp.parentId, sp.rootId, sp.nickname, sp.role, sp.reviewer], ['p', 'root', 'Ada', 'explorer', false]);
    assert.strictEqual(metaOf({ id: 'm', thread_source: 'memory_consolidation' }, 0).hidden, true);
    assert.strictEqual(metaOf({ id: 'm', session_id: 'm', source: 'vscode' }, 0).rootId, null, 'main thread: session_id = its own id');
  });

  test('entry point: originator first, then source', () => {
    assert.strictEqual(entryOf({ originator: 'Codex Desktop', source: 'vscode' }), 'desktop');
    assert.strictEqual(entryOf({ originator: 'codex_vscode' }), 'vscode');
    assert.strictEqual(entryOf({ originator: 'codex_cli_rs', source: 'cli' }), 'cli');
    assert.strictEqual(entryOf({ originator: 'codex_exec', source: 'exec' }), 'exec');
    assert.strictEqual(entryOf({ originator: 'x', source: 'mcp' }), 'other');
  });
}

// ---------- Discovery, grouping, session fields ----------

function scanTests() {
  test('discovery: across date directories; child threads attach to the parent session; a child whose parent is not found becomes its own session', () => {
    const { sessions, by } = scanAt(120);
    const keys = sessions.map((s) => s.key).sort();
    const want = [1, 2, 3, 4, 5, 6, 7, 8, 11, 13, 14, 15].map(KEY).sort();
    assert.deepStrictEqual(keys, want);
    assert.deepStrictEqual(by.get(KEY(8)).agents.map((a) => a.id), [ID(10), ID(9)], 'sorted by start time, ascending');
    assert.deepStrictEqual(by.get(KEY(11)).agents.map((a) => a.id), [ID(12)], 'parent thread outside the window is included too');
    assert.strictEqual(by.get(KEY(13)).main.kind, 'main');
    assert.strictEqual(by.get(KEY(13)).titleSource, 'prompt');
    assert.strictEqual(by.get(KEY(13)).title.length, 40);
    for (let i = 1; i < sessions.length; i++) assert.ok(sessions[i - 1].updatedMs >= sessions[i].updatedMs, 'sorted by updatedMs, descending');
  });

  test('0001 turn finished: done, title from the last index entry, entry point, usage (deduped by response_id) and cost', () => {
    const s = scanAt(120).by.get(KEY(1));
    assert.strictEqual(s.main.status.code, 'done');
    assert.strictEqual(s.main.status.sinceMs, S(61));
    assert.strictEqual(s.doneAtMs, S(61));
    assert.deepStrictEqual([s.title, s.titleSource, s.entry, s.entryRaw, s.provider, s.id], ['Fix lint errors', 'index', 'vscode', 'codex_vscode', 'codex', ID(1)]);
    assert.deepStrictEqual([s.live, s.liveStatus, s.waitingFor, s.entrypoint, s.projectDir], [false, null, null, null, null]);
    assert.deepStrictEqual([s.createdMs, s.startedMs, s.cwd, s.model], [S(0), S(0), '/work/demo', 'gpt-5.6-sol']);
    const t = s.main.tokens;
    assert.deepStrictEqual([t.display, t.contextUsed, t.contextWindow, t.compactAt, t.toCompact], [16200, 16200, 258400, 244800, 228600]);
    assert.deepStrictEqual([t.output, t.processed, t.apiCalls], [2500, 39500, 3]);
    approx(s.main.costUsd, 0.09, 1e-12);
    approx(s.costUsd, 0.09, 1e-12);
    assert.deepStrictEqual([s.main.toolCalls, s.main.toolErrors, s.main.filesChanged], [5, 3, 4]);
    assert.deepStrictEqual(s.main.lastCompact, { ms: S(57), trigger: null, preTokens: 12800, postTokens: 16200, model: 'gpt-5.6-sol', contextWindow: 258400 });
    assert.deepStrictEqual([s.compactCount, s.compactLoop], [1, false]); // a compacted line and a ContextCompaction count as one
    assert.deepStrictEqual(s.counts, { running: 0, awaiting: 0, error: 0, done: 1, total: 1 });
    assert.deepStrictEqual(s.workflows, []);
    assert.deepStrictEqual(s.resume, []);
    assert.deepStrictEqual([s.main.kind, s.main.name, s.main.cacheTtl, s.main.background, s.main.phase], ['main', null, null, false, null]);
    assert.deepStrictEqual(s.main.step, { kind: 'text', tool: null, detail: 'All tests pass. Updated 4 files.', parallel: 0, sinceMs: S(60) });
  });

  test('0001 details: timeline (prompt uses the user\'s original text, reasoning merged, compaction recorded once), result, changed files, errors', () => {
    const { p } = scanAt(120, { limits: { timelineSent: 50 } });
    const d = p.details([KEY(1), 'codex:nope'])[KEY(1)];
    assert.ok(d && !p.detail('codex:nope'));
    const a = d.agents[ID(1)];
    assert.deepStrictEqual(a.timeline.map((e) => e.kind), ['prompt', 'thinking', 'tool', 'toolDone', 'tool', 'toolDone',
      'tool', 'toolError', 'toolDone', 'tool', 'toolError', 'toolDone', 'tool', 'toolError', 'thinking', 'text', 'compact', 'text', 'done']);
    assert.strictEqual(a.timeline[0].detail, 'Run the tests and fix lint');
    assert.strictEqual(a.timeline[1].detail, 'Planning the test run');
    assert.deepStrictEqual([a.timeline[2].tool, a.timeline[2].detail], ['exec_command', 'npm test']);
    assert.deepStrictEqual([a.timeline[4].tool, a.timeline[4].detail], ['apply_patch', '…/src/new.js']);
    assert.deepStrictEqual(a.result, { text: 'All tests pass. Updated 4 files.', ms: S(61), source: 'taskComplete', truncated: false });
    const files = Object.fromEntries(a.files.map((f) => [f.path, [f.op, f.movedTo]]));
    assert.deepStrictEqual(files, {
      '/work/demo/src/new.js': ['create', null], '/work/demo/src/old.js': ['move', '/work/demo/src/renamed.js'],
      '/work/demo/src/app.js': ['edit', null], '/work/demo/tmp.txt': ['delete', null],
    });
    assert.deepStrictEqual(a.errors.map((e) => [e.tool, e.text]), [
      ['exec_command', 'error: 2 problems'], ['mcp__docs__search', 'tool not found'], ['exec', 'Error: boom']]);
    const d12 = scanAt(120).p.detail(KEY(1)).agents[ID(1)];
    assert.strictEqual(d12.timeline.length, 12, 'only the latest 12 entries are sent by default');
    assert.strictEqual(d12.timeline[11].kind, 'done');
  });

  test('account-level quota: newest rate_limits across all rollouts (5h + weekly)', () => {
    const q = scanAt(120).p.quota();
    assert.deepStrictEqual([q.planType, q.limitId, q.reachedType, q.observedMs], ['plus', 'codex', null, S(90.1)]);
    assert.deepStrictEqual(q.windows.map((w) => [w.label, w.usedPct]), [['5h', 100], ['weekly', 60]]);
    assert.strictEqual(q.windows[0].resetsAtMs, S(2 * 3600));
    assert.deepStrictEqual(q.credits, { hasCredits: false, unlimited: false, balance: '0' });
  });

  test('with no threads in the window, the quota is read from the tail of the newest rollout', () => {
    const home = makeHome([1, 8]);
    const p = new CodexProvider({ home, activeWindowMinutes: 1 });
    assert.deepStrictEqual(p.scan(S(86400)), []);
    const q = p.quota();
    assert.deepStrictEqual(q.windows.map((w) => [w.label, w.usedPct]), [['5h', 42], ['weekly', 17]]);
    assert.strictEqual(q.observedMs, S(59.1), '0001 is newer than 0008');
    const empty = new CodexProvider({ home: path.join(TMP, 'no-such-home') });
    assert.deepStrictEqual(empty.scan(S(0)), []);
    assert.deepStrictEqual(empty.quota().windows, []);
  });

  test('config.toml: model_auto_compact_token_limit takes the smaller value; no "until compaction" with body_after_prefix', () => {
    const home = makeHome([1]);
    fs.writeFileSync(path.join(home, 'config.toml'), 'model_auto_compact_token_limit = 200_000\n');
    let s = scanAt(120, {}, home).by.get(KEY(1));
    assert.deepStrictEqual([s.main.tokens.compactAt, s.main.tokens.toCompact], [200000, 183800]);
    fs.writeFileSync(path.join(home, 'config.toml'), 'model_auto_compact_token_limit_scope = "body_after_prefix"\n');
    s = scanAt(120, {}, home).by.get(KEY(1));
    assert.deepStrictEqual([s.main.tokens.compactAt, s.main.tokens.toCompact], [244800, null]);
  });

  test('context window and compaction point sources, percentage (Claude Code formula), main transcript path; Codex has no cost-state', () => {
    const s = scanAt(120).by.get(KEY(1));
    assert.deepStrictEqual([s.contextWindow, s.contextWindowSource, s.compactAt, s.compactAtSource, s.autoCompactWindow],
      [258400, 'codex-record', 244800, 'default', null]);
    assert.strictEqual(s.contextPct, Math.round(16200 / 258400 * 100));
    assert.strictEqual(s.main.tokens.contextPct, s.contextPct);
    assert.deepStrictEqual([s.modelVariant, s.ccCostUsd], [null, null]);
    assert.strictEqual(s.transcript, fileOf(SHARED, 1));
    assert.strictEqual(s.transcript, s.main.file);
    assert.ok(!('_ctx' in JSON.parse(JSON.stringify(s.main))), 'internal fields stay out of the snapshot');
    const home = makeHome([1]);
    fs.writeFileSync(path.join(home, 'config.toml'), 'model_auto_compact_token_limit = 200_000\n');
    const c = scanAt(120, {}, home).by.get(KEY(1));
    assert.deepStrictEqual([c.compactAt, c.compactAtSource], [200000, 'settings-user']);
    for (const a of scanAt(120).by.get(KEY(8)).agents) {
      assert.ok(a.tokens.contextPct == null || (Number.isInteger(a.tokens.contextPct) && a.tokens.contextPct >= 0 && a.tokens.contextPct <= 100));
    }
  });

  test('convenience fields named as in Claude sessions; cache-related fields are null; detail / has accept an id or a key', () => {
    const { p, by } = scanAt(120);
    const s = by.get(KEY(1));
    assert.deepStrictEqual([s.version, s.contextUsed, s.contextWindow, s.compactAt, s.lastActivityMs, s.lastApiMs, s.unpricedModel],
      ['0.155.0', 16200, 258400, 244800, S(61), S(59), null]);
    assert.deepStrictEqual([s.cacheTtl, s.cacheTtlMs, s.cacheExpiresMs, s.cacheTtlInferred], [null, null, null, false]);
    assert.deepStrictEqual([s.main.costEstimated, s.main.lastApiMs], [false, S(59)]);
    assert.strictEqual(by.get(KEY(8)).unpricedModel, 'codex-auto-review');
    assert.ok(p.has(KEY(1)) && p.has(ID(1)) && p.has(ID(1).toUpperCase()));
    assert.ok(!p.has('claude:' + ID(1)) && !p.has('') && !p.has(ID(9)), 'a child thread is not a session');
    assert.strictEqual(p.detail(ID(1)).key, KEY(1));
    assert.strictEqual(p.detail('claude:' + ID(1)), null);
  });

  test('bad lines, unknown types and malformed lines are skipped without affecting the scan', () => {
    const home = makeHome([1]);
    const f = fileOf(home, 1);
    const junk = ['null', '42', '[1,2]', '{"type":"event_msg","payload":null}', '{"type":"event_msg"}', '{broken',
      '{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":{}}}',
      '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","status":"completed","changes":"x"}}}',
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":null,"last_token_usage":null}}}',
      '{"type":"session_meta","payload":{"id":"' + ID(2) + '"}}', '{"type":"future_kind","payload":{"type":"whatever"}}'];
    fs.appendFileSync(f, junk.join('\n') + '\n');
    const s = scanAt(120, {}, home).by.get(KEY(1));
    assert.strictEqual(s.main.status.code, 'done');
    assert.strictEqual(s.id, ID(1), 'session_meta from another thread is ignored');
  });

  test('keepKeys: a selected session is kept even outside the activity window', () => {
    const p = new CodexProvider({ home: SHARED, activeWindowMinutes: 1 });
    const got = p.scan(S(86400), { keepKeys: [KEY(1), 'claude:x'] });
    assert.deepStrictEqual(got.map((s) => s.key), [KEY(1)]);
    assert.ok(p.detail(KEY(1)));
  });

  test('internal threads such as memory consolidation do not become sessions of their own', () => {
    const home = makeHome([1]);
    const id = ID(0x99);
    const f = path.join(home, 'sessions', '2026', '09', '20', `rollout-x-${id}.jsonl`);
    fs.writeFileSync(f, line(ev(0, 'session_meta', { id, session_id: id, timestamp: iso(0), cwd: '/w', originator: 'codex_vscode', source: { internal: 'memory_consolidation' }, thread_source: 'memory_consolidation' })));
    touchToLastLine(f);
    assert.deepStrictEqual(scanAt(120, {}, home).sessions.map((s) => s.key), [KEY(1)]);
  });
}

// ---------- Status detection ----------

function statusTests() {
  test('0002 fast tool apply_patch: tool within 30 s; after 60 s, guessed as "maybe waiting for your approval"', () => {
    let s = scanAt(30).by.get(KEY(2));
    assert.deepStrictEqual([s.main.status.code, s.main.status.pendingTool, s.main.status.sinceMs], ['tool', 'apply_patch', S(10)]);
    assert.deepStrictEqual(s.main.step, { kind: 'tool', tool: 'apply_patch', detail: '…/src/app.js', parallel: 1, sinceMs: S(10) });
    assert.deepStrictEqual([s.live, s.liveStatus, s.entry], [true, 'busy', 'desktop']);
    s = scanAt(75).by.get(KEY(2));
    assert.deepStrictEqual([s.main.status.code, s.main.status.pendingTool, s.main.status.sinceMs, s.main.status.certainty],
      ['maybeAwaitingApproval', 'apply_patch', S(10), 'guess']);
    assert.strictEqual(s.liveStatus, 'waiting');
    assert.deepStrictEqual(s.counts, { running: 0, awaiting: 1, error: 0, done: 0, total: 1 });
    s = scanAt(6 * 60, {}, NO_LIMIT).by.get(KEY(2));
    assert.strictEqual(s.main.status.code, 'maybeAwaitingApproval', 'decided before stale');
  });

  test('0002 settings: off disables the guess; seconds are configurable; allTools uses staleMinutes', () => {
    assert.strictEqual(scanAt(75, { approvalGuess: 'off' }).by.get(KEY(2)).main.status.code, 'tool');
    assert.strictEqual(scanAt(75, { approvalGuessSeconds: 120 }).by.get(KEY(2)).main.status.code, 'tool');
    assert.strictEqual(scanAt(140, { approvalGuessSeconds: 120 }).by.get(KEY(2)).main.status.code, 'maybeAwaitingApproval');
    assert.strictEqual(scanAt(75, { approvalGuess: 'allTools' }).by.get(KEY(2)).main.status.code, 'tool');
    assert.strictEqual(scanAt(6 * 60, { approvalGuess: 'allTools' }, NO_LIMIT).by.get(KEY(2)).main.status.code, 'maybeAwaitingApproval');
    assert.strictEqual(scanAt(6 * 60, { approvalGuess: 'off' }, NO_LIMIT).by.get(KEY(2)).main.status.code, 'stale');
  });

  test('0003 long command exec_command: no guess; 2 in parallel; stale with stalePending after timeout; guessed with allTools', () => {
    let s = scanAt(90).by.get(KEY(3));
    assert.deepStrictEqual([s.main.status.code, s.main.status.pendingTool], ['tool', 'exec_command']);
    assert.deepStrictEqual([s.main.step.tool, s.main.step.detail, s.main.step.parallel], ['exec_command', 'npm run build', 2]);
    s = scanAt(6 * 60, {}, NO_LIMIT).by.get(KEY(3));
    assert.deepStrictEqual([s.main.status.code, s.main.status.stalePending, s.main.status.pendingTool, s.main.status.sinceMs],
      ['stale', true, 'exec_command', S(10)]);
    assert.deepStrictEqual(s.resume.map((h) => [h.kind, h.threadId, h.entry, h.cwd]), [['codexThread', ID(3), 'vscode', '/work/demo']]);
    assert.deepStrictEqual(resumeVariants(s.resume[0]), ['prompt']);
    assert.strictEqual(scanAt(6 * 60, { approvalGuess: 'allTools' }, NO_LIMIT).by.get(KEY(3)).main.status.code, 'maybeAwaitingApproval');
  });

  test('0004 exec code cell still running (Script running with cell ID); wait is waiting on apply_patch', () => {
    let s = scanAt(30).by.get(KEY(4));
    assert.deepStrictEqual([s.main.status.code, s.main.status.pendingTool], ['tool', 'apply_patch']);
    assert.deepStrictEqual(s.main.step, { kind: 'tool', tool: 'apply_patch', detail: '…/lib/util.js', parallel: 1, sinceMs: S(10) });
    s = scanAt(75).by.get(KEY(4));
    assert.deepStrictEqual([s.main.status.code, s.main.status.pendingTool, s.main.status.sinceMs], ['maybeAwaitingApproval', 'apply_patch', S(10)]);
    const tl = scanAt(75).p.detail(KEY(4)).agents[ID(4)].timeline.map((e) => e.kind);
    assert.deepStrictEqual(tl, ['prompt', 'tool'], 'still-running output and wait are not recorded separately');
    assert.strictEqual(s.main.toolCalls, 2);
  });

  test('0005 usage limit hit (usage_limit_exceeded, string form) → quota; reset time from the exhausted window', () => {
    const s = scanAt(120).by.get(KEY(5));
    assert.strictEqual(s.main.status.code, 'quota');
    assert.strictEqual(s.main.status.sinceMs, S(100));
    assert.deepStrictEqual(s.main.status.quota, { kind: 'window', model: null, resetsAtMs: S(2 * 3600), resetsText: null, source: 'turnError', autoContinue: false });
    assert.deepStrictEqual(s.resume.map((h) => [h.kind, h.entry]), [['codexThread', 'desktop']]);
    assert.ok(s.resume[0].estimate.contextTokens === 41000 && s.resume[0].estimate.ttl === 'unknown');
    const d = scanAt(120).p.detail(KEY(5)).agents[ID(5)];
    assert.strictEqual(d.timeline[d.timeline.length - 1].kind, 'quota');
    assert.strictEqual(d.result, null, 'no reply');
    assert.deepStrictEqual(s.counts, { running: 0, awaiting: 0, error: 1, done: 0, total: 1 });
  });

  test('0006 API error (object form with parameters) → apiError, with HTTP status and first line of the error', () => {
    const s = scanAt(120).by.get(KEY(6));
    assert.strictEqual(s.main.status.code, 'apiError');
    assert.deepStrictEqual(s.main.status.error, { kind: 'http_connection_failed', http: 502, message: 'stream disconnected before completion' });
    assert.strictEqual(s.resume.length, 1);
  });

  test('other task_complete.error enum values in string form → apiError', () => {
    const st = feed([
      ev(0, 'session_meta', { id: 'x', timestamp: iso(0) }),
      ev(1, 'event_msg', { type: 'task_started', turn_id: 't' }),
      ev(9, 'event_msg', { type: 'task_complete', turn_id: 't', last_agent_message: null, error: { message: 'Server overloaded', codex_error_info: 'server_overloaded' } }),
    ]);
    const r = classifyThread(st, baseOpts(20));
    assert.deepStrictEqual([r.code, r.error.kind, r.error.http, r.error.message], ['apiError', 'server_overloaded', null, 'Server overloaded']);
    const st2 = feed([ev(1, 'event_msg', { type: 'task_started', turn_id: 't' }), ev(2, 'event_msg', { type: 'task_complete', turn_id: 't', error: { message: 'x' } })]);
    assert.strictEqual(classifyThread(st2, baseOpts(3)).error.kind, 'unknown');
  });

  test('turn_aborted: four reasons', () => {
    const run = (reason) => classifyThread(feed([
      ev(1, 'event_msg', { type: 'task_started', turn_id: 't' }),
      ev(5, 'event_msg', { type: 'turn_aborted', turn_id: 't', reason }),
    ]), baseOpts(10));
    assert.strictEqual(run('interrupted').code, 'interrupted');
    assert.strictEqual(run('replaced').code, 'done');
    assert.strictEqual(run('review_ended').code, 'done');
    const b = run('budget_limited');
    assert.deepStrictEqual([b.code, b.quota.kind, b.quota.source], ['quota', 'spend', 'turnError']);
    assert.strictEqual(run('interrupted').sinceMs, S(5));
  });

  test('0007 legacy: turn_started/turn_complete aliases, user_message, shell, apply_patch falls back to the patch header, token_count deltas', () => {
    const s = scanAt(120).by.get(KEY(7));
    assert.deepStrictEqual([s.entry, s.entryRaw, s.model, s.title, s.titleSource], ['cli', 'codex_cli_rs', 'gpt-5.5', 'List the files and add a stub', 'prompt']);
    assert.strictEqual(s.main.status.code, 'interrupted', 'second turn was interrupted');
    assert.deepStrictEqual([s.main.tokens.processed, s.main.tokens.output, s.main.tokens.apiCalls, s.main.tokens.contextUsed], [5300, 300, 2, 3200]);
    approx(s.main.costUsd, 0.0295, 1e-12);
    assert.deepStrictEqual([s.main.toolCalls, s.main.filesChanged], [2, 1]);
    assert.strictEqual(s.doneAtMs, S(10));
    const d = scanAt(120).p.detail(KEY(7)).agents[ID(7)];
    assert.deepStrictEqual(d.files.map((f) => [f.path, f.op]), [['/work/demo/src/stub.js', 'create']]);
    assert.deepStrictEqual(d.result, { text: 'Added src/stub.js.', ms: S(9), source: 'lastText', truncated: false });
    assert.deepStrictEqual(d.timeline.map((e) => e.kind), ['prompt', 'tool', 'toolDone', 'tool', 'toolDone', 'text', 'done', 'prompt', 'interrupt']);
    assert.deepStrictEqual([d.timeline[1].tool, d.timeline[1].detail], ['shell', 'bash -lc ls -la']);
    assert.strictEqual(d.timeline[7].detail, 'Now run the tests');
    assert.deepStrictEqual(s.resume.map((h) => [h.kind, h.entry]), [['codexThread', 'cli']]);
    assert.deepStrictEqual(resumeVariants(s.resume[0]), ['cli', 'prompt']);
  });

  test('0008 parent/child threads: review thread + subagent; main thread finished its turn but a child is running → idleBackground', () => {
    const s = scanAt(60).by.get(KEY(8));
    assert.deepStrictEqual([s.title, s.titleSource], ['Explore with helper', 'index']);
    assert.strictEqual(s.main.status.code, 'idleBackground');
    const [rev, sub] = s.agents;
    assert.deepStrictEqual([rev.kind, rev.name, rev.agentType, rev.model, rev.status.code], ['codexReviewer', null, null, 'codex-auto-review', 'done']);
    assert.deepStrictEqual([sub.kind, sub.name, sub.agentType, sub.status.code, sub.startedMs], ['codexSubagent', 'Ada', 'explorer', 'thinking', S(25)]);
    assert.deepStrictEqual([rev.costUsd, rev.unpricedModel], [null, 'codex-auto-review'], 'the review model has no public price');
    approx(s.main.costUsd, 0.046, 1e-12);
    approx(sub.costUsd, 0.0236, 1e-12);
    approx(s.costUsd, 0.0696, 1e-12);
    assert.strictEqual(s.updatedMs, S(55));
    assert.deepStrictEqual(s.counts, { running: 2, awaiting: 0, error: 0, done: 1, total: 3 });
    assert.strictEqual(sub.step.kind, 'thinking');
    assert.strictEqual(sub.step.detail, 'Reading lib/ layout');
    const d = scanAt(60).p.detail(KEY(8));
    assert.deepStrictEqual(Object.keys(d.agents).sort(), [ID(8), ID(9), ID(10)].sort());
    assert.deepStrictEqual(d.agents[ID(10)].result.text, '{"outcome":"allow"}');
    // Child threads stop writing: stale; the main thread no longer counts as running in the background
    const later = scanAt(20 * 60, {}, NO_LIMIT).by.get(KEY(8));
    assert.deepStrictEqual([later.agents[1].status.code, later.main.status.code], ['stale', 'done']);
  });

  test('000e in progress, quota full and no longer writing → quota (rateLimits) instead of stale; after the reset time → stale', () => {
    const home = makeHome([14]);
    assert.strictEqual(scanAt(60, {}, home).by.get(KEY(14)).main.status.code, 'starting', 'only a user message so far');
    const q = scanAt(10 * 60, {}, home).by.get(KEY(14)).main.status;
    assert.deepStrictEqual([q.code, q.quota.source, q.quota.kind, q.quota.resetsAtMs], ['quota', 'rateLimits', 'window', S(4 * 3600)]);
    assert.strictEqual(scanAt(5 * 3600, { activeWindowMinutes: 600 }, home).by.get(KEY(14)).main.status.code, 'stale');
  });

  test('quota belongs to the account: if a snapshot from another thread shows it full, a timed-out in-progress thread is quota too; reset time from the newest snapshot', () => {
    const q = scanAt(10 * 60).by.get(KEY(14)).main.status;
    assert.deepStrictEqual([q.code, q.quota.resetsAtMs], ['quota', S(2 * 3600)], 'the 0005 snapshot is newer');
    assert.strictEqual(scanAt(10 * 60).by.get(KEY(3)).main.status.code, 'quota');
    assert.strictEqual(scanAt(90).by.get(KEY(3)).main.status.code, 'tool', 'not timed out yet: status as usual');
  });

  test('000f only session_meta → starting; stale after timeout', () => {
    assert.strictEqual(scanAt(60).by.get(KEY(15)).main.status.code, 'starting');
    const st = scanAt(10 * 60).by.get(KEY(15)).main.status;
    assert.deepStrictEqual([st.code, st.stalePending, st.sinceMs], ['stale', false, S(0)]);
  });

  test('no guess when approval_policy = never or while a review thread is reviewing', () => {
    const lines = (policy) => [
      ev(0, 'session_meta', { id: 'x', timestamp: iso(0) }),
      ev(1, 'event_msg', { type: 'task_started', turn_id: 't' }),
      ev(1, 'turn_context', { turn_id: 't', model: 'gpt-5.6-sol', approval_policy: policy }),
      ev(10, 'response_item', { type: 'custom_tool_call', call_id: 'c', name: 'exec', input: 'await tools.apply_patch(p);' }),
    ];
    assert.strictEqual(classifyThread(feed(lines('on-request')), baseOpts(80)).code, 'maybeAwaitingApproval');
    assert.strictEqual(classifyThread(feed(lines('never')), baseOpts(80)).code, 'tool');
    assert.strictEqual(classifyThread(feed(lines({ granular: {} })), baseOpts(80)).code, 'maybeAwaitingApproval');
    assert.strictEqual(classifyThread(feed(lines('on-request')), baseOpts(80, { reviewerWorking: true })).code, 'tool');
  });

  test('usage: token_usage_record and token_count are not double-counted, even in a file that has only token_count at first and records later', () => {
    const u = (i, c, o) => ({ input_tokens: i, cached_input_tokens: c, cache_write_input_tokens: 0, output_tokens: o, reasoning_output_tokens: 0, total_tokens: i + o });
    const tc = (sec, total, last) => ev(sec, 'event_msg', { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 }, rate_limits: null });
    const rec = (sec, id, usage) => ({ timestamp: iso(sec), type: 'token_usage_record', payload: { response_id: id, usage } });
    const st = feed([
      ev(0, 'turn_context', { model: 'gpt-5.6-sol' }),
      tc(1, u(1000, 0, 100), u(1000, 0, 100)),                     // old format: delta 1100
      tc(2, u(1000, 0, 100), u(1000, 0, 100)),                     // identical: skipped
      rec(3, 'r1', u(2000, 1000, 200)),                            // counted by record from here on
      tc(3.1, u(3000, 1000, 300), u(2000, 1000, 200)),
      rec(4, 'r1', u(2000, 1000, 200)),                            // duplicate response_id
      rec(5, 'r2', u(500, 0, 50)),
      tc(5.1, u(3500, 1000, 350), u(500, 0, 50)),
    ]);
    assert.deepStrictEqual([st.usage.apiCalls, st.usage.processed, st.usage.output], [3, 1100 + 2200 + 550, 350]);
    // 1000×4 + 100×20 = 6000; 1000×4 + 1000×0.4 + 200×20 = 8400; 500×4 + 50×20 = 3000 → 17400 / 1e6
    approx(st.usage.costUsd, 0.0174, 1e-12);
    assert.strictEqual(st.tokenInfo.last_token_usage.total_tokens, 550);
    // A decrease is treated as a reset and counted in full
    const r = feed([tc(1, u(1000, 0, 0), u(1000, 0, 0)), tc(2, u(300, 0, 0), u(300, 0, 0))]);
    assert.strictEqual(r.usage.processed, 1300);
  });

  test('quota still at the limit: judged by the reset time of the exhausted window; with only a "reached" type, treated as still at the limit', () => {
    const w = (used, resetSec) => ({ used_percent: used, window_minutes: 300, resets_at: Math.floor(S(resetSec) / 1000) });
    assert.strictEqual(limitReachedNow({ primary: w(100, 3600) }, S(0), S(60)), true);
    assert.strictEqual(limitReachedNow({ primary: w(100, 3600) }, S(0), S(7200)), false, 'already reset');
    assert.strictEqual(limitReachedNow({ primary: w(80, 3600), rate_limit_reached_type: 'workspace_member_credits_depleted' }, S(0), S(60)), true);
    assert.strictEqual(limitReachedNow({ primary: w(80, 3600) }, S(0), S(60)), false);
    assert.strictEqual(limitReachedNow(null, 0, 0), false);
  });

  test('missing tier in the price table: use an approximate price and set costEstimated (gpt-5.5 Fast has no long-context price)', () => {
    const st = feed([
      ev(0, 'turn_context', { model: 'gpt-5.5' }),
      ev(0, 'event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.5', service_tier: 'fast' } }),
      { timestamp: iso(1), type: 'token_usage_record', payload: { response_id: 'r', usage: { input_tokens: 300000, cached_input_tokens: 0, output_tokens: 10, total_tokens: 300010 } } },
    ]);
    assert.deepStrictEqual([st.usage.pricedAny, st.usage.estimated, st.lastApiMs], [true, true, S(1)]);
    // 300000×12.5 + 10×75 = 3750750 / 1e6
    approx(st.usage.costUsd, 3.75075, 1e-9);
  });

  test('unpriced model: costUsd is null, counted in unpricedTokens', () => {
    const st = feed([
      ev(0, 'turn_context', { model: 'codex-auto-review' }),
      { timestamp: iso(1), type: 'token_usage_record', payload: { response_id: 'r', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, total_tokens: 15 } } },
    ]);
    assert.deepStrictEqual([st.usage.pricedAny, st.usage.unpricedTokens, st.usage.unpricedModel], [false, 15, 'codex-auto-review']);
  });

  test('steps: toolResult after a result comes back; thinking after reasoning; prompt when there is only a prompt', () => {
    const s = feed([
      ev(1, 'event_msg', { type: 'task_started', turn_id: 't' }),
      ev(1.1, 'event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'hello   there' }] } }),
    ]);
    assert.deepStrictEqual(stepOf(s), { kind: 'prompt', tool: null, detail: 'hello there', parallel: 0, sinceMs: S(1) });
    ingestCodex(s, ev(2, 'response_item', { type: 'custom_tool_call', call_id: 'c', name: 'exec', input: 'await tools.exec_command({cmd:"ls"})' }));
    ingestCodex(s, ev(3, 'response_item', { type: 'custom_tool_call_output', call_id: 'c', output: 'Script completed\n' }));
    assert.deepStrictEqual(stepOf(s), { kind: 'toolResult', tool: 'exec_command', detail: 'ls', parallel: 0, sinceMs: S(3) });
    assert.strictEqual(classifyThread(s, baseOpts(4)).code, 'thinking');
    ingestCodex(s, ev(4, 'response_item', { type: 'reasoning', summary: [] }));
    assert.strictEqual(stepOf(s).kind, 'thinking');
  });

  test('compaction: preTokens from the last token_count before it; postTokens from the first one after it (the one Codex recomputes for the new history); model is the model at that time', () => {
    const tc = (sec, last, total) => ev(sec, 'event_msg', { type: 'token_count', info: {
      last_token_usage: { input_tokens: last, output_tokens: 0, total_tokens: last }, total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total }, model_context_window: 258400 } });
    const s = feed([
      ev(0, 'turn_context', { model: 'gpt-5.6-sol', cwd: '/work/x' }),
      ev(1, 'event_msg', { type: 'task_started', turn_id: 't' }),
      tc(2, 224000, 900000),
      ev(3, 'compacted', { message: '', replacement_history: [] }),
      tc(3.2, 16700, 900000),
      ev(3.5, 'event_msg', { type: 'item_completed', item: { type: 'ContextCompaction', id: 'c' } }),
      tc(9, 23000, 923000),
    ]);
    assert.deepStrictEqual(s.lastCompact, { ms: S(3), trigger: null, preTokens: 224000, postTokens: 16700, model: 'gpt-5.6-sol' });
    assert.strictEqual(s.compactCount, 1, 'compacted and ContextCompaction count as one');
    // Only ContextCompaction and no token_count after it yet: postTokens is null for now
    const t = feed([ev(0, 'turn_context', { model: 'gpt-5.6-sol' }), tc(1, 200000, 200000), ev(2, 'event_msg', { type: 'item_completed', item: { type: 'ContextCompaction', id: 'c' } })]);
    assert.deepStrictEqual([t.lastCompact.preTokens, t.lastCompact.postTokens], [200000, null]);
  });

  test('results longer than resultChars are truncated and flagged', () => {
    const s = newThreadState({ timeline: 30, timelineSent: 12, resultChars: 10, filesPerAgent: 200, errorsPerAgent: 10 });
    ingestCodex(s, ev(1, 'event_msg', { type: 'task_started', turn_id: 't' }));
    ingestCodex(s, ev(2, 'event_msg', { type: 'task_complete', turn_id: 't', last_agent_message: '0123456789ABCDEF' }));
    assert.deepStrictEqual([s.result.text, s.result.truncated, s.result.source], ['0123456789', true, 'taskComplete']);
  });

  test('error details keep only the latest errorsPerAgent entries; the count has no cap', () => {
    const s = newThreadState({ timeline: 30, timelineSent: 12, resultChars: 4000, filesPerAgent: 200, errorsPerAgent: 2 });
    for (let i = 0; i < 5; i++) {
      ingestCodex(s, ev(i, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', status: 'failed', stderr: `err ${i}\nmore`, exit_code: 2 } }));
    }
    assert.deepStrictEqual([s.toolErrors, s.errors.map((e) => e.text)], [5, ['err 3', 'err 4']]);
  });
}

// ---------- Incremental reads, stable order ----------

function incrementalTests() {
  test('incremental: after a result and task_complete are appended, the next scan by the same provider shows done', () => {
    const home = makeHome([2]);
    const f = fileOf(home, 2);
    const p = new CodexProvider({ home, activeWindowMinutes: 60 });
    assert.strictEqual(p.scan(S(30))[0].main.status.code, 'tool');
    fs.appendFileSync(f, line(ev(40, 'response_item', { type: 'custom_tool_call_output', call_id: 'call_p', output: [{ type: 'input_text', text: 'Script completed' }] }))
      + line(ev(44, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Renamed.' }], phase: 'final_answer' }))
      + line(ev(45, 'event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: null })));
    touchToLastLine(f);
    const s = p.scan(S(50))[0];
    assert.deepStrictEqual([s.main.status.code, s.live, s.liveStatus, s.main.toolCalls], ['done', false, null, 1]);
    assert.deepStrictEqual(p.detail(s.key).agents[ID(2)].result, { text: 'Renamed.', ms: S(44), source: 'lastText', truncated: false });
  });

  test('stable startedMs: without a timestamp, use the first time it was seen and never change it', () => {
    const home = makeHome([1]);
    const id = ID(0x77);
    const f = path.join(home, 'sessions', '2026', '09', '20', `rollout-x-${id}.jsonl`);
    fs.writeFileSync(f, line({ type: 'session_meta', payload: { id, cwd: '/w', originator: 'codex_vscode' } }));
    fs.utimesSync(f, new Date(S(100)), new Date(S(100)));
    const p = new CodexProvider({ home, activeWindowMinutes: 60 });
    const first = p.scan(S(110)).find((s) => s.id === id);
    assert.strictEqual(first.startedMs, S(110));
    fs.appendFileSync(f, line(ev(5, 'event_msg', { type: 'task_started', turn_id: 't' })));
    fs.utimesSync(f, new Date(S(200)), new Date(S(200)));
    const again = p.scan(S(210)).find((s) => s.id === id);
    assert.strictEqual(again.startedMs, S(110));
    assert.strictEqual(p.scan(S(220)).find((s) => s.id === ID(1)).startedMs, S(0));
  });

  test('fixed order: two child threads alternate activity, lamps flip back and forth, a third appears midway; children always stay in start-time order', () => {
    const home = path.join(TMP, 'order-home');
    const dir = path.join(home, 'sessions', '2026', '09', '20');
    fs.mkdirSync(dir, { recursive: true });
    const pid = ID(0x100);
    const kids = [ID(0x101), ID(0x102), ID(0x103)];
    const fileFor = (id) => path.join(dir, `rollout-x-${id}.jsonl`);
    const write = (id, lines, sec) => { fs.appendFileSync(fileFor(id), lines.map(line).join('')); fs.utimesSync(fileFor(id), new Date(S(sec)), new Date(S(sec))); };
    const metaLine = (id, sec, parent) => ev(sec, 'session_meta', { id, session_id: parent || id, parent_thread_id: parent, timestamp: iso(sec), cwd: '/w', originator: 'codex_vscode', source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_nickname: id.slice(-3) } } } : 'vscode' });
    write(pid, [metaLine(pid, 0), ev(1, 'event_msg', { type: 'task_started', turn_id: 'm' })], 1);
    write(kids[0], [metaLine(kids[0], 10, pid)], 10);
    write(kids[1], [metaLine(kids[1], 20, pid)], 20);
    const p = new CodexProvider({ home, activeWindowMinutes: 60 });
    const seen = [];
    for (let i = 0; i < 20; i++) {
      const sec = 30 + i * 10;
      const k = kids[i % 2];
      // Alternate: one starts a new turn (Working), the other ends (Done)
      write(k, [ev(sec, 'event_msg', { type: 'task_started', turn_id: 'r' + i }), ev(sec + 1, 'response_item', { type: 'reasoning', summary: [] })], sec + 1);
      write(kids[(i + 1) % 2], [ev(sec + 2, 'event_msg', { type: 'task_complete', turn_id: 'r' + (i - 1), last_agent_message: 'ok' })], sec + 2);
      if (i === 9) write(kids[2], [metaLine(kids[2], sec + 3, pid)], sec + 3);
      const s = p.scan(S(sec + 5)).find((x) => x.key === `codex:${pid}`);
      seen.push(s.agents.map((a) => a.id).join(','));
      const lamps = s.agents.map((a) => a.status.code);
      assert.ok(lamps.includes('thinking') && lamps.includes('done'), 'lamps flip back and forth');
    }
    const early = kids.slice(0, 2).join(',');
    assert.ok(seen.slice(0, 9).every((x) => x === early), seen.join(' | '));
    assert.ok(seen.slice(9).every((x) => x === kids.join(',')), 'new child threads are only appended at the end');
  });
}

// ---------- Optional: read-only smoke test of the local ~/.codex (prints only counts and distributions, never content) ----------

function realSmoke() {
  const want = process.argv.includes('--real') || process.env.AGENT_MONITOR_REAL === '1';
  if (!want) return;
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (!fs.existsSync(path.join(home, 'sessions'))) { console.log('  skip  no local Codex sessions directory'); return; }
  test('smoke: local ~/.codex (read-only, counts and distributions only)', () => {
    const p = new CodexProvider({ home, activeWindowMinutes: 60 * 24 * 365 });
    const t0 = Date.now();
    const sessions = p.scan();
    const cold = Date.now() - t0;
    const t1 = Date.now();
    p.scan();
    const warm = Date.now() - t1;
    const dist = (arr) => arr.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {});
    const agents = sessions.flatMap((s) => s.agents);
    const all = [...sessions.map((s) => s.main), ...agents];
    const details = p.details(sessions.map((s) => s.key));
    const tl = Object.values(details).flatMap((d) => Object.values(d.agents)).flatMap((a) => a.timeline.map((e) => e.kind));
    const q = p.quota();
    console.log('        rollouts', p.files.size, 'sessions', sessions.length, 'child threads', agents.length, `cold start ${cold}ms, rescan ${warm}ms`);
    console.log('        main thread status', JSON.stringify(dist(sessions.map((s) => s.main.status.code))));
    console.log('        child thread status', JSON.stringify(dist(agents.map((a) => a.status.code))), 'kinds', JSON.stringify(dist(agents.map((a) => a.kind))));
    console.log('        entry', JSON.stringify(dist(sessions.map((s) => s.entry))), 'title source', JSON.stringify(dist(sessions.map((s) => s.titleSource))), 'open', sessions.filter((s) => s.live).length);
    console.log('        tool calls', all.reduce((a, x) => a + x.toolCalls, 0), 'tool errors', all.reduce((a, x) => a + x.toolErrors, 0), 'changed files', all.reduce((a, x) => a + x.filesChanged, 0), 'compacted', all.filter((x) => x.lastCompact).length);
    console.log('        priced', all.filter((x) => x.costUsd != null).length, 'unpriced', all.filter((x) => x.costUsd == null).length, 'with compaction threshold', all.filter((x) => x.tokens.compactAt != null).length);
    console.log('        resume hints', JSON.stringify(dist(sessions.flatMap((s) => s.resume.map((r) => r.kind)))), 'timeline kinds', JSON.stringify(dist(tl)));
    console.log('        quota windows', JSON.stringify(q.windows.map((w) => w.label)), 'has plan', !!q.planType);
    for (const s of sessions) {
      assert.ok(s.key.startsWith('codex:') && Number.isFinite(s.startedMs) && Number.isFinite(s.updatedMs));
      for (const a of [s.main, ...s.agents]) assert.ok(a.status && a.status.code && a.tokens && Number.isFinite(a.tokens.contextUsed));
      const agentsSorted = s.agents.map((a) => a.startedMs);
      assert.deepStrictEqual(agentsSorted, [...agentsSorted].sort((a, b) => a - b));
    }
    const again = p.scan();
    assert.deepStrictEqual(again.map((s) => s.startedMs), sessions.map((s) => s.startedMs));
  });
}

// ---------- Run ----------

console.log('codex provider');
try {
  parseTests();
  scanTests();
  statusTests();
  incrementalTests();
  realSmoke();
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
