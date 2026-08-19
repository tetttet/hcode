import { describe, expect, test } from "bun:test";
import type { ToolCall, ToolDefinition } from "../src/openrouter.ts";
import { ToolRegistry, ToolScheduler, type RegisteredTool } from "../src/tools/registry.ts";
import { readStoredCommandOutput, reduceCommandOutput } from "../src/tools/output.ts";
import { withRetry } from "../src/utils/retry.ts";

function definition(name: string): ToolDefinition {
  return {
    type: "function",
    function: { name, description: name, parameters: { type: "object" } },
  };
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("tool scheduler", () => {
  test("runs independent read-only tools in parallel", async () => {
    let active = 0;
    let maximumActive = 0;
    const read: RegisteredTool = {
      definition: definition("read"),
      readOnly: true,
      execute: async (args) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await delay(20);
        active -= 1;
        return String(args.path);
      },
    };
    const scheduler = new ToolScheduler(new ToolRegistry([read]));
    const results = await scheduler.execute([
      call("1", "read", { path: "a" }),
      call("2", "read", { path: "b" }),
      call("3", "read", { path: "c" }),
    ], new AbortController().signal);
    expect(maximumActive).toBe(3);
    expect(results.map((result) => result.content)).toEqual(["a", "b", "c"]);
  });

  test("serializes mutations and preserves their order", async () => {
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const mutate: RegisteredTool = {
      definition: definition("mutate"),
      readOnly: false,
      execute: async (args) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        order.push(`start-${args.id}`);
        await delay(10);
        order.push(`end-${args.id}`);
        active -= 1;
        return "changed";
      },
    };
    await new ToolScheduler(new ToolRegistry([mutate])).execute([
      call("1", "mutate", { id: 1 }),
      call("2", "mutate", { id: 2 }),
    ], new AbortController().signal);
    expect(maximumActive).toBe(1);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  test("deduplicates identical reads and invalidates after a mutation", async () => {
    let reads = 0;
    const registry = new ToolRegistry([
      {
        definition: definition("read"),
        readOnly: true,
        execute: async () => {
          reads += 1;
          await delay(5);
          return `read-${reads}`;
        },
      },
      {
        definition: definition("mutate"),
        readOnly: false,
        execute: async () => "changed",
      },
    ]);
    const scheduler = new ToolScheduler(registry);
    const first = await scheduler.execute([
      call("1", "read", { path: "same" }),
      call("2", "read", { path: "same" }),
    ], new AbortController().signal);
    expect(reads).toBe(1);
    expect(first[1]?.cached).toBe(true);
    await scheduler.execute([call("3", "read", { path: "same" })], new AbortController().signal);
    expect(reads).toBe(1);
    await scheduler.execute([call("4", "mutate")], new AbortController().signal);
    await scheduler.execute([call("5", "read", { path: "same" })], new AbortController().signal);
    expect(reads).toBe(2);
  });
});

describe("retry helper", () => {
  test("retries bounded transient failures", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary");
      return "ok";
    }, { attempts: 3, baseDelayMs: 0, jitter: 0 });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("AbortController cancels retry backoff immediately", async () => {
    const controller = new AbortController();
    const pending = withRetry(async () => {
      throw new Error("temporary");
    }, { attempts: 3, baseDelayMs: 1_000, jitter: 0, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow("cancelled");
  });
});

describe("command output reducer", () => {
  test("surfaces diagnostics and keeps bounded full output available by range", () => {
    const output = [
      ...Array.from({ length: 200 }, (_, index) => `noise ${index}`),
      "FAIL src/auth.test.ts",
      "src/auth.test.ts:84: Expected 200, received 401",
    ].join("\n");
    const reduced = reduceCommandOutput("bun test", 1, output);
    expect(reduced).toContain("Exit code: 1");
    expect(reduced).toContain("src/auth.test.ts:84");
    expect(reduced).not.toContain("noise 20\nnoise 21");
    const id = reduced.match(/Full output: (cmd-[a-z0-9]+)/)?.[1];
    expect(id).toBeTruthy();
    expect(readStoredCommandOutput(id ?? "", 200, 202)).toContain("FAIL src/auth.test.ts");
  });
});
