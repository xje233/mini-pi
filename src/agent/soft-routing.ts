// 工具路由第二步：软路由（对照 Claude Code 的 Tool Search / defer_loading）。
// 长尾工具不进可见集，模型通过 search_tools 元工具按关键词/领域检索，
// 命中的工具注入可见集（下一轮生效）；工具集差分由循环层的
// declareToolChanges 机制声明给模型（pi: agent-loop.ts:332）。
//
// 选择"元工具 + 关键词过滤"而非 harness 侧向量召回的理由（调研文档 3.③）：
// 召回失败 = 模型不知道工具存在且无法自救；元工具路线检索错误可重试。
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "./tools.js";

/** 可见集的可变容器（main/循环/工具三方共享同一引用） */
export interface ToolSet {
	visible: AgentTool[];
}

/**
 * search_tools 元工具：检索 deferred 工具并注入可见集。
 * 注入后由循环层的 declareToolChanges 差分声明给模型。
 */
export function createSearchToolsTool(set: ToolSet, deferred: AgentTool[]): AgentTool {
	return {
		name: "search_tools",
		label: "搜索工具",
		domain: "meta",
		description:
			"搜索并加载延迟工具。部分工具未加载，需要时用关键词搜索（匹配工具名/描述/领域/标签），" +
			"命中的工具会在下一轮自动加入你的可用工具集。参数：query（关键词）、domain（可选，限定领域）。",
		parameters: Type.Object({
			query: Type.String({ description: "关键词，匹配工具名/描述/领域/标签" }),
			domain: Type.Optional(Type.String({ description: "限定领域，如 fs/shell" })),
		}),
		execute: async (args) => {
			// 分词 OR 匹配（审查修复：整句子串匹配会让多词查询必然落空——
			// "运行命令 shell 时间" 整串不是 haystack 子串，但任一 token 都该命中）
			const tokens = String(args.query ?? "")
				.toLowerCase()
				.split(/\s+/)
				.filter(Boolean);
			const domain = args.domain ? String(args.domain) : undefined;
			const hits = deferred.filter((t) => {
				if (set.visible.some((v) => v.name === t.name)) return false; // 已加载过
				if (domain && t.domain !== domain) return false;
				if (!tokens.length) return true; // 只给领域 → 返回该领域全部
				const haystack = [t.name, t.description, t.domain, ...(t.tags ?? [])].join(" ").toLowerCase();
				return tokens.some((tok) => haystack.includes(tok));
			});
			if (!hits.length) {
				return "没有匹配的延迟工具。可换关键词重试，或直接用现有工具完成任务。";
			}
			set.visible.push(...hits); // 注入可见集（下一轮生效）
			return [
				`已加载 ${hits.length} 个工具（下一轮可用）：`,
				...hits.map((t) => `- ${t.name}（${t.domain}）：${t.description}`),
			].join("\n");
		},
	};
}

/**
 * 工具集差分（对照 pi 的 declareToolChanges：agent-loop.ts:332）。
 * lastDeclared 为 null 表示首轮（初始集由请求的 tools 参数自然携带，无需声明）。
 * 无变化返回 null。
 */
export function diffToolSets(
	lastDeclared: string[] | null,
	current: AgentTool[],
): { added: string[]; removed: string[] } | null {
	if (lastDeclared === null) return null;
	const names = current.map((t) => t.name);
	const added = names.filter((n) => !lastDeclared.includes(n));
	const removed = lastDeclared.filter((n) => !names.includes(n));
	if (!added.length && !removed.length) return null;
	return { added, removed };
}

/** 差分 → 注入历史的 system 消息文本 */
export function toolChangesMessage(diff: { added: string[]; removed: string[] }): string {
	const parts: string[] = [];
	if (diff.added.length) parts.push(`新增工具: ${diff.added.join(", ")}`);
	if (diff.removed.length) parts.push(`移除工具: ${diff.removed.join(", ")}`);
	return `[工具变更] ${parts.join("；")}。可用工具集已更新。`;
}
