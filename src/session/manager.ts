import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "../openrouter.ts";
import type { SessionMetadata, StoredSession } from "./types.ts";
import { redactGithubSecrets } from "../mcp/security.ts";

const SESSION_VERSION = 1;

export function projectSessionHash(projectRoot: string): string {
  return createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 24);
}

function redactSecrets(value: string): string {
  return redactGithubSecrets(value, [process.env.GITHUB_TOKEN])
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[REDACTED_OPENROUTER_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_ACCESS_KEY]")
    .replace(/(OPENROUTER_API_KEY\s*=\s*)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: typeof message.content === "string" ? redactSecrets(message.content) : null,
    ...(message.tool_calls
      ? {
          tool_calls: message.tool_calls.map((call) => ({
            ...call,
            function: {
              ...call.function,
              arguments: redactSecrets(call.function.arguments),
            },
          })),
        }
      : {}),
  }));
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const session = value as Partial<StoredSession>;
  return (
    session.version === SESSION_VERSION &&
    typeof session.id === "string" &&
    typeof session.projectHash === "string" &&
    typeof session.projectRoot === "string" &&
    typeof session.model === "string" &&
    typeof session.updatedAt === "string" &&
    Array.isArray(session.messages)
  );
}

export class SessionManager {
  private readonly projectRoot: string;
  private readonly projectHash: string;
  private readonly projectDirectory: string;
  private currentSessionId: string | null = null;

  constructor(
    projectRoot: string,
    sessionsDirectory = path.join(os.homedir(), ".hcode", "sessions"),
  ) {
    this.projectRoot = path.resolve(projectRoot);
    this.projectHash = projectSessionHash(this.projectRoot);
    this.projectDirectory = path.join(sessionsDirectory, this.projectHash);
  }

  startNew(): void {
    this.currentSessionId = `${Date.now()}-${randomUUID()}`;
  }

  async save(
    messages: ChatMessage[],
    model: string,
    metadata: SessionMetadata = {},
  ): Promise<StoredSession> {
    if (!this.currentSessionId) {
      this.startNew();
    }
    const session: StoredSession = {
      version: SESSION_VERSION,
      id: this.currentSessionId as string,
      projectHash: this.projectHash,
      projectRoot: this.projectRoot,
      model,
      updatedAt: new Date().toISOString(),
      messages: sanitizeMessages(messages),
      metadata,
    };

    await mkdir(this.projectDirectory, { recursive: true, mode: 0o700 });
    const sessionPath = path.join(this.projectDirectory, `${session.id}.json`);
    const temporaryPath = `${sessionPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(session)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, sessionPath);
    if (process.platform === "darwin" || process.platform === "linux") {
      await chmod(sessionPath, 0o600);
    }
    return session;
  }

  async loadLatest(): Promise<StoredSession | null> {
    let names: string[];
    try {
      names = (await readdir(this.projectDirectory))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }

    for (const name of names) {
      try {
        const parsed = JSON.parse(
          await readFile(path.join(this.projectDirectory, name), "utf8"),
        ) as unknown;
        if (
          isStoredSession(parsed) &&
          parsed.projectHash === this.projectHash &&
          path.resolve(parsed.projectRoot) === this.projectRoot
        ) {
          this.currentSessionId = parsed.id;
          return parsed;
        }
      } catch {
        // Ignore incomplete or corrupt session files and try the next one.
      }
    }
    return null;
  }
}
