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
import type { AssistantReply, ChatMessage, StreamFn, ToolCall } from "../ai/index.js";
import type { ModelDef } from "../ai/models.js";
import type { DecisionSource, ToolCallDecision } from "./decision.js";
import type { AgentTool } from "./tools.js";
import { validateToolArguments } from "./validation.js";
import { compactHistory, estimateTokens, shouldCompact, summaryMessage, type CompactionOptions } from "./compaction.js";
import { diffToolSets, toolChangesMessage } from "./soft-routing.js";

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
	// 执行门控钩子（对照 pi 的 beforeToolCall）：在 validate 之后、execute 之前
	// 运行，可 block（fail-safe：钩子抛错也视为 block）。返回 undefined = 放行。
	// 裁决带 source/rule 归因（L5-B 审计：区分"规则拦的"与"钩子坏了的"）。
	beforeToolCall?: (input: {
		toolCall: ToolCall;
		tool: AgentTool;
		args: Record<string, unknown>;
	}) => Promise<ToolCallDecision | undefined> | ToolCallDecision | undefined;
	// 软路由：取当前活跃工具集（可被 search_tools 原地修改）。缺省 = config.tools 静态集
	getActiveTools?: () => AgentTool[];
	// 恢复会话时带入的历史（投影后，来自 SessionManager 重放）
	initialHistory?: ChatMessage[];
	// 自动压缩（对照 pi 的 prepareNextTurnWithContext 钩子 + compaction 设置）
	compaction?: CompactionOptions;
}

// 对照 pi 的 AgentEvent（packages/agent/src/types.ts:485）
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "turn_start"; input: string }
	| { type: "message_update"; delta: string; model: ModelDef }
	| { type: "message_end"; content: string; model: ModelDef }
	| { type: "tool_execution_start"; tool: string; argsPreview: string }
	| { type: "tool_execution_end"; tool: string; isError: boolean }
	| { type: "steering_applied"; content: string }
	| { type: "message_appended"; message: ChatMessage }
	| { type: "compaction_applied"; summary: string; tokensBefore: number; keptMessages: ChatMessage[] }
	| { type: "compaction_skipped"; reason: string }
	| { type: "tools_changed"; added: string[]; removed: string[] }
	// L5-B 审计：每次权限决策都是事实。argsChars 恒有；argsPreview 供内容门控消费
	// （默认审计只落长度，MINI_PI_TRACE_CONTENT=1 才落参数正文）。
	| {
			type: "tool_decision";
			tool: string;
			decision: "allow" | "deny";
			source: DecisionSource;
			rule?: string;
			reason?: string;
			argsChars: number;
			argsPreview: string;
	  }
	| { type: "limit_reached"; maxTurns: number }
	| { type: "turn_end"; reason: "completed" | "aborted" | "max_turns" }
	| { type: "agent_end" };

// 工具结果截断：这是上下文卫生（防止单个结果撑爆请求），不是安全规则
const MAX_TOOL_RESULT_CHARS = 20_000;
const DEFAULT_MAX_TURNS = 30;

export async function agentLoop(config: AgentLoopConfig, onEvent: (event: AgentEvent) => void): Promise<void> {
	onEvent({ type: "agent_start" });

	// pi 的约定：systemPrompt 与对话历史分离，请求时才在 LLM 调用边界拼接。
	// 恢复会话时以重放结果为起点（这些消息已持久化过，不再发 message_appended）。
	const history: ChatMessage[] = [...(config.initialHistory ?? [])];
	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;

	// 消息进历史的唯一入口：push + 通知会话层持久化（底账与投影同步生长）。
	// persist=false 用于压缩时保留区消息的"重新入列"——它们早已在底账里。
	const pushMessage = (message: ChatMessage, persist = true): void => {
		history.push(message);
		if (persist) onEvent({ type: "message_appended", message });
	};

	// 软路由：上次已声明的工具集（session 级——声明留在 transcript 里跨任务有效）
	let lastDeclaredTools: string[] | null = config.getActiveTools
		? config.getActiveTools().map((t) => t.name)
		: null;

	while (true) {
		// —— 外层循环：一条用户输入开启一个任务 ——
		const input = await config.getUserMessage();
		if (input === null) break;
		if (!input.trim()) continue;
		onEvent({ type: "turn_start", input });
		pushMessage({ role: "user", content: input });

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

			// 自动压缩：每轮 LLM 请求前检查（对照 pi 的 prepareNextTurnWithContext
			// 钩子安装点，agent-session.ts:587）。只改投影：history 被替换为
			// 摘要 + 近期消息；底账由会话层凭 compaction_applied 事件持久化。
			const comp = config.compaction;
			if (comp) {
				const contextWindow = comp.contextWindow ?? config.state.model.contextWindow;
				const tokensBefore = estimateTokens(history);
				if (comp.force || shouldCompact(tokensBefore, contextWindow, comp)) {
					comp.force = false;
					let compacted;
					try {
						compacted = await compactHistory(
							history,
							config.streamFn,
							config.state.model,
							comp,
							signal,
						);
					} catch (err) {
						// 摘要生成途中被中止：优雅结束本任务，而非顶层报错（审查修复）
						if (signal?.aborted) {
							endReason = "aborted";
							break;
						}
						throw err;
					}
					const { summary, keptFrom } = compacted;
					if (summary) {
						const kept = history.slice(keptFrom);
						history.length = 0;
						// 摘要消息只存在于投影：其持久形态是会话层的 compaction 条目
						pushMessage(summaryMessage(summary), false);
						for (const m of kept) pushMessage(m, false); // 已在底账，不重复持久化
						onEvent({ type: "compaction_applied", summary, tokensBefore, keptMessages: kept });
					} else {
						// 无可压缩内容（近期消息未超出 keepRecentTokens）——必须告知用户，
						// 否则手动 /compact 会被静默吞掉
						onEvent({
							type: "compaction_skipped",
							reason: `可压缩内容不足：近期消息未超出 keepRecentTokens=${comp.keepRecentTokens}`,
						});
					}
				}
			}

			turnsUsed++;

			// 软路由的 declareToolChanges（对照 pi: agent-loop.ts:332）：
			// 活跃工具集与上次声明有差分时，注入 system 消息告知模型。
			// 首轮以当前集为基准（初始集由请求的 tools 参数自然携带）。
			const activeTools = config.getActiveTools?.() ?? config.tools;
			if (config.getActiveTools) {
				const diff = diffToolSets(lastDeclaredTools, activeTools);
				lastDeclaredTools = activeTools.map((t) => t.name);
				if (diff) {
					pushMessage({ role: "system", content: toolChangesMessage(diff) });
					onEvent({ type: "tools_changed", added: diff.added, removed: diff.removed });
				}
			}

			if (turnsUsed > maxTurns && !forceStop) {
				// 达到上限：不再执行工具，给模型一次"纯总结"的机会
				forceStop = true;
				pushMessage({
					role: "user",
					content: `（系统）已达单任务最大工具轮次（${maxTurns}），请立即停止调用工具，直接总结当前进展并结束。`,
				});
				onEvent({ type: "limit_reached", maxTurns });
			}

			const currentModel = config.state.model;

			// 消费流式事件：delta 逐个转发给 UI（对照 pi 的 message_update 透传），
			// done 携带组装完成的完整消息，交给既有的校验/截断/执行逻辑
			let reply: AssistantReply | undefined;
			try {
				for await (const event of config.streamFn(
					[{ role: "system", content: config.systemPrompt }, ...history],
					currentModel,
					// 只把 wire 层需要的字段给 ai 包（AgentTool 的 execute 不出 agent 包）
					activeTools.map(({ name, description, parameters }) => ({ name, description, parameters })),
					signal,
				)) {
					if (event.type === "text_delta") {
						onEvent({ type: "message_update", delta: event.delta, model: currentModel });
					} else if (event.type === "done") {
						reply = event.message;
					} else if (event.type === "error") {
						throw event.error;
					}
				}
			} catch (err) {
				// 用户中止导致的请求取消 ≠ 轮次级故障：优雅结束本任务，回到提示符
				if (signal?.aborted) {
					endReason = "aborted";
					break;
				}
				throw err; // 其余 LLM 错误仍上抛（阶段 4 恢复接管）
			}
			if (!reply) {
				// 流在 done 之前结束：中止则优雅退出，否则视为轮次级故障
				if (signal?.aborted) {
					endReason = "aborted";
					break;
				}
				throw new Error("LLM 流在完成前结束");
			}

			pushMessage({
				role: "assistant",
				content: reply.content,
				toolCalls: reply.toolCalls.length ? reply.toolCalls : undefined,
				model: `${currentModel.provider}/${currentModel.modelId}`,
			});
			if (reply.content) {
				onEvent({ type: "message_end", content: reply.content, model: currentModel });
			}

			// 流被用户中止：partial 的 toolCalls 参数不完整，一律不执行；
			// 但每个仍要回填 aborted 结果（协议配对）。审查修复：此前该分支缺失，
			// 中止时半截参数会进入正常执行路径。
			if (reply.stopReason === "aborted") {
				for (const call of reply.toolCalls) {
					onEvent({
						type: "tool_execution_start",
						tool: call.name,
						argsPreview: call.arguments.slice(0, 120),
					});
					onEvent({ type: "tool_execution_end", tool: call.name, isError: true });
					pushMessage({
						role: "toolResult",
						content: "Operation aborted",
						toolCallId: call.id,
						toolName: call.name,
						isError: true,
					});
				}
				endReason = "aborted";
				break;
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
					pushMessage({
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
						pushMessage({
							role: "toolResult",
							content: reason,
							toolCallId: call.id,
							toolName: call.name,
							isError: true,
						});
						continue;
					}

					const tool = activeTools.find((t) => t.name === call.name);
					// 初始化空串只为满足 TS 控制流分析：下面每条路径都会覆盖它
					let content = "";
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
								// 执行门控：validate 之后、execute 之前（对照 pi 的顺序）。
								// L5-B：决策本身是审计事实——放行/拒绝都发 tool_decision；
								// 钩子抛错必须与"工具自己失败"区分，所以单独 try/catch（fail-safe 阻断）。
								const decisionBase = {
									tool: call.name,
									argsChars: call.arguments.length,
									argsPreview: call.arguments.slice(0, 200),
								};
								let blocked = false;
								if (config.beforeToolCall) {
									try {
										const verdict = await config.beforeToolCall({ toolCall: call, tool, args: validation.args });
										if (verdict?.block) {
											blocked = true;
											content = verdict.reason ?? "工具调用被权限规则拒绝";
											isError = true;
											onEvent({
												type: "tool_decision",
												...decisionBase,
												decision: "deny",
												source: verdict.source ?? "rule",
												...(verdict.rule ? { rule: verdict.rule } : {}),
												reason: content,
											});
										} else {
											// 放行也带归因：审批门放行时 source 是 user_temporary/user_permanent，
											// 无策略时才是 default（审计据此区分"人工批准"与"自动放行"）
											onEvent({
												type: "tool_decision",
												...decisionBase,
												decision: "allow",
												source: verdict?.source ?? "default",
												...(verdict?.rule ? { rule: verdict.rule } : {}),
											});
										}
									} catch (err) {
										blocked = true;
										content = `Error: 权限钩子异常，已按 fail-safe 阻断: ${err instanceof Error ? err.message : String(err)}`;
										isError = true;
										onEvent({
											type: "tool_decision",
											...decisionBase,
											decision: "deny",
											source: "hook",
											reason: content,
										});
									}
								}
								if (!blocked) content = await tool.execute(validation.args, signal);
							}
						} catch (err) {
							// 错误不抛出——以 isError 结果回填，让模型自己看到并修正（pi 的错误哲学）
							content = `Error: ${err instanceof Error ? err.message : String(err)}`;
							isError = true;
						}
					}

					onEvent({ type: "tool_execution_end", tool: call.name, isError });
					pushMessage({
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
					pushMessage(message);
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
