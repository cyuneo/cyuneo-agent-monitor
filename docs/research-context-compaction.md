# 上下文压缩对模型表现的影响：调研结论

> 调研日期：2026-09-24。你现在用的是 Claude Code（Claude Opus 5.5，1M 窗口，默认约 967K 自动压缩）和 Codex（约 272K 窗口）。下文的"强/中/弱"指证据强弱，标"二手"的表示没拿到原文。

---

## 1. 一句话结论

你的两个担心都成立：上下文越长，模型确实会慢慢变差；压缩也确实每次都会丢细节，压的次数越多风险越大。所以"一直压缩"和"一直堆着不管"都不对。更好的做法是：
- 规则和进度写进文件；
- 同一个任务在自然节点处带保留要求压缩一次；
- 换任务，或者已经压过几次，就开新会话。

对你用的 1M 窗口 Opus 5.5，20 万 token 以内基本不用管。这个数是推断，Opus 5.5 本身没有公开的长上下文数据。

---

## 2. 直接回答你的两个问题

### 2.1 上下文越大，能力会下降吗？

**会，这是真的，厂商自己也承认。**
- Anthropic 的工程博客（2025-09-29）解释了原因：注意力要分给越来越多的 token，而训练数据里长文本又少，所以表现会随长度"逐渐下滑"，不是到某个点突然变差。
- Anthropic 发布 Opus 4.6 时（2026-02-05）直接说 "context rot" 是用户的常见抱怨。
- Claude API 文档写 "response quality degrades as a conversation grows"。

你看到的报道很可能说的是 Chroma 的《Context Rot》（2025-07-14）。它测了 18 个模型（Claude Opus 4 / Sonnet 4、GPT-4.1、o3、Gemini 2.5、Qwen3 等），结论是：远没塞满窗口时表现就开始下降；需要"理解意思"的查找比"找原词"的查找掉得更快；无关但相似的内容（干扰项）越多，掉得越厉害。

**从多大开始？取决于模型和任务，差别很大。**
- **旧模型掉得很早。** NoLiMa（ICML 2025）测了 13 个模型（GPT-4o、Gemini 1.5、Llama 3.3 等）。在"问题和答案没有字面重合"的任务上，32K 时有 11 个跌到短文本成绩的一半以下，GPT-4o 从 99.3% 掉到 69.7%。
- **新模型好很多，但没有消除这个问题，而且会随版本倒退。** 下表是 MRCR v2 8-needle 测试，专门考"长对话里有很多相似内容，让模型找出指定那一段"：

| 模型 | 128K–256K | 512K–1M | 来源 |
|---|---|---|---|
| Opus 4.6 | 91.9% | 78.3% | Opus 4.7 System Card（2026-04） |
| GPT-5.4 (xhigh) | 79.3% | 36.6% | 同上 |
| Gemini 3.1 Pro | 59.1% | 25.9% | 同上 |
| Opus 4.7 (max) | 59.2% | 32.2% | 同上（比 4.6 倒退了） |
| GPT-6 Astra | 100%（256K–512K） | 96.3% | OpenAI 自报，二手转述 |

   从 20 万到 100 万，大部分模型掉 14–43 个百分点。**你在用的 Opus 5.5，以及 Opus 5 和 Sonnet 5，都没有公开这类分数**。再加上 Opus 4.7 曾经倒退，所以不能默认"越新越不怕长"。
- **2026 年的新研究补充了一点**（arXiv 2608.03297，2026-08）：对 Opus 4.7、GPT-5.5 这种顶级模型，只删掉无关内容、保留有用信息，分数也不会更高，因为它们已经在天花板上；小模型（Haiku 4.5、Sonnet 4.6）删掉无关内容后会明显变好；但如果随便从中间删一段，所有模型都会崩。换句话说，对顶级模型，**真正伤害表现的是"有用信息丢了"，而不是"长度本身"**。
- **网上常引的 "Lost in the Middle"（中间位置容易被忽略）** 是 2023 年的论文，测的是 GPT-3.5 等旧模型，上下文只有约 4K token。Chroma 2025 年在新模型上测了 11 个位置，没有看到明显差别。这条不要再当作今天的规律。

**在智能体多轮对话里（也就是你在 Claude Code 和 Codex 里的日常），问题是另一种形态：**
- Laban et al.（ICLR 2026，15 个模型，含 o3、GPT-4.1、Claude 3.7 Sonnet、Gemini 2.5 Pro）发现，多轮对话比单轮平均差 39%。其中能力本身只降了 16%，"不可靠"却增加了 112%。主要原因是模型早期做了错误假设，后面就很难纠正。关键发现：**把所有信息整理成一条完整说明重新问，能恢复到单轮 95.1% 的水平**。
- LongFuncEval（2025-04）发现：工具越多、工具输出越长、轮次越多，函数调用准确率分别下降 7–85%、7–91%、13–40%。
- Anthropic 也把"堆在上下文里、已经用过的工具输出"列为 context rot 的主要来源。
- Cognition（2025-09）发现 Sonnet 4.5 会"context anxiety"：它以为自己快满了，就开始走捷径、留下没做完的事。

**所以在 Claude Code 里，真正拖累你的通常是三样东西：** 大量旧的读文件和测试日志、早期走错的方向、说过但被淹没的规则。单纯的 token 数量反而是次要的。

### 2.2 一直压缩是不是也不好？

**是，压缩一定有损。** Anthropic 的 1M GA 博客直接把压缩叫作 "lossy summarization"。Codex 源码里也有一句警告："long threads and multiple compactions can cause the model to be less accurate"。

**一次 /compact 会丢什么（Claude Code 官方文档）：**
- **会保留（摘要里）：** 你的请求和意图、关键技术概念、看过或改过的文件和重要代码片段、报错和修法、待办、当前工作。
- **会从磁盘重新加载：** 项目根目录的 CLAUDE.md、没有 `paths:` 的规则、auto memory、plan mode 写的计划、匹配 compact 的 SessionStart hook。另外会重读最近改过的最多 5 个文件，超过 5K token 的只给路径。用过的技能正文也会重新注入，每个最多 5K、总共最多 25K，超了先丢最早的，而且截断时保留开头。
- **会丢掉：** 工具输出的原文、中间推理过程、技能列表、带 `paths:` 的规则和子目录 CLAUDE.md、对话早期的详细指令。

**丢得有多严重（2026 年的新研究和一手案例）：**
- **逐字信息几乎全丢。** arXiv 2608.01326（2026-08）把 15,000 个 URL（约 500K token）放进 Opus 4.8 的上下文。不压缩时查询错误率 0.02；用 Anthropic 压缩端点压缩后，错误率约 0.5，等于瞎猜。
- **你在对话里临时说的约束最容易丢。** 《Lost in Compaction》（2026-07-31）发现，压缩器平均只保留 17% 的会话约束（例如"删邮件前先问我"），多数压缩器压缩后的遵守率还不如不压缩。这篇没测 Opus/GPT 旗舰。
- **规则还在，但模型不听了。** Claude Code issue #95745（2026-09-20，Opus 4.8 和 Opus 5，可以反复复现）：压缩后 CLAUDE.md 仍在上下文里，但"不要自己 commit"这条被违反了。目前只有这一位报告人，也没有官方回复。
- **摘要会被模型当作权威。** Opus 4.7 System Card 第 112 页记录了一个案例：一段被篡改的压缩摘要把危险命令写成"既定做法"，模型就照做了。

**但压缩并不总是坏事：**
- Anthropic 自家的搜索类评测在 **200K 就触发压缩**（Opus 4.7、Opus 5 的 BrowseComp），靠压缩把总 token 用到 1000 万，得分 79.3%。
- JetBrains（2025）在 SWE-bench 上测试（用的是 Qwen3、Gemini 2.5 Flash，没有 Claude 或 GPT）：只清掉旧工具输出，成本减半，解题率不降；用 LLM 写摘要反而让轨迹变长 13–15%。
- Anthropic 的 context editing（清理过期的工具结果）在内部搜索评测里提升 29%，配合 memory 提升 39%。评测用的模型没有披露。

**规律可以总结成一句：** 丢掉的是"以后用不上的东西"（旧日志、已经看完的搜索结果），压缩就是赚的；丢掉的是"以后还要逐字用的东西"（精确路径、报错原文、约束条件），压缩就是亏的。

**反复压缩会不会越压越差？**
- **没有任何研究画出"压缩第 N 次后掉多少"的曲线，这个查不到。**
- 间接证据都指向"会累积"：
  - 第二次压缩就是对摘要再做摘要；
  - Codex 源码自带多次压缩警告；
  - Codex issue 里有压缩循环、进度从 97% 跳回 42%（#25792）、重复做已完成的工作直到耗尽一周额度（#35935，GPT-5.6 Sol）等报告，都是单个用户；
  - ACE 论文里有一个"整体重写记忆后坍塌"的例子：18,282 token 被压成 122 token，准确率从 66.7 掉到 57.1，比完全不管理的基线 63.7 还低。不过那是另一种方法反复重写记忆，模型是 DeepSeek-V3.1，只能当类比。
- 结论：方向上可信，但**没有依据说"第几次以后一定不行"**。

---

## 3. 什么时候压缩、什么时候开新会话、什么时候不用管

| 你的情况 | 建议 | 依据强弱 |
|---|---|---|
| 同一个任务，进展顺利，Claude 上下文 < 约 200K | **不用管**，不要为了"保险"去压缩 | 中弱。Anthropic 自家评测在 200K 才压缩；Opus 4.6 在 128–256K 检索约 92%；Opus 5.5 没有数据 |
| 上下文很小（< 约 50K） | 压缩几乎没收益，只会丢细节 | 弱，是推理 |
| 同一任务到了自然节点（探索完准备动手、一个子功能做完），上下文在 200K–500K | 可以**带保留要求 /compact**，继续做也可以 | 中弱。官方文档建议"在任务之间的自然停顿处压缩，而不是等自动压缩在任务中途触发"；具体数字是推断 |
| 上下文 > 500K | 在**下一个节点主动处理**（压缩或开新会话），别等 967K 自动压缩在任务中途触发 | 中弱。新模型在 512K–1M 普遍比 256K 以内差；官方"提前压缩"的示例就是 `/autocompact 500k` |
| 走错了方向，想放弃 | 用 **/rewind** 回到之前，不要压缩（能保留缓存，也没有摘要损失） | 强，官方文档 |
| 换到不相关的任务 | 需要的话先写交接笔记，然后 **/clear 开新会话** | 强，官方文档 |
| 模型开始忘规则、重复已做完的工作、绕圈子 | 停下来，整理一份完整说明，**开新会话** | 中强。Laban：整理成一条完整说明能恢复到 95.1%；另有多个 issue |
| 同一会话已压缩 2 次以上，还要做很久 | 写交接笔记后**开新会话** | 弱，经验值，没有研究曲线 |
| 接下来要大量用到逐字细节（路径、报错原文、约束） | **先写进文件**，再压缩或开新会话 | 中。2608.01326、Lost in Compaction |
| 要离开超过缓存时间，回来还做同一件事，上下文 ≥150K | 离开前带保留要求压缩；细节关键的话先写进度文件 | 成本机制强（官方）；金额见下方估算 |
| Codex（272K 窗口，约 232K 自动压缩） | 长任务几乎一定会压缩。在节点处主动收尾；看到连续压缩或进度回退就开新会话 | 中弱。源码分析加 issue |

**缓存和成本（官方 prompt-caching 文档）：**
- **缓存时长：** 订阅用户在额度内，主会话缓存 1 小时；用 API key、云平台，或者超出额度改用 credits 时，是 5 分钟。
- **什么时候压缩便宜：** 缓存还热时，/compact 按"缓存读"价读全文，很便宜。缓存过期后，不管是继续聊还是压缩，都要全价重读，这时压缩最贵。
- **估算（按 Opus 5.5 官方价）：** 缓存读 $0.20/M，写缓存 $5/M，普通输入 $4/M。以 400K 上下文为例，缓存热时压缩读全文约 $0.08；过期后重读约 $1.6–2.0。订阅用户扣的是额度，比例相同。

**顺带说明：** 网上流传"用到 40–50% 就手动压缩"的说法，查不到方法论，也没有官方背书，不要当依据。

---

## 4. 降低压缩损失的做法（按证据强弱排序）

**强**
1. **长期规则写进项目根目录 CLAUDE.md，不要只在对话里说。**
   - 官方文档明确说根 CLAUDE.md 会在压缩后从磁盘重新加载；带 `paths:` 的规则和子目录 CLAUDE.md 会被摘要掉。
   - 会话里临时说的约束平均只剩 17%（Lost in Compaction）。
   - 技能文件里重要的内容放在开头，因为截断时保留开头。
2. **换任务就 /clear，不要压缩后接着干别的。** 官方原话是 "Clear between tasks"。
3. **长任务用进度文件加 git 提交做交接。**
   - Anthropic《Effective harnesses for long-running agents》（2025-11-26，Opus 4.5）直接说 "compaction isn't sufficient"，推荐进度文件、功能清单加 git 历史。
   - Laban 的实验说明"整理成一份完整说明"能找回绝大部分表现。
   - 注意：Cognition 发现模型自己写的笔记常常不全，所以交接笔记要**你自己看一眼**。

**中**

4. **在任务边界压缩，不要在任务中途压缩。** 官方缓存文档建议在自然停顿处 /compact。issue #28728 里，自动压缩在中途触发失败，用户最后只能 /clear。这条没有对照实验。
5. **/compact 带保留要求**，例如 `/compact 保留：任务目标、已做的决定和原因、未解决的问题、正在改的文件路径、不要自动 commit`。也可以在 CLAUDE.md 里写一段 Compact Instructions。这是官方建议；另外，专门抽取约束的方法能保留 90% 以上的约束，远高于通用压缩的 17%。
6. **走错路用 /rewind，不要压缩。** 如果只想压缩其中一段，用 /rewind 的 "Summarize from here / up to here"。这是官方功能。
7. **大量读文件、搜索交给子智能体**，它只把 1–2K token 的结论带回主会话。这是官方建议。注意：常被引用的"多智能体提升 90.2%"主要来自多花 token（约 15 倍），不能当作"隔离比压缩好"的证据。
8. **优先清理旧工具输出，其次才是整段摘要。** Claude Code 的自动流程本来就是先清旧工具输出、再做摘要。证据是 JetBrains（非 Claude 模型）和 Anthropic 的 context editing（没披露模型）。

**弱**

9. **压缩后检查关键约束还在不在**，尤其是 commit、push、删除这类权限；必要时让模型重读 CLAUDE.md 和进度文件。关键禁令可以用 SessionStart（compact）hook 重新注入：#95745 里 hook 注入的指令在压缩后仍被遵守，但只有这一个报告。
10. **留意压缩次数**，压过几次就考虑开新会话。这只是经验，没有阈值研究。

---

## 5. 证据表

| 结论 | 证据 | 出处 | 日期 | 强弱 |
|---|---|---|---|---|
| 上下文变长会逐渐变差，是架构性问题 | Anthropic 机制解释；官方建议压缩、清理工具输出、换任务开新会话 | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | 2025-09-29 | 强（厂商） |
| 远没到窗口上限就变差；干扰项越多越差 | 18 个模型的独立基准 | https://www.trychroma.com/research/context-rot | 2025-07-14 | 强（测的是 2025 年中及更早的模型） |
| 理解类查找比找原词退化更早：32K 时 13 个模型中 11 个跌破一半，GPT-4o 99.3%→69.7% | NoLiMa, ICML 2025 | https://arxiv.org/abs/2502.05167 | 2025-02 | 强（2024–25 年的模型） |
| 长文档深度推理：最佳模型直接作答 50.1%，人类专家 53.7%（503 题） | LongBench v2 | https://arxiv.org/abs/2412.15204 | 2024-12-19 | 中（旧模型） |
| "中间位置被忽略"只适用于旧模型：约 4K token，GPT-3.5 最多降 20% 以上；Chroma 在新模型上没看到明显位置差异 | Lost in the Middle（TACL）；Chroma | https://arxiv.org/abs/2307.03172 | 2023-07 | 不适用于今天的模型 |
| 新模型从 256K 到 1M 仍然会掉：Opus 4.6 91.9→78.3，GPT-5.4 79.3→36.6，Gemini 3.1 Pro 59.1→25.9，Opus 4.7 59.2→32.2 | MRCR v2 8-needle | https://www-cdn.anthropic.com/037f06850df7fbe871e206dad004c3db5fd50340/Claude%20Opus%204.7%20System%20Card.pdf | 2026-04 | 中强（厂商自报） |
| Opus 4.6 在 1M 下 76%，Sonnet 4.5 为 18.5%；官方承认 context rot 是常见抱怨 | 发布文 | https://www.anthropic.com/news/claude-opus-4-6 | 2026-02-05 | 中强（厂商） |
| GPT-6 Astra 在 512K–1M 为 96.3% | OpenAI 自报，Vellum 转述 | https://www.vellum.ai/blog/gpt-6-astra-benchmarks-explained | 2026-09-03 | 弱（二手） |
| 顶级模型删掉无关内容也不涨分，小模型会涨；随意删中间内容则全部崩 | BABILong / GraphWalks 截断实验 | https://arxiv.org/abs/2608.03297 | 2026-08-04 | 中（新论文，未见复现） |
| 多轮对话平均降 39%，主要是不可靠（+112%）；整理成一条完整说明恢复到 95.1% | 15 个模型，20 万+ 模拟对话 | https://arxiv.org/abs/2505.06120 | 2025-05（ICLR 2026） | 强 |
| 工具多、输出长、轮次多，函数调用准确率分别降 7–85%、7–91%、13–40% | LongFuncEval | https://arxiv.org/abs/2505.10570 | 2025-04-30 | 中（模型名单未核实） |
| 模型以为快满时会走捷径（context anxiety） | Sonnet 4.5 实践 | https://cognition.com/blog/devin-sonnet-4-5-lessons-and-challenges | 2025-09-29 | 中（实践者） |
| /compact 保留什么、丢什么、从磁盘重载什么 | 官方文档 | https://code.claude.com/docs/en/context-window | 2026-09 访问 | 强 |
| 1M 窗口模型（Opus 4.7 及以后、Sonnet 5）默认约 967K 自动压缩；可用 /autocompact 在 100K–1M 之间调 | 官方文档 | https://code.claude.com/docs/en/model-config | 2026-09 访问 | 强 |
| 缓存热时压缩便宜、冷时最贵；订阅 1h / API 5min；建议在任务间停顿时压缩 | 官方文档 | https://code.claude.com/docs/en/prompt-caching | 2026-09 访问 | 强 |
| 压缩后逐字查询接近瞎猜（错误率 0.02→约 0.5） | Opus 4.8，约 500K token | https://arxiv.org/abs/2608.01326 | 2026-08-02 | 中（只测了一种任务） |
| 压缩器平均只保留 17% 的会话约束 | Lost in Compaction | https://arxiv.org/abs/2608.11242 | 2026-07-31 | 中（没测旗舰模型） |
| 压缩后 CLAUDE.md 还在但不被遵守（Opus 4.8 / Opus 5） | issue #95745 | https://github.com/anthropics/claude-code/issues/95745 | 2026-09-20 | 弱中（单人，可复现） |
| 压缩摘要会被模型当作权威执行 | System Card 第 112 页 | 同上 Opus 4.7 System Card | 2026-04 | 中 |
| Anthropic 自家评测在 200K 就压缩，BrowseComp 靠压缩得 79.3% | System Card | 同上 | 2026-04 | 中强（搜索任务，不是编码） |
| 只清旧工具输出：成本减半、解题率不降；LLM 摘要让轨迹长 13–15% | SWE-bench，Qwen3 / Gemini 2.5 Flash | https://arxiv.org/abs/2508.21433 ；https://blog.jetbrains.com/research/2025/12/efficient-context-management/ | 2025-08 / 2025-12 | 中 |
| context editing +29%，配合 memory +39%，token 降 84% | 内部搜索评测，未披露模型 | https://claude.com/blog/context-management | 2025-09-29 | 中 |
| 优化过的压缩：峰值 token 降 26–54%，小模型最多 +46% | ACON, ICML 2026 | https://arxiv.org/abs/2510.00615 | 2026-06 修订 | 中 |
| 光靠压缩不够，要用进度文件加 git 交接 | Anthropic 长程智能体博客（Opus 4.5） | https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents | 2025-11-26 | 强（厂商） |
| 整体重写记忆会坍塌：18,282→122 token，66.7→57.1，低于基线 63.7 | ACE（DeepSeek-V3.1，不是 /compact） | https://arxiv.org/abs/2510.04618 | 2025-10 | 弱（类比） |
| Codex 约 272K×95%×90% ≈ 232K 触发；源码警告多次压缩会降低准确性 | 源码分析 | https://gist.github.com/osolmaz/a38acf6e522df67530e3ed47c80fdcd5 | 2026-07 | 中（实践者） |
| Codex 压缩后进度回退、重复做工、耗尽周额度 | issue #25792、#35935、#35032 | https://github.com/openai/codex/issues/35935 | 2026-06 / 07 | 弱（都是单人报告） |
| 多智能体 +90.2%，但约 15 倍 token，差异的 80% 由 token 量解释 | Anthropic 多智能体博客 | https://www.anthropic.com/engineering/multi-agent-research-system | 2025-06-13 | 中（不能当"隔离更好"的证据） |
| 压缩要"可恢复"（保留 URL 和路径）；缓存命中很重要 | Manus 工程博客 | https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus | 2025-07-18 | 中（实践者） |
| Anthropic 说法前后不一：一处说"1M 全程保持准确"，另一处说"质量随对话变长下降" | 1M GA 博客；API 压缩文档 | https://claude.com/blog/1m-context-ga ；https://platform.claude.com/docs/en/build-with-claude/compaction | 2026-03-13 | 说明厂商口径不统一 |
| "40–50% 就手动压缩" | 个人博客，没有方法论 | https://www.mindstudio.ai/blog/how-to-stop-burning-through-claude-code-tokens-context-management-guide-beginners | 未知 | 查不到依据，不采用 |

---

## 6. 还不确定的地方

1. **你实际在用的 Opus 5.5 没有公开的长上下文分数**，Opus 5 和 Sonnet 5 也没有。Opus 4.7 比 4.6 明显倒退过，所以上面的 200K、500K 分区只是推断，不是实测。
2. **没有"压缩 N 次后掉多少"的研究。** "多次压缩更差"只有间接证据：机制推理、Codex 的警告和单人 issue。
3. **编码任务缺少对照实验。** 搜索类任务压缩后反而提分，逐字查找类任务压缩后接近瞎猜，编码大概在两者之间，但没人测过。
4. **2026 年的旗舰数据大多是厂商自报**，例如 GPT-6 Astra 的 96.3%、Opus 系列的 System Card。独立复测（如 Context Arena、Fiction.LiveBench）这次没拿到。
5. **CLAUDE.md 压缩后明明重新加载了却不被遵守（#95745），原因不明**，也没有官方回复。
6. **Anthropic 自己的说法不一致**：1M GA 博客说"全程保持准确"，其他文档说"质量会随长度下降"。
7. 很多 GitHub issue 是单个用户的报告；Claude Code #13919 打不开，#10948、#13112、#4517 没有核实原帖，这次都没有采用。
8. OpenAI 的缓存 TTL 规则，以及 Codex 开 1M 窗口的配置方式，这次没核实到一手资料。
