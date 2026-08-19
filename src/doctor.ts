import { access, chmod, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HcodeConfig } from "./config/store.ts";
import { CONFIG_DIRECTORY, CONFIG_PATH } from "./config/store.ts";
import { OPENROUTER_URL } from "./openrouter.ts";
import { GithubMcpManager } from "./mcp/github.ts";
import { withTimeout } from "./utils/timeout.ts";
import { VERSION } from "./version.ts";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

async function commandVersion(command: string, args = ["--version"]): Promise<string | null> {
  const executable = Bun.which(command);
  if (!executable) return null;
  const child = Bun.spawn([executable, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return exitCode === 0 ? (stdout || stderr).trim().split("\n", 1)[0] ?? command : null;
}

export async function runDoctor(
  projectRoot: string,
  config: HcodeConfig,
  options: {
    checkNetwork?: boolean;
    configPath?: string;
    baseDirectory?: string;
    fetchImpl?: typeof fetch;
    githubManager?: GithubMcpManager;
  } = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    { name: "hcode", status: "ok", detail: VERSION },
    { name: "Platform", status: "ok", detail: `${os.platform()} ${os.arch()}` },
  ];
  const [git, ripgrep] = await Promise.all([commandVersion("git"), commandVersion("rg")]);
  checks.push(git
    ? { name: "Git", status: "ok", detail: git.replace(/^git version\s*/i, "") }
    : { name: "Git", status: "error", detail: "not found", fix: "Install Git and ensure it is in PATH." });
  checks.push(ripgrep
    ? { name: "ripgrep", status: "ok", detail: ripgrep.replace(/^ripgrep\s*/i, "") }
    : { name: "ripgrep", status: "warning", detail: "not found (slower fallback active)", fix: "Install ripgrep for faster search." });
  checks.push({
    name: "Bun",
    status: process.versions.bun ? "ok" : "warning",
    detail: process.versions.bun ?? "compiled runtime",
  });

  const configPath = options.configPath ?? CONFIG_PATH;
  try {
    const mode = (await stat(configPath)).mode & 0o777;
    const safe = (mode & 0o077) === 0;
    checks.push({
      name: "Config permissions",
      status: safe ? "ok" : "error",
      detail: mode.toString(8).padStart(4, "0"),
      ...(!safe ? { fix: `Run: chmod 600 ${configPath}` } : {}),
    });
  } catch (error) {
    checks.push((error as NodeJS.ErrnoException).code === "ENOENT"
      ? { name: "Config permissions", status: "warning", detail: "config not created yet" }
      : { name: "Config permissions", status: "error", detail: "cannot inspect config" });
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim() ||
    (typeof config.openRouterApiKey === "string" ? config.openRouterApiKey.trim() : "");
  checks.push(apiKey
    ? { name: "OpenRouter API key", status: "ok", detail: "configured" }
    : { name: "OpenRouter API key", status: "error", detail: "not configured", fix: "Set OPENROUTER_API_KEY or start hcode interactively." });

  const baseDirectory = options.baseDirectory ?? CONFIG_DIRECTORY;
  const sessionDirectory = path.join(baseDirectory, "sessions");
  const cacheDirectory = path.join(baseDirectory, "cache");
  for (const [name, directory] of [["Session directory", sessionDirectory], ["Cache directory", cacheDirectory]] as const) {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform === "darwin" || process.platform === "linux") await chmod(directory, 0o700);
      await access(directory, constants.R_OK | constants.W_OK);
      checks.push({ name, status: "ok", detail: directory });
    } catch {
      checks.push({ name, status: "error", detail: directory, fix: "Ensure the directory is writable by the current user." });
    }
  }
  try {
    await access(path.resolve(projectRoot), constants.R_OK | constants.W_OK);
    checks.push({ name: "Project permissions", status: "ok", detail: "read/write" });
  } catch {
    checks.push({ name: "Project permissions", status: "error", detail: "not writable", fix: "Choose a writable project or fix its permissions." });
  }

  const ownsGithubManager = !options.githubManager;
  const github = options.githubManager ?? new GithubMcpManager({
    projectRoot,
    config: config.github,
    binDirectory: path.join(baseDirectory, "bin"),
    confirm: async () => false,
  });
  try {
    let githubStatus = await github.status();
    checks.push(githubStatus.configured
      ? { name: "GitHub MCP / GITHUB_TOKEN", status: "ok", detail: "configured" }
      : {
          name: "GitHub MCP / GITHUB_TOKEN",
          status: "warning",
          detail: "not configured (optional)",
          fix: 'Set GITHUB_TOKEN to enable the optional GitHub integration.',
        });
    if (githubStatus.configured) {
      checks.push(githubStatus.serverAvailable
        ? { name: "GitHub MCP / server", status: "ok", detail: githubStatus.serverSource ?? "available" }
        : {
            name: "GitHub MCP / server",
            status: "warning",
            detail: "not installed",
            fix: "Run hcode and use /github status to install the official server.",
          });
      if (githubStatus.serverAvailable) {
        githubStatus = await github.status({ probe: true });
        checks.push(githubStatus.state === "connected"
          ? { name: "GitHub MCP / protocol", status: "ok", detail: "connected" }
          : {
              name: "GitHub MCP / protocol",
              status: "warning",
              detail: githubStatus.error ?? githubStatus.state,
            });
        checks.push(githubStatus.authenticated === true
          ? { name: "GitHub MCP / authentication", status: "ok", detail: "verified" }
          : {
              name: "GitHub MCP / authentication",
              status: "warning",
              detail: githubStatus.authenticated === false ? "failed" : "not verified",
            });
      }
    }
  } finally {
    if (ownsGithubManager) await github.close();
  }

  if (options.checkNetwork !== false) {
    try {
      const fetchImpl = options.fetchImpl ?? fetch;
      const response = await withTimeout(
        (signal) => fetchImpl(OPENROUTER_URL.replace(/\/chat\/completions$/, "/models"), {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          signal,
        }),
        5_000,
        "OpenRouter connectivity check",
      );
      checks.push(response.ok
        ? { name: "OpenRouter network", status: "ok", detail: `HTTP ${response.status}` }
        : { name: "OpenRouter network", status: "error", detail: `HTTP ${response.status}`, fix: "Check the API key, network, and OpenRouter status." });
    } catch (error) {
      checks.push({
        name: "OpenRouter network",
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
        fix: "Check internet access, proxy settings, and OpenRouter availability.",
      });
    }
  }

  return { ok: checks.every((check) => check.status !== "error"), checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  return report.checks.map((check) => {
    const symbol = check.status === "ok" ? "✓" : check.status === "warning" ? "!" : "✗";
    return `${symbol} ${check.name}: ${check.detail}${check.fix ? `\n  Fix: ${check.fix}` : ""}`;
  }).join("\n");
}
