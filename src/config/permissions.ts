export type PermissionMode = "safe" | "edit" | "auto";

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  safe: "Safe",
  edit: "Edit",
  auto: "Auto",
};

export function parsePermissionMode(value: string): PermissionMode | null {
  const normalized = value.trim().toLowerCase();
  return normalized === "safe" || normalized === "edit" || normalized === "auto"
    ? normalized
    : null;
}

export function requiresFileEditConfirmation(mode: PermissionMode): boolean {
  return mode === "safe";
}

export function dangerousCommandReason(command: string): string | null {
  if (/\b(?:sudo|shutdown|reboot|poweroff|halt)\b/i.test(command)) {
    return "privileged or system shutdown commands are blocked";
  }
  if (/(?:^|[^\w])mkfs(?:\.[\w-]+)?\b/i.test(command)) {
    return "filesystem formatting commands are blocked";
  }
  if (/\b(?:dd)\s+[^\n]*(?:of=\/dev\/|if=\/dev\/(?:zero|random|urandom))/i.test(command)) {
    return "raw device writes are blocked";
  }

  const rmCommands = command.matchAll(
    /(?:^|[;&|]\s*|\s)(?:[^\s;&|]*\/)?rm\s+([^;&|\n]*)/gi,
  );
  for (const match of rmCommands) {
    const argumentsText = match[1] ?? "";
    const flags = argumentsText.match(/--recursive|--force|-[a-zA-Z]+/g) ?? [];
    const recursive = flags.some(
      (flag) => flag === "--recursive" || flag.slice(1).toLowerCase().includes("r"),
    );
    const force = flags.some(
      (flag) => flag === "--force" || flag.slice(1).toLowerCase().includes("f"),
    );
    if (recursive && force) {
      return "recursive forced deletion (rm -rf) is blocked";
    }
  }

  return null;
}

const SAFE_DEVELOPMENT_COMMANDS = [
  /^(?:bun|npm|pnpm|yarn)\s+test(?:\s+[^;&|`$<>]*)?$/,
  /^(?:bun|npm|pnpm|yarn)\s+run\s+(?:test|typecheck|check|lint|build)(?::[\w.-]+)?(?:\s+[^;&|`$<>]*)?$/,
  /^bunx\s+(?:tsc|eslint|biome)(?:\s+[^;&|`$<>]*)?$/,
  /^npx\s+(?:tsc|eslint|biome)(?:\s+[^;&|`$<>]*)?$/,
  /^git\s+(?:status|diff|log|show)(?:\s+[^;&|`$<>]*)?$/,
  /^(?:cargo\s+(?:test|check)|go\s+test|pytest)(?:\s+[^;&|`$<>]*)?$/,
];

export function isSafeDevelopmentCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  return SAFE_DEVELOPMENT_COMMANDS.some((pattern) => pattern.test(normalized));
}

export function requiresShellConfirmation(
  mode: PermissionMode,
  command: string,
): boolean {
  return mode !== "auto" || !isSafeDevelopmentCommand(command);
}

export interface ExternalToolSafety {
  readOnly: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  sensitive?: boolean;
}

export function requiresExternalToolConfirmation(
  mode: PermissionMode,
  safety: ExternalToolSafety,
): boolean {
  if (safety.readOnly) return false;
  if (mode === "safe" || mode === "edit") return true;
  if (safety.sensitive || safety.destructive !== false) return true;
  return safety.idempotent !== true;
}
