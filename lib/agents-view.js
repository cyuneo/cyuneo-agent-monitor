'use strict';
// 底部面板（DESIGN §11.13：做成终端面板那样）：一个 webview 视图 agentMonitor.agents，
// 一侧是窄的会话列表（仿终端标签列表），另一块是选中会话的会话条 + 智能体表（§8.2、§11.2–11.4、§11.7、§11.8）。
// - buildViewModel()：纯函数（不依赖 vscode），把 Session + SessionDetail + 灯 + i18n 拼成内容区的视图模型，
//   所有文字在这里按语言格式化好；webview（media/agents.js）只渲染、只查词典，不拼句子、不排序。
// - buildSessionList()：纯函数，把排好序的会话（lib/order.js createSessionOrder，§11.3）拼成列表的视图模型：
//   行文字、短状态、悬停提示、右键菜单用的 data-vscode-context。原来左侧原生树（sessions-tree.js）的行文字逻辑并到这里。
// - 行顺序由 lib/order.js 锁定（§11.3），webview 按 key / 行 id 增量更新 DOM。
// - AgentsViewProvider：WebviewViewProvider。列表和内容分两种消息（list / render），各自只在内容真变了时才发。
//   webview 发来的消息只带 sessionKey / 行 id / 序号 / 宽度，路径和文字一律由扩展端按当前数据重新查找，不信任 webview。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const S = require('./core/status');
const F = require('./format');
const lampLib = require('./lamp');
const LIST = require('../media/session-list');
const { createAgentOrder, ROW_MAIN, agentRowId, workflowAgentRowId } = require('./order');
const { webviewHtml } = require('./webview-html');

const VIEW_ID = 'agentMonitor.agents';
const COMPACT_COMMAND = 'agentMonitor.compact';
const AUTOCOMPACT_COMMAND = 'agentMonitor.setAutoCompact';
const REVEAL_COMMAND = 'agentMonitor.revealTranscript';
const COPY_PATH_COMMAND = 'agentMonitor.copyTranscriptPath';
const SHOW_ALL_COMMAND = 'agentMonitor.scope.all';
const SEP = F.SEP;

// 会话的右键菜单（package.json contributes.menus["webview/context"]）和行尾“…”弹出的 QuickPick 用同一份清单。
// when：只在会话带这个标记时出现（data-vscode-context 里的 compactable / resumable）。
const SESSION_MENU = Object.freeze([
  { command: 'agentMonitor.compact', group: '1_session', when: 'compactable' },
  { command: 'agentMonitor.handoff', group: '1_session', when: null },
  { command: 'agentMonitor.setAutoCompact', group: '1_session', when: null },
  { command: 'agentMonitor.copyResume', group: '1_session', when: 'resumable' },
  { command: 'agentMonitor.markSeen', group: '1_session', when: null },
  { command: 'agentMonitor.openTranscript', group: '2_open', when: null },
  { command: 'agentMonitor.revealTranscript', group: '2_open', when: null },
  { command: 'agentMonitor.copyTranscriptPath', group: '2_open', when: null },
].map((m) => Object.freeze(m)));

/**
 * 某个会话该出现的菜单项（顺序同右键菜单）。
 * @param {{ compactable?: boolean, resumable?: boolean }} flags
 */
function sessionMenuItems(flags) {
  const f = flags || {};
  return SESSION_MENU.filter((m) => !m.when || !!f[m.when]);
}

/**
 * 会话列表在哪一边（§11.13）：设置 agentMonitor.sessionListPosition；auto 跟随终端标签列表的位置
 * （terminal.integrated.tabs.location，VS Code 默认 right）。
 * @param {any} setting 'auto' | 'left' | 'right'
 * @param {any} terminalLocation 'left' | 'right' | undefined
 * @returns {'left'|'right'}
 */
function resolveListPosition(setting, terminalLocation) {
  if (setting === 'left' || setting === 'right') return setting;
  return terminalLocation === 'left' ? 'left' : 'right';
}

// §11.8 第 1 条：窗口 ≥ 500K 的模型按绝对数分区，其余按占自动压缩阈值的比例分区
const BIG_WINDOW = 500000;
const HINT_START_DEFAULT = 200000;
const HINT_ACT_DEFAULT = 500000;
const RATIO_CONSIDER = 0.6;
const RATIO_ACT = 0.8;
const EXPANDED_MAX_SESSIONS = 50;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const lines = (...xs) => xs.filter(Boolean).join('\n');

// §11.9 “自动压缩：{值}（来源）▾”的文字由 lib/autocompact.js 的纯函数给；模块不在或出错时不显示这一项
let describeCompactSetting = null;
try {
  const m = require('./autocompact');
  if (m && typeof m.describeCompactSetting === 'function') describeCompactSetting = m.describeCompactSetting;
} catch { /* 模块不存在：隐藏入口 */ }

// 时间线、文件操作的 codicon 与色调（error = 报错色）
const TIMELINE_ICON = {
  prompt: 'comment', thinking: 'lightbulb', tool: 'tools', toolDone: 'check', toolError: 'error',
  text: 'output', compact: 'fold', quota: 'error', apiError: 'error', retry: 'sync', interrupt: 'debug-stop', done: 'pass',
};
const ERROR_KINDS = new Set(['toolError', 'quota', 'apiError']);
const FILE_ICON = { create: 'diff-added', edit: 'diff-modified', delete: 'diff-removed', move: 'diff-renamed' };

/**
 * 上下文分区（§11.8 第 1 条，软提示，不改灯色）。
 * @param {{ contextUsed?: number, contextWindow?: number|null, compactAt?: number|null }|null} tokens
 * @param {{ start?: number, act?: number }} [o] 设置 contextHintStart / contextHintAct
 * @returns {'consider'|'act'|null}
 */
function contextZone(tokens, o = {}) {
  const t = tokens || {};
  const used = Number(t.contextUsed) || 0;
  if (used <= 0) return null;
  if (fin(t.contextWindow) && t.contextWindow >= BIG_WINDOW) {
    const start = fin(o.start) && o.start > 0 ? o.start : HINT_START_DEFAULT;
    const act = fin(o.act) && o.act > start ? o.act : Math.max(HINT_ACT_DEFAULT, start);
    if (used < start) return null;
    return used < act ? 'consider' : 'act';
  }
  const limit = fin(t.compactAt) && t.compactAt > 0 ? t.compactAt : (fin(t.contextWindow) && t.contextWindow > 0 ? t.contextWindow : null);
  if (!limit) return null;
  const r = used / limit;
  if (r >= RATIO_ACT) return 'act';
  if (r >= RATIO_CONSIDER) return 'consider';
  return null;
}

// 主目录缩写成 ~
function tildePath(p, home) {
  const s = String(p || '');
  if (!home || !s) return s;
  if (s === home) return '~';
  const sep = s.includes('\\') && !s.includes('/') ? '\\' : '/';
  return s.startsWith(home + sep) ? '~' + s.slice(home.length) : s;
}

// 路径显示：在会话目录下写相对路径，否则主目录缩写成 ~
function displayPath(p, cwd, home) {
  const s = String(p || '');
  if (cwd && (s.startsWith(cwd + '/') || s.startsWith(cwd + '\\'))) return s.slice(cwd.length + 1);
  return tildePath(s, home);
}

// 文件显示：名字 + 所在目录（在会话目录下时写相对路径）
function splitPath(p, cwd, home) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const base = i >= 0 ? s.slice(i + 1) : s;
  let dir = i >= 0 ? s.slice(0, i) : '';
  if (cwd && dir && (dir === cwd || dir.startsWith(cwd + '/') || dir.startsWith(cwd + '\\'))) {
    dir = dir.slice(cwd.length).replace(/^[\\/]/, '');
  } else {
    dir = tildePath(dir, home);
  }
  return { base, dir };
}

function lampBits(lamp) {
  const v = lampLib.lampVisual(lamp);
  return { lamp: v.lamp, shape: v.shape, badge: v.badgeIcon };
}

// 智能体用时：在跑（或在等你）算到现在，停下的算到最后一次活动
function agentDuration(agent, status, now, i18n) {
  const start = agent && agent.startedMs;
  if (!fin(start)) return '';
  const code = status && status.code;
  const active = S.isRunningCode(code) || S.isNeedsYouCode(code);
  const end = active ? now : (fin(agent.lastActivityMs) ? agent.lastActivityMs : now);
  return end >= start ? i18n.fmtDur(end - start) : '';
}

// 行的悬停提示：不放逐秒变化的内容（§11.2 同理），免得每次刷新提示被关掉
function agentTip(agent, status, lamp, i18n, o) {
  const tk = agent.tokens || {};
  const ctx = F.formatContext(tk, i18n);
  const counts = [
    i18n.t('count.apiCalls', { n: tk.apiCalls || 0 }),
    i18n.t('count.toolCalls', { n: agent.toolCalls || 0 }),
    i18n.t('count.toolErrors', { n: agent.toolErrors || 0 }),
    i18n.t('count.filesChanged', { n: agent.filesChanged || 0 }),
  ].join(SEP);
  const cost = o.showCost
    ? i18n.t('cost.label') + ': ' + F.formatCost(agent.costUsd, i18n, { unpriced: agent.unpricedModel, estimated: agent.costEstimated })
    : '';
  return lines(
    F.formatAgentName(agent, i18n) + SEP + F.formatAgentKind(agent, i18n),
    agent.model ? i18n.t('tip.model') + ': ' + agent.model : '',
    F.lampLabel(lamp, i18n) + SEP + F.formatStatus(status, agent, i18n, o.now, { stable: true, isMain: agent.kind === 'main' }),
    F.formatStatusNote(status, i18n),
    status && status.error && status.error.message ? String(status.error.message) : '',
    F.formatStep(agent.step, status, i18n, o.now),
    i18n.t('ctx.label') + ': ' + [ctx.usageText, ctx.remainText].filter(Boolean).join(SEP),
    i18n.t('webview.tip.latestCall', { n: i18n.fmtNum(tk.display || 0) }),
    i18n.t('webview.tip.output', { n: i18n.fmtNum(tk.output || 0) }),
    i18n.t('webview.tip.processed', { n: i18n.fmtNum(tk.processed || 0) }),
    counts,
    cost,
    fin(agent.startedMs) ? i18n.t('webview.tip.started', { time: i18n.fmtDateTime(agent.startedMs) }) : '',
    i18n.t('webview.tip.click'),
  );
}

function agentRowVm(r, L, i18n, o) {
  const a = r.agent;
  const fixed = L.rows.get(r.id) || null;
  // 主对话行一定用按登记表修正后的状态（lamp.js）
  const status = fixed && fixed.status ? fixed.status : a.status;
  const lamp = fixed ? fixed.lamp : lampLib.agentLamp(a);
  const isMain = r.kind === 'main';
  const name = F.formatAgentName(a, i18n);
  // 模型 · 类型；和名字重复的段（例如没有名字的审阅智能体）不再写一遍
  const sub = [a.model, ...(isMain ? [] : F.formatAgentKind(a, i18n).split(SEP))]
    .filter((x) => x && x !== name).join(SEP);
  const tk = a.tokens || {};
  const costFull = o.showCost ? F.formatCost(a.costUsd, i18n, { unpriced: a.unpricedModel, estimated: a.costEstimated }) : '';
  return {
    id: r.id,
    kind: r.kind,
    depth: r.depth,
    parentId: r.parentId,
    ...lampBits(lamp),
    lampText: F.lampLabel(lamp, i18n),
    name,
    sub,
    statusText: F.formatStatus(status, a, i18n, o.now, { isMain }),
    guess: !!(status && S.isGuessCode(status.code)),
    stepText: F.formatStep(a.step, status, i18n, o.now, { withDur: true }),
    tokensText: i18n.fmtTokens(tk.display || 0),
    // 没有价格时格子里只放“—”，完整说明（无公开价格 / 估算）放悬停提示
    costText: o.showCost ? (fin(a.costUsd) ? F.formatCost(a.costUsd, i18n, { unpriced: a.unpricedModel }) : i18n.fmtUsd(null)) : '',
    costTip: costFull,
    durText: agentDuration(a, status, o.now, i18n),
    tip: agentTip(a, status, lamp, i18n, o),
    expandable: true,
  };
}

function workflowRowVm(r, L, i18n, o) {
  const w = r.workflow;
  const fixed = L.rows.get(r.id);
  const lamp = fixed ? fixed.lamp : S.LAMP.IDLE;
  const f = F.formatWorkflow(w, i18n);
  const status = [f.stateText, f.progressText].filter(Boolean).join(SEP);
  return {
    id: r.id,
    kind: 'workflow',
    depth: r.depth,
    parentId: null,
    ...lampBits(lamp),
    badge: null, // 组的灯已经说明了；状态文字前不再放铃铛 / 报错图标
    lampText: F.lampLabel(lamp, i18n),
    name: f.name,
    sub: [i18n.t('workflow.label'), f.phaseText].filter(Boolean).join(SEP),
    statusText: status,
    guess: false,
    stepText: '',
    tokensText: i18n.fmtTokens(w.tokens || 0),
    costText: o.showCost ? F.formatCost(w.costUsd, i18n) : '',
    costTip: '',
    durText: '',
    tip: lines(i18n.t('workflow.label') + SEP + f.name, status, f.phaseText, w.scriptPath ? String(w.scriptPath) : ''),
    expandable: false,
  };
}

// 展开后的细节（§5）：最近几步、结果、改过的文件、报错
function detailVm(agent, d, i18n, o) {
  const counts = [
    i18n.t('count.toolCalls', { n: agent.toolCalls || 0 }),
    i18n.t('count.toolErrors', { n: agent.toolErrors || 0 }),
    i18n.t('count.filesChanged', { n: agent.filesChanged || 0 }),
  ].join(SEP);
  const base = { loaded: !!d, countsText: counts, canOpen: typeof agent.file === 'string' && agent.file.endsWith('.jsonl') };
  if (!d) return { ...base, timeline: [], result: null, files: [], errors: [] };
  const timeline = (d.timeline || []).slice().reverse().map((ev) => ({
    ago: i18n.fmtAgo(ev.ms, o.now),
    icon: TIMELINE_ICON[ev.kind] || 'circle-small',
    tone: ERROR_KINDS.has(ev.kind) ? 'error' : '',
    text: F.formatTimelineEvent(ev, i18n) || String(ev.kind || ''),
  }));
  const result = d.result && d.result.text
    ? { text: String(d.result.text), truncated: !!d.result.truncated, ago: i18n.fmtAgo(d.result.ms, o.now) }
    : null;
  const files = (d.files || []).map((f) => {
    const p = splitPath(f.path, o.cwd, o.home);
    const shown = f.op === 'move' && f.movedTo ? { ...f, movedTo: displayPath(f.movedTo, o.cwd, o.home) } : f;
    return { path: String(f.path), base: p.base, dir: p.dir, opText: F.formatFileOp(shown, i18n), icon: FILE_ICON[f.op] || 'file' };
  });
  const errors = (d.errors || []).slice().reverse().map((e) => ({
    ago: i18n.fmtAgo(e.ms, o.now),
    tool: e.tool ? F.toolLabel(e.tool, i18n) : '',
    text: String(e.text || ''),
  }));
  return { ...base, timeline, result, files, errors };
}

// 顶部会话条的上下文：绝对数为主（§11.8 第 1 条）、分区、压缩次数、缓存倒计时。
// 窗口与压缩点用 Session 上按 Claude Code / Codex 规则算好的值（§11.10），百分比用 Claude Code 的公式（占窗口）。
function contextVm(s, i18n, o) {
  const tk = F.sessionContextTokens(s);
  const ctx = F.formatContext(tk, i18n);
  const ofCompact = ctx.limit != null && fin(tk.compactAt) && ctx.limit === tk.compactAt;
  const text = ctx.limit
    ? i18n.t(ofCompact ? 'webview.ctx.ofCompact' : 'webview.ctx.ofWindow', { used: i18n.fmtTokens(ctx.used), limit: i18n.fmtTokens(ctx.limit) })
    : ctx.usageText;
  // 进度条：已用 / 自动压缩点（满格 = 该压缩了）；文字里的百分比是占窗口的（和 Claude Code 显示的一致）
  const pct = ctx.ratio == null ? null : Math.max(0, Math.min(100, Math.round(ctx.ratio * 100)));
  // 进度条上限就是窗口时，百分比直接跟在后面；否则单独写“占 1M 窗口的 41%”
  const pctText = ofCompact ? ctx.pctOfWindowText : (ctx.pctText ? '(' + ctx.pctText + ')' : '');
  const src = F.formatContextSources(tk, s.provider, i18n);
  const zone = contextZone(tk, { start: o.hintStart, act: o.hintAct });
  const zoneTip = zone ? lines(i18n.t('webview.zone.' + zone + '.tip'), i18n.t('webview.zone.newTask'), i18n.t('webview.zone.basis')) : '';
  // 压缩次数：provider 给了 compactCount 就用；否则只写最近一次压缩
  let compactText = '';
  let compactTip = '';
  let compactTone = '';
  const n = fin(s.compactCount) ? s.compactCount : null;
  const last = s.main && s.main.lastCompact;
  // §11.8 第 2 条的第二种情况：最近一次压缩后上下文仍在“建议处理”区（Claude 记录里有 postTokens）
  const postAct = !!last && fin(last.postTokens)
    && contextZone({ ...tk, contextUsed: last.postTokens }, { start: o.hintStart, act: o.hintAct }) === 'act';
  if (s.compactLoop || postAct) {
    compactText = i18n.t('webview.compactLoop');
    compactTip = lines(i18n.t('webview.compactLoop.tip'), i18n.t('webview.compactMany.basis'));
    compactTone = 'error';
  } else if (n != null && n > 0) {
    compactText = i18n.t('webview.compacted', { n });
    compactTip = i18n.t('webview.compacted.tip');
  } else if (last && fin(last.ms)) {
    const trig = last.trigger === 'auto' || last.trigger === 'manual' ? i18n.t('ctx.trigger.' + last.trigger) : '';
    compactText = trig ? i18n.t('webview.lastCompact', { ago: i18n.fmtAgo(last.ms, o.now), trigger: trig }) : i18n.t('ctx.lastCompact', { ago: i18n.fmtAgo(last.ms, o.now) });
  }
  const tipParts = [text, ctx.pctOfWindowText, ctx.remainText, ...ctx.notes, ...src.lines];
  if (s.provider === 'codex') tipParts.push(i18n.t('ctx.codexNote'));
  return {
    // §11.8 第 1 条 + §11.10：“412K / 967K 自动压缩” “占 1M 窗口的 41%” “距自动压缩 555K”，三段各自成块（窄面板里整块换行）
    text: ofCompact || !pctText ? text : text + ' ' + pctText,
    pctText: ofCompact ? pctText : '',
    // 标题行「压缩…」旁的“上下文 41%”（占窗口，和会话列表原来那段一样；列表现在只留灯、标题和区标记）
    shortText: ctx.shortText || '',
    remainText: ctx.remainText,
    tip: lines(...tipParts),
    pct,
    ariaText: [text, ctx.pctOfWindowText || ctx.pctText, ctx.remainText].filter(Boolean).join(SEP),
    zone,
    zoneText: zone ? i18n.t('webview.zone.' + zone) : '',
    zoneTip,
    compactText,
    compactTip,
    compactTone,
    many: n != null && n >= 2 && !!zone,
  };
}

function bannersVm(s, L, i18n, o) {
  const out = [];
  const mainSt = L.main && L.main.status;
  const lead = L.lead && L.lead.status;
  const quotaSt = mainSt && mainSt.code === S.STATUS.QUOTA ? mainSt : lead && lead.code === S.STATUS.QUOTA ? lead : null;
  // 状态那一行已经是这条额度信息时不再重复（自动继续的说明在续跑提示里）
  if (quotaSt && quotaSt !== lead) {
    out.push({
      tone: 'error', icon: 'error',
      text: F.formatQuotaHit(quotaSt.quota, i18n, o.now),
      detail: F.formatAutoContinue(quotaSt.quota, i18n, o.now),
      tip: '',
    });
  }
  if (mainSt && mainSt.code === S.STATUS.API_ERROR && mainSt.error && mainSt.error.message) {
    out.push({
      tone: 'error', icon: 'error',
      text: i18n.t('webview.apiError', { status: F.formatStatus(mainSt, s.main, i18n, o.now), message: String(mainSt.error.message) }),
      detail: '', tip: String(mainSt.error.message),
    });
  }
  const q = o.quota || {};
  if (s.provider === 'codex' && q.codex && (q.codex.windows || []).length) {
    const cq = F.formatCodexQuota(q.codex, i18n, o.now);
    const hot = !!q.codex.reachedType || q.codex.windows.some((w) => Number(w.usedPct) >= 90 && !(fin(w.resetsAtMs) && w.resetsAtMs <= o.now));
    out.push({
      tone: hot ? 'warning' : 'info', icon: hot ? 'warning' : 'info',
      text: i18n.t('webview.codexQuota', { title: cq.title, lines: cq.lines.slice(0, 2).join(i18n.t('webview.listSep')) }),
      detail: '', tip: lines(cq.title, ...cq.lines),
    });
  }
  if (s.provider === 'claude' && !quotaSt && q.claude && q.claude.lastHit) {
    const hit = q.claude.lastHit;
    if (fin(hit.resetsAtMs) && hit.resetsAtMs > o.now) {
      out.push({
        tone: 'info', icon: 'info',
        text: F.formatClaudeLastHit(hit, i18n, o.now),
        detail: '', tip: i18n.t('quota.claude.noPercent'),
      });
    }
  }
  if (o.ctx && o.ctx.many) {
    out.push({ tone: 'info', icon: 'info', text: i18n.t('webview.compactMany'), detail: '', tip: i18n.t('webview.compactMany.basis') });
  }
  return out.map((b, i) => ({ id: 'b' + i + ':' + b.tone, ...b }));
}

function resumeVm(s, i18n, o) {
  return (s.resume || []).map((hint, index) => {
    const f = F.formatResumeHint(hint, i18n, { now: o.now, platform: o.platform });
    const buttons = [];
    for (const v of f.variants) {
      const text = v === 'cli' ? f.command : f.prompt;
      if (!text) continue;
      buttons.push({ variant: v, label: i18n.t('resume.variant.' + v), tip: text });
    }
    return { index, label: f.label, infoText: [f.noteText, f.estimateText].filter(Boolean).join(' '), buttons };
  });
}

/**
 * “自动压缩：{值}（来源）▾”（§11.9）。文字来自 autocompact.describeCompactSetting；没有模块、没有值 → null（不显示）。
 * 例：text “Auto-compact: 400K (40%)”，detailText “→ ≈ 367K · Source: user settings”（后者在窄面板里先被省略）。
 * @returns {{ text: string, detailText: string, tip: string }|null}
 */
function autoCompactVm(s, i18n, o) {
  const describe = o.describeCompact !== undefined ? o.describeCompact : describeCompactSetting;
  if (typeof describe !== 'function') return null;
  // 还没有模型回复的会话（不知道模型、也不知道窗口）：不按 200K 猜一个“≈ 167K”，这一行不显示
  const tk = (s.main && s.main.tokens) || {};
  if (!s.model && !s.modelVariant && !fin(s.contextWindow) && !fin(tk.contextWindow)) return null;
  let d = null;
  try { d = describe(s, i18n); } catch { d = null; }
  if (!d || !d.valueText) return null;
  const value = String(d.valueText);
  // 按钮里值之后的部分：优先取 describe 按本语言模板拼好的整句（“400K (40%) → ≈ 367K · Source: …”）去掉开头的值
  const whole = d.text ? String(d.text) : '';
  const detail = whole.startsWith(value) && whole.length > value.length
    ? whole.slice(value.length).trim()
    : [d.effectiveText, d.sourceText].filter(Boolean).map(String).join(SEP);
  return {
    text: i18n.t('webview.autoCompact', { value }),
    detailText: detail,
    tip: lines(d.text ? String(d.text) : [value, detail].filter(Boolean).join(' '), d.tooltip ? String(d.tooltip) : '', i18n.t('webview.autoCompact.tip')),
  };
}

/** 主记录路径：provider 给的 transcript（§11.12.2），没有时用主对话的记录文件 */
function transcriptOf(s) {
  const p = s && typeof s.transcript === 'string' && s.transcript ? s.transcript
    : s && s.main && typeof s.main.file === 'string' ? s.main.file : '';
  return p && path.isAbsolute(p) ? p : '';
}

/**
 * “记录位置”一行（§11.11）：路径（~ 缩写）、主记录 / 子智能体 / 文件备份各多大、在文件管理器中显示、复制路径。
 * 大小来自 SessionDetail.storage（只给 focus 的会话，60 秒最多算一次），还没有时只显示路径。
 * @returns {{ pathText: string, pathTip: string, sizesText: string, sizesTip: string, revealText: string, copyText: string }|null}
 */
function storageVm(s, detail, i18n, o) {
  const file = transcriptOf(s);
  if (!file) return null;
  const st = detail && detail.storage && typeof detail.storage === 'object' ? detail.storage : null;
  const sizes = [];
  const tips = [];
  if (st) {
    if (fin(st.transcriptBytes)) {
      sizes.push(F.formatBytes(st.transcriptBytes, i18n));
      tips.push(i18n.t('webview.store.main.tip', { size: F.formatBytes(st.transcriptBytes, i18n) }));
    }
    if (fin(st.subagentsBytes) && st.subagentsBytes > 0) {
      sizes.push(i18n.t('webview.store.subagents', { size: F.formatBytes(st.subagentsBytes, i18n) }));
      tips.push(i18n.t('webview.store.subagents.tip', { size: F.formatBytes(st.subagentsBytes, i18n) }));
    }
    if (fin(st.fileHistoryBytes) && st.fileHistoryBytes > 0) {
      sizes.push(i18n.t('webview.store.fileHistory', { size: F.formatBytes(st.fileHistoryBytes, i18n) }));
      tips.push(i18n.t('webview.store.fileHistory.tip', { size: F.formatBytes(st.fileHistoryBytes, i18n) }));
    }
  }
  const platform = o.platform || process.platform;
  const reveal = platform === 'darwin' ? 'webview.store.reveal.mac' : platform === 'win32' ? 'webview.store.reveal.win' : 'webview.store.reveal.linux';
  return {
    pathText: tildePath(file, o.home),
    pathTip: lines(file, i18n.t('webview.store.tip')),
    sizesText: sizes.join(SEP),
    sizesTip: lines(...tips),
    revealText: i18n.t(reveal),
    copyText: i18n.t('webview.store.copy'),
  };
}

function sessionVm(s, L, i18n, o) {
  const lamp = L.lamp;
  const ctx = contextVm(s, i18n, o);
  const statusText = F.formatSessionStatus(s, i18n, o.now, {}, L);
  const leadStatus = L.lead && L.lead.status;
  const errMsg = leadStatus && leadStatus.error && leadStatus.error.message ? String(leadStatus.error.message) : '';
  const used = s.main && s.main.tokens ? Number(s.main.tokens.contextUsed) || 0 : 0;
  const compactable = (s.provider === 'claude' || s.provider === 'codex') && used >= F.COMPACTABLE_MIN;
  const today = F.formatToday(o.today, i18n);
  const cost = F.formatSessionCost(s, i18n);
  const cwd = s.cwd ? String(s.cwd) : '';
  const cacheMs = s.provider === 'claude' && fin(s.cacheExpiresMs) ? s.cacheExpiresMs : null;
  return {
    key: s.key,
    title: String(s.title || s.id || ''),
    provider: s.provider,
    ...lampBits(lamp),
    lampText: F.lampLabel(lamp, i18n),
    meta: [F.providerLabel(s.provider, i18n), F.entryLabel(s.entry, i18n), s.model, tildePath(cwd, o.home)].filter(Boolean).join(SEP),
    metaTip: lines(
      i18n.t('webview.meta.id', { id: s.id }),
      cwd ? i18n.t('webview.meta.folder', { path: cwd }) : '',
      i18n.t('tip.entry') + ': ' + F.entryLabel(s.entry, i18n) + SEP + i18n.t(s.live ? 'tip.open' : 'tip.notOpen'),
      fin(s.startedMs) ? i18n.t('tip.started') + ': ' + i18n.fmtDateTime(s.startedMs) : '',
    ),
    statusText,
    statusTip: lines(F.lampLabel(lamp, i18n), F.formatStatusNote(leadStatus, i18n), errMsg),
    guess: !!(leadStatus && S.isGuessCode(leadStatus.code)),
    context: ctx,
    compactable,
    autoCompact: autoCompactVm(s, i18n, o),
    storage: storageVm(s, o.detail, i18n, o),
    cache: cacheMs != null ? { expiresMs: cacheMs, text: F.formatCacheLeft(cacheMs, i18n, o.now) } : null,
    costText: o.showCost && cost.text ? i18n.t('webview.sessionCost', { usd: cost.text }) : '',
    todayText: o.showCost && o.today
      ? [i18n.t('webview.todayCost', { usd: today.text }), today.partialText].filter(Boolean).join(SEP)
      : '',
    // 会话费用优先用 Claude Code 自己的统计（§11.10），插件的估算写在提示里对照
    costTip: o.showCost
      ? (cost.fromClaudeCode
        ? lines(i18n.t('webview.sessionCost.cc.tip'), cost.estimateText ? i18n.t('webview.sessionCost.estimate', { usd: cost.estimateText }) : '', F.formatCostNote(i18n))
        : lines(i18n.t('cost.label'), F.formatCostNote(i18n)))
      : '',
    todayTip: o.showCost ? lines(i18n.t('cost.label') + SEP + i18n.t('cost.today'), ...today.lines, F.formatCostNote(i18n)) : '',
    banners: bannersVm(s, L, i18n, { ...o, ctx }),
    resume: resumeVm(s, i18n, o),
  };
}

/**
 * 视图模型（纯函数）。每次快照、切换选中会话、展开行时由扩展调用，结果原样 postMessage 给 webview。
 * @param {{
 *   session: any|null,                 // 选中的 Session（null → 空状态）
 *   detail?: any|null,                 // snapshot.details[session.key]
 *   lamps?: any,                       // lamp.computeLamps(...).bySession.get(session.key)；缺省时按未看过现算
 *   i18n: any, now?: number, today?: any, quota?: any,
 *   order?: ReturnType<typeof createAgentOrder>,   // 有状态的排序器，同一个视图要一直用同一个
 *   expanded?: Set<string>|string[],   // 展开的行 id：只给这些行带细节，消息不至于太大
 *   settings?: { hideCompleted?: boolean, showCost?: boolean, contextHintStart?: number, contextHintAct?: number },
 *   loaded?: boolean,                  // 收到过快照没有（false → “正在读取…”）
 *   emptyText?: string,                // 没有会话时的提示（范围为空等），扩展按范围给
 *   emptyAction?: 'showAll'|null,      // 空状态下的按钮：只看工作区时“显示所有会话”
 *   home?: string, platform?: string,
 *   describeCompact?: Function|null,  // 测试注入；缺省用 lib/autocompact.js 的 describeCompactSetting
 * }} input
 * @returns {{ vm: any, rowAgents: Map<string, any> }}
 */
function buildView(input) {
  const i18n = input.i18n;
  const now = fin(input.now) ? input.now : Date.now();
  const st = input.settings || {};
  const showCost = st.showCost !== false;
  const base = { type: 'render', v: 1, now, showCost, sessionKey: null, emptyText: '', emptyAction: null, session: null, rows: [], detail: {}, note: '' };
  const rowAgents = new Map();
  const s = input.session;
  if (!s || typeof s.key !== 'string') {
    base.emptyText = input.loaded === false ? i18n.t('session.loading') : (input.emptyText || i18n.t('session.none'));
    // 只看工作区而工作区里没有会话时，给一个“显示所有会话”（原来左侧原生树空状态里的链接）
    if (input.loaded !== false && input.emptyAction === 'showAll') base.emptyAction = { act: 'showAll', text: i18n.t('scope.showAll') };
    return { vm: base, rowAgents };
  }
  const L = input.lamps || lampLib.sessionLamps(s, { seenAtMs: 0 });
  const order = input.order || createAgentOrder();
  const o = {
    now, showCost,
    hintStart: st.contextHintStart, hintAct: st.contextHintAct,
    today: input.today || null, quota: input.quota || null,
    home: input.home != null ? input.home : os.homedir(),
    platform: input.platform || process.platform,
    cwd: s.cwd || null,
    detail: input.detail || null,
    describeCompact: input.describeCompact,
  };
  const arranged = order.arrange(s, { hideCompleted: !!st.hideCompleted });
  const rows = [];
  for (const r of arranged) {
    if (r.kind === 'workflow') rows.push(workflowRowVm(r, L, i18n, o));
    else { rows.push(agentRowVm(r, L, i18n, o)); rowAgents.set(r.id, r.agent); }
  }
  const expanded = input.expanded instanceof Set ? input.expanded : new Set(input.expanded || []);
  const detail = {};
  const agentsDetail = (input.detail && input.detail.agents) || null;
  for (const id of expanded) {
    const a = rowAgents.get(id);
    if (!a) continue;
    const d = agentsDetail ? agentsDetail[a.id] : null;
    detail[id] = detailVm(a, d || null, i18n, o);
  }
  // hideCompleted 藏掉的行数
  let total = (s.main ? 1 : 0) + (s.agents || []).length;
  for (const w of s.workflows || []) total += 1 + (w.agents || []).length;
  const hidden = st.hideCompleted ? Math.max(0, total - arranged.length) : 0;
  const vm = {
    ...base,
    sessionKey: s.key,
    session: sessionVm(s, L, i18n, o),
    rows,
    detail,
    note: hidden ? i18n.t('row.completedHidden', { n: hidden }) : '',
  };
  return { vm, rowAgents };
}

/** 只要视图模型 */
function buildViewModel(input) { return buildView(input).vm; }

// ---------------------------------------------------------------------------
// 会话列表（§11.13；行文字规则同 §11.2 左侧 description，悬停提示同原来左侧原生树）
// ---------------------------------------------------------------------------

// 在跑时一步一变的状态（思考 / 执行工具 / 启动）：会话行只写“运行中”，细节看内容区。
// 否则会话每走一步行文字就变一次，悬停提示照样被频繁关掉（§11.2 要避免的）。
const CHURN = new Set([S.STATUS.STARTING, S.STATUS.THINKING, S.STATUS.TOOL]);
// §11.8 第 1 条：会话行短状态末尾一个字的上下文区标记（可考虑 / 建议处理），只在换区时变
const ZONE_MARK = Object.freeze({ consider: '◔', act: '◕' });

/**
 * 会话行的渲染数据（会话列表、侧边栏总览树共用；不含逐秒变化的内容）。
 * description = {Claude|Codex} · 状态一句话 · 上下文百分比 [区标记]（lib/format.js formatSessionRow）。
 * @param {any} s Session
 * @param {any} L sessionLamps 的结果
 * @param {any} i18n
 * @param {number} now
 * @param {{ start?: number, act?: number }} [hints] contextHintStart / contextHintAct
 * @returns {{ label: string, description: string, icon: string, color: string, contextValue: string, a11y: string, mark: string }}
 */
function sessionRowVm(s, L, i18n, now, hints) {
  const row = F.formatSessionRow(s, i18n, { lamps: L, now });
  const look = lampLib.lampVisual(L.lamp);
  let { description, a11y } = row;
  const lead = L.lead && L.lead.status;
  if (L.lamp === S.LAMP.WORKING && lead && CHURN.has(lead.code) && row.statusText) {
    // 只换掉“状态一句话”那一段，format.js 在后面追加的内容（上下文、区标记…）原样保留
    const working = F.lampLabel(S.LAMP.WORKING, i18n);
    const swap = (text, sep) => {
      const i = text.indexOf(sep + row.statusText);
      if (i < 0) return text;
      const j = i + sep.length + row.statusText.length;
      return text.slice(0, i + sep.length) + working + text.slice(j);
    };
    description = swap(description, SEP);
    a11y = swap(a11y, ', ');
  }
  // 分区按会话级的窗口和压缩点（§11.10），和内容区的会话条一致
  const zone = contextZone(F.sessionContextTokens(s), hints || {});
  if (zone) {
    description += ' ' + ZONE_MARK[zone];
    a11y += ', ' + i18n.t('webview.zone.' + zone);
  }
  return {
    label: row.label,
    description,
    icon: look.shape,
    color: look.colorId,
    contextValue: F.sessionContextValue(s, L.lamp),
    a11y,
    mark: zone ? ZONE_MARK[zone] : '',
  };
}

/** contextValue（空格分隔的标记）→ 菜单要用的两个标记 */
function flagsOf(contextValue) {
  const set = new Set(String(contextValue || '').split(/\s+/));
  return { compactable: set.has('compactable'), resumable: set.has('resumable') };
}

/**
 * 会话行的悬停提示（纯文本，webview 用 title 属性显示；用户文本原样，不做 Markdown 转义）。
 * 内容同原来左侧原生树的 Markdown 提示：状态、入口、目录、ID、模型、上下文、自动压缩、缓存、费用、智能体数、开始时间，
 * 再加上下文区标记的说明（§11.8 第 1、4 条）。不含逐秒变化的内容，悬停时不会因为刷新被关掉。
 * @param {any} s Session
 * @param {any} L sessionLamps 的结果（null 时按未看过现算）
 * @param {any} i18n
 * @param {{ now?: number, showCost?: boolean, hints?: { start?: number, act?: number } }} [o]
 */
function sessionTipText(s, L, i18n, o = {}) {
  const lamps = L || lampLib.sessionLamps(s);
  const rows = F.formatSessionTooltip(s, i18n, { lamps, now: o.now, showCost: o.showCost });
  const out = [String(s.title || s.id || ''), ...rows.map(([k, v]) => k + ': ' + v)];
  const zone = contextZone(F.sessionContextTokens(s), o.hints || {});
  if (zone) {
    out.push('', ZONE_MARK[zone] + ' ' + i18n.t('webview.zone.' + zone) + ': ' + i18n.t('webview.zone.' + zone + '.tip'),
      i18n.t('webview.zone.newTask'), i18n.t('webview.zone.basis'));
  }
  if (o.showCost !== false && rows.some(([k]) => k === i18n.t('cost.label'))) out.push('', F.formatCostNote(i18n));
  return out.join('\n');
}

/** 列表里的一行会话 */
function sessionListRow(s, L, group, i18n, o) {
  const vm = sessionRowVm(s, L, i18n, o.now, o.hints);
  const flags = flagsOf(vm.contextValue);
  const look = lampBits(L.lamp);
  // VS Code 右键菜单读 data-vscode-context：webviewSection / sessionKey / 两个标记；不要剪切、复制、粘贴这些默认项
  const context = {
    webviewSection: 'session', sessionKey: s.key,
    compactable: flags.compactable, resumable: flags.resumable,
    preventDefaultContextMenuItems: true,
  };
  return {
    kind: 'session',
    key: s.key,
    group,
    title: vm.label,
    // 列表窄：一行只放灯、标题和区标记（◔/◕）；来源、状态、上下文挪到内容区的会话条，完整内容在悬停提示和 a11y 里
    desc: vm.mark,
    lamp: look.lamp,
    shape: look.shape,
    a11y: vm.a11y,
    tip: sessionTipText(s, L, i18n, o),
    compactable: flags.compactable,
    resumable: flags.resumable,
    context: JSON.stringify(context),
  };
}

/**
 * 会话列表的视图模型（纯函数）。顺序、分组来自 createSessionOrder().arrange()（§11.3，扩展持有排序器）。
 * 只有一组时不出组标签。选中的 key 不在列表里时为 null。
 * @param {{
 *   arranged?: { groups: { id: 'open'|'recent', sessions: any[] }[], showGroupHeaders: boolean },
 *   lamps?: Map<string, any>, i18n: any, now?: number,
 *   hints?: { start?: number, act?: number }, showCost?: boolean,
 *   selectedKey?: string|null, position?: 'left'|'right', width?: number,
 * }} input
 */
function buildSessionList(input) {
  const i18n = input.i18n;
  const now = fin(input.now) ? input.now : Date.now();
  const lamps = input.lamps || new Map();
  const arranged = input.arranged || { groups: [], showGroupHeaders: false };
  const o = { now, hints: input.hints || {}, showCost: input.showCost !== false };
  const showGroups = !!arranged.showGroupHeaders;
  const items = [];
  const keys = new Set();
  for (const g of arranged.groups || []) {
    const list = (g.sessions || []).filter((s) => s && typeof s.key === 'string');
    if (showGroups) items.push({ kind: 'group', id: 'g:' + g.id, text: F.formatGroup(g.id, i18n), count: String(list.length) });
    for (const s of list) {
      items.push(sessionListRow(s, lamps.get(s.key) || lampLib.sessionLamps(s), g.id, i18n, o));
      keys.add(s.key);
    }
  }
  return {
    type: 'list',
    v: 1,
    selectedKey: typeof input.selectedKey === 'string' && keys.has(input.selectedKey) ? input.selectedKey : null,
    position: input.position === 'left' ? 'left' : 'right',
    width: LIST.snapWidth(input.width),
    defaultWidth: LIST.WIDTH.DEFAULT,
    showGroups,
    items,
  };
}

// ---------------------------------------------------------------------------
// WebviewViewProvider
// ---------------------------------------------------------------------------

class AgentsViewProvider {
  /**
   * @param {import('vscode').ExtensionContext} context
   * @param {{
   *   i18n: any, version?: string,
   *   vscode?: any,                                   // 测试注入
   *   log?: (msg: string) => void,                    // 输出面板
   *   onDidChangeVisibility?: (visible: boolean) => void,   // 已看过的停留计时（seen.js dwell 'view'）
   *   onSelect?: (sessionKey: string) => void,        // 用户在列表里点了 / 按 Enter 选了某个会话
   *   onResizeList?: (width: number) => void,         // 拖完分隔线（宽度已吸附），扩展存进 globalState
   *   onMore?: (sessionKey: string) => void,          // 行尾“…”：扩展弹出与右键菜单同样内容的 QuickPick
   * }} opts
   */
  constructor(context, opts = {}) {
    this.vscode = opts.vscode || require('vscode');
    this.context = context;
    this.i18n = opts.i18n;
    this.version = opts.version || '';
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.onVisibility = typeof opts.onDidChangeVisibility === 'function' ? opts.onDidChangeVisibility : null;
    this.onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
    this.onResizeList = typeof opts.onResizeList === 'function' ? opts.onResizeList : null;
    this.onMore = typeof opts.onMore === 'function' ? opts.onMore : null;
    this.order = createAgentOrder();
    this.view = null;
    this.ready = false;
    this.input = null;        // 最近一次 update() 的输入（内容区）
    this.listInput = null;    // 最近一次 updateList() 的输入（会话列表）
    this.listKeys = new Set(); // 最近一次发给页面的列表里有哪些会话（页面发来的 key 只认这些）
    this.expanded = new Map(); // sessionKey -> Set<rowId>
    this.lastJson = '';
    this.lastListJson = '';
    this.badge = undefined;
    this.description = undefined;
    this.disposables = [];
  }

  /** 当前显示的会话 key（没有 → null） */
  get shownKey() { return this.input && this.input.session ? this.input.session.key : null; }

  /** webview 当前可见 */
  get visible() { return !!(this.view && this.view.visible); }

  resolveWebviewView(view) {
    const vscode = this.vscode;
    this.view = view;
    this.ready = false;
    this.lastJson = '';
    this.lastListJson = '';
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('base64');
    view.webview.html = webviewHtml({
      cspSource: view.webview.cspSource,
      asset: (p) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, ...p.split('/'))).toString(),
      nonce,
      version: this.version,
      i18n: this.i18n,
    });
    // 视图还没显示过时设的徽标、说明，等视图建好再挂上去
    if (this.badge !== undefined) view.badge = this.badge;
    if (this.description !== undefined) view.description = this.description;
    this.disposables.push(
      view.webview.onDidReceiveMessage((m) => {
        try { this.onMessage(m); } catch (err) { this.log('agents view: ' + ((err && err.stack) || err)); }
      }),
      view.onDidChangeVisibility(() => {
        // 隐藏后页面会被销毁，再显示时重新加载并发 ready
        if (!view.visible) this.ready = false;
        if (this.onVisibility) this.onVisibility(view.visible);
      }),
      view.onDidDispose(() => {
        if (this.view === view) { this.view = null; this.ready = false; }
        if (this.onVisibility) this.onVisibility(false);
      }),
    );
    if (this.onVisibility) this.onVisibility(view.visible);
  }

  /**
   * 换内容区的数据（每份快照、选中变化、设置变化都调）。参数同 buildView 的 input，去掉 i18n / order / expanded。
   * @param {Omit<Parameters<typeof buildView>[0], 'i18n'|'order'|'expanded'>} input
   */
  update(input) {
    this.input = input || null;
    this.post();
  }

  /**
   * 换会话列表的数据。参数同 buildSessionList 的 input，去掉 i18n。
   * @param {Omit<Parameters<typeof buildSessionList>[0], 'i18n'>} input
   */
  updateList(input) {
    this.listInput = input || null;
    this.post();
  }

  /** 视图徽标（需要你看的会话数，§8.2）：挂在这个 webview 视图上；视图还没建好时先记着 */
  setBadge(badge) {
    this.badge = badge;
    if (this.view) this.view.badge = badge;
  }

  /** 视图说明（查看范围只看工作区时写“此工作区”） */
  setDescription(text) {
    this.description = text;
    if (this.view) this.view.description = text;
  }

  /** 强制重发一次（例如主题、语言之外的外观设置变了） */
  refresh() {
    this.lastJson = '';
    this.lastListJson = '';
    this.post();
  }

  // 列表先发、内容后发；各自和上一次一样就不发（列表里没有逐秒变化的内容，数据刷新时通常不重发）
  post() {
    if (!this.view || !this.view.visible || !this.ready) return;
    if (this.listInput) {
      const list = buildSessionList({ ...this.listInput, i18n: this.i18n });
      this.listKeys = new Set(list.items.filter((x) => x.kind === 'session').map((x) => /** @type {any} */ (x).key));
      const json = JSON.stringify(list);
      if (json !== this.lastListJson) {
        this.lastListJson = json;
        this.view.webview.postMessage(list);
      }
    }
    if (!this.input) return;
    const key = this.shownKey;
    const { vm } = buildView({
      ...this.input,
      i18n: this.i18n,
      order: this.order,
      expanded: (key && this.expanded.get(key)) || new Set(),
    });
    const json = JSON.stringify(vm);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.view.webview.postMessage(vm);
  }

  /** 页面发来的会话 key 是否在列表里（或正在显示） */
  listed(key) {
    return typeof key === 'string' && (this.listKeys.has(key) || key === this.shownKey);
  }

  // 只认当前显示的会话；按行 id 在当前数据里找智能体。返回 [session, agent|null]
  lookup(m) {
    const s = this.input && this.input.session;
    if (!s || !m || m.sessionKey !== s.key) return [null, null];
    return [s, typeof m.rowId === 'string' ? agentForRow(s, m.rowId) : null];
  }

  setExpanded(sessionKey, rowId, open) {
    if (typeof sessionKey !== 'string' || typeof rowId !== 'string') return;
    let set = this.expanded.get(sessionKey);
    if (!set) {
      set = new Set();
      this.expanded.set(sessionKey, set);
      if (this.expanded.size > EXPANDED_MAX_SESSIONS) this.expanded.delete(this.expanded.keys().next().value);
    }
    if (open) set.add(rowId); else set.delete(rowId);
  }

  onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    const vscode = this.vscode;
    const t = (k, vars) => this.i18n.t(k, vars);
    switch (m.type) {
      case 'ready': {
        // webview 自己记着展开了哪些行（vscode.setState），重新加载后报上来
        if (m.expanded && typeof m.expanded === 'object') {
          for (const [k, ids] of Object.entries(m.expanded)) {
            if (Array.isArray(ids)) for (const id of ids.slice(0, 200)) this.setExpanded(k, String(id), true);
          }
        }
        // 页面自己记着列表宽度（webview state）：和扩展存的不一样时以页面的为准，同步回 globalState
        if (typeof m.listWidth === 'number' && Number.isFinite(m.listWidth) && this.onResizeList) {
          this.onResizeList(LIST.snapWidth(m.listWidth));
        }
        this.ready = true;
        this.lastJson = '';
        this.lastListJson = '';
        this.post();
        return;
      }
      case 'expand':
        this.setExpanded(m.sessionKey, m.rowId, !!m.open);
        if (m.open && m.sessionKey === this.shownKey) this.post();
        return;
      // 列表：点行 / Enter / 空格选中；只认列表里有的会话，其余由扩展按当前数据决定
      case 'select':
        if (this.listed(m.sessionKey) && this.onSelect) this.onSelect(m.sessionKey);
        return;
      // 拖完分隔线、双击复位：宽度按终端的规则吸附后交给扩展保存
      case 'resizeList':
        if (typeof m.width === 'number' && Number.isFinite(m.width) && this.onResizeList) this.onResizeList(LIST.snapWidth(m.width));
        return;
      // 行尾“…”：弹出与右键菜单同样内容的 QuickPick
      case 'more':
        if (this.listed(m.sessionKey) && this.onMore) this.onMore(m.sessionKey);
        return;
      // 空状态里的“显示所有会话”
      case 'showAll':
        Promise.resolve(vscode.commands.executeCommand(SHOW_ALL_COMMAND)).catch((err) => this.log(SHOW_ALL_COMMAND + ': ' + ((err && err.message) || err)));
        return;
      // 压缩：会话条上的按钮（当前会话）或列表行尾的按钮（列表里的任一会话）；由压缩命令按 key 重新查找会话
      case 'compact':
        if (this.listed(m.sessionKey)) vscode.commands.executeCommand(COMPACT_COMMAND, m.sessionKey);
        return;
      // 会话条上的“自动压缩 ▾”“在文件管理器中显示”“复制路径”：只认当前会话，路径由命令按快照数据重新查
      case 'setAutoCompact':
      case 'revealTranscript':
      case 'copyTranscriptPath': {
        const [s] = this.lookup(m);
        const cmd = { setAutoCompact: AUTOCOMPACT_COMMAND, revealTranscript: REVEAL_COMMAND, copyTranscriptPath: COPY_PATH_COMMAND }[m.type];
        if (s) Promise.resolve(vscode.commands.executeCommand(cmd, s.key)).catch((err) => this.log(cmd + ': ' + ((err && err.message) || err)));
        return;
      }
      case 'copyResume': {
        const [s] = this.lookup(m);
        if (!s || !Number.isInteger(m.hintIndex)) return;
        const hint = (s.resume || [])[m.hintIndex];
        if (!hint) return;
        const f = F.formatResumeHint(hint, this.i18n, { now: Date.now(), platform: process.platform });
        if (!f.variants.includes(m.variant)) return;
        const text = m.variant === 'cli' ? f.command : f.prompt;
        if (!text) return;
        vscode.env.clipboard.writeText(text).then(
          () => vscode.window.showInformationMessage(t(m.variant === 'cli' ? 'resume.copied.cli' : 'resume.copied')),
          (err) => this.log('clipboard: ' + err),
        );
        return;
      }
      case 'copyResult': {
        const [s, agent] = this.lookup(m);
        const d = s && agent && this.input.detail && this.input.detail.agents && this.input.detail.agents[agent.id];
        const text = d && d.result && d.result.text;
        if (!text) return;
        vscode.env.clipboard.writeText(String(text)).then(
          () => vscode.window.showInformationMessage(t('webview.copied')),
          (err) => this.log('clipboard: ' + err),
        );
        return;
      }
      case 'openTranscript': {
        const [, agent] = this.lookup(m);
        const file = agent && agent.file;
        if (typeof file !== 'string' || !file.endsWith('.jsonl') || !path.isAbsolute(file)) return;
        if (!isFile(file)) { vscode.window.showWarningMessage(t('webview.transcriptMissing')); return; }
        vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
        return;
      }
      case 'openFile': {
        const [, agent] = this.lookup(m);
        const d = agent && this.input.detail && this.input.detail.agents && this.input.detail.agents[agent.id];
        const p = typeof m.path === 'string' ? m.path : '';
        // 只打开这个智能体细节里列出的文件：绝对路径、确实存在
        if (!d || !p || !(d.files || []).some((f) => f && f.path === p) || !path.isAbsolute(p)) return;
        if (!isFile(p)) { vscode.window.showWarningMessage(t('webview.fileMissing', { path: p })); return; }
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p));
        return;
      }
      default:
    }
  }

  dispose() {
    for (const d of this.disposables.splice(0)) { try { d.dispose(); } catch { /* 忽略 */ } }
    this.view = null;
    this.ready = false;
  }
}

/** 行 id（order.js 的格式）→ 会话里的智能体；工作流组行、找不到 → null */
function agentForRow(s, rowId) {
  if (!s || typeof rowId !== 'string') return null;
  if (rowId === ROW_MAIN) return s.main || null;
  for (const a of s.agents || []) if (a && a.id != null && agentRowId(a.id) === rowId) return a;
  for (const w of s.workflows || []) {
    if (!w || w.id == null) continue;
    for (const a of w.agents || []) if (a && a.id != null && workflowAgentRowId(w.id, a.id) === rowId) return a;
  }
  return null;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

module.exports = {
  VIEW_ID, COMPACT_COMMAND, AUTOCOMPACT_COMMAND, REVEAL_COMMAND, COPY_PATH_COMMAND, SHOW_ALL_COMMAND,
  SESSION_MENU, ZONE_MARK, LIST_WIDTH: LIST.WIDTH,
  AgentsViewProvider, buildView, buildViewModel, buildSessionList, contextZone, transcriptOf,
  sessionRowVm, sessionTipText, sessionMenuItems, resolveListPosition,
  _internal: { tildePath, displayPath, splitPath, agentDuration, agentForRow, flagsOf },
};
