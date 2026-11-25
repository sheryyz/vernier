import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { PiAiModelService } from "./model.ts";

export { fauxAssistantMessage, fauxText, fauxToolCall };

/**
 * A scripted model. Every test in this repo runs against this and never the network:
 * free, instant, and the only way to assert on what the harness actually sent.
 */
export function createFauxModel(script: readonly FauxResponseStep[]): PiAiModelService {
	const handle = fauxProvider();
	handle.setResponses([...script]);
	const models = createModels();
	models.setProvider(handle.provider);
	return new PiAiModelService({ models, model: handle.getModel() });
}
