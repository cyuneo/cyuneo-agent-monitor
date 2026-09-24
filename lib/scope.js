'use strict';
// Viewing scope, its settings migration, and following the "current conversation".
// - Only two scopes: all (default) / workspace, applied only to the left-hand session list; the old conversation / pinned values are migrated away.
// - Following: computed only on tab-switch events (a data refresh never moves the selection); Claude tabs are matched by title,
//   Codex tabs by the id in the URI.
// Everything that depends on vscode (workspace folders, Tab, the TabInputWebview / TabInputCustom classes) is passed in by the
// caller; node tests use stubs.

const SCOPE = Object.freeze({ ALL: 'all', WORKSPACE: 'workspace' });
const SCOPES = Object.freeze([SCOPE.ALL, SCOPE.WORKSPACE]);

// Tab recognition
const CLAUDE_PANEL_SUFFIX = 'claudeVSCodePanel';        // the actual viewType is mainThreadWebview-claudeVSCodePanel
const CLAUDE_DEFAULT_TITLE = 'Claude Code';             // a new Claude tab that has no title yet
const CODEX_EDITOR_VIEWTYPE = 'chatgpt.conversationEditor';
const TITLE_MAX = 200;                                  // the Claude extension truncates tab titles to 200 code points
const PROJECT_DIR_MAX = 200;                            // Claude truncates project dir names over 200 chars and appends a hash

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Setting value -> one of the two scopes. Legacy values: conversation -> workspace (closest to "only here"), pinned and anything else -> all.
 * @param {any} v
 * @returns {'all'|'workspace'}
 */
function normalizeScope(v) {
  if (v === SCOPE.WORKSPACE || v === 'conversation') return SCOPE.WORKSPACE;
  return SCOPE.ALL;
}

const LAYERS = [
  ['workspaceFolderValue', 'workspaceFolder'],
  ['workspaceValue', 'workspace'],
  ['globalValue', 'global'],
];

/**
 * Settings migrations to write on activation (pure; the caller maps target to a ConfigurationTarget and calls update):
 * 1. scope set at some level to a removed value (conversation / pinned / garbage) -> rewrite it at that level to normalizeScope's result;
 * 2. the legacy onlyWorkspace setting is effectively true and scope is not set at any level -> write 'workspace' at the level where onlyWorkspace takes effect.
 * @param {{ globalValue?: any, workspaceValue?: any, workspaceFolderValue?: any }|undefined} scopeInspect config.inspect('scope')
 * @param {{ globalValue?: any, workspaceValue?: any, workspaceFolderValue?: any }|undefined} onlyWsInspect config.inspect('onlyWorkspace')
 * @returns {{ key: 'scope', value: 'all'|'workspace', target: 'global'|'workspace'|'workspaceFolder' }[]}
 */
function planScopeMigration(scopeInspect, onlyWsInspect) {
  const out = [];
  const si = scopeInspect || {};
  let scopeSet = false;
  for (const [field, target] of LAYERS) {
    const v = si[field];
    if (v === undefined) continue;
    scopeSet = true;
    if (!SCOPES.includes(v)) out.push({ key: 'scope', value: normalizeScope(v), target });
  }
  if (!scopeSet && onlyWsInspect) {
    for (const [field, target] of LAYERS) {
      const v = onlyWsInspect[field];
      if (v === undefined) continue;
      if (v === true) out.push({ key: 'scope', value: SCOPE.WORKSPACE, target });
      break; // only the effective level matters
    }
  }
  return out;
}

/** Claude's project dir naming: every non-alphanumeric char becomes '-' (same as projectDirName in monitor.js) */
function projectDirName(p) {
  return String(p || '').replace(/[^a-zA-Z0-9]/g, '-');
}

// Windows drive-letter paths are case-insensitive
const isWinPath = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
function normPath(p) {
  let s = String(p || '');
  if (!s) return '';
  if (s.length > 1) s = s.replace(/[\\/]+$/, '');
  return isWinPath(s) ? s.replace(/\//g, '\\').toLowerCase() : s;
}

// A path from a string or a vscode.Uri-like object (file URIs only)
function fsPathOf(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && (v.scheme == null || v.scheme === 'file') && typeof v.fsPath === 'string' && v.fsPath) return v.fsPath;
  return null;
}

/**
 * Workspace info.
 * @param {Array<string|{ uri: { fsPath: string } }>|undefined|null} folders vscode.workspace.workspaceFolders or an array of paths
 * @param {{ workspaceFile?: any, storageDir?: string|null }} [o] for Copilot chats (optional):
 *   workspaceFile: vscode.workspace.workspaceFile (a multi-root workspace's .code-workspace file; untitled ones are ignored);
 *   storageDir: this window's workspace storage dir <User>/workspaceStorage/<hash> (the parent of context.storageUri)
 * @returns {{ paths: string[], dirs: string[], workspaceFile: string|null, storageDir: string|null, empty: boolean }}
 *   empty: no folder and no workspace file (an empty window)
 */
function workspaceInfo(folders, o = {}) {
  const paths = [];
  for (const f of folders || []) {
    const p = typeof f === 'string' ? f : f && f.uri && f.uri.fsPath;
    if (p) paths.push(p);
  }
  const workspaceFile = fsPathOf(o && o.workspaceFile);
  const storageDir = fsPathOf(o && o.storageDir);
  return { paths, dirs: paths.map(projectDirName), workspaceFile, storageDir, empty: !paths.length && !workspaceFile };
}

/** cwd equals or is inside one of the workspace folders */
function cwdInWorkspace(cwd, ws) {
  if (!cwd || !ws || !ws.paths) return false;
  const c = normPath(cwd);
  for (const p of ws.paths) {
    const w = normPath(p);
    if (!w) continue;
    if (c === w) return true;
    const sep = isWinPath(w) ? '\\' : '/';
    if (c.startsWith(w.endsWith(sep) ? w : w + sep)) return true;
  }
  return false;
}

/**
 * Copilot chat → this window: its file lies in this window's workspace storage dir, or its workspace's .code-workspace file
 * is this window's; a chat of the empty window belongs to an empty window. null = undecided (fall back to cwd).
 * @param {{ transcript?: string|null, copilot?: { storage?: string, workspaceFile?: string|null }|null }} s
 * @param {{ paths: string[], workspaceFile?: string|null, storageDir?: string|null, empty?: boolean }} ws
 * @returns {boolean|null}
 */
function copilotInWorkspace(s, ws) {
  const c = s.copilot && typeof s.copilot === 'object' ? s.copilot : {};
  if (c.storage === 'emptyWindow') return ws.empty === true;
  // <User>/workspaceStorage/<hash>/chatSessions/<id>.jsonl → <User>/workspaceStorage/<hash>
  if (ws.storageDir && typeof s.transcript === 'string' && s.transcript) {
    const own = normPath(s.transcript).replace(/[\\/][^\\/]+[\\/][^\\/]+$/, '');
    if (own && own === normPath(ws.storageDir)) return true;
  }
  if (c.workspaceFile && ws.workspaceFile && normPath(c.workspaceFile) === normPath(ws.workspaceFile)) return true;
  return null;
}

/**
 * Whether a session belongs to the current workspace (the workspace scope):
 * Claude: the transcript dir name matches (for names over 200 chars, compare the first 200), or cwd equals / is inside a
 * workspace folder; Copilot: the chat file is in this window's workspace storage, or the chat's .code-workspace file is this
 * window's, or a chat of the empty window in an empty window, else cwd; Codex, Gemini, Qwen: cwd only.
 * @param {{ provider: string, projectDir?: string|null, cwd?: string|null, transcript?: string|null, copilot?: any }} s
 * @param {{ paths: string[], dirs: string[], workspaceFile?: string|null, storageDir?: string|null, empty?: boolean }} ws
 */
function inWorkspace(s, ws) {
  if (!s || !ws) return false;
  if (s.provider === 'claude' && s.projectDir) {
    for (const d of ws.dirs || []) {
      if (!d) continue;
      if (s.projectDir === d) return true;
      if (d.length > PROJECT_DIR_MAX && s.projectDir.length > PROJECT_DIR_MAX
        && s.projectDir.startsWith(d.slice(0, PROJECT_DIR_MAX))) return true;
    }
  }
  if (s.provider === 'copilot') {
    const r = copilotInWorkspace(s, ws);
    if (r != null) return r;
  }
  return cwdInWorkspace(s.cwd, ws);
}

/**
 * Filter sessions by scope (left-hand list only; the status-bar overall lamp and badge are computed from this result too).
 * @template S
 * @param {S[]} sessions
 * @param {string} scope
 * @param {{ paths: string[], dirs: string[] }} ws
 * @returns {S[]}
 */
function filterByScope(sessions, scope, ws) {
  const list = sessions || [];
  if (normalizeScope(scope) !== SCOPE.WORKSPACE) return list.slice();
  return list.filter((s) => inWorkspace(s, ws));
}

// ---------------------------------------------------------------------------
// Following the current conversation
// ---------------------------------------------------------------------------

/** openai-codex://route/local/<id> -> <id>; takes the segment after local|remote */
function codexConversationId(uri) {
  if (!uri) return null;
  let p = typeof uri === 'string' ? uri : (uri.path != null ? uri.path : String(uri));
  if (typeof uri === 'string') {
    const m = /^[a-z][\w+.-]*:\/\/[^/]*(\/[^?#]*)/i.exec(uri);
    if (m) p = m[1];
  }
  const parts = String(p).split('/').filter(Boolean);
  const i = parts.findIndex((x) => x === 'local' || x === 'remote');
  const id = i >= 0 ? parts[i + 1] : null;
  if (!id) return null;
  try { return decodeURIComponent(id); } catch { return id; }
}

/**
 * Classify a tab: Claude conversation tab, Codex conversation tab, otherwise null.
 * @param {any} tab vscode.Tab
 * @param {{ TabInputWebview?: Function, TabInputCustom?: Function }} [types] the classes from vscode; if omitted, decided by fields
 * @returns {{ provider: 'claude', label: string } | { provider: 'codex', label: string, conversationId: string|null } | null}
 */
function classifyTab(tab, types = {}) {
  const input = tab && tab.input;
  if (!input || typeof input.viewType !== 'string') return null;
  const label = String(tab.label || '').trim();
  const isWebview = types.TabInputWebview ? input instanceof types.TabInputWebview : !input.uri;
  const isCustom = types.TabInputCustom ? input instanceof types.TabInputCustom : !!input.uri;
  if (isWebview && input.viewType.endsWith(CLAUDE_PANEL_SUFFIX)) return { provider: 'claude', label };
  if (isCustom && input.viewType === CODEX_EDITOR_VIEWTYPE) {
    return { provider: 'codex', label, conversationId: codexConversationId(input.uri) };
  }
  return null;
}

const firstCodePoints = (s, n) => Array.from(String(s || '').trim()).slice(0, n).join('');
// Several candidates: prefer open ones, then the most recently updated (used only for matching, never for list order)
function best(list) {
  let b = null;
  for (const s of list) {
    if (!b) { b = s; continue; }
    const la = s.live ? 1 : 0;
    const lb = b.live ? 1 : 0;
    if (la > lb || (la === lb && (s.updatedMs || 0) > (b.updatedMs || 0))) b = s;
  }
  return b;
}

/**
 * Tab -> session key (rules 1 and 2; rule 3, "keep the previous match", is handled by the caller).
 * Claude: (1) tab title equals the first 200 code points of the session title (customTitle / aiTitle);
 *         (2) title is the default "Claude Code" -> the newest Claude session in the workspace whose entrypoint is VS Code (open ones preferred).
 * Codex:  (1) the id in the URI equals the thread id; (2) tab title equals thread_name from session_index.
 * @param {ReturnType<typeof classifyTab>} info
 * @param {any[]} sessions sessions in the current scope
 * @param {{ paths: string[], dirs: string[] }} [ws]
 * @returns {string|null}
 */
function matchChatTab(info, sessions, ws) {
  if (!info) return null;
  const list = (sessions || []).filter((s) => s && s.provider === info.provider);
  if (info.provider === 'claude') {
    if (info.label && info.label !== CLAUDE_DEFAULT_TITLE) {
      const hits = list.filter((s) => (s.titleSource == null || s.titleSource === 'custom' || s.titleSource === 'ai')
        && firstCodePoints(s.title, TITLE_MAX) === info.label);
      const b = best(hits);
      if (b) return b.key;
    }
    if (info.label === CLAUDE_DEFAULT_TITLE || !info.label) {
      const hits = list.filter((s) => (s.entry === 'vscode' || s.entrypoint === 'claude-vscode') && inWorkspace(s, ws || { paths: [], dirs: [] }));
      const b = best(hits);
      if (b) return b.key;
    }
    return null;
  }
  if (info.provider === 'codex') {
    if (info.conversationId) {
      const hit = list.find((s) => s.id === info.conversationId);
      if (hit) return hit.key;
    }
    if (info.label) {
      const b = best(list.filter((s) => (s.titleSource == null || s.titleSource === 'index') && String(s.title || '').trim() === info.label));
      if (b) return b.key;
    }
  }
  return null;
}

// Tab signature: only switching to another tab, or a title change (Claude naming the chat), counts as a switch
function tabSig(info) {
  if (!info) return null;
  return info.provider === 'codex' ? `codex\u0001${info.conversationId || ''}\u0001${info.label}` : `claude\u0001${info.label}`;
}

/**
 * Current-conversation follower (stateful; conversationKey lives only in memory).
 * - onTabEvent: call from tabGroups.onDidChangeTabs / onDidChangeTabGroups / window.onDidChangeWindowState.
 *   If the active tab is a Claude / Codex conversation and the tab changed (or its title changed) -> re-match; on a match
 *   follow = true, and the caller moves the left-hand selection there when followActiveChat is on. Focus events on the
 *   same tab do not follow again. If the active tab is not a conversation (the user went to read code) -> keep the
 *   previous result, do not clear it.
 * - onSnapshot: call on data refresh. Follows once only if the tab switch found no match (the new session was not in the
 *   snapshot yet), the user is still on that tab, and a match appears within pendingMs; otherwise a data refresh never
 *   moves the selection.
 * @param {{ types?: { TabInputWebview?: Function, TabInputCustom?: Function }, now?: () => number, pendingMs?: number }} [o]
 */
function createChatFollower(o = {}) {
  const types = o.types || {};
  const now = o.now || Date.now;
  const pendingMs = o.pendingMs ?? 30e3;
  let key = null;
  let lastSig = null;
  let pending = null; // { sig, since }

  function onTabEvent(tab, sessions, ws) {
    const info = classifyTab(tab, types);
    if (!info) { lastSig = null; pending = null; return { key, follow: false, chat: false }; }
    const sig = tabSig(info);
    if (sig === lastSig) return { key, follow: false, chat: true };
    lastSig = sig;
    const m = matchChatTab(info, sessions, ws);
    if (!m) { pending = { sig, since: now() }; return { key, follow: false, chat: true }; }
    pending = null;
    key = m;
    return { key, follow: true, chat: true };
  }

  function onSnapshot(tab, sessions, ws) {
    if (!pending) return { key, follow: false };
    const info = classifyTab(tab, types);
    if (!info || tabSig(info) !== pending.sig || now() - pending.since > pendingMs) {
      pending = null;
      return { key, follow: false };
    }
    const m = matchChatTab(info, sessions, ws);
    if (!m) return { key, follow: false };
    pending = null;
    key = m;
    return { key, follow: true };
  }

  return {
    onTabEvent,
    onSnapshot,
    /** Session key of the current conversation (never matched -> null) */
    get key() { return key; },
    reset() { key = null; lastSig = null; pending = null; },
  };
}

/**
 * Which session the right-hand view shows: the user's selection if still in the list; otherwise the current
 * conversation; otherwise the first row.
 * The caller keeps the selection itself (it changes only when the user clicks something else); this only decides what to show.
 * @param {{ selectedKey?: string|null, conversationKey?: string|null, keys: string[] }} o keys: left-hand session keys in display order
 * @returns {{ key: string|null, reason: 'selected'|'conversation'|'first'|null }}
 */
function resolveSelection(o) {
  const keys = (o && o.keys) || [];
  if (o.selectedKey && keys.includes(o.selectedKey)) return { key: o.selectedKey, reason: 'selected' };
  if (o.conversationKey && keys.includes(o.conversationKey)) return { key: o.conversationKey, reason: 'conversation' };
  if (keys.length) return { key: keys[0], reason: 'first' };
  return { key: null, reason: null };
}

module.exports = {
  SCOPE, SCOPES, normalizeScope, planScopeMigration,
  projectDirName, workspaceInfo, cwdInWorkspace, copilotInWorkspace, inWorkspace, filterByScope,
  CLAUDE_PANEL_SUFFIX, CLAUDE_DEFAULT_TITLE, CODEX_EDITOR_VIEWTYPE, TITLE_MAX,
  codexConversationId, classifyTab, matchChatTab, createChatFollower, resolveSelection,
};
