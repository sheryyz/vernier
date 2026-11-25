import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The key lives outside the repo on purpose. This reads the same file the setup
 * instructions create, so a run works without the caller exporting anything first.
 */
export function loadApiKey(): void {
	if (process.env.DEEPSEEK_API_KEY) return;
	for (const path of [join(homedir(), ".config", "vernier", "env"), join(process.cwd(), ".env")]) {
		try {
			for (const line of readFileSync(path, "utf8").split("\n")) {
				const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
				if (!match) continue;
				const [, name, rawValue] = match as unknown as [string, string, string];
				if (process.env[name]) continue;
				process.env[name] = rawValue.replace(/^["']|["']$/g, "");
			}
		} catch {
			// Missing file is the normal case for one of the two paths.
		}
		if (process.env.DEEPSEEK_API_KEY) return;
	}
}
