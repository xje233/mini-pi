// 工具路由第一步回归：registry / 暴露过滤 / 执行门控 / 循环集成
import { createRequire } from "node:module";
import { agentLoop } from "file:///home/xje/workplace/mini-pi/src/agent/agent-loop.ts";
import { ToolRegistry, matchToolPattern, filterVisibleTools, createEnforceGate } from "file:///home/xje/workplace/mini-pi/src/agent/tool-registry.ts";
const require = createRequire("/home/xje/workplace/mini-pi/src/");
const { Type } = require("@sinclair/typebox");

const mk = (name, domain) => ({ name, domain, description: "t", label: name, parameters: Type.Object({}) });

// 1：registry（first-registration-wins）
{
	const reg = new ToolRegistry();
	reg.register(mk("read_file", "fs"));
	reg.register(mk("read_file", "net")); // 重名被忽略
	reg.register(mk("run_command", "shell"));
	const ok = reg.all().length === 2 && reg.get("read_file")?.domain === "fs";
	console.log(`1 registry: ${ok ? "✅" : "❌"} count=${reg.all().length}`);
}

// 2：模式匹配
{
	const t = { name: "run_command", domain: "shell" };
	const ok =
		matchToolPattern("run_command", t) &&
		matchToolPattern("shell:*", t) &&
		matchToolPattern("run_*", t) &&
		matchToolPattern("*", t) &&
		!matchToolPattern("fs:*", t) &&
		!matchToolPattern("read_*", t);
	console.log(`2 模式匹配: ${ok ? "✅" : "❌"}`);
}

// 3：暴露过滤
{
	const tools = [mk("read_file", "fs"), mk("write_file", "fs"), mk("run_command", "shell")];
	const visible = filterVisibleTools(tools, ["run_command"]);
	const visible2 = filterVisibleTools(tools, ["fs:*"]);
	const ok = visible.length === 2 && !visible.some((t) => t.name === "run_command") && visible2.length === 1 && visible2[0].name === "run_command";
	console.log(`3 暴露过滤: ${ok ? "✅" : "❌"} deny精确=${visible.length} deny=fs:*后仅剩shell`);
}

// 4：执行门控（参数级）
{
	const tool = mk("run_command", "shell");
	const gate = createEnforceGate([
		{ tool: "run_command", argsRegex: "\\brm\\b", reason: "禁止 rm" },
		{ tool: "shell:*", argsRegex: "curl" },
	]);
	const rmHit = await gate({ tool, args: { command: "rm -rf /tmp/x" } });
	const lsPass = await gate({ tool, args: { command: "ls" } });
	const curlHit = await gate({ tool, args: { command: "curl http://x" } });
	const ok = rmHit?.block === true && rmHit.reason === "禁止 rm" && !lsPass && curlHit?.block === true;
	console.log(`4 执行门控: ${ok ? "✅" : "❌"} rm拦截/ls放行/curl(领域规则)拦截`);
}

// 5：循环集成——被门控的工具：不执行、isError 回填、模型收到拒绝原因
{
	let asked = false;
	let executed = 0;
	const events = [];
	let turn = 0;
	await agentLoop(
		{
			systemPrompt: "t",
			tools: [{ ...mk("run_command", "shell"), execute: async () => { executed++; return "ok"; } }],
			state: { model: { provider: "t", modelId: "t", apiModel: "t", baseUrl: "http://x", apiKeyEnv: "X", label: "t", contextWindow: 128000 } },
			beforeToolCall: createEnforceGate([{ tool: "run_command", argsRegex: "\\brm\\b", reason: "禁止 rm" }]),
			streamFn: async function* () {
				turn++;
				if (turn === 1) {
					yield { type: "done", stopReason: "stop", message: { content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: '{"command":"rm -rf /tmp/x"}' }], stopReason: "stop" } };
				} else {
					yield { type: "done", stopReason: "stop", message: { content: "被拒了", toolCalls: [], stopReason: "stop" } };
				}
			},
			getUserMessage: async () => { if (!asked) { asked = true; return "删文件"; } return null; },
		},
		(e) => events.push(e),
	);
	const blocked = events.some((e) => e.type === "tool_execution_end" && e.isError);
	const ok = executed === 0 && blocked && events.at(-1)?.type === "agent_end";
	console.log(`5 循环集成: ${ok ? "✅" : "❌"} executed=${executed} blocked=${blocked}`);
}
