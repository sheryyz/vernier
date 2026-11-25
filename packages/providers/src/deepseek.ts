import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { PiAiModelService } from "./model.ts";

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";

export interface DeepSeekOptions {
	modelId?: string;
	/** Default "low": the cheapest level deepseek-flash actually maps. */
	reasoning?: ThinkingLevel;
	temperature?: number;
}

/** Reads DEEPSEEK_API_KEY from the environment, as pi-ai's provider declares. */
export function createDeepSeekModel(options: DeepSeekOptions = {}): PiAiModelService {
	const modelId = options.modelId ?? DEFAULT_DEEPSEEK_MODEL;
	const models = createModels();
	models.setProvider(deepseekProvider());
	const model = models.getModel("deepseek", modelId);
	if (!model) throw new Error(`unknown deepseek model: ${modelId}`);
	return new PiAiModelService({
		models,
		model,
		reasoning: options.reasoning ?? "low",
		...(options.temperature === undefined ? {} : { temperature: options.temperature }),
	});
}
