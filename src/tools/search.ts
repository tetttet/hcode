import { createReadStream } from "node:fs";
import { access, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { loadProjectIgnore, type ProjectIgnore } from "../context/ignore.ts";
import type { ToolInteraction } from "./files.ts";
import {
  IGNORED_DIRECTORIES,
  isProtectedFileName,
  relativeDisplayPath,
  resolveProjectPath,
} from "./path-security.ts";

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 200;
const MAX_SNIPPET_LENGTH = 300;

export interface SearchCodeOptions {
  query: string;
  path?: string;
  glob?: string;
  maxResults?: number;
}

interface SearchMatch {
  path: string;
  line: number;
  snippet: string;
}

function normalizeOptions(options: SearchCodeOptions): Required<SearchCodeOptions> {
  const query = options.query;
  if (!query || query.includes("\0") || query.includes("\n") || query.length > 1_000) {
    throw new Error("query must be a non-empty single-line string up to 1000 characters.");
  }
  const maxResults = Math.min(
    MAX_RESULTS,
    Math.max(1, Math.trunc(options.maxResults ?? DEFAULT_MAX_RESULTS)),
  );
  return {
    query,
    path: options.path?.trim() || ".",
    glob: options.glob?.trim() || "*",
    maxResults,
  };
}

function snippet(value: string): string {
  const compact = value.trimEnd().replaceAll("\t", "  ");
  return compact.length <= MAX_SNIPPET_LENGTH
    ? compact
    : `${compact.slice(0, MAX_SNIPPET_LENGTH)}…`;
}

function formatMatches(matches: SearchMatch[]): string {
  if (matches.length === 0) {
    return "No matches found.";
  }
  return matches.map((match) => `${match.path}:${match.line}: ${match.snippet}`).join("\n");
}

async function searchWithRipgrep(
  ripgrepPath: string,
  projectRoot: string,
  targetPath: string,
  options: Required<SearchCodeOptions>,
  signal?: AbortSignal,
): Promise<SearchMatch[]> {
  const target = relativeDisplayPath(projectRoot, targetPath);
  const args = [
    ripgrepPath,
    "--json",
    "--fixed-strings",
    "--line-number",
    "--hidden",
    "--glob", "!.git/**",
    "--glob", "!node_modules/**",
    "--glob", "!dist/**",
    "--glob", "!.next/**",
    "--glob", "!build/**",
    "--glob", "!.env",
    "--glob", "!.env.*",
    "--glob", "!*.pem",
    "--glob", "!*.key",
    "--glob", "!*.p12",
    "--glob", "!*.pfx",
    "--glob", "!.npmrc",
    "--glob", "!.pypirc",
    "--glob", "!credentials.json",
    "--glob", "!service-account*.json",
    "--glob", "!id_rsa",
    "--glob", "!id_dsa",
    "--glob", "!id_ecdsa",
    "--glob", "!id_ed25519",
  ];
  try {
    await access(path.join(projectRoot, ".hcodeignore"));
    args.push("--ignore-file", ".hcodeignore");
  } catch {
    // Project-level hcode ignore is optional.
  }
  if (options.glob !== "*") {
    args.push("--glob", options.glob);
  }
  args.push("--", options.query, target);

  const child = Bun.spawn(args, {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });

  const matches: SearchMatch[] = [];
  const decoder = new TextDecoder();
  const reader = child.stdout.getReader();
  let pending = "";

  try {
    while (matches.length < options.maxResults) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) {
          continue;
        }
        const event = JSON.parse(line) as {
          type?: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };
        if (event.type !== "match" || !event.data?.path?.text || !event.data.line_number) {
          continue;
        }
        matches.push({
          path: event.data.path.text.split(path.sep).join("/"),
          line: event.data.line_number,
          snippet: snippet(event.data.lines?.text ?? ""),
        });
        if (matches.length >= options.maxResults) {
          child.kill();
          break;
        }
      }
    }
    await child.exited;
    if (signal?.aborted) {
      throw new Error("Operation cancelled.");
    }
    return matches;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

async function searchFallback(
  projectRoot: string,
  targetPath: string,
  options: Required<SearchCodeOptions>,
  signal?: AbortSignal,
  ignore?: ProjectIgnore,
): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];
  const glob = new Bun.Glob(options.glob);

  async function searchFile(absolutePath: string): Promise<void> {
    const relativePath = relativeDisplayPath(projectRoot, absolutePath);
    if (
      isProtectedFileName(path.basename(absolutePath)) ||
      ignore?.ignores(relativePath) ||
      (options.glob !== "*" && !glob.match(relativePath))
    ) {
      return;
    }
    const input = createReadStream(absolutePath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        if (signal?.aborted || matches.length >= options.maxResults) {
          break;
        }
        lineNumber += 1;
        if (line.includes(options.query)) {
          matches.push({ path: relativePath, line: lineNumber, snippet: snippet(line) });
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }

  async function walk(absolutePath: string): Promise<void> {
    if (signal?.aborted || matches.length >= options.maxResults) {
      return;
    }
    const stats = await lstat(absolutePath);
    if (stats.isFile()) {
      await searchFile(absolutePath);
      return;
    }
    if (!stats.isDirectory()) {
      return;
    }
    const entries = await readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= options.maxResults) {
        break;
      }
      if (entry.isSymbolicLink() || isProtectedFileName(entry.name)) {
        continue;
      }
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const relativePath = relativeDisplayPath(projectRoot, path.join(absolutePath, entry.name));
      if (ignore?.ignores(relativePath, entry.isDirectory())) {
        continue;
      }
      await walk(path.join(absolutePath, entry.name));
    }
  }

  await walk(targetPath);
  if (signal?.aborted) {
    throw new Error("Operation cancelled.");
  }
  return matches;
}

export async function searchCode(
  projectRoot: string,
  rawOptions: SearchCodeOptions,
  interaction: ToolInteraction,
  ripgrepPath: string | null = Bun.which("rg"),
): Promise<string> {
  const options = normalizeOptions(rawOptions);
  const targetPath = await resolveProjectPath(projectRoot, options.path, {
    allowProjectRoot: true,
    protectSecrets: true,
  });
  interaction.action(`Searching for ${JSON.stringify(options.query)}`);
  if (interaction.signal?.aborted) {
    throw new Error("Operation cancelled.");
  }

  const ignore = await loadProjectIgnore(projectRoot);
  const targetDisplayPath = relativeDisplayPath(projectRoot, targetPath);
  if (targetDisplayPath !== "." && ignore.ignores(targetDisplayPath, false)) {
    return "No matches found (path is excluded by .gitignore or .hcodeignore).";
  }
  const matches = ripgrepPath
    ? await searchWithRipgrep(ripgrepPath, projectRoot, targetPath, options, interaction.signal)
    : await searchFallback(projectRoot, targetPath, options, interaction.signal, ignore);
  return formatMatches(matches);
}
