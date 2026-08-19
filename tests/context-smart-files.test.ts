import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.ts";
import { ProjectCache } from "../src/context/cache.ts";
import { ContextManager } from "../src/context/manager.ts";
import { buildRepoMap, formatRepoMap } from "../src/context/repo-map.ts";
import { listFiles, readProjectFile, type ToolInteraction } from "../src/tools/files.ts";
import { searchCode } from "../src/tools/search.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function interaction(): ToolInteraction {
  return { confirm: async () => true, action: () => undefined, permissionMode: "edit" };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("repository map and incremental cache", () => {
  test("extracts lightweight symbols for supported languages", async () => {
    const root = await temporaryDirectory("hcode-map-");
    const cacheRoot = await temporaryDirectory("hcode-cache-");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/session.ts"), [
      'import { db } from "./db";',
      "export interface Session {}",
      "export class SessionStore {}",
      "export function createSession() {}",
    ].join("\n"));
    await writeFile(path.join(root, "worker.py"), "import json\nclass Worker:\n    pass\ndef run():\n    pass\n");
    const map = await buildRepoMap(root, { cache: new ProjectCache(root, cacheRoot) });
    const formatted = formatRepoMap(map);
    expect(formatted).toContain("src/session.ts");
    expect(formatted).toContain("createSession");
    expect(formatted).toContain("SessionStore");
    expect(formatted).toContain("worker.py");
    expect(formatted).toContain("Worker");
  });

  test("reuses unchanged metadata and invalidates only changed files", async () => {
    const root = await temporaryDirectory("hcode-map-");
    const cacheRoot = await temporaryDirectory("hcode-cache-");
    const target = path.join(root, "file.ts");
    await writeFile(target, "export const before = 1;\n");
    await buildRepoMap(root, { cache: new ProjectCache(root, cacheRoot) });
    const reused = await buildRepoMap(root, { cache: new ProjectCache(root, cacheRoot) });
    expect(reused.reusedFromCache).toBe(1);

    await writeFile(target, "export const afterValue = 2;\n");
    const future = new Date(Date.now() + 2_000);
    await utimes(target, future, future);
    const rebuilt = await buildRepoMap(root, { cache: new ProjectCache(root, cacheRoot) });
    expect(rebuilt.reusedFromCache).toBe(0);
    expect(formatRepoMap(rebuilt)).toContain("afterValue");
  });

  test("ignores a corrupt cache and rebuilds", async () => {
    const root = await temporaryDirectory("hcode-map-");
    const cacheRoot = await temporaryDirectory("hcode-cache-");
    await writeFile(path.join(root, "file.ts"), "export const ready = true;\n");
    const cache = new ProjectCache(root, cacheRoot);
    await writeFile(cache.cachePath, "not json");
    const map = await buildRepoMap(root, { cache });
    expect(formatRepoMap(map)).toContain("ready");
    expect(JSON.parse(await readFile(cache.cachePath, "utf8"))).toHaveProperty("version", 1);
  });
});

describe("context budget and compaction", () => {
  test("tracks files and requests automatic compaction near the model limit", () => {
    const manager = new ContextManager();
    manager.recordRead("src/a.ts", "hash");
    manager.recordModified("src/a.ts");
    const messages = [
      { role: "system" as const, content: "system" },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: "user" as const,
        content: `${index} ${"x".repeat(3_000)}`,
      })),
    ];
    expect(manager.shouldAutoCompact(messages, 4_096)).toBe(true);
    const status = manager.status(messages, 4_096);
    expect(status.filesLoaded).toBe(1);
    expect(status.modifiedFiles).toEqual(["src/a.ts"]);
  });

  test("agent compaction preserves goal, changes, errors, verification, and plan", () => {
    const agent = new Agent({
      projectRoot: process.cwd(),
      apiKey: "unused",
      model: "openrouter/free",
      confirm: async () => false,
      action: () => undefined,
    });
    agent.loadHistory([
      { role: "user", content: "Fix authentication" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "1", type: "function",
          function: { name: "run_command", arguments: JSON.stringify({ command: "bun test" }) },
        }],
      },
      { role: "tool", tool_call_id: "1", content: "Exit code: 1\nerror src/auth.ts:4" },
    ], undefined, { plan: [{ step: "Fix auth", status: "in_progress" }] });
    const summary = agent.compact();
    expect(summary).toContain("Fix authentication");
    expect(summary).toContain("bun test");
    expect(summary).toContain("Fix auth");
    expect(agent.getHistory()).toHaveLength(1);
  });
});

describe("smart file reading and ignores", () => {
  test("reads bounded line ranges with total line metadata", async () => {
    const root = await temporaryDirectory("hcode-read-");
    await writeFile(path.join(root, "large.txt"), Array.from({ length: 5_000 }, (_, index) => `line ${index + 1}`).join("\n"));
    const ranged = await readProjectFile(root, "large.txt", interaction(), { startLine: 840, endLine: 850 });
    expect(ranged).toContain("Range: 840-850");
    expect(ranged).toContain("Total lines: 5000");
    expect(ranged).toContain("line 840");
    expect(ranged).not.toContain("line 839\n");
    const automatic = await readProjectFile(root, "large.txt", interaction());
    expect(automatic).toContain("Range: 1-400");
    expect(automatic).toContain("more lines");
  });

  test("detects binary files before UTF-8 decoding", async () => {
    const root = await temporaryDirectory("hcode-read-");
    await writeFile(path.join(root, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0xff]));
    const result = await readProjectFile(root, "image.bin", interaction());
    expect(result).toContain("appears to be binary");
  });

  test("applies .hcodeignore to discovery and search but permits explicit safe reads", async () => {
    const root = await temporaryDirectory("hcode-ignore-");
    await mkdir(path.join(root, "private"));
    await writeFile(path.join(root, ".hcodeignore"), "private/\n*.log\n");
    await writeFile(path.join(root, "private/hidden.ts"), "export const needle = 1;\n");
    await writeFile(path.join(root, "debug.log"), "needle\n");
    await writeFile(path.join(root, "visible.ts"), "export const visible = true;\n");
    const listed = await listFiles(root, interaction());
    expect(listed).toContain("visible.ts");
    expect(listed).not.toContain("hidden.ts");
    expect(listed).not.toContain("debug.log");
    const searched = await searchCode(root, { query: "needle" }, interaction(), null);
    expect(searched).toContain("No matches");
    expect(await readProjectFile(root, "private/hidden.ts", interaction())).toContain("needle");
  });
});
