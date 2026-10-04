// 会话持久化：追加式 JSONL（对照 pi: packages/coding-agent/src/core/session-manager.ts）。
// 核心原则：底账永不删除——压缩/分支只改变"重放时的投影"，不改文件内容。
// 简化：单链追加（pi 的 parentId 树是分支/fork 的地基，留作扩展）。
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../ai/index.js";
import { summaryMessage } from "../agent/compaction.js";

export interface EntryBase {
	id: number;
	timestamp: number;
}

export type SessionEntry =
	| ({ type: "session"; cwd: string } & EntryBase)
	| ({ type: "message"; message: ChatMessage } & EntryBase)
	| ({ type: "model_change"; provider: string; modelId: string } & EntryBase)
	| ({ type: "compaction"; summary: string; firstKeptEntryId: number | null; tokensBefore: number } & EntryBase);

/** Omit 在联合类型上会塌缩成公共键，必须用分布式版本逐成员剔除 id/timestamp */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type AppendableEntry = DistributiveOmit<SessionEntry, "id" | "timestamp">;

export class SessionManager {
	readonly file: string;
	private nextId = 0;

	constructor(dir: string, opts: { resume?: boolean } = {}) {
		mkdirSync(dir, { recursive: true });
		if (opts.resume) {
			const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
			if (!files.length) throw new Error("没有可恢复的会话");
			this.file = join(dir, files[files.length - 1]!);
			const entries = this.readEntries();
			this.nextId = entries.length > 0 ? entries[entries.length - 1]!.id + 1 : 0;
		} else {
			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			this.file = join(dir, `${id}.jsonl`);
			this.append({ type: "session", cwd: process.cwd() });
		}
	}

	/** 追加一条 entry，返回它的 id（供 firstKeptEntryId 之类的前向引用） */
	append(entry: AppendableEntry): number {
		const full = { ...entry, id: this.nextId++, timestamp: Date.now() } as SessionEntry;
		// 追加式写入：崩溃时最多丢最后一行，永不写坏整个文件
		appendFileSync(this.file, JSON.stringify(full) + "\n", "utf8");
		return full.id;
	}

	appendMessage(message: ChatMessage): number {
		return this.append({ type: "message", message });
	}

	readEntries(): SessionEntry[] {
		return readFileSync(this.file, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as SessionEntry);
	}
}

export interface ReplayedSession {
	/** 重放后的模型上下文（已应用压缩投影） */
	history: ChatMessage[];
	/** 最近一次模型切换（无则为 null） */
	model: { provider: string; modelId: string } | null;
	/** 重放消息 → 底账 entry id（恢复进程的压缩需要它定位保留区起点） */
	messageEntryIds: Map<ChatMessage, number>;
}

/**
 * 重放（对照 pi 的 buildContextEntries + getSessionContextSettings）：
 * 模型上下文 = 最后一次 compaction 的摘要消息 + firstKeptEntryId 之后的全部消息；
 * 更早的消息被摘要替代（底账仍在文件里）。model_change 只恢复状态，不进上下文。
 */
export function replaySession(entries: SessionEntry[]): ReplayedSession {
	let model: { provider: string; modelId: string } | null = null;
	let lastCompaction: Extract<SessionEntry, { type: "compaction" }> | null = null;
	const messageEntryIds = new Map<ChatMessage, number>();
	for (const e of entries) {
		if (e.type === "model_change") model = { provider: e.provider, modelId: e.modelId };
		if (e.type === "message") messageEntryIds.set(e.message, e.id);
		if (e.type === "compaction") lastCompaction = e;
	}

	const history: ChatMessage[] = [];
	if (lastCompaction) {
		history.push(summaryMessage(lastCompaction.summary));
		// firstKeptEntryId 为 null 时视为"摘要后什么都不保留"（对照 pi：用自身 id）
		const from = lastCompaction.firstKeptEntryId ?? lastCompaction.id;
		for (const e of entries) {
			if (e.type === "message" && e.id >= from) history.push(e.message);
		}
	} else {
		for (const e of entries) {
			if (e.type === "message") history.push(e.message);
		}
	}
	return { history, model, messageEntryIds };
}
