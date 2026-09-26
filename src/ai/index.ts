// 最薄的 LLM 层：OpenAI 兼容 /chat/completions，非流式。
// 阶段 3 会对照 packages/ai 重写为流式 + 统一错误契约。
import type { ModelDef } from "./models.js";
import { resolveApiKey } from "./models.js";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
	role: ChatRole;
	content: string;
	// 对照 pi：AssistantMessage 自带 provider/model（types.ts:542），
	// 同一会话混用多家模型时可追溯每条回复是谁生成的
	model?: string;
}

// 对照 pi: packages/agent/src/types.ts 的 StreamFn——
// 循环只依赖这个函数类型，不关心背后是哪家 provider。
// 第二个参数 model 是唯一的状态：切换模型 = 传不同的 ModelDef 进来。
export type StreamFn = (messages: ChatMessage[], model: ModelDef) => Promise<string>;

// 端点知识封装在 provider 层（对照 pi：packages/ai 的各 api 适配器自己拼完整 URL），
// 用户只配 base URL，带不带 /chat/completions 都能正确解析。
function resolveEndpoint(base: string): string {
	const trimmed = base.replace(/\/+$/, "");
	return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

export const defaultStreamFn: StreamFn = async (messages, model) => {
	const apiKey = resolveApiKey(model);
	if (!apiKey) {
		throw new Error(
			`未找到 ${model.provider} 的 API Key：请在 mini-pi/.env 中设置 ${model.apiKeyEnv}`,
		);
	}
	const res = await fetch(resolveEndpoint(model.baseUrl), {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ model: model.apiModel, messages }),
	});
	if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	const content = data.choices?.[0]?.message?.content;
	if (content === undefined) throw new Error("LLM 响应缺少 choices[0].message.content");
	return content;
};
