# 工具路由系统调研（阶段 5 权限/软路由的设计依据）

> 调研时间：2026-10-02。来源：Claude Code 权限文档（code.claude.com/docs/en/permissions、
> agent-sdk/permissions）、Anthropic Tool Search 机制报道、pi 源码实证
> （tools/index.ts、sdk.ts、agent-session.ts、agent-loop.ts、extensions/*）。

## 一、主流 harness 的工具路由分五步

```
① 注册（registry）   全部可用工具的底账
② 暴露过滤           决定模型"看得见"什么（allowlist/denylist）
③ 延迟加载（可选）    长尾工具藏到元工具后面，按需召回
④ 执行门控           调用时按规则拦截（工具级/参数级模式）
⑤ 结果改写           afterToolCall 脱敏/压缩
```

## 二、关键机制实证

### 2.1 Claude Code：权限必须双层（最重要的发现）

```
disallowed_tools=["Bash"]        → 工具定义从请求中移除，模型看不见   ← 暴露级
disallowed_tools=["Bash(rm *)"]  → 工具仍可见，rm* 调用每次被拒绝     ← 执行级
allowed_tools=["Read","Grep"]    → 不是"只暴露"，而是"自动批准"（免审批）
```

双层并存的原因：**"看得见但每次要批准"有真实需求**——模型只有知道能力存在，
才会向用户请求授权；参数级模式（`Bash(rm *)`）只有执行层能实现。
规则支持通配：`mcp__puppeteer__*`（server 全部工具）、`mcp__github__get_*`；
未锚定的 `*`/`mcp__*` 会被忽略并告警（防误全放行）。

### 2.2 Tool Search / 延迟加载（Anthropic）

核心工具（~20 个）常驻上下文；长尾工具 `defer_loading: true` → 模型只见一个
`ToolSearch` 元工具 → 需要时模糊搜索 → 命中的 schema 动态注入。
动机（硬数据）：50+ MCP 工具传统方案仅工具定义就占 ~72K token，且工具选择
准确率明显退化（Anthropic 报告：5 台 MCP 服务器 34 个工具时已可测出）；
Tool Search 预载 ~500 token，约 85% 节省。

### 2.3 pi：路由前置为静态过滤，动态性交给扩展

- 过滤三处：SDK（allowlist → `noTools` → settings 默认 → denylist，
  sdk.ts L258-265）→ AgentSession `_refreshToolRegistry`（L3144）→
  `agent.state.tools`（`setActiveToolsByName` L1279）。
- **loader tool 模式**（docs/extensions.md L146-150）：所有工具先注册进
  registry（可执行），active 集合由扩展 `setActiveTools()` 显式切换；
  loop 的 `declareToolChanges`（agent-loop.ts:332）把工具集**差分**
  （toolsAdded/toolsRemoved 结构化字段）写进 transcript system 消息，
  provider 适配层转成各家原生 deferred loading / tool search。
- 扩展工具注册：`pi.registerTool`，**无 namespacing，先到先得**
  （runner.ts L586）；内置/SDK 工具在注册表带 `<builtin:name>`/`<sdk:name>` 源标记。
- 权限：暴露时无权限概念；执行时扩展 `tool_call` 事件钩子
  （agent-session.ts:529）可 block/改写参数，handler 抛错 = fail-safe 阻断；
  对称 `tool_result` 钩子可改写结果。示例：examples/extensions/permission-gate.ts。

## 三、对 mini-pi 三段式设计的评估

| 原设计 | 评估 | 修正 |
|---|---|---|
| 权限校验：无权限的工具一定不暴露 | 对一半 | 拆两层：expose（可见性）+ enforce（执行拦截，支持参数级模式）；"可见但需批准"类工具必须可见才能被请求 |
| 领域划分：划分为不同领域的工具 | 不该是硬阶段 | 领域 = AgentTool 的元数据（domain/tags），供权限 glob 与软路由检索消费；硬分域会造成跨领域工具的召回盲区 |
| 软路由：根据需求召回候选工具 | 路线要选对 | 元工具 + domain/关键词过滤（Claude Code 路线）优先于 harness 侧向量召回——召回失败 = 模型不知道工具存在且无法自救；语义检索留作可插拔实验 |
| （缺）工具变更声明 | 必须补 | 工具集随软路由变化，需 declareToolChanges 式差分通知模型（否则模型拿旧认知调新工具） |

## 四、mini-pi 实现规划（两步）

### 第一步：registry + expose/enforce 双层权限

```
ToolRegistry（全部工具底账，first-registration-wins）
   ├─ 暴露过滤：DENY_TOOLS（模式：精确名 / domain:* / 前缀*）→ 可见集
   └─ 执行门控：beforeToolCall 钩子 + DenyRule（tool 模式 + argsRegex 参数级）
        位置：validate 之后、execute 之前（对照 pi 的顺序）
```

### 第二步：defer + search_tools 软路由

```
长尾工具 defer → 只暴露 search_tools 元工具（domain/关键词过滤）
命中工具注入 + declareToolChanges 差分系统消息（toolsAdded/toolsRemoved）
撤回策略：会话结束或任务边界（对齐 Claude Code：schema 注入后常驻到会话结束）
```
