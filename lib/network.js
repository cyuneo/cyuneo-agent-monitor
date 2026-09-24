'use strict';
// The one way out to the network. Every request the extension makes goes through request() here, which reads the
// agentMonitor.network.allow switch at call time. While the switch is off (the default), request() answers
// { ok: false, code: 'networkOff' } and never calls fetch.
// - No vscode dependency. The extension tells this module where the switch is read (setAllowed: user settings only, via
//   inspect().globalValue); until it does, and again after it stops, the switch reads as off.
// - Only an exact true turns it on: a throwing source, 'true', 1 or anything else is off.
// - No other file may call fetch, http(s).request, net.connect or similar; test/push.test.js checks the sources for it.

const OFF_CODE = 'networkOff';

let source = null;

/**
 * Sets where the switch is read. Returns a release function that puts the switch back to off, but only while this
 * source is still the current one (a later setAllowed wins).
 * @param {(() => boolean)|null} fn
 * @returns {() => void}
 */
function setAllowed(fn) {
  const mine = typeof fn === 'function' ? fn : null;
  source = mine;
  return () => { if (source === mine) source = null; };
}

/** The switch, read now */
function isAllowed() {
  if (!source) return false;
  try {
    return source() === true;
  } catch {
    return false;
  }
}

/** The answer for a request refused because the switch is off (a fresh object each time) */
function offResult() {
  return { ok: false, status: 0, code: OFF_CODE, error: 'network access is off' };
}

/** Whether a result is offResult() */
function isOff(r) {
  return !!r && typeof r === 'object' && r.code === OFF_CODE;
}

/**
 * Sends one request, if the switch is on right now. Off: resolves offResult() without calling fetch.
 * On: returns what fetch returns (resolves the response, rejects on a network error, like fetch).
 * @param {string} url
 * @param {object} init fetch options
 * @param {{ fetch?: Function }} [o] fetch: for tests; defaults to globalThis.fetch at call time
 * @returns {Promise<any>}
 */
async function request(url, init, o) {
  if (!isAllowed()) return offResult();
  const f = o && typeof o.fetch === 'function' ? o.fetch : typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
  if (!f) throw new Error('fetch is not available');
  return f(url, init);
}

module.exports = { OFF_CODE, setAllowed, isAllowed, offResult, isOff, request };
