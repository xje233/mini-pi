// L5 观测层 · 事件流 → span 重建器
//
// 为什么是"重建"而不是"插桩"：mini-pi 内核是哑内核 + 事件流（F1 的设计），
// 生命周期已全程广播；观测器只旁听、配对，不需要在循环里传 span context。
// 代价是只能到事件粒度：LLM 请求的"发出时刻"不可观察，用"上一个事件时刻"
// 回溯近似（Node 单线程下事件同步派发，循环紧接着发起请求，误差在毫秒级）。
//
// 事件 → span 配对规则：
//   turn_start                        开 turn span（trace 根）
//   message_update                    首个 delta 开 chat span（start=上一事件时刻）+ TTFT
//   message_appended(role=assistant)  结算 chat span（模型不发言直接调工具时在此回补）
//   tool_execution_start / _end       开/关 execute_tool span（串行配对）
//   steering/compaction/tools_changed/limit_reached → 挂到 turn span 的 event
//   turn_end / agent_end              结算（含防御性清理残余）
//
// 为什么用 assistant 的 message_appended 而不是 message_end 作结算锚点：
// message_end 只在模型有文本输出时才发（agent-loop.ts:227），而每次 LLM 回复
// 都必然 pushMessage(assistant) → message_appended 是"一次 LLM 请求结束"的
// 无歧义锚点（工具批次内的 start/end 之间绝不会插入该事件，可区分
// "同批次下一个工具"与"新一次 LLM 轮"）。

import type { AgentEvent } from "../agent/agent-loop.js";
import type { SpanRecord, SpanStatus } from "./types.js";

/** 落盘出口（对照 pi：exporter 被定义为 adapter 的私事，契约层不含实现） */
export interface TraceSink {
	append(span: SpanRecord): void;
}

export interface TraceCollectorOptions {
	sessionId: string;
	/** 缺省 = 纯内存（测试用）；生产接 TraceStore */
	sink?: TraceSink;
	/** 内容门控（对照 Claude Code 的 OTEL_LOG_* 与 semconv opt-in content）：
	 *  默认只记长度/计数等元数据；开启后正文入 trace（截断到 200 字符）。 */
	content?: boolean;
	/** 可注入时钟（测试确定性） */
	now?: () => number;
}

const CONTENT_MAX_CHARS = 200;

function truncate(text: string): string {
	return text.length > CONTENT_MAX_CHARS ? `${text.slice(0, CONTENT_MAX_CHARS)}…` : text;
}

export class TraceCollector {
	private readonly spans: SpanRecord[] = [];
	/** 未结算 span（turn 沉底，chat/tool 在上；close 时移除） */
	private readonly open: SpanRecord[] = [];
	private openTurn: SpanRecord | null = null;
	private openChat: SpanRecord | null = null;
	private chatDeltas = 0;

	private spanSeq = 0;
	/** 上一个事件的处理时刻（= 最后一个已知活动的结束时间，chat 起点锚） */
	private lastActivity = 0;
	private sinkWarned = false;

	constructor(private readonly opts: TraceCollectorOptions) {}

	/** 只读快照（测试断言用） */
	spansSnapshot(): readonly SpanRecord[] {
		return this.spans;
	}

	/** 当前任务的 trace id（无任务进行中时 null；供审计记录关联） */
	currentTraceId(): string | null {
		return this.openTurn?.traceId ?? null;
	}

	/** AgentEvent → span 状态机（同步）。整体吞错 = 旁路原则：观测失败不影响主流程 */
	onEvent(event: AgentEvent): void {
		const now = this.clock();
		const anchor = this.lastActivity;
		try {
			this.handle(event, now, anchor);
		} catch {
			// 诊断数据不允许反过来影响被观测的系统（pi: "recording must not change ..."）
		}
		this.lastActivity = now;
	}

	private handle(event: AgentEvent, now: number, anchor: number): void {
		switch (event.type) {
			case "turn_start": {
				const turn = this.newSpan("turn", now, null);
				if (this.opts.content) turn.attributes.input = truncate(event.input);
				else turn.attributes.input_chars = event.input.length;
				this.openTurn = turn;
				this.open.push(turn);
				break;
			}
			case "message_update": {
				if (!this.openChat) {
					// 首个 delta 到达才开 chat：start 回溯到上一活动结束（窗口含"请求发出→首字"等待）
					this.openChat = this.newSpan("chat", anchor, this.openTurn);
					this.open.push(this.openChat);
					this.chatDeltas = 0;
				}
				if (this.chatDeltas === 0) this.openChat.attributes.ttft_ms = now - this.openChat.startTime;
				this.chatDeltas++;
				break;
			}
			case "message_appended": {
				if (event.message.role !== "assistant") break;
				// LLM 结束锚点；模型无文本时 chat 尚不存在，在此用 [anchor, now] 回补
				const chat = this.openChat ?? this.newSpan("chat", anchor, this.openTurn);
				if (!this.openChat) this.open.push(chat);
				chat.attributes.model = event.message.model ?? "unknown";
				chat.attributes.output_chars = event.message.content.length;
				chat.attributes.tool_calls = event.message.toolCalls?.length ?? 0;
				if (this.opts.content && event.message.content) chat.attributes.output = truncate(event.message.content);
				this.close(chat, now, "ok");
				this.openChat = null;
				break;
			}
			case "tool_execution_start": {
				this.settleChat(now); // 防御：异常序列下 chat 仍开着时先结算
				const tool = this.newSpan("execute_tool", now, this.openTurn);
				tool.attributes.tool = event.tool;
				if (this.opts.content) tool.attributes.args = truncate(event.argsPreview);
				else tool.attributes.args_chars = event.argsPreview.length;
				this.open.push(tool);
				break;
			}
			case "tool_execution_end": {
				const top = this.open.at(-1);
				if (top?.name === "execute_tool" && top.attributes.tool === event.tool) {
					top.attributes.is_error = event.isError;
					this.close(top, now, event.isError ? "error" : "ok");
				}
				// 无对应 start 的 end：忽略（不造脏 span）
				break;
			}
			case "tool_decision": {
				// 只把"拦截"写进 trace（allow 是默认路径，写进去只会淹没信号；
				// 需要全量放行审计时由 AuditLogger 的 AUDIT_ALLOW 负责，职责分离）
				if (event.decision !== "deny") break;
				const top = this.open.at(-1);
				if (top?.name === "execute_tool" && top.attributes.tool === event.tool) {
					top.attributes.decision = "deny";
					top.attributes.decision_source = event.source;
					if (event.rule) top.attributes.rule = event.rule;
				}
				this.addTurnEvent("tool_decision", now, {
					tool: event.tool,
					source: event.source,
					...(event.rule ? { rule: event.rule } : {}),
				});
				break;
			}
			case "steering_applied":
				this.addTurnEvent(
					"steering",
					now,
					this.opts.content ? { content: truncate(event.content) } : { chars: event.content.length },
				);
				break;
			case "compaction_applied":
				this.addTurnEvent("compaction", now, {
					tokens_before: event.tokensBefore,
					kept_messages: event.keptMessages.length,
				});
				break;
			case "compaction_skipped":
				this.addTurnEvent("compaction_skipped", now);
				break;
			case "tools_changed":
				this.addTurnEvent("tools_changed", now, {
					added: event.added.join(","),
					removed: event.removed.join(","),
				});
				break;
			case "limit_reached":
				this.addTurnEvent("limit_reached", now, { max_turns: event.maxTurns });
				break;
			case "turn_end": {
				this.settleChat(now);
				if (this.openTurn) {
					this.openTurn.attributes.reason = event.reason;
					// aborted / max_turns 是预期控制流（协议完好、会话存活），不是 error
					this.close(this.openTurn, now, "ok");
					this.openTurn = null;
				}
				this.settleLeftovers(now);
				break;
			}
			case "agent_end": {
				this.settleChat(now);
				if (this.openTurn) {
					this.openTurn.attributes.reason = "incomplete";
					this.close(this.openTurn, now, "ok");
					this.openTurn = null;
				}
				this.settleLeftovers(now);
				break;
			}
			case "agent_start":
				break;
		}
	}

	private newSpan(name: string, start: number, parent: SpanRecord | null): SpanRecord {
		// 根 span（turn）的 id 用起始时刻的 base36——序号在 resume 的新进程里会从 0
		// 重新开始，纯序号方案会让两个任务的 traceId 撞名（同一文件内）；带时刻则全局唯一。
		const spanId = parent ? `s${++this.spanSeq}` : `t${start.toString(36)}`;
		return {
			traceId: parent ? parent.traceId : spanId,
			spanId,
			parentSpanId: parent?.spanId ?? null,
			sessionId: this.opts.sessionId,
			name,
			startTime: start,
			endTime: start,
			status: "ok",
			attributes: {},
			events: [],
		};
	}

	/** 结算：写 end/status、移出 open、进快照、旁路落盘（落盘失败静默一次） */
	private close(span: SpanRecord, end: number, status: SpanStatus): void {
		span.endTime = Math.max(end, span.startTime);
		span.status = status;
		const i = this.open.indexOf(span);
		if (i >= 0) this.open.splice(i, 1);
		this.spans.push(span);
		if (this.opts.sink) {
			try {
				this.opts.sink.append(span);
			} catch (err) {
				if (!this.sinkWarned) {
					this.sinkWarned = true;
					process.stderr.write(
						`[trace] 落盘失败（后续静默）: ${err instanceof Error ? err.message : String(err)}\n`,
					);
				}
			}
		}
	}

	private settleChat(now: number): void {
		if (this.openChat) {
			this.close(this.openChat, now, "ok");
			this.openChat = null;
		}
	}

	/** turn_end/agent_end 时清理残余（异常序列防御；正常路径应已空） */
	private settleLeftovers(now: number): void {
		while (this.open.length) {
			const span = this.open.pop()!;
			this.close(span, now, span.status);
		}
	}

	private addTurnEvent(name: string, time: number, attributes?: Record<string, string | number | boolean>): void {
		this.openTurn?.events.push({ name, time, ...(attributes ? { attributes } : {}) });
	}

	private clock(): number {
		return this.opts.now?.() ?? Date.now();
	}
}
