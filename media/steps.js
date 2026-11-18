'use strict';
// Step blocks, shared by the webview pages that show an agent's steps (the bottom panel today).
// - A tool call is a gray block (media/steps.css) that opens to its input and output; prompts, thinking, replies and events
//   are plain lines between the blocks. Everything shown comes preformatted from the view model (lib/agents-view.js stepsVm).
// - Opening a block asks the extension for that call's log: the page posts only { type: 'step', sessionKey, rowId, ref } and the
//   extension checks and reads it (serveStep). Replies are kept while the page is open (at most 200).
// - DOM is built from text only (the page's h() helper); nothing here parses markup.
// When loaded in the browser via <script>, it is exposed as globalThis.AgentMonitorSteps; Node tests require it directly.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else /** @type {any} */ (root).AgentMonitorSteps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_LOGS = 200;
  const STATE_ICON = { running: 'loading codicon-modifier-spin', done: 'check', error: 'error', stopped: 'debug-stop' };

  function txt(el, s) { s = s == null ? '' : String(s); if (el.textContent !== s) el.textContent = s; }
  function at(el, k, v) {
    if (v == null || v === false) { if (el.hasAttribute(k)) el.removeAttribute(k); return; }
    const s = v === true ? '' : String(v);
    if (el.getAttribute(k) !== s) el.setAttribute(k, s);
  }
  function cn(el, s) { if (el.className !== s) el.className = s; }
  function show(el, on) { if (el.hidden === !!on) el.hidden = !on; }

  /**
   * @param {{ post: (m: any) => void, t: (key: string, vars?: any) => string, h: (tag: string, attrs?: any, kids?: any[]) => any,
   *   getSessionKey: () => (string|null), syncKeyed?: Function }} o
   *   post sends a message to the extension; t looks up the injected dictionary; h builds an element from text;
   *   getSessionKey is the session whose steps are on screen; syncKeyed (media/session-list.js) is needed for sync().
   */
  function createSteps({ post, t, h, getSessionKey, syncKeyed }) {
    const logs = new Map(); // session + row id + call id -> the reply of the extension
    const logKey = (sessionKey, rowId, ref) => sessionKey + '\n' + rowId + '\n' + ref;
    let seq = 0; // for step body ids

    function makeLine() {
      return h('li', { class: 'step line' }, [
        h('i', { class: 'codicon', 'aria-hidden': 'true' }), h('span', { class: 'st-text' }), h('span', { class: 'ago muted' }),
      ]);
    }
    function updateLine(li, x) {
      cn(li.children[0], 'codicon codicon-' + x.icon + (x.tone ? ' tone-' + x.tone : ''));
      txt(li.children[1], x.text);
      at(li.children[1], 'title', x.text);
      txt(li.children[2], x.ago);
    }

    function makeStep() {
      const bodyId = 'st' + (++seq);
      const head = h('button', { type: 'button', class: 'st-head', 'data-act': 'step', 'aria-expanded': 'false', 'aria-controls': bodyId }, [
        h('i', { class: 'st-chev codicon codicon-chevron-right', 'aria-hidden': 'true' }),
        h('i', { class: 'st-icon codicon', 'aria-hidden': 'true' }),
        h('span', { class: 'st-title' }),
        h('span', { class: 'st-text muted' }),
        h('span', { class: 'st-tool muted' }),
        h('span', { class: 'st-dur muted' }),
        h('i', { class: 'st-state codicon', 'aria-hidden': 'true' }),
        h('span', { class: 'sr-only st-statetext' }),
        h('span', { class: 'ago muted' }),
      ]);
      const io = (label) => h('div', { class: 'st-io' }, [h('div', { class: 'st-label muted' }, [label]), h('pre', { class: 'st-code', tabindex: '0' }), h('p', { class: 'muted trunc' }, [t('webview.step.truncated')])]);
      const body = h('div', { class: 'st-body', id: bodyId, hidden: '' }, [
        h('p', { class: 'st-err' }),
        io(t('webview.step.input')), io(t('webview.step.output')),
        h('p', { class: 'muted st-msg' }),
      ]);
      const li = h('li', { class: 'step block' }, [head, body]);
      li._s = { head, body, open: false };
      return li;
    }
    function updateStep(li, x, rowId) {
      const S = li._s;
      // A step that was running when it was opened has its output now: ask again
      const ended = S.open && S.data && S.data.state === 'running' && x.state !== 'running' && x.ref;
      S.data = x;
      S.rowId = rowId;
      S.sessionKey = getSessionKey();
      if (ended) post({ type: 'step', sessionKey: S.sessionKey, rowId, ref: x.ref });
      const [chev, icon, title, text, tool, dur, state, stateText, ago] = S.head.children;
      cn(li, 'step block' + (x.state ? ' s-' + x.state : '') + (x.ref ? '' : ' no-log') + (li.classList.contains('enter') ? ' enter' : ''));
      cn(icon, 'st-icon codicon codicon-' + x.icon);
      txt(title, x.title);
      txt(text, x.text);
      show(text, !!x.text);
      txt(tool, x.tool);
      show(tool, !!x.tool);
      txt(dur, x.durText);
      show(dur, !!x.durText);
      cn(state, 'st-state codicon codicon-' + (STATE_ICON[x.state] || 'circle-small'));
      txt(stateText, x.stateText);
      txt(ago, x.ago);
      at(S.head, 'title', [x.title, x.tool, x.text, x.durText, x.stateText].filter(Boolean).join(' · '));
      at(S.head, 'aria-disabled', x.ref || x.error ? null : 'true');
      show(chev, !!(x.ref || x.error));
      if (S.open) fillStep(li);
    }
    function toggleStep(li) {
      const S = li && li._s;
      if (!S || !S.data || !(S.data.ref || S.data.error)) return;
      S.open = !S.open;
      at(S.head, 'aria-expanded', String(S.open));
      cn(S.head.children[0], 'st-chev codicon codicon-chevron-' + (S.open ? 'down' : 'right'));
      show(S.body, S.open);
      if (!S.open) return;
      const ref = S.data.ref;
      const k = logKey(S.sessionKey, S.rowId, ref);
      // Ask again while a step is still running: its output arrives later
      if (ref && (!logs.has(k) || S.data.state === 'running')) {
        if (!logs.has(k)) logs.set(k, null);
        post({ type: 'step', sessionKey: S.sessionKey, rowId: S.rowId, ref });
      }
      fillStep(li);
    }
    function fillStep(li) {
      const S = li._s;
      const [err, inBox, outBox, msg] = S.body.children;
      txt(err, S.data.error || '');
      show(err, !!S.data.error);
      const r = S.data.ref ? logs.get(logKey(S.sessionKey, S.rowId, S.data.ref)) : undefined;
      const put = (box, text, cut) => {
        show(box, text != null && text !== '');
        if (text != null) txt(box.children[1], text);
        show(box.children[2], !!cut);
      };
      put(inBox, r ? r.input : null, r && r.inputTruncated);
      put(outBox, r ? r.output : null, r && r.outputTruncated);
      outBox.classList.toggle('is-error', !!(r && r.isError));
      let note = '';
      if (S.data.ref && r === null) note = t('webview.step.loading');
      else if (r && r.failed) note = t('webview.step.failed');
      else if (r && !r.found) note = t('webview.step.notFound');
      else if (r && r.output == null && S.data.state === 'running') note = t('webview.step.waiting');
      txt(msg, note);
      show(msg, !!note);
    }
    /** A { type: 'step' } reply from the extension: keep it and refill the open blocks under root that show that call. */
    function onStepLog(m, root) {
      if (!m || m.sessionKey !== getSessionKey()) return;
      logs.set(logKey(m.sessionKey, m.rowId, m.ref), m);
      if (logs.size > MAX_LOGS) logs.delete(logs.keys().next().value);
      for (const li of root.querySelectorAll('.step.block')) {
        const S = li._s;
        if (S && S.open && S.sessionKey === m.sessionKey && S.rowId === m.rowId && S.data && S.data.ref === m.ref) fillStep(li);
      }
    }

    /**
     * Brings list (an <ol class="steps">) in line with the view model's steps of one row, keeping each step's element.
     * With animate, steps that are new since the last call slide in one after another (the first fill appears at once).
     * reuse (optional): key -> an element from elsewhere to take for a step that has none here yet.
     */
    function sync(list, items, rowId, animate, reuse) {
      let fresh = 0;
      syncKeyed(list, items, (x) => x.key, (x) => {
        const li = x.block ? makeStep() : makeLine();
        if (animate) {
          li.classList.add('enter');
          li.style.animationDelay = Math.min(fresh++, 8) * 70 + 'ms';
          // once only: an animation would play again whenever the list is hidden and shown
          li.addEventListener('animationend', () => { li.classList.remove('enter'); li.style.animationDelay = ''; }, { once: true });
        }
        return li;
      }, (li, x) => (x.block ? updateStep(li, x, rowId) : updateLine(li, x)), reuse);
    }

    return { makeLine, updateLine, makeStep, updateStep, toggleStep, fillStep, onStepLog, sync };
  }

  return { createSteps, STATE_ICON };
});
