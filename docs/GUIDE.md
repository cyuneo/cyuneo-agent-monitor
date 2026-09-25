# CYUNEO Agent Monitor: full guide

**English** · [简体中文](GUIDE.zh-CN.md) · [繁體中文](GUIDE.zh-TW.md) · [한국어](GUIDE.ko.md) · [日本語](GUIDE.ja.md)

[← Back to the README](../README.md)

## Features

### A panel that works like the Terminal

![The Agent Monitor tab in the bottom panel, with made-up sample data: the selected Claude Code chat's main agent, two subagents and a workflow's agents on the left, and the list of open and recent chats on the right](../images/split-view.png)

- **Agent Monitor** opens as a tab in the bottom panel, next to Terminal, and looks like it: one panel with no extra view headers. The agents of the selected chat fill most of it, and a narrow list of chats sits on one side, like the terminal's tab list.
- **The chat list.** Every open and recent chat, each with a status light. They are grouped into **Open** (Claude Code still has the chat open; Codex or GitHub Copilot Chat is in the middle of a turn; Qwen Code's process is still running; or, as a guess, Gemini CLI has written to it recently) and **Recent**. Rows are the same height as terminal tabs, and the selected chat is highlighted. To leave room for titles, a row shows only the status light and the title, plus a small mark when a large context is worth dealing with: **◔** consider compacting, **◕** handle soon. Hover over a row for its status, context and the rest.
- **The list sits where your terminal's tab list is** (right by default, following `terminal.integrated.tabs.location`); set `agentMonitor.sessionListPosition` to put it on the left or right yourself. Drag the divider to resize it, double-click the divider to reset it to 200 px, or drag it almost closed to shrink the list to a strip of status lights. When the panel is narrower than 500 px, the strip is used automatically. The width is remembered.
- **Hover over a chat** for a **Compact…** button (20K context or more) and a **…** button with the same actions as the right-click menu. You can also use the keyboard: arrow keys, Home and End move through the list, Enter or Space selects, typing jumps to a chat by its first letters, and Shift+F10 opens the actions.
- **The agents.** Click a chat to see what's running inside it: the main conversation on top, then subagents and background agents, with workflow agents grouped under their workflow.
- **The chat's header takes two lines**, so the agents stay in view even in a short panel. The first line is the title, with how full the context is ("41% context") next to **Go to** and **Compact…**. The second has the status, the context against the auto-compact point, hints, the cache countdown and this chat's cost. Everything else (the context bar, the auto-compact setting, today's total, notices, resume prompts and the Transcript line) is under **Details ▸**. Urgent problems, such as a usage limit, an API error or a compaction loop, get one extra line. The table's column headings stay at the top as you scroll, and when the panel is under 400 px tall the cost and time columns are hidden.
- When you switch to a Claude Code or Codex chat tab, that chat is selected in the list. This only happens when you switch tabs, never on a refresh, so your selection stays put.
- There is also an **Overview** tree in the side bar, a status bar light with counts, and a badge showing how many chats need a look.

### Status lights

The same six lights are used everywhere: in the chat list, the Agents table, the Overview, the status bar and the terminal version.

| Light | Meaning |
| --- | --- |
| Magenta | **Needs you**: waiting for your approval, an answer or a dialog |
| Red | **Error**: stopped by a usage limit or an API error |
| Blue | **Working** |
| Bright green | **Done (new)**: finished, and you haven't looked yet |
| Dark green | **Done**: finished and already seen |
| Grey | **Idle**: interrupted, stopped, or no recent activity |

Lights also differ in shape (filled or outline), so they don't rely on colour alone. Light themes and high-contrast themes get their own shades, and you can change every colour in `workbench.colorCustomizations`.

"Needs you" is exact for Claude Code versions that report their live state (see [What it reads](#what-it-reads)) and for GitHub Copilot Chat, though Copilot Chat can show it up to about a minute late. For older Claude Code versions, Codex, Gemini CLI and Qwen Code, the extension has to guess. When a quick tool (reading, writing or editing a file, search, a patch) has had no result for 60 seconds, the chat shows **May be waiting for your approval**. Long commands such as shell commands are never guessed. You can change or turn off the guess with `agentMonitor.approvalGuess`.

### Go to where a chat is running

Click **Go to** in the chat's header, or double-click a chat in the list or one of its agents, and Agent Monitor brings up the place where that chat is running. A single click still only selects the chat or shows an agent's details. **Go to Chat** is also in the chat's right-click and **…** menus, in the right-click menu of the Overview in the side bar (with an inline button on chat rows), and in the Command Palette.

| Where the chat runs | What happens |
| --- | --- |
| Claude Code extension | The chat opens in Claude Code, in a tab or the side bar as your `claudeCode.preferredLocation` setting says. The setting isn't changed |
| Codex extension | The conversation opens in an editor tab |
| GitHub Copilot Chat | The chat opens in an editor tab, in the window whose workspace it belongs to |
| Claude Code, Codex, Gemini CLI or Qwen Code in VS Code's integrated terminal | That terminal is shown |
| Another VS Code window | That window opens the chat or shows the terminal, and comes to the front. This needs `agentMonitor.shareScanAcrossWindows` on (the default). If the window can't come to the front, a message says which one to switch to |
| Terminal.app or iTerm2 (macOS) | The app comes to the front with the chat's tab selected (see below) |
| The Claude or Codex desktop app, or another terminal app (Warp, Ghostty, WezTerm, kitty, Alacritty, Windows Terminal and others) | Not supported yet; a message says so |

- **Terminal.app and iTerm2:** the first time, Agent Monitor asks whether to switch to the chat's tab in that app. After you choose **Continue**, macOS asks whether VS Code (or the editor you use) may control that app: choose **Allow**. Agent Monitor asks only once per app. If you didn't allow it, the next try shows a message with **Open Automation Settings**; allow it in System Settings > Privacy & Security > Automation, then try again. You can also change it there later.
- **Codex CLI and Gemini CLI:** Agent Monitor has no process ID for these chats, so it looks for a running `codex` or `gemini` process in the chat's folder (for Codex, the process that has the chat's record open, when that can be told). If several run in the same folder, the newest one is chosen, which may be a different chat. On Windows a process's folder can't be read, so the newest one is chosen.
- **When it can't go there,** a message says why: for example, the chat isn't running any more, it runs in a terminal outside VS Code, it was started by another tool or agent rather than in a terminal or chat panel, or no open VS Code window has the Copilot chat's workspace.
- **The Go to button** (and the Overview's inline button) appears only when going there is likely to work: for Claude Code and Qwen Code chats that are still open, and for Codex, Gemini CLI and Copilot Chat chats that are open or were active in the last 24 hours. Double-clicking and the menus always try.
- **Only when you ask.** Agent Monitor lists the running processes only when you use Go to: one `ps` call on macOS and Linux, one PowerShell call on Windows, plus, for Codex CLI and Gemini CLI, their working folders and, for Codex, which process has the chat's record open (`lsof` on macOS, `/proc` on Linux). It doesn't read your chats for this, and nothing is sent anywhere. Other VS Code windows are reached through the shared folder described in [What it reads](#what-it-reads).

### "Needs you" notifications

- When a chat or one of its agents starts waiting for you (an approval, an answer or a dialog, including the guessed **May be waiting for your approval**), Agent Monitor tells you. In a focused VS Code window it shows a message with a **Show** button, which selects the chat in the panel. If the window's scope hides that chat, it is added to this window's list until you select another chat or change the scope; the scope setting itself is not changed. There is no message for the chat you are already looking at (its tab is active, or the panel shows it).
- When no VS Code window has focus, you get a system notification instead (macOS and Linux). On Windows and in remote windows (SSH, WSL, containers), the message appears in the next VS Code window you switch to, if the chat is still waiting.
- Each wait is reported once, by one window, however many windows are open, and also across editors that have the extension installed (VS Code, VS Code Insiders, Cursor and so on). Chats that were already waiting when the window opened are not reported, nor are chats that only appear because you changed a setting (for example, turning Codex on). Chats outside the window's scope count too.
- Turn notifications off with `agentMonitor.notifyNeedsYou`. While no VS Code window has focus, the records are read every 5 seconds instead of every 2 (`agentMonitor.backgroundRefreshSeconds`). Before a system notification is sent, the records are read once more, so a prompt you have already answered is not reported. A notification can therefore take a few seconds to arrive.
- To also get a message on your phone when you don't answer, see [Push to your phone or team chat](#push-to-your-phone-or-team-chat). To hear a sound, see [Sounds](#sounds); to keep things quiet at night, see [Quiet hours](#quiet-hours).

### Push to your phone or team chat

Optional, and **off by default**. Once you turn it on, Agent Monitor can send a short message to your phone or a team chat when:

- **an agent needs you** and is still waiting after `agentMonitor.push.delaySeconds` (30 seconds by default). The desktop notification comes first; if you answer in time, nothing is pushed. If your computer sleeps during the wait, that wait isn't pushed when it wakes up.
- **an agent stops with an API error** (sent right away).
- **a Claude Code or Codex usage limit is reached**, and again **when it resets**.
- **a threshold alert** comes in: usage, today's cost or a chat's context passed a value you set (see [Threshold alerts](#threshold-alerts)). These are the events `usageHigh`, `costDaily` and `contextHigh`.

All of them are on by default (the cost and context alerts only come once you set their thresholds). Choose them with **Choose events…** in the setup menu, or with `agentMonitor.push.events`. During [quiet hours](#quiet-hours), nothing is pushed, except API errors and usage-limit hits if you let errors through.

**Network access:** push is the only feature that uses the network, so it also needs **Allow network access** (`agentMonitor.network.allow`, off by default). While that is off, nothing is sent at all, not even a test message, and the setup menu shows push as **Paused**. If you add a channel, turn push on or send a test message while it is off, a dialog says what would be sent and where; only its **Allow network access** button turns it on. Turn it off again with **Block Network Access** (the setup menu, the panel's **…** menu or the Command Palette): push stays on, and when you allow the network again, nothing that happened in between is sent. Allowing network access applies to this computer only: Settings Sync doesn't carry it to your other computers.

**What is sent:** the project folder name and the state, for example "Agent needs you · my-app"; for a usage limit, the product and the reset time; for a threshold alert, what passed the threshold: the usage window and its percentage, that today's cost passed your budget (without any amount), or the chat's context percentage. With `agentMonitor.push.includeTitle`, the chat title (and the subagent's name) is added, but only a real title: one you set, or one the agent or app wrote. A title made from your first prompt is never sent. The extension never adds prompts, code, file paths, token counts or costs; a title or subagent name is sent as it is written, so it may name a file.

**Setting it up:** run **Agent Monitor: Push Notifications…** from the Command Palette or the **…** menu of the panel title bar, and choose **Add a push channel**. Pick a service, read the privacy notice (shown once per service), fill in the fields and send a test message. Tokens, keys and webhook URLs go into VS Code's secure storage, never into `settings.json`. When you edit a channel, leave a secret field empty to keep its saved value, or enter `-` to remove an optional one (an ntfy access token, a Feishu or DingTalk signing secret). Secrets are not synced between computers. With Settings Sync, a channel added on another computer shows **Not set up on this computer** until you set it up there too, and removing a channel deletes its secrets only on the computer where you remove it (a copy left on another computer is never used again). Plain `http://` to your own ntfy or Bark server is allowed only for localhost and private network addresses. It isn't encrypted, and on another network (a café, a hotel) the same address can be someone else's device, so use it only with a server on a network you control. The same menu shows whether push is on, how many channels are in use and whether network access is allowed, and lets you send test messages, edit, turn off or remove a channel, turn push on or off, choose the events, and allow or block network access.

| Service | What you need |
| --- | --- |
| **ntfy** | The ntfy app, subscribed to the topic the setup suggests. The topic is random because on ntfy.sh anyone who knows it can read it. Your own server and an access token also work. |
| **Bark** (iPhone) | The device key from the Bark app: the part of the example URL right after the server address. |
| **ServerChan** (WeChat) | Your SendKey from sct.ftqq.com (`SCT…`, or `sctp…` for ServerChan³). The free plan allows 5 messages a day, so this channel's daily limit starts at 5. |
| **Feishu / Lark** | A custom bot in a group: copy its webhook URL. Add its secret if signature verification is on, and one of its keywords if it uses them. |
| **DingTalk** | A custom robot in a group: copy its webhook URL. Add its secret (it starts with `SEC`) if the security setting is signing, or one keyword if it is custom keywords. |
| **WeCom** | A group robot: copy its webhook URL. |
| **Telegram** | A bot from @BotFather: paste its token and your chat ID. Send the bot a message first, since a bot can't start a chat. |
| **Discord** | In the channel's settings, Integrations > Webhooks: create a webhook and copy its URL. |
| **Slack** | An incoming webhook for a channel: copy its URL. |

**Limits:** updates that arrive within a few seconds of each other go out as one message. Each channel gets at most one message every 10 seconds and 20 an hour, plus its own **Daily limit** if you set one (0 means none). A message over the hourly or daily limit is skipped, not sent later, and the Agent Monitor output says so. The limits count across all windows, and each event is sent by one window only. If a channel fails three times in a row, you get one warning with **Open push setup**; it isn't repeated until a message to that channel gets through again.

**Remote windows:** pushes are sent from the machine that runs the extension. In a remote window (SSH, WSL, containers), that is the remote machine, which must be able to reach the service. The channel secrets are used there too (VS Code hands them to the extension on that machine), so while push is on, open remote windows only on machines you trust, or turn push off first.

**Proxies:** pushes go out through VS Code, so the proxy you set in VS Code (`http.proxy`) applies wherever VS Code passes it on to extensions (`http.fetchAdditionalSupport`, on by default in recent versions). If pushes fail behind a proxy, check those settings.

### Sounds

Optional, and **off by default**. Turn on `agentMonitor.sound.enabled`, and Agent Monitor plays a short sound when:

- **an agent needs you** (`agentMonitor.sound.needsYou`);
- **an agent stops with an error**, such as an API error or a usage limit (`agentMonitor.sound.error`);
- **a chat finishes and you haven't looked at it yet**, so its light turns bright green, **Done (new)** (`agentMonitor.sound.done`);
- **a threshold alert** comes in (`agentMonitor.sound.alert`; see [Threshold alerts](#threshold-alerts)).

Each of these settings takes `default`, `off`, or one of Glass, Ping, Pop, Tink, Submarine, Funk, Hero and Basso. `default` gives each event its own sound: Glass when an agent needs you, Basso for errors, Hero when a chat is done and Funk for threshold alerts. The names are macOS system sounds, played with `afplay`. On Linux, a similar sound from the system's sound theme is played with `canberra-gtk-play` or `paplay`, if one of them is installed; on Windows, a similar sound from the Windows `Media` folder. The "needs you" sound plays together with the ["needs you" notification](#needs-you-notifications), so it also needs `agentMonitor.notifyNeedsYou` on. Neither the "needs you" sound nor the "done" sound plays for the chat you are looking at, and there is no "done" sound when a finish is only a guess, as it usually is for Gemini CLI. Each sound plays in one VS Code window only, and when several things happen at once, you hear one sound: at most one every 3 seconds, across all windows. No sound plays in remote windows (SSH, WSL, containers) or during [quiet hours](#quiet-hours).

### Quiet hours

Optional, and **off by default**. Turn on `agentMonitor.quietHours.enabled` to keep Agent Monitor quiet at set times. During quiet hours:

- no sounds play;
- there are no system notifications: the message waits for the next VS Code window you switch to instead;
- nothing is pushed to your phone or team chat, and nothing from quiet hours is sent later.

Messages in a focused VS Code window still appear, and the panel, the lights, the badges and the status bar keep updating as usual. While quiet hours are on, the status bar tooltip says so.

- `agentMonitor.quietHours.start` and `agentMonitor.quietHours.end` are local times in 24-hour `HH:MM` form, 22:00 and 08:00 by default. When the end is earlier than the start, quiet hours run past midnight. If both are the same, quiet hours never start.
- `agentMonitor.quietHours.days` limits them to certain days: `sun`, `mon`, `tue`, `wed`, `thu`, `fri`, `sat`. Empty (the default) means every day. What counts is the day quiet hours start: with `["fri"]`, Friday 22:00 to Saturday 08:00 is quiet.
- With `agentMonitor.quietHours.allowErrors`, API errors and usage-limit hits still play the error sound and are still pushed. Limit resets and threshold alerts stay quiet.

### Threshold alerts

Agent Monitor can also tell you when a number passes a value you set. The alert comes like a "needs you" notification (a message in the focused VS Code window, or a system notification when no VS Code window has focus), with the threshold alert sound if sounds are on, and as a push if push is on.

| Setting | Default | Alert when |
| --- | --- | --- |
| `agentMonitor.alerts.usagePercent` | `90` | Codex's 5-hour or weekly usage reaches this percentage. Codex only: Claude Code's local logs record when a limit is hit, but not a percentage |
| `agentMonitor.alerts.dailyCost` | `0` (off) | Today's estimated API-equivalent cost, Claude Code and Codex together, reaches this many US dollars |
| `agentMonitor.alerts.contextPercent` | `0` (off) | A chat's main conversation reaches this percentage of its auto-compact point (Claude Code and Codex; the other tools have no auto-compact point) |

- Each alert comes once: once per usage window until it resets, once a day for the cost, and once per chat until its next compaction. Set a value to 0 to turn that alert off.
- What is already over a threshold when the window opens, or when you change the setting, is not reported.
- Each alert is shown by one window only.
- Costs are estimates at list prices (see [Usage and cost](#usage-and-cost)), and "today" follows your computer's local time.
- With push on, they are pushed too (see [Push to your phone or team chat](#push-to-your-phone-or-team-chat)). A daily-cost push says only that today's cost passed your budget, without any amount.

### An order that doesn't jump

- Chats are sorted by when they started, newest first. Agents are sorted by when they started, oldest first.
- Nothing is ever reordered by activity, status or token count. When an agent finishes, it stays where it is and only its light changes.
- A chat moves only when it switches between **Open** and **Recent**. The Agents table updates rows in place, so scroll position and expanded rows are kept.

### Compact button, with a choice of model and a cost estimate

![Choosing how to compact a closed Claude Code session, with an estimate for each model](../images/compact.png)

Every Claude Code or Codex chat with at least 20K tokens of context gets a **Compact…** button, both on its row in the chat list (when you hover over it) and in the chat's header above its agents. Nothing runs until you choose.

- **The Claude Code chat is open:** the extension switches to that chat and puts `/compact` into its input box, followed by a template that says what the summary must keep (goal, decisions, open problems, file paths, your constraints). The text is also copied to the clipboard. Edit it if you like, then press Enter yourself.
- **The Claude Code chat is closed:** the extension can compact it in the background with your local Claude Code, and you pick the model:
  - the chat's own model;
  - Claude Sonnet 5;
  - Claude Haiku 4.5, only when the context fits its 200K window.

  Each option shows an estimated cost, and the cheapest one is marked **Recommended**. A confirmation dialog comes first (it can be turned off). Right before running, the extension checks again and stops if the chat has been reopened.
- **Estimates follow the prompt cache.**
  - While the cache is still warm, compacting with the same model is by far the cheapest.
  - Once it has expired, switching to a cheaper model costs about half.
  - For example, with 400K tokens of context on Claude Opus 5.5: about $0.40 while the cache is warm; after the 1-hour cache has expired, about $3.52 with the same model or about $1.76 with Sonnet 5.
- **Also in the menu:** **Write a handoff note**, for when you're switching to a new task. A new session works better than compacting for that.
- **Reminders** (each one can be turned off):
  - shortly before a large idle chat's prompt cache expires, or when you close a large chat, while compacting is still cheap;
  - after a compaction, to check that your key rules are still in place.
- **Codex chats:** the extension opens the conversation in Codex and copies `/compact` for you to paste.
- **Compaction count:** **Details** shows **Compacted N×** (automatic and manual). After two or more compactions, if the context is getting large again, it suggests writing a handoff note and starting a new session. When a chat compacted twice within 10 minutes, or is still in the "handle soon" zone right after compacting, it shows **May be stuck in a compaction loop** in the error colour. "Two" is a rule of thumb, not a measured limit.

### Set your own auto-compact threshold

Claude Code compacts on its own when the context reaches a threshold. That happens while you're working, so the cache is warm and the compaction itself is cheap. What you can choose is *when*. Click **Auto-compact: … ▾** under the chat's **Details**, or right-click a chat and choose **Set Auto-Compact Threshold…**.

- The list shows each preset converted to that chat's window (percentage and tokens), roughly where it will actually compact, how strong the evidence is, and an estimate such as "about $0.069 per call, 45% less than the default". **Custom…** accepts any value from 100K to 1M, and **View the reference guide** opens the notes behind these numbers.
- **All projects:** if the chat is open, the extension fills in `/autocompact <value>` in that chat; press Enter and Claude Code applies it right away and saves it in your user settings. If the chat is closed, the extension writes `autoCompactWindow` in `~/.claude/settings.json`.
- **Only this project:** the extension writes `autoCompactWindow` in `<project>/.claude/settings.local.json`, which takes priority over your user settings. New sessions use it; an open session may need to be reopened.
- When the extension writes a settings file, it changes only that one key, keeps your formatting, saves a backup first, and doesn't write at all if the file can't be parsed. Choosing **Keep the default** removes the key.
- **Codex:** the extension doesn't edit `config.toml`. It copies a line such as `model_auto_compact_token_limit = 217600`, opens `~/.codex/config.toml`, and asks you to paste it at the top, before any `[table]`.

No vendor or paper gives a standard answer like "X% for research, Y% for coding". These presets are a compromise between vendor defaults, vendor benchmark setups, practitioners' data and a cost model, and the evidence column says how solid each one is.

| Preset | 1M-window models: setting → compacts at about | 200K-window models | Codex | Per call (Opus 5.5, 1M) / vs. default | Evidence |
| --- | --- | --- | --- | --- | --- |
| **Keep the default** (for people who'd rather not tune it) | not set → ~967K | not set → ~167K | 90% (~245K) | $0.126 / 100% | Strong: vendor default, officially recommended |
| **Coding (balanced)** | 400K (40%) → ~367K | not set | 90% | $0.069 / ~55% | Medium: one practitioner's data from 873 compactions (building and understanding code at 300–450K) plus practitioner experience; no controlled experiment |
| **Research / retrieval** | 250K (25%) → ~217K | 160K (80%) → ~127K | 80% | $0.056 / ~44% | Medium: Anthropic's own search benchmark setup triggers at 200K; DeepSeek-V3.2 and Kimi K2.5 trigger at 80% of the window. Risk: more likely to lose the original question, so write it to a file |
| **Long autonomous runs** | 600K (60%) → ~567K | not set | 90% | $0.088 / ~70% | Weak: a compromise with no direct evidence; what matters most is writing goals and constraints to a file |
| **Budget first** | 200K (20%) → ~167K | not set (lowering it doesn't save money) | 80% | $0.052 / ~41% | Medium: cost model plus the same practitioner's cost-optimal point (~220K). Cost: about 7× as many compactions and the most information loss |

- **The value you set is not where it compacts.** It compacts about 33K earlier (inferred from the official "1M compacts at about 967K"), so "400K" means about 367K.
- **On 200K-window models, lowering the threshold barely saves money** (about 3% per call), so only do it for quality. The setting can't go below 100K, so those models only allow 50%–100%.
- **One value for every model.** If you switch between 1M and 200K models in the same scope, the smaller window caps it.
- **Every compaction loses detail.** Put long-lived rules in `CLAUDE.md`, and start a new session for a different task instead of compacting.
- **Cost model:** the cache stays warm; each call adds about 3K tokens; about 30K is left after a compaction; the summary is about 4% of the compaction point (2K–20K). Prices come from the chat's model.
- **Claude Code's own advice:** "The auto setting picks a window tuned for your model and is strongly recommended for the best cost and performance. Overriding auto may result in high token usage, especially when resuming long sessions." It doesn't say why. Likely causes: resuming an old chat that is already bigger than the new threshold compacts it at once, with a cold cache; a threshold close to the size a chat starts with can compact over and over; and details lost in a summary can cost extra calls to re-read files.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, if set for Claude Code, overrides all of these settings.

The full reference, with sources (other tools' defaults, vendor benchmarks, blog advice and the cost model), is in [docs/compaction-threshold-guide.md](compaction-threshold-guide.md).

### Details

Click an agent to see its recent steps, its final result (with a copy button), the files it changed (click one to open it) and its tool errors. **Open transcript** opens the raw session record.

**Details** also has a **Transcript** line: where the chat is saved (with your home folder shortened to `~`), how big the transcript, its subagents and its file backups are, and **Reveal in Finder** (File Explorer on Windows) and **Copy Path** buttons.

### Usage and cost

- **Context:** how much is used out of the auto-compact point (for example, "412K / 967K auto-compact"), the percentage of the model's window ("41% of the 1M window"), and how much is left before auto-compact. The bar fills up as the chat approaches auto-compact.
- **Percentages and windows come from Claude Code and Codex themselves.** The percentage uses Claude Code's own formula: context tokens (input + cache write + cache read of the latest call) ÷ context window, rounded. The window comes from Claude Code's cost record for the session (which knows whether a model runs with a 1M window), otherwise from the model's standard window; for Codex, from the Codex log. For the other tools, see [Supported tools](#supported-tools).
- **Where auto-compact happens, and why:** from your settings (this project's local settings, this project's settings, or your user settings), otherwise **measured** (where that model last auto-compacted, remembered by the extension), otherwise the official default. The tooltip says which one applies. If `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is set for Claude Code, it compacts earlier than shown; the extension can't see Claude Code's environment variables.
- **Context hints:** soft labels ("Consider compacting", "Handle soon") when a large context is worth dealing with at the next good stopping point. They never change the light colour.
- **Prompt cache:** a countdown for each Claude Code chat's cache ("Cache: 38 min left").
- **API-equivalent cost:** for each agent, each chat, and a total for today (Claude Code and Codex only). For a Claude Code chat, the header shows Claude Code's own running total for that chat ("Claude Code's count"); everything else is estimated from token counts at list API prices. Subscription plans are not billed this way, so treat it as a comparison. GitHub Copilot Chat shows Copilot credits instead of a cost (see [Supported tools](#supported-tools)).

### Usage history

**Agent Monitor: Show Usage History** (in the **…** menu of the panel title bar, or the Command Palette) opens a page with your Claude Code and Codex usage over the last 30 days (GitHub Copilot Chat, Gemini CLI and Qwen Code aren't included):

- the estimated cost or the tokens of each day, as a bar chart with Claude Code and Codex stacked (switch between **Cost** and **Tokens**, or **Show as a table**);
- totals for the period, the daily average and how many days you used them;
- a breakdown **By model**: input, output, cache read, cache write, reasoning, all tokens and estimated cost.

![The Usage History page, with made-up sample data: estimated cost per day over 30 days with Claude Code and Codex stacked, the totals and the breakdown by model](../images/history.png)

How it works:

- It is worked out on your computer from the same records the panel reads (see [What it reads](#what-it-reads)). The records are read in the background, only while the page is open, and the page updates every minute while you look at it.
- The results are cached in the extension's storage, so the next visit reads only what's new.
- Costs are API-equivalent estimates at list prices, as everywhere else in the extension. Tokens from models without a public price are left out of the cost, and the page says how many there were.
- Days follow your computer's local time.
- Only transcripts still on your computer count. Claude Code deletes old transcripts after its cleanup period (`cleanupPeriodDays`, 30 days by default), so older days can show less than you actually used.

### Usage limits and resuming

- Shows when a Claude Code chat hits its session, weekly or model limit, and when the limit resets.
- Shows Codex's 5-hour and weekly usage percentages.
- When a Claude Code or Codex chat or agent was stopped by a usage limit, an API error or an interruption, **Copy Resume Prompt…** copies a ready-made prompt or terminal command (`claude --resume …`, `codex resume …`). It also estimates what re-reading the context will cost.

### Where your chats are stored, and moving them

The prompt cache lives on Anthropic's and OpenAI's servers and takes no space on your computer. What does take space, and gets written to again and again, are the chat transcripts, file backups, plugins and logs. On one test machine, each Claude Code session process wrote 23–78 MB and read 14–36 MB per hour and used 300–400 MB of memory; `~/.claude/projects` was 932 MB, and `~/.codex` held 298 MB of plugins and 52 MB of sessions.

That much writing is not a concern for an SSD's lifetime. The real issue is free space on your system disk. Moving the files frees space but doesn't reduce memory use.

**Agent Monitor: Storage Locations and Usage** (in the **…** menu of the Agent Monitor panel's title bar, or the Command Palette) shows:

- Claude Code's data folder (`CLAUDE_CONFIG_DIR` or `~/.claude`) and the size of `projects`, `file-history`, `plugins`, `skills`, `cache`, `backups`, `shell-snapshots` and `~/.claude.json`;
- Codex's folder (`CODEX_HOME` or `~/.codex`), its subfolders and database files;
- which items are already symbolic links, and where they point;
- the free space on each disk;
- how long Claude Code keeps transcripts (`cleanupPeriodDays`, 30 days unless you change it).

The page covers only Claude Code and Codex. Sizes are counted in the background, only while the page is open and at most once every 10 minutes.

> **The moving plans are a reference only.** They are generated from the paths on your computer and are not a tested procedure. Check every path and command yourself, back up anything important, and decide for yourself whether to run them. You are responsible for the results, including any data loss. The extension is provided "as is", without warranty of any kind. On the page, you have to tick a confirmation before you can copy the commands or put them in a terminal.

It also prepares commands for moving the data to another folder. The default suggestion is the non-system disk with the most free space, and you can pick any folder.

- **Option A (recommended): move only the biggest folder and leave a symbolic link.** For Claude Code that is `projects`, for Codex `sessions`. On macOS and Linux the command looks roughly like this (the generated one also checks first that nothing is in the way):

  ```sh
  mkdir -p '/Volumes/External/AI-Data/claude/projects' \
    && rsync -a ~/.claude/projects/ '/Volumes/External/AI-Data/claude/projects/' \
    && mv ~/.claude/projects ~/.claude/projects.bak \
    && ln -s '/Volumes/External/AI-Data/claude/projects' ~/.claude/projects
  # When everything works, delete the backup: rm -rf ~/.claude/projects.bak
  ```

  On Windows it uses `robocopy` and a directory junction (`mklink /J`). These Windows commands have not been tested on Windows yet.
- **Option B (official): move the whole folder** with `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. In VS Code, set it through the Claude Code extension's `claudeCode.environmentVariables` setting; for the terminal, add it to your shell profile. You may need to log in again (not verified).

Before you move anything:

- The page lists chats that are still open. Close them first, and don't start new ones while moving.
- An external disk must be connected before you start Claude Code or Codex. Otherwise the link points nowhere, and sessions fail to save or start in an empty folder.
- Don't use a synced folder such as iCloud Drive or Dropbox; constant writes conflict with syncing.
- Keep the `.bak` copy until you're sure everything works.

**The extension never runs these commands.** **Copy Commands** copies them, and **Open in Terminal** types them into a new terminal without pressing Enter, so you can check them and run them yourself. The extension follows the data wherever it goes: symbolic links are transparent, and `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are respected. If you don't want a chat saved at all, Claude Code's `--no-session-persistence` flag turns transcripts off (Agent Monitor then can't see that chat).

### Supported tools

- **Claude Code** in the VS Code extension, the terminal or the desktop app, including subagents, background agents and workflows.
- **Codex** in the VS Code extension, the CLI or the desktop app, including subagent and reviewer threads.
- **GitHub Copilot Chat**: VS Code's built-in chat, including agent mode and its subagents.
- **Gemini CLI** (preview), including subagents.
- **Qwen Code** (preview), including subagents.
- Tools that aren't installed are skipped, and each one can be turned off in the settings (see [Settings](#settings)).

> **Gemini CLI and Qwen Code are a preview.** Support for them is built from their published record formats and hasn't been checked against real sessions yet. If a chat looks wrong, please report it in [GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues).

Each tool records different things, so the extension can see different things:

| | GitHub Copilot Chat | Gemini CLI (preview) | Qwen Code (preview) |
| --- | --- | --- | --- |
| **Open, working, done** | Read from the chat, but up to about a minute late: VS Code saves chats about once a minute | Guessed from when the chat was last written, so a chat that looks done can go back to working. A tool's name appears only after the tool finishes | Whether the chat is open is exact: it comes from the Qwen Code process ID |
| **Needs you** | Exact, with the same delay | Guessed | Guessed |
| **Tokens and cost** | Tokens for the whole chat (not per subagent), and Copilot credits instead of a dollar cost | Tokens and estimated cost | Tokens, and a cost estimated at Alibaba Cloud's international list prices. The free OAuth model shows tokens only |
| **Context** | Window from the model details VS Code saves with the chat. No auto-compact point | The model's standard window. No auto-compact point | Window from Qwen Code's records. No auto-compact point |

Usage history, today's total cost (and its alert) and the [storage page](#where-your-chats-are-stored-and-moving-them) cover only Claude Code and Codex. **Compact…**, handoff notes, the auto-compact threshold and resume prompts are offered only for Claude Code and Codex chats, and background compaction is still Claude Code only.

### Terminal version

![The terminal version with the same lights and the same fixed order](../images/terminal.png)

The same monitor also runs in a terminal. It is included in the source repository, not in the extension package, and needs Node.js 20 or later (tested with Node.js 20, 22 and 24):

```sh
git clone https://github.com/cyuneo/cyuneo-agent-monitor.git
cd cyuneo-agent-monitor
node bin/agent-monitor.js --watch          # refresh in place; q or Ctrl+C to quit
node bin/agent-monitor.js --session 1a2b   # one chat in detail: steps, result, files, errors, resume
node bin/agent-monitor.js --json           # the data as JSON
```

Other options include `--provider all|claude|codex|copilot|gemini|qwen` (default `all`), `--window <minutes>`, `--here` (only chats in the current folder), `--today`, `--lang en|zh-cn|zh-tw|ko|ja` and `--no-color`. Run `--help` for the full list.

## Installation

- **One click:** [Install in VS Code](https://vscode.dev/redirect?url=vscode:extension/cyuneo.cyuneo-agent-monitor) opens VS Code on the extension's page. Click **Install**.
- **From the Extensions view:** search for **CYUNEO Agent Monitor** and click **Install**. It is published on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=cyuneo.cyuneo-agent-monitor).
- **From the command line:**

  ```sh
  code --install-extension cyuneo.cyuneo-agent-monitor
  ```

After installing, open the **Agent Monitor** tab in the bottom panel, or run **Agent Monitor: Show Agent Monitor** from the Command Palette.

## What it reads

Everything is read-only, with one exception that you start yourself: when you set the auto-compact threshold, the extension may write the `autoCompactWindow` key in a Claude Code settings file (see [Set your own auto-compact threshold](#set-your-own-auto-compact-threshold)). When you compact a closed chat in the background, it is Claude Code itself that adds the summary to that chat's record.

| File | Used for |
| --- | --- |
| `~/.claude/projects/<project>/<session>.jsonl` | Claude Code chats (the main conversation) |
| `~/.claude/projects/<project>/<session>/subagents/…` | Subagents, background agents and workflow agents |
| `~/.claude/projects/<project>/<session>/workflows/…` | Workflow names, state and results |
| `~/.claude/sessions/*.json` | Claude Code's list of running sessions: which chats are open, and whether each one is busy or waiting for approval, an answer or a dialog. Only the `.json` files are read. The `.key` files and sockets next to them are never opened. |
| `~/.claude/settings.json`, `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json` | Your auto-compact settings (`autoCompactWindow`, `autoCompactEnabled`) and `cleanupPeriodDays` |
| `~/.claude/file-history/<session>` and the other folders under `~/.claude` and `~/.codex` | Sizes only (for the Transcript line and the storage page). File contents are not opened. |
| `~/.codex/sessions/**/rollout-*.jsonl` | Codex threads, including subagent and reviewer threads and usage limits |
| `~/.codex/session_index.jsonl` | Codex thread titles |
| `~/.codex/models_cache.json`, `~/.codex/config.toml` | Codex context window and auto-compact limit |
| `<User>/workspaceStorage/<workspace>/chatSessions/<session>.jsonl` (or `.json`) | GitHub Copilot Chat chats in windows with a folder or workspace open. `<User>` is the User folder of the VS Code you are using, for example `~/Library/Application Support/Code/User` on macOS, `~/.config/Code/User` on Linux or `%APPDATA%\Code\User` on Windows |
| `<User>/globalStorage/emptyWindowChatSessions/<session>.jsonl`, and the same under `<User>/profiles/<profile>/` | Copilot Chat chats in windows with no folder open, including other profiles |
| `<User>/workspaceStorage/<workspace>/workspace.json` | Which folder a Copilot Chat chat belongs to |
| `~/.gemini/tmp/<project>/chats/session-*.jsonl` (or `.json`) and `~/.gemini/tmp/<project>/chats/<session>/…` | Gemini CLI chats and their subagents. When Gemini CLI runs in the macOS sandbox, the same files under `~/.cache/.gemini`, which is read too unless `agentMonitor.gemini.home` is set |
| `~/.gemini/tmp/<project>/.project_root`, `~/.gemini/projects.json` | Which folder a Gemini CLI chat belongs to |
| `~/.qwen/projects/<project>/chats/<session>.jsonl` | Qwen Code chats, including subagents |
| `~/.qwen/projects/<project>/chats/<session>.runtime.json` | The Qwen Code process ID, to tell whether the chat is still open. The extension only checks whether that process is still running |

The paths above are the defaults. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are respected; `GEMINI_CLI_HOME` puts the Gemini CLI folders under `$GEMINI_CLI_HOME` instead of `~`; and for Qwen Code, `QWEN_RUNTIME_DIR`, else `QWEN_HOME`, is used instead of `~/.qwen`. You can also point the extension somewhere else with `agentMonitor.claude.projectsDir`, `agentMonitor.codex.home`, `agentMonitor.gemini.home` and `agentMonitor.qwen.home`.

The extension only reads the GitHub Copilot Chat, Gemini CLI and Qwen Code files, and never writes to them or to those tools' folders. Nothing from them is sent anywhere, apart from the short messages described in [Push to your phone or team chat](#push-to-your-phone-or-team-chat) if you turn push on.

The extension keeps a few small things in VS Code's own storage: which chats you have already looked at, which reminders you turned off, where each model was measured to auto-compact, and backups of any settings file it changed. It writes to the clipboard only when you click a copy or compact action.

While `agentMonitor.shareScanAcrossWindows` is on (the default), the windows also share a folder in the extension's global storage (`shared-scan`), even when only one window is open. It says which window reads the records, and that window saves its latest results for the others in `shared-scan/snapshot.json`: chat titles, project folders, steps and costs. The file is overwritten whenever the results change and deleted when that window closes normally. Each window also keeps a small record there with its folders and the process IDs of its extension host and terminals, so that [Go to](#go-to-where-a-chat-is-running) can find the window a chat runs in; a request to another window to open a chat is a small file there too, which that window deletes when it takes it. For notifications, a small marker per wait (a hash, no chat text) goes into a private folder in your system's temporary directory, so that only one window, in any editor, shows it. Markers are removed after a day. With push on, the send times of each push channel (no message text) are kept in the same folder (`push-sent.json`), so the limits hold across windows.

The [usage history](#usage-history) page keeps a cache in the extension's storage: for each transcript it has read, the file's path, size and how far it was read, plus token counts per day and model and the message IDs it uses to avoid counting a response twice. No chat text is stored. The cache changes only while the page is open.

## Privacy

- **The extension makes no network requests unless you turn on Allow network access** (`agentMonitor.network.allow`, off by default). While it is off, every request is refused in the code, push notifications and test messages included. Today only push notifications use it. There is no telemetry, no analytics and no remote content.
- **Push notifications are optional and off by default.** When you turn them on, only a short message goes to the services you set up: the project folder name and the state, plus the chat title and subagent names if you allow them. Nothing else leaves your computer. As with any web request, the service sees that message and your IP address. Tokens and webhook URLs are kept in VS Code's secure storage and are masked in every error that is shown or logged.
- **Compacting a closed chat in the background goes through Claude Code**, and only after you confirm. The extension then runs your local Claude Code (`claude -p --resume <session> --model <model> --output-format json "/compact …"`). Claude Code connects to Anthropic just as it does when you use it yourself, and the usage counts toward your plan or API bill.
- **Compacting an open chat, or setting its auto-compact threshold, only puts text into its input box** (`/compact …` or `/autocompact …`). Nothing is sent until you press Enter. (For a closed chat, or for one project only, the threshold is written to a settings file instead; see [What it reads](#what-it-reads).)
- **Moving your data is up to you.** The storage page only generates commands; the extension never runs them, and **Open in Terminal** doesn't press Enter.
- **Go to looks at your processes only when you use it.** To find the terminal or window a chat runs in, it lists the running processes on your computer (see [Go to where a chat is running](#go-to-where-a-chat-is-running)). It doesn't read your chats for this, and nothing is sent anywhere. It controls Terminal.app or iTerm2, to select a tab, only after you confirm, and macOS asks for your permission as well.
- **The reference guide link** opens a page on GitHub in your browser, only when you click it.
- **Desktop notifications stay on your computer.** They are shown by VS Code, or by your system's own notification command (`osascript` on macOS, `notify-send` on Linux), and contain the chat's title and project folder name. Nothing is sent over the network.
- **Sounds are played on your computer** by the system's own player (`afplay` on macOS, `canberra-gtk-play` or `paplay` on Linux, PowerShell on Windows). Nothing is sent over the network.
- **The usage history is worked out on your computer** and cached in the extension's storage. Nothing is sent anywhere.
- **Your conversations stay local.** Chat titles, steps and results are shown only inside your own VS Code (and, for notifications, in your own system's notification area).
- **The numbers are for you, not the model.** Context size, cache countdown and cost are never passed to the model.

## Commands

All commands are in the **Agent Monitor** category, and the table shows where you find each one. Commands that act on one chat work from its row; when run from the Command Palette, they ask which chat (the selected one is listed first).

| Command | Where | What it does |
| --- | --- | --- |
| **Show Agent Monitor** | Status bar light, Command Palette | Opens the Agent Monitor panel |
| **Show Overview in Side Bar** | Command Palette | Opens the Overview tree in the side bar |
| **Refresh** | Panel title bar, Overview title bar, Command Palette | Re-reads the records now |
| **Open Settings** | **…** menu of the panel title bar, Overview title bar, Command Palette | Opens Agent Monitor's settings |
| **Show All Sessions** / **Show Only This Workspace's Sessions** | Panel title bar, Overview title bar, Command Palette | Switches the scope |
| **Mark as Seen** / **Mark All as Seen** | Chat right-click or **…** / Panel title bar, Command Palette | Turns "Done (new)" into "Done" |
| **Hide Completed Agents** / **Show Completed Agents** | Panel title bar, Overview title bar, Command Palette | Hides or shows finished agents |
| **Go to Chat** | **Go to** in the chat's header, double-clicking a chat or agent, chat right-click or **…**, Overview right-click and chat rows, Command Palette | Brings up where the chat is running; see [Go to where a chat is running](#go-to-where-a-chat-is-running) |
| **Open Transcript** | Chat and agent right-click | Opens the raw record |
| **Reveal Transcript File** | Chat right-click or **…**, Transcript line in the chat's Details | Shows the transcript in Finder or File Explorer |
| **Copy Transcript Path** | Chat right-click or **…**, Transcript line in the chat's Details | Copies the transcript's full path |
| **Copy Resume Prompt…** | Chat right-click or **…**, when a Claude Code or Codex chat has something to resume | Copies a resume prompt or terminal command |
| **Compact…** | Chat row, right-click or **…** (Claude Code and Codex chats with 20K context or more), the chat's header, Command Palette | Compacts the chat; see [Compact button](#compact-button-with-a-choice-of-model-and-a-cost-estimate) |
| **Write Handoff Note and Start Fresh…** | Chat right-click or **…** (Claude Code and Codex chats), Compact menu, Command Palette | Asks the model to write `HANDOFF.md`, then guides you to `/clear` and continue |
| **Set Auto-Compact Threshold…** | "Auto-compact" in the chat's Details, chat right-click or **…** (Claude Code and Codex chats), Command Palette | See [Set your own auto-compact threshold](#set-your-own-auto-compact-threshold) |
| **Storage Locations and Usage** | **…** menu of the panel title bar, Command Palette | See [Where your chats are stored](#where-your-chats-are-stored-and-moving-them) |
| **Push Notifications…** | **…** menu of the panel title bar, Command Palette | See [Push to your phone or team chat](#push-to-your-phone-or-team-chat) |
| **Allow Network Access** / **Block Network Access** | **…** menu of the panel title bar, Command Palette | Turns network access on or off; see [Privacy](#privacy) |
| **Toggle Network Access** | Only through a keyboard shortcut you assign in Keyboard Shortcuts | Turns network access on when it is off, and off when it is on |
| **Show Usage History** | **…** menu of the panel title bar, Command Palette | See [Usage history](#usage-history) |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `agentMonitor.scope` | `all` | Which chats the chat list, Overview, status bar and badges include: `all`, or only this `workspace` |
| `agentMonitor.followActiveChat` | `true` | Select the matching chat when you switch to a Claude Code or Codex chat tab |
| `agentMonitor.hideCompleted` | `false` | Hide finished subagents, workflow agents and completed workflows (the main agent is always shown) |
| `agentMonitor.showStatusBar` | `true` | Show the overall status light in the status bar |
| `agentMonitor.statusBarBackground` | `true` | Warning background when something needs you, error background when something failed |
| `agentMonitor.showCost` | `true` | Show API-equivalent costs |
| `agentMonitor.sessionListPosition` | `auto` | Which side of the panel the chat list is on: `auto` (the same side as the terminal's tab list), `left` or `right` |
| `agentMonitor.notifyNeedsYou` | `true` | Notify you when a chat starts waiting for you: a message in the focused window, or a system notification when no VS Code window has focus (macOS and Linux; elsewhere, a message in the next window you switch to) |
| `agentMonitor.refreshSeconds` | `2` | How often to re-read the session records |
| `agentMonitor.activeWindowMinutes` | `30` | Show chats active within this many minutes (open and selected chats are always shown) |
| `agentMonitor.staleMinutes` | `5` | Minutes without new records before an agent counts as having no activity |
| `agentMonitor.approvalGuess` | `fastTools` | When a chat can't report its real state, guess "may be waiting for your approval": `fastTools`, `allTools` or `off` |
| `agentMonitor.approvalGuessSeconds` | `60` | Seconds a quick tool can go without a result before the guess applies |
| `agentMonitor.backgroundRefreshSeconds` | `5` | While no VS Code window has focus, re-read the records this often instead, in seconds (2–60; never faster than `refreshSeconds`) |
| `agentMonitor.shareScanAcrossWindows` | `true` | Let VS Code windows share one reading of the records (one window reads them, the others show its results) |
| `agentMonitor.claude.enabled` | `true` | Read Claude Code records |
| `agentMonitor.claude.projectsDir` | `""` | Claude Code records folder (empty: `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`) |
| `agentMonitor.claude.cliPath` | `""` | Claude Code command line, used only for background compaction (empty: look for `claude` on PATH, then in the Claude Code extension) |
| `agentMonitor.codex.enabled` | `true` | Read Codex records |
| `agentMonitor.codex.home` | `""` | Codex folder (empty: `$CODEX_HOME` or `~/.codex`) |
| `agentMonitor.copilot.enabled` | `true` | Read GitHub Copilot Chat sessions (VS Code's built-in chat) |
| `agentMonitor.gemini.enabled` | `true` | Read Gemini CLI records (preview) |
| `agentMonitor.gemini.home` | `""` | Gemini CLI folder (empty: `$GEMINI_CLI_HOME/.gemini` or `~/.gemini`, plus the macOS sandbox folder `$GEMINI_CLI_HOME/.cache/.gemini` or `~/.cache/.gemini`) |
| `agentMonitor.qwen.enabled` | `true` | Read Qwen Code records (preview) |
| `agentMonitor.qwen.home` | `""` | Qwen Code folder (empty: `$QWEN_RUNTIME_DIR`, else `$QWEN_HOME`, else `~/.qwen`) |
| `agentMonitor.compactConfirm` | `true` | Ask before compacting a closed chat in the background |
| `agentMonitor.compactTemplate` | `""` | Text after `/compact` that says what to keep (empty: built-in template in your display language) |
| `agentMonitor.contextHintStart` | `200000` | For models with a window of 500K tokens or more: from this many tokens on, suggest compacting at the next good stopping point |
| `agentMonitor.contextHintAct` | `500000` | For models with a window of 500K tokens or more: from this many tokens on, recommend dealing with the context before auto-compact kicks in |
| `agentMonitor.cacheReminder` | `true` | Remind you shortly before a large idle chat's 1-hour prompt cache expires |
| `agentMonitor.cacheReminderMinutes` | `8` | How many minutes before expiry to remind you |
| `agentMonitor.cacheReminderMinContext` | `150000` | Only remind about chats with at least this many context tokens |
| `agentMonitor.cacheReminderShortTtl` | `false` | Also remind about chats that use the 5-minute cache |
| `agentMonitor.closeReminder` | `true` | When you close a large chat while its cache is warm, offer to compact it or write a handoff note |
| `agentMonitor.postCompactHint` | `true` | After a chat is compacted, remind you to check that its key rules are still there |
| `agentMonitor.sound.enabled` | `false` | Play sounds; see [Sounds](#sounds) |
| `agentMonitor.sound.needsYou` | `default` | Sound when an agent needs you: `default`, `off`, or `Glass`, `Ping`, `Pop`, `Tink`, `Submarine`, `Funk`, `Hero`, `Basso` |
| `agentMonitor.sound.error` | `default` | Sound when an agent stops with an error or a usage limit (same choices) |
| `agentMonitor.sound.done` | `default` | Sound when a chat finishes and you haven't looked at it yet (same choices) |
| `agentMonitor.sound.alert` | `default` | Sound for threshold alerts (same choices) |
| `agentMonitor.quietHours.enabled` | `false` | Quiet hours: no sounds, system notifications or push; see [Quiet hours](#quiet-hours) |
| `agentMonitor.quietHours.start` | `"22:00"` | When quiet hours start (local time, 24-hour `HH:MM`) |
| `agentMonitor.quietHours.end` | `"08:00"` | When quiet hours end; earlier than the start means the next day |
| `agentMonitor.quietHours.days` | `[]` | The days quiet hours start on: `sun` … `sat`; empty means every day |
| `agentMonitor.quietHours.allowErrors` | `false` | During quiet hours, still play the error sound for API errors and usage-limit hits, and push them |
| `agentMonitor.alerts.usagePercent` | `90` | Alert when Codex's 5-hour or weekly usage reaches this percentage (0: off); see [Threshold alerts](#threshold-alerts) |
| `agentMonitor.alerts.dailyCost` | `0` | Alert when today's estimated cost reaches this many US dollars (0: off) |
| `agentMonitor.alerts.contextPercent` | `0` | Alert when a chat's main conversation reaches this percentage of its auto-compact point (0: off) |
| `agentMonitor.network.allow` | `false` | Allow network requests. Off, the extension makes none at all; today only push notifications use it. Applies to this computer only (not synced by Settings Sync) |
| `agentMonitor.push.enabled` | `false` | Push to your phone or team chat; see [Push to your phone or team chat](#push-to-your-phone-or-team-chat) |
| `agentMonitor.push.events` | all on | Which events are pushed: `needsYou`, `error`, `limitHit`, `limitReset`, `usageHigh`, `costDaily`, `contextHigh` |
| `agentMonitor.push.delaySeconds` | `30` | How many seconds a chat must keep waiting for you before it is pushed (0–600) |
| `agentMonitor.push.includeTitle` | `false` | Also send the chat title and subagent name (never a title made from your prompt) |
| `agentMonitor.push.channels` | `[]` | The push channels without their secrets; change them with **Push Notifications…** |
| `agentMonitor.onlyWorkspace` | `false` | Deprecated: replaced by `agentMonitor.scope` and migrated automatically |

The push settings and `agentMonitor.network.allow` are read only from your user settings, so a workspace can't turn push or network access on, or change where pushes go.

## Context and compaction tips

These tips come from a review of published research and the official documentation. The full notes, with sources, are in [docs/research-context-compaction.md](research-context-compaction.md). For choosing an auto-compact threshold, see [docs/compaction-threshold-guide.md](compaction-threshold-guide.md) and [Set your own auto-compact threshold](#set-your-own-auto-compact-threshold).

1. **Don't compact just to be safe.** If a task is going well and a 1M-context model is below about 200K tokens, leave it alone. Below about 50K there is almost nothing to gain, and compacting only loses detail.
2. **Compact at a milestone, and say what to keep.** Good moments are when exploring is done or a sub-feature is finished, not the middle of a task. Use `/compact Keep: the goal, decisions and why, open problems, file paths, constraints such as "don't push"`. Above about 500K, deal with it at the next milestone instead of waiting for auto-compact to fire mid-task.
3. **Put long-lived rules in a file.** Use `CLAUDE.md` at the project root (`AGENTS.md` for Codex). Rules you only said in chat are often lost in a summary.
4. **For a different task, start a new session.** Use `/clear`, writing a handoff note first if you need one, and read it yourself before relying on it. If you went the wrong way, use `/rewind` instead of compacting.
5. **Compact while the cache is warm.** Compacting reads the whole context, and a warm cache makes that cheap. See the example under [Compact button](#compact-button-with-a-choice-of-model-and-a-cost-estimate).
6. **Watch the compaction count.** After two or more compactions (a rule of thumb, not a measured limit), if there's still a lot to do, write a handoff note and start fresh. After any compaction, check that important constraints, especially commit, push and delete permissions, are still in place.
7. **Think twice before a 1-hour cache for subagents.** Each cache write costs 60% more (2× instead of 1.25× the input price). It only pays off when subagents often pause for more than 5 minutes. A usage-limit pause usually lasts hours, longer than even the 1-hour cache.

## Known limitations

- **Record formats can change.** The record formats of all five tools are internal and can change with any update. Lines the extension can't read are skipped.
- **Gemini CLI and Qwen Code support is a preview.** It is built from their published record formats and hasn't been checked against real sessions yet. If a chat looks wrong, please tell us in [GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues).
- **Steps can lag.** Records are written after each model call, so during a long stretch of thinking the step shown is the last one written.
- **"Needs you" is exact only when the app reports its state.** That means Claude Code versions that report live state in `~/.claude/sessions`, and GitHub Copilot Chat. Older Claude Code versions, Codex, Gemini CLI and Qwen Code rely on the guess described above, and Codex writes very little about approvals and errors to disk. Gemini CLI keeps no list of running sessions either, so whether its chats are working or done is a guess too.
- **GitHub Copilot Chat can be up to about a minute behind.** VS Code saves chats to disk about once a minute, so a new step, a finished answer or a prompt waiting for you can show up to a minute late.
- **Costs are estimates.** They use list prices as of the date shown in the tooltip, so prices can change. Some models, such as Codex's review model, have no public price. GitHub Copilot Chat shows Copilot credits, not a cost. Qwen Code costs use Alibaba Cloud's international list prices (other regions charge differently); cache hits are priced at the explicit-cache rate, because the records don't say which kind of cache was used; and the free OAuth model has no price, so only its tokens are shown.
- **Some features cover only Claude Code and Codex.** Usage history, today's total cost (and the daily cost alert) and the storage page don't include GitHub Copilot Chat, Gemini CLI or Qwen Code, and none of these three has an auto-compact point. **Compact…**, handoff notes, the auto-compact threshold and resume prompts are only for Claude Code and Codex chats.
- **Claude Code usage percentages aren't shown.** Claude Code doesn't save them to local files, so for Claude the extension only shows limit hits and reset times, and the usage alert is Codex only.
- **Tab following has gaps.** It uses the tab title for Claude Code and the conversation ID for Codex. Chats shown in a side bar view (rather than an editor tab) can't be detected.
- **Background compaction with a chosen model is Claude Code only.** Codex compacts inside Codex. A chat can't be compacted in the background while it is open.
- **Claude Code's environment variables are invisible to the extension.** `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can make Claude Code compact at a different point than the one shown. A measured point appears only after a model has auto-compacted once.
- **Windows share one reading of the records.** With several VS Code windows open, one of them reads the records and the others show its results, usually only a moment later. When that window closes, another one takes over right away; if it stops responding, within about 10 seconds (longer while no VS Code window has focus, since the windows then check on each other only every `agentMonitor.backgroundRefreshSeconds`). Windows with different reading settings (folders, activity window, guesses) or a different extension version read on their own, and so does every window when the shared folder can't be written (for example, when the disk is full). You can turn sharing off with `agentMonitor.shareScanAcrossWindows`.
- **System notifications are basic.** On macOS they are shown with AppleScript, so they appear under **Script Editor**, and that is where you allow or silence them in System Settings > Notifications. Clicking one opens Script Editor, not VS Code: switch to VS Code yourself, where the waiting chat has a magenta light. On Windows and in remote windows there is no system notification for now; the message appears in the next VS Code window you switch to instead. On Linux, a VS Code message is shown when `notify-send` isn't installed.
- **You can't approve or answer from a notification.** Agent Monitor only reads the records. Answering from a notification would need hooks into Claude Code or Codex, or remote control of them. Switch to the chat to answer it.
- **Clicking a system notification can't take you to the chat.** The system shows the notification on its own and can't call back into the extension. Use **Go to** in the panel instead: in a VS Code message, **Show** selects the chat in the panel, and **Go to** takes you to it, in whichever window it runs.
- **Go to doesn't reach every place yet.** Chats in the Claude and Codex desktop apps, and in terminal apps other than Terminal.app and iTerm2 (Warp, Ghostty, WezTerm, kitty, Alacritty, Windows Terminal and others), aren't supported yet. For Codex CLI and Gemini CLI, when several run in the same folder, the newest one is chosen. A chat in another VS Code window can be reached only while `agentMonitor.shareScanAcrossWindows` is on.
- **Sounds have only been tried on macOS.** On Linux they are played with `canberra-gtk-play` or `paplay`, and on Windows with PowerShell, from the Windows `Media` folder; neither has been tried yet.
- **The Windows move commands haven't been tested on Windows yet.** The `robocopy` and `mklink /J` commands on the Storage Locations page were checked only as text. Read them before running them, and keep the `.bak` folder until everything works.
- **The terminal version doesn't push.** Push notifications come only from the VS Code extension.
- **DingTalk signing hasn't been tried with a real robot.** The signature follows DingTalk's documentation and is checked only against it. If a robot that uses signing rejects the messages, use a custom keyword as its security setting instead, and please tell us in [GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues).

---

© 2026 Chenyu Guo. Free for personal and noncommercial use under the [PolyForm Noncommercial License 1.0.0](../LICENSE). The CYUNEO™ name and logo are not licensed.
