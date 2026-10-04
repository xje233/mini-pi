// 会话持久化 + 压缩回归
import { rmSync } from "node:fs";
import { SessionManager, replaySession } from "file:///home/xje/workplace/mini-pi/src/session/session-manager.ts";
import { estimateTokens, findCutIndex, shouldCompact, DEFAULT_COMPACTION } from "file:///home/xje/workplace/mini-pi/src/agent/compaction.ts";
import { agentLoop } from "file:///home/xje/workplace/mini-pi/src/agent/agent-loop.ts";

const model = { provider: "t", modelId: "t", apiModel: "t", baseUrl: "http://x", apiKeyEnv: "X", label: "t", contextWindow: 128000 };
const mk = (role, content) => ({ role, content });

// 1：JSONL roundtrip（含压缩投影）+ resume 续写
{
	const dir = "/tmp/mini-pi-sess-test";
	rmSync(dir, { recursive: true, force: true });
	const sm = new SessionManager(dir);
	sm.appendMessage(mk("user", "任务A"));
	sm.appendMessage(mk("assistant", "好的"));
	const keptId = sm.appendMessage(mk("user", "任务B"));
	sm.appendMessage(mk("assistant", "完成"));
	sm.append({ type: "compaction", summary: "## Goal\n完成任务A", firstKeptEntryId: keptId, tokensBefore: 100 });
	sm.appendMessage(mk("user", "任务C"));
	const r = replaySession(sm.readEntries());
	const ok1 = r.history.length === 4 && r.history[0]?.content.startsWith("The conversation history before this point was compacted") && !r.history.some((m) => m.content === "任务A");
	const sm2 = new SessionManager(dir, { resume: true });
	const before = sm2.readEntries().length;
	sm2.appendMessage(mk("user", "继续"));
	const ok2 = sm2.readEntries().length === before + 1;
	console.log(`1 JSONL roundtrip: ${ok1 && ok2 ? "✅" : "❌"} history=${r.history.length} resume续写=${ok2}`);
}

// 2：切点安全（不拆 tool 对）
{
	const history = [
		mk("user", "x".repeat(100)),
		{ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] },
		{ role: "toolResult", content: "r".repeat(100), toolCallId: "c1", toolName: "t" },
		mk("user", "y".repeat(100)),
		mk("assistant", "z".repeat(100)),
		{ role: "toolResult", content: "w".repeat(100), toolCallId: "c1", toolName: "t" },
	];
	const cut = findCutIndex(history, 30);
	const role = history[cut]?.role;
	const ok = (role === "user" || role === "assistant") && shouldCompact(200000, 128000, DEFAULT_COMPACTION);
	console.log(`2 切点安全: ${ok ? "✅" : "❌"} cut=${cut}(${role})`);
}

// 3：循环集成（自动压缩）
{
	let asked = false;
	const requests = [];
	const events = [];
	const initialHistory = Array.from({ length: 40 }, (_, i) => mk(i % 2 ? "assistant" : "user", `消息${i} `.repeat(20)));
	await agentLoop(
		{
			systemPrompt: "t",
			tools: [],
			state: { model },
			initialHistory,
			compaction: { reserveTokens: 50, keepRecentTokens: 100, contextWindow: 400 },
			streamFn: async function* (messages) {
				requests.push(messages);
				if (messages[0]?.content.includes("summarization")) {
					yield { type: "text_delta", delta: "## Goal\n压缩测试" };
					yield { type: "done", stopReason: "stop", message: { content: "## Goal\n压缩测试", toolCalls: [], stopReason: "stop" } };
				} else {
					yield { type: "text_delta", delta: "完成" };
					yield { type: "done", stopReason: "stop", message: { content: "完成", toolCalls: [], stopReason: "stop" } };
				}
			},
			getUserMessage: async () => {
				if (!asked) { asked = true; return "继续"; }
				return null;
			},
		},
		(e) => events.push(e),
	);
	const compaction = events.find((e) => e.type === "compaction_applied");
	const normal = requests.find((m) => !m[0]?.content.includes("summarization"));
	const ok = compaction && normal?.some((m) => m.content?.includes("<summary>")) && requests.length === 2;
	console.log(`3 循环自动压缩: ${ok ? "✅" : "❌"} ${estimateTokens(initialHistory)} → ${normal ? estimateTokens(normal.slice(1)) : "?"} token`);
}
