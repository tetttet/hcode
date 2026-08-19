import { VERSION } from "../version.ts";
import { withTimeout } from "../utils/timeout.ts";
import { redactGithubSecrets } from "./security.ts";
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcResponse,
  McpInitializeResult,
  McpTool,
  McpToolResult,
  McpTransport,
} from "./types.ts";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const DEFAULT_MCP_TIMEOUTS = {
  startup: 10_000,
  listTools: 10_000,
  callTool: 60_000,
} as const;

export interface McpTimeouts {
  startup: number;
  listTools: number;
  callTool: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class McpProtocolError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(redactGithubSecrets(message));
    this.name = "McpProtocolError";
  }
}

export class McpClient {
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private started = false;
  private initialized = false;
  private serverInfo: McpInitializeResult["serverInfo"] | null = null;

  constructor(
    private readonly transport: McpTransport,
    private readonly timeouts: Partial<McpTimeouts> = {},
  ) {}

  getServerInfo(): McpInitializeResult["serverInfo"] | null {
    return this.serverInfo ? { ...this.serverInfo } : null;
  }

  async initialize(signal?: AbortSignal): Promise<McpInitializeResult> {
    if (this.initialized) {
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        serverInfo: this.serverInfo ?? { name: "unknown", version: "unknown" },
      };
    }
    try {
      if (!this.started) {
        await withTimeout(
          () => this.transport.start(
            (message) => this.receive(message),
            (error) => this.failPending(error),
          ),
          this.timeouts.startup ?? DEFAULT_MCP_TIMEOUTS.startup,
          "MCP startup",
          signal,
        );
        this.started = true;
      }
      const result = await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "hcode", version: VERSION },
      }, this.timeouts.startup ?? DEFAULT_MCP_TIMEOUTS.startup, signal) as McpInitializeResult;
      if (!result || typeof result !== "object" || typeof result.protocolVersion !== "string" ||
        !result.serverInfo || typeof result.serverInfo.name !== "string") {
        throw new McpProtocolError("MCP server returned an invalid initialize result.");
      }
      this.serverInfo = result.serverInfo;
      await this.notify("notifications/initialized");
      this.initialized = true;
      return result;
    } catch (error) {
      this.started = false;
      this.initialized = false;
      await this.transport.close().catch(() => undefined);
      throw error;
    }
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    this.requireInitialized();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.request(
        "tools/list",
        cursor ? { cursor } : {},
        this.timeouts.listTools ?? DEFAULT_MCP_TIMEOUTS.listTools,
        signal,
      ) as { tools?: unknown; nextCursor?: unknown };
      if (!result || !Array.isArray(result.tools)) {
        throw new McpProtocolError("MCP server returned an invalid tools/list result.");
      }
      for (const value of result.tools) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const tool = value as Partial<McpTool>;
        if (typeof tool.name !== "string" || !tool.name || !tool.inputSchema ||
          typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) continue;
        tools.push(tool as McpTool);
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor
        ? result.nextCursor : undefined;
      if (!cursor) return tools;
    }
    throw new McpProtocolError("MCP tools/list exceeded the pagination limit.");
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    this.requireInitialized();
    const result = await this.request(
      "tools/call",
      { name, arguments: args },
      this.timeouts.callTool ?? DEFAULT_MCP_TIMEOUTS.callTool,
      signal,
    );
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new McpProtocolError(`MCP tool ${name} returned an invalid result.`);
    }
    return result as McpToolResult;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("MCP client is not initialized.");
  }

  private receive(message: JsonRpcMessage): void {
    if (!("id" in message)) return;
    if ("method" in message) {
      void this.transport.send({
        jsonrpc: "2.0",
        id: message.id,
        ...(message.method === "ping"
          ? { result: {} }
          : { error: { code: -32601, message: "Client method not supported" } }),
      });
      return;
    }
    const response = message as JsonRpcResponse;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new McpProtocolError(
        `MCP error ${response.error.code}: ${response.error.message}`,
        response.error.code,
        response.error.data,
      ));
    } else {
      pending.resolve(response.result);
    }
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      return await withTimeout(async () => {
        await this.transport.send({ jsonrpc: "2.0", id, method, params });
        return response;
      }, timeoutMs, `MCP ${method}`, signal);
    } catch (error) {
      await this.notify("notifications/cancelled", {
        requestId: id,
        reason: signal?.aborted ? "Operation cancelled" : "Request timed out or failed",
      }).catch(() => undefined);
      throw error;
    } finally {
      this.pending.delete(id);
    }
  }

  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.transport.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  private failPending(error: Error): void {
    const safe = new McpProtocolError(redactGithubSecrets(error.message));
    for (const pending of this.pending.values()) pending.reject(safe);
    this.pending.clear();
    this.started = false;
    this.initialized = false;
  }

  async close(): Promise<void> {
    this.failPending(new Error("MCP client closed."));
    await this.transport.close();
  }
}
