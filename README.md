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

## Commands

- `/help` — show commands
- `/clear` — clear the screen and conversation history
- `/reset-key` — remove the saved OpenRouter API key
- `/exit` — quit
