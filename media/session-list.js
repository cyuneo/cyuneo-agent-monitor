'use strict';
// 会话列表（仿终端标签列表，DESIGN §11.13）的纯函数：宽度吸附、键盘移动、首字母跳转、按 key 增量同步子节点。
// 页面（media/agents.js）和扩展（lib/agents-view.js）共用同一份数值；单测在 Node 里直接 require。
// 不依赖 DOM 全局对象：syncKeyed 只用 children / firstChild / nextSibling / insertBefore / remove，测试可以用假节点。
// 浏览器里用 <script> 引入时挂在 globalThis.AgentMonitorList。
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else /** @type {any} */ (root).AgentMonitorList = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 数值取自 VS Code 终端标签列表（terminal.ts TerminalTabsListSizes）：窄条 46、宽模式最少 80、最宽 500；
  // 默认宽度按 §11.13 用 200；面板窄于 500 时自动用窄条。
  // 内容区至少留 300：窄排法的第二行（缩进 + token / 费用 / 用时三个定宽格）要这么宽才不被裁掉
  const WIDTH = Object.freeze({
    DEFAULT: 200,
    NARROW: 46,
    MIN: 80,
    MAX: 500,
    AUTO_NARROW_PANEL: 500,
    MIN_CONTENT: 300,
  });
  // 拖到窄条和最小宽度的中点以下就吸附成窄条
  const MIDPOINT = (WIDTH.NARROW + WIDTH.MIN) / 2;

  /**
   * 拖动或保存的宽度 → 吸附后的宽度：< 63 → 46（窄条）；63–80 → 80；最宽 500。非数字 → 默认宽度。
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
   * 实际显示的宽度。
   * - 面板窄于 500：自动窄条（auto = true，这时不能拖动，保存的宽度不变）；
   * - 保存的是窄条：窄条；
   * - 否则保存的宽度，但给内容区留 300；留不出 80 的列表就用窄条。
   * @param {any} saved 保存的宽度
   * @param {number} panelWidth 整个面板（webview）的宽度
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
   * 拖动分隔线时，指针横坐标 → 列表宽度（列表贴着面板的左边或右边）。
   * @param {'left'|'right'} position
   * @param {number} clientX
   * @param {number} panelWidth
   */
  function dragWidth(position, clientX, panelWidth) {
    return position === 'left' ? clientX : panelWidth - clientX;
  }

  /**
   * 键盘移动焦点：↑ / ↓ / Home / End / PageUp / PageDown。其它键返回 -1（不处理）。
   * @param {string} key KeyboardEvent.key
   * @param {number} index 当前焦点（-1 = 还没有）
   * @param {number} count 行数
   * @param {number} [page] 一页多少行（PageUp / PageDown）
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
   * 首字母跳转（不分大小写，找不到时回绕）。
   * - 连按同一个字母（“a”“aa”…）：在以这个字母开头的行之间轮换，从当前焦点的下一行找；
   * - 连着打几个字（“fix”）：从当前焦点这一行开始找以它开头的，这样多打一个字母时焦点不乱跳。
   * @param {string[]} labels 各行标题
   * @param {number} from 当前焦点（-1 = 还没有）
   * @param {string} typed 这一串键入的文字
   * @returns {number} 找到的行，没有 → -1
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
   * 按键同步子节点：先删掉不再需要的，再按顺序放置；已在正确位置的节点不动（不移动就不会丢焦点、不闪）。
   * 同一个 key 始终是同一个节点：已有的原地更新，新的插到规定位置。
   * @param {any} parent 有 children、firstChild、insertBefore 的节点
   * @param {any[]} items
   * @param {(it: any, i: number) => string} keyOf
   * @param {(it: any) => any} make 新建节点（节点上会记 _key）
   * @param {(node: any, it: any) => void} update
   * @param {(key: string) => any} [reuse] 先到别处找现成的节点（例如从另一个父节点挪过来），没有就 make
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
