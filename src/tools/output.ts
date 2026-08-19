import { randomUUID } from "node:crypto";

const MAX_STORED_OUTPUTS = 20;
const MAX_DIAGNOSTIC_LINES = 80;

interface StoredOutput {
  id: string;
  command: string;
  output: string;
  createdAt: number;
}

const storedOutputs = new Map<string, StoredOutput>();

function relevantLines(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const selected = new Set<number>();
  const diagnostic = /(?:\berror\b|\bfailed\b|\bfailure\b|\bwarning\b|\bpanic\b|\bexpected\b|\breceived\b|\bFAIL\b|\bnot ok\b|\bat [^\s]+:\d+(?::\d+)?)/i;
  lines.forEach((line, index) => {
    if (!diagnostic.test(line)) return;
    for (let nearby = Math.max(0, index - 1); nearby <= Math.min(lines.length - 1, index + 2); nearby += 1) {
      selected.add(nearby);
    }
  });
  return [...selected]
    .sort((left, right) => left - right)
    .slice(0, MAX_DIAGNOSTIC_LINES)
    .map((index) => lines[index] ?? "");
}

function count(pattern: RegExp, value: string): number {
  return [...value.matchAll(pattern)].length;
}

export function reduceCommandOutput(command: string, exitCode: number, output: string): string {
  const id = `cmd-${randomUUID().slice(0, 8)}`;
  storedOutputs.set(id, { id, command, output, createdAt: Date.now() });
  while (storedOutputs.size > MAX_STORED_OUTPUTS) {
    const oldest = storedOutputs.keys().next().value;
    if (typeof oldest !== "string") break;
    storedOutputs.delete(oldest);
  }

  const diagnostics = relevantLines(output);
  const failures = count(/(?:^|\n)\s*(?:FAIL\b|not ok\b|✗|×)/gim, output);
  const warnings = count(/\bwarning\b/gi, output);
  const summary = [
    `Exit code: ${exitCode}`,
    failures ? `Failed tests/checks: ${failures}` : "",
    warnings ? `Warnings: ${warnings}` : "",
    `Full output: ${id}`,
  ].filter(Boolean);

  if (diagnostics.length) {
    summary.push("", "Diagnostics:", ...diagnostics);
  } else {
    const compact = output.trim().split(/\r?\n/).slice(-40);
    if (compact.length) summary.push("", ...compact);
  }
  return summary.join("\n").slice(0, 16_000);
}

export function readStoredCommandOutput(
  id: string,
  startLine = 1,
  endLine = startLine + 399,
): string {
  const stored = storedOutputs.get(id);
  if (!stored) {
    throw new Error(`Command output ${id} is unavailable or expired.`);
  }
  if (startLine < 1 || endLine < startLine || endLine - startLine > 1_999) {
    throw new Error("Invalid command-output line range.");
  }
  const lines = stored.output.split(/\r?\n/);
  const actualEnd = Math.min(Math.trunc(endLine), lines.length);
  return [
    `Command: ${stored.command}`,
    `Range: ${Math.trunc(startLine)}-${actualEnd}`,
    `Total lines: ${lines.length}`,
    "",
    ...lines.slice(Math.trunc(startLine) - 1, actualEnd),
  ].join("\n");
}
