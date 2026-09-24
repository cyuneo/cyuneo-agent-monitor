'use strict';
// 编排层（DESIGN §1.1、§1.4、§2.1、§11.1–11.3、§11.12.3）：持有 Claude 与 Codex 两个 provider，
// 合并成 Snapshot v2，做窗口过滤，按 focus 附带细节（含单个会话的存储占用），推进今日合计；
// 另按需统计存储占用（lib/storage.js，10 分钟最多一次）。
// 不产出界面文字；不依赖 vscode，worker 和终端版共用。
// Codex provider（lib/providers/codex.js）或 lib/storage.js 不存在、出错时照常跑，不崩。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ClaudeProvider, DEFAULT_LIMITS, defaultProjectsDir, projectDirName, cleanObserved } = require('./providers/claude');
const { DailyScanner, emptyDailyTotals } = require('./core/daily');
const quota = require('./core/quota');
const S = require('./core/status');

const DEFAULT_BUDGET = 8 * 1024 * 1024;
const GUESS_MODES = new Set(Object.values(S.APPROVAL_GUESS));
const DIR_SOURCES = new Set(['env', 'setting', 'default']);
const STORAGE_TTL_MS = 10 * 60e3;          // §11.11：存储占用 10 分钟最多统计一次（force 除外）
const SESSION_STORAGE_TTL_MS = 60e3;       // §11.12.3：单个会话的占用 60 秒最多一次

function pos(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(String(a)) === path.resolve(String(b));
}

// 目录从哪来：与环境变量相同 → env；是默认位置 → default；其余算设置给的
function dirSourceOf(given, dir, envVal, def) {
  if (DIR_SOURCES.has(given)) return given;
  if (envVal && samePath(dir, envVal)) return 'env';
  if (samePath(dir, def)) return 'default';
  return 'setting';
}

/**
 * 补全 WorkerConfig（§1.4、§11.12.3）。也接受 v0.2 的旧写法 { root, activeWindowMinutes, staleMinutes }。
 * - claude.configDir：CLAUDE_CONFIG_DIR 或 ~/.claude（扩展算好传进来）；没给时用 claude.home，再退回 projectsDir 的上一级。
 *   它同时是登记表 sessions/ 的父目录（home 与它相同）和用户设置 settings.json 所在目录
 *   （给了 configDir 时忽略 claude.settingsPath）。
 * - observedCompact：`${model}|${contextWindow}` → 实测自动压缩点（扩展从 globalState 带过来）。
 * @param {any} raw
 * @param {Record<string, string|undefined>} [env]
 */
function normalizeConfig(raw, env = process.env) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const claude = c.claude && typeof c.claude === 'object' ? c.claude : {};
  const codex = c.codex && typeof c.codex === 'object' ? c.codex : {};
  const e = env || {};
  const projectsDir = claude.projectsDir || c.root || defaultProjectsDir(e);
  const configDir = claude.configDir || claude.home || path.dirname(projectsDir);
  const codexHome = codex.home || e.CODEX_HOME || path.join(os.homedir(), '.codex');
  return {
    intervalMs: pos(c.intervalMs, 2000),
    activeWindowMinutes: pos(c.activeWindowMinutes, 30),
    staleMinutes: pos(c.staleMinutes, 5),
    claude: {
      enabled: claude.enabled !== false,
      projectsDir,
      configDir,
      configDirSource: dirSourceOf(claude.configDirSource, configDir, e.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')),
      // 用户设置 = <configDir>/settings.json（§11.10）；给了 configDir 时以它为准，旧写法的 settingsPath 只在没给时用
      settingsPath: claude.configDir ? path.join(configDir, 'settings.json') : (claude.settingsPath || path.join(configDir, 'settings.json')),
      home: configDir,
    },
    codex: {
      enabled: codex.enabled !== false,
      home: codexHome,
      homeSource: dirSourceOf(codex.homeSource, codexHome, e.CODEX_HOME, path.join(os.homedir(), '.codex')),
    },
    observedCompact: cleanObserved(c.observedCompact),
    limits: { ...DEFAULT_LIMITS, ...(c.limits && typeof c.limits === 'object' ? c.limits : {}) },
    dailyBudgetBytesPerTick: pos(c.dailyBudgetBytesPerTick, DEFAULT_BUDGET),
    daily: c.daily !== false,
    approvalGuess: GUESS_MODES.has(c.approvalGuess) ? c.approvalGuess : S.APPROVAL_GUESS.FAST_TOOLS,
    approvalGuessSeconds: pos(c.approvalGuessSeconds, S.APPROVAL_GUESS_DEFAULT_SECONDS),
    timeZone: typeof c.timeZone === 'string' && c.timeZone ? c.timeZone : undefined,
  };
}

// ---------------------------------------------------------------------------
// Codex provider 适配：接口按 DESIGN §1.2 / §2，由另一个模块实现；这里对常见写法都兼容
// ---------------------------------------------------------------------------

function errText(err) {
  return String((err && err.message) || err).split('\n')[0].slice(0, 300);
}

function createCodex(cfg, mod) {
  let m = mod;
  if (!m) {
    try {
      m = require('./providers/codex');
    } catch (err) {
      return { inst: null, error: 'load: ' + errText(err) };
    }
  }
  // 传一个“超集”配置：顶层带 codex 的字段（home…），也带完整的 WorkerConfig
  const opts = {
    ...cfg,
    ...cfg.codex,
    codexHome: cfg.codex.home,
    sessionsDir: path.join(cfg.codex.home, 'sessions'),
    codex: cfg.codex,
    claude: cfg.claude,
  };
  try {
    const Ctor = (m && (m.CodexProvider || m.Provider || m.default)) || (typeof m === 'function' ? m : null);
    let inst = null;
    if (typeof Ctor === 'function') inst = new Ctor(opts);
    else if (m && typeof m.createProvider === 'function') inst = m.createProvider(opts);
    else if (m && typeof m.createCodexProvider === 'function') inst = m.createCodexProvider(opts);
    if (!inst) return { inst: null, error: 'codex provider 没有可用的构造函数' };
    return { inst, error: null };
  } catch (err) {
    return { inst: null, error: 'init: ' + errText(err) };
  }
}

function callFirst(inst, names, args) {
  for (const n of names) if (inst && typeof inst[n] === 'function') return { found: true, value: inst[n](...args) };
  return { found: false, value: undefined };
}

// 各种返回形状 → { sessions, quota(codex 部分) }
function normalizeScan(res) {
  if (Array.isArray(res)) return { sessions: res, quota: null };
  if (res && typeof res === 'object') {
    const q = res.quota ?? res.codexQuota ?? res.rateLimits ?? null;
    return { sessions: Array.isArray(res.sessions) ? res.sessions : [], quota: q };
  }
  return { sessions: [], quota: null };
}

function codexQuotaOf(q) {
  if (!q || typeof q !== 'object') return null;
  if (q.codex && typeof q.codex === 'object') return q.codex;
  if (Array.isArray(q.windows)) return q;
  return null;
}

/**
 * 两份 WorkerConfig 是否只有 observedCompact 不同（这种变化不必重建 provider，worker 用它省掉整次重读）。
 * @param {any} a normalizeConfig 的结果
 * @param {any} b
 */
function sameExceptObserved(a, b) {
  if (!a || !b) return false;
  const strip = (x) => JSON.stringify({ ...x, observedCompact: null });
  return strip(a) === strip(b);
}

function storageErrorReport(now, message) {
  return { at: now, claude: null, codex: null, volumes: [], cleanupPeriodDays: null, error: String(message || 'unavailable') };
}

async function fileSize(f) {
  if (!f) return null;
  try { return (await fs.promises.stat(f)).size; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

class Monitor {
  /**
   * @param {any} cfg WorkerConfig（§1.4），缺的字段补默认值
   * @param {{ codexModule?: any, storageModule?: any, isAlive?: (pid: number) => boolean, dayStart?: (now: number) => number,
   *   env?: Record<string, string|undefined> }} [deps] 测试用：替换 Codex 模块、存储统计模块（null = 不可用）、存活判定、零点
   */
  constructor(cfg = {}, deps = {}) {
    this.cfg = normalizeConfig(cfg, deps.env || process.env);
    this.deps = deps;
    this.storageLib = undefined;  // lib/storage.js（第一次用时再加载）
    this.storageCache = null;     // { at, report }
    this.storagePending = null;   // 进行中的统计（同时来的请求共用）
    this.sessStorage = new Map(); // 会话 key → { at, value, pending }
    this.onChange = null;         // 异步结果到了（单个会话的存储占用）：worker 用它尽快再发一份快照
    this.windowMs = this.cfg.activeWindowMinutes * 60e3;
    this.focus = new Set();
    this.errors = new Map();      // 来源 → 最近一次出错信息（worker 取走后清空）
    this.status = { claude: { enabled: this.cfg.claude.enabled, ok: true, error: null, registry: false },
      codex: { enabled: this.cfg.codex.enabled, ok: false, error: null } };
    this.started = new Map();     // Codex 会话缺 startedMs 时补的排序键（首次看到的时间，之后不变）
    this.claude = null;
    if (this.cfg.claude.enabled) {
      this.claude = new ClaudeProvider({
        projectsDir: this.cfg.claude.projectsDir,
        settingsPath: this.cfg.claude.settingsPath,
        home: this.cfg.claude.configDir,
        observedCompact: this.cfg.observedCompact,
        activeWindowMinutes: this.cfg.activeWindowMinutes,
        staleMinutes: this.cfg.staleMinutes,
        limits: this.cfg.limits,
        approvalGuess: this.cfg.approvalGuess,
        approvalGuessSeconds: this.cfg.approvalGuessSeconds,
        timeZone: this.cfg.timeZone,
        env: deps.env,
        isAlive: deps.isAlive,
      });
    }
    this.codex = null;
    if (this.cfg.codex.enabled) {
      const r = createCodex(this.cfg, deps.codexModule);
      this.codex = r.inst;
      this.status.codex.ok = !!r.inst;
      if (r.error) this.fail('codex', r.error);
    }
    this.daily = this.cfg.daily
      ? new DailyScanner({
        claudeProjectsDir: this.cfg.claude.enabled ? this.cfg.claude.projectsDir : null,
        codexHome: this.cfg.codex.enabled ? this.cfg.codex.home : null,
        budgetBytes: this.cfg.dailyBudgetBytesPerTick,
        dayStart: deps.dayStart,
      })
      : null;
  }

  fail(source, message) {
    this.errors.set(source, message);
    if (this.status[source]) this.status[source].error = message;
  }

  /** 取走本次积累的出错信息 [[来源, 信息], …] */
  takeErrors() {
    const out = [...this.errors];
    this.errors.clear();
    return out;
  }

  /** 需要附带细节的会话 key（当前选中的 + 当前对话）；这些会话也不做窗口过滤 */
  setFocus(keys) {
    this.focus = new Set((Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k));
  }

  /**
   * 换实测压缩点表（§11.12.2）：不重建 provider，下一次扫描就用上。
   * @param {Record<string, number>} map
   */
  setObservedCompact(map) {
    this.cfg.observedCompact = cleanObserved(map);
    if (this.claude) this.claude.setObservedCompact(this.cfg.observedCompact);
  }

  // lib/storage.js：不存在或加载出错时为 null（存储功能不可用，其余照常）
  storageModule() {
    if (this.storageLib !== undefined) return this.storageLib;
    if (this.deps.storageModule !== undefined) {
      this.storageLib = this.deps.storageModule;
      return this.storageLib;
    }
    try {
      this.storageLib = require('./storage');
    } catch (err) {
      this.storageLib = null;
      this.fail('storage', 'load: ' + errText(err));
    }
    return this.storageLib;
  }

  /**
   * 存储位置与占用（§11.11、§11.12.3）。没有 force 时 10 分钟内返回缓存（cached: true）；
   * 统计进行中再来的请求共用同一次统计。出错或 lib/storage.js 不可用时也会 resolve（带 error）。
   * @param {{ force?: boolean, now?: number }} [o]
   * @returns {Promise<import('./core/status').StorageReport>}
   */
  storageReport(o = {}) {
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const c = this.storageCache;
    if (!o.force && c && now >= c.at && now - c.at < STORAGE_TTL_MS) return Promise.resolve({ ...c.report, cached: true });
    if (this.storagePending) return this.storagePending;
    const mod = this.storageModule();
    if (!mod || typeof mod.scanStorage !== 'function') return Promise.resolve(storageErrorReport(now, 'unavailable'));
    const cc = this.cfg.claude;
    const cx = this.cfg.codex;
    const run = Promise.resolve()
      .then(() => mod.scanStorage({
        claudeDir: cc.configDir, codexHome: cx.home,
        claudeDirSource: cc.configDirSource, codexHomeSource: cx.homeSource, projectsDir: cc.projectsDir,
      }))
      .then((r) => {
        const report = r && typeof r === 'object' ? { ...r } : {};
        if (!Number.isFinite(report.at)) report.at = now;
        if (report.claude && typeof report.claude === 'object' && !report.claude.dirSource) report.claude = { ...report.claude, dirSource: cc.configDirSource };
        if (report.codex && typeof report.codex === 'object' && !report.codex.dirSource) report.codex = { ...report.codex, dirSource: cx.homeSource };
        if (!Array.isArray(report.volumes)) report.volumes = [];
        if (report.cleanupPeriodDays === undefined) report.cleanupPeriodDays = null;
        delete report.type;
        delete report.cached;
        this.storageCache = { at: now, report };
        return { ...report, cached: false };
      })
      .catch((err) => {
        this.fail('storage', errText(err));
        return storageErrorReport(now, errText(err));
      })
      .finally(() => { this.storagePending = null; });
    this.storagePending = run;
    return run;
  }

  /**
   * 单个会话的存储占用（§11.11 右侧“记录位置”）：60 秒最多统计一次，异步算，
   * 本次先返回上一次的结果（第一次为 null），算完调用 onChange 让 worker 尽快再发快照。
   * @param {any} s Session
   * @param {number} now
   * @returns {import('./core/status').SessionStorage|null}
   */
  sessionStorage(s, now) {
    let c = this.sessStorage.get(s.key);
    if (c && (c.pending || (now >= c.at && now - c.at < SESSION_STORAGE_TTL_MS))) return c.value;
    if (!c) { c = { at: now, value: null, pending: false }; this.sessStorage.set(s.key, c); }
    c.at = now;
    c.pending = true;
    const job = s.provider === 'claude' ? () => this.claudeSessionStorage(s) : () => this.codexSessionStorage(s);
    Promise.resolve()
      .then(job)
      .then((v) => {
        c.value = v && typeof v === 'object'
          ? {
            transcriptBytes: v.transcriptBytes ?? null, subagentsBytes: v.subagentsBytes ?? null, fileHistoryBytes: v.fileHistoryBytes ?? null,
            transcript: v.transcript ?? s.transcript ?? null, subagentsDir: v.subagentsDir ?? null, fileHistoryDir: v.fileHistoryDir ?? null,
            at: now,
          }
          : null;
      })
      .catch((err) => this.fail('storage', errText(err)))
      .finally(() => {
        c.pending = false;
        if (typeof this.onChange === 'function') { try { this.onChange(); } catch { /* 忽略 */ } }
      });
    return c.value;
  }

  async claudeSessionStorage(s) {
    const mod = this.storageModule();
    if (mod && typeof mod.sessionStorage === 'function') {
      // projectDir 传完整目录（主记录所在目录）；Session.projectDir 只是目录名
      return mod.sessionStorage({
        claudeDir: this.cfg.claude.configDir, projectsDir: this.cfg.claude.projectsDir,
        projectDir: s.transcript ? path.dirname(s.transcript) : null, sessionId: s.id, transcript: s.transcript,
      });
    }
    // lib/storage.js 不可用：只给主记录大小
    return { transcriptBytes: await fileSize(s.transcript), subagentsBytes: null, fileHistoryBytes: null, transcript: s.transcript || null };
  }

  // Codex：主线程 rollout + 子线程 rollout 合计；没有文件备份
  async codexSessionStorage(s) {
    const transcriptBytes = await fileSize(s.transcript || (s.main && s.main.file));
    let subagentsBytes = null;
    for (const a of s.agents || []) {
      const n = await fileSize(a && a.file);
      if (n != null) subagentsBytes = (subagentsBytes || 0) + n;
    }
    return { transcriptBytes, subagentsBytes, fileHistoryBytes: null, transcript: s.transcript || (s.main && s.main.file) || null };
  }

  pin(key, candidate, now) {
    let v = this.started.get(key);
    if (v == null) {
      v = Number.isFinite(candidate) ? candidate : now;
      this.started.set(key, v);
    }
    return v;
  }

  /**
   * 扫一遍，返回 Snapshot v2（不含 type 字段；worker 发送时加上）。
   * @param {number} [now]
   * @returns {import('./core/status').Snapshot & { sources: any }}
   */
  snapshot(now = Date.now()) {
    const sessions = [];
    const q = quota.emptyQuotaSnapshot();

    if (this.claude) {
      try {
        const keep = [...this.focus].filter((k) => k.startsWith('claude:'));
        const r = this.claude.scan(now, { keep });
        for (const s of r.sessions) sessions.push(s);
        q.claude.lastHit = r.quotaHit || null;
        this.status.claude.ok = true;
        this.status.claude.error = null;
        this.status.claude.registry = !!r.registryOk;
        if (this.claude.lastError) { this.fail('claude', errText(this.claude.lastError)); this.claude.lastError = null; }
      } catch (err) {
        this.status.claude.ok = false;
        this.fail('claude', errText(err));
      }
    }

    if (this.codex) {
      try {
        const keep = [...this.focus].filter((k) => k.startsWith('codex:'));
        const call = callFirst(this.codex, ['scan', 'snapshot', 'poll', 'tick'], [now, { keep, keepKeys: keep }]);
        if (!call.found) throw new Error('codex provider 没有 scan / snapshot 方法');
        const r = normalizeScan(call.value);
        let cq = codexQuotaOf(r.quota);
        if (!cq) {
          const qc = callFirst(this.codex, ['quota', 'getQuota', 'quotaSnapshot'], [now]);
          if (qc.found) cq = codexQuotaOf(qc.value);
        }
        if (cq) q.codex = cq;
        for (const s of r.sessions) {
          if (!s || typeof s !== 'object' || !s.id) continue;
          if (!s.key) s.key = S.sessionKey('codex', s.id);
          if (!s.provider) s.provider = 'codex';
          if (!Number.isFinite(s.startedMs)) s.startedMs = this.pin(s.key, s.createdMs, now);
          if (typeof s.live !== 'boolean') s.live = false;
          const inWindow = now - (s.updatedMs || 0) < this.windowMs;
          if (!inWindow && !s.live && !this.focus.has(s.key)) continue;
          sessions.push(s);
        }
        this.status.codex.ok = true;
        this.status.codex.error = null;
      } catch (err) {
        this.status.codex.ok = false;
        this.fail('codex', errText(err));
      }
    }

    // §11.3：按会话开始时间倒序，排序键不随活动变化
    sessions.sort((a, b) => (b.startedMs - a.startedMs) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const details = {};
    for (const key of this.focus) {
      const sess = sessions.find((s) => s.key === key);
      if (!sess) continue;
      const d = this.detail(key);
      if (d) details[key] = { ...d, storage: this.sessionStorage(sess, now) };
    }
    for (const k of [...this.sessStorage.keys()]) if (!this.focus.has(k)) this.sessStorage.delete(k);

    let today = emptyDailyTotals();
    if (this.daily) {
      try {
        today = this.daily.tick(now);
      } catch (err) {
        this.fail('daily', errText(err));
      }
    }

    return {
      v: 2,
      now,
      sessions,
      quota: q,
      today,
      details,
      sources: {
        claude: { ...this.status.claude },
        codex: { ...this.status.codex },
      },
    };
  }

  /**
   * 某个会话的细节（§2.7）。
   * @param {string} key 'claude:<id>' / 'codex:<id>'
   */
  detail(key) {
    const k = S.parseSessionKey(key);
    if (!k) return null;
    try {
      if (k.provider === 'claude' && this.claude) return this.claude.detail(k.id);
      if (k.provider === 'codex' && this.codex) {
        let r = callFirst(this.codex, ['detail', 'sessionDetail', 'getDetail'], [key]);
        if (r.found && !r.value) r = callFirst(this.codex, ['detail', 'sessionDetail', 'getDetail'], [k.id]);
        if (r.found) return r.value || null;
        const many = callFirst(this.codex, ['details'], [[key]]);
        if (many.found && many.value) return many.value[key] || null;
      }
    } catch (err) {
      this.fail(k.provider, errText(err));
    }
    return null;
  }

  dispose() {
    try { if (this.claude) this.claude.dispose(); } catch { /* 忽略 */ }
    try { if (this.codex && typeof this.codex.dispose === 'function') this.codex.dispose(); } catch { /* 忽略 */ }
  }
}

// ---------------------------------------------------------------------------
// v0.2 遗留的小工具（extension.js / bin 改写前仍在用；不含界面文字）
// ---------------------------------------------------------------------------

function fmtDur(ms) {
  if (!(ms >= 0)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}

const DEFAULT_ROOT = defaultProjectsDir();

module.exports = {
  Monitor, normalizeConfig, createCodex, sameExceptObserved,
  STORAGE_TTL_MS, SESSION_STORAGE_TTL_MS,
  projectDirName, DEFAULT_ROOT,
  fmtTokens, fmtDur,
};
