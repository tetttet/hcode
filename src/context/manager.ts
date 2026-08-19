import type { ChatMessage } from "../openrouter.ts";
import { contextBudget, type ContextBudget } from "./budget.ts";

export interface LoadedFileState {
  path: string;
  contentHash: string;
  lastRead: number;
  changedSinceRead: boolean;
  size?: number;
  mtimeMs?: number;
  ranges: string[];
}

export interface ContextStatus extends ContextBudget {
  messages: number;
  filesLoaded: number;
  modifiedFiles: string[];
  repoMapReady: boolean;
}

export class ContextManager {
  private readonly loadedFiles = new Map<string, LoadedFileState>();
  private readonly modifiedFiles = new Set<string>();
  private repoMapReady = false;
  private lastCompactedMessageCount = -1;

  recordRead(
    filePath: string,
    contentHash: string,
    metadata: { size?: number; mtimeMs?: number; range?: string } = {},
  ): void {
    const previous = this.loadedFiles.get(filePath);
    const sameVersion = previous && previous.contentHash === contentHash &&
      previous.size === metadata.size && previous.mtimeMs === metadata.mtimeMs;
    this.loadedFiles.set(filePath, {
      path: filePath,
      contentHash,
      lastRead: Date.now(),
      changedSinceRead: false,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ranges: [
        ...(sameVersion ? previous.ranges : []),
        ...(metadata.range ? [metadata.range] : []),
      ].filter((value, index, values) => values.indexOf(value) === index),
    });
  }

  canReuseRead(filePath: string, size: number, mtimeMs: number, range: string): boolean {
    const loaded = this.loadedFiles.get(filePath);
    return Boolean(
      loaded && !loaded.changedSinceRead && loaded.size === size &&
      loaded.mtimeMs === mtimeMs && loaded.ranges.includes(range),
    );
  }

  recordModified(filePath: string): void {
    this.modifiedFiles.add(filePath);
    const loaded = this.loadedFiles.get(filePath);
    if (loaded) {
      loaded.changedSinceRead = true;
    }
  }

  recordMove(source: string, destination: string): void {
    this.recordModified(source);
    this.recordModified(destination);
  }

  markRepoMapReady(): void {
    this.repoMapReady = true;
  }

  clearConversationState(): void {
    this.loadedFiles.clear();
    this.modifiedFiles.clear();
    this.repoMapReady = false;
    this.lastCompactedMessageCount = -1;
  }

  shouldAutoCompact(messages: ChatMessage[], contextWindow: number): boolean {
    const budget = contextBudget(messages, contextWindow);
    return budget.shouldCompact &&
      messages.length >= 8 &&
      messages.length - this.lastCompactedMessageCount >= 8;
  }

  markCompacted(messages: ChatMessage[]): void {
    this.lastCompactedMessageCount = messages.length;
    this.loadedFiles.clear();
  }

  status(messages: ChatMessage[], contextWindow: number): ContextStatus {
    return {
      ...contextBudget(messages, contextWindow),
      messages: Math.max(0, messages.length - 1),
      filesLoaded: this.loadedFiles.size,
      modifiedFiles: [...this.modifiedFiles].sort(),
      repoMapReady: this.repoMapReady,
    };
  }
}
