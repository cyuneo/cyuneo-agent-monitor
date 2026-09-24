'use strict';
// Bottom panel, laid out like VS Code's terminal panel: a single webview view, agentMonitor.agents.
// One side is a narrow session list (modeled on the terminal tab list); the other shows the selected session's session bar + agent table.
// - buildViewModel(): pure function (no vscode dependency) that combines Session + SessionDetail + lamps + i18n into the content-area view model.
//   All text is formatted for the current language here; the webview (media/agents.js) only renders and looks up the dictionary; it never builds sentences or sorts.
// - buildSessionList(): pure function that turns the sorted sessions (lib/order.js createSessionOrder) into the list view model:
//   row text, short status, hover tooltip, and the data-vscode-context used by the context menu.
// - Row order is fixed by lib/order.js; the webview updates the DOM incrementally by key / row id.
// - AgentsViewProvider: the WebviewViewProvider. The list and the content use two message types (list / render), each sent only when its content actually changed.
//   Messages from the webview carry only sessionKey / row id / index / width; the extension looks up paths and text again from current data and never trusts the webview.

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

// The session context menu (package.json contributes.menus["webview/context"]) and the QuickPick opened by the "…" button at the end of a row share this list.
// when: the item appears only if the session carries this flag (compactable / resumable in data-vscode-context).
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
 * Menu items a session should show (same order as the context menu).
 * @param {{ compactable?: boolean, resumable?: boolean }} flags
 */
function sessionMenuItems(flags) {
  const f = flags || {};
  return SESSION_MENU.filter((m) => !m.when || !!f[m.when]);
}

/**
 * Which side the session list is on: setting agentMonitor.sessionListPosition; auto follows the position of the terminal tab list
 * (terminal.integrated.tabs.location, VS Code default: right).
 * @param {any} setting 'auto' | 'left' | 'right'
 * @param {any} terminalLocation 'left' | 'right' | undefined
 * @returns {'left'|'right'}
 */
function resolveListPosition(setting, terminalLocation) {
  if (setting === 'left' || setting === 'right') return setting;
  return terminalLocation === 'left' ? 'left' : 'right';
}

// Models with a window ≥ 500K are zoned by absolute token count; others by their share of the auto-compact threshold
const BIG_WINDOW = 500000;
const HINT_START_DEFAULT = 200000;
const HINT_ACT_DEFAULT = 500000;
const RATIO_CONSIDER = 0.6;
const RATIO_ACT = 0.8;
const EXPANDED_MAX_SESSIONS = 50;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const lines = (...xs) => xs.filter(Boolean).join('\n');

// The "Auto-compact: {value} (source) ▾" text comes from pure functions in lib/autocompact.js; the item is hidden if that module is missing or fails
let describeCompactSetting = null;
try {
  const m = require('./autocompact');
  if (m && typeof m.describeCompactSetting === 'function') describeCompactSetting = m.describeCompactSetting;
} catch { /* module missing: hide the entry */ }

// Codicons and color tones for timeline entries and file operations (error = error color)
const TIMELINE_ICON = {
  prompt: 'comment', thinking: 'lightbulb', tool: 'tools', toolDone: 'check', toolError: 'error',
  text: 'output', compact: 'fold', quota: 'error', apiError: 'error', retry: 'sync', interrupt: 'debug-stop', done: 'pass',
};
const ERROR_KINDS = new Set(['toolError', 'quota', 'apiError']);
const FILE_ICON = { create: 'diff-added', edit: 'diff-modified', delete: 'diff-removed', move: 'diff-renamed' };

/**
 * Context zone (a soft hint; does not change the lamp color).
 * @param {{ contextUsed?: number, contextWindow?: number|null, compactAt?: number|null }|null} tokens
 * @param {{ start?: number, act?: number }} [o] settings contextHintStart / contextHintAct
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

// Shorten the home directory to ~
function tildePath(p, home) {
  const s = String(p || '');
  if (!home || !s) return s;
  if (s === home) return '~';
  const sep = s.includes('\\') && !s.includes('/') ? '\\' : '/';
  return s.startsWith(home + sep) ? '~' + s.slice(home.length) : s;
}

// Path display: relative path when inside the session directory, otherwise the home directory is shortened to ~
function displayPath(p, cwd, home) {
  const s = String(p || '');
  if (cwd && (s.startsWith(cwd + '/') || s.startsWith(cwd + '\\'))) return s.slice(cwd.length + 1);
  return tildePath(s, home);
}

// File display: name + containing directory (relative path when inside the session directory)
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

// Agent elapsed time: up to now while running (or waiting on you); up to the last activity once stopped
function agentDuration(agent, status, now, i18n) {
  const start = agent && agent.startedMs;
  if (!fin(start)) return '';
  const code = status && status.code;
  const active = S.isRunningCode(code) || S.isNeedsYouCode(code);
  const end = active ? now : (fin(agent.lastActivityMs) ? agent.lastActivityMs : now);
  return end >= start ? i18n.fmtDur(end - start) : '';
}

// Row hover tooltip: nothing that changes every second, so a refresh doesn't close the tooltip
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
  // The main conversation row always uses the status corrected against the registry (lamp.js)
  const status = fixed && fixed.status ? fixed.status : a.status;
  const lamp = fixed ? fixed.lamp : lampLib.agentLamp(a);
  const isMain = r.kind === 'main';
  const name = F.formatAgentName(a, i18n);
  // Model · type; skip any part that repeats the name (e.g. an unnamed review agent)
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
    // Without a price the cell shows only "—"; the full explanation (no public pricing / estimate) goes in the hover tooltip
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
    badge: null, // the group's lamp already says it; no bell / error icon before the status text
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

// Expanded details: recent steps, result, changed files, errors
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

// Context for the session bar at the top: absolute numbers first, zone, compaction count, cache countdown.
// Window and compaction point use the values computed on Session per Claude Code / Codex rules; the percentage uses Claude Code's formula (share of the window).
function contextVm(s, i18n, o) {
  const tk = F.sessionContextTokens(s);
  const ctx = F.formatContext(tk, i18n);
  const ofCompact = ctx.limit != null && fin(tk.compactAt) && ctx.limit === tk.compactAt;
  const text = ctx.limit
    ? i18n.t(ofCompact ? 'webview.ctx.ofCompact' : 'webview.ctx.ofWindow', { used: i18n.fmtTokens(ctx.used), limit: i18n.fmtTokens(ctx.limit) })
    : ctx.usageText;
  // Progress bar: used / auto-compact point (full = time to compact); the percentage in the text is of the window (matches what Claude Code shows)
  const pct = ctx.ratio == null ? null : Math.max(0, Math.min(100, Math.round(ctx.ratio * 100)));
  // When the bar maximum is the window itself, the percentage follows directly; otherwise write "41% of the 1M window" separately
  const pctText = ofCompact ? ctx.pctOfWindowText : (ctx.pctText ? '(' + ctx.pctText + ')' : '');
  const src = F.formatContextSources(tk, s.provider, i18n);
  const zone = contextZone(tk, { start: o.hintStart, act: o.hintAct });
  const zoneTip = zone ? lines(i18n.t('webview.zone.' + zone + '.tip'), i18n.t('webview.zone.newTask'), i18n.t('webview.zone.basis')) : '';
  // Compaction count: use compactCount if the provider gives it; otherwise mention only the most recent compaction
  let compactText = '';
  let compactTip = '';
  let compactTone = '';
  const n = fin(s.compactCount) ? s.compactCount : null;
  const last = s.main && s.main.lastCompact;
  // Second case: after the most recent compaction the context is still in the "act" zone (Claude transcripts record postTokens)
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
    // "412K / 967K auto-compact", "41% of the 1M window", "555K to auto-compact": each part is its own block (wraps as a whole in a narrow panel)
    text: ofCompact || !pctText ? text : text + ' ' + pctText,
    pctText: ofCompact ? pctText : '',
    // "41% context" next to "Compact…" in the title line (share of the window; the session list itself shows only the lamp, title and zone marker)
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
  // Don't repeat this usage-limit info when the status line already says it (the auto-continue note is in the resume hint)
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
 * "Auto-compact: {value} (source) ▾". Text comes from autocompact.describeCompactSetting; no module or no value → null (not shown).
 * Example: text "Auto-compact: 400K (40%)", detailText "→ ≈ 367K · Source: user settings" (the latter is dropped first in a narrow panel).
 * @returns {{ text: string, detailText: string, tip: string }|null}
 */
function autoCompactVm(s, i18n, o) {
  const describe = o.describeCompact !== undefined ? o.describeCompact : describeCompactSetting;
  if (typeof describe !== 'function') return null;
  // Session with no model reply yet (model and window unknown): don't guess "≈ 167K" from a 200K window; hide this line
  const tk = (s.main && s.main.tokens) || {};
  if (!s.model && !s.modelVariant && !fin(s.contextWindow) && !fin(tk.contextWindow)) return null;
  let d = null;
  try { d = describe(s, i18n); } catch { d = null; }
  if (!d || !d.valueText) return null;
  const value = String(d.valueText);
  // The part after the value in the button: prefer the full sentence describe built from this language's template ("400K (40%) → ≈ 367K · Source: …") minus the leading value
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

/** Main transcript path: the transcript given by the provider, or else the main conversation's transcript file */
function transcriptOf(s) {
  const p = s && typeof s.transcript === 'string' && s.transcript ? s.transcript
    : s && s.main && typeof s.main.file === 'string' ? s.main.file : '';
  return p && path.isAbsolute(p) ? p : '';
}

/**
 * The "Storage location" line: path (~ shortened), sizes of the main transcript / subagents / file backups, Reveal in file manager, Copy path.
 * Sizes come from SessionDetail.storage (only for the focused session, computed at most once every 60 seconds); until then only the path is shown.
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
    // Session cost prefers Claude Code's own stats; the extension's estimate goes in the tooltip for comparison
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
 * View model (pure function). Called by the extension on each snapshot, selection change and row expansion; the result is posted to the webview as-is.
 * @param {{
 *   session: any|null,                 // selected Session (null → empty state)
 *   detail?: any|null,                 // snapshot.details[session.key]
 *   lamps?: any,                       // lamp.computeLamps(...).bySession.get(session.key); if omitted, computed as unseen
 *   i18n: any, now?: number, today?: any, quota?: any,
 *   order?: ReturnType<typeof createAgentOrder>,   // stateful sorter; a view must keep using the same one
 *   expanded?: Set<string>|string[],   // expanded row ids: only these rows carry details, keeping messages small
 *   settings?: { hideCompleted?: boolean, showCost?: boolean, contextHintStart?: number, contextHintAct?: number },
 *   loaded?: boolean,                  // whether a snapshot has been received (false → "Loading…")
 *   emptyText?: string,                // hint when there are no sessions (empty scope, etc.); the extension picks it by scope
 *   emptyAction?: 'showAll'|null,      // button in the empty state: "Show all sessions" when scoped to the workspace
 *   home?: string, platform?: string,
 *   describeCompact?: Function|null,  // injected by tests; defaults to describeCompactSetting from lib/autocompact.js
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
    // When scoped to the workspace and the workspace has no sessions, offer "Show all sessions"
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
  // Number of rows hidden by hideCompleted
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

/** View model only */
function buildViewModel(input) { return buildView(input).vm; }

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

// Statuses that change on every step while running (thinking / running a tool / starting): the session row just says "Running"; details are in the content area.
// Otherwise the row text would change on every step and the hover tooltip would keep getting closed.
const CHURN = new Set([S.STATUS.STARTING, S.STATUS.THINKING, S.STATUS.TOOL]);
// Context zone marker as the last character of the session row's short status (consider / act); changes only when the zone changes
const ZONE_MARK = Object.freeze({ consider: '◔', act: '◕' });

/**
 * Render data for a session row (shared by the session list and the sidebar overview tree; nothing that changes every second).
 * description = {Claude|Codex} · one-line status · context percent [zone marker] (lib/format.js formatSessionRow).
 * @param {any} s Session
 * @param {any} L result of sessionLamps
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
    // Replace only the "one-line status" part; anything format.js appends after it (context, zone marker…) stays as-is
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
  // Zones use the session-level window and compaction point, consistent with the session bar in the content area
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

/** contextValue (space-separated flags) → the two flags the menu needs */
function flagsOf(contextValue) {
  const set = new Set(String(contextValue || '').split(/\s+/));
  return { compactable: set.has('compactable'), resumable: set.has('resumable') };
}

/**
 * Hover tooltip for a session row (plain text shown via the title attribute; user text as-is, no Markdown escaping).
 * Covers status, entry point, directory, ID, model, context, auto-compact, cache, cost, agent count and start time,
 * plus an explanation of the context zone marker. Nothing that changes every second, so a refresh won't close it while hovered.
 * @param {any} s Session
 * @param {any} L result of sessionLamps (if null, computed as unseen)
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

/** One session row in the list */
function sessionListRow(s, L, group, i18n, o) {
  const vm = sessionRowVm(s, L, i18n, o.now, o.hints);
  const flags = flagsOf(vm.contextValue);
  const look = lampBits(L.lamp);
  // The VS Code context menu reads data-vscode-context: webviewSection / sessionKey / the two flags; suppress the default Cut / Copy / Paste items
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
    // The list is narrow: a row holds only the lamp, title and zone marker (◔/◕); source, status and context move to the session bar, full text is in the tooltip and a11y
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
 * Session list view model (pure function). Order and groups come from createSessionOrder().arrange() (the extension owns the sorter).
 * No group label when there is only one group. The selected key is null when it isn't in the list.
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
   *   vscode?: any,                                   // injected by tests
   *   log?: (msg: string) => void,                    // Output panel
   *   onDidChangeVisibility?: (visible: boolean) => void,   // dwell timer for "seen" (seen.js dwell 'view')
   *   onSelect?: (sessionKey: string) => void,        // user clicked / pressed Enter on a session in the list
   *   onResizeList?: (width: number) => void,         // finished dragging the sash (width already snapped); the extension saves it to globalState
   *   onMore?: (sessionKey: string) => void,          // "…" at the end of a row: the extension shows a QuickPick with the same items as the context menu
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
    this.input = null;        // input of the most recent update() (content area)
    this.listInput = null;    // input of the most recent updateList() (session list)
    this.listKeys = new Set(); // sessions in the list last sent to the page (only these keys are accepted from the page)
    this.expanded = new Map(); // sessionKey -> Set<rowId>
    this.lastJson = '';
    this.lastListJson = '';
    this.description = undefined;
    this.disposables = [];
  }

  /** Key of the session currently shown (none → null) */
  get shownKey() { return this.input && this.input.session ? this.input.session.key : null; }

  /** Whether the webview is currently visible */
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
    // Description set before the view was first shown; apply it once the view exists (the panel's count badge is carried
    // by the hidden agentMonitor.panelOverview tree in extension.js, not by this view)
    if (this.description !== undefined) view.description = this.description;
    this.disposables.push(
      view.webview.onDidReceiveMessage((m) => {
        try { this.onMessage(m); } catch (err) { this.log('agents view: ' + ((err && err.stack) || err)); }
      }),
      view.onDidChangeVisibility(() => {
        // Once hidden, the page is destroyed; when shown again it reloads and sends ready
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
   * Replace the content-area data (called on every snapshot, selection change and settings change). Same parameters as buildView's input, minus i18n / order / expanded.
   * @param {Omit<Parameters<typeof buildView>[0], 'i18n'|'order'|'expanded'>} input
   */
  update(input) {
    this.input = input || null;
    this.post();
  }

  /**
   * Replace the session list data. Same parameters as buildSessionList's input, minus i18n.
   * @param {Omit<Parameters<typeof buildSessionList>[0], 'i18n'>} input
   */
  updateList(input) {
    this.listInput = input || null;
    this.post();
  }

  /** View description ("This workspace" when the scope is limited to the workspace) */
  setDescription(text) {
    this.description = text;
    if (this.view) this.view.description = text;
  }

  /** Force a resend (e.g. an appearance setting other than theme or language changed) */
  refresh() {
    this.lastJson = '';
    this.lastListJson = '';
    this.post();
  }

  // Send the list first, then the content; skip either if unchanged since last time (the list has nothing that changes every second, so data refreshes usually don't resend it)
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

  /** Whether a session key sent by the page is in the list (or currently shown) */
  listed(key) {
    return typeof key === 'string' && (this.listKeys.has(key) || key === this.shownKey);
  }

  // Accept only the session currently shown; find the agent in current data by row id. Returns [session, agent|null]
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
        // The webview remembers which rows are expanded (vscode.setState) and reports them after a reload
        if (m.expanded && typeof m.expanded === 'object') {
          for (const [k, ids] of Object.entries(m.expanded)) {
            if (Array.isArray(ids)) for (const id of ids.slice(0, 200)) this.setExpanded(k, String(id), true);
          }
        }
        // The page remembers the list width (webview state): if it differs from what the extension saved, the page wins and it is synced back to globalState
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
      // List: click a row / Enter / Space selects it; accept only sessions in the list, the extension decides the rest from current data
      case 'select':
        if (this.listed(m.sessionKey) && this.onSelect) this.onSelect(m.sessionKey);
        return;
      // Finished dragging the sash, or double-clicked to reset: width is snapped by the terminal's rules and handed to the extension to save
      case 'resizeList':
        if (typeof m.width === 'number' && Number.isFinite(m.width) && this.onResizeList) this.onResizeList(LIST.snapWidth(m.width));
        return;
      // "…" at the end of a row: show a QuickPick with the same items as the context menu
      case 'more':
        if (this.listed(m.sessionKey) && this.onMore) this.onMore(m.sessionKey);
        return;
      // "Show all sessions" in the empty state
      case 'showAll':
        Promise.resolve(vscode.commands.executeCommand(SHOW_ALL_COMMAND)).catch((err) => this.log(SHOW_ALL_COMMAND + ': ' + ((err && err.message) || err)));
        return;
      // Compact: the button on the session bar (current session) or at the end of a list row (any session in the list); the compact command looks the session up again by key
      case 'compact':
        if (this.listed(m.sessionKey)) vscode.commands.executeCommand(COMPACT_COMMAND, m.sessionKey);
        return;
      // "Auto-compact ▾", "Reveal in file manager", "Copy path" on the session bar: accept only the current session; the command looks up the path again from snapshot data
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
        // Open only files listed in this agent's details: absolute path that actually exists
        if (!d || !p || !(d.files || []).some((f) => f && f.path === p) || !path.isAbsolute(p)) return;
        if (!isFile(p)) { vscode.window.showWarningMessage(t('webview.fileMissing', { path: p })); return; }
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p));
        return;
      }
      default:
    }
  }

  dispose() {
    for (const d of this.disposables.splice(0)) { try { d.dispose(); } catch { /* ignore */ } }
    this.view = null;
    this.ready = false;
  }
}

/** Row id (order.js format) → the agent in the session; workflow group row or not found → null */
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
