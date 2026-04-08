# Actoviq Claw

`Actoviq Claw` is a fully autonomous terminal AI assistant built on top of `actoviq-agent-sdk`.

It is designed for unattended task execution and keeps the UI focused on the chat flow:

- fullscreen chat-style transcript
- bottom prompt bar with slash-command and `@file` workflow
- Claude Code-style footer suggestions for slash/file completion
- built-in heartbeat, buddy, memory, dream, and background task support

## Interface

The default TUI now follows a much simpler layout:

- main transcript shows only user tasks and assistant answers
- bottom prompt is the primary interaction point
- every launch starts a fresh chat window
- typing `/` opens command suggestions
- typing `@` opens workspace file and path suggestions
- suggestions stay in the prompt footer instead of taking over the screen
- runtime features live in footer pills and on-demand panels instead of a permanent dashboard

The available built-in panels are:

- `/help`
- `/status`
- `/tasks`
- `/heartbeat`
- `/memory`
- `/dream`
- `/buddy`
- `/tools`
- `/permission`

## Quick Start

```bash
npm install
npm run dev
```

If credentials are missing on first launch, configure either:

- `actoviq-claw.runtime.settings.local.json`
- or environment variables such as `ACTOVIQ_BASE_URL`, `ACTOVIQ_AUTH_TOKEN`, and `ACTOVIQ_MODEL`

Legacy runtime field names are also mapped automatically.

## TUI Controls

- type plain text: submit a mission
- type `/`: open command suggestions
- open a panel such as `/heartbeat`: use `Up / Down` to pick a quick action, `Enter` to apply it, or `Tab` to insert and edit it
- open `/tools`: pick a tool row to toggle it, or use global actions such as `allow all`, `deny all`, and `reset`
- `/tools` also supports category actions such as `enable category computer` or `disable category mcp`
- open `/permission`: choose `chat-only`, `workspace-only`, or `full-access` from the panel quick actions
- type `@`: autocomplete files and paths from the workspace
- `Tab`: accept the selected suggestion or extend a shared file-path prefix
- `Ctrl+N / Ctrl+P`: cycle the current suggestion list
- `Up / Down`: browse input history while text is in the prompt
- `Enter`: run the mission or command
- `Shift+Enter` or `Meta+Enter`: insert a newline in the prompt
- `Esc`: dismiss suggestions, close the current panel, press twice to clear input, or interrupt the active mission
- mouse wheel or `PageUp / PageDown`: scroll the transcript
- `Ctrl+Q` or `Ctrl+C`: exit

## Core Features

- autonomous mission queue
- heartbeat-driven unattended checks with configurable schedule, active hours, isolated-session mode, and guide-file path
- buddy companion card, intro text, reaction bubble, hatch, rename, persona, mute, unmute, and pet controls
- persistent tool allowlist with `/tools`
- built-in computer-use tools in `/tools`, registered by default but not enabled in the default allowlist
- three permission presets with `/permission`: chat-only, workspace-only, and full-access
- panel quick actions for tools, permissions, heartbeat, buddy, and other runtime controls

## Tool Catalog

By default, `/tools` now exposes more than the original file-tool set:

- file tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`
- task delegation: `Task`
- computer-use tools: `computer_open_url`, `computer_focus_window`, `computer_type_text`, `computer_keypress`, `computer_read_clipboard`, `computer_write_clipboard`, `computer_take_screenshot`, `computer_wait`, `computer_run_workflow`

Computer-use tools are registered by default so they appear in `/tools`, but they are not included in the default allowlist until you enable them.

If you want external MCP tools to appear in `/tools` too, add them under `tooling.mcpServers` in [actoviq-claw.config.example.json](./actoviq-claw.config.example.json).
- automatic session memory extraction and memory search
- dream state tracking and manual or automatic dream runs
- background task tracking for delegated work
- archived chat history with `/resume` restoration

## Docs

- Chinese usage guide: [USAGE-zh.md](./USAGE-zh.md)
- Heartbeat template: [HEARTBEAT.md](./HEARTBEAT.md)
- Runtime settings example: [actoviq-claw.runtime.settings.example.json](./actoviq-claw.runtime.settings.example.json)
