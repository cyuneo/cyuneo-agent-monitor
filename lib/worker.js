'use strict';
// Scans transcript files on a separate thread, so the first parse of a
// main transcript of tens of MB does not block VS Code's extension host (the
// Claude Code extension runs in that same process).
// Message protocol:
//   extension -> worker:
//     { type: 'config', cfg }        rebuild providers; if only observedCompact changed, swap the table without rebuilding
//     { type: 'focus', keys }        sessions to include details for (details carry storage: per-session disk usage, computed at most once per 60 s)
//     { type: 'refresh' }            scan immediately
//     { type: 'storage', force? }    storage locations and usage; without force, a cached result under 10 minutes old is returned
//   worker -> extension:
//     { type: 'snapshot', v: 2, now, sessions, quota, today, details, sources }
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

function build() {
  if (mon) {
    try { mon.dispose(); } catch { /* ignore */ }
  }
  mon = new Monitor(cfg);
  mon.setFocus(focus);
  mon.onChange = soon;
}

// A per-session storage size finished computing: send a fresh snapshot soon (coalescing bursts)
function soon() {
  if (soonTimer) return;
  soonTimer = setTimeout(() => { soonTimer = null; tick(); }, SOON_MS);
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
  try {
    if (!mon) build();
    const snap = mon.snapshot(Date.now());
    post({ type: 'snapshot', ...snap });
    for (const [source, message] of mon.takeErrors()) report(source, message);
  } catch (err) {
    report('worker', errText(err));
  }
  timer = setTimeout(tick, cfg.intervalMs);
}

if (parentPort) {
  parentPort.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    try {
      if (m.type === 'config') {
        const next = normalizeConfig(m.cfg || {});
        if (mon && sameExceptObserved(cfg, next)) {
          // Only the observed compaction-point table changed: swap it without re-reading all transcripts
          cfg = next;
          mon.setObservedCompact(next.observedCompact);
        } else {
          cfg = next;
          build();
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
      }
    } catch (err) {
      report('worker', errText(err));
    }
  });
  try { build(); } catch (err) { report('worker', errText(err)); }
  tick();
}
