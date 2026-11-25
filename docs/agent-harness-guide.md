# 从十个源码文件理解 Pi 的 Agent 和 Harness

这份笔记围绕一个任务展开：用户输入“读取 README.md，告诉我这个项目做什么”。我们跟着 Pi 看，它怎样把一句话变成模型请求、文件读取和最终回答。阅读时先理解每一步为什么存在，再看对应函数。

本文基于 Pi 提交 `d57c2d21916eaad1158031526ac6ec860eae5f14`。源码链接指向同级的 `pi` 目录。`agent.ts` 和 `agent-loop.ts` 的工作区存在未提交改动，本文以该提交中的版本为准。这里的 PiForge 职责属于设计设想。

## 先认识三个角色

**模型**负责根据收到的信息生成文本，或提出使用工具的请求。例如它可以说“请读取 README.md”。工具请求里有名称和参数，但模型自己不会因此直接读取你的硬盘。

**Agent**负责围绕模型反复做事。它把用户问题发给模型，接到工具请求后安排执行，把结果发回模型，直到本次运行可以结束。这个反复过程叫 Agent Loop，也就是 Agent 循环。

**Harness** 是包在模型和 Agent 周围的运行环境。它把模型、工具、会话记录、上下文、交互界面等部件组织起来。想象模型需要读文件，Harness 要准备读文件工具，还要安排运行和记录结果。Pi 自身已经是一个可扩展的 Agent Harness，PiForge 则计划使用 Pi 的底层部件，组合自己的任务控制、恢复和评测能力。定义和分包见 [Pi README](../../pi/README.md) 和 [Core README](../../pi/packages/agent/README.md)。

```text
用户：README 说了什么？
  ↓
接收输入，准备模型、工具和历史
  ↓
问模型 ── 模型请求 read ──→ 程序读取 README
  ↑                             ↓
  └────────── 把读取结果交回模型 ─┘
  ↓
模型给出回答 → 显示给用户

过程中的消息和工具结果可以由会话层保存。
```

下面先从入口到出口走一遍，再解释历史记录与压缩。

## 1. 输入从哪里进来，回答从哪里出去

文件：[print-mode.ts](../../pi/packages/coding-agent/src/modes/print-mode.ts)

找 `runPrintMode`。它是 Pi 的一种入口，适合提交问题后输出结果。拿到初始问题后，它调用 `session.prompt(initialMessage)`。等任务完成，再从会话中取最后一条助手消息，把其中的文本打印出来。

把它当作接待窗口就好。窗口收到“读 README”，交给会话处理，最后把回答展示出来。它还可以输出 JSON 格式的事件，供其他程序观察进度。

在我们的例子中，此时程序只是收到了文字，还没有调用模型，也没有读取文件。

## 2. Agent 的零件从哪里来

文件：[sdk.ts](../../pi/packages/coding-agent/src/core/sdk.ts)

找 `createAgentSession`，再找里面的 `new Agent(...)`。这里创建一个 Agent，并给它准备模型、已有消息、工具配置和请求模型的函数 `streamFn`。

`streamFn` 可以理解为一根连接模型的线。Agent 执行到“需要问模型”时会调用它，Coding Agent 在这里把请求交给自己的模型运行层。不同模型厂商的具体差异继续由下层处理。

PiForge 可以参考这种组装方式。它可以把 `pi-ai` 的模型请求函数交给 `pi-agent-core` 的 Agent，再自行提供工具和策略。这里先关注零件如何连接。

## 3. 一次请求如何交给 Agent

文件：[agent-session.ts](../../pi/packages/coding-agent/src/core/agent-session.ts)

这个文件比较长，先沿 `AgentSession.prompt`、`_preparePrompt`、`_startRun` 阅读。普通问题进来后，会话层先准备输入并检查所需配置，再交给 `agent.prompt(messages)`。

会话层还接收执行过程中产生的事件。找 `_handleAgentEvent`，可以看到消息结束后，它会将消息交给 `sessionManager.appendMessage` 保存。稍后会解释这个管理器。

例如用户在问题里使用技能命令或提示模板时，会话层还要先处理这些输入。对于简单的“读取 README”，主线可以先理解为：**收到问题 → 整理输入 → 交给 Agent → 观察结果**。

## 4. Agent 如何开始、报告进度和取消

文件：[agent.ts](../../pi/packages/agent/src/agent.ts)

从 `Agent.prompt` 看起。它把字符串整理成消息，交给 `runPromptMessages`，再进入 `runWithLifecycle`，最终调用 Agent Loop。

执行期间会不断产生事件，例如“这一轮开始了”“模型产生一段新文字”“工具执行结束了”。`processEvents` 用事件更新 Agent 的当前状态，再通知通过 `subscribe` 注册的监听者。界面可以据此显示进度，会话层也可以据此保存消息。事件是程序对外报告的进度，它本身不等于磁盘记录。

用户取消时，`abort()` 会发出取消信号。模型请求和工具需要配合这个信号才能停下；已经写入的文件不会因此自动恢复。一次运行结束后，`prompt()` 返回，但这只能说明运行已经收尾。若任务要求修 Bug，还需要看最终结果并运行测试。

## 5. Agent Loop 怎样让模型和工具轮流工作

文件：[agent-loop.ts](../../pi/packages/agent/src/agent-loop.ts)

这是整条链路中最值得反复读的文件。先找 `runAgentLoop` 和 `runLoop`，再找 `streamAssistantResponse`、`executeToolCalls`。

一次普通运行大致如下。

1. `runLoop` 把当前消息交给 `streamAssistantResponse`。
2. `streamAssistantResponse` 整理上下文，调用 `streamFn` 请求模型，并把逐步收到的内容变成消息事件。
3. `runLoop` 检查模型回复。如果回复里有工具请求，就交给 `executeToolCalls`。
4. 程序检查工具和参数，执行被允许的工具，整理成工具结果消息。
5. 有工具结果时，通常开始下一轮请求，把结果交回模型。模型可以继续请求工具，也可以给出文字回答。
6. 没有需要继续处理的工具请求和排队消息时，运行结束。具体结束还受取消、错误和钩子等条件影响。

以 README 为例，模型第一次返回“调用 read，参数为 README.md”。Loop 安排读取并拿到文件内容，再把它交回模型。模型第二次才能根据内容回答。

这里的 `beforeToolCall` 是调用前的钩子，也就是程序预留的检查位置。它可以拒绝某次调用，例如禁止读取某个路径。它提供检查机会，具体权限规则由使用者决定。多个工具默认可以并发，要求按顺序执行时可配置为串行。更详细的事件顺序见 [Core README](../../pi/packages/agent/README.md)。

## 6. 模型请求和工具结果怎样对上号

文件：[types.ts（pi-ai）](../../pi/packages/ai/src/types.ts)

找 `Message`、`AssistantMessage`、`ToolCall` 和 `ToolResultMessage`。类型可以理解为一张表格，规定每种消息里能放什么字段。

| 消息角色     | 例子                        | 用途                   |
| ------------ | --------------------------- | ---------------------- |
| `system`     | “你是编程助手”以及工具声明  | 告诉模型规则和可用能力 |
| `user`       | “读取 README.md”            | 用户的请求             |
| `assistant`  | 一段回答，或请求调用 `read` | 模型的回复             |
| `toolResult` | README 的内容               | 程序执行工具后的结果   |

一次工具请求带 `id`、工具 `name` 和 `arguments`。工具结果带 `toolCallId`，用来指回原来的请求。下面是为了理解而简化的示意。

```text
助手请求  id = call-1，工具 = read，参数 = README.md
工具结果  toolCallId = call-1，内容 = README 的文字
```

有多次工具调用时，这个编号尤其重要。整理或压缩历史时，也要保留请求与结果的正确关系，才能让模型理解发生了什么。

这个文件还定义了流式事件。流式就是模型边生成、程序边接收。例如 `text_delta` 表示新增的一小段文字，界面不用等全部回答完成才开始显示。

## 7. `read` 工具在哪里真正读文件

文件：[read.ts](../../pi/packages/coding-agent/src/core/tools/read.ts)

找 `createReadToolDefinition` 和其中的 `execute`。这里定义读取文件所需的参数，以及工具被调用后要做的工作。Agent Loop 会把模型请求中的参数交给工具的执行函数，工具再返回内容。

所以读取 README 的动作发生在运行 Pi 的程序所在环境里。模型收到的是工具说明和执行结果。工具失败时，Agent 可以将失败信息作为工具结果交回模型，让模型决定下一步。

对 PiForge 来说，工具执行前后是加入记录、耗时统计和权限策略的位置。实际的路径限制和进程隔离需要由策略及执行环境落实。

## 8. Pi 怎样找到并请求模型

文件：[models.ts](../../pi/packages/ai/src/models.ts)

找 `createModels`、`setProvider`、`getModel` 和 `streamSimple`。`createModels` 建立模型管理对象，`setProvider` 注册厂商，`getModel` 选择模型，`streamSimple` 使用通用选项发起流式请求。

例如程序配置某个厂商和模型后，Agent 无需自己处理每家服务的底层消息格式。`pi-ai` 按所选模型找到对应的厂商实现。具体厂商怎么拼请求、怎么接收网络流，可以继续阅读 [Anthropic 适配器](../../pi/packages/ai/src/api/anthropic-messages.ts)。

在完整 Pi 中，SDK 提供的 `streamFn` 经过 Coding Agent 自己的模型运行层。独立使用 `pi-ai` 时，可以参考 [Core README 的示例](../../pi/packages/agent/README.md)，把模型管理对象的 `streamSimple` 传给 Agent。

## 9. 会话历史怎样保存，又怎样取出来

文件：[session-manager.ts](../../pi/packages/coding-agent/src/core/session-manager.ts)

找 `SessionManager`、`appendMessage` 和 `buildSessionContext`。会话层把用户消息、助手回复和工具结果等条目交给管理器。持久会话使用 JSONL，也就是每行一个 JSON 条目的文件。

它把条目组织成树。平时顺着当前分支往下追加；用户回到较早位置继续时，可以形成另一条分支。`buildSessionContext` 根据当前分支和已有摘要等信息，整理下一次需要给模型的历史。

例如，完整会话里有十次读文件记录，下一次模型请求使用的是根据当前分支重建的上下文。会话文件里的全部记录与某一次实际发给模型的内容因此可能不同。具体格式见 [Session File Format](../../pi/packages/coding-agent/docs/session-format.md)。

## 10. 对话太长时怎样压缩

文件：[compaction.ts](../../pi/packages/coding-agent/src/core/compaction/compaction.ts)

模型每次能接收的内容有上限，这个上限叫上下文窗口。问题、历史消息、工具输出都会占用空间。看 `shouldCompact`，它根据当前使用量、窗口大小和预留空间判断是否需要压缩。

触发后，`prepareCompaction` 和 `findCutPoint` 等逻辑帮助选取整理范围，`compact` 参与生成摘要。后续模型请求可以使用较早内容的摘要和保留下来的近期消息，原始条目仍留在会话记录中。更完整的触发时机见 [Compaction 文档](../../pi/packages/coding-agent/docs/compaction.md)。

例如一次测试输出两万行，长日志会迅速占满窗口。PiForge 可以在此基础上研究自己的策略：保存完整日志，让模型先看到失败测试和关键报错，需要细节时再按段读取。做完后要实际比较 Token、成功率和关键约束是否保留。

## 把十个文件重新串起来

```text
print-mode.ts        接收用户问题，最后打印答案
  ↓
agent-session.ts     整理问题，交给 Agent，并接收事件
  ↓
agent.ts             开始一次运行，维护状态，通知订阅者
  ↓
agent-loop.ts        发请求 → 检查工具调用 → 执行 → 再请求
  ├─ types.ts        规定消息、工具请求、结果和流式事件的形状
  ├─ models.ts       通过模型管理接口找到厂商并发请求
  └─ read.ts         当模型请求 read 时执行文件读取

sdk.ts               创建并连接 Agent 所需的模型、工具和其他部件
session-manager.ts   保存会话条目，重建当前分支的上下文
compaction.ts        历史太长时帮助摘要和保留近期内容
```

这张图表达职责和主要数据流。一次真实运行中，会话保存和界面事件会穿插在模型、工具执行过程中。

## 用这条链路思考 PiForge

如果任务从“读 README”变成“修分页 Bug”，模型可以先读代码，再请求编辑和运行测试。PiForge 可以围绕这个过程提供三种能力。

- **上下文管理**。保存完整测试日志，优先把失败断言交给模型，并保留用户的验收条件。
- **任务恢复**。记录工具准备做什么和实际做完什么。如果程序在修改文件后崩溃，重启时先核对文件，再决定从哪里继续。单纯保存对话还无法确定外部操作是否完成。
- **任务验收与评测**。模型说“修好了”之后，独立运行预设测试。记录成功与否、工具调用、时间和 Token，才能比较不同策略的效果。

Pi 已有独立的 Durable 运行时，提供任务阶段、检查点和工具重放策略。它与 `pi-agent-core` 是不同的运行路线；选择前可读 [Durable README](../../pi/packages/durable/README.md) 及 [工具任务实现](../../pi/packages/durable/src/harness/tool.ts)。

## 自测

1. 模型返回 `read` 工具请求后，哪个文件负责安排执行？哪个文件实现读取？
2. 两次工具调用的结果怎样与各自的请求对应？
3. 为什么 Agent 读完 README 通常还要再请求一次模型？
4. 会话中的完整历史和某次发给模型的上下文为什么可能不同？
5. 如果写文件后、保存结果前程序崩溃，仅靠聊天记录为什么无法判断是否应该重试？

对应答案依次可以回看第 5、7 节，第 6 节，第 5 节，第 9、10 节，以及最后一节的任务恢复例子。
