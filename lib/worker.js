'use strict';
// 在独立线程里扫描记录文件：第一次解析几十 MB 的主记录时，
// 不会卡住 VS Code 的扩展进程（Claude Code 扩展也在那个进程里）。
// 消息协议（DESIGN §1.4、§11.12.3）：
//   扩展 → worker：
//     { type: 'config', cfg }        重建 provider；只有 observedCompact 变了时不重建，直接换表
//     { type: 'focus', keys }        附带细节的会话（细节里带 storage：单个会话的存储占用，60 秒最多统计一次）
//     { type: 'refresh' }            立即扫一次
//     { type: 'storage', force? }    存储位置与占用；没有 force 时 10 分钟内返回缓存
//   worker → 扩展：
//     { type: 'snapshot', v: 2, now, sessions, quota, today, details, sources }
//     { type: 'storage', ...StorageReport }（出错 / lib/storage.js 不可用时也回，带 error）
//     { type: 'error', source, message }

const { parentPort, workerData } = require('worker_threads');
const { Monitor, normalizeConfig, sameExceptObserved } = require('./monitor');

const ERROR_REPEAT_MS = 60e3; // 同一条出错信息 60 秒内只报一次
const SOON_MS = 50;           // 异步结果到了之后，多久再发一份快照

let cfg = normalizeConfig(workerData || {});
let mon = null;
let focus = [];
let timer = null;
let soonTimer = null;
const reported = new Map(); // 出错信息 → 上次报告时间

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
    try { mon.dispose(); } catch { /* 忽略 */ }
  }
  mon = new Monitor(cfg);
  mon.setFocus(focus);
  mon.onChange = soon;
}

// 单个会话的存储占用算完了：尽快再发一份快照（合并同一时刻的多次）
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
          // 只是实测压缩点表变了（§11.12.2）：换表，不重读全部记录
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
        tick(); // 选中会话变了：尽快把细节送过去
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
