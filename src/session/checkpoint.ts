import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveProjectPath } from "../tools/path-security.ts";

interface FileState {
  exists: boolean;
  content?: Buffer;
  mode?: number;
  fingerprint: string;
}

interface CheckpointEntry {
  path: string;
  before: FileState;
  after?: FileState;
}

export interface CheckpointSummary {
  id: number;
  label: string;
  files: string[];
}

interface CheckpointRecord extends CheckpointSummary {
  entries: CheckpointEntry[];
}

async function fileState(absolutePath: string): Promise<FileState> {
  try {
    const stats = await lstat(absolutePath);
    if (!stats.isFile()) {
      throw new Error(`${absolutePath} is not a regular file.`);
    }
    const content = await readFile(absolutePath);
    return {
      exists: true,
      content,
      mode: stats.mode,
      fingerprint: Bun.hash(content).toString(16),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return { exists: false, fingerprint: "missing" };
  }
}

export class CheckpointManager {
  private current: Map<string, CheckpointEntry> | null = null;
  private currentLabel = "File changes";
  private readonly history: CheckpointRecord[] = [];
  private nextId = 1;
  private readonly hcodeCreatedFiles = new Set<string>();

  constructor(private readonly projectRoot: string) {}

  beginOperation(label = "File changes"): void {
    this.current = new Map();
    this.currentLabel = label.trim().slice(0, 80) || "File changes";
  }

  async capture(requestedPath: string): Promise<void> {
    if (!this.current) {
      return;
    }
    const absolutePath = await resolveProjectPath(this.projectRoot, requestedPath, {
      protectSecrets: true,
    });
    if (this.current.has(absolutePath)) {
      return;
    }
    this.current.set(absolutePath, {
      path: absolutePath,
      before: await fileState(absolutePath),
    });
  }

  async finishOperation(): Promise<void> {
    if (!this.current) {
      return;
    }

    const changed: CheckpointEntry[] = [];
    for (const entry of this.current.values()) {
      entry.after = await fileState(entry.path);
      if (entry.before.fingerprint !== entry.after.fingerprint) {
        changed.push(entry);
        if (!entry.before.exists && entry.after.exists) {
          this.hcodeCreatedFiles.add(entry.path);
        } else if (entry.before.exists && !entry.after.exists) {
          this.hcodeCreatedFiles.delete(entry.path);
        }
      }
    }
    if (changed.length > 0) {
      this.history.push({
        id: this.nextId,
        label: this.currentLabel,
        files: changed.map((entry) => path.relative(this.projectRoot, entry.path)),
        entries: changed,
      });
      this.nextId += 1;
      if (this.history.length > 20) this.history.shift();
    }
    this.current = null;
  }

  async wasCreatedByHcode(requestedPath: string): Promise<boolean> {
    const absolutePath = await resolveProjectPath(this.projectRoot, requestedPath, {
      protectSecrets: true,
    });
    return this.hcodeCreatedFiles.has(absolutePath);
  }

  hasUndo(): boolean {
    return this.history.length > 0;
  }

  list(): CheckpointSummary[] {
    return [...this.history].reverse().map(({ id, label, files }) => ({
      id,
      label,
      files: [...files],
    }));
  }

  async undoLast(): Promise<string> {
    const checkpoint = this.history.at(-1)?.entries;
    if (!checkpoint?.length) {
      return "Nothing to undo.";
    }

    for (const entry of checkpoint) {
      const current = await fileState(entry.path);
      if (current.fingerprint !== entry.after?.fingerprint) {
        throw new Error(
          `${path.relative(this.projectRoot, entry.path)} changed after hcode edited it; undo was not applied.`,
        );
      }
    }

    for (const entry of [...checkpoint].reverse()) {
      if (entry.before.exists) {
        await mkdir(path.dirname(entry.path), { recursive: true });
        await writeFile(entry.path, entry.before.content ?? Buffer.alloc(0));
        if (entry.before.mode !== undefined) {
          await chmod(entry.path, entry.before.mode);
        }
      } else {
        try {
          await unlink(entry.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
      this.hcodeCreatedFiles.delete(entry.path);
    }

    const paths = checkpoint.map((entry) => path.relative(this.projectRoot, entry.path));
    this.history.pop();
    return `Restored ${paths.length} file${paths.length === 1 ? "" : "s"}: ${paths.join(", ")}`;
  }
}
