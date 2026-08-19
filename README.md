# hcode

A fast, lightweight terminal coding agent built with TypeScript, Bun, and OpenRouter.
It builds a lazy, incremental repository map on demand and never runs a background
watcher or sends telemetry.

## Install

Install the latest macOS or Linux release:

```bash
curl -fsSL https://raw.githubusercontent.com/tetttet/hcode/main/install.sh | sh
```

Or run the project locally:

```bash
bun install
bun run dev
```

On first launch, hcode asks for an OpenRouter API key and stores it in
`~/.hcode/config.json` with user-only permissions. Alternatively, set
`OPENROUTER_API_KEY` in the environment.

## Models

The active model is resolved in this order:

1. `OPENROUTER_MODEL`
2. the model saved in `~/.hcode/config.json`
3. `openrouter/free`

Use `/model current`, `/model provider/model-name`, or interactive `/model` to
inspect or change the model. Changing it preserves the saved OpenRouter API key.

```bash
OPENROUTER_MODEL="provider/model-name" hcode
```

## GitHub MCP (optional)

hcode is an MCP client for the official
[`github/github-mcp-server`](https://github.com/github/github-mcp-server). GitHub
support is optional: OpenRouter with the `openrouter/free` route remains the AI
provider, and no OpenAI, Anthropic, Gemini, or paid search key is required.

Export one GitHub Personal Access Token and start hcode normally:

```bash
export GITHUB_TOKEN="your_github_token"
hcode
```

Then use GitHub in natural language:

```text
> show the open issues for this repository
> read issue #14 and fix it locally
> create a pull request for these changes
```

GitHub MCP starts lazily only for a GitHub request or an explicit `/github`
command. hcode first looks for `github-mcp-server` in `PATH`, then under
`~/.hcode/bin`. On first use it can download the matching macOS/Linux arm64/x64
archive from the official GitHub release metadata, verify its published SHA-256
checksum, and install it under `~/.hcode/bin` without `sudo`. Docker is not
required; an already-present local image is only a fallback if native installation
is declined.

hcode maps `GITHUB_TOKEN` to `GITHUB_PERSONAL_ACCESS_TOKEN` only in the MCP child
process. The value is never placed in command arguments, model context, config,
sessions, history, repo maps, caches, diagnostics, or logs. Known GitHub token
formats and the exact active token are redacted from MCP errors and server stderr.

The default toolsets keep model context bounded:

```json
{
  "github": {
    "enabled": true,
    "toolsets": ["repos", "issues", "pull_requests", "users"],
    "readOnly": false
  }
}
```

This belongs in the existing `~/.hcode/config.json`; never add the token there.
Use `/github`, `/github status`, and `/github tools` to inspect the connection.
`/github readonly` enables the official server's strict read-only mode, while
`/github readonly off` restores read/write tool discovery.

Read operations follow the normal Safe/Edit/Auto policy without extra prompts.
GitHub mutations are confirmed in Safe and Edit. Auto only skips confirmation
for non-destructive, explicitly idempotent operations; merges, deletes, repository
settings, workflow dispatch, branch-protection changes, and push-like actions
always require confirmation. A local GitHub `origin` in HTTPS or SSH form is
resolved to `owner/repo`; hcode does not guess when the origin is not GitHub.

Grant the token only the repository access and read/write permissions actually
needed. Read-only use works with read permissions; issue or pull-request writes
need their corresponding write permissions. Admin permissions are not required.

## Permissions

Use `/permissions` or `/permissions safe|edit|auto`:

- **Safe** confirms existing-file edits and every shell command.
- **Edit** allows safe file edits and confirms shell commands.
- **Auto** also permits a small allowlist of safe development commands.

Dangerous commands remain blocked or require confirmation in every mode. File
tools stay inside the project root, reject symlink escapes, and protect `.env`
and credential files.

## Sessions and context

Sessions are stored as project-scoped JSON under `~/.hcode/sessions/`. Project
directory names are hashed; API keys, GitHub tokens, and known secret patterns
are not stored.

```bash
hcode --continue
hcode -c
```

`/resume` loads the latest session for the current project. `/compact` replaces
old verbose tool output with a small work summary containing goals, inspected
files, changes, errors, verification, and remaining plan items. hcode also
compacts automatically near the active model's context limit.

Cheap repository metadata is cached per-project under `~/.hcode/cache/`. The
cache contains file sizes, mtimes, symbol summaries, and bounded recent search
results—not source contents, environment files, credentials, or API keys. A
corrupt cache is ignored and rebuilt. Unchanged files reuse cached metadata;
changed files are refreshed individually.

The repo map recognizes TypeScript/JavaScript, Python, Go, and Rust imports,
exports, classes, functions, interfaces, and types with lightweight parsing.
`read_file` uses bounded line ranges and refuses to decode binary files. Large
text files default to a small first range instead of flooding the model.

## Non-interactive and JSON modes

Run one task and exit:

```bash
hcode -p "fix the failing tests"
hcode --permission edit --prompt "update the parser"
hcode --json -p "check this project"
```

Safe-mode confirmations are never implicitly approved in non-interactive mode.
Use an explicit permission mode when appropriate. JSON mode writes one valid JSON
object to stdout and keeps progress/diagnostics off stdout:

```json
{
  "success": true,
  "message": "...",
  "changedFiles": [],
  "verification": [],
  "usage": {}
}
```

Non-interactive exit codes are `0` for success, `1` for an incomplete/failed
task, `2` for configuration or authentication problems, and `3` for cancellation.

## Project ignores and privacy

Automatic discovery, repo maps, and search respect `.gitignore` and an optional
`.hcodeignore` using familiar gitignore-style patterns:

```gitignore
generated/
fixtures/huge/
private/
*.log
```

An explicit `read_file` may read a safe ignored file, which keeps behavior
predictable when the user names it. Environment and credential files (`.env`,
private keys, SSH keys, `credentials.json`, and `service-account*.json`) remain
blocked even when requested explicitly.

## Commands

- `/model` — inspect or change the active model
- `/permissions` — inspect or change the permission mode
- `/context` — show approximate context usage, loaded files, and repo-map state
- `/status` — show compact project, model, Git, session, context, and plan status
- `/usage` — show session request/token usage and provider cost when available
- `/diff [path]` — show a change summary and diff, optionally for one file
- `/checkpoints` — list reversible hcode file actions
- `/undo` — restore only files from the latest hcode edit checkpoint
- `/compact` — reduce long conversation context
- `/doctor` — diagnose Git, ripgrep, Bun, permissions, key presence, and network
- `/github` — show the optional GitHub MCP connection and mode
- `/github status` — verify the server, MCP protocol, and GitHub authentication
- `/github tools` — show the compact dynamically discovered tool list
- `/github readonly` — enable strict server-side read-only mode
- `/resume` — load the latest session for this project
- `/clear` — start a new conversation
- `/version` — show the current version
- `/update` — install the latest release
- `/change` — replace the saved OpenRouter API key
- `/reset-key` — remove only the saved API key
- `/help` — show commands
- `/exit` — quit

Outside the interactive CLI, use `hcode --version` (`hcode -v`), `hcode doctor`,
and `hcode --update`.

Interactive input uses the platform readline editor, including arrow-key history,
Left/Right, Home/End, Ctrl+A, Ctrl+E, Ctrl+W, and Ctrl+U. Prompt history is kept
at `~/.hcode/history` with a bounded size; hidden inputs and likely secrets are
excluded.

## Development

```bash
bun test
bunx tsc --noEmit
bun run build
```

The compiled executable is written to `dist/hcode`. The animated Yahya loading
indicator supports iTerm2, WezTerm, Warp, Kitty, and Ghostty, with a text fallback.
Set `HCODE_IMAGE_PROTOCOL=iterm`, `kitty`, or `text` to override detection.
Set `HCODE_DEBUG=1` to print local timing for searches, reads, tool calls, and
OpenRouter requests. Debug timings stay local; hcode has no analytics or external
telemetry.

Internally, local and dynamically discovered MCP tools share the same small tool
registry and scheduler. The MCP runtime implements the required JSON-RPC lifecycle
over newline-delimited stdio, bounded diagnostics, cancellation, timeouts, clean
shutdown, and a single safe reconnect for interrupted read calls. Without
`GITHUB_TOKEN`, no GitHub process, network request, download, or tool schema is
created.
