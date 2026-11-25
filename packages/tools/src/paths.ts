import { isAbsolute, relative, resolve } from "node:path";

/**
 * Every path a tool touches goes through here. A model that writes to `../../.ssh`
 * should fail loudly, not quietly, and a benchmark run must never be able to reach
 * outside the workspace it was handed.
 */
export function resolveInside(cwd: string, path: string): string {
	const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
	const rel = relative(resolve(cwd), absolute);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new PathEscapeError(path, cwd);
	}
	return absolute;
}

export class PathEscapeError extends Error {
	constructor(path: string, cwd: string) {
		super(`path leaves the workspace: ${path} (workspace: ${cwd})`);
		this.name = "PathEscapeError";
	}
}
