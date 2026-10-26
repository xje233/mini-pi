// L5-B 护栏审计回归：决策事件（规则/钩子/放行）/ 归因 / 落盘 / 内容门控 / trace 接入
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { agentLoop } from "file:///home/xje/workplace/mini-pi/src/agent/agent-loop.ts";
import { createEnforceGate } from "file:///home/xje/workplace/mini-pi/src/agent/tool-registry.ts";
import { TraceCollector } from "file:///home/xje/workplace/mini-pi/src/telemetry/collector.ts";
import { AuditLogger, AuditStore, formatDecision } from "file:///home/xje/workplace/mini-pi/src/telemetry/audit.ts";

const require = createRequire("/home/xje/workplace/mini-pi/src/");
const { Type } = require("@sinclair/typebox");

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`${name}: ${ok ? "✅" : "❌"}${detail ? ` ${detail}` : ""}`);
	if (!ok) failures++;
};

const model = { provider: "t", modelId: "t", apiModel: "t", baseUrl: "http://x", apiKeyEnv: "X", label: "t", contextWindow: 128000 };
const mkTool = (name, execute) => ({ name, description: "t", parameters: Type.Object({}), label: "t", execute });

/** 跑一次任务：第一次 LLM 要求调用 run_command，第二次收尾 */
async function runTask(beforeToolCall, execute) {
	let asked = false;
	let call = 0;
	const events = [];
	await agentLoop(
		{
			systemPrompt: "t",
			tools: [mkTool("run_command", execute)],
			state: { model },
			streamFn: async function* () {
				call++;
				if (call === 1) {
					yield {
						type: "done",
						stopReason: "stop",
						message: {
							content: "",
							toolCalls: [{ id: "c1", name: "run_command", arguments: '{"command":"rm -rf x"}' }],
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
			beforeToolCall,
		},
		(e) => events.push(e),
	);
	return events;
}

// —— 1：规则拦截（deny 事件带 source/rule；工具不执行；结果仍回填）——
{
	let executed = 0;
	const events = await runTask(
		async () => ({ block: true, source: "rule", rule: "run_command ~ /\\brm\\b/", reason: "禁止 rm" }),
		async () => {
			executed++;
			return "ok";
		},
	);
	const decision = events.find((e) => e.type === "tool_decision");
	check(
		"1 规则拦截：deny/rule/未执行/结果回填",
		executed === 0 &&
			decision?.decision === "deny" &&
			decision?.source === "rule" &&
			decision?.rule.includes("run_command") &&
			events.some((e) => e.type === "tool_execution_end" && e.isError),
	);
}

// —— 2：钩子抛错 = fail-safe 阻断（与"工具自己失败"区分归因）——
{
	let executed = 0;
	const events = await runTask(
		async () => {
			throw new Error("policy backend down");
		},
		async () => {
			executed++;
			return "ok";
		},
	);
	const decision = events.find((e) => e.type === "tool_decision");
	check(
		"2 钩子异常：source=hook / fail-safe 阻断",
		executed === 0 && decision?.decision === "deny" && decision?.source === "hook" && decision?.reason.includes("fail-safe"),
	);
}

// —— 3：放行（allow 事件照发：内核陈述事实，落盘粒度由消费方决定）——
{
	let executed = 0;
	const events = await runTask(async () => undefined, async () => {
		executed++;
		return "ok";
	});
	const decision = events.find((e) => e.type === "tool_decision");
	check("3 放行：allow/default/执行一次", executed === 1 && decision?.decision === "allow" && decision?.source === "default");
}

// —— 4：enforce gate 的审计归因（rule 描述 + source）——
{
	const gate = createEnforceGate([{ tool: "run_command", argsRegex: "\\brm\\b", reason: "禁止 rm" }]);
	const tool = mkTool("run_command", async () => "");
	const hit = await gate({ tool, args: { command: "rm -rf x" } });
	const miss = await gate({ tool, args: { command: "ls" } });
	check(
		"4 gate 归因：source=rule + 规则描述 / 未命中放行",
		hit?.block === true && hit.source === "rule" && hit.rule.includes("run_command") && hit.rule.includes("rm") && miss === undefined,
		`rule=${hit?.rule}`,
	);
}

// —— 5：trace 接入（tool span 属性 + turn event）——
{
	let clock = 0;
	const collector = new TraceCollector({ sessionId: "t", now: () => clock });
	const feed = (advance, event) => {
		clock += advance;
		collector.onEvent(event);
	};
	feed(10, { type: "turn_start", input: "任务" });
	feed(10, { type: "tool_execution_start", tool: "run_command", argsPreview: '{"command":"rm"}' });
	feed(1, {
		type: "tool_decision",
		tool: "run_command",
		decision: "deny",
		source: "rule",
		rule: "run_command ~ /\\brm\\b/",
		reason: "禁止 rm",
		argsChars: 19,
		argsPreview: '{"command":"rm"}',
	});
	feed(1, { type: "tool_execution_end", tool: "run_command", isError: true });
	feed(10, { type: "turn_end", reason: "completed" });
	const spans = [...collector.spansSnapshot()];
	const tool = spans.find((s) => s.name === "execute_tool");
	const turn = spans.find((s) => s.name === "turn");
	check(
		"5 trace 接入：span 属性 + turn event",
		tool.attributes.decision === "deny" &&
			tool.attributes.decision_source === "rule" &&
			String(tool.attributes.rule).includes("run_command") &&
			turn.events.some((e) => e.name === "tool_decision"),
	);
}

// —— 6：AuditStore roundtrip + 坏行容错 ——
{
	const dir = mkdtempSync(join(tmpdir(), "mini-pi-audit-"));
	const store = new AuditStore(dir, "sess");
	const base = { sessionId: "sess", timestamp: 1, traceId: "t1", tool: "run_command", decision: "deny", source: "rule" };
	store.append({ ...base, rule: "r", reason: "x", argsChars: 5 });
	appendFileSync(store.file, "{ 坏行\n", "utf8");
	const records = store.readAll();
	check("6 store roundtrip + 坏行跳过", records.length === 1 && records[0].tool === "run_command", `lines=${records.length}`);
	rmSync(dir, { recursive: true, force: true });
}

// —— 7：AuditLogger（deny 全量、allow 按开关、内容门控）——
{
	const dir = mkdtempSync(join(tmpdir(), "mini-pi-audit-"));
	const store = new AuditStore(dir, "sess");
	let traceId = "t1";
	const logger = new AuditLogger(store, { sessionId: "sess", content: false, getTraceId: () => traceId });
	const decisionEvent = (tool, decision, source) => ({
		type: "tool_decision",
		tool,
		decision,
		source,
		argsChars: 7,
		argsPreview: "args-json",
	});
	logger.onEvent(decisionEvent("a", "deny", "rule"));
	logger.onEvent(decisionEvent("b", "allow", "default"));
	const records = store.readAll();
	check(
		"7a deny 记 / allow 默认不记 / 默认只记长度",
		records.length === 1 && records[0].tool === "a" && records[0].traceId === "t1" && records[0].argsChars === 7 && records[0].argsPreview === undefined,
	);
	const allowLogger = new AuditLogger(store, {
		sessionId: "sess",
		content: true,
		recordAllow: true,
		getTraceId: () => traceId,
	});
	allowLogger.onEvent(decisionEvent("b", "allow", "default"));
	const all = store.readAll();
	check(
		"7b AUDIT_ALLOW 全量 / content 记录正文",
		all.length === 2 && all[1].decision === "allow" && all[1].argsPreview === "args-json",
	);
	rmSync(dir, { recursive: true, force: true });
}

// —— 8：/audit 单行格式化 ——
{
	const line = formatDecision({
		sessionId: "s",
		timestamp: Date.now(),
		traceId: "t1",
		tool: "run_command",
		decision: "deny",
		source: "rule",
		rule: "run_command ~ /\\brm\\b/",
		argsChars: 15,
	});
	check(
		"8 格式化输出",
		line.includes("DENY") && line.includes("run_command") && line.includes("[rule]") && line.includes("[t1]") && line.includes("args=15字"),
		line,
	);
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
if (failures) process.exitCode = 1;
