'use strict';
// Remote push (opt-in, off by default): send a short message to the user's phone or team chat through one of nine
// channels when an agent needs them, stops with an error, or hits / leaves a usage limit. This is the extension's only
// network access, so privacy comes first:
// - the default message is the project folder name plus the state; chat titles and agent names only with includeTitle,
//   and then only a real title (never one made from the prompt); never prompts, code, paths, token or cost numbers;
// - every error string goes through redact() before it is cut to one line, which masks secret fields and token-bearing
//   URL parts; describeError() also breaks [label](link) syntax so vendor text cannot plant a link in a notification;
// - only https URLs (http only for a self-hosted ntfy / Bark server on localhost or a private address), and webhook URLs
//   must be on the vendor's own host.
// No vscode dependency; fetch, clock and crypto are injectable. The extension wires it in:
//   const events = tracker.update({ sessions, lamps, quota, now });     // after each computeLamps
//   for (const ev of events) {
//     let p = plan({ event: ev, settings });
//     if (p.action === 'wait') setTimeout(() => {                         // needsYou: escalate only if still waiting
//       p = plan({ event: ev, settings, stillActive: isStillActive(ev, latestSessions, latestLamps) });
//       if (p.action === 'send') enqueue(ev, p);
//     }, p.delayMs);
//     else if (p.action === 'send') enqueue(ev, p);
//   }
//   enqueue(ev, p):  if (!notify.claimOnce(dir, p.claimId, Date.now())) return;   // one window per event
//                    for (const c of channels) limiter.add(channelKeyOf(c), ev, Date.now(), { dailyMax: c.dailyMax });
//                    schedule a flush at limiter.nextAt()
//   flush():         const { batches, dropped, nextAt } = limiter.due(Date.now());
//                    for (const b of batches) send(configOf(b.channel), formatPush(b.events, i18n, { includeTitle }), { fetch });
//                    log dropped (reason 'hourly' / 'daily' / 'stale'); if (nextAt != null) schedule a flush at nextAt
//   configOf(key):   mergeConfig(settingsEntry, JSON.parse(await secrets.get(...key...)))   // never the settings copy alone
// Settings: every agentMonitor.push.* setting is "scope": "application" (a workspace cannot turn push on or redirect it),
// listed in capabilities.untrustedWorkspaces.restrictedConfigurations, and read with inspect().globalValue.

const fs = require('fs');
const nodeCrypto = require('crypto');
const S = require('./core/status');
const lampLib = require('./lamp');
const notify = require('./notify');
const { ROW_MAIN } = require('./order');

const APP_NAME = notify.APP_NAME;
const EVENT_TYPES = Object.freeze(['needsYou', 'error', 'limitHit', 'limitReset']);
const CLAIM_PREFIX = 'push|';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_DELAY_SECONDS = 30;
const MAX_DELAY_SECONDS = 3600;
const DEFAULT_MAX_AGE_MS = 15 * 60e3;
const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;
const ERROR_MAX = 200;
const RESPONSE_MAX = 4000;
const RESPONSE_MAX_BYTES = 16384;
const NTFY_TOPIC_MIN = 12;
const SERVERCHAN_SHORT_MAX = 64;
const TITLE_MAX = 120;
const LINE_MAX = 200;
const BODY_LINES_MAX = 8;
const BATCH_LINES_MAX = 5;
const CHAT_TITLE_MAX = 60;
const NAME_MAX = 40;
const TRACKER_MAX_KEYS = 1000;
const LIMIT_IDS_MAX = 200;
const RESETS_MAX = 50;
// Codex resolves resets_in_seconds against each line's time, so one reset time drifts by up to a second or two between
// lines: ids use it rounded up to the minute, and a new value within RESET_SNAP_MS of a known one is that same reset
const RESET_STEP_MS = 60e3;
const RESET_SNAP_MS = 2 * 60e3;
// Title sources that are a real chat title, never the prompt (lib/core/status.js Session.titleSource)
const SAFE_TITLE_SOURCES = new Set(['custom', 'ai', 'index']);
// Discord message flag SUPPRESS_EMBEDS (1 << 2): no link previews fetched for text we post
const DISCORD_SUPPRESS_EMBEDS = 4;
// Most urgent first (formatting order; the first event of a batch names msg.event)
const EVENT_ORDER = Object.freeze({ needsYou: 0, error: 1, limitHit: 2, limitReset: 3 });
// ntfy Tags header: emoji short codes shown before the title
const NTFY_TAGS = Object.freeze({
  needsYou: 'bell', error: 'warning', limitHit: 'hourglass_flowing_sand', limitReset: 'white_check_mark', test: 'bell',
});

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const cleanText = notify.cleanText;

/** VS Code turns [label](command:…|https:…) in a notification into a link: a zero-width space after ']' breaks it */
function breakLinks(s) {
  return String(s).replace(/\](\s*)\(/g, ']\u200b$1(');
}

/** Several lines (\n kept, each line cleaned and capped), at most maxLines lines */
function cleanLines(s, maxLine = LINE_MAX, maxLines = BODY_LINES_MAX) {
  return String(s == null ? '' : s).split(/\r\n|\r|\n/).map((l) => cleanText(l, maxLine)).filter(Boolean)
    .slice(0, maxLines).join('\n');
}

/** At most max code points, with a trailing … when cut */
function truncChars(s, max) {
  const a = Array.from(String(s));
  return a.length > max ? a.slice(0, Math.max(1, max - 1)).join('') + '…' : String(s);
}

/** At most maxBytes UTF-8 bytes, cut on a code point boundary, with a trailing … when cut */
function truncBytes(s, maxBytes) {
  const str = String(s);
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  let out = '';
  let used = 3; // room for the ellipsis
  for (const ch of str) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out + '…';
}

/**
 * RFC 2047 encoded-words for a header value that is not plain ASCII (fetch only takes Latin-1 header values, and the
 * ntfy docs name RFC 2047 as the way to send UTF-8 titles). Each word holds whole characters and stays within 75 chars.
 */
function headerText(s) {
  const str = String(s);
  if (/^[\x20-\x7e]*$/.test(str)) return str;
  const words = [];
  let chunk = '';
  for (const ch of str) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(' ');
}

/** Slack mrkdwn: & < > must be escaped, or <!channel> and <url|label> in a chat title would become control sequences */
function slackEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Feishu text messages turn <at user_id="all"></at> into a mention: a full-width < keeps the text inert */
function feishuEscape(s) {
  return String(s).replace(/</g, '＜');
}

/** ServerChan desp is Markdown: backslash-escape the characters that start links, images, emphasis or HTML */
function markdownEscape(s) {
  return String(s).replace(/([\\`*_{}[\]()#+\-!<>|~])/g, '\\$1');
}

/** Title and body as one plain text for chat-style channels */
function chatText(msg) {
  return [msg.title, msg.body].filter(Boolean).join('\n');
}

/** Message as the channels get it: one-line title, cleaned body lines, priority high|normal */
function normalizeMsg(msg) {
  const m = msg || {};
  return {
    title: cleanText(m.title, TITLE_MAX) || APP_NAME,
    body: cleanLines(m.body),
    priority: m.priority === 'high' ? 'high' : 'normal',
    event: typeof m.event === 'string' ? m.event : '',
  };
}

// ---------------------------------------------------------------------------
// URL checks
// ---------------------------------------------------------------------------

/**
 * Host is loopback, a private / link-local / shared (RFC 6598) address, or a local-only name, where plain http does
 * not cross the public internet.
 * @param {string} hostname URL.hostname (IPv6 in brackets is accepted)
 */
function isPrivateHost(hostname) {
  let h = String(hostname || '').toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/\.(local|lan|internal|home\.arpa)$/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((x) => x > 255)) return false;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) {
    if (h === '::1') return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;  // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;   // fe80::/10 link-local
  }
  return false;
}

function parseUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * Self-hosted server base URL (ntfy, Bark): https anywhere, http only for isPrivateHost; no user info, query or fragment.
 * @returns {{ code: string, vars?: object }|null} null when fine
 */
function checkServerUrl(raw) {
  const u = parseUrl(raw);
  if (!u) return { code: 'url' };
  if (u.username || u.password) return { code: 'userinfo' };
  if (u.search || u.hash) return { code: 'format' };
  if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) return { code: 'httpPublic' };
  return null;
}

/**
 * Vendor webhook URL: https only, exactly one of the vendor's hosts on the default port, the documented path, and the
 * required query parameters. Stops a mistyped or look-alike host from receiving the message.
 * @param {string} raw
 * @param {{ hosts: string[], path: RegExp, query?: string[] }} rule
 * @returns {{ code: string, vars?: object }|null}
 */
function checkWebhookUrl(raw, rule) {
  const u = parseUrl(raw);
  if (!u) return { code: 'url' };
  if (u.protocol !== 'https:') return { code: 'https' };
  if (u.username || u.password) return { code: 'userinfo' };
  if (!rule.hosts.includes(u.hostname.toLowerCase()) || u.port) return { code: 'host', vars: { host: rule.hosts.join(' / ') } };
  if (!rule.path.test(u.pathname)) return { code: 'format' };
  for (const q of rule.query || []) if (!u.searchParams.get(q)) return { code: 'format' };
  return null;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * Feishu / Lark custom bot: HMAC-SHA256 keyed with `${timestamp}\n${secret}` over an empty message, base64.
 * timestamp is in seconds. https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 */
function feishuSign(timestampSec, secret, cryptoImpl) {
  const c = cryptoImpl || nodeCrypto;
  return c.createHmac('sha256', `${timestampSec}\n${secret}`).update('').digest('base64');
}

/**
 * DingTalk custom robot: HMAC-SHA256 keyed with the secret over `${timestamp}\n${secret}`, base64 (the caller URL-encodes
 * it as a query parameter). timestamp is in milliseconds.
 * https://open.dingtalk.com/document/robots/customize-robot-security-settings
 */
function dingtalkSign(timestampMs, secret, cryptoImpl) {
  const c = cryptoImpl || nodeCrypto;
  return c.createHmac('sha256', String(secret)).update(`${timestampMs}\n${secret}`).digest('base64');
}

// ---------------------------------------------------------------------------
// Channel registry
// ---------------------------------------------------------------------------

const pattern = (re) => (v) => (re.test(String(v)) ? null : { code: 'format' });
const oneLineShort = (v) => (/[\r\n]/.test(String(v)) || Array.from(String(v)).length > NAME_MAX ? { code: 'format' } : null);
const serverUrl = (v) => checkServerUrl(v);
const webhook = (rule) => (v) => checkWebhookUrl(v, rule);

/**
 * ntfy topic: on a server without an access token the topic is the only secret (anyone who guesses it can subscribe),
 * so it must be long enough not to be guessed.
 */
function ntfyTopic(v, c) {
  if (!/^[-_A-Za-z0-9]{1,64}$/.test(String(v))) return { code: 'format' };
  if (!(c && c.token) && String(v).length < NTFY_TOPIC_MIN) return { code: 'topicShort', vars: { min: NTFY_TOPIC_MIN } };
  return null;
}

/** A random ntfy topic to suggest in the setup UI: "am-" + 16 base64url characters (96 bits) */
function randomTopic(cryptoImpl) {
  const c = cryptoImpl || nodeCrypto;
  return `am-${Buffer.from(c.randomBytes(12)).toString('base64url')}`;
}

function nonNegInt(v) {
  if (v === '' || v == null) return 0;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

/**
 * secret: kept only in SecretStorage and masked in the UI. bound: not secret (shown as typed), but it decides where the
 * secrets go (a self-hosted server, a Telegram chat), so SecretStorage keeps the copy that is used and settings.json only
 * a display copy (see splitConfig / mergeConfig).
 * @param {string} key
 * @param {{ secret?: boolean, bound?: boolean, required?: boolean, default?: any, type?: 'string'|'number', placeholder?: string,
 *   help?: string, validate?: (value: any, config: any) => ({ code: string, vars?: object }|null) }} o
 */
function field(key, o = {}) {
  return Object.freeze({
    key,
    secret: !!o.secret,
    bound: !o.secret && !!o.bound,
    required: !!o.required,
    default: o.default === undefined ? (o.type === 'number' ? 0 : '') : o.default,
    type: o.type || 'string',
    label: `push.field.${key}`,
    placeholder: o.placeholder || null,
    help: o.help || null,
    validate: o.validate || null,
  });
}

/** Every channel has an optional daily cap (0 = none); ServerChan's free plan allows 5 messages a day */
function dailyMaxField(def) {
  return field('dailyMax', {
    type: 'number', default: def, help: 'push.help.dailyMax',
    validate: (v) => (Number.isNaN(nonNegInt(v)) ? { code: 'number' } : null),
  });
}

const DINGTALK_RULE = { hosts: ['oapi.dingtalk.com'], path: /^\/robot\/send$/, query: ['access_token'] };
const FEISHU_RULE = { hosts: ['open.feishu.cn', 'open.larksuite.com'], path: /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/ };
const WECOM_RULE = { hosts: ['qyapi.weixin.qq.com'], path: /^\/cgi-bin\/webhook\/send$/, query: ['key'] };
const DISCORD_RULE = {
  hosts: ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'],
  path: /^\/api(\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/,
};
const SLACK_RULE = { hosts: ['hooks.slack.com'], path: /^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/?$/ };

const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json; charset=utf-8' });
const json = (url, payload) => ({ url, method: 'POST', headers: { ...JSON_HEADERS }, body: JSON.stringify(payload) });
const trimSlash = (s) => String(s).trim().replace(/\/+$/, '');
const withKeyword = (text, keyword) => {
  const k = cleanText(keyword, NAME_MAX);
  return k && !text.includes(k) ? `${k} ${text}` : text;
};

/**
 * The nine channels. Each has an l10n label key, its fields (secret ones belong in SecretStorage, never in settings) and a
 * pure build(config, msg, now, deps) → { url, method, headers, body }. config holds the field values (defaults applied by
 * send); msg is { title, body, priority: 'high'|'normal', event }; now is epoch ms; deps.crypto replaces Node's crypto.
 */
const CHANNELS = Object.freeze({
  // https://docs.ntfy.sh/publish/ — POST <server>/<topic>, body = message, X-Title/X-Priority/X-Tags headers, Bearer token
  ntfy: {
    id: 'ntfy',
    label: 'push.channel.ntfy',
    fields: [
      field('server', { bound: true, required: true, default: 'https://ntfy.sh', placeholder: 'push.ph.ntfy.server', help: 'push.help.server', validate: serverUrl }),
      // The token comes before the topic: the setup checks each field against the ones before it, and with a token the
      // topic may be shorter (see ntfyTopic)
      field('token', { secret: true, placeholder: 'push.ph.ntfy.token', help: 'push.help.ntfy.token', validate: pattern(/^[\x21-\x7e]{1,512}$/) }),
      field('topic', { secret: true, required: true, placeholder: 'push.ph.ntfy.topic', help: 'push.help.ntfy.topic', validate: ntfyTopic }),
      dailyMaxField(0),
    ],
    build(c, msg) {
      const m = normalizeMsg(msg);
      const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        // The X- names are canonical: a bare "Priority" is also the RFC 9218 header, which Cloudflare and other proxies
        // add or rewrite on the way to a self-hosted server (ntfy then ignores it and the push arrives at default priority)
        'X-Title': headerText(m.title),
        'X-Priority': m.priority === 'high' ? 'high' : 'default',
        'X-Tags': NTFY_TAGS[m.event] || NTFY_TAGS.test,
      };
      if (c.token) headers.Authorization = `Bearer ${c.token}`;
      return { url: `${trimSlash(c.server)}/${encodeURIComponent(c.topic)}`, method: 'POST', headers, body: truncBytes(m.body || m.title, 4000) };
    },
  },

  // https://github.com/Finb/bark-server/blob/master/docs/API_V2.md — POST <server>/push with JSON
  bark: {
    id: 'bark',
    label: 'push.channel.bark',
    fields: [
      field('server', { bound: true, required: true, default: 'https://api.day.app', placeholder: 'push.ph.bark.server', help: 'push.help.server', validate: serverUrl }),
      field('deviceKey', { secret: true, required: true, placeholder: 'push.ph.bark.deviceKey', help: 'push.help.bark.deviceKey', validate: pattern(/^[A-Za-z0-9_-]{8,128}$/) }),
      dailyMaxField(0),
    ],
    build(c, msg) {
      const m = normalizeMsg(msg);
      return json(`${trimSlash(c.server)}/push`, {
        device_key: c.deviceKey,
        title: m.title,
        body: truncChars(m.body || m.title, 1000),
        level: m.priority === 'high' ? 'timeSensitive' : 'active',
        group: APP_NAME,
      });
    },
  },

  // https://sct.ftqq.com/docs/ — POST https://sctapi.ftqq.com/<key>.send; keys sctp<uid>t… go to https://<uid>.push.ft07.com
  serverchan: {
    id: 'serverchan',
    label: 'push.channel.serverchan',
    fields: [
      field('sendKey', { secret: true, required: true, placeholder: 'push.ph.serverchan.sendKey', help: 'push.help.serverchan.sendKey', validate: pattern(/^[A-Za-z0-9_-]{8,128}$/) }),
      dailyMaxField(5),
    ],
    build(c, msg) {
      const m = normalizeMsg(msg);
      const key = String(c.sendKey);
      const sc3 = /^sctp(\d+)t/.exec(key);
      const url = sc3
        ? `https://${sc3[1]}.push.ft07.com/send/${encodeURIComponent(key)}.send`
        : `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`;
      // title: required, one line, 32 characters at most. desp is Markdown, where a single \n is a soft break: a blank line
      // between body lines keeps a batch one event per line. short: the plain-text card preview (WeChat / the app), which
      // would otherwise be cut from the escaped desp and show its backslashes.
      const form = new URLSearchParams({ title: cleanText(m.title, 32), desp: m.body.split('\n').map(markdownEscape).join('\n\n') });
      const short = cleanText(m.body.replace(/\n/g, ' · '), SERVERCHAN_SHORT_MAX);
      if (short) form.set('short', short);
      const body = form.toString();
      return { url, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }, body };
    },
  },

  // https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot — msg_type text; timestamp + sign in the JSON body
  feishu: {
    id: 'feishu',
    label: 'push.channel.feishu',
    fields: [
      field('webhook', { secret: true, required: true, placeholder: 'push.ph.feishu.webhook', help: 'push.help.webhook', validate: webhook(FEISHU_RULE) }),
      field('secret', { secret: true, placeholder: 'push.ph.feishu.secret', help: 'push.help.feishu.secret', validate: pattern(/^\S{1,256}$/) }),
      field('keyword', { help: 'push.help.keyword', validate: oneLineShort }),
      dailyMaxField(0),
    ],
    build(c, msg, now, deps = {}) {
      const m = normalizeMsg(msg);
      const payload = {};
      if (c.secret) {
        const ts = String(Math.floor(now / 1000));
        payload.timestamp = ts;
        payload.sign = feishuSign(ts, c.secret, deps.crypto);
      }
      payload.msg_type = 'text';
      payload.content = { text: truncBytes(feishuEscape(withKeyword(chatText(m), c.keyword)), 4000) };
      return json(String(c.webhook).trim(), payload);
    },
  },

  // https://open.dingtalk.com/document/robots/custom-robot-access — msgtype text; timestamp + sign as query parameters
  dingtalk: {
    id: 'dingtalk',
    label: 'push.channel.dingtalk',
    fields: [
      field('webhook', { secret: true, required: true, placeholder: 'push.ph.dingtalk.webhook', help: 'push.help.webhook', validate: webhook(DINGTALK_RULE) }),
      field('secret', { secret: true, placeholder: 'push.ph.dingtalk.secret', help: 'push.help.dingtalk.secret', validate: pattern(/^\S{1,256}$/) }),
      field('keyword', { help: 'push.help.keyword', validate: oneLineShort }),
      dailyMaxField(0),
    ],
    build(c, msg, now, deps = {}) {
      const m = normalizeMsg(msg);
      let url = String(c.webhook).trim();
      if (c.secret) {
        // Through the URL object: a fragment pasted with the URL (even a bare '#') would otherwise swallow the signature,
        // and fetch never sends a fragment. URLSearchParams encodes + / = as %2B %2F %3D, like the documented URL encoding.
        const u = new URL(url);
        const ts = String(Math.round(now));
        u.hash = '';
        u.searchParams.set('timestamp', ts);
        u.searchParams.set('sign', dingtalkSign(ts, c.secret, deps.crypto));
        url = u.toString();
      }
      return json(url, { msgtype: 'text', text: { content: truncBytes(withKeyword(chatText(m), c.keyword), 4000) } });
    },
  },

  // https://developer.work.weixin.qq.com/document/path/91770 — msgtype text; content at most 2048 bytes
  wecom: {
    id: 'wecom',
    label: 'push.channel.wecom',
    fields: [
      field('webhook', { secret: true, required: true, placeholder: 'push.ph.wecom.webhook', help: 'push.help.webhook', validate: webhook(WECOM_RULE) }),
      dailyMaxField(0),
    ],
    build(c, msg) {
      const m = normalizeMsg(msg);
      return json(String(c.webhook).trim(), { msgtype: 'text', text: { content: truncBytes(chatText(m), 2048) } });
    },
  },

  // https://core.telegram.org/bots/api#sendmessage — plain text (no parse_mode), 4096 characters at most
  telegram: {
    id: 'telegram',
    label: 'push.channel.telegram',
    fields: [
      field('botToken', { secret: true, required: true, placeholder: 'push.ph.telegram.botToken', help: 'push.help.telegram.botToken', validate: pattern(/^\d{3,20}:[A-Za-z0-9_-]{20,100}$/) }),
      field('chatId', { bound: true, required: true, placeholder: 'push.ph.telegram.chatId', help: 'push.help.telegram.chatId', validate: pattern(/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,64})$/) }),
      dailyMaxField(0),
    ],
    build(c, msg) {
      const m = normalizeMsg(msg);
      const id = String(c.chatId).trim();
      const n = Number(id);
      return json(`https://api.telegram.org/bot${c.botToken}/sendMessage`, {
        chat_id: /^-?\d+$/.test(id) && Number.isSafeInteger(n) ? n : id,
        text: truncChars(chatText(m), 4096),
        link_preview_options: { is_disabled: true },
      });
    },
  },

  // https://docs.discord.com/developers/resources/webhook#execute-webhook — content at most 2000 characters
  discord: {
    id: 'discord',
    label: 'push.channel.discord',
    fields: [
      field('webhook', { secret: true, required: true, placeholder: 'push.ph.discord.webhook', help: 'push.help.webhook', validate: webhook(DISCORD_RULE) }),
      dailyMaxField(0),
    ],
    build(c, msg) {
      const m = normalizeMsg(msg);
      return json(String(c.webhook).trim(), {
        content: truncChars(chatText(m), 2000),
        allowed_mentions: { parse: [] },
        flags: DISCORD_SUPPRESS_EMBEDS,
      });
    },
  },

  // https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/ — { text }
  slack: {
    id: 'slack',
    label: 'push.channel.slack',
    fields: [
      field('webhook', { secret: true, required: true, placeholder: 'push.ph.slack.webhook', help: 'push.help.webhook', validate: webhook(SLACK_RULE) }),
      dailyMaxField(0),
    ],
    build(c, msg) {
      const m = normalizeMsg(msg);
      return json(String(c.webhook).trim(), { text: truncChars(slackEscape(chatText(m)), 4000) });
    },
  },
});
for (const ch of Object.values(CHANNELS)) { Object.freeze(ch.fields); Object.freeze(ch); }

/** Channel ids in menu order */
const CHANNEL_IDS = Object.freeze(Object.keys(CHANNELS));

/** Channel definition for a config ({ channel: 'ntfy', ... }) or an id; null when unknown */
function channelOf(configOrId) {
  const id = typeof configOrId === 'string' ? configOrId : configOrId && configOrId.channel;
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(CHANNELS, id) ? CHANNELS[id] : null;
}

/** Key for rate limits and storage: config.key when set (several channels of one type), else the channel id */
function channelKeyOf(config) {
  if (!config) return '';
  return typeof config.key === 'string' && config.key ? config.key : String(config.channel || '');
}

/** config with every missing field set to its default; strings trimmed */
function withDefaults(config) {
  const ch = channelOf(config);
  const out = { ...(config || {}) };
  if (!ch) return out;
  for (const f of ch.fields) {
    const v = out[f.key];
    if (v == null || (typeof v === 'string' && v.trim() === '')) out[f.key] = f.default;
    else if (typeof v === 'string') out[f.key] = v.trim();
  }
  return out;
}

/**
 * Checks a channel config field by field.
 * @returns {{ ok: boolean, errors: { key: string, code: string, vars?: object }[] }} code → l10n key push.err.<code>
 */
function validateConfig(config) {
  const ch = channelOf(config);
  if (!ch) return { ok: false, errors: [{ key: 'channel', code: 'channel' }] };
  const c = withDefaults(config);
  const errors = [];
  for (const f of ch.fields) {
    const v = c[f.key];
    const empty = v == null || v === '' || (f.type === 'number' && v === 0 && !f.required);
    if (empty) {
      if (f.required) errors.push({ key: f.key, code: 'required' });
      continue;
    }
    const e = f.validate ? f.validate(v, c) : null;
    if (e) errors.push({ key: f.key, ...e });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Split a config into what may go into settings.json and what must go into SecretStorage.
 * secrets: the secret fields, plus the channel id and the bound fields (server, chatId), the copies mergeConfig uses.
 * settings: every non-secret field, bound ones and the channel id included as display copies.
 */
function splitConfig(config) {
  const ch = channelOf(config);
  const settings = {};
  const secrets = {};
  for (const [k, v] of Object.entries(config || {})) {
    const f = ch && ch.fields.find((x) => x.key === k);
    const filled = v != null && v !== '';
    if (f && f.secret) { if (filled) secrets[k] = v; continue; }
    settings[k] = v;
    if (ch && filled && (k === 'channel' || (f && f.bound))) secrets[k] = v;
  }
  return { settings, secrets };
}

/**
 * The config to send with: keyword, dailyMax and key from settings.json; the channel id, the secrets and the bound fields
 * from SecretStorage only. A settings value for a bound field is ignored, so a workspace .vscode/settings.json cannot
 * point the stored token or device key at another server; a bound field missing from SecretStorage takes its default.
 * @param {any} settings this channel's entry from settings.json
 * @param {any} secrets its SecretStorage JSON (as splitConfig wrote it)
 * @returns {any|null} null without stored secrets, for an unknown channel, or when the two channel ids disagree
 */
function mergeConfig(settings, secrets) {
  const st = settings && typeof settings === 'object' ? settings : {};
  const sec = secrets && typeof secrets === 'object' ? secrets : null;
  if (!sec) return null;
  if (typeof sec.channel === 'string' && st.channel != null && st.channel !== sec.channel) return null;
  const channel = typeof sec.channel === 'string' ? sec.channel : st.channel;
  const ch = channelOf(channel);
  if (!ch) return null;
  const out = {};
  for (const [k, v] of Object.entries(st)) {
    const f = ch.fields.find((x) => x.key === k);
    if (!f || !(f.secret || f.bound)) out[k] = v;
  }
  for (const f of ch.fields) if ((f.secret || f.bound) && sec[f.key] != null && sec[f.key] !== '') out[f.key] = sec[f.key];
  out.channel = channel;
  return out;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

// Token shapes masked in any text, whatever the config says
const TOKEN_PATTERNS = [
  [/\b\d{3,20}:[A-Za-z0-9_-]{20,}/g, '***'],                                    // Telegram bot token
  [/(\/bot)[^/\s"']+/g, '$1***'],                                              // …/bot<token>/sendMessage
  [/\bsctp\d+t[A-Za-z0-9_-]*/gi, 'sctp***'],                                   // ServerChan³ SendKey
  [/\bSCT[A-Za-z0-9_-]{4,}/g, 'SCT***'],                                        // ServerChan Turbo SendKey
  [/\bSEC[A-Za-z0-9]{16,}/g, 'SEC***'],                                         // DingTalk signing secret
  [/\btk_[A-Za-z0-9_-]+/g, 'tk_***'],                                           // ntfy access token
  [/((?:Bearer|Basic)\s+)[^\s"',;]+/gi, '$1***'],
  [/([?&](?:access_token|key|sign|token|auth|timestamp)=)[^&#\s"']+/gi, '$1***'],
  [/(\/open-apis\/bot\/v2\/hook\/)[^\s/?#"']+/g, '$1***'],                      // Feishu / Lark
  [/(\/webhooks\/\d+\/)[^\s/?#"']+/g, '$1***'],                                  // Discord
  [/(\/services\/)[^\s?#"']+/g, '$1***'],                                        // Slack
  [/(\.push\.ft07\.com\/send\/)[^\s?#"']+/g, '$1***'],
];

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A URL part that can carry a token: long, or mixing letters and digits (not "open-apis", "webhooks", "sendMessage") */
function tokenLike(s) {
  return s.length >= 16 || (s.length >= 8 && /\d/.test(s));
}

/** Every string worth masking for one secret value: itself, URL-encoded, and for a URL its token-bearing parts */
function secretVariants(value) {
  const v = String(value).trim();
  const out = new Set();
  if (v.length < 3) return out;
  out.add(v);
  out.add(encodeURIComponent(v));
  const u = parseUrl(v);
  if (u) {
    for (const seg of u.pathname.split('/')) if (tokenLike(seg)) { out.add(seg); out.add(decodeSafe(seg)); }
    for (const [, val] of u.searchParams) if (tokenLike(val)) { out.add(val); out.add(encodeURIComponent(val)); }
  }
  return out;
}

function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Masks secrets in a text before it is shown or logged: every secret field value of the channel config (also URL-encoded,
 * and each path segment / query value of a secret URL), plus known token shapes (bot tokens, SendKeys, Bearer tokens,
 * access_token=, key=, sign=, webhook path tokens). Never throws.
 * @param {any} text
 * @param {any} [config] channel config
 * @returns {string}
 */
function redact(text, config) {
  let s = String(text == null ? '' : text);
  try {
    const ch = channelOf(config);
    const values = new Set();
    if (ch) {
      for (const f of ch.fields) if (f.secret && config[f.key] != null) for (const x of secretVariants(config[f.key])) values.add(x);
    }
    for (const v of [...values].sort((a, b) => b.length - a.length)) s = s.replace(new RegExp(escapeRe(v), 'g'), '***');
    for (const [re, rep] of TOKEN_PATTERNS) s = s.replace(re, rep);
  } catch {
    return '***';
  }
  return s;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function parseJson(text) {
  try {
    const v = JSON.parse(String(text));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function oneLineError(s) {
  return cleanText(s, ERROR_MAX);
}

/** A message from a vendor's JSON error body, or the start of the text */
function messageOf(j, text) {
  if (j) {
    for (const k of ['description', 'message', 'msg', 'errmsg', 'error', 'StatusMessage']) {
      if (typeof j[k] === 'string' && j[k].trim()) return j[k];
    }
    const first = Object.values(j).find((v) => typeof v === 'string' && v.trim())
      || Object.values(j).find((v) => Array.isArray(v) && typeof v[0] === 'string');
    if (first) return Array.isArray(first) ? first[0] : first;
  }
  const t = String(text || '').trim();
  return t && !/^[<{[]/.test(t) ? t : '';
}

/**
 * Whether a response means the message was accepted. Several vendors answer HTTP 200 with an error code in the body:
 * DingTalk / WeCom errcode ≠ 0, Feishu code ≠ 0 (or StatusCode ≠ 0), ServerChan code ≠ 0, Bark code ≠ 200,
 * Telegram ok: false. A 2xx without a recognizable body counts as accepted (Discord answers 204, Slack "ok").
 * @param {string} channelId
 * @param {number} status HTTP status
 * @param {string} text response body
 * @param {(s: string) => string} [clean] applied to the vendor message before it is cut to one line (send() passes redact,
 *   so a secret straddling the cut cannot leak its first half); the decision itself always reads the raw body
 * @returns {{ ok: boolean, error: string|null }} error is vendor text (send() redacts it again)
 */
function parseResult(channelId, status, text, clean) {
  const st = Number(status) || 0;
  const j = parseJson(text);
  const ok2xx = st >= 200 && st < 300;
  const fail = (msg, code) => {
    const m = oneLineError(typeof clean === 'function' ? clean(String(msg)) : msg);
    const withCode = code != null && code !== '' && !m.includes(String(code)) ? `${m || 'error'} (${code})` : m;
    return { ok: false, error: withCode || `HTTP ${st}` };
  };
  if (!ok2xx) {
    const m = messageOf(j, text);
    const code = j && (j.errcode ?? j.error_code ?? j.code);
    return fail(m ? `HTTP ${st}: ${m}` : `HTTP ${st}`, typeof code === 'number' && code !== st ? code : null);
  }
  if (!j) return { ok: true, error: null };
  switch (channelId) {
    case 'dingtalk':
    case 'wecom':
      if (j.errcode !== undefined && Number(j.errcode) !== 0) return fail(j.errmsg || 'error', j.errcode);
      break;
    case 'feishu':
      if (j.code !== undefined && Number(j.code) !== 0) return fail(j.msg || 'error', j.code);
      if (j.StatusCode !== undefined && Number(j.StatusCode) !== 0) return fail(j.StatusMessage || 'error', j.StatusCode);
      break;
    case 'serverchan':
      if (j.code !== undefined && Number(j.code) !== 0) return fail(j.message || j.info || 'error', j.code);
      break;
    case 'bark':
      if (j.code !== undefined && Number(j.code) !== 200) return fail(j.message || 'error', j.code);
      break;
    case 'telegram':
      if (j.ok === false) return fail(j.description || 'error', j.error_code);
      break;
    default:
      break;
  }
  return { ok: true, error: null };
}

/** Short reason for a failed fetch: the error code, else the message (redacted before it is cut) */
function networkDetail(err, config) {
  const cause = err && err.cause;
  const code = (cause && (cause.code || cause.name)) || (err && err.code);
  if (typeof code === 'string' && code && code !== 'Error') return oneLineError(redact(code, config));
  return oneLineError(redact((cause && cause.message) || (err && err.message) || 'network error', config));
}

/** Masks secrets, then cuts to one line: redaction must see the whole text */
function safeError(s, config) {
  return redact(oneLineError(redact(s, config)), config);
}

/**
 * The response body, at most RESPONSE_MAX_BYTES read (a server that streams forever is not buffered), as text of at most
 * RESPONSE_MAX characters. Falls back to res.text() for a response without a readable body stream.
 */
async function readBody(res) {
  const body = res && res.body;
  if (body && typeof body.getReader === 'function' && typeof TextDecoder === 'function') {
    const reader = body.getReader();
    const dec = new TextDecoder('utf-8');
    let out = '';
    let bytes = 0;
    try {
      while (bytes < RESPONSE_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(0);
        const part = chunk.subarray(0, RESPONSE_MAX_BYTES - bytes);
        bytes += part.length;
        out += dec.decode(part, { stream: true });
      }
      out += dec.decode();
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    return out.slice(0, RESPONSE_MAX);
  }
  return String(await res.text()).slice(0, RESPONSE_MAX);
}

/**
 * Sends one message through one channel. Never throws or rejects.
 * code: null on success; 'config' (field / problem say which), 'timeout', 'network', 'redirect', 'http' (non-2xx) or
 * 'rejected' (2xx with an error in the body). error is English and always redacted; describeError() localizes it.
 * @param {any} config channel config with secrets merged in, e.g. { channel: 'ntfy', topic: '…' }
 * @param {{ title: string, body: string, priority?: 'high'|'normal', event?: string }} msg
 * @param {{ fetch?: Function, timeoutMs?: number, clock?: () => number, crypto?: any }} [o]
 * @returns {Promise<{ ok: boolean, status: number, error: string|null, code: string|null, field?: string, problem?: string,
 *   timeoutMs?: number }>}
 */
async function send(config, msg, o = {}) {
  const timeoutMs = Number.isFinite(o && o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  let req;
  let ch;
  try {
    ch = channelOf(config);
    if (!ch) return { ok: false, status: 0, code: 'config', error: 'unknown channel', field: 'channel', problem: 'channel' };
    const v = validateConfig(config);
    if (!v.ok) {
      const e = v.errors[0];
      const r = { ok: false, status: 0, code: 'config', error: redact(`${e.key}: ${e.code}`, config), field: e.key, problem: e.code };
      if (e.vars) r.vars = e.vars;
      return r;
    }
    const clock = o && typeof o.clock === 'function' ? o.clock : Date.now;
    req = ch.build(withDefaults(config), msg, Number(clock()), { crypto: o && o.crypto });
  } catch (err) {
    return { ok: false, status: 0, code: 'config', error: safeError(err && err.message, config) };
  }
  const fetchImpl = (o && o.fetch) || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { ok: false, status: 0, code: 'network', error: 'fetch is not available' };

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      try { if (ctrl) ctrl.abort(); } catch { /* ignore */ }
      resolve({ ok: false, status: 0, code: 'timeout', error: `no answer within ${Math.round(timeoutMs / 1000)} s`, timeoutMs });
    }, timeoutMs);
  });
  const attempt = (async () => {
    try {
      const res = await fetchImpl(req.url, {
        method: req.method, headers: req.headers, body: req.body, redirect: 'manual', signal: ctrl ? ctrl.signal : undefined,
      });
      const status = Number(res && res.status) || 0;
      let text = '';
      try { text = await readBody(res); } catch { /* status alone decides */ }
      if (status >= 300 && status < 400) return { ok: false, status, code: 'redirect', error: `HTTP ${status} (redirect)` };
      const r = parseResult(ch.id, status, text, (s) => redact(s, config));
      if (r.ok) return { ok: true, status, error: null, code: null };
      return { ok: false, status, code: status >= 200 && status < 300 ? 'rejected' : 'http', error: redact(r.error, config) };
    } catch (err) {
      if (err && err.name === 'AbortError') return null; // the timer already answered
      return { ok: false, status: 0, code: 'network', error: redact(networkDetail(err, config), config) };
    }
  })();
  try {
    const r = await Promise.race([attempt, timedOut]);
    return r || (await timedOut);
  } catch (err) {
    return { ok: false, status: 0, code: 'network', error: safeError(err && err.message, config) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Localized one-line reason for a failed send() result, for "Channel test failed: {error}" and similar.
 * @param {{ code: string|null, status?: number, error?: string|null, field?: string, problem?: string, timeoutMs?: number }} result
 * @param {Function|{ t: Function }} t
 * @param {{ channel?: string }} [o] channel id (for the host hint of a 'host' problem)
 */
function describeError(result, t, o = {}) {
  const tr = typeof t === 'function' ? t : (k, v) => t.t(k, v);
  const r = result || {};
  // Vendor text lands in a VS Code notification, which renders [label](command:…) as a link
  const err = r.error ? breakLinks(r.error) : '';
  switch (r.code) {
    case 'timeout': return tr('push.err.timeout', { seconds: Math.round((r.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000) });
    case 'network': return tr('push.err.network', { detail: err });
    case 'redirect': return tr('push.err.redirect');
    case 'http': return /^HTTP \d+$/.test(err) || !err
      ? tr('push.err.http', { status: r.status })
      : tr('push.err.httpMessage', { status: r.status, message: err.replace(/^HTTP \d+:\s*/, '') });
    case 'rejected': return tr('push.err.rejected', { message: err });
    case 'config': {
      const ch = channelOf(o.channel || '');
      const f = ch && ch.fields.find((x) => x.key === r.field);
      const vars = { ...(r.vars && typeof r.vars === 'object' ? r.vars : {}), host: hostHint(ch, r.field) };
      const problem = r.problem ? tr(`push.err.${r.problem}`, vars) : err;
      return f ? tr('push.err.config', { field: tr(f.label), problem }) : problem;
    }
    default: return err || tr('push.err.unknown');
  }
}

function hostHint(ch, key) {
  const rules = { feishu: FEISHU_RULE, dingtalk: DINGTALK_RULE, wecom: WECOM_RULE, discord: DISCORD_RULE, slack: SLACK_RULE };
  const r = ch && key === 'webhook' ? rules[ch.id] : null;
  return r ? r.hosts.join(' / ') : '';
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Last path segment of the session folder (either separator); null when unknown */
function projectOf(session) {
  const cwd = session && typeof session.cwd === 'string' ? session.cwd.replace(/[\\/]+$/, '') : '';
  if (!cwd) return null;
  const parts = cwd.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

/** sessionLamps result: from computeLamps' result, from a Map of key → sessionLamps, or computed here */
function lampsFor(lamps, session) {
  const map = lamps && lamps.bySession instanceof Map ? lamps.bySession : lamps instanceof Map ? lamps : null;
  const r = map ? map.get(session.key) : null;
  if (r && typeof r === 'object') return r;
  return map ? null : lampLib.sessionLamps(session);
}

/** When the lead row entered its state (same candidates as notify's transitionId) */
function sinceOf(L, session) {
  const lead = L && L.lead;
  for (const v of [lead && lead.status && lead.status.sinceMs, lead && lead.agent && lead.agent.status && lead.agent.status.sinceMs,
    session && session.updatedMs]) if (Number.isFinite(v) && v > 0) return Math.round(v);
  return 0;
}

/** Push-worthy state of a session: 'needsYou', 'error' (an API error; usage limits come from the quota snapshot) or null */
function pushStateOf(L) {
  if (!L) return null;
  if (L.lamp === S.LAMP.NEEDS_YOU) return 'needsYou';
  if (L.lamp === S.LAMP.ERROR) {
    const code = L.lead && L.lead.status && L.lead.status.code;
    return code === S.STATUS.QUOTA ? null : 'error';
  }
  return null;
}

/** Event id: needsYou uses notify's transitionId as is (so the push and the desktop notification name the same wait) */
function sessionTransitionId(type, session, L) {
  const base = notify.transitionIdOf(session, L);
  return type === 'needsYou' ? base : `${type}|${base}`;
}

function agentNameOf(session, L) {
  const lead = (L && L.lead) || { rowId: ROW_MAIN, agent: session.main || null };
  const agent = lead.agent || null;
  if ((lead.rowId || ROW_MAIN) === ROW_MAIN || !agent || agent.kind === 'main') return null;
  const raw = agent.name || agent.agentType || (agent.id != null ? String(agent.id).slice(0, 8) : '');
  return raw ? String(raw) : null;
}

/**
 * Chat title fit for a push: only a real title (set by the user, written by the agent, or from the provider's index).
 * A title made from the prompt ('prompt') or the session id ('id') is left out: prompts never leave the computer.
 */
function pushTitleOf(session) {
  return session && SAFE_TITLE_SOURCES.has(session.titleSource) ? String(session.title || '') : '';
}

function sessionEvent(type, session, L) {
  return {
    type,
    key: session.key,
    transitionId: sessionTransitionId(type, session, L),
    title: pushTitleOf(session),
    titleSource: typeof session.titleSource === 'string' ? session.titleSource : null,
    project: projectOf(session),
    agentName: agentNameOf(session, L),
    provider: session.provider || String(session.key).split(':')[0] || null,
  };
}

/**
 * Current usage-limit hits from a QuotaSnapshot (lib/core/quota.js, filled by monitor.js): Claude's lastHit, and Codex
 * when rate_limit_reached_type is set or a window is at 100 %. The id derives from the data only (reset time, else the
 * hit time), so every window names the same hit alike.
 */
function limitHitsOf(quota) {
  const out = [];
  const hit = quota && quota.claude && quota.claude.lastHit;
  if (hit && Number.isFinite(hit.ms) && hit.ms > 0) {
    const resetAt = Number.isFinite(hit.resetsAtMs) && hit.resetsAtMs > 0 ? Math.round(hit.resetsAtMs) : null;
    out.push({ provider: 'claude', resetAt, at: Math.round(hit.ms), sessionKey: typeof hit.sessionKey === 'string' ? hit.sessionKey : null });
  }
  const cq = quota && quota.codex;
  if (cq && typeof cq === 'object') {
    const ws = Array.isArray(cq.windows) ? cq.windows.filter((w) => w && typeof w === 'object') : [];
    const full = ws.filter((w) => Number(w.usedPct) >= 100);
    if (full.length || (typeof cq.reachedType === 'string' && cq.reachedType)) {
      const pool = full.length ? full : ws;
      let resetAt = null;
      for (const w of pool) if (Number.isFinite(w.resetsAtMs) && w.resetsAtMs > 0) resetAt = Math.max(resetAt || 0, Math.round(w.resetsAtMs));
      const at = Number.isFinite(cq.observedMs) && cq.observedMs > 0 ? Math.round(cq.observedMs) : 0;
      if (resetAt != null || at > 0) out.push({ provider: 'codex', resetAt, at, sessionKey: null });
    }
  }
  return out;
}

/** Bounded insertion-ordered set */
function rememberId(set, id, max) {
  set.delete(id);
  set.add(id);
  while (set.size > max) set.delete(set.values().next().value);
}

/**
 * Tracks what is worth pushing.
 * - The first update only seeds: states and limit hits present when the window opens are not reported (a limit whose
 *   reset time is still ahead is remembered, so its limitReset is reported later). Sessions and the quota snapshot seed
 *   separately, on the first update that carries each.
 * - needsYou / error: a session entering that lamp (error only for API errors). Ids come from notify.transitionIdOf, so
 *   every window derives the same one; a flicker of the same wait or error is not reported twice.
 * - limitHit: a new hit in the quota snapshot; limitReset: a known reset time has passed.
 * - Anything that began more than maxAgeMs ago is not reported (a session that just came into scope, a laptop that
 *   slept through a reset): the push is about what happens now.
 * @param {{ maxAgeMs?: number }} [o]
 */
function createPushTracker(o = {}) {
  const maxAgeMs = Number.isFinite(o.maxAgeMs) && o.maxAgeMs > 0 ? o.maxAgeMs : DEFAULT_MAX_AGE_MS;
  let seeded = false;            // sessions seen once
  let quotaSeeded = false;       // a quota snapshot seen once (seeded separately: a caller may pass it later)
  const state = new Map();       // key → 'needsYou'|'error'|null for present keys
  const lastId = new Map();      // `${type}|${key}` → last transitionId seen for that key and type
  const limitIds = new Set();    // limitHit ids already seen
  const resets = new Map();      // limitReset id → pending reset
  const reachedSince = new Map(); // provider → first observation of a hit with no known reset time (Codex)
  const knownReset = new Map();   // provider → last canonical reset time (see RESET_SNAP_MS)

  /** Reset time as ids use it: rounded up to the minute, snapped to this provider's known reset when within RESET_SNAP_MS */
  function canonReset(provider, resetAt) {
    const q = Math.ceil(resetAt / RESET_STEP_MS) * RESET_STEP_MS;
    const prev = knownReset.get(provider);
    if (prev != null && Math.abs(prev - q) <= RESET_SNAP_MS) return prev;
    knownReset.set(provider, q);
    return q;
  }

  /**
   * @param {{ sessions?: any[], lamps?: any, quota?: any, now?: number }} [input]
   * @returns {{ type: string, key: string, transitionId: string, title: string, titleSource: string|null,
   *   project: string|null, agentName: string|null, provider: string|null, resetAt?: number|null }[]}
   *   title is '' unless it is a real chat title (see pushTitleOf)
   */
  function update(input = {}) {
    const { sessions, lamps, quota } = input || {};
    const now = Number.isFinite(input && input.now) ? input.now : Date.now();
    const out = [];
    const byKey = new Map();
    const fresh = (since) => !(since > 0) || now - since <= maxAgeMs;

    if (Array.isArray(sessions)) {
      const present = new Set();
      for (const s of sessions) {
        if (!s || typeof s.key !== 'string' || present.has(s.key)) continue;
        present.add(s.key);
        byKey.set(s.key, s);
        const L = lampsFor(lamps, s);
        const kind = pushStateOf(L);
        const was = state.get(s.key) || null;
        state.set(s.key, kind);
        if (!kind || kind === was) continue;
        const ev = sessionEvent(kind, s, L);
        const k = `${kind}|${s.key}`;
        const prevId = lastId.get(k);
        lastId.delete(k); // re-insert: pruning drops the oldest first
        lastId.set(k, ev.transitionId);
        if (seeded && prevId !== ev.transitionId && fresh(sinceOf(L, s))) out.push(ev);
      }
      for (const k of [...state.keys()]) if (!present.has(k)) state.delete(k);
      if (lastId.size > TRACKER_MAX_KEYS) {
        for (const k of [...lastId.keys()]) {
          if (lastId.size <= TRACKER_MAX_KEYS) break;
          if (!present.has(k.slice(k.indexOf('|') + 1))) lastId.delete(k);
        }
      }
    }

    const hasQuota = !!quota && typeof quota === 'object';
    if (hasQuota) {
      const hits = limitHitsOf(quota);
      for (const p of [...reachedSince.keys()]) if (!hits.some((h) => h.provider === p && h.resetAt == null)) reachedSince.delete(p);
      for (const h of hits) {
        if (h.resetAt != null) h.resetAt = canonReset(h.provider, h.resetAt);
        // Codex's observation time moves with every rate_limits line; while the same hit lasts, keep its first one
        if (h.provider === 'codex' && h.resetAt == null) {
          if (!reachedSince.has('codex')) reachedSince.set('codex', h.at);
          h.at = reachedSince.get('codex');
        }
        const id = `limitHit|${h.provider}|${h.resetAt != null ? h.resetAt : `at${h.at}`}`;
        const s = h.sessionKey ? byKey.get(h.sessionKey) : null;
        const base = {
          key: h.sessionKey || `quota:${h.provider}`,
          title: pushTitleOf(s),
          titleSource: s && typeof s.titleSource === 'string' ? s.titleSource : null,
          project: s ? projectOf(s) : null,
          agentName: null,
          provider: h.provider,
          resetAt: h.resetAt,
        };
        if (h.resetAt != null && h.resetAt > now) {
          const rid = `limitReset|${h.provider}|${h.resetAt}`;
          if (!resets.has(rid)) {
            resets.set(rid, { ...base, type: 'limitReset', transitionId: rid });
            while (resets.size > RESETS_MAX) resets.delete(resets.keys().next().value);
          }
        }
        if (limitIds.has(id)) continue;
        rememberId(limitIds, id, LIMIT_IDS_MAX);
        const active = h.resetAt == null || h.resetAt > now;
        if (quotaSeeded && active && fresh(h.at)) out.push({ type: 'limitHit', transitionId: id, ...base });
      }
    }

    for (const [rid, r] of [...resets]) {
      if (r.resetAt > now) continue;
      resets.delete(rid);
      if (quotaSeeded && now - r.resetAt <= maxAgeMs) {
        const s = byKey.get(r.key);
        out.push({
          ...r,
          title: s ? pushTitleOf(s) : r.title,
          titleSource: s && typeof s.titleSource === 'string' ? s.titleSource : r.titleSource,
          project: s ? projectOf(s) : r.project,
        });
      }
    }

    if (Array.isArray(sessions)) seeded = true;
    if (hasQuota) quotaSeeded = true;
    return out;
  }

  return { update };
}

/**
 * Whether an event still holds: needsYou / error → the session is still in that state with the same transitionId;
 * limit events always hold. Used when a needsYou delay ends.
 * @param {any} event
 * @param {any[]} sessions
 * @param {any} [lamps]
 */
function isStillActive(event, sessions, lamps) {
  if (!event) return false;
  if (event.type !== 'needsYou' && event.type !== 'error') return true;
  const s = Array.isArray(sessions) ? sessions.find((x) => x && x.key === event.key) : null;
  if (!s) return false;
  const L = lampsFor(lamps, s);
  return pushStateOf(L) === event.type && sessionTransitionId(event.type, s, L) === event.transitionId;
}

/**
 * The event as it stands now: needsYou / error → the session's current event of that type, whatever its transitionId
 * (the wait may have moved on while the lamp stayed on, e.g. a second tool call asked right after the first one was
 * approved, or another subagent now leads), or null when the session is no longer in that state; limit events as they are.
 * @param {any} event
 * @param {any[]} sessions
 * @param {any} [lamps]
 * @returns {any|null}
 */
function currentEventOf(event, sessions, lamps) {
  if (!event) return null;
  if (event.type !== 'needsYou' && event.type !== 'error') return event;
  const s = Array.isArray(sessions) ? sessions.find((x) => x && x.key === event.key) : null;
  if (!s) return null;
  const L = lampsFor(lamps, s);
  return pushStateOf(L) === event.type ? sessionEvent(event.type, s, L) : null;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Push settings with defaults: off; all four events on; needsYou waits 30 s; chat titles left out.
 * @param {any} raw { enabled, events: { needsYou, error, limitHit, limitReset }, delaySeconds, includeTitle }
 */
function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ev = r.events && typeof r.events === 'object' ? r.events : {};
  const events = {};
  for (const t of EVENT_TYPES) events[t] = ev[t] !== false;
  const d = Number(r.delaySeconds);
  return {
    enabled: r.enabled === true,
    events,
    delaySeconds: Number.isFinite(d) ? Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.round(d))) : DEFAULT_DELAY_SECONDS,
    includeTitle: r.includeTitle === true,
  };
}

/**
 * What to do with an event.
 * - 'drop': push is off, the event type is off, or (needsYou) the chat is no longer waiting (stillActive === false);
 * - 'wait': needsYou with a delay: call plan again after delayMs with stillActive (isStillActive) — the push is an
 *   escalation after the desktop notification;
 * - 'send': go now; claimId is for notify.claimOnce so only one window sends it.
 * @param {{ event: any, settings?: any, stillActive?: boolean }} o
 * @returns {{ action: 'drop'|'wait'|'send', delayMs: number, claimId: string|null, reason?: string }}
 */
function plan(o = {}) {
  const event = o && o.event;
  if (!event || !EVENT_TYPES.includes(event.type) || typeof event.transitionId !== 'string') {
    return { action: 'drop', delayMs: 0, claimId: null, reason: 'invalid' };
  }
  const s = normalizeSettings(o.settings);
  const claimId = CLAIM_PREFIX + event.transitionId;
  if (!s.enabled) return { action: 'drop', delayMs: 0, claimId, reason: 'off' };
  if (!s.events[event.type]) return { action: 'drop', delayMs: 0, claimId, reason: 'eventOff' };
  if (event.type === 'needsYou') {
    if (o.stillActive === false) return { action: 'drop', delayMs: 0, claimId, reason: 'answered' };
    if (o.stillActive !== true && s.delaySeconds > 0) return { action: 'wait', delayMs: s.delaySeconds * 1000, claimId };
  }
  return { action: 'send', delayMs: 0, claimId };
}

/**
 * JSON file store for the limiter's send history, so windows share the caps (best effort: missing or corrupt → empty).
 * @param {string} file e.g. path.join(notify.sharedClaimDir(), 'push-sent.json')
 * @param {typeof import('fs')} [fsImpl]
 */
function fileStore(file, fsImpl) {
  const fsx = fsImpl || fs;
  return {
    load() {
      try {
        const v = JSON.parse(String(fsx.readFileSync(file, 'utf8')));
        return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
      } catch {
        return null;
      }
    },
    save(obj) {
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fsx.writeFileSync(tmp, JSON.stringify(obj));
        fsx.renameSync(tmp, file);
      } catch {
        try { fsx.unlinkSync(tmp); } catch { /* ignore */ }
      }
    },
  };
}

/**
 * Per-channel queue with coalescing and caps.
 * - add(channel, event, now, { dailyMax }): queue an event (same transitionId once); returns when the batch is ready.
 * - due(now): { batches, dropped, nextAt } — batches ready now: the first event waited coalesceMs (so a burst goes out as
 *   one message) and the channel's last send (in any window, with a store) is perChannelMinMs ago. A batch over perHourMax
 *   sends in the last hour or dailyMax in the last 24 h is dropped (reason 'hourly' / 'daily'), not held back to arrive
 *   stale; so is an event queued more than maxQueueMs ago (reason 'stale'). Every attempt counts (ServerChan counts failed
 *   calls too). nextAt is when to call due() again (null when nothing is queued): always re-arm with it, because another
 *   window's send can push a batch back.
 * - nextAt(): the same, at any time.
 * @param {{ perChannelMinMs?: number, perHourMax?: number, coalesceMs?: number, maxQueueMs?: number,
 *   store?: { load(): any, save(obj: any): void } }} [o]
 */
function createLimiter(o = {}) {
  const pick = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  const minGap = pick(o.perChannelMinMs, 10000);
  const hourMax = pick(o.perHourMax, 20);
  const coalesceMs = pick(o.coalesceMs, 3000);
  const maxQueueMs = Number.isFinite(o.maxQueueMs) && o.maxQueueMs > 0 ? o.maxQueueMs : DEFAULT_MAX_AGE_MS;
  const store = o.store || null;
  const queues = new Map(); // channel → { events, addedAt (parallel to events), firstAt, dailyMax }
  const hist = new Map();   // channel → send times (ascending, last 24 h)

  const prune = (arr, now) => (arr || []).filter((x) => Number.isFinite(x) && x > now - DAY_MS && x <= now + HOUR_MS);

  function sync(now) {
    if (!store) return;
    let saved = null;
    try { saved = store.load(); } catch { saved = null; }
    if (!saved || typeof saved !== 'object') return;
    for (const [ch, arr] of Object.entries(saved)) {
      if (!Array.isArray(arr)) continue;
      const merged = new Set([...(hist.get(ch) || []), ...arr.map(Number)]);
      hist.set(ch, prune([...merged].sort((a, b) => a - b), now));
    }
  }

  function readyAt(ch, q) {
    const h = hist.get(ch) || [];
    const last = h.length ? h[h.length - 1] : -Infinity;
    return Math.max(q.firstAt + coalesceMs, last + minGap);
  }

  function add(channel, event, now, opts = {}) {
    sync(now); // the ready time must count other windows' sends
    const ch = String(channel || '');
    let q = queues.get(ch);
    if (!q) { q = { events: [], addedAt: [], firstAt: now, dailyMax: 0 }; queues.set(ch, q); }
    if (event && !q.events.some((e) => e.transitionId === event.transitionId)) { q.events.push(event); q.addedAt.push(now); }
    const d = nonNegInt(opts && opts.dailyMax);
    q.dailyMax = Number.isNaN(d) ? 0 : d;
    return readyAt(ch, q);
  }

  function due(now) {
    sync(now);
    const batches = [];
    const dropped = [];
    for (const [ch, q] of [...queues]) {
      const stale = q.events.filter((e, i) => now - q.addedAt[i] > maxQueueMs);
      if (stale.length) {
        dropped.push({ channel: ch, events: stale, reason: 'stale' });
        const keep = q.events.map((e, i) => i).filter((i) => now - q.addedAt[i] <= maxQueueMs);
        q.events = keep.map((i) => q.events[i]);
        q.addedAt = keep.map((i) => q.addedAt[i]);
        if (!q.events.length) { queues.delete(ch); continue; }
        q.firstAt = Math.max(q.firstAt, q.addedAt[0]);
      }
      if (now < readyAt(ch, q)) continue;
      queues.delete(ch);
      const h = prune(hist.get(ch), now);
      const lastHour = h.filter((x) => x > now - HOUR_MS).length;
      if (hourMax > 0 && lastHour >= hourMax) { dropped.push({ channel: ch, events: q.events, reason: 'hourly' }); continue; }
      if (q.dailyMax > 0 && h.length >= q.dailyMax) { dropped.push({ channel: ch, events: q.events, reason: 'daily' }); continue; }
      h.push(now);
      hist.set(ch, h);
      batches.push({ channel: ch, events: q.events });
    }
    if (batches.length && store) {
      try { store.save(Object.fromEntries([...hist].map(([k, v]) => [k, prune(v, now)]))); } catch { /* best effort */ }
    }
    return { batches, dropped, nextAt: nextAt() };
  }

  function nextAt() {
    let t = null;
    for (const [ch, q] of queues) { const r = readyAt(ch, q); if (t == null || r < t) t = r; }
    return t;
  }

  /** Sends recorded for a channel within windowMs before now (default 24 h) */
  function count(channel, now, windowMs = DAY_MS) {
    return (hist.get(String(channel)) || []).filter((x) => x > now - windowMs && x <= now).length;
  }

  return { add, due, nextAt, count };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function providerName(tr, provider) {
  const key = `push.provider.${provider}`;
  const v = tr(key);
  return v && v !== key ? v : cleanText(provider || '', NAME_MAX);
}

/** Title and body for one event */
function describeEvent(e, tr, o) {
  const project = cleanText(e.project, NAME_MAX);
  const chat = o.includeTitle && SAFE_TITLE_SOURCES.has(e.titleSource) ? cleanText(e.title, CHAT_TITLE_MAX) : '';
  const agent = o.includeTitle ? cleanText(e.agentName, NAME_MAX) : '';
  if (e.type === 'needsYou' || e.type === 'error') {
    const p = `push.msg.${e.type}`;
    const title = project ? tr(`${p}.titleProject`, { project }) : tr(`${p}.title`);
    let body;
    if (chat && agent) body = tr(`${p}.bodyAgent`, { title: chat, agent });
    else if (chat) body = tr(`${p}.bodyTitle`, { title: chat });
    else body = tr(`${p}.body`);
    return { title, body, chat };
  }
  const provider = providerName(tr, e.provider);
  if (e.type === 'limitHit') {
    const reset = Number.isFinite(e.resetAt) && o.clock ? o.clock(e.resetAt) : '';
    return {
      title: tr('push.msg.limitHit.title', { provider }),
      body: reset ? tr('push.msg.limitHit.body', { reset }) : tr('push.msg.limitHit.bodyUnknown'),
      chat: '',
    };
  }
  return { title: tr('push.msg.limitReset.title', { provider }), body: tr('push.msg.limitReset.body'), chat: '' };
}

/**
 * Push message for one or more events (a coalesced batch).
 * Default content: the project folder name and the state (for limits: the provider and the reset time). Chat titles and
 * agent names only with includeTitle. Never prompts, code, paths, token counts or cost.
 * @param {any[]} events
 * @param {Function|{ t: Function, fmtClock?: Function }} t translate function (key, vars) or an i18n instance
 * @param {{ includeTitle?: boolean, now?: number, fmtClock?: (ms: number) => string }} [o]
 * @returns {{ title: string, body: string, priority: 'high'|'normal', event: string }}
 */
function formatPush(events, t, o = {}) {
  const tr = typeof t === 'function' ? t : (k, v) => t.t(k, v);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const clock = typeof o.fmtClock === 'function' ? o.fmtClock
    : t && typeof t.fmtClock === 'function' ? (ms) => t.fmtClock(ms, now) : null;
  const seen = new Set();
  const list = (Array.isArray(events) ? events : [events])
    .filter((e) => e && EVENT_TYPES.includes(e.type) && !seen.has(e.transitionId) && seen.add(e.transitionId))
    .sort((a, b) => EVENT_ORDER[a.type] - EVENT_ORDER[b.type]);
  if (!list.length) return { title: APP_NAME, body: '', priority: 'normal', event: '' };
  const opts = { includeTitle: !!o.includeTitle, clock };
  const priority = list.some((e) => e.type === 'needsYou' || e.type === 'error') ? 'high' : 'normal';
  if (list.length === 1) {
    const d = describeEvent(list[0], tr, opts);
    return { title: d.title, body: d.body, priority, event: list[0].type };
  }
  const lines = list.slice(0, BATCH_LINES_MAX).map((e) => {
    const d = describeEvent(e, tr, opts);
    return d.chat ? tr('push.msg.batch.lineTitle', { line: d.title, title: d.chat }) : d.title;
  });
  if (list.length > BATCH_LINES_MAX) lines.push(tr('push.msg.batch.more', { n: list.length - BATCH_LINES_MAX }));
  return { title: tr('push.msg.batch.title', { n: list.length }), body: lines.join('\n'), priority, event: list[0].type };
}

/** The message sent by "test channel" */
function testMessage(t) {
  const tr = typeof t === 'function' ? t : (k, v) => t.t(k, v);
  return { title: tr('push.msg.test.title'), body: tr('push.msg.test.body'), priority: 'normal', event: 'test' };
}

module.exports = {
  APP_NAME, EVENT_TYPES, CLAIM_PREFIX, DEFAULT_TIMEOUT_MS, DEFAULT_DELAY_SECONDS,
  // channels
  CHANNELS, CHANNEL_IDS, channelOf, channelKeyOf, withDefaults, validateConfig, splitConfig, mergeConfig, randomTopic,
  checkServerUrl, checkWebhookUrl, isPrivateHost, feishuSign, dingtalkSign, headerText, breakLinks,
  // sending
  parseResult, send, redact, describeError,
  // events and policy
  createPushTracker, isStillActive, currentEventOf, normalizeSettings, plan, createLimiter, fileStore,
  // text
  formatPush, testMessage,
};
