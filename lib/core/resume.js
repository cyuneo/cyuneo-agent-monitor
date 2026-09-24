'use strict';
// 续跑（DESIGN §7）：worker 产出结构化的 ResumeHint（不含界面文字），
// 界面层按 resumePrompt() 给出的词典键拼提示词，按 resumeCommand() 拼终端命令。

const { STATUS } = require('./status');
const { rereadCost, cacheLikelyExpired } = require('./pricing');

// 智能体级：这些状态给续跑提示
const AGENT_RESUME_CODES = new Set([STATUS.QUOTA, STATUS.API_ERROR]);
// 只给会话级（主智能体 / 主线程）
const SESSION_RESUME_CODES = new Set([STATUS.QUOTA, STATUS.API_ERROR, STATUS.STALE, STATUS.INTERRUPTED]);
// 内置的一次性子智能体，没有 agent ID，续不了，只能重跑【文档 sub-agents#resume-subagents】
const ONE_SHOT_AGENT_TYPES = new Set(['Explore', 'Plan']);

/**
 * 由最近一次 usage.cache_creation 推缓存 TTL（§7.3）。
 * 1h 写入 > 0 → '1h'；5m 写入 > 0（或只有 cache_creation_input_tokens）→ '5m'；
 * 都没有 → 主智能体 '1h'、其余 '5m'（文档默认，inferred = true）。
 * @param {any} usage
 * @param {boolean} isMain
 * @returns {{ ttl: '5m'|'1h', inferred: boolean }}
 */
function cacheTtlFromUsage(usage, isMain) {
  const u = usage || {};
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  if (cc && Number(cc.ephemeral_1h_input_tokens) > 0) return { ttl: '1h', inferred: false };
  if (cc && Number(cc.ephemeral_5m_input_tokens) > 0) return { ttl: '5m', inferred: false };
  if (!cc && Number(u.cache_creation_input_tokens) > 0) return { ttl: '5m', inferred: false };
  return { ttl: isMain ? '1h' : '5m', inferred: true };
}

/**
 * 续跑代价预估（§7.3）。
 * @param {{ provider: 'claude'|'codex', model: string|null, contextTokens: number, ttl?: '5m'|'1h'|null,
 *   lastActivityMs?: number|null, resetsAtMs?: number|null, now: number, isMain?: boolean }} o
 * @returns {import('./status').ResumeEstimate}
 */
function resumeEstimate(o) {
  const contextTokens = Math.max(0, Math.round(Number(o.contextTokens) || 0));
  if (o.provider === 'codex') {
    const c = rereadCost('codex', o.model, contextTokens);
    return { contextTokens, ttl: 'unknown', cacheLikelyExpired: null, usdIfMiss: c.usdIfMiss, usdIfHit: c.usdIfHit };
  }
  const isMain = o.isMain !== false;
  const ttl = o.ttl === '1h' || o.ttl === '5m' ? o.ttl : (isMain ? '1h' : '5m');
  const expired = cacheLikelyExpired(ttl, o.lastActivityMs, o.now, isMain, o.resetsAtMs ?? null);
  const c = rereadCost('claude', o.model, contextTokens, ttl);
  return { contextTokens, ttl, cacheLikelyExpired: expired, usdIfMiss: c.usdIfMiss, usdIfHit: c.usdIfHit };
}

function agentEstimate(provider, agent, now, isMain) {
  const st = agent && agent.status;
  return resumeEstimate({
    provider,
    model: agent && agent.model,
    contextTokens: agent && agent.tokens ? agent.tokens.contextUsed : 0,
    ttl: agent && agent.cacheTtl,
    lastActivityMs: agent && agent.lastActivityMs,
    resetsAtMs: st && st.quota ? st.quota.resetsAtMs : null,
    now,
    isMain,
  });
}

// 多个智能体的预估合起来（工作流重跑用）
function sumEstimates(list) {
  const out = { contextTokens: 0, ttl: '5m', cacheLikelyExpired: null, usdIfMiss: null, usdIfHit: null };
  for (const e of list) {
    out.contextTokens += e.contextTokens;
    if (e.ttl === '1h') out.ttl = '1h';
    if (e.cacheLikelyExpired != null) out.cacheLikelyExpired = !!(out.cacheLikelyExpired || e.cacheLikelyExpired);
    if (e.usdIfMiss != null) out.usdIfMiss = (out.usdIfMiss || 0) + e.usdIfMiss;
    if (e.usdIfHit != null) out.usdIfHit = (out.usdIfHit || 0) + e.usdIfHit;
  }
  return out;
}

/**
 * 按会话生成续跑提示（§7.1 生成条件）：
 * - 主智能体 / 主线程：quota / apiError / stale / interrupted；
 * - Claude 子智能体、Codex 子线程：quota / apiError（审阅线程不给）；
 * - Claude 工作流：killed / paused，或有智能体 quota / apiError（整个工作流一条）。
 * @param {import('./status').Session} session
 * @param {{ now?: number }} [opts]
 * @returns {import('./status').ResumeHint[]}
 */
function resumeHints(session, opts = {}) {
  const now = opts.now ?? Date.now();
  const out = [];
  if (!session || !session.main) return out;
  const provider = session.provider;
  const main = session.main;
  const code = main.status && main.status.code;

  if (provider === 'claude') {
    if (SESSION_RESUME_CODES.has(code)) {
      const quota = (main.status && main.status.quota) || null;
      out.push({
        kind: 'claudeSession',
        sessionId: session.id,
        cwd: session.cwd || null,
        entry: session.entry || null,
        autoContinue: code === STATUS.QUOTA && quota ? (quota.autoContinue ?? null) : false,
        quota,
        estimate: agentEstimate('claude', main, now, true),
      });
    }
    for (const a of session.agents || []) {
      if (a.kind !== 'subagent' || !AGENT_RESUME_CODES.has(a.status && a.status.code)) continue;
      out.push({
        kind: 'claudeSubagent',
        sessionId: session.id,
        agentId: a.id,
        name: a.name || null,
        agentType: a.agentType || null,
        resumable: !ONE_SHOT_AGENT_TYPES.has(a.agentType),
        estimate: agentEstimate('claude', a, now, false),
      });
    }
    for (const w of session.workflows || []) {
      const agents = w.agents || [];
      const failed = agents.some((a) => AGENT_RESUME_CODES.has(a.status && a.status.code));
      if (!(w.state === 'killed' || w.state === 'paused' || failed)) continue;
      const rerun = agents.filter((a) => !(a.status && a.status.code === STATUS.DONE));
      out.push({
        kind: 'claudeWorkflow',
        sessionId: session.id,
        runId: w.id,
        workflowName: w.name || w.id,
        scriptPath: w.scriptPath || null,
        paused: w.state === 'paused',
        estimate: sumEstimates(rerun.map((a) => agentEstimate('claude', a, now, false))),
      });
    }
  } else if (provider === 'codex') {
    if (SESSION_RESUME_CODES.has(code)) {
      out.push({
        kind: 'codexThread',
        threadId: session.id,
        cwd: session.cwd || null,
        entry: session.entry || null,
        estimate: agentEstimate('codex', main, now, true),
      });
    }
    for (const a of session.agents || []) {
      if (a.kind !== 'codexSubagent' || !AGENT_RESUME_CODES.has(a.status && a.status.code)) continue;
      out.push({
        kind: 'codexSubagent',
        parentThreadId: session.id,
        threadId: a.id,
        nickname: a.name || null,
        estimate: agentEstimate('codex', a, now, false),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 界面层用：词典键、可复制的形式、终端命令
// ---------------------------------------------------------------------------

/**
 * 提示词对应的词典键与占位符（文字在 l10n/core.*.json 的 resume.prompt.*）。
 * @param {import('./status').ResumeHint} hint
 * @returns {{ key: string, vars: Record<string, string> }}
 */
function resumePrompt(hint) {
  switch (hint && hint.kind) {
    case 'claudeSession': return { key: 'resume.prompt.claude', vars: {} };
    case 'codexThread': return { key: 'resume.prompt.codex', vars: {} };
    case 'claudeSubagent':
      return hint.resumable
        ? { key: 'resume.prompt.claudeSubagent', vars: { agentId: hint.agentId, name: hint.name || hint.agentId } }
        : { key: 'resume.prompt.claudeSubagentRerun', vars: { name: hint.name || hint.agentType || hint.agentId } };
    case 'claudeWorkflow':
      return hint.scriptPath
        ? { key: 'resume.prompt.claudeWorkflow', vars: { workflowName: hint.workflowName, runId: hint.runId, scriptPath: hint.scriptPath } }
        : { key: 'resume.prompt.claudeWorkflow.noScript', vars: { workflowName: hint.workflowName, runId: hint.runId } };
    case 'codexSubagent':
      return { key: 'resume.prompt.codexSubagent', vars: { nickname: hint.nickname || hint.threadId, threadId: hint.threadId } };
    default: return { key: 'resume.prompt.claude', vars: {} };
  }
}

/**
 * 这条提示能复制成哪些形式（§7.2）：
 * - 会话 / 线程：入口是 VS Code、桌面版 → 只复制提示词；否则终端命令 + 提示词；
 * - 子智能体、工作流：只复制提示词（在父会话里发）；工作流撞额度暂停中 → 不给复制。
 * @param {import('./status').ResumeHint} hint
 * @returns {('cli'|'prompt')[]}
 */
function resumeVariants(hint) {
  if (!hint) return [];
  if (hint.kind === 'claudeWorkflow' && hint.paused) return [];
  if (hint.kind === 'claudeSession' || hint.kind === 'codexThread') {
    return hint.entry === 'vscode' || hint.entry === 'desktop' ? ['prompt'] : ['cli', 'prompt'];
  }
  return ['prompt'];
}

// POSIX：提示词用双引号包，\ " $ ` 前加 \；含 ! 时改用单引号，避免交互式 shell 的历史展开
function quotePosixArg(s) {
  const v = String(s);
  if (v.includes('!')) return "'" + v.replace(/'/g, "'\\''") + "'";
  return '"' + v.replace(/([\\"$`])/g, '\\$1') + '"';
}
// POSIX 路径：只含安全字符就原样，否则单引号包（内部 ' 写成 '\''）
function quotePosixPath(s) {
  const v = String(s);
  return /^[\w@%+=:,./-]+$/.test(v) ? v : "'" + v.replace(/'/g, "'\\''") + "'";
}
// PowerShell：路径用单引号（内部 ' 写成 ''）；提示词用双引号，` " $ 前加反引号
function quotePwshPath(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function quotePwshArg(s) { return '"' + String(s).replace(/([`"$])/g, '`$1') + '"'; }

/**
 * 终端续跑命令（§7.2）。只有 claudeSession / codexThread 有；其它返回 null。
 * @param {import('./status').ResumeHint} hint
 * @param {string} prompt 已按界面语言拼好的提示词
 * @param {{ platform?: string }} [o] 默认 process.platform
 * @returns {string|null}
 */
function resumeCommand(hint, prompt, o = {}) {
  if (!hint) return null;
  let cli;
  let id;
  if (hint.kind === 'claudeSession') { cli = 'claude --resume'; id = hint.sessionId; }
  else if (hint.kind === 'codexThread') { cli = 'codex resume'; id = hint.threadId; }
  else return null;
  if (!/^[\w-]+$/.test(String(id || ''))) return null; // id 只允许安全字符，防注入
  const win = (o.platform || process.platform) === 'win32';
  if (win) {
    const run = `${cli} ${id} ${quotePwshArg(prompt)}`;
    return hint.cwd ? `Set-Location -LiteralPath ${quotePwshPath(hint.cwd)}; ${run}` : run;
  }
  const run = `${cli} ${id} ${quotePosixArg(prompt)}`;
  return hint.cwd ? `cd ${quotePosixPath(hint.cwd)} && ${run}` : run;
}

module.exports = {
  AGENT_RESUME_CODES, SESSION_RESUME_CODES, ONE_SHOT_AGENT_TYPES,
  cacheTtlFromUsage, resumeEstimate, resumeHints,
  resumePrompt, resumeVariants, resumeCommand,
  quotePosixArg, quotePosixPath, quotePwshPath, quotePwshArg,
};
