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

## F7 · Abort 硬中断 + 迭代上限（2026-10-01）

**做了什么**

① `signal` 贯穿全链路：`getSignal()` 提供 AbortSignal → `StreamFn`（fetch
取消，`AbortSignal.any` 合并超时与用户取消两个源）→ `tool.execute`
（`run_command` 传入 exec 的 signal，abort 时 kill 子进程）。会话层 `/stop`
触发，立即生效，不经过消息队列。② 单任务 LLM 回合数超 `maxTurns`（默认
30，`MAX_TURNS` 可调）后强制收尾：注入系统提示给模型一次纯总结机会，
若仍要工具则拒绝执行并结束。

**关键设计决策（对照 pi）**

1. **abort 与 steering 是两条独立通道**：steering 走消息队列在回合边界生效；
   abort 走 AbortSignal 立即生效（pi：Esc → `Agent.abort()` →
   `activeRun.abortController.abort()`，interactive-mode.ts:2966）。
2. **硬中断也守协议**：被中止的工具回填 `isError: "Operation aborted"`
   结果（pi 同款），tool_call 配对永不破坏。
3. **abort ≠ 会话销毁**：`turn_end(aborted)` 后回到提示符，会话继续
   （pi：abort 结束本次 run，不销毁 session）。
4. **abort 优先于 steering**：中止后跳过 steering 轮询，排队消息不注入。
5. **迭代上限的柔性设计**：超限时不是直接掐死，而是注入系统提示 + 给模型
   一个纯总结回合（forceStop 标志）；若模型仍要工具才硬结束
   （`turn_end(max_turns)`）。
6. **abort 触发点在会话层行观察者**：LineQueue 的 onLine 回调在行到达时
   同步判断 `/stop`（busy 时消费该行并 abort），保证即时性。

**验证**：typecheck 通过；mock 两条用例（工具执行中 abort：execute 立即
收到 abort 信号、回填 isError、turn_end(aborted)、会话存活；maxTurns=3
失控模型：3 回正常执行 + limit_reached + 强制收尾回合 + turn_end(max_turns)）；
真机端到端（`sleep 20` 第 4 秒 `/stop` → 子进程被杀 → 立即回提示符，exit 0）。

**过程中暴露的锋利边缘**：mock 工具用 plain JSON object 当 parameters，
`Value.Check` 内部直接抛错且信息难懂——已加固：校验器把 schema 非法转换
为明确错误。教训：**接受"schema 是 typebox"这一隐含契约的地方要有显式
防呆**（pi 对非 typebox schema 有独立的 JSON Schema 强转路径，
validation.ts:323）。

---

## F8 · 流式输出 + 连接阶段重试（阶段 3，2026-10-01）

**做了什么**

`defaultStreamFn` 从"全量等待"升级为流式：`stream: true` + 手工 SSE 解析，
`StreamFn` 返回值从 `Promise<AssistantReply>` 升级为 `AsyncIterable<AssistantStreamEvent>`
（text_delta / toolcall_start / toolcall_delta / done / error）。循环层逐 delta
转发 `message_update`，UI 收到 delta 立即写 stdout。连接阶段失败（网络错误、
408/409/429/5xx）自动指数退避重试（±25% 抖动、尊重 retry-after），流开始后
不重试（对齐 pi）。abort 在流中途生效：已生成部分以 done(aborted) 交付。

**代码结构**

```
src/ai/sse.ts           # iterateSseData：getReader + TextDecoder(stream) + 行缓冲（~50 行）
src/ai/index.ts         # 流式事件契约 + partial 组装 + fetchWithRetry
src/agent/agent-loop.ts # 消费 AsyncIterable，delta → message_update
src/main.ts             # 首个 delta 打头部，之后增量写 stdout
```

**关键设计决策（对照 pi）**

1. **SSE 手工解析**（对照 pi 的 iterateSseMessages，anthropic-messages.ts:411）：
   `stream:true` 的 TextDecoder 处理跨 chunk 多字节字符；按行缓冲、凑齐即
   yield——第一个 token 到达即可见，无额外批量缓冲。
2. **partial 可变消息**（对照 pi 的 output 对象）：ai 层内部就地组装
   content/toolCalls（tool_calls 按 index 跨 chunk 累加 arguments），done 时
   交付完整 AssistantReply——循环层的校验/截断/执行逻辑零改动。
3. **重试只覆盖连接阶段**：408/409/429/5xx + 网络错误，指数退避 0.5s×2^n
   cap 8s 抖动 ±25%，尊重 retry-after(-ms)，sleep 可被 signal 中断；流中断
   属于"已消费部分响应"，重试会导致重复生成，故只报 error（pi 同款边界）。
4. **abort 在流式中**：combined signal 让 reader.read() 立即 reject，
   partial 内容以 done(aborted) 交付；循环层 signal.aborted 分支优雅收尾。
5. **tool_calls 流式拼装**：id/name 只在首 chunk 出现，后续 chunk 只有
   index + arguments 片段——ai 层维护 Map<index, entry>，done 时按 index
   排序还原（对照协议抓包结论）。

**验证**：typecheck 通过；本地 SSE mock 服务器三场景（流式组装/500 重试/
中途 abort）全过；真机端到端（流式回复 + 工具调用 + 文件落盘 + exit 0；
`/stop` 在流式中途打断 3000 字长文，文本半句截断、立即回到提示符）。

**排障记录**：两次"abort 未生效"实为测试时序竞争——模型数到 100 约 4-5s
即完成，/stop（5s）到达时任务已结束；改用"禁用工具的 3000 字长文"才稳定
复现中途窗口。教训：**测中断类逻辑要先证明目标仍在运行**（探针 stderr +
时间戳定位）。

---

## F9 · 会话持久化 + 自动压缩（阶段 4，2026-10-02）

**做了什么**

前两层 Memory：① 会话持久化——每个 session 一个 JSONL 文件
（`.mini-pi/sessions/`），每条进历史的消息/模型切换/压缩条目都追加落盘，
`--resume` 顺序重放恢复上下文与模型；② 自动压缩——每轮 LLM 请求前检查
`estimateTokens > contextWindow - reserveTokens`，超限则 LLM 生成结构化摘要、
保留最近 keepRecentTokens，替换**投影**（底账不删，只追加 compaction 条目）。
手动 `/compact` 任意时刻排程。调研依据见 `docs/memory-research.md`。

**代码结构**

```
docs/memory-research.md        # 三层 Memory 调研 + pi 实证（摘要 prompt 逐字、entry schema）
src/session/session-manager.ts # JSONL 追加式底账 + replaySession 重放投影
src/agent/compaction.ts        # 估算/阈值/切点/摘要 prompt（pi 逐字）/摘要生成
src/agent/agent-loop.ts        # pushMessage 统一入口（persist 标志）+ 请求前压缩检查
src/main.ts                    # 底账接线、--resume、/compact、parseSessionLine 统一命令解析
```

**关键设计决策（对照 pi）**

1. **投影变、底账不变**：compaction 只是追加一条
   `{summary, firstKeptEntryId, tokensBefore}`；重放 = 摘要消息 +
   `id >= firstKeptEntryId` 的消息。摘要消息只存在于投影（persist=false），
   其持久形态就是 compaction 条目。
2. **切点安全**：keepRecent 从尾部累加，切点只能落在 user/assistant——
   tool_call/toolResult 配对永不切开（pi 的 findValidCutPoints）。
3. **摘要 prompt 逐字照抄 pi**：结构化格式
   （Goal/Constraints/Progress/Decisions/Next Steps/Critical Context），
   要求精确保留路径/函数名/错误信息——摘要是写给下一个 LLM 的提示词。
4. **估算 = 字符数/4**（pi 的 CHARS_PER_TOKEN=4，无 CJK 特判）——粗但够用，
   有 usage 实测锚定是后续改进。
5. **压缩检查在每轮请求前**（pi 的 prepareNextTurnWithContext 安装点），
   摘要生成是独立 LLM 调用（同模型、无 tools）。
6. **命令解析统一**：忙碌/空闲两条路径共用 parseSessionLine——否则执行期间
   输入的 /compact 会被当成 steering 消息喂给模型（排障中实测撞上）。

**排障记录**

- `firstKeptEntryId=null` 事故：--resume 进程里重放消息不在
  messageEntryIds（WeakMap 仅本进程追加时填充）→ 压缩定位不到保留区起点 →
  重放丢保留区。修复：replaySession 返回 messageEntryIds，恢复时播种。
- 摘要消息曾误持久化为 message entry（会导致重放双重摘要）——改为
  persist=false。
- 手动 /compact 在"近期消息未超 keepRecent"时被静默吞掉——增加
  compaction_skipped 事件。
- 测试时序竞争三连：/stop、/compact 总是慢于任务完成（模型太快）；
  `grep | head` 关管道触发 EPIPE 杀进程。教训同 F5/F7：**测中断/插桩类
  逻辑要先保证执行窗口，输出重定向到文件而非管道截断**。

**验证**：typecheck 通过；确定性三用例（JSONL roundtrip 含压缩投影/resume
续写、切点安全、循环集成压缩后 token 950→131）；真机端到端（创建任务落盘
→ --resume 无工具回答文件内容 → 多轮任务中 /compact 真实触发（165 token →
摘要 + 保留 6 条）→ 压缩后二次恢复，模型凭摘要准确报出 10 个文件）。

---

## F10 · 代码审查 + 回归测试套件（2026-10-02）

**做了什么**

以 DEVLOG 记录的行为为基准逐文件审查，发现并修复 2 个高危缺陷 + 3 个小问题；
把散落在 /tmp 的确定性测试重建为项目内测试套件（`tests/`，`npm test`，13 项）。

**修复的高危缺陷**

1. **超时/中止通道混淆**（`ai/index.ts` SSE catch）：`combined.aborted` 同时
   覆盖「用户中止」和「超时」，超时被伪装成 `done(aborted)` 交付**半截
   toolCalls**。修复：只有 `signal?.aborted`（用户）才走 aborted，超时走
   error 通道。真机验证：`LLM_TIMEOUT_MS=5000` + 长散文 → 文本流到 5s 截断
   并报 `The operation was aborted due to timeout`，exit 1。
2. **循环层缺 `stopReason === "aborted"` 分支**（同源缺陷的另一半）：中止时
   交付的 partial toolCalls 会进入正常执行路径——半截参数直接执行（F5 截断
   保护要防的事故类别，经 abort 通道绕过）。修复：aborted 时全部不执行、
   逐个回填 `Operation aborted`（保持协议配对），`turn_end(aborted)`。

**修复的小问题**

3. 压缩摘要调用缺 abort 感知 catch：中止会炸成顶层错误（exit 1）而非优雅
   `turn_end(aborted)`——已补 try/catch。
4. `iterateSseData` 残余 buffer 未清 `\r`。
5. `.env.example` 补全全部旋钮（timeout/retries/max_tokens/MAX_TURNS/
   COMPACT_*），此前新增的开关无处可查。

**已知未修项（记录）**

- `estimateTokens` 不计 system prompt 与 tools schema 的 token——阈值偏乐观
  （pi 的 estimateMessageTokens 计入两者）。
- `SessionManager.readEntries` 遇损坏行整体失败（应逐行容错跳过）。
- `/model` 切到当前同一模型也会追加 model_change 条目（无害冗余）。
- 压缩后若仍超阈值会立即再压（无冷却/最小间隔；pi 用 tokensBefore 与
  firstKeptEntryId 规避）。

**测试套件**（`npm test`，13 项全绿）：`tests/stream.test.mjs`（SSE 组装/
500 重试/流中 abort）、`tests/session-compaction.test.mjs`（roundtrip/切点/
循环压缩）、`tests/control.test.mjs`（截断/steering/abort/maxTurns）、
`tests/review-fixes.test.mjs`（本次审查的三条修复）。

**教训**：`/tmp` 会被系统清理，回归测试必须住在项目里——这也是本轮重建
测试套件的直接触发原因。

---

## F11 · 工具路由系统（registry / expose-enforce / 软路由，2026-10-02~04）

**做了什么**

工具路由第一步（registry + expose/enforce 双层权限）与第二步（defer +
search_tools 软路由 + declareToolChanges 差分声明）。调研依据见
`docs/tool-routing-research.md`（Claude Code 双层权限 / Tool Search / pi 的
loader tool 模式与 declareToolChanges 实证）。

**代码结构**

```
docs/tool-routing-research.md # 调研存档（五步抽象 + Claude Code/pi 实证 + 设计修正）
src/agent/tool-registry.ts    # registry（first-wins）+ matchToolPattern + 暴露过滤 + enforce 门
src/agent/soft-routing.ts     # search_tools 元工具 + diffToolSets + 差分消息
src/agent/tools.ts            # AgentTool 增加 domain/tags 元数据
src/agent/agent-loop.ts       # beforeToolCall 钩子 + getActiveTools + declareToolChanges
src/main.ts                   # DENY_TOOLS / ENFORCE_RULES / DEFER_TOOLS 环境变量接线
```

**关键设计决策（对照调研）**

1. **权限拆双层**：expose（DENY_TOOLS 命中即从请求移除，模型看不见）+
   enforce（ENFORCE_RULES 参数级 `argsRegex`，对照 `Bash(rm *)`）。
   单层会把"可见但需批准"类工具错杀。
2. **领域是元数据不是阶段**：`domain`/`tags` 供权限 glob（`shell:*`）与
   软路由检索消费，不做硬分域阶段。
3. **软路由选元工具路线**：`search_tools`（domain/关键词过滤，分词 OR 匹配）
   而非向量召回——召回失败时模型可重试自救。
4. **declareToolChanges**：活跃集差分 → `role:"system"` 消息入 transcript
   （对照 pi 的结构化 toolsAdded/toolsRemoved，agent-loop.ts:332），
   首轮以当前集为基准。
5. **enforce 位置**：validate 之后、execute 之前；钩子抛错 = fail-safe 阻断。

**排障记录**

- 多词查询整句子串匹配必然落空（"运行命令 shell 时间" 不是 haystack 子串），
  mock 用单词查询全绿、真机多词查询全挂——修复为分词 OR 语义。教训：
  **检索类匹配必须用真实查询分布测试**（模型的查询天然是多词的）。
- `grep | head` 提前关管道（EPIPE）杀掉被测进程，造成"无压缩条目"假象——
  输出重定向文件再检查。
- `.mjs` 测试里混入 TS 注解（`!`/`Array<>`/`(m: any)`）导致 SyntaxError——
  测试文件保持纯 JS，或改名 `.ts`。

**验证**：typecheck 通过；`npm test` 21 项全绿（含路由 8 项：registry/模式
匹配/暴露过滤/参数级门控/循环集成/search_tools/差分/循环软路由集成）；
真机端到端（ENFORCE_RULES 拦截 rm 且模型给出替代方案；DEFER_TOOLS 下模型
search_tools 召回 run_command → `date` 获取真实系统时间，exit 0）。

---

## F12 · L5 观测第一步：事件流重建 span + /trace（2026-10-05）

**做了什么**

架构图 L5 的 Trace 底座：观测器旁听 AgentEvent 事件流，把"散的事件"配对成
span（括号），append-only JSONL 落盘（`.mini-pi/traces/`，每 session 一个文件），
`/trace` 在读取时按 parentSpanId 投影成树展示。内核零改动——这是 F1"哑内核 +
事件流"设计的直接红利（调研依据：docs/observability-research.md）。

**代码结构**

```
src/telemetry/types.ts     # SpanRecord/SpanEventRecord/SpanNode（pi callback 契约的"快照化"裁剪）
src/telemetry/collector.ts # TraceCollector：AgentEvent → span 状态机（重建核心）
src/telemetry/store.ts     # TraceStore：append-only JSONL + 逐行容错读取
src/telemetry/view.ts      # buildSpanTree/listTraces/formatSpanTree（读取时投影）
src/main.ts                # onEvent 旁路接线 + /trace 命令（会话层）
tests/trace.test.mjs       # 事件脚本 → span 树断言（18 项）
```

**关键设计决策（对照 pi / Codex / Claude Code / OTel semconv）**

1. **事件流重建 ≠ 主动插桩**：pi 用 callback 式 startSpan 在每个调用点手动开
   span（契约完备但全仓库只插桩了 1 个）；mini-pi 不碰内核，collector 维护
   "打开中的 span 栈"，按事件进出配对。代价是只能到事件粒度；收益是零侵入，
   覆盖面天然更全（turn/chat/tool/压缩都在事件流里）。
2. **LLM 结算锚点 = assistant 的 message_appended**（不是 message_end）：
   后者只在模型有文本输出时才发（agent-loop.ts:227）；而工具批次内的
   start/end 之间绝不会插入该事件，所以它是"一次 LLM 请求结束"的无歧义
   锚点，还顺带解决了"模型不发言直接调工具"轮次的 chat span 回补——真机
   4 轮 LLM 里 2 轮是这种情况，全靠它记录。
3. **请求窗口近似**：LLM 请求"发出时刻"没有事件，用"上一个活动时刻"回溯
   （Node 单线程同步派发，循环紧接着发起请求，误差毫秒级）。语义对齐 OTel：
   chat span 覆盖一次逻辑请求（含重试），TTFT 是 span 属性
   （gen_ai.response.time_to_first_chunk 的对应物）。
4. **数据模型是"已结算快照"**：pi 的契约是运行时句柄（startSpan 回调拥有生命
   周期）；重建路线不需要句柄——SpanRecord 就是结算后的一行记录，树不在存储
   里，读取时按 parentSpanId 聚（对照 Codex rollout：单文件线性 JSONL，无
   event 树，replay 靠物理行序）。
5. **traceId 用 base36 时刻而非序号**：纯序号在 --resume 的新进程里从 0 重来，
   两个任务的 traceId 会撞名（同一文件里出现两个 t1，/trace 会把它们合并）；
   根 span 的 id 换成起始时刻 base36 后跨进程唯一（测试 3c 锁住这个行为）。
6. **内容门控默认脱敏**：默认只记长度/计数（input_chars/args_chars）；设
   `MINI_PI_TRACE_CONTENT=1` 才把正文写入（截断 200 字符）。对照 Claude Code
   的 OTEL_LOG_* 六门控与 semconv 的 opt-in content——内容捕获是数据分级
   决策，不是调试开关。
7. **旁路原则写进代码**：collector.onEvent 整体吞错；sink 落盘失败静默一次
   （对照 pi adapter 契约的 "suppress backend failures"）——观测失败绝不影响
   主流程。
8. **compaction/steering/tools_changed/limit_reached 记成 turn span 上的
   event**：这些没有可靠的 start 时刻，不假装有 span（OTel 里 event 就是
   时间点事实）。
9. **存储分离**：trace 与 session 底账分开存储（diagnostic data ≠ business
   state，pi telemetry README 的第一原则）；文件名与会话文件同名
   （`<sessionId>.jsonl`），resume 后仍能对上。

**验证**

- typecheck 通过；`npm test` 全绿（新增 trace 18 项：完整任务重建/abort 路径/
  落盘 roundtrip/坏行容错/跨进程 traceId 不撞名/内容门控/无 start 的 end 防御/
  sink 抛错旁路/格式化输出）。
- 真机端到端：任务"创建→读回→删除文件"→ 9 spans 全部正确重建——4 轮 LLM
  的 chat span（含 2 个无文本轮回补、ttft 657ms/501ms）与 4 个工具 span
  （write 1ms / list 0ms / read 2ms / run_command 876ms）完整配对；
  `--resume` 后 `/trace` 跨进程正常渲染出树。

**未尽事项**（L5 后续）：护栏审计（tool_decision 式决策事件，L5-B）、eval
harness（L5-C）、压缩的摘要 LLM 调用没有 span（无事件，只有 compaction
event）、span 树目前两层（子 agent/并行工具需要更深）、OTLP adapter
（契约留了 TraceSink 口子，未做）。

---
