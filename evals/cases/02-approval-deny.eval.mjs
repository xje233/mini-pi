// eval 用例：审批拒绝后模型自愈（换工具完成）
import { createApprovalGate } from "../../src/agent/tool-registry.ts";
import { defineEval } from "../../src/eval/harness.ts";

export default defineEval({
	name: "02 审批拒绝后自愈",
	turns: [
		{ toolCalls: [{ name: "run_command", arguments: { command: "date" } }] },
		{ toolCalls: [{ name: "list_dir", arguments: { path: "." } }] },
		{ text: "已改用目录查询" },
	],
	beforeToolCall: createApprovalGate({
		patterns: ["run_command"],
		requestApproval: async () => "no",
	}),
	expect: {
		toolSequence: ["run_command", "list_dir"],
		deniedTools: ["run_command"],
		executedTools: 1, // 只有 list_dir 真正执行
		llmCalls: 3,
		toolCalls: 2,
		finalText: "已改用目录查询",
		stopReason: "completed",
	},
});
