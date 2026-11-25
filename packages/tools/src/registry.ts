import type { Tool, ToolCall, ToolContext, ToolResult, ToolService, ToolSpec } from "@vernier/kernel";
import { bashTool } from "./bash-tool.ts";
import { editTool, readTool, writeTool } from "./file-tools.ts";

export class ToolRegistry implements ToolService {
	readonly name = "tool" as const;
	private readonly tools = new Map<string, Tool>();

	constructor(tools: readonly Tool[]) {
		for (const tool of tools) this.tools.set(tool.spec.name, tool);
	}

	specs(): ToolSpec[] {
		return [...this.tools.values()].map((tool) => tool.spec);
	}

	async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
		const tool = this.tools.get(call.name);
		if (!tool) {
			const message = `unknown tool: ${call.name}`;
			return {
				callId: call.id,
				toolName: call.name,
				ok: false,
				content: message,
				error: { kind: "not_found", message, retryable: false },
			};
		}
		try {
			const output = await tool.run(call.args, ctx);
			const result: ToolResult = {
				callId: call.id,
				toolName: call.name,
				ok: output.ok,
				content: output.content,
			};
			if (output.error) result.error = output.error;
			return result;
		} catch (error) {
			// A tool that throws is a bug in the tool, not an answer for the model, but the
			// loop still has to send something back or the transcript loses a pairing.
			const message = error instanceof Error ? error.message : String(error);
			return {
				callId: call.id,
				toolName: call.name,
				ok: false,
				content: message,
				error: { kind: "internal", message, retryable: false },
			};
		}
	}
}

export function defaultTools(): ToolRegistry {
	return new ToolRegistry([readTool, writeTool, editTool, bashTool]);
}
