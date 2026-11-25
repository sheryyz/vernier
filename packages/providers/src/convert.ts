import type {
	AssistantMessage,
	ModelCost,
	Message as PiMessage,
	ToolCall as PiToolCall,
	Usage as PiUsage,
	TextContent,
} from "@earendil-works/pi-ai";
import type { Message, ModelStopReason, ToolCall, Usage } from "@vernier/kernel";

export interface ModelIdentity {
	api: AssistantMessage["api"];
	provider: AssistantMessage["provider"];
	model: string;
}

/**
 * Kernel history -> provider transcript.
 *
 * Assistant messages go back as the provider's own object when we still have it
 * (`raw`). deepseek-flash requires `reasoning_content` on assistant messages, and a
 * message rebuilt from text alone has none; it also changes the bytes, which costs a
 * cache hit. The reconstruction below is the fallback for messages a plugin
 * synthesized, never for ones a provider produced.
 */
export function toProviderMessages(messages: readonly Message[], identity: ModelIdentity): PiMessage[] {
	const out: PiMessage[] = [];
	for (const message of messages) {
		const timestamp = message.meta?.createdAt ?? Date.now();
		if (message.role === "user") {
			out.push({ role: "user", content: message.content, timestamp });
		} else if (message.role === "assistant") {
			out.push(message.raw ? (message.raw as AssistantMessage) : rebuildAssistant(message, identity, timestamp));
		} else if (message.role === "tool") {
			const result = message.toolResult;
			if (!result) continue;
			out.push({
				role: "toolResult",
				toolCallId: result.callId,
				toolName: result.toolName,
				content: [{ type: "text", text: message.content }],
				isError: !result.ok,
				timestamp,
			});
		}
		// `system` is carried by Context.systemPrompt, not by the transcript.
	}
	return out;
}

function rebuildAssistant(message: Message, identity: ModelIdentity, timestamp: number): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (message.content) content.push({ type: "text", text: message.content } satisfies TextContent);
	for (const call of message.toolCalls ?? []) {
		content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.args } as PiToolCall);
	}
	return {
		role: "assistant",
		content,
		api: identity.api,
		provider: identity.provider,
		model: identity.model,
		usage: emptyProviderUsage(),
		stopReason: message.toolCalls?.length ? "toolUse" : "stop",
		timestamp,
	};
}

function emptyProviderUsage(): PiUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function textOf(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

export function toolCallsOf(message: AssistantMessage): ToolCall[] {
	return message.content
		.filter((block): block is PiToolCall => block.type === "toolCall")
		.map((block) => ({ id: block.id, name: block.name, args: block.arguments as Record<string, unknown> }));
}

/**
 * pi-ai already splits DeepSeek's `prompt_cache_hit_tokens` out of the prompt total,
 * so `input` here is the part billed at full price and `cacheRead` the part billed at
 * 1/50th of it. Keeping them apart is the whole point of the cache metric.
 */
export function toUsage(usage: PiUsage, cost: ModelCost | undefined): Usage {
	const inputTokens = usage.input;
	const cacheReadTokens = usage.cacheRead;
	const cacheWriteTokens = usage.cacheWrite;
	const outputTokens = usage.output;
	const reported = usage.cost?.total ?? 0;
	return {
		inputTokens,
		outputTokens,
		reasoningTokens: usage.reasoning ?? 0,
		cacheReadTokens,
		cacheWriteTokens,
		costUsd:
			reported > 0 ? reported : estimateCost({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, cost),
	};
}

export function estimateCost(
	tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
	cost: ModelCost | undefined,
): number {
	if (!cost) return 0;
	const perMillion =
		tokens.inputTokens * cost.input +
		tokens.outputTokens * cost.output +
		tokens.cacheReadTokens * cost.cacheRead +
		tokens.cacheWriteTokens * cost.cacheWrite;
	return perMillion / 1_000_000;
}

export function toStopReason(reason: AssistantMessage["stopReason"]): ModelStopReason {
	switch (reason) {
		case "stop":
			return "stop";
		case "toolUse":
			return "tool_use";
		case "length":
			return "length";
		case "aborted":
			return "aborted";
		default:
			return "error";
	}
}
