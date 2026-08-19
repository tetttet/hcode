import {
  lstat,
  mkdir,
  open,
  readFile as readFileFromDisk,
  rename,
  unlink,
  writeFile as writeFileToDisk,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { discoverProjectFiles } from "../context/ignore.ts";
import {
  requiresFileEditConfirmation,
  type PermissionMode,
} from "../config/permissions.ts";
import type { CheckpointManager } from "../session/checkpoint.ts";
import {
  relativeDisplayPath,
  resolveProjectPath,
} from "./path-security.ts";

const MAX_LISTED_FILES = 1_000;
const MAX_READ_LENGTH = 100_000;
const MAX_AUTO_READ_LINES = 400;
const MAX_EXPLICIT_READ_LINES = 2_000;
const BINARY_SAMPLE_BYTES = 8_192;
const MAX_BUFFERED_READ_BYTES = 5 * 1_024 * 1_024;

export interface ToolInteraction {
  confirm(message: string): Promise<boolean>;
  action(message: string): void;
  permissionMode?: PermissionMode;
  checkpoint?: CheckpointManager;
  signal?: AbortSignal;
}

function permissionMode(interaction: ToolInteraction): PermissionMode {
  return interaction.permissionMode ?? "safe";
}

async function regularFileExists(absolutePath: string, displayPath: string): Promise<boolean> {
  try {
    const stats = await lstat(absolutePath);
    if (!stats.isFile()) {
      throw new Error(`${displayPath} is not a regular file.`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export { resolveProjectPath } from "./path-security.ts";

export async function listFiles(
  projectRoot: string,
  interaction: ToolInteraction,
): Promise<string> {
  interaction.action("Inspecting project files");
  const { files, truncated } = await discoverProjectFiles(projectRoot, {
    maxFiles: MAX_LISTED_FILES,
    signal: interaction.signal,
  });
  return `${files.map((file) => file.relativePath).join("\n") || "(no files)"}${
    truncated
      ? `\n... file list limited to ${MAX_LISTED_FILES}; use repo_map or search_code ...`
      : ""
  }`;
}

export interface ReadFileOptions {
  startLine?: number;
  endLine?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function validateRange(options: ReadFileOptions): { startLine: number; endLine: number } {
  const startLine = Math.trunc(options.startLine ?? 1);
  const defaultEnd = options.startLine === undefined
    ? MAX_AUTO_READ_LINES
    : startLine + MAX_AUTO_READ_LINES - 1;
  const endLine = Math.trunc(options.endLine ?? defaultEnd);
  if (startLine < 1 || endLine < startLine) {
    throw new Error("startLine and endLine must describe a positive line range.");
  }
  if (endLine - startLine + 1 > MAX_EXPLICIT_READ_LINES) {
    throw new Error(`A single read_file range may contain at most ${MAX_EXPLICIT_READ_LINES} lines.`);
  }
  return { startLine, endLine };
}

async function appearsBinary(absolutePath: string, size: number): Promise<boolean> {
  if (size === 0) {
    return false;
  }
  const handle = await open(absolutePath, "r");
  try {
    const sample = Buffer.alloc(Math.min(size, BINARY_SAMPLE_BYTES));
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    const bytes = sample.subarray(0, bytesRead);
    if (bytes.includes(0)) {
      return true;
    }
    const decoded = new TextDecoder("utf-8").decode(bytes);
    const replacements = [...decoded].filter((character) => character === "�").length;
    let controls = 0;
    for (const byte of bytes) {
      if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controls += 1;
    }
    return replacements > 2 || controls / Math.max(1, bytes.length) > 0.1;
  } finally {
    await handle.close();
  }
}

async function readLargeRange(
  absolutePath: string,
  startLine: number,
  endLine: number,
  signal?: AbortSignal,
): Promise<{ body: string; totalLines: number; actualEnd: number }> {
  const stream = createReadStream(absolutePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const selected: string[] = [];
  let totalLines = 0;
  try {
    for await (const line of lines) {
      if (signal?.aborted) throw new Error("Operation cancelled.");
      totalLines += 1;
      if (totalLines >= startLine && totalLines <= endLine) selected.push(line);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return {
    body: selected.join("\n"),
    totalLines,
    actualEnd: selected.length ? startLine + selected.length - 1 : Math.min(endLine, totalLines),
  };
}

export async function readProjectFile(
  projectRoot: string,
  requestedPath: string,
  interaction: ToolInteraction,
  options: ReadFileOptions = {},
): Promise<string> {
  const absolutePath = await resolveProjectPath(projectRoot, requestedPath, {
    protectSecrets: true,
  });
  const displayPath = relativeDisplayPath(projectRoot, absolutePath);
  interaction.action(`Reading ${displayPath}`);

  const stats = await lstat(absolutePath);
  if (!stats.isFile()) {
    throw new Error(`${displayPath} is not a regular file.`);
  }

  if (await appearsBinary(absolutePath, stats.size)) {
    return `File appears to be binary (${formatBytes(stats.size)}): ${displayPath}`;
  }

  const { startLine, endLine } = validateRange(options);
  let body: string;
  let totalLines: number;
  let actualEnd: number;
  if (stats.size > MAX_BUFFERED_READ_BYTES) {
    const large = await readLargeRange(
      absolutePath,
      startLine,
      endLine,
      interaction.signal,
    );
    ({ body, totalLines, actualEnd } = large);
  } else {
    const content = await readFileFromDisk(absolutePath, "utf8");
    const lines = content.split(/\r?\n/);
    totalLines = lines.length;
    actualEnd = Math.min(endLine, totalLines);
    body = startLine > totalLines ? "" : lines.slice(startLine - 1, actualEnd).join("\n");
  }
  if (body.length > MAX_READ_LENGTH) {
    body = `${body.slice(0, MAX_READ_LENGTH)}\n... range truncated at ${MAX_READ_LENGTH} characters ...`;
  }
  const range = body.length || startLine <= totalLines ? `${startLine}-${actualEnd}` : "empty";
  const more = actualEnd < totalLines
    ? `\n... ${totalLines - actualEnd} more lines; request another range ...`
    : "";
  return `File: ${displayPath}\nSize: ${formatBytes(stats.size)}\nRange: ${range}\nTotal lines: ${totalLines}\n\n${body}${more}`;
}

export async function writeProjectFile(
  projectRoot: string,
  requestedPath: string,
  content: string,
  interaction: ToolInteraction,
): Promise<string> {
  const absolutePath = await resolveProjectPath(projectRoot, requestedPath, {
    protectSecrets: true,
  });
  const displayPath = relativeDisplayPath(projectRoot, absolutePath);
  const exists = await regularFileExists(absolutePath, displayPath);

  if (
    exists &&
    requiresFileEditConfirmation(permissionMode(interaction)) &&
    !(await interaction.confirm(`Edit ${displayPath}? [y/N]`))
  ) {
    return `User declined the edit. ${displayPath} was not changed.`;
  }

  interaction.action(`${exists ? "Editing" : "Creating"} ${displayPath}`);
  if (interaction.signal?.aborted) {
    throw new Error("Operation cancelled.");
  }
  await interaction.checkpoint?.capture(requestedPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFileToDisk(absolutePath, content, "utf8");
  return `${displayPath} was written successfully.`;
}

export async function moveProjectFile(
  projectRoot: string,
  sourcePath: string,
  destinationPath: string,
  interaction: ToolInteraction,
): Promise<string> {
  const source = await resolveProjectPath(projectRoot, sourcePath, { protectSecrets: true });
  const destination = await resolveProjectPath(projectRoot, destinationPath, { protectSecrets: true });
  const sourceDisplay = relativeDisplayPath(projectRoot, source);
  const destinationDisplay = relativeDisplayPath(projectRoot, destination);
  if (source === destination) {
    throw new Error("Source and destination must be different.");
  }
  if (!(await regularFileExists(source, sourceDisplay))) {
    throw new Error(`${sourceDisplay} does not exist.`);
  }
  const destinationExists = await regularFileExists(destination, destinationDisplay);

  const confirmationRequired =
    destinationExists || requiresFileEditConfirmation(permissionMode(interaction));
  if (
    confirmationRequired &&
    !(await interaction.confirm(
      `${destinationExists ? "Overwrite" : "Move"} ${sourceDisplay} → ${destinationDisplay}? [y/N]`,
    ))
  ) {
    return `User declined the move. ${sourceDisplay} was not changed.`;
  }

  interaction.action(`Moving ${sourceDisplay} → ${destinationDisplay}`);
  if (interaction.signal?.aborted) {
    throw new Error("Operation cancelled.");
  }
  await interaction.checkpoint?.capture(sourcePath);
  await interaction.checkpoint?.capture(destinationPath);
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(source, destination);
  return `Moved ${sourceDisplay} to ${destinationDisplay}.`;
}

export async function deleteProjectFile(
  projectRoot: string,
  requestedPath: string,
  interaction: ToolInteraction,
): Promise<string> {
  const absolutePath = await resolveProjectPath(projectRoot, requestedPath, {
    protectSecrets: true,
  });
  const displayPath = relativeDisplayPath(projectRoot, absolutePath);
  if (!(await regularFileExists(absolutePath, displayPath))) {
    throw new Error(`${displayPath} does not exist.`);
  }

  const createdByHcode = await interaction.checkpoint?.wasCreatedByHcode(requestedPath);
  const mayDeleteAutomatically = permissionMode(interaction) !== "safe" && createdByHcode;
  if (
    !mayDeleteAutomatically &&
    !(await interaction.confirm(`Delete file ${displayPath}? [y/N]`))
  ) {
    return `User declined the deletion. ${displayPath} was not changed.`;
  }

  interaction.action(`Deleting ${displayPath}`);
  if (interaction.signal?.aborted) {
    throw new Error("Operation cancelled.");
  }
  await interaction.checkpoint?.capture(requestedPath);
  await unlink(absolutePath);
  return `Deleted ${displayPath}.`;
}
