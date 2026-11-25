# Vernier 实施路线

> 写于 2026-11-25。配套阅读 [`extension-plan.md`](./extension-plan.md)（**扩展什么**），本文回答**按什么顺序做、每步做完怎么算过关**。
> 文中所有数字分两类：**已核实**（标注来源）和**待实测**（写成 `TBD`）。简历上只能写实测出来的那一类。

---

## 0. 三条贯穿始终的纪律

这三条如果破了，项目就退化成"又一个 Claude Code 仿写"：

1. **评测先于机制。** M2 的基线表必须在任何插件之前跑出来。没有基线，后面每个机制都是自我感动。
2. **内核不认识任何机制。** `packages/kernel` 里不许出现 `compaction`、`memory`、`planner` 这些词。由 `test/architecture.test.ts` 强制，CI 红了就是破了。
3. **一份 trace 两处用。** 事件总线写一份 JSONL，Web 面板和评测报告都读它。绝不写第二套埋点。

---

## 1. 前置条件（已就绪）

| 项 | 状态 | 位置/值 |
| --- | --- | --- |
| Node | ✅ v24.21.0 | 原生 TS 类型剥离，无构建步骤 |
| 模型 | ✅ 实测可用 | `deepseek-flash`（DeepSeek V4.1 Flash），1M 上下文 |
| API Key | ✅ | `~/.config/vernier/env`（权限 600），变量 `DEEPSEEK_API_KEY` |
| 单价（来自 pi-ai 目录） | ✅ | 输入 $0.30/M，输出 $1.20/M，**缓存读 $0.006/M**，缓存写 $0 |
| 仓库 | ✅ | `github.com/sheryyz/vernier`，SSH 推送已通 |
| Docker | ⬜ 待确认 | M2 需要，届时验证 |

---

## 2. 里程碑总览

| M | 名称 | 日期 | 工时 | 产出 | 卖点 |
| --- | --- | --- | --- | --- | --- |
| M0 | 骨架 + 内核协议 | 11/25 | 0.5d | ✅ `daf5445` | |
| M1 | 最小闭环 | 11/25 | 0.5d | ✅ 真实模型修好了一个 bug | |
| M2 | **评测骨架** | 11/28–11/30 | 3d | 第一张基线表 | ⭐ |
| M3 | 内核化（8 Hook） | 12/01–12/03 | 3d | 任意插件可关 | ⭐ |
| M4 | 工具加固 + 会话 | 12/04–12/05 | 2d | B1 对照 | |
| M5 | **两段式压缩** | 12/06–12/08 | 3d | B2 对照 + 缓存指标 | ⭐⭐ |
| M6 | 长期记忆 | 12/09–12/11 | 3d | B3 对照 | ⭐ |
| M7 | 计划 + Prompt 改写 | 12/12–12/13 | 2d | B4 对照 | |
| M8 | **全量消融** | 12/14–12/16 | 3d | 完整报告 | ⭐⭐ |
| M9 | Web 轨迹面板 | 12/17–12/19 | 3d | SSE 可视化 | |
| M10 | README + 简历定稿 | 12/20 | 1d | 可复现的表 | |

合计 **25 个工作日**。M9 是唯一可砍项（时间紧时直接跳到 M10）。

---

## 3. 逐个里程碑

### M1 — 最小闭环（11/25，✅ 完成）

**目标**：一条命令让 `deepseek-flash` 真的改掉工作区里的一个文件。

**要写的文件**

```
packages/kernel/src/services.ts       ModelService / ToolService / ToolSpec 接口
packages/providers/src/model.ts       pi-ai 包一层，kernel Message ↔ pi-ai Message
packages/providers/src/deepseek.ts    createDeepSeekModel()
packages/providers/src/faux.ts        createFauxModel(scripted)  ← 离线测试用
packages/tools/src/{read,write,edit,bash}.ts
packages/tools/src/registry.ts        ToolService 实现
packages/runtime/src/loop.ts          裸循环（模型→工具→结果），预算 + AbortController
packages/cli/src/main.ts              入口
```

**关键设计决策**

- **assistant 消息存 `raw`**：DeepSeek 的 compat 里写着 `requiresReasoningContentOnAssistantMessages: true`，意思是回传历史时 assistant 消息必须带上 `reasoning_content`。如果我们用自己的 Message 类型重建，这个字段就丢了，多轮会出问题。所以 kernel 的 `Message` 带一个 `raw?: unknown` 存 provider 原生对象，只有 `providers` 包认识它。压缩插件改写消息时必须同步处理 `raw`，否则缓存和推理连续性一起坏掉。
- **思考等级必须固定**：实测 `deepseek-flash` 默认就会产生 `reasoning_content`。推理长度波动会同时污染成本和方差，所以从 M1 起就把 `reasoning` 作为显式参数固定下来，并记进每次 run 的元数据。
- **循环先写单层**：pi 的 `agent-loop.ts` 是双层（内层工具轮次、外层续跑决策），我们 M1 只要内层。外层的续跑语义等 M7 planner 需要时再加。

**验收**（三条都要过）

```sh
npm test                                   # faux 模型离线跑通「读 README → 回答」，断言 2 次请求 / 1 次工具 / id 配对
node packages/cli/src/main.ts "把 demo.txt 里的 foo 改成 bar"   # 真实模型改掉文件
node packages/cli/src/main.ts --probe-cost "..."                # 打印 token、缓存命中、美元数
```

第三条是**成本探针**，M1 就要有。别等到 M8 才发现跑不起。

**实测结果（2026-11-25）**：两个真实任务都一次做对——改字符串（4 轮 / 3 次工具 / 4.6s / $0.00090）和修 Python 断言失败（5 轮 / 5 次工具 / 5.2s / $0.00084）。
两个值得记下的观察：
- **裸循环的缓存命中率已经有 62%–69%**。这是 B0 基线，M5 的压缩必须以不破坏它为前提。
- **单任务成本比预算估得低一个量级**（$0.0009 vs 估算 $0.038）。但这是 5 轮的小任务，M2 的真实 benchmark 任务会长得多，预算先不调。

**坑**：工作区路径约束要在 M1 就加（`resolveInside(cwd, path)`，越界直接拒）。否则真实模型一旦写错路径会动到仓库外的文件。

---

### M2 — 评测骨架（11/28–11/30，3 天）⭐

**目标**：`npm run eval -- --profile B0` 吐出第一张基线表。**这是整个项目的转折点**——在此之前是在写代码，在此之后是在做实验。

**要写的文件**

```
packages/evals/src/task.ts        任务 schema 与加载
packages/evals/src/docker.ts      容器隔离 + git 快照重置
packages/evals/src/runner.ts      按 profile 跑一批任务
packages/evals/src/judge.ts       可执行断言判定（LLM-as-Judge 兜底留空接口）
packages/evals/src/report.ts      trace JSONL → 指标表
profiles/B0.json
benchmarks/fixtures/<3 个起步仓>
benchmarks/tasks/<3 个起步任务>
```

**任务 schema**

```
benchmarks/tasks/bugfix-01/
  task.json      { id, category, difficulty, prompt, fixture, timeoutMs, budget }
  patch.diff     注入的 bug（可选）
  verify.sh      退出码 0 = 通过
```

**判定方式的优先级**（这条是和参考简历拉开差距的关键）

| 优先级 | 方式 | 适用 |
| --- | --- | --- |
| 1 | 跑原有单测 | Bug 修复、重构 |
| 2 | 跑任务自带的测试文件 | 功能实现 |
| 3 | 结构断言（grep / AST / git diff 检查） | 重构、写测试 |
| 4 | LLM-as-Judge | **只有代码理解问答用**，且必须双盲复核 |

**M2 必须完成的一件事：难度校准。** 3 个起步任务跑 Baseline，**成功率要落在 40%–70%**。
- 全过（天花板效应）→ 后面所有机制都显示"无提升"，实验白做
- 全挂（地板效应）→ 同理
校准不过就调任务难度，这一步宁可多花半天。

**验收**

```sh
npm run eval -- --profile B0 --tasks smoke
# 产出 reports/<时间戳>/summary.md，含 7 项指标
# 同一任务连跑 2 次，docker 快照重置生效（第二次起点干净）
```

---

### M3 — 内核化（12/01–12/03，3 天）⭐

**目标**：把 M1/M2 里硬编码的逻辑**反向重构**成插件，8 个 Hook 全部实装。

**为什么是反向重构而不是一开始就写对**：先让它跑起来再切边界，你才知道边界该切在哪。一开始就设计插件系统，切出来的一定是想象中的边界。

**要写的文件**

```
packages/kernel/src/registry.ts     Service 注册 + 依赖校验（validateDependencies 已有）
packages/kernel/src/hooks.ts        Hook 调度，带 order
packages/kernel/src/kernel.ts       生命周期 + 事件总线
packages/runtime/src/loop.ts        改造：在 8 个切点广播
```

**验收**（第二条是这个里程碑真正的价值）

```sh
npm test
npm run test:subset-ablation   # 随机关闭任意插件子集，B0 任务仍跑通
```

第二条测试本身就是"插件化是真的"的证明，README 里要引用它。

---

### M4 — 工具加固 + 会话（12/04–12/05，2 天）

**目标**：`tool-hardening` 插件 + JSONL 会话 + `--continue`。

**tool-hardening 做四件事**
1. 超时（每个工具独立超时，传递 AbortSignal）
2. 重试（只重试 `retryable: true` 的错误）
3. 输出截断（超限的部分落盘，消息里留 `<elided bytes=N ref=tool_7>`）
4. **错误结构化回灌**：模型拿到的不是一坨 stderr，而是 `{kind, message, retryable}`

**验收**

```sh
npm run eval -- --profile B1        # 对比 B0
npm test -- fault-injection         # 注入超时/报错/超大输出三类故障，模型能恢复
npm test -- resume                  # 三处强制中断后恢复，不重复写文件
```

---

### M5 — 两段式压缩（12/06–12/08，3 天）⭐⭐

**目标**：这是项目**第一个研究性卖点**。

**pi 的做法**（`compaction.ts:267`）：`contextTokens > contextWindow - reserveTokens` 就触发，保留最近 N token，更早的整段丢给 LLM 摘要。

**我们的做法**

```
阶段一（零模型调用）：把 N 轮之前的工具输出折叠成 <elided bytes=12345 ref=tool_7>
                      原文落盘，模型可按 ref 取回
    ↓ 仍超阈值？
阶段二（有成本）：     调模型做结构化摘要
    ↓ 全程约束
前缀字节稳定：         system prompt / 任务目标 / 早期稳定段永不改写
```

**为什么前缀稳定这么重要**：缓存读 $0.006/M vs 新输入 $0.30/M，差 50 倍。摘要重写历史会让前缀整体失效，下一轮全按新输入计价。**所以"省 token"和"省钱"可能方向相反**——这正是我们要用实验回答的问题。

**要新增的指标**：`cache_hit_rate = cacheRead / (cacheRead + input)`。
pi-ai 已经把 DeepSeek 的 `prompt_cache_hit_tokens` 映射成 `usage.cacheRead`（`api/openai-completions.ts:1529`），所以这个指标**不需要额外埋点**。

**验收**

```sh
npm test -- compaction      # faux 模型下断言"实际发出的消息"结构符合预期
npm run eval -- --profile B2
```

期望看到的结论形态（数字待实测）：

> 朴素压缩 token 降 `TBD`%，但缓存命中率从 `TBD`% 掉到 `TBD`%，实际成本变化 `TBD`；
> 前缀稳定的两段式压缩 token 降 `TBD`%，缓存命中率保持 `TBD`%，成本下降 `TBD`%。

---

### M6 — 长期记忆（12/09–12/11，3 天）⭐

**目标**：补上 pi 完全没有的能力。

**设计**

| 环节 | 做法 |
| --- | --- |
| 存储 | `memory/*.md`，一条一个文件，frontmatter 带类型与摘要 |
| 索引 | 一份 `INDEX.md`，每条一行，**始终在上下文里**（所以索引行必须短） |
| 写入 | agent 主动调 `memory_write` 工具；`onSessionEnd` 再自动抽取一次 |
| 读取 | `beforeRequest` 按任务相关性注入 |
| 淘汰 | 条数上限 + 冲突时覆盖旧条目 |

**验收**：设计一组**连续任务**（同一仓库连做 3 个相关任务），对比有无记忆时第 2、3 次的模型轮数。
这是记忆唯一能体现价值的场景——单次独立任务上它必然无增益，报告里要**如实写出来**。诚实地报告"某机制在某类任务上无效"，比处处有效更可信。

---

### M7 — 计划 + Prompt 改写（12/12–12/13，2 天）

- `planner`：提供 `plan` 工具，`onTurnEnd` 推进，把长任务拆成可勾选步骤回灌
- `prompt-optimizer`：仅首轮触发，把模糊需求改写成可执行描述

**验收**：`npm run eval -- --profile B3` / `B4`，并**按任务类别拆开看**——planner 预期只在重构和功能实现类上有效。

---

### M8 — 全量消融（12/14–12/16，3 天）⭐⭐

**目标**：任务集扩到 25 个，6 组 profile × 3 次重复，出完整报告。

**profile 定义**

| id | 开启的插件 | 想证明 |
| --- | --- | --- |
| B0 | （无） | 基线 |
| B1 | tool-hardening | 工具失败数↓、轮数↓ |
| B2 | + context-compaction | token↓ 且缓存命中率保持 |
| B3 | + memory | 连续任务轮数↓ |
| B4 | + planner, prompt-optimizer | 长任务成功率↑ |
| F | 全开 | 综合效果 |

**任务集构成**（25 个）

| 类别 | 数量 | 判定方式 | 生成方式 |
| --- | --- | --- | --- |
| Bug 修复 | 6 | 原单测转绿 | 脚本注入 bug（改边界条件、反转判断） |
| 功能实现 | 5 | 任务自带测试通过 | 先写测试，留空实现 |
| 重构 | 5 | 原测试仍绿 + 结构断言 | 指定提取函数/改接口 |
| 写测试 | 4 | 新测试通过 + 覆盖率提升 | 指定未覆盖模块 |
| 代码理解 | 5 | LLM-as-Judge + 人工复核 | 可复用 pi-notes 里的自测题 |

**实验口径**（这段直接决定报告可不可信）

- **固定不变**：模型 `deepseek-flash`、思考等级、温度、工具集、预算（轮数/工具调用/时长）、Docker 镜像、fixture 的 git 快照
- **重复**：每任务每配置跑 3 次。单任务得分 ∈ {0, 1/3, 2/3, 1}
- **报告**：配置得分 = 25 个任务的均值；**同时给出 3 次重复间的标准差**
- **配对比较**：所有配置跑同一批任务，比较时用配对差值，不是独立样本
- **诚实声明**：n=25，样本小。报告里必须写明"3 个任务的差距在 n=25 下不具统计显著性"这类限制

> 这一段是和参考简历拉开最大差距的地方。他的"90% vs 75%"是单次运行的 18/20 vs 15/20——3 个任务的差距完全可能是 LLM 本身的波动。面试官只要问一句"怎么排除随机性"，就答不上来。

**验收**

```sh
npm run eval -- --all-profiles --repeat 3
# reports/<时间戳>/ 下有：每次 run 的原始 trace JSONL + summary.md（带方差的汇总表）
```

---

### M9 — Web 轨迹面板（12/17–12/19，3 天，可砍）

SSE 订阅 M3 就在写的那份 trace JSONL，实时渲染决策与工具轨迹。
**不新增埋点**——如果发现面板需要的数据 trace 里没有，那是 trace 设计漏了，去补 trace，不是补第二套。

---

### M10 — README + 简历定稿（12/20，1 天）

- README 放消融表 + 2 张图（成功率对比、成本/缓存命中对比）
- 写明复现步骤：别人 clone 之后能跑出同样的表
- 把 `TBD` 全部替换成实测数字

---

## 4. 指标定义

全部从 trace JSONL 算出，不额外埋点：

| 指标 | 定义 |
| --- | --- |
| 成功率 | `verify.sh` 退出码 0 的比例，3 次重复取均值 |
| 模型轮数 | 模型请求次数 |
| 工具调用数 / 失败数 | `afterToolCall` 事件数 / 其中 `ok:false` 的数 |
| Token | 分别记 `input`(未命中) / `cacheRead` / `output` / `reasoning` |
| **缓存命中率** | `cacheRead / (cacheRead + input)` |
| 端到端时延 | 会话开始到结束的墙钟时间 |
| **成本** | 按目录单价算：input×0.30 + output×1.20 + cacheRead×0.006（每 M token，美元） |

---

## 5. 成本预算

**单 run 估算**（15 轮、上下文 5k→40k、输出每轮 ~800 token）

| 场景 | 单 run | 450 run（6 配置 × 25 任务 × 3 次） |
| --- | --- | --- |
| 无缓存命中 | ≈ $0.104 | ≈ **$47**（¥340） |
| 缓存命中 75% | ≈ $0.038 | ≈ **$17**（¥125） |

加上开发调试期的零散调用，**整体预算按 ¥300–700 准备**。

**两个会让成本翻倍的变量，必须在 M1 就控制住**：
1. **思考等级**。`deepseek-flash` 默认产生 `reasoning_content`，而 reasoning token 按输出价（$1.20/M）计。开 high 可能让输出翻 3–5 倍。
2. **缓存命中率**。这既是实验对象也是成本杠杆——50 倍价差。

**硬措施**：runner 带 `--max-cost` 全局上限，超了直接中止并保留已完成结果。

---

## 6. 风险清单

| 风险 | 概率 | 后果 | 应对 |
| --- | --- | --- | --- |
| 任务难度没校准（天花板/地板效应） | 高 | 所有机制显示"无提升"，实验白做 | M2 强制校准到 40–70%，不过关不进 M3 |
| 方差淹没差异 | 高 | 结论不可信 | 3 次重复 + 配对比较 + 如实报告显著性限制 |
| 成本超支 | 中 | 跑不完 M8 | M1 成本探针 + runner `--max-cost` |
| DeepSeek 限流 | 中 | M8 跑不动 | 并发上限 + 指数退避重试 + 断点续跑 |
| 时间超支 | 中 | 赶不上投递 | M9 可砍；M8 的 25 任务可降到 20 |
| 某机制实测无效 | 中 | 卖点变弱 | **照实写**。能说清"为什么无效"比假装有效更有说服力 |

---

## 7. 最终产出形态

**README 的核心表**（数字待实测）

| 配置 | 成功率 | 模型轮数 | 工具失败 | Token | 缓存命中 | 成本 | 时延 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B0 基线 | TBD±TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| … | | | | | | | |
| F 全开 | TBD±TBD | TBD | TBD | TBD | TBD | TBD | TBD |

**简历条目**（M10 填数字）

> **Vernier —— 可测量的插件化 Coding Agent Harness（TypeScript / Node.js / DeepSeek）**
> 1. **插件化 Agent Runtime**：自研 Model→Tool→Result 循环与内核协议，机制通过 8 个生命周期 Hook 解耦为可开关插件，依赖校验与分层边界由测试强制；支持任意插件子集独立关闭。
> 2. **两段式上下文压缩**：先按规则零成本折叠历史工具输出，仍超阈值才触发模型摘要，并保持请求前缀字节稳定以保护 KV 缓存；相比单段式摘要压缩调用降低 `TBD`%、缓存命中率保持 `TBD`%。
> 3. **跨会话长期记忆**：Markdown 文件 + 常驻索引 + 会话后自动抽取，连续任务平均模型轮数由 `TBD` 降至 `TBD`。
> 4. **消融评测体系**：25 任务 / 5 类 Benchmark，Docker 隔离 + git 快照重置 + 可执行断言判定（LLM-as-Judge 仅兜底）；6 组配置 × 3 次重复，报告成功率、轮数、工具失败、Token、**缓存命中率**、成本、时延 7 类指标及方差。

**面试时能展开 10 分钟的点**：压缩省 token 与省钱可能方向相反，以及你是怎么用实验回答它的。

---

## 8. 下一步

M1。先写 `packages/kernel/src/services.ts` 和 `packages/providers`，当天让它改掉第一个文件。
