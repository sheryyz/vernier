/**
 * The kernel protocol. Everything else in this repo is written against these types.
 *
 * Rule: the kernel knows nothing about any concrete mechanism. No compaction, no
 * memory, no planner appears here -- those are plugins. If a mechanism cannot be
 * expressed through `Hooks`, the hook set is wrong; add a hook, never an `if`.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

export interface ToolError {
	kind: "timeout" | "not_found" | "denied" | "exec_failed" | "invalid_args" | "internal";
	message: string;
	retryable: boolean;
}

export interface ToolResult {
	callId: string;
	ok: boolean;
	/** What the model sees. Already truncated by the time it reaches the request. */
	content: string;
	error?: ToolError;
	/** Set by the hardening plugin when `content` is a shortened view of a larger output. */
	truncated?: { originalBytes: number; keptBytes: number; ref?: string };
}

export interface MessageMeta {
	/** Turn that produced this message. Compaction uses it to decide what is "old". */
	turn: number;
	createdAt: number;
	/** True once a plugin has replaced this message with a summary. */
	compacted?: boolean;
	/** Bytes of the pre-compaction original, for the compaction report. */
	originalBytes?: number;
}

export interface Message {
	role: Role;
	content: string;
	toolCalls?: ToolCall[];
	toolResult?: ToolResult;
	meta?: MessageMeta;
}

/**
 * Token accounting. Cache fields are first-class on purpose: with deepseek-flash a
 * cache read costs 1/50th of a fresh input token, so "fewer tokens" and "less money"
 * are different questions and the report must be able to tell them apart.
 */
export interface Usage {
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheMissTokens: number;
	costUsd: number;
}

export interface Budget {
	maxTurns: number;
	maxToolCalls: number;
	timeoutMs: number;
	maxCostUsd?: number;
}

export interface Spent {
	turns: number;
	toolCalls: number;
	elapsedMs: number;
	usage: Usage;
}

export interface SessionState {
	id: string;
	cwd: string;
	task: string;
	startedAt: number;
	turn: number;
	/** The durable history. What is actually sent lives on `RequestCtx.messages`. */
	messages: Message[];
}

export interface RequestCtx {
	session: SessionState;
	turn: number;
	/** The view that will be sent this turn. Plugins mutate this, never `session.messages`. */
	messages: Message[];
	system: string[];
	signal: AbortSignal;
}

export interface ResponseCtx {
	session: SessionState;
	turn: number;
	text: string;
	toolCalls: ToolCall[];
	usage: Usage;
	latencyMs: number;
}

export type ToolDecision =
	| { action: "allow" }
	| { action: "deny"; reason: string }
	| { action: "rewrite"; args: Record<string, unknown> };

export interface ToolCallCtx {
	session: SessionState;
	call: ToolCall;
	signal: AbortSignal;
}

export interface ToolResultCtx {
	session: SessionState;
	call: ToolCall;
	result: ToolResult;
	durationMs: number;
}

export interface TurnCtx {
	session: SessionState;
	turn: number;
	spent: Spent;
	budget: Budget;
}

export interface AgentError {
	phase: "request" | "tool" | "hook";
	cause: unknown;
	attempt: number;
}

export type ErrorAction = { action: "retry"; delayMs?: number } | { action: "fail" } | { action: "stop" };

/**
 * The eight cut points of the loop. Every mechanism in `packages/plugins` is some
 * subset of these.
 */
export type MaybePromise<T> = T | Promise<T>;

/** A hook that may answer, or may stay out of the way by returning nothing. */
export type HookOutcome<T> = MaybePromise<T | undefined>;

export interface Hooks {
	onSessionStart: (s: SessionState) => MaybePromise<void>;
	beforeRequest: (c: RequestCtx) => MaybePromise<void>;
	afterResponse: (c: ResponseCtx) => MaybePromise<void>;
	beforeToolCall: (c: ToolCallCtx) => HookOutcome<ToolDecision>;
	afterToolCall: (c: ToolResultCtx) => HookOutcome<ToolResult>;
	onTurnEnd: (c: TurnCtx) => MaybePromise<void>;
	onSessionEnd: (s: SessionState) => MaybePromise<void>;
	onError: (e: AgentError) => HookOutcome<ErrorAction>;
}

export type HookName = keyof Hooks;

export interface Service {
	readonly name: string;
	init?(ctx: KernelContext): MaybePromise<void>;
	dispose?(): MaybePromise<void>;
}

export interface KernelContext {
	readonly cwd: string;
	readonly budget: Budget;
	config<T>(key: string, fallback: T): T;
	emit(event: TraceEvent): void;
}

export interface PluginApi {
	on<K extends HookName>(hook: K, fn: Hooks[K], opts?: { order?: number }): void;
	service<T extends Service>(name: string): T;
}

export interface Plugin {
	readonly name: string;
	/** Service names that must be registered before setup. Checked at startup. */
	readonly requires?: readonly string[];
	/** Service names this plugin registers. */
	readonly provides?: readonly string[];
	setup(ctx: KernelContext, api: PluginApi): MaybePromise<void>;
}

/**
 * One trace stream feeds both the web panel and the eval report. Never add a second
 * instrumentation path.
 */
export interface TraceEvent {
	at: number;
	sessionId: string;
	turn: number;
	type: string;
	data: Record<string, unknown>;
}
