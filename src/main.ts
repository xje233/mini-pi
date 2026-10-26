#!/usr/bin/env node
// 会话层：readline UI + 斜杠命令解析 + 打印。循环不感知这些（哑内核）。
// 对照 pi：斜杠命令在会话层（slash-commands.ts）拦截，到不了 agent 循环。
import readline from "node:readline";
import { basename } from "node:path";
import { defaultStreamFn } from "./ai/index.js";
import type { ChatMessage } from "./ai/index.js";
import { MODELS, listModels, resolveApiKey, resolveModel } from "./ai/models.js";
import type { ModelDef } from "./ai/models.js";
import { agentLoop, type AgentState } from "./agent/agent-loop.js";
import { DEFAULT_COMPACTION, type CompactionOptions } from "./agent/compaction.js";
import { createTools } from "./agent/tools.js";
import {
	composeGates,
	createApprovalGate,
	createEnforceGate,
	filterVisibleTools,
	matchToolPattern,
	ToolRegistry,
	type ApprovalAnswer,
	type DenyRule,
} from "./agent/tool-registry.js";
import { createSearchToolsTool, type ToolSet } from "./agent/soft-routing.js";
import { SessionManager, replaySession } from "./session/session-manager.js";
import { TraceCollector } from "./telemetry/collector.js";
import { TraceStore } from "./telemetry/store.js";
import { buildSpanTree, formatAgo, formatSpanTree, listTraces } from "./telemetry/view.js";
import { AuditLogger, AuditStore, formatDecision } from "./telemetry/audit.js";

/**
 * 行队列（ERR-003）：readline/promises 的 question() 在第一次 resolve 后
 * 会丢失缓冲区中的后续行（Node 22.23 实测），改用 line 事件自建队列，
 * pull 语义与 agentLoop 的 getUserMessage 对齐。
 */
class LineQueue {
	private pending: string[] = [];
	private waiter: ((line: string | null) => void) | null = null;
	private done = false;

	/**
	 * onLine：每行的同步观察者，返回 true 表示该行已被消费（如 /stop 触发中止），
	 * 不再进入队列。abort 必须在行到达时立即生效，不能等回合边界。
	 */
	constructor(
		private rl: readline.Interface,
		private onLine?: (line: string) => boolean,
	) {
		rl.on("line", (line) => {
			if (this.onLine?.(line)) return;
			if (this.waiter) {
				const resolve = this.waiter;
				this.waiter = null;
				resolve(line);
			} else {
				this.pending.push(line);
			}
		});
		rl.on("close", () => {
			this.done = true;
			if (this.waiter) {
				const resolve = this.waiter;
				this.waiter = null;
				resolve(null);
			}
		});
	}

	next(): Promise<string | null> {
		const buffered = this.pending.shift();
		if (buffered !== undefined) return Promise.resolve(buffered);
		if (this.done) return Promise.resolve(null);
		return new Promise((resolve) => {
			this.waiter = resolve;
		});
	}

	/** 非阻塞读取：只取已缓冲的行（agent 干活期间用户输入会堆在这里），不等待新输入 */
	tryNext(): string | null {
		return this.pending.shift() ?? null;
	}
}

// 初始模型：命令行参数 > （--resume 时）会话里上次的模型 > 第一个配了 Key 的 > 第一个
const modelArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
let initialModel: ModelDef | undefined;
if (modelArg) {
	const result = resolveModel(modelArg);
	if (!result.ok) {
		console.error(
			result.reason === "ambiguous"
				? `模型 "${modelArg}" 有歧义，候选:\n${listModels()}`
				: `未知模型: ${modelArg}\n可用模型:\n${listModels()}`,
		);
		process.exit(1);
	}
	initialModel = result.model;
} else {
	initialModel = MODELS.find((m) => resolveApiKey(m)) ?? MODELS[0];
}
if (!initialModel) {
	console.error("模型注册表为空");
	process.exit(1);
}

// 状态由会话层持有（对照 pi：AgentSession 持有并修改 agent.state.model）
const state: AgentState = { model: initialModel };
// 消息 → 会话 entry id 的映射（compaction 的 firstKeptEntryId 靠它定位保留区起点）
const messageEntryIds = new WeakMap<object, number>();

// —— 会话持久化（对照 pi：session-manager 的追加式 JSONL；底账永不删除）——
const resume = process.argv.includes("--resume");
const session = (() => {
	try {
		return new SessionManager(".mini-pi/sessions", { resume });
	} catch (err) {
		console.error(`会话初始化失败: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
})();
let resumedHistory: ChatMessage[] = [];
if (resume) {
	const replayed = replaySession(session.readEntries());
	resumedHistory = replayed.history;
	// 播种重放消息的 entry id：否则本进程压缩时定位不到保留区起点（F9 排障）
	for (const [msg, id] of replayed.messageEntryIds) messageEntryIds.set(msg, id);
	if (!modelArg && replayed.model) {
		const r = resolveModel(`${replayed.model.provider}/${replayed.model.modelId}`);
		if (r.ok) state.model = r.model;
	}
	console.log(`已恢复会话 ${session.file}（${replayed.history.length} 条消息）`);
}

// —— L5 观测（Trace）：事件流旁路收集 + JSONL 落盘（docs/observability-research.md）——
// trace 是诊断数据不是业务状态 → 与 session 底账分开存储；收集器整体吞错，绝不影响主流程。
// 内容门控：默认只记长度/计数等元数据；MINI_PI_TRACE_CONTENT=1 才把正文写入 trace。
const sessionId = basename(session.file, ".jsonl");
const traceStore = new TraceStore(".mini-pi/traces", sessionId);
const traceCollector = new TraceCollector({
	sessionId,
	sink: traceStore,
	content: process.env.MINI_PI_TRACE_CONTENT === "1",
});

// —— L5 观测（护栏审计）：每次权限决策的账本（对照 Claude Code 的 tool_decision）——
// 与 trace 分文件：审计要求全量/长期保留/跨会话可查。默认只记拦截（降噪）；
// AUDIT_ALLOW=1 记录放行（生产合规应全量）。内容门控与 trace 共用同一开关。
const auditStore = new AuditStore(".mini-pi/audit", sessionId);
const auditLogger = new AuditLogger(auditStore, {
	sessionId,
	content: process.env.MINI_PI_TRACE_CONTENT === "1",
	recordAllow: process.env.AUDIT_ALLOW === "1",
	getTraceId: () => traceCollector.currentTraceId(),
});

/** /model 命令：无参列出模型；带参切换，切换前做 auth 预检（失败不切换） */
function handleModelCommand(arg: string): void {
	if (!arg) {
		console.log(`当前模型: ${state.model.provider}/${state.model.modelId}\n可用模型:\n${listModels()}`);
		return;
	}
	const result = resolveModel(arg);
	if (!result.ok) {
		console.log(
			result.reason === "ambiguous"
				? `模型 "${arg}" 有歧义，候选:\n${listModels()}`
				: `未知模型: ${arg}\n可用模型:\n${listModels()}`,
		);
		return;
	}
	// auth 预检（对照 pi 的 checkAuth，agent-session.ts:2118）：无 Key 直接拒绝切换
	if (!resolveApiKey(result.model)) {
		console.log(`无法切换到 ${arg}：未设置 ${result.model.apiKeyEnv}，请先在 .env 中配置`);
		return;
	}
	state.model = result.model;
	session.append({ type: "model_change", provider: result.model.provider, modelId: result.model.modelId });
	console.log(`[模型] ${state.model.provider}/${state.model.modelId}`);
}

/** /trace 命令：读落盘 span → 投影成树（默认最近一个任务；/trace 2 = 倒数第二个） */
function handleTraceCommand(arg: string): void {
	const spans = traceStore.readAll();
	if (!spans.length) {
		console.log("暂无 trace（完成一次任务后再试）");
		return;
	}
	const traces = listTraces(spans);
	const n = arg ? Number(arg) : 1;
	if (!Number.isInteger(n) || n < 1 || n > traces.length) {
		console.log(`用法: /trace [n]（1 = 最近），当前共 ${traces.length} 个任务`);
		return;
	}
	const summary = traces[traces.length - n]!;
	const roots = buildSpanTree(spans.filter((s) => s.traceId === summary.traceId));
	console.log(
		`[trace] 最近第 ${n}/${traces.length} 个任务 · ${summary.spanCount} spans · ${formatAgo(summary.startTime)}`,
	);
	console.log(formatSpanTree(roots));
}

/** /audit 命令：列出本会话的权限决策（默认最近 20 条，倒序） */
function handleAuditCommand(arg: string): void {
	const records = auditStore.readAll();
	if (!records.length) {
		console.log("暂无审计记录（DENY_TOOLS 隐藏、ENFORCE_RULES 拦截、钩子异常、AUDIT_ALLOW=1 放行时会记录）");
		return;
	}
	const limit = Math.max(1, Number(arg) || 20);
	const shown = records.slice(-limit).reverse();
	console.log(`[audit] 共 ${records.length} 条，展示最近 ${shown.length} 条：`);
	for (const record of shown) console.log(formatDecision(record));
}

console.log(`mini-pi 就绪 | 模型: ${state.model.provider}/${state.model.modelId}`);
console.log(`可用模型:\n${listModels()}\n切换: /model <provider/model>，退出: exit`);

const systemPrompt =
	process.env.SYSTEM_PROMPT ??
	"你是一个运行在用户终端里的 coding agent。用提供的工具完成用户的任务，完成后用一两句话简短总结。用简体中文。";
// terminal 模式下回显/行编辑依赖 output 流——漏掉它会导致"输入不显示"（ERR-006）
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: process.stdin.isTTY,
});

console.log(
	"提示：执行期间输入消息 = steering（回合边界生效）；/stop = 立即中止；/compact = 手动压缩；/trace = 查看任务 trace；/audit = 查看权限决策；exit = 退出（--resume 可恢复上次会话）",
);

/**
 * 会话行解析（忙碌/空闲两条路径共用——F9 排障：命令解析只在空闲路径做时，
 * 执行期间输入的 /compact 会被当成 steering 消息喂给模型）。
 * quit=true 表示用户要退出；messages 为空表示该行已被消费，无需注入。
 */
function parseSessionLine(line: string): { quit: boolean; messages: ChatMessage[] } {
	const trimmed = line.trim();
	if (trimmed === "exit") return { quit: true, messages: [] };
	if (trimmed === "/stop") return { quit: false, messages: [] }; // busy 时已由 onLine 消费；空闲时忽略
	if (trimmed.startsWith("/compact")) {
		compaction.force = true;
		console.log("已排程：下一次 LLM 请求前压缩上下文");
		return { quit: false, messages: [] };
	}
	if (trimmed.startsWith("/model")) {
		handleModelCommand(trimmed.slice("/model".length).trim());
		return { quit: false, messages: [] };
	}
	if (trimmed === "/trace" || trimmed.startsWith("/trace ")) {
		handleTraceCommand(trimmed.slice("/trace".length).trim());
		return { quit: false, messages: [] };
	}
	if (trimmed === "/audit" || trimmed.startsWith("/audit ")) {
		handleAuditCommand(trimmed.slice("/audit".length).trim());
		return { quit: false, messages: [] };
	}
	return { quit: false, messages: [{ role: "user", content: line }] };
}

// 用户在 agent 忙碌期间输入 exit → 本回合结束后退出（quitRequested 由会话层转换，
// 循环层只认 getUserMessage 返回 null）
let quitRequested = false;
// 每个任务一个 AbortController（对齐 pi：activeRun.abortController）
let abortController: AbortController | null = null;
let busy = false;
// 当前回合是否已开始流式打印（决定 message_end 是补换行还是全量打印）
let streamingLine = false;

// —— 工具路由第一步：registry + expose/enforce 双层权限（对照调研文档第四节）——
// ① 注册：全部工具进底账（first-registration-wins）
const registry = new ToolRegistry();
for (const tool of createTools()) registry.register(tool);

// ② 暴露过滤：DENY_TOOLS（逗号分隔，模式：精确名 / domain:* / 前缀*）→ 模型看不见
const denyPatterns = (process.env.DENY_TOOLS ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const visibleTools = filterVisibleTools(registry.all(), denyPatterns);
if (denyPatterns.length) {
	const hidden = registry.all().length - visibleTools.length;
	console.log(`[expose] 已按 DENY_TOOLS 隐藏 ${hidden} 个工具（模式: ${denyPatterns.join(", ")}）`);
}
// L5-B：暴露层隐藏是最隐蔽的一类拦截（模型根本看不见，永远不会产生调用/拒绝事件），
// 必须在启动时留审计，否则事后无法解释"为什么 agent 从不使用某能力"。
for (const tool of registry.all()) {
	if (visibleTools.some((v) => v.name === tool.name)) continue;
	auditStore.append({
		sessionId,
		timestamp: Date.now(),
		traceId: null,
		tool: tool.name,
		decision: "deny",
		source: "config",
		reason: `DENY_TOOLS 隐藏（模型不可见）：${denyPatterns.join(", ")}`,
	});
}

// ③ 执行门控：ENFORCE_RULES 为 JSON 数组 [{ "tool": "run_command", "argsRegex": "\\brm\\b", "reason": "..." }]
//    argsRegex 对参数 JSON 串匹配（对照 Claude Code 的 Bash(rm *) 参数级模式）
const enforceRules: DenyRule[] = (() => {
	const raw = process.env.ENFORCE_RULES;
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as DenyRule[];
		if (!Array.isArray(parsed)) throw new Error("必须是数组");
		return parsed;
	} catch (err) {
		console.error(`ENFORCE_RULES 解析失败: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
})();
if (enforceRules.length) console.log(`[enforce] 已加载 ${enforceRules.length} 条执行门控规则`);

// —— L5-B：交互式审批（ASK_TOOLS 命中时在 execute 前询问；对照 Claude Code 的 user_* 决策源）——
const askPatterns = (process.env.ASK_TOOLS ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
if (askPatterns.length) {
	console.log(`[approval] ${askPatterns.length} 个模式命中时需人工审批（模式: ${askPatterns.join(", ")}）`);
}

// —— 工具路由第二步：defer + search_tools 软路由（对照 Claude Code 的 Tool Search）——
const deferPatterns = (process.env.DEFER_TOOLS ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const deferredTools = visibleTools.filter((t) => deferPatterns.some((p) => matchToolPattern(p, t)));
const softVisible = deferredTools.length
	? visibleTools.filter((t) => !deferredTools.some((d) => d.name === t.name))
	: visibleTools;
const toolSet: ToolSet = { visible: softVisible };
if (deferredTools.length) {
	softVisible.push(createSearchToolsTool(toolSet, deferredTools));
	console.log(`[defer] ${deferredTools.length} 个工具延迟加载，已暴露 search_tools 元工具（模式: ${deferPatterns.join(", ")}）`);
}

// 压缩设置（可变对象：/compact 置 force，循环层消费后复位；参数可用环境变量调小以便测试）
const compaction: CompactionOptions = {
	reserveTokens: Number(process.env.COMPACT_RESERVE_TOKENS ?? DEFAULT_COMPACTION.reserveTokens),
	keepRecentTokens: Number(process.env.COMPACT_KEEP_RECENT_TOKENS ?? DEFAULT_COMPACTION.keepRecentTokens),
};

// —— 交互式审批的会话层实现：复用 LineQueue 的行通道（内核不感知 stdin）——
// 审批提示出现后的下一行即答案；提示出现前缓冲的行仍是 steering（两种语义不混）。
let pendingApproval: { resolve: (answer: string) => void } | null = null;

function resolveApproval(answer: string): void {
	const pending = pendingApproval;
	pendingApproval = null;
	pending?.resolve(answer);
}

/** 向用户提问并等待一行输入（y=本次 / a=本会话总是 / n=拒绝） */
function requestApproval(request: { tool: string; argsPreview: string }): Promise<ApprovalAnswer> {
	process.stdout.write(`\n[审批] ${request.tool} ${request.argsPreview}\n  允许？(y=本次 / a=本会话总是 / n=拒绝): `);
	return new Promise<string>((resolve) => {
		pendingApproval = { resolve };
	}).then((answer) => {
		const normalized = answer.trim().toLowerCase();
		if (normalized === "y" || normalized === "yes") {
			console.log("  已批准（本次）");
			return "yes";
		}
		if (normalized === "a" || normalized === "always") {
			console.log("  已批准（本会话总是）");
			return "always";
		}
		if (normalized === "abort") {
			console.log("  已中止");
			return "abort";
		}
		console.log("  已拒绝");
		return "no";
	});
}

const approvalGate = askPatterns.length
	? createApprovalGate({ patterns: askPatterns, requestApproval })
	: undefined;

// EOF/关闭时唤醒等待中的审批：未作答 = 拒绝（对照 Claude Code 的 user_abort，fail-closed）
rl.on("close", () => resolveApproval("abort"));

const lines = new LineQueue(rl, (line) => {
	// busy 时的行处理：/stop 立即 abort（独立通道）；审批等待期间的行是审批答案；
	// exit 软退出；/compact 即时排程；其余返回 false 进入缓冲作为 steering 消息
	if (!busy) return false;
	const trimmed = line.trim();
	if (trimmed === "/stop") {
		abortController?.abort();
		resolveApproval("abort"); // 唤醒等待中的审批（fail-closed）
		return true;
	}
	if (pendingApproval) {
		if (trimmed === "exit") {
			quitRequested = true;
			abortController?.abort();
			resolveApproval("abort");
			return true;
		}
		resolveApproval(trimmed);
		return true;
	}
	const parsed = parseSessionLine(line);
	if (parsed.quit) quitRequested = true;
	return parsed.messages.length === 0;
});

try {
	await agentLoop(
		{
			systemPrompt,
			streamFn: defaultStreamFn,
			tools: softVisible,
			state,
			getActiveTools: () => toolSet.visible,
			// 多层门控组合：硬规则优先，其次审批；任一 block 即拒绝（归因随裁决透传）
			beforeToolCall: composeGates([
				enforceRules.length ? createEnforceGate(enforceRules) : undefined,
				approvalGate,
			]),
			maxTurns: Number(process.env.MAX_TURNS ?? 30),
			getSignal: () => abortController?.signal,
			initialHistory: resumedHistory,
			compaction,
			getUserMessage: async () => {
				while (true) {
					if (quitRequested) return null;
					if (process.stdin.isTTY) process.stdout.write("\n你: ");
					const input = await lines.next();
					if (input === null) return null; // EOF / 管道结束，正常退出
					const parsed = parseSessionLine(input);
					if (parsed.quit) return null;
					if (!parsed.messages.length) continue;
					// 新任务开始：换新的取消信号
					abortController = new AbortController();
					return parsed.messages[0]!.content;
				}
			},
			// steering：agent 忙碌期间用户输入的行已缓冲在 LineQueue 里，
			// 回合边界逐条取走（one-at-a-time，对齐 pi 默认 QueueMode）
			getSteeringMessages: async () => {
				const line = lines.tryNext();
				if (line === null) return [];
				const parsed = parseSessionLine(line);
				if (parsed.quit) quitRequested = true;
				return parsed.messages;
			},
		},
		(event) => {
			// L5 观测：纯旁路收集（内部吞错，不影响 UI 与循环）
			traceCollector.onEvent(event);
			auditLogger.onEvent(event);
			switch (event.type) {
				case "turn_start":
					busy = true;
					streamingLine = false;
					break;
				case "message_update":
					// 流式增量：首个 delta 先打印头部，之后逐段写 stdout（无缓冲直出）
					if (!streamingLine) {
						process.stdout.write(`\n🤖 [${event.model.provider}/${event.model.modelId}] `);
						streamingLine = true;
					}
					process.stdout.write(event.delta);
					break;
				case "message_end":
					if (streamingLine) {
						process.stdout.write("\n"); // 流式打印已输出内容，只补换行
						streamingLine = false;
					} else {
						console.log(`\n🤖 [${event.model.provider}/${event.model.modelId}] ${event.content}`);
					}
					break;
				case "tool_execution_start":
					console.log(`  ⚙️  ${event.tool} ${event.argsPreview}`);
					break;
				case "tool_execution_end":
					if (event.isError) console.log(`  ⚠️  ${event.tool} 出错（已把错误回填给模型）`);
					break;
				case "steering_applied":
					console.log(`  ↩️  [steering] ${event.content}`);
					break;
				case "message_appended":
					// 底账：每条进入历史的消息都追加进会话文件
					messageEntryIds.set(event.message, session.appendMessage(event.message));
					break;
				case "compaction_applied": {
					// 底账不删：只追加 compaction 条目（重放时投影 = 摘要 + 保留区之后）
					const firstKept = event.keptMessages[0];
					session.append({
						type: "compaction",
						summary: event.summary,
						firstKeptEntryId: firstKept ? (messageEntryIds.get(firstKept) ?? null) : null,
						tokensBefore: event.tokensBefore,
					});
					console.log(
						`  🗜️  [compaction] 约 ${event.tokensBefore} token → 摘要 + 保留 ${event.keptMessages.length} 条近期消息`,
					);
					break;
				}
				case "compaction_skipped":
					console.log(`  🗜️  [compaction] 已跳过：${event.reason}`);
					break;
				case "tools_changed":
					console.log(
						`  🔧 [tools] +${event.added.join(", ")}${event.removed.length ? ` / -${event.removed.join(", ")}` : ""}`,
					);
					break;
				case "limit_reached":
					console.log(`\n⛔ 已达单任务最大工具轮次（${event.maxTurns}），进入强制收尾`);
					break;
				case "turn_end":
					busy = false;
					if (event.reason === "aborted") console.log(`\n⛔ 已中止当前任务`);
					else if (event.reason === "max_turns") console.log(`\n⛔ 已达最大工具轮次，任务结束`);
					break;
				case "agent_end":
					busy = false;
					rl.close();
					break;
			}
		},
	);
} catch (err) {
	console.error(`\n出错: ${err instanceof Error ? err.message : String(err)}`);
	rl.close();
	process.exitCode = 1;
}
