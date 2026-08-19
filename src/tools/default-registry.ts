import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { ProjectCache } from "../context/cache.ts";
import type { ContextManager } from "../context/manager.ts";
import { buildRepoMap, formatRepoMap } from "../context/repo-map.ts";
import {
  deleteProjectFile,
  listFiles,
  moveProjectFile,
  readProjectFile,
  writeProjectFile,
  type ToolInteraction,
  resolveProjectPath,
} from "./files.ts";
import { findReferences, findTests } from "./discovery.ts";
import { gitDiff, gitStatus } from "./git.ts";
import { readStoredCommandOutput } from "./output.ts";
import { applyProjectPatch } from "./patch.ts";
import { ToolRegistry, type RegisteredTool } from "./registry.ts";
import { searchCode } from "./search.ts";
import { runProjectCommand } from "./shell.ts";

function requiredString(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`Argument ${key} must be a ${allowEmpty ? "" : "non-empty "}string.`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Argument ${key} must be a string.`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Argument ${key} must be a number.`);
  }
  return Math.trunc(value);
}

function definition(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): RegisteredTool["definition"] {
  return { type: "function", function: { name, description, parameters } };
}

export interface DefaultToolRegistryOptions {
  projectRoot: string;
  cache: ProjectCache;
  context: ContextManager;
  interaction(signal: AbortSignal): ToolInteraction;
  updatePlan(value: unknown): string;
}

export function createDefaultToolRegistry(options: DefaultToolRegistryOptions): ToolRegistry {
  const tools: RegisteredTool[] = [
    {
      definition: definition(
        "repo_map",
        "Build a compact, cached source map with imports and symbols. Prefer this over listing many files.",
        {
          type: "object",
          properties: { maxFiles: { type: "integer", minimum: 1, maximum: 1_000 } },
          additionalProperties: false,
        },
      ),
      readOnly: true,
      execute: async (args, signal) => {
        options.interaction(signal).action("Building repository map");
        const map = await buildRepoMap(options.projectRoot, {
          cache: options.cache,
          maxFiles: optionalNumber(args, "maxFiles"),
          signal,
        });
        options.context.markRepoMapReady();
        return formatRepoMap(map);
      },
    },
    {
      definition: definition(
        "list_files",
        "List a bounded set of project files. Prefer repo_map or search_code on large projects.",
        { type: "object", properties: {}, additionalProperties: false },
      ),
      readOnly: true,
      execute: async (_args, signal) => listFiles(options.projectRoot, options.interaction(signal)),
    },
    {
      definition: definition(
        "read_file",
        "Read a UTF-8 file or a relevant line range. Returns the selected range and total line count.",
        {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
          },
          required: ["path"],
          additionalProperties: false,
        },
      ),
      readOnly: true,
      execute: async (args, signal) => {
        const filePath = requiredString(args, "path");
        const startLine = optionalNumber(args, "startLine");
        const endLine = optionalNumber(args, "endLine");
        const range = `${startLine ?? 1}:${endLine ?? "auto"}`;
        const absolutePath = await resolveProjectPath(options.projectRoot, filePath, {
          protectSecrets: true,
        });
        const before = await lstat(absolutePath);
        if (options.context.canReuseRead(filePath, before.size, before.mtimeMs, range)) {
          return `File already loaded and unchanged: ${filePath} (${range}). Use the previous result.`;
        }
        const result = await readProjectFile(
          options.projectRoot,
          filePath,
          options.interaction(signal),
          {
            startLine,
            endLine,
          },
        );
        options.context.recordRead(
          filePath,
          createHash("sha256").update(result).digest("hex").slice(0, 16),
          { size: before.size, mtimeMs: before.mtimeMs, range },
        );
        return result;
      },
    },
    {
      definition: definition(
        "search_code",
        "Search project text and return compact file:line matches. Search before reading broad files.",
        {
          type: "object",
          properties: {
            query: { type: "string" },
            path: { type: "string" },
            glob: { type: "string" },
            maxResults: { type: "integer", minimum: 1, maximum: 200 },
          },
          required: ["query"],
          additionalProperties: false,
        },
      ),
      readOnly: true,
      execute: async (args, signal) => {
        const searchOptions = {
          query: requiredString(args, "query"),
          path: optionalString(args, "path"),
          glob: optionalString(args, "glob"),
          maxResults: optionalNumber(args, "maxResults"),
        };
        const result = await searchCode(
          options.projectRoot,
          searchOptions,
          options.interaction(signal),
        );
        await options.cache.setSearch(JSON.stringify(searchOptions), result);
        await options.cache.save().catch(() => undefined);
        return result;
      },
    },
    {
      definition: definition(
        "find_references",
        "Find practical definitions, imports, references, and test uses for a symbol.",
        {
          type: "object",
          properties: { symbol: { type: "string" } },
          required: ["symbol"],
          additionalProperties: false,
        },
      ),
      readOnly: true,
      execute: async (args, signal) => findReferences(
        options.projectRoot,
        requiredString(args, "symbol"),
        options.interaction(signal),
      ),
    },
    {
      definition: definition(
        "find_tests",
        "Find the most likely tests related to a changed or inspected source file.",
        {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      ),
      readOnly: true,
      execute: async (args, signal) => findTests(
        options.projectRoot,
        requiredString(args, "path"),
        options.interaction(signal),
      ),
    },
    {
      definition: definition(
        "apply_patch",
        "Replace one unique oldText occurrence in an existing project file.",
        {
          type: "object",
          properties: {
            path: { type: "string" },
            oldText: { type: "string" },
            newText: { type: "string" },
          },
          required: ["path", "oldText", "newText"],
          additionalProperties: false,
        },
      ),
      readOnly: false,
      execute: async (args, signal) => {
        const filePath = requiredString(args, "path");
        const result = await applyProjectPatch(
          options.projectRoot,
          filePath,
          requiredString(args, "oldText"),
          requiredString(args, "newText", true),
          options.interaction(signal),
        );
        if (!result.startsWith("User declined")) options.context.recordModified(filePath);
        options.cache.invalidateSearches();
        return result;
      },
    },
    {
      definition: definition(
        "write_file",
        "Create a file, or replace an entire file only when necessary.",
        {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
          additionalProperties: false,
        },
      ),
      readOnly: false,
      execute: async (args, signal) => {
        const filePath = requiredString(args, "path");
        const result = await writeProjectFile(
          options.projectRoot,
          filePath,
          requiredString(args, "content", true),
          options.interaction(signal),
        );
        if (!result.startsWith("User declined")) options.context.recordModified(filePath);
        options.cache.invalidateSearches();
        return result;
      },
    },
    {
      definition: definition(
        "move_file",
        "Move one project file to another safe project path.",
        {
          type: "object",
          properties: { source: { type: "string" }, destination: { type: "string" } },
          required: ["source", "destination"],
          additionalProperties: false,
        },
      ),
      readOnly: false,
      execute: async (args, signal) => {
        const source = requiredString(args, "source");
        const destination = requiredString(args, "destination");
        const result = await moveProjectFile(
          options.projectRoot,
          source,
          destination,
          options.interaction(signal),
        );
        if (!result.startsWith("User declined")) options.context.recordMove(source, destination);
        options.cache.invalidateSearches();
        return result;
      },
    },
    {
      definition: definition(
        "delete_file",
        "Delete one project file. Directories and secret files are refused.",
        {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      ),
      readOnly: false,
      execute: async (args, signal) => {
        const filePath = requiredString(args, "path");
        const result = await deleteProjectFile(
          options.projectRoot,
          filePath,
          options.interaction(signal),
        );
        if (!result.startsWith("User declined")) options.context.recordModified(filePath);
        options.cache.invalidateSearches();
        return result;
      },
    },
    {
      definition: definition(
        "run_command",
        "Run a project command with permissions and timeout. Output is reduced to useful diagnostics.",
        {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      ),
      readOnly: false,
      execute: async (args, signal) => runProjectCommand(
        options.projectRoot,
        requiredString(args, "command"),
        options.interaction(signal),
      ),
    },
    {
      definition: definition(
        "read_command_output",
        "Read a range from full output previously identified by run_command.",
        {
          type: "object",
          properties: {
            id: { type: "string" },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
          },
          required: ["id"],
          additionalProperties: false,
        },
      ),
      readOnly: true,
      execute: async (args) => readStoredCommandOutput(
        requiredString(args, "id"),
        optionalNumber(args, "startLine"),
        optionalNumber(args, "endLine"),
      ),
    },
    {
      definition: definition(
        "git_status",
        "Show compact Git working-tree status.",
        { type: "object", properties: {}, additionalProperties: false },
      ),
      readOnly: true,
      execute: async (_args, signal) => gitStatus(options.projectRoot, options.interaction(signal)),
    },
    {
      definition: definition(
        "git_diff",
        "Show a diff summary and current diff, optionally for one file.",
        {
          type: "object",
          properties: { path: { type: "string" } },
          additionalProperties: false,
        },
      ),
      readOnly: true,
      execute: async (args, signal) => gitDiff(
        options.projectRoot,
        options.interaction(signal),
        optionalString(args, "path"),
      ),
    },
    {
      definition: definition(
        "update_plan",
        "Update a short plan for a genuinely multi-step task.",
        {
          type: "object",
          properties: {
            plan: {
              type: "array",
              maxItems: 12,
              items: {
                type: "object",
                properties: {
                  step: { type: "string" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                },
                required: ["step", "status"],
                additionalProperties: false,
              },
            },
          },
          required: ["plan"],
          additionalProperties: false,
        },
      ),
      readOnly: false,
      invalidatesRepository: false,
      execute: async (args) => options.updatePlan(args.plan),
    },
  ];
  return new ToolRegistry(tools);
}
