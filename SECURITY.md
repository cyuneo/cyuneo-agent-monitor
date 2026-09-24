# Security Policy

## Supported versions

Security fixes are made for the latest released version only.

| Version | Supported |
| --- | --- |
| 0.3.x (latest) | Yes |
| Earlier | No |

## Reporting a vulnerability

**Please don't report security problems in public issues.**

Use GitHub's private vulnerability reporting instead:

1. Open the repository's [Security tab](https://github.com/cyuneo/cyuneo-agent-monitor/security).
2. Choose **Report a vulnerability**. You can also go straight to [the report form](https://github.com/cyuneo/cyuneo-agent-monitor/security/advisories/new).
3. Describe the problem, how to reproduce it, and what an attacker could do with it.

Only the maintainer can see the report. Please don't include real conversation content from your session records; synthetic examples are enough.

## What happens next

This is a one-person project, so responses are best effort:

- You should get an acknowledgement within 7 days.
- The maintainer will keep you updated in the private report while a fix is prepared.
- The fix is released first, and the advisory is published after that. You'll be credited unless you prefer not to be.

## Scope

Examples of what's in scope:

- Any way the extension could send data over the network, or read files other than the ones listed in the README under "What it reads".
- The background compaction feature running a program, a model or arguments other than the ones you chose.
- Script injection into the extension's webview, or into VS Code through the text the extension displays.
- Opening or changing files without your action.

Out of scope: problems in Claude Code, Codex or VS Code themselves. Please report those to their vendors.
