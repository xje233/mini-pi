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

## ERR-003 | 2026-09-26 | readline/promises 连续 question 丢行 + EOF 挂起不 settle

**现象**

管道喂入多行命令时，只有第一行被处理；其余行不投递，进程一直等到
stdin 关闭才以 exit 0 结束。另一变体：挂起中的 question 在 EOF 时 Promise
永不 settle，Node 报 `Detected unsettled top-level await` 后直接退出。

**具体内容**

`rl.question()` 连续调用 + 管道输入 `a\nb\nc\nexit\n`：第一次拿到 `a`，
第二次要等到 EOF 才返回。用最小复现脚本验证，去掉 `Promise.race` 的
对照版本行为完全一致——排除我们自身逻辑，是 Node 22.23 的
`readline/promises` 行为：**question() 第一次 resolve 后，缓冲区中剩余的行
不会投递给后续的 question 调用**。

**错误原因**

- `question()` 是为"一次一问"的交互设计的，不是通用的逐行读取 API；
  它内部与 prompt 机制耦合，连续调用时对已缓冲数据的投递不可靠。
- 教训：**选型时要区分"交互一次"和"流式逐行"两种需求**，前者用
  question，后者必须用 `line` 事件。

**怎么解决**

`main.ts` 用 `line` 事件自建 `LineQueue`（缓冲队列 + 单一 waiter +
close 置 done），pull 语义与 agentLoop 的 `getUserMessage` 对齐；
prompt 改为 `process.stdout.write`（仅 TTY 时显示）。
最小复现验证：4 行全部按序投递、EOF 干净退出。

**延伸 / 面试考点**

1. **Promise API vs 事件 API**：Promise 表达"一次等待"，事件表达"持续到达"。
   把持续到达的数据塞进一次性 Promise（question）是范畴错误；
   正确模式是"事件 → 队列 → 异步迭代器/pull 接口"。
2. **缓冲与背压**：readline 内部已有行缓冲，自建队列要处理
   "数据先到、等待后到"（进缓冲）与"等待先到、数据后到"（直接唤醒）
   两种时序——本质是单生产者/单消费者队列。
3. **最小复现的价值**：先用 10 行脚本证明是平台行为而非业务 bug，
   再决定绕过方案；排查时"去掉可疑层做对照"（本次去掉 race）能快速定位。
4. **对照 pi**：`packages/tui` 的编辑器完全自建输入处理，
   不依赖 readline/promises 的高层封装——工业级 CLI 都会自己管终端原始输入。

---

## ERR-004 | 2026-09-27 | 无校验的参数边界：String(undefined) / [object Object]（主动踩坑实验）

**现象（实验复现，非线上事故）**

| 实验 | 输入 | 实际结果 |
|---|---|---|
| write_file 漏传 path | `{ content: "hello" }` | **在当前工作目录真的创建了名为 `undefined` 的文件** |
| content 传对象 | `{ path: "...", content: {nested:true} }` | 文件内容变成字面量 `[object Object]`，静默成功 |
| path 传数字 | `{ path: 12345 }` | `String(12345)` → 去打开名为 `12345` 的路径 |
| arguments 为空串/坏 JSON | `JSON.parse("")` | 抛 `Unexpected end of JSON input`（被 isError 回填兜住） |
| read_file 读二进制 | `/usr/bin/ls` | ELF 乱码直接进入对话上下文 |

**错误原因**

- `String(x)` 对任何输入都"成功"，把类型错误变成了**静默的荒谬行为**：
  `undefined` 变成字面量路径、对象变成 `[object Object]`。没有校验层时，
  这些垃圾参数直达文件系统，最坏情况（本次实验）是在真实目录里创建垃圾文件。
- `JSON.parse` 失败虽然被错误回填兜住（模型能自救），但每次都是一轮浪费的往返。
- 读二进制文件没有嗅探/拒绝，浪费上下文且可能让模型困惑。

**怎么解决（2026-09-28 已修复，见 DEVLOG F4）**

1. ✅ 工具参数用 typebox schema 校验（对照 pi：`validateToolArguments`，
   在执行前拦截并生成 isError 结果，不再直达文件系统）。
2. ✅ 拒绝静默强转：类型不匹配走 `Value.Convert` 显式强转（"123"→123），
   无法转换的在校验层拦截，`String(x)` 式静默转换不再可达 execute。
3. JSON.parse 失败仍由 isError 回填兜底（受约束解码保护，实际极少发生）。

**延伸 / 面试考点**

1. **静默强转 vs 快速失败**：`String(undefined)` 能跑通 == 最危险的 bug 类型。
   边界层（工具参数）宁可抛错也不将就。
2. **错误成本不对称**：校验失败的成本是一次模型往返；校验缺失的成本是
   破坏用户文件系统。agent 能动手之后，参数错误从"难看"升级成"危险"。
3. **对照 pi**：`prepareToolCall`（agent-loop.ts:703）在执行前做
   prepareArguments + validateToolArguments + beforeToolCall 钩子三道关，
   我们跳过的每一道都对应上面一类事故。

---

## ERR-005 | 2026-09-27 | 模型方言：reasoner 的工具支持与被丢弃的 reasoning_content（主动踩坑实验）

**现象**

用同一份带 `tools` 的请求实测两个模型：
- `deepseek-chat`：正常返回 tool_calls（`finish_reason: "tool_calls"`）。
- `deepseek-reasoner`：**也支持 tools**（F2 踩坑预告里"reasoner 不支持
  function calling"的历史结论在 2026-09 的 API 上已不成立），
  但响应里多一个我们完全没处理的字段 `reasoning_content`
  （模型完整的思考过程文本），mini-pi 静默丢弃。

**错误原因**

- 按模型能力写死假设（"reasoner 不支持工具"）而不实测——**模型能力是
  时变的**，provider 一个版本就翻转。
- 统一消息格式只映射了 `content`/`tool_calls`，对增量字段（如
  `reasoning_content`）没有"未知字段保留"策略，信息无声丢失。

**怎么解决**

1. 模型能力不写死、要实测：接入新模型时用冒烟脚本验证 tools/长上下文/
   多模态等关键能力（pi 的 `compat` 开关组就是这类实测结果的固化）。
2. `toWire`/响应解析对未知字段宽容：至少把 `reasoning_content` 提取出来
   作为 thinking 事件展示（pi 的流事件里专门有
   `thinking_start/delta/end` 一族，packages/ai/src/types.ts:732）。
3. 阶段 3 做 provider 层时，把"每家 API 独有的字段"列成显式清单。

**延伸 / 面试考点**

1. **兼容层的正确姿势**：内部统一格式是"超集"设计——各 API 的特有信息
   （thinking、usage、cache 命中）都要有位置存放，转换时只增不减。
2. **能力探测 vs 声明式配置**：运行时探测模型能力代价高且不稳定；
   pi 把能力写成模型元数据（contextWindow、reasoning、compat），
   目录数据化（F2 踩坑 5）的又一例证。
3. **实验方法论**：两个模型跑同一个 prompt 对照输出——方言差异必须
   双模型实测才能发现，看文档/猜都不可靠。

---

## ERR-006 | 2026-10-01 | TTY 回显失效：readline 缺 output 流（用户实测发现）

**现象**

交互模式下用户敲键盘：字符不显示（无回显），观感上"无法输入"。
但管道测试（`echo | npm start`）全部通过。

**具体内容**

ERR-003 修复时从 `readline/promises` 换到 `node:readline`，接口配置写成
`createInterface({ input: process.stdin, terminal: process.stdin.isTTY })`——
漏掉了 `output: process.stdout`。readline 在 terminal 模式下的回显与行编辑
是往 output 流写入实现的，缺省时回显链路断裂。管道测试不经过该路径
（isTTY=false，terminal 逻辑整体不激活），所以全绿是"假绿"。

**错误原因**

- 直接原因：readline 接口缺 output 流。
- 根本原因：**测试环境与真实使用环境的 I/O 语义不同**——管道是
  非终端路径，TTY 才是产品的真实路径；TERMIOS/raw mode/回显这些
  只在终端里激活的逻辑完全处于测试盲区。

**怎么解决**

`createInterface({ input, output: process.stdout, terminal: process.stdin.isTTY })`。
验证工具：`script -qec "cmd" /dev/null` 分配伪终端（pty），
让管道输入也能覆盖终端路径。

**延伸 / 面试考点**

1. **"假绿"测试**：测试通过 ≠ 覆盖了真实路径。环境相关的代码分支
   （TTY vs 管道、dev vs prod）必须有对应环境的测试手段。
2. **readline 的回显原理**：terminal 模式 = readline 把 stdin 置 raw mode、
   自己接管按键（行编辑/历史/回显），回显写到 output 流——input/output/
   terminal 三个参数是一个整体，缺一不可。
3. **伪终端测试工具**：`script -qec`（util-linux）、`pty.js`、CI 里的
   `script -c` 包装，是测 CLI 交互的标准手段。
4. **对照 pi**：pi 的 `packages/tui` 完全自建终端渲染层（差分渲染 +
   原始按键处理），不依赖 readline 的 terminal 模式——规避了这一整类
   配置敏感问题，代价是自己维护 TERM 转义、光标、宽字符等全部细节。

---



