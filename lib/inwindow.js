'use strict';
// Auto-resume in the original window (docs/DESIGN.md §12.8), the half that touches files and processes. No vscode:
// lib/autoresume-runtime.js creates it with its own fs, clock, child runner and log (deps below) and runs the fallback
// chain around it; the decisions are lib/core/inwindow.js.
// - Registry: only <claudeHome>/sessions/<digits>.json is read. The <pid>.<hash>.key files next to them, the sockets and
//   <claudeHome>/daemon/ are never opened, read or logged (no path outside sessions/<digits>.json, /proc/<pid>/stat,
//   /proc/self/ns/pid and the transcripts is ever opened here).
// - send(): targeting (rules a–d) → the helper (`claude -p … --output-format json "<prompt>"`, argv only, no shell,
//   90 s, cwd the chat's folder or the extension's storage folder) which checks ListAgents (rule e) and sends → after SENT
//   the registry is read again and the chat's transcript is polled for the marker line for up to 120 s (rule f); the
//   marker in any other transcript changed since the send → misdelivered. The helper's output is never logged in full:
//   only its parsed status and, for a failure, its first line, redacted.
// - waitForPrompt(): fallback ii, polls the chat's transcript for a new user entry (up to 10 min).
// - ownedHere(pid): whether the chat's process runs under this window's extension host (fallback i may prefill there).

const nodeFs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');
const core = require('./core/inwindow');

const HELPER_TIMEOUT_MS = 90e3;
const HELPER_GONE_MS = 10e3;       // the helper's own sessions/<pid>.json must be gone within this long after it ended
const HELPER_GONE_POLL_MS = 500;
const VERIFY_MS = 120e3;            // the marker must reach the chat's transcript within this long after SENT
const VERIFY_POLL_MS = 5e3;
const WAIT_PROMPT_MS = 10 * 60e3;   // fallback ii: how long a new user entry is waited for before the copy
const WAIT_POLL_MS = 15e3;
const TAIL_BYTES = 2 * 1024 * 1024; // transcript bytes read from the end (marker search, permission mode)
const SCAN_SLACK_MS = 5e3;          // other transcripts changed this long before the send are searched too
const SCAN_DIRS_MAX = 2000;
const CHAIN_MAX = 64;

const msg = (e) => String((e && e.message) || e);

/**
 * @param {{
 *   fs?: typeof nodeFs, platform?: string, now: () => number, sleep: (ms: number) => Promise<void>,
 *   runChild: (cmd: string, args: string[], o: { cwd?: string, timeoutMs: number, env?: Record<string, string> }) => Promise<any>,
 *   cli: () => ({ path: string }|{ error: string }),
 *   claudeHome: () => string|null, projectsDir?: () => string|null, storageDir?: () => string|null,
 *   randomBytes?: (n: number) => Buffer, isAlive?: (pid: number) => boolean, hostPid?: number,
 *   processChain?: (pid: number) => Promise<number[]>, firstLine?: (s: string) => string, log?: (line: string) => void,
 * }} deps
 */
function createInWindow(deps) {
  const fsx = deps.fs || nodeFs;
  const platform = deps.platform || process.platform;
  const log = (line) => { try { if (typeof deps.log === 'function') deps.log(String(line)); } catch { /* never throws */ } };
  const firstLine = typeof deps.firstLine === 'function' ? deps.firstLine : (s) => String(s || '').split(/\r?\n/)[0].slice(0, 300);
  const randomBytes = typeof deps.randomBytes === 'function' ? deps.randomBytes : crypto.randomBytes;
  const isAlive = typeof deps.isAlive === 'function' ? deps.isAlive : defaultIsAlive;
  const hostPid = Number.isInteger(deps.hostPid) ? deps.hostPid : process.pid;
  let pidNsCache;

  const home = () => {
    try {
      const h = deps.claudeHome ? deps.claudeHome() : null;
      return typeof h === 'string' && h ? h : null;
    } catch {
      return null;
    }
  };
  const sessionsDir = () => (home() ? nodePath.join(home(), 'sessions') : null);

  /** /proc/<pid>/stat → { ppid, starttime } (Linux), or null */
  function procStat(pid) {
    if (platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null;
    try {
      const s = String(fsx.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      const i = s.lastIndexOf(')');
      if (i < 0) return null;
      const f = s.slice(i + 2).trim().split(/\s+/);
      const ppid = Number(f[1]);
      return { ppid: Number.isInteger(ppid) ? ppid : null, starttime: f[19] != null && /^\d+$/.test(f[19]) ? f[19] : null };
    } catch {
      return null;
    }
  }

  function pidNs() {
    if (platform !== 'linux') return null;
    if (pidNsCache !== undefined) return pidNsCache;
    try {
      const v = String(fsx.readlinkSync('/proc/self/ns/pid'));
      pidNsCache = /^pid:\[\d+\]$/.test(v) ? v : null;
    } catch {
      pidNsCache = null;
    }
    return pidNsCache;
  }

  /** Every <digits>.json in sessions/, parsed leniently, with the liveness facts: [{ entry, facts }] */
  function readRegistry() {
    const dir = sessionsDir();
    if (!dir) return [];
    let names;
    try { names = fsx.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const raw of names) {
      const name = typeof raw === 'string' ? raw : raw && raw.name;
      if (!core.isRegistryFile(name)) continue; // never *.key, sockets or anything else
      const file = nodePath.join(dir, name);
      let j;
      try { j = JSON.parse(String(fsx.readFileSync(file, 'utf8'))); } catch { continue; }
      const entry = core.registryEntry(file, j);
      if (!entry) continue;
      let alive = false;
      try { alive = !!isAlive(entry.pid); } catch { alive = false; }
      const st = alive ? procStat(entry.pid) : null;
      out.push({ entry, facts: { alive, procStartNow: st ? st.starttime : null } });
    }
    return out;
  }

  /** One registry file read again (rule f), or null */
  function readEntry(file) {
    try { return core.registryEntry(file, JSON.parse(String(fsx.readFileSync(file, 'utf8')))); } catch { return null; }
  }

  /**
   * Targeting (rules a–d) on a fresh read of the registry.
   * @returns {ReturnType<typeof core.pickTarget> & { entry?: any }} entry: the chat's registry entry, also when it is
   *   not sendable (pid / entrypoint for the fallback)
   */
  function probe(session, stopSinceMs) {
    const sid = session && session.id;
    const entries = readRegistry();
    const r = core.pickTarget(entries, sid, { platform, now: deps.now(), stopSinceMs, pidNs: pidNs() });
    if (!r.ok) {
      const own = entries.filter((x) => x.entry.sessionId === sid && x.facts.alive);
      if (own.length === 1) r.entry = own[0].entry;
    }
    return r;
  }

  function sizeOf(file) {
    try { return fsx.statSync(file).size; } catch { return null; }
  }

  /** Bytes [from, end) of a file as text (at most TAIL_BYTES, the last ones), '' when unreadable */
  function readFrom(file, from) {
    let fd = null;
    try {
      const size = fsx.statSync(file).size;
      const start = Math.max(Number.isFinite(from) && from > 0 ? from : 0, size - TAIL_BYTES, 0);
      const len = size - start;
      if (len <= 0) return '';
      fd = fsx.openSync(file, 'r');
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = fsx.readSync(fd, buf, got, len - got, start + got);
        if (!n) break;
        got += n;
      }
      return buf.subarray(0, got).toString('utf8');
    } catch {
      return '';
    } finally {
      if (fd !== null) { try { fsx.closeSync(fd); } catch { /* closed */ } }
    }
  }

  /** Main transcripts (<projectsDir>/<dir>/*.jsonl) other than the chat's, changed since sinceMs, that hold the marker */
  function scanOthers(message, sinceMs, ownFile) {
    const root = (() => { try { return deps.projectsDir ? deps.projectsDir() : null; } catch { return null; } })();
    if (typeof root !== 'string' || !root) return [];
    const hits = [];
    let dirs;
    try { dirs = fsx.readdirSync(root); } catch { return []; }
    const own = ownFile ? nodePath.resolve(ownFile) : null;
    for (const d of dirs.slice(0, SCAN_DIRS_MAX)) {
      const dname = typeof d === 'string' ? d : d && d.name;
      if (!dname) continue;
      const dir = nodePath.join(root, dname);
      let files;
      try { files = fsx.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        const fname = typeof f === 'string' ? f : f && f.name;
        if (typeof fname !== 'string' || !fname.endsWith('.jsonl')) continue;
        const file = nodePath.join(dir, fname);
        if (own && nodePath.resolve(file) === own) continue;
        let st;
        try { st = fsx.statSync(file); } catch { continue; }
        if (!st.isFile() || st.mtimeMs < sinceMs - SCAN_SLACK_MS) continue;
        if (core.transcriptHasMarker(readFrom(file, 0), message)) hits.push(file);
      }
    }
    return hits;
  }

  /** The process chain of pid (itself, its parent, …) */
  async function chainOf(pid) {
    if (typeof deps.processChain === 'function') return deps.processChain(pid);
    if (platform === 'linux') {
      const chain = [];
      let cur = pid;
      while (Number.isInteger(cur) && cur > 0 && !chain.includes(cur) && chain.length < CHAIN_MAX) {
        chain.push(cur);
        const st = procStat(cur);
        if (!st) break;
        cur = st.ppid;
      }
      return chain;
    }
    const jump = require('./jump');
    const procs = await jump.listProcesses({ platform });
    return jump._internal.ancestry(pid, jump._internal.indexProcs(procs));
  }

  /** Whether the chat's process runs under this window's extension host */
  async function ownedHere(pid) {
    try {
      const chain = await chainOf(pid);
      return Array.isArray(chain) && chain.slice(1).includes(hostPid);
    } catch (e) {
      log(`autoresume: in-window: process chain: ${msg(e)}`);
      return false;
    }
  }

  function helperCwd(session) {
    const ok = (p) => {
      if (typeof p !== 'string' || !p || !nodePath.isAbsolute(p)) return false;
      try { return fsx.statSync(p).isDirectory(); } catch { return false; }
    };
    if (ok(session && session.cwd)) return session.cwd;
    let s = null;
    try { s = deps.storageDir ? deps.storageDir() : null; } catch { s = null; }
    if (typeof s === 'string' && s && nodePath.isAbsolute(s)) {
      try { fsx.mkdirSync(s, { recursive: true }); } catch { /* checked below */ }
      if (ok(s)) return s;
    }
    return null;
  }

  /**
   * One helper run. On a timeout the runner kills the helper by its own pid (never by pattern). Afterwards its own
   * registry file <claudeHome>/sessions/<its pid>.json (that one name only) must be gone; it is waited for a little and
   * a leftover is logged (never deleted: it belongs to Claude Code).
   */
  async function runHelper(cli, o) {
    const args = core.helperArgs(o);
    if (!args) return { status: 'bad', detail: 'bad name' };
    const r = await deps.runChild(cli, args, { cwd: o.cwd, timeoutMs: HELPER_TIMEOUT_MS, env: { ...core.HELPER_ENV } });
    const res = core.parseHelperResult(r);
    if (res.status !== 'sent') {
      const line = r && (firstLine(r.stderr) || (res.status === 'exit' ? firstLine(r.stdout) : ''));
      if (line) log(`autoresume: in-window: helper said: ${line}`);
    }
    await helperGone(r && r.pid);
    return res;
  }

  /** Waits until the helper's own registry file is gone; false (and a log line) when it is still there */
  async function helperGone(pid) {
    const dir = sessionsDir();
    if (!dir || !Number.isInteger(pid) || pid <= 0) return true;
    const file = nodePath.join(dir, `${pid}.json`);
    const deadline = deps.now() + HELPER_GONE_MS;
    for (;;) {
      let there = false;
      try { there = fsx.existsSync(file); } catch { there = false; }
      if (!there) return true;
      if (deps.now() >= deadline) break;
      await deps.sleep(HELPER_GONE_POLL_MS);
    }
    log(`autoresume: in-window: the helper's registry file ${pid}.json is still there after it ended`);
    return false;
  }

  /**
   * Sends the resume message into the chat's own window and checks it arrived.
   * @param {any} session
   * @param {{ trigger?: string|null, account?: string|null, prompt?: string|null, stopSinceMs?: number|null }} o
   * @returns {Promise<{ result: 'messaged' } | { result: 'notOpen' } | { result: 'busy' }
   *   | { result: 'misdelivered', files: string[] } | { result: 'unsendable', reason: string, entry: any|null }
   *   | { result: 'unverified', reason: string, entry: any|null, sentAtMs: number }>}
   */
  async function send(session, o = {}) {
    const t = probe(session, o.stopSinceMs);
    if (!t.ok) {
      if (!t.open) return { result: 'notOpen' };
      if (t.reason === 'busy') return { result: 'busy' };
      return { result: 'unsendable', reason: t.reason, entry: t.entry || null };
    }
    const target = t.target;
    const transcript = session && typeof session.transcript === 'string' && nodePath.isAbsolute(session.transcript) ? session.transcript : null;
    if (!transcript || sizeOf(transcript) === null) return { result: 'unsendable', reason: 'noTranscript', entry: target };
    let found;
    try { found = deps.cli(); } catch { found = null; }
    if (!found || found.error || typeof found.path !== 'string' || !found.path) return { result: 'unsendable', reason: 'cliNotFound', entry: target };
    const cwd = helperCwd(session);
    if (!cwd) return { result: 'unsendable', reason: 'noCwd', entry: target };
    let nonce;
    try { nonce = core.makeNonce(randomBytes); } catch { return { result: 'unsendable', reason: 'nonce', entry: target }; }
    const message = core.buildMessage({ nonce, trigger: o.trigger, account: o.account, prompt: o.prompt });
    if (!message) return { result: 'unsendable', reason: 'nonce', entry: target };
    const permissionMode = core.permissionModeOf(readFrom(transcript, 0));
    // The registry is read once more right before the send: still exactly this target, still idle
    const again = probe(session, o.stopSinceMs);
    if (!again.ok || !core.sameTarget(target, again.target)) {
      if (!again.ok && again.reason === 'busy') return { result: 'busy' };
      if (!again.ok && !again.open) return { result: 'notOpen' };
      return { result: 'unsendable', reason: again.ok ? 'changed' : again.reason, entry: target };
    }
    const sentAtMs = deps.now();
    const sizeBefore = sizeOf(transcript);
    log(`autoresume: in-window: sending to "${target.name}" (pid ${target.pid}, mode ${permissionMode}, marker ${nonce})`);
    const res = await runHelper(found.path, { name: target.name, text: message.text, permissionMode, cwd });
    // Anything but SENT or a clean "not sent" may still have sent it: checked like a send, never counted as delivered
    const maybe = core.mayHaveSent(res.status);
    if (res.status !== 'sent') {
      log(`autoresume: in-window: not sent (${res.status}: ${res.detail})`);
      if (!maybe) return { result: 'unsendable', reason: `helper:${res.status}`, entry: target };
    }
    const same = core.sameTarget(target, readEntry(target.file));
    if (!same) log('autoresume: in-window: the registry entry changed during the send');
    const deadline = deps.now() + VERIFY_MS;
    let landed = false;
    for (;;) {
      if (core.transcriptHasMarker(readFrom(transcript, 0), message)) { landed = true; break; }
      if (deps.now() >= deadline) break;
      await deps.sleep(VERIFY_POLL_MS);
    }
    const others = scanOthers(message, sentAtMs, transcript);
    if (others.length) return { result: 'misdelivered', files: others };
    const stillSame = same && core.sameTarget(target, readEntry(target.file));
    if (res.status === 'sent' && landed && stillSame) return { result: 'messaged' };
    const reason = res.status !== 'sent' ? res.status : landed ? 'registryChanged' : 'noMarker';
    log(`autoresume: in-window: not verified (${reason})`);
    return { result: 'unverified', reason, entry: target, sentAtMs, sizeBefore };
  }

  /**
   * Fallback ii: a new user entry in the chat's transcript after fromSize (sinceMs) within timeoutMs. stillStopped():
   * false once the snapshot shows the chat moved on (that counts as continued too). aborted(): stop waiting.
   * @returns {Promise<'prompt'|'movedOn'|'timeout'|'aborted'>}
   */
  async function waitForPrompt(session, o = {}) {
    const file = session && session.transcript;
    const from = Number.isFinite(o.fromSize) ? o.fromSize : sizeOf(file);
    const deadline = deps.now() + (Number.isFinite(o.timeoutMs) ? o.timeoutMs : WAIT_PROMPT_MS);
    for (;;) {
      if (typeof o.aborted === 'function' && o.aborted()) return 'aborted';
      if (from !== null && core.hasNewUserPrompt(readFrom(file, from), o.sinceMs)) return 'prompt';
      if (typeof o.stillStopped === 'function' && !o.stillStopped()) return 'movedOn';
      if (deps.now() >= deadline) return 'timeout';
      await deps.sleep(Math.min(WAIT_POLL_MS, Math.max(1, deadline - deps.now())));
    }
  }

  return { probe, send, waitForPrompt, ownedHere, sizeOf, readRegistry, scanOthers, helperGone };
}

/** process.kill(pid, 0): alive, or EPERM (alive, another user's) */
function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

module.exports = {
  createInWindow, defaultIsAlive,
  HELPER_TIMEOUT_MS, HELPER_GONE_MS, VERIFY_MS, VERIFY_POLL_MS, WAIT_PROMPT_MS, WAIT_POLL_MS, TAIL_BYTES,
};
