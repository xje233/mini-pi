// 工具调用决策的共享类型（内核、门控、审计三方共用，避免类型漂移）
// 对照 Claude Code 的 tool_decision.source 六态，mini-pi 收紧为 8 态：
//   config/rule/hook/default（系统自动）+ user_*（人工审批）。

export type DecisionSource =
	| "config" // 暴露层隐藏（DENY_TOOLS）
	| "rule" // 静态规则命中（ENFORCE_RULES）
	| "hook" // 钩子自身的决策或异常（fail-safe）
	| "default" // 无策略自动放行
	| "user_temporary" // 用户批准"本次"
	| "user_permanent" // 用户批准"本会话总是"（对照 Claude Code 的保存规则，mini 版不落盘）
	| "user_abort" // 未作答（EOF/中止），fail-closed
	| "user_reject"; // 用户明确拒绝

/** 门控裁决：block=true 拒绝；否则放行；source/rule 是审计归因与证据 */
export interface ToolCallDecision {
	block?: boolean;
	reason?: string;
	source?: DecisionSource;
	/** 命中的规则描述（供审计） */
	rule?: string;
}
