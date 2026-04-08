# Actoviq Claw Usage Guide

## 1. What This Project Is

`Actoviq Claw` is a terminal-first autonomous assistant built on `actoviq-agent-sdk`.

It is not only a chat interface. It is an early implementation of a larger idea: a persistent AI brain that can eventually connect to different hardware surfaces. Today the active product surface is a TUI. In the future, the same core direction could expand to computers, phones, robots, and other network-connected devices.

At the current stage, this repository focuses on:

- a full-screen TUI
- unattended mission execution
- heartbeat-based checking
- memory and dream loops
- tool control and permission control
- chat archiving and resume

## 2. Install and Start

From the project directory:

```bash
npm install
npm run dev
```

If you want to point the assistant at another workspace:

```bash
npm run dev -- --workspace E:/your/workspace
```

## 3. Global Install After NPM Publish

Once the package is published to npm, users can install it globally and launch it from any terminal directory:

```bash
npm install -g actoviq-claw
actov
```

Behavior:

- the current shell directory becomes the working workspace
- `actov --workspace <path>` overrides the workspace explicitly
- state, chat history, and local config are then managed relative to that workspace unless changed in config

## 4. Runtime Configuration

The runtime looks for:

- `actoviq-claw.runtime.settings.local.json`

Use the example file as a template:

- [actoviq-claw.runtime.settings.example.json](./actoviq-claw.runtime.settings.example.json)

At minimum, set:

- `ACTOVIQ_BASE_URL`
- `ACTOVIQ_AUTH_TOKEN`
- `ACTOVIQ_MODEL`

Legacy field names are also accepted and mapped automatically, including older `ANTHROPIC_*` runtime fields.

## 5. App Configuration

The assistant's own app config lives in:

- `actoviq-claw.config.json`

Template:

- [actoviq-claw.config.example.json](./actoviq-claw.config.example.json)

Typical settings here include:

- `workspacePath`
- `stateDir`
- `historyDir`
- default heartbeat settings
- default permission preset
- default tool allowlist
- computer-use options
- MCP server definitions

## 6. Main Interface

The TUI is chat-first.

You mainly see:

- the main transcript
- the bottom prompt
- footer pills with runtime state
- focused operational panels opened from slash commands

The main transcript is intentionally quieter than a debug console. It prioritizes user requests and assistant replies instead of dumping every internal runtime event into the center of the screen.

## 7. Core Input Rules

- type plain text: submit a mission
- type `/`: open the slash command entry list
- type `@`: open file and path suggestions from the workspace
- `Enter`: submit the mission or run the selected command
- `Shift+Enter`: insert a newline
- `Tab`: accept the selected suggestion or insert the selected panel action into the prompt
- `Ctrl+N / Ctrl+P`: cycle the current suggestion list
- `Esc`: dismiss suggestions, close a panel, clear input, or interrupt the current mission depending on state
- mouse wheel or `PageUp / PageDown`: scroll transcript or panel content
- `Ctrl+Q` or `Ctrl+C`: exit

## 8. Slash Entry Points

The main slash entry points are:

- `/help`
- `/status`
- `/tasks`
- `/heartbeat`
- `/memory`
- `/dream`
- `/buddy`
- `/tools`
- `/permission`

The slash list is intended as an entry layer. Most feature-specific actions happen after you enter a panel.

## 9. How Panels Work

After entering a panel:

- `Up / Down`: move across quick actions
- `Enter`: run the selected action immediately
- `Tab`: insert the selected action into the prompt so you can edit it first
- mouse wheel: scroll panel content, not the quick-action selection

Example:

- open `/heartbeat`
- select `worktime`
- press `Enter`
- then choose `24h` or `hours 09:00 18:00`

## 10. Status Panel

Open:

```text
/status
```

Use it to inspect:

- current chat id and title
- archived chat count
- current workspace
- current model
- current permission preset
- effective tool count
- queue state
- current history directory

Common status-panel commands:

- `pause`
- `resume`
- `newchat`
- `sessions`
- `history`
- `history-dir <path>`

## 11. Tasks Panel

Open:

```text
/tasks
```

Use it for:

- mission overview
- cancellation
- archived chat restore

Common task commands:

- `resume`
- `resume <chat-id>`
- `resume queue`
- `cancel <mission-id>`

### Resume Flow

The resume flow is intentionally two-step:

1. open `/tasks`
2. select `resume`
3. press `Enter`
4. choose a chat id

Behavior:

- by default it shows chat ids from the current workspace only
- press `Tab` to switch to all-workspace ids
- each id is annotated with recent update time
- the selected entry exposes full detail including workspace path, creation time, and last update time

## 12. Heartbeat Panel

Open:

```text
/heartbeat
```

Heartbeat is the unattended checking loop. It can periodically inspect the system, read a guide file, and decide whether action is needed.

Top-level heartbeat actions include:

- `on`
- `off`
- `toggle`
- `tick`
- `every <minutes>`
- `worktime`
- `file <path>`
- `isolated <on|off>`

### Worktime Flow

Heartbeat worktime is intentionally a second-level picker:

1. open `/heartbeat`
2. select `worktime`
3. press `Enter`
4. choose one of:
   - `24h`
   - `hours <start> <end>`
   - `start <HH:MM>`
   - `end <HH:MM>`
   - `timezone <name|clear>`

Examples:

```text
/heartbeat
tick
```

```text
/heartbeat
every 30
```

```text
/heartbeat
worktime
24h
```

```text
/heartbeat
worktime
hours 09:00 22:30
```

```text
/heartbeat
file ./HEARTBEAT.md
```

## 13. Heartbeat Guide File

The guide file tells heartbeat what to inspect.

Default template:

- [HEARTBEAT.md](./HEARTBEAT.md)

You can point heartbeat at another file from the panel:

```text
file ./ops/HEARTBEAT.md
```

The assistant is expected to read that guide during heartbeat turns and follow it strictly.

## 14. Tools Panel

Open:

```text
/tools
```

This panel controls which tools the model is allowed to use.

The runtime can register more tools than are currently enabled. `/tools` lets you inspect and change the allowlist.

Common actions:

- `show`
- `allow all`
- `deny all`
- `reset`
- `enable <tool>`
- `disable <tool>`
- `toggle <tool>`
- `enable category computer`
- `disable category computer`
- `enable category file`

### Default Tool Groups

File tools:

- `Read`
- `Write`
- `Edit`
- `Glob`
- `Grep`

Delegation:

- `Task`

Computer-use tools:

- `computer_open_url`
- `computer_focus_window`
- `computer_type_text`
- `computer_keypress`
- `computer_read_clipboard`
- `computer_write_clipboard`
- `computer_take_screenshot`
- `computer_wait`
- `computer_run_workflow`

If you configure MCP servers, their tools can also appear in this panel.

## 15. Permission Panel

Open:

```text
/permission
```

This panel sets the broad permission envelope.

The three built-in presets are:

- `chat-only`
- `workspace-only`
- `full-access`

Relationship between `/permission` and `/tools`:

- `/permission` defines the larger boundary
- `/tools` defines the concrete allowlist
- the effective runtime capability is the intersection of both

## 16. Buddy Panel

Open:

```text
/buddy
```

Buddy is the companion layer of the system. It is not the main task engine. It gives the assistant a persistent companion identity, personality, and reaction layer.

Common buddy actions:

- `show`
- `pet`
- `intro`
- `mute`
- `unmute`
- `rename <name>`
- `persona <text>`
- `hatch <name> [personality]`

Examples:

```text
rename Mochi
persona calm and observant
pet
```

## 17. Memory Panel

Open:

```text
/memory
```

Use it to inspect:

- current memory state
- relevant memories
- session memory preview
- memory manifest preview

Common actions:

- `state`
- `refresh`
- `find <query>`

## 18. Dream Panel

Open:

```text
/dream
```

Dream is the consolidation loop. It helps the system turn accumulated context into more durable structure.

Use it to inspect:

- whether dream can currently run
- why it is blocked, if blocked
- whether automatic dream is enabled
- the most recent consolidation-ready state

Common actions:

- `state`
- `run`

The system can also run dream automatically when conditions are satisfied.

## 19. Skills

The current runtime loads built-in SDK skills even though the TUI does not yet expose a dedicated `/skills` panel.

Bundled skills currently include:

- `debug`
- `simplify`
- `batch`
- `verify`
- `remember`
- `stuck`
- `loop`
- `update-config`

These are runtime-level capabilities and can already be used internally by the SDK.

## 20. Chat History

Every launch starts a fresh chat window.

Each chat:

- receives a stable `chat_<...>` id
- is archived independently
- can be restored later

Default history location:

```text
./.actoviq-claw/history
```

To inspect or change the history directory:

1. open `/status`
2. run:

```text
history
history-dir ./my-history
```

## 21. Recommended First-Time Workflow

1. Run `npm run dev`
2. Open `/status` and confirm workspace, model, and history path
3. Open `/tools` and `/permission` to review capability boundaries
4. Open `/heartbeat` and configure interval, worktime, and guide file
5. Submit a normal natural-language mission
6. Use `/tasks -> resume` when you want to restore an older chat

## 22. Troubleshooting

### Why does every launch start a new chat?

That is the current design. New launches open a fresh chat window, and older conversations are restored by chat id.

### Why do I see tools in `/tools` that are not actually enabled?

Because registration and allowlisting are separate. A tool can be available in the catalog but still blocked by the current allowlist or permission preset.

### Why is heartbeat not always doing visible work?

Heartbeat can legitimately decide that nothing needs attention and acknowledge with `HEARTBEAT_OK`.

### Why is dream sometimes blocked?

Dream is stateful. It can be blocked by timing, locking, or session-related gates until a suitable run condition is met.

## 23. Current Limitations

This project is still early-stage.

Current limitations include:

- the main surface is still the TUI only
- some advanced runtime capabilities are not yet exposed as first-class UI panels
- cross-device and cloud-brain integration are still future goals
- the interface is still being iterated heavily

## 24. NPM Release Automation

This repository includes a GitHub Actions workflow for npm publishing:

- [npm-publish.yml](./.github/workflows/npm-publish.yml)
- [ci.yml](./.github/workflows/ci.yml)

To use it:

1. choose one publish mode:
   - add an `NPM_TOKEN` repository secret in GitHub
   - or configure npm trusted publishing for this GitHub repository
2. update the version in `package.json`
3. create and push a matching Git tag such as `v0.1.0`

The workflow will:

- install dependencies
- run typecheck
- run tests
- build the package
- publish to npm

The separate `CI` workflow runs on normal pushes and pull requests so code health is checked even when you are not publishing.

## 25. Long-Term Direction

`Actoviq Claw` is meant to be more than a terminal app.

The long-term target is an AI brain that can eventually serve as the connected intelligence layer for:

- computers
- phones
- robots
- other network-connected hardware

This repository is the early practical stage of that vision. It already demonstrates the direction, but it is still under active development and will be expanded gradually over time.
