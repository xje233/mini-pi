# 实现日志（DEVLOG）

> 记录 mini-pi 每个已实现功能：做了什么、关键设计决策、与 pi 源码的对照。
> 新条目追加在最下方。

---

## F1 · 一层 Agent Loop（2026-09-25，commit 101535b）

**做了什么**

最小可用的 agent 主循环：拼接 system prompt + 对话历史发给 LLM，
把回复存回历史并输出，循环等待下一条用户输入，`exit` / EOF 退出。

**代码结构**

```
src/ai/index.ts        # ChatMessage 类型 + StreamFn 契约 + OpenAI 兼容 fetch 实现
src/agent/agent-loop.ts# agentLoop()：while 循环 + AgentEvent 事件
src/main.ts            # readline UI，循环不感知 UI
```

**关键设计决策（对照 pi）**

1. **systemPrompt 与对话历史分离**：不在历史里塞 system 消息，
   每次在 LLM 调用边界才拼接 `[{system}, ...history]`
   （pi：`AgentState.systemPrompt` 与 `AgentState.messages` 分离，
   `agent-loop.ts` 注释"Transforms to Message[] only at the LLM call boundary"）。
2. **循环只依赖 `StreamFn` 函数类型**，不依赖任何具体 provider
   （pi：`packages/agent/src/types.ts:33` 的 `StreamFn`，agent 包对 ai 包零硬编码）。
3. **哑内核 + 事件流**：循环不打印任何东西，只发 `agent_start` / `turn_start` /
   `message_end` / `agent_end` 事件，UI 逻辑全在 `main.ts` 的 `onEvent` 回调
   （pi：10 种 `AgentEvent`，`packages/agent/src/types.ts:485`）。

**使用方式**

```bash
npm start                # 交互模式，/model 看模型，exit 退出
```

**验证**：typecheck 通过；管道输入冒烟测试真实调用 DeepSeek 成功、退出码 0。

---

## F2 · 多模型注册与运行时切换（2026-09-26，commit 101535b）

**做了什么**

同一会话内可在多个 LLM provider 之间切换：启动时自动选第一个配了 Key 的模型，
对话中用 `/model <provider/modelId>` 随时切换，下一轮立即生效；
每条 assistant 回复带 `[provider/modelId]` 标签，历史消息记录生成它的模型。

**代码结构**

```
src/ai/models.ts       # MODELS 注册表 + resolveModel() 二级寻址 + resolveApiKey()
src/ai/index.ts        # StreamFn 增加 model 参数，按 model.baseUrl/apiModel 发请求
src/agent/agent-loop.ts# currentModel 状态 + /model 命令 + model_change 事件
.env                   # 每个 provider 一个 Key：DEEPSEEK_API_KEY / GLM_API_KEY / MOONSHOT_API_KEY
```

**关键设计决策（对照 pi）**

1. **Provider 是声明式注册，不是运行时探测**：注册表条目自带
   `provider / baseUrl / apiKeyEnv`，启动"识别"只是遍历注册表查哪个 env 有值。
   生产版（pi）不做自动猜测，默认模型来自配置或会话恢复——隐式回退是学习便利项。
2. **二级寻址 `provider/modelId`**，不做全局唯一字符串
   （pi：`Models.getModel(provider, id)`，`packages/ai/src/models.ts:471`；
   解析顺序：全串 → 按 `/` 拆开 → 裸 id（歧义拒绝），对照 `model-resolver.ts:88`）。
3. **API Key 按 provider 命名空间化共存**，一个 `.env` 存多个 Key
   （pi：`packages/ai/src/env-api-keys.ts` 的 provider→env 映射表）。
4. **切换模型 = 改一个状态引用，历史零特殊处理**：统一消息格式对 provider 中立，
   同一会话混用多家模型合法；每条 assistant 消息记录自己的来源
   （pi：`AgentSession.setModel()` 核心就一行 `state.model = model`，
   `agent-session.ts:2118`；`AssistantMessage` 自带 provider/model 字段，
   `packages/ai/src/types.ts:542`；会话追加 `model_change` 条目，
   `session-manager.ts:1228`）。

**使用方式**

```bash
npm start                 # 自动选第一个有 Key 的模型
npm start glm/glm-4.6     # 指定初始模型
/model                    # 列出全部模型与当前模型
/model kimi/kimi-k2       # 切换，下一轮生效
```

**验证**：typecheck 通过；真实调用 DeepSeek 成功；`/model` 列表与切换、
未配 Key 模型的友好报错均正常。

**未尽事项**（后续阶段补齐）：`model_change` 持久化到会话文件（阶段 4）、
流式输出与统一重试契约（阶段 3）、自定义 provider 配置文件（对照 pi 的 models.json）。

**踩坑记录（已知问题，2026-09-26 复盘）**

1. **架构腐化**：`/model` 的解析与 `console.log` 写在了 agentLoop 里，违反
   "哑内核"原则。pi 的命令在会话层拦截（slash-commands.ts），到不了循环。
2. **无 auth 预检**：`/model` 切换总"成功"，第一次发消息才报缺 Key。
   pi 的 `setModel()` 第一步就是 `checkAuth()`（agent-session.ts:2118）。
   教训：切换类操作失败要发生在动作前（preflight），不是动作后。
3. **缺 contextWindow 元数据**：长历史从大窗口模型切到小窗口模型（如
   256k→128k）会直接 400 超上下文。pi 的 Model 带 contextWindow/maxTokens，
   compaction 阈值靠它计算（compaction.ts:246）。没有它，阶段 4 无法做。
4. **API 方言差异没有出口**：全走一条 OpenAI 兼容路径，deepseek-reasoner 的
   reasoning_content 被丢弃，GLM thinking 开关无法表达。pi 用每协议一个适配器
   （packages/ai/src/api/*）+ 每 model 一组 compat 开关（types.ts:1107）解决。
5. **模型目录硬编码会腐烂**：kimi-k2-0905-preview 这类带日期的命名、模型
   弃用/上新都要求改代码。pi 的目录是生成的（models.generated.ts），
   且有 models.json 自定义通道——目录应该是数据，不是代码。
6. **歧义静默失败**：裸 id 匹配多个时返回 undefined，报"未知模型"但实际是
   "有歧义"，两种错误应区分报错（pi：model-resolver.ts:136 显式拒绝并列候选）。
   另：LLM_API_KEY 的 deepseek 专属回退是隐式行为，可调试性差。

**三条归纳（面试视角）**：能力/元数据必须跟模型走；切换类操作要 preflight；
目录是数据、命令属于会话层。

**修复状态（2026-09-26）**：问题 1（命令上移会话层，状态归 `AgentState`）、
2（auth 预检）、6（ResolveResult 区分 not_found/ambiguous）已修复；
另按 ERR-003 修复了请求超时缺失与 readline 丢行/EOF 挂起（LineQueue）。
3/4/5 留待阶段 3/4（compat、contextWindow、模型目录数据化）。

---

## F3 · 工具调用（2026-09-27）

**做了什么**

agent 从"聊天机器人"升级为能动手的 agent：模型可以在一轮任务内连续调用
多个工具（write/read/list/run_command），结果回填后继续推理，直到它认为任务
完成才输出总结。端到端验证：模型自主串行 4 次工具调用完成"创建→确认→删除"。

**代码结构**

```
src/ai/index.ts        # ChatMessage 扩展 toolCalls/toolResult 角色；toWire() 调用边界转换
src/agent/tools.ts     # AgentTool 接口 + 4 个内置工具（read_file/write_file/list_dir/run_command）
src/agent/agent-loop.ts# 双层循环：外层等用户，内层跑工具直到模型不再要工具
```

**关键设计决策（对照 pi）**

1. **双层循环**：外层 = 一条用户输入一个任务；内层 = 工具循环，
   "模型不要工具"是唯一出口（pi：`runLoop` 的内层 while，agent-loop.ts L182）。
2. **工具接口分层**：`AgentTool`（带 execute，留在 agent 包）↔ `ToolSchema`
   （纯 wire 描述，才允许进 ai 包）。循环只把
   `{name, description, parameters}` 三元组传给 StreamFn——pi 同样把
   wire 层的 `Tool`（typebox schema）与带 `execute` 的 `AgentTool` 分开
   （packages/agent/src/types.ts:443）。
3. **消息格式中立 + 边界转换**：内部统一 `toolResult` 角色（含 toolCallId/
   isError），`toWire()` 在出网时才转成 OpenAI 的 `{role:"tool",
   tool_call_id}`——这正是"调用边界转换"原则第一次发挥实际作用：
   换 Anthropic 协议时只需改 toWire，历史与循环零改动。
4. **错误契约**：工具抛错不在循环里炸，而是 `isError: true` + 错误文本回填，
   让模型看到并自己修（pi 的 `createToolResultMessage` 同款哲学）；
   `run_command` 的非零退出码也按"结果"处理（stderr 回填）。
5. **未做（按学习计划刻意留白）**：参数 schema 校验（pi 的
   `validateToolArguments`）、prepare→execute→finalize 三段式与
   before/afterToolCall 钩子、权限检查（阶段 5）、并行工具执行
   （pi 的 sequential/parallel 两种 executionMode）。

**踩坑实验（2026-09-27，详见 ERRORS.md ERR-004/005）**：无校验参数边界实测
——漏传 path 会真实创建名为 `undefined` 的文件、对象参数静默变
`[object Object]`、二进制乱码进上下文；模型方言实测——reasoner 已支持
tools（历史结论过时），但响应携带的 `reasoning_content` 被我们静默丢弃。
结论：校验层 + compat 能力清单是阶段 2 后半/阶段 3 的硬需求。

**验证**：typecheck 通过；真实任务端到端（创建/读取/删除文件）成功，
模型自主多轮工具调用后正确收尾，exit 0。

---

## F4 · 参数校验与友好错误（2026-09-28）

**做了什么**

给工具调用加 prepare 阶段的参数校验：可选参数 null 归一化 → 类型强转
（"123"→123）→ typebox 严格校验。失败时工具不执行，生成格式化的
友好错误文本作为 isError 结果回填给 LLM。

**代码结构**

```
src/agent/validation.ts    # validateToolArguments：归一化/强转/校验/错误格式化
src/agent/agent-loop.ts    # 执行前插入校验，失败走 isError 回填短路径
```

**关键设计决策（对照 pi）**

1. **校验位置在执行之前**（pi：`prepareToolCall` → `validateToolArguments`，
   packages/ai/src/utils/validation.ts:317）——参数垃圾最多走一轮模型往返，
   永远到不了文件系统（ERR-004 的"创建 undefined 文件"从此不可能）。
2. **两层宽容度**：`Value.Convert` 先做强转（模型给数字 path、字符串布尔
   是常态，能救就救），`Value.Check` 再严格把关——pi 同款"先 Convert 后 Check"。
3. **错误文本是给模型的提示词**：逐条列出 `- /path: Expected string` +
   完整收到的参数 + 修正指令。端到端验证：诱导模型漏传 path，它收到错误后
   自行读懂、补全参数重试成功——自愈闭环成立。
4. **structuredClone 隔离**：校验/强转不污染原始 toolCall（pi 同款）。

**验证**：typecheck 通过；ERR-004 五个用例全部按预期拦截/强转；
端到端自愈测试（故意漏传 path → 收错 → 修正重试 → 文件创建成功）通过。

---

## F5 · 截断保护（2026-09-30）

**做了什么**

停止原因（`finish_reason`）从 provider 响应一路透传到循环层；
当 `stopReason === "length"`（输出撞上 token 上限）时，本轮所有 tool_calls
**一律不执行**，逐个回填 isError 结果，让模型重新发起完整调用。

**代码结构**

```
src/ai/index.ts         # AssistantReply.stopReason 透传 finish_reason；支持 LLM_MAX_TOKENS
src/agent/agent-loop.ts # 内层循环的截断保护分支（对照 pi failToolCallsFromTruncatedMessage）
```

**关键设计决策（对照 pi，agent-loop.ts:475）**

1. **为什么必须整体拒绝**：流式参数拼装的 JSON 可能"语法合法、schema 通过，
   但值被静默截断"（截在字符串值内部）——无法区分哪个 call 完整，
   所以宁枉勿纵，一个都不执行。
2. **但每个 call 都要回填**：协议要求 tool_call_id 配对，不回填会导致
   下一轮请求 400（协议毒化）；错误文本 = 原因 + 补救动作
   （重新调用 / 拆分大参数）。
3. **停止原因是独立信源**：截断与否由 provider 声明的元数据决定，
   不能靠的内容猜测；校验层救不了它（schema 描述形状，描述不了完整性）。
4. **请求侧配合**：新增 `LLM_MAX_TOKENS` 控制输出上限——反馈（回填错误）
   与配置（上限）双侧夹住，问题才算真正关闭。

**验证**：typecheck 通过；mock 测试（stopReason=length + 2 个截断 call）
确认 execute 调用 0 次、两个 call 均回填 isError、循环正常继续并结束；
真机验证 `finish_reason` 透传（正常=stop，`LLM_MAX_TOKENS=20` 长输出=length）。

**新发现的缺口（待办）**：循环没有最大迭代次数保护——若模型陷入
"失败→重试→再失败"的循环，会无限消耗额度（pi 在更高层的会话/运行时有
驱动层控制）。阶段 4 做失败恢复时应一并处理。

---

## F6 · Steering（2026-09-30）

**做了什么**

agent 执行期间用户输入不再丢失：新输入缓存在会话层（LineQueue），
内层循环在每个回合边界（工具结果回填后、下一次 LLM 调用前）轮询
`getSteeringMessages`，取到的消息作为普通 user 消息注入。one-at-a-time
语义（每回合最多注入一条，对齐 pi 默认 QueueMode）。执行期间输入
`exit` 转换为"当前回合结束后退出"。

**代码结构**

```
src/agent/agent-loop.ts  # AgentLoopConfig.getSteeringMessages 钩子 + 回合边界轮询注入
src/main.ts              # LineQueue.tryNext() 非阻塞取行；exit→quitRequested 转换
```

**关键设计决策（对照 pi）**

1. **不套第三层循环**：steering = 两条 FIFO 队列 + 回合边界的固定轮询点
   （pi: agent-loop.ts:294；另有进入循环前 L174 与 prepareNextTurn 后 L203
   两处补查，mini-pi 简化为一处）。
2. **注入点收敛在回合边界**：不中止流式输出、不打断 in-flight 工具
   （pi 中那是独立的 abort 通道：Esc → AbortController 贯穿流式与工具执行，
   mini-pi 暂未实现）。工具批次必须整体跑完才轮询——并行批次的中途插入
   会让结果配对变复杂，pi 也选择不做。
3. **轮询必须在 break 之前**：内层循环条件等价于
   `hasMoreToolCalls || pendingMessages.length > 0`（pi L182）——
   纯文本回复 + 队列有消息时也要再跑一回合，否则 steering 被吞掉。
4. **one-at-a-time**：多条插入按 FIFO 每回合消费一条，每条独立影响一次
   推理，避免一次性灌入互相矛盾的多条消息（pi 默认行为）。
5. **退出信号分层**：执行期间 `exit` 由会话层转成 quitRequested，
   循环层只认 getUserMessage 的 null（mock 测试曾因违反此约定死循环）。
6. **未实现（对照 pi 的差距）**：followUp 队列（agent 本该停时才消费）、
   all 模式、abort 硬中断、UI 队列展示与取回（pi 的 Esc 退回编辑器）。

**验证**：typecheck 通过；mock 验证（注入时序、请求 2 含 steering 消息、
两条排队消息各占一回合、正常退出）；真机端到端（`sleep 8` 执行中第 3 秒
插入 steering → 回合边界注入 → 模型总结包含指定语句，exit 0）。

---
