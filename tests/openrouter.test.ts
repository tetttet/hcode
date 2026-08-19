import { describe, expect, test } from "bun:test";
import { createChatCompletion } from "../src/openrouter.ts";

describe("OpenRouter retry and usage", () => {
  test("retries a temporary provider response and records reported usage", async () => {
    let attempts = 0;
    let recorded: unknown;
    const message = await createChatCompletion({
      apiKey: "test",
      model: "openrouter/free",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      retryAttempts: 2,
      retryBaseDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
          });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "done" } }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cost: 0.001 },
        }), { status: 200 });
      },
      onUsage: (usage) => { recorded = usage; },
    });
    expect(attempts).toBe(2);
    expect(message.content).toBe("done");
    expect(recorded).toEqual({
      promptTokens: 12,
      completionTokens: 3,
      totalTokens: 15,
      cost: 0.001,
    });
  });

  test("does not retry authentication errors", async () => {
    let attempts = 0;
    await expect(createChatCompletion({
      apiKey: "invalid",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      retryAttempts: 3,
      retryBaseDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        return new Response(JSON.stringify({ error: { message: "invalid API key" } }), {
          status: 401,
        });
      },
    })).rejects.toThrow("HTTP 401");
    expect(attempts).toBe(1);
  });
});
