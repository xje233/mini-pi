// eval 用例：迭代上限（超限后拒绝执行工具并强制收尾）
import { defineEval } from "../../src/eval/harness.ts";

export default defineEval({
	name: "05 maxTurns 强制收尾",
	maxTurns: 2,
	turns: [
		{ toolCalls: [{ name: "list_dir", arguments: { path: "." } }] },
		{ toolCalls: [{ name: "list_dir", arguments: { path: "." } }] },
		{ toolCalls: [{ name: "list_dir", arguments: { path: "." } }] },
	],
	expect: {
		stopReason: "max_turns",
		llmCalls: 3, // 2 轮正常 + 1 轮强制收尾
		executedTools: 2,
		toolCalls: 3, // 第 3 个调用不执行但回填
	},
});
