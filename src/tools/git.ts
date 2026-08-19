import path from "node:path";
import type { ToolInteraction } from "./files.ts";
import { relativeDisplayPath, resolveProjectPath } from "./path-security.ts";
import { SHELL_TIMEOUT_MS, withTimeout } from "../utils/timeout.ts";

const MAX_GIT_OUTPUT = 30_000;
const SECRET_PATHSPECS = [
  ":(exclude).env",
  ":(exclude)**/.env",
  ":(exclude).env.*",
  ":(exclude)**/.env.*",
  ":(exclude)*.pem",
  ":(exclude)**/*.pem",
  ":(exclude)*.key",
  ":(exclude)**/*.key",
  ":(exclude)*.p12",
  ":(exclude)**/*.p12",
  ":(exclude)*.pfx",
  ":(exclude)**/*.pfx",
  ":(exclude).npmrc",
  ":(exclude)**/.npmrc",
  ":(exclude).pypirc",
  ":(exclude)**/.pypirc",
  ":(exclude)credentials.json",
  ":(exclude)**/credentials.json",
  ":(exclude)service-account*.json",
  ":(exclude)**/service-account*.json",
  ":(exclude)id_rsa",
  ":(exclude)**/id_rsa",
  ":(exclude)id_dsa",
  ":(exclude)**/id_dsa",
  ":(exclude)id_ecdsa",
  ":(exclude)**/id_ecdsa",
  ":(exclude)id_ed25519",
  ":(exclude)**/id_ed25519",
];

function truncate(value: string): string {
  return value.length <= MAX_GIT_OUTPUT
    ? value
    : `${value.slice(0, MAX_GIT_OUTPUT)}\n... output truncated ...`;
}

async function runGit(
  projectRoot: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return withTimeout(async (timeoutSignal) => {
    const child = Bun.spawn(["git", ...args], {
      cwd: path.resolve(projectRoot),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const abort = () => child.kill();
    timeoutSignal.addEventListener("abort", abort, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (timeoutSignal.aborted) {
        throw new Error(signal?.aborted ? "Operation cancelled." : "Git command cancelled.");
      }
      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `git exited with code ${exitCode}.`);
      }
      return truncate(stdout.trimEnd());
    } finally {
      timeoutSignal.removeEventListener("abort", abort);
    }
  }, SHELL_TIMEOUT_MS, "Git command", signal);
}

export async function gitStatus(
  projectRoot: string,
  interaction?: ToolInteraction,
): Promise<string> {
  interaction?.action("Inspecting git status");
  const output = await runGit(
    projectRoot,
    ["status", "--short", "--", ".", ...SECRET_PATHSPECS],
    interaction?.signal,
  );
  return output || "Working tree clean.";
}

export async function gitDiff(
  projectRoot: string,
  interaction?: ToolInteraction,
  requestedPath?: string,
): Promise<string> {
  interaction?.action("Inspecting git diff");
  const args = ["diff", "--no-ext-diff", "--unified=3", "--"];
  let displayPath = ".";
  if (requestedPath) {
    const absolutePath = await resolveProjectPath(projectRoot, requestedPath, {
      allowProjectRoot: true,
      protectSecrets: true,
    });
    displayPath = relativeDisplayPath(projectRoot, absolutePath);
  }
  args.push(displayPath, ...SECRET_PATHSPECS);
  const [status, diff, numstat] = await Promise.all([
    runGit(
      projectRoot,
      ["status", "--short", "--", displayPath, ...SECRET_PATHSPECS],
      interaction?.signal,
    ),
    runGit(projectRoot, args, interaction?.signal),
    runGit(
      projectRoot,
      ["diff", "--numstat", "--", displayPath, ...SECRET_PATHSPECS],
      interaction?.signal,
    ),
  ]);
  if (!status && !diff) {
    return "Working tree clean.";
  }
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n")) {
    const [added, deleted] = line.split("\t");
    if (/^\d+$/.test(added ?? "")) additions += Number(added);
    if (/^\d+$/.test(deleted ?? "")) deletions += Number(deleted);
  }
  const changedFiles = new Set(status.split("\n").filter(Boolean).map((line) => line.slice(3).trim()));
  const summary = `${changedFiles.size} file${changedFiles.size === 1 ? "" : "s"} changed\n+${additions} -${deletions}`;
  return `Summary:\n${summary}\n\n${status ? `Status:\n${status}` : ""}${status && diff ? "\n\n" : ""}${diff ? `Diff:\n${diff}` : ""}`;
}
