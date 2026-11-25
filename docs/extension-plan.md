# pi-evolve 扩展方案：pi 有什么，我们补什么

> 写于 2026-11-25。pi 侧的结论全部来自 commit `d57c2d21` 的源码，文件路径从 pi 仓库根算起。
> 本文回答一个问题：**"基于 pi 做扩展"具体扩展什么，补完之后为什么算一个完整的 agent。**

---

## 0. 先澄清：我们不 fork pi

"基于 pi"有三种完全不同的含义，先把我们选的那种钉死：

| 做法 | 含义 | 我们选吗 | 原因 |
| --- | --- | --- | --- |
| **Fork pi 改源码** | 在 pi 仓库里加功能 | ❌ | pi 有 12 个包、几万行代码。你加的那几百行淹没在里面，面试时说不清哪部分是你的 |
| **当 SDK 全量用** | `npm i pi-agent-core`，调它的 Agent | ❌ | 那循环就是别人的。"你的 Agent Loop 怎么设计的"这个必问题你没得答 |
| **拆开用：电池用它的，发动机自己造** | 只用 `pi-ai` 做模型接入，循环/内核/机制全部自己写，其余部分读源码学思想 | ✅ | 脏活不重复造，核心能力是自己的代码 |

一句话：**pi 是教材 + 电池，不是地基。**

---

## 1. pi 现在有什么（事实清单）

### 1.1 十二个包

| 包 | 做什么 | 规模/证据 |
| --- | --- | --- |
| `pi-ai` | 模型接入层。30+ 厂商 provider（含 `deepseek`）、鉴权、流式、工具调用的协议转换、假模型 | `packages/ai/src/providers/` 下 40+ 文件；`deepseek.ts` 已内置 |
| `pi-agent-core` | Agent 循环与状态机、事件流、工具执行 | `agent-loop.ts` 1187 行，`agent.ts` 783 行 |
| `pi-coding-agent` | 真正的 CLI 产品：工具、会话、压缩、技能、斜杠命令、扩展、MCP、TUI | `src/core/` 下 60+ 文件 |
| `pi-codemode` | 沙箱里跑 JS，唯一能力是调注入的工具 | 独立包 |
| `pi-mcp` | MCP 客户端 | 独立包 |
| `pi-durable` | 可恢复任务、检查点、重放 | 独立包 |
| `pi-env` | 通过 SSH 部署的远程执行环境 | 独立包 |
| `pi-evals` | 评测运行器：Docker 隔离 + 计划 + 报告 | `src/{cli,docker,harness,plan,report}.ts` |
| `pi-tui` | 终端 UI 差分渲染 | 独立包 |
| `pi-schema` / `pi-telemetry` / `chord` | JSON Schema 校验 / 遥测契约 / 跨进程对象运行时 | 基础设施 |

### 1.2 按"agent 能力"重新切一遍

这张表才是重点——**左边是一个完整 agent 需要的能力，右边是 pi 的真实状态**：

| 能力 | pi 的状态 | 证据（文件:行） |
| --- | --- | --- |
| 模型接入 | ✅ 很完整 | `packages/ai/src/models.ts` 的 `createModels/getModel/streamSimple/completeSimple` |
| Agent 循环 | ✅ 完整，双层循环（外层管续跑，内层管工具轮次） | `packages/agent/src/agent-loop.ts:253`（外）`:258`（内） |
| 工具集 | ✅ read/write/edit/bash/grep/find/ls + 输出截断 | `packages/coding-agent/src/core/tools/` |
| 工具钩子 | ⚠️ 只有两个：`beforeToolCall` / `afterToolCall` | `packages/agent/src/types.ts` |
| 上下文改写 | ⚠️ 有 `transformContext` / `convertToLlm` 两个回调 | `agent-loop.ts:511` 附近 |
| 上下文压缩 | ✅ 有，但是单段式 LLM 摘要 | `core/compaction/compaction.ts` 1104 行 |
| 压缩触发 | ✅ `contextTokens > contextWindow - reserveTokens` | `compaction.ts:267` `shouldCompact()` |
| 会话持久化 | ✅ JSONL 追加写，支持恢复 | `core/session-manager.ts:1081`，文件名 `<时间戳>_<id>.jsonl` |
| 静态项目上下文 | ✅ 自动加载 `AGENTS.md` / `CLAUDE.md` | `core/resource-loader.ts:213` |
| 技能（Skills） | ✅ 目录里放 `SKILL.md`，按需加载 | `core/resource-loader.ts:856`、`core/skills.ts` 505 行 |
| 扩展机制 | ✅ 庞大的 `ExtensionAPI` | `core/extensions/types.ts:1637` |
| MCP | ✅ 客户端完整 | `pi-mcp` 包 |
| 评测 | ✅ 有，但服务于 pi 自己 | `packages/evals/src/harness.ts:257` `verifySystemPrompt()` |
| **跨会话长期记忆** | ❌ **没有** | 见 2.1 |
| **机制级可插拔 + 消融** | ❌ **没有** | 见 2.3 |
| **子 agent** | ❌ 没有 | 全仓搜 `subagent` 只在 codemode 里出现一次 |
| **成本/缓存可观测** | ⚠️ 有 usage 统计，但不做缓存命中分析 | `packages/ai/src/types.ts:467` `Usage` |

---

## 2. pi 的四个空白（我们的机会）

### 2.1 没有跨会话的长期记忆

pi 有的是两样**静态**东西：

- `AGENTS.md` / `CLAUDE.md`：你手写的项目说明，每次会话原样注入（`resource-loader.ts:213`）
- `SKILL.md`：你手写的技能包，按需加载（`resource-loader.ts:856`）

还有一样**流水账**：会话 JSONL（`session-manager.ts:1081`）。

缺的是中间那层：**agent 自己从历史会话里提炼出知识、写下来、下次自动检索回来**。pi 的 JSONL 只是录像带，没有人去看、去提炼。

> 我们要做的：`memory` 插件 —— Markdown 文件 + 常驻索引 + agent 主动写入 + 会话结束后自动抽取。

### 2.2 压缩是单段式，而且对缓存无感

pi 的压缩逻辑（`compaction.ts`）：

```
contextTokens > contextWindow - reserveTokens   →   触发
    ↓
保留最近 keepRecentTokens 的消息
    ↓
把更早的消息整段丢给 LLM 做结构化摘要（SUMMARIZATION_PROMPT，compaction.ts:507）
```

两个问题：

1. **没有廉价阶段。** 一旦越线就得花一次完整 LLM 调用。但历史里最占地方的往往是陈旧的工具输出（一次 `bash` 打印的 500 行日志），这种东西按规则折叠就行，根本不需要模型。
2. **对前缀缓存无感。** 摘要会重写历史 → 请求前缀变了 → 下一轮全部 cache miss。用 `deepseek-flash` 时缓存读 \$0.006/M、新输入 \$0.30/M，**差 50 倍**。所以"压缩省了 token"和"压缩省了钱"是两个问题，pi 不回答第二个。

> 我们要做的：`context-compaction` 插件 —— 两段式（先免费折叠旧工具输出，仍超阈值才摘要）+ 前缀字节稳定 + 把缓存命中率当成一等指标。

### 2.3 扩展点是"产品功能型"，不是"机制型"

pi 的 `ExtensionAPI` 能注册的东西：

```
registerCommand      registerShortcut      registerFlag
registerProvider     registerMcpServer     registerVirtualModel
registerToolRenderer registerMarkdownTransformer
```

全是**给 UI 和集成用的**。而"上下文怎么压、记忆怎么注入、计划怎么推进"这些**机制**，散落在 `agent-session.ts`（3000+ 行）里，没有统一的可开关边界。

后果：**你没法问"关掉压缩会怎样"**。没有这个开关，就没有消融实验，就没有数字。

> 我们要做的：八个 Hook 的内核协议，每个机制 = 一个插件 = 一行配置开关。已经在 `packages/kernel/src/types.ts` 定稿。

### 2.4 评测是为 pi 自己服务的

`pi-evals` 很专业——Docker 隔离、任务计划、结果报告。但看它的 API 就知道目标是什么：

```ts
verifySystemPrompt(...)                 // harness.ts:257
createPiDocumentationEvalHarness(...)   // harness.ts:517
resolveDocumentationVariant(...)        // harness.ts:487
```

它在验证**pi 自己的系统提示词和文档**写得好不好，不是"量化某个 harness 机制带来多少收益"。没有 ablation（消融）这个概念，也没有重复运行取方差。

> 我们要做的：`packages/evals` —— profile 驱动的对照实验，6 组配置 × 25 任务 × 3 次重复，可执行断言判定。

---

## 3. 三类关系，落到包

| pi-evolve 的包 | 关系 | 具体 |
| --- | --- | --- |
| `providers` | **用** `pi-ai` | `createModels()` + `deepseekProvider()` + `completeSimple()`。连 DeepSeek 的 `prompt_cache_hit_tokens` 它都已经映射成 `usage.cacheRead` 了 |
| `kernel` | **自己写** | 协议：Plugin / Service / 8 个 Hook / 依赖校验。pi 没有对应物 |
| `runtime` | **参考** `agent-loop.ts`，自己写 | 学它的双层循环和工具批处理，但写成自己的 ~300 行 |
| `tools` | **参考** `core/tools/`，自己写 | read/write/edit/bash 四个起步，学它的截断和路径约束 |
| `session` | **参考** `session-manager.ts`，自己写简化版 | 同样 JSONL 追加写，但不要它那 2029 行的多版本迁移 |
| `plugins/*` | **自己写**（pi 无对应） | 压缩、记忆、计划、工具加固、Prompt 改写 |
| `evals` | **参考** `packages/evals/`，自己写 | 学 Docker 隔离与报告结构，但目标换成消融实验 |
| `web` | **自己写** | pi 是 TUI；我们做 SSE 轨迹面板 |

---

## 4. 九块能力，逐块说清"怎么补"

### ① 模型接入层 — 直接用 pi-ai

- **pi 怎么做**：`createModels()` → `setProvider(deepseekProvider())` → `getModel("deepseek","deepseek-flash")` → `completeSimple(model, context, opts)`
- **我们怎么做**：包一层 `ModelService`，把 pi-ai 的 `Message[]` 和我们 kernel 的 `Message[]` 互转；assistant 消息把 provider 原生对象存进 `raw` 字段原样回传（DeepSeek 要求 assistant 消息带 `reasoning_content`，重建会丢）
- **为什么不自己写**：HTTP、SSE、重试、鉴权、各家工具调用格式差异——纯脏活，面试不会问
- **验收**：faux 模型离线跑通一次「读文件→回答」；真实 `deepseek-flash` 跑通一次改文件

### ② Agent 循环 — 自己写

- **pi 怎么做**：双层循环。内层处理「模型→工具→结果」直到模型不再调工具；外层处理插队消息和 `finishTurn` 续跑决策
- **我们怎么做**：先写单层循环（模型→工具→结果），加预算（轮数/工具调用数/时长/成本）与 `AbortController`；M3 再把 8 个 Hook 挂进去
- **为什么自己写**：这是整个项目唯一被深挖的地方
- **验收**：预算耗尽时干净退出并保留证据；取消后不再发下一次请求

### ③ 工具层 — 自己写，参考 pi 的细节

- **pi 怎么做**：`core/tools/` 下每个工具独立文件，配 `truncate.ts` 做输出截断、`output-accumulator.ts` 做流式累积、`file-mutation-queue.ts` 串行化写操作
- **我们怎么做**：read / write / edit / bash 四个起步，统一加工作区路径约束（防越界）、超时、输出截断
- **M4 的加固插件再补**：重试、错误结构化回灌（让模型拿到的不是一坨 stderr，而是 `{kind, message, retryable}`）
- **验收**：注入超时 / 报错 / 超大输出三类故障，模型能据此恢复

### ④ 上下文管理 — 自己写，这是卖点之一

- **pi 怎么做**：见 2.2
- **我们怎么做**：两段式
  - 阶段一（零成本）：把 N 轮之前的工具输出折叠成 `<elided bytes=12345 ref=tool_7>`，原文落盘可按引用取回
  - 阶段二（有成本）：仍超阈值才调模型摘要
  - 全程保持前缀字节稳定：system prompt、任务目标、早期稳定段永不改写
- **指标**：压缩触发次数、压缩自身消耗的 token、**缓存命中率**、端到端成本
- **验收**：用 faux 模型断言"实际发出的消息"符合预期；B2 vs B0 出对照表

### ⑤ 长期记忆 — 自己写，pi 完全没有

- **我们怎么做**：
  - 存储：`memory/*.md`，每条一个文件，带 frontmatter（类型、摘要、时间）
  - 索引：一份常驻的 `INDEX.md`，每条一行，始终在上下文里
  - 写入：agent 自己调 `memory_write` 工具；会话结束后 `onSessionEnd` 再自动抽取一次
  - 读取：`beforeRequest` 按任务相关性注入
- **验收**：同一个仓库连续做三个相关任务，第二、三次的模型轮数显著低于无记忆组

### ⑥ 会话与恢复 — 自己写简化版

- **pi 怎么做**：JSONL 追加写 + 多版本迁移 + 分支摘要，2029 行
- **我们怎么做**：同样 JSONL 追加写，但只做：完整消息、工具调用与结果、轮末检查点、`--continue` 恢复
- **验收**：在"执行前 / 写入后 / 整轮完成后"三处强制中断，恢复后不重复写文件

### ⑦ 计划机制 — 自己写

- **pi 怎么做**：没有独立的 plan/todo 机制
- **我们怎么做**：`planner` 插件提供 `plan` 工具 + `onTurnEnd` 推进，把长任务拆成可勾选的步骤回灌给模型
- **验收**：长任务（重构类）成功率对比

### ⑧ 权限与安全 — 自己写最小版

- **我们怎么做**：`permission` 插件挂 `beforeToolCall`，白名单 + 工作区约束 + 危险命令拦截
- **注意**：**不参与消融**（不能为了实验把安全关掉），只进 demo 和 README

### ⑨ 可观测性与评测 — 自己写，这是最大卖点

- **一份 trace 两处用**：事件总线写出 JSONL，Web 面板订阅它做实时轨迹，评测报告解析它算指标。**绝不写两套埋点**
- **评测**：
  - 任务：25 个 / 5 类（Bug 修复、功能实现、重构、写测试、代码理解），靠脚本注入生成，可复现
  - 判定：**可执行断言优先**（跑测试、grep 结构、检查 diff），LLM-as-Judge 只兜底
  - 隔离：Docker + git 快照重置
  - 对照：6 组 profile × 3 次重复，报告均值与方差
  - 指标：成功率、模型轮数、工具调用数、工具失败数、token、时延、**缓存命中率**、**成本**
- **验收**：别人 clone 仓库能复现你 README 里的表

---

## 5. 一次 turn 的时序：每个机制挂在哪

```
CLI / Web / Evals ──► Kernel.run(task)
  │
  ├─ onSessionStart ─────────► session 开 JSONL
  │
  └─ loop:
       beforeRequest ────────► [memory 注入] → [compaction 两段式] → [prompt-optimizer]
       ModelService.send ────► pi-ai → deepseek-flash
       afterResponse ────────► telemetry 记 token / 缓存命中 / 延迟
       for each toolCall:
           beforeToolCall ───► [permission 判定] allow / deny / rewrite
           ToolService.exec ─► 超时 + AbortSignal
           afterToolCall ────► [hardening 截断 + 错误结构化]
       onTurnEnd ────────────► [planner 推进] + 预算检查
       无 toolCall → 结束
  │
  └─ onSessionEnd ──────────► [memory 抽取] + trace flush
```

方括号里全是**可关掉的插件**。内核代码里不出现任何一个方括号的名字——这条由 `test/architecture.test.ts` 强制。

---

## 6. 能力 → 里程碑对照

| 里程碑 | 补的能力 | 状态 |
| --- | --- | --- |
| M0 骨架 + 内核协议 | ⑨ 的地基 | ✅ 完成（`daf5445`） |
| M1 最小闭环 | ① ② ③ | 下一步 |
| M2 评测骨架 | ⑨ | **必须在 M3–M7 之前** |
| M3 内核化（8 个 Hook） | 机制级可插拔 | |
| M4 工具加固 + 会话 | ③ ⑥ | |
| M5 两段式压缩 | ④ | ⭐ |
| M6 长期记忆 | ⑤ | ⭐ |
| M7 计划 + Prompt 改写 | ⑦ | |
| M8 全量消融 | ⑨ | ⭐ |
| M9 Web 轨迹面板 | ⑨ | |
| M10 README + 数字定稿 | — | |

---

## 7. 明确不做的（防止范围失控）

| 不做 | 理由 |
| --- | --- |
| TUI | pi 有 `pi-tui` 做差分渲染，我们做 Web 面板，二选一 |
| 多 provider | 一个 `deepseek-flash` 足够；多厂商不增加说服力，只增加变量 |
| MCP | 可选加分项，排在 M10 之后 |
| Durable / 远程执行 | `pi-durable`、`pi-env` 是生产级需求，portfolio 用不上 |
| Codemode 沙箱 | 很酷，但和"量化上下文机制"的主线无关 |
| 子 agent | 同上，排在 MCP 之后 |

砍掉的理由统一是一句话：**它们不进消融表。**

---

## 8. 一句话总结

pi 给了我们一个完整 agent 的**全套零件和一本教材**，但它的设计目标是"做一个好用的 CLI 产品"，所以：机制和产品代码耦合在一起、没有跨会话记忆、压缩不考虑缓存经济、评测服务于自己。

pi-evolve 的设计目标不同：**做一个能证明自己每个机制都有用的 harness。**
所以我们把机制切成插件、给每个插件配一组对照实验、把成本和缓存命中率当成和成功率同等重要的指标。
