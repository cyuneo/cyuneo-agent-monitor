# 自动压缩阈值怎么选：参考说明

[English](compaction-threshold-guide.md) · **简体中文**

> 调研日期：2026-09-24。每个数字都附了出处，查不到的直接写“查不到”。
> 文中的“压缩”指 compaction：上下文快满时，把前面的对话总结成一段摘要，腾出空间。
> 百分比默认以**整个模型窗口**为分母，另有说明的除外。

---

## 1. 一句话结论

**没有任何厂商或论文给过“调研用 X%、写代码用 Y%”这样的标准答案。** 能确定的只有两点：在 1M 窗口的模型上，把压缩点从默认约 967K 调到 200K–400K，按下面的成本模型，每次调用能省约 45–59%，代价是压缩次数多 3–7 倍，而每次压缩都会丢信息；在 200K 窗口的模型上调低阈值几乎不省钱，调低只能是为了质量。

---

## 2. 各家工具默认在哪里压缩

| 工具 | 默认压缩点 | 能否配置 | 官方理由 | 出处 |
|---|---|---|---|---|
| **Claude Code** | 1M 窗口模型约 **967K**（96.7%）；200K 窗口模型在 **200K 边界** | 能：`/autocompact`、`autoCompactWindow`（100K–1M）、`--autocompact`、环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（优先级最高）；另有 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`（1–100%，分母是压缩窗口，只能调低） | /autocompact 对话框原文：“auto 按模型调过，为成本和性能强烈推荐”（这是产品内文案，在 v2.1.278 里找到，公开文档里没有）。最近几个版本一直把默认压缩点往后推：v2.1.247 从约 934K 改到约 967K；v2.1.260 让 Opus/Fable 接近 1M 才压缩；v2.1.273 把“约半个窗口就压缩”当 bug 修掉了 | https://code.claude.com/docs/en/model-config ；https://code.claude.com/docs/en/env-vars ；https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md |
| **Codex CLI** | 窗口的 **90%**。默认窗口 272K，所以约 **244,800** | 能：`model_auto_compact_token_limit`，只能调低，超过 90% 会被封顶 | 文档只写了“unset uses model defaults”，90% 出自源码 `min(用户值, 窗口×9/10)` | https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs |
| Gemini CLI | **50%**（2025-11-20 对 API key 用户从 70% 下调），压缩后保留最近 30% | 能 | PR 里只说“更早触发压缩” | https://github.com/google-gemini/gemini-cli/pull/13517 |
| Qwen Code | **85%**（从 70% **上调**） | 能：`context.autoCompactThreshold` | 1M 模型在 70% 时还剩约 300K，而摘要加输出只要约 33K，压得太早 | https://github.com/QwenLM/qwen-code/blob/main/docs/design/auto-compaction-threshold-redesign.md |
| GitHub Copilot CLI | 80% 开始后台压缩，95% 暂停等待 | 文档未写 | 留约 20% 空间，压缩期间工具调用还能继续 | https://docs.github.com/en/copilot/concepts/agents/copilot-cli/context-management |
| VS Code Copilot Chat | 缓存热时约 80%（在 0.78–0.82 之间浮动），缓存冷时 ≥90%，溢出时前台压缩 | 否（有内部设置，但没开放给用户） | 官方只写“窗口满时”，数字来自一篇读源码的博客 | https://alexop.dev/posts/how-vscode-copilot-chat-conversation-compaction-works/ （2026-09-23） |
| Cline | 约窗口的 **81%**（可用输入预算的 90%） | 未核实 | 文档里没有数字。网上流传的“70%”已经过时 | https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/context/compaction-shared.ts |
| Goose | **80%** | 能：`GOOSE_AUTO_COMPACT_THRESHOLD`，设 0 关闭 | 未说明 | https://goose-docs.ai/docs/guides/sessions/smart-context-management/ |
| Zed | **90%** | 能：可以写百分比、已用 token 数或剩余 token 数，也可以关闭 | 未说明 | https://zed.dev/docs/ai/agent-settings |
| Roo Code | 滑块默认 100%（第三方文章说实际约 86–92% 就触发，未核实） | 能 | 交给用户决定 | https://roocodeinc.github.io/Roo-Code/features/intelligent-context-condensing |
| Kilo Code | 不设百分比时，剩余空间低于 20K buffer 就压缩 | 能：`threshold_percent` 1–100 | 保证压缩请求本身不会失败 | https://kilo.ai/docs/customize/context/context-condensing |
| Aider | 只管聊天历史：输入窗口的 1/16（1K–8K，约 6%） | 能 | 未说明 | https://github.com/Aider-AI/aider/blob/main/aider/models.py |
| OpenHands | 按事件条数算：满 120 条压到约 60 条，保留最前面 4 条 | 能 | 保留开头的设定和最近的事件 | https://docs.openhands.dev/sdk/arch/condenser |
| Amp | **不自动压缩**，2025-10 起改成手动 Handoff | — | 压缩有损，摘要里有没有你要的东西“取决于 agent”；压缩还会让线程越拖越长、越来越散 | https://ampcode.com/news/handoff |
| Cursor | 不公开百分比。员工在论坛回复：“在当前窗口接近顶部时触发” | 否 | 过早触发多半是 node_modules 这类目录被拉进了上下文 | https://forum.cursor.com/t/context-keeps-summarizing-at-10-20-of-total-context-window/163850 （2026-06-22） |
| Windsurf、opencode | **查不到可靠数字**。opencode 有两种第三方说法，互相矛盾 | — | — | — |

**能看出的规律：** 各家默认值从约 6%（Aider）到 100%（Roo）都有，多数落在 80–90%。调整方向也不统一：Gemini 往前调（70%→50%），Qwen 和 Claude Code 往后调（70%→85%，934K→967K）。可见业界**没有公认的最优百分比**。

---

## 3. 厂商跑评测时在哪里压缩

### 调研 / 检索类

| 谁 | 模型与窗口 | 压缩点 | 结果 | 出处 |
|---|---|---|---|---|
| Anthropic（Opus 4.6 发布文，2026-02） | Opus 4.6 | BrowseComp：**50K** 触发，总预算 10M；HLE：50K 触发，总预算 3M | 拿下当时的最高分 | https://www.anthropic.com/news/claude-opus-4-6 |
| Anthropic cookbook（2026-06-25） | 新模型 | BrowseComp：**200K** 触发，总预算 3M；最新 model card 里的 DeepSearchQA 不压缩（1M 窗口装得下） | 触发点越低，越容易在压缩后丢掉原始问题（一道题可能被压好几次），200K 时这个问题小一些 | https://platform.claude.com/cookbook/evals-agentic-search-reproduce-agentic-search-benchmarks |
| DeepSeek-V3.2（2025-12） | 128K 窗口 | 用量到窗口的 **80%**（约 102K）时触发 | 不做管理 51.4 → 做摘要 60.2（要 364 步）→ 直接丢掉全部旧工具结果 **67.6** | https://arxiv.org/html/2512.02556 |
| Kimi K2.5（2026-02） | 256K 窗口 | 窗口的 **80%** 触发 discard-all；HLE 在 96K 触发 | BrowseComp 60.6 → **74.9** | https://huggingface.co/moonshotai/Kimi-K2.5/discussions/13 （Moonshot 员工的说明）、arXiv 2602.02276 |

### 写代码类

| 谁 | 设置 | 结果 | 出处 |
|---|---|---|---|
| JetBrains《Complexity Trap》（2025-08，SWE-bench Verified，Qwen3-Coder 480B） | 只保留最近 **10 轮**工具输出，更早的丢掉 | 解决率 54.8%，每题 $0.61；不做管理 53.4%，$1.29；LLM 摘要（31 轮时触发）53.8%，$0.64；保留 20 轮反而更差 | https://arxiv.org/html/2508.21433v3 |
| OpenHands 博客（2025-04-04） | 上下文压缩（文中没给触发阈值） | 解决率 53% → 54%，单轮成本降了一半以上 | https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents |
| arXiv 2609.20804（2026-09-17） | 窗口预算分 32K/64K/96K/128K 四档 | “有管理”和“无管理”的差距从 35.7 分缩小到 2.7 分，收益主要来自避免溢出截断 | https://arxiv.org/html/2609.20804 |
| Claude API 默认值（vendor-doc，不是评测） | context editing 在 100K 时清旧工具结果，保留 3 次；API compaction 默认 150K 触发，最低 50K | 官方原话是合适的值取决于你的 agent 怎么用工具结果，“多试几种配置” | https://platform.claude.com/docs/en/build-with-claude/compaction-threshold |

**说明什么：** 调研类评测普遍**压得早、丢得狠**（50K–200K，或窗口的 80%），因为网页原文读完、提炼出结论后就没用了。写代码类研究更看重**保留最近几轮的原始输出**，而写代码工具的默认值都设得很晚（90%–96.7%）。**要注意：评测配置是为了刷分，不是给交互使用的建议。** Anthropic 自家的 BrowseComp 触发点也从 50K 改成了 200K，理由就是压得太早会丢掉原始问题。

---

## 4. 博客与从业者的意见

| 谁 | 建议 | 针对什么任务 | 有没有数据 | 出处 |
|---|---|---|---|---|
| **langwatch / Rogerio Chaves**（2026-08-02） | PR 驱动 200–250K；**研究 250–300K**；QA 250–350K；**构建/理解代码 300–450K**；成本最优点约 220K（170K–316K 都在最优的 10% 以内） | 分任务类型 | **有**：162 天、2,451 个会话、873 次压缩；压缩后 5 步内纠错率从 17.7% 升到 41.9%。**局限**：只有作者一个人的数据，是观察不是实验；研究类会话很少超过 150K，所以研究那档是外推的；文中没说用的哪个模型；给的是绝对 token 数，不是百分比 | https://langwatch.ai/blog/context-tax-when-to-compact |
| HumanLayer / Dex Horthy（约 2025-08） | 上下文利用率保持在 **40–60%**，经常主动压缩 | 写代码（研究→计划→实现） | 无实验，是经验方法 | https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md |
| Dex Horthy 访谈（Pragmatic Engineer，2026-07-15） | 1M 模型用到 **300–400K**；200K 模型约 **100K** 就停 | 写代码 | 无。网传的“40% 进入 dumb zone”“依据 10 万+会话”在访谈原文里找不到 | https://newsletter.pragmaticengineer.com/p/context-engineering-with-dex-horthy |
| WorkOS / Mitch Fultz（2026-08-14） | 320K 窗口、预留 64K，约 256K（80%）时压缩 | 写代码 | 无。作者自己说这是“需要用你自己的工作负载去验证的工程假设” | https://workos.com/blog/coding-agent-context-window-compaction-settings |
| LangChain deepagents（2026-03-11） | 85% 触发，保留最近 10% | 写代码（不是“研究专用”） | 没有阈值对比。核心主张是让模型自己决定什么时候压缩 | https://www.langchain.com/blog/autonomous-context-compression |
| Hermes（mem0 博客，2026-05-14 发布，09-15 更新） | 主压缩在 50%，85% 做兜底 | 通用 | 工程上的双层设计，不是按任务调出来的 | https://mem0.ai/blog/how-hermes-and-claude-handle-context-compression-in-real-production-agents-(and-what-you-should-extract) |
| mindstudio（2026-07-09） | 通用任务 70–75%，复杂推理 60–70% | 通用 | 无。文中说“研究表明”，但没给出处 | https://www.mindstudio.ai/blog/context-rot-ai-agents-auto-compact-fix |
| nathanonn（2026-05-01） | 50–60% 手动压缩，60% 以上直接重开；1M Opus 用到 15–20% 就重开 | 写代码 | 作者的一次个人经历 | https://www.nathanonn.com/claude-code-never-auto-compact/ |
| howdoiuseai（2026-04-16） | 约 60% | 通用 | 无 | https://www.howdoiuseai.com/blog/2026-04-16-what-does-compact-do-in-claude-code-context-management |
| **网传“Anthropic 的 Thariq 建议 50–60%”** | — | — | **查不到出处。** Thariq 在 Anthropic 官方博客（2026-04-15）的文章里没有任何百分比，只说 1M 窗口让你“有更多时间主动 /compact”，以及“模型在压缩的那一刻最不聪明”。50–60% 最早见于 albertsikkema.com（2026-04-23），属于误归因 | https://claude.com/blog/using-claude-code-session-management-and-1m-context |
| badlogic gist（2025-12-02） | 嫌默认 95% 太晚，建议 85–90% | 写代码 CLI | 无 | https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f |
| Geoffrey Huntley（2025-04-07） | Claude 3.7 标称 200K，到 147–152K 就开始变差；主张不压缩，直接开新会话，把状态写进规格文件 | 长时间自主循环 | 个人观察，模型已经过时 | https://ghuntley.com/redlining/ |
| Anthropic《Effective context engineering》（2025） | **不给数字**：来回对话多的用 compaction，按里程碑推进的开发记笔记，复杂研究用多 agent | 按技术手段分场景，不按百分比分 | — | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |

**点评：**
- **最有参考价值的是 langwatch**。它是唯一一篇按任务类型给数字、而且有真实数据的文章，但数据只来自一个人，研究类那档还是外推的。
- 网上流传的“40–60%”基本都来自 HumanLayer 的经验方法和别人的转述。**挂在 Anthropic 名下的“50–60%”不成立**，产品文案里不要这样写。
- 这些百分比大多是在 200K 窗口时代提出的。agentpatterns 汇总的老模型测试显示，性能开始下降的点更接近一个**绝对 token 数**（约 32K–100K），而不是某个百分比（https://agentpatterns.ai/context-engineering/context-window-dumb-zone/ ）。同样是 50%，放在 200K 模型和 1M 模型上意义完全不同。所以插件按 token 数来设是对的。

---

## 5. 论文实验说明了什么

**压得晚（阈值高）的代价**
- 上下文越长，模型越容易出错。Chroma《Context Rot》（2025-07）；MRCR v2 8-needle 测试中，从 128–256K 到 512K–1M，Opus 4.6 从 91.9% 降到 78.3%，GPT-5.4 从 79.3% 降到 36.6%（上一轮调研的结果）。
- langwatch 的数据：上下文超过 600K 时，只有约 2.5% 的内容还真正被用到；低于 50K 时这个比例是 47.5%。
- 每次调用都要把整个上下文重读一遍，阈值越高越贵，见第 6 节。

**压得早（阈值低）的代价**
- 压缩有损。Lost in Compaction（2026-07）：会话里的约束平均只剩 17%；arXiv 2608.01326：逐字信息几乎全丢（上一轮调研的结果）。阈值越低，压缩次数越多，损失会累积。
- ACON（arXiv 2510.00615）专门做了阈值消融：阈值越小越省 token，但压缩次数越多、准确率越低。它的阈值是 4096/1024 这类很小的绝对值，不能直接套到 Claude Code 上。
- Anthropic cookbook：触发点越低，越容易在压缩后丢掉“原始问题”。
- langwatch：压缩后 5 步内的纠错率是平时的 2.37 倍，120 步后还没完全恢复。
- 阈值离“启动时的上下文大小”太近，会陷入反复压缩。Claude Code issue #61351：阈值约 70%，加上很大的 CLAUDE.md 和记忆文件，几乎每轮都在压缩，58 分钟花了约 $9.18（https://github.com/anthropics/claude-code/issues/61351 ）。

**几个反直觉的发现**
- 压缩不一定降分。OpenHands 压缩后解决率 53%→54%；JetBrains 的“只留最近 10 轮”比不管理更好，价格还不到一半。
- 调研类任务里，**怎么处理**比**什么时候触发**更关键。DeepSeek 和 Kimi 在同样的 80% 触发，直接丢掉旧搜索结果比做摘要分数高得多（67.6 对 60.2）。
- **时机**比**比例**重要。Self-Compacting LM Agents（arXiv 2606.23525）发现，按固定 token 数触发可能在推理进行到一半时把中间结果丢掉；让模型自己选时机，效果不比固定间隔差，每题成本还低 30–70%。
- 窗口越大，上下文管理带来的准确率收益越小（arXiv 2609.20804：差距从 35.7 分缩到 2.7 分）。

**目前缺的：** 没有任何论文直接测过“Claude Code / Codex 在 X% 压缩”的效果。所以下面的档位建议都是**从间接证据推出来的**，不是实验结论。

---

## 6. 成本账（自己算的模型）

### 假设
- 价格按 **Opus 5.5**，已对照 Anthropic 官方 SDK 资料核对：输入 $4、输出 $20、缓存读 $0.20；1 小时缓存写入是输入价的 2 倍，即 $8。单位都是每百万 token。
- **缓存一直是热的**：两次调用间隔不超过 1 小时，也就是用 1 小时缓存。
- 每次调用：之前的整个上下文按缓存读计费，新增的约 3K token 按 1 小时缓存写入计费。常规回复的输出费用各档一样，不影响比较，所以没算进去。
- 压缩后剩约 30K，之后每次调用涨 3K，直到压缩点。
- 每次压缩的费用 = 按缓存读价把当前上下文读一遍 + 摘要输出（压缩点的 4%，限定在 2K–20K 之间）+ 压缩后把 30K 重新写入缓存。
- 压缩费用平摊到这一轮的每次调用上。

### 结果

| 压缩点 | 一轮能跑几次调用 | 平均上下文 | 每次：重读上下文 | 每次：写入新内容 | 单次压缩费用 | 平摊到每次 | **每次调用合计** | 相对默认 | 每 100 次调用压缩几次 |
|---|---|---|---|---|---|---|---|---|---|
| **967K**（1M 默认） | 312 | 497K | $0.099 | $0.024 | $0.83 | $0.003 | **$0.126** | 100% | 0.3 |
| **500K** | 157 | 264K | $0.053 | $0.024 | $0.74 | $0.005 | **$0.081** | 65% | 0.6 |
| **300K** | 90 | 164K | $0.033 | $0.024 | $0.54 | $0.006 | **$0.063** | 50% | 1.1 |
| **200K** | 57 | 114K | $0.023 | $0.024 | $0.44 | $0.008 | **$0.055** | 43% | 1.8 |

举个例子：一个 600 次调用的会话（大约几小时的写代码），967K 约 **$75.6**、压缩 2 次；500K 约 $48.9、压缩 4 次；300K 约 $37.6、压缩 7 次；200K 约 **$32.7**、压缩 11 次。

### 表里能看出什么
1. **钱主要花在“每次重读整个上下文”上，压缩本身不贵。** 一次压缩最多约 $0.83，平摊到每次调用不到 1 美分。
2. **越往低调越不划算。** 每次调用都有约 $0.024 的固定写入费，压缩点低于约 200K 后几乎不再省钱（100K 时每次约 $0.051），压缩次数却成倍增加。
3. **200K 窗口的模型调低基本不省钱。** 默认本来就在约 167K 压缩，调到约 127K，每次只省约 3%。
4. **离开超过 1 小时，缓存就冷了**，回来第一次调用要把整个上下文按 $8/M 重新写入：平均上下文 497K 时约 $3.98，114K 时约 $0.91。经常中途离开的人，低阈值更省。
5. **加上返工成本也不改变结论。** 假设每次压缩后要多跑 5 次调用、重新读回 20K 的文件（约 $0.32/次），200K 档每次调用是 $0.060，仍然只有默认的一半左右。但到 100K 档，费用开始反弹（$0.065）。
6. 这个量级和 langwatch 用真实账单算出的“逼近 1M 时约为最优点的 2.3 倍”一致（我们算的 967K 对 200K 也是 2.3 倍）。
7. **Codex** 默认窗口只有 272K，把 90% 调到 80% 或 70%，粗算只省约 7–14%。Codex 真正要避开的是上下文超过 272K 后的长上下文加价，见第 7 节。

### 官方那句 “Overriding auto may result in high token usage, especially when resuming long sessions” 可能指什么

**官方没有解释这句话，以下都是推测。** 按上面的稳态模型，调低阈值每次调用是更便宜的，所以这句话更可能指下面几种情况：
- **恢复一个比阈值大的旧会话。** 比如一个在默认设置下聊到 600K 的会话，你把压缩窗口改成 300K，隔天再恢复。缓存早就过期了，一恢复就超过阈值、立刻压缩：600K 按未缓存输入价 $4/M 算是 $2.40，再加摘要和重写，一次约 $3。官方 prompt-caching 文档确实写了 “This is why /compact costs the most when you resume an old session”（https://code.claude.com/docs/en/prompt-caching ）。但单看这一步不一定比 auto 更贵：不压缩的话，恢复 600K 也要重新写缓存（1 小时写入约 $4.8）。如果 Claude Code 的做法是先正常发一次请求、再发现超阈值去压缩，那两笔都得付（约 $5.6）。具体实现我们没查到。
- **反复压缩**：阈值设得离启动上下文太近，就会出现 issue #61351 那种几乎每轮都压缩的情况。
- **压缩后返工**：摘要丢了细节，模型只好重新读文件、重做。
- **“token usage”可能指 token 数量**，比如订阅用户的用量额度，而不是美元。额度按什么规则折算，我们查不到。

---

## 7. 怎么选

| 档位 | 1M 窗口的模型（设多少 → 约在哪压缩） | 200K 窗口的模型 | Codex（默认 272K 窗口） | 适合谁 | 代价（成本按第 6 节模型） | 依据强弱 |
|---|---|---|---|---|---|---|
| **保持默认（auto）** | 不设（约 967K） | 不设（200K 边界） | 不设（90%，约 245K） | 不想操心的人；经常恢复很久以前的长会话；启动上下文很大 | 1M 模型每次调用最贵（约 $0.126）；上下文后段模型可能变迟钝 | **强**：厂商默认，官方强烈推荐 |
| **写代码（均衡）** | 400K → 约 367K | 200K（同默认） | 0.9（同默认） | 日常写代码、读代码、改 bug | 每次约 $0.069，比默认省约 45%；压缩次数约为默认的 2.8 倍 | **中**：langwatch 数据（构建/理解代码 300–450K）加从业者经验（1M 用到 300–400K），没有对照实验 |
| **调研/检索** | 250K → 约 217K | 160K → 约 127K | 0.8 → 约 218K | 大量搜索、读网页和文档，读完只留结论 | 每次约 $0.056，省约 56%；压缩次数约为默认的 5 倍；更容易丢掉最初的问题，建议把问题写进文件 | **中**：Anthropic 自家搜索评测在 200K 触发；DeepSeek 和 Kimi 在窗口 80% 触发；langwatch 研究类 250–300K（超出其数据覆盖范围） |
| **长时间自主运行** | 600K → 约 567K | 200K（同默认） | 0.9（同默认） | 无人值守、一跑几个小时的任务 | 每次约 $0.088，省约 30%；压缩次数只有默认的约 1.8 倍 | **弱**：折中推理，没有直接证据。真正起作用的是把目标和约束写进文件 |
| **省钱优先** | 200K → 约 167K | 200K（同默认，调低也不省钱） | 0.8 → 约 218K | 预算敏感，任务短、彼此独立 | 每次约 $0.052，省约 59%，再往下基本不省；压缩次数约为默认的 7 倍，信息损失最多 | **中**：成本模型加 langwatch 的成本最优点（约 220K） |

**拿不准怎么选：** 主要写代码的选“写代码（均衡）”；主要查资料的选“调研/检索”；经常隔天恢复长会话、或者 CLAUDE.md 和 MCP 工具很多的，保持默认。

### 设置前要知道的几件事
1. **你设的是“压缩窗口”，实际压缩会早一点。** 官方 changelog 写明 1M 窗口约在 967K 压缩，两者差约 33K（拆成摘要预留 20K 加缓冲 13K，这个说法是二手旁证）。官方没写自定义值是不是也提前 33K，所以上表的“约在哪压缩”是推算出来的。
2. **状态栏的 used_percentage 始终以整个模型窗口为分母。** 设了压缩窗口之后，这个百分比就不再代表离压缩还有多远（env-vars 文档原文）。
3. **别设得离启动上下文太近。** 如果一开局 CLAUDE.md、MCP 工具说明、记忆文件就占了几万 token，压缩后很快又会满，陷入反复压缩。我们自己的经验规则（不是官方说法）：压缩点至少是“压缩后剩余大小”的 3 倍。
4. **比调数字更管用的两件事：** 在任务间隙手动 `/compact`，别让自动压缩在任务中途触发（官方 prompt-caching 页也这么建议）；把目标、约束、进度写进文件（计划文件、CLAUDE.md），压缩丢了还能读回来（Anthropic 的记笔记做法、Huntley 和 Manus 的思路都是这样）。
5. **Codex：** 默认窗口 272K。如果你手动开了更大的窗口（最大 872K），比例要按新窗口重算。另外有报道称 GPT-5.6 的输入超过 272K 后，输入按 2 倍、输出按 1.5 倍计价（AI Weekly，2026-07-19，https://aiweekly.co/alerts/openai-codex-cuts-gpt-56-context-window-from-372k-to-272k ），所以开了大窗口的话，压缩点放在 272K 以下更省钱。
6. **订阅用户（Pro/Max）：** 上面的美元账是按 API 按量计费算的。订阅额度怎么按 token 折算我们查不到，只能说大方向应该一致。
