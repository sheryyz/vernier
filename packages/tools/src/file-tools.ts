import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "@vernier/kernel";
import { resolveInside } from "./paths.ts";
import { truncate } from "./truncate.ts";

function fail(kind: "not_found" | "invalid_args" | "exec_failed", message: string, retryable = false): ToolOutput {
	return { ok: false, content: message, error: { kind, message, retryable } };
}

function requireString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
	return value;
}

export const readTool: Tool = {
	spec: {
		name: "read",
		description: "Read a UTF-8 text file from the workspace.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path relative to the workspace root." },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	async run(args, ctx: ToolContext): Promise<ToolOutput> {
		let path: string;
		try {
			path = resolveInside(ctx.cwd, requireString(args, "path"));
		} catch (error) {
			return fail("invalid_args", String(error));
		}
		try {
			return { ok: true, content: truncate(await readFile(path, "utf8")) };
		} catch (error) {
			return fail("not_found", `cannot read ${args.path}: ${(error as Error).message}`);
		}
	},
};

export const writeTool: Tool = {
	spec: {
		name: "write",
		description: "Write a file, creating parent directories and replacing any existing content.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				content: { type: "string" },
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
	},
	async run(args, ctx: ToolContext): Promise<ToolOutput> {
		let path: string;
		let content: string;
		try {
			path = resolveInside(ctx.cwd, requireString(args, "path"));
			content = requireString(args, "content");
		} catch (error) {
			return fail("invalid_args", String(error));
		}
		try {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");
			return { ok: true, content: `wrote ${content.length} characters to ${args.path}` };
		} catch (error) {
			return fail("exec_failed", `cannot write ${args.path}: ${(error as Error).message}`);
		}
	},
};

export const editTool: Tool = {
	spec: {
		name: "edit",
		description:
			"Replace one exact occurrence of old_string with new_string. Fails when old_string is absent or appears more than once, so include enough surrounding context to be unique.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				old_string: { type: "string" },
				new_string: { type: "string" },
			},
			required: ["path", "old_string", "new_string"],
			additionalProperties: false,
		},
	},
	async run(args, ctx: ToolContext): Promise<ToolOutput> {
		let path: string;
		let oldString: string;
		let newString: string;
		try {
			path = resolveInside(ctx.cwd, requireString(args, "path"));
			oldString = requireString(args, "old_string");
			newString = requireString(args, "new_string");
		} catch (error) {
			return fail("invalid_args", String(error));
		}
		if (oldString === "") return fail("invalid_args", "old_string must not be empty");

		let source: string;
		try {
			source = await readFile(path, "utf8");
		} catch (error) {
			return fail("not_found", `cannot read ${args.path}: ${(error as Error).message}`);
		}

		const first = source.indexOf(oldString);
		if (first === -1) return fail("invalid_args", `old_string not found in ${args.path}`);
		if (source.indexOf(oldString, first + oldString.length) !== -1) {
			return fail("invalid_args", `old_string appears more than once in ${args.path}; add surrounding context`);
		}

		try {
			await writeFile(path, source.slice(0, first) + newString + source.slice(first + oldString.length), "utf8");
			return { ok: true, content: `edited ${args.path}` };
		} catch (error) {
			return fail("exec_failed", `cannot write ${args.path}: ${(error as Error).message}`);
		}
	},
};
