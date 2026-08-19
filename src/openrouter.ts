import { FALLBACK_MODEL } from "./config/models.ts";
import { OPENROUTER_TIMEOUT_MS, withTimeout } from "./utils/timeout.ts";
import { withRetry } from "./utils/retry.ts";
import { withTiming } from "./utils/debug.ts";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: ChatMessage;
  }>;
  error?: {
    message?: string;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

function isRetryableStatus(status: number, model: string): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 ||
    status >= 500 || (model === "openrouter/free" && status === 404);
}

export async function createChatCompletion(options: {
  apiKey: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  retryAttempts?: number;
  retryBaseDelayMs?: number;
  onUsage?(usage: ProviderUsage): void;
  fetchImpl?: FetchLike;
}): Promise<ChatMessage> {
  const model = options.model ?? FALLBACK_MODEL;
  return withRetry(async () => withTiming("OpenRouter", async () => {
    let response: Response;
    try {
      response = await withTimeout(
        (signal) => (options.fetchImpl ?? fetch)(OPENROUTER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: options.messages,
            tools: options.tools,
            tool_choice: "auto",
          }),
          signal,
        }),
        options.timeoutMs ?? OPENROUTER_TIMEOUT_MS,
        "OpenRouter request",
        options.signal,
      );
    } catch (error) {
      if (options.signal?.aborted) throw new Error("Operation cancelled.");
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenRouterError(`Could not connect to OpenRouter: ${message}`, undefined, true);
    }

    const rawBody = await response.text();
    let body: OpenRouterResponse;
    try {
      body = JSON.parse(rawBody) as OpenRouterResponse;
    } catch {
      throw new OpenRouterError(
        `OpenRouter returned an invalid response (HTTP ${response.status}).`,
        response.status,
        response.status >= 500,
      );
    }
    if (!response.ok) {
      const detail = body.error?.message ?? rawBody.slice(0, 500);
      throw new OpenRouterError(
        `OpenRouter error (HTTP ${response.status}): ${detail}`,
        response.status,
        isRetryableStatus(response.status, model),
      );
    }
    const message = body.choices?.[0]?.message;
    if (!message || message.role !== "assistant") {
      throw new OpenRouterError("OpenRouter returned no assistant message.", response.status, true);
    }
    if (body.usage) {
      options.onUsage?.({
        promptTokens: body.usage.prompt_tokens ?? 0,
        completionTokens: body.usage.completion_tokens ?? 0,
        totalTokens: body.usage.total_tokens ??
          (body.usage.prompt_tokens ?? 0) + (body.usage.completion_tokens ?? 0),
        ...(typeof body.usage.cost === "number" ? { cost: body.usage.cost } : {}),
      });
    }
    return {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : null,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    };
  }), {
    attempts: options.retryAttempts ?? 2,
    baseDelayMs: options.retryBaseDelayMs ?? 300,
    maxDelayMs: 1_500,
    signal: options.signal,
    shouldRetry: (error) => error instanceof OpenRouterError && error.retryable,
  });
}
