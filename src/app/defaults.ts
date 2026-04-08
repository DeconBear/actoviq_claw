import path from 'node:path';

import {
  createActoviqFileTools,
  type AgentMcpServerDefinition,
  type ActoviqAgentDefinition,
  type AgentToolDefinition,
  type CreateActoviqComputerUseOptions,
} from 'actoviq-agent-sdk';

import { defaultAllowedTools } from './permissions.js';
import type { AssistantAppConfig } from './types.js';

export const DEFAULT_HEARTBEAT_PROMPT =
  'Read HEARTBEAT.md if it exists in the current workspace by using the available file tools. Follow it strictly. Do not revive stale work. If nothing needs attention, reply HEARTBEAT_OK.';

export const DEFAULT_HEARTBEAT_TEMPLATE = `# Heartbeat Checklist

- Review queued or blocked missions.
- Check whether any background tasks or delegated subagents finished.
- Inspect recent memory or session summaries if they would help the next autonomous step.
- If nothing needs attention right now, reply with HEARTBEAT_OK.
`;

export const DEFAULT_SYSTEM_PROMPT = `You are Actoviq Claw, a fully autonomous terminal AI assistant running in unattended mode.

Finish the user's task end to end whenever it is feasible. Prefer doing the work over proposing.
Use tools aggressively but responsibly. Keep progress visible in short status updates when you are mid-task.
You can inspect and modify the workspace directly with file tools such as Read, Glob, Grep, Edit, and Write.
If computer-use tools are available, you may drive the local desktop with tools like open_url, focus_window, type_text, keypress, clipboard access, screenshots, and wait.
When a subproblem is focused and benefits from specialization, delegate with the Task tool to one of the named agents: planner, researcher, implementer, reviewer.
Treat durable memory as future-facing context. Preserve stable facts and collaboration preferences. Use session memory to stay oriented during long tasks.
Heartbeat turns are operational check-ins. Follow HEARTBEAT.md if it exists. If nothing needs attention, respond with HEARTBEAT_OK.
If a buddy companion appears in context, do not impersonate it; simply coexist with it as a separate companion voice.`;

export function buildDefaultTools(workspacePath: string): AgentToolDefinition[] {
  return createActoviqFileTools({
    cwd: workspacePath,
  });
}

export function buildDefaultComputerUseOptions(
  config: AssistantAppConfig,
): false | CreateActoviqComputerUseOptions {
  if (!config.tooling.enableComputerUse) {
    return false;
  }

  const prefix = config.tooling.computerUsePrefix?.trim();
  return prefix ? { prefix } : {};
}

export function buildDefaultMcpServers(config: AssistantAppConfig): AgentMcpServerDefinition[] {
  return config.tooling.mcpServers.map(server => ({ ...server }));
}

export function buildDefaultConfig(rootDir: string): AssistantAppConfig {
  return {
    workspacePath: rootDir,
    runtimeConfigPath: path.join(rootDir, 'actoviq-claw.runtime.settings.local.json'),
    stateDir: path.join(rootDir, '.actoviq-claw'),
    historyDir: path.join(rootDir, '.actoviq-claw', 'history'),
    tooling: {
      enableComputerUse: true,
      computerUsePrefix: 'computer',
      mcpServers: [],
    },
    heartbeat: {
      enabled: true,
      guideFilePath: path.join(rootDir, 'HEARTBEAT.md'),
      intervalMinutes: 20,
      ackMaxChars: 240,
      useIsolatedSession: false,
      prompt: DEFAULT_HEARTBEAT_PROMPT,
      activeHours: {
        start: '08:00',
        end: '23:30',
      },
    },
    autonomy: {
      autoRun: true,
      autoExtractMemory: true,
      autoDream: true,
      permissionMode: 'bypassPermissions',
      permissionPreset: 'full-access',
      allowedTools: defaultAllowedTools(),
    },
    buddy: {
      autoHatch: true,
      muted: false,
      name: 'Mochi',
      personality: 'quietly observant, warm, and encouraging',
    },
  };
}

export function buildNamedAgents(): ActoviqAgentDefinition[] {
  return [
    {
      name: 'planner',
      description: 'Clarify goals, constraints, and the next concrete execution plan.',
      systemPrompt:
        'You are a crisp planning agent. Turn messy requests into concrete execution steps, risks, and finish criteria.',
    },
    {
      name: 'researcher',
      description: 'Inspect code, docs, and context before implementation.',
      systemPrompt:
        'You are a repository and documentation researcher. Gather the most decision-relevant facts first.',
    },
    {
      name: 'implementer',
      description: 'Execute implementation work with tools and deliver usable results.',
      systemPrompt:
        'You are an implementation specialist. Prefer concrete changes, verification, and concise status notes.',
    },
    {
      name: 'reviewer',
      description: 'Review work for bugs, regressions, missing tests, and hidden risk.',
      systemPrompt:
        'You are a strict reviewer. Findings first, highest severity first, then brief residual risk.',
    },
  ];
}
