import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "build",
]);

const SECRET_FILE_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);

export function isProtectedFileName(name: string): boolean {
  const lowerName = name.toLowerCase();
  const isEnvironmentFile =
    lowerName === ".env" ||
    (lowerName.startsWith(".env.") &&
      !/^\.env\.(?:example|sample|template)$/.test(lowerName));
  return (
    isEnvironmentFile ||
    SECRET_FILE_NAMES.has(lowerName) ||
    /\.(?:pem|key|p12|pfx)$/.test(lowerName) ||
    /^service-account.*\.json$/.test(lowerName)
  );
}

export function isProtectedProjectPath(requestedPath: string): boolean {
  return requestedPath
    .replaceAll("\\", "/")
    .split("/")
    .some(isProtectedFileName);
}

function hasParentTraversal(input: string): boolean {
  return input.replaceAll("\\", "/").split("/").includes("..");
}

export function isPathInside(root: string, candidate: string): boolean {
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
      if (!isPathInside(realRoot, actualPath)) {
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

export interface ResolvePathOptions {
  allowProjectRoot?: boolean;
  protectSecrets?: boolean;
  rejectFinalSymlink?: boolean;
}

export async function resolveProjectPath(
  projectRoot: string,
  requestedPath: string,
  options: ResolvePathOptions = {},
): Promise<string> {
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new Error("A valid project-relative path is required.");
  }
  if (hasParentTraversal(requestedPath)) {
    throw new Error("Parent path segments (..) are not allowed.");
  }
  if (options.protectSecrets && isProtectedProjectPath(requestedPath)) {
    throw new Error("Protected environment or credential files cannot be accessed.");
  }

  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, requestedPath);
  if (!isPathInside(root, candidate)) {
    throw new Error("Path is outside the project root.");
  }
  if (candidate === root && !options.allowProjectRoot) {
    throw new Error("A file path inside the project root is required.");
  }

  await assertRealPathInsideRoot(root, candidate);

  if (options.rejectFinalSymlink !== false) {
    try {
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink()) {
        throw new Error("Symbolic links cannot be modified by filesystem tools.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return candidate;
}

export function relativeDisplayPath(
  projectRoot: string,
  absolutePath: string,
): string {
  return path.relative(path.resolve(projectRoot), absolutePath).split(path.sep).join("/") || ".";
}
