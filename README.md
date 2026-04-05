# Actoviq Claw

一个基于本地 `actoviq-agent-sdk` 搭建的全自动 TUI AI 助理。它面向无人值守场景，内置任务队列、心跳模式、buddy、记忆系统、dream 和记忆巩固、后台任务监控，以及面向长任务的全屏终端界面。

核心特性：

- 全屏 TUI：任务、日志、buddy、memory、dream、后台任务同屏展示
- 自治执行：普通输入直接入队，助手自动串行执行
- 心跳模式：定时巡检 `HEARTBEAT.md`，支持 `HEARTBEAT_OK` 抑制无效提醒
- Buddy：自动孵化、可抚摸、可静音
- Memory：任务结束后自动抽取 session memory，并可查询相关记忆
- Dream：支持手动 dream 与任务后的自动 dream
- Delegation-ready：注册了 `planner / researcher / implementer / reviewer` 命名 agent，可通过 SDK 的 `Task` 工具进行子任务分派

快速开始见 [USAGE-zh.md](./USAGE-zh.md)。
