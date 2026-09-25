'use strict';
// Tests for remote push: lib/push.js, lib/push-runtime.js, the network switch (lib/network.js) and the push.* keys in
// l10n/push.*.json.
// Plain node: node test/push.test.js. All sessions, keys, tokens and webhook URLs are synthetic; ~/.claude and ~/.codex
// are never read. No request ever leaves the process: every send() gets a fake fetch, and the global fetch is replaced
// by one that fails the test if anything reaches it.
// Claim markers and store files go under AGENT_MONITOR_TEST_TMP (system temp dir if unset) and are removed afterwards.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const S = require('../lib/core/status');
const i18nLib = require('../lib/i18n');
const lampLib = require('../lib/lamp');
const notify = require('../lib/notify');
const alerts = require('../lib/alerts');
const push = require('../lib/push');
const network = require('../lib/network');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-push-'));

// Safety net: a real network call would be a test bug
let realFetchCalls = 0;
globalThis.fetch = async () => { realFetchCalls++; throw new Error('real fetch must never be called in tests'); };
// The network switch: allowed for the channel, send and runtime tests (they run concurrently); the switch tests run last,
// one at a time, and turn it off
const netSwitch = { on: true };
network.setAllowed(() => netSwitch.on);

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

const NOW = Date.parse('2026-09-24T10:00:00Z'); // 1790244000000
const SEC = 1000;
const MIN = 60e3;
const HOUR = 3600e3;
const LOCALES = ['en', 'zh-cn', 'zh-tw', 'ko', 'ja'];

// Synthetic credentials (none of these exist anywhere)
const K = {
  ntfyTopic: 'am-7fk2q9x4synth',
  ntfyToken: 'tk_synthetic0ntfy0token0000000',
  barkKey: 'synthBarkDeviceKey0001',
  sctKey: 'SCT123456TsynthKey000000000',
  sctpKey: 'sctp9876tSynthKey0000000000',
  feishuHook: 'https://open.feishu.cn/open-apis/bot/v2/hook/0f0e0d0c-aaaa-bbbb-cccc-111122223333',
  feishuSecret: 'synthetic-feishu-secret',
  dingHook: 'https://oapi.dingtalk.com/robot/send?access_token=5a5b5c5d000011112222333344445555666677778888999900001111aaaabbbb',
  dingSecret: 'SECsynthetic0dingtalk0secret0000000000000000000000000000000000000',
  wecomHook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=00000000-1111-2222-3333-444444444444',
  // Token-shaped fixtures are assembled at runtime so secret scanners don't flag the source.
  tgToken: ['123456789', 'AAsynthetic_token_value_0000000000'].join(':'),
  discordHook: ['https://discord.com/api/webhooks', '123456789012345678', 'synthetic-discord-token_000000000000000000000000'].join('/'),
  slackHook: ['https://hooks.slack.com/services', 'T0SYNTH00', 'B0SYNTH00', 'synthSlackToken000000000'].join('/'),
};
const CFG = {
  ntfy: { channel: 'ntfy', topic: K.ntfyTopic, token: K.ntfyToken },
  bark: { channel: 'bark', deviceKey: K.barkKey },
  serverchan: { channel: 'serverchan', sendKey: K.sctKey },
  feishu: { channel: 'feishu', webhook: K.feishuHook, secret: K.feishuSecret },
  dingtalk: { channel: 'dingtalk', webhook: K.dingHook, secret: K.dingSecret, keyword: 'AgentBot' },
  wecom: { channel: 'wecom', webhook: K.wecomHook },
  telegram: { channel: 'telegram', botToken: K.tgToken, chatId: '123456789' },
  discord: { channel: 'discord', webhook: K.discordHook },
  slack: { channel: 'slack', webhook: K.slackHook },
};
// Every string that must never appear in an error: secret values and the token-bearing parts of secret URLs
const NEEDLES = {
  ntfy: [K.ntfyTopic, K.ntfyToken],
  bark: [K.barkKey],
  serverchan: [K.sctKey, 'TsynthKey000000000'],
  feishu: ['0f0e0d0c-aaaa-bbbb-cccc-111122223333', K.feishuSecret],
  dingtalk: ['5a5b5c5d000011112222333344445555666677778888999900001111aaaabbbb', K.dingSecret, 'synthetic0dingtalk0secret'],
  wecom: ['00000000-1111-2222-3333-444444444444'],
  telegram: [K.tgToken, 'AAsynthetic_token_value_0000000000'],
  discord: ['synthetic-discord-token_000000000000000000000000'],
  slack: ['synthSlackToken000000000'],
};

const MSG = { title: 'Agent needs you · demo-app', body: 'A chat is waiting for your reply or approval.', priority: 'high', event: 'needsYou' };
const TEXT = `${MSG.title}\n${MSG.body}`;
const JSON_CT = { 'Content-Type': 'application/json; charset=utf-8' };
const build = (cfg, msg = MSG, now = NOW, deps) => push.channelOf(cfg).build(push.withDefaults(cfg), msg, now, deps);
const rfc2047 = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
const decode2047 = (h) => h.split(' ').map((w) => {
  const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(w);
  assert.ok(m, `encoded word: ${w}`);
  assert.ok(w.length <= 75, `encoded word too long: ${w.length}`);
  return Buffer.from(m[1], 'base64').toString('utf8');
}).join('');

/** Fake fetch: records calls and answers with status / text (or a function of the request) */
function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const a = typeof answer === 'function' ? await answer(url, init) : answer || { status: 200, text: '' };
    return { status: a.status, text: async () => (a.textError ? Promise.reject(new Error(a.textError)) : a.text || '') };
  };
  f.calls = calls;
  return f;
}

// Sessions (same shapes as test/notify.test.js)
const st = (code, sinceMs, extra) => S.makeStatus(code, sinceMs, extra);
function agent(o = {}) {
  return {
    id: 'main', kind: 'main', name: null, agentType: null, phase: null, background: false, model: 'claude-opus-5-5',
    status: st('thinking', NOW - 5000), step: null, startedMs: NOW - HOUR, lastActivityMs: NOW - 5000, mtimeMs: NOW - 5000,
    file: '/synthetic/main.jsonl', ...o,
  };
}
function session(o = {}) {
  const id = o.id || 'aaaaaaaa-1111-2222-3333-444444444444';
  return {
    key: 'claude:' + id, provider: 'claude', id, title: 'Refactor the parser', titleSource: 'ai',
    cwd: '/work/private-client/demo-app', projectDir: '-work-private-client-demo-app', live: false, liveStatus: null, waitingFor: null,
    startedMs: NOW - HOUR, updatedMs: NOW - 1000, doneAtMs: null, lastActivityMs: NOW - 1000,
    main: agent(), agents: [], workflows: [], ...o,
  };
}
const working = (o) => session({ main: agent({ status: st('tool', NOW - 3000, { pendingTool: 'Bash' }) }), ...o });
const asking = (since, o) => session({ main: agent({ status: st('awaitingInput', since, { question: 'askUser', pendingTool: 'AskUserQuestion' }) }), ...o });
const failing = (since, o) => session({ main: agent({ status: st('apiError', since, { error: { kind: 'server_error', http: 500, message: 'synthetic' } }) }), ...o });
const limited = (since, o) => session({ main: agent({ status: st('quota', since, { quota: { kind: 'session', model: null, resetsAtMs: NOW + HOUR, resetsText: null, source: 'text', autoContinue: false } }) }), ...o });
const lampsOf = (sessions) => lampLib.computeLamps(sessions, { seen: 0 });
const feed = (tr, sessions, now = NOW, quota) => tr.update({ sessions, lamps: lampsOf(sessions), quota, now });
const emptyQuota = () => ({ claude: { lastHit: null }, codex: { observedMs: null, planType: null, limitId: null, windows: [], reachedType: null, credits: null } });
const claudeHit = (ms, resetsAtMs, sessionKey) => ({ ...emptyQuota(), claude: { lastHit: { kind: 'session', model: null, resetsAtMs, resetsText: null, source: 'text', autoContinue: false, ms, sessionKey } } });
const codexQuota = (observedMs, windows, reachedType = null) => ({ ...emptyQuota(), codex: { observedMs, planType: 'plus', limitId: 'codex', windows, reachedType, credits: null } });

const en = i18nLib.createI18n('en');
const zh = i18nLib.createI18n('zh-cn');

// ---------- Channels: exact requests ----------

function channelTests() {
  test('registry: nine channels, each with an l10n label, typed fields and a build function; secrets are marked', () => {
    assert.deepStrictEqual([...push.CHANNEL_IDS], ['ntfy', 'bark', 'serverchan', 'feishu', 'dingtalk', 'wecom', 'telegram', 'discord', 'slack']);
    const secretKeys = Object.fromEntries(push.CHANNEL_IDS.map((id) => [id, push.CHANNELS[id].fields.filter((f) => f.secret).map((f) => f.key)]));
    assert.deepStrictEqual(secretKeys, {
      ntfy: ['token', 'topic'], bark: ['deviceKey'], serverchan: ['sendKey'], feishu: ['webhook', 'secret'],
      dingtalk: ['webhook', 'secret'], wecom: ['webhook'], telegram: ['botToken'], discord: ['webhook'], slack: ['webhook'],
    });
    for (const id of push.CHANNEL_IDS) {
      const ch = push.CHANNELS[id];
      assert.strictEqual(ch.id, id);
      assert.strictEqual(ch.label, `push.channel.${id}`);
      assert.strictEqual(typeof ch.build, 'function');
      assert.ok(ch.fields.some((f) => f.key === 'dailyMax'), `${id} has a daily cap field`);
    }
    const daily = (id) => push.CHANNELS[id].fields.find((f) => f.key === 'dailyMax').default;
    assert.strictEqual(daily('serverchan'), 5, 'ServerChan free plan: 5 a day');
    assert.strictEqual(daily('ntfy'), 0);
    const boundKeys = Object.fromEntries(push.CHANNEL_IDS.map((id) => [id, push.CHANNELS[id].fields.filter((f) => f.bound).map((f) => f.key)]));
    assert.deepStrictEqual(boundKeys, {
      ntfy: ['server'], bark: ['server'], serverchan: [], feishu: [], dingtalk: [], wecom: [], telegram: ['chatId'], discord: [], slack: [],
    });
    const { settings, secrets } = push.splitConfig({ ...CFG.dingtalk, key: 'ding-1' });
    assert.deepStrictEqual(settings, { channel: 'dingtalk', keyword: 'AgentBot', key: 'ding-1' });
    assert.deepStrictEqual(secrets, { channel: 'dingtalk', webhook: K.dingHook, secret: K.dingSecret });
    assert.strictEqual(push.channelKeyOf({ channel: 'ntfy' }), 'ntfy');
    assert.strictEqual(push.channelKeyOf({ channel: 'ntfy', key: 'ntfy-phone' }), 'ntfy-phone');
  });

  test('ntfy: POST <server>/<topic>, text body, X-Title (RFC 2047 for non-ASCII) / X-Priority / X-Tags / Bearer headers', () => {
    assert.deepStrictEqual(build(CFG.ntfy), {
      url: `https://ntfy.sh/${K.ntfyTopic}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Title': rfc2047('Agent needs you · demo-app'),
        'X-Priority': 'high',
        'X-Tags': 'bell',
        Authorization: `Bearer ${K.ntfyToken}`,
      },
      body: MSG.body,
    });
    const self = build({ channel: 'ntfy', server: 'http://192.168.1.20:8080/', topic: 'alerts' },
      { title: 'Limit reached', body: 'Resets 2:00 PM.', priority: 'normal', event: 'limitHit' });
    assert.deepStrictEqual(self, {
      url: 'http://192.168.1.20:8080/alerts',
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Title': 'Limit reached', 'X-Priority': 'default', 'X-Tags': 'hourglass_flowing_sand' },
      body: 'Resets 2:00 PM.',
    });
    const long = '智能体需要你 · 一个名字很长很长的项目文件夹-用来测试多段编码的标题';
    const h = build(CFG.ntfy, { ...MSG, title: long }).headers['X-Title'];
    assert.ok(h.split(' ').length > 1, 'split into several encoded words');
    assert.strictEqual(decode2047(h), long);
    assert.ok(/^[\x20-\x7e]+$/.test(h), 'header value is plain ASCII');
    // A bare "Priority" is the RFC 9218 header that Cloudflare rewrites; only the X- names are sent
    const names = Object.keys(build(CFG.ntfy).headers);
    for (const bare of ['Title', 'Priority', 'Tags']) assert.ok(!names.includes(bare), `no bare ${bare} header`);
    // every event type has its own tag; threshold alerts included
    const tags = Object.fromEntries(push.EVENT_TYPES.map((event) => [event, build(CFG.ntfy, { ...MSG, event }).headers['X-Tags']]));
    assert.deepStrictEqual(tags, {
      needsYou: 'bell', error: 'warning', limitHit: 'hourglass_flowing_sand', limitReset: 'white_check_mark',
      usageHigh: 'bar_chart', costDaily: 'moneybag', contextHigh: 'memo',
    });
  });

  test('Bark: POST <server>/push JSON with device_key, level timeSensitive for high priority, the app group', () => {
    assert.deepStrictEqual(build(CFG.bark), {
      url: 'https://api.day.app/push',
      method: 'POST',
      headers: JSON_CT,
      body: JSON.stringify({ device_key: K.barkKey, title: MSG.title, body: MSG.body, level: 'timeSensitive', group: 'CYUNEO Agent Monitor' }),
    });
    const normal = build({ ...CFG.bark, server: 'https://bark.example.org/base/' }, { ...MSG, priority: 'normal' });
    assert.strictEqual(normal.url, 'https://bark.example.org/base/push');
    assert.strictEqual(JSON.parse(normal.body).level, 'active');
  });

  test('ServerChan: endpoint by key prefix; form body with a one-line title of at most 32 characters and escaped Markdown desp', () => {
    assert.deepStrictEqual(build(CFG.serverchan), {
      url: `https://sctapi.ftqq.com/${K.sctKey}.send`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: 'title=Agent+needs+you+%C2%B7+demo-app&desp=A+chat+is+waiting+for+your+reply+or+approval.&short=A+chat+is+waiting+for+your+reply+or+approval.',
    });
    assert.strictEqual(build({ channel: 'serverchan', sendKey: K.sctpKey }).url, `https://9876.push.ft07.com/send/${K.sctpKey}.send`);
    const r = build(CFG.serverchan, { ...MSG, title: 'x'.repeat(50), body: 'see [link](http://tracker.example/p.png) *now*' });
    const form = new URLSearchParams(r.body);
    assert.strictEqual(Array.from(form.get('title')).length, 32);
    assert.ok(!/[\r\n]/.test(form.get('title')));
    assert.strictEqual(form.get('desp'), 'see \\[link\\]\\(http://tracker.example/p.png\\) \\*now\\*');
    // A batch: one paragraph per line in the Markdown desp; the card preview (short) is plain text without escapes
    const batch = new URLSearchParams(build(CFG.serverchan, { ...MSG, body: 'Agent needs you · demo-app\nAgent stopped with an error · my_api (v2)' }).body);
    assert.strictEqual(batch.get('desp'), 'Agent needs you · demo\\-app\n\nAgent stopped with an error · my\\_api \\(v2\\)');
    assert.strictEqual(batch.get('short'), 'Agent needs you · demo-app · Agent stopped with an error · my_api (v2)'.slice(0, 63) + '…');
    assert.ok(!batch.get('short').includes('\\'));
    assert.strictEqual(new URLSearchParams(build(CFG.serverchan, { ...MSG, body: '' }).body).has('short'), false, 'no empty short');
  });

  test('Feishu: msg_type text; with a secret, timestamp (seconds) and sign in the JSON body (known answer)', () => {
    // Known answer from the Python sample in the Feishu docs (hmac.new(f"{ts}\n{secret}".encode(), digestmod=sha256), empty message)
    const SIGN = '4WAgFf+wG1rSpexVAAQTtmXESAP+6A3yfcA+wcDcSx4=';
    const independent = crypto.createHmac('sha256', `1790244000\n${K.feishuSecret}`).update(Buffer.alloc(0)).digest('base64');
    assert.strictEqual(independent, SIGN, 'the documented formula, computed here');
    assert.strictEqual(push.feishuSign('1790244000', K.feishuSecret), SIGN);
    assert.deepStrictEqual(build(CFG.feishu), {
      url: K.feishuHook,
      method: 'POST',
      headers: JSON_CT,
      body: JSON.stringify({ timestamp: '1790244000', sign: SIGN, msg_type: 'text', content: { text: TEXT } }),
    });
    const lark = build({ channel: 'feishu', webhook: 'https://open.larksuite.com/open-apis/bot/v2/hook/abc-123', keyword: 'Needs' },
      { ...MSG, title: 'Needs you <at user_id="all">x</at>' });
    assert.strictEqual(lark.url, 'https://open.larksuite.com/open-apis/bot/v2/hook/abc-123');
    const payload = JSON.parse(lark.body);
    assert.deepStrictEqual(Object.keys(payload), ['msg_type', 'content'], 'no timestamp / sign without a secret');
    assert.ok(!payload.content.text.includes('<at'), 'an @all mention in a title stays inert');
    assert.ok(payload.content.text.startsWith('Needs you'), 'keyword already present is not prepended again');
    const kw = JSON.parse(build({ channel: 'feishu', webhook: K.feishuHook, keyword: '提醒' }).body);
    assert.strictEqual(kw.content.text, `提醒 ${TEXT}`);
  });

  test('DingTalk: msgtype text with the keyword prepended; with a secret, timestamp (ms) and URL-encoded sign as query parameters (known answer)', () => {
    // Known answer: base64(HMAC-SHA256(key = secret, msg = `${timestamp}\n${secret}`)), then URL-encoded (Python quote_plus)
    const SIGN = 'Vy53GmVWrKGaiGvt+7MpuFvaw+Mw4HMfdrGwXwwaMDU=';
    const SIGN_Q = 'Vy53GmVWrKGaiGvt%2B7MpuFvaw%2BMw4HMfdrGwXwwaMDU%3D';
    const independent = crypto.createHmac('sha256', K.dingSecret).update(`1790244000000\n${K.dingSecret}`).digest('base64');
    assert.strictEqual(independent, SIGN, 'the documented formula, computed here');
    assert.strictEqual(push.dingtalkSign('1790244000000', K.dingSecret), SIGN);
    assert.deepStrictEqual(build(CFG.dingtalk), {
      url: `${K.dingHook}&timestamp=1790244000000&sign=${SIGN_Q}`,
      method: 'POST',
      headers: JSON_CT,
      body: JSON.stringify({ msgtype: 'text', text: { content: `AgentBot ${TEXT}` } }),
    });
    const plain = build({ channel: 'dingtalk', webhook: K.dingHook });
    assert.strictEqual(plain.url, K.dingHook, 'no signature without a secret');
    assert.strictEqual(JSON.parse(plain.body).text.content, TEXT);
    const again = build({ ...CFG.dingtalk, webhook: `${K.dingHook}&timestamp=1&sign=old` });
    assert.strictEqual(again.url.match(/timestamp=/g).length, 1, 'stale timestamp / sign pasted with the URL are replaced');
    // A fragment pasted with the URL (even a bare '#') must not swallow the signature: fetch never sends a fragment
    for (const frag of ['#', '#section']) {
      const cfg = { ...CFG.dingtalk, webhook: K.dingHook + frag };
      assert.ok(push.validateConfig(cfg).ok);
      const u = new URL(build(cfg).url);
      assert.strictEqual(u.hash, '');
      assert.strictEqual(u.searchParams.get('timestamp'), '1790244000000');
      assert.strictEqual(u.searchParams.get('sign'), SIGN);
      assert.strictEqual(build(cfg).url, `${K.dingHook}&timestamp=1790244000000&sign=${SIGN_Q}`);
    }
  });

  test('WeCom: msgtype text, content cut to 2048 UTF-8 bytes', () => {
    assert.deepStrictEqual(build(CFG.wecom), {
      url: K.wecomHook, method: 'POST', headers: JSON_CT, body: JSON.stringify({ msgtype: 'text', text: { content: TEXT } }),
    });
    const big = build(CFG.wecom, { ...MSG, body: Array.from({ length: 8 }, () => '需'.repeat(199)).join('\n') });
    assert.ok(Buffer.byteLength(JSON.parse(big.body).text.content, 'utf8') <= 2048);
  });

  test('Telegram: POST /bot<token>/sendMessage, plain text, numeric chat ids as numbers, no link preview', () => {
    assert.deepStrictEqual(build(CFG.telegram), {
      url: `https://api.telegram.org/bot${K.tgToken}/sendMessage`,
      method: 'POST',
      headers: JSON_CT,
      body: JSON.stringify({ chat_id: 123456789, text: TEXT, link_preview_options: { is_disabled: true } }),
    });
    assert.strictEqual(JSON.parse(build({ ...CFG.telegram, chatId: '-1001234567890' }).body).chat_id, -1001234567890);
    assert.strictEqual(JSON.parse(build({ ...CFG.telegram, chatId: '@my_alerts' }).body).chat_id, '@my_alerts');
    assert.ok(!('parse_mode' in JSON.parse(build(CFG.telegram).body)));
  });

  test('Discord: content ≤ 2000 characters, no mentions parsed, embeds suppressed', () => {
    assert.deepStrictEqual(build(CFG.discord), {
      url: K.discordHook,
      method: 'POST',
      headers: JSON_CT,
      body: JSON.stringify({ content: TEXT, allowed_mentions: { parse: [] }, flags: 4 }),
    });
    const long = build(CFG.discord, { ...MSG, body: Array.from({ length: 8 }, () => 'y'.repeat(199)).join('\n'), title: 'z'.repeat(119) });
    assert.ok(Array.from(JSON.parse(long.body).content).length <= 2000);
  });

  test('Slack: { text } with & < > escaped so <!channel> in a title is inert', () => {
    assert.deepStrictEqual(build(CFG.slack), {
      url: K.slackHook, method: 'POST', headers: JSON_CT, body: JSON.stringify({ text: TEXT }),
    });
    const esc = JSON.parse(build(CFG.slack, { ...MSG, title: 'Hi <!channel> & <https://x.example|y>' }).body).text;
    assert.ok(esc.startsWith('Hi &lt;!channel&gt; &amp; &lt;https://x.example|y&gt;'), esc);
  });

  test('build never lets control characters or bidi marks through; the title is one line', () => {
    const r = JSON.parse(build(CFG.slack, { title: 'a\nb‮c\u0007', body: 'l1\r\nl2 x' }).body).text;
    assert.strictEqual(r, 'a bc\nl1\nl2 x');
  });
}

// ---------- URL and config validation ----------

function validationTests() {
  const code = (e) => (e ? e.code : null);
  test('webhook URLs: https only, exact vendor host on the default port, documented path and query', () => {
    const cases = [
      ['feishu', K.feishuHook, null],
      ['feishu', 'https://open.larksuite.com/open-apis/bot/v2/hook/abc', null],
      ['feishu', 'http://open.feishu.cn/open-apis/bot/v2/hook/abc', 'https'],
      ['feishu', 'https://open.feishu.cn.evil.example/open-apis/bot/v2/hook/abc', 'host'],
      ['feishu', 'https://evil.example/open-apis/bot/v2/hook/abc', 'host'],
      ['feishu', 'https://open.feishu.cn:8443/open-apis/bot/v2/hook/abc', 'host'],
      ['feishu', 'https://user:pw@open.feishu.cn/open-apis/bot/v2/hook/abc', 'userinfo'],
      ['feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/', 'format'],
      ['dingtalk', K.dingHook, null],
      ['dingtalk', 'https://oapi.dingtalk.com/robot/send', 'format'],
      ['dingtalk', 'https://oapi.dingtalk.com.cn/robot/send?access_token=x', 'host'],
      ['wecom', K.wecomHook, null],
      ['wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send', 'format'],
      ['wecom', 'https://qyapi.weixin.qq.com.attacker.example/cgi-bin/webhook/send?key=x', 'host'],
      ['discord', K.discordHook, null],
      ['discord', 'https://discordapp.com/api/webhooks/1/abc', null],
      ['discord', 'https://discord.com/api/v10/webhooks/1/abc', null],
      ['discord', 'https://discord.gg/api/webhooks/1/abc', 'host'],
      ['discord', 'https://discord.com/api/channels/1/messages', 'format'],
      ['slack', K.slackHook, null],
      ['slack', 'https://hooks.slack.com.evil.example/services/T/B/X', 'host'],
      ['slack', 'https://hooks.slack.com/triggers/T/B/X', 'format'],
      ['slack', 'javascript:alert(1)', 'url'],
      ['slack', 'not a url', 'url'],
    ];
    for (const [id, url, want] of cases) {
      const f = push.CHANNELS[id].fields.find((x) => x.key === 'webhook');
      assert.strictEqual(code(f.validate(url)), want, `${id} ${url}`);
    }
    const host = push.CHANNELS.feishu.fields[0].validate('https://evil.example/open-apis/bot/v2/hook/abc');
    assert.deepStrictEqual(host.vars, { host: 'open.feishu.cn / open.larksuite.com' });
  });

  test('self-hosted servers (ntfy, Bark): https anywhere; http only for localhost and private addresses', () => {
    const ok = ['https://ntfy.sh', 'https://ntfy.example.org/sub/', 'http://localhost:8080', 'http://127.0.0.1', 'http://10.1.2.3:2586',
      'http://172.16.0.9', 'http://172.31.255.1', 'http://192.168.1.20:8080/', 'http://169.254.1.1', 'http://100.64.0.1',
      'http://[::1]:8080', 'http://[fd12:3456::1]', 'http://[fe80::1]', 'http://nas.local', 'http://pi.lan', 'http://box.home.arpa'];
    for (const u of ok) assert.strictEqual(push.checkServerUrl(u), null, u);
    const bad = [['http://ntfy.sh', 'httpPublic'], ['http://8.8.8.8', 'httpPublic'], ['http://172.32.0.1', 'httpPublic'],
      ['http://192.169.0.1', 'httpPublic'], ['http://[2001:db8::1]', 'httpPublic'], ['http://localhost.evil.example', 'httpPublic'],
      ['ftp://ntfy.sh', 'url'], ['https://u:p@ntfy.sh', 'userinfo'], ['https://ntfy.sh/?x=1', 'format'], ['', 'url']];
    for (const [u, want] of bad) assert.strictEqual(code(push.checkServerUrl(u)), want, u);
  });

  test('validateConfig: required fields, formats, defaults and the daily cap number', () => {
    assert.deepStrictEqual(push.validateConfig(CFG.ntfy), { ok: true, errors: [] });
    for (const id of push.CHANNEL_IDS) assert.ok(push.validateConfig(CFG[id]).ok, id);
    assert.deepStrictEqual(push.validateConfig({ channel: 'ntfy' }).errors, [{ key: 'topic', code: 'required' }]);
    assert.deepStrictEqual(push.validateConfig({ channel: 'ntfy', topic: 'has space' }).errors, [{ key: 'topic', code: 'format' }]);
    assert.deepStrictEqual(push.validateConfig({ channel: 'telegram', botToken: 'nope', chatId: 'x y' }).errors,
      [{ key: 'botToken', code: 'format' }, { key: 'chatId', code: 'format' }]);
    assert.deepStrictEqual(push.validateConfig({ ...CFG.bark, dailyMax: 'lots' }).errors, [{ key: 'dailyMax', code: 'number' }]);
    assert.deepStrictEqual(push.validateConfig({ ...CFG.dingtalk, keyword: 'two\nlines' }).errors, [{ key: 'keyword', code: 'format' }]);
    assert.deepStrictEqual(push.validateConfig({ channel: 'email' }).errors, [{ key: 'channel', code: 'channel' }]);
    assert.strictEqual(push.withDefaults({ channel: 'ntfy', topic: ' t ' }).server, 'https://ntfy.sh');
    assert.strictEqual(push.withDefaults({ channel: 'ntfy', topic: ' t ' }).topic, 't');
    assert.strictEqual(push.withDefaults({ channel: 'serverchan', sendKey: K.sctKey }).dailyMax, 5);
  });

  test('ntfy topic: without an access token it must be long enough not to be guessed; randomTopic suggests one', () => {
    const short = push.validateConfig({ channel: 'ntfy', topic: 'alerts' });
    assert.deepStrictEqual(short.errors, [{ key: 'topic', code: 'topicShort', vars: { min: 12 } }]);
    assert.ok(push.validateConfig({ channel: 'ntfy', topic: 'alerts', token: K.ntfyToken }).ok, 'a token protects a short topic');
    assert.ok(push.validateConfig({ channel: 'ntfy', topic: 'a1b2c3d4e5f6' }).ok, '12 characters');
    assert.strictEqual(push.describeError({ code: 'config', field: 'topic', problem: 'topicShort', vars: { min: 12 } }, en, { channel: 'ntfy' }),
      'Topic: Too easy to guess. Without an access token, use at least 12 characters.');
    const t = push.randomTopic();
    assert.ok(/^am-[A-Za-z0-9_-]{16}$/.test(t), t);
    assert.ok(push.validateConfig({ channel: 'ntfy', topic: t }).ok);
    assert.notStrictEqual(push.randomTopic(), t);
    assert.strictEqual(push.randomTopic({ randomBytes: (n) => Buffer.alloc(n, 0xff) }), 'am-________________');
    return (async () => {
      const f = fakeFetch();
      const r = await push.send({ channel: 'ntfy', topic: 'claude' }, MSG, { fetch: f });
      assert.deepStrictEqual([r.code, r.field, r.problem, r.vars, f.calls.length], ['config', 'topic', 'topicShort', { min: 12 }, 0]);
    })();
  });

  test('splitConfig / mergeConfig: the server, chat id and channel that decide where secrets go come from SecretStorage only', () => {
    const cfg = { channel: 'ntfy', server: 'https://ntfy.example.com', topic: K.ntfyTopic, token: K.ntfyToken, dailyMax: 3 };
    const { settings, secrets } = push.splitConfig(cfg);
    assert.deepStrictEqual(settings, { channel: 'ntfy', server: 'https://ntfy.example.com', dailyMax: 3 }, 'display copy, nothing secret');
    assert.deepStrictEqual(secrets, { channel: 'ntfy', server: 'https://ntfy.example.com', topic: K.ntfyTopic, token: K.ntfyToken });
    assert.deepStrictEqual(push.mergeConfig(settings, secrets), cfg);
    // A workspace .vscode/settings.json that points the channel elsewhere
    const hostile = push.mergeConfig({ ...settings, server: 'https://attacker.example', dailyMax: 0 }, secrets);
    assert.strictEqual(hostile.server, 'https://ntfy.example.com');
    assert.strictEqual(hostile.dailyMax, 0, 'harmless fields still come from settings');
    const noServer = push.splitConfig({ channel: 'bark', deviceKey: K.barkKey }).secrets;
    assert.strictEqual(push.mergeConfig({ channel: 'bark', server: 'https://attacker.example' }, noServer).server, undefined, 'the default applies, not the settings copy');
    assert.strictEqual(push.withDefaults(push.mergeConfig({ channel: 'bark', server: 'https://attacker.example' }, noServer)).server, 'https://api.day.app');
    const tg = push.splitConfig(CFG.telegram);
    assert.deepStrictEqual(tg.secrets, { channel: 'telegram', botToken: K.tgToken, chatId: '123456789' });
    assert.strictEqual(push.mergeConfig({ ...tg.settings, chatId: '-100999' }, tg.secrets).chatId, '123456789');
    assert.strictEqual(push.mergeConfig({ channel: 'bark' }, secrets), null, 'channel ids disagree');
    assert.strictEqual(push.mergeConfig(settings, null), null, 'no stored secrets');
    assert.strictEqual(push.mergeConfig({ channel: 'email' }, { topic: 'x' }), null);
    return (async () => {
      const f = fakeFetch();
      await push.send(push.mergeConfig({ ...settings, server: 'https://attacker.example' }, secrets), MSG, { fetch: f });
      assert.strictEqual(f.calls[0].url, `https://ntfy.example.com/${K.ntfyTopic}`);
    })();
  });
}

// ---------- parseResult ----------

function parseTests() {
  const P = (id, status, body) => push.parseResult(id, status, typeof body === 'string' ? body : JSON.stringify(body));
  test('parseResult: success bodies of every vendor', () => {
    const okCases = [
      ['ntfy', 200, { id: 'x1', time: 1, event: 'message', topic: 't' }],
      ['bark', 200, { code: 200, message: 'success', timestamp: 1 }],
      ['serverchan', 200, { code: 0, message: '', data: { pushid: '1', readkey: 'r', error: 'SUCCESS', errno: 0 } }],
      ['feishu', 200, { code: 0, msg: 'success', data: {} }],
      ['feishu', 200, { Extra: null, StatusCode: 0, StatusMessage: 'success' }],
      ['dingtalk', 200, { errcode: 0, errmsg: 'ok' }],
      ['wecom', 200, { errcode: 0, errmsg: 'ok' }],
      ['telegram', 200, { ok: true, result: { message_id: 1 } }],
      ['discord', 204, ''],
      ['slack', 200, 'ok'],
    ];
    for (const [id, status, body] of okCases) assert.deepStrictEqual(P(id, status, body), { ok: true, error: null }, id);
  });

  test('parseResult: vendors that answer 200 with an error code, and non-2xx errors', () => {
    const errCases = [
      ['bark', 200, { code: 400, message: 'failed to get device token' }, 'failed to get device token (400)'],
      ['serverchan', 200, { code: 40001, message: 'bad pushtoken' }, 'bad pushtoken (40001)'],
      ['feishu', 200, { code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' },
        'sign match fail or timestamp is not within one hour from current time (19021)'],
      ['feishu', 200, { code: 19024, msg: 'Key Words Not Found' }, 'Key Words Not Found (19024)'],
      ['feishu', 200, { StatusCode: 9499, StatusMessage: 'Bad Request' }, 'Bad Request (9499)'],
      ['dingtalk', 200, { errcode: 310000, errmsg: 'keywords not in content' }, 'keywords not in content (310000)'],
      ['wecom', 200, { errcode: 93000, errmsg: 'invalid webhook url' }, 'invalid webhook url (93000)'],
      ['telegram', 200, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 'Forbidden: bot was blocked by the user (403)'],
      ['telegram', 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 'HTTP 400: Bad Request: chat not found'],
      ['ntfy', 403, { code: 40301, http: 403, error: 'forbidden' }, 'HTTP 403: forbidden (40301)'],
      ['ntfy', 429, { code: 42901, http: 429, error: 'limit reached: too many requests' }, 'HTTP 429: limit reached: too many requests (42901)'],
      ['bark', 400, { code: 400, message: 'device key is empty' }, 'HTTP 400: device key is empty'],
      ['discord', 404, { message: 'Unknown Webhook', code: 10015 }, 'HTTP 404: Unknown Webhook (10015)'],
      ['discord', 400, { content: ['Must be 2000 or fewer in length.'] }, 'HTTP 400: Must be 2000 or fewer in length.'],
      ['slack', 403, 'invalid_token', 'HTTP 403: invalid_token'],
      ['slack', 404, 'no_service', 'HTTP 404: no_service'],
      ['serverchan', 502, '<html><body>Bad Gateway</body></html>', 'HTTP 502'],
      ['wecom', 0, '', 'HTTP 0'],
    ];
    for (const [id, status, body, want] of errCases) assert.deepStrictEqual(P(id, status, body), { ok: false, error: want }, `${id} ${status}`);
    const long = P('slack', 500, 'e'.repeat(1000)).error;
    assert.ok(Array.from(long).length <= 200, 'error text is capped');
  });
}

// ---------- send ----------

function sendTests() {
  test('send: the request goes out as built (manual redirects, abort signal) and a success resolves ok', async () => {
    const f = fakeFetch({ status: 200, text: JSON.stringify({ errcode: 0, errmsg: 'ok' }) });
    const r = await push.send(CFG.dingtalk, MSG, { fetch: f, clock: () => NOW });
    assert.deepStrictEqual(r, { ok: true, status: 200, error: null, code: null });
    assert.strictEqual(f.calls.length, 1);
    const { url, init } = f.calls[0];
    const want = build(CFG.dingtalk);
    assert.strictEqual(url, want.url);
    assert.strictEqual(init.method, 'POST');
    assert.deepStrictEqual(init.headers, want.headers);
    assert.strictEqual(init.body, want.body);
    assert.strictEqual(init.redirect, 'manual');
    assert.ok(init.signal && typeof init.signal.aborted === 'boolean');
  });

  test('send: the clock and crypto are injectable', async () => {
    const f = fakeFetch({ status: 200, text: '{"code":0}' });
    const seen = [];
    const fakeCrypto = { createHmac: (alg, key) => ({ update: (m) => ({ digest: (enc) => { seen.push([alg, key, m, enc]); return 'FAKESIG='; } }) }) };
    await push.send(CFG.feishu, MSG, { fetch: f, clock: () => 1234567890123, crypto: fakeCrypto });
    assert.deepStrictEqual(seen, [['sha256', `1234567890\n${K.feishuSecret}`, '', 'base64']]);
    const body = JSON.parse(f.calls[0].init.body);
    assert.strictEqual(body.timestamp, '1234567890');
    assert.strictEqual(body.sign, 'FAKESIG=');
  });

  test('send: 200 with a vendor error → rejected; non-2xx → http; 3xx → redirect; bad config → config without any request', async () => {
    const rejected = await push.send(CFG.wecom, MSG, { fetch: fakeFetch({ status: 200, text: '{"errcode":45009,"errmsg":"api freq out of limit"}' }) });
    assert.deepStrictEqual(rejected, { ok: false, status: 200, code: 'rejected', error: 'api freq out of limit (45009)' });
    const http = await push.send(CFG.slack, MSG, { fetch: fakeFetch({ status: 410, text: 'channel_is_archived' }) });
    assert.deepStrictEqual(http, { ok: false, status: 410, code: 'http', error: 'HTTP 410: channel_is_archived' });
    const redirect = await push.send(CFG.bark, MSG, { fetch: fakeFetch({ status: 301, text: '' }) });
    assert.strictEqual(redirect.code, 'redirect');
    const f = fakeFetch();
    const bad = await push.send({ channel: 'slack', webhook: 'https://hooks.slack.com.evil.example/services/A/B/C' }, MSG, { fetch: f });
    assert.strictEqual(bad.code, 'config');
    assert.strictEqual(bad.field, 'webhook');
    assert.strictEqual(bad.problem, 'host');
    assert.strictEqual(f.calls.length, 0, 'nothing is sent to a wrong host');
    const unknown = await push.send({ channel: 'email' }, MSG, { fetch: f });
    assert.strictEqual(unknown.code, 'config');
    assert.strictEqual(f.calls.length, 0);
  });

  test('send: network failures resolve (never throw), including a fetch that throws synchronously or a body that fails', async () => {
    const err = new TypeError('fetch failed');
    err.cause = { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.telegram.org' };
    const r1 = await push.send(CFG.telegram, MSG, { fetch: async () => { throw err; } });
    assert.deepStrictEqual(r1, { ok: false, status: 0, code: 'network', error: 'ENOTFOUND' });
    const r2 = await push.send(CFG.telegram, MSG, { fetch: () => { throw new Error('boom'); } });
    assert.strictEqual(r2.code, 'network');
    const r3 = await push.send(CFG.discord, MSG, { fetch: fakeFetch({ status: 204, textError: 'socket hang up' }) });
    assert.deepStrictEqual(r3, { ok: true, status: 204, error: null, code: null }, 'the status alone decides when the body cannot be read');
  });

  test('send: timeout aborts the request; a fetch that ignores the signal still resolves', async () => {
    let aborted = false;
    const hang = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
    const t0 = Date.now();
    const r = await push.send(CFG.ntfy, MSG, { fetch: hang, timeoutMs: 40 });
    assert.strictEqual(r.code, 'timeout');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.timeoutMs, 40);
    assert.ok(aborted, 'the request was aborted');
    const deaf = await push.send(CFG.ntfy, MSG, { fetch: () => new Promise(() => {}), timeoutMs: 40 });
    assert.strictEqual(deaf.code, 'timeout');
    assert.ok(Date.now() - t0 < 2000, 'both resolved promptly');
    assert.strictEqual(push.DEFAULT_TIMEOUT_MS, 10000);
  });

  test('redact: no secret survives any error path of any channel', async () => {
    const leaks = [];
    const check = (id, where, text) => {
      for (const n of NEEDLES[id]) if (String(text).includes(n) || String(text).includes(encodeURIComponent(n))) leaks.push(`${id} ${where}: ${n}`);
    };
    // Answers that echo the whole request back into the error text
    const echo = (url, init) => `${url} ${JSON.stringify(init.headers)} ${init.body}`;
    for (const id of push.CHANNEL_IDS) {
      const cfg = CFG[id];
      const paths = {
        // 2xx with an error body (only for vendors that answer that way; ntfy, Discord and Slack treat 2xx as sent)
        rejected: ['ntfy', 'discord', 'slack'].includes(id) ? null : fakeFetch((url, init) => ({ status: 200, text: JSON.stringify({ code: 1, errcode: 1, ok: false, msg: echo(url, init), errmsg: echo(url, init), description: echo(url, init), message: echo(url, init) }) })),
        httpJson: fakeFetch((url, init) => ({ status: 400, text: JSON.stringify({ message: echo(url, init), error: echo(url, init) }) })),
        httpText: fakeFetch((url, init) => ({ status: 500, text: echo(url, init) })),
        network: async (url, init) => { throw new Error(`request to ${echo(url, init)} failed`); },
        networkCause: async (url) => { const e = new TypeError('fetch failed'); e.cause = { message: `connect to ${url}` }; throw e; },
        redirect: fakeFetch((url) => ({ status: 302, text: `moved from ${url}` })),
      };
      for (const [where, f] of Object.entries(paths)) {
        if (!f) continue;
        const r = await push.send(cfg, MSG, { fetch: f, clock: () => NOW });
        assert.strictEqual(r.ok, false, `${id} ${where}`);
        check(id, where, r.error);
        check(id, `${where} (described)`, push.describeError(r, en, { channel: id }));
      }
      const timeout = await push.send(cfg, MSG, { fetch: () => new Promise(() => {}), timeoutMs: 5 });
      check(id, 'timeout', timeout.error);
      // An invalid value next to the secrets: the config error names the field, never a value
      const broken = await push.send({ ...cfg, dailyMax: 'x' }, MSG, { fetch: fakeFetch() });
      assert.strictEqual(broken.code, 'config');
      check(id, 'config', broken.error);
      check(id, 'config (described)', push.describeError(broken, en, { channel: id }));
    }
    assert.deepStrictEqual(leaks, []);
  });

  test('redact: masks config secrets (also URL-encoded) and known token shapes without a config; keeps harmless text', () => {
    assert.strictEqual(push.redact(`bad topic ${K.ntfyTopic}`, CFG.ntfy), 'bad topic ***');
    assert.strictEqual(push.redact(`x ${encodeURIComponent(K.feishuSecret + '/+')}`, { channel: 'feishu', webhook: K.feishuHook, secret: `${K.feishuSecret}/+` }), 'x ***');
    const bare = push.redact(`POST https://api.telegram.org/bot${K.tgToken}/sendMessage; ${K.dingHook}; Authorization: Bearer ${K.ntfyToken}; `
      + `${K.slackHook} ${K.discordHook} ${K.feishuHook} key=${K.sctKey} https://9876.push.ft07.com/send/${K.sctpKey}.send ${K.dingSecret}`);
    for (const id of push.CHANNEL_IDS) for (const n of NEEDLES[id]) {
      if (id === 'ntfy' && n === K.ntfyTopic) continue; // a bare topic name has no recognizable shape
      if (id === 'bark') continue; // likewise a bare device key
      assert.ok(!bare.includes(n), `${id}: ${n} in ${bare}`);
    }
    assert.strictEqual(push.redact('HTTP 404: Unknown Webhook', CFG.discord), 'HTTP 404: Unknown Webhook');
    assert.strictEqual(push.redact('open-apis webhooks sendMessage', CFG.feishu), 'open-apis webhooks sendMessage');
    assert.strictEqual(push.redact(null), '');
  });

  test('redact: a secret straddling the 200-character cut leaks no part of it (bark, ntfy, telegram, network errors)', async () => {
    // Filler so that half the secret lies before the cut: 'HTTP 4xx: ' + before + filler + after + secret
    const pad = (secret, before, after) => 'z'.repeat(200 - 'HTTP 400: '.length - before.length - after.length - Math.floor(secret.length / 2));
    const around = (secret, before, after) => `${before}${pad(secret, before, after)}${after}${secret}`;
    const cases = [
      ['bark', K.barkKey, (sec) => ({ status: 400, text: `${around(sec, 'device ', ' ')} not registered` })],
      ['ntfy', K.ntfyTopic, (sec) => ({ status: 502, text: `${around(sec, 'bad gateway ', ' https://ntfy.sh/')}/json` })],
      ['telegram', K.tgToken, (sec) => ({ status: 500, text: `${around(sec, '', ' ')} failed` })],
    ];
    for (const [id, secret, answer] of cases) {
      const r = await push.send(CFG[id], MSG, { fetch: fakeFetch(() => answer(secret)) });
      assert.strictEqual(r.ok, false);
      for (let n = 6; n <= secret.length; n++) {
        const piece = secret.slice(0, n);
        assert.ok(!r.error.includes(piece) || /^[0-9]+$/.test(piece), `${id}: ${piece} in ${r.error}`);
      }
      assert.ok(r.error.includes('***'), r.error);
    }
    const net = await push.send(CFG.bark, MSG, {
      fetch: async () => { throw new Error(`${'n'.repeat(190)} ${K.barkKey}`); },
    });
    assert.strictEqual(net.code, 'network');
    assert.ok(!net.error.includes(K.barkKey.slice(0, 6)), net.error);
  });

  test('describeError: vendor text cannot plant a clickable link in a VS Code notification', async () => {
    const hostile = 'Invalid key. [Open docs](command:workbench.action.terminal.new)';
    for (const [answer, code] of [[{ status: 400, text: hostile }, 'http'], [{ status: 200, text: JSON.stringify({ code: 400, message: hostile }) }, 'rejected']]) {
      const r = await push.send(CFG.bark, MSG, { fetch: fakeFetch(answer) });
      assert.strictEqual(r.code, code);
      const shown = push.describeError(r, en, { channel: 'bark' });
      assert.ok(shown.includes(']\u200b('), shown);
      assert.ok(!/\]\s*\(/.test(shown), shown);
    }
    const net = push.describeError({ code: 'network', error: '[x](https://evil.example)' }, en);
    assert.ok(!/\]\s*\(/.test(net), net);
    assert.ok(!/\]\s*\(/.test(push.describeError({ code: 'weird', error: '[x] (command:y)' }, en)));
  });

  test('send: at most 16 KB of the response body is read; a server that streams forever is not buffered', async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode('x'.repeat(4096));
    const body = new ReadableStream({
      pull(ctrl) { pulls++; ctrl.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    const r = await push.send(CFG.ntfy, MSG, { fetch: async () => ({ status: 500, body, text: async () => { throw new Error('text() must not be used'); } }) });
    assert.strictEqual(r.code, 'http');
    assert.ok(pulls <= 6, `pulled ${pulls} chunks`);
    assert.ok(cancelled, 'the stream was cancelled');
    const ok = await push.send(CFG.telegram, MSG, {
      fetch: async () => ({ status: 200, body: new Blob([JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' })]).stream() }),
    });
    assert.deepStrictEqual([ok.code, ok.error], ['rejected', 'Bad Request: chat not found (400)']);
  });

  test('describeError: localized reasons for every failure code', () => {
    const cases = [
      [{ code: 'timeout', timeoutMs: 10000 }, 'no answer within 10 s', '10 秒内没有响应'],
      [{ code: 'network', error: 'ENOTFOUND' }, 'couldn\'t connect (ENOTFOUND)', '无法连接（ENOTFOUND）'],
      [{ code: 'redirect', status: 302 }, 'the server redirected the request. Check the address.', '服务器要求跳转，请检查地址。'],
      [{ code: 'http', status: 502, error: 'HTTP 502' }, 'the server answered HTTP 502', '服务器返回 HTTP 502'],
      [{ code: 'http', status: 403, error: 'HTTP 403: invalid_token' }, 'the server answered HTTP 403: invalid_token', '服务器返回 HTTP 403：invalid_token'],
      [{ code: 'rejected', status: 200, error: 'keywords not in content (310000)' }, 'the service refused it: keywords not in content (310000)', '服务返回错误：keywords not in content (310000)'],
    ];
    for (const [r, wantEn, wantZh] of cases) {
      assert.strictEqual(push.describeError(r, en), wantEn);
      assert.strictEqual(push.describeError(r, zh), wantZh);
    }
    const cfgErr = { code: 'config', field: 'webhook', problem: 'host' };
    assert.strictEqual(push.describeError(cfgErr, en, { channel: 'slack' }), 'Webhook URL: This isn\'t the service\'s own address. It should be on hooks.slack.com.');
    assert.strictEqual(push.describeError(cfgErr, zh, { channel: 'slack' }), 'Webhook 地址：这不是该服务的官方地址，应为 hooks.slack.com。');
    assert.strictEqual(en.t('push.ui.testFailed', { error: push.describeError(cases[0][0], en) }), 'Channel test failed: no answer within 10 s');
  });
}

// ---------- Tracker ----------

function trackerTests() {
  test('first update only seeds: waiting / failed sessions and current limit hits are not reported', () => {
    const tr = push.createPushTracker();
    const sid = session().key;
    const list = [asking(NOW - MIN), failing(NOW - MIN, { id: 'bbbbbbbb-1111-2222-3333-444444444444' })];
    assert.deepStrictEqual(feed(tr, list, NOW, claudeHit(NOW - MIN, NOW + HOUR, sid)), []);
    assert.deepStrictEqual(feed(tr, list, NOW + SEC, claudeHit(NOW - MIN, NOW + HOUR, sid)), []);
    const late = push.createPushTracker();
    assert.deepStrictEqual(feed(late, list, NOW), []);
    assert.deepStrictEqual(feed(late, list, NOW + SEC, claudeHit(NOW - MIN, NOW + HOUR, sid)), [], 'the first quota snapshot seeds on its own');
    assert.deepStrictEqual(late.update(undefined), [], 'bad input is ignored');
  });

  test('needsYou: transition reported once with the same transitionId as the desktop notification', () => {
    const tr = push.createPushTracker();
    const desk = notify.createNeedsYouTracker();
    const sub = agent({ id: 'agent-7f3a', kind: 'subagent', name: 'code-reviewer', agentType: 'Explore', status: st('awaitingApproval', NOW - 4000, { pendingTool: 'Bash' }) });
    const before = [working()];
    const after = [session({ agents: [sub], main: agent({ status: st('tool', NOW - 9000, { pendingTool: 'Agent' }) }) })];
    feed(tr, before);
    desk.update(before, lampsOf(before));
    const out = feed(tr, after);
    const d = desk.update(after, lampsOf(after));
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0], {
      type: 'needsYou', key: after[0].key, transitionId: d[0].transitionId, title: 'Refactor the parser', titleSource: 'ai',
      project: 'demo-app', agentName: 'code-reviewer', provider: 'claude',
    });
    assert.strictEqual(out[0].transitionId, `${after[0].key}|a/agent-7f3a|${NOW - 4000}`);
    assert.deepStrictEqual(feed(tr, after), [], 'not again while it keeps waiting');
    feed(tr, before);
    assert.deepStrictEqual(feed(tr, after), [], 'a flicker of the same wait is not reported twice');
    feed(tr, before, NOW + MIN);
    const later = feed(tr, [asking(NOW + 2 * MIN)], NOW + 2 * MIN);
    assert.strictEqual(later.length, 1, 'a new wait is reported');
  });

  test('error: an API error is reported with its own id; a usage-limit error is left to the limit events', () => {
    const tr = push.createPushTracker();
    feed(tr, [working()]);
    const out = feed(tr, [failing(NOW - 2000)]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].type, 'error');
    assert.strictEqual(out[0].transitionId, `error|${session().key}|main|${NOW - 2000}`);
    const tr2 = push.createPushTracker();
    feed(tr2, [working()]);
    assert.deepStrictEqual(feed(tr2, [limited(NOW - 2000)]), []);
    // error → needsYou: both are transitions
    const tr3 = push.createPushTracker();
    feed(tr3, [failing(NOW - 5000)]);
    assert.deepStrictEqual(feed(tr3, [asking(NOW - 1000)]).map((e) => e.type), ['needsYou']);
  });

  test('stale transitions (a session that just came into scope, waiting for an hour) are not pushed', () => {
    const tr = push.createPushTracker();
    feed(tr, []);
    assert.deepStrictEqual(feed(tr, [asking(NOW - HOUR)]), []);
    const tr2 = push.createPushTracker({ maxAgeMs: 2 * HOUR });
    feed(tr2, []);
    assert.strictEqual(feed(tr2, [asking(NOW - HOUR)]).length, 1);
  });

  test('limitHit / limitReset (Claude): ids from the reset time, reset reported once when the time passes', () => {
    const tr = push.createPushTracker();
    const s = asking(NOW - 10 * MIN);
    const reset = NOW + 2 * HOUR;
    feed(tr, [s], NOW, emptyQuota());
    const hit = feed(tr, [s], NOW, claudeHit(NOW - 2000, reset, s.key));
    assert.deepStrictEqual(hit, [{
      type: 'limitHit', transitionId: `limitHit|claude|${reset}`, key: s.key, title: 'Refactor the parser', titleSource: 'ai',
      project: 'demo-app', agentName: null, provider: 'claude', resetAt: reset,
    }]);
    assert.deepStrictEqual(feed(tr, [s], NOW + MIN, claudeHit(NOW + 30 * SEC, reset, s.key)), [], 'another hit of the same limit is not news');
    assert.deepStrictEqual(feed(tr, [s], reset - SEC, claudeHit(NOW - 2000, reset, s.key)), []);
    const r = feed(tr, [s], reset + SEC, claudeHit(NOW - 2000, reset, s.key));
    assert.deepStrictEqual(r.map((e) => [e.type, e.transitionId, e.resetAt]), [['limitReset', `limitReset|claude|${reset}`, reset]]);
    assert.deepStrictEqual(feed(tr, [s], reset + MIN, claudeHit(NOW - 2000, reset, s.key)), []);
  });

  test('limitHit / limitReset (Copilot): its lastHit works like Claude\'s, and the message names the tool', () => {
    const tr = push.createPushTracker();
    const s = asking(NOW - 10 * MIN);
    const reset = NOW + 2 * HOUR;
    const hitOf = (provider, ms, resetsAtMs) => ({ ...emptyQuota(), [provider]: { lastHit: { kind: 'unknown', model: null, resetsAtMs, resetsText: null, source: 'turnError', autoContinue: null, ms, sessionKey: s.key } } });
    feed(tr, [s], NOW, { ...emptyQuota(), copilot: { lastHit: null } });
    const cp = feed(tr, [s], NOW, hitOf('copilot', NOW - 2000, null));
    assert.deepStrictEqual(cp.map((e) => [e.type, e.provider, e.transitionId, e.resetAt, e.key]), [['limitHit', 'copilot', `limitHit|copilot|at${NOW - 2000}`, null, s.key]]);
    assert.deepStrictEqual(feed(tr, [s], NOW + SEC, hitOf('copilot', NOW - 2000, null)), [], 'the same hit is not news any more');
    const cr = feed(tr, [s], NOW + 2 * SEC, hitOf('copilot', NOW - 1000, reset));
    assert.deepStrictEqual(cr.map((e) => [e.type, e.provider, e.resetAt]), [['limitHit', 'copilot', reset]]);
    const r = feed(tr, [s], reset + SEC, hitOf('copilot', NOW - 1000, reset));
    assert.deepStrictEqual(r.map((e) => [e.type, e.transitionId]), [['limitReset', `limitReset|copilot|${reset}`]]);
    // the tool is named in every language (never the raw id)
    for (const i18n of [en, zh, i18nLib.createI18n('ja'), i18nLib.createI18n('ko'), i18nLib.createI18n('zh-tw')]) {
      const title = push.formatPush([{ ...cp[0], transitionId: 'copilot' }], i18n).title;
      assert.ok(title.includes('Copilot'), `${i18n.locale || ''}: ${title}`);
    }
  });

  test('limits seen at seeding: no limitHit, but the reset is still reported; past resets and old hits are ignored', () => {
    const tr = push.createPushTracker();
    const reset = NOW + HOUR;
    assert.deepStrictEqual(feed(tr, [], NOW, claudeHit(NOW - 3 * HOUR, reset, 'claude:x')), []);
    assert.deepStrictEqual(feed(tr, [], reset + SEC, claudeHit(NOW - 3 * HOUR, reset, 'claude:x')).map((e) => e.type), ['limitReset']);
    const tr2 = push.createPushTracker();
    feed(tr2, [], NOW, emptyQuota());
    assert.deepStrictEqual(feed(tr2, [], NOW, claudeHit(NOW - 5 * HOUR, NOW - HOUR, 'claude:x')), [], 'already reset');
    assert.deepStrictEqual(feed(tr2, [], NOW, claudeHit(NOW - 3 * HOUR, NOW + HOUR, 'claude:y')), [], 'hit long ago');
    const tr3 = push.createPushTracker();
    feed(tr3, [], NOW, claudeHit(NOW - MIN, NOW + HOUR, 'claude:x'));
    assert.deepStrictEqual(feed(tr3, [], NOW + 5 * HOUR, claudeHit(NOW - MIN, NOW + HOUR, 'claude:x')), [], 'slept through the reset');
  });

  test('limitHit (Codex): a full window or rate_limit_reached_type; the id is stable while observations move', () => {
    const tr = push.createPushTracker();
    const R = NOW + 3 * HOUR;
    feed(tr, [], NOW, codexQuota(NOW - HOUR, [{ minutes: 300, usedPct: 80, resetsAtMs: R, label: '5h' }]));
    const hit = feed(tr, [], NOW, codexQuota(NOW - SEC, [{ minutes: 300, usedPct: 100, resetsAtMs: R, label: '5h' }, { minutes: 10080, usedPct: 40, resetsAtMs: R + 86400e3, label: 'weekly' }]));
    assert.deepStrictEqual(hit.map((e) => [e.type, e.transitionId, e.provider, e.resetAt, e.key]), [['limitHit', `limitHit|codex|${R}`, 'codex', R, 'quota:codex']]);
    assert.deepStrictEqual(feed(tr, [], NOW + MIN, codexQuota(NOW + 30 * SEC, [{ minutes: 300, usedPct: 100, resetsAtMs: R, label: '5h' }])), []);
    const tr2 = push.createPushTracker();
    feed(tr2, [], NOW, emptyQuota());
    const a = feed(tr2, [], NOW, codexQuota(NOW - SEC, [], 'rate_limit_reached'));
    assert.deepStrictEqual(a.map((e) => e.transitionId), [`limitHit|codex|at${NOW - SEC}`]);
    assert.deepStrictEqual(feed(tr2, [], NOW + MIN, codexQuota(NOW + 50 * SEC, [], 'rate_limit_reached')), [], 'same hit, later observation');
    feed(tr2, [], NOW + 2 * MIN, emptyQuota());
    assert.strictEqual(feed(tr2, [], NOW + 3 * MIN, codexQuota(NOW + 3 * MIN, [], 'rate_limit_reached')).length, 1, 'a new hit after it cleared');
  });

  test('limitHit (Codex, resets_in_seconds): a reset time that drifts between lines is one hit and one reset', () => {
    const quota = require('../lib/core/quota');
    const R = NOW + 3 * HOUR + 17 * SEC + 400;
    // Each line resolves resets_in_seconds (whole seconds) against its own time, so the reset time moves by up to a second
    const line = (t) => ({
      ...emptyQuota(),
      codex: quota.codexQuota({
        primary: { used_percent: 100, window_minutes: 300, resets_in_seconds: Math.round((R - t) / 1000) },
        rate_limit_reached_type: 'rate_limit_reached',
      }, t),
    });
    const obs = [NOW - 7300, NOW, NOW + 7300, NOW + 14600, NOW + 21900].map((t) => t + 137);
    const resets = obs.map((t) => line(t).codex.windows[0].resetsAtMs);
    assert.ok(new Set(resets).size > 1, `the raw reset times drift: ${resets}`);
    const run = (list, t0) => {
      const tr = push.createPushTracker();
      feed(tr, [], t0, emptyQuota());
      const hits = [];
      for (const t of list) hits.push(...feed(tr, [], t + 50, line(t)));
      const done = feed(tr, [], R + MIN + SEC, line(list[list.length - 1]));
      return { hits, done };
    };
    const a = run(obs, NOW - 8000);
    assert.deepStrictEqual(a.hits.map((e) => e.type), ['limitHit'], 'one limitHit');
    assert.strictEqual(a.hits[0].transitionId, `limitHit|codex|${NOW + 3 * HOUR + MIN}`, 'rounded up to the minute');
    assert.deepStrictEqual(a.done.map((e) => [e.type, e.transitionId]), [['limitReset', `limitReset|codex|${NOW + 3 * HOUR + MIN}`]], 'one limitReset');
    const b = run(obs.slice(2), NOW - 8000);
    assert.strictEqual(b.hits[0].transitionId, a.hits[0].transitionId, 'another window seeing other lines derives the same id');
  });

  test('ids never depend on the local clock: two windows at different times derive the same ids', () => {
    const run = (t0) => {
      const tr = push.createPushTracker({ maxAgeMs: 10 * HOUR });
      feed(tr, [working()], t0, emptyQuota());
      return feed(tr, [failing(NOW - 3000)], t0 + 777, claudeHit(NOW - 2000, NOW + 5 * HOUR, session().key)).map((e) => e.transitionId);
    };
    const a = run(NOW);
    assert.strictEqual(a.length, 2);
    assert.deepStrictEqual(run(NOW + 37 * MIN), a);
  });

  test('isStillActive: same wait → true; answered or a different wait → false; limit events always hold; currentEventOf follows the wait', () => {
    const tr = push.createPushTracker();
    feed(tr, [working()]);
    const [ev] = feed(tr, [asking(NOW - 1000)]);
    const still = [asking(NOW - 1000)];
    assert.strictEqual(push.isStillActive(ev, still, lampsOf(still)), true);
    assert.strictEqual(push.isStillActive(ev, still), true, 'lamps computed when omitted');
    assert.strictEqual(push.isStillActive(ev, [working()], lampsOf([working()])), false);
    const again = [asking(NOW + MIN)];
    assert.strictEqual(push.isStillActive(ev, again, lampsOf(again)), false);
    assert.strictEqual(push.isStillActive(ev, [], lampsOf([])), false);
    assert.strictEqual(push.isStillActive({ type: 'limitHit', transitionId: 'x' }, []), true);
    // currentEventOf: the session's wait as it stands now, whatever its id; null once answered
    assert.deepStrictEqual(push.currentEventOf(ev, still, lampsOf(still)), ev);
    assert.strictEqual(push.currentEventOf(ev, again, lampsOf(again)).transitionId, `${session().key}|main|${NOW + MIN}`);
    assert.strictEqual(push.currentEventOf(ev, [working()], lampsOf([working()])), null);
    assert.strictEqual(push.currentEventOf(ev, []), null);
    const lim = { type: 'limitHit', transitionId: 'x' };
    assert.strictEqual(push.currentEventOf(lim, []), lim);
  });
}

// ---------- Policy ----------

function policyTests() {
  const ev = (type, id = 'claude:a|main|1') => ({ type, transitionId: id, key: 'claude:a' });
  test('normalizeSettings: off by default, all events on, 30 s delay, no chat titles; values clamped', () => {
    assert.deepStrictEqual(push.normalizeSettings(undefined), {
      enabled: false,
      events: { needsYou: true, error: true, limitHit: true, limitReset: true, usageHigh: true, costDaily: true, contextHigh: true },
      delaySeconds: 30,
      includeTitle: false,
    });
    assert.deepStrictEqual(push.ALERT_EVENT_TYPES, alerts.ALERT_TYPES.slice(), 'the threshold alerts of lib/alerts.js');
    assert.deepStrictEqual(push.EVENT_TYPES.slice(-3), ['usageHigh', 'costDaily', 'contextHigh'], 'new events come last (setting and picker order)');
    assert.strictEqual(push.normalizeSettings({ events: { costDaily: false } }).events.costDaily, false);
    const s = push.normalizeSettings({ enabled: 'yes', delaySeconds: -5, includeTitle: 1, events: { limitReset: false } });
    assert.strictEqual(s.enabled, false, 'only true turns it on');
    assert.strictEqual(s.delaySeconds, 0);
    assert.strictEqual(s.includeTitle, false);
    assert.strictEqual(s.events.limitReset, false);
    assert.strictEqual(push.normalizeSettings({ delaySeconds: 1e9 }).delaySeconds, 3600);
  });

  test('plan: off → drop; needsYou waits the delay, then sends only if still waiting; error and limits go out now', () => {
    const on = { enabled: true };
    assert.deepStrictEqual(push.plan({ event: ev('needsYou'), settings: {} }), { action: 'drop', delayMs: 0, claimId: 'push|claude:a|main|1', reason: 'off' });
    assert.deepStrictEqual(push.plan({ event: ev('needsYou'), settings: on }), { action: 'wait', delayMs: 30000, claimId: 'push|claude:a|main|1' });
    assert.deepStrictEqual(push.plan({ event: ev('needsYou'), settings: on, stillActive: true }), { action: 'send', delayMs: 0, claimId: 'push|claude:a|main|1' });
    assert.strictEqual(push.plan({ event: ev('needsYou'), settings: on, stillActive: false }).action, 'drop');
    assert.strictEqual(push.plan({ event: ev('needsYou'), settings: { enabled: true, delaySeconds: 0 } }).action, 'send');
    assert.strictEqual(push.plan({ event: ev('needsYou'), settings: { enabled: true, delaySeconds: 90 } }).delayMs, 90000);
    for (const t of ['error', 'limitHit', 'limitReset']) assert.strictEqual(push.plan({ event: ev(t), settings: on }).action, 'send', t);
    // threshold alerts go out at once, even with a needsYou delay set
    for (const t of ['usageHigh', 'costDaily', 'contextHigh']) {
      assert.deepStrictEqual(push.plan({ event: ev(t, `${t}|x`), settings: { enabled: true, delaySeconds: 90 } }), { action: 'send', delayMs: 0, claimId: `push|${t}|x` }, t);
      assert.strictEqual(push.plan({ event: ev(t), settings: { enabled: true, events: { [t]: false } } }).reason, 'eventOff', t);
    }
    assert.strictEqual(push.plan({ event: ev('error'), settings: { enabled: true, events: { error: false } } }).reason, 'eventOff');
    assert.strictEqual(push.plan({ event: { type: 'other', transitionId: 'x' }, settings: on }).action, 'drop');
    assert.strictEqual(push.plan({}).action, 'drop');
  });

  test('cross-window: the push claim is separate from the desktop claim of the same wait, and only one window wins it', () => {
    const dir = path.join(TMP, 'claims');
    const id = 'claude:a|main|123';
    const p = push.plan({ event: ev('needsYou', id), settings: { enabled: true }, stillActive: true });
    assert.ok(notify.claimOnce(dir, id, NOW), 'desktop notification claims the wait');
    assert.ok(notify.claimOnce(dir, p.claimId, NOW), 'push claims it separately');
    assert.strictEqual(notify.claimOnce(dir, p.claimId, NOW), false, 'a second window does not push it again');
  });

  test('limiter: events within the coalescing window go out as one batch; duplicates collapse', () => {
    const lim = push.createLimiter({ coalesceMs: 3000 });
    assert.strictEqual(lim.nextAt(), null);
    assert.strictEqual(lim.add('ntfy', ev('error', 'e1'), NOW), NOW + 3000);
    lim.add('ntfy', ev('limitHit', 'l1'), NOW + 1000);
    lim.add('ntfy', ev('limitHit', 'l1'), NOW + 1500);
    assert.strictEqual(lim.nextAt(), NOW + 3000);
    assert.deepStrictEqual(lim.due(NOW + 2999), { batches: [], dropped: [], nextAt: NOW + 3000 });
    const { batches, nextAt } = lim.due(NOW + 3000);
    assert.deepStrictEqual(batches.map((b) => [b.channel, b.events.map((e) => e.transitionId)]), [['ntfy', ['e1', 'l1']]]);
    assert.strictEqual(nextAt, null);
    assert.strictEqual(lim.nextAt(), null);
  });

  test('limiter: per-channel minimum gap holds the next batch (and coalesces what arrives meanwhile); channels are independent', () => {
    const lim = push.createLimiter({ perChannelMinMs: 10000, coalesceMs: 1000 });
    lim.add('ntfy', ev('error', 'a'), NOW);
    lim.add('slack', ev('error', 'a'), NOW);
    assert.strictEqual(lim.due(NOW + 1000).batches.length, 2);
    lim.add('ntfy', ev('error', 'b'), NOW + 2000);
    lim.add('ntfy', ev('error', 'c'), NOW + 5000);
    assert.strictEqual(lim.nextAt(), NOW + 11000);
    assert.deepStrictEqual(lim.due(NOW + 10999).batches, []);
    assert.deepStrictEqual(lim.due(NOW + 11000).batches.map((b) => b.events.map((e) => e.transitionId)), [['b', 'c']]);
  });

  test('limiter: hourly cap and per-channel daily cap drop instead of sending late (ServerChan: 5 a day)', () => {
    const lim = push.createLimiter({ perChannelMinMs: 0, coalesceMs: 0, perHourMax: 3 });
    const sendAt = (t, ch = 'ntfy', dailyMax) => { lim.add(ch, ev('error', `x${t}`), t, { dailyMax }); return lim.due(t); };
    for (let i = 0; i < 3; i++) assert.strictEqual(sendAt(NOW + i * MIN).batches.length, 1);
    const capped = sendAt(NOW + 3 * MIN);
    assert.deepStrictEqual([capped.batches.length, capped.dropped.map((d) => d.reason)], [0, ['hourly']]);
    assert.strictEqual(sendAt(NOW + HOUR + SEC).batches.length, 1, 'the hour rolled over');

    const sc = push.createLimiter({ perChannelMinMs: 0, coalesceMs: 0, perHourMax: 0 });
    const daily = push.withDefaults({ channel: 'serverchan', sendKey: K.sctKey }).dailyMax;
    const scSend = (t) => { sc.add('serverchan', ev('error', `s${t}`), t, { dailyMax: daily }); return sc.due(t); };
    for (let i = 0; i < 5; i++) assert.strictEqual(scSend(NOW + i * HOUR).batches.length, 1);
    assert.deepStrictEqual(scSend(NOW + 5 * HOUR).dropped.map((d) => d.reason), ['daily']);
    assert.strictEqual(sc.count('serverchan', NOW + 5 * HOUR), 5);
    assert.strictEqual(scSend(NOW + 24 * HOUR + SEC).batches.length, 1, '24 hours after the first send');
  });

  test('limiter: an event queued longer than maxQueueMs is dropped as stale, never sent hours late with a newer one', () => {
    const lim = push.createLimiter({ coalesceMs: 3000, perChannelMinMs: 0, maxQueueMs: 15 * MIN });
    lim.add('ntfy', ev('needsYou', 'old'), NOW);
    lim.add('ntfy', ev('error', 'new'), NOW + 2 * HOUR);
    const r = lim.due(NOW + 2 * HOUR + 3000);
    assert.deepStrictEqual(r.dropped.map((d) => [d.reason, d.events.map((e) => e.transitionId)]), [['stale', ['old']]]);
    assert.deepStrictEqual(r.batches.map((b) => b.events.map((e) => e.transitionId)), [['new']]);
    const only = push.createLimiter({ maxQueueMs: MIN });
    only.add('slack', ev('error', 'x'), NOW);
    assert.deepStrictEqual(only.due(NOW + 2 * MIN), { batches: [], dropped: [{ channel: 'slack', events: [ev('error', 'x')], reason: 'stale' }], nextAt: null });
    const def = push.createLimiter({ coalesceMs: 0, perChannelMinMs: 0 });
    def.add('ntfy', ev('error', 'y'), NOW);
    assert.deepStrictEqual(def.due(NOW + 16 * MIN).dropped.map((d) => d.reason), ['stale'], 'default: 15 minutes');
  });

  test('limiter: a shared store makes the gap and the caps hold across windows; fileStore round-trips and survives corruption', () => {
    let saved = null;
    const mem = { load: () => (saved ? JSON.parse(JSON.stringify(saved)) : null), save: (o) => { saved = o; } };
    const a = push.createLimiter({ coalesceMs: 0, perChannelMinMs: 10000, store: mem });
    const b = push.createLimiter({ coalesceMs: 0, perChannelMinMs: 10000, store: mem });
    a.add('ntfy', ev('error', 'a'), NOW);
    assert.strictEqual(a.due(NOW).batches.length, 1);
    b.add('ntfy', ev('error', 'b'), NOW + 1000);
    assert.deepStrictEqual(b.due(NOW + 1000).batches, [], 'window B sees window A\'s send');
    assert.strictEqual(b.due(NOW + 10000).batches.length, 1);
    const file = path.join(TMP, 'push-sent.json');
    const fsStore = push.fileStore(file);
    assert.strictEqual(fsStore.load(), null);
    fsStore.save({ ntfy: [NOW] });
    assert.deepStrictEqual(fsStore.load(), { ntfy: [NOW] });
    fs.writeFileSync(file, '{broken');
    assert.strictEqual(fsStore.load(), null);
    // Another window's send after this window last looked: add() already counts it, and due() says when to look again
    let shared = { ntfy: [NOW + 20000] };
    const store2 = { load: () => JSON.parse(JSON.stringify(shared)), save: (o) => { shared = o; } };
    const w = push.createLimiter({ coalesceMs: 3000, perChannelMinMs: 10000, store: store2 });
    shared = { ntfy: [NOW + 20000] };
    assert.strictEqual(w.add('ntfy', ev('needsYou', 'w1'), NOW + 24000), NOW + 30000, 'ready after the other window\'s gap');
    shared = { ntfy: [NOW + 20000, NOW + 26000] };
    const early = w.due(NOW + 30000);
    assert.deepStrictEqual([early.batches.length, early.nextAt], [0, NOW + 36000], 'pushed back by a send in between: re-arm at nextAt');
    assert.deepStrictEqual(w.due(early.nextAt).batches.map((b) => b.events.map((e) => e.transitionId)), [['w1']]);
    const c = push.createLimiter({ coalesceMs: 0, store: fsStore });
    c.add('ntfy', ev('error', 'c'), NOW);
    assert.strictEqual(c.due(NOW).batches.length, 1, 'a corrupt store does not block sending');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ntfy: [NOW] });
  });
}

// ---------- Formatting ----------

function formatTests() {
  const needs = {
    type: 'needsYou', key: 'claude:a', transitionId: 'claude:a|main|1', title: 'Refactor the parser for /Users/someone/secret',
    titleSource: 'custom', project: 'demo-app', agentName: null, provider: 'claude',
  };
  const needsSub = { ...needs, transitionId: 'claude:a|a/x|2', agentName: 'code-reviewer', title: 'Refactor the parser' };
  const err = { ...needs, type: 'error', transitionId: 'error|claude:b|main|3', project: 'api-server', title: 'Fix login' };
  const hit = { type: 'limitHit', key: 'quota:codex', transitionId: 'limitHit|codex|9', title: '', project: null, agentName: null, provider: 'codex', resetAt: NOW + HOUR };
  const reset = { ...hit, type: 'limitReset', transitionId: 'limitReset|claude|9', provider: 'claude' };
  const clock = () => '11:00';

  test('default content: project name and state only (en and zh-cn)', () => {
    assert.deepStrictEqual(push.formatPush([needs], en), {
      title: 'Agent needs you · demo-app', body: 'A chat is waiting for your reply or approval.', priority: 'high', event: 'needsYou',
    });
    assert.deepStrictEqual(push.formatPush([needs], zh), {
      title: '智能体需要你 · demo-app', body: '有对话正在等你回复或批准。', priority: 'high', event: 'needsYou',
    });
    for (const m of [push.formatPush([needsSub], en), push.formatPush([needs, needsSub, err], zh)]) {
      const all = `${m.title}\n${m.body}`;
      for (const s of ['Refactor', 'code-reviewer', 'Fix login', '/Users', 'secret']) assert.ok(!all.includes(s), `${s} leaked: ${all}`);
    }
    assert.deepStrictEqual(push.formatPush([{ ...needs, project: null }], en).title, 'Agent needs you');
    assert.deepStrictEqual(push.formatPush([err], en), {
      title: 'Agent stopped with an error · api-server', body: 'A chat stopped because of an API error.', priority: 'high', event: 'error',
    });
  });

  test('includeTitle adds the chat title and agent name (cleaned and capped)', () => {
    assert.strictEqual(push.formatPush([needsSub], en, { includeTitle: true }).body, 'Refactor the parser · code-reviewer is waiting for your reply or approval');
    assert.strictEqual(push.formatPush([needsSub], zh, { includeTitle: true }).body, 'Refactor the parser · code-reviewer 正在等你回复或批准');
    assert.strictEqual(push.formatPush([err], en, { includeTitle: true }).body, 'Fix login stopped because of an API error');
    const long = push.formatPush([{ ...needs, title: `x\n${'y'.repeat(200)}` }], en, { includeTitle: true }).body;
    assert.ok(!long.includes('\n') && long.includes('…'), long);
  });

  test('includeTitle never sends a title made from the prompt or the session id', () => {
    const prompt = 'fix the bug in payroll.ts, password is hunter2';
    for (const titleSource of ['prompt', 'id', null, undefined, 'other']) {
      const m = push.formatPush([{ ...needsSub, title: prompt, titleSource }], en, { includeTitle: true });
      assert.ok(!`${m.title}\n${m.body}`.includes('payroll'), `${titleSource}: ${m.body}`);
      assert.strictEqual(m.body, 'A chat is waiting for your reply or approval.');
    }
    for (const titleSource of ['custom', 'ai', 'index']) {
      assert.ok(push.formatPush([{ ...needsSub, titleSource }], en, { includeTitle: true }).body.startsWith('Refactor the parser'), titleSource);
    }
    // The tracker leaves such a title out of the event itself
    const tr = push.createPushTracker();
    feed(tr, [working({ title: prompt, titleSource: 'prompt' })]);
    const [e] = feed(tr, [asking(NOW - 1000, { title: prompt, titleSource: 'prompt' })]);
    assert.deepStrictEqual([e.type, e.title, e.titleSource], ['needsYou', '', 'prompt']);
    const tr2 = push.createPushTracker();
    const s = asking(NOW - 10 * MIN, { title: prompt, titleSource: 'prompt' });
    feed(tr2, [s], NOW, emptyQuota());
    const [h] = feed(tr2, [s], NOW, claudeHit(NOW - 2000, NOW + HOUR, s.key));
    assert.deepStrictEqual([h.type, h.title], ['limitHit', '']);
    const [r] = feed(tr2, [s], NOW + HOUR + SEC, claudeHit(NOW - 2000, NOW + HOUR, s.key));
    assert.deepStrictEqual([r.type, r.title], ['limitReset', '']);
  });

  test('limit events: provider and reset time; never chat titles or numbers of tokens / cost', () => {
    assert.deepStrictEqual(push.formatPush([hit], en, { fmtClock: clock }), {
      title: 'Codex usage limit reached', body: 'Resets 11:00.', priority: 'normal', event: 'limitHit',
    });
    assert.strictEqual(push.formatPush([hit], zh, { fmtClock: clock }).body, '11:00 重置。');
    assert.strictEqual(push.formatPush([{ ...hit, resetAt: null }], en).body, 'The reset time isn\'t known.');
    const viaI18n = push.formatPush([hit], en, { now: NOW }).body;
    assert.ok(viaI18n.startsWith('Resets ') && viaI18n !== 'Resets .', `uses i18n.fmtClock: ${viaI18n}`);
    assert.deepStrictEqual(push.formatPush([reset], zh), {
      title: 'Claude Code 额度已重置', body: '现在可以接着继续了。', priority: 'normal', event: 'limitReset',
    });
  });

  test('a batch: most urgent first, one line per event, a count title; includeTitle appends the chat title', () => {
    const m = push.formatPush([reset, hit, err, needs], en, { fmtClock: clock });
    assert.deepStrictEqual(m, {
      title: '4 updates from your agents',
      body: 'Agent needs you · demo-app\nAgent stopped with an error · api-server\nCodex usage limit reached\nClaude Code usage limit has reset',
      priority: 'high',
      event: 'needsYou',
    });
    const z = push.formatPush([err, needs], zh, { includeTitle: true });
    assert.strictEqual(z.title, '智能体有 2 条新动态');
    assert.strictEqual(z.body, '智能体需要你 · demo-app：Refactor the parser for /Users/someone/secret\n智能体出错停止了 · api-server：Fix login');
    const many = Array.from({ length: 7 }, (_, i) => ({ ...err, transitionId: `e${i}`, project: `p${i}` }));
    const mm = push.formatPush(many, en);
    assert.strictEqual(mm.body.split('\n').length, 6);
    assert.ok(mm.body.endsWith('…and 2 more'));
    assert.strictEqual(push.formatPush([needs, needs], en).title, 'Agent needs you · demo-app', 'same event twice is one');
  });

  // Threshold alerts as lib/alerts.js createThresholdTracker reports them
  const usage = {
    type: 'usageHigh', key: 'quota:codex:5h', transitionId: 'usageHigh|codex|5h|9|90', provider: 'codex', window: '5h',
    windowMinutes: 300, percent: 92.4, threshold: 90, resetAt: NOW + HOUR, atLimit: false,
  };
  const cost = {
    type: 'costDaily', key: 'today', transitionId: 'costDaily|2026-09-24|5', date: '2026-09-24', cost: 7.5, threshold: 5,
    claudeCost: 5.25, codexCost: 2.25,
  };
  const ctx = {
    type: 'contextHigh', key: 'claude:a', transitionId: 'contextHigh|claude:a|c0|80', provider: 'claude', title: 'Refactor the parser',
    titleSource: 'ai', project: 'demo-app', percent: 85, threshold: 80, contextPct: 40, contextUsed: 400000, compactAt: 470000, toCompact: 70000,
  };

  test('threshold alerts: worded by alerts.formatAlert with the push rules, normal priority; no cost amounts, a chat title only with includeTitle and a real title', () => {
    assert.deepStrictEqual(push.formatPush([usage], en, { fmtClock: clock }), {
      title: 'Codex 5-hour limit at 92%', body: 'Resets 11:00.', priority: 'normal', event: 'usageHigh',
    });
    assert.deepStrictEqual(push.formatPush([cost], en), {
      title: 'Today\'s cost passed your daily budget', body: 'Today\'s estimated API-equivalent cost is over the budget you set.', priority: 'normal', event: 'costDaily',
    });
    for (const i18n of [en, zh]) {
      const m = push.formatPush([cost], i18n, { includeTitle: true });
      assert.ok(!/[$¥]|7[.,]5|5[.,]00?\b/.test(`${m.title}\n${m.body}`), `a cost amount leaked: ${m.title} / ${m.body}`);
    }
    assert.deepStrictEqual(push.formatPush([ctx], en), {
      title: 'Context nearly full · demo-app', body: 'A chat has reached 85% of its auto-compact point.', priority: 'normal', event: 'contextHigh',
    });
    assert.strictEqual(push.formatPush([ctx], en, { includeTitle: true }).body, 'Refactor the parser has reached 85% of its auto-compact point.');
    for (const titleSource of ['prompt', 'id', null]) {
      const m = push.formatPush([{ ...ctx, title: 'fix payroll.ts', titleSource }], en, { includeTitle: true });
      assert.ok(!m.body.includes('payroll'), `${titleSource}: ${m.body}`);
    }
    // the same text as the desktop alert's push form
    for (const e of [usage, cost, ctx]) {
      const a = alerts.formatAlert(e, en, { forPush: true, includeTitle: false, fmtClock: clock });
      const m = push.formatPush([e], en, { fmtClock: clock });
      assert.deepStrictEqual([m.title, m.body], [a.title, a.body], e.type);
    }
    // a batch: after limit hits, before resets; normal priority unless a chat needs you or failed
    const b = push.formatPush([reset, cost, ctx, usage, hit], en, { fmtClock: clock });
    assert.deepStrictEqual(b, {
      title: '5 updates from your agents',
      body: 'Codex usage limit reached\nCodex 5-hour limit at 92%\nContext nearly full · demo-app\nToday\'s cost passed your daily budget\nClaude Code usage limit has reset',
      priority: 'normal',
      event: 'limitHit',
    });
    assert.strictEqual(push.formatPush([usage, needs], en).priority, 'high');
    for (const loc of LOCALES) {
      const i18n = i18nLib.createI18n(loc);
      const m = push.formatPush([usage, cost, ctx], i18n, { includeTitle: true, fmtClock: clock });
      for (const v of [m.title, m.body]) assert.ok(v && !/\{\w+\}/.test(v) && !/\b(?:push|alerts)\./.test(v), `${loc}: ${v}`);
    }
  });

  test('test message, and every locale renders without raw keys or placeholders', () => {
    assert.deepStrictEqual(push.testMessage(en), {
      title: 'Test from CYUNEO Agent Monitor', body: 'Push notifications work. You\'ll get a message like this when an agent needs you.', priority: 'normal', event: 'test',
    });
    assert.strictEqual(push.testMessage(zh).title, 'CYUNEO Agent Monitor 测试消息');
    for (const loc of LOCALES) {
      const i18n = i18nLib.createI18n(loc);
      for (const m of [push.formatPush([needsSub], i18n, { includeTitle: true }), push.formatPush([err, hit, reset], i18n, { fmtClock: clock }), push.testMessage(i18n)]) {
        for (const v of [m.title, m.body]) assert.ok(v && !/\{\w+\}/.test(v) && !v.includes('push.'), `${loc}: ${v}`);
      }
      if (loc !== 'en') assert.notStrictEqual(push.formatPush([needs], i18n).title, 'Agent needs you · demo-app', `${loc} is translated`);
    }
  });

  test('push.* keys: same set and placeholders in all five languages; every key the code uses exists', () => {
    const read = (loc) => JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', `push.${loc}.json`), 'utf8'));
    const base = read('en');
    const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const loc of LOCALES) {
      const d = read(loc);
      assert.deepStrictEqual(Object.keys(d).sort(), Object.keys(base).sort(), loc);
      for (const k of Object.keys(base)) {
        assert.ok(typeof d[k] === 'string' && d[k].trim(), `${loc} ${k}`);
        assert.strictEqual(ph(d[k]), ph(base[k]), `${loc} ${k} placeholders`);
      }
    }
    const used = new Set();
    for (const ch of Object.values(push.CHANNELS)) {
      used.add(ch.label);
      for (const f of ch.fields) for (const k of [f.label, f.placeholder, f.help]) if (k) used.add(k);
    }
    for (const t of push.EVENT_TYPES) used.add(`push.event.${t}`);
    for (const c of ['required', 'url', 'https', 'httpPublic', 'host', 'userinfo', 'format', 'number', 'channel']) used.add(`push.err.${c}`);
    for (const k of used) assert.ok(k in base, `missing ${k}`);
    assert.ok(i18nLib.REGIONS.includes('push'), 'the push bundle is loaded');
  });
}

// ---------- Runtime (lib/push-runtime.js) ----------

function runtimeTests() {
  const rt = require('../lib/push-runtime');
  const TIMING = { wait: () => 20, rescanLeadMs: 10, freshWaitMs: 50, limiter: { coalesceMs: 5, perChannelMinMs: 0 } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function makeRuntime(o = {}) {
    const store = new Map(Object.entries(o.secrets || {}));
    const fetch = fakeFetch(o.answer);
    const settings = { enabled: true, channels: [], ...o.settings };
    const logs = [];
    const warns = [];
    const runtime = rt.createPushRuntime({
      read: () => settings, secret: async (k) => store.get(k), claimDir: () => o.dir || '', i18n: en,
      log: (l) => logs.push(l), warn: (w) => warns.push(w), rescan: () => {}, fetch, timing: TIMING, clock: o.clock, mute: o.mute,
    });
    return { runtime, fetch, settings, store, logs, warns };
  }
  const secretsOf = (cfg) => ({ [rt.secretKeyOf(cfg.key || cfg.channel)]: JSON.stringify(push.splitConfig(cfg).secrets) });

  test('runtime helpers: SecretStorage key per channel key; a new, never reused key per channel; numbered names; junk entries ignored', () => {
    assert.strictEqual(rt.secretKeyOf({ channel: 'ntfy' }), 'agentMonitor.push.ntfy');
    assert.strictEqual(rt.secretKeyOf({ channel: 'ntfy', key: 'ntfy-2' }), 'agentMonitor.push.ntfy-2');
    const entries = [{ channel: 'ntfy', key: 'ntfy' }, null, 'x', { channel: 'nope', key: 'bark-AAAAAAAA' }, { channel: 'ntfy', key: 'ntfy-3' }, { channel: 'slack' }];
    assert.strictEqual(rt.channelEntries(entries).length, 3);
    // Random, so a secret left on another computer under an old key is never matched to a new entry (not even 'bark',
    // the bare id, when no entry uses it); unique among all entries, unknown ones included
    for (const id of ['ntfy', 'slack', 'bark']) assert.ok(new RegExp(`^${id}-[A-Za-z0-9_-]{8}$`).test(rt.newChannelKey(id, entries)), id);
    assert.notStrictEqual(rt.newChannelKey('ntfy', []), rt.newChannelKey('ntfy', []));
    const seq = [Buffer.alloc(6, 0), Buffer.alloc(6, 0), Buffer.alloc(6, 0xff)];
    assert.strictEqual(rt.newChannelKey('bark', entries, () => seq.shift()), 'bark-________', 'a key in use is drawn again');
    assert.deepStrictEqual(rt.channelEntries(entries).map((e) => rt.channelName(e, entries, en)), ['ntfy 1', 'ntfy 2', 'Slack incoming webhook']);
  });

  test('runtime configs: settings merged with SecretStorage; the stored server wins over the settings copy; entries turned off or without secrets only with all', async () => {
    const cfg = { ...CFG.ntfy, key: 'ntfy', server: 'https://ntfy.example.com' };
    const { runtime, settings } = makeRuntime({ secrets: { ...secretsOf(cfg), 'agentMonitor.push.bad': '{not json' } });
    settings.channels = [
      { ...push.splitConfig(cfg).settings, server: 'https://attacker.example' },
      { channel: 'slack', key: 'slack' },                  // no secrets here
      { channel: 'bark', key: 'bad' },                     // corrupt secrets
      { channel: 'ntfy', key: 'ntfy', enabled: false },   // same key again: ignored
    ];
    const list = await runtime.configs();
    assert.deepStrictEqual(list.map((c) => [c.key, c.config.server, c.config.topic]), [['ntfy', 'https://ntfy.example.com', K.ntfyTopic]]);
    const all = await runtime.configs({ all: true });
    assert.deepStrictEqual(all.map((c) => [c.key, !!c.config]), [['ntfy', true], ['slack', false], ['bad', false]]);
    settings.channels[0].enabled = false;
    assert.deepStrictEqual(await runtime.configs(), []);
    assert.strictEqual((await runtime.configs({ all: true }))[0].enabled, false);
  });

  test('runtime: off means no plan, no timer, no request; on, an error is sent once and a second window on the same claim dir stays quiet; test() works while off', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'rt-'));
    const cfg = { ...CFG.ntfy, key: 'ntfy' };
    const now = Date.now();
    const a = makeRuntime({ dir, secrets: secretsOf(cfg), settings: { enabled: false, channels: [push.splitConfig(cfg).settings] } });
    const b = makeRuntime({ dir, secrets: secretsOf(cfg), settings: { enabled: true, channels: [push.splitConfig(cfg).settings] } });
    const calm = [working({ updatedMs: now })];
    const broke = [failing(now - 1000, { updatedMs: now })];
    for (const x of [a, b]) x.runtime.update({ sessions: calm, lamps: lampsOf(calm), seq: 1 });
    a.runtime.update({ sessions: broke, lamps: lampsOf(broke), seq: 2 });
    await sleep(40);
    assert.strictEqual(a.fetch.calls.length, 0);
    assert.deepStrictEqual([a.runtime._state().waits, a.runtime._state().flushTimer], [0, false]);
    a.settings.enabled = true; // both on now; the same error seen by both
    a.runtime.update({ sessions: calm, lamps: lampsOf(calm), seq: 3 });
    const broke2 = [failing(now - 500, { updatedMs: now })];
    for (const x of [a, b]) { x.runtime.update({ sessions: calm, lamps: lampsOf(calm), seq: 3 }); x.runtime.update({ sessions: broke2, lamps: lampsOf(broke2), seq: 4 }); }
    await sleep(60);
    assert.strictEqual(a.fetch.calls.length + b.fetch.calls.length, 1, 'sent twice or not at all');
    const r = await a.runtime.test('ntfy');
    assert.ok(r.ok);
    assert.ok(a.fetch.calls.some((c) => /Test from CYUNEO/.test(JSON.stringify(c.init.headers))));
    a.runtime.dispose();
    b.runtime.dispose();
  });

  // needsYou: one pending wait per session, decided on whether the chat still waits (not on the exact transition)
  function waitRig(o = {}) {
    const dir = fs.mkdtempSync(path.join(TMP, 'rt-wait-'));
    const cfg = { ...CFG.ntfy, key: 'ntfy' };
    const x = makeRuntime({ dir, secrets: secretsOf(cfg), settings: { enabled: true, channels: [push.splitConfig(cfg).settings] }, clock: o.clock });
    let seq = 0;
    x.feed = (list) => x.runtime.update({ sessions: list, lamps: lampsOf(list), seq: ++seq });
    x.claimed = (id) => fs.existsSync(path.join(dir, notify.markerName(push.CLAIM_PREFIX + id)));
    return x;
  }

  test('runtime needsYou: a second prompt right after an answer (the lamp never leaves NeedsYou) is still pushed, once, claimed with its own id', async () => {
    const now = Date.now();
    const x = waitRig();
    x.feed([working({ updatedMs: now })]);
    const [ev] = x.feed([asking(now - 3000, { updatedMs: now })]);
    assert.strictEqual(ev.type, 'needsYou');
    const next = [asking(now - 500, { updatedMs: now })]; // tool call 1 approved, tool call 2 asks, within one scan
    assert.deepStrictEqual(x.feed(next), [], 'no new event: the state did not change');
    const cur = push.currentEventOf(ev, next, lampsOf(next));
    assert.ok(cur && cur.transitionId !== ev.transitionId && !push.isStillActive(ev, next, lampsOf(next)));
    await sleep(35); // past the delay, with no snapshot since the rescan request
    assert.strictEqual(x.fetch.calls.length, 0);
    x.feed(next); // the rescan: still waiting
    await sleep(40);
    assert.strictEqual(x.fetch.calls.length, 1, 'dropped as answered while the chat kept waiting');
    assert.ok(x.claimed(cur.transitionId) && !x.claimed(ev.transitionId), 'claimed with the current wait, so every window claims the same');
    assert.strictEqual(x.runtime._state().waits, 0);
    x.runtime.dispose();
  });

  test('runtime needsYou: another subagent takes the lead while the chat waits → pushed; answered in time → not; a newer wait of the same chat replaces the pending one', async () => {
    const now = Date.now();
    const sub = (id, status) => agent({ id, kind: 'subagent', name: id, agentType: 'Explore', status });
    const chat = (a, b) => [session({ main: agent({ status: st('tool', now - 9000, { pendingTool: 'Agent' }) }), agents: [sub('agent-a', a), sub('agent-b', b)], updatedMs: now })];
    const x = waitRig();
    const calm = chat(st('tool', now - 4000, { pendingTool: 'Bash' }), st('tool', now - 4000, { pendingTool: 'Bash' }));
    x.feed(calm);
    const [ev] = x.feed(chat(st('tool', now - 2000, { pendingTool: 'Bash' }), st('awaitingApproval', now - 2000, { pendingTool: 'Bash' })));
    assert.ok(/\|a\/agent-b\|/.test(ev.transitionId), ev.transitionId);
    const both = chat(st('awaitingApproval', now - 400, { pendingTool: 'Bash' }), st('awaitingApproval', now - 2000, { pendingTool: 'Bash' }));
    assert.deepStrictEqual(x.feed(both), []);
    await sleep(35);
    x.feed(both);
    await sleep(40);
    assert.strictEqual(x.fetch.calls.length, 1, 'the lead row moved and the push was dropped');
    assert.ok(x.claimed(push.currentEventOf(ev, both, lampsOf(both)).transitionId));
    // answered before the delay is up: nothing
    x.feed(calm);
    x.feed([asking(now - 300, { updatedMs: now, id: 'dddddddd-1111-2222-3333-444444444444' })]);
    x.feed([working({ updatedMs: now, id: 'dddddddd-1111-2222-3333-444444444444' })]);
    await sleep(35);
    x.feed([working({ updatedMs: now, id: 'dddddddd-1111-2222-3333-444444444444' })]);
    await sleep(40);
    assert.strictEqual(x.fetch.calls.length, 1, 'an answered chat was pushed');
    // answered, then asked again: the newer wait replaces the pending one (its delay starts again); one push
    const e = 'eeeeeeee-1111-2222-3333-444444444444';
    x.feed([working({ updatedMs: now, id: e })]);
    assert.strictEqual(x.feed([asking(now - 900, { updatedMs: now, id: e })]).length, 1);
    x.feed([working({ updatedMs: now, id: e })]);
    const again = [asking(now - 100, { updatedMs: now, id: e })];
    assert.strictEqual(x.feed(again).length, 1);
    assert.strictEqual(x.runtime._state().waits, 1, 'one pending wait per chat');
    await sleep(35);
    x.feed(again);
    await sleep(40);
    assert.strictEqual(x.fetch.calls.length, 2);
    assert.strictEqual(x.runtime._state().waits, 0);
    x.runtime.dispose();
  });

  test('runtime: threshold alerts handed to update() go out at once (no delay), claimed per alert so one of two windows sends; junk entries are ignored', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'rt-alerts-'));
    const cfg = { ...CFG.ntfy, key: 'ntfy' };
    const opts = { dir, secrets: secretsOf(cfg), settings: { enabled: true, delaySeconds: 600, channels: [push.splitConfig(cfg).settings] } };
    const a = makeRuntime(opts);
    const b = makeRuntime(opts);
    const calm = [working({ updatedMs: Date.now() })];
    const usage = {
      type: 'usageHigh', key: 'quota:codex:5h', transitionId: 'usageHigh|codex|5h|1|90', provider: 'codex', window: '5h',
      windowMinutes: 300, percent: 91, threshold: 90, resetAt: null, atLimit: false,
    };
    for (const x of [a, b]) x.runtime.update({ sessions: calm, lamps: lampsOf(calm), seq: 1 });
    for (const x of [a, b]) {
      const out = x.runtime.update({ sessions: calm, lamps: lampsOf(calm), seq: 2, alerts: [usage, null, { type: 'needsYou', transitionId: 'x' }, { type: 'costDaily' }] });
      assert.deepStrictEqual(out.map((e) => e.type), ['usageHigh'], 'only valid threshold alerts are taken');
    }
    await sleep(60);
    const calls = [...a.fetch.calls, ...b.fetch.calls];
    assert.strictEqual(calls.length, 1, 'sent twice or not at all');
    assert.strictEqual(calls[0].init.headers['X-Title'], 'Codex 5-hour limit at 91%');
    assert.strictEqual(calls[0].init.headers['X-Priority'], 'default');
    assert.ok(fs.existsSync(path.join(dir, notify.markerName(push.CLAIM_PREFIX + usage.transitionId))));
    // the same alert again (every render passes what the tracker reported): claimed already, nothing more
    a.runtime.update({ sessions: calm, lamps: lampsOf(calm), seq: 3, alerts: [usage] });
    await sleep(40);
    assert.strictEqual(a.fetch.calls.length + b.fetch.calls.length, 1);
    for (const x of [a, b]) x.runtime.dispose();
  });

  test('runtime: quiet hours (mute) drop an event without claiming it, so a window outside them can still send it; a needsYou is checked when its delay ends; a throwing mute mutes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'rt-quiet-'));
    const cfg = { ...CFG.ntfy, key: 'ntfy' };
    const quiet = { on: true, asked: [] };
    const opts = { dir, secrets: secretsOf(cfg), settings: { enabled: true, channels: [push.splitConfig(cfg).settings] } };
    const a = makeRuntime({ ...opts, mute: (type) => { quiet.asked.push(type); return quiet.on; } });
    const now = Date.now();
    const calm = [working({ updatedMs: now })];
    const broke = [failing(now - 800, { updatedMs: now })];
    a.runtime.update({ sessions: calm, lamps: lampsOf(calm), seq: 1 });
    const [ev] = a.runtime.update({ sessions: broke, lamps: lampsOf(broke), seq: 2 });
    await sleep(40);
    assert.strictEqual(a.fetch.calls.length, 0, 'pushed during quiet hours');
    assert.deepStrictEqual(quiet.asked, ['error']);
    assert.ok(!fs.existsSync(path.join(dir, notify.markerName(push.CLAIM_PREFIX + ev.transitionId))), 'a muted event must not be claimed');
    // another window, outside quiet hours (or with allowErrors), sends that same error
    const b = makeRuntime(opts);
    b.runtime.update({ sessions: calm, lamps: lampsOf(calm), seq: 1 });
    b.runtime.update({ sessions: broke, lamps: lampsOf(broke), seq: 2 });
    await sleep(40);
    assert.strictEqual(b.fetch.calls.length, 1);
    // needsYou: quiet hours start during its delay → not pushed
    const e = 'ffffffff-1111-2222-3333-444444444444';
    quiet.on = false;
    a.runtime.update({ sessions: [working({ updatedMs: now, id: e })], lamps: lampsOf([working({ updatedMs: now, id: e })]), seq: 3 });
    const wait = [asking(now - 300, { updatedMs: now, id: e })];
    assert.strictEqual(a.runtime.update({ sessions: wait, lamps: lampsOf(wait), seq: 4 }).length, 1);
    quiet.on = true;
    await sleep(35);
    a.runtime.update({ sessions: wait, lamps: lampsOf(wait), seq: 5 });
    await sleep(40);
    assert.strictEqual(a.fetch.calls.length, 0, 'the delayed needsYou was pushed during quiet hours');
    assert.strictEqual(quiet.asked[quiet.asked.length - 1], 'needsYou');
    // a mute callback that throws does not stop push
    const c = makeRuntime({ ...opts, dir: fs.mkdtempSync(path.join(TMP, 'rt-quiet-')), mute: () => { throw new Error('synthetic'); } });
    c.runtime.update({ sessions: calm, lamps: lampsOf(calm), seq: 1 });
    c.runtime.update({ sessions: broke, lamps: lampsOf(broke), seq: 2 });
    await sleep(40);
    assert.strictEqual(c.fetch.calls.length, 1);
    for (const x of [a, b, c]) x.runtime.dispose();
  });

  test('runtime needsYou: a decision that comes far past its deadline (the computer slept, timers paused) is dropped', async () => {
    const now = Date.now();
    const off = { ms: 0 };
    const x = waitRig({ clock: () => Date.now() + off.ms });
    x.feed([working({ updatedMs: now })]);
    const list = [asking(now - 1000, { updatedMs: now })];
    assert.strictEqual(x.feed(list).length, 1);
    off.ms = HOUR; // the wall clock moved on while the timers stood still
    await sleep(35);
    x.feed(list);
    await sleep(40);
    assert.strictEqual(x.fetch.calls.length, 0, 'pushed on waking up');
    assert.strictEqual(x.runtime._state().waits, 0);
    x.runtime.dispose();
  });
}

// ---------- Network switch (lib/network.js) ----------

// Run after every other test has finished, one at a time: they turn the process-wide switch off and on
async function serial(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`  ok    ${name}`);
  } catch (err) {
    fail(name, err);
  }
}

async function networkTests() {
  const rt = require('../lib/push-runtime');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (r) => ({ ok: r.ok, status: r.status, code: r.code });
  const OFF = { ok: false, status: 0, code: 'networkOff' };
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

  await serial('network switch: off until a source is set and again after it is released; only an exact true is on; a throwing source is off; a stale release leaves the newer source', async () => {
    const release = network.setAllowed(null);
    assert.strictEqual(network.isAllowed(), false, 'no source: off');
    let v = true;
    const r1 = network.setAllowed(() => v);
    assert.strictEqual(network.isAllowed(), true);
    for (const x of ['true', 1, {}, undefined, null, false]) { v = x; assert.strictEqual(network.isAllowed(), false, String(x)); }
    network.setAllowed(() => { throw new Error('settings unavailable'); });
    assert.strictEqual(network.isAllowed(), false);
    const r2 = network.setAllowed(() => true);
    r1(); // an older source's release does nothing
    assert.strictEqual(network.isAllowed(), true);
    r2();
    assert.strictEqual(network.isAllowed(), false, 'released: off');
    release();
    network.setAllowed(() => netSwitch.on);
  });

  await serial('network.request: reads the switch at call time; off answers networkOff and never calls fetch; on, the given fetch gets the url and init', async () => {
    const f = fakeFetch();
    netSwitch.on = false;
    assert.deepStrictEqual(pick(await network.request('https://ntfy.sh/x', { method: 'POST' }, { fetch: f })), OFF);
    assert.ok(network.isOff(await network.request('https://ntfy.sh/x', {}, {})), 'off with the global fetch too');
    assert.strictEqual(f.calls.length, 0);
    netSwitch.on = true;
    const res = await network.request('https://ntfy.sh/x', { method: 'POST' }, { fetch: f });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(f.calls.map((c) => [c.url, c.init.method]), [['https://ntfy.sh/x', 'POST']]);
    assert.ok(!network.isOff(res) && !network.isOff(null) && network.isOff(network.offResult()));
    assert.notStrictEqual(network.offResult(), network.offResult(), 'a fresh object each time');
  });

  await serial('send: with the switch off, all nine channels answer networkOff without a request; describeError says so in all five languages', async () => {
    netSwitch.on = false;
    const f = fakeFetch();
    try {
      for (const id of push.CHANNEL_IDS) assert.deepStrictEqual(pick(await push.send(CFG[id], MSG, { fetch: f, timeoutMs: 20 })), OFF, id);
      assert.strictEqual(f.calls.length, 0);
    } finally {
      netSwitch.on = true;
    }
    for (const loc of LOCALES) {
      const text = push.describeError(network.offResult(), i18nLib.createI18n(loc));
      assert.ok(text && !/\{\w+\}/.test(text) && !text.startsWith('push.'), `${loc}: ${text}`);
    }
    assert.strictEqual(push.describeError(network.offResult(), en), en.t('push.err.networkOff'));
    // turned off after send() passed its own check: the gate in network.request() still refuses, and the result says so
    const late = fakeFetch();
    let first = true;
    network.setAllowed(() => { if (first) { first = false; return true; } return false; });
    try {
      assert.deepStrictEqual(pick(await push.send(CFG.ntfy, MSG, { fetch: late })), OFF);
      assert.strictEqual(late.calls.length, 0);
    } finally {
      network.setAllowed(() => netSwitch.on);
    }
  });

  function rig(o = {}) {
    const dir = fs.mkdtempSync(path.join(TMP, 'rt-net-'));
    const cfg = { ...CFG.ntfy, key: 'ntfy' };
    const store = new Map([[rt.secretKeyOf('ntfy'), JSON.stringify(push.splitConfig(cfg).secrets)]]);
    const fetch = fakeFetch();
    const logs = [];
    const warns = [];
    const runtime = rt.createPushRuntime({
      read: () => ({ enabled: true, channels: [push.splitConfig(cfg).settings] }), secret: async (k) => store.get(k),
      claimDir: () => dir, i18n: en, log: (l) => logs.push(l), warn: (w) => warns.push(w), rescan: () => {}, fetch,
      timing: { wait: () => 20, rescanLeadMs: 10, freshWaitMs: 50, limiter: { coalesceMs: o.coalesceMs || 5, perChannelMinMs: 0 } },
    });
    let seq = 0;
    const feedRt = (list, quota) => runtime.update({ sessions: list, lamps: lampsOf(list), quota, seq: ++seq });
    const markers = () => fs.readdirSync(dir).filter((f) => f !== rt.STORE_FILE);
    return { runtime, fetch, logs, warns, feed: feedRt, markers };
  }

  await serial('runtime: with the network off, push on and a channel set up: errors, waits and usage limits are tracked but nothing is planned, claimed, queued or sent; allowing it later sends only what happens after', async () => {
    netSwitch.on = false;
    const x = rig();
    try {
      const now = Date.now();
      x.feed([working({ updatedMs: now })], emptyQuota());
      const evs = [
        ...x.feed([failing(now - 2000, { updatedMs: now })], emptyQuota()),
        ...x.feed([asking(now - 1000, { updatedMs: now })], claudeHit(now, now + HOUR)),
      ];
      assert.deepStrictEqual(evs.map((e) => e.type).sort(), ['error', 'limitHit', 'needsYou'], 'the tracker still sees them');
      await sleep(120); // past the needsYou delay and any batch
      assert.strictEqual(x.fetch.calls.length, 0);
      assert.deepStrictEqual([x.runtime._state().waits, x.runtime._state().flushTimer], [0, false]);
      assert.deepStrictEqual(x.markers(), [], 'an event was claimed');
      // allowed again: what happened while it was off is not sent; a new error is, once
      netSwitch.on = true;
      x.runtime.onSettings();
      x.feed([asking(now - 1000, { updatedMs: now })], claudeHit(now, now + HOUR));
      await sleep(120);
      assert.strictEqual(x.fetch.calls.length, 0, 'an old event was sent after allowing the network');
      x.feed([working({ updatedMs: now })], claudeHit(now, now + HOUR));
      x.feed([failing(now - 500, { updatedMs: now })], claudeHit(now, now + HOUR));
      await sleep(60);
      assert.strictEqual(x.fetch.calls.length, 1);
    } finally {
      netSwitch.on = true;
      x.runtime.dispose();
    }
  });

  await serial('runtime: test() with the network off answers networkOff without a request (logged, not counted as a failure); the network turned off while a batch is queued drops it', async () => {
    netSwitch.on = false;
    const x = rig({ coalesceMs: 40 });
    try {
      const r = await x.runtime.test('ntfy');
      assert.deepStrictEqual(pick(r), OFF);
      assert.strictEqual(x.fetch.calls.length, 0);
      assert.ok(x.logs.includes(en.t('push.ui.testFailedChannel', { channel: 'ntfy', error: en.t('push.err.networkOff') })), x.logs.join('\n'));
      // queued with the network on, then turned off before the batch is due
      netSwitch.on = true;
      const now = Date.now();
      x.feed([working({ updatedMs: now })]);
      x.feed([failing(now - 700, { updatedMs: now })]);
      for (let i = 0; i < 50 && !x.runtime._state().flushTimer; i++) await new Promise((res) => setImmediate(res));
      assert.ok(x.runtime._state().flushTimer, 'the batch was not queued');
      netSwitch.on = false;
      await sleep(80);
      assert.strictEqual(x.fetch.calls.length, 0);
      assert.deepStrictEqual([x.runtime._state().flushTimer, x.runtime._state().failures.size, x.warns.length], [false, 0, 0]);
    } finally {
      netSwitch.on = true;
      x.runtime.dispose();
    }
  });

  await serial('sources: every request goes through lib/network.js; no other file calls fetch or loads http, https, http2, net, tls or dgram', () => {
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = `${dir}/${e.name}`;
      return e.isDirectory() ? walk(rel) : /\.(c|m)?js$/.test(e.name) ? [rel] : [];
    });
    const files = ['extension.js', ...walk('lib'), ...walk('bin'), ...walk('media')];
    assert.ok(files.includes('lib/push.js') && files.includes('lib/network.js') && files.length > 20, files.join(' '));
    const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
    // the global fetch in any form, any call of an injected one, other request APIs, and Node's network modules
    const modules = /require\(\s*['"](?:node:)?(?:https?|http2|net|tls|dgram)['"]\s*\)|\bnet\.connect\b|\btls\.connect\b|\bhttps?\.(?:request|get)\b/;
    const bad = new RegExp([
      /(^|[^.\w$])fetch\b(?!\s*:)/.source, /\b(?:globalThis|window|self|global)\.fetch\b/.source, /\bfetch\s*\(/.source,
      /\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/.source, modules.source,
    ].join('|'));
    for (const f of files) {
      if (f === 'lib/network.js') continue;
      const hit = code(f).split('\n').find((l) => bad.test(l));
      assert.ok(!hit, `${f}: ${hit && hit.trim()}`);
    }
    // push.js and the runtime reach the network only through network.request()
    assert.ok(/network\.request\(/.test(code('lib/push.js')));
    const gate = code('lib/network.js');
    assert.ok(!modules.test(gate), 'network.js loads no network module');
    assert.strictEqual((gate.match(/return f\(url, init\);/g) || []).length, 1, 'fetch is called in one place');
    assert.ok(gate.indexOf('if (!isAllowed()) return offResult();') < gate.indexOf('return f(url, init);'), 'the switch is checked first');
  });
}

// ---------- Run ----------

console.log('channels');
channelTests();
console.log('validation');
validationTests();
console.log('parseResult');
parseTests();
console.log('send');
sendTests();
console.log('tracker');
trackerTests();
console.log('policy');
policyTests();
console.log('format');
formatTests();
console.log('runtime');
runtimeTests();

Promise.all(pending).then(async () => {
  console.log('network switch');
  await networkTests();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  if (realFetchCalls) { results.push(false); console.log(`  FAIL  ${realFetchCalls} call(s) reached the real fetch`); }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
});
