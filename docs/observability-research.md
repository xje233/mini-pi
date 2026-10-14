# L5 观测层调研（Trace · Eval · 护栏）

> 调研日期：2026-10-04。目的：为 mini-pi 实现架构图 L5 层提供依据。
> 一手资料：① pi monorepo 源码（`/home/xje/workplace/pi`，逐文件核对）；
> ② Claude Code 官方监控文档（OTel 导出清单）；③ Codex CLI rollout 格式调查；
> ④ OTel GenAI semantic conventions（industry 标准，Development 状态）。

---

## 0. 先回答一个问题：L5 是"日志机制"吗？

**不只是。** "日志"只是 L5 最底层的数据形态，完整地看它是三块拼图：

| 拼图 | 一句话 | 数据形态 | 消费方式 |
|------|--------|----------|----------|
| **Trace** | 把 agent 干过的事变成**结构化、有因果**的记录 | span 树 / 事件流（JSONL） | 人排查 + 机器分析 |
| **Eval** | 对 trace/结果**打分**，判断"这次/这个版本变好还是变差" | 分数 + 证据（grader 断言） | 回归对比、基线告警 |
| **护栏** | 运行时**策略执行**：拦截、审批、留痕 | 决策事件（decision/source） | 实时阻断 + 审计 |

三者的关系：Trace 是原料，Eval 是加工，护栏既是"前置拦截器"又是"最有价值的 trace 来源"
（拦截决策天然是审计证据）。

三个常见的认知纠正：

1. **Trace ≠ 文本日志**。文本日志无 schema、无因果；trace 有 span 层级（谁包含谁）、
   生命周期（start/end/status）、结构性属性。pi 的 README 把这条写成第一原则：
   *"A span is diagnostic data, not business state. Recording it must not change whether
   the account load runs, succeeds, fails, or is persisted."*（telemetry/README.md:62）
   ——观测必须是**纯旁路**，不能影响业务行为。
2. **Trace ≠ 业务状态**。会话底账（mini-pi 的 session JSONL）是业务状态，要 replay 恢复；
   trace 是诊断数据，可以不完整、可以采样、可以过期删除。二者应当**分开存储**
   （Codex 是少数把两者合一的：rollout 文件每个条目带 timestamp 与 type，
   既能 replay 又能审计——因为它的定位是"事实日志"。见 §3.3）。
3. **Eval 不是"跑一遍看输出对不对"**。agent 的评估对象从 response 扩展到
   trajectory（执行轨迹）：工具调用序列、中间状态、token/延迟都要入评。
   评审器（grader）有三类组合：代码断言 / LLM-as-Judge / 规则匹配。

---

## 1. 行业标准：OTel GenAI 语义约定

OpenTelemetry 的 GenAI semconv（Development 状态，已迁至独立仓库
`open-telemetry/semantic-conventions-genai`）是当前的**命名层标准**——它规定
"一个 LLM 调用、一次工具执行、一个 agent 轮次应该叫什么名字、带哪些属性"。

### 1.1 Span 分类（agent 一棵树）

```
invoke_agent                 ← 一次 agent 轮次（树的根）
├── chat {model}             ← 每次 LLM 调用（也可 generate_content/embeddings）
├── execute_tool {tool}      ← 每次工具执行
│   └── chat / execute_tool  ← 子 agent 嵌套（递归）
└── retrieval / memory       ← RAG 与记忆读写（L2 侧）
```

命名规则：`{gen_ai.operation.name} {gen_ai.request.model}`，如 `chat gpt-4o`。
一个 span 覆盖**逻辑操作**（含自动重试）。

### 1.2 关键属性分层（requirement levels 承担架构职责）

| 等级 | 属性 | 备注 |
|------|------|------|
| Required | `gen_ai.operation.name` | 所有 GenAI span 必填 |
| Required（推理/客户端 agent） | `gen_ai.provider.name` | **`execute_tool` 不含此属性** |
| Conditionally required | `gen_ai.request.model`、`error.type`、`gen_ai.conversation.id`、`gen_ai.request.stream` | 有则必填 |
| Recommended | temperature/max_tokens、`response.model/id/finish_reasons`、usage 计数、TTFC、`server.address` | 可查询性主力 |
| Usage 专项 | `usage.input_tokens`、`usage.output_tokens`、`usage.cache_read/creation.input_tokens`、`usage.reasoning.output_tokens` | 缓存读写与 thinking token 是账单主导项 |
| **Opt-In（内容）** | `gen_ai.input.messages`、`output.messages`、`system_instructions`、`tool.definitions` | **默认关闭**，结构为 role-and-parts JSON |

### 1.3 三条工程教训（来自规范的失败模式清单）

1. **内容捕获是数据分级决策，不是调试开关**：默认只记元数据（模型名、token 数、时长），
   显式 opt-in 才捕获 prompt/工具参数/结果；生产上只对采样 trace 开启。
2. **指标不采样，且严禁高基数**：`request.model`/`response.model` 是有界集；
   session id、prompt 名放 span 属性，**不放指标属性**。
3. **usage 只能在一层上报**：推理 span 与 `invoke_agent` span 都报 usage 会导致
   跨 span 求和时**双重计数**——聚合器必须强制只选一层。

### 1.4 评估与规范的关系

规范给了一个事件：`gen_ai.evaluation.result`——携带评估 name、score、label、
explanation，**把评估分数直接附着在 trace 上**。这就是 Trace 与 Eval 的官方衔接点。

---

## 2. 主流 harness 实证

### 2.1 pi：契约完备、实现稀疏（最重要的参照）

pi 把观测拆成一个独立包 + 一套域 schema，**但全仓库只插桩了 1 个 span**——
这正是 mini-pi 可以"补齐并演示完整 L5"的空间。

#### 2.1.1 契约层（`packages/telemetry`）

核心只有两个接口（`src/index.ts:14-22`），设计约束非常硬：

```ts
interface TelemetryContext {
  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}
interface TelemetrySpan extends TelemetryContext {   // span 自身即子 context
  addEvent(name: string, attributes?: SpanAttributes): void;
  setAttributes(attributes: SpanAttributes): void;
  setStatus(status: SpanStatus): void;               // 'ok' | 'error'
}
```

设计决策（对 mini-pi 直接可搬）：
1. **callback 拥有 span 生命周期，无公开 `end()`**：`startSpan` 在回调 settle 时
   自动结算（正常 = ok，抛出 = error，显式 setStatus 覆盖）。杜绝忘 end / 重复 end。
2. **无全局状态、无 AsyncLocalStorage**：parent 通过参数显式传递——
   Node/Bun/浏览器/worker 全runtime 中立，也意味着"边界转换"哲学延伸到观测。
3. **无 exporter**：契约包只定义接口；导出（OTLP/Sentry/文件）是 adapter 的私事。
   参考实现只有两个：`NOOP_TELEMETRY_CONTEXT`（冻结的单例惰性 span）
   与 `InMemoryTelemetryContext`（`getSpans()` 返回确定性快照，无时间戳，供测试断言）。
4. **adapter 一致性套件**：`createTelemetryAdapterConformance()` 把
   "回调恰调用一次、返回值身份保留、settle 后调用惰性化、属性合并 last-write-wins"
   等语义固化为可复用的测试用例——换 adapter 跑同一套测试。
5. **typed schema（文档即契约）**：`defineTelemetrySchema`（运行时零校验的 typed
   identity）+ `createTypedSpanStarter`（用类型系统约束 span 名、必填 start 属性、
   可选 end 属性、事件名）；schema 文档由脚本生成并被测试锁死
   （`packages/agent/docs/telemetry-schema.md`）。

#### 2.1.2 域 schema（`packages/agent/src/harness/telemetry.ts`）

12 个 span 的完整词汇表（`AGENT_TELEMETRY_SCHEMAS = [AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA]`）：

| span | parent 规则 | 关键属性 | 状态判定 |
|------|------------|----------|----------|
| `pi.ai.request` | any | operation/provider/model/api/streaming；end: response.model/stop_reason、http.status_code、usage 六件套、TTFC、chunk_count | 抛错或返回错误结果 |
| `pi.harness.run` | root_or_external | session.id、lane.name、operation.id、operation.recovery | outcome(completed/aborted/failed/suspended) |
| `pi.harness.compaction` | root_or_external | 同上 | outcome(completed/declined/aborted/failed) |
| `pi.harness.navigation` | root_or_external | 同上 | 同上 |
| `pi.harness.checkpoint` | spans:[run] | checkpoint.kind(normal/abort_reconcile) | 抛错 |
| `pi.harness.turn` | spans:[run] | turn.id | 抛错 |
| `pi.harness.step` | spans:[turn,checkpoint,compaction,navigation] | step.kind(assistant/compaction/branch_summary)、attempt、compaction.reason | outcome(succeeded/retry/failed/aborted/deferred/overflow) |
| `pi.harness.tool` | spans:[turn,run] | tool.name、tool.call_id、tool.replay、tool.recovery | tool.is_error |
| `pi.harness.hook` | any | hook.name（11 个 HOOK_NAMES 枚举）、hook.registration_id | hook.outcome(completed/skipped/blocked/failed) |
| `pi.harness.sleep` | spans:[run,compaction,...] | sleep.delay_ms | sleep.outcome(elapsed/aborted) |
| `pi.harness.event_handler` | any | event.type（28 个 EVENT_TYPES 枚举） | 监听器抛错 |
| `pi.session.write` | any | session.id、item_count、item_kinds | storage 拒绝事务 |

另有两个封闭枚举供属性取值：`HOOK_NAMES`（11 个）与 `EVENT_TYPES`（28 个）。

#### 2.1.3 插桩现状（重要：稀疏是有意的教学空间）

- **全仓库唯一的真实 startSpan** = `pi.harness.hook`
  （`packages/agent/src/harness/hooks.ts:376`，在每个 hook handler 调用点）。
- `packages/ai` 只做**字段透传**：`ProviderRequestOptions.telemetryContext`
  （`src/types.ts:131-135`）+ `buildBaseOptions` 传播——`pi.ai.request` span 没有
  任何 startSpan 调用点。
- `packages/coding-agent` **零插桩**（检索 `startSpan|startHarnessSpan` 为 0 命中；
  该目录的 "telemetry" 全指"安装遥测匿名上报"，另一回事）。
- 官方承认是半成品：`packages/agent/docs/telemetry.md:3`——"most runtime spans and
  cross-process trace propagation remain design or implementation work"。
- 跨进程传播（W3C traceparent）只是设计文档，未实现。

#### 2.1.4 事件流分层消费（`AgentEvent` 的既有出口）

pi 的 `AgentEvent`（`packages/agent/src/types.ts:485`，10 种）有清晰的消费者分工：

| 消费者 | 位置 | 用途 |
|--------|------|------|
| `AgentSession._handleAgentEvent` | coding-agent/src/core/agent-session.ts:894 | 持久化 JSONL + 转发扩展 + 广播订阅者 + auto-retry |
| 交互式 TUI | interactive-mode.ts:3280 | 渲染（tool_execution_start → 组件） |
| print / `--mode json` | print-mode.ts:108 | `JSON.stringify(toJsonEvent(event))` |
| RPC 模式 | rpc-mode.ts:355 | 事件转 RPC 输出 |
| 线上裁剪 | json-event.ts:40 | 去掉累积型 partial/usage 快照，只发 delta，避免 O(n²) 体积 |
| 扩展事件总线 | extensions/runner.ts | 扩展 `pi.on(...)` 分发 |

**telemetry 不是事件流的消费者**（`pi.harness.event_handler` span 只有 schema 没有实现）。
调试日志只有 `/debug` 把**渲染后的终端行**写入 `~/.pi/pi-debug.log`——不是事件流。

#### 2.1.5 护栏（guardrails）：三层，无内置审批

| 层 | 机制 | 位置 |
|----|------|------|
| 1. 能力裁剪（静态） | CLI `--tools` 允许清单 / `--exclude-tools` 拒绝清单 / `--no-builtin-tools`；session 侧 `_allowedToolNames` 过滤三类工具 | cli/args.ts:143、sdk.ts:258、agent-session.ts:3149 |
| 2. 执行前阻断（可编程） | 扩展 `tool_call` 事件可返回 `{block, reason, terminate}`；agent-core 同构机制 `before_tool` hook 聚合（首个 block 胜出）；扩展抛错 = fail-safe 阻断 | agent-session.ts:529、extensions/types.ts:1233、harness/hooks.ts:156 |
| 3. 交互审批原语（不自带 UI 流程） | 扩展拿 `ctx.ui.select/confirm/input` 自行实现审批；各模式各自实现（TUI / RPC 走 `extension_ui_request` 消息 / print 无 UI 默认拒绝） | extensions/types.ts:143、rpc-mode.ts:142 |

附加：项目信任闸门（`project-trust.ts:24`：加载项目资源需信任，无 UI 默认拒绝）、
工具输出截断（2000 行 / 50KB，`tools/truncate.ts:11`）。

**pi 明确没有的**：bash 命令允许清单、OS 级沙箱、内置工具审批 UI。
（对比：Claude Code 的权限系统正是补齐这三样的参考，见下。）

### 2.2 Claude Code：OTel 全量导出 + 权限审计证据链

Claude Code 走的是"把一切导出到 OTLP 后端"的路线，实现是产品级最完整的：

#### 2.2.1 三类信号清单

- **8 个指标**：`session.count`、`lines_of_code.count`、`pull_request.count`、
  `commit.count`、`cost.usage`、`token.usage`（属性 type=input/output/cacheRead/cacheCreation）、
  `code_edit_tool.decision`（编辑工具接受/拒绝计数）、`active_time.total`（user/cli 双桶）。
- **27 类事件**，核心关联属性：`prompt.id`（同一提示内所有事件的 UUID）、
  `event.sequence`、`message.uuid`、`client_request_id`。代表事件：
  `user_prompt`、`assistant_response`、`api_request`（cost/token/duration）、
  `api_error`（含 attempt）、`tool_result`（duration_ms/error_type/decision_source）、
  **`tool_decision`**、`permission_mode_changed`、`compaction`（pre/post tokens）、
  `subagent_completed`、`hook_execution_complete`（num_blocking）。
- **6 类 trace span**（Beta）：

```
claude_code.interaction                    ← 每个用户提示一个根 span
├── claude_code.llm_request                ← 每次 API 请求（ttft_ms、input/cache_read tokens、attempt、stop_reason）
├── claude_code.hook
└── claude_code.tool
    ├── claude_code.tool.blocked_on_user   ← 权限等待（decision、duration_ms）
    ├── claude_code.tool.execution         ← 执行（success、error_class 归一化）
    └── (Agent 工具) 子代理的 llm_request / tool span 递归嵌套
```

#### 2.2.2 权限审计（护栏与 trace 的合流点，最值得偷师）

`tool_decision` 事件在**每次权限决策**时记录，`source` 六态构成证据链：

| source | 含义 | 判定 |
|--------|------|------|
| `config` | allow/deny 规则、企业策略、权限模式、会话授权，或工具本身安全 | — |
| `hook` | PreToolUse / PermissionRequest 钩子决策 | — |
| `user_permanent` | "以后不再问"（保存规则） | 接受 |
| `user_temporary` | 一次性批准 / 本会话授权 | 接受 |
| `user_abort` | 未作答关闭提示（含中断轮次） | 拒绝 |
| `user_reject` | 明确选"否" | 拒绝 |

配套三角：`code_edit_tool.decision` 指标（聚合计数、告警基线）+ 
`permission_mode_changed` 事件（捕获权限升级）+ `hook_execution_complete.num_blocking`（钩子拦截定位）。

#### 2.2.3 隐私与治理（默认全脱敏）

- 默认只发**长度/计数**；6 个 `OTEL_LOG_*` 门控逐级放开：user prompts →
  assistant responses → tool details（bash 命令、MCP 名、tool_input）→ tool content
  （原始文件/输出）→ raw API bodies → managed settings。
- 内容类属性有截断上限（`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`，默认 60KB）。
- 企业治理：托管设置**锁定** OTLP 端点/凭证（启动时删除开发者冲突变量）；
  **仓库设置不可信**（`.claude/settings.json` 只能把导出器设为 `none`）；
  `OTEL_*` **不传给子进程**。
- 传播：Bash 子进程继承 `TRACEPARENT`；直连 API 时每个模型请求带 W3C `traceparent`。

### 2.3 Codex CLI：线性 rollout JSONL + 血缘图

Codex 的路线与前两者不同：**不导出 OTel，而是把一切写进本地 rollout 文件**。

- 路径：`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>.jsonl`，append 模式逐行写。
- 行结构（serde flatten，`item` 字段展开到顶层）：

```json
{ "timestamp": "2026-08-29T01:23:45.678Z", "ordinal": 42, "type": "event_msg", "payload": { "type": "turn_started" } }
```

- 10 种行类型：`session_meta`、`response_item`、`compacted`、`turn_context`、
  `event_msg`（turn_started / token_count）、`world_state`、`security_risk_score`、
  `inter_agent_communication(_metadata)`、`realtime_item`。
- **没有 event 级 parent 树**：单文件是纯线性顺序日志（物理行序 = replay 顺序，
  新版用 `ordinal` 显式表达）。
- 血缘（fork/subagent）在 **thread/rollout 层**：`parent_thread_id`（谁创建）、
  `forked_from_id`（从哪分叉）、`history_base`（共享历史前缀引用，不复制祖先历史——
  子文件只存 suffix，逻辑历史 = `A[0..40] + B[41..]`）。
- 语义：rollout 文件同时是**业务状态（replay/resume）+ 审计日志**——因为它定位为
  "事实日志"，所以合一；解析建议分两层：单文件顺序 parser + 跨文件 lineage resolver。

### 2.4 对照总结

| 维度 | pi | Claude Code | Codex CLI | OTel semconv |
|------|----|----|----|----|
| trace 模型 | callback span（显式传递） | span 树（W3C 上下文） | 线性 JSONL | span 树标准 |
| 导出 | 无（adapter 私事） | OTLP（用户自建后端） | 本地文件 | OTLP |
| 内容捕获 | schema 里有 sensitive 标记，未实现门控 | 6 个门控变量，默认脱敏 | 全量落盘（本地） | opt-in，默认关闭 |
| Eval | 独立 evals 包（vitest-evals） | 无（用户侧） | 无 | `gen_ai.evaluation.result` 事件预留 |
| 护栏 | 三层（静态清单+钩子+UI 原语） | 权限系统 + `tool_decision` 审计 | approval mode + sandbox | 不属规范范围 |
| 与 session 关系 | 分离（span ≠ business state） | 分离 | 合一（rollout 即事实日志） | 分离 |

---

## 3. 对 mini-pi 的落地设计

### 3.1 接缝：为什么 AgentEvent 就是天然的 trace 源

mini-pi 已经是"哑内核 + 事件流"架构：`agentLoop(config, onEvent)` 的 14 种事件
（agent-loop.ts:53）覆盖了生命周期全貌，且**内核不感知消费方**。
这意味着 trace 收集**不需要在内核里插桩 startSpan**——加一个消费者即可：

```
agentLoop ──onEvent──┬──> main.ts UI switch（现有）
                     └──> traceCollector（新增，纯旁路）
```

这正好绕开了 pi"契约完备但没人插桩"的尴尬：pi 需要改每个调用点把 span 传下去，
mini-pi 的事件流把"什么时候发生了什么"已经广播出来了。

### 3.2 五个关键设计决策（对照三家）

1. **span 从事件流重建，而非手动插桩**。给事件流加 `traceId / spanId / parentSpanId`
   做关联：`turn_start` 开 `run` span（或 `turn`），`tool_execution_start/end` 开
   `execute_tool` span，`message_update/end` 归属 `chat` span，`compaction_*` 开
   `compaction` span。线性 JSONL 落盘（Codex 形态），树是**读取时的投影**。
   ——理由：单进程教学项目，显式 span 传递的成本 > 收益；pi 的显式契约留在
   `StreamFn` 那种"跨包边界"用。这个取舍要写进 DEVLOG（对照 pi 的 ref 实现）。
2. **契约按 pi 的最小两接口裁剪，但简化调用形态**。保留"callback 拥有生命周期、
   事件不可 no-throw 之外的副作用、settle 后惰性"三条不变量；`InMemoryTelemetry`
   作为测试断言用（`getSpans()` 确定性快照）；JSONL exporter 作为唯一后端。
3. **内容门控**：默认 trace 只记元数据（工具名、参数长度、结果长度/失败与否、
   token、耗时）；`MINI_PI_TRACE_CONTENT=1` 才记录正文（对照 Claude Code 的
   `OTEL_LOG_*` 与 semconv 的 opt-in content）。原因：内容里有用户代码与文件内容，
   "默认写入磁盘"是数据分级决策。
4. **护栏补审计**：F11 已有 DENY_TOOLS / ENFORCE_RULES / beforeToolCall 阻断，
   但决策只在 UI 一闪而过。补 `tool_decision` 式事件（`tool_name / decision /
   source(config|rule|user) / rule / reason`）并落到 trace——这就是 Claude Code
   证据链的 mini 版，也让护栏从"规则"升级为"可审计的规则"。
5. **Eval 从灰盒开始**：复用 `tests/` 的 mock stream 思路做 host eval harness——
   `evalRun(task, {fixtureTools, mockModel})` 拿 trace 做断言（工具调用序列、
   最终答案、步数上限）；再留一个 LLM-judge 入口（可选、默认关闭）。
   指标 = 每用例 passed/tokens/turns，基线对比 → 回答"这次改动是变好还是变差"。

### 3.3 分步实施计划

**L5-A · Trace 底座（第一优先）**
```
src/telemetry/types.ts     # Span/SpanEvent/SpanStatus + TraceCollector 契约（对照 pi telemetry/src/index.ts 裁剪）
src/telemetry/in-memory.ts # 确定性内存收集器（测试断言用）
src/telemetry/jsonl.ts     # .mini-pi/traces/<sessionId>.jsonl exporter（append-only）
src/telemetry/collector.ts # AgentEvent → span 状态机（映射表：事件 → span 开/关/属性）
src/main.ts                # 接线：onEvent 组合两个消费者；/trace 命令查看最近 span 树
```
验证：mock 事件流回放 → span 树快照断言；真机任务 → trace 文件行数与事件数对账。

**L5-B · 护栏审计（依赖 L5-A）**
```
- tool_decision 事件（内核 beforeToolCall 结果 → 结构化决策）
- DENY_TOOLS / ENFORCE_RULES 分支区分 source；阻断原因入 trace
- /audit 命令：按 session 列出全部决策（谁拦的、拦了什么、依据哪条规则）
```

**L5-C · Eval（依赖 L5-A）**
```
evals/                      # 用例定义（*.eval.mjs，对照 pi 的 evals/ 扁平约定）
src/eval/harness.ts         # mock provider + 真实 provider 双模式；产出 trace 摘要
npm run eval                # 输出 passed/tokens/turns 表 + 与上次基线对比
```

### 3.4 与 pi 的差距清单（作为 L5 完成度的自检）

| 能力 | pi | mini-pi 计划 |
|------|----|----|
| span 契约 | ✅ 完整（callback/NOOP/InMemory/conformance/typed schema） | 裁剪版（不加 typed schema，教学项目不值） |
| 实际插桩 | ❌ 只有 1 个 span | ✅ 事件流重建（覆盖面天然更全） |
| exporter | ❌ 无 | JSONL 文件（本地的 Claude Code 版） |
| 内容门控 | ⚠️ 只有 sensitive 标记 | 环境变量门控（默认脱敏） |
| eval | ✅ vitest-evals + Docker lift | 简化 host eval + 基线对比 |
| 护栏 | ✅ 三层 | F11 已有 2 层；补审计与审批原语 |

---

## 4. 未决问题（待拍板）

> **2026-10-05 进展（见 DEVLOG F12）**：问题 1、2 已拍板并实现——单文件 append
> （`.mini-pi/traces/<sessionId>.jsonl`）+ 事件流重建（`src/telemetry/`）；
> 3 留待 L5-C（先确定性断言）、4 留待 L5-B（护栏审计先行，审批后议）。

1. **trace 存储**：复用一个文件（每 session 一个 JSONL）还是按 trace 分文件？
   建议单文件 append（session 即天然聚合单位），`/trace` 读取时重建树。
2. **是否保留"事件流 → span 重建"的折衷**：如果坚持 pi 的显式 span 传递，
   代码量约 +40%，收益主要是"未来跨进程"——教学项目是否需要？
3. **eval 的评分主体**：先只用确定性断言（代码 grader），还是同时做 LLM-judge？
   建议先确定性（成本零、无 flake），judge 作为 L5-C 可选扩展。
4. **护栏的交互审批**：F11 的 enforce 是"静态规则 + 阻断"；要不要补
   `confirm` 式审批（对照 Claude Code 的 user_temporary/permanent）？
