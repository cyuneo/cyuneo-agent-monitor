#!/usr/bin/env node
'use strict';
// 终端版（DESIGN §1.2、§3.4、§3.5、§11.3）：同时读 Claude Code 与 Codex 的本机会话记录。
// - 文字全部走 lib/i18n + lib/format（--lang 或 LC_ALL / LC_MESSAGES / LANG），本文件不写界面文字；
// - 灯用 statuslight 同色号的 xterm 256 色（lib/lamp.xtermDot）；
// - 会话、智能体顺序用 lib/order.js 锁定：--watch 下不因活动、灯、token 变化而跳动；
// - 只读本机文件，不联网；没有持久化，默认全部当作“未看过”（--seen-all 全部当看过）。
// 用法见 --help。被 require 时不运行，只导出纯函数（测试用）。

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

const BRAND = 'CYUNEO Agent Monitor'; // 产品名，不翻译
const SEP = F.SEP;
const DEFAULTS = Object.freeze({ window: 30, stale: 5, interval: 2 });
const PROVIDERS = ['all', 'claude', 'codex'];
const ONE_SHOT_BUDGET = 1e15; // 单次运行加 --today 时一次读完今天的记录
const RESULT_LINES = 12;      // 细节模式里结果最多显示的行数
const TIMELINE_MAX = 12;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

// 选项表：name → { flag, takes: 值的类型 }；help 按这个顺序列出
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
 * 解析命令行。出错不抛，放进 errors（{ key, vars }，由调用方按语言输出）。
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

/** 展开开头的 ~ 并转成绝对路径 */
function expandPath(p) {
  if (!p) return undefined;
  const s = String(p);
  const home = os.homedir();
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2));
  return path.resolve(s);
}

/** 由参数得到 Monitor 的配置（WorkerConfig 的子集，其余由 normalizeConfig 补默认值） */
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
// 终端小工具：颜色、显示宽度、截断
// ---------------------------------------------------------------------------

/**
 * 是否上色：--no-color / NO_COLOR 关；--color / FORCE_COLOR 开；否则看 stdout 是不是终端。
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

// 东亚宽字符占两列；组合符号、零宽字符占 0 列
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

/** 终端里的显示宽度（忽略 ANSI 转义） */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s).replace(ANSI_RE, '')) w += charWidth(ch.codePointAt(0));
  return w;
}

/** 截到 width 列（保留 ANSI 转义），超出时以 … 结尾并复位颜色 */
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

/** 按显示宽度补空格到 width 列 */
function padWidth(s, width) {
  const w = displayWidth(s);
  return w >= width ? String(s) : String(s) + ' '.repeat(width - w);
}

/** 行首缩进 + 单行化（原文里的换行、制表符变成空格） */
function oneLine(s) { return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim(); }

function shortHome(p) {
  if (!p) return '';
  const home = os.homedir();
  const s = String(p);
  return home && (s === home || s.startsWith(home + path.sep)) ? '~' + s.slice(home.length) : s;
}

// ---------------------------------------------------------------------------
// 视图：把一份快照排成终端文字
// ---------------------------------------------------------------------------

/**
 * 一次运行的渲染状态：i18n、上色、稳定排序器（--watch 期间一直用同一份，顺序才不跳）。
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

/** 范围过滤 + 稳定排序 + 灯 */
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

/** 灯 + 文字：NeedsYou / Error 的文字也上灯色 */
function lampText(view, lamp, text) {
  const n = LAMP_TEXT_COLOR[lamp];
  return n ? fg(view.color, n, text) : text;
}

function dot(view, lamp) { return lampLib.xtermDot(lamp, { color: view.color }); }

/** 顶部一行：品牌 + 各灯的会话数（按显示紧急度） */
function headerLine(view, counts) {
  const { i18n } = view;
  const parts = [];
  for (const l of ['needsYou', 'error', 'doneUnseen', 'working']) {
    if (counts[l] > 0) parts.push(dot(view, l) + ' ' + i18n.t('bar.count', { n: counts[l], label: F.lampLabel(l, i18n, true) }));
  }
  const tail = parts.length ? parts.join('  ') : dot(view, 'idle') + ' ' + i18n.t('bar.idle');
  return bold(view.color, BRAND) + '   ' + tail;
}

/** 会话标题行 + 一行灰色的元信息 */
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

/** 一个智能体行 */
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
  // “思考中”状态配“思考中”步骤时只写一次（带用时）
  const same = st && st.code === S.STATUS.THINKING && a.step && a.step.kind === S.STEP.THINKING && step;
  parts.push(lampText(view, cell.lamp, same ? oneLine(step) : status));
  if (step && !same) parts.push(oneLine(step));
  const tok = a.tokens && a.tokens.display;
  if (tok > 0) parts.push(i18n.t('count.tokens', { n: i18n.fmtTokens(tok) }));
  if (a.toolErrors > 0) parts.push(fg(view.color, 196, i18n.t('count.toolErrors', { n: a.toolErrors })));
  if (!isMain && a.model && a.model !== s.model) parts.push(dim(view.color, String(a.model)));
  return indent + dot(view, cell.lamp) + ' ' + parts.join(SEP);
}

/** 账号级信息：Codex 额度、Claude 最近一次撞额度、今日合计、出错信息 */
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
 * 列表视图：打开中 / 最近两组，每个会话下面是它的智能体（顺序固定）。
 * @param {any} view createView() 的结果
 * @param {any} snap Monitor.snapshot()
 * @param {{ now?: number, extra?: string[] }} [o] extra：放在底部的附加行（用时、按键提示）
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
 * --session 用：在这份列表里能唯一定位的 id 前缀（至少 8 个字符）。
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
 * 按 id、key 或前缀找会话。
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
 * 细节视图（右侧那一栏的终端版）：会话、每个智能体的时间线 / 结果 / 改过的文件 / 报错，再加续跑提示。
 * @param {any} view
 * @param {any} snap 已 setFocus 过该会话的快照
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
 * --json 的内容：快照 + 固定顺序 + 灯。会话按左侧顺序排好，每个会话带 lamp、group 和按右侧顺序的 rows。
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
// 帮助、版本
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

/** --help 的全部行 */
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
// 运行
// ---------------------------------------------------------------------------

function writeLines(stream, lines) { stream.write(lines.join('\n') + '\n'); }

/**
 * 入口。返回退出码（watch 模式下返回 null，由信号结束进程）。
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

  // 一次渲染：返回 { lines } 或 { error }
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
      // 细节只给 focus 里的会话：设好 focus 再取一份（只用内存状态，很便宜）
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

  // --watch：终端里用备用屏幕、原地重画；不是终端（管道）时逐帧追加
  const tty = !!out.isTTY && !opts.json;
  const stdin = io.stdin || process.stdin;
  let timer = null;
  let stopped = false;
  const stop = (code) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    try { mon.dispose(); } catch { /* 忽略 */ }
    if (tty) out.write('\x1b[?25h\x1b[?1049l');
    try { if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false); } catch { /* 忽略 */ }
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
    // 放不下时截掉中间，最后一行（更新时间、按键提示）总留着
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
