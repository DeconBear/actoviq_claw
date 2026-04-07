import process from 'node:process';
import { EventEmitter } from 'node:events';

import chalk from 'chalk';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

import { Cursor } from './claudecode/Cursor.js';
import type { AssistantLogEntry, AssistantMission, ControllerSnapshot } from './types.js';
import type { AutonomousAssistantController } from './controller.js';

type OverlayPanel = 'help' | 'status' | 'tasks' | 'memory' | 'dream' | 'buddy';
type TimelineTone = 'normal' | 'success' | 'warning' | 'error' | 'muted';
type PanelTone = 'normal' | 'accent' | 'success' | 'warning' | 'error' | 'muted';

interface SlashCommandTemplate {
  value: string;
  description: string;
  tag: 'panel' | 'action';
}

interface TimelineItem {
  id: string;
  at: string;
  role: 'user' | 'assistant';
  text: string;
  tone: TimelineTone;
}

interface DisplayLine {
  key: string;
  text: string;
  color?: string;
  backgroundColor?: string;
  dimColor?: boolean;
  bold?: boolean;
}

interface PanelLine {
  key: string;
  text: string;
  tone?: PanelTone;
  bold?: boolean;
}

interface FooterPill {
  id: string;
  label: string;
  backgroundColor?: string;
  color?: string;
  active?: boolean;
}

const PANEL_ORDER: OverlayPanel[] = ['help', 'status', 'tasks', 'memory', 'dream', 'buddy'];

const SLASH_COMMANDS: SlashCommandTemplate[] = [
  { value: '/help', description: 'open the help panel', tag: 'panel' },
  { value: '/status', description: 'open runtime status', tag: 'panel' },
  { value: '/tasks', description: 'open missions and background tasks', tag: 'panel' },
  { value: '/memory', description: 'open memory summary', tag: 'panel' },
  { value: '/dream', description: 'open dream state', tag: 'panel' },
  { value: '/buddy', description: 'open buddy state', tag: 'panel' },
  { value: '/close', description: 'close the open panel', tag: 'panel' },
  { value: '/pause', description: 'pause the autonomous queue', tag: 'action' },
  { value: '/resume', description: 'resume the autonomous queue', tag: 'action' },
  { value: '/heartbeat tick', description: 'run one heartbeat now', tag: 'action' },
  { value: '/heartbeat on', description: 'enable heartbeat mode', tag: 'action' },
  { value: '/heartbeat off', description: 'disable heartbeat mode', tag: 'action' },
  { value: '/heartbeat every 20', description: 'set heartbeat interval in minutes', tag: 'action' },
  { value: '/dream now', description: 'launch a dream run', tag: 'action' },
  { value: '/buddy pet', description: 'pet the buddy', tag: 'action' },
  { value: '/buddy mute', description: 'mute the buddy', tag: 'action' },
  { value: '/buddy unmute', description: 'unmute the buddy', tag: 'action' },
  { value: '/buddy hatch Mochi calm and observant', description: 'hatch a new buddy', tag: 'action' },
  { value: '/memory find release flow', description: 'search relevant memories', tag: 'action' },
  { value: '/cancel mission_id', description: 'cancel a queued or running mission', tag: 'action' },
  { value: '/sessions', description: 'list recent SDK sessions', tag: 'action' },
];

const MAX_INPUT_VISIBLE_LINES = 6;

function compactText(value: string | undefined, maxLength: number): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function clampCursorOffset(value: string, cursorOffset: number): number {
  return Math.max(0, Math.min(value.length, cursorOffset));
}

function createInputCursor(value: string, cursorOffset: number, columns: number): Cursor {
  return Cursor.fromText(value, Math.max(8, columns), clampCursorOffset(value, cursorOffset));
}

function renderPromptLines(props: {
  value: string;
  cursorOffset: number;
  columns: number;
  placeholder: string;
  inlineGhostText?: string;
}): string[] {
  if (!props.value) {
    if (!props.placeholder) {
      return [chalk.inverse(' ')];
    }

    const first = props.placeholder[0] ?? ' ';
    return [`${chalk.inverse(first)}${chalk.dim(props.placeholder.slice(1))}`];
  }

  const rendered = createInputCursor(props.value, props.cursorOffset, props.columns).render(
    ' ',
    '',
    chalk.inverse,
    props.inlineGhostText ? { text: props.inlineGhostText, dim: chalk.dim } : undefined,
    MAX_INPUT_VISIBLE_LINES,
  );

  return rendered.split('\n');
}

function formatClock(value: string | undefined): string {
  if (!value) {
    return 'n/a';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'n/a';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function relativeTimeLabel(value: string | undefined): string {
  if (!value) {
    return 'n/a';
  }

  const target = new Date(value).getTime();
  if (Number.isNaN(target)) {
    return 'n/a';
  }

  const diffMs = target - Date.now();
  const absMs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (absMs < minute) {
    return diffMs >= 0 ? 'soon' : 'just now';
  }
  if (absMs < hour) {
    const minutes = Math.round(absMs / minute);
    return diffMs >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  }
  if (absMs < day) {
    const hours = Math.round(absMs / hour);
    return diffMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
  }

  const days = Math.round(absMs / day);
  return diffMs >= 0 ? `in ${days}d` : `${days}d ago`;
}

function compactPath(value: string): string {
  const parts = value.split(/[\\/]+/u).filter(Boolean);
  if (parts.length === 0) {
    return compactText(value, 64);
  }
  if (parts.length === 1) {
    return parts[0]!;
  }
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function simplifyLogText(text: string): string {
  return text.replace(/[A-Za-z]:\\[^\s]+/gu, value => compactPath(value));
}

function timelineToneForLog(entry: AssistantLogEntry): TimelineTone {
  switch (entry.level) {
    case 'error':
      return 'error';
    case 'warn':
      return 'warning';
    case 'success':
      return 'success';
    default:
      return 'muted';
  }
}

function toneColor(tone: TimelineTone | PanelTone | undefined): string | undefined {
  switch (tone) {
    case 'accent':
      return 'cyan';
    case 'success':
      return 'green';
    case 'warning':
      return 'yellow';
    case 'error':
      return 'red';
    default:
      return undefined;
  }
}

function missionReply(mission: AssistantMission): TimelineItem | undefined {
  const at = mission.completedAt ?? mission.updatedAt;

  if (mission.status === 'completed') {
    if (mission.resultText?.trim()) {
      return {
        id: `${mission.id}:assistant`,
        at,
        role: 'assistant',
        text: mission.resultText,
        tone: 'normal',
      };
    }
    return undefined;
  }

  if (mission.status === 'failed') {
    return {
      id: `${mission.id}:failed`,
      at,
      role: 'assistant',
      text: `Mission failed: ${mission.error ?? 'unknown error'}`,
      tone: 'error',
    };
  }

  if (mission.status === 'cancelled') {
    return {
      id: `${mission.id}:cancelled`,
      at,
      role: 'assistant',
      text: 'Mission cancelled.',
      tone: 'warning',
    };
  }

  return undefined;
}

function logToTimelineItem(entry: AssistantLogEntry): TimelineItem | undefined {
  const text = (entry.text ?? '').trim();
  if (!text) {
    return undefined;
  }

  if (text.startsWith('Actoviq Claw is ready.')) {
    return undefined;
  }
  if (/^Queued mission [^:]+:/u.test(text)) {
    return undefined;
  }
  if (/^Running mission [^:]+:/u.test(text)) {
    return undefined;
  }
  if (/^Mission [^ ]+ completed with \d+ tool calls\.$/u.test(text)) {
    return undefined;
  }
  if (/^Mission [^ ]+ failed:/u.test(text)) {
    return undefined;
  }
  if (/^Cancelled queued mission /u.test(text)) {
    return undefined;
  }
  if (/^Abort requested for mission /u.test(text)) {
    return undefined;
  }
  if (/^Session memory (updated|checked):/u.test(text)) {
    return undefined;
  }
  if (/^Session compacted /u.test(text)) {
    return undefined;
  }
  if (text === 'Heartbeat acknowledged with HEARTBEAT_OK.') {
    return undefined;
  }
  if (text.startsWith('Dream skipped:')) {
    return undefined;
  }
  if (text.startsWith('Dream launched in background:')) {
    return undefined;
  }
  if (text.startsWith('Dream finished:')) {
    return undefined;
  }
  if (text.startsWith('Tool call:')) {
    return undefined;
  }
  if (text.startsWith('Tool result:')) {
    return undefined;
  }
  if (text.startsWith('Permission ')) {
    return undefined;
  }
  if (entry.scope === 'background') {
    return undefined;
  }

  return {
    id: entry.id,
    at: entry.at,
    role: 'assistant',
    text: simplifyLogText(text),
    tone: timelineToneForLog(entry),
  };
}

function buildTimeline(snapshot: ControllerSnapshot): TimelineItem[] {
  const items: TimelineItem[] = [];
  const missions = [...snapshot.missions].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const mission of missions) {
    items.push({
      id: `${mission.id}:user`,
      at: mission.createdAt,
      role: 'user',
      text: mission.prompt,
      tone: 'normal',
    });

    const reply = missionReply(mission);
    if (reply) {
      items.push(reply);
    }
  }

  for (const entry of snapshot.logs) {
    const item = logToTimelineItem(entry);
    if (item) {
      items.push(item);
    }
  }

  const active = snapshot.missions.find(mission => mission.id === snapshot.activeMissionId);
  if (active && snapshot.liveOutput.trim()) {
    items.push({
      id: `${active.id}:live`,
      at: active.updatedAt,
      role: 'assistant',
      text: snapshot.liveOutput,
      tone: 'normal',
    });
  }

  return items.sort((left, right) => {
    if (left.at === right.at) {
      return left.id.localeCompare(right.id);
    }
    return left.at.localeCompare(right.at);
  });
}

function wrapLines(text: string, width: number): string[] {
  const paragraphs = text.replace(/\r/g, '').split(/\n/u);
  const lines: string[] = [];
  const safeWidth = Math.max(8, width);

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('');
      continue;
    }

    const wrapped = wrapAnsi(paragraph, safeWidth, {
      hard: true,
      trim: false,
      wordWrap: true,
    }).split('\n');

    lines.push(...wrapped);
  }

  return lines.length > 0 ? lines : [''];
}

function timelineToLines(snapshot: ControllerSnapshot, width: number): DisplayLine[] {
  const timeline = buildTimeline(snapshot);
  const lines: DisplayLine[] = [];

  if (timeline.length === 0) {
    return [
      { key: 'welcome:0', text: 'Ready.', color: 'white', bold: true },
      { key: 'welcome:1', text: 'Type a task and press Enter.', dimColor: true },
      { key: 'welcome:2', text: 'Use / to open commands, status, memory, dream, buddy, and tasks.', dimColor: true },
    ];
  }

  for (const item of timeline) {
    if (lines.length > 0) {
      lines.push({ key: `${item.id}:gap`, text: '' });
    }

    const prefix = item.role === 'user' ? '> ' : '⎿ ';
    const continuation = '  ';
    const wrapped = wrapLines(item.text, Math.max(12, width - stringWidth(prefix)));
    const color = item.role === 'user' ? 'cyan' : toneColor(item.tone) ?? 'white';

    wrapped.forEach((line, index) => {
      lines.push({
        key: `${item.id}:body:${index}`,
        text: `${index === 0 ? prefix : continuation}${line}`,
        color,
        dimColor: item.role === 'assistant' && item.tone === 'muted',
      });
    });
  }

  return lines;
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function localPanelCommand(value: string): OverlayPanel | 'close' | undefined {
  switch (normalizeCommand(value)) {
    case '/help':
      return 'help';
    case '/status':
      return 'status';
    case '/tasks':
      return 'tasks';
    case '/memory':
    case '/memory state':
      return 'memory';
    case '/dream':
    case '/dream state':
      return 'dream';
    case '/buddy':
      return 'buddy';
    case '/close':
      return 'close';
    default:
      return undefined;
  }
}

function followupPanel(value: string): OverlayPanel | undefined {
  const normalized = normalizeCommand(value);

  if (normalized === '/pause' || normalized === '/resume') {
    return 'status';
  }
  if (normalized.startsWith('/heartbeat ')) {
    return 'status';
  }
  if (normalized.startsWith('/buddy ')) {
    return 'buddy';
  }
  if (normalized.startsWith('/dream ')) {
    return 'dream';
  }
  if (normalized.startsWith('/memory ')) {
    return 'memory';
  }
  if (normalized.startsWith('/cancel ')) {
    return 'tasks';
  }

  return undefined;
}

function filterSlashCommands(query: string): SlashCommandTemplate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized.startsWith('/')) {
    return [];
  }

  return SLASH_COMMANDS.filter(command => {
    const value = command.value.toLowerCase();
    return value.startsWith(normalized) || value.includes(normalized);
  }).slice(0, 8);
}

function panelLabel(panel: OverlayPanel): string {
  return panel;
}

function cyclePanel(panel: OverlayPanel, direction: -1 | 1): OverlayPanel {
  const index = PANEL_ORDER.indexOf(panel);
  const nextIndex = (index + direction + PANEL_ORDER.length) % PANEL_ORDER.length;
  return PANEL_ORDER[nextIndex]!;
}

function formatMissionCount(snapshot: ControllerSnapshot, status: AssistantMission['status']): number {
  return snapshot.missions.filter(mission => mission.status === status).length;
}

function activeMission(snapshot: ControllerSnapshot): AssistantMission | undefined {
  return snapshot.missions.find(mission => mission.id === snapshot.activeMissionId);
}

function buildFooterPills(
  snapshot: ControllerSnapshot,
  activePanel: OverlayPanel | 'none',
): FooterPill[] {
  const queued = formatMissionCount(snapshot, 'queued');
  const running = formatMissionCount(snapshot, 'running');
  const backgroundRunning = snapshot.backgroundTasks.filter(task => task.status === 'running').length;
  const hbLabel = snapshot.heartbeatEnabled
    ? `hb ${relativeTimeLabel(snapshot.heartbeats.nextTickAt)}`
    : 'hb off';
  const dreamLabel = snapshot.dream?.enabled
    ? snapshot.dream.canRun
      ? 'dream ready'
      : `dream ${snapshot.dream.blockedReason ?? 'waiting'}`
    : 'dream off';
  const buddyLabel = snapshot.buddy?.buddy
    ? `buddy ${snapshot.buddy.buddy.name.toLowerCase()}`
    : 'buddy none';
  const memoryLabel = `memory ${snapshot.memory.relevantMemories.length}`;
  const taskLabel = `tasks ${queued + running + backgroundRunning}`;

  const pills: FooterPill[] = [];

  if (activePanel !== 'none') {
    pills.push({
      id: 'panel',
      label: panelLabel(activePanel),
      backgroundColor: 'cyan',
      color: 'black',
      active: true,
    });
  }

  pills.push({
    id: 'state',
    label: snapshot.paused ? 'paused' : snapshot.autoRunEnabled ? 'auto' : 'manual',
    backgroundColor: snapshot.paused ? 'yellow' : 'green',
    color: 'black',
  });
  pills.push({
    id: 'heartbeat',
    label: hbLabel,
    backgroundColor: snapshot.heartbeatEnabled ? 'blue' : 'gray',
    color: 'black',
  });
  pills.push({
    id: 'dream',
    label: dreamLabel,
    backgroundColor: snapshot.dream?.canRun ? 'green' : 'gray',
    color: 'black',
  });
  pills.push({
    id: 'buddy',
    label: buddyLabel,
    backgroundColor: snapshot.buddy?.muted ? 'gray' : 'blue',
    color: 'black',
  });
  pills.push({
    id: 'tasks',
    label: taskLabel,
    backgroundColor: queued + running + backgroundRunning > 0 ? 'yellow' : 'gray',
    color: 'black',
  });
  pills.push({
    id: 'model',
    label: snapshot.detectedModel ?? 'model unknown',
    backgroundColor: 'gray',
    color: 'black',
  });
  pills.push({
    id: 'memory',
    label: memoryLabel,
    backgroundColor: snapshot.memory.relevantMemories.length > 0 ? 'cyan' : 'gray',
    color: 'black',
  });

  return pills;
}

function pickFooterPills(pills: FooterPill[], width: number): FooterPill[] {
  const selected: FooterPill[] = [];
  let used = 0;

  for (const pill of pills) {
    const pillWidth = stringWidth(pill.label) + 2 + (selected.length > 0 ? 1 : 0);
    if (used + pillWidth > width) {
      break;
    }
    selected.push(pill);
    used += pillWidth;
  }

  const hiddenCount = pills.length - selected.length;
  if (hiddenCount <= 0) {
    return selected;
  }

  const morePill: FooterPill = {
    id: 'more',
    label: `+${hiddenCount}`,
    backgroundColor: 'gray',
    color: 'black',
  };
  const moreWidth = stringWidth(morePill.label) + 2 + (selected.length > 0 ? 1 : 0);

  if (used + moreWidth <= width) {
    return [...selected, morePill];
  }

  if (selected.length === 0) {
    return [morePill];
  }

  const shortened = [...selected];
  shortened.pop();
  return pickFooterPills([...shortened, morePill], width);
}

function footerHint(
  snapshot: ControllerSnapshot,
  activePanel: OverlayPanel | 'none',
  commandPaletteVisible: boolean,
  scrollOffsetLines: number,
  active: AssistantMission | undefined,
  escapePending: boolean,
): string {
  if (escapePending) {
    return 'Esc again to clear';
  }
  if (commandPaletteVisible) {
    return '/ commands  Enter run  Tab complete  Esc close';
  }
  if (activePanel !== 'none') {
    return `${panelLabel(activePanel)} open  Left/Right switch  Esc close  / commands`;
  }
  if (scrollOffsetLines > 0) {
    return 'Viewing earlier messages  PgDn toward newest  / commands';
  }
  if (active) {
    return `Running ${compactText(active.title, 56)}  Esc interrupt`;
  }
  if (snapshot.paused) {
    return 'Queue paused  /resume to continue  / commands';
  }
  return '? help  / commands  Up/Down history  PgUp/PgDn scroll';
}

function pushSection(lines: PanelLine[], key: string, title: string, body: string[]): void {
  lines.push({ key: `${key}:title`, text: title, tone: 'accent', bold: true });
  body.forEach((text, index) => {
    lines.push({ key: `${key}:${index}`, text, tone: 'normal' });
  });
  lines.push({ key: `${key}:gap`, text: '', tone: 'muted' });
}

function buildPanelLines(panel: OverlayPanel, snapshot: ControllerSnapshot): PanelLine[] {
  const lines: PanelLine[] = [];
  const queued = formatMissionCount(snapshot, 'queued');
  const running = formatMissionCount(snapshot, 'running');
  const completed = formatMissionCount(snapshot, 'completed');
  const failed = formatMissionCount(snapshot, 'failed');
  const active = activeMission(snapshot);

  switch (panel) {
    case 'help':
      pushSection(lines, 'help:ask', 'Ask', [
        'Type plain text and press Enter to queue a task.',
        'Only user prompts and assistant answers appear in the main transcript.',
      ]);
      pushSection(lines, 'help:panels', 'Panels', [
        '/help  /status  /tasks  /memory  /dream  /buddy',
        '/close closes the current panel.',
      ]);
      pushSection(lines, 'help:actions', 'Actions', [
        '/pause  /resume  /heartbeat tick  /heartbeat on  /heartbeat off',
        '/buddy pet  /buddy mute  /buddy unmute  /dream now',
        '/memory find <query>  /cancel <mission-id>  /sessions',
      ]);
      pushSection(lines, 'help:keys', 'Keys', [
        'Esc close panel  Left/Right switch panels',
        'PageUp/PageDown scroll transcript',
        'Ctrl+C or Ctrl+Q exit',
      ]);
      break;
    case 'status':
      pushSection(lines, 'status:runtime', 'Runtime', [
        `workspace: ${snapshot.workspacePath}`,
        `model: ${snapshot.detectedModel ?? 'unknown'}`,
        `permission mode: ${snapshot.permissionMode}`,
        `state: ${snapshot.paused ? 'paused' : snapshot.busy ? 'busy' : 'idle'}`,
      ]);
      pushSection(lines, 'status:queue', 'Queue', [
        `missions: ${queued} queued, ${running} running, ${completed} done, ${failed} failed`,
        active ? `active: ${compactText(active.title, 110)}` : 'active: none',
        `background: ${snapshot.backgroundTasks.filter(task => task.status === 'running').length} running`,
      ]);
      pushSection(lines, 'status:automation', 'Automation', [
        `auto run: ${snapshot.autoRunEnabled ? 'on' : 'off'}`,
        `auto memory: ${snapshot.autoExtractMemoryEnabled ? 'on' : 'off'}`,
        `auto dream: ${snapshot.autoDreamEnabled ? 'on' : 'off'}`,
      ]);
      pushSection(lines, 'status:heartbeat', 'Heartbeat', [
        `enabled: ${snapshot.heartbeatEnabled ? 'on' : 'off'}`,
        `interval: every ${snapshot.heartbeatIntervalMinutes}m`,
        `next: ${formatClock(snapshot.heartbeats.nextTickAt)} (${relativeTimeLabel(snapshot.heartbeats.nextTickAt)})`,
        `last: ${formatClock(snapshot.heartbeats.lastTickAt)}  result: ${compactText(snapshot.heartbeats.lastResult, 90) || 'n/a'}`,
      ]);
      break;
    case 'tasks': {
      const recentMissions = [...snapshot.missions]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 6);
      const missionBody =
        recentMissions.length === 0
          ? ['No missions yet.']
          : recentMissions.map(mission => {
              const modelSuffix = mission.model ? `  ${mission.model}` : '';
              const toolSuffix = mission.toolCalls > 0 ? `  tools ${mission.toolCalls}` : '';
              return `${mission.status.padEnd(9)} ${compactText(mission.title, 72)}${toolSuffix}${modelSuffix}`;
            });
      pushSection(lines, 'tasks:missions', 'Missions', missionBody);

      const backgroundTasks = snapshot.backgroundTasks.slice(0, 6);
      const backgroundBody =
        backgroundTasks.length === 0
          ? ['No background tasks.']
          : backgroundTasks.map(task => {
              const status = task.status.padEnd(9);
              const summary = compactText(task.description, 80);
              return `${status} ${task.subagentType}  ${summary}`;
            });
      pushSection(lines, 'tasks:background', 'Background Tasks', backgroundBody);
      break;
    }
    case 'memory': {
      pushSection(lines, 'memory:state', 'State', [
        `auto memory: ${snapshot.autoExtractMemoryEnabled ? 'on' : 'off'}`,
        `cached relevant memories: ${snapshot.memory.relevantMemories.length}`,
      ]);

      const relevantBody =
        snapshot.memory.relevantMemories.length === 0
          ? ['No relevant memories cached right now.']
          : snapshot.memory.relevantMemories.slice(0, 6).map(memory => {
              const score = typeof memory.score === 'number' ? `  ${Math.round(memory.score * 100)}%` : '';
              return `${memory.scope.padEnd(7)} ${memory.filename}${score}`;
            });
      pushSection(lines, 'memory:relevant', 'Relevant Memories', relevantBody);
      pushSection(lines, 'memory:session', 'Session Memory', [
        snapshot.memory.sessionMemoryPreview || 'No session memory preview yet.',
      ]);
      pushSection(lines, 'memory:manifest', 'Manifest', [
        snapshot.memory.manifestPreview || 'No memory manifest available.',
      ]);
      break;
    }
    case 'dream': {
      const dream = snapshot.dream;
      pushSection(lines, 'dream:state', 'State', [
        `enabled: ${dream?.enabled ? 'on' : 'off'}`,
        `auto memory required: ${dream?.autoMemoryEnabled ? 'yes' : 'no'}`,
        `can run: ${dream?.canRun ? 'yes' : 'no'}`,
        `blocked reason: ${dream?.blockedReason ?? 'ready'}`,
      ]);
      pushSection(lines, 'dream:timing', 'Timing', [
        `last consolidation: ${dream?.lastConsolidatedAt ?? 'never'}`,
        `hours since last: ${dream?.hoursSinceLastConsolidated ?? 'n/a'}`,
        `sessions waiting: ${(dream?.sessionsSinceLastConsolidated ?? []).length}`,
      ]);
      if ((dream?.sessionsSinceLastConsolidated ?? []).length > 0) {
        pushSection(lines, 'dream:sessions', 'Queued Sessions', [
          compactText(dream!.sessionsSinceLastConsolidated.join(', '), 130),
        ]);
      }
      break;
    }
    case 'buddy': {
      const buddy = snapshot.buddy?.buddy;
      if (!buddy) {
        pushSection(lines, 'buddy:none', 'Buddy', ['No buddy has been hatched yet.']);
        break;
      }

      const sortedStats = Object.entries(buddy.stats)
        .sort((left, right) => right[1] - left[1])
        .map(([name, value]) => `${name.toLowerCase()} ${value}`)
        .join('  ');

      pushSection(lines, 'buddy:identity', 'Buddy', [
        `name: ${buddy.name}`,
        `species: ${buddy.species}`,
        `rarity: ${buddy.rarity}${buddy.shiny ? '  shiny' : ''}`,
        `muted: ${snapshot.buddy?.muted ? 'yes' : 'no'}`,
      ]);
      pushSection(lines, 'buddy:personality', 'Personality', [
        buddy.personality || 'No personality recorded.',
      ]);
      pushSection(lines, 'buddy:stats', 'Stats', [sortedStats || 'No stats available.']);
      break;
    }
    default:
      break;
  }

  while (lines.length > 0 && !lines[lines.length - 1]?.text) {
    lines.pop();
  }

  return lines;
}

function panelDisplayLines(
  panel: OverlayPanel,
  snapshot: ControllerSnapshot,
  width: number,
  maxRows: number,
): DisplayLine[] {
  const bodyWidth = Math.max(16, width - 4);
  const flattened: DisplayLine[] = [];
  const sourceLines = buildPanelLines(panel, snapshot);

  for (const line of sourceLines) {
    if (!line.text) {
      flattened.push({ key: `${line.key}:gap`, text: '', dimColor: true });
      continue;
    }

    const wrapped = wrapLines(line.text, bodyWidth);
    wrapped.forEach((wrappedLine, index) => {
      flattened.push({
        key: `${line.key}:${index}`,
        text: `  ${wrappedLine}`,
        color: toneColor(line.tone),
        dimColor: line.tone === 'muted',
        bold: line.bold && index === 0,
      });
    });
  }

  if (flattened.length <= maxRows) {
    return flattened;
  }

  return [
    ...flattened.slice(0, Math.max(0, maxRows - 1)),
    { key: 'panel:more', text: '  ...', dimColor: true },
  ];
}

function panelTabPills(panel: OverlayPanel): FooterPill[] {
  return PANEL_ORDER.map(entry => ({
    id: entry,
    label: panelLabel(entry),
    backgroundColor: entry === panel ? 'cyan' : 'gray',
    color: 'black',
    active: entry === panel,
  }));
}

function repeatRule(width: number): string {
  return '-'.repeat(Math.max(12, width));
}

function enterAlternateScreen(): void {
  if (!process.stdout.isTTY) {
    return;
  }
  process.stdout.write('\u001B[?1049h');
  process.stdout.write('\u001B[2J\u001B[H');
}

function leaveAlternateScreen(): void {
  if (!process.stdout.isTTY) {
    return;
  }
  process.stdout.write('\u001B[?1049l');
}

function StatusPill(props: { pill: FooterPill }): React.ReactNode {
  const backgroundColor = props.pill.active ? 'cyan' : props.pill.backgroundColor ?? 'gray';
  const color = props.pill.active ? 'black' : props.pill.color ?? 'black';

  return (
    <Text backgroundColor={backgroundColor} color={color}>
      {` ${props.pill.label} `}
    </Text>
  );
}

function FooterPillRow(props: { pills: FooterPill[]; width: number }): React.ReactNode {
  const visible = pickFooterPills(props.pills, props.width);

  return (
    <Box>
      {visible.map((pill, index) => (
        <Box key={pill.id} marginRight={index === visible.length - 1 ? 0 : 1}>
          <StatusPill pill={pill} />
        </Box>
      ))}
    </Box>
  );
}

function SlashPalette(props: {
  matches: SlashCommandTemplate[];
  selectedIndex: number;
  width: number;
}): React.ReactNode {
  const visibleMatches = props.matches.slice(0, 5);
  const labelWidth = Math.min(
    Math.max(...visibleMatches.map(command => stringWidth(command.value)), 0) + 2,
    Math.max(18, Math.floor(props.width * 0.45)),
  );

  return (
    <Box flexDirection="column" paddingX={2}>
      {visibleMatches.length === 0 ? (
        <Text dimColor>No matching command.</Text>
      ) : (
        visibleMatches.map((command, index) => {
          const selected = index === props.selectedIndex;
          const padded = `${command.value}${' '.repeat(Math.max(0, labelWidth - stringWidth(command.value)))}`;
          return (
            <Box key={command.value}>
              <Text
                backgroundColor={selected ? 'cyan' : undefined}
                color={selected ? 'black' : 'cyan'}
              >
                {padded}
              </Text>
              <Text dimColor>{`  ${command.description}`}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

function PanelView(props: {
  panel: OverlayPanel;
  snapshot: ControllerSnapshot;
  width: number;
  height: number;
}): React.ReactNode {
  const tabs = panelTabPills(props.panel);
  const bodyLines = panelDisplayLines(props.panel, props.snapshot, props.width, Math.max(3, props.height - 2));

  return (
    <Box flexDirection="column">
      <Text dimColor>{repeatRule(props.width)}</Text>
      <Box paddingX={2} marginBottom={1}>
        {tabs.map((pill, index) => (
          <Box key={pill.id} marginRight={index === tabs.length - 1 ? 0 : 1}>
            <StatusPill pill={pill} />
          </Box>
        ))}
      </Box>
      <Box flexDirection="column">
        {bodyLines.map(line => (
          <Text
            key={line.key}
            color={line.color}
            backgroundColor={line.backgroundColor}
            dimColor={line.dimColor}
            bold={line.bold}
          >
            {line.text || ' '}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function ActoviqClawInkApp(props: {
  controller: AutonomousAssistantController;
}): React.ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  const [snapshot, setSnapshot] = useState<ControllerSnapshot>(props.controller.snapshot());
  const [input, setInput] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [scrollOffsetLines, setScrollOffsetLines] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activePanel, setActivePanel] = useState<OverlayPanel | 'none'>('none');
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [escapePending, setEscapePending] = useState(false);
  const lastLineCountRef = useRef(0);
  const exitingRef = useRef(false);
  const historyDraftRef = useRef('');
  const suppressHistoryResetRef = useRef(false);
  const escapeTimerRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    const handler = (nextSnapshot: ControllerSnapshot): void => {
      setSnapshot(nextSnapshot);
    };

    props.controller.on('updated', handler);
    return () => {
      (props.controller as unknown as EventEmitter).off('updated', handler);
    };
  }, [props.controller]);

  useEffect(() => {
    return () => {
      if (escapeTimerRef.current) {
        clearTimeout(escapeTimerRef.current);
      }
    };
  }, []);

  const commandMatches = useMemo(() => filterSlashCommands(input), [input]);
  const commandPaletteVisible = input.trimStart().startsWith('/');
  const selectedCommand = commandMatches[selectedCommandIndex];
  const inlineGhostText =
    commandPaletteVisible &&
    selectedCommand &&
    selectedCommand.value.toLowerCase().startsWith(input.toLowerCase())
      ? selectedCommand.value.slice(input.length)
      : undefined;
  const editorColumns = Math.max(12, columns - 6);
  const promptLines = useMemo(
    () =>
      renderPromptLines({
        value: input,
        cursorOffset,
        columns: editorColumns,
        placeholder: 'Type a task or /command',
        inlineGhostText,
      }),
    [columns, cursorOffset, editorColumns, inlineGhostText, input],
  );

  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [input]);

  const unreadPillRows = unreadCount > 0 && scrollOffsetLines > 0 ? 1 : 0;
  const panelRows = activePanel === 'none' ? 0 : Math.min(13, Math.max(7, Math.floor(rows * 0.33)));
  const paletteRows = commandPaletteVisible ? Math.max(1, Math.min(5, commandMatches.length || 1)) : 0;
  const dividerRows = 1;
  const inputRows = Math.max(1, promptLines.length);
  const footerRows = 2;
  const bodyRows = Math.max(
    3,
    rows - panelRows - paletteRows - unreadPillRows - dividerRows - inputRows - footerRows,
  );

  const allLines = useMemo(
    () => timelineToLines(snapshot, Math.max(20, columns - 2)),
    [columns, snapshot],
  );
  const maxScroll = Math.max(0, allLines.length - bodyRows);

  useEffect(() => {
    setScrollOffsetLines(current => Math.min(current, maxScroll));
  }, [maxScroll]);

  useEffect(() => {
    const currentLineCount = allLines.length;
    const previousLineCount = lastLineCountRef.current;
    if (scrollOffsetLines > 0 && currentLineCount > previousLineCount) {
      setUnreadCount(current => Math.min(99, current + (currentLineCount - previousLineCount)));
    } else if (scrollOffsetLines === 0) {
      setUnreadCount(0);
    }
    lastLineCountRef.current = currentLineCount;
  }, [allLines.length, scrollOffsetLines]);

  const startLine = Math.max(0, allLines.length - bodyRows - scrollOffsetLines);
  const visibleLines = allLines.slice(startLine, startLine + bodyRows);
  const footerPills = buildFooterPills(snapshot, activePanel);
  const active = activeMission(snapshot);
  const hintText = footerHint(
    snapshot,
    activePanel,
    commandPaletteVisible,
    scrollOffsetLines,
    active,
    escapePending,
  );

  const requestExit = (): void => {
    if (exitingRef.current) {
      return;
    }
    exitingRef.current = true;
    void props.controller.dispose().finally(() => {
      exit();
    });
  };

  const submitInput = (): void => {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    let payload = trimmed;
    const selected = commandMatches[selectedCommandIndex];
    if (
      commandPaletteVisible &&
      selected &&
      selected.value.toLowerCase().startsWith(trimmed.toLowerCase())
    ) {
      payload = selected.value;
    }

    setInput('');
    setCursorOffset(0);
    setUnreadCount(0);
    setScrollOffsetLines(0);
    setHistoryIndex(null);
    historyDraftRef.current = '';
    setInputHistory(current => {
      if (current[current.length - 1] === trimmed) {
        return current;
      }
      return [...current, trimmed].slice(-100);
    });

    const panelCommand = localPanelCommand(payload);
    if (panelCommand === 'close') {
      setActivePanel('none');
      return;
    }
    if (panelCommand) {
      setActivePanel(panelCommand);
      return;
    }

    if (payload.startsWith('/')) {
      const panel = followupPanel(payload);
      if (panel) {
        setActivePanel(panel);
      }
    } else {
      setActivePanel('none');
    }

    void props.controller.handleInput(payload);
  };

  const updateInput = (value: string, nextCursorOffset = value.length): void => {
    setInput(value);
    setCursorOffset(clampCursorOffset(value, nextCursorOffset));
    setEscapePending(false);
    if (escapeTimerRef.current) {
      clearTimeout(escapeTimerRef.current);
      escapeTimerRef.current = undefined;
    }
    if (suppressHistoryResetRef.current) {
      suppressHistoryResetRef.current = false;
      return;
    }
    if (historyIndex !== null) {
      setHistoryIndex(null);
    }
  };

  const restoreHistoryInput = (value: string, nextIndex: number | null): void => {
    suppressHistoryResetRef.current = true;
    setInput(value);
    setCursorOffset(value.length);
    setHistoryIndex(nextIndex);
  };

  const navigateHistoryUp = (): void => {
    if (inputHistory.length === 0) {
      return;
    }

    if (historyIndex === null) {
      historyDraftRef.current = input;
      restoreHistoryInput(inputHistory[inputHistory.length - 1] ?? '', inputHistory.length - 1);
      return;
    }

    const nextIndex = Math.max(0, historyIndex - 1);
    restoreHistoryInput(inputHistory[nextIndex] ?? '', nextIndex);
  };

  const navigateHistoryDown = (): void => {
    if (historyIndex === null) {
      return;
    }

    const nextIndex = historyIndex + 1;
    if (nextIndex >= inputHistory.length) {
      restoreHistoryInput(historyDraftRef.current, null);
      historyDraftRef.current = '';
      return;
    }

    restoreHistoryInput(inputHistory[nextIndex] ?? '', nextIndex);
  };

  const applyEditorCursor = (nextCursor: Cursor): void => {
    updateInput(nextCursor.text, nextCursor.offset);
  };

  const handleEditorInput = (value: string, key: Record<string, boolean | undefined>): boolean => {
    const cursor = createInputCursor(input, cursorOffset, editorColumns);

    if (key.return) {
      if (key.shift || key.meta) {
        applyEditorCursor(cursor.insert('\n'));
        return true;
      }

      submitInput();
      return true;
    }

    if (key.home) {
      applyEditorCursor(cursor.startOfLine());
      return true;
    }

    if (key.end) {
      applyEditorCursor(cursor.endOfLine());
      return true;
    }

    if (key.leftArrow) {
      applyEditorCursor(key.ctrl || key.meta ? cursor.prevWord() : cursor.left());
      return true;
    }

    if (key.rightArrow) {
      applyEditorCursor(key.ctrl || key.meta ? cursor.nextWord() : cursor.right());
      return true;
    }

    if (key.upArrow) {
      const visual = cursor.up();
      if (!visual.equals(cursor)) {
        applyEditorCursor(visual);
        return true;
      }

      if (input.includes('\n')) {
        const logical = cursor.upLogicalLine();
        if (!logical.equals(cursor)) {
          applyEditorCursor(logical);
          return true;
        }
      }

      navigateHistoryUp();
      return true;
    }

    if (key.downArrow) {
      const visual = cursor.down();
      if (!visual.equals(cursor)) {
        applyEditorCursor(visual);
        return true;
      }

      if (input.includes('\n')) {
        const logical = cursor.downLogicalLine();
        if (!logical.equals(cursor)) {
          applyEditorCursor(logical);
          return true;
        }
      }

      navigateHistoryDown();
      return true;
    }

    if (key.backspace) {
      applyEditorCursor(key.ctrl || key.meta ? (cursor.deleteTokenBefore() ?? cursor.backspace()) : cursor.backspace());
      return true;
    }

    if (key.delete) {
      applyEditorCursor(key.meta ? cursor.deleteWordAfter() : cursor.del());
      return true;
    }

    if (key.ctrl) {
      switch (value) {
        case 'a':
          applyEditorCursor(cursor.startOfLine());
          return true;
        case 'e':
          applyEditorCursor(cursor.endOfLine());
          return true;
        case 'b':
          applyEditorCursor(cursor.left());
          return true;
        case 'f':
          applyEditorCursor(cursor.right());
          return true;
        case 'd':
          applyEditorCursor(cursor.del());
          return true;
        case 'h':
          applyEditorCursor(cursor.deleteTokenBefore() ?? cursor.backspace());
          return true;
        case 'k':
          applyEditorCursor(cursor.deleteToLineEnd().cursor);
          return true;
        case 'u':
          applyEditorCursor(cursor.deleteToLineStart().cursor);
          return true;
        case 'w':
          applyEditorCursor(cursor.deleteWordBefore().cursor);
          return true;
        default:
          break;
      }
    }

    if (key.meta) {
      switch (value) {
        case 'b':
          applyEditorCursor(cursor.prevWord());
          return true;
        case 'f':
          applyEditorCursor(cursor.nextWord());
          return true;
        case 'd':
          applyEditorCursor(cursor.deleteWordAfter());
          return true;
        default:
          break;
      }
    }

    if (value && !key.ctrl && !key.meta && !key.tab && !key.escape) {
      applyEditorCursor(cursor.insert(value));
      return true;
    }

    return false;
  };

  useInput((value, key) => {
    if (key.ctrl && value === 'q') {
      requestExit();
      return;
    }

    if (key.ctrl && value === 'c') {
      requestExit();
      return;
    }

    if (!input && value === '?') {
      setActivePanel('help');
      return;
    }

    if (key.pageUp) {
      setScrollOffsetLines(current => Math.min(maxScroll, current + Math.max(3, Math.floor(bodyRows / 2))));
      return;
    }

    if (key.pageDown) {
      setScrollOffsetLines(current => Math.max(0, current - Math.max(3, Math.floor(bodyRows / 2))));
      return;
    }

    if (key.upArrow && commandPaletteVisible && commandMatches.length > 0) {
      setSelectedCommandIndex(current => (current - 1 + commandMatches.length) % commandMatches.length);
      return;
    }

    if (key.downArrow && commandPaletteVisible && commandMatches.length > 0) {
      setSelectedCommandIndex(current => (current + 1) % commandMatches.length);
      return;
    }

    if (!commandPaletteVisible && activePanel !== 'none' && !input && key.leftArrow) {
      setActivePanel(current => (current === 'none' ? 'help' : cyclePanel(current, -1)));
      return;
    }

    if (!commandPaletteVisible && activePanel !== 'none' && !input && key.rightArrow) {
      setActivePanel(current => (current === 'none' ? 'help' : cyclePanel(current, 1)));
      return;
    }

    if (key.tab && commandPaletteVisible && commandMatches.length > 0) {
      const match = commandMatches[selectedCommandIndex];
      if (match) {
        setInput(match.value);
      }
      return;
    }

    if (key.escape && commandPaletteVisible) {
      setInput('');
      setCursorOffset(0);
      setEscapePending(false);
      setHistoryIndex(null);
      return;
    }

    if (key.escape && activePanel !== 'none' && !input) {
      setActivePanel('none');
      return;
    }

    if (key.escape && input) {
      if (!escapePending) {
        setEscapePending(true);
        if (escapeTimerRef.current) {
          clearTimeout(escapeTimerRef.current);
        }
        escapeTimerRef.current = setTimeout(() => {
          setEscapePending(false);
          escapeTimerRef.current = undefined;
        }, 800);
        return;
      }

      setInput('');
      setCursorOffset(0);
      setEscapePending(false);
      if (escapeTimerRef.current) {
        clearTimeout(escapeTimerRef.current);
        escapeTimerRef.current = undefined;
      }
      setHistoryIndex(null);
      historyDraftRef.current = '';
      return;
    }

    if (key.escape && active?.status === 'running') {
      void props.controller.handleInput(`/cancel ${active.id}`);
      setActivePanel('tasks');
      return;
    }

    if (handleEditorInput(value, key)) {
      return;
    }
  });

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexGrow={1} flexDirection="column">
        {visibleLines.map(line => (
          <Text
            key={line.key}
            color={line.color}
            backgroundColor={line.backgroundColor}
            dimColor={line.dimColor}
            bold={line.bold}
          >
            {line.text || ' '}
          </Text>
        ))}
      </Box>

      {unreadCount > 0 && scrollOffsetLines > 0 ? (
        <Box paddingX={2}>
          <Text backgroundColor="yellow" color="black">
            {` ${unreadCount} new message${unreadCount === 1 ? '' : 's'} `}
          </Text>
          <Text dimColor>{'  PgDn toward newest'}</Text>
        </Box>
      ) : null}

      {activePanel !== 'none' ? (
        <PanelView
          panel={activePanel}
          snapshot={snapshot}
          width={columns}
          height={panelRows}
        />
      ) : null}

      {commandPaletteVisible ? (
        <SlashPalette
          matches={commandMatches}
          selectedIndex={selectedCommandIndex}
          width={columns}
        />
      ) : null}

      <Text dimColor>{repeatRule(columns)}</Text>

      <Box paddingX={2} flexDirection="column">
        {promptLines.map((line, index) => (
          <Box key={`prompt:${index}`}>
            <Text color={commandPaletteVisible ? 'cyan' : 'white'}>
              {index === 0 ? '> ' : '  '}
            </Text>
            <Text>{line || ' '}</Text>
          </Box>
        ))}
      </Box>

      <Box paddingX={2}>
        <Text dimColor>{compactText(hintText, Math.max(12, columns - 4))}</Text>
      </Box>

      <Box paddingX={2}>
        <FooterPillRow pills={footerPills} width={Math.max(12, columns - 4)} />
      </Box>
    </Box>
  );
}

export class ActoviqClawTui {
  constructor(private readonly controller: AutonomousAssistantController) {}

  async mount(): Promise<void> {
    enterAlternateScreen();
    try {
      const app = render(<ActoviqClawInkApp controller={this.controller} />, {
        exitOnCtrlC: false,
      });
      await app.waitUntilExit();
    } finally {
      leaveAlternateScreen();
    }
  }
}
