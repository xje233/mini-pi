#!/usr/bin/env node
// CLI 入口：readline 提供 getUserMessage，事件打印到终端。
// 循环本身不知道 UI 的存在（对照 pi 的"哑内核 + 事件流"）。
import readline from "node:readline/promises";
import { defaultStreamFn } from "./ai/index.js";
import { MODELS, listModels, resolveApiKey, resolveModel } from "./ai/models.js";
import { agentLoop } from "./agent/agent-loop.js";

// 初始模型：/model deepseek/deepseek-chat 或默认第一个有 Key 的
const initialModel =
	(process.argv[2] ? resolveModel(process.argv[2]) : undefined) ??
	MODELS.find((m) => resolveApiKey(m)) ??
	MODELS[0];
if (!initialModel) {
	console.error("模型注册表为空");
	process.exit(1);
}

console.log(`mini-pi 就绪 | 模型: ${initialModel.provider}/${initialModel.modelId}`);
console.log(`可用模型:\n${listModels()}\n切换: /model <provider/model>，退出: exit`);

const systemPrompt = process.env.SYSTEM_PROMPT ?? "你是一个乐于助人的助手，用简体中文简短回答。";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

try {
	await agentLoop(
		{
			systemPrompt,
			streamFn: defaultStreamFn,
			model: initialModel,
			getUserMessage: async () => {
				let input: string;
				try {
					input = await rl.question("\n你: ");
				} catch {
					return null; // 输入流已结束（EOF / 管道），视为正常退出
				}
				if (input.trim() === "exit") return null;
				return input;
			},
		},
		(event) => {
			switch (event.type) {
				case "model_change":
					console.log(`[模型] ${event.model.provider}/${event.model.modelId}`);
					break;
				case "message_end":
					console.log(`\n🤖 [${event.model.provider}/${event.model.modelId}] ${event.content}`);
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
