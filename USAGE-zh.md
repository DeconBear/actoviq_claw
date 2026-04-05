# Actoviq Claw 使用教程

## 1. 项目定位

`Actoviq Claw` 是一个运行在终端里的全自动 AI 助理。它不是普通的聊天壳，而是一个带有自治循环的 TUI：

- 用户输入普通文本后，会被当成一个 mission 放入任务队列
- 助理会自动取队列任务执行
- 长任务结束后会抽取 session memory
- 在满足条件时会触发 dream 做长期记忆整理
- 空闲时会按心跳周期读取 `HEARTBEAT.md` 做自主巡检

## 2. 依赖安装

在当前目录执行：

```bash
npm install
```

## 3. Runtime 配置

本项目优先读取本地的 `actoviq-claw.runtime.settings.local.json`。

如果这个文件不存在，程序会尝试：

1. 读取 `~/.actoviq/settings.json`
2. 自动复制一份到当前目录作为本地 runtime 配置

如果你还没有可用配置，可以参考：

- [actoviq-claw.runtime.settings.example.json](./actoviq-claw.runtime.settings.example.json)

## 4. 启动

```bash
npm run dev
```

如果希望让它操作其他目录，而不是当前项目根目录：

```bash
npm run dev -- --workspace E:/your/workspace
```

## 5. 首次启动会发生什么

程序会自动完成这些步骤：

1. 创建 `actoviq-claw.config.json`（如果还不存在）
2. 创建 `HEARTBEAT.md`（如果还不存在）
3. 创建本地状态目录 `.actoviq-claw/`
4. 初始化本地 session 存储 `.actoviq-claw/sessions/`
5. 启用 `autoCompactEnabled / autoMemoryEnabled / autoDreamEnabled`
6. 如果没有 buddy，就自动孵化一个默认 buddy

## 6. TUI 面板说明

- `Status`：工作区、模型、暂停状态、心跳下次触发时间
- `Missions`：任务队列和最近任务
- `Buddy`：伙伴状态与属性
- `Memory & Dream`：相关记忆、session memory、dream 状态
- `Background`：后台 dream 或委派任务
- `Console`：运行日志和流式输出
- `Command / Mission`：底部输入框

## 7. 快捷键

- `Ctrl+Q`：退出
- `Ctrl+C`：退出
- `Ctrl+H`：手动触发一次 heartbeat
- `Ctrl+D`：手动触发一次 dream
- `Ctrl+P`：抚摸 buddy
- `Ctrl+Space`：暂停或恢复自动任务队列

## 8. 输入方式

### 8.1 普通文本

直接输入一句自然语言，就会进入 mission 队列：

```text
检查当前仓库的发布风险，并给出一个可执行清单
```

### 8.2 命令

支持这些命令：

- `/help`
- `/pause`
- `/resume`
- `/status`
- `/tasks`
- `/sessions`
- `/cancel <mission-id>`
- `/heartbeat on`
- `/heartbeat off`
- `/heartbeat tick`
- `/heartbeat every 30`
- `/buddy pet`
- `/buddy mute`
- `/buddy unmute`
- `/buddy hatch Luna calm and observant`
- `/memory state`
- `/memory find 发布流程`
- `/dream now`
- `/dream state`

## 9. 心跳模式

心跳逻辑参考了 OpenClaw 的设计，但是这里做成了纯 TUI 本地版：

- 默认按 `20` 分钟执行一次
- 会读取当前工作区的 [HEARTBEAT.md](./HEARTBEAT.md)
- 如果回复是 `HEARTBEAT_OK`，且后续文本不超过阈值，就只做内部确认，不制造噪音
- 如果当前有 mission 正在运行，heartbeat 会跳过本次轮询并等待下一次

你可以直接修改 `HEARTBEAT.md` 来改变自治巡检内容。

## 10. Buddy、Memory、Dream

### Buddy

- 首次启动会自动孵化默认 buddy
- buddy 会通过 `actoviq-agent-sdk` 的 companion 能力进入上下文
- 可以用 `/buddy pet`、`/buddy mute`、`/buddy hatch ...` 控制

### Memory

- 每个 mission 完成后，程序会尝试执行 `session.extractMemory()`
- 最新 session memory 会显示在 `Memory & Dream` 面板
- `/memory find <query>` 可以查询相关长期记忆

### Dream

- 若配置开启 `autoDream`，mission 结束后会尝试 `maybeAutoDream`
- `/dream now` 可以强制触发一次 dream
- `Background` 面板会显示后台 dream 任务

## 11. 数据落盘位置

- 本地应用状态：`./.actoviq-claw/state.json`
- 本地 session：`./.actoviq-claw/sessions/`
- 本地 runtime 配置：`./actoviq-claw.runtime.settings.local.json`
- app 配置：`./actoviq-claw.config.json`

Actoviq 的 durable memory 仍然由 SDK 自己管理，通常会写到 `~/.actoviq/` 下对应的 project memory 目录。

## 12. 推荐使用方式

比较适合的用法是：

1. 让它盯一个工作区持续工作
2. 把你想做的事情一句一句投入 mission 队列
3. 通过 heartbeat 让它空闲时主动巡检
4. 利用 session memory 和记忆系统让它逐步“熟悉”项目

## 13. 验证命令

开发阶段常用：

```bash
npm run typecheck
npm test
```
