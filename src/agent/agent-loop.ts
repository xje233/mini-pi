// agent loop：外层等用户输入，内层"模型要工具 → 执行 → 结果回填 → 再问模型"。
// 命名对照 pi: packages/agent/src/agent-loop.ts 的 runLoop（L162-320）。
//
// steering：回合边界轮询 getSteeringMessages（pi: agent-loop.ts:294）。
// abort：signal 贯穿 LLM 请求与工具执行（pi: Agent.abort() → AbortController），
//   与 steering 分工——steering 温和转向，abort 立即停止；被中止也要回填
//   isError 结果（tool_call 配对协议不因硬中断而破坏）。
// 迭代上限：单任务 LLM 回合数超过 maxTurns 后强制收尾，防失控烧钱。
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
	// 回合边界轮询：取走用户在执行期间插入的 steering 消息
	getSteeringMessages?: () => Promise<ChatMessage[]>;
	// 当前任务的取消信号（对齐 pi：Agent.abort() → activeRun.abortController.abort()）
	getSignal?: () => AbortSignal | undefined;
	// 单任务最大 LLM 回合数（防失控），默认 30
	maxTurns?: number;
}

// 对照 pi 的 AgentEvent（packages/agent/src/types.ts:485）
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "turn_start"; input: string }
	| { type: "message_end"; content: string; model: ModelDef }
	| { type: "tool_execution_start"; tool: string; argsPreview: string }
	| { type: "tool_execution_end"; tool: string; isError: boolean }
	| { type: "steering_applied"; content: string }
	| { type: "limit_reached"; maxTurns: number }
	| { type: "turn_end"; reason: "completed" | "aborted" | "max_turns" }
	| { type: "agent_end" };

// 工具结果截断：这是上下文卫生（防止单个结果撑爆请求），不是安全规则
const MAX_TOOL_RESULT_CHARS = 20_000;
const DEFAULT_MAX_TURNS = 30;

export async function agentLoop(config: AgentLoopConfig, onEvent: (event: AgentEvent) => void): Promise<void> {
	onEvent({ type: "agent_start" });

	// pi 的约定：systemPrompt 与对话历史分离，请求时才在 LLM 调用边界拼接
	const history: ChatMessage[] = [];
	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;

	while (true) {
		// —— 外层循环：一条用户输入开启一个任务 ——
		const input = await config.getUserMessage();
		if (input === null) break;
		if (!input.trim()) continue;
		onEvent({ type: "turn_start", input });
		history.push({ role: "user", content: input });

		const signal = config.getSignal?.();
		let turnsUsed = 0;
		let forceStop = false;
		let endReason: "completed" | "aborted" | "max_turns" = "completed";

		// —— 内层循环：回合循环（pi runLoop 的内层 while）——
		while (true) {
			if (signal?.aborted) {
				endReason = "aborted";
				break;
			}
			turnsUsed++;
			if (turnsUsed > maxTurns && !forceStop) {
				// 达到上限：不再执行工具，给模型一次"纯总结"的机会
				forceStop = true;
				history.push({
					role: "user",
					content: `（系统）已达单任务最大工具轮次（${maxTurns}），请立即停止调用工具，直接总结当前进展并结束。`,
				});
				onEvent({ type: "limit_reached", maxTurns });
			}

			const currentModel = config.state.model;

			let reply;
			try {
				reply = await config.streamFn(
					[{ role: "system", content: config.systemPrompt }, ...history],
					currentModel,
					// 只把 wire 层需要的字段给 ai 包（AgentTool 的 execute 不出 agent 包）
					config.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
					signal,
				);
			} catch (err) {
				// 用户中止导致的请求取消 ≠ 轮次级故障：优雅结束本任务，回到提示符
				if (signal?.aborted) {
					endReason = "aborted";
					break;
				}
				throw err; // 其余 LLM 错误仍上抛（阶段 3 重试 / 阶段 4 恢复接管）
			}

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

					// 已取消 / 已达上限：不再执行，但必须回填（协议配对不因硬中断破坏）
					if (signal?.aborted || forceStop) {
						const reason = signal?.aborted
							? "Operation aborted"
							: `已达单任务最大工具轮次（${maxTurns}），本调用未执行。`;
						onEvent({ type: "tool_execution_end", tool: call.name, isError: true });
						history.push({
							role: "toolResult",
							content: reason,
							toolCallId: call.id,
							toolName: call.name,
							isError: true,
						});
						continue;
					}

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
								content = await tool.execute(validation.args, signal);
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
			// 已中止时跳过轮询——abort 优先于一切待处理消息。
			let steering: ChatMessage[] = [];
			if (!signal?.aborted) {
				steering = (await config.getSteeringMessages?.()) ?? [];
				for (const message of steering) {
					history.push(message);
					onEvent({ type: "steering_applied", content: message.content });
				}
			}

			// 退出判定（互斥，按优先级）：
			// ① 已中止  ② 强制收尾回合里模型仍要工具  ③ 无 steering 且模型不要工具
			if (signal?.aborted) {
				endReason = "aborted";
				break;
			}
			if (forceStop && reply.toolCalls.length) {
				endReason = "max_turns";
				break;
			}
			if (!steering.length && !reply.toolCalls.length) break;
		}

		onEvent({ type: "turn_end", reason: endReason });
		// 中止/上限结束都只终结本任务，回到提示符继续会话（对齐 pi：abort 结束本次 run，
		// 不销毁 session；main.ts 会在下个任务开始时换新的 AbortController）
	}

	onEvent({ type: "agent_end" });
}
