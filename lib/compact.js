'use strict';
// The compact button and three kinds of reminders.
// - Command agentMonitor.compact (argument: a session tree node or sessionKey) shows a QuickPick:
//   Claude session open → compact in the session (prefilled, not sent automatically); Claude session not open → pick a model and run the local Claude Code in the background to compact;
//   Codex → open + copy /compact. All three also offer "write a handoff note, then start a new session".
// - The handoff note is also a standalone command, agentMonitor.handoff: this module exports runHandoff and extension.js registers it.
// - deliverText (prefill + clipboard fallback) is exported for lib/autocompact.js to prefill /autocompact.
// - Background compaction: spawn without a shell, stdin set to ignore; sessionId must be a UUID, the model must come from the candidate allowlist, and cwd must exist;
//   the live registry is read again right before running, and the run is aborted if the session has been opened.
// - The extension itself never goes online: only after the user confirms does it call the local Claude Code, which does the network access. Nothing is compacted without a user click.
// - Option building, cost estimates, argument validation, CLI lookup, child process runs, result parsing and reminder decisions are pure functions with no vscode dependency, called directly by tests;
//   vscode is only used inside activateCompact.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const S = require('./core/status');
const pricing = require('./core/pricing');
const { claudeWindow } = require('./core/context');
const claudeLive = require('./providers/claude-live');
const scopeLib = require('./scope');
const { entryLabel, COMPACTABLE_MIN } = require('./format');

const CMD = 'agentMonitor.compact';
const CLAUDE_OPEN_CMD = 'claude-vscode.editor.open';   // Claude extension: open the session and prefill the prompt (without sending)
const CLAUDE_EXT_ID = 'anthropic.claude-code';
const CLAUDE_VSCODE_ENTRY = 'claude-vscode';
const CODEX_AUTHORITY = 'openai.chatgpt';               // Codex extension's URI handler: path is used as the page route
const COMPACT_CMD = '/compact';

const TIMEOUT_MS = 10 * 60e3;          // time out after 10 minutes
const KILL_GRACE_MS = 3000;            // SIGKILL if still running this long after SIGTERM
const STDOUT_MAX = 4 * 1024 * 1024;    // the result JSON is small; defensive cap
const STDERR_KEEP = 64 * 1024;         // keep only the tail of stderr
const TAIL_LINES = 5;                  // show the last 5 lines of stderr on failure
const BOUNDARY_SCAN_MAX = 8 * 1024 * 1024;
const TEXT_MAX = 2000;                 // maximum length of the retention instructions
const CHEAPER_MIN_SAVING = 0.3;        // only show the info item if switching to Sonnet 5 saves ≥ 30%
const REMIND_MIN_GAIN_USD = 0.5;       // only remind if compacting after expiry costs at least $0.50 more than compacting now
const SONNET_TARGET = 'claude-sonnet-5';
// A session counts as "closed" only after this many consecutive snapshots without it in the registry: a read can fail while the registry file is being rewritten, making the session seem to vanish once
const CLOSE_CONFIRM_SNAPSHOTS = 2;

// Shape of a model id (a second line of defense beyond the allowlist): letters, digits, dots, hyphens, optionally [1m]
const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{0,79}(\[1m\])?$/i;
// Codex thread ids go into a URI, so only these characters are allowed
const CODEX_ID_RE = /^[A-Za-z0-9][\w-]{0,127}$/;

const MUTE_KEY = 'agentMonitor.compact.muted';             // workspaceState: { [sessionId]: ms }, "don't remind me again for this session"
const HINT_OFF_KEY = 'agentMonitor.compact.postHintOff';   // globalState: "don't show again" for the post-compaction hint

const DEFAULTS = Object.freeze({
  compactConfirm: true,
  compactTemplate: '',
  cacheReminder: true,
  cacheReminderMinutes: 8,           // default: 8 minutes
  cacheReminderMinContext: 150000,
  cacheReminderShortTtl: false,
  closeReminder: true,
  postCompactHint: true,
});

const SEPARATOR_KIND = -1; // vscode.QuickPickItemKind.Separator

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clip = (s, n) => {
  const a = Array.from(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
  return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join('');
};

// ---------------------------------------------------------------------------
// Session fields
// ---------------------------------------------------------------------------

/** Context usage of a session (top-level Session field, falling back to the main agent's) */
function contextUsedOf(s) {
  if (!s) return 0;
  if (fin(s.contextUsed)) return s.contextUsed;
  const t = s.main && s.main.tokens;
  return t && fin(t.contextUsed) ? t.contextUsed : 0;
}

/** The cache timer runs from API calls, so use lastApiMs (lastActivityMs only if missing) */
function lastApiOf(s) {
  if (fin(s.lastApiMs)) return s.lastApiMs;
  if (fin(s.lastActivityMs)) return s.lastActivityMs;
  const m = s.main;
  if (m && fin(m.lastApiMs)) return m.lastApiMs;
  return m && fin(m.lastActivityMs) ? m.lastActivityMs : null;
}

/** TTL the compaction request will use: the tier most recently detected for the session; if undetected, assume 1h as for a subscription's main conversation */
function ttlOf(s) {
  return s && (s.cacheTtl === '5m' || s.cacheTtl === '1h') ? s.cacheTtl : '1h';
}

function isHaiku(model) {
  return pricing.normalizeClaudeModel(model).startsWith('claude-haiku');
}

/** Command argument → sessionKey: a string, or a session tree node (key / sessionKey / session.key) */
function keyFromArg(arg) {
  if (typeof arg === 'string') return arg;
  if (!arg || typeof arg !== 'object') return null;
  for (const v of [arg.sessionKey, arg.key, arg.session && arg.session.key]) {
    if (typeof v === 'string' && v) return v;
  }
  if (typeof arg.provider === 'string' && typeof arg.id === 'string') return S.sessionKey(arg.provider, arg.id);
  // form where TreeItem.id is the sessionKey itself
  const p = typeof arg.id === 'string' ? S.parseSessionKey(arg.id) : null;
  if (p && (p.provider === 'claude' || p.provider === 'codex')) return arg.id;
  return null;
}

// ---------------------------------------------------------------------------
// Cost estimates
// ---------------------------------------------------------------------------

/**
 * On a cache miss, the base estimateCompact always prices at the 5-minute cache write rate, but the price should follow the TTL this request will use.
 * This only switches to the 1-hour rate when the result exactly equals the 5-minute rate, so it will not double-convert once the base is fixed.
 */
function applyTtl(est, ttl) {
  if (!est || ttl !== '1h' || est.pricing !== 'miss' || !est.available || est.readUsd == null) return est;
  const r = pricing.claudeRates(est.targetModel);
  if (!r) return est;
  const at5m = est.contextTokens * r.cacheWrite5m / 1e6;
  if (Math.abs(est.readUsd - at5m) > 1e-9 || r.cacheWrite1h === r.cacheWrite5m) return est;
  const readUsd = est.contextTokens * r.cacheWrite1h / 1e6;
  return { ...est, readUsd, usd: readUsd + (est.writeUsd || 0) };
}

/**
 * Cost estimate for one compaction. o.expired = true: price as if the cache has expired (the "compact after expiry" figure in reminders).
 * @returns {ReturnType<typeof pricing.estimateCompact>}
 */
function estimateFor(session, targetModel, now, o = {}) {
  const ttl = ttlOf(session);
  const est = pricing.estimateCompact({
    contextUsed: contextUsedOf(session),
    model: session.model || null,
    targetModel: targetModel || session.model || null,
    ttl,
    lastActivityMs: o.expired ? null : lastApiOf(session),
    now,
    isMain: true,
  });
  return applyTtl(est, ttl);
}

/**
 * Recommended item: the cheapest among those that are available, priced and have an id; ties keep the first one (the original model comes first).
 * @param {{ id: string|null, available: boolean, usd: number|null }[]} list
 */
function pickRecommended(list) {
  let best = null;
  for (const c of list) {
    if (!c.id || !c.available || c.usd == null) continue;
    if (!best || c.usd < best.usd - 1e-9) best = c;
  }
  return best;
}

/**
 * Background compaction candidates: the original model, claude-sonnet-5, claude-haiku-4-5; after TTL-adjusting the estimates, recompute the recommendation and savings ratio.
 * @returns {{ candidates: any[], recommended: string|null }}
 */
function candidatesFor(session, now) {
  const ttl = ttlOf(session);
  const base = pricing.compactCandidates({
    contextUsed: contextUsedOf(session),
    model: session.model || null,
    ttl,
    lastActivityMs: lastApiOf(session),
    now,
    isMain: true,
  });
  const list = base.candidates.map((c) => ({ ...applyTtl(c, ttl), recommended: false, savingVsOriginal: null }));
  const orig = list[0];
  for (const c of list) {
    if (c !== orig && orig && orig.usd != null && c.usd != null && orig.usd > 0) c.savingVsOriginal = (orig.usd - c.usd) / orig.usd;
  }
  const best = pickRecommended(list);
  if (best) best.recommended = true;
  return { candidates: list, recommended: best ? best.id : null };
}

/**
 * Value passed to --model: if the original model has a 200K window but usage is already past 200K (1M extended context is on, and the transcript lacks [1m]) → append [1m].
 * @param {string} id candidate id
 * @param {any} session
 */
function cliModelFor(id, session) {
  if (!id) return null;
  const same = pricing.normalizeClaudeModel(id) === pricing.normalizeClaudeModel(session.model);
  if (!same || /\[1m\]$/i.test(id)) return id;
  const used = contextUsedOf(session);
  const { window } = claudeWindow(id, 0);
  return used + pricing.COMPACT_HEADROOM > window ? id + '[1m]' : id;
}

/** All values allowed for --model for this session (the allowlist) */
function allowedModels(session, now = Date.now()) {
  const out = [];
  for (const c of candidatesFor(session, now).candidates) {
    if (!c.id || !c.available || !MODEL_ID_RE.test(c.id)) continue;
    const m = cliModelFor(c.id, session);
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Retention instructions: use the compactTemplate setting if non-empty, otherwise the dictionary. Strips a leading /compact the user may have added. */
function resolveTemplate(configValue, i18n) {
  const own = typeof configValue === 'string' ? normalizeInstructions(configValue) : '';
  return own || normalizeInstructions(i18n.t('compact.template'));
}

/** Normalize retention instructions to one line: strip a leading /compact, turn newlines into spaces, cap the length */
function normalizeInstructions(text) {
  let s = String(text == null ? '' : text).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  s = s.replace(/^\/compact\b\s*/i, '').trim();
  if (s.length > TEXT_MAX) s = s.slice(0, TEXT_MAX);
  return s;
}

/** '/compact' or '/compact {retention instructions}' */
function compactPrompt(instructions) {
  const s = normalizeInstructions(instructions);
  return s ? `${COMPACT_CMD} ${s}` : COMPACT_CMD;
}

/** Last n non-empty lines of stderr */
function tailLines(text, n = TAIL_LINES) {
  return String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).slice(-n);
}

function usdText(est, i18n) {
  if (est && est.usd != null) return i18n.t('compact.detail.usd', { usd: i18n.fmtUsd(est.usd) });
  return i18n.t('compact.detail.unpriced', { model: (est && est.targetModel) || '—' });
}

function cacheText(est, session, i18n, now) {
  if (!est.sameModel) return i18n.t('compact.detail.newModel');
  if (est.pricing === 'hit') {
    const exp = session.cacheExpiresMs;
    if (fin(exp) && exp > now) return i18n.t('compact.detail.cacheWarmLeft', { m: Math.max(1, Math.ceil((exp - now) / 60e3)) });
    return i18n.t('compact.detail.cacheWarm');
  }
  return i18n.t('compact.detail.cacheExpired');
}

// ---------------------------------------------------------------------------
// QuickPick items
// ---------------------------------------------------------------------------

/**
 * Build the QuickPick title, notes and items. Pure function; item.action describes what happens when selected:
 * - { type: 'inSession' }: prefill /compact {template}; { type: 'custom' }: edit the retention instructions in an InputBox first, then prefill
 * - { type: 'background', model }: background compaction (model is the --model value)
 * - { type: 'handoff' }: write a handoff note; { type: 'codexOpen' }: open Codex and copy /compact
 * - { type: 'info', text }: just show the explanation, do nothing
 * @param {any} session
 * @param {{ i18n: any, now?: number, live: boolean, liveStatus?: string|null, separatorKind?: number }} ctx
 * @returns {{ title: string, placeholder: string, items: any[], active: any|null }}
 */
function buildPickItems(session, ctx) {
  const i18n = ctx.i18n;
  const now = ctx.now ?? Date.now();
  const sep = { label: '', kind: ctx.separatorKind ?? SEPARATOR_KIND };
  const used = contextUsedOf(session);
  const title = i18n.t('compact.pick.title', { title: clip(session.title || session.id, 60), tokens: i18n.fmtTokens(used) });
  const items = [];
  const info = (icon, text, extra) => ({ label: `$(${icon}) ${text}`, action: { type: 'info', text }, ...extra });
  let active = null;

  if (session.provider === 'codex') {
    items.push(info('info', i18n.t('compact.info.rulesCodex')));
    items.push(sep);
    active = {
      label: '$(link-external) ' + i18n.t('compact.item.codexOpen'),
      detail: i18n.t('compact.item.codexOpen.detail'),
      action: { type: 'codexOpen' },
    };
    items.push(active);
    items.push(handoffItem(i18n));
    return { title, placeholder: i18n.t('compact.pick.placeholder.codex'), items, active };
  }

  // Claude: two lines of notes at the top, as normal-size info items rather than small text on a separator
  items.push(info('info', i18n.t('compact.info.rules')));
  items.push(info('discard', i18n.t('compact.info.rewind')));
  items.push(sep);
  const placeholder = i18n.t('compact.pick.costNote', { date: pricing.PRICES_UPDATED });

  if (ctx.live) {
    const est = estimateFor(session, session.model, now);
    const parts = [];
    if (ctx.liveStatus === S.LIVE_STATUS.BUSY) parts.push(i18n.t('compact.detail.busy'));
    parts.push(cacheText(est, session, i18n, now), usdText(est, i18n));
    active = {
      label: '$(screen-normal) ' + (session.model
        ? i18n.t('compact.item.inSession', { model: session.model })
        : i18n.t('compact.item.inSession.noModel')),
      detail: parts.join(' · '),
      action: { type: 'inSession' },
    };
    items.push(active);
    items.push({
      label: '$(edit) ' + i18n.t('compact.item.custom'),
      detail: i18n.t('compact.item.custom.detail'),
      action: { type: 'custom' },
    });
    items.push(handoffItem(i18n));
    // Cache may have expired and switching to Sonnet 5 saves ≥ 30% → add an info item below a separator
    const { candidates } = candidatesFor(session, now);
    const orig = candidates[0];
    const son = candidates.find((c) => c.role === 'target' && pricing.normalizeClaudeModel(c.id) === SONNET_TARGET);
    if (orig && orig.id && orig.cacheLikelyExpired && son && son.available && son.usd != null
      && son.savingVsOriginal != null && son.savingVsOriginal >= CHEAPER_MIN_SAVING) {
      const text = i18n.t('compact.item.cheaper.detail', { usd: i18n.fmtUsd(son.usd) });
      items.push(sep);
      items.push({ label: '$(lightbulb) ' + i18n.t('compact.item.cheaper'), detail: text, action: { type: 'info', text } });
    }
    return { title, placeholder, items, active };
  }

  // Not open: background compaction with a choice of model. Recommended item first, the rest in candidate order, unavailable ones last
  const { candidates } = candidatesFor(session, now);
  const usable = candidates.filter((c) => c.id && c.available);
  const ordered = [...usable.filter((c) => c.recommended), ...usable.filter((c) => !c.recommended)];
  for (const c of ordered) {
    const parts = [cacheText(c, session, i18n, now), usdText(c, i18n)];
    if (c.recommended && c.sameModel && c.pricing === 'hit') parts.push(i18n.t('compact.detail.warmBest'));
    if (c.savingVsOriginal != null && c.savingVsOriginal >= 0.05) parts.push(i18n.t('compact.detail.saving', { pct: i18n.fmtPct(c.savingVsOriginal) }));
    if (c.sameModel && c.pricing === 'hit') {
      // Inferred: a background -p request has a different system prompt and tools from the session, so it may not hit the cache
      const miss = estimateFor(session, c.id, now, { expired: true });
      if (miss.usd != null) parts.push(i18n.t('compact.detail.bgMayMiss', { usd: i18n.fmtUsd(miss.usd) }));
    }
    if (isHaiku(c.id)) parts.push(i18n.t('compact.detail.haiku'));
    const item = {
      label: '$(server-process) ' + i18n.t('compact.item.background', { model: c.id }),
      description: c.recommended ? i18n.t('compact.recommended') : undefined,
      detail: parts.join(' · '),
      action: { type: 'background', model: cliModelFor(c.id, session) },
    };
    if (!active) active = item;
    items.push(item);
  }
  for (const c of candidates) {
    if (!c.id || c.available) continue;
    const text = i18n.t('compact.detail.window', { model: c.id, window: i18n.fmtTokens(c.targetWindow) });
    items.push({ label: '$(circle-slash) ' + i18n.t('compact.item.unavailable', { model: c.id }), detail: text, action: { type: 'info', text } });
  }
  if (!candidates[0] || !candidates[0].id) {
    const text = i18n.t('compact.detail.noModel');
    items.push({ label: '$(question) ' + text, action: { type: 'info', text } });
  }
  items.push(handoffItem(i18n));
  return { title, placeholder, items, active };
}

function handoffItem(i18n) {
  return {
    label: '$(note) ' + i18n.t('compact.item.handoff'),
    detail: i18n.t('compact.item.handoff.detail'),
    action: { type: 'handoff' },
  };
}

// ---------------------------------------------------------------------------
// Send text into a session (prefill with clipboard fallback; autocompact.js also uses this to prefill /autocompact)
// ---------------------------------------------------------------------------

/**
 * Claude (claude-vscode entrypoint): prefill via claude-vscode.editor.open (without sending) and also copy to the clipboard;
 * other entrypoints: copy only; Codex: open the conversation + copy. Returns the message text shown to the user.
 * @param {any} vscode
 * @param {any} session
 * @param {string} text
 * @param {{ i18n: any, liveNow?: boolean, log?: (line: string) => void }} o
 * @returns {Promise<string>}
 */
async function deliverText(vscode, session, text, o) {
  const i18n = o.i18n;
  const log = o.log || (() => {});
  try { await vscode.env.clipboard.writeText(text); } catch (err) { log(`clipboard: ${err && err.message}`); }
  if (session.provider === 'codex') {
    let opened = false;
    if (CODEX_ID_RE.test(String(session.id))) {
      try {
        const scheme = (vscode.env && vscode.env.uriScheme) || 'vscode';
        opened = !!(await vscode.env.openExternal(vscode.Uri.parse(`${scheme}://${CODEX_AUTHORITY}/local/${session.id}`)));
      } catch (err) {
        log(`openExternal failed: ${err && err.message}`);
      }
    }
    return i18n.t(opened ? 'compact.deliver.codexOpened' : 'compact.deliver.codexCopied');
  }
  const entrypoint = session.entrypoint || (session.entry === 'vscode' ? CLAUDE_VSCODE_ENTRY : null);
  if (entrypoint === CLAUDE_VSCODE_ENTRY && S.isUuid(session.id)) {
    try {
      // The 6th argument keeps Claude's own preferred location; without it the command switches it to "panel"
      await vscode.commands.executeCommand(CLAUDE_OPEN_CMD, session.id, text, undefined, undefined, undefined,
        { programmatic: 'honor-preferred-location' });
      return i18n.t('compact.deliver.opened');
    } catch (err) {
      log(`${CLAUDE_OPEN_CMD} failed: ${err && err.message}`);
      return i18n.t('compact.deliver.copied');
    }
  }
  if (entrypoint && entrypoint !== CLAUDE_VSCODE_ENTRY) {
    return o.liveNow
      ? i18n.t('compact.deliver.copiedOther', { where: entryLabel(session.entry, i18n) })
      : i18n.t('compact.deliver.copiedClosed');
  }
  return i18n.t('compact.deliver.copied');
}

// ---------------------------------------------------------------------------
// Background compaction: validation, CLI lookup, child process
// ---------------------------------------------------------------------------

/** spawn arguments, in a fixed order */
function buildSpawnArgs(sessionId, model, prompt) {
  return ['-p', '--resume', sessionId, '--model', model, '--output-format', 'json', prompt];
}

/**
 * Argument validation before background compaction. Returns null if valid, otherwise a dictionary key.
 * @param {{ sessionId: any, model: any, allowed: string[], cwd: any, statSync?: typeof fs.statSync }} o
 */
function validateBackground(o) {
  if (!S.isUuid(o.sessionId)) return 'compact.error.badId';
  if (typeof o.model !== 'string' || !MODEL_ID_RE.test(o.model) || !(o.allowed || []).includes(o.model)) return 'compact.error.badModel';
  if (typeof o.cwd !== 'string' || !o.cwd || !path.isAbsolute(o.cwd)) return 'compact.error.cwd';
  try {
    if (!(o.statSync || fs.statSync)(o.cwd).isDirectory()) return 'compact.error.cwd';
  } catch {
    return 'compact.error.cwd';
  }
  return null;
}

function isRunnable(p, platform, fsImpl = fs) {
  try {
    if (!fsImpl.statSync(p).isFile()) return false;
    if (platform === 'win32') return true; // Windows has no execute bit
    fsImpl.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Home directory for ~ in the cliPath setting. macOS / Linux: HOME, then os.homedir().
 * Windows: USERPROFILE, then os.homedir(); HOME is ignored there because Git Bash / MSYS can set it to a POSIX-style path (/c/Users/...).
 */
function homeFor(env, platform = process.platform) {
  const e = env || {};
  return (platform === 'win32' ? e.USERPROFILE : e.HOME) || os.homedir();
}

function expandHome(p, env, platform) {
  if (p === '~') return homeFor(env, platform);
  if (/^~[/\\]/.test(p)) return path.join(homeFor(env, platform), p.slice(2));
  return p;
}

/**
 * Find the Claude Code CLI:
 * 1. The agentMonitor.claude.cliPath setting (set but not executable → error, never silently fall back to another);
 * 2. claude on PATH (walked in plain JS, absolute directories only; on Windows look for claude.exe / claude.cmd);
 * 3. The Claude extension's bundled resources/native-binary/claude (claude.exe on Windows), used only if the file exists;
 * 4. None found → { error: 'notFound' }.
 * A Windows .cmd cannot start without a shell, so when PATH only has a .cmd it ranks after the extension's bundled .exe, and is blocked before spawn.
 * @param {{ cliPath?: string, env?: Record<string, string|undefined>, platform?: string, extensionPath?: string|null, fs?: any }} o
 * @returns {{ path: string, source: 'setting'|'path'|'extension' } | { error: 'cliPath'|'notFound', path?: string }}
 */
function findCli(o = {}) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const fsImpl = o.fs || fs;
  const win = platform === 'win32';
  const pathMod = path; // join paths with the host's path module (path.win32 when actually on Windows); platform only decides separators and file names
  const setting = typeof o.cliPath === 'string' ? o.cliPath.trim() : '';
  if (setting) {
    const p = expandHome(setting, env, platform);
    if (pathMod.isAbsolute(p) && isRunnable(p, platform, fsImpl)) return { path: p, source: 'setting' };
    return { error: 'cliPath', path: setting };
  }
  const pathVar = env.PATH || env.Path || env.path || '';
  const dirs = String(pathVar).split(win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => d && pathMod.isAbsolute(d));
  let shim = null;
  for (const dir of dirs) {
    if (win) {
      const exe = pathMod.join(dir, 'claude.exe');
      if (isRunnable(exe, platform, fsImpl)) return { path: exe, source: 'path' };
      const cmd = pathMod.join(dir, 'claude.cmd');
      if (!shim && isRunnable(cmd, platform, fsImpl)) shim = cmd;
    } else {
      const p = pathMod.join(dir, 'claude');
      if (isRunnable(p, platform, fsImpl)) return { path: p, source: 'path' };
    }
  }
  if (o.extensionPath) {
    const p = pathMod.join(o.extensionPath, 'resources', 'native-binary', win ? 'claude.exe' : 'claude');
    if (isRunnable(p, platform, fsImpl)) return { path: p, source: 'extension' };
  }
  if (shim) return { path: shim, source: 'path' };
  return { error: 'notFound' };
}

/** Windows batch files (.cmd / .bat) cannot start without a shell */
function needsShell(cli) {
  return /\.(cmd|bat)$/i.test(String(cli || ''));
}

/** Extract the result JSON from stdout: use the whole output if it parses; otherwise search backwards for a line with type result */
function parseResultJson(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    if (Array.isArray(j)) return [...j].reverse().find((x) => x && x.type === 'result') || null;
  } catch { /* multi-line output; search line by line */ }
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('{')) continue;
    try {
      const j = JSON.parse(l);
      if (j && typeof j === 'object' && (j.type === 'result' || 'is_error' in j)) return j;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Run the background compaction child process. No shell, stdin set to ignore; cancellable, and the child is terminated on timeout.
 * @param {{ cli: string, args: string[], cwd: string, timeoutMs?: number,
 *   token?: { isCancellationRequested?: boolean, onCancellationRequested?: Function },
 *   spawn?: typeof cp.spawn, env?: Record<string, string>, onChild?: (child: any) => void }} o
 * @returns {Promise<{ outcome: 'ok'|'failed'|'cancelled'|'timeout'|'spawnError', code: number|null, signal: string|null,
 *   json: any, stdout: string, stderr: string, error: string|null, durationMs: number, pid: number|null }>}
 */
function runCompact(o) {
  return new Promise((resolve) => {
    const started = Date.now();
    const base = { code: null, signal: null, json: null, stdout: '', stderr: '', error: null, pid: null };
    let child;
    try {
      child = (o.spawn || cp.spawn)(o.cli, o.args, {
        cwd: o.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        env: o.env || process.env,
      });
    } catch (err) {
      resolve({ ...base, outcome: 'spawnError', error: String((err && err.message) || err), durationMs: 0 });
      return;
    }
    if (o.onChild) o.onChild(child);
    const out = [];
    let outLen = 0;
    let err = '';
    let reason = null;
    let done = false;
    let killTimer = null;
    let sub = null;
    const kill = () => {
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
      if (!killTimer) {
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } }, KILL_GRACE_MS);
        if (killTimer.unref) killTimer.unref();
      }
    };
    const timer = setTimeout(() => { reason = reason || 'timeout'; kill(); }, o.timeoutMs || TIMEOUT_MS);
    if (o.token) {
      if (o.token.isCancellationRequested) { reason = 'cancelled'; kill(); }
      if (typeof o.token.onCancellationRequested === 'function') {
        sub = o.token.onCancellationRequested(() => { reason = reason || 'cancelled'; kill(); });
      }
    }
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killTimer && r.outcome !== 'spawnError') clearTimeout(killTimer);
      if (sub && typeof sub.dispose === 'function') sub.dispose();
      resolve({ ...base, pid: child.pid ?? null, durationMs: Date.now() - started, ...r });
    };
    if (child.stdout) {
      child.stdout.on('data', (b) => {
        if (outLen >= STDOUT_MAX) return;
        out.push(b);
        outLen += b.length;
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (b) => {
        err += b.toString('utf8');
        if (err.length > STDERR_KEEP * 2) err = err.slice(-STDERR_KEEP);
      });
    }
    child.on('error', (e) => {
      if (reason) return; // error from terminating the child; the close event is authoritative
      finish({ outcome: 'spawnError', error: String((e && e.message) || e) });
    });
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = err.slice(-STDERR_KEEP);
      const json = parseResultJson(stdout);
      let outcome = reason;
      if (!outcome) outcome = code === 0 && !(json && json.is_error === true) ? 'ok' : 'failed';
      finish({ outcome, code, signal: signal || null, json, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Result: read the last compact_boundary in the session transcript
// ---------------------------------------------------------------------------

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/**
 * Find the last system/compact_boundary starting at fromOffset (from the start if the file got shorter). Reads at most the last 8MB.
 * @returns {{ preTokens: number|null, postTokens: number|null, trigger: string|null, ms: number|null }|null}
 */
function readCompactBoundary(file, fromOffset = 0) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    let start = fromOffset > size ? 0 : Math.max(0, fromOffset);
    start = Math.max(start, size - BOUNDARY_SCAN_MAX);
    const len = size - start;
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('compact_boundary')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || e.type !== 'system' || e.subtype !== 'compact_boundary') continue;
      const md = e.compactMetadata && typeof e.compactMetadata === 'object' ? e.compactMetadata : {};
      const n = (v) => (fin(Number(v)) && v !== null && v !== '' ? Number(v) : null);
      return { preTokens: n(md.preTokens), postTokens: n(md.postTokens), trigger: md.trigger || null, ms: Date.parse(e.timestamp) || null };
    }
    return null;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Session transcript file: Session.main.file (the file name must be <sessionId>.jsonl); otherwise search under <claudeHome>/projects/*\/.
 */
function transcriptFile(session, claudeHome, sessionId = session.id) {
  if (!S.isUuid(sessionId)) return null;
  const name = sessionId + '.jsonl';
  const f = session.main && session.main.file;
  if (typeof f === 'string' && path.isAbsolute(f)) {
    if (path.basename(f) === name) return f;
    const sib = path.join(path.dirname(f), name);
    if (fs.existsSync(sib)) return sib;
  }
  if (!claudeHome) return null;
  const projects = path.join(claudeHome, 'projects');
  const dirs = [];
  if (session.projectDir && /^[^/\\]+$/.test(session.projectDir)) dirs.push(session.projectDir);
  try {
    for (const d of fs.readdirSync(projects)) if (!dirs.includes(d)) dirs.push(d);
  } catch { /* directory does not exist */ }
  for (const d of dirs) {
    const p = path.join(projects, d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reminder decisions
// ---------------------------------------------------------------------------

/**
 * Estimates for compacting now (cache still warm) versus after expiry. Returns null if either has no price.
 * @returns {{ warm: number, cold: number }|null}
 */
function warmCold(session, now) {
  const warm = estimateFor(session, session.model, now);
  const cold = estimateFor(session, session.model, now, { expired: true });
  if (warm.usd == null || cold.usd == null || warm.pricing !== 'hit') return null;
  return { warm: warm.usd, cold: cold.usd };
}

/**
 * Whether the "cache about to expire" reminder should show (by default only for a 1-hour TTL).
 * @param {any} s Session
 * @param {number} now
 * @param {{ enabled?: boolean, minutes?: number, minContext?: number, shortTtl?: boolean,
 *   reminded?: Set<string>, muted?: (sessionId: string) => boolean }} o
 * @returns {{ key: string, minutes: number, warm: number, cold: number, tokens: number }|null}
 */
function cacheReminderDue(s, now, o = {}) {
  if (o.enabled === false || !s || s.provider !== 'claude' || !s.live) return null;
  if (s.liveStatus === S.LIVE_STATUS.BUSY || s.liveStatus === S.LIVE_STATUS.WAITING) return null;
  if (ttlOf(s) !== '1h' && !o.shortTtl) return null;
  const tokens = contextUsedOf(s);
  if (tokens < (o.minContext ?? DEFAULTS.cacheReminderMinContext)) return null;
  const exp = s.cacheExpiresMs;
  if (!fin(exp) || exp <= now) return null;
  const left = exp - now;
  if (left > (o.minutes ?? DEFAULTS.cacheReminderMinutes) * 60e3) return null;
  const key = `${s.id}:${exp}`;
  if ((o.reminded && o.reminded.has(key)) || (o.muted && o.muted(s.id))) return null;
  const wc = warmCold(s, now);
  if (!wc || wc.cold - wc.warm < REMIND_MIN_GAIN_USD) return null;
  return { key, minutes: Math.max(1, Math.ceil(left / 60e3)), warm: wc.warm, cold: wc.cold, tokens };
}

/**
 * Whether the "window closed" reminder should show: the session just left the registry (decided by the caller), the cache is still warm, and compacting now saves ≥ $0.50.
 * @returns {{ minutes: number, warm: number, cold: number, tokens: number, reopen: boolean }|null}
 */
function closeReminderDue(s, now, o = {}) {
  if (o.enabled === false || !s || s.provider !== 'claude' || s.live) return null;
  const tokens = contextUsedOf(s);
  if (tokens < (o.minContext ?? DEFAULTS.cacheReminderMinContext)) return null;
  const exp = s.cacheExpiresMs;
  if (!fin(exp) || exp <= now) return null;
  if (o.muted && o.muted(s.id)) return null;
  const wc = warmCold(s, now);
  if (!wc || wc.cold - wc.warm < REMIND_MIN_GAIN_USD) return null;
  return {
    minutes: Math.max(1, Math.ceil((exp - now) / 60e3)),
    warm: wc.warm,
    cold: wc.cold,
    tokens,
    reopen: s.entrypoint === CLAUDE_VSCODE_ENTRY && S.isUuid(s.id),
  };
}

/** Compaction count marker: compactCount if present, otherwise the time of the main agent's most recent compaction */
function compactMarker(s) {
  if (fin(s.compactCount)) return s.compactCount;
  const lc = s.main && s.main.lastCompact;
  return lc && fin(lc.ms) ? lc.ms : null;
}

// ---------------------------------------------------------------------------
// VS Code wiring
// ---------------------------------------------------------------------------

/**
 * Register the command agentMonitor.compact and return a Disposable (with three extra methods: onSnapshot, compact, runHandoff).
 * @param {any} context ExtensionContext (uses globalState / workspaceState)
 * @param {{ getSession: (key: string) => any, i18n: any, claudeHome: string|(() => string), output?: any,
 *   listSessions?: () => any[], inWorkspace?: (s: any) => boolean, getSelectedKey?: () => string|null,
 *   spawn?: typeof cp.spawn, timeoutMs?: number, env?: Record<string, string|undefined>, platform?: string }} deps
 *   spawn / timeoutMs / env / platform are only for test overrides.
 */
function activateCompact(context, deps) {
  const vscode = require('vscode');
  const ctx = context || {};
  const I = () => (typeof deps.i18n === 'function' ? deps.i18n() : deps.i18n);
  const claudeHome = () => (typeof deps.claudeHome === 'function' ? deps.claudeHome() : deps.claudeHome)
    || path.join(os.homedir(), '.claude');
  const log = (line) => { try { if (deps.output) deps.output.appendLine(`[compact] ${line}`); } catch { /* ignore */ } };
  const cfg = (key, dflt) => {
    try {
      const v = vscode.workspace.getConfiguration('agentMonitor').get(key);
      return v === undefined || v === null ? dflt : v;
    } catch {
      return dflt;
    }
  };
  const running = new Map(); // sessionId → child
  const sepKind = vscode.QuickPickItemKind ? vscode.QuickPickItemKind.Separator : SEPARATOR_KIND;
  const memMute = new Map();
  let disposed = false;

  // ---------- Helpers ----------

  const info = (msg, ...items) => vscode.window.showInformationMessage(msg, ...items);
  const errorMsg = (msg, ...items) => vscode.window.showErrorMessage(msg, ...items);
  const titleOf = (s) => clip((s && (s.title || s.id)) || '', 60);

  function registry() {
    try {
      return claudeLive.readRegistry(claudeHome());
    } catch {
      return { ok: false, live: new Map(), minVersion: null };
    }
  }

  function isMuted(sessionId) {
    if (memMute.has(sessionId)) return true;
    try {
      const m = ctx.workspaceState && ctx.workspaceState.get(MUTE_KEY);
      return !!(m && typeof m === 'object' && m[sessionId]);
    } catch {
      return false;
    }
  }

  async function mute(sessionId) {
    memMute.set(sessionId, Date.now());
    try {
      if (!ctx.workspaceState) return;
      const m = { ...(ctx.workspaceState.get(MUTE_KEY) || {}) };
      m[sessionId] = Date.now();
      await ctx.workspaceState.update(MUTE_KEY, m);
    } catch { /* keep it in memory only */ }
  }

  function template() {
    return resolveTemplate(cfg('compactTemplate', DEFAULTS.compactTemplate), I());
  }

  /**
   * Pick a session (when there is no argument, e.g. from the Command Palette). Compaction lists only compactable sessions; handoff lists all Claude / Codex sessions.
   * When deps.getSelectedKey is given, the currently selected session goes first (highlighted by default) and the rest keep their order.
   * @param {{ minContext?: number, placeholder?: string, emptyKey?: string }} [o]
   */
  async function pickSessionKey(o = {}) {
    const i18n = I();
    const minContext = o.minContext ?? COMPACTABLE_MIN;
    const list = (deps.listSessions ? deps.listSessions() || [] : [])
      .filter((s) => s && (s.provider === 'claude' || s.provider === 'codex') && contextUsedOf(s) >= minContext);
    if (!list.length) {
      info(i18n.t(o.emptyKey || 'compact.noSessions'));
      return null;
    }
    let selected = null;
    try { selected = deps.getSelectedKey ? deps.getSelectedKey() : null; } catch { selected = null; }
    const at = selected ? list.findIndex((s) => s.key === selected) : -1;
    if (at > 0) list.unshift(...list.splice(at, 1));
    const items = list.map((s) => ({
      label: titleOf(s),
      description: `${i18n.t('provider.' + s.provider)} · ${i18n.fmtTokens(contextUsedOf(s))}`,
      key: s.key,
    }));
    const it = await vscode.window.showQuickPick(items, { placeHolder: i18n.t(o.placeholder || 'compact.pickSession') });
    return it ? it.key : null;
  }

  /** QuickPick: info items just show their explanation without closing; active is set to the recommended item */
  function pick(built) {
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick();
      qp.title = built.title;
      qp.placeholder = built.placeholder;
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;
      qp.items = built.items;
      if (built.active) qp.activeItems = [built.active];
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
        qp.dispose();
      };
      qp.onDidAccept(() => {
        const it = (qp.selectedItems && qp.selectedItems[0]) || (qp.activeItems && qp.activeItems[0]);
        if (!it || !it.action) return;
        if (it.action.type === 'info') {
          info(it.action.text);
          return;
        }
        finish(it);
      });
      qp.onDidHide(() => finish(undefined));
      qp.show();
    });
  }

  /** Send text into a session (prefill + clipboard fallback, see deliverText) and return the message text */
  function deliver(session, text, liveNow) {
    return deliverText(vscode, session, text, { i18n: I(), liveNow, log });
  }

  async function compactInSession(session, instructions, liveNow) {
    const msg = await deliver(session, compactPrompt(instructions), liveNow);
    info(msg);
  }

  // Write a handoff note → review it → /clear → send the continuation prompt
  async function handoff(session, liveNow) {
    const i18n = I();
    const msg = await deliver(session, i18n.t('compact.handoff.prompt'), liveNow);
    const next = i18n.t(session.provider === 'codex' ? 'compact.handoff.next.codex' : 'compact.handoff.next');
    const copy = i18n.t('compact.handoff.copyContinue');
    const b = await info(`${msg} ${next}`, copy);
    if (b === copy) {
      try { await vscode.env.clipboard.writeText(i18n.t('compact.handoff.continue')); } catch { /* ignore */ }
    }
  }

  async function askInstructions(title) {
    const i18n = I();
    const v = await vscode.window.showInputBox({
      title,
      prompt: i18n.t('compact.input.prompt'),
      placeHolder: i18n.t('compact.input.placeholder'),
      value: template(),
      ignoreFocusOut: true,
      validateInput: (s) => (String(s || '').length > TEXT_MAX ? i18n.t('compact.input.tooLong', { n: TEXT_MAX }) : null),
    });
    return v === undefined ? undefined : normalizeInstructions(v);
  }

  // ---------- Background compaction ----------

  async function background(key, model) {
    const i18n = I();
    let session = deps.getSession(key);
    if (!session) { errorMsg(i18n.t('compact.error.noSession')); return; }
    const title = titleOf(session);
    const early = validateBackground({ sessionId: session.id, model, allowed: allowedModels(session), cwd: session.cwd });
    if (early) { errorMsg(i18n.t(early)); return; }
    if (running.has(session.id)) { info(i18n.t('compact.already', { title })); return; }

    const instructions = await askInstructions(i18n.t('compact.input.title', { model }));
    if (instructions === undefined) return;

    // Confirmation dialog (compactConfirm is on by default; always confirm when the registry cannot verify the session is not open)
    const reg = registry();
    const verified = reg.ok && !(session.version && reg.minVersion && claudeLive.cmpVersion(session.version, reg.minVersion) < 0);
    const est = estimateFor(session, model.replace(/\[1m\]$/i, ''), Date.now());
    if (cfg('compactConfirm', DEFAULTS.compactConfirm) !== false || !verified) {
      const go = i18n.t('compact.confirm.go');
      const detail = [
        i18n.t('compact.confirm.detail', { title, model, usd: est.usd == null ? i18n.t('compact.confirm.unpriced') : i18n.fmtUsd(est.usd) }),
        verified ? '' : i18n.t('compact.confirm.unverified'),
        i18n.t('compact.confirm.newTask'),
      ].filter(Boolean).join('\n\n');
      const b = await info(i18n.t('compact.confirm.message'), { modal: true, detail }, go);
      if (b !== go) return;
    }

    // Check again before running: the session may have just been opened, and the snapshot may have changed
    session = deps.getSession(key) || session;
    let liveMap;
    try { liveMap = claudeLive.readLiveSessions(claudeHome()); } catch { liveMap = new Map(); }
    if (liveMap.has(session.id)) {
      log(`${key}: session is open now, background compaction aborted`);
      const act = i18n.t('compact.nowOpen.action');
      const b = await info(i18n.t('compact.nowOpen', { title }), act);
      if (b === act) {
        const fresh = { ...session, entrypoint: liveMap.get(session.id).entrypoint || session.entrypoint };
        await compactInSession(fresh, instructions, true);
      }
      return;
    }
    const bad = validateBackground({ sessionId: session.id, model, allowed: allowedModels(session), cwd: session.cwd });
    if (bad) { errorMsg(i18n.t(bad)); return; }
    if (running.has(session.id)) { info(i18n.t('compact.already', { title })); return; }

    const found = findCli({
      cliPath: cfg('claude.cliPath', ''),
      env: deps.env || process.env,
      platform: deps.platform || process.platform,
      extensionPath: extensionPath(),
    });
    if (found.error) {
      const open = i18n.t('compact.openSettings');
      const b = await errorMsg(found.error === 'cliPath'
        ? i18n.t('compact.error.cliPath', { path: found.path })
        : i18n.t('compact.error.noCli'), open);
      if (b === open) vscode.commands.executeCommand('workbench.action.openSettings', 'agentMonitor.claude.cliPath');
      return;
    }
    if (needsShell(found.path)) { errorMsg(i18n.t('compact.error.cmdShim', { path: found.path })); return; }

    const file = transcriptFile(session, claudeHome());
    const sizeBefore = file ? fileSize(file) : 0;
    const args = buildSpawnArgs(session.id, model, compactPrompt(instructions));
    log(`${key}: start model=${model} cli=${found.source}`);
    running.set(session.id, null);
    let r;
    try {
      r = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: i18n.t('compact.progress', { title }),
        cancellable: true,
      }, (progress, token) => {
        progress.report({ message: i18n.t('compact.progress.detail', { model }) });
        return runCompact({
          cli: found.path,
          args,
          cwd: session.cwd,
          timeoutMs: deps.timeoutMs || TIMEOUT_MS,
          token,
          spawn: deps.spawn,
          env: deps.env,
          onChild: (child) => running.set(session.id, child),
        });
      });
    } finally {
      running.delete(session.id);
    }
    const lines = tailLines(r.stderr);
    log(`${key}: ${r.outcome} code=${r.code} signal=${r.signal || '-'} ${(r.durationMs / 1000).toFixed(1)}s`);
    for (const l of lines) log(`  stderr: ${l}`);
    if (disposed) return;
    if (r.outcome === 'cancelled') { info(i18n.t('compact.cancelled', { title })); return; }
    if (r.outcome === 'timeout') {
      errorMsg(i18n.t('compact.timeout', { title, min: Math.round((deps.timeoutMs || TIMEOUT_MS) / 60e3) }));
      return;
    }
    if (r.outcome === 'spawnError') { errorMsg(i18n.t('compact.error.spawn', { message: r.error || '' })); return; }
    if (r.outcome === 'failed') {
      const detail = [
        r.code != null ? i18n.t('compact.failed.exit', { code: r.code }) : '',
        r.json && r.json.is_error && r.json.result ? clip(String(r.json.result).split('\n')[0], 200) : '',
        ...(lines.length ? lines : [i18n.t('compact.failed.noStderr')]),
      ].filter(Boolean).join('\n');
      errorMsg(i18n.t('compact.failed', { title }), { modal: true, detail });
      return;
    }
    // Success: pre → post come from the last compact_boundary in the transcript; cost comes from the CLI's own total_cost_usd
    const usd = r.json && fin(r.json.total_cost_usd) ? i18n.fmtUsd(r.json.total_cost_usd) : '—';
    const sid = r.json && S.isUuid(r.json.session_id) ? r.json.session_id : session.id;
    let boundary = null;
    if (sid === session.id) {
      if (file) boundary = readCompactBoundary(file, sizeBefore);
    } else {
      const other = transcriptFile(session, claudeHome(), sid);
      if (other) boundary = readCompactBoundary(other, 0);
    }
    if (boundary && boundary.preTokens != null && boundary.postTokens != null) {
      info(i18n.t('compact.done', {
        title, pre: i18n.fmtTokens(boundary.preTokens), post: i18n.fmtTokens(boundary.postTokens), usd, model,
      }));
    } else {
      info(i18n.t('compact.done.noRecord', { title, usd, model }));
    }
  }

  function extensionPath() {
    try {
      const ext = vscode.extensions && vscode.extensions.getExtension(CLAUDE_EXT_ID);
      return (ext && ext.extensionPath) || null;
    } catch {
      return null;
    }
  }

  // ---------- Commands ----------

  /**
   * Whether a session is open is decided by the registry (the snapshot may be 2 seconds old); fall back to the snapshot when the registry is unavailable. Codex uses the snapshot directly.
   * @returns {{ view: any, liveNow: boolean, liveStatus: string|null }}
   */
  function resolveLive(session) {
    let liveNow = !!session.live;
    let liveStatus = session.liveStatus || null;
    let view = session;
    if (session.provider === 'claude') {
      const reg = registry();
      const entry = reg.live.get(session.id);
      if (entry) {
        liveNow = true;
        liveStatus = entry.status || liveStatus;
        view = { ...session, entrypoint: entry.entrypoint || session.entrypoint };
      } else if (reg.ok) {
        liveNow = false;
      }
    }
    return { view, liveNow, liveStatus };
  }

  async function compact(arg) {
    const i18n = I();
    let key = keyFromArg(arg);
    if (!key) key = await pickSessionKey();
    if (!key) return;
    const parsed = S.parseSessionKey(key);
    const session = deps.getSession(key);
    if (!parsed || !session || (session.provider !== 'claude' && session.provider !== 'codex')) {
      errorMsg(i18n.t('compact.error.noSession'));
      return;
    }
    if (session.provider === 'claude' && !S.isUuid(session.id)) { errorMsg(i18n.t('compact.error.badId')); return; }
    const { view, liveNow, liveStatus } = resolveLive(session);
    const built = buildPickItems(view, { i18n, now: Date.now(), live: liveNow, liveStatus, separatorKind: sepKind });
    const it = await pick(built);
    if (!it) return;
    const a = it.action;
    if (a.type === 'inSession') return compactInSession(view, template(), true);
    if (a.type === 'custom') {
      const text = await askInstructions(i18n.t('compact.input.titleInSession'));
      if (text === undefined) return;
      return compactInSession(view, text, true);
    }
    if (a.type === 'codexOpen') return compactInSession(view, '', liveNow);
    if (a.type === 'handoff') return handoff(view, liveNow);   // same function as the agentMonitor.handoff command (handoffCommand)
    if (a.type === 'background') return background(key, a.model);
  }

  /**
   * "Write a handoff note, then start a new session", for extension.js to register as agentMonitor.handoff.
   * Argument: a session tree node or sessionKey; with no argument, pick a session first (defaulting to the currently selected one).
   */
  async function handoffCommand(arg) {
    const i18n = I();
    let key = keyFromArg(arg);
    if (!key) key = await pickSessionKey({ minContext: 0, placeholder: 'compact.handoff.pickSession', emptyKey: 'compact.handoff.noSessions' });
    if (!key) return;
    const session = deps.getSession(key);
    if (!session || (session.provider !== 'claude' && session.provider !== 'codex')) {
      errorMsg(i18n.t('compact.error.noSession'));
      return;
    }
    const { view, liveNow } = resolveLive(session);
    return handoff(view, liveNow);
  }

  // ---------- Reminders ----------

  let prevLive = null;              // keys of Claude sessions live in the previous snapshot
  const closing = new Map();        // key of a session that went from live to not live → number of consecutive snapshots not live
  const reminded = new Set();       // cache windows already reminded about: sessionId:cacheExpiresMs
  const compactSeen = new Map();    // session key → compaction count marker

  function inWs(s) {
    try {
      if (deps.inWorkspace) return !!deps.inWorkspace(s);
      return scopeLib.inWorkspace(s, scopeLib.workspaceInfo(vscode.workspace.workspaceFolders));
    } catch {
      return false;
    }
  }

  async function remindCache(s, due) {
    const i18n = I();
    const bCompact = i18n.t('compact.remind.cache.compact');
    const bHandoff = i18n.t('compact.remind.handoff');
    const bMute = i18n.t('compact.remind.mute');
    const b = await info(i18n.t('compact.remind.cache', {
      title: titleOf(s), m: due.minutes, tokens: i18n.fmtTokens(due.tokens), warm: i18n.fmtUsd(due.warm), cold: i18n.fmtUsd(due.cold),
    }), bCompact, bHandoff, bMute);
    if (b === bCompact) {
      if (s.live) await compactInSession(s, template(), true);
      else await vscode.commands.executeCommand(CMD, s.key);
    } else if (b === bHandoff) {
      await handoff(s, !!s.live);
    } else if (b === bMute) {
      await mute(s.id);
    }
  }

  async function remindClose(s, due) {
    const i18n = I();
    const msg = i18n.t('compact.remind.close', {
      title: titleOf(s), tokens: i18n.fmtTokens(due.tokens), m: due.minutes, warm: i18n.fmtUsd(due.warm),
    });
    const bMute = i18n.t('compact.remind.mute');
    if (!due.reopen) {
      // other entrypoints (terminal, desktop app) only get a message, without a "Reopen" button
      if ((await info(msg, bMute)) === bMute) await mute(s.id);
      return;
    }
    const bCompact = i18n.t('compact.remind.close.compact');
    const bHandoff = i18n.t('compact.remind.close.handoff');
    const b = await info(msg, bCompact, bHandoff, bMute);
    if (b === bCompact) await compactInSession(s, template(), false);
    else if (b === bHandoff) await handoff(s, false);
    else if (b === bMute) await mute(s.id);
  }

  async function hintPostCompact(s) {
    const i18n = I();
    const off = i18n.t('compact.postCompact.off');
    const key = s.provider === 'codex' ? 'compact.postCompact.codex' : 'compact.postCompact';
    const b = await info(i18n.t(key, { title: titleOf(s) }), off);
    if (b === off) {
      try { if (ctx.globalState) await ctx.globalState.update(HINT_OFF_KEY, true); } catch { /* ignore */ }
    }
  }

  /**
   * Called once per snapshot (extension.js calls it after receiving a snapshot from the worker).
   * replay: true marks a snapshot a follower window re-runs with its own clock while the shared scan's leader has nothing
   * new; it moves the time-based reminders on but never counts towards confirming a closed window.
   * @param {{ now?: number, sessions?: any[], sources?: any, replay?: boolean }|any[]} snap
   */
  function onSnapshot(snap) {
    if (disposed) return;
    const sessions = Array.isArray(snap) ? snap : (snap && snap.sessions) || [];
    const now = (!Array.isArray(snap) && snap && fin(snap.now)) ? snap.now : Date.now();
    const catchErr = (p) => Promise.resolve(p).catch((err) => log(`reminder: ${err && err.message}`));

    // Post-compaction hint: check constraints
    const hintOn = cfg('postCompactHint', DEFAULTS.postCompactHint) !== false
      && !(ctx.globalState && ctx.globalState.get(HINT_OFF_KEY));
    for (const s of sessions) {
      if (!s || !s.key) continue;
      const marker = compactMarker(s);
      const had = compactSeen.has(s.key);
      const prev = compactSeen.get(s.key);
      compactSeen.set(s.key, marker);
      if (!had || marker == null || (prev != null && marker <= prev)) continue;
      if (hintOn && inWs(s)) catchErr(hintPostCompact(s));
    }

    // Window-closed reminder: a session counts as closed only after going from "live" to "not in the registry" for 2 consecutive snapshots (guards against failed reads while the registry file is rewritten).
    // If several are confirmed closed in the same snapshot, the whole window is most likely quitting, so no reminder.
    // Do not check whether the registry is "available": after the last session closes the registry may be empty, and that is exactly when to remind.
    const curLive = new Set();
    const byKey = new Map();
    for (const s of sessions) {
      if (!s || s.provider !== 'claude') continue;
      byKey.set(s.key, s);
      if (s.live) curLive.add(s.key);
    }
    const replay = !Array.isArray(snap) && !!snap && snap.replay === true; // same data as the last one: not a second look
    if (prevLive && !replay) {
      for (const k of prevLive) if (!curLive.has(k) && byKey.has(k)) closing.set(k, 0);
    }
    const closed = [];
    for (const [k, n] of (replay ? [] : closing)) {
      const s = byKey.get(k);
      if (!s || s.live) { closing.delete(k); continue; }
      if (n + 1 >= CLOSE_CONFIRM_SNAPSHOTS) { closed.push(s); closing.delete(k); } else closing.set(k, n + 1);
    }
    if (closed.length === 1 && cfg('closeReminder', DEFAULTS.closeReminder) !== false && inWs(closed[0])) {
      const due = closeReminderDue(closed[0], now, {
        minContext: Number(cfg('cacheReminderMinContext', DEFAULTS.cacheReminderMinContext)),
        muted: isMuted,
      });
      if (due) catchErr(remindClose(closed[0], due));
    }
    if (!replay) prevLive = curLive;

    // Cache-about-to-expire reminder
    if (cfg('cacheReminder', DEFAULTS.cacheReminder) !== false) {
      const o = {
        minutes: Number(cfg('cacheReminderMinutes', DEFAULTS.cacheReminderMinutes)),
        minContext: Number(cfg('cacheReminderMinContext', DEFAULTS.cacheReminderMinContext)),
        shortTtl: cfg('cacheReminderShortTtl', DEFAULTS.cacheReminderShortTtl) === true,
        reminded,
        muted: isMuted,
      };
      for (const s of byKey.values()) {
        const due = cacheReminderDue(s, now, o);
        if (!due || !inWs(s)) continue;
        reminded.add(due.key);
        catchErr(remindCache(s, due));
      }
    }
  }

  const reg = vscode.commands.registerCommand(CMD, (arg) => compact(arg).catch((err) => {
    log(`error: ${err && err.message}`);
    errorMsg(I().t('compact.error.unexpected', { message: String((err && err.message) || err) }));
  }));

  const api = {
    onSnapshot,
    compact,
    /** Implementation of agentMonitor.handoff (called by extension.js when registering the command); errors are shown to the user, not thrown */
    runHandoff: (arg) => handoffCommand(arg).catch((err) => {
      log(`handoff error: ${err && err.message}`);
      errorMsg(I().t('compact.handoff.error', { message: String((err && err.message) || err) }));
    }),
    dispose() {
      disposed = true;
      if (activeApi === api) activeApi = null;
      try { reg.dispose(); } catch { /* ignore */ }
      for (const child of running.values()) {
        try { if (child) child.kill('SIGTERM'); } catch { /* already exited */ }
      }
      running.clear();
    },
  };
  activeApi = api;
  return api;
}

// Instance from the most recent activateCompact: the module-level runHandoff forwards to it
let activeApi = null;

/**
 * Module-level entry point: extension.js can register agentMonitor.handoff directly with require('./lib/compact').runHandoff(arg).
 * Argument: a session tree node or sessionKey; with no argument, pick a session first. Calls made before activateCompact are rejected.
 * @param {any} [arg]
 * @returns {Promise<void>}
 */
function runHandoff(arg) {
  if (!activeApi) return Promise.reject(new Error('compact module is not active'));
  return activeApi.runHandoff(arg);
}

module.exports = {
  CMD, CLAUDE_OPEN_CMD, CLAUDE_EXT_ID, TIMEOUT_MS, TAIL_LINES, MODEL_ID_RE, MUTE_KEY, HINT_OFF_KEY, DEFAULTS,
  activateCompact, runHandoff, deliverText,
  // Pure functions (for tests and reuse)
  keyFromArg, contextUsedOf, ttlOf, applyTtl, estimateFor, candidatesFor, pickRecommended, cliModelFor, allowedModels,
  resolveTemplate, normalizeInstructions, compactPrompt, tailLines,
  buildPickItems, buildSpawnArgs, validateBackground, homeFor, findCli, needsShell, parseResultJson, runCompact,
  readCompactBoundary, transcriptFile,
  cacheReminderDue, closeReminderDue, compactMarker,
};
