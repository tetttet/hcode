import {
  lstat,
  mkdir,
  readFile as readFileFromDisk,
  readdir,
  realpath,
  writeFile as writeFileToDisk,
} from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "build",
]);
const IGNORED_FILES = new Set([".env"]);

function isIgnoredFile(name: string): boolean {
  if (IGNORED_FILES.has(name)) {
    return true;
  }
  return (
    name.startsWith(".env.") && !/^\.env\.(?:example|sample|template)$/.test(name)
  );
}

export interface ToolInteraction {
  confirm(message: string): Promise<boolean>;
  action(message: string): void;
}

function hasParentTraversal(input: string): boolean {
  return input.replaceAll("\\", "/").split("/").includes("..");
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function assertRealPathInsideRoot(
  projectRoot: string,
  candidate: string,
): Promise<void> {
  const realRoot = await realpath(projectRoot);
  let existingPath = candidate;

  while (true) {
    try {
      const actualPath = await realpath(existingPath);
      if (!isInside(realRoot, actualPath)) {
        throw new Error("Path is outside the project root.");
      }
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }

      const parent = path.dirname(existingPath);
      if (parent === existingPath) {
        throw new Error("Could not validate the requested path.");
      }
      existingPath = parent;
    }
  }
}

export async function resolveProjectPath(
  projectRoot: string,
  requestedPath: string,
): Promise<string> {
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new Error("A valid project-relative path is required.");
  }
  if (hasParentTraversal(requestedPath)) {
    throw new Error("Parent path segments (..) are not allowed.");
  }

  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, requestedPath);
  if (!isInside(root, candidate)) {
    throw new Error("Path is outside the project root.");
  }

  await assertRealPathInsideRoot(root, candidate);
  return candidate;
}

function relativeDisplayPath(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/") || ".";
}

export async function listFiles(
  projectRoot: string,
  interaction: ToolInteraction,
): Promise<string> {
  interaction.action("Inspecting project files");
  const root = path.resolve(projectRoot);
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isFile() && isIgnoredFile(entry.name)) {
        continue;
      }
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        files.push(relativeDisplayPath(root, absolutePath));
      }
    }
  }

  await walk(root);
  const projectName = path.basename(root);
  const fileList = files.length > 0 ? files.join("\n") : "(no files)";
  return `Project: ${projectName}\nRoot: ${root}\nFiles:\n${fileList}`;
}

export async function readProjectFile(
  projectRoot: string,
  requestedPath: string,
  interaction: ToolInteraction,
): Promise<string> {
  const absolutePath = await resolveProjectPath(projectRoot, requestedPath);
  const displayPath = relativeDisplayPath(projectRoot, absolutePath);
  interaction.action(`Reading ${displayPath}`);

  const stats = await lstat(absolutePath);
  if (!stats.isFile()) {
    throw new Error(`${displayPath} is not a regular file.`);
  }

  return readFileFromDisk(absolutePath, "utf8");
}

export async function writeProjectFile(
  projectRoot: string,
  requestedPath: string,
  content: string,
  interaction: ToolInteraction,
): Promise<string> {
  const absolutePath = await resolveProjectPath(projectRoot, requestedPath);
  const displayPath = relativeDisplayPath(projectRoot, absolutePath);

  let exists = false;
  try {
    const stats = await lstat(absolutePath);
    if (!stats.isFile()) {
      throw new Error(`${displayPath} is not a regular file.`);
    }
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (exists && !(await interaction.confirm(`Edit ${displayPath}? [y/N]`))) {
    return `User declined the edit. ${displayPath} was not changed.`;
  }

  interaction.action(`Editing ${displayPath}`);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFileToDisk(absolutePath, content, "utf8");
  return `${displayPath} was written successfully.`;
}
