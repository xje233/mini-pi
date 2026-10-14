// L5 观测（Trace）回归：事件流重建 span / 树投影 / 落盘容错 / 内容门控 / 旁路防御
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceCollector } from "file:///home/xje/workplace/mini-pi/src/telemetry/collector.ts";
import { TraceStore } from "file:///home/xje/workplace/mini-pi/src/telemetry/store.ts";
import { buildSpanTree, formatSpanTree, listTraces } from "file:///home/xje/workplace/mini-pi/src/telemetry/view.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`${name}: ${ok ? "✅" : "❌"}${detail ? ` ${detail}` : ""}`);
	if (!ok) failures++;
};

const M = { provider: "t", modelId: "t" };
/** 跑一段事件脚本：[时钟前进步数, 事件]；返回收集器与快照 */
function run(script, opts = {}) {
	let clock = 0;
	const collector = new TraceCollector({ sessionId: "test", now: () => clock, ...opts });
	for (const [advance, event] of script) {
		clock += advance;
		collector.onEvent(event);
	}
	return { collector, spans: [...collector.spansSnapshot()], endClock: clock };
}
const assistant = (content, toolCalls = []) => ({
	type: "message_appended",
	message: { role: "assistant", content, toolCalls, model: "t/t" },
});

// —— 1：完整任务（有文本轮 + 工具 + 无文本轮回补 + 工具 + 总结）——
{
	const text1 = "好的，我来创建";
	const script = [
		[1000, { type: "turn_start", input: "创建 hello.txt 并读回" }],
		[100, { type: "message_update", delta: "好的", model: M }],
		[150, { type: "message_update", delta: "，我来创建", model: M }],
		[50, { type: "message_end", content: text1, model: M }],
		[5, assistant(text1, [{ id: "c1", name: "write_file", arguments: '{"path":"hello.txt"}' }])],
		[5, { type: "tool_execution_start", tool: "write_file", argsPreview: '{"path":"hello.txt"}' }],
		[90, { type: "tool_execution_end", tool: "write_file", isError: false }],
		[10, assistant("", [{ id: "c2", name: "read_file", arguments: '{"path":"hello.txt"}' }])],
		[10, { type: "tool_execution_start", tool: "read_file", argsPreview: '{"path":"hello.txt"}' }],
		[30, { type: "tool_execution_end", tool: "read_file", isError: false }],
		[10, assistant("文件已创建并确认")],
		[10, { type: "turn_end", reason: "completed" }],
		[10, { type: "agent_end" }],
	];
	const { spans } = run(script);
	const turn = spans.find((s) => s.name === "turn");
	const chats = spans.filter((s) => s.name === "chat");
	const tools = spans.filter((s) => s.name === "execute_tool");
	check("1a span 数量（turn+chat×3+tool×2）", spans.length === 6, `got ${spans.length}`);
	check(
		"1b turn 结算（起止/原因/根）",
		turn.startTime === 1000 && turn.endTime === 1470 && turn.attributes.reason === "completed" && turn.parentSpanId === null,
	);
	check("1c traceId = 根 spanId 且全体一致", spans.every((s) => s.traceId === turn.spanId) && /^t/.test(turn.spanId));
	check(
		"1d chat1（首轮：起=任务开始, ttft=100, out, 工具数）",
		chats[0].startTime === 1000 &&
			chats[0].endTime === 1305 &&
			chats[0].attributes.ttft_ms === 100 &&
			chats[0].attributes.output_chars === text1.length &&
			chats[0].attributes.tool_calls === 1 &&
			chats[0].attributes.model === "t/t",
	);
	check(
		"1e tool1（精确起止）",
		tools[0].startTime === 1310 && tools[0].endTime === 1400 && tools[0].attributes.tool === "write_file" && tools[0].status === "ok",
	);
	check(
		"1f chat2（无文本轮回补：起=上一工具结束）",
		chats[1].startTime === 1400 && chats[1].endTime === 1410 && chats[1].attributes.output_chars === 0 && chats[1].attributes.tool_calls === 1,
	);
	check("1g chat3（总结轮）", chats[2].startTime === 1450 && chats[2].endTime === 1460, `start=${chats[2].startTime}`);
	const roots = buildSpanTree(spans);
	const order = roots[0]?.children.map((c) => c.spanId).join(",");
	const expectOrder = [chats[0], tools[0], chats[1], tools[1], chats[2]].map((s) => s.spanId).join(",");
	check("1h 树投影（1 根 5 子，按时间排序）", roots.length === 1 && roots[0].children.length === 5 && order === expectOrder);
}

// —— 2：abort 路径（工具回填对 + turn_end(aborted)；中止是预期控制流不是 error）——
{
	const script = [
		[10, { type: "turn_start", input: "长任务" }],
		[50, { type: "message_update", delta: "开始", model: M }],
		[40, assistant("开始", [{ id: "c1", name: "run_command", arguments: "{}" }])],
		[5, { type: "tool_execution_start", tool: "run_command", argsPreview: "{}" }],
		[20, { type: "tool_execution_end", tool: "run_command", isError: true }],
		[5, { type: "turn_end", reason: "aborted" }],
		[5, { type: "agent_end" }],
	];
	const { spans } = run(script);
	const turn = spans.find((s) => s.name === "turn");
	const tool = spans.find((s) => s.name === "execute_tool");
	check(
		"2 abort 路径",
		spans.length === 3 && tool.status === "error" && tool.attributes.is_error === true && turn.attributes.reason === "aborted" && turn.status === "ok",
	);
}

// —— 3：落盘 roundtrip + 坏行容错 + listTraces ——
{
	const dir = mkdtempSync(join(tmpdir(), "mini-pi-trace-"));
	const store = new TraceStore(dir, "sessA");
	const script1 = [
		[1000, { type: "turn_start", input: "任务一" }],
		[10, assistant("完成")],
		[10, { type: "turn_end", reason: "completed" }],
		[10, { type: "agent_end" }],
	];
	const { spans } = run(script1, { sink: store });
	const readBack = store.readAll();
	check("3a 落盘 roundtrip", readBack.length === spans.length && readBack[0].spanId === spans[0].spanId, `lines=${readBack.length}`);
	appendFileSync(store.file, "{ 这不是 JSON\n", "utf8");
	check("3b 损坏行跳过（不整体失败）", store.readAll().length === spans.length);
	// 第二个 trace 追加进同一文件（模拟 resume：新 collector 序号归零）
	run(
		[
			[2000, { type: "turn_start", input: "任务二" }],
			[10, assistant("好的")],
			[10, { type: "turn_end", reason: "completed" }],
			[10, { type: "agent_end" }],
		],
		{ sink: store },
	);
	const traces = listTraces(store.readAll());
	check(
		"3c listTraces（跨进程 traceId 不撞名）",
		traces.length === 2 && traces[1].spanCount === 2 && traces[1].traceId !== traces[0].traceId,
		`ids=${traces.map((t) => t.traceId).join(",")}`,
	);
	rmSync(dir, { recursive: true, force: true });
}

// —— 4：内容门控（默认脱敏；MINI_PI_TRACE_CONTENT=1 才记正文）——
{
	const longInput = "任".repeat(250);
	const script = [
		[10, { type: "turn_start", input: longInput }],
		[10, { type: "turn_end", reason: "completed" }],
		[10, { type: "agent_end" }],
	];
	const off = run(script).spans.find((s) => s.name === "turn");
	check("4a 默认只记长度", off.attributes.input === undefined && off.attributes.input_chars === 250);
	const on = run(script, { content: true }).spans.find((s) => s.name === "turn");
	check("4b content 开启（截断 200+省略号）", typeof on.attributes.input === "string" && on.attributes.input.length === 201);
}

// —— 5：防御（无 start 的 end 被忽略；sink 抛错不影响收集）——
{
	let threw = 0;
	const badSink = {
		append() {
			threw++;
			throw new Error("disk full");
		},
	};
	const { spans } = run(
		[
			[10, { type: "turn_start", input: "x" }],
			[10, { type: "tool_execution_end", tool: "ghost", isError: false }],
			[10, { type: "turn_end", reason: "completed" }],
			[10, { type: "agent_end" }],
		],
		{ sink: badSink },
	);
	check("5a 无对应 start 的 end 不造脏 span", spans.length === 1 && spans[0].name === "turn");
	check("5b sink 抛错不影响收集（旁路）", threw >= 1 && spans.length === 1, `threw=${threw}`);
}

// —— 6：turn 事件挂钩（steering/compaction 等）与文本格式化 ——
{
	const { spans } = run([
		[10, { type: "turn_start", input: "t" }],
		[5, { type: "message_update", delta: "好", model: M }],
		[5, assistant("好")],
		[10, { type: "steering_applied", content: "改方向" }],
		[10, { type: "compaction_applied", summary: "s", tokensBefore: 900, keptMessages: [1, 2] }],
		[10, { type: "turn_end", reason: "completed" }],
		[10, { type: "agent_end" }],
	]);
	const turn = spans.find((s) => s.name === "turn");
	check(
		"6a turn.events 挂钩",
		turn.events.map((e) => e.name).join(",") === "steering,compaction" &&
			turn.events[1].attributes.tokens_before === 900,
	);
	const text = formatSpanTree(buildSpanTree(spans));
	check(
		"6b 树格式化输出",
		text.includes("turn") &&
			text.includes("chat") &&
			text.includes("ttft") &&
			text.includes("[steering compaction]") &&
			text.includes("✓"),
	);
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
if (failures) process.exitCode = 1;
