import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpClient } from "../src/mcp/client.ts";
import {
  GithubMcpManager,
  GITHUB_RELEASE_API,
  installGithubMcpServer,
  namespaceGithubToolName,
  parseGitHubRepositoryUrl,
  selectGithubReleaseAssets,
} from "../src/mcp/github.ts";
import { redactGithubSecrets } from "../src/mcp/security.ts";
import type { McpTool, McpToolResult } from "../src/mcp/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

const readTool: McpTool = {
  name: "get_file_contents",
  description: "Read a repository file.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

const writeTool: McpTool = {
  name: "create_issue",
  title: "create issue",
  description: "Create an issue.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

function fakeClient(options: {
  tools?: McpTool[];
  call?(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  onClose?(): void;
} = {}): McpClient {
  return {
    initialize: async () => ({
      protocolVersion: "2025-11-25",
      capabilities: {},
      serverInfo: { name: "mock", version: "1" },
    }),
    listTools: async () => options.tools ?? [readTool, writeTool],
    callTool: async (name: string, args: Record<string, unknown>) =>
      options.call?.(name, args) ?? { content: [{ type: "text", text: "ok" }] },
    close: async () => { options.onClose?.(); },
    getServerInfo: () => ({ name: "mock", version: "1" }),
  } as unknown as McpClient;
}

describe("GitHub MCP manager", () => {
  test("is lazy and has zero server startup without a token", async () => {
    let creations = 0;
    const manager = new GithubMcpManager({
      projectRoot: process.cwd(),
      token: "",
      command: "mock",
      clientFactory: () => { creations += 1; return fakeClient(); },
    });
    expect(manager.isConfigured()).toBe(false);
    expect((await manager.status()).state).toBe("not-configured");
    expect(creations).toBe(0);
    expect(manager.configurationHelp()).toContain("GITHUB_TOKEN");
  });

  test("maps GITHUB_TOKEN only into the child MCP environment", async () => {
    const token = "github_pat_abcdefghijklmnopqrstuvwxyz123456";
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    const manager = new GithubMcpManager({
      projectRoot: process.cwd(),
      token,
      command: "mock",
      clientFactory: (_launch, env) => { childEnvironment = env; return fakeClient(); },
    });
    await manager.connect();
    expect(childEnvironment?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(token);
    expect(childEnvironment?.GITHUB_TOKEN).toBeUndefined();
    await manager.close();
  });

  test("registers dynamically discovered tools with a safe namespace", async () => {
    const manager = new GithubMcpManager({
      projectRoot: process.cwd(), token: "token", command: "mock",
      clientFactory: () => fakeClient(),
    });
    const registry = new ToolRegistry();
    expect(await manager.registerTools(registry)).toBe(2);
    expect(registry.definitions().map((definition) => definition.function.name)).toEqual([
      "github_get_file_contents",
      "github_create_issue",
    ]);
    expect(namespaceGithubToolName("a".repeat(100))).toHaveLength(64);
    await manager.close();
  });

  test("read-only mode filters mutation tools from the registry", async () => {
    let launchArgs: string[] = [];
    const manager = new GithubMcpManager({
      projectRoot: process.cwd(), token: "token", command: "mock",
      config: { readOnly: true },
      clientFactory: (launch) => { launchArgs = launch.args; return fakeClient(); },
    });
    const registry = new ToolRegistry();
    await manager.registerTools(registry);
    expect(registry.definitions().map((definition) => definition.function.name)).toEqual([
      "github_get_file_contents",
    ]);
    expect(launchArgs).toContain("--read-only");
    expect(launchArgs.find((value) => value.startsWith("--toolsets="))).toContain("repos,issues,pull_requests,users");
    await manager.close();
  });

  test("reads without confirmation and confirms GitHub mutations with compact context", async () => {
    const confirmations: string[] = [];
    const calls: string[] = [];
    const manager = new GithubMcpManager({
      projectRoot: process.cwd(), token: "token", command: "mock",
      permissionMode: () => "edit",
      confirm: async (message) => { confirmations.push(message); return false; },
      clientFactory: () => fakeClient({
        call: async (name) => { calls.push(name); return { content: [{ type: "text", text: "ok" }] }; },
      }),
    });
    const registry = new ToolRegistry();
    await manager.registerTools(registry);
    const signal = new AbortController().signal;
    await registry.get("github_get_file_contents")?.execute({}, signal);
    const declined = await registry.get("github_create_issue")?.execute({
      owner: "tetttet", repo: "hcode", title: "Fix session cache",
    }, signal);
    expect(calls).toEqual(["get_file_contents"]);
    expect(declined).toContain("declined");
    expect(confirmations[0]).toContain("Repository: tetttet/hcode");
    expect(confirmations[0]).toContain("Title: Fix session cache");
    expect(confirmations[0]).not.toContain("{\"");
    await manager.close();
  });

  test("turns MCP tool failures into compact redacted GitHub errors", async () => {
    const token = "github_pat_abcdefghijklmnopqrstuvwxyz123456";
    const manager = new GithubMcpManager({
      projectRoot: process.cwd(), token, command: "mock",
      clientFactory: () => fakeClient({
        tools: [readTool],
        call: async () => ({
          isError: true,
          content: [{ type: "text", text: `403 Forbidden ${token}` }],
        }),
      }),
    });
    const registry = new ToolRegistry();
    await manager.registerTools(registry);
    await expect(registry.get("github_get_file_contents")?.execute({
      owner: "tetttet", repo: "hcode",
    }, new AbortController().signal)).rejects.toThrow("GitHub MCP error");
    try {
      await registry.get("github_get_file_contents")?.execute({}, new AbortController().signal);
    } catch (error) {
      expect(String(error)).not.toContain(token);
      expect(String(error)).toContain("[REDACTED]");
    }
    await manager.close();
  });
});

describe("GitHub MCP helpers", () => {
  test("parses HTTPS and SSH GitHub origins without guessing non-GitHub remotes", () => {
    expect(parseGitHubRepositoryUrl("https://github.com/tetttet/hcode.git")).toBe("tetttet/hcode");
    expect(parseGitHubRepositoryUrl("git@github.com:tetttet/hcode.git")).toBe("tetttet/hcode");
    expect(parseGitHubRepositoryUrl("ssh://git@github.com/tetttet/hcode")).toBe("tetttet/hcode");
    expect(parseGitHubRepositoryUrl("https://gitlab.com/tetttet/hcode.git")).toBeNull();
  });

  test("selects only matching official release assets from metadata", () => {
    const selection = selectGithubReleaseAssets({ assets: [
      {
        name: "github-mcp-server_Darwin_arm64.tar.gz",
        browser_download_url: "https://github.com/github/github-mcp-server/releases/download/v1.0.0/github-mcp-server_Darwin_arm64.tar.gz",
      },
      {
        name: "github-mcp-server_1.0.0_checksums.txt",
        browser_download_url: "https://github.com/github/github-mcp-server/releases/download/v1.0.0/github-mcp-server_1.0.0_checksums.txt",
      },
    ] }, "darwin", "arm64");
    expect(selection.archive.name).toContain("Darwin_arm64");
    expect(() => selectGithubReleaseAssets({ assets: [{
      name: "github-mcp-server_Linux_x86_64.tar.gz",
      browser_download_url: "https://unofficial.example/server.tar.gz",
    }] }, "linux", "x64")).toThrow();
  });

  test("installs a checksum-verified official archive without sudo", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hcode-github-install-test-"));
    temporaryDirectories.push(root);
    const sourceDirectory = path.join(root, "source");
    await mkdir(sourceDirectory);
    const sourceBinary = path.join(sourceDirectory, "github-mcp-server");
    await writeFile(sourceBinary, "official mock binary");
    await chmod(sourceBinary, 0o755);
    const archivePath = path.join(root, "github-mcp-server_Darwin_arm64.tar.gz");
    const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", sourceDirectory, "github-mcp-server"], {
      stdout: "ignore", stderr: "pipe",
    });
    expect(await tar.exited).toBe(0);
    const archive = await readFile(archivePath);
    const checksum = createHash("sha256").update(archive).digest("hex");
    const archiveUrl = "https://github.com/github/github-mcp-server/releases/download/v1.0.0/github-mcp-server_Darwin_arm64.tar.gz";
    const checksumUrl = "https://github.com/github/github-mcp-server/releases/download/v1.0.0/github-mcp-server_1.0.0_checksums.txt";
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === GITHUB_RELEASE_API) return new Response(JSON.stringify({ assets: [
        { name: path.basename(archivePath), browser_download_url: archiveUrl },
        { name: "github-mcp-server_1.0.0_checksums.txt", browser_download_url: checksumUrl },
      ] }), { status: 200 });
      if (url === archiveUrl) return new Response(archive, { status: 200 });
      if (url === checksumUrl) {
        return new Response(`${checksum}  ${path.basename(archivePath)}\n`, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const installed = await installGithubMcpServer({
      binDirectory: path.join(root, "bin"),
      fetchImpl,
      platform: "darwin",
      architecture: "arm64",
    });
    expect(await readFile(installed, "utf8")).toBe("official mock binary");
    expect((await stat(installed)).mode & 0o777).toBe(0o755);
  });

  test("redacts exact and standard GitHub token forms", () => {
    const token = "github_pat_abcdefghijklmnopqrstuvwxyz123456";
    const output = redactGithubSecrets(`failed token=${token} ghp_abcdefghijklmnopqrstuvwxyz123456`);
    expect(output).not.toContain(token);
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(output.match(/\[REDACTED\]/g)?.length).toBe(2);
  });
});
