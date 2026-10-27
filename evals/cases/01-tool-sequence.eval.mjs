// eval 用例：工具调用序列 + 真实文件状态（写→读→总结）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineEval } from "../../src/eval/harness.ts";

export default defineEval({
	name: "01 工具序列（写→读）",
	turns: [
		{ toolCalls: [{ name: "write_file", arguments: { path: "hello.txt", content: "hi" } }] },
		{ toolCalls: [{ name: "read_file", arguments: { path: "hello.txt" } }] },
		{ text: "完成" },
	],
	expect: {
		toolSequence: ["write_file", "read_file"],
		executedTools: 2,
		llmCalls: 3,
		toolCalls: 2,
		finalText: "完成",
		stopReason: "completed",
		spans: 6, // turn + chat×3 + execute_tool×2
	},
	verify: ({ cwd }) => {
		const content = readFileSync(join(cwd, "hello.txt"), "utf8");
		if (content !== "hi") throw new Error(`文件内容不符: ${JSON.stringify(content)}`);
	},
});
