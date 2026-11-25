export interface CliArgs {
	task: string;
	cwd: string;
	modelId: string | undefined;
	reasoning: string | undefined;
	maxTurns: number;
	maxToolCalls: number;
	timeoutMs: number;
	maxCostUsd: number | undefined;
	trace: string | undefined;
	quiet: boolean;
}

export const USAGE = `vernier "<task>" [options]

  --cwd <dir>           workspace root (default: current directory)
  --model <id>          deepseek model id (default: deepseek-flash)
  --reasoning <level>   low | high | max (default: low, fixed for experiments)
  --max-turns <n>       model requests allowed (default: 30)
  --max-tool-calls <n>  tool calls allowed (default: 80)
  --timeout <seconds>   wall-clock budget (default: 600)
  --max-cost <usd>      abort once spend reaches this
  --trace <file>        append trace events as JSONL
  --quiet               only print the final answer
`;

export function parseArgs(argv: readonly string[]): CliArgs {
	const positional: string[] = [];
	const flags = new Map<string, string>();

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i] as string;
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const name = token.slice(2);
		if (name === "quiet") {
			flags.set(name, "true");
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined) throw new Error(`--${name} needs a value`);
		flags.set(name, value);
		i += 1;
	}

	const number = (name: string, fallback: number): number => {
		const raw = flags.get(name);
		if (raw === undefined) return fallback;
		const parsed = Number(raw);
		if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
		return parsed;
	};

	return {
		task: positional.join(" "),
		cwd: flags.get("cwd") ?? process.cwd(),
		modelId: flags.get("model"),
		reasoning: flags.get("reasoning"),
		maxTurns: number("max-turns", 30),
		maxToolCalls: number("max-tool-calls", 80),
		timeoutMs: number("timeout", 600) * 1000,
		maxCostUsd: flags.has("max-cost") ? number("max-cost", 0) : undefined,
		trace: flags.get("trace"),
		quiet: flags.has("quiet"),
	};
}
