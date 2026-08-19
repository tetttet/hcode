#!/usr/bin/env bun

import { createInterface, type Interface } from "node:readline";
import { Agent, type AgentEvent, type SessionUsage } from "./agent.ts";
import { resolveActiveModel, validateModel } from "./config/models.ts";
import {
  parsePermissionMode,
  PERMISSION_LABELS,
  type PermissionMode,
} from "./config/permissions.ts";
import { readConfig, updateConfig, type HcodeConfig } from "./config/store.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";
import type { GithubStatus } from "./mcp/github.ts";
import { createTerminalLogo, YAHYA_TEXT_LOGO_FRAMES } from "./logo.ts";
import { renderMarkdown } from "./markdown.ts";
import { SessionManager } from "./session/manager.ts";
import { gitDiff, gitStatus } from "./tools/git.ts";
import { PromptHistory } from "./ui/history.ts";
import { installLatestHcode } from "./update.ts";
import { VERSION } from "./version.ts";

export const EXIT_CODES = {
  success: 0,
  taskFailed: 1,
  configuration: 2,
  cancelled: 3,
} as const;

const ANSI_ENABLED = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  white: "\x1b[97m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

function styled(value: string, ...codes: string[]): string {
  return ANSI_ENABLED ? `${codes.join("")}${value}${ANSI.reset}` : value;
}

class Spinner {
  private readonly logo = createTerminalLogo();
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private active = false;

  start(label: string): void {
    if (!process.stdout.isTTY) return;
    if (this.active) this.stop();
    this.active = true;
    if (this.logo.imageSequence) {
      const labelColumn = this.logo.columns + 1;
      process.stdout.write(
        `\r\x1b[2K\x1b7${this.logo.imageSequence}\x1b8\x1b[${labelColumn}C${styled(label, ANSI.dim)}`,
      );
      return;
    }
    const render = () => {
      const frame = YAHYA_TEXT_LOGO_FRAMES[this.frame] ?? YAHYA_TEXT_LOGO_FRAMES[0];
      process.stdout.write(`\r\x1b[2K${styled(frame, ANSI.white, ANSI.bold)} ${styled(label, ANSI.dim)}`);
      this.frame = (this.frame + 1) % YAHYA_TEXT_LOGO_FRAMES.length;
    };
    render();
    this.timer = setInterval(render, 100);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.active && this.logo.cleanupSequence) process.stdout.write(this.logo.cleanupSequence);
    if (process.stdout.isTTY && this.active) process.stdout.write("\r\x1b[2K");
    this.active = false;
  }
}

class PromptInput {
  private readonly queuedLines: string[] = [];
  private readonly waiting: Array<(line: string | null) => void> = [];
  private closed = false;
  private hideInput = false;
  private saveNextLine = false;
  private interruptHandler: () => void = () => this.close();

  private constructor(
    private readonly readline: Interface,
    private readonly history: PromptHistory,
  ) {
    const mutableReadline = readline as Interface & {
      _writeToOutput?(value: string): void;
      history?: string[];
    };
    const writeToOutput = mutableReadline._writeToOutput?.bind(readline);
    if (writeToOutput) {
      mutableReadline._writeToOutput = (value: string) => {
        if (!this.hideInput) writeToOutput(value);
      };
    }
    readline.on("line", (line) => {
      const shouldSave = this.saveNextLine && !this.hideInput;
      this.saveNextLine = false;
      if (shouldSave) {
        void this.history.record(line).catch(() => undefined);
      } else if (mutableReadline.history?.[0] === line) {
        mutableReadline.history.shift();
      }
      const resolve = this.waiting.shift();
      if (resolve) resolve(line);
      else this.queuedLines.push(line);
    });
    readline.on("SIGINT", () => this.interruptHandler());
    readline.on("close", () => {
      this.closed = true;
      for (const resolve of this.waiting.splice(0)) resolve(null);
    });
  }

  static async create(): Promise<PromptInput> {
    const history = new PromptHistory();
    const entries = await history.load().catch(() => []);
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: 500,
      removeHistoryDuplicates: true,
    });
    (readline as Interface & { history?: string[] }).history = [...entries].reverse();
    return new PromptInput(readline, history);
  }

  onInterrupt(handler: () => void): void { this.interruptHandler = handler; }
  cancelPendingQuestion(): void { this.waiting.shift()?.(null); }

  ask(prompt: string, saveHistory = false): Promise<string | null> {
    process.stdout.write(prompt);
    this.saveNextLine = saveHistory;
    const queued = this.queuedLines.shift();
    if (queued !== undefined) {
      this.saveNextLine = false;
      if (saveHistory) void this.history.record(queued).catch(() => undefined);
      return Promise.resolve(queued);
    }
    if (this.closed) {
      this.saveNextLine = false;
      return Promise.resolve(null);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async askSecret(prompt: string): Promise<string | null> {
    this.hideInput = true;
    try {
      return await this.ask(prompt, false);
    } finally {
      this.hideInput = false;
      process.stdout.write("\n");
    }
  }

  close(): void { if (!this.closed) this.readline.close(); }
}

export interface CliArguments {
  continueSession: boolean;
  json: boolean;
  prompt?: string;
  permission?: PermissionMode;
  command?: "version" | "update" | "doctor" | "help";
}

export function parseCliArguments(args: string[]): CliArguments {
  const parsed: CliArguments = { continueSession: false, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--version" || argument === "-v") parsed.command = "version";
    else if (argument === "--help" || argument === "-h") parsed.command = "help";
    else if (argument === "--update") parsed.command = "update";
    else if (argument === "doctor" || argument === "--doctor") parsed.command = "doctor";
    else if (argument === "--continue" || argument === "-c") parsed.continueSession = true;
    else if (argument === "--json") parsed.json = true;
    else if (argument === "-p" || argument === "--prompt") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a prompt.`);
      parsed.prompt = value;
      index += 1;
    } else if (argument.startsWith("--prompt=")) {
      parsed.prompt = argument.slice("--prompt=".length);
    } else if (argument === "--permission") {
      const value = args[index + 1];
      const permission = value ? parsePermissionMode(value) : null;
      if (!permission) throw new Error("--permission must be safe, edit, or auto.");
      parsed.permission = permission;
      index += 1;
    } else if (argument.startsWith("--permission=")) {
      const permission = parsePermissionMode(argument.slice("--permission=".length));
      if (!permission) throw new Error("--permission must be safe, edit, or auto.");
      parsed.permission = permission;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (parsed.json && !parsed.prompt) throw new Error("--json requires --prompt/-p.");
  if (parsed.prompt !== undefined && !parsed.prompt.trim()) throw new Error("Prompt cannot be empty.");
  if (parsed.command && (parsed.prompt || parsed.json || parsed.permission)) {
    throw new Error(`${parsed.command} cannot be combined with agent prompt options.`);
  }
  return parsed;
}

function savedApiKey(config: HcodeConfig): string | null {
  return typeof config.openRouterApiKey === "string" && config.openRouterApiKey.trim()
    ? config.openRouterApiKey.trim()
    : null;
}

async function getInteractiveApiKey(prompt: PromptInput, config: HcodeConfig): Promise<string> {
  const existing = process.env.OPENROUTER_API_KEY?.trim() || savedApiKey(config);
  if (existing) return existing;
  console.log("Welcome to hcode\n\nOpenRouter API key not configured.\n\nEnter your OpenRouter API key:");
  while (true) {
    const entered = await prompt.askSecret("> ");
    if (entered === null) throw new Error("API key input was cancelled.");
    const apiKey = entered.trim();
    if (!apiKey) {
      console.log("API key cannot be empty. Please try again.");
      continue;
    }
    await updateConfig({ openRouterApiKey: apiKey });
    return apiKey;
  }
}

function printHeader(projectRoot: string, permissions: PermissionMode): void {
  console.log(`${styled(YAHYA_TEXT_LOGO_FRAMES[0], ANSI.white, ANSI.bold)} ${styled("hcode", ANSI.bold)} ${styled(VERSION, ANSI.dim)}`);
  console.log(`${styled("Project:", ANSI.dim)} ${projectRoot}`);
  console.log(`${styled("Permissions:", ANSI.dim)} ${PERMISSION_LABELS[permissions]}\n`);
}

function printHelp(): void {
  console.log(styled("Commands:", ANSI.bold));
  console.log("/model [current|provider/model]  Show or select model");
  console.log("/permissions [safe|edit|auto]   Show or select permissions");
  console.log("/context                         Show context budget and loaded files");
  console.log("/status                          Show project/session status");
  console.log("/usage                           Show provider token/cost usage");
  console.log("/diff [path]                     Show diff summary and patch");
  console.log("/checkpoints                     List reversible hcode actions");
  console.log("/undo                            Undo the latest hcode file action");
  console.log("/compact                         Compact conversation context");
  console.log("/doctor                          Diagnose this installation");
  console.log("/github [status|tools|readonly]  Inspect or configure GitHub MCP");
  console.log("/resume                          Resume latest project session");
  console.log("/clear                           Start a new conversation");
  console.log("/version | /update | /change | /reset-key | /help | /exit");
}

function isConfirmed(answer: string | null): boolean {
  return answer !== null && ["y", "yes"].includes(answer.trim().toLowerCase());
}

async function updateHcode(prompt: PromptInput): Promise<void> {
  if (!isConfirmed(await prompt.ask("Update hcode to the latest version? [y/N] "))) {
    console.log();
    return;
  }
  console.log(`${styled("●", ANSI.cyan, ANSI.bold)} Checking/installing latest hcode...`);
  try {
    await installLatestHcode();
    console.log(`\n${styled("✓", ANSI.green, ANSI.bold)} hcode updated successfully\n\nRestart hcode to use the new version.\n`);
  } catch (error) {
    console.error(`\n${styled("Update failed:", ANSI.red, ANSI.bold)} ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function changeApiKey(prompt: PromptInput, agent: Agent): Promise<void> {
  if (!isConfirmed(await prompt.ask("Change OpenRouter API key? [y/N] "))) return void console.log();
  const apiKey = (await prompt.askSecret("Enter new OpenRouter API key:\n> "))?.trim();
  if (!apiKey) return void console.error("API key change was cancelled. The previous key is still active.\n");
  await updateConfig({ openRouterApiKey: apiKey });
  agent.setApiKey(apiKey);
  console.log(`${styled("✓", ANSI.green, ANSI.bold)} OpenRouter API key updated\n`);
}

function commandArgument(input: string, command: string): string | null {
  if (input === command) return "";
  return input.startsWith(`${command} `) ? input.slice(command.length + 1).trim() : null;
}

function formatUsage(usage: SessionUsage): string {
  return [
    "Session usage",
    "",
    `Requests: ${usage.requests.toLocaleString("en-US")}`,
    `Input tokens: ${usage.inputTokens.toLocaleString("en-US")}`,
    `Output tokens: ${usage.outputTokens.toLocaleString("en-US")}`,
    `Cost: ${usage.cost === undefined ? "unavailable" : `$${usage.cost.toFixed(6)}`}`,
  ].join("\n");
}

function formatContext(agent: Agent): string {
  const status = agent.getContextStatus();
  return [
    "Context",
    "",
    `Model: ${agent.getModel()}`,
    `Messages: ${status.messages}`,
    `Files loaded: ${status.filesLoaded}`,
    `Modified files: ${status.modifiedFiles.length}`,
    `Repo map: ${status.repoMapReady ? "ready" : "lazy (not built)"}`,
    "Session: active",
    `Approx context usage: ${status.usagePercent}% (${status.estimatedTokens.toLocaleString("en-US")} / ${status.contextWindow.toLocaleString("en-US")})`,
  ].join("\n");
}

async function formatStatus(projectRoot: string, agent: Agent): Promise<string> {
  let git = "unavailable";
  try {
    const status = await gitStatus(projectRoot);
    if (status === "Working tree clean.") git = "clean";
    else {
      const lines = status.split("\n").filter(Boolean);
      const untracked = lines.filter((line) => line.startsWith("??")).length;
      git = `${lines.length - untracked} modified, ${untracked} untracked`;
    }
  } catch {
    // A project need not be a Git repository.
  }
  const plan = agent.getPlan();
  const github = await agent.getGithubStatus(false);
  return [
    `hcode ${VERSION}`,
    "",
    `Project: ${projectRoot}`,
    `Model: ${agent.getModel()}`,
    `Mode: ${PERMISSION_LABELS[agent.getPermissionMode()]}`,
    "Session: active",
    `Git: ${git}`,
    `Context: ${agent.getContextStatus().usagePercent}%`,
    `Plan: ${plan.filter((item) => item.status === "completed").length}/${plan.length} complete`,
    "",
    "AI",
    "  OpenRouter",
    `  ${agent.getModel()}`,
    "",
    "GitHub",
    `  ${!github.configured ? "not configured" : github.state === "connected"
      ? `MCP connected · ${github.toolsets.join(", ")}`
      : `MCP ${github.state} · ${github.toolsets.join(", ")}`}`,
  ].join("\n");
}

export function formatGithubStatus(status: GithubStatus): string {
  if (!status.configured) {
    return [
      "GitHub MCP is not configured.",
      "",
      "Set:",
      "",
      'export GITHUB_TOKEN="your_token"',
      "",
      "Then restart hcode.",
    ].join("\n");
  }
  return [
    "GitHub MCP",
    "",
    `Status: ${status.state}`,
    `Server: ${status.serverInfo ?? GITHUB_MCP_REPOSITORY_LABEL}`,
    "Authentication: GITHUB_TOKEN",
    `Mode: ${status.readOnly ? "read-only" : "read/write"}`,
    "",
    "Toolsets:",
    ...status.toolsets.map((toolset) => `  ${toolset}`),
    "",
    `Tools: ${status.tools}`,
    ...(status.error ? ["", `Diagnostic: ${status.error}`] : []),
  ].join("\n");
}

export function formatGithubDiagnostics(status: GithubStatus): string {
  if (!status.configured) return formatGithubStatus(status);
  const mark = (ok: boolean | null) => ok === true ? "✓" : ok === false ? "✗" : "○";
  return [
    "GitHub MCP",
    "",
    "✓ GITHUB_TOKEN configured",
    `${mark(status.serverAvailable)} github-mcp-server ${status.serverAvailable ? "available" : "not installed"}`,
    `${mark(status.state === "connected")} MCP connection`,
    `${mark(status.authenticated)} GitHub authentication`,
    "",
    `Tools: ${status.tools}`,
    ...(status.error ? ["", `Diagnostic: ${status.error}`] : []),
  ].join("\n");
}

const GITHUB_MCP_REPOSITORY_LABEL = "github/github-mcp-server";

export interface JsonResult {
  success: boolean;
  message: string;
  changedFiles: string[];
  verification: Array<{ command: string; success: boolean; summary: string }>;
  usage: SessionUsage;
}

export function createJsonResult(
  success: boolean,
  message: string,
  events: AgentEvent[],
  usage: SessionUsage,
): JsonResult {
  const changedFiles = [...new Set(events.flatMap((event) => event.type === "file_changed" ? [event.path] : []))];
  const verification = events.flatMap((event) => event.type === "verification"
    ? [{ command: event.command, success: event.success, summary: event.summary }]
    : []);
  return { success, message, changedFiles, verification, usage };
}

function classifyError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancelled|canceled|aborted/i.test(message)) return EXIT_CODES.cancelled;
  if (/API key|HTTP 401|HTTP 403|configuration/i.test(message)) return EXIT_CODES.configuration;
  return EXIT_CODES.taskFailed;
}

async function runNonInteractive(
  cli: CliArguments,
  projectRoot: string,
  config: HcodeConfig,
): Promise<number> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim() || savedApiKey(config);
  if (!apiKey) {
    const result = createJsonResult(false, "OpenRouter API key is not configured.", [], {
      requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    });
    if (cli.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stderr.write("Error: OpenRouter API key is not configured.\n");
    return EXIT_CODES.configuration;
  }
  const savedPermission = typeof config.permissions === "string"
    ? parsePermissionMode(config.permissions) : null;
  const sessions = new SessionManager(projectRoot);
  const resumed = cli.continueSession ? await sessions.loadLatest() : null;
  if (!resumed) sessions.startNew();
  const model = process.env.OPENROUTER_MODEL?.trim()
    ? resolveActiveModel()
    : resumed?.model ?? resolveActiveModel(typeof config.model === "string" ? config.model : undefined);
  const events: AgentEvent[] = [];
  let declined = false;
  const agent = new Agent({
    projectRoot,
    apiKey,
    model,
    permissionMode: cli.permission ?? savedPermission ?? "safe",
    githubConfig: config.github,
    confirm: async () => false,
    action: (message) => {
      if (!cli.json) process.stderr.write(`◆ ${message}\n`);
    },
    onEvent: (event) => {
      events.push(event);
      if (event.type === "tool_end" && event.result.startsWith("User declined")) declined = true;
    },
  });
  if (resumed) agent.loadHistory(resumed.messages, model, resumed.metadata);
  try {
    const message = await agent.run(cli.prompt ?? "");
    await sessions.save(agent.getHistory(), agent.getModel(), agent.getSessionMetadata());
    const lastVerification = events.filter((event) => event.type === "verification").at(-1);
    const completed = !declined && (lastVerification?.type !== "verification" || lastVerification.success);
    const result = createJsonResult(completed, message, events, agent.getUsage());
    if (cli.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(`${renderMarkdown(message, false)}\n\n`);
      process.stdout.write(`${completed ? "✓ Done" : "⚠ Incomplete"}\nUsage: ${agent.getToolRounds()} tool rounds\n`);
    }
    return completed ? EXIT_CODES.success : EXIT_CODES.taskFailed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = classifyError(error);
    if (cli.json) process.stdout.write(`${JSON.stringify(createJsonResult(false, message, events, agent.getUsage()))}\n`);
    else process.stderr.write(`Error: ${message}\n`);
    return code;
  } finally {
    await agent.close();
  }
}

async function runInteractive(
  projectRoot: string,
  config: HcodeConfig,
  continueSession = false,
): Promise<number> {
  const prompt = await PromptInput.create();
  const spinner = new Spinner();
  let agent: Agent | null = null;
  try {
    const apiKey = await getInteractiveApiKey(prompt, config);
    const savedPermissions = typeof config.permissions === "string" ? parsePermissionMode(config.permissions) : null;
    const sessionManager = new SessionManager(projectRoot);
    const resumed = continueSession ? await sessionManager.loadLatest() : null;
    if (!resumed) sessionManager.startNew();
    const model = process.env.OPENROUTER_MODEL?.trim()
      ? resolveActiveModel()
      : resumed?.model ?? resolveActiveModel(typeof config.model === "string" ? config.model : undefined);
    agent = new Agent({
      projectRoot,
      apiKey,
      model,
      permissionMode: savedPermissions ?? "safe",
      githubConfig: config.github,
      confirm: async (message) => {
        spinner.stop();
        const answer = await prompt.ask(`${styled("?", ANSI.yellow, ANSI.bold)} ${message} `);
        const confirmed = message.includes("[Y/n]")
          ? answer !== null && !["n", "no"].includes(answer.trim().toLowerCase())
          : isConfirmed(answer);
        spinner.start(confirmed ? "Applying changes…" : "Thinking…");
        return confirmed;
      },
      action: (message) => {
        spinner.stop();
        console.log(`${styled("◆", ANSI.cyan, ANSI.bold)} ${message}`);
        spinner.start(message.includes("Compacting") ? "Compacting context…" : "Working…");
      },
    });
    const activeAgent = agent;
    if (resumed) agent.loadHistory(resumed.messages, model, resumed.metadata);

    let operationActive = false;
    let cancelActiveOperation: (() => boolean) | null = null;
    prompt.onInterrupt(() => {
      if (operationActive && cancelActiveOperation?.()) {
        spinner.stop();
        prompt.cancelPendingQuestion();
        console.log("\nCancelling current operation...");
      } else {
        console.log();
        prompt.close();
      }
    });
    const saveSession = async () => sessionManager.save(
      activeAgent.getHistory(), activeAgent.getModel(), activeAgent.getSessionMetadata(),
    );
    printHeader(projectRoot, agent.getPermissionMode());
    if (resumed) console.log(`${styled("✓", ANSI.green, ANSI.bold)} Resumed latest project session\n`);

    while (true) {
      const line = await prompt.ask("> ", true);
      if (line === null) break;
      const input = line.trim();
      if (!input) continue;
      if (input === "/exit") break;
      if (input === "/help") { printHelp(); console.log(); continue; }
      if (input === "/version") { console.log(`hcode ${VERSION}\n`); continue; }
      if (input === "/clear") {
        agent.clearHistory();
        sessionManager.startNew();
        console.clear();
        printHeader(projectRoot, agent.getPermissionMode());
        continue;
      }
      if (input === "/update") { await updateHcode(prompt); continue; }
      if (input === "/change") { await changeApiKey(prompt, agent); continue; }
      if (input === "/reset-key") {
        await updateConfig({ openRouterApiKey: undefined });
        console.log("Saved OpenRouter API key removed. Restart hcode to configure it again.\n");
        continue;
      }
      if (input === "/context") { console.log(`${formatContext(agent)}\n`); continue; }
      if (input === "/status") { console.log(`${await formatStatus(projectRoot, agent)}\n`); continue; }
      if (input === "/usage") { console.log(`${formatUsage(agent.getUsage())}\n`); continue; }
      if (input === "/doctor") {
        console.log(`${formatDoctorReport(await runDoctor(projectRoot, await readConfig(), {
          githubManager: agent.getGithubManager(),
        }))}\n`);
        continue;
      }
      const githubArgument = commandArgument(input, "/github");
      if (githubArgument !== null) {
        try {
          if (githubArgument === "tools") {
            await agent.getGithubManager().connect();
            console.log(`${agent.getGithubManager().formatTools()}\n`);
            continue;
          }
          if (githubArgument === "readonly" || githubArgument === "readonly on" ||
            githubArgument === "readonly off") {
            const enabled = githubArgument !== "readonly off";
            await agent.setGithubReadOnly(enabled);
            await updateConfig({
              github: {
                enabled: config.github?.enabled ?? true,
                toolsets: agent.getGithubManager().getToolsets(),
                readOnly: enabled,
              },
            });
            console.log(`${styled("✓", ANSI.green, ANSI.bold)} GitHub MCP mode: ${enabled ? "read-only" : "read/write"}\n`);
            continue;
          }
          if (githubArgument && githubArgument !== "status") {
            console.error("Usage: /github [status|tools|readonly [on|off]]\n");
            continue;
          }
          const status = await agent.getGithubStatus(true);
          console.log(`${githubArgument === "status"
            ? formatGithubDiagnostics(status)
            : formatGithubStatus(status)}\n`);
        } catch (error) {
          console.error(`${error instanceof Error ? error.message : String(error)}\n`);
        }
        continue;
      }
      if (input === "/checkpoints") {
        const checkpoints = agent.getCheckpoints();
        console.log(`${checkpoints.length
          ? checkpoints.map((item) => `#${item.id}  ${item.label}`).join("\n")
          : "No checkpoints."}\n`);
        continue;
      }
      if (input === "/undo") {
        try { console.log(`${styled("✓", ANSI.green, ANSI.bold)} ${await agent.undoLast()}\n`); }
        catch (error) { console.error(`${styled("Undo refused:", ANSI.red, ANSI.bold)} ${error instanceof Error ? error.message : String(error)}\n`); }
        continue;
      }
      if (input === "/compact") {
        agent.compact();
        await saveSession();
        console.log(`${styled("✓", ANSI.green, ANSI.bold)} Conversation context compacted\n`);
        continue;
      }
      if (input === "/resume") {
        const latest = await sessionManager.loadLatest();
        if (!latest) { console.log("No saved session for this project.\n"); continue; }
        const resumedModel = process.env.OPENROUTER_MODEL?.trim() ? agent.getModel() : latest.model;
        agent.loadHistory(latest.messages, resumedModel, latest.metadata);
        console.log(`${styled("✓", ANSI.green, ANSI.bold)} Resumed latest project session\n`);
        continue;
      }

      const diffArgument = commandArgument(input, "/diff");
      if (diffArgument !== null) {
        const controller = new AbortController();
        try {
          operationActive = true;
          cancelActiveOperation = () => { controller.abort(); return true; };
          console.log(`${await gitDiff(projectRoot, {
            confirm: async () => false,
            action: () => undefined,
            signal: controller.signal,
          }, diffArgument || undefined)}\n`);
        }
        catch (error) { console.error(`${styled("Git error:", ANSI.red, ANSI.bold)} ${error instanceof Error ? error.message : String(error)}\n`); }
        finally { operationActive = false; cancelActiveOperation = null; }
        continue;
      }
      const modelArgument = commandArgument(input, "/model");
      if (modelArgument !== null) {
        if (modelArgument === "current") { console.log(`Current model: ${agent.getModel()}\n`); continue; }
        let requested = modelArgument;
        if (!requested) requested = (await prompt.ask(`Current model: ${agent.getModel()}\nModel (provider/model-name, blank to cancel): `))?.trim() ?? "";
        if (!requested) { console.log(); continue; }
        try {
          const nextModel = validateModel(requested);
          agent.setModel(nextModel);
          await updateConfig({ model: nextModel });
          await saveSession();
          console.log(`${styled("✓", ANSI.green, ANSI.bold)} Model: ${nextModel}\n`);
        } catch (error) { console.error(`${styled("Invalid model:", ANSI.red, ANSI.bold)} ${error instanceof Error ? error.message : String(error)}\n`); }
        continue;
      }
      const permissionsArgument = commandArgument(input, "/permissions");
      if (permissionsArgument !== null) {
        let requested = permissionsArgument;
        if (!requested || requested === "current") {
          console.log(`Current permissions: ${PERMISSION_LABELS[agent.getPermissionMode()]}`);
          if (requested === "current") { console.log(); continue; }
          requested = (await prompt.ask("Mode (safe/edit/auto, blank to cancel): "))?.trim() ?? "";
        }
        if (!requested) { console.log(); continue; }
        const mode = parsePermissionMode(requested);
        if (!mode) { console.error("Permissions must be safe, edit, or auto.\n"); continue; }
        agent.setPermissionMode(mode);
        await updateConfig({ permissions: mode });
        console.log(`${styled("✓", ANSI.green, ANSI.bold)} Permissions: ${PERMISSION_LABELS[mode]}\n`);
        continue;
      }

      try {
        operationActive = true;
        cancelActiveOperation = () => activeAgent.cancelCurrent();
        spinner.start("Thinking…");
        const response = await agent.run(input);
        spinner.stop();
        console.log(`\n${renderMarkdown(response, ANSI_ENABLED)}\n`);
        console.log(`${styled("✓", ANSI.green, ANSI.bold)} ${styled("Done", ANSI.dim)} · ${agent.getToolRounds()} tool rounds\n`);
        await saveSession();
      } catch (error) {
        spinner.stop();
        console.error(`\n${styled("Error:", ANSI.red, ANSI.bold)} ${error instanceof Error ? error.message : String(error)}\n`);
        await saveSession().catch(() => undefined);
      } finally {
        operationActive = false;
        cancelActiveOperation = null;
      }
    }
    return EXIT_CODES.success;
  } finally {
    spinner.stop();
    await agent?.close().catch(() => undefined);
    prompt.close();
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let cli: CliArguments;
  try {
    cli = parseCliArguments(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(createJsonResult(false, message, [], {
        requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
      }))}\n`);
    } else {
      process.stderr.write(`Error: ${message}\n`);
    }
    process.exitCode = EXIT_CODES.configuration;
    return;
  }
  if (cli.command === "version") return void console.log(`hcode ${VERSION}`);
  if (cli.command === "help") return void printHelp();
  const projectRoot = process.cwd();
  const config = await readConfig();
  if (cli.command === "doctor") {
    const report = await runDoctor(projectRoot, config);
    console.log(formatDoctorReport(report));
    process.exitCode = report.ok ? EXIT_CODES.success : EXIT_CODES.configuration;
    return;
  }
  if (cli.command === "update") {
    const prompt = await PromptInput.create();
    try { await updateHcode(prompt); } finally { prompt.close(); }
    return;
  }
  try {
    process.exitCode = cli.prompt
      ? await runNonInteractive(cli, projectRoot, config)
      : await runInteractive(projectRoot, config, cli.continueSession);
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = classifyError(error);
  }
}

if (import.meta.main) await main();
