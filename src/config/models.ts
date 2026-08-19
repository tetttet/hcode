export const FALLBACK_MODEL = "openrouter/free";

export interface ModelCapabilities {
  id: string;
  contextWindow: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
}

const DEFAULT_CAPABILITIES = {
  contextWindow: 32_000,
  supportsTools: true,
  supportsReasoning: false,
};

const KNOWN_MODELS: Record<string, Omit<ModelCapabilities, "id">> = {
  "openrouter/free": DEFAULT_CAPABILITIES,
};

export function getModelCapabilities(id: string): ModelCapabilities {
  return { id, ...(KNOWN_MODELS[id] ?? DEFAULT_CAPABILITIES) };
}

export function validateModel(value: string): string {
  const model = value.trim();
  if (!model || model.length > 200 || /\s/.test(model) || !model.includes("/")) {
    throw new Error("Model must use the provider/model-name format.");
  }
  return model;
}

export function resolveActiveModel(savedModel?: string): string {
  const environmentModel = process.env.OPENROUTER_MODEL?.trim();
  if (environmentModel) {
    return validateModel(environmentModel);
  }
  if (savedModel?.trim()) {
    return validateModel(savedModel);
  }
  return FALLBACK_MODEL;
}
