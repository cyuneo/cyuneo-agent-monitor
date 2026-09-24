# Changelog

All notable changes to CYUNEO Agent Monitor are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-24

### Added

- **"Needs you" notifications.** When a chat or one of its agents starts waiting for your approval, an answer or a dialog, you are told right away: a message in the focused VS Code window, with a **Show** button that selects the chat in the panel, or a system notification (macOS and Linux) when no VS Code window has focus. On Windows and in remote windows, the message appears in the next VS Code window you switch to instead, for now. There is no message for the chat you are already looking at, and a prompt you answer within a few seconds is not reported. Each wait is reported once, by one window, even across editors that have the extension installed. Chats that were already waiting when the window opened, or that only appear after you change a setting, are not reported. Turn it off with `agentMonitor.notifyNeedsYou`.
- **Windows share one reading of the records.** With several VS Code windows open, one window reads the session records and the others show its results, instead of every window reading them again. If that window closes, another takes over right away; if the shared folder can't be written, each window reads on its own. Turn it off with `agentMonitor.shareScanAcrossWindows`.
- **Slower reading in the background.** While no VS Code window has focus, the records are read every 5 seconds instead of every 2 (`agentMonitor.backgroundRefreshSeconds`), and at full speed again as soon as a window has focus.
- **Push notifications to your phone or team chat (optional, off by default).** When an agent is still waiting for you after a delay (30 seconds by default), stops with an API error, or hits or clears a Claude Code or Codex usage limit, Agent Monitor can send a short message through ntfy, Bark, ServerChan, Feishu / Lark, DingTalk, WeCom, Telegram, Discord or Slack. Only the project folder name and the state are sent, plus the chat title and subagent name if you allow them (`agentMonitor.push.includeTitle`); prompts, code and costs never are. Set it up with **Agent Monitor: Push Notifications…** in the Command Palette or the panel's **…** menu: add a channel, send a test message, choose the events. Tokens and webhook URLs are kept in VS Code's secure storage, and the push settings are read only from your user settings. Messages are grouped, limited per channel (one every 10 seconds, 20 an hour, plus an optional daily limit) and sent by one window only. After three failures in a row you get one warning. With push off, the extension makes no network requests, except a test message you send yourself.

### Changed

- **The count badge shows on the Agent Monitor panel tab from the start**, before you have opened the panel.
- **The reference guides are now in English too.** **View the reference guide** opens the English guide, or the Chinese one when VS Code's display language is Chinese.
- **The README shows a short demo GIF.**
- For contributors: code comments, test names and test output are in English, and the tests run on Linux, macOS and Windows for every push and pull request.

### Fixed

- **Windows: changing a chat's auto-compact threshold no longer fails when Claude Code's `settings.json` is briefly locked** by another program (for example an antivirus scan); the write is retried for a moment.
- **Windows: `~` in `agentMonitor.claude.cliPath` now means your user folder** (`USERPROFILE`), as it does on macOS and Linux.

## [0.3.1] - 2026-09-24

### Changed

- **New license.** From this version on, CYUNEO Agent Monitor is licensed under the PolyForm Noncommercial License 1.0.0: free for personal and noncommercial use; commercial use needs a separate license. See the License, Disclaimer and Copyright sections of the README.
- **Shorter README.** It now explains why the extension exists, what it does for you and how to get started, with an **Install in VS Code** link. Every feature, command and setting is described in the [full guide](docs/GUIDE.md).
- **Clearer Marketplace description and more search keywords.**
- The README now notes that the extension was developed with AI assistance.

## [0.3.0] - 2026-09-24

First public release, published as a **preview**.

### Added

- **Codex support.** Reads Codex session records (VS Code extension, CLI and desktop app), including subagent and reviewer threads, alongside Claude Code.
- **A bottom panel laid out like the terminal.**
  - A narrow list of chats (sessions) with status lights, grouped into Open and Recent, on the same side as the terminal's tab list (right by default; `agentMonitor.sessionListPosition`). Drag the divider to resize it or shrink it to a strip of lights; right-click a chat for its actions.
  - Next to it, the agents of the selected chat, with the main conversation on top, then subagents, then workflow agents grouped under their workflow.
  - Each list row shows only the light, the title and a context mark, so titles have room; status and context are in the tooltip and in the chat's header.
  - A two-line header for the selected chat, so the agents stay visible in a short panel: the title with "41% context" next to **Compact…**, then the status, context against the auto-compact point, cache countdown and cost. The rest is under **Details ▸**, and urgent problems get one extra line. Column headings stay at the top, and the cost and time columns are hidden when the panel is under 400 px tall.
- **Six status lights:** Needs you, Error, Working, Done (new), Done and Idle. They also appear in the status bar, as view badges and in the side bar Overview.
- **Live state of open Claude Code chats.** For Claude Code versions that report it, "waiting for your approval", "waiting for your answer" and "a dialog is waiting for you" are exact.
- **Guessed "may be waiting for your approval"** for other cases: a quick tool (read, write, edit, search, patch) with no result for 60 seconds. Controlled by `agentMonitor.approvalGuess` and `agentMonitor.approvalGuessSeconds`.
- **Compact button** for chats with at least 20K tokens of context:
  - Open Claude Code chat: pre-fills `/compact` with a keep-instructions template in that chat's input box.
  - Closed Claude Code chat: compacts in the background with your local Claude Code, with a choice of the chat's model, Claude Sonnet 5 or Claude Haiku 4.5, a cost estimate for each, and a confirmation step.
  - Codex chat: opens the conversation and copies `/compact`.
  - Also offers "write a handoff note and start a new session", which is also its own command (**Write Handoff Note and Start Fresh…**).
- **Set your own auto-compact threshold** (**Set Auto-Compact Threshold…**, or **Auto-compact: … ▾** in the header). Presets for coding, research, long autonomous runs and saving money, each converted to the chat's window, with where it will actually compact, an estimated cost per call, how strong the evidence is, and a link to the reference guide. Applies to all projects (through `/autocompact` in an open chat, or `~/.claude/settings.json`) or only this project (`.claude/settings.local.json`); only the `autoCompactWindow` key is changed and a backup is kept. For Codex, it copies the `model_auto_compact_token_limit` line for you to paste.
- **Prompt cache countdown**, with reminders before a large idle chat's cache expires and when a large chat is closed. There is also a reminder to check your key rules after a compaction.
- **Context use against the auto-compact point**, with soft "Consider compacting" and "Handle soon" hints, and a one-character mark after each chat's title in the list (◔ consider, ◕ handle soon; the chat's tooltip explains it).
- **Percentages, windows and auto-compact points from Claude Code and Codex themselves.** The percentage uses Claude Code's own formula (context ÷ window). The window comes from Claude Code's cost record (so `[1m]` models count as 1M) or the Codex log. The auto-compact point comes from your settings, from where that model was measured to auto-compact, or from the official default, and the tooltip says which.
- **Compaction count** ("Compacted N×"), a hint to hand off to a new session after several compactions, and a warning when a chat may be stuck in a compaction loop.
- **Transcript line** under the chat's **Details**: where the chat is saved, how big its transcript, subagents and file backups are, and **Reveal in Finder** / **Copy Path**. Also available as **Reveal Transcript File** and **Copy Transcript Path** on the chat's right-click menu.
- **Storage Locations and Usage** page: sizes of Claude Code's and Codex's data folders, symbolic links, free disk space and `cleanupPeriodDays`, plus commands for moving the data to another disk (symbolic link, or `CLAUDE_CONFIG_DIR` / `CODEX_HOME`; `robocopy` and `mklink /J` on Windows). The extension only generates the commands and never runs them. The plans are marked as a reference only, and you have to tick a confirmation before you can copy them or put them in a terminal.
- **Details for each agent:** recent steps, final result, changed files and tool errors.
- **API-equivalent cost** for each agent, each chat and for today, estimated at list prices. For a Claude Code chat, the header shows Claude Code's own running total.
- **Usage limits:** Claude Code limit hits with their reset times, and Codex 5-hour and weekly usage.
- **Copy Resume Prompt…** for chats and agents stopped by a usage limit, an API error or an interruption, with an estimate of what resuming will cost.
- **"Follow the active chat":** switching to a Claude Code or Codex chat tab selects it in the list (`agentMonitor.followActiveChat`).
- **Interface in English, Simplified Chinese, Traditional Chinese, Korean and Japanese.** It follows the VS Code display language.
- **Terminal version** (`node bin/agent-monitor.js`, in the source repository). It reads both Claude Code and Codex and has `--watch`, `--json`, `--session`, `--provider`, `--lang` and more.

### Changed

- **Fixed order.** Chats are listed by start time (newest first) and agents by start time (oldest first). Nothing moves because of activity, status or token count.
- **Simpler scope.** The view scope is now `all` or `workspace` (`agentMonitor.scope`). The old `agentMonitor.onlyWorkspace` setting is migrated automatically.
- **Stable Sessions list.** Row text no longer changes every second, so tooltips stay open.
- **Narrow Agents table.** Below 700px, the first line of each agent now holds only its name and status, so sentences such as "Waiting for your approval" are no longer cut off; the context size moved to the second line with the step, cost and time.
- **Command Palette.** Compact, handoff and the auto-compact threshold can be run from the Command Palette (they ask which chat), and so can the storage page. Commands that need a chat row, such as Copy Resume Prompt, are no longer listed there.
- **Marketplace category.** The extension is now listed under **AI**.
- The `staleAsNeedsYou` setting from the private 0.2 builds is gone; `agentMonitor.approvalGuess` replaces it.
- **New name and license.** The extension ID is now `cyuneo.cyuneo-agent-monitor`, and it is released under the MIT License.

### Fixed

- After a usage-limit error, Claude Code's context size no longer drops to 0, and the chat is no longer shown as finished.
- After `/compact`, a Claude Code chat is no longer shown as "thinking" and then "no activity".
- A small but non-zero context now shows "<1%" instead of "0%".
- Resume hints no longer include a cost sentence when the context size is 0 or unknown.

## 0.2.0 - 2026-09-23

Private build, not published.

- Added the side bar tree view and a native-looking table in the bottom panel.

## 0.1.0 - 2026-09-23

Private build, not published.

- First version: the current step and token use of each Claude Code agent, including subagents and workflows.

[0.3.0]: https://github.com/cyuneo/cyuneo-agent-monitor/releases/tag/v0.3.0
