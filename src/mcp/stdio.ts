import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonRpcMessage, McpTransport } from "./types.ts";
import { redactGithubSecrets } from "./security.ts";

const DEFAULT_STDERR_LIMIT = 8_192;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stderrLimit?: number;
  secrets?: string[];
}

export class StdioTransport implements McpTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private onMessage: ((message: JsonRpcMessage) => void) | null = null;
  private onClose: ((error: Error) => void) | null = null;

  constructor(private readonly options: StdioTransportOptions) {}

  async start(
    onMessage: (message: JsonRpcMessage) => void,
    onClose: (error: Error) => void,
  ): Promise<void> {
    if (this.child) throw new Error("MCP stdio transport is already running.");
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.closing = false;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.on("data", (chunk: string) => this.captureDiagnostics(chunk));
    child.once("close", (code, signal) => {
      const detail = this.diagnostics();
      const suffix = detail ? `: ${detail}` : "";
      const error = new Error(
        `MCP server exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}${suffix}`,
      );
      this.child = null;
      if (!this.closing) this.onClose?.(error);
    });

    await new Promise<void>((resolve, reject) => {
      const spawned = () => {
        child.removeListener("error", failed);
        resolve();
      };
      const failed = (error: Error) => {
        child.removeListener("spawn", spawned);
        this.child = null;
        reject(new Error(`Could not start MCP server: ${this.clean(error.message)}`));
      };
      child.once("spawn", spawned);
      child.once("error", failed);
    });
    child.on("error", (error) => {
      if (!this.closing) this.onClose?.(new Error(`MCP server process error: ${this.clean(error.message)}`));
    });
  }

  private clean(value: string): string {
    return redactGithubSecrets(value, this.options.secrets);
  }

  private captureDiagnostics(chunk: string): void {
    const limit = Math.max(256, this.options.stderrLimit ?? DEFAULT_STDERR_LIMIT);
    this.stderrBuffer = this.clean(`${this.stderrBuffer}${chunk}`).slice(-limit);
  }

  private receive(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_MESSAGE_BYTES) {
      this.failProtocol("MCP server sent an oversized stdio message.");
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("message is not an object");
        }
        this.onMessage?.(parsed as JsonRpcMessage);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.failProtocol(`Invalid MCP message: ${this.clean(detail)}`);
        return;
      }
    }
  }

  private failProtocol(message: string): void {
    this.onClose?.(new Error(message));
    void this.close();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("MCP stdio transport is not running.");
    const payload = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(payload, (error) => {
        if (error) reject(new Error(`Could not write to MCP server: ${this.clean(error.message)}`));
        else resolve();
      });
    });
  }

  diagnostics(): string {
    return this.clean(this.stderrBuffer).trim().replace(/\s+/g, " ").slice(-2_000);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const child = this.child;
    if (!child) return;
    this.closing = true;
    this.closePromise = (async () => {
      if (child.stdin.writable) child.stdin.end();
      if (await this.waitForExit(child, 500)) return;
      child.kill("SIGTERM");
      if (await this.waitForExit(child, 1_000)) return;
      child.kill("SIGKILL");
      await this.waitForExit(child, 500);
    })().finally(() => {
      this.child = null;
      this.closePromise = null;
    });
    return this.closePromise;
  }

  private async waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        child.removeListener("close", closed);
        resolve(false);
      }, timeoutMs);
      const closed = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      child.once("close", closed);
    });
  }
}
