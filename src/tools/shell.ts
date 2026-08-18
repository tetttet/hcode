import path from "node:path";
import type { ToolInteraction } from "./files.ts";

const MAX_OUTPUT_LENGTH = 30_000;

function dangerousReason(command: string): string | null {
  if (/\b(?:sudo|shutdown|reboot|poweroff|halt)\b/i.test(command)) {
    return "privileged or system shutdown commands are blocked";
  }
  if (/(?:^|[^\w])mkfs(?:\.[\w-]+)?\b/i.test(command)) {
    return "filesystem formatting commands are blocked";
  }

  const rmCommands = command.matchAll(
    /(?:^|[;&|]\s*|\s)(?:[^\s;&|]*\/)?rm\s+([^;&|\n]*)/gi,
  );
  for (const match of rmCommands) {
    const argumentsText = match[1] ?? "";
    const flags = argumentsText.match(/--recursive|--force|-[a-zA-Z]+/g) ?? [];
    const recursive = flags.some(
      (flag) => flag === "--recursive" || flag.slice(1).toLowerCase().includes("r"),
    );
    const force = flags.some(
      (flag) => flag === "--force" || flag.slice(1).toLowerCase().includes("f"),
    );
    if (recursive && force) {
      return "recursive forced deletion (rm -rf) is blocked";
    }
  }

  return null;
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_OUTPUT_LENGTH)}\n... output truncated ...`;
}

export async function runProjectCommand(
  projectRoot: string,
  command: string,
  interaction: ToolInteraction,
): Promise<string> {
  if (!command.trim()) {
    throw new Error("A non-empty command is required.");
  }

  const reason = dangerousReason(command);
  if (reason) {
    throw new Error(`Command refused: ${reason}.`);
  }

  if (!(await interaction.confirm(`Run: ${command} ? [y/N]`))) {
    return "User declined the command. It was not run.";
  }

  interaction.action(`Running ${command}`);
  const process = Bun.spawn(["sh", "-lc", command], {
    cwd: path.resolve(projectRoot),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  return JSON.stringify(
    {
      exitCode,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
    },
    null,
    2,
  );
}
