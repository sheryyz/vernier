import { describe, expect, it } from "vitest";
import { validateDependencies } from "./dependencies.ts";
import type { Plugin } from "./types.ts";

const plugin = (name: string, requires: string[] = [], provides: string[] = []): Plugin => ({
	name,
	requires,
	provides,
	setup: () => {},
});

describe("validateDependencies", () => {
	it("accepts a plugin whose requirement a builtin service covers", () => {
		expect(validateDependencies([plugin("compaction", ["model"])], ["model", "tool"])).toEqual([]);
	});

	it("reports a requirement nobody provides", () => {
		expect(validateDependencies([plugin("memory", ["store"])], ["model"])).toEqual([
			{ kind: "missing_service", plugin: "memory", service: "store" },
		]);
	});

	it("reports two plugins claiming the same service", () => {
		const issues = validateDependencies([plugin("a", [], ["store"]), plugin("b", [], ["store"])]);
		expect(issues).toEqual([{ kind: "duplicate_service", service: "store", plugins: ["a", "b"] }]);
	});

	it("reports a cycle between two plugins", () => {
		const issues = validateDependencies([plugin("a", ["sb"], ["sa"]), plugin("b", ["sa"], ["sb"])]);
		expect(issues.some((i) => i.kind === "cycle")).toBe(true);
	});

	it("lets an arbitrary subset be switched off, which is what ablation runs do", () => {
		const all = [plugin("hardening", ["tool"]), plugin("compaction", ["model"]), plugin("planner", ["tool"])];
		for (const dropped of all) {
			const kept = all.filter((p) => p !== dropped);
			expect(validateDependencies(kept, ["model", "tool"])).toEqual([]);
		}
	});
});
