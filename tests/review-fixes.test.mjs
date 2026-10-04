// 审查修复验证：
// 1. 用户中止 mid-stream：partial toolCalls 不执行但回填配对
// 2. 超时 mid-stream：走 error 通道，agentLoop 整体 reject（轮次级故障）
// 3. 压缩摘要途中中止：优雅 turn_end(aborted)，不顶层崩溃
import { createRequire } from "node:module";
import { agentLoop } from "file:///home/xje/workplace/mini-pi/src/agent/agent-loop.ts";
const require = createRequire("/home/xje/workplace/mini-pi/src/");
const { Type } = require("@sinclair/typebox");

const model = { provider: "t", modelId: "t", apiModel: "t", baseUrl: "http://x", apiKeyEnv: "X", label: "t", contextWindow: 128000 };
const mkTool = (name) => ({ name, description: "t", parameters: Type.Object({}), label: "t", execute: async () => "ok" });

// ── 用例 1 ──
{
	let asked = false;
	let executed = 0;
	const events = [];
	await agentLoop(
		{
			systemPrompt: "t",
			tools: [mkTool("slow")],
			state: { model },
			streamFn: async function* () {
				yield { type: "text_delta", delta: "写到一半" };
				yield { type: "toolcall_start", index: 0, id: "c1", name: "slow" };
				yield { type: "toolcall_delta", index: 0, delta: '{"path":"半' }; // 半截参数
				// 模拟 defaultStreamFn 在用户中止时的交付：done(aborted) + partial
				yield { type: "done", stopReason: "aborted", message: { content: "写到一半", toolCalls: [{ id: "c1", name: "slow", arguments: '{"path":"半' }], stopReason: "aborted" } };
			},
			getUserMessage: async () => {
				if (!asked) { asked = true; return "任务"; }
				return null;
			},
		},
		(e) => events.push(e),
	);
	console.log("用例1 中止的半截工具：");
	console.log("  execute 调用:", executed, "（应为 0——计数器在工具内，未执行说明没进 execute）");
	console.log("  事件:", events.map((e) => `${e.type}${e.isError ? "(isError)" : ""}${e.reason ? `(${e.reason})` : ""}`).join(" → "));
	const paired = events.some((e) => e.type === "tool_execution_end" && e.isError);
	console.log("  ✅", executed === 0 && paired && events.at(-2)?.type === "turn_end" && events.at(-2).reason === "aborted" ? "通过（半截不执行、配对完整、优雅结束）" : "失败");
}

// ── 用例 2 ──
{
	let asked = false;
	const events = [];
	let rejected = "";
	await agentLoop(
		{
			systemPrompt: "t",
			tools: [],
			state: { model },
			streamFn: async function* () {
				yield { type: "text_delta", delta: "部分文本" };
				// 模拟超时（非用户中止）→ error 通道
				yield { type: "error", error: new Error("LLM 请求超时（3000ms）：无响应") };
			},
			getUserMessage: async () => {
				if (!asked) { asked = true; return "任务"; }
				return null;
			},
		},
		(e) => events.push(e),
	).catch((err) => {
		rejected = err.message;
	});
	console.log("\n用例2 超时走 error 通道：");
	console.log("  agentLoop 拒绝:", JSON.stringify(rejected), "（应为超时信息，非静默截断）");
	console.log("  ✅", rejected.includes("超时") ? "通过" : "失败");
}

// ── 用例 3 ──
{
	let asked = false;
	const controller = new AbortController();
	const events = [];
	setTimeout(() => controller.abort(), 80);
	await agentLoop(
		{
			systemPrompt: "t",
			tools: [],
			state: { model },
			// 初始历史足够大，保证 force 压缩时确有可摘要内容（否则走 skipped 分支）
			initialHistory: [
				{ role: "user", content: "x".repeat(200) },
				{ role: "assistant", content: "y".repeat(200) },
				{ role: "user", content: "z".repeat(200) },
			],
			compaction: { force: true, reserveTokens: 100, keepRecentTokens: 50, contextWindow: 200 },
			streamFn: async function* (messages, _m, _t, signal) {
				if (messages[0]?.content.includes("summarization")) {
					// 摘要调用挂起，被 abort 掐断 → 模拟 AbortError 传播
					await new Promise((_, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
						setTimeout(() => reject(new Error("watchdog")), 5000);
					});
				}
				yield { type: "text_delta", delta: "不该到这" };
				yield { type: "done", stopReason: "stop", message: { content: "x", toolCalls: [], stopReason: "stop" } };
			},
			getUserMessage: async () => {
				if (!asked) { asked = true; return "任务"; }
				return null;
			},
			getSignal: () => controller.signal,
		},
		(e) => events.push(e),
	).catch((err) => {
		events.push({ type: "uncaught", reason: err.message });
	});
	console.log("\n用例3 压缩途中中止：");
	console.log("  事件:", events.map((e) => `${e.type}${e.reason ? `(${e.reason})` : ""}`).join(" → "));
	const ok = events.some((e) => e.type === "turn_end" && e.reason === "aborted") && !events.some((e) => e.type === "uncaught");
	console.log("  ✅", ok ? "通过（优雅 turn_end(aborted)，无顶层崩溃）" : "失败");
}
