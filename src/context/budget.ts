import type { ChatMessage } from "../openrouter.ts";

export function estimateTextTokens(value: string): number {
  if (!value) return 0;
  const ascii = value.replace(/[^\x00-\x7f]/g, "").length;
  const nonAscii = value.length - ascii;
  return Math.ceil(ascii / 4 + nonAscii / 2);
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => {
    const toolArguments = (message.tool_calls ?? []).reduce(
      (sum, call) => sum + estimateTextTokens(call.function.arguments) + 12,
      0,
    );
    return total + 6 + estimateTextTokens(message.content ?? "") + toolArguments;
  }, 0);
}

export interface ContextBudget {
  estimatedTokens: number;
  contextWindow: number;
  usagePercent: number;
  shouldCompact: boolean;
}

export function contextBudget(
  messages: ChatMessage[],
  contextWindow: number,
  compactThreshold = 0.78,
): ContextBudget {
  const estimatedTokens = estimateMessageTokens(messages);
  const safeWindow = Math.max(4_096, contextWindow);
  const usagePercent = Math.min(100, Math.round((estimatedTokens / safeWindow) * 100));
  return {
    estimatedTokens,
    contextWindow: safeWindow,
    usagePercent,
    shouldCompact: estimatedTokens >= safeWindow * compactThreshold,
  };
}

export function omitOldToolOutputs(
  messages: ChatMessage[],
  keepRecentMessages = 10,
): ChatMessage[] {
  const cutoff = Math.max(1, messages.length - keepRecentMessages);
  return messages.map((message, index) => {
    if (index >= cutoff || message.role !== "tool" || !message.content) {
      return message;
    }
    const firstLine = message.content.split("\n", 1)[0]?.slice(0, 200) ?? "completed";
    return {
      ...message,
      content: `[Earlier tool output omitted: ${firstLine}]`,
    };
  });
}
