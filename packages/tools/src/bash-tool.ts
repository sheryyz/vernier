import { spawn } from "node:child_process";
import type { Tool, ToolContext, ToolOutput } from "@vernier/kernel";
import { truncate } from "./truncate.ts";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;

export const bashTool: Tool = {
	spec: {
		name: "bash",
		description: "Run a shell command in the workspace root. stdout and stderr come back together.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string" },
				timeout_ms: { type: "number", description: `Defaults to ${DEFAULT_BASH_TIMEOUT_MS}.` },
			},
			required: ["command"],
			additionalProperties: false,
		},
	},
	run(args, ctx: ToolContext): Promise<ToolOutput> {
		const command = args.command;
		if (typeof command !== "string") {
			const message = "command must be a string";
			return Promise.resolve({
				ok: false,
				content: message,
				error: { kind: "invalid_args", message, retryable: false },
			});
		}
		const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : DEFAULT_BASH_TIMEOUT_MS;
		return runCommand(command, ctx, timeoutMs);
	},
};

function runCommand(command: string, ctx: ToolContext, timeoutMs: number): Promise<ToolOutput> {
	return new Promise((resolve) => {
		const child = spawn("/bin/sh", ["-c", command], { cwd: ctx.cwd, signal: ctx.signal });
		let output = "";
		let settled = false;

		// The timer is the tool's own deadline; ctx.signal is the run-wide one. Both must
		// land on the same promise, or a hung command outlives the turn that asked for it.
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({
				ok: false,
				content: truncate(output),
				error: { kind: "timeout", message: `command exceeded ${timeoutMs}ms`, retryable: true },
			});
		}, timeoutMs);

		const finish = (result: ToolOutput): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.on("error", (error) => {
			finish({
				ok: false,
				content: truncate(output || String(error)),
				error: { kind: "exec_failed", message: error.message, retryable: false },
			});
		});
		child.on("close", (code) => {
			if (code === 0) {
				finish({ ok: true, content: truncate(output) || "(no output)" });
				return;
			}
			finish({
				ok: false,
				content: truncate(output) || `(no output)`,
				error: { kind: "exec_failed", message: `exit code ${code}`, retryable: false },
			});
		});
	});
}
