'use strict';
// Tests for the presentation core: lib/lamp.js, lib/seen.js, lib/scope.js, lib/order.js, lib/format.js, l10n/views.en.json.
// Run with plain node: node test/present.test.js. All data is synthetic; nothing is read from ~/.claude or ~/.codex and no files are written.

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

// ---------- Helpers ----------

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

// Sessions shaped like the Copilot / Gemini CLI / Qwen Code providers produce them (lib/providers/{copilot,gemini,qwen}.js):
// no auto-compact point, no prompt cache, no resume hints; Copilot bills in credits (costUsd always null),
// Gemini CLI guesses running / done from write timing (certainty 'guess', liveCertainty 'guess'), Qwen's OAuth model is unpriced.
const noCompact = (used, window, o = {}) => ({ display: used, contextUsed: used, contextWindow: window, compactAt: null, toCompact: null,
  contextPct: window ? Math.round((used / window) * 100) : null, output: 900, processed: 50000, apiCalls: 4, ...o });
function copilotSession(o = {}) {
  const credits = 'credits' in o ? o.credits : 1.5;
  return session({
    provider: 'copilot', id: o.id || 'cop-1', entry: 'vscode', entryRaw: 'panel', entrypoint: null, model: 'copilot/claude-sonnet-4.5',
    live: true, liveStatus: 'waiting', contextWindow: 128000, contextWindowSource: 'copilot-model', compactAt: null, compactAtSource: null,
    cacheExpiresMs: null, costUsd: null, unpricedModel: null, ccCostUsd: null,
    main: agent({ model: 'copilot/claude-sonnet-4.5', status: st('awaitingInput', NOW - 30000, { question: 'askUser' }),
      step: { kind: 'tool', tool: 'questionCarousel', detail: null, parallel: 0, sinceMs: NOW - 30000 },
      tokens: noCompact(41000, 128000), costUsd: null, costEstimated: false, copilotCredits: credits, cacheTtl: null }),
    agents: [agent({ id: 'sa1', kind: 'copilotSubagent', name: 'Explorer', agentType: 'Explore', description: 'Survey the repo for auth call sites',
      model: 'claude-haiku-4.5', status: st('thinking', NOW - 5000), tokens: noCompact(0, null), costUsd: null, cacheTtl: null })],
    copilot: { credits, multiplier: 1, cachedTokens: 0, requests: 2, queued: 0, modelState: 4, mode: 'agent', permissionLevel: 'default', storage: 'workspace', workspaceFile: null },
    ...o.extra,
  });
}
function geminiSession(o = {}) {
  return session({
    provider: 'gemini', id: o.id || 'gem-1', entry: 'cli', entryRaw: null, entrypoint: null, model: 'gemini-2.5-pro',
    live: false, liveStatus: null, liveCertainty: 'guess', contextWindow: 1048576, contextWindowSource: 'model-rule',
    compactAt: null, compactAtSource: null, cacheExpiresMs: null, costUsd: 0.051625, unpricedModel: null, ccCostUsd: null,
    doneAtMs: NOW - 120000,
    main: agent({ model: 'gemini-2.5-pro', status: st('done', NOW - 120000, { certainty: 'guess' }), step: null,
      tokens: noCompact(52000, 1048576, { input: 52000, cached: 30000, thoughts: 1200, tool: 300 }),
      costUsd: 0.051625, costEstimated: true, cacheTtl: null }),
    agents: [agent({ id: 'g-sub', kind: 'geminiSubagent', name: 'investigator', agentType: 'codebase_investigator', status: st('done', NOW - 130000),
      tokens: noCompact(9000, 1048576, { input: 9000, cached: 0, thoughts: 0, tool: 0 }), costUsd: 0.01, cacheTtl: null })],
    ...o.extra,
  });
}
function qwenSession(o = {}) {
  return session({
    provider: 'qwen', id: o.id || 'qw-1', entry: 'cli', entryRaw: null, entrypoint: null, model: 'coder-model',
    live: false, liveStatus: null, contextWindow: 1000000, contextWindowSource: 'qwen-record', compactAt: null, compactAtSource: null,
    cacheExpiresMs: null, costUsd: null, unpricedModel: 'coder-model', ccCostUsd: null, doneAtMs: NOW - 80000,
    main: agent({ model: 'coder-model', status: st('done', NOW - 80000), tokens: noCompact(30000, 1000000), costUsd: null,
      unpricedModel: 'coder-model', cacheTtl: null }),
    agents: [agent({ id: 'q-sub', kind: 'qwenSubagent', name: null, agentType: 'reviewer', status: st('maybeAwaitingApproval', NOW - 70000, { pendingTool: 'run_shell_command' }),
      tokens: noCompact(2000, 1000000), costUsd: 0.001, costEstimated: true, cacheTtl: null })],
    ...o.extra,
  });
}

// ---------- Lamps ----------

function lampTests() {
  test('status code → agent lamp (including both definite and guessed waiting)', () => {
    const want = {
      starting: 'working', thinking: 'working', tool: 'working', retrying: 'working', idleBackground: 'working',
      awaitingApproval: 'needsYou', awaitingInput: 'needsYou', dialogOpen: 'needsYou', maybeAwaitingApproval: 'needsYou',
      done: 'doneUnseen', interrupted: 'idle', killed: 'idle', stale: 'idle', quota: 'error', apiError: 'error',
    };
    for (const code of S.STATUS_CODES) {
      assert.strictEqual(lamp.agentLamp({ status: st(code, NOW) }), want[code], code);
    }
    assert.strictEqual(lamp.agentLamp({ status: null }), 'idle');
    // stale with an unfinished tool: Idle by default; NeedsYou only with explicit staleAsNeedsYou
    const stale = { status: st('stale', NOW, { stalePending: true, pendingTool: 'Bash' }) };
    assert.strictEqual(lamp.agentLamp(stale), 'idle');
    assert.strictEqual(lamp.agentLamp(stale, { staleAsNeedsYou: true }), 'needsYou');
    assert.strictEqual(st('maybeAwaitingApproval', NOW).certainty, 'guess');
    assert.strictEqual(st('awaitingApproval', NOW).certainty, 'certain');
  });

  test('seen: done and sinceMs ≤ seenAtMs → DoneSeen; the main agent uses doneAtMs', () => {
    const a = { status: st('done', NOW - 10000) };
    assert.strictEqual(lamp.agentLamp(a, { seenAtMs: 0 }), 'doneUnseen');
    assert.strictEqual(lamp.agentLamp(a, { seenAtMs: NOW - 20000 }), 'doneUnseen');
    assert.strictEqual(lamp.agentLamp(a, { seenAtMs: NOW - 10000 }), 'doneSeen');
    // Main agent: status.sinceMs is early, but doneAtMs is later than seen → unseen
    assert.strictEqual(lamp.agentLamp(a, { seenAtMs: NOW - 5000, isMain: true, doneAtMs: NOW - 1000 }), 'doneUnseen');
    assert.strictEqual(lamp.agentLamp(a, { seenAtMs: NOW, isMain: true, doneAtMs: NOW - 1000 }), 'doneSeen');
  });

  test('session lamp by derivation priority, overall lamp by display urgency', () => {
    const mk = (codes) => session({
      main: agent({ status: st(codes[0], NOW - 1000) }),
      agents: codes.slice(1).map((c, i) => agent({ id: 'sub' + i, kind: 'subagent', name: 'Sub ' + i, status: st(c, NOW - 1000) })),
    });
    assert.strictEqual(lamp.sessionLamps(mk(['thinking', 'maybeAwaitingApproval', 'apiError'])).lamp, 'needsYou');
    assert.strictEqual(lamp.sessionLamps(mk(['thinking', 'apiError'])).lamp, 'error');
    assert.strictEqual(lamp.sessionLamps(mk(['done', 'tool'])).lamp, 'working');
    assert.strictEqual(lamp.sessionLamps(mk(['interrupted', 'done'])).lamp, 'doneUnseen');
    assert.strictEqual(lamp.sessionLamps(mk(['interrupted', 'killed'])).lamp, 'idle');
    // Overall lamp: DoneUnseen ranks ahead of Working
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

  test('exception 1: a subagent error from before it was seen does not bubble up; main agent errors always bubble up', () => {
    const s = session({
      doneAtMs: NOW - 3000,
      main: agent({ status: st('done', NOW - 3000) }),
      agents: [agent({ id: 'x', kind: 'subagent', name: 'Worker', status: st('apiError', NOW - 60000) })],
    });
    assert.strictEqual(lamp.sessionLamps(s, { seenAtMs: 0 }).lamp, 'error', 'not seen yet: bubbles up');
    const seenL = lamp.sessionLamps(s, { seenAtMs: NOW - 30000 });
    assert.strictEqual(seenL.lamp, 'doneUnseen', 'after being seen: the error no longer bubbles up; the main agent\'s new result is still unseen');
    assert.strictEqual(seenL.rows.get('a/x').lamp, 'error', 'the row itself is still red');
    const mainErr = session({ main: agent({ status: st('quota', NOW - 60000) }) });
    assert.strictEqual(lamp.sessionLamps(mainErr, { seenAtMs: NOW }).lamp, 'error');
  });

  test('exception 2: when only finished agents remain, use the main agent\'s doneAtMs', () => {
    const s = session({
      doneAtMs: NOW - 10000,
      main: agent({ status: st('done', NOW - 10000) }),
      agents: [agent({ id: 'late', kind: 'subagent', name: 'Late', status: st('done', NOW - 1000) })],
    });
    assert.strictEqual(lamp.sessionLamps(s, { seenAtMs: NOW - 5000 }).lamp, 'doneSeen');
    assert.strictEqual(lamp.sessionLamps(s, { seenAtMs: NOW - 5000 }).rows.get('a/late').lamp, 'doneUnseen');
    assert.strictEqual(lamp.sessionLamps(s, { seenAtMs: NOW - 20000 }).lamp, 'doneUnseen');
  });

  test('registry: waiting → NeedsYou (definite), busy → Working, guesses step aside', () => {
    const base = { main: agent({ status: st('stale', NOW - 10 * MIN, { stalePending: true, pendingTool: 'Bash' }) }), live: true };
    for (const [wf, code] of [['permission prompt', 'awaitingApproval'], ['input needed', 'awaitingInput'], ['dialog open', 'dialogOpen']]) {
      const L = lamp.sessionLamps(session({ ...base, liveStatus: 'waiting', waitingFor: wf }));
      assert.strictEqual(L.lamp, 'needsYou', wf);
      assert.strictEqual(L.main.status.code, code, wf);
      assert.strictEqual(L.main.status.certainty, 'certain');
      assert.strictEqual(L.registry, 'waiting');
    }
    // busy: previously stale (gray) → Working, status rewritten as tool
    const busy = lamp.sessionLamps(session({ ...base, liveStatus: 'busy' }));
    assert.strictEqual(busy.lamp, 'working');
    assert.strictEqual(busy.main.status.code, 'tool');
    assert.strictEqual(busy.main.status.pendingTool, 'Bash');
    // busy overrides a guess
    const guess = { main: agent({ status: st('maybeAwaitingApproval', NOW - 90000, { pendingTool: 'Edit' }) }), live: true };
    assert.strictEqual(lamp.sessionLamps(session(guess)).lamp, 'needsYou', 'without the registry the guess applies');
    assert.strictEqual(lamp.sessionLamps(session({ ...guess, liveStatus: 'busy' })).lamp, 'working');
    assert.strictEqual(lamp.sessionLamps(session({ ...guess, liveStatus: 'idle' })).lamp, 'idle');
    // busy keeps a red lamp (e.g. usage limit hit, waiting to auto-continue)
    assert.strictEqual(lamp.sessionLamps(session({ live: true, liveStatus: 'busy', main: agent({ status: st('quota', NOW) }) })).lamp, 'error');
    // With a registry signal, subagent guesses do not count either
    const sub = session({
      live: true, liveStatus: 'busy', main: agent({ status: st('idleBackground', NOW) }),
      agents: [agent({ id: 's', kind: 'subagent', name: 'S', status: st('maybeAwaitingApproval', NOW - 90000, { pendingTool: 'Read' }) })],
    });
    const subL = lamp.sessionLamps(sub);
    assert.strictEqual(subL.lamp, 'working');
    assert.strictEqual(subL.rows.get('a/s').status.code, 'tool');
    // Process exited (live false): registry ignored; the registry only applies to Claude
    assert.strictEqual(lamp.sessionLamps(session({ ...guess, live: false, liveStatus: 'busy' })).lamp, 'needsYou');
    assert.strictEqual(lamp.sessionLamps(session({ ...guess, provider: 'codex', id: 'th', liveStatus: 'busy' })).lamp, 'needsYou');
    // The provider already set a definite state of the same kind: keep it (with its question)
    const ask = session({ live: true, liveStatus: 'waiting', waitingFor: 'input needed', main: agent({ status: st('awaitingInput', NOW - 7000, { question: 'planApproval' }) }) });
    const askL = lamp.sessionLamps(ask);
    assert.strictEqual(askL.main.status.question, 'planApproval');
    assert.strictEqual(askL.main.status.sinceMs, NOW - 7000);
  });

  test('lead: the one-line summary on the left comes from the row that decides the session lamp, main agent first', () => {
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

  test('Copilot / Gemini CLI / Qwen Code feed the same lamps; a guessed done is exactly as loud as a certain one, never louder', () => {
    const guessDone = st('done', NOW - 1000, { certainty: 'guess' });
    assert.strictEqual(lamp.agentLamp({ status: guessDone }), lamp.agentLamp({ status: st('done', NOW - 1000) }));
    assert.strictEqual(lamp.agentLamp({ status: guessDone }, { seenAtMs: NOW }), 'doneSeen', 'seen after it finished → DoneSeen, like any done');
    assert.strictEqual(lamp.agentLamp({ status: st('thinking', NOW, { certainty: 'guess' }) }), 'working');
    // Same data, once as a Gemini guess and once as a certain Codex done: identical lamps and attention counts
    const gem = geminiSession({ id: 'g' });
    const cx = session({ provider: 'codex', id: 'c', doneAtMs: gem.doneAtMs, main: agent({ status: st('done', gem.main.status.sinceMs) }), agents: [] });
    const both = lamp.computeLamps([gem, session({ ...gem, key: 'gemini:h', id: 'h', agents: [] }), cx]);
    assert.deepStrictEqual([...both.bySession.values()].map((l) => l.lamp), ['doneUnseen', 'doneUnseen', 'doneUnseen']);
    assert.strictEqual(both.counts.doneUnseen, 3);
    assert.strictEqual(both.attention, 3);
    // Providers without a registry: liveStatus is derived from the status itself and never overrides it
    const cop = copilotSession();
    const L = lamp.sessionLamps(cop, { seenAtMs: 0 });
    assert.strictEqual(L.registry, null);
    assert.strictEqual(L.lamp, 'needsYou');
    assert.strictEqual(L.main.status, cop.main.status);
    const qw = lamp.sessionLamps(qwenSession({ extra: { live: true, liveStatus: 'busy' } }), { seenAtMs: 0 });
    assert.strictEqual(qw.registry, null);
    assert.strictEqual(qw.lamp, 'needsYou', 'a sub-agent approval guess still counts: no registry to overrule it');
    // isGuessStatus: guessed approval waits and anything tagged certainty 'guess'
    assert.ok(lamp.isGuessStatus(st('maybeAwaitingApproval', NOW)));
    assert.ok(lamp.isGuessStatus(guessDone));
    assert.ok(!lamp.isGuessStatus(st('done', NOW)));
    assert.ok(!lamp.isGuessStatus(null));
  });

  test('workflow row lamps, visuals, terminal dots', () => {
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

// ---------- Seen ----------

function seenTests() {
  test('store: only moves forward, marks several at once, reader reads once', async () => {
    const mem = seen.createMemoryMemento();
    let t = NOW;
    const store = seen.createSeenStore(mem, { now: () => t });
    assert.strictEqual(store.get('claude:a'), 0);
    assert.strictEqual(await store.mark('claude:a'), true);
    assert.strictEqual(store.get('claude:a'), NOW);
    assert.strictEqual(await store.mark('claude:a', NOW - 1000), false, 'an earlier time is not written');
    assert.strictEqual(store.get('claude:a'), NOW);
    t = NOW + 5000;
    await store.markMany(['claude:a', 'codex:b', '', null]);
    assert.deepStrictEqual(store.all(), { 'claude:a': NOW + 5000, 'codex:b': NOW + 5000 });
    const r = store.reader();
    await store.mark('claude:c', NOW + 9000);
    assert.strictEqual(r('claude:c'), 0, 'reader is a snapshot of that moment');
    assert.strictEqual(mem.get(seen.SEEN_KEY)['claude:c'], NOW + 9000, 'written to agentMonitor.seen.v1');
  });

  test('store: prunes entries older than 14 days, keeps at most 1000; --seen-all', async () => {
    const init = { 'claude:old': NOW - 15 * 24 * HOUR, 'claude:new': NOW - HOUR };
    for (let i = 0; i < 1005; i++) init['codex:' + i] = NOW - i * 1000;
    const mem = seen.createMemoryMemento({ [seen.SEEN_KEY]: init });
    const store = seen.createSeenStore(mem, { now: () => NOW });
    const removed = await store.prune();
    const left = store.all();
    assert.strictEqual(Object.keys(left).length, 1000);
    assert.ok(!('claude:old' in left));
    assert.strictEqual(removed, 1007 - 1000);
    assert.ok('codex:0' in left && !('codex:1004' in left), 'keeps the newest');
    const all = seen.createSeenStore(seen.createMemoryMemento(), { allSeen: true });
    assert.strictEqual(all.get('x'), seen.ALL_SEEN);
    assert.strictEqual(lamp.agentLamp({ status: st('done', NOW) }, { seenAtMs: all.get('x') }), 'doneSeen');
  });

  test('"seen" follows the selection: select A → A becomes DoneSeen, B stays DoneUnseen; then select B', async () => {
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
    await store.mark(B.key); // select B
    assert.deepStrictEqual(lampsNow(), ['doneSeen', 'doneSeen']);
    // A finishes another turn: the new doneAtMs is later than seen → unseen again
    A.doneAtMs = t + 1000;
    A.main.status = st('done', t + 1000);
    assert.deepStrictEqual(lampsNow(), ['doneUnseen', 'doneSeen']);
  });

  test('dwell timer: marks only after a full 1.5 s; switching away cancels; refresh marks only sessions with new content', async () => {
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
    d.set('tab', 'claude:A'); // same key does not restart the timer
    d.set('tab', 'claude:B'); // switched away after 1 s: A does not count
    t += 1000; run();
    await Promise.resolve();
    assert.strictEqual(store.get('claude:A'), 0);
    t += 600; run();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(store.get('claude:B'), NOW + 1000 + 1000 + 600);
    assert.deepStrictEqual(marked, ['tab:claude:B']);
    d.set('view', null);
    assert.deepStrictEqual(d.active(), { tab: 'claude:B' });
    // Keep watching: mark again only when there is new content
    t += 10000;
    assert.strictEqual(await d.refresh(() => false), false);
    await d.refresh((k) => k === 'claude:B');
    assert.strictEqual(store.get('claude:B'), t);
    d.set('tab', null);
    assert.deepStrictEqual(d.active(), {});
    d.dispose();
  });
}

// ---------- Scope and following ----------

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
  test('only two scope levels; migration of old values and onlyWorkspace', () => {
    assert.deepStrictEqual(scope.SCOPES, ['all', 'workspace']);
    assert.strictEqual(scope.normalizeScope('workspace'), 'workspace');
    assert.strictEqual(scope.normalizeScope('conversation'), 'workspace');
    assert.strictEqual(scope.normalizeScope('pinned'), 'all');
    assert.strictEqual(scope.normalizeScope(undefined), 'all');
    assert.deepStrictEqual(scope.planScopeMigration({}, { workspaceValue: true, globalValue: false }),
      [{ key: 'scope', value: 'workspace', target: 'workspace' }]);
    assert.deepStrictEqual(scope.planScopeMigration({}, { globalValue: true }), [{ key: 'scope', value: 'workspace', target: 'global' }]);
    assert.deepStrictEqual(scope.planScopeMigration({}, { workspaceValue: false, globalValue: true }), [], 'the effective layer is false');
    assert.deepStrictEqual(scope.planScopeMigration({ globalValue: 'all' }, { globalValue: true }), [], 'no migration once scope is set');
    assert.deepStrictEqual(scope.planScopeMigration({ globalValue: 'pinned', workspaceValue: 'conversation' }, undefined), [
      { key: 'scope', value: 'workspace', target: 'workspace' },
      { key: 'scope', value: 'all', target: 'global' },
    ]);
  });

  test('workspace level: Claude matches the directory name or cwd, Codex only cwd; path boundaries; case-insensitive on Windows', () => {
    const ws = scope.workspaceInfo([{ uri: { fsPath: '/work/proj' } }, '/other/place/']);
    assert.deepStrictEqual(ws.dirs, ['-work-proj', '-other-place-']);
    const c = (o) => session({ cwd: null, projectDir: null, ...o });
    assert.ok(scope.inWorkspace(c({ projectDir: '-work-proj' }), ws));
    assert.ok(scope.inWorkspace(c({ cwd: '/work/proj/sub/dir' }), ws));
    assert.ok(scope.inWorkspace(c({ cwd: '/other/place' }), ws));
    assert.ok(!scope.inWorkspace(c({ cwd: '/work/project2' }), ws), '/work/proj does not contain /work/project2');
    assert.ok(!scope.inWorkspace(c({ provider: 'codex', projectDir: '-work-proj', cwd: '/elsewhere' }), ws), 'Codex ignores the directory name');
    assert.ok(scope.inWorkspace(c({ provider: 'codex', cwd: '/work/proj' }), ws));
    const win = scope.workspaceInfo(['C:\\Users\\Me\\Proj']);
    assert.ok(scope.inWorkspace(c({ provider: 'codex', cwd: 'c:/users/me/proj/src' }), win));
    // Directory name longer than 200 characters: compare the first 200
    const long = '/' + 'x'.repeat(230);
    const lws = scope.workspaceInfo([long]);
    assert.ok(scope.inWorkspace(c({ projectDir: scope.projectDirName(long).slice(0, 200) + '-abc123' }), lws));
    const list = [c({ id: '1', cwd: '/work/proj' }), c({ id: '2', cwd: '/tmp/x' })];
    assert.strictEqual(scope.filterByScope(list, 'all', ws).length, 2);
    assert.deepStrictEqual(scope.filterByScope(list, 'workspace', ws).map((s) => s.id), ['1']);
    assert.deepStrictEqual(scope.filterByScope(list, 'workspace', scope.workspaceInfo(undefined)), []);
  });

  test('tab classification: Claude webview, Codex custom editor, others', () => {
    assert.deepStrictEqual(scope.classifyTab(claudeTab('  Fix login  '), TYPES), { provider: 'claude', label: 'Fix login' });
    assert.deepStrictEqual(scope.classifyTab(codexTab('th-1', 'Refactor'), TYPES), { provider: 'codex', label: 'Refactor', conversationId: 'th-1' });
    assert.strictEqual(scope.classifyTab(textTab(), TYPES), null);
    assert.strictEqual(scope.classifyTab({ label: 'x', input: new TabInputWebview('mainThreadWebview-other') }, TYPES), null);
    assert.strictEqual(scope.classifyTab(null, TYPES), null);
    // Without the classes, decide by fields
    assert.strictEqual(scope.classifyTab(claudeTab('A')).provider, 'claude');
    assert.strictEqual(scope.codexConversationId('openai-codex://route/local/abc-123'), 'abc-123');
    assert.strictEqual(scope.codexConversationId({ path: '/remote/r-9' }), 'r-9');
    assert.strictEqual(scope.codexConversationId({ path: '/settings' }), null);
  });

  test('matching: title → default title falls back to the newest VS Code session in the workspace → Codex id / thread_name', () => {
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
    assert.strictEqual(m(claudeTab('Fix login')), 'claude:c2', 'duplicate titles: most recently updated wins');
    assert.strictEqual(m(claudeTab('L'.repeat(200))), 'claude:c3', 'title truncated to 200 code points');
    assert.strictEqual(m(claudeTab('From prompt')), null, 'titles taken from the prompt are not matched');
    assert.strictEqual(m(claudeTab('Claude Code')), 'claude:c6', 'default title: an open VS Code session wins');
    assert.strictEqual(m(claudeTab('Unknown')), null);
    assert.strictEqual(m(codexTab('th-1')), 'codex:th-1');
    assert.strictEqual(m(codexTab('zzz', 'Codex thread')), 'codex:th-1', 'falls back to thread_name when the id does not match');
    assert.strictEqual(m(codexTab('zzz', 'nope')), null);
  });

  test('follow: selection moves only on tab switches; focus events on the same tab and data refreshes do not move it', () => {
    const ws = scope.workspaceInfo(['/work/proj']);
    let t = NOW;
    const A = session({ id: 'A', title: 'Alpha' });
    const B = session({ id: 'B', title: 'Beta' });
    let sessions = [A, B];
    const f = scope.createChatFollower({ types: TYPES, now: () => t });
    assert.strictEqual(f.key, null);
    let r = f.onTabEvent(claudeTab('Alpha'), sessions, ws);
    assert.deepStrictEqual([r.key, r.follow], ['claude:A', true]);
    r = f.onTabEvent(claudeTab('Alpha'), sessions, ws); // window focus change, same tab
    assert.strictEqual(r.follow, false);
    r = f.onSnapshot(claudeTab('Alpha'), sessions, ws);
    assert.strictEqual(r.follow, false, 'a data refresh does not move it');
    r = f.onTabEvent(textTab(), sessions, ws); // switch to a code tab
    assert.deepStrictEqual([r.key, r.follow, r.chat], ['claude:A', false, false], 'keeps the previous one');
    r = f.onTabEvent(claudeTab('Alpha'), sessions, ws); // switch back: follow once more
    assert.strictEqual(r.follow, true);
    r = f.onTabEvent(claudeTab('Beta'), sessions, ws);
    assert.deepStrictEqual([r.key, r.follow], ['claude:B', true]);
    // New session: not in the snapshot yet at tab switch → don't follow yet; follow once when it appears in a later snapshot
    r = f.onTabEvent(claudeTab('Gamma'), sessions, ws);
    assert.deepStrictEqual([r.key, r.follow], ['claude:B', false]);
    t += 2000;
    assert.strictEqual(f.onSnapshot(claudeTab('Gamma'), sessions, ws).follow, false);
    sessions = [...sessions, session({ id: 'G', title: 'Gamma' })];
    r = f.onSnapshot(claudeTab('Gamma'), sessions, ws);
    assert.deepStrictEqual([r.key, r.follow], ['claude:G', true]);
    assert.strictEqual(f.onSnapshot(claudeTab('Gamma'), sessions, ws).follow, false, 'follows only once');
    // After the timeout, no late follow
    f.onTabEvent(claudeTab('Delta'), sessions, ws);
    t += 31000;
    sessions = [...sessions, session({ id: 'D', title: 'Delta' })];
    assert.strictEqual(f.onSnapshot(claudeTab('Delta'), sessions, ws).follow, false);
    // Claude setting the title (same tab renamed) counts as a switch
    f.onTabEvent(claudeTab('Claude Code'), sessions, ws);
    r = f.onTabEvent(claudeTab('Alpha'), sessions, ws);
    assert.deepStrictEqual([r.key, r.follow], ['claude:A', true]);
  });

  test('which session the right side shows: selected → current conversation → first row', () => {
    const keys = ['claude:a', 'claude:b', 'codex:c'];
    assert.deepStrictEqual(scope.resolveSelection({ selectedKey: 'claude:b', conversationKey: 'codex:c', keys }), { key: 'claude:b', reason: 'selected' });
    assert.deepStrictEqual(scope.resolveSelection({ selectedKey: 'gone', conversationKey: 'codex:c', keys }), { key: 'codex:c', reason: 'conversation' });
    assert.deepStrictEqual(scope.resolveSelection({ selectedKey: null, conversationKey: null, keys }), { key: 'claude:a', reason: 'first' });
    assert.deepStrictEqual(scope.resolveSelection({ keys: [] }), { key: null, reason: null });
  });
}

// ---------- Stable ordering ----------

function orderTests() {
  test('20 consecutive snapshots: agents alternate activity, lamps flip back and forth, agents and sessions are added midway; left and right order never jumps', () => {
    let t = NOW;
    const so = order.createSessionOrder({ now: () => t });
    const ao = order.createAgentOrder({ now: () => t });
    const T0 = NOW;
    const mkAgent = (id, kind, start, name) => agent({ id, kind, name, startedMs: start, model: 'claude-sonnet-5' });
    // Session A (open): main + subagents a1, a2 + workflow wf1 (w1, w2)
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
      // Two subagents alternate: lamps flip between Working and DoneUnseen; tokens and activity times keep changing
      const [on, off] = i % 2 ? [a2, a1] : [a1, a2];
      on.status = st('tool', t - 500, { pendingTool: 'Bash' });
      on.lastActivityMs = t;
      on.tokens = tokens(90000 + i * 1000);
      off.status = st('done', t - 1500);
      // Workflow agent: switches between "maybe waiting for your approval" and "running a tool" (magenta ↔ blue)
      w1.status = i % 3 === 0 ? st('maybeAwaitingApproval', t - 70000, { pendingTool: 'Edit' }) : st('tool', t - 1000, { pendingTool: 'Read' });
      w2.lastActivityMs = t;
      // Two sessions take turns being newest: the snapshot itself is sorted by updatedMs descending, so rows would swap
      A.updatedMs = i % 2 ? t : t - 1000;
      B.updatedMs = i % 2 ? t - 1000 : t;
      B.main.status = i % 2 ? st('done', t - 100) : st('thinking', t - 100);
      if (i === 8) A.agents.push(mkAgent('a3', 'subagent', t, 'Late helper')); // new subagent
      if (i === 10) wf1.agents.push(mkAgent('w3', 'workflowAgent', t, 'Phase C')); // new agent inside the workflow
      if (i === 12) { E = session({ id: 'E', title: 'Epsilon', live: true, startedMs: t }); sessions.push(E); } // new session (open)
      if (i === 14) { F = session({ provider: 'codex', id: 'F', title: 'Zeta', live: false, startedMs: null }); sessions.push(F); } // no start time

      const input = [...sessions].sort((x, y) => y.updatedMs - x.updatedMs); // snapshot order
      const L = lamp.computeLamps(input);
      seenLamps.a1.add(L.bySession.get('claude:A').rows.get('a/a1').lamp);
      seenLamps.w1.add(L.bySession.get('claude:A').rows.get('wf/wf1/w1').lamp);
      seenLamps.session.add(L.bySession.get('claude:B').lamp);

      const left = so.arrange(input);
      const open = i >= 12 ? ['claude:E', 'claude:B', 'claude:A'] : ['claude:B', 'claude:A'];
      const recent = i >= 14 ? ['codex:F', 'codex:C', 'claude:D'] : ['codex:C', 'claude:D'];
      assert.deepStrictEqual(left.keys, [...open, ...recent], `snapshot ${i} left`);
      assert.deepStrictEqual(left.groups.map((g) => g.id), ['open', 'recent']);
      assert.strictEqual(left.showGroupHeaders, true);

      // Right side: subagents are fed in shuffled by "activity order"; the result is unaffected
      const shuffled = { ...A, agents: i % 2 ? [...A.agents].reverse() : A.agents, workflows: [{ ...wf1, agents: [...wf1.agents].reverse() }] };
      const right = ao.arrange(shuffled).map((r) => r.id);
      const want = ['main', 'a/a1', 'a/a2', 'wf/wf1', 'wf/wf1/w1', 'wf/wf1/w2'];
      if (i >= 10) want.push('wf/wf1/w3');
      if (i >= 8) want.push('a/a3');
      assert.deepStrictEqual(right, want, `snapshot ${i} right`);

      // New rows appear only in their designated place; existing rows keep their relative order
      if (prevLeft) {
        const d = order.diffOrder(prevLeft, left.keys);
        assert.strictEqual(d.moved, false, `snapshot ${i}: existing left rows did not move`);
        if (i === 12) assert.deepStrictEqual(d.added, [{ id: 'claude:E', afterId: null }], 'new session at the top of "Open"');
        else if (i === 14) assert.deepStrictEqual(d.added, [{ id: 'codex:F', afterId: 'claude:A' }], 'new session without a start time at the top of "Recent"');
        else assert.deepStrictEqual(d.added, []);
      }
      if (prevRight) {
        const d = order.diffOrder(prevRight, right);
        assert.strictEqual(d.moved, false, `snapshot ${i}: existing right rows did not move`);
        if (i === 8) assert.deepStrictEqual(d.added, [{ id: 'a/a3', afterId: 'wf/wf1/w2' }], 'new subagent appended at the end');
        else if (i === 10) assert.deepStrictEqual(d.added, [{ id: 'wf/wf1/w3', afterId: 'wf/wf1/w2' }], 'new workflow agent appended at the end of its group');
        else assert.deepStrictEqual(d.added, []);
      }
      prevLeft = left.keys;
      prevRight = right;
    }
    // The scenario really does "move": lamps did flip back and forth
    assert.ok(seenLamps.a1.has('working') && seenLamps.a1.has('doneUnseen'));
    assert.ok(seenLamps.w1.has('needsYou') && seenLamps.w1.has('working'));
    assert.ok(seenLamps.session.has('working') && seenLamps.session.has('doneUnseen'));
    // F's sort key is locked to the first-seen time and does not move when startedMs is filled in later
    const fKey = so.sortKey('codex:F');
    assert.strictEqual(fKey, T0 + 14 * 2000);
    F.startedMs = T0 - 10 * HOUR;
    t += 2000;
    assert.deepStrictEqual(so.arrange(sessions).keys.slice(3), ['codex:F', 'codex:C', 'claude:D']);
    assert.strictEqual(so.sortKey('codex:F'), fKey);
  });

  test('rows move only when switching between "Open ↔ Recent"; no group headers when there is only one group', () => {
    const so = order.createSessionOrder({ now: () => NOW });
    const A = session({ id: 'A', live: false, startedMs: NOW - 3 * HOUR });
    const B = session({ id: 'B', live: false, startedMs: NOW - 2 * HOUR });
    const C = session({ id: 'C', live: false, startedMs: NOW - 1 * HOUR });
    let r = so.arrange([A, B, C]);
    assert.deepStrictEqual(r.keys, ['claude:C', 'claude:B', 'claude:A']);
    assert.strictEqual(r.showGroupHeaders, false);
    A.live = true; // the user opened A
    r = so.arrange([C, B, A]);
    assert.deepStrictEqual(r.keys, ['claude:A', 'claude:C', 'claude:B']);
    assert.strictEqual(r.showGroupHeaders, true);
    A.live = false;
    r = so.arrange([B, A, C]);
    assert.deepStrictEqual(r.keys, ['claude:C', 'claude:B', 'claude:A'], 'back in place');
    assert.deepStrictEqual(so.arrange([A, B, C], { grouped: false }).keys, ['claude:C', 'claude:B', 'claude:A']);
  });

  test('hideCompleted: hides finished rows without changing the order of the rest; back in place when turned off', () => {
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

  test('sort key ignores activity time, lamp and tokens: first-seen time when startedMs is missing', () => {
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

// ---------- Formatting ----------

// Synthetic statuses covering every status code and the main branches
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

// A wide-coverage synthetic snapshot
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
      // Session-level context window and compaction point (with sources); every 8th session starting at index 7 omits them to exercise the fallback to the main agent's tokens
      ...(i % 8 === 7 ? {} : {
        contextWindow: provider === 'codex' ? 258400 : 1000000,
        contextWindowSource: provider === 'codex' ? 'codex-record' : ['cost-state', 'model-rule'][i % 2],
        compactAt: provider === 'codex' ? 232560 : 967000 - (i % 3) * 300000,
        compactAtSource: CTX_SOURCES[i % CTX_SOURCES.length],
      }),
      ccCostUsd: provider === 'claude' && i % 3 === 1 ? 1.5 + i : undefined,
    });
  });
  // Copilot / Gemini CLI / Qwen Code sessions, including Copilot waiting parts, guessed statuses and a Copilot session without credits
  sessions.push(
    copilotSession({ id: 'cop-q' }),
    copilotSession({ id: 'cop-plan', credits: null, extra: {
      main: agent({ status: st('awaitingInput', now - 9000, { question: 'planApproval' }), step: { kind: 'tool', tool: 'planReview', detail: null, parallel: 0, sinceMs: now - 9000 },
        tokens: noCompact(0, 128000), costUsd: null, copilotCredits: null }),
    } }),
    copilotSession({ id: 'cop-conf', extra: {
      main: agent({ status: st('awaitingApproval', now - 9000), step: { kind: 'tool', tool: 'confirmation', detail: null, parallel: 0, sinceMs: now - 9000 },
        tokens: noCompact(1000, 128000), costUsd: null, copilotCredits: 0.33 }),
    } }),
    geminiSession({ id: 'gem-done' }),
    geminiSession({ id: 'gem-run', extra: { live: true, liveStatus: 'busy', doneAtMs: null,
      main: agent({ model: 'gemini-9-ultra-exp', status: st('thinking', now - 3000, { certainty: 'guess' }), tokens: noCompact(20000, null, { input: 20000, cached: 0, thoughts: 10, tool: 0 }),
        costUsd: null, unpricedModel: 'gemini-9-ultra-exp' }) } }),
    qwenSession({ id: 'qw-done' }),
  );
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

// Run every formatting function once and collect the output ([name, text, may be empty])
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
    add(`cache ${s.key}`, fmt.formatCacheLeft(s.cacheExpiresMs, i18n, now), s.provider !== 'claude');
    add(`cost.note ${s.key}`, fmt.formatCostNote(i18n, s.provider));
    add(`provider.note ${s.key}`, fmt.formatProviderNote(s.provider, i18n), s.provider !== 'copilot');
    add(`live ${s.key}`, fmt.formatLive(s, i18n));
    for (const a of agents) {
      const c = fmt.formatAgentCost(a, i18n, { provider: s.provider });
      add(`agent.costLabel ${a.id}`, c.label);
      add(`agent.costCell ${a.id}`, c.cell);
      add(`agent.costFull ${a.id}`, c.full);
      add(`agent.breakdown ${a.id}`, fmt.formatTokenBreakdown(a.tokens, i18n), true);
      for (const n of fmt.formatContext(fmt.agentContextTokens(a, s.provider), i18n).notes) add(`ctx.agentNote ${a.id}`, n);
    }
  }
  for (const status of snap.statuses) {
    for (const main of [true, false]) {
      add(`status ${status.code}`, fmt.formatStatus(status, null, i18n, now, { isMain: main }));
      add(`statusStable ${status.code}`, fmt.formatStatus(status, null, i18n, now, { isMain: main, stable: true }));
    }
    if (status.quota) add('autoContinue', fmt.formatAutoContinue(status.quota, i18n, now), true);
  }
  for (const tool of ['questionCarousel', 'elicitationSerialized', 'elicitation', 'planReview', 'confirmation']) {
    add(`interaction ${tool}`, fmt.toolLabel(tool, i18n));
  }
  for (const step of snap.steps) {
    add(`step ${step.kind}`, fmt.formatStep(step, st('thinking', now), i18n, now));
    add(`stepDur ${step.kind}`, fmt.formatStep(step, st('tool', now), i18n, now, { withDur: true }));
    assert.strictEqual(fmt.formatStep(step, st('done', now), i18n, now), '', 'no step shown when done');
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
  test('five languages: no empty formatted output, no unreplaced placeholders, every key used exists in the dictionary (missing languages fall back to English)', () => {
    i18nLib.clearCache();
    const snap = syntheticSnapshot(NOW);
    for (const locale of LOCALES) {
      const base = i18nLib.createI18n(locale, { timeZone: 'UTC' });
      const used = new Set();
      const i18n = { ...base, t: (k, v) => { used.add(k); return base.t(k, v); } };
      const out = renderAll(i18n, NOW, snap);
      assert.ok(out.length > 500, `${locale}: output count ${out.length}`);
      for (const [name, text, mayBeEmpty] of out) {
        assert.strictEqual(typeof text, 'string', `${locale} ${name} is not a string`);
        if (!mayBeEmpty) assert.ok(text.trim().length > 0, `${locale} ${name} is empty`);
        assert.ok(!PLACEHOLDER.test(text), `${locale} ${name} has an unreplaced placeholder: ${text}`);
      }
      const missing = [...used].filter((k) => !base.has(k));
      assert.deepStrictEqual(missing, [], `${locale} missing entries`);
      assert.strictEqual(base.locale, locale);
    }
  });

  test('English text for definite vs. guessed "waiting for your approval"; the stable left-side version has no duration', () => {
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

  test('left row: {Claude|Codex} · {status} · {context}, text does not change as time passes', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    const snap = syntheticSnapshot(NOW);
    for (const s of snap.sessions) {
      const a = fmt.formatSessionRow(s, en, { now: NOW });
      const tipA = JSON.stringify(fmt.formatSessionTooltip(s, en, { now: NOW }));
      for (const dt of [1000, 7000, 29000]) {
        const b = fmt.formatSessionRow(s, en, { now: NOW + dt });
        assert.strictEqual(b.description, a.description, `${s.key} +${dt}ms`);
        assert.strictEqual(b.a11y, a.a11y);
        assert.strictEqual(JSON.stringify(fmt.formatSessionTooltip(s, en, { now: NOW + dt })), tipA, `${s.key} tooltip +${dt}ms`);
      }
      assert.ok(/^(Claude|Codex|Copilot|Gemini CLI|Qwen Code) · /.test(a.description), a.description);
    }
    const s = session({
      live: true, liveStatus: 'waiting', waitingFor: 'permission prompt',
      main: agent({ status: st('tool', NOW - 5000, { pendingTool: 'Bash' }), tokens: tokens(290100) }),
    });
    // Percentage uses Claude Code's formula: 290100 / 1M window = 29% (not 30% of the 967K threshold)
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

  test('tool names, steps, context, cost', () => {
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
    assert.strictEqual(c.pctText, '41%', 'percentage = used / window (Claude Code\'s formula)');
    assert.strictEqual(c.pct, 41);
    assert.strictEqual(c.usageText, '412.3K / 967K');
    assert.strictEqual(c.remainText, '554.7K until auto-compact');
    assert.strictEqual(c.shortText, '41% context');
    assert.strictEqual(c.pctOfWindowText, '41% of the 1M window');
    assert.ok(Math.abs(c.ratio - 412345 / 967000) < 1e-9, 'the progress bar is still used / auto-compact point');
    assert.strictEqual(fmt.formatContext(tokens(84000, { compactAt: null, toCompact: null }), en).remainText, 'Auto-compact is off');
    const rel = fmt.formatContext({ contextUsed: 100000, contextWindow: 258400, compactAt: 244800, toCompact: null }, en);
    assert.strictEqual(rel.usageText, '100K / 258.4K', 'body_after_prefix: the progress bar falls back to the window');
    assert.strictEqual(rel.notes.length, 1);
    assert.strictEqual(fmt.formatCost(1.234, en), '$1.23');
    assert.strictEqual(fmt.formatCost(0.4, en, { unpriced: 'codex-auto-review' }), '$0.400+');
    assert.strictEqual(fmt.formatCost(null, en, { unpriced: true }), 'No public price');
    assert.strictEqual(fmt.formatCost(null, en), '—');
    assert.ok(fmt.formatCostNote(en).includes('2026-09-23'));
  });

  test('percentage: Claude Code\'s formula (rounded, clamped to 0–100); small but non-zero shows <1%', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    assert.strictEqual(fmt.contextPct(4999, 1000000), 0);
    assert.strictEqual(fmt.contextPct(5000, 1000000), 1, '0.5 rounds to 1');
    assert.strictEqual(fmt.contextPct(1500000, 1000000), 100, 'clamped at 100');
    assert.strictEqual(fmt.contextPct(-3, 1000000), 0);
    assert.strictEqual(fmt.contextPct(100, 0), null);
    const tiny = fmt.formatContext(tokens(3000), en);
    assert.strictEqual(tiny.pctText, '<1%');
    assert.strictEqual(tiny.shortText, '<1% context');
    assert.strictEqual(fmt.formatContext(tokens(0), en).pctText, '0%', 'shows 0% only when it really is 0');
    assert.strictEqual(fmt.formatContext(tokens(1200000, { toCompact: -233000 }), en).pctText, '100%');
    // <1% has no leftover placeholders in any language
    for (const locale of LOCALES) {
      const t = fmt.formatContext(tokens(3000), i18nLib.createI18n(locale, { timeZone: 'UTC' })).pctText;
      assert.ok(t.startsWith('<') && /1/.test(t), `${locale}: ${t}`);
    }
    // When the window is unknown, the threshold is used as the denominator
    assert.strictEqual(fmt.formatContext({ contextUsed: 50000, contextWindow: null, compactAt: 100000, toCompact: 50000 }, en).pctText, '50%');
  });

  test('session-level context window and compaction point: values on Session win, sources go into the tooltip; disabled → auto-compact off', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    // Main agent tokens by the old rule are 200K / 167K; the provider recognized [1m] from cost-state → session-level 1M, observed 950K
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
    assert.ok(src.lines.some((l) => l.includes('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')), 'mentions that setting the env variable makes it earlier');
    assert.ok(src.lines.some((l) => l.includes("Claude Code's own formula")));
    const tip = Object.fromEntries(fmt.formatSessionTooltip(s, en, { now: NOW }));
    assert.strictEqual(tip[en.t('tip.autoCompact')], 'About 950K · measured where this model last auto-compacted');
    assert.strictEqual(tip[en.t('ctx.label')], '300K / 950K · 650K until auto-compact · 30% of the 1M window');
    // Every source has text
    for (const source of ['settings-local', 'settings-project', 'settings-user', 'observed', 'default']) {
      const t = fmt.formatContextSources(fmt.sessionContextTokens({ ...s, compactAtSource: source }), 'claude', en);
      assert.ok(t.compactText && !/\{\w+\}/.test(t.compactText) && !t.compactText.includes('src.'), source + ': ' + t.compactText);
    }
    // Auto-compact turned off
    const off = session({ contextWindow: 1000000, contextWindowSource: 'model-rule', compactAt: null, compactAtSource: 'disabled', main: agent({ tokens: tokens(84000) }) });
    const offTk = fmt.sessionContextTokens(off);
    assert.strictEqual(offTk.compactAt, null);
    assert.strictEqual(fmt.formatContext(offTk, en).remainText, 'Auto-compact is off');
    assert.strictEqual(fmt.formatContextSources(offTk, 'claude', en).compactShort, 'Off');
    assert.ok(!fmt.formatContextSources(offTk, 'claude', en).lines.some((l) => l.includes('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')));
    // Codex body_after_prefix: remaining amount cannot be computed; the "relative" note is kept
    const cx = session({ provider: 'codex', id: 'th', contextWindow: 258400, contextWindowSource: 'codex-record', compactAt: 232560, compactAtSource: 'default',
      main: agent({ tokens: { contextUsed: 100000, contextWindow: 258400, compactAt: 232560, toCompact: null } }) });
    const cxTk = fmt.sessionContextTokens(cx);
    assert.strictEqual(cxTk.toCompact, null);
    assert.strictEqual(fmt.formatContext(cxTk, en).notes.length, 1);
    assert.ok(!fmt.formatContextSources(cxTk, 'codex', en).lines.some((l) => l.includes('CLAUDE_')), 'Codex does not mention Claude env variables');
    // No session-level fields: use the main agent's tokens as they are
    const plain = fmt.sessionContextTokens(session());
    assert.strictEqual(plain.compactAt, 967000);
    assert.strictEqual(plain.windowSource, null);
  });

  test('session cost prefers Claude Code\'s own count; bytes use 1000-based units', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    const cc = fmt.formatSessionCost(session({ ccCostUsd: 3.2104, costUsd: 2.9 }), en);
    const label = 'API-equivalent cost';
    assert.deepStrictEqual(cc, { text: "$3.21 (Claude Code's count)", fromClaudeCode: true, estimateText: '$2.90', credits: false, label });
    assert.deepStrictEqual(fmt.formatSessionCost(session({ costUsd: 2.9 }), en), { text: '$2.90', fromClaudeCode: false, estimateText: '$2.90', credits: false, label });
    assert.strictEqual(fmt.formatSessionCost(session({ costUsd: null }), en).text, '');
    const tip = Object.fromEntries(fmt.formatSessionTooltip(session({ ccCostUsd: 3.2104 }), en, { now: NOW }));
    assert.strictEqual(tip[en.t('cost.label')], "$3.21 (Claude Code's count)");
    assert.strictEqual(fmt.formatBytes(0, en), '0B');
    assert.strictEqual(fmt.formatBytes(512, en), '512B');
    assert.strictEqual(fmt.formatBytes(7.7e6, en), '7.7 MB');
    assert.strictEqual(fmt.formatBytes(57.3e6, en), '57.3 MB');
    assert.strictEqual(fmt.formatBytes(932e6, en), '932 MB');
    assert.strictEqual(fmt.formatBytes(999.97e6, en), '1 GB', 'no "1000 MB" after rounding');
    assert.strictEqual(fmt.formatBytes(null, en), '—');
    assert.strictEqual(fmt.formatBytes(-1, en), '—');
  });

  test('Copilot / Gemini CLI / Qwen Code: product names, sub-agent kinds, Copilot waiting parts by name', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    for (const locale of LOCALES) {
      const i18n = i18nLib.createI18n(locale, { timeZone: 'UTC' });
      assert.deepStrictEqual(['copilot', 'gemini', 'qwen'].map((p) => fmt.providerLabel(p, i18n)), ['Copilot', 'Gemini CLI', 'Qwen Code'], locale);
    }
    assert.strictEqual(fmt.providerLabel('someday', en), 'someday', 'unknown providers fall back to the raw id');
    const cop = copilotSession();
    assert.ok(fmt.formatSessionRow(cop, en, { now: NOW }).description.startsWith('Copilot · Waiting for your answer'));
    assert.ok(fmt.formatSessionRow(geminiSession(), en, { now: NOW }).description.startsWith('Gemini CLI · '));
    assert.ok(fmt.formatSessionRow(qwenSession(), en, { now: NOW }).description.startsWith('Qwen Code · '));
    const tip = Object.fromEntries(fmt.formatSessionTooltip(cop, en, { now: NOW }));
    assert.strictEqual(tip[en.t('tip.entry')], 'Copilot · VS Code · open now');
    // Sub-agents render like Claude's: the Copilot task description is the name, the agent's own name goes into the type
    const [sa] = cop.agents;
    assert.strictEqual(fmt.formatAgentName(sa, en), 'Survey the repo for auth call sites');
    assert.strictEqual(fmt.formatAgentKind(sa, en), 'Subagent · Explorer');
    assert.strictEqual(fmt.formatAgentKind(geminiSession().agents[0], en), 'Subagent · codebase_investigator');
    assert.strictEqual(fmt.formatAgentName(qwenSession().agents[0], en), 'reviewer');
    assert.strictEqual(fmt.formatAgentKind({ kind: 'qwenSubagent' }, en), 'Subagent');
    // Copilot parts that wait on you: step.tool carries the raw part kind
    const label = (tool) => fmt.formatStep({ kind: 'tool', tool, detail: null, parallel: 0, sinceMs: NOW }, st('awaitingInput', NOW), en, NOW);
    assert.deepStrictEqual(['questionCarousel', 'elicitationSerialized', 'planReview', 'confirmation'].map(label),
      ['Question for you', 'Request for input', 'Plan review', 'Confirmation']);
    assert.strictEqual(fmt.toolLabel('confirmation'), 'confirmation', 'without a dictionary the raw kind is kept');
    assert.strictEqual(fmt.formatTimelineEvent({ ms: NOW, kind: 'tool', tool: 'planReview', detail: null }, en), 'Plan review');
    assert.strictEqual(fmt.formatStatus(st('awaitingInput', NOW, { question: 'askUser' }), null, en, NOW), 'Waiting for your answer');
    assert.strictEqual(fmt.formatStatus(st('awaitingInput', NOW, { question: 'planApproval' }), null, en, NOW), 'Waiting for you to approve the plan');
  });

  test('guessed statuses (Gemini CLI timing guesses, liveCertainty guess): "~" mark and a note; approval guesses keep their own wording', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    const g = st('thinking', NOW - 3000, { certainty: 'guess' });
    assert.strictEqual(fmt.formatStatus(g, null, en, NOW), '~Thinking');
    assert.strictEqual(fmt.formatStatus(st('done', NOW, { certainty: 'guess' }), { kind: 'main' }, en, NOW, { stable: true }), '~Turn finished');
    assert.strictEqual(fmt.formatStatus(st('stale', NOW - 7 * MIN, { certainty: 'guess' }), null, en, NOW, { stable: true }), '~No recent activity');
    assert.strictEqual(fmt.formatStatus(st('maybeAwaitingApproval', NOW), null, en, NOW, { stable: true }), 'May be waiting for your approval', 'no double hedge');
    assert.strictEqual(fmt.formatStatus(st('thinking', NOW), null, en, NOW), 'Thinking', 'certain statuses are unchanged');
    assert.ok(fmt.formatStatusNote(g, en).startsWith('Guessed from when the session log was last written'));
    assert.ok(fmt.formatStatusNote(st('maybeAwaitingApproval', NOW), en).startsWith('Guessed: a quick tool'));
    assert.strictEqual(fmt.formatStatusNote(st('done', NOW), en), '');
    const gem = geminiSession();
    const row = fmt.formatSessionRow(gem, en, { now: NOW });
    assert.strictEqual(row.description, 'Gemini CLI · ~Turn finished · 5% context');
    const tip = Object.fromEntries(fmt.formatSessionTooltip(gem, en, { now: NOW }));
    assert.ok(tip[en.t('tip.note')].startsWith('Guessed from when'));
    assert.strictEqual(tip[en.t('tip.entry')], 'Gemini CLI · Terminal · probably not open');
    assert.strictEqual(fmt.formatLive({ live: true, liveCertainty: 'guess' }, en), 'probably open');
    assert.strictEqual(fmt.formatLive({ live: true }, en), 'open now');
    // Copilot: status can lag behind VS Code by about a minute
    const cop = Object.fromEntries(fmt.formatSessionTooltip(copilotSession(), en, { now: NOW }));
    assert.ok(cop[en.t('tip.note')].includes('60 seconds'));
    assert.strictEqual(fmt.formatProviderNote('claude', en), '');
  });

  test('costs: Copilot shows credits (never "$0" or "No public price"); unpriced Qwen / Gemini models; estimate marker; per-provider price dates', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    const cop = copilotSession({ credits: 12.345 });
    assert.deepStrictEqual(fmt.formatSessionCost(cop, en), { text: '12.35 credits', fromClaudeCode: false, estimateText: '', credits: true, label: 'Copilot credits' });
    assert.strictEqual(fmt.formatSessionCost(copilotSession({ credits: null }), en).text, '', 'not recorded: nothing rather than a misleading 0');
    assert.strictEqual(fmt.copilotCredits({ provider: 'copilot', main: { copilotCredits: 3 } }), 3, 'falls back to main.copilotCredits');
    const tip = Object.fromEntries(fmt.formatSessionTooltip(cop, en, { now: NOW }));
    assert.strictEqual(tip['Copilot credits'], '12.35 credits');
    assert.ok(!(en.t('cost.label') in tip));
    assert.deepStrictEqual(fmt.formatAgentCost(cop.main, en, { provider: 'copilot' }), { label: 'Copilot credits', cell: '12.35', full: '12.35 credits' });
    assert.deepStrictEqual(fmt.formatAgentCost(cop.agents[0], en, { provider: 'copilot' }),
      { label: 'Copilot credits', cell: '—', full: "Counted in the session's Copilot credits (main agent row)." });
    assert.strictEqual(fmt.formatAgentCost({ kind: 'main', copilotCredits: null }, en, { provider: 'copilot' }).full, en.t('cost.credits.none'));
    assert.ok(fmt.formatCostNote(en, 'copilot').startsWith('Copilot bills in credits'));
    // Qwen OAuth 'coder-model' and unknown Gemini ids: tokens still shown, cost says "No public price"
    const qw = qwenSession();
    assert.strictEqual(fmt.formatSessionCost(qw, en).text, 'No public price');
    assert.deepStrictEqual(fmt.formatAgentCost(qw.main, en, { provider: 'qwen' }), { label: 'API-equivalent cost', cell: '—', full: 'No public price' });
    assert.strictEqual(fmt.formatAgentCost(qw.agents[0], en, { provider: 'qwen' }).full, '$0.001 est.');
    const gem = geminiSession();
    assert.deepStrictEqual(fmt.formatAgentCost(gem.main, en, { provider: 'gemini' }), { label: 'API-equivalent cost', cell: '$0.052', full: '$0.052 est.' });
    assert.ok(fmt.formatCostNote(en, 'gemini').includes('2026-09-24'), 'Gemini prices have their own date');
    assert.ok(fmt.formatCostNote(en, 'qwen').includes('2026-09-24'));
    assert.ok(fmt.formatCostNote(en, 'claude').includes('2026-09-23'));
    // Gemini token breakdown; nothing for providers without one
    assert.strictEqual(fmt.formatTokenBreakdown(gem.main.tokens, en), 'Input 52K (cached 30K) · thoughts 1.2K · tool use 300');
    assert.strictEqual(fmt.formatTokenBreakdown(tokens(1000), en), '');
  });

  test('no auto-compact point for Copilot / Gemini CLI / Qwen Code: never "auto-compact is off", no compaction row, no compact menu; window source named', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    for (const s of [copilotSession(), geminiSession(), qwenSession()]) {
      const tk = fmt.sessionContextTokens(s);
      assert.strictEqual(tk.compactUnknown, true, s.provider);
      const c = fmt.formatContext(tk, en);
      assert.strictEqual(c.remainText, '', s.provider);
      assert.deepStrictEqual(c.notes, [en.t('ctx.compactUnknown')]);
      assert.ok(c.usageText.includes(' / '), 'usage is shown against the window');
      const src = fmt.formatContextSources(tk, s.provider, en);
      assert.strictEqual(src.compactShort, '');
      assert.strictEqual(src.compactText, '');
      assert.ok(!src.lines.some((l) => l.includes('CLAUDE_')));
      const tip = Object.fromEntries(fmt.formatSessionTooltip(s, en, { now: NOW }));
      assert.ok(!(en.t('tip.autoCompact') in tip), s.provider);
      assert.ok(!tip[en.t('ctx.label')].includes('Auto-compact'), s.provider);
      const big = { ...s, main: { ...s.main, tokens: noCompact(90000, 128000) } };
      assert.ok(!/\bcompactable\b/.test(fmt.sessionContextValue(big, 'working')), 'no compact command for ' + s.provider);
      const at = fmt.formatContext(fmt.agentContextTokens(s.main, s.provider), en);
      assert.strictEqual(at.remainText, '');
    }
    assert.strictEqual(fmt.formatContextSources(fmt.sessionContextTokens(copilotSession()), 'copilot', en).windowText,
      'Context window: 128K (from the model info VS Code keeps with this chat)');
    assert.strictEqual(fmt.formatContextSources(fmt.sessionContextTokens(qwenSession()), 'qwen', en).windowText,
      'Context window: 1M (from the Qwen Code session log)');
    // Claude / Codex keep "auto-compact is off" for compactAt null
    assert.strictEqual(fmt.formatContext(fmt.agentContextTokens(agent({ tokens: tokens(84000, { compactAt: null, toCompact: null }) }), 'claude'), en).remainText, 'Auto-compact is off');
    assert.strictEqual(fmt.sessionContextTokens(session()).compactUnknown, false);
  });

  test('token counts never recorded (Copilot sub-agents, Copilot chats without usage): "—" instead of 0, no percentage, bar or row context', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    const zero = { display: 0, contextUsed: 0, contextWindow: 128000, compactAt: null, toCompact: null, contextPct: 0, output: 0, processed: 0, apiCalls: 0 };
    const s = copilotSession({ extra: { main: agent({ model: 'copilot/claude-sonnet-4.5', tokens: zero, costUsd: null, copilotCredits: 2, cacheTtl: null }) } });
    assert.strictEqual(fmt.tokensUnknown(s.main, 'copilot'), true);
    assert.strictEqual(fmt.tokensUnknown(s.agents[0], 'copilot'), true, 'Copilot never records sub-agent tokens');
    assert.strictEqual(fmt.tokensUnknown(copilotSession().main, 'copilot'), false, 'a Copilot chat with usage');
    assert.strictEqual(fmt.tokensUnknown(agent({ tokens: tokens(0, { output: 0, processed: 0 }) }), 'claude'), false, 'other providers: 0 is a real reading');
    assert.strictEqual(fmt.tokensUnknown(agent({ tokens: { ...zero, unknown: true } }), 'gemini'), true, 'explicit flag');
    const c = fmt.formatContext(fmt.sessionContextTokens(s), en);
    assert.strictEqual(c.unknown, true);
    assert.strictEqual(c.usageText, '— / 128K');
    assert.strictEqual(c.ratio, null);
    assert.strictEqual(c.pct, null);
    assert.strictEqual(c.pctText, '');
    assert.strictEqual(c.shortText, '');
    assert.strictEqual(c.pctOfWindowText, '');
    assert.deepStrictEqual(c.notes, []);
    assert.strictEqual(fmt.formatContext({ unknown: true }, en).usageText, '—', 'no window either');
    const sub = fmt.formatContext(fmt.agentContextTokens(s.agents[0], 'copilot'), en);
    assert.strictEqual(sub.usageText, '—');
    assert.strictEqual(fmt.formatTokensUnknownNote(s.agents[0], 'copilot', en), en.t('ctx.unknown.sub'));
    assert.strictEqual(fmt.formatTokensUnknownNote(s.main, 'copilot', en), en.t('ctx.unknown.note'));
    assert.strictEqual(fmt.formatTokensUnknownNote(copilotSession().main, 'copilot', en), '');
    // Session list row and tooltip: no "0% context", "Context: — / 128K"
    const row = fmt.formatSessionRow(s, en, { now: NOW });
    assert.strictEqual(row.contextText, '');
    assert.ok(!/\b0%/.test(row.description), row.description);
    const tip = Object.fromEntries(fmt.formatSessionTooltip(s, en, { now: NOW }));
    assert.strictEqual(tip[en.t('ctx.label')], '— / 128K');
    for (const loc of LOCALES) {
      const i18n = i18nLib.createI18n(loc, { timeZone: 'UTC' });
      for (const k of ['ctx.unknown', 'ctx.unknown.note', 'ctx.unknown.sub']) assert.ok(i18n.t(k) && i18n.t(k) !== k, `${loc}: ${k}`);
    }
  });

  test('last usage-limit hits: Claude, Copilot, Gemini CLI and Qwen Code each get a line; the panel keeps a hit without a reset time for an hour', () => {
    const en = i18nLib.createI18n('en', { timeZone: 'UTC' });
    const hit = (o) => ({ kind: 'unknown', model: null, resetsAtMs: null, resetsText: null, source: 'text', autoContinue: null, ms: NOW - 5 * MIN, sessionKey: 'x:1', ...o });
    assert.strictEqual(fmt.formatLastHit('copilot', hit({ source: 'turnError', model: 'gpt-5' }), en, NOW), 'Last Copilot limit hit: Usage limit reached (5m ago)');
    assert.strictEqual(fmt.formatLastHit('qwen', hit({ ms: undefined }), en, NOW), 'Last Qwen Code limit hit: Usage limit reached');
    assert.strictEqual(fmt.formatLastHit('gemini', null, en, NOW), '');
    const claude = hit({ kind: 'weekly', resetsAtMs: NOW + HOUR });
    assert.strictEqual(fmt.formatLastHit('claude', claude, en, NOW), fmt.formatClaudeLastHit(claude, en, NOW));
    assert.ok(fmt.formatClaudeLastHit(claude, en, NOW).startsWith('Last Claude limit hit: Weekly limit reached'));
    const lines = fmt.formatLastHits({
      claude: { lastHit: claude }, codex: { windows: [] }, copilot: { lastHit: null }, gemini: { lastHit: hit({ ms: NOW - 2 * HOUR }) }, qwen: { lastHit: hit() },
    }, en, NOW);
    assert.deepStrictEqual(lines.map((l) => l.split(':')[0]), ['Last Claude limit hit', 'Last Gemini CLI limit hit', 'Last Qwen Code limit hit']);
    assert.deepStrictEqual(fmt.formatLastHits(null, en, NOW), []);
    assert.deepStrictEqual(fmt.formatLastHits({ claude: { lastHit: null } }, en, NOW), []);
    assert.strictEqual(fmt.isRecentHit(hit(), NOW), true);
    assert.strictEqual(fmt.isRecentHit(hit({ ms: NOW - 61 * MIN }), NOW), false, 'no reset time: an hour');
    assert.strictEqual(fmt.isRecentHit(hit({ ms: NOW - 3 * HOUR, resetsAtMs: NOW + MIN }), NOW), true, 'known reset time wins');
    assert.strictEqual(fmt.isRecentHit(hit({ resetsAtMs: NOW - 1 }), NOW), false);
    assert.strictEqual(fmt.isRecentHit(null, NOW), false);
    for (const loc of LOCALES) {
      const i18n = i18nLib.createI18n(loc, { timeZone: 'UTC' });
      for (const p of ['copilot', 'gemini', 'qwen']) {
        const t = fmt.formatLastHit(p, hit(), i18n, NOW);
        assert.ok(t.includes(fmt.providerLabel(p, i18n)) && !PLACEHOLDER.test(t), `${loc} ${p}: ${t}`);
      }
      assert.ok(!PLACEHOLDER.test(fmt.formatLastHit('gemini', hit({ ms: null }), i18n, NOW)), loc);
    }
  });

  test('resume note: no estimate sentence when context is 0 or unknown', () => {
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

  test('resume hint: button label, prompt, terminal command, cost', () => {
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

  test('contextValue, status bar, badge, quota', () => {
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

  test('l10n/views.en.json: English only, correct placeholder syntax, no core key prefixes, no duplicates of core', () => {
    const views = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'views.en.json'), 'utf8'));
    const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'core.en.json'), 'utf8'));
    const corePrefixes = ['lamp', 'status', 'step', 'timeline', 'file', 'quota', 'cost', 'ctx', 'resume', 'dur', 'agent', 'workflow', 'entry', 'provider', 'count', 'tool'];
    for (const [k, v] of Object.entries(views)) {
      assert.strictEqual(typeof v, 'string', k);
      assert.ok(v.trim(), k);
      assert.ok(!corePrefixes.includes(k.split('.')[0]), `${k} uses a core prefix`);
      assert.ok(!(k in core), `${k} duplicates core`);
      for (const m of v.matchAll(/\{([^{}]*)\}/g)) assert.ok(/^\w+$/.test(m[1]), `${k} placeholder syntax {${m[1]}}`);
    }
    assert.ok(!/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(JSON.stringify(views)), 'no CJK characters in the English dictionary');
  });

  test('instances restored with fromPayload in the webview can be formatted too', () => {
    const base = i18nLib.createI18n('ko', { timeZone: 'UTC' });
    const w = i18nLib.fromPayload(JSON.parse(base.webviewJson()), { timeZone: 'UTC' });
    const s = session({ main: agent({ status: st('stale', NOW - 7 * MIN) }) });
    assert.strictEqual(fmt.formatSessionRow(s, w, { now: NOW }).description, fmt.formatSessionRow(s, base, { now: NOW }).description);
    assert.strictEqual(fmt.formatStatus(s.main.status, s.main, w, NOW), fmt.formatStatus(s.main.status, s.main, base, NOW));
  });
}

// ---------- Run ----------

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
