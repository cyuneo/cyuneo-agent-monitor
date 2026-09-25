'use strict';
// Resume support: the worker produces a structured ResumeHint (no UI text);
// the UI layer builds the prompt from the dictionary key returned by resumePrompt() and the terminal command from resumeCommand().

const { STATUS } = require('./status');
const { rereadCost, cacheLikelyExpired } = require('./pricing');

// Agent level: these statuses get a resume hint
const AGENT_RESUME_CODES = new Set([STATUS.QUOTA, STATUS.API_ERROR]);
// Session level only (main agent / main thread)
const SESSION_RESUME_CODES = new Set([STATUS.QUOTA, STATUS.API_ERROR, STATUS.STALE, STATUS.INTERRUPTED]);
// Built-in one-shot subagents have no agent ID, so they cannot be resumed, only re-run (see the Claude Code sub-agents docs, "Resume subagents")
const ONE_SHOT_AGENT_TYPES = new Set(['Explore', 'Plan']);

/**
 * Infers the cache TTL from the most recent usage.cache_creation.
 * 1h writes > 0 → '1h'; 5m writes > 0 (or only cache_creation_input_tokens) → '5m';
 * neither → '1h' for the main agent, '5m' otherwise (documented defaults, inferred = true).
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
 * Estimates the cost of resuming.
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

// Combines the estimates of several agents (used for workflow re-runs)
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
 * Builds resume hints for a session. They are generated when:
 * - main agent / main thread: quota / apiError / stale / interrupted;
 * - Claude subagent, Codex sub-thread: quota / apiError (review threads get none);
 * - Claude workflow: killed / paused, or any agent hit quota / apiError (one hint for the whole workflow).
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
  // Copilot: no hints (no resume command confirmed for it yet)
  return out;
}

// ---------------------------------------------------------------------------
// For the UI layer: dictionary keys, copyable forms, terminal commands
// ---------------------------------------------------------------------------

/**
 * Dictionary key and placeholders for the prompt (text lives under resume.prompt.* in l10n/core.*.json).
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
 * Which forms this hint can be copied as:
 * - session / thread: entry point is VS Code or the desktop app → prompt only; otherwise terminal command + prompt;
 * - subagent, workflow: prompt only (sent in the parent session); workflow paused on a usage limit → nothing to copy.
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

// POSIX: wrap the prompt in double quotes and escape \ " $ ` with \; if it contains !, use single quotes instead to avoid history expansion in interactive shells
function quotePosixArg(s) {
  const v = String(s);
  if (v.includes('!')) return "'" + v.replace(/'/g, "'\\''") + "'";
  return '"' + v.replace(/([\\"$`])/g, '\\$1') + '"';
}
// POSIX path: leave as-is if it only has safe characters, otherwise wrap in single quotes (an inner ' becomes '\'')
function quotePosixPath(s) {
  const v = String(s);
  return /^[\w@%+=:,./-]+$/.test(v) ? v : "'" + v.replace(/'/g, "'\\''") + "'";
}
// PowerShell: single-quote paths (an inner ' becomes ''); double-quote the prompt and prefix ` " $ with a backtick
function quotePwshPath(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function quotePwshArg(s) { return '"' + String(s).replace(/([`"$])/g, '`$1') + '"'; }

/**
 * Terminal command to resume. Only claudeSession / codexThread have one; others return null.
 * @param {import('./status').ResumeHint} hint
 * @param {string} prompt prompt already built in the UI language
 * @param {{ platform?: string }} [o] defaults to process.platform
 * @returns {string|null}
 */
function resumeCommand(hint, prompt, o = {}) {
  if (!hint) return null;
  let cli;
  let id;
  if (hint.kind === 'claudeSession') { cli = 'claude --resume'; id = hint.sessionId; }
  else if (hint.kind === 'codexThread') { cli = 'codex resume'; id = hint.threadId; }
  else return null;
  if (!/^[\w-]+$/.test(String(id || ''))) return null; // only safe characters allowed in the id, to prevent injection
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
