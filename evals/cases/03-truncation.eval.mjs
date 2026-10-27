// eval 用例：输出截断保护（length 时本轮工具全部不执行，但逐个回填）
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineEval } from "../../src/eval/harness.ts";

export default defineEval({
	name: "03 截断保护",
	turns: [
		{
			toolCalls: [
				{ name: "write_file", arguments: { path: "a.txt", content: "A" } },
				{ name: "write_file", arguments: { path: "b.txt", content: "B" } },
			],
			stopReason: "length",
		},
		{ text: "重发完成" },
	],
	expect: {
		toolSequence: ["write_file", "write_file"],
		executedTools: 0, // 参数可能被静默截断：一个都不执行
		toolCalls: 2, // 但每个都回填（协议配对）
		llmCalls: 2,
		finalText: "重发完成",
		stopReason: "completed",
	},
	verify: ({ cwd }) => {
		if (existsSync(join(cwd, "a.txt")) || existsSync(join(cwd, "b.txt"))) {
			throw new Error("截断的工具调用不应产生文件");
		}
	},
});
