'use strict';
// Claude Code live-session registry: <claudeHome>/sessions/<pid>.json.
// One file per running Claude Code process, holding sessionId, status (busy/waiting/idle), waitingFor, etc.
// Only *.json is parsed; the neighbouring <pid>.<hash>.key files and sockets are never read or touched.
// Synchronous, stateless, plain Node: the worker calls it once per refresh; the extension host also calls it directly to re-check before running compaction.

const fs = require('fs');
const path = require('path');

const LIVE_STATUSES = new Set(['busy', 'waiting', 'idle']);

// Millisecond timestamp; converts if it happens to be epoch seconds
function ms(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function str(v) {
  return typeof v === 'string' && v ? v : null;
}

/**
 * Whether a process is still alive: kill(pid, 0) succeeds or throws EPERM → alive; ESRCH (or any other error) → exited.
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
 * Reads the registry directory and returns every successfully parsed entry (including leftovers from exited processes), used to decide whether the registry is usable.
 * @param {string} claudeHome e.g. ~/.claude
 * @param {{ isAlive?: (pid: number) => boolean }} [opts] isAlive is only replaced in tests
 * @returns {{ ok: boolean, dir: string, entries: LiveEntry[], live: Map<string, LiveEntry>, minVersion: string|null }}
 *   ok: the directory is readable and has at least one valid entry (meaning the local Claude Code writes the registry);
 *   live: sessionId → entry of a live process (if one session has several live processes, the one with the newest updatedAt wins);
 *   minVersion: the lowest version among all valid entries (used to judge whether sessions of a given version get registered).
 */
function readRegistry(claudeHome, opts = {}) {
  const dir = path.join(String(claudeHome || ''), 'sessions');
  const out = { ok: false, dir, entries: [], live: new Map(), minVersion: null };
  if (!claudeHome) return out;
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory missing: treat as no registry
  }
  const alive = opts.isAlive || isPidAlive;
  for (const d of names) {
    const name = d.name;
    // Only plain *.json files; *.key, sockets and subdirectories are skipped (never opened)
    if (!name.endsWith('.json') || name.endsWith('.key')) continue;
    if (!d.isFile()) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue; // being written or corrupted
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
    if (!entry.alive) continue; // ESRCH: the process has exited; the file is a leftover
    const prev = out.live.get(sessionId);
    if (!prev || (entry.updatedAt || 0) > (prev.updatedAt || 0)) out.live.set(sessionId, entry);
  }
  out.ok = out.entries.length > 0;
  return out;
}

/**
 * Live sessions that are still running.
 * @param {string} claudeHome e.g. ~/.claude (the parent of claude.projectsDir)
 * @param {{ isAlive?: (pid: number) => boolean }} [opts]
 * @returns {Map<string, LiveEntry>} sessionId → { pid, status, waitingFor, entrypoint, cwd, startedAt, statusUpdatedAt, … }
 */
function readLiveSessions(claudeHome, opts) {
  return readRegistry(claudeHome, opts).live;
}

// Version comparison (numeric segments only): returns a negative number when a < b
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
