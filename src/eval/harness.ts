// L5-C · Eval harness：脚本化模型 + 真实工具 + trace 断言
//
// 设计口径（docs/observability-research.md）：
//  - 确定性优先：模型输出由脚本回放（mock StreamFn），不调真实 API → 零成本、无 flake
//  - 端到端：工具用真实实现（每个 case 独立 tmpdir），verify 断言文件状态
//  - 轨迹断言：复用 TraceCollector 的 span 树（工具序列/拦截/压缩都在事件流里）
//  - 不实现 judge（L5-C 可选项）：需要语义评分时再加 rubric grader，默认只报告不阻断

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "../ai/index.js";
import type { ModelDef } from "../ai/models.js";
import { agentLoop, type AgentEvent, type AgentLoopConfig } from "../agent/agent-loop.js";
import type { CompactionOptions } from "../agent/compaction.js";
import { createTools, type AgentTool } from "../agent/tools.js";
import { TraceCollector } from "../telemetry/collector.js";
import type { SpanRecord } from "../telemetry/types.js";

export interface ScriptedTurn {
	/** 该轮助手文本（缺省 = 只调工具不说话） */
	text?: string;
	toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
	/** 默认 stop；截断用例用 length，中止用例用 aborted */
	stopReason?: string;
}

export interface EvalExpectations {
	/** 工具执行序列（按事件顺序，含被拦截/未执行的调用） */
	toolSequence?: string[];
	/** 真正执行了 execute 的工具数（被拦截/截断/未执行的不算） */
	executedTools?: number;
	/** 最终助手文本（字符串包含 / 正则匹配） */
	finalText?: string | RegExp;
	/** 正常 LLM 调用次数（不含压缩摘要调用） */
	llmCalls?: number;
	/** tool_execution_start 事件数（含协议回填） */
	toolCalls?: number;
	stopReason?: "completed" | "aborted" | "max_turns";
	/** 落盘 span 总数（turn + chat + execute_tool） */
	spans?: number;
	/** span 名称序列（按开始时间；chat 顺序与脚本轮次对应） */
	spanSequence?: string[];
	/** 被拦截的工具名（从 trace 的 decision=deny 提取） */
	deniedTools?: string[];
	/** 是否触发过压缩 */
	compacted?: boolean;
}

export interface EvalCase {
	name: string;
	description?: string;
	input?: string;
	turns: ScriptedTurn[];
	tools?: AgentTool[];
	maxTurns?: number;
	compaction?: CompactionOptions;
	beforeToolCall?: AgentLoopConfig["beforeToolCall"];
	expect?: EvalExpectations;
	/** agentLoop 结束后、临时目录清理前执行（断言文件状态） */
	verify?: (ctx: { cwd: string }) => void | Promise<void>;
}

export interface EvalMetrics {
	llmCalls: number;
	toolCalls: number;
	executedTools: number;
	spans: number;
	durationMs: number;
}

export interface EvalResult {
	name: string;
	passed: boolean;
	failures: string[];
	metrics: EvalMetrics;
}

const EVAL_MODEL: ModelDef = {
	provider: "eval",
	modelId: "scripted",
	apiModel: "scripted",
	baseUrl: "",
	apiKeyEnv: "",
	label: "scripted",
	contextWindow: 128000,
};

export function defineEval(def: EvalCase): EvalCase {
	if (!def.name) throw new Error("eval case 缺少 name");
	if (!def.turns?.length) throw new Error(`eval case「${def.name}」缺少 turns`);
	return def;
}

export async function runCase(def: EvalCase): Promise<EvalResult> {
	const failures: string[] = [];
	const dir = mkdtempSync(join(tmpdir(), "mini-pi-eval-"));
	const originalCwd = process.cwd();
	const events: AgentEvent[] = [];
	const collector = new TraceCollector({ sessionId: "eval" });

	let llmCalls = 0;
	let summaryCalls = 0;
	let scriptIndex = 0;
	let executedTools = 0;
	let asked = false;

	// 真实工具（每个 case 独立临时目录）；包装 execute 以统计"真正执行"的次数
	const tools = (def.tools ?? createTools()).map((tool) => ({
		...tool,
		execute: async (args: Record<string, unknown>, signal?: AbortSignal) => {
			executedTools++;
			return tool.execute(args, signal);
		},
	}));

	// 脚本化模型：正常轮次消费 turns；压缩摘要调用（tools=[]）回放固定摘要、不消耗脚本
	const streamFn: StreamFn = async function* (_messages, _model, schemas) {
		if (schemas.length === 0) {
			summaryCalls++;
			// 压缩摘要只累加 text_delta（compactHistory 的实现），必须两段都发
			yield { type: "text_delta", delta: "（摘要）" };
			yield { type: "done", stopReason: "stop", message: { content: "（摘要）", toolCalls: [], stopReason: "stop" } };
			return;
		}
		const callNo = ++llmCalls;
		const turn = def.turns[scriptIndex++] ?? { text: "（脚本耗尽）" };
		yield {
			type: "done",
			stopReason: turn.stopReason ?? "stop",
			message: {
				content: turn.text ?? "",
				toolCalls: (turn.toolCalls ?? []).map((call, i) => ({
					id: `call-${callNo}-${i}`,
					name: call.name,
					arguments: JSON.stringify(call.arguments),
				})),
				stopReason: turn.stopReason ?? "stop",
			},
		};
	};

	const started = Date.now();
	process.chdir(dir);
	try {
		await agentLoop(
			{
				systemPrompt: "eval",
				streamFn,
				tools,
				state: { model: { ...EVAL_MODEL, contextWindow: def.compaction?.contextWindow ?? EVAL_MODEL.contextWindow } },
				beforeToolCall: def.beforeToolCall,
				maxTurns: def.maxTurns,
				compaction: def.compaction,
				getUserMessage: async () => {
					if (asked) return null;
					asked = true;
					return def.input ?? "eval task";
				},
			},
			(event) => {
				events.push(event);
				collector.onEvent(event);
			},
		);
		if (def.verify) await def.verify({ cwd: dir });
	} catch (err) {
		failures.push(`agentLoop 抛出异常: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		process.chdir(originalCwd);
		rmSync(dir, { recursive: true, force: true });
	}

	const durationMs = Date.now() - started;
	const spans = [...collector.spansSnapshot()];
	const metrics: EvalMetrics = {
		llmCalls,
		toolCalls: events.filter((e) => e.type === "tool_execution_start").length,
		executedTools,
		spans: spans.length,
		durationMs,
	};
	// summaryCalls 目前只用于说明"摘要调用不占脚本"，指标里不展示
	void summaryCalls;

	checkExpectations(def, events, spans, metrics, failures);
	return { name: def.name, passed: failures.length === 0, failures, metrics };
}

function checkExpectations(
	def: EvalCase,
	events: AgentEvent[],
	spans: SpanRecord[],
	metrics: EvalMetrics,
	failures: string[],
): void {
	const expect = def.expect;
	if (!expect) return;

	const toolSequence: string[] = [];
	let stopReason = "missing";
	let finalText = "";
	let compacted = false;
	for (const event of events) {
		if (event.type === "tool_execution_start") toolSequence.push(event.tool);
		if (event.type === "turn_end") stopReason = event.reason;
		if (event.type === "message_end") finalText = event.content;
		if (event.type === "compaction_applied") compacted = true;
	}

	if (expect.toolSequence && JSON.stringify(toolSequence) !== JSON.stringify(expect.toolSequence)) {
		failures.push(`工具序列不符：期望 ${JSON.stringify(expect.toolSequence)}，实际 ${JSON.stringify(toolSequence)}`);
	}
	if (expect.executedTools !== undefined && metrics.executedTools !== expect.executedTools) {
		failures.push(`执行工具数不符：期望 ${expect.executedTools}，实际 ${metrics.executedTools}`);
	}
	if (expect.finalText !== undefined) {
		const ok =
			typeof expect.finalText === "string" ? finalText.includes(expect.finalText) : expect.finalText.test(finalText);
		if (!ok) {
			failures.push(`最终文本不符：期望 ${String(expect.finalText)}，实际 "${finalText.slice(0, 120)}"`);
		}
	}
	if (expect.llmCalls !== undefined && metrics.llmCalls !== expect.llmCalls) {
		failures.push(`LLM 调用次数不符：期望 ${expect.llmCalls}，实际 ${metrics.llmCalls}`);
	}
	if (expect.toolCalls !== undefined && metrics.toolCalls !== expect.toolCalls) {
		failures.push(`工具调用事件数不符：期望 ${expect.toolCalls}，实际 ${metrics.toolCalls}`);
	}
	if (expect.stopReason !== undefined && stopReason !== expect.stopReason) {
		failures.push(`停止原因不符：期望 ${expect.stopReason}，实际 ${stopReason}`);
	}
	if (expect.spans !== undefined && metrics.spans !== expect.spans) {
		failures.push(`span 数不符：期望 ${expect.spans}，实际 ${metrics.spans}`);
	}
	if (expect.spanSequence) {
		const actual = [...spans]
			.sort((a, b) => a.startTime - b.startTime)
			.map((s) => s.name);
		if (JSON.stringify(actual) !== JSON.stringify(expect.spanSequence)) {
			failures.push(`span 序列不符：期望 ${JSON.stringify(expect.spanSequence)}，实际 ${JSON.stringify(actual)}`);
		}
	}
	if (expect.deniedTools) {
		const actual = spans
			.filter((s) => s.name === "execute_tool" && s.attributes.decision === "deny" && typeof s.attributes.tool === "string")
			.map((s) => String(s.attributes.tool))
			.sort();
		const expected = [...expect.deniedTools].sort();
		if (JSON.stringify(actual) !== JSON.stringify(expected)) {
			failures.push(`被拦截工具不符：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
		}
	}
	if (expect.compacted !== undefined && compacted !== expect.compacted) {
		failures.push(`压缩标记不符：期望 ${expect.compacted}，实际 ${compacted}`);
	}
}
