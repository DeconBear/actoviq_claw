# Actoviq Claw 使用教程

## 1. 项目定位

`Actoviq Claw` 是一个运行在终端里的全自动 AI 助理，基于 `actoviq-agent-sdk` 构建。

它不是一次性的问答工具，而是一套可长期运行的自治工作台：

- 你输入普通文本，它会把内容作为 mission 放进队列
- 队列可以自动执行，也可以暂停和恢复
- 空闲时会按 heartbeat 周期自动巡检
- 任务结束后会提取 memory
- 条件满足时会运行 dream
- buddy 会作为常驻 companion 融入 TUI

## 2. 安装与启动

在当前目录执行：

```bash
npm install
npm run dev
```

如果你想让它操作别的工作区：

```bash
npm run dev -- --workspace E:/your/workspace
```

## 3. 运行时配置

程序优先读取：

- `actoviq-claw.runtime.settings.local.json`

可以参考：

- [actoviq-claw.runtime.settings.example.json](./actoviq-claw.runtime.settings.example.json)

至少需要这些字段：

- `ACTOVIQ_BASE_URL`
- `ACTOVIQ_AUTH_TOKEN`
- `ACTOVIQ_MODEL`

旧字段名也会自动兼容映射。

应用自身配置文件是：

- `actoviq-claw.config.json`

可以参考：

- [actoviq-claw.config.example.json](./actoviq-claw.config.example.json)

这里可以配置：

- `stateDir`
- `historyDir`
- heartbeat 默认参数
- tools / permission 默认策略
- computer-use 和 MCP servers

## 4. 界面结构

当前 TUI 采用聊天优先的全屏布局，主要分成三部分：

- 主聊天记录区
- 底部输入区
- 底部状态 pills

默认不会把 heartbeat、memory、dream、tool call 这些过程日志持续刷进主聊天区，主界面只保留用户输入和助手回答。

## 5. 基本交互

- 输入普通文本：提交一个 mission
- 输入 `/`：打开命令入口
- 输入 `@`：补全工作区文件和路径
- `Enter`：提交任务或执行当前命令
- `Shift+Enter`：在输入框内换行
- `Tab`：接受当前建议，或继续补全公共路径前缀
- `Up / Down`
  - 当建议列表打开时：移动当前选项
  - 当输入框里已经有文本时：切换输入历史
  - 当输入框为空且没有建议时：滚动聊天记录
- `Esc`
  - 先关闭建议列表
  - 再关闭当前面板
  - 再次按下可清空输入
  - 当前 mission 正在运行时可中断任务
- 鼠标滚轮 / `PageUp` / `PageDown`：滚动聊天记录或当前面板正文
- `Ctrl+N / Ctrl+P`：切换当前建议项
- `Ctrl+Q` / `Ctrl+C`：退出
- `?`：打开帮助面板

## 6. Slash 入口

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

这些命令主要是“进入某个面板”，不是把所有子命令都堆在 `/` 列表里。

## 7. 面板内如何操作

进入任意面板后，可以这样用：

- `Up / Down`：选择 quick actions
- `Enter`：直接执行当前选中项
- `Tab`：把当前选中项填进输入框，再继续编辑
- 鼠标滚轮：滚动面板正文，不操作 quick actions

例如：

- 在 `/heartbeat` 里选中 `start 08:00` 后按 `Tab`，再改成 `start 09:30`
- 在 `/tools` 里选中某个 tool 后按 `Enter`，直接切换允许状态

## 8. 聊天历史与恢复

这是当前版本新增的一条重要能力。

- 每次启动都会新开一个 chat 窗口
- 每个 chat 都有稳定的 chat id，例如 `chat_abcd1234_xyz987`
- 每个已归档 chat 都会按 id 单独保存成一个 JSON 文件
- 默认保存目录是 `historyDir`

默认示例路径：

```text
./.actoviq-claw/history
```

恢复方式有两种：

- 在输入框里直接执行：

```text
/resume <chat-id>
```

- 或进入 `/tasks`，直接选择对应的 `resume <chat-id>`
  - 现在更推荐：先进入 `/tasks`
  - 选中 `resume` 后按 `Enter`
  - 默认先显示当前工作区的 chat ids
  - 在 resume picker 里按 `Tab` 可以切到“所有工作区 ids”
  - 每个 id 后面都会显示最近修改时间和工作区路径

查看和修改历史保存路径：

1. 输入 `/status`
2. 在状态面板里执行：

```text
history
history-dir ./my-history
```

## 9. 常见面板

### `/status`

查看整体运行状态，包括：

- 当前 chat 标题和 chat id
- 已归档聊天数量
- 当前 historyDir
- 当前工作区
- 当前模型
- 当前权限模式
- 当前生效工具数量
- 队列状态

常用命令：

- `pause`
- `resume`
- `newchat`
- `sessions`
- `history`
- `history-dir <path>`

### `/tasks`

查看：

- 最近 missions
- 后台任务
- 已归档 chats

常用命令：

- `resume`
- `resume <chat-id>`
- `resume queue`
- `cancel <mission-id>`

### `/heartbeat`

用于配置无人值守巡检。

可操作项包括：

- `on`
- `off`
- `tick`
- `every 30`
- `start 09:00`
- `end 22:30`
- `hours 09:00 22:30`
- `timezone Asia/Shanghai`
- `file ./HEARTBEAT.md`
- `isolated on`

### `/tools`

用于查看和控制模型可使用的工具。

你会看到：

- 当前已注册 tool 数量
- 当前已配置 / 实际生效的 tool 数量
- quick actions
- 每个 tool 的独立开关

常见操作：

- `show`
- `allow all`
- `deny all`
- `reset`
- `enable category computer`
- `disable <tool>`
- `enable <tool>`

当前常见 tools 包括：

- `Read`
- `Write`
- `Edit`
- `Glob`
- `Grep`
- `Task`
- `computer_open_url`
- `computer_focus_window`
- `computer_type_text`
- `computer_keypress`
- `computer_read_clipboard`
- `computer_write_clipboard`
- `computer_take_screenshot`
- `computer_wait`
- `computer_run_workflow`

如果配置了 MCP servers，它们暴露出来的工具也会自动出现在 `/tools`。

### `/permission`

用于设置权限预设。

可选三种模式：

- `chat-only`
- `workspace-only`
- `full-access`

关系是：

- `/permission` 决定大范围权限边界
- `/tools` 决定具体 allowlist
- 最终生效的是两者的交集

### `/buddy`

用于控制 companion。

常用命令：

- `show`
- `pet`
- `intro`
- `mute`
- `unmute`
- `rename Mochi`
- `persona calm and observant`
- `hatch Mochi quietly supportive and curious`

### `/memory`

查看：

- auto memory 状态
- relevant memories
- session memory 摘要
- manifest 摘要

### `/dream`

查看：

- 是否可运行
- 阻塞原因
- 距离上次 consolidation 的时间
- 等待整理的 session 数量

## 10. 一个推荐上手流程

1. 启动 `npm run dev`
2. 先输入 `/status` 看当前 workspace、model、historyDir
3. 输入 `/tools` 和 `/permission` 确认工具和权限边界
4. 输入 `/heartbeat` 配置巡检周期和 guide 文件
5. 直接提交自然语言任务
6. 需要恢复旧会话时，用 `/resume <chat-id>`，或者进入 `/tasks` 后用 `resume` picker

## 11. 常见问题

### 为什么每次启动都是一个新 chat？

这是当前设计的一部分。新启动默认新开窗口，旧 chat 通过 chat id 恢复，这样更接近 Claude Code 的会话方式。

### 如何知道历史文件保存到哪里？

用 `/status` 面板里的：

- `history`

### 如何修改历史保存位置？

用 `/status` 面板里的：

- `history-dir <path>`

### 为什么 `/tools` 里能看到 computer tools，但默认不一定能用？

因为它们默认是“已注册但未必在 allowlist 中”。这样你能看见能力范围，但不会一上来就放开桌面操作权限。
