// 软路由回归：search_tools 检索注入 / 差分声明 / 循环集成
import { createRequire } from "node:module";
import { agentLoop } from "file:///home/xje/workplace/mini-pi/src/agent/agent-loop.ts";
import { createSearchToolsTool, diffToolSets, toolChangesMessage } from "file:///home/xje/workplace/mini-pi/src/agent/soft-routing.ts";
const require = createRequire("/home/xje/workplace/mini-pi/src/");
const { Type } = require("@sinclair/typebox");

const model = { provider: "t", modelId: "t", apiModel: "t", baseUrl: "http://x", apiKeyEnv: "X", label: "t", contextWindow: 128000 };
const mk = (name, domain, content = "t") => ({ name, domain, description: content, label: name, parameters: Type.Object({}) });

// 1：search_tools 检索注入
{
	const deferred = [mk("read_file", "fs", "读取文本文件"), mk("write_file", "fs", "写入文件"), mk("net_fetch", "net", "发起 HTTP 请求")];
	const set = { visible: [] };
	set.visible.push(createSearchToolsTool(set, deferred));
	const search = set.visible[0];
	const r1 = await search.execute({ query: "文件" });
	const hitFs = set.visible.some((t) => t.name === "read_file") && set.visible.some((t) => t.name === "write_file");
	const r2 = await search.execute({ query: "http" });
	const hitNet = set.visible.some((t) => t.name === "net_fetch");
	const r3 = await search.execute({ query: "不存在的关键词" });
	const ok = hitFs && hitNet && r3.includes("没有匹配");
	console.log(`1 search_tools: ${ok ? "✅" : "❌"} fs注入=${hitFs} net注入=${hitNet} 未命中提示=${r3.includes("没有匹配")}`);
}

// 2：差分
{
	const a = mk("a", "fs");
	const b = mk("b", "fs");
	const d1 = diffToolSets(null, [a, b]); // 首轮 → null
	const d2 = diffToolSets(["a", "b"], [a]); // 移除 b
	const d3 = diffToolSets(["a"], [a, b]); // 新增 b
	const d4 = diffToolSets(["a"], [a]); // 无变化
	const ok = d1 === null && d2?.removed.includes("b") && d3?.added.includes("b") && d4 === null;
	console.log(`2 diffToolSets: ${ok ? "✅" : "❌"} ${JSON.stringify(d2)} ${JSON.stringify(d3)}`);
	console.log(`   差分消息: ${toolChangesMessage({ added: ["x"], removed: [] })}`);
}

// 3：循环集成——模型调 search_tools → 注入 → 差分声明 → 下一轮工具可用
{
	let asked = false;
	let turn = 0;
	const requests = [];
	const events = [];
	const deferred = [mk("read_file", "fs", "读取文本文件")];
	const set = { visible: [] };
	set.visible.push(createSearchToolsTool(set, deferred));
	await agentLoop(
		{
			systemPrompt: "t",
			tools: set.visible,
			state: { model },
			getActiveTools: () => set.visible,
			streamFn: async function* (messages, _m, tools) {
				turn++;
				requests.push({ msgs: [...messages], tools: tools.map((t) => t.name) });
				if (turn === 1) {
					yield { type: "done", stopReason: "stop", message: { content: "", toolCalls: [{ id: "c1", name: "search_tools", arguments: '{"query":"文件"}' }], stopReason: "stop" } };
				} else {
					yield { type: "done", stopReason: "stop", message: { content: "已找到并读取", toolCalls: [], stopReason: "stop" } };
				}
			},
			getUserMessage: async () => { if (!asked) { asked = true; return "读个文件"; } return null; },
		},
		(e) => events.push(`${e.type}${e.type === "tools_changed" ? `(${e.added.join(",")})` : ""}`),
	);
	const req2 = requests[1];
	const hasSystemDecl = req2.msgs.some((m) => m.role === "system" && String(m.content).includes("工具变更"));
	const hasReadFile = req2.tools.includes("read_file");
	const ok = turn === 2 && hasSystemDecl && hasReadFile && events.includes("tools_changed(read_file)");
	console.log(`3 循环集成: ${ok ? "✅" : "❌"} 请求2 tools=${JSON.stringify(req2.tools)} 声明=${hasSystemDecl}`);
	console.log(`   事件: ${events.join(" → ")}`);
}
