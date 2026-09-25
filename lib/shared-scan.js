'use strict';
// One scan shared by all VS Code windows: every window runs its own extension host and worker, but only one window (the
// leader) scans; the others (followers) read its snapshots from disk. No vscode import: fs, clock and timers are injectable.
//
// Files in dir (all written atomically: tmp file + rename; missing, partial or corrupt files are treated as absent):
//   leader.json    { id, cfgKey, beat, hb, publishing? }       who scans; refreshed every heartbeat (publishing: false while
//                                                              its snapshot writes keep failing)
//   snapshot.json  { leaderId, cfgKey, at, snap }              the leader's latest snapshot (not rewritten when only snap.now
//                                                              changed; removed when the leader stops)
//   win-<id>.json  { id, cfgKey, focus: [keys], focused, beat, hb, hostPid, terminals, folders, storageDir, workspaceFile,
//                    empty }                                   one per window; rewritten on every heartbeat and on every change.
//                                                              hostPid / terminals / folders: the window's extension-host pid,
//                                                              its integrated terminals' shell pids and its workspace folders;
//                                                              storageDir / workspaceFile / empty: which Copilot chats it can
//                                                              load (setHost), so "Go to agent" (lib/jump.js) can find the
//                                                              window that owns a chat or a terminal
//   refresh.json   { from, at, n }                             a follower asks the leader to rescan now (content changes each time)
//   jump.<req>.<to>.json { id, from, to, at, expires, action } a window asks window <to> to bring up a chat / terminal
//                                                              (requestJump); <to> takes it (deletes it, then onJump) on its
//                                                              next poll, which fs.watch triggers at once; expired ones are
//                                                              ignored, and the leader sweeps the ones nobody took
// The dir is made private (mode 0700, files 0600). Any process of this user can still write into it, so a jump request is
// only handed on when it is small (JUMP_MAX_BYTES), a regular file, well-formed (ids, from, to, at, expires within
// JUMP_MAX_TTL_MS) and not expired, at most MAX_JUMPS_PER_POLL per poll; lib/jump.js then checks the action itself. Jump
// requests are neither written nor taken while the dir is not private (a symlink, another owner, chmod failed).
//
// Roles:
//   leader    scans; its worker gets the union of the focus keys of all fresh windows with the same cfgKey (onFocusUnion)
//             and it calls publish(snap) for each snapshot.
//   follower  a fresh leader with my cfgKey exists: do not scan, render the snapshots from onSnapshot (only the ones that
//             leader wrote, so a file left by an earlier leader is never shown).
//   solo      a fresh leader exists but its cfgKey differs from mine, or it cannot write its snapshots (publishing: false),
//             or my claim could not be written (e.g. a full disk; retried every heartbeat): scan myself (onFocusUnion gets
//             my own keys), neither follow nor claim.
//   null      before start / after stop / while my first claim settles / no leader and I may not lead (setCanLead(false),
//             e.g. my worker keeps crashing): the worker should stay paused.
// Election: a window claims when leader.json is missing, corrupt or stale (beat older than staleMs; a follower that has
// seen a live leader also gives it one more heartbeat to refresh, so waking from sleep does not move leadership). Last
// writer wins: a claim is confirmed settleMs after writing only if leader.json still holds my id, and a leader that
// reads another fresh id steps down. A brief double leader is harmless.
//
// API:
//   createSharedScan({ dir, windowId?, cfgKey, fs?, now?, setTimeout?, clearTimeout?, setInterval?, clearInterval?,
//     watch? = true, heartbeatMs? = 2000, idleHeartbeatMs? = heartbeatMs, staleMs? = 8000, settleMs? = 150,
//     soloGraceMs? = 3000, sweepMs?, debounceMs? = 25, canLead? = true, host? = { hostPid, terminals, folders, … },
//     onRole(role, prev), onSnapshot(snap), onFocusUnion(keys), onRefreshRequest(), onPresence({ anyFocused }),
//     onJump({ id, from, at, action }), onError(err), platform? })
//   -> { start(), stop(), setFocus(keys), setWindowFocused(bool), setCfgKey(key), setCanLead(bool),
//        setIdleHeartbeatMs(ms), publish(snap, { force }?) -> bool, requestRefresh() -> bool, anyWindowFocused() -> bool,
//        focusKeys() -> keys, setHost({ hostPid, terminals, folders, storageDir, workspaceFile, empty }), windows() ->
//        [{ id, self, focused, hostPid, terminals, folders, storageDir, workspaceFile, empty }], requestJump(toId, action, { ttlMs }?) -> request id | null,
//        cancelJump(toId, reqId) -> bool (true: removed before that window took it), role, id }
// windows(): the fresh window files read now (this window first, self: true), for finding the window that owns a process.
// Callback order: on becoming leader or solo, onFocusUnion(keys) is called just before onRole, so the (paused) worker has
// its focus before it resumes; on becoming follower, onRole('follower') comes first, then onSnapshot with the current file.
// onFocusUnion is only called when the set changes; onPresence only when anyWindowFocused() changes (and once after start).
// anyWindowFocused(): this window, or any fresh window file (whatever its cfgKey) with focused: true.
// Latency: fs.watch on dir triggers a poll (debounced) in addition to the poll every heartbeat; followers ignore other
// windows' files in watch events (they only matter to the leader) and simply poll each heartbeat.
// Idle: while anyWindowFocused() is false, a window beats every idleHeartbeatMs instead (never faster than heartbeatMs).
// Each file carries its writer's period (hb), and staleMs is scaled by hb / heartbeatMs when judging it, so a slow writer
// is not taken for gone; switching to the slower period rewrites my files at once.
// requestRefresh(): as leader or solo calls onRefreshRequest() here; as follower writes refresh.json, the leader calls its
// onRefreshRequest() and writes its next publish even if unchanged (so the follower's progress indicator stops).
// Never throws from timers, watch callbacks or the caller's callbacks (errors go to onError).

const nodeFs = require('fs');
const nodePath = require('path');

const LEADER = 'leader.json';
const SNAPSHOT = 'snapshot.json';
const REFRESH = 'refresh.json';
const WIN_RE = /^win-(.+)\.json$/;
const JUMP_RE = /^jump\.([a-z0-9]+)\.(.+)\.json$/; // jump.<request id>.<target window id>.json (request ids have no dots)
const REQ_ID_RE = /^[a-z0-9]{1,40}$/;
const WIN_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;  // safeId() output
const JUMP_TTL_MS = 15000;      // default lifetime of a jump request
const JUMP_MAX_TTL_MS = 60e3;   // longest lifetime a request may ask for
const JUMP_SWEEP_MS = 60e3;     // the leader deletes requests this long past their expiry (their window never took them)
const JUMP_SKEW_MS = 5000;      // a request dated further in the future than this is not trusted
const JUMP_MAX_BYTES = 16 * 1024;   // a real request is a few hundred bytes
const WIN_MAX_BYTES = 1024 * 1024;  // a window file with MAX_TERMINALS pids and MAX_FOLDERS folders stays far below this
const MAX_JUMPS_PER_POLL = 8;   // requests handed on per poll; any beyond are deleted unread
const MAX_TERMINALS = 256;
const MAX_FOLDERS = 64;
const MAX_PATH = 4096;
const ROLES = Object.freeze({ LEADER: 'leader', FOLLOWER: 'follower', SOLO: 'solo' });
const PUBLISH_FAIL_LIMIT = 3;   // failed snapshot writes in a row after which the leader tells followers to scan themselves
const MAX_HB_MS = 10 * 60e3;    // a period announced in a file is capped at this (a corrupt value must not keep it fresh)

// Reads open files non-blocking where the platform has it (POSIX), so a FIFO planted in the dir cannot block a read
const OPEN_FLAGS = nodeFs.constants && nodeFs.constants.O_NONBLOCK ? nodeFs.constants.O_RDONLY | nodeFs.constants.O_NONBLOCK : 'r';

const pos = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
const nonneg = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);

function safeId(v) {
  return String(v).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'w';
}

function defaultId() {
  return `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Presence fields for "Go to agent": extension-host pid, terminal shell pids (unique, sorted), workspace folders, and the
 * workspace storage dir / .code-workspace file / whether the window is empty (which Copilot chats it can load)
 */
function cleanHost(v) {
  const o = v && typeof v === 'object' ? v : {};
  const isPid = (x) => Number.isInteger(x) && x > 0;
  const str = (x) => (typeof x === 'string' && x && x.length <= MAX_PATH ? x : null);
  return {
    hostPid: isPid(o.hostPid) ? o.hostPid : null,
    terminals: [...new Set((Array.isArray(o.terminals) ? o.terminals : []).filter(isPid))].sort((a, b) => a - b).slice(0, MAX_TERMINALS),
    folders: (Array.isArray(o.folders) ? o.folders : []).filter((f) => str(f) !== null).slice(0, MAX_FOLDERS),
    storageDir: str(o.storageDir),
    workspaceFile: str(o.workspaceFile),
    empty: o.empty === true,
  };
}

/** Unique non-empty string keys, sorted (a stable signature) */
function cleanKeys(keys) {
  return [...new Set((Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k))].sort();
}

function createSharedScan(o = {}) {
  const fs = o.fs || nodeFs;
  const dir = String(o.dir || '');
  const posix = (o.platform || process.platform) !== 'win32';
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const T = {
    setTimeout: o.setTimeout || setTimeout,
    clearTimeout: o.clearTimeout || clearTimeout,
    setInterval: o.setInterval || setInterval,
    clearInterval: o.clearInterval || clearInterval,
  };
  const heartbeatMs = pos(o.heartbeatMs, 2000);
  let idleHeartbeatMs = pos(o.idleHeartbeatMs, heartbeatMs);
  const staleMs = pos(o.staleMs, 8000);
  const settleMs = nonneg(o.settleMs, 150);
  const soloGraceMs = nonneg(o.soloGraceMs, 3000);
  const sweepMs = pos(o.sweepMs, Math.max(staleMs * 4, 60e3)); // the leader deletes win files this old (crashed windows)
  const debounceMs = nonneg(o.debounceMs, 25);
  const useWatch = o.watch !== false && typeof fs.watch === 'function';
  const id = safeId(o.windowId || defaultId());
  const winName = `win-${id}.json`;

  let running = false;
  let role = null;
  let canLead = o.canLead !== false;
  let hbMs = heartbeatMs;   // my current heartbeat period (idleHeartbeatMs while no window has focus)
  let leaderId = null;      // follower: the leader whose snapshots I render
  let pubFails = 0;         // leader: snapshot writes that failed in a row
  let cfgKey = String(o.cfgKey == null ? '' : o.cfgKey);
  let focus = [];
  let focused = false;
  let host = cleanHost(o.host); // my presence fields for "Go to agent"
  let myJumps = [];         // jump request files addressed to me, seen by the last scan
  let otherJumps = [];      // jump request files for other windows (the leader sweeps expired ones)
  let others = new Map();   // window id -> { cfgKey, focus, focused, beat } (fresh windows other than me)
  let staleWins = [];       // win file names to sweep (leader only)
  let claimAt = null;       // my claim is waiting for settleMs
  let suspect = null;       // { id, beat, at }: a stale leader seen by a follower / solo, given one more heartbeat
  let mismatchSince = null; // follower: when the leader's cfgKey started to differ from mine
  let unionSig = null;
  let presence = null;
  let pubSig = null;
  let forcePublish = false;
  let snapSig = null;
  let refreshSeen = null;
  let refreshSeq = 0;
  let hbTimer = null;
  let settleTimer = null;
  let debounceTimer = null;
  let watcher = null;

  const file = (name) => nodePath.join(dir, name);
  const tmpName = (name) => `.${name}.${id}.tmp`;

  function report(err) {
    if (typeof o.onError !== 'function') return;
    try { o.onError(err); } catch { /* ignore */ }
  }

  function call(fn, ...args) {
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (err) { report(err); }
  }

  function safe(fn) {
    try { fn(); } catch (err) { report(err); }
  }

  function unref(h) {
    if (h && typeof h.unref === 'function') h.unref();
    return h;
  }

  // Regular files only (opened non-blocking and checked with fstat: a FIFO would block the extension host), at most max
  // bytes when given; no more system calls than a plain readFileSync(path)
  function readRaw(name, max) {
    let fd = null;
    try {
      fd = fs.openSync(file(name), OPEN_FLAGS);
      const st = fs.fstatSync(fd);
      if (!st.isFile() || (max && st.size > max)) return null;
      return fs.readFileSync(fd, 'utf8');
    } catch {
      return null;
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
  }

  function readJson(name, max) {
    const raw = readRaw(name, max);
    if (raw == null) return null;
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch { return null; }
  }

  function writeJson(name, obj) {
    const data = JSON.stringify(obj);
    const tmp = file(tmpName(name));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.writeFileSync(tmp, data, { mode: 0o600 });
        fs.renameSync(tmp, file(name));
        return true;
      } catch (err) {
        if (err && err.code === 'ENOENT') { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }
        if (attempt === 2) {
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          report(err);
        }
      }
    }
    return false;
  }

  function remove(name) {
    try { fs.unlinkSync(file(name)); } catch { /* ignore */ }
  }

  /**
   * Whether dir is private: a real directory (not a symlink) owned by this user and closed to group and others (made so
   * with chmod 0700 when it is not; lib/notify.js does the same). Windows: the profile folder's ACLs apply. Jump
   * requests are only written and taken while this holds.
   */
  let privateWarned = false;
  function isPrivate() {
    if (!posix) return true;
    try {
      let st = fs.lstatSync(dir);
      const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
      if (!st.isDirectory() || (uid >= 0 && st.uid !== uid)) throw new Error('not a directory owned by this user');
      if (st.mode & 0o077) {
        fs.chmodSync(dir, 0o700);
        st = fs.lstatSync(dir);
        if (st.mode & 0o077) throw new Error('cannot make it private');
      }
      return true;
    } catch (err) {
      if (!privateWarned) {
        privateWarned = true;
        report(new Error(`${dir}: ${(err && err.message) || err}; requests between windows are off`));
      }
      return false;
    }
  }

  // How long a file stays fresh: staleMs, scaled up for a writer that announced a slower heartbeat (hb) than heartbeatMs
  function staleFor(hb) {
    const h = Number.isFinite(hb) && hb > heartbeatMs ? Math.min(hb, MAX_HB_MS) : heartbeatMs;
    return staleMs * (h / heartbeatMs);
  }

  const isFresh = (beat, t, hb) => Number.isFinite(beat) && Math.abs(t - beat) <= staleFor(hb);

  function writeWin(t) {
    writeJson(winName, { id, cfgKey, focus, focused, beat: t, hb: hbMs, ...host });
  }

  function writeLeader(t) {
    const L = { id, cfgKey, beat: t, hb: hbMs };
    if (pubFails >= PUBLISH_FAIL_LIMIT) L.publishing = false;
    return writeJson(LEADER, L);
  }

  // Read the other windows' files: fresh ones go to others, stale or corrupt ones older than sweepMs are swept by the leader
  function scanWindows(t) {
    let names;
    try { names = fs.readdirSync(dir); } catch { names = []; }
    const next = new Map();
    const sweep = [];
    const mine = [];
    const theirs = [];
    for (const name of names) {
      const j = JUMP_RE.exec(name);
      if (j) { (j[2] === id ? mine : theirs).push(name); continue; }
      const m = WIN_RE.exec(name);
      if (!m || name === winName) continue;
      const w = readJson(name, WIN_MAX_BYTES);
      if (!w) { sweep.push(name); continue; }
      if (!isFresh(w.beat, t, w.hb)) {
        if (!Number.isFinite(w.beat) || Math.abs(t - w.beat) > Math.max(sweepMs, staleFor(w.hb))) sweep.push(name);
        continue;
      }
      next.set(m[1], {
        cfgKey: String(w.cfgKey == null ? '' : w.cfgKey),
        focus: cleanKeys(w.focus),
        focused: w.focused === true,
        beat: w.beat,
        hb: w.hb,
      });
    }
    others = next;
    staleWins = sweep;
    myJumps = mine;
    otherJumps = theirs;
  }

  /**
   * A jump request as read from its file → { id, from, at, action }, or null unless it is well-formed, addressed to me
   * under the id in its file name, from another window, and within its lifetime (which may not exceed JUMP_MAX_TTL_MS)
   */
  function jumpRequest(req, reqId, t) {
    if (!req || req.to !== id || req.id !== reqId || !REQ_ID_RE.test(reqId)) return null;
    if (typeof req.from !== 'string' || !WIN_ID_RE.test(req.from) || req.from === id) return null;
    const { at, expires } = req;
    if (!Number.isFinite(at) || !Number.isFinite(expires) || expires < at || expires - at > JUMP_MAX_TTL_MS) return null;
    if (expires < t || at > t + JUMP_SKEW_MS) return null;
    return { id: reqId, from: req.from, at, action: req.action };
  }

  // Jump requests addressed to me: each is deleted first (so it runs once), then handed to onJump when jumpRequest accepts
  // it; at most MAX_JUMPS_PER_POLL per poll, the rest are deleted unread. Left alone while the dir is not private.
  function takeJumps(t) {
    const names = myJumps.sort();
    myJumps = [];
    if (!names.length || !isPrivate()) return;
    let handed = 0;
    for (const name of names) {
      const over = handed >= MAX_JUMPS_PER_POLL;
      const req = over ? null : readJson(name, JUMP_MAX_BYTES);
      try { fs.unlinkSync(file(name)); } catch { continue; } // already taken
      const r = req && jumpRequest(req, JUMP_RE.exec(name)[1], t);
      if (!r) continue;
      handed++;
      call(o.onJump, r);
    }
  }

  // Leader: requests whose window never took them (it closed or crashed), and ones that could never be taken
  function sweepJumps(t) {
    const names = otherJumps;
    otherJumps = [];
    for (const name of names) {
      const req = readJson(name, JUMP_MAX_BYTES);
      const bad = !req || !Number.isFinite(req.expires) || !Number.isFinite(req.at) || req.expires - req.at > JUMP_MAX_TTL_MS || req.at > t + JUMP_SKEW_MS;
      if (bad || t - req.expires > JUMP_SWEEP_MS) remove(name);
    }
  }

  // The keys my worker should scan details for: the union across same-config windows for the leader, my own for solo
  function focusKeys() {
    if (role === ROLES.SOLO) return focus.slice();
    if (role !== ROLES.LEADER) return [];
    const all = new Set(focus);
    const t = now();
    for (const w of others.values()) {
      if (w.cfgKey === cfgKey && isFresh(w.beat, t, w.hb)) for (const k of w.focus) all.add(k);
    }
    return [...all].sort();
  }

  function updateUnion() {
    if (role !== ROLES.LEADER && role !== ROLES.SOLO) return;
    const keys = focusKeys();
    const sig = keys.join('\n');
    if (sig === unionSig) return;
    unionSig = sig;
    call(o.onFocusUnion, keys);
  }

  function anyWindowFocused() {
    if (focused) return true;
    const t = now();
    for (const w of others.values()) if (w.focused && isFresh(w.beat, t, w.hb)) return true;
    return false;
  }

  function updatePresence() {
    const v = anyWindowFocused();
    if (v === presence) return;
    presence = v;
    retime();
    call(o.onPresence, { anyFocused: v });
  }

  function armHeartbeat() {
    if (hbTimer) T.clearInterval(hbTimer);
    hbTimer = running ? unref(T.setInterval(() => safe(heartbeat), hbMs)) : null;
  }

  // Heartbeat period for the current presence; a slower period is announced in my files right away, so no one reads the
  // old, shorter one and takes them for stale before my next beat
  function retime() {
    const next = presence === false ? Math.max(heartbeatMs, idleHeartbeatMs) : heartbeatMs;
    if (next === hbMs) return;
    const slower = next > hbMs;
    hbMs = next;
    if (!running) return;
    armHeartbeat();
    if (!slower) return;
    writeWin(now());
    if (role === ROLES.LEADER && claimAt == null) writeLeader(now());
  }

  function setRole(r) {
    if (r === role) return;
    const prev = role;
    role = r;
    mismatchSince = null;
    suspect = null;
    unionSig = null;
    if (r === ROLES.LEADER) {
      pubSig = null;
      forcePublish = false;
      pubFails = 0;
      refreshSeen = readRaw(REFRESH); // requests made before I led are not mine to answer
    }
    if (r === ROLES.FOLLOWER) snapSig = null;
    updateUnion(); // leader / solo: the worker gets its focus before it resumes
    call(o.onRole, r, prev);
    if (r === ROLES.FOLLOWER) readSnapshot();
  }

  function clearSettle() {
    if (settleTimer) T.clearTimeout(settleTimer);
    settleTimer = null;
  }

  function claim(t) {
    if (!canLead) { setRole(null); return; } // nothing to show until a leader appears
    // Cannot write leader.json (full disk, permissions): scan alone instead of waiting for a leader that never comes;
    // the claim is retried on every heartbeat
    if (!writeLeader(t)) { setRole(ROLES.SOLO); return; }
    claimAt = t;
    if (settleMs <= 0) { claimAt = null; setRole(ROLES.LEADER); return; }
    clearSettle();
    settleTimer = unref(T.setTimeout(() => safe(confirmClaim), settleMs));
  }

  function confirmClaim() {
    settleTimer = null;
    if (!running || claimAt == null) return;
    const L = readJson(LEADER);
    if (L && L.id === id) {
      claimAt = null;
      scanWindows(now());
      setRole(ROLES.LEADER);
      afterPoll();
    } else {
      poll();
    }
  }

  function follow(L, t) {
    if (L.id !== leaderId) { leaderId = L.id; snapSig = null; } // only this leader's snapshots count from now on
    const own = canLead ? ROLES.SOLO : null;
    if (L.publishing === false) { setRole(own); return; } // its snapshots cannot be written: they would freeze
    if (String(L.cfgKey) === cfgKey) {
      mismatchSince = null;
      setRole(ROLES.FOLLOWER);
      return;
    }
    // A follower waits soloGraceMs before scanning on its own: when a setting changes, every window gets the change
    // within moments, and the leader may have written its new cfgKey first
    if (role === ROLES.FOLLOWER && soloGraceMs > 0) {
      if (mismatchSince == null) mismatchSince = t;
      if (t - mismatchSince < soloGraceMs) return;
    }
    setRole(own);
  }

  function readSnapshot() {
    let st;
    try { st = fs.statSync(file(SNAPSHOT)); } catch { return; }
    const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (sig === snapSig) return;
    snapSig = sig;
    const p = readJson(SNAPSHOT);
    // Written by an earlier leader (e.g. left from yesterday's session): wait for the current leader's first publish
    if (!p || p.leaderId !== leaderId || String(p.cfgKey) !== cfgKey || !p.snap || typeof p.snap !== 'object') return;
    call(o.onSnapshot, p.snap);
  }

  function checkRefresh() {
    const raw = readRaw(REFRESH);
    if (raw === refreshSeen) return;
    refreshSeen = raw;
    if (raw == null) return;
    forcePublish = true;
    call(o.onRefreshRequest);
  }

  function afterPoll() {
    takeJumps(now()); // whatever my role
    if (role === ROLES.LEADER) {
      updateUnion();
      checkRefresh();
      for (const name of staleWins) remove(name);
      staleWins = [];
      sweepJumps(now());
    } else if (role === ROLES.FOLLOWER) {
      readSnapshot();
    }
    updatePresence();
  }

  function poll() {
    if (!running) return;
    const t = now();
    scanWindows(t);
    const L = readJson(LEADER);
    const valid = !!L && typeof L.id === 'string' && L.id !== '';
    const fresh = valid && isFresh(L.beat, t, L.hb);
    if (claimAt != null) {
      if (valid && L.id === id) { /* wait for confirmClaim */ } else if (fresh) { claimAt = null; clearSettle(); follow(L, t); } else claim(t);
    } else if (role === ROLES.LEADER) {
      if (fresh && L.id !== id) follow(L, t); // someone claimed after me: last writer wins
      else if (!valid || L.id !== id || !fresh || String(L.cfgKey) !== cfgKey) writeLeader(t); // lost or damaged: write it back
    } else if (!valid) {
      claim(t);
    } else if (!fresh) {
      // Missing heartbeats: at start claim at once; a follower gives the leader one more heartbeat (e.g. after sleep)
      if (role == null) claim(t);
      else if (suspect && suspect.id === L.id && suspect.beat === L.beat) {
        if (t - suspect.at >= Math.max(heartbeatMs, Math.min(pos(L.hb, 0), MAX_HB_MS))) claim(t);
      }
      else suspect = { id: L.id, beat: L.beat, at: t };
    } else {
      suspect = null;
      if (L.id === id) { writeLeader(t); setRole(ROLES.LEADER); } else follow(L, t);
    }
    afterPoll();
  }

  function heartbeat() {
    if (!running) return;
    writeWin(now());
    poll();
    if (running && role === ROLES.LEADER && claimAt == null) writeLeader(now());
  }

  function schedulePoll() {
    if (!running || debounceTimer) return;
    debounceTimer = unref(T.setTimeout(() => { debounceTimer = null; safe(poll); }, debounceMs));
  }

  function onWatch(_ev, name) {
    const n = name == null ? '' : String(name);
    if (n.endsWith('.tmp') || n === winName) return; // my own writes
    const j = JUMP_RE.exec(n);
    if (j) { if (j[2] === id) schedulePoll(); return; } // a jump request for me is taken at once; others' are not my business
    if (n === SNAPSHOT && role !== ROLES.FOLLOWER) return;
    if (WIN_RE.test(n) && role !== ROLES.LEADER) return; // only the leader needs other windows' focus at once; the rest poll each heartbeat
    schedulePoll();
  }

  function startWatch() {
    if (!useWatch) return;
    try {
      watcher = fs.watch(dir, { persistent: false }, (ev, name) => safe(() => onWatch(ev, name)));
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', (err) => { report(err); stopWatch(); }); // polling every heartbeat still works
      }
    } catch (err) {
      watcher = null;
      report(err);
    }
  }

  function stopWatch() {
    const w = watcher;
    watcher = null;
    if (w) { try { w.close(); } catch { /* ignore */ } }
  }

  const api = {
    get role() { return role; },
    get id() { return id; },

    start() {
      if (running) return;
      running = true;
      hbMs = heartbeatMs;
      safe(() => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }));
      isPrivate(); // chmod 0700 now, so the files written next are not readable by other users even briefly
      safe(() => { writeWin(now()); poll(); });
      armHeartbeat();
      startWatch();
    },

    stop() {
      if (!running) return;
      running = false;
      if (hbTimer) T.clearInterval(hbTimer);
      hbTimer = null;
      clearSettle();
      if (debounceTimer) T.clearTimeout(debounceTimer);
      debounceTimer = null;
      stopWatch();
      safe(() => {
        remove(winName);
        const L = readJson(LEADER);
        if (L && L.id === id) {
          remove(LEADER);   // another window takes over at once
          remove(SNAPSHOT); // nobody reads it after I leave (followers only take their current leader's), so don't keep a copy
        }
        for (const name of [LEADER, SNAPSHOT, REFRESH, winName]) remove(tmpName(name));
      });
      role = null;
      claimAt = null;
      leaderId = null;
      others = new Map();
      presence = null;
    },

    setFocus(keys) {
      const next = cleanKeys(keys);
      if (next.join('\n') === focus.join('\n')) return;
      focus = next;
      if (!running) return;
      safe(() => { writeWin(now()); updateUnion(); });
    },

    setWindowFocused(v) {
      const next = !!v;
      if (next === focused) return;
      focused = next;
      if (!running) return;
      safe(() => { updatePresence(); writeWin(now()); }); // presence first: the file then carries the new period
    },

    setCfgKey(key) {
      const next = String(key == null ? '' : key);
      if (next === cfgKey) return;
      cfgKey = next;
      if (!running) return;
      safe(() => {
        writeWin(now());
        snapSig = null;
        if (role === ROLES.LEADER) {
          writeLeader(now());
          pubSig = null; // the next snapshot is written under the new key even if it looks the same
          updateUnion();
        } else {
          poll();
        }
      });
    },

    /**
     * Leader only: write the snapshot for the followers; skipped (false) when nothing except snap.now changed, unless
     * force. After PUBLISH_FAIL_LIMIT failed writes in a row, leader.json says publishing: false (followers scan
     * themselves) until a write succeeds again.
     */
    publish(snap, opts) {
      if (!running || role !== ROLES.LEADER || !snap || typeof snap !== 'object') return false;
      try {
        const sig = JSON.stringify({ ...snap, now: 0 });
        if (!forcePublish && !(opts && opts.force) && sig === pubSig) return false;
        if (!writeJson(SNAPSHOT, { leaderId: id, cfgKey, at: now(), snap })) {
          if (++pubFails === PUBLISH_FAIL_LIMIT && claimAt == null) writeLeader(now());
          return false;
        }
        pubSig = sig;
        forcePublish = false;
        const wasStuck = pubFails >= PUBLISH_FAIL_LIMIT;
        pubFails = 0;
        if (wasStuck && claimAt == null) writeLeader(now()); // followers may follow again
        return true;
      } catch (err) {
        report(err);
        return false;
      }
    },

    /**
     * false: this window never claims (its worker cannot scan); as leader it steps down at once, as solo it gives up
     * scanning, and it follows a leader with the same cfgKey when there is one (role null otherwise). true: claims again.
     */
    setCanLead(v) {
      const next = v !== false;
      if (next === canLead) return;
      canLead = next;
      if (!running) return;
      safe(() => {
        if (!canLead) {
          if (role === ROLES.LEADER || claimAt != null) {
            clearSettle();
            claimAt = null;
            const L = readJson(LEADER);
            if (L && L.id === id) remove(LEADER); // another window takes over at once
          }
          if (role === ROLES.LEADER || role === ROLES.SOLO) setRole(null);
        }
        poll();
      });
    },

    /** Heartbeat period while no window has focus (never faster than heartbeatMs) */
    setIdleHeartbeatMs(ms) {
      idleHeartbeatMs = pos(ms, heartbeatMs);
      if (running) safe(retime);
    },

    requestRefresh() {
      if (!running) return false;
      if (role === ROLES.LEADER || role === ROLES.SOLO) {
        call(o.onRefreshRequest);
        return true;
      }
      return writeJson(REFRESH, { from: id, at: now(), n: `${++refreshSeq}-${Math.random().toString(36).slice(2, 8)}` });
    },

    /** My presence fields for "Go to agent" (cleanHost); rewrites my file on a change */
    setHost(info) {
      const next = cleanHost(info);
      if (JSON.stringify(next) === JSON.stringify(host)) return;
      host = next;
      if (running) safe(() => writeWin(now()));
    },

    /** Fresh windows (this one first, self: true) with their presence fields, read from disk now */
    windows() {
      const out = [{ id, self: true, focused, ...host }];
      if (!running) return out;
      const t = now();
      let names;
      try { names = fs.readdirSync(dir); } catch { names = []; }
      for (const name of names) {
        const m = WIN_RE.exec(name);
        if (!m || name === winName) continue;
        const w = readJson(name, WIN_MAX_BYTES);
        if (!w || !isFresh(w.beat, t, w.hb)) continue;
        out.push({ id: m[1], self: false, focused: w.focused === true, ...cleanHost(w) });
      }
      return out;
    },

    /**
     * Ask window toId to perform action (lib/jump.js decides what it may be); it takes the request on its next poll.
     * Returns the request id, or null when not running, toId is me, or the file could not be written.
     */
    requestJump(toId, action, opts) {
      if (!running || toId == null) return null;
      const to = safeId(toId);
      if (to === id || !isPrivate()) return null;
      const ttl = Math.min(pos(opts && opts.ttlMs, JUMP_TTL_MS), JUMP_MAX_TTL_MS);
      const reqId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.replace(/[^a-z0-9]/g, '');
      const t = now();
      try {
        return writeJson(`jump.${reqId}.${to}.json`, { id: reqId, from: id, to, at: t, expires: t + ttl, action }) ? reqId : null;
      } catch (err) {
        report(err);
        return null;
      }
    },

    /**
     * Withdraw a request that window toId has not taken yet (the requester stopped waiting for it, so it must not be
     * performed later). true when the file was still there and is now removed.
     */
    cancelJump(toId, reqId) {
      if (toId == null || !REQ_ID_RE.test(String(reqId || ''))) return false;
      try {
        fs.unlinkSync(file(`jump.${reqId}.${safeId(toId)}.json`));
        return true;
      } catch {
        return false;
      }
    },

    anyWindowFocused,
    focusKeys,
  };
  return api;
}

module.exports = { createSharedScan, ROLES, _internal: { cleanKeys, safeId, cleanHost, JUMP_RE, JUMP_MAX_BYTES, MAX_JUMPS_PER_POLL } };
