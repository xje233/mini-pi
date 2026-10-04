// 工具路由第一步：registry + expose/enforce 双层权限。
// 对照调研（docs/tool-routing-research.md）：
//   expose 层 = Claude Code 的 disallowed_tools（工具定义从请求移除，模型看不见）
//   enforce 层 = 执行时拦截，支持参数级模式（对照 disallowed_tools=["Bash(rm *)"]）
// 两层缺一不可：expose 管"不浪费注意力"，enforce 管"可见但危险"的工具与参数级规则。
import type { AgentTool } from "./tools.js";

/**
 * 工具注册表：全部可用工具的底账（对照 pi 的 registry，first-registration-wins）。
 * 暴露过滤只改变"模型可见集"，注册表里的工具始终可被路由/恢复。
 */
export class ToolRegistry {
	private tools = new Map<string, AgentTool>();

	register(tool: AgentTool): void {
		if (this.tools.has(tool.name)) {
			// 对照 pi：先到先得，后注册者忽略（扩展生态的重名自治理）
			return;
		}
		this.tools.set(tool.name, tool);
	}

	get(name: string): AgentTool | undefined {
		return this.tools.get(name);
	}

	all(): AgentTool[] {
		return [...this.tools.values()];
	}
}

/**
 * 工具模式匹配：
 *   "run_command"   → 精确名
 *   "shell:*"       → 某领域全部工具（对照 mcp__puppeteer__* 的领域 glob）
 *   "read_*"        → 名称前缀
 *   "*"             → 全部
 */
export function matchToolPattern(pattern: string, tool: { name: string; domain: string }): boolean {
	const domainGlob = /^([\w-]+):\*$/.exec(pattern);
	if (domainGlob) return tool.domain === domainGlob[1];
	if (pattern === "*") return true;
	if (pattern.endsWith("*")) return tool.name.startsWith(pattern.slice(0, -1));
	return tool.name === pattern;
}

/** 暴露过滤：命中 deny 模式的工具从可见集中移除（模型看不见，自然无法调用） */
export function filterVisibleTools(tools: AgentTool[], denyPatterns: string[]): AgentTool[] {
	return tools.filter((t) => !denyPatterns.some((p) => matchToolPattern(p, t)));
}

// —— 执行门控：DenyRule + beforeToolCall 门（对照 disallowed_tools=["Bash(rm *)"]）——

export interface DenyRule {
	/** 工具模式（精确 / domain:* / 前缀*） */
	tool: string;
	/** 可选：参数级正则，对参数 JSON 串匹配——只有命中才拒绝（对照 "Bash(rm *)" 的 rm 部分） */
	argsRegex?: string;
	reason?: string;
}

export interface EnforceVerdict {
	block: boolean;
	reason: string;
}

export function createEnforceGate(rules: DenyRule[]): (input: { tool: AgentTool; args: Record<string, unknown> }) => Promise<EnforceVerdict | undefined> {
	const compiled = rules.map((rule) => ({
		...rule,
		regex: rule.argsRegex ? new RegExp(rule.argsRegex) : undefined,
	}));
	return async ({ tool, args }) => {
		for (const rule of compiled) {
			if (!matchToolPattern(rule.tool, tool)) continue;
			if (rule.regex) {
				// 对参数 JSON 串做正则匹配：参数级拦截的通用近似
				// （对照 Claude Code 的 Bash(rm *)：模式语义由规则作者定义）
				if (!rule.regex.test(JSON.stringify(args))) continue;
			}
			return {
				block: true,
				reason: rule.reason ?? `工具 ${tool.name} 的本次调用被权限规则拒绝（匹配 ${rule.tool}）`,
			};
		}
		return undefined;
	};
}
