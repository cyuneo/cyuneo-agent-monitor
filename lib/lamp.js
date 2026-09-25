'use strict';
// Status lamps: combines "seen" state with Claude's live session registry to compute the lamp for each agent,
// each session, and the overall lamp.
// Rules:
// - Definite registry signals beat guesses: waiting -> NeedsYou (awaiting your approval / answer / a dialog is open),
//   busy -> Working; when a session has a registry signal, a "may be waiting for your approval" guess never counts as NeedsYou.
// - Session lamp = highest by derivation priority NeedsYou > Error > Working > DoneUnseen > DoneSeen > Idle;
//   Errors from subagents / workflow agents older than seenAtMs do not bubble up (the main agent always counts);
//   when only finished agents remain, the main agent's doneAtMs is compared with seenAtMs.
// - Overall lamp = highest by display urgency NeedsYou > Error > DoneUnseen > Working > DoneSeen > Idle.
// - Every provider feeds the same lamps. Guessed statuses (certainty 'guess': Codex / Claude "may be waiting for
//   approval") get exactly the lamp of the same certain status, never a stronger one. The UI marks guesses in the text
//   (format.js), not here.
// - Only Claude has a process registry. Copilot also fills liveStatus, but derives it from the same status,
//   so it is not an independent signal and is ignored here.
// Pure functions with no vscode dependency; shared by the extension and the terminal version.

const S = require('./core/status');
const { ROW_MAIN, agentRowId, workflowRowId, workflowAgentRowId } = require('./order');

const { LAMP, STATUS } = S;
const DONE_LAMPS = new Set([LAMP.DONE_UNSEEN, LAMP.DONE_SEEN]);

/**
 * Normalizes the seen argument to (sessionKey) => seenAtMs.
 * Accepts: a number (same value for every session), a function, or an object with get(key) (the store from seen.js).
 */
function seenLookup(seen) {
  if (typeof seen === 'function') return (k) => Number(seen(k)) || 0;
  if (seen && typeof seen.get === 'function') return (k) => Number(seen.get(k)) || 0;
  const n = Number(seen) || 0;
  return () => n;
}

/**
 * Whether a status is a guess rather than something the tool recorded: the guessed approval wait, or any status the
 * provider tagged certainty 'guess'.
 * @param {import('./core/status').AgentStatus|null|undefined} status
 */
function isGuessStatus(status) {
  return !!status && (S.isGuessCode(status.code) || status.certainty === 'guess');
}

/**
 * A session's registry signal: 'busy' | 'waiting' | 'idle' | null.
 * Only Claude has a registry; ignored when live === false (the process has exited).
 */
function registrySignal(session) {
  if (!session || session.provider !== 'claude' || session.live === false) return null;
  const v = session.liveStatus;
  return v === S.LIVE_STATUS.BUSY || v === S.LIVE_STATUS.WAITING || v === S.LIVE_STATUS.IDLE ? v : null;
}

/**
 * Lamp for a single agent.
 * @param {{ status: import('./core/status').AgentStatus|null }} agent
 * @param {{ seenAtMs?: number, isMain?: boolean, doneAtMs?: number|null, staleAsNeedsYou?: boolean }} [o]
 *   For the main agent, done is judged by comparing doneAtMs (the session's doneAtMs) with seenAtMs; others use status.sinceMs.
 */
function agentLamp(agent, o = {}) {
  const st = agent && agent.status;
  if (!st || !st.code) return LAMP.IDLE;
  let seen = false;
  if (st.code === STATUS.DONE) {
    const seenAt = Number(o.seenAtMs) || 0;
    const doneAt = o.isMain && Number.isFinite(o.doneAtMs) ? o.doneAtMs : st.sinceMs;
    seen = seenAt > 0 && Number.isFinite(doneAt) && doneAt <= seenAt;
  }
  return S.lampForStatus(st, { seen, staleAsNeedsYou: !!o.staleAsNeedsYou });
}

// When busy, rewrite the main agent as running: tool if a tool call is pending, otherwise thinking
function busyStatus(st) {
  const tool = st && st.pendingTool;
  return S.makeStatus(tool ? STATUS.TOOL : STATUS.THINKING, st ? st.sinceMs : 0, { pendingTool: tool || null });
}

/**
 * The main agent's status and lamp, corrected by the registry.
 * - waiting -> the definite status given by the registry (NeedsYou);
 * - busy -> Error is kept, everything else becomes Working (even if the transcript has no new lines yet and was
 *   judged stale / done / a guess);
 * - idle -> the process is waiting for the next prompt: NeedsYou (a guess or an outdated definite status) is
 *   downgraded to interrupted (Idle); otherwise the transcript is followed.
 * @returns {{ status: any, lamp: string }}
 */
function mainWithRegistry(session, lamp, reg) {
  const st = session.main && session.main.status;
  if (reg === S.LIVE_STATUS.WAITING) {
    const waitingFor = session.waitingFor || null;
    // The provider already applied the registry (or the transcript shows the same kind of wait, e.g. AskUserQuestion) -> keep the original status (with its question and start time)
    if (st && st.code === S.codeForWaitingFor(waitingFor)) {
      return { status: { ...st, certainty: 'certain', waitingFor: st.waitingFor || waitingFor }, lamp: LAMP.NEEDS_YOU };
    }
    const since = Number(session.liveSinceMs) || (st ? st.sinceMs : 0);
    const rs = S.statusFromRegistry({ status: 'waiting', waitingFor }, since);
    return { status: rs, lamp: LAMP.NEEDS_YOU };
  }
  if (reg === S.LIVE_STATUS.BUSY) {
    if (lamp === LAMP.ERROR || lamp === LAMP.WORKING) return { status: st, lamp };
    return { status: busyStatus(st), lamp: LAMP.WORKING };
  }
  if (reg === S.LIVE_STATUS.IDLE && lamp === LAMP.NEEDS_YOU) {
    return { status: S.makeStatus(STATUS.INTERRUPTED, st ? st.sinceMs : 0), lamp: LAMP.IDLE };
  }
  return { status: st, lamp };
}

/**
 * All lamps for one session.
 * @param {any} session Session
 * @param {{ seen?: number|Function|{ get: Function }, seenAtMs?: number, staleAsNeedsYou?: boolean }} [o]
 * @returns {{
 *   key: string, lamp: string, seenAtMs: number, registry: 'busy'|'waiting'|'idle'|null,
 *   main: { lamp: string, status: any },
 *   rows: Map<string, { lamp: string, status: any|null }>,
 *   lead: { rowId: string, agent: any|null, status: any|null, lamp: string }
 * }}
 *   rows keys match the row ids in order.js: 'main', 'a/<id>', 'wf/<id>', 'wf/<id>/<agentId>'; status is the corrected one (used directly by the right-hand view).
 *   lead: the row that determines the session lamp (main agent preferred); used for the one-line status on the left.
 */
function sessionLamps(session, o = {}) {
  const key = session && session.key;
  const seenAtMs = o.seenAtMs != null ? Number(o.seenAtMs) || 0 : seenLookup(o.seen)(key);
  const stale = !!o.staleAsNeedsYou;
  const reg = registrySignal(session);
  const rows = new Map();
  const contrib = []; // { rowId, agent, status, lamp }

  // Main agent
  const main = session && session.main;
  let mainLamp = agentLamp(main, { seenAtMs, isMain: true, doneAtMs: session && session.doneAtMs, staleAsNeedsYou: stale });
  let mainStatus = main ? main.status : null;
  if (reg && main) {
    const r = mainWithRegistry(session, mainLamp, reg);
    mainLamp = r.lamp;
    mainStatus = r.status;
  }
  rows.set(ROW_MAIN, { lamp: mainLamp, status: mainStatus });
  if (main) contrib.push({ rowId: ROW_MAIN, agent: main, status: mainStatus, lamp: mainLamp });

  // Subagents and workflow agents
  const sub = (rowId, a) => {
    let st = a.status || null;
    let lamp = agentLamp(a, { seenAtMs, staleAsNeedsYou: stale });
    // The session has a registry signal: ignore subagent guesses (a real approval wait would show as waiting in the registry); show as tool running
    if (reg && st && S.isGuessCode(st.code)) {
      st = busyStatus(st);
      lamp = LAMP.WORKING;
    }
    rows.set(rowId, { lamp, status: st });
    // Exception 1: subagent errors from before the last seen time do not bubble up
    const oldError = lamp === LAMP.ERROR && seenAtMs > 0 && st && Number.isFinite(st.sinceMs) && st.sinceMs <= seenAtMs;
    if (!oldError) contrib.push({ rowId, agent: a, status: st, lamp });
    return lamp;
  };
  for (const a of (session && session.agents) || []) if (a && a.id != null) sub(agentRowId(a.id), a);
  for (const w of (session && session.workflows) || []) {
    if (!w || w.id == null) continue;
    const lamps = [];
    for (const a of w.agents || []) if (a && a.id != null) lamps.push(sub(workflowAgentRowId(w.id, a.id), a));
    let wl;
    if (lamps.length) wl = S.pickDerived(lamps);
    else wl = w.state === 'running' ? LAMP.WORKING : w.state === 'completed' ? LAMP.DONE_SEEN : LAMP.IDLE;
    rows.set(workflowRowId(w.id), { lamp: wl, status: null });
  }

  // Session lamp
  let lamp;
  const urgent = contrib.some((c) => c.lamp === LAMP.NEEDS_YOU || c.lamp === LAMP.ERROR || c.lamp === LAMP.WORKING);
  if (!urgent && DONE_LAMPS.has(mainLamp)) lamp = mainLamp; // Exception 2: only finished agents left, so use the main agent
  else lamp = S.pickDerived(contrib.map((c) => c.lamp));

  let lead = contrib.find((c) => c.lamp === lamp) || null;
  if (!lead) lead = { rowId: ROW_MAIN, agent: main || null, status: mainStatus, lamp: mainLamp };
  return { key, lamp, seenAtMs, registry: reg, main: { lamp: mainLamp, status: mainStatus }, rows, lead };
}

/** Empty counts */
function emptyCounts() {
  return { needsYou: 0, error: 0, working: 0, doneUnseen: 0, doneSeen: 0, idle: 0 };
}

/** Number of sessions per lamp */
function countLamps(lamps) {
  const c = emptyCounts();
  for (const l of lamps || []) if (l in c) c[l]++;
  return c;
}

/** Number of sessions needing your attention (the view badge): NeedsYou + Error + DoneUnseen */
function attentionCount(counts) {
  return (counts.needsYou || 0) + (counts.error || 0) + (counts.doneUnseen || 0);
}

/**
 * All lamps for one snapshot (the sessions in the current viewing scope).
 * @param {any[]} sessions
 * @param {{ seen?: any, staleAsNeedsYou?: boolean }} [o]
 * @returns {{ bySession: Map<string, ReturnType<typeof sessionLamps>>, overall: string, counts: ReturnType<typeof emptyCounts>, attention: number }}
 */
function computeLamps(sessions, o = {}) {
  const seenOf = seenLookup(o.seen);
  const bySession = new Map();
  const lamps = [];
  for (const s of sessions || []) {
    if (!s || typeof s.key !== 'string') continue;
    const r = sessionLamps(s, { seenAtMs: seenOf(s.key), staleAsNeedsYou: o.staleAsNeedsYou });
    bySession.set(s.key, r);
    lamps.push(r.lamp);
  }
  const counts = countLamps(lamps);
  return { bySession, overall: S.pickSevere(lamps), counts, attention: attentionCount(counts) };
}

/** Overall lamp (status bar): highest by display urgency */
function overallLamp(lamps) { return S.pickSevere(lamps); }

/**
 * Lamp appearance: color id (tree ThemeColor), CSS variable (webview), codicon shape, icon before the description, and xterm 256-color index.
 * @param {string} lamp
 */
function lampVisual(lamp) {
  const l = lamp in S.LAMP_COLOR_ID ? lamp : LAMP.IDLE;
  return {
    lamp: l,
    colorId: S.LAMP_COLOR_ID[l],
    cssVar: S.LAMP_CSS_VAR[l],
    cssClass: 'lamp-' + l,
    shape: S.LAMP_SHAPE[l],
    badgeIcon: S.LAMP_BADGE_ICON[l] || null,
    xterm: S.LAMP_XTERM[l],
  };
}

/**
 * Terminal lamp: filled ● / hollow ○; no ANSI color when color is false (pipes, NO_COLOR).
 * @param {string} lamp
 * @param {{ color?: boolean }} [o]
 */
function xtermDot(lamp, o = {}) {
  const v = lampVisual(lamp);
  const dot = v.shape === 'circle-large-outline' ? '○' : '●';
  return o.color === false ? dot : `\x1b[38;5;${v.xterm}m${dot}\x1b[0m`;
}

module.exports = {
  seenLookup, isGuessStatus, registrySignal, agentLamp, sessionLamps, computeLamps,
  emptyCounts, countLamps, attentionCount, overallLamp, lampVisual, xtermDot,
};
