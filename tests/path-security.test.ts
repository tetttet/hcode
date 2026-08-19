import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveProjectPath } from "../src/tools/path-security.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
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

describe("project path security", () => {
  test("rejects parent traversal and absolute escapes", async () => {
    const root = await temporaryDirectory("hcode-path-");
    await expect(resolveProjectPath(root, "../outside.txt")).rejects.toThrow("Parent path");
    await expect(resolveProjectPath(root, "/tmp/outside.txt")).rejects.toThrow("outside");
  });

  test("rejects symlink escapes", async () => {
    const root = await temporaryDirectory("hcode-root-");
    const outside = await temporaryDirectory("hcode-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "link"));
    await expect(resolveProjectPath(root, "link/secret.txt")).rejects.toThrow("outside");
  });

  test("protects environment files but permits templates", async () => {
    const root = await temporaryDirectory("hcode-env-");
    await mkdir(path.join(root, "config"));
    await expect(
      resolveProjectPath(root, "config/.env.local", { protectSecrets: true }),
    ).rejects.toThrow("Protected");
    await expect(
      resolveProjectPath(root, ".env.example", { protectSecrets: true }),
    ).resolves.toBe(path.join(root, ".env.example"));
  });
});
