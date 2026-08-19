import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GithubConfig } from "../config/store.ts";
import { DEFAULT_GITHUB_TOOLSETS } from "../config/store.ts";
import {
  requiresExternalToolConfirmation,
  type PermissionMode,
} from "../config/permissions.ts";
import type { RegisteredTool, ToolRegistry } from "../tools/registry.ts";
import {
  GITHUB_MCP_BINARY,
  GITHUB_RELEASE_API,
  installGithubMcpServer,
  runGithubCommand,
  selectGithubReleaseAssets,
  type GithubInstallOptions,
} from "./github-binary.ts";
import { McpClient, McpProtocolError } from "./client.ts";
import { redactGithubSecrets } from "./security.ts";
import { StdioTransport } from "./stdio.ts";
import type { McpTool, McpToolResult } from "./types.ts";

export const GITHUB_MCP_REPOSITORY = "github/github-mcp-server";
export const GITHUB_DOCKER_IMAGE = "ghcr.io/github/github-mcp-server";
export { GITHUB_RELEASE_API, installGithubMcpServer, selectGithubReleaseAssets };

const MAX_GITHUB_RESULT_CHARS = 24_000;
const MAX_TOOL_DESCRIPTION_CHARS = 700;

export interface GithubServerLaunch {
  command: string;
  args: string[];
  source: "path" | "managed" | "docker" | "custom";
}

export type GithubConnectionState =
  | "not-configured"
  | "disabled"
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface GithubStatus {
  configured: boolean;
  enabled: boolean;
  state: GithubConnectionState;
  serverAvailable: boolean;
  serverSource?: GithubServerLaunch["source"];
  serverInfo?: string;
  authenticated: boolean | null;
  readOnly: boolean;
  toolsets: string[];
  tools: number;
  error?: string;
}

export interface GithubManagerOptions {
  projectRoot: string;
  config?: GithubConfig;
  token?: string;
  binDirectory?: string;
  fetchImpl?: typeof fetch;
  command?: string;
  commandArgs?: string[];
  action?(message: string): void;
  confirm?(message: string): Promise<boolean>;
  permissionMode?(): PermissionMode;
  installBinary?(options: GithubInstallOptions): Promise<string>;
  clientFactory?(launch: GithubServerLaunch, env: NodeJS.ProcessEnv): McpClient;
}

function normalizeToolsets(config?: GithubConfig): string[] {
  const configured = config?.toolsets?.filter((value) => /^[a-z][a-z0-9_]{0,63}$/.test(value));
  return [...new Set(configured?.length ? configured : DEFAULT_GITHUB_TOOLSETS)];
}

export function namespaceGithubToolName(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9_-]/g, "_");
  const candidate = `github_${normalized}`;
  if (candidate.length <= 64) return candidate;
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${candidate.slice(0, 55)}_${digest}`;
}

export function parseGitHubRepositoryUrl(value: string): string | null {
  const input = value.trim();
  const match = input.match(
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

export async function detectGitHubRepository(projectRoot: string): Promise<string | null> {
  try {
    const output = await runGithubCommand("git", ["-C", projectRoot, "remote", "get-url", "origin"], 3_000);
    return parseGitHubRepositoryUrl(output.trim());
  } catch {
    return null;
  }
}

export function isGithubIntent(input: string): boolean {
  return /(?:github|git hub|pull[ -]?request|\bPR\b|issue\s*#\d+|(?:show|list|read|create|comment\s+on)\b.{0,40}\bissues?\b|\b(?:open|closed)\s+issues?\b|(?:покажи|прочитай|создай|прокомментируй|открыт\w*)\b.{0,50}(?:issues?|ишью)|пулл[ -]?реквест|гитхаб)/iu
    .test(input);
}

function isReadOnlyTool(tool: McpTool, configuredReadOnly: boolean): boolean {
  return configuredReadOnly || tool.annotations?.readOnlyHint === true;
}

function isSensitiveTool(tool: McpTool): boolean {
  return /(?:merge|delete|remove|settings?|workflow[_-]?dispatch|force|push|branch[_-]?protection)/i
    .test(tool.name);
}

function confirmationMessage(tool: McpTool, args: Record<string, unknown>): string {
  const lines = [`GitHub: ${tool.title ?? tool.name.replaceAll("_", " ")}`];
  const owner = typeof args.owner === "string" ? args.owner : undefined;
  const repo = typeof args.repo === "string" ? args.repo : undefined;
  const repository = typeof args.repository === "string"
    ? args.repository : owner && repo ? `${owner}/${repo}` : undefined;
  const branch = [args.branch, args.head, args.head_branch].find((value) => typeof value === "string");
  if (repository) lines.push(`Repository: ${redactGithubSecrets(repository)}`);
  if (typeof branch === "string") lines.push(`Branch: ${redactGithubSecrets(branch)}`);
  if (typeof args.title === "string") lines.push(`Title: ${redactGithubSecrets(args.title).slice(0, 300)}`);
  lines.push("", "Proceed? [y/N]");
  return lines.join("\n");
}

function formatMcpResult(tool: McpTool, result: McpToolResult): string {
  const parts: string[] = [];
  for (const content of result.content ?? []) {
    if (content.type === "text" && typeof content.text === "string") parts.push(content.text);
    else parts.push(JSON.stringify(content));
  }
  if (result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  let value = redactGithubSecrets(parts.filter(Boolean).join("\n") || "GitHub MCP returned no content.");
  if (value.length > MAX_GITHUB_RESULT_CHARS) {
    value = `${value.slice(0, MAX_GITHUB_RESULT_CHARS)}\n\n[GitHub result truncated by hcode; request a narrower page or item.]`;
  }
  if (result.isError) {
    throw new McpProtocolError(value);
  }
  return value;
}

function toolGroup(name: string): string {
  if (/pull_request|review/.test(name)) return "Pull Requests";
  if (/issue|sub_issue/.test(name)) return "Issues";
  if (/workflow|action|job|run_/.test(name)) return "Actions";
  if (/user|team|org|me$/.test(name)) return "Users";
  return "Repositories";
}

export class GithubMcpManager {
  private readonly token: string;
  private readonly binDirectory: string;
  private toolsets: string[];
  private readOnly: boolean;
  private enabled: boolean;
  private client: McpClient | null = null;
  private tools: McpTool[] = [];
  private launch: GithubServerLaunch | null = null;
  private state: GithubConnectionState;
  private authenticated: boolean | null = null;
  private lastError: string | undefined;
  private connecting: Promise<void> | null = null;

  constructor(private readonly options: GithubManagerOptions) {
    this.token = (options.token ?? process.env.GITHUB_TOKEN ?? "").trim();
    this.binDirectory = options.binDirectory ?? path.join(os.homedir(), ".hcode", "bin");
    this.toolsets = normalizeToolsets(options.config);
    this.readOnly = options.config?.readOnly === true;
    this.enabled = options.config?.enabled !== false;
    this.state = !this.enabled ? "disabled" : this.token ? "disconnected" : "not-configured";
  }

  isConfigured(): boolean { return this.enabled && Boolean(this.token); }
  isEnabled(): boolean { return this.enabled; }
  getToolsets(): string[] { return [...this.toolsets]; }
  isReadOnly(): boolean { return this.readOnly; }

  async setReadOnly(value: boolean): Promise<void> {
    if (this.readOnly === value) return;
    this.readOnly = value;
    await this.disconnect();
  }

  private nativeArgs(): string[] {
    return [
      "stdio",
      `--toolsets=${this.toolsets.join(",")}`,
      ...(this.readOnly ? ["--read-only"] : []),
    ];
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    env.GITHUB_PERSONAL_ACCESS_TOKEN = this.token;
    return env;
  }

  private async findLaunch(includeDocker = false): Promise<GithubServerLaunch | null> {
    if (this.options.command) {
      return {
        command: this.options.command,
        args: this.options.commandArgs ?? this.nativeArgs(),
        source: "custom",
      };
    }
    const installed = Bun.which(GITHUB_MCP_BINARY);
    if (installed) return { command: installed, args: this.nativeArgs(), source: "path" };
    const managed = path.join(this.binDirectory, GITHUB_MCP_BINARY);
    try {
      await access(managed, constants.X_OK);
      return { command: managed, args: this.nativeArgs(), source: "managed" };
    } catch {
      // Managed binary has not been installed yet.
    }
    if (!includeDocker) return null;
    const docker = Bun.which("docker");
    if (!docker) return null;
    try {
      await runGithubCommand(docker, ["image", "inspect", GITHUB_DOCKER_IMAGE], 3_000);
      return {
        command: docker,
        args: [
          "run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
          GITHUB_DOCKER_IMAGE,
          ...this.nativeArgs(),
        ],
        source: "docker",
      };
    } catch {
      return null;
    }
  }

  private async ensureLaunch(): Promise<GithubServerLaunch> {
    const existing = await this.findLaunch(false);
    if (existing) return existing;
    const confirmed = await (this.options.confirm?.(
      `GitHub MCP server is required.\nInstall official ${GITHUB_MCP_REPOSITORY} locally? [Y/n]`,
    ) ?? Promise.resolve(false));
    if (confirmed) {
      this.options.action?.("Installing GitHub MCP…");
      const install = this.options.installBinary ?? installGithubMcpServer;
      const command = await install({
        binDirectory: this.binDirectory,
        fetchImpl: this.options.fetchImpl,
      });
      return { command, args: this.nativeArgs(), source: "managed" };
    }
    const docker = await this.findLaunch(true);
    if (docker) return docker;
    throw new Error(
      `Official ${GITHUB_MCP_REPOSITORY} is not installed. Run /github status and approve installation.`,
    );
  }

  private createClient(launch: GithubServerLaunch): McpClient {
    const env = this.childEnvironment();
    if (this.options.clientFactory) return this.options.clientFactory(launch, env);
    return new McpClient(new StdioTransport({
      command: launch.command,
      args: launch.args,
      env,
      secrets: [this.token],
    }));
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (!this.enabled) throw new Error("GitHub MCP is disabled in ~/.hcode/config.json.");
    if (!this.token) throw new Error(this.configurationHelp());
    if (this.client && this.state === "connected") return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.state = "connecting";
      this.lastError = undefined;
      this.options.action?.("Connecting to GitHub…");
      try {
        this.launch = await this.ensureLaunch();
        this.client = this.createClient(this.launch);
        await this.client.initialize(signal);
        const listedTools = await this.client.listTools(signal);
        this.tools = this.readOnly
          ? listedTools.filter((tool) => tool.annotations?.readOnlyHint === true)
          : listedTools;
        this.state = "connected";
      } catch (error) {
        await this.client?.close().catch(() => undefined);
        this.client = null;
        this.tools = [];
        this.state = "error";
        this.lastError = redactGithubSecrets(
          error instanceof Error ? error.message : String(error),
          [this.token],
        );
        throw new Error(this.lastError);
      }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async registerTools(registry: ToolRegistry, signal?: AbortSignal): Promise<number> {
    await this.connect(signal);
    for (const tool of this.tools) {
      const definitionName = namespaceGithubToolName(tool.name);
      const readOnly = isReadOnlyTool(tool, this.readOnly);
      const registered: RegisteredTool = {
        definition: {
          type: "function",
          function: {
            name: definitionName,
            description: `[GitHub MCP] ${(tool.description ?? tool.title ?? tool.name).slice(0, MAX_TOOL_DESCRIPTION_CHARS)}`,
            parameters: tool.inputSchema,
          },
        },
        readOnly,
        cacheable: false,
        invalidatesRepository: false,
        execute: async (args, callSignal) => {
          const confirm = requiresExternalToolConfirmation(
            this.options.permissionMode?.() ?? "safe",
            {
              readOnly,
              destructive: tool.annotations?.destructiveHint,
              idempotent: tool.annotations?.idempotentHint,
              sensitive: isSensitiveTool(tool),
            },
          );
          if (confirm && !(await (this.options.confirm?.(confirmationMessage(tool, args)) ?? false))) {
            return `User declined GitHub action: ${tool.name}`;
          }
          this.options.action?.(`${readOnly ? "Reading" : "Updating"} GitHub: ${tool.title ?? tool.name}`);
          return this.call(tool, args, callSignal, readOnly);
        },
      };
      registry.register(registered);
    }
    return this.tools.length;
  }

  private async call(
    tool: McpTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
    safeToRetry: boolean,
  ): Promise<string> {
    try {
      if (!this.client) throw new Error("GitHub MCP is not connected.");
      return formatMcpResult(tool, await this.client.callTool(tool.name, args, signal));
    } catch (error) {
      const message = redactGithubSecrets(error instanceof Error ? error.message : String(error), [this.token]);
      const crashed = /MCP server exited|transport is not running|client closed/i.test(message);
      if (!safeToRetry || !crashed || signal.aborted) {
        if (crashed) {
          await this.disconnect();
          this.lastError = message;
        }
        throw new Error(this.formatToolError(tool, args, message));
      }
      await this.disconnect();
      await this.connect(signal);
      if (!this.client) throw new Error(this.formatToolError(tool, args, message));
      try {
        return formatMcpResult(tool, await this.client.callTool(tool.name, args, signal));
      } catch (retryError) {
        const detail = retryError instanceof Error ? retryError.message : String(retryError);
        throw new Error(this.formatToolError(tool, args, detail));
      }
    }
  }

  private formatToolError(tool: McpTool, args: Record<string, unknown>, detail: string): string {
    const owner = typeof args.owner === "string" ? args.owner : undefined;
    const repo = typeof args.repo === "string" ? args.repo : undefined;
    return redactGithubSecrets([
      "GitHub MCP error",
      "",
      `Tool: ${tool.name}`,
      ...(owner && repo ? [`Repository: ${owner}/${repo}`] : []),
      "",
      detail,
    ].join("\n"), [this.token]);
  }

  async probeAuthentication(signal?: AbortSignal): Promise<boolean> {
    await this.connect(signal);
    const getMe = this.tools.find((tool) => tool.name === "get_me");
    if (!getMe || !this.client) {
      this.authenticated = null;
      return false;
    }
    try {
      const result = await this.client.callTool(getMe.name, {}, signal);
      if (result.isError) throw new Error("GitHub rejected authentication.");
      this.authenticated = true;
      return true;
    } catch (error) {
      this.authenticated = false;
      this.lastError = redactGithubSecrets(error instanceof Error ? error.message : String(error), [this.token]);
      return false;
    }
  }

  async status(options: { probe?: boolean; signal?: AbortSignal } = {}): Promise<GithubStatus> {
    if (options.probe && this.isConfigured()) {
      try {
        await this.probeAuthentication(options.signal);
      } catch {
        // The compact status below contains the safe diagnostic.
      }
    }
    const available = this.launch ?? await this.findLaunch(false);
    return {
      configured: Boolean(this.token),
      enabled: this.enabled,
      state: this.state,
      serverAvailable: Boolean(available),
      ...(available ? { serverSource: available.source } : {}),
      ...(this.client?.getServerInfo()
        ? { serverInfo: `${this.client.getServerInfo()?.name} ${this.client.getServerInfo()?.version}` }
        : {}),
      authenticated: this.authenticated,
      readOnly: this.readOnly,
      toolsets: [...this.toolsets],
      tools: this.tools.length,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  formatTools(): string {
    if (!this.tools.length) return "No GitHub MCP tools loaded.";
    const groups = new Map<string, string[]>();
    for (const tool of this.tools) {
      const group = toolGroup(tool.name);
      groups.set(group, [...(groups.get(group) ?? []), tool.name]);
    }
    return [...groups.entries()].map(([group, names]) =>
      `${group}\n${names.sort().map((name) => `  ${name}`).join("\n")}`
    ).join("\n\n");
  }

  configurationHelp(): string {
    return [
      "GitHub integration requires GITHUB_TOKEN.",
      "",
      "Add it to your shell:",
      "",
      'export GITHUB_TOKEN="..."',
      "",
      "Then restart hcode.",
    ].join("\n");
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.tools = [];
    this.authenticated = null;
    await client?.close().catch(() => undefined);
    this.state = !this.enabled ? "disabled" : this.token ? "disconnected" : "not-configured";
  }

  async close(): Promise<void> {
    await this.disconnect();
  }
}
