'use strict';
// Tests for the side-bar Progress view: lib/progress-view.js (cards, plan, phases, the folded step stream, the provider),
// progressHtml in lib/webview-html.js, and media/progress.js / progress.css (static checks plus a run on a small fake DOM).
// Run with plain Node: node test/progress-view.test.js
// All data is synthetic; nothing is read from ~/.claude or ~/.codex. Temp files go under AGENT_MONITOR_TEST_TMP (or the
// system temp dir if unset) and are deleted afterwards.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const S = require('../lib/core/status');
const i18nLib = require('../lib/i18n');
const lamp = require('../lib/lamp');
const AV = require('../lib/agents-view');
const PV = require('../lib/progress-view');
const LS = require('../media/session-list');
const { progressHtml, WEBVIEW_DICT_PREFIXES } = require('../lib/webview-html');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-progress-'));

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
const F = require('../lib/format');
const SEP = F.SEP;

function agent(o = {}) {
  return {
    id: 'main', kind: 'main', name: null, agentType: null, phase: null, background: false,
    model: 'claude-opus-5-5', status: S.makeStatus('thinking', NOW - 5000), step: null,
    tokens: { display: 84800, contextUsed: 84000, contextWindow: 1000000, compactAt: 967000, toCompact: 883000, output: 1200, processed: 60000, apiCalls: 12 },
    toolCalls: 3, toolErrors: 0, filesChanged: 1,
    costUsd: 0.42, costEstimated: false, unpricedModel: null, lastCompact: null, cacheTtl: '1h',
    startedMs: NOW - 120 * MIN, lastActivityMs: NOW - 5000, mtimeMs: NOW - 5000, file: path.join(TMP, 'main.jsonl'),
    todo: null, turn: null, parentRef: null,
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
const working = (o = {}) => agent({ status: S.makeStatus('tool', NOW - 2000), step: { kind: 'tool', tool: 'Bash', detail: 'npm test', parallel: 1, sinceMs: NOW - 2000 }, ...o });
const done = (o = {}) => agent({ status: S.makeStatus('done', NOW - 10 * MIN), ...o });
const sub = (id, o = {}) => agent({ id, kind: 'subagent', name: 'Sub ' + id, agentType: 'general-purpose', file: path.join(TMP, `agent-${id}.jsonl`), ...o });

// Timeline entries
let clock = NOW - 30 * MIN;
const at = () => (clock += 1000);
const prompt = (detail) => ({ kind: 'prompt', ms: at(), detail });
const call = (tool, ref, detail = '') => ({ kind: 'tool', ms: at(), tool, ref, detail });
const ok = (tool, ref) => ({ kind: 'toolDone', ms: at(), tool, ref });
const bad = (tool, ref) => ({ kind: 'toolError', ms: at(), tool, ref, detail: 'boom' });
const line = (kind, detail) => ({ kind, ms: at(), ...(detail ? { detail } : {}) });
const pair = (tool, ref) => [call(tool, ref), ok(tool, ref)];

const vmOf = (timeline, s = session(), d = {}, o = {}) => PV.progressVm(timeline, s, d, i18n, { now: NOW, canOpen: true, ...o });
const shape = (items) => items.map((x) => (x.type === 'group' ? `group:${x.items.length}` : x.type === 'line' ? `line:${x.key.split(':')[0]}` : x.type));

// ---------- Folding ----------

test('folding: prompt, 3 tools, thinking, 2 tools, text, 1 tool → quoted prompt, one group of 5, the text, a single block', () => {
  const tl = [prompt('Fix the login'), ...pair('Read', 'a'), ...pair('Grep', 'b'), ...pair('Read', 'c'), line('thinking'),
    ...pair('Edit', 'd'), ...pair('Read', 'e'), line('text', 'Looking at the tests'), ...pair('Bash', 'f')];
  const out = vmOf(tl);
  assert.deepStrictEqual(shape(out), ['quote', 'group:5', 'line:text', 'block']);
  assert.strictEqual(out[0].text, i18n.t('webview.progress.you', { text: 'Fix the login' }));
  const g = out[1];
  assert.strictEqual(g.key, 'g:r:a');
  assert.strictEqual(g.state, 'done');
  assert.strictEqual(g.title, i18n.t('webview.progress.ranN', { n: 5 }));
  // categories: most used first, then first seen
  assert.strictEqual(g.cats, [`${i18n.t('webview.step.read')} ×3`, `${i18n.t('webview.step.search')} ×1`, `${i18n.t('webview.step.edit')} ×1`].join(SEP));
  assert.ok(!g.current && !g.defaultOpen);
  assert.strictEqual(out[3].key, 'r:f');
  // the same input twice gives the same output
  assert.strictEqual(JSON.stringify(vmOf(tl)), JSON.stringify(out));
});

test('groups: a running call names what runs now and marks the group current (open while the turn runs); state order running > error > stopped > done', () => {
  const tl = [prompt('Go'), ...pair('Read', 'a'), call('Bash', 'b', 'npm test')];
  const out = vmOf(tl, session(), {}, { running: true });
  const g = out[1];
  assert.strictEqual(g.state, 'running');
  assert.strictEqual(g.title, [i18n.t('webview.progress.ranN', { n: 2 }), i18n.t('webview.progress.nowStep', { step: i18n.t('webview.step.run') })].join(SEP));
  assert.ok(g.current && g.defaultOpen);
  assert.ok(g.items[1].current, 'the running block is highlighted');
  const stateOf = (tl2) => vmOf([prompt('x'), ...tl2]).find((x) => x.type === 'group').state;
  assert.strictEqual(stateOf([call('Read', 'a'), bad('Read', 'a'), call('Bash', 'b')]), 'running');
  assert.strictEqual(stateOf([call('Read', 'a'), bad('Read', 'a'), call('Bash', 'b'), line('interrupt')]), 'error');
  assert.strictEqual(stateOf([...pair('Read', 'a'), call('Bash', 'b'), line('interrupt')]), 'stopped');
  const errTitle = vmOf([prompt('x'), call('Read', 'a'), bad('Read', 'a'), call('Bash', 'b'), line('interrupt')])[1].title;
  assert.strictEqual(errTitle, [i18n.t('webview.progress.ranN', { n: 2 }), i18n.t('webview.progress.failedN', { n: 1 }), i18n.t('webview.progress.stoppedN', { n: 1 })].join(SEP));
  // once the turn ended, groups start closed
  const after = vmOf([prompt('x'), ...pair('Read', 'a'), ...pair('Read', 'b')], session(), {}, { running: false });
  assert.strictEqual(after[1].defaultOpen, false);
  // more than three categories: "and more"
  const many = vmOf([prompt('x'), ...pair('Read', 'a'), ...pair('Grep', 'b'), ...pair('Edit', 'c'), ...pair('Bash', 'd')])[1];
  assert.ok(many.cats.endsWith(SEP + i18n.t('webview.progress.catsMore', { n: 1 })));
  assert.strictEqual(i18n.t('webview.progress.catsMore', { n: 1 }), '+1 more');
});

test('keys stay put when the oldest entries fall off the front', () => {
  const head = [];
  for (let i = 0; i < 5; i++) head.push(...pair('Read', 'old' + i));
  const tl = [...head, prompt('Now'), ...pair('Read', 'a'), ...pair('Edit', 'b'), call('Bash', 'c')];
  const before = vmOf(tl);
  const after = vmOf(tl.slice(10));
  const cur = (out) => out.filter((x) => x.type === 'group' || x.type === 'quote').map((x) => x.key);
  assert.deepStrictEqual(cur(after), cur(before).slice(-2));
  assert.strictEqual(after.find((x) => x.type === 'group').key, 'g:r:a');
  // The prompt fell off: the head of the first group drops with each new call, its key does not change
  const long = [];
  for (let i = 0; i < 6; i++) long.push(...pair('Read', 'h' + i));
  const keysOf = (tl2) => vmOf(tl2).filter((x) => x.type === 'group').map((x) => x.key);
  assert.deepStrictEqual(keysOf(long), ['g:head']);
  assert.deepStrictEqual(keysOf(long.slice(1)), ['g:head'], 'only the call entry fell off (its result keeps the block)');
  assert.deepStrictEqual(keysOf(long.slice(2)), ['g:head']);
  // ...and the earlier turn without its prompt keeps one key too
  const turnKey = (tl2) => vmOf([...tl2, prompt('Next'), ...pair('Edit', 'n')]).find((x) => x.type === 'turn').key;
  assert.strictEqual(turnKey(long), 't:head');
  assert.strictEqual(turnKey(long.slice(2)), 't:head');
  const turnGroups = vmOf([...long.slice(4), prompt('Next')]).find((x) => x.type === 'turn').items.filter((x) => x.type === 'group');
  assert.deepStrictEqual(turnGroups.map((x) => x.key), ['g:head']);
});

test('turns: earlier turns fold to one line each; tool calls of this turn that fell off are counted; a lost prompt is said once', () => {
  const tl = [prompt('First'), ...pair('Read', 'a'), ...pair('Grep', 'b'), line('done'), prompt('Second'), ...pair('Edit', 'c')];
  const out = vmOf(tl);
  assert.deepStrictEqual(shape(out), ['turn', 'quote', 'block']);
  const turn = out[0];
  assert.ok(turn.text.startsWith(i18n.t('webview.progress.prevTurn', { n: 2 })));
  assert.ok(turn.text.includes(SEP), 'with its duration');
  assert.deepStrictEqual(shape(turn.items), ['quote', 'group:2', 'line:done']);
  assert.strictEqual(turn.items[1].defaultOpen, false);
  // the turn's prompt fell off together with some of its calls
  const dropped = vmOf([...pair('Read', 'x'), ...pair('Edit', 'y')], session(), { turn: { sinceMs: NOW - MIN, tools: 9, errors: 0, dropped: { tools: 7 } } });
  assert.deepStrictEqual(shape(dropped), ['note', 'group:2']);
  assert.strictEqual(dropped[0].text, i18n.t('webview.progress.earlier', { n: 7 }));
  // the prompt fell off, but no call of this turn did
  const lost = vmOf([line('text', 'hi'), ...pair('Read', 'x')], session(), { turn: { sinceMs: NOW - MIN, tools: 1, errors: 0, dropped: { tools: 0 } } });
  assert.deepStrictEqual(shape(lost), ['note', 'line:text', 'block']);
  assert.strictEqual(lost[0].text, i18n.t('webview.progress.lost'));
  // A call whose entry fell off while its result is kept is still shown: not counted as not shown
  const half = vmOf([ok('Read', 'r0'), call('Read', 'r1'), ok('Read', 'r1'), call('Grep', 'r2'), ok('Grep', 'r2')], session(),
    { turn: { sinceMs: NOW - MIN, tools: 9, errors: 0, dropped: { tools: 7 } } });
  assert.deepStrictEqual(shape(half), ['note', 'group:3']);
  assert.strictEqual(half[0].text, i18n.t('webview.progress.earlier', { n: 6 }));
  const allShown = vmOf([ok('Read', 'r0'), ...pair('Read', 'r1')], session(), { turn: { sinceMs: NOW - MIN, tools: 2, errors: 0, dropped: { tools: 1 } } });
  assert.deepStrictEqual(shape(allShown), ['note', 'group:2']);
  assert.strictEqual(allShown[0].text, i18n.t('webview.progress.lost'), 'nothing left out: only the lost prompt is said');
});

test('nesting: an Agent block carries its subagent\'s line (parentRef), a Workflow block its run\'s phase line (Workflow.ref)', () => {
  const s = session({
    agents: [sub('s1', { parentRef: 'ag', status: S.makeStatus('tool', NOW - 1000), step: { kind: 'tool', tool: 'Read', detail: 'oauth.js', parallel: 1, sinceMs: NOW - 1000 } }),
      sub('s2', { parentRef: 'ag2', status: S.makeStatus('done', NOW - MIN), toolCalls: 4 })],
    workflows: [{ id: 'wf1', taskId: null, name: 'review-pr', scriptPath: null, state: 'running', phases: [], done: 5, total: 8, running: 3,
      tokens: 0, outTokens: 0, costUsd: null, ref: 'wf', phaseList: ['Build', 'Review', 'Sum up'],
      phaseStates: [{ title: 'Build', state: 'done', done: 2, started: 2 }, { title: 'Review', state: 'current', done: 3, started: 5 }, { title: 'Sum up', state: 'pending', done: 0, started: 0 }],
      agents: [] }],
  });
  const out = vmOf([prompt('x'), call('Agent', 'ag'), call('Agent', 'ag2'), ok('Agent', 'ag2'), call('Workflow', 'wf'), ok('Workflow', 'wf')], s);
  const blocks = out[1].items;
  // the subagent's step as the card's "now" line says it, with the blocks' category label ("Reading oauth.js", not "Read oauth.js")
  assert.strictEqual(blocks[0].nest.text, i18n.t('step.tool', { tool: i18n.t('webview.step.read'), detail: 'oauth.js' }));
  assert.strictEqual(blocks[0].nest.lamp, 'working');
  assert.strictEqual(blocks[1].nest.text, i18n.t('webview.progress.childDone', { n: 4 }));
  assert.strictEqual(blocks[2].nest.text, i18n.t('workflow.phaseOf', { index: 2, count: 3, title: 'Review' }) + SEP + i18n.t('workflow.started', { total: 8, done: 5 }));
  assert.strictEqual(vmOf([prompt('x'), ...pair('Read', 'zz')], s)[1].nest, null);
});

test('Copilot: calls that end with their turn count as done (no result is ever recorded); an interrupt still stops them; the panel\'s stepsVm is unchanged', () => {
  const cp = session({ provider: 'copilot' });
  const tl = [prompt('x'), call('Read', null), call('Grep', null), line('done')];
  const g = vmOf(tl, cp).find((x) => x.type === 'group');
  assert.deepStrictEqual([g.state, g.items.map((b) => b.state)], ['done', ['done', 'done']]);
  assert.strictEqual(g.title, i18n.t('webview.progress.ranN', { n: 2 }));
  const g2 = vmOf([prompt('x'), call('Read', null), call('Grep', null), line('interrupt'), line('done')], cp).find((x) => x.type === 'group');
  assert.strictEqual(g2.state, 'stopped');
  assert.deepStrictEqual(g2.items.map((b) => b.state), ['done', 'stopped'], 'the next call shows the first one returned');
  // the bottom panel keeps calling them stopped
  const panel = AV._internal.stepsVm(tl, i18n, { now: NOW }, true);
  assert.deepStrictEqual(panel.filter((x) => x.block).map((x) => x.state), ['stopped', 'stopped']);
  // A request that failed (no done, no interrupt) ends its last call as stopped; an earlier request never stays running
  const failed = [prompt('one'), call('run_in_terminal', null), call('read_file', null), line('apiError', 'boom'), prompt('two'), call('Read', null), line('done')];
  const earlier = vmOf(failed, cp).find((x) => x.type === 'turn');
  const eg = earlier.items.find((x) => x.type === 'group');
  assert.deepStrictEqual([eg.state, eg.current, eg.items.map((b) => b.state)], ['stopped', false, ['done', 'stopped']]);
  assert.ok(!eg.title.includes(i18n.t('webview.progress.nowStep', { step: '' }).trim()), eg.title);
  const cut = vmOf([prompt('one'), call('Read', null), call('Grep', null), prompt('two'), line('text')], cp).find((x) => x.type === 'turn');
  assert.deepStrictEqual(cut.items.find((x) => x.type === 'group').items.map((b) => b.state), ['done', 'stopped'], 'the next request ended it');
  const quota = vmOf([prompt('one'), call('Read', null), line('quota')], cp).filter((x) => x.type === 'block');
  assert.deepStrictEqual(quota.map((b) => [b.state, b.current]), [['stopped', false]]);
  // While a request runs, only its latest call is running and highlighted
  const live = vmOf([prompt('go'), call('Read', null), call('Grep', null), line('thinking'), call('Bash', null)], cp, {}, { running: true });
  const lg = live.find((x) => x.type === 'group');
  assert.deepStrictEqual(lg.items.map((b) => [b.state, b.current]), [['done', false], ['done', false], ['running', true]]);
  assert.strictEqual(lg.title, [i18n.t('webview.progress.ranN', { n: 3 }), i18n.t('webview.progress.nowStep', { step: lg.items[2].title })].join(SEP));
});

// ---------- Plan and phases ----------

test('planVm: done items fold, the item in progress shows its activeForm, at most 7 open items before "N more"', () => {
  const items = [{ text: 'A', active: null, status: 'completed' }, { text: 'B', active: 'Doing B', status: 'in_progress' }];
  for (let i = 0; i < 8; i++) items.push({ text: 'P' + i, active: null, status: 'pending' });
  const p = PV.planVm({ ms: NOW, source: 'todo', items }, i18n);
  assert.strictEqual(p.title, i18n.t('webview.progress.tasks'));
  assert.strictEqual(p.progressText, i18n.t('plan.progress', { done: 1, total: 10 }));
  assert.deepStrictEqual([p.value, p.max], [1, 10]);
  assert.strictEqual(p.doneText, i18n.t('webview.progress.doneFold', { n: 1 }));
  assert.deepStrictEqual(p.shown[0], { text: 'Doing B', status: 'in_progress' });
  assert.strictEqual(p.shown.length, 7);
  assert.strictEqual(p.moreText, i18n.t('webview.progress.more', { n: 2 }));
  assert.strictEqual(PV.planVm({ source: 'plan', items: [{ text: 'X', status: 'pending' }] }, i18n).title, i18n.t('webview.progress.plan'));
  assert.strictEqual(PV.planVm(null, i18n), null);
  assert.strictEqual(PV.planVm({ items: [] }, i18n), null);
  // the plan's own order: a pending item listed before the one in progress stays above it
  assert.deepStrictEqual(PV.planVm({ ms: NOW, source: 'todo', items: [{ text: 'Write tests', status: 'pending' }, { text: 'Fix parser', active: null, status: 'in_progress' }] }, i18n)
    .shown.map((x) => x.text), ['Write tests', 'Fix parser']);
  // a plan finished before the current turn is not shown; one finished in this turn, or still open, is
  const fin5 = { ms: NOW - 10 * MIN, source: 'plan', items: [1, 2, 3, 4, 5].map((i) => ({ text: 'S' + i, status: 'completed' })) };
  assert.strictEqual(PV.planVm(fin5, i18n, { sinceMs: NOW - 5 * MIN }), null);
  assert.ok(PV.planVm(fin5, i18n, { sinceMs: NOW - 20 * MIN }));
  assert.ok(PV.planVm({ ...fin5, items: [...fin5.items.slice(1), { text: 'S6', status: 'pending' }] }, i18n, { sinceMs: NOW - 5 * MIN }));
});

test('phaseVm: one segment per declared phase (the current one counts done / started); without phases only the line', () => {
  const w = { id: 'w', name: 'review-pr', state: 'running', phases: [], done: 3, total: 5, phaseList: ['A', 'B'],
    phaseStates: [{ title: 'A', state: 'done', done: 2, started: 2 }, { title: 'B', state: 'current', done: 1, started: 3 }], agents: [] };
  const v = PV.phaseVm(w, i18n);
  assert.deepStrictEqual(v.phases.map((p) => [p.title, p.state, p.count]), [['A', 'done', ''], ['B', 'current', '1/3']]);
  assert.strictEqual(v.lineText, i18n.t('workflow.phaseOf', { index: 2, count: 2, title: 'B' }) + SEP + i18n.t('workflow.started', { total: 5, done: 3 }));
  const bare = PV.phaseVm({ ...w, phaseList: [], phaseStates: [] }, i18n);
  assert.deepStrictEqual([bare.phases, bare.lineText], [[], i18n.t('workflow.started', { total: 5, done: 3 })]);
});

// ---------- Cards ----------

const L = (s) => lamp.sessionLamps(s, { seenAtMs: 0 });
const card = (s, o = {}) => PV.cardVm(s, L(s), i18n, { now: NOW, ...o });

test('card progress line: plan > workflow with phases > workflow without > subagents > this turn (while working); "started" wording', () => {
  const wf = { id: 'w', name: 'review-pr', state: 'running', phases: [], done: 5, total: 8, running: 3, phaseList: ['A', 'B', 'C'],
    phaseStates: [{ title: 'A', state: 'done', done: 2, started: 2 }, { title: 'B', state: 'current', done: 3, started: 6 }, { title: 'C', state: 'pending', done: 0, started: 0 }], agents: [] };
  const all = session({
    main: working({ todo: { done: 3, total: 7, active: 'Testing' }, turn: { sinceMs: NOW - 3 * MIN, tools: 12, errors: 0 } }),
    workflows: [wf], agents: [sub('a', { status: S.makeStatus('done', NOW - MIN) }), sub('b')],
  });
  const p1 = card(all).prog;
  assert.deepStrictEqual(p1, { kind: 'todo', text: i18n.t('webview.progress.tasksDone', { done: 3, total: 7 }), value: 3, max: 7 });
  // open, the plan and the phase bar below say it in full: no second "3/7" on the card itself
  assert.strictEqual(card(all, { shownKey: all.key }).prog, null);
  assert.strictEqual(card({ ...all, main: working({ turn: all.main.turn }) }, { shownKey: all.key }).prog, null, 'phases too');
  assert.strictEqual(card({ ...all, main: working({ turn: all.main.turn }), workflows: [] }, { shownKey: all.key }).prog.kind, 'subagents', 'nothing below says that');
  assert.strictEqual(card(session({ ...all, provider: 'codex', key: 'codex:x' })).prog.text, i18n.t('webview.progress.planDone', { done: 3, total: 7 }));
  const noTodo = { ...all, main: working({ turn: all.main.turn }) };
  const p2 = card(noTodo).prog;
  assert.strictEqual(p2.kind, 'phases');
  assert.strictEqual(p2.text, i18n.t('workflow.phaseOf', { index: 2, count: 3, title: 'B' }) + SEP + i18n.t('workflow.started', { total: 8, done: 5 }));
  assert.deepStrictEqual([p2.value, p2.max], [1, 3]);
  const p3 = card({ ...noTodo, workflows: [{ ...wf, phaseList: [], phaseStates: [] }] }).prog;
  assert.deepStrictEqual([p3.kind, p3.text, p3.value, p3.max], ['workflow', 'review-pr' + SEP + i18n.t('workflow.started', { total: 8, done: 5 }), 5, 8]);
  assert.ok(/started/.test(p3.text));
  const p4 = card({ ...noTodo, workflows: [] }).prog;
  assert.deepStrictEqual([p4.kind, p4.text], ['subagents', i18n.t('webview.progress.subagents', { done: 1, total: 2 })]);
  const p5 = card({ ...noTodo, workflows: [], agents: [] }).prog;
  assert.strictEqual(p5.kind, 'turn');
  assert.strictEqual(p5.value, null);
  assert.ok(p5.text.includes('12'));
  assert.strictEqual(card(session({ main: agent({ status: S.makeStatus('thinking', NOW - 1000) }) })).prog, null, 'no turn data, nothing to count');
  // A plan finished in an earlier turn gives way to the next source; finished in this turn it stays
  const turn2 = { sinceMs: NOW - 3 * MIN, tools: 14, errors: 0 };
  const old = card({ ...all, workflows: [], agents: [], main: working({ todo: { done: 5, total: 5, active: null, ms: NOW - 30 * MIN }, turn: turn2 }) }).prog;
  assert.deepStrictEqual([old.kind, old.value], ['turn', null]);
  const fresh = card({ ...all, workflows: [], agents: [], main: working({ todo: { done: 5, total: 5, active: null, ms: NOW - MIN }, turn: turn2 }) }).prog;
  assert.deepStrictEqual([fresh.kind, fresh.value, fresh.max], ['todo', 5, 5]);
  const open = card({ ...all, workflows: [], agents: [], main: working({ todo: { done: 2, total: 5, active: 'x', ms: NOW - 30 * MIN }, turn: turn2 }) }).prog;
  assert.strictEqual(open.kind, 'todo', 'an unfinished plan from an earlier turn still counts');
});

test('cards: a finished session that is not open is one compact line; the open one is full; nothing changes from one second to the next', () => {
  const fin = session({ main: done(), doneAtMs: NOW - 10 * MIN });
  const c = card(fin);
  assert.strictEqual(c.compact, true);
  assert.deepStrictEqual([c.now, c.prog, c.cost], [null, null, '']);
  assert.ok(c.ago.startsWith(c.lampText + SEP));
  const open = card(fin, { shownKey: fin.key });
  assert.deepStrictEqual([open.compact, open.expanded], [false, true]);
  const run = session({ main: working({ turn: { sinceMs: NOW - 20e3, tools: 2, errors: 0 } }) });
  const a = card(run);
  // the category label the step blocks use, not the tool's own name ("Bash npm test")
  assert.strictEqual(a.now.text, i18n.t('step.tool', { tool: i18n.t('webview.step.run'), detail: 'npm test' }));
  // a tool without a category keeps its own name
  assert.strictEqual(card(session({ main: working({ step: { kind: 'tool', tool: 'SomeTool', detail: 'x', parallel: 1, sinceMs: NOW - 2000 } }) })).now.text,
    i18n.t('step.tool', { tool: 'SomeTool', detail: 'x' }));
  assert.ok(a.now.spin);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(PV.cardVm(run, L(run), i18n, { now: NOW + 1000 })));
  // the menu context is the panel list's, for the same session menu
  assert.deepStrictEqual(JSON.parse(a.context).webviewSection, 'session');
  assert.strictEqual(JSON.parse(a.context).sessionKey, run.key);
});

test('buildProgress: cards in the order given, only the shown session expanded (loading until its details arrive), the empty text', () => {
  const s1 = session({ id: 'a1', title: 'A', main: working() });
  const s2 = session({ id: 'b2', title: 'B', main: done() });
  const arranged = { groups: [{ id: 'open', sessions: [s1] }, { id: 'recent', sessions: [s2] }] };
  let r = PV.buildProgress({ arranged, shownKey: s2.key, i18n, now: NOW });
  assert.deepStrictEqual(r.cards.items.map((c) => c.key), [s1.key, s2.key]);
  assert.deepStrictEqual([r.cards.shownKey, r.expanded.key, r.expanded.loading, r.expanded.stream], [s2.key, s2.key, true, []]);
  r = PV.buildProgress({ arranged, shownKey: s2.key, i18n, now: NOW, detail: { key: s1.key, agents: { main: { timeline: [] } } } });
  assert.strictEqual(r.expanded.loading, true, 'another session\'s details are not used');
  r = PV.buildProgress({ arranged, shownKey: s2.key, i18n, now: NOW, detail: { key: s2.key, agents: { main: { timeline: [prompt('Hi')], plan: null } } } });
  assert.deepStrictEqual([r.expanded.loading, r.expanded.stream.map((x) => x.type), r.expanded.canOpen], [false, ['quote'], true]);
  r = PV.buildProgress({ arranged, shownKey: 'claude:gone', i18n, now: NOW });
  assert.strictEqual(r.expanded.key, null);
  assert.strictEqual(PV.buildProgress({ arranged: null, loaded: false, i18n }).cards.emptyText, i18n.t('session.loading'));
  assert.strictEqual(PV.buildProgress({ arranged: { groups: [] }, i18n, emptyText: 'Nothing here' }).cards.emptyText, 'Nothing here');
});

// ---------- Provider ----------

function makeStub() {
  const log = { commands: [], posted: [] };
  const listeners = { msg: null, vis: null };
  const Uri = { joinPath: (u, ...parts) => ({ fsPath: path.join(u.fsPath, ...parts) }) };
  const vscode = {
    Uri,
    commands: { executeCommand: (...a) => { log.commands.push(a); return Promise.resolve(); } },
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
    onDidDispose: () => ({ dispose() {} }),
  };
  return { vscode, view, context: { extensionUri: { fsPath: ROOT } }, log, listeners };
}

test('provider: posts only after ready and while visible; the same data is not posted again; select only for listed keys', () => {
  const st = makeStub();
  const selected = [];
  const p = new PV.ProgressViewProvider(st.context, { vscode: st.vscode, i18n, onSelect: (k) => selected.push(k) });
  const s1 = session({ id: 'a1', main: working() });
  const input = { arranged: { groups: [{ id: 'open', sessions: [s1] }] }, shownKey: s1.key, session: s1, now: NOW };
  p.update(input);
  p.resolveWebviewView(st.view);
  assert.ok(st.view.webview.html.includes('progress.js'));
  assert.deepStrictEqual(st.log.posted, [], 'nothing before ready');
  st.listeners.msg({ type: 'ready', closed: [] });
  assert.deepStrictEqual(st.log.posted.map((m) => m.type), ['cards', 'expanded']);
  p.update({ ...input });
  p.update({ ...input, now: NOW + 1000 });
  assert.strictEqual(st.log.posted.length, 2, 'unchanged: not posted again');
  st.view.visible = false;
  st.listeners.vis();
  p.update({ ...input, arranged: { groups: [] } });
  assert.strictEqual(st.log.posted.length, 2, 'hidden: nothing posted');
  st.view.visible = true;
  st.listeners.vis();
  st.listeners.msg({ type: 'ready', closed: [s1.key] });
  p.update(input);
  assert.strictEqual(p.lookingAt(s1.key), false, 'folded on the page');
  st.listeners.msg({ type: 'select', sessionKey: 'claude:nope' });
  st.listeners.msg({ type: 'select', sessionKey: s1.key });
  assert.deepStrictEqual(selected, [s1.key]);
  assert.strictEqual(p.lookingAt(s1.key), true, 'selecting unfolds it');
  st.listeners.msg({ type: 'toggle', sessionKey: s1.key, open: false });
  assert.strictEqual(p.lookingAt(s1.key), false);
  st.listeners.msg({ type: 'show' });
  st.listeners.msg({ type: 'openTranscript', sessionKey: 'claude:nope' });
  st.listeners.msg({ type: 'openTranscript', sessionKey: s1.key });
  assert.deepStrictEqual(st.log.commands, [['agentMonitor.show'], ['agentMonitor.openTranscript', s1.key]]);
});

test('provider: step reads a call only when it is listed in the shown session\'s details and the transcript is a real file path', async () => {
  const file = path.join(TMP, 'main.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'all good' }] } }),
  ].join('\n') + '\n');
  const st = makeStub();
  const p = new PV.ProgressViewProvider(st.context, { vscode: st.vscode, i18n });
  const s1 = session({ id: 'a1', main: agent({ file }) });
  const detail = { key: s1.key, agents: { main: { timeline: [call('Bash', 'tu1', 'npm test'), ok('Bash', 'tu1')] } } };
  p.resolveWebviewView(st.view);
  st.listeners.msg({ type: 'ready', closed: [] });
  p.update({ arranged: { groups: [{ id: 'open', sessions: [s1] }] }, shownKey: s1.key, session: s1, detail, now: NOW });
  const n = st.log.posted.length;
  st.listeners.msg({ type: 'step', sessionKey: s1.key, rowId: 'main', ref: 'tu9' });
  st.listeners.msg({ type: 'step', sessionKey: 'claude:other', rowId: 'main', ref: 'tu1' });
  st.listeners.msg({ type: 'step', sessionKey: s1.key, rowId: 'main', ref: 'tu1' });
  await new Promise((r) => setTimeout(r, 50));
  const replies = st.log.posted.slice(n).filter((m) => m.type === 'step');
  assert.strictEqual(replies.length, 1);
  assert.strictEqual(replies[0].ref, 'tu1');
  assert.strictEqual(replies[0].found, true);
  assert.ok(/npm test/.test(replies[0].input) && /all good/.test(replies[0].output));
  // a relative path is never read
  const rel = session({ id: 'a1', main: agent({ file: 'main.jsonl' }) });
  p.update({ arranged: { groups: [{ id: 'open', sessions: [rel] }] }, shownKey: rel.key, session: rel, detail, now: NOW });
  const m = st.log.posted.length;
  st.listeners.msg({ type: 'step', sessionKey: rel.key, rowId: 'main', ref: 'tu1' });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(st.log.posted.slice(m).filter((x) => x.type === 'step').length, 0);
});

// ---------- Page ----------

test('progressHtml: CSP allows only cspSource and the nonce; sheets and scripts in order; no inline style or handlers', () => {
  const html = progressHtml({ cspSource: 'c:', asset: (p) => 'a/' + p, nonce: 'N', i18n });
  assert.ok(html.includes(`content="default-src &#39;none&#39;; style-src c:; font-src c:; script-src &#39;nonce-N&#39;"`));
  assert.deepStrictEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]), ['a/codicons/codicon.css', 'a/steps.css', 'a/progress.css']);
  assert.deepStrictEqual([...html.matchAll(/<script nonce="N" src="([^"]+)"><\/script>/g)].map((m) => m[1]), ['a/session-list.js', 'a/steps.js', 'a/progress.js']);
  assert.strictEqual([...html.matchAll(/<script/g)].length, 4, 'three page scripts plus the dictionary block');
  assert.ok(!/\sstyle=|\son\w+=/.test(html));
  assert.ok(html.includes(`<title>${i18n.t('webview.progress.title')}</title>`));
  assert.ok(html.includes('id="cards"') && html.includes('role="list"'));
});

test('media/progress.js and progress.css: DOM from text only, no network; strings in the English dictionary; container queries, no opacity, reduced motion', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'progress.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\('style'|fetch\(/.test(js), 'DOM built from text only');
  assert.ok(/window\.AgentMonitorSteps\.createSteps\(/.test(js) && /LS\.syncKeyed|syncKeyed = LS\.syncKeyed/.test(js));
  const dict = i18n.dict(WEBVIEW_DICT_PREFIXES);
  const keys = [...new Set([...js.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]))].filter((k) => !k.endsWith('.')); // a prefix + state
  assert.ok(keys.length >= 5, keys.join());
  for (const k of keys) {
    assert.ok(WEBVIEW_DICT_PREFIXES.some((p) => k.startsWith(p)), 'not under an injected prefix: ' + k);
    assert.ok(k in dict, 'missing from the dictionary: ' + k);
  }
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'webview.en.json'), 'utf8'));
  for (const f of ['lib/progress-view.js', 'lib/webview-html.js', 'media/progress.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/'(webview\.[\w.]+)'/g)) {
      if (m[1].endsWith('.')) continue;
      assert.ok(m[1] in en, f + ' uses a missing string ' + m[1]);
    }
  }
  for (const st of ['done', 'current', 'pending']) assert.ok(('webview.progress.phase.' + st) in en);
  const css = fs.readFileSync(path.join(ROOT, 'media', 'progress.css'), 'utf8');
  // a block's category label ("运行命令") is not squeezed away: it keeps its width up to half the row, the detail is cut instead
  assert.match(css, /\.c-stream \.st-title \{ flex: 0 0 auto; max-width: 50%;/);
  assert.ok(!/opacity\s*:/.test(css), 'no opacity dimming');
  assert.ok(!/@media[^{]*width/.test(css), 'no viewport-width rules');
  assert.ok(/container-type: inline-size;/.test(css) && /@container progress \(max-width: 280px\)/.test(css));
  assert.ok(/@media \(prefers-reduced-motion: reduce\) \{[^}]*animation: none !important;/.test(css));
  assert.ok(/::-webkit-progress-value \{ background: var\(--vscode-progressBar-background\)/.test(css));
  // colors only from theme variables (fallbacks inside var() are the lamp defaults the panel uses too)
  const outside = css.replace(/var\([^;]*\)/g, '').match(/#[0-9a-fA-F]{3,6}\b/g);
  assert.strictEqual(outside, null, 'a color outside var(): ' + outside);
});

// A small DOM for running media/progress.js: elements with attributes, classes, children, ids, closest() and events
function fakeDom() {
  const listeners = { doc: {}, win: {} };
  class Node {
    constructor(tag, text) {
      this.tagName = tag; this.kids = []; this.parentNode = null; this.attrs = new Map(); this.hidden = false; this._text = text || '';
      this.style = {}; this.className = ''; this.ev = {};
      const el = this;
      const list = () => el.className.split(/\s+/).filter(Boolean);
      this.classList = {
        contains: (c) => list().includes(c),
        add: (c) => { if (!list().includes(c)) el.className = [...list(), c].join(' '); },
        remove: (c) => { el.className = list().filter((x) => x !== c).join(' '); },
        toggle: (c, on) => { if (on === undefined) on = !list().includes(c); if (on) el.classList.add(c); else el.classList.remove(c); return on; },
      };
    }
    get id() { return this.attrs.get('id') || ''; }
    get children() { return this.kids.filter((k) => k.tagName !== '#text'); }
    get firstChild() { return this.kids[0] || null; }
    get nextSibling() { const p = this.parentNode; return p ? p.kids[p.kids.indexOf(this) + 1] || null : null; }
    get textContent() { return this.tagName === '#text' ? this._text : this.kids.map((k) => k.textContent).join(''); }
    set textContent(v) { for (const k of this.kids) k.parentNode = null; this.kids = v ? [new Node('#text', String(v))] : []; }
    setAttribute(k, v) { if (k === 'class') this.className = String(v); else if (k === 'hidden') this.hidden = true; else this.attrs.set(k, String(v)); }
    getAttribute(k) { return k === 'class' ? this.className : this.attrs.has(k) ? this.attrs.get(k) : null; }
    hasAttribute(k) { return k === 'hidden' ? this.hidden : this.attrs.has(k); }
    removeAttribute(k) { if (k === 'hidden') this.hidden = false; else this.attrs.delete(k); }
    appendChild(c) { return this.insertBefore(c, null); }
    insertBefore(c, ref) {
      if (c.parentNode) c.remove();
      const i = ref ? this.kids.indexOf(ref) : -1;
      if (i < 0) this.kids.push(c); else this.kids.splice(i, 0, c);
      c.parentNode = this;
      return c;
    }
    remove() { if (this.parentNode) this.parentNode.kids.splice(this.parentNode.kids.indexOf(this), 1); this.parentNode = null; }
    addEventListener(type, fn) { (this.ev[type] = this.ev[type] || []).push(fn); }
    matches(sel) {
      const m = /^\[([\w-]+)\]$/.exec(sel);
      if (m) return this.attrs.has(m[1]);
      return sel.split('.').filter(Boolean).every((c) => this.classList.contains(c));
    }
    closest(sel) { for (let n = this; n && n.tagName !== '#doc'; n = n.parentNode) if (n.matches && n.matches(sel)) return n; return null; }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { for (const k of n.children) { if (k.matches(sel)) out.push(k); walk(k); } };
      walk(this);
      return out;
    }
    focus() { dom.focused = this; }
  }
  const body = new Node('body');
  const docNode = new Node('#doc');
  docNode.appendChild(body);
  const dom = {
    Node, body, focused: null, listeners,
    find: (pred) => { let hit = null; const walk = (n) => { for (const k of n.children) { if (!hit && pred(k)) hit = k; walk(k); } }; walk(body); return hit; },
    all: (pred) => { const out = []; const walk = (n) => { for (const k of n.children) { if (pred(k)) out.push(k); walk(k); } }; walk(body); return out; },
    click: (el) => { for (const fn of listeners.doc.click || []) fn({ target: el }); },
  };
  dom.document = {
    createElement: (tag) => new Node(tag),
    createTextNode: (s) => new Node('#text', s),
    getElementById: (id) => dom.find((n) => n.id === id),
    addEventListener: (type, fn) => { (listeners.doc[type] = listeners.doc[type] || []).push(fn); },
    scrollingElement: { scrollTop: 0 },
  };
  Object.defineProperty(dom.document, 'activeElement', { get: () => dom.focused });
  return dom;
}

function runPage(savedState) {
  const dom = fakeDom();
  const { h } = { h: (tag, attrs, kids) => {
    const el = dom.document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    for (const c of kids || []) el.appendChild(typeof c === 'string' ? dom.document.createTextNode(c) : c);
    return el;
  } };
  // the page as progressHtml writes it
  const dictJson = i18n.webviewJson(WEBVIEW_DICT_PREFIXES);
  dom.body.appendChild(h('script', { id: 'l10n' }, [dictJson]));
  dom.body.appendChild(h('main', { id: 'app' }, [h('p', { id: 'empty' }), h('div', { id: 'cards', role: 'list' })]));
  const posted = [];
  const page = { state: savedState, posted, dom };
  const win = {
    addEventListener: (type, fn) => { (dom.listeners.win[type] = dom.listeners.win[type] || []).push(fn); },
  };
  const ctx = {
    window: win, document: dom.document, setTimeout, clearTimeout, console,
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => page.state, setState: (s) => { page.state = JSON.parse(JSON.stringify(s)); } }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['session-list.js', 'steps.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'media', f), 'utf8'), ctx, { filename: f });
  win.AgentMonitorList = ctx.AgentMonitorList;
  win.AgentMonitorSteps = ctx.AgentMonitorSteps;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'media', 'progress.js'), 'utf8'), ctx, { filename: 'progress.js' });
  page.send = (m) => { for (const fn of dom.listeners.win.message || []) fn({ data: JSON.parse(JSON.stringify(m)) }); };
  page.cards = () => dom.find((n) => n.id === 'cards').children;
  page.key = (key) => page.cards().find((c) => c._key === key);
  return page;
}

test('media/progress.js on a fake DOM: cards render in order, the shown card opens with its stream; clicks post only keys; folds and groups are remembered', () => {
  const s1 = session({ id: 'a1', title: 'Alpha', main: working({ turn: { sinceMs: NOW - MIN, tools: 3, errors: 0 } }) });
  const s2 = session({ id: 'b2', title: 'Beta', main: done(), doneAtMs: NOW - 5 * MIN });
  const arranged = { groups: [{ id: 'open', sessions: [s1] }, { id: 'recent', sessions: [s2] }] };
  const timeline = [prompt('Fix it'), ...pair('Read', 'a'), ...pair('Grep', 'b'), call('Agent', 'ag'), ok('Agent', 'ag'), line('text', 'Now the tests'), ...pair('Edit', 'c'), call('Bash', 'd', 'npm test')];
  const withSub = { ...s1, agents: [sub('s1', { parentRef: 'ag', status: S.makeStatus('done', NOW - MIN), toolCalls: 2 })] };
  const arr2 = { groups: [{ id: 'open', sessions: [withSub] }, { id: 'recent', sessions: [s2] }] };
  const detail = { key: s1.key, agents: { main: { timeline, plan: { ms: NOW, source: 'todo', items: [{ text: 'A', active: null, status: 'completed' }, { text: 'B', active: 'Doing B', status: 'in_progress' }] } } } };
  const r = PV.buildProgress({ arranged: arr2, shownKey: s1.key, detail, i18n, now: NOW });
  const page = runPage(undefined);
  assert.deepStrictEqual(page.posted, [{ type: 'ready', closed: [] }]);
  page.send(r.cards);
  assert.deepStrictEqual(page.cards().map((c) => c._key), [s1.key, s2.key]);
  const [c1, c2] = page.cards();
  assert.ok(c1.classList.contains('open') && !c2.classList.contains('open'));
  assert.ok(c2.classList.contains('compact'));
  assert.strictEqual(c1.getAttribute('data-vscode-context'), r.cards.items[0].context);
  const body = c1._c.body;
  assert.ok(body, 'the shown card opens');
  assert.strictEqual(body._b.loading.hidden, false, 'loading until its part arrives');
  page.send(r.expanded);
  assert.strictEqual(body._b.loading.hidden, true);
  const stream = body._b.stream.children;
  assert.deepStrictEqual(stream.map((li) => li._key.split('|')[0]), ['quote', 'group', 'line', 'group']);
  const [, g1, , g2] = stream;
  // the finished group starts closed, the running one open with its blocks; the Agent block shows its subagent
  assert.strictEqual(g1._f.items.hidden, true);
  assert.strictEqual(g2._f.items.hidden, false);
  assert.ok(g2.classList.contains('current'));
  assert.strictEqual(g2._f.items.children.length, 2);
  // the plan shows the item in progress by its activeForm
  assert.strictEqual(body._b.plan.shown.children[0].children[1].textContent, 'Doing B');
  // open the first group: the Agent block inside carries the nested line
  page.dom.click(g1._f.head);
  assert.strictEqual(g1._f.items.hidden, false);
  const agentLi = g1._f.items.children[2];
  assert.ok(agentLi._nest && agentLi._nest.hidden === false);
  assert.strictEqual(agentLi._nest.children[1].textContent, i18n.t('webview.progress.childDone', { n: 2 }));
  assert.strictEqual(page.state.open[s1.key + '\ng:r:a'], true, 'remembered');
  // a step block posts only the session key, row id and call id
  page.dom.click(agentLi._s.head);
  assert.deepStrictEqual(page.posted.at(-1), { type: 'step', sessionKey: s1.key, rowId: 'main', ref: 'ag' });
  // another card selects that session; the shown card folds and unfolds on the page only
  page.dom.click(c2._c.head);
  assert.deepStrictEqual(page.posted.at(-1), { type: 'select', sessionKey: s2.key });
  page.dom.click(c1._c.head);
  assert.deepStrictEqual(page.posted.at(-1), { type: 'toggle', sessionKey: s1.key, open: false });
  assert.strictEqual(c1._c.body, null);
  assert.deepStrictEqual(page.state.closed, [s1.key]);
  page.dom.click(c1._c.head);
  assert.deepStrictEqual(page.posted.at(-1), { type: 'toggle', sessionKey: s1.key, open: true });
  // footer buttons
  const foot = c1._c.body.children.find((n) => n.classList.contains('c-foot'));
  page.dom.click(foot.children[0]);
  page.dom.click(foot.children[1]);
  assert.deepStrictEqual(page.posted.slice(-2), [{ type: 'show' }, { type: 'openTranscript', sessionKey: s1.key }]);
  // the same data again keeps every element
  const before = page.cards()[0]._c.body._b.stream.children.slice();
  page.send(r.cards);
  page.send(r.expanded);
  assert.deepStrictEqual(page.cards()[0]._c.body._b.stream.children, before);
  // a page rebuilt with the saved state sends the folded cards with ready
  const again = runPage({ closed: ['claude:zz'], open: {}, scroll: 0 });
  assert.deepStrictEqual(again.posted, [{ type: 'ready', closed: ['claude:zz'] }]);
  // keyboard: ↓ / End move between card heads
  const keydown = page.dom.find((n) => n.id === 'cards').ev.keydown[0];
  let prevented = false;
  keydown({ target: c1._c.head, key: 'ArrowDown', preventDefault: () => { prevented = true; } });
  assert.ok(prevented && page.dom.focused === c2._c.head);
});

test('media/progress.js: a lone block that the next call turns into a group keeps its element, stays open and keeps focus', () => {
  const s1 = session({ id: 'a1', title: 'Alpha', main: working({ turn: { sinceMs: NOW - MIN, tools: 1, errors: 0 } }) });
  const arranged = { groups: [{ id: 'open', sessions: [s1] }] };
  const p0 = prompt('Run it');
  const bash = call('Bash', 'x', 'npm test');
  const send = (page, timeline) => {
    const r = PV.buildProgress({ arranged, shownKey: s1.key, detail: { key: s1.key, agents: { main: { timeline } } }, i18n, now: NOW });
    page.send(r.cards);
    page.send(r.expanded);
    return page.cards()[0]._c.body._b.stream;
  };
  const page = runPage(undefined);
  let stream = send(page, [p0, bash]);
  assert.deepStrictEqual(stream.children.map((li) => li._key), ['quote|q:' + p0.ms, 'block|r:x']);
  const blockLi = stream.children[1];
  page.dom.click(blockLi._s.head);
  assert.strictEqual(blockLi._s.open, true);
  blockLi._s.head.focus();
  // the next call: the block is now the first item of a group
  const read = call('Read', 'y');
  stream = send(page, [p0, bash, read]);
  const g = stream.children[1];
  assert.strictEqual(g._key, 'group|g:r:x');
  assert.strictEqual(g._f.items.hidden, false, 'the group opens to show it');
  assert.strictEqual(g._f.items.children[0], blockLi, 'the same element, now inside the group');
  assert.strictEqual(blockLi._key, 'r:x');
  assert.strictEqual(blockLi._s.open, true);
  assert.strictEqual(blockLi._s.body.hidden, false);
  assert.strictEqual(page.dom.focused, blockLi._s.head, 'focus stays on its head');
  // a closed, unfocused lone block is simply replaced (nothing to keep)
  const page2 = runPage(undefined);
  let st2 = send(page2, [p0, bash]);
  const li2 = st2.children[1];
  page2.dom.focused = null;
  st2 = send(page2, [p0, bash, read]);
  assert.notStrictEqual(st2.children[1]._f.items.children[0], li2);
});

test('progress.css: the selected card\'s head still shows the keyboard focus ring (a rule at least as specific as its outline)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'media', 'progress.css'), 'utf8');
  const sel = css.indexOf('.card.selected > .c-head {');
  const focus = css.indexOf('.card.selected > .c-head:focus-visible { outline: 1px solid var(--vscode-focusBorder); }');
  assert.ok(sel >= 0 && focus > sel, 'the focus rule comes after the selected rule');
  const js = fs.readFileSync(path.join(ROOT, 'media', 'progress.js'), 'utf8');
  assert.ok(js.includes("t('webview.openTranscript')") && !js.includes('progress.openLog'), 'the footer link reads like the command it runs');
});

Promise.all(pending).then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
});
