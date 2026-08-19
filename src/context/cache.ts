import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SymbolSummary } from "./symbols.ts";

const CACHE_VERSION = 1;

export interface CachedFileMetadata {
  size: number;
  mtimeMs: number;
  symbols: SymbolSummary;
}

export interface CachedSearch {
  key: string;
  result: string;
  savedAt: number;
}

interface CacheDocument {
  version: 1;
  projectRootHash: string;
  files: Record<string, CachedFileMetadata>;
  searches: CachedSearch[];
  updatedAt: number;
}

export function projectCacheHash(projectRoot: string): string {
  return createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 24);
}

function emptyDocument(projectRoot: string): CacheDocument {
  return {
    version: CACHE_VERSION,
    projectRootHash: projectCacheHash(projectRoot),
    files: {},
    searches: [],
    updatedAt: Date.now(),
  };
}

function redactCachedText(value: string): string {
  return value
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_KEY]")
    .replace(/((?:api[_-]?key|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

export class ProjectCache {
  private document: CacheDocument | null = null;
  private dirty = false;
  readonly cachePath: string;

  constructor(
    private readonly projectRoot: string,
    cacheDirectory = path.join(os.homedir(), ".hcode", "cache"),
  ) {
    this.cachePath = path.join(cacheDirectory, `${projectCacheHash(projectRoot)}.json`);
  }

  private async load(): Promise<CacheDocument> {
    if (this.document) {
      return this.document;
    }
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, "utf8")) as Partial<CacheDocument>;
      if (
        parsed.version !== CACHE_VERSION ||
        parsed.projectRootHash !== projectCacheHash(this.projectRoot) ||
        !parsed.files || typeof parsed.files !== "object" ||
        !Array.isArray(parsed.searches)
      ) {
        throw new Error("Unsupported cache format");
      }
      this.document = parsed as CacheDocument;
    } catch {
      this.document = emptyDocument(this.projectRoot);
    }
    return this.document;
  }

  async getFile(filePath: string, size: number, mtimeMs: number): Promise<CachedFileMetadata | null> {
    const cached = (await this.load()).files[filePath];
    return cached && cached.size === size && cached.mtimeMs === mtimeMs ? cached : null;
  }

  async setFile(filePath: string, metadata: CachedFileMetadata): Promise<void> {
    (await this.load()).files[filePath] = metadata;
    this.dirty = true;
  }

  async pruneFiles(activePaths: Set<string>): Promise<void> {
    const document = await this.load();
    for (const filePath of Object.keys(document.files)) {
      if (!activePaths.has(filePath)) {
        delete document.files[filePath];
        this.dirty = true;
      }
    }
  }

  async getSearch(key: string, maxAgeMs = 5 * 60_000): Promise<string | null> {
    const match = (await this.load()).searches.find((item) => item.key === key);
    return match && Date.now() - match.savedAt <= maxAgeMs ? match.result : null;
  }

  async setSearch(key: string, result: string): Promise<void> {
    const document = await this.load();
    document.searches = [
      { key, result: redactCachedText(result.slice(0, 20_000)), savedAt: Date.now() },
      ...document.searches.filter((item) => item.key !== key),
    ].slice(0, 20);
    this.dirty = true;
  }

  invalidateSearches(): void {
    if (this.document?.searches.length) {
      this.document.searches = [];
      this.dirty = true;
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    const document = await this.load();
    document.updatedAt = Date.now();
    const directory = path.dirname(this.cachePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.cachePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.cachePath);
    if (process.platform === "darwin" || process.platform === "linux") {
      await chmod(this.cachePath, 0o600);
    }
    this.dirty = false;
  }
}
