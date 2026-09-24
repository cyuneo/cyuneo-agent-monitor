'use strict';
// Claude Code 在线会话登记表（DESIGN §11.1）：<claudeHome>/sessions/<pid>.json。
// 每个正在运行的 Claude Code 进程一个文件，写着 sessionId、status（busy/waiting/idle）、waitingFor 等。
// 只解析 *.json；旁边的 <pid>.<hash>.key 文件和 socket 一律不读、不碰。
// 同步、无状态、纯 Node：worker 每次刷新调用一次；扩展主线程的压缩功能执行前也直接调用它复查。

const fs = require('fs');
const path = require('path');

const LIVE_STATUSES = new Set(['busy', 'waiting', 'idle']);

// 毫秒时间戳；万一是 epoch 秒就换算
function ms(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function str(v) {
  return typeof v === 'string' && v ? v : null;
}

/**
 * 进程是否还活着：kill(pid, 0) 不抛或抛 EPERM → 活；ESRCH（及其它错误）→ 已退出。
 * @param {number} pid
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === 'EPERM';
  }
}

/**
 * 读登记表目录，返回全部解析成功的条目（含已退出进程的残留），供判断“登记表是否可用”。
 * @param {string} claudeHome 例如 ~/.claude
 * @param {{ isAlive?: (pid: number) => boolean }} [opts] isAlive 仅供测试替换
 * @returns {{ ok: boolean, dir: string, entries: LiveEntry[], live: Map<string, LiveEntry>, minVersion: string|null }}
 *   ok：目录可读且至少有一个合法条目（说明本机 Claude Code 会写登记表）；
 *   live：sessionId → 存活进程的条目（同一会话多个存活进程时取 updatedAt 最新的）；
 *   minVersion：所有合法条目里最低的 version（判断“这个版本的会话会不会登记”用）。
 */
function readRegistry(claudeHome, opts = {}) {
  const dir = path.join(String(claudeHome || ''), 'sessions');
  const out = { ok: false, dir, entries: [], live: new Map(), minVersion: null };
  if (!claudeHome) return out;
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在：当作没有登记表
  }
  const alive = opts.isAlive || isPidAlive;
  for (const d of names) {
    const name = d.name;
    // 只要 *.json 普通文件；*.key、socket、子目录一律跳过（不 open）
    if (!name.endsWith('.json') || name.endsWith('.key')) continue;
    if (!d.isFile()) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue; // 正在写或已损坏
    }
    if (!j || typeof j !== 'object') continue;
    const sessionId = str(j.sessionId);
    let pid = Number(j.pid);
    if (!Number.isInteger(pid) || pid <= 0) pid = Number(name.replace(/\.json$/, ''));
    if (!sessionId || !Number.isInteger(pid) || pid <= 0) continue;
    const status = LIVE_STATUSES.has(j.status) ? j.status : null;
    /** @type {LiveEntry} */
    const entry = {
      pid,
      sessionId,
      status,
      waitingFor: status === 'waiting' ? str(j.waitingFor) : null,
      entrypoint: str(j.entrypoint),
      cwd: str(j.cwd),
      startedAt: ms(j.startedAt),
      statusUpdatedAt: ms(j.statusUpdatedAt),
      updatedAt: ms(j.updatedAt),
      version: str(j.version),
      kind: str(j.kind),
      alive: false,
    };
    out.entries.push(entry);
    if (entry.version && (!out.minVersion || cmpVersion(entry.version, out.minVersion) < 0)) out.minVersion = entry.version;
    entry.alive = alive(pid);
    if (!entry.alive) continue; // ESRCH：进程已退出，文件是残留
    const prev = out.live.get(sessionId);
    if (!prev || (entry.updatedAt || 0) > (prev.updatedAt || 0)) out.live.set(sessionId, entry);
  }
  out.ok = out.entries.length > 0;
  return out;
}

/**
 * 存活的在线会话。
 * @param {string} claudeHome 例如 ~/.claude（即 claude.projectsDir 的上一级）
 * @param {{ isAlive?: (pid: number) => boolean }} [opts]
 * @returns {Map<string, LiveEntry>} sessionId → { pid, status, waitingFor, entrypoint, cwd, startedAt, statusUpdatedAt, … }
 */
function readLiveSessions(claudeHome, opts) {
  return readRegistry(claudeHome, opts).live;
}

// 版本号比较（只比数字段）：a<b 返回负数
function cmpVersion(a, b) {
  const pa = String(a).split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^\d]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * @typedef {{
 *   pid: number, sessionId: string,
 *   status: 'busy'|'waiting'|'idle'|null, waitingFor: string|null,
 *   entrypoint: string|null, cwd: string|null,
 *   startedAt: number|null, statusUpdatedAt: number|null, updatedAt: number|null,
 *   version: string|null, kind: string|null, alive: boolean
 * }} LiveEntry
 */

module.exports = { readLiveSessions, readRegistry, isPidAlive, cmpVersion };
