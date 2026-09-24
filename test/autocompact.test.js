'use strict';
// 自动压缩容量设置的测试：lib/autocompact.js、lib/compact-presets.js、l10n/compact.en.json 里的 autocompact.* 键（DESIGN §11.9、§11.12.7）。
// 纯 node 运行：node test/autocompact.test.js
// 绝不读写 ~/.claude、~/.codex，也不运行 claude：设置文件、登记表、config.toml 全是临时目录里的合成品。
// 临时目录取 AGENT_MONITOR_TEST_TMP，没设就用系统临时目录。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const TMP_BASE = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_BASE, { recursive: true });
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(TMP_BASE, 'am-autocompact-')));

// ---------- vscode 桩 ----------

class Emitter {
  constructor() {
    this.fns = [];
    this.event = (fn) => { this.fns.push(fn); return { dispose: () => { this.fns = this.fns.filter((f) => f !== fn); } }; };
  }
  fire(e) { for (const fn of [...this.fns]) fn(e); }
}

const log = { messages: [], executed: [], clipboard: [], opened: [], quickPicks: [], inputs: [], output: [] };
const ui = {};
const commands = new Map();

function resetUi() {
  for (const k of Object.keys(log)) log[k] = [];
  ui.onQuickPick = (qp) => qp.accept(qp.activeItems[0]);
  ui.onShowQuickPick = (items) => items[0];
  ui.onInputBox = (o) => o.value;
  ui.onMessage = () => undefined;
  ui.onExecute = () => { throw new Error('command not found'); };
}

function createQuickPick() {
  const acc = new Emitter();
  const hide = new Emitter();
  const qp = {
    items: [], activeItems: [], selectedItems: [], title: '', placeholder: '', disposed: false,
    onDidAccept: acc.event,
    onDidHide: hide.event,
    show() { log.quickPicks.push(qp); setImmediate(() => ui.onQuickPick(qp)); },
    dispose() { if (!qp.disposed) { qp.disposed = true; hide.fire(); } },
    accept(item) { qp.selectedItems = item ? [item] : []; acc.fire(); },
    find(fn) { return qp.items.find(fn); },
  };
  return qp;
}

function message(kind, msg, rest) {
  let opts = null;
  let items = rest;
  if (rest.length && rest[0] && typeof rest[0] === 'object') { opts = rest[0]; items = rest.slice(1); }
  const rec = { kind, msg, opts, items };
  log.messages.push(rec);
  return Promise.resolve(ui.onMessage(rec));
}

const uri = (s, fsPath) => ({ scheme: String(s).split(':')[0], fsPath, toString: () => String(s) });
const vscode = {
  QuickPickItemKind: { Separator: -1, Default: 0 },
  Uri: { parse: (s) => uri(s), file: (p) => uri('file://' + p, p) },
  env: {
    uriScheme: 'vscode',
    clipboard: { writeText: async (t) => { log.clipboard.push(t); } },
    openExternal: async (u) => { log.opened.push(u.toString()); return true; },
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return { dispose: () => commands.delete(id) }; },
    executeCommand: async (id, ...args) => {
      log.executed.push([id, ...args]);
      if (commands.has(id)) return commands.get(id)(...args);
      if (id === 'vscode.open') return undefined;
      return ui.onExecute(id, args);
    },
  },
  window: {
    createQuickPick,
    showQuickPick: async (items, opts) => { log.quickPicks.push({ items, opts }); return ui.onShowQuickPick(items, opts); },
    showInputBox: async (o) => { log.inputs.push(o); return ui.onInputBox(o); },
    showInformationMessage: (msg, ...rest) => message('info', msg, rest),
    showErrorMessage: (msg, ...rest) => message('error', msg, rest),
    showWarningMessage: (msg, ...rest) => message('warn', msg, rest),
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return origLoad.call(this, request, parent, isMain);
};

const AC = require('../lib/autocompact');
const P = require('../lib/compact-presets');
const i18nLib = require('../lib/i18n');

const i18n = i18nLib.createI18n('en', { timeZone: 'UTC' });
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'compact.en.json'), 'utf8'));
const t = (k, v) => i18n.t(k, v);

// ---------- 小工具 ----------

const tests = [];
const results = [];
function test(name, fn) { tests.push([name, fn]); }

const SID = 'a0c0ffee-0000-4000-8000-000000000001';
const SID2 = 'a0c0ffee-0000-4000-8000-000000000002';
const CODEX_ID = '0c0de000-0000-4000-8000-0000000000bb';
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} ≈ ${b}`);
const mkdirp = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
const read = (p) => fs.readFileSync(p, 'utf8');
// 提示里的路径把主目录缩写成 ~（临时目录一般不在主目录下，这里照同样规则算，免得环境不同就失败）
const shown = (p) => (p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p);
let seq = 0;
const freshDir = (name) => mkdirp(path.join(TMP, `${name}-${++seq}`));

/** 合成的 Claude 会话（字段同 §11.12.2） */
function claudeSession(o = {}) {
  return {
    key: 'claude:' + (o.id || SID), provider: 'claude', id: o.id || SID, title: o.title || 'Synthetic refactor task',
    cwd: o.cwd === undefined ? null : o.cwd, entry: o.entry || 'vscode',
    entrypoint: o.entrypoint === undefined ? 'claude-vscode' : o.entrypoint,
    model: o.model === undefined ? 'claude-opus-5-5' : o.model, modelVariant: o.modelVariant || null,
    live: !!o.live, liveStatus: o.live ? 'idle' : null, cacheTtl: o.cacheTtl || '1h',
    contextUsed: o.contextUsed ?? 300000,
    contextWindow: o.contextWindow === undefined ? 1000000 : o.contextWindow,
    contextWindowSource: 'cost-state',
    compactAt: o.compactAt === undefined ? 967000 : o.compactAt,
    compactAtSource: o.compactAtSource || 'default',
    ...(o.autoCompactWindow != null ? { autoCompactWindow: o.autoCompactWindow } : {}),
    main: { tokens: { contextUsed: o.contextUsed ?? 300000 } }, agents: [], workflows: [],
  };
}

function codexSession(o = {}) {
  return {
    key: 'codex:' + CODEX_ID, provider: 'codex', id: CODEX_ID, title: 'Synthetic codex thread', cwd: '/work/demo',
    entry: 'vscode', entrypoint: null, model: o.model || 'gpt-5.6-sol', live: false, contextUsed: 120000,
    contextWindow: o.contextWindow === undefined ? 258400 : o.contextWindow, contextWindowSource: 'codex-record',
    compactAt: o.compactAt === undefined ? 244800 : o.compactAt, compactAtSource: o.compactAtSource || 'default',
    main: { tokens: { contextUsed: 120000 } }, agents: [], workflows: [],
  };
}

function writeRegistry(home, pid, sid, o = {}) {
  const dir = mkdirp(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId: sid, cwd: '/work/demo', startedAt: Date.now() - 3600e3, version: '2.1.280', kind: 'interactive',
    entrypoint: o.entrypoint || 'claude-vscode', status: 'idle', updatedAt: Date.now(),
  }));
}

/** 一套场景：临时 claudeHome（登记表只有一个死进程条目，说明登记表可用）、项目目录、globalStorage、codexHome */
function scenario(name, o = {}) {
  const dir = freshDir(name);
  const home = mkdirp(path.join(dir, 'claude-home'));
  const cwd = mkdirp(path.join(dir, 'project dir 项目'));
  const storage = mkdirp(path.join(dir, 'global-storage'));
  const codexHome = mkdirp(path.join(dir, 'codex-home'));
  writeRegistry(home, 99999999, 'deadbeef-0000-4000-8000-000000000000');
  if (o.live) writeRegistry(home, process.pid, SID, { entrypoint: o.entrypoint });
  const session = o.session || claudeSession({ cwd, ...(o.sessionOpts || {}) });
  const sessions = new Map([[session.key, session]]);
  const ctx = { globalStorageUri: { fsPath: storage } };
  const deps = {
    getSession: (k) => sessions.get(k) || null,
    getSessions: () => [...sessions.values()],
    i18n,
    claudeHome: home,
    codexHome,
    output: { appendLine: (l) => log.output.push(l) },
    env: o.env || {},
    getSelectedKey: o.selected ? () => o.selected : undefined,
  };
  const handle = AC.activateAutoCompact(ctx, deps);
  return { dir, home, cwd, storage, codexHome, session, sessions, ctx, deps, handle, backups: path.join(storage, AC.BACKUP_DIR) };
}

const byPreset = (id) => (qp) => qp.accept(qp.find((it) => it.action && it.action.type === 'preset' && it.action.id === id));
const byScope = (scope) => (qp) => qp.accept(qp.find((it) => it.action && it.action.scope === scope));
/** 先选档位、再选范围 */
function choose(presetId, scope) {
  ui.onQuickPick = (qp) => {
    if (qp.items.some((it) => it.action && it.action.type === 'scope')) {
      if (scope) byScope(scope)(qp); else qp.accept(qp.activeItems[0]);
    } else byPreset(presetId)(qp);
  };
}
const isSep = (it) => it.kind === -1;
const listBackups = (sc) => (fs.existsSync(sc.backups) ? fs.readdirSync(sc.backups) : []);

// ===========================================================================
// 预设数据与成本模型（§11.9）
// ===========================================================================

test('预设：五档、数值与依据强弱照 §11.9 表', () => {
  assert.deepStrictEqual(P.PRESETS.map((p) => p.id), ['auto', 'coding', 'research', 'long', 'budget']);
  const row = (id) => P.presetById(id);
  assert.deepStrictEqual([row('auto').value1m, row('coding').value1m, row('research').value1m, row('long').value1m, row('budget').value1m],
    [null, 400000, 250000, 600000, 200000]);
  assert.deepStrictEqual(P.PRESETS.map((p) => p.value200k), [null, null, 160000, null, null]);
  assert.deepStrictEqual(P.PRESETS.map((p) => p.codexRatio), [0.9, 0.9, 0.8, 0.9, 0.8]);
  assert.deepStrictEqual(P.PRESETS.map((p) => p.evidence), ['strong', 'medium', 'medium', 'weak', 'medium']);
  assert.strictEqual(P.COMPACT_BUFFER, 33000);
  assert.strictEqual(P.SETTING_MIN, 100000);
  assert.strictEqual(P.SETTING_MAX, 1000000);
  assert.strictEqual(P.GUIDE_URL, 'https://github.com/cyuneo/cyuneo-agent-monitor/blob/main/docs/compaction-threshold-guide.md');
});

test('成本模型：Opus 5.5、1M 窗口复现 §11.9 表的“每次调用 / 相对默认”', () => {
  const opts = AC.presetOptions(claudeSession());
  for (const o of opts) {
    near(o.usdPerCall, o.preset.reference.usdPerCall, 0.0006, `${o.id} usd`);
    near(o.ratio, o.preset.reference.ratio, 0.011, `${o.id} ratio`);
  }
  // 参考说明第 6 节的中间量：967K 一轮 312 次、平均 497K；单次压缩约 $0.83
  const c = AC.costPerCall(967000, AC.ratesFor(claudeSession()));
  assert.strictEqual(c.calls, 312);
  near(c.avgContext, 496500, 1);
  near(c.compactUsd, 0.83, 0.005);
  near(c.compactionsPer100, 0.32, 0.01);
  const c200 = AC.costPerCall(200000, AC.ratesFor(claudeSession()));
  assert.strictEqual(c200.calls, 57);
  near(c200.perCallUsd, 0.055, 0.0006);
});

test('成本模型：按会话模型的价格算（不写死 Opus 5.5）；5 分钟档用 5 分钟写价；没有价格 → 金额为空、频率照算', () => {
  const opus = AC.presetOptions(claudeSession());
  const sonnet = AC.presetOptions(claudeSession({ model: 'claude-sonnet-5' }));
  // Sonnet 5：读 $0.20、1h 写 $4、输出 $10（§6.3），默认档与 Opus 5.5 不同
  const r = AC.ratesFor(claudeSession({ model: 'claude-sonnet-5' }));
  assert.deepStrictEqual([r.read, r.write, r.output], [0.2, 4, 10]);
  assert.notStrictEqual(sonnet[0].usdPerCall.toFixed(4), opus[0].usdPerCall.toFixed(4));
  near(sonnet[0].usdPerCall, AC.costPerCall(967000, r).perCallUsd, 1e-12);
  const r5 = AC.ratesFor(claudeSession({ cacheTtl: '5m' }));
  assert.strictEqual(r5.write, 5, 'Opus 5.5 的 5 分钟缓存写价');
  // [1m] 变体名照样能定价
  assert.ok(AC.ratesFor(claudeSession({ modelVariant: 'claude-opus-5-5[1m]' })));
  const unknown = AC.presetOptions(claudeSession({ model: 'claude-future-9' }));
  for (const o of unknown) assert.strictEqual(o.usdPerCall, null);
  near(unknown.find((o) => o.id === 'coding').freq, 312 / 112, 1e-9);
  const items = AC.buildPresetItems(claudeSession({ model: 'claude-future-9' }), { i18n }).items;
  assert.ok(items.find((it) => it.action && it.action.id === 'coding').detail.startsWith(t('autocompact.cost.unpriced', { model: 'claude-future-9' })));
});

test('选项：1M 窗口 → 设定值、约在哪压缩（设定值 − 33K）、百分比；默认档标“当前”', () => {
  const opts = AC.presetOptions(claudeSession());
  const m = Object.fromEntries(opts.map((o) => [o.id, o]));
  assert.deepStrictEqual([m.auto.value, m.auto.point], [null, 967000]);
  assert.deepStrictEqual([m.coding.value, m.coding.point, m.coding.pct], [400000, 367000, 0.4]);
  assert.deepStrictEqual([m.research.value, m.research.point], [250000, 217000]);
  assert.deepStrictEqual([m.long.value, m.long.point], [600000, 567000]);
  assert.deepStrictEqual([m.budget.value, m.budget.point], [200000, 167000]);
  assert.ok(opts.every((o) => o.available));
  assert.deepStrictEqual(opts.filter((o) => o.current).map((o) => o.id), ['auto']);
  // 用户设置里是 400K（compactAt = 367K）→ “写代码”是当前档
  const cur = AC.presetOptions(claudeSession({ compactAt: 367000, compactAtSource: 'settings-user' }));
  assert.deepStrictEqual(cur.filter((o) => o.current).map((o) => o.id), ['coding']);

  const built = AC.buildPresetItems(claudeSession(), { i18n });
  const coding = built.items.find((it) => it.action && it.action.id === 'coding');
  assert.strictEqual(coding.description, '400K (40%) → ≈ 367K');
  assert.ok(coding.detail.startsWith('≈ $0.069 per call, 45% less than the default'), coding.detail);
  assert.ok(coding.detail.includes(t('autocompact.freq', { n: '2.8' })));
  assert.ok(coding.detail.includes(t('autocompact.evidence', { strength: t('autocompact.evidence.medium'), basis: t('autocompact.preset.coding.basis') })));
  const auto = built.items.find((it) => it.action && it.action.id === 'auto');
  assert.strictEqual(auto.description, 'Not set → ≈ 967K · Current');
  assert.strictEqual(built.active, auto);
  // 每档 detail 末尾都是 §11.9 那句提醒
  for (const it of built.items.filter((x) => x.action && x.action.type === 'preset')) {
    assert.ok(it.detail.endsWith(t('autocompact.reminder')), it.label);
  }
  // 最后两项：自定义、查看参考说明；顶部有官方原话与提醒
  assert.deepStrictEqual(built.items.slice(-2).map((it) => it.action.type), ['custom', 'guide']);
  assert.strictEqual(built.items[0].action.text, t('autocompact.info.official'));
  assert.strictEqual(built.items[1].action.text, t('autocompact.info.reminder'));
  assert.ok(built.placeholder.includes('200K'));
});

test('选项：200K 窗口 → 低于 50% 的档位不可选并说明原因；“长时间自主运行”等于默认也不可选；只有“调研”可设 160K', () => {
  const s = claudeSession({ model: 'claude-sonnet-4-6', contextWindow: 200000, compactAt: 167000, contextUsed: 90000 });
  const m = Object.fromEntries(AC.presetOptions(s).map((o) => [o.id, o]));
  assert.deepStrictEqual([m.auto.available, m.auto.point], [true, 167000]);
  assert.deepStrictEqual([m.coding.available, m.coding.reason], [false, 'below50']);
  assert.deepStrictEqual([m.budget.available, m.budget.reason], [false, 'below50']);
  assert.deepStrictEqual([m.long.available, m.long.reason], [false, 'sameAsDefault']);
  assert.deepStrictEqual([m.research.available, m.research.value, m.research.point, m.research.pct], [true, 160000, 127000, 0.8]);
  // 200K 上调低省得很少：按会话模型价格算，Sonnet 4.6 约 8%；参考说明按 Opus 5.5 价算的约 3%
  near(1 - m.research.ratio, 0.079, 0.005);
  const opusSmall = AC.presetOptions(claudeSession({ contextWindow: 200000, compactAt: 167000 })).find((o) => o.id === 'research');
  near(1 - opusSmall.ratio, 0.03, 0.005);
  const built = AC.buildPresetItems(s, { i18n });
  const coding = built.items.find((it) => it.label.endsWith(t('autocompact.preset.coding.name')));
  assert.ok(coding.label.startsWith('$(circle-slash)'));
  assert.deepStrictEqual(coding.action, { type: 'info', text: t('autocompact.reason.below50') });
  assert.strictEqual(coding.description, t('autocompact.unavailable'));
  const long = built.items.find((it) => it.label.endsWith(t('autocompact.preset.long.name')));
  assert.strictEqual(long.action.text, t('autocompact.reason.sameAsDefault', { at: '167K' }));
  assert.ok(built.items.some((it) => it.action && it.action.text === t('autocompact.info.small', { pct: '8%' })));
  const unpriced = AC.buildPresetItems({ ...s, model: 'claude-future-1' }, { i18n });
  assert.ok(unpriced.items.some((it) => it.action && it.action.text === t('autocompact.info.small.noPrice')));
  assert.strictEqual(unpriced.items.findIndex(isSep), unpriced.items.findIndex((it) => it.action && it.action.text === t('autocompact.info.small.noPrice')) + 1,
    '说明项在分隔线上方');
  // 模型窗口未知时按模型规则推：Haiku 4.5 → 200K
  const h = claudeSession({ model: 'claude-haiku-4-5', contextWindow: null, compactAt: null, contextUsed: 50000 });
  assert.strictEqual(AC.windowOf(h), 200000);
});

test('选项：Codex → 比例 × 完整窗口（258400 / 0.95 = 272000）；0.9 档同默认，0.8 档 217600', () => {
  const s = codexSession();
  assert.strictEqual(AC.codexFullWindow(s), 272000);
  const m = Object.fromEntries(AC.presetOptions(s).map((o) => [o.id, o]));
  assert.deepStrictEqual([m.auto.value, m.auto.point], [null, 244800]);
  assert.deepStrictEqual([m.coding.value, m.coding.sameAsDefault, m.long.value], [null, true, null]);
  assert.deepStrictEqual([m.research.value, m.budget.value], [217600, 217600]);
  assert.ok(m.research.ratio < 1 && m.research.ratio > 0.85, '粗算只省约 7%');
  const built = AC.buildPresetItems(s, { i18n });
  assert.strictEqual(built.items.find((it) => it.action && it.action.id === 'research').description, '80% → ≈ 217.6K');
  assert.strictEqual(built.items.find((it) => it.action && it.action.id === 'coding').description, '90% → ≈ 244.8K (default)');
  assert.ok(built.items.find((it) => it.action && it.action.id === 'research').detail.endsWith(t('autocompact.reminder.codex')));
  assert.ok(!built.items.some((it) => it.action && it.action.type === 'info'), 'Codex 没有 Claude 的说明项');
  // 没有记录时按默认 272K
  assert.strictEqual(AC.codexFullWindow(codexSession({ contextWindow: null })), 272000);
});

test('当前设置：Codex 有来源就以来源为准（default 且压缩点偏小也不算 config.toml）', () => {
  const base = { provider: 'codex', contextWindow: 272000, main: { tokens: {} } };
  assert.strictEqual(AC.currentSetting({ ...base, compactAt: 232560, compactAtSource: 'default' }).source, 'codexDefault');
  assert.strictEqual(AC.currentSetting({ ...base, compactAt: 200000, compactAtSource: 'settings-user' }).source, 'codexConfig');
  // 来源缺失时才按“比默认点小”推断
  assert.strictEqual(AC.currentSetting({ ...base, compactAt: 200000, compactAtSource: null }).source, 'codexConfig');
});

// ===========================================================================
// 输入解析
// ===========================================================================

test('自定义输入：300k / 300K / 300000 / 300（简写）/ 1m / 0.5m / 300,000 / auto；范围 100K–1M', () => {
  const v = (s) => AC.parseWindowInput(s);
  assert.deepStrictEqual(v('300k'), { value: 300000 });
  assert.deepStrictEqual(v(' 300K '), { value: 300000 });
  assert.deepStrictEqual(v('300000'), { value: 300000 });
  assert.deepStrictEqual(v('300'), { value: 300000 });
  assert.deepStrictEqual(v('100'), { value: 100000 });
  assert.deepStrictEqual(v('1000'), { value: 1000000 }, '与 Claude Code 一致：100–1000 是 K 的简写');
  assert.deepStrictEqual(v('1m'), { value: 1000000 });
  assert.deepStrictEqual(v('1M'), { value: 1000000 });
  assert.deepStrictEqual(v('0.5m'), { value: 500000 });
  assert.deepStrictEqual(v('250.5k'), { value: 250500 });
  assert.deepStrictEqual(v('300,000'), { value: 300000 });
  assert.deepStrictEqual(v('AUTO'), { value: 'auto' });
  assert.strictEqual(v('99k').error, 'range');
  assert.strictEqual(v('99999').error, 'range');
  assert.strictEqual(v('1001k').error, 'range');
  assert.strictEqual(v('2m').error, 'range');
  assert.strictEqual(v('50').error, 'range', '100 以下不是简写');
  assert.strictEqual(v('abc').error, 'format');
  assert.strictEqual(v('300kb').error, 'format');
  assert.strictEqual(v('-300k').error, 'format');
  assert.strictEqual(v('').error, 'empty');
  assert.strictEqual(v(null).error, 'empty');
  assert.strictEqual(AC.autocompactArg(400000), '400k');
  assert.strictEqual(AC.autocompactArg(1000000), '1000k');
  assert.strictEqual(AC.autocompactArg(250500), '250500');
  assert.strictEqual(AC.autocompactArg(null), 'auto');
  // 生成的参数再解析回来是同一个值
  for (const n of [100000, 160000, 250500, 400000, 1000000]) assert.deepStrictEqual(v(AC.autocompactArg(n)), { value: n });
});

// ===========================================================================
// JSON 编辑：只改一个键、保留缩进与键顺序
// ===========================================================================

const SAMPLE = [
  '{',
  '  "model": "opus",',
  '  "permissions": {',
  '    "allow": ["Bash(git status)", "Read(**/{a,b}.json)"],',
  '    "deny": []',
  '  },',
  '  "note": "braces } and \\" quotes, autoCompactWindow inside a string",',
  '  "autoCompactWindow": 500000,',
  '  "statusLine": { "type": "command", "command": "echo \\"hi\\"" }',
  '}',
  '',
].join('\n');

test('JSON：已有键 → 只替换数值，其余字节完全不变', () => {
  const r = AC.editSettingsText(SAMPLE, 400000);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.text, SAMPLE.replace('"autoCompactWindow": 500000', '"autoCompactWindow": 400000'));
  assert.deepStrictEqual(Object.keys(JSON.parse(r.text)), ['model', 'permissions', 'note', 'autoCompactWindow', 'statusLine']);
  // 值相同 → 不改
  assert.deepStrictEqual(AC.editSettingsText(SAMPLE, 500000), { text: SAMPLE, changed: false, existed: true });
});

test('JSON：没有这个键 → 按原缩进追加在最后一个成员后面（2 空格、4 空格、Tab、CRLF、单行、空对象、BOM）', () => {
  const two = '{\n  "a": 1,\n  "b": {\n    "c": [1, 2]\n  }\n}\n';
  assert.strictEqual(AC.editSettingsText(two, 300000).text, '{\n  "a": 1,\n  "b": {\n    "c": [1, 2]\n  },\n  "autoCompactWindow": 300000\n}\n');
  const four = '{\n    "a": 1,\n    "b": 2\n}';
  assert.strictEqual(AC.editSettingsText(four, 300000).text, '{\n    "a": 1,\n    "b": 2,\n    "autoCompactWindow": 300000\n}');
  const tab = '{\n\t"a": true\n}\n';
  assert.strictEqual(AC.editSettingsText(tab, 300000).text, '{\n\t"a": true,\n\t"autoCompactWindow": 300000\n}\n');
  const crlf = '{\r\n  "a": 1\r\n}\r\n';
  assert.strictEqual(AC.editSettingsText(crlf, 300000).text, '{\r\n  "a": 1,\r\n  "autoCompactWindow": 300000\r\n}\r\n');
  assert.strictEqual(AC.editSettingsText('{"a":1,"b":"x"}', 300000).text, '{"a":1,"b":"x","autoCompactWindow":300000}');
  assert.strictEqual(AC.editSettingsText('{ "a": 1 }', 300000).text, '{ "a": 1, "autoCompactWindow": 300000 }');
  assert.strictEqual(AC.editSettingsText('{}\n', 300000).text, '{\n  "autoCompactWindow": 300000\n}\n');
  assert.strictEqual(AC.editSettingsText('﻿{\n  "a": 1\n}\n', 300000).text, '﻿{\n  "a": 1,\n  "autoCompactWindow": 300000\n}\n');
  assert.strictEqual(AC.editSettingsText('', 300000).text, '{\n  "autoCompactWindow": 300000\n}\n', '空文件当作 {}');
  assert.strictEqual(AC.editSettingsText('  \n', null).changed, false);
});

test('JSON：auto → 删除该键（首个、中间、最后、唯一、重复），其余不变', () => {
  assert.strictEqual(AC.editSettingsText(SAMPLE, null).text, SAMPLE.replace('  "autoCompactWindow": 500000,\n', ''));
  assert.strictEqual(AC.editSettingsText('{\n  "autoCompactWindow": 1,\n  "b": 2\n}\n', null).text, '{\n  "b": 2\n}\n');
  assert.strictEqual(AC.editSettingsText('{\n  "a": 1,\n  "autoCompactWindow": 3\n}\n', null).text, '{\n  "a": 1\n}\n');
  assert.strictEqual(AC.editSettingsText('{\n  "autoCompactWindow": 3\n}\n', null).text, '{}\n');
  assert.strictEqual(AC.editSettingsText('{"a":1,"autoCompactWindow":2,"b":3,"autoCompactWindow":4}', null).text, '{"a":1,"b":3}');
  assert.strictEqual(AC.editSettingsText('{"autoCompactWindow":2,"autoCompactWindow":2}', 300000).text, '{"autoCompactWindow":300000,"autoCompactWindow":300000}');
  // 没有这个键 → 不改
  assert.deepStrictEqual(AC.editSettingsText('{"a":1}', null), { text: '{"a":1}', changed: false, existed: false });
  // 嵌套对象里的同名键不算
  const nested = '{\n  "env": { "autoCompactWindow": 1 }\n}\n';
  assert.strictEqual(AC.editSettingsText(nested, null).changed, false);
  assert.strictEqual(AC.editSettingsText(nested, 300000).text, '{\n  "env": { "autoCompactWindow": 1 },\n  "autoCompactWindow": 300000\n}\n');
});

test('JSON：解析失败、顶层不是对象 → 报错，不给新文本', () => {
  assert.strictEqual(AC.editSettingsText('{ "a": 1, }', 300000).error, 'parse');
  assert.strictEqual(AC.editSettingsText('// comment\n{}', 300000).error, 'parse');
  assert.strictEqual(AC.editSettingsText('[1, 2]', 300000).error, 'notObject');
  assert.strictEqual(AC.editSettingsText('null', null).error, 'notObject');
});

test('JSON：随机成员顺序、各种值 → 结果只差这一个键，键顺序不变', () => {
  const vals = [1, -2.5e3, 'str "q" }', true, false, null, [1, { x: '}' }], { deep: { k: ['a', 'b'] } }, ''];
  for (let n = 0; n < 60; n++) {
    const obj = {};
    const count = (n % 6) + 1;
    for (let i = 0; i < count; i++) obj['k' + ((n * 7 + i * 13) % 17) + '_' + i] = vals[(n + i) % vals.length];
    if (n % 3 === 0) obj.autoCompactWindow = 700000;
    const indent = [2, 4, '\t', 0][n % 4];
    const text = JSON.stringify(obj, null, indent) + (n % 2 ? '\n' : '');
    for (const value of [null, 250000]) {
      const r = AC.editSettingsText(text, value);
      const out = JSON.parse(r.text);
      const expected = { ...obj };
      if (value == null) delete expected.autoCompactWindow; else expected.autoCompactWindow = value;
      assert.deepStrictEqual(out, expected);
      assert.deepStrictEqual(Object.keys(out), Object.keys(expected), `顺序 ${n}`);
      if (indent) assert.ok(!r.text.includes('\n') || r.text.split('\n')[1].startsWith(indent === '\t' ? '\t' : ' '.repeat(indent)) || Object.keys(expected).length === 0, `缩进 ${n}`);
    }
  }
});

// ===========================================================================
// 写文件：备份、坏 JSON 不写、auto 删键、新建 .claude/、软链接
// ===========================================================================

test('写文件：只改一个键、其它键与缩进不变；先写备份（内容是原文）', () => {
  const dir = freshDir('write');
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, SAMPLE);
  const backups = path.join(dir, 'backups');
  const r = AC.writeAutoCompactSetting({ file, value: 400000, backupDir: backups, now: Date.parse('2026-09-24T10:00:00Z') });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.changed, r.created, r.existed], [true, false, true]);
  assert.strictEqual(read(file), SAMPLE.replace('500000', '400000'));
  assert.ok(r.backup && fs.existsSync(r.backup));
  assert.strictEqual(read(r.backup), SAMPLE);
  assert.ok(path.basename(r.backup).startsWith('2026-09-24T10-00-00-000Z-'));
  assert.ok(path.basename(r.backup).endsWith('-settings.json'));
  // 没有临时文件残留
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['backups', 'settings.json']);
  // 值相同 → 不写、不备份
  const r2 = AC.writeAutoCompactSetting({ file, value: 400000, backupDir: backups });
  assert.deepStrictEqual([r2.ok, r2.changed, r2.backup], [true, false, null]);
  assert.strictEqual(fs.readdirSync(backups).length, 1);
});

test('写文件：JSON 解析失败 → 不写、不备份、报 parse', () => {
  const dir = freshDir('badjson');
  const file = path.join(dir, 'settings.json');
  const bad = '{\n  "model": "opus",\n}\n';
  fs.writeFileSync(file, bad);
  const r = AC.writeAutoCompactSetting({ file, value: 400000, backupDir: path.join(dir, 'b') });
  assert.deepStrictEqual([r.ok, r.error], [false, 'parse']);
  assert.strictEqual(read(file), bad);
  assert.ok(!fs.existsSync(path.join(dir, 'b')));
});

test('写文件：auto 删键；文件不存在时 auto 什么都不做；设值时新建 .claude/ 和文件', () => {
  const dir = freshDir('auto');
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{\n  "model": "opus",\n  "autoCompactWindow": 300000\n}\n');
  const r = AC.writeAutoCompactSetting({ file, value: null, backupDir: path.join(dir, 'b') });
  assert.deepStrictEqual([r.ok, r.changed], [true, true]);
  assert.strictEqual(read(file), '{\n  "model": "opus"\n}\n');
  const proj = path.join(dir, 'proj');
  mkdirp(proj);
  const local = path.join(proj, '.claude', 'settings.local.json');
  const r0 = AC.writeAutoCompactSetting({ file: local, value: null, backupDir: path.join(dir, 'b') });
  assert.deepStrictEqual([r0.ok, r0.changed], [true, false]);
  assert.ok(!fs.existsSync(path.join(proj, '.claude')), 'auto 不新建目录');
  const r1 = AC.writeAutoCompactSetting({ file: local, value: 160000, backupDir: path.join(dir, 'b') });
  assert.deepStrictEqual([r1.ok, r1.changed, r1.created, r1.backup], [true, true, true, null]);
  assert.deepStrictEqual(JSON.parse(read(local)), { autoCompactWindow: 160000 });
});

test('写文件：取值范围 100000–1000000 之外、没有备份目录 → 不写', () => {
  const dir = freshDir('range');
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{}\n');
  for (const v of [99999, 1000001, 3.5, NaN]) {
    const r = AC.writeAutoCompactSetting({ file, value: v, backupDir: path.join(dir, 'b') });
    assert.strictEqual(r.ok, false, String(v));
  }
  const r = AC.writeAutoCompactSetting({ file, value: 300000, backupDir: null });
  assert.deepStrictEqual([r.ok, r.error], [false, 'backup']);
  assert.strictEqual(read(file), '{}\n');
});

test('写文件：settings.json 是软链接 → 写到它指向的真实文件，链接保留；备份留最新 30 份', () => {
  const dir = freshDir('symlink');
  const real = path.join(dir, 'dotfiles', 'claude-settings.json');
  mkdirp(path.dirname(real));
  fs.writeFileSync(real, '{\n  "a": 1\n}\n');
  const link = path.join(dir, 'settings.json');
  fs.symlinkSync(real, link);
  const backups = path.join(dir, 'b');
  const r = AC.writeAutoCompactSetting({ file: link, value: 300000, backupDir: backups });
  assert.strictEqual(r.ok, true);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepStrictEqual(JSON.parse(read(real)), { a: 1, autoCompactWindow: 300000 });
  for (let i = 0; i < 35; i++) {
    AC.writeAutoCompactSetting({ file: link, value: 200000 + i * 1000, backupDir: backups, now: Date.parse('2026-09-24T10:00:00Z') + i * 1000 });
  }
  assert.strictEqual(fs.readdirSync(backups).length, AC.BACKUP_KEEP);
});

// ===========================================================================
// describeCompactSetting（agents-view / tree 用）
// ===========================================================================

test('describeCompactSetting：用户设置 400K / 默认 / 实测 / 关闭 / 项目本地（200K 封顶）/ 环境变量 / Codex', () => {
  const d1 = AC.describeCompactSetting(claudeSession({ compactAt: 367000, compactAtSource: 'settings-user' }), i18n);
  assert.deepStrictEqual([d1.valueText, d1.effectiveText, d1.sourceText], ['400K (40%)', '≈ 367K', 'Source: user settings']);
  assert.strictEqual(d1.text, '400K (40%) → ≈ 367K · Source: user settings');
  assert.strictEqual(d1.value, 400000);
  assert.strictEqual(d1.tooltip, t('autocompact.tooltip'));
  // providers 直接给原始设定值时优先用它
  const d1b = AC.describeCompactSetting(claudeSession({ compactAt: 367000, compactAtSource: 'settings-user', autoCompactWindow: 400000 }), i18n);
  assert.strictEqual(d1b.value, 400000);

  assert.strictEqual(AC.describeCompactSetting(claudeSession(), i18n).text, 'Auto → ≈ 967K · Source: Claude Code default');
  assert.strictEqual(AC.describeCompactSetting(claudeSession({ compactAt: 955000, compactAtSource: 'observed' }), i18n).text,
    'Auto → ≈ 955K (measured) · Source: measured in your sessions');
  const off = AC.describeCompactSetting(claudeSession({ compactAt: null, compactAtSource: 'disabled' }), i18n);
  assert.deepStrictEqual([off.off, off.text], [true, 'Off · Source: autoCompactEnabled: false']);
  const small = claudeSession({ model: 'claude-sonnet-4-6', contextWindow: 200000, compactAt: 127000, compactAtSource: 'settings-local' });
  assert.strictEqual(AC.describeCompactSetting(small, i18n).text, '160K (80%) → ≈ 127K · Source: project local settings');
  const capped = claudeSession({ model: 'claude-sonnet-4-6', contextWindow: 200000, compactAt: 167000, compactAtSource: 'settings-user', autoCompactWindow: 400000 });
  assert.strictEqual(AC.describeCompactSetting(capped, i18n).valueText, '400K (capped at 200K)');
  assert.strictEqual(AC.describeCompactSetting(claudeSession({ compactAt: 467000, compactAtSource: 'env' }), i18n).sourceText,
    'Source: CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  // 来源缺失、compactAt 缺失：按窗口推默认
  assert.strictEqual(AC.describeCompactSetting(claudeSession({ compactAt: null, compactAtSource: null }), i18n).effectiveText, '≈ 967K');
  // 设置来源在 main.tokens 上也认
  const onMain = claudeSession({ compactAt: null, compactAtSource: 'settings-project' });
  onMain.main.tokens.compactAt = 267000;
  assert.strictEqual(AC.describeCompactSetting(onMain, i18n).valueText, '300K (30%)');

  assert.strictEqual(AC.describeCompactSetting(codexSession(), i18n).text, '244.8K (90%) · Source: Codex default');
  assert.strictEqual(AC.describeCompactSetting(codexSession({ compactAt: 217600, compactAtSource: 'settings-user' }), i18n).text,
    '217.6K (80%) · Source: config.toml');
  assert.strictEqual(AC.describeCompactSetting(codexSession(), i18n).tooltip, t('autocompact.tooltip.codex'));
  // 没传 i18n → 英文
  assert.strictEqual(AC.describeCompactSetting(claudeSession()).valueText, 'Auto');
  // 其它语言：词典还没翻译时回退英文，不出现键名
  for (const loc of ['zh-cn', 'zh-tw', 'ko', 'ja']) {
    const d = AC.describeCompactSetting(claudeSession({ compactAt: 367000, compactAtSource: 'settings-user' }), i18nLib.createI18n(loc));
    assert.ok(!/autocompact\./.test(d.text + d.tooltip), loc);
  }
});

// ===========================================================================
// 命令流程（vscode 桩）
// ===========================================================================

test('流程：会话打开中 + 所有项目 → 预填 /autocompact 400k（claude-vscode.editor.open）并复制，不写任何文件', async () => {
  resetUi();
  const sc = scenario('live-all', { live: true });
  ui.onExecute = () => undefined;
  choose('coding', 'all');
  try {
    await vscode.commands.executeCommand(AC.CMD, { key: sc.session.key });
    const [pickQp, scopeQp] = log.quickPicks;
    assert.ok(pickQp.title.includes('Synthetic refactor task'));
    assert.ok(scopeQp.title.includes('400K (40%)'));
    assert.strictEqual(scopeQp.find((it) => it.action && it.action.scope === 'all').detail,
      t('autocompact.scope.all.live', { command: '/autocompact 400k' }));
    assert.deepStrictEqual(log.executed.find((e) => e[0] === 'claude-vscode.editor.open'), ['claude-vscode.editor.open', SID, '/autocompact 400k']);
    assert.deepStrictEqual(log.clipboard, ['/autocompact 400k']);
    const m = log.messages.pop();
    assert.strictEqual(m.msg, `${t('compact.deliver.opened')} ${t('autocompact.prefill.after')}`);
    assert.ok(!fs.existsSync(path.join(sc.home, 'settings.json')));
    assert.ok(!fs.existsSync(path.join(sc.cwd, '.claude')));
  } finally { sc.handle.dispose(); }
});

test('流程：预填失败（Claude 扩展命令不存在）→ 剪贴板退路；终端入口 → 只复制并提示去那个窗口', async () => {
  resetUi();
  const sc = scenario('live-fallback', { live: true });
  choose('research', 'all');
  try {
    await sc.handle.run(sc.session.key);
    assert.ok(log.executed.some((e) => e[0] === 'claude-vscode.editor.open'));
    assert.deepStrictEqual(log.clipboard, ['/autocompact 250k']);
    assert.strictEqual(log.messages.pop().msg, `${t('compact.deliver.copied')} ${t('autocompact.prefill.after')}`);
  } finally { sc.handle.dispose(); }

  resetUi();
  const sc2 = scenario('live-cli', { live: true, entrypoint: 'cli', sessionOpts: { entry: 'cli', entrypoint: 'cli' } });
  choose('long', 'all');
  try {
    await sc2.handle.run(sc2.session.key);
    assert.ok(!log.executed.some((e) => e[0] === 'claude-vscode.editor.open'));
    assert.deepStrictEqual(log.clipboard, ['/autocompact 600k']);
    assert.ok(log.messages.pop().msg.startsWith(t('compact.deliver.copiedOther', { where: t('entry.cli') })));
  } finally { sc2.handle.dispose(); }
});

test('流程：会话没打开 + 所有项目 → 插件写 ~/.claude/settings.json（只改一个键），备份在 globalStorage', async () => {
  resetUi();
  const sc = scenario('closed-all');
  const user = path.join(sc.home, 'settings.json');
  fs.writeFileSync(user, SAMPLE);
  choose('coding', 'all');
  ui.onMessage = (rec) => (rec.items.includes(t('autocompact.openFile')) ? t('autocompact.openFile') : undefined);
  try {
    await sc.handle.run(sc.session.key);
    const scopeQp = log.quickPicks[1];
    assert.ok(scopeQp.find((it) => it.action && it.action.scope === 'all').detail.includes('settings.json'));
    assert.strictEqual(read(user), SAMPLE.replace('500000', '400000'));
    const backups = listBackups(sc);
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(read(path.join(sc.backups, backups[0])), SAMPLE);
    const m = log.messages.pop();
    assert.ok(m.msg.startsWith(t('autocompact.done.set', { path: shown(user), value: '400K (40%)' })), m.msg);
    assert.ok(m.msg.includes(t('autocompact.done.reopenUser')));
    assert.ok(log.executed.some((e) => e[0] === 'vscode.open' && e[1].fsPath === user), '“打开文件”按钮');
    assert.ok(!log.executed.some((e) => e[0] === 'claude-vscode.editor.open'));
    assert.deepStrictEqual(log.clipboard, []);
  } finally { sc.handle.dispose(); }
});

test('流程：仅这个项目 → 新建 <cwd>/.claude/settings.local.json；提示“新开的会话生效；已打开的会话需要重开”', async () => {
  resetUi();
  const sc = scenario('project', { live: true });
  choose('research', 'project');
  try {
    await sc.handle.run(sc.session.key);
    const local = path.join(sc.cwd, '.claude', 'settings.local.json');
    assert.deepStrictEqual(JSON.parse(read(local)), { autoCompactWindow: 250000 });
    const m = log.messages.pop();
    assert.strictEqual(m.msg, `${t('autocompact.done.created', { path: shown(local), value: '250K (25%)' })} ${t('autocompact.done.reopen')}`);
    assert.ok(!log.executed.some((e) => e[0] === 'claude-vscode.editor.open'), '项目范围不预填');
    assert.ok(!fs.existsSync(path.join(sc.home, 'settings.json')), '用户设置不动');
  } finally { sc.handle.dispose(); }
});

test('流程：保持默认 + 仅这个项目 → 删除键，其它键保留；再做一次提示“没有可删的”', async () => {
  resetUi();
  const sc = scenario('project-auto');
  const local = path.join(mkdirp(path.join(sc.cwd, '.claude')), 'settings.local.json');
  fs.writeFileSync(local, '{\n  "permissions": { "allow": [] },\n  "autoCompactWindow": 250000\n}\n');
  choose('auto', 'project');
  try {
    await sc.handle.run(sc.session.key);
    assert.strictEqual(read(local), '{\n  "permissions": { "allow": [] }\n}\n');
    assert.ok(log.messages.pop().msg.startsWith(t('autocompact.done.removed', { path: shown(local) })));
    assert.strictEqual(listBackups(sc).length, 1);
    await sc.handle.run(sc.session.key);
    assert.strictEqual(log.messages.pop().msg, t('autocompact.done.nothingToRemove', { path: shown(local) }));
  } finally { sc.handle.dispose(); }
});

test('流程：用户设置是坏 JSON → 报错（可打开文件），文件不变、不备份', async () => {
  resetUi();
  const sc = scenario('bad-user');
  const user = path.join(sc.home, 'settings.json');
  const bad = '{ "model": "opus", }';
  fs.writeFileSync(user, bad);
  choose('budget', 'all');
  try {
    await sc.handle.run(sc.session.key);
    const m = log.messages.pop();
    assert.strictEqual(m.kind, 'error');
    assert.strictEqual(m.msg, t('autocompact.error.parse', { path: shown(user), message: '' }));
    assert.deepStrictEqual(m.items, [t('autocompact.openFile')]);
    assert.strictEqual(read(user), bad);
    assert.deepStrictEqual(listBackups(sc), []);
  } finally { sc.handle.dispose(); }
});

test('流程：自定义… → InputBox 校验（格式、范围），“300” 按 300K 写入', async () => {
  resetUi();
  const sc = scenario('custom');
  ui.onQuickPick = (qp) => {
    if (qp.items.some((it) => it.action && it.action.type === 'scope')) byScope('all')(qp);
    else qp.accept(qp.find((it) => it.action && it.action.type === 'custom'));
  };
  let box;
  ui.onInputBox = (o) => { box = o; return '300'; };
  try {
    await sc.handle.run(sc.session.key);
    assert.strictEqual(box.validateInput('300k'), null);
    assert.strictEqual(box.validateInput('auto'), null);
    assert.strictEqual(box.validateInput('12'), t('autocompact.input.range'));
    assert.strictEqual(box.validateInput('2m'), t('autocompact.input.range'));
    assert.strictEqual(box.validateInput('lots'), t('autocompact.input.format'));
    assert.strictEqual(box.value, '', '当前是 auto，输入框为空');
    assert.deepStrictEqual(JSON.parse(read(path.join(sc.home, 'settings.json'))), { autoCompactWindow: 300000 });
  } finally { sc.handle.dispose(); }
});

test('流程：查看参考说明 → openExternal 打开 GitHub 上的参考说明，不写文件', async () => {
  resetUi();
  const sc = scenario('guide');
  ui.onQuickPick = (qp) => qp.accept(qp.find((it) => it.action && it.action.type === 'guide'));
  try {
    await sc.handle.run(sc.session.key);
    assert.deepStrictEqual(log.opened, [P.GUIDE_URL]);
    assert.strictEqual(log.quickPicks.length, 1);
    assert.ok(!fs.existsSync(path.join(sc.home, 'settings.json')));
  } finally { sc.handle.dispose(); }
});

test('流程：200K 模型选不可用的档位 → 只弹原因，QuickPick 不关；再选“调研”写 160K', async () => {
  resetUi();
  const sc = scenario('small', { sessionOpts: { model: 'claude-sonnet-4-6', contextWindow: 200000, compactAt: 167000 } });
  ui.onQuickPick = (qp) => {
    if (qp.items.some((it) => it.action && it.action.type === 'scope')) { byScope('all')(qp); return; }
    qp.accept(qp.find((it) => it.label.endsWith(t('autocompact.preset.budget.name'))));
    assert.strictEqual(qp.disposed, false);
    byPreset('research')(qp);
  };
  try {
    await sc.handle.run(sc.session.key);
    assert.strictEqual(log.messages[0].msg, t('autocompact.reason.below50'));
    assert.deepStrictEqual(JSON.parse(read(path.join(sc.home, 'settings.json'))), { autoCompactWindow: 160000 });
  } finally { sc.handle.dispose(); }
});

test('流程：Codex → 复制 model_auto_compact_token_limit 行并打开 config.toml（不改文件）；已有该行提示替换；默认档不复制', async () => {
  resetUi();
  const cx = codexSession();
  const sc = scenario('codex', { session: cx });
  const toml = path.join(sc.codexHome, 'config.toml');
  const original = 'model = "gpt-5.6-sol"\n\n[profiles.fast]\nmodel = "gpt-5.6-luna"\n';
  fs.writeFileSync(toml, original);
  choose('research');
  try {
    await sc.handle.run(cx.key);
    assert.strictEqual(log.quickPicks.length, 1, 'Codex 不选范围');
    assert.deepStrictEqual(log.clipboard, ['model_auto_compact_token_limit = 217600']);
    assert.ok(log.executed.some((e) => e[0] === 'vscode.open' && e[1].fsPath === toml));
    assert.strictEqual(log.messages.pop().msg, t('autocompact.codex.copied', { line: 'model_auto_compact_token_limit = 217600', path: shown(toml) }));
    assert.strictEqual(read(toml), original, 'config.toml 不改');

    resetUi();
    fs.writeFileSync(toml, 'model_auto_compact_token_limit = 200000\n' + original);
    choose('budget');
    await sc.handle.run(cx.key);
    assert.strictEqual(log.messages.pop().msg, t('autocompact.codex.replace', { line: 'model_auto_compact_token_limit = 217600', path: shown(toml), old: 200000 }));

    resetUi();
    choose('coding'); // 0.9 = 默认
    await sc.handle.run(cx.key);
    assert.deepStrictEqual(log.clipboard, []);
    assert.strictEqual(log.messages.pop().msg, t('autocompact.codex.remove', { path: shown(toml), old: 200000 }));

    resetUi();
    fs.rmSync(toml);
    choose('research');
    await sc.handle.run(cx.key);
    assert.deepStrictEqual(log.clipboard, ['model_auto_compact_token_limit = 217600']);
    assert.strictEqual(log.messages.pop().msg, t('autocompact.codex.missing', { line: 'model_auto_compact_token_limit = 217600', path: shown(toml) }));
    assert.ok(!fs.existsSync(toml), '不替用户新建 config.toml');
  } finally { sc.handle.dispose(); }
});

test('流程：没有参数 → 先选会话（当前选中的排第一）；会话不在列表 → 报错', async () => {
  resetUi();
  const sc = scenario('pick', { selected: 'codex:' + CODEX_ID });
  const cx = codexSession();
  sc.sessions.set(cx.key, cx);
  ui.onShowQuickPick = () => undefined;
  try {
    await sc.handle.run();
    const q = log.quickPicks[0];
    assert.strictEqual(q.opts.placeHolder, t('autocompact.pickSession'));
    assert.deepStrictEqual(q.items.map((it) => it.key), [cx.key, sc.session.key]);
    assert.ok(q.items[1].description.includes('Auto'));
    await sc.handle.run('claude:' + SID2);
    assert.strictEqual(log.messages.pop().msg, t('autocompact.error.noSession'));
  } finally { sc.handle.dispose(); }
});

test('流程：会话目录不存在 → “仅这个项目”不可选（只弹原因）；设了环境变量 → 提示它优先', async () => {
  resetUi();
  const sc = scenario('nocwd', { sessionOpts: { cwd: '/nonexistent/am-autocompact' }, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' } });
  let scopeItems = null;
  ui.onQuickPick = (qp) => {
    if (qp.items.some((it) => it.action && it.action.type === 'scope')) {
      scopeItems = qp.items;
      const proj = qp.items.find((it) => it.label.includes(t('autocompact.scope.project')));
      qp.accept(proj);
      assert.strictEqual(qp.disposed, false);
      byScope('all')(qp);
      return;
    }
    assert.ok(qp.items.some((it) => it.action && it.action.text === t('autocompact.info.env')));
    byPreset('coding')(qp);
  };
  try {
    await sc.handle.run(sc.session.key);
    assert.ok(scopeItems.find((it) => it.label.includes(t('autocompact.scope.project'))).label.startsWith('$(circle-slash)'));
    assert.strictEqual(log.messages[0].msg, t('autocompact.scope.project.noCwd'));
    assert.ok(log.messages.pop().msg.includes(t('autocompact.note.env')));
  } finally { sc.handle.dispose(); }
});

test('流程：写用户设置时项目里另有值 → 提示项目的值优先', async () => {
  resetUi();
  const sc = scenario('override');
  const proj = path.join(mkdirp(path.join(sc.cwd, '.claude')), 'settings.json');
  fs.writeFileSync(proj, '{ "autoCompactWindow": 300000 }\n');
  choose('long', 'all');
  try {
    await sc.handle.run(sc.session.key);
    assert.ok(log.messages.pop().msg.includes(t('autocompact.note.project', { path: shown(proj) })));
    assert.strictEqual(read(proj), '{ "autoCompactWindow": 300000 }\n', '项目文件不动');
  } finally { sc.handle.dispose(); }
});

test('项目范围：会话开在 Claude 数据目录的上一级（主目录）→ 不可用', () => {
  const dir = freshDir('home');
  const home = mkdirp(path.join(dir, '.claude'));
  assert.deepStrictEqual(AC.projectSettingsFile({ cwd: dir }, home), { file: null, reason: 'home' });
  assert.deepStrictEqual(AC.projectSettingsFile({ cwd: null }, home), { file: null, reason: 'noCwd' });
  const other = mkdirp(path.join(dir, 'proj'));
  assert.strictEqual(AC.projectSettingsFile({ cwd: other }, home).file, path.join(other, '.claude', 'settings.local.json'));
});

// ===========================================================================
// 词典与安全
// ===========================================================================

test('词典：autocompact.* 键只在英文词典里写英文；占位符都是 {word}；预设与来源的键齐全', () => {
  const keys = Object.keys(EN).filter((k) => k.startsWith('autocompact.'));
  assert.ok(keys.length > 80);
  for (const k of keys) {
    assert.ok(!/[぀-ヿ㐀-鿿가-힯]/.test(EN[k]), `CJK in ${k}`);
    for (const m of EN[k].matchAll(/\{([^{}]*)\}/g)) assert.ok(/^\w+$/.test(m[1]), `${k} 占位符 {${m[1]}}`);
  }
  for (const p of P.PRESETS) for (const k of [p.nameKey, p.summaryKey, p.basisKey]) assert.ok(k in EN, k);
  for (const k of Object.values(P.EVIDENCE_KEYS)) assert.ok(k in EN, k);
  for (const k of Object.values(AC.SOURCE_KEYS)) assert.ok(k in EN, k);
  // 官方原话原样保留
  assert.ok(EN['autocompact.info.official'].includes('Overriding auto may result in high token usage, especially when resuming long sessions.'));
});

test('安全：autocompact.js 不起子进程、不联网、不读 *.key', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'autocompact.js'), 'utf8');
  assert.ok(!/require\(['"](child_process|http|https|net|tls|dns)['"]\)/.test(src));
  assert.ok(!/\bfetch\(|WebSocket/.test(src));
  assert.ok(!/\.key\b['"]/.test(src));
  const presets = fs.readFileSync(path.join(ROOT, 'lib', 'compact-presets.js'), 'utf8');
  assert.ok(!/require\(/.test(presets), 'compact-presets.js 只有数据');
});

// ---------- 运行 ----------

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      results.push(true);
      console.log(`  ok    ${name}`);
    } catch (err) {
      results.push(false);
      console.log(`  FAIL  ${name}\n        ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n        ')}`);
    }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exitCode = passed === results.length ? 0 : 1;
})();
