// L5 观测层 · 护栏审计（对照 Claude Code 的 tool_decision 事件）
//
// 与 trace 的分工（调研文档"护栏审计"一节）：
//   trace = 诊断数据（可采样、随 session、树形，回答"慢在哪"）
//   audit = 证据账本（deny 全量、跨会话可查、拒绝要记内容，回答"谁为什么放行/拦截"）
// mini-pi 取舍：deny 全量记录；allow 默认不记（AUDIT_ALLOW=1 开全量——生产合规
// 应全量，教学默认降噪）。内容门控复用 MINI_PI_TRACE_CONTENT：默认只记参数长度。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "../agent/agent-loop.js";
import type { DecisionSource } from "../agent/decision.js";

export type { DecisionSource };

/** 一条审计记录 = 一次权限决策（对照 Claude Code 的 claude_code.tool_decision） */
export interface DecisionRecord {
	sessionId: string;
	/** epoch ms */
	timestamp: number;
	/** 决策发生在任务内时关联 trace；启动期的 expose 决策为 null */
	traceId: string | null;
	tool: string;
	decision: "allow" | "deny";
	/** 归因：config=暴露层隐藏；rule=规则命中；hook=钩子决策/异常；default=无策略放行 */
	source: DecisionSource;
	/** 命中的规则描述（source=rule 时的证据） */
	rule?: string;
	reason?: string;
	/** 参数长度（默认记录） */
	argsChars?: number;
	/** 参数正文（内容门控开启时记录，已截断） */
	argsPreview?: string;
}

export class AuditStore {
	readonly file: string;

	constructor(dir: string, sessionId: string) {
		mkdirSync(dir, { recursive: true });
		this.file = join(dir, `${sessionId}.jsonl`);
	}

	append(record: DecisionRecord): void {
		appendFileSync(this.file, JSON.stringify(record) + "\n", "utf8");
	}

	/** 逐行容错（与 TraceStore 同款：坏行跳过，不整体失败） */
	readAll(): DecisionRecord[] {
		if (!existsSync(this.file)) return [];
		const records: DecisionRecord[] = [];
		for (const line of readFileSync(this.file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line) as DecisionRecord);
			} catch {
				// 跳过损坏行（半行写入/手工编辑）
			}
		}
		return records;
	}
}

export interface AuditLoggerOptions {
	sessionId: string;
	/** 是否记录参数正文（与 trace 共用同一个内容门控变量） */
	content?: boolean;
	/** 是否记录 allow 决策（生产合规应全量；默认只记拦截） */
	recordAllow?: boolean;
	getTraceId?: () => string | null;
}

/** 把内核算出的 tool_decision 事件落成审计账本（内核陈述事实，消费方筛粒度） */
export class AuditLogger {
	constructor(
		private readonly store: AuditStore,
		private readonly opts: AuditLoggerOptions,
	) {}

	onEvent(event: AgentEvent): void {
		if (event.type !== "tool_decision") return;
		// 自动放行（default）默认不记；人工批准（user_*）必须留痕——审计价值最高
		if (event.decision === "allow" && event.source === "default" && !this.opts.recordAllow) return;
		try {
			this.store.append({
				sessionId: this.opts.sessionId,
				timestamp: Date.now(),
				traceId: this.opts.getTraceId?.() ?? null,
				tool: event.tool,
				decision: event.decision,
				source: event.source,
				...(event.rule ? { rule: event.rule } : {}),
				...(event.reason ? { reason: event.reason } : {}),
				argsChars: event.argsChars,
				...(this.opts.content ? { argsPreview: event.argsPreview } : {}),
			});
		} catch {
			// 旁路原则：审计落盘失败不影响主流程（与 TraceCollector 同款）
		}
	}
}

/** /audit 的单行展示（抽成纯函数便于测试） */
export function formatDecision(record: DecisionRecord): string {
	const time = new Date(record.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
	const verdict = (record.decision === "deny" ? "DENY" : "ALLOW").padEnd(5);
	const trace = record.traceId ? ` [${record.traceId}]` : "";
	const why = record.rule ? `命中规则 ${record.rule}` : (record.reason ?? "");
	const args =
		record.argsPreview !== undefined
			? ` args=${record.argsPreview}`
			: record.argsChars !== undefined
				? ` args=${record.argsChars}字`
				: "";
	return `${time} ${verdict} ${record.tool} [${record.source}]${trace} ${why}${args}`.trim();
}
