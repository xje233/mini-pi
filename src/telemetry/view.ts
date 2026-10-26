// L5 观测层 · 读取时投影：线性 span 记录 → 树 + 文本格式化（/trace 展示）
// 树不是存出来的，是读的时候按 parentSpanId 聚出来的——jsonl 每行仍是线性记录。

import type { SpanNode, SpanRecord } from "./types.js";

/** 线性记录 → 树（同一父下按 startTime 排序；孤儿节点升为根，不丢数据） */
export function buildSpanTree(spans: SpanRecord[]): SpanNode[] {
	const nodes = new Map<string, SpanNode>();
	for (const span of spans) nodes.set(span.spanId, { ...span, children: [] });
	const roots: SpanNode[] = [];
	for (const node of nodes.values()) {
		const parent = node.parentSpanId !== null ? nodes.get(node.parentSpanId) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	const sortRecursive = (list: SpanNode[]): void => {
		list.sort((a, b) => a.startTime - b.startTime);
		for (const node of list) sortRecursive(node.children);
	};
	sortRecursive(roots);
	return roots;
}

export interface TraceSummary {
	traceId: string;
	root: SpanRecord | null;
	spanCount: number;
	startTime: number;
}

/** 按 traceId 分组（时间升序），供 /trace 选择"最近第 n 个" */
export function listTraces(spans: SpanRecord[]): TraceSummary[] {
	const byId = new Map<string, SpanRecord[]>();
	for (const span of spans) {
		const list = byId.get(span.traceId);
		if (list) list.push(span);
		else byId.set(span.traceId, [span]);
	}
	const summaries: TraceSummary[] = [];
	for (const [traceId, list] of byId) {
		summaries.push({
			traceId,
			root: list.find((s) => s.parentSpanId === null) ?? null,
			spanCount: list.length,
			startTime: Math.min(...list.map((s) => s.startTime)),
		});
	}
	summaries.sort((a, b) => a.startTime - b.startTime);
	return summaries;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
	const seconds = Math.round(ms / 1000);
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function formatAgo(time: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - time) / 1000));
	if (seconds < 60) return `${seconds} 秒前`;
	if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
	return `${Math.round(seconds / 3600)} 小时前`;
}

/** span 树 → 文本（缩进 + 时长 + 关键属性，对齐 OTel 瀑布图的终端简化版） */
export function formatSpanTree(roots: SpanNode[]): string {
	const lines: string[] = [];
	const walk = (node: SpanNode, prefix: string, isLast: boolean, isRoot: boolean): void => {
		const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
		lines.push(`${prefix}${connector}${describe(node)}`);
		const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
		node.children.forEach((child, i) => walk(child, childPrefix, i === node.children.length - 1, false));
	};
	roots.forEach((root, i) => walk(root, "", i === roots.length - 1, true));
	return lines.join("\n");
}

function describe(node: SpanNode): string {
	const attrs = node.attributes;
	const parts: string[] = [
		node.name === "execute_tool" && typeof attrs.tool === "string" ? `execute_tool ${attrs.tool}` : node.name,
	];
	if (typeof attrs.input === "string") parts.push(`"${attrs.input}"`);
	else if (typeof attrs.input_chars === "number") parts.push(`(${attrs.input_chars} 字输入)`);
	if (typeof attrs.model === "string") parts.push(attrs.model);
	if (typeof attrs.ttft_ms === "number") parts.push(`ttft ${attrs.ttft_ms}ms`);
	if (typeof attrs.output_chars === "number") parts.push(`out ${attrs.output_chars} 字`);
	if (typeof attrs.tool_calls === "number" && attrs.tool_calls > 0) parts.push(`→ ${attrs.tool_calls} 个工具调用`);
	if (attrs.is_error === true) parts.push("失败");
	if (attrs.decision === "deny") parts.push(`[拦截:${typeof attrs.decision_source === "string" ? attrs.decision_source : "?"}]`);
	if (typeof attrs.reason === "string" && attrs.reason !== "completed") parts.push(`(${attrs.reason})`);
	parts.push(formatDuration(node.endTime - node.startTime));
	parts.push(node.status === "error" ? "✗" : "✓");
	if (node.events.length) parts.push(`[${node.events.map((e) => e.name).join(" ")}]`);
	return parts.join("  ");
}
