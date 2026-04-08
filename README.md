# Actoviq Claw

`Actoviq Claw` is a full-screen autonomous TUI assistant built on top of `actoviq-agent-sdk`.

This repository is also a broader product experiment: a new attempt at building an AI brain that can eventually live in the cloud and connect to many kinds of hardware. The long-term goal is not only a terminal assistant on a computer, but a reusable AI core that could later power desktops, phones, robots, and other network-connected devices. The current repository is still an early-stage implementation focused on the TUI and local unattended workflows, and it will continue to evolve step by step.

## Vision

The idea behind `Actoviq Claw` is simple:

- one persistent AI brain
- multiple possible hardware shells
- long-running memory, heartbeat, and dream loops
- autonomous task execution instead of one-shot chat only

Today, the project is still in its first practical stage:

- the main interface is a terminal UI
- the current runtime is local-first
- the system already supports unattended loops, tools, memory, dream, and buddy
- more device surfaces and broader integration layers are future work

## Current Scope

Right now this repository focuses on a chat-first terminal experience:

- fullscreen TUI
- slash-command driven operations
- per-chat history with resume
- autonomous mission queue
- heartbeat-based unattended checking
- buddy companion layer
- session memory and dream support
- file tools, task delegation, and computer-use tools

It is intentionally not positioned as a finished cross-device product yet. It is an actively developing prototype that is meant to grow into a larger AI brain architecture over time.

## Key Features

- autonomous mission queue for unattended execution
- fresh chat window on every launch, with archived chat restore by id
- `/heartbeat` panel for unattended checks, worktime, interval, guide file, and isolated-session mode
- `/tools` panel for allowlist control across file, task, computer-use, and future MCP tools
- `/permission` panel for `chat-only`, `workspace-only`, and `full-access`
- built-in buddy, memory, dream, and background-task support
- `@file` completion for workspace files and paths
- runtime history directory selection and chat resume flows

## Quick Start

```bash
npm install
npm run dev
```

If credentials are missing, configure either:

- `actoviq-claw.runtime.settings.local.json`
- or environment variables such as `ACTOVIQ_BASE_URL`, `ACTOVIQ_AUTH_TOKEN`, and `ACTOVIQ_MODEL`

Legacy runtime names are mapped automatically, so existing `ANTHROPIC_*` fields can still work.

## Global CLI

After the package is published, users can install it globally and launch the TUI from any directory:

```bash
npm install -g actoviq-claw
actov
```

Behavior:

- the current terminal directory becomes the working workspace
- `actov --workspace <path>` can override that workspace explicitly
- the TUI stores state and history relative to the chosen workspace unless you change the config

## Main Config Files

- [actoviq-claw.runtime.settings.example.json](./actoviq-claw.runtime.settings.example.json)
- [actoviq-claw.config.example.json](./actoviq-claw.config.example.json)
- [HEARTBEAT.md](./HEARTBEAT.md)

Common app-level settings include:

- `workspacePath`
- `historyDir`
- heartbeat defaults
- tool and permission defaults
- computer-use settings
- MCP server definitions

## Interface Summary

The TUI is chat-first.

- main transcript for user tasks and assistant replies
- bottom prompt for chat, slash commands, and `@file`
- footer pills for quick runtime context
- focused panels for operational features

Built-in panels:

- `/help`
- `/status`
- `/tasks`
- `/heartbeat`
- `/memory`
- `/dream`
- `/buddy`
- `/tools`
- `/permission`

## Controls

- type plain text: submit a mission
- type `/`: open slash entry suggestions
- type `@`: open workspace file suggestions
- `Enter`: submit
- `Shift+Enter`: newline
- `Tab`: accept current suggestion or insert the selected panel action
- `Up / Down`: select current suggestion or browse input history depending on context
- `Esc`: dismiss suggestions, close panels, clear input, or interrupt the active mission depending on context
- mouse wheel or `PageUp / PageDown`: scroll transcript or panel content
- `Ctrl+Q` or `Ctrl+C`: exit

## Tools

The runtime currently exposes these default tool categories:

- file tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`
- task delegation: `Task`
- computer-use tools:
  - `computer_open_url`
  - `computer_focus_window`
  - `computer_type_text`
  - `computer_keypress`
  - `computer_read_clipboard`
  - `computer_write_clipboard`
  - `computer_take_screenshot`
  - `computer_wait`
  - `computer_run_workflow`

Computer-use tools are registered by default so they appear in `/tools`, but they are not enabled in the default allowlist until you explicitly allow them.

If you configure MCP servers, their tools can also appear in `/tools`.

## Skills

The current runtime also loads built-in SDK skills. At the time of writing, the bundled set includes:

- `debug`
- `simplify`
- `batch`
- `verify`
- `remember`
- `stuck`
- `loop`
- `update-config`

These skills are available through the runtime even though the TUI is still centered on the panel workflow rather than a dedicated `/skills` panel.

## Project Status

This is an early-stage system.

What is already real:

- unattended task execution
- heartbeat loop
- memory extraction
- dream execution
- tool gating
- chat history and resume
- companion-style buddy layer

What is still evolving:

- more polished TUI behavior
- broader device integration
- richer skill exposure in the UI
- deeper autonomy orchestration
- more complete cloud-brain architecture across hardware surfaces

## Documentation

- English usage guide: [USAGE.md](./USAGE.md)
- Chinese usage guide: [USAGE-zh.md](./USAGE-zh.md)
- Heartbeat guide template: [HEARTBEAT.md](./HEARTBEAT.md)

## NPM Release Automation

This repository now includes a GitHub Actions workflow at [.github/workflows/npm-publish.yml](./.github/workflows/npm-publish.yml).

To use it:

1. configure npm trusted publishing for this package on npmjs.com
2. use:
   - GitHub user or org: `DeconBear`
   - repository: `actoviq_claw`
   - workflow filename: `npm-publish.yml`
3. bump the package version in `package.json`
4. create and push a matching tag such as `v0.1.0`

The workflow will then:

- install dependencies
- run typecheck
- run tests
- build the package
- publish it to npm

This repository also includes a normal CI workflow at [.github/workflows/ci.yml](./.github/workflows/ci.yml) for push and pull request verification.

Publishing is now configured for npm trusted publishing via GitHub OIDC.

## Long-Term Direction

`Actoviq Claw` should be read as the first visible shell of a larger ambition:

- a reusable AI brain
- cloud-connected when needed
- stateful across sessions
- able to inhabit different devices

In the future, that could mean:

- a desktop worker
- a mobile companion
- a robot control layer
- an embedded agent on any network-connected hardware

Today, this repository is still the early TUI prototype. It is intentionally practical first, ambitious second, and it will be refined gradually.
