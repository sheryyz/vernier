import type { Api, Context, Model, MutableModels, Tool as PiTool, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRequest, ModelResponse, ModelService } from "@vernier/kernel";
import { type ModelIdentity, textOf, toolCallsOf, toProviderMessages, toStopReason, toUsage } from "./convert.ts";

export interface PiAiModelOptions {
	models: MutableModels;
	model: Model<Api>;
	/**
	 * Fixed for the life of an experiment. deepseek-flash reasons by default, reasoning
	 * tokens bill at the output rate, and their length varies run to run -- left free it
	 * pollutes both the cost column and the variance the ablation is trying to measure.
	 */
	reasoning?: ThinkingLevel;
	temperature?: number;
}

/** The model layer is the one part of the harness borrowed whole from pi. */
export class PiAiModelService implements ModelService {
	readonly name = "model" as const;
	readonly modelId: string;
	private readonly options: PiAiModelOptions;
	private readonly identity: ModelIdentity;

	constructor(options: PiAiModelOptions) {
		this.options = options;
		this.modelId = options.model.id;
		this.identity = { api: options.model.api, provider: options.model.provider, model: options.model.id };
	}

	async send(request: ModelRequest): Promise<ModelResponse> {
		const context: Context = {
			messages: toProviderMessages(request.messages, this.identity),
			tools: request.tools.map((spec) => ({ ...spec }) as PiTool),
		};
		const system = request.system.filter((part) => part.trim().length > 0).join("\n\n");
		if (system) context.systemPrompt = system;

		const startedAt = performance.now();
		const assistant = await this.options.models.completeSimple(this.options.model, context, {
			signal: request.signal,
			...(this.options.reasoning ? { reasoning: this.options.reasoning } : {}),
			...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
		});
		const latencyMs = Math.round(performance.now() - startedAt);

		const response: ModelResponse = {
			text: textOf(assistant),
			toolCalls: toolCallsOf(assistant),
			usage: toUsage(assistant.usage, this.options.model.cost),
			stopReason: toStopReason(assistant.stopReason),
			latencyMs,
			raw: assistant,
		};
		if (assistant.errorMessage) response.errorMessage = assistant.errorMessage;
		return response;
	}
}
