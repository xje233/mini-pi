// LLM 层：OpenAI 兼容协议 + 流式输出 + 连接阶段重试。
// 对照 pi: packages/ai 的精简版——
//   流事件契约 ≈ AssistantMessageEvent（types.ts:732）
//   SSE 解析   ≈ iterateSseMessages（anthropic-messages.ts:411）
//   重试       ≈ provider-retry.ts（只重试连接阶段，流开始后不重试）
// 内部消息格式 provider 中立；出网前在"调用边界"转成 wire format。
import type { ModelDef } from "./models.js";
import { resolveApiKey } from "./models.js";
import { iterateSseData } from "./sse.js";

export type ChatRole = "system" | "user" | "assistant" | "toolResult";

/** 模型发起的工具调用（assistant 消息携带；arguments 保持 wire 的 JSON 字符串） */
export interface ToolCall {
	id: string;
	name: string;
	arguments: string;
}

export interface ChatMessage {
	role: ChatRole;
	content: string;
	/** assistant：谁生成的（对照 pi 的 AssistantMessage.provider/model 字段） */
	model?: string;
	toolCalls?: ToolCall[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

/** 出网用的工具描述。ai 包只认识 wire 层的 schema，不认识带 execute 的 AgentTool */
export interface ToolSchema {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** 一次回复的最终形态（流 done 事件的 message 字段） */
export interface AssistantReply {
	content: string;
	toolCalls: ToolCall[];
	stopReason: string;
}

/**
 * 流式事件契约（对照 pi 的 AssistantMessageEvent 精简版）。
 * text_delta/toolcall_* 是增量；done 携带组装完成的完整消息。
 */
export type AssistantStreamEvent =
	| { type: "text_delta"; delta: string }
	| { type: "toolcall_start"; index: number; id: string; name: string }
	| { type: "toolcall_delta"; index: number; delta: string }
	| { type: "done"; stopReason: string; message: AssistantReply }
	| { type: "error"; error: unknown };

export type StreamFn = (
	messages: ChatMessage[],
	model: ModelDef,
	tools: ToolSchema[],
	signal?: AbortSignal,
) => AsyncIterable<AssistantStreamEvent>;

// —— 调用边界：内部统一格式 → OpenAI wire format ——
function toWire(messages: ChatMessage[]): unknown[] {
	return messages.map((m) => {
		if (m.role === "toolResult") {
			return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
		}
		if (m.role === "assistant" && m.toolCalls?.length) {
			return {
				role: "assistant",
				content: m.content || null,
				tool_calls: m.toolCalls.map((c) => ({
					id: c.id,
					type: "function",
					function: { name: c.name, arguments: c.arguments },
				})),
			};
		}
		return { role: m.role, content: m.content };
	});
}

// 端点知识封装在 provider 层：用户只配 base URL，带不带 /chat/completions 都能解析
function resolveEndpoint(base: string): string {
	const trimmed = base.replace(/\/+$/, "");
	return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

// —— 重试（对照 pi: provider-retry.ts）——
// 只重试"连接阶段"（拿到响应流之前）；流开始后的中断不重试，直接 error 事件。
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8000;

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}

/** 指数退避 + 抖动（对照 pi 的 0.5s×2^n cap 8s 带 25% 抖动） */
function backoffDelay(attempt: number, retryAfterMs?: number): number {
	if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, RETRY_CAP_MS);
	const base = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
	return Math.floor(base * (0.75 + Math.random() * 0.5)); // ±25% 抖动
}

async function fetchWithRetry(body: Record<string, unknown>, apiKey: string, signal?: AbortSignal): Promise<Response> {
	const endpoint = resolveEndpoint(process.env.LLM_BASE_URL ?? "https://api.deepseek.com");
	const maxRetries = Number(process.env.LLM_MAX_RETRIES ?? 3);
	for (let attempt = 0; ; attempt++) {
		let res: Response;
		try {
			res = await fetch(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify(body),
				signal,
			});
		} catch (err) {
			// 网络错误：未中止且还有额度则退避重试
			if (signal?.aborted || attempt >= maxRetries) throw err;
			await abortableSleep(backoffDelay(attempt), signal);
			continue;
		}
		if (res.ok) return res;
		const text = await res.text().catch(() => "");
		if (signal?.aborted || attempt >= maxRetries || !isRetryableStatus(res.status)) {
			throw new Error(`LLM HTTP ${res.status}: ${text}`);
		}
		const retryAfterSec = Number(res.headers.get("retry-after"));
		const retryAfterMs = Number(res.headers.get("retry-after-ms")) || (retryAfterSec > 0 ? retryAfterSec * 1000 : 0);
		await res.body?.cancel().catch(() => {});
		await abortableSleep(backoffDelay(attempt, retryAfterMs), signal);
	}
}

export const defaultStreamFn: StreamFn = async function* (messages, model, tools, signal) {
	const apiKey = resolveApiKey(model);
	if (!apiKey) {
		throw new Error(`未找到 ${model.provider} 的 API Key：请在 mini-pi/.env 中设置 ${model.apiKeyEnv}`);
	}

	const body: Record<string, unknown> = {
		model: model.apiModel,
		messages: toWire(messages),
		stream: true, // 阶段 3：从"全量等待"升级为流式
	};
	if (tools.length) {
		body.tools = tools.map((t) => ({
			type: "function",
			function: { name: t.name, description: t.description, parameters: t.parameters },
		}));
	}
	const maxTokens = process.env.LLM_MAX_TOKENS;
	if (maxTokens) body.max_tokens = Number(maxTokens);

	const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

	const res = await fetchWithRetry(body, apiKey, combined);

	// —— 流式组装：partial 可变消息（对照 pi 的 output 对象就地修改）——
	let content = "";
	const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
	let stopReason = "stop";

	try {
		for await (const data of iterateSseData(res, combined)) {
			let chunk: {
				choices?: Array<{
					delta?: {
						content?: string | null;
						tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
					};
					finish_reason?: string | null;
				}>;
			};
			try {
				chunk = JSON.parse(data);
			} catch {
				continue; // 单帧损坏跳过，不炸整个流
			}
			const choice = chunk.choices?.[0];
			if (!choice) continue;
			const delta = choice.delta ?? {};

			if (delta.content) {
				content += delta.content;
				yield { type: "text_delta", delta: delta.content };
			}
			for (const tc of delta.tool_calls ?? []) {
				const index = tc.index ?? 0;
				let entry = toolCalls.get(index);
				if (!entry) {
					// 该调用的首个 chunk：携带完整 id/name，arguments 从空串开始累加
					entry = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
					toolCalls.set(index, entry);
					yield { type: "toolcall_start", index, id: entry.id, name: entry.name };
				}
				if (tc.function?.arguments) {
					entry.arguments += tc.function.arguments;
					yield { type: "toolcall_delta", index, delta: tc.function.arguments };
				}
			}
			if (choice.finish_reason) stopReason = choice.finish_reason;
		}
	} catch (err) {
		// 区分两个取消源（审查修复）：用户中止 → partial 以 aborted 交付；
		// 超时（combined 但非用户中止）→ error 通道，绝不能把半截 toolCalls
		// 伪装成 aborted 交给循环层执行
		if (signal?.aborted) {
			const ordered = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
			yield { type: "done", stopReason: "aborted", message: { content, toolCalls: ordered, stopReason: "aborted" } };
			return;
		}
		yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
		return;
	}

	// 流正常结束：按 index 顺序还原 tool_calls
	const ordered = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
	yield { type: "done", stopReason, message: { content, toolCalls: ordered, stopReason } };
};
