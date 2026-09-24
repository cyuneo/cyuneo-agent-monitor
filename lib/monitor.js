'use strict';
// Orchestration layer: owns the Claude provider and the providers that share CodexProvider's interface (Codex, GitHub
// Copilot Chat, Gemini CLI, Qwen Code), merges them into Snapshot v2, applies the activity-window filter, attaches details
// for focused sessions (including per-session storage usage), and advances today's totals; also computes storage usage on
// demand (lib/storage.js, at most once per 10 minutes) and, only while the history page asks for it, the per-day usage
// history (lib/core/history.js, loaded on first use). Today's totals, history and storage cover Claude and Codex only.
// Produces no UI text; no vscode dependency; shared by the worker and the terminal version.
// Keeps running without crashing if any provider module (lib/providers/*.js) or lib/storage.js is missing or fails: each
// provider is created, scanned and disposed in isolation, and its errors are reported under its own source name.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ClaudeProvider, DEFAULT_LIMITS, defaultProjectsDir, projectDirName, cleanObserved } = require('./providers/claude');
const { DailyScanner, emptyDailyTotals } = require('./core/daily');
const quota = require('./core/quota');
const S = require('./core/status');

const DEFAULT_BUDGET = 8 * 1024 * 1024;
const DEFAULT_HISTORY_BUDGET = 16 * 1024 * 1024; // same as lib/core/history.js (not required here so it loads only when used)
const GUESS_MODES = new Set(Object.values(S.APPROVAL_GUESS));
const DIR_SOURCES = new Set(['env', 'setting', 'default']);
const STORAGE_TTL_MS = 10 * 60e3;          // storage usage is computed at most once per 10 minutes (unless forced)
const SESSION_STORAGE_TTL_MS = 60e3;       // per-session usage at most once per 60 s
const PROBE_MS = 30e3;                     // a lazy provider whose data folder is missing is looked for again this often
const STARTED_MAX = 2000;                  // remembered first-seen times (sessions a provider gave no startedMs)

// A dir from a setting or env var: trimmed; a leading ~ (~/… or ~\\…) is the user's home dir, as the extension resolves them
function expandHome(p, home = os.homedir()) {
  const s = typeof p === 'string' ? p.trim() : '';
  if (!s) return '';
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2));
  return s;
}

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
  const sub = (v) => (v && typeof v === 'object' ? v : {});
  const claude = sub(c.claude);
  const codex = sub(c.codex);
  const copilot = sub(c.copilot);
  const gemini = sub(c.gemini);
  const qwen = sub(c.qwen);
  const e = env || {};
  const claudeEnv = expandHome(e.CLAUDE_CONFIG_DIR) || undefined;
  const projectsDir = claude.projectsDir || c.root || defaultProjectsDir({ CLAUDE_CONFIG_DIR: claudeEnv });
  const configDir = claude.configDir || claude.home || path.dirname(projectsDir);
  // Dirs from settings and env vars may start with ~ (expanded as the extension does)
  const codexEnv = expandHome(e.CODEX_HOME) || undefined;
  const codexHome = expandHome(codex.home) || codexEnv || path.join(os.homedir(), '.codex');
  // Gemini CLI: <GEMINI_CLI_HOME>/.gemini, else ~/.gemini (lib/providers/gemini.js resolves the same way)
  const geminiBase = expandHome(e.GEMINI_CLI_HOME);
  const geminiEnv = geminiBase ? path.join(geminiBase, '.gemini') : undefined;
  const geminiDefault = path.join(os.homedir(), '.gemini');
  const geminiHome = expandHome(gemini.home) || geminiEnv || geminiDefault;
  // Qwen Code: QWEN_RUNTIME_DIR, then QWEN_HOME, else ~/.qwen (same order as lib/providers/qwen.js)
  const qwenEnv = expandHome(e.QWEN_RUNTIME_DIR) || expandHome(e.QWEN_HOME) || undefined;
  const qwenDefault = path.join(os.homedir(), '.qwen');
  const qwenHome = expandHome(qwen.home) || qwenEnv || qwenDefault;
  const copilotDir = expandHome(copilot.userDir) || null;
  return {
    intervalMs: pos(c.intervalMs, 2000),
    activeWindowMinutes: pos(c.activeWindowMinutes, 30),
    staleMinutes: pos(c.staleMinutes, 5),
    claude: {
      enabled: claude.enabled !== false,
      projectsDir,
      configDir,
      configDirSource: dirSourceOf(claude.configDirSource, configDir, claudeEnv, path.join(os.homedir(), '.claude')),
      // User settings = <configDir>/settings.json; configDir wins when given, the legacy settingsPath is used only otherwise
      settingsPath: claude.configDir ? path.join(configDir, 'settings.json') : (claude.settingsPath || path.join(configDir, 'settings.json')),
      home: configDir,
    },
    codex: {
      enabled: codex.enabled !== false,
      home: codexHome,
      homeSource: dirSourceOf(codex.homeSource, codexHome, codexEnv, path.join(os.homedir(), '.codex')),
    },
    // VS Code user dir (…/Code/User) holding Copilot Chat's session logs; null = the provider's defaults (Code, Code - Insiders)
    copilot: {
      enabled: copilot.enabled !== false,
      userDir: copilotDir,
    },
    gemini: {
      enabled: gemini.enabled !== false,
      home: geminiHome,
      homeSource: dirSourceOf(gemini.homeSource, geminiHome, geminiEnv, geminiDefault),
    },
    qwen: {
      enabled: qwen.enabled !== false,
      home: qwenHome,
      homeSource: dirSourceOf(qwen.homeSource, qwenHome, qwenEnv, qwenDefault),
    },
    observedCompact: cleanObserved(c.observedCompact),
    limits: { ...DEFAULT_LIMITS, ...(c.limits && typeof c.limits === 'object' ? c.limits : {}) },
    dailyBudgetBytesPerTick: pos(c.dailyBudgetBytesPerTick, DEFAULT_BUDGET),
    daily: c.daily !== false,
    // Usage history: where its cache is persisted (null = memory only) and the bytes it may read per slice
    historyCacheFile: typeof c.historyCacheFile === 'string' && c.historyCacheFile ? c.historyCacheFile : null,
    historyBudgetBytesPerTick: pos(c.historyBudgetBytesPerTick, DEFAULT_HISTORY_BUDGET),
    approvalGuess: GUESS_MODES.has(c.approvalGuess) ? c.approvalGuess : S.APPROVAL_GUESS.FAST_TOOLS,
    approvalGuessSeconds: pos(c.approvalGuessSeconds, S.APPROVAL_GUESS_DEFAULT_SECONDS),
    timeZone: typeof c.timeZone === 'string' && c.timeZone ? c.timeZone : undefined,
  };
}

// ---------------------------------------------------------------------------
// Provider registry: modules that share CodexProvider's interface
//   scan(now, { keepKeys }) → Session[] (or { sessions, quota }), detail(keyOrId), details(keys), has(keyOrId), quota(), dispose()
// Codex is built with the Monitor (as it always was). The others are lazy: their module is loaded and the provider built only
// once one of their data folders exists, checked at most every PROBE_MS, so a tool that is not installed costs a stat or two
// per PROBE_MS and nothing on the other ticks.
// ---------------------------------------------------------------------------

function errText(err) {
  return String((err && err.message) || err).split('\n')[0].slice(0, 300);
}

// Options every provider understands (a provider ignores what it does not use)
function commonOpts(cfg) {
  return {
    activeWindowMinutes: cfg.activeWindowMinutes,
    staleMinutes: cfg.staleMinutes,
    limits: cfg.limits,
    approvalGuess: cfg.approvalGuess,
    approvalGuessSeconds: cfg.approvalGuessSeconds,
    timeZone: cfg.timeZone,
  };
}

// Latest usage-limit hit from a provider's quota result ({ lastHit }); undefined when the value has no such shape
function lastHitOf(v) {
  if (!v || typeof v !== 'object' || !('lastHit' in v)) return undefined;
  const h = v.lastHit;
  return h && typeof h === 'object' && Number.isFinite(h.ms) ? { ...h } : null;
}

function codexQuotaOf(q) {
  if (!q || typeof q !== 'object') return null;
  if (q.codex && typeof q.codex === 'object') return q.codex;
  if (Array.isArray(q.windows)) return q;
  return null;
}

const PROVIDERS = Object.freeze({
  codex: Object.freeze({
    module: './providers/codex',
    ctor: 'CodexProvider',
    lazy: false,
    // A superset config: the codex fields (home, ...) at top level plus the full WorkerConfig
    options: (cfg) => ({
      ...cfg,
      ...cfg.codex,
      codexHome: cfg.codex.home,
      sessionsDir: path.join(cfg.codex.home, 'sessions'),
      codex: cfg.codex,
      claude: cfg.claude,
    }),
    // Codex keeps a real usage snapshot (rate_limits); a scan result that carries none falls back to quota()
    applyQuota(q, scanQuota, inst, now) {
      let cq = codexQuotaOf(scanQuota);
      if (!cq) {
        const qc = callFirst(inst, ['quota', 'getQuota', 'quotaSnapshot'], [now]);
        if (qc.found) cq = codexQuotaOf(qc.value);
      }
      if (cq) q.codex = cq;
    },
  }),
  copilot: Object.freeze({
    module: './providers/copilot',
    ctor: 'CopilotProvider',
    lazy: true,
    // The configured VS Code user dir, else the provider's defaults (Code, Code - Insiders, a portable install)
    roots: (cfg, mod, env) => (cfg.copilot.userDir ? [cfg.copilot.userDir]
      : mod && typeof mod.defaultUserDirs === 'function' ? mod.defaultUserDirs(env || process.env) : []),
    options: (cfg, env) => ({ ...commonOpts(cfg), ...(cfg.copilot.userDir ? { userDir: cfg.copilot.userDir } : {}), env }),
  }),
  gemini: Object.freeze({
    module: './providers/gemini',
    ctor: 'GeminiProvider',
    lazy: true,
    // Without a configured dir the CLI may also write under <base>/.cache/.gemini (macOS sandbox); the provider scans both
    roots: (cfg) => (cfg.gemini.homeSource === 'setting' ? [cfg.gemini.home]
      : [cfg.gemini.home, path.join(path.dirname(cfg.gemini.home), '.cache', '.gemini')]),
    // Only a configured dir is passed on: from the env / default the provider resolves it itself (and adds the sandbox dir)
    options: (cfg, env) => ({ ...commonOpts(cfg), ...(cfg.gemini.homeSource === 'setting' ? { geminiHome: cfg.gemini.home } : {}), env }),
  }),
  qwen: Object.freeze({
    module: './providers/qwen',
    ctor: 'QwenProvider',
    lazy: true,
    roots: (cfg) => [cfg.qwen.home],
    options: (cfg, env) => ({ ...commonOpts(cfg), qwenHome: cfg.qwen.home, env }),
  }),
});
// Scan order (sessions are sorted afterwards; this only decides whose errors come first)
const PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));
// Providers other than Codex, which report only { lastHit } for quota
const LAZY_PROVIDERS = Object.freeze(PROVIDER_NAMES.filter((n) => PROVIDERS[n].lazy));

function loadProvider(name, mod) {
  if (mod) return { mod, error: null };
  try {
    return { mod: require(PROVIDERS[name].module), error: null };
  } catch (err) {
    return { mod: null, error: 'load: ' + errText(err) };
  }
}

/**
 * Build one registered provider from its module (loaded here unless given). Never throws.
 * @param {string} name key of PROVIDERS
 * @param {any} cfg result of normalizeConfig
 * @param {any} [mod] the module (tests inject fakes)
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ inst: any, error: string|null }}
 */
function createProvider(name, cfg, mod, env) {
  const spec = PROVIDERS[name];
  if (!spec) return { inst: null, error: `unknown provider ${name}` };
  const loaded = loadProvider(name, mod);
  const m = loaded.mod;
  if (!m) return { inst: null, error: loaded.error };
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  try {
    const opts = spec.options(cfg, env);
    const Ctor = (m && (m[spec.ctor] || m.Provider || m.default)) || (typeof m === 'function' ? m : null);
    let inst = null;
    if (typeof Ctor === 'function') inst = new Ctor(opts);
    else if (m && typeof m.createProvider === 'function') inst = m.createProvider(opts);
    else if (m && typeof m[`create${cap}Provider`] === 'function') inst = m[`create${cap}Provider`](opts);
    if (!inst) return { inst: null, error: `${name} provider has no usable constructor` };
    return { inst, error: null };
  } catch (err) {
    return { inst: null, error: 'init: ' + errText(err) };
  }
}

function createCodex(cfg, mod) {
  return createProvider('codex', cfg, mod);
}

function callFirst(inst, names, args) {
  for (const n of names) if (inst && typeof inst[n] === 'function') return { found: true, value: inst[n](...args) };
  return { found: false, value: undefined };
}

// Various return shapes -> { sessions, quota (the provider's part) }
function normalizeScan(res) {
  if (Array.isArray(res)) return { sessions: res, quota: null };
  if (res && typeof res === 'object') {
    const q = res.quota ?? res.codexQuota ?? res.rateLimits ?? null;
    return { sessions: Array.isArray(res.sessions) ? res.sessions : [], quota: q };
  }
  return { sessions: [], quota: null };
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
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
   * @param {{ codexModule?: any, modules?: Record<string, any>, storageModule?: any, isAlive?: (pid: number) => boolean,
   *   dayStart?: (now: number) => number, env?: Record<string, string|undefined> }} [deps] for tests: replace the Codex module,
   *   other provider modules by name (modules.copilot / .gemini / .qwen), the storage module (null = unavailable), the
   *   liveness check, start of day and the environment
   */
  constructor(cfg = {}, deps = {}) {
    this.cfg = normalizeConfig(cfg, deps.env || process.env);
    this.deps = deps;
    this.storageLib = undefined;  // lib/storage.js (loaded on first use)
    this.storageCache = null;     // { at, report }
    this.storagePending = null;   // in-flight scan (shared by concurrent requests)
    this.sessStorage = new Map(); // session key -> { at, value, pending }
    this.onChange = null;         // async result arrived (per-session storage): the worker uses it to send a snapshot soon
    this.historyScanner = null;   // lib/core/history.js HistoryScanner, created by the first history() call
    this.windowMs = this.cfg.activeWindowMinutes * 60e3;
    this.focus = new Set();
    this.errors = new Map();      // source -> latest error message (cleared when the worker takes them)
    this.status = { claude: { enabled: this.cfg.claude.enabled, ok: true, error: null, registry: false },
      codex: { enabled: this.cfg.codex.enabled, ok: false, error: null } };
    // Lazy providers: ok until something fails; found = one of their data folders exists (the provider is built then)
    for (const name of LAZY_PROVIDERS) this.status[name] = { enabled: this.cfg[name].enabled, ok: true, error: null, found: false };
    this.started = new Map();     // sort key for provider sessions missing startedMs (first-seen time, never changes)
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
    // Registered providers (codex first, then the lazy ones); each slot: { name, spec, inst, mod, failed, lastProbe }
    this.slots = [];
    for (const name of PROVIDER_NAMES) {
      if (!this.cfg[name].enabled) continue;
      this.slots.push({ name, spec: PROVIDERS[name], inst: null, mod: null, failed: false, lastProbe: null });
    }
    this.codex = null;
    const codexSlot = this.slotOf('codex');
    if (codexSlot) {
      const r = createCodex(this.cfg, deps.codexModule);
      this.codex = codexSlot.inst = r.inst;
      codexSlot.failed = !r.inst;
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

  /** Slot of a registered provider that is enabled, or null */
  slotOf(name) {
    return this.slots.find((x) => x.name === name) || null;
  }

  /** A registered provider's instance (null when disabled, not built yet or failed) */
  provider(name) {
    const slot = this.slotOf(name);
    return slot ? slot.inst : null;
  }

  /**
   * The provider of a slot, building a lazy one once its data folder exists. The folder check runs at most every PROBE_MS
   * (or again at once if the clock went back); a module that fails to load or construct is reported once and not retried.
   * @returns {any|null}
   */
  ensure(slot, now) {
    if (slot.inst || slot.failed) return slot.inst;
    if (!slot.spec.lazy) return null;
    if (slot.lastProbe != null && now >= slot.lastProbe && now - slot.lastProbe < PROBE_MS) return null;
    slot.lastProbe = now;
    const st = this.status[slot.name];
    const env = this.deps.env;
    if (!slot.mod) {
      const injected = (this.deps.modules && this.deps.modules[slot.name]) || this.deps[slot.name + 'Module'];
      const r = loadProvider(slot.name, injected);
      if (!r.mod) {
        slot.failed = true;
        st.ok = false;
        this.fail(slot.name, r.error);
        return null;
      }
      slot.mod = r.mod;
    }
    let roots = [];
    try { roots = slot.spec.roots(this.cfg, slot.mod, env) || []; } catch { roots = []; }
    st.found = roots.some((d) => typeof d === 'string' && d && isDir(d));
    if (!st.found) return null;
    const r = createProvider(slot.name, this.cfg, slot.mod, env);
    slot.inst = r.inst;
    if (!r.inst) {
      slot.failed = true;
      st.ok = false;
      this.fail(slot.name, r.error);
    }
    return slot.inst;
  }

  /**
   * Scan one registered provider and add its sessions (window filter, keys, startedMs) and quota. A throwing provider
   * only marks its own source as failed; nothing it returned in that scan is used.
   */
  scanSlot(slot, now, sessions, q) {
    const name = slot.name;
    const st = this.status[name];
    const inst = this.ensure(slot, now);
    if (!inst) return;
    const out = [];
    try {
      const keep = [...this.focus].filter((k) => k.startsWith(name + ':'));
      const call = callFirst(inst, ['scan', 'snapshot', 'poll', 'tick'], [now, { keep, keepKeys: keep }]);
      if (!call.found) throw new Error(`${name} provider has no scan / snapshot method`);
      const r = normalizeScan(call.value);
      for (const s of r.sessions) {
        if (!s || typeof s !== 'object' || !s.id) continue;
        if (!s.key) s.key = S.sessionKey(name, s.id);
        if (!s.provider) s.provider = name;
        if (!Number.isFinite(s.startedMs)) s.startedMs = this.pin(s.key, s.createdMs, now);
        if (typeof s.live !== 'boolean') s.live = false;
        const inWindow = now - (s.updatedMs || 0) < this.windowMs;
        if (!inWindow && !s.live && !this.focus.has(s.key)) continue;
        out.push(s);
      }
      st.ok = true;
      st.error = null;
      // A failing quota read is reported but keeps the sessions
      try {
        if (slot.spec.applyQuota) slot.spec.applyQuota(q, r.quota, inst, now);
        else {
          let hit = lastHitOf(r.quota);
          if (hit === undefined) {
            const qc = callFirst(inst, ['quota', 'getQuota', 'quotaSnapshot'], [now]);
            if (qc.found) hit = lastHitOf(qc.value);
          }
          q[name] = { lastHit: hit || null };
        }
      } catch (err) {
        this.fail(name, 'quota: ' + errText(err));
      }
    } catch (err) {
      st.ok = false;
      this.fail(name, errText(err));
      return;
    }
    for (const s of out) sessions.push(s);
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
    const job = s.provider === 'claude' ? () => this.claudeSessionStorage(s)
      : s.provider === 'codex' ? () => this.codexSessionStorage(s) : () => this.fileSessionStorage(s);
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

  // Copilot / Gemini / Qwen: the main session file, plus sub-agent files other than it (Copilot and Qwen keep sub-agents in
  // the same file, Gemini in files of their own); no file backups
  async fileSessionStorage(s) {
    const transcript = s.transcript || (s.main && s.main.file) || null;
    const transcriptBytes = await fileSize(transcript);
    const seen = new Set(transcript ? [path.resolve(transcript)] : []);
    let subagentsBytes = null;
    for (const a of s.agents || []) {
      const f = a && typeof a.file === 'string' && a.file ? path.resolve(a.file) : null;
      if (!f || seen.has(f)) continue;
      seen.add(f);
      const n = await fileSize(f);
      if (n != null) subagentsBytes = (subagentsBytes || 0) + n;
    }
    return { transcriptBytes, subagentsBytes, fileHistoryBytes: null, transcript };
  }

  /**
   * Usage history: applies the request, reads one budgeted slice and returns the report (partial until every file in
   * the window has been read; call again to continue). Never throws: failures come back with error set.
   * @param {{ days?: number, force?: boolean, now?: number }} [o] force: re-list and re-check files now
   */
  history(o = {}) {
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    let mod = null;
    try {
      mod = require('./core/history');
      if (!this.historyScanner) {
        this.historyScanner = new mod.HistoryScanner({
          claudeProjectsDir: this.cfg.claude.enabled ? this.cfg.claude.projectsDir : null,
          codexHome: this.cfg.codex.enabled ? this.cfg.codex.home : null,
          cacheFile: this.cfg.historyCacheFile,
          budgetBytes: this.cfg.historyBudgetBytesPerTick,
          days: o.days,
        });
      }
      const h = this.historyScanner;
      h.request({ days: o.days, force: o.force === true });
      return h.step(now);
    } catch (err) {
      this.fail('history', errText(err));
      const empty = mod ? mod.emptyHistoryReport(o.days, now) : { at: now, days: [], byModel: [], totals: null, partial: false };
      return { ...empty, partial: false, error: errText(err) };
    }
  }

  /** Save the history cache and free the scanner's memory (the history page closed or went idle) */
  historyRelease() {
    const h = this.historyScanner;
    this.historyScanner = null;
    if (h) { try { h.dispose(); } catch (err) { this.fail('history', errText(err)); } }
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

    // Codex, Copilot, Gemini, Qwen: each in isolation
    for (const lazy of LAZY_PROVIDERS) q[lazy] = { lastHit: null };
    for (const slot of this.slots) this.scanSlot(slot, now, sessions, q);

    // First-seen times of sessions that no longer show up are dropped once there are many (bounded over a long run)
    if (this.started.size > STARTED_MAX) {
      const shown = new Set(sessions.map((s) => s.key));
      for (const k of [...this.started.keys()]) if (!shown.has(k)) this.started.delete(k);
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
      sources: Object.fromEntries(Object.entries(this.status).map(([k, v]) => [k, { ...v }])),
    };
  }

  /**
   * Details for one session.
   * @param {string} key 'claude:<id>' / 'codex:<id>' / 'copilot:<id>' / 'gemini:<id>' / 'qwen:<id>'
   */
  detail(key) {
    const k = S.parseSessionKey(key);
    if (!k) return null;
    try {
      if (k.provider === 'claude') return this.claude ? this.claude.detail(k.id) : null;
      const inst = this.provider(k.provider);
      if (inst) {
        let r = callFirst(inst, ['detail', 'sessionDetail', 'getDetail'], [key]);
        if (r.found && !r.value) r = callFirst(inst, ['detail', 'sessionDetail', 'getDetail'], [k.id]);
        if (r.found) return r.value || null;
        const many = callFirst(inst, ['details'], [[key]]);
        if (many.found && many.value) return many.value[key] || null;
      }
    } catch (err) {
      this.fail(k.provider, errText(err));
    }
    return null;
  }

  dispose() {
    this.historyRelease();
    try { if (this.claude) this.claude.dispose(); } catch { /* ignore */ }
    for (const slot of this.slots) {
      try { if (slot.inst && typeof slot.inst.dispose === 'function') slot.inst.dispose(); } catch { /* ignore */ }
    }
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
  Monitor, normalizeConfig, createCodex, createProvider, sameExceptObserved, expandHome,
  PROVIDERS, PROVIDER_NAMES, LAZY_PROVIDERS, PROBE_MS,
  STORAGE_TTL_MS, SESSION_STORAGE_TTL_MS,
  projectDirName, DEFAULT_ROOT,
  fmtTokens, fmtDur,
};
