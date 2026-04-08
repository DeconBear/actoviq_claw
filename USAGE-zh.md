# Actoviq Claw 使用教程

## 1. 项目定位

`Actoviq Claw` 是一个运行在终端里的全自动 AI 助理，基于 `actoviq-agent-sdk` 构建。

它不是一次性的问答工具，而是一个可长期运行的自治工作台：

- 你输入一条普通文本，它会把这条内容当成 mission 放进队列
- 队列可以自动执行，也可以暂停后恢复
- 空闲时会按 heartbeat 周期自动巡检
- mission 完成后会提取 session memory
- 条件满足时会运行 dream
- buddy 会作为常驻 companion 融入 TUI

## 2. 安装与启动

在当前目录执行：

```bash
npm install
npm run dev
```

如果你希望它操作别的工作区：

```bash
npm run dev -- --workspace E:/your/workspace
```

## 3. 运行时配置

程序优先读取当前目录下的：

- `actoviq-claw.runtime.settings.local.json`

可参考：

- [actoviq-claw.runtime.settings.example.json](./actoviq-claw.runtime.settings.example.json)

至少需要这些字段：

- `ACTOVIQ_BASE_URL`
- `ACTOVIQ_AUTH_TOKEN`
- `ACTOVIQ_MODEL`

旧字段名也会自动映射兼容。

另外，工具注册相关配置在：

- `actoviq-claw.config.json`

可参考：

- [actoviq-claw.config.example.json](./actoviq-claw.config.example.json)

这里可以配置：

- 是否注册 computer-use 工具
- computer-use 工具前缀
- 额外 MCP servers

## 4. 启动后界面

当前 TUI 采用聊天优先的全屏布局，主要由三部分组成：

- 主聊天记录区
- 底部输入区
- 底部状态 pills

所有功能都从输入区进入，不再放一个常驻大面板。

### 主聊天记录区

默认只显示两类内容：

- 你的输入
- 助理的回复

heartbeat、memory、dream、tool call 这些过程信息不会持续刷进主聊天区。

### 底部输入区

- 输入普通文本：提交一个 mission
- 输入 `/`：打开命令入口
- 输入 `@`：补全工作区文件和路径
- `Shift+Enter`：换行

### 底部状态 pills

底部会显示当前关键状态，例如：

- 当前权限预设
- heartbeat 状态
- dream 状态
- buddy 状态
- tasks 数量
- memory 状态
- 当前模型

## 5. 快捷键

- `/`：打开 slash 命令入口
- `@`：补全工作区文件和路径
- `Up / Down`：
  - 输入框里有文本时，切换输入历史
  - 建议列表打开时，移动当前选项
  - 输入框为空且无建议时，滚动聊天记录
- `Tab`：接受当前建议，或继续补全共同前缀
- `Enter`：提交任务或执行当前选项
- `Shift+Enter`：在输入框内换行
- `Esc`：
  - 先关闭建议列表
  - 再关闭当前面板
  - 输入框非空时，双击清空
  - mission 正在运行时，可以中断当前任务
- 鼠标滚轮 / `PageUp` / `PageDown`：滚动聊天记录
- `Ctrl+N / Ctrl+P`：在建议列表中上下移动
- `Ctrl+Q` / `Ctrl+C`：退出
- `?`：打开帮助面板

## 6. Slash 命令入口

当前可用入口有：

- `/help`
- `/status`
- `/tasks`
- `/heartbeat`
- `/memory`
- `/dream`
- `/buddy`
- `/tools`
- `/permission`

这些命令现在主要是“进入某个功能面板”的入口，不再把所有子命令都塞进 `/` 列表里。

## 7. 面板通用交互

进入任何一个面板后，都可以这样操作：

- `Up / Down`：选择面板中的 quick actions
- `Enter`：直接执行当前选中项
- `Tab`：把当前选中项填进输入框，便于继续改成自定义参数

例如：

- 选中 `start 08:00` 后按 `Tab`，再把它改成 `start 09:30`
- 选中 `file ./HEARTBEAT.md` 后按 `Tab`，再改成你自己的路径

## 8. 常见用法

### 8.1 提交普通任务

直接输入自然语言即可：

```text
检查当前仓库的发布风险，并给出一个可执行清单
```

### 8.2 使用 `/heartbeat`

先输入：

```text
/heartbeat
```

进入后可以直接选择或输入：

- `tick`
- `on`
- `off`
- `every 30`
- `start 09:00`
- `end 22:30`
- `hours 09:00 22:30`
- `timezone Asia/Shanghai`
- `file ./HEARTBEAT.md`
- `isolated on`

### 8.3 使用 `/tools`

先输入：

```text
/tools
```

面板里会显示：

- 全局动作：`show`、`allow all`、`deny all`、`reset`
- 分类动作：例如 `enable category computer`
- 每个工具的一行状态

你可以：

- 直接选中某个工具并按 `Enter`，切换它的允许状态
- 或按 `Tab` 把动作填进输入框后再编辑

当前模型侧直接可用的工具通常包括：

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

说明：

- file tools 和 `Task` 默认就在 allowlist 里
- computer-use 工具默认会注册进系统，因此你能在 `/tools` 里看到它们
- 但它们默认不在 allowlist 中，需要你自己启用
- 如果你配置了 MCP servers，它们暴露出来的工具也会自动出现在 `/tools`

### 8.4 使用 `/permission`

先输入：

```text
/permission
```

可选三种权限预设：

- `chat-only`
  - 仅聊天回复，不允许模型使用工具
- `workspace-only`
  - 只允许工作区文件相关工具生效
- `full-access`
  - 所有已启用工具都可运行

`/permission` 和 `/tools` 是叠加关系：

- `/permission` 决定大范围模式
- `/tools` 决定具体哪些工具在 allowlist 中

最终生效的是两者的交集。

### 8.5 使用 `/buddy`

先输入：

```text
/buddy
```

进入后可以直接选择或输入：

- `show`
- `pet`
- `intro`
- `mute`
- `unmute`
- `rename Mochi`
- `persona quietly observant and warm`
- `hatch Mochi calm and observant`

## 9. 各面板说明

### `/status`

查看整体运行状态：

- 当前 chat
- 当前工作区
- 当前模型
- 当前权限模式
- 工具生效数量
- paused / busy / idle
- 队列与后台任务

### `/tasks`

查看：

- 最近 missions
- 后台任务
- 已归档聊天

### `/heartbeat`

查看和配置：

- 是否开启
- 心跳间隔
- 活跃时间窗
- 时区
- heartbeat guide 文件路径
- 是否使用 isolated session

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
- 等待整理的 session

### `/buddy`

查看：

- companion 形态
- 名字、物种、帽子、眼睛、稀有度
- personality
- stats
- intro prompt
- 最新 reaction

### `/tools`

查看：

- 当前注册的全部工具
- 每个工具当前是 enabled / disabled / blocked by preset
- 按 category 分类后的数量
- allowlist 与最终生效数量

### `/permission`

查看：

- 当前预设
- 当前底层运行模式
- 当前真正生效的工具集合

## 10. Heartbeat、Buddy、Memory、Dream

### Heartbeat

Heartbeat 用来让助理在无人值守时自动巡检：

- 周期执行
- 读取 [HEARTBEAT.md](./HEARTBEAT.md)
- 当前 mission 忙碌时会跳过本轮
- 返回 `HEARTBEAT_OK` 时会内部记录成功，但不打扰主聊天流

### Buddy

Buddy 是 `actoviq-agent-sdk` companion 能力在 TUI 里的落地：

- 默认会自动 hatch
- 支持 pet / mute / unmute / rename / persona / hatch
- 有底部 companion dock 和 reaction bubble

### Memory

Memory 负责长期记住项目上下文：

- mission 完成后自动抽取 session memory
- `/memory find <query>` 可检索相关记忆

### Dream

Dream 用来做更长周期的整理与沉淀：

- `autoDream` 开启时会按条件自动尝试运行
- 也可以通过 `/dream` 面板手动触发

## 11. 聊天历史恢复

每次启动默认都会开启一个新的聊天窗口。

如果要恢复旧聊天：

```text
/resume
```

然后可以继续：

- `list`
- `last`
- `<chat-id>`

也可以直接进入 `/tasks` 面板查看 archived chats。

## 12. 心跳配置文件

默认心跳说明文件是：

- [HEARTBEAT.md](./HEARTBEAT.md)

你可以在 `/heartbeat` 面板里通过 `file <path>` 改成自己的文件。

## 13. 建议的第一次体验流程

建议你第一次启动后按这个顺序试：

1. 输入 `/status`
2. 输入 `/permission`
3. 切到 `workspace-only`
4. 输入 `/tools`
5. 看一下当前允许的工具
6. 输入 `/heartbeat`
7. 试一次 `tick`
8. 输入一个普通任务
9. 用 `@` 提及工作区里的文件

这样最快能把整个系统摸熟。
