'use strict';
// 表现层核心的测试：lib/lamp.js、lib/seen.js、lib/scope.js、lib/order.js、lib/format.js、l10n/views.en.json。
// 纯 node 运行：node test/present.test.js。数据全部是合成的，不读 ~/.claude、~/.codex，不写任何文件。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const S = require('../lib/core/status');
const i18nLib = require('../lib/i18n');
const lamp = require('../lib/lamp');
const seen = require('../lib/seen');
const scope = require('../lib/scope');
const order = require('../lib/order');
const fmt = require('../lib/format');

// ---------- 小工具 ----------

const results = [];
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { results.push(true); console.log(`  ok    ${name}`); },
        (err) => fail(name, err)));
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
const HOUR = 3600e3;
const LOCALES = ['en', 'zh-cn', 'zh-tw', 'ko', 'ja'];
const PLACEHOLDER = /\{\w+\}/;

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
    costUsd: 0.42, unpricedModel: null, lastCompact: null, cacheTtl: '1h',
    startedMs: NOW - 2 * HOUR, lastActivityMs: NOW - 5000, mtimeMs: NOW - 5000, file: '/synthetic/main.jsonl',
    ...o,
  };
}
function session(o = {}) {
  const provider = o.provider || 'claude';
  const id = o.id || 'sess-1';
  return {
    provider, id, key: `${provider}:${id}`,
    title: 'Synthetic session', titleSource: 'ai',
    cwd: '/work/proj', projectDir: '-work-proj',
    entry: 'vscode', entryRaw: 'claude-vscode', entrypoint: 'claude-vscode',
    model: 'claude-opus-5-5', createdMs: NOW - 2 * HOUR, updatedMs: NOW - 5000, startedMs: NOW - 2 * HOUR,
    doneAtMs: null, live: false, liveStatus: null, waitingFor: null,
    main: agent(), agents: [], workflows: [],
    counts: { running: 1, awaiting: 0, error: 0, done: 0, total: 1 },
    costUsd: 1.23, resume: [],
    ...o,
  };
}
const st = (code, sinceMs, extra) => S.makeStatus(code, sinceMs, extra);

// ---------- 灯 ----------

function lampTests() {
  test('§3.2 状态码 → 智能体灯（含确定 / 推测两种等待）', () => {
    const want = {
      starting: 'working', thinking: 'working', tool: 'working', retrying: 'working', idleBackground: 'working',
      awaitingApproval: 'needsYou', awaitingInput: 'needsYou', dialogOpen: 'needsYou', maybeAwaitingApproval: 'needsYou',
      done: 'doneUnseen', interrupted: 'idle', killed: 'idle', stale: 'idle', quota: 'error', apiError: 'error',
    };
    for (const code of S.STATUS_CODES) {
      assert.strictEqual(lamp.agentLamp({ status: st(code, NOW) }), want[code], code);
    }
    assert.strictEqual(lamp.agentLamp({ status: null }), 'idle');
    // stale 带未完成工具：默认 Idle；显式 staleAsNeedsYou 才 NeedsYou
    const stale = { status: st('stale', NOW, { stalePending: true, pendingTool: 'Bash' }) };
    assert.strictEqual(lamp.agentLamp(stale), 'idle');
    assert.strictEqual(lamp.agentLamp(stale, { staleAsNeedsYou: true }), 'needsYou');
    assert.strictEqual(st('maybeAwaitingApproval', NOW).certainty, 'guess');
    assert.strictEqual(st('awaitingApproval', NOW).certainty, 'certain');
  });

  test('§3.4 已看过：done 且 sinceMs ≤ seenAtMs → DoneSeen；主智能体看 doneAtMs', () => {
    const a = { status: st('done', NOW - 10000) };
    assert.strictEqual(lamp.agentLamp(a, { seenAtMs: 0 }), 'doneUnseen');
    assert.strictEqual(lamp.agentLamp(a, { seenAtMs: NOW - 20000 }), 'doneUnseen');
    assert.strictEqual(lamp.agentLamp(a, { seenAtMs: NOW - 10000 }), 'doneSeen');
    // 主智能体：status.sinceMs 早，但 doneAtMs 晚于 seen → 未看
    assert.strictEqual(lamp.agentLamp(a, { seenAtMs: NOW - 5000, isMain: true, doneAtMs: NOW - 1000 }), 'doneUnseen');
    assert.strictEqual(lamp.agentLamp(a, { seenAtMs: NOW, isMain: true, doneAtMs: NOW - 1000 }), 'doneSeen');
  });

  test('§3.3 会话灯按推导优先级、总灯按显示紧急度', () => {
    const mk = (codes) => session({
      main: agent({ status: st(codes[0], NOW - 1000) }),
      agents: codes.slice(1).map((c, i) => agent({ id: 'sub' + i, kind: 'subagent', name: 'Sub ' + i, status: st(c, NOW - 1000) })),
    });
    assert.strictEqual(lamp.sessionLamps(mk(['thinking', 'maybeAwaitingApproval', 'apiError'])).lamp, 'needsYou');
    assert.strictEqual(lamp.sessionLamps(mk(['thinking', 'apiError'])).lamp, 'error');
    assert.strictEqual(lamp.sessionLamps(mk(['done', 'tool'])).lamp, 'working');
    assert.strictEqual(lamp.sessionLamps(mk(['interrupted', 'done'])).lamp, 'doneUnseen');
    assert.strictEqual(lamp.sessionLamps(mk(['interrupted', 'killed'])).lamp, 'idle');
    // 总灯：DoneUnseen 排在 Working 前面
    assert.strictEqual(lamp.overallLamp(['working', 'doneUnseen', 'idle']), 'doneUnseen');
    assert.strictEqual(lamp.overallLamp(['working', 'doneUnseen', 'error']), 'error');
    assert.strictEqual(lamp.overallLamp([]), 'idle');
    const all = lamp.computeLamps([
      mk(['thinking', 'maybeAwaitingApproval']), { ...mk(['done']), key: 'claude:b', id: 'b' }, { ...mk(['tool']), key: 'claude:c', id: 'c' },
    ]);
    assert.strictEqual(all.overall, 'needsYou');
    assert.deepStrictEqual(all.counts, { needsYou: 1, error: 0, working: 1, doneUnseen: 1, doneSeen: 0, idle: 0 });
    assert.strictEqual(all.attention, 2);
  });

  test('§3.3 例外 1：子智能体看过之前的报错不上浮，主智能体的报错始终上浮', () => {
    const s = session({
      doneAtMs: NOW - 3000,
      main: agent({ status: st('done', NOW - 3000) }),
      agents: [agent({ id: 'x', kind: 'subagent', name: 'Worker', status: st('apiError', NOW - 60000) })],
    });
    assert.strictEqual(lamp.sessionLamps(s, { seenAtMs: 0 }).lamp, 'error', '没看过：上浮');
    const seenL = lamp.sessionLamps(s, { seenAtMs: NOW - 30000 });
    assert.strictEqual(seenL.lamp, 'doneUnseen', '看过之后：报错不上浮，主智能体的新结果仍未看');
    assert.strictEqual(seenL.rows.get('a/x').lamp, 'error', '行本身仍是红灯');
    const mainErr = session({ main: agent({ status: st('quota', NOW - 60000) }) });
    assert.strictEqual(lamp.sessionLamps(mainErr, { seenAtMs: NOW }).lamp, 'error');
  });

  test('§3.3 例外 2：只剩完成的智能体时看主智能体的 doneAtMs', () => {
    const s = session({
      doneAtMs: NOW - 10000,
      main: agent({ status: st('done', NOW - 10000) }),
      agents: [agent({ id: 'late', kind: 'subagent', name: 'Late', status: st('done', NOW - 1000) })],
    });
    assert.strictEqual(lamp.sessionLamps(s, { seenAtMs: NOW - 5000 }).lamp, 'doneSeen');
    assert.strictEqual(lamp.sessionLamps(s, { seenAtMs: NOW - 5000 }).rows.get('a/late').lamp, 'doneUnseen');
    assert.strictEqual(lamp.sessionLamps(s, { seenAtMs: NOW - 20000 }).lamp, 'doneUnseen');
  });

  test('§11.1 登记表：waiting → NeedsYou（确定），busy → Working，推测让位', () => {
    const base = { main: agent({ status: st('stale', NOW - 10 * MIN, { stalePending: true, pendingTool: 'Bash' }) }), live: true };
    for (const [wf, code] of [['permission prompt', 'awaitingApproval'], ['input needed', 'awaitingInput'], ['dialog open', 'dialogOpen']]) {
      const L = lamp.sessionLamps(session({ ...base, liveStatus: 'waiting', waitingFor: wf }));
      assert.strictEqual(L.lamp, 'needsYou', wf);
      assert.strictEqual(L.main.status.code, code, wf);
      assert.strictEqual(L.main.status.certainty, 'certain');
      assert.strictEqual(L.registry, 'waiting');
    }
    // busy：原来 stale（灰）→ Working，状态改写成 tool
    const busy = lamp.sessionLamps(session({ ...base, liveStatus: 'busy' }));
    assert.strictEqual(busy.lamp, 'working');
    assert.strictEqual(busy.main.status.code, 'tool');
    assert.strictEqual(busy.main.status.pendingTool, 'Bash');
    // busy 盖过推测
    const guess = { main: agent({ status: st('maybeAwaitingApproval', NOW - 90000, { pendingTool: 'Edit' }) }), live: true };
    assert.strictEqual(lamp.sessionLamps(session(guess)).lamp, 'needsYou', '没有登记表时推测生效');
    assert.strictEqual(lamp.sessionLamps(session({ ...guess, liveStatus: 'busy' })).lamp, 'working');
    assert.strictEqual(lamp.sessionLamps(session({ ...guess, liveStatus: 'idle' })).lamp, 'idle');
    // busy 保留红灯（撞额度等自动继续）
    assert.strictEqual(lamp.sessionLamps(session({ live: true, liveStatus: 'busy', main: agent({ status: st('quota', NOW) }) })).lamp, 'error');
    // 有登记信号时子智能体的推测也不算
    const sub = session({
      live: true, liveStatus: 'busy', main: agent({ status: st('idleBackground', NOW) }),
      agents: [agent({ id: 's', kind: 'subagent', name: 'S', status: st('maybeAwaitingApproval', NOW - 90000, { pendingTool: 'Read' }) })],
    });
    const subL = lamp.sessionLamps(sub);
    assert.strictEqual(subL.lamp, 'working');
    assert.strictEqual(subL.rows.get('a/s').status.code, 'tool');
    // 进程已退出（live false）：登记表不算；登记表只属于 Claude
    assert.strictEqual(lamp.sessionLamps(session({ ...guess, live: false, liveStatus: 'busy' })).lamp, 'needsYou');
    assert.strictEqual(lamp.sessionLamps(session({ ...guess, provider: 'codex', id: 'th', liveStatus: 'busy' })).lamp, 'needsYou');
    // provider 已经写好同类的确定状态：保留原状态（带 question）
    const ask = session({ live: true, liveStatus: 'waiting', waitingFor: 'input needed', main: agent({ status: st('awaitingInput', NOW - 7000, { question: 'planApproval' }) }) });
    const askL = lamp.sessionLamps(ask);
    assert.strictEqual(askL.main.status.question, 'planApproval');
    assert.strictEqual(askL.main.status.sinceMs, NOW - 7000);
  });

  test('lead：左侧一句话取决定会话灯的那一行，主智能体优先', () => {
    const s = session({
      main: agent({ status: st('thinking', NOW) }),
      agents: [
        agent({ id: 'a', kind: 'subagent', name: 'Alpha', status: st('tool', NOW) }),
        agent({ id: 'b', kind: 'subagent', name: 'Beta', status: st('maybeAwaitingApproval', NOW - 70000, { pendingTool: 'Write' }) }),
      ],
    });
    assert.strictEqual(lamp.sessionLamps(s).lead.rowId, 'a/b');
    s.agents[1].status = st('tool', NOW);
    assert.strictEqual(lamp.sessionLamps(s).lead.rowId, 'main');
  });

  test('工作流行的灯、外观、终端灯', () => {
    const s = session({
      workflows: [{ id: 'wf_1', name: 'Build', state: 'running', agents: [
        agent({ id: 'w1', kind: 'workflowAgent', name: 'W1', status: st('done', NOW) }),
        agent({ id: 'w2', kind: 'workflowAgent', name: 'W2', status: st('quota', NOW) }),
      ] }, { id: 'wf_2', name: 'Empty', state: 'killed', agents: [] }],
    });
    const L = lamp.sessionLamps(s);
    assert.strictEqual(L.rows.get('wf/wf_1').lamp, 'error');
    assert.strictEqual(L.rows.get('wf/wf_1/w1').lamp, 'doneUnseen');
    assert.strictEqual(L.rows.get('wf/wf_2').lamp, 'idle');
    const v = lamp.lampVisual('needsYou');
    assert.strictEqual(v.colorId, 'agentMonitor.lampNeedsYou');
    assert.strictEqual(v.cssVar, '--vscode-agentMonitor-lampNeedsYou');
    assert.strictEqual(v.shape, 'circle-large-filled');
    assert.strictEqual(v.badgeIcon, 'bell');
    assert.strictEqual(lamp.lampVisual('bogus').lamp, 'idle');
    assert.strictEqual(lamp.xtermDot('working'), '\x1b[38;5;39m\u25CF\x1b[0m');
    assert.strictEqual(lamp.xtermDot('doneSeen', { color: false }), '\u25CB');
  });
}

// ---------- 已看过 ----------

function seenTests() {
  test('store：只增不减、一次记多个、reader 读一次', async () => {
    const mem = seen.createMemoryMemento();
    let t = NOW;
    const store = seen.createSeenStore(mem, { now: () => t });
    assert.strictEqual(store.get('claude:a'), 0);
    assert.strictEqual(await store.mark('claude:a'), true);
    assert.strictEqual(store.get('claude:a'), NOW);
    assert.strictEqual(await store.mark('claude:a', NOW - 1000), false, '更早的时间不写');
    assert.strictEqual(store.get('claude:a'), NOW);
    t = NOW + 5000;
    await store.markMany(['claude:a', 'codex:b', '', null]);
    assert.deepStrictEqual(store.all(), { 'claude:a': NOW + 5000, 'codex:b': NOW + 5000 });
    const r = store.reader();
    await store.mark('claude:c', NOW + 9000);
    assert.strictEqual(r('claude:c'), 0, 'reader 是那一刻的快照');
    assert.strictEqual(mem.get(seen.SEEN_KEY)['claude:c'], NOW + 9000, '写在 agentMonitor.seen.v1');
  });

  test('store：清理 14 天前的条目，最多留 1000 条；--seen-all', async () => {
    const init = { 'claude:old': NOW - 15 * 24 * HOUR, 'claude:new': NOW - HOUR };
    for (let i = 0; i < 1005; i++) init['codex:' + i] = NOW - i * 1000;
    const mem = seen.createMemoryMemento({ [seen.SEEN_KEY]: init });
    const store = seen.createSeenStore(mem, { now: () => NOW });
    const removed = await store.prune();
    const left = store.all();
    assert.strictEqual(Object.keys(left).length, 1000);
    assert.ok(!('claude:old' in left));
    assert.strictEqual(removed, 1007 - 1000);
    assert.ok('codex:0' in left && !('codex:1004' in left), '留最新的');
    const all = seen.createSeenStore(seen.createMemoryMemento(), { allSeen: true });
    assert.strictEqual(all.get('x'), seen.ALL_SEEN);
    assert.strictEqual(lamp.agentLamp({ status: st('done', NOW) }, { seenAtMs: all.get('x') }), 'doneSeen');
  });

  test('切换选中后“已看过”跟着变：选 A → A 变 DoneSeen，B 仍 DoneUnseen；再选 B', async () => {
    let t = NOW;
    const store = seen.createSeenStore(seen.createMemoryMemento(), { now: () => t });
    const A = session({ id: 'A', doneAtMs: NOW - 1000, main: agent({ status: st('done', NOW - 1000) }) });
    const B = session({ id: 'B', doneAtMs: NOW - 2000, main: agent({ status: st('done', NOW - 2000) }) });
    const lampsNow = () => {
      const L = lamp.computeLamps([A, B], { seen: store.reader() });
      return [L.bySession.get('claude:A').lamp, L.bySession.get('claude:B').lamp];
    };
    assert.deepStrictEqual(lampsNow(), ['doneUnseen', 'doneUnseen']);
    await store.mark(A.key); // onDidChangeSelection → A
    assert.deepStrictEqual(lampsNow(), ['doneSeen', 'doneUnseen']);
    t += 3000;
    await store.mark(B.key); // 选 B
    assert.deepStrictEqual(lampsNow(), ['doneSeen', 'doneSeen']);
    // A 又跑完一轮：新的 doneAtMs 晚于 seen → 重新未看
    A.doneAtMs = t + 1000;
    A.main.status = st('done', t + 1000);
    assert.deepStrictEqual(lampsNow(), ['doneUnseen', 'doneSeen']);
  });

  test('停留计时：满 1.5 秒才记；中途换走取消；refresh 只记有新内容的', async () => {
    let t = NOW;
    const timers = [];
    const fakeSet = (fn, ms) => { const h = { fn, at: t + ms, done: false }; timers.push(h); return h; };
    const fakeClear = (h) => { h.done = true; };
    const run = () => { for (const h of timers) if (!h.done && h.at <= t) { h.done = true; h.fn(); } };
    const store = seen.createSeenStore(seen.createMemoryMemento(), { now: () => t });
    const marked = [];
    const d = seen.createDwellTracker(store, { now: () => t, setTimeout: fakeSet, clearTimeout: fakeClear, onMarked: (k, src) => marked.push(`${src}:${k}`) });
    d.set('tab', 'claude:A');
    t += 1000; run();
    d.set('tab', 'claude:A'); // 同一个 key 不重新计时
    d.set('tab', 'claude:B'); // 1 秒就换走：A 不算
    t += 1000; run();
    await Promise.resolve();
    assert.strictEqual(store.get('claude:A'), 0);
    t += 600; run();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(store.get('claude:B'), NOW + 1000 + 1000 + 600);
    assert.deepStrictEqual(marked, ['tab:claude:B']);
    d.set('view', null);
    assert.deepStrictEqual(d.active(), { tab: 'claude:B' });
    // 继续盯着看：只有有新内容时才再记
    t += 10000;
    assert.strictEqual(await d.refresh(() => false), false);
    await d.refresh((k) => k === 'claude:B');
    assert.strictEqual(store.get('claude:B'), t);
    d.set('tab', null);
    assert.deepStrictEqual(d.active(), {});
    d.dispose();
  });
}

// ---------- 范围与跟随 ----------

class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }
class TabInputText { constructor(uri) { this.uri = uri; } }
const TYPES = { TabInputWebview, TabInputCustom };
const claudeTab = (label) => ({ label, input: new TabInputWebview('mainThreadWebview-claudeVSCodePanel') });
const codexTab = (id, label = 'Codex') => ({
  label, input: new TabInputCustom({ scheme: 'openai-codex', authority: 'route', path: `/local/${id}` }, 'chatgpt.conversationEditor'),
});
const textTab = () => ({ label: 'index.js', input: new TabInputText({ scheme: 'file', path: '/work/proj/index.js' }) });

function scopeTests() {
  test('范围只有两档；旧值与 onlyWorkspace 的迁移', () => {
    assert.deepStrictEqual(scope.SCOPES, ['all', 'workspace']);
    assert.strictEqual(scope.normalizeScope('workspace'), 'workspace');
    assert.strictEqual(scope.normalizeScope('conversation'), 'workspace');
    assert.strictEqual(scope.normalizeScope('pinned'), 'all');
    assert.strictEqual(scope.normalizeScope(undefined), 'all');
    assert.deepStrictEqual(scope.planScopeMigration({}, { workspaceValue: true, globalValue: false }),
      [{ key: 'scope', value: 'workspace', target: 'workspace' }]);
    assert.deepStrictEqual(scope.planScopeMigration({}, { globalValue: true }), [{ key: 'scope', value: 'workspace', target: 'global' }]);
    assert.deepStrictEqual(scope.planScopeMigration({}, { workspaceValue: false, globalValue: true }), [], '生效的那层是 false');
    assert.deepStrictEqual(scope.planScopeMigration({ globalValue: 'all' }, { globalValue: true }), [], 'scope 设过就不迁移');
    assert.deepStrictEqual(scope.planScopeMigration({ globalValue: 'pinned', workspaceValue: 'conversation' }, undefined), [
      { key: 'scope', value: 'workspace', target: 'workspace' },
      { key: 'scope', value: 'all', target: 'global' },
    ]);
  });

  test('workspace 档：Claude 看目录名或 cwd，Codex 只看 cwd；路径边界；Windows 不分大小写', () => {
    const ws = scope.workspaceInfo([{ uri: { fsPath: '/work/proj' } }, '/other/place/']);
    assert.deepStrictEqual(ws.dirs, ['-work-proj', '-other-place-']);
    const c = (o) => session({ cwd: null, projectDir: null, ...o });
    assert.ok(scope.inWorkspace(c({ projectDir: '-work-proj' }), ws));
    assert.ok(scope.inWorkspace(c({ cwd: '/work/proj/sub/dir' }), ws));
    assert.ok(scope.inWorkspace(c({ cwd: '/other/place' }), ws));
    assert.ok(!scope.inWorkspace(c({ cwd: '/work/project2' }), ws), '/work/proj 不包含 /work/project2');
    assert.ok(!scope.inWorkspace(c({ provider: 'codex', projectDir: '-work-proj', cwd: '/elsewhere' }), ws), 'Codex 不看目录名');
    assert.ok(scope.inWorkspace(c({ provider: 'codex', cwd: '/work/proj' }), ws));
    const win = scope.workspaceInfo(['C:\\Users\\Me\\Proj']);
    assert.ok(scope.inWorkspace(c({ provider: 'codex', cwd: 'c:/users/me/proj/src' }), win));
    // 目录名超过 200 字符：比前 200 个
    const long = '/' + 'x'.repeat(230);
    const lws = scope.workspaceInfo([long]);
    assert.ok(scope.inWorkspace(c({ projectDir: scope.projectDirName(long).slice(0, 200) + '-abc123' }), lws));
    const list = [c({ id: '1', cwd: '/work/proj' }), c({ id: '2', cwd: '/tmp/x' })];
    assert.strictEqual(scope.filterByScope(list, 'all', ws).length, 2);
    assert.deepStrictEqual(scope.filterByScope(list, 'workspace', ws).map((s) => s.id), ['1']);
    assert.deepStrictEqual(scope.filterByScope(list, 'workspace', scope.workspaceInfo(undefined)), []);
  });

  test('§8.4 标签识别：Claude webview、Codex 自定义编辑器、其它', () => {
    assert.deepStrictEqual(scope.classifyTab(claudeTab('  Fix login  '), TYPES), { provider: 'claude', label: 'Fix login' });
    assert.deepStrictEqual(scope.classifyTab(codexTab('th-1', 'Refactor'), TYPES), { provider: 'codex', label: 'Refactor', conversationId: 'th-1' });
    assert.strictEqual(scope.classifyTab(textTab(), TYPES), null);
    assert.strictEqual(scope.classifyTab({ label: 'x', input: new TabInputWebview('mainThreadWebview-other') }, TYPES), null);
    assert.strictEqual(scope.classifyTab(null, TYPES), null);
    // 不传类时按字段判断
    assert.strictEqual(scope.classifyTab(claudeTab('A')).provider, 'claude');
    assert.strictEqual(scope.codexConversationId('openai-codex://route/local/abc-123'), 'abc-123');
    assert.strictEqual(scope.codexConversationId({ path: '/remote/r-9' }), 'r-9');
    assert.strictEqual(scope.codexConversationId({ path: '/settings' }), null);
  });

  test('§8.4 匹配：标题 → 默认标题退回工作区最新 VS Code 会话 → Codex id / thread_name', () => {
    const ws = scope.workspaceInfo(['/work/proj']);
    const long = 'L'.repeat(250);
    const sessions = [
      session({ id: 'c1', title: 'Fix login', updatedMs: NOW - 9000 }),
      session({ id: 'c2', title: 'Fix login', updatedMs: NOW - 1000 }),
      session({ id: 'c3', title: long, updatedMs: NOW - 5000 }),
      session({ id: 'c4', title: 'From prompt', titleSource: 'prompt' }),
      session({ id: 'c5', title: 'CLI one', entry: 'cli', entrypoint: 'cli', updatedMs: NOW }),
      session({ id: 'c6', title: 'Live vscode', live: true, updatedMs: NOW - 60000 }),
      session({ provider: 'codex', id: 'th-1', title: 'Codex thread', titleSource: 'index' }),
    ];
    const m = (tab) => scope.matchChatTab(scope.classifyTab(tab, TYPES), sessions, ws);
    assert.strictEqual(m(claudeTab('Fix login')), 'claude:c2', '重名取最近更新的');
    assert.strictEqual(m(claudeTab('L'.repeat(200))), 'claude:c3', '标题截到 200 码点');
    assert.strictEqual(m(claudeTab('From prompt')), null, '不用提示词标题匹配');
    assert.strictEqual(m(claudeTab('Claude Code')), 'claude:c6', '默认标题：打开中的 VS Code 会话优先');
    assert.strictEqual(m(claudeTab('Unknown')), null);
    assert.strictEqual(m(codexTab('th-1')), 'codex:th-1');
    assert.strictEqual(m(codexTab('zzz', 'Codex thread')), 'codex:th-1', 'id 对不上时按 thread_name');
    assert.strictEqual(m(codexTab('zzz', 'nope')), null);
  });

  test('跟随：只在切标签时移动选中；同一标签的焦点事件、数据刷新都不移动', () => {
    const ws = scope.workspaceInfo(['/work/proj']);
    let t = NOW;
    const A = session({ id: 'A', title: 'Alpha' });
    const B = session({ id: 'B', title: 'Beta' });
    let sessions = [A, B];
    const f = scope.createChatFollower({ types: TYPES, now: () => t });
    assert.strictEqual(f.key, null);
    let r = f.onTabEvent(claudeTab('Alpha'), sessions, ws);
    assert.deepStrictEqual([r.key, r.follow], ['claude:A', true]);
    r = f.onTabEvent(claudeTab('Alpha'), sessions, ws); // 窗口焦点变化，同一标签
    assert.strictEqual(r.follow, false);
    r = f.onSnapshot(claudeTab('Alpha'), sessions, ws);
    assert.strictEqual(r.follow, false, '数据刷新不移动');
    r = f.onTabEvent(textTab(), sessions, ws); // 切去看代码
    assert.deepStrictEqual([r.key, r.follow, r.chat], ['claude:A', false, false], '保持上一次');
    r = f.onTabEvent(claudeTab('Alpha'), sessions, ws); // 切回来：再跟随一次
    assert.strictEqual(r.follow, true);
    r = f.onTabEvent(claudeTab('Beta'), sessions, ws);
    assert.deepStrictEqual([r.key, r.follow], ['claude:B', true]);
    // 新会话：切标签时还不在快照里 → 暂不跟随；下一份快照出现后跟随一次
    r = f.onTabEvent(claudeTab('Gamma'), sessions, ws);
    assert.deepStrictEqual([r.key, r.follow], ['claude:B', false]);
    t += 2000;
    assert.strictEqual(f.onSnapshot(claudeTab('Gamma'), sessions, ws).follow, false);
    sessions = [...sessions, session({ id: 'G', title: 'Gamma' })];
    r = f.onSnapshot(claudeTab('Gamma'), sessions, ws);
    assert.deepStrictEqual([r.key, r.follow], ['claude:G', true]);
    assert.strictEqual(f.onSnapshot(claudeTab('Gamma'), sessions, ws).follow, false, '只跟随一次');
    // 超时后不再补跟随
    f.onTabEvent(claudeTab('Delta'), sessions, ws);
    t += 31000;
    sessions = [...sessions, session({ id: 'D', title: 'Delta' })];
    assert.strictEqual(f.onSnapshot(claudeTab('Delta'), sessions, ws).follow, false);
    // Claude 起好标题（同一标签改名）算切换
    f.onTabEvent(claudeTab('Claude Code'), sessions, ws);
    r = f.onTabEvent(claudeTab('Alpha'), sessions, ws);
    assert.deepStrictEqual([r.key, r.follow], ['claude:A', true]);
  });

  test('右侧显示哪个会话：选中的 → 当前对话 → 第一行', () => {
    const keys = ['claude:a', 'claude:b', 'codex:c'];
    assert.deepStrictEqual(scope.resolveSelection({ selectedKey: 'claude:b', conversationKey: 'codex:c', keys }), { key: 'claude:b', reason: 'selected' });
    assert.deepStrictEqual(scope.resolveSelection({ selectedKey: 'gone', conversationKey: 'codex:c', keys }), { key: 'codex:c', reason: 'conversation' });
    assert.deepStrictEqual(scope.resolveSelection({ selectedKey: null, conversationKey: null, keys }), { key: 'claude:a', reason: 'first' });
    assert.deepStrictEqual(scope.resolveSelection({ keys: [] }), { key: null, reason: null });
  });
}

// ---------- 稳定排序（§11.3） ----------

function orderTests() {
  test('§11.3 连续 20 份快照：智能体交替活动、灯来回切换、中途新增智能体和会话，左右顺序不跳', () => {
    let t = NOW;
    const so = order.createSessionOrder({ now: () => t });
    const ao = order.createAgentOrder({ now: () => t });
    const T0 = NOW;
    const mkAgent = (id, kind, start, name) => agent({ id, kind, name, startedMs: start, model: 'claude-sonnet-5' });
    // 会话 A（打开中）：主 + 子智能体 a1、a2 + 工作流 wf1（w1、w2）
    const a1 = mkAgent('a1', 'subagent', T0 - 50 * MIN, 'Explore auth');
    const a2 = mkAgent('a2', 'subagent', T0 - 40 * MIN, 'Write tests');
    const w1 = mkAgent('w1', 'workflowAgent', T0 - 30 * MIN, 'Phase A');
    const w2 = mkAgent('w2', 'workflowAgent', T0 - 29 * MIN, 'Phase B');
    const wf1 = { id: 'wf1', name: 'Build', state: 'running', phases: [], done: 0, total: 2, running: 2, agents: [w1, w2] };
    const A = session({ id: 'A', title: 'Alpha', live: true, startedMs: T0 - 3 * HOUR, agents: [a1, a2], workflows: [wf1] });
    const B = session({ id: 'B', title: 'Beta', live: true, startedMs: T0 - 2 * HOUR });
    const C = session({ provider: 'codex', id: 'C', title: 'Gamma', live: false, startedMs: T0 - 1 * HOUR });
    const D = session({ id: 'D', title: 'Delta', live: false, startedMs: T0 - 5 * HOUR });
    let sessions = [A, B, C, D];
    const seenLamps = { a1: new Set(), w1: new Set(), session: new Set() };
    let prevLeft = null;
    let prevRight = null;
    let E = null;
    let F = null;

    for (let i = 0; i < 20; i++) {
      t = T0 + i * 2000;
      // 两个子智能体交替活动：灯在 Working 与 DoneUnseen 之间来回切，token、活动时间一直在变
      const [on, off] = i % 2 ? [a2, a1] : [a1, a2];
      on.status = st('tool', t - 500, { pendingTool: 'Bash' });
      on.lastActivityMs = t;
      on.tokens = tokens(90000 + i * 1000);
      off.status = st('done', t - 1500);
      // 工作流智能体：在“可能在等你批准”和“执行工具”之间切换（品红 ↔ 蓝）
      w1.status = i % 3 === 0 ? st('maybeAwaitingApproval', t - 70000, { pendingTool: 'Edit' }) : st('tool', t - 1000, { pendingTool: 'Read' });
      w2.lastActivityMs = t;
      // 两个会话交替最新：快照本身按 updatedMs 降序，行会来回换
      A.updatedMs = i % 2 ? t : t - 1000;
      B.updatedMs = i % 2 ? t - 1000 : t;
      B.main.status = i % 2 ? st('done', t - 100) : st('thinking', t - 100);
      if (i === 8) A.agents.push(mkAgent('a3', 'subagent', t, 'Late helper')); // 新子智能体
      if (i === 10) wf1.agents.push(mkAgent('w3', 'workflowAgent', t, 'Phase C')); // 工作流内新智能体
      if (i === 12) { E = session({ id: 'E', title: 'Epsilon', live: true, startedMs: t }); sessions.push(E); } // 新会话（打开中）
      if (i === 14) { F = session({ provider: 'codex', id: 'F', title: 'Zeta', live: false, startedMs: null }); sessions.push(F); } // 没有开始时间

      const input = [...sessions].sort((x, y) => y.updatedMs - x.updatedMs); // 快照的顺序
      const L = lamp.computeLamps(input);
      seenLamps.a1.add(L.bySession.get('claude:A').rows.get('a/a1').lamp);
      seenLamps.w1.add(L.bySession.get('claude:A').rows.get('wf/wf1/w1').lamp);
      seenLamps.session.add(L.bySession.get('claude:B').lamp);

      const left = so.arrange(input);
      const open = i >= 12 ? ['claude:E', 'claude:B', 'claude:A'] : ['claude:B', 'claude:A'];
      const recent = i >= 14 ? ['codex:F', 'codex:C', 'claude:D'] : ['codex:C', 'claude:D'];
      assert.deepStrictEqual(left.keys, [...open, ...recent], `快照 ${i} 左侧`);
      assert.deepStrictEqual(left.groups.map((g) => g.id), ['open', 'recent']);
      assert.strictEqual(left.showGroupHeaders, true);

      // 右侧：子智能体按输入的“活动顺序”打乱后喂进去，结果不受影响
      const shuffled = { ...A, agents: i % 2 ? [...A.agents].reverse() : A.agents, workflows: [{ ...wf1, agents: [...wf1.agents].reverse() }] };
      const right = ao.arrange(shuffled).map((r) => r.id);
      const want = ['main', 'a/a1', 'a/a2', 'wf/wf1', 'wf/wf1/w1', 'wf/wf1/w2'];
      if (i >= 10) want.push('wf/wf1/w3');
      if (i >= 8) want.push('a/a3');
      assert.deepStrictEqual(right, want, `快照 ${i} 右侧`);

      // 新行只出现在规定位置，已有行相对顺序不变
      if (prevLeft) {
        const d = order.diffOrder(prevLeft, left.keys);
        assert.strictEqual(d.moved, false, `快照 ${i} 左侧已有行没动`);
        if (i === 12) assert.deepStrictEqual(d.added, [{ id: 'claude:E', afterId: null }], '新会话在“打开中”最上面');
        else if (i === 14) assert.deepStrictEqual(d.added, [{ id: 'codex:F', afterId: 'claude:A' }], '没有开始时间的新会话在“最近”最上面');
        else assert.deepStrictEqual(d.added, []);
      }
      if (prevRight) {
        const d = order.diffOrder(prevRight, right);
        assert.strictEqual(d.moved, false, `快照 ${i} 右侧已有行没动`);
        if (i === 8) assert.deepStrictEqual(d.added, [{ id: 'a/a3', afterId: 'wf/wf1/w2' }], '新子智能体追加在最后');
        else if (i === 10) assert.deepStrictEqual(d.added, [{ id: 'wf/wf1/w3', afterId: 'wf/wf1/w2' }], '工作流新智能体追加在该组末尾');
        else assert.deepStrictEqual(d.added, []);
      }
      prevLeft = left.keys;
      prevRight = right;
    }
    // 场景确实在“动”：灯来回切换过
    assert.ok(seenLamps.a1.has('working') && seenLamps.a1.has('doneUnseen'));
    assert.ok(seenLamps.w1.has('needsYou') && seenLamps.w1.has('working'));
    assert.ok(seenLamps.session.has('working') && seenLamps.session.has('doneUnseen'));
    // F 的排序键锁定为第一次看到的时间，之后补上 startedMs 也不动
    const fKey = so.sortKey('codex:F');
    assert.strictEqual(fKey, T0 + 14 * 2000);
    F.startedMs = T0 - 10 * HOUR;
    t += 2000;
    assert.deepStrictEqual(so.arrange(sessions).keys.slice(3), ['codex:F', 'codex:C', 'claude:D']);
    assert.strictEqual(so.sortKey('codex:F'), fKey);
  });

  test('只在“打开中 ↔ 最近”换组时移动；只有一组时不显示组头', () => {
    const so = order.createSessionOrder({ now: () => NOW });
    const A = session({ id: 'A', live: false, startedMs: NOW - 3 * HOUR });
    const B = session({ id: 'B', live: false, startedMs: NOW - 2 * HOUR });
    const C = session({ id: 'C', live: false, startedMs: NOW - 1 * HOUR });
    let r = so.arrange([A, B, C]);
    assert.deepStrictEqual(r.keys, ['claude:C', 'claude:B', 'claude:A']);
    assert.strictEqual(r.showGroupHeaders, false);
    A.live = true; // 用户打开了 A
    r = so.arrange([C, B, A]);
    assert.deepStrictEqual(r.keys, ['claude:A', 'claude:C', 'claude:B']);
    assert.strictEqual(r.showGroupHeaders, true);
    A.live = false;
    r = so.arrange([B, A, C]);
    assert.deepStrictEqual(r.keys, ['claude:C', 'claude:B', 'claude:A'], '回到原位');
    assert.deepStrictEqual(so.arrange([A, B, C], { grouped: false }).keys, ['claude:C', 'claude:B', 'claude:A']);
  });

  test('hideCompleted：隐藏完成的行，不改变其余行的顺序；关掉后回到原位', () => {
    const ao = order.createAgentOrder({ now: () => NOW });
    const mk = (id, start, code) => agent({ id, kind: 'subagent', name: id, startedMs: start, status: st(code, NOW) });
    const s = session({
      agents: [mk('x', NOW - 3000, 'done'), mk('y', NOW - 2000, 'tool'), mk('z', NOW - 1000, 'done')],
      workflows: [
        { id: 'w', name: 'W', state: 'completed', agents: [mk('w1', NOW - 2500, 'done')] },
        { id: 'v', name: 'V', state: 'running', agents: [mk('v1', NOW - 1500, 'done'), mk('v2', NOW - 1400, 'tool')] },
      ],
    });
    const all = ao.arrange(s).map((r) => r.id);
    assert.deepStrictEqual(all, ['main', 'a/x', 'wf/w', 'wf/w/w1', 'a/y', 'wf/v', 'wf/v/v1', 'wf/v/v2', 'a/z']);
    assert.deepStrictEqual(ao.arrange(s, { hideCompleted: true }).map((r) => r.id), ['main', 'a/y', 'wf/v', 'wf/v/v2']);
    assert.deepStrictEqual(ao.arrange(s).map((r) => r.id), all);
    const rows = ao.arrange(s);
    assert.deepStrictEqual(rows.find((r) => r.id === 'wf/v/v2').parentId, 'wf/v');
    assert.deepStrictEqual(rows.map((r) => r.depth), [0, 1, 1, 2, 1, 1, 2, 2, 1]);
  });

  test('排序键不看活动时间、灯、token：startedMs 缺失时用第一次看到的时间', () => {
    let t = NOW;
    const ao = order.createAgentOrder({ now: () => t });
    const s = session({ agents: [agent({ id: 'n1', kind: 'subagent', startedMs: null })] });
    ao.arrange(s);
    t += 5000;
    s.agents.push(agent({ id: 'n2', kind: 'subagent', startedMs: null }));
    s.agents.push(agent({ id: 'old', kind: 'subagent', startedMs: NOW - HOUR }));
    s.agents[0].lastActivityMs = t + 99999;
    s.agents[0].tokens = tokens(900000);
    assert.deepStrictEqual(ao.arrange(s).map((r) => r.id), ['main', 'a/old', 'a/n1', 'a/n2']);
    assert.strictEqual(ao.sortKey(s.key, 'a/n1'), NOW);
    const d = order.diffOrder(['a', 'b', 'c'], ['a', 'x', 'c', 'y']);
    assert.deepStrictEqual(d, { removed: ['b'], added: [{ id: 'x', afterId: 'a' }, { id: 'y', afterId: 'c' }], moved: false });
    assert.strictEqual(order.diffOrder(['a', 'b'], ['b', 'a']).moved, true);
  });
}

// ---------- 格式化 ----------

// 覆盖全部状态码与主要分支的合成状态
function statusCatalog(now) {
  const q = (o) => st('quota', now - 10000, { quota: { kind: 'session', model: null, resetsAtMs: now + HOUR + 5 * MIN, resetsText: 'resets 2am (Asia/Seoul)', source: 'text', autoContinue: null, ...o } });
  return [
    st('starting', now - 2000),
    st('thinking', now - 3000),
    st('tool', now - 4000, { pendingTool: 'Bash' }),
    st('retrying', now - 1000, { retry: { attempt: 2, max: 10, inMs: 8000 } }),
    st('retrying', now - 1000, { retry: { attempt: 2, max: 10, inMs: null } }),
    st('awaitingApproval', now - 30000, { waitingFor: 'permission prompt' }),
    st('awaitingInput', now - 30000, { question: 'askUser' }),
    st('awaitingInput', now - 30000, { question: 'planApproval' }),
    st('dialogOpen', now - 30000, { waitingFor: 'dialog open' }),
    st('maybeAwaitingApproval', now - 65000, { pendingTool: 'Read' }),
    st('maybeAwaitingApproval', now - 65000, { pendingTool: 'mcp__claude_ai_Notion__notion-search' }),
    st('maybeAwaitingApproval', now - 65000),
    st('idleBackground', now - 10000),
    st('done', now - 10000),
    st('interrupted', now - 10000),
    st('stale', now - 7 * MIN),
    st('stale', now - 7 * MIN, { stalePending: true, pendingTool: 'Bash' }),
    st('killed', now - 10000),
    q({}),
    q({ kind: 'weekly', resetsAtMs: now - MIN }),
    q({ kind: 'model', model: 'Opus 5.5' }),
    q({ kind: 'model', model: null }),
    q({ kind: 'spend', resetsAtMs: null, resetsText: null }),
    q({ kind: 'window', resetsAtMs: now + 3 * 24 * HOUR }),
    q({ kind: 'unknown', resetsAtMs: null }),
    st('quota', now - 10000),
    st('apiError', now - 10000, { error: { kind: 'server_error', http: 529, message: 'Overloaded' } }),
    st('apiError', now - 10000, { error: { kind: 'unknown', http: null, message: null } }),
  ];
}

function stepCatalog(now) {
  return [
    { kind: 'tool', tool: 'Bash', detail: 'npm test', parallel: 1, sinceMs: now - 3000 },
    { kind: 'tool', tool: 'mcp__codex_apps__github_fetch', detail: null, parallel: 3, sinceMs: now - 3000 },
    { kind: 'toolResult', tool: 'Read', detail: null, parallel: 0, sinceMs: now - 1000 },
    { kind: 'toolResult', tool: null, detail: null, parallel: 0, sinceMs: now - 1000 },
    { kind: 'thinking', tool: null, detail: null, parallel: 0, sinceMs: now - 9000 },
    { kind: 'text', tool: null, detail: 'Summarising the change', parallel: 0, sinceMs: now - 2000 },
    { kind: 'prompt', tool: null, detail: 'Add a login page', parallel: 0, sinceMs: now - 2000 },
    { kind: 'compact', tool: null, detail: null, parallel: 0, sinceMs: now - 2000 },
  ];
}

const CTX_SOURCES = ['settings-local', 'settings-project', 'settings-user', 'observed', 'default', 'disabled', null];

// 一份覆盖面广的合成快照
function syntheticSnapshot(now) {
  const statuses = statusCatalog(now);
  const steps = stepCatalog(now);
  const sessions = statuses.map((status, i) => {
    const provider = i % 4 === 3 ? 'codex' : 'claude';
    const sub = agent({ id: 'sub' + i, kind: provider === 'codex' ? 'codexSubagent' : 'subagent', name: i % 2 ? 'Helper ' + i : null,
      agentType: i % 2 ? null : 'Explore', background: i % 5 === 0, status: statuses[(i + 7) % statuses.length], step: steps[i % steps.length],
      startedMs: now - HOUR + i * 1000 });
    const reviewer = agent({ id: 'rev' + i, kind: 'codexReviewer', name: null, status: st('done', now - 5000) });
    const wfAgent = agent({ id: 'wa' + i, kind: 'workflowAgent', name: 'Phase ' + i, phase: String(i % 3 + 1), status: statuses[(i + 3) % statuses.length], step: steps[(i + 1) % steps.length] });
    return session({
      provider, id: 'sess-' + i, title: 'Synthetic ' + i, titleSource: provider === 'codex' ? 'index' : 'ai',
      entry: ['vscode', 'cli', 'desktop', 'sdk', 'exec', 'other'][i % 6],
      live: i % 3 === 0, liveStatus: i % 9 === 0 ? 'waiting' : i % 9 === 3 ? 'busy' : null, waitingFor: i % 9 === 0 ? 'permission prompt' : null,
      startedMs: now - HOUR - i * MIN, doneAtMs: now - 10000,
      cacheExpiresMs: provider === 'claude' ? now + (i - 5) * MIN : undefined,
      main: agent({ status, step: steps[i % steps.length], tokens: i % 5 === 1 ? tokens(84000, { compactAt: null }) : i % 5 === 2 ? tokens(120000, { toCompact: null }) : tokens(i * 20000),
        unpricedModel: i % 7 === 0 ? 'codex-auto-review' : null }),
      agents: provider === 'codex' ? [sub, reviewer] : [sub],
      workflows: provider === 'claude' ? [{ id: 'wf' + i, name: 'Workflow ' + i, state: ['running', 'paused', 'completed', 'killed', 'stale'][i % 5], phases: ['1', '2'], done: 1, total: 3, running: 1, agents: [wfAgent] }] : [],
      counts: { running: 1, awaiting: 0, error: 0, done: 1, total: 3 },
      costUsd: i % 6 === 0 ? null : 0.0005 + i * 0.37,
      // §11.10 会话级窗口与压缩点（带来源）；第 7 个起每 8 个缺一次，走退回主智能体 tokens 的分支
      ...(i % 8 === 7 ? {} : {
        contextWindow: provider === 'codex' ? 258400 : 1000000,
        contextWindowSource: provider === 'codex' ? 'codex-record' : ['cost-state', 'model-rule'][i % 2],
        compactAt: provider === 'codex' ? 232560 : 967000 - (i % 3) * 300000,
        compactAtSource: CTX_SOURCES[i % CTX_SOURCES.length],
      }),
      ccCostUsd: provider === 'claude' && i % 3 === 1 ? 1.5 + i : undefined,
    });
  });
  const estimate = (o) => ({ contextTokens: 412345, ttl: '1h', cacheLikelyExpired: true, usdIfMiss: 3.2, usdIfHit: 0.08, ...o });
  const hints = [
    { kind: 'claudeSession', sessionId: '0b7c1f7e-2a4d-4c3b-9f11-0123456789ab', cwd: '/work/proj', entry: 'cli', autoContinue: null,
      quota: { kind: 'session', model: null, resetsAtMs: now + HOUR, resetsText: null, source: 'text', autoContinue: null }, estimate: estimate({}) },
    { kind: 'claudeSession', sessionId: '0b7c1f7e-2a4d-4c3b-9f11-0123456789ab', cwd: null, entry: 'vscode', autoContinue: false, quota: null, estimate: estimate({ cacheLikelyExpired: false }) },
    { kind: 'claudeSubagent', sessionId: 's', agentId: 'agent-1', name: 'Explore auth', agentType: 'general', resumable: true, estimate: estimate({ ttl: '5m' }) },
    { kind: 'claudeSubagent', sessionId: 's', agentId: 'agent-2', name: null, agentType: 'Explore', resumable: false, estimate: estimate({}) },
    { kind: 'claudeWorkflow', sessionId: 's', runId: 'wf_1', workflowName: 'Build', scriptPath: '/work/scripts/build.js', paused: false, estimate: estimate({}) },
    { kind: 'claudeWorkflow', sessionId: 's', runId: 'wf_2', workflowName: 'Build', scriptPath: null, paused: true, estimate: estimate({}) },
    { kind: 'codexThread', threadId: 'th-1', cwd: '/work/proj', entry: 'cli', estimate: estimate({ ttl: 'unknown', cacheLikelyExpired: null }) },
    { kind: 'codexSubagent', parentThreadId: 'th-1', threadId: 'th-2', nickname: 'Ada', estimate: estimate({ ttl: 'unknown', cacheLikelyExpired: null }) },
  ];
  const today = {
    dayStartMs: now - 10 * HOUR, partial: true, progress: 0.42,
    claude: { input: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, output: 1, costUsd: 12.3, unpricedTokens: 0,
      byModel: { 'claude-opus-5-5': { tokens: 100, costUsd: 12.3 } } },
    codex: { input: 1, cachedInput: 1, cacheWrite: 0, output: 1, reasoning: 0, costUsd: 0.7, unpricedTokens: 5000,
      byModel: { 'gpt-5.6-sol': { tokens: 100, costUsd: 0.7 }, 'codex-auto-review': { tokens: 5000, costUsd: null } } },
  };
  const codexQuota = {
    observedMs: now - 5 * MIN, planType: 'plus', limitId: 'codex', reachedType: 'rate_limit_reached',
    windows: [
      { minutes: 300, usedPct: 42, resetsAtMs: now + 2 * HOUR, label: '5h' },
      { minutes: 10080, usedPct: 81, resetsAtMs: now - MIN, label: 'weekly' },
      { minutes: 60, usedPct: 5, resetsAtMs: null, label: '60m' },
    ],
    credits: { hasCredits: true, unlimited: false, balance: '12.50' },
  };
  const lastHit = { kind: 'weekly', model: null, resetsAtMs: now + 5 * HOUR, resetsText: null, source: 'quotaLimits', autoContinue: null, ms: now - 30 * MIN, sessionKey: 'claude:x' };
  const timeline = ['prompt', 'thinking', 'tool', 'toolDone', 'toolError', 'text', 'compact', 'quota', 'apiError', 'retry', 'interrupt', 'done']
    .flatMap((kind) => [{ ms: now - 1000, kind, tool: 'Bash', detail: 'ls -la' }, { ms: now - 1000, kind, tool: null, detail: null }]);
  const files = [
    { path: '/work/a.js', op: 'create', count: 1, lastMs: now, movedTo: null },
    { path: '/work/b.js', op: 'edit', count: 4, lastMs: now, movedTo: null },
    { path: '/work/c.js', op: 'delete', count: 1, lastMs: now, movedTo: null },
    { path: '/work/d.js', op: 'move', count: 1, lastMs: now, movedTo: '/work/e.js' },
  ];
  return { sessions, statuses, steps, hints, today, codexQuota, lastHit, timeline, files };
}

// 调一遍所有格式化函数，收集输出（[名字, 文字, 允许为空]）
function renderAll(i18n, now, snap) {
  const out = [];
  const add = (name, text, mayBeEmpty = false) => out.push([name, text, mayBeEmpty]);
  const L = lamp.computeLamps(snap.sessions);
  for (const s of snap.sessions) {
    const sl = L.bySession.get(s.key);
    const row = fmt.formatSessionRow(s, i18n, { lamps: sl, now });
    add(`row.label ${s.key}`, row.label);
    add(`row.description ${s.key}`, row.description);
    add(`row.a11y ${s.key}`, row.a11y);
    for (const [k, v] of fmt.formatSessionTooltip(s, i18n, { lamps: sl, now })) { add(`tip.key ${s.key}`, k); add(`tip.value ${s.key} ${k}`, v); }
    add(`contextValue ${s.key}`, fmt.sessionContextValue(s, sl.lamp));
    const agents = [s.main, ...s.agents, ...s.workflows.flatMap((w) => w.agents)];
    for (const a of agents) {
      add(`agent.name ${a.id}`, fmt.formatAgentName(a, i18n));
      add(`agent.kind ${a.id}`, fmt.formatAgentKind(a, i18n));
      add(`agent.status ${a.id}`, fmt.formatStatus(a.status, a, i18n, now));
      add(`agent.statusStable ${a.id}`, fmt.formatStatus(a.status, a, i18n, now, { stable: true }));
      add(`agent.statusPending ${a.id}`, fmt.formatStatus(a.status, a, i18n, now, { staleAsNeedsYou: true }));
      add(`agent.note ${a.id}`, fmt.formatStatusNote(a.status, i18n), true);
      add(`agent.step ${a.id}`, fmt.formatStep(a.step, a.status, i18n, now, { withDur: true }), true);
      const c = fmt.formatContext(a.tokens, i18n);
      add(`ctx.usage ${a.id}`, c.usageText);
      for (const k of ['pctText', 'shortText', 'remainText']) add(`ctx.${k} ${a.id}`, c[k], true);
      for (const n of c.notes) add(`ctx.note ${a.id}`, n);
      add(`ctx.pctOfWindow ${a.id}`, c.pctOfWindowText, true);
      add(`agent.cost ${a.id}`, fmt.formatCost(a.costUsd, i18n, { unpriced: a.unpricedModel }));
    }
    const src = fmt.formatContextSources(fmt.sessionContextTokens(s), s.provider, i18n);
    for (const l of src.lines) add(`ctx.source ${s.key}`, l);
    add(`ctx.compactShort ${s.key}`, src.compactShort, true);
    add(`session.cost ${s.key}`, fmt.formatSessionCost(s, i18n).text, true);
    for (const w of s.workflows) for (const [k, v] of Object.entries(fmt.formatWorkflow(w, i18n))) add(`wf.${k}`, v, k === 'phaseText');
    add(`cache ${s.key}`, fmt.formatCacheLeft(s.cacheExpiresMs, i18n, now), s.provider === 'codex');
  }
  for (const status of snap.statuses) {
    for (const main of [true, false]) {
      add(`status ${status.code}`, fmt.formatStatus(status, null, i18n, now, { isMain: main }));
      add(`statusStable ${status.code}`, fmt.formatStatus(status, null, i18n, now, { isMain: main, stable: true }));
    }
    if (status.quota) add('autoContinue', fmt.formatAutoContinue(status.quota, i18n, now), true);
  }
  for (const step of snap.steps) {
    add(`step ${step.kind}`, fmt.formatStep(step, st('thinking', now), i18n, now));
    add(`stepDur ${step.kind}`, fmt.formatStep(step, st('tool', now), i18n, now, { withDur: true }));
    assert.strictEqual(fmt.formatStep(step, st('done', now), i18n, now), '', 'done 时不显示步骤');
  }
  for (const h of snap.hints) {
    for (const platform of ['darwin', 'win32']) {
      const r = fmt.formatResumeHint(h, i18n, { now, platform });
      add(`resume.label ${h.kind}`, r.label);
      add(`resume.prompt ${h.kind}`, r.prompt);
      add(`resume.command ${h.kind}`, r.command || '', !r.variants.includes('cli'));
      add(`resume.estimate ${h.kind}`, r.estimateText);
      add(`resume.note ${h.kind}`, r.noteText, true);
    }
  }
  const today = fmt.formatToday(snap.today, i18n);
  add('today.text', today.text);
  add('today.partial', today.partialText);
  for (const l of today.lines) add('today.line', l);
  add('cost.note', fmt.formatCostNote(i18n));
  add('cost.null', fmt.formatCost(null, i18n));
  add('cost.unpriced', fmt.formatCost(null, i18n, { unpriced: true }));
  add('cost.estimated', fmt.formatCost(0.12, i18n, { estimated: true }));
  for (const b of [0, 512, 71234, 7.7e6, 932e6, 1.4e9]) add('bytes', fmt.formatBytes(b, i18n));
  const cq = fmt.formatCodexQuota(snap.codexQuota, i18n, now);
  add('codex.title', cq.title);
  for (const l of cq.lines) add('codex.line', l);
  add('claude.lastHit', fmt.formatClaudeLastHit(snap.lastHit, i18n, now));
  for (const ev of snap.timeline) add(`timeline ${ev.kind}`, fmt.formatTimelineEvent(ev, i18n), ev.kind === 'text' && !ev.detail);
  for (const f of snap.files) add(`file ${f.op}`, fmt.formatFileOp(f, i18n));
  add('bar.idle', fmt.formatStatusBarText({}, i18n));
  add('bar.text', fmt.formatStatusBarText(L.counts, i18n));
  add('bar.text.all', fmt.formatStatusBarText({ needsYou: 1, error: 2, doneUnseen: 3, working: 4 }, i18n));
  const ordered = order.createSessionOrder({ now: () => now }).arrange(snap.sessions).list;
  for (const l of fmt.formatStatusBarLines(ordered, L.bySession, i18n, now, 15)) add('bar.line', l);
  add('badge', fmt.formatBadge({ needsYou: 1, error: 2, doneUnseen: 3 }, i18n).tooltip);
  for (const sc of ['all', 'workspace']) { const r = fmt.formatScope(sc, i18n); add('scope.label', r.label); add('scope.empty', r.empty); }
  for (const g of ['open', 'recent']) add('group', fmt.formatGroup(g, i18n));
  for (const l of S.LAMPS) { add('lamp', fmt.lampLabel(l, i18n)); add('lamp.short', fmt.lampLabel(l, i18n, true)); }
  for (const e of ['vscode', 'cli', 'desktop', 'sdk', 'exec', 'other', null, 'weird']) add('entry', fmt.entryLabel(e, i18n));
  return out;
}

function formatTests() {
  test('五种语言：全部格式化输出不为空、没有未替换的占位符、用到的键都在词典里（缺的语言回退英文）', () => {
    i18nLib.clearCache();
    const snap = syntheticSnapshot(NOW);
    for (const locale of LOCALES) {
      const base = i18nLib.createI18n(locale, { timeZone: 'UTC' });
      const used = new Set();
      const i18n = { ...base, t: (k, v) => { used.add(k); return base.t(k, v); } };
      const out = renderAll(i18n, NOW, snap);
      assert.ok(out.length > 500, `${locale}：输出条数 ${out.length}`);
      for (const [name, text, mayBeEmpty] of out) {
        assert.strictEqual(typeof text, 'string', `${locale} ${name} 不是字符串`);
        if (!mayBeEmpty) assert.ok(text.trim().length > 0, `${locale} ${name} 为空`);
        assert.ok(!PLACEHOLDER.test(text), `${locale} ${name} 有未替换的占位符：${text}`);
      }
      const missing = [...used].filter((k) => !base.has(k));
      assert.deepStrictEqual(missing, [], `${locale} 缺词条`);
      assert.strictEqual(base.locale, locale);
    }
  });

  test('确定 / 推测两种“等你批准”的英文文案；左侧稳定版不带时长', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    assert.strictEqual(fmt.formatStatus(st('awaitingApproval', NOW - 5000), null, en, NOW), 'Waiting for your approval');
    assert.strictEqual(fmt.formatStatus(st('awaitingInput', NOW, { question: 'askUser' }), null, en, NOW), 'Waiting for your answer');
    assert.strictEqual(fmt.formatStatus(st('dialogOpen', NOW), null, en, NOW), 'A dialog is waiting for you');
    const guess = st('maybeAwaitingApproval', NOW - 65000, { pendingTool: 'Read' });
    assert.strictEqual(fmt.formatStatus(guess, null, en, NOW), 'May be waiting for your approval (Read, no result for 1m05s)');
    assert.strictEqual(fmt.formatStatus(guess, null, en, NOW, { stable: true }), 'May be waiting for your approval');
    assert.ok(fmt.formatStatusNote(guess, en).startsWith('Guessed'));
    assert.strictEqual(fmt.formatStatusNote(st('awaitingApproval', NOW), en), '');
    assert.strictEqual(fmt.formatStatus(st('stale', NOW - 7 * MIN, { stalePending: true, pendingTool: 'Bash' }), null, en, NOW),
      'No activity for 7m00s (Bash still running)');
    assert.strictEqual(fmt.formatStatus(st('stale', NOW - 7 * MIN), null, en, NOW, { stable: true }), 'No recent activity');
    assert.strictEqual(fmt.formatStatus(st('done', NOW), { kind: 'main' }, en, NOW), 'Turn finished');
    assert.strictEqual(fmt.formatStatus(st('done', NOW), { kind: 'subagent' }, en, NOW), 'Done');
    assert.strictEqual(fmt.formatStatus(st('retrying', NOW - 1000, { retry: { attempt: 2, max: 10, inMs: 8000 } }), null, en, NOW), 'Retrying (2/10) in 7s');
    assert.strictEqual(fmt.formatStatus(st('apiError', NOW, { error: { kind: 'x', http: 529, message: null } }), null, en, NOW), 'API error (529)');
    const quota = st('quota', NOW, { quota: { kind: 'model', model: 'Opus 5.5', resetsAtMs: NOW + HOUR + 5 * MIN, resetsText: null, source: 'text', autoContinue: null } });
    assert.strictEqual(fmt.formatStatus(quota, null, en, NOW), 'Opus 5.5 limit reached · resets 11:05 AM (in 1h05m)');
    assert.strictEqual(fmt.formatStatus(quota, null, en, NOW, { stable: true }), 'Opus 5.5 limit reached · resets 11:05 AM');
    assert.strictEqual(fmt.formatAutoContinue(quota.quota, en, NOW), 'If auto-continue is on, it will continue at 11:05 AM');
    assert.strictEqual(fmt.formatQuotaHit({ ...quota.quota, resetsAtMs: NOW - 1 }, en, NOW), 'Opus 5.5 limit reached · Reset time has passed, but it hasn\'t continued yet');
  });

  test('§11.2 左侧行：{Claude|Codex} · {状态} · {上下文}，时间流逝时文字不变', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    const snap = syntheticSnapshot(NOW);
    for (const s of snap.sessions) {
      const a = fmt.formatSessionRow(s, en, { now: NOW });
      const tipA = JSON.stringify(fmt.formatSessionTooltip(s, en, { now: NOW }));
      for (const dt of [1000, 7000, 29000]) {
        const b = fmt.formatSessionRow(s, en, { now: NOW + dt });
        assert.strictEqual(b.description, a.description, `${s.key} +${dt}ms`);
        assert.strictEqual(b.a11y, a.a11y);
        assert.strictEqual(JSON.stringify(fmt.formatSessionTooltip(s, en, { now: NOW + dt })), tipA, `${s.key} 提示 +${dt}ms`);
      }
      assert.ok(/^(Claude|Codex) · /.test(a.description), a.description);
    }
    const s = session({
      live: true, liveStatus: 'waiting', waitingFor: 'permission prompt',
      main: agent({ status: st('tool', NOW - 5000, { pendingTool: 'Bash' }), tokens: tokens(290100) }),
    });
    // 百分比按 Claude Code 的公式：290100 / 1M 窗口 = 29%（不是占 967K 阈值的 30%）
    assert.strictEqual(fmt.formatSessionRow(s, en, { now: NOW }).description, 'Claude · Waiting for your approval · 29% context');
    const sub = session({
      main: agent({ status: st('idleBackground', NOW), tokens: tokens(96700) }),
      agents: [agent({ id: 'x', kind: 'subagent', name: 'A very long subagent description that goes on', status: st('maybeAwaitingApproval', NOW - 70000, { pendingTool: 'Edit' }) })],
    });
    assert.strictEqual(fmt.formatSessionRow(sub, en, { now: NOW }).description,
      'Claude · A very long subagent de…: May be waiting for your approval · 10% context');
    const codex = session({ provider: 'codex', id: 'th', main: agent({ status: st('done', NOW), tokens: { contextUsed: 0, contextWindow: null, compactAt: null, toCompact: null } }) });
    assert.strictEqual(fmt.formatSessionRow(codex, en, { now: NOW }).description, 'Codex · Turn finished');
  });

  test('工具名、步骤、上下文、费用', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    assert.strictEqual(fmt.toolLabel('mcp__claude_ai_Notion__notion-search'), 'Notion·notion-search');
    assert.strictEqual(fmt.toolLabel('mcp__codex_apps__github_fetch'), 'codex_apps·github_fetch');
    assert.strictEqual(fmt.toolLabel('mcp__plugin_eng_github__get_pr'), 'github·get_pr');
    assert.strictEqual(fmt.toolLabel('apply_patch'), 'apply_patch');
    assert.strictEqual(fmt.toolLabel(null, en), 'tool');
    const tool = { kind: 'tool', tool: 'Bash', detail: 'npm test', parallel: 3, sinceMs: NOW - 12000 };
    assert.strictEqual(fmt.formatStep(tool, st('tool', NOW), en, NOW), 'Bash npm test (3 in parallel)');
    assert.strictEqual(fmt.formatStep(tool, st('tool', NOW), en, NOW, { withDur: true }), 'Bash npm test (3 in parallel) · 12s');
    assert.strictEqual(fmt.formatStep({ ...tool, detail: null, parallel: 1 }, st('tool', NOW), en, NOW), 'Bash');
    assert.strictEqual(fmt.formatStep(tool, st('interrupted', NOW), en, NOW), '');
    assert.strictEqual(fmt.formatStep(null, null, en, NOW), '');
    const c = fmt.formatContext(tokens(412345), en);
    assert.strictEqual(c.pctText, '41%', '百分比 = 已用 / 窗口（Claude Code 的公式）');
    assert.strictEqual(c.pct, 41);
    assert.strictEqual(c.usageText, '412.3K / 967K');
    assert.strictEqual(c.remainText, '554.7K until auto-compact');
    assert.strictEqual(c.shortText, '41% context');
    assert.strictEqual(c.pctOfWindowText, '41% of the 1M window');
    assert.ok(Math.abs(c.ratio - 412345 / 967000) < 1e-9, '进度条仍是 已用 / 自动压缩点');
    assert.strictEqual(fmt.formatContext(tokens(84000, { compactAt: null, toCompact: null }), en).remainText, 'Auto-compact is off');
    const rel = fmt.formatContext({ contextUsed: 100000, contextWindow: 258400, compactAt: 244800, toCompact: null }, en);
    assert.strictEqual(rel.usageText, '100K / 258.4K', 'body_after_prefix：进度条退回窗口');
    assert.strictEqual(rel.notes.length, 1);
    assert.strictEqual(fmt.formatCost(1.234, en), '$1.23');
    assert.strictEqual(fmt.formatCost(0.4, en, { unpriced: 'codex-auto-review' }), '$0.400+');
    assert.strictEqual(fmt.formatCost(null, en, { unpriced: true }), 'No public price');
    assert.strictEqual(fmt.formatCost(null, en), '—');
    assert.ok(fmt.formatCostNote(en).includes('2026-09-23'));
  });

  test('§11.10 百分比：Claude Code 的公式（四舍五入、夹在 0–100），很小但非零写 <1%', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    assert.strictEqual(fmt.contextPct(4999, 1000000), 0);
    assert.strictEqual(fmt.contextPct(5000, 1000000), 1, '0.5 四舍五入到 1');
    assert.strictEqual(fmt.contextPct(1500000, 1000000), 100, '夹在 100');
    assert.strictEqual(fmt.contextPct(-3, 1000000), 0);
    assert.strictEqual(fmt.contextPct(100, 0), null);
    const tiny = fmt.formatContext(tokens(3000), en);
    assert.strictEqual(tiny.pctText, '<1%');
    assert.strictEqual(tiny.shortText, '<1% context');
    assert.strictEqual(fmt.formatContext(tokens(0), en).pctText, '0%', '真的是 0 才写 0%');
    assert.strictEqual(fmt.formatContext(tokens(1200000, { toCompact: -233000 }), en).pctText, '100%');
    // 各语言的 <1% 都没有占位符残留
    for (const locale of LOCALES) {
      const t = fmt.formatContext(tokens(3000), i18nLib.createI18n(locale, { timeZone: 'UTC' })).pctText;
      assert.ok(t.startsWith('<') && /1/.test(t), `${locale}: ${t}`);
    }
    // 窗口不知道时退回阈值做分母
    assert.strictEqual(fmt.formatContext({ contextUsed: 50000, contextWindow: null, compactAt: 100000, toCompact: 50000 }, en).pctText, '50%');
  });

  test('§11.10 会话级窗口与压缩点：Session 上的值优先，来源写进提示；disabled → 自动压缩已关', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    // 主智能体 tokens 按旧规则是 200K / 167K，provider 从 cost-state 认出 [1m] → 会话级 1M、实测 950K
    const s = session({
      contextWindow: 1000000, contextWindowSource: 'cost-state', compactAt: 950000, compactAtSource: 'observed',
      main: agent({ tokens: tokens(300000, { contextWindow: 200000, compactAt: 167000, toCompact: -133000 }) }),
    });
    const tk = fmt.sessionContextTokens(s);
    assert.strictEqual(tk.contextWindow, 1000000);
    assert.strictEqual(tk.compactAt, 950000);
    assert.strictEqual(tk.toCompact, 650000);
    assert.strictEqual(tk.windowSource, 'cost-state');
    assert.strictEqual(tk.compactAtSource, 'observed');
    assert.strictEqual(fmt.formatSessionRow(s, en, { now: NOW }).contextText, '30% context');
    const src = fmt.formatContextSources(tk, 'claude', en);
    assert.strictEqual(src.windowText, "Context window: 1M (from Claude Code's cost record for this session)");
    assert.strictEqual(src.compactText, 'Auto-compacts at about 950K (measured where this model last auto-compacted)');
    assert.strictEqual(src.compactShort, 'About 950K · measured where this model last auto-compacted');
    assert.ok(src.lines.some((l) => l.includes('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')), '提示设了环境变量会更早');
    assert.ok(src.lines.some((l) => l.includes("Claude Code's own formula")));
    const tip = Object.fromEntries(fmt.formatSessionTooltip(s, en, { now: NOW }));
    assert.strictEqual(tip[en.t('tip.autoCompact')], 'About 950K · measured where this model last auto-compacted');
    assert.strictEqual(tip[en.t('ctx.label')], '300K / 950K · 650K until auto-compact · 30% of the 1M window');
    // 各来源都有文字
    for (const source of ['settings-local', 'settings-project', 'settings-user', 'observed', 'default']) {
      const t = fmt.formatContextSources(fmt.sessionContextTokens({ ...s, compactAtSource: source }), 'claude', en);
      assert.ok(t.compactText && !/\{\w+\}/.test(t.compactText) && !t.compactText.includes('src.'), source + ': ' + t.compactText);
    }
    // 自动压缩关了
    const off = session({ contextWindow: 1000000, contextWindowSource: 'model-rule', compactAt: null, compactAtSource: 'disabled', main: agent({ tokens: tokens(84000) }) });
    const offTk = fmt.sessionContextTokens(off);
    assert.strictEqual(offTk.compactAt, null);
    assert.strictEqual(fmt.formatContext(offTk, en).remainText, 'Auto-compact is off');
    assert.strictEqual(fmt.formatContextSources(offTk, 'claude', en).compactShort, 'Off');
    assert.ok(!fmt.formatContextSources(offTk, 'claude', en).lines.some((l) => l.includes('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')));
    // Codex body_after_prefix：剩余量不可算，保留“相对”说明
    const cx = session({ provider: 'codex', id: 'th', contextWindow: 258400, contextWindowSource: 'codex-record', compactAt: 232560, compactAtSource: 'default',
      main: agent({ tokens: { contextUsed: 100000, contextWindow: 258400, compactAt: 232560, toCompact: null } }) });
    const cxTk = fmt.sessionContextTokens(cx);
    assert.strictEqual(cxTk.toCompact, null);
    assert.strictEqual(fmt.formatContext(cxTk, en).notes.length, 1);
    assert.ok(!fmt.formatContextSources(cxTk, 'codex', en).lines.some((l) => l.includes('CLAUDE_')), 'Codex 不提 Claude 的环境变量');
    // 没有会话级字段：原样用主智能体的 tokens
    const plain = fmt.sessionContextTokens(session());
    assert.strictEqual(plain.compactAt, 967000);
    assert.strictEqual(plain.windowSource, null);
  });

  test('§11.10 会话费用优先用 Claude Code 自己的统计；字节数按 1000 进位', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    const cc = fmt.formatSessionCost(session({ ccCostUsd: 3.2104, costUsd: 2.9 }), en);
    assert.deepStrictEqual(cc, { text: "$3.21 (Claude Code's count)", fromClaudeCode: true, estimateText: '$2.90' });
    assert.deepStrictEqual(fmt.formatSessionCost(session({ costUsd: 2.9 }), en), { text: '$2.90', fromClaudeCode: false, estimateText: '$2.90' });
    assert.strictEqual(fmt.formatSessionCost(session({ costUsd: null }), en).text, '');
    const tip = Object.fromEntries(fmt.formatSessionTooltip(session({ ccCostUsd: 3.2104 }), en, { now: NOW }));
    assert.strictEqual(tip[en.t('cost.label')], "$3.21 (Claude Code's count)");
    assert.strictEqual(fmt.formatBytes(0, en), '0B');
    assert.strictEqual(fmt.formatBytes(512, en), '512B');
    assert.strictEqual(fmt.formatBytes(7.7e6, en), '7.7 MB');
    assert.strictEqual(fmt.formatBytes(57.3e6, en), '57.3 MB');
    assert.strictEqual(fmt.formatBytes(932e6, en), '932 MB');
    assert.strictEqual(fmt.formatBytes(999.97e6, en), '1 GB', '进位后不写 1000 MB');
    assert.strictEqual(fmt.formatBytes(null, en), '—');
    assert.strictEqual(fmt.formatBytes(-1, en), '—');
  });

  test('续跑说明：上下文为 0 或不知道时不写估价句', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    const base = { ttl: '1h', cacheLikelyExpired: true, usdIfMiss: 0, usdIfHit: 0 };
    assert.strictEqual(fmt.formatResumeEstimate({ ...base, contextTokens: 0 }, en), '');
    assert.strictEqual(fmt.formatResumeEstimate({ ...base, contextTokens: null }, en), '');
    assert.strictEqual(fmt.formatResumeEstimate({ ...base, contextTokens: undefined, cacheLikelyExpired: null }, en), '');
    const hint = { kind: 'claudeSession', sessionId: '0b7c1f7e-2a4d-4c3b-9f11-0123456789ab', cwd: '/work/proj', entry: 'cli', autoContinue: false, quota: null,
      estimate: { ...base, contextTokens: 0 } };
    assert.strictEqual(fmt.formatResumeHint(hint, en, { now: NOW }).estimateText, '');
    assert.ok(fmt.formatResumeEstimate({ ...base, contextTokens: 1200, usdIfMiss: 0.01 }, en).includes('1.2K'));
  });

  test('续跑提示：按钮名、提示词、终端命令、代价', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    const snap = syntheticSnapshot(NOW);
    const cli = fmt.formatResumeHint(snap.hints[0], en, { now: NOW, platform: 'darwin' });
    assert.strictEqual(cli.label, 'Resume this session');
    assert.deepStrictEqual(cli.variants, ['cli', 'prompt']);
    assert.ok(cli.command.startsWith('cd /work/proj && claude --resume 0b7c1f7e-2a4d-4c3b-9f11-0123456789ab "Continue the task'));
    assert.strictEqual(cli.estimateText, 'Resuming re-reads about 412.3K tokens of context. The cache has likely expired; API-equivalent cost about $3.20.');
    assert.strictEqual(cli.noteText, 'If auto-continue is on, it will continue by itself at 11:00 AM; no action needed.');
    const vs = fmt.formatResumeHint(snap.hints[1], en, { now: NOW });
    assert.deepStrictEqual(vs.variants, ['prompt']);
    assert.strictEqual(vs.command, null);
    assert.ok(vs.estimateText.includes('may still be valid') && vs.estimateText.includes('$0.080'));
    assert.strictEqual(fmt.formatResumeHint(snap.hints[3], en).label, 'Rerun subagent Explore');
    assert.strictEqual(fmt.formatResumeHint(snap.hints[5], en).noteText, 'Will continue automatically after the usage limit resets.');
    assert.deepStrictEqual(fmt.formatResumeHint(snap.hints[5], en).variants, []);
    assert.strictEqual(fmt.formatResumeHint(snap.hints[6], en).estimateText,
      'Resuming re-reads about 412.3K tokens of context; API-equivalent cost about $0.080–$3.20 depending on the cache.');
  });

  test('contextValue、状态栏、徽标、额度', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    const s = session({ live: true, resume: [{ kind: 'claudeSession' }], main: agent({ status: st('quota', NOW), tokens: tokens(25000) }) });
    assert.strictEqual(fmt.sessionContextValue(s, 'error'), 'session provider-claude lamp-error quota resumable compactable live');
    assert.strictEqual(fmt.sessionContextValue(session({ main: agent({ tokens: tokens(19999) }) }), 'working'), 'session provider-claude lamp-working');
    assert.strictEqual(fmt.formatStatusBarText({ needsYou: 2, error: 0, doneUnseen: 1, working: 3 }, en),
      '$(circle-large-filled) 2 need you · 1 new · 3 working');
    assert.strictEqual(fmt.formatStatusBarText({ doneSeen: 4, idle: 2 }, en), '$(circle-large-outline) No active agents');
    assert.deepStrictEqual(fmt.formatBadge({ needsYou: 1, error: 0, doneUnseen: 2, working: 5 }, en), { value: 3, tooltip: '1 need you · 2 with new results' });
    const many = Array.from({ length: 17 }, (_, i) => session({ id: 'm' + i, title: 'Session ' + i }));
    const lines = fmt.formatStatusBarLines(many, lamp.computeLamps(many).bySession, en, NOW, 15);
    assert.strictEqual(lines.length, 16);
    assert.strictEqual(lines[0], 'Working · Session 0 · Thinking');
    assert.strictEqual(lines[15], '…and 2 more');
    const snap = syntheticSnapshot(NOW);
    const cq = fmt.formatCodexQuota(snap.codexQuota, en, NOW);
    assert.deepStrictEqual(cq.lines.slice(0, 3), ['5-hour: 42% used · resets 12:00 PM', 'Weekly: reset', '60-min: 5% used']);
    assert.ok(fmt.formatClaudeLastHit(snap.lastHit, en, NOW).startsWith('Last Claude limit hit: Weekly limit reached · resets'));
    assert.strictEqual(fmt.formatClaudeLastHit(null, en, NOW), '');
    assert.strictEqual(fmt.formatCacheLeft(NOW + 4.2 * MIN, en, NOW), 'Cache: 5 min left');
    assert.strictEqual(fmt.formatCacheLeft(NOW - 1, en, NOW), 'Cache expired');
    assert.strictEqual(fmt.formatCacheLeft(undefined, en, NOW), '');
  });

  test('l10n/views.en.json：只含英文、占位符写法正确、不占用 core 的键前缀、不与 core 重复', () => {
    const views = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'views.en.json'), 'utf8'));
    const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'core.en.json'), 'utf8'));
    const corePrefixes = ['lamp', 'status', 'step', 'timeline', 'file', 'quota', 'cost', 'ctx', 'resume', 'dur', 'agent', 'workflow', 'entry', 'provider', 'count', 'tool'];
    for (const [k, v] of Object.entries(views)) {
      assert.strictEqual(typeof v, 'string', k);
      assert.ok(v.trim(), k);
      assert.ok(!corePrefixes.includes(k.split('.')[0]), `${k} 用了 core 的前缀`);
      assert.ok(!(k in core), `${k} 与 core 重复`);
      for (const m of v.matchAll(/\{([^{}]*)\}/g)) assert.ok(/^\w+$/.test(m[1]), `${k} 占位符写法 {${m[1]}}`);
    }
    assert.ok(!/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(JSON.stringify(views)), '英文词典里没有中日韩字符');
  });

  test('webview 里用 fromPayload 还原的实例也能格式化', () => {
    const base = i18nLib.createI18n('ko', { timeZone: 'UTC' });
    const w = i18nLib.fromPayload(JSON.parse(base.webviewJson()), { timeZone: 'UTC' });
    const s = session({ main: agent({ status: st('stale', NOW - 7 * MIN) }) });
    assert.strictEqual(fmt.formatSessionRow(s, w, { now: NOW }).description, fmt.formatSessionRow(s, base, { now: NOW }).description);
    assert.strictEqual(fmt.formatStatus(s.main.status, s.main, w, NOW), fmt.formatStatus(s.main.status, s.main, base, NOW));
  });
}

// ---------- 运行 ----------

console.log('lamp');
lampTests();
console.log('seen');
seenTests();
console.log('scope');
scopeTests();
console.log('order');
orderTests();
console.log('format');
formatTests();

Promise.all(pending).then(() => {
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
});
