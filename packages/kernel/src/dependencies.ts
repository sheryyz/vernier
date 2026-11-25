import type { Plugin } from "./types.ts";

export type DependencyIssue =
	| { kind: "missing_service"; plugin: string; service: string }
	| { kind: "duplicate_service"; service: string; plugins: string[] }
	| { kind: "cycle"; plugins: string[] };

/**
 * Startup check. Plugins depend on *services*, never on each other by name, so the
 * graph stays shallow and any subset of plugins can be switched off for an ablation
 * run as long as nothing left standing required what was removed.
 */
export function validateDependencies(plugins: readonly Plugin[], builtins: readonly string[] = []): DependencyIssue[] {
	const issues: DependencyIssue[] = [];

	const providers = new Map<string, string[]>();
	for (const name of builtins) providers.set(name, ["<kernel>"]);
	for (const plugin of plugins) {
		for (const service of plugin.provides ?? []) {
			const owners = providers.get(service) ?? [];
			owners.push(plugin.name);
			providers.set(service, owners);
		}
	}

	for (const [service, owners] of providers) {
		if (owners.length > 1) issues.push({ kind: "duplicate_service", service, plugins: owners });
	}

	for (const plugin of plugins) {
		for (const service of plugin.requires ?? []) {
			if (!providers.has(service)) issues.push({ kind: "missing_service", plugin: plugin.name, service });
		}
	}

	issues.push(...findCycles(plugins, providers));
	return issues;
}

/** A requires B's service, B requires A's -- neither can be set up first. */
function findCycles(plugins: readonly Plugin[], providers: Map<string, string[]>): DependencyIssue[] {
	const edges = new Map<string, string[]>();
	for (const plugin of plugins) {
		const deps: string[] = [];
		for (const service of plugin.requires ?? []) {
			for (const owner of providers.get(service) ?? []) {
				if (owner !== "<kernel>" && owner !== plugin.name) deps.push(owner);
			}
		}
		edges.set(plugin.name, deps);
	}

	const issues: DependencyIssue[] = [];
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];

	const visit = (name: string): void => {
		const seen = state.get(name);
		if (seen === "done") return;
		if (seen === "visiting") {
			issues.push({ kind: "cycle", plugins: [...stack.slice(stack.indexOf(name)), name] });
			return;
		}
		state.set(name, "visiting");
		stack.push(name);
		for (const dep of edges.get(name) ?? []) visit(dep);
		stack.pop();
		state.set(name, "done");
	};

	for (const plugin of plugins) visit(plugin.name);
	return issues;
}
