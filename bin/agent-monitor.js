#!/usr/bin/env node
'use strict';
// Terminal version: reads both Claude Code and Codex local session transcripts.
// - All text goes through lib/i18n + lib/format (--lang or LC_ALL / LC_MESSAGES / LANG); this file contains no UI text;
// - Lamps use xterm 256 colors (lib/lamp.xtermDot);
// - Session and agent order is locked by lib/order.js: under --watch nothing jumps when activity, lamps or tokens change;
// - Reads local files only, no network; nothing is persisted, so everything starts "unseen" (--seen-all marks all as seen).
// See --help for usage. Does not run when required; only exports pure functions (for tests).

const os = require('os');
const path = require('path');
const { Monitor } = require('../lib/monitor');
const { createI18n, resolveCliLocale } = require('../lib/i18n');
const F = require('../lib/format');
const lampLib = require('../lib/lamp');
const { createSessionOrder, createAgentOrder } = require('../lib/order');
const { ALL_SEEN } = require('../lib/seen');
const { workspaceInfo, filterByScope } = require('../lib/scope');
const S = require('../lib/core/status');

const BRAND = 'CYUNEO Agent Monitor'; // product name, not translated
const SEP = F.SEP;
const DEFAULTS = Object.freeze({ window: 30, stale: 5, interval: 2 });
const PROVIDERS = ['all', 'claude', 'codex'];
const ONE_SHOT_BUDGET = 1e15; // a one-shot run with --today reads all of today's transcripts at once
const RESULT_LINES = 12;      // max result lines shown in detail mode
const TIMELINE_MAX = 12;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

// Option table: name -> { flag, takes: value type }; --help lists them in this order
const OPTIONS = [
  { name: 'watch', flags: ['--watch', '-w'] },
  { name: 'interval', flags: ['--interval'], value: 'SEC', type: 'number' },
  { name: 'window', flags: ['--window'], value: 'MIN', type: 'number' },
  { name: 'stale', flags: ['--stale'], value: 'MIN', type: 'number' },
  { name: 'provider', flags: ['--provider'], value: 'all|claude|codex', type: 'string' },
  { name: 'here', flags: ['--here'] },
  { name: 'session', flags: ['--session', '-s'], value: 'ID', type: 'string' },
  { name: 'today', flags: ['--today'] },
  { name: 'noToday', flags: ['--no-today'] },
  { name: 'seenAll', flags: ['--seen-all'] },
  { name: 'json', flags: ['--json'] },
  { name: 'lang', flags: ['--lang'], value: 'en|zh-cn|zh-tw|ko|ja', type: 'string' },
  { name: 'claudeDir', flags: ['--claude-dir'], value: 'DIR', type: 'string' },
  { name: 'codexHome', flags: ['--codex-home'], value: 'DIR', type: 'string' },
  { name: 'noColor', flags: ['--no-color'] },
  { name: 'color', flags: ['--color'] },
  { name: 'help', flags: ['--help', '-h'] },
  { name: 'version', flags: ['--version'] },
];
const BY_FLAG = new Map();
for (const o of OPTIONS) for (const f of o.flags) BY_FLAG.set(f, o);

/**
 * Parse the command line. Errors are not thrown but collected in errors ({ key, vars }, printed by the caller in the chosen language).
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ opts: Record<string, any>, errors: { key: string, vars: Record<string, any> }[] }}
 */
function parseArgs(argv) {
  const opts = { window: DEFAULTS.window, stale: DEFAULTS.stale, interval: DEFAULTS.interval, provider: 'all' };
  const errors = [];
  const args = argv || [];
  for (let i = 0; i < args.length; i++) {
    const raw = String(args[i]);
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const o = BY_FLAG.get(flag);
    if (!o) { errors.push({ key: 'cli.error.unknownOption', vars: { opt: raw } }); continue; }
    if (!o.type) {
      if (eq > 0) { errors.push({ key: 'cli.error.noValue', vars: { flag } }); continue; }
      opts[o.name] = true;
      continue;
    }
    let v;
    if (eq > 0) v = raw.slice(eq + 1);
    else if (i + 1 < args.length) v = String(args[++i]);
    else { errors.push({ key: 'cli.error.needsValue', vars: { flag } }); continue; }
    if (o.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) { errors.push({ key: 'cli.error.badNumber', vars: { flag, value: v } }); continue; }
      opts[o.name] = n;
    } else {
      opts[o.name] = v;
    }
  }
  if (opts.provider != null) {
    const p = String(opts.provider).toLowerCase();
    if (!PROVIDERS.includes(p)) errors.push({ key: 'cli.error.badProvider', vars: { value: opts.provider } });
    else opts.provider = p;
  }
  if (opts.interval < 0.5) opts.interval = 0.5;
  return { opts, errors };
}

/** Expand a leading ~ and make the path absolute */
function expandPath(p) {
  if (!p) return undefined;
  const s = String(p);
  const home = os.homedir();
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2));
  return path.resolve(s);
}

/** Monitor config from the options (a subset of WorkerConfig; normalizeConfig fills in the rest) */
function monitorConfig(opts) {
  const daily = opts.watch ? !opts.noToday : !!opts.today;
  const cfg = {
    intervalMs: Math.round(opts.interval * 1000),
    activeWindowMinutes: opts.window,
    staleMinutes: opts.stale,
    claude: { enabled: opts.provider !== 'codex' },
    codex: { enabled: opts.provider !== 'claude' },
    daily,
  };
  const cd = expandPath(opts.claudeDir);
  if (cd) cfg.claude.projectsDir = cd;
  const ch = expandPath(opts.codexHome);
  if (ch) cfg.codex.home = ch;
  if (daily && !opts.watch) cfg.dailyBudgetBytesPerTick = ONE_SHOT_BUDGET;
  return cfg;
}

// ---------------------------------------------------------------------------
// Terminal helpers: color, display width, truncation
// ---------------------------------------------------------------------------

/**
 * Whether to use color: off with --no-color / NO_COLOR; on with --color / FORCE_COLOR; otherwise only if stdout is a TTY.
 * @param {Record<string, any>} opts
 * @param {Record<string, string|undefined>} env
 * @param {{ isTTY?: boolean }} stream
 */
function useColor(opts, env, stream) {
  if (opts.noColor) return false;
  if (opts.color) return true;
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR != null && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return !!(stream && stream.isTTY);
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function paint(on, code, s) { return on && s ? `\x1b[${code}m${s}\x1b[0m` : s; }
const dim = (on, s) => paint(on, '2', s);
const bold = (on, s) => paint(on, '1', s);
const fg = (on, n, s) => paint(on, `38;5;${n}`, s);

// East Asian wide chars take 2 columns; combining marks and zero-width chars take 0
function charWidth(cp) {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

/** Display width in the terminal (ignoring ANSI escapes) */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s).replace(ANSI_RE, '')) w += charWidth(ch.codePointAt(0));
  return w;
}

/** Truncate to width columns (keeping ANSI escapes); on overflow end with … and reset color */
function truncate(s, width) {
  const str = String(s);
  if (!(width > 0) || displayWidth(str) <= width) return str;
  let out = '';
  let w = 0;
  let colored = false;
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      ANSI_RE.lastIndex = i;
      const m = ANSI_RE.exec(str);
      if (m && m.index === i) {
        out += m[0];
        colored = m[0] !== '\x1b[0m';
        i += m[0].length;
        continue;
      }
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + (colored ? '\x1b[0m' : '') + '…';
}

/** Pad with spaces to width columns by display width */
function padWidth(s, width) {
  const w = displayWidth(s);
  return w >= width ? String(s) : String(s) + ' '.repeat(width - w);
}

/** Indent and flatten to one line (newlines and tabs become spaces) */
function oneLine(s) { return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim(); }

function shortHome(p) {
  if (!p) return '';
  const home = os.homedir();
  const s = String(p);
  return home && (s === home || s.startsWith(home + path.sep)) ? '~' + s.slice(home.length) : s;
}

// ---------------------------------------------------------------------------
// Views: lay out a snapshot as terminal text
// ---------------------------------------------------------------------------

/**
 * Render state for one run: i18n, color, stable sorters (reused for the whole --watch session so order never jumps).
 * @param {{ i18n: any, color: boolean, seenAll?: boolean, here?: string|null, window?: number,
 *   staleAsNeedsYou?: boolean, showToday?: boolean, providers?: string }} o
 */
function createView(o) {
  return {
    i18n: o.i18n,
    color: !!o.color,
    seenAll: !!o.seenAll,
    here: o.here || null,
    window: o.window || DEFAULTS.window,
    showToday: !!o.showToday,
    staleAsNeedsYou: !!o.staleAsNeedsYou,
    sessionOrder: createSessionOrder(),
    agentOrder: createAgentOrder(),
  };
}

/** Scope filter + stable ordering + lamps */
function arrange(view, snap) {
  let sessions = (snap && snap.sessions) || [];
  if (view.here) sessions = filterByScope(sessions, 'workspace', workspaceInfo([view.here]));
  const order = view.sessionOrder.arrange(sessions);
  const lamps = lampLib.computeLamps(order.list, {
    seen: view.seenAll ? ALL_SEEN : 0,
    staleAsNeedsYou: view.staleAsNeedsYou,
  });
  return { order, lamps };
}

const LAMP_TEXT_COLOR = { needsYou: 161, error: 196 };

/** Lamp + text: NeedsYou / Error text is also drawn in the lamp color */
function lampText(view, lamp, text) {
  const n = LAMP_TEXT_COLOR[lamp];
  return n ? fg(view.color, n, text) : text;
}

function dot(view, lamp) { return lampLib.xtermDot(lamp, { color: view.color }); }

/** Top line: brand + session count per lamp (by display urgency) */
function headerLine(view, counts) {
  const { i18n } = view;
  const parts = [];
  for (const l of ['needsYou', 'error', 'doneUnseen', 'working']) {
    if (counts[l] > 0) parts.push(dot(view, l) + ' ' + i18n.t('bar.count', { n: counts[l], label: F.lampLabel(l, i18n, true) }));
  }
  const tail = parts.length ? parts.join('  ') : dot(view, 'idle') + ' ' + i18n.t('bar.idle');
  return bold(view.color, BRAND) + '   ' + tail;
}

/** Session title line + one dimmed line of metadata */
function sessionLines(view, s, L, now) {
  const { i18n } = view;
  const row = F.formatSessionRow(s, i18n, { lamps: L, now, staleAsNeedsYou: view.staleAsNeedsYou });
  const desc = [F.providerLabel(s.provider, i18n), lampText(view, L.lamp, row.statusText)];
  if (row.contextText) desc.push(row.contextText);
  const lines = [dot(view, L.lamp) + ' ' + bold(view.color, oneLine(row.label)) + '   ' + desc.join(SEP)];

  const meta = [F.entryLabel(s.entry, i18n)];
  if (s.cwd) meta.push(shortHome(s.cwd));
  if (s.model) meta.push(String(s.model));
  const ctx = F.formatContext(s.main && s.main.tokens, i18n);
  if (ctx.used > 0) meta.push(i18n.t('ctx.label') + ' ' + ctx.usageText);
  if ((Number.isFinite(s.costUsd) && s.costUsd > 0) || (s.main && s.main.unpricedModel)) {
    meta.push(i18n.t('cost.label') + ' ' + F.formatCost(s.costUsd, i18n, { unpriced: s.main && s.main.unpricedModel }));
  }
  const cache = F.formatCacheLeft(s.cacheExpiresMs, i18n, now);
  if (cache) meta.push(cache);
  lines.push('    ' + dim(view.color, meta.join(SEP)));
  return lines;
}

/** One agent row */
function agentLine(view, s, r, L, now) {
  const { i18n } = view;
  const indent = '  ' + '  '.repeat(r.depth);
  const cell = L.rows.get(r.id) || { lamp: S.LAMP.IDLE, status: null };
  if (r.kind === 'workflow') {
    const w = F.formatWorkflow(r.workflow, i18n);
    const parts = [bold(view.color, i18n.t('workflow.label') + ' ' + oneLine(w.name)), w.stateText, w.progressText];
    if (w.phaseText) parts.push(w.phaseText);
    if (r.workflow && r.workflow.tokens > 0) parts.push(i18n.t('count.tokens', { n: i18n.fmtTokens(r.workflow.tokens) }));
    return indent + dot(view, cell.lamp) + ' ' + parts.filter(Boolean).join(SEP);
  }
  const a = r.agent || {};
  const st = cell.status || a.status || null;
  const isMain = r.kind === 'main';
  const parts = [bold(view.color, oneLine(F.formatAgentName(a, i18n)))];
  if (!isMain) parts.push(dim(view.color, F.formatAgentKind(a, i18n)));
  const status = F.formatStatus(st, a, i18n, now, { isMain, staleAsNeedsYou: view.staleAsNeedsYou });
  const step = F.formatStep(a.step, st, i18n, now, { withDur: true });
  // A "thinking" status with a "thinking" step is written only once (with duration)
  const same = st && st.code === S.STATUS.THINKING && a.step && a.step.kind === S.STEP.THINKING && step;
  parts.push(lampText(view, cell.lamp, same ? oneLine(step) : status));
  if (step && !same) parts.push(oneLine(step));
  const tok = a.tokens && a.tokens.display;
  if (tok > 0) parts.push(i18n.t('count.tokens', { n: i18n.fmtTokens(tok) }));
  if (a.toolErrors > 0) parts.push(fg(view.color, 196, i18n.t('count.toolErrors', { n: a.toolErrors })));
  if (!isMain && a.model && a.model !== s.model) parts.push(dim(view.color, String(a.model)));
  return indent + dot(view, cell.lamp) + ' ' + parts.join(SEP);
}

/** Account-level info: Codex quota, Claude's most recent quota hit, today's totals, errors */
function footerLines(view, snap, now) {
  const { i18n } = view;
  const out = [];
  const q = snap && snap.quota;
  const codexOn = !snap.sources || !snap.sources.codex || snap.sources.codex.enabled !== false;
  if (codexOn && q && q.codex && Array.isArray(q.codex.windows) && q.codex.windows.length) {
    const cq = F.formatCodexQuota(q.codex, i18n, now);
    out.push(bold(view.color, cq.title) + '   ' + cq.lines.join(SEP));
  }
  const hit = q && q.claude && F.formatClaudeLastHit(q.claude.lastHit, i18n, now);
  if (hit) out.push(hit);
  if (view.showToday && snap.today) {
    const td = F.formatToday(snap.today, i18n);
    let s = i18n.t('cli.today', { label: i18n.t('cost.label'), usd: td.text });
    if (td.partialText) s += SEP + td.partialText;
    out.push(s);
  }
  for (const src of ['claude', 'codex']) {
    const e = snap.sources && snap.sources[src];
    if (e && e.enabled !== false && e.error) {
      out.push(fg(view.color, 196, i18n.t('cli.error.source', { source: F.providerLabel(src, i18n), message: oneLine(e.error) })));
    }
  }
  return out;
}

/**
 * List view: "open" and "recent" groups, each session followed by its agents (fixed order).
 * @param {any} view result of createView()
 * @param {any} snap Monitor.snapshot()
 * @param {{ now?: number, extra?: string[] }} [o] extra: extra lines at the bottom (timing, key hints)
 * @returns {string[]}
 */
function renderList(view, snap, o = {}) {
  const { i18n } = view;
  const now = o.now ?? snap.now ?? Date.now();
  const { order, lamps } = arrange(view, snap);
  const lines = [headerLine(view, lamps.counts), ''];
  if (!order.list.length) {
    lines.push(view.here
      ? i18n.t('cli.empty.here', { dir: shortHome(view.here), n: view.window })
      : i18n.t('cli.empty', { n: view.window }));
  }
  for (const g of order.groups) {
    if (order.showGroupHeaders) lines.push(bold(view.color, F.formatGroup(g.id, i18n)));
    for (const s of g.sessions) {
      const L = lamps.bySession.get(s.key);
      lines.push(...sessionLines(view, s, L, now));
      for (const r of view.agentOrder.arrange(s)) lines.push(agentLine(view, s, r, L, now));
      if (s.resume && s.resume.length) {
        const h = F.formatResumeHint(s.resume[0], i18n, { now });
        lines.push('    ' + dim(view.color, '↻ ' + h.label + SEP + i18n.t('cli.seeDetail', { id: shortId(s, snap.sessions) })));
      }
      lines.push('');
    }
  }
  const foot = footerLines(view, snap, now);
  if (foot.length) lines.push(...foot);
  if (o.extra && o.extra.length) lines.push(...o.extra.map((x) => dim(view.color, x)));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * For --session: the shortest id prefix (at least 8 chars) that is unique within this list.
 * @param {any} s
 * @param {any[]} [list]
 */
function shortId(s, list) {
  const id = String(s.id || '');
  const others = (list || []).filter((x) => x !== s).map((x) => String(x.id || ''));
  for (let n = 8; n < id.length; n += 4) {
    const p = id.slice(0, n);
    if (!others.some((o) => o.startsWith(p))) return p;
  }
  return id;
}

/**
 * Find a session by id, key or prefix.
 * @returns {{ session: any|null, matches: number }}
 */
function findSession(sessions, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return { session: null, matches: 0 };
  const list = sessions || [];
  const exact = list.find((s) => String(s.key).toLowerCase() === needle || String(s.id).toLowerCase() === needle);
  if (exact) return { session: exact, matches: 1 };
  const hits = list.filter((s) => String(s.id).toLowerCase().startsWith(needle) || String(s.key).toLowerCase().startsWith(needle));
  return { session: hits.length === 1 ? hits[0] : null, matches: hits.length };
}

/**
 * Detail view (terminal version of the right-hand panel): the session, each agent's timeline / result / changed files /
 * errors, plus a resume hint.
 * @param {any} view
 * @param {any} snap a snapshot taken after setFocus on that session
 * @param {any} session
 * @param {{ now?: number, platform?: string, extra?: string[] }} [o]
 * @returns {string[]}
 */
function renderDetail(view, snap, session, o = {}) {
  const { i18n } = view;
  const now = o.now ?? snap.now ?? Date.now();
  const lamps = lampLib.computeLamps([session], { seen: view.seenAll ? ALL_SEEN : 0, staleAsNeedsYou: view.staleAsNeedsYou });
  const L = lamps.bySession.get(session.key);
  const detail = (snap.details && snap.details[session.key]) || null;
  const lines = [headerLine(view, lamps.counts), ''];
  lines.push(...sessionLines(view, session, L, now));
  lines.push(dim(view.color, '    ' + i18n.t('tip.id') + ' ' + session.id));
  lines.push('');
  const agoWidth = 10;
  for (const r of view.agentOrder.arrange(session)) {
    lines.push(agentLine(view, session, r, L, now));
    const pad = '  ' + '  '.repeat(r.depth) + '    ';
    const sub = (s) => pad + s;
    if (!r.agent) continue;
    const d = detail && detail.agents && detail.agents[r.agent.id];
    if (!d) continue;
    const tl = (d.timeline || []).slice(-TIMELINE_MAX);
    if (tl.length) {
      lines.push(sub(bold(view.color, i18n.t('cli.detail.timeline'))));
      for (const ev of tl) {
        const text = oneLine(F.formatTimelineEvent(ev, i18n));
        if (text) lines.push(sub('  ' + dim(view.color, padWidth(i18n.fmtAgo(ev.ms, now), agoWidth)) + ' ' + text));
      }
    }
    if (d.result && d.result.text) {
      const all = String(d.result.text).replace(/\r/g, '').split('\n');
      const shown = all.slice(0, RESULT_LINES);
      const cut = all.length > RESULT_LINES || d.result.truncated;
      lines.push(sub(bold(view.color, i18n.t('cli.detail.result')) + (cut ? ' ' + dim(view.color, i18n.t('cli.detail.truncated')) : '')));
      for (const x of shown) lines.push(sub('  ' + x.replace(/\t/g, '  ')));
    }
    if (d.files && d.files.length) {
      lines.push(sub(bold(view.color, i18n.t('cli.detail.files'))));
      for (const f of d.files) lines.push(sub('  ' + F.formatFileOp(f, i18n) + '  ' + shortHome(f.path)));
    }
    if (d.errors && d.errors.length) {
      lines.push(sub(bold(view.color, i18n.t('cli.detail.errors'))));
      for (const e of d.errors) {
        const who = e.tool ? F.toolLabel(e.tool, i18n) + ': ' : '';
        lines.push(sub('  ' + dim(view.color, padWidth(i18n.fmtAgo(e.ms, now), agoWidth)) + ' ' + fg(view.color, 196, who + oneLine(e.text))));
      }
    }
  }
  if (!detail) lines.push('', dim(view.color, i18n.t('cli.detail.none')));
  if (session.resume && session.resume.length) {
    lines.push('', bold(view.color, i18n.t('cli.detail.resume')));
    for (const hint of session.resume) {
      const h = F.formatResumeHint(hint, i18n, { now, platform: o.platform });
      lines.push('  ↻ ' + h.label);
      if (h.noteText) lines.push('    ' + h.noteText);
      if (h.estimateText) lines.push('    ' + dim(view.color, h.estimateText));
      if (h.command) lines.push('    ' + i18n.t('cli.detail.command') + '  ' + h.command);
      if (h.variants.includes('prompt')) lines.push('    ' + i18n.t('cli.detail.prompt') + '  ' + h.prompt);
    }
  }
  const foot = footerLines(view, snap, now);
  if (foot.length) lines.push('', ...foot);
  if (o.extra && o.extra.length) lines.push(...o.extra.map((x) => dim(view.color, x)));
  return lines;
}

/**
 * --json output: snapshot + fixed order + lamps. Sessions are in left-hand order; each has lamp, group, and rows in right-hand order.
 * @param {any} view
 * @param {any} snap
 * @param {{ scanMs?: number, locale?: string }} [o]
 */
function buildJson(view, snap, o = {}) {
  const { order, lamps } = arrange(view, snap);
  const groupOf = new Map();
  for (const g of order.groups) for (const s of g.sessions) groupOf.set(s.key, g.id);
  const sessions = order.list.map((s) => {
    const L = lamps.bySession.get(s.key);
    const rows = view.agentOrder.arrange(s).map((r) => {
      const c = L.rows.get(r.id);
      return { id: r.id, kind: r.kind, depth: r.depth, parentId: r.parentId, lamp: c ? c.lamp : S.LAMP.IDLE,
        status: c && c.status ? c.status.code : null };
    });
    return { ...s, lamp: L.lamp, group: groupOf.get(s.key) || null, rows };
  });
  const out = {
    v: snap.v,
    now: snap.now,
    locale: o.locale || view.i18n.locale,
    lamps: { overall: lamps.overall, counts: lamps.counts },
    groups: order.groups.map((g) => ({ id: g.id, keys: g.sessions.map((s) => s.key) })),
    sessions,
    quota: snap.quota,
    details: snap.details || {},
    sources: snap.sources,
  };
  if (view.showToday) out.today = snap.today;
  if (Number.isFinite(o.scanMs)) out.scanMs = o.scanMs;
  return out;
}

// ---------------------------------------------------------------------------
// Help, version
// ---------------------------------------------------------------------------

function packageInfo() {
  try {
    const p = require('../package.json');
    return { name: p.name || 'cyuneo-agent-monitor', version: p.version || '' };
  } catch {
    return { name: 'cyuneo-agent-monitor', version: '' };
  }
}

const HELP_KEY = {
  watch: 'cli.opt.watch', interval: 'cli.opt.interval', window: 'cli.opt.window', stale: 'cli.opt.stale',
  provider: 'cli.opt.provider', here: 'cli.opt.here', session: 'cli.opt.session', today: 'cli.opt.today',
  noToday: 'cli.opt.noToday', seenAll: 'cli.opt.seenAll', json: 'cli.opt.json', lang: 'cli.opt.lang',
  claudeDir: 'cli.opt.claudeDir', codexHome: 'cli.opt.codexHome', noColor: 'cli.opt.noColor', color: 'cli.opt.color',
  help: 'cli.opt.help', version: 'cli.opt.version',
};

/** All lines of --help */
function helpLines(i18n, color) {
  const view = { color, i18n };
  const lines = [bold(color, BRAND), i18n.t('cli.help.intro'), '', bold(color, i18n.t('cli.help.usage')),
    '  agent-monitor [' + i18n.t('cli.help.optionsArg') + ']', '', bold(color, i18n.t('cli.help.options'))];
  const flagText = (o) => o.flags.join(', ') + (o.value ? ' <' + o.value + '>' : '');
  const pad = Math.max(...OPTIONS.map((o) => displayWidth(flagText(o)))) + 2;
  for (const o of OPTIONS) {
    const ft = flagText(o);
    const vars = { n: DEFAULTS[o.name] };
    lines.push('  ' + ft + ' '.repeat(pad - displayWidth(ft)) + i18n.t(HELP_KEY[o.name], vars));
  }
  lines.push('', bold(color, i18n.t('cli.help.lamps')));
  for (const l of S.LAMPS) lines.push('  ' + dot(view, l) + ' ' + F.lampLabel(l, i18n));
  lines.push('', bold(color, i18n.t('cli.help.examples')));
  lines.push('  agent-monitor --watch');
  lines.push('  agent-monitor --provider codex --window 120');
  lines.push('  agent-monitor --session 1a2b3c4d');
  lines.push('  agent-monitor --json > snapshot.json');
  lines.push('', i18n.t('cli.help.privacy'));
  return lines;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function writeLines(stream, lines) { stream.write(lines.join('\n') + '\n'); }

/**
 * Entry point. Returns the exit code (null in watch mode, where a signal ends the process).
 * @param {string[]} argv
 * @param {{ env?: Record<string, string|undefined>, stdout?: any, stderr?: any, stdin?: any }} [io]
 */
function main(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const { opts, errors } = parseArgs(argv);
  const i18n = createI18n(opts.lang || resolveCliLocale([], env));
  const color = useColor(opts, env, out);

  if (errors.length) {
    const ec = useColor(opts, env, err);
    for (const e of errors) err.write(fg(ec, 196, i18n.t(e.key, e.vars)) + '\n');
    err.write(i18n.t('cli.error.seeHelp') + '\n');
    return 2;
  }
  if (opts.help) { writeLines(out, helpLines(i18n, color)); return 0; }
  if (opts.version) { const p = packageInfo(); out.write(`${p.name} ${p.version}\n`); return 0; }

  const cfg = monitorConfig(opts);
  const mon = new Monitor(cfg);
  const view = createView({
    i18n, color, seenAll: opts.seenAll, window: opts.window, showToday: cfg.daily,
    here: opts.here ? process.cwd() : null,
  });

  // Render one frame: returns { lines } or { error }
  const frame = (extra) => {
    const t0 = Date.now();
    let snap = mon.snapshot(t0);
    let session = null;
    if (opts.session) {
      const f = findSession(snap.sessions, opts.session);
      if (!f.session) {
        return { error: f.matches > 1
          ? i18n.t('cli.error.ambiguous', { id: opts.session, n: f.matches })
          : i18n.t('cli.error.noSession', { id: opts.session, n: opts.window }) };
      }
      session = f.session;
      // Details are only produced for focused sessions: set focus and take another snapshot (in-memory state only, cheap)
      if (!snap.details || !snap.details[session.key]) {
        mon.setFocus([session.key]);
        snap = mon.snapshot(Date.now());
        session = snap.sessions.find((s) => s.key === session.key) || session;
      }
    }
    const scanMs = Date.now() - t0;
    if (opts.json) {
      const data = buildJson(view, snap, { scanMs });
      if (session) {
        data.sessions = data.sessions.filter((s) => s.key === session.key);
        data.groups = data.groups.map((g) => ({ id: g.id, keys: g.keys.filter((k) => k === session.key) })).filter((g) => g.keys.length);
      }
      return { json: data };
    }
    const tail = extra ? extra(scanMs) : [];
    const lines = session ? renderDetail(view, snap, session, { now: snap.now, extra: tail })
      : renderList(view, snap, { now: snap.now, extra: tail });
    return { lines };
  };

  if (!opts.watch) {
    let r;
    try {
      r = frame((ms) => ['', i18n.t('cli.scanned', { ms })]);
    } finally {
      mon.dispose();
    }
    if (r.error) { err.write(r.error + '\n'); return 1; }
    if (r.json) { out.write(JSON.stringify(r.json, null, 2) + '\n'); return 0; }
    writeLines(out, r.lines);
    return 0;
  }

  // --watch: on a TTY use the alternate screen and redraw in place; otherwise (pipe) append frame by frame
  const tty = !!out.isTTY && !opts.json;
  const stdin = io.stdin || process.stdin;
  let timer = null;
  let stopped = false;
  const stop = (code) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    try { mon.dispose(); } catch { /* ignore */ }
    if (tty) out.write('\x1b[?25h\x1b[?1049l');
    try { if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false); } catch { /* ignore */ }
    process.exit(code);
  };
  const draw = () => {
    let r;
    try {
      r = frame(() => ['', i18n.t('cli.updated', { time: new Date().toLocaleTimeString(i18n.intlLocale) }) + SEP + i18n.t('cli.quit')]);
    } catch (e) {
      r = { error: String((e && e.message) || e) };
    }
    if (r.json) { out.write(JSON.stringify(r.json) + '\n'); return; }
    const lines = r.error ? [fg(color, 196, r.error)] : r.lines;
    if (!tty) { writeLines(out, lines.concat('')); return; }
    const width = out.columns || 0;
    const height = out.rows || 0;
    let shown = width ? lines.map((l) => truncate(l, width)) : lines;
    // If it doesn't fit, cut the middle; the last line (update time, key hints) always stays
    if (height > 3 && shown.length > height) {
      const hidden = shown.length - (height - 2) - 1;
      shown = shown.slice(0, height - 2).concat(dim(color, i18n.t('cli.more', { n: hidden })), shown[shown.length - 1]);
    }
    out.write('\x1b[H' + shown.map((l) => l + '\x1b[K').join('\n') + '\x1b[J');
  };

  if (tty) out.write('\x1b[?1049h\x1b[?25l');
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  if (tty) out.on('resize', draw);
  if (stdin.isTTY && stdin.setRawMode) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', (b) => {
      const k = String(b);
      if (k === 'q' || k === 'Q' || k === '\x03' || k === '\x1b') stop(0);
    });
  }
  draw();
  timer = setInterval(draw, cfg.intervalMs);
  return null;
}

if (require.main === module) {
  process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });
  const code = main(process.argv.slice(2));
  if (code != null) process.exitCode = code;
}

module.exports = {
  parseArgs, monitorConfig, useColor, displayWidth, truncate, findSession,
  createView, renderList, renderDetail, buildJson, helpLines, main,
};
