# PiForge 架构方案

**可行。** 首版采用单进程、单任务、一个 Agent。用 pi-ai 选模型，用 pi-agent-core 驱动执行；PiForge 持有任务目标、工具权限、执行记录、验收和实验配置。公开接线范例见 Pi 的 `packages/agent/README.md`，导出边界见 `packages/agent/src/index.ts`、`packages/ai/src/index.ts`。下表中的 PiForge 组件是拟设计的职责。

| 问题               | Pi 已提供                                                                                                                                                         | PiForge 拟做的工作                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 怎样调模型         | createModels、setProvider、getModel、streamSimple，见 `packages/ai/src/models.ts`                                                                                 | 显式选择厂商和模型，把绑定到实例的 streamSimple 作为 Agent 的 streamFn。离线测试替换为 faux provider，见 `packages/ai/src/providers/faux.ts`。           |
| 谁调工具、何时结束 | Agent、AgentTool、beforeToolCall、afterToolCall、finishTurn、subscribe，见 `packages/agent/src/agent.ts`、`packages/agent/src/types.ts`                           | 运行前固定工具集和策略；在调用前扣减工具预算、检查工作区，按轮控制请求上限，到时取消。首版对写操作串行，避免并发改同一文件。                             |
| 上下文太大         | Core 有 transformContext、convertToLlm；完整 CLI 有摘要与保留段。见 `packages/agent/src/agent-loop.ts`、`packages/coding-agent/src/core/compaction/compaction.ts` | 把长输出保存为可按段读取的附件，工具结果仅保留引用、退出码和关键报错。每轮保留目标、验收条件、未解决问题和工具调用配对；持久历史和本轮发送视图分别管理。 |
| 怎样换策略         | Core 接收具名回调；Coding Agent 另有完整 ExtensionRunner。见 `packages/agent/src/types.ts`、`packages/coding-agent/src/core/extensions/runner.ts`                 | 首版由启动代码注入上下文、工具策略、记录器和验收器。用同一任务替换一种策略证明可插拔。出现真实依赖关系后再设计插件依赖排序。                             |
| 中断后怎么办       | Agent.continue 延续合法消息历史；Durable 已有可恢复任务、检查点和重放策略。见 `packages/agent/src/agent.ts`、`packages/durable/src/harness/tool.ts`               | Core 路线只承诺从可验证边界恢复。在任务账本记录执行意图、结果和工作区证据；复杂持久调度需求出现时，评估直接采用 Durable Harness。                        |
| 如何证明修好       | Core 能报告工具错误和模型停止原因；上游有评测运行器。见 `packages/agent/src/types.ts`、`packages/evals/src/harness.ts`                                            | 独立验收器在指定工作区运行预先定义的断言或测试，失败信息回送 Agent。固定修复轮数，耗尽后报告失败。按任务比较成功数和成本。                               |

## 从输入到验收

用户给出“修复分页多返回一项”。宿主创建任务，记录仓库起点、验收测试和预算。Agent 读代码、请求编辑；工具入口记录意图，再执行。运行测试产生大量日志时，完整输出进入附件，模型收到失败断言和附件编号。Agent 给出完成说明后，宿主运行固定验收。通过才标记成功；失败且还有预算，就把断言作为新输入继续。模型错误、取消、预算耗尽、验收失败分别记录。

**恢复边界。** 每次操作用任务 ID、调用 ID、工作区和输入摘要关联。单写者先持久化意图，再做修改，再持久化结果；在整批结果齐全后保存消息、剩余预算和文件指纹。重启时舍弃明确不完整的日志尾条，检查工作区与未决调用。若写入后、记结果前崩溃，能用前后指纹判断的编辑可补记结果；无法判断的命令进入待确认状态。恢复后先核对工具调用与结果配对，再选择 continue 或以新用户消息开始下一步。多进程争用、任意 Shell 的恰好一次执行都超出首版承诺。Durable 的对照行为见 `packages/durable/README.md`。

## 必须讲清的接口限制

1. Core 要求提供 streamFn；宿主没有设置默认值时，getDefaultStreamFn 会失败。使用实例绑定或闭包，避免丢失 Models 的 this。独立 Harness 也要自行选择工具和持久化位置。依据 `packages/agent/src/stream-fn.ts`、`packages/agent/README.md`。
2. 运行中再次 prompt 会拒绝，输入应按时机选择 steer 或 followUp。continue 遇到末尾助手消息且无排队输入会拒绝。恢复的是持久数据，进程内 Promise 无法续跑。依据 `packages/agent/src/agent.ts`。
3. transformContext 只处理发送视图，且约定失败时返回可用消息；权限阻断应放在 beforeToolCall。finishTurn 在整轮结果产生后触发，不能用它逐个批准同批调用。模型用量通常在响应后才能准确结算，硬限制需预留输入输出预算；底层网络重试与模型轮数要分别计数。依据 `packages/agent/src/types.ts`、`packages/agent/src/agent-loop.ts`、`packages/ai/src/api/anthropic-messages.ts`。
4. 从根包公开导入。只有依赖 pi-coding-agent 才能通过它的公共入口复用 createReadTool、SessionManager 等。首版可只实现受限文件工具与指定验收命令；若要 CLI 全套会话和扩展，改用公开 SDK。依据 `packages/coding-agent/src/index.ts`、`packages/coding-agent/package.json`、`packages/coding-agent/docs/sdk.md`。
5. 可取消需要工具响应 signal。工具钩子能批准或拒绝请求，真正的命令隔离需在执行器落实。优先开放有限操作，确需通用 Shell 再加隔离执行器。依据 `packages/agent/src/types.ts`、`packages/coding-agent/docs/containerization.md`。

**是否需要修改 Core？** 本方案所有首版能力均可通过公开入口组合。若目标升级为“任意机器指令处崩溃后，原调用从该指令继续”，Core 只暴露消息、事件与钩子，无法保存调用栈或把文件系统与日志变成同一笔事务。改循环也无法单独提供这个保证。替代方案是可核对、可重复的工具操作，或使用实验性的 Durable 任务阶段；需要底层强隔离时使用外部执行器。依据 `packages/agent/src/agent-loop.ts`、`packages/durable/src/harness/tool.ts`。
