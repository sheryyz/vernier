import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Layering, enforced instead of documented. The kernel must stay ignorant of every
 * concrete mechanism -- that is the whole reason an ablation run can switch plugins
 * off one at a time.
 */
const ALLOWED: Record<string, readonly string[]> = {
	kernel: [],
	providers: ["kernel"],
	tools: ["kernel"],
	session: ["kernel"],
	runtime: ["kernel", "providers", "tools", "session"],
	plugins: ["kernel", "tools"],
	evals: ["kernel", "runtime", "providers", "tools", "session", "plugins"],
	cli: ["kernel", "runtime", "providers", "tools", "session", "plugins", "evals"],
	web: ["kernel", "session"],
};

const SCOPE = "@vernier/";
const root = new URL("../packages", import.meta.url).pathname;

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...tsFiles(path));
		else if (entry.endsWith(".ts")) out.push(path);
	}
	return out;
}

function importsOf(source: string): string[] {
	return [...source.matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((m) => m[1] as string);
}

describe("package layering", () => {
	const packages = readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory());

	it("declares a rule for every package that exists", () => {
		expect(packages.filter((name) => !(name in ALLOWED))).toEqual([]);
	});

	for (const name of packages) {
		it(`${name} only imports packages it is allowed to`, () => {
			const allowed = ALLOWED[name] ?? [];
			const violations: string[] = [];
			for (const file of tsFiles(join(root, name))) {
				for (const spec of importsOf(readFileSync(file, "utf8"))) {
					if (!spec.startsWith(SCOPE)) continue;
					const target = spec.slice(SCOPE.length).split("/")[0] as string;
					if (target !== name && !allowed.includes(target)) {
						violations.push(`${file.slice(root.length + 1)} -> ${target}`);
					}
				}
			}
			expect(violations).toEqual([]);
		});
	}
});
