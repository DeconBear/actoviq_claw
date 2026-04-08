import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  loadArchivedChats,
  loadOrCreateAppConfig,
  loadOrCreateState,
  saveAppConfig,
  saveArchivedChats,
} from '../src/app/persistence.js';
import type { AssistantArchivedChat } from '../src/app/types.js';

describe('loadOrCreateState', () => {
  it('migrates a version 1 state into the current chat-aware format', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-claw-state-'));
    const legacyState = {
      version: 1,
      paused: true,
      missions: [
        {
          id: 'mission_legacy',
          title: 'Legacy mission',
          prompt: 'Summarize the release notes',
          status: 'completed',
          createdAt: '2026-04-01T10:00:00.000Z',
          updatedAt: '2026-04-01T10:03:00.000Z',
          completedAt: '2026-04-01T10:03:00.000Z',
          toolCalls: 1,
          delegatedAgents: [],
        },
      ],
      logs: [
        {
          id: 'log_legacy',
          at: '2026-04-01T10:03:00.000Z',
          level: 'info',
          scope: 'system',
          text: 'Legacy state restored.',
        },
      ],
      heartbeats: {
        skippedCount: 2,
      },
    };

    await writeFile(path.join(stateDir, 'state.json'), JSON.stringify(legacyState, null, 2), 'utf8');

    const state = await loadOrCreateState(stateDir);

    expect(state.version).toBe(2);
    expect(state.currentChatId).toMatch(/^chat_/);
    expect(state.currentChatCreatedAt).toBe('2026-04-01T10:00:00.000Z');
    expect(state.currentChatTitle).toContain('Chat');
    expect(state.chats).toEqual([]);
    expect(state.missions).toHaveLength(1);
    expect(state.logs).toHaveLength(1);
    expect(state.heartbeats.skippedCount).toBe(2);

    const saved = JSON.parse(await readFile(path.join(stateDir, 'state.json'), 'utf8')) as {
      version: number;
    };
    expect(saved.version).toBe(2);
  });
});

describe('app config persistence', () => {
  it('persists heartbeat guide path and schedule settings', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-claw-config-'));

    const initial = await loadOrCreateAppConfig(rootDir);
    initial.heartbeat.guideFilePath = path.join(rootDir, 'ops', 'heartbeat-guide.md');
    initial.heartbeat.intervalMinutes = 45;
    initial.heartbeat.activeHours = {
      start: '09:15',
      end: '21:30',
      timezone: 'Asia/Shanghai',
    };
    initial.tooling.enableComputerUse = true;
    initial.tooling.computerUsePrefix = 'desktop';
    initial.tooling.mcpServers = [
      {
        kind: 'stdio',
        name: 'demo-mcp',
        command: 'npx',
        args: ['-y', 'demo-mcp'],
        cwd: path.join(rootDir, 'tools'),
        prefix: 'demo',
      },
    ];
    initial.autonomy.permissionPreset = 'workspace-only';
    initial.autonomy.allowedTools = ['Read', 'Glob'];
    initial.historyDir = path.join(rootDir, 'custom-history');

    await saveAppConfig(rootDir, initial);

    const reloaded = await loadOrCreateAppConfig(rootDir);
    expect(reloaded.heartbeat.guideFilePath).toBe(path.join(rootDir, 'ops', 'heartbeat-guide.md'));
    expect(reloaded.heartbeat.intervalMinutes).toBe(45);
    expect(reloaded.heartbeat.activeHours).toEqual({
      start: '09:15',
      end: '21:30',
      timezone: 'Asia/Shanghai',
    });
    expect(reloaded.tooling.enableComputerUse).toBe(true);
    expect(reloaded.tooling.computerUsePrefix).toBe('desktop');
    expect(reloaded.tooling.mcpServers).toEqual([
      {
        kind: 'stdio',
        name: 'demo-mcp',
        command: 'npx',
        args: ['-y', 'demo-mcp'],
        cwd: path.join(rootDir, 'tools'),
        prefix: 'demo',
        env: undefined,
        stderr: undefined,
      },
    ]);
    expect(reloaded.autonomy.permissionPreset).toBe('workspace-only');
    expect(reloaded.autonomy.allowedTools).toEqual(['Read', 'Glob']);
    expect(reloaded.historyDir).toBe(path.join(rootDir, 'custom-history'));
  });
});

describe('archived chat persistence', () => {
  it('stores each archived chat as a separate json file and reloads them by id', async () => {
    const historyDir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-claw-history-'));
    const chats: AssistantArchivedChat[] = [
      {
        id: 'chat_mno123_abcd01',
        title: 'Chat 1',
        workspacePath: 'E:/workspace/one',
        createdAt: '2026-04-08T10:00:00.000Z',
        archivedAt: '2026-04-08T10:10:00.000Z',
        updatedAt: '2026-04-08T10:10:00.000Z',
        missions: [],
        logs: [],
      },
      {
        id: 'chat_mno124_abcd02',
        title: 'Chat 2',
        workspacePath: 'E:/workspace/two',
        createdAt: '2026-04-08T11:00:00.000Z',
        archivedAt: '2026-04-08T11:10:00.000Z',
        updatedAt: '2026-04-08T11:10:00.000Z',
        missions: [],
        logs: [],
      },
    ];

    await saveArchivedChats(historyDir, chats);

    const firstFile = JSON.parse(
      await readFile(path.join(historyDir, 'chat_mno123_abcd01.json'), 'utf8'),
    ) as { id: string };
    expect(firstFile.id).toBe('chat_mno123_abcd01');

    const reloaded = await loadArchivedChats(historyDir);
    expect(reloaded.map(chat => chat.id)).toEqual(['chat_mno124_abcd02', 'chat_mno123_abcd01']);
  });
});
