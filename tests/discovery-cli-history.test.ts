import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createJsonResult,
  formatGithubDiagnostics,
  formatGithubStatus,
  parseCliArguments,
} from "../src/cli.ts";
import { formatDoctorReport, runDoctor } from "../src/doctor.ts";
import { findTests } from "../src/tools/discovery.ts";
import type { ToolInteraction } from "../src/tools/files.ts";
import { PromptHistory, isSafeHistoryEntry } from "../src/ui/history.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function interaction(): ToolInteraction {
  return { confirm: async () => true, action: () => undefined };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("test discovery", () => {
  test("ranks colocated and conventional tests for a source file", async () => {
    const root = await temporaryDirectory("hcode-tests-");
    await mkdir(path.join(root, "src/auth"), { recursive: true });
    await mkdir(path.join(root, "tests"));
    await writeFile(path.join(root, "src/auth/session.ts"), "export const session = true;\n");
    await writeFile(path.join(root, "src/auth/session.test.ts"), "import './session';\n");
    await writeFile(path.join(root, "tests/session.spec.ts"), "import '../src/auth/session';\n");
    await writeFile(path.join(root, "tests/unrelated.test.ts"), "test('other', () => {});\n");
    const result = await findTests(root, "src/auth/session.ts", interaction());
    expect(result.split("\n")[0]).toBe("src/auth/session.test.ts");
    expect(result).toContain("tests/session.spec.ts");
    expect(result).not.toContain("unrelated.test.ts");
  });
});

describe("non-interactive and JSON CLI", () => {
  test("parses prompt, JSON, continuation, and permission options", () => {
    expect(parseCliArguments([
      "--json", "--continue", "--permission", "edit", "-p", "fix tests",
    ])).toEqual({
      json: true,
      continueSession: true,
      permission: "edit",
      prompt: "fix tests",
    });
    expect(() => parseCliArguments(["--json"])).toThrow("requires");
    expect(parseCliArguments(["--help"]).command).toBe("help");
  });

  test("builds a stable machine-readable final result from execution events", () => {
    const result = createJsonResult(true, "done", [
      { type: "file_changed", path: "src/a.ts" },
      { type: "file_changed", path: "src/a.ts" },
      { type: "verification", command: "bun test", success: true, summary: "Exit code: 0" },
    ], { requests: 2, inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      success: true,
      message: "done",
      changedFiles: ["src/a.ts"],
      verification: [{ command: "bun test", success: true, summary: "Exit code: 0" }],
      usage: { requests: 2, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  test("prints only valid JSON and exit code 2 when non-interactive auth is missing", async () => {
    const root = await temporaryDirectory("hcode-json-project-");
    const home = await temporaryDirectory("hcode-json-home-");
    const cliPath = path.resolve(import.meta.dir, "../src/cli.ts");
    const child = Bun.spawn([process.execPath, cliPath, "--json", "-p", "inspect project"], {
      cwd: root,
      env: { ...process.env, HOME: home, OPENROUTER_API_KEY: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      success: false,
      changedFiles: [],
      verification: [],
    });
  });
});

describe("prompt history privacy", () => {
  test("excludes API keys and hidden key-change input", async () => {
    expect(isSafeHistoryEntry("fix the tests")).toBe(true);
    expect(isSafeHistoryEntry("/change")).toBe(false);
    expect(isSafeHistoryEntry("OPENROUTER_API_KEY=sk-or-v1-secret")).toBe(false);
    expect(isSafeHistoryEntry("github_pat_abcdefghijklmnopqrstuvwxyz123456")).toBe(false);
    const directory = await temporaryDirectory("hcode-history-");
    const historyPath = path.join(directory, "history");
    const history = new PromptHistory(historyPath, 3);
    await history.load();
    await history.record("first prompt");
    await history.record("sk-or-v1-supersecret");
    await history.record("second prompt");
    expect(await new PromptHistory(historyPath, 3).load()).toEqual(["first prompt", "second prompt"]);
    expect(await readFile(historyPath, "utf8")).not.toContain("supersecret");
  });
});

describe("GitHub CLI status", () => {
  test("prints setup help without a token and compact diagnostics when connected", () => {
    const base = {
      enabled: true,
      readOnly: false,
      toolsets: ["repos", "issues", "pull_requests"],
      error: undefined,
    };
    expect(formatGithubStatus({
      ...base,
      configured: false,
      state: "not-configured",
      serverAvailable: false,
      authenticated: null,
      tools: 0,
    })).toContain('export GITHUB_TOKEN="your_token"');
    const diagnostic = formatGithubDiagnostics({
      ...base,
      configured: true,
      state: "connected",
      serverAvailable: true,
      authenticated: true,
      tools: 24,
    });
    expect(diagnostic).toContain("✓ MCP connection");
    expect(diagnostic).toContain("Tools: 24");
  });
});

describe("doctor", () => {
  test("checks local installation without exposing the configured API key", async () => {
    const root = await temporaryDirectory("hcode-doctor-project-");
    const base = await temporaryDirectory("hcode-doctor-home-");
    const configPath = path.join(base, "config.json");
    await writeFile(configPath, "{}", { mode: 0o600 });
    const report = await runDoctor(root, { openRouterApiKey: "sk-or-v1-sensitive" }, {
      checkNetwork: false,
      configPath,
      baseDirectory: base,
    });
    const output = formatDoctorReport(report);
    expect(output).toContain("OpenRouter API key: configured");
    expect(output).toContain("Project permissions: read/write");
    expect(output).not.toContain("sensitive");
  });
});
