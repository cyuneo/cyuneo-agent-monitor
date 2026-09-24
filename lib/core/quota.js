'use strict';
// 额度（DESIGN §4.3、§4.6、§4.7）：Claude 撞额度报错的解析、Codex rate_limits 归一化。
// 只出结构化数据，不含界面文字。时区换算只用 Node 自带的 Intl。

// ---------------------------------------------------------------------------
// 时区工具
// ---------------------------------------------------------------------------

const dtfCache = new Map();
function dtf(timeZone) {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** IANA 时区是否可用 */
function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { dtf(tz); return true; } catch { return false; }
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * 某时刻在某时区的墙上时间。tz 为空用本机时区。
 * @returns {{ y: number, mo: number, d: number, h: number, mi: number, s: number, wd: number }}
 */
function zonedParts(ms, tz) {
  if (!tz) {
    const x = new Date(ms);
    return { y: x.getFullYear(), mo: x.getMonth() + 1, d: x.getDate(), h: x.getHours(), mi: x.getMinutes(), s: x.getSeconds(), wd: x.getDay() };
  }
  const p = {};
  for (const part of dtf(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: WD[p.weekday] };
}

/** 时区相对 UTC 的偏移（毫秒，东正西负） */
function tzOffsetMs(ms, tz) {
  if (!tz) return -new Date(ms).getTimezoneOffset() * 60e3;
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** 某时区的墙上时间 → epoch 毫秒（夏令时交界按第二次校正） */
function zonedToEpoch(y, mo, d, h, mi, tz) {
  if (!tz) return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMs(guess, tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

/**
 * refMs 之后（严格晚于）第一个满足（星期、时、分）的时刻。
 * @param {number} refMs
 * @param {{ weekday: number|null, hour: number, minute: number }} want hour 为 0–23
 * @param {string|undefined} tz
 * @returns {number|null}
 */
function nextWallTime(refMs, want, tz) {
  const p = zonedParts(refMs, tz);
  for (let add = 0; add <= 8; add++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + add));
    if (want.weekday != null && day.getUTCDay() !== want.weekday) continue;
    const t = zonedToEpoch(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), want.hour, want.minute, tz);
    if (t > refMs) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claude（§4.3）
// ---------------------------------------------------------------------------

const RESET_RE = /resets\s+(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i;
const LIMIT_TYPE_KIND = Object.freeze({ seven_day: 'weekly', five_hour: 'session' });
// “xxx limit” 里不是模型名的词
const NOT_MODEL = new Set(['usage', 'rate', 'your', 'the', 'a', 'this', 'daily', 'hourly', 'monthly', 'token', 'request', 'requests']);
// 自动继续从这个版本起（订阅登录下默认开）【文档 interactive-mode#wait-for-a-usage-limit-to-reset】
const AUTO_CONTINUE_SINCE = '2.1.234';

/** 撞额度的那一行：synthetic 报错、error === 'rate_limit' */
function isClaudeQuotaLine(e) {
  return !!e && e.type === 'assistant' && e.isApiErrorMessage === true && e.error === 'rate_limit';
}

/** assistant 行里的文字（报错原文） */
function claudeMessageText(e) {
  const m = e && e.message;
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  return m.content.map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('\n');
}

/**
 * 版本号比较：a ≥ b。无法解析 → false。
 * @param {string} a @param {string} b
 */
function versionAtLeast(a, b) {
  if (typeof a !== 'string' || !/^\d+(\.\d+)*/.test(a)) return false;
  const pa = a.match(/^\d+(?:\.\d+)*/)[0].split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * 解析额度报错文字。
 * @param {string} text 例：“You've hit your session limit · resets 2am (Asia/Seoul)”
 * @param {number} refMs 记录时间戳（重置时间取它之后的第一个时刻）
 * @param {string} [defaultTz] 文字里没有时区括号时用的时区；默认本机时区
 * @returns {{ kind: 'session'|'weekly'|'model'|'spend'|'unknown', model: string|null,
 *   resetsAtMs: number|null, resetsText: string|null, timeZone: string|null }}
 */
function parseClaudeLimitText(text, refMs, defaultTz) {
  const s = String(text || '');
  let kind = 'unknown';
  let model = null;
  if (/session limit/i.test(s)) kind = 'session';
  else if (/weekly limit/i.test(s)) kind = 'weekly';
  else if (/spend limit|budget/i.test(s)) kind = 'spend';
  else {
    const m = /(\S+(?: [\d.]+)?) limit/i.exec(s);
    if (m) {
      const name = m[1].replace(/^[^\w]+|[^\w.]+$/g, '');
      if (name && !NOT_MODEL.has(name.toLowerCase())) { kind = 'model'; model = name; }
    }
  }
  let resetsAtMs = null;
  let resetsText = null;
  let timeZone = null;
  const r = RESET_RE.exec(s);
  if (r) {
    resetsText = r[0].trim();
    let hour = Number(r[2]) % 12;
    if (r[4].toLowerCase() === 'pm') hour += 12;
    const minute = r[3] ? Number(r[3]) : 0;
    const weekday = r[1] ? WD[r[1][0].toUpperCase() + r[1].slice(1, 3).toLowerCase()] : null;
    const tzRaw = r[5] ? r[5].trim() : null;
    let tz;
    if (tzRaw && isValidTimeZone(tzRaw)) tz = tzRaw;
    else if (defaultTz && isValidTimeZone(defaultTz)) tz = defaultTz;
    else tz = undefined;
    timeZone = tz || null;
    if (hour <= 23 && minute <= 59 && Number.isFinite(refMs)) {
      resetsAtMs = nextWallTime(refMs, { weekday, hour, minute }, tz);
    }
  } else {
    const i = s.search(/resets\b/i);
    if (i >= 0) resetsText = s.slice(i).split(/[·\n]/)[0].trim().replace(/[.。]$/, '') || null;
  }
  return { kind, model, resetsAtMs, resetsText, timeZone };
}

/**
 * 撞额度行 → QuotaHit（§4.3）。quotaLimits.resetsAt（epoch 秒）优先于文字。
 * @param {any} e 记录里的 assistant 行
 * @param {{ timeZone?: string, now?: number }} [opts] timeZone：文字里没写时区时用（默认本机）
 * @returns {import('./status').QuotaHit}
 */
function parseClaudeQuota(e, opts = {}) {
  const ts = Date.parse(e && e.timestamp);
  const ref = Number.isFinite(ts) ? ts : (opts.now ?? Date.now());
  const parsed = parseClaudeLimitText(claudeMessageText(e), ref, opts.timeZone);
  const entry = String((e && e.entrypoint) || '');
  const autoContinue = versionAtLeast(e && e.version, AUTO_CONTINUE_SINCE) && !/^sdk/.test(entry) ? null : false;
  const hit = {
    kind: parsed.kind,
    model: parsed.model,
    resetsAtMs: parsed.resetsAtMs,
    resetsText: parsed.resetsText,
    source: 'text',
    autoContinue,
  };
  const q = e && e.quotaLimits;
  const at = q && Number(q.resetsAt);
  if (q && Number.isFinite(at) && at > 0) {
    hit.resetsAtMs = at > 1e12 ? at : at * 1000;
    const k = LIMIT_TYPE_KIND[q.rateLimitType];
    hit.kind = k || (parsed.kind !== 'unknown' ? parsed.kind : 'unknown');
    if (hit.kind !== 'model') hit.model = null;
    hit.source = 'quotaLimits';
  }
  return hit;
}

/**
 * 非额度的 API 报错 → AgentStatus.error（§4.2 第 2 条）。
 * @param {any} e
 * @returns {{ kind: string, http: number|null, message: string|null }}
 */
function claudeApiError(e) {
  const http = Number(e && e.apiErrorStatus);
  const first = claudeMessageText(e).split('\n').map((x) => x.trim()).find(Boolean) || null;
  return {
    kind: (e && typeof e.error === 'string' && e.error) || 'unknown',
    http: Number.isFinite(http) && http > 0 ? http : null,
    message: first ? first.slice(0, 200) : null,
  };
}

// ---------------------------------------------------------------------------
// Codex（§4.6、§4.7）
// ---------------------------------------------------------------------------

function num(v) { const n = Number(v); return v != null && Number.isFinite(n) ? n : null; }

/** 窗口分钟数 → 标签：300 → '5h'，10080 → 'weekly'，其它 → '<n>m' */
function codexWindowLabel(minutes) {
  if (minutes === 300) return '5h';
  if (minutes === 10080) return 'weekly';
  return `${minutes}m`;
}

/**
 * 单个 RateLimitWindow → QuotaWindow。resets_at 是 epoch 秒；老版本的 resets_in_seconds 按观测时间推算。
 * @param {any} w
 * @param {number|null} observedMs
 * @returns {import('./status').QuotaWindow|null}
 */
function codexWindow(w, observedMs) {
  if (!w || typeof w !== 'object') return null;
  const minutes = num(w.window_minutes);
  const usedPct = num(w.used_percent);
  if (minutes == null && usedPct == null) return null;
  let resetsAtMs = null;
  const at = num(w.resets_at);
  if (at != null && at > 0) resetsAtMs = at > 1e12 ? at : at * 1000;
  else {
    const inS = num(w.resets_in_seconds);
    if (inS != null && Number.isFinite(observedMs)) resetsAtMs = observedMs + inS * 1000;
  }
  return { minutes: minutes ?? 0, usedPct: usedPct ?? 0, resetsAtMs, label: codexWindowLabel(minutes ?? 0) };
}

/**
 * rate_limits → 窗口列表（primary、secondary）。
 * @param {any} rl token_count.rate_limits
 * @param {number|null} observedMs 该行时间戳
 */
function codexWindows(rl, observedMs) {
  if (!rl || typeof rl !== 'object') return [];
  return [codexWindow(rl.primary, observedMs), codexWindow(rl.secondary, observedMs)].filter(Boolean);
}

/**
 * rate_limits → QuotaSnapshot.codex。
 * @param {any} rl
 * @param {number|null} observedMs
 */
function codexQuota(rl, observedMs) {
  if (!rl || typeof rl !== 'object') return emptyQuotaSnapshot().codex;
  const c = rl.credits;
  return {
    observedMs: Number.isFinite(observedMs) ? observedMs : null,
    planType: typeof rl.plan_type === 'string' ? rl.plan_type : null,
    limitId: typeof rl.limit_id === 'string' ? rl.limit_id : null,
    windows: codexWindows(rl, observedMs),
    reachedType: typeof rl.rate_limit_reached_type === 'string' ? rl.rate_limit_reached_type : null,
    credits: c && typeof c === 'object'
      ? { hasCredits: !!c.has_credits, unlimited: !!c.unlimited, balance: c.balance == null ? null : String(c.balance) }
      : null,
  };
}

/** 空的 QuotaSnapshot */
function emptyQuotaSnapshot() {
  return {
    claude: { lastHit: null },
    codex: { observedMs: null, planType: null, limitId: null, windows: [], reachedType: null, credits: null },
  };
}

/** 窗口的重置时间已过（界面显示“已重置”） */
function isWindowReset(w, now) {
  return !!w && w.resetsAtMs != null && w.resetsAtMs <= now;
}

/** rate_limits 显示已撞上限：有窗口用满，或 rate_limit_reached_type 非空 */
function codexLimitReached(rl) {
  if (!rl || typeof rl !== 'object') return false;
  if (typeof rl.rate_limit_reached_type === 'string' && rl.rate_limit_reached_type) return true;
  for (const w of [rl.primary, rl.secondary]) {
    const p = w && num(w.used_percent);
    if (p != null && p >= 100) return true;
  }
  return false;
}

/**
 * CodexErrorInfo（snake_case；单元变体是字符串，带参变体是对象）→ 枚举名。
 * 例：'usage_limit_exceeded' → 同名；{ http_connection_failed: {…} } → 'http_connection_failed'
 */
function codexErrorKind(info) {
  if (typeof info === 'string') return info || null;
  if (info && typeof info === 'object') { const k = Object.keys(info)[0]; return k || null; }
  return null;
}

/** 带参变体里的 HTTP 状态码（如 http_connection_failed.http_status_code） */
function codexErrorHttp(info) {
  if (!info || typeof info !== 'object') return null;
  const v = info[Object.keys(info)[0]];
  return v && typeof v === 'object' ? num(v.http_status_code) : null;
}

function isCodexUsageLimit(info) { return codexErrorKind(info) === 'usage_limit_exceeded'; }

/**
 * Codex 撞上限的 QuotaHit：重置时间取已用满的窗口（多个取最晚重置的），没有用满的取用量最高的。
 * @param {any} rl 最新 rate_limits（可为空）
 * @param {number|null} observedMs
 * @param {{ kind?: 'window'|'spend', source?: 'turnError'|'rateLimits' }} [o]
 * @returns {import('./status').QuotaHit}
 */
function codexQuotaHit(rl, observedMs, o = {}) {
  const ws = codexWindows(rl, observedMs);
  let pick = null;
  const full = ws.filter((w) => w.usedPct >= 100);
  if (full.length) pick = full.reduce((a, b) => ((b.resetsAtMs || 0) > (a.resetsAtMs || 0) ? b : a));
  else if (ws.length) pick = ws.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
  return {
    kind: o.kind || 'window',
    model: null,
    resetsAtMs: pick ? pick.resetsAtMs : null,
    resetsText: null,
    source: o.source || 'turnError',
    autoContinue: false,
  };
}

module.exports = {
  // 时区
  isValidTimeZone, zonedParts, tzOffsetMs, zonedToEpoch, nextWallTime,
  // Claude
  RESET_RE, AUTO_CONTINUE_SINCE, isClaudeQuotaLine, claudeMessageText, versionAtLeast,
  parseClaudeLimitText, parseClaudeQuota, claudeApiError,
  // Codex
  codexWindowLabel, codexWindow, codexWindows, codexQuota, emptyQuotaSnapshot, isWindowReset,
  codexLimitReached, codexErrorKind, codexErrorHttp, isCodexUsageLimit, codexQuotaHit,
};
