import { lstat, readFile, writeFile } from "node:fs/promises";
import { requiresFileEditConfirmation } from "../config/permissions.ts";
import type { ToolInteraction } from "./files.ts";
import { relativeDisplayPath, resolveProjectPath } from "./path-security.ts";

export async function applyProjectPatch(
  projectRoot: string,
  requestedPath: string,
  oldText: string,
  newText: string,
  interaction: ToolInteraction,
): Promise<string> {
  if (!oldText) {
    throw new Error("oldText must not be empty.");
  }
  const absolutePath = await resolveProjectPath(projectRoot, requestedPath, {
    protectSecrets: true,
  });
  const displayPath = relativeDisplayPath(projectRoot, absolutePath);
  const stats = await lstat(absolutePath);
  if (!stats.isFile()) {
    throw new Error(`${displayPath} is not a regular file.`);
  }

  const content = await readFile(absolutePath);
  const oldBytes = Buffer.from(oldText, "utf8");
  const firstMatch = content.indexOf(oldBytes);
  if (firstMatch === -1) {
    throw new Error(`oldText was not found in ${displayPath}.`);
  }
  if (content.indexOf(oldBytes, firstMatch + oldBytes.length) !== -1) {
    throw new Error(`oldText occurs more than once in ${displayPath}; the patch is ambiguous.`);
  }

  if (
    requiresFileEditConfirmation(interaction.permissionMode ?? "safe") &&
    !(await interaction.confirm(`Patch ${displayPath}? [y/N]`))
  ) {
    return `User declined the patch. ${displayPath} was not changed.`;
  }

  interaction.action(`Patching ${displayPath}`);
  if (interaction.signal?.aborted) {
    throw new Error("Operation cancelled.");
  }
  await interaction.checkpoint?.capture(requestedPath);
  const nextContent = Buffer.concat([
    content.subarray(0, firstMatch),
    Buffer.from(newText, "utf8"),
    content.subarray(firstMatch + oldBytes.length),
  ]);
  await writeFile(absolutePath, nextContent);
  return `Patched ${displayPath} (${oldBytes.length} bytes replaced).`;
}
