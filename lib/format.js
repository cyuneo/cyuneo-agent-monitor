'use strict';
// 界面层唯一拼句子的地方（DESIGN §2.6、§6.4、§7.2、§8.2、§8.5、§11.2）。
// worker 只给代码、数字、时间戳和原文片段；这里按 i18n 实例拼成当前语言的文字。
// 约定：
// - 所有函数第一个参数是数据，i18n 实例（lib/i18n.js 的 createI18n / fromPayload）紧随其后，now 可注入。
// - opts.stable = true：不含逐秒变化的内容（用时、倒计时），给左侧会话行和悬停提示用（§11.2），
//   这样只有内容真变了才需要刷新行。右侧表格不传 stable，可以带时长。
// - 用户原文（工具参数、标题、报错）原样插入，不做转义；Markdown / HTML 转义由调用方负责。

const S = require('./core/status');
const { PRICES_UPDATED } = require('./core/pricing');
const { resumePrompt, resumeVariants, resumeCommand } = require('./core/resume');
const { isWindowReset } = require('./core/quota');
const lampLib = require('./lamp');
const { ROW_MAIN } = require('./order');

const SEP = ' · ';
const QUOTA_KINDS = new Set(['session', 'weekly', 'model', 'spend', 'window', 'unknown']);
const KIND_KEY = {
  main: 'agent.main', subagent: 'agent.subagent', workflowAgent: 'agent.workflowAgent',
  codexSubagent: 'agent.codexSubagent', codexReviewer: 'agent.reviewer',
};
// §11.4：上下文 ≥ 20000 的会话才给压缩按钮
const COMPACTABLE_MIN = 20000;
const NAME_MAX = 24;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clip = (s, n) => {
  const a = Array.from(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
  return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join('');
};

// ---------------------------------------------------------------------------
// 小件
// ---------------------------------------------------------------------------

/**
 * 工具名显示（不翻译）：mcp__claude_ai_Notion__notion-search → Notion·notion-search；
 * mcp__codex_apps__github_fetch → codex_apps·github_fetch；空 → 词典 tool.generic。
 * @param {string|null} name
 * @param {any} [i18n]
 */
function toolLabel(name, i18n) {
  if (!name) return i18n ? i18n.t('tool.generic') : 'tool';
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name));
  if (m) return m[1].replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '') + '·' + m[2];
  return String(name);
}

/** 'claude' → Claude，'codex' → Codex（产品名不翻译，但走词典以便统一） */
function providerLabel(provider, i18n) {
  return provider === 'codex' || provider === 'claude' ? i18n.t('provider.' + provider) : String(provider || '');
}

/** 入口：vscode / cli / desktop / sdk / exec / other */
function entryLabel(entry, i18n) {
  const k = 'entry.' + (entry || 'other');
  return i18n.has(k) ? i18n.t(k) : i18n.t('entry.other');
}

/** 灯名（§9.4），short = true 用状态栏的短写 */
function lampLabel(lamp, i18n, short = false) {
  const l = S.LAMPS.includes(lamp) ? lamp : S.LAMP.IDLE;
  return i18n.t('lamp.' + l + (short ? '.short' : ''));
}

// ---------------------------------------------------------------------------
// 状态（§2.5、§11.1、决定 4）
// ---------------------------------------------------------------------------

/**
 * 额度撞线的一句话：标题 + 重置时间。
 * @param {import('./core/status').QuotaHit|null} hit
 * @param {any} i18n
 * @param {number} [now]
 * @param {{ stable?: boolean }} [opts] stable：不写“还剩多久”
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
 * 撞额度后的补充说明（自动继续），没有就返回 ''。
 * @param {import('./core/status').QuotaHit|null} hit
 */
function formatAutoContinue(hit, i18n, now = Date.now()) {
  if (!hit || hit.autoContinue === false || !fin(hit.resetsAtMs) || hit.resetsAtMs <= now) return '';
  return i18n.t('quota.autoContinue', { reset: i18n.fmtClock(hit.resetsAtMs, now) });
}

/**
 * 一句状态。
 * @param {import('./core/status').AgentStatus|null} status
 * @param {{ kind?: string }|null} agent 用来区分主智能体（done → “本轮完成”）
 * @param {any} i18n
 * @param {number} [now]
 * @param {{ stable?: boolean, isMain?: boolean, staleAsNeedsYou?: boolean }} [opts]
 */
function formatStatus(status, agent, i18n, now = Date.now(), opts = {}) {
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

/** 推测状态的说明（tooltip 用）；确定状态返回 '' */
function formatStatusNote(status, i18n) {
  return status && S.isGuessCode(status.code) ? i18n.t('status.guess.note') : '';
}

// ---------------------------------------------------------------------------
// 步骤（§2.6）
// ---------------------------------------------------------------------------

/**
 * 当前步骤。done / interrupted 时不显示（最后回复放细节里）。
 * @param {import('./core/status').Step|null} step
 * @param {import('./core/status').AgentStatus|null} status
 * @param {any} i18n
 * @param {number} [now]
 * @param {{ withDur?: boolean }} [opts] withDur：后面接“· 用时”（右侧表格）
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
// 上下文（§6.1、§11.2）
// ---------------------------------------------------------------------------

/**
 * 百分比按 Claude Code 自己的算法（§11.10，打包代码 KJt）：round(已用 / 窗口 × 100)，夹在 0–100。
 * @param {number} used
 * @param {number} window
 * @returns {number|null}
 */
function contextPct(used, window) {
  if (!fin(window) || window <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((Math.max(0, Number(used) || 0) / window) * 100)));
}

/** 百分数文字：很小但非零时写“<1%”，不写“0%” */
function formatPctValue(pct, used, i18n) {
  if (pct == null) return '';
  if (pct === 0 && used > 0) return '<' + i18n.fmtPct(0.01);
  return i18n.fmtPct(pct / 100);
}

/**
 * 上下文占用。进度条是“已用 / 自动压缩阈值”；阈值不知道时退回窗口。
 * 百分比一律按窗口算（Claude Code 的公式，§11.10），不是占阈值的比例；窗口不知道时退回阈值。
 * @param {import('./core/status').AgentTokens|null} tokens
 * @param {any} i18n
 * @returns {{ used: number, limit: number|null, window: number|null, ratio: number|null, pct: number|null,
 *   pctText: string, pctOfWindowText: string, usageText: string, shortText: string, remainText: string, notes: string[] }}
 *   ratio = 已用 / 进度条上限（给进度条）；pct = 占窗口的整数百分比；shortText 给左侧行（“42% 上下文”）；
 *   pctOfWindowText 是“占 1M 窗口的 41%”；remainText 是“离自动压缩还有 …”或“自动压缩已关”。
 */
function formatContext(tokens, i18n) {
  const t = tokens || {};
  const used = Math.max(0, Number(t.contextUsed) || 0);
  const relative = fin(t.compactAt) && t.toCompact == null; // Codex body_after_prefix
  const window = fin(t.contextWindow) && t.contextWindow > 0 ? t.contextWindow : null;
  let limit = null;
  if (fin(t.compactAt) && t.compactAt > 0 && !relative) limit = t.compactAt;
  else if (window) limit = window;
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
  else if (t.compactAt == null && window) remainText = i18n.t('ctx.autoCompactOff');
  return {
    used, limit, window, ratio, pct, pctText,
    pctOfWindowText: window && pctText ? i18n.t('tip.pctOfWindow', { pct: pctText, window: i18n.fmtTokens(window) }) : '',
    usageText,
    shortText: pctText ? i18n.t('row.context', { pct: pctText }) : '',
    remainText, notes,
  };
}

/**
 * 会话级的上下文数据（§11.10）：窗口和压缩点以 Session.contextWindow / compactAt 为准
 * （providers 按 Claude Code / Codex 自己的规则算好并标了来源），缺失时退回主智能体 tokens 里的同名字段。
 * @param {any} s Session
 * @returns {import('./core/status').AgentTokens & { windowSource: string|null, compactAtSource: string|null }}
 */
function sessionContextTokens(s) {
  /** @type {any} */
  const tk = (s && s.main && s.main.tokens) || {};
  /** @type {any} */
  const out = { ...tk, windowSource: null, compactAtSource: null };
  if (!s) return out;
  const used = Math.max(0, Number(tk.contextUsed) || 0);
  if (fin(s.contextWindow) && s.contextWindow > 0) {
    out.contextWindow = s.contextWindow;
    out.windowSource = s.contextWindowSource || null;
  }
  const relative = fin(tk.compactAt) && tk.toCompact == null; // Codex body_after_prefix：剩余量不可算
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

const WINDOW_SOURCE_KEY = {
  'cost-state': 'src.window.costState', 'model-rule': 'src.window.modelRule', 'codex-record': 'src.window.codexRecord',
};
const COMPACT_SOURCE_KEY = {
  'settings-local': 'src.compact.settingsLocal', 'settings-project': 'src.compact.settingsProject',
  'settings-user': 'src.compact.settingsUser', observed: 'src.compact.observed', default: 'src.compact.default',
  disabled: 'src.compact.disabled',
};

/**
 * 窗口与自动压缩点的来源说明（tooltip 用，§11.10 第 4 条）。
 * @param {ReturnType<typeof sessionContextTokens>} tokens
 * @param {string} provider
 * @param {any} i18n
 * @returns {{ windowText: string, compactText: string, compactShort: string, lines: string[] }}
 *   compactShort 是“约 967K · 官方默认”这种一格能放下的写法（左侧提示的表格用）。
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
 * 字节数：按 1000 进位（和 Finder 一致），单位由 Intl 按语言写（7.7 MB、7.7MB…）。null / 负数 → —。
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
// 费用（§6.4）
// ---------------------------------------------------------------------------

/**
 * 等价 API 费用。null → “无公开价格”（有未定价模型时）或 “—”；有未定价的部分时金额后加 “+”。
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

/** 费用 tooltip 的说明（带价格表日期） */
function formatCostNote(i18n) {
  return i18n.t('cost.note', { date: PRICES_UPDATED });
}

/**
 * 会话费用（§11.10）：优先用 Claude Code 自己算的 cost-state.totalCostUSD（标“Claude Code 统计”），
 * 没有时用插件按价格表的估算。都没有 → text 为 ''。
 * @param {any} s Session
 * @returns {{ text: string, fromClaudeCode: boolean, estimateText: string }}
 *   estimateText：插件自己的估算（有 Claude Code 统计时放 tooltip 里对照）
 */
function formatSessionCost(s, i18n) {
  const unpriced = !!(s && s.main && s.main.unpricedModel);
  const estimate = s && (fin(s.costUsd) || unpriced) ? formatCost(s.costUsd, i18n, { unpriced }) : '';
  if (s && fin(s.ccCostUsd)) {
    return { text: i18n.t('src.ccCost', { usd: i18n.fmtUsd(s.ccCostUsd) }), fromClaudeCode: true, estimateText: estimate };
  }
  return { text: estimate, fromClaudeCode: false, estimateText: estimate };
}

/**
 * 今日合计（§6.2）。
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
// 额度（§4.3、§4.7）
// ---------------------------------------------------------------------------

/**
 * Codex 账号额度的几行文字（状态栏 tooltip、右侧额度横幅）。
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
 * Claude 最近一次撞额度（账号级，§4.3）；没有撞过返回 ''。
 * @param {(import('./core/status').QuotaHit & { ms: number })|null} lastHit
 */
function formatClaudeLastHit(lastHit, i18n, now = Date.now()) {
  if (!lastHit) return '';
  return i18n.t('quota.claude.lastHit', {
    what: formatQuotaHit(lastHit, i18n, now, { stable: true }),
    ago: i18n.fmtAgo(lastHit.ms, now),
  });
}

// ---------------------------------------------------------------------------
// 续跑（§7）
// ---------------------------------------------------------------------------

/**
 * 续跑代价一句话（§7.3）。Claude 按缓存是否过期给一个数；Codex 缓存不可知，给区间。
 * @param {import('./core/status').ResumeEstimate|null} est
 */
function formatResumeEstimate(est, i18n) {
  // 上下文为 0 或不知道：没有可估的东西，不写“重读约 0 token”这种句子
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
 * 一条续跑提示的全部文字：按钮名、提示词、终端命令、可复制的形式、代价、补充说明。
 * 复制时由扩展端重新调用本函数生成文本（不信任 webview 传来的文字）。
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
// 智能体、工作流、细节
// ---------------------------------------------------------------------------

/** 智能体名：主智能体 → “主智能体”；审阅线程没名字 → “审阅”；其余用原文名 / 类型 / id 前 8 位 */
function formatAgentName(agent, i18n) {
  if (!agent) return '';
  if (agent.kind === 'main') return i18n.t('agent.main');
  if (agent.name) return String(agent.name);
  if (agent.kind === 'codexReviewer') return i18n.t('agent.reviewer');
  if (agent.agentType) return String(agent.agentType);
  return i18n.t(KIND_KEY[agent.kind] || 'agent.subagent') + ' ' + String(agent.id || '').slice(0, 8);
}

/** 类型说明：子智能体 · Explore · 阶段 2 · 后台 */
function formatAgentKind(agent, i18n) {
  if (!agent) return '';
  const parts = [i18n.t(KIND_KEY[agent.kind] || 'agent.subagent')];
  // 工作流智能体的类型固定是 workflow-subagent（样例里写 workflow-agent），和“工作流智能体”重复，不写
  if (agent.agentType && agent.name && !(agent.kind === 'workflowAgent' && /^workflow-(sub)?agent$/.test(agent.agentType))) parts.push(String(agent.agentType));
  if (agent.phase) parts.push(i18n.t('workflow.phase', { phase: agent.phase }));
  if (agent.background) parts.push(i18n.t('agent.background'));
  return parts.join(SEP);
}

/** 工作流一行：名字、状态、进度 */
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

/** 时间线一条（§5） */
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

/** 改过的文件：操作 + 次数 */
function formatFileOp(f, i18n) {
  if (!f) return '';
  let s = f.op === 'move' ? i18n.t('file.op.move', { to: f.movedTo || '' }) : i18n.t('file.op.' + (f.op || 'edit'));
  if (f.count > 1) s += SEP + i18n.t('file.count', { n: f.count });
  return s;
}

/** 右侧会话条的缓存剩余（§11.7），Codex / 不知道时 ''。webview 每 30 秒自己刷新这一处 */
function formatCacheLeft(expiresMs, i18n, now = Date.now()) {
  if (!fin(expiresMs)) return '';
  if (expiresMs <= now) return i18n.t('session.cacheExpired');
  return i18n.t('session.cacheLeft', { m: Math.max(1, Math.ceil((expiresMs - now) / 60e3)) });
}

// ---------------------------------------------------------------------------
// 左侧会话行（§11.2）
// ---------------------------------------------------------------------------

/**
 * 会话的一句话状态（决定会话灯的那一行；不是主智能体时前面加名字）。
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
 * 左侧会话行：label、description（{Claude|Codex} · {状态一句话} · {上下文百分比}）、a11y。
 * description 不含逐秒变化的内容：只有状态、上下文真的变了才变。
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
 * 左侧会话行的悬停提示（纯文本 [标签, 值] 对，调用方转成 Markdown 表格并转义）。不含逐秒变化的内容。
 * @returns {[string, string][]}
 */
function formatSessionTooltip(session, i18n, o = {}) {
  const now = o.now ?? Date.now();
  const L = o.lamps || lampLib.sessionLamps(session, { seenAtMs: o.seenAtMs, staleAsNeedsYou: o.staleAsNeedsYou });
  const rows = [];
  const status = formatSessionStatus(session, i18n, now, { stable: true, staleAsNeedsYou: o.staleAsNeedsYou }, L);
  rows.push([i18n.t('tip.status'), lampLabel(L.lamp, i18n) + SEP + status]);
  const note = formatStatusNote(L.lead && L.lead.status, i18n);
  if (note) rows.push([i18n.t('tip.note'), note]);
  rows.push([i18n.t('tip.entry'), providerLabel(session.provider, i18n) + SEP + entryLabel(session.entry, i18n)
    + SEP + i18n.t(session.live ? 'tip.open' : 'tip.notOpen')]);
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
    if (cost.text) rows.push([i18n.t('cost.label'), cost.text]);
  }
  const c = session.counts;
  if (c && c.total > 0) rows.push([i18n.t('tip.agents'), i18n.t('tip.agentCounts', { total: c.total, running: c.running || 0 })]);
  if (fin(session.startedMs)) rows.push([i18n.t('tip.started'), i18n.fmtDateTime(session.startedMs)]);
  return rows;
}

/**
 * 会话节点的 contextValue（菜单 when 用 viewItem =~ /\bxxx\b/）：
 * session provider-<p> lamp-<灯> [quota] [resumable] [compactable] [live]
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
// 状态栏总灯与徽标（§8.2、§8.5）
// ---------------------------------------------------------------------------

/**
 * 状态栏文字：$(circle-large-filled) 2 need you · 1 error · 3 working；全 0 → $(circle-large-outline) 没有在跑的智能体。
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
 * 状态栏 tooltip 的会话行：“灯名 · 标题 · 状态一句话”，最多 max 行，多出的写“还有 n 个”。
 * @param {any[]} sessions 已按左侧顺序排好
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

/** 视图徽标：需要你看的会话数 + tooltip（分别列出三个数） */
function formatBadge(counts, i18n) {
  const c = counts || {};
  const value = lampLib.attentionCount(c);
  const parts = [];
  if (c.needsYou) parts.push(i18n.t('badge.needsYou', { n: c.needsYou }));
  if (c.error) parts.push(i18n.t('badge.error', { n: c.error }));
  if (c.doneUnseen) parts.push(i18n.t('badge.doneUnseen', { n: c.doneUnseen }));
  return { value, tooltip: parts.join(SEP) };
}

/** 范围名与空列表提示 */
function formatScope(scope, i18n) {
  const s = scope === 'workspace' ? 'workspace' : 'all';
  return { label: i18n.t('scope.' + s), empty: i18n.t('scope.empty.' + s) };
}

/** 左侧分组头 */
function formatGroup(groupId, i18n) {
  return i18n.t(groupId === 'open' ? 'group.open' : 'group.recent');
}

module.exports = {
  SEP, COMPACTABLE_MIN,
  toolLabel, providerLabel, entryLabel, lampLabel,
  formatStatus, formatStatusNote, formatQuotaHit, formatAutoContinue,
  formatStep, formatContext, contextPct, sessionContextTokens, formatContextSources, formatBytes,
  formatCost, formatCostNote, formatSessionCost, formatToday,
  formatCodexQuota, formatClaudeLastHit,
  formatResumeEstimate, formatResumeHint,
  formatAgentName, formatAgentKind, formatWorkflow, formatTimelineEvent, formatFileOp, formatCacheLeft,
  formatSessionStatus, formatSessionRow, formatSessionTooltip, sessionContextValue,
  formatStatusBarText, formatStatusBarLines, formatBadge, formatScope, formatGroup,
};
