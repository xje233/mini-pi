// L5 观测层 · JSONL 落盘（对照 Codex rollout：append-only，崩溃最多丢最后一行）
// 存储与服务分离：collector 只管重建，写入/读取全在这里（对照 pi：exporter 是 adapter 的私事）。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TraceSink } from "./collector.js";
import type { SpanRecord } from "./types.js";

export class TraceStore implements TraceSink {
	readonly file: string;

	constructor(dir: string, sessionId: string) {
		mkdirSync(dir, { recursive: true });
		this.file = join(dir, `${sessionId}.jsonl`);
	}

	append(span: SpanRecord): void {
		appendFileSync(this.file, JSON.stringify(span) + "\n", "utf8");
	}

	/**
	 * 全量读取。逐行容错：损坏行跳过而非整体失败
	 * （F10 已知未修项 SessionManager.readEntries 的同款教训，新代码不再犯）。
	 */
	readAll(): SpanRecord[] {
		if (!existsSync(this.file)) return [];
		const spans: SpanRecord[] = [];
		for (const line of readFileSync(this.file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				spans.push(JSON.parse(line) as SpanRecord);
			} catch {
				// 跳过损坏行（半行写入/手工编辑）
			}
		}
		return spans;
	}
}
