import blessed from 'blessed';

import type { ControllerSnapshot } from './types.js';
import type { AutonomousAssistantController } from './controller.js';

function formatMissionLines(snapshot: ControllerSnapshot): string {
  if (snapshot.missions.length === 0) {
    return 'No missions yet.\n\nType plain text below to enqueue a new unattended task.';
  }

  return snapshot.missions
    .slice(0, 14)
    .map(mission => {
      const marker =
        snapshot.activeMissionId === mission.id
          ? '>'
          : mission.status === 'completed'
            ? '+'
            : mission.status === 'failed'
              ? '!'
              : mission.status === 'cancelled'
                ? 'x'
                : '-';
      return `${marker} ${mission.id}\n${mission.status} | tools=${mission.toolCalls}\n${mission.title}`;
    })
    .join('\n\n');
}

function formatBuddy(snapshot: ControllerSnapshot): string {
  if (!snapshot.buddy?.buddy) {
    return 'No buddy hatched yet.\nUse /buddy hatch <name> [personality]';
  }

  const buddy = snapshot.buddy.buddy;
  return [
    `${buddy.name} the ${buddy.species}`,
    `rarity: ${buddy.rarity}${buddy.shiny ? ' | shiny' : ''}`,
    `eyes: ${buddy.eye} | hat: ${buddy.hat}`,
    `muted: ${snapshot.buddy.muted ? 'yes' : 'no'}`,
    '',
    `DEBUGGING ${buddy.stats.DEBUGGING}`,
    `PATIENCE  ${buddy.stats.PATIENCE}`,
    `CHAOS     ${buddy.stats.CHAOS}`,
    `WISDOM    ${buddy.stats.WISDOM}`,
    `SNARK     ${buddy.stats.SNARK}`,
  ].join('\n');
}

function formatMemory(snapshot: ControllerSnapshot): string {
  const relevant =
    snapshot.memory.relevantMemories.length === 0
      ? 'No recent relevant memories.'
      : snapshot.memory.relevantMemories
          .slice(0, 5)
          .map(memory => `${memory.scope}: ${memory.filename}`)
          .join('\n');

  return [
    `Dream ready: ${snapshot.dream?.canRun ? 'yes' : 'no'}`,
    `Dream reason: ${snapshot.dream?.blockedReason ?? 'ready'}`,
    '',
    'Relevant memories:',
    relevant,
    '',
    'Session memory:',
    snapshot.memory.sessionMemoryPreview || 'No extracted session memory yet.',
  ].join('\n');
}

function formatBackground(snapshot: ControllerSnapshot): string {
  if (snapshot.backgroundTasks.length === 0) {
    return 'No background tasks.';
  }

  return snapshot.backgroundTasks
    .slice(0, 10)
    .map(task => `${task.status} ${task.subagentType}\n${task.description}`)
    .join('\n\n');
}

function formatLogs(snapshot: ControllerSnapshot): string {
  const rows = snapshot.logs
    .slice(-60)
    .map(entry => `[${entry.scope}] ${entry.text}`);
  if (snapshot.liveOutput) {
    rows.push('');
    rows.push('[assistant-stream]');
    rows.push(snapshot.liveOutput);
  }
  return rows.join('\n');
}

function formatHeader(snapshot: ControllerSnapshot): string {
  const heartbeat = snapshot.heartbeats.nextTickAt
    ? new Date(snapshot.heartbeats.nextTickAt).toLocaleTimeString()
    : 'n/a';
  return [
    `Actoviq Claw | workspace: ${snapshot.workspacePath}`,
    `model: ${snapshot.detectedModel ?? 'unknown'} | runtime: ${snapshot.runtimeConfigSource} | paused: ${
      snapshot.paused ? 'yes' : 'no'
    } | busy: ${snapshot.busy ? 'yes' : 'no'} | heartbeat: ${heartbeat}`,
  ].join('\n');
}

function formatFooter(): string {
  return 'Enter plain text to queue a mission. Ctrl+Q quit | Ctrl+H heartbeat | Ctrl+D dream | Ctrl+P pet buddy | Ctrl+Space pause/resume';
}

export class ActoviqClawTui {
  private readonly screen = blessed.screen({
    smartCSR: true,
    title: 'Actoviq Claw',
    fullUnicode: true,
  });
  private readonly header = blessed.box({
    parent: this.screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    border: 'line',
    label: ' Status ',
  });
  private readonly queue = blessed.box({
    parent: this.screen,
    top: 3,
    left: 0,
    width: '30%',
    height: '52%-1',
    border: 'line',
    label: ' Missions ',
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    mouse: true,
  });
  private readonly buddy = blessed.box({
    parent: this.screen,
    top: '52%+2',
    left: 0,
    width: '30%',
    height: '28%',
    border: 'line',
    label: ' Buddy ',
    scrollable: true,
  });
  private readonly memory = blessed.box({
    parent: this.screen,
    top: 3,
    left: '30%',
    width: '35%',
    height: '77%-1',
    border: 'line',
    label: ' Memory & Dream ',
    scrollable: true,
    alwaysScroll: true,
  });
  private readonly background = blessed.box({
    parent: this.screen,
    top: 3,
    left: '65%',
    width: '35%',
    height: '35%',
    border: 'line',
    label: ' Background ',
    scrollable: true,
  });
  private readonly consoleBox = blessed.box({
    parent: this.screen,
    top: '38%',
    left: '65%',
    width: '35%',
    height: '42%',
    border: 'line',
    label: ' Console ',
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    mouse: true,
  });
  private readonly input = blessed.textbox({
    parent: this.screen,
    bottom: 1,
    left: 0,
    width: '100%',
    height: 3,
    border: 'line',
    label: ' Command / Mission ',
    inputOnFocus: true,
  });
  private readonly footer = blessed.box({
    parent: this.screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
  });

  constructor(private readonly controller: AutonomousAssistantController) {}

  mount(): void {
    this.controller.on('updated', (snapshot: ControllerSnapshot) => {
      this.render(snapshot);
    });

    this.input.on('submit', value => {
      const payload = value.trim();
      this.input.clearValue();
      this.screen.render();
      if (!payload) {
        this.input.focus();
        return;
      }
      void this.controller.handleInput(payload).finally(() => {
        this.input.focus();
      });
    });

    this.screen.key(['C-q'], () => {
      void this.controller.dispose().finally(() => {
        this.screen.destroy();
      });
    });
    this.screen.key(['C-c'], () => {
      void this.controller.dispose().finally(() => {
        this.screen.destroy();
      });
    });
    this.screen.key(['C-h'], () => {
      void this.controller.handleInput('/heartbeat tick');
    });
    this.screen.key(['C-d'], () => {
      void this.controller.handleInput('/dream now');
    });
    this.screen.key(['C-p'], () => {
      void this.controller.handleInput('/buddy pet');
    });
    this.screen.key(['C-space'], () => {
      const snapshot = this.controller.snapshot();
      void this.controller.handleInput(snapshot.paused ? '/resume' : '/pause');
    });

    this.input.focus();
    this.render(this.controller.snapshot());
  }

  private render(snapshot: ControllerSnapshot): void {
    this.header.setContent(formatHeader(snapshot));
    this.queue.setContent(formatMissionLines(snapshot));
    this.buddy.setContent(formatBuddy(snapshot));
    this.memory.setContent(formatMemory(snapshot));
    this.background.setContent(formatBackground(snapshot));
    this.consoleBox.setContent(formatLogs(snapshot));
    this.footer.setContent(formatFooter());
    this.consoleBox.setScrollPerc(100);
    this.screen.render();
  }
}
