import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadOrCreateAppConfig, loadOrCreateState, saveAppConfig } from '../src/app/persistence.js';

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

    await saveAppConfig(rootDir, initial);

    const reloaded = await loadOrCreateAppConfig(rootDir);
    expect(reloaded.heartbeat.guideFilePath).toBe(path.join(rootDir, 'ops', 'heartbeat-guide.md'));
    expect(reloaded.heartbeat.intervalMinutes).toBe(45);
    expect(reloaded.heartbeat.activeHours).toEqual({
      start: '09:15',
      end: '21:30',
      timezone: 'Asia/Shanghai',
    });
  });
});
