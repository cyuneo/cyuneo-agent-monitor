'use strict';
// Scans transcript files on a separate thread, so the first parse of a
// main transcript of tens of MB does not block VS Code's extension host (the
// Claude Code extension runs in that same process).
// Message protocol:
//   workerData: the WorkerConfig (see lib/monitor.js normalizeConfig); with paused: true the worker starts paused (no scan until resume);
//               cfgGen: a number echoed in every snapshot (see config)
//   extension -> worker:
//     { type: 'config', cfg, gen? }  rebuild providers; if only observedCompact changed, swap the table without rebuilding.
//                                    gen (optional) replaces cfgGen, so the extension can tell which snapshots use the new cfg
//                                    (paused: just remember cfg, and drop a Monitor built for storage if providers would change)
//     { type: 'focus', keys }        sessions to include details for (details carry storage: per-session disk usage, computed at most once per 60 s)
//     { type: 'refresh' }            scan immediately (ignored while paused)
//     { type: 'storage', force? }    storage locations and usage; without force, a cached result under 10 minutes old is returned.
//                                    Also answered while paused (a Monitor is built for it, but nothing is scanned until resume)
//     { type: 'pause' }              stop scanning and dispose the Monitor to free memory (another window scans for this one)
//     { type: 'resume' }             scan immediately, then keep scanning every interval
//     { type: 'interval', ms }       scan every ms instead of cfg.intervalMs, without rebuilding providers; the next scan is due
//                                    ms after the last one (at once if that is past). ms null / 0 / invalid: back to cfg.intervalMs.
//                                    The override survives later config messages.
//   worker -> extension:
//     { type: 'snapshot', v: 2, now, sessions, quota, today, details, sources, cfgGen }
//     { type: 'storage', ...StorageReport }  (also sent, with error, on failure or when lib/storage.js is unavailable)
//     { type: 'error', source, message }

const { parentPort, workerData } = require('worker_threads');
const { Monitor, normalizeConfig, sameExceptObserved } = require('./monitor');

const ERROR_REPEAT_MS = 60e3; // report the same error at most once per 60 s
const SOON_MS = 50;           // delay before sending another snapshot once an async result arrives

let cfg = normalizeConfig(workerData || {});
let mon = null;
let focus = [];
let timer = null;
let soonTimer = null;
let paused = !!(workerData && workerData.paused === true);
let intervalOverride = null; // ms from an 'interval' message; null = cfg.intervalMs
let cfgGen = Number.isFinite(workerData && workerData.cfgGen) ? workerData.cfgGen : 0;
let lastTickAt = 0;          // when the last scan finished
const reported = new Map(); // error text -> last time it was reported

function errText(err) {
  return String((err && err.stack) || err);
}

function post(msg) {
  if (parentPort) parentPort.postMessage(msg);
}

function report(source, message) {
  const k = source + '\n' + message;
  const now = Date.now();
  const last = reported.get(k);
  if (last && now - last < ERROR_REPEAT_MS) return;
  reported.set(k, now);
  post({ type: 'error', source, message });
}

function dispose() {
  if (mon) {
    try { mon.dispose(); } catch { /* ignore */ }
  }
  mon = null;
}

function build() {
  dispose();
  mon = new Monitor(cfg);
  mon.setFocus(focus);
  mon.onChange = soon;
}

function intervalMs() {
  return intervalOverride || cfg.intervalMs;
}

// Schedule the next scan intervalMs after the last one finished (at once if that is already past)
function schedule() {
  clearTimeout(timer);
  timer = null;
  if (paused) return;
  timer = setTimeout(tick, Math.max(0, lastTickAt + intervalMs() - Date.now()));
}

// A per-session storage size finished computing: send a fresh snapshot soon (coalescing bursts)
function soon() {
  if (soonTimer || paused) return;
  soonTimer = setTimeout(() => { soonTimer = null; tick(); }, SOON_MS);
}

function pause() {
  paused = true;
  clearTimeout(timer);
  clearTimeout(soonTimer);
  timer = null;
  soonTimer = null;
  dispose(); // a storage scan in flight still resolves and posts its result
}

function storage(force) {
  const at = Date.now();
  try {
    if (!mon) build();
    mon.storageReport({ force: !!force }).then(
      (r) => post({ type: 'storage', ...r }),
      (err) => post({ type: 'storage', at, claude: null, codex: null, volumes: [], cleanupPeriodDays: null, error: errText(err) }),
    );
  } catch (err) {
    report('storage', errText(err));
    post({ type: 'storage', at, claude: null, codex: null, volumes: [], cleanupPeriodDays: null, error: errText(err) });
  }
}

function tick() {
  clearTimeout(timer);
  timer = null;
  if (paused) return;
  try {
    if (!mon) build();
    const snap = mon.snapshot(Date.now());
    post({ type: 'snapshot', ...snap, cfgGen });
    for (const [source, message] of mon.takeErrors()) report(source, message);
  } catch (err) {
    report('worker', errText(err));
  }
  lastTickAt = Date.now();
  schedule();
}

if (parentPort) {
  parentPort.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    try {
      if (m.type === 'config') {
        if (Number.isFinite(m.gen)) cfgGen = m.gen;
        const next = normalizeConfig(m.cfg || {});
        if (mon && sameExceptObserved(cfg, next)) {
          // Only the observed compaction-point table changed: swap it without re-reading all transcripts
          cfg = next;
          mon.setObservedCompact(next.observedCompact);
        } else {
          cfg = next;
          if (paused) dispose(); // built again on the next storage request or resume
          else build();
        }
        tick();
      } else if (m.type === 'storage') {
        storage(m.force === true);
      } else if (m.type === 'focus') {
        focus = Array.isArray(m.keys) ? m.keys.filter((k) => typeof k === 'string' && k) : [];
        if (mon) mon.setFocus(focus);
        tick(); // selected sessions changed: send their details right away
      } else if (m.type === 'refresh') {
        tick();
      } else if (m.type === 'pause') {
        pause();
      } else if (m.type === 'resume') {
        paused = false;
        tick();
      } else if (m.type === 'interval') {
        intervalOverride = Number.isFinite(m.ms) && m.ms > 0 ? m.ms : null;
        if (!paused && lastTickAt) schedule();
      }
    } catch (err) {
      report('worker', errText(err));
    }
  });
  if (!paused) {
    try { build(); } catch (err) { report('worker', errText(err)); }
    tick();
  }
}
