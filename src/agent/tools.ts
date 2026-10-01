// 简易内置工具（对照 pi: packages/coding-agent/src/core/tools/ 的 read/write/bash）。
// 按学习计划暂不做参数校验与权限控制（阶段 5 再加），只保留工具描述——
// 模型对"我能干什么"的全部认知来自 description + 参数 schema，必须写清楚。
import { exec } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import type { ToolSchema } from "../ai/index.js";

const execAsync = promisify(exec);

/** 对照 pi: packages/agent/src/types.ts 的 AgentTool（精简版：去掉钩子/onUpdate） */
export interface AgentTool extends ToolSchema {
	label: string;
	/** signal：用户 abort 时工具应尽快终止（如 kill 子进程）并抛错 */
	execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

export const createTools = (): AgentTool[] => [
	{
		name: "read_file",
		label: "读文件",
		description: "读取文本文件的全部内容。参数：path（文件路径）。",
		parameters: Type.Object({
			path: Type.String({ description: "要读取的文件路径" }),
		}),
		execute: async (args) => readFile(String(args.path), "utf8"),
	},
	{
		name: "write_file",
		label: "写文件",
		description: "把文本写入文件，目录不存在会自动创建，已存在则覆盖。参数：path、content。",
		parameters: Type.Object({
			path: Type.String({ description: "目标文件路径" }),
			content: Type.String({ description: "要写入的完整内容" }),
		}),
		execute: async (args) => {
			const path = String(args.path);
			const content = String(args.content ?? "");
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");
			return `已写入 ${path}（${content.length} 字符）`;
		},
	},
	{
		name: "list_dir",
		label: "列目录",
		description: "列出目录下的文件和子目录（子目录以 / 结尾）。参数：path（目录路径，默认当前目录）。",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "目录路径" })),
		}),
		execute: async (args) => {
			const path = args.path ? String(args.path) : process.cwd();
			const entries = await readdir(path, { withFileTypes: true });
			if (!entries.length) return "(空目录)";
			return entries
				.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
				.join("\n");
		},
	},
	{
		name: "run_command",
		label: "执行命令",
		description: "在当前工作目录执行 shell 命令，返回 stdout 与 stderr（超时 30 秒）。参数：command。",
		parameters: Type.Object({
			command: Type.String({ description: "要执行的 shell 命令" }),
		}),
		execute: async (args, signal) => {
			try {
				// signal 传入 exec：用户 abort 时直接 kill 子进程（Node ≥16 支持）
				const { stdout } = await execAsync(String(args.command), {
					timeout: 30_000,
					maxBuffer: 1024 * 1024,
					signal,
				});
				return stdout || "(命令执行成功，无输出)";
			} catch (err) {
				// 非零退出码也算"结果"而非异常：stderr 原样回填，模型看到后自己修
				// （对照 pi 的错误契约：工具失败以 isError 结果进入对话，不在循环里抛出）
				const e = err as { stdout?: string; stderr?: string; message: string };
				return e.stderr || e.stdout || e.message;
			}
		},
	},
];
