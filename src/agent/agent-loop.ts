// 一层 agent loop：拼接 system prompt + 用户输入 → 发给 LLM → 存回复 → 循环。
// 命名对照 pi: packages/agent/src/agent-loop.ts（那里是双层循环，工具调用在阶段 2 加入）。
import type { ChatMessage, StreamFn } from "../ai/index.js";
import type { ModelDef } from "../ai/models.js";
import { listModels, resolveModel } from "../ai/models.js";

export interface AgentLoopConfig {
	systemPrompt: string;
	streamFn: StreamFn;
	/** 初始模型（对照 pi 的 AgentState.model） */
	model: ModelDef;
	// 取下一条用户输入；返回 null 表示退出循环（循环不关心输入来自 CLI 还是别的 UI）
	getUserMessage: () => Promise<string | null>;
}

// 对照 pi 的 AgentEvent（packages/agent/src/types.ts），先只保留无工具时需要的几种
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "turn_start"; input: string }
	| { type: "model_change"; model: ModelDef }
	| { type: "message_end"; content: string; model: ModelDef }
	| { type: "agent_end" };

export async function agentLoop(config: AgentLoopConfig, onEvent: (event: AgentEvent) => void): Promise<void> {
	onEvent({ type: "agent_start" });

	// pi 的约定：systemPrompt 与对话历史分离（AgentState.systemPrompt / AgentState.messages），
	// 每次请求时才在 LLM 调用边界拼接，历史里永远不混入 system 消息。
	const history: ChatMessage[] = [];

	// 对照 pi 的 AgentSession.setModel()：切换模型只是改这个状态引用，
	// 下一轮请求自然生效，历史消息不需要任何特殊处理。
	let currentModel = config.model;

	while (true) {
		const input = await config.getUserMessage();
		if (input === null) break;
		if (!input.trim()) continue;

		// /model 命令：切换模型（对照 pi 的 slash-commands.ts "model" 命令）
		if (input.startsWith("/model")) {
			const arg = input.slice("/model".length).trim();
			if (!arg) {
				onEvent({ type: "model_change", model: currentModel });
				console.log(`当前模型: ${currentModel.provider}/${currentModel.modelId}\n可用模型:\n${listModels()}`);
				continue;
			}
			const next = resolveModel(arg);
			if (!next) {
				console.log(`未知模型: ${arg}\n可用模型:\n${listModels()}`);
				continue;
			}
			currentModel = next;
			onEvent({ type: "model_change", model: currentModel });
			continue;
		}

		onEvent({ type: "turn_start", input });
		history.push({ role: "user", content: input });

		const reply = await config.streamFn(
			[{ role: "system", content: config.systemPrompt }, ...history],
			currentModel,
		);

		history.push({ role: "assistant", content: reply, model: `${currentModel.provider}/${currentModel.modelId}` });
		onEvent({ type: "message_end", content: reply, model: currentModel });
	}

	onEvent({ type: "agent_end" });
}
