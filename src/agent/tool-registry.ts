// 工具路由第一步：registry + expose/enforce 双层权限。
// 对照调研（docs/tool-routing-research.md）：
//   expose 层 = Claude Code 的 disallowed_tools（工具定义从请求移除，模型看不见）
//   enforce 层 = 执行时拦截，支持参数级模式（对照 disallowed_tools=["Bash(rm *)"]）
// 两层缺一不可：expose 管"不浪费注意力"，enforce 管"可见但危险"的工具与参数级规则。
import type { ToolCallDecision } from "./decision.js";
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

/** 门控裁决（共享类型见 decision.ts，避免内核/门控/审计三方类型漂移） */
export type EnforceVerdict = ToolCallDecision;

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
				source: "rule",
				rule: `${rule.tool}${rule.argsRegex ? ` ~ /${rule.argsRegex}/` : ""}`,
				reason: rule.reason ?? `工具 ${tool.name} 的本次调用被权限规则拒绝（匹配 ${rule.tool}）`,
			};
		}
		return undefined;
	};
}

// —— 交互式审批：命中 ASK_TOOLS 的调用在 execute 前询问用户 ——
// 对照 Claude Code 的四个人工决策源（user_temporary/user_permanent/user_reject/user_abort）。

export interface ApprovalRequest {
	tool: string;
	argsPreview: string;
}

export type ApprovalAnswer = "yes" | "always" | "no" | "abort";

export interface ApprovalGateOptions {
	/** 命中即询问的工具模式（同 matchToolPattern：精确名 / domain:* / 前缀*） */
	patterns: string[];
	/** 会话层注入的交互函数（内核不感知 stdin） */
	requestApproval: (request: ApprovalRequest) => Promise<ApprovalAnswer>;
}

/**
 * 审批门：y=本次（user_temporary）/ a=本会话总是（user_permanent）/
 * n=拒绝（user_reject）/ abort=未作答（user_abort，fail-closed）。
 * always 集合是进程级（本会话）——对照 Claude Code 的 user_permanent，但不落盘。
 */
export function createApprovalGate(
	opts: ApprovalGateOptions,
): (input: { tool: AgentTool; args: Record<string, unknown> }) => Promise<EnforceVerdict | undefined> {
	const always = new Set<string>();
	return async ({ tool, args }) => {
		if (!opts.patterns.some((p) => matchToolPattern(p, tool))) return undefined;
		if (always.has(tool.name)) {
			return { source: "user_permanent", rule: `本会话已批准 ${tool.name}` };
		}
		const answer = await opts.requestApproval({
			tool: tool.name,
			argsPreview: JSON.stringify(args).slice(0, 200),
		});
		if (answer === "yes") return { source: "user_temporary" };
		if (answer === "always") {
			always.add(tool.name);
			return { source: "user_permanent", rule: `本会话已批准 ${tool.name}` };
		}
		if (answer === "abort") {
			return { block: true, source: "user_abort", reason: "审批未作答（EOF/中止），按拒绝处理" };
		}
		return { block: true, source: "user_reject", reason: "用户拒绝了本次工具调用" };
	};
}

export type ToolGate = (input: { tool: AgentTool; args: Record<string, unknown> }) => Promise<EnforceVerdict | undefined>;

/** 组合多个门控：任一 block 即返回；否则透传最后一个归因（审批的 user_* 才不会丢） */
export function composeGates(gates: Array<ToolGate | undefined>): ToolGate | undefined {
	const active = gates.filter((gate): gate is ToolGate => gate !== undefined);
	if (!active.length) return undefined;
	return async (input) => {
		let last: EnforceVerdict | undefined;
		for (const gate of active) {
			const verdict = await gate(input);
			if (verdict?.block) return verdict;
			if (verdict) last = verdict;
		}
		return last;
	};
}
