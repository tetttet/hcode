import { describe, expect, test } from "bun:test";
import {
  dangerousCommandReason,
  isSafeDevelopmentCommand,
  requiresFileEditConfirmation,
  requiresShellConfirmation,
} from "../src/config/permissions.ts";
import { runProjectCommand } from "../src/tools/shell.ts";
import { TimeoutError } from "../src/utils/timeout.ts";

describe("permissions", () => {
  test("Safe confirms edits and shell, Edit only confirms shell", () => {
    expect(requiresFileEditConfirmation("safe")).toBe(true);
    expect(requiresFileEditConfirmation("edit")).toBe(false);
    expect(requiresShellConfirmation("safe", "bun test")).toBe(true);
    expect(requiresShellConfirmation("edit", "bun test")).toBe(true);
  });

  test("Auto approves only allowlisted development commands", () => {
    expect(isSafeDevelopmentCommand("bun test")).toBe(true);
    expect(requiresShellConfirmation("auto", "bun test")).toBe(false);
    expect(requiresShellConfirmation("auto", "curl example.com")).toBe(true);
    expect(requiresShellConfirmation("auto", "git reset --hard")).toBe(true);
    expect(requiresShellConfirmation("auto", "bun run destroy-data")).toBe(true);
  });

  test("dangerous shell commands remain blocked", async () => {
    expect(dangerousCommandReason("rm -rf /tmp/example")).toContain("deletion");
    expect(dangerousCommandReason("sudo echo no")).toContain("privileged");
    await expect(runProjectCommand(process.cwd(), "rm -rf /tmp/example", {
      confirm: async () => true,
      action: () => undefined,
      permissionMode: "auto",
    })).rejects.toThrow("refused");
  });

  test("shell commands are terminated on timeout", async () => {
    await expect(runProjectCommand(process.cwd(), "sleep 1", {
      confirm: async () => true,
      action: () => undefined,
      permissionMode: "safe",
    }, 10)).rejects.toBeInstanceOf(TimeoutError);
  });
});
