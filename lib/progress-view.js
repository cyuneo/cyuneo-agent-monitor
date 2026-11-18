'use strict';
// Side-bar Progress view (agentMonitor.progress, 0.12.0): one card per session, in the session list's order, and the
// selected session's main conversation laid out in place under its card.
// - Every card comes from the per-tick snapshot (no focus needed): lamp, title, what it is doing now, and one progress line
//   (plan > declared workflow phases > workflow agents > subagents > this turn's tool count).
// - The expanded card (the extension's shownKey, the selection shared with the bottom panel) adds the plan, the phase bars
//   of running workflows and the step stream of the current turn, folded into "Ran N tools" groups (progressVm).
// - Pure view-model functions (no vscode dependency); all text is formatted here, media/progress.js only renders it and
//   looks up fixed strings in the injected dictionary.
// - ProgressViewProvider: posts the cards and the expanded part as two messages, each only after ready, only while visible
//   and only when it changed. Messages from the page carry only a session key, row id and call id; everything is looked up
//   again in current data.

const crypto = require('crypto');
const S = require('./core/status');
const F = require('./format');
const lampLib = require('./lamp');
const AV = require('./agents-view');
const { ROW_MAIN, agentRowId, workflowRowId } = require('./order');
const { progressHtml } = require('./webview-html');

const VIEW_ID = 'agentMonitor.progress';
const SHOW_COMMAND = 'agentMonitor.show';
const OPEN_TRANSCRIPT_COMMAND = 'agentMonitor.openTranscript';
const SEP = F.SEP;
const { stepsVm, serveStep, flagsOf } = AV._internal;

const PLAN_SHOWN = 7;       // plan items shown before "N more"
const MAX_WORKFLOWS = 3;    // running workflows shown with their phase bars
const CAT_MAX = 3;          // tool categories named in a group's second line
const CLOSED_MAX = 50;      // sessions whose expanded card the page has collapsed (remembered by the page)
// A card folds to one line when the session is finished or idle (unless it is the expanded one)
const QUIET_LAMPS = new Set([S.LAMP.DONE_SEEN, S.LAMP.DONE_UNSEEN, S.LAMP.IDLE]);

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const isTranscriptFile = (file) => typeof file === 'string' && /\.jsonl?$/i.test(file);

/** "Just now" for anything under a minute, so card and step texts change at most once a minute */
function coarseAgo(i18n, ms, now) {
  if (!fin(ms)) return '';
  return Math.abs(now - ms) < 60e3 ? i18n.fmtAgo(now, now) : i18n.fmtAgo(ms, now);
}

/** The same i18n with the coarse ago (for stepsVm) */
function coarseI18n(i18n) {
  return Object.assign(Object.create(i18n), { fmtAgo: (ms, now) => coarseAgo(i18n, ms, now) });
}

/** Kind of a stepsVm line (its key starts with the timeline kind) */
function kindOf(x) {
  if (x.block) return 'tool';
  const i = String(x.key || '').indexOf(':');
  return i > 0 ? x.key.slice(0, i) : '';
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * What the session is doing now: the question it waits on, the current step while it works, else its status.
 * @returns {{ text: string, icon: string, spin: boolean }}
 */
function nowVm(s, L, i18n, now) {
  const look = lampLib.lampVisual(L.lamp);
  const status = F.formatSessionStatus(s, i18n, now, { stable: true }, L);
  if (L.lamp === S.LAMP.WORKING) {
    const lead = L.lead || {};
    const agent = lead.agent || s.main || null;
    const step = agent ? F.formatStep(agent.step, lead.status, i18n, now) : '';
    if (!step) return { text: status, icon: 'loading', spin: true };
    const isMain = !lead.rowId || lead.rowId === ROW_MAIN;
    return {
      text: isMain ? step : i18n.t('row.agentStatus', { name: F.formatAgentName(agent, i18n), status: step }),
      icon: 'loading', spin: true,
    };
  }
  return { text: status, icon: look.badgeIcon || '', spin: false };
}

/** A plan finished before the current turn started: it no longer says anything about this turn */
function stalePlan(done, total, ms, turn) {
  return total > 0 && done >= total && fin(ms) && !!turn && fin(turn.sinceMs) && ms < turn.sinceMs;
}

/**
 * The card's progress line, from the first source that has one: the main conversation's plan (unless it was finished in an
 * earlier turn), a running workflow with declared phases, a running workflow without them, subagents, or (while it works)
 * this turn's tool calls.
 * value / max feed a <progress> bar; null value = text only.
 * @returns {{ kind: string, text: string, value: number|null, max: number|null }|null}
 */
function progressSourceVm(s, L, i18n, now) {
  const main = s.main || {};
  const todo = main.todo;
  if (todo && todo.total > 0 && !stalePlan(todo.done, todo.total, todo.ms, main.turn)) {
    const done = Math.min(Math.max(0, todo.done || 0), todo.total);
    const key = s.provider === 'codex' ? 'webview.progress.planDone' : 'webview.progress.tasksDone';
    return { kind: 'todo', text: i18n.t(key, { done, total: todo.total }), value: done, max: todo.total };
  }
  const running = (s.workflows || []).filter((w) => w && w.state === 'running');
  const w = running[running.length - 1];
  if (w) {
    const fp = F.formatPhase(w, i18n);
    if (fp.count) {
      const done = (w.phaseStates || []).filter((p) => p && p.state === 'done').length;
      return { kind: 'phases', text: fp.phaseText + SEP + fp.agentsText, value: done, max: fp.count };
    }
    const f = F.formatWorkflow(w, i18n);
    const total = w.total || 0;
    return { kind: 'workflow', text: f.name + SEP + fp.agentsText, value: total > 0 ? Math.min(w.done || 0, total) : null, max: total > 0 ? total : null };
  }
  const subs = (s.agents || []).filter(Boolean);
  if (subs.length) {
    const done = subs.filter((a) => a.status && a.status.code === S.STATUS.DONE).length;
    return { kind: 'subagents', text: i18n.t('webview.progress.subagents', { done, total: subs.length }), value: done, max: subs.length };
  }
  const turn = main.turn;
  if (L.lamp === S.LAMP.WORKING && turn && fin(turn.sinceMs)) {
    return { kind: 'turn', text: i18n.t('webview.progress.turn', { ago: coarseAgo(i18n, turn.sinceMs, now), n: turn.tools || 0 }), value: null, max: null };
  }
  return null;
}

/**
 * One card. A finished or idle session that is not the expanded one is a single line: lamp, title, "Done · 5 min ago".
 * Nothing here changes every second (ago is coarse, statuses are the stable forms).
 * @param {any} s Session
 * @param {any} L sessionLamps
 * @param {{ now: number, showCost?: boolean, hints?: any, shownKey?: string|null, autoResume?: any }} o
 */
function cardVm(s, L, i18n, o) {
  const look = lampLib.lampVisual(L.lamp);
  const lampText = F.lampLabel(L.lamp, i18n);
  const expanded = s.key === o.shownKey;
  const compact = !expanded && QUIET_LAMPS.has(L.lamp);
  const ago = coarseAgo(i18n, fin(s.lastActivityMs) ? s.lastActivityMs : s.updatedMs, o.now);
  const ar = AV.autoResumeInfo(o.autoResume, s);
  const row = AV.sessionRowVm(s, L, i18n, o.now, o.hints, ar);
  const flags = flagsOf(row.contextValue);
  // The VS Code context menu reads data-vscode-context: the same session menu as the bottom panel's list
  const context = {
    webviewSection: 'session', sessionKey: s.key,
    compactable: flags.compactable, resumable: flags.resumable, handoff: flags.handoff, autoCompact: flags.autoCompact,
    bgResumable: flags.bgResumable, autoResumePending: flags.autoResumePending,
    preventDefaultContextMenuItems: true,
  };
  const cost = o.showCost !== false && !compact ? F.formatSessionCost(s, i18n).text : '';
  return {
    key: s.key,
    title: row.label,
    lamp: look.lamp,
    shape: look.shape,
    lampText,
    a11y: row.a11y,
    ago: compact ? [lampText, ago].filter(Boolean).join(SEP) : ago,
    cost,
    compact,
    expanded,
    now: compact ? null : nowVm(s, L, i18n, o.now),
    prog: compact ? null : progressSourceVm(s, L, i18n, o.now),
    tip: AV.sessionTipText(s, L, i18n, { now: o.now, showCost: o.showCost, hints: o.hints, autoResumeInfo: ar }),
    context: JSON.stringify(context),
  };
}

// ---------------------------------------------------------------------------
// Expanded card: plan, workflows, step stream
// ---------------------------------------------------------------------------

/**
 * The main conversation's plan (SessionDetail.agents[main].plan), in its own order: done items fold into "N completed", the
 * in-progress item shows its activeForm, at most 7 open items before "N more". A plan finished before the current turn
 * (turn = SessionDetail's) is not shown.
 */
function planVm(plan, i18n, turn) {
  if (!plan || !Array.isArray(plan.items) || !plan.items.length) return null;
  const items = plan.items.filter((x) => x && typeof x.text === 'string');
  if (!items.length) return null;
  const done = items.filter((x) => x.status === 'completed');
  if (stalePlan(done.length, items.length, plan.ms, turn)) return null;
  const open = items.filter((x) => x.status !== 'completed').map((x) => ({
    text: x.status === 'in_progress' && x.active ? String(x.active) : String(x.text),
    status: x.status === 'in_progress' ? 'in_progress' : 'pending',
  }));
  return {
    title: i18n.t(plan.source === 'plan' ? 'webview.progress.plan' : 'webview.progress.tasks'),
    progressText: i18n.t('plan.progress', { done: done.length, total: items.length }),
    value: done.length,
    max: items.length,
    doneText: done.length ? i18n.t('webview.progress.doneFold', { n: done.length }) : '',
    done: done.map((x) => ({ text: String(x.text), status: 'completed' })),
    shown: open.slice(0, PLAN_SHOWN),
    more: open.slice(PLAN_SHOWN),
    moreText: open.length > PLAN_SHOWN ? i18n.t('webview.progress.more', { n: open.length - PLAN_SHOWN }) : '',
  };
}

/**
 * A workflow's phase bar: one segment per declared phase (done / current / pending; the current one counts its agents
 * done / started), plus the one-line text the narrow layout shows instead. Without declared phases only the line.
 */
function phaseVm(w, i18n) {
  const f = F.formatWorkflow(w, i18n);
  const fp = F.formatPhase(w, i18n);
  const states = Array.isArray(w.phaseStates) && w.phaseStates.length ? w.phaseStates
    : (Array.isArray(w.phaseList) ? w.phaseList.map((title) => ({ title, state: 'pending', done: 0, started: 0 })) : []);
  const phases = states.map((p, i) => {
    const state = p.state === 'done' || p.state === 'current' ? p.state : 'pending';
    return {
      key: String(i),
      title: String(p.title || ''),
      state,
      count: state === 'current' ? `${p.done || 0}/${p.started || 0}` : '',
      stateText: i18n.t('webview.progress.phase.' + state),
    };
  });
  return {
    key: String(w.id),
    name: f.name,
    stateText: f.stateText,
    lineText: fp.phaseText ? fp.phaseText + SEP + fp.agentsText : fp.agentsText,
    phases,
  };
}

/** The nested line under an Agent block (its subagent) or a Workflow block (its run) */
function nestOf(ref, s, L, i18n, now) {
  if (!ref) return null;
  const sub = (s.agents || []).find((a) => a && a.parentRef === ref);
  if (sub) {
    const row = L.rows && L.rows.get(agentRowId(sub.id));
    const status = row && row.status ? row.status : sub.status;
    const lamp = row ? row.lamp : lampLib.agentLamp(sub);
    const look = lampLib.lampVisual(lamp);
    let text;
    if (lamp === S.LAMP.WORKING) {
      // formatStep already reads "Thinking", "Writing: …", "Read oauth.js" (as on the card's "now" line)
      text = F.formatStep(sub.step, status, i18n, now) || F.formatStatus(status, sub, i18n, now, { stable: true, isMain: false });
    } else if (status && status.code === S.STATUS.DONE) {
      text = i18n.t('webview.progress.childDone', { n: sub.toolCalls || 0 });
    } else {
      text = F.formatStatus(status, sub, i18n, now, { stable: true, isMain: false });
    }
    return { lamp: look.lamp, shape: look.shape, text };
  }
  const w = (s.workflows || []).find((x) => x && x.ref === ref);
  if (w) {
    const row = L.rows && L.rows.get(workflowRowId(w.id));
    const look = lampLib.lampVisual(row ? row.lamp : S.LAMP.IDLE);
    const fp = F.formatPhase(w, i18n);
    return { lamp: look.lamp, shape: look.shape, text: fp.phaseText ? fp.phaseText + SEP + fp.agentsText : fp.agentsText };
  }
  return null;
}

/**
 * Copilot records no result for any call, so a call's end is read from what follows it in its request (one turn's steps):
 * - anything after it (the next call, text, thinking) or the request's normal end: it returned, done;
 * - an interrupt, or a failed request (apiError, quota): stopped;
 * - the end of an earlier request (ended): stopped; only the last call of the request still in progress stays running.
 * Changes the blocks in place.
 */
function resultless(steps, i18n, ended) {
  const set = (b, st) => { b.state = st; b.tone = ''; b.stateText = i18n.t('webview.step.state.' + st); };
  let last = null; // the latest call with no result yet (running, or stopped by the request's end)
  const settle = (st) => { if (last && (last.state === 'running' || last.state === 'stopped')) set(last, st); last = null; };
  for (const x of steps) {
    if (x.block) {
      settle('done');
      if (x.state === 'running' || x.state === 'stopped') last = x;
      continue;
    }
    const k = kindOf(x);
    if (k === 'interrupt' || k === 'apiError' || k === 'quota') settle('stopped');
    else settle('done');
  }
  if (ended && last && last.state === 'running') set(last, 'stopped');
  return steps;
}

const STATE_RANK = ['running', 'error', 'stopped', 'done'];

/** Consecutive blocks → one group (a lone block stays a block); thinking is left out; other lines sit between groups */
function foldSteps(steps, i18n) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length === 1) out.push({ type: 'block', ...run[0] });
    else if (run.length) out.push(groupVm(run, i18n));
    run = [];
  };
  for (const x of steps) {
    if (x.block) { run.push(x); continue; }
    if (kindOf(x) === 'thinking') continue;
    flush();
    out.push({ type: 'line', ...x });
  }
  flush();
  return out;
}

/** "Ran 5 tools · 1 failed · now Running command" and "Reading ×3 · Searching ×2 · Editing ×1" */
function groupVm(run, i18n) {
  const has = (st) => run.some((b) => b.state === st);
  const state = STATE_RANK.find(has) || 'done';
  const errors = run.filter((b) => b.state === 'error').length;
  const stopped = run.filter((b) => b.state === 'stopped').length;
  const parts = [i18n.t('webview.progress.ranN', { n: run.length })];
  if (errors) parts.push(i18n.t('webview.progress.failedN', { n: errors }));
  if (stopped) parts.push(i18n.t('webview.progress.stoppedN', { n: stopped }));
  const cur = run.filter((b) => b.state === 'running').pop();
  if (cur) parts.push(i18n.t('webview.progress.nowStep', { step: cur.title }));
  const cats = new Map();
  for (const b of run) cats.set(b.title, (cats.get(b.title) || 0) + 1);
  const ranked = [...cats.entries()].map(([title, n], i) => ({ title, n, i })).sort((a, b) => (b.n - a.n) || (a.i - b.i));
  const catText = ranked.slice(0, CAT_MAX).map((c) => `${c.title} ×${c.n}`);
  if (ranked.length > CAT_MAX) catText.push(i18n.t('webview.progress.catsMore', { n: ranked.length - CAT_MAX }));
  return {
    type: 'group',
    key: 'g:' + run[0].key,
    state,
    stateText: i18n.t('webview.step.state.' + state),
    title: parts.join(SEP),
    cats: catText.join(SEP),
    current: state === 'running',
    defaultOpen: state === 'running',
    items: run,
  };
}

/**
 * The main conversation's steps as the side bar shows them (pure). The timeline is cut into turns at each prompt:
 * earlier turns fold to one line each ("Earlier turn · tool calls: 12 · 6m00s"); the current turn starts with the quoted
 * prompt, then its steps folded by foldSteps. When the turn's own prompt fell off the kept steps, a note says so (with the
 * number of this turn's calls that fell off when known). While the turn runs, its last group starts open.
 * Agent and Workflow blocks carry a nested line for the subagent / run they started (parentRef / Workflow.ref).
 * @param {any[]} timeline SessionDetail.agents[main].timeline
 * @param {any} s Session
 * @param {any} d SessionDetail.agents[main] (turn: dropped tools)
 * @param {any} i18n
 * @param {{ now: number, lamps?: any, running?: boolean, canOpen?: boolean }} o
 */
function progressVm(timeline, s, d, i18n, o) {
  const now = fin(o.now) ? o.now : Date.now();
  const I = coarseI18n(i18n);
  const L = o.lamps || lampLib.sessionLamps(s, { seenAtMs: 0 });
  const segs = [];
  let seg = null;
  for (const ev of timeline || []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.kind === 'prompt' || !seg) { seg = { prompt: ev.kind === 'prompt' ? ev : null, events: [] }; segs.push(seg); }
    if (ev.kind !== 'prompt') seg.events.push(ev);
  }
  const vmOf = (sg, ended) => {
    const steps = stepsVm(sg.events, I, { now }, !!o.canOpen);
    if (s.provider === 'copilot') resultless(steps, i18n, ended);
    for (const b of steps) {
      if (!b.block) continue;
      b.current = b.state === 'running';
      b.nest = nestOf(String(b.key).startsWith('r:') ? b.key.slice(2) : null, s, L, i18n, now);
    }
    return steps;
  };
  const quote = (ev) => ({
    type: 'quote', key: 'q:' + ev.ms,
    text: ev.detail ? i18n.t('webview.progress.you', { text: String(ev.detail) }) : F.formatTimelineEvent(ev, i18n),
    ago: coarseAgo(i18n, ev.ms, now),
  });
  const out = [];
  segs.forEach((sg, i) => {
    const steps = vmOf(sg, i < segs.length - 1);
    const items = foldSteps(steps, i18n);
    // A turn whose prompt fell off can lose the head of its first group: that group keeps one key ('g:head')
    if (i === 0 && !sg.prompt) {
      const g = items.find((x) => x.type === 'group');
      if (g) g.key = 'g:head';
    }
    if (i < segs.length - 1) {
      const first = sg.prompt || sg.events[0];
      const lastEv = sg.events.length ? sg.events[sg.events.length - 1] : first;
      const dur = first && lastEv && fin(first.ms) && fin(lastEv.ms) && lastEv.ms >= first.ms ? i18n.fmtDur(lastEv.ms - first.ms) : '';
      const n = steps.filter((x) => x.block).length;
      for (const x of items) if (x.type === 'group') x.defaultOpen = false;
      out.push({
        type: 'turn',
        key: 't:' + (sg.prompt ? 'prompt:' + sg.prompt.ms : 'head'),
        text: [i18n.t('webview.progress.prevTurn', { n }), dur].filter(Boolean).join(SEP),
        items: sg.prompt ? [quote(sg.prompt), ...items] : items,
      });
      return;
    }
    // The current turn
    const turn = d && d.turn;
    // A call whose own entry fell off but whose result is still kept is shown (from the result), so it is not counted
    const called = new Set(sg.events.filter((ev) => ev.kind === 'tool' && ev.ref).map((ev) => ev.ref));
    const shownAnyway = new Set(sg.events.filter((ev) => (ev.kind === 'toolDone' || ev.kind === 'toolError') && ev.ref && !called.has(ev.ref)).map((ev) => ev.ref));
    const dropped = turn && turn.dropped && turn.dropped.tools > 0 ? Math.max(0, turn.dropped.tools - shownAnyway.size) : 0;
    if (dropped) out.push({ type: 'note', key: 'n:earlier', icon: 'history', text: i18n.t('webview.progress.earlier', { n: dropped }) });
    else if (!sg.prompt && turn && fin(turn.sinceMs)) out.push({ type: 'note', key: 'n:lost', icon: 'history', text: i18n.t('webview.progress.lost') });
    if (sg.prompt) out.push(quote(sg.prompt));
    // While it works, the last group starts open; once the turn ended, groups start closed
    const groups = items.filter((x) => x.type === 'group');
    for (const g of groups) g.defaultOpen = g.current || (!!o.running && g === groups[groups.length - 1]);
    out.push(...items);
  });
  return out;
}

// ---------------------------------------------------------------------------
// The whole view
// ---------------------------------------------------------------------------

/**
 * Cards and the expanded part (pure).
 * @param {{
 *   arranged?: { groups: { id: string, sessions: any[] }[] }|null,  // createSessionOrder().arrange() (null = not loaded)
 *   lamps?: Map<string, any>, shownKey?: string|null, detail?: any|null, // snapshot.details[shownKey]
 *   i18n: any, now?: number, settings?: { showCost?: boolean, contextHintStart?: number, contextHintAct?: number },
 *   loaded?: boolean, emptyText?: string, autoResume?: any,
 * }} input
 * @returns {{ type: 'progress', v: 1, cards: any, expanded: any }}
 */
function buildProgress(input) {
  const i18n = input.i18n;
  const now = fin(input.now) ? input.now : Date.now();
  const st = input.settings || {};
  const lamps = input.lamps || new Map();
  const hints = { start: st.contextHintStart, act: st.contextHintAct };
  const sessions = [];
  for (const g of (input.arranged && input.arranged.groups) || []) {
    for (const s of g.sessions || []) if (s && typeof s.key === 'string') sessions.push(s);
  }
  const shown = sessions.find((s) => s.key === input.shownKey) || null;
  const o = { now, showCost: st.showCost !== false, hints, shownKey: shown ? shown.key : null, autoResume: input.autoResume || null };
  const lampsOf = (s) => lamps.get(s.key) || lampLib.sessionLamps(s);
  const loaded = input.loaded !== false;
  const cards = {
    type: 'cards', v: 1,
    loaded,
    emptyText: !loaded ? i18n.t('session.loading') : (sessions.length ? '' : String(input.emptyText || '')),
    shownKey: o.shownKey,
    items: sessions.map((s) => cardVm(s, lampsOf(s), i18n, o)),
  };
  const expanded = { type: 'expanded', v: 1, key: null, loading: false, canOpen: false, plan: null, workflows: [], stream: [] };
  if (shown) {
    const L = lampsOf(shown);
    const det = input.detail && (input.detail.key == null || input.detail.key === shown.key) ? input.detail : null;
    const main = shown.main || null;
    const d = main && det && det.agents ? det.agents[main.id] || null : null;
    expanded.key = shown.key;
    expanded.loading = !d;
    expanded.canOpen = !!AV.transcriptOf(shown);
    expanded.plan = d ? planVm(d.plan, i18n, d.turn) : null;
    expanded.workflows = (shown.workflows || []).filter((w) => w && (w.state === 'running' || w.state === 'paused'))
      .slice(-MAX_WORKFLOWS).map((w) => phaseVm(w, i18n));
    expanded.stream = d ? progressVm(d.timeline || [], shown, d, i18n, {
      now, lamps: L,
      running: !!(L.main && L.main.status && S.isRunningCode(L.main.status.code)),
      canOpen: !!main && isTranscriptFile(main.file),
    }) : [];
  }
  return { type: 'progress', v: 1, cards, expanded };
}

// ---------------------------------------------------------------------------
// WebviewViewProvider
// ---------------------------------------------------------------------------

class ProgressViewProvider {
  /**
   * @param {import('vscode').ExtensionContext} context
   * @param {{
   *   i18n: any, vscode?: any, log?: (msg: string) => void,
   *   onDidChangeVisibility?: (visible: boolean) => void,  // also called when the page folds or unfolds the expanded card
   *   onSelect?: (sessionKey: string) => void,             // a card was clicked (shared selection: extension userSelect)
   *   autoResume?: any,                                    // auto-resume provider: menu flags and tooltip line
   * }} opts
   */
  constructor(context, opts = {}) {
    this.vscode = opts.vscode || require('vscode');
    this.context = context;
    this.i18n = opts.i18n;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.onVisibility = typeof opts.onDidChangeVisibility === 'function' ? opts.onDidChangeVisibility : null;
    this.onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
    this.autoResume = opts.autoResume && typeof opts.autoResume === 'object' ? opts.autoResume : null;
    this.view = null;
    this.ready = false;
    this.input = null;
    this.listKeys = new Set();  // sessions on the cards last sent (only these keys are accepted from the page)
    this.closed = new Set();    // sessions whose expanded card the page has folded
    this.lastCardsJson = '';
    this.lastExpandedJson = '';
    this.disposables = [];
  }

  get visible() { return !!(this.view && this.view.visible); }

  /** The expanded card's session (the extension's shownKey while it is on the cards) */
  get shownKey() { return this.input && typeof this.input.shownKey === 'string' ? this.input.shownKey : null; }

  /** The view is on screen with this session's card open (seen-dwell, "looking at" for notifications) */
  lookingAt(key) {
    return this.visible && this.ready && typeof key === 'string' && key === this.shownKey && this.listKeys.has(key) && !this.closed.has(key);
  }

  resolveWebviewView(view) {
    const vscode = this.vscode;
    this.view = view;
    this.ready = false;
    this.lastCardsJson = '';
    this.lastExpandedJson = '';
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('base64');
    view.webview.html = progressHtml({
      cspSource: view.webview.cspSource,
      asset: (p) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, ...p.split('/'))).toString(),
      nonce,
      i18n: this.i18n,
    });
    this.disposables.push(
      view.webview.onDidReceiveMessage((m) => {
        try { this.onMessage(m); } catch (err) { this.log('progress view: ' + ((err && err.stack) || err)); }
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
   * Replace the data (every render). Same as buildProgress's input minus i18n, plus session (the shown Session).
   * @param {any} input
   */
  update(input) {
    this.input = input || null;
    this.post();
  }

  /** Force a resend */
  refresh() {
    this.lastCardsJson = '';
    this.lastExpandedJson = '';
    this.post();
  }

  post() {
    if (!this.view || !this.view.visible || !this.ready || !this.input) return;
    const r = buildProgress({ ...this.input, i18n: this.i18n, autoResume: this.autoResume });
    this.listKeys = new Set(r.cards.items.map((c) => c.key));
    const cj = JSON.stringify(r.cards);
    if (cj !== this.lastCardsJson) {
      this.lastCardsJson = cj;
      this.view.webview.postMessage(r.cards);
    }
    const ej = JSON.stringify(r.expanded);
    if (ej !== this.lastExpandedJson) {
      this.lastExpandedJson = ej;
      this.view.webview.postMessage(r.expanded);
    }
  }

  listed(key) { return typeof key === 'string' && this.listKeys.has(key); }

  /** The shown session, only when the page names it */
  shown(m) {
    const s = this.input && this.input.session;
    return s && m && typeof m.sessionKey === 'string' && m.sessionKey === s.key && m.sessionKey === this.shownKey ? s : null;
  }

  onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    const vscode = this.vscode;
    const run = (cmd, ...args) => Promise.resolve(vscode.commands.executeCommand(cmd, ...args)).catch((err) => this.log(cmd + ': ' + ((err && err.message) || err)));
    switch (m.type) {
      case 'ready':
        // The page remembers which expanded cards it folded (vscode.setState)
        this.closed = new Set(Array.isArray(m.closed) ? m.closed.filter((k) => typeof k === 'string').slice(-CLOSED_MAX) : []);
        this.ready = true;
        this.lastCardsJson = '';
        this.lastExpandedJson = '';
        this.post();
        if (this.onVisibility) this.onVisibility(this.visible);
        return;
      // A card head was clicked (or Enter / Space): select that session, shared with the bottom panel
      case 'select':
        if (!this.listed(m.sessionKey)) return;
        this.closed.delete(m.sessionKey);
        if (this.onSelect) this.onSelect(m.sessionKey);
        return;
      // The expanded card was folded or unfolded in the page (the selection does not change)
      case 'toggle':
        if (!this.listed(m.sessionKey) || m.sessionKey !== this.shownKey) return;
        if (m.open) this.closed.delete(m.sessionKey);
        else {
          this.closed.add(m.sessionKey);
          if (this.closed.size > CLOSED_MAX) this.closed.delete(this.closed.values().next().value);
        }
        if (this.onVisibility) this.onVisibility(this.visible);
        return;
      // A step block was opened: the same checks as the bottom panel (serveStep)
      case 'step': {
        const s = this.shown(m);
        const ref = typeof m.ref === 'string' ? m.ref : '';
        const read = s ? serveStep(s, this.input.detail, m.rowId, ref) : null;
        if (!read) return;
        const reply = (x) => { if (this.view) this.view.webview.postMessage({ type: 'step', sessionKey: s.key, rowId: m.rowId, ref, ...x }); };
        read.then(reply, (err) => { this.log('step: ' + err); reply({ found: false, failed: true }); });
        return;
      }
      // "Open transcript" under the expanded card: the command finds the file again from current data
      case 'openTranscript':
        if (this.listed(m.sessionKey)) run(OPEN_TRANSCRIPT_COMMAND, m.sessionKey);
        return;
      // "Open in panel": the panel shows the same selected session
      case 'show':
        run(SHOW_COMMAND);
        return;
      default:
    }
  }

  dispose() {
    for (const d of this.disposables.splice(0)) { try { d.dispose(); } catch { /* ignore */ } }
    this.view = null;
    this.ready = false;
  }
}

module.exports = {
  VIEW_ID, ProgressViewProvider, buildProgress,
  cardVm, progressSourceVm, planVm, phaseVm, progressVm,
  _internal: { coarseAgo, foldSteps, groupVm, nestOf, resultless, kindOf, nowVm },
};
