#!/usr/bin/env node
// 会话层：readline UI + 斜杠命令解析 + 打印。循环不感知这些（哑内核）。
// 对照 pi：斜杠命令在会话层（slash-commands.ts）拦截，到不了 agent 循环。
import readline from "node:readline";
import { defaultStreamFn } from "./ai/index.js";
import { MODELS, listModels, resolveApiKey, resolveModel } from "./ai/models.js";
import type { ModelDef } from "./ai/models.js";
import { agentLoop, type AgentState } from "./agent/agent-loop.js";
import { createTools } from "./agent/tools.js";

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

// 初始模型：命令行参数 > 第一个配了 Key 的 > 第一个
let initialModel: ModelDef | undefined;
if (process.argv[2]) {
	const result = resolveModel(process.argv[2]);
	if (!result.ok) {
		console.error(
			result.reason === "ambiguous"
				? `模型 "${process.argv[2]}" 有歧义，候选:\n${listModels()}`
				: `未知模型: ${process.argv[2]}\n可用模型:\n${listModels()}`,
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
	console.log(`[模型] ${state.model.provider}/${state.model.modelId}`);
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

console.log("提示：执行期间输入消息 = steering（回合边界生效）；/stop = 立即中止当前任务；exit = 退出");

// 用户在 agent 忙碌期间输入 exit → 本回合结束后退出（quitRequested 由会话层转换，
// 循环层只认 getUserMessage 返回 null）
let quitRequested = false;
// 每个任务一个 AbortController（对齐 pi：activeRun.abortController）
let abortController: AbortController | null = null;
let busy = false;
// 当前回合是否已开始流式打印（决定 message_end 是补换行还是全量打印）
let streamingLine = false;

const lines = new LineQueue(rl, (line) => {
	// /stop 在 agent 忙碌时立即中止当前任务（abort 是独立通道，不走消息队列）
	if (busy && line.trim() === "/stop") {
		abortController?.abort();
		return true; // 已消费，不进入队列
	}
	return false;
});

try {
	await agentLoop(
		{
			systemPrompt,
			streamFn: defaultStreamFn,
			tools: createTools(),
			state,
			maxTurns: Number(process.env.MAX_TURNS ?? 30),
			getSignal: () => abortController?.signal,
			getUserMessage: async () => {
				while (true) {
					if (quitRequested) return null;
					if (process.stdin.isTTY) process.stdout.write("\n你: ");
					const input = await lines.next();
					if (input === null) return null; // EOF / 管道结束，正常退出
					if (input.trim() === "exit") return null;
					if (input.trim() === "/stop") continue; // 空闲时 /stop 无意义，忽略
					// 命令在本层消费，不进入循环
					if (input.startsWith("/model")) {
						handleModelCommand(input.slice("/model".length).trim());
						continue;
					}
					// 新任务开始：换新的取消信号
					abortController = new AbortController();
					return input;
				}
			},
			// steering：agent 忙碌期间用户输入的行已缓冲在 LineQueue 里，
			// 回合边界逐条取走（one-at-a-time，对齐 pi 默认 QueueMode）
			getSteeringMessages: async () => {
				const line = lines.tryNext();
				if (line === null) return [];
				if (line.trim() === "exit") {
					quitRequested = true;
					return [];
				}
				return [{ role: "user", content: line }];
			},
		},
		(event) => {
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
