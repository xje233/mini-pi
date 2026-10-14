// L5 观测层 · 数据模型（对照 pi 的 packages/telemetry + OTel GenAI semantic conventions）
//
// 设计口径（对照 docs/observability-research.md 第 3 节）：
//  - span = "有开始、有结束、有结果"的一段工作；span 是诊断数据，不是业务状态
//    （pi: telemetry/README.md "A span is diagnostic data, not business state"）。
//  - 与 pi 的差异：pi 用 callback 式 startSpan（代码主动插桩）；mini-pi 走
//    "事件流重建"路线（collector 从 AgentEvent 推断 span），因此这里的类型是
//    "已结算快照"（SpanRecord）——没有 open/close 的运行时句柄，树是读取时投影。

export type SpanStatus = "ok" | "error";

/** 属性值限定为原始标量（对照 pi 的 AttributeValue 收窄版；数组教学项目暂不需要） */
export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue>;

/** span 内的时间点事件（对照 pi 的 TelemetrySpan.addEvent / OTel Event） */
export interface SpanEventRecord {
	name: string;
	/** epoch ms */
	time: number;
	attributes?: SpanAttributes;
}

/** 一个已结算 span（落盘与内存的存储形态：线性 JSONL 一行一条） */
export interface SpanRecord {
	/** 一次用户任务的 trace id = 该任务 turn span 的 spanId */
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	sessionId: string;
	/** "turn" | "chat" | "execute_tool"（名称对照 OTel：invoke_agent / chat / execute_tool） */
	name: string;
	/** epoch ms */
	startTime: number;
	endTime: number;
	status: SpanStatus;
	attributes: SpanAttributes;
	events: SpanEventRecord[];
}

/** 读取时投影出的树节点（children 按 startTime 排序） */
export interface SpanNode extends SpanRecord {
	children: SpanNode[];
}
