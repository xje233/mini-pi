// eval 用例：审批 always 记忆（同工具本会话只询问一次）
import { createApprovalGate } from "../../src/agent/tool-registry.ts";
import { defineEval } from "../../src/eval/harness.ts";

let asked = 0;

export default defineEval({
	name: "06 审批 always 记忆",
	turns: [
		{ toolCalls: [{ name: "run_command", arguments: { command: "date" } }] },
		{ toolCalls: [{ name: "run_command", arguments: { command: "pwd" } }] },
		{ text: "完成" },
	],
	beforeToolCall: createApprovalGate({
		patterns: ["run_command"],
		requestApproval: async () => {
			asked++;
			return "always";
		},
	}),
	expect: {
		executedTools: 2,
		llmCalls: 3,
		stopReason: "completed",
	},
	verify: () => {
		if (asked !== 1) throw new Error(`always 后不应再次询问，实际询问 ${asked} 次`);
	},
});
