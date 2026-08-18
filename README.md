# hcode

An interactive coding agent for the current project, powered by OpenRouter.

## Run locally

```bash
bun install
bun run dev
```

On first launch, hcode asks for an OpenRouter API key and stores it in
`~/.hcode/config.json` with user-only permissions. You can also provide it with
the `OPENROUTER_API_KEY` environment variable.

The default model route is `openrouter/free`. To use a specific, more capable
model, set `OPENROUTER_MODEL` when starting hcode:

```bash
OPENROUTER_MODEL="provider/model-name" bun run dev
```

## Build

```bash
bun run build
```

The compiled executable is written to `dist/hcode`.

The loading indicator uses the animated Yahya logo in iTerm2, WezTerm, and
Warp, a static inline logo in Kitty and Ghostty, and a terminal-rendered logo
everywhere else. Detection can be overridden with
`HCODE_IMAGE_PROTOCOL=iterm`, `kitty`, or `text`.

## Commands

- `/help` — show available commands
- `/clear` — clear the screen and conversation history
- `/version` — show the current hcode version
- `/update` — install the latest hcode release
- `/change` — replace the saved OpenRouter API key for the current session
- `/reset-key` — remove the saved OpenRouter API key
- `/exit` — quit

Outside the interactive CLI, use `hcode --version` (or `hcode -v`) to print the
version and `hcode --update` to run the updater without starting a chat.
