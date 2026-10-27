// eval 用例：上下文超阈值自动压缩（摘要调用不消耗脚本轮次）
import { defineEval } from "../../src/eval/harness.ts";

const LONG_INPUT = "上下文".repeat(300); // 900 字符 ≈ 225 token

export default defineEval({
	name: "04 自动压缩",
	input: LONG_INPUT,
	turns: [
		{ toolCalls: [{ name: "write_file", arguments: { path: "note.txt", content: "x" } }] },
		{ text: "完成" },
	],
	compaction: { contextWindow: 60, reserveTokens: 5, keepRecentTokens: 10 },
	expect: {
		compacted: true,
		llmCalls: 2, // 正常轮次；摘要调用不计入
		executedTools: 1,
		stopReason: "completed",
	},
});
