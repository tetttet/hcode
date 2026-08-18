#!/usr/bin/env bun

import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { Agent } from "./agent.ts";
import { DEFAULT_MODEL } from "./openrouter.ts";

const CONFIG_DIRECTORY = path.join(os.homedir(), ".hcode");
const CONFIG_PATH = path.join(os.homedir(), ".hcode", "config.json");
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
  private readonly frames = [
    "⠋",
    "⠙",
    "⠹",
    "⠸",
    "⠼",
    "⠴",
    "⠦",
    "⠧",
    "⠇",
    "⠏",
  ];
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private label = "";

  start(label: string): void {
    if (!process.stdout.isTTY) {
      return;
    }

    this.label = label;
    if (this.timer) {
      this.render();
      return;
    }

    this.frame = 0;
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % this.frames.length;
      this.render();
    }, 80);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (process.stdout.isTTY) {
      process.stdout.write("\r\x1b[2K");
    }
  }

  private render(): void {
    const icon = styled(this.frames[this.frame] ?? "•", ANSI.white, ANSI.bold);
    const label = styled(this.label, ANSI.dim);
    process.stdout.write(`\r\x1b[2K${icon} ${label}`);
  }
}

class PromptInput {
  private readonly readline: Interface;
  private readonly queuedLines: string[] = [];
  private readonly waiting: Array<(line: string | null) => void> = [];
  private closed = false;
  private hideInput = false;

  constructor() {
    this.readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const mutableReadline = this.readline as Interface & {
      _writeToOutput?(value: string): void;
    };
    const writeToOutput = mutableReadline._writeToOutput?.bind(this.readline);
    if (writeToOutput) {
      mutableReadline._writeToOutput = (value: string) => {
        if (!this.hideInput) {
          writeToOutput(value);
        }
      };
    }

    this.readline.on("line", (line) => {
      const resolve = this.waiting.shift();
      if (resolve) {
        resolve(line);
      } else {
        this.queuedLines.push(line);
      }
    });
    this.readline.on("close", () => {
      this.closed = true;
      for (const resolve of this.waiting.splice(0)) {
        resolve(null);
      }
    });
  }

  ask(prompt: string): Promise<string | null> {
    process.stdout.write(prompt);
    const queued = this.queuedLines.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async askSecret(prompt: string): Promise<string | null> {
    this.hideInput = true;
    try {
      return await this.ask(prompt);
    } finally {
      this.hideInput = false;
      process.stdout.write("\n");
    }
  }

  close(): void {
    this.readline.close();
  }
}

async function readSavedApiKey(): Promise<string | null> {
  try {
    const config = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as unknown;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return null;
    }

    const apiKey = (config as { openRouterApiKey?: unknown }).openRouterApiKey;
    return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null;
  } catch {
    return null;
  }
}

async function saveApiKey(apiKey: string): Promise<void> {
  await mkdir(CONFIG_DIRECTORY, { recursive: true, mode: 0o700 });
  await writeFile(
    CONFIG_PATH,
    `${JSON.stringify({ openRouterApiKey: apiKey }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  if (process.platform === "darwin" || process.platform === "linux") {
    await chmod(CONFIG_PATH, 0o600);
  }
}

async function deleteSavedApiKey(): Promise<void> {
  try {
    await unlink(CONFIG_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function getApiKey(prompt: PromptInput): Promise<string> {
  const environmentApiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (environmentApiKey) {
    return environmentApiKey;
  }

  const savedApiKey = await readSavedApiKey();
  if (savedApiKey) {
    return savedApiKey;
  }

  console.log("Welcome to hcode\n");
  console.log("OpenRouter API key not configured.\n");
  console.log("Enter your OpenRouter API key:");

  while (true) {
    const enteredApiKey = await prompt.askSecret("> ");
    if (enteredApiKey === null) {
      throw new Error("API key input was cancelled.");
    }

    const apiKey = enteredApiKey.trim();
    if (!apiKey) {
      console.log("API key cannot be empty. Please try again.");
      continue;
    }

    try {
      await saveApiKey(apiKey);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not save API key: ${detail}`);
    }
    return apiKey;
  }
}

function printHeader(projectRoot: string): void {
  console.log(
    `${styled("◆", ANSI.white, ANSI.bold)} ${styled("hcode", ANSI.bold)}`,
  );
  console.log(`${styled("Project:", ANSI.dim)} ${projectRoot}`);
  console.log(`${styled("Model:", ANSI.dim)} ${DEFAULT_MODEL}`);
  console.log();
}

function printHelp(): void {
  console.log(styled("Commands:", ANSI.bold));
  console.log("  /help       Show this help");
  console.log("  /clear      Clear the screen and conversation history");
  console.log("  /reset-key  Delete the saved OpenRouter API key");
  console.log("  /exit       Exit hcode");
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const prompt = new PromptInput();
  const spinner = new Spinner();

  try {
    const apiKey = await getApiKey(prompt);
    const agent = new Agent({
      projectRoot,
      apiKey,
      confirm: async (message) => {
        spinner.stop();
        const answer = await prompt.ask(
          `${styled("?", ANSI.yellow, ANSI.bold)} ${message} `,
        );
        const confirmed =
          answer !== null && ["y", "yes"].includes(answer.trim().toLowerCase());
        spinner.start(confirmed ? "Applying changes…" : "Thinking…");
        return confirmed;
      },
      action: (message) => {
        spinner.stop();
        console.log(`${styled("◆", ANSI.cyan, ANSI.bold)} ${message}`);
        spinner.start("Working…");
      },
    });

    printHeader(projectRoot);

    while (true) {
      const line = await prompt.ask("> ");
      if (line === null) {
        break;
      }
      const input = line.trim();

      if (!input) {
        continue;
      }

      if (input === "/exit") {
        break;
      }
      if (input === "/help") {
        printHelp();
        console.log();
        continue;
      }
      if (input === "/clear") {
        agent.clearHistory();
        console.clear();
        printHeader(projectRoot);
        continue;
      }
      if (input === "/reset-key") {
        try {
          await deleteSavedApiKey();
          console.log(
            "Saved OpenRouter API key removed. Restart hcode to configure it again.\n",
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Could not remove the saved API key: ${message}\n`);
        }
        continue;
      }

      try {
        spinner.start("Thinking…");
        const response = await agent.run(input);
        spinner.stop();
        console.log(`\n${response}\n`);
        console.log(
          `${styled("✓", ANSI.green, ANSI.bold)} ${styled("Done", ANSI.dim)}\n`,
        );
      } catch (error) {
        spinner.stop();
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\n${styled("Error:", ANSI.red, ANSI.bold)} ${message}\n`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  } finally {
    spinner.stop();
    prompt.close();
  }
}

await main();
