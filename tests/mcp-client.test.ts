import { afterEach, describe, expect, test } from "bun:test";
import { McpClient } from "../src/mcp/client.ts";
import { StdioTransport } from "../src/mcp/stdio.ts";
import { TimeoutError } from "../src/utils/timeout.ts";

const clients: McpClient[] = [];
const serverPath = `${import.meta.dir}/fixtures/mock-mcp-server.ts`;

function client(mode = "normal", token = "github_pat_abcdefghijklmnopqrstuvwxyz123456") {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      MOCK_MCP_MODE: mode,
      MOCK_EXPECTED_TOKEN: token,
      GITHUB_PERSONAL_ACCESS_TOKEN: token,
      GITHUB_TOKEN: undefined,
    },
    secrets: [token],
  });
  const mcp = new McpClient(transport, { startup: 100, listTools: 100, callTool: 100 });
  clients.push(mcp);
  return { mcp, transport, token };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("MCP stdio client", () => {
  test("initializes, discovers tools, and calls tools over newline framing", async () => {
    const { mcp } = client();
    const initialized = await mcp.initialize();
    expect(initialized.serverInfo.name).toBe("mock-github-mcp");
    const tools = await mcp.listTools();
    expect(tools.map((tool) => tool.name)).toContain("get_file_contents");
    const result = await mcp.callTool("get_file_contents", {
      owner: "tetttet", repo: "hcode", path: "README.md",
    });
    expect(result.content?.[0]?.text).toContain("README.md");
  });

  test("maps authentication only to the server token environment", async () => {
    const { mcp } = client();
    await mcp.initialize();
    const result = await mcp.callTool("inspect_env", {});
    expect(result.content?.[0]?.text).toBe('{"mapped":true,"aliasPresent":false}');
  });

  test("rejects a server crash and redacts token diagnostics", async () => {
    const { mcp, transport, token } = client("crash");
    await mcp.initialize();
    await expect(mcp.callTool("get_me", {})).rejects.toThrow("server exited");
    expect(transport.diagnostics()).not.toContain(token);
  });

  test("times out startup and cleans up the process", async () => {
    const { mcp } = client("startup_timeout");
    await expect(mcp.initialize()).rejects.toBeInstanceOf(TimeoutError);
    await mcp.close();
  });

  test("times out tools/call and supports graceful shutdown", async () => {
    const { mcp } = client("tool_timeout");
    await mcp.initialize();
    await expect(mcp.callTool("get_me", {})).rejects.toBeInstanceOf(TimeoutError);
    await mcp.close();
  });

  test("never exposes a token written to server stderr", async () => {
    const { mcp, transport, token } = client("stderr_token");
    await mcp.initialize();
    await Bun.sleep(10);
    expect(transport.diagnostics()).toContain("[REDACTED]");
    expect(transport.diagnostics()).not.toContain(token);
  });
});
