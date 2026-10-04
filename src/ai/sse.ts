// SSE（Server-Sent Events）解析器。
// 对照 pi: packages/ai/src/api/anthropic-messages.ts 的 iterateSseMessages（L411）——
// body.getReader() + TextDecoder(stream:true) 增量解码，跨 chunk 维护行缓冲，
// 每凑齐一行立即 yield，不做额外批量缓冲（第一个 token 到达即可见）。
//
// OpenAI 兼容协议的事件就是一个 data: 行（`data: {...}\n\n`），
// 结束哨兵为 `data: [DONE]`。SSE 规范的多行 data 聚合、event: 字段
// 在 OpenAI 兼容协议里用不到，mini-pi 按行解析即可。

/** 逐事件产出 data 载荷（已去掉 "data: " 前缀；[DONE] 作为流结束直接终止） */
export async function* iterateSseData(response: Response, signal?: AbortSignal): AsyncGenerator<string> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("LLM 响应缺少 body（无法流式读取）");
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				await reader.cancel().catch(() => {});
				throw new DOMException("Aborted", "AbortError");
			}
			const { done, value } = await reader.read();
			if (done) break;
			// stream: true 让 decoder 处理跨 chunk 的多字节 UTF-8 字符
			buffer += decoder.decode(value, { stream: true });

			let idx: number;
			while ((idx = buffer.indexOf("\n")) !== -1) {
				let line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1); // 兼容 \r\n
				if (!line.startsWith("data:")) continue; // SSE 注释/空行/其他字段
				const data = line.slice(5).trimStart();
				if (data === "[DONE]") return; // 流结束哨兵
				if (data) yield data;
			}
		}
		// 流异常截断时 flushing 残余 buffer（对照 pi 的 flush 逻辑；清掉可能的 \r 尾巴）
		const rest = buffer.replace(/\r+$/, "").trim();
		if (rest.startsWith("data:")) yield rest.slice(5).trimStart();
	} finally {
		reader.releaseLock();
	}
}
