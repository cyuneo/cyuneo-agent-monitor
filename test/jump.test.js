'use strict';
// Tests for lib/jump.js ("Go to agent"). Plain node: node test/jump.test.js
// - All process lists, command outputs and sessions are synthetic: execFile, readlink, readdir and the vscode API are fakes,
//   so no process is ever listed or run and nothing is read from ~/.claude or ~/.codex.
// - The cross-window round trip uses two real lib/shared-scan.js coordinators on real timers (fs.watch off, short heartbeat)
//   over a temp directory under AGENT_MONITOR_TEST_TMP (falls back to the system temp directory), deleted after the run.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const J = require('../lib/jump');
const { createSharedScan } = require('../lib/shared-scan');
const { createI18n } = require('../lib/i18n');

const I = J._internal;
const { REASON, ACTION } = J;
const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-jump-'));

const NOW = 1_800_000_000_000;
const HOUR = 3600e3;
const UUID = '11111111-1111-4111-8111-111111111111';
const CODEX_ID = '0c0de000-0000-4000-8000-000000000001';
const CODE = '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility';
const PTY = '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper --type=utility ptyHost';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (a) => a[a.length - 1];
const proc = (pid, ppid, cmd, o = {}) => ({ pid, ppid, startMs: NOW - HOUR, tty: null, cmd, ...o });

// A fake execFile: answers(cmd, args, opts) -> { out } | { err } ; records every call
function fakeExec(answers) {
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    const a = answers(cmd, args, opts) || { out: '' };
    setImmediate(() => (a.err ? cb(a.err, a.out || '', a.stderr || '') : cb(null, a.out, '')));
  };
  fn.calls = calls;
  return fn;
}

// A synthetic JumpEnv: processes, windows and helpers as given
function env(o = {}) {
  let lists = 0;
  const e = {
    platform: o.platform || 'darwin',
    now: NOW,
    processes: async () => { lists++; return o.procs || []; },
    processCwds: async () => o.cwds === undefined ? new Map() : o.cwds,
    fileHolders: async (file, pids) => (o.holders ? new Set(pids.filter((p) => o.holders.has(p))) : null),
    claudeLive: (id) => (o.live || {})[id] || null,
    local: { hostPid: 100, terminals: [], folders: ['/w/here'], ...(o.local || {}) },
    windows: o.windows || [],
  };
  Object.defineProperty(e, 'lists', { get: () => lists });
  return e;
}
const PEER = { id: 'peer', hostPid: 200, terminals: [210], folders: ['/w/peer'], storageDir: '/u/workspaceStorage/p1', workspaceFile: null, empty: false };

// A fake vscode for createJumper / raiseWindow
function fakeVscode(o = {}) {
  const executed = [];
  const commands = new Set(o.commands || []);
  const vscode = {
    executed,
    commands: {
      getCommands: async () => [...commands],
      executeCommand: async (id, ...args) => { executed.push([id, ...args]); },
    },
    window: { terminals: o.terminals || [] },
    extensions: { getExtension: (id) => ((o.extensions || []).includes(id) ? { id } : undefined) },
    Uri: { from: (c) => ({ ...c, toString: () => `${c.scheme}://${c.authority}${c.path}` }) },
    env: { appRoot: o.appRoot, appName: 'Visual Studio Code' },
    workspace: { workspaceFolders: o.folders, workspaceFile: o.workspaceFile },
  };
  vscode.addCommand = (id) => commands.add(id);
  return vscode;
}
const terminal = (pid) => { const t = { processId: Promise.resolve(pid), shown: [], show(p) { t.shown.push(p); } }; return t; };
const fileUri = (p) => ({ scheme: 'file', fsPath: p });

// ---------- Process listing ----------

test('parsePs: pid, ppid, start time from etime ([[dd-]hh:]mm:ss), tty with /dev/ (none for ?? / ?), the command with its spaces; junk lines skipped', () => {
  const out = [
    '    1     0 12-03:04:05 ??       /sbin/launchd',
    '  501     1    01:02:03 ttys003  /bin/zsh -il',
    '  777   501       00:07 pts/2    node /usr/lib/node_modules/@openai/codex/bin/codex.js --model "gpt 5"',
    '  778   777       00:05 ?',
    'garbage line',
    '',
  ].join('\n');
  const ps = I.parsePs(out, NOW);
  assert.deepStrictEqual(ps.map((p) => [p.pid, p.ppid, p.tty]), [[1, 0, null], [501, 1, '/dev/ttys003'], [777, 501, '/dev/pts/2'], [778, 777, null]]);
  assert.strictEqual(ps[0].startMs, NOW - (12 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000);
  assert.strictEqual(ps[1].startMs, NOW - 3723e3);
  assert.strictEqual(ps[2].cmd, 'node /usr/lib/node_modules/@openai/codex/bin/codex.js --model "gpt 5"');
  assert.strictEqual(ps[3].cmd, '');
  assert.strictEqual(I.parseEtime('bad'), null);
  assert.strictEqual(I.parseEtime('1-00:00:01'), 86401);
});

test('parseCim: the compact shape and plain Win32_Process fields, an array or one object; /Date(ms)/, ISO and epoch dates; a BOM or bad JSON is fine', () => {
  const compact = JSON.stringify([{ p: 4, pp: 0, t: NOW - 5000, c: 'System' }, { p: 900, pp: 4, t: null, c: '"C:\\Program Files\\x\\codex.exe" --yolo' }, { p: -1, pp: 0 }]);
  assert.deepStrictEqual(I.parseCim(compact).map((p) => [p.pid, p.ppid, p.startMs, p.cmd]),
    [[4, 0, NOW - 5000, 'System'], [900, 4, null, '"C:\\Program Files\\x\\codex.exe" --yolo']]);
  const raw = '\uFEFF' + JSON.stringify({ ProcessId: 12, ParentProcessId: 4, CreationDate: `/Date(${NOW})/`, CommandLine: null, Name: 'pwsh.exe' });
  assert.deepStrictEqual(I.parseCim(raw), [{ pid: 12, ppid: 4, startMs: NOW, tty: null, cmd: 'pwsh.exe' }]);
  assert.strictEqual(I.cimDate('2027-01-15T08:00:00.000+00:00'), Date.parse('2027-01-15T08:00:00Z'));
  assert.strictEqual(I.cimDate({ value: `/Date(${NOW})/` }), NOW);
  assert.deepStrictEqual(I.parseCim('not json'), []);
  assert.deepStrictEqual(I.parseCim(''), []);
});

test('listProcesses: macOS runs /bin/ps once (pid, ppid, etime, tty, full args) with a timeout; Linux ps by its full path; Windows one PowerShell -EncodedCommand call by its full path; a failure rejects', async () => {
  const mac = fakeExec(() => ({ out: '  1  0 01:00 ?? /sbin/launchd\n' }));
  const ps = await J.listProcesses({ platform: 'darwin', execFile: mac, now: () => NOW });
  assert.deepStrictEqual(mac.calls.map((c) => [c.cmd, c.args]), [['/bin/ps', ['-A', '-ww', '-o', 'pid=,ppid=,etime=,tty=,args=']]]);
  assert.ok(mac.calls[0].opts.timeout > 0);
  assert.strictEqual(ps[0].startMs, NOW - 60e3);
  const lin = fakeExec(() => ({ out: '' }));
  await J.listProcesses({ platform: 'linux', execFile: lin, exists: (p) => p === '/usr/bin/ps' });
  assert.strictEqual(lin.calls[0].cmd, '/usr/bin/ps');
  await J.listProcesses({ platform: 'linux', execFile: lin, exists: () => false });
  assert.strictEqual(lin.calls[1].cmd, 'ps', 'neither /bin/ps nor /usr/bin/ps: from PATH');
  const win = fakeExec(() => ({ out: JSON.stringify([{ p: 8, pp: 4, t: 1, c: 'x' }]) }));
  const wp = await J.listProcesses({ platform: 'win32', execFile: win, env: { SystemRoot: 'D:\\Win' } });
  const args = win.calls[0].args;
  assert.strictEqual(win.calls[0].cmd, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'never a bare name (the working directory would be searched first)');
  assert.ok(win.calls[0].opts.timeout > 0);
  assert.deepStrictEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  assert.strictEqual(Buffer.from(args[5], 'base64').toString('utf16le'), I.CIM_SCRIPT);
  assert.ok(I.CIM_SCRIPT.includes('$ProgressPreference = "SilentlyContinue"'), 'no progress records on stderr');
  assert.deepStrictEqual(wp.map((p) => p.pid), [8]);
  assert.strictEqual(I.powershellPath({}), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const bad = fakeExec(() => ({ err: Object.assign(new Error('timed out'), { killed: true }) }));
  await assert.rejects(J.listProcesses({ platform: 'darwin', execFile: bad }), /timed out/);
});

test('command errors are short: the program, what happened and stderr, never the whole command line (the base64 script, every AppleScript line)', async () => {
  const long = 'Command failed: powershell.exe -NoProfile -EncodedCommand ' + 'A'.repeat(4000);
  const e1 = I.shortError('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', Object.assign(new Error(long), { code: 1 }), 'Get-CimInstance : Access denied\r\n  at line 3\r\n');
  assert.strictEqual(e1.message, 'powershell.exe exited with 1: Get-CimInstance : Access denied at line 3');
  assert.strictEqual(e1.code, 1);
  assert.strictEqual(I.shortError('/bin/ps', Object.assign(new Error(long), { killed: true, signal: 'SIGTERM' }), '').message, 'ps timed out');
  assert.strictEqual(I.shortError('/usr/bin/osascript', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '').message, 'osascript not found');
  assert.ok(I.shortError('x', Object.assign(new Error('e'), { code: 2 }), 'y'.repeat(1000)).message.length < 340, 'stderr is capped');
  // osascript failing for another reason than -1743: a short FAILED error
  const exec = fakeExec(() => ({ err: Object.assign(new Error('Command failed: /usr/bin/osascript -e ' + I.TERMINAL_APP_SCRIPT.join(' -e ')), { code: 1 }), stderr: '0:12: execution error: Terminal got an error: AppleEvent timed out. (-1712)' }));
  const j = J.createJumper({ vscode: fakeVscode(), platform: 'darwin', execFile: exec, confirmAutomation: async () => true });
  await assert.rejects(j.perform({ kind: 'externalTerminal', app: 'terminalApp', tty: '/dev/ttys002' }), (err) => err.message === 'osascript exited with 1: 0:12: execution error: Terminal got an error: AppleEvent timed out. (-1712)');
});

test('processCwds / fileHolders: macOS one lsof call (exit 1 = none), Linux /proc, Windows null; only the given pids count', async () => {
  const lsof = fakeExec((cmd, args) => (args.includes('cwd') ? { out: 'p10\nfcwd\nn/w/a\np11\nfcwd\nn/w/b dir\n', err: Object.assign(new Error('x'), { code: 1 }) } : null));
  const cwds = await J.processCwds([10, 11, 10, -3, 'x'], { platform: 'darwin', execFile: lsof });
  assert.deepStrictEqual([...cwds], [[10, '/w/a'], [11, '/w/b dir']]);
  assert.deepStrictEqual(lsof.calls[0].args, ['-a', '-d', 'cwd', '-Fn', '-p', '10,11']);
  assert.ok(lsof.calls[0].opts.timeout > 0 && lsof.calls[0].cmd === '/usr/sbin/lsof');
  assert.strictEqual(await J.processCwds([10], { platform: 'win32' }), null);
  const linux = await J.processCwds([5, 6], { platform: 'linux', readlink: (p) => { if (p === '/proc/5/cwd') return '/w/l'; throw new Error('gone'); } });
  assert.deepStrictEqual([...linux], [[5, '/w/l']]);

  const holders = fakeExec(() => ({ out: '42\n77\n99\n' }));
  const held = await J.fileHolders('/h/.codex/sessions/r.jsonl', [42, 99], { platform: 'darwin', execFile: holders });
  assert.deepStrictEqual([...held].sort(), [42, 99]);
  assert.deepStrictEqual(holders.calls[0].args, ['-t', '--', '/h/.codex/sessions/r.jsonl']);
  assert.ok(holders.calls[0].opts.timeout > 0);
  const none = fakeExec(() => ({ out: '', err: Object.assign(new Error('exit 1'), { code: 1 }) }));
  assert.deepStrictEqual([...await J.fileHolders('/f', [1], { platform: 'darwin', execFile: none })], []);
  const fds = { '/proc/7/fd': ['0', '1', '9'], '/proc/8/fd': ['0'] };
  const links = { '/proc/7/fd/9': '/f', '/proc/7/fd/0': '/dev/pts/1', '/proc/8/fd/0': '/dev/null' };
  const lh = await J.fileHolders('/f', [7, 8], { platform: 'linux', readdir: (d) => fds[d] || [], readlink: (l) => links[l] || '' });
  assert.deepStrictEqual([...lh], [7]);
  assert.strictEqual(await J.fileHolders('/f', [7], { platform: 'win32' }), null);
  assert.strictEqual(await J.fileHolders('relative/f', [7], { platform: 'darwin', execFile: none }), null);
});

// ---------- Process tree ----------

test('ancestry: the process and its parents up to pid 0; stops at a cycle, a missing pid, or a "parent" that started after its child (pid reuse)', () => {
  const by = I.indexProcs([proc(1, 0, 'init'), proc(10, 1, 'a'), proc(20, 10, 'b'), proc(30, 20, 'c')]);
  assert.deepStrictEqual(I.ancestry(30, by), [30, 20, 10, 1]);
  assert.deepStrictEqual(I.ancestry(99, by), []);
  const cyc = I.indexProcs([proc(5, 6, 'x'), proc(6, 5, 'y')]);
  assert.deepStrictEqual(I.ancestry(5, cyc), [5, 6]);
  const reused = I.indexProcs([proc(1, 0, 'init'), proc(40, 1, 'new owner of a reused pid', { startMs: NOW - 60e3 }), proc(41, 40, 'child', { startMs: NOW - HOUR })]);
  assert.deepStrictEqual(I.ancestry(41, reused), [41]);
});

test('placesOf / findOwner: this window\'s places come first (a stale record of another window loses); the nearest ancestor wins; kind filters', () => {
  const places = I.placesOf({ hostPid: 100, terminals: [110] }, [{ id: 'w2', hostPid: 200, terminals: [110, 210], folders: ['/w2'] }, { id: '', hostPid: 300 }]);
  assert.deepStrictEqual(places.map((p) => [p.pid, p.kind, p.window && p.window.id]), [[100, 'host', null], [110, 'terminal', null], [200, 'host', 'w2'], [110, 'terminal', 'w2'], [210, 'terminal', 'w2']]);
  assert.strictEqual(I.findOwner([7, 110, 100], places).window, null);
  assert.deepStrictEqual(I.findOwner([7, 210, 200], places, 'host'), { pid: 200, kind: 'host', window: { id: 'w2', folders: ['/w2'] }, depth: 2 });
  assert.strictEqual(I.findOwner([7, 210, 200], places, 'terminal').pid, 210);
  assert.strictEqual(I.findOwner([7, 8], places), null);
});

// ---------- Finding CLI processes ----------

test('isAgentProcess: Codex CLI (binary, npm script, quoted Windows path); not editor-bundled binaries, codex app-server, CodexBar or other programs', () => {
  const yes = (tool, cmd) => assert.ok(I.isAgentProcess(tool, cmd), `${tool}: ${cmd}`);
  const no = (tool, cmd) => assert.ok(!I.isAgentProcess(tool, cmd), `not ${tool}: ${cmd}`);
  yes('codex', '/opt/homebrew/bin/codex --full-auto');
  yes('codex', 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js');
  yes('codex', '/usr/local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex-aarch64-apple-darwin');
  yes('codex', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a b\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"');
  no('codex', '/Users/x/.vscode/extensions/openai.chatgpt-26.1.0/bin/macos-aarch64/codex app-server --analytics-default-enabled');
  no('codex', '/opt/homebrew/bin/codex app-server');
  no('codex', '/Applications/CodexBar.app/Contents/MacOS/CodexBar');
  no('codex', 'vim codex.md');
  yes('codex', 'node --no-warnings /opt/homebrew/bin/codex');
  no('codex', 'node /x/my-codex.js');
  no('aider', '/bin/aider');
  assert.ok(I.isCodexAppServer('/Users/x/.vscode/extensions/openai.chatgpt-26.1.0/bin/macos-aarch64/codex app-server'));
  assert.ok(!I.isCodexAppServer('/opt/homebrew/bin/codex'));
  assert.deepStrictEqual(I.splitCommand('"a b" c  "" d'), ['a b', 'c', '', 'd']);
});

test('agentCandidates / pickAgentProcess: the launcher counts once; the session folder filters; the newest one already running when the session last wrote wins, with the count', () => {
  const procs = [
    proc(10, 1, 'node /x/node_modules/@openai/codex/bin/codex.js', { startMs: NOW - 3 * HOUR }),
    proc(11, 10, '/x/node_modules/@openai/codex/vendor/codex/codex', { startMs: NOW - 3 * HOUR }),
    proc(20, 1, '/opt/homebrew/bin/codex', { startMs: NOW - 2 * HOUR }),
    proc(30, 1, '/opt/homebrew/bin/codex', { startMs: NOW - 10e3 }),
  ];
  const cands = I.agentCandidates(procs, 'codex');
  assert.deepStrictEqual(cands.map((p) => p.pid), [10, 20, 30]);
  const cwds = new Map([[10, '/w/a'], [20, '/w/b'], [30, '/w/b']]);
  assert.deepStrictEqual(I.pickAgentProcess(cands, { cwd: '/w/b', cwds, updatedMs: NOW - HOUR, platform: 'linux' }), { pid: 20, count: 2 }, '30 started after the last write');
  assert.deepStrictEqual(I.pickAgentProcess(cands, { cwd: '/w/b', cwds, updatedMs: NOW, platform: 'linux' }), { pid: 30, count: 2 });
  assert.deepStrictEqual(I.pickAgentProcess(cands, { cwd: '/W/A/', cwds, platform: 'darwin' }), { pid: 10, count: 1 }, 'case-insensitive on macOS');
  assert.strictEqual(I.pickAgentProcess(cands, { cwd: '/w/none', cwds, platform: 'linux' }), null);
  assert.deepStrictEqual(I.pickAgentProcess(cands, { cwd: '/w/a', cwds: null }), { pid: 30, count: 3 }, 'no working directories (Windows): the newest');
});

// ---------- Resolvers ----------

test('resolverFor / worthTrying: one resolver per target; live-certain targets need a live session, the others a recent one; unsupported ones are never offered', () => {
  const r = (s) => J.resolverFor(s).id;
  assert.strictEqual(r({ provider: 'claude', entry: 'vscode', entrypoint: null }), 'claudeVscode');
  assert.strictEqual(r({ provider: 'claude', entry: 'cli', entrypoint: 'claude-vscode' }), 'claudeVscode', 'the live registry entrypoint wins');
  assert.strictEqual(r({ provider: 'claude', entry: 'desktop' }), 'claudeDesktop');
  assert.strictEqual(r({ provider: 'claude', entry: 'cli', entrypoint: 'cli' }), 'claudeCli');
  assert.strictEqual(r({ provider: 'claude', entry: 'sdk', entrypoint: 'sdk-ts' }), 'claudeCli');
  assert.strictEqual(r({ provider: 'codex', entry: 'vscode' }), 'codexVscode');
  assert.strictEqual(r({ provider: 'codex', entry: 'desktop' }), 'codexDesktop');
  assert.strictEqual(r({ provider: 'codex', entry: 'exec' }), 'codexCli');
  assert.strictEqual(r({ provider: 'copilot', entry: 'vscode' }), 'copilot');
  assert.deepStrictEqual(J.resolverFor({ provider: 'aider' }), { id: 'unknown', unsupported: 'aider' });
  const w = (s) => J.worthTrying(s, NOW);
  assert.strictEqual(w({ provider: 'claude', entry: 'cli', live: true }), true);
  assert.strictEqual(w({ provider: 'claude', entry: 'cli', live: false, updatedMs: NOW }), false);
  assert.strictEqual(w({ provider: 'codex', entry: 'cli', live: false, updatedMs: NOW - HOUR }), true);
  assert.strictEqual(w({ provider: 'codex', entry: 'cli', live: false, updatedMs: NOW - 30 * HOUR, lastActivityMs: NOW - 2 * HOUR }), true);
  assert.strictEqual(w({ provider: 'copilot', live: false, updatedMs: NOW - 30 * HOUR }), false);
  assert.strictEqual(w({ provider: 'codex', entry: 'desktop', live: true }), false);
  assert.strictEqual(w({ provider: 'claude', entry: 'sdk', entrypoint: 'sdk-ts', live: true }), false, 'Agent SDK sessions run in the background');
});

test('planJump, Claude VS Code: the extension host that runs the claude process names the window (here or another); an unknown VS Code → otherWindow; not in the registry or exited → notRunning', async () => {
  const procs = [proc(1, 0, '/sbin/launchd'), proc(100, 1, CODE), proc(200, 1, CODE), proc(300, 1, CODE),
    proc(101, 100, '/x/claude'), proc(201, 200, '/x/claude'), proc(301, 300, '/x/claude')];
  const s = { provider: 'claude', id: UUID, entry: 'vscode', entrypoint: 'claude-vscode', live: true };
  const plan = (pid) => J.planJump(s, env({ procs, windows: [PEER], live: pid ? { [UUID]: { pid } } : {} }));
  assert.deepStrictEqual(await plan(101), { ok: true, window: null, action: { kind: ACTION.CLAUDE_VSCODE, sessionId: UUID }, target: 'claudeVscode' });
  assert.deepStrictEqual((await plan(201)).window, { id: 'peer', folders: ['/w/peer'] });
  assert.strictEqual((await plan(301)).reason, REASON.OTHER_WINDOW);
  assert.strictEqual((await plan(0)).reason, REASON.NOT_RUNNING);
  assert.strictEqual((await plan(999)).reason, REASON.NOT_RUNNING);
});

test('planJump, CLI in a terminal: this window\'s or another window\'s integrated terminal; iTerm2 / Terminal.app on macOS → select the tab by tty; other apps or platforms are named; under an extension host → background; unknown VS Code → otherWindow', async () => {
  const s = { provider: 'claude', id: UUID, entry: 'cli', entrypoint: 'cli', live: true };
  const base = [proc(1, 0, '/sbin/launchd'), proc(100, 1, CODE), proc(50, 1, PTY), proc(110, 50, '/bin/zsh'), proc(210, 50, '/bin/zsh')];
  const plan = (procs, pid, o = {}) => J.planJump(s, env({ procs: [...base, ...procs], windows: [PEER], local: { terminals: [110] }, live: { [UUID]: { pid } }, ...o }));
  assert.deepStrictEqual(await plan([proc(111, 110, '/x/claude')], 111), { ok: true, window: null, action: { kind: ACTION.TERMINAL, pid: 110 }, target: 'claudeCli' });
  const remote = await plan([proc(211, 210, '/x/claude')], 211);
  assert.deepStrictEqual([remote.window.id, remote.action], ['peer', { kind: ACTION.TERMINAL, pid: 210 }]);
  const iterm = [proc(800, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2'), proc(801, 800, '/Applications/iTerm.app/Contents/MacOS/iTermServer-3.5 x'),
    proc(802, 801, '/usr/bin/login -fpl x /bin/zsh', { tty: '/dev/ttys007' }), proc(803, 802, '-zsh', { tty: '/dev/ttys007' }), proc(804, 803, '/x/claude', { tty: '/dev/ttys007' })];
  assert.deepStrictEqual(await plan(iterm, 804), { ok: true, window: null, action: { kind: ACTION.EXTERNAL_TERMINAL, app: 'iterm2', tty: '/dev/ttys007' }, target: 'claudeCli' });
  assert.deepStrictEqual(await plan(iterm, 804, { platform: 'linux' }), { ok: false, reason: REASON.EXTERNAL, app: 'iTerm2', terminal: 'iterm2', target: 'claudeCli' });
  const term = [proc(900, 1, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'), proc(901, 900, '-zsh', { tty: '/dev/ttys002' }), proc(902, 901, '/x/claude', { tty: '/dev/ttys002' })];
  assert.deepStrictEqual((await plan(term, 902)).action, { kind: ACTION.EXTERNAL_TERMINAL, app: 'terminalApp', tty: '/dev/ttys002' });
  const warp = [proc(700, 1, '/Applications/Warp.app/Contents/MacOS/stable'), proc(701, 700, '/bin/zsh', { tty: '/dev/ttys001' }), proc(702, 701, '/x/claude', { tty: '/dev/ttys001' })];
  assert.strictEqual((await plan(warp, 702)).app, 'Warp');
  assert.strictEqual((await plan([proc(120, 100, '/x/claude -p')], 120)).reason, REASON.BACKGROUND);
  assert.strictEqual((await plan([proc(400, 1, CODE), proc(401, 400, '/x/claude')], 401)).reason, REASON.OTHER_WINDOW);
  assert.deepStrictEqual(await plan([proc(600, 1, '/usr/sbin/sshd'), proc(601, 600, '/x/claude')], 601), { ok: false, reason: REASON.EXTERNAL, target: 'claudeCli' });
});

test('planJump: a registry pid whose process started after the session registered it was reused → notRunning (Claude VS Code / CLI); an older process is still the agent', async () => {
  const base = [proc(1, 0, '/sbin/launchd'), proc(100, 1, CODE), proc(50, 1, PTY), proc(110, 50, '/bin/zsh')];
  const vs = { provider: 'claude', id: UUID, entry: 'vscode', entrypoint: 'claude-vscode', live: true };
  const cli = { provider: 'claude', id: UUID, entry: 'cli', entrypoint: 'cli', live: true };
  const young = [...base, proc(101, 100, '/x/some-other-program', { startMs: NOW - 60e3 }), proc(111, 110, '/x/other', { startMs: NOW - 60e3 })];
  const live = (pid) => ({ [UUID]: { pid, startedAt: NOW - HOUR } });
  assert.strictEqual((await J.planJump(vs, env({ procs: young, live: live(101) }))).reason, REASON.NOT_RUNNING);
  assert.strictEqual((await J.planJump(cli, env({ procs: young, local: { terminals: [110] }, live: live(111) }))).reason, REASON.NOT_RUNNING);
  const old = [...base, proc(101, 100, '/x/claude', { startMs: NOW - HOUR - 1500 })];
  assert.ok((await J.planJump(vs, env({ procs: old, live: live(101) }))).ok, 'started (just) before it registered: the agent');
  const cprocs = [...base, proc(122, 110, '/x/claude', { startMs: NOW - 60e3 })];
  const c = (startedAt) => J.planJump(cli, env({ procs: cprocs, local: { terminals: [110] }, live: { [UUID]: { pid: 122, startedAt } } }));
  assert.strictEqual((await c(NOW - HOUR)).reason, REASON.NOT_RUNNING);
  assert.strictEqual((await c(NOW - 61e3)).action.pid, 110);
  assert.strictEqual((await c(undefined)).action.pid, 110, 'no start time in the registry: no check');
});

test('planJump, external terminal apps: no AppleScript plan in a remote window or for a tty that is not a plain terminal device', async () => {
  const s = { provider: 'claude', id: UUID, entry: 'cli', entrypoint: 'cli', live: true };
  const term = (tty) => [proc(1, 0, '/sbin/launchd'), proc(900, 1, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'),
    proc(901, 900, '-zsh', { tty }), proc(902, 901, '/x/claude', { tty })];
  const plan = (tty, o = {}) => J.planJump(s, { ...env({ procs: term(tty), live: { [UUID]: { pid: 902 } } }), ...o });
  assert.strictEqual((await plan('/dev/ttys002')).action.kind, ACTION.EXTERNAL_TERMINAL);
  assert.deepStrictEqual(await plan('/dev/ttys002', { remote: true }), { ok: false, reason: REASON.EXTERNAL, app: 'Terminal', terminal: 'terminalApp', target: 'claudeCli' });
  assert.strictEqual((await plan('/dev/tty.weird')).reason, REASON.EXTERNAL);
  // perform in a remote window (the extension host runs on another machine): osascript is never run
  const exec = fakeExec(() => ({ out: 'ok' }));
  const vscode = fakeVscode();
  vscode.env.remoteName = 'ssh-remote';
  const j = J.createJumper({ vscode, platform: 'darwin', execFile: exec, confirmAutomation: async () => true });
  assert.strictEqual((await j.perform({ kind: 'externalTerminal', app: 'terminalApp', tty: '/dev/ttys002' })).reason, REASON.EXTERNAL);
  assert.strictEqual(exec.calls.length, 0);
});

test('planJump, Codex CLI: first asks which process holds the rollout file; otherwise the folder and the newest process', async () => {
  const early = { startMs: NOW - 5 * HOUR };
  const base = [proc(1, 0, '/sbin/launchd', early), proc(50, 1, PTY, early), proc(110, 50, '/bin/zsh', early), proc(120, 50, '/bin/zsh', early)];
  const procs = [...base, proc(111, 110, '/opt/homebrew/bin/codex', { startMs: NOW - 2 * HOUR }), proc(121, 120, '/opt/homebrew/bin/codex', { startMs: NOW - HOUR })];
  const s = { provider: 'codex', id: CODEX_ID, entry: 'cli', cwd: '/w/a', transcript: '/h/.codex/sessions/rollout.jsonl', updatedMs: NOW };
  const local = { terminals: [110, 120] };
  const held = await J.planJump(s, env({ procs, local, holders: new Set([111]), cwds: new Map([[111, '/w/a'], [121, '/w/a']]) }));
  assert.deepStrictEqual([held.action, held.candidates], [{ kind: ACTION.TERMINAL, pid: 110 }, undefined], 'the holder, even though 121 is newer');
  const guess = await J.planJump(s, env({ procs, local, cwds: new Map([[111, '/w/a'], [121, '/w/a']]) }));
  assert.deepStrictEqual([guess.action.pid, guess.candidates], [120, 2], 'no holder info: the newest, counted');
  const folder = await J.planJump(s, env({ procs, local, cwds: new Map([[111, '/w/a'], [121, '/w/other']]) }));
  assert.deepStrictEqual([folder.action.pid, folder.candidates], [110, undefined], 'no holder info: the one in the session folder');
  assert.strictEqual((await J.planJump(s, env({ procs: base, local }))).reason, REASON.NOT_FOUND);
});

test('planJump, Codex extension: the window whose app-server holds the rollout file; without holder info the only window running Codex, else the folder match; no app-server → here', async () => {
  const server = (pid, host) => proc(pid, host, '/Users/x/.vscode/extensions/openai.chatgpt-26.1.0/bin/macos-aarch64/codex app-server --analytics-default-enabled');
  const hosts = [proc(1, 0, '/sbin/launchd'), proc(100, 1, CODE), proc(200, 1, CODE)];
  const s = { provider: 'codex', id: CODEX_ID, entry: 'vscode', cwd: '/w/peer/sub', transcript: '/h/.codex/sessions/rollout.jsonl' };
  const win = async (procs, o = {}) => { const p = await J.planJump(s, env({ procs: [...hosts, ...procs], windows: [PEER], ...o })); assert.ok(p.ok, JSON.stringify(p)); return p.window && p.window.id; };
  assert.strictEqual(await win([]), null, 'no app-server anywhere: open it here');
  assert.strictEqual(await win([server(101, 100), server(201, 200)], { holders: new Set([201]) }), 'peer');
  assert.strictEqual(await win([server(101, 100), server(201, 200)], { holders: new Set() }), null, 'nobody has it loaded: here');
  // held by an app-server under a window Agent Monitor cannot reach: opening it here would conflict with that writer
  const stranger = [proc(300, 1, CODE), server(301, 300)];
  assert.strictEqual((await J.planJump(s, env({ procs: [...hosts, server(101, 100), ...stranger], windows: [PEER], holders: new Set([301]) }))).reason, REASON.OTHER_WINDOW);
  assert.strictEqual((await J.planJump(s, env({ procs: [...hosts, ...stranger], windows: [PEER], holders: new Set([301]) }))).reason, REASON.OTHER_WINDOW);
  assert.strictEqual((await J.planJump(s, env({ procs: [...hosts, ...stranger], windows: [PEER], holders: new Set() }))).window, null, 'not held there: here');
  assert.strictEqual(await win([server(201, 200)]), 'peer', 'the only window running Codex');
  assert.strictEqual(await win([server(101, 100), server(201, 200)]), 'peer', 'folder match');
  s.cwd = '/elsewhere';
  assert.strictEqual(await win([server(101, 100), server(201, 200)]), null, 'no folder match: here');
  const p = await J.planJump(s, env({ procs: hosts }));
  assert.deepStrictEqual(p.action, { kind: ACTION.CODEX_VSCODE, threadId: CODEX_ID });
  assert.strictEqual((await J.planJump({ ...s, id: '../x' }, env())).reason, REASON.NOT_FOUND);
});

test('planJump, Copilot: the window whose workspace storage / .code-workspace holds the chat (an empty window for empty-window chats); none open → windowClosed; processes are never listed', async () => {
  const cop = (o) => ({ provider: 'copilot', id: 'chat-1', entry: 'vscode', transcript: '/u/workspaceStorage/p1/chatSessions/chat-1.jsonl', copilot: { storage: 'workspace', workspaceFile: null }, ...o });
  const E = env({ windows: [PEER, { id: 'empty', hostPid: 300, terminals: [], folders: [], empty: true }], local: { storageDir: '/u/workspaceStorage/h0', empty: false } });
  assert.deepStrictEqual(await J.planJump(cop(), E), { ok: true, window: { id: 'peer', folders: ['/w/peer'] }, action: { kind: ACTION.COPILOT, sessionId: 'chat-1' }, target: 'copilot' });
  assert.strictEqual((await J.planJump(cop({ transcript: '/u/workspaceStorage/h0/chatSessions/chat-1.jsonl' }), E)).window, null);
  assert.strictEqual((await J.planJump(cop({ copilot: { storage: 'emptyWindow' }, transcript: '/u/globalStorage/emptyWindowChatSessions/chat-1.jsonl' }), E)).window.id, 'empty');
  const wsFile = env({ windows: [{ ...PEER, storageDir: null, workspaceFile: '/w/team.code-workspace' }] });
  assert.strictEqual((await J.planJump(cop({ transcript: '/other/x.jsonl', copilot: { storage: 'workspace', workspaceFile: '/w/team.code-workspace' } }), wsFile)).window.id, 'peer');
  assert.strictEqual((await J.planJump(cop({ transcript: '/u/workspaceStorage/zz/chatSessions/chat-1.jsonl' }), E)).reason, REASON.WINDOW_CLOSED);
  assert.strictEqual(E.lists, 0);
});

test('planJump, unsupported targets: the Claude desktop app, the Codex app and unknown providers say which, without listing processes', async () => {
  const E = env();
  assert.deepStrictEqual(await J.planJump({ provider: 'claude', id: UUID, entry: 'desktop', live: true }, E), { ok: false, reason: REASON.UNSUPPORTED, tool: 'claudeDesktop', target: 'claudeDesktop' });
  assert.strictEqual((await J.planJump({ provider: 'codex', id: CODEX_ID, entry: 'desktop' }, E)).tool, 'codexDesktop');
  assert.strictEqual((await J.planJump({ provider: 'aider', id: 'a' }, E)).tool, 'aider');
  assert.strictEqual(E.lists, 0);
});

// ---------- Performing ----------

test('cleanAction: only well-formed actions pass (ids, pids, a known terminal app with a /dev/tty path, reply fields)', () => {
  const c = I.cleanAction;
  assert.deepStrictEqual(c({ kind: 'claudeVscode', sessionId: UUID, extra: 1 }), { kind: 'claudeVscode', sessionId: UUID });
  assert.strictEqual(c({ kind: 'claudeVscode', sessionId: 'x' }), null);
  assert.deepStrictEqual(c({ kind: 'codexVscode', threadId: CODEX_ID }), { kind: 'codexVscode', threadId: CODEX_ID });
  assert.strictEqual(c({ kind: 'codexVscode', threadId: '../../x' }), null);
  assert.strictEqual(c({ kind: 'copilot', sessionId: 'a/b' }), null);
  assert.strictEqual(c({ kind: 'terminal', pid: 0 }), null);
  assert.deepStrictEqual(c({ kind: 'externalTerminal', app: 'terminalApp', tty: '/dev/ttys001' }), { kind: 'externalTerminal', app: 'terminalApp', tty: '/dev/ttys001' });
  assert.strictEqual(c({ kind: 'externalTerminal', app: 'warp', tty: '/dev/ttys001' }), null, 'no script for Warp');
  assert.strictEqual(c({ kind: 'externalTerminal', app: 'iterm2', tty: '/etc/passwd' }), null);
  // the tty goes to osascript: only what ps prints for a terminal device (ttys003, old BSD ttyp0) passes
  assert.ok(c({ kind: 'externalTerminal', app: 'iterm2', tty: '/dev/ttyp0' }));
  for (const tty of ['/dev/ttys001" & do shell script "x', '/dev/tty.usbserial', '/dev/ttys001\n', '/dev/ttys/../../x', '/dev/pts/3', '-e', 7]) {
    assert.strictEqual(c({ kind: 'externalTerminal', app: 'iterm2', tty }), null, JSON.stringify(tty));
  }
  assert.deepStrictEqual(c({ kind: 'result', reqId: 'abc123', ok: 'yes', raised: true, reason: 'bogus', tool: 'copilot' }),
    { kind: 'result', reqId: 'abc123', ok: false, raised: true, reason: undefined, tool: 'copilot' });
  assert.strictEqual(c({ kind: 'run', command: 'workbench.action.quit' }), null);
});

test('perform: Claude opens with the 6th argument that keeps the preferred location; Codex via vscode.openWith on its custom editor; Copilot via the internal command with a base64url id; each only when available', async () => {
  const vscode = fakeVscode();
  const j = J.createJumper({ vscode, platform: 'darwin' });
  assert.deepStrictEqual(await j.perform({ kind: 'claudeVscode', sessionId: UUID }), { ok: false, reason: REASON.NO_COMMAND, tool: 'claudeVscode' });
  vscode.addCommand(J.CLAUDE_OPEN_CMD);
  assert.deepStrictEqual(await j.perform({ kind: 'claudeVscode', sessionId: UUID }), { ok: true });
  assert.deepStrictEqual(last(vscode.executed), ['claude-vscode.editor.open', UUID, undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' }]);

  assert.deepStrictEqual(await j.perform({ kind: 'codexVscode', threadId: CODEX_ID }), { ok: false, reason: REASON.NO_COMMAND, tool: 'codexVscode' });
  const withCodex = fakeVscode({ extensions: ['openai.chatgpt'] });
  await J.createJumper({ vscode: withCodex }).perform({ kind: 'codexVscode', threadId: CODEX_ID });
  const [cmd, uri, viewType] = last(withCodex.executed);
  assert.deepStrictEqual([cmd, uri.scheme, uri.authority, uri.path, viewType], ['vscode.openWith', 'openai-codex', 'route', `/local/${CODEX_ID}`, 'chatgpt.conversationEditor']);

  assert.strictEqual((await j.perform({ kind: 'copilot', sessionId: 'ab' })).reason, REASON.NO_COMMAND);
  vscode.addCommand(J.COPILOT_OPEN_CMD);
  await j.perform({ kind: 'copilot', sessionId: 'ab' });
  const [ccmd, arg] = last(vscode.executed);
  assert.deepStrictEqual([ccmd, arg.resource.scheme, arg.resource.authority, arg.resource.path], ['workbench.action.chat.openSessionInEditorGroup', 'vscode-chat-session', 'local', '/YWI']);

  const t = terminal(4242);
  const withTerm = fakeVscode({ terminals: [terminal(1), t] });
  assert.deepStrictEqual(await J.createJumper({ vscode: withTerm }).perform({ kind: 'terminal', pid: 4242 }), { ok: true });
  assert.deepStrictEqual(t.shown, [false], 'shown and focused');
  assert.strictEqual((await J.createJumper({ vscode: withTerm }).perform({ kind: 'terminal', pid: 9 })).reason, REASON.NOT_FOUND);
  assert.strictEqual((await j.perform({ kind: 'nope' })).reason, REASON.FAILED);
});

test('perform, Terminal.app / iTerm2: nothing runs until the user confirms; then osascript with each script line and the tty; tab gone → tabNotFound; -1743 → automationDenied; not macOS → external', async () => {
  let answer = false;
  const asked = [];
  const confirmAutomation = async (app) => { asked.push(app); return answer; };
  let out = { out: 'ok\n' };
  const exec = fakeExec(() => out);
  const j = J.createJumper({ vscode: fakeVscode(), platform: 'darwin', execFile: exec, confirmAutomation });
  const act = { kind: 'externalTerminal', app: 'terminalApp', tty: '/dev/ttys002' };
  assert.deepStrictEqual(await j.perform(act), { ok: false, reason: REASON.CANCELLED });
  assert.deepStrictEqual([asked, exec.calls.length], [[{ id: 'terminalApp', name: 'Terminal' }], 0]);
  answer = true;
  assert.deepStrictEqual(await j.perform(act), { ok: true });
  const { cmd, args, opts } = exec.calls[0];
  assert.strictEqual(cmd, '/usr/bin/osascript');
  assert.deepStrictEqual(args.filter((a, i) => i % 2 === 1 && i < args.length - 1), I.TERMINAL_APP_SCRIPT);
  assert.ok(args.slice(0, -1).every((a, i) => i % 2 === 1 || a === '-e'));
  assert.strictEqual(last(args), '/dev/ttys002');
  assert.ok(opts.timeout >= 60e3, 'room for the macOS permission prompt');
  assert.ok(I.TERMINAL_APP_SCRIPT.some((l) => l.includes('set selected tab of w to t')) && I.TERMINAL_APP_SCRIPT.some((l) => l.includes('set index of w to 1')));
  assert.ok(I.ITERM_SCRIPT.some((l) => l.includes('tell s to select')));
  out = { out: 'not-found\n' };
  assert.deepStrictEqual(await j.perform({ ...act, app: 'iterm2' }), { ok: false, reason: REASON.NOT_FOUND, app: 'iTerm2' });
  out = { err: Object.assign(new Error('Command failed'), { code: 1 }), stderr: 'execution error: Not authorized to send Apple events to Terminal. (-1743)' };
  assert.deepStrictEqual(await j.perform(act), { ok: false, reason: REASON.AUTOMATION_DENIED, app: 'Terminal' });
  const linux = J.createJumper({ vscode: fakeVscode(), platform: 'linux', execFile: exec, confirmAutomation });
  assert.strictEqual((await linux.perform(act)).reason, REASON.EXTERNAL);
  assert.strictEqual(exec.calls.length, 3);
});

test('raiseWindow: workbench.action.focusWindow when it exists; else the code CLI with this window\'s own .code-workspace file or single folder, without VSCODE_IPC_HOOK_CLI; nothing when the target is ambiguous', async () => {
  const focus = fakeVscode({ commands: [J.FOCUS_WINDOW_CMD] });
  const noExec = fakeExec(() => { throw new Error('must not run'); });
  assert.strictEqual(await J.raiseWindow({ vscode: focus, platform: 'darwin', execFile: noExec }), true);
  assert.deepStrictEqual(focus.executed, [['workbench.action.focusWindow']]);
  assert.strictEqual(noExec.calls.length, 0);

  const env0 = { PATH: '/bin', VSCODE_IPC_HOOK_CLI: '/tmp/x.sock', ELECTRON_RUN_AS_NODE: '1' };
  const exists = (p) => /[\\/]bin[\\/](code|code-insiders)(\.cmd)?$/.test(p);
  const readFile = () => JSON.stringify({ applicationName: 'code-insiders' });
  const mac = fakeExec(() => ({ out: '' }));
  const macVs = fakeVscode({ appRoot: '/Applications/Visual Studio Code.app/Contents/Resources/app', folders: [{ uri: fileUri('/w/one') }] });
  assert.strictEqual(await J.raiseWindow({ vscode: macVs, platform: 'darwin', execFile: mac, env: env0, exists, readFile }), true);
  assert.deepStrictEqual([mac.calls[0].cmd, mac.calls[0].args], ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', ['/w/one']]);
  assert.deepStrictEqual(mac.calls[0].opts.env, { PATH: '/bin' });

  const lin = fakeExec(() => ({ out: '' }));
  const linVs = fakeVscode({ appRoot: '/usr/share/code-insiders/resources/app', workspaceFile: fileUri('/w/team.code-workspace'), folders: [{ uri: fileUri('/w/a') }, { uri: fileUri('/w/b') }] });
  await J.raiseWindow({ vscode: linVs, platform: 'linux', execFile: lin, env: env0, exists, readFile });
  assert.deepStrictEqual([lin.calls[0].cmd, lin.calls[0].args], ['/usr/share/code-insiders/bin/code-insiders', ['/w/team.code-workspace']]);

  // Windows: no cmd.exe (bin\code.cmd is a batch file); Code.exe runs out\cli.js as node, the folder as a plain argument
  const win = fakeExec(() => ({ out: '' }));
  const appRoot = 'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app';
  const exe = 'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
  const winExists = (p) => p === exe || p === appRoot + '\\out\\cli.js';
  const odd = 'C:\\w\\100% & "x" ^ !y!';
  const winVs = fakeVscode({ appRoot, folders: [{ uri: fileUri(odd) }] });
  assert.strictEqual(await J.raiseWindow({ vscode: winVs, platform: 'win32', execFile: win, execPath: exe, env: { ...env0, ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, exists: winExists }), true);
  assert.deepStrictEqual([win.calls[0].cmd, win.calls[0].args], [exe, [appRoot + '\\out\\cli.js', odd]], 'the folder is one argument, whatever it contains');
  assert.deepStrictEqual(win.calls[0].opts.env, { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
  assert.ok(!win.calls[0].opts.shell && !win.calls[0].opts.windowsVerbatimArguments);
  assert.strictEqual(await J.raiseWindow({ vscode: winVs, platform: 'win32', execFile: win, execPath: exe, env: env0, exists: () => false }), false, 'no cli.js: nothing run');
  assert.strictEqual(win.calls.length, 1);
  // a relative or odd "folder" is never passed (the CLI could read it as an option)
  const rel = fakeVscode({ appRoot: '/a', folders: [{ uri: fileUri('--install-extension=evil') }] });
  const noRun = fakeExec(() => ({ out: '' }));
  assert.strictEqual(await J.raiseWindow({ vscode: rel, platform: 'darwin', execFile: noRun, exists: () => true }), false);
  assert.strictEqual(noRun.calls.length, 0);

  const two = fakeVscode({ appRoot: '/a', folders: [{ uri: fileUri('/w/a') }, { uri: fileUri('/w/b') }] });
  const untitled = fakeVscode({ appRoot: '/a', workspaceFile: { scheme: 'untitled', fsPath: '/Untitled-1' }, folders: [{ uri: fileUri('/w/a') }] });
  const none = fakeExec(() => ({ out: '' }));
  assert.strictEqual(await J.raiseWindow({ vscode: two, platform: 'darwin', execFile: none, exists: () => true }), false);
  assert.strictEqual(await J.raiseWindow({ vscode: untitled, platform: 'darwin', execFile: none, exists: () => true }), false);
  assert.strictEqual(none.calls.length, 0);
});

// ---------- Across windows ----------

test('cross-window round trip over shared-scan: A asks B, B opens the chat (never A), raises itself and replies; A has nothing to say. B failing is reported; B not answering → noReply', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'rt-'));
  const opts = { dir, cfgKey: 'k', watch: false, heartbeatMs: 15, staleMs: 2000, settleMs: 5, soloGraceMs: 5 };
  const vsA = fakeVscode({ commands: [J.CLAUDE_OPEN_CMD, J.FOCUS_WINDOW_CMD] });
  const vsB = fakeVscode({ commands: [J.CLAUDE_OPEN_CMD, J.FOCUS_WINDOW_CMD] });
  let jA = null;
  let jB = null;
  let bAnswers = true;
  const scanA = createSharedScan({ ...opts, windowId: 'a', host: { hostPid: 100, folders: ['/w/a'] }, onJump: (r) => jA.handleRequest(r) });
  const scanB = createSharedScan({ ...opts, windowId: 'b', host: { hostPid: 200, folders: ['/w/b'] }, onJump: (r) => (bAnswers ? jB.handleRequest(r) : null) });
  const procs = [proc(1, 0, '/sbin/launchd'), proc(100, 1, CODE), proc(200, 1, CODE), proc(201, 200, '/x/claude')];
  const common = { platform: 'darwin', listProcesses: async () => procs, claudeLive: () => ({ pid: 201 }), replyWaitMs: 1500 };
  jA = J.createJumper({ ...common, vscode: vsA, hostPid: 100, windows: () => scanA.windows(), requestJump: (id, a) => scanA.requestJump(id, a) });
  jB = J.createJumper({ ...common, vscode: vsB, hostPid: 200, windows: () => scanB.windows(), requestJump: (id, a) => scanB.requestJump(id, a) });
  const s = { provider: 'claude', id: UUID, entry: 'vscode', entrypoint: 'claude-vscode', live: true };
  try {
    scanA.start();
    await sleep(30);
    scanB.start();
    await sleep(60);
    assert.deepStrictEqual(scanA.windows().map((w) => [w.id, w.hostPid]), [['a', 100], ['b', 200]]);
    const out = await jA.goTo(s);
    assert.deepStrictEqual(out, { ok: true, remote: true, folder: '/w/b', raised: true, replied: true, target: 'claudeVscode' });
    assert.deepStrictEqual(vsB.executed, [
      ['claude-vscode.editor.open', UUID, undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' }],
      ['workbench.action.focusWindow'],
    ], 'B opened it, then raised itself');
    assert.deepStrictEqual(vsA.executed, [], 'A never opens it (it would be a duplicate)');
    assert.strictEqual(J.messageOf(out, createI18n('en'), s), null);
    // B no longer has the Claude extension: A says so
    vsB.executed.length = 0;
    const vsB2 = fakeVscode({ commands: [J.FOCUS_WINDOW_CMD] });
    jB = J.createJumper({ ...common, vscode: vsB2, hostPid: 200, windows: () => scanB.windows(), requestJump: (id, a) => scanB.requestJump(id, a) });
    const failed = await jA.goTo(s);
    assert.deepStrictEqual([failed.ok, failed.reason, failed.tool, failed.remote], [false, REASON.NO_COMMAND, 'claudeVscode', true]);
    assert.deepStrictEqual(vsB2.executed, [], 'not raised when nothing was opened');
    // B takes the request but never answers
    bAnswers = false;
    const quiet = J.createJumper({ ...common, vscode: vsA, hostPid: 100, windows: () => scanA.windows(), requestJump: (id, a) => scanA.requestJump(id, a), replyWaitMs: 80 });
    const silent = await quiet.goTo(s);
    assert.deepStrictEqual([silent.ok, silent.replied], [true, false]);
    assert.strictEqual(J.messageOf(silent, createI18n('en'), s).text, createI18n('en').t('ext.jump.noReply', { folder: 'b' }));
  } finally {
    scanA.stop();
    scanB.stop();
  }
});

test('goTo, another window: no reply in time → the request is withdrawn (it must not be performed later); a failure there is reported as happening there, never with its error text', async () => {
  const procs = [proc(1, 0, '/sbin/launchd'), proc(100, 1, CODE), proc(200, 1, CODE), proc(201, 200, '/x/claude')];
  const s = { provider: 'claude', id: UUID, entry: 'vscode', entrypoint: 'claude-vscode', live: true };
  const en = createI18n('en');
  const cancelled = [];
  const base = { vscode: fakeVscode(), platform: 'darwin', hostPid: 100, listProcesses: async () => procs, claudeLive: () => ({ pid: 201 }), windows: () => [PEER] };
  const quiet = J.createJumper({ ...base, requestJump: () => 'req1', cancelJump: (w, r) => { cancelled.push([w, r]); return true; }, replyWaitMs: 20 });
  assert.deepStrictEqual(await quiet.goTo(s), { ok: true, remote: true, folder: '/w/peer', raised: false, replied: false, target: 'claudeVscode' });
  assert.deepStrictEqual(cancelled, [['peer', 'req1']]);
  // a reply from a window that was not asked is ignored
  const other = J.createJumper({
    ...base, replyWaitMs: 60, cancelJump: () => false,
    requestJump: () => { setTimeout(() => other.handleRequest({ id: 'r', from: 'intruder', action: { kind: 'result', reqId: 'req3', ok: false, reason: 'notFound' } }), 5); return 'req3'; },
  });
  assert.deepStrictEqual((await other.goTo(s)).replied, false);
  let reply = null;
  const j = J.createJumper({
    ...base, replyWaitMs: 2000, cancelJump: () => { throw new Error('not called when answered'); },
    requestJump: () => { setTimeout(() => j.handleRequest({ id: 'r', from: 'peer', action: { kind: 'result', reqId: 'req2', ...reply } }), 5); return 'req2'; },
  });
  reply = { ok: false, reason: 'noCommand', tool: 'claudeVscode' };
  const nc = await j.goTo(s);
  assert.deepStrictEqual(nc, { ok: false, reason: REASON.NO_COMMAND, tool: 'claudeVscode', remote: true, folder: '/w/peer', target: 'claudeVscode' });
  assert.strictEqual(J.messageOf(nc, en, s).text, en.t('ext.jump.noCommandThere', { folder: 'peer', tool: en.t('ext.jump.tool.claudeVscode') }));
  for (const r of [{ ok: false, reason: 'failed', error: '[Open](command:workbench.action.quit)' }, { ok: false, reason: 'bogus' }]) {
    reply = r;
    const out = await j.goTo(s);
    assert.deepStrictEqual([out.ok, out.reason, out.error], [false, REASON.FAILED, undefined], 'the error text of another window is not carried');
    assert.strictEqual(J.messageOf(out, en, s).text, en.t('ext.jump.failedThere', { folder: 'peer' }));
  }
  assert.ok(!J.messageOf({ ok: false, reason: REASON.FAILED, remote: true, error: '[x](command:evil)' }, en).text.includes('command:'));
  // a folder name from another window's file cannot become a link or carry control characters
  assert.strictEqual(I.folderLabel('/w/[x](command:evil)'), '[x] (command:evil)');
  assert.strictEqual(I.folderLabel('/w/a\u0007b\n/'), 'ab');
  assert.strictEqual(I.folderLabel('C:\\w\\proj'), 'proj');
  assert.strictEqual(I.folderLabel(7), '');
});

test('handleRequest: invalid or external-terminal requests do nothing; a reply to an unknown request is ignored', async () => {
  const vscode = fakeVscode({ commands: [J.CLAUDE_OPEN_CMD, J.FOCUS_WINDOW_CMD] });
  const sent = [];
  const j = J.createJumper({ vscode, requestJump: (id, a) => { sent.push([id, a]); return 'r'; } });
  assert.strictEqual((await j.handleRequest({ id: 'x', from: 'w', action: { kind: 'externalTerminal', app: 'iterm2', tty: '/dev/ttys001' } })).ok, false);
  assert.strictEqual((await j.handleRequest({ id: 'x', from: 'w', action: { kind: 'run', command: 'rm' } })).ok, false);
  assert.deepStrictEqual((await j.handleRequest({ id: 'x', from: 'w', action: { kind: 'result', reqId: 'zzz', ok: true } })), { ok: true });
  assert.deepStrictEqual([vscode.executed, sent], [[], []]);
  const done = await j.handleRequest({ id: 'q1', from: 'w', action: { kind: 'claudeVscode', sessionId: UUID } });
  assert.deepStrictEqual([done.ok, done.raised], [true, true]);
  assert.deepStrictEqual(sent, [['w', { kind: 'result', reqId: 'q1', ok: true, raised: true, reason: undefined, tool: undefined }]]);
});

// ---------- Messages ----------

test('messageOf: every outcome has a short message in all 5 languages with its placeholders filled; success here or a raised window says nothing; Automation refusals carry the settings button', () => {
  const outcomes = [
    { ok: true, remote: true, folder: '/w/peer', replied: true, raised: false },
    { ok: true, remote: true, folder: null, replied: true, raised: false },
    { ok: true, remote: true, folder: '/w/peer', replied: false, raised: false },
    { ok: true, remote: true, folder: null, replied: false, raised: false },
    { ok: false, reason: REASON.NOT_RUNNING },
    { ok: false, reason: REASON.NOT_FOUND },
    { ok: false, reason: REASON.NOT_FOUND, app: 'iTerm2' },
    { ok: false, reason: REASON.EXTERNAL },
    { ok: false, reason: REASON.EXTERNAL, app: 'Warp' },
    { ok: false, reason: REASON.BACKGROUND },
    { ok: false, reason: REASON.OTHER_WINDOW },
    { ok: false, reason: REASON.WINDOW_CLOSED },
    ...J.TOOL_KEYS.map((tool) => ({ ok: false, reason: REASON.NO_COMMAND, tool })),
    ...J.TOOL_KEYS.map((tool) => ({ ok: false, reason: REASON.UNSUPPORTED, tool })),
    { ok: false, reason: REASON.UNSUPPORTED, tool: 'aider' },
    { ok: false, reason: REASON.AUTOMATION_DENIED, app: 'Terminal' },
    { ok: false, reason: REASON.FAILED, error: 'ps timed out' },
    { ok: false, reason: REASON.NO_COMMAND, tool: 'copilot', remote: true, folder: '/w/peer' },
    { ok: false, reason: REASON.NO_COMMAND, tool: 'codexVscode', remote: true, folder: null },
    { ok: false, reason: REASON.FAILED, remote: true, folder: '/w/peer' },
    { ok: false, reason: REASON.FAILED, remote: true, folder: null },
  ];
  for (const lang of ['en', 'zh-cn', 'zh-tw', 'ko', 'ja']) {
    const i18n = createI18n(lang);
    for (const o of outcomes) {
      const m = J.messageOf(o, i18n, { provider: 'codex' }, { appName: 'Cursor' });
      assert.ok(m && m.text && !/ext\.jump|\{\w+\}/.test(m.text), `${lang} ${JSON.stringify(o)}: ${m && m.text}`);
    }
    const denied = J.messageOf({ ok: false, reason: REASON.AUTOMATION_DENIED, app: 'Terminal' }, i18n, null, { appName: 'Cursor' });
    assert.ok(denied.text.includes('Cursor') && denied.text.includes('Terminal') && denied.level === 'warn');
    assert.deepStrictEqual([denied.button.url, denied.button.label], [J.AUTOMATION_SETTINGS_URL, i18n.t('ext.jump.openAutomationSettings')]);
    for (const k of ['ext.jump.automation.confirm', 'ext.jump.automation.detail', 'ext.jump.automation.continue']) assert.notStrictEqual(i18n.t(k, { app: 'a', editor: 'e' }), k);
  }
  const en = createI18n('en');
  assert.strictEqual(J.messageOf({ ok: true, remote: false }, en), null);
  assert.strictEqual(J.messageOf({ ok: true, remote: true, raised: true, replied: true }, en), null);
  assert.strictEqual(J.messageOf({ ok: false, reason: REASON.CANCELLED }, en), null);
  assert.strictEqual(J.messageOf({ ok: true, remote: true, folder: '/w/peer', replied: true }, en).text, en.t('ext.jump.sentToWindow', { folder: 'peer' }));
  assert.strictEqual(J.messageOf({ ok: false, reason: REASON.NOT_FOUND }, en, { provider: 'codex' }).text, en.t('ext.jump.notFound', { tool: 'Codex' }));
  assert.strictEqual(J.messageOf({ ok: false, reason: REASON.NO_COMMAND, tool: 'copilot' }, en).text, en.t('ext.jump.noCommand', { tool: 'GitHub Copilot Chat' }));
  assert.strictEqual(J.messageOf({ ok: false, reason: REASON.FAILED, error: 'boom' }, en).level, 'warn');
});

(async () => {
  let ok = 0;
  let fail = 0;
  console.log('Go to agent (lib/jump.js)');
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
