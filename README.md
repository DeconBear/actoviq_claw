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
- open a panel such as `/heartbeat`: then use plain panel commands like `tick`, `on`, `every 20`, or `file ./HEARTBEAT.md`
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
- buddy hatch, mute, unmute, and pet controls
- automatic session memory extraction and memory search
- dream state tracking and manual or automatic dream runs
- background task tracking for delegated work
- archived chat history with `/resume` restoration

## Docs

- Chinese usage guide: [USAGE-zh.md](./USAGE-zh.md)
- Heartbeat template: [HEARTBEAT.md](./HEARTBEAT.md)
- Runtime settings example: [actoviq-claw.runtime.settings.example.json](./actoviq-claw.runtime.settings.example.json)
