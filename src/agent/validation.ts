// 工具参数校验（对照 pi: packages/ai/src/utils/validation.ts 的 validateToolArguments）
// 三步：① 可选参数 null 归一化 ② 类型强转（宽容层）③ 严格校验（严格层）。
// 校验失败返回格式化的友好错误——这段文本会作为 isError 结果回填给 LLM，
// 它是写给模型看的提示词：错在哪、收到了什么、该怎么改。
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import type { AgentTool } from "./tools.js";

export type ValidationOutcome =
	| { ok: true; args: Record<string, unknown> }
	| { ok: false; message: string };

/** 可选属性收到 null → 视为未传（模型对 optional 参数的常见输出） */
function normalizeOptionalNulls(args: unknown, schema: Record<string, unknown>): void {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return;
	const props = schema.properties as Record<string, TSchema> | undefined;
	if (!props) return;
	const required = (schema.required as string[] | undefined) ?? [];
	const record = args as Record<string, unknown>;
	for (const key of Object.keys(props)) {
		if (!required.includes(key) && record[key] === null) {
			delete record[key];
		}
	}
}

export function validateToolArguments(tool: AgentTool, args: unknown): ValidationOutcome {
	const schema = tool.parameters as Record<string, unknown>;

	// 克隆后操作：校验/强转不得污染原始 toolCall（对照 pi 的 structuredClone）
	const normalized = structuredClone(args);
	normalizeOptionalNulls(normalized, schema);

	// 宽容层：类型强转。"123" → 123、"true" → true 等（对照 pi 的 Value.Convert + coerceWithJsonSchema）
	try {
		Value.Convert(schema as never, normalized as never);
	} catch {
		// Convert 对极端输入可能抛错，交给下面的 Check 给出准确报错
	}

	// 严格层：typebox schema 校验（schema 本身非法时给出工具定义错误，而非神秘堆栈）
	try {
		if (Value.Check(schema as never, normalized as never)) {
			return { ok: true, args: normalized as Record<string, unknown> };
		}
	} catch (err) {
		return {
			ok: false,
			message: `Tool "${tool.name}" 参数 schema 非法（parameters 必须是 typebox schema）: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}

	// 友好错误：逐条列出错误路径 + 原因 + 模型实际发了什么 + 下一步指令
	const errors = [...Value.Errors(schema as never, normalized as never)]
		.map((e) => `  - ${e.path || "/"}: ${e.message}`)
		.join("\n");
	return {
		ok: false,
		message:
			`Validation failed for tool "${tool.name}":\n${errors}\n\n` +
			`Received arguments: ${JSON.stringify(args)}\n\n` +
			`请根据工具的参数 schema 修正参数后重新调用。`,
	};
}
