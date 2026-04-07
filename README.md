# Actoviq Claw

`Actoviq Claw` is a fully autonomous terminal AI assistant built on top of `actoviq-agent-sdk`.

It is designed for unattended task execution and keeps the UI focused on the chat flow:

- fullscreen chat-style transcript
- bottom prompt bar with slash-command workflow
- slash command palette for panels and actions
- built-in heartbeat, buddy, memory, dream, and background task support

## Interface

The default TUI now follows a much simpler layout:

- main transcript shows only user tasks and assistant answers
- bottom prompt is the primary interaction point
- typing `/` opens the command palette
- runtime features live in footer pills and on-demand panels instead of a permanent dashboard

The available built-in panels are:

- `/help`
- `/status`
- `/tasks`
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
- type `/`: open the slash command palette
- `Up / Down`: move through slash suggestions or input history
- `Tab`: autocomplete the selected slash command
- `Enter`: run the mission or command
- `Shift+Enter` or `Meta+Enter`: insert a newline in the prompt
- `Esc`: close the current panel, press twice to clear input, or interrupt the active mission
- `Left / Right`: switch panels when a panel is open
- `PageUp / PageDown`: scroll the transcript
- `Ctrl+Q` or `Ctrl+C`: exit

## Core Features

- autonomous mission queue
- heartbeat-driven unattended checks via [HEARTBEAT.md](./HEARTBEAT.md)
- buddy hatch, mute, unmute, and pet controls
- automatic session memory extraction and memory search
- dream state tracking and manual or automatic dream runs
- background task tracking for delegated work

## Docs

- Chinese usage guide: [USAGE-zh.md](./USAGE-zh.md)
- Heartbeat template: [HEARTBEAT.md](./HEARTBEAT.md)
- Runtime settings example: [actoviq-claw.runtime.settings.example.json](./actoviq-claw.runtime.settings.example.json)
