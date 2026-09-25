'use strict';
// Tests for the bottom-panel webview: lib/agents-view.js (view models for the content area and session list + WebviewViewProvider), lib/webview-html.js,
// media/session-list.js (width snapping, keyboard, type-ahead, incremental sync), wiring and strings in media/agents.js, and l10n/webview.en.json.
// Run with plain Node: node test/agents-view.test.js
// All data is synthetic; nothing is read from ~/.claude or ~/.codex. Temp files go under AGENT_MONITOR_TEST_TMP (or the system temp dir if unset) and are deleted afterwards.
// The page itself (incremental DOM updates, contrast, narrow/wide layouts) is checked manually in headless Chrome during development, not here.

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

// ---------- Helpers ----------

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

// ---------- View model ----------

test('empty state: no snapshot yet → loading; no sessions → the hint from the extension; otherwise "pick a session"', () => {
  const a = AV.buildViewModel({ session: null, i18n, loaded: false });
  assert.strictEqual(a.type, 'render');
  assert.strictEqual(a.emptyText, i18n.t('session.loading'));
  assert.deepStrictEqual(a.rows, []);
  const b = AV.buildViewModel({ session: null, i18n, loaded: true, emptyText: 'Nothing here' });
  assert.strictEqual(b.emptyText, 'Nothing here');
  const c = AV.buildViewModel({ session: null, i18n, loaded: true });
  assert.strictEqual(c.emptyText, i18n.t('session.none'));
});

test('rows: main conversation first, subagents by start time ascending, workflow agents grouped (order comes from order.js)', () => {
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
  assert.strictEqual(byId['wf/wf_1'].badge, null, 'workflow rows get no bell before the status');
  for (const r of vm.rows) {
    assert.ok(r.name && r.statusText && r.lamp && r.shape, r.id);
    assert.ok(!/\{\w+\}/.test(JSON.stringify(r)), 'no unreplaced placeholders: ' + r.id);
  }
});

test('20 snapshots in a row: two agents take turns being active, input order shuffled, a row added midway → order depends only on start time and the new row lands in its place', () => {
  const order = createAgentOrder({ now: () => NOW });
  let prev = null;
  for (let i = 0; i < 20; i++) {
    const x = sub('x', NOW - 20 * MIN, { status: S.makeStatus(i % 2 ? 'done' : 'tool', NOW), lastActivityMs: NOW + i });
    const y = sub('y', NOW - 10 * MIN, { status: S.makeStatus(i % 2 ? 'tool' : 'done', NOW), lastActivityMs: NOW - i });
    const list = i % 2 ? [y, x] : [x, y];
    if (i >= 8) list.unshift(sub('z', NOW - 5 * MIN)); // appears midway, latest start time
    const s = session({ agents: list, updatedMs: NOW + i });
    const vm = AV.buildViewModel({ session: s, i18n, now: NOW + i * 2000, order, loaded: true });
    const want = i >= 8 ? ['main', 'a/x', 'a/y', 'a/z'] : ['main', 'a/x', 'a/y'];
    assert.deepStrictEqual(ids(vm), want, 'snapshot ' + i + ' (0-based)');
    if (prev) assert.deepStrictEqual(ids(vm).filter((id) => prev.includes(id)), prev, 'existing rows keep their relative order');
    prev = ids(vm);
  }
});

test('details only for expanded rows; loaded=false when there is no detail data', () => {
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
  assert.strictEqual(d.timeline[0].tone, 'error', 'newest first');
  assert.strictEqual(d.timeline[0].icon, 'error');
  assert.deepStrictEqual(d.result, { text: 'Done.', truncated: true, ago: i18n.fmtAgo(NOW - 1000, NOW) });
  assert.deepStrictEqual(d.files.map((f) => [f.base, f.dir]), [['a.js', 'src'], ['old.js', 'src'], ['x.md', '~/notes']]);
  assert.ok(d.files[1].opText.includes('src/new/old.js') && !d.files[1].opText.includes('/work/demo'), 'move target uses a relative path');
  assert.strictEqual(d.errors[0].tool, 'Bash');
  assert.strictEqual(d.canOpen, true);
  assert.strictEqual(vm.detail['a/a'].loaded, false);
  const none = build(s, { detail });
  assert.deepStrictEqual(none.detail, {}, 'no expanded rows: no details');
});

test('main row uses the status corrected by the registry (waiting → awaiting your approval, NeedsYou)', () => {
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

test('session bar: compact button only for main sessions with context ≥ 20000; cache countdown only for Claude', () => {
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

test('session bar: context in absolute numbers (used / auto-compact point), percentage of the window (the Claude Code formula), meter 0–100', () => {
  const s = session({ main: agent({ tokens: tokens(412000) }) });
  const ctx = build(s).session.context;
  assert.strictEqual(ctx.text, i18n.t('webview.ctx.ofCompact', { used: i18n.fmtTokens(412000), limit: i18n.fmtTokens(967000) }));
  assert.strictEqual(ctx.pctText, '41% of the 1M window', 'percentage = used / window, not 43% of the threshold');
  assert.strictEqual(ctx.pct, 43, 'meter is still used / auto-compact point');
  assert.strictEqual(ctx.remainText, i18n.t('ctx.toCompact', { tokens: i18n.fmtTokens(555000) })); // shown next to it as "555K to auto-compact"
  assert.ok(ctx.ariaText.includes(ctx.pctText) && ctx.ariaText.includes(ctx.remainText), ctx.ariaText);
  assert.strictEqual(ctx.zone, 'consider');
  assert.ok(ctx.zoneTip.includes(i18n.t('webview.zone.newTask')));
  const over = build(session({ main: agent({ tokens: tokens(990000, { toCompact: -23000 }) }) })).session.context;
  assert.strictEqual(over.pct, 100);
  const off = build(session({ main: agent({ tokens: tokens(50000, { compactAt: null, toCompact: null }) }) })).session.context;
  assert.strictEqual(off.text, i18n.t('webview.ctx.ofWindow', { used: i18n.fmtTokens(50000), limit: i18n.fmtTokens(1000000) }) + ' (5%)');
  assert.strictEqual(off.pctText, '', 'when the meter limit is the window, the percentage is appended to the text instead of shown separately');
  assert.strictEqual(off.remainText, i18n.t('ctx.autoCompactOff'));
  const tiny = build(session({ main: agent({ tokens: tokens(2000) }) })).session.context;
  assert.strictEqual(tiny.pctText, '<1% of the 1M window', 'tiny but non-zero shows <1%');
});

test('session bar: window and compaction point come from the Session; the tooltip names the sources and CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', () => {
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
  // window < 500K: zones use the share of the compaction point: 300K / 367K = 82% → act
  const small = build(session({ contextWindow: 200000, contextWindowSource: 'model-rule', compactAt: 167000, compactAtSource: 'default',
    main: agent({ tokens: tokens(140000, { contextWindow: 1000000, compactAt: 967000, toCompact: 827000 }) }) })).session.context;
  assert.strictEqual(small.zone, 'act', 'zones use the session-level 200K window');
  assert.ok(small.tip.includes('standard window for this model') && small.tip.includes('official default'), small.tip);
});

test('session bar: "Auto-compact: {value} ▾" uses the describeCompactSetting text and is hidden when the module is missing', () => {
  const calls = [];
  const describe = (sess, i) => { calls.push([sess.key, i]); return { valueText: '400K (40%)', effectiveText: '→ ≈ 367K', sourceText: 'Source: user settings', text: 'T', tooltip: 'How it works' }; };
  const s = session();
  const ac = build(s, { describeCompact: describe }).session.autoCompact;
  assert.deepStrictEqual(calls, [[s.key, i18n]]);
  assert.strictEqual(ac.text, i18n.t('webview.autoCompact', { value: '400K (40%)' }));
  assert.strictEqual(ac.detailText, '→ ≈ 367K · Source: user settings');
  assert.ok(ac.tip.includes('How it works') && ac.tip.includes(i18n.t('webview.autoCompact.tip')), ac.tip);
  // when the localized sentence from describe starts with the value, the rest of the sentence is used as is after the value (no arrow is added)
  const whole = build(s, { describeCompact: () => ({ valueText: '40만 (40%)', effectiveText: '≈ 36.7만', sourceText: '출처: 사용자 설정', text: '40만 (40%) → ≈ 36.7만 · 출처: 사용자 설정' }) }).session.autoCompact;
  assert.strictEqual(whole.detailText, '→ ≈ 36.7만 · 출처: 사용자 설정');
  assert.strictEqual(build(s, { describeCompact: null }).session.autoCompact, null, 'no module');
  assert.strictEqual(build(s, { describeCompact: () => { throw new Error('x'); } }).session.autoCompact, null, 'hidden on error');
  assert.strictEqual(build(s, { describeCompact: () => ({ valueText: '' }) }).session.autoCompact, null);
  // session with no model reply yet (model and window unknown): hidden, rather than guessing "≈ 167K" from 200K
  const noModel = session({ model: null, contextWindow: null, compactAt: null, compactAtSource: null, main: agent({ tokens: tokens(0, { contextWindow: null, compactAt: null, toCompact: null }) }) });
  assert.strictEqual(build(noModel, { describeCompact: describe }).session.autoCompact, null, 'session without a model reply');
  // when the real module (lib/autocompact.js) is present, it is used by default
  let real = null;
  try { real = require('../lib/autocompact'); } catch { real = null; }
  if (real && typeof real.describeCompactSetting === 'function') {
    const vm = build(session({ contextWindow: 1000000, contextWindowSource: 'cost-state', compactAt: 967000, compactAtSource: 'default' })).session.autoCompact;
    assert.ok(vm && vm.text.startsWith('Auto-compact: '), JSON.stringify(vm));
    assert.ok(!/\{\w+\}/.test(JSON.stringify(vm)), 'no unreplaced placeholders');
  }
});

test('session bar: transcript location line (~ abbreviation, three sizes, platform-specific button name); only the path when there are no sizes', () => {
  const file = '/Users/demo/.claude/projects/-work-demo/11111111-0000-4000-8000-000000000001.jsonl';
  const s = session({ transcript: file });
  const detail = { key: s.key, agents: {}, storage: { transcriptBytes: 7.7e6, subagentsBytes: 57.3e6, fileHistoryBytes: 5.3e6 } };
  const st = build(s, { detail }).session.storage;
  assert.strictEqual(st.pathText, '~/.claude/projects/-work-demo/11111111-0000-4000-8000-000000000001.jsonl');
  assert.ok(st.pathTip.startsWith(file + '\n'), 'tooltip has the full path');
  assert.strictEqual(st.sizesText, '7.7 MB · subagents 57.3 MB · file backups 5.3 MB');
  assert.ok(st.sizesTip.includes('Main transcript: 7.7 MB'));
  assert.strictEqual(st.revealText, 'Reveal in Finder');
  assert.strictEqual(st.copyText, i18n.t('webview.store.copy'));
  assert.strictEqual(build(s, { detail, platform: 'win32' }).session.storage.revealText, 'Reveal in File Explorer');
  assert.strictEqual(build(s, { detail, platform: 'linux' }).session.storage.revealText, 'Open Containing Folder');
  // subagent and file-backup sizes are omitted when 0; only the path until sizes are computed
  const zero = build(s, { detail: { ...detail, storage: { transcriptBytes: 1234, subagentsBytes: 0, fileHistoryBytes: null } } }).session.storage;
  assert.strictEqual(zero.sizesText, '1.2 kB');
  assert.strictEqual(build(s).session.storage.sizesText, '');
  // no transcript field: fall back to the main conversation's transcript file; relative paths are not shown
  assert.strictEqual(build(session()).session.storage.pathText, '/synthetic/main.jsonl');
  assert.strictEqual(build(session({ transcript: 'relative.jsonl', main: agent({ file: null }) })).session.storage, null);
  // Codex sessions show the rollout path
  const cx = build(session({ provider: 'codex', id: '0c0de000-0000-4000-8000-000000000003', transcript: '/Users/demo/.codex/sessions/2026/09/24/rollout-x.jsonl',
    main: agent({ id: '0c0de000-0000-4000-8000-000000000003' }) }), { detail: { storage: { transcriptBytes: 52e6 } } }).session.storage;
  assert.strictEqual(cx.pathText, '~/.codex/sessions/2026/09/24/rollout-x.jsonl');
  assert.strictEqual(cx.sizesText, '52 MB');
});

test('session cost: prefer the count from Claude Code itself; the extension estimate goes into the tooltip', () => {
  const on = build(session({ ccCostUsd: 3.2104, costUsd: 2.9 })).session;
  assert.strictEqual(on.costText, i18n.t('webview.sessionCost', { usd: "$3.21 (Claude Code's count)" }));
  assert.ok(on.costTip.includes(i18n.t('webview.sessionCost.cc.tip')) && on.costTip.includes('$2.90'), on.costTip);
  const est = build(session({ costUsd: 2.9 })).session;
  assert.strictEqual(est.costText, i18n.t('webview.sessionCost', { usd: '$2.90' }));
  assert.strictEqual(build(session({ ccCostUsd: 1 }), { settings: { showCost: false } }).session.costText, '');
});

test('resume hint: no cost sentence when the context is 0', () => {
  const s = session({ resume: [{ kind: 'claudeSession', sessionId: '11111111-0000-4000-8000-000000000001', cwd: '/work/demo', entry: 'cli', autoContinue: false, quota: null,
    estimate: { contextTokens: 0, ttl: '1h', cacheLikelyExpired: true, usdIfMiss: 0, usdIfHit: 0 } }] });
  assert.strictEqual(build(s).session.resume[0].infoText, '');
});

test('context zones: large windows use absolute numbers, others use the share of the threshold', () => {
  const z = (used, o = {}, hint) => AV.contextZone({ contextUsed: used, contextWindow: 1000000, compactAt: 967000, ...o }, hint);
  assert.strictEqual(z(199999), null);
  assert.strictEqual(z(200000), 'consider');
  assert.strictEqual(z(499999), 'consider');
  assert.strictEqual(z(500000), 'act');
  assert.strictEqual(z(300000, {}, { start: 350000, act: 600000 }), null, 'contextHintStart setting');
  assert.strictEqual(z(550000, {}, { start: 350000, act: 600000 }), 'consider');
  const small = (used) => AV.contextZone({ contextUsed: used, contextWindow: 258400, compactAt: 244800 });
  assert.strictEqual(small(146000), null);
  assert.strictEqual(small(146880), 'consider');
  assert.strictEqual(small(195840), 'act');
  assert.strictEqual(AV.contextZone({ contextUsed: 150000, contextWindow: 200000, compactAt: null }), 'consider', 'unknown threshold: use the window');
  assert.strictEqual(AV.contextZone(null), null);
});

test('compaction count: compactCount ≥ 2 inside a zone → repeated-compaction hint; compactLoop → error-colored text', () => {
  const many = build(session({ compactCount: 2, main: agent({ tokens: tokens(300000) }) })).session;
  assert.strictEqual(many.context.compactText, i18n.t('webview.compacted', { n: 2 }));
  assert.ok(many.banners.some((b) => b.text === i18n.t('webview.compactMany')));
  const loop = build(session({ compactCount: 3, compactLoop: true })).session;
  assert.strictEqual(loop.context.compactText, i18n.t('webview.compactLoop'));
  assert.strictEqual(loop.context.compactTone, 'error');
  const last = build(session({ main: agent({ lastCompact: { ms: NOW - 5 * MIN, trigger: 'manual', preTokens: 100 } }) })).session;
  assert.ok(last.context.compactText.includes(i18n.t('ctx.trigger.manual')), last.context.compactText);
});

test('quota banner: not repeated when the status line already shows this quota; Codex shows the account quota', () => {
  const hit = { kind: 'weekly', model: null, resetsAtMs: NOW + 3 * 3600e3, resetsText: null, source: 'quotaLimits', autoContinue: null };
  const q = build(session({ main: agent({ status: S.makeStatus('quota', NOW - MIN, { quota: hit }) }) })).session;
  assert.strictEqual(q.statusText, i18n.t('quota.weekly') + ' · ' + i18n.t('quota.resets', { reset: i18n.fmtClock(hit.resetsAtMs, NOW), left: i18n.fmtDur(3 * 3600e3) }));
  assert.ok(!q.banners.some((b) => b.tone === 'error'), 'not repeated');
  // a subagent hit a quota but the session lamp comes from the main conversation's "waiting for your answer" → banner shows the quota
  const s2 = session({ main: agent({ status: S.makeStatus('awaitingInput', NOW) }), agents: [sub('q', NOW - MIN, { status: S.makeStatus('quota', NOW - MIN, { quota: hit }) })] });
  const L2 = lamp.sessionLamps(s2, { seenAtMs: 0 });
  assert.strictEqual(L2.lead.rowId, 'main');
  // neither the main conversation nor the lead is quota → no quota banner (the quota shows only on that row)
  assert.ok(!build(s2, { lamps: L2 }).session.banners.some((b) => b.tone === 'error'));
  const quota = { claude: { lastHit: null }, codex: { observedMs: NOW - MIN, planType: 'plus', limitId: 'codex', reachedType: null, credits: null,
    windows: [{ minutes: 300, usedPct: 95, resetsAtMs: NOW + 3600e3, label: '5h' }, { minutes: 10080, usedPct: 40, resetsAtMs: NOW + 86400e3, label: 'weekly' }] } };
  const cx = build(session({ provider: 'codex', id: '0c0de000-0000-4000-8000-000000000002', main: agent({ id: '0c0de000-0000-4000-8000-000000000002' }) }), { quota }).session;
  const b = cx.banners.find((x) => x.text.startsWith(i18n.t('quota.codex.title')));
  assert.ok(b, JSON.stringify(cx.banners));
  assert.strictEqual(b.tone, 'warning', '≥ 90% uses warning');
});

test('showCost=false: cost column, session cost and cost for today are all hidden', () => {
  const today = { dayStartMs: NOW - 3600e3, partial: false, progress: 1, claude: { costUsd: 1.5, unpricedTokens: 0, byModel: {} }, codex: { costUsd: 0, unpricedTokens: 0, byModel: {} } };
  const on = build(session(), { today });
  assert.ok(on.session.costText && on.session.todayText && on.rows[0].costText);
  const off = build(session(), { today, settings: { showCost: false } });
  assert.strictEqual(off.showCost, false);
  assert.strictEqual(off.session.costText, '');
  assert.strictEqual(off.session.todayText, '');
  assert.ok(off.rows.every((r) => r.costText === ''));
});

test('agent without a price: the cell shows only "—", the explanation goes into the tooltip', () => {
  const s = session({ agents: [sub('r', NOW - MIN, { kind: 'codexReviewer', name: null, agentType: null, model: 'codex-auto-review', costUsd: null, unpricedModel: 'codex-auto-review' })] });
  const r = build(s).rows.find((x) => x.id === 'a/r');
  assert.strictEqual(r.costText, i18n.fmtUsd(null));
  assert.strictEqual(r.costTip, i18n.t('cost.unpriced'));
  assert.ok(!r.sub.split(' · ').includes(r.name), 'type equal to name is not repeated: ' + r.sub);
});

test('hideCompleted: completed subagents are hidden, with an "n hidden" note', () => {
  const s = session({ agents: [sub('d', NOW - 20 * MIN, { status: S.makeStatus('done', NOW - MIN) }), sub('r', NOW - 10 * MIN)] });
  const vm = build(s, { settings: { hideCompleted: true } });
  assert.deepStrictEqual(ids(vm), ['main', 'a/r']);
  assert.strictEqual(vm.note, i18n.t('row.completedHidden', { n: 1 }));
  assert.strictEqual(build(s).note, '');
});

test('resume hint: buttons only for the forms formatResumeHint returns; the text goes into tip', () => {
  const s = session({ resume: [{ kind: 'claudeSession', sessionId: '11111111-0000-4000-8000-000000000001', cwd: '/work/demo', entry: 'cli', autoContinue: false, quota: null,
    estimate: { contextTokens: 50000, ttl: '1h', cacheLikelyExpired: true, usdIfMiss: 0.4, usdIfHit: 0.01 } }] });
  const r = build(s).session.resume[0];
  assert.strictEqual(r.index, 0);
  assert.ok(r.buttons.length >= 1);
  assert.ok(r.buttons.some((b) => b.variant === 'cli' && b.tip.includes('claude --resume')), JSON.stringify(r.buttons));
  assert.ok(r.infoText.length > 0);
});

// ---------- Page HTML and strings ----------

test('webviewHtml: CSP allows only cspSource and the nonce, lang uses the Intl locale, dictionary JSON escapes </script>', () => {
  const evil = i18nLib.createI18n('ko', { dicts: { en: { 'webview.title': 'A</script><script>alert(1)</script>', 'webview.footer': 'v{version}' }, ko: {} } });
  const html = webviewHtml({ cspSource: 'vscode-webview://x', asset: (p) => 'https://asset/' + p, nonce: 'N0NCE', version: '0.3.0', i18n: evil });
  const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1].replace(/&#39;/g, "'");
  assert.strictEqual(csp, "default-src 'none'; style-src vscode-webview://x; font-src vscode-webview://x; script-src 'nonce-N0NCE'");
  assert.ok(html.includes('<html lang="ko-KR">'));
  const scripts = html.match(/<script\b[^>]*>/g);
  assert.deepStrictEqual(scripts, ['<script type="application/json" id="l10n">', '<script nonce="N0NCE" src="https://asset/session-list.js">', '<script nonce="N0NCE" src="https://asset/agents.js">']);
  const json = html.slice(html.indexOf('id="l10n">') + 10, html.indexOf('</script>'));
  assert.ok(!json.includes('<'), 'no < in the data block');
  assert.strictEqual(JSON.parse(json).dict['webview.title'], 'A</script><script>alert(1)</script>');
  assert.ok(html.includes('<title>A&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>'));
  assert.ok(html.includes('https://asset/agents.css') && html.includes('https://asset/codicons/codicon.css'));
  assert.ok(!/style=/.test(html), 'no inline style (blocked by CSP)');
  assert.ok(!/\bon[a-z]+=/.test(html), 'no inline event handlers');
  // newer session bar lines: auto-compact entry, percentage of the window, distance to auto-compact, transcript location and its two buttons
  for (const id of ['s-pct', 's-remain', 's-acline', 's-autocompact', 's-storeline', 's-path', 's-sizes', 's-reveal', 's-copypath']) {
    assert.ok(html.includes(`id="${id}"`), 'missing #' + id);
  }
  for (const act of ['setAutoCompact', 'revealTranscript', 'copyTranscriptPath']) assert.ok(html.includes(`data-act="${act}"`), act);
  // header: the token column is in the second-line group (in a narrow panel the first line keeps only name and status)
  const headLine2 = html.slice(html.indexOf('class="c-line2"'), html.indexOf('<div id="rows"'));
  assert.ok(headLine2.includes('c-tok'), 'token header is inside c-line2');
});

test('media/agents.js: token cell is in the second-line group; new buttons send only sessionKey', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'agents.js'), 'utf8');
  assert.ok(/'c-line2'[^\n]*\[u\.step, u\.tok, u\.cost, u\.time\]/.test(js), 'c-line2 = step, tokens, cost, time');
  assert.ok(/act === 'setAutoCompact' \|\| act === 'revealTranscript' \|\| act === 'copyTranscriptPath'/.test(js));
  assert.ok(/postMessage\(\{ type: act, sessionKey: key \}\)/.test(js), 'sends only the type and the session key');
  const css = fs.readFileSync(path.join(ROOT, 'media', 'agents.css'), 'utf8');
  // the narrow layout follows the content area's own width (container query); the width taken by the session list beside it does not count
  assert.ok(!css.includes('@media (max-width: 699px)'), 'no longer switches on the width of the whole webview');
  assert.ok(/\.content \{[^}]*container: content \/ inline-size;/.test(css), 'content area is a container');
  const narrow = css.slice(css.indexOf('@container content (max-width: 699px)'));
  assert.ok(narrow.length > 100, 'missing the content-area container query');
  assert.ok(/grid-template-columns: minmax\(0, 1fr\) clamp\(9em, 50%, 14\.5em\)/.test(narrow), 'narrow content area: name / status columns are redistributed');
});

test('every string used by media/agents.js is under an injected prefix and in the English dictionary', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'agents.js'), 'utf8');
  const keys = [...new Set([...js.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]))];
  const dyn = [...js.matchAll(/'(webview\.[\w.]+)'/g)].map((m) => m[1]); // the t(cond ? 'a' : 'b') form
  const all = [...new Set([...keys, ...dyn])];
  assert.ok(all.length >= 10, all.join());
  const dict = i18n.dict(WEBVIEW_DICT_PREFIXES);
  for (const k of all) {
    assert.ok(WEBVIEW_DICT_PREFIXES.some((p) => k.startsWith(p)), 'not under an injected prefix: ' + k);
    assert.ok(k in dict, 'missing from the dictionary: ' + k);
  }
});

test('every webview.* string used by lib/agents-view.js and lib/webview-html.js is in webview.en.json', () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'webview.en.json'), 'utf8'));
  for (const f of ['lib/agents-view.js', 'lib/webview-html.js', 'media/agents.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/'(webview\.[\w.]+)'/g)) {
      if (m[1].endsWith('.')) continue; // a prefix that gets concatenated, e.g. 'webview.zone.' + zone
      assert.ok(m[1] in en, f + ' uses a missing string ' + m[1]);
    }
  }
  for (const z of ['consider', 'act']) for (const suf of ['', '.tip']) assert.ok(('webview.zone.' + z + suf) in en);
});

test('l10n/webview.en.json: every key starts with webview., values are strings, no CJK characters', () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'webview.en.json'), 'utf8'));
  for (const [k, v] of Object.entries(en)) {
    assert.ok(k.startsWith('webview.'), k);
    assert.strictEqual(typeof v, 'string', k);
    assert.ok(!/[぀-ヿ㐀-鿿가-힯]/.test(v), 'CJK characters in the English dictionary: ' + k);
  }
});

// ---------- WebviewViewProvider (vscode stub) ----------

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

test('provider: posts only after ready; the same view model is not reposted; nothing is posted while hidden', () => {
  const st = makeStub();
  const visible = [];
  const p = new AV.AgentsViewProvider(st.context, { vscode: st.vscode, i18n, version: '0.3.0', onDidChangeVisibility: (v) => visible.push(v) });
  p.resolveWebviewView(st.view);
  assert.ok(st.view.webview.html.includes('script-src &#39;nonce-'));
  assert.deepStrictEqual(st.view.webview.options.localResourceRoots.map((u) => u.fsPath), [path.join(ROOT, 'media')]);
  assert.deepStrictEqual(visible, [true]);
  const s = session();
  p.update({ session: s, now: NOW, loaded: true });
  assert.strictEqual(st.log.posted.length, 0, 'nothing before ready');
  st.listeners.msg({ type: 'ready', expanded: { [s.key]: ['main'] } });
  assert.strictEqual(st.log.posted.length, 1);
  assert.strictEqual(st.log.posted[0].sessionKey, s.key);
  assert.ok('main' in st.log.posted[0].detail, 'expanded state sent with ready takes effect');
  p.update({ session: s, now: NOW, loaded: true });
  assert.strictEqual(st.log.posted.length, 1, 'unchanged: not reposted');
  p.update({ session: s, now: NOW + 2000, loaded: true });
  assert.strictEqual(st.log.posted.length, 2);
  assert.strictEqual(p.shownKey, s.key);
  st.view.visible = false;
  st.listeners.vis();
  assert.deepStrictEqual(visible, [true, false]);
  p.update({ session: s, now: NOW + 4000, loaded: true });
  assert.strictEqual(st.log.posted.length, 2, 'nothing while hidden');
  st.view.visible = true;
  st.listeners.vis();
  st.listeners.msg({ type: 'ready' });
  assert.strictEqual(st.log.posted.length, 3, 'posted again once visible and the page is ready');
});

test('provider: expand reposts at once with details; compact is forwarded only for the current session', () => {
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
  assert.strictEqual(st.log.commands.length, 0, 'other sessions are not forwarded');
  st.listeners.msg({ type: 'compact', sessionKey: s.key });
  assert.deepStrictEqual(st.log.commands, [[AV.COMPACT_COMMAND, s.key]]);
});

test('provider: setAutoCompact / revealTranscript / copyTranscriptPath are forwarded only for the current session, without any path from the webview', async () => {
  const st = makeStub();
  const p = new AV.AgentsViewProvider(st.context, { vscode: st.vscode, i18n });
  p.resolveWebviewView(st.view);
  const s = session();
  p.update({ session: s, now: NOW, loaded: true });
  st.listeners.msg({ type: 'ready' });
  for (const type of ['setAutoCompact', 'revealTranscript', 'copyTranscriptPath']) {
    st.listeners.msg({ type, sessionKey: 'claude:other', path: '/etc/passwd' });
  }
  assert.strictEqual(st.log.commands.length, 0, 'other sessions are not forwarded');
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

test('provider: goTo (session bar button, double-click on a list or agent row) runs Go to Chat for a listed or shown session only', async () => {
  const st = makeStub();
  const p = new AV.AgentsViewProvider(st.context, { vscode: st.vscode, i18n });
  p.resolveWebviewView(st.view);
  const { b, input } = listFixture();
  const shown = session({ id: '11111111-0000-4000-8000-000000000002' }); // shown although not in the list
  p.updateList(input);
  p.update({ session: shown, now: NOW, loaded: true });
  st.listeners.msg({ type: 'ready' });
  st.listeners.msg({ type: 'goTo', sessionKey: 'claude:not-listed' });
  st.listeners.msg({ type: 'goTo', sessionKey: 42 });
  st.listeners.msg({ type: 'goTo', sessionKey: shown.key });
  st.listeners.msg({ type: 'goTo', sessionKey: b.key });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(st.log.commands, [[AV.GOTO_COMMAND, shown.key], [AV.GOTO_COMMAND, b.key]]);
  assert.strictEqual(AV.GOTO_COMMAND, 'agentMonitor.goToChat');
});

test('Go to button: shown for a live Claude / Qwen session and a recent Codex / Gemini / Copilot session; hidden when not running, old or not supported yet', () => {
  const goTo = (o) => build(session(o)).session.goTo;
  assert.strictEqual(goTo({ live: true }), true, 'Claude VS Code chat, live');
  assert.strictEqual(goTo({ live: false }), false, 'Claude, not running');
  assert.strictEqual(goTo({ entry: 'cli', entrypoint: 'cli', live: true }), true, 'Claude CLI, live');
  assert.strictEqual(goTo({ entry: 'desktop', entrypoint: 'claude-desktop', live: true }), false, 'Claude desktop app: not supported yet');
  assert.strictEqual(goTo({ provider: 'codex', id: 'c1', entry: 'cli', entrypoint: null, live: false }), true, 'Codex CLI written 5 s ago (no registry)');
  assert.strictEqual(goTo({ provider: 'codex', id: 'c2', entry: 'cli', entrypoint: null, live: false, updatedMs: NOW - 3 * 86400e3 }), false, 'Codex CLI, days old');
  assert.strictEqual(goTo({ provider: 'codex', id: 'c3', entry: 'vscode', entrypoint: null, live: true }), true, 'Codex extension thread');
  assert.strictEqual(goTo({ provider: 'codex', id: 'c4', entry: 'desktop', entrypoint: null, live: true }), false, 'Codex app: not supported yet');
  assert.strictEqual(goTo({ provider: 'gemini', id: 'g1', entry: 'cli', entrypoint: null }), true);
  assert.strictEqual(goTo({ provider: 'qwen', id: 'q1', entry: 'cli', entrypoint: null, live: true }), true);
  assert.strictEqual(goTo({ provider: 'qwen', id: 'q2', entry: 'cli', entrypoint: null, live: false }), false);
  assert.strictEqual(goTo({ provider: 'copilot', id: 'p1', entry: 'vscode', entrypoint: null, live: true }), true, 'Copilot Chat');
  assert.strictEqual(goTo({ provider: 'copilot', id: 'p2', entry: 'vscode', entrypoint: null, live: false, updatedMs: NOW - 3 * 86400e3 }), false, 'Copilot Chat, days old');
});

test('webview: the Go to button sits in the title line (hidden until the session allows it, still named when narrowed to its icon); double-click on list and agent rows sends goTo', () => {
  const html = webviewHtml({ cspSource: 'c:', asset: (p) => 'a/' + p, nonce: 'N', version: '0.3.0', i18n });
  const head = html.slice(html.indexOf('class="s-line s-head"'), html.indexOf('class="s-line s-sum"'));
  assert.ok(/id="s-goto"[^>]*data-act="goTo"[^>]*hidden[^>]*aria-label="Go to"/.test(head), 'Go to button in the title line');
  assert.ok(head.indexOf('id="s-goto"') < head.indexOf('id="s-compact"'), 'left of Compact…');
  for (const k of ['webview.goTo', 'webview.goTo.tip']) assert.notStrictEqual(i18n.t(k), k, 'string ' + k);
  const js = fs.readFileSync(path.join(ROOT, 'media', 'agents.js'), 'utf8');
  assert.ok(/show\(E\.goto, !!s\.goTo\)/.test(js), 'shown from the view model');
  assert.ok(/E\.box\.addEventListener\('dblclick'[\s\S]{0,300}type: 'goTo', sessionKey: row\._data\.key/.test(js), 'list row double-click');
  assert.ok(/E\.rows\.addEventListener\('dblclick'[\s\S]{0,300}type: 'goTo', sessionKey: shownKey/.test(js), 'agent row double-click');
  assert.ok(/act === 'goTo'\) \{ if \(key\) vscode\.postMessage\(\{ type: 'goTo', sessionKey: key \}\)/.test(js), 'button sends only the session key');
  assert.ok(/e\.detail > 1/.test(js), 'the second click of a double-click does not toggle the row back');
  const css = fs.readFileSync(path.join(ROOT, 'media', 'agents.css'), 'utf8');
  assert.ok(/#s-goto > span \{ display: none; \}|#s-goto > span[,{]/.test(css), 'icon only in a narrow panel');
});

test('provider: copyResume regenerates the text in the extension; an out-of-range index or wrong form copies nothing', async () => {
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

test('provider: openFile only opens existing files listed in the details; openTranscript needs an existing .jsonl (or legacy .json) transcript', () => {
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
  assert.strictEqual(st.log.commands.length, 0, 'not in the list / other session: not opened');
  st.listeners.msg({ type: 'openFile', sessionKey: s.key, rowId: 'main', path: gone });
  assert.strictEqual(st.log.warn.length, 1, 'warns when missing');
  st.listeners.msg({ type: 'openFile', sessionKey: s.key, rowId: 'main', path: real });
  assert.strictEqual(st.log.commands.length, 1);
  assert.strictEqual(st.log.commands[0][0], 'vscode.open');
  assert.strictEqual(st.log.commands[0][1].fsPath, real);
  st.listeners.msg({ type: 'openTranscript', sessionKey: s.key, rowId: 'a/x' });
  assert.strictEqual(st.log.opened.length, 0, 'not a .jsonl: not opened');
  st.listeners.msg({ type: 'openTranscript', sessionKey: s.key, rowId: 'main', file: '/etc/passwd' });
  assert.deepStrictEqual(st.log.opened, [[transcript, { preview: true }]], 'path comes from session data, not from the webview');
  // Whole-file JSON sessions (older Copilot Chat / Gemini CLI) can be opened too
  const legacy = path.join(TMP, 'legacy.json');
  fs.writeFileSync(legacy, '{}');
  const s2 = session({ provider: 'copilot', id: 'legacy', main: agent({ file: legacy }) });
  p.update({ session: s2, detail: null, now: NOW, loaded: true });
  st.listeners.msg({ type: 'openTranscript', sessionKey: s2.key, rowId: 'main' });
  assert.deepStrictEqual(st.log.opened.slice(-1), [[legacy, { preview: true }]]);
  const d = AV.buildViewModel({ session: s2, i18n, now: NOW, expanded: ['main'], loaded: true }).detail.main;
  assert.strictEqual(d.canOpen, true);
});

test('row id → agent: main, subagent, workflow agent; workflow group rows and unknown ids give null', () => {
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

test('provider: copyResult copies the result from the details (found from current data even before the page is ready); unknown messages are ignored', async () => {
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

// ---------- Session list (modeled on the terminal tab list) ----------

test('webviewHtml: one layout with content area, sash and session list (a named listbox); the list starts on the right', () => {
  const html = webviewHtml({ cspSource: 'c:', asset: (p) => 'a/' + p, nonce: 'N', version: '0.3.0', i18n });
  const app = html.slice(html.indexOf('<div id="app"'));
  assert.ok(/<div id="app" class="app list-right">/.test(html));
  const at = (id) => app.indexOf(`id="${id}"`);
  assert.ok(at('content') > 0 && at('content') < at('sash') && at('sash') < at('slist'), 'order: content, sash, list');
  assert.ok(/<main id="content" class="content" tabindex="0" aria-label="Agents">/.test(html), 'content area is reachable with Tab (keyboard scrolling)');
  assert.ok(/<div id="sash" class="sash" aria-hidden="true"><\/div>/.test(html));
  assert.ok(new RegExp('<div id="sl-box" class="sl-box" role="listbox" tabindex="0" aria-label="' + i18n.t('webview.list') + '">').test(html));
  // the existing session bar, table and footer all live in the content area
  const content = html.slice(html.indexOf('<main id="content"'), html.indexOf('</main>'));
  for (const id of ['empty', 'empty-act', 'sbar', 'grid', 'rows', 'note']) assert.ok(content.includes(`id="${id}"`), id);
  assert.ok(content.includes('<footer'), 'footer is inside the content area');
});

test('session bar has two lines: the summary line holds status, context, zone, cache, session cost, [Resume] and [Details]; everything else goes into details, collapsed by default', () => {
  const html = webviewHtml({ cspSource: 'c:', asset: (p) => 'a/' + p, nonce: 'N', version: '0.3.0', i18n });
  const sbar = html.slice(html.indexOf('<section id="sbar"'), html.indexOf('</section>'));
  const sum = sbar.slice(sbar.indexOf('class="s-line s-sum"'), sbar.indexOf('id="s-urgent"'));
  for (const id of ['s-status', 's-ctx', 's-zone', 's-cache', 's-cost', 's-resumebtn', 's-more']) assert.ok(sum.includes(`id="${id}"`), 'summary line has ' + id);
  assert.ok(/id="s-more"[^>]*data-act="toggleDetails"[^>]*aria-expanded="false"[^>]*aria-controls="s-details"/.test(sum), '[Details] collapsed by default');
  assert.ok(/id="s-resumebtn"[^>]*data-act="showResume"[^>]*hidden[^>]*aria-label="/.test(sum), '[Resume] hidden by default, and still named when narrowed to an icon');
  assert.ok(/<div id="s-urgent" class="s-line s-urgent" role="alert" hidden>/.test(sbar), 'urgent banner hidden by default');
  const det = sbar.slice(sbar.indexOf('<div id="s-details"'));
  assert.ok(/^<div id="s-details" class="s-details" hidden>/.test(det), 'details collapsed by default');
  for (const id of ['s-ctxline', 's-meter', 's-acline', 's-autocompact', 's-costline', 's-today', 's-banners', 's-resume', 's-storeline']) assert.ok(det.includes(`id="${id}"`), 'details have ' + id);
  for (const k of ['webview.details', 'webview.resumeShort']) assert.notStrictEqual(i18n.t(k), k, 'string ' + k);
});

test('title line shows "Context N%" (of the window) left of "Compact…"; the session list no longer shows it', () => {
  const html = webviewHtml({ cspSource: 'c:', asset: (p) => 'a/' + p, nonce: 'N', version: '0.3.0', i18n });
  const head = html.slice(html.indexOf('class="s-line s-head"'), html.indexOf('class="s-line s-sum"'));
  assert.ok(/id="s-headctx"[^>]*hidden[\s\S]*id="s-compact"/.test(head), 'before the compact button, hidden by default');
  const c = build(session({ main: agent({ tokens: tokens(140000, { contextWindow: 200000, compactAt: 167000 }) }), contextWindow: 200000, compactAt: 167000 })).session.context;
  assert.strictEqual(c.shortText, i18n.t('row.context', { pct: '70%' }));
  assert.strictEqual(build(session({ main: agent({ tokens: null }) })).session.context.shortText, '', 'hidden without tokens');
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'agents.js'), 'utf8');
  assert.ok(/txt\(E\.headCtx, c\.shortText\)/.test(js) && /show\(E\.headCtx, !!c\.shortText\)/.test(js));
});

test('styles: sticky header; a short panel (body.short) hides the cost and time columns; a narrow content area keeps its two-column layout', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'agents.css'), 'utf8');
  assert.ok(/\.row\.head \{\s*position: sticky;\s*top: 0;/.test(css), 'header is sticky');
  assert.ok(/body\.short \.c-cost, body\.short \.c-time \{ display: none; \}/.test(css), 'short panel hides two columns');
  assert.ok(/\.row, body\.no-cost \.row, body\.short \.row \{ grid-template-columns: minmax\(0, 1fr\) clamp/.test(css), 'narrow content layout overrides body.short');
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'agents.js'), 'utf8');
  assert.ok(/classList\.toggle\('short', window\.innerHeight < 400\)/.test(js), 'short only when height < 400');
});

test('session-list.js width: snaps like the terminal (< 63 → 46, 63–80 → 80, max 500, non-number → 200)', () => {
  assert.deepStrictEqual(LS.WIDTH, { DEFAULT: 200, NARROW: 46, MIN: 80, MAX: 500, AUTO_NARROW_PANEL: 500, MIN_CONTENT: 300 });
  assert.strictEqual(LS.MIDPOINT, 63);
  const cases = [[0, 200], [-5, 200], ['x', 200], [null, 200], [10, 46], [62.9, 46], [63, 80], [79, 80], [80, 80], [199.6, 200], [260, 260], [500, 500], [2000, 500]];
  for (const [w, want] of cases) assert.strictEqual(LS.snapWidth(w), want, String(w));
});

test('session-list.js effective width: panel < 500 → automatic narrow strip (not draggable); a saved narrow width stays narrow; 300 is left for the content area', () => {
  assert.deepStrictEqual(LS.effectiveWidth(300, 499), { width: 46, narrow: true, auto: true });
  assert.deepStrictEqual(LS.effectiveWidth(46, 1300), { width: 46, narrow: true, auto: false });
  assert.deepStrictEqual(LS.effectiveWidth(200, 1300), { width: 200, narrow: false, auto: false });
  assert.deepStrictEqual(LS.effectiveWidth(300, 1300), { width: 300, narrow: false, auto: false });
  assert.deepStrictEqual(LS.effectiveWidth(500, 700), { width: 400, narrow: false, auto: false }, '700-wide panel: list at most 700 − 300');
  assert.deepStrictEqual(LS.effectiveWidth(300, 500), { width: 200, narrow: false, auto: false }, '500-wide panel: list at most 200');
  assert.deepStrictEqual(LS.effectiveWidth(null, 760), { width: 200, narrow: false, auto: false }, 'nothing saved: default 200');
  assert.strictEqual(LS.effectiveWidth(260, 0).width, 260, 'panel width not known yet: use the saved width');
  assert.strictEqual(LS.dragWidth('right', 1000, 1300), 300, 'list on the right: panel width − pointer position');
  assert.strictEqual(LS.dragWidth('left', 180, 1300), 180, 'list on the left: pointer position');
});

test('session-list.js keyboard: ↑ ↓ Home End PageUp PageDown move focus (clamped at both ends); other keys are ignored', () => {
  const m = LS.moveIndex;
  assert.strictEqual(m('ArrowDown', -1, 5), 0, 'no focus yet: lands on the first row');
  assert.strictEqual(m('ArrowUp', -1, 5), 0);
  assert.strictEqual(m('ArrowDown', 1, 5), 2);
  assert.strictEqual(m('ArrowDown', 4, 5), 4, 'no wrap at the end');
  assert.strictEqual(m('ArrowUp', 0, 5), 0);
  assert.strictEqual(m('Home', 3, 5), 0);
  assert.strictEqual(m('End', 0, 5), 4);
  assert.strictEqual(m('PageDown', 0, 50, 10), 10);
  assert.strictEqual(m('PageUp', 5, 50, 10), 0);
  assert.strictEqual(m('PageDown', 45, 50, 10), 49);
  assert.strictEqual(m('ArrowDown', 9, 5), 0, 'out-of-range focus counts as none');
  assert.strictEqual(m('Enter', 1, 5), -1);
  assert.strictEqual(m('a', 1, 5), -1);
  assert.strictEqual(m('ArrowDown', 0, 0), -1, 'empty list');
});

test('session-list.js type-ahead: case-insensitive, searches from the next row, wraps; repeating one letter cycles; typing several letters matches a prefix without jumping around', () => {
  const labels = ['Alpha chat', 'beta chat', 'Gamma thread', 'Beta two', 'alpine', '修复登录'];
  const ta = LS.typeAhead;
  assert.strictEqual(ta(labels, -1, 'b'), 1);
  assert.strictEqual(ta(labels, 1, 'b'), 3, 'searches from the next row');
  assert.strictEqual(ta(labels, 3, 'B'), 1, 'wraps, case-insensitive');
  assert.strictEqual(ta(labels, 0, 'aa'), 4, 'same letter repeated: moves to the next row starting with a');
  assert.strictEqual(ta(labels, 4, 'aaa'), 0);
  assert.strictEqual(ta(labels, 0, 'al'), 0, 'an extra letter that still matches the current row: focus stays');
  assert.strictEqual(ta(labels, 0, 'alpi'), 4);
  assert.strictEqual(ta(labels, 2, 'z'), -1);
  assert.strictEqual(ta(labels, 0, '修'), 5, 'works for CJK titles too');
  assert.strictEqual(ta([], 0, 'a'), -1);
  assert.strictEqual(ta(labels, 0, ''), -1);
});

test('session-list.js incremental sync: the same key keeps the same node, only new items are created and only removed ones deleted, nothing moves if the order is unchanged; reuse can supply an existing node from elsewhere', () => {
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
  assert.strictEqual(box.moves, moves, 'order unchanged: nothing moved');
  sync(['a', 'x', 'b', 'c']);
  assert.deepStrictEqual(made, ['a', 'b', 'c', 'x']);
  assert.deepStrictEqual(box.kids.map((n) => n.k), ['a', 'x', 'b', 'c']);
  assert.ok(box.kids[0] === a && box.kids[2] === b && box.kids[3] === c);
  sync(['c', 'a']);
  assert.deepStrictEqual(box.kids.map((n) => n.k), ['c', 'a']);
  assert.ok(box.kids[0] === c && box.kids[1] === a, 'swapped items keep their nodes');
  const spare = new N('z');
  sync(['c', 'a', 'z'], (k) => (k === 'z' ? spare : null));
  assert.strictEqual(box.kids[2], spare, 'the node from reuse is moved in, nothing is created');
  assert.ok(!made.includes('z'));
});

test('session list view model: data-vscode-context content; no group label when there is only one group; selection only accepts keys in the list', () => {
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
  assert.deepStrictEqual(JSON.parse(rows[0].context), { webviewSection: 'session', sessionKey: open.key, compactable: true, resumable: false, handoff: true, autoCompact: true, preventDefaultContextMenuItems: true });
  assert.deepStrictEqual(JSON.parse(rows[1].context), { webviewSection: 'session', sessionKey: done.key, compactable: false, resumable: true, handoff: true, autoCompact: true, preventDefaultContextMenuItems: true });
  assert.strictEqual(vm.items.filter((x) => x.kind === 'group').length, 2);
  const one = AV.buildSessionList({ arranged: createSessionOrder().arrange([done]), i18n, now: NOW, selectedKey: 'claude:nope' });
  assert.strictEqual(one.showGroups, false);
  assert.ok(one.items.every((x) => x.kind === 'session'));
  assert.strictEqual(one.selectedKey, null);
  assert.deepStrictEqual(AV.buildSessionList({ i18n }).items, [], 'no data yet: empty list');
});

test('position: sessionListPosition = left / right is used as is; auto follows the terminal tab list (terminal.integrated.tabs.location, default right)', () => {
  const r = AV.resolveListPosition;
  assert.strictEqual(r('left', 'right'), 'left');
  assert.strictEqual(r('right', 'left'), 'right');
  assert.strictEqual(r('auto', 'left'), 'left');
  assert.strictEqual(r('auto', 'right'), 'right');
  assert.strictEqual(r('auto', undefined), 'right');
  assert.strictEqual(r(undefined, 'left'), 'left');
  assert.strictEqual(r('bogus', 'bogus'), 'right');
});

test('session menu: SESSION_MENU matches webview/context in package.json one to one (command, order, group, when); filtered by flags', () => {
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
    ['goToChat', 'compact', 'handoff', 'setAutoCompact', 'copyResume', 'markSeen', 'openTranscript', 'revealTranscript', 'copyTranscriptPath']);
  const names = (f) => AV.sessionMenuItems(f).map((m) => m.command.replace('agentMonitor.', ''));
  // Go to Chat is on every session (when the jump is not possible, the command says why)
  assert.deepStrictEqual(names({}), ['goToChat', 'markSeen', 'openTranscript', 'revealTranscript', 'copyTranscriptPath']);
  assert.deepStrictEqual(names({ handoff: true, autoCompact: true }), ['goToChat', 'handoff', 'setAutoCompact', 'markSeen', 'openTranscript', 'revealTranscript', 'copyTranscriptPath']);
  assert.ok(names({ compactable: true }).includes('compact') && !names({ compactable: true }).includes('copyResume'));
  assert.ok(names({ resumable: true }).includes('copyResume'));
  assert.deepStrictEqual(AV._internal.flagsOf('session provider-claude lamp-idle resumable compactable'), { compactable: true, resumable: true, handoff: true, autoCompact: true });
  assert.deepStrictEqual(AV._internal.flagsOf('session provider-codex lamp-idle'), { compactable: false, resumable: false, handoff: true, autoCompact: true });
  for (const p of ['copilot', 'gemini', 'qwen']) assert.deepStrictEqual(AV._internal.flagsOf(`session provider-${p} lamp-idle`), { compactable: false, resumable: false, handoff: false, autoCompact: false }, p);
  assert.deepStrictEqual(AV._internal.flagsOf('session lamp-compactable'), { compactable: false, resumable: false, handoff: false, autoCompact: false }, 'whole-word match');
});

test('content empty state: offers "show all sessions" when showing only the workspace and it has no sessions; not while loading', () => {
  const vm = AV.buildViewModel({ session: null, i18n, loaded: true, emptyText: 'x', emptyAction: 'showAll' });
  assert.deepStrictEqual(vm.emptyAction, { act: 'showAll', text: i18n.t('scope.showAll') });
  assert.strictEqual(AV.buildViewModel({ session: null, i18n, loaded: false, emptyAction: 'showAll' }).emptyAction, null);
  assert.strictEqual(AV.buildViewModel({ session: null, i18n, loaded: true }).emptyAction, null);
});

test('media/agents.js wiring: listbox keyboard, Enter / Space selects, type-ahead, data-vscode-context, no tooltip change while hovered, sash drag and double-click, width saved in state and sent to the extension', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'agents.js'), 'utf8');
  assert.ok(js.includes("const LS = window.AgentMonitorList;") && js.includes('const syncKeyed = LS.syncKeyed;'), 'uses the pure functions from session-list.js');
  assert.ok(/role: 'option'/.test(js) && /'aria-selected'/.test(js) && /'aria-activedescendant'/.test(js));
  assert.ok(/e\.key === 'Enter' \|\| e\.key === ' '/.test(js), 'Enter / Space selects');
  assert.ok(/LS\.moveIndex\(e\.key/.test(js) && /LS\.typeAhead\(/.test(js));
  assert.ok(/e\.key === 'ContextMenu' \|\| \(e\.shiftKey && e\.key === 'F10'\)/.test(js), 'Menu key / Shift+F10 opens "…"');
  assert.ok(/at\(el, 'data-vscode-context', it\.context\)/.test(js));
  assert.ok(/el\.matches\(':hover'\)/.test(js) && /mouseleave/.test(js), 'title is not changed while hovered, only after the pointer leaves');
  assert.ok(/postMessage\(\{ type: 'select', sessionKey: key \}\)/.test(js));
  assert.ok(/type: act === 'rowCompact' \? 'compact' : 'more', sessionKey: row\._data\.key/.test(js), 'row-end buttons send only the type and key');
  assert.ok(/postMessage\(\{ type: 'resizeList', width: savedWidth \}\)/.test(js) && /state\.listWidth = savedWidth/.test(js));
  assert.ok(/addEventListener\('dblclick', \(\) => saveWidth\(LS\.WIDTH\.DEFAULT\)\)/.test(js), 'double-click resets');
  assert.ok(/setPointerCapture/.test(js) && /LS\.dragWidth\(position, e\.clientX, panel\)/.test(js));
  // the right-click menu is left to VS Code: the page's contextmenu handler must not call preventDefault
  const ctx = js.slice(js.indexOf("E.box.addEventListener('contextmenu'"), js.indexOf("E.box.addEventListener('contextmenu'") + 300);
  assert.ok(ctx.length > 50 && !ctx.includes('preventDefault'), ctx);
  // the content area scrolls by itself
  assert.ok(!/window\.scrollTo|window\.scrollY/.test(js) && /E\.content\.scrollTop/.test(js));
});

test('media/agents.css: sash line color from theme variables (high-contrast contrastBorder → editorOverviewRuler.border, as used by the terminal line → panel-border), 4px hit area + sash.hoverBorder; 22px rows, 8px left padding; state colors use list.* variables; no opacity', () => {
  const css = fs.readFileSync(path.join(ROOT, 'media', 'agents.css'), 'utf8');
  // the vertical line seen in the terminal panel is the overview ruler border, one shade darker than panel-border; without these variables it falls back to panel-border
  assert.ok(/--list-line: var\(--vscode-contrastBorder, var\(--vscode-editorOverviewRuler-border, var\(--vscode-panel-border/.test(css));
  assert.ok(/\.list-right \.slist \{ border-left: 1px solid var\(--list-line\); \}/.test(css) && /\.list-left \.slist \{ border-right: 1px solid var\(--list-line\); \}/.test(css));
  assert.ok(/--sash-hover: var\(--vscode-sash-hoverBorder/.test(css));
  const sash = css.slice(css.indexOf('.sash::before {'), css.indexOf('}', css.indexOf('.sash::before {')));
  assert.ok(/width: 4px;/.test(sash) && /cursor: ew-resize;/.test(sash), sash);
  const row = css.slice(css.indexOf('.sl-row {'), css.indexOf('}', css.indexOf('.sl-row {')));
  assert.ok(/height: var\(--row-h\);/.test(row) && /padding: 0 4px 0 8px;/.test(row), row);
  for (const v of ['list-hoverBackground', 'list-activeSelectionBackground', 'list-activeSelectionForeground', 'list-inactiveSelectionBackground',
    'list-inactiveSelectionForeground', 'list-focusOutline', 'contrastActiveBorder']) assert.ok(css.includes('--vscode-' + v), v);
  assert.ok(!/opacity\s*:/.test(css), 'no opacity dimming');
  assert.ok(/\.slist\.narrow \.sl-title, \.slist\.narrow \.sl-desc, \.slist\.narrow \.sl-acts \{ display: none !important; \}/.test(css), 'narrow strip shows icons only');
  assert.ok(/\.sl-desc \{ flex: none;/.test(css) && /\.sl-desc:empty \{ display: none; \}/.test(css), 'only a short marker follows the title, and it takes no space when empty');
});

test('media/agents.css (matching the terminal tab list): 10px between the line and the rows (none for the narrow strip), 4px between icon and text; the session bar source segment never shrinks to a lone letter and is hidden in a narrow content area', () => {
  const css = fs.readFileSync(path.join(ROOT, 'media', 'agents.css'), 'utf8');
  // in the terminal panel, a 10px overview ruler sits between the vertical line and the tab rows
  assert.ok(/\.list-right \.slist:not\(\.narrow\) \{ padding-left: 10px; \}/.test(css), 'list on the right: 10px on the left');
  assert.ok(/\.list-left \.slist:not\(\.narrow\) \{ padding-right: 10px; \}/.test(css), 'list on the left: 10px on the right');
  // terminal tabs are "icon + space + name", which measures 4px; title and short status stay 6px apart
  const row = css.slice(css.indexOf('.sl-row {'), css.indexOf('}', css.indexOf('.sl-row {')));
  assert.ok(/gap: 4px;/.test(row), row);
  assert.ok(/\.sl-desc \{[^}]*margin-left: 2px;/.test(css), '2px extra before the short status');
  // source · entry · model · directory: when it does not fit, keep at least a few characters plus an ellipsis; hidden entirely in a narrow content area (the list row tooltip has the same info)
  assert.ok(/\.s-head \.s-meta \{[^}]*min-width: 4em;/.test(css));
  const narrow = css.slice(css.indexOf('@container content (max-width: 699px)'));
  assert.ok(/\.s-head \.s-meta \{ display: none; \}/.test(narrow), 'narrow content area hides the source segment');
});

function listFixture() {
  const order = createSessionOrder({ now: () => NOW });
  const a = session({ id: 'aaaaaaaa-0000-4000-8000-00000000000a', title: 'Alpha', live: true, main: agent({ tokens: tokens(120000) }) });
  const b = session({ id: 'aaaaaaaa-0000-4000-8000-00000000000b', title: 'Beta', startedMs: NOW - 300 * MIN });
  const list = [a, b];
  return { a, b, input: { arranged: order.arrange(list), lamps: lamp.computeLamps(list, { seen: 0 }).bySession, now: NOW, selectedKey: a.key, position: 'right', width: 200 } };
}

test('provider list messages: after ready, list is posted before render; unchanged → not reposted; reposted only when position / width / selection changes', () => {
  const st = makeStub();
  const p = new AV.AgentsViewProvider(st.context, { vscode: st.vscode, i18n });
  p.resolveWebviewView(st.view);
  const { a, b, input } = listFixture();
  p.updateList(input);
  p.update({ session: a, now: NOW, loaded: true });
  assert.strictEqual(st.log.posted.length, 0, 'nothing before ready');
  st.listeners.msg({ type: 'ready' });
  assert.deepStrictEqual(st.log.posted.map((m) => m.type), ['list', 'render']);
  assert.deepStrictEqual(st.log.posted[0].items.filter((x) => x.kind === 'session').map((x) => x.key), [a.key, b.key]);
  p.updateList({ ...input, now: NOW + 7000 });
  assert.strictEqual(st.log.posted.length, 2, 'list unchanged: not reposted');
  p.updateList({ ...input, selectedKey: b.key });
  assert.strictEqual(st.log.posted.length, 3);
  assert.strictEqual(st.log.posted[2].selectedKey, b.key);
  p.updateList({ ...input, selectedKey: b.key, position: 'left' });
  assert.strictEqual(st.log.posted[3].position, 'left');
  p.updateList({ ...input, selectedKey: b.key, position: 'left', width: 70 });
  assert.strictEqual(st.log.posted[4].width, 80, 'width is snapped before posting');
  assert.strictEqual(st.log.posted.length, 5);
});

test('provider list messages: select / more accept only keys in the list; resizeList snaps and hands over to the extension; width sent with ready is synced; showAll runs "show all sessions"', async () => {
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
  assert.deepStrictEqual(calls.resize, [46], 'width from ready (page state) is snapped and synced to the extension');
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
  // compact at the row end: works for any session in the list (not only the one shown)
  st.listeners.msg({ type: 'compact', sessionKey: b.key });
  st.listeners.msg({ type: 'compact', sessionKey: 'claude:not-listed' });
  st.listeners.msg({ type: 'showAll' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(st.log.commands, [[AV.COMPACT_COMMAND, b.key], [AV.SHOW_ALL_COMMAND]]);
  assert.strictEqual(AV.SHOW_ALL_COMMAND, 'agentMonitor.scope.all');
});

test('provider description: set on the webview view; remembered until the view exists, then applied; no badge of its own', () => {
  const st = makeStub();
  const p = new AV.AgentsViewProvider(st.context, { vscode: st.vscode, i18n });
  p.setDescription('This workspace');
  p.resolveWebviewView(st.view);
  assert.strictEqual(st.view.description, 'This workspace');
  assert.strictEqual(st.view.badge, undefined, 'the panel tab\'s badge comes from the hidden overview tree');
  assert.strictEqual(typeof p.setBadge, 'undefined');
  p.setDescription(undefined);
  assert.strictEqual(st.view.description, undefined);
});

// ---------- Copilot / Gemini CLI / Qwen Code ----------

// Sessions shaped like lib/providers/{copilot,gemini,qwen}.js produce them: no auto-compact point, no cache, no resume hints
const noCompact = (used, window, o = {}) => ({ display: used, contextUsed: used, contextWindow: window, compactAt: null, toCompact: null,
  output: 900, processed: 50000, apiCalls: 4, ...o });
function providerSession(provider, o = {}) {
  const base = {
    copilot: { entry: 'vscode', model: 'copilot/claude-sonnet-4.5', contextWindow: 128000, contextWindowSource: 'copilot-model', costUsd: null,
      copilot: { credits: 1.5, multiplier: 1, cachedTokens: 0, requests: 2, queued: 0, modelState: 4, mode: 'agent', permissionLevel: 'default', storage: 'workspace', workspaceFile: null } },
    gemini: { entry: 'cli', model: 'gemini-2.5-pro', contextWindow: 1048576, contextWindowSource: 'model-rule', costUsd: 0.05, liveCertainty: 'guess' },
    qwen: { entry: 'cli', model: 'coder-model', contextWindow: 1000000, contextWindowSource: 'qwen-record', costUsd: null, unpricedModel: 'coder-model' },
  }[provider];
  return session({
    provider, id: provider + '-1', entryRaw: null, entrypoint: null, cacheExpiresMs: null, compactAt: null, compactAtSource: null, resume: [],
    ...base,
    main: agent({ model: base.model, tokens: noCompact(90000, base.contextWindow), costUsd: base.costUsd, cacheTtl: null, file: `/synthetic/${provider}.jsonl` }),
    ...o,
  });
}

test('Copilot: "Credits" column with plain credit numbers, credits in the session bar, sub-agents named by their task, waiting parts by name, lag note', () => {
  const s = providerSession('copilot', {
    live: true, liveStatus: 'waiting',
    main: agent({ model: 'copilot/claude-sonnet-4.5', status: S.makeStatus('awaitingInput', NOW - 20000, { question: 'planApproval' }),
      step: { kind: 'tool', tool: 'planReview', detail: null, parallel: 0, sinceMs: NOW - 20000 },
      tokens: noCompact(41000, 128000), costUsd: null, copilotCredits: 1.5, cacheTtl: null }),
    agents: [sub('sa1', NOW - MIN, { kind: 'copilotSubagent', name: 'Explorer', agentType: 'Explore', description: 'Survey the repo for auth call sites',
      model: 'claude-haiku-4.5', costUsd: null, tokens: noCompact(0, null) })],
  });
  const vm = build(s);
  assert.deepStrictEqual(vm.costHead, { text: 'Credits', tip: i18n.t('cost.copilot.note') });
  assert.strictEqual(build(session()).costHead, null, 'other providers keep the default "Cost" header');
  const [main, sa] = vm.rows;
  assert.strictEqual(main.costText, '1.5');
  assert.strictEqual(main.costTip, '1.5 credits');
  assert.ok(main.tip.includes('Copilot credits: 1.5 credits'), main.tip);
  assert.ok(!main.tip.includes('API-equivalent cost'));
  assert.strictEqual(main.statusText, 'Waiting for you to approve the plan');
  assert.strictEqual(main.stepText, 'Plan review · 20s');
  assert.strictEqual(sa.name, 'Survey the repo for auth call sites');
  assert.strictEqual(sa.sub, 'claude-haiku-4.5 · Subagent · Explorer');
  assert.strictEqual(sa.costText, '—');
  assert.strictEqual(sa.costTip, i18n.t('cost.credits.inSession'));
  const bar = vm.session;
  assert.ok(bar.meta.startsWith('Copilot · VS Code · '), bar.meta);
  assert.strictEqual(bar.costText, 'This session: 1.5 credits');
  assert.ok(bar.costTip.startsWith('Copilot credits\nCopilot bills in credits'), bar.costTip);
  assert.ok(bar.statusTip.includes('60 seconds'), 'status can lag about a minute');
  assert.strictEqual(bar.guess, false);
  // No credits recorded (older VS Code): nothing in the bar, "—" in the cell with the reason on hover
  const none = build(providerSession('copilot', { copilot: { credits: null }, main: agent({ tokens: noCompact(1000, 128000), costUsd: null, copilotCredits: null }) }));
  assert.strictEqual(none.session.costText, '');
  assert.strictEqual(none.rows[0].costText, '—');
  assert.strictEqual(none.rows[0].costTip, i18n.t('cost.credits.none'));
  // Session list tooltip: credits row and the Copilot billing note, no API price note
  const tip = AV.sessionTipText(s, null, i18n, { now: NOW });
  assert.ok(tip.includes('Copilot credits: 1.5 credits') && tip.includes('Copilot bills in credits') && !tip.includes('list API prices'), tip);
});

test('Copilot without token counts (and its sub-agents, never counted): "—" in the Context column and bar, no meter, no "0% context", reason on hover', () => {
  const zero = noCompact(0, 128000, { output: 0, processed: 0, apiCalls: 0 });
  const s = providerSession('copilot', {
    main: agent({ model: 'copilot/claude-sonnet-4.5', tokens: zero, costUsd: null, copilotCredits: 2, cacheTtl: null }),
    agents: [sub('sa1', NOW - MIN, { kind: 'copilotSubagent', name: 'Explorer', agentType: 'Explore', description: 'Survey', model: 'claude-haiku-4.5',
      costUsd: null, tokens: noCompact(0, null, { output: 0, processed: 0, apiCalls: 0 }) })],
  });
  const vm = build(s);
  const [main, sa] = vm.rows;
  for (const r of [main, sa]) {
    assert.strictEqual(r.tokensText, '—', r.name);
    assert.ok(!r.tip.includes('0 tokens') && !r.tip.includes('Latest call'), r.tip);
    assert.ok(r.tip.includes('API calls: —'), r.tip);
  }
  assert.strictEqual(main.tokensTip, i18n.t('ctx.unknown.note'));
  assert.strictEqual(sa.tokensTip, i18n.t('ctx.unknown.sub'));
  assert.ok(main.tip.includes('Context: — / 128K'), main.tip);
  assert.ok(sa.tip.includes(i18n.t('ctx.unknown.sub')), sa.tip);
  const c = vm.session.context;
  assert.strictEqual(c.text, '— / 128K window');
  assert.strictEqual(c.pct, null, 'no meter');
  assert.strictEqual(c.shortText, '');
  assert.strictEqual(c.pctText, '');
  assert.strictEqual(c.zone, null);
  assert.ok(c.tip.includes(i18n.t('ctx.unknown.note')) && !c.tip.includes('0%'), c.tip);
  const L = lamp.sessionLamps(s, { seenAtMs: 0 });
  const row = AV.sessionRowVm(s, L, i18n, NOW);
  assert.ok(!row.description.includes('context'), row.description);
  assert.ok(AV.sessionTipText(s, L, i18n, { now: NOW }).includes('Context: — / 128K'));
  // With usage recorded the Copilot main agent keeps its numbers
  const known = build(providerSession('copilot')).rows[0];
  assert.strictEqual(known.tokensText, '90K');
  assert.strictEqual(known.tokensTip, '');
  // The page puts the reason on the cell
  const js = fs.readFileSync(path.join(ROOT, 'media', 'agents.js'), 'utf8');
  assert.ok(/at\(u\.tok, 'title', r\.tokensTip/.test(js));
});

test('last usage-limit hit banner: Copilot / Gemini CLI / Qwen Code for an hour after the hit, Claude until its reset time, never on other tools', () => {
  const hit = (o) => ({ kind: 'unknown', model: null, resetsAtMs: null, resetsText: null, source: 'text', autoContinue: null, ms: NOW - 10 * MIN, sessionKey: 'qwen:other', ...o });
  const info = (vm) => vm.session.banners.filter((b) => b.tone === 'info' && b.text.startsWith('Last '));
  for (const p of ['copilot', 'gemini', 'qwen']) {
    const s = providerSession(p);
    const b = info(build(s, { quota: { [p]: { lastHit: hit() } } }));
    assert.strictEqual(b.length, 1, p);
    assert.strictEqual(b[0].text, `Last ${i18n.t('provider.' + p)} limit hit: Usage limit reached (10m ago)`);
    assert.strictEqual(b[0].tip, i18n.t('quota.lastHit.tip'));
    assert.strictEqual(info(build(s, { quota: { [p]: { lastHit: hit({ ms: NOW - 2 * 60 * MIN }) } } })).length, 0, p + ': an old hit is not shown');
    // this session's own status already says it
    const own = providerSession(p, { main: agent({ status: S.makeStatus('quota', NOW - MIN, { quota: hit() }), tokens: noCompact(1000, 128000), costUsd: null, cacheTtl: null }) });
    assert.strictEqual(info(build(own, { quota: { [p]: { lastHit: hit() } } })).length, 0, p);
  }
  assert.strictEqual(info(build(providerSession('gemini'), { quota: { qwen: { lastHit: hit() } } })).length, 0, 'another tool\'s hit');
  assert.strictEqual(info(build(session(), { quota: { claude: { lastHit: hit() } } })).length, 0, 'Claude without a reset time: as before, nothing');
  assert.strictEqual(info(build(session(), { quota: { claude: { lastHit: hit({ kind: 'weekly', resetsAtMs: NOW + 60 * MIN }) } } })).length, 1);
});

test('today\'s total says it covers Claude Code and Codex only', () => {
  const today = { dayStartMs: NOW - 3600e3, partial: false, progress: 1, claude: { costUsd: 1.5, unpricedTokens: 0, byModel: {} }, codex: { costUsd: 0, unpricedTokens: 0, byModel: {} } };
  assert.ok(build(providerSession('gemini'), { today }).session.todayTip.includes(i18n.t('cost.today.scope')));
});

test('Gemini CLI: guessed statuses get the guess cue ("~", italic class, note); token breakdown and estimate marker in the row tooltip', () => {
  const s = providerSession('gemini', {
    live: true, liveStatus: 'busy',
    main: agent({ model: 'gemini-2.5-pro', status: S.makeStatus('thinking', NOW - 3000, { certainty: 'guess' }),
      tokens: noCompact(52000, 1048576, { input: 52000, cached: 30000, thoughts: 1200, tool: 300 }), costUsd: 0.0516, costEstimated: true, cacheTtl: null }),
    agents: [sub('g1', NOW - MIN, { kind: 'geminiSubagent', name: 'investigator', agentType: 'codebase_investigator', model: 'gemini-2.5-flash', status: S.makeStatus('done', NOW - 30000),
      tokens: noCompact(9000, 1048576, { input: 9000, cached: 0, thoughts: 0, tool: 0 }), costUsd: 0.01 })],
  });
  const vm = build(s);
  const [main, g1] = vm.rows;
  assert.strictEqual(main.statusText, '~Thinking');
  assert.strictEqual(main.guess, true);
  assert.strictEqual(g1.guess, false, 'certain sub-agent done');
  assert.strictEqual(g1.name, 'investigator');
  assert.strictEqual(g1.sub, 'gemini-2.5-flash · Subagent · codebase_investigator');
  assert.ok(main.tip.includes('Input 52K (cached 30K) · thoughts 1.2K · tool use 300'), main.tip);
  assert.ok(main.tip.includes('Guessed from when the session log was last written'), main.tip);
  assert.strictEqual(main.costText, '$0.052');
  assert.strictEqual(main.costTip, '$0.052 est.');
  assert.strictEqual(vm.session.statusText, '~Thinking');
  assert.strictEqual(vm.session.guess, true);
  assert.ok(vm.session.metaTip.includes('probably open'), vm.session.metaTip);
  assert.ok(vm.session.costTip.includes('2026-09-24'), 'Gemini price table date');
  // Session list: churning statuses collapse to "Working" but keep the guess mark
  const L = lamp.sessionLamps(s, { seenAtMs: 0 });
  const row = AV.sessionRowVm(s, L, i18n, NOW);
  assert.strictEqual(row.description, 'Gemini CLI · ~Working · 5% context');
  assert.ok(row.a11y.includes('~Working'));
  // A guessed done is DoneUnseen like any done, with the same cue
  const done = providerSession('gemini', { doneAtMs: NOW - 60000,
    main: agent({ status: S.makeStatus('done', NOW - 60000, { certainty: 'guess' }), tokens: noCompact(1000, 1048576), cacheTtl: null }) });
  const dvm = build(done);
  assert.strictEqual(dvm.session.lamp, 'doneUnseen');
  assert.strictEqual(dvm.session.statusText, '~Turn finished');
  assert.strictEqual(dvm.rows[0].guess, true);
});

test('Copilot / Gemini CLI / Qwen Code: no compaction UI (no auto-compact button or line, no compact button, no "auto-compact is off"); unpriced models keep their tokens', () => {
  for (const p of ['copilot', 'gemini', 'qwen']) {
    const s = providerSession(p);
    const vm = build(s, { describeCompact: () => ({ valueText: '400K', text: '400K (40%)' }) });
    const bar = vm.session;
    assert.strictEqual(bar.autoCompact, null, p + ': no auto-compact setting to read or change');
    assert.strictEqual(bar.compactable, false, p);
    assert.strictEqual(bar.cache, null, p);
    assert.strictEqual(bar.context.remainText, '', p);
    assert.ok(!bar.context.text.includes('auto-compact'), bar.context.text);
    assert.ok(bar.context.tip.includes(i18n.t('ctx.compactUnknown')), p);
    assert.ok(!bar.context.tip.includes('Auto-compact is off') && !bar.context.tip.includes('CLAUDE_'), bar.context.tip);
    assert.ok(!vm.rows[0].tip.includes('Auto-compact is off'), vm.rows[0].tip);
    assert.ok(!/\{\w+\}/.test(JSON.stringify(vm)), p + ': no unreplaced placeholders');
    const list = AV.buildSessionList({ arranged: { groups: [{ id: 'recent', sessions: [s] }], showGroupHeaders: false }, i18n, now: NOW });
    assert.strictEqual(list.items[0].compactable, false, p);
    const ctx = JSON.parse(list.items[0].context);
    assert.ok(ctx.handoff === false && ctx.autoCompact === false, p + ': no Handoff / Set Auto-Compact in the context menu');
  }
  // Qwen OAuth 'coder-model': tokens stay, the cell says "—" and the tooltip "No public price"
  const q = build(providerSession('qwen', { main: agent({ model: 'coder-model', tokens: noCompact(30000, 1000000), costUsd: null, unpricedModel: 'coder-model', cacheTtl: null }) }));
  assert.strictEqual(q.rows[0].tokensText, '30K');
  assert.strictEqual(q.rows[0].costText, '—');
  assert.strictEqual(q.rows[0].costTip, 'No public price');
  assert.strictEqual(q.session.costText, 'This session: No public price');
});

test('sessions scanned by the real Copilot / Gemini CLI / Qwen Code providers from synthetic files render fully in every language', () => {
  const { CopilotProvider } = require('../lib/providers/copilot');
  const { GeminiProvider } = require('../lib/providers/gemini');
  const { QwenProvider, sanitizeCwd } = require('../lib/providers/qwen');
  const base = path.join(TMP, 'providers');
  const line = (o) => JSON.stringify(o) + '\n';
  const write = (file, text, mtimeMs) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  };
  const iso = (ms) => new Date(ms).toISOString();
  // Copilot: a request waiting on a question carousel, credits recorded, one running sub-agent
  const user = path.join(base, 'Code', 'User');
  const md = (t) => ({ value: t });
  const req = (n, o) => ({ requestId: 'r' + n, timestamp: NOW - 60000 + n, message: { text: 'prompt ' + n }, modelId: 'copilot/claude-sonnet-4.5', response: o.parts,
    modelState: { value: o.state }, ...(o.extra || {}) });
  const sub = { kind: 'toolInvocationSerialized', toolId: 'runSubagent', toolCallId: 'sa1', invocationMessage: md('Delegating'), isConfirmed: { type: 1 }, isComplete: false,
    toolSpecificData: { kind: 'subagent', agentName: 'Explore', description: 'Survey the repo', prompt: 'p' } };
  const croot = (id, requests) => ({ version: 3, sessionId: id, creationDate: NOW - 120000, initialLocation: 'panel', requests, pendingRequests: [],
    inputState: { selectedModel: { identifier: 'copilot/claude-sonnet-4.5', metadata: { maxInputTokens: 128000, multiplierNumeric: 1 } } } });
  const cdir = path.join(user, 'workspaceStorage', 'ws1', 'chatSessions');
  write(path.join(cdir, 'cop-q.jsonl'), line({ kind: 0, v: croot('cop-q', [req(1, { state: 4, parts: [{ kind: 'questionCarousel', questions: [] }], extra: { copilotCredits: 1.5 } })]) }), NOW - 20000);
  write(path.join(cdir, 'cop-s.jsonl'), line({ kind: 0, v: croot('cop-s', [req(1, { state: 0, parts: [sub] })]) }), NOW - 20000);
  const copilot = new CopilotProvider({ userDir: user, activeWindowMinutes: 30, staleMinutes: 5 }).scan(NOW);
  // Gemini CLI: one turn that went quiet (guessed done), token breakdown recorded
  const ghome = path.join(base, 'gemini');
  const gfile = path.join(ghome, 'tmp', 'proj', 'chats', 'session-2026-09-24T09-58-aaaa1111.jsonl');
  write(gfile, [
    { sessionId: 'aaaa1111-0000-4000-8000-000000000001', projectHash: 'ph', startTime: iso(NOW - 180000), lastUpdated: iso(NOW - 120000), kind: 'main' },
    { id: 'u1', timestamp: iso(NOW - 180000), type: 'user', content: [{ text: 'Fix the flaky test' }] },
    { id: 'g1', timestamp: iso(NOW - 120000), type: 'gemini', content: 'All tests pass now.', model: 'gemini-2.5-pro',
      tokens: { input: 52000, output: 800, cached: 30000, thoughts: 1200, tool: 300, total: 54300 } },
  ].map(line).join(''), NOW - 120000);
  const gemini = new GeminiProvider({ geminiHome: ghome, activeWindowMinutes: 30, staleMinutes: 5 }).scan(NOW);
  // Qwen Code: an OAuth 'coder-model' turn (unpriced)
  const qhome = path.join(base, 'qwen');
  const qsid = 'dddd4444-0000-4000-8000-000000000004';
  const qrec = (ms, type, extra) => ({ uuid: 'u' + ms, parentUuid: null, sessionId: qsid, timestamp: iso(ms), type, cwd: '/work/qw', version: '0.9.0', ...extra });
  write(path.join(qhome, 'projects', sanitizeCwd('/work/qw'), 'chats', qsid + '.jsonl'), [
    qrec(NOW - 90000, 'user', { message: { role: 'user', parts: [{ text: 'Summarise the repo' }] } }),
    { ...qrec(NOW - 80000, 'assistant', { message: { role: 'model', parts: [{ text: 'Here it is.' }] } }), model: 'coder-model', contextWindowSize: 1000000,
      usageMetadata: { promptTokenCount: 30000, candidatesTokenCount: 400, cachedContentTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 30400 } },
  ].map(line).join(''), NOW - 80000);
  const qwen = new QwenProvider({ qwenHome: qhome, activeWindowMinutes: 30, staleMinutes: 5 }).scan(NOW);

  const byId = (list, id) => list.find((x) => x.id === id || x.id.startsWith(id));
  const cq = byId(copilot, 'cop-q');
  const cs = byId(copilot, 'cop-s');
  const gd = byId(gemini, 'aaaa1111');
  const qd = byId(qwen, qsid);
  assert.ok(cq && cs && gd && qd, 'every provider produced its session');
  for (const locale of ['en', 'zh-cn', 'zh-tw', 'ko', 'ja']) {
    const i18nL = i18nLib.createI18n(locale, { timeZone: 'UTC' });
    for (const s of [cq, cs, gd, qd]) {
      const vm = AV.buildViewModel({ session: s, i18n: i18nL, now: NOW, expanded: ['main'], loaded: true, describeCompact: null });
      const json = JSON.stringify(vm);
      assert.ok(!/\{\w+\}/.test(json), `${locale} ${s.key}: unreplaced placeholder`);
      assert.ok(!/"(status|tool|cost|ctx|provider|entry|count)\.[\w.]+"/.test(json), `${locale} ${s.key}: raw dictionary key in the output`);
      assert.ok(vm.session.meta.startsWith(i18nL.t('provider.' + s.provider) + ' · '), vm.session.meta);
      AV.sessionTipText(s, null, i18nL, { now: NOW });
    }
  }
  const en = i18n;
  const q = build(cq);
  assert.strictEqual(q.rows[0].statusText, 'Waiting for your answer');
  assert.ok(q.rows[0].stepText.startsWith('Question for you'), q.rows[0].stepText);
  assert.strictEqual(q.rows[0].costText, '1.5');
  const sv = build(cs);
  const subRow = sv.rows.find((r) => r.id !== 'main');
  assert.strictEqual(subRow.name, 'Survey the repo');
  assert.strictEqual(subRow.sub.split(' · ').slice(-2).join(' · '), 'Subagent · Explore');
  const g = build(gd);
  assert.strictEqual(g.session.lamp, 'doneUnseen');
  assert.strictEqual(g.rows[0].statusText, '~Turn finished');
  assert.strictEqual(g.rows[0].guess, true);
  assert.ok(g.rows[0].tip.includes(en.t('count.breakdown', { input: '52K', cached: '30K', thoughts: '1.2K', tool: '300' })), g.rows[0].tip);
  const qv = build(qd);
  assert.strictEqual(qv.rows[0].costTip, 'No public price');
  assert.strictEqual(qv.session.autoCompact, null);
});

test('media: guessed statuses are italic in the session bar and the table; the cost column header follows costHead', () => {
  const css = fs.readFileSync(path.join(ROOT, 'media', 'agents.css'), 'utf8');
  assert.ok(/#s-status\.guess, \.row\.guess \.st \{ font-style: italic; \}/.test(css), 'guess cue');
  const js = fs.readFileSync(path.join(ROOT, 'media', 'agents.js'), 'utf8');
  assert.ok(/E\.status\.classList\.toggle\('guess', !!s\.guess\)/.test(js));
  assert.ok(/txt\(E\.costHead, m\.costHead \? m\.costHead\.text : t\('webview\.col\.cost'\)\)/.test(js), 'header text from the view model, default "Cost"');
});

// ---------- Finish ----------

Promise.all(pending).then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch { /* ignore */ }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
});
