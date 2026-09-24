'use strict';
// 状态灯（DESIGN §3.2–§3.4、§11.1）：结合“已看过”和 Claude 在线登记表，算每个智能体、会话、总灯。
// 规则：
// - 登记表的确定信号优先于推测：waiting → NeedsYou（等你批准 / 等你回答 / 有对话框），busy → Working；
//   会话有登记信号时，“可能在等你批准”的推测一律不算 NeedsYou。
// - 会话灯按推导优先级 NeedsYou > Error > Working > DoneUnseen > DoneSeen > Idle 取最高；
//   子智能体 / 工作流智能体早于 seenAtMs 的 Error 不上浮（主智能体的始终参与）；
//   只剩完成的智能体时看主智能体的 doneAtMs 与 seenAtMs。
// - 总灯按显示紧急度 NeedsYou > Error > DoneUnseen > Working > DoneSeen > Idle。
// 纯函数，不依赖 vscode；扩展、终端版共用。

const S = require('./core/status');
const { ROW_MAIN, agentRowId, workflowRowId, workflowAgentRowId } = require('./order');

const { LAMP, STATUS } = S;
const DONE_LAMPS = new Set([LAMP.DONE_UNSEEN, LAMP.DONE_SEEN]);

/**
 * seen 参数统一成 (sessionKey) => seenAtMs。
 * 可以传：数字（所有会话同一个值）、函数、带 get(key) 的对象（seen.js 的 store）。
 */
function seenLookup(seen) {
  if (typeof seen === 'function') return (k) => Number(seen(k)) || 0;
  if (seen && typeof seen.get === 'function') return (k) => Number(seen.get(k)) || 0;
  const n = Number(seen) || 0;
  return () => n;
}

/**
 * 会话的登记表信号（§11.1）：'busy' | 'waiting' | 'idle' | null。
 * 登记表只有 Claude 有；live === false（进程已退出）时不算。
 */
function registrySignal(session) {
  if (!session || session.provider !== 'claude' || session.live === false) return null;
  const v = session.liveStatus;
  return v === S.LIVE_STATUS.BUSY || v === S.LIVE_STATUS.WAITING || v === S.LIVE_STATUS.IDLE ? v : null;
}

/**
 * 单个智能体的灯（§3.2 + §3.4）。
 * @param {{ status: import('./core/status').AgentStatus|null }} agent
 * @param {{ seenAtMs?: number, isMain?: boolean, doneAtMs?: number|null, staleAsNeedsYou?: boolean }} [o]
 *   主智能体的 done 用 doneAtMs（会话的 doneAtMs）与 seenAtMs 比，其余用 status.sinceMs。
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

// busy 时把主智能体改写成“在跑”：有未完成的工具就是 tool，否则 thinking
function busyStatus(st) {
  const tool = st && st.pendingTool;
  return S.makeStatus(tool ? STATUS.TOOL : STATUS.THINKING, st ? st.sinceMs : 0, { pendingTool: tool || null });
}

/**
 * 主智能体按登记表修正后的状态与灯。
 * - waiting → 登记表给的确定状态（NeedsYou）；
 * - busy → Error 保留，其余一律 Working（即使记录暂时没有新行、原先判成 stale / done / 推测）；
 * - idle → 进程在等下一个提示：NeedsYou（推测或过时的确定状态）改判 interrupted（Idle），其余照记录。
 * @returns {{ status: any, lamp: string }}
 */
function mainWithRegistry(session, lamp, reg) {
  const st = session.main && session.main.status;
  if (reg === S.LIVE_STATUS.WAITING) {
    const waitingFor = session.waitingFor || null;
    // provider 已按登记表写好（或记录里就是同一种等待，如 AskUserQuestion）→ 保留原状态（带 question、进入时间）
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
 * 一个会话的全部灯。
 * @param {any} session Session
 * @param {{ seen?: number|Function|{ get: Function }, seenAtMs?: number, staleAsNeedsYou?: boolean }} [o]
 * @returns {{
 *   key: string, lamp: string, seenAtMs: number, registry: 'busy'|'waiting'|'idle'|null,
 *   main: { lamp: string, status: any },
 *   rows: Map<string, { lamp: string, status: any|null }>,
 *   lead: { rowId: string, agent: any|null, status: any|null, lamp: string }
 * }}
 *   rows 的键与 order.js 的行 id 一致：'main'、'a/<id>'、'wf/<id>'、'wf/<id>/<agentId>'；status 是修正后的（右侧直接用）。
 *   lead：决定会话灯的那一行（主智能体优先），左侧一句话状态用它。
 */
function sessionLamps(session, o = {}) {
  const key = session && session.key;
  const seenAtMs = o.seenAtMs != null ? Number(o.seenAtMs) || 0 : seenLookup(o.seen)(key);
  const stale = !!o.staleAsNeedsYou;
  const reg = registrySignal(session);
  const rows = new Map();
  const contrib = []; // { rowId, agent, status, lamp }

  // 主智能体
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

  // 子智能体、工作流智能体
  const sub = (rowId, a) => {
    let st = a.status || null;
    let lamp = agentLamp(a, { seenAtMs, staleAsNeedsYou: stale });
    // 会话有登记信号：子智能体的推测不算（真在等批准时登记表会是 waiting），按“工具在跑”显示
    if (reg && st && S.isGuessCode(st.code)) {
      st = busyStatus(st);
      lamp = LAMP.WORKING;
    }
    rows.set(rowId, { lamp, status: st });
    // 例外 1：已看过之前的子智能体报错不上浮
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

  // 会话灯
  let lamp;
  const urgent = contrib.some((c) => c.lamp === LAMP.NEEDS_YOU || c.lamp === LAMP.ERROR || c.lamp === LAMP.WORKING);
  if (!urgent && DONE_LAMPS.has(mainLamp)) lamp = mainLamp; // 例外 2：只剩完成的，看主智能体
  else lamp = S.pickDerived(contrib.map((c) => c.lamp));

  let lead = contrib.find((c) => c.lamp === lamp) || null;
  if (!lead) lead = { rowId: ROW_MAIN, agent: main || null, status: mainStatus, lamp: mainLamp };
  return { key, lamp, seenAtMs, registry: reg, main: { lamp: mainLamp, status: mainStatus }, rows, lead };
}

/** 空的计数 */
function emptyCounts() {
  return { needsYou: 0, error: 0, working: 0, doneUnseen: 0, doneSeen: 0, idle: 0 };
}

/** 各灯的会话数 */
function countLamps(lamps) {
  const c = emptyCounts();
  for (const l of lamps || []) if (l in c) c[l]++;
  return c;
}

/** 需要你看的会话数（视图徽标，§8.2）：NeedsYou + Error + DoneUnseen */
function attentionCount(counts) {
  return (counts.needsYou || 0) + (counts.error || 0) + (counts.doneUnseen || 0);
}

/**
 * 一份快照（当前查看范围内的会话）的全部灯。
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

/** 总灯（状态栏）：按显示紧急度取最高 */
function overallLamp(lamps) { return S.pickSevere(lamps); }

/**
 * 灯的外观：颜色 id（树 ThemeColor）、CSS 变量（webview）、codicon 形状、说明前的图标、终端 256 色号。
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
 * 终端版的灯：实心 ● / 空心 ○，color 为 false 时不加 ANSI 颜色（管道、NO_COLOR）。
 * @param {string} lamp
 * @param {{ color?: boolean }} [o]
 */
function xtermDot(lamp, o = {}) {
  const v = lampVisual(lamp);
  const dot = v.shape === 'circle-large-outline' ? '○' : '●';
  return o.color === false ? dot : `\x1b[38;5;${v.xterm}m${dot}\x1b[0m`;
}

module.exports = {
  seenLookup, registrySignal, agentLamp, sessionLamps, computeLamps,
  emptyCounts, countLamps, attentionCount, overallLamp, lampVisual, xtermDot,
};
