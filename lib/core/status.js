'use strict';
// Constants and data model shared by all modules.
// Only code, numbers and mappings, no UI text; text lives in the l10n dictionaries and is assembled by the format layer.

// ---------------------------------------------------------------------------
// Data model v2 (JSDoc). Times are always epoch milliseconds; tokens are integers; amounts are USD floats; null = unknown / no price.
// ---------------------------------------------------------------------------

/** @typedef {'claude'|'codex'|'copilot'} Provider */

/** @typedef {'starting'|'thinking'|'tool'|'retrying'
 *  |'awaitingApproval'|'awaitingInput'|'dialogOpen'|'maybeAwaitingApproval'
 *  |'idleBackground'|'done'|'interrupted'|'stale'|'killed'|'quota'|'apiError'} StatusCode */

/** @typedef {{ kind: 'session'|'weekly'|'model'|'spend'|'window'|'unknown',
 *  model: string|null, resetsAtMs: number|null, resetsText: string|null,
 *  source: 'quotaLimits'|'text'|'rateLimits'|'turnError', autoContinue: boolean|null }} QuotaHit */

/** @typedef {{
 *  code: StatusCode,
 *  sinceMs: number,                    // when this status was entered
 *  pendingTool: string|null,           // tool being waited on for tool / stale / maybeAwaitingApproval (raw name)
 *  stalePending: boolean,              // stale with an unfinished tool call
 *  retry: { attempt: number, max: number, inMs: number|null }|null,
 *  quota: QuotaHit|null,
 *  error: { kind: string, http: number|null, message: string|null }|null,  // message is the first line of the raw error, ≤200 chars
 *  question: 'askUser'|'planApproval'|null,   // why it is awaitingInput (as seen in the transcript)
 *  certainty: 'certain'|'guess',       // source of a NeedsYou-type status: certain from the registry / transcript, or a guess
 *  waitingFor: string|null             // raw registry value: 'permission prompt' | 'input needed' | 'dialog open'
 * }} AgentStatus */

/** @typedef {{
 *  kind: 'tool'|'toolResult'|'thinking'|'text'|'prompt'|'compact'|'none',
 *  tool: string|null, detail: string|null, parallel: number, sinceMs: number|null
 * }} Step */

/** @typedef {{
 *  display: number, contextUsed: number,
 *  contextWindow: number|null, compactAt: number|null, toCompact: number|null,
 *  contextPct: number|null,     // Claude Code's formula: round(contextUsed / contextWindow × 100), clamped to 0–100; null when the window is unknown
 *  output: number, processed: number, apiCalls: number,
 *  unknown?: true               // the counts were never recorded (Copilot sub-agents, or a Copilot chat without usage): show "—", not 0
 * }} AgentTokens */

/** @typedef {{
 *  ms: number, trigger: 'auto'|'manual'|null, preTokens: number|null,
 *  postTokens?: number|null,    // Claude: compactMetadata.postTokens; Codex: last_token_usage.total_tokens of the first token_count after compaction
 *  model: string|null,          // model at compaction time (message.model as-is, without [1m]; for Codex the turn_context.model at the time)
 *  contextWindow?: number|null  // this model's window in this session (used in the key `${model}|${contextWindow}` for learning observed compaction points)
 * }} LastCompact */

/** @typedef {{
 *  id: string,                  // Claude: 'main' or agentId; Codex: thread id; Copilot: session id / tool call id
 *  kind: 'main'|'subagent'|'workflowAgent'|'codexSubagent'|'codexReviewer'|'copilotSubagent',
 *  name: string|null, agentType: string|null, phase: string|null, background: boolean,
 *  model: string|null,
 *  status: AgentStatus, step: Step|null,
 *  tokens: AgentTokens,
 *  toolCalls: number, toolErrors: number, filesChanged: number,
 *  costUsd: number|null, unpricedModel: string|null,
 *  costEstimated?: boolean,     // the cost rests on an assumed rate (e.g. a price inferred for the model); Copilot: always false (costUsd null)
 *  description?: string|null,   // Copilot sub-agent: the task description it was given (raw, one line)
 *  copilotCredits?: number|null, // Copilot main agent: premium-request credits used by the session (raw sum)
 *  lastCompact: LastCompact|null,
 *  cacheTtl: '5m'|'1h'|null,    // cache TTL inferred from the latest usage (for resume / compaction cost estimates; always null for Codex)
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
 *  entrypoint: string|null,     // raw entrypoint from the live-session registry (claude-vscode / cli / claude-desktop …)
 *  model: string|null,
 *  createdMs: number|null, updatedMs: number,
 *  startedMs: number,           // sort key: time of the transcript's first line; if missing, the time first seen; never changes afterwards
 *  doneAtMs: number|null,
 *  live: boolean,               // the registry has a live process for it (Codex: a turn is in progress; Copilot: the last request is
 *                               // running or waiting on you)
 *  liveStatus: 'busy'|'waiting'|'idle'|null,
 *  waitingFor: string|null,
 *  version: string|null,        // client version recorded in the transcript
 *  compactCount: number,        // number of compactions in the main conversation (auto and manual both count)
 *  compactLoop: boolean,        // the last two compactions were ≤ 10 minutes apart with no other progress since ("postTokens still in the suggested-action zone after compaction" depends on a UI setting and is judged separately by the UI layer)
 *  contextUsed: number,         // context fields follow the main conversation and match the same-named fields in main.tokens; subagents use their own Agent.tokens
 *  modelVariant: string|null,   // key matched in cost-state.modelUsage, e.g. 'claude-opus-5-5[1m]'; null without cost-state
 *  contextWindow: number|null,
 *  contextWindowSource: 'cost-state'|'model-rule'|'codex-record'|'copilot-model'|null,
 *                               // copilot-model: maxInputTokens of the chat model stored with the session
 *  compactAt: number|null,      // actual compaction point (estimated): configured value − 33K, or the observed value; null when disabled
 *  compactAtSource: 'settings-local'|'settings-project'|'settings-user'|'observed'|'default'|'disabled'|null, // Codex: settings-user when taken from config.toml, otherwise default
 *  autoCompactWindow: number|null, // configured value compactAt was derived from (the setting capped at the window; default = window); null for observed / disabled / Codex
 *  contextPct: number|null,     // Claude Code's formula (see AgentTokens.contextPct)
 *  cacheTtl: '5m'|'1h'|null, cacheTtlInferred: boolean, cacheTtlMs: number|null,   // cache, Claude only; all null for Codex
 *  lastApiMs: number|null, cacheExpiresMs: number|null, lastActivityMs: number,
 *  main: Agent, agents: Agent[], workflows: Workflow[],
 *  counts: { running: number, awaiting: number, error: number, done: number, total: number },
 *  costUsd: number|null,        // this session's equivalent cost estimated by the extension from the price table (main + subagents + workflows)
 *  unpricedModel: string|null,
 *  ccCostUsd: number|null,      // cost-state.totalCostUSD: this session's cumulative cost as computed by Claude Code itself; always null for Codex
 *  transcript: string,          // absolute path of the main transcript (Claude: <sid>.jsonl; Codex: main-thread rollout; Copilot: the chat
 *                               // session file)
 *  resume: ResumeHint[],        // Copilot: always []
 *  copilot?: {                  // Copilot only (raw values)
 *    credits: number|null, multiplier: number|null, cachedTokens: number, requests: number, queued: number,
 *    modelState: number|null,   // last request's modelState (0 pending, 1 complete, 2 cancelled, 3 failed, 4 needs input)
 *    mode: string|null, permissionLevel: string|null,
 *    storage: 'workspace'|'emptyWindow', // where the chat file lives: a workspace's storage or the empty window's
 *    workspaceFile: string|null  // the .code-workspace file of that workspace, when it is a multi-root one
 *  }
 * }} Session */

/** @typedef {{ ms: number,
 *  kind: 'prompt'|'thinking'|'tool'|'toolDone'|'toolError'|'text'|'compact'|'quota'|'apiError'|'retry'|'interrupt'|'done',
 *  tool: string|null, detail: string|null }} TimelineEvent */

/** @typedef {{
 *  transcriptBytes: number|null,   // main transcript (Codex: main-thread rollout)
 *  subagentsBytes: number|null,    // Claude: the <project dir>/<sid>/ directory (subagents, workflows); Codex: total of sub-thread rollouts
 *  fileHistoryBytes: number|null,  // Claude: <configDir>/file-history/<sid>; always null for Codex
 *  transcript: string|null,        // main transcript path
 *  subagentsDir?: string|null, fileHistoryDir?: string|null,  // Claude: the corresponding directories (provided by lib/storage.js)
 *  at: number                      // measurement time (each session is measured at most once every 60 seconds)
 * }} SessionStorage */

/** @typedef {{
 *  key: string,
 *  agents: Record<string, {
 *    timeline: TimelineEvent[],
 *    result: { text: string, ms: number, source: 'lastText'|'journal'|'structuredOutput'|'taskComplete' }|null,
 *    files: { path: string, op: 'create'|'edit'|'delete'|'move', count: number, lastMs: number, movedTo: string|null }[],
 *    errors: { ms: number, tool: string|null, text: string }[]
 *  }>,
 *  storage?: SessionStorage|null   // null until the first measurement finishes (the next snapshot after that carries it)
 * }} SessionDetail */

/** @typedef {{ name: string, path: string, bytes: number|null, files: number|null,
 *  isSymlink: boolean, symlinkTarget: string|null, exists: boolean }} StorageEntry */

/** @typedef {{
 *  at: number,
 *  claude: { dir: string, dirSource: 'env'|'setting'|'default', entries: StorageEntry[] }|null,
 *  codex:  { dir: string, dirSource: 'env'|'setting'|'default', entries: StorageEntry[] }|null,
 *  volumes: { mount: string, freeBytes: number, totalBytes: number }[],
 *  cleanupPeriodDays: number|null,
 *  cached?: boolean,               // the worker returned a cached result less than 10 minutes old
 *  error?: string                  // only present when measuring failed / lib/storage.js is unavailable
 * }} StorageReport */

/** @typedef {{
 *  intervalMs: number, activeWindowMinutes: number, staleMinutes: number,
 *  claude: { enabled: boolean, projectsDir: string, configDir: string, configDirSource: 'env'|'setting'|'default',
 *            home: string, settingsPath: string },   // home = configDir (parent of the registry's sessions/ directory)
 *  codex:  { enabled: boolean, home: string, homeSource: 'env'|'setting'|'default' },
 *  copilot: { enabled: boolean, userDir: string|null },  // VS Code user dir (…/Code/User); null = the provider's defaults
 *  observedCompact: Record<string, number>,           // `${model}|${contextWindow}` → observed auto-compaction point (preTokens)
 *  limits: { timeline: number, timelineSent: number, resultChars: number, filesPerAgent: number, errorsPerAgent: number },
 *  dailyBudgetBytesPerTick: number
 * }} WorkerConfig */

/** @typedef {{ minutes: number, usedPct: number, resetsAtMs: number|null, label: string }} QuotaWindow */

/** @typedef {{
 *  claude: { lastHit: (QuotaHit & { ms: number, sessionKey: string })|null },
 *  codex:  { observedMs: number|null, planType: string|null, limitId: string|null,
 *            windows: QuotaWindow[], reachedType: string|null,
 *            credits: { hasCredits: boolean, unlimited: boolean, balance: string|null }|null },
 *  // Latest usage-limit hit seen in a session (same shape as claude; Copilot keeps no usage percentage on disk).
 *  // Filled by lib/monitor.js; absent in snapshots from older workers.
 *  copilot?: { lastHit: (QuotaHit & { ms: number, sessionKey: string })|null }
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
// Source codes for the context window and auto-compaction point (the UI looks up strings by code)
// ---------------------------------------------------------------------------

const WINDOW_SOURCE = Object.freeze({
  COST_STATE: 'cost-state', MODEL_RULE: 'model-rule', CODEX_RECORD: 'codex-record',
  COPILOT_MODEL: 'copilot-model', // maxInputTokens of the chat model stored with the Copilot session
});
const COMPACT_SOURCE = Object.freeze({
  SETTINGS_LOCAL: 'settings-local',     // <cwd>/.claude/settings.local.json
  SETTINGS_PROJECT: 'settings-project', // <cwd>/.claude/settings.json
  SETTINGS_USER: 'settings-user',       // <claudeConfigDir>/settings.json (Codex: config.toml)
  OBSERVED: 'observed',                 // observed (observedCompact)
  DEFAULT: 'default',                   // official default (window − 33K; Codex: window × 0.9)
  DISABLED: 'disabled',                 // autoCompactEnabled === false
});
// Settings-based sources (sessions with these are skipped when learning observed compaction points: their observed values reflect user settings, not the default)
const SETTINGS_SOURCES = new Set([COMPACT_SOURCE.SETTINGS_LOCAL, COMPACT_SOURCE.SETTINGS_PROJECT, COMPACT_SOURCE.SETTINGS_USER]);

// ---------------------------------------------------------------------------
// Status codes
// ---------------------------------------------------------------------------

const STATUS = Object.freeze({
  STARTING: 'starting',
  THINKING: 'thinking',
  TOOL: 'tool',
  RETRYING: 'retrying',
  // Needs you: certain (live-session registry / question tools in the transcript)
  AWAITING_APPROVAL: 'awaitingApproval',   // registry waitingFor = 'permission prompt'
  AWAITING_INPUT: 'awaitingInput',         // registry 'input needed', or AskUserQuestion / ExitPlanMode in the transcript with no result yet
  DIALOG_OPEN: 'dialogOpen',               // registry 'dialog open'
  // Needs you: guessed (a fast tool was issued and has had no result for a long time)
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

// Certain "needs you"
const CERTAIN_NEEDS_YOU = new Set([STATUS.AWAITING_APPROVAL, STATUS.AWAITING_INPUT, STATUS.DIALOG_OPEN]);
// Guessed "needs you"
const GUESS_NEEDS_YOU = new Set([STATUS.MAYBE_AWAITING_APPROVAL]);
// Status codes that count as "running" (Working lamp)
const RUNNING_CODES = new Set([STATUS.STARTING, STATUS.THINKING, STATUS.TOOL, STATUS.RETRYING, STATUS.IDLE_BACKGROUND]);
// Errors
const ERROR_CODES = new Set([STATUS.QUOTA, STATUS.API_ERROR]);
// This turn has stopped (will not move on its own)
const STOPPED_CODES = new Set([STATUS.DONE, STATUS.INTERRUPTED, STATUS.KILLED, STATUS.QUOTA, STATUS.API_ERROR]);

function isNeedsYouCode(code) { return CERTAIN_NEEDS_YOU.has(code) || GUESS_NEEDS_YOU.has(code); }
function isGuessCode(code) { return GUESS_NEEDS_YOU.has(code); }
function isRunningCode(code) { return RUNNING_CODES.has(code); }
function isErrorCode(code) { return ERROR_CODES.has(code); }

/**
 * Builds a complete AgentStatus, filling missing fields with defaults.
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
// Step kinds
// ---------------------------------------------------------------------------

const STEP = Object.freeze({
  TOOL: 'tool', TOOL_RESULT: 'toolResult', THINKING: 'thinking', TEXT: 'text',
  PROMPT: 'prompt', COMPACT: 'compact', NONE: 'none',
});

// ---------------------------------------------------------------------------
// Claude live-session registry
// ---------------------------------------------------------------------------

const LIVE_STATUS = Object.freeze({ BUSY: 'busy', WAITING: 'waiting', IDLE: 'idle' });
const WAITING_FOR = Object.freeze({ PERMISSION: 'permission prompt', INPUT: 'input needed', DIALOG: 'dialog open' });

/**
 * Registry waitingFor → certain status code. An unknown waitingFor is treated as "awaiting your approval" (in the CLI everything except questions / dialogs is a permission prompt).
 * @param {string|null} waitingFor
 * @returns {StatusCode}
 */
function codeForWaitingFor(waitingFor) {
  if (waitingFor === WAITING_FOR.INPUT) return STATUS.AWAITING_INPUT;
  if (waitingFor === WAITING_FOR.DIALOG) return STATUS.DIALOG_OPEN;
  return STATUS.AWAITING_APPROVAL;
}

/**
 * Registry entry → status the main agent should be overridden with; returns null when no override is needed.
 * Only waiting overrides (a certain NeedsYou); busy / idle are left to the caller to judge together with the transcript.
 * @param {{ status?: string, waitingFor?: string|null, statusUpdatedAt?: number, updatedAt?: number }|null} entry
 * @param {number} [fallbackSinceMs]
 * @returns {AgentStatus|null}
 */
function statusFromRegistry(entry, fallbackSinceMs = 0) {
  if (!entry || entry.status !== LIVE_STATUS.WAITING) return null;
  let since = Number(entry.statusUpdatedAt || entry.updatedAt) || fallbackSinceMs;
  if (since > 0 && since < 1e12) since *= 1000; // in case it is epoch seconds
  const code = codeForWaitingFor(entry.waitingFor || null);
  return makeStatus(code, since, { waitingFor: entry.waitingFor || null, certainty: 'certain' });
}

// ---------------------------------------------------------------------------
// Guessing "may be awaiting your approval"
// ---------------------------------------------------------------------------

// Fast tools: normally return within seconds; no result long after being issued most likely means waiting for permission approval
const FAST_TOOLS = Object.freeze({
  claude: Object.freeze(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'TodoWrite', 'WebFetch']),
  // Codex file read/write / patch tools (names taken from tools.<name> in exec code mode, or the function_call names of older versions)
  codex: Object.freeze(['apply_patch', 'update_plan', 'view_image', 'read_file', 'list_dir', 'grep_files']),
});
const FAST_TOOL_SETS = Object.fromEntries(Object.entries(FAST_TOOLS).map(([k, v]) => [k, new Set(v)]));

const APPROVAL_GUESS = Object.freeze({ FAST_TOOLS: 'fastTools', ALL_TOOLS: 'allTools', OFF: 'off' });
const APPROVAL_GUESS_DEFAULT_SECONDS = 60;

/**
 * @param {Provider} provider
 * @param {string|null} tool raw tool name
 */
function isFastTool(provider, tool) {
  const set = FAST_TOOL_SETS[provider];
  return !!(set && tool && set.has(tool));
}

/**
 * Whether "a tool was issued and has had no result for a long time" should be judged as maybeAwaitingApproval.
 * - mode 'off' → never;
 * - the session has a signal in the live-session registry (hasRegistry) → never (use the registry's certain status);
 * - 'fastTools' (default): fast tools only, waiting ≥ seconds seconds;
 * - 'allTools': any tool, waiting ≥ staleMinutes minutes.
 * With several unfinished calls, any one meeting the condition is enough.
 * @param {{
 *   provider: Provider,
 *   pending: { tool: string|null, sinceMs: number }[],
 *   now: number,
 *   mode?: 'fastTools'|'allTools'|'off',
 *   seconds?: number,
 *   staleMinutes?: number,
 *   hasRegistry?: boolean
 * }} o
 * @returns {{ tool: string|null, sinceMs: number }|null} the matching call (the earliest); null when not judged
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
// Lamps
// ---------------------------------------------------------------------------

const LAMP = Object.freeze({
  NEEDS_YOU: 'needsYou', ERROR: 'error', WORKING: 'working',
  DONE_UNSEEN: 'doneUnseen', DONE_SEEN: 'doneSeen', IDLE: 'idle',
});
const LAMPS = Object.freeze(['needsYou', 'error', 'working', 'doneUnseen', 'doneSeen', 'idle']);

// Derivation priority of the session lamp (first match wins)
const DERIVE_ORDER = Object.freeze(['needsYou', 'error', 'working', 'doneUnseen', 'doneSeen', 'idle']);
// Display urgency of the overall lamp (higher = more urgent)
const SEVERITY = Object.freeze({ needsYou: 100, error: 80, doneUnseen: 60, working: 40, doneSeen: 20, idle: 10 });

// Color contribution ids (package.json contributes.colors)
const LAMP_COLOR_ID = Object.freeze({
  needsYou: 'agentMonitor.lampNeedsYou',
  error: 'agentMonitor.lampError',
  working: 'agentMonitor.lampWorking',
  doneUnseen: 'agentMonitor.lampDoneUnseen',
  doneSeen: 'agentMonitor.lampDoneSeen',
  idle: 'agentMonitor.lampIdle',
});
// CSS variables in the webview ('--vscode-' + id with the first '.' replaced by '-')
const LAMP_CSS_VAR = Object.freeze(Object.fromEntries(
  Object.entries(LAMP_COLOR_ID).map(([k, id]) => [k, '--vscode-' + id.replace('.', '-')])));
// Default colors (light and high-contrast variants adjusted for contrast)
const LAMP_COLORS = Object.freeze({
  working:    Object.freeze({ dark: '#00AFFF', light: '#0078D4', highContrast: '#00AFFF', highContrastLight: '#005A9E' }),
  needsYou:   Object.freeze({ dark: '#EE2B7B', light: '#C4004F', highContrast: '#FF3D8B', highContrastLight: '#B0004A' }),
  doneUnseen: Object.freeze({ dark: '#5FFF00', light: '#2E9E00', highContrast: '#5FFF00', highContrastLight: '#1F6F00' }),
  doneSeen:   Object.freeze({ dark: '#008700', light: '#1A5C1A', highContrast: '#3FBF3F', highContrastLight: '#2D5A2D' }),
  error:      Object.freeze({ dark: '#FF0000', light: '#E51400', highContrast: '#FF4D4D', highContrastLight: '#B5200D' }),
  idle:       Object.freeze({ dark: '#808080', light: '#767676', highContrast: '#B0B0B0', highContrastLight: '#5A5A5A' }),
});
// Terminal version: xterm 256-color numbers
const LAMP_XTERM = Object.freeze({ working: 39, needsYou: 161, doneUnseen: 82, doneSeen: 28, error: 196, idle: 244 });
// Icon shape: filled / outline (not distinguished by color alone)
const LAMP_SHAPE = Object.freeze({
  needsYou: 'circle-large-filled', error: 'circle-large-filled', working: 'circle-large-filled',
  doneUnseen: 'circle-large-filled', doneSeen: 'circle-large-outline', idle: 'circle-large-outline',
});
// Icon placed before description text (tooltip / a11y)
const LAMP_BADGE_ICON = Object.freeze({ needsYou: 'bell', error: 'error' });

// Status code → lamp (done also depends on "seen", stale on an option)
const STATUS_LAMP = Object.freeze({
  starting: 'working', thinking: 'working', tool: 'working', retrying: 'working', idleBackground: 'working',
  awaitingApproval: 'needsYou', awaitingInput: 'needsYou', dialogOpen: 'needsYou', maybeAwaitingApproval: 'needsYou',
  done: 'doneUnseen',
  interrupted: 'idle', killed: 'idle', stale: 'idle',
  quota: 'error', apiError: 'error',
});

/**
 * Lamp for a single agent.
 * - done: seen is true → DoneSeen, otherwise DoneUnseen (seen is decided by the caller and passed in);
 * - stale: Idle by default. "Awaiting approval" is now expressed by maybeAwaitingApproval,
 *   so it only counts as NeedsYou when staleAsNeedsYou is passed explicitly and stalePending is set (compatibility with an older setting).
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

// Highest lamp by derivation priority (session lamp); empty list → idle
function pickDerived(lamps) {
  let best = null;
  for (const l of lamps || []) {
    const i = DERIVE_ORDER.indexOf(l);
    if (i < 0) continue;
    if (best == null || i < DERIVE_ORDER.indexOf(best)) best = l;
  }
  return best || LAMP.IDLE;
}

// Highest lamp by display urgency (overall status-bar lamp); empty list → idle
function pickSevere(lamps) {
  let best = null;
  for (const l of lamps || []) {
    if (!(l in SEVERITY)) continue;
    if (best == null || SEVERITY[l] > SEVERITY[best]) best = l;
  }
  return best || LAMP.IDLE;
}

// ---------------------------------------------------------------------------
// Other shared helpers
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
// Compaction count and loops (2 compactions / 10 minutes are empirical thresholds)
// ---------------------------------------------------------------------------

const COMPACT_LOOP_MS = 10 * 60e3;
const COMPACT_TIMES_KEEP = 4;

/** Records the time of a compaction (keeps only the last few) */
function noteCompact(times, ms) {
  if (Number.isFinite(ms)) times.push(ms);
  if (times.length > COMPACT_TIMES_KEEP) times.splice(0, times.length - COMPACT_TIMES_KEEP);
}

/**
 * Possible compaction loop: the last two compactions were ≤ 10 minutes apart, and there was no other progress within 10 minutes after the last one.
 * (Sessions that went on working normally for a long time afterwards are no longer flagged red.)
 * @param {number[]} times compaction times (oldest → newest)
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
