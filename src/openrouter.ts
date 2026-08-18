export const DEFAULT_MODEL =
  process.env.OPENROUTER_MODEL?.trim() || "openrouter/free";
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
}

export async function createChatCompletion(options: {
  apiKey: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  model?: string;
}): Promise<ChatMessage> {
  let response: Response;

  try {
    response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model ?? DEFAULT_MODEL,
        messages: options.messages,
        tools: options.tools,
        tool_choice: "auto",
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not connect to OpenRouter: ${message}`);
  }

  const rawBody = await response.text();
  let body: OpenRouterResponse;

  try {
    body = JSON.parse(rawBody) as OpenRouterResponse;
  } catch {
    throw new Error(
      `OpenRouter returned an invalid response (HTTP ${response.status}).`,
    );
  }

  if (!response.ok) {
    const detail = body.error?.message ?? rawBody.slice(0, 500);
    throw new Error(`OpenRouter error (HTTP ${response.status}): ${detail}`);
  }

  const message = body.choices?.[0]?.message;
  if (!message || message.role !== "assistant") {
    throw new Error("OpenRouter returned no assistant message.");
  }

  return {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : null,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  };
}
