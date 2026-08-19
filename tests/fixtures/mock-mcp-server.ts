import { createInterface } from "node:readline";

const mode = process.env.MOCK_MCP_MODE ?? "normal";
const expectedToken = process.env.MOCK_EXPECTED_TOKEN ?? "";

if (mode === "stderr_token") {
  process.stderr.write(`diagnostic GITHUB_PERSONAL_ACCESS_TOKEN=${process.env.GITHUB_PERSONAL_ACCESS_TOKEN}\n`);
}

const tools = [
  {
    name: "get_file_contents",
    description: "Read a file from a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } },
      required: ["owner", "repo", "path"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "get_me",
    description: "Get the authenticated GitHub user.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "inspect_env",
    description: "Inspect mock authentication mapping.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "create_issue",
    description: "Create an issue.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" } },
      required: ["owner", "repo", "title"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
];

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line) as {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (message.method === "initialize") {
    if (mode === "startup_timeout") return;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mock-github-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    if (mode === "crash") process.exit(9);
    if (mode === "tool_timeout") return;
    const name = message.params?.name;
    const args = message.params?.arguments;
    if (name === "inspect_env") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              mapped: Boolean(expectedToken) && process.env.GITHUB_PERSONAL_ACCESS_TOKEN === expectedToken,
              aliasPresent: Boolean(process.env.GITHUB_TOKEN),
            }),
          }],
        },
      });
      return;
    }
    if (name === "protocol_error") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: 403, message: "Forbidden" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: JSON.stringify({ name, args }) }] },
    });
  }
});
