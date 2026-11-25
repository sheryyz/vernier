import type { MaybePromise, Message, Service, ToolCall, ToolError, ToolResult, Usage } from "./types.ts";

/** A tool as the model sees it: a name, a sentence, and a JSON Schema for the arguments. */
export interface ToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface ModelRequest {
	system: string[];
	messages: Message[];
	tools: ToolSpec[];
	signal: AbortSignal;
}

export type ModelStopReason = "stop" | "tool_use" | "length" | "aborted" | "error";

export interface ModelResponse {
	text: string;
	toolCalls: ToolCall[];
	usage: Usage;
	stopReason: ModelStopReason;
	latencyMs: number;
	/** Provider-native assistant message; goes onto the stored message as `raw`. */
	raw?: unknown;
	errorMessage?: string;
}

export interface ModelService extends Service {
	readonly name: "model";
	readonly modelId: string;
	send(request: ModelRequest): Promise<ModelResponse>;
}

export interface ToolContext {
	cwd: string;
	signal: AbortSignal;
}

export interface ToolOutput {
	ok: boolean;
	content: string;
	error?: ToolError;
}

export interface Tool {
	readonly spec: ToolSpec;
	run(args: Record<string, unknown>, ctx: ToolContext): MaybePromise<ToolOutput>;
}

export interface ToolService extends Service {
	readonly name: "tool";
	specs(): ToolSpec[];
	run(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}
