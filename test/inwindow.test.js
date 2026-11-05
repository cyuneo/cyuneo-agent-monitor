'use strict';
// Tests for auto-resume in the original window (0.11.0, docs/DESIGN.md §12.8): lib/core/inwindow.js and lib/inwindow.js.
// Plain node: node test/inwindow.test.js. The registry, transcripts and the helper are synthetic: ~/.claude is never
// read, no process is started (the helper is a fake runChild) and no cross-session message is sent. Files go under
// AGENT_MONITOR_TEST_TMP (system temp dir if unset) and are removed afterwards.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const childProcess = require('child_process');
childProcess.spawn = () => { throw new Error('tests never spawn processes'); };
childProcess.execFile = () => { throw new Error('tests never spawn processes'); };

const core = require('../lib/core/inwindow');
const { createInWindow } = require('../lib/inwindow');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-inwindow-'));

const results = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
async function runAll() {
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
}

const SID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const NONCE = '0123456789abcdef0123456789abcdef';
const fakeRandom = () => Buffer.from(NONCE, 'hex');

const entry = (o = {}) => ({
  entry: core.registryEntry(`/h/sessions/${o.pid || 100}.json`, {
    sessionId: SID, pid: 100, name: 'my-chat', nameSince: '1', procStart: '555', status: 'idle', entrypoint: 'claude-vscode', ...o,
  }),
  facts: { alive: true, procStartNow: '555', ...(o.facts || {}) },
});
const LINUX = { platform: 'linux', now: NOW };

// ---------- core: targeting (a–d, f) ----------

test('targeting: one idle live entry with a unique name → target', () => {
  const r = core.pickTarget([entry()], SID, LINUX);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.target.name, 'my-chat');
});

test('targeting a: missing → notOpen (not open anywhere); two entries for the chat → ambiguous', () => {
  assert.deepStrictEqual(core.pickTarget([entry({ sessionId: OTHER })], SID, LINUX), { ok: false, reason: 'notOpen', open: false });
  assert.strictEqual(core.pickTarget([entry(), entry({ pid: 101, name: 'b' })], SID, LINUX).reason, 'ambiguous');
});

test('targeting b: dead pid → notOpen; pid reuse (starttime differs) → notOpen; no procStart on Linux → unguarded', () => {
  assert.strictEqual(core.pickTarget([entry({ facts: { alive: false } })], SID, LINUX).reason, 'notOpen');
  assert.strictEqual(core.pickTarget([entry({ facts: { procStartNow: '999' } })], SID, LINUX).reason, 'notOpen');
  assert.strictEqual(core.pickTarget([entry({ procStart: '' })], SID, LINUX).reason, 'unguarded');
});

test('targeting b (not Linux): stale statusUpdatedAt → stale; fresh → ok', () => {
  const o = { platform: 'darwin', now: NOW, stopSinceMs: NOW - 60e3 };
  assert.strictEqual(core.pickTarget([entry({ statusUpdatedAt: NOW - 3 * 3600e3 })], SID, o).reason, 'stale');
  assert.strictEqual(core.pickTarget([entry({ statusUpdatedAt: NOW - 30e3 })], SID, o).ok, true);
});

test('targeting c: busy / waiting → busy (never interrupted); unknown status → unknownStatus', () => {
  assert.strictEqual(core.pickTarget([entry({ status: 'busy' })], SID, LINUX).reason, 'busy');
  assert.strictEqual(core.pickTarget([entry({ status: 'waiting' })], SID, LINUX).reason, 'busy');
  assert.strictEqual(core.pickTarget([entry({ status: 'x' })], SID, LINUX).reason, 'unknownStatus');
});

test('targeting d: no name, unsafe name, duplicate name in another live entry → not sent', () => {
  assert.strictEqual(core.pickTarget([entry({ name: '' })], SID, LINUX).reason, 'noName');
  assert.strictEqual(core.pickTarget([entry({ name: 'a "b"' })], SID, LINUX).reason, 'badName');
  assert.strictEqual(core.pickTarget([entry(), entry({ pid: 7, sessionId: OTHER })], SID, LINUX).reason, 'dupName');
  // a dead entry with the same name does not count
  assert.strictEqual(core.pickTarget([entry(), entry({ pid: 7, sessionId: OTHER, facts: { alive: false } })], SID, LINUX).ok, true);
});

test('targeting f: name / nameSince / pid changed mid-send → not the same target', () => {
  const t = entry().entry;
  assert.ok(core.sameTarget(t, { ...t }));
  assert.ok(!core.sameTarget(t, { ...t, name: 'other' }));
  assert.ok(!core.sameTarget(t, { ...t, nameSince: '2' }));
  assert.ok(!core.sameTarget(t, { ...t, pid: 5 }));
  assert.ok(!core.sameTarget(t, null));
});

test('registry files: only <digits>.json; *.key and others never', () => {
  assert.ok(core.isRegistryFile('123.json'));
  for (const n of ['123.abc.key', 'roster.json', 'control.key', '123.json.key', '../1.json']) assert.ok(!core.isRegistryFile(n), n);
});

// ---------- core: message, marker, transcripts ----------

test('message: Chinese first line with the marker and the account, then the prompt; bad nonce → null', () => {
  const m = core.buildMessage({ nonce: NONCE, trigger: 'limit', account: '#3', prompt: 'go on\nplease' });
  assert.strictEqual(m.firstLine, `[Agent Monitor 续跑 ${NONCE}] 额度已恢复（已切换到 #3），请继续刚才因额度用完而中断的任务。`);
  assert.strictEqual(m.text, `${m.firstLine}\ngo on please`);
  assert.ok(!core.buildMessage({ nonce: NONCE, trigger: 'limit', account: 'me@x.com' }).text.includes('@'));
  assert.strictEqual(core.buildMessage({ nonce: 'abc' }), null);
  assert.strictEqual(core.makeNonce(fakeRandom), NONCE);
});

test('transcript marker: exact line in a user entry (wrapper allowed); partial / base64-like text does not count', () => {
  const m = core.buildMessage({ nonce: NONCE, trigger: 'error' });
  const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  assert.ok(core.transcriptHasMarker(user(`<cross-session-message from="x">${m.firstLine}</cross-session-message>`), m));
  assert.ok(core.transcriptHasMarker(`partial"}\n${user(m.text)}\n`, m));
  assert.ok(!core.transcriptHasMarker(user(`xx${NONCE}yy`), m));
  assert.ok(!core.transcriptHasMarker(JSON.stringify({ type: 'assistant', message: { content: m.firstLine } }), m));
});

test('permission mode from the transcript: latest wins, default → manual, unknown → auto', () => {
  const l = (m) => JSON.stringify({ type: 'user', permissionMode: m });
  assert.strictEqual(core.permissionModeOf(`${l('plan')}\n${l('acceptEdits')}`), 'acceptEdits');
  assert.strictEqual(core.permissionModeOf(l('default')), 'manual');
  assert.strictEqual(core.permissionModeOf(l('weird')), 'auto');
  assert.strictEqual(core.permissionModeOf(''), 'auto');
});

// ---------- core: helper ----------

test('helper argv: haiku, low effort, only ListAgents + SendMessage, hooks and ultracode off, max 4 turns, prompt last', () => {
  const a = core.helperArgs({ name: 'my-chat', text: 'hello', permissionMode: 'plan' });
  const val = (f) => a[a.indexOf(f) + 1];
  assert.strictEqual(a[0], '-p');
  assert.strictEqual(val('--tools'), 'ListAgents,SendMessage');
  assert.strictEqual(val('--allowedTools'), 'ListAgents,SendMessage');
  assert.strictEqual(val('--model'), 'haiku');
  assert.strictEqual(val('--effort'), 'low');
  assert.strictEqual(val('--max-turns'), '4');
  assert.strictEqual(val('--output-format'), 'json');
  assert.strictEqual(val('--permission-mode'), 'plan');
  assert.deepStrictEqual(JSON.parse(val('--settings')), { disableAllHooks: true, ultracode: false });
  assert.ok(a.includes('--no-session-persistence'));
  assert.ok(!a.join(' ').includes('ToolSearch'));
  assert.ok(a[a.length - 1].includes('BEGIN-MESSAGE\nhello\nEND-MESSAGE'));
  assert.strictEqual(core.helperArgs({ name: 'bad name', text: 'x' }), null);
});

test('helper result: SENT, FAIL, delivery notice, NOTOOLS, timeout, bad JSON, non-zero exit, denials', () => {
  const ok = (result, extra = {}) => ({ kind: 'exit', code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', result, ...extra }) });
  assert.strictEqual(core.parseHelperResult(ok('SENT')).status, 'sent');
  assert.strictEqual(core.parseHelperResult(ok('**SENT.**')).status, 'sent');
  assert.strictEqual(core.parseHelperResult(ok('FAIL')).status, 'fail');
  assert.strictEqual(core.parseHelperResult(ok('[Cross-session delivery notice] held for approval\nSENT')).status, 'notice');
  assert.strictEqual(core.parseHelperResult(ok('NOTOOLS')).status, 'notools');
  assert.strictEqual(core.parseHelperResult(ok('SENT', { permission_denials: [{}] })).status, 'denied');
  assert.strictEqual(core.parseHelperResult(ok('NOTARGET')).status, 'notarget');
  assert.strictEqual(core.parseHelperResult(ok('x', { is_error: true, subtype: 'error_max_turns' })).status, 'error');
  for (const s of ['fail', 'error', 'exit', 'timeout', 'bad', 'notice']) assert.strictEqual(core.mayHaveSent(s), true, s);
  for (const s of ['spawn', 'notools', 'notarget', 'denied']) assert.strictEqual(core.mayHaveSent(s), false, s);
  assert.strictEqual(core.parseHelperResult({ kind: 'timeout' }).status, 'timeout');
  assert.strictEqual(core.parseHelperResult({ kind: 'exit', code: 0, stdout: 'not json' }).status, 'bad');
  assert.strictEqual(core.parseHelperResult({ kind: 'exit', code: 1, stdout: '' }).status, 'exit');
  assert.strictEqual(core.parseHelperResult(ok('hmm')).status, 'bad');
});

test('fallback order: not open → bg; sent but unverified → wait; VS Code chat in this window → prefill; else bg', () => {
  assert.strictEqual(core.fallbackStep({ open: false, sent: true }), 'bg');
  assert.strictEqual(core.fallbackStep({ open: true, sent: true, vscodeEntry: true, ownedHere: true, canPrefill: true }), 'wait');
  assert.strictEqual(core.fallbackStep({ open: true, vscodeEntry: true, ownedHere: true, canPrefill: true }), 'prefill');
  assert.strictEqual(core.fallbackStep({ open: true, vscodeEntry: true, ownedHere: false, canPrefill: true }), 'bg');
  assert.strictEqual(core.fallbackStep({ open: true, vscodeEntry: false, ownedHere: true, canPrefill: true }), 'bg');
});

// ---------- lib: send() end to end with a fake helper ----------

let caseN = 0;
function world(o = {}) {
  const root = path.join(TMP, `w${caseN++}`);
  const home = path.join(root, 'claude');
  const sessions = path.join(home, 'sessions');
  const projects = path.join(home, 'projects');
  const proj = path.join(projects, '-p');
  const cwd = path.join(root, 'cwd');
  for (const d of [sessions, proj, cwd, path.join(home, 'daemon')]) fs.mkdirSync(d, { recursive: true });
  const reg = (pid, j) => fs.writeFileSync(path.join(sessions, `${pid}.json`), JSON.stringify(j));
  reg(100, { sessionId: SID, pid: 100, name: 'my-chat', nameSince: '1', status: 'idle', entrypoint: 'claude-vscode', statusUpdatedAt: NOW, ...(o.reg || {}) });
  fs.writeFileSync(path.join(sessions, '100.abcdef.key'), 'SECRET');
  fs.writeFileSync(path.join(home, 'daemon', 'control.key'), 'SECRET');
  fs.writeFileSync(path.join(home, 'daemon', 'roster.json'), '{}');
  const transcript = path.join(proj, `${SID}.jsonl`);
  const otherT = path.join(proj, `${OTHER}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', permissionMode: 'acceptEdits', message: { content: 'hi' } })}\n`);
  fs.writeFileSync(otherT, '');
  const opened = [];
  const guard = (p) => {
    const s = String(p);
    opened.push(s);
    if (s.endsWith('.key') || s.includes(`${path.sep}daemon`)) throw new Error(`opened a secret: ${s}`);
  };
  const fsx = new Proxy(fs, {
    get(t, k) {
      const f = t[k];
      if (typeof f !== 'function' || !/^(readFileSync|openSync|statSync|existsSync|readdirSync|readlinkSync)$/.test(k)) return f;
      return (...a) => { guard(a[0]); return f.apply(t, a); };
    },
  });
  let now = NOW;
  const calls = [];
  const logs = [];
  const iw = createInWindow({
    fs: fsx, platform: 'darwin', now: () => now, sleep: async (ms) => { now += ms; if (o.onSleep) o.onSleep(); },
    runChild: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const prompt = args[args.length - 1];
      const text = prompt.slice(prompt.indexOf('BEGIN-MESSAGE\n') + 14, prompt.lastIndexOf('\nEND-MESSAGE'));
      const line = JSON.stringify({ type: 'user', message: { role: 'user', content: `<cross-session-message from="h">${text}</cross-session-message>` } });
      if (o.deliverTo === 'own') fs.appendFileSync(transcript, `${line}\n`);
      if (o.deliverTo === 'other') fs.appendFileSync(otherT, `${line}\n`);
      if (o.renameDuring) reg(100, { sessionId: SID, pid: 100, name: 'renamed', nameSince: '2', status: 'idle', statusUpdatedAt: NOW });
      if (o.helperLeftover) reg(4242, { sessionId: 'x', pid: 4242 });
      const answer = o.answer || 'SENT';
      return answer === 'timeout' ? { kind: 'timeout', pid: 4242, stdout: '', stderr: '' }
        : { kind: 'exit', code: 0, pid: 4242, stdout: JSON.stringify({ subtype: 'success', result: answer }), stderr: '' };
    },
    cli: () => ({ path: '/fake/claude' }), claudeHome: () => home, projectsDir: () => projects, storageDir: () => root,
    randomBytes: fakeRandom, isAlive: (pid) => pid === 100 || (o.extraAlive || []).includes(pid), log: (l) => logs.push(l),
  });
  const session = { id: SID, transcript, cwd };
  return { iw, session, calls, logs, opened, sessions, reg };
}

test('send: delivered and verified → messaged; helper argv/cwd; the *.key and daemon files are never opened', async () => {
  const w = world({ deliverTo: 'own' });
  const r = await w.iw.send(w.session, { trigger: 'limit', account: '#2', stopSinceMs: NOW - 60e3 });
  assert.deepStrictEqual(r, { result: 'messaged' });
  assert.strictEqual(w.calls.length, 1);
  assert.strictEqual(w.calls[0].opts.cwd, w.session.cwd);
  // tool search off: SendMessage is otherwise deferred behind ToolSearch, which the helper does not have
  assert.deepStrictEqual(w.calls[0].opts.env, { ENABLE_TOOL_SEARCH: 'false' });
  const a = w.calls[0].args;
  assert.strictEqual(a[a.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(a[a.length - 1].includes('已切换到 #2'));
  assert.ok(w.opened.length > 0 && !w.opened.some((p) => p.endsWith('.key') || p.includes('daemon')));
});

test('send: busy → busy, nothing run; not open → notOpen; duplicate name → unsendable', async () => {
  let w = world({ reg: { status: 'busy' } });
  assert.deepStrictEqual(await w.iw.send(w.session, {}), { result: 'busy' });
  assert.strictEqual(w.calls.length, 0);
  w = world({ reg: { sessionId: OTHER } });
  assert.deepStrictEqual(await w.iw.send(w.session, {}), { result: 'notOpen' });
  w = world({ extraAlive: [200] });
  fs.writeFileSync(path.join(w.sessions, '200.json'), JSON.stringify({ sessionId: OTHER, pid: 200, name: 'my-chat', statusUpdatedAt: NOW }));
  const dup = await w.iw.send(w.session, {});
  assert.strictEqual(dup.result, 'unsendable');
  assert.strictEqual(dup.reason, 'dupName');
  assert.strictEqual(w.calls.length, 0);
});

test('send: NOTARGET → unsendable; FAIL may have sent → unverified, no copy yet; marker never arrives → unverified', async () => {
  let w = world({ answer: 'NOTARGET' });
  const r1 = await w.iw.send(w.session, {});
  assert.strictEqual(r1.result, 'unsendable');
  assert.strictEqual(r1.reason, 'helper:notarget');
  w = world({ answer: 'FAIL' });
  const r0 = await w.iw.send(w.session, {});
  assert.strictEqual(r0.result, 'unverified');
  assert.strictEqual(r0.reason, 'fail');
  w = world({ answer: 'SENT' });
  const r2 = await w.iw.send(w.session, {});
  assert.strictEqual(r2.result, 'unverified');
  assert.strictEqual(r2.reason, 'noMarker');
});

test('send: marker in another transcript → misdelivered', async () => {
  const w = world({ deliverTo: 'other' });
  const r = await w.iw.send(w.session, {});
  assert.strictEqual(r.result, 'misdelivered');
  assert.strictEqual(path.basename(r.files[0]), `${OTHER}.jsonl`);
});

test('send: the registry name changed during the send → unverified (registryChanged)', async () => {
  const w = world({ deliverTo: 'own', renameDuring: true });
  const r = await w.iw.send(w.session, {});
  assert.strictEqual(r.result, 'unverified');
  assert.strictEqual(r.reason, 'registryChanged');
});

test('send: helper timeout → checked like a send, never delivered', async () => {
  const w = world({ answer: 'timeout', deliverTo: 'own' });
  const r = await w.iw.send(w.session, {});
  assert.strictEqual(r.result, 'unverified');
  assert.strictEqual(r.reason, 'timeout');
});

test('helper registry file: gone → nothing logged; left over → logged, never deleted; no other file looked at', async () => {
  let w = world({ deliverTo: 'own' });
  await w.iw.send(w.session, {});
  assert.ok(!w.logs.some((l) => l.includes('still there')));
  w = world({ deliverTo: 'own', helperLeftover: true });
  await w.iw.send(w.session, {});
  assert.ok(w.logs.some((l) => l.includes('4242.json is still there')));
  assert.ok(fs.existsSync(path.join(w.sessions, '4242.json')));
  const w2 = world();
  fs.writeFileSync(path.join(w2.sessions, '77.json'), '{}');
  let n = 0;
  const done = await w2.iw.helperGone(77).then((v) => { n++; return v; });
  assert.strictEqual(done, false);
  assert.strictEqual(n, 1);
});

test('waitForPrompt: a new user entry → prompt; nothing → timeout; chat moved on → movedOn', async () => {
  const w = world();
  const from = w.iw.sizeOf(w.session.transcript);
  fs.appendFileSync(w.session.transcript, `${JSON.stringify({ type: 'user', message: { content: 'continue' } })}\n`);
  assert.strictEqual(await w.iw.waitForPrompt(w.session, { fromSize: from, timeoutMs: 60e3 }), 'prompt');
  const w2 = world();
  assert.strictEqual(await w2.iw.waitForPrompt(w2.session, { timeoutMs: 60e3 }), 'timeout');
  assert.strictEqual(await w2.iw.waitForPrompt(w2.session, { timeoutMs: 60e3, stillStopped: () => false }), 'movedOn');
});

runAll().then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
});
