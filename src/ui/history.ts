import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { containsGithubToken } from "../mcp/security.ts";

export const HISTORY_PATH = path.join(os.homedir(), ".hcode", "history");
const DEFAULT_HISTORY_LIMIT = 500;

export function isSafeHistoryEntry(value: string): boolean {
  const input = value.trim();
  if (!input || input === "/change" || input.startsWith("/change ")) return false;
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  if (githubToken && input.includes(githubToken)) return false;
  if (/sk-or-v1-[A-Za-z0-9_-]+/i.test(input)) return false;
  if (containsGithubToken(input)) return false;
  if (/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/i.test(input)) return false;
  if (/-----BEGIN [^-]+PRIVATE KEY-----/.test(input)) return false;
  return true;
}

export class PromptHistory {
  private entries: string[] = [];
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly historyPath = HISTORY_PATH,
    private readonly limit = DEFAULT_HISTORY_LIMIT,
  ) {}

  async load(): Promise<string[]> {
    try {
      const lines = (await readFile(this.historyPath, "utf8")).split(/\r?\n/).filter(Boolean);
      this.entries = lines.flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return typeof parsed === "string" && isSafeHistoryEntry(parsed) ? [parsed] : [];
        } catch {
          return isSafeHistoryEntry(line) ? [line] : [];
        }
      }).slice(-this.limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.entries = [];
    }
    return [...this.entries];
  }

  async record(value: string): Promise<void> {
    this.pending = this.pending.then(() => this.recordNow(value));
    return this.pending;
  }

  private async recordNow(value: string): Promise<void> {
    const input = value.trim();
    if (!isSafeHistoryEntry(input)) return;
    if (this.entries.at(-1) !== input) this.entries.push(input);
    this.entries = this.entries.slice(-this.limit);
    const directory = path.dirname(this.historyPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.historyPath}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      `${this.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      { mode: 0o600 },
    );
    await rename(temporaryPath, this.historyPath);
    if (process.platform === "darwin" || process.platform === "linux") {
      await chmod(this.historyPath, 0o600);
    }
  }
}
