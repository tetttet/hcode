import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PermissionMode } from "./permissions.ts";

export const CONFIG_DIRECTORY = path.join(os.homedir(), ".hcode");
export const CONFIG_PATH = path.join(CONFIG_DIRECTORY, "config.json");

export const DEFAULT_GITHUB_TOOLSETS = ["repos", "issues", "pull_requests", "users"] as const;

export interface GithubConfig {
  enabled?: boolean;
  toolsets?: string[];
  readOnly?: boolean;
}

export interface HcodeConfig extends Record<string, unknown> {
  openRouterApiKey?: string;
  model?: string;
  permissions?: PermissionMode;
  github?: GithubConfig;
}

function sanitizeGithubConfig(value: unknown): GithubConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const github: GithubConfig = {};
  if (typeof input.enabled === "boolean") github.enabled = input.enabled;
  if (typeof input.readOnly === "boolean") github.readOnly = input.readOnly;
  if (Array.isArray(input.toolsets)) {
    const toolsets = input.toolsets.filter((item): item is string =>
      typeof item === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(item)
    ).slice(0, 20);
    if (toolsets.length) github.toolsets = [...new Set(toolsets)];
  }
  return github;
}

function sanitizeConfig(value: HcodeConfig): HcodeConfig {
  const next = { ...value };
  for (const key of Object.keys(next)) {
    if (/^github.*(?:token|secret|password|key)$/i.test(key)) delete next[key];
  }
  if ("github" in next) {
    const github = sanitizeGithubConfig(next.github);
    if (github) next.github = github;
    else delete next.github;
  }
  return next;
}

export async function readConfig(configPath = CONFIG_PATH): Promise<HcodeConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return sanitizeConfig(parsed as HcodeConfig);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return {};
    }
    throw error;
  }
}

export async function updateConfig(
  changes: Partial<HcodeConfig>,
  configPath = CONFIG_PATH,
): Promise<HcodeConfig> {
  const current = await readConfig(configPath);
  const next: HcodeConfig = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  const safeNext = sanitizeConfig(next);

  const directory = path.dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.config-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(safeNext, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, configPath);
  if (process.platform === "darwin" || process.platform === "linux") {
    await chmod(configPath, 0o600);
  }
  return safeNext;
}
