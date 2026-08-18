#!/usr/bin/env bun

import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { Agent } from "./agent.ts";
import {
  createTerminalLogo,
  YAHYA_TEXT_LOGO_FRAMES,
} from "./logo.ts";
import { renderMarkdown } from "./markdown.ts";
import { installLatestHcode } from "./update.ts";
import { VERSION } from "./version.ts";

const CONFIG_DIRECTORY = path.join(os.homedir(), ".hcode");
const CONFIG_PATH = path.join(os.homedir(), ".hcode", "config.json");
const DISPLAY_MODEL = "hermes/code";
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
  private label = "";
  private active = false;

  start(label: string): void {
    if (!process.stdout.isTTY) {
      return;
    }

    if (this.active) {
      this.stop();
    }

    this.label = label;
    this.active = true;

    if (this.logo.imageSequence) {
      this.renderImage();
      return;
    }

    this.frame = 0;
    this.renderText();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % YAHYA_TEXT_LOGO_FRAMES.length;
      this.renderText();
    }, 100);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.active && this.logo.cleanupSequence) {
      process.stdout.write(this.logo.cleanupSequence);
    }
    if (process.stdout.isTTY && this.active) {
      process.stdout.write("\r\x1b[2K");
    }
    this.active = false;
  }

  private renderText(): void {
    const frame = YAHYA_TEXT_LOGO_FRAMES[this.frame] ?? YAHYA_TEXT_LOGO_FRAMES[0];
    const icon = styled(frame, ANSI.white, ANSI.bold);
    const label = styled(this.label, ANSI.dim);
    process.stdout.write(`\r\x1b[2K${icon} ${label}`);
  }

  private renderImage(): void {
    const label = styled(this.label, ANSI.dim);
    const labelColumn = this.logo.columns + 1;
    process.stdout.write(
      `\r\x1b[2K\x1b7${this.logo.imageSequence}\x1b8` +
        `\x1b[${labelColumn}C${label}`,
    );
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
    `${styled(YAHYA_TEXT_LOGO_FRAMES[0], ANSI.white, ANSI.bold)} ${styled("hcode", ANSI.bold)}`,
  );
  console.log(`${styled("Project:", ANSI.dim)} ${projectRoot}`);
  console.log(`${styled("Model:", ANSI.dim)} ${DISPLAY_MODEL}`);
  console.log();
}

function printHelp(): void {
  console.log(styled("Commands:", ANSI.bold));
  console.log("/help       Show available commands");
  console.log("/clear      Clear conversation");
  console.log("/version    Show hcode version");
  console.log("/update     Update hcode");
  console.log("/change     Change OpenRouter API key");
  console.log("/reset-key  Remove saved API key");
  console.log("/exit       Exit hcode");
}

function isConfirmed(answer: string | null): boolean {
  return answer !== null && ["y", "yes"].includes(answer.trim().toLowerCase());
}

async function updateHcode(prompt: PromptInput): Promise<void> {
  const answer = await prompt.ask("Update hcode to the latest version? [y/N] ");
  if (!isConfirmed(answer)) {
    console.log();
    return;
  }

  console.log(
    `${styled("●", ANSI.cyan, ANSI.bold)} Checking/installing latest hcode...`,
  );

  try {
    await installLatestHcode();
    console.log(
      `\n${styled("✓", ANSI.green, ANSI.bold)} hcode updated successfully\n\n` +
        "Restart hcode to use the new version.\n",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n${styled("Update failed:", ANSI.red, ANSI.bold)} ${message}\n`);
  }
}

async function changeApiKey(prompt: PromptInput, agent: Agent): Promise<void> {
  const answer = await prompt.ask("Change OpenRouter API key? [y/N] ");
  if (!isConfirmed(answer)) {
    console.log();
    return;
  }

  console.log("Enter new OpenRouter API key:");
  const enteredApiKey = await prompt.askSecret("> ");
  if (enteredApiKey === null) {
    console.error(
      "API key change was cancelled. The previous key is still active.\n",
    );
    return;
  }

  const newApiKey = enteredApiKey.trim();
  if (!newApiKey) {
    console.error("API key cannot be empty. The previous key is still active.\n");
    return;
  }

  try {
    await saveApiKey(newApiKey);
    agent.setApiKey(newApiKey);
    console.log(
      `${styled("✓", ANSI.green, ANSI.bold)} OpenRouter API key updated\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${styled("Could not update OpenRouter API key:", ANSI.red, ANSI.bold)} ` +
        `${message}\nThe previous key is still active.\n`,
    );
  }
}

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  if (
    argumentsList.length === 1 &&
    ["--version", "-v"].includes(argumentsList[0] ?? "")
  ) {
    console.log(`hcode ${VERSION}`);
    return;
  }

  const projectRoot = process.cwd();
  const prompt = new PromptInput();
  const spinner = new Spinner();

  try {
    if (argumentsList.length === 1 && argumentsList[0] === "--update") {
      await updateHcode(prompt);
      return;
    }

    const apiKey = await getApiKey(prompt);
    const agent = new Agent({
      projectRoot,
      apiKey,
      confirm: async (message) => {
        spinner.stop();
        const answer = await prompt.ask(
          `${styled("?", ANSI.yellow, ANSI.bold)} ${message} `,
        );
        const confirmed = isConfirmed(answer);
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
      if (input === "/version") {
        console.log(`hcode ${VERSION}\n`);
        continue;
      }
      if (input === "/update") {
        await updateHcode(prompt);
        continue;
      }
      if (input === "/change") {
        await changeApiKey(prompt, agent);
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
        console.log(`\n${renderMarkdown(response, ANSI_ENABLED)}\n`);
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
