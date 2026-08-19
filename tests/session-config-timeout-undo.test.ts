import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readConfig, updateConfig } from "../src/config/store.ts";
import { CheckpointManager } from "../src/session/checkpoint.ts";
import { SessionManager, projectSessionHash } from "../src/session/manager.ts";
import { TimeoutError, withTimeout } from "../src/utils/timeout.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix = "hcode-test-"): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("configuration", () => {
  test("preserves API key and unknown fields when saving model or permissions", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ openRouterApiKey: "secret", custom: true }));
    await updateConfig({ model: "openrouter/free", permissions: "edit" }, configPath);
    expect(await readConfig(configPath)).toEqual({
      openRouterApiKey: "secret",
      custom: true,
      model: "openrouter/free",
      permissions: "edit",
    });
  });

  test("removes only the API key when it is reset", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      openRouterApiKey: "secret",
      model: "openrouter/free",
      permissions: "auto",
    }));
    await updateConfig({ openRouterApiKey: undefined }, configPath);
    expect(await readConfig(configPath)).toEqual({
      model: "openrouter/free",
      permissions: "auto",
    });
  });

  test("stores GitHub preferences but strips every GitHub token field", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.json");
    await updateConfig({
      github: {
        enabled: true,
        toolsets: ["repos", "issues", "pull_requests"],
        readOnly: true,
        token: "github_pat_abcdefghijklmnopqrstuvwxyz123456",
      } as never,
      githubToken: "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    }, configPath);
    const raw = await readFile(configPath, "utf8");
    expect(raw).not.toContain("github_pat_");
    expect(await readConfig(configPath)).toEqual({
      github: {
        enabled: true,
        toolsets: ["repos", "issues", "pull_requests"],
        readOnly: true,
      },
    });
  });
});

describe("sessions", () => {
  test("saves and loads only the latest session for the same project", async () => {
    const base = await temporaryDirectory();
    const root = await temporaryDirectory("hcode-project-");
    const manager = new SessionManager(root, base);
    manager.startNew();
    await manager.save([{ role: "user", content: "use sk-or-v1-secretvalue" }], "openrouter/free");
    const loaded = await new SessionManager(root, base).loadLatest();
    expect(loaded?.messages[0]?.content).toContain("REDACTED");
    expect(loaded?.messages[0]?.content).not.toContain("secretvalue");
    expect(loaded?.projectHash).toBe(projectSessionHash(root));
    expect(await new SessionManager(`${root}-other`, base).loadLatest()).toBeNull();
  });

  test("never stores GitHub tokens in sessions", async () => {
    const base = await temporaryDirectory();
    const root = await temporaryDirectory("hcode-project-");
    const manager = new SessionManager(root, base);
    manager.startNew();
    const token = "github_pat_abcdefghijklmnopqrstuvwxyz123456";
    const saved = await manager.save([{ role: "user", content: `use ${token}` }], "openrouter/free");
    expect(saved.messages[0]?.content).toContain("[REDACTED]");
    expect(saved.messages[0]?.content).not.toContain(token);
  });
});

describe("checkpoints and undo", () => {
  test("restores exactly the captured files", async () => {
    const root = await temporaryDirectory("hcode-undo-");
    const target = path.join(root, "target.txt");
    const unrelated = path.join(root, "unrelated.txt");
    await writeFile(target, "before");
    await writeFile(unrelated, "user work");
    const checkpoints = new CheckpointManager(root);
    checkpoints.beginOperation();
    await checkpoints.capture("target.txt");
    await writeFile(target, "after");
    await checkpoints.finishOperation();
    expect(await checkpoints.undoLast()).toContain("target.txt");
    expect(await readFile(target, "utf8")).toBe("before");
    expect(await readFile(unrelated, "utf8")).toBe("user work");
  });

  test("refuses undo when a file changed after the checkpoint", async () => {
    const root = await temporaryDirectory("hcode-undo-");
    const target = path.join(root, "target.txt");
    await writeFile(target, "before");
    const checkpoints = new CheckpointManager(root);
    checkpoints.beginOperation();
    await checkpoints.capture("target.txt");
    await writeFile(target, "after");
    await checkpoints.finishOperation();
    await writeFile(target, "new user edit");
    await expect(checkpoints.undoLast()).rejects.toThrow("changed after");
    expect(await readFile(target, "utf8")).toBe("new user edit");
  });
});

describe("timeouts", () => {
  test("aborts and rejects stalled operations", async () => {
    await expect(withTimeout(
      () => new Promise<void>(() => undefined),
      10,
      "Test operation",
    )).rejects.toBeInstanceOf(TimeoutError);
  });
});
