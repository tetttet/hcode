import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  IGNORED_DIRECTORIES,
  isProtectedFileName,
  relativeDisplayPath,
} from "../tools/path-security.ts";

interface IgnoreRule {
  negate: boolean;
  directoryOnly: boolean;
  anchored: boolean;
  pattern: string;
  matcher: RegExp;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globRegex(pattern: string, anchored: boolean): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(character ?? "");
    }
  }
  const prefix = anchored ? "^" : "(?:^|/)";
  return new RegExp(`${prefix}${source}(?:$|/)`);
}

function parseRules(contents: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const negate = line.startsWith("!");
    if (negate) {
      line = line.slice(1);
    }
    if (!line) {
      continue;
    }
    const directoryOnly = line.endsWith("/");
    const anchored = line.startsWith("/");
    line = line.replace(/^\//, "").replace(/\/$/, "");
    rules.push({
      negate,
      directoryOnly,
      anchored,
      pattern: line,
      matcher: globRegex(line, anchored),
    });
  }
  return rules;
}

export class ProjectIgnore {
  constructor(private readonly rules: IgnoreRule[]) {}

  ignores(relativePath: string, isDirectory = false): boolean {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
    const parts = normalized.split("/");
    if (parts.some((part) => IGNORED_DIRECTORIES.has(part))) {
      return true;
    }
    if (!isDirectory && isProtectedFileName(path.basename(normalized))) {
      return true;
    }

    let ignored = false;
    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDirectory && !normalized.includes(`${rule.pattern}/`)) {
        continue;
      }
      if (rule.matcher.test(normalized)) {
        ignored = !rule.negate;
      }
    }
    return ignored;
  }
}

export async function loadProjectIgnore(projectRoot: string): Promise<ProjectIgnore> {
  const contents: string[] = [];
  for (const name of [".gitignore", ".hcodeignore"]) {
    try {
      contents.push(await readFile(path.join(projectRoot, name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return new ProjectIgnore(parseRules(contents.join("\n")));
}

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
}

export async function discoverProjectFiles(
  projectRoot: string,
  options: { maxFiles?: number; extensions?: Set<string>; signal?: AbortSignal } = {},
): Promise<{ files: DiscoveredFile[]; truncated: boolean }> {
  const root = path.resolve(projectRoot);
  const ignore = await loadProjectIgnore(root);
  const files: DiscoveredFile[] = [];
  const maxFiles = Math.max(1, options.maxFiles ?? 10_000);
  let truncated = false;

  async function walk(directory: string): Promise<void> {
    if (options.signal?.aborted) {
      throw new Error("Operation cancelled.");
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativeDisplayPath(root, absolutePath);
      if (ignore.ignores(relativePath, entry.isDirectory())) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (
        entry.isFile() &&
        (!options.extensions || options.extensions.has(path.extname(entry.name).toLowerCase()))
      ) {
        files.push({ absolutePath, relativePath });
      }
    }
  }

  await walk(root);
  return { files, truncated };
}
