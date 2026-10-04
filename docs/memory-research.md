# Memory 系统调研（阶段 4 设计依据）

> 调研时间：2026-10-02。来源：主流 harness 对比（Claude Code / Codex CLI / OpenCode / pi）
> + pi 源码实证（session-manager.ts / compaction.ts / estimate.ts / agent-session.ts）。

## 一、概念分层：三层"Memory"

| 层 | 存什么 | 典型实现 | 本项目对应 |
|---|---|---|---|
| ① 会话持久化 | 每个 session 的完整对话（落盘底账，永不删） | JSONL / SQLite | F9 |
| ② 会话内上下文管理 | 发给 LLM 的上下文瘦身（底账的投影） | 阈值触发压缩 | F9 |
| ③ 跨会话记忆 | 跨 session 的规则/偏好/项目知识 | CLAUDE.md / AGENTS.md | 后续可选 |

关键认知：**压缩只改投影，不改底账**。会话文件里永远有全部消息。

## 二、"不是全量发送"的准确语义

- 压缩触发前：**是全量发送**（刻意设计，模型需要完整上下文）。
- 触发后：旧历史被摘要替换，每轮只发「摘要 + 最近未压缩消息」。
- 跨会话：只带 ③ 层资产，从不带全量 transcript。

## 三、压缩策略对比（四家）

| 维度 | Codex CLI | Claude Code | OpenCode | pi |
|---|---|---|---|---|
| 触发 | 阈值 `窗口 - min(输出上限,20K) - 13K`（200K 窗 ≈ 83.5%） | 接近上限自动 + `/compact` 手动 | 无固定阈值：模型自主决定（Compress 工具） | 阈值 `contextTokens > 窗口 - 16384`，每轮请求前检查 |
| 策略 | 两级（结构化状态优先，避免 LLM 调用；服务端加密 blob） | 三级（微压缩卸载大工具结果 / 自动摘要 / 手动焦点指令） | 剪枝优先（>20K 门槛、最近 40K 保护区、skill 输出永不剪）+ 嵌套摘要 | LLM 摘要（预算 ≤ reserve/2）+ 保留最近 20000 token |
| 压缩后恢复 | 自动重读 5 个文件（预算 50K，已知会形成循环） | 无自动重读 | 保护区保住近期上下文 | 摘要 + keepRecent 即全部 |
| 频率 | 阈值/事件驱动，非定时 | 同左 | 模型自主（任务边界） | 同左 |

统一结论：**没有一家定时压缩**——全部阈值/事件驱动。压缩本身要花一次 LLM 调用，没事压是浪费；压太晚有 context rot。阈值是资源管理调参题。

## 四、本地持久化格式

| 产品 | 存储 |
|---|---|
| Claude Code | `~/.claude/projects/<目录哈希>/<session-id>.jsonl`（JSONL） |
| Codex CLI | `~/.codex/sessions/…/rollout-*.jsonl`（JSONL） |
| pi | JSONL **追加式树**（每条 entry 带 `id/parentId`，分支 = 移动 `leafId`） |
| OpenCode | 新版 SQLite（session/message/part 多层） |
| Cursor / Cline | IDE 状态库 SQLite |

CLI 阵营选 JSONL 的理由：追加即写入（崩溃安全）、人类可读可 grep、树/分支天然表达、
SQLite 的查询/并发优势对单用户顺序写场景收益小（pi 的 durable 包把 memory/jsonl/sqlite
做成可插拔后端，是"存储是实现细节"的最佳示范）。

## 五、pi 实现实证（本项目的模板）

### 5.1 压缩（packages/agent/src/harness/compaction/compaction.ts）

- **默认参数**（L157-161）：`enabled: true, reserveTokens: 16384, keepRecentTokens: 20000`。
- **触发**（L246-249）：`contextTokens > contextWindow - reserveTokens`。
- **摘要 prompt**（L420-455，逐字）：system 指令要求"只输出结构化摘要，不要继续对话"；
  user prompt 规定 EXACT 格式：`## Goal / ## Constraints & Preferences / ## Progress
  (Done/In Progress/Blocked) / ## Key Decisions / ## Next Steps / ## Critical Context`，
  要求精确保留文件路径、函数名、错误信息。
- **请求组装**（L555-611）：单条 user 消息 = `<conversation>…</conversation>` +
  （二次压缩时）`<previous-summary>…</previous-summary>`；`maxTokens =
  min(floor(0.8×reserveTokens), model.maxTokens)`。
- **切点规则**（L311-418）：从尾部累加 token 到 keepRecentTokens，再前移到**合法切点**——
  合法切点只能是 user/assistant 消息，**toolResult 永远不是切点**（tool_call/结果对不可切开）。
- **token 估算**（packages/ai/src/utils/estimate.ts）：`CHARS_PER_TOKEN = 4`，纯字符数除以 4，
  无 CJK 特殊处理；优先用最后一次 assistant usage 实测值锚定。

### 5.2 持久化（packages/coding-agent/src/core/session-manager.ts）

- **entry schema**：基类 `{ type, id, parentId, timestamp }`（树）；
  `message`（L64）/ `model_change`（L74）/ `session_info` / `usage` / `compaction`
  （L91-104：`{ summary, firstKeptEntryId, tokensBefore, systemMessage快照 }`）。
- **重放**（L476-512）：从 leaf 回溯到 root 取路径 → 找最后一个 compaction →
  模型上下文 = `[compaction 摘要消息] + firstKeptEntryId 之后的全部 message entries`；
  `model_change`/`usage` 等不进模型上下文，只恢复状态。
- **摘要投影**（packages/coding-agent/src/core/messages.ts L176-183）：
  compaction entry → `role: "user"` 消息，文本 =
  `The conversation history before this point was compacted into the following
  summary:\n\n<summary>\n{summary}\n</summary>`。

### 5.3 触发位置（agent-session.ts L587-606）

挂在 agent 的 `prepareNextTurnWithContext` 钩子上——**每轮构建 assistant 请求之前**运行
（用户消息已写入 session、尚未发起 LLM 请求）；摘要生成是**独立的一次性 LLM 调用**：
同模型、只有 system + 单条 user、无 tools、无缓存。

## 六、mini-pi 的取舍

照抄 pi 的：阈值公式、切点规则（不切 tool 对）、摘要 prompt（逐字）、
"投影变、底账不变"、JSONL 追加式、独立摘要调用。
简化的：树/分支（单链追加，parentId 树留作扩展）、摘要 maxTokens 上限（StreamFn
契约暂无 per-call maxTokens，LLM_MAX_TOKENS 全局兜底）、二次压缩的 UPDATE prompt
（旧摘要作为普通消息参与 serialize）。
