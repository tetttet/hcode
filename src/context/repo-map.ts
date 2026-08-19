import { lstat, readFile } from "node:fs/promises";
import { discoverProjectFiles } from "./ignore.ts";
import { ProjectCache } from "./cache.ts";
import {
  extractSymbols,
  hasUsefulSymbols,
  REPO_MAP_EXTENSIONS,
  type SymbolSummary,
} from "./symbols.ts";

const MAX_SYMBOL_FILE_SIZE = 1_000_000;
const DEFAULT_MAP_FILES = 500;

export interface RepoMapEntry {
  path: string;
  size: number;
  mtimeMs: number;
  symbols: SymbolSummary;
}

export interface RepoMap {
  entries: RepoMapEntry[];
  scannedFiles: number;
  truncated: boolean;
  reusedFromCache: number;
}

export async function buildRepoMap(
  projectRoot: string,
  options: {
    cache?: ProjectCache;
    maxFiles?: number;
    signal?: AbortSignal;
  } = {},
): Promise<RepoMap> {
  const cache = options.cache ?? new ProjectCache(projectRoot);
  const discovered = await discoverProjectFiles(projectRoot, {
    extensions: REPO_MAP_EXTENSIONS,
    maxFiles: Math.max(DEFAULT_MAP_FILES, options.maxFiles ?? DEFAULT_MAP_FILES) * 4,
    signal: options.signal,
  });
  const entries: RepoMapEntry[] = [];
  let reusedFromCache = 0;

  for (const file of discovered.files) {
    if (options.signal?.aborted) {
      throw new Error("Operation cancelled.");
    }
    const stats = await lstat(file.absolutePath);
    const cached = await cache.getFile(file.relativePath, stats.size, stats.mtimeMs);
    let symbols: SymbolSummary;
    if (cached) {
      symbols = cached.symbols;
      reusedFromCache += 1;
    } else {
      try {
        symbols = stats.size <= MAX_SYMBOL_FILE_SIZE
          ? extractSymbols(file.relativePath, await readFile(file.absolutePath, "utf8"))
          : { imports: [], exports: [], classes: [], functions: [], types: [] };
      } catch {
        symbols = { imports: [], exports: [], classes: [], functions: [], types: [] };
      }
      await cache.setFile(file.relativePath, {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        symbols,
      });
    }
    entries.push({
      path: file.relativePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      symbols,
    });
  }

  await cache.pruneFiles(new Set(discovered.files.map((file) => file.relativePath)));
  await cache.save().catch(() => undefined);
  const maxFiles = options.maxFiles ?? DEFAULT_MAP_FILES;
  return {
    entries: entries.slice(0, maxFiles),
    scannedFiles: discovered.files.length,
    truncated: discovered.truncated || entries.length > maxFiles,
    reusedFromCache,
  };
}

export function formatRepoMap(map: RepoMap): string {
  const lines: string[] = [];
  for (const entry of map.entries) {
    lines.push(entry.path);
    const groups: Array<[keyof SymbolSummary, string]> = [
      ["exports", "exports"],
      ["classes", "classes"],
      ["functions", "functions"],
      ["types", "types"],
      ["imports", "imports"],
    ];
    for (const [key, label] of groups) {
      if (entry.symbols[key].length) {
        lines.push(`  ${label}: ${entry.symbols[key].join(", ")}`);
      }
    }
    if (!hasUsefulSymbols(entry.symbols)) {
      lines.push("  symbols: none detected");
    }
  }
  if (map.truncated) {
    lines.push(`... repository map limited to ${map.entries.length} of ${map.scannedFiles} code files ...`);
  }
  return lines.join("\n") || "No supported source files found.";
}
