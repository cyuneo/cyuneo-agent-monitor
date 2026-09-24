# How context compaction affects model performance: research findings

**English** · [简体中文](research-context-compaction.zh-CN.md)

> Research date: 2026-09-24. The examples below use Claude Code (Claude Opus 5.5, 1M window, auto-compacts at about 967K by default) and Codex (about 272K window). "Strong/medium/weak" below refers to the strength of the evidence; "second-hand" means we didn't get hold of the original source.

---

## 1. The short answer

Both of your concerns are valid: models really do get gradually worse as the context grows, and every compaction really does lose details, with the risk growing the more often you compact. So neither "compact all the time" nor "let it pile up and ignore it" is right. A better approach:
- Write rules and progress into files;
- Within a single task, compact once at a natural break, saying what to keep;
- When you switch tasks, or after several compactions, start a new session.

For the 1M-window Opus 5.5 you're using, there's basically nothing to manage below 200K tokens. That number is an inference: Opus 5.5 itself has no published long-context data.

---

## 2. Direct answers to your two questions

### 2.1 Does capability drop as the context grows?

**Yes, this is real, and the vendors admit it.**
- Anthropic's engineering blog (2025-09-29) explains why: attention has to be spread over more and more tokens, and long texts are scarce in training data, so performance slides gradually as length grows instead of suddenly getting worse at some point.
- When Anthropic released Opus 4.6 (2026-02-05), it said outright that "context rot" is a common user complaint.
- The Claude API docs say "response quality degrades as a conversation grows".

The reports you saw were most likely about Chroma's *Context Rot* (2025-07-14). It tested 18 models (Claude Opus 4 / Sonnet 4, GPT-4.1, o3, Gemini 2.5, Qwen3 and others) and concluded that performance starts to drop long before the window is full; that lookups requiring an understanding of meaning degrade faster than lookups for exact words; and that the more irrelevant but similar content (distractors) there is, the worse it gets.

**Where does it start? That varies a lot by model and task.**
- **Older models drop early.** NoLiMa (ICML 2025) tested 13 models (GPT-4o, Gemini 1.5, Llama 3.3 and others). On tasks where the question and the answer share no literal wording, 11 of them fell below half of their short-context score at 32K, and GPT-4o went from 99.3% to 69.7%.
- **Newer models are much better, but the problem hasn't gone away, and it can regress from one version to the next.** The table below is MRCR v2 8-needle, a test designed around long conversations full of similar passages, where the model has to find the specific one it's asked for:

| Model | 128K–256K | 512K–1M | Source |
|---|---|---|---|
| Opus 4.6 | 91.9% | 78.3% | Opus 4.7 System Card (2026-04) |
| GPT-5.4 (xhigh) | 79.3% | 36.6% | Same |
| Gemini 3.1 Pro | 59.1% | 25.9% | Same |
| Opus 4.7 (max) | 59.2% | 32.2% | Same (a regression from 4.6) |
| GPT-6 Astra | 100% (256K–512K) | 96.3% | Self-reported by OpenAI, second-hand |

   From 200K to 1M, most models lose 14–43 percentage points. **Opus 5.5, which you're using, has no published scores of this kind, and neither do Opus 5 or Sonnet 5.** Since Opus 4.7 also regressed once, you can't assume that newer models cope better with length.
- **New 2026 research adds one point** (arXiv 2608.03297, 2026-08): for top models such as Opus 4.7 and GPT-5.5, removing only the irrelevant content while keeping the useful information doesn't raise their scores, because they're already at the ceiling; small models (Haiku 4.5, Sonnet 4.6) improve noticeably once irrelevant content is removed; but cutting a random chunk out of the middle breaks every model. In other words, for top models **what really hurts is losing useful information, not length itself**.
- **The often-cited "Lost in the Middle"** (content in the middle gets overlooked) is a 2023 paper that tested older models such as GPT-3.5, with contexts of only about 4K tokens. In 2025 Chroma tested 11 positions on newer models and saw no clear difference. Don't treat it as a rule for today's models.

**In multi-turn agent conversations (your everyday use of Claude Code and Codex), the problem takes a different form:**
- Laban et al. (ICLR 2026, 15 models including o3, GPT-4.1, Claude 3.7 Sonnet and Gemini 2.5 Pro) found that multi-turn conversations are on average 39% worse than single-turn ones. Of that, aptitude itself fell by only 16%, while unreliability rose by 112%. The main cause is that the model makes wrong assumptions early and then finds them hard to correct. The key finding: **gathering all the information into one complete instruction and asking again brings performance back to 95.1% of single-turn**.
- LongFuncEval (2025-04) found that as the number of tools, the length of tool outputs and the number of turns grow, function-calling accuracy drops by 7–85%, 7–91% and 13–40% respectively.
- Anthropic also names tool outputs that have already been used but are still sitting in the context as a main source of context rot.
- Cognition (2025-09) found that Sonnet 4.5 shows "context anxiety": when it believes it's nearly full, it starts cutting corners and leaving work unfinished.

**So in Claude Code, what actually drags you down is usually three things:** piles of old file reads and test logs, wrong directions taken early on, and rules that were stated but got buried. The raw token count matters less.

### 2.2 Isn't compacting all the time bad too?

**Yes. Compaction is always lossy.** Anthropic's 1M GA blog post calls compaction "lossy summarization" outright. The Codex source also carries a warning: "long threads and multiple compactions can cause the model to be less accurate".

**What a single /compact loses (Claude Code official docs):**
- **Kept (in the summary):** your requests and intent, key technical concepts, files viewed or changed and important code snippets, errors and their fixes, to-dos, the current work.
- **Reloaded from disk:** CLAUDE.md in the project root, rules without `paths:`, auto memory, plans written in plan mode, and SessionStart hooks that match compact. It also rereads up to 5 recently edited files; for files over 5K tokens, only the path is included. The bodies of skills you've used are injected again too, up to 5K each and 25K in total; past that, the oldest are dropped first, and truncation keeps the beginning.
- **Dropped:** raw tool output, intermediate reasoning, the skill list, rules with `paths:` and CLAUDE.md files in subdirectories, detailed instructions from early in the conversation.

**How bad the loss is (new 2026 research and first-hand cases):**
- **Verbatim information is almost entirely lost.** arXiv 2608.01326 (2026-08) put 15,000 URLs (about 500K tokens) into Opus 4.8's context. Without compaction the lookup error rate was 0.02; after compacting with Anthropic's compaction endpoint it was about 0.5, no better than guessing.
- **Constraints you mention in passing during the conversation are the most likely to be lost.** *Lost in Compaction* (2026-07-31) found that compactors keep on average only 17% of in-session constraints (for example, "ask me before deleting email"), and after compaction most compactors did worse on compliance than no compaction at all. This paper didn't test the Opus/GPT flagships.
- **The rule is still there, but the model stops following it.** Claude Code issue #95745 (2026-09-20, Opus 4.8 and Opus 5, reproducible): after compaction CLAUDE.md was still in the context, but its "don't commit on your own" rule was broken. So far there is only this one reporter and no official response.
- **The model treats the summary as authoritative.** Page 112 of the Opus 4.7 System Card records a case where a tampered compaction summary presented a dangerous command as "established practice", and the model went ahead and ran it.

**But compaction isn't always bad:**
- Anthropic's own search benchmarks **trigger compaction as early as 200K** (BrowseComp for Opus 4.7 and Opus 5), use compaction to stretch the total to 10 million tokens, and score 79.3%.
- JetBrains (2025) ran SWE-bench tests (with Qwen3 and Gemini 2.5 Flash, no Claude or GPT): just clearing old tool output halved the cost without lowering the solve rate, while LLM-written summaries made trajectories 13–15% longer.
- Anthropic's context editing (clearing stale tool results) improved an internal search benchmark by 29%, and by 39% combined with memory. The models used weren't disclosed.

**The pattern, in one sentence:** when compaction throws away things you won't need again (old logs, search results you're done with), it pays off; when it throws away things you'll need word for word later (exact paths, raw error messages, constraints), it costs you.

**Does repeated compaction get worse each time?**
- **No study has plotted how much is lost after the Nth compaction; we found nothing on this.**
- The indirect evidence all points toward the losses accumulating:
  - The second compaction is a summary of a summary;
  - The Codex source has its own warning about multiple compactions;
  - Codex issues include reports of compaction loops, progress jumping back from 97% to 42% (#25792), and redoing finished work until a week's quota ran out (#35935, GPT-5.6 Sol), each from a single user;
  - The ACE paper has an example of collapse after rewriting the whole memory: 18,282 tokens were compressed to 122 tokens, and accuracy fell from 66.7 to 57.1, below the unmanaged baseline of 63.7. But that was a different method (repeatedly rewriting memory) on DeepSeek-V3.1, so it only works as an analogy.
- Conclusion: the direction is credible, but **there's no basis for saying it definitely breaks after a certain number of compactions**.

---

## 3. When to compact, when to start a new session, and when to leave it alone

| Your situation | Recommendation | Strength of evidence |
|---|---|---|
| Same task, going well, Claude context < about 200K | **Leave it alone**; don't compact "just to be safe" | Medium-weak. Anthropic's own benchmarks don't compact until 200K; Opus 4.6 retrieves at about 92% at 128–256K; no data for Opus 5.5 |
| Very small context (< about 50K) | Compaction gains almost nothing and only loses detail | Weak; reasoning only |
| Same task at a natural break (done exploring and about to build, or a sub-feature finished), context at 200K–500K | You can **/compact with instructions on what to keep**, or just carry on | Medium-weak. The official docs recommend compacting at natural pauses between tasks rather than waiting for auto-compaction to fire mid-task; the specific numbers are inferred |
| Context > 500K | **Deal with it at the next break** (compact or start a new session) instead of waiting for the 967K auto-compaction to fire mid-task | Medium-weak. Newer models are generally worse at 512K–1M than within 256K; the official example of compacting earlier is exactly `/autocompact 500k` |
| Went the wrong way and want to drop it | Use **/rewind** to go back instead of compacting (keeps the cache and avoids summary loss) | Strong; official docs |
| Switching to an unrelated task | Write a handoff note first if needed, then **/clear and start a new session** | Strong; official docs |
| The model starts forgetting rules, redoing finished work or going in circles | Stop, write up one complete brief, and **start a new session** | Medium-strong. Laban: consolidating into one complete instruction recovers 95.1%; also several issues |
| The session has already been compacted 2+ times and there's a lot of work left | Write a handoff note and **start a new session** | Weak; rule of thumb, no research curve |
| You'll soon need lots of verbatim details (paths, raw error messages, constraints) | **Write them into a file first**, then compact or start a new session | Medium. 2608.01326, Lost in Compaction |
| You'll be away longer than the cache lasts and will continue the same work on return, context ≥150K | Before leaving, compact with instructions on what to keep; if the details matter, write a progress file first | The cost mechanism is strong (official); see the estimate below for amounts |
| Codex (272K window, auto-compacts at about 232K) | Long tasks will almost certainly compact. Wrap up proactively at breaks; if you see back-to-back compactions or progress going backwards, start a new session | Medium-weak. Source analysis plus issues |

**Caching and cost (official prompt-caching docs):**
- **Cache lifetime:** for subscribers within their allowance, the main session's cache lasts 1 hour; with an API key or a cloud platform, or once you're past your allowance and paying with credits, it's 5 minutes.
- **When compaction is cheap:** while the cache is warm, /compact reads the whole context at the cache-read price, which is cheap. Once the cache has expired, continuing and compacting both mean rereading everything at full price, and that's when compaction costs the most.
- **Estimate (Opus 5.5 official prices):** cache read $0.20/M, cache write $5/M, regular input $4/M. With a 400K context, compacting on a warm cache reads everything for about $0.08; after expiry, rereading costs about $1.6–2.0. Subscribers are charged against their allowance in the same proportions.

**A side note:** the widely shared advice to "compact manually at 40–50%" has no methodology we could find and no official backing; don't rely on it.

---

## 4. Ways to reduce compaction loss (ordered by strength of evidence)

**Strong**
1. **Put long-term rules in the project-root CLAUDE.md, not only in the conversation.**
   - The official docs state that the root CLAUDE.md is reloaded from disk after compaction, while rules with `paths:` and CLAUDE.md files in subdirectories get summarized away.
   - Constraints stated in passing during a session survive only 17% of the time on average (Lost in Compaction).
   - Put the important parts of a skill file at the top, because truncation keeps the beginning.
2. **When you switch tasks, /clear instead of compacting and carrying on with something else.** The official wording is "Clear between tasks".
3. **For long tasks, hand off through a progress file plus git commits.**
   - Anthropic's *Effective harnesses for long-running agents* (2025-11-26, Opus 4.5) says plainly that "compaction isn't sufficient" and recommends a progress file, a feature list and git history.
   - Laban's experiments show that consolidating everything into one complete brief recovers most of the performance.
   - Note: Cognition found that notes the model writes for itself are often incomplete, so **look over the handoff note yourself**.

**Medium**

4. **Compact at task boundaries, not mid-task.** The official caching docs recommend running /compact at natural pauses. In issue #28728, auto-compaction fired mid-task and failed, and the user ended up having to /clear. There is no controlled experiment behind this one.
5. **Give /compact instructions on what to keep**, for example `/compact keep: task goal, decisions made and why, open questions, paths of files being edited, no automatic commits`. You can also add a Compact Instructions section to CLAUDE.md. This is official advice; in addition, methods that extract constraints specifically keep over 90% of them, far above the 17% of generic compaction.
6. **If you went the wrong way, use /rewind rather than compaction.** To compact only part of the conversation, use /rewind's "Summarize from here / up to here". This is an official feature.
7. **Hand heavy file reading and searching to subagents**, which bring only 1–2K tokens of conclusions back to the main session. This is official advice. Note: the often-cited "multi-agent improves results by 90.2%" comes mostly from spending more tokens (about 15 times as many), so it isn't evidence that isolation beats compaction.
8. **Clear old tool output first, and only then summarize the whole conversation.** Claude Code's automatic flow already clears old tool output before summarizing. The evidence is JetBrains (non-Claude models) and Anthropic's context editing (models not disclosed).

**Weak**

9. **After compaction, check that key constraints are still in place**, especially permissions around commit, push and delete; if needed, have the model reread CLAUDE.md and the progress file. Critical prohibitions can be re-injected with a SessionStart (compact) hook: in #95745, instructions injected by a hook were still followed after compaction, but that's a single report.
10. **Keep count of how many times you've compacted**, and consider a new session after a few. This is only a rule of thumb; there's no research on a threshold.

---

## 5. Evidence table

| Claim | Evidence | Source | Date | Strength |
|---|---|---|---|---|
| Performance degrades gradually as context grows; it's an architectural issue | Anthropic's explanation of the mechanism; official advice to compact, clear tool output and start a new session when switching tasks | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | 2025-09-29 | Strong (vendor) |
| Degradation starts well before the window limit; more distractors make it worse | Independent benchmark of 18 models | https://www.trychroma.com/research/context-rot | 2025-07-14 | Strong (models from mid-2025 and earlier) |
| Meaning-based lookups degrade earlier than exact-word lookups: at 32K, 11 of 13 models fell below half, GPT-4o 99.3%→69.7% | NoLiMa, ICML 2025 | https://arxiv.org/abs/2502.05167 | 2025-02 | Strong (2024–25 models) |
| Deep reasoning over long documents: best model answering directly 50.1%, human experts 53.7% (503 questions) | LongBench v2 | https://arxiv.org/abs/2412.15204 | 2024-12-19 | Medium (older models) |
| "The middle gets overlooked" only applies to older models: about 4K tokens, GPT-3.5 dropped by more than 20% at worst; Chroma saw no clear positional difference on newer models | Lost in the Middle (TACL); Chroma | https://arxiv.org/abs/2307.03172 | 2023-07 | Doesn't apply to today's models |
| Newer models still drop from 256K to 1M: Opus 4.6 91.9→78.3, GPT-5.4 79.3→36.6, Gemini 3.1 Pro 59.1→25.9, Opus 4.7 59.2→32.2 | MRCR v2 8-needle | https://www-cdn.anthropic.com/037f06850df7fbe871e206dad004c3db5fd50340/Claude%20Opus%204.7%20System%20Card.pdf | 2026-04 | Medium-strong (vendor self-reported) |
| Opus 4.6 scores 76% at 1M, Sonnet 4.5 18.5%; Anthropic acknowledges context rot is a common complaint | Launch post | https://www.anthropic.com/news/claude-opus-4-6 | 2026-02-05 | Medium-strong (vendor) |
| GPT-6 Astra scores 96.3% at 512K–1M | Self-reported by OpenAI, relayed by Vellum | https://www.vellum.ai/blog/gpt-6-astra-benchmarks-explained | 2026-09-03 | Weak (second-hand) |
| Top models don't gain from removing irrelevant content, small models do; removing content from the middle at random breaks all of them | BABILong / GraphWalks truncation experiments | https://arxiv.org/abs/2608.03297 | 2026-08-04 | Medium (new paper, not yet replicated) |
| Multi-turn conversations drop 39% on average, mostly from unreliability (+112%); consolidating into one complete instruction recovers 95.1% | 15 models, 200K+ simulated conversations | https://arxiv.org/abs/2505.06120 | 2025-05 (ICLR 2026) | Strong |
| More tools, longer outputs and more turns lower function-calling accuracy by 7–85%, 7–91% and 13–40% respectively | LongFuncEval | https://arxiv.org/abs/2505.10570 | 2025-04-30 | Medium (model list not verified) |
| Models cut corners when they believe they're nearly full (context anxiety) | Hands-on experience with Sonnet 4.5 | https://cognition.com/blog/devin-sonnet-4-5-lessons-and-challenges | 2025-09-29 | Medium (practitioner) |
| What /compact keeps, drops and reloads from disk | Official docs | https://code.claude.com/docs/en/context-window | Accessed 2026-09 | Strong |
| 1M-window models (Opus 4.7 and later, Sonnet 5) auto-compact at about 967K by default; adjustable with /autocompact between 100K and 1M | Official docs | https://code.claude.com/docs/en/model-config | Accessed 2026-09 | Strong |
| Compaction is cheap with a warm cache and most expensive with a cold one; subscription 1h / API 5min; compact at pauses between tasks | Official docs | https://code.claude.com/docs/en/prompt-caching | Accessed 2026-09 | Strong |
| After compaction, verbatim lookups are close to guessing (error rate 0.02 → about 0.5) | Opus 4.8, about 500K tokens | https://arxiv.org/abs/2608.01326 | 2026-08-02 | Medium (only one task type tested) |
| Compactors keep on average only 17% of in-session constraints | Lost in Compaction | https://arxiv.org/abs/2608.11242 | 2026-07-31 | Medium (flagship models not tested) |
| After compaction, CLAUDE.md is still present but not followed (Opus 4.8 / Opus 5) | issue #95745 | https://github.com/anthropics/claude-code/issues/95745 | 2026-09-20 | Weak-medium (one reporter, reproducible) |
| The model acts on a compaction summary as if it were authoritative | System Card page 112 | Same Opus 4.7 System Card as above | 2026-04 | Medium |
| Anthropic's own benchmarks compact at 200K; BrowseComp reaches 79.3% with compaction | System Card | Same as above | 2026-04 | Medium-strong (search tasks, not coding) |
| Clearing only old tool output: cost halved, solve rate unchanged; LLM summaries make trajectories 13–15% longer | SWE-bench, Qwen3 / Gemini 2.5 Flash | https://arxiv.org/abs/2508.21433 ; https://blog.jetbrains.com/research/2025/12/efficient-context-management/ | 2025-08 / 2025-12 | Medium |
| Context editing +29%, +39% with memory, tokens down 84% | Internal search benchmark, models not disclosed | https://claude.com/blog/context-management | 2025-09-29 | Medium |
| Optimized compaction: peak tokens down 26–54%, small models up to +46% | ACON, ICML 2026 | https://arxiv.org/abs/2510.00615 | Revised 2026-06 | Medium |
| Compaction alone isn't enough; hand off with a progress file plus git | Anthropic's long-running agents blog post (Opus 4.5) | https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents | 2025-11-26 | Strong (vendor) |
| Rewriting the whole memory can collapse: 18,282→122 tokens, 66.7→57.1, below the 63.7 baseline | ACE (DeepSeek-V3.1, not /compact) | https://arxiv.org/abs/2510.04618 | 2025-10 | Weak (analogy) |
| Codex triggers at about 272K×95%×90% ≈ 232K; the source warns that multiple compactions reduce accuracy | Source analysis | https://gist.github.com/osolmaz/a38acf6e522df67530e3ed47c80fdcd5 | 2026-07 | Medium (practitioner) |
| Codex after compaction: progress going backwards, redoing work, running out of the weekly quota | issues #25792, #35935, #35032 | https://github.com/openai/codex/issues/35935 | 2026-06 / 07 | Weak (all single-user reports) |
| Multi-agent +90.2%, but at about 15 times the tokens; token count explains 80% of the difference | Anthropic multi-agent blog post | https://www.anthropic.com/engineering/multi-agent-research-system | 2025-06-13 | Medium (not evidence that isolation is better) |
| Compaction should be restorable (keep URLs and paths); cache hits matter a lot | Manus engineering blog | https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus | 2025-07-18 | Medium (practitioner) |
| Anthropic contradicts itself: one place says the 1M window stays accurate throughout, another says quality degrades as the conversation grows | 1M GA blog post; API compaction docs | https://claude.com/blog/1m-context-ga ; https://platform.claude.com/docs/en/build-with-claude/compaction | 2026-03-13 | Shows the vendor's messaging is inconsistent |
| "Compact manually at 40–50%" | Personal blog, no methodology | https://www.mindstudio.ai/blog/how-to-stop-burning-through-claude-code-tokens-context-management-guide-beginners | Unknown | No basis found; not used |

---

## 6. Open questions

1. **Opus 5.5, the model you actually use, has no published long-context scores**, and neither do Opus 5 and Sonnet 5. Opus 4.7 clearly regressed from 4.6, so the 200K and 500K bands above are inferences, not measurements.
2. **There's no research on how much is lost after N compactions.** "Multiple compactions are worse" rests only on indirect evidence: reasoning about the mechanism, the Codex warning and single-user issues.
3. **Coding tasks lack controlled experiments.** On search tasks compaction actually raises scores, and on verbatim-lookup tasks it drops to near guessing; coding is probably somewhere in between, but nobody has measured it.
4. **Most 2026 flagship data are vendor self-reports**, such as GPT-6 Astra's 96.3% and the Opus System Cards. Independent re-tests (such as Context Arena and Fiction.LiveBench) weren't obtained this time.
5. **Why CLAUDE.md is reloaded after compaction yet not followed (#95745) is unknown**, and there has been no official response.
6. **Anthropic's own statements don't agree**: the 1M GA blog post says accuracy holds throughout, while other docs say quality degrades with length.
7. Many GitHub issues are single-user reports; Claude Code #13919 couldn't be opened, and the original posts of #10948, #13112 and #4517 weren't verified, so none of them were used this time.
8. OpenAI's cache TTL rules, and how to enable a 1M window in Codex, weren't verified against first-hand sources this time.
