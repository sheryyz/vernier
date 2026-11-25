import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message as PiMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createFauxModel, fauxAssistantMessage, fauxText, fauxToolCall } from "@vernier/providers";
import { run } from "@vernier/runtime";
import { defaultTools } from "@vernier/tools";
import { describe, expect, it } from "vitest";

/**
 * The acceptance test for M1: a whole task, end to end, with no network. The faux
 * model's response factory hands us the transcript the harness actually sent, which
 * is the only way to assert on context assembly rather than on its side effects.
 */
describe("read a file and answer, offline", () => {
	it("sends two requests, runs one tool, and pairs the result with the call", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "vernier-e2e-"));
		await writeFile(join(cwd, "README.md"), "# Vernier\n\nA harness that measures its own mechanisms.\n");

		const sent: PiMessage[][] = [];
		const record = (context: TranscriptContext) => {
			sent.push([...context.messages]);
		};

		const model = createFauxModel([
			(context) => {
				record(context);
				return fauxAssistantMessage([
					fauxText("Let me read it."),
					fauxToolCall("read", { path: "README.md" }, { id: "call_1" }),
				]);
			},
			(context) => {
				record(context);
				return fauxAssistantMessage("It is a harness that measures its own mechanisms.");
			},
		]);

		const events: string[] = [];
		const result = await run({
			task: "Read README.md and tell me what this project does.",
			cwd,
			model,
			tools: defaultTools(),
			budget: { maxTurns: 10, maxToolCalls: 10, timeoutMs: 10_000 },
			onEvent: (event) => events.push(event.type),
		});

		expect(result.stopReason).toBe("done");
		expect(result.text).toBe("It is a harness that measures its own mechanisms.");
		expect(result.spent.turns).toBe(2);
		expect(result.spent.toolCalls).toBe(1);
		expect(sent).toHaveLength(2);

		// First request: system prompt plus the task, and nothing else.
		expect(sent[0]?.map((m) => m.role)).toEqual(["system", "user"]);

		// Second request: the assistant's tool call and its result, paired by id, with the
		// file's real contents -- proof the tool ran and its output reached the model.
		const second = sent[1] ?? [];
		expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult"]);
		const toolResult = second[3];
		if (toolResult?.role !== "toolResult") throw new Error("expected a toolResult message");
		expect(toolResult.toolCallId).toBe("call_1");
		expect(toolResult.toolName).toBe("read");
		expect(toolResult.isError).toBe(false);
		expect(JSON.stringify(toolResult.content)).toContain("measures its own mechanisms");

		expect(events.filter((type) => type === "request")).toHaveLength(2);
	});

	it("carries the provider's own assistant message back verbatim", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "vernier-raw-"));
		const sent: PiMessage[][] = [];

		const model = createFauxModel([
			(context) => {
				sent.push([...context.messages]);
				return fauxAssistantMessage([fauxText("one"), fauxToolCall("bash", { command: "true" }, { id: "c1" })]);
			},
			(context) => {
				sent.push([...context.messages]);
				return fauxAssistantMessage("two");
			},
		]);

		await run({
			task: "run something",
			cwd,
			model,
			tools: defaultTools(),
			budget: { maxTurns: 5, maxToolCalls: 5, timeoutMs: 10_000 },
		});

		// Rebuilding this message from text would drop provider-only fields -- on
		// deepseek-flash that means reasoning_content, which it requires on replay.
		const assistant = sent[1]?.[2];
		if (assistant?.role !== "assistant") throw new Error("expected an assistant message");
		expect(assistant.provider).toBe("faux");
		expect(assistant.usage).toBeDefined();
		expect(assistant.content.some((block) => block.type === "toolCall")).toBe(true);
	});
});
