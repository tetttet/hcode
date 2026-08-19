import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitDiff, gitStatus } from "../src/tools/git.ts";

const temporaryDirectories: string[] = [];

async function run(root: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(await new Response(child.stderr).text());
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("git tools", () => {
  test("shows working changes without exposing protected files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hcode-git-"));
    temporaryDirectories.push(root);
    await run(root, ["init", "--quiet"]);
    await writeFile(path.join(root, "safe.txt"), "before\n");
    await writeFile(path.join(root, ".env"), "SECRET=before\n");
    await run(root, ["add", "."]);
    await writeFile(path.join(root, "safe.txt"), "after\n");
    await writeFile(path.join(root, ".env"), "SECRET=after\n");

    const status = await gitStatus(root);
    const diff = await gitDiff(root);
    expect(status).toContain("safe.txt");
    expect(status).not.toContain(".env");
    expect(diff).toContain("safe.txt");
    expect(diff).not.toContain("SECRET");
    expect(diff).not.toContain(".env");
  });
});
