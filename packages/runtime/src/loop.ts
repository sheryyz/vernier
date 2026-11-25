import {
	addUsage,
	type Budget,
	emptyUsage,
	type Message,
	type ModelService,
	type SessionState,
	type Spent,
	type ToolCall,
	type ToolService,
	type TraceEvent,
} from "@vernier/kernel";
import { defaultSystemPrompt } from "./prompt.ts";

export type RunStopReason =
	| "done"
	| "budget_turns"
	| "budget_tool_calls"
	| "budget_timeout"
	| "budget_cost"
	| "aborted"
	| "error";

export interface RunOptions {
	task: string;
	cwd: string;
	model: ModelService;
	tools: ToolService;
	budget: Budget;
	system?: string[];
	signal?: AbortSignal;
	onEvent?: (event: TraceEvent) => void;
}

export interface RunResult {
	session: SessionState;
	spent: Spent;
	stopReason: RunStopReason;
	text: string;
	error?: string;
}

/**
 * The loop, M1 shape: one layer, no hooks yet. M3 broadcasts at eight points and moves
 * every mechanism out into plugins; keeping this small now is what makes that cheap.
 */
export async function run(options: RunOptions): Promise<RunResult> {
	const startedAt = Date.now();
	const session: SessionState = {
		id: `run_${startedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
		cwd: options.cwd,
		task: options.task,
		startedAt,
		turn: 0,
		messages: [{ role: "user", content: options.task, meta: { turn: 0, createdAt: startedAt } }],
	};
	const spent: Spent = { turns: 0, toolCalls: 0, elapsedMs: 0, usage: emptyUsage() };
	const system = options.system ?? [defaultSystemPrompt(options.cwd)];

	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error("budget_timeout")), options.budget.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;

	const emit = (type: string, data: Record<string, unknown>): void => {
		options.onEvent?.({ at: Date.now(), sessionId: session.id, turn: session.turn, type, data });
	};
	const settle = (stopReason: RunStopReason, text: string, error?: string): RunResult => {
		clearTimeout(timer);
		spent.elapsedMs = Date.now() - startedAt;
		emit("session_end", { stopReason, ...spent });
		const result: RunResult = { session, spent, stopReason, text };
		if (error) result.error = error;
		return result;
	};

	emit("session_start", { task: options.task, cwd: options.cwd, model: options.model.modelId });

	let lastText = "";
	while (true) {
		if (spent.turns >= options.budget.maxTurns) return settle("budget_turns", lastText);

		session.turn = spent.turns + 1;
		emit("request", { messages: session.messages.length });

		let response: Awaited<ReturnType<ModelService["send"]>>;
		try {
			response = await options.model.send({ system, messages: session.messages, tools: options.tools.specs(), signal });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return settle(deadline.signal.aborted ? "budget_timeout" : "error", lastText, message);
		}

		spent.turns += 1;
		addUsage(spent.usage, response.usage);
		lastText = response.text || lastText;
		emit("response", {
			stopReason: response.stopReason,
			toolCalls: response.toolCalls.length,
			latencyMs: response.latencyMs,
			usage: response.usage,
		});

		const assistant: Message = {
			role: "assistant",
			content: response.text,
			meta: { turn: session.turn, createdAt: Date.now() },
			raw: response.raw,
		};
		if (response.toolCalls.length > 0) assistant.toolCalls = response.toolCalls;
		session.messages.push(assistant);

		if (response.stopReason === "error") return settle("error", lastText, response.errorMessage ?? "model error");
		if (response.stopReason === "aborted") {
			return settle(deadline.signal.aborted ? "budget_timeout" : "aborted", lastText);
		}
		if (response.toolCalls.length === 0) return settle("done", lastText);

		for (const call of response.toolCalls) {
			if (spent.toolCalls >= options.budget.maxToolCalls) return settle("budget_tool_calls", lastText);
			const outcome = await runTool(call, options, session.turn, signal, emit);
			spent.toolCalls += 1;
			session.messages.push(outcome);
		}

		const cap = options.budget.maxCostUsd;
		if (cap !== undefined && spent.usage.costUsd >= cap) return settle("budget_cost", lastText);
		emit("turn_end", { turns: spent.turns, toolCalls: spent.toolCalls, costUsd: spent.usage.costUsd });
	}
}

async function runTool(
	call: ToolCall,
	options: RunOptions,
	turn: number,
	signal: AbortSignal,
	emit: (type: string, data: Record<string, unknown>) => void,
): Promise<Message> {
	emit("tool_call", { id: call.id, name: call.name, args: call.args });
	const startedAt = performance.now();
	const result = await options.tools.run(call, { cwd: options.cwd, signal });
	const durationMs = Math.round(performance.now() - startedAt);
	emit("tool_result", { id: call.id, name: call.name, ok: result.ok, durationMs, bytes: result.content.length });
	return {
		role: "tool",
		content: result.content,
		toolResult: result,
		meta: { turn, createdAt: Date.now() },
	};
}
