# Actoviq Claw 使用教程

## 1. 项目定位

`Actoviq Claw` 是一个基于 `actoviq-agent-sdk` 构建的终端自治 AI 助理。

它不只是一个聊天界面，也不只是一次性的问答工具。这个仓库更像是一个更大方向的早期原型：尝试做一个可持续运行、可长期记忆、可连接不同硬件外壳的 AI 大脑。当前阶段的主要表现形态还是 TUI，但未来目标并不局限于电脑终端，而是希望逐步扩展到手机、机器人以及各种可联网的硬件设备。

当前这个仓库聚焦的是：

- 全屏 TUI
- 无人值守任务执行
- heartbeat 巡检
- memory 与 dream 循环
- tools 与 permission 控制
- chat 历史归档与恢复

## 2. 安装与启动

在项目目录执行：

```bash
npm install
npm run dev
```

如果你想让它操作别的工作区：

```bash
npm run dev -- --workspace E:/your/workspace
```

## 3. 运行时配置

运行时默认读取：

- `actoviq-claw.runtime.settings.local.json`

可参考模板：

- [actoviq-claw.runtime.settings.example.json](./actoviq-claw.runtime.settings.example.json)

至少需要配置：

- `ACTOVIQ_BASE_URL`
- `ACTOVIQ_AUTH_TOKEN`
- `ACTOVIQ_MODEL`

旧字段名也会自动兼容映射，包括已有的 `ANTHROPIC_*` 字段。

## 4. 应用配置

应用自身配置文件是：

- `actoviq-claw.config.json`

可参考：

- [actoviq-claw.config.example.json](./actoviq-claw.config.example.json)

这里常见的配置项包括：

- `workspacePath`
- `stateDir`
- `historyDir`
- heartbeat 默认参数
- 默认权限预设
- 默认工具 allowlist
- computer-use 配置
- MCP server 配置

## 5. 界面结构

当前 TUI 是聊天优先的布局。

你主要会看到：

- 主聊天记录区
- 底部输入框
- 底部状态 pills
- 通过 slash 打开的功能面板

主聊天区刻意保持克制，不会像调试控制台一样把所有内部事件都刷出来。它更偏向展示用户任务与助手回答，而把运维和运行态信息收进面板与底部状态区。

## 6. 基础输入规则

- 输入普通文本：提交一个 mission
- 输入 `/`：打开 slash 入口
- 输入 `@`：打开工作区文件和路径补全
- `Enter`：提交任务或执行当前命令
- `Shift+Enter`：在输入框中换行
- `Tab`：接受当前建议，或把当前面板动作填入输入框
- `Ctrl+N / Ctrl+P`：切换当前建议项
- `Esc`：关闭建议、关闭面板、清空输入、或中断当前任务，具体取决于上下文
- 鼠标滚轮 / `PageUp` / `PageDown`：滚动聊天记录或面板正文
- `Ctrl+Q` 或 `Ctrl+C`：退出

## 7. Slash 入口

当前主要入口有：

- `/help`
- `/status`
- `/tasks`
- `/heartbeat`
- `/memory`
- `/dream`
- `/buddy`
- `/tools`
- `/permission`

这里的设计目标是“先进入面板，再执行具体动作”，而不是把所有子命令一次性堆在 `/` 列表里。

## 8. 面板内如何操作

进入任意面板后：

- `Up / Down`：在 quick actions 中移动
- `Enter`：直接执行当前动作
- `Tab`：把当前动作填进输入框，再手动修改后执行
- 鼠标滚轮：滚动面板正文，不操作 quick actions

例如：

1. 输入 `/heartbeat`
2. 选中 `worktime`
3. 按 `Enter`
4. 再选择 `24h` 或 `hours 09:00 18:00`

## 9. Status 面板

打开方式：

```text
/status
```

它主要用于查看：

- 当前 chat id 和标题
- 已归档 chat 数量
- 当前工作区
- 当前模型
- 当前 permission preset
- 当前有效 tools 数量
- 队列状态
- 当前 history 目录

常见命令：

- `pause`
- `resume`
- `newchat`
- `sessions`
- `history`
- `history-dir <path>`

## 10. Tasks 面板

打开方式：

```text
/tasks
```

主要用途：

- 查看 mission
- 取消任务
- 恢复历史 chat

常见命令：

- `resume`
- `resume <chat-id>`
- `resume queue`
- `cancel <mission-id>`

### Resume 恢复流程

当前推荐恢复方式是两步走：

1. 打开 `/tasks`
2. 选中 `resume`
3. 按 `Enter`
4. 再从列表里选择 chat id

当前行为：

- 默认只展示当前工作区的 chat ids
- 在该 picker 中按 `Tab` 可以切换为“所有工作区 ids”
- 每个 id 会显示最近更新时间
- 当前选中的项会额外展示完整信息，包括工作区路径、创建时间和最近修改时间

## 11. Heartbeat 面板

打开方式：

```text
/heartbeat
```

heartbeat 是系统的无人值守巡检循环。它会周期性地检查当前状态、读取 guide 文件，并决定是否需要继续处理。

heartbeat 顶层常见动作：

- `on`
- `off`
- `toggle`
- `tick`
- `every <minutes>`
- `worktime`
- `file <path>`
- `isolated <on|off>`

### Worktime 配置流程

heartbeat 的工作时间是二级配置入口：

1. 打开 `/heartbeat`
2. 选中 `worktime`
3. 按 `Enter`
4. 再选择：
   - `24h`
   - `hours <start> <end>`
   - `start <HH:MM>`
   - `end <HH:MM>`
   - `timezone <name|clear>`

示例：

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

## 12. Heartbeat Guide 文件

guide 文件决定 heartbeat 巡检时应该重点看什么。

默认模板：

- [HEARTBEAT.md](./HEARTBEAT.md)

你也可以在面板里改成别的文件：

```text
file ./ops/HEARTBEAT.md
```

heartbeat 执行时会尝试读取该文件，并按其中的规则执行。

## 13. Tools 面板

打开方式：

```text
/tools
```

这个面板用于控制模型当前允许使用哪些工具。

系统运行时实际注册的工具，可能会比当前 allowlist 中启用的工具更多。`/tools` 的作用就是查看目录并控制 allowlist。

常见动作：

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

### 当前默认工具分类

文件工具：

- `Read`
- `Write`
- `Edit`
- `Glob`
- `Grep`

委派工具：

- `Task`

computer-use 工具：

- `computer_open_url`
- `computer_focus_window`
- `computer_type_text`
- `computer_keypress`
- `computer_read_clipboard`
- `computer_write_clipboard`
- `computer_take_screenshot`
- `computer_wait`
- `computer_run_workflow`

如果你配置了 MCP servers，那么它们暴露出来的工具也会出现在 `/tools` 中。

## 14. Permission 面板

打开方式：

```text
/permission
```

这个面板用来设定更大的权限边界。

当前内置三种预设：

- `chat-only`
- `workspace-only`
- `full-access`

`/permission` 与 `/tools` 的关系是：

- `/permission` 决定大边界
- `/tools` 决定具体 allowlist
- 最终生效的是两者的交集

## 15. Buddy 面板

打开方式：

```text
/buddy
```

buddy 是 companion 层，不是主任务引擎。它负责系统里的陪伴感、人格设定、反应层和长期 companion 身份。

常见动作：

- `show`
- `pet`
- `intro`
- `mute`
- `unmute`
- `rename <name>`
- `persona <text>`
- `hatch <name> [personality]`

示例：

```text
rename Mochi
persona calm and observant
pet
```

## 16. Memory 面板

打开方式：

```text
/memory
```

主要用于查看：

- 当前 memory 状态
- relevant memories
- session memory 摘要
- manifest 摘要

常见动作：

- `state`
- `refresh`
- `find <query>`

## 17. Dream 面板

打开方式：

```text
/dream
```

dream 是系统的整理与归纳循环。它会把累积的上下文进一步整理为更稳定的结构。

你可以在这里查看：

- 当前 dream 是否可运行
- 如果被阻塞，阻塞原因是什么
- 当前是否开启了自动 dream
- 最近是否具备 consolidation 条件

常见动作：

- `state`
- `run`

系统也可以在条件合适时自动执行 dream。

## 18. Skills

当前 runtime 会加载 SDK 内置 skills，虽然 TUI 里还没有独立的 `/skills` 面板。

目前默认 bundled skills 包括：

- `debug`
- `simplify`
- `batch`
- `verify`
- `remember`
- `stuck`
- `loop`
- `update-config`

这些能力当前已经在 runtime 层可用。

## 19. 聊天历史

每次启动都会新开一个 chat 窗口。

每个 chat：

- 都会生成稳定的 `chat_<...>` id
- 都会独立归档
- 后续可以按 id 恢复

默认历史目录：

```text
./.actoviq-claw/history
```

查看或修改 history 目录的方法：

1. 打开 `/status`
2. 执行：

```text
history
history-dir ./my-history
```

## 20. 推荐的首次使用流程

1. 运行 `npm run dev`
2. 打开 `/status`，确认 workspace、model 和 history 路径
3. 打开 `/tools` 和 `/permission`，确认能力边界
4. 打开 `/heartbeat`，设置间隔、工作时间和 guide 文件
5. 直接提交自然语言任务
6. 需要恢复旧会话时，使用 `/tasks -> resume`

## 21. 常见问题

### 为什么每次启动都会新建一个 chat？

这是当前设计的一部分。新启动默认新开窗口，旧聊天通过 chat id 恢复。

### 为什么 `/tools` 里能看到一些工具，但默认不一定能直接用？

因为工具“注册”和“允许使用”是两层逻辑。它可能已经出现在目录里，但仍然被 allowlist 或 permission preset 限制。

### 为什么 heartbeat 有时看起来没有做事？

因为 heartbeat 可能检查后判断当前没有需要处理的事情，然后正常返回 `HEARTBEAT_OK`。

### 为什么 dream 有时不能立即运行？

dream 是带状态的，它可能因为时间门控、锁或 session 条件而暂时不可执行。

## 22. 当前限制

这个项目仍然处于早期阶段。

当前限制包括：

- 主界面目前仍然只有 TUI
- 一些 runtime 能力还没有全部做成一等 UI 面板
- 跨设备与云端 AI 大脑能力还处于未来目标阶段
- 交互界面仍在持续迭代

## 23. 长期方向

`Actoviq Claw` 不应该只被理解成一个终端程序。

它更长期的目标，是成为一个可以连接不同硬件外壳的 AI 大脑：

- 可以在电脑里
- 可以在手机里
- 可以在机器人里
- 也可以进入其他任何可联网的硬件设备

当前这个仓库就是这个方向的第一个可运行阶段。它已经展示了方向，但仍然是早期版本，后续会持续完善、扩展和重构。
