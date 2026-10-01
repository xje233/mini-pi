// agent loop：外层等用户输入，内层"模型要工具 → 执行 → 结果回填 → 再问模型"。
// 命名对照 pi: packages/agent/src/agent-loop.ts 的 runLoop（L162-320）。
//
// steering（对齐 pi 的回合边界轮询，agent-loop.ts:294）：
// 每个回合结束时（工具结果已入历史、下一次 LLM 调用之前）轮询 getSteeringMessages，
// 取到的消息作为普通 user 消息注入历史。不中止流式输出、不打断 in-flight 工具
// （那是 abort 的职责，pi 用独立的 AbortController 实现）。
//
// 分层约定：循环只读 state.model、只发事件；命令解析/退出约定在会话层（main.ts），
// getUserMessage 返回 null 才是循环认识的退出信号。
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
	// 回合边界轮询：取走用户在执行期间插入的 steering 消息（对齐 pi 的钩子名）。
	// 返回数组：one-at-a-time 语义下每次最多一条，由实现方决定。
	getSteeringMessages?: () => Promise<ChatMessage[]>;
}

// 对照 pi 的 AgentEvent（packages/agent/src/types.ts:485）
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "turn_start"; input: string }
	| { type: "message_end"; content: string; model: ModelDef }
	| { type: "tool_execution_start"; tool: string; argsPreview: string }
	| { type: "tool_execution_end"; tool: string; isError: boolean }
	| { type: "steering_applied"; content: string }
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

		// —— 内层循环：回合循环（pi runLoop 的内层 while）——
		while (true) {
			// 每回合开始时读一次当前模型：上层中途改 state.model 即下一回合生效
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

			if (reply.stopReason === "length") {
				// 截断保护（对照 pi 的 failToolCallsFromTruncatedMessage，agent-loop.ts:475）：
				// 参数可能"语法合法但静默不完整"，无法区分 → 一个都不执行；
				// 但每个 tool_call 仍必须回填 isError 结果（协议要求 id 配对）。
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
			} else {
				// 正常执行模型要求的每个工具，结果以 toolResult 消息回填
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

			// 回合边界：轮询 steering（pi: agent-loop.ts:294 的轮询点）。
			// 取到的消息作为普通 user 消息注入，下一次 LLM 调用即可见。
			const steering = (await config.getSteeringMessages?.()) ?? [];
			for (const message of steering) {
				history.push(message);
				onEvent({ type: "steering_applied", content: message.content });
			}

			// 无 steering 且模型不再要工具 → 本轮任务结束，回到外层等用户。
			// 有 steering（即使模型本要停）→ 再跑一回合，steering 不被 break 吞掉。
			if (!steering.length && !reply.toolCalls.length) break;
		}
	}

	onEvent({ type: "agent_end" });
}
