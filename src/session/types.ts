import type { ChatMessage } from "../openrouter.ts";

export interface SessionMetadata {
  compactedAt?: string;
  plan?: Array<{
    step: string;
    status: "pending" | "in_progress" | "completed";
  }>;
  usage?: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost?: number;
  };
}

export interface StoredSession {
  version: 1;
  id: string;
  projectHash: string;
  projectRoot: string;
  model: string;
  updatedAt: string;
  messages: ChatMessage[];
  metadata: SessionMetadata;
}
