'use strict';
// 查看范围与“当前对话”跟随（DESIGN §11.2、§8.3 的迁移规则、§8.4）。
// - 范围只有两档：all（默认）/ workspace，只作用于左侧会话列表；旧的 conversation / pinned 迁移掉。
// - 跟随：只在标签切换事件里算（不在数据刷新时移动选中）；Claude 标签按标题匹配，Codex 标签按 URI 里的 id 匹配。
// 依赖 vscode 的东西（工作区文件夹、Tab、TabInputWebview / TabInputCustom 类）都由调用方传入，node 测试里用桩。

const SCOPE = Object.freeze({ ALL: 'all', WORKSPACE: 'workspace' });
const SCOPES = Object.freeze([SCOPE.ALL, SCOPE.WORKSPACE]);

// §8.4 标签识别
const CLAUDE_PANEL_SUFFIX = 'claudeVSCodePanel';        // 实际 viewType 是 mainThreadWebview-claudeVSCodePanel
const CLAUDE_DEFAULT_TITLE = 'Claude Code';             // 新建、还没起标题的 Claude 标签
const CODEX_EDITOR_VIEWTYPE = 'chatgpt.conversationEditor';
const TITLE_MAX = 200;                                  // Claude 扩展把标签标题截到 200 个码点
const PROJECT_DIR_MAX = 200;                            // Claude 目录名超过 200 字符会截断再接哈希

// ---------------------------------------------------------------------------
// 范围
// ---------------------------------------------------------------------------

/**
 * 设置值 → 两档之一。旧值：conversation → workspace（最接近“只看这里”），pinned 及其它 → all。
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
 * 激活时要写的迁移（纯函数；调用方把 target 映射成 ConfigurationTarget 再 update）：
 * 1. scope 在某一层设成了已删掉的档（conversation / pinned / 乱写）→ 在那一层改成 normalizeScope 的结果；
 * 2. 旧设置 onlyWorkspace 生效值为 true、且 scope 哪一层都没设过 → 在 onlyWorkspace 生效的那一层写 'workspace'。
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
      break; // 只看生效的那一层
    }
  }
  return out;
}

/** Claude 的项目目录名规则：非字母数字都换成 '-'（沿用 monitor.js 的 projectDirName） */
function projectDirName(p) {
  return String(p || '').replace(/[^a-zA-Z0-9]/g, '-');
}

// Windows 盘符路径不分大小写
const isWinPath = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
function normPath(p) {
  let s = String(p || '');
  if (!s) return '';
  if (s.length > 1) s = s.replace(/[\\/]+$/, '');
  return isWinPath(s) ? s.replace(/\//g, '\\').toLowerCase() : s;
}

/**
 * 工作区信息。
 * @param {Array<string|{ uri: { fsPath: string } }>|undefined|null} folders vscode.workspace.workspaceFolders 或路径数组
 * @returns {{ paths: string[], dirs: string[] }}
 */
function workspaceInfo(folders) {
  const paths = [];
  for (const f of folders || []) {
    const p = typeof f === 'string' ? f : f && f.uri && f.uri.fsPath;
    if (p) paths.push(p);
  }
  return { paths, dirs: paths.map(projectDirName) };
}

/** cwd 等于或位于某个工作区文件夹下 */
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
 * 会话属于当前工作区（§8.3 workspace 档）：
 * Claude：记录目录名对得上（目录名超 200 字符时比前 200 个），或 cwd 等于/位于工作区文件夹下；Codex：只看 cwd。
 * @param {{ provider: string, projectDir?: string|null, cwd?: string|null }} s
 * @param {{ paths: string[], dirs: string[] }} ws
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
  return cwdInWorkspace(s.cwd, ws);
}

/**
 * 按范围过滤会话（只用于左侧列表；状态栏总灯、徽标也按这个结果算）。
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
// 当前对话跟随（§8.4）
// ---------------------------------------------------------------------------

/** openai-codex://route/local/<id> → <id>；取 local|remote 后面那一段 */
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
 * 识别标签：Claude 对话标签、Codex 对话标签，其它返回 null。
 * @param {any} tab vscode.Tab
 * @param {{ TabInputWebview?: Function, TabInputCustom?: Function }} [types] 传 vscode 里的类；不传时按字段判断
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
// 多个候选：打开中的优先，再取最近更新的（只用于匹配，不影响列表顺序）
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
 * 标签 → 会话 key（§8.4 规则 ①②；③“保持上一次”由调用方处理）。
 * Claude：① 标签标题等于会话标题（customTitle / aiTitle）前 200 码点；
 *         ② 标题是默认的 “Claude Code” → 工作区内、入口是 VS Code 的最新 Claude 会话（打开中的优先）。
 * Codex： ① URI 里的 id 等于线程 id；② 标签标题等于 session_index 的 thread_name。
 * @param {ReturnType<typeof classifyTab>} info
 * @param {any[]} sessions 当前范围内的会话
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

// 同一个标签的签名：切到别的标签、或标题变了（Claude 起好标题）才算“切换”
function tabSig(info) {
  if (!info) return null;
  return info.provider === 'codex' ? `codex\u0001${info.conversationId || ''}\u0001${info.label}` : `claude\u0001${info.label}`;
}

/**
 * 当前对话跟随器（有状态，conversationKey 只在内存里）。
 * - onTabEvent：在 tabGroups.onDidChangeTabs / onDidChangeTabGroups / window.onDidChangeWindowState 里调。
 *   活动标签是 Claude / Codex 对话且换了标签（或标题变了）→ 重新匹配；匹配上时 follow = true，
 *   调用方在 followActiveChat 开着时把左侧选中切过去。同一标签上的焦点事件不会再次 follow。
 *   活动标签不是对话（用户去看代码了）→ 保持上一次结果，不清空。
 * - onSnapshot：数据刷新时调。只有“切标签时没匹配上”（新会话还没出现在快照里）且仍停在那个标签、
 *   在 pendingMs 内终于匹配上，才 follow 一次；其它情况数据刷新从不移动选中。
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
    /** 当前对话的会话 key（从没命中过 → null） */
    get key() { return key; },
    reset() { key = null; lastSig = null; pending = null; },
  };
}

/**
 * 右侧显示哪个会话（§11.2）：用户选过且还在列表里 → 它；否则当前对话；再没有 → 第一行。
 * 选中本身由调用方一直保留（用户点别的才换），这里只决定“显示哪个”。
 * @param {{ selectedKey?: string|null, conversationKey?: string|null, keys: string[] }} o keys：左侧按显示顺序的会话 key
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
  projectDirName, workspaceInfo, cwdInWorkspace, inWorkspace, filterByScope,
  CLAUDE_PANEL_SUFFIX, CLAUDE_DEFAULT_TITLE, CODEX_EDITOR_VIEWTYPE, TITLE_MAX,
  codexConversationId, classifyTab, matchChatTab, createChatFollower, resolveSelection,
};
