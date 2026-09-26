# 错误学习日志

> 每次遇到错误都记录在此：现象 → 原因 → 解决 → 延伸（面试考点）。

---

## ERR-001 | 2026-09-25 | LLM HTTP 404（端点拼接错误）

**现象**

```
你: 你好，介绍一下你自己
出错: LLM HTTP 404:
```

**具体内容**

请求 `POST https://api.deepseek.com`（域名根路径）返回 `404 Not Found`，且响应体为空。
当时 `.env` 配置为 `LLM_BASE_URL=https://api.deepseek.com`（少了 `/chat/completions` 路径），
代码里 `fetch(baseURL)` 直接用了这个值，于是打到了根路径上。

**错误原因**

- 直接原因：base URL 只有域名、没有 API 路径，请求 404。
- 根本原因：**"如何从 base URL 得到完整端点"这一知识被留给了用户**，代码没有封装。
  端点路径属于 provider 协议的一部分，谁实现协议谁负责拼接。

**怎么解决**

在 `src/ai/index.ts` 增加 `resolveEndpoint()`：base URL 末尾去掉多余 `/`，
若已含 `/chat/completions` 则原样使用，否则自动拼接。用户现在配
`https://api.deepseek.com` 或完整路径都能跑通。

**延伸 / 面试考点**

1. **404 与 401 的区别**：404 = 路径不存在（先查 URL），401 = 认证失败（先查 Key）。
   排查 HTTP 错误先看状态码类别：4xx 客户端错（配置/参数），5xx 服务端错（重试）。
2. **配置的职责边界**：好的 SDK 只让用户配 `baseURL` + `apiKey`，路径、header、
   重试都封装掉。pi 的做法：每个 API 协议一个适配器（`packages/ai/src/api/`），
   适配器内部拼完整端点，用户层永远不知道路径细节。
3. **为什么要兼容两种写法**：OpenAI 官方 SDK 习惯是 base URL 不带路径（`/v1`），
   但很多教程直接给完整 endpoint。输入归一化（normalization）是集成层的日常工作。
4. **相关坑**：DeepSeek 模型名只有 `deepseek-chat` / `deepseek-reasoner`，
   配了不存在的模型会报 400 `Model Not Exist`——与 404 是不同性质的错误。

---

## ERR-002 | 2026-09-25 | readline was closed（输入流 EOF 未处理）

**现象**

```
🤖 我是你的AI助手，随时为你提供帮助。
出错: readline was closed
```

（真实调用已成功，退出阶段却报错，退出码非 0）

**具体内容**

用管道喂输入（`echo "你好" | npm start`）时，第一轮对话正常完成；
stdin 流结束后 readline 接口触发 `close`，下一次 `rl.question()` 挂起的
Promise 直接 reject，错误消息为 `readline was closed`，被顶层 catch 当成了运行错误。

**错误原因**

- 直接原因：`question()` 的 Promise 在接口关闭时会 reject，代码没有捕获。
- 根本原因：把「输入流正常结束（EOF）」和「真的出错」混为一谈。
  EOF 是交互循环的**正常退出方式**之一（还有用户输 exit、Ctrl+D / Ctrl+C），
  应该归一化为"没有更多输入"，而不是异常。

**怎么解决**

`main.ts` 中把 `rl.question()` 包进 try/catch，reject 时返回 `null`，
让 agentLoop 走正常退出路径。恢复语义：null = 没有更多输入。

**延伸 / 面试考点**

1. **EOF 是事件不是异常**：处理 stdin/socket/流式输入时，"流结束"必须与
   "读写失败"区分开。Node 流的 `end`/`close` 事件 vs `error` 事件。
2. **Promise 化 API 的坑**：readline/promises 的 `question()` 在 close 时 reject，
   这类"资源关闭导致挂起 Promise 拒绝"的模式在数据库连接池、HTTP 长连接里同样出现
   （连接被对端关闭 → 挂起的请求 reject），处理思路一致：区分关闭原因。
3. **退出码约定**：CLI 程序正常退出 exit 0，错误退出非 0；脚本化调用方
   （CI、管道）依赖这个约定。本次 bug 的表象之一就是"成功执行却返回非 0"。
4. **对照 pi**：pi 的 `packages/tui` 自己实现了编辑器与输入循环，
   对 EOF/Ctrl+C 的处理是显式状态机，而不是依赖 Promise 的隐式拒绝。

---

