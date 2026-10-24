'use strict';
// Account switcher (optional): reads the local claude-swap (`cswap`) state so a chat stopped on a usage limit can be
// resumed once cswap has moved to an account with room, instead of waiting for the limit to reset. Read-only: runs
// `cswap policy list --json` (no shell, 10 s at most), which reads local files only. Without cswap on PATH (or in
// ~/.local/bin) the reader answers null and nothing changes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const RUN_TIMEOUT_MS = 10e3;
const OUTPUT_MAX = 4 * 1024 * 1024;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

function isRunnable(p, platform, fsImpl) {
  try {
    const st = fsImpl.statSync(p);
    if (!st.isFile()) return false;
    if (platform === 'win32') return true;
    fsImpl.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * cswap on PATH (absolute directories only), then ~/.local/bin/cswap (where uv tool installs it; VS Code's PATH often
 * lacks it). Not found → null.
 * @param {{ env?: Record<string, string|undefined>, platform?: string, fs?: any, home?: string }} o
 */
function findCswap(o = {}) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const fsImpl = o.fs || fs;
  const win = platform === 'win32';
  const name = win ? 'cswap.exe' : 'cswap';
  const dirs = String(env.PATH || env.Path || env.path || '')
    .split(win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => d && path.isAbsolute(d));
  const home = o.home || env.HOME || env.USERPROFILE || os.homedir();
  if (home) dirs.push(path.join(home, '.local', 'bin'));
  for (const dir of dirs) {
    const p = path.join(dir, name);
    if (isRunnable(p, platform, fsImpl)) return p;
  }
  return null;
}

const under = (used, max) => !fin(used) || used < (fin(max) ? max : 100);

/**
 * `cswap policy list --json` → AccountInfo (lib/core/autoresume.js): the time of cswap's last switch, when it switched
 * to the account in use now, and whether that account has room (enabled, no login error, below its own 5h and 7d
 * limits). Anything unexpected → null.
 * @param {any} j parsed JSON
 * @returns {{ switchedAtMs: number|null, hasRoom: boolean, label: string }|null}
 */
function parseCswap(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.accounts)) return null;
  const active = j.accounts.find((r) => r && typeof r === 'object' && r.active === true);
  if (!active) return null;
  const number = String(active.number == null ? '' : active.number);
  const last = j.autoswitch && typeof j.autoswitch === 'object' ? j.autoswitch.lastSwitch : null;
  const switchedAtMs = last && typeof last === 'object' && fin(last.at) && String(last.to) === number ? Math.round(last.at * 1000) : null;
  const hasRoom = active.enabled !== false && !active.lastError && !active.quarantined
    && under(active.usage5h, active.max5h) && under(active.usage7d, active.max7d);
  return { switchedAtMs, hasRoom, label: number ? `#${number}` : '' };
}

/**
 * @param {{ find?: () => string|null, execFile?: typeof cp.execFile, log?: (line: string) => void }} deps
 * @returns {() => Promise<ReturnType<typeof parseCswap>>} never rejects
 */
function createCswapReader(deps = {}) {
  const find = typeof deps.find === 'function' ? deps.find : () => findCswap();
  const execFile = deps.execFile || cp.execFile;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  let warned = false;
  return function read() {
    let bin = null;
    try { bin = find(); } catch { bin = null; }
    if (!bin) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        execFile(bin, ['policy', 'list', '--json'], { timeout: RUN_TIMEOUT_MS, maxBuffer: OUTPUT_MAX, windowsHide: true, shell: false },
          (err, stdout) => {
            if (err) {
              if (!warned) log(`autoresume: cswap policy list failed: ${String((err && err.message) || err).split('\n')[0]}`);
              warned = true;
              resolve(null);
              return;
            }
            warned = false;
            try { resolve(parseCswap(JSON.parse(String(stdout)))); } catch { resolve(null); }
          });
      } catch {
        resolve(null);
      }
    });
  };
}

module.exports = { RUN_TIMEOUT_MS, findCswap, parseCswap, createCswapReader };
