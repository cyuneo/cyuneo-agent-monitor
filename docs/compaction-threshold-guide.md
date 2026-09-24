# Choosing an auto-compact threshold: reference notes

**English** · [简体中文](compaction-threshold-guide.zh-CN.md)

> Research date: 2026-09-24. Every number comes with a source; where nothing could be found, the text says "not found".
> "Compaction" here means: when the context is nearly full, the earlier conversation is summarized into a short summary to free up space.
> Percentages use the **whole model window** as the denominator unless stated otherwise.

---

## 1. The short answer

**No vendor or paper gives a standard answer such as "X% for research, Y% for coding."** Only two things are certain. On a model with a 1M window, moving the compaction point from the default of about 967K down to 200K–400K saves about 45–59% per call under the cost model below, at the price of 3–7 times as many compactions, and every compaction loses information. On a model with a 200K window, lowering the threshold saves almost nothing, so the only reason to lower it there is quality.

---

## 2. Where each tool compacts by default

| Tool | Default compaction point | Configurable? | Stated rationale | Source |
|---|---|---|---|---|
| **Claude Code** | About **967K** (96.7%) on 1M-window models; at the **200K boundary** on 200K-window models | Yes: `/autocompact`, `autoCompactWindow` (100K–1M), `--autocompact`, and the environment variable `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (highest priority). There is also `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1–100%, with the compaction window as the denominator; it can only lower the point) | The /autocompact dialog describes auto as tuned per model and strongly recommended for cost and performance (in-product copy found in v2.1.278; the public docs don't have it). Recent releases have kept pushing the default later: v2.1.247 moved it from about 934K to about 967K; v2.1.260 made Opus/Fable compact only near 1M; v2.1.273 fixed "compacting at about half the window" as a bug | https://code.claude.com/docs/en/model-config ; https://code.claude.com/docs/en/env-vars ; https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md |
| **Codex CLI** | **90%** of the window. The default window is 272K, so about **244,800** | Yes: `model_auto_compact_token_limit`, which can only lower the point; anything above 90% is capped | The docs only say "unset uses model defaults"; the 90% comes from the source code, `min(user value, window×9/10)` | https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs |
| Gemini CLI | **50%** (lowered from 70% for API key users on 2025-11-20); keeps the most recent 30% after compaction | Yes | The PR only says it makes compaction trigger earlier | https://github.com/google-gemini/gemini-cli/pull/13517 |
| Qwen Code | **85%** (**raised** from 70%) | Yes: `context.autoCompactThreshold` | At 70%, a 1M model still has about 300K left, while the summary plus output needs only about 33K, so it compacted too early | https://github.com/QwenLM/qwen-code/blob/main/docs/design/auto-compaction-threshold-redesign.md |
| GitHub Copilot CLI | Starts background compaction at 80%; pauses and waits at 95% | Not documented | Leaves about 20% headroom so tool calls can continue while compaction runs | https://docs.github.com/en/copilot/concepts/agents/copilot-cli/context-management |
| VS Code Copilot Chat | About 80% with a warm cache (floating between 0.78 and 0.82), ≥90% with a cold cache, foreground compaction on overflow | No (internal settings exist but aren't exposed to users) | The official docs only say "when the window is full"; the numbers come from a blog post that reads the source | https://alexop.dev/posts/how-vscode-copilot-chat-conversation-compaction-works/ (2026-09-23) |
| Cline | About **81%** of the window (90% of the usable input budget) | Not verified | The docs give no number. The widely repeated "70%" is out of date | https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/context/compaction-shared.ts |
| Goose | **80%** | Yes: `GOOSE_AUTO_COMPACT_THRESHOLD`; 0 turns it off | Not stated | https://goose-docs.ai/docs/guides/sessions/smart-context-management/ |
| Zed | **90%** | Yes: as a percentage, tokens used or tokens remaining; it can also be turned off | Not stated | https://zed.dev/docs/ai/agent-settings |
| Roo Code | Slider defaults to 100% (a third-party article says it actually triggers at about 86–92%; not verified) | Yes | Left to the user | https://roocodeinc.github.io/Roo-Code/features/intelligent-context-condensing |
| Kilo Code | With no percentage set, compacts when free space drops below a 20K buffer | Yes: `threshold_percent` 1–100 | Makes sure the compaction request itself doesn't fail | https://kilo.ai/docs/customize/context/context-condensing |
| Aider | Manages chat history only: 1/16 of the input window (1K–8K, about 6%) | Yes | Not stated | https://github.com/Aider-AI/aider/blob/main/aider/models.py |
| OpenHands | Counts events: at 120 events it condenses down to about 60, keeping the first 4 | Yes | Keeps the setup at the start and the most recent events | https://docs.openhands.dev/sdk/arch/condenser |
| Amp | **No auto-compaction**; switched to manual Handoff in 2025-10 | — | Compaction is lossy, and whether the summary keeps what you need depends on the agent; compaction also makes threads drag on and lose focus | https://ampcode.com/news/handoff |
| Cursor | No published percentage. A staff member replied on the forum that it triggers when the current window gets close to the top | No | Early triggering usually means directories such as node_modules were pulled into the context | https://forum.cursor.com/t/context-keeps-summarizing-at-10-20-of-total-context-window/163850 (2026-06-22) |
| Windsurf, opencode | **No reliable number found.** For opencode there are two third-party claims that contradict each other | — | — | — |

**The pattern:** defaults range from about 6% (Aider) to 100% (Roo), and most sit between 80% and 90%. Recent changes don't point the same way either: Gemini moved earlier (70%→50%), while Qwen and Claude Code moved later (70%→85%, 934K→967K). The industry has **no agreed optimal percentage**.

---

## 3. Where vendors compact when running benchmarks

### Research / retrieval

| Who | Model and window | Compaction point | Result | Source |
|---|---|---|---|---|
| Anthropic (Opus 4.6 launch post, 2026-02) | Opus 4.6 | BrowseComp: triggers at **50K**, total budget 10M; HLE: triggers at 50K, total budget 3M | Top score at the time | https://www.anthropic.com/news/claude-opus-4-6 |
| Anthropic cookbook (2026-06-25) | Newer models | BrowseComp: triggers at **200K**, total budget 3M; DeepSearchQA in the latest model card runs without compaction (it fits in the 1M window) | The lower the trigger, the more likely the original question is lost after compaction (a single question may be compacted several times); at 200K this is less of a problem | https://platform.claude.com/cookbook/evals-agentic-search-reproduce-agentic-search-benchmarks |
| DeepSeek-V3.2 (2025-12) | 128K window | Triggers when usage reaches **80%** of the window (about 102K) | No management 51.4 → summarization 60.2 (taking 364 steps) → simply discarding all old tool results **67.6** | https://arxiv.org/html/2512.02556 |
| Kimi K2.5 (2026-02) | 256K window | Discard-all triggers at **80%** of the window; HLE triggers at 96K | BrowseComp 60.6 → **74.9** | https://huggingface.co/moonshotai/Kimi-K2.5/discussions/13 (explanation from a Moonshot employee), arXiv 2602.02276 |

### Coding

| Who | Setup | Result | Source |
|---|---|---|---|
| JetBrains, *The Complexity Trap* (2025-08, SWE-bench Verified, Qwen3-Coder 480B) | Keeps only the last **10 turns** of tool output and drops anything older | 54.8% solved at $0.61 per task; no management 53.4% at $1.29; LLM summarization (triggered at 31 turns) 53.8% at $0.64; keeping 20 turns did worse | https://arxiv.org/html/2508.21433v3 |
| OpenHands blog (2025-04-04) | Context condensation (the post gives no trigger threshold) | Solve rate 53% → 54%, cost per turn cut by more than half | https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents |
| arXiv 2609.20804 (2026-09-17) | Four window budgets: 32K/64K/96K/128K | The gap between "managed" and "unmanaged" shrinks from 35.7 points to 2.7 points; most of the gain comes from avoiding overflow truncation | https://arxiv.org/html/2609.20804 |
| Claude API defaults (vendor-doc, not a benchmark) | Context editing clears old tool results at 100K and keeps 3; API compaction triggers at 150K by default, minimum 50K | The docs say the right value depends on how your agent uses tool results, and suggest trying several configurations | https://platform.claude.com/docs/en/build-with-claude/compaction-threshold |

**What this shows:** research benchmarks generally **compact early and discard aggressively** (50K–200K, or 80% of the window), because raw web pages are useless once the findings have been extracted. Coding studies care more about **keeping the raw output of the last few turns**, yet coding tools set their defaults very late (90%–96.7%). **Keep in mind that benchmark configurations are tuned for scores; they are not advice for interactive use.** Anthropic itself moved its BrowseComp trigger from 50K to 200K, precisely because compacting too early loses the original question.

---

## 4. What bloggers and practitioners say

| Who | Recommendation | Task type | Data? | Source |
|---|---|---|---|---|
| **langwatch / Rogerio Chaves** (2026-08-02) | PR-driven work 200–250K; **research 250–300K**; QA 250–350K; **building/understanding code 300–450K**; cost optimum about 220K (anything from 170K to 316K is within 10% of it) | Per task type | **Yes**: 162 days, 2,451 sessions, 873 compactions; the correction rate within 5 steps after a compaction rose from 17.7% to 41.9%. **Limitations**: data from the author alone; observational, not an experiment; research sessions rarely went past 150K, so the research band is extrapolated; the post doesn't say which model was used; the figures are absolute token counts, not percentages | https://langwatch.ai/blog/context-tax-when-to-compact |
| HumanLayer / Dex Horthy (around 2025-08) | Keep context utilization at **40–60%** and compact proactively and often | Coding (research → plan → implement) | No experiment; a rule of thumb | https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md |
| Dex Horthy interview (Pragmatic Engineer, 2026-07-15) | Go up to **300–400K** on 1M models; stop at about **100K** on 200K models | Coding | None. The widely quoted "the dumb zone starts at 40%" and "based on 100K+ sessions" don't appear in the interview | https://newsletter.pragmaticengineer.com/p/context-engineering-with-dex-horthy |
| WorkOS / Mitch Fultz (2026-08-14) | 320K window with 64K reserved; compact at about 256K (80%) | Coding | None. The author himself calls it an engineering hypothesis you need to validate against your own workload | https://workos.com/blog/coding-agent-context-window-compaction-settings |
| LangChain deepagents (2026-03-11) | Trigger at 85%, keep the most recent 10% | Coding (not "research only") | No threshold comparison. The main argument is to let the model decide when to compact | https://www.langchain.com/blog/autonomous-context-compression |
| Hermes (mem0 blog, published 2026-05-14, updated 09-15) | Main compaction at 50%, with 85% as a fallback | General | A two-tier engineering design, not tuned per task | https://mem0.ai/blog/how-hermes-and-claude-handle-context-compression-in-real-production-agents-(and-what-you-should-extract) |
| mindstudio (2026-07-09) | 70–75% for general tasks, 60–70% for complex reasoning | General | None. The post says "research shows" but cites nothing | https://www.mindstudio.ai/blog/context-rot-ai-agents-auto-compact-fix |
| nathanonn (2026-05-01) | Compact manually at 50–60% and start over above 60%; on 1M Opus, start over at 15–20% | Coding | One personal experience of the author's | https://www.nathanonn.com/claude-code-never-auto-compact/ |
| howdoiuseai (2026-04-16) | About 60% | General | None | https://www.howdoiuseai.com/blog/2026-04-16-what-does-compact-do-in-claude-code-context-management |
| **The widely shared "Anthropic's Thariq recommends 50–60%"** | — | — | **No source found.** Thariq's post on the official Anthropic blog (2026-04-15) contains no percentages at all. It only says the 1M window gives you more time to /compact proactively, and that the model is at its least intelligent at the moment it compacts. The 50–60% first shows up on albertsikkema.com (2026-04-23) and is a misattribution | https://claude.com/blog/using-claude-code-session-management-and-1m-context |
| badlogic gist (2025-12-02) | Finds the default 95% too late and suggests 85–90% | Coding CLI | None | https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f |
| Geoffrey Huntley (2025-04-07) | Claude 3.7 is rated at 200K but starts to degrade at 147–152K; argues against compaction: start a new session instead and keep state in a spec file | Long autonomous loops | Personal observation, on a model that is now outdated | https://ghuntley.com/redlining/ |
| Anthropic, *Effective context engineering* (2025) | **No numbers**: compaction for long back-and-forth conversations, note-taking for milestone-driven development, multiple agents for complex research | Splits scenarios by technique, not by percentage | — | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |

**Assessment:**
- **langwatch is the most useful reference.** It is the only post that gives numbers per task type backed by real data, but the data come from one person and the research band is extrapolated.
- The "40–60%" going around online mostly traces back to HumanLayer's rule of thumb and retellings of it. **The "50–60%" credited to Anthropic doesn't hold up**; don't put it in product copy.
- Most of these percentages date from the 200K-window era. Tests on older models collected by agentpatterns suggest that performance starts to drop at something closer to an **absolute token count** (about 32K–100K) than a percentage (https://agentpatterns.ai/context-engineering/context-window-dumb-zone/ ). The same 50% means something entirely different on a 200K model and on a 1M model, so the extension is right to work in token counts.

---

## 5. What the research experiments show

**The cost of compacting late (high threshold)**
- The longer the context, the more mistakes the model makes. Chroma, *Context Rot* (2025-07); on MRCR v2 8-needle, going from 128–256K to 512K–1M, Opus 4.6 drops from 91.9% to 78.3% and GPT-5.4 from 79.3% to 36.6% (results from our previous round of research).
- langwatch's data: above 600K of context, only about 2.5% of the content is actually used; below 50K the share is 47.5%.
- Every call rereads the whole context, so the higher the threshold, the more each call costs; see section 6.

**The cost of compacting early (low threshold)**
- Compaction is lossy. Lost in Compaction (2026-07): on average only 17% of in-session constraints survive; arXiv 2608.01326: verbatim information is almost entirely lost (results from our previous round of research). The lower the threshold, the more compactions there are, and the losses add up.
- ACON (arXiv 2510.00615) ran a threshold ablation: smaller thresholds save more tokens but mean more compactions and lower accuracy. Its thresholds are tiny absolute values such as 4096/1024, so they don't carry over directly to Claude Code.
- Anthropic cookbook: the lower the trigger, the more likely the "original question" is lost after compaction.
- langwatch: the correction rate within 5 steps after a compaction is 2.37 times the usual rate, and it still hasn't fully recovered after 120 steps.
- A threshold too close to the "startup context size" leads to repeated compaction. Claude Code issue #61351: with the threshold at about 70%, plus a large CLAUDE.md and memory files, it compacted almost every turn and spent about $9.18 in 58 minutes (https://github.com/anthropics/claude-code/issues/61351 ).

**Some counterintuitive findings**
- Compaction doesn't necessarily lower scores. With compaction, OpenHands went from 53% to 54% solved; JetBrains' "keep only the last 10 turns" beat no management at less than half the cost.
- In research tasks, **what you do** with old context matters more than **when** you trigger. DeepSeek and Kimi both trigger at 80%, and simply discarding old search results scores much higher than summarizing them (67.6 vs 60.2).
- **Timing** matters more than **ratio**. Self-Compacting LM Agents (arXiv 2606.23525) found that triggering at a fixed token count can throw away intermediate results in the middle of reasoning; letting the model pick its own moment did no worse than fixed intervals and cost 30–70% less per task.
- The larger the window, the smaller the accuracy gain from context management (arXiv 2609.20804: the gap shrinks from 35.7 points to 2.7 points).

**What's missing:** no paper has directly measured what happens when "Claude Code / Codex compacts at X%". The level recommendations below are therefore **inferred from indirect evidence**, not experimental findings.

---

## 6. The cost math (our own model)

### Assumptions
- Prices are for **Opus 5.5**, checked against Anthropic's official SDK material: input $4, output $20, cache read $0.20; a 1-hour cache write is 2 times the input price, i.e. $8. All prices are per million tokens.
- **The cache stays warm**: calls are never more than 1 hour apart, so the 1-hour cache applies.
- On each call, the whole previous context is billed as cache reads, and about 3K of new tokens are billed as 1-hour cache writes. Output from normal replies costs the same at every level and doesn't affect the comparison, so it's left out.
- About 30K remains after a compaction, and each call adds 3K until the compaction point is reached.
- Cost of one compaction = reading the current context once at the cache-read price + summary output (4% of the compaction point, clamped to 2K–20K) + rewriting the remaining 30K into the cache afterwards.
- The compaction cost is spread evenly over every call in that cycle.

### Results

| Compaction point | Calls per cycle | Average context | Per call: reread context | Per call: write new content | Cost of one compaction | Amortized per call | **Total per call** | vs default | Compactions per 100 calls |
|---|---|---|---|---|---|---|---|---|---|
| **967K** (1M default) | 312 | 497K | $0.099 | $0.024 | $0.83 | $0.003 | **$0.126** | 100% | 0.3 |
| **500K** | 157 | 264K | $0.053 | $0.024 | $0.74 | $0.005 | **$0.081** | 65% | 0.6 |
| **300K** | 90 | 164K | $0.033 | $0.024 | $0.54 | $0.006 | **$0.063** | 50% | 1.1 |
| **200K** | 57 | 114K | $0.023 | $0.024 | $0.44 | $0.008 | **$0.055** | 43% | 1.8 |

For example, a 600-call session (a few hours of coding) costs about **$75.6** with 2 compactions at 967K; about $48.9 with 4 compactions at 500K; about $37.6 with 7 compactions at 300K; and about **$32.7** with 11 compactions at 200K.

### What the table tells us
1. **The money goes mostly to rereading the whole context on every call; compaction itself is cheap.** One compaction costs at most about $0.83, which is less than 1 cent per call once amortized.
2. **Going lower pays off less and less.** Every call carries a fixed write cost of about $0.024, so below about 200K there is almost no further saving (about $0.051 per call at 100K), while the number of compactions keeps multiplying.
3. **Lowering the threshold on a 200K-window model saves almost nothing.** The default already compacts at about 167K; moving it to about 127K saves only about 3% per call.
4. **Step away for more than 1 hour and the cache goes cold.** The first call after you return rewrites the whole context at $8/M: about $3.98 at an average context of 497K, about $0.91 at 114K. If you often leave in the middle of a session, a low threshold saves more.
5. **Adding rework cost doesn't change the conclusion.** Suppose each compaction is followed by 5 extra calls and 20K of files read back in (about $0.32 per compaction): the 200K level then comes to $0.060 per call, still about half of the default. At the 100K level, though, the cost starts to climb again ($0.065).
6. This order of magnitude matches langwatch's figure from real bills, "about 2.3 times the optimum when close to 1M" (our 967K vs 200K is also 2.3 times).
7. **Codex** has a default window of only 272K, so lowering 90% to 80% or 70% saves only about 7–14% by a rough estimate. What Codex really needs to avoid is the long-context surcharge above 272K; see section 7.

### What the official line "Overriding auto may result in high token usage, especially when resuming long sessions" might refer to

**The docs don't explain this line; everything below is speculation.** Under the steady-state model above, a lower threshold makes each call cheaper, so the line more likely refers to one of these cases:
- **Resuming an old session that is larger than the threshold.** Say a session grew to 600K under the default settings, you then set the compaction window to 300K, and you resume the session the next day. The cache expired long ago, and the moment you resume, the session is over the threshold and compacts right away: 600K at the uncached input price of $4/M is $2.40, and with the summary and the rewrite it comes to about $3. The official prompt-caching docs do say "This is why /compact costs the most when you resume an old session" (https://code.claude.com/docs/en/prompt-caching ). But this step on its own isn't necessarily more expensive than auto: without compaction, resuming 600K also means rewriting the cache (about $4.8 for a 1-hour write). If Claude Code first sends a normal request and only then notices it is over the threshold and compacts, you pay both (about $5.6). We couldn't find out how it is actually implemented.
- **Repeated compaction**: a threshold set too close to the startup context leads to what issue #61351 describes, with compaction on almost every turn.
- **Rework after compaction**: the summary dropped details, so the model has to reread files and redo work.
- **"Token usage" may mean token counts**, such as a subscriber's usage allowance, rather than dollars. We couldn't find how the allowance is calculated.

---

## 7. How to choose

| Level | 1M-window model (set to → compacts at about) | 200K-window model | Codex (default 272K window) | Who it suits | Trade-off (cost from the section 6 model) | Strength of evidence |
|---|---|---|---|---|---|---|
| **Keep the default (auto)** | Not set (about 967K) | Not set (200K boundary) | Not set (90%, about 245K) | People who don't want to think about it; people who often resume long sessions from long ago; setups with a large startup context | Most expensive per call on 1M models (about $0.126); the model may get sluggish late in the context | **Strong**: vendor default, officially strongly recommended |
| **Coding (balanced)** | 400K → about 367K | 200K (same as default) | 0.9 (same as default) | Everyday coding, reading code, fixing bugs | About $0.069 per call, about 45% less than the default; about 2.8 times as many compactions as the default | **Medium**: langwatch data (building/understanding code 300–450K) plus practitioner experience (going up to 300–400K on 1M); no controlled experiment |
| **Research / retrieval** | 250K → about 217K | 160K → about 127K | 0.8 → about 218K | Heavy searching and reading of web pages and docs, keeping only the conclusions | About $0.056 per call, about 56% less; about 5 times as many compactions as the default; the original question is more easily lost, so write it into a file | **Medium**: Anthropic's own search benchmarks trigger at 200K; DeepSeek and Kimi trigger at 80% of the window; langwatch's research band is 250–300K (beyond what its data cover) |
| **Long autonomous runs** | 600K → about 567K | 200K (same as default) | 0.9 (same as default) | Unattended tasks that run for hours | About $0.088 per call, about 30% less; only about 1.8 times as many compactions as the default | **Weak**: a reasoned compromise with no direct evidence. What really makes the difference is writing goals and constraints into files |
| **Budget first** | 200K → about 167K | 200K (same as default; lowering it saves nothing) | 0.8 → about 218K | Budget-conscious users with short, independent tasks | About $0.052 per call, about 59% less, with almost no further saving below this; about 7 times as many compactions as the default and the most information loss | **Medium**: the cost model plus langwatch's cost optimum (about 220K) |

**If you're not sure which to pick:** if you mostly write code, choose "Coding (balanced)"; if you mostly look things up, choose "Research / retrieval"; if you often resume long sessions the next day, or have a large CLAUDE.md and many MCP tools, keep the default.

### Things to know before you change it
1. **What you set is the "compaction window"; the actual compaction happens a little earlier.** The official changelog states that a 1M window compacts at about 967K, a gap of about 33K (said to be 20K reserved for the summary plus a 13K buffer, but that breakdown is second-hand). The docs don't say whether custom values also compact 33K early, so the "compacts at about" figures in the table above are estimates.
2. **The status line's used_percentage always uses the whole model window as its denominator.** Once you set a compaction window, that percentage no longer tells you how close you are to compaction (per the env-vars docs).
3. **Don't set it too close to your startup context.** If CLAUDE.md, MCP tool descriptions and memory files take up tens of thousands of tokens from the start, the context fills up again soon after each compaction and you end up compacting over and over. Our own rule of thumb (not an official one): the compaction point should be at least 3 times the "size left after compaction".
4. **Two things that help more than tuning the number:** run `/compact` yourself between tasks so auto-compaction doesn't fire in the middle of one (the official prompt-caching page recommends this too); and write goals, constraints and progress into files (a plan file, CLAUDE.md) so they can be read back if compaction drops them (this is Anthropic's note-taking approach, and the same idea as Huntley's and Manus's).
5. **Codex:** the default window is 272K. If you have manually enabled a larger window (up to 872K), recompute the ratio against the new window. There are also reports that once input exceeds 272K, GPT-5.6 bills input at 2 times and output at 1.5 times the normal price (AI Weekly, 2026-07-19, https://aiweekly.co/alerts/openai-codex-cuts-gpt-56-context-window-from-372k-to-272k ), so with a large window it's cheaper to keep the compaction point below 272K.
6. **Subscribers (Pro/Max):** the dollar figures above assume pay-as-you-go API pricing. We couldn't find how subscription allowances map to tokens; all we can say is that the general direction should be the same.
