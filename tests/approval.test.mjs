// L5-B 交互式审批回归：审批门语义（y/a/n/abort）/ 多层门控组合 / 归因透传 / 审计留痕
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { agentLoop } from "file:///home/xje/workplace/mini-pi/src/agent/agent-loop.ts";
import { composeGates, createApprovalGate, createEnforceGate } from "file:///home/xje/workplace/mini-pi/src/agent/tool-registry.ts";
import { AuditLogger, AuditStore } from "file:///home/xje/workplace/mini-pi/src/telemetry/audit.ts";

const require = createRequire("/home/xje/workplace/mini-pi/src/");
const { Type } = require("@sinclair/typebox");

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`${name}: ${ok ? "✅" : "❌"}${detail ? ` ${detail}` : ""}`);
	if (!ok) failures++;
};

const model = { provider: "t", modelId: "t", apiModel: "t", baseUrl: "http://x", apiKeyEnv: "X", label: "t", contextWindow: 128000 };
const mkTool = (name, execute = async () => "ok") => ({
	name,
	description: "t",
	parameters: Type.Object({}),
	label: "t",
	domain: "shell",
	execute,
});
const shellTool = mkTool("run_command");

// —— 1：模式命中才询问；非命中直接放行 ——
{
	let asked = 0;
	const gate = createApprovalGate({
		patterns: ["run_command"],
		requestApproval: async () => {
			asked++;
			return "yes";
		},
	});
	const miss = await gate({ tool: mkTool("read_file"), args: { path: "a" } });
	const hit = await gate({ tool: shellTool, args: { command: "ls" } });
	check("1 模式命中才询问", miss === undefined && asked === 1 && hit?.source === "user_temporary");
}

// —— 2：y=本次（user_temporary）/ n=拒绝（user_reject）/ abort=未作答（user_abort）——
{
	const answer = (value) => createApprovalGate({ patterns: ["run_command"], requestApproval: async () => value });
	const yes = await answer("yes")({ tool: shellTool, args: {} });
	const no = await answer("no")({ tool: shellTool, args: {} });
	const abort = await answer("abort")({ tool: shellTool, args: {} });
	check(
		"2 四种答案语义",
		yes?.block !== true && yes?.source === "user_temporary" && no?.block === true && no?.source === "user_reject" && abort?.block === true && abort?.source === "user_abort",
	);
}

// —— 3：a=本会话总是（记住后不再询问）——
{
	let asked = 0;
	const gate = createApprovalGate({
		patterns: ["run_command"],
		requestApproval: async () => {
			asked++;
			return "always";
		},
	});
	const first = await gate({ tool: shellTool, args: { command: "ls" } });
	const second = await gate({ tool: shellTool, args: { command: "pwd" } });
	check(
		"3 always：本会话记住",
		asked === 1 && first?.source === "user_permanent" && second?.source === "user_permanent" && second?.rule?.includes("本会话已批准"),
	);
}

// —— 4：多层门控组合（硬规则优先；审批的归因不被 compose 吞掉）——
{
	let asked = 0;
	const enforce = createEnforceGate([{ tool: "run_command", argsRegex: "\\brm\\b", reason: "禁止 rm" }]);
	const approval = createApprovalGate({
		patterns: ["run_command"],
		requestApproval: async () => {
			asked++;
			return "yes";
		},
	});
	const gate = composeGates([enforce, approval]);
	const blocked = await gate({ tool: shellTool, args: { command: "rm -rf x" } });
	const allowed = await gate({ tool: shellTool, args: { command: "ls" } });
	check(
		"4 compose：规则拦截优先 / 审批归因透传",
		blocked?.block === true && blocked.source === "rule" && asked === 1 && allowed?.source === "user_temporary",
	);
}

// —— 5：内核集成（审批放行 → allow 事件带 user_temporary；工具执行）——
{
	let asked = false;
	let call = 0;
	let executed = 0;
	const events = [];
	const gate = createApprovalGate({ patterns: ["run_command"], requestApproval: async () => "yes" });
	await agentLoop(
		{
			systemPrompt: "t",
			tools: [mkTool("run_command", async () => {
				executed++;
				return "ok";
			})],
			state: { model },
			streamFn: async function* () {
				call++;
				if (call === 1) {
					yield {
						type: "done",
						stopReason: "stop",
						message: {
							content: "",
							toolCalls: [{ id: "c1", name: "run_command", arguments: '{"command":"date"}' }],
							stopReason: "stop",
						},
					};
				} else {
					yield { type: "done", stopReason: "stop", message: { content: "完成", toolCalls: [], stopReason: "stop" } };
				}
			},
			getUserMessage: async () => {
				if (!asked) {
					asked = true;
					return "任务";
				}
				return null;
			},
			beforeToolCall: gate,
		},
		(e) => events.push(e),
	);
	const decision = events.find((e) => e.type === "tool_decision");
	check(
		"5 内核：allow 事件透传 user_temporary",
		executed === 1 && decision?.decision === "allow" && decision?.source === "user_temporary",
	);
}

// —— 6：审计（人工批准默认留痕；自动放行仍默认不记）——
{
	const dir = mkdtempSync(join(tmpdir(), "mini-pi-approval-"));
	const store = new AuditStore(dir, "sess");
	const logger = new AuditLogger(store, { sessionId: "sess", getTraceId: () => null });
	const event = (source) => ({
		type: "tool_decision",
		tool: "run_command",
		decision: "allow",
		source,
		argsChars: 4,
		argsPreview: "args",
	});
	logger.onEvent(event("user_temporary"));
	logger.onEvent(event("user_permanent"));
	logger.onEvent(event("default"));
	const records = store.readAll();
	check(
		"6 审计：人工批准留痕 / 自动放行默认不记",
		records.length === 2 && records[0].source === "user_temporary" && records[1].source === "user_permanent",
		`lines=${records.length}`,
	);
	rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
if (failures) process.exitCode = 1;
