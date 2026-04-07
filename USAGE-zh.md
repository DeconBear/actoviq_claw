# Actoviq Claw 使用教程

## 1. 它是什么

`Actoviq Claw` 是一个运行在终端中的全自动 AI 助理，基于 `actoviq-agent-sdk` 构建。

它的默认使用方式不是“单次问答”，而是“长期驻留 + 持续接任务”：

- 你输入一句自然语言，它会把这句话当作一个 mission 放进队列
- 队列可以自动运行，也可以暂停后手动恢复
- 空闲时可以按 heartbeat 周期巡检
- 任务完成后会提取 session memory
- 合适的时候会触发 dream 做长期记忆整理
- buddy 会作为陪伴式角色融入整个运行时

## 2. 安装

在当前目录执行：

```bash
npm install
```

## 3. 运行时配置

程序优先读取当前目录下的：

- `actoviq-claw.runtime.settings.local.json`

可以参考：

- [actoviq-claw.runtime.settings.example.json](./actoviq-claw.runtime.settings.example.json)

最少需要准备：

- `ACTOVIQ_BASE_URL`
- `ACTOVIQ_AUTH_TOKEN`
- `ACTOVIQ_MODEL`

如果你已经有旧版运行时配置，这个项目也会自动兼容映射，不需要重新改历史字段。

## 4. 启动

```bash
npm run dev
```

如果你想让它操作别的工作区：

```bash
npm run dev -- --workspace E:/your/workspace
```

## 5. 首次启动会做什么

首次启动时，程序会自动完成这些初始化：

1. 创建 `actoviq-claw.config.json`
2. 创建 `HEARTBEAT.md`
3. 创建本地状态目录 `./.actoviq-claw/`
4. 初始化本地 session 存储 `./.actoviq-claw/sessions/`
5. 启用 memory / compact / dream 相关运行时能力
6. 如果还没有 buddy，就自动孵化一个默认 buddy

## 6. 当前 TUI 结构

现在的界面是“全屏聊天流 + 底部输入栏”的形式，重点是把注意力放回对话和任务本身，而不是一直盯着监控面板。

### 主聊天流

主区域默认只显示两类内容：

- 你提交的任务
- 助理返回的回答

不会在主聊天流里持续刷这些过程性信息：

- 工具调用细节
- memory 提取过程
- dream 过程日志
- heartbeat 内部巡检日志

这些能力仍然存在，只是被移到了 `/` 命令和下方面板里。

### 底部输入栏

底部只有一个输入框：

- 输入普通文本：提交任务
- 输入 `/`：打开命令面板
- 输入完整 `/命令`：直接执行控制动作
- `Shift+Enter` 或 `Meta+Enter`：在输入框里换行
- 当 `/` 命令存在更完整匹配时，输入框会直接显示内联补全提示

### 底部状态区

输入框下方会显示两行简洁状态信息：

- 一行交互提示，例如 `/ commands`、`Esc interrupt`、`Up/Down history`
- 一行状态 pills，用来展示 auto / heartbeat / dream / buddy / tasks / model / memory

## 7. 快捷键

- `/`：打开命令建议
- `@`：补全工作区中的文件和路径
- 建议列表会直接显示在输入区 footer，不会占满整个屏幕
- `Up / Down`：在输入框非空时切换输入历史
- `Tab`：接受当前建议，或把多个文件建议的公共前缀继续补全
- `Ctrl+N / Ctrl+P`：在当前建议列表中切换
- `Enter`：提交任务或执行命令
- `Shift+Enter`：在输入框里换行
- `Esc`：先收起当前建议；再按可关闭面板；输入框非空时按两次可清空；空输入时可中断当前 mission
- `Left / Right`：面板打开时切换不同面板
- `鼠标滚轮 / PageUp / PageDown`：滚动主聊天流
- `Ctrl+Q`：退出
- `Ctrl+C`：退出
- `?`：在空输入状态下打开帮助面板

## 8. 输入方式

### 8.1 普通任务

直接输入一句自然语言即可，它会被放进 mission 队列：

```text
检查当前仓库的发布风险，并给出一个可执行清单
```

### 8.2 Slash 命令

当前常用命令包括：

- `/help`
- `/pause`
- `/resume`
- `/resume list`
- `/resume queue`
- `/status`
- `/tasks`
- `/sessions`
- `/cancel <mission-id>`
- `/heartbeat on`
- `/heartbeat off`
- `/heartbeat tick`
- `/heartbeat every 30`
- `/buddy`
- `/buddy pet`
- `/buddy mute`
- `/buddy unmute`
- `/buddy hatch Mochi calm and observant`
- `/memory`
- `/memory state`
- `/memory find 发布流程`
- `/dream`
- `/dream now`
- `/dream state`

其中：

- `/help /status /tasks /memory /dream /buddy` 会打开对应面板
- `/pause /resume /resume list /resume queue /heartbeat ... /buddy ... /dream ... /memory find ...` 会执行动作

## 9. 各个面板的作用

### `/status`

查看整体运行状态：

- 当前工作区
- 当前模型
- 权限模式
- paused / busy / idle
- heartbeat 周期和最近结果
- auto run / auto memory / auto dream 状态

### `/tasks`

查看最近任务和后台任务：

- 最近 missions
- 每个任务的状态、标题、工具调用数量、模型
- background tasks 的运行情况

### `/memory`

查看记忆状态：

- 是否开启自动 memory
- 当前缓存到的 relevant memories
- session memory 摘要
- manifest 摘要

### `/dream`

查看做梦状态：

- 是否开启
- 是否满足运行条件
- 当前阻塞原因
- 距离上次整理过去多久
- 还有多少 session 等待整理

### `/buddy`

查看 buddy 信息：

- 名称
- 物种
- 稀有度
- 是否静音
- 性格
- 属性统计

### `/help`

查看当前支持的命令和快捷键。

## 10. Heartbeat / Buddy / Memory / Dream

### Heartbeat

Heartbeat 用来让助理在无人值守时继续周期巡检：

- 按配置周期自动执行
- 读取当前工作区里的 [HEARTBEAT.md](./HEARTBEAT.md)
- 如果当前有 mission 正在运行，就跳过本轮，等待下一次机会
- 如果模型返回 `HEARTBEAT_OK`，内部会记录成功，但不会刷屏打扰主聊天流

你可以直接修改 `HEARTBEAT.md` 来改变巡检策略。

### Buddy

Buddy 是 `actoviq-agent-sdk` 的 companion 能力在这个 TUI 中的落地：

- 首次启动会自动孵化默认 buddy
- 可以 `/buddy pet`
- 可以 `/buddy mute` 和 `/buddy unmute`
- 可以 `/buddy hatch <name> [personality]` 重新孵化

### Memory

Memory 负责让助理在长周期运行中逐渐记住项目：

- 每个 mission 完成后会尝试提取 session memory
- `/memory find <query>` 可以搜索相关记忆
- 相关 durable memory 仍由 SDK 负责管理

### Dream

Dream 用来做较长周期的整理和沉淀：

- 如果开启 `autoDream`，任务结束后会按条件自动尝试运行
- `/dream now` 可以手动触发
- dream 的状态和阻塞原因可以在 `/dream` 面板里查看

## 11. 数据落盘位置

- 本地状态：`./.actoviq-claw/state.json`
- 本地 sessions：`./.actoviq-claw/sessions/`
- 本地 runtime 配置：`./actoviq-claw.runtime.settings.local.json`
- 应用配置：`./actoviq-claw.config.json`

更长期的 durable memory 仍由 SDK 自己管理，通常位于用户目录下的 Actoviq 数据目录。

## 12. 推荐使用方式

更适合这套工具的工作流是：

1. 让它长期驻留在一个工作区
2. 持续把你要做的事情投进 mission 队列
3. 用 heartbeat 让它在空闲时主动巡检
4. 用 memory 和 dream 让它逐渐熟悉你的项目
5. 需要看内部状态时，再用 `/status /tasks /memory /dream /buddy`

## 13. 常用验证命令

开发阶段常用：

```bash
npm run typecheck
npm test
npm run build
```
