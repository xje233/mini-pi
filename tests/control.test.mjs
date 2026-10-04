// 控制面回归：截断保护 / steering / abort / maxTurns
import { createRequire } from "node:module";
import { agentLoop } from "file:///home/xje/workplace/mini-pi/src/agent/agent-loop.ts";
const require = createRequire("/home/xje/workplace/mini-pi/src/");
const { Type } = require("@sinclair/typebox");

const model = { provider: "t", modelId: "t", apiModel: "t", baseUrl: "http://x", apiKeyEnv: "X", label: "t", contextWindow: 128000 };
const mkTool = (name, execute) => ({ name, description: "t", parameters: Type.Object({}), label: "t", execute });

// 1：截断保护（stopReason=length → 全部不执行但回填；次轮模型重发正常）
{
	let asked = false;
	let call = 0;
	let executed = 0;
	const events = [];
	await agentLoop(
		{
			systemPrompt: "t",
			tools: [mkTool("w", async () => { executed++; return "ok"; })],
			state: { model },
			streamFn: async function* () {
				call++;
				if (call === 1) {
					yield { type: "done", stopReason: "length", message: { content: "", toolCalls: [
						{ id: "c1", name: "w", arguments: '{"path":"a","co' },
						{ id: "c2", name: "w", arguments: '{"path":"b","co' },
					], stopReason: "length" } };
				} else {
					yield { type: "done", stopReason: "stop", message: { content: "重发完成", toolCalls: [], stopReason: "stop" } };
				}
			},
			getUserMessage: async () => { if (!asked) { asked = true; return "任务"; } return null; },
		},
		(e) => events.push(e),
	);
	const ok = executed === 0
		&& events.filter((e) => e.type === "tool_execution_end" && e.isError).length === 2
		&& events.at(-1)?.type === "agent_end"
		&& events.some((e) => e.type === "message_end" && e.content === "重发完成");
	console.log(`1 截断保护: ${ok ? "✅" : "❌"} executed=${executed}`);
}

// 2：steering（回合边界注入，one-at-a-time）
{
	let turn = 0;
	let polls = 0;
	let asked = false;
	const userMsgsPerRequest = [];
	const events = [];
	await agentLoop(
		{
			systemPrompt: "t",
			tools: [mkTool("noop", async () => "ok")],
			state: { model },
			streamFn: async function* (messages) {
				turn++;
				userMsgsPerRequest.push(messages.filter((m) => m.role === "user").map((m) => m.content));
				if (turn === 1) yield { type: "done", stopReason: "stop", message: { content: "", toolCalls: [{ id: "c1", name: "noop", arguments: "{}" }], stopReason: "stop" } };
				else yield { type: "done", stopReason: "stop", message: { content: "总结", toolCalls: [], stopReason: "stop" } };
			},
			getUserMessage: async () => { if (!asked) { asked = true; return "执行任务"; } return null; },
			getSteeringMessages: async () => { polls++; return polls === 1 ? [{ role: "user", content: "转向" }] : []; },
		},
		(e) => events.push(e),
	);
	const ok = polls === 2 && JSON.stringify(userMsgsPerRequest[1]) === JSON.stringify(["执行任务", "转向"]) && events.some((e) => e.type === "steering_applied");
	console.log(`2 steering: ${ok ? "✅" : "❌"} 请求2=${JSON.stringify(userMsgsPerRequest[1])}`);
}

// 3：工具执行中 abort（信号挂在 execute 上）+ 会话存活
{
	const controller = new AbortController();
	let asked = false;
	let executed = 0;
	const events = [];
	setTimeout(() => controller.abort(), 120);
	await agentLoop(
		{
			systemPrompt: "t",
			tools: [mkTool("slow", (_a, signal) => new Promise((_r, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
				setTimeout(() => reject(new Error("watchdog")), 4000);
			}))],
			state: { model },
			streamFn: async function* () {
				yield { type: "done", stopReason: "stop", message: { content: "", toolCalls: [{ id: "c1", name: "slow", arguments: "{}" }], stopReason: "stop" } };
			},
			getUserMessage: async () => { if (!asked) { asked = true; return "任务"; } return null; },
			getSignal: () => controller.signal,
		},
		(e) => events.push(e),
	);
	const abortedTurn = events.some((e) => e.type === "turn_end" && e.reason === "aborted");
	console.log(`3 工具中 abort: ${abortedTurn && events.at(-1)?.type === "agent_end" ? "✅" : "❌"} executed=${executed}`);
}

// 4：maxTurns 强制收尾
{
	let asked = false;
	let executed = 0;
	let turns = 0;
	const events = [];
	await agentLoop(
		{
			systemPrompt: "t",
			tools: [mkTool("noop", async () => { executed++; return "ok"; })],
			state: { model },
			streamFn: async function* () {
				turns++;
				yield { type: "done", stopReason: "stop", message: { content: "", toolCalls: [{ id: `c${turns}`, name: "noop", arguments: "{}" }], stopReason: "stop" } };
			},
			getUserMessage: async () => { if (!asked) { asked = true; return "失控"; } return null; },
			maxTurns: 3,
		},
		(e) => events.push(e),
	);
	const ok = turns === 4 && executed === 3 && events.some((e) => e.type === "turn_end" && e.reason === "max_turns");
	console.log(`4 maxTurns: ${ok ? "✅" : "❌"} turns=${turns} executed=${executed}`);
}
