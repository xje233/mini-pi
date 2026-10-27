// L5-C · Eval runner：发现用例 → 串行执行 → 报告 → 基线对比
//
// 用法：
//   npm run eval                     跑全部用例，与基线对比（失败 exit 1）
//   npm run eval -- --update-baseline  更新 evals/baseline.json
//
// 产物：.mini-pi/evals/latest.json（gitignore）；基线 evals/baseline.json（入库）

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCase, type EvalCase, type EvalResult } from "./harness.js";

const CASES_DIR = resolve("evals/cases");
const BASELINE_FILE = resolve("evals/baseline.json");
const RESULTS_FILE = resolve(".mini-pi/evals/latest.json");

interface BaselineCase {
	name: string;
	passed: boolean;
}

interface Baseline {
	version: number;
	gitCommit: string;
	updatedAt: string;
	cases: BaselineCase[];
}

function gitCommit(): string {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

async function loadCases(): Promise<EvalCase[]> {
	if (!existsSync(CASES_DIR)) throw new Error(`找不到用例目录: ${CASES_DIR}`);
	const files = readdirSync(CASES_DIR)
		.filter((file) => file.endsWith(".eval.mjs"))
		.sort();
	const cases: EvalCase[] = [];
	for (const file of files) {
		const module = await import(pathToFileURL(join(CASES_DIR, file)).href);
		const def = module.default as EvalCase | undefined;
		if (!def) throw new Error(`${file} 没有 default 导出`);
		cases.push(def);
	}
	return cases;
}

function formatMetrics(result: EvalResult): string {
	const m = result.metrics;
	return `llm=${m.llmCalls} tools=${m.toolCalls} exec=${m.executedTools} spans=${m.spans} ${m.durationMs}ms`;
}

async function main(): Promise<void> {
	const updateBaseline = process.argv.includes("--update-baseline");
	const cases = await loadCases();
	const results: EvalResult[] = [];

	for (const def of cases) {
		const result = await runCase(def);
		results.push(result);
		console.log(`${result.passed ? "✓" : "✗"} ${result.name.padEnd(26)} ${formatMetrics(result)}`);
		for (const failure of result.failures) console.log(`   - ${failure}`);
	}

	const passed = results.filter((r) => r.passed).length;
	const rate = results.length ? passed / results.length : 0;
	console.log(`\n结果: ${passed}/${results.length} 通过（${Math.round(rate * 100)}%）`);

	mkdirSync(resolve(".mini-pi/evals"), { recursive: true });
	writeFileSync(
		RESULTS_FILE,
		JSON.stringify({ generatedAt: new Date().toISOString(), gitCommit: gitCommit(), results }, null, 2) + "\n",
		"utf8",
	);

	const baseline: Baseline | null = existsSync(BASELINE_FILE)
		? (JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline)
		: null;
	if (baseline && !updateBaseline) {
		const before = new Map(baseline.cases.map((c) => [c.name, c.passed]));
		const beforePassed = baseline.cases.filter((c) => c.passed).length;
		const beforeRate = baseline.cases.length ? beforePassed / baseline.cases.length : 0;
		const newlyFailing = results.filter((r) => !r.passed && before.get(r.name) === true).map((r) => r.name);
		const newlyPassing = results.filter((r) => r.passed && before.get(r.name) === false).map((r) => r.name);
		const delta = Math.round((rate - beforeRate) * 100);
		console.log(
			`基线（${baseline.gitCommit} · ${baseline.updatedAt.slice(0, 10)}）：` +
				`${beforePassed}/${baseline.cases.length} → ${passed}/${results.length}（${delta >= 0 ? "+" : ""}${delta} 个百分点）`,
		);
		if (newlyFailing.length) console.log(`新失败: ${newlyFailing.join("、")}`);
		if (newlyPassing.length) console.log(`新通过: ${newlyPassing.join("、")}`);
	}

	if (updateBaseline) {
		const next: Baseline = {
			version: 1,
			gitCommit: gitCommit(),
			updatedAt: new Date().toISOString(),
			cases: results.map((r) => ({ name: r.name, passed: r.passed })),
		};
		writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
		console.log(`已更新基线: ${BASELINE_FILE}`);
	}

	if (passed !== results.length) process.exitCode = 1;
}

await main();
