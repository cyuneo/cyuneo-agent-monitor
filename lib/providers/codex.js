'use strict';
// Codex provider（DESIGN §2、§4.4–4.8、§5、§6、§7、§11.1）。
// 读 $CODEX_HOME 下的 rollout（sessions/YYYY/MM/DD/rollout-*.jsonl）、session_index.jsonl、
// models_cache.json、config.toml，产出 Session v2。只读文件，不联网，不产出任何界面文字：
// 只给状态码、步骤种类、数字、时间戳和原文片段（标题、工具参数摘要、结果、报错首行）。
// 纯 Node，不依赖 vscode；worker、终端版都能用。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { JsonlTail } = require('../core/jsonl');
const {
  STATUS, STEP, makeStatus, isRunningCode, isNeedsYouCode, isErrorCode,
  guessAwaitingApproval, isFastTool, sessionKey, parseSessionKey, APPROVAL_GUESS, APPROVAL_GUESS_DEFAULT_SECONDS,
  noteCompact, compactLoopOf,
} = require('../core/status');
const pricing = require('../core/pricing');
const quotaLib = require('../core/quota');
const contextLib = require('../core/context');
const { resumeHints } = require('../core/resume');

const PROVIDER = 'codex';

const DEFAULT_LIMITS = Object.freeze({ timeline: 30, timelineSent: 12, resultChars: 4000, filesPerAgent: 200, errorsPerAgent: 10 });
const ROLLOUT_RE = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const DISCOVER_MS = 5000;       // 每 5 秒重新列一次 rollout（沿用 discover 节奏）
const COLD_DIR_MS = 60000;      // 文件很多时，旧日期目录每 60 秒扫一次
const MANY_FILES = 2000;
const HOT_DAYS = 3;             // 最近几个日期目录每次都扫
const MAX_REMEMBER = 5000;      // startedMs / 首次看到时间最多记这么多条
const RL_TAIL_BYTES = 512 * 1024; // 窗口内没有线程时，从最新 rollout 末尾找额度快照
const COMPACT_MERGE_MS = 60000; // compacted 行与 ContextCompaction 条目是同一次压缩，60 秒内只记一次
const RUNNING_CELL_RE = /^\s*Script running with cell ID\s+(\S+)/i; // exec 代码单元还在跑【本机 113 条】
const FAILED_SCRIPT_RE = /^\s*Script failed\b/i;                     // exec 代码抛错【本机 5 条】

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function tsOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v !== 'string' || !v) return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

function str(v) { return typeof v === 'string' && v ? v : null; }
function int(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; }

// 单行、限长（沿用 monitor.js 的 oneLine）
function oneLine(t, max = 90) {
  if (t == null) return '';
  let s = String(t);
  if (s.length > max * 8) s = s.slice(0, max * 8); // 很长的原文先截一段再压空白，省得整段处理
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// 第一条非空行，≤ max 字
function firstLine(t, max = 200) {
  if (typeof t !== 'string') return null;
  for (const l of t.split('\n')) { const s = l.trim(); if (s) return oneLine(s, max); }
  return null;
}

// 最后一条非空行（命令失败时报错一般在输出末尾）
function lastLine(t, max = 200) {
  if (typeof t !== 'string') return null;
  const ls = t.split('\n');
  for (let i = ls.length - 1; i >= 0; i--) { const s = ls[i].trim(); if (s) return oneLine(s, max); }
  return null;
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? String(p) : '…/' + parts.slice(-2).join('/');
}

// JS / JSON 字符串字面量里常见的转义还原成可读文字
function unescapeLiteral(s) {
  return String(s).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, c) => {
    if (c === 'n' || c === 'r' || c === 't') return ' ';
    if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return c;
  });
}

// 消息 content 数组 → 文字（input_text / output_text / text / Text）
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const c of content) {
    if (c && typeof c.text === 'string') out += (out ? '\n' : '') + c.text;
  }
  return out;
}

// 工具输出 → 文字（字符串，或 [{type:'input_text', text}] 数组）
function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return contentText(output);
  if (output && typeof output === 'object' && typeof output.content === 'string') return output.content;
  return '';
}

// 注入的上下文（环境信息、AGENTS.md 等）不是用户真正输入的提示
function isInjectedContext(text) {
  const t = String(text || '').trimStart();
  return t.startsWith('<') || t.startsWith('# AGENTS.md');
}

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_REMEMBER) map.delete(map.keys().next().value);
  return value;
}

// ---------------------------------------------------------------------------
// 工具调用 → 步骤（§4.6 describeCodexCall）
// ---------------------------------------------------------------------------

// 从 JS 代码里取 key: "字符串"（key 可带引号；值可以是 "…" '…' `…`）
function pickStringProp(code, keys) {
  const k = keys.join('|');
  const re = new RegExp('(?:\\b(?:' + k + ')|["\'](?:' + k + ')["\'])\\s*:\\s*(["\'`])((?:\\\\[\\s\\S]|(?!\\1)[^\\\\])*)\\1');
  const m = re.exec(code);
  return m ? unescapeLiteral(m[2]) : null;
}

// apply_patch 补丁头：*** Add/Update/Delete File: 路径（可跟 *** Move to: 新路径）。
// 补丁可能是真换行，也可能是字符串里的 \n 转义，所以路径在换行或反斜杠处截止。
function parsePatchHeaders(text) {
  const out = [];
  if (typeof text !== 'string' || !text.includes('*** ')) return out;
  const re = /\*\*\* (Add|Update|Delete) File: ((?:[^\n\\"'`]|\\(?![nrt"'`\\]))+)(?:(?:\n|\\n)\*\*\* Move to: ((?:[^\n\\"'`]|\\(?![nrt"'`\\]))+))?/g;
  let m;
  while ((m = re.exec(text))) {
    const p = m[2].trim();
    if (!p) continue;
    const op = m[1] === 'Add' ? 'create' : m[1] === 'Delete' ? 'delete' : (m[3] ? 'move' : 'edit');
    out.push({ path: p, op, movedTo: m[3] ? m[3].trim() : null });
  }
  return out;
}

/**
 * exec 代码模式：input 是一段 JS，调用的工具形如 tools.<名字>(…)。
 * @param {string} code
 * @returns {{ tool: string, tools: string[], detail: string|null, parallel: number, patch: {path:string, op:string, movedTo:string|null}[] }}
 */
function describeExecCode(code) {
  const src = typeof code === 'string' ? code : '';
  const calls = [...src.matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  const tools = [...new Set(calls)];
  const patch = parsePatchHeaders(src);
  if (!tools.length) return { tool: 'exec', tools: [], detail: null, parallel: 1, patch };
  const tool = tools[0];
  let detail = null;
  if (tool === 'exec_command') detail = pickStringProp(src, ['cmd', 'command']);
  else if (tool === 'apply_patch') detail = patch.length ? shortPath(patch[0].path) : null;
  else if (tool === 'web__run' || /search/i.test(tool)) detail = pickStringProp(src, ['query', 'q']);
  else if (tool === 'view_image') detail = shortPath(pickStringProp(src, ['path']));
  return { tool, tools, detail: detail ? oneLine(detail) : null, parallel: Math.max(1, calls.length), patch };
}

// function_call 的 arguments（JSON 字符串）→ 参数摘要
function describeArgs(name, args) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  if (!a || typeof a !== 'object') return { detail: null, patch: [], cellId: null };
  const cellId = a.cell_id != null ? String(a.cell_id) : null;
  let patch = [];
  let detail = null;
  const cmd = a.cmd != null ? a.cmd : a.command;
  if (Array.isArray(cmd)) detail = cmd.map(String).join(' ');
  else if (typeof cmd === 'string') detail = cmd;
  if (typeof a.input === 'string' && a.input.includes('*** ')) patch = parsePatchHeaders(a.input);
  else if (typeof a.patch === 'string') patch = parsePatchHeaders(a.patch);
  if (!detail && patch.length) detail = shortPath(patch[0].path);
  if (!detail) {
    for (const k of ['query', 'q', 'path', 'file_path', 'url', 'pattern', 'message', 'prompt']) {
      if (typeof a[k] === 'string' && a[k]) { detail = k.includes('path') ? shortPath(a[k]) : a[k]; break; }
    }
  }
  return { detail: detail ? oneLine(detail) : null, patch, cellId };
}

/**
 * response_item 的工具调用 → 步骤描述。
 * - custom_tool_call 名为 exec：按代码取 tools.<名字>；
 * - function_call：wait（等代码单元）、shell / exec_command / apply_patch 等老版本工具，解析 arguments；
 * - local_shell_call：老版本本地 shell。
 * @param {any} p response_item.payload
 * @returns {{ name: string, tool: string, tools: string[], detail: string|null, parallel: number,
 *   patch: {path:string, op:string, movedTo:string|null}[], cellId: string|null }}
 */
function describeCodexCall(p) {
  const type = p && p.type;
  const name = str(p && p.name) || (type === 'local_shell_call' ? 'local_shell' : String(type || 'tool').replace(/_call$/, ''));
  if (type === 'custom_tool_call' && name === 'exec') {
    const d = describeExecCode(p.input);
    return { name, tool: d.tool, tools: d.tools, detail: d.detail, parallel: d.parallel, patch: d.patch, cellId: null };
  }
  if (type === 'custom_tool_call') {
    // 其它自定义工具：input 是原文（如 apply_patch 的补丁）
    const patch = parsePatchHeaders(p.input);
    const detail = name === 'apply_patch' && patch.length ? shortPath(patch[0].path) : null;
    return { name, tool: name, tools: [name], detail, parallel: 1, patch, cellId: null };
  }
  if (type === 'local_shell_call') {
    const cmd = p.action && Array.isArray(p.action.command) ? p.action.command.join(' ') : null;
    return { name, tool: 'local_shell', tools: ['local_shell'], detail: cmd ? oneLine(cmd) : null, parallel: 1, patch: [], cellId: null };
  }
  const d = describeArgs(name, p && (p.arguments != null ? p.arguments : p.input));
  return { name, tool: name, tools: [name], detail: name === 'wait' ? null : d.detail, parallel: 1, patch: d.patch, cellId: d.cellId };
}

// 决定 4 的推测用哪个工具名：代码里全是快工具才算快；否则取第一个非快工具（避免误报）
function guessToolOf(call) {
  const c = call && call.cell ? call.cell : call;
  if (!c) return null;
  const tools = c.tools && c.tools.length ? c.tools : [c.tool];
  const slow = tools.find((t) => !isFastTool(PROVIDER, t));
  return slow || tools[0] || c.tool || null;
}

// ---------------------------------------------------------------------------
// 单个线程（rollout 文件）的状态：增量累积
// ---------------------------------------------------------------------------

/**
 * @param {typeof DEFAULT_LIMITS} [limits]
 * @param {string|null} [fileId] 文件名里的线程 id；只认这个 id 的 session_meta
 */
function newThreadState(limits = DEFAULT_LIMITS, fileId = null) {
  return {
    limits,
    fileId,
    meta: null,               // metaOf() 的结果
    firstTs: null, lastTs: null,
    tcModel: null,            // 最近 turn_context.model
    settingsModel: null,      // 最近 thread_settings_applied.thread_settings.model
    cwd: null, serviceTier: null,
    approvalPolicy: null,     // 最近 turn_context / thread_settings 的 approval_policy（'never' 时不会弹批准）
    openTurn: null,           // { turnId, startedMs, modelOutput, promptEv, promptFromEvent }
    lastTurnEnd: null,        // { kind: 'complete'|'aborted', ms, turnId, reason, error, lastAgentMessage }
    lastDoneMs: null,         // 最近一次“一轮正常结束”的时间（doneAtMs）
    turns: 0,
    pending: new Map(),       // call_id -> call（describeCodexCall + ms + cell）
    cells: new Map(),         // exec 代码单元 cell_id -> 发起它的 call（还在跑）
    callIds: new Set(),       // toolCalls 按 call_id 去重
    toolCalls: 0,
    lastEvent: null,          // { kind, tool, detail, parallel, ms }
    tokenInfo: null,          // 最近 token_count.info
    ctxWindowHint: null,      // task_started.model_context_window
    rateLimits: null, rateLimitsMs: 0,
    // 用量：有 token_usage_record 的按 response_id 去重；之前的部分按 total_token_usage 差值
    usage: { apiCalls: 0, output: 0, processed: 0, costUsd: 0, pricedAny: false, estimated: false, unpricedTokens: 0, unpricedModel: null },
    lastApiMs: null,          // 最近一次响应用量的时间
    responses: new Set(),
    hasRecords: false,
    prevTotal: null,
    lastCompact: null,        // { ms, trigger, preTokens, postTokens, model }
    compactCount: 0, compactTimes: [], // §11.8 第 2 条（compacted 行与 ContextCompaction 60 秒内算一次）
    awaitPostCompact: false,  // 压缩后等下一条 token_count（Codex 压缩后会按新历史重算一次）取 postTokens
    timeline: [], files: new Map(), errors: [], toolErrors: 0,
    firstPrompt: null,        // 第一条用户消息（标题用）
    fallbackPrompt: null,     // 没有 UserMessage 事件时，退回第一条非注入的 response_item 用户消息
    finalAnswer: null,        // { text, ms } 最近一条 final_answer
    lastText: null,           // { text, ms } 最近一条 assistant 文字
    result: null,             // { text, ms, source, truncated }
    sawPatchEnd: false,
  };
}

function modelNow(s) { return s.tcModel || s.settingsModel || null; }

function pushTimeline(s, ev) {
  s.timeline.push(ev);
  const max = (s.limits && s.limits.timeline) || DEFAULT_LIMITS.timeline;
  if (s.timeline.length > max) s.timeline.splice(0, s.timeline.length - max);
  return ev;
}

function pushError(s, ms, tool, text) {
  s.toolErrors++;
  s.errors.push({ ms, tool: tool || null, text: text || '' });
  const max = (s.limits && s.limits.errorsPerAgent) || DEFAULT_LIMITS.errorsPerAgent;
  if (s.errors.length > max) s.errors.splice(0, s.errors.length - max);
  pushTimeline(s, { ms, kind: 'toolError', tool: tool || null, detail: text || null });
}

function addFile(s, ms, filePath, op, movedTo) {
  if (!filePath) return;
  const f = s.files.get(filePath);
  if (f) {
    f.count++; f.lastMs = ms;
    if (op === 'delete' || op === 'move' || f.op !== 'create') f.op = op;
    if (movedTo) f.movedTo = movedTo;
    return;
  }
  const max = (s.limits && s.limits.filesPerAgent) || DEFAULT_LIMITS.filesPerAgent;
  if (s.files.size >= max) return;
  s.files.set(filePath, { path: filePath, op, count: 1, lastMs: ms, movedTo: movedTo || null });
}

// FileChange.changes：键是路径，值 { type: add|update|delete, unified_diff?, move_path?, content? }
function addChanges(s, ms, changes) {
  if (!changes || typeof changes !== 'object') return;
  for (const [p, c] of Object.entries(changes)) {
    const t = c && typeof c === 'object' ? (c.type || Object.keys(c)[0]) : null;
    const inner = c && typeof c === 'object' && !c.type && t ? c[t] : c;
    const move = inner && typeof inner === 'object' ? str(inner.move_path) : null;
    const op = t === 'add' ? 'create' : t === 'delete' ? 'delete' : move ? 'move' : 'edit';
    addFile(s, ms, p, op, move);
  }
}

function setPrompt(s, text, fromEvent) {
  if (typeof text !== 'string' || !text.trim()) return;
  if (fromEvent) { if (s.firstPrompt == null) s.firstPrompt = text; }
  else if (s.fallbackPrompt == null && !isInjectedContext(text)) s.fallbackPrompt = text;
  const t = s.openTurn;
  if (!t || !t.promptEv) return;
  // UserMessage 事件是权威来源；response_item 的用户消息只在还没有时补上
  if (fromEvent && !t.promptFromEvent) { t.promptEv.detail = oneLine(text); t.promptFromEvent = true; }
  else if (!fromEvent && t.promptEv.detail == null && !isInjectedContext(text)) t.promptEv.detail = oneLine(text);
  if (s.lastEvent && s.lastEvent.kind === STEP.PROMPT) s.lastEvent.detail = t.promptEv.detail;
}

function markOutput(s) { if (s.openTurn) s.openTurn.modelOutput = true; }

// 最终回复：legacy 模式里 response_item 与 agent_message 事件是同一条，文字相同就保留先到的
function setFinal(s, text, ms) {
  if (!text) return;
  if (s.finalAnswer && s.finalAnswer.text === text && ms - s.finalAnswer.ms < 60000) return;
  s.finalAnswer = { text, ms };
}

function setResult(s, text, ms, source) {
  const max = (s.limits && s.limits.resultChars) || DEFAULT_LIMITS.resultChars;
  const t = String(text);
  s.result = { text: t.length > max ? t.slice(0, max) : t, ms, source, truncated: t.length > max };
}

// 一条用量计入会话累计（model / tier 取当时的值）
function addUsage(s, u, total, ms) {
  const model = modelNow(s);
  const tok = pricing.openaiUsageTokens(u);
  const usd = pricing.priceOpenAI(model, u, s.serviceTier);
  if (ms != null && (s.lastApiMs == null || ms > s.lastApiMs)) s.lastApiMs = ms;
  s.usage.apiCalls++;
  s.usage.output += tok.output;
  s.usage.processed += total != null ? int(total) : tok.input + tok.output;
  if (usd == null) {
    s.usage.unpricedTokens += tok.input + tok.output;
    if (model) s.usage.unpricedModel = model;
  } else {
    s.usage.costUsd += usd;
    s.usage.pricedAny = true;
    // 价格表里缺这一档（如没有长上下文价、没有缓存写价）时按近似价算，标“估”
    const r = pricing.openaiRates(model, { tier: s.serviceTier, long: tok.input > pricing.OPENAI_LONG_CONTEXT });
    if (r && (r.estimated || (tok.cacheWrite > 0 && r.cacheWrite == null))) s.usage.estimated = true;
  }
}

const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];

// 老版本（没有 token_usage_record）：本条 total_token_usage − 上条；相等跳过；变小视为重置，整条计入
function addTotalDelta(s, total, ms) {
  if (!total || typeof total !== 'object') return;
  const prev = s.prevTotal;
  s.prevTotal = total;
  let d = {};
  let reset = false;
  if (prev) {
    for (const k of USAGE_KEYS) {
      const v = int(total[k]) - int(prev[k]);
      if (v < 0) { reset = true; break; }
      d[k] = v;
    }
  }
  if (!prev || reset) d = Object.fromEntries(USAGE_KEYS.map((k) => [k, int(total[k])]));
  if (!USAGE_KEYS.some((k) => d[k] > 0)) return;
  addUsage(s, d, d.total_tokens || (d.input_tokens + d.output_tokens), ms);
}

function onCompact(s, ms) {
  if (s.lastCompact && Math.abs(ms - s.lastCompact.ms) < COMPACT_MERGE_MS) return;
  const pre = s.tokenInfo && s.tokenInfo.last_token_usage ? int(s.tokenInfo.last_token_usage.total_tokens) : null;
  // model：压缩时的模型（§11.12.2；Codex 看不出自动 / 手动，trigger 恒 null，不参与学习实测压缩点）
  // postTokens：压缩后的第一条 token_count（本机：compacted 之后紧跟一条按新历史重算的 token_count，
  // total_token_usage 不变、last_token_usage 变成压缩后的大小）
  s.lastCompact = { ms, trigger: null, preTokens: pre || null, postTokens: null, model: modelNow(s) };
  s.awaitPostCompact = true;
  s.compactCount++;
  noteCompact(s.compactTimes, ms);
  s.lastEvent = { kind: STEP.COMPACT, tool: null, detail: null, parallel: 0, ms };
  pushTimeline(s, { ms, kind: 'compact', tool: null, detail: null });
}

function metaOf(p, ms) {
  const src = p.source;
  const sub = src && typeof src === 'object' ? (src.subagent !== undefined ? src.subagent : src.sub_agent) : undefined;
  const spawn = sub && typeof sub === 'object' && sub.thread_spawn && typeof sub.thread_spawn === 'object' ? sub.thread_spawn : null;
  const other = sub && typeof sub === 'object' && typeof sub.other === 'string' ? sub.other : null;
  const internal = src && typeof src === 'object' && typeof src.internal === 'string' ? src.internal : null;
  const subKind = typeof sub === 'string' ? sub : other || (spawn ? 'thread_spawn' : sub ? Object.keys(sub)[0] || null : null);
  const threadSource = str(p.thread_source);
  const id = str(p.id);
  const parentId = str(p.parent_thread_id) || (spawn && str(spawn.parent_thread_id)) || null;
  const sessionId = str(p.session_id);
  return {
    id,
    parentId,
    // session_id 等于根线程 id【源码 SessionMeta】；子线程挂到根上
    rootId: sessionId && sessionId !== id ? sessionId : parentId,
    timestampMs: tsOf(p.timestamp) ?? ms,
    cwd: str(p.cwd),
    originator: str(p.originator),
    cliVersion: str(p.cli_version),
    source: typeof src === 'string' ? src : sub !== undefined ? 'subagent' : internal ? 'internal' : null,
    subKind,
    internal,
    threadSource,
    nickname: str(p.agent_nickname) || (spawn && str(spawn.agent_nickname)) || null,
    role: str(p.agent_role) || str(p.agent_type) || (spawn && (str(spawn.agent_role) || str(spawn.agent_type))) || null,
    historyMode: str(p.history_mode),
    reviewer: threadSource === 'guardian_review' || other === 'guardian' || internal === 'guardian',
    // 记忆整理这类内部线程不是用户对话，不单独成会话
    hidden: threadSource === 'memory_consolidation' || internal === 'memory_consolidation' || subKind === 'memory_consolidation',
  };
}

// 老格式：没有 {type, payload} 外壳的行
const BARE_RESPONSE_TYPES = new Set(['message', 'reasoning', 'function_call', 'function_call_output',
  'custom_tool_call', 'custom_tool_call_output', 'local_shell_call', 'web_search_call']);

/**
 * JsonlTail 的 feed：把 rollout 的一行累积进线程状态。未知的 type 一律忽略。
 * @param {ReturnType<typeof newThreadState>} s
 * @param {any} e
 */
function ingestCodex(s, e) {
  const ms0 = tsOf(e.timestamp);
  if (ms0 != null) {
    if (s.firstTs == null) s.firstTs = ms0;
    if (s.lastTs == null || ms0 > s.lastTs) s.lastTs = ms0;
  }
  const ms = ms0 != null ? ms0 : (s.lastTs || 0);
  let type = e.type;
  let p = e.payload && typeof e.payload === 'object' ? e.payload : null;
  if (!p) {
    if (BARE_RESPONSE_TYPES.has(type)) { p = e; type = 'response_item'; }
    else if (!type && str(e.id) && e.timestamp) { p = e; type = 'session_meta'; }
    else return;
  }
  switch (type) {
    case 'session_meta': {
      const m = metaOf(p, ms);
      if (s.meta) return;                                   // 只认第一条
      if (s.fileId && m.id && m.id !== s.fileId) return;    // 复制来的别的线程的 meta
      s.meta = m;
      if (!s.cwd && m.cwd) s.cwd = m.cwd;
      return;
    }
    case 'turn_context':
      if (str(p.model)) s.tcModel = p.model;
      if (str(p.cwd)) s.cwd = p.cwd;
      if (p.approval_policy !== undefined) s.approvalPolicy = policyOf(p.approval_policy);
      return;
    case 'event_msg': onEvent(s, p, ms); return;
    case 'response_item': onResponse(s, p, ms); return;
    case 'token_usage_record': onUsageRecord(s, p, ms); return;
    case 'compacted': onCompact(s, ms); return;
    default: return;
  }
}

// approval_policy 可能是字符串（never / on-request / untrusted …）或对象（细分策略）
function policyOf(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return Object.keys(v)[0] || 'custom';
  return null;
}

function onUsageRecord(s, p, ms) {
  s.hasRecords = true;
  const id = str(p.response_id);
  if (id) { if (s.responses.has(id)) return; s.responses.add(id); }
  if (!p.usage || typeof p.usage !== 'object') return;
  addUsage(s, p.usage, p.usage.total_tokens, ms);
}

function endTurn(s, p, ms) {
  const t = s.openTurn;
  // 结束的是更早的那一轮（turn_id 对不上）：只记结束，不关掉进行中的这一轮
  const mismatch = t && t.turnId && str(p.turn_id) && p.turn_id !== t.turnId;
  if (!mismatch) {
    s.openTurn = null;
    s.pending.clear();
    s.cells.clear();
  }
  return !mismatch;
}

function onEvent(s, p, ms) {
  switch (p.type) {
    case 'task_started':
    case 'turn_started': {
      s.turns++;
      s.pending.clear();
      s.cells.clear();
      if (p.model_context_window != null) s.ctxWindowHint = int(p.model_context_window) || s.ctxWindowHint;
      const promptEv = pushTimeline(s, { ms, kind: 'prompt', tool: null, detail: null });
      s.openTurn = { turnId: str(p.turn_id), startedMs: ms, modelOutput: false, promptEv, promptFromEvent: false };
      s.lastEvent = { kind: STEP.PROMPT, tool: null, detail: null, parallel: 0, ms };
      return;
    }
    case 'task_complete':
    case 'turn_complete': {
      const closes = endTurn(s, p, ms);
      const err = p.error && typeof p.error === 'object' ? p.error : null;
      s.lastTurnEnd = {
        kind: 'complete', ms, turnId: str(p.turn_id), reason: null,
        error: err ? { message: typeof err.message === 'string' ? err.message : null, info: err.codex_error_info ?? null } : null,
        lastAgentMessage: typeof p.last_agent_message === 'string' ? p.last_agent_message : null,
        closes,
      };
      if (err) {
        const kind = quotaLib.codexErrorKind(err.codex_error_info);
        pushTimeline(s, { ms, kind: kind === 'usage_limit_exceeded' ? 'quota' : 'apiError', tool: null, detail: firstLine(err.message) });
      } else {
        s.lastDoneMs = ms;
        pushTimeline(s, { ms, kind: 'done', tool: null, detail: null });
      }
      // 结果：task_complete.last_agent_message；为 null 时退回最近一条 final_answer
      if (typeof p.last_agent_message === 'string' && p.last_agent_message) setResult(s, p.last_agent_message, ms, 'taskComplete');
      else if (s.finalAnswer) setResult(s, s.finalAnswer.text, s.finalAnswer.ms, 'lastText');
      else if (s.lastText) setResult(s, s.lastText.text, s.lastText.ms, 'lastText');
      return;
    }
    case 'turn_aborted': {
      const closes = endTurn(s, p, ms);
      const reason = str(p.reason) || 'interrupted';
      s.lastTurnEnd = { kind: 'aborted', ms, turnId: str(p.turn_id), reason, error: null, lastAgentMessage: null, closes };
      const kind = reason === 'budget_limited' ? 'quota' : (reason === 'replaced' || reason === 'review_ended') ? 'done' : 'interrupt';
      if (kind === 'done') s.lastDoneMs = ms;
      pushTimeline(s, { ms, kind, tool: null, detail: null });
      return;
    }
    case 'token_count': {
      const info = p.info && typeof p.info === 'object' ? p.info : null;
      if (info) {
        s.tokenInfo = info;
        if (!s.hasRecords) addTotalDelta(s, info.total_token_usage, ms);
        if (s.awaitPostCompact && s.lastCompact) {
          const last = info.last_token_usage && typeof info.last_token_usage === 'object' ? int(info.last_token_usage.total_tokens) : 0;
          s.lastCompact.postTokens = last || null;
          s.awaitPostCompact = false;
        }
      }
      if (p.rate_limits && typeof p.rate_limits === 'object') { s.rateLimits = p.rate_limits; s.rateLimitsMs = ms; }
      return;
    }
    case 'thread_settings_applied': {
      const ts = p.thread_settings && typeof p.thread_settings === 'object' ? p.thread_settings : {};
      if (str(ts.model)) s.settingsModel = ts.model;
      if (ts.service_tier !== undefined) s.serviceTier = str(ts.service_tier);
      if (ts.approval_policy !== undefined) s.approvalPolicy = policyOf(ts.approval_policy);
      return;
    }
    case 'item_completed': onItem(s, p.item, ms); return;
    // legacy 模式的事件（paginated 模式改写 item_completed）
    case 'user_message': setPrompt(s, p.message, true); return;
    case 'agent_message':
      if (typeof p.message === 'string' && p.phase === 'final_answer') setFinal(s, p.message, ms);
      return;
    case 'patch_apply_end': {
      s.sawPatchEnd = true;
      if (p.success === false || p.status === 'failed' || p.status === 'declined') {
        pushError(s, ms, 'apply_patch', firstLine(p.stderr) || firstLine(p.stdout) || p.status || null);
      } else addChanges(s, ms, p.changes);
      return;
    }
    case 'context_compacted': onCompact(s, ms); return;
    case 'mcp_tool_call_end': {
      const r = p.result;
      const inv = p.invocation || {};
      const tool = inv.server && inv.tool ? `mcp__${inv.server}__${inv.tool}` : 'mcp';
      if (r && typeof r === 'object' && r.Err !== undefined) pushError(s, ms, tool, firstLine(String(r.Err)));
      else if (r && r.Ok && r.Ok.isError) pushError(s, ms, tool, firstLine(contentText(r.Ok.content)));
      return;
    }
    default: return;
  }
}

function onItem(s, it, ms) {
  if (!it || typeof it !== 'object') return;
  switch (it.type) {
    case 'UserMessage': setPrompt(s, contentText(it.content), true); return;
    case 'AgentMessage': {
      if (it.phase === 'final_answer') setFinal(s, contentText(it.content), ms);
      return;
    }
    case 'Reasoning': {
      // 思考摘要：补给当前这条 thinking
      const sum = Array.isArray(it.summary_text) ? it.summary_text.find((x) => typeof x === 'string' && x.trim()) : null;
      const last = s.timeline[s.timeline.length - 1];
      if (sum && last && last.kind === 'thinking' && !last.detail) last.detail = oneLine(sum);
      if (sum && s.lastEvent && s.lastEvent.kind === STEP.THINKING && !s.lastEvent.detail) s.lastEvent.detail = oneLine(sum);
      return;
    }
    case 'FileChange':
      if (it.status === 'completed') addChanges(s, ms, it.changes);
      else if (it.status === 'failed' || it.status === 'declined') {
        pushError(s, ms, 'apply_patch', firstLine(it.stderr) || firstLine(it.stdout) || it.status);
      }
      return;
    case 'CommandExecution': {
      const failed = it.status === 'failed' || (it.status == null && it.exit_code != null && it.exit_code !== 0);
      if (!failed) return;
      const text = firstLine(it.stderr) || lastLine(it.aggregated_output) || lastLine(it.stdout)
        || (it.exit_code != null ? `exit ${it.exit_code}` : null);
      pushError(s, ms, 'exec_command', text);
      return;
    }
    case 'McpToolCall': {
      if (it.status !== 'failed') return;
      const tool = it.server && it.tool ? `mcp__${it.server}__${it.tool}` : 'mcp';
      const r = it.result;
      let text = null;
      if (r && typeof r === 'object') {
        if (typeof r.Err === 'string') text = firstLine(r.Err);
        else text = firstLine(contentText(r.content || (r.Ok && r.Ok.content)));
      } else if (typeof r === 'string') text = firstLine(r);
      pushError(s, ms, tool, text || (typeof it.error === 'string' ? firstLine(it.error) : null));
      return;
    }
    case 'ContextCompaction': onCompact(s, ms); return;
    default: return;
  }
}

function onResponse(s, p, ms) {
  switch (p.type) {
    case 'message': {
      const text = contentText(p.content);
      if (p.role === 'user') { setPrompt(s, text, false); return; }
      if (p.role !== 'assistant') return;
      markOutput(s);
      if (!text || !text.trim()) return;
      s.lastText = { text, ms };
      if (p.phase === 'final_answer') setFinal(s, text, ms);
      const detail = oneLine(text);
      s.lastEvent = { kind: STEP.TEXT, tool: null, detail, parallel: 0, ms };
      pushTimeline(s, { ms, kind: 'text', tool: null, detail });
      return;
    }
    case 'reasoning': {
      markOutput(s);
      const sum = Array.isArray(p.summary) ? p.summary.find((x) => x && typeof x.text === 'string' && x.text.trim()) : null;
      const detail = sum ? oneLine(sum.text) : null;
      const last = s.timeline[s.timeline.length - 1];
      if (last && last.kind === 'thinking') { if (!last.detail && detail) last.detail = detail; } // 连续的思考合并成一条
      else pushTimeline(s, { ms, kind: 'thinking', tool: null, detail });
      if (!(s.lastEvent && s.lastEvent.kind === STEP.THINKING)) s.lastEvent = { kind: STEP.THINKING, tool: null, detail, parallel: 0, ms };
      else if (!s.lastEvent.detail && detail) s.lastEvent.detail = detail;
      return;
    }
    case 'custom_tool_call':
    case 'function_call':
    case 'local_shell_call':
    case 'tool_search_call': {
      markOutput(s);
      const callId = str(p.call_id) || str(p.id);
      const call = describeCodexCall(p);
      call.ms = ms;
      call.callId = callId;
      if (call.name === 'wait' && call.cellId != null) call.cell = s.cells.get(call.cellId) || null;
      if (callId) {
        // 同一 call_id 重复写（已经有结果的）不再挂起
        if (!s.callIds.has(callId)) { s.callIds.add(callId); s.toolCalls++; s.pending.set(callId, call); }
        else if (s.pending.has(callId)) s.pending.set(callId, call);
      } else s.toolCalls++;
      const eff = call.cell || call;
      s.lastEvent = { kind: STEP.TOOL, tool: eff.tool, detail: eff.detail, parallel: eff.parallel || 1, ms };
      // wait 只是在等已知代码单元的输出，时间线里不重复记一次
      if (!call.cell) pushTimeline(s, { ms, kind: 'tool', tool: call.tool, detail: call.detail });
      return;
    }
    case 'custom_tool_call_output':
    case 'function_call_output':
    case 'tool_search_output': {
      const callId = str(p.call_id);
      const call = callId ? s.pending.get(callId) : null;
      if (callId) s.pending.delete(callId);
      const text = outputText(p.output);
      const head = text.split('\n', 1)[0] || '';
      const eff = call ? (call.cell || call) : null;
      const running = RUNNING_CELL_RE.exec(head);
      if (call && call.name === 'wait' && call.cellId != null && !running) s.cells.delete(call.cellId);
      if (running && eff) s.cells.set(running[1], eff); // 代码单元还在跑：记下它是哪个工具
      const tool = eff ? eff.tool : null;
      if (FAILED_SCRIPT_RE.test(head)) {
        const rest = text.slice(head.length);
        pushError(s, ms, tool, firstLine(rest) || null);
      } else if (!running) {
        pushTimeline(s, { ms, kind: 'toolDone', tool, detail: null });
        // legacy 线程没有 patch_apply_end 时，退回解析 apply_patch 输入里的补丁头
        if (eff && eff.patch && eff.patch.length && !s.sawPatchEnd && s.meta && s.meta.historyMode === 'legacy') {
          for (const f of eff.patch) addFile(s, ms, f.path, f.op, f.movedTo);
        }
      }
      s.lastEvent = { kind: STEP.TOOL_RESULT, tool, detail: eff ? eff.detail : null, parallel: 0, ms };
      return;
    }
    case 'web_search_call': {
      markOutput(s);
      const q = p.action && typeof p.action.query === 'string' ? oneLine(p.action.query) : null;
      pushTimeline(s, { ms, kind: 'tool', tool: 'web_search', detail: q });
      return;
    }
    case 'compaction':
    case 'context_compaction': onCompact(s, ms); return;
    default: return;
  }
}

// 格式变了、某一行结构不对时只跳过这一行，不让整次扫描出错（§10.1 风险 1）
function safeIngest(s, e) {
  try { ingestCodex(s, e); } catch { s.badLines = (s.badLines || 0) + 1; }
}

// ---------------------------------------------------------------------------
// 状态判定（§4.6 + 决定 4 + §11.1）
// ---------------------------------------------------------------------------

// 额度快照此刻是否仍在上限：有用满的窗口时看它们是否还没到重置时间；
// 没有用满的窗口、只有 rate_limit_reached_type（如额度点数用完）时，没有重置时间可看，按仍在上限算
function limitReachedNow(rl, rlMs, now) {
  if (!rl || !quotaLib.codexLimitReached(rl)) return false;
  const full = quotaLib.codexWindows(rl, rlMs).filter((w) => w.usedPct >= 100);
  if (full.length) return full.some((w) => w.resetsAtMs == null || w.resetsAtMs > now);
  return typeof rl.rate_limit_reached_type === 'string' && !!rl.rate_limit_reached_type;
}

function pendingList(s) {
  const out = [];
  for (const c of s.pending.values()) out.push({ tool: guessToolOf(c), sinceMs: c.cell ? c.cell.ms : c.ms, call: c });
  return out;
}

/**
 * 线程状态 → AgentStatus。
 * @param {ReturnType<typeof newThreadState>} s
 * @param {{ now: number, mtimeMs?: number, staleMs: number, isMain?: boolean, childWorking?: boolean,
 *   reviewerWorking?: boolean, approvalGuess?: string, approvalGuessSeconds?: number, staleMinutes?: number,
 *   accountRl?: { rl: any, ms: number }|null }} o
 * @returns {import('../core/status').AgentStatus}
 */
function classifyThread(s, o) {
  const now = o.now;
  const lastActivity = Math.max(s.lastTs || 0, o.mtimeMs || 0);
  // 额度快照：本线程的，或更新的账号级快照
  let rl = s.rateLimits;
  let rlMs = s.rateLimitsMs;
  if (o.accountRl && o.accountRl.rl && (!rl || o.accountRl.ms > rlMs)) { rl = o.accountRl.rl; rlMs = o.accountRl.ms; }

  const t = s.openTurn;
  const end = s.lastTurnEnd;
  if (!t) {
    if (end && end.kind === 'complete' && end.error) {
      const info = end.error.info;
      const kind = quotaLib.codexErrorKind(info);
      if (kind === 'usage_limit_exceeded') {
        return makeStatus(STATUS.QUOTA, end.ms, { quota: quotaLib.codexQuotaHit(rl, rlMs, { kind: 'window', source: 'turnError' }) });
      }
      return makeStatus(STATUS.API_ERROR, end.ms, {
        error: { kind: kind || 'unknown', http: quotaLib.codexErrorHttp(info), message: firstLine(end.error.message) },
      });
    }
    if (end && end.kind === 'aborted') {
      if (end.reason === 'budget_limited') {
        return makeStatus(STATUS.QUOTA, end.ms, {
          quota: { kind: 'spend', model: null, resetsAtMs: null, resetsText: null, source: 'turnError', autoContinue: false },
        });
      }
      if (end.reason === 'replaced' || end.reason === 'review_ended') return doneStatus(end.ms, o);
      return makeStatus(STATUS.INTERRUPTED, end.ms);
    }
    if (end) return doneStatus(end.ms, o);
    // 只有 session_meta：启动中，超时算 stale
    if (now - lastActivity > o.staleMs) return makeStatus(STATUS.STALE, lastActivity);
    return makeStatus(STATUS.STARTING, (s.meta && s.meta.timestampMs) || s.firstTs || lastActivity);
  }

  const stale = now - lastActivity > o.staleMs;
  // 撞了上限且不再写记录：判 quota 而不是 stale【推断 §4.6】
  if (stale && limitReachedNow(rl, rlMs, now)) {
    return makeStatus(STATUS.QUOTA, lastActivity, { quota: quotaLib.codexQuotaHit(rl, rlMs, { kind: 'window', source: 'rateLimits' }) });
  }
  const pend = pendingList(s);
  // 决定 4：快工具发出后久无结果 → 可能在等你批准（Codex 没有登记表，hasRegistry 恒为 false）；在 stale 之前判。
  // 两种情况不推测：approval_policy 为 never（Codex 不会弹批准）；审阅线程正在审（等的是它，不是你）。
  const canAsk = s.approvalPolicy !== 'never' && !o.reviewerWorking;
  const hit = canAsk && guessAwaitingApproval({
    provider: PROVIDER,
    pending: pend.map((x) => ({ tool: x.tool, sinceMs: x.sinceMs })),
    now,
    mode: o.approvalGuess || APPROVAL_GUESS.FAST_TOOLS,
    seconds: o.approvalGuessSeconds ?? APPROVAL_GUESS_DEFAULT_SECONDS,
    staleMinutes: o.staleMinutes ?? o.staleMs / 60e3,
    hasRegistry: false,
  });
  if (hit) return makeStatus(STATUS.MAYBE_AWAITING_APPROVAL, hit.sinceMs, { pendingTool: hit.tool });
  const latest = pend.length ? pend.reduce((a, b) => (b.call.ms >= a.call.ms ? b : a)) : null;
  if (stale) {
    return makeStatus(STATUS.STALE, lastActivity, {
      stalePending: pend.length > 0,
      pendingTool: latest ? latest.tool : null,
    });
  }
  if (latest) return makeStatus(STATUS.TOOL, latest.sinceMs, { pendingTool: latest.tool });
  if (!t.modelOutput) return makeStatus(STATUS.STARTING, t.startedMs);
  return makeStatus(STATUS.THINKING, (s.lastEvent && s.lastEvent.ms) || t.startedMs);
}

function doneStatus(ms, o) {
  // 主线程这一轮结束了、但子线程还在跑 → idleBackground
  return makeStatus(o.isMain && o.childWorking ? STATUS.IDLE_BACKGROUND : STATUS.DONE, ms);
}

/**
 * 当前步骤（§2.6）。
 * @param {ReturnType<typeof newThreadState>} s
 * @returns {import('../core/status').Step|null}
 */
function stepOf(s) {
  if (s.pending.size) {
    let latest = null;
    let parallel = 0;
    for (const c of s.pending.values()) {
      const eff = c.cell || c;
      parallel += eff.parallel || 1;
      if (!latest || c.ms >= latest.ms) latest = c;
    }
    const eff = latest.cell || latest;
    return { kind: STEP.TOOL, tool: eff.tool, detail: eff.detail || null, parallel, sinceMs: eff.ms };
  }
  const ev = s.lastEvent;
  if (!ev) return null;
  return {
    kind: ev.kind === STEP.TOOL ? STEP.TOOL_RESULT : ev.kind,
    tool: ev.tool || null,
    detail: ev.detail || null,
    parallel: 0,
    sinceMs: ev.ms,
  };
}

// session_meta → Session.entry（§2.8）
function entryOf(meta) {
  const o = (meta && meta.originator) || '';
  if (/desktop/i.test(o)) return 'desktop';
  if (/vscode/i.test(o)) return 'vscode';
  const src = meta && meta.source;
  if (src === 'cli') return 'cli';
  if (src === 'exec') return 'exec';
  if (src === 'vscode') return 'vscode';
  return 'other';
}

function agentKindOf(meta, asMain) {
  if (asMain) return 'main';
  return meta && meta.reviewer ? 'codexReviewer' : 'codexSubagent';
}

// ---------------------------------------------------------------------------
// 发现 rollout（§4.4）
// ---------------------------------------------------------------------------

function listDirents(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; }
}

function statRollouts(dir) {
  const out = [];
  for (const f of listDirents(dir)) {
    if (!f.isFile() && !f.isSymbolicLink()) continue;
    const m = ROLLOUT_RE.exec(f.name);
    if (!m) continue;
    const file = path.join(dir, f.name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    out.push({ id: m[1].toLowerCase(), file, mtimeMs: st.mtimeMs, size: st.size });
  }
  return out;
}

// 从文件末尾往前找最近一条带 rate_limits 的 token_count（只读最后 512KB）
function readLatestRateLimits(file, size) {
  let fd;
  try {
    const len = Math.min(size, RL_TAIL_BYTES);
    if (!(len > 0)) return null;
    const buf = Buffer.allocUnsafe(len);
    fd = fs.openSync(file, 'r');
    const got = fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8', 0, got).split('\n');
    if (len < size) lines.shift(); // 第一行可能是半行
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.includes('"rate_limits":{')) continue;
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      const p = e && e.payload;
      if (p && p.type === 'token_count' && p.rate_limits && typeof p.rate_limits === 'object') {
        return { rl: p.rate_limits, ms: tsOf(e.timestamp) || 0 };
      }
    }
  } catch { /* 读不到就算了 */ } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
  }
  return null;
}

// session_index.jsonl：{ id, thread_name, updated_at }，同一 id 取最后一条
function ingestIndex(map, e) {
  if (e && typeof e.id === 'string' && typeof e.thread_name === 'string') {
    const name = e.thread_name.trim();
    if (name) map.set(e.id.toLowerCase(), name);
    else map.delete(e.id.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Codex provider。用法（worker / 终端版）：
 *   const p = new CodexProvider({ home, activeWindowMinutes, staleMinutes, limits, approvalGuess, approvalGuessSeconds });
 *   const sessions = p.scan(now);          // Session[]，已按活动窗口过滤，按 updatedMs 降序
 *   const q = p.quota();                   // QuotaSnapshot.codex（账号级，取所有 rollout 里最新的 rate_limits）
 *   const d = p.details(keys, now);        // { [sessionKey]: SessionDetail }，只给 scan 里出现过的会话
 */
class CodexProvider {
  /**
   * @param {{ home?: string, codex?: { home?: string }, activeWindowMinutes?: number, staleMinutes?: number,
   *   limits?: Partial<typeof DEFAULT_LIMITS>, approvalGuess?: 'fastTools'|'allTools'|'off', approvalGuessSeconds?: number,
   *   env?: Record<string, string|undefined> }} [opts]
   *   也接受整个 WorkerConfig（从 opts.codex.home 取路径）。
   */
  constructor(opts = {}) {
    const env = opts.env || process.env;
    this.home = opts.home || (opts.codex && opts.codex.home) || env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.sessionsDir = path.join(this.home, 'sessions');
    this.windowMs = (opts.activeWindowMinutes ?? 30) * 60e3;
    this.staleMinutes = opts.staleMinutes ?? 5;
    this.staleMs = this.staleMinutes * 60e3;
    this.approvalGuess = opts.approvalGuess || APPROVAL_GUESS.FAST_TOOLS;
    this.approvalGuessSeconds = opts.approvalGuessSeconds ?? APPROVAL_GUESS_DEFAULT_SECONDS;
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    this.index = new JsonlTail(path.join(this.home, 'session_index.jsonl'), () => new Map(), ingestIndex);
    this.models = new Map();
    this.modelsMtime = -1;
    this.config = {};
    this.configMtime = -1;
    this.files = new Map();     // 线程 id -> { id, file, mtimeMs, size }（所有 rollout，找父线程用）
    this.dirs = new Map();      // 日期目录 -> { scannedMs, entries }
    this.threads = new Map();   // 线程 id -> JsonlTail（只读窗口内的，和它们需要的父线程）
    this.startedMs = new Map(); // 线程 id -> 稳定的开始时间（§11.3）
    this.firstSeen = new Map(); // 线程 id -> 第一次看到的时间
    this.latestRl = null;       // { rl, ms } 读过的线程里最新的 rate_limits
    this.rlFallback = null;     // { file, size, rl, ms } 窗口内没有线程时从最新 rollout 末尾取
    this.built = new Map();     // sessionKey -> { rootId, childIds }（上一次 scan 的结果，details 用）
    this.lastDiscover = -Infinity;
    this.lastFullScan = -Infinity;
  }

  // ---------- 辅助文件 ----------

  refreshAux() {
    this.index.poll();
    const mc = path.join(this.home, 'models_cache.json');
    const mt = mtimeOf(mc);
    if (mt !== this.modelsMtime) { this.modelsMtime = mt; this.models = contextLib.readCodexModelsCache(mc); }
    const cf = path.join(this.home, 'config.toml');
    const ct = mtimeOf(cf);
    if (ct !== this.configMtime) { this.configMtime = ct; this.config = contextLib.readCodexConfig(cf); }
  }

  // ---------- 发现 ----------

  discover(now) {
    this.lastDiscover = now;
    const days = [];
    for (const y of listDirents(this.sessionsDir)) {
      if (!y.isDirectory()) continue;
      const yd = path.join(this.sessionsDir, y.name);
      for (const m of listDirents(yd)) {
        if (!m.isDirectory()) continue;
        const md = path.join(yd, m.name);
        for (const d of listDirents(md)) if (d.isDirectory()) days.push(path.join(md, d.name));
      }
    }
    days.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // 新日期在前
    const many = this.files.size > MANY_FILES;
    const full = !many || now - this.lastFullScan >= COLD_DIR_MS;
    if (full) this.lastFullScan = now;
    const seen = new Set();
    const scanDir = (dir, force) => {
      seen.add(dir);
      let c = this.dirs.get(dir);
      if (!c || force) { c = { scannedMs: now, entries: statRollouts(dir) }; this.dirs.set(dir, c); }
      return c.entries;
    };
    const files = new Map();
    const put = (x) => { const old = files.get(x.id); if (!old || x.mtimeMs > old.mtimeMs) files.set(x.id, x); };
    // 老版本可能直接放在 sessions/ 下
    for (const x of scanDir(this.sessionsDir, true)) put(x);
    days.forEach((dir, i) => { for (const x of scanDir(dir, full || i < HOT_DAYS)) put(x); });
    for (const k of [...this.dirs.keys()]) if (!seen.has(k)) this.dirs.delete(k);
    // 正在读的线程：stat 结果以读取器为准（更新更及时）
    for (const [id, tail] of this.threads) {
      const x = files.get(id);
      if (x && tail.mtimeMs > x.mtimeMs) x.mtimeMs = tail.mtimeMs;
    }
    this.files = files;
  }

  // ---------- 读取器 ----------

  track(id, now = Date.now()) {
    let tail = this.threads.get(id);
    if (tail) return tail;
    const f = this.files.get(id);
    if (!f) return null;
    const limits = this.limits;
    tail = new JsonlTail(f.file, () => newThreadState(limits, id), safeIngest);
    this.threads.set(id, tail);
    if (!this.firstSeen.has(id)) remember(this.firstSeen, id, now);
    return tail;
  }

  pollThread(tail) {
    tail.poll();
    const f = this.files.get(tail.state.fileId);
    if (f && tail.mtimeMs) f.mtimeMs = tail.mtimeMs;
    const s = tail.state;
    if (s.rateLimits && (!this.latestRl || s.rateLimitsMs > this.latestRl.ms)) this.latestRl = { rl: s.rateLimits, ms: s.rateLimitsMs };
  }

  // 稳定的开始时间：session_meta.timestamp → 第一行时间 → 第一次看到的时间；定下来就不再变（§11.3）
  stableStart(id, s, now) {
    const known = this.startedMs.get(id);
    if (known != null) return known;
    const v = (s.meta && s.meta.timestampMs) || s.firstTs || this.firstSeen.get(id) || now;
    return remember(this.startedMs, id, v);
  }

  /**
   * 扫一次，返回窗口内的会话。
   * @param {number} [now]
   * @param {{ keepKeys?: Iterable<string> }} [opts] keepKeys：即使超出活动窗口也保留的会话（如当前选中的）
   * @returns {import('../core/status').Session[]}
   */
  scan(now = Date.now(), opts = {}) {
    if (now - this.lastDiscover >= DISCOVER_MS || now < this.lastDiscover) this.discover(now);
    this.refreshAux();
    const keep = new Set();
    for (const k of opts.keepKeys || []) {
      const pk = parseSessionKey(k);
      if (pk && pk.provider === PROVIDER) keep.add(pk.id.toLowerCase());
    }

    // 1. 窗口内的 rollout 都读；文件已经不在的释放掉
    for (const id of [...this.threads.keys()]) if (!this.files.has(id)) this.threads.delete(id);
    for (const [id, f] of this.files) {
      if (now - f.mtimeMs < this.windowMs || keep.has(id)) this.track(id, now);
    }
    for (const tail of this.threads.values()) this.pollThread(tail);

    // 2. 子线程的根 / 父线程不在读的就补读（父线程不在窗口内也要纳入，§4.8）
    const rootOf = new Map();
    for (let round = 0; round < 4; round++) {
      let added = false;
      for (const [id, tail] of this.threads) {
        if (rootOf.has(id)) continue;
        const m = tail.state.meta;
        if (!m || (!m.rootId && !m.parentId)) { rootOf.set(id, id); continue; }
        const cands = [m.rootId, m.parentId].filter(Boolean).map((x) => x.toLowerCase());
        let root = null;
        for (const c of cands) {
          if (this.threads.has(c)) { root = c; break; }
          if (this.files.has(c)) { const t = this.track(c, now); this.pollThread(t); root = c; added = true; break; }
        }
        rootOf.set(id, root || id); // 找不到父线程：单独成会话
      }
      if (!added) break;
    }
    // 根线程自己也是子线程（多层）：一路往上找
    const finalRoot = (id) => {
      let r = id;
      for (let i = 0; i < 8; i++) { const n = rootOf.get(r); if (!n || n === r) break; r = n; }
      return r;
    };

    // 3. 按根分组
    const groups = new Map(); // rootId -> childIds[]
    for (const [id, tail] of this.threads) {
      const s = tail.state;
      if (!s.meta && s.firstTs == null) continue; // 还没写出任何行
      const r = finalRoot(id);
      if (!groups.has(r)) groups.set(r, []);
      if (r !== id) groups.get(r).push(id);
    }

    // 4. 生成会话；窗口外的会话、没用上的读取器释放掉
    const out = [];
    const used = new Set();
    this.built = new Map();
    const accountRl = this.accountRl();
    for (const [rootId, childIdsAll] of groups) {
      const rootTail = this.threads.get(rootId);
      if (!rootTail) continue;
      const rs = rootTail.state;
      if (rs.meta && rs.meta.hidden) continue;
      const childIds = childIdsAll.filter((cid) => {
        const t = this.threads.get(cid);
        return t && (now - t.mtimeMs < this.windowMs || keep.has(cid)) && !(t.state.meta && t.state.meta.hidden);
      });
      const updatedMs = Math.max(rootTail.mtimeMs || 0, ...childIds.map((cid) => this.threads.get(cid).mtimeMs || 0));
      if (!(now - updatedMs < this.windowMs) && !keep.has(rootId)) continue;
      const session = this.buildSession(rootId, childIds, now, updatedMs, accountRl);
      out.push(session);
      used.add(rootId);
      for (const c of childIds) used.add(c);
      this.built.set(session.key, { rootId, childIds });
    }
    for (const id of [...this.threads.keys()]) {
      const f = this.files.get(id);
      const inWindow = f && now - f.mtimeMs < this.windowMs;
      if (!used.has(id) && !inWindow && !keep.has(id)) this.threads.delete(id);
    }
    out.sort((a, b) => b.updatedMs - a.updatedMs || (a.key < b.key ? -1 : 1));
    return out;
  }

  accountRl() {
    let best = this.latestRl;
    // 读过的线程里没有更新的额度快照：从最新的 rollout 末尾补一条（窗口内没有线程时）
    let newest = null;
    for (const f of this.files.values()) if (!newest || f.mtimeMs > newest.mtimeMs) newest = f;
    if (newest && !this.threads.has(newest.id) && (!best || newest.mtimeMs > best.ms)) {
      const fb = this.rlFallback;
      if (!fb || fb.file !== newest.file || fb.size !== newest.size) {
        const r = readLatestRateLimits(newest.file, newest.size);
        this.rlFallback = { file: newest.file, size: newest.size, rl: r ? r.rl : null, ms: r ? r.ms : 0 };
      }
    }
    const fb = this.rlFallback;
    if (fb && fb.rl && (!best || fb.ms > best.ms)) best = { rl: fb.rl, ms: fb.ms };
    return best;
  }

  classifyOpts(now, mtimeMs, isMain, childWorking, accountRl, reviewerWorking = false) {
    return {
      now, mtimeMs, staleMs: this.staleMs, isMain, childWorking, reviewerWorking,
      approvalGuess: this.approvalGuess, approvalGuessSeconds: this.approvalGuessSeconds,
      staleMinutes: this.staleMinutes, accountRl,
    };
  }

  /** @returns {any} Agent；另把 ctx（codexContext 的结果）挂在不可枚举的 _ctx 上，给会话级字段用 */
  buildAgent(id, tail, kind, now, st) {
    const s = tail.state;
    const model = modelNow(s);
    const info = s.tokenInfo;
    const last = info && info.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : null;
    const used = last ? int(last.total_tokens) : 0;
    const ctx = contextLib.codexContext(
      { model, contextUsed: used, modelContextWindow: (info && info.model_context_window) || s.ctxWindowHint || null },
      this.models, this.config,
    );
    const u = s.usage;
    const m = s.meta || {};
    const agent = {
      id,
      kind,
      name: kind === 'main' ? null : m.nickname || null,
      agentType: m.role || null,
      phase: null,
      background: false,
      model,
      status: st,
      step: stepOf(s),
      tokens: {
        display: used,
        contextUsed: used,
        contextWindow: ctx.contextWindow,
        compactAt: ctx.compactAt,
        toCompact: ctx.toCompact,
        contextPct: ctx.contextPct,
        output: u.output,
        processed: u.processed,
        apiCalls: u.apiCalls,
      },
      toolCalls: s.toolCalls,
      toolErrors: s.toolErrors,
      filesChanged: s.files.size,
      costUsd: u.pricedAny ? u.costUsd : (u.unpricedTokens > 0 ? null : 0),
      costEstimated: u.estimated,
      unpricedModel: u.unpricedTokens > 0 ? u.unpricedModel : null,
      lastCompact: s.lastCompact ? { ...s.lastCompact, contextWindow: ctx.contextWindow } : null,
      cacheTtl: null,
      startedMs: this.stableStart(id, s, now),
      lastActivityMs: Math.max(s.lastTs || 0, tail.mtimeMs || 0),
      lastApiMs: s.lastApiMs,
      mtimeMs: tail.mtimeMs || 0,
      file: tail.file,
    };
    Object.defineProperty(agent, '_ctx', { value: ctx, enumerable: false });
    return agent;
  }

  buildSession(rootId, childIds, now, updatedMs, accountRl) {
    const rootTail = this.threads.get(rootId);
    const rs = rootTail.state;
    const meta = rs.meta || {};
    const agents = [];
    for (const cid of childIds) {
      const t = this.threads.get(cid);
      const st = classifyThread(t.state, this.classifyOpts(now, t.mtimeMs, false, false, accountRl));
      agents.push(this.buildAgent(cid, t, agentKindOf(t.state.meta, false), now, st));
    }
    // §11.3：按开始时间正序，先开始的在上面
    agents.sort((a, b) => (a.startedMs - b.startedMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const childWorking = agents.some((a) => isRunningCode(a.status.code) || isNeedsYouCode(a.status.code));
    const reviewerWorking = agents.some((a) => a.kind === 'codexReviewer' && isRunningCode(a.status.code));
    const mainSt = classifyThread(rs, this.classifyOpts(now, rootTail.mtimeMs, true, childWorking, accountRl, reviewerWorking));
    const main = this.buildAgent(rootId, rootTail, 'main', now, mainSt);

    const idxName = this.index.state.get(rootId);
    let title;
    let titleSource;
    if (idxName) { title = idxName; titleSource = 'index'; }
    else if (rs.firstPrompt || rs.fallbackPrompt) { title = oneLine(rs.firstPrompt || rs.fallbackPrompt, 40); titleSource = 'prompt'; }
    else { title = rootId.slice(0, 8); titleSource = 'id'; }

    const all = [main, ...agents];
    const counts = { running: 0, awaiting: 0, error: 0, done: 0, total: all.length };
    let cost = null;
    let unpricedModel = null;
    for (const a of all) {
      const c = a.status.code;
      if (isRunningCode(c)) counts.running++;
      else if (isNeedsYouCode(c)) counts.awaiting++;
      else if (isErrorCode(c)) counts.error++;
      else if (c === STATUS.DONE) counts.done++;
      if (a.costUsd != null) cost = (cost || 0) + a.costUsd;
      if (!unpricedModel && a.unpricedModel) unpricedModel = a.unpricedModel;
    }
    const live = !!rs.openTurn;
    const session = {
      key: sessionKey(PROVIDER, rootId),
      provider: PROVIDER,
      id: rootId,
      title,
      titleSource,
      cwd: rs.cwd || meta.cwd || null,
      projectDir: null,
      entry: entryOf(meta),
      entryRaw: meta.originator || (typeof meta.source === 'string' ? meta.source : null),
      entrypoint: null,
      version: meta.cliVersion || null,
      model: main.model,
      createdMs: meta.timestampMs || rs.firstTs || null,
      updatedMs,
      startedMs: main.startedMs,
      doneAtMs: rs.lastDoneMs,
      // §11.1：Codex 没有登记表，“打开中”= 有进行中的回合
      live,
      liveStatus: live ? (mainSt.code === STATUS.MAYBE_AWAITING_APPROVAL ? 'waiting' : 'busy') : null,
      waitingFor: null,
      compactCount: rs.compactCount,
      compactLoop: compactLoopOf(rs.compactTimes, main.lastActivityMs),
      // 与 Claude 会话同名的便捷字段；Codex 的缓存保留时长没有可靠依据，缓存相关一律 null（§11.7）
      contextUsed: main.tokens.contextUsed,
      modelVariant: null,
      contextWindow: main.tokens.contextWindow,
      contextWindowSource: main._ctx.contextWindowSource, // §11.10：记录里的 model_context_window → codex-record
      compactAt: main.tokens.compactAt,
      compactAtSource: main._ctx.compactAtSource,
      autoCompactWindow: null,
      contextPct: main.tokens.contextPct,
      cacheTtl: null,
      cacheTtlInferred: false,
      cacheTtlMs: null,
      lastApiMs: main.lastApiMs,
      cacheExpiresMs: null,
      lastActivityMs: main.lastActivityMs,
      main,
      agents,
      workflows: [],
      counts,
      costUsd: cost,
      unpricedModel,
      ccCostUsd: null,
      transcript: rootTail.file,   // §11.11 主线程 rollout
      resume: [],
    };
    session.resume = resumeHints(session, { now });
    return session;
  }

  /**
   * 细节（§5）：只给上一次 scan 里出现过的会话。只用内存里的状态，不重读文件。
   * @param {string} idOrKey 线程 id 或 'codex:<id>'
   * @returns {import('../core/status').SessionDetail|null}
   */
  detail(idOrKey) {
    const key = keyOf(idOrKey);
    const b = key && this.built.get(key);
    if (!b) return null;
    const agents = {};
    for (const id of [b.rootId, ...b.childIds]) {
      const t = this.threads.get(id);
      if (!t) continue;
      const s = t.state;
      const sent = this.limits.timelineSent;
      agents[id] = {
        timeline: s.timeline.slice(-sent).map((e) => ({ ms: e.ms, kind: e.kind, tool: e.tool || null, detail: e.detail || null })),
        result: s.result ? { ...s.result } : null,
        files: [...s.files.values()].sort((a, c) => c.lastMs - a.lastMs).map((f) => ({ ...f })),
        errors: s.errors.map((e) => ({ ...e })),
      };
    }
    return { key, agents };
  }

  /**
   * @param {Iterable<string>} keys
   * @returns {Record<string, import('../core/status').SessionDetail>}
   */
  details(keys) {
    const out = {};
    for (const k of keys || []) {
      const d = this.detail(k);
      if (d) out[d.key] = d;
    }
    return out;
  }

  /** 上一次 scan 里有没有这个会话 */
  has(idOrKey) {
    const key = keyOf(idOrKey);
    return !!key && this.built.has(key);
  }

  /** 账号级额度快照（§4.7）：所有 rollout 里时间戳最新的 rate_limits */
  quota() {
    const best = this.accountRl();
    return best && best.rl ? quotaLib.codexQuota(best.rl, best.ms) : quotaLib.emptyQuotaSnapshot().codex;
  }

  dispose() {
    this.threads.clear();
    this.files.clear();
    this.dirs.clear();
    this.built.clear();
  }
}

function mtimeOf(f) {
  try { return fs.statSync(f).mtimeMs; } catch { return 0; }
}

// 'codex:<id>' 或裸 id → 会话 key；别的 provider 的 key 返回 null
function keyOf(idOrKey) {
  if (typeof idOrKey !== 'string' || !idOrKey) return null;
  const pk = parseSessionKey(idOrKey);
  if (pk && pk.provider === PROVIDER) return sessionKey(PROVIDER, pk.id.toLowerCase());
  if (pk) return null;
  return sessionKey(PROVIDER, idOrKey.toLowerCase());
}

module.exports = {
  PROVIDER, DEFAULT_LIMITS, ROLLOUT_RE,
  CodexProvider,
  // 下面这些导出给测试和其它模块复用
  newThreadState, ingestCodex, classifyThread, stepOf, entryOf, agentKindOf, metaOf,
  describeCodexCall, describeExecCode, parsePatchHeaders, guessToolOf, ingestIndex, readLatestRateLimits, limitReachedNow,
  oneLine, shortPath,
};
