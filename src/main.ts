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

	constructor(rl: readline.Interface) {
		rl.on("line", (line) => {
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
const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
const lines = new LineQueue(rl);

try {
	await agentLoop(
		{
			systemPrompt,
			streamFn: defaultStreamFn,
			tools: createTools(),
			state,
			getUserMessage: async () => {
				while (true) {
					if (process.stdin.isTTY) process.stdout.write("\n你: ");
					const input = await lines.next();
					if (input === null) return null; // EOF / 管道结束，正常退出
					if (input.trim() === "exit") return null;
					// 命令在本层消费，不进入循环
					if (input.startsWith("/model")) {
						handleModelCommand(input.slice("/model".length).trim());
						continue;
					}
					return input;
				}
			},
		},
		(event) => {
			switch (event.type) {
				case "message_end":
					console.log(`\n🤖 [${event.model.provider}/${event.model.modelId}] ${event.content}`);
					break;
				case "tool_execution_start":
					console.log(`  ⚙️  ${event.tool} ${event.argsPreview}`);
					break;
				case "tool_execution_end":
					if (event.isError) console.log(`  ⚠️  ${event.tool} 出错（已把错误回填给模型）`);
					break;
				case "agent_end":
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
