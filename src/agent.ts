import {
  createChatCompletion,
  type ChatMessage,
  type ToolCall,
  type ToolDefinition,
} from "./openrouter.ts";
import path from "node:path";
import {
  listFiles,
  readProjectFile,
  writeProjectFile,
  type ToolInteraction,
} from "./tools/files.ts";
import { runProjectCommand } from "./tools/shell.ts";

const MAX_TOOL_ITERATIONS = 15;

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "Inspect the current project. Returns the project folder name, its absolute root, and all files recursively. Common generated and dependency directories are ignored.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file inside the project. Use a project-relative path and inspect files before editing them.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path, for example src/auth.ts",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or completely overwrite a UTF-8 text file inside the project. Existing files require user confirmation.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path, for example src/auth.ts",
          },
          content: {
            type: "string",
            description: "The complete new contents of the file",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the project root after user confirmation. Dangerous destructive or system commands are refused.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to run in the project root",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

function systemPrompt(projectRoot: string): string {
  const projectName = path.basename(path.resolve(projectRoot));

  return `You are hcode, an expert software-engineering agent working directly in the user's current project.

ENVIRONMENT
- Project name: ${JSON.stringify(projectName)}
- Project root: ${JSON.stringify(projectRoot)}
- The project root is fixed. Never access files outside it.
- With file tools, use only project-relative paths and never use parent path segments.

WORKING METHOD
1. Understand the requested outcome and think through the task before acting.
2. If the answer depends on the project, inspect the workspace with tools. Treat tool results as the source of truth.
3. Read relevant existing files before editing them. Keep changes focused and preserve unrelated code and user work.
4. For implementation requests, carry the task through to a finished result instead of only describing what the user could do.
5. After changes, run the most relevant available test, typecheck, lint, or build when proportionate. If verification is unavailable or fails, state that precisely.
6. Resolve straightforward ambiguity from project context. Ask a question only when different answers would materially change the result or risk user data.

ACCURACY AND SAFETY
- Never invent files, folders, requirements, tool results, or completed work.
- Never claim that a file was created, changed, or tested unless the corresponding tool succeeded.
- Do not assume the user mentioned a folder or feature that is absent from their message.
- When the user says "this folder" or equivalent, they mean the project root above unless they clearly name another folder.
- Do not modify unrelated files. Do not expose secrets. Do not run destructive commands.
- If a tool reports that the user declined an action, respect that decision and do not claim success.

COMMUNICATION
- Reply in the same language as the user unless they ask otherwise.
- Lead with the outcome. Be concise, direct, calm, and technically precise.
- Do not use canned greetings, filler, excessive headings, or repeated offers to do more work.
- Do not narrate hidden chain-of-thought. Give only useful conclusions, key decisions, and verification results.
- After making changes, briefly name what changed and how it was verified.
- If the project is empty, say so plainly while still identifying the project folder by its known name.`;
}

function parseArguments(toolCall: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(toolCall.function.arguments) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("arguments must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid arguments for ${toolCall.function.name}: ${detail}`);
  }
}

function requiredString(
  argumentsObject: Record<string, unknown>,
  key: string,
): string {
  const value = argumentsObject[key];
  if (typeof value !== "string") {
    throw new Error(`Argument ${key} must be a string.`);
  }
  return value;
}

async function executeTool(
  toolCall: ToolCall,
  projectRoot: string,
  interaction: ToolInteraction,
): Promise<string> {
  try {
    const args = parseArguments(toolCall);

    switch (toolCall.function.name) {
      case "list_files":
        return await listFiles(projectRoot, interaction);
      case "read_file":
        return await readProjectFile(
          projectRoot,
          requiredString(args, "path"),
          interaction,
        );
      case "write_file":
        return await writeProjectFile(
          projectRoot,
          requiredString(args, "path"),
          requiredString(args, "content"),
          interaction,
        );
      case "run_command":
        return await runProjectCommand(
          projectRoot,
          requiredString(args, "command"),
          interaction,
        );
      default:
        throw new Error(`Unknown tool: ${toolCall.function.name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Tool error: ${message}`;
  }
}

export interface AgentOptions extends ToolInteraction {
  projectRoot: string;
  apiKey: string;
}

export class Agent {
  private readonly messages: ChatMessage[];

  constructor(private readonly options: AgentOptions) {
    this.messages = [
      {
        role: "system",
        content: systemPrompt(options.projectRoot),
      },
    ];
  }

  clearHistory(): void {
    this.messages.splice(1);
  }

  async run(userInput: string): Promise<string> {
    this.messages.push({ role: "user", content: userInput });

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const assistantMessage = await createChatCompletion({
        apiKey: this.options.apiKey,
        messages: this.messages,
        tools: TOOL_DEFINITIONS,
      });
      this.messages.push(assistantMessage);

      const toolCalls = assistantMessage.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return assistantMessage.content?.trim() || "Done.";
      }

      for (const toolCall of toolCalls) {
        const result = await executeTool(
          toolCall,
          this.options.projectRoot,
          this.options,
        );
        this.messages.push({
          role: "tool",
          content: result,
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
        });
      }
    }

    throw new Error(
      `Stopped after ${MAX_TOOL_ITERATIONS} tool-call iterations to avoid an infinite loop.`,
    );
  }
}
