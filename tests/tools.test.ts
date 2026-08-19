import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolInteraction } from "../src/tools/files.ts";
import {
  deleteProjectFile,
  moveProjectFile,
  writeProjectFile,
} from "../src/tools/files.ts";
import { applyProjectPatch } from "../src/tools/patch.ts";
import { searchCode } from "../src/tools/search.ts";
import { CheckpointManager } from "../src/session/checkpoint.ts";

const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hcode-tools-"));
  temporaryDirectories.push(directory);
  return directory;
}

function interaction(overrides: Partial<ToolInteraction> = {}): ToolInteraction {
  return {
    confirm: async () => true,
    action: () => undefined,
    permissionMode: "edit",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("search_code", () => {
  test("returns bounded file and line matches while ignoring secrets", async () => {
    const root = await temporaryProject();
    await writeFile(path.join(root, "one.ts"), "first\nneedle here\nneedle again\n");
    await writeFile(path.join(root, ".env"), "needle=secret\n");
    const result = await searchCode(root, { query: "needle", maxResults: 1 }, interaction());
    expect(result).toContain("one.ts:2:");
    expect(result).not.toContain(".env");
    expect(result.split("\n")).toHaveLength(1);
  });

  test("uses the Bun streaming fallback when ripgrep is unavailable", async () => {
    const root = await temporaryProject();
    await writeFile(path.join(root, "fallback.ts"), "fallback needle\n");
    const result = await searchCode(
      root,
      { query: "needle", glob: "*.ts" },
      interaction(),
      null,
    );
    expect(result).toContain("fallback.ts:1:");
  });
});

describe("apply_patch", () => {
  test("replaces exactly one match and preserves surrounding bytes", async () => {
    const root = await temporaryProject();
    await writeFile(path.join(root, "file.txt"), Buffer.from([0x61, 0x0d, 0x0a, 0x62]));
    await applyProjectPatch(root, "file.txt", "a", "A", interaction());
    expect(await readFile(path.join(root, "file.txt"))).toEqual(Buffer.from([0x41, 0x0d, 0x0a, 0x62]));
  });

  test("rejects missing and ambiguous matches", async () => {
    const root = await temporaryProject();
    await writeFile(path.join(root, "file.txt"), "same same");
    await expect(
      applyProjectPatch(root, "file.txt", "missing", "x", interaction()),
    ).rejects.toThrow("not found");
    await expect(
      applyProjectPatch(root, "file.txt", "same", "x", interaction()),
    ).rejects.toThrow("ambiguous");
  });
});

describe("move_file and delete_file", () => {
  test("moves files and never overwrites without confirmation", async () => {
    const root = await temporaryProject();
    await writeFile(path.join(root, "source.txt"), "source");
    await writeFile(path.join(root, "destination.txt"), "destination");
    const result = await moveProjectFile(
      root,
      "source.txt",
      "destination.txt",
      interaction({ confirm: async () => false, permissionMode: "auto" }),
    );
    expect(result).toContain("declined");
    expect(await readFile(path.join(root, "source.txt"), "utf8")).toBe("source");
    expect(await readFile(path.join(root, "destination.txt"), "utf8")).toBe("destination");
  });

  test("moves a regular file inside the project", async () => {
    const root = await temporaryProject();
    await writeFile(path.join(root, "source.txt"), "source");
    await moveProjectFile(root, "source.txt", "nested/destination.txt", interaction());
    expect(await readFile(path.join(root, "nested/destination.txt"), "utf8")).toBe("source");
    await expect(readFile(path.join(root, "source.txt"))).rejects.toThrow();
  });

  test("deletes only a file after confirmation", async () => {
    const root = await temporaryProject();
    await writeFile(path.join(root, "remove.txt"), "remove");
    let confirmations = 0;
    await deleteProjectFile(root, "remove.txt", interaction({
      permissionMode: "auto",
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    }));
    expect(confirmations).toBe(1);
    await expect(readFile(path.join(root, "remove.txt"))).rejects.toThrow();
  });

  test("auto-deletes a file created by hcode in Edit mode", async () => {
    const root = await temporaryProject();
    const checkpoint = new CheckpointManager(root);
    const toolInteraction = interaction({
      checkpoint,
      confirm: async () => {
        throw new Error("unexpected confirmation");
      },
    });
    checkpoint.beginOperation();
    await writeProjectFile(root, "created.txt", "created", toolInteraction);
    await checkpoint.finishOperation();
    checkpoint.beginOperation();
    await deleteProjectFile(root, "created.txt", toolInteraction);
    await checkpoint.finishOperation();
    await expect(readFile(path.join(root, "created.txt"))).rejects.toThrow();
  });
});
