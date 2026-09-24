'use strict';
// 压缩按钮（DESIGN §11.4、§11.5，按 §11.8 第 3、4 条调整）与三种提醒（§11.7、§11.8 第 5–7 条）。
// - 命令 agentMonitor.compact（参数：会话树节点或 sessionKey）弹 QuickPick：
//   Claude 打开中 → 在会话里压缩（预填，不自动发送）；Claude 未打开 → 选模型、在后台调用本机 Claude Code 压缩；
//   Codex → 打开 + 复制 /compact。三种都另有“写交接笔记后开新会话”一项。
// - 交接笔记也是独立命令 agentMonitor.handoff：本模块导出 runHandoff，由 extension.js 注册（§11.12.4）。
// - deliverText（预填 + 剪贴板退路）导出给 lib/autocompact.js 预填 /autocompact 用。
// - 后台压缩：spawn 不经过 shell、stdin 为 ignore；sessionId 必须是 UUID，模型只能取候选白名单，cwd 必须存在；
//   执行前再读一次在线登记表，会话已被打开就中止。
// - 扩展自身不联网：只有用户确认后才调用本机 Claude Code，由它联网。没有用户点击，不会触发任何压缩。
// - 选项生成、估价、参数校验、CLI 查找、子进程运行、结果解析、提醒判定都是纯函数，不依赖 vscode，测试直接调用；
//   vscode 只在 activateCompact 里取用。

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const S = require('./core/status');
const pricing = require('./core/pricing');
const { claudeWindow } = require('./core/context');
const claudeLive = require('./providers/claude-live');
const scopeLib = require('./scope');
const { entryLabel, COMPACTABLE_MIN } = require('./format');

const CMD = 'agentMonitor.compact';
const CLAUDE_OPEN_CMD = 'claude-vscode.editor.open';   // Claude 扩展：打开会话并预填 prompt（不发送）
const CLAUDE_EXT_ID = 'anthropic.claude-code';
const CLAUDE_VSCODE_ENTRY = 'claude-vscode';
const CODEX_AUTHORITY = 'openai.chatgpt';               // Codex 扩展的 URI 处理器：path 当页面路由
const COMPACT_CMD = '/compact';

const TIMEOUT_MS = 10 * 60e3;          // §11.4：超时 10 分钟
const KILL_GRACE_MS = 3000;            // SIGTERM 后等这么久还没退出就 SIGKILL
const STDOUT_MAX = 4 * 1024 * 1024;    // 结果 JSON 很小，防御性上限
const STDERR_KEEP = 64 * 1024;         // 只留 stderr 末尾
const TAIL_LINES = 5;                  // 失败时显示 stderr 最后 5 行
const BOUNDARY_SCAN_MAX = 8 * 1024 * 1024;
const TEXT_MAX = 2000;                 // 保留要求的长度上限
const CHEAPER_MIN_SAVING = 0.3;        // §11.4 第 4 条：换 Sonnet 5 能省 ≥ 30% 才给说明项
const REMIND_MIN_GAIN_USD = 0.5;       // §11.7：过期后压缩比现在压缩贵至少 $0.50 才提醒
const SONNET_TARGET = 'claude-sonnet-5';
// 连续几份快照不在登记表里才算“关掉了”：登记表文件正在改写时读失败，会话会看起来消失一次
const CLOSE_CONFIRM_SNAPSHOTS = 2;

// 模型 id 的形状（白名单之外的第二道防线）：字母数字、点、横线，可带 [1m]
const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{0,79}(\[1m\])?$/i;
// Codex 线程 id 拼进 URI，只允许这些字符
const CODEX_ID_RE = /^[A-Za-z0-9][\w-]{0,127}$/;

const MUTE_KEY = 'agentMonitor.compact.muted';             // workspaceState：{ [sessionId]: ms }，“这个会话不再提醒”
const HINT_OFF_KEY = 'agentMonitor.compact.postHintOff';   // globalState：压缩后提示“不再提示”

const DEFAULTS = Object.freeze({
  compactConfirm: true,
  compactTemplate: '',
  cacheReminder: true,
  cacheReminderMinutes: 8,           // §11.8 第 10 条：默认改为 8
  cacheReminderMinContext: 150000,
  cacheReminderShortTtl: false,
  closeReminder: true,
  postCompactHint: true,
});

const SEPARATOR_KIND = -1; // vscode.QuickPickItemKind.Separator

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clip = (s, n) => {
  const a = Array.from(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
  return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join('');
};

// ---------------------------------------------------------------------------
// 会话字段
// ---------------------------------------------------------------------------

/** 会话的上下文占用（Session 顶层字段，缺失时取主智能体的） */
function contextUsedOf(s) {
  if (!s) return 0;
  if (fin(s.contextUsed)) return s.contextUsed;
  const t = s.main && s.main.tokens;
  return t && fin(t.contextUsed) ? t.contextUsed : 0;
}

/** 缓存按 API 调用计时，所以用 lastApiMs（没有才用 lastActivityMs） */
function lastApiOf(s) {
  if (fin(s.lastApiMs)) return s.lastApiMs;
  if (fin(s.lastActivityMs)) return s.lastActivityMs;
  const m = s.main;
  if (m && fin(m.lastApiMs)) return m.lastApiMs;
  return m && fin(m.lastActivityMs) ? m.lastActivityMs : null;
}

/** 这次压缩请求会用的 TTL（§11.5）：会话最近检测到的档位；检测不到按订阅主对话的 1h */
function ttlOf(s) {
  return s && (s.cacheTtl === '5m' || s.cacheTtl === '1h') ? s.cacheTtl : '1h';
}

function isHaiku(model) {
  return pricing.normalizeClaudeModel(model).startsWith('claude-haiku');
}

/** 命令参数 → sessionKey：字符串，或会话树节点（key / sessionKey / session.key） */
function keyFromArg(arg) {
  if (typeof arg === 'string') return arg;
  if (!arg || typeof arg !== 'object') return null;
  for (const v of [arg.sessionKey, arg.key, arg.session && arg.session.key]) {
    if (typeof v === 'string' && v) return v;
  }
  if (typeof arg.provider === 'string' && typeof arg.id === 'string') return S.sessionKey(arg.provider, arg.id);
  // TreeItem.id 直接用 sessionKey 的写法
  const p = typeof arg.id === 'string' ? S.parseSessionKey(arg.id) : null;
  if (p && (p.provider === 'claude' || p.provider === 'codex')) return arg.id;
  return null;
}

// ---------------------------------------------------------------------------
// 估价（§11.5）
// ---------------------------------------------------------------------------

/**
 * 基座 estimateCompact 在缓存未命中时一律按 5 分钟缓存写价取价；§11.5 要按这次请求会用的 TTL 取。
 * 这里只在“结果恰好等于 5 分钟档”时改成 1 小时档，所以基座以后修好了也不会重复换算。
 */
function applyTtl(est, ttl) {
  if (!est || ttl !== '1h' || est.pricing !== 'miss' || !est.available || est.readUsd == null) return est;
  const r = pricing.claudeRates(est.targetModel);
  if (!r) return est;
  const at5m = est.contextTokens * r.cacheWrite5m / 1e6;
  if (Math.abs(est.readUsd - at5m) > 1e-9 || r.cacheWrite1h === r.cacheWrite5m) return est;
  const readUsd = est.contextTokens * r.cacheWrite1h / 1e6;
  return { ...est, readUsd, usd: readUsd + (est.writeUsd || 0) };
}

/**
 * 一次压缩的估价。o.expired = true：按“缓存已过期”算（提醒里的“过期后再压缩”）。
 * @returns {ReturnType<typeof pricing.estimateCompact>}
 */
function estimateFor(session, targetModel, now, o = {}) {
  const ttl = ttlOf(session);
  const est = pricing.estimateCompact({
    contextUsed: contextUsedOf(session),
    model: session.model || null,
    targetModel: targetModel || session.model || null,
    ttl,
    lastActivityMs: o.expired ? null : lastApiOf(session),
    now,
    isMain: true,
  });
  return applyTtl(est, ttl);
}

/**
 * 推荐项：可用、有价、有 id 的里面估价最低的；同价保留先出现的（原模型在最前）。
 * @param {{ id: string|null, available: boolean, usd: number|null }[]} list
 */
function pickRecommended(list) {
  let best = null;
  for (const c of list) {
    if (!c.id || !c.available || c.usd == null) continue;
    if (!best || c.usd < best.usd - 1e-9) best = c;
  }
  return best;
}

/**
 * 后台压缩的候选（§11.4）：原模型、claude-sonnet-5、claude-haiku-4-5，估价按 TTL 修正后重新算推荐与节省比例。
 * @returns {{ candidates: any[], recommended: string|null }}
 */
function candidatesFor(session, now) {
  const ttl = ttlOf(session);
  const base = pricing.compactCandidates({
    contextUsed: contextUsedOf(session),
    model: session.model || null,
    ttl,
    lastActivityMs: lastApiOf(session),
    now,
    isMain: true,
  });
  const list = base.candidates.map((c) => ({ ...applyTtl(c, ttl), recommended: false, savingVsOriginal: null }));
  const orig = list[0];
  for (const c of list) {
    if (c !== orig && orig && orig.usd != null && c.usd != null && orig.usd > 0) c.savingVsOriginal = (orig.usd - c.usd) / orig.usd;
  }
  const best = pickRecommended(list);
  if (best) best.recommended = true;
  return { candidates: list, recommended: best ? best.id : null };
}

/**
 * 传给 --model 的值：原模型在 200K 窗口的模型上却已超过 200K（开了 1M 扩展上下文，记录里不带 [1m]）→ 加 [1m]。
 * @param {string} id 候选 id
 * @param {any} session
 */
function cliModelFor(id, session) {
  if (!id) return null;
  const same = pricing.normalizeClaudeModel(id) === pricing.normalizeClaudeModel(session.model);
  if (!same || /\[1m\]$/i.test(id)) return id;
  const used = contextUsedOf(session);
  const { window } = claudeWindow(id, 0);
  return used + pricing.COMPACT_HEADROOM > window ? id + '[1m]' : id;
}

/** 这个会话允许传给 --model 的全部值（白名单） */
function allowedModels(session, now = Date.now()) {
  const out = [];
  for (const c of candidatesFor(session, now).candidates) {
    if (!c.id || !c.available || !MODEL_ID_RE.test(c.id)) continue;
    const m = cliModelFor(c.id, session);
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 文本
// ---------------------------------------------------------------------------

/** 保留要求：设置 compactTemplate 非空就用它，否则用词典（§11.8 第 3 条）。去掉用户多写的开头 /compact。 */
function resolveTemplate(configValue, i18n) {
  const own = typeof configValue === 'string' ? normalizeInstructions(configValue) : '';
  return own || normalizeInstructions(i18n.t('compact.template'));
}

/** 保留要求规整成一行：去掉开头的 /compact，换行并成空格，限长 */
function normalizeInstructions(text) {
  let s = String(text == null ? '' : text).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  s = s.replace(/^\/compact\b\s*/i, '').trim();
  if (s.length > TEXT_MAX) s = s.slice(0, TEXT_MAX);
  return s;
}

/** '/compact' 或 '/compact {保留要求}' */
function compactPrompt(instructions) {
  const s = normalizeInstructions(instructions);
  return s ? `${COMPACT_CMD} ${s}` : COMPACT_CMD;
}

/** stderr 的最后 n 个非空行 */
function tailLines(text, n = TAIL_LINES) {
  return String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).slice(-n);
}

function usdText(est, i18n) {
  if (est && est.usd != null) return i18n.t('compact.detail.usd', { usd: i18n.fmtUsd(est.usd) });
  return i18n.t('compact.detail.unpriced', { model: (est && est.targetModel) || '—' });
}

function cacheText(est, session, i18n, now) {
  if (!est.sameModel) return i18n.t('compact.detail.newModel');
  if (est.pricing === 'hit') {
    const exp = session.cacheExpiresMs;
    if (fin(exp) && exp > now) return i18n.t('compact.detail.cacheWarmLeft', { m: Math.max(1, Math.ceil((exp - now) / 60e3)) });
    return i18n.t('compact.detail.cacheWarm');
  }
  return i18n.t('compact.detail.cacheExpired');
}

// ---------------------------------------------------------------------------
// QuickPick 选项（§11.4、§11.8 第 3、4 条）
// ---------------------------------------------------------------------------

/**
 * 生成 QuickPick 的标题、说明和选项。纯函数，item.action 描述选中后做什么：
 * - { type: 'inSession' }：预填 /compact {模板}；{ type: 'custom' }：先 InputBox 改保留要求再预填
 * - { type: 'background', model }：后台压缩（model 是 --model 的值）
 * - { type: 'handoff' }：写交接笔记；{ type: 'codexOpen' }：打开 Codex 并复制 /compact
 * - { type: 'info', text }：只弹说明，不执行
 * @param {any} session
 * @param {{ i18n: any, now?: number, live: boolean, liveStatus?: string|null, separatorKind?: number }} ctx
 * @returns {{ title: string, placeholder: string, items: any[], active: any|null }}
 */
function buildPickItems(session, ctx) {
  const i18n = ctx.i18n;
  const now = ctx.now ?? Date.now();
  const sep = { label: '', kind: ctx.separatorKind ?? SEPARATOR_KIND };
  const used = contextUsedOf(session);
  const title = i18n.t('compact.pick.title', { title: clip(session.title || session.id, 60), tokens: i18n.fmtTokens(used) });
  const items = [];
  const info = (icon, text, extra) => ({ label: `$(${icon}) ${text}`, action: { type: 'info', text }, ...extra });
  let active = null;

  if (session.provider === 'codex') {
    items.push(info('info', i18n.t('compact.info.rulesCodex')));
    items.push(sep);
    active = {
      label: '$(link-external) ' + i18n.t('compact.item.codexOpen'),
      detail: i18n.t('compact.item.codexOpen.detail'),
      action: { type: 'codexOpen' },
    };
    items.push(active);
    items.push(handoffItem(i18n));
    return { title, placeholder: i18n.t('compact.pick.placeholder.codex'), items, active };
  }

  // Claude：顶部两行说明（§11.8 第 3 条），用正常字号的说明项，不做成分隔线上的小字
  items.push(info('info', i18n.t('compact.info.rules')));
  items.push(info('discard', i18n.t('compact.info.rewind')));
  items.push(sep);
  const placeholder = i18n.t('compact.pick.costNote', { date: pricing.PRICES_UPDATED });

  if (ctx.live) {
    const est = estimateFor(session, session.model, now);
    const parts = [];
    if (ctx.liveStatus === S.LIVE_STATUS.BUSY) parts.push(i18n.t('compact.detail.busy'));
    parts.push(cacheText(est, session, i18n, now), usdText(est, i18n));
    active = {
      label: '$(screen-normal) ' + (session.model
        ? i18n.t('compact.item.inSession', { model: session.model })
        : i18n.t('compact.item.inSession.noModel')),
      detail: parts.join(' · '),
      action: { type: 'inSession' },
    };
    items.push(active);
    items.push({
      label: '$(edit) ' + i18n.t('compact.item.custom'),
      detail: i18n.t('compact.item.custom.detail'),
      action: { type: 'custom' },
    });
    items.push(handoffItem(i18n));
    // §11.4 第 4 条：缓存可能已过期、换 Sonnet 5 能省 ≥ 30% → 分隔线下加一条说明项
    const { candidates } = candidatesFor(session, now);
    const orig = candidates[0];
    const son = candidates.find((c) => c.role === 'target' && pricing.normalizeClaudeModel(c.id) === SONNET_TARGET);
    if (orig && orig.id && orig.cacheLikelyExpired && son && son.available && son.usd != null
      && son.savingVsOriginal != null && son.savingVsOriginal >= CHEAPER_MIN_SAVING) {
      const text = i18n.t('compact.item.cheaper.detail', { usd: i18n.fmtUsd(son.usd) });
      items.push(sep);
      items.push({ label: '$(lightbulb) ' + i18n.t('compact.item.cheaper'), detail: text, action: { type: 'info', text } });
    }
    return { title, placeholder, items, active };
  }

  // 未打开：后台压缩，可选模型。推荐项排第一，其余按候选顺序，不可用的放最后
  const { candidates } = candidatesFor(session, now);
  const usable = candidates.filter((c) => c.id && c.available);
  const ordered = [...usable.filter((c) => c.recommended), ...usable.filter((c) => !c.recommended)];
  for (const c of ordered) {
    const parts = [cacheText(c, session, i18n, now), usdText(c, i18n)];
    if (c.recommended && c.sameModel && c.pricing === 'hit') parts.push(i18n.t('compact.detail.warmBest'));
    if (c.savingVsOriginal != null && c.savingVsOriginal >= 0.05) parts.push(i18n.t('compact.detail.saving', { pct: i18n.fmtPct(c.savingVsOriginal) }));
    if (c.sameModel && c.pricing === 'hit') {
      // 【推断】-p 后台请求的系统提示和工具与会话里不同，可能用不上缓存（§11.7）
      const miss = estimateFor(session, c.id, now, { expired: true });
      if (miss.usd != null) parts.push(i18n.t('compact.detail.bgMayMiss', { usd: i18n.fmtUsd(miss.usd) }));
    }
    if (isHaiku(c.id)) parts.push(i18n.t('compact.detail.haiku'));
    const item = {
      label: '$(server-process) ' + i18n.t('compact.item.background', { model: c.id }),
      description: c.recommended ? i18n.t('compact.recommended') : undefined,
      detail: parts.join(' · '),
      action: { type: 'background', model: cliModelFor(c.id, session) },
    };
    if (!active) active = item;
    items.push(item);
  }
  for (const c of candidates) {
    if (!c.id || c.available) continue;
    const text = i18n.t('compact.detail.window', { model: c.id, window: i18n.fmtTokens(c.targetWindow) });
    items.push({ label: '$(circle-slash) ' + i18n.t('compact.item.unavailable', { model: c.id }), detail: text, action: { type: 'info', text } });
  }
  if (!candidates[0] || !candidates[0].id) {
    const text = i18n.t('compact.detail.noModel');
    items.push({ label: '$(question) ' + text, action: { type: 'info', text } });
  }
  items.push(handoffItem(i18n));
  return { title, placeholder, items, active };
}

function handoffItem(i18n) {
  return {
    label: '$(note) ' + i18n.t('compact.item.handoff'),
    detail: i18n.t('compact.item.handoff.detail'),
    action: { type: 'handoff' },
  };
}

// ---------------------------------------------------------------------------
// 把文字送进会话（§11.4 的预填方式与剪贴板退路；autocompact.js 预填 /autocompact 也用它）
// ---------------------------------------------------------------------------

/**
 * Claude（claude-vscode 入口）用 claude-vscode.editor.open 预填（不发送），同时复制到剪贴板；
 * 其它入口只复制；Codex：打开对话 + 复制。返回给用户看的提示文字。
 * @param {any} vscode
 * @param {any} session
 * @param {string} text
 * @param {{ i18n: any, liveNow?: boolean, log?: (line: string) => void }} o
 * @returns {Promise<string>}
 */
async function deliverText(vscode, session, text, o) {
  const i18n = o.i18n;
  const log = o.log || (() => {});
  try { await vscode.env.clipboard.writeText(text); } catch (err) { log(`clipboard: ${err && err.message}`); }
  if (session.provider === 'codex') {
    let opened = false;
    if (CODEX_ID_RE.test(String(session.id))) {
      try {
        const scheme = (vscode.env && vscode.env.uriScheme) || 'vscode';
        opened = !!(await vscode.env.openExternal(vscode.Uri.parse(`${scheme}://${CODEX_AUTHORITY}/local/${session.id}`)));
      } catch (err) {
        log(`openExternal failed: ${err && err.message}`);
      }
    }
    return i18n.t(opened ? 'compact.deliver.codexOpened' : 'compact.deliver.codexCopied');
  }
  const entrypoint = session.entrypoint || (session.entry === 'vscode' ? CLAUDE_VSCODE_ENTRY : null);
  if (entrypoint === CLAUDE_VSCODE_ENTRY && S.isUuid(session.id)) {
    try {
      await vscode.commands.executeCommand(CLAUDE_OPEN_CMD, session.id, text);
      return i18n.t('compact.deliver.opened');
    } catch (err) {
      log(`${CLAUDE_OPEN_CMD} failed: ${err && err.message}`);
      return i18n.t('compact.deliver.copied');
    }
  }
  if (entrypoint && entrypoint !== CLAUDE_VSCODE_ENTRY) {
    return o.liveNow
      ? i18n.t('compact.deliver.copiedOther', { where: entryLabel(session.entry, i18n) })
      : i18n.t('compact.deliver.copiedClosed');
  }
  return i18n.t('compact.deliver.copied');
}

// ---------------------------------------------------------------------------
// 后台压缩：校验、CLI 查找、子进程
// ---------------------------------------------------------------------------

/** spawn 的参数（§11.4），顺序固定 */
function buildSpawnArgs(sessionId, model, prompt) {
  return ['-p', '--resume', sessionId, '--model', model, '--output-format', 'json', prompt];
}

/**
 * 后台压缩前的参数校验。通过返回 null，否则返回词典键。
 * @param {{ sessionId: any, model: any, allowed: string[], cwd: any, statSync?: typeof fs.statSync }} o
 */
function validateBackground(o) {
  if (!S.isUuid(o.sessionId)) return 'compact.error.badId';
  if (typeof o.model !== 'string' || !MODEL_ID_RE.test(o.model) || !(o.allowed || []).includes(o.model)) return 'compact.error.badModel';
  if (typeof o.cwd !== 'string' || !o.cwd || !path.isAbsolute(o.cwd)) return 'compact.error.cwd';
  try {
    if (!(o.statSync || fs.statSync)(o.cwd).isDirectory()) return 'compact.error.cwd';
  } catch {
    return 'compact.error.cwd';
  }
  return null;
}

function isRunnable(p, platform, fsImpl = fs) {
  try {
    if (!fsImpl.statSync(p).isFile()) return false;
    if (platform === 'win32') return true; // Windows 没有执行位
    fsImpl.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(p, env) {
  if (p === '~') return (env && env.HOME) || os.homedir();
  if (/^~[/\\]/.test(p)) return path.join((env && env.HOME) || os.homedir(), p.slice(2));
  return p;
}

/**
 * 找 Claude Code 命令行（§11.4）：
 * 1. 设置 agentMonitor.claude.cliPath（设了但不可执行 → 报错，不悄悄换别的）；
 * 2. PATH 里的 claude（纯 JS 遍历，只看绝对路径的目录；Windows 找 claude.exe / claude.cmd）；
 * 3. Claude 扩展自带的 resources/native-binary/claude（Windows 为 claude.exe），文件存在才用；
 * 4. 都没有 → { error: 'notFound' }。
 * Windows 的 .cmd 不经过 shell 起不来，所以 PATH 里只有 .cmd 时排在扩展自带的 .exe 之后，spawn 前再拦下。
 * @param {{ cliPath?: string, env?: Record<string, string|undefined>, platform?: string, extensionPath?: string|null, fs?: any }} o
 * @returns {{ path: string, source: 'setting'|'path'|'extension' } | { error: 'cliPath'|'notFound', path?: string }}
 */
function findCli(o = {}) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const fsImpl = o.fs || fs;
  const win = platform === 'win32';
  const pathMod = path; // 拼路径用本机的 path（真在 Windows 上就是 path.win32）；platform 只决定分隔符和文件名
  const setting = typeof o.cliPath === 'string' ? o.cliPath.trim() : '';
  if (setting) {
    const p = expandHome(setting, env);
    if (pathMod.isAbsolute(p) && isRunnable(p, platform, fsImpl)) return { path: p, source: 'setting' };
    return { error: 'cliPath', path: setting };
  }
  const pathVar = env.PATH || env.Path || env.path || '';
  const dirs = String(pathVar).split(win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => d && pathMod.isAbsolute(d));
  let shim = null;
  for (const dir of dirs) {
    if (win) {
      const exe = pathMod.join(dir, 'claude.exe');
      if (isRunnable(exe, platform, fsImpl)) return { path: exe, source: 'path' };
      const cmd = pathMod.join(dir, 'claude.cmd');
      if (!shim && isRunnable(cmd, platform, fsImpl)) shim = cmd;
    } else {
      const p = pathMod.join(dir, 'claude');
      if (isRunnable(p, platform, fsImpl)) return { path: p, source: 'path' };
    }
  }
  if (o.extensionPath) {
    const p = pathMod.join(o.extensionPath, 'resources', 'native-binary', win ? 'claude.exe' : 'claude');
    if (isRunnable(p, platform, fsImpl)) return { path: p, source: 'extension' };
  }
  if (shim) return { path: shim, source: 'path' };
  return { error: 'notFound' };
}

/** Windows 批处理（.cmd / .bat）不经过 shell 起不来 */
function needsShell(cli) {
  return /\.(cmd|bat)$/i.test(String(cli || ''));
}

/** 从 stdout 取结果 JSON：整段能解析就用；否则从后往前找 type 为 result 的一行 */
function parseResultJson(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    if (Array.isArray(j)) return [...j].reverse().find((x) => x && x.type === 'result') || null;
  } catch { /* 多行输出，逐行找 */ }
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('{')) continue;
    try {
      const j = JSON.parse(l);
      if (j && typeof j === 'object' && (j.type === 'result' || 'is_error' in j)) return j;
    } catch { /* 跳过 */ }
  }
  return null;
}

/**
 * 运行后台压缩的子进程。不经过 shell、stdin 为 ignore；可取消、超时后结束子进程。
 * @param {{ cli: string, args: string[], cwd: string, timeoutMs?: number,
 *   token?: { isCancellationRequested?: boolean, onCancellationRequested?: Function },
 *   spawn?: typeof cp.spawn, env?: Record<string, string>, onChild?: (child: any) => void }} o
 * @returns {Promise<{ outcome: 'ok'|'failed'|'cancelled'|'timeout'|'spawnError', code: number|null, signal: string|null,
 *   json: any, stdout: string, stderr: string, error: string|null, durationMs: number, pid: number|null }>}
 */
function runCompact(o) {
  return new Promise((resolve) => {
    const started = Date.now();
    const base = { code: null, signal: null, json: null, stdout: '', stderr: '', error: null, pid: null };
    let child;
    try {
      child = (o.spawn || cp.spawn)(o.cli, o.args, {
        cwd: o.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        env: o.env || process.env,
      });
    } catch (err) {
      resolve({ ...base, outcome: 'spawnError', error: String((err && err.message) || err), durationMs: 0 });
      return;
    }
    if (o.onChild) o.onChild(child);
    const out = [];
    let outLen = 0;
    let err = '';
    let reason = null;
    let done = false;
    let killTimer = null;
    let sub = null;
    const kill = () => {
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
      if (!killTimer) {
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, KILL_GRACE_MS);
        if (killTimer.unref) killTimer.unref();
      }
    };
    const timer = setTimeout(() => { reason = reason || 'timeout'; kill(); }, o.timeoutMs || TIMEOUT_MS);
    if (o.token) {
      if (o.token.isCancellationRequested) { reason = 'cancelled'; kill(); }
      if (typeof o.token.onCancellationRequested === 'function') {
        sub = o.token.onCancellationRequested(() => { reason = reason || 'cancelled'; kill(); });
      }
    }
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killTimer && r.outcome !== 'spawnError') clearTimeout(killTimer);
      if (sub && typeof sub.dispose === 'function') sub.dispose();
      resolve({ ...base, pid: child.pid ?? null, durationMs: Date.now() - started, ...r });
    };
    if (child.stdout) {
      child.stdout.on('data', (b) => {
        if (outLen >= STDOUT_MAX) return;
        out.push(b);
        outLen += b.length;
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (b) => {
        err += b.toString('utf8');
        if (err.length > STDERR_KEEP * 2) err = err.slice(-STDERR_KEEP);
      });
    }
    child.on('error', (e) => {
      if (reason) return; // 结束子进程时的报错，以 close 为准
      finish({ outcome: 'spawnError', error: String((e && e.message) || e) });
    });
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = err.slice(-STDERR_KEEP);
      const json = parseResultJson(stdout);
      let outcome = reason;
      if (!outcome) outcome = code === 0 && !(json && json.is_error === true) ? 'ok' : 'failed';
      finish({ outcome, code, signal: signal || null, json, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// 结果：读会话记录里最后一条 compact_boundary
// ---------------------------------------------------------------------------

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/**
 * 从 fromOffset 起（文件变短就从头）找最后一条 system/compact_boundary。最多读末尾 8MB。
 * @returns {{ preTokens: number|null, postTokens: number|null, trigger: string|null, ms: number|null }|null}
 */
function readCompactBoundary(file, fromOffset = 0) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    let start = fromOffset > size ? 0 : Math.max(0, fromOffset);
    start = Math.max(start, size - BOUNDARY_SCAN_MAX);
    const len = size - start;
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('compact_boundary')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || e.type !== 'system' || e.subtype !== 'compact_boundary') continue;
      const md = e.compactMetadata && typeof e.compactMetadata === 'object' ? e.compactMetadata : {};
      const n = (v) => (fin(Number(v)) && v !== null && v !== '' ? Number(v) : null);
      return { preTokens: n(md.preTokens), postTokens: n(md.postTokens), trigger: md.trigger || null, ms: Date.parse(e.timestamp) || null };
    }
    return null;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
  }
}

/**
 * 会话记录文件：Session.main.file（文件名必须是 <sessionId>.jsonl）；没有就在 <claudeHome>/projects/*\/ 下找。
 */
function transcriptFile(session, claudeHome, sessionId = session.id) {
  if (!S.isUuid(sessionId)) return null;
  const name = sessionId + '.jsonl';
  const f = session.main && session.main.file;
  if (typeof f === 'string' && path.isAbsolute(f)) {
    if (path.basename(f) === name) return f;
    const sib = path.join(path.dirname(f), name);
    if (fs.existsSync(sib)) return sib;
  }
  if (!claudeHome) return null;
  const projects = path.join(claudeHome, 'projects');
  const dirs = [];
  if (session.projectDir && /^[^/\\]+$/.test(session.projectDir)) dirs.push(session.projectDir);
  try {
    for (const d of fs.readdirSync(projects)) if (!dirs.includes(d)) dirs.push(d);
  } catch { /* 目录不存在 */ }
  for (const d of dirs) {
    const p = path.join(projects, d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 提醒判定（§11.7、§11.8 第 5、6 条）
// ---------------------------------------------------------------------------

/**
 * 现在压缩（缓存还在）与过期后再压缩的估价。任一没有价格返回 null。
 * @returns {{ warm: number, cold: number }|null}
 */
function warmCold(session, now) {
  const warm = estimateFor(session, session.model, now);
  const cold = estimateFor(session, session.model, now, { expired: true });
  if (warm.usd == null || cold.usd == null || warm.pricing !== 'hit') return null;
  return { warm: warm.usd, cold: cold.usd };
}

/**
 * “缓存快过期”提醒是否该弹（§11.7 条件 1–7，§11.8 第 5 条：默认只对 1 小时 TTL）。
 * @param {any} s Session
 * @param {number} now
 * @param {{ enabled?: boolean, minutes?: number, minContext?: number, shortTtl?: boolean,
 *   reminded?: Set<string>, muted?: (sessionId: string) => boolean }} o
 * @returns {{ key: string, minutes: number, warm: number, cold: number, tokens: number }|null}
 */
function cacheReminderDue(s, now, o = {}) {
  if (o.enabled === false || !s || s.provider !== 'claude' || !s.live) return null;
  if (s.liveStatus === S.LIVE_STATUS.BUSY || s.liveStatus === S.LIVE_STATUS.WAITING) return null;
  if (ttlOf(s) !== '1h' && !o.shortTtl) return null;
  const tokens = contextUsedOf(s);
  if (tokens < (o.minContext ?? DEFAULTS.cacheReminderMinContext)) return null;
  const exp = s.cacheExpiresMs;
  if (!fin(exp) || exp <= now) return null;
  const left = exp - now;
  if (left > (o.minutes ?? DEFAULTS.cacheReminderMinutes) * 60e3) return null;
  const key = `${s.id}:${exp}`;
  if ((o.reminded && o.reminded.has(key)) || (o.muted && o.muted(s.id))) return null;
  const wc = warmCold(s, now);
  if (!wc || wc.cold - wc.warm < REMIND_MIN_GAIN_USD) return null;
  return { key, minutes: Math.max(1, Math.ceil(left / 60e3)), warm: wc.warm, cold: wc.cold, tokens };
}

/**
 * “关窗口”提醒是否该弹（§11.7）：会话刚从登记表消失（调用方判断），缓存还在，现在压缩能省 ≥ $0.50。
 * @returns {{ minutes: number, warm: number, cold: number, tokens: number, reopen: boolean }|null}
 */
function closeReminderDue(s, now, o = {}) {
  if (o.enabled === false || !s || s.provider !== 'claude' || s.live) return null;
  const tokens = contextUsedOf(s);
  if (tokens < (o.minContext ?? DEFAULTS.cacheReminderMinContext)) return null;
  const exp = s.cacheExpiresMs;
  if (!fin(exp) || exp <= now) return null;
  if (o.muted && o.muted(s.id)) return null;
  const wc = warmCold(s, now);
  if (!wc || wc.cold - wc.warm < REMIND_MIN_GAIN_USD) return null;
  return {
    minutes: Math.max(1, Math.ceil((exp - now) / 60e3)),
    warm: wc.warm,
    cold: wc.cold,
    tokens,
    reopen: s.entrypoint === CLAUDE_VSCODE_ENTRY && S.isUuid(s.id),
  };
}

/** 压缩次数标记：有 compactCount 用它，否则用主智能体最近一次压缩的时间 */
function compactMarker(s) {
  if (fin(s.compactCount)) return s.compactCount;
  const lc = s.main && s.main.lastCompact;
  return lc && fin(lc.ms) ? lc.ms : null;
}

// ---------------------------------------------------------------------------
// VS Code 接线
// ---------------------------------------------------------------------------

/**
 * 注册命令 agentMonitor.compact，返回 Disposable（另带 onSnapshot、compact、runHandoff 三个方法）。
 * @param {any} context ExtensionContext（用 globalState / workspaceState）
 * @param {{ getSession: (key: string) => any, i18n: any, claudeHome: string|(() => string), output?: any,
 *   listSessions?: () => any[], inWorkspace?: (s: any) => boolean, getSelectedKey?: () => string|null,
 *   spawn?: typeof cp.spawn, timeoutMs?: number, env?: Record<string, string|undefined>, platform?: string }} deps
 *   spawn / timeoutMs / env / platform 只供测试替换。
 */
function activateCompact(context, deps) {
  const vscode = require('vscode');
  const ctx = context || {};
  const I = () => (typeof deps.i18n === 'function' ? deps.i18n() : deps.i18n);
  const claudeHome = () => (typeof deps.claudeHome === 'function' ? deps.claudeHome() : deps.claudeHome)
    || path.join(os.homedir(), '.claude');
  const log = (line) => { try { if (deps.output) deps.output.appendLine(`[compact] ${line}`); } catch { /* 忽略 */ } };
  const cfg = (key, dflt) => {
    try {
      const v = vscode.workspace.getConfiguration('agentMonitor').get(key);
      return v === undefined || v === null ? dflt : v;
    } catch {
      return dflt;
    }
  };
  const running = new Map(); // sessionId → child
  const sepKind = vscode.QuickPickItemKind ? vscode.QuickPickItemKind.Separator : SEPARATOR_KIND;
  const memMute = new Map();
  let disposed = false;

  // ---------- 小件 ----------

  const info = (msg, ...items) => vscode.window.showInformationMessage(msg, ...items);
  const errorMsg = (msg, ...items) => vscode.window.showErrorMessage(msg, ...items);
  const titleOf = (s) => clip((s && (s.title || s.id)) || '', 60);

  function registry() {
    try {
      return claudeLive.readRegistry(claudeHome());
    } catch {
      return { ok: false, live: new Map(), minVersion: null };
    }
  }

  function isMuted(sessionId) {
    if (memMute.has(sessionId)) return true;
    try {
      const m = ctx.workspaceState && ctx.workspaceState.get(MUTE_KEY);
      return !!(m && typeof m === 'object' && m[sessionId]);
    } catch {
      return false;
    }
  }

  async function mute(sessionId) {
    memMute.set(sessionId, Date.now());
    try {
      if (!ctx.workspaceState) return;
      const m = { ...(ctx.workspaceState.get(MUTE_KEY) || {}) };
      m[sessionId] = Date.now();
      await ctx.workspaceState.update(MUTE_KEY, m);
    } catch { /* 只在内存里记 */ }
  }

  function template() {
    return resolveTemplate(cfg('compactTemplate', DEFAULTS.compactTemplate), I());
  }

  /**
   * 选会话（没有参数时，比如从命令面板）。压缩只列可压缩的会话；交接笔记列全部 Claude / Codex 会话。
   * 给了 deps.getSelectedKey 时，当前选中的会话排第一（默认高亮），其余顺序不变。
   * @param {{ minContext?: number, placeholder?: string, emptyKey?: string }} [o]
   */
  async function pickSessionKey(o = {}) {
    const i18n = I();
    const minContext = o.minContext ?? COMPACTABLE_MIN;
    const list = (deps.listSessions ? deps.listSessions() || [] : [])
      .filter((s) => s && (s.provider === 'claude' || s.provider === 'codex') && contextUsedOf(s) >= minContext);
    if (!list.length) {
      info(i18n.t(o.emptyKey || 'compact.noSessions'));
      return null;
    }
    let selected = null;
    try { selected = deps.getSelectedKey ? deps.getSelectedKey() : null; } catch { selected = null; }
    const at = selected ? list.findIndex((s) => s.key === selected) : -1;
    if (at > 0) list.unshift(...list.splice(at, 1));
    const items = list.map((s) => ({
      label: titleOf(s),
      description: `${i18n.t('provider.' + s.provider)} · ${i18n.fmtTokens(contextUsedOf(s))}`,
      key: s.key,
    }));
    const it = await vscode.window.showQuickPick(items, { placeHolder: i18n.t(o.placeholder || 'compact.pickSession') });
    return it ? it.key : null;
  }

  /** QuickPick：说明项只弹说明、不关闭；active 设成推荐项 */
  function pick(built) {
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick();
      qp.title = built.title;
      qp.placeholder = built.placeholder;
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;
      qp.items = built.items;
      if (built.active) qp.activeItems = [built.active];
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
        qp.dispose();
      };
      qp.onDidAccept(() => {
        const it = (qp.selectedItems && qp.selectedItems[0]) || (qp.activeItems && qp.activeItems[0]);
        if (!it || !it.action) return;
        if (it.action.type === 'info') {
          info(it.action.text);
          return;
        }
        finish(it);
      });
      qp.onDidHide(() => finish(undefined));
      qp.show();
    });
  }

  /** 把文字送进会话（预填 + 剪贴板退路，见 deliverText），返回提示文字 */
  function deliver(session, text, liveNow) {
    return deliverText(vscode, session, text, { i18n: I(), liveNow, log });
  }

  async function compactInSession(session, instructions, liveNow) {
    const msg = await deliver(session, compactPrompt(instructions), liveNow);
    info(msg);
  }

  // §11.8 第 4 条：写交接笔记 → 看一眼 → /clear → 发续接提示
  async function handoff(session, liveNow) {
    const i18n = I();
    const msg = await deliver(session, i18n.t('compact.handoff.prompt'), liveNow);
    const next = i18n.t(session.provider === 'codex' ? 'compact.handoff.next.codex' : 'compact.handoff.next');
    const copy = i18n.t('compact.handoff.copyContinue');
    const b = await info(`${msg} ${next}`, copy);
    if (b === copy) {
      try { await vscode.env.clipboard.writeText(i18n.t('compact.handoff.continue')); } catch { /* 忽略 */ }
    }
  }

  async function askInstructions(title) {
    const i18n = I();
    const v = await vscode.window.showInputBox({
      title,
      prompt: i18n.t('compact.input.prompt'),
      placeHolder: i18n.t('compact.input.placeholder'),
      value: template(),
      ignoreFocusOut: true,
      validateInput: (s) => (String(s || '').length > TEXT_MAX ? i18n.t('compact.input.tooLong', { n: TEXT_MAX }) : null),
    });
    return v === undefined ? undefined : normalizeInstructions(v);
  }

  // ---------- 后台压缩 ----------

  async function background(key, model) {
    const i18n = I();
    let session = deps.getSession(key);
    if (!session) { errorMsg(i18n.t('compact.error.noSession')); return; }
    const title = titleOf(session);
    const early = validateBackground({ sessionId: session.id, model, allowed: allowedModels(session), cwd: session.cwd });
    if (early) { errorMsg(i18n.t(early)); return; }
    if (running.has(session.id)) { info(i18n.t('compact.already', { title })); return; }

    const instructions = await askInstructions(i18n.t('compact.input.title', { model }));
    if (instructions === undefined) return;

    // 确认框（compactConfirm 默认开；登记表核实不了“没打开”时一律确认）
    const reg = registry();
    const verified = reg.ok && !(session.version && reg.minVersion && claudeLive.cmpVersion(session.version, reg.minVersion) < 0);
    const est = estimateFor(session, model.replace(/\[1m\]$/i, ''), Date.now());
    if (cfg('compactConfirm', DEFAULTS.compactConfirm) !== false || !verified) {
      const go = i18n.t('compact.confirm.go');
      const detail = [
        i18n.t('compact.confirm.detail', { title, model, usd: est.usd == null ? i18n.t('compact.confirm.unpriced') : i18n.fmtUsd(est.usd) }),
        verified ? '' : i18n.t('compact.confirm.unverified'),
        i18n.t('compact.confirm.newTask'),
      ].filter(Boolean).join('\n\n');
      const b = await info(i18n.t('compact.confirm.message'), { modal: true, detail }, go);
      if (b !== go) return;
    }

    // 执行前再查：会话可能刚被打开；快照也可能已经变了
    session = deps.getSession(key) || session;
    let liveMap;
    try { liveMap = claudeLive.readLiveSessions(claudeHome()); } catch { liveMap = new Map(); }
    if (liveMap.has(session.id)) {
      log(`${key}: session is open now, background compaction aborted`);
      const act = i18n.t('compact.nowOpen.action');
      const b = await info(i18n.t('compact.nowOpen', { title }), act);
      if (b === act) {
        const fresh = { ...session, entrypoint: liveMap.get(session.id).entrypoint || session.entrypoint };
        await compactInSession(fresh, instructions, true);
      }
      return;
    }
    const bad = validateBackground({ sessionId: session.id, model, allowed: allowedModels(session), cwd: session.cwd });
    if (bad) { errorMsg(i18n.t(bad)); return; }
    if (running.has(session.id)) { info(i18n.t('compact.already', { title })); return; }

    const found = findCli({
      cliPath: cfg('claude.cliPath', ''),
      env: deps.env || process.env,
      platform: deps.platform || process.platform,
      extensionPath: extensionPath(),
    });
    if (found.error) {
      const open = i18n.t('compact.openSettings');
      const b = await errorMsg(found.error === 'cliPath'
        ? i18n.t('compact.error.cliPath', { path: found.path })
        : i18n.t('compact.error.noCli'), open);
      if (b === open) vscode.commands.executeCommand('workbench.action.openSettings', 'agentMonitor.claude.cliPath');
      return;
    }
    if (needsShell(found.path)) { errorMsg(i18n.t('compact.error.cmdShim', { path: found.path })); return; }

    const file = transcriptFile(session, claudeHome());
    const sizeBefore = file ? fileSize(file) : 0;
    const args = buildSpawnArgs(session.id, model, compactPrompt(instructions));
    log(`${key}: start model=${model} cli=${found.source}`);
    running.set(session.id, null);
    let r;
    try {
      r = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: i18n.t('compact.progress', { title }),
        cancellable: true,
      }, (progress, token) => {
        progress.report({ message: i18n.t('compact.progress.detail', { model }) });
        return runCompact({
          cli: found.path,
          args,
          cwd: session.cwd,
          timeoutMs: deps.timeoutMs || TIMEOUT_MS,
          token,
          spawn: deps.spawn,
          env: deps.env,
          onChild: (child) => running.set(session.id, child),
        });
      });
    } finally {
      running.delete(session.id);
    }
    const lines = tailLines(r.stderr);
    log(`${key}: ${r.outcome} code=${r.code} signal=${r.signal || '-'} ${(r.durationMs / 1000).toFixed(1)}s`);
    for (const l of lines) log(`  stderr: ${l}`);
    if (disposed) return;
    if (r.outcome === 'cancelled') { info(i18n.t('compact.cancelled', { title })); return; }
    if (r.outcome === 'timeout') {
      errorMsg(i18n.t('compact.timeout', { title, min: Math.round((deps.timeoutMs || TIMEOUT_MS) / 60e3) }));
      return;
    }
    if (r.outcome === 'spawnError') { errorMsg(i18n.t('compact.error.spawn', { message: r.error || '' })); return; }
    if (r.outcome === 'failed') {
      const detail = [
        r.code != null ? i18n.t('compact.failed.exit', { code: r.code }) : '',
        r.json && r.json.is_error && r.json.result ? clip(String(r.json.result).split('\n')[0], 200) : '',
        ...(lines.length ? lines : [i18n.t('compact.failed.noStderr')]),
      ].filter(Boolean).join('\n');
      errorMsg(i18n.t('compact.failed', { title }), { modal: true, detail });
      return;
    }
    // 成功：pre → post 取记录里最后一条 compact_boundary；花费取 CLI 自己算的 total_cost_usd
    const usd = r.json && fin(r.json.total_cost_usd) ? i18n.fmtUsd(r.json.total_cost_usd) : '—';
    const sid = r.json && S.isUuid(r.json.session_id) ? r.json.session_id : session.id;
    let boundary = null;
    if (sid === session.id) {
      if (file) boundary = readCompactBoundary(file, sizeBefore);
    } else {
      const other = transcriptFile(session, claudeHome(), sid);
      if (other) boundary = readCompactBoundary(other, 0);
    }
    if (boundary && boundary.preTokens != null && boundary.postTokens != null) {
      info(i18n.t('compact.done', {
        title, pre: i18n.fmtTokens(boundary.preTokens), post: i18n.fmtTokens(boundary.postTokens), usd, model,
      }));
    } else {
      info(i18n.t('compact.done.noRecord', { title, usd, model }));
    }
  }

  function extensionPath() {
    try {
      const ext = vscode.extensions && vscode.extensions.getExtension(CLAUDE_EXT_ID);
      return (ext && ext.extensionPath) || null;
    } catch {
      return null;
    }
  }

  // ---------- 命令 ----------

  /**
   * 会话打开没打开以登记表为准（快照可能是 2 秒前的）；登记表不可用时退回快照。Codex 直接用快照。
   * @returns {{ view: any, liveNow: boolean, liveStatus: string|null }}
   */
  function resolveLive(session) {
    let liveNow = !!session.live;
    let liveStatus = session.liveStatus || null;
    let view = session;
    if (session.provider === 'claude') {
      const reg = registry();
      const entry = reg.live.get(session.id);
      if (entry) {
        liveNow = true;
        liveStatus = entry.status || liveStatus;
        view = { ...session, entrypoint: entry.entrypoint || session.entrypoint };
      } else if (reg.ok) {
        liveNow = false;
      }
    }
    return { view, liveNow, liveStatus };
  }

  async function compact(arg) {
    const i18n = I();
    let key = keyFromArg(arg);
    if (!key) key = await pickSessionKey();
    if (!key) return;
    const parsed = S.parseSessionKey(key);
    const session = deps.getSession(key);
    if (!parsed || !session || (session.provider !== 'claude' && session.provider !== 'codex')) {
      errorMsg(i18n.t('compact.error.noSession'));
      return;
    }
    if (session.provider === 'claude' && !S.isUuid(session.id)) { errorMsg(i18n.t('compact.error.badId')); return; }
    const { view, liveNow, liveStatus } = resolveLive(session);
    const built = buildPickItems(view, { i18n, now: Date.now(), live: liveNow, liveStatus, separatorKind: sepKind });
    const it = await pick(built);
    if (!it) return;
    const a = it.action;
    if (a.type === 'inSession') return compactInSession(view, template(), true);
    if (a.type === 'custom') {
      const text = await askInstructions(i18n.t('compact.input.titleInSession'));
      if (text === undefined) return;
      return compactInSession(view, text, true);
    }
    if (a.type === 'codexOpen') return compactInSession(view, '', liveNow);
    if (a.type === 'handoff') return handoff(view, liveNow);   // 与命令 agentMonitor.handoff（handoffCommand）同一个函数
    if (a.type === 'background') return background(key, a.model);
  }

  /**
   * §11.8 第 4 条“写交接笔记后开新会话”，供 extension.js 注册 agentMonitor.handoff（§11.12.4）。
   * 参数：会话树节点或 sessionKey；没有参数时先选会话（默认当前选中的会话）。
   */
  async function handoffCommand(arg) {
    const i18n = I();
    let key = keyFromArg(arg);
    if (!key) key = await pickSessionKey({ minContext: 0, placeholder: 'compact.handoff.pickSession', emptyKey: 'compact.handoff.noSessions' });
    if (!key) return;
    const session = deps.getSession(key);
    if (!session || (session.provider !== 'claude' && session.provider !== 'codex')) {
      errorMsg(i18n.t('compact.error.noSession'));
      return;
    }
    const { view, liveNow } = resolveLive(session);
    return handoff(view, liveNow);
  }

  // ---------- 提醒（§11.7、§11.8 第 5–7 条） ----------

  let prevLive = null;              // 上一份快照里存活的 Claude 会话 key
  const closing = new Map();        // 从存活变成不存活的会话 key → 连续几份快照不存活
  const reminded = new Set();       // 已提醒过的缓存窗口：sessionId:cacheExpiresMs
  const compactSeen = new Map();    // 会话 key → 压缩次数标记

  function inWs(s) {
    try {
      if (deps.inWorkspace) return !!deps.inWorkspace(s);
      return scopeLib.inWorkspace(s, scopeLib.workspaceInfo(vscode.workspace.workspaceFolders));
    } catch {
      return false;
    }
  }

  async function remindCache(s, due) {
    const i18n = I();
    const bCompact = i18n.t('compact.remind.cache.compact');
    const bHandoff = i18n.t('compact.remind.handoff');
    const bMute = i18n.t('compact.remind.mute');
    const b = await info(i18n.t('compact.remind.cache', {
      title: titleOf(s), m: due.minutes, tokens: i18n.fmtTokens(due.tokens), warm: i18n.fmtUsd(due.warm), cold: i18n.fmtUsd(due.cold),
    }), bCompact, bHandoff, bMute);
    if (b === bCompact) {
      if (s.live) await compactInSession(s, template(), true);
      else await vscode.commands.executeCommand(CMD, s.key);
    } else if (b === bHandoff) {
      await handoff(s, !!s.live);
    } else if (b === bMute) {
      await mute(s.id);
    }
  }

  async function remindClose(s, due) {
    const i18n = I();
    const msg = i18n.t('compact.remind.close', {
      title: titleOf(s), tokens: i18n.fmtTokens(due.tokens), m: due.minutes, warm: i18n.fmtUsd(due.warm),
    });
    const bMute = i18n.t('compact.remind.mute');
    if (!due.reopen) {
      // 其它入口（终端、桌面版）只提示，不给“重新打开”按钮
      if ((await info(msg, bMute)) === bMute) await mute(s.id);
      return;
    }
    const bCompact = i18n.t('compact.remind.close.compact');
    const bHandoff = i18n.t('compact.remind.close.handoff');
    const b = await info(msg, bCompact, bHandoff, bMute);
    if (b === bCompact) await compactInSession(s, template(), false);
    else if (b === bHandoff) await handoff(s, false);
    else if (b === bMute) await mute(s.id);
  }

  async function hintPostCompact(s) {
    const i18n = I();
    const off = i18n.t('compact.postCompact.off');
    const key = s.provider === 'codex' ? 'compact.postCompact.codex' : 'compact.postCompact';
    const b = await info(i18n.t(key, { title: titleOf(s) }), off);
    if (b === off) {
      try { if (ctx.globalState) await ctx.globalState.update(HINT_OFF_KEY, true); } catch { /* 忽略 */ }
    }
  }

  /**
   * 每份快照调用一次（extension.js 在收到 worker 快照后调用）。
   * @param {{ now?: number, sessions?: any[], sources?: any }|any[]} snap
   */
  function onSnapshot(snap) {
    if (disposed) return;
    const sessions = Array.isArray(snap) ? snap : (snap && snap.sessions) || [];
    const now = (!Array.isArray(snap) && snap && fin(snap.now)) ? snap.now : Date.now();
    const catchErr = (p) => Promise.resolve(p).catch((err) => log(`reminder: ${err && err.message}`));

    // 压缩后提示检查约束（§11.8 第 7 条）
    const hintOn = cfg('postCompactHint', DEFAULTS.postCompactHint) !== false
      && !(ctx.globalState && ctx.globalState.get(HINT_OFF_KEY));
    for (const s of sessions) {
      if (!s || !s.key) continue;
      const marker = compactMarker(s);
      const had = compactSeen.has(s.key);
      const prev = compactSeen.get(s.key);
      compactSeen.set(s.key, marker);
      if (!had || marker == null || (prev != null && marker <= prev)) continue;
      if (hintOn && inWs(s)) catchErr(hintPostCompact(s));
    }

    // 关窗口提醒：会话从“存活”变成“不在登记表里”，连续 2 份快照都这样才算关掉（防登记表文件改写时读失败）。
    // 同一份快照里确认关掉多个，多半是整个窗口在退出，不提醒。
    // 不看登记表是否“可用”：关掉最后一个会话后登记表可能就空了，那正是要提醒的时候。
    const curLive = new Set();
    const byKey = new Map();
    for (const s of sessions) {
      if (!s || s.provider !== 'claude') continue;
      byKey.set(s.key, s);
      if (s.live) curLive.add(s.key);
    }
    if (prevLive) {
      for (const k of prevLive) if (!curLive.has(k) && byKey.has(k)) closing.set(k, 0);
    }
    const closed = [];
    for (const [k, n] of closing) {
      const s = byKey.get(k);
      if (!s || s.live) { closing.delete(k); continue; }
      if (n + 1 >= CLOSE_CONFIRM_SNAPSHOTS) { closed.push(s); closing.delete(k); } else closing.set(k, n + 1);
    }
    if (closed.length === 1 && cfg('closeReminder', DEFAULTS.closeReminder) !== false && inWs(closed[0])) {
      const due = closeReminderDue(closed[0], now, {
        minContext: Number(cfg('cacheReminderMinContext', DEFAULTS.cacheReminderMinContext)),
        muted: isMuted,
      });
      if (due) catchErr(remindClose(closed[0], due));
    }
    prevLive = curLive;

    // 缓存快过期提醒
    if (cfg('cacheReminder', DEFAULTS.cacheReminder) !== false) {
      const o = {
        minutes: Number(cfg('cacheReminderMinutes', DEFAULTS.cacheReminderMinutes)),
        minContext: Number(cfg('cacheReminderMinContext', DEFAULTS.cacheReminderMinContext)),
        shortTtl: cfg('cacheReminderShortTtl', DEFAULTS.cacheReminderShortTtl) === true,
        reminded,
        muted: isMuted,
      };
      for (const s of byKey.values()) {
        const due = cacheReminderDue(s, now, o);
        if (!due || !inWs(s)) continue;
        reminded.add(due.key);
        catchErr(remindCache(s, due));
      }
    }
  }

  const reg = vscode.commands.registerCommand(CMD, (arg) => compact(arg).catch((err) => {
    log(`error: ${err && err.message}`);
    errorMsg(I().t('compact.error.unexpected', { message: String((err && err.message) || err) }));
  }));

  const api = {
    onSnapshot,
    compact,
    /** agentMonitor.handoff 的实现（extension.js 注册命令时调用）；出错只提示，不抛 */
    runHandoff: (arg) => handoffCommand(arg).catch((err) => {
      log(`handoff error: ${err && err.message}`);
      errorMsg(I().t('compact.handoff.error', { message: String((err && err.message) || err) }));
    }),
    dispose() {
      disposed = true;
      if (activeApi === api) activeApi = null;
      try { reg.dispose(); } catch { /* 忽略 */ }
      for (const child of running.values()) {
        try { if (child) child.kill('SIGTERM'); } catch { /* 已退出 */ }
      }
      running.clear();
    },
  };
  activeApi = api;
  return api;
}

// 最近一次 activateCompact 的实例：模块级 runHandoff 转给它
let activeApi = null;

/**
 * 模块级入口：extension.js 可以直接 require('./lib/compact').runHandoff(arg) 注册 agentMonitor.handoff。
 * 参数：会话树节点或 sessionKey；没有参数时先选会话。activateCompact 之前调用会被拒绝。
 * @param {any} [arg]
 * @returns {Promise<void>}
 */
function runHandoff(arg) {
  if (!activeApi) return Promise.reject(new Error('compact module is not active'));
  return activeApi.runHandoff(arg);
}

module.exports = {
  CMD, CLAUDE_OPEN_CMD, CLAUDE_EXT_ID, TIMEOUT_MS, TAIL_LINES, MODEL_ID_RE, MUTE_KEY, HINT_OFF_KEY, DEFAULTS,
  activateCompact, runHandoff, deliverText,
  // 纯函数（测试与复用）
  keyFromArg, contextUsedOf, ttlOf, applyTtl, estimateFor, candidatesFor, pickRecommended, cliModelFor, allowedModels,
  resolveTemplate, normalizeInstructions, compactPrompt, tailLines,
  buildPickItems, buildSpawnArgs, validateBackground, findCli, needsShell, parseResultJson, runCompact,
  readCompactBoundary, transcriptFile,
  cacheReminderDue, closeReminderDue, compactMarker,
};
