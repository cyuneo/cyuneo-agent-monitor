'use strict';
// The only place in the UI layer that builds sentences.
// The worker supplies only codes, numbers, timestamps and raw text snippets; this module turns them into text in the
// current language using the i18n instance.
// Conventions:
// - Every function takes the data first, then the i18n instance (createI18n / fromPayload from lib/i18n.js); now can be injected.
// - opts.stable = true: leave out anything that changes every second (elapsed time, countdowns). Used for session list
//   rows and their hover tooltips, so a row only needs refreshing when its content really changes. The agent table does
//   not pass stable and may include durations.
// - User text (tool arguments, titles, error messages) is inserted as-is without escaping; Markdown / HTML escaping is the caller's job.

const S = require('./core/status');
const pricing = require('./core/pricing');

const { PRICES_UPDATED } = pricing;
const { resumePrompt, resumeVariants, resumeCommand } = require('./core/resume');
const { isWindowReset } = require('./core/quota');
const lampLib = require('./lamp');
const { ROW_MAIN } = require('./order');

const SEP = ' · ';
const QUOTA_KINDS = new Set(['session', 'weekly', 'model', 'spend', 'window', 'unknown']);
const KIND_KEY = {
  main: 'agent.main', subagent: 'agent.subagent', workflowAgent: 'agent.workflowAgent',
  codexSubagent: 'agent.codexSubagent', codexReviewer: 'agent.reviewer',
  copilotSubagent: 'agent.subagent', geminiSubagent: 'agent.subagent', qwenSubagent: 'agent.subagent',
};
// Providers with a product name in the dictionary (provider.<id>)
const PROVIDERS = new Set(['claude', 'codex', 'copilot', 'gemini', 'qwen']);
// Providers whose sessions report an auto-compact point; for the others compactAt is always null and means "unknown", not "off"
const COMPACT_PROVIDERS = new Set(['claude', 'codex']);
// Copilot chat parts that wait on the user: step.tool / pendingTool carry the raw part kind, shown by name instead
const INTERACTION_TOOL_KEY = {
  questionCarousel: 'tool.question', elicitationSerialized: 'tool.elicitation', elicitation: 'tool.elicitation',
  planReview: 'tool.planReview', confirmation: 'tool.confirmation',
};
// Providers whose account-wide usage-limit hit is kept as QuotaSnapshot[provider].lastHit (Codex has its own quota windows)
const LAST_HIT_PROVIDERS = Object.freeze(['claude', 'copilot', 'gemini', 'qwen']);
// No reset time known (Copilot / Gemini CLI / Qwen Code): the panel mentions a limit hit for this long afterwards
const RECENT_HIT_MS = 60 * 60e3;
// Only offer the compact button for sessions whose context is ≥ 20000 tokens
const COMPACTABLE_MIN = 20000;
const NAME_MAX = 24;
const DASH = '—';

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clip = (s, n) => {
  const a = Array.from(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
  return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join('');
};

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/**
 * Tool name display (not translated): mcp__claude_ai_Notion__notion-search → Notion·notion-search;
 * mcp__codex_apps__github_fetch → codex_apps·github_fetch; empty → dictionary entry tool.generic.
 * @param {string|null} name
 * @param {any} [i18n]
 */
function toolLabel(name, i18n) {
  if (!name) return i18n ? i18n.t('tool.generic') : 'tool';
  if (i18n && Object.prototype.hasOwnProperty.call(INTERACTION_TOOL_KEY, name)) return i18n.t(INTERACTION_TOOL_KEY[name]);
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name));
  if (m) return m[1].replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '') + '·' + m[2];
  return String(name);
}

/**
 * 'claude' → Claude, 'codex' → Codex, 'copilot' → Copilot, 'gemini' → Gemini CLI, 'qwen' → Qwen Code
 * (product names are not translated, but go through the dictionary for consistency)
 */
function providerLabel(provider, i18n) {
  return PROVIDERS.has(provider) ? i18n.t('provider.' + provider) : String(provider || '');
}

/** Whether this provider reports an auto-compact point (Claude, Codex); the others only know the window */
function hasCompactPoint(provider) {
  return COMPACT_PROVIDERS.has(provider);
}

/** Entry point: vscode / cli / desktop / sdk / exec / other */
function entryLabel(entry, i18n) {
  const k = 'entry.' + (entry || 'other');
  return i18n.has(k) ? i18n.t(k) : i18n.t('entry.other');
}

/** Lamp name; short = true uses the short form shown in the status bar */
function lampLabel(lamp, i18n, short = false) {
  const l = S.LAMPS.includes(lamp) ? lamp : S.LAMP.IDLE;
  return i18n.t('lamp.' + l + (short ? '.short' : ''));
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * One line for hitting a usage limit: title + reset time.
 * @param {import('./core/status').QuotaHit|null} hit
 * @param {any} i18n
 * @param {number} [now]
 * @param {{ stable?: boolean }} [opts] stable: leave out the "time remaining" part
 */
function formatQuotaHit(hit, i18n, now = Date.now(), opts = {}) {
  if (!hit) return i18n.t('status.quota');
  let kind = QUOTA_KINDS.has(hit.kind) ? hit.kind : 'unknown';
  if (kind === 'model' && !hit.model) kind = 'unknown';
  const title = kind === 'model' ? i18n.t('quota.model', { model: hit.model }) : i18n.t('quota.' + kind);
  let reset = '';
  if (fin(hit.resetsAtMs)) {
    const at = i18n.fmtClock(hit.resetsAtMs, now);
    if (hit.resetsAtMs <= now) reset = i18n.t('quota.resetPassed');
    else if (opts.stable) reset = i18n.t('quota.window.resetAt', { reset: at });
    else reset = i18n.t('quota.resets', { reset: at, left: i18n.fmtDur(hit.resetsAtMs - now) });
  } else if (hit.resetsText) {
    reset = String(hit.resetsText);
  }
  return reset ? title + SEP + reset : title;
}

/**
 * Extra note after hitting a usage limit (auto-continue); returns '' when there is none.
 * @param {import('./core/status').QuotaHit|null} hit
 */
function formatAutoContinue(hit, i18n, now = Date.now()) {
  if (!hit || hit.autoContinue === false || !fin(hit.resetsAtMs) || hit.resetsAtMs <= now) return '';
  return i18n.t('quota.autoContinue', { reset: i18n.fmtClock(hit.resetsAtMs, now) });
}

/**
 * One-line status. A status the provider only guessed (certainty 'guess', e.g. Gemini CLI's running / done from write timing)
 * is marked "~Thinking"; the guessed approval wait already says "may be" and is left as is.
 * @param {import('./core/status').AgentStatus|null} status
 * @param {{ kind?: string }|null} agent used to tell the main agent apart (done → "turn complete")
 * @param {any} i18n
 * @param {number} [now]
 * @param {{ stable?: boolean, isMain?: boolean, staleAsNeedsYou?: boolean }} [opts]
 */
function formatStatus(status, agent, i18n, now = Date.now(), opts = {}) {
  const text = statusText(status, agent, i18n, now, opts);
  return lampLib.isGuessStatus(status) && !S.isGuessCode(status.code) ? markGuess(text, i18n) : text;
}

/**
 * Marks text that describes a status inferred from timing ("~Thinking"). Statuses whose own wording already says
 * "may be" (maybeAwaitingApproval) are not marked again.
 */
function markGuess(text, i18n) {
  return text ? i18n.t('status.guessed', { status: text }) : text;
}

function statusText(status, agent, i18n, now, opts) {
  if (!status || !status.code) return i18n.t('lamp.idle');
  const stable = !!opts.stable;
  const isMain = opts.isMain != null ? !!opts.isMain : !!(agent && agent.kind === 'main');
  const since = fin(status.sinceMs) ? status.sinceMs : null;
  const dur = since != null && now >= since ? i18n.fmtDur(now - since) : '';
  switch (status.code) {
    case S.STATUS.RETRYING: {
      const r = status.retry || {};
      const vars = { attempt: r.attempt ?? '?', max: r.max ?? '?' };
      if (!stable && fin(r.inMs) && since != null && since + r.inMs > now) {
        return i18n.t('status.retrying.in', { ...vars, dur: i18n.fmtDur(since + r.inMs - now) });
      }
      return i18n.t('status.retrying', vars);
    }
    case S.STATUS.AWAITING_INPUT:
      return i18n.t(status.question === 'planApproval' ? 'status.awaitingInput.planApproval' : 'status.awaitingInput');
    case S.STATUS.MAYBE_AWAITING_APPROVAL:
      if (!stable && status.pendingTool && dur) {
        return i18n.t('status.maybeAwaitingApproval.tool', { tool: toolLabel(status.pendingTool, i18n), dur });
      }
      return i18n.t('status.maybeAwaitingApproval');
    case S.STATUS.DONE:
      return i18n.t(isMain ? 'status.done.main' : 'status.done');
    case S.STATUS.STALE: {
      const tool = status.stalePending && status.pendingTool ? toolLabel(status.pendingTool, i18n) : null;
      const pendingGuess = opts.staleAsNeedsYou && status.stalePending;
      if (stable) {
        if (pendingGuess) return i18n.t('row.stalePending');
        return tool ? i18n.t('row.staleRunning', { tool }) : i18n.t('row.stale');
      }
      if (pendingGuess) return i18n.t('status.stale.pending', { dur });
      return tool ? i18n.t('status.stale.running', { dur, tool }) : i18n.t('status.stale', { dur });
    }
    case S.STATUS.QUOTA:
      return formatQuotaHit(status.quota, i18n, now, { stable });
    case S.STATUS.API_ERROR: {
      const http = status.error && status.error.http;
      return http ? i18n.t('status.apiError.http', { http }) : i18n.t('status.apiError');
    }
    default: {
      const k = 'status.' + status.code;
      return i18n.has(k) ? i18n.t(k) : String(status.code);
    }
  }
}

/**
 * Explanation of an inferred status (for the tooltip); returns '' for a confirmed status.
 * Guessed approval waits keep their own note; other guesses (Gemini CLI: running / done inferred from write timing) get the timing note.
 */
function formatStatusNote(status, i18n) {
  if (!status) return '';
  if (S.isGuessCode(status.code)) return i18n.t('status.guess.note');
  return lampLib.isGuessStatus(status) ? i18n.t('status.guess.timing') : '';
}

/** Provider-wide caveat about status freshness (Copilot: VS Code saves chat sessions about once a minute); '' when none */
function formatProviderNote(provider, i18n) {
  return provider === 'copilot' ? i18n.t('status.lag.copilot') : '';
}

/**
 * "open now" / "not open" for the tooltip; providers without a process registry (Gemini CLI) only guess it from write timing.
 * @param {{ live?: boolean, liveCertainty?: string }} session
 */
function formatLive(session, i18n) {
  const guess = !!session && session.liveCertainty === 'guess';
  if (session && session.live) return i18n.t(guess ? 'entry.openGuess' : 'tip.open');
  return i18n.t(guess ? 'entry.notOpenGuess' : 'tip.notOpen');
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Current step. Not shown when done / interrupted (the last reply goes in the details).
 * @param {import('./core/status').Step|null} step
 * @param {import('./core/status').AgentStatus|null} status
 * @param {any} i18n
 * @param {number} [now]
 * @param {{ withDur?: boolean }} [opts] withDur: append "· elapsed time" (agent table)
 */
function formatStep(step, status, i18n, now = Date.now(), opts = {}) {
  if (!step || !step.kind || step.kind === S.STEP.NONE) return '';
  if (status && (status.code === S.STATUS.DONE || status.code === S.STATUS.INTERRUPTED)) return '';
  let s = '';
  switch (step.kind) {
    case S.STEP.TOOL: {
      const tool = toolLabel(step.tool, i18n);
      s = step.detail ? i18n.t('step.tool', { tool, detail: step.detail }) : i18n.t('step.tool.noDetail', { tool });
      if (step.parallel > 1) s += ' ' + i18n.t('step.parallel', { n: step.parallel });
      break;
    }
    case S.STEP.TOOL_RESULT:
      s = step.tool ? i18n.t('step.toolResult', { tool: toolLabel(step.tool, i18n) }) : i18n.t('step.toolResult.noTool');
      break;
    case S.STEP.THINKING: s = i18n.t('step.thinking'); break;
    case S.STEP.TEXT: s = step.detail ? i18n.t('step.text', { detail: step.detail }) : ''; break;
    case S.STEP.PROMPT: s = step.detail ? i18n.t('step.prompt', { detail: step.detail }) : ''; break;
    case S.STEP.COMPACT: s = i18n.t('step.compact'); break;
    default: s = '';
  }
  if (s && opts.withDur && fin(step.sinceMs) && now >= step.sinceMs) {
    s = i18n.t('step.since', { step: s, dur: i18n.fmtDur(now - step.sinceMs) });
  }
  return s;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Whether an agent's token counts were never recorded, so "0" would be a false reading (shown as "—" instead).
 * Copilot keeps no token counts for sub-agents, and a chat whose requests carry no usage has none for the main agent either.
 * A provider can also say so directly with tokens.unknown = true.
 * @param {any} agent
 * @param {string} [provider]
 */
function tokensUnknown(agent, provider) {
  const t = agent && agent.tokens;
  if (!t || typeof t !== 'object' || t.unknown === true) return true;
  if (provider !== 'copilot') return false;
  if (agent.kind !== 'main') return true;
  return !(Number(t.contextUsed) > 0 || Number(t.processed) > 0 || Number(t.output) > 0);
}

/**
 * Note explaining why token counts are missing ('' when they are known).
 * @param {any} agent
 * @param {string} [provider]
 */
function formatTokensUnknownNote(agent, provider, i18n) {
  if (!tokensUnknown(agent, provider)) return '';
  return i18n.t(provider === 'copilot' && agent && agent.kind !== 'main' ? 'ctx.unknown.sub' : 'ctx.unknown.note');
}

/**
 * The percentage follows Claude Code's own formula: round(used / window × 100), clamped to 0–100.
 * @param {number} used
 * @param {number} window
 * @returns {number|null}
 */
function contextPct(used, window) {
  if (!fin(window) || window <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((Math.max(0, Number(used) || 0) / window) * 100)));
}

/** Percentage text: write "<1%" instead of "0%" when the value is tiny but non-zero */
function formatPctValue(pct, used, i18n) {
  if (pct == null) return '';
  if (pct === 0 && used > 0) return '<' + i18n.fmtPct(0.01);
  return i18n.fmtPct(pct / 100);
}

/**
 * Context usage. The progress bar is "used / auto-compact threshold"; falls back to the window when the threshold is unknown.
 * The percentage is always relative to the window (Claude Code's formula), not the threshold; falls back to the
 * threshold when the window is unknown.
 * @param {(import('./core/status').AgentTokens & { compactUnknown?: boolean, unknown?: boolean })|null} tokens
 *   compactUnknown: the provider never reports an auto-compact point (see agentContextTokens / sessionContextTokens);
 *   unknown: no token counts were recorded (tokensUnknown): usage reads "—" and there is no percentage or bar
 * @param {any} i18n
 * @returns {{ used: number, limit: number|null, window: number|null, ratio: number|null, pct: number|null,
 *   pctText: string, pctOfWindowText: string, usageText: string, shortText: string, remainText: string, notes: string[],
 *   unknown: boolean }}
 *   ratio = used / bar maximum (for the progress bar); pct = integer percent of the window; shortText is for the
 *   session list row ("42% context");
 *   pctOfWindowText is "41% of the 1M window"; remainText is "… until auto-compact" or "auto-compact off".
 */
function formatContext(tokens, i18n) {
  const t = tokens || {};
  const used = Math.max(0, Number(t.contextUsed) || 0);
  const relative = fin(t.compactAt) && t.toCompact == null; // Codex body_after_prefix
  const window = fin(t.contextWindow) && t.contextWindow > 0 ? t.contextWindow : null;
  let limit = null;
  if (fin(t.compactAt) && t.compactAt > 0 && !relative) limit = t.compactAt;
  else if (window) limit = window;
  if (t.unknown) {
    // Not recorded: "— / 128K" (the window is still worth knowing), no percentage, bar, zone or remaining amount
    return {
      used: 0, limit, window, ratio: null, pct: null, pctText: '', pctOfWindowText: '',
      usageText: limit ? i18n.t('ctx.usage', { used: DASH, limit: i18n.fmtTokens(limit) }) : DASH,
      shortText: '', remainText: '', notes: [], unknown: true,
    };
  }
  const ratio = limit ? used / limit : null;
  const pct = contextPct(used, window || limit);
  const pctText = formatPctValue(pct, used, i18n);
  const usageText = limit
    ? i18n.t('ctx.usage', { used: i18n.fmtTokens(used), limit: i18n.fmtTokens(limit) })
    : i18n.fmtTokens(used);
  let remainText = '';
  const notes = [];
  if (relative) notes.push(i18n.t('ctx.relativeScope'));
  else if (fin(t.toCompact)) remainText = i18n.t('ctx.toCompact', { tokens: i18n.fmtTokens(Math.max(0, t.toCompact)) });
  // Providers without an auto-compact point (compactUnknown): null means "not reported", so don't claim it is off
  else if (t.compactAt == null && t.compactUnknown) notes.push(i18n.t('ctx.compactUnknown'));
  else if (t.compactAt == null && window) remainText = i18n.t('ctx.autoCompactOff');
  return {
    used, limit, window, ratio, pct, pctText,
    pctOfWindowText: window && pctText ? i18n.t('tip.pctOfWindow', { pct: pctText, window: i18n.fmtTokens(window) }) : '',
    usageText,
    shortText: pctText ? i18n.t('row.context', { pct: pctText }) : '',
    remainText, notes, unknown: false,
  };
}

/**
 * Session-level context data: the window and compaction point come from Session.contextWindow / compactAt
 * (providers compute them by Claude Code's / Codex's own rules and tag the source); when missing, fall back to the
 * fields of the same name in the main agent's tokens.
 * @param {any} s Session
 * @returns {import('./core/status').AgentTokens & { windowSource: string|null, compactAtSource: string|null, compactUnknown: boolean,
 *   unknown: boolean }}   unknown: the main agent's token counts were never recorded (tokensUnknown)
 */
function sessionContextTokens(s) {
  /** @type {any} */
  const tk = (s && s.main && s.main.tokens) || {};
  /** @type {any} */
  const out = {
    ...tk, windowSource: null, compactAtSource: null, compactUnknown: !!(s && s.provider) && !hasCompactPoint(s.provider),
    unknown: !!(s && s.main) && tokensUnknown(s.main, s.provider),
  };
  if (!s) return out;
  const used = Math.max(0, Number(tk.contextUsed) || 0);
  if (fin(s.contextWindow) && s.contextWindow > 0) {
    out.contextWindow = s.contextWindow;
    out.windowSource = s.contextWindowSource || null;
  }
  const relative = fin(tk.compactAt) && tk.toCompact == null; // Codex body_after_prefix: remaining amount cannot be computed
  if (s.compactAtSource === 'disabled') {
    out.compactAt = null;
    out.toCompact = null;
    out.compactAtSource = 'disabled';
  } else if (fin(s.compactAt) && s.compactAt > 0) {
    out.compactAt = s.compactAt;
    out.toCompact = relative ? null : s.compactAt - used;
    out.compactAtSource = s.compactAtSource || null;
  }
  return out;
}

/**
 * An agent's own tokens for formatContext, tagged with whether its provider reports an auto-compact point and whether
 * its token counts were recorded at all.
 * @param {any} agent
 * @param {string} [provider]
 */
function agentContextTokens(agent, provider) {
  const tk = (agent && agent.tokens) || {};
  const out = provider && !hasCompactPoint(provider) ? { ...tk, compactUnknown: true } : tk;
  return agent && tokensUnknown(agent, provider) ? { ...out, unknown: true } : out;
}

const WINDOW_SOURCE_KEY = {
  'cost-state': 'src.window.costState', 'model-rule': 'src.window.modelRule', 'codex-record': 'src.window.codexRecord',
  'copilot-model': 'ctx.src.copilotModel', 'qwen-record': 'ctx.src.qwenRecord',
};
const COMPACT_SOURCE_KEY = {
  'settings-local': 'src.compact.settingsLocal', 'settings-project': 'src.compact.settingsProject',
  'settings-user': 'src.compact.settingsUser', observed: 'src.compact.observed', default: 'src.compact.default',
  disabled: 'src.compact.disabled',
};

/**
 * Explanation of where the window and auto-compact point come from (for the tooltip).
 * @param {ReturnType<typeof sessionContextTokens>} tokens
 * @param {string} provider
 * @param {any} i18n
 * @returns {{ windowText: string, compactText: string, compactShort: string, lines: string[] }}
 *   compactShort is a short form such as "~967K · official default" that fits in one cell (used in the session list tooltip table).
 */
function formatContextSources(tokens, provider, i18n) {
  /** @type {any} */
  const t = tokens || {};
  const wKey = WINDOW_SOURCE_KEY[t.windowSource];
  const cKey = COMPACT_SOURCE_KEY[t.compactAtSource];
  const windowText = fin(t.contextWindow) && t.contextWindow > 0
    ? i18n.t(wKey ? 'src.windowLine' : 'src.windowLine.plain', { window: i18n.fmtTokens(t.contextWindow), source: wKey ? i18n.t(wKey) : '' })
    : '';
  let compactText = '';
  let compactShort = '';
  if (t.compactAtSource === 'disabled') {
    compactText = i18n.t('src.compact.disabled');
    compactShort = i18n.t('src.compactShort.off');
  } else if (fin(t.compactAt) && t.compactAt > 0) {
    const tokensText = i18n.fmtTokens(t.compactAt);
    compactText = cKey
      ? i18n.t('src.compactLine', { tokens: tokensText, source: i18n.t(cKey) })
      : i18n.t('src.compactLine.plain', { tokens: tokensText });
    compactShort = cKey ? i18n.t('src.compactShort', { tokens: tokensText, source: i18n.t(cKey) }) : i18n.t('src.compactShort.plain', { tokens: tokensText });
  }
  const lines = [windowText, compactText];
  if (provider === 'claude') {
    lines.push(i18n.t('src.pctFormula'));
    if (t.compactAtSource !== 'disabled') lines.push(i18n.t('src.pctOverride'));
  }
  return { windowText, compactText, compactShort, lines: lines.filter(Boolean) };
}

/**
 * Byte count: 1000-based units (same as Finder); Intl writes the unit per language (7.7 MB, 7.7MB…). null / negative → —.
 * @param {number|null} bytes
 * @param {any} i18n
 */
function formatBytes(bytes, i18n) {
  const n = Number(bytes);
  if (bytes == null || !Number.isFinite(n) || n < 0) return i18n.fmtNum(null);
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
  let v = n;
  let u = 0;
  while (v >= 999.95 && u < units.length - 1) { v /= 1000; u++; }
  return i18n.fmtNum(v, {
    style: 'unit', unit: units[u], unitDisplay: u === 0 ? 'narrow' : 'short',
    maximumFractionDigits: u === 0 || v >= 100 ? 0 : 1,
  });
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * Equivalent API cost. null → "no public pricing" (when some models are unpriced) or "—"; append "+" to the amount
 * when part of it is unpriced.
 * @param {number|null} usd
 * @param {any} i18n
 * @param {{ unpriced?: boolean|number|string|null, estimated?: boolean }} [o]
 */
function formatCost(usd, i18n, o = {}) {
  const unpriced = !!o.unpriced;
  if (!fin(usd)) return unpriced ? i18n.t('cost.unpriced') : i18n.fmtUsd(null);
  let s = i18n.fmtUsd(usd) + (unpriced ? '+' : '');
  if (o.estimated) s += ' ' + i18n.t('cost.estimated');
  return s;
}

/**
 * Explanation for the cost tooltip (includes the price table date). Copilot bills in credits instead, so it gets its own note.
 * @param {any} i18n
 * @param {string} [provider]
 */
function formatCostNote(i18n, provider) {
  if (provider === 'copilot') return i18n.t('cost.copilot.note');
  // Gemini CLI and Qwen Code are priced from their own tables, updated separately
  const date = (provider === 'gemini' && pricing.GEMINI_PRICES_UPDATED) || (provider === 'qwen' && pricing.QWEN_PRICES_UPDATED) || PRICES_UPDATED;
  return i18n.t('cost.note', { date });
}

/** Copilot credits used by a session (session.copilot.credits, else main.copilotCredits); null when not recorded */
function copilotCredits(s) {
  if (!s) return null;
  if (s.copilot && fin(s.copilot.credits)) return s.copilot.credits;
  return s.main && fin(s.main.copilotCredits) ? s.main.copilotCredits : null;
}

/** "2.5 credits" */
function formatCredits(n, i18n) {
  return i18n.t('cost.credits', { n: i18n.fmtNum(n, { maximumFractionDigits: 2 }) });
}

/**
 * Cost of one agent for the table cell and the tooltip.
 * Copilot has no USD cost (costUsd is always null): the main agent shows the session's credits (the cell holds just the number,
 * under a "Credits" column header), sub-agents point at the session total.
 * @param {any} agent
 * @param {any} i18n
 * @param {{ provider?: string }} [o]
 * @returns {{ label: string, cell: string, full: string }}
 *   label: row title (API-equivalent cost / Copilot credits); cell: short text for the table ("—" without a price);
 *   full: the whole explanation (no public price, estimate marker, credits note)
 */
function formatAgentCost(agent, i18n, o = {}) {
  const a = agent || {};
  if (o.provider === 'copilot') {
    const n = a.kind === 'main' && fin(a.copilotCredits) ? a.copilotCredits : null;
    if (n != null) return { label: i18n.t('cost.credits.label'), cell: i18n.fmtNum(n, { maximumFractionDigits: 2 }), full: formatCredits(n, i18n) };
    const why = i18n.t(a.kind === 'main' ? 'cost.credits.none' : 'cost.credits.inSession');
    return { label: i18n.t('cost.credits.label'), cell: i18n.fmtUsd(null), full: why };
  }
  const full = formatCost(a.costUsd, i18n, { unpriced: a.unpricedModel, estimated: a.costEstimated });
  // Without a price the cell shows only "—"; the full explanation (no public pricing / estimate) goes in the hover tooltip
  const cell = fin(a.costUsd) ? formatCost(a.costUsd, i18n, { unpriced: a.unpricedModel }) : i18n.fmtUsd(null);
  return { label: i18n.t('cost.label'), cell, full };
}

/**
 * Token breakdown some providers record per agent (Gemini CLI: input incl. cached, cached, thoughts, tool-use prompt);
 * '' when the agent has none.
 * @param {any} tokens AgentTokens
 */
function formatTokenBreakdown(tokens, i18n) {
  const t = tokens || {};
  if (!fin(t.input)) return '';
  return i18n.t('count.breakdown', {
    input: i18n.fmtTokens(t.input), cached: i18n.fmtTokens(fin(t.cached) ? t.cached : 0),
    thoughts: i18n.fmtTokens(fin(t.thoughts) ? t.thoughts : 0), tool: i18n.fmtTokens(fin(t.tool) ? t.tool : 0),
  });
}

/**
 * Session cost: prefer Claude Code's own cost-state.totalCostUSD (labeled "Claude Code stats"),
 * otherwise the extension's estimate from the price table. If neither exists → text is ''.
 * Copilot: the session's credits (credits = true); '' when this VS Code version doesn't record them.
 * @param {any} s Session
 * @returns {{ text: string, fromClaudeCode: boolean, estimateText: string, credits: boolean, label: string }}
 *   estimateText: the extension's own estimate (shown in the tooltip for comparison when Claude Code stats exist);
 *   label: row title for tooltips (API-equivalent cost / Copilot credits)
 */
function formatSessionCost(s, i18n) {
  if (s && s.provider === 'copilot') {
    const n = copilotCredits(s);
    return { text: n != null ? formatCredits(n, i18n) : '', fromClaudeCode: false, estimateText: '', credits: true, label: i18n.t('cost.credits.label') };
  }
  const label = i18n.t('cost.label');
  const unpriced = !!(s && s.main && s.main.unpricedModel);
  const estimate = s && (fin(s.costUsd) || unpriced) ? formatCost(s.costUsd, i18n, { unpriced }) : '';
  if (s && fin(s.ccCostUsd)) {
    return { text: i18n.t('src.ccCost', { usd: i18n.fmtUsd(s.ccCostUsd) }), fromClaudeCode: true, estimateText: estimate, credits: false, label };
  }
  return { text: estimate, fromClaudeCode: false, estimateText: estimate, credits: false, label };
}

/**
 * Today's total.
 * @param {import('./core/status').DailyTotals|null} today
 * @returns {{ usd: number|null, text: string, partialText: string, lines: string[] }}
 */
function formatToday(today, i18n) {
  if (!today) return { usd: null, text: i18n.fmtUsd(null), partialText: '', lines: [] };
  const c = today.claude || {};
  const x = today.codex || {};
  const usd = (Number(c.costUsd) || 0) + (Number(x.costUsd) || 0);
  const unpricedTokens = (Number(c.unpricedTokens) || 0) + (Number(x.unpricedTokens) || 0);
  const text = formatCost(usd, i18n, { unpriced: unpricedTokens > 0 });
  const partialText = today.partial ? i18n.t('cost.partial', { pct: i18n.fmtPct(today.progress || 0) }) : '';
  const lines = [];
  for (const [provider, part] of [['claude', c], ['codex', x]]) {
    for (const [model, v] of Object.entries(part.byModel || {})) {
      lines.push(providerLabel(provider, i18n) + SEP + i18n.t('cost.byModel', { model, usd: formatCost(v && v.costUsd, i18n, { unpriced: v && v.costUsd == null }) }));
    }
  }
  if (unpricedTokens > 0) lines.push(i18n.t('cost.unpricedTokens', { tokens: i18n.fmtTokens(unpricedTokens) }));
  return { usd, text, partialText, lines };
}

// ---------------------------------------------------------------------------
// Usage limits
// ---------------------------------------------------------------------------

/**
 * Lines of text for Codex account usage limits (status bar tooltip, usage-limit banner in the panel).
 * @param {import('./core/status').QuotaSnapshot['codex']|null} q
 * @returns {{ title: string, lines: string[] }}
 */
function formatCodexQuota(q, i18n, now = Date.now()) {
  const lines = [];
  if (!q) return { title: i18n.t('quota.codex.title'), lines };
  for (const w of q.windows || []) {
    const label = w.label === '5h' ? i18n.t('quota.window.5h')
      : w.label === 'weekly' ? i18n.t('quota.window.weekly')
        : i18n.t('quota.window.minutes', { n: w.minutes });
    if (isWindowReset(w, now)) { lines.push(i18n.t('quota.window.reset', { label })); continue; }
    let s = i18n.t('quota.window.used', { label, pct: i18n.fmtPct((Number(w.usedPct) || 0) / 100) });
    if (fin(w.resetsAtMs)) s += SEP + i18n.t('quota.window.resetAt', { reset: i18n.fmtClock(w.resetsAtMs, now) });
    lines.push(s);
  }
  if (q.reachedType) lines.push(i18n.t('quota.codex.reached', { type: q.reachedType }));
  if (q.planType) lines.push(i18n.t('quota.codex.plan', { plan: q.planType }));
  if (q.credits) {
    if (q.credits.unlimited) lines.push(i18n.t('quota.codex.unlimited'));
    else if (q.credits.balance != null) lines.push(i18n.t('quota.codex.credits', { balance: q.credits.balance }));
  }
  if (fin(q.observedMs)) lines.push(i18n.t('quota.codex.observed', { ago: i18n.fmtAgo(q.observedMs, now) }));
  return { title: i18n.t('quota.codex.title'), lines };
}

/**
 * A provider's most recent usage-limit hit (account-wide, QuotaSnapshot[provider].lastHit); returns '' if there is none.
 * "Last Copilot limit hit: Usage limit reached (5m ago)"
 * @param {string} provider claude / copilot / gemini / qwen
 * @param {(import('./core/status').QuotaHit & { ms: number })|null} lastHit
 */
function formatLastHit(provider, lastHit, i18n, now = Date.now()) {
  if (!lastHit || typeof lastHit !== 'object') return '';
  const vars = { what: formatQuotaHit(lastHit, i18n, now, { stable: true }), ago: fin(lastHit.ms) ? i18n.fmtAgo(lastHit.ms, now) : '' };
  if (provider === 'claude' && vars.ago) return i18n.t('quota.claude.lastHit', vars);
  return i18n.t(vars.ago ? 'quota.lastHit' : 'quota.lastHit.noTime', { ...vars, provider: providerLabel(provider, i18n) });
}

/**
 * Claude's most recent usage-limit hit (account-wide); returns '' if it has never hit one.
 * @param {(import('./core/status').QuotaHit & { ms: number })|null} lastHit
 */
function formatClaudeLastHit(lastHit, i18n, now = Date.now()) {
  return formatLastHit('claude', lastHit, i18n, now);
}

/**
 * Every provider's most recent usage-limit hit, one line each (status bar tooltip, terminal footer); Codex's quota windows
 * are formatted separately by formatCodexQuota.
 * @param {Partial<import('./core/status').QuotaSnapshot>|null} quota
 * @param {any} i18n
 * @param {number} [now]
 * @returns {string[]}
 */
function formatLastHits(quota, i18n, now = Date.now()) {
  const q = quota || {};
  return LAST_HIT_PROVIDERS.map((p) => formatLastHit(p, q[p] && q[p].lastHit, i18n, now)).filter(Boolean);
}

/**
 * Whether the panel should still mention a provider's last limit hit: until its reset time when one is known
 * (Claude), otherwise for an hour after the hit (Copilot, Gemini CLI and Qwen Code report no reset time).
 * @param {(import('./core/status').QuotaHit & { ms: number })|null} lastHit
 * @param {number} [now]
 */
function isRecentHit(lastHit, now = Date.now()) {
  if (!lastHit || typeof lastHit !== 'object') return false;
  if (fin(lastHit.resetsAtMs)) return lastHit.resetsAtMs > now;
  return fin(lastHit.ms) && lastHit.ms <= now + 60e3 && now - lastHit.ms < RECENT_HIT_MS;
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

/**
 * One sentence on the cost of resuming. For Claude, a single number depending on whether the cache has expired;
 * Codex's cache state is unknown, so give a range.
 * @param {import('./core/status').ResumeEstimate|null} est
 */
function formatResumeEstimate(est, i18n) {
  // Context is 0 or unknown: nothing to estimate, so don't write sentences like "re-reads about 0 tokens"
  if (!est || !(Number(est.contextTokens) > 0)) return '';
  const tokens = i18n.fmtTokens(est.contextTokens);
  if (est.cacheLikelyExpired == null) {
    if (!fin(est.usdIfHit) && !fin(est.usdIfMiss)) return '';
    return i18n.t('resume.estimate.range', { tokens, low: i18n.fmtUsd(est.usdIfHit), high: i18n.fmtUsd(est.usdIfMiss) });
  }
  if (est.cacheLikelyExpired) return i18n.t('resume.estimate.expired', { tokens, usd: i18n.fmtUsd(est.usdIfMiss) });
  return i18n.t('resume.estimate.valid', { tokens, usd: i18n.fmtUsd(est.usdIfHit) });
}

/**
 * All the text for one resume hint: button label, prompt, terminal command, copyable form, cost, extra notes.
 * When copying, the extension side calls this function again to build the text (it does not trust text sent from the webview).
 * @param {import('./core/status').ResumeHint} hint
 * @param {any} i18n
 * @param {{ now?: number, platform?: string }} [o]
 * @returns {{ kind: string, label: string, prompt: string, command: string|null, variants: ('cli'|'prompt')[],
 *   estimateText: string, noteText: string }}
 */
function formatResumeHint(hint, i18n, o = {}) {
  const now = o.now ?? Date.now();
  const p = resumePrompt(hint);
  const prompt = i18n.t(p.key, p.vars);
  const variants = resumeVariants(hint);
  const command = variants.includes('cli') ? resumeCommand(hint, prompt, { platform: o.platform }) : null;
  let label;
  switch (hint && hint.kind) {
    case 'claudeSubagent': {
      const name = hint.name || hint.agentType || hint.agentId;
      label = i18n.t(hint.resumable ? 'resume.label.claudeSubagent' : 'resume.label.claudeSubagentRerun', { name });
      break;
    }
    case 'claudeWorkflow': label = i18n.t('resume.label.claudeWorkflow', { name: hint.workflowName || hint.runId }); break;
    case 'codexThread': label = i18n.t('resume.label.codexThread'); break;
    case 'codexSubagent': label = i18n.t('resume.label.codexSubagent', { name: hint.nickname || hint.threadId }); break;
    default: label = i18n.t('resume.label.claudeSession');
  }
  let noteText = '';
  if (hint && hint.kind === 'claudeWorkflow' && hint.paused) noteText = i18n.t('resume.workflowPaused');
  else if (hint && hint.kind === 'claudeSession' && hint.quota && hint.autoContinue !== false
    && fin(hint.quota.resetsAtMs) && hint.quota.resetsAtMs > now) {
    noteText = i18n.t('resume.autoContinue', { reset: i18n.fmtClock(hint.quota.resetsAtMs, now) });
  }
  return {
    kind: (hint && hint.kind) || 'claudeSession',
    label, prompt, command: command || null, variants,
    estimateText: formatResumeEstimate(hint && hint.estimate, i18n),
    noteText,
  };
}

// ---------------------------------------------------------------------------
// Agents, workflows, details
// ---------------------------------------------------------------------------

/**
 * Agent name: main agent → "Main agent"; unnamed review thread → "Review"; otherwise the raw name / type / first 8 chars of the id.
 * Copilot sub-agents carry the task description separately (their name is the agent type), so the description is the name,
 * like the task description Claude subagents are named after.
 */
function formatAgentName(agent, i18n) {
  if (!agent) return '';
  if (agent.kind === 'main') return i18n.t('agent.main');
  if (agent.description) return String(agent.description);
  if (agent.name) return String(agent.name);
  if (agent.kind === 'codexReviewer') return i18n.t('agent.reviewer');
  if (agent.agentType) return String(agent.agentType);
  return i18n.t(KIND_KEY[agent.kind] || 'agent.subagent') + ' ' + String(agent.id || '').slice(0, 8);
}

/** Type description: Subagent · Explore · Phase 2 · Background */
function formatAgentKind(agent, i18n) {
  if (!agent) return '';
  const parts = [i18n.t(KIND_KEY[agent.kind] || 'agent.subagent')];
  // Named after its description (Copilot): the agent's own name / type goes here instead
  if (agent.description && (agent.name || agent.agentType)) parts.push(String(agent.name || agent.agentType));
  // Workflow agents always have type workflow-subagent (sample transcripts show workflow-agent), which just repeats
  // "Workflow agent", so leave it out
  else if (agent.agentType && agent.name && !(agent.kind === 'workflowAgent' && /^workflow-(sub)?agent$/.test(agent.agentType))) parts.push(String(agent.agentType));
  if (agent.phase) parts.push(i18n.t('workflow.phase', { phase: agent.phase }));
  if (agent.background) parts.push(i18n.t('agent.background'));
  return parts.join(SEP);
}

/** One workflow line: name, status, progress */
function formatWorkflow(w, i18n) {
  if (!w) return { name: '', stateText: '', progressText: '', phaseText: '' };
  const k = 'workflow.' + w.state;
  return {
    name: String(w.name || w.id || ''),
    stateText: i18n.has(k) ? i18n.t(k) : String(w.state || ''),
    progressText: i18n.t('workflow.progress', { done: w.done || 0, total: w.total || 0 }),
    phaseText: w.phases && w.phases.length ? i18n.t('workflow.phase', { phase: w.phases.join('/') }) : '',
  };
}

/** One timeline entry */
function formatTimelineEvent(ev, i18n) {
  if (!ev) return '';
  const tool = toolLabel(ev.tool, i18n);
  const detail = ev.detail || '';
  switch (ev.kind) {
    case 'prompt': return detail ? i18n.t('timeline.prompt', { detail }) : i18n.t('detail.prompt.noDetail');
    case 'tool': return detail ? i18n.t('timeline.tool', { tool, detail }) : tool;
    case 'toolDone': return i18n.t('timeline.toolDone', { tool });
    case 'toolError': return i18n.t('timeline.toolError', { tool });
    case 'text': return detail ? i18n.t('timeline.text', { detail }) : '';
    default: {
      const k = 'timeline.' + ev.kind;
      return i18n.has(k) ? i18n.t(k) : String(ev.kind || '');
    }
  }
}

/** Changed files: operation + count */
function formatFileOp(f, i18n) {
  if (!f) return '';
  let s = f.op === 'move' ? i18n.t('file.op.move', { to: f.movedTo || '' }) : i18n.t('file.op.' + (f.op || 'edit'));
  if (f.count > 1) s += SEP + i18n.t('file.count', { n: f.count });
  return s;
}

/** Cache time left for the session bar; '' for Codex / unknown. The webview refreshes this spot on its own every 30 seconds */
function formatCacheLeft(expiresMs, i18n, now = Date.now()) {
  if (!fin(expiresMs)) return '';
  if (expiresMs <= now) return i18n.t('session.cacheExpired');
  return i18n.t('session.cacheLeft', { m: Math.max(1, Math.ceil((expiresMs - now) / 60e3)) });
}

// ---------------------------------------------------------------------------
// Session list rows
// ---------------------------------------------------------------------------

/**
 * One-line status for a session (the line that decides the session lamp; prefixed with the agent name when it isn't the main agent).
 * @param {any} session
 * @param {ReturnType<typeof lampLib.sessionLamps>} [lamps]
 */
function formatSessionStatus(session, i18n, now = Date.now(), opts = {}, lamps) {
  const L = lamps || lampLib.sessionLamps(session, { seenAtMs: opts.seenAtMs, staleAsNeedsYou: opts.staleAsNeedsYou });
  const lead = L.lead;
  const isMain = !lead || lead.rowId === ROW_MAIN;
  const agent = isMain ? session.main : lead.agent;
  const st = isMain ? L.main.status : lead.status;
  const text = formatStatus(st, agent, i18n, now, { ...opts, isMain });
  if (isMain) return text;
  return i18n.t('row.agentStatus', { name: clip(formatAgentName(agent, i18n), NAME_MAX), status: text });
}

/**
 * Session list row: label, description ({provider} · {one-line status} · {context percent}), a11y.
 * description has nothing that changes every second: it changes only when the status or context really changes.
 * @param {any} session
 * @param {any} i18n
 * @param {{ lamps?: ReturnType<typeof lampLib.sessionLamps>, seenAtMs?: number, staleAsNeedsYou?: boolean, now?: number }} [o]
 * @returns {{ label: string, description: string, statusText: string, contextText: string, lampText: string, a11y: string }}
 */
function formatSessionRow(session, i18n, o = {}) {
  const now = o.now ?? Date.now();
  const L = o.lamps || lampLib.sessionLamps(session, { seenAtMs: o.seenAtMs, staleAsNeedsYou: o.staleAsNeedsYou });
  const statusText = formatSessionStatus(session, i18n, now, { stable: true, staleAsNeedsYou: o.staleAsNeedsYou }, L);
  const ctx = formatContext(sessionContextTokens(session), i18n);
  const parts = [providerLabel(session.provider, i18n), statusText];
  if (ctx.shortText) parts.push(ctx.shortText);
  const lampText = lampLabel(L.lamp, i18n);
  const label = String(session.title || session.id || '');
  return {
    label,
    description: parts.join(SEP),
    statusText,
    contextText: ctx.shortText,
    lampText,
    a11y: [label, lampText, ...parts].join(', '),
  };
}

/**
 * Hover tooltip for a session list row (plain-text [label, value] pairs; the caller turns them into an escaped
 * Markdown table). Nothing that changes every second.
 * @returns {[string, string][]}
 */
function formatSessionTooltip(session, i18n, o = {}) {
  const now = o.now ?? Date.now();
  const L = o.lamps || lampLib.sessionLamps(session, { seenAtMs: o.seenAtMs, staleAsNeedsYou: o.staleAsNeedsYou });
  const rows = [];
  const status = formatSessionStatus(session, i18n, now, { stable: true, staleAsNeedsYou: o.staleAsNeedsYou }, L);
  rows.push([i18n.t('tip.status'), lampLabel(L.lamp, i18n) + SEP + status]);
  const note = [formatStatusNote(L.lead && L.lead.status, i18n), formatProviderNote(session.provider, i18n)].filter(Boolean).join(' ');
  if (note) rows.push([i18n.t('tip.note'), note]);
  rows.push([i18n.t('tip.entry'), providerLabel(session.provider, i18n) + SEP + entryLabel(session.entry, i18n)
    + SEP + formatLive(session, i18n)]);
  if (session.cwd) rows.push([i18n.t('tip.folder'), String(session.cwd)]);
  rows.push([i18n.t('tip.id'), String(session.id || '')]);
  if (session.model) rows.push([i18n.t('tip.model'), String(session.modelVariant || session.model)]);
  const tk = sessionContextTokens(session);
  const ctx = formatContext(tk, i18n);
  const ctxText = [ctx.usageText, ctx.remainText, ctx.pctOfWindowText].filter(Boolean).join(SEP);
  if (ctxText) rows.push([i18n.t('ctx.label'), ctxText]);
  const src = formatContextSources(tk, session.provider, i18n);
  if (src.compactShort) rows.push([i18n.t('tip.autoCompact'), src.compactShort]);
  if (fin(session.cacheExpiresMs)) rows.push([i18n.t('tip.cache'), i18n.t('session.cacheExpiresAt', { time: i18n.fmtClock(session.cacheExpiresMs, now) })]);
  if (o.showCost !== false) {
    const cost = formatSessionCost(session, i18n);
    if (cost.text) rows.push([cost.label, cost.text]);
  }
  const c = session.counts;
  if (c && c.total > 0) rows.push([i18n.t('tip.agents'), i18n.t('tip.agentCounts', { total: c.total, running: c.running || 0 })]);
  if (fin(session.startedMs)) rows.push([i18n.t('tip.started'), i18n.fmtDateTime(session.startedMs)]);
  return rows;
}

/**
 * contextValue for session nodes (menu `when` clauses use viewItem =~ /\bxxx\b/):
 * session provider-<p> lamp-<lamp> [quota] [resumable] [compactable] [live]
 */
function sessionContextValue(session, lamp) {
  const parts = ['session', 'provider-' + session.provider, 'lamp-' + (lamp || S.LAMP.IDLE)];
  const st = session.main && session.main.status;
  if (st && st.code === S.STATUS.QUOTA) parts.push('quota');
  if (session.resume && session.resume.length) parts.push('resumable');
  const used = session.main && session.main.tokens ? Number(session.main.tokens.contextUsed) || 0 : 0;
  if ((session.provider === 'claude' || session.provider === 'codex') && used >= COMPACTABLE_MIN) parts.push('compactable');
  if (session.live) parts.push('live');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Status bar summary lamp and view badge
// ---------------------------------------------------------------------------

/**
 * Status bar text: $(circle-large-filled) 2 need you · 1 error · 3 working; all zero → $(circle-large-outline) no agents running.
 * @param {{ needsYou: number, error: number, doneUnseen: number, working: number }} counts
 */
function formatStatusBarText(counts, i18n) {
  const c = counts || {};
  const parts = [];
  for (const l of ['needsYou', 'error', 'doneUnseen', 'working']) {
    if (c[l] > 0) parts.push(i18n.t('bar.count', { n: c[l], label: lampLabel(l, i18n, true) }));
  }
  if (!parts.length) return '$(circle-large-outline) ' + i18n.t('bar.idle');
  return '$(circle-large-filled) ' + parts.join(SEP);
}

/**
 * Session lines in the status bar tooltip: "lamp name · title · one-line status", at most max lines; the rest become "n more".
 * @param {any[]} sessions already sorted in session list order
 * @param {Map<string, ReturnType<typeof lampLib.sessionLamps>>} bySession
 */
function formatStatusBarLines(sessions, bySession, i18n, now = Date.now(), max = 15) {
  const lines = [];
  const list = sessions || [];
  for (const s of list.slice(0, max)) {
    const L = bySession && bySession.get(s.key);
    const lamp = L ? L.lamp : S.LAMP.IDLE;
    lines.push([lampLabel(lamp, i18n), clip(s.title || s.id, 60), formatSessionStatus(s, i18n, now, { stable: true }, L)].join(SEP));
  }
  if (list.length > max) lines.push(i18n.t('bar.more', { n: list.length - max }));
  return lines;
}

/** View badge: number of sessions that need you + tooltip (lists the three counts separately) */
function formatBadge(counts, i18n) {
  const c = counts || {};
  const value = lampLib.attentionCount(c);
  const parts = [];
  if (c.needsYou) parts.push(i18n.t('badge.needsYou', { n: c.needsYou }));
  if (c.error) parts.push(i18n.t('badge.error', { n: c.error }));
  if (c.doneUnseen) parts.push(i18n.t('badge.doneUnseen', { n: c.doneUnseen }));
  return { value, tooltip: parts.join(SEP) };
}

/** Scope name and empty-list hint */
function formatScope(scope, i18n) {
  const s = scope === 'workspace' ? 'workspace' : 'all';
  return { label: i18n.t('scope.' + s), empty: i18n.t('scope.empty.' + s) };
}

/** Session list group header */
function formatGroup(groupId, i18n) {
  return i18n.t(groupId === 'open' ? 'group.open' : 'group.recent');
}

module.exports = {
  SEP, COMPACTABLE_MIN,
  toolLabel, providerLabel, hasCompactPoint, entryLabel, lampLabel,
  formatStatus, formatStatusNote, formatProviderNote, formatLive, markGuess, formatQuotaHit, formatAutoContinue,
  formatStep, formatContext, contextPct, sessionContextTokens, agentContextTokens, tokensUnknown, formatTokensUnknownNote,
  formatContextSources, formatBytes,
  formatCost, formatCostNote, formatSessionCost, formatAgentCost, formatCredits, copilotCredits, formatTokenBreakdown, formatToday,
  formatCodexQuota, formatClaudeLastHit, formatLastHit, formatLastHits, isRecentHit, LAST_HIT_PROVIDERS,
  formatResumeEstimate, formatResumeHint,
  formatAgentName, formatAgentKind, formatWorkflow, formatTimelineEvent, formatFileOp, formatCacheLeft,
  formatSessionStatus, formatSessionRow, formatSessionTooltip, sessionContextValue,
  formatStatusBarText, formatStatusBarLines, formatBadge, formatScope, formatGroup,
};
