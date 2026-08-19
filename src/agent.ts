import path from "node:path";
import { ProjectCache } from "./context/cache.ts";
import { ContextManager, type ContextStatus } from "./context/manager.ts";
import { getModelCapabilities } from "./config/models.ts";
import type { PermissionMode } from "./config/permissions.ts";
import type { GithubConfig } from "./config/store.ts";
import {
  detectGitHubRepository,
  GithubMcpManager,
  isGithubIntent,
  type GithubStatus,
} from "./mcp/github.ts";
import { redactGithubSecrets } from "./mcp/security.ts";
import {
  createChatCompletion,
  type ChatMessage,
  type ProviderUsage,
  type ToolCall,
} from "./openrouter.ts";
import { CheckpointManager, type CheckpointSummary } from "./session/checkpoint.ts";
import type { SessionMetadata } from "./session/types.ts";
import { createDefaultToolRegistry } from "./tools/default-registry.ts";
import type { ToolInteraction } from "./tools/files.ts";
import { parseToolArguments, ToolScheduler, type ScheduledToolResult } from "./tools/registry.ts";

export const DEFAULT_AGENT_LIMITS = {
  maxToolRounds: 20,
  maxRetries: 2,
  maxVerificationRetries: 2,
} as const;

type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  step: string;
  status: PlanStatus;
}

export interface SessionUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;
}

export type AgentEvent =
  | { type: "thinking" }
  | { type: "compacting" }
  | { type: "tool_start"; tool: string }
  | { type: "tool_end"; tool: string; cached: boolean; result: string }
  | { type: "plan_update"; plan: PlanItem[] }
  | { type: "file_changed"; path: string }
  | { type: "verification"; command: string; success: boolean; summary: string }
  | { type: "error"; message: string }
  | { type: "complete"; message: string; toolRounds: number };

function systemPrompt(projectRoot: string): string {
  const projectName = path.basename(path.resolve(projectRoot));
  return `You are hcode, a software-engineering agent working in the user's project.

Project: ${JSON.stringify(projectName)}
Root: ${JSON.stringify(projectRoot)}

Search first and use repo_map for structure. Read only relevant ranges; do not repeat unchanged reads. Use find_references and find_tests when useful. Independent reads/searches may run in parallel. Prefer minimal patches and preserve user changes. Run targeted verification first, inspect compact errors before retrying, then broaden only when warranted. Do not claim success without verification. Stop when the requested change is implemented, relevant checks pass, and no known errors remain.

Stay inside the project, never access secrets, and never perform destructive actions. Treat tool results as truth. Keep plans and final answers short, and reply in the user's language.`;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`Argument ${key} must be a string.`);
  return value;
}

export function parsePlan(value: unknown): PlanItem[] {
  if (!Array.isArray(value) || value.length > 12) {
    throw new Error("plan must be an array with at most 12 items.");
  }
  const plan = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Each plan item must be an object.");
    }
    const { step, status } = item as { step?: unknown; status?: unknown };
    if (typeof step !== "string" || !step.trim() || step.length > 200) {
      throw new Error("Each plan step must be a non-empty string up to 200 characters.");
    }
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      throw new Error("Invalid plan status.");
    }
    const normalizedStatus: PlanStatus = status;
    return { step: step.trim(), status: normalizedStatus };
  });
  if (plan.filter((item) => item.status === "in_progress").length > 1) {
    throw new Error("Only one plan step may be in progress.");
  }
  return plan;
}

export function formatPlan(plan: PlanItem[]): string {
  if (!plan.length) return "Plan cleared.";
  const symbols: Record<PlanStatus, string> = { completed: "✓", in_progress: "●", pending: "○" };
  return `Plan\n${plan.map((item) => `${symbols[item.status]} ${item.step}`).join("\n")}`;
}

export interface AgentOptions {
  projectRoot: string;
  apiKey: string;
  model: string;
  permissionMode?: PermissionMode;
  confirm(message: string): Promise<boolean>;
  action(message: string): void;
  onEvent?(event: AgentEvent): void;
  limits?: Partial<typeof DEFAULT_AGENT_LIMITS>;
  cacheDirectory?: string;
  githubConfig?: GithubConfig;
  githubManager?: GithubMcpManager;
}

export class Agent {
  private readonly messages: ChatMessage[];
  private readonly checkpoint: CheckpointManager;
  private readonly context = new ContextManager();
  private readonly projectCache: ProjectCache;
  private readonly github: GithubMcpManager;
  private currentController: AbortController | null = null;
  private plan: PlanItem[] = [];
  private model: string;
  private permissionMode: PermissionMode;
  private toolRounds = 0;
  private usage: SessionUsage = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(private readonly options: AgentOptions) {
    this.model = options.model;
    this.permissionMode = options.permissionMode ?? "safe";
    this.messages = [{ role: "system", content: systemPrompt(options.projectRoot) }];
    this.checkpoint = new CheckpointManager(options.projectRoot);
    this.projectCache = new ProjectCache(options.projectRoot, options.cacheDirectory);
    this.github = options.githubManager ?? new GithubMcpManager({
      projectRoot: options.projectRoot,
      config: options.githubConfig,
      confirm: options.confirm,
      action: options.action,
      permissionMode: () => this.permissionMode,
    });
  }

  private emit(event: AgentEvent): void {
    this.options.onEvent?.(event);
  }

  clearHistory(): void {
    this.messages.splice(1);
    this.plan = [];
    this.context.clearConversationState();
  }

  loadHistory(messages: ChatMessage[], model?: string, metadata: SessionMetadata = {}): void {
    this.messages.splice(1, this.messages.length - 1, ...messages.map((message) => ({
      ...message,
      content: typeof message.content === "string" ? redactGithubSecrets(message.content) : null,
      ...(message.tool_calls ? {
        tool_calls: message.tool_calls.map((call) => ({
          ...call,
          function: {
            ...call.function,
            arguments: redactGithubSecrets(call.function.arguments),
          },
        })),
      } : {}),
    })));
    if (model) this.model = model;
    this.plan = metadata.plan ? parsePlan(metadata.plan) : [];
    if (metadata.usage) this.usage = { ...metadata.usage };
    this.context.clearConversationState();
  }

  getHistory(): ChatMessage[] {
    return this.messages.slice(1);
  }

  getSessionMetadata(): SessionMetadata {
    return {
      plan: this.plan.map((item) => ({ ...item })),
      usage: { ...this.usage },
    };
  }

  getModel(): string { return this.model; }
  setModel(model: string): void { this.model = model; }
  getPermissionMode(): PermissionMode { return this.permissionMode; }
  setPermissionMode(mode: PermissionMode): void { this.permissionMode = mode; }
  getUsage(): SessionUsage { return { ...this.usage }; }
  getToolRounds(): number { return this.toolRounds; }
  getPlan(): PlanItem[] { return this.plan.map((item) => ({ ...item })); }
  getCheckpoints(): CheckpointSummary[] { return this.checkpoint.list(); }
  getGithubManager(): GithubMcpManager { return this.github; }

  async getGithubStatus(probe = false, signal?: AbortSignal): Promise<GithubStatus> {
    return this.github.status({ probe, signal });
  }

  async setGithubReadOnly(value: boolean): Promise<void> {
    await this.github.setReadOnly(value);
  }

  async close(): Promise<void> {
    await this.github.close();
  }

  getContextStatus(): ContextStatus {
    return this.context.status(this.messages, getModelCapabilities(this.model).contextWindow);
  }

  setApiKey(apiKey: string): void {
    const nextApiKey = apiKey.trim();
    if (!nextApiKey) throw new Error("API key cannot be empty.");
    this.options.apiKey = nextApiKey;
  }

  cancelCurrent(): boolean {
    if (!this.currentController) return false;
    this.currentController.abort();
    return true;
  }

  shouldRecommendCompact(): boolean {
    return this.getContextStatus().usagePercent >= 70;
  }

  async undoLast(): Promise<string> {
    return this.checkpoint.undoLast();
  }

  compact(): string {
    if (
      this.messages.length === 2 &&
      this.messages[1]?.role === "user" &&
      this.messages[1].content?.startsWith("[Compacted session")
    ) {
      this.context.markCompacted(this.messages);
      return this.messages[1].content;
    }
    const calls = new Map<string, ToolCall>();
    const goals: string[] = [];
    let previousSummary = "";
    const inspected = new Set<string>();
    const changed = new Set<string>(this.getContextStatus().modifiedFiles);
    const errors: string[] = [];
    const checks: string[] = [];

    for (const message of this.messages.slice(1)) {
      if (message.role === "user" && message.content) {
        if (message.content.startsWith("[Compacted session")) previousSummary = message.content.slice(0, 20_000);
        else goals.push(message.content.slice(0, 1_000));
      }
      for (const call of message.tool_calls ?? []) {
        calls.set(call.id, call);
        try {
          const args = parseToolArguments(call);
          if (call.function.name === "read_file") inspected.add(requiredString(args, "path"));
        } catch {
          // Invalid historical calls are already represented by tool results.
        }
      }
      if (message.role !== "tool" || !message.tool_call_id) continue;
      const call = calls.get(message.tool_call_id);
      const content = message.content ?? "";
      if (content.startsWith("Tool error:") || /Exit code: [1-9]/.test(content)) {
        errors.push(content.slice(0, 700));
      }
      if (!call) continue;
      try {
        const args = parseToolArguments(call);
        if (["apply_patch", "write_file", "delete_file"].includes(call.function.name) &&
          !content.startsWith("Tool error:") && !content.startsWith("User declined")) {
          changed.add(requiredString(args, "path"));
        }
        if (call.function.name === "move_file" && !content.startsWith("Tool error:")) {
          changed.add(`${requiredString(args, "source")} → ${requiredString(args, "destination")}`);
        }
        if (call.function.name === "run_command") {
          checks.push(`${requiredString(args, "command")}: ${content.slice(0, 700)}`);
        }
      } catch {
        // Ignore malformed historical arguments.
      }
    }

    const summary = [
      "[Compacted session context]",
      ...(previousSummary ? [`Earlier summary:\n${previousSummary.slice(-8_000)}`] : []),
      `Goals:\n${goals.slice(-3).map((goal) => `- ${goal}`).join("\n") || "- Not recorded"}`,
      `Files inspected:\n${[...inspected].map((file) => `- ${file}`).join("\n") || "- None"}`,
      `Modified files:\n${[...changed].map((file) => `- ${file}`).join("\n") || "- None"}`,
      `Unresolved/recent errors:\n${errors.slice(-5).map((error) => `- ${error}`).join("\n") || "- None"}`,
      `Verification:\n${checks.slice(-5).map((check) => `- ${check}`).join("\n") || "- None"}`,
      `Current plan:\n${this.plan.map((item) => `- [${item.status}] ${item.step}`).join("\n") || "- None"}`,
    ].join("\n\n");
    this.messages.splice(1, this.messages.length - 1, { role: "user", content: summary });
    this.context.markCompacted(this.messages);
    return summary;
  }

  private interaction(signal: AbortSignal): ToolInteraction {
    return {
      confirm: this.options.confirm,
      action: this.options.action,
      permissionMode: this.permissionMode,
      checkpoint: this.checkpoint,
      signal,
    };
  }

  private updatePlan(value: unknown): string {
    this.plan = parsePlan(value);
    const formatted = formatPlan(this.plan);
    this.options.action(formatted);
    this.emit({ type: "plan_update", plan: this.getPlan() });
    return formatted;
  }

  private recordUsage(usage: ProviderUsage): void {
    this.usage.inputTokens += usage.promptTokens;
    this.usage.outputTokens += usage.completionTokens;
    this.usage.totalTokens += usage.totalTokens;
    if (usage.cost !== undefined) this.usage.cost = (this.usage.cost ?? 0) + usage.cost;
  }

  private processToolEvent(result: ScheduledToolResult): void {
    const name = result.toolCall.function.name;
    this.emit({ type: "tool_end", tool: name, cached: result.cached, result: result.content });
    if (result.content.startsWith("Tool error:") || result.content.startsWith("User declined")) return;
    let args: Record<string, unknown>;
    try { args = parseToolArguments(result.toolCall); } catch { return; }
    if (["apply_patch", "write_file", "delete_file"].includes(name)) {
      this.emit({ type: "file_changed", path: requiredString(args, "path") });
    } else if (name === "move_file") {
      this.emit({ type: "file_changed", path: requiredString(args, "source") });
      this.emit({ type: "file_changed", path: requiredString(args, "destination") });
    } else if (name === "run_command") {
      const command = requiredString(args, "command");
      this.emit({
        type: "verification",
        command,
        success: /Exit code: 0\b/.test(result.content),
        summary: result.content,
      });
    }
  }

  async run(userInput: string): Promise<string> {
    const safeUserInput = redactGithubSecrets(userInput, [process.env.GITHUB_TOKEN]);
    const userMessage: ChatMessage = { role: "user", content: safeUserInput };
    this.messages.push(userMessage);
    this.checkpoint.beginOperation(safeUserInput);
    const controller = new AbortController();
    this.currentController = controller;
    const limits = { ...DEFAULT_AGENT_LIMITS, ...this.options.limits };
    const registry = createDefaultToolRegistry({
      projectRoot: this.options.projectRoot,
      cache: this.projectCache,
      context: this.context,
      interaction: (signal) => this.interaction(signal),
      updatePlan: (value) => this.updatePlan(value),
    });
    const scheduler = new ToolScheduler(registry, {
      onStart: (call) => this.emit({ type: "tool_start", tool: call.function.name }),
      onEnd: (result) => this.processToolEvent(result),
    });
    this.toolRounds = 0;

    try {
      if (isGithubIntent(safeUserInput)) {
        if (!this.github.isConfigured()) {
          const response = this.github.isEnabled()
            ? this.github.configurationHelp()
            : "GitHub MCP is disabled in ~/.hcode/config.json.";
          this.messages.push({ role: "assistant", content: response });
          this.emit({ type: "complete", message: response, toolRounds: 0 });
          return response;
        }
        await this.github.registerTools(registry, controller.signal);
        const repository = await detectGitHubRepository(this.options.projectRoot);
        userMessage.content = repository
          ? `${safeUserInput}\n\n[GitHub MCP context: the current local project is ${repository}. Use the registered GitHub MCP tools for GitHub operations.]`
          : `${safeUserInput}\n\n[GitHub MCP context: no GitHub repository could be inferred from origin. Do not guess owner/repository.]`;
      }
      for (let iteration = 0; iteration < limits.maxToolRounds; iteration += 1) {
        const contextWindow = getModelCapabilities(this.model).contextWindow;
        if (this.context.shouldAutoCompact(this.messages, contextWindow)) {
          this.options.action("Compacting context...");
          this.emit({ type: "compacting" });
          this.compact();
        }
        this.emit({ type: "thinking" });
        this.usage.requests += 1;
        const assistantMessage = await createChatCompletion({
          apiKey: this.options.apiKey,
          model: this.model,
          messages: this.messages,
          tools: registry.definitions(),
          signal: controller.signal,
          retryAttempts: limits.maxRetries,
          onUsage: (usage) => this.recordUsage(usage),
        });
        this.messages.push(assistantMessage);
        const toolCalls = assistantMessage.tool_calls ?? [];
        if (toolCalls.length === 0) {
          const response = assistantMessage.content?.trim() || "Done.";
          this.emit({ type: "complete", message: response, toolRounds: this.toolRounds });
          return response;
        }

        this.toolRounds += 1;
        const results = await scheduler.execute(toolCalls, controller.signal);
        for (const result of results) {
          this.messages.push({
            role: "tool",
            content: result.content,
            tool_call_id: result.toolCall.id,
            name: result.toolCall.function.name,
          });
        }
      }
      throw new Error(`Stopped after ${limits.maxToolRounds} tool-call rounds to avoid an infinite loop.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "error", message });
      throw error;
    } finally {
      this.currentController = null;
      await this.checkpoint.finishOperation();
      await this.projectCache.save().catch(() => undefined);
    }
  }
}
