import path from "node:path";
import {
  dangerousCommandReason,
  requiresShellConfirmation,
} from "../config/permissions.ts";
import { SHELL_TIMEOUT_MS, withTimeout } from "../utils/timeout.ts";
import type { ToolInteraction } from "./files.ts";
import { reduceCommandOutput } from "./output.ts";

export async function runProjectCommand(
  projectRoot: string,
  command: string,
  interaction: ToolInteraction,
  timeoutMs = SHELL_TIMEOUT_MS,
): Promise<string> {
  if (!command.trim()) {
    throw new Error("A non-empty command is required.");
  }

  const reason = dangerousCommandReason(command);
  if (reason) {
    throw new Error(`Command refused: ${reason}.`);
  }

  if (
    requiresShellConfirmation(interaction.permissionMode ?? "safe", command) &&
    !(await interaction.confirm(`Run: ${command} ? [y/N]`))
  ) {
    return "User declined the command. It was not run.";
  }

  interaction.action(`Running ${command}`);
  return withTimeout(async (signal) => {
    const child = Bun.spawn(["sh", "-lc", command], {
      cwd: path.resolve(projectRoot),
      detached: process.platform !== "win32",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const abort = () => {
      try {
        if (process.platform !== "win32") {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill();
        }
      } catch {
        child.kill();
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (signal.aborted) {
        throw new Error(interaction.signal?.aborted ? "Operation cancelled." : "Command cancelled.");
      }
      const combined = [
        stdout ? `stdout:\n${stdout.trimEnd()}` : "",
        stderr ? `stderr:\n${stderr.trimEnd()}` : "",
      ].filter(Boolean).join("\n");
      return reduceCommandOutput(command, exitCode, combined);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }, timeoutMs, "Shell command", interaction.signal);
}
