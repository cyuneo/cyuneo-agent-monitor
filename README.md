# CYUNEO Agent Monitor

**English** · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [한국어](README.ko.md) · [日本語](README.ja.md)

See all your Claude Code and Codex chats in one place, next to your terminal: which agents are working, which ones need you, and how full each context is.

The extension reads the session records that Claude Code and Codex already write on your computer. The extension itself makes no network requests and collects no data.

> **Preview (0.3.0).** This is the first public version. Please report anything that looks wrong in [GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues).

![Agent Monitor in the VS Code panel, laid out like the Terminal: the selected chat's agents fill the panel, and a narrow list of chats with status lights sits on the side where the terminal's tab list is](images/split-view.png)

## Features

### A panel that works like the Terminal

- **Agent Monitor** opens as a tab in the bottom panel, next to Terminal, and looks like it: one panel with no extra view headers. The agents of the selected chat fill most of it, and a narrow list of chats sits on one side, like the terminal's tab list.
- **The chat list.** Every open and recent chat, each with a status light. They are grouped into **Open** (Claude Code still has the chat open, or Codex is in the middle of a turn) and **Recent**. Rows are the same height as terminal tabs, and the selected chat is highlighted. To leave room for titles, a row shows only the status light and the title, plus a small mark when a large context is worth dealing with: **◔** consider compacting, **◕** handle soon. Hover over a row for its status, context and the rest.
- **The list sits where your terminal's tab list is** (right by default, following `terminal.integrated.tabs.location`); set `agentMonitor.sessionListPosition` to put it on the left or right yourself. Drag the divider to resize it, double-click the divider to reset it to 200 px, or drag it almost closed to shrink the list to a strip of status lights. When the panel is narrower than 500 px, the strip is used automatically. The width is remembered.
- **Hover over a chat** for a **Compact…** button (20K context or more) and a **…** button with the same actions as the right-click menu. You can also use the keyboard: arrow keys, Home and End move through the list, Enter or Space selects, typing jumps to a chat by its first letters, and Shift+F10 opens the actions.
- **The agents.** Click a chat to see what's running inside it: the main conversation on top, then subagents and background agents, with workflow agents grouped under their workflow.
- **The chat's header takes two lines**, so the agents stay in view even in a short panel. The first line is the title, with how full the context is ("41% context") next to **Compact…**. The second has the status, the context against the auto-compact point, hints, the cache countdown and this chat's cost. Everything else (the context bar, the auto-compact setting, today's total, notices, resume prompts and the Transcript line) is under **Details ▸**. Urgent problems, such as a usage limit, an API error or a compaction loop, get one extra line. The table's column headings stay at the top as you scroll, and when the panel is under 400 px tall the cost and time columns are hidden.
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

"Needs you" is exact for Claude Code versions that report their live state (see [What it reads](#what-it-reads)). For older versions and for Codex, the extension has to guess. When a quick tool (reading, writing or editing a file, search, a patch) has had no result for 60 seconds, the chat shows **May be waiting for your approval**. Long commands such as shell commands are never guessed. You can change or turn off the guess with `agentMonitor.approvalGuess`.

### An order that doesn't jump

- Chats are sorted by when they started, newest first. Agents are sorted by when they started, oldest first.
- Nothing is ever reordered by activity, status or token count. When an agent finishes, it stays where it is and only its light changes.
- A chat moves only when it switches between **Open** and **Recent**. The Agents table updates rows in place, so scroll position and expanded rows are kept.

### Compact button, with a choice of model and a cost estimate

![Choosing how to compact a closed Claude Code session, with an estimate for each model](images/compact.png)

Every chat with at least 20K tokens of context gets a **Compact…** button, both on its row in the chat list (when you hover over it) and in the chat's header above its agents. Nothing runs until you choose.

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

The full reference, with sources (other tools' defaults, vendor benchmarks, blog advice and the cost model), is in [docs/compaction-threshold-guide.md](docs/compaction-threshold-guide.md) (in Chinese).

### Details

Click an agent to see its recent steps, its final result (with a copy button), the files it changed (click one to open it) and its tool errors. **Open transcript** opens the raw session record.

**Details** also has a **Transcript** line: where the chat is saved (with your home folder shortened to `~`), how big the transcript, its subagents and its file backups are, and **Reveal in Finder** (File Explorer on Windows) and **Copy Path** buttons.

### Usage and cost

- **Context:** how much is used out of the auto-compact point (for example, "412K / 967K auto-compact"), the percentage of the model's window ("41% of the 1M window"), and how much is left before auto-compact. The bar fills up as the chat approaches auto-compact.
- **Percentages and windows come from Claude Code and Codex themselves.** The percentage uses Claude Code's own formula: context tokens (input + cache write + cache read of the latest call) ÷ context window, rounded. The window comes from Claude Code's cost record for the session (which knows whether a model runs with a 1M window), otherwise from the model's standard window; for Codex, from the Codex log.
- **Where auto-compact happens, and why:** from your settings (this project's local settings, this project's settings, or your user settings), otherwise **measured** (where that model last auto-compacted, remembered by the extension), otherwise the official default. The tooltip says which one applies. If `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is set for Claude Code, it compacts earlier than shown; the extension can't see Claude Code's environment variables.
- **Context hints:** soft labels ("Consider compacting", "Handle soon") when a large context is worth dealing with at the next good stopping point. They never change the light colour.
- **Prompt cache:** a countdown for each Claude Code chat's cache ("Cache: 38 min left").
- **API-equivalent cost:** for each agent, each chat, and a total for today. For a Claude Code chat, the header shows Claude Code's own running total for that chat ("Claude Code's count"); everything else is estimated from token counts at list API prices. Subscription plans are not billed this way, so treat it as a comparison.

### Usage limits and resuming

- Shows when a Claude Code chat hits its session, weekly or model limit, and when the limit resets.
- Shows Codex's 5-hour and weekly usage percentages.
- When a chat or agent was stopped by a usage limit, an API error or an interruption, **Copy Resume Prompt…** copies a ready-made prompt or terminal command (`claude --resume …`, `codex resume …`). It also estimates what re-reading the context will cost.

### Where your chats are stored, and moving them

The prompt cache lives on Anthropic's and OpenAI's servers and takes no space on your computer. What does take space, and gets written to again and again, are the chat transcripts, file backups, plugins and logs. On one test machine, each Claude Code session process wrote 23–78 MB and read 14–36 MB per hour and used 300–400 MB of memory; `~/.claude/projects` was 932 MB, and `~/.codex` held 298 MB of plugins and 52 MB of sessions.

That much writing is not a concern for an SSD's lifetime. The real issue is free space on your system disk. Moving the files frees space but doesn't reduce memory use.

**Agent Monitor: Storage Locations and Usage** (in the **…** menu of the Agent Monitor panel's title bar, or the Command Palette) shows:

- Claude Code's data folder (`CLAUDE_CONFIG_DIR` or `~/.claude`) and the size of `projects`, `file-history`, `plugins`, `skills`, `cache`, `backups`, `shell-snapshots` and `~/.claude.json`;
- Codex's folder (`CODEX_HOME` or `~/.codex`), its subfolders and database files;
- which items are already symbolic links, and where they point;
- the free space on each disk;
- how long Claude Code keeps transcripts (`cleanupPeriodDays`, 30 days unless you change it).

Sizes are counted in the background, only while the page is open and at most once every 10 minutes.

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

### Claude Code and Codex

- **Claude Code** in the VS Code extension, the terminal or the desktop app, including subagents, background agents and workflows.
- **Codex** in the VS Code extension, the CLI or the desktop app, including subagent and reviewer threads.
- Either one can be turned off in the settings.

### Terminal version

![The terminal version with the same lights and the same fixed order](images/terminal.png)

The same monitor also runs in a terminal. It is included in the source repository, not in the extension package, and needs Node.js 18 or later (tested with Node.js 24):

```sh
git clone https://github.com/cyuneo/cyuneo-agent-monitor.git
cd cyuneo-agent-monitor
node bin/agent-monitor.js --watch          # refresh in place; q or Ctrl+C to quit
node bin/agent-monitor.js --session 1a2b   # one chat in detail: steps, result, files, errors, resume
node bin/agent-monitor.js --json           # the data as JSON
```

Other options include `--provider claude|codex`, `--window <minutes>`, `--here` (only chats in the current folder), `--today`, `--lang en|zh-cn|zh-tw|ko|ja` and `--no-color`. Run `--help` for the full list.

## Requirements

- VS Code 1.94 or later.
- Claude Code and/or Codex, used on the same computer (VS Code extension, command line or desktop app).
- To compact a closed chat in the background, you also need the Claude Code command line. The extension looks for `claude` on your PATH, then in the installed Claude Code extension. You can also set `agentMonitor.claude.cliPath`.
- Tested on macOS. Windows and Linux haven't been tested yet.

## Installation

- **From the Extensions view:** search for **CYUNEO Agent Monitor** and click **Install**. It is published on the Visual Studio Marketplace and on Open VSX.
- **From the command line:**

  ```sh
  code --install-extension cyuneo.cyuneo-agent-monitor
  ```

- **From a VSIX file:** download the `.vsix` from [GitHub Releases](https://github.com/cyuneo/cyuneo-agent-monitor/releases). In the Extensions view, open the **…** menu and choose **Install from VSIX…**.

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

`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are respected. You can also point the extension somewhere else with `agentMonitor.claude.projectsDir` and `agentMonitor.codex.home`.

The extension keeps a few small things in VS Code's own storage: which chats you have already looked at, which reminders you turned off, where each model was measured to auto-compact, and backups of any settings file it changed. It writes to the clipboard only when you click a copy or compact action.

## Privacy

- **The extension makes no network requests.** It has no telemetry, no analytics and no remote content, and nothing leaves your computer because of it.
- **The one exception is compacting a closed chat in the background**, and only after you confirm. The extension then runs your local Claude Code (`claude -p --resume <session> --model <model> --output-format json "/compact …"`). Claude Code connects to Anthropic just as it does when you use it yourself, and the usage counts toward your plan or API bill.
- **Compacting an open chat, or setting its auto-compact threshold, only puts text into its input box** (`/compact …` or `/autocompact …`). Nothing is sent until you press Enter. (For a closed chat, or for one project only, the threshold is written to a settings file instead; see [What it reads](#what-it-reads).)
- **Moving your data is up to you.** The storage page only generates commands; the extension never runs them, and **Open in Terminal** doesn't press Enter.
- **The reference guide link** opens a page on GitHub in your browser, only when you click it.
- **Your conversations stay local.** Chat titles, steps and results are shown only inside your own VS Code.
- **The numbers are for you, not the model.** Context size, cache countdown and cost are never passed to the model.

## Commands

All commands are in the **Agent Monitor** category of the Command Palette. Commands that act on one chat work from its row; when run from the Command Palette, they ask which chat (the selected one is listed first).

| Command | Where | What it does |
| --- | --- | --- |
| **Show Agent Monitor** | Status bar light, Command Palette | Opens the Agent Monitor panel |
| **Show Overview in Side Bar** | Command Palette | Opens the Overview tree in the side bar |
| **Refresh** | Panel title bar, Overview title bar | Re-reads the records now |
| **Open Settings** | **…** menu of the panel title bar, Overview title bar | Opens Agent Monitor's settings |
| **Show All Sessions** / **Show Only This Workspace's Sessions** | Panel title bar, Overview title bar, Command Palette | Switches the scope |
| **Mark as Seen** / **Mark All as Seen** | Chat right-click or **…** / Panel title bar | Turns "Done (new)" into "Done" |
| **Hide Completed Agents** / **Show Completed Agents** | Panel title bar, Overview title bar | Hides or shows finished agents |
| **Open Transcript** | Chat and agent right-click | Opens the raw record |
| **Reveal Transcript File** | Chat right-click or **…**, Transcript line in the chat's Details | Shows the transcript in Finder or File Explorer |
| **Copy Transcript Path** | Chat right-click or **…**, Transcript line in the chat's Details | Copies the transcript's full path |
| **Copy Resume Prompt…** | Chat right-click or **…**, when there is something to resume | Copies a resume prompt or terminal command |
| **Compact…** | Chat row, right-click or **…** (20K context or more), the chat's header, Command Palette | Compacts the chat; see [Compact button](#compact-button-with-a-choice-of-model-and-a-cost-estimate) |
| **Write Handoff Note and Start Fresh…** | Chat right-click, Compact menu, Command Palette | Asks the model to write `HANDOFF.md`, then guides you to `/clear` and continue |
| **Set Auto-Compact Threshold…** | "Auto-compact" in the chat's Details, chat right-click or **…**, Command Palette | See [Set your own auto-compact threshold](#set-your-own-auto-compact-threshold) |
| **Storage Locations and Usage** | **…** menu of the panel title bar, Command Palette | See [Where your chats are stored](#where-your-chats-are-stored-and-moving-them) |

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
| `agentMonitor.refreshSeconds` | `2` | How often to re-read the session records |
| `agentMonitor.activeWindowMinutes` | `30` | Show chats active within this many minutes (open and selected chats are always shown) |
| `agentMonitor.staleMinutes` | `5` | Minutes without new records before an agent counts as having no activity |
| `agentMonitor.approvalGuess` | `fastTools` | When a chat can't report its real state, guess "may be waiting for your approval": `fastTools`, `allTools` or `off` |
| `agentMonitor.approvalGuessSeconds` | `60` | Seconds a quick tool can go without a result before the guess applies |
| `agentMonitor.claude.enabled` | `true` | Read Claude Code records |
| `agentMonitor.claude.projectsDir` | `""` | Claude Code records folder (empty: `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`) |
| `agentMonitor.claude.cliPath` | `""` | Claude Code command line, used only for background compaction (empty: look for `claude` on PATH, then in the Claude Code extension) |
| `agentMonitor.codex.enabled` | `true` | Read Codex records |
| `agentMonitor.codex.home` | `""` | Codex folder (empty: `$CODEX_HOME` or `~/.codex`) |
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
| `agentMonitor.onlyWorkspace` | `false` | Deprecated: replaced by `agentMonitor.scope` and migrated automatically |

## Context and compaction tips

These tips come from a review of published research and the official documentation. The full notes, with sources, are in [docs/research-context-compaction.md](docs/research-context-compaction.md) (in Chinese). For choosing an auto-compact threshold, see [docs/compaction-threshold-guide.md](docs/compaction-threshold-guide.md) (in Chinese) and [Set your own auto-compact threshold](#set-your-own-auto-compact-threshold).

1. **Don't compact just to be safe.** If a task is going well and a 1M-context model is below about 200K tokens, leave it alone. Below about 50K there is almost nothing to gain, and compacting only loses detail.
2. **Compact at a milestone, and say what to keep.** Good moments are when exploring is done or a sub-feature is finished, not the middle of a task. Use `/compact Keep: the goal, decisions and why, open problems, file paths, constraints such as "don't push"`. Above about 500K, deal with it at the next milestone instead of waiting for auto-compact to fire mid-task.
3. **Put long-lived rules in a file.** Use `CLAUDE.md` at the project root (`AGENTS.md` for Codex). Rules you only said in chat are often lost in a summary.
4. **For a different task, start a new session.** Use `/clear`, writing a handoff note first if you need one, and read it yourself before relying on it. If you went the wrong way, use `/rewind` instead of compacting.
5. **Compact while the cache is warm.** Compacting reads the whole context, and a warm cache makes that cheap. See the example under [Compact button](#compact-button-with-a-choice-of-model-and-a-cost-estimate).
6. **Watch the compaction count.** After two or more compactions (a rule of thumb, not a measured limit), if there's still a lot to do, write a handoff note and start fresh. After any compaction, check that important constraints, especially commit, push and delete permissions, are still in place.
7. **Think twice before a 1-hour cache for subagents.** Each cache write costs 60% more (2× instead of 1.25× the input price). It only pays off when subagents often pause for more than 5 minutes. A usage-limit pause usually lasts hours, longer than even the 1-hour cache.

## Known limitations

- **Record formats can change.** Claude Code and Codex record formats are internal and can change with any update. Lines the extension can't read are skipped.
- **Steps can lag.** Records are written after each model call, so during a long stretch of thinking the step shown is the last one written.
- **"Needs you" is exact only when the app reports its state.** That means Claude Code versions that report live state in `~/.claude/sessions`. Older Claude Code versions and Codex rely on the guess described above, and Codex writes very little about approvals and errors to disk.
- **Costs are estimates.** They use list prices as of the date shown in the tooltip, so prices can change. Some models, such as Codex's review model, have no public price.
- **Claude Code usage percentages aren't shown.** Claude Code doesn't save them to local files, so for Claude the extension only shows limit hits and reset times.
- **Tab following has gaps.** It uses the tab title for Claude Code and the conversation ID for Codex. Chats shown in a side bar view (rather than an editor tab) can't be detected.
- **Background compaction with a chosen model is Claude Code only.** Codex compacts inside Codex. A chat can't be compacted in the background while it is open.
- **Claude Code's environment variables are invisible to the extension.** `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can make Claude Code compact at a different point than the one shown. A measured point appears only after a model has auto-compacted once.
- **Each VS Code window reads the records separately.**
- **The Windows move commands haven't been tested on Windows yet.** The `robocopy` and `mklink /J` commands on the Storage Locations page were checked only as text. Read them before running them, and keep the `.bak` folder until everything works.

## Unofficial

CYUNEO Agent Monitor is an independent, unofficial project. It is not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI. Product names are the property of their respective owners and are used here only to describe what the extension works with.

## License

CYUNEO Agent Monitor is **free for personal and noncommercial use** under the [PolyForm Noncommercial License 1.0.0](LICENSE). The source code is public, but it is not open-source software.

- **Allowed without asking:** personal use, study, hobby projects and research, and use by charitable, educational, public research, public safety or health, environmental and government organizations. For these purposes you may also change the code and share it, as long as you pass on the license and the `Required Notice` line.
- **Needs a separate commercial license:** any other use, for example using it for your work at a company, including it in a product or service, or selling it. To ask about a commercial license, open an issue titled "Commercial license" in [GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues).
- This summary is for convenience. Only the [license text](LICENSE) is binding.

## Disclaimer

- **No warranty.** The extension is provided "as is", without warranty of any kind. As far as the law allows, the author is not liable for any loss or damage from using it, including lost data, lost work, extra costs or problems with your accounts.
- **It only acts when you confirm.** The extension reads the session records on your computer. It changes a file or runs Claude Code only after you confirm: changing the auto-compact setting (one key, with a backup), compacting in the background, or writing a handoff note.
- **Usage and costs are yours.** Background compaction and handoff notes run your own Claude Code and count toward your plan's usage limits or your API bill. Cost figures are estimates at list prices, not bills.
- **Moving data is at your own risk.** The storage page only suggests commands. You check them and decide whether to run them.
- **Follow the services' terms.** You are responsible for using Claude Code, Codex and their services in line with their terms.
- **Not professional advice.** The context and compaction tips summarize published sources and may be out of date.

## Copyright and trademarks

- © 2026 Chenyu Guo. All rights not expressly granted by the license are reserved.
- The CYUNEO™ name and logo are not licensed. Don't use them for your own products, or in a way that suggests your version comes from or is endorsed by CYUNEO.
- Using this project commercially without a license, removing its copyright or license notices, or republishing it under another name as your own work infringes the author's rights. The author may ask GitHub, the Visual Studio Marketplace, Open VSX and other platforms to take such copies down, and reserves the right to take further legal action.
- If you see a copy being used or sold in violation of the license, please tell us in [GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues).

## Support and security

- Questions, bugs and ideas: [GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues). See [SUPPORT.md](SUPPORT.md).
- Security problems: please report them privately, as described in [SECURITY.md](SECURITY.md).
- Release notes: [CHANGELOG.md](CHANGELOG.md). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

CYUNEO™ / Connect Intelligence. Create Your Universe.

© 2026 Chenyu Guo. Free for personal and noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). The CYUNEO™ name and logo are not licensed.
