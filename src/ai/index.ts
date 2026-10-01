// 最薄的 LLM 层：OpenAI 兼容 /chat/completions，非流式。
// 内部消息格式 provider 中立；出网前在"调用边界"转成 wire format
// （对照 pi："Transforms to Message[] only at the LLM call boundary"）。
// 阶段 3 会对照 packages/ai 重写为流式 + 统一错误契约。
import type { ModelDef } from "./models.js";
import { resolveApiKey } from "./models.js";

export type ChatRole = "system" | "user" | "assistant" | "toolResult";

/** 模型发起的工具调用（assistant 消息携带；arguments 保持 wire 的 JSON 字符串，执行边界才 parse） */
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
	/** assistant：模型要求的工具调用 */
	toolCalls?: ToolCall[];
	/** toolResult：对应哪次调用 */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

/** 出网用的工具描述。ai 包只认识 wire 层的 schema，不认识带 execute 的 AgentTool */
export interface ToolSchema {
	name: string;
	description: string;
	parameters: Record<string, unknown>; // JSON Schema
}

/** 模型的一次回复：文本 +（可能为空的）工具调用列表 + 停止原因 */
export interface AssistantReply {
	content: string;
	toolCalls: ToolCall[];
	/**
	 * 停止原因（OpenAI 兼容的 finish_reason 原值透传）。
	 * "length" = 输出 token 上限截断——此时 tool_calls 参数可能不完整，
	 * 循环层必须据此拒绝执行（对照 pi：Anthropic 的 "max_tokens" 在阶段 3 统一映射）。
	 */
	stopReason: string;
}

export type StreamFn = (
	messages: ChatMessage[],
	model: ModelDef,
	tools: ToolSchema[],
	/** 取消信号：用户 abort 时取消进行中的 HTTP 请求（对齐 pi 的 signal 贯穿） */
	signal?: AbortSignal,
) => Promise<AssistantReply>;

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

export const defaultStreamFn: StreamFn = async (messages, model, tools, signal) => {
	const apiKey = resolveApiKey(model);
	if (!apiKey) {
		throw new Error(
			`未找到 ${model.provider} 的 API Key：请在 mini-pi/.env 中设置 ${model.apiKeyEnv}`,
		);
	}

	const body: Record<string, unknown> = {
		model: model.apiModel,
		messages: toWire(messages),
	};
	if (tools.length) {
		body.tools = tools.map((t) => ({
			type: "function",
			function: { name: t.name, description: t.description, parameters: t.parameters },
		}));
	}
	// 输出上限（请求侧控制）：不设则用 provider 默认。配合循环层的截断保护使用
	const maxTokens = process.env.LLM_MAX_TOKENS;
	if (maxTokens) body.max_tokens = Number(maxTokens);

	// 请求超时：LLM 长响应可能很慢，但连接级挂死必须有上限（LLM_TIMEOUT_MS 可覆盖）
	const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
	// 合并两个取消源：超时 + 用户 abort（AbortSignal.any 任一触发即取消）
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
	const res = await fetch(resolveEndpoint(model.baseUrl), {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
		body: JSON.stringify(body),
		signal: combinedSignal,
	}).catch((err: unknown) => {
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new Error(`LLM 请求超时（${timeoutMs}ms）：${model.provider} 无响应，可稍后重试或调大 LLM_TIMEOUT_MS`);
		}
		throw err;
	});
	if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);

	const data = (await res.json()) as {
		choices?: Array<{
			message?: {
				content?: string | null;
				tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
			};
			finish_reason?: string;
		}>;
	};
	const choice = data.choices?.[0];
	const msg = choice?.message;
	if (!msg) throw new Error("LLM 响应缺少 choices[0].message");

	return {
		content: msg.content ?? "",
		toolCalls: (msg.tool_calls ?? []).map((c) => ({
			id: c.id,
			name: c.function?.name ?? "",
			arguments: c.function?.arguments ?? "{}",
		})),
		stopReason: choice.finish_reason ?? "stop",
	};
};
