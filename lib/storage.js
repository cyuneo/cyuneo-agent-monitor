'use strict';
// 存储位置、占用与迁移参考（DESIGN §11.11、§11.12.3）。纯 Node、不依赖 vscode，worker 和扩展主线程都能用。
// - scanStorage()：Claude / Codex 数据目录各项的大小（递归 lstat，异步、分批让出事件循环；
//   目录里的软链接不跟随，只有顶层条目是软链接时跟过去统计一次，并写出指向哪里），
//   每个卷的剩余空间（fs.statfsSync）、cleanupPeriodDays。只读；统计出错的项标出来，不抛。限频由调用方负责。
// - sessionStorage()：单个会话的主记录、子智能体目录、file-history/<sid> 各多大。
// - migrationPlan()：生成迁移命令文本。路径一律加引号（支持空格和中文）。插件只生成、绝不执行。

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

// Claude 数据目录里列出的子项（§11.11 第 2 条），其余合成一项“其它”
const CLAUDE_ITEMS = Object.freeze(['projects', 'file-history', 'plugins', 'skills', 'cache', 'backups', 'shell-snapshots']);
// Codex：常见子目录；*.sqlite 连同 -wal / -shm / -journal 各算一项
const CODEX_ITEMS = Object.freeze(['sessions', 'archived_sessions', 'plugins', 'log', 'cache', 'skills', 'shell_snapshots']);
// 迁移方案 A 挪的子目录（§11.11 第 3 条）
const MIGRATE_SUB = Object.freeze({ claude: 'projects', codex: 'sessions' });
// 方案 B 的环境变量
const ENV_VAR = Object.freeze({ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' });
const SQLITE_SIDE = Object.freeze(['-wal', '-shm', '-journal']);
const REST = '*'; // “其它”条目的 name

const DEFAULTS = Object.freeze({
  batch: 64,          // 一批并发 lstat 的个数
  yieldEvery: 256,    // 每处理这么多项让出一次事件循环
  maxFiles: 2000000,  // 超过就停，标 partial
  timeBudgetMs: 120000,
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const tick = () => new Promise((r) => setImmediate(r));
const errCode = (err) => String((err && err.code) || 'ERROR');

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

// 比较路径：去掉末尾分隔符；Windows、macOS 不分大小写
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

/** child 是否在 parent 里面（不含相等） */
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
// 目录统计
// ---------------------------------------------------------------------------

function newCtx(o = {}) {
  return {
    batch: fin(o.batch) && o.batch > 0 ? o.batch : DEFAULTS.batch,
    yieldEvery: fin(o.yieldEvery) && o.yieldEvery > 0 ? o.yieldEvery : DEFAULTS.yieldEvery,
    maxFiles: fin(o.maxFiles) && o.maxFiles > 0 ? o.maxFiles : DEFAULTS.maxFiles,
    deadline: Date.now() + (fin(o.timeBudgetMs) && o.timeBudgetMs > 0 ? o.timeBudgetMs : DEFAULTS.timeBudgetMs),
    onYield: typeof o.onYield === 'function' ? o.onYield : null,
    inodes: new Set(),   // 硬链接（nlink > 1）只算一次
    roots: new Map(),    // 已统计过的真实路径 → 条目名（两个软链接指向同一处时不重复统计）
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
  if (ctx.onYield) { try { ctx.onYield(ctx.files); } catch { /* 忽略 */ } }
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
 * 递归统计目录（不跟随里面的软链接：软链接按它自己的 lstat 大小算一个文件）。
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
        if (d.isDirectory()) { stack.push(full); return null; } // 目录项本身的大小忽略
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
 * 统计一个顶层条目（文件或目录）。顶层是软链接时写出目标并跟过去统计一次。
 * @param {string} name
 * @param {string} p
 * @param {any} ctx
 * @param {{ extraFiles?: string[] }} [o] extraFiles：一并计入的旁路文件（sqlite 的 -wal / -shm）
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
      // 目标不在（外置盘没挂好等）
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
      try { addFile(await fsp.lstat(side), e, ctx); } catch { /* 没有就算了 */ }
    }
    await maybeYield(ctx, 1 + (o.extraFiles || []).length);
  }
  return e;
}

/**
 * 统计一个数据目录：列出的子项按固定顺序，其余合成“其它”一项。
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
    try { out.symlinkTarget = path.resolve(path.dirname(dir), await fsp.readlink(dir)); } catch { /* 忽略 */ }
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
  const keep = new Set([MIGRATE_SUB[app]]); // 迁移用的子目录没有也列出来
  for (const name of known) {
    consumed.add(name);
    const e = await measureEntry(name, path.join(dir, name), ctx);
    if (e.exists || e.error || keep.has(name)) out.entries.push(e);
  }
  if (app === 'claude') {
    // CLAUDE_CONFIG_DIR 没设时 .claude.json 在主目录下；设了就在该目录里（Claude Code 打包代码 EL0）
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
  // 其它：剩下的顶层项合计
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
  // 其它里最大的三项（悬停提示用）
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
// 卷
// ---------------------------------------------------------------------------

const LINUX_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'f2fs',
  'hfsplus', 'apfs', 'zfs', 'jfs', 'reiserfs', 'nilfs2', 'bcachefs', 'drvfs', '9p']);

function decodeMount(s) {
  return String(s).replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
}

/** 各平台的候选挂载点（只读目录、文件，不起子进程） */
function volumeRoots(platform) {
  const out = [];
  if (platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const root = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(root)) out.push(root); } catch { /* 忽略 */ }
    }
    return out;
  }
  out.push('/');
  if (platform === 'darwin') {
    let names = [];
    try { names = fs.readdirSync('/Volumes', { withFileTypes: true }); } catch { /* 忽略 */ }
    for (const d of names) {
      if (d.name.startsWith('.') || d.name.startsWith('com.apple.')) continue;
      if (d.isSymbolicLink()) continue; // “Macintosh HD” → / 这类
      out.push(path.posix.join('/Volumes', d.name));
    }
    return out;
  }
  let text = '';
  try { text = fs.readFileSync('/proc/mounts', 'utf8'); } catch { /* 忽略 */ }
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

// 卷的显示名：Windows 盘符；macOS 的 / 用 /Volumes 下指向 / 的那个名字（例如 Macintosh HD）
function volumeName(mount, platform) {
  if (platform === 'win32') return simpleName(mount, platform);
  if (mount === '/') {
    if (platform === 'darwin') {
      try {
        for (const d of fs.readdirSync('/Volumes', { withFileTypes: true })) {
          if (!d.isSymbolicLink()) continue;
          try { if (fs.realpathSync(path.posix.join('/Volumes', d.name)) === '/') return d.name; } catch { /* 忽略 */ }
        }
      } catch { /* 忽略 */ }
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
 * 每个卷的剩余空间。
 * @param {{ platform?: string, env?: Record<string, string|undefined>, roots?: string[], home?: string,
 *   statfs?: (p: string) => { freeBytes: number, totalBytes: number, writable?: boolean }, systemMount?: string }} [o]
 *   roots / statfs / systemMount 供测试替换
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
    // macOS 的 / 是只读的系统快照，用户数据在同一容器的数据卷上：按主目录判断能不能写
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
  // 系统卷在前，其余按挂载点
  out.sort((a, b) => (a.system === b.system ? (a.mount < b.mount ? -1 : a.mount > b.mount ? 1 : 0) : a.system ? -1 : 1));
  return out;
}

/** 路径所在的卷（最长前缀匹配）；找不到 → null */
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
 * 迁移的默认目标卷：可写、非系统卷、且不是数据现在所在的卷里，剩余空间最多的。没有 → null。
 * @param {Volume[]} volumes
 * @param {string|null} sourceMount 数据现在所在的卷
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
 * 默认目标文件夹：<卷>/AI-Data/<app>（方案 B 用它；方案 A 再接子目录）。
 * @returns {string|null}
 */
function defaultBase(app, volumes, sourceMount, platform = process.platform) {
  const v = pickTargetVolume(volumes, sourceMount, platform);
  return v ? pathApi(platform).join(v.mount, 'AI-Data', app) : null;
}

// ---------------------------------------------------------------------------
// 设置与总入口
// ---------------------------------------------------------------------------

/**
 * <claudeDir>/settings.json 里的 cleanupPeriodDays（会话记录保留天数）。没设、读不了 → null。
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

// 目录来源：环境变量 / 设置 / 默认
function inferDirSource(dir, envVal, defaultDir, platform) {
  if (envVal && samePath(dir, envVal, platform)) return 'env';
  if (samePath(dir, defaultDir, platform)) return 'default';
  return 'setting';
}

/**
 * 统计 Claude / Codex 数据目录（§11.11 第 2 条）。
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
 * 单个会话的存储占用（§11.11 第 1 条）：主记录、<项目目录>/<sid>/（子智能体、工作流）、file-history/<sid>。
 * 不适用的部分为 null（例如 Codex 会话只给 transcript）；目录不存在算 0。
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
// 迁移命令（只生成文本）
// ---------------------------------------------------------------------------

// POSIX：一律单引号，内部 ' 写成 '\''
function qPosix(p) { return "'" + String(p).replace(/'/g, "'\\''") + "'"; }
// PowerShell：一律单引号，内部 ' 写成 ''（单引号里 $ ` 都不展开）
function qPwsh(p) { return "'" + String(p).replace(/'/g, "''") + "'"; }
// JSON 字符串（VS Code 设置片段用）
const qJson = (s) => JSON.stringify(String(s));

let enI18n = null;
function fallbackI18n() {
  if (!enI18n) enI18n = require('./i18n').createI18n('en');
  return enI18n;
}

/**
 * 迁移命令（§11.11 第 3 条）。插件只生成、绝不执行；“在终端中打开”只放 oneLine，不按回车。
 * - kind 'symlink'（方案 A）：source 是要挪的子目录（~/.claude/projects、~/.codex/sessions），target 是新位置。
 *   macOS / Linux：rsync + mv .bak + ln -s；Windows（PowerShell）：robocopy + Rename-Item .bak + mklink /J。
 * - kind 'env'（方案 B）：source 是整个数据目录，target 是新的 CLAUDE_CONFIG_DIR / CODEX_HOME。
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
  // 去掉末尾的分隔符（根目录除外）
  const strip = (s) => (s.length > 1 && !/^[A-Za-z]:\\$/.test(s) ? s.replace(/[\\/]+$/, '') || s : s);
  const src = plan.source = strip(plan.source);
  const dst = plan.target = strip(plan.target);
  // 路径检查：必须是绝对路径、不能有控制字符（换行会让终端提前执行）、不能互相包含
  if (!src || !dst || !P.isAbsolute(src) || !P.isAbsolute(dst)) { plan.error = 'NOT_ABSOLUTE'; return plan; }
  if (/[\u0000-\u001f\u007f]/.test(src + dst)) { plan.error = 'BAD_PATH'; return plan; }
  if (samePath(src, dst, platform)) { plan.error = 'SAME_PATH'; return plan; }
  if (isInside(dst, src, platform)) { plan.error = 'TARGET_INSIDE_SOURCE'; return plan; }
  if (isInside(src, dst, platform)) { plan.error = 'SOURCE_INSIDE_TARGET'; return plan; }

  const bak = src.replace(/[\\/]+$/, '') + '.bak';
  const base = P.basename(src.replace(/[\\/]+$/, ''));
  const envName = ENV_VAR[app];
  const home = (o && o.homeDir) || os.homedir();
  // 方案 B 且 Claude 用的是默认目录：.claude.json 在主目录下，设了 CLAUDE_CONFIG_DIR 后要在新目录里
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
      // VS Code 里 Claude Code 扩展的设置（Codex 扩展没有对应设置）
      vscodeSetting: app === 'claude' ? `"claudeCode.environmentVariables": [\n  { "name": "${envName}", "value": ${qJson(dst)} }\n]` : null,
      shellLine: win ? `[Environment]::SetEnvironmentVariable('${envName}', ${qPwsh(dst)}, 'User')` : `export ${envName}=${qPosix(dst)}`,
    };
    plan.monitorSetting = app === 'claude'
      ? `"agentMonitor.claude.projectsDir": ${qJson(P.join(dst, 'projects'))}`
      : `"agentMonitor.codex.home": ${qJson(dst)}`;
  }

  // 说明（按界面语言）
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
 *   rest：其它顶层项的合计（name 为 '*'，top 是其中最大的三项）；outside：.claude.json 在数据目录外（主目录下）；
 *   error：'EACCES' 等，或 'TARGET_MISSING'（软链接指向的地方不在，例如外置盘没挂）；sameAs：与另一项是同一个目录
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
 *   commands：复制用（POSIX 多行，用 \ 续行）；oneLine：送进终端用（单行、不含换行，不会被执行）
 */

module.exports = {
  CLAUDE_ITEMS, CODEX_ITEMS, MIGRATE_SUB, ENV_VAR, REST,
  scanStorage, sessionStorage, migrationPlan, readCleanupPeriodDays,
  listVolumes, volumeOf, pickTargetVolume, defaultBase,
  samePath, isInside, qPosix, qPwsh,
  _internal: { walkDir, measureEntry, newCtx, inferDirSource, volumeRoots, decodeMount },
};
