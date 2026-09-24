'use strict';
// Pure functions for the session list (modeled on VS Code's terminal tab list): width snapping, keyboard navigation, type-to-jump, keyed incremental child sync.
// The page (media/agents.js) and the extension (lib/agents-view.js) share the same values; unit tests require it directly in Node.
// No dependency on DOM globals: syncKeyed only uses children / firstChild / nextSibling / insertBefore / remove, so tests can use fake nodes.
// When loaded in the browser via <script>, it is exposed as globalThis.AgentMonitorList.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else /** @type {any} */ (root).AgentMonitorList = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Values taken from VS Code's terminal tab list (terminal.ts TerminalTabsListSizes): narrow strip 46, wide mode at least 80, at most 500;
  // default width 200; when the panel is narrower than 500 the narrow strip is used automatically.
  // Leave at least 300 for the content area: the second line of the narrow layout (indent + three fixed-width cells for tokens / cost / time) needs that much to avoid clipping
  const WIDTH = Object.freeze({
    DEFAULT: 200,
    NARROW: 46,
    MIN: 80,
    MAX: 500,
    AUTO_NARROW_PANEL: 500,
    MIN_CONTENT: 300,
  });
  // Dragged below the midpoint between the narrow strip and the minimum width → snap to the narrow strip
  const MIDPOINT = (WIDTH.NARROW + WIDTH.MIN) / 2;

  /**
   * Dragged or saved width → snapped width: < 63 → 46 (narrow strip); 63–80 → 80; at most 500. Non-number → default width.
   * @param {any} w
   * @returns {number}
   */
  function snapWidth(w) {
    const n = Number(w);
    if (!Number.isFinite(n) || n <= 0) return WIDTH.DEFAULT;
    if (n < MIDPOINT) return WIDTH.NARROW;
    if (n < WIDTH.MIN) return WIDTH.MIN;
    return Math.min(WIDTH.MAX, Math.round(n));
  }

  /**
   * Actual displayed width.
   * - Panel narrower than 500: automatic narrow strip (auto = true; dragging is disabled and the saved width is left unchanged);
   * - Saved width is the narrow strip: narrow strip;
   * - Otherwise the saved width, leaving 300 for the content area; if that leaves less than 80 for the list, use the narrow strip.
   * @param {any} saved saved width
   * @param {number} panelWidth width of the whole panel (webview)
   * @returns {{ width: number, narrow: boolean, auto: boolean }}
   */
  function effectiveWidth(saved, panelWidth) {
    const narrow = (auto) => ({ width: WIDTH.NARROW, narrow: true, auto });
    const panel = Number(panelWidth);
    if (Number.isFinite(panel) && panel > 0 && panel < WIDTH.AUTO_NARROW_PANEL) return narrow(true);
    const w = snapWidth(saved);
    if (w === WIDTH.NARROW) return narrow(false);
    const room = Number.isFinite(panel) && panel > 0 ? panel - WIDTH.MIN_CONTENT : WIDTH.MAX;
    if (room < WIDTH.MIN) return narrow(true);
    const width = Math.max(WIDTH.MIN, Math.min(w, room));
    return { width, narrow: false, auto: false };
  }

  /**
   * While dragging the sash: pointer x-coordinate → list width (the list sits against the left or right edge of the panel).
   * @param {'left'|'right'} position
   * @param {number} clientX
   * @param {number} panelWidth
   */
  function dragWidth(position, clientX, panelWidth) {
    return position === 'left' ? clientX : panelWidth - clientX;
  }

  /**
   * Keyboard focus movement: ↑ / ↓ / Home / End / PageUp / PageDown. Other keys return -1 (not handled).
   * @param {string} key KeyboardEvent.key
   * @param {number} index current focus (-1 = none yet)
   * @param {number} count number of rows
   * @param {number} [page] rows per page (PageUp / PageDown)
   */
  function moveIndex(key, index, count, page) {
    if (!(count > 0)) return -1;
    const last = count - 1;
    const step = Math.max(1, (page | 0) || 1);
    const cur = index >= 0 && index <= last ? index : -1;
    switch (key) {
      case 'ArrowDown': return cur < 0 ? 0 : Math.min(last, cur + 1);
      case 'ArrowUp': return cur < 0 ? 0 : Math.max(0, cur - 1);
      case 'Home': return 0;
      case 'End': return last;
      case 'PageDown': return cur < 0 ? 0 : Math.min(last, cur + step);
      case 'PageUp': return cur < 0 ? 0 : Math.max(0, cur - step);
      default: return -1;
    }
  }

  /**
   * Type-to-jump (case-insensitive, wraps around when nothing is found).
   * - Repeating the same letter ("a", "aa"…): cycles through rows starting with that letter, searching from the row after the current focus;
   * - Typing several characters ("fix"): searches from the current row for one starting with them, so typing one more letter doesn't make the focus jump around.
   * @param {string[]} labels row titles
   * @param {number} from current focus (-1 = none yet)
   * @param {string} typed the characters typed in this sequence
   * @returns {number} the matching row, or -1 if none
   */
  function typeAhead(labels, from, typed) {
    const list = labels || [];
    const n = list.length;
    const q = String(typed || '').toLocaleLowerCase();
    if (!n || !q) return -1;
    const repeated = q.length > 1 && q.split('').every((c) => c === q[0]);
    const prefix = repeated ? q[0] : q;
    const start = repeated || q.length === 1 ? from + 1 : Math.max(0, from);
    for (let i = 0; i < n; i++) {
      const j = (((start + i) % n) + n) % n;
      if (String(list[j] || '').toLocaleLowerCase().startsWith(prefix)) return j;
    }
    return -1;
  }

  /**
   * Sync child nodes by key: first remove the ones no longer needed, then place them in order; nodes already in the right place are not moved (so focus isn't lost and nothing flickers).
   * The same key is always the same node: existing ones are updated in place, new ones are inserted at their position.
   * @param {any} parent a node with children, firstChild, insertBefore
   * @param {any[]} items
   * @param {(it: any, i: number) => string} keyOf
   * @param {(it: any) => any} make creates a new node (the node records _key)
   * @param {(node: any, it: any) => void} update
   * @param {(key: string) => any} [reuse] first look for an existing node elsewhere (e.g. moved from another parent); otherwise make
   */
  function syncKeyed(parent, items, keyOf, make, update, reuse) {
    const keys = items.map(keyOf);
    const keep = new Set(keys);
    const byKey = new Map();
    for (const c of Array.from(parent.children)) {
      if (!keep.has(c._key) || byKey.has(c._key)) c.remove();
      else byKey.set(c._key, c);
    }
    let prev = null;
    items.forEach((it, i) => {
      let node = byKey.get(keys[i]) || (reuse ? reuse(keys[i]) : null);
      if (!node) { node = make(it); node._key = keys[i]; }
      update(node, it);
      const want = prev ? prev.nextSibling : parent.firstChild;
      if (node !== want) parent.insertBefore(node, want);
      prev = node;
    });
  }

  return { WIDTH, MIDPOINT, snapWidth, effectiveWidth, dragWidth, moveIndex, typeAhead, syncKeyed };
});
