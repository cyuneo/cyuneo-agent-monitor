'use strict';
// Storage locations, usage and migration guidance. Plain Node with no vscode dependency, usable from both the worker and the extension host.
// - scanStorage(): size of each item in the Claude / Codex data directories (recursive lstat, async, yielding to the event loop in batches;
//   symlinks inside directories are not followed; only a top-level entry that is a symlink is followed once and its target recorded),
//   free space on each volume (fs.statfsSync), and cleanupPeriodDays. Read-only; items that fail to measure are flagged rather than thrown. Rate limiting is the caller's job.
// - sessionStorage(): size of a single session's main transcript, subagent directory and file-history/<sid>.
// - migrationPlan(): generates migration command text. Paths are always quoted (spaces and non-ASCII characters are supported). The extension only generates commands and never runs them.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

// Sub-items listed for the Claude data directory; everything else is merged into a single "other" item
const CLAUDE_ITEMS = Object.freeze(['projects', 'file-history', 'plugins', 'skills', 'cache', 'backups', 'shell-snapshots']);
// Codex: common subdirectories; each *.sqlite together with its -wal / -shm / -journal counts as one item
const CODEX_ITEMS = Object.freeze(['sessions', 'archived_sessions', 'plugins', 'log', 'cache', 'skills', 'shell_snapshots']);
// Subdirectory moved by migration option A (symlink)
const MIGRATE_SUB = Object.freeze({ claude: 'projects', codex: 'sessions' });
// Environment variable for option B
const ENV_VAR = Object.freeze({ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' });
const SQLITE_SIDE = Object.freeze(['-wal', '-shm', '-journal']);
const REST = '*'; // name of the "other" entry

const DEFAULTS = Object.freeze({
  batch: 64,          // number of concurrent lstat calls per batch
  yieldEvery: 256,    // yield to the event loop after this many items
  maxFiles: 2000000,  // stop past this and mark as partial
  timeBudgetMs: 120000,
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const tick = () => new Promise((r) => setImmediate(r));
const errCode = (err) => String((err && err.code) || 'ERROR');

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

// Compare paths: strip trailing separators; case-insensitive on Windows and macOS
function normPath(p, platform) {
  const P = pathApi(platform);
  let s = P.normalize(String(p || ''));
  if (s.length > 1) s = s.replace(/[\\/]+$/, '');
  if (platform === 'win32' && /^[A-Za-z]:$/.test(s)) s += '\\';
  return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s;
}

function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  return normPath(a, platform) === normPath(b, platform);
}

/** Whether child is inside parent (equal paths do not count) */
function isInside(child, parent, platform = process.platform) {
  if (!child || !parent) return false;
  const c = normPath(child, platform);
  const p = normPath(parent, platform);
  if (c === p) return false;
  const sep = platform === 'win32' ? '\\' : '/';
  const base = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(base);
}

// ---------------------------------------------------------------------------
// Directory measurement
// ---------------------------------------------------------------------------

function newCtx(o = {}) {
  return {
    batch: fin(o.batch) && o.batch > 0 ? o.batch : DEFAULTS.batch,
    yieldEvery: fin(o.yieldEvery) && o.yieldEvery > 0 ? o.yieldEvery : DEFAULTS.yieldEvery,
    maxFiles: fin(o.maxFiles) && o.maxFiles > 0 ? o.maxFiles : DEFAULTS.maxFiles,
    deadline: Date.now() + (fin(o.timeBudgetMs) && o.timeBudgetMs > 0 ? o.timeBudgetMs : DEFAULTS.timeBudgetMs),
    onYield: typeof o.onYield === 'function' ? o.onYield : null,
    inodes: new Set(),   // hard links (nlink > 1) are counted only once
    roots: new Map(),    // already-measured real path → entry name (avoids double counting when two symlinks point to the same place)
    ops: 0,
    sinceYield: 0,
    files: 0,
    yields: 0,
  };
}

const stopped = (ctx) => ctx.files >= ctx.maxFiles || Date.now() > ctx.deadline;

async function maybeYield(ctx, n) {
  ctx.ops += n;
  ctx.sinceYield += n;
  if (ctx.sinceYield < ctx.yieldEvery) return;
  ctx.sinceYield = 0;
  ctx.yields++;
  if (ctx.onYield) { try { ctx.onYield(ctx.files); } catch { /* ignore */ } }
  await tick();
}

function addFile(st, acc, ctx) {
  if (st.nlink > 1) {
    const k = `${st.dev}:${st.ino}`;
    if (ctx.inodes.has(k)) return;
    ctx.inodes.add(k);
  }
  acc.bytes += Number(st.size) || 0;
  acc.files++;
  ctx.files++;
}

/**
 * Recursively measure a directory (symlinks inside are not followed: each counts as one file with its own lstat size).
 * @returns {Promise<{ bytes: number, files: number, errors: number, partial: boolean }>}
 */
async function walkDir(root, ctx) {
  const acc = { bytes: 0, files: 0, errors: 0, partial: false };
  const stack = [root];
  while (stack.length) {
    if (stopped(ctx)) { acc.partial = true; break; }
    const dir = stack.pop();
    let ents;
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      acc.errors++;
      continue;
    }
    for (let i = 0; i < ents.length; i += ctx.batch) {
      const chunk = ents.slice(i, i + ctx.batch);
      const stats = await Promise.all(chunk.map((d) => {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) { stack.push(full); return null; } // ignore the size of the directory entry itself
        return fsp.lstat(full).catch(() => { acc.errors++; return null; });
      }));
      for (const st of stats) if (st) addFile(st, acc, ctx);
      await maybeYield(ctx, chunk.length);
      if (stopped(ctx)) { acc.partial = true; break; }
    }
  }
  return acc;
}

/**
 * Measure one top-level entry (file or directory). If it is a symlink, record the target and follow it once.
 * @param {string} name
 * @param {string} p
 * @param {any} ctx
 * @param {{ extraFiles?: string[] }} [o] extraFiles: sidecar files counted along with it (sqlite -wal / -shm)
 * @returns {Promise<StorageEntry>}
 */
async function measureEntry(name, p, ctx, o = {}) {
  /** @type {StorageEntry} */
  const e = {
    name, path: p, bytes: 0, files: 0, isSymlink: false, symlinkTarget: null, exists: false,
    kind: null, realPath: null, volume: null, error: null, errors: 0, partial: false, sameAs: null,
  };
  let st;
  try {
    st = await fsp.lstat(p);
  } catch (err) {
    if (err && err.code !== 'ENOENT') e.error = errCode(err);
    return e;
  }
  e.exists = true;
  let real = p;
  if (st.isSymbolicLink()) {
    e.isSymlink = true;
    try {
      const raw = await fsp.readlink(p);
      e.symlinkTarget = path.resolve(path.dirname(p), raw);
    } catch (err) {
      e.error = errCode(err);
    }
    try {
      real = await fsp.realpath(p);
      st = await fsp.stat(p);
    } catch (err) {
      // target is missing (e.g. an external drive is not mounted)
      e.error = err && err.code === 'ENOENT' ? 'TARGET_MISSING' : errCode(err);
      return e;
    }
  } else {
    try { real = await fsp.realpath(p); } catch { real = p; }
  }
  e.realPath = real;
  if (st.isDirectory()) {
    e.kind = 'dir';
    const prev = ctx.roots.get(real);
    if (prev != null) { e.sameAs = prev; return e; }
    ctx.roots.set(real, name);
    const acc = await walkDir(real, ctx);
    e.bytes = acc.bytes;
    e.files = acc.files;
    e.errors = acc.errors;
    e.partial = acc.partial;
  } else {
    e.kind = 'file';
    addFile(st, e, ctx);
    for (const side of o.extraFiles || []) {
      try { addFile(await fsp.lstat(side), e, ctx); } catch { /* fine if it does not exist */ }
    }
    await maybeYield(ctx, 1 + (o.extraFiles || []).length);
  }
  return e;
}

/**
 * Measure a data directory: listed sub-items in a fixed order, everything else merged into one "other" item.
 * @param {'claude'|'codex'} app
 * @param {string} dir
 * @param {string} dirSource
 * @param {any} ctx
 * @param {{ home: string }} o
 */
async function scanDir(app, dir, dirSource, ctx, o) {
  const out = {
    dir, dirSource, exists: false, isSymlink: false, symlinkTarget: null, realPath: null, volume: null,
    entries: [], totalBytes: 0, totalFiles: 0, partial: false, error: null,
  };
  let st;
  try {
    st = await fsp.lstat(dir);
  } catch (err) {
    if (err && err.code !== 'ENOENT') out.error = errCode(err);
    return out;
  }
  out.exists = true;
  if (st.isSymbolicLink()) {
    out.isSymlink = true;
    try { out.symlinkTarget = path.resolve(path.dirname(dir), await fsp.readlink(dir)); } catch { /* ignore */ }
  }
  try { out.realPath = await fsp.realpath(dir); } catch (err) {
    out.error = err && err.code === 'ENOENT' ? 'TARGET_MISSING' : errCode(err);
    return out;
  }
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    out.error = errCode(err);
  }
  const consumed = new Set();
  const known = app === 'claude' ? CLAUDE_ITEMS : CODEX_ITEMS;
  const keep = new Set([MIGRATE_SUB[app]]); // the migration subdirectory is listed even if it does not exist
  for (const name of known) {
    consumed.add(name);
    const e = await measureEntry(name, path.join(dir, name), ctx);
    if (e.exists || e.error || keep.has(name)) out.entries.push(e);
  }
  if (app === 'claude') {
    // Without CLAUDE_CONFIG_DIR, .claude.json lives in the home directory; with it set, it lives in that directory (per Claude Code's bundled source)
    const inDefault = samePath(dir, path.join(o.home, '.claude'));
    const cfgFile = inDefault ? path.join(o.home, '.claude.json') : path.join(dir, '.claude.json');
    if (!inDefault) consumed.add('.claude.json');
    const e = await measureEntry('.claude.json', cfgFile, ctx);
    e.outside = inDefault;
    out.entries.push(e);
  } else {
    for (const name of names.slice().sort()) {
      if (!name.endsWith('.sqlite')) continue;
      const sides = SQLITE_SIDE.map((s) => name + s).filter((n) => names.includes(n));
      consumed.add(name);
      for (const s of sides) consumed.add(s);
      out.entries.push(await measureEntry(name, path.join(dir, name), ctx, { extraFiles: sides.map((s) => path.join(dir, s)) }));
    }
  }
  // Other: total of the remaining top-level items
  const rest = {
    name: REST, rest: true, path: dir, bytes: 0, files: 0, count: 0, isSymlink: false, symlinkTarget: null, exists: true,
    kind: 'dir', realPath: out.realPath, volume: null, error: null, errors: 0, partial: false, sameAs: null,
  };
  const parts = [];
  for (const name of names) {
    if (consumed.has(name)) continue;
    const e = await measureEntry(name, path.join(dir, name), ctx);
    if (!e.exists) continue;
    parts.push({ name, bytes: e.bytes });
    rest.count++;
    rest.bytes += e.bytes;
    rest.files += e.files;
    rest.errors += e.errors + (e.error ? 1 : 0);
    rest.partial = rest.partial || e.partial;
  }
  // The three largest items within "other" (for the hover tooltip)
  rest.top = parts.sort((a, b) => b.bytes - a.bytes).slice(0, 3).filter((x) => x.bytes > 0);
  if (rest.count) out.entries.push(rest);
  for (const e of out.entries) {
    if (e.sameAs) continue;
    out.totalBytes += e.bytes;
    out.totalFiles += e.files;
    out.partial = out.partial || e.partial;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

const LINUX_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'f2fs',
  'hfsplus', 'apfs', 'zfs', 'jfs', 'reiserfs', 'nilfs2', 'bcachefs', 'drvfs', '9p']);

function decodeMount(s) {
  return String(s).replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
}

/** Candidate mount points per platform (reads directories and files only; spawns no child processes) */
function volumeRoots(platform) {
  const out = [];
  if (platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const root = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(root)) out.push(root); } catch { /* ignore */ }
    }
    return out;
  }
  out.push('/');
  if (platform === 'darwin') {
    let names = [];
    try { names = fs.readdirSync('/Volumes', { withFileTypes: true }); } catch { /* ignore */ }
    for (const d of names) {
      if (d.name.startsWith('.') || d.name.startsWith('com.apple.')) continue;
      if (d.isSymbolicLink()) continue; // e.g. "Macintosh HD" → /
      out.push(path.posix.join('/Volumes', d.name));
    }
    return out;
  }
  let text = '';
  try { text = fs.readFileSync('/proc/mounts', 'utf8'); } catch { /* ignore */ }
  for (const line of text.split('\n')) {
    const f = line.split(' ');
    if (f.length < 3 || !LINUX_FS.has(f[2])) continue;
    const m = decodeMount(f[1]);
    if (m === '/' || /^\/(proc|sys|dev|snap|boot|var\/lib\/docker|var\/snap)(\/|$)/.test(m)) continue;
    if (/^\/run(\/|$)/.test(m) && !/^\/run\/media\//.test(m)) continue;
    out.push(m);
  }
  return out;
}

function simpleName(mount, platform) {
  if (platform === 'win32') return mount.replace(/\\$/, '');
  return mount === '/' ? '/' : pathApi(platform).basename(mount) || mount;
}

// Volume display name: drive letter on Windows; on macOS, / uses the name under /Volumes that points to / (e.g. Macintosh HD)
function volumeName(mount, platform) {
  if (platform === 'win32') return simpleName(mount, platform);
  if (mount === '/') {
    if (platform === 'darwin') {
      try {
        for (const d of fs.readdirSync('/Volumes', { withFileTypes: true })) {
          if (!d.isSymbolicLink()) continue;
          try { if (fs.realpathSync(path.posix.join('/Volumes', d.name)) === '/') return d.name; } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    return '/';
  }
  return simpleName(mount, platform);
}

function defaultStatfs(p) {
  const s = fs.statfsSync(p);
  return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
}

function isWritable(p) {
  try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; }
}

/**
 * Free space on each volume.
 * @param {{ platform?: string, env?: Record<string, string|undefined>, roots?: string[], home?: string,
 *   statfs?: (p: string) => { freeBytes: number, totalBytes: number, writable?: boolean }, systemMount?: string }} [o]
 *   roots / statfs / systemMount can be overridden by tests
 * @returns {Volume[]}
 */
function listVolumes(o = {}) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const roots = Array.isArray(o.roots) ? o.roots : volumeRoots(platform);
  const statfs = typeof o.statfs === 'function' ? o.statfs : defaultStatfs;
  const sys = o.systemMount
    || (platform === 'win32' ? String(env.SystemDrive || 'C:').replace(/\\?$/, '\\') : '/');
  const out = [];
  const devs = new Set();
  for (const mount of roots) {
    let dev = null;
    try { dev = fs.statSync(mount).dev; } catch { if (!o.roots) continue; }
    if (dev != null && !o.roots) {
      if (devs.has(dev)) continue;
      devs.add(dev);
    }
    let sz;
    try { sz = statfs(mount); } catch { continue; }
    if (!sz || !fin(sz.totalBytes) || sz.totalBytes <= 0) continue;
    const system = samePath(mount, sys, platform);
    // On macOS, / is a read-only system snapshot and user data lives on the data volume in the same container: check writability via the home directory
    const probe = platform === 'darwin' && mount === '/' ? (o.home || os.homedir()) : mount;
    out.push({
      mount,
      name: o.roots ? simpleName(mount, platform) : volumeName(mount, platform),
      freeBytes: Math.max(0, Number(sz.freeBytes) || 0),
      totalBytes: Number(sz.totalBytes),
      system,
      writable: sz.writable != null ? !!sz.writable : isWritable(probe),
    });
  }
  // System volume first, the rest sorted by mount point
  out.sort((a, b) => (a.system === b.system ? (a.mount < b.mount ? -1 : a.mount > b.mount ? 1 : 0) : a.system ? -1 : 1));
  return out;
}

/** Volume containing a path (longest prefix match); not found → null */
function volumeOf(p, volumes, platform = process.platform) {
  if (!p || !Array.isArray(volumes)) return null;
  let best = null;
  for (const v of volumes) {
    if (!v || !v.mount) continue;
    const m = v.mount;
    const hit = samePath(p, m, platform) || isInside(p, m, platform) || (platform !== 'win32' && m === '/');
    if (hit && (!best || normPath(m, platform).length > normPath(best.mount, platform).length)) best = v;
  }
  return best ? best.mount : null;
}

/**
 * Default migration target volume: the writable, non-system volume with the most free space, excluding the one currently holding the data. None → null.
 * @param {Volume[]} volumes
 * @param {string|null} sourceMount volume currently holding the data
 */
function pickTargetVolume(volumes, sourceMount, platform = process.platform) {
  let best = null;
  for (const v of volumes || []) {
    if (!v || v.system || v.writable === false) continue;
    if (sourceMount && samePath(v.mount, sourceMount, platform)) continue;
    if (!best || v.freeBytes > best.freeBytes) best = v;
  }
  return best;
}

/**
 * Default target folder: <volume>/AI-Data/<app> (option B uses it directly; option A appends the subdirectory).
 * @returns {string|null}
 */
function defaultBase(app, volumes, sourceMount, platform = process.platform) {
  const v = pickTargetVolume(volumes, sourceMount, platform);
  return v ? pathApi(platform).join(v.mount, 'AI-Data', app) : null;
}

// ---------------------------------------------------------------------------
// Settings and main entry points
// ---------------------------------------------------------------------------

/**
 * cleanupPeriodDays from <claudeDir>/settings.json (days to keep session transcripts). Not set or unreadable → null.
 * @param {string} claudeDir
 * @returns {number|null}
 */
function readCleanupPeriodDays(claudeDir) {
  if (!claudeDir) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    const v = j && j.cleanupPeriodDays;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

// Directory source: environment variable / setting / default
function inferDirSource(dir, envVal, defaultDir, platform) {
  if (envVal && samePath(dir, envVal, platform)) return 'env';
  if (samePath(dir, defaultDir, platform)) return 'default';
  return 'setting';
}

/**
 * Measure the Claude / Codex data directories.
 * @param {{ claudeDir?: string|null, codexHome?: string|null,
 *   claudeDirSource?: 'env'|'setting'|'default', codexHomeSource?: 'env'|'setting'|'default',
 *   homeDir?: string, platform?: string, env?: Record<string, string|undefined>,
 *   volumes?: { roots?: string[], statfs?: Function, systemMount?: string },
 *   batch?: number, yieldEvery?: number, maxFiles?: number, timeBudgetMs?: number, onYield?: (files: number) => void }} o
 * @returns {Promise<StorageReport>}
 */
async function scanStorage(o = {}) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const home = o.homeDir || os.homedir();
  const ctx = newCtx(o);
  const claude = o.claudeDir
    ? await scanDir('claude', o.claudeDir, o.claudeDirSource || inferDirSource(o.claudeDir, env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), platform), ctx, { home })
    : null;
  const codex = o.codexHome
    ? await scanDir('codex', o.codexHome, o.codexHomeSource || inferDirSource(o.codexHome, env.CODEX_HOME, path.join(home, '.codex'), platform), ctx, { home })
    : null;
  const volumes = listVolumes({ platform, env, home, ...(o.volumes || {}) });
  for (const d of [claude, codex]) {
    if (!d) continue;
    d.volume = volumeOf(d.realPath || d.dir, volumes, platform);
    for (const e of d.entries) e.volume = volumeOf(e.realPath || e.path, volumes, platform);
  }
  return {
    at: Date.now(),
    claude,
    codex,
    volumes,
    cleanupPeriodDays: o.claudeDir ? readCleanupPeriodDays(o.claudeDir) : null,
    homeDir: home,
    partial: !!((claude && claude.partial) || (codex && codex.partial)),
  };
}

const SAFE_ID = /^[\w.-]+$/;

async function fileBytes(p) {
  try { return (await fsp.stat(p)).size; } catch { return null; }
}

async function dirBytes(p) {
  try {
    const st = await fsp.stat(p);
    if (!st.isDirectory()) return st.size;
  } catch {
    return 0;
  }
  const acc = await walkDir(p, newCtx());
  return acc.bytes;
}

/**
 * Storage used by a single session: main transcript, <project dir>/<sid>/ (subagents, workflows), file-history/<sid>.
 * Parts that do not apply are null (e.g. a Codex session only has transcript); a missing directory counts as 0.
 * @param {{ claudeDir?: string|null, projectDir?: string|null, sessionId?: string|null, transcript?: string|null }} o
 * @returns {Promise<{ transcriptBytes: number|null, subagentsBytes: number|null, fileHistoryBytes: number|null,
 *   transcript: string|null, subagentsDir: string|null, fileHistoryDir: string|null }>}
 */
async function sessionStorage(o = {}) {
  const out = {
    transcriptBytes: null, subagentsBytes: null, fileHistoryBytes: null,
    transcript: o.transcript || null, subagentsDir: null, fileHistoryDir: null,
  };
  if (o.transcript) out.transcriptBytes = await fileBytes(o.transcript);
  const sid = typeof o.sessionId === 'string' && SAFE_ID.test(o.sessionId) && !/^\.+$/.test(o.sessionId) ? o.sessionId : null;
  if (!sid) return out;
  const projectDir = o.projectDir || (o.transcript && o.claudeDir ? path.dirname(o.transcript) : null);
  if (projectDir) {
    out.subagentsDir = path.join(projectDir, sid);
    out.subagentsBytes = await dirBytes(out.subagentsDir);
  }
  if (o.claudeDir) {
    out.fileHistoryDir = path.join(o.claudeDir, 'file-history', sid);
    out.fileHistoryBytes = await dirBytes(out.fileHistoryDir);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Migration commands (text generation only)
// ---------------------------------------------------------------------------

// POSIX: always single quotes; an inner ' becomes '\''
function qPosix(p) { return "'" + String(p).replace(/'/g, "'\\''") + "'"; }
// PowerShell: always single quotes; an inner ' becomes '' ($ and ` are not expanded inside single quotes)
function qPwsh(p) { return "'" + String(p).replace(/'/g, "''") + "'"; }
// JSON string (for the VS Code settings snippet)
const qJson = (s) => JSON.stringify(String(s));

let enI18n = null;
function fallbackI18n() {
  if (!enI18n) enI18n = require('./i18n').createI18n('en');
  return enI18n;
}

/**
 * Migration commands. The extension only generates them and never runs them; "Open in terminal" only pastes oneLine without pressing Enter.
 * - kind 'symlink' (option A): source is the subdirectory to move (~/.claude/projects, ~/.codex/sessions), target is the new location.
 *   macOS / Linux: rsync + mv .bak + ln -s; Windows (PowerShell): robocopy + Rename-Item .bak + mklink /J.
 * - kind 'env' (option B): source is the whole data directory, target is the new CLAUDE_CONFIG_DIR / CODEX_HOME.
 * @param {{ platform?: string, kind: 'symlink'|'env', source: string, target: string, app: 'claude'|'codex',
 *   homeDir?: string, i18n?: { t: (k: string, v?: any) => string } }} o
 * @returns {MigrationPlan}
 */
function migrationPlan(o) {
  const platform = (o && o.platform) || process.platform;
  const win = platform === 'win32';
  const P = pathApi(platform);
  const i18n = (o && o.i18n) || fallbackI18n();
  const t = (k, v) => i18n.t(k, v);
  const app = o && o.app === 'codex' ? 'codex' : 'claude';
  const kind = o && o.kind === 'env' ? 'env' : 'symlink';
  const plan = {
    ok: false, error: null, kind, app, platform, shell: win ? 'powershell' : 'posix',
    source: o && o.source ? String(o.source) : '', target: o && o.target ? String(o.target) : '',
    commands: '', oneLine: '', cleanup: '', rollback: '', env: null, monitorSetting: '', notes: [],
  };
  // Strip trailing separators (except for the root directory)
  const strip = (s) => (s.length > 1 && !/^[A-Za-z]:\\$/.test(s) ? s.replace(/[\\/]+$/, '') || s : s);
  const src = plan.source = strip(plan.source);
  const dst = plan.target = strip(plan.target);
  // Path checks: must be absolute, must not contain control characters (a newline would make the terminal run early), must not contain each other
  if (!src || !dst || !P.isAbsolute(src) || !P.isAbsolute(dst)) { plan.error = 'NOT_ABSOLUTE'; return plan; }
  if (/[\u0000-\u001f\u007f]/.test(src + dst)) { plan.error = 'BAD_PATH'; return plan; }
  if (samePath(src, dst, platform)) { plan.error = 'SAME_PATH'; return plan; }
  if (isInside(dst, src, platform)) { plan.error = 'TARGET_INSIDE_SOURCE'; return plan; }
  if (isInside(src, dst, platform)) { plan.error = 'SOURCE_INSIDE_TARGET'; return plan; }

  const bak = src.replace(/[\\/]+$/, '') + '.bak';
  const base = P.basename(src.replace(/[\\/]+$/, ''));
  const envName = ENV_VAR[app];
  const home = (o && o.homeDir) || os.homedir();
  // Option B with Claude on the default directory: .claude.json is in the home directory, but once CLAUDE_CONFIG_DIR is set it must be in the new directory
  const claudeJson = kind === 'env' && app === 'claude' && samePath(src, P.join(home, '.claude'), platform)
    ? P.join(home, '.claude.json') : null;

  if (!win) {
    const S = qPosix(src);
    const D = qPosix(dst);
    const B = qPosix(bak);
    const guard = [`test -d ${S}`, `test ! -L ${S}`, `test ! -e ${B}`];
    const copy = [`mkdir -p ${D}`, `rsync -a ${qPosix(src + '/')} ${qPosix(dst + '/')}`];
    let steps;
    if (kind === 'symlink') {
      steps = [...guard, ...copy, `mv ${S} ${B}`, `ln -s ${D} ${S}`];
      plan.rollback = [`test -L ${S}`, `test -d ${B}`, `rsync -a ${qPosix(dst + '/')} ${qPosix(bak + '/')}`, `rm ${S}`, `mv ${B} ${S}`].join(' && ');
    } else {
      steps = [...guard, ...copy];
      if (claudeJson) steps.push(`cp -p ${qPosix(claudeJson)} ${qPosix(P.join(dst, '.claude.json'))}`);
      steps.push(`mv ${S} ${B}`);
      plan.rollback = [`test -d ${B}`, `test ! -e ${S}`, `rsync -a ${qPosix(dst + '/')} ${qPosix(bak + '/')}`, `mv ${B} ${S}`].join(' && ');
    }
    plan.commands = steps[0] + steps.slice(1).map((s) => ' \\\n  && ' + s).join('');
    plan.oneLine = steps.join(' && ');
    plan.cleanup = `rm -rf ${B}`;
  } else {
    const S = qPwsh(src);
    const D = qPwsh(dst);
    const B = qPwsh(bak);
    const robo = (from, to) => `robocopy ${qPwsh(from)} ${qPwsh(to)} /E /COPY:DAT /DCOPY:T /R:1 /W:1 /NP`;
    const guard = `(Test-Path -LiteralPath ${S} -PathType Container) -and -not (Get-Item -LiteralPath ${S} -Force).LinkType -and -not (Test-Path -LiteralPath ${B})`;
    const rename = `Rename-Item -LiteralPath ${S} -NewName ${qPwsh(base + '.bak')}`;
    if (kind === 'symlink') {
      plan.oneLine = `if (${guard}) { ${robo(src, dst)}; if ($LASTEXITCODE -lt 8) { ${rename}; if ($?) { cmd /c mklink /J ${S} ${D} } } }`;
      plan.rollback = `if ((Get-Item -LiteralPath ${S} -Force).LinkType -and (Test-Path -LiteralPath ${B})) { ${robo(dst, bak)}; if ($LASTEXITCODE -lt 8) { cmd /c rmdir ${S}; if ($?) { Rename-Item -LiteralPath ${B} -NewName ${qPwsh(base)} } } }`;
    } else {
      const cj = claudeJson ? `Copy-Item -LiteralPath ${qPwsh(claudeJson)} -Destination ${qPwsh(P.join(dst, '.claude.json'))}; ` : '';
      plan.oneLine = `if (${guard}) { ${robo(src, dst)}; if ($LASTEXITCODE -lt 8) { ${cj}${rename} } }`;
      plan.rollback = `if ((Test-Path -LiteralPath ${B}) -and -not (Test-Path -LiteralPath ${S})) { ${robo(dst, bak)}; if ($LASTEXITCODE -lt 8) { Rename-Item -LiteralPath ${B} -NewName ${qPwsh(base)} } }`;
    }
    plan.commands = plan.oneLine;
    plan.cleanup = `Remove-Item -LiteralPath ${B} -Recurse -Force`;
  }

  if (kind === 'env') {
    plan.env = {
      name: envName,
      value: dst,
      // Setting for the Claude Code extension in VS Code (the Codex extension has no equivalent)
      vscodeSetting: app === 'claude' ? `"claudeCode.environmentVariables": [\n  { "name": "${envName}", "value": ${qJson(dst)} }\n]` : null,
      shellLine: win ? `[Environment]::SetEnvironmentVariable('${envName}', ${qPwsh(dst)}, 'User')` : `export ${envName}=${qPosix(dst)}`,
    };
    plan.monitorSetting = app === 'claude'
      ? `"agentMonitor.claude.projectsDir": ${qJson(P.join(dst, 'projects'))}`
      : `"agentMonitor.codex.home": ${qJson(dst)}`;
  }

  // Notes (in the UI language)
  const n = plan.notes;
  if (kind === 'symlink') {
    n.push(t('storage.plan.note.symlink', { name: base, bak: base + '.bak' }));
    n.push(t(win ? 'storage.plan.note.junction' : 'storage.plan.note.rsync'));
    if (platform === 'linux') n.push(t('storage.plan.note.noRsync'));
    n.push(t('storage.plan.note.guard'));
  } else {
    n.push(t('storage.plan.note.env.copy', { name: envName }));
    if (app === 'claude') {
      n.push(t('storage.plan.note.env.claude', { name: envName }));
      if (claudeJson) n.push(t('storage.plan.note.env.claudeJson'));
      n.push(t('storage.plan.note.env.login'));
    } else {
      n.push(t('storage.plan.note.env.codex', { name: envName }));
    }
    n.push(t('storage.plan.note.env.monitor'));
    n.push(t('storage.plan.note.guard'));
  }
  plan.ok = true;
  return plan;
}

/**
 * @typedef {{ name: string, path: string, bytes: number, files: number, isSymlink: boolean, symlinkTarget: string|null,
 *   exists: boolean, kind?: 'dir'|'file'|null, realPath?: string|null, volume?: string|null, error?: string|null,
 *   errors?: number, partial?: boolean, sameAs?: string|null, rest?: boolean, count?: number, outside?: boolean,
 *   top?: Array<{ name: string, bytes: number }> }} StorageEntry
 *   rest: total of the other top-level items (name is '*', top holds the three largest); outside: .claude.json is outside the data directory (in the home directory);
 *   error: 'EACCES' etc., or 'TARGET_MISSING' (the symlink target is missing, e.g. an external drive is not mounted); sameAs: same directory as another entry
 * @typedef {{ mount: string, name: string, freeBytes: number, totalBytes: number, system: boolean, writable: boolean }} Volume
 * @typedef {{ dir: string, dirSource: 'env'|'setting'|'default', exists: boolean, isSymlink: boolean, symlinkTarget: string|null,
 *   realPath: string|null, volume: string|null, entries: StorageEntry[], totalBytes: number, totalFiles: number,
 *   partial: boolean, error: string|null }} DirReport
 * @typedef {{ at: number, claude: DirReport|null, codex: DirReport|null, volumes: Volume[], cleanupPeriodDays: number|null,
 *   homeDir: string, partial: boolean }} StorageReport
 * @typedef {{ ok: boolean, error: string|null, kind: 'symlink'|'env', app: 'claude'|'codex', platform: string,
 *   shell: 'posix'|'powershell', source: string, target: string,
 *   commands: string, oneLine: string, cleanup: string, rollback: string,
 *   env: { name: string, value: string, vscodeSetting: string|null, shellLine: string }|null,
 *   monitorSetting: string, notes: string[] }} MigrationPlan
 *   commands: for copying (multi-line on POSIX, continued with \); oneLine: for sending to the terminal (single line with no newline, so it is not executed)
 */

module.exports = {
  CLAUDE_ITEMS, CODEX_ITEMS, MIGRATE_SUB, ENV_VAR, REST,
  scanStorage, sessionStorage, migrationPlan, readCleanupPeriodDays,
  listVolumes, volumeOf, pickTargetVolume, defaultBase,
  samePath, isInside, qPosix, qPwsh,
  _internal: { walkDir, measureEntry, newCtx, inferDirSource, volumeRoots, decodeMount },
};
