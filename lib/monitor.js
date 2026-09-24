'use strict';
// Orchestration layer: owns the Claude and Codex providers, merges them into Snapshot v2, applies the
// activity-window filter, attaches details for focused sessions (including per-session storage usage), and
// advances today's totals; also computes storage usage on demand (lib/storage.js, at most once per 10 minutes).
// Produces no UI text; no vscode dependency; shared by the worker and the terminal version.
// Keeps running without crashing if the Codex provider (lib/providers/codex.js) or lib/storage.js is missing or fails.

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
const STORAGE_TTL_MS = 10 * 60e3;          // storage usage is computed at most once per 10 minutes (unless forced)
const SESSION_STORAGE_TTL_MS = 60e3;       // per-session usage at most once per 60 s

function pos(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(String(a)) === path.resolve(String(b));
}

// Where a dir came from: same as the env var -> env; the default location -> default; otherwise from settings
function dirSourceOf(given, dir, envVal, def) {
  if (DIR_SOURCES.has(given)) return given;
  if (envVal && samePath(dir, envVal)) return 'env';
  if (samePath(dir, def)) return 'default';
  return 'setting';
}

/**
 * Fill in a WorkerConfig with defaults. Also accepts the legacy shape { root, activeWindowMinutes, staleMinutes }.
 * - claude.configDir: CLAUDE_CONFIG_DIR or ~/.claude (resolved by the extension); if absent, claude.home, then the parent of projectsDir.
 *   It is both the parent of the session registry sessions/ (home equals it) and the directory holding the user
 *   settings.json (claude.settingsPath is ignored when configDir is given).
 * - observedCompact: `${model}|${contextWindow}` -> observed auto-compaction point (passed in by the extension from globalState).
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
      // User settings = <configDir>/settings.json; configDir wins when given, the legacy settingsPath is used only otherwise
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
// Codex provider adapter: the provider lives in a separate module; this accepts the common interface shapes
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
  // Pass a superset config: the codex fields (home, ...) at top level plus the full WorkerConfig
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
    if (!inst) return { inst: null, error: 'codex provider has no usable constructor' };
    return { inst, error: null };
  } catch (err) {
    return { inst: null, error: 'init: ' + errText(err) };
  }
}

function callFirst(inst, names, args) {
  for (const n of names) if (inst && typeof inst[n] === 'function') return { found: true, value: inst[n](...args) };
  return { found: false, value: undefined };
}

// Various return shapes -> { sessions, quota (codex part) }
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
 * Whether two WorkerConfigs differ only in observedCompact (such a change needs no provider rebuild; the worker uses this to skip a full re-read).
 * @param {any} a result of normalizeConfig
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
   * @param {any} cfg WorkerConfig; missing fields get defaults
   * @param {{ codexModule?: any, storageModule?: any, isAlive?: (pid: number) => boolean, dayStart?: (now: number) => number,
   *   env?: Record<string, string|undefined> }} [deps] for tests: replace the Codex module, the storage module (null = unavailable), the liveness check, and start of day
   */
  constructor(cfg = {}, deps = {}) {
    this.cfg = normalizeConfig(cfg, deps.env || process.env);
    this.deps = deps;
    this.storageLib = undefined;  // lib/storage.js (loaded on first use)
    this.storageCache = null;     // { at, report }
    this.storagePending = null;   // in-flight scan (shared by concurrent requests)
    this.sessStorage = new Map(); // session key -> { at, value, pending }
    this.onChange = null;         // async result arrived (per-session storage): the worker uses it to send a snapshot soon
    this.windowMs = this.cfg.activeWindowMinutes * 60e3;
    this.focus = new Set();
    this.errors = new Map();      // source -> latest error message (cleared when the worker takes them)
    this.status = { claude: { enabled: this.cfg.claude.enabled, ok: true, error: null, registry: false },
      codex: { enabled: this.cfg.codex.enabled, ok: false, error: null } };
    this.started = new Map();     // sort key for Codex sessions missing startedMs (first-seen time, never changes)
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

  /** Take the accumulated errors [[source, message], ...] */
  takeErrors() {
    const out = [...this.errors];
    this.errors.clear();
    return out;
  }

  /** Session keys that need details (currently selected + current conversation); these are also exempt from the window filter */
  setFocus(keys) {
    this.focus = new Set((Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k));
  }

  /**
   * Swap the observed compaction-point table: no provider rebuild; takes effect on the next scan.
   * @param {Record<string, number>} map
   */
  setObservedCompact(map) {
    this.cfg.observedCompact = cleanObserved(map);
    if (this.claude) this.claude.setObservedCompact(this.cfg.observedCompact);
  }

  // lib/storage.js: null if missing or failing to load (storage features unavailable, everything else works)
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
   * Storage locations and usage. Without force, a cached result under 10 minutes old is returned (cached: true);
   * requests arriving while a scan is running share it. Also resolves (with error) on failure or when lib/storage.js is unavailable.
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
   * Storage usage of one session (the "transcript location" section of the right-hand view): computed asynchronously at
   * most once per 60 s; returns the previous result for now (null the first time) and calls onChange when done so the
   * worker sends a fresh snapshot soon.
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
        if (typeof this.onChange === 'function') { try { this.onChange(); } catch { /* ignore */ } }
      });
    return c.value;
  }

  async claudeSessionStorage(s) {
    const mod = this.storageModule();
    if (mod && typeof mod.sessionStorage === 'function') {
      // pass projectDir as the full path (the main transcript's directory); Session.projectDir is just the dir name
      return mod.sessionStorage({
        claudeDir: this.cfg.claude.configDir, projectsDir: this.cfg.claude.projectsDir,
        projectDir: s.transcript ? path.dirname(s.transcript) : null, sessionId: s.id, transcript: s.transcript,
      });
    }
    // lib/storage.js unavailable: report only the main transcript size
    return { transcriptBytes: await fileSize(s.transcript), subagentsBytes: null, fileHistoryBytes: null, transcript: s.transcript || null };
  }

  // Codex: main-thread rollout + sub-thread rollouts; there are no file backups
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
   * Scan once and return Snapshot v2 (without the type field; the worker adds it when posting).
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
        if (!call.found) throw new Error('codex provider has no scan / snapshot method');
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

    // Newest session start first; the sort key does not change with activity
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
   * Details for one session.
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
    try { if (this.claude) this.claude.dispose(); } catch { /* ignore */ }
    try { if (this.codex && typeof this.codex.dispose === 'function') this.codex.dispose(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Small legacy helpers kept for older callers (no UI text)
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
