'use strict';
// 底部面板 webview 的测试：lib/agents-view.js（内容区与会话列表的视图模型 + WebviewViewProvider）、lib/webview-html.js、
// media/session-list.js（宽度吸附、键盘、首字母跳转、增量同步）、media/agents.js 的接线与词条、l10n/webview.en.json。
// 纯 node 运行：node test/agents-view.test.js。
// 数据全部是合成的，不读 ~/.claude、~/.codex。临时文件放在 AGENT_MONITOR_TEST_TMP（没设就用系统临时目录），跑完删除。
// 页面本身（DOM 增量更新、对比度、窄宽排法）在无头 Chrome 里另测（开发时手工检查，不在这里）。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const S = require('../lib/core/status');
const i18nLib = require('../lib/i18n');
const { createAgentOrder, createSessionOrder } = require('../lib/order');
const LS = require('../media/session-list');
const lamp = require('../lib/lamp');
const AV = require('../lib/agents-view');
const { webviewHtml, WEBVIEW_DICT_PREFIXES } = require('../lib/webview-html');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-agents-view-'));

// ---------- 小工具 ----------

const results = [];
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { results.push(true); console.log(`  ok    ${name}`); }, (err) => fail(name, err)));
      return;
    }
    results.push(true);
    console.log(`  ok    ${name}`);
  } catch (err) {
    fail(name, err);
  }
}
function fail(name, err) {
  results.push(false);
  console.log(`  FAIL  ${name}\n        ${String((err && err.stack) || err).split('\n').slice(0, 5).join('\n        ')}`);
}

const NOW = Date.parse('2026-09-24T10:00:00Z');
const MIN = 60e3;
const i18n = i18nLib.createI18n('en', { timeZone: 'UTC' });

function tokens(used, o = {}) {
  return {
    display: used + 800, contextUsed: used, contextWindow: 1000000, compactAt: 967000, toCompact: 967000 - used,
    output: 1200, processed: 60000, apiCalls: 12, ...o,
  };
}
function agent(o = {}) {
  return {
    id: 'main', kind: 'main', name: null, agentType: null, phase: null, background: false,
    model: 'claude-opus-5-5', status: S.makeStatus('thinking', NOW - 5000), step: null,
    tokens: tokens(84000), toolCalls: 3, toolErrors: 0, filesChanged: 1,
    costUsd: 0.42, costEstimated: false, unpricedModel: null, lastCompact: null, cacheTtl: '1h',
    startedMs: NOW - 120 * MIN, lastActivityMs: NOW - 5000, mtimeMs: NOW - 5000, file: '/synthetic/main.jsonl',
    ...o,
  };
}
function session(o = {}) {
  const id = o.id || '11111111-0000-4000-8000-000000000001';
  const provider = o.provider || 'claude';
  return {
    key: `${provider}:${id}`, provider, id, title: 'Synthetic session', titleSource: 'ai',
    cwd: '/work/demo', projectDir: '-work-demo', entry: 'vscode', entryRaw: 'claude-vscode', entrypoint: 'claude-vscode',
    model: 'claude-opus-5-5', createdMs: NOW - 120 * MIN, updatedMs: NOW - 5000, startedMs: NOW - 120 * MIN,
    doneAtMs: null, live: false, liveStatus: null, waitingFor: null,
    main: agent(), agents: [], workflows: [],
    counts: { running: 1, awaiting: 0, error: 0, done: 0, total: 1 },
    costUsd: 0.5, resume: [], cacheExpiresMs: NOW + 12 * MIN,
    ...o,
  };
}
const sub = (id, startedMs, o = {}) => agent({ id, kind: 'subagent', name: 'Sub ' + id, agentType: 'general-purpose', startedMs, file: `/synthetic/agent-${id}.jsonl`, ...o });
const ids = (vm) => vm.rows.map((r) => r.id);
const build = (s, o = {}) => AV.buildViewModel({ session: s, i18n, now: NOW, order: createAgentOrder({ now: () => NOW }), home: '/Users/demo', platform: 'darwin', loaded: true, ...o });

// ---------- 视图模型 ----------

test('空状态：没收到快照 → 正在读取；没有会话 → 扩展给的提示；否则“选一个会话”', () => {
  const a = AV.buildViewModel({ session: null, i18n, loaded: false });
  assert.strictEqual(a.type, 'render');
  assert.strictEqual(a.emptyText, i18n.t('session.loading'));
  assert.deepStrictEqual(a.rows, []);
  const b = AV.buildViewModel({ session: null, i18n, loaded: true, emptyText: 'Nothing here' });
  assert.strictEqual(b.emptyText, 'Nothing here');
  const c = AV.buildViewModel({ session: null, i18n, loaded: true });
  assert.strictEqual(c.emptyText, i18n.t('session.none'));
});

test('行：主对话最上，子智能体按开始时间正序，工作流智能体归组（顺序来自 order.js）', () => {
  const s = session({
    agents: [sub('b', NOW - 10 * MIN), sub('a', NOW - 30 * MIN)],
    workflows: [{ id: 'wf_1', taskId: null, name: 'flow', scriptPath: null, state: 'running', phases: ['p1'], done: 0, total: 2, running: 2,
      tokens: 100, outTokens: 10, costUsd: 0.01, startedMs: NOW - 20 * MIN,
      agents: [agent({ id: 'w2', kind: 'workflowAgent', name: 'W2', startedMs: NOW - 15 * MIN }), agent({ id: 'w1', kind: 'workflowAgent', name: 'W1', startedMs: NOW - 19 * MIN })] }],
  });
  const vm = build(s);
  assert.deepStrictEqual(ids(vm), ['main', 'a/a', 'wf/wf_1', 'wf/wf_1/w1', 'wf/wf_1/w2', 'a/b']);
  const byId = Object.fromEntries(vm.rows.map((r) => [r.id, r]));
  assert.strictEqual(byId.main.name, i18n.t('agent.main'));
  assert.strictEqual(byId['wf/wf_1'].kind, 'workflow');
  assert.strictEqual(byId['wf/wf_1'].expandable, false);
  assert.strictEqual(byId['wf/wf_1/w1'].parentId, 'wf/wf_1');
  assert.strictEqual(byId['wf/wf_1/w1'].depth, 2);
  assert.strictEqual(byId['wf/wf_1'].badge, null, '工作流行不在状态前放铃铛');
  for (const r of vm.rows) {
    assert.ok(r.name && r.statusText && r.lamp && r.shape, r.id);
    assert.ok(!/\{\w+\}/.test(JSON.stringify(r)), '没有未替换的占位符：' + r.id);
  }
});

test('连续 20 份快照：两个智能体交替活动、输入顺序打乱、中途新增一行 → 顺序只按开始时间、新行在规定位置', () => {
  const order = createAgentOrder({ now: () => NOW });
  let prev = null;
  for (let i = 0; i < 20; i++) {
    const x = sub('x', NOW - 20 * MIN, { status: S.makeStatus(i % 2 ? 'done' : 'tool', NOW), lastActivityMs: NOW + i });
    const y = sub('y', NOW - 10 * MIN, { status: S.makeStatus(i % 2 ? 'tool' : 'done', NOW), lastActivityMs: NOW - i });
    const list = i % 2 ? [y, x] : [x, y];
    if (i >= 8) list.unshift(sub('z', NOW - 5 * MIN)); // 中途出现、开始时间最晚
    const s = session({ agents: list, updatedMs: NOW + i });
    const vm = AV.buildViewModel({ session: s, i18n, now: NOW + i * 2000, order, loaded: true });
    const want = i >= 8 ? ['main', 'a/x', 'a/y', 'a/z'] : ['main', 'a/x', 'a/y'];
    assert.deepStrictEqual(ids(vm), want, '第 ' + i + ' 份');
    if (prev) assert.deepStrictEqual(ids(vm).filter((id) => prev.includes(id)), prev, '已有行的相对顺序不变');
    prev = ids(vm);
  }
});

test('细节只给展开的行；没有细节数据时 loaded=false', () => {
  const s = session({ agents: [sub('a', NOW - 30 * MIN)] });
  const detail = { key: s.key, agents: {
    main: {
      timeline: [{ ms: NOW - 60e3, kind: 'tool', tool: 'Edit', detail: 'src/a.js' }, { ms: NOW - 30e3, kind: 'toolError', tool: 'Bash', detail: 'npm test' }],
      result: { text: 'Done.', ms: NOW - 1000, source: 'lastText', truncated: true },
      files: [{ path: '/work/demo/src/a.js', op: 'edit', count: 2, lastMs: NOW, movedTo: null },
        { path: '/work/demo/src/old.js', op: 'move', count: 1, lastMs: NOW, movedTo: '/work/demo/src/new/old.js' },
        { path: '/Users/demo/notes/x.md', op: 'create', count: 1, lastMs: NOW, movedTo: null }],
      errors: [{ ms: NOW - 30e3, tool: 'Bash', text: 'Exit code 1' }],
    },
  } };
  const vm = build(s, { detail, expanded: ['main', 'a/a', 'nope'] });
  assert.deepStrictEqual(Object.keys(vm.detail).sort(), ['a/a', 'main']);
  const d = vm.detail.main;
  assert.strictEqual(d.loaded, true);
  assert.strictEqual(d.timeline.length, 2);
  assert.strictEqual(d.timeline[0].tone, 'error', '最新的在最上面');
  assert.strictEqual(d.timeline[0].icon, 'error');
  assert.deepStrictEqual(d.result, { text: 'Done.', truncated: true, ago: i18n.fmtAgo(NOW - 1000, NOW) });
  assert.deepStrictEqual(d.files.map((f) => [f.base, f.dir]), [['a.js', 'src'], ['old.js', 'src'], ['x.md', '~/notes']]);
  assert.ok(d.files[1].opText.includes('src/new/old.js') && !d.files[1].opText.includes('/work/demo'), '移动目标写相对路径');
  assert.strictEqual(d.errors[0].tool, 'Bash');
  assert.strictEqual(d.canOpen, true);
  assert.strictEqual(vm.detail['a/a'].loaded, false);
  const none = build(s, { detail });
  assert.deepStrictEqual(none.detail, {}, '没有展开的行就不带细节');
});

test('主对话行用按登记表修正后的状态（waiting → 等你批准，NeedsYou）', () => {
  const s = session({ live: true, liveStatus: 'waiting', waitingFor: S.WAITING_FOR.PERMISSION });
  const L = lamp.sessionLamps(s, { seenAtMs: 0 });
  const vm = build(s, { lamps: L });
  const main = vm.rows.find((r) => r.id === 'main');
  assert.strictEqual(main.lamp, 'needsYou');
  assert.strictEqual(main.statusText, i18n.t('status.awaitingApproval'));
  assert.strictEqual(main.badge, 'bell');
  assert.strictEqual(vm.session.lamp, 'needsYou');
  assert.strictEqual(vm.session.statusText, i18n.t('status.awaitingApproval'));
});

test('会话条：压缩按钮只给上下文 ≥ 20000 的主会话；缓存倒计时只给 Claude', () => {
  assert.strictEqual(build(session()).session.compactable, true);
  assert.strictEqual(build(session({ main: agent({ tokens: tokens(19999) }) })).session.compactable, false);
  const cx = build(session({ provider: 'codex', id: '0c0de000-0000-4000-8000-000000000001', cacheExpiresMs: null,
    main: agent({ id: '0c0de000-0000-4000-8000-000000000001', model: 'gpt-5.6-sol', tokens: tokens(30000, { contextWindow: 258400, compactAt: 244800, toCompact: 214800 }) }) }));
  assert.strictEqual(cx.session.compactable, true);
  assert.strictEqual(cx.session.cache, null);
  const c = build(session()).session.cache;
  assert.strictEqual(c.expiresMs, NOW + 12 * MIN);
  assert.strictEqual(c.text, i18n.t('session.cacheLeft', { m: 12 }));
});

test('会话条：上下文用绝对数（已用 / 自动压缩点），百分比按窗口（Claude Code 的公式），进度条 0–100', () => {
  const s = session({ main: agent({ tokens: tokens(412000) }) });
  const ctx = build(s).session.context;
  assert.strictEqual(ctx.text, i18n.t('webview.ctx.ofCompact', { used: i18n.fmtTokens(412000), limit: i18n.fmtTokens(967000) }));
  assert.strictEqual(ctx.pctText, '41% of the 1M window', '百分比 = 已用 / 窗口，不是占阈值的 43%');
  assert.strictEqual(ctx.pct, 43, '进度条仍是 已用 / 自动压缩点');
  assert.strictEqual(ctx.remainText, i18n.t('ctx.toCompact', { tokens: i18n.fmtTokens(555000) })); // 旁边写“距自动压缩 555K”
  assert.ok(ctx.ariaText.includes(ctx.pctText) && ctx.ariaText.includes(ctx.remainText), ctx.ariaText);
  assert.strictEqual(ctx.zone, 'consider');
  assert.ok(ctx.zoneTip.includes(i18n.t('webview.zone.newTask')));
  const over = build(session({ main: agent({ tokens: tokens(990000, { toCompact: -23000 }) }) })).session.context;
  assert.strictEqual(over.pct, 100);
  const off = build(session({ main: agent({ tokens: tokens(50000, { compactAt: null, toCompact: null }) }) })).session.context;
  assert.strictEqual(off.text, i18n.t('webview.ctx.ofWindow', { used: i18n.fmtTokens(50000), limit: i18n.fmtTokens(1000000) }) + ' (5%)');
  assert.strictEqual(off.pctText, '', '进度条上限就是窗口时百分比跟在后面，不再单写一段');
  assert.strictEqual(off.remainText, i18n.t('ctx.autoCompactOff'));
  const tiny = build(session({ main: agent({ tokens: tokens(2000) }) })).session.context;
  assert.strictEqual(tiny.pctText, '<1% of the 1M window', '很小但非零写 <1%');
});

test('§11.10 会话条：窗口和压缩点用 Session 上的值，提示里写来源和 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', () => {
  const s = session({
    contextWindow: 1000000, contextWindowSource: 'cost-state', compactAt: 367000, compactAtSource: 'settings-user',
    main: agent({ tokens: tokens(300000, { contextWindow: 200000, compactAt: 167000, toCompact: -133000 }) }),
  });
  const ctx = build(s).session.context;
  assert.strictEqual(ctx.text, i18n.t('webview.ctx.ofCompact', { used: '300K', limit: '367K' }));
  assert.strictEqual(ctx.pctText, '30% of the 1M window');
  assert.strictEqual(ctx.remainText, i18n.t('ctx.toCompact', { tokens: '67K' }));
  assert.strictEqual(ctx.pct, 82);
  assert.ok(ctx.tip.includes("from Claude Code's cost record"), ctx.tip);
  assert.ok(ctx.tip.includes('your user settings'), ctx.tip);
  assert.ok(ctx.tip.includes('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'), ctx.tip);
  // 窗口 < 500K 时分区按占压缩点的比例：300K / 367K = 82% → 建议处理
  const small = build(session({ contextWindow: 200000, contextWindowSource: 'model-rule', compactAt: 167000, compactAtSource: 'default',
    main: agent({ tokens: tokens(140000, { contextWindow: 1000000, compactAt: 967000, toCompact: 827000 }) }) })).session.context;
  assert.strictEqual(small.zone, 'act', '按会话级窗口 200K 分区');
  assert.ok(small.tip.includes('standard window for this model') && small.tip.includes('official default'), small.tip);
});

test('§11.9 会话条：“自动压缩：{值} ▾”用 describeCompactSetting 的文字，模块不在时不显示', () => {
  const calls = [];
  const describe = (sess, i) => { calls.push([sess.key, i]); return { valueText: '400K (40%)', effectiveText: '→ ≈ 367K', sourceText: 'Source: user settings', text: 'T', tooltip: 'How it works' }; };
  const s = session();
  const ac = build(s, { describeCompact: describe }).session.autoCompact;
  assert.deepStrictEqual(calls, [[s.key, i18n]]);
  assert.strictEqual(ac.text, i18n.t('webview.autoCompact', { value: '400K (40%)' }));
  assert.strictEqual(ac.detailText, '→ ≈ 367K · Source: user settings');
  assert.ok(ac.tip.includes('How it works') && ac.tip.includes(i18n.t('webview.autoCompact.tip')), ac.tip);
  // describe 按本语言模板拼好的整句以值开头时，按钮里值之后的部分直接取整句的后半（不自己拼箭头）
  const whole = build(s, { describeCompact: () => ({ valueText: '40만 (40%)', effectiveText: '≈ 36.7만', sourceText: '출처: 사용자 설정', text: '40만 (40%) → ≈ 36.7만 · 출처: 사용자 설정' }) }).session.autoCompact;
  assert.strictEqual(whole.detailText, '→ ≈ 36.7만 · 출처: 사용자 설정');
  assert.strictEqual(build(s, { describeCompact: null }).session.autoCompact, null, '没有模块');
  assert.strictEqual(build(s, { describeCompact: () => { throw new Error('x'); } }).session.autoCompact, null, '出错不显示');
  assert.strictEqual(build(s, { describeCompact: () => ({ valueText: '' }) }).session.autoCompact, null);
  // 还没有模型回复的会话（模型、窗口都不知道）：不显示，不按 200K 猜“≈ 167K”
  const noModel = session({ model: null, contextWindow: null, compactAt: null, compactAtSource: null, main: agent({ tokens: tokens(0, { contextWindow: null, compactAt: null, toCompact: null }) }) });
  assert.strictEqual(build(noModel, { describeCompact: describe }).session.autoCompact, null, '没有模型回复的会话');
  // 真模块在时（收尾轮 lib/autocompact.js）：默认就用它
  let real = null;
  try { real = require('../lib/autocompact'); } catch { real = null; }
  if (real && typeof real.describeCompactSetting === 'function') {
    const vm = build(session({ contextWindow: 1000000, contextWindowSource: 'cost-state', compactAt: 967000, compactAtSource: 'default' })).session.autoCompact;
    assert.ok(vm && vm.text.startsWith('Auto-compact: '), JSON.stringify(vm));
    assert.ok(!/\{\w+\}/.test(JSON.stringify(vm)), '没有未替换的占位符');
  }
});

test('§11.11 会话条：“记录位置”一行（~ 缩写、三种大小、按平台的按钮名），没有大小时只显示路径', () => {
  const file = '/Users/demo/.claude/projects/-work-demo/11111111-0000-4000-8000-000000000001.jsonl';
  const s = session({ transcript: file });
  const detail = { key: s.key, agents: {}, storage: { transcriptBytes: 7.7e6, subagentsBytes: 57.3e6, fileHistoryBytes: 5.3e6 } };
  const st = build(s, { detail }).session.storage;
  assert.strictEqual(st.pathText, '~/.claude/projects/-work-demo/11111111-0000-4000-8000-000000000001.jsonl');
  assert.ok(st.pathTip.startsWith(file + '\n'), '提示里是完整路径');
  assert.strictEqual(st.sizesText, '7.7 MB · subagents 57.3 MB · file backups 5.3 MB');
  assert.ok(st.sizesTip.includes('Main transcript: 7.7 MB'));
  assert.strictEqual(st.revealText, 'Reveal in Finder');
  assert.strictEqual(st.copyText, i18n.t('webview.store.copy'));
  assert.strictEqual(build(s, { detail, platform: 'win32' }).session.storage.revealText, 'Reveal in File Explorer');
  assert.strictEqual(build(s, { detail, platform: 'linux' }).session.storage.revealText, 'Open Containing Folder');
  // 子智能体、文件备份为 0 时不写；还没算出来时只有路径
  const zero = build(s, { detail: { ...detail, storage: { transcriptBytes: 1234, subagentsBytes: 0, fileHistoryBytes: null } } }).session.storage;
  assert.strictEqual(zero.sizesText, '1.2 kB');
  assert.strictEqual(build(s).session.storage.sizesText, '');
  // 没有 transcript 字段：退回主对话的记录文件；相对路径不显示
  assert.strictEqual(build(session()).session.storage.pathText, '/synthetic/main.jsonl');
  assert.strictEqual(build(session({ transcript: 'relative.jsonl', main: agent({ file: null }) })).session.storage, null);
  // Codex 会话显示 rollout 路径
  const cx = build(session({ provider: 'codex', id: '0c0de000-0000-4000-8000-000000000003', transcript: '/Users/demo/.codex/sessions/2026/09/24/rollout-x.jsonl',
    main: agent({ id: '0c0de000-0000-4000-8000-000000000003' }) }), { detail: { storage: { transcriptBytes: 52e6 } } }).session.storage;
  assert.strictEqual(cx.pathText, '~/.codex/sessions/2026/09/24/rollout-x.jsonl');
  assert.strictEqual(cx.sizesText, '52 MB');
});

test('§11.10 会话费用：优先 Claude Code 自己的统计，插件估算写进提示', () => {
  const on = build(session({ ccCostUsd: 3.2104, costUsd: 2.9 })).session;
  assert.strictEqual(on.costText, i18n.t('webview.sessionCost', { usd: "$3.21 (Claude Code's count)" }));
  assert.ok(on.costTip.includes(i18n.t('webview.sessionCost.cc.tip')) && on.costTip.includes('$2.90'), on.costTip);
  const est = build(session({ costUsd: 2.9 })).session;
  assert.strictEqual(est.costText, i18n.t('webview.sessionCost', { usd: '$2.90' }));
  assert.strictEqual(build(session({ ccCostUsd: 1 }), { settings: { showCost: false } }).session.costText, '');
});

test('续跑提示：上下文为 0 时不写估价句', () => {
  const s = session({ resume: [{ kind: 'claudeSession', sessionId: '11111111-0000-4000-8000-000000000001', cwd: '/work/demo', entry: 'cli', autoContinue: false, quota: null,
    estimate: { contextTokens: 0, ttl: '1h', cacheLikelyExpired: true, usdIfMiss: 0, usdIfHit: 0 } }] });
  assert.strictEqual(build(s).session.resume[0].infoText, '');
});

test('上下文分区（§11.8）：大窗口按绝对数，其余按占阈值的比例', () => {
  const z = (used, o = {}, hint) => AV.contextZone({ contextUsed: used, contextWindow: 1000000, compactAt: 967000, ...o }, hint);
  assert.strictEqual(z(199999), null);
  assert.strictEqual(z(200000), 'consider');
  assert.strictEqual(z(499999), 'consider');
  assert.strictEqual(z(500000), 'act');
  assert.strictEqual(z(300000, {}, { start: 350000, act: 600000 }), null, '设置 contextHintStart');
  assert.strictEqual(z(550000, {}, { start: 350000, act: 600000 }), 'consider');
  const small = (used) => AV.contextZone({ contextUsed: used, contextWindow: 258400, compactAt: 244800 });
  assert.strictEqual(small(146000), null);
  assert.strictEqual(small(146880), 'consider');
  assert.strictEqual(small(195840), 'act');
  assert.strictEqual(AV.contextZone({ contextUsed: 150000, contextWindow: 200000, compactAt: null }), 'consider', '阈值未知时按窗口');
  assert.strictEqual(AV.contextZone(null), null);
});

test('压缩次数：compactCount ≥ 2 且在分区里 → 多次压缩提示；compactLoop → 报错色字样', () => {
  const many = build(session({ compactCount: 2, main: agent({ tokens: tokens(300000) }) })).session;
  assert.strictEqual(many.context.compactText, i18n.t('webview.compacted', { n: 2 }));
  assert.ok(many.banners.some((b) => b.text === i18n.t('webview.compactMany')));
  const loop = build(session({ compactCount: 3, compactLoop: true })).session;
  assert.strictEqual(loop.context.compactText, i18n.t('webview.compactLoop'));
  assert.strictEqual(loop.context.compactTone, 'error');
  const last = build(session({ main: agent({ lastCompact: { ms: NOW - 5 * MIN, trigger: 'manual', preTokens: 100 } }) })).session;
  assert.ok(last.context.compactText.includes(i18n.t('ctx.trigger.manual')), last.context.compactText);
});

test('额度横幅：状态行已经是这条额度时不重复；Codex 显示账号额度', () => {
  const hit = { kind: 'weekly', model: null, resetsAtMs: NOW + 3 * 3600e3, resetsText: null, source: 'quotaLimits', autoContinue: null };
  const q = build(session({ main: agent({ status: S.makeStatus('quota', NOW - MIN, { quota: hit }) }) })).session;
  assert.strictEqual(q.statusText, i18n.t('quota.weekly') + ' · ' + i18n.t('quota.resets', { reset: i18n.fmtClock(hit.resetsAtMs, NOW), left: i18n.fmtDur(3 * 3600e3) }));
  assert.ok(!q.banners.some((b) => b.tone === 'error'), '不重复');
  // 子智能体撞额度、会话灯却由主对话的“等你回答”决定 → 横幅提示额度
  const s2 = session({ main: agent({ status: S.makeStatus('awaitingInput', NOW) }), agents: [sub('q', NOW - MIN, { status: S.makeStatus('quota', NOW - MIN, { quota: hit }) })] });
  const L2 = lamp.sessionLamps(s2, { seenAtMs: 0 });
  assert.strictEqual(L2.lead.rowId, 'main');
  // 主对话不是 quota、lead 也不是 → 不出额度横幅（额度只在那一行显示）
  assert.ok(!build(s2, { lamps: L2 }).session.banners.some((b) => b.tone === 'error'));
  const quota = { claude: { lastHit: null }, codex: { observedMs: NOW - MIN, planType: 'plus', limitId: 'codex', reachedType: null, credits: null,
    windows: [{ minutes: 300, usedPct: 95, resetsAtMs: NOW + 3600e3, label: '5h' }, { minutes: 10080, usedPct: 40, resetsAtMs: NOW + 86400e3, label: 'weekly' }] } };
  const cx = build(session({ provider: 'codex', id: '0c0de000-0000-4000-8000-000000000002', main: agent({ id: '0c0de000-0000-4000-8000-000000000002' }) }), { quota }).session;
  const b = cx.banners.find((x) => x.text.startsWith(i18n.t('quota.codex.title')));
  assert.ok(b, JSON.stringify(cx.banners));
  assert.strictEqual(b.tone, 'warning', '≥ 90% 用 warning');
});

test('showCost=false：费用列、会话费用、今日费用都不出现', () => {
  const today = { dayStartMs: NOW - 3600e3, partial: false, progress: 1, claude: { costUsd: 1.5, unpricedTokens: 0, byModel: {} }, codex: { costUsd: 0, unpricedTokens: 0, byModel: {} } };
  const on = build(session(), { today });
  assert.ok(on.session.costText && on.session.todayText && on.rows[0].costText);
  const off = build(session(), { today, settings: { showCost: false } });
  assert.strictEqual(off.showCost, false);
  assert.strictEqual(off.session.costText, '');
  assert.strictEqual(off.session.todayText, '');
  assert.ok(off.rows.every((r) => r.costText === ''));
});

test('没有价格的智能体：格子里只放“—”，说明放悬停提示', () => {
  const s = session({ agents: [sub('r', NOW - MIN, { kind: 'codexReviewer', name: null, agentType: null, model: 'codex-auto-review', costUsd: null, unpricedModel: 'codex-auto-review' })] });
  const r = build(s).rows.find((x) => x.id === 'a/r');
  assert.strictEqual(r.costText, i18n.fmtUsd(null));
  assert.strictEqual(r.costTip, i18n.t('cost.unpriced'));
  assert.ok(!r.sub.split(' · ').includes(r.name), '类型和名字相同不重复：' + r.sub);
});

test('hideCompleted：完成的子智能体不出现，并给一句“隐藏了 n 个”', () => {
  const s = session({ agents: [sub('d', NOW - 20 * MIN, { status: S.makeStatus('done', NOW - MIN) }), sub('r', NOW - 10 * MIN)] });
  const vm = build(s, { settings: { hideCompleted: true } });
  assert.deepStrictEqual(ids(vm), ['main', 'a/r']);
  assert.strictEqual(vm.note, i18n.t('row.completedHidden', { n: 1 }));
  assert.strictEqual(build(s).note, '');
});

test('续跑提示：按钮只有 formatResumeHint 给的形式，文字放 tip', () => {
  const s = session({ resume: [{ kind: 'claudeSession', sessionId: '11111111-0000-4000-8000-000000000001', cwd: '/work/demo', entry: 'cli', autoContinue: false, quota: null,
    estimate: { contextTokens: 50000, ttl: '1h', cacheLikelyExpired: true, usdIfMiss: 0.4, usdIfHit: 0.01 } }] });
  const r = build(s).session.resume[0];
  assert.strictEqual(r.index, 0);
  assert.ok(r.buttons.length >= 1);
  assert.ok(r.buttons.some((b) => b.variant === 'cli' && b.tip.includes('claude --resume')), JSON.stringify(r.buttons));
  assert.ok(r.infoText.length > 0);
});

// ---------- 页面 HTML 与词条 ----------

test('webviewHtml：CSP 只放行 cspSource 与 nonce，lang 用 Intl locale，词典 JSON 转义了 </script>', () => {
  const evil = i18nLib.createI18n('ko', { dicts: { en: { 'webview.title': 'A</script><script>alert(1)</script>', 'webview.footer': 'v{version}' }, ko: {} } });
  const html = webviewHtml({ cspSource: 'vscode-webview://x', asset: (p) => 'https://asset/' + p, nonce: 'N0NCE', version: '0.3.0', i18n: evil });
  const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1].replace(/&#39;/g, "'");
  assert.strictEqual(csp, "default-src 'none'; style-src vscode-webview://x; font-src vscode-webview://x; script-src 'nonce-N0NCE'");
  assert.ok(html.includes('<html lang="ko-KR">'));
  const scripts = html.match(/<script\b[^>]*>/g);
  assert.deepStrictEqual(scripts, ['<script type="application/json" id="l10n">', '<script nonce="N0NCE" src="https://asset/session-list.js">', '<script nonce="N0NCE" src="https://asset/agents.js">']);
  const json = html.slice(html.indexOf('id="l10n">') + 10, html.indexOf('</script>'));
  assert.ok(!json.includes('<'), '数据块里没有 <');
  assert.strictEqual(JSON.parse(json).dict['webview.title'], 'A</script><script>alert(1)</script>');
  assert.ok(html.includes('<title>A&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>'));
  assert.ok(html.includes('https://asset/agents.css') && html.includes('https://asset/codicons/codicon.css'));
  assert.ok(!/style=/.test(html), '没有内联 style（CSP 不放行）');
  assert.ok(!/\bon[a-z]+=/.test(html), '没有内联事件');
  // 会话条新行（§11.9–11.11）：自动压缩入口、占窗口百分比、距自动压缩、记录位置与两个按钮
  for (const id of ['s-pct', 's-remain', 's-acline', 's-autocompact', 's-storeline', 's-path', 's-sizes', 's-reveal', 's-copypath']) {
    assert.ok(html.includes(`id="${id}"`), '缺少 #' + id);
  }
  for (const act of ['setAutoCompact', 'revealTranscript', 'copyTranscriptPath']) assert.ok(html.includes(`data-act="${act}"`), act);
  // 表头：token 列在第二行那组里（窄面板第一行只剩名字和状态）
  const headLine2 = html.slice(html.indexOf('class="c-line2"'), html.indexOf('<div id="rows"'));
  assert.ok(headLine2.includes('c-tok'), 'token 表头在 c-line2 里');
});

test('media/agents.js：token 格在第二行那组里；新按钮只发 sessionKey', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'agents.js'), 'utf8');
  assert.ok(/'c-line2'[^\n]*\[u\.step, u\.tok, u\.cost, u\.time\]/.test(js), 'c-line2 = 步骤、token、费用、用时');
  assert.ok(/act === 'setAutoCompact' \|\| act === 'revealTranscript' \|\| act === 'copyTranscriptPath'/.test(js));
  assert.ok(/postMessage\(\{ type: act, sessionKey: key \}\)/.test(js), '只发类型和会话 key');
  const css = fs.readFileSync(path.join(ROOT, 'media', 'agents.css'), 'utf8');
  // 窄排法按内容区自己的宽度（容器查询），旁边的会话列表占去的宽度不算
  assert.ok(!css.includes('@media (max-width: 699px)'), '不再按整个 webview 的宽度切换');
  assert.ok(/\.content \{[^}]*container: content \/ inline-size;/.test(css), '内容区是容器');
  const narrow = css.slice(css.indexOf('@container content (max-width: 699px)'));
  assert.ok(narrow.length > 100, '缺少内容区的容器查询');
  assert.ok(/grid-template-columns: minmax\(0, 1fr\) clamp\(9em, 50%, 14\.5em\)/.test(narrow), '窄内容区：名字 / 状态两列重新分配');
});

test('media/agents.js 用到的词条都在注入前缀里、英文词典里都有', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'agents.js'), 'utf8');
  const keys = [...new Set([...js.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]))];
  const dyn = [...js.matchAll(/'(webview\.[\w.]+)'/g)].map((m) => m[1]); // t(cond ? 'a' : 'b') 的写法
  const all = [...new Set([...keys, ...dyn])];
  assert.ok(all.length >= 10, all.join());
  const dict = i18n.dict(WEBVIEW_DICT_PREFIXES);
  for (const k of all) {
    assert.ok(WEBVIEW_DICT_PREFIXES.some((p) => k.startsWith(p)), '不在注入前缀里：' + k);
    assert.ok(k in dict, '词典里没有：' + k);
  }
});

test('lib/agents-view.js、lib/webview-html.js 用到的 webview.* 词条都在 webview.en.json 里', () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'webview.en.json'), 'utf8'));
  for (const f of ['lib/agents-view.js', 'lib/webview-html.js', 'media/agents.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/'(webview\.[\w.]+)'/g)) {
      if (m[1].endsWith('.')) continue; // 拼出来的前缀，例如 'webview.zone.' + zone
      assert.ok(m[1] in en, f + ' 用了不存在的词条 ' + m[1]);
    }
  }
  for (const z of ['consider', 'act']) for (const suf of ['', '.tip']) assert.ok(('webview.zone.' + z + suf) in en);
});

test('l10n/webview.en.json：键都以 webview. 开头、值是字符串、没有中日韩字符', () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'webview.en.json'), 'utf8'));
  for (const [k, v] of Object.entries(en)) {
    assert.ok(k.startsWith('webview.'), k);
    assert.strictEqual(typeof v, 'string', k);
    assert.ok(!/[぀-ヿ㐀-鿿가-힯]/.test(v), '英文词典里有中日韩字符：' + k);
  }
});

// ---------- WebviewViewProvider（vscode 桩） ----------

function makeStub() {
  const log = { commands: [], clipboard: [], info: [], warn: [], opened: [], posted: [] };
  const listeners = { msg: null, vis: null, dispose: null };
  const Uri = {
    file: (p) => ({ scheme: 'file', fsPath: p, toString: () => 'file://' + p }),
    joinPath: (u, ...parts) => ({ fsPath: path.join(u.fsPath, ...parts), toString() { return 'file://' + this.fsPath; } }),
  };
  const vscode = {
    Uri,
    commands: { executeCommand: (...a) => { log.commands.push(a); return Promise.resolve(); } },
    env: { clipboard: { writeText: (t) => { log.clipboard.push(t); return Promise.resolve(); } } },
    window: {
      showInformationMessage: (m) => { log.info.push(m); },
      showWarningMessage: (m) => { log.warn.push(m); },
      showTextDocument: (u, o) => { log.opened.push([u.fsPath, o]); },
    },
  };
  const view = {
    visible: true,
    webview: {
      options: null, html: '', cspSource: 'vscode-webview://stub',
      asWebviewUri: (u) => ({ toString: () => 'vscode-webview://stub' + u.fsPath }),
      postMessage: (m) => { log.posted.push(JSON.parse(JSON.stringify(m))); return Promise.resolve(true); },
      onDidReceiveMessage: (fn) => { listeners.msg = fn; return { dispose() {} }; },
    },
    onDidChangeVisibility: (fn) => { listeners.vis = fn; return { dispose() {} }; },
    onDidDispose: (fn) => { listeners.dispose = fn; return { dispose() {} }; },
  };
  const context = { extensionUri: { fsPath: ROOT } };
  return { vscode, view, context, log, listeners };
}

test('provider：ready 之后才发；同样的视图模型不重发；不可见时不发', () => {
  const st = makeStub();
  const visible = [];
  const p = new AV.AgentsViewProvider(st.context, { vscode: st.vscode, i18n, version: '0.3.0', onDidChangeVisibility: (v) => visible.push(v) });
  p.resolveWebviewView(st.view);
  assert.ok(st.view.webview.html.includes('script-src &#39;nonce-'));
  assert.deepStrictEqual(st.view.webview.options.localResourceRoots.map((u) => u.fsPath), [path.join(ROOT, 'media')]);
  assert.deepStrictEqual(visible, [true]);
  const s = session();
  p.update({ session: s, now: NOW, loaded: true });
  assert.strictEqual(st.log.posted.length, 0, 'ready 之前不发');
  st.listeners.msg({ type: 'ready', expanded: { [s.key]: ['main'] } });
  assert.strictEqual(st.log.posted.length, 1);
  assert.strictEqual(st.log.posted[0].sessionKey, s.key);
  assert.ok('main' in st.log.posted[0].detail, 'ready 带来的展开状态生效');
  p.update({ session: s, now: NOW, loaded: true });
  assert.strictEqual(st.log.posted.length, 1, '没变就不重发');
  p.update({ session: s, now: NOW + 2000, loaded: true });
  assert.strictEqual(st.log.posted.length, 2);
  assert.strictEqual(p.shownKey, s.key);
  st.view.visible = false;
  st.listeners.vis();
  assert.deepStrictEqual(visible, [true, false]);
  p.update({ session: s, now: NOW + 4000, loaded: true });
  assert.strictEqual(st.log.posted.length, 2, '不可见时不发');
  st.view.visible = true;
  st.listeners.vis();
  st.listeners.msg({ type: 'ready' });
  assert.strictEqual(st.log.posted.length, 3, '重新可见、页面 ready 后补发');
});

test('provider：expand 立即重发带细节；compact 只转给当前会话', () => {
  const st = makeStub();
  const p = new AV.AgentsViewProvider(st.context, { vscode: st.vscode, i18n });
  p.resolveWebviewView(st.view);
  const s = session({ agents: [sub('a', NOW - MIN)] });
  const detail = { key: s.key, agents: { a: { timeline: [], result: { text: 'R', ms: NOW, source: 'lastText', truncated: false }, files: [], errors: [] } } };
  p.update({ session: s, detail, now: NOW, loaded: true });
  st.listeners.msg({ type: 'ready' });
  st.listeners.msg({ type: 'expand', sessionKey: s.key, rowId: 'a/a', open: true });
  const last = st.log.posted[st.log.posted.length - 1];
  assert.strictEqual(last.detail['a/a'].result.text, 'R');
  st.listeners.msg({ type: 'compact', sessionKey: 'claude:other' });
  assert.strictEqual(st.log.commands.length, 0, '别的会话不转');
  st.listeners.msg({ type: 'compact', sessionKey: s.key });
  assert.deepStrictEqual(st.log.commands, [[AV.COMPACT_COMMAND, s.key]]);
});

test('provider：setAutoCompact / revealTranscript / copyTranscriptPath 只转给当前会话，不带 webview 传来的路径', async () => {
  const st = makeStub();
  const p = new AV.AgentsViewProvider(st.context, { vscode: st.vscode, i18n });
  p.resolveWebviewView(st.view);
  const s = session();
  p.update({ session: s, now: NOW, loaded: true });
  st.listeners.msg({ type: 'ready' });
  for (const type of ['setAutoCompact', 'revealTranscript', 'copyTranscriptPath']) {
    st.listeners.msg({ type, sessionKey: 'claude:other', path: '/etc/passwd' });
  }
  assert.strictEqual(st.log.commands.length, 0, '别的会话不转');
  st.listeners.msg({ type: 'setAutoCompact', sessionKey: s.key });
  st.listeners.msg({ type: 'revealTranscript', sessionKey: s.key, path: '/etc/passwd' });
  st.listeners.msg({ type: 'copyTranscriptPath', sessionKey: s.key, path: '/etc/passwd' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(st.log.commands, [
    [AV.AUTOCOMPACT_COMMAND, s.key], [AV.REVEAL_COMMAND, s.key], [AV.COPY_PATH_COMMAND, s.key],
  ]);
  assert.deepStrictEqual([AV.AUTOCOMPACT_COMMAND, AV.REVEAL_COMMAND, AV.COPY_PATH_COMMAND],
    ['agentMonitor.setAutoCompact', 'agentMonitor.revealTranscript', 'agentMonitor.copyTranscriptPath']);
});

test('provider：copyResume 由扩展重新生成文字；越界、错误形式不复制', async () => {
  const st = makeStub();
  const p = new AV.AgentsViewProvider(st.context, { vscode: st.vscode, i18n });
  p.resolveWebviewView(st.view);
  const s = session({ resume: [{ kind: 'claudeSession', sessionId: '11111111-0000-4000-8000-000000000001', cwd: '/work/demo', entry: 'cli', autoContinue: false, quota: null,
    estimate: { contextTokens: 1, ttl: '1h', cacheLikelyExpired: true, usdIfMiss: 0, usdIfHit: 0 } }] });
  p.update({ session: s, now: NOW, loaded: true });
  st.listeners.msg({ type: 'copyResume', sessionKey: s.key, hintIndex: 5, variant: 'cli' });
  st.listeners.msg({ type: 'copyResume', sessionKey: s.key, hintIndex: 0, variant: 'evil', text: 'rm -rf /' });
  st.listeners.msg({ type: 'copyResume', sessionKey: s.key, hintIndex: '0', variant: 'cli' });
  assert.strictEqual(st.log.clipboard.length, 0);
  st.listeners.msg({ type: 'copyResume', sessionKey: s.key, hintIndex: 0, variant: 'cli', text: 'rm -rf /' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(st.log.clipboard.length, 1);
  assert.ok(st.log.clipboard[0].includes('claude --resume 11111111-0000-4000-8000-000000000001'), st.log.clipboard[0]);
  assert.ok(!st.log.clipboard[0].includes('rm -rf'));
  assert.deepStrictEqual(st.log.info, [i18n.t('resume.copied.cli')]);
});

test('provider：openFile 只打开细节里列出且存在的文件；openTranscript 要 .jsonl 且存在', () => {
  const st = makeStub();
  const p = new AV.AgentsViewProvider(st.context, { vscode: st.vscode, i18n });
  p.resolveWebviewView(st.view);
  const real = path.join(TMP, 'edited.js');
  fs.writeFileSync(real, '// synthetic\n');
  const gone = path.join(TMP, 'gone.js');
  const transcript = path.join(TMP, 'main.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const s = session({ main: agent({ file: transcript }), agents: [sub('x', NOW - MIN, { file: path.join(TMP, 'agent-x.txt') })] });
  const detail = { key: s.key, agents: { main: { timeline: [], result: null, errors: [],
    files: [{ path: real, op: 'edit', count: 1, lastMs: NOW, movedTo: null }, { path: gone, op: 'create', count: 1, lastMs: NOW, movedTo: null }] } } };
  p.update({ session: s, detail, now: NOW, loaded: true });
  st.listeners.msg({ type: 'ready' });
  st.listeners.msg({ type: 'openFile', sessionKey: s.key, rowId: 'main', path: '/etc/hosts' });
  st.listeners.msg({ type: 'openFile', sessionKey: 'claude:other', rowId: 'main', path: real });
  assert.strictEqual(st.log.commands.length, 0, '不在列表里 / 别的会话不打开');
  st.listeners.msg({ type: 'openFile', sessionKey: s.key, rowId: 'main', path: gone });
  assert.strictEqual(st.log.warn.length, 1, '不存在时提示');
  st.listeners.msg({ type: 'openFile', sessionKey: s.key, rowId: 'main', path: real });
  assert.strictEqual(st.log.commands.length, 1);
  assert.strictEqual(st.log.commands[0][0], 'vscode.open');
  assert.strictEqual(st.log.commands[0][1].fsPath, real);
  st.listeners.msg({ type: 'openTranscript', sessionKey: s.key, rowId: 'a/x' });
  assert.strictEqual(st.log.opened.length, 0, '不是 .jsonl 不打开');
  st.listeners.msg({ type: 'openTranscript', sessionKey: s.key, rowId: 'main', file: '/etc/passwd' });
  assert.deepStrictEqual(st.log.opened, [[transcript, { preview: true }]], '路径来自会话数据，不用 webview 传来的');
});

test('行 id → 智能体：主对话、子智能体、工作流智能体；工作流组行和未知 id 为 null', () => {
  const w1 = agent({ id: 'w1', kind: 'workflowAgent' });
  const a = sub('a', NOW);
  const s = session({ agents: [a], workflows: [{ id: 'wf_1', name: 'f', state: 'running', agents: [w1] }] });
  const f = AV._internal.agentForRow;
  assert.strictEqual(f(s, 'main'), s.main);
  assert.strictEqual(f(s, 'a/a'), a);
  assert.strictEqual(f(s, 'wf/wf_1/w1'), w1);
  assert.strictEqual(f(s, 'wf/wf_1'), null);
  assert.strictEqual(f(s, 'a/zzz'), null);
  assert.strictEqual(f(s, 42), null);
});

test('provider：copyResult 复制细节里的结果（页面还没 ready 也能按当前数据找到）；未知消息忽略', async () => {
  const st = makeStub();
  const p = new AV.AgentsViewProvider(st.context, { vscode: st.vscode, i18n });
  p.resolveWebviewView(st.view);
  const s = session();
  p.update({ session: s, detail: { key: s.key, agents: { main: { timeline: [], files: [], errors: [], result: { text: 'Result text', ms: NOW, source: 'lastText', truncated: false } } } }, now: NOW, loaded: true });
  st.listeners.msg({ type: 'copyResult', sessionKey: s.key, rowId: 'main', text: 'other' });
  st.listeners.msg({ type: 'whatever' });
  st.listeners.msg(null);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(st.log.clipboard, ['Result text']);
  assert.deepStrictEqual(st.log.info, [i18n.t('webview.copied')]);
});

// ---------- 会话列表（§11.13，仿终端标签列表） ----------

test('webviewHtml：一个整体——内容区、分隔线、会话列表（listbox，带名字）；初始排法是列表在右', () => {
  const html = webviewHtml({ cspSource: 'c:', asset: (p) => 'a/' + p, nonce: 'N', version: '0.3.0', i18n });
  const app = html.slice(html.indexOf('<div id="app"'));
  assert.ok(/<div id="app" class="app list-right">/.test(html));
  const at = (id) => app.indexOf(`id="${id}"`);
  assert.ok(at('content') > 0 && at('content') < at('sash') && at('sash') < at('slist'), '顺序：内容、分隔线、列表');
  assert.ok(/<main id="content" class="content" tabindex="0" aria-label="Agents">/.test(html), '内容区能 Tab 进去（键盘滚动）');
  assert.ok(/<div id="sash" class="sash" aria-hidden="true"><\/div>/.test(html));
  assert.ok(new RegExp('<div id="sl-box" class="sl-box" role="listbox" tabindex="0" aria-label="' + i18n.t('webview.list') + '">').test(html));
  // 原来的会话条、表格、脚注都在内容区里
  const content = html.slice(html.indexOf('<main id="content"'), html.indexOf('</main>'));
  for (const id of ['empty', 'empty-act', 'sbar', 'grid', 'rows', 'note']) assert.ok(content.includes(`id="${id}"`), id);
  assert.ok(content.includes('<footer'), '脚注在内容区里');
});

test('§11.14 会话条两行：摘要行放状态、上下文、分区、缓存、本会话费用和 [继续]、[详情]；其余收进默认收起的详情', () => {
  const html = webviewHtml({ cspSource: 'c:', asset: (p) => 'a/' + p, nonce: 'N', version: '0.3.0', i18n });
  const sbar = html.slice(html.indexOf('<section id="sbar"'), html.indexOf('</section>'));
  const sum = sbar.slice(sbar.indexOf('class="s-line s-sum"'), sbar.indexOf('id="s-urgent"'));
  for (const id of ['s-status', 's-ctx', 's-zone', 's-cache', 's-cost', 's-resumebtn', 's-more']) assert.ok(sum.includes(`id="${id}"`), '摘要行里有 ' + id);
  assert.ok(/id="s-more"[^>]*data-act="toggleDetails"[^>]*aria-expanded="false"[^>]*aria-controls="s-details"/.test(sum), '[详情] 默认收起');
  assert.ok(/id="s-resumebtn"[^>]*data-act="showResume"[^>]*hidden[^>]*aria-label="/.test(sum), '[继续] 默认隐藏，窄时只剩图标也有名字');
  assert.ok(/<div id="s-urgent" class="s-line s-urgent" role="alert" hidden>/.test(sbar), '紧急横幅默认隐藏');
  const det = sbar.slice(sbar.indexOf('<div id="s-details"'));
  assert.ok(/^<div id="s-details" class="s-details" hidden>/.test(det), '详情默认收起');
  for (const id of ['s-ctxline', 's-meter', 's-acline', 's-autocompact', 's-costline', 's-today', 's-banners', 's-resume', 's-storeline']) assert.ok(det.includes(`id="${id}"`), '详情里有 ' + id);
  for (const k of ['webview.details', 'webview.resumeShort']) assert.notStrictEqual(i18n.t(k), k, '词条 ' + k);
});

test('标题行「压缩…」左边是“上下文 N%”（占窗口，会话列表不再写这段）', () => {
  const html = webviewHtml({ cspSource: 'c:', asset: (p) => 'a/' + p, nonce: 'N', version: '0.3.0', i18n });
  const head = html.slice(html.indexOf('class="s-line s-head"'), html.indexOf('class="s-line s-sum"'));
  assert.ok(/id="s-headctx"[^>]*hidden[\s\S]*id="s-compact"/.test(head), '在压缩按钮前，默认隐藏');
  const c = build(session({ main: agent({ tokens: tokens(140000, { contextWindow: 200000, compactAt: 167000 }) }), contextWindow: 200000, compactAt: 167000 })).session.context;
  assert.strictEqual(c.shortText, i18n.t('row.context', { pct: '70%' }));
  assert.strictEqual(build(session({ main: agent({ tokens: null }) })).session.context.shortText, '', '没有 token 就不显示');
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'agents.js'), 'utf8');
  assert.ok(/txt\(E\.headCtx, c\.shortText\)/.test(js) && /show\(E\.headCtx, !!c\.shortText\)/.test(js));
});

test('§11.14 样式：表头固定；面板矮（body.short）时藏费用、用时两列，窄内容区里仍是两列排法', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'agents.css'), 'utf8');
  assert.ok(/\.row\.head \{\s*position: sticky;\s*top: 0;/.test(css), '表头 sticky');
  assert.ok(/body\.short \.c-cost, body\.short \.c-time \{ display: none; \}/.test(css), '矮面板藏两列');
  assert.ok(/\.row, body\.no-cost \.row, body\.short \.row \{ grid-template-columns: minmax\(0, 1fr\) clamp/.test(css), '窄内容区的排法压过 body.short');
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'agents.js'), 'utf8');
  assert.ok(/classList\.toggle\('short', window\.innerHeight < 400\)/.test(js), '高度 < 400 才算矮');
});

test('session-list.js 宽度：按终端的规则吸附（< 63 → 46，63–80 → 80，最宽 500，非数字 → 200）', () => {
  assert.deepStrictEqual(LS.WIDTH, { DEFAULT: 200, NARROW: 46, MIN: 80, MAX: 500, AUTO_NARROW_PANEL: 500, MIN_CONTENT: 300 });
  assert.strictEqual(LS.MIDPOINT, 63);
  const cases = [[0, 200], [-5, 200], ['x', 200], [null, 200], [10, 46], [62.9, 46], [63, 80], [79, 80], [80, 80], [199.6, 200], [260, 260], [500, 500], [2000, 500]];
  for (const [w, want] of cases) assert.strictEqual(LS.snapWidth(w), want, String(w));
});

test('session-list.js 实际宽度：面板 < 500 自动窄条（不能拖）；存的是窄条就窄条；给内容区留 300', () => {
  assert.deepStrictEqual(LS.effectiveWidth(300, 499), { width: 46, narrow: true, auto: true });
  assert.deepStrictEqual(LS.effectiveWidth(46, 1300), { width: 46, narrow: true, auto: false });
  assert.deepStrictEqual(LS.effectiveWidth(200, 1300), { width: 200, narrow: false, auto: false });
  assert.deepStrictEqual(LS.effectiveWidth(300, 1300), { width: 300, narrow: false, auto: false });
  assert.deepStrictEqual(LS.effectiveWidth(500, 700), { width: 400, narrow: false, auto: false }, '700 宽的面板：列表最多 700 − 300');
  assert.deepStrictEqual(LS.effectiveWidth(300, 500), { width: 200, narrow: false, auto: false }, '500 宽的面板：列表最多 200');
  assert.deepStrictEqual(LS.effectiveWidth(null, 760), { width: 200, narrow: false, auto: false }, '没存过用默认 200');
  assert.strictEqual(LS.effectiveWidth(260, 0).width, 260, '还不知道面板多宽时按存的来');
  assert.strictEqual(LS.dragWidth('right', 1000, 1300), 300, '列表在右：面板宽 − 指针位置');
  assert.strictEqual(LS.dragWidth('left', 180, 1300), 180, '列表在左：指针位置');
});

test('session-list.js 键盘：↑ ↓ Home End PageUp PageDown 移动焦点（夹在两端）；其它键不处理', () => {
  const m = LS.moveIndex;
  assert.strictEqual(m('ArrowDown', -1, 5), 0, '还没有焦点：落在第一行');
  assert.strictEqual(m('ArrowUp', -1, 5), 0);
  assert.strictEqual(m('ArrowDown', 1, 5), 2);
  assert.strictEqual(m('ArrowDown', 4, 5), 4, '到底不回绕');
  assert.strictEqual(m('ArrowUp', 0, 5), 0);
  assert.strictEqual(m('Home', 3, 5), 0);
  assert.strictEqual(m('End', 0, 5), 4);
  assert.strictEqual(m('PageDown', 0, 50, 10), 10);
  assert.strictEqual(m('PageUp', 5, 50, 10), 0);
  assert.strictEqual(m('PageDown', 45, 50, 10), 49);
  assert.strictEqual(m('ArrowDown', 9, 5), 0, '越界的焦点当没有');
  assert.strictEqual(m('Enter', 1, 5), -1);
  assert.strictEqual(m('a', 1, 5), -1);
  assert.strictEqual(m('ArrowDown', 0, 0), -1, '空列表');
});

test('session-list.js 首字母跳转：不分大小写、从下一行找、回绕；连按同一字母轮换；连打几个字按前缀、不乱跳', () => {
  const labels = ['Alpha chat', 'beta chat', 'Gamma thread', 'Beta two', 'alpine', '修复登录'];
  const ta = LS.typeAhead;
  assert.strictEqual(ta(labels, -1, 'b'), 1);
  assert.strictEqual(ta(labels, 1, 'b'), 3, '从下一行找');
  assert.strictEqual(ta(labels, 3, 'B'), 1, '回绕、不分大小写');
  assert.strictEqual(ta(labels, 0, 'aa'), 4, '连按同一字母：轮到下一个 a 开头的');
  assert.strictEqual(ta(labels, 4, 'aaa'), 0);
  assert.strictEqual(ta(labels, 0, 'al'), 0, '多打一个字母仍匹配当前行：焦点不动');
  assert.strictEqual(ta(labels, 0, 'alpi'), 4);
  assert.strictEqual(ta(labels, 2, 'z'), -1);
  assert.strictEqual(ta(labels, 0, '修'), 5, '中日韩标题也能跳');
  assert.strictEqual(ta([], 0, 'a'), -1);
  assert.strictEqual(ta(labels, 0, ''), -1);
});

test('session-list.js 增量同步：同一个 key 同一个节点，只新建新的、只删掉没了的，顺序没变不挪；reuse 可以从别处拿现成节点', () => {
  class N {
    constructor(k) { this.k = k; this.parent = null; this.kids = []; this.moves = 0; }
    get children() { return this.kids.slice(); }
    get firstChild() { return this.kids[0] || null; }
    get nextSibling() { const k = this.parent ? this.parent.kids : []; return k[k.indexOf(this) + 1] || null; }
    insertBefore(n, ref) { if (n.parent) n.parent.kids.splice(n.parent.kids.indexOf(n), 1); const i = ref ? this.kids.indexOf(ref) : -1; this.kids.splice(i < 0 ? this.kids.length : i, 0, n); n.parent = this; this.moves++; }
    remove() { if (this.parent) { this.parent.kids.splice(this.parent.kids.indexOf(this), 1); this.parent = null; } }
  }
  const box = new N('box');
  const made = [];
  const sync = (keys, reuse) => LS.syncKeyed(box, keys, (k) => k, (k) => { made.push(k); return new N(k); }, (n, k) => { n.v = k; }, reuse);
  sync(['a', 'b', 'c']);
  const [a, b, c] = box.kids;
  const moves = box.moves;
  sync(['a', 'b', 'c']);
  assert.strictEqual(box.moves, moves, '顺序没变不挪');
  sync(['a', 'x', 'b', 'c']);
  assert.deepStrictEqual(made, ['a', 'b', 'c', 'x']);
  assert.deepStrictEqual(box.kids.map((n) => n.k), ['a', 'x', 'b', 'c']);
  assert.ok(box.kids[0] === a && box.kids[2] === b && box.kids[3] === c);
  sync(['c', 'a']);
  assert.deepStrictEqual(box.kids.map((n) => n.k), ['c', 'a']);
  assert.ok(box.kids[0] === c && box.kids[1] === a, '换位也是同一个节点');
  const spare = new N('z');
  sync(['c', 'a', 'z'], (k) => (k === 'z' ? spare : null));
  assert.strictEqual(box.kids[2], spare, 'reuse 给的节点被挪进来，没有新建');
  assert.ok(!made.includes('z'));
});

test('会话列表视图模型：data-vscode-context 的内容；只有一组时不出组标签；选中只认列表里有的 key', () => {
  const order = createSessionOrder({ now: () => NOW });
  const open = session({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Open one', live: true, liveStatus: 'busy', main: agent({ tokens: tokens(120000) }) });
  const done = session({ id: 'aaaaaaaa-0000-4000-8000-000000000002', title: 'Done one', startedMs: NOW - 200 * MIN, doneAtMs: NOW - MIN,
    main: agent({ status: S.makeStatus('done', NOW - MIN), tokens: tokens(5000) }),
    resume: [{ kind: 'claudeSession', sessionId: 'aaaaaaaa-0000-4000-8000-000000000002', cwd: '/work/demo', entry: 'cli', autoContinue: null, quota: null, estimate: null }] });
  const list = [open, done];
  const vm = AV.buildSessionList({ arranged: order.arrange(list), lamps: lamp.computeLamps(list, { seen: 0 }).bySession, i18n, now: NOW, selectedKey: done.key, position: 'right', width: 210 });
  assert.strictEqual(vm.type, 'list');
  assert.strictEqual(vm.selectedKey, done.key);
  assert.strictEqual(vm.width, 210);
  const rows = vm.items.filter((x) => x.kind === 'session');
  assert.deepStrictEqual(rows.map((r) => r.key), [open.key, done.key]);
  assert.deepStrictEqual(JSON.parse(rows[0].context), { webviewSection: 'session', sessionKey: open.key, compactable: true, resumable: false, preventDefaultContextMenuItems: true });
  assert.deepStrictEqual(JSON.parse(rows[1].context), { webviewSection: 'session', sessionKey: done.key, compactable: false, resumable: true, preventDefaultContextMenuItems: true });
  assert.strictEqual(vm.items.filter((x) => x.kind === 'group').length, 2);
  const one = AV.buildSessionList({ arranged: createSessionOrder().arrange([done]), i18n, now: NOW, selectedKey: 'claude:nope' });
  assert.strictEqual(one.showGroups, false);
  assert.ok(one.items.every((x) => x.kind === 'session'));
  assert.strictEqual(one.selectedKey, null);
  assert.deepStrictEqual(AV.buildSessionList({ i18n }).items, [], '还没有数据：空列表');
});

test('位置：sessionListPosition = left / right 直接用；auto 跟随终端标签列表（terminal.integrated.tabs.location，缺省 right）', () => {
  const r = AV.resolveListPosition;
  assert.strictEqual(r('left', 'right'), 'left');
  assert.strictEqual(r('right', 'left'), 'right');
  assert.strictEqual(r('auto', 'left'), 'left');
  assert.strictEqual(r('auto', 'right'), 'right');
  assert.strictEqual(r('auto', undefined), 'right');
  assert.strictEqual(r(undefined, 'left'), 'left');
  assert.strictEqual(r('bogus', 'bogus'), 'right');
});

test('会话菜单：SESSION_MENU 与 package.json 的 webview/context 一一对应（命令、顺序、分组、when）；按标记过滤', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const menu = pkg.contributes.menus['webview/context'];
  const base = "webviewId == 'agentMonitor.agents' && webviewSection == 'session'";
  assert.deepStrictEqual(menu.map((m) => m.command), AV.SESSION_MENU.map((m) => m.command));
  menu.forEach((m, i) => {
    const d = AV.SESSION_MENU[i];
    assert.strictEqual(m.when, d.when ? `${base} && ${d.when}` : base, m.command);
    assert.ok(m.group.startsWith(d.group + '@'), m.group);
  });
  assert.deepStrictEqual(AV.SESSION_MENU.map((m) => m.command.replace('agentMonitor.', '')),
    ['compact', 'handoff', 'setAutoCompact', 'copyResume', 'markSeen', 'openTranscript', 'revealTranscript', 'copyTranscriptPath']);
  const names = (f) => AV.sessionMenuItems(f).map((m) => m.command.replace('agentMonitor.', ''));
  assert.deepStrictEqual(names({}), ['handoff', 'setAutoCompact', 'markSeen', 'openTranscript', 'revealTranscript', 'copyTranscriptPath']);
  assert.ok(names({ compactable: true }).includes('compact') && !names({ compactable: true }).includes('copyResume'));
  assert.ok(names({ resumable: true }).includes('copyResume'));
  assert.deepStrictEqual(AV._internal.flagsOf('session provider-claude lamp-idle resumable compactable'), { compactable: true, resumable: true });
  assert.deepStrictEqual(AV._internal.flagsOf('session lamp-compactable'), { compactable: false, resumable: false }, '按整词匹配');
});

test('内容区空状态：只看工作区而工作区里没有会话时带“显示所有会话”；读取中不带', () => {
  const vm = AV.buildViewModel({ session: null, i18n, loaded: true, emptyText: 'x', emptyAction: 'showAll' });
  assert.deepStrictEqual(vm.emptyAction, { act: 'showAll', text: i18n.t('scope.showAll') });
  assert.strictEqual(AV.buildViewModel({ session: null, i18n, loaded: false, emptyAction: 'showAll' }).emptyAction, null);
  assert.strictEqual(AV.buildViewModel({ session: null, i18n, loaded: true }).emptyAction, null);
});

test('media/agents.js 接线：listbox 键盘、Enter / 空格选中、首字母、data-vscode-context、悬停时不改提示、分隔线拖动与双击、宽度存 state 并发给扩展', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'agents.js'), 'utf8');
  assert.ok(js.includes("const LS = window.AgentMonitorList;") && js.includes('const syncKeyed = LS.syncKeyed;'), '用 session-list.js 的纯函数');
  assert.ok(/role: 'option'/.test(js) && /'aria-selected'/.test(js) && /'aria-activedescendant'/.test(js));
  assert.ok(/e\.key === 'Enter' \|\| e\.key === ' '/.test(js), 'Enter / 空格选中');
  assert.ok(/LS\.moveIndex\(e\.key/.test(js) && /LS\.typeAhead\(/.test(js));
  assert.ok(/e\.key === 'ContextMenu' \|\| \(e\.shiftKey && e\.key === 'F10'\)/.test(js), '菜单键 / Shift+F10 打开“…”');
  assert.ok(/at\(el, 'data-vscode-context', it\.context\)/.test(js));
  assert.ok(/el\.matches\(':hover'\)/.test(js) && /mouseleave/.test(js), '悬停时不改 title，离开后再换');
  assert.ok(/postMessage\(\{ type: 'select', sessionKey: key \}\)/.test(js));
  assert.ok(/type: act === 'rowCompact' \? 'compact' : 'more', sessionKey: row\._data\.key/.test(js), '行尾按钮只发类型和 key');
  assert.ok(/postMessage\(\{ type: 'resizeList', width: savedWidth \}\)/.test(js) && /state\.listWidth = savedWidth/.test(js));
  assert.ok(/addEventListener\('dblclick', \(\) => saveWidth\(LS\.WIDTH\.DEFAULT\)\)/.test(js), '双击复位');
  assert.ok(/setPointerCapture/.test(js) && /LS\.dragWidth\(position, e\.clientX, panel\)/.test(js));
  // 右键菜单交给 VS Code：页面的 contextmenu 处理不能 preventDefault
  const ctx = js.slice(js.indexOf("E.box.addEventListener('contextmenu'"), js.indexOf("E.box.addEventListener('contextmenu'") + 300);
  assert.ok(ctx.length > 50 && !ctx.includes('preventDefault'), ctx);
  // 内容区自己滚动
  assert.ok(!/window\.scrollTo|window\.scrollY/.test(js) && /E\.content\.scrollTop/.test(js));
});

test('media/agents.css：分隔线颜色取主题变量（高对比 contrastBorder → 终端里那条线的 editorOverviewRuler.border → panel-border）、热区 4px + sash.hoverBorder；行 22px、左内边距 8px；状态色走 list.* 变量；不用 opacity', () => {
  const css = fs.readFileSync(path.join(ROOT, 'media', 'agents.css'), 'utf8');
  // UX 核对时按用户截图改过：终端面板里看到的竖线是概览标尺的边框，比 panel-border 深一档；没有这些变量时仍退回 panel-border
  assert.ok(/--list-line: var\(--vscode-contrastBorder, var\(--vscode-editorOverviewRuler-border, var\(--vscode-panel-border/.test(css));
  assert.ok(/\.list-right \.slist \{ border-left: 1px solid var\(--list-line\); \}/.test(css) && /\.list-left \.slist \{ border-right: 1px solid var\(--list-line\); \}/.test(css));
  assert.ok(/--sash-hover: var\(--vscode-sash-hoverBorder/.test(css));
  const sash = css.slice(css.indexOf('.sash::before {'), css.indexOf('}', css.indexOf('.sash::before {')));
  assert.ok(/width: 4px;/.test(sash) && /cursor: ew-resize;/.test(sash), sash);
  const row = css.slice(css.indexOf('.sl-row {'), css.indexOf('}', css.indexOf('.sl-row {')));
  assert.ok(/height: var\(--row-h\);/.test(row) && /padding: 0 4px 0 8px;/.test(row), row);
  for (const v of ['list-hoverBackground', 'list-activeSelectionBackground', 'list-activeSelectionForeground', 'list-inactiveSelectionBackground',
    'list-inactiveSelectionForeground', 'list-focusOutline', 'contrastActiveBorder']) assert.ok(css.includes('--vscode-' + v), v);
  assert.ok(!/opacity\s*:/.test(css), '不用 opacity 调暗');
  assert.ok(/\.slist\.narrow \.sl-title, \.slist\.narrow \.sl-desc, \.slist\.narrow \.sl-acts \{ display: none !important; \}/.test(css), '窄条只有图标');
  assert.ok(/\.sl-desc \{ flex: none;/.test(css) && /\.sl-desc:empty \{ display: none; \}/.test(css), '标题后只接区标记，没有时不占地方');
});

test('media/agents.css（对照用户终端截图）：线和行之间空 10px（窄条不空）、图标与文字 4px；会话条的来源一段不剩孤零零的字母，窄内容区不显示', () => {
  const css = fs.readFileSync(path.join(ROOT, 'media', 'agents.css'), 'utf8');
  // 终端面板里那条竖线和标签行之间隔着 10px 的概览标尺
  assert.ok(/\.list-right \.slist:not\(\.narrow\) \{ padding-left: 10px; \}/.test(css), '列表在右：左边空 10px');
  assert.ok(/\.list-left \.slist:not\(\.narrow\) \{ padding-right: 10px; \}/.test(css), '列表在左：右边空 10px');
  // 终端标签是“图标 + 空格 + 名字”，量出来 4px；标题和短状态之间仍是 6px
  const row = css.slice(css.indexOf('.sl-row {'), css.indexOf('}', css.indexOf('.sl-row {')));
  assert.ok(/gap: 4px;/.test(row), row);
  assert.ok(/\.sl-desc \{[^}]*margin-left: 2px;/.test(css), '短状态前多空 2px');
  // 来源 · 入口 · 模型 · 目录：放不下时至少留几个字加省略号；窄内容区整段不显示（列表行的悬停提示里有同样的信息）
  assert.ok(/\.s-head \.s-meta \{[^}]*min-width: 4em;/.test(css));
  const narrow = css.slice(css.indexOf('@container content (max-width: 699px)'));
  assert.ok(/\.s-head \.s-meta \{ display: none; \}/.test(narrow), '窄内容区不显示来源一段');
});

function listFixture() {
  const order = createSessionOrder({ now: () => NOW });
  const a = session({ id: 'aaaaaaaa-0000-4000-8000-00000000000a', title: 'Alpha', live: true, main: agent({ tokens: tokens(120000) }) });
  const b = session({ id: 'aaaaaaaa-0000-4000-8000-00000000000b', title: 'Beta', startedMs: NOW - 300 * MIN });
  const list = [a, b];
  return { a, b, input: { arranged: order.arrange(list), lamps: lamp.computeLamps(list, { seen: 0 }).bySession, now: NOW, selectedKey: a.key, position: 'right', width: 200 } };
}

test('provider 列表消息：ready 后先发 list 再发 render；没变不重发；位置 / 宽度 / 选中变了才重发', () => {
  const st = makeStub();
  const p = new AV.AgentsViewProvider(st.context, { vscode: st.vscode, i18n });
  p.resolveWebviewView(st.view);
  const { a, b, input } = listFixture();
  p.updateList(input);
  p.update({ session: a, now: NOW, loaded: true });
  assert.strictEqual(st.log.posted.length, 0, 'ready 之前不发');
  st.listeners.msg({ type: 'ready' });
  assert.deepStrictEqual(st.log.posted.map((m) => m.type), ['list', 'render']);
  assert.deepStrictEqual(st.log.posted[0].items.filter((x) => x.kind === 'session').map((x) => x.key), [a.key, b.key]);
  p.updateList({ ...input, now: NOW + 7000 });
  assert.strictEqual(st.log.posted.length, 2, '列表没变：不重发');
  p.updateList({ ...input, selectedKey: b.key });
  assert.strictEqual(st.log.posted.length, 3);
  assert.strictEqual(st.log.posted[2].selectedKey, b.key);
  p.updateList({ ...input, selectedKey: b.key, position: 'left' });
  assert.strictEqual(st.log.posted[3].position, 'left');
  p.updateList({ ...input, selectedKey: b.key, position: 'left', width: 70 });
  assert.strictEqual(st.log.posted[4].width, 80, '宽度吸附后发');
  assert.strictEqual(st.log.posted.length, 5);
});

test('provider 列表消息：select / more 只认列表里的 key；resizeList 吸附后交给扩展；ready 带宽度时同步；showAll 执行“显示所有会话”', async () => {
  const st = makeStub();
  const calls = { select: [], resize: [], more: [] };
  const p = new AV.AgentsViewProvider(st.context, {
    vscode: st.vscode, i18n,
    onSelect: (k) => calls.select.push(k), onResizeList: (w) => calls.resize.push(w), onMore: (k) => calls.more.push(k),
  });
  p.resolveWebviewView(st.view);
  const { a, b, input } = listFixture();
  p.updateList(input);
  p.update({ session: a, now: NOW, loaded: true });
  st.listeners.msg({ type: 'ready', listWidth: 62 });
  assert.deepStrictEqual(calls.resize, [46], 'ready 带来的宽度（页面 state）按规则吸附后同步给扩展');
  st.listeners.msg({ type: 'select', sessionKey: b.key });
  st.listeners.msg({ type: 'select', sessionKey: 'claude:not-listed' });
  st.listeners.msg({ type: 'select', sessionKey: 42 });
  assert.deepStrictEqual(calls.select, [b.key]);
  st.listeners.msg({ type: 'more', sessionKey: b.key });
  st.listeners.msg({ type: 'more', sessionKey: 'claude:not-listed' });
  assert.deepStrictEqual(calls.more, [b.key]);
  st.listeners.msg({ type: 'resizeList', width: 333.4 });
  st.listeners.msg({ type: 'resizeList', width: '300' });
  st.listeners.msg({ type: 'resizeList', width: Infinity });
  st.listeners.msg({ type: 'resizeList', width: 9999 });
  assert.deepStrictEqual(calls.resize, [46, 333, 500]);
  // 列表行尾的压缩：列表里的任一会话都行（不一定是正在显示的）
  st.listeners.msg({ type: 'compact', sessionKey: b.key });
  st.listeners.msg({ type: 'compact', sessionKey: 'claude:not-listed' });
  st.listeners.msg({ type: 'showAll' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(st.log.commands, [[AV.COMPACT_COMMAND, b.key], [AV.SHOW_ALL_COMMAND]]);
  assert.strictEqual(AV.SHOW_ALL_COMMAND, 'agentMonitor.scope.all');
});

test('provider 徽标与说明：挂在 webview 视图上；视图还没建好时先记着，建好后补上', () => {
  const st = makeStub();
  const p = new AV.AgentsViewProvider(st.context, { vscode: st.vscode, i18n });
  p.setBadge({ value: 2, tooltip: '2 need you' });
  p.setDescription('This workspace');
  assert.strictEqual(st.view.badge, undefined);
  p.resolveWebviewView(st.view);
  assert.deepStrictEqual(st.view.badge, { value: 2, tooltip: '2 need you' });
  assert.strictEqual(st.view.description, 'This workspace');
  p.setBadge(undefined);
  p.setDescription(undefined);
  assert.strictEqual(st.view.badge, undefined);
  assert.strictEqual(st.view.description, undefined);
});

// ---------- 收尾 ----------

Promise.all(pending).then(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
});
