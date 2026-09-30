// agent loop：外层等用户输入，内层"模型要工具 → 执行 → 结果回填 → 再问模型"。
// 命名对照 pi: packages/agent/src/agent-loop.ts 的 runLoop（L162-320）——
// 我们的内层循环就是它的内层 while 的最简版（无 steering/续跑，阶段 2 后半再补）。
//
// 分层约定：循环只读 state.model、只发事件；命令解析在会话层（main.ts）。
import type { ChatMessage, StreamFn } from "../ai/index.js";
import type { ModelDef } from "../ai/models.js";
import type { AgentTool } from "./tools.js";
import { validateToolArguments } from "./validation.js";

// 对照 pi 的 AgentState：跨轮次的可变状态由上层持有，循环只读
export interface AgentState {
	model: ModelDef;
}

export interface AgentLoopConfig {
	systemPrompt: string;
	streamFn: StreamFn;
	tools: AgentTool[];
	state: AgentState;
	// 取下一条用户输入；返回 null 表示退出循环（命令解析发生在这一层的上游）
	getUserMessage: () => Promise<string | null>;
}

// 对照 pi 的 AgentEvent（packages/agent/src/types.ts:485），工具相关事件对齐命名
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "turn_start"; input: string }
	| { type: "message_end"; content: string; model: ModelDef }
	| { type: "tool_execution_start"; tool: string; argsPreview: string }
	| { type: "tool_execution_end"; tool: string; isError: boolean }
	| { type: "agent_end" };

// 工具结果截断：这是上下文卫生（防止单个结果撑爆请求），不是安全规则
const MAX_TOOL_RESULT_CHARS = 20_000;

export async function agentLoop(config: AgentLoopConfig, onEvent: (event: AgentEvent) => void): Promise<void> {
	onEvent({ type: "agent_start" });

	// pi 的约定：systemPrompt 与对话历史分离，请求时才在 LLM 调用边界拼接
	const history: ChatMessage[] = [];

	while (true) {
		// —— 外层循环：一条用户输入开启一个任务 ——
		const input = await config.getUserMessage();
		if (input === null) break;
		if (!input.trim()) continue;
		onEvent({ type: "turn_start", input });
		history.push({ role: "user", content: input });

		// —— 内层循环：模型不要工具时才退出（对照 pi runLoop 的内层 while）——
		while (true) {
			const currentModel = config.state.model;

			const reply = await config.streamFn(
				[{ role: "system", content: config.systemPrompt }, ...history],
				currentModel,
				// 只把 wire 层需要的字段给 ai 包（AgentTool 的 execute 不出 agent 包）
				config.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
			);

			history.push({
				role: "assistant",
				content: reply.content,
				toolCalls: reply.toolCalls.length ? reply.toolCalls : undefined,
				model: `${currentModel.provider}/${currentModel.modelId}`,
			});
			if (reply.content) {
				onEvent({ type: "message_end", content: reply.content, model: currentModel });
			}
			// 模型不再要工具 → 内层结束，回到外层等用户
			if (!reply.toolCalls.length) break;

			// 截断保护（对照 pi 的 failToolCallsFromTruncatedMessage，agent-loop.ts:475）：
			// finish_reason=length 时参数可能"语法合法但静默不完整"（截在字符串值内部），
			// 无法区分哪些完整 → 一个都不执行；但每个 tool_call 仍必须回填 isError
			// 结果（协议要求 id 配对），让模型重新发起完整调用。
			if (reply.stopReason === "length") {
				for (const call of reply.toolCalls) {
					onEvent({
						type: "tool_execution_start",
						tool: call.name,
						argsPreview: call.arguments.slice(0, 120),
					});
					onEvent({ type: "tool_execution_end", tool: call.name, isError: true });
					history.push({
						role: "toolResult",
						content:
							`工具调用 "${call.name}" 未执行：响应触及输出 token 上限，参数可能被截断。` +
							`请重新发起完整的工具调用；若参数过大（如写入大文件），请拆分为多次较小的调用。`,
						toolCallId: call.id,
						toolName: call.name,
						isError: true,
					});
				}
				continue;
			}

			// 执行模型要求的每个工具，结果以 toolResult 消息回填（对照 pi 的 createToolResultMessage）
			for (const call of reply.toolCalls) {
				onEvent({
					type: "tool_execution_start",
					tool: call.name,
					argsPreview: call.arguments.slice(0, 120),
				});

				const tool = config.tools.find((t) => t.name === call.name);
				let content: string;
				let isError = false;
				if (!tool) {
					content = `未知工具: ${call.name}`;
					isError = true;
				} else {
					try {
						// arguments 是 wire 的 JSON 字符串，在执行边界才 parse
						const parsed = JSON.parse(call.arguments || "{}") as unknown;
						// prepare 阶段：参数校验（对照 pi 的 validateToolArguments）。
						// 失败 = 友好错误文本回填，工具不执行，模型看到后自行修正。
						const validation = validateToolArguments(tool, parsed);
						if (!validation.ok) {
							content = validation.message;
							isError = true;
						} else {
							content = await tool.execute(validation.args);
						}
					} catch (err) {
						// 错误不抛出——以 isError 结果回填，让模型自己看到并修正（pi 的错误哲学）
						content = `Error: ${err instanceof Error ? err.message : String(err)}`;
						isError = true;
					}
				}

				onEvent({ type: "tool_execution_end", tool: call.name, isError });
				history.push({
					role: "toolResult",
					content: content.slice(0, MAX_TOOL_RESULT_CHARS),
					toolCallId: call.id,
					toolName: call.name,
					isError,
				});
			}
		}
	}

	onEvent({ type: "agent_end" });
}
