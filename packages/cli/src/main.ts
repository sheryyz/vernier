import { appendFileSync } from "node:fs";
import { cacheHitRate, type TraceEvent } from "@vernier/kernel";
import { createDeepSeekModel } from "@vernier/providers";
import { run } from "@vernier/runtime";
import { defaultTools } from "@vernier/tools";
import { parseArgs, USAGE } from "./args.ts";
import { loadApiKey } from "./env.ts";

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (!args.task) {
		process.stdout.write(USAGE);
		return 1;
	}

	loadApiKey();
	if (!process.env.DEEPSEEK_API_KEY) {
		process.stderr.write("DEEPSEEK_API_KEY is not set (looked at ~/.config/vernier/env and ./.env)\n");
		return 1;
	}

	const model = createDeepSeekModel({
		...(args.modelId ? { modelId: args.modelId } : {}),
		...(args.reasoning ? { reasoning: args.reasoning as "low" } : {}),
	});

	const result = await run({
		task: args.task,
		cwd: args.cwd,
		model,
		tools: defaultTools(),
		budget: {
			maxTurns: args.maxTurns,
			maxToolCalls: args.maxToolCalls,
			timeoutMs: args.timeoutMs,
			...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }),
		},
		onEvent: (event) => {
			if (args.trace) appendFileSync(args.trace, `${JSON.stringify(event)}\n`);
			if (!args.quiet) report(event);
		},
	});

	if (!args.quiet) process.stdout.write("\n");
	process.stdout.write(`${result.text.trim()}\n`);

	const { usage } = result.spent;
	process.stdout.write(
		[
			"",
			`stop: ${result.stopReason}${result.error ? ` (${result.error})` : ""}`,
			`turns: ${result.spent.turns}  tools: ${result.spent.toolCalls}  elapsed: ${(result.spent.elapsedMs / 1000).toFixed(1)}s`,
			`tokens: in ${usage.inputTokens} + cached ${usage.cacheReadTokens} -> out ${usage.outputTokens} (reasoning ${usage.reasoningTokens})`,
			`cache hit: ${(cacheHitRate(usage) * 100).toFixed(1)}%   cost: $${usage.costUsd.toFixed(5)}`,
			"",
		].join("\n"),
	);

	return result.stopReason === "done" ? 0 : 2;
}

/** One line per event. The web panel in M9 reads the same stream from the trace file. */
function report(event: TraceEvent): void {
	const d = event.data;
	switch (event.type) {
		case "request":
			process.stdout.write(`\n[turn ${event.turn}] -> model (${String(d.messages)} messages)\n`);
			break;
		case "response": {
			const usage = d.usage as { inputTokens: number; cacheReadTokens: number; outputTokens: number };
			process.stdout.write(
				`[turn ${event.turn}] <- ${String(d.stopReason)} in ${String(d.latencyMs)}ms  ` +
					`(in ${usage.inputTokens}+${usage.cacheReadTokens} out ${usage.outputTokens})\n`,
			);
			break;
		}
		case "tool_call":
			process.stdout.write(`  · ${String(d.name)} ${preview(d.args)}\n`);
			break;
		case "tool_result":
			process.stdout.write(`    ${d.ok ? "ok" : "FAILED"} ${String(d.durationMs)}ms ${String(d.bytes)} bytes\n`);
			break;
		default:
			break;
	}
}

function preview(args: unknown): string {
	const text = JSON.stringify(args) ?? "";
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exitCode = 1;
	});
