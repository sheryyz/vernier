# Pi 上游源码分析

分析对象为本机同级目录 `../pi` 的 main 提交 `d57c2d21916eaad1158031526ac6ec860eae5f14`。本文的源码路径都从 Pi 仓库根目录算起。工作区的 `packages/agent/src/agent.ts`、`packages/agent/src/agent-loop.ts` 有既存未提交改动，涉及这两个文件的结论以 Git 提交版为准。可用 `git show <commit>:<path>` 对照。以下是源码推演，没有调用真实模型或跑性能实验。

## 版本与依赖

根清单 `package.json` 的私有工作区 pi-monorepo 版本是 0.0.3，下表各包清单的版本是 1.5.0。根清单、AI、Core、Coding Agent 和 Durable 均要求 Node.js >=22.19.0。根 README.md 的 Packages、Using local packages outside the monorepo 说明了分包与本地打包方式。AGENTS.md 规定上游检查、测试和依赖更新约束。本阶段只读，无需构建。为复验应同时记录提交和包版本，同号发布物与本地 main 的内容不能仅靠版本号确认一致。

包名统一带作用域 `@earendil-works/`。表中仅列运行时的仓内直接依赖。

| 包名（省略作用域） | 清单                                 | 直接依赖                                           |
| ------------------ | ------------------------------------ | -------------------------------------------------- |
| pi-ai              | `packages/ai/package.json`           | pi-schema、pi-telemetry                            |
| pi-agent-core      | `packages/agent/package.json`        | pi-ai、pi-schema                                   |
| pi-coding-agent    | `packages/coding-agent/package.json` | pi-agent-core、pi-ai、pi-codemode、pi-mcp、pi-tui  |
| pi-durable         | `packages/durable/package.json`      | chord、pi-ai、pi-codemode、pi-schema、pi-telemetry |
| pi-telemetry       | `packages/telemetry/package.json`    | 无                                                 |
| pi-evals（私有）   | `packages/evals/package.json`        | 无；开发依赖含 pi-ai、pi-coding-agent              |

Core 与 Durable 是两条执行路线。安装 Core 不会自动获得 Durable 的恢复能力。Coding Agent 的现成 MCP 接入见 `packages/coding-agent/src/core/mcp-servers.ts` 和 `packages/coding-agent/docs/mcp.md`。

## 模型怎样与程序交谈

- **选模型。** `packages/ai/src/index.ts` 导出轻量根 API，具体厂商从 providers 子路径引入。`packages/ai/src/models.ts` 中，宿主用 createModels 创建实例，用 setProvider 注册厂商，再用 getModel 选择模型。ModelsImpl.streamSimple 按模型找到厂商、准备请求，再调用 provider.streamSimple。stream 支持具体 API 的选项，streamSimple 使用通用选项，completeSimple 等待流的最终结果。官方用例见 `packages/ai/README.md`。
- **整理消息。** `packages/ai/src/types.ts` 定义 Message 的四种角色 system、user、assistant、toolResult。助手消息可以混合文本、思考块和多个 ToolCall。系统指令和工具声明可以沿历史变化，送给厂商的是规范化的 TranscriptContext。实现见 `packages/ai/src/utils/transcript.ts`。Core 的 AgentMessage 还允许应用自定义消息，发给模型前由 convertToLlm 转换或过滤，见 `packages/agent/src/types.ts`。
- **边生成边读。** AssistantMessageEventStream 支持异步迭代和 result()。一次正常响应从 start 开始，文本增量是 text_delta，工具参数也分段到达，最后是 done。初始化故障可直接发 error。partial 表示正在变化的消息，长期保存应取最终消息。协议与流容器见 `packages/ai/src/types.ts`、`packages/ai/src/utils/event-stream.ts`。
- **工具调用是请求。** 模型给出 ToolCall 的 id、name、arguments；JSON 无法解析时可带 argumentsError。模型端只拿到工具声明，执行函数留在宿主。宿主把结果写成 toolResult，用 toolCallId 对回原调用，content 给模型读，isError 表示失败。Core 的 structuredContent 是程序侧结果。定义见 `packages/ai/src/types.ts`、`packages/agent/src/types.ts`。例如 Anthropic 把 tool_use 和 input_json_delta 转成 Pi 的调用块，回传时再关联 tool_use_id，见 `packages/ai/src/api/anthropic-messages.ts`。

## 一次完整调用：用打印模式让 Pi 读 README 再回答

下面选普通文本、已配置的 Anthropic 模型、一次成功 read、无排队消息的路径。各厂商的网络请求不同。下文私有函数名仅用于源码导航。

| 步骤                  | 执行位置                                                                                                                                                                                                                                                               | 发生的事                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 接收输入           | `packages/coding-agent/src/main.ts` 的 main → `packages/coding-agent/src/modes/print-mode.ts` 的 runPrintMode                                                                                                                                                          | 选择打印模式，把 initialMessage 交给 session.prompt。                                                                                                                                       |
| 2. 组织本次任务       | `packages/coding-agent/src/core/agent-session.ts` 的 AgentSession.prompt → _preparePrompt → _startRun → _prepareRun → agent.prompt                                                                                                                                     | 先处理输入与扩展，检查模型，然后产生本轮消息。SDK 创建 Agent 并注入模型请求函数的位置在 `packages/coding-agent/src/core/sdk.ts` 的 createAgentSession。                                     |
| 3. 开始循环           | `packages/agent/src/agent.ts` 的 Agent.prompt → normalizePromptInput → runPromptMessages → runWithLifecycle；`packages/agent/src/agent-loop.ts` 的 runAgentLoop → runLoop                                                                                              | 创建本次运行的 AbortController，发送 agent_start、turn_start 和输入消息事件。                                                                                                               |
| 4. 请求模型           | `packages/agent/src/agent-loop.ts` 的 runLoop → prepareRequest 钩子 → streamAssistantResponse                                                                                                                                                                          | 先 transformContext，再 convertToLlm；传规范化消息、模型和取消信号给注入的 streamFn。工具集合变化由 declareToolChanges 写进系统消息。                                                       |
| 5. 到厂商再返回       | `packages/coding-agent/src/core/sdk.ts` 的 streamFn → `packages/coding-agent/src/core/model-runtime.ts` 的 streamSimple → provider.streamSimple；以 `packages/ai/src/providers/anthropic.ts`、`packages/ai/src/api/anthropic-messages.ts` 的 streamSimple、stream 为例 | 适配器发送请求并消费流。Core 的 streamAssistantResponse 把增量转成 message_update，完成后发 message_end。独立宿主可在同一入口注入 Models 实例的 streamSimple，跳过 CLI 的模型配置层。       |
| 6. 执行 read          | `packages/agent/src/agent-loop.ts` 的 executeToolCalls → prepareToolCall → executePreparedToolCall → finalizeExecutedToolCall；工具实现在 `packages/coding-agent/src/core/tools/read.ts` 的 createReadToolDefinition 所定义的 execute                                  | 查工具、validateToolArguments、运行 beforeToolCall，经允许才调 execute。执行结果再过 afterToolCall。发 tool_execution_start、可选 update、end，createToolResultMessage 按 id 生成结果消息。 |
| 7. 保存结果、再问模型 | `packages/agent/src/agent-loop.ts` 的 runLoop；`packages/agent/src/agent.ts` 的 processEvents；`packages/coding-agent/src/core/agent-session.ts` 的 _handleAgentEvent                                                                                                  | 工具结果追加到循环历史；Agent 按消息结束事件更新状态；上层用 SessionManager.appendMessage 写会话。本轮 finishTurn 后发 turn_end，通常带上读到的内容再请求一次。                             |
| 8. 返回最终回答       | `packages/agent/src/agent-loop.ts` 的 runLoop → agent_end；`packages/coding-agent/src/modes/print-mode.ts` 的 runPrintMode                                                                                                                                             | 无待执行调用、无排队输入且没有要求继续时收尾。prompt 返回后打印最终助手消息中的文本块；error、aborted 或截断会影响退出码。                                                                  |

**并发与取消。** 默认 parallel，同批工具按顺序预检，获准工具可并发。tool_execution_end 按完成先后发出，写入历史的结果按助手发起顺序排列；sequential 可改为串行。输出因 length 截断时，当前消息的工具调用全部转为失败结果。error 和 aborted 是硬退出。steer 在当前批次后进入，followUp 在原本就要结束时进入。依据 `packages/agent/src/agent-loop.ts`、`packages/agent/src/types.ts`。

Agent.abort() 触发本次运行的信号，等待收尾用 waitForIdle()。信号传到 streamFn、工具和相应钩子，具体实现必须合作停止；已完成的文件写入不会自动撤销。processEvents 先更新状态，再依订阅顺序等待监听器，agent_end 发出时监听器可能仍在写盘。prompt 返回 Promise<void>，应检查最终消息的 stopReason。依据 `packages/agent/src/agent.ts`、`packages/agent/src/agent-loop.ts`。

## Coding Agent 已经补齐的五层

| 层         | 实现与边界                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session    | `packages/coding-agent/src/core/session-manager.ts` 的 SessionManager 管理 JSONL 条目树。id、parentId 和活动叶子决定当前分支，buildSessionContext 根据分支、摘要和上下文编辑重建模型历史。SDK 下持久状态以 manager 为准。见 `packages/coding-agent/docs/session-format.md`、`packages/coding-agent/docs/sdk.md`。                                                                                   |
| Compaction | `packages/coding-agent/src/core/compaction/compaction.ts` 的 shouldCompact 在启用且使用量大于窗口减 reserveTokens 时触发，默认预留 16384、近期预算 20000。prepareCompaction、findCutPoint 和 compact 选边界、生成摘要；会话以摘要和保留段重建下次输入，旧记录仍可查。分支摘要另见 `packages/coding-agent/src/core/compaction/branch-summarization.ts`、`packages/coding-agent/docs/compaction.md`。 |
| Extensions | `packages/coding-agent/src/core/extensions/loader.ts` 加载工厂，`packages/coding-agent/src/core/extensions/runner.ts` 的 ExtensionRunner 分发事件，emitToolCall 可拦截，emitToolResult 可改结果。扩展可注册工具和命令，和宿主同进程。见 `packages/coding-agent/docs/extensions.md`。                                                                                                                |
| Tools      | `packages/coding-agent/src/core/tools/index.ts` 的 createCodingTools 提供 read、bash、edit、write，createReadOnlyTools 提供 read、grep、find、ls。具体执行见同目录 read.ts 和 bash.ts；公共工厂从 `packages/coding-agent/src/index.ts` 导出。指定 cwd 并不等于有操作系统隔离。                                                                                                                      |
| Skills     | `packages/coding-agent/src/core/skills.ts` 的 loadSkills、formatSkillsForPrompt 发现 SKILL.md，并给模型名称、说明和位置；模型按需读取全文。`packages/coding-agent/src/core/agent-session.ts` 的 _expandSkillCommand 可展开显式 /skill:name。技能是按需提供的操作说明，扩展则能运行 TypeScript。见 `packages/coding-agent/docs/skills.md`。                                                          |

## 容易重复开发的三项能力

- **持久执行已经存在。** `packages/durable/src/index.ts` 导出 Harness、GenerationTask、ToolTask 和检查点类型。`packages/durable/src/harness/generation.ts`、`packages/durable/src/harness/tool.ts` 与 `packages/durable/README.md` 描述按阶段提交、重启和工具重放。工具执行前先提交意图；未完成的调用只有声明 replay 为 safe 才允许重跑，否则产生 interrupted 结果。外部副作用仍需工具自己保证重复执行的安全性。Durable 官方标为实验性。
- **有权限钩子，也需要执行边界。** Core 的 beforeToolCall 能在参数校验后返回 block 和 reason，Core 再把拒绝作为错误结果交给模型。Coding Agent 的 _beforeToolCall 对接扩展。项目是否受信任和某次调用是否获准是不同决定。操作系统的文件、进程、网络隔离要靠实际执行环境。见 `packages/agent/src/types.ts`、`packages/coding-agent/src/core/agent-session.ts`、`packages/coding-agent/docs/containerization.md`、根 README.md。
- **有遥测和评测基础。** `packages/telemetry/src/index.ts` 定义 TelemetryContext、span、指标与查询契约；`packages/telemetry/src/memory.ts` 有 InMemoryTelemetryContext。`packages/ai/src/telemetry.ts` 有 observeModelRequest，`packages/durable/src/harness/telemetry.ts` 定义 Durable 的遥测结构。仓内已有私有评测包，见 `packages/evals/package.json`、`packages/evals/src/harness.ts`。PiForge 可贡献自己的任务集、故障注入和验收口径，不能把已有遥测协议算作自己的实现。
