'use strict';
// "Go to agent": find where a session is actually running and bring that place up (its chat panel, editor tab or terminal).
// No vscode import: the process lister, the cwd / open-file lookups, the registry readers and the vscode API are all
// injectable, so the pure parts (process-tree parsing, ancestor matching, choosing a resolver, messages) are tested without
// VS Code.
//
// Resolvers (RESOLVERS, first match wins). Each turns a Session into a Plan: the window that owns it (null = this one) and
// the action to perform there:
//   claudeVscode   Claude Code VS Code extension chats (live registry entrypoint 'claude-vscode'): the claude process is a
//                  child of some window's extension host → claude-vscode.editor.open(sessionId, …, { programmatic:
//                  'honor-preferred-location' }) in that window. Without the 6th argument the command silently switches the
//                  user's preferred Claude location to "panel"; the user's settings must never change. It only knows its own
//                  window's tabs, so it must run in the owning window (elsewhere it would open a duplicate)
//   codexVscode    Codex VS Code extension (openai.chatgpt) threads: open the thread as an editor tab (vscode.openWith on
//                  openai-codex://route/local/<threadId> with the chatgpt.conversationEditor custom editor) in the window
//                  whose `codex app-server` holds the thread's rollout file open, else the one that runs Codex, else here.
//                  The vscode://openai.chatgpt deep link is not used: VS Code asks the user to allow it first
//   copilot        Copilot Chat: in the window whose workspace storage holds the chat (an empty window for empty-window
//                  chats): workbench.action.chat.openSessionInEditorGroup({ resource: vscode-chat-session://local/<b64url id> })
//                  (an internal VS Code command, so it is checked with getCommands first)
//   claudeCli, codexCli
//                  CLI sessions: find the agent's process (Claude: registry pid; Codex: the process that holds the rollout
//                  file open, else a search of the processes by command name and working directory), walk the process tree
//                  up and match an ancestor against the shell pids of the integrated terminals of this or another window →
//                  terminal.show() there. Last resort, macOS only (not in a remote window): a process in Terminal.app or
//                  iTerm2 → select its tab by tty with AppleScript, after a one-time confirmation (macOS asks for Automation
//                  permission). A registry pid (Claude) whose process started after the session registered it belongs to
//                  another program now (pid reuse): not running
//   claudeDesktop, codexDesktop
//                  not supported yet: a "not supported yet" reason
//
// Processes are listed only when the user asks for a jump: one `ps` call on macOS / Linux, one PowerShell Get-CimInstance
// call on Windows, each with a timeout (plus, for Codex, one `lsof` on macOS or /proc on Linux for the working directories
// or the holder of the rollout file). Session content is never read here; only the session fields the providers already
// expose and the Claude live registry (which the Claude provider reads anyway).
//
// Another window: each window's shared-scan presence record (win-<id>.json, lib/shared-scan.js) carries its extension-host
// pid, its terminals' shell pids, its folders and workspace storage. When the owner is another window, it gets a jump request
// (shared-scan requestJump); the owner performs the action itself (handleRequest), raises its own window (raiseWindow:
// workbench.action.focusWindow, else the code CLI with its own folder) and replies, so the requester only speaks up when that
// did not work. A request not answered within replyWaitMs is withdrawn (cancelJump), so it is not performed later.
// Requests come from files any process of this user can write: only the actions cleanAction accepts are performed, never an
// external-terminal one (no AppleScript for another window), and nothing from a request reaches a shell, osascript or
// cmd.exe (osascript and the code CLI get fixed scripts / arguments through execFile).
//
// API:
//   createJumper({ vscode, platform?, claudeHome?, claudeLive?, localInfo?, windows?, requestJump?, cancelJump?,
//                  raiseWindow?, confirmAutomation?, listProcesses?, processCwds?, fileHolders?, execFile?, replyWaitMs?, log? })
//     -> { goTo(session), plan(session), perform(action), handleRequest(req) }
//   messageOf(outcome, i18n, session?, { appName }?) -> { level: 'info'|'warn', text, button? } | null
//   worthTrying(session, now) -> whether to offer the jump (the panel's Go to button, the tree's inline action)

const nodeFs = require('fs');
const nodePath = require('path');
const nodeCp = require('child_process');
const S = require('./core/status');
const claudeLiveLib = require('./providers/claude-live');
const scopeLib = require('./scope');

const CLAUDE_OPEN_CMD = 'claude-vscode.editor.open'; // Claude Code: (sessionId?, prompt?, viewColumn?, groupId?, fullEditor?, { programmatic? })
const CLAUDE_OPEN_OPTS = Object.freeze({ programmatic: 'honor-preferred-location' }); // keeps the user's preferred location
const CLAUDE_VSCODE_ENTRY = 'claude-vscode';
const CODEX_EXT_ID = 'openai.chatgpt';
const CODEX_EDITOR = 'chatgpt.conversationEditor';   // Codex's custom editor for openai-codex://route/local/<threadId>
const CODEX_ID_RE = /^[A-Za-z0-9][\w-]{0,127}$/;     // same as lib/compact.js
// Internal VS Code command (not stable API): opens a local chat session in the active editor group, moving it out of the
// Chat view if it is shown there; checked with getCommands before use
const COPILOT_OPEN_CMD = 'workbench.action.chat.openSessionInEditorGroup';
const COPILOT_ID_RE = /^[\w.-]{1,128}$/;
// Force-focuses the calling window (VS Code 1.138: hostService.focus(window, { mode: 2 }); on macOS also app.focus({ steal }))
const FOCUS_WINDOW_CMD = 'workbench.action.focusWindow';
const AUTOMATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';
const PS_TIMEOUT_MS = 4000;
const WIN_TIMEOUT_MS = 10000;          // PowerShell starts slowly
const CLI_TIMEOUT_MS = 15000;          // the code CLI hands the folder to the running instance and exits
const OSA_TIMEOUT_MS = 120000;         // the first AppleScript call waits while macOS asks for Automation permission
const MAX_BUFFER = 32 * 1024 * 1024;   // ps output with long Electron command lines
const MAX_DEPTH = 64;                  // ancestors walked at most
const START_SLACK_MS = 2000;           // ps etime has one-second resolution
const REUSE_SLACK_MS = 5000;           // a registry pid whose process started this long after the registration was reused
const PID_WAIT_MS = 1500;              // Terminal.processId of a terminal whose process has not started yet
const RECENT_MS = 24 * 3600e3;         // targets without a process registry: offer the jump for sessions written this recently
const REQUEST_TTL_MS = 15000;          // a jump request another window has not taken by then is dropped
const REPLY_WAIT_MS = 5000;            // how long the requester waits for the owning window's reply

const REASON = Object.freeze({
  NOT_RUNNING: 'notRunning',   // the session has no live process
  NOT_FOUND: 'notFound',       // no matching process, the terminal is gone, or (app) no tab with that tty
  EXTERNAL: 'external',        // under no VS Code window (e.g. an external terminal); app: the terminal app when recognized
  BACKGROUND: 'background',    // started by an extension or another agent, not in a terminal or chat panel
  OTHER_WINDOW: 'otherWindow', // in a VS Code window Agent Monitor cannot reach (sharing off, another profile, older version)
  WINDOW_CLOSED: 'windowClosed', // Copilot: no open window has this chat's workspace
  UNSUPPORTED: 'unsupported',  // tool: which one (claudeDesktop / codexDesktop / a provider id)
  NO_COMMAND: 'noCommand',     // tool: the extension / command that would open it is missing in the owning window
  AUTOMATION_DENIED: 'automationDenied', // app: macOS refused Apple events to that terminal app (-1743)
  CANCELLED: 'cancelled',      // the user declined the Automation confirmation
  FAILED: 'failed',            // error: what went wrong (listing processes timed out, …)
});

const ACTION = Object.freeze({
  CLAUDE_VSCODE: 'claudeVscode', CODEX_VSCODE: 'codexVscode', COPILOT: 'copilot', TERMINAL: 'terminal',
  EXTERNAL_TERMINAL: 'externalTerminal', // this window only (never sent to another one)
  RESULT: 'result',                      // the owning window's reply to a request
});

// Tools with a name of their own in messages (ext.jump.tool.<id>)
const TOOL_KEYS = Object.freeze(['claudeVscode', 'claudeDesktop', 'codexVscode', 'codexDesktop', 'copilot']);

// A terminal device as ps prints it on macOS (ttys003; old BSD ptys ttyp0): the only tty that is passed to osascript
const TTY_RE = /^\/dev\/tty[a-z]{0,3}[0-9a-f]{1,5}$/;

// ---------------------------------------------------------------------------
// Process listing (only on click)
// ---------------------------------------------------------------------------

/** ps etime "[[dd-]hh:]mm:ss" → seconds; null when it does not look like that */
function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** ps tty ("ttys003", "pts/3", "??", "?") → device path, or null without a terminal */
function ttyPath(t) {
  const s = String(t || '');
  if (!s || /^\?+$/.test(s) || s === '-') return null;
  return s.startsWith('/dev/') ? s : '/dev/' + s;
}

/**
 * Output of `ps -A -o pid=,ppid=,etime=,tty=,args=` → processes. The command comes last, so spaces in it are kept.
 * @returns {Proc[]}
 */
function parsePs(text, now = Date.now()) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const secs = parseEtime(m[3]);
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), startMs: secs == null ? null : now - secs * 1000, tty: ttyPath(m[4]), cmd: (m[5] || '').trim() });
  }
  return out;
}

// One PowerShell call on Windows: pid, parent pid, start time (epoch ms) and command line of every process, as JSON
const CIM_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$ProgressPreference = "SilentlyContinue"',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Get-CimInstance Win32_Process | ForEach-Object {',
  '  [pscustomobject]@{',
  '    p = $_.ProcessId; pp = $_.ParentProcessId',
  '    t = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null })',
  '    c = $(if ($_.CommandLine) { $_.CommandLine } else { $_.Name })',
  '  }',
  '} | ConvertTo-Json -Compress',
].join('\n');

/** CIM date as written by ConvertTo-Json: epoch ms, "/Date(ms)/" (Windows PowerShell 5.1) or ISO (PowerShell 7) */
function cimDate(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v && typeof v === 'object') return cimDate(v.value != null ? v.value : v.DateTime);
  if (typeof v !== 'string' || !v) return null;
  const m = /\/Date\((-?\d+)/.exec(v);
  if (m) return Number(m[1]);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Output of the Get-CimInstance call → processes. Accepts the compact shape of CIM_SCRIPT ({ p, pp, t, c }) and plain
 * Win32_Process fields ({ ProcessId, ParentProcessId, CreationDate, CommandLine, Name }); one object or an array.
 * @returns {Proc[]}
 */
function parseCim(text) {
  let v;
  try { v = JSON.parse(String(text || '').replace(/^﻿/, '').trim() || '[]'); } catch { return []; }
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  const out = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const pid = Number(x.p != null ? x.p : x.ProcessId);
    const ppid = Number(x.pp != null ? x.pp : x.ParentProcessId);
    if (!Number.isInteger(pid) || pid < 0 || !Number.isInteger(ppid) || ppid < 0) continue;
    const cmd = x.c != null ? x.c : x.CommandLine != null ? x.CommandLine : x.Name;
    out.push({ pid, ppid, startMs: cimDate(x.t != null ? x.t : x.CreationDate), tty: null, cmd: typeof cmd === 'string' ? cmd : '' });
  }
  return out;
}

/** PowerShell -EncodedCommand: base64 of UTF-16LE (no quoting problems) */
function encodePs(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * A short error for a failed command: its program name, what happened and the start of its stderr. execFile's own message
 * repeats the whole command line (the base64 PowerShell script, every AppleScript line), which is no use in a message.
 */
function shortError(cmd, err, stderr) {
  const name = String(cmd || '').split(/[\\/]/).pop() || 'command';
  const code = err && err.code;
  let what;
  if (code === 'ENOENT') what = 'not found';
  else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') what = 'printed too much';
  else if (err && err.killed) what = 'timed out';
  else if (err && err.signal) what = `stopped (${err.signal})`;
  else if (Number.isInteger(code)) what = `exited with ${code}`;
  else what = `failed${code ? ` (${code})` : ''}`;
  const detail = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ').slice(0, 300);
  const out = new Error(`${name} ${what}${detail ? ': ' + detail : ''}`);
  if (err) { out.code = err.code; out.killed = err.killed; out.signal = err.signal; }
  return out;
}

/** execFile as a promise → stdout; okCodes: exit codes that still count as an answer (lsof exits 1 when nothing matched) */
function run(execFile, cmd, args, opts, okCodes = []) {
  return new Promise((resolve, reject) => {
    try {
      execFile(cmd, args, { maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8', ...opts }, (err, stdout, stderr) => {
        if (err && !(okCodes.includes(err.code) && !err.killed)) reject(shortError(cmd, err, stderr));
        else resolve(String(stdout || ''));
      });
    } catch (err) {
      reject(shortError(cmd, err, ''));
    }
  });
}

/**
 * Windows PowerShell by its full path (a bare name would also be looked up in the working directory first)
 * @param {Record<string, string|undefined>} [env]
 */
function powershellPath(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  return nodePath.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Every process with its parent, start time, terminal and command line: one call, with a timeout. -ww: full command lines
 * whatever the output width.
 * @param {{ platform?: string, execFile?: Function, timeoutMs?: number, now?: () => number, env?: Record<string, string|undefined>,
 *   exists?: (p: string) => boolean }} [o]
 * @returns {Promise<Proc[]>}
 */
function listProcesses(o = {}) {
  const platform = o.platform || process.platform;
  const execFile = o.execFile || nodeCp.execFile;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  if (platform === 'win32') {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(CIM_SCRIPT)];
    return run(execFile, powershellPath(o.env || process.env), args, { timeout: o.timeoutMs || WIN_TIMEOUT_MS }).then(parseCim);
  }
  const exists = o.exists || nodeFs.existsSync;
  const ps = platform === 'darwin' ? '/bin/ps' : ['/bin/ps', '/usr/bin/ps'].find((p) => exists(p)) || 'ps';
  return run(execFile, ps, ['-A', '-ww', '-o', 'pid=,ppid=,etime=,tty=,args='], { timeout: o.timeoutMs || PS_TIMEOUT_MS }).then((out) => parsePs(out, now()));
}

/** `lsof -F…` output → pid → the first name (n) line after it */
function parseLsofNames(text) {
  const out = new Map();
  let pid = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && Number.isInteger(pid) && !out.has(pid)) out.set(pid, line.slice(1));
  }
  return out;
}

const cleanPids = (pids) => [...new Set((pids || []).filter((p) => Number.isInteger(p) && p > 0))].slice(0, 200);

/**
 * Working directories of a few processes (the Codex candidates): macOS one lsof call, Linux /proc/<pid>/cwd.
 * Windows: null (a process's working directory cannot be read without native code; the folder check is skipped).
 * @param {number[]} pids
 * @param {{ platform?: string, execFile?: Function, readlink?: (p: string) => string, timeoutMs?: number }} [o]
 * @returns {Promise<Map<number, string>|null>}
 */
async function processCwds(pids, o = {}) {
  const platform = o.platform || process.platform;
  const list = cleanPids(pids);
  if (platform === 'win32') return null;
  if (!list.length) return new Map();
  if (platform === 'darwin') {
    // exit status 1 when some pid has gone: the rest is still printed
    const out = await run(o.execFile || nodeCp.execFile, '/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn', '-p', list.join(',')], { timeout: o.timeoutMs || PS_TIMEOUT_MS }, [1]);
    return parseLsofNames(out);
  }
  const readlink = o.readlink || nodeFs.readlinkSync;
  const map = new Map();
  for (const pid of list) {
    try { map.set(pid, String(readlink(`/proc/${pid}/cwd`))); } catch { /* gone, or not ours */ }
  }
  return map;
}

/**
 * Which of these processes hold a file open (Codex keeps a session's rollout file open while it runs): macOS one
 * `lsof -t` call, Linux /proc/<pid>/fd. Only which process holds it is looked at, never what is in it. Windows: null.
 * @param {string} file absolute path
 * @param {number[]} pids candidates
 * @param {{ platform?: string, execFile?: Function, readdir?: Function, readlink?: Function, timeoutMs?: number }} [o]
 * @returns {Promise<Set<number>|null>}
 */
async function fileHolders(file, pids, o = {}) {
  const platform = o.platform || process.platform;
  const list = cleanPids(pids);
  if (platform === 'win32' || typeof file !== 'string' || !nodePath.isAbsolute(file)) return null;
  if (!list.length) return new Set();
  if (platform === 'darwin') {
    const out = await run(o.execFile || nodeCp.execFile, '/usr/sbin/lsof', ['-t', '--', file], { timeout: o.timeoutMs || PS_TIMEOUT_MS }, [1]);
    const want = new Set(list);
    return new Set(out.split(/\s+/).map(Number).filter((p) => want.has(p)));
  }
  const readdir = o.readdir || nodeFs.readdirSync;
  const readlink = o.readlink || nodeFs.readlinkSync;
  const held = new Set();
  for (const pid of list.slice(0, 50)) {
    let fds;
    try { fds = readdir(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target;
      try { target = String(readlink(`/proc/${pid}/fd/${fd}`)); } catch { continue; }
      if (target === file) { held.add(pid); break; }
    }
  }
  return held;
}

// ---------------------------------------------------------------------------
// Process tree
// ---------------------------------------------------------------------------

function indexProcs(procs) {
  const m = new Map();
  for (const p of procs || []) if (p && Number.isInteger(p.pid)) m.set(p.pid, p);
  return m;
}

/**
 * pid, its parent, its grandparent … as far as the list goes. Empty when pid is not in the list (the process is gone).
 * Stops at pid 0, a cycle, MAX_DEPTH, or a "parent" that started after its child (Windows reuses the pid of a parent
 * that has exited; Unix re-parents orphans instead).
 * @param {number} pid
 * @param {Map<number, Proc>} byPid
 * @returns {number[]}
 */
function ancestry(pid, byPid, max = MAX_DEPTH) {
  const chain = [];
  const seen = new Set();
  let cur = pid;
  let child = null;
  while (Number.isInteger(cur) && cur > 0 && !seen.has(cur) && chain.length < max) {
    const p = byPid.get(cur);
    if (!p) break;
    if (child && Number.isFinite(child.startMs) && Number.isFinite(p.startMs) && p.startMs > child.startMs + START_SLACK_MS) break;
    seen.add(cur);
    chain.push(cur);
    child = p;
    cur = p.ppid;
  }
  return chain;
}

/**
 * Whether a pid taken from a registry (Claude's live registry) now belongs to a process that started
 * after the session registered it: the agent exited and the pid was given to another program.
 * @param {Proc|undefined} p
 * @param {number|null|undefined} startedMs when the registry says the agent started
 */
function reusedPid(p, startedMs) {
  return !!p && Number.isFinite(startedMs) && Number.isFinite(p.startMs) && p.startMs > startedMs + REUSE_SLACK_MS;
}

/** A window reference in a plan: its id and folders (null = this window) */
function windowRef(w) {
  return { id: w.id, folders: Array.isArray(w.folders) ? w.folders.filter((f) => typeof f === 'string' && f) : [] };
}

/**
 * The places an agent can run in: the extension hosts and integrated-terminal shells of this window and the other windows.
 * This window's come first, so it wins if a stale record of another window lists the same pid.
 * @param {{ hostPid?: number|null, terminals?: number[] }} local
 * @param {WindowInfo[]} windows other windows
 * @returns {Place[]} { pid, kind: 'host'|'terminal', window: null (this window) | { id, folders } }
 */
function placesOf(local, windows) {
  const out = [];
  const add = (w, info) => {
    if (Number.isInteger(info.hostPid) && info.hostPid > 0) out.push({ pid: info.hostPid, kind: 'host', window: w });
    for (const pid of info.terminals || []) if (Number.isInteger(pid) && pid > 0) out.push({ pid, kind: 'terminal', window: w });
  };
  add(null, local || {});
  for (const w of windows || []) if (w && typeof w.id === 'string' && w.id) add(windowRef(w), w);
  return out;
}

/**
 * The nearest ancestor (the process itself first) that is one of the places.
 * @param {number[]} chain from ancestry()
 * @param {Place[]} places
 * @param {'host'|'terminal'} [kind] only places of this kind
 * @returns {(Place & { depth: number })|null}
 */
function findOwner(chain, places, kind) {
  const byPid = new Map();
  for (const p of places || []) if ((!kind || p.kind === kind) && !byPid.has(p.pid)) byPid.set(p.pid, p);
  for (let i = 0; i < (chain || []).length; i++) {
    const hit = byPid.get(chain[i]);
    if (hit) return { ...hit, depth: i };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Finding the agent process of a CLI without a registry (Codex)
// ---------------------------------------------------------------------------

/** Command line → arguments; double quotes group (Windows command lines quote paths with spaces) */
function splitCommand(cmd) {
  const out = [];
  let cur = '';
  let quoted = false;
  let any = false;
  for (const ch of String(cmd || '')) {
    if (ch === '"') { quoted = !quoted; any = true; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (any) { out.push(cur); cur = ''; any = false; }
      continue;
    }
    cur += ch;
    any = true;
  }
  if (any) out.push(cur);
  return out;
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop().toLowerCase();
const RUNTIME_RE = /^(node|nodejs|bun|deno)(\.exe)?$/;

/** The program a command line runs: the executable, and for node / bun / deno the script it was given */
function programOf(cmd) {
  const args = splitCommand(cmd);
  const exe = args.length ? args[0] : '';
  const script = RUNTIME_RE.test(baseName(exe)) ? args.slice(1).find((a) => !a.startsWith('-')) || null : null;
  return { exe, script, args: args.slice(1) };
}

// A binary bundled with an editor extension (~/.vscode/extensions/…, ~/.cursor/extensions/…): an integration, not a terminal chat
const EXTENSION_DIR_RE = /[\\/]\.[\w.-]+[\\/]extensions[\\/]/i;

// CLI processes per tool: the executable (or the node script) name, or the npm package path; skip: arguments of
// integrations that run the same binary (the Codex VS Code extension runs `codex app-server`)
const AGENT_PROCESS = Object.freeze({
  codex: Object.freeze({
    name: /^codex(-[\w.-]+)?(\.(exe|cmd|js|mjs|cjs))?$/,
    pkg: /[\\/]@openai[\\/]codex[\\/]/i,
    skip: Object.freeze(['app-server', 'mcp-server']),
  }),
});

function runsTool(tool, prog) {
  const spec = AGENT_PROCESS[tool];
  const hit = (p) => !!p && (spec.name.test(baseName(p)) || spec.pkg.test(p));
  return hit(prog.exe) || hit(prog.script);
}

/** Whether a command line is that tool's CLI (in a terminal, not an editor integration) */
function isAgentProcess(tool, cmd) {
  const spec = AGENT_PROCESS[tool];
  if (!spec) return false;
  const prog = programOf(cmd);
  if (!runsTool(tool, prog)) return false;
  if (EXTENSION_DIR_RE.test(prog.exe) || (prog.script && EXTENSION_DIR_RE.test(prog.script))) return false;
  return !prog.args.some((a) => spec.skip.includes(a));
}

/** `codex app-server`: the process the Codex VS Code extension runs under its window's extension host */
function isCodexAppServer(cmd) {
  const prog = programOf(cmd);
  return runsTool('codex', prog) && prog.args.includes('app-server');
}

/**
 * The tool's CLI processes. A launcher and the process it starts (the npm wrapper and the native codex binary) count
 * once: only the outermost one is kept (both sit under the same terminal).
 */
function agentCandidates(procs, tool) {
  const list = (procs || []).filter((p) => p && isAgentProcess(tool, p.cmd));
  const ids = new Set(list.map((p) => p.pid));
  return list.filter((p) => !ids.has(p.ppid));
}

function normPath(p, platform) {
  let s = String(p || '');
  if (!s) return '';
  s = platform === 'win32' ? nodePath.win32.resolve(s) : nodePath.posix.resolve(s);
  s = s.replace(/[\\/]+$/, '') || s;
  return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s; // macOS volumes are case-insensitive by default
}

function realPath(p) {
  try { return nodeFs.realpathSync.native(p); } catch { return null; }
}

function samePath(a, b, platform) {
  const x = normPath(a, platform);
  if (!x) return false;
  if (x === normPath(b, platform)) return true;
  const r = realPath(b); // /tmp vs /private/tmp: the process reports the real path
  return !!r && x === normPath(r, platform);
}

/**
 * Picks the agent process of a session among the candidates:
 * - in the session's folder (skipped where working directories cannot be read, cwds null, or the session has no cwd);
 * - several can still match (two chats started in the same folder). Then the most recently started one wins, among
 *   those already running when the session last wrote (a process started later cannot have written it): the newest
 *   chat is the one most likely to be active. The count is returned, so callers can tell the choice was a guess.
 * @param {Proc[]} candidates from agentCandidates()
 * @param {{ cwd?: string|null, cwds?: Map<number, string>|null, updatedMs?: number|null, platform?: string }} o
 * @returns {{ pid: number, count: number }|null}
 */
function pickAgentProcess(candidates, o = {}) {
  let list = (candidates || []).slice();
  if (o.cwd && o.cwds) list = list.filter((p) => o.cwds.has(p.pid) && samePath(o.cwds.get(p.pid), o.cwd, o.platform || process.platform));
  if (!list.length) return null;
  const upd = Number(o.updatedMs);
  const before = Number.isFinite(upd) ? list.filter((p) => !Number.isFinite(p.startMs) || p.startMs <= upd + START_SLACK_MS) : [];
  const pool = (before.length ? before : list).sort((a, b) => (b.startMs || 0) - (a.startMs || 0) || b.pid - a.pid);
  return { pid: pool[0].pid, count: list.length };
}

// ---------------------------------------------------------------------------
// Terminal apps outside VS Code
// ---------------------------------------------------------------------------

// Terminal.app: the tab whose tty matches (checked against its scripting dictionary: tab.tty, window.selected tab, index)
const TERMINAL_APP_SCRIPT = [
  'on run argv',
  '  set targetTty to item 1 of argv',
  '  if application id "com.apple.Terminal" is not running then return "not-running"',
  '  tell application id "com.apple.Terminal"',
  '    repeat with w in windows',
  '      repeat with t in tabs of w',
  '        if tty of t is targetTty then',
  '          if miniaturized of w then set miniaturized of w to false',
  '          set selected tab of w to t',
  '          set index of w to 1',
  '          activate',
  '          return "ok"',
  '        end if',
  '      end repeat',
  '    end repeat',
  '  end tell',
  '  return "not-found"',
  'end run',
];

// iTerm2: the session whose tty matches (its documented dictionary: session.tty and select on window, tab, session)
const ITERM_SCRIPT = [
  'on run argv',
  '  set targetTty to item 1 of argv',
  '  if application id "com.googlecode.iterm2" is not running then return "not-running"',
  '  tell application id "com.googlecode.iterm2"',
  '    repeat with w in windows',
  '      repeat with t in tabs of w',
  '        repeat with s in sessions of t',
  '          if tty of s is targetTty then',
  '            tell w to select',
  '            tell t to select',
  '            tell s to select',
  '            activate',
  '            return "ok"',
  '          end if',
  '        end repeat',
  '      end repeat',
  '    end repeat',
  '  end tell',
  '  return "not-found"',
  'end run',
];

// Terminal apps, tested against the command line of each ancestor. script: AppleScript that selects the tab by tty (macOS);
// the others are not supported yet
const EXTERNAL_TERMINALS = Object.freeze([
  { id: 'iterm2', name: 'iTerm2', test: /iTerm2?\.app[\\/]|[\\/]iTermServer-/i, script: ITERM_SCRIPT },
  { id: 'terminalApp', name: 'Terminal', test: /[\\/]Terminal\.app[\\/]Contents[\\/]MacOS[\\/]Terminal\b/, script: TERMINAL_APP_SCRIPT },
  { id: 'warp', name: 'Warp', test: /[\\/]Warp\.app[\\/]|[\\/]warp-terminal\b/i, script: null },
  { id: 'ghostty', name: 'Ghostty', test: /[\\/]ghostty(\.app[\\/]|(\s|$))/i, script: null },
  { id: 'wezterm', name: 'WezTerm', test: /[\\/]wezterm(-gui)?(\.exe)?(\s|$)|WezTerm\.app[\\/]/i, script: null },
  { id: 'alacritty', name: 'Alacritty', test: /[\\/]alacritty(\.exe)?(\s|$)|Alacritty\.app[\\/]/i, script: null },
  { id: 'kitty', name: 'kitty', test: /[\\/]kitty(\s|$)|kitty\.app[\\/]/i, script: null },
  { id: 'windowsTerminal', name: 'Windows Terminal', test: /[\\/]WindowsTerminal\.exe\b/i, script: null },
  { id: 'gnomeTerminal', name: 'GNOME Terminal', test: /[\\/]gnome-terminal-server\b/, script: null },
  { id: 'konsole', name: 'Konsole', test: /[\\/]konsole(\s|$)/, script: null },
].map((t) => Object.freeze(t)));

// VS Code and its forks (a window Agent Monitor has no presence record for)
const EDITOR_RE = /Visual Studio Code|Code Helper|Code - Insiders|VSCodium|Cursor Helper|Cursor\.app|Windsurf|[\\/]code(-insiders|-oss)?(\.exe)?(\s|$)|[\\/]Code( - Insiders)?\.exe|\.vscode-server/i;

/**
 * A process under no known terminal / chat panel, from its ancestors (nearest first): started by a known window's
 * extension host (another tool or agent ran it) → background; Terminal.app / iTerm2 when AppleScript can be used (macOS,
 * not a remote window) → select its tab by tty (the last resolver); another terminal app → external (with its name); a
 * VS Code process → another window; otherwise → outside VS Code.
 * @param {boolean} scriptable AppleScript can be used here (canScript)
 */
function elsewhere(chain, byPid, places, scriptable) {
  if (findOwner(chain, places, 'host')) return fail(REASON.BACKGROUND);
  for (const pid of chain) {
    const cmd = (byPid.get(pid) || {}).cmd || '';
    const app = EXTERNAL_TERMINALS.find((t) => t.test.test(cmd));
    if (app) {
      const tty = chain.map((p) => (byPid.get(p) || {}).tty).find(Boolean);
      if (app.script && scriptable && TTY_RE.test(String(tty || ''))) {
        return { ok: true, window: null, action: { kind: ACTION.EXTERNAL_TERMINAL, app: app.id, tty } };
      }
      return fail(REASON.EXTERNAL, { app: app.name, terminal: app.id });
    }
    if (EDITOR_RE.test(cmd)) return fail(REASON.OTHER_WINDOW);
  }
  return fail(REASON.EXTERNAL);
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

function fail(reason, extra) {
  return { ok: false, reason, ...(extra || {}) };
}

const claudeEntrypoint = (s) => s.entrypoint || (s.entry === 'vscode' ? CLAUDE_VSCODE_ENTRY : null);

/** AppleScript can select a tab of a terminal app here: macOS, and not a remote window (it would run on the remote machine) */
const canScript = (env) => env.platform === 'darwin' && !env.remote;

/** Claude Code VS Code chat: its claude process is a child of the owning window's extension host */
async function resolveClaudeVscode(s, env) {
  if (!S.isUuid(s.id)) return fail(REASON.NOT_FOUND);
  const live = env.claudeLive(s.id);
  if (!live || !Number.isInteger(live.pid)) return fail(REASON.NOT_RUNNING);
  const procs = await env.processes();
  const byPid = indexProcs(procs);
  if (reusedPid(byPid.get(live.pid), live.startedAt)) return fail(REASON.NOT_RUNNING);
  const chain = ancestry(live.pid, byPid);
  if (!chain.length) return fail(REASON.NOT_RUNNING); // exited since the registry was read
  const places = placesOf(env.local, env.windows);
  const owner = findOwner(chain, places, 'host');
  if (owner) return { ok: true, window: owner.window, action: { kind: ACTION.CLAUDE_VSCODE, sessionId: s.id } };
  // a VS Code chat always runs in some window: one Agent Monitor cannot reach
  return fail(REASON.OTHER_WINDOW);
}

/**
 * Codex VS Code thread: the window whose `codex app-server` holds the thread's rollout file open (the thread is loaded
 * there; opening it elsewhere could conflict with that writer); an app-server under a window Agent Monitor cannot reach
 * holding it → otherWindow. When that cannot be told (Windows, lsof failed): the only window running Codex, else the one
 * whose folders contain the session's folder, else this one. A thread no app-server holds is opened here (the Codex
 * extension starts one).
 */
async function resolveCodexVscode(s, env) {
  if (!CODEX_ID_RE.test(String(s.id || ''))) return fail(REASON.NOT_FOUND);
  const plan = (w) => ({ ok: true, window: w, action: { kind: ACTION.CODEX_VSCODE, threadId: s.id } });
  const procs = await env.processes();
  const byPid = indexProcs(procs);
  const places = placesOf(env.local, env.windows);
  const servers = [];
  const strangers = []; // app-servers under no known window
  for (const p of procs) {
    if (!isCodexAppServer(p.cmd)) continue;
    const owner = findOwner(ancestry(p.pid, byPid), places, 'host');
    if (owner) servers.push({ pid: p.pid, window: owner.window });
    else strangers.push(p.pid);
  }
  if (!servers.length && !strangers.length) return plan(null);
  let held = null;
  if (s.transcript) {
    try { held = await env.fileHolders(s.transcript, [...servers.map((x) => x.pid), ...strangers]); } catch { held = null; }
  }
  if (held) {
    const hit = servers.find((x) => held.has(x.pid));
    if (hit) return plan(hit.window);
    return strangers.some((pid) => held.has(pid)) ? fail(REASON.OTHER_WINDOW) : plan(null);
  }
  if (!servers.length) return plan(null);
  if (servers.length === 1) return plan(servers[0].window);
  const infoOf = (w) => (w ? (env.windows.find((x) => x.id === w.id) || {}) : env.local || {});
  const byFolder = s.cwd && servers.find((x) => scopeLib.cwdInWorkspace(s.cwd, { paths: infoOf(x.window).folders || [] }));
  return plan((byFolder || servers.find((x) => !x.window) || servers[0]).window);
}

/** Copilot Chat: only the window whose workspace storage holds the chat can load it (an empty window for empty-window chats) */
async function resolveCopilot(s, env) {
  if (!COPILOT_ID_RE.test(String(s.id || ''))) return fail(REASON.NOT_FOUND);
  const wsOf = (w) => ({
    paths: Array.isArray(w.folders) ? w.folders : [], dirs: [],
    workspaceFile: w.workspaceFile || null, storageDir: w.storageDir || null, empty: w.empty === true,
  });
  const all = [{ window: null, info: env.local || {} }, ...(env.windows || []).map((w) => ({ window: windowRef(w), info: w }))];
  const hit = all.find((x) => scopeLib.copilotInWorkspace(s, wsOf(x.info)) === true);
  if (!hit) return fail(REASON.WINDOW_CLOSED);
  return { ok: true, window: hit.window, action: { kind: ACTION.COPILOT, sessionId: s.id } };
}

/** CLI session: the integrated terminal whose shell is an ancestor of the agent's process */
async function resolveTerminal(s, env, pidOf) {
  const found = await pidOf(s, env);
  if (!found || !Number.isInteger(found.pid)) return fail((found && found.reason) || REASON.NOT_FOUND);
  const procs = await env.processes();
  const byPid = indexProcs(procs);
  if (reusedPid(byPid.get(found.pid), found.startedMs)) return fail(REASON.NOT_RUNNING);
  const chain = ancestry(found.pid, byPid);
  if (!chain.length) return fail(REASON.NOT_RUNNING);
  const places = placesOf(env.local, env.windows);
  const owner = findOwner(chain, places, 'terminal');
  if (owner) {
    const plan = { ok: true, window: owner.window, action: { kind: ACTION.TERMINAL, pid: owner.pid } };
    if (found.count > 1) plan.candidates = found.count; // picked the newest of several (pickAgentProcess)
    return plan;
  }
  return elsewhere(chain, byPid, places, canScript(env));
}

// pid sources for resolveTerminal: { pid, startedMs? (from the registry, for reusedPid) } or { reason }
async function claudePid(s, env) {
  const live = S.isUuid(s.id) ? env.claudeLive(s.id) : null;
  return live && Number.isInteger(live.pid) ? { pid: live.pid, startedMs: live.startedAt } : { reason: REASON.NOT_RUNNING };
}

const searchPid = (tool) => async (s, env) => {
  const procs = await env.processes();
  const cands = agentCandidates(procs, tool);
  if (!cands.length) return { reason: REASON.NOT_FOUND };
  // Codex keeps the rollout file open while the session runs: the process holding the transcript is certainly it (the
  // native binary holds it, not its npm launcher, so every matching process is asked)
  if (tool === 'codex' && s.transcript) {
    let held = null;
    try { held = await env.fileHolders(s.transcript, procs.filter((p) => isAgentProcess(tool, p.cmd)).map((p) => p.pid)); } catch { held = null; }
    const pid = held && [...held][0];
    if (pid) return { pid };
  }
  let cwds = null;
  if (s.cwd) {
    try { cwds = await env.processCwds(cands.map((p) => p.pid)); } catch { cwds = null; } // unknown: newest candidate
  }
  return pickAgentProcess(cands, { cwd: s.cwd, cwds, updatedMs: s.updatedMs, platform: env.platform }) || { reason: REASON.NOT_FOUND };
};

/**
 * Per-target resolvers, first match wins. live: 'certain' (the provider knows whether a process runs: offer the jump only
 * for live sessions) or 'unknown' (no registry: offer it for recent sessions). unsupported: the tool id of a target that
 * has no resolver yet.
 */
const RESOLVERS = Object.freeze([
  { id: 'claudeVscode', test: (s) => s.provider === 'claude' && claudeEntrypoint(s) === CLAUDE_VSCODE_ENTRY, live: 'certain', resolve: resolveClaudeVscode },
  { id: 'claudeDesktop', test: (s) => s.provider === 'claude' && (s.entry === 'desktop' || claudeEntrypoint(s) === 'claude-desktop'), unsupported: 'claudeDesktop' },
  { id: 'claudeCli', test: (s) => s.provider === 'claude', live: 'certain', resolve: (s, env) => resolveTerminal(s, env, claudePid) },
  { id: 'codexVscode', test: (s) => s.provider === 'codex' && s.entry === 'vscode', live: 'unknown', resolve: resolveCodexVscode },
  { id: 'codexDesktop', test: (s) => s.provider === 'codex' && s.entry === 'desktop', unsupported: 'codexDesktop' },
  { id: 'codexCli', test: (s) => s.provider === 'codex', live: 'unknown', resolve: (s, env) => resolveTerminal(s, env, searchPid('codex')) },
  { id: 'copilot', test: (s) => s.provider === 'copilot', live: 'unknown', resolve: resolveCopilot },
].map((r) => Object.freeze(r)));

/** The resolver for a session; an unknown provider gets an "unsupported" one */
function resolverFor(s) {
  const r = s && typeof s === 'object' ? RESOLVERS.find((x) => x.test(s)) : null;
  return r || { id: 'unknown', unsupported: String((s && s.provider) || 'unknown') };
}

/**
 * Whether to offer the jump (the panel's Go to button, the tree's inline action); the context menu always has it. Not for
 * Claude Agent SDK sessions (entry sdk): other tools and agents start those in the background, with nothing to go to.
 */
function worthTrying(s, now = Date.now()) {
  const r = resolverFor(s);
  if (r.unsupported) return false;
  if (r.id === 'claudeCli' && s.entry === 'sdk') return false;
  if (r.live === 'certain') return !!s.live;
  const last = Math.max(Number(s.updatedMs) || 0, Number(s.lastActivityMs) || 0);
  return !!s.live || now - last <= RECENT_MS;
}

/**
 * Where a session runs, as a Plan: { ok: true, window: null (this window) | { id, folders }, action, candidates? } or
 * { ok: false, reason, … }; target: the resolver id.
 * @param {any} s Session
 * @param {JumpEnv} env
 */
async function planJump(s, env) {
  const r = resolverFor(s);
  if (r.unsupported) return { ...fail(REASON.UNSUPPORTED, { tool: r.unsupported }), target: r.id };
  return { ...(await r.resolve(s, env)), target: r.id };
}

// ---------------------------------------------------------------------------
// Bringing the owning window to the front (run by that window itself)
// ---------------------------------------------------------------------------

async function hasCommand(vscode, id) {
  const c = vscode && vscode.commands;
  if (!c || typeof c.getCommands !== 'function') return false;
  try { return (await c.getCommands(true)).includes(id); } catch { return false; }
}

/**
 * What the code CLI must be given to find this window: its .code-workspace file, or its only folder (exact match only);
 * an absolute local path, so the CLI can never take it for an option
 */
function ownWorkspaceTarget(vscode, platform = process.platform) {
  const ws = (vscode && vscode.workspace) || {};
  const wf = ws.workspaceFile;
  const folders = ws.workspaceFolders || [];
  const p = wf ? (wf.scheme === 'file' ? wf.fsPath : null)
    : folders.length === 1 && folders[0].uri && folders[0].uri.scheme === 'file' ? folders[0].uri.fsPath : null;
  const P = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  return typeof p === 'string' && p && P.isAbsolute(p) && !/[\0\r\n]/.test(p) ? p : null;
}

/**
 * How to run the code CLI of the running VS Code, as an execFile program + leading arguments (never through a shell),
 * from vscode.env.appRoot (process.execPath is a helper binary in the extension host on macOS):
 * - macOS: <appRoot>/bin/code; Linux: <appRoot>/../../bin/<applicationName> (shell scripts run by their #! line);
 * - Windows: bin\<applicationName>.cmd is a batch file, which only cmd.exe can run (and cmd.exe would reparse the folder
 *   path), so what it does is done directly: the editor's executable (process.execPath of the extension host) with
 *   ELECTRON_RUN_AS_NODE=1 runs <appRoot>\out\cli.js.
 * null when not found.
 * @returns {{ file: string, args: string[], env?: Record<string, string> }|null}
 */
function codeCli(o) {
  const appRoot = o.appRoot;
  if (!appRoot) return null;
  const exists = o.exists || nodeFs.existsSync;
  if (o.platform === 'win32') {
    const P = nodePath.win32;
    const exe = o.execPath;
    const cli = P.join(appRoot, 'out', 'cli.js');
    if (!exe || !/\.exe$/i.test(exe) || !exists(exe) || !exists(cli)) return null;
    return { file: exe, args: [cli], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  let name = 'code';
  try {
    const product = JSON.parse((o.readFile || nodeFs.readFileSync)(nodePath.join(appRoot, 'product.json'), 'utf8'));
    if (product && /^[\w.-]+$/.test(String(product.applicationName || ''))) name = product.applicationName;
  } catch { /* default name */ }
  const P = nodePath.posix;
  const file = o.platform === 'darwin' ? P.join(appRoot, 'bin', 'code') : P.resolve(appRoot, '..', '..', 'bin', name);
  return exists(file) ? { file, args: [] } : null;
}

/**
 * Bring this window to the front. Called by the window that owns a session after it brought the chat / terminal up for a
 * request from another window. workbench.action.focusWindow force-focuses the calling window (checked in VS Code 1.138:
 * hostService.focus(window, { mode: 2 }), which on macOS also does app.focus({ steal: true })). Fallback where that
 * command is missing (older VS Code): the code CLI (codeCli, execFile with an argument array) with this window's own
 * .code-workspace file or folder, which focuses the window that has exactly that open. VSCODE_IPC_HOOK_CLI is removed from
 * its environment (otherwise bin/code talks to a remote CLI server). The vscode:// windowId route is not used: VS Code asks
 * the user to allow it first.
 * @param {{ vscode: any, platform?: string, execFile?: Function, env?: Record<string, string|undefined>, execPath?: string,
 *   exists?: (p: string) => boolean, readFile?: Function }} o
 * @returns {Promise<boolean>} true when the window was raised (or the CLI was run)
 */
async function raiseWindow(o) {
  const vscode = o.vscode;
  if (await hasCommand(vscode, FOCUS_WINDOW_CMD)) {
    await vscode.commands.executeCommand(FOCUS_WINDOW_CMD);
    return true;
  }
  const platform = o.platform || process.platform;
  const target = ownWorkspaceTarget(vscode, platform);
  const cli = codeCli({ appRoot: vscode && vscode.env && vscode.env.appRoot, platform, execPath: o.execPath || process.execPath, exists: o.exists, readFile: o.readFile });
  if (!target || !cli) return false;
  const env = { ...(o.env || process.env) };
  delete env.VSCODE_IPC_HOOK_CLI;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_DEV;
  Object.assign(env, cli.env || {});
  await run(o.execFile || nodeCp.execFile, cli.file, [...cli.args, target], { timeout: CLI_TIMEOUT_MS, env });
  return true;
}

// ---------------------------------------------------------------------------
// VS Code side
// ---------------------------------------------------------------------------

function withTimeout(thenable, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    if (t && typeof t.unref === 'function') t.unref();
    Promise.resolve(thenable).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(undefined); });
  });
}

/**
 * This window's integrated terminals by shell pid (a terminal whose process has not started within waitMs is left out).
 * @returns {Promise<Map<number, any>>}
 */
async function terminalsByPid(vscode, waitMs = PID_WAIT_MS) {
  const list = (vscode && vscode.window && Array.isArray(vscode.window.terminals)) ? vscode.window.terminals : [];
  const pairs = await Promise.all(list.map(async (t) => [await withTimeout(t && t.processId, waitMs), t]));
  const map = new Map();
  for (const [pid, t] of pairs) if (Number.isInteger(pid) && pid > 0 && !map.has(pid)) map.set(pid, t);
  return map;
}

const REASONS = new Set(Object.values(REASON));

/** A jump action (from another window, or anyone who can write the shared dir): only these shapes are performed */
function cleanAction(a) {
  if (!a || typeof a !== 'object') return null;
  switch (a.kind) {
    case ACTION.CLAUDE_VSCODE: return S.isUuid(a.sessionId) ? { kind: a.kind, sessionId: a.sessionId } : null;
    case ACTION.CODEX_VSCODE: return CODEX_ID_RE.test(String(a.threadId || '')) ? { kind: a.kind, threadId: a.threadId } : null;
    case ACTION.COPILOT: return COPILOT_ID_RE.test(String(a.sessionId || '')) ? { kind: a.kind, sessionId: a.sessionId } : null;
    case ACTION.TERMINAL: return Number.isInteger(a.pid) && a.pid > 0 ? { kind: a.kind, pid: a.pid } : null;
    case ACTION.EXTERNAL_TERMINAL: {
      const app = EXTERNAL_TERMINALS.find((t) => t.id === a.app && t.script);
      return app && TTY_RE.test(String(a.tty || '')) ? { kind: a.kind, app: app.id, tty: a.tty } : null;
    }
    case ACTION.RESULT:
      if (!/^[a-z0-9]{1,40}$/.test(String(a.reqId || ''))) return null;
      return {
        kind: a.kind, reqId: a.reqId, ok: a.ok === true, raised: a.raised === true,
        reason: REASONS.has(a.reason) ? a.reason : undefined, tool: TOOL_KEYS.includes(a.tool) ? a.tool : undefined,
      };
    default: return null;
  }
}

function errText(err) {
  return String((err && err.message) || err || 'error');
}

/**
 * The last part of a window's folder for messages. It comes from that window's presence file, so control characters are
 * dropped and "](" is broken up (a notification would make [text](command:…) a link).
 */
function folderLabel(folder) {
  if (typeof folder !== 'string' || !folder) return '';
  const base = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;
  return base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\]\(/g, '] (').slice(0, 120);
}

/**
 * @param {{
 *   vscode: any, platform?: string,
 *   claudeHome?: () => string,                      // parent of the live registry sessions/
 *   claudeLive?: (sessionId: string) => any,        // replaces the registry read (tests)
 *   localInfo?: () => { folders?: string[], storageDir?: string|null, workspaceFile?: string|null, empty?: boolean },
 *   windows?: () => WindowInfo[],                   // other windows' presence records (shared-scan windows(), self is skipped)
 *   requestJump?: (windowId: string, action: any) => string|null, // the request id when it was written
 *   cancelJump?: (windowId: string, reqId: string) => boolean, // withdraw a request that got no reply in time
 *   raiseWindow?: () => Promise<boolean>,           // replaces raiseWindow({ vscode, … }) (tests)
 *   confirmAutomation?: (app: { id: string, name: string }) => Promise<boolean>, // one-time confirmation before AppleScript
 *   listProcesses?: Function, processCwds?: Function, fileHolders?: Function, execFile?: Function,
 *   hostPid?: number, replyWaitMs?: number, log?: (line: string) => void,
 * }} deps
 */
function createJumper(deps = {}) {
  const vscode = deps.vscode;
  const platform = deps.platform || process.platform;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const lister = deps.listProcesses || listProcesses;
  const cwdsOf = deps.processCwds || processCwds;
  const holdersOf = deps.fileHolders || fileHolders;
  const execFile = deps.execFile || nodeCp.execFile;
  const hostPid = Number.isInteger(deps.hostPid) ? deps.hostPid : process.pid;
  const replyWaitMs = Number.isFinite(deps.replyWaitMs) ? deps.replyWaitMs : REPLY_WAIT_MS;
  const waiters = new Map(); // request id → { from: the window asked, done: resolve(reply) }

  const claudeLive = deps.claudeLive || ((id) => {
    const home = typeof deps.claudeHome === 'function' ? deps.claudeHome() : deps.claudeHome;
    if (!home) return null;
    try { return claudeLiveLib.readRegistry(home).live.get(id) || null; } catch { return null; }
  });

  /** Everything a resolver needs; processes are listed at most once per jump, and only if a resolver asks */
  async function makeEnv() {
    const terms = await terminalsByPid(vscode);
    let procs = null;
    let windows = [];
    try { windows = (typeof deps.windows === 'function' ? deps.windows() : []) || []; } catch { windows = []; }
    let info = {};
    try { info = (typeof deps.localInfo === 'function' ? deps.localInfo() : {}) || {}; } catch { info = {}; }
    return {
      platform,
      remote: !!(vscode && vscode.env && vscode.env.remoteName),
      now: Date.now(),
      processes: () => procs || (procs = Promise.resolve(lister({ platform }))),
      processCwds: (pids) => Promise.resolve(cwdsOf(pids, { platform })),
      fileHolders: (file, pids) => Promise.resolve(holdersOf(file, pids, { platform })),
      claudeLive,
      local: { ...info, hostPid, terminals: [...terms.keys()] },
      windows: windows.filter((w) => w && !w.self),
    };
  }

  /** AppleScript that selects the tab of a terminal app by tty, after the one-time confirmation */
  async function selectExternalTab(a) {
    const app = EXTERNAL_TERMINALS.find((t) => t.id === a.app);
    const confirm = typeof deps.confirmAutomation === 'function' ? deps.confirmAutomation : async () => false;
    if (!(await confirm({ id: app.id, name: app.name }))) return fail(REASON.CANCELLED);
    const args = [];
    for (const line of app.script) args.push('-e', line);
    args.push(a.tty);
    let out;
    try {
      out = (await run(execFile, '/usr/bin/osascript', args, { timeout: OSA_TIMEOUT_MS })).trim();
    } catch (err) {
      if (/-1743\b/.test(errText(err))) return fail(REASON.AUTOMATION_DENIED, { app: app.name });
      throw err;
    }
    if (out === 'ok') return { ok: true };
    return fail(REASON.NOT_FOUND, { app: app.name });
  }

  /** Perform an action in this window */
  async function perform(action) {
    const a = cleanAction(action);
    if (!a || a.kind === ACTION.RESULT) return fail(REASON.FAILED, { error: 'invalid action' });
    switch (a.kind) {
      case ACTION.CLAUDE_VSCODE:
        if (!(await hasCommand(vscode, CLAUDE_OPEN_CMD))) return fail(REASON.NO_COMMAND, { tool: 'claudeVscode' });
        await vscode.commands.executeCommand(CLAUDE_OPEN_CMD, a.sessionId, undefined, undefined, undefined, undefined, { ...CLAUDE_OPEN_OPTS });
        return { ok: true };
      case ACTION.CODEX_VSCODE: {
        const ext = vscode.extensions && typeof vscode.extensions.getExtension === 'function' ? vscode.extensions.getExtension(CODEX_EXT_ID) : null;
        if (!ext) return fail(REASON.NO_COMMAND, { tool: 'codexVscode' });
        const uri = vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: `/local/${a.threadId}` });
        await vscode.commands.executeCommand('vscode.openWith', uri, CODEX_EDITOR);
        return { ok: true };
      }
      case ACTION.COPILOT: {
        if (!(await hasCommand(vscode, COPILOT_OPEN_CMD))) return fail(REASON.NO_COMMAND, { tool: 'copilot' });
        const id = Buffer.from(a.sessionId, 'utf8').toString('base64url'); // URL-safe, no padding (LocalChatSessionUri)
        const resource = vscode.Uri.from({ scheme: 'vscode-chat-session', authority: 'local', path: '/' + id });
        await vscode.commands.executeCommand(COPILOT_OPEN_CMD, { resource });
        return { ok: true };
      }
      case ACTION.TERMINAL: {
        const t = (await terminalsByPid(vscode)).get(a.pid);
        if (!t) return fail(REASON.NOT_FOUND);
        t.show(false);
        return { ok: true };
      }
      case ACTION.EXTERNAL_TERMINAL:
        return canScript({ platform, remote: !!(vscode && vscode.env && vscode.env.remoteName) }) ? selectExternalTab(a) : fail(REASON.EXTERNAL);
      default:
        return fail(REASON.FAILED, { error: 'invalid action' });
    }
  }

  async function plan(session) {
    return planJump(session, await makeEnv());
  }

  function waitReply(reqId, from) {
    return new Promise((resolve) => {
      // not unref'd: the user is waiting for this answer
      const t = setTimeout(() => { waiters.delete(reqId); resolve(null); }, replyWaitMs);
      waiters.set(reqId, { from, done: (r) => { clearTimeout(t); resolve(r); } });
    });
  }

  /**
   * Go to where a session runs. Outcome: { ok: true, remote: false } (done here); { ok: true, remote: true, folder, raised,
   * replied } (another window was asked; replied false when it did not answer in time, and the request is withdrawn);
   * or { ok: false, reason, …, remote? (true: the other window's answer), folder? }.
   */
  async function goTo(session) {
    try {
      const p = await plan(session);
      if (!p.ok) return p;
      if (p.candidates) log(`goToChat: ${p.candidates} matching ${session.provider} processes; picked the newest`);
      if (!p.window || p.action.kind === ACTION.EXTERNAL_TERMINAL) return { ...(await perform(p.action)), remote: false, target: p.target };
      const reqId = typeof deps.requestJump === 'function' ? deps.requestJump(p.window.id, p.action) : null;
      if (!reqId) return { ...fail(REASON.OTHER_WINDOW), target: p.target };
      const folder = p.window.folders[0] || null;
      const reply = await waitReply(reqId, p.window.id);
      if (!reply) {
        let withdrawn = false;
        try { withdrawn = typeof deps.cancelJump === 'function' && deps.cancelJump(p.window.id, reqId) === true; } catch { /* taken already */ }
        log(`goToChat: no reply from window ${p.window.id}${withdrawn ? ' (it never took the request; withdrawn)' : ''}`);
        return { ok: true, remote: true, folder, raised: false, replied: false, target: p.target };
      }
      if (!reply.ok) return { ...fail(reply.reason || REASON.FAILED, reply.tool ? { tool: reply.tool } : null), remote: true, folder, target: p.target };
      return { ok: true, remote: true, folder, raised: reply.raised, replied: true, target: p.target };
    } catch (err) {
      return fail(REASON.FAILED, { error: errText(err) });
    }
  }

  /**
   * A request from another window (shared-scan onJump): a reply to one of mine, or an action to perform here; after
   * performing it this window raises itself and replies (ok, raised, reason).
   */
  async function handleRequest(req) {
    const a = cleanAction(req && req.action);
    if (!a || a.kind === ACTION.EXTERNAL_TERMINAL) return fail(REASON.FAILED, { error: 'invalid request' });
    if (a.kind === ACTION.RESULT) {
      // only from the window that was asked
      const w = waiters.get(a.reqId);
      if (w && req.from === w.from) { waiters.delete(a.reqId); w.done(a); }
      return { ok: true };
    }
    let out;
    try {
      out = await perform(a);
    } catch (err) {
      out = fail(REASON.FAILED, { error: errText(err) });
    }
    let raised = false;
    if (out.ok) {
      try {
        raised = !!(await (typeof deps.raiseWindow === 'function' ? deps.raiseWindow() : raiseWindow({ vscode, platform, execFile })));
      } catch (err) {
        log(`goToChat: raising this window failed: ${errText(err)}`);
      }
    } else {
      log(`goToChat request from another window: ${out.reason}${out.error ? ' ' + out.error : ''}`);
    }
    const reqId = req && typeof req.id === 'string' ? req.id : '';
    if (reqId && req.from && typeof deps.requestJump === 'function') {
      try {
        deps.requestJump(req.from, { kind: ACTION.RESULT, reqId, ok: !!out.ok, raised, reason: out.reason, tool: out.tool });
      } catch (err) {
        log(`goToChat: reply failed: ${errText(err)}`);
      }
    }
    return { ...out, raised };
  }

  return { goTo, plan, perform, handleRequest };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * The short message for an outcome (null: nothing to say, e.g. the chat was brought up here or its window was raised).
 * @param {any} o outcome of goTo()
 * @param {any} i18n
 * @param {any} [session] for the tool name in "not found"
 * @param {{ appName?: string }} [opts] the editor's name (vscode.env.appName) for the Automation messages
 * @returns {{ level: 'info'|'warn', text: string, button?: { label: string, url: string } }|null}
 */
function messageOf(o, i18n, session, opts = {}) {
  if (!o) return null;
  const info = (key, vars) => ({ level: 'info', text: i18n.t(key, vars) });
  const toolName = (id) => (TOOL_KEYS.includes(id) ? i18n.t('ext.jump.tool.' + id) : require('./format').providerLabel(String(id || ''), i18n));
  const folderName = folderLabel(o.folder);
  // with or without the folder of the window that was asked
  const there = (key, vars) => (folderName ? info(key, { ...vars, folder: folderName }) : info(key + 'NoFolder', vars));
  if (o.ok) {
    if (!o.remote || o.raised) return null;
    if (o.replied === false) return there('ext.jump.noReply');
    return there('ext.jump.sentToWindow');
  }
  // The other window's answer: say that it happened there. Its error text is never shown (it comes from a file any local
  // process can write, and notifications turn [text](link) into links); its Agent Monitor output has the details.
  if (o.remote && o.reason === REASON.NO_COMMAND) return there('ext.jump.noCommandThere', { tool: toolName(o.tool) });
  if (o.remote && (o.reason === REASON.FAILED || !REASONS.has(o.reason))) return { ...there('ext.jump.failedThere'), level: 'warn' };
  switch (o.reason) {
    case REASON.CANCELLED: return null;
    case REASON.NOT_RUNNING: return info('ext.jump.notRunning');
    case REASON.NOT_FOUND:
      if (o.app) return info('ext.jump.tabNotFound', { app: o.app });
      return info('ext.jump.notFound', { tool: require('./format').providerLabel((session && session.provider) || '', i18n) });
    case REASON.EXTERNAL: return o.app ? info('ext.jump.externalApp', { app: o.app }) : info('ext.jump.external');
    case REASON.BACKGROUND: return info('ext.jump.background');
    case REASON.OTHER_WINDOW: return info('ext.jump.otherWindow');
    case REASON.WINDOW_CLOSED: return info('ext.jump.windowClosed');
    case REASON.NO_COMMAND: return info('ext.jump.noCommand', { tool: toolName(o.tool) });
    case REASON.UNSUPPORTED: return info('ext.jump.unsupported', { tool: toolName(o.tool) });
    case REASON.AUTOMATION_DENIED:
      return {
        level: 'warn',
        text: i18n.t('ext.jump.automationDenied', { app: o.app || '', editor: opts.appName || 'VS Code' }),
        button: { label: i18n.t('ext.jump.openAutomationSettings'), url: AUTOMATION_SETTINGS_URL },
      };
    default: return { level: 'warn', text: i18n.t('ext.jump.failed', { error: String(o.error || '') }) };
  }
}

/**
 * @typedef {{ pid: number, ppid: number, startMs: number|null, tty: string|null, cmd: string }} Proc
 * @typedef {{ id: string, self?: boolean, hostPid: number|null, terminals: number[], folders: string[],
 *   storageDir?: string|null, workspaceFile?: string|null, empty?: boolean }} WindowInfo
 * @typedef {{ pid: number, kind: 'host'|'terminal', window: null|{ id: string, folders: string[] } }} Place
 * @typedef {{
 *   platform: string, now: number,
 *   processes: () => Promise<Proc[]>, processCwds: (pids: number[]) => Promise<Map<number, string>|null>,
 *   fileHolders: (file: string, pids: number[]) => Promise<Set<number>|null>,
 *   claudeLive: (sessionId: string) => any,
 *   local: { hostPid: number|null, terminals: number[], folders?: string[], storageDir?: string|null,
 *     workspaceFile?: string|null, empty?: boolean },
 *   windows: WindowInfo[],
 * }} JumpEnv
 */

module.exports = {
  CLAUDE_OPEN_CMD, CLAUDE_OPEN_OPTS, CODEX_EXT_ID, CODEX_EDITOR, COPILOT_OPEN_CMD, FOCUS_WINDOW_CMD, AUTOMATION_SETTINGS_URL,
  REASON, ACTION, RESOLVERS, EXTERNAL_TERMINALS, REQUEST_TTL_MS, TOOL_KEYS,
  createJumper, messageOf, worthTrying, resolverFor, planJump, raiseWindow, terminalsByPid,
  listProcesses, processCwds, fileHolders,
  _internal: {
    parseEtime, ttyPath, parsePs, parseCim, cimDate, parseLsofNames, encodePs, CIM_SCRIPT, TERMINAL_APP_SCRIPT, ITERM_SCRIPT,
    indexProcs, ancestry, placesOf, findOwner, splitCommand, programOf, isAgentProcess, isCodexAppServer, agentCandidates,
    pickAgentProcess, samePath, cleanAction, elsewhere, codeCli, ownWorkspaceTarget, shortError, powershellPath, reusedPid,
    folderLabel, TTY_RE,
  },
};
