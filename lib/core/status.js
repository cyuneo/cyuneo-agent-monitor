'use strict';
// 全部模块共用的常量与数据模型（DESIGN §2、§3、§11.1、决定 4、决定 5）。
// 只有代码、数字、映射，不含任何界面文字；文字在 l10n 词典里，由 format 层拼。

// ---------------------------------------------------------------------------
// 数据模型 v2（JSDoc）。时间一律 epoch 毫秒；token 整数；金额美元浮点；null = 不知道/没有价。
// ---------------------------------------------------------------------------

/** @typedef {'claude'|'codex'} Provider */

/** @typedef {'starting'|'thinking'|'tool'|'retrying'
 *  |'awaitingApproval'|'awaitingInput'|'dialogOpen'|'maybeAwaitingApproval'
 *  |'idleBackground'|'done'|'interrupted'|'stale'|'killed'|'quota'|'apiError'} StatusCode */

/** @typedef {{ kind: 'session'|'weekly'|'model'|'spend'|'window'|'unknown',
 *  model: string|null, resetsAtMs: number|null, resetsText: string|null,
 *  source: 'quotaLimits'|'text'|'rateLimits'|'turnError', autoContinue: boolean|null }} QuotaHit */

/** @typedef {{
 *  code: StatusCode,
 *  sinceMs: number,                    // 进入该状态的时间
 *  pendingTool: string|null,           // tool / stale / maybeAwaitingApproval 时正在等的工具名（原始名）
 *  stalePending: boolean,              // stale 且有未完成的工具调用
 *  retry: { attempt: number, max: number, inMs: number|null }|null,
 *  quota: QuotaHit|null,
 *  error: { kind: string, http: number|null, message: string|null }|null,  // message 为报错原文首行 ≤200 字
 *  question: 'askUser'|'planApproval'|null,   // awaitingInput 的原因（记录里看出来的）
 *  certainty: 'certain'|'guess',       // NeedsYou 类状态的来源：登记表/记录里确定的，还是推测的
 *  waitingFor: string|null             // 登记表原文：'permission prompt' | 'input needed' | 'dialog open'
 * }} AgentStatus */

/** @typedef {{
 *  kind: 'tool'|'toolResult'|'thinking'|'text'|'prompt'|'compact'|'none',
 *  tool: string|null, detail: string|null, parallel: number, sinceMs: number|null
 * }} Step */

/** @typedef {{
 *  display: number, contextUsed: number,
 *  contextWindow: number|null, compactAt: number|null, toCompact: number|null,
 *  contextPct: number|null,     // §11.10 Claude Code 的公式：round(contextUsed / contextWindow × 100)，夹在 0–100；窗口不知道时 null
 *  output: number, processed: number, apiCalls: number
 * }} AgentTokens */

/** @typedef {{
 *  ms: number, trigger: 'auto'|'manual'|null, preTokens: number|null,
 *  postTokens?: number|null,    // Claude：compactMetadata.postTokens；Codex：压缩后第一条 token_count 的 last_token_usage.total_tokens
 *  model: string|null,          // §11.12.2 压缩时的模型（message.model 原样，不带 [1m]；Codex 为当时 turn_context.model）
 *  contextWindow?: number|null  // 该模型在本会话里的窗口（学习实测压缩点的键 `${model}|${contextWindow}` 用）
 * }} LastCompact */

/** @typedef {{
 *  id: string,                  // Claude：'main' 或 agentId；Codex：线程 id
 *  kind: 'main'|'subagent'|'workflowAgent'|'codexSubagent'|'codexReviewer',
 *  name: string|null, agentType: string|null, phase: string|null, background: boolean,
 *  model: string|null,
 *  status: AgentStatus, step: Step|null,
 *  tokens: AgentTokens,
 *  toolCalls: number, toolErrors: number, filesChanged: number,
 *  costUsd: number|null, unpricedModel: string|null,
 *  lastCompact: LastCompact|null,
 *  cacheTtl: '5m'|'1h'|null,    // 最近一次 usage 推出的缓存 TTL（resume / 压缩估价用；Codex 恒 null）
 *  startedMs: number|null, lastActivityMs: number, mtimeMs: number,
 *  file: string
 * }} Agent */

/** @typedef {{
 *  id: string, taskId: string|null, name: string, scriptPath: string|null,
 *  state: 'running'|'paused'|'completed'|'killed'|'stale',
 *  phases: string[], done: number, total: number, running: number,
 *  tokens: number, outTokens: number, costUsd: number|null,
 *  agents: Agent[]
 * }} Workflow */

/** @typedef {{
 *  key: string,                 // `${provider}:${id}`
 *  provider: Provider, id: string,
 *  title: string, titleSource: 'custom'|'ai'|'index'|'prompt'|'id',
 *  cwd: string|null, projectDir: string|null,
 *  entry: 'vscode'|'cli'|'desktop'|'sdk'|'exec'|'other', entryRaw: string|null,
 *  entrypoint: string|null,     // §11.1 登记表的 entrypoint 原文（claude-vscode / cli / claude-desktop …）
 *  model: string|null,
 *  createdMs: number|null, updatedMs: number,
 *  startedMs: number,           // §11.1/§11.3 排序键：记录第一行时间；缺失用第一次看到的时间，之后不变
 *  doneAtMs: number|null,
 *  live: boolean,               // §11.1 登记表里有存活进程（Codex：有进行中的回合）
 *  liveStatus: 'busy'|'waiting'|'idle'|null,
 *  waitingFor: string|null,
 *  version: string|null,        // 记录里的客户端版本
 *  compactCount: number,        // §11.8 第 2 条：主对话里压缩了几次（自动和手动都算）
 *  compactLoop: boolean,        // 最近两次压缩相隔 ≤ 10 分钟且之后没有别的进展（“压缩后 postTokens 仍在建议处理区”依赖界面设置，由界面层另判）
 *  contextUsed: number,         // §11.10 上下文字段以主对话为准，与 main.tokens 的同名字段一致；子智能体看自己的 Agent.tokens
 *  modelVariant: string|null,   // cost-state.modelUsage 里匹配到的键名，例如 'claude-opus-5-5[1m]'；没有 cost-state 时 null
 *  contextWindow: number|null,
 *  contextWindowSource: 'cost-state'|'model-rule'|'codex-record'|null,
 *  compactAt: number|null,      // 实际压缩点（估计）：设定值 − 33K，或实测值；已关时 null
 *  compactAtSource: 'settings-local'|'settings-project'|'settings-user'|'observed'|'default'|'disabled'|null, // Codex：config.toml 取小时 settings-user，否则 default
 *  autoCompactWindow: number|null, // compactAt 由哪个设定值推出（设置取与窗口的较小值；默认 = 窗口）；实测 / 已关 / Codex 为 null
 *  contextPct: number|null,     // Claude Code 的公式（见 AgentTokens.contextPct）
 *  cacheTtl: '5m'|'1h'|null, cacheTtlInferred: boolean, cacheTtlMs: number|null,   // §11.7 缓存，仅 Claude；Codex 全为 null
 *  lastApiMs: number|null, cacheExpiresMs: number|null, lastActivityMs: number,
 *  main: Agent, agents: Agent[], workflows: Workflow[],
 *  counts: { running: number, awaiting: number, error: number, done: number, total: number },
 *  costUsd: number|null,        // 插件按价格表估的本会话等价费用（主+子+工作流）
 *  unpricedModel: string|null,
 *  ccCostUsd: number|null,      // §11.10 cost-state.totalCostUSD：Claude Code 自己算的本会话累计费用；Codex 恒 null
 *  transcript: string,          // §11.11 主记录绝对路径（Claude：<sid>.jsonl；Codex：主线程 rollout）
 *  resume: ResumeHint[]
 * }} Session */

/** @typedef {{ ms: number,
 *  kind: 'prompt'|'thinking'|'tool'|'toolDone'|'toolError'|'text'|'compact'|'quota'|'apiError'|'retry'|'interrupt'|'done',
 *  tool: string|null, detail: string|null }} TimelineEvent */

/** @typedef {{
 *  transcriptBytes: number|null,   // 主记录（Codex：主线程 rollout）
 *  subagentsBytes: number|null,    // Claude：<项目目录>/<sid>/ 目录（子智能体、工作流）；Codex：子线程 rollout 合计
 *  fileHistoryBytes: number|null,  // Claude：<configDir>/file-history/<sid>；Codex 恒 null
 *  transcript: string|null,        // 主记录路径
 *  subagentsDir?: string|null, fileHistoryDir?: string|null,  // Claude：对应目录（lib/storage.js 给出）
 *  at: number                      // 统计时间（每个会话 60 秒最多统计一次）
 * }} SessionStorage */

/** @typedef {{
 *  key: string,
 *  agents: Record<string, {
 *    timeline: TimelineEvent[],
 *    result: { text: string, ms: number, source: 'lastText'|'journal'|'structuredOutput'|'taskComplete' }|null,
 *    files: { path: string, op: 'create'|'edit'|'delete'|'move', count: number, lastMs: number, movedTo: string|null }[],
 *    errors: { ms: number, tool: string|null, text: string }[]
 *  }>,
 *  storage?: SessionStorage|null   // §11.12.3：第一次统计完成前为 null（完成后下一份快照带上）
 * }} SessionDetail */

/** @typedef {{ name: string, path: string, bytes: number|null, files: number|null,
 *  isSymlink: boolean, symlinkTarget: string|null, exists: boolean }} StorageEntry */

/** @typedef {{
 *  at: number,
 *  claude: { dir: string, dirSource: 'env'|'setting'|'default', entries: StorageEntry[] }|null,
 *  codex:  { dir: string, dirSource: 'env'|'setting'|'default', entries: StorageEntry[] }|null,
 *  volumes: { mount: string, freeBytes: number, totalBytes: number }[],
 *  cleanupPeriodDays: number|null,
 *  cached?: boolean,               // worker 返回的是 10 分钟内的缓存
 *  error?: string                  // 统计失败 / lib/storage.js 不可用时才有
 * }} StorageReport */

/** @typedef {{
 *  intervalMs: number, activeWindowMinutes: number, staleMinutes: number,
 *  claude: { enabled: boolean, projectsDir: string, configDir: string, configDirSource: 'env'|'setting'|'default',
 *            home: string, settingsPath: string },   // home = configDir（登记表 sessions/ 的父目录）
 *  codex:  { enabled: boolean, home: string, homeSource: 'env'|'setting'|'default' },
 *  observedCompact: Record<string, number>,           // `${model}|${contextWindow}` → 实测自动压缩点（preTokens）
 *  limits: { timeline: number, timelineSent: number, resultChars: number, filesPerAgent: number, errorsPerAgent: number },
 *  dailyBudgetBytesPerTick: number
 * }} WorkerConfig */

/** @typedef {{ minutes: number, usedPct: number, resetsAtMs: number|null, label: string }} QuotaWindow */

/** @typedef {{
 *  claude: { lastHit: (QuotaHit & { ms: number, sessionKey: string })|null },
 *  codex:  { observedMs: number|null, planType: string|null, limitId: string|null,
 *            windows: QuotaWindow[], reachedType: string|null,
 *            credits: { hasCredits: boolean, unlimited: boolean, balance: string|null }|null }
 * }} QuotaSnapshot */

/** @typedef {{
 *  dayStartMs: number, partial: boolean, progress: number,
 *  claude: { input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number,
 *            costUsd: number, unpricedTokens: number, byModel: Record<string, { tokens: number, costUsd: number|null }> },
 *  codex:  { input: number, cachedInput: number, cacheWrite: number, output: number, reasoning: number,
 *            costUsd: number, unpricedTokens: number, byModel: Record<string, { tokens: number, costUsd: number|null }> }
 * }} DailyTotals */

/** @typedef {{ contextTokens: number, ttl: '5m'|'1h'|'unknown', cacheLikelyExpired: boolean|null,
 *  usdIfMiss: number|null, usdIfHit: number|null }} ResumeEstimate */

/** @typedef {(
 *  { kind: 'claudeSession', sessionId: string, cwd: string|null, entry: string|null, autoContinue: boolean|null, quota: QuotaHit|null, estimate: ResumeEstimate } |
 *  { kind: 'claudeSubagent', sessionId: string, agentId: string, name: string|null, agentType: string|null, resumable: boolean, estimate: ResumeEstimate } |
 *  { kind: 'claudeWorkflow', sessionId: string, runId: string, workflowName: string, scriptPath: string|null, paused: boolean, estimate: ResumeEstimate } |
 *  { kind: 'codexThread', threadId: string, cwd: string|null, entry: string|null, estimate: ResumeEstimate } |
 *  { kind: 'codexSubagent', parentThreadId: string, threadId: string, nickname: string|null, estimate: ResumeEstimate }
 * )} ResumeHint */

/** @typedef {{
 *  v: 2, now: number, sessions: Session[], quota: QuotaSnapshot, today: DailyTotals,
 *  details: Record<string, SessionDetail>
 * }} Snapshot */

// ---------------------------------------------------------------------------
// §11.10 上下文窗口与自动压缩点的来源代码（界面按代码查词条）
// ---------------------------------------------------------------------------

const WINDOW_SOURCE = Object.freeze({ COST_STATE: 'cost-state', MODEL_RULE: 'model-rule', CODEX_RECORD: 'codex-record' });
const COMPACT_SOURCE = Object.freeze({
  SETTINGS_LOCAL: 'settings-local',     // <cwd>/.claude/settings.local.json
  SETTINGS_PROJECT: 'settings-project', // <cwd>/.claude/settings.json
  SETTINGS_USER: 'settings-user',       // <claudeConfigDir>/settings.json（Codex：config.toml）
  OBSERVED: 'observed',                 // 实测（observedCompact）
  DEFAULT: 'default',                   // 官方默认（窗口 − 33K；Codex 窗口 × 0.9）
  DISABLED: 'disabled',                 // autoCompactEnabled === false
});
// 设置类来源（学习实测压缩点时跳过这些会话：它们的实测值反映的是用户设定，不是默认）
const SETTINGS_SOURCES = new Set([COMPACT_SOURCE.SETTINGS_LOCAL, COMPACT_SOURCE.SETTINGS_PROJECT, COMPACT_SOURCE.SETTINGS_USER]);

// ---------------------------------------------------------------------------
// 状态码
// ---------------------------------------------------------------------------

const STATUS = Object.freeze({
  STARTING: 'starting',
  THINKING: 'thinking',
  TOOL: 'tool',
  RETRYING: 'retrying',
  // 需要你处理：确定的（§11.1 登记表 / 记录里的提问工具）
  AWAITING_APPROVAL: 'awaitingApproval',   // 登记表 waitingFor = 'permission prompt'
  AWAITING_INPUT: 'awaitingInput',         // 登记表 'input needed'，或记录里 AskUserQuestion / ExitPlanMode 未返回
  DIALOG_OPEN: 'dialogOpen',               // 登记表 'dialog open'
  // 需要你处理：推测的（决定 4：快工具发出后久无结果）
  MAYBE_AWAITING_APPROVAL: 'maybeAwaitingApproval',
  IDLE_BACKGROUND: 'idleBackground',
  DONE: 'done',
  INTERRUPTED: 'interrupted',
  STALE: 'stale',
  KILLED: 'killed',
  QUOTA: 'quota',
  API_ERROR: 'apiError',
});

const STATUS_CODES = Object.freeze(Object.values(STATUS));

// 确定的“需要你处理”
const CERTAIN_NEEDS_YOU = new Set([STATUS.AWAITING_APPROVAL, STATUS.AWAITING_INPUT, STATUS.DIALOG_OPEN]);
// 推测的“需要你处理”
const GUESS_NEEDS_YOU = new Set([STATUS.MAYBE_AWAITING_APPROVAL]);
// 算“在跑”的状态码（Working 灯）
const RUNNING_CODES = new Set([STATUS.STARTING, STATUS.THINKING, STATUS.TOOL, STATUS.RETRYING, STATUS.IDLE_BACKGROUND]);
// 出错
const ERROR_CODES = new Set([STATUS.QUOTA, STATUS.API_ERROR]);
// 这一轮已经停下（不会再自己动）
const STOPPED_CODES = new Set([STATUS.DONE, STATUS.INTERRUPTED, STATUS.KILLED, STATUS.QUOTA, STATUS.API_ERROR]);

function isNeedsYouCode(code) { return CERTAIN_NEEDS_YOU.has(code) || GUESS_NEEDS_YOU.has(code); }
function isGuessCode(code) { return GUESS_NEEDS_YOU.has(code); }
function isRunningCode(code) { return RUNNING_CODES.has(code); }
function isErrorCode(code) { return ERROR_CODES.has(code); }

/**
 * 生成一个完整的 AgentStatus，缺的字段补默认值。
 * @param {StatusCode} code
 * @param {number} sinceMs
 * @param {Partial<AgentStatus>} [extra]
 * @returns {AgentStatus}
 */
function makeStatus(code, sinceMs, extra = {}) {
  return {
    code,
    sinceMs: Number.isFinite(sinceMs) ? sinceMs : 0,
    pendingTool: null,
    stalePending: false,
    retry: null,
    quota: null,
    error: null,
    question: null,
    certainty: GUESS_NEEDS_YOU.has(code) ? 'guess' : 'certain',
    waitingFor: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 步骤种类
// ---------------------------------------------------------------------------

const STEP = Object.freeze({
  TOOL: 'tool', TOOL_RESULT: 'toolResult', THINKING: 'thinking', TEXT: 'text',
  PROMPT: 'prompt', COMPACT: 'compact', NONE: 'none',
});

// ---------------------------------------------------------------------------
// §11.1 Claude 在线会话登记表
// ---------------------------------------------------------------------------

const LIVE_STATUS = Object.freeze({ BUSY: 'busy', WAITING: 'waiting', IDLE: 'idle' });
const WAITING_FOR = Object.freeze({ PERMISSION: 'permission prompt', INPUT: 'input needed', DIALOG: 'dialog open' });

/**
 * 登记表 waitingFor → 确定的状态码。未知的 waitingFor 按“等你批准”处理（CLI 里除提问/对话框外都是权限）。
 * @param {string|null} waitingFor
 * @returns {StatusCode}
 */
function codeForWaitingFor(waitingFor) {
  if (waitingFor === WAITING_FOR.INPUT) return STATUS.AWAITING_INPUT;
  if (waitingFor === WAITING_FOR.DIALOG) return STATUS.DIALOG_OPEN;
  return STATUS.AWAITING_APPROVAL;
}

/**
 * 登记表条目 → 主智能体应当覆盖成的状态；不需要覆盖时返回 null。
 * 只有 waiting 会覆盖（确定的 NeedsYou）；busy / idle 交给调用方结合记录判断（§11.1 第 3 条）。
 * @param {{ status?: string, waitingFor?: string|null, statusUpdatedAt?: number, updatedAt?: number }|null} entry
 * @param {number} [fallbackSinceMs]
 * @returns {AgentStatus|null}
 */
function statusFromRegistry(entry, fallbackSinceMs = 0) {
  if (!entry || entry.status !== LIVE_STATUS.WAITING) return null;
  let since = Number(entry.statusUpdatedAt || entry.updatedAt) || fallbackSinceMs;
  if (since > 0 && since < 1e12) since *= 1000; // 万一是 epoch 秒
  const code = codeForWaitingFor(entry.waitingFor || null);
  return makeStatus(code, since, { waitingFor: entry.waitingFor || null, certainty: 'certain' });
}

// ---------------------------------------------------------------------------
// 决定 4：“可能在等你批准”的推测
// ---------------------------------------------------------------------------

// 快工具：正常几秒内就有结果；发出后久无结果，多半是在等权限批准
const FAST_TOOLS = Object.freeze({
  claude: Object.freeze(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'TodoWrite', 'WebFetch']),
  // Codex 的文件读写 / 补丁类工具（exec 代码模式里 tools.<名字> 取出的名字，或老版本的 function_call 名）
  codex: Object.freeze(['apply_patch', 'update_plan', 'view_image', 'read_file', 'list_dir', 'grep_files']),
});
const FAST_TOOL_SETS = {
  claude: new Set(FAST_TOOLS.claude),
  codex: new Set(FAST_TOOLS.codex),
};

const APPROVAL_GUESS = Object.freeze({ FAST_TOOLS: 'fastTools', ALL_TOOLS: 'allTools', OFF: 'off' });
const APPROVAL_GUESS_DEFAULT_SECONDS = 60;

/**
 * @param {Provider} provider
 * @param {string|null} tool 原始工具名
 */
function isFastTool(provider, tool) {
  const set = FAST_TOOL_SETS[provider];
  return !!(set && tool && set.has(tool));
}

/**
 * 决定 4 + §11.1：要不要把“工具发出后久无结果”判成 maybeAwaitingApproval。
 * - mode 'off' → 不判；
 * - 会话在登记表里有信号（hasRegistry）→ 不判（用登记表的确定状态）；
 * - 'fastTools'（默认）：只看快工具，等了 ≥ seconds 秒；
 * - 'allTools'：任何工具，等了 ≥ staleMinutes 分钟。
 * 有多个未完成调用时，任一满足即可。
 * @param {{
 *   provider: Provider,
 *   pending: { tool: string|null, sinceMs: number }[],
 *   now: number,
 *   mode?: 'fastTools'|'allTools'|'off',
 *   seconds?: number,
 *   staleMinutes?: number,
 *   hasRegistry?: boolean
 * }} o
 * @returns {{ tool: string|null, sinceMs: number }|null} 命中的那个调用（最早的）；不判时 null
 */
function guessAwaitingApproval(o) {
  const mode = o.mode || APPROVAL_GUESS.FAST_TOOLS;
  if (mode === APPROVAL_GUESS.OFF || o.hasRegistry) return null;
  if (!Array.isArray(o.pending) || !o.pending.length) return null;
  const waitMs = mode === APPROVAL_GUESS.ALL_TOOLS
    ? Math.max(0, Number(o.staleMinutes ?? 5)) * 60e3
    : Math.max(0, Number(o.seconds ?? APPROVAL_GUESS_DEFAULT_SECONDS)) * 1e3;
  let hit = null;
  for (const p of o.pending) {
    if (!p || !Number.isFinite(p.sinceMs)) continue;
    if (mode !== APPROVAL_GUESS.ALL_TOOLS && !isFastTool(o.provider, p.tool)) continue;
    if (o.now - p.sinceMs < waitMs) continue;
    if (!hit || p.sinceMs < hit.sinceMs) hit = p;
  }
  return hit ? { tool: hit.tool || null, sinceMs: hit.sinceMs } : null;
}

// ---------------------------------------------------------------------------
// 灯（§3）
// ---------------------------------------------------------------------------

const LAMP = Object.freeze({
  NEEDS_YOU: 'needsYou', ERROR: 'error', WORKING: 'working',
  DONE_UNSEEN: 'doneUnseen', DONE_SEEN: 'doneSeen', IDLE: 'idle',
});
const LAMPS = Object.freeze(['needsYou', 'error', 'working', 'doneUnseen', 'doneSeen', 'idle']);

// 会话灯的推导优先级（statuslight derive 顺序）
const DERIVE_ORDER = Object.freeze(['needsYou', 'error', 'working', 'doneUnseen', 'doneSeen', 'idle']);
// 总灯的显示紧急度（statuslight Severity）
const SEVERITY = Object.freeze({ needsYou: 100, error: 80, doneUnseen: 60, working: 40, doneSeen: 20, idle: 10 });

// 颜色贡献点 id（package.json contributes.colors）
const LAMP_COLOR_ID = Object.freeze({
  needsYou: 'agentMonitor.lampNeedsYou',
  error: 'agentMonitor.lampError',
  working: 'agentMonitor.lampWorking',
  doneUnseen: 'agentMonitor.lampDoneUnseen',
  doneSeen: 'agentMonitor.lampDoneSeen',
  idle: 'agentMonitor.lampIdle',
});
// webview 里的 CSS 变量（'--vscode-' + id 里第一个 '.' 换成 '-'）
const LAMP_CSS_VAR = Object.freeze(Object.fromEntries(
  Object.entries(LAMP_COLOR_ID).map(([k, id]) => [k, '--vscode-' + id.replace('.', '-')])));
// §3.5 默认色值（决定 5：沿用 statuslight；浅色、高对比按对比度换过）
const LAMP_COLORS = Object.freeze({
  working:    Object.freeze({ dark: '#00AFFF', light: '#0078D4', highContrast: '#00AFFF', highContrastLight: '#005A9E' }),
  needsYou:   Object.freeze({ dark: '#EE2B7B', light: '#C4004F', highContrast: '#FF3D8B', highContrastLight: '#B0004A' }),
  doneUnseen: Object.freeze({ dark: '#5FFF00', light: '#2E9E00', highContrast: '#5FFF00', highContrastLight: '#1F6F00' }),
  doneSeen:   Object.freeze({ dark: '#008700', light: '#1A5C1A', highContrast: '#3FBF3F', highContrastLight: '#2D5A2D' }),
  error:      Object.freeze({ dark: '#FF0000', light: '#E51400', highContrast: '#FF4D4D', highContrastLight: '#B5200D' }),
  idle:       Object.freeze({ dark: '#808080', light: '#767676', highContrast: '#B0B0B0', highContrastLight: '#5A5A5A' }),
});
// 终端版：statuslight 的 xterm 256 色号
const LAMP_XTERM = Object.freeze({ working: 39, needsYou: 161, doneUnseen: 82, doneSeen: 28, error: 196, idle: 244 });
// 图标形状：实心 / 空心（不只靠颜色区分）
const LAMP_SHAPE = Object.freeze({
  needsYou: 'circle-large-filled', error: 'circle-large-filled', working: 'circle-large-filled',
  doneUnseen: 'circle-large-filled', doneSeen: 'circle-large-outline', idle: 'circle-large-outline',
});
// 说明文字前加的图标（tooltip / a11y）
const LAMP_BADGE_ICON = Object.freeze({ needsYou: 'bell', error: 'error' });

// 状态码 → 灯（done 另看“已看过”，stale 另看选项）
const STATUS_LAMP = Object.freeze({
  starting: 'working', thinking: 'working', tool: 'working', retrying: 'working', idleBackground: 'working',
  awaitingApproval: 'needsYou', awaitingInput: 'needsYou', dialogOpen: 'needsYou', maybeAwaitingApproval: 'needsYou',
  done: 'doneUnseen',
  interrupted: 'idle', killed: 'idle', stale: 'idle',
  quota: 'error', apiError: 'error',
});

/**
 * 单个智能体的灯（§3.2 + 决定 4）。
 * - done：seen 为真 → DoneSeen，否则 DoneUnseen（seen 由调用方按 §3.4 判定后传入）；
 * - stale：默认 Idle。决定 4 之后“等批准”改由 maybeAwaitingApproval 表达，
 *   只有显式传 staleAsNeedsYou 且 stalePending 才算 NeedsYou（兼容 §3.2 的旧设置）。
 * @param {AgentStatus|{ code: StatusCode, stalePending?: boolean }|null} status
 * @param {{ seen?: boolean, staleAsNeedsYou?: boolean }} [opts]
 * @returns {'needsYou'|'error'|'working'|'doneUnseen'|'doneSeen'|'idle'}
 */
function lampForStatus(status, opts = {}) {
  if (!status || !status.code) return LAMP.IDLE;
  const code = status.code;
  if (code === STATUS.DONE) return opts.seen ? LAMP.DONE_SEEN : LAMP.DONE_UNSEEN;
  if (code === STATUS.STALE) return opts.staleAsNeedsYou && status.stalePending ? LAMP.NEEDS_YOU : LAMP.IDLE;
  return STATUS_LAMP[code] || LAMP.IDLE;
}

// 按推导优先级取最高的灯（会话灯）；空列表 → idle
function pickDerived(lamps) {
  let best = null;
  for (const l of lamps || []) {
    const i = DERIVE_ORDER.indexOf(l);
    if (i < 0) continue;
    if (best == null || i < DERIVE_ORDER.indexOf(best)) best = l;
  }
  return best || LAMP.IDLE;
}

// 按显示紧急度取最高的灯（状态栏总灯）；空列表 → idle
function pickSevere(lamps) {
  let best = null;
  for (const l of lamps || []) {
    if (!(l in SEVERITY)) continue;
    if (best == null || SEVERITY[l] > SEVERITY[best]) best = l;
  }
  return best || LAMP.IDLE;
}

// ---------------------------------------------------------------------------
// 其它共用小工具
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

/** @param {Provider} provider @param {string} id */
function sessionKey(provider, id) { return `${provider}:${id}`; }
/** @param {string} key @returns {{ provider: string, id: string }|null} */
function parseSessionKey(key) {
  if (typeof key !== 'string') return null;
  const i = key.indexOf(':');
  if (i <= 0) return null;
  return { provider: key.slice(0, i), id: key.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// 压缩次数与循环（§11.8 第 2 条；2 次、10 分钟是经验值）
// ---------------------------------------------------------------------------

const COMPACT_LOOP_MS = 10 * 60e3;
const COMPACT_TIMES_KEEP = 4;

/** 记一次压缩的时间（只留最近几次） */
function noteCompact(times, ms) {
  if (Number.isFinite(ms)) times.push(ms);
  if (times.length > COMPACT_TIMES_KEEP) times.splice(0, times.length - COMPACT_TIMES_KEEP);
}

/**
 * 可能在压缩循环：最近两次压缩相隔 ≤ 10 分钟，并且最后一次压缩之后 10 分钟内就没有别的进展了。
 * （之后又正常干了很久的会话不再标红。）
 * @param {number[]} times 压缩时间（旧→新）
 * @param {number|null} lastActivityMs
 */
function compactLoopOf(times, lastActivityMs) {
  const n = times ? times.length : 0;
  if (n < 2) return false;
  const a = times[n - 1];
  if (a - times[n - 2] > COMPACT_LOOP_MS) return false;
  return !Number.isFinite(lastActivityMs) || lastActivityMs - a <= COMPACT_LOOP_MS;
}

module.exports = {
  STATUS, STATUS_CODES,
  CERTAIN_NEEDS_YOU, GUESS_NEEDS_YOU, RUNNING_CODES, ERROR_CODES, STOPPED_CODES,
  isNeedsYouCode, isGuessCode, isRunningCode, isErrorCode, makeStatus,
  STEP,
  LIVE_STATUS, WAITING_FOR, codeForWaitingFor, statusFromRegistry,
  FAST_TOOLS, APPROVAL_GUESS, APPROVAL_GUESS_DEFAULT_SECONDS, isFastTool, guessAwaitingApproval,
  LAMP, LAMPS, DERIVE_ORDER, SEVERITY, LAMP_COLOR_ID, LAMP_CSS_VAR, LAMP_COLORS, LAMP_XTERM, LAMP_SHAPE,
  LAMP_BADGE_ICON, STATUS_LAMP, lampForStatus, pickDerived, pickSevere,
  UUID_RE, isUuid, sessionKey, parseSessionKey,
  COMPACT_LOOP_MS, noteCompact, compactLoopOf,
  WINDOW_SOURCE, COMPACT_SOURCE, SETTINGS_SOURCES,
};
