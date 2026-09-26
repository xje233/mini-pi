// 模型注册表（对照 pi: packages/ai/src/providers/*.ts + models.ts 的 getModel(provider, id)）
export interface ModelDef {
	/** 二级寻址：provider/modelId（对照 pi 的 getModel(provider, id) 二级查找） */
	provider: string;
	modelId: string;
	/** 传给 API 的 model 参数 */
	apiModel: string;
	/** API 根地址，路径由 provider 层自动拼接 */
	baseUrl: string;
	/** 从哪个环境变量读 API Key（对照 pi 的 env-api-keys.ts 映射表） */
	apiKeyEnv: string;
	/** 展示用 */
	label: string;
}

export const MODELS: ModelDef[] = [
	{
		provider: "deepseek",
		modelId: "deepseek-chat",
		apiModel: "deepseek-chat",
		baseUrl: "https://api.deepseek.com",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		label: "DeepSeek Chat",
	},
	{
		provider: "deepseek",
		modelId: "deepseek-reasoner",
		apiModel: "deepseek-reasoner",
		baseUrl: "https://api.deepseek.com",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		label: "DeepSeek Reasoner",
	},
	{
		provider: "glm",
		modelId: "glm-4.6",
		apiModel: "glm-4.6",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		apiKeyEnv: "GLM_API_KEY",
		label: "GLM-4.6",
	},
	{
		provider: "kimi",
		modelId: "kimi-k2",
		apiModel: "kimi-k2-0905-preview",
		baseUrl: "https://api.moonshot.cn/v1",
		apiKeyEnv: "MOONSHOT_API_KEY",
		label: "Kimi K2",
	},
];

export function listModels(): string {
	return MODELS.map((m) => `  ${m.provider}/${m.modelId}  (${m.label})`).join("\n");
}

/**
 * 解析 "provider/model" 或裸 "modelId"（对照 pi 的 model-resolver.ts：先全串、
 * 再按第一个 / 拆开匹配、最后裸 id 匹配，歧义时拒绝）。
 */
export function resolveModel(pattern: string): ModelDef | undefined {
	const p = pattern.trim();
	const exact = MODELS.find((m) => `${m.provider}/${m.modelId}` === p);
	if (exact) return exact;
	if (p.includes("/")) {
		const [provider, modelId] = p.split("/", 2);
		return MODELS.find((m) => m.provider === provider && m.modelId === modelId);
	}
	const matches = MODELS.filter((m) => m.modelId === p);
	return matches.length === 1 ? matches[0] : undefined;
}

/** 取 provider 对应的 API Key；deepseek 兼容旧的 LLM_API_KEY */
export function resolveApiKey(model: ModelDef): string | undefined {
	const key = process.env[model.apiKeyEnv];
	if (key) return key;
	if (model.provider === "deepseek") return process.env.LLM_API_KEY;
	return undefined;
}
