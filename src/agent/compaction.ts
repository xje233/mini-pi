// 上下文压缩（对照 pi: packages/agent/src/harness/compaction/compaction.ts）。
// 核心原则：投影变、底账不变——压缩替换的是"发给 LLM 的历史"，
// 会话文件里的原始消息永远完整保留（持久化在 session 层）。
import type { ChatMessage, StreamFn } from "../ai/index.js";
import type { ModelDef } from "../ai/models.js";

export interface CompactionOptions {
	/** 触发线预留空间（也是摘要生成的输出预算参考） */
	reserveTokens: number;
	/** 无论如何都保留的近期消息 token */
	keepRecentTokens: number;
	/** 手动触发（/compact），下一次请求前强制压缩 */
	force?: boolean;
	/** 覆盖模型元数据的上下文窗口（测试用） */
	contextWindow?: number;
}

// 对照 pi 的 DEFAULT_COMPACTION_SETTINGS（compaction.ts:157-161）
export const DEFAULT_COMPACTION: CompactionOptions = {
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
};

// —— token 估算（对照 pi: packages/ai/src/utils/estimate.ts，CHARS_PER_TOKEN=4）——
export function estimateTokens(messages: ChatMessage[]): number {
	let chars = 0;
	for (const m of messages) {
		chars += m.content.length;
		if (m.toolCalls) {
			for (const c of m.toolCalls) chars += c.name.length + c.arguments.length;
		}
	}
	return Math.ceil(chars / 4);
}

// 触发判定（对照 pi 的 shouldCompact，compaction.ts:246-249）
export function shouldCompact(tokens: number, contextWindow: number, opts: CompactionOptions): boolean {
	return tokens > contextWindow - opts.reserveTokens;
}

/**
 * 切点：从尾部累加 token 到 keepRecentTokens，再前移到"合法切点"。
 * 合法切点只能是 user/assistant 消息——toolResult 永远不是切点，
 * 保证 assistant(toolCall) → toolResult 配对不被切开（对照 pi 的 findValidCutPoints）。
 */
export function findCutIndex(messages: ChatMessage[], keepRecentTokens: number): number {
	let tokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		tokens += estimateTokens([m]);
		if (tokens >= keepRecentTokens) {
			let cut = i;
			while (cut < messages.length) {
				const role = messages[cut]!.role;
				if (role === "user" || role === "assistant") return cut;
				cut++;
			}
			return messages.length; // 无合法切点（理论不可达）：整段保留，不压缩
		}
	}
	return 0;
}

// —— 摘要 prompt（对照 pi compaction.ts:420-455，逐字）——
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function serializeMessage(m: ChatMessage): string {
	if (m.role === "toolResult") return `[tool ${m.toolName ?? ""} 结果] ${m.content}`;
	if (m.toolCalls?.length) {
		return `[assistant 请求工具] ${m.toolCalls.map((c) => `${c.name}(${c.arguments})`).join("; ")}${m.content ? `\n[assistant] ${m.content}` : ""}`;
	}
	return `[${m.role}] ${m.content}`;
}

export interface CompactionResult {
	/** 摘要文本（空串 = 没有可压缩内容，放弃本次压缩） */
	summary: string;
	/** 保留区起始下标（history.slice(keptFrom) 为保留消息） */
	keptFrom: number;
}

/**
 * 生成摘要（对照 pi 的 generateSummaryWithRequest：独立的一次性 LLM 调用，
 * 同模型、只有 system + 单条 user、无 tools）。
 */
export async function compactHistory(
	history: ChatMessage[],
	streamFn: StreamFn,
	model: ModelDef,
	opts: CompactionOptions,
	signal?: AbortSignal,
): Promise<CompactionResult> {
	const cut = findCutIndex(history, opts.keepRecentTokens);
	const toSummarize = history.slice(0, cut);
	if (!toSummarize.length) return { summary: "", keptFrom: 0 };

	const conversation = toSummarize.map(serializeMessage).join("\n");
	let summary = "";
	for await (const event of streamFn(
		[
			{ role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
			{ role: "user", content: `<conversation>\n${conversation}\n</conversation>\n\n${SUMMARIZATION_PROMPT}` },
		],
		model,
		[],
		signal,
	)) {
		if (event.type === "text_delta") summary += event.delta;
	}
	return { summary: summary.trim(), keptFrom: cut };
}

/** 摘要投影成 user 消息（对照 pi 的 convertToLlm，messages.ts:176-183，文本逐字） */
export function summaryMessage(summary: string): ChatMessage {
	return {
		role: "user",
		content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
	};
}
