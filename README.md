# CYUNEO Agent Monitor

**English** · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [한국어](README.ko.md) · [日本語](README.ja.md)

See all your AI coding chats in one place, next to your terminal: which agents are working, which ones need you, and how full each context is. Works with Claude Code, Codex and GitHub Copilot Chat, and, as a preview, Gemini CLI and Qwen Code.

[**Install in VS Code**](https://vscode.dev/redirect?url=vscode:extension/cyuneo.cyuneo-agent-monitor) · [View on the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=cyuneo.cyuneo-agent-monitor)

> **Preview (0.5.0).** Please report anything that looks wrong in [GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues).

![Animated demo of Agent Monitor in the VS Code panel, with made-up sample data: in a Claude Code chat running in a terminal, the main agent and two subagents step through reading files, searching, editing and running tests while tokens, cost and context percent climb. When a subagent wants to run the tests, its light and the main agent's turn magenta while they wait for approval, and the chat's light in the list, the panel badge and the status bar change with them. A double-click on the chat jumps to the terminal it runs in, where the command is approved. Back in the panel, every agent finishes with a green light. Last, Usage History is opened from the panel's … menu](images/demo.gif)

## Why I built it

Claude Code and Codex now run several agents at once: subagents, background agents, whole workflows. In VS Code, most of that work is invisible:

- **You can't see who is doing what.** The agent view only appears when you open it, so an agent waiting for your approval can sit there unnoticed.
- **Context fills up quietly.** You find out when auto-compact starts at a bad moment, or when a long chat starts forgetting things.
- **The cache runs out while you're away.** Come back after an hour and the next message re-reads the whole context at full price.
- **Usage limits stop work halfway.** Agents stop, and you have to notice, wait for the reset and restart them yourself.

## What it does for you

- **Every chat at a glance.** A panel next to the terminal lists every open and recent chat with a status light. Click one to see its agents, the step each one is on, and its tokens and cost.
- **Jump straight to it.** Click **Go to** or double-click a chat, and Agent Monitor brings up where it is running: the chat in the Claude Code or Codex extension or in Copilot Chat, or the VS Code terminal it runs in, even in another VS Code window (on macOS, also a Terminal.app or iTerm2 tab).
- **Know when you're needed.** A chat waiting for your approval or answer gets a magenta light. Finished and failed chats have their own colors, in the status bar too.
- **Get notified, even away from your desk.** When a chat starts waiting for you, VS Code or your system tells you, with a sound if you like. A short message can also go to your phone or team chat (ntfy, Bark, ServerChan, Feishu, DingTalk, WeCom, Telegram, Discord or Slack), for errors and usage limits too. Set quiet hours, and it all stays silent at night.
- **Hear about it before you run out.** Get an alert when Codex usage reaches 90% and, if you turn them on, when today's estimated cost passes your budget or a chat's context gets close to auto-compact.
- **Keep context under control.** See how full each chat is, compact it from the panel (with a cheaper model if you like, after seeing a cost estimate), choose when auto-compact happens, and get a reminder before the cache expires.
- **Carry on after a usage limit.** See when the limit resets, and copy a ready-made prompt or command to resume.
- **See your usage over time.** A usage history page shows estimated cost and tokens per day for Claude Code and Codex over the last 30 days, also by model.
- **Know where your chats are stored.** See how much space Claude Code and Codex chats take, with reference commands for moving them to another disk.

It only reads the records the supported tools already write on your computer, and collects no data. The extension makes no network requests unless you turn on **Allow network access** (off by default); today only push notifications use it.

## Supported tools

- **Claude Code** and **Codex**, in the VS Code extension, the command line or the desktop app, including their subagents.
- **GitHub Copilot Chat**: VS Code's built-in chat, agent mode included.
- **Gemini CLI** and **Qwen Code**, as a **preview**. Support for them is built from their published record formats and hasn't been checked against real sessions yet. If something looks wrong, please report it in [GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues).

Tools that aren't installed are skipped, and each one can be turned off in the settings. What the extension can see differs between tools: for example, Copilot Chat shows Copilot credits instead of a dollar cost, and Gemini CLI's states are guesses. Compacting, usage history, today's total cost and the storage page cover only Claude Code and Codex. Details: [Supported tools](docs/GUIDE.md#supported-tools) in the full guide.

## Get started

1. Click **Install in VS Code** above, or search for **CYUNEO Agent Monitor** in the Extensions view.
2. Open the **Agent Monitor** tab in the bottom panel, next to Terminal.
3. Click a chat in the list to see its agents.

Every feature, command and setting is explained in the **[full guide](docs/GUIDE.md)**.

## Requirements

- VS Code 1.94 or later.
- At least one supported tool, used on the same computer: Claude Code or Codex (VS Code extension, command line or desktop app), GitHub Copilot Chat in VS Code, Gemini CLI or Qwen Code.
- To compact a closed chat in the background, you also need the Claude Code command line. The extension looks for `claude` on your PATH, then in the installed Claude Code extension. You can also set `agentMonitor.claude.cliPath`.
- The automated tests run on macOS, Windows and Linux (Node.js 22, and also Node.js 20 on Linux). Hands-on testing inside VS Code has only been done on macOS so far.

## Privacy

- No telemetry, and no network requests unless you turn on **Allow network access** (off by default); today only push notifications use it. Your conversations stay on your computer.
- Push notifications are optional and off by default. When you turn them on, only a short message goes to the services you set up: the project folder name and the state, plus the chat title and subagent names if you allow them. Nothing else ever leaves your computer.
- The usage history is worked out on your computer, and sounds are played by your own system. Neither sends anything anywhere.
- **Go to** looks at the running processes on your computer only when you use it, to find where a chat runs. It doesn't read your chats for this and sends nothing anywhere.
- It changes a file or runs Claude Code only after you confirm (see [Disclaimer](#disclaimer)).
- Details: [What it reads](docs/GUIDE.md#what-it-reads) and [Privacy](docs/GUIDE.md#privacy) in the full guide.

## Unofficial

CYUNEO Agent Monitor is an independent, unofficial project. It is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, GitHub, Microsoft, Google or Alibaba. Product names are the property of their respective owners and are used here only to describe what the extension works with.

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
- **Follow the services' terms.** You are responsible for using the AI coding tools you monitor and their services, and any push service you set up, in line with their terms.
- **Not professional advice.** The context and compaction tips summarize published sources and may be out of date.

## Copyright and trademarks

- © 2026 Chenyu Guo. All rights not expressly granted by the license are reserved.
- Developed by Chenyu Guo with AI assistance (mainly Claude Code). The idea, requirements and design decisions are the author's, and the author reviewed the results.
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