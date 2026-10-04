// 流式层回归：SSE 组装 / 500 重试 / 流中途 abort（本地 mock SSE 服务器）
import { createRequire } from "node:module";
import http from "node:http";
const require = createRequire("/home/xje/workplace/mini-pi/src/");
const { defaultStreamFn } = require("/home/xje/workplace/mini-pi/src/ai/index.ts");

const model = { provider: "mock", modelId: "m", apiModel: "m", baseUrl: "http://127.0.0.1:0", apiKeyEnv: "X", label: "t", contextWindow: 128000 };
let attempts = 0;
let mode = "normal";

const server = http.createServer((req, res) => {
	attempts++;
	if (mode === "fail-first" && attempts === 1) {
		res.writeHead(500);
		res.end("boom");
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] })}\n\n`);
	res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "你" } }] })}\n\n`);
	setTimeout(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`), 30);
	setTimeout(() => {
		res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"pa' } }] } }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x.txt"}' } }] } }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
		res.end("data: [DONE]\n\n");
	}, 80);
	if (mode === "hang") {
		res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "部分" } }] })}\n\n`);
	}
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/chat/completions`;
process.env.LLM_API_KEY = "test-key";
process.env.X = "test-key";
process.env.LLM_MAX_RETRIES = "3";
const messages = [{ role: "user", content: "t" }];
const noTools = [];

// 场景 A：流式组装
{
	mode = "normal";
	attempts = 0;
	const events = [];
	for await (const ev of defaultStreamFn(messages, model, noTools)) events.push(ev);
	const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
	const done = events.find((e) => e.type === "done");
	const ok = deltas === "你好" && done.message.toolCalls[0]?.arguments === '{"path":"x.txt"}' && done.message.stopReason === "tool_calls";
	console.log(`A 流式组装: ${ok ? "✅" : "❌"} ${deltas} / ${done.message.toolCalls[0]?.arguments}`);
}

// 场景 B：500 → 重试成功
{
	mode = "fail-first";
	attempts = 0;
	const events = [];
	for await (const ev of defaultStreamFn(messages, model, noTools)) events.push(ev);
	const ok = attempts === 2 && events.some((e) => e.type === "done");
	console.log(`B 500 重试: ${ok ? "✅" : "❌"} 尝试 ${attempts} 次`);
}

// 场景 C：流中途 abort → done(aborted)（用户中止专属通道；超时走 error 由 review 测试覆盖）
{
	mode = "hang";
	attempts = 0;
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 60);
	const events = [];
	for await (const ev of defaultStreamFn(messages, model, noTools, controller.signal)) events.push(ev);
	const done = events.find((e) => e.type === "done");
	const ok = done?.message.stopReason === "aborted";
	console.log(`C 流中 abort: ${ok ? "✅" : "❌"} stopReason=${done?.message.stopReason}`);
}

server.close();
