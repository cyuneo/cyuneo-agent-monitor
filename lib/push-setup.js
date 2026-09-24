'use strict';
// Push notification setup: the agentMonitor.push.setup command (Command Palette and the bottom panel's … menu).
// One QuickPick, titled with the current state (on / off, channels in use), that comes back after each quick action:
// - Add a channel: pick one of the nine, the privacy notice (a modal, once per channel type), each field in an input box
//   (secrets masked; the ntfy topic is shown, since it has to be typed into the ntfy app too, and is prefilled with a
//   random one), checked with validateConfig, saved, then "Send a test message" (for ntfy also "Copy topic", to
//   subscribe to it). Cancelling before the save goes back to the menu.
// - Send a test message to every channel in use, or to any one from its own menu; the result or the described error is shown.
// - Per channel: test, edit (secret fields: leave empty to keep the saved value; an optional one is removed with "-"),
//   turn off / on, remove (with its secrets).
// - Turn push on / off; choose the events; open the remaining push settings (delay, chat titles).
// Settings hold only what splitConfig puts there; the secrets go to SecretStorage under secretKeyOf(key). All push
// settings are written to user settings and read from them only (deps.read uses inspect().globalValue). Writes change
// only the entry concerned and keep every other one as it is, including entries this version does not know (a newer
// version's channel synced from another computer).

const push = require('./push');
const rt = require('./push-runtime');

const ACK_KEY = 'agentMonitor.push.privacyAck'; // globalState: channel ids whose privacy notice was accepted
const VISIBLE_SECRETS = new Set(['ntfy.topic']); // secret, but the user must read it to subscribe
const CLEAR_SECRET = '-';                         // typed into an optional secret field when editing: remove the saved value
const SEPARATOR_KIND = -1;                        // vscode.QuickPickItemKind.Separator

/**
 * @param {{
 *   i18n: any,
 *   secrets: { get(k: string): Thenable<string|undefined>, store(k: string, v: string): Thenable<void>, delete(k: string): Thenable<void> }|null,
 *   globalState: any,
 *   read: () => { enabled: boolean, events: any, delaySeconds: any, includeTitle: boolean, channels: any[] },
 *   write: (key: string, value: any) => Thenable<void>,
 *   runtime: ReturnType<typeof rt.createPushRuntime>,
 *   openSettings: () => any,
 * }} deps
 */
async function runPushSetup(deps) {
  const vscode = require('vscode');
  const i18n = deps.i18n;
  const t = (k, v) => i18n.t(k, v);
  const win = vscode.window;
  const icon = (name, text) => `$(${name}) ${text}`;

  if (!deps.secrets) {
    win.showErrorMessage(t('ext.pushUnavailable'));
    return;
  }

  const state = () => {
    const raw = deps.read() || {};
    return { ...push.normalizeSettings(raw), channels: rt.channelEntries(raw.channels) };
  };
  /** The settings array as it is, for writes (entries this version does not know are kept) */
  const rawChannels = () => {
    const raw = deps.read() || {};
    return Array.isArray(raw.channels) ? [...raw.channels] : [];
  };
  /** A known channel entry with this key */
  const isEntry = (e, key) => rt.channelEntries([e]).length === 1 && push.channelKeyOf(e) === key;

  for (;;) {
    const s = state();
    const list = await deps.runtime.configs({ all: true });
    const inUse = list.filter((c) => c.config && c.enabled);
    const items = [];
    items.push({ label: icon('add', t('push.ui.addChannel')), action: 'add' });
    const onHint = inUse.length ? '' : t(list.length ? 'push.ui.noChannelInUse' : 'push.ui.noChannelsShort');
    items.push(s.enabled
      ? { label: icon('bell-slash', t('push.ui.turnOff')), action: 'off' }
      : { label: icon('bell', t('push.ui.turnOn')), description: onHint, action: 'on' });
    const nEvents = push.EVENT_TYPES.filter((e) => s.events[e]).length;
    items.push({
      label: icon('checklist', t('push.ui.chooseEvents')),
      description: t('push.ui.eventsSummary', { n: nEvents, total: push.EVENT_TYPES.length }),
      action: 'events',
    });
    if (inUse.length) items.push({ label: icon('send', t('push.ui.testAll')), action: 'testAll' });
    if (list.length) {
      items.push({ label: t('push.ui.channels'), kind: SEPARATOR_KIND });
      for (const c of list) items.push({ label: icon('broadcast', c.name), description: channelHint(c), action: 'channel', channel: c });
    }
    items.push({ label: '', kind: SEPARATOR_KIND });
    items.push({ label: icon('gear', t('push.ui.moreSettings')), action: 'settings' });

    const title = t('push.ui.menuTitle', { state: t(s.enabled ? 'push.ui.stateOn' : 'push.ui.stateOff'), n: inUse.length });
    const pick = await win.showQuickPick(items, { title, placeHolder: t('push.ui.menuPlaceholder') });
    if (!pick || !pick.action) return;
    switch (pick.action) {
      case 'add': if (await addChannel(s)) return; break; // cancelled: back to the menu
      case 'on':
        if (!list.length) { if (await addChannel(s, true)) return; break; }
        await deps.write('push.enabled', true);
        // Channels exist but none is in use here (turned off, or not set up on this computer): the menu lists them
        if (!inUse.length) win.showInformationMessage(t('push.ui.onNoChannel'));
        break;
      case 'off': await deps.write('push.enabled', false); break;
      case 'events': await chooseEvents(s); break;
      case 'testAll': await testAll(inUse); return; // a channel turned off is tested from its own menu only
      case 'channel': if (await channelMenu(pick.channel)) return; break;
      case 'settings': await deps.openSettings(); return;
      default: return;
    }
  }

  /** What tells channels apart in the list: the server or chat (not secret), and whether it is off or not set up here */
  function channelHint(c) {
    const parts = [];
    const cfg = c.config || c.entry;
    if (cfg.server) { try { parts.push(new URL(String(cfg.server)).host); } catch { /* not shown */ } }
    if (cfg.chatId) parts.push(String(cfg.chatId));
    if (!c.config) parts.push(t('push.ui.notHere'));
    else if (!c.enabled) parts.push(t('push.ui.channelIsOff'));
    return parts.join(' · ');
  }

  async function chooseEvents(s) {
    const items = push.EVENT_TYPES.map((e) => ({
      label: t(`push.event.${e}`),
      description: e !== 'needsYou' ? '' : s.delaySeconds > 0 ? t('push.ui.afterDelay', { seconds: s.delaySeconds }) : t('push.ui.noDelay'),
      picked: !!s.events[e],
      type: e,
    }));
    const picked = await win.showQuickPick(items, { title: t('push.ui.chooseEvents'), placeHolder: t('push.ui.pickEvents'), canPickMany: true });
    if (!picked) return;
    const chosen = new Set(picked.map((x) => x.type));
    const events = {};
    for (const e of push.EVENT_TYPES) events[e] = chosen.has(e);
    await deps.write('push.events', events);
  }

  /** @returns {Promise<boolean>} true when the flow ended (no return to the main menu) */
  async function channelMenu(c) {
    const items = [];
    if (c.config) items.push({ label: icon('send', t('push.ui.testChannel')), action: 'test' });
    items.push({ label: icon('edit', t(c.config ? 'push.ui.edit' : 'push.ui.setUpHere')), action: 'edit' });
    items.push(c.enabled
      ? { label: icon('debug-pause', t('push.ui.channelOff')), action: 'pause' }
      : { label: icon('debug-start', t('push.ui.channelOn')), action: 'resume' });
    items.push({ label: icon('trash', t('push.ui.remove')), action: 'remove' });
    const pick = await win.showQuickPick(items, { title: c.name, placeHolder: t('push.ui.channelPlaceholder') });
    if (!pick) return false;
    switch (pick.action) {
      case 'test': await testOne(c); return true;
      case 'edit': await editChannel(c); return true;
      case 'pause':
      case 'resume': await setChannelEnabled(c, pick.action === 'resume'); return false;
      case 'remove': return removeChannel(c);
      default: return false;
    }
  }

  /** @returns {Promise<boolean>} true when a channel was saved (the flow ends there); false when cancelled */
  async function addChannel(s, turnOn = false) {
    const pick = await win.showQuickPick(push.CHANNEL_IDS.map((id) => ({ label: t(push.CHANNELS[id].label), id })), {
      title: t('push.ui.addChannel'), placeHolder: t('push.ui.pickChannel'),
    });
    if (!pick) return false;
    const ch = push.CHANNELS[pick.id];
    const label = t(ch.label);
    let enable = turnOn && !s.enabled;
    const acked = ackedIds();
    if (!acked.includes(ch.id)) {
      const go = t(s.enabled ? 'push.ui.continue' : 'push.ui.turnOn');
      const b = await win.showInformationMessage(t('push.ui.privacy', { channel: label }), { modal: true }, go);
      if (b !== go) return false;
      if (!s.enabled) enable = true;
    }
    const values = await askFields(ch, null);
    if (!values) return false;
    const key = rt.newChannelKey(ch.id, rawChannels());
    const config = { channel: ch.id, key, ...values };
    if (!(await save(config, null))) return true; // the error is shown
    if (!acked.includes(ch.id)) await deps.globalState.update(ACK_KEY, [...ackedIds().filter((x) => x !== ch.id), ch.id]);
    if (enable) await deps.write('push.enabled', true);
    await afterSave(key);
    return true;
  }

  async function editChannel(c) {
    const ch = push.channelOf(c.entry);
    if (!ch) return;
    // Prefill from the config that is used (bound fields from SecretStorage); without secrets here, from settings
    const current = c.config || { ...c.entry };
    const values = await askFields(ch, current, !!c.config);
    if (!values) return;
    const config = { ...values, channel: ch.id, key: c.key };
    if (c.entry.enabled === false) config.enabled = false;
    if (!(await save(config, c.key))) return;
    await afterSave(c.key);
  }

  /**
   * One input box per field. Secret fields are never prefilled; when editing, empty keeps the saved value, and "-" removes
   * the saved value of an optional one (an ntfy token, a signing secret).
   * @returns {Promise<object|undefined>} field values (numbers for number fields; empty optional fields left out)
   */
  async function askFields(ch, current, keepSecrets = false) {
    const label = t(ch.label);
    const out = {};
    for (const f of ch.fields) {
      const cur = current ? current[f.key] : undefined;
      const keep = keepSecrets && f.secret && cur != null && cur !== '';
      const clearable = keep && !f.required;
      const visible = VISIBLE_SECRETS.has(`${ch.id}.${f.key}`);
      let value = '';
      if (!f.secret && cur != null && cur !== '') value = String(cur);
      else if (!f.secret && f.default !== '' && f.default != null) value = String(f.default);
      else if (!current && visible) value = push.randomTopic(); // ntfy: a random, hard-to-guess topic
      if (keep && visible) value = String(cur);
      // The fields entered so far: the ntfy token comes before the topic, which may then be shorter
      const before = { ...out };
      const hint = clearable ? t('push.ui.keepOrClearSecret', { clear: CLEAR_SECRET }) : keep && !visible ? t('push.ui.keepSecret') : null;
      const v = await win.showInputBox({
        title: t('push.ui.enterField', { channel: label, field: t(f.label) }),
        prompt: f.help ? t(f.help) : undefined,
        placeHolder: hint || (f.placeholder ? t(f.placeholder) : undefined),
        value,
        password: f.secret && !visible,
        ignoreFocusOut: true,
        validateInput: (x) => fieldError(ch, f, x, before, keep),
      });
      if (v === undefined) return undefined;
      const s = String(v).trim();
      if (clearable && s === CLEAR_SECRET) continue; // removed: left out of the saved config
      if (s === '') {
        if (keep) out[f.key] = cur;
        else if (f.type === 'number') out[f.key] = f.default;
        continue;
      }
      out[f.key] = f.type === 'number' ? Number(s) : s;
    }
    return out;
  }

  /** The error for one field, in the context of the fields entered before it; null when fine */
  function fieldError(ch, f, raw, sofar, keep) {
    const s = String(raw == null ? '' : raw).trim();
    if (s === '') return keep || !f.required ? null : t('push.err.required');
    if (s === CLEAR_SECRET && keep && !f.required) return null;
    const r = push.validateConfig({ ...sofar, channel: ch.id, [f.key]: s });
    const e = r.errors.find((x) => x.key === f.key);
    return e ? push.describeError({ code: 'config', field: e.key, problem: e.code, vars: e.vars }, i18n, { channel: ch.id }) : null;
  }

  /**
   * Checks the whole config, then stores the secrets and the settings half (replacing the entry with replaceKey). When the
   * settings can't be written (e.g. settings.json has a syntax error), the secrets are put back as they were and the
   * error is thrown on to the command, which shows it.
   */
  async function save(config, replaceKey) {
    const v = push.validateConfig(config);
    if (!v.ok) {
      const e = v.errors[0];
      win.showErrorMessage(push.describeError({ code: 'config', field: e.key, problem: e.code, vars: e.vars }, i18n, { channel: config.channel }));
      return false;
    }
    const { settings, secrets } = push.splitConfig(config);
    const secretKey = rt.secretKeyOf(config.key);
    let before;
    try { before = await deps.secrets.get(secretKey); } catch { before = undefined; }
    // Secrets first: an entry in settings without its secrets is simply not used yet
    await deps.secrets.store(secretKey, JSON.stringify(secrets));
    const entries = rawChannels();
    const i = replaceKey == null ? -1 : entries.findIndex((e) => isEntry(e, replaceKey));
    if (i >= 0) entries[i] = settings;
    else entries.push(settings);
    try {
      await deps.write('push.channels', entries);
    } catch (err) {
      try {
        if (typeof before === 'string') await deps.secrets.store(secretKey, before);
        else await deps.secrets.delete(secretKey);
      } catch { /* the error below is what the user needs to see */ }
      throw err;
    }
    return true;
  }

  // ntfy delivers only to apps subscribed to the topic, and accepts a message to any topic: say so, and offer to copy it
  async function afterSave(key) {
    const c = (await deps.runtime.configs({ all: true })).find((x) => x.key === key);
    const name = c ? c.name : key;
    const topic = c && c.config && c.config.channel === 'ntfy' ? String(c.config.topic || '') : '';
    const test = t('push.ui.testChannel');
    const on = t('push.ui.turnOn');
    const copy = t('push.ui.copyTopic');
    const buttons = [...(topic ? [copy] : []), test, ...(state().enabled ? [] : [on])];
    for (;;) {
      const b = await win.showInformationMessage(t(topic ? 'push.ui.savedNtfy' : 'push.ui.saved', { channel: name }), ...buttons);
      if (b === copy) {
        await vscode.env.clipboard.writeText(topic);
        buttons.splice(buttons.indexOf(copy), 1); // shown again, so the test can follow the subscription
        continue;
      }
      if (b === on) await deps.write('push.enabled', true);
      else if (b === test && c) await testOne(c);
      return;
    }
  }

  function isNtfy(c) {
    return !!(c && c.config && c.config.channel === 'ntfy');
  }

  async function testOne(c) {
    const r = await win.withProgress({ location: vscode.ProgressLocation.Notification, title: t('push.ui.testing', { channel: c.name }) },
      () => deps.runtime.test(c.key));
    if (r && r.ok) win.showInformationMessage(t(isNtfy(c) ? 'push.ui.testOkNtfy' : 'push.ui.testOk', { channel: c.name }));
    else win.showErrorMessage(t('push.ui.testFailed', { error: push.describeError(r, i18n, { channel: c.config && c.config.channel }) }));
  }

  /** Channel names as a list in the UI language ("A, B and C", "A、B和C") */
  function listOf(names) {
    try {
      return new Intl.ListFormat(i18n.intlLocale || 'en', { style: 'long', type: 'conjunction' }).format(names);
    } catch {
      return names.join(', ');
    }
  }

  async function testAll(list) {
    if (!list.length) { win.showInformationMessage(t('push.ui.noChannels')); return; }
    const results = await win.withProgress({ location: vscode.ProgressLocation.Notification, title: t('push.ui.testingAll') },
      () => Promise.all(list.map(async (c) => ({ c, r: await deps.runtime.test(c.key) }))));
    const good = results.filter((x) => x.r && x.r.ok).map((x) => x.c);
    const ok = good.map((c) => c.name);
    if (ok.length) win.showInformationMessage(t(good.some(isNtfy) ? 'push.ui.testOkNtfy' : 'push.ui.testOk', { channel: listOf(ok) }));
    for (const { c, r } of results) {
      if (r && r.ok) continue;
      win.showErrorMessage(t('push.ui.testFailedChannel', { channel: c.name, error: push.describeError(r, i18n, { channel: c.config.channel }) }));
    }
  }

  async function setChannelEnabled(c, enabled) {
    const entries = rawChannels().map((e) => {
      if (!isEntry(e, c.key)) return e;
      const next = { ...e };
      if (enabled) delete next.enabled;
      else next.enabled = false;
      return next;
    });
    await deps.write('push.channels', entries);
  }

  /** @returns {Promise<boolean>} true when removed (the flow ends with a message) */
  async function removeChannel(c) {
    const yes = t('push.ui.remove');
    const b = await win.showWarningMessage(t('push.ui.removeConfirm', { channel: c.name }), { modal: true }, yes);
    if (b !== yes) return false;
    await deps.secrets.delete(rt.secretKeyOf(c.key));
    await deps.write('push.channels', rawChannels().filter((e) => !isEntry(e, c.key)));
    win.showInformationMessage(t('push.ui.removed', { channel: c.name }));
    return true;
  }

  function ackedIds() {
    const v = deps.globalState && deps.globalState.get(ACK_KEY);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  }
}

module.exports = { runPushSetup, ACK_KEY };
