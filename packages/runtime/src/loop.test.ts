import {
	emptyUsage,
	type ModelRequest,
	type ModelResponse,
	type ModelService,
	type ToolCall,
	type ToolContext,
	type ToolResult,
	type ToolService,
	type ToolSpec,
} from "@vernier/kernel";
import { describe, expect, it } from "vitest";
import { run } from "./loop.ts";

function scriptedModel(responses: readonly Partial<ModelResponse>[]): ModelService & { seen: ModelRequest[] } {
	const seen: ModelRequest[] = [];
	let index = 0;
	return {
		name: "model",
		modelId: "scripted",
		seen,
		send(request: ModelRequest): Promise<ModelResponse> {
			seen.push({ ...request, messages: structuredClone(request.messages.map(({ raw: _raw, ...rest }) => rest)) });
			const next = responses[index] ?? { text: "done" };
			index += 1;
			return Promise.resolve({
				text: "",
				toolCalls: [],
				usage: emptyUsage(),
				stopReason: next.toolCalls?.length ? "tool_use" : "stop",
				latencyMs: 1,
				...next,
			});
		},
	};
}

function echoTools(): ToolService & { calls: ToolCall[] } {
	const calls: ToolCall[] = [];
	return {
		name: "tool",
		calls,
		specs(): ToolSpec[] {
			return [{ name: "echo", description: "echo", parameters: { type: "object" } }];
		},
		run(call: ToolCall, _ctx: ToolContext): Promise<ToolResult> {
			calls.push(call);
			return Promise.resolve({ callId: call.id, toolName: call.name, ok: true, content: `echoed ${call.name}` });
		},
	};
}

const budget = { maxTurns: 10, maxToolCalls: 10, timeoutMs: 5_000 };

describe("run", () => {
	it("stops on the first response that calls no tool", async () => {
		const model = scriptedModel([{ text: "nothing to do" }]);
		const result = await run({ task: "hello", cwd: process.cwd(), model, tools: echoTools(), budget });

		expect(result.stopReason).toBe("done");
		expect(result.text).toBe("nothing to do");
		expect(model.seen).toHaveLength(1);
	});

	it("sends a second request carrying the tool result, paired by call id", async () => {
		const model = scriptedModel([
			{ text: "reading", toolCalls: [{ id: "call_1", name: "echo", args: { a: 1 } }] },
			{ text: "all set" },
		]);
		const tools = echoTools();
		const result = await run({ task: "do it", cwd: process.cwd(), model, tools, budget });

		expect(model.seen).toHaveLength(2);
		expect(tools.calls.map((c) => c.id)).toEqual(["call_1"]);
		expect(result.spent.turns).toBe(2);
		expect(result.spent.toolCalls).toBe(1);

		const sentSecond = model.seen[1]?.messages ?? [];
		expect(sentSecond.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
		expect(sentSecond[1]?.toolCalls?.[0]?.id).toBe("call_1");
		expect(sentSecond[2]?.toolResult?.callId).toBe("call_1");
		expect(sentSecond[2]?.toolResult?.toolName).toBe("echo");
		expect(result.text).toBe("all set");
	});

	it("stops at the turn budget instead of looping forever", async () => {
		const model = scriptedModel(
			Array.from({ length: 10 }, () => ({ text: "again", toolCalls: [{ id: "c", name: "echo", args: {} }] })),
		);
		const result = await run({
			task: "loop",
			cwd: process.cwd(),
			model,
			tools: echoTools(),
			budget: { ...budget, maxTurns: 3 },
		});

		expect(result.stopReason).toBe("budget_turns");
		expect(result.spent.turns).toBe(3);
	});

	it("stops at the tool-call budget", async () => {
		const model = scriptedModel(
			Array.from({ length: 10 }, () => ({
				text: "again",
				toolCalls: [
					{ id: "a", name: "echo", args: {} },
					{ id: "b", name: "echo", args: {} },
				],
			})),
		);
		const result = await run({
			task: "loop",
			cwd: process.cwd(),
			model,
			tools: echoTools(),
			budget: { ...budget, maxToolCalls: 3 },
		});

		expect(result.stopReason).toBe("budget_tool_calls");
		expect(result.spent.toolCalls).toBe(3);
	});

	it("emits a trace the report and the panel can both read", async () => {
		const events: string[] = [];
		await run({
			task: "trace me",
			cwd: process.cwd(),
			model: scriptedModel([{ text: "x", toolCalls: [{ id: "c1", name: "echo", args: {} }] }, { text: "y" }]),
			tools: echoTools(),
			budget,
			onEvent: (event) => events.push(event.type),
		});

		expect(events).toEqual([
			"session_start",
			"request",
			"response",
			"tool_call",
			"tool_result",
			"turn_end",
			"request",
			"response",
			"session_end",
		]);
	});
});
