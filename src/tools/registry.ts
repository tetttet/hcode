import type { ToolCall, ToolDefinition } from "../openrouter.ts";
import { withTiming } from "../utils/debug.ts";

export interface RegisteredTool {
  definition: ToolDefinition;
  readOnly: boolean;
  cacheable?: boolean;
  invalidatesRepository?: boolean;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

export interface ScheduledToolResult {
  toolCall: ToolCall;
  content: string;
  cached: boolean;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function parseToolArguments(toolCall: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(toolCall.function.arguments) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("arguments must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid arguments for ${toolCall.function.name}: ${detail}`);
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(tools: RegisteredTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: RegisteredTool): void {
    const name = tool.definition.function.name;
    if (this.tools.has(name)) throw new Error(`Tool already registered: ${name}`);
    this.tools.set(name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }
}

export interface ToolSchedulerEvents {
  onStart?(toolCall: ToolCall): void;
  onEnd?(result: ScheduledToolResult): void;
  onMutation?(): void;
}

export class ToolScheduler {
  private readonly cache = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private repositoryRevision = 0;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly events: ToolSchedulerEvents = {},
  ) {}

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.repositoryRevision = 0;
  }

  private async executeOne(toolCall: ToolCall, signal: AbortSignal): Promise<ScheduledToolResult> {
    const tool = this.registry.get(toolCall.function.name);
    if (!tool) {
      return { toolCall, content: `Tool error: Unknown tool: ${toolCall.function.name}`, cached: false };
    }
    this.events.onStart?.(toolCall);
    let result: ScheduledToolResult;
    try {
      if (signal.aborted) throw new Error("Operation cancelled.");
      const args = parseToolArguments(toolCall);
      const key = `${this.repositoryRevision}:${toolCall.function.name}:${JSON.stringify(stableValue(args))}`;
      const cached = tool.cacheable === false ? undefined : this.cache.get(key);
      if (cached !== undefined) {
        result = { toolCall, content: cached, cached: true };
      } else {
        const existing = tool.readOnly ? this.inFlight.get(key) : undefined;
        const execution = existing ?? withTiming(
          toolCall.function.name,
          () => tool.execute(args, signal),
        );
        if (tool.readOnly && !existing) this.inFlight.set(key, execution);
        let content: string;
        try {
          content = await execution;
        } finally {
          if (!existing) this.inFlight.delete(key);
        }
        if (tool.readOnly && tool.cacheable !== false) this.cache.set(key, content);
        result = { toolCall, content, cached: Boolean(existing) };
        if (!tool.readOnly && tool.invalidatesRepository !== false && !/^User declined/.test(content)) {
          this.repositoryRevision += 1;
          this.cache.clear();
          this.events.onMutation?.();
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { toolCall, content: `Tool error: ${message}`, cached: false };
    }
    this.events.onEnd?.(result);
    return result;
  }

  async execute(toolCalls: ToolCall[], signal: AbortSignal): Promise<ScheduledToolResult[]> {
    const results: ScheduledToolResult[] = [];
    let index = 0;
    while (index < toolCalls.length) {
      const current = toolCalls[index];
      if (!current) break;
      const tool = this.registry.get(current.function.name);
      if (!tool?.readOnly) {
        results.push(await this.executeOne(current, signal));
        index += 1;
        continue;
      }
      const group: ToolCall[] = [];
      while (index < toolCalls.length) {
        const next = toolCalls[index];
        if (!next || !this.registry.get(next.function.name)?.readOnly) break;
        group.push(next);
        index += 1;
      }
      results.push(...await Promise.all(group.map((call) => this.executeOne(call, signal))));
    }
    return results;
  }
}
