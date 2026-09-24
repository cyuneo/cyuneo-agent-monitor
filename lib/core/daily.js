'use strict';
// 今日合计（DESIGN §6.2）：独立于“活动窗口”的扫描器，增量、分片、不重复计数。
// - “今日”= 本机时区 0 点到现在；跨零点丢弃全部累加器重新开始。
// - 每个文件一个 JsonlTail（与活动窗口的读取器分开），prefilter 在 JSON.parse 前按子串跳过无关行。
// - 每次 tick 最多读 budgetBytes，读不完下次继续（partial / progress）。
// - Claude 以 message.id 全局去重（同一消息多行写、usage 逐行更新，取增量）；跳过 synthetic。
// - Codex 有 token_usage_record 的文件按 response_id 计；老文件按 token_count 的累计值取差。
// 只读，纯 Node。

const fs = require('fs');
const path = require('path');
const { JsonlTail, substringFilter } = require('./jsonl');
const pricing = require('./pricing');

const DEFAULT_BUDGET = 8 * 1024 * 1024;
const DEFAULT_LIST_MS = 30000;

const CLAUDE_FILTER = substringFilter('"usage"');
const CODEX_FILTER = substringFilter('token_usage_record', 'token_count', 'turn_context', 'thread_settings_applied');

/** 本机时区的当天 0 点 */
function localDayStart(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function listDir(d) {
  try { return fs.readdirSync(d); } catch { return []; }
}

function statOf(f) {
  try { return fs.statSync(f); } catch { return null; }
}

function emptyClaude() {
  return { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, costUsd: 0, unpricedTokens: 0, byModel: {} };
}

function emptyCodex() {
  return { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, unpricedTokens: 0, byModel: {} };
}

// 按模型累加（sign = -1 时回滚）
function addByModel(bucket, model, tokens, usd, sign = 1) {
  const key = model || 'unknown';
  let b = bucket.byModel[key];
  if (!b) { b = { tokens: 0, costUsd: usd == null ? null : 0 }; bucket.byModel[key] = b; }
  b.tokens += sign * tokens;
  if (usd != null) b.costUsd = (b.costUsd || 0) + sign * usd;
}

class DailyScanner {
  /**
   * @param {{
   *   claudeProjectsDir?: string|null,   // null / 空 = 不扫 Claude
   *   codexHome?: string|null,           // null / 空 = 不扫 Codex
   *   budgetBytes?: number,              // 每次 tick 最多读多少字节，默认 8 MB
   *   listMs?: number,                   // 多久重新列一次文件，默认 30 秒
   *   dayStart?: (now: number) => number // 测试用：自定义“当天 0 点”
   * }} [opts]
   */
  constructor(opts = {}) {
    this.claudeDir = opts.claudeProjectsDir || null;
    this.codexHome = opts.codexHome || null;
    this.budget = opts.budgetBytes > 0 ? opts.budgetBytes : DEFAULT_BUDGET;
    this.listMs = opts.listMs ?? DEFAULT_LIST_MS;
    this.dayStartFn = opts.dayStart || localDayStart;
    this.dayStartMs = null;
    this.resetDay(null);
  }

  resetDay(dayStartMs) {
    this.dayStartMs = dayStartMs;
    this.tails = new Map();      // 文件 → { tail, provider }
    this.order = [];             // 读的顺序（最近改过的在前）
    this.msgs = new Map();       // Claude message.id → 上次看到的分类 token
    this.responses = new Set();  // Codex response_id（已计入）
    this.codexFiles = new Map(); // Codex 文件 → 该文件的模型、档位、计数方式等
    this.claude = emptyClaude();
    this.codex = emptyCodex();
    this.lastList = -Infinity;
  }

  /**
   * 推进一次（读至多 budgetBytes），返回当前合计。
   * @param {number} [now]
   * @returns {import('./status').DailyTotals}
   */
  tick(now = Date.now()) {
    const ds = this.dayStartFn(now);
    if (ds !== this.dayStartMs) this.resetDay(ds);
    if (now - this.lastList >= this.listMs) {
      this.list();
      this.lastList = now;
    }
    let budget = this.budget;
    for (const f of this.order) {
      const x = this.tails.get(f);
      if (!x) continue;
      if (budget > 0) {
        x.tail.poll(budget);
        budget -= x.tail.bytesRead;
      } else {
        x.tail.poll(0); // 预算用完：只更新大小，算进度
      }
    }
    return this.totals();
  }

  // 列出今天改过的文件（新文件加进来；已有的保留到跨零点）
  list() {
    const found = [];
    if (this.claudeDir) {
      for (const proj of listDir(this.claudeDir)) {
        const pd = path.join(this.claudeDir, proj);
        for (const f of listDir(pd)) {
          const p = path.join(pd, f);
          if (f.endsWith('.jsonl')) { this.consider(found, p, 'claude'); continue; }
          // 会话目录：subagents/agent-*.jsonl、subagents/workflows/wf_*/agent-*.jsonl
          const sub = path.join(p, 'subagents');
          for (const a of listDir(sub)) {
            if (a.startsWith('agent-') && a.endsWith('.jsonl')) this.consider(found, path.join(sub, a), 'claude');
          }
          const wfRoot = path.join(sub, 'workflows');
          for (const wf of listDir(wfRoot)) {
            if (!wf.startsWith('wf_')) continue;
            for (const a of listDir(path.join(wfRoot, wf))) {
              if (a.startsWith('agent-') && a.endsWith('.jsonl')) this.consider(found, path.join(wfRoot, wf, a), 'claude');
            }
          }
        }
      }
    }
    if (this.codexHome) {
      const root = path.join(this.codexHome, 'sessions');
      for (const y of listDir(root)) {
        for (const m of listDir(path.join(root, y))) {
          for (const d of listDir(path.join(root, y, m))) {
            const dir = path.join(root, y, m, d);
            for (const f of listDir(dir)) {
              if (f.startsWith('rollout-') && f.endsWith('.jsonl')) this.consider(found, path.join(dir, f), 'codex');
            }
          }
        }
      }
    }
    for (const x of found) {
      if (this.tails.has(x.file)) { this.tails.get(x.file).mtimeMs = x.mtimeMs; continue; }
      this.tails.set(x.file, { tail: this.makeTail(x.file, x.provider), provider: x.provider, mtimeMs: x.mtimeMs });
    }
    this.order = [...this.tails.keys()].sort((a, b) => this.tails.get(b).mtimeMs - this.tails.get(a).mtimeMs);
  }

  consider(found, file, provider) {
    const st = statOf(file);
    if (!st || !st.isFile() || st.mtimeMs < this.dayStartMs) return;
    found.push({ file, provider, mtimeMs: st.mtimeMs });
  }

  makeTail(file, provider) {
    if (provider === 'claude') {
      return new JsonlTail(file, () => ({}), (_s, e) => this.feedClaude(e), { prefilter: CLAUDE_FILTER });
    }
    let first = true;
    const init = () => {
      // 文件被截断 / 替换后重读：已计过的不再计（见 feedCodex 的 replay）
      const f = this.codexFile(file);
      if (!first) f.replay = true;
      first = false;
      return {};
    };
    return new JsonlTail(file, init, (_s, e) => this.feedCodex(file, e), { prefilter: CODEX_FILTER });
  }

  // ---------- Claude ----------

  feedClaude(e) {
    if (e.type !== 'assistant' || e.isApiErrorMessage === true) return;
    const m = e.message;
    if (!m || typeof m !== 'object' || !m.id || !m.usage || typeof m.usage !== 'object') return;
    if (m.model === '<synthetic>') return;
    const ts = Date.parse(e.timestamp);
    if (!Number.isFinite(ts) || ts < this.dayStartMs) return; // 0 点之前的行丢弃
    const t = pricing.claudeUsageTokens(m.usage);
    const prev = this.msgs.get(m.id);
    const d = {
      input: t.input - (prev ? prev.input : 0),
      cacheWrite5m: t.cacheWrite5m - (prev ? prev.cacheWrite5m : 0),
      cacheWrite1h: t.cacheWrite1h - (prev ? prev.cacheWrite1h : 0),
      cacheRead: t.cacheRead - (prev ? prev.cacheRead : 0),
      output: t.output - (prev ? prev.output : 0),
    };
    this.msgs.set(m.id, { input: t.input, cacheWrite5m: t.cacheWrite5m, cacheWrite1h: t.cacheWrite1h, cacheRead: t.cacheRead, output: t.output });
    const tokens = d.input + d.cacheWrite5m + d.cacheWrite1h + d.cacheRead + d.output;
    if (!tokens) return;
    const c = this.claude;
    c.input += d.input;
    c.cacheWrite5m += d.cacheWrite5m;
    c.cacheWrite1h += d.cacheWrite1h;
    c.cacheRead += d.cacheRead;
    c.output += d.output;
    const usd = pricing.priceClaudeTokens(m.model, d, t.speed);
    if (usd == null) c.unpricedTokens += tokens;
    else c.costUsd += usd;
    addByModel(c, m.model, tokens, usd);
  }

  // ---------- Codex ----------

  codexFile(file) {
    let f = this.codexFiles.get(file);
    if (!f) {
      f = {
        model: null, settingsModel: null, tier: null,
        records: false,        // 见过 token_usage_record：本文件只按它计
        last: null,            // 上一条 token_count 的 total_token_usage（分类 token）
        high: null,            // 见过的最大累计值（重读时防重复）
        replay: false,         // 文件被截断 / 替换后正在重读
        turnAcc: new Map(),    // 本轮（上个 turn_context 之后）按 token_count 计入的量，model → { t, usd }
      };
      this.codexFiles.set(file, f);
    }
    return f;
  }

  feedCodex(file, e) {
    const f = this.codexFile(file);
    const p = e.payload && typeof e.payload === 'object' ? e.payload : null;
    if (!p) return;
    if (e.type === 'turn_context') {
      if (typeof p.model === 'string' && p.model) f.model = p.model;
      f.turnAcc.clear();
      return;
    }
    if (e.type === 'event_msg' && p.type === 'thread_settings_applied') {
      const ts = p.thread_settings && typeof p.thread_settings === 'object' ? p.thread_settings : {};
      if (typeof ts.model === 'string' && ts.model) f.settingsModel = ts.model;
      if (typeof ts.service_tier === 'string' && ts.service_tier) f.tier = ts.service_tier;
      return;
    }
    const ts = Date.parse(e.timestamp);
    if (e.type === 'token_usage_record') {
      if (!f.records) {
        // 第一次见到逐次记录：回滚本轮已按 token_count 计入的量（同一次响应两种都写，顺序不定）
        f.records = true;
        for (const [model, x] of f.turnAcc) this.addCodex(model, x.t, x.usd, -1);
        f.turnAcc.clear();
      }
      const rid = typeof p.response_id === 'string' ? p.response_id : null;
      if (!rid || this.responses.has(rid)) return;
      if (!Number.isFinite(ts) || ts < this.dayStartMs) return;
      this.responses.add(rid);
      const model = f.model || f.settingsModel;
      const t = pricing.openaiUsageTokens(p.usage);
      const usd = pricing.priceOpenAI(model, p.usage, f.tier);
      this.addCodex(model, t, usd, 1);
      return;
    }
    if (e.type === 'event_msg' && p.type === 'token_count') {
      if (f.records) return; // 有逐次记录的文件不再用累计值（否则重复）
      const info = p.info && typeof p.info === 'object' ? p.info : null;
      if (!info || !info.total_token_usage) return;
      const cur = pricing.openaiUsageTokens(info.total_token_usage);
      const total = cur.input + cur.output;
      let d;
      if (f.replay) {
        // 重读：没超过以前见过的最大值的部分都已计过
        if (f.high && total <= f.high.input + f.high.output) { f.last = cur; return; }
        d = diffTokens(cur, f.high || zeroTokens());
        f.replay = false;
      } else if (!f.last) {
        d = cur;
      } else {
        const lastTotal = f.last.input + f.last.output;
        if (total === lastTotal) { f.last = cur; return; } // 与上一条相同：跳过
        d = total < lastTotal ? cur : diffTokens(cur, f.last); // 变小视为重置，整条计入
      }
      f.last = cur;
      if (!f.high || total > f.high.input + f.high.output) f.high = cur;
      if (!Number.isFinite(ts) || ts < this.dayStartMs) return; // 0 点前的只推进基准，不计
      const model = f.model || f.settingsModel;
      const usd = pricing.priceOpenAITokens(model, d, { tier: f.tier });
      this.addCodex(model, d, usd, 1);
      const k = model || 'unknown';
      const acc = f.turnAcc.get(k);
      f.turnAcc.set(k, acc
        ? { t: sumTokens(acc.t, d), usd: acc.usd == null || usd == null ? null : acc.usd + usd }
        : { t: d, usd });
    }
  }

  addCodex(model, t, usd, sign) {
    const c = this.codex;
    c.input += sign * t.input;
    c.cachedInput += sign * t.cachedInput;
    c.cacheWrite += sign * t.cacheWrite;
    c.output += sign * t.output;
    c.reasoning += sign * t.reasoning;
    const tokens = t.input + t.output; // = total_tokens（input 已含 cached）
    if (usd == null) c.unpricedTokens += sign * tokens;
    else c.costUsd += sign * usd;
    addByModel(c, model === 'unknown' ? null : model, tokens, usd, sign);
  }

  totals() {
    let size = 0;
    let read = 0;
    for (const x of this.tails.values()) {
      size += x.tail.size;
      read += Math.min(x.tail.offset, x.tail.size);
    }
    return {
      dayStartMs: this.dayStartMs,
      partial: read < size,
      progress: size > 0 ? read / size : 1,
      claude: cloneBucket(this.claude),
      codex: cloneBucket(this.codex),
    };
  }
}

function zeroTokens() { return { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 }; }

function diffTokens(a, b) {
  return {
    input: Math.max(0, a.input - b.input),
    cachedInput: Math.max(0, a.cachedInput - b.cachedInput),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
    output: Math.max(0, a.output - b.output),
    reasoning: Math.max(0, a.reasoning - b.reasoning),
  };
}

function sumTokens(a, b) {
  return {
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

function cloneBucket(b) {
  const byModel = {};
  for (const [k, v] of Object.entries(b.byModel)) byModel[k] = { tokens: v.tokens, costUsd: v.costUsd };
  return { ...b, byModel };
}

/** 空的今日合计（没有扫描器时用） */
function emptyDailyTotals(dayStartMs = null) {
  return { dayStartMs, partial: false, progress: 1, claude: emptyClaude(), codex: emptyCodex() };
}

module.exports = { DailyScanner, localDayStart, emptyDailyTotals, DEFAULT_BUDGET, CLAUDE_FILTER, CODEX_FILTER };
