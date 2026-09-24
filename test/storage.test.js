'use strict';
// Tests for "storage locations, usage and migration reference": lib/storage.js, lib/storage-view.js, media/storage.{js,css}, l10n/storage.en.json.
// Plain node: node test/storage.test.js. All data lives in synthetic temp directories; ~/.claude and ~/.codex are never read.
// Volumes use injected mount points and a fake statfs. Temp files go under AGENT_MONITOR_TEST_TMP (system temp dir if unset) and are removed afterwards.
// Generated commands are only checked as text (split into words by shell rules, then paths compared); no command is ever executed.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const storage = require('../lib/storage');
const SV = require('../lib/storage-view');
const i18nLib = require('../lib/i18n');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'am-storage-')));

const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
const LOCALES = ['en', 'zh-cn', 'zh-tw', 'ko', 'ja'];
const GB = 1e9;

// ---------- Helpers ----------

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function write(p, bytes) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 97));
}

// POSIX word splitting: only handles what this extension generates (single quotes, '\'' escapes, whitespace separators)
function posixWords(line) {
  const out = [];
  let cur = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const j = line.indexOf("'", i + 1);
      assert.ok(j > i, 'Unclosed single quote: ' + line);
      cur = (cur || '') + line.slice(i + 1, j);
      i = j;
    } else if (c === '\\') {
      cur = (cur || '') + line[i + 1];
      i++;
    } else if (/\s/.test(c)) {
      if (cur != null) out.push(cur);
      cur = null;
    } else {
      cur = (cur || '') + c;
    }
  }
  if (cur != null) out.push(cur);
  return out;
}
// Split into separate commands at && outside quotes
function posixSteps(line) {
  const steps = [];
  let q = false;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (!q && line[i] === '\\') i++; // \' outside quotes is a literal single quote
    else if (line[i] === "'") q = !q;
    else if (!q && line.startsWith(' && ', i)) { steps.push(line.slice(start, i)); start = i + 4; i += 3; }
  }
  steps.push(line.slice(start));
  return steps.map(posixWords);
}
// PowerShell single-quoted strings ('' means one ')
function pwshStrings(line) {
  const out = [];
  const re = /'((?:[^']|'')*)'/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1].replace(/''/g, "'"));
  return out;
}

// Synthetic Claude / Codex directories (projects etc.); returns their paths
function makeClaudeHome(base) {
  const home = path.join(base, 'home');
  const claude = path.join(home, '.claude');
  write(path.join(claude, 'projects', '-work-a', 's1.jsonl'), 1000);
  write(path.join(claude, 'projects', '-work-a', 's1', 'subagents', 'agent-x.jsonl'), 300);
  write(path.join(claude, 'projects', '-work-b', 's2.jsonl'), 200);
  write(path.join(claude, 'file-history', 's1', 'f1@v1'), 50);
  write(path.join(claude, 'plugins', 'p', 'index.js'), 70);
  write(path.join(claude, 'history.jsonl'), 30);
  write(path.join(claude, 'todos', 't.json'), 20);
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 14, model: 'x' }, null, 2));
  write(path.join(home, '.claude.json'), 40);
  const codex = path.join(home, '.codex');
  write(path.join(codex, 'sessions', '2026', '09', '24', 'rollout-a.jsonl'), 500);
  write(path.join(codex, 'state_5.sqlite'), 100);
  write(path.join(codex, 'state_5.sqlite-wal'), 10);
  write(path.join(codex, 'state_5.sqlite-shm'), 5);
  write(path.join(codex, 'config.toml'), 8);
  return { home, claude, codex };
}

// Fake volumes: / (system), <base>/My Disk (external, most free space), <base>/Small (external), <base>/RO (read-only)
function fakeVolumes(base) {
  const big = path.join(base, 'My Disk');
  const small = path.join(base, 'Small');
  const ro = path.join(base, 'RO');
  for (const d of [big, small, ro]) fs.mkdirSync(d, { recursive: true });
  const sizes = new Map([
    ['/', { freeBytes: 39 * GB, totalBytes: 228 * GB, writable: true }],
    [big, { freeBytes: 440 * GB, totalBytes: 1000 * GB, writable: true }],
    [small, { freeBytes: 20 * GB, totalBytes: 64 * GB, writable: true }],
    [ro, { freeBytes: 900 * GB, totalBytes: 1000 * GB, writable: false }],
  ]);
  return {
    big, small, ro,
    opts: { roots: ['/', big, small, ro], statfs: (p) => sizes.get(p), systemMount: '/' },
  };
}

// ---------- vscode stub (only the APIs this page uses) ----------

function makeVscode() {
  const log = { panels: [], warn: [], info: [], dialogs: [], terminals: [], clipboard: [], executed: [] };
  const ctl = { warnAnswer: undefined, pick: undefined };
  const uri = (p) => ({ fsPath: p, scheme: 'file', toString: () => 'file://' + p });
  const vscode = {
    Uri: {
      file: uri,
      joinPath: (u, ...parts) => uri(path.join(u.fsPath, ...parts)),
    },
    ViewColumn: { Active: -1 },
    env: { clipboard: { writeText: async (t) => { log.clipboard.push(t); } } },
    commands: { executeCommand: async (id, ...args) => { log.executed.push([id, ...args]); } },
    window: {
      createWebviewPanel: (type, title, column, options) => {
        const handlers = { msg: null, dispose: [] };
        const panel = {
          type, title, column, options, visible: true, revealed: 0, posted: [], iconPath: null,
          webview: {
            html: '', cspSource: 'vscode-webview://abc',
            asWebviewUri: (u) => ({ toString: () => 'https://asset' + u.fsPath }),
            postMessage: (m) => { panel.posted.push(JSON.parse(JSON.stringify(m))); return Promise.resolve(true); },
            onDidReceiveMessage: (fn) => { handlers.msg = fn; return { dispose() {} }; },
          },
          onDidDispose: (fn) => { handlers.dispose.push(fn); return { dispose() {} }; },
          onDidChangeViewState: () => ({ dispose() {} }),
          reveal() { panel.revealed++; },
          dispose() { const fns = handlers.dispose.splice(0); for (const f of fns) f(); },
          handlers,
        };
        log.panels.push(panel);
        return panel;
      },
      showWarningMessage: async (msg, ...rest) => { log.warn.push({ msg, rest }); return ctl.warnAnswer; },
      showInformationMessage: async (msg) => { log.info.push(msg); return undefined; },
      showOpenDialog: async (o) => { log.dialogs.push(o); return ctl.pick ? [uri(ctl.pick)] : undefined; },
      createTerminal: (o) => {
        const term = { opts: o, shown: 0, sent: [], show() { term.shown++; }, sendText(text, addNewLine) { term.sent.push([text, addNewLine]); } };
        log.terminals.push(term);
        return term;
      },
    },
  };
  return { vscode, log, ctl };
}

// ---------- Directory scan ----------

test('scanStorage: per-entry size, file count, "everything else" total, .claude.json in the home directory, cleanupPeriodDays, directory source', async () => {
  const base = path.join(TMP, 'scan1');
  const { home, claude, codex } = makeClaudeHome(base);
  const vols = fakeVolumes(base);
  const r = await storage.scanStorage({ claudeDir: claude, codexHome: codex, homeDir: home, env: {}, platform: process.platform, volumes: vols.opts });
  const c = r.claude;
  assert.strictEqual(c.exists, true);
  assert.strictEqual(c.dirSource, 'default');
  const by = Object.fromEntries(c.entries.map((e) => [e.name, e]));
  assert.deepStrictEqual([by.projects.bytes, by.projects.files], [1500, 3]);
  assert.deepStrictEqual([by['file-history'].bytes, by['file-history'].files], [50, 1]);
  assert.strictEqual(by.plugins.bytes, 70);
  // Known subdirectories that do not exist are not listed (except projects)
  assert.ok(!by.skills && !by.cache && !by.backups);
  assert.strictEqual(by['.claude.json'].bytes, 40);
  assert.strictEqual(by['.claude.json'].outside, true);
  assert.strictEqual(by['.claude.json'].path, path.join(home, '.claude.json'));
  // Everything else: history.jsonl + todos/ + settings.json
  const settingsBytes = fs.statSync(path.join(claude, 'settings.json')).size;
  assert.strictEqual(by['*'].rest, true);
  assert.strictEqual(by['*'].count, 3);
  assert.strictEqual(by['*'].bytes, 30 + 20 + settingsBytes);
  assert.deepStrictEqual(by['*'].top.map((x) => x.name).sort(), ['history.jsonl', 'settings.json', 'todos'].sort());
  assert.strictEqual(c.totalBytes, 1500 + 50 + 70 + 40 + 30 + 20 + settingsBytes);
  assert.strictEqual(r.cleanupPeriodDays, 14);
  // Fixed order: known entries in list order, then .claude.json, then everything else
  assert.deepStrictEqual(c.entries.map((e) => e.name), ['projects', 'file-history', 'plugins', '.claude.json', '*']);
  // Codex: sqlite plus its -wal / -shm files count as one entry; everything else is just config.toml
  const x = Object.fromEntries(r.codex.entries.map((e) => [e.name, e]));
  assert.strictEqual(x.sessions.bytes, 500);
  assert.deepStrictEqual([x['state_5.sqlite'].bytes, x['state_5.sqlite'].files], [115, 3]);
  assert.deepStrictEqual([x['*'].count, x['*'].bytes], [1, 8]);
  assert.strictEqual(r.codex.dirSource, 'default');
  // Volumes: injected mount points; each entry is tagged with its volume
  assert.deepStrictEqual(r.volumes.map((v) => [v.mount, v.system]), [['/', true], [vols.big, false], [vols.ro, false], [vols.small, false]]);
  assert.strictEqual(by.projects.volume, '/');
  // Source: environment variable / setting
  const r2 = await storage.scanStorage({ claudeDir: claude, codexHome: codex, homeDir: home, env: { CLAUDE_CONFIG_DIR: claude + '/' }, volumes: vols.opts });
  assert.strictEqual(r2.claude.dirSource, 'env');
  assert.strictEqual(r2.codex.dirSource, 'default');
  const r3 = await storage.scanStorage({ claudeDir: claude, homeDir: path.join(base, 'elsewhere'), env: {}, volumes: vols.opts });
  assert.strictEqual(r3.claude.dirSource, 'setting');
  assert.strictEqual(r3.codex, null);
  // When not in the default location, .claude.json is looked up inside that directory (missing here, but still listed)
  const cj = r3.claude.entries.find((e) => e.name === '.claude.json');
  assert.deepStrictEqual([cj.exists, cj.outside, cj.path], [false, false, path.join(claude, '.claude.json')]);
});

test('Symlinks: top-level entries are followed once and their target is shown; symlinks inside directories are not followed; two entries pointing to the same place are counted once; hard links count once', async () => {
  const base = path.join(TMP, 'links');
  const claude = path.join(base, 'home', '.claude');
  const ext = path.join(base, 'My Disk', 'AI-Data', 'claude', 'projects');
  write(path.join(ext, '-p', 'a.jsonl'), 4000);
  write(path.join(base, 'big', 'blob.bin'), 100000);
  // A symlink inside projects points to a large directory: not followed
  fs.symlinkSync(path.join(base, 'big'), path.join(ext, '-p', 'link-to-big'));
  // Hard link: one file with two names
  fs.linkSync(path.join(ext, '-p', 'a.jsonl'), path.join(ext, '-p', 'a-hard.jsonl'));
  fs.mkdirSync(claude, { recursive: true });
  fs.symlinkSync(ext, path.join(claude, 'projects'));
  // cache points to the same place too
  fs.symlinkSync(ext, path.join(claude, 'cache'));
  // Broken symlink (external drive not mounted)
  fs.symlinkSync(path.join(base, 'Unplugged', 'x'), path.join(claude, 'backups'));
  const vols = fakeVolumes(base);
  const r = await storage.scanStorage({ claudeDir: claude, homeDir: path.join(base, 'home'), env: {}, volumes: vols.opts });
  const by = Object.fromEntries(r.claude.entries.map((e) => [e.name, e]));
  const p = by.projects;
  assert.strictEqual(p.isSymlink, true);
  assert.strictEqual(p.symlinkTarget, ext);
  assert.strictEqual(p.volume, vols.big);
  const linkLen = fs.lstatSync(path.join(ext, '-p', 'link-to-big')).size;
  assert.strictEqual(p.bytes, 4000 + linkLen, 'symlinks count only their own size; hard links count once');
  assert.strictEqual(p.files, 2);
  assert.strictEqual(by.cache.isSymlink, true);
  assert.strictEqual(by.cache.sameAs, 'projects');
  assert.strictEqual(by.cache.bytes, 0);
  assert.strictEqual(by.backups.isSymlink, true);
  assert.strictEqual(by.backups.error, 'TARGET_MISSING');
  assert.strictEqual(by.backups.symlinkTarget, path.join(base, 'Unplugged', 'x'));
  assert.strictEqual(r.claude.totalBytes, p.bytes, 'total does not double count');
  // The whole data directory is a symlink
  const linkedHome = path.join(base, 'home2');
  fs.mkdirSync(linkedHome);
  fs.symlinkSync(claude, path.join(linkedHome, '.claude'));
  const r2 = await storage.scanStorage({ claudeDir: path.join(linkedHome, '.claude'), homeDir: linkedHome, env: {}, volumes: vols.opts });
  assert.strictEqual(r2.claude.isSymlink, true);
  assert.strictEqual(r2.claude.symlinkTarget, claude);
});

test('Scan errors do not throw: unreadable subdirectories are counted in errors; missing data directory -> exists=false; yields to the event loop in batches', async () => {
  const base = path.join(TMP, 'errs');
  const claude = path.join(base, '.claude');
  for (let i = 0; i < 300; i++) write(path.join(claude, 'projects', 'p' + (i % 5), `f${i}.jsonl`), 10);
  const locked = path.join(claude, 'projects', 'locked');
  fs.mkdirSync(locked);
  write(path.join(locked, 'x'), 5);
  const canLock = typeof process.getuid !== 'function' || process.getuid() !== 0;
  if (canLock) fs.chmodSync(locked, 0o000);
  let yields = 0;
  let immediates = 0;
  let stop = false;
  const spin = () => { if (stop) return; immediates++; setImmediate(spin); };
  setImmediate(spin);
  try {
    const r = await storage.scanStorage({ claudeDir: claude, homeDir: base, env: {}, volumes: { roots: ['/'], statfs: () => ({ freeBytes: 1, totalBytes: 2, writable: true }) }, yieldEvery: 20, batch: 8, onYield: () => { yields++; } });
    const p = r.claude.entries.find((e) => e.name === 'projects');
    assert.strictEqual(p.bytes, 3000);
    if (canLock && process.platform !== 'win32') assert.ok(p.errors >= 1, 'unreadable directory is counted in errors');
    assert.ok(yields >= 10, `yield count ${yields}`);
    assert.ok(immediates >= 10, `other callbacks keep running during the scan (${immediates})`);
  } finally {
    stop = true;
    if (canLock) fs.chmodSync(locked, 0o755);
  }
  const none = await storage.scanStorage({ claudeDir: path.join(base, 'nope'), codexHome: path.join(base, 'nope2'), homeDir: base, env: {}, volumes: { roots: [] } });
  assert.deepStrictEqual([none.claude.exists, none.claude.entries.length, none.codex.exists], [false, 0, false]);
  assert.strictEqual(none.cleanupPeriodDays, null);
  // File count limit: stop and mark as partial
  const cut = await storage.scanStorage({ claudeDir: claude, homeDir: base, env: {}, volumes: { roots: [] }, maxFiles: 50 });
  assert.strictEqual(cut.partial, true);
  assert.ok(cut.claude.entries.find((e) => e.name === 'projects').partial);
});

test('readCleanupPeriodDays: unset / bad JSON -> null; 0 and positive numbers are read as is', () => {
  const d = path.join(TMP, 'cleanup');
  fs.mkdirSync(d, { recursive: true });
  assert.strictEqual(storage.readCleanupPeriodDays(d), null);
  fs.writeFileSync(path.join(d, 'settings.json'), '{ "cleanupPeriodDays": ');
  assert.strictEqual(storage.readCleanupPeriodDays(d), null);
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ cleanupPeriodDays: '30' }));
  assert.strictEqual(storage.readCleanupPeriodDays(d), null);
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 7 }));
  assert.strictEqual(storage.readCleanupPeriodDays(d), 7);
  assert.strictEqual(storage.readCleanupPeriodDays(''), null);
});

test('sessionStorage: transcript, <project>/<sid>/, file-history/<sid>; Codex reports only the rollout; no paths are built for an invalid session id', async () => {
  const base = path.join(TMP, 'sess');
  const claude = path.join(base, '.claude');
  const proj = path.join(claude, 'projects', '-work-a');
  write(path.join(proj, 'sid-1.jsonl'), 777);
  write(path.join(proj, 'sid-1', 'subagents', 'a.jsonl'), 100);
  write(path.join(proj, 'sid-1', 'workflows', 'wf_1', 'journal.jsonl'), 23);
  write(path.join(claude, 'file-history', 'sid-1', 'x@v1'), 9);
  const s = await storage.sessionStorage({ claudeDir: claude, projectDir: proj, sessionId: 'sid-1', transcript: path.join(proj, 'sid-1.jsonl') });
  assert.deepStrictEqual([s.transcriptBytes, s.subagentsBytes, s.fileHistoryBytes], [777, 123, 9]);
  assert.strictEqual(s.subagentsDir, path.join(proj, 'sid-1'));
  assert.strictEqual(s.fileHistoryDir, path.join(claude, 'file-history', 'sid-1'));
  // No subagents, no file-history -> 0; without projectDir, the transcript's directory is used
  write(path.join(proj, 'sid-2.jsonl'), 5);
  const s2 = await storage.sessionStorage({ claudeDir: claude, sessionId: 'sid-2', transcript: path.join(proj, 'sid-2.jsonl') });
  assert.deepStrictEqual([s2.transcriptBytes, s2.subagentsBytes, s2.fileHistoryBytes], [5, 0, 0]);
  // Codex: rollout only
  write(path.join(base, 'rollout.jsonl'), 42);
  const cx = await storage.sessionStorage({ transcript: path.join(base, 'rollout.jsonl'), sessionId: 'thread-1' });
  assert.deepStrictEqual([cx.transcriptBytes, cx.subagentsBytes, cx.fileHistoryBytes], [42, null, null]);
  const bad = await storage.sessionStorage({ claudeDir: claude, projectDir: proj, sessionId: '../..', transcript: path.join(proj, 'missing.jsonl') });
  assert.deepStrictEqual([bad.transcriptBytes, bad.subagentsBytes, bad.fileHistoryBytes, bad.subagentsDir], [null, null, null, null]);
});

// ---------- Volumes and default target ----------

test('Volumes: the real listVolumes returns at least one system volume; default target = the writable non-system volume with the most free space that does not already hold the data', () => {
  const real = storage.listVolumes();
  assert.ok(real.length >= 1 && real.some((v) => v.system), 'the host has at least one system volume');
  assert.ok(real.every((v) => v.totalBytes > 0 && v.freeBytes >= 0 && typeof v.name === 'string'));
  const vols = [
    { mount: '/', freeBytes: 39 * GB, totalBytes: 228 * GB, system: true, writable: true },
    { mount: '/Volumes/My Disk', freeBytes: 440 * GB, totalBytes: 1000 * GB, system: false, writable: true },
    { mount: '/Volumes/Small', freeBytes: 20 * GB, totalBytes: 64 * GB, system: false, writable: true },
    { mount: '/Volumes/Installer', freeBytes: 900 * GB, totalBytes: 1000 * GB, system: false, writable: false },
  ];
  assert.strictEqual(storage.pickTargetVolume(vols, '/', 'darwin').mount, '/Volumes/My Disk');
  // Data is already on My Disk: pick another one
  assert.strictEqual(storage.pickTargetVolume(vols, '/Volumes/My Disk', 'darwin').mount, '/Volumes/Small');
  assert.strictEqual(storage.pickTargetVolume([vols[0], vols[3]], '/', 'darwin'), null, 'never picks read-only or system volumes');
  assert.strictEqual(storage.defaultBase('claude', vols, '/', 'darwin'), '/Volumes/My Disk/AI-Data/claude');
  assert.strictEqual(storage.defaultBase('codex', [vols[0]], '/', 'darwin'), null);
  assert.strictEqual(storage.volumeOf('/Volumes/My Disk/软件/x', vols, 'darwin'), '/Volumes/My Disk');
  assert.strictEqual(storage.volumeOf('/Users/demo/.claude', vols, 'darwin'), '/');
  assert.strictEqual(storage.volumeOf('/Volumes/My Diskette/x', vols, 'darwin'), '/', 'prefix match must respect directory boundaries');
  const win = [
    { mount: 'C:\\', freeBytes: 30 * GB, totalBytes: 256 * GB, system: true, writable: true },
    { mount: 'D:\\', freeBytes: 300 * GB, totalBytes: 1000 * GB, system: false, writable: true },
    { mount: 'E:\\', freeBytes: 100 * GB, totalBytes: 500 * GB, system: false, writable: true },
  ];
  assert.strictEqual(storage.volumeOf('c:\\Users\\Demo\\.claude', win, 'win32'), 'C:\\');
  assert.strictEqual(storage.defaultBase('claude', win, 'C:\\', 'win32'), 'D:\\AI-Data\\claude');
  // listVolumes: injected mount points + fake statfs; system drive first
  const lv = storage.listVolumes({ platform: 'win32', roots: ['E:\\', 'C:\\', 'D:\\'], env: { SystemDrive: 'C:' }, statfs: (m) => ({ freeBytes: 1, totalBytes: 2, writable: m !== 'E:\\' }) });
  assert.deepStrictEqual(lv.map((v) => [v.mount, v.name, v.system, v.writable]), [['C:\\', 'C:', true, true], ['D:\\', 'D:', false, true], ['E:\\', 'E:', false, false]]);
  assert.strictEqual(storage._internal.decodeMount('/media/me/My\\040Disk'), '/media/me/My Disk');
});

// ---------- Migration commands ----------

test('Plan A (macOS): paths with spaces and Chinese characters are always single-quoted and split back to the exact original path; the terminal version is one line with no newlines', () => {
  const src = '/Users/demo/.claude/projects';
  const dst = "/Volumes/My Disk/软件/Bob's AI-Data/claude/projects";
  const p = storage.migrationPlan({ platform: 'darwin', kind: 'symlink', app: 'claude', source: src, target: dst });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.shell, 'posix');
  assert.ok(!p.oneLine.includes('\n') && !p.oneLine.includes('\r'), 'the command sent to the terminal has no newlines (otherwise it would run)');
  assert.strictEqual(p.commands.replace(/ \\\n {2}&& /g, ' && '), p.oneLine, 'the multi-line copy version only uses line continuations');
  const steps = posixSteps(p.oneLine);
  assert.deepStrictEqual(steps, [
    ['test', '-d', src],
    ['test', '!', '-L', src],
    ['test', '!', '-e', src + '.bak'],
    ['mkdir', '-p', dst],
    ['rsync', '-a', src + '/', dst + '/'],
    ['mv', src, src + '.bak'],
    ['ln', '-s', dst, src],
  ]);
  // Every path argument is single-quoted
  assert.ok(p.oneLine.includes("'/Volumes/My Disk/软件/Bob'\\''s AI-Data/claude/projects'"));
  assert.deepStrictEqual(posixSteps(p.cleanup), [['rm', '-rf', src + '.bak']]);
  assert.deepStrictEqual(posixSteps(p.rollback), [
    ['test', '-L', src], ['test', '-d', src + '.bak'], ['rsync', '-a', dst + '/', src + '.bak/'], ['rm', src], ['mv', src + '.bak', src],
  ]);
  assert.strictEqual(p.env, null);
  assert.ok(p.notes.length >= 2 && p.notes.every((n) => typeof n === 'string' && n && !/\{\w+\}/.test(n)));
  // Trailing separators are removed
  const q = storage.migrationPlan({ platform: 'linux', kind: 'symlink', app: 'codex', source: '/home/me/.codex/sessions/', target: '/media/me/Data 盘/AI-Data/codex/sessions/' });
  assert.deepStrictEqual(posixSteps(q.oneLine)[4], ['rsync', '-a', '/home/me/.codex/sessions/', '/media/me/Data 盘/AI-Data/codex/sessions/']);
  assert.ok(q.notes.some((n) => n.includes('cp -a')), 'Linux notes mention the fallback when rsync is missing');
});

test('Plan A (Windows): robocopy + Rename-Item .bak + mklink /J, PowerShell single quotes (an inner \' becomes \'\')', () => {
  const src = 'C:\\Users\\Demo User\\.claude\\projects';
  const dst = "D:\\AI-Data\\软件\\O'Neil\\claude\\projects";
  const p = storage.migrationPlan({ platform: 'win32', kind: 'symlink', app: 'claude', source: src, target: dst });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.shell, 'powershell');
  assert.ok(!/[\r\n]/.test(p.oneLine));
  assert.strictEqual(p.commands, p.oneLine);
  assert.ok(/robocopy '[^']+' '(?:[^']|'')+' \/E /.test(p.oneLine), p.oneLine);
  assert.ok(p.oneLine.includes(`cmd /c mklink /J '${src}' 'D:\\AI-Data\\软件\\O''Neil\\claude\\projects'`));
  assert.ok(p.oneLine.includes(`Rename-Item -LiteralPath '${src}' -NewName 'projects.bak'`));
  assert.ok(p.oneLine.includes('$LASTEXITCODE -lt 8'), 'robocopy exit codes 0-7 all count as success');
  const strs = pwshStrings(p.oneLine);
  assert.ok(strs.includes(src) && strs.includes(dst) && strs.includes(src + '.bak'));
  assert.ok(!p.oneLine.includes('"'), 'no double quotes (avoids $ expansion)');
  assert.strictEqual(p.cleanup, `Remove-Item -LiteralPath '${src}.bak' -Recurse -Force`);
  assert.ok(p.rollback.includes(`cmd /c rmdir '${src}'`), 'rollback removes only the junction itself');
  assert.ok(p.notes.some((n) => n.includes('mklink /J')));
});

test('Plan B: CLAUDE_CONFIG_DIR / CODEX_HOME setting snippets; copies ~/.claude.json when using the default directory; Windows version', () => {
  const home = '/Users/demo';
  const dst = '/Volumes/My Disk/AI-Data/claude';
  const p = storage.migrationPlan({ platform: 'darwin', kind: 'env', app: 'claude', source: home + '/.claude', target: dst, homeDir: home });
  assert.strictEqual(p.ok, true);
  const steps = posixSteps(p.oneLine);
  assert.deepStrictEqual(steps.slice(3), [
    ['mkdir', '-p', dst], ['rsync', '-a', home + '/.claude/', dst + '/'],
    ['cp', '-p', home + '/.claude.json', dst + '/.claude.json'], ['mv', home + '/.claude', home + '/.claude.bak'],
  ]);
  assert.deepStrictEqual(p.env.name, 'CLAUDE_CONFIG_DIR');
  assert.deepStrictEqual(JSON.parse('{' + p.env.vscodeSetting + '}'), { 'claudeCode.environmentVariables': [{ name: 'CLAUDE_CONFIG_DIR', value: dst }] });
  assert.deepStrictEqual(posixWords(p.env.shellLine), ['export', 'CLAUDE_CONFIG_DIR=' + dst]);
  assert.deepStrictEqual(JSON.parse('{' + p.monitorSetting + '}'), { 'agentMonitor.claude.projectsDir': dst + '/projects' });
  assert.ok(p.notes.some((n) => n.includes('claudeCode.environmentVariables')));
  assert.ok(p.notes.some((n) => /not verified/.test(n)), 're-login is stated as not verified');
  // Not the default directory: .claude.json is not copied
  const p2 = storage.migrationPlan({ platform: 'darwin', kind: 'env', app: 'claude', source: '/data/claude-cfg', target: dst, homeDir: home });
  assert.ok(!p2.oneLine.includes('.claude.json'));
  // Codex: no VS Code setting snippet
  const c = storage.migrationPlan({ platform: 'darwin', kind: 'env', app: 'codex', source: home + '/.codex', target: '/Volumes/My Disk/AI-Data/codex', homeDir: home });
  assert.strictEqual(c.env.name, 'CODEX_HOME');
  assert.strictEqual(c.env.vscodeSetting, null);
  assert.deepStrictEqual(JSON.parse('{' + c.monitorSetting + '}'), { 'agentMonitor.codex.home': '/Volumes/My Disk/AI-Data/codex' });
  // Windows
  const w = storage.migrationPlan({ platform: 'win32', kind: 'env', app: 'claude', source: 'C:\\Users\\Demo\\.claude', target: 'D:\\AI-Data\\claude', homeDir: 'C:\\Users\\Demo' });
  assert.ok(w.oneLine.includes("Copy-Item -LiteralPath 'C:\\Users\\Demo\\.claude.json' -Destination 'D:\\AI-Data\\claude\\.claude.json'"));
  assert.strictEqual(w.env.shellLine, "[Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'D:\\AI-Data\\claude', 'User')");
  assert.deepStrictEqual(JSON.parse('{' + w.env.vscodeSetting + '}')['claudeCode.environmentVariables'][0].value, 'D:\\AI-Data\\claude');
});

test('Migration commands: never generated for relative paths, identical paths, nested paths, or paths containing newlines', () => {
  const mk = (source, target, platform = 'darwin') => storage.migrationPlan({ platform, kind: 'symlink', app: 'claude', source, target });
  assert.strictEqual(mk('~/.claude/projects', '/Volumes/X/p').error, 'NOT_ABSOLUTE');
  assert.strictEqual(mk('/a/projects', '').error, 'NOT_ABSOLUTE');
  assert.strictEqual(mk('/a/projects', '/A/Projects/').error, 'SAME_PATH', 'macOS is case-insensitive');
  assert.strictEqual(mk('/a/projects', '/a/projects/new').error, 'TARGET_INSIDE_SOURCE');
  assert.strictEqual(mk('/a/projects', '/a').error, 'SOURCE_INSIDE_TARGET');
  assert.strictEqual(mk('/a/projects', '/b/x\ny').error, 'BAD_PATH');
  assert.strictEqual(mk('C:\\a\\projects', 'c:\\A\\projects', 'win32').error, 'SAME_PATH');
  for (const e of ['NOT_ABSOLUTE', 'SAME_PATH', 'TARGET_INSIDE_SOURCE', 'SOURCE_INSIDE_TARGET', 'BAD_PATH']) {
    assert.ok(en.has('storage.plan.error.' + e), e);
  }
  const bad = mk('/a/projects', '/a/projects/new');
  assert.deepStrictEqual([bad.ok, bad.commands, bad.oneLine], [false, '', '']);
});

// ---------- View model ----------

async function syntheticReport(base) {
  const { home, claude, codex } = makeClaudeHome(base);
  const vols = fakeVolumes(base);
  const report = await storage.scanStorage({ claudeDir: claude, codexHome: codex, homeDir: home, env: {}, volumes: vols.opts });
  return { home, claude, codex, vols, report };
}

test('View model: entry text, volume tags, default target on the external disk with the most free space at AI-Data/<app>/<subdir>, warnings for open sessions', async () => {
  const base = path.join(TMP, 'vm');
  const { home, claude, vols, report } = await syntheticReport(base);
  const live = [{ provider: 'claude', sessionId: 's1', title: 'Refactor payments' }, { provider: 'codex', sessionId: 't1', title: 'Fix CI' }];
  const { vm, paths, plans } = SV.buildStorageVm({ report, i18n: en, platform: 'darwin', home, live, now: report.at });
  assert.strictEqual(vm.dirs.length, 2);
  const c = vm.dirs[0];
  assert.strictEqual(c.pathText, '~/.claude');
  assert.strictEqual(paths.get(c.pathId), claude);
  const proj = c.entries.find((e) => e.name === 'projects');
  assert.strictEqual(proj.sizeText, '1.5 kB');
  assert.strictEqual(proj.filesText, '3');
  assert.strictEqual(paths.get(proj.pathId), path.join(claude, 'projects'));
  assert.ok(c.entries.find((e) => e.rest).name.startsWith('Everything else (3'));
  assert.strictEqual(vm.retention.text, '14 days (cleanupPeriodDays)');
  // Volumes
  const bigRow = vm.volumes.rows.find((r) => r.name === 'My Disk');
  assert.ok(bigRow.tags.includes('Suggested target'));
  assert.strictEqual(bigRow.freeText, '440 GB free of 1 TB');
  assert.strictEqual(bigRow.usedPct, 56);
  const sys = vm.volumes.rows[0];
  assert.ok(sys.tags.includes('System disk') && sys.tags.includes('Claude Code data'));
  assert.ok(vm.volumes.rows.find((r) => r.name === 'RO').tags.includes('Read-only'));
  // Migration: default target
  const card = vm.migrate.cards.find((x) => x.app === 'claude');
  assert.strictEqual(card.target.text, path.join(vols.big, 'AI-Data', 'claude'));
  const a = plans.get('claude|symlink');
  assert.strictEqual(a.target, path.join(vols.big, 'AI-Data', 'claude', 'projects'));
  assert.strictEqual(a.source, path.join(claude, 'projects'));
  assert.strictEqual(plans.get('claude|env').target, path.join(vols.big, 'AI-Data', 'claude'));
  assert.strictEqual(plans.get('codex|symlink').target, path.join(vols.big, 'AI-Data', 'codex', 'sessions'));
  // Open sessions: listed on their own app's card
  assert.ok(card.live && card.live.text.includes('(1)'));
  assert.deepStrictEqual(card.live.items, ['Refactor payments']);
  const cx = vm.migrate.cards.find((x) => x.app === 'codex');
  assert.deepStrictEqual(cx.live.items, ['Fix CI']);
  const quiet = SV.buildStorageVm({ report, i18n: en, platform: 'darwin', home, live: [] });
  assert.ok(quiet.vm.migrate.cards.every((x) => x.live === null));
  // Steps: Plan A's commands can be copied or sent to the terminal; cleanup and rollback can only be copied
  const pa = card.plans.find((x) => x.kind === 'symlink');
  const run = pa.steps.find((s) => s.part === 'commands');
  assert.deepStrictEqual(run.actions, ['copy', 'terminal']);
  assert.strictEqual(run.code, a.commands);
  assert.deepStrictEqual(pa.steps.filter((s) => s.part && s.part !== 'commands').map((s) => [s.part, s.actions.join()]), [['cleanup', 'copy'], ['rollback', 'copy']]);
  const pb = card.plans.find((x) => x.kind === 'env');
  assert.deepStrictEqual(pb.steps.filter((s) => s.part).map((s) => s.part), ['commands', 'vscodeSetting', 'shellLine', 'monitorSetting', 'cleanup', 'rollback']);
  // Notes are listed in full
  assert.strictEqual(vm.notes.items.length, 6);
  assert.ok(vm.notes.items.some((n) => /iCloud/.test(n)) && vm.notes.items.some((n) => /mklink \/J/.test(n)));
});

test('View model: user-picked folder, same disk, synced folder, not enough space, already moved, no other disk', async () => {
  const base = path.join(TMP, 'vm2');
  const { home, report, vols } = await syntheticReport(base);
  const build = (o) => SV.buildStorageVm({ report, i18n: en, platform: 'darwin', home, live: [], ...o });
  // A picked folder named claude is used as is; otherwise data goes into <picked>/claude
  assert.strictEqual(SV._internal.baseFromPick('/Volumes/X/Backup', 'claude', 'darwin'), '/Volumes/X/Backup/claude');
  assert.strictEqual(SV._internal.baseFromPick('/Volumes/X/Claude/', 'claude', 'darwin'), '/Volumes/X/Claude');
  assert.strictEqual(SV._internal.baseFromPick('D:\\', 'codex', 'win32'), 'D:\\codex');
  const custom = build({ bases: { claude: path.join(vols.small, 'Mine', 'claude') } });
  const card = custom.vm.migrate.cards.find((c) => c.app === 'claude');
  assert.strictEqual(card.target.custom, true);
  assert.strictEqual(custom.plans.get('claude|symlink').target, path.join(vols.small, 'Mine', 'claude', 'projects'));
  // Same disk (data is on /)
  const same = build({ bases: { claude: path.join(home, 'Elsewhere', 'claude') } });
  assert.ok(same.vm.migrate.cards[0].warnings.some((w) => /same disk/.test(w)));
  // Synced folder
  const synced = build({ bases: { claude: '/Users/demo/Library/Mobile Documents/com~apple~CloudDocs/claude' } });
  assert.ok(synced.vm.migrate.cards[0].warnings.some((w) => /synced folder/.test(w)));
  assert.ok(SV._internal.SYNCED_RE.test('C:\\Users\\me\\OneDrive\\claude') && !SV._internal.SYNCED_RE.test('/Volumes/My Disk/AI-Data/claude'));
  // Read-only disk, not enough space
  const ro = build({ bases: { claude: path.join(vols.ro, 'claude') } });
  assert.ok(ro.vm.migrate.cards[0].warnings.some((w) => /read-only/.test(w)));
  const tiny = JSON.parse(JSON.stringify(report));
  tiny.volumes.find((v) => v.mount === vols.big).freeBytes = 100;
  const full = SV.buildStorageVm({ report: tiny, i18n: en, platform: 'darwin', home, live: [], bases: { claude: path.join(vols.big, 'claude') } });
  assert.ok(full.vm.migrate.cards[0].plans[0].warnings.some((w) => /Not enough free space/.test(w)));
  // Target already contains files
  const probe = { exists: () => true, nonEmptyDir: (p) => p.endsWith('projects') };
  const merged = build({ probe });
  assert.ok(merged.vm.migrate.cards[0].plans[0].warnings.some((w) => /already has files/.test(w)));
  // projects is already a symlink: Plan A shows it as moved and generates no commands
  const linked = JSON.parse(JSON.stringify(report));
  const pe = linked.claude.entries.find((e) => e.name === 'projects');
  Object.assign(pe, { isSymlink: true, symlinkTarget: '/Volumes/My Disk/AI-Data/claude/projects' });
  const lv = SV.buildStorageVm({ report: linked, i18n: en, platform: 'darwin', home, live: [] });
  const la = lv.vm.migrate.cards[0].plans[0];
  assert.ok(/Already moved/.test(la.info) && la.steps.length === 0);
  assert.strictEqual(lv.paths.get(la.infoId), '/Volumes/My Disk/AI-Data/claude/projects');
  assert.ok(!lv.plans.has('claude|symlink') && lv.plans.has('claude|env'));
  // No other writable disk
  const lone = JSON.parse(JSON.stringify(report));
  lone.volumes = lone.volumes.filter((v) => v.system);
  const nv = SV.buildStorageVm({ report: lone, i18n: en, platform: 'darwin', home, live: [] });
  assert.strictEqual(nv.vm.migrate.cards[0].target.text, '');
  assert.ok(/No other writable disk/.test(nv.vm.migrate.cards[0].plans[0].errorText));
  assert.strictEqual(nv.plans.size, 0);
  // Scan not finished yet
  const loading = SV.buildStorageVm({ report: null, loading: true, i18n: en, platform: 'darwin', home });
  assert.deepStrictEqual([loading.vm.dirs.length, loading.vm.statusText], [0, 'Measuring folder sizes…']);
});

test('View model: Windows button labels and commands; no unreplaced placeholders or missing keys in any of the five languages', async () => {
  const base = path.join(TMP, 'vm3');
  const { home, report } = await syntheticReport(base);
  const w = SV.buildStorageVm({ report, i18n: en, platform: 'win32', home, live: [] });
  assert.strictEqual(w.vm.labels.reveal, 'Reveal in File Explorer');
  assert.ok(/directory junction/.test(w.vm.migrate.cards[0].plans[0].label));
  for (const locale of LOCALES) {
    const i18n = i18nLib.createI18n(locale, { timeZone: 'UTC' });
    const used = new Set();
    const spy = { ...i18n, t: (k, v) => { used.add(k); return i18n.t(k, v); } };
    const live = [{ provider: 'claude', sessionId: 's', title: 't' }];
    const texts = [];
    for (const platform of ['darwin', 'win32', 'linux']) {
      const out = SV.buildStorageVm({ report, i18n: spy, platform, home, live, error: 'EIO', now: report.at });
      const walk = (x) => { if (typeof x === 'string') texts.push(x); else if (x && typeof x === 'object') Object.values(x).forEach(walk); };
      walk(out.vm);
      for (const p of out.plans.values()) texts.push(...p.notes);
    }
    for (const s of texts) assert.ok(!/\{\w+\}/.test(s), `${locale}: unreplaced placeholder ${s}`);
    const missing = [...used].filter((k) => !i18n.has(k) && !/^storage\.item\./.test(k));
    assert.deepStrictEqual(missing, [], `${locale} missing strings`);
  }
});

test('fmtBytes: decimal units, locale-aware', () => {
  assert.strictEqual(SV.fmtBytes(0, en), '0 byte');
  assert.strictEqual(SV.fmtBytes(71306, en), '71.3 kB');
  assert.strictEqual(SV.fmtBytes(932e6, en), '932 MB');
  assert.strictEqual(SV.fmtBytes(1.2e9, en), '1.2 GB');
  assert.strictEqual(SV.fmtBytes(null, en), '—');
  assert.strictEqual(SV.fmtBytes(-1, en), '—');
});

// ---------- Page HTML ----------

test('Page HTML: CSP allows only cspSource and the nonce; only a JSON data block and a nonce script; no inline styles; dictionary includes storage.page.*', () => {
  const html = SV.storageHtml({ cspSource: 'vscode-webview://abc', asset: (p) => 'https://asset/' + p, nonce: 'N0NCE', i18n: i18nLib.createI18n('zh-cn') });
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1].replace(/&#39;/g, "'");
  assert.strictEqual(csp, "default-src 'none'; style-src vscode-webview://abc; font-src vscode-webview://abc; script-src 'nonce-N0NCE'");
  assert.ok(!/unsafe-/.test(html));
  const scripts = html.match(/<script[^>]*>/g);
  assert.deepStrictEqual(scripts, ['<script type="application/json" id="l10n">', '<script nonce="N0NCE" src="https://asset/storage.js">']);
  assert.ok(!/\sstyle=/.test(html) && !/<style/.test(html), 'no inline styles');
  assert.ok(html.includes('<html lang="zh-CN">'));
  assert.ok(html.includes('href="https://asset/codicons/codicon.css"') && html.includes('href="https://asset/storage.css"'));
  const json = html.slice(html.indexOf('id="l10n">') + 10, html.indexOf('</script>'));
  const payload = JSON.parse(json);
  assert.ok(Object.keys(payload.dict).length > 0 && Object.keys(payload.dict).every((k) => k.startsWith('storage.page.')));
  assert.ok(payload.dict['storage.page.loading']);
  // A < in text cannot close the script block early
  const evil = { ...en, t: () => '</script><img src=x>' };
  const h2 = SV.storageHtml({ cspSource: 'x', asset: (p) => p, nonce: 'n', i18n: evil });
  assert.ok(!h2.includes('<img'));
});

test('media/storage.js, storage.css: no innerHTML, no direct terminal access; no opacity; font size not below the UI font size', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'storage.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/.test(js));
  assert.ok(!/sendText|createTerminal/.test(js));
  for (const type of ['ready', 'refresh', 'reveal', 'copyPath', 'pickTarget', 'resetTarget', 'copy', 'terminal']) {
    assert.ok(js.includes(`type: '${type}'`), type);
  }
  const css = fs.readFileSync(path.join(ROOT, 'media', 'storage.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/opacity/.test(css), 'no opacity dimming');
  for (const m of css.matchAll(/font-size:\s*([^;]+);/g)) {
    assert.ok(/var\(--vscode-font-size\)|inherit/.test(m[1]), `font size ${m[1]}`);
  }
  assert.ok(/overflow-x:\s*hidden/.test(css) && /@media \(max-width: 640px\)/.test(css));
});

// ---------- WebviewPanel ----------

test('Panel: singleton; posts the view model after ready; refresh passes force; Reveal in Finder and Copy Path accept only extension-issued ids', async () => {
  const base = path.join(TMP, 'panel1');
  const { home, claude, report } = await syntheticReport(base);
  const { vscode, log } = makeVscode();
  const calls = [];
  const deps = { vscode, i18n: en, platform: 'darwin', home, liveSessions: () => [], requestStorage: async (force) => { calls.push(force); return report; } };
  const ctx = { extensionUri: vscode.Uri.file(ROOT) };
  const a = SV.openStorageView(ctx, deps);
  const b = SV.openStorageView(ctx, deps);
  assert.strictEqual(a, b, 'singleton');
  assert.strictEqual(log.panels.length, 1);
  const panel = log.panels[0];
  assert.strictEqual(panel.revealed, 1);
  assert.strictEqual(panel.type, 'agentMonitor.storage');
  assert.deepStrictEqual(panel.options.localResourceRoots.map((u) => u.fsPath), [path.join(ROOT, 'media')]);
  assert.ok(/script-src 'nonce-[A-Za-z0-9+/=]+'/.test(panel.webview.html.replace(/&#39;/g, "'")));
  await a.onMessage({ type: 'ready' });
  await new Promise((r) => setImmediate(r));
  const last = panel.posted[panel.posted.length - 1];
  assert.strictEqual(last.type, 'vm');
  assert.strictEqual(last.vm.dirs[0].pathText, '~/.claude');
  await a.onMessage({ type: 'refresh' });
  assert.deepStrictEqual(calls, [false, false, true]);
  // Reveal in Finder: the real path is looked up by id
  const vm = last.vm;
  const proj = vm.dirs[0].entries.find((e) => e.name === 'projects');
  await a.onMessage({ type: 'reveal', id: proj.pathId });
  assert.deepStrictEqual(log.executed.map((x) => [x[0], x[1].fsPath]), [['revealFileInOS', path.join(claude, 'projects')]]);
  await a.onMessage({ type: 'reveal', id: 'nope' });
  await a.onMessage({ type: 'reveal', path: '/etc' });
  assert.strictEqual(log.executed.length, 1, 'ignores paths sent by the webview');
  await a.onMessage({ type: 'copyPath', id: proj.pathId });
  assert.deepStrictEqual(log.clipboard, [path.join(claude, 'projects')]);
  panel.dispose();
  assert.strictEqual(a.disposed, true);
  const c = SV.openStorageView(ctx, deps);
  assert.notStrictEqual(c, a, 'reopening after close creates a new panel');
  c.dispose();
});

test('Panel: copy command, open in terminal (sendText second argument is false, single-line command); a modal warning comes first when sessions are open', async () => {
  const base = path.join(TMP, 'panel2');
  const { home, claude, report, vols } = await syntheticReport(base);
  const { vscode, log, ctl } = makeVscode();
  let live = [{ provider: 'claude', sessionId: 's1', title: 'Refactor payments' }];
  const deps = { vscode, i18n: en, platform: 'darwin', home, liveSessions: () => live, requestStorage: async () => report };
  const p = SV.openStorageView({ extensionUri: vscode.Uri.file(ROOT) }, deps);
  await p.onMessage({ type: 'ready' });
  await new Promise((r) => setImmediate(r));
  const plan = p.plans.get('claude|symlink');
  assert.ok(plan && plan.ok);
  // Sessions are open: warn first; cancel -> do nothing
  ctl.warnAnswer = undefined;
  await p.onMessage({ type: 'terminal', app: 'claude', kind: 'symlink', ack: true });
  assert.strictEqual(log.terminals.length, 0);
  assert.strictEqual(log.warn.length, 1);
  assert.strictEqual(log.warn[0].rest[0].modal, true);
  assert.ok(log.warn[0].rest[0].detail.includes('Refactor payments'));
  await p.onMessage({ type: 'copy', app: 'claude', kind: 'symlink', part: 'commands', ack: true });
  assert.deepStrictEqual(log.clipboard, []);
  // Choose "Continue Anyway"
  ctl.warnAnswer = 'Continue Anyway';
  await p.onMessage({ type: 'terminal', app: 'claude', kind: 'symlink', ack: true });
  assert.strictEqual(log.terminals.length, 1);
  const term = log.terminals[0];
  assert.strictEqual(term.shown, 1);
  assert.strictEqual(term.sent.length, 1);
  assert.strictEqual(term.sent[0][1], false, 'sendText second argument must be false (no Enter)');
  assert.strictEqual(term.sent[0][0], plan.oneLine);
  assert.ok(!/[\r\n]/.test(term.sent[0][0]));
  assert.strictEqual(term.opts.shellPath, undefined);
  // All sessions closed: no more warning
  live = [];
  const warnBefore = log.warn.length;
  await p.onMessage({ type: 'copy', app: 'claude', kind: 'symlink', part: 'commands', ack: true });
  assert.deepStrictEqual(log.clipboard, [plan.commands]);
  assert.strictEqual(log.warn.length, warnBefore);
  await p.onMessage({ type: 'copy', app: 'claude', kind: 'env', part: 'vscodeSetting', ack: true });
  assert.ok(log.clipboard[1].includes('claudeCode.environmentVariables'));
  // Unknown step, app or plan -> ignored
  await p.onMessage({ type: 'copy', app: 'claude', kind: 'symlink', part: 'oneLine; rm -rf /', ack: true });
  await p.onMessage({ type: 'copy', app: 'evil', kind: 'symlink', part: 'commands', ack: true });
  await p.onMessage({ type: 'terminal', app: 'claude', kind: 'bogus', ack: true });
  await p.onMessage({ type: 'terminal', app: 'claude', kind: 'symlink', command: 'rm -rf ~', ack: true });
  assert.strictEqual(log.clipboard.length, 2);
  assert.strictEqual(log.terminals.length, 2);
  assert.deepStrictEqual(log.terminals[1].sent, [[plan.oneLine, false]], 'command sent by the webview is not used');
  // Pick another folder: the target follows; then reset to the suggested one
  ctl.pick = path.join(vols.small, 'Backups');
  await p.onMessage({ type: 'pickTarget', app: 'claude' });
  assert.strictEqual(log.dialogs[0].canSelectFolders, true);
  assert.strictEqual(log.dialogs[0].canSelectFiles, false);
  assert.strictEqual(p.plans.get('claude|symlink').target, path.join(vols.small, 'Backups', 'claude', 'projects'));
  const posted = p.panel.posted[p.panel.posted.length - 1].vm;
  assert.strictEqual(posted.migrate.cards[0].target.custom, true);
  await p.onMessage({ type: 'terminal', app: 'claude', kind: 'symlink', ack: true });
  assert.ok(log.terminals[2].sent[0][0].includes(path.join(vols.small, 'Backups', 'claude', 'projects')));
  assert.strictEqual(log.terminals[2].sent[0][1], false);
  await p.onMessage({ type: 'resetTarget', app: 'claude' });
  assert.strictEqual(p.plans.get('claude|symlink').target, path.join(vols.big, 'AI-Data', 'claude', 'projects'));
  assert.ok(fs.existsSync(path.join(claude, 'projects')) && !fs.lstatSync(path.join(claude, 'projects')).isSymbolicLink(), 'nothing was executed');
  p.dispose();
  // Windows: PowerShell terminal
  const W = makeVscode();
  const wr = JSON.parse(JSON.stringify(report));
  const wp = SV.openStorageView({ extensionUri: W.vscode.Uri.file(ROOT) }, { ...deps, vscode: W.vscode, liveSessions: () => [], requestStorage: async () => wr, platform: 'win32' });
  await wp.onMessage({ type: 'ready' });
  await new Promise((r) => setImmediate(r));
  // The synthetic report uses POSIX paths, which are not absolute on Windows, so no commands are generated: retry with Windows paths
  wp.report = {
    at: Date.now(), homeDir: 'C:\\Users\\Demo', partial: false, cleanupPeriodDays: null,
    claude: { dir: 'C:\\Users\\Demo\\.claude', dirSource: 'default', exists: true, volume: 'C:\\', entries: [{ name: 'projects', path: 'C:\\Users\\Demo\\.claude\\projects', bytes: 10, files: 1, exists: true, kind: 'dir', isSymlink: false, symlinkTarget: null }], totalBytes: 10, totalFiles: 1 },
    codex: null,
    volumes: [{ mount: 'C:\\', name: 'C:', freeBytes: 1e9, totalBytes: 1e10, system: true, writable: true }, { mount: 'D:\\', name: 'D:', freeBytes: 5e11, totalBytes: 1e12, system: false, writable: true }],
  };
  wp.home = 'C:\\Users\\Demo';
  await wp.onMessage({ type: 'terminal', app: 'claude', kind: 'symlink', ack: true });
  const wt = W.log.terminals[0];
  assert.strictEqual(wt.opts.shellPath, 'powershell.exe');
  assert.strictEqual(wt.sent[0][1], false);
  assert.ok(wt.sent[0][0].includes("cmd /c mklink /J 'C:\\Users\\Demo\\.claude\\projects' 'D:\\AI-Data\\claude\\projects'"));
  wp.dispose();
});

test('Migration commands are reference only: without ack from the page, a modal confirmation comes first; cancel means no copy and no terminal', async () => {
  const base = path.join(TMP, 'panel-ack');
  const { home, report } = await syntheticReport(base);
  const { vscode, log, ctl } = makeVscode();
  const deps = { vscode, i18n: en, platform: 'darwin', home, liveSessions: () => [], requestStorage: async () => report };
  const p = SV.openStorageView({ extensionUri: vscode.Uri.file(ROOT) }, deps);
  await p.onMessage({ type: 'ready' });
  await new Promise((r) => setImmediate(r));
  const plan = p.plans.get('claude|symlink');
  ctl.warnAnswer = undefined;
  await p.onMessage({ type: 'copy', app: 'claude', kind: 'symlink', part: 'commands' });
  await p.onMessage({ type: 'terminal', app: 'claude', kind: 'symlink', ack: 'yes' });
  assert.deepStrictEqual(log.clipboard, []);
  assert.strictEqual(log.terminals.length, 0);
  assert.strictEqual(log.warn.length, 2);
  assert.strictEqual(log.warn[0].msg, en.t('storage.disclaimer.confirm'));
  assert.strictEqual(log.warn[0].rest[0].modal, true);
  ctl.warnAnswer = en.t('storage.disclaimer.continue');
  await p.onMessage({ type: 'copy', app: 'claude', kind: 'symlink', part: 'commands' });
  assert.deepStrictEqual(log.clipboard, [plan.commands]);
  // Once confirmed (ack: true), no more dialog
  const before = log.warn.length;
  await p.onMessage({ type: 'terminal', app: 'claude', kind: 'symlink', ack: true });
  assert.strictEqual(log.warn.length, before);
  assert.deepStrictEqual(log.terminals[0].sent, [[plan.oneLine, false]]);
  p.dispose();
});

test('Storage page: migration plans start with a disclaimer and a confirmation checkbox; copy / terminal buttons are disabled until it is ticked', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'storage.js'), 'utf8');
  assert.ok(/let ack = false;/.test(js), 'unticked by default');
  assert.ok(/type: 'checkbox', id: 'ack'/.test(js));
  assert.ok(/const lock = ack \|\| !vm\.migrate\.disclaimer \? null : vm\.migrate\.disclaimer\.locked;/.test(js));
  assert.ok(/disabled: locked/.test(js));
  assert.ok(/type: 'copy', app: d\.app, kind: d\.kind, part: d\.part, ack \}/.test(js) && /type: 'terminal', app: d\.app, kind: d\.kind, ack \}/.test(js));
  for (const k of ['storage.disclaimer.title', 'storage.disclaimer.reference', 'storage.disclaimer.check', 'storage.disclaimer.risk', 'storage.disclaimer.ack', 'storage.disclaimer.locked', 'storage.disclaimer.confirm', 'storage.disclaimer.continue']) {
    assert.notStrictEqual(en.t(k), k, k);
  }
  assert.ok(/as is/.test(en.t('storage.disclaimer.risk')) && /without warranty/.test(en.t('storage.disclaimer.risk')));
});

test('Panel: shows an error when the scan fails; stale results do not overwrite newer ones', async () => {
  const { vscode } = makeVscode();
  let n = 0;
  const resolvers = [];
  const deps = {
    vscode, i18n: en, platform: 'darwin', home: '/Users/demo', liveSessions: () => { throw new Error('boom'); },
    requestStorage: () => { n++; if (n === 1) return Promise.reject(new Error('worker gone')); return new Promise((r) => resolvers.push(r)); },
  };
  const p = SV.openStorageView({ extensionUri: vscode.Uri.file(ROOT) }, deps);
  await p.onMessage({ type: 'ready' });
  await new Promise((r) => setImmediate(r));
  let vm = p.panel.posted[p.panel.posted.length - 1].vm;
  assert.ok(/worker gone/.test(vm.errorText));
  p.load(true);
  p.load(true);
  resolvers[1]({ at: 2, claude: null, codex: null, volumes: [], cleanupPeriodDays: null });
  await new Promise((r) => setImmediate(r));
  resolvers[0]({ at: 1, claude: null, codex: null, volumes: [], cleanupPeriodDays: null });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(p.report.at, 2);
  vm = p.panel.posted[p.panel.posted.length - 1].vm;
  assert.strictEqual(vm.errorText, '');
  p.dispose();
});

// ---------- Dictionary ----------

test('l10n/storage.en.json: all keys start with storage., values are English with well-formed placeholders; every key used in code exists; the region list includes storage', () => {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'storage.en.json'), 'utf8'));
  for (const [k, v] of Object.entries(dict)) {
    assert.ok(k.startsWith('storage.'), k);
    assert.strictEqual(typeof v, 'string');
    assert.ok(v.trim(), k);
    for (const m of v.matchAll(/\{([^{}]*)\}/g)) assert.ok(/^\w+$/.test(m[1]), `${k} placeholder {${m[1]}}`);
  }
  assert.ok(!/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(JSON.stringify(dict)), 'no CJK characters in the English dictionary');
  assert.ok(i18nLib.REGIONS.includes('storage'));
  const src = ['lib/storage.js', 'lib/storage-view.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const keys = new Set([...src.matchAll(/'(storage\.[\w.-]+[\w-])'/g)].map((m) => m[1]).filter((k) => !/\.(js|css)$/.test(k)));
  const dyn = [];
  for (const app of ['claude', 'codex']) dyn.push(`storage.app.${app}`, `storage.dir.${app}`, `storage.live.${app}`, `storage.mig.${app}`);
  for (const e of ['NOT_ABSOLUTE', 'BAD_PATH', 'SAME_PATH', 'TARGET_INSIDE_SOURCE', 'SOURCE_INSIDE_TARGET']) dyn.push('storage.plan.error.' + e);
  for (const n of storage.CLAUDE_ITEMS) dyn.push('storage.item.claude.' + n);
  dyn.push('storage.item.claude.claude_json');
  for (const n of storage.CODEX_ITEMS) dyn.push('storage.item.codex.' + n);
  const missing = [...keys, ...dyn].filter((k) => !(k in dict));
  assert.deepStrictEqual(missing, []);
  // storage.page.* strings shown by the page can be injected via webviewJson (the dictionary merges all regions)
  const inj = JSON.parse(en.webviewJson(SV.STORAGE_DICT_PREFIXES)).dict;
  assert.strictEqual(inj['storage.page.loading'], dict['storage.page.loading']);
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
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
