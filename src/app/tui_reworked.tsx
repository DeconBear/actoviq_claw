import process from 'node:process';
import { EventEmitter } from 'node:events';

import chalk from 'chalk';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdin, useStdout } from 'ink';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

import { Cursor } from './claudecode/Cursor.js';
import type { AssistantLogEntry, AssistantMission, ControllerSnapshot } from './types.js';
import type { AutonomousAssistantController } from './controller.js';
import { applyRawInputSequence, withRawTerminalKeys } from './inputSequence.js';
import { FullscreenLayout } from './tui/FullscreenLayout.js';
import {
  type DisplayLine,
  type TranscriptBlock,
  findStickyPrompt,
  useTranscriptLayout,
  useVirtualScroll,
  VirtualMessageList,
} from './tui/VirtualMessageList.js';
import {
  applyMentionSuggestion,
  extractMentionToken,
  formatMentionReplacement,
  getWorkspacePathSuggestions,
  startWorkspaceFileScan,
  type MentionToken,
  type WorkspacePathSuggestion,
} from './workspaceFiles.js';

type OverlayPanel = 'help' | 'status' | 'tasks' | 'heartbeat' | 'memory' | 'dream' | 'buddy';
type TimelineTone = 'normal' | 'success' | 'warning' | 'error' | 'muted';
type PanelTone = 'normal' | 'accent' | 'success' | 'warning' | 'error' | 'muted';

interface SlashCommandTemplate {
  value: string;
  description: string;
}

interface PanelCommandTemplate {
  value: string;
  description: string;
}

interface SuggestionOption {
  id: string;
  value: string;
  description: string;
  kind: 'slash' | 'resume' | 'file' | 'panel';
  replacement?: string;
}

interface TimelineItem {
  id: string;
  at: string;
  role: 'user' | 'assistant';
  text: string;
  tone: TimelineTone;
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

const SLASH_COMMANDS: SlashCommandTemplate[] = [
  { value: '/help', description: 'open help and usage notes' },
  { value: '/status', description: 'open runtime status and chat controls' },
  { value: '/tasks', description: 'open missions, queue, and archived chats' },
  { value: '/heartbeat', description: 'open heartbeat controls and schedule settings' },
  { value: '/memory', description: 'open memory state and memory search tools' },
  { value: '/dream', description: 'open dream state and run controls' },
  { value: '/buddy', description: 'open buddy controls' },
  { value: '/close', description: 'close the current panel' },
];

const MAX_INPUT_VISIBLE_LINES = 6;
const ASSISTANT_PREFIX = '  ⎿ ';
const ASSISTANT_CONTINUATION = '    ';
const USER_MESSAGE_BACKGROUND = '#1f2328';
const USER_MESSAGE_FOREGROUND = '#f0f6fc';
const ASSISTANT_PREFIX_COLOR = '#8b949e';
const WELCOME_PREFIX_COLOR = '#6e7681';

function compactText(value: string | undefined, maxLength: number): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function firstParagraph(value: string): string {
  const trimmed = value.trimStart();
  const splitIndex = trimmed.search(/\n\s*\n/u);
  return splitIndex >= 0 ? trimmed.slice(0, splitIndex) : trimmed;
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

  return createInputCursor(props.value, props.cursorOffset, props.columns)
    .render(
      ' ',
      '',
      chalk.inverse,
      props.inlineGhostText ? { text: props.inlineGhostText, dim: chalk.dim } : undefined,
      MAX_INPUT_VISIBLE_LINES,
    )
    .split('\n');
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
      return { id: `${mission.id}:assistant`, at, role: 'assistant', text: mission.resultText, tone: 'normal' };
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
    return { id: `${mission.id}:cancelled`, at, role: 'assistant', text: 'Mission cancelled.', tone: 'warning' };
  }

  return undefined;
}

function logToTimelineItem(entry: AssistantLogEntry): TimelineItem | undefined {
  const text = (entry.text ?? '').trim();
  if (!text) {
    return undefined;
  }

  if (text.startsWith('Actoviq Claw is ready.')) return undefined;
  if (/^Queued mission [^:]+:/u.test(text)) return undefined;
  if (/^Running mission [^:]+:/u.test(text)) return undefined;
  if (/^Mission [^ ]+ completed with \d+ tool calls\.$/u.test(text)) return undefined;
  if (/^Mission [^ ]+ failed:/u.test(text)) return undefined;
  if (/^Cancelled queued mission /u.test(text)) return undefined;
  if (/^Abort requested for mission /u.test(text)) return undefined;
  if (/^Session memory (updated|checked):/u.test(text)) return undefined;
  if (/^Session compacted /u.test(text)) return undefined;
  if (text === 'Heartbeat acknowledged with HEARTBEAT_OK.') return undefined;
  if (text.startsWith('Dream skipped:')) return undefined;
  if (text.startsWith('Dream launched in background:')) return undefined;
  if (text.startsWith('Dream finished:')) return undefined;
  if (text.startsWith('Tool call:')) return undefined;
  if (text.startsWith('Tool result:')) return undefined;
  if (text.startsWith('Permission ')) return undefined;
  if (entry.scope === 'background') return undefined;

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
    items.push({ id: `${mission.id}:user`, at: mission.createdAt, role: 'user', text: mission.prompt, tone: 'normal' });
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

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('');
      continue;
    }

    lines.push(
      ...wrapAnsi(paragraph, Math.max(8, width), {
        hard: true,
        trim: false,
        wordWrap: true,
      }).split('\n'),
    );
  }

  return lines.length > 0 ? lines : [''];
}

function assistantBlockLines(
  item: TimelineItem,
  width: number,
): DisplayLine[] {
  const wrapped = wrapLines(item.text, Math.max(12, width - stringWidth(ASSISTANT_PREFIX)));

  return wrapped.map((line, lineIndex) => ({
    key: `${item.id}:body:${lineIndex}`,
    prefixText: lineIndex === 0 ? ASSISTANT_PREFIX : ASSISTANT_CONTINUATION,
    prefixColor: ASSISTANT_PREFIX_COLOR,
    prefixDimColor: true,
    text: line,
    color: toneColor(item.tone) ?? 'white',
    dimColor: item.tone === 'muted',
  }));
}

function userBlockLines(
  item: TimelineItem,
  width: number,
): DisplayLine[] {
  const wrapped = wrapLines(item.text, Math.max(12, width - 2));

  return wrapped.map((line, lineIndex) => ({
    key: `${item.id}:body:${lineIndex}`,
    text: line ? ` ${line} ` : '  ',
    color: USER_MESSAGE_FOREGROUND,
    backgroundColor: USER_MESSAGE_BACKGROUND,
  }));
}

function timelineToBlocks(snapshot: ControllerSnapshot, width: number): TranscriptBlock[] {
  const timeline = buildTimeline(snapshot);

  if (timeline.length === 0) {
    return [
      {
        id: 'welcome',
        role: 'assistant',
        contentStartRow: 0,
        lines: [
          {
            key: 'welcome:0',
            prefixText: ASSISTANT_PREFIX,
            prefixColor: WELCOME_PREFIX_COLOR,
            prefixDimColor: true,
            text: 'Ready.',
            color: 'white',
            bold: true,
          },
          {
            key: 'welcome:1',
            prefixText: ASSISTANT_CONTINUATION,
            prefixColor: WELCOME_PREFIX_COLOR,
            prefixDimColor: true,
            text: 'Start with a task, or type / for commands.',
            dimColor: true,
          },
          {
            key: 'welcome:2',
            prefixText: ASSISTANT_CONTINUATION,
            prefixColor: WELCOME_PREFIX_COLOR,
            prefixDimColor: true,
            text: 'Buddy, heartbeat, dream, memory, and tasks are all available from slash commands.',
            dimColor: true,
          },
        ],
      },
    ];
  }

  return timeline.map((item, index) => {
    const lines: DisplayLine[] = [];

    if (index > 0) {
      lines.push({ key: `${item.id}:gap`, text: '' });
    }

    lines.push(...(item.role === 'user' ? userBlockLines(item, width) : assistantBlockLines(item, width)));

    return {
      id: item.id,
      role: item.role,
      lines,
      contentStartRow: index > 0 ? 1 : 0,
      stickyLabel: item.role === 'user' ? compactText(firstParagraph(item.text), Math.max(16, width - 10)) : undefined,
    };
  });
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
    case '/heartbeat':
      return 'heartbeat';
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

  if (normalized === '/pause' || normalized === '/resume queue') return 'status';
  if (normalized.startsWith('/resume')) return 'tasks';
  if (normalized === '/heartbeat' || normalized.startsWith('/heartbeat ')) return 'heartbeat';
  if (normalized.startsWith('/buddy ')) return 'buddy';
  if (normalized.startsWith('/dream ')) return 'dream';
  if (normalized.startsWith('/memory ')) return 'memory';
  if (normalized.startsWith('/cancel ')) return 'tasks';
  return undefined;
}

function filterResumeSuggestions(query: string, snapshot: ControllerSnapshot): SuggestionOption[] {
  const normalized = query.trim().toLowerCase();
  if (!/^\/resume\s+/u.test(query.toLowerCase())) {
    return [];
  }

  const search = normalized.slice('/resume'.length).trim();
  return snapshot.archivedChats
    .filter(chat => {
      if (!search) {
        return true;
      }
      return (
        chat.id.toLowerCase().includes(search) ||
        chat.title.toLowerCase().includes(search) ||
        chat.preview.toLowerCase().includes(search)
      );
    })
    .map(chat => ({
      id: `resume:${chat.id}`,
      value: `/resume ${chat.id}`,
      description: `${chat.title} · ${chat.preview}`,
      kind: 'resume' as const,
    }));
}

function filterSlashCommands(query: string, snapshot: ControllerSnapshot): SuggestionOption[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized.startsWith('/')) {
    return [];
  }

  const matches = SLASH_COMMANDS.filter(command => {
    const value = command.value.toLowerCase();
    return value.startsWith(normalized) || value.includes(normalized);
  })
    .map(command => ({
      id: command.value,
      value: command.value,
      description: command.description,
      kind: 'slash' as const,
    }));

  const resumeMatches = filterResumeSuggestions(query, snapshot);
  return normalized.startsWith('/resume')
    ? [...resumeMatches, ...matches]
    : [...matches, ...resumeMatches];
}

function preserveSuggestionIndex(
  previous: SuggestionOption[],
  currentIndex: number,
  next: SuggestionOption[],
): number {
  if (next.length === 0) {
    return 0;
  }

  if (currentIndex < 0) {
    return 0;
  }

  const previousSelected = previous[currentIndex];
  if (!previousSelected) {
    return 0;
  }

  const nextIndex = next.findIndex(item => item.id === previousSelected.id);
  return nextIndex >= 0 ? nextIndex : 0;
}

function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) {
    return '';
  }

  let prefix = values[0] ?? '';
  for (const value of values.slice(1)) {
    let index = 0;
    const maxLength = Math.min(prefix.length, value.length);
    while (index < maxLength && prefix[index] === value[index]) {
      index += 1;
    }
    prefix = prefix.slice(0, index);
    if (!prefix) {
      break;
    }
  }
  return prefix;
}

function panelCommandTemplates(panel: OverlayPanel, snapshot: ControllerSnapshot): PanelCommandTemplate[] {
  switch (panel) {
    case 'status':
      return [
        { value: 'pause', description: 'pause the autonomous queue' },
        { value: 'resume', description: 'resume the autonomous queue' },
        { value: 'newchat', description: 'start a fresh chat window' },
        { value: 'sessions', description: 'list recent SDK sessions' },
      ];
    case 'tasks': {
      const active = activeMission(snapshot);
      return [
        { value: 'pause', description: 'pause the autonomous queue' },
        { value: 'resume last', description: 'resume the latest archived chat' },
        { value: 'resume list', description: 'list archived chats' },
        { value: 'resume queue', description: 'resume the paused queue' },
        {
          value: active ? `cancel ${active.id}` : 'cancel <mission-id>',
          description: 'cancel a queued or running mission',
        },
      ];
    }
    case 'heartbeat':
      return [
        { value: 'tick', description: 'run one heartbeat now' },
        { value: 'on', description: 'enable heartbeat mode' },
        { value: 'off', description: 'disable heartbeat mode' },
        { value: 'toggle', description: 'toggle heartbeat mode' },
        { value: `every ${snapshot.heartbeatIntervalMinutes}`, description: 'set heartbeat interval in minutes' },
        {
          value: `start ${snapshot.heartbeatActiveHours?.start ?? '08:00'}`,
          description: 'set heartbeat daily start time',
        },
        {
          value: `end ${snapshot.heartbeatActiveHours?.end ?? '23:30'}`,
          description: 'set heartbeat daily end time',
        },
        {
          value: `hours ${snapshot.heartbeatActiveHours?.start ?? '08:00'} ${snapshot.heartbeatActiveHours?.end ?? '23:30'}`,
          description: 'set the full active time window',
        },
        {
          value: `timezone ${snapshot.heartbeatActiveHours?.timezone ?? 'Asia/Shanghai'}`,
          description: 'set heartbeat timezone or clear it',
        },
        {
          value: `file ${compactPath(snapshot.heartbeatGuideFilePath) || './HEARTBEAT.md'}`,
          description: 'set the heartbeat guide file path',
        },
        {
          value: `isolated ${snapshot.heartbeatUseIsolatedSession ? 'on' : 'off'}`,
          description: 'toggle isolated heartbeat sessions',
        },
      ];
    case 'memory':
      return [
        { value: 'refresh', description: 'refresh memory panel state' },
        { value: 'find release flow', description: 'search relevant memories' },
      ];
    case 'dream':
      return [
        { value: 'run', description: 'launch a dream run now' },
        { value: 'state', description: 'refresh dream state' },
      ];
    case 'buddy':
      return [
        { value: 'pet', description: 'pet the buddy' },
        { value: snapshot.buddy?.muted ? 'unmute' : 'mute', description: 'toggle buddy audio presence' },
        {
          value: `hatch ${snapshot.buddy?.buddy?.name ?? 'Mochi'} calm and observant`,
          description: 'hatch or replace the current buddy',
        },
      ];
    case 'help':
      return [
        { value: '/status', description: 'open runtime status and chat controls' },
        { value: '/tasks', description: 'open tasks and archived chats' },
        { value: '/heartbeat', description: 'open heartbeat controls' },
        { value: '/memory', description: 'open memory tools' },
        { value: '/dream', description: 'open dream controls' },
        { value: '/buddy', description: 'open buddy controls' },
      ];
    default:
      return [];
  }
}

function filterPanelCommands(
  panel: OverlayPanel | 'none',
  input: string,
  snapshot: ControllerSnapshot,
): SuggestionOption[] {
  if (panel === 'none') {
    return [];
  }

  const normalized = input.trim().toLowerCase();
  return panelCommandTemplates(panel, snapshot)
    .filter(command => {
      if (!normalized) {
        return true;
      }
      const value = command.value.toLowerCase();
      return value.startsWith(normalized) || value.includes(normalized);
    })
    .map(command => ({
      id: `${panel}:${command.value}`,
      value: command.value,
      description: command.description,
      kind: 'panel' as const,
    }));
}

function slashCommandArgumentHint(input: string): string | undefined {
  if (!input.startsWith('/')) {
    return undefined;
  }

  const normalized = normalizeCommand(input);
  switch (normalized) {
    case '/heartbeat':
      return 'Enter to open heartbeat controls';
    case '/buddy':
      return 'Enter to open buddy controls';
    case '/dream':
      return 'Enter to open dream controls';
    case '/memory':
      return 'Enter to open memory controls';
    case '/tasks':
      return 'Enter to open tasks and archived chats';
    case '/status':
      return 'Enter to open runtime status';
    case '/resume':
      return 'resume <chat-id|last|list|queue>';
    case '/cancel':
      return 'cancel <mission-id>';
    default:
      return undefined;
  }
}

function panelCommandArgumentHint(panel: OverlayPanel | 'none', input: string): string | undefined {
  if (panel === 'none') {
    return undefined;
  }

  const normalized = normalizeCommand(input);
  switch (`${panel}:${normalized}`) {
    case 'tasks:resume':
      return 'resume <chat-id|last|list|queue>';
    case 'tasks:cancel':
      return 'cancel <mission-id>';
    case 'heartbeat:every':
    case 'heartbeat:interval':
      return 'every <minutes>';
    case 'heartbeat:start':
      return 'start <HH:MM>';
    case 'heartbeat:end':
      return 'end <HH:MM>';
    case 'heartbeat:hours':
      return 'hours <HH:MM> <HH:MM>';
    case 'heartbeat:timezone':
      return 'timezone <IANA name|clear>';
    case 'heartbeat:file':
    case 'heartbeat:path':
      return 'file <path-to-heartbeat-guide>';
    case 'heartbeat:isolated':
      return 'isolated <on|off>';
    case 'memory:find':
      return 'find <query>';
    case 'buddy:hatch':
      return 'hatch <name> [personality]';
    default:
      return undefined;
  }
}

function panelLabel(panel: OverlayPanel): string {
  switch (panel) {
    case 'help':
      return 'Help';
    case 'status':
      return 'Status';
    case 'tasks':
      return 'Tasks';
    case 'heartbeat':
      return 'Heartbeat';
    case 'memory':
      return 'Memory';
    case 'dream':
      return 'Dream';
    case 'buddy':
      return 'Buddy';
    default:
      return panel;
  }
}

function formatMissionCount(snapshot: ControllerSnapshot, status: AssistantMission['status']): number {
  return snapshot.missions.filter(mission => mission.status === status).length;
}

function activeMission(snapshot: ControllerSnapshot): AssistantMission | undefined {
  return snapshot.missions.find(mission => mission.id === snapshot.activeMissionId);
}

function buildFooterPills(snapshot: ControllerSnapshot, activePanel: OverlayPanel | 'none'): FooterPill[] {
  const queued = formatMissionCount(snapshot, 'queued');
  const running = formatMissionCount(snapshot, 'running');
  const backgroundRunning = snapshot.backgroundTasks.filter(task => task.status === 'running').length;
  const hbLabel = snapshot.heartbeatEnabled ? `hb ${relativeTimeLabel(snapshot.heartbeats.nextTickAt)}` : 'hb off';
  const dreamLabel = snapshot.dream?.enabled
    ? snapshot.dream.canRun
      ? 'dream ready'
      : `dream ${snapshot.dream.blockedReason ?? 'waiting'}`
    : 'dream off';
  const buddyLabel = snapshot.buddy?.buddy ? `buddy ${snapshot.buddy.buddy.name.toLowerCase()}` : 'buddy none';
  const memoryLabel = `memory ${snapshot.memory.relevantMemories.length}`;
  const taskLabel = `tasks ${queued + running + backgroundRunning}`;
  const pills: FooterPill[] = [];

  if (activePanel !== 'none') {
    pills.push({ id: 'panel', label: panelLabel(activePanel), backgroundColor: 'cyan', color: 'black', active: true });
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
    backgroundColor: snapshot.heartbeatEnabled ? 'gray' : 'black',
    color: snapshot.heartbeatEnabled ? 'white' : 'gray',
  });
  pills.push({
    id: 'dream',
    label: dreamLabel,
    backgroundColor: snapshot.dream?.canRun ? 'gray' : 'black',
    color: snapshot.dream?.canRun ? 'white' : 'gray',
  });
  pills.push({
    id: 'buddy',
    label: buddyLabel,
    backgroundColor: snapshot.buddy?.muted ? 'black' : 'gray',
    color: snapshot.buddy?.muted ? 'gray' : 'white',
  });
  pills.push({
    id: 'tasks',
    label: taskLabel,
    backgroundColor: queued + running + backgroundRunning > 0 ? 'yellow' : 'black',
    color: queued + running + backgroundRunning > 0 ? 'black' : 'gray',
  });
  pills.push({
    id: 'memory',
    label: memoryLabel,
    backgroundColor: snapshot.memory.relevantMemories.length > 0 ? 'gray' : 'black',
    color: snapshot.memory.relevantMemories.length > 0 ? 'white' : 'gray',
  });
  pills.push({ id: 'model', label: snapshot.detectedModel ?? 'model unknown', backgroundColor: 'black', color: 'gray' });
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

  const morePill: FooterPill = { id: 'more', label: `+${hiddenCount}`, backgroundColor: 'black', color: 'gray' };
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
  suggestionsVisible: boolean,
  atBottom: boolean,
  active: AssistantMission | undefined,
  escapePending: boolean,
): string {
  if (escapePending) return 'Esc again to clear';
  if (suggestionsVisible) {
    if (activePanel !== 'none') {
      return 'Up/Down move  Enter run  Tab insert  Esc dismiss';
    }
    return 'Up/Down move  Tab accept  Esc dismiss';
  }
  if (activePanel !== 'none') return `${panelLabel(activePanel)} open  Enter panel command  Esc close  / commands`;
  if (!atBottom) return 'Viewing earlier messages  Up/Down, wheel, or PageDown toward newest';
  if (active) return `Running ${compactText(active.title, 56)}  Esc interrupt`;
  if (snapshot.paused) return 'Queue paused  /resume queue to continue  / commands';
  return '? help  / commands  Up/Down history  @file mention  wheel/PageUp/PageDown scroll';
}

function inputPlaceholder(activePanel: OverlayPanel | 'none'): string {
  switch (activePanel) {
    case 'status':
      return 'status command';
    case 'tasks':
      return 'tasks command';
    case 'heartbeat':
      return 'heartbeat command';
    case 'memory':
      return 'memory command';
    case 'dream':
      return 'dream command';
    case 'buddy':
      return 'buddy command';
    case 'help':
      return 'Open a panel with /status, /tasks, /heartbeat, /memory, /dream, or /buddy';
    default:
      return 'Type a task, /command, or @file';
  }
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
        'Use @ to mention workspace files.',
      ]);
      pushSection(lines, 'help:panels', 'Panels', [
        '/status  /tasks  /heartbeat  /memory  /dream  /buddy',
        '/close closes the current panel. /resume reopens archived chats.',
      ]);
      pushSection(lines, 'help:actions', 'Panel Commands', [
        'Slash commands are entry points now.',
        'Open a panel first, then type local commands like "tick" or "file ./ops/heartbeat.md".',
      ]);
      pushSection(lines, 'help:keys', 'Keys', [
        'Up/Down or Ctrl+N/Ctrl+P move suggestions  Tab accepts',
        'Esc close panel or clear input',
        'PageUp/PageDown scroll transcript  Ctrl+C exit',
      ]);
      break;
    case 'status':
      pushSection(lines, 'status:chat', 'Chat', [
        `current: ${snapshot.currentChatTitle}`,
        `chat id: ${snapshot.currentChatId}`,
        `archived chats: ${snapshot.archivedChats.length}`,
      ]);
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
      pushSection(lines, 'status:actions', 'Panel Commands', [
        'pause  resume  newchat',
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
      const archivedBody =
        snapshot.archivedChats.length === 0
          ? ['No archived chats yet.']
          : snapshot.archivedChats.slice(0, 6).map(chat => `${chat.id}  ${compactText(chat.title, 28)}  ${chat.preview}`);
      pushSection(lines, 'tasks:archived', 'Archived Chats', archivedBody);
      pushSection(lines, 'tasks:actions', 'Panel Commands', [
        'pause  resume [chat-id|last|list|queue]  cancel <mission-id>',
      ]);
      break;
    }
    case 'heartbeat': {
      const activeHours = snapshot.heartbeatActiveHours;
      pushSection(lines, 'heartbeat:state', 'State', [
        `enabled: ${snapshot.heartbeatEnabled ? 'on' : 'off'}`,
        `interval: every ${snapshot.heartbeatIntervalMinutes}m`,
        `isolated session: ${snapshot.heartbeatUseIsolatedSession ? 'on' : 'off'}`,
        `next: ${formatClock(snapshot.heartbeats.nextTickAt)} (${relativeTimeLabel(snapshot.heartbeats.nextTickAt)})`,
        `last: ${formatClock(snapshot.heartbeats.lastTickAt)}  result: ${compactText(snapshot.heartbeats.lastResult, 90) || 'n/a'}`,
      ]);
      pushSection(lines, 'heartbeat:window', 'Active Window', [
        `start: ${activeHours?.start ?? '08:00'}`,
        `end: ${activeHours?.end ?? '23:30'}`,
        `timezone: ${activeHours?.timezone ?? 'local terminal time'}`,
      ]);
      pushSection(lines, 'heartbeat:file', 'Guide File', [
        snapshot.heartbeatGuideFilePath,
      ]);
      pushSection(lines, 'heartbeat:actions', 'Panel Commands', [
        'on  off  toggle  tick',
        'every <minutes>  start <HH:MM>  end <HH:MM>',
        'hours <HH:MM> <HH:MM>  timezone <name|clear>',
        'file <path>  isolated <on|off>',
      ]);
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
      pushSection(lines, 'memory:actions', 'Panel Commands', [
        'refresh  find <query>',
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
      pushSection(lines, 'dream:actions', 'Panel Commands', ['run  state']);
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
      pushSection(lines, 'buddy:personality', 'Personality', [buddy.personality || 'No personality recorded.']);
      pushSection(lines, 'buddy:stats', 'Stats', [sortedStats || 'No stats available.']);
      pushSection(lines, 'buddy:actions', 'Panel Commands', [
        'pet  mute  unmute  hatch <name> [personality]',
      ]);
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

function panelDisplayLines(panel: OverlayPanel, snapshot: ControllerSnapshot, width: number, maxRows: number): DisplayLine[] {
  const bodyWidth = Math.max(16, width - 4);
  const flattened: DisplayLine[] = [];

  for (const line of buildPanelLines(panel, snapshot)) {
    if (!line.text) {
      flattened.push({ key: `${line.key}:gap`, text: '', dimColor: true });
      continue;
    }

    wrapLines(line.text, bodyWidth).forEach((wrappedLine, index) => {
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

  return [...flattened.slice(0, Math.max(0, maxRows - 1)), { key: 'panel:more', text: '  ...', dimColor: true }];
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
  const backgroundColor = props.pill.active ? 'cyan' : props.pill.backgroundColor ?? 'black';
  const color = props.pill.active ? 'black' : props.pill.color ?? 'white';
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

function paletteWindow(
  matches: SuggestionOption[],
  selectedIndex: number,
  maxVisible: number,
): { items: SuggestionOption[]; start: number } {
  if (matches.length <= maxVisible) {
    return { items: matches, start: 0 };
  }

  const clampedIndex = Math.max(0, Math.min(matches.length - 1, selectedIndex));
  const half = Math.floor(maxVisible / 2);
  const maxStart = Math.max(0, matches.length - maxVisible);
  const start = Math.max(0, Math.min(maxStart, clampedIndex - half));

  return {
    items: matches.slice(start, start + maxVisible),
    start,
  };
}

function suggestionIcon(option: SuggestionOption): string {
  if (option.kind === 'file') {
    return option.description === 'directory' ? '/' : '+';
  }
  if (option.kind === 'resume') {
    return ':';
  }
  if (option.kind === 'panel') {
    return '>';
  }
  return '/';
}

function FooterSuggestions(props: {
  matches: SuggestionOption[];
  selectedIndex: number;
  width: number;
}): React.ReactNode {
  const { items: visibleMatches, start } = paletteWindow(props.matches, props.selectedIndex, 5);
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
          const selected = start + index === props.selectedIndex;
          const label = `${suggestionIcon(command)} ${command.value}`;
          const padded = `${label}${' '.repeat(Math.max(0, labelWidth - stringWidth(label)))}`;
          return (
            <Box key={command.id}>
              <Text backgroundColor={selected ? 'cyan' : 'black'} color={selected ? 'black' : 'white'}>
                {padded}
              </Text>
              <Text dimColor>{`  ${command.description}`}</Text>
            </Box>
          );
        })
      )}
      {props.matches.length > visibleMatches.length ? (
        <Text dimColor>{`Showing ${start + 1}-${start + visibleMatches.length} of ${props.matches.length}`}</Text>
      ) : null}
    </Box>
  );
}

function ArgumentHintRow(props: { text: string; width: number }): React.ReactNode {
  return (
    <Box paddingX={2}>
      <Text dimColor>{compactText(props.text, Math.max(12, props.width - 4))}</Text>
    </Box>
  );
}

function PanelView(props: { panel: OverlayPanel; snapshot: ControllerSnapshot; width: number; height: number }): React.ReactNode {
  const bodyLines = panelDisplayLines(props.panel, props.snapshot, props.width, Math.max(3, props.height - 4));

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Box paddingX={2} marginBottom={1}>
        <Text color="cyan" bold>{panelLabel(props.panel)}</Text>
      </Box>
      <Box flexDirection="column">
        {bodyLines.map(line => (
          <Text key={line.key} color={line.color} backgroundColor={line.backgroundColor} dimColor={line.dimColor} bold={line.bold}>
            {line.text || ' '}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function BottomPane(props: {
  promptLines: string[];
  suggestionsVisible: boolean;
  suggestions: SuggestionOption[];
  selectedSuggestionIndex: number;
  commandArgumentHint?: string;
  hintText: string;
  footerPills: FooterPill[];
  width: number;
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Box paddingX={2} flexDirection="column">
        {props.promptLines.map((line, index) => (
          <Box key={`prompt:${index}`}>
            <Text color={props.suggestionsVisible ? 'cyan' : 'white'}>{index === 0 ? '> ' : '  '}</Text>
            <Text>{line || ' '}</Text>
          </Box>
        ))}
      </Box>
      {props.suggestionsVisible ? (
        <FooterSuggestions
          matches={props.suggestions}
          selectedIndex={props.selectedSuggestionIndex}
          width={Math.max(12, props.width - 4)}
        />
      ) : null}
      {!props.suggestionsVisible && props.commandArgumentHint ? (
        <ArgumentHintRow text={props.commandArgumentHint} width={props.width} />
      ) : null}
      <Box paddingX={2}>
        <Text dimColor>{compactText(props.hintText, Math.max(12, props.width - 4))}</Text>
      </Box>
      <Box paddingX={2}>
        <FooterPillRow pills={props.footerPills} width={Math.max(12, props.width - 4)} />
      </Box>
    </Box>
  );
}

function ActoviqClawInkApp(props: { controller: AutonomousAssistantController }): React.ReactNode {
  const { exit } = useApp();
  const { internal_eventEmitter } = useStdin();
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  const [snapshot, setSnapshot] = useState<ControllerSnapshot>(props.controller.snapshot());
  const [input, setInput] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activePanel, setActivePanel] = useState<OverlayPanel | 'none'>('none');
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [fileSuggestions, setFileSuggestions] = useState<WorkspacePathSuggestion[]>([]);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [escapePending, setEscapePending] = useState(false);
  const [dismissedSuggestionKey, setDismissedSuggestionKey] = useState<string | null>(null);
  const exitingRef = useRef(false);
  const historyDraftRef = useRef('');
  const suppressHistoryResetRef = useRef(false);
  const escapeTimerRef = useRef<NodeJS.Timeout>();
  const scrollTopRef = useRef(0);
  const transcriptMetricsRef = useRef({ totalHeight: 0, bodyRows: 0 });
  const pendingRawInputRef = useRef<string | null>(null);
  const previousSuggestionsRef = useRef<SuggestionOption[]>([]);

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

  useEffect(() => {
    const handleRawInput = (data: string): void => {
      pendingRawInputRef.current = data;
    };

    internal_eventEmitter.on('input', handleRawInput);
    return () => {
      internal_eventEmitter.removeListener('input', handleRawInput);
    };
  }, [internal_eventEmitter]);

  useEffect(() => {
    startWorkspaceFileScan(snapshot.workspacePath);
  }, [snapshot.workspacePath]);

  const commandPaletteVisible = input.trimStart().startsWith('/');
  const mentionToken = useMemo<MentionToken | undefined>(
    () => extractMentionToken(input, cursorOffset),
    [cursorOffset, input],
  );
  const panelSuggestionMode = activePanel !== 'none' && !input.trimStart().startsWith('/') && !mentionToken;
  const commandMatches = useMemo(
    () => filterSlashCommands(input, snapshot),
    [input, snapshot],
  );
  const panelMatches = useMemo(
    () => filterPanelCommands(activePanel, input, snapshot),
    [activePanel, input, snapshot],
  );
  const mentionSuggestions = useMemo<SuggestionOption[]>(
    () =>
      fileSuggestions.map(suggestion => ({
        id: suggestion.id,
        value: suggestion.display.startsWith('@') ? suggestion.display : `@${suggestion.display}`,
        description: suggestion.description,
        kind: 'file',
        replacement: suggestion.replacement,
      })),
    [fileSuggestions],
  );
  const suggestionTriggerKey = mentionToken
    ? `mention:${mentionToken.raw}`
    : commandPaletteVisible
    ? `slash:${input}`
    : panelSuggestionMode
    ? `panel:${activePanel}:${input}`
    : undefined;
  const suggestionsDismissed = Boolean(suggestionTriggerKey && dismissedSuggestionKey === suggestionTriggerKey);
  const activeSuggestions = suggestionsDismissed
    ? []
    : mentionToken
    ? mentionSuggestions
    : commandPaletteVisible
    ? commandMatches
    : panelSuggestionMode
    ? panelMatches
    : [];
  const suggestionPaletteVisible =
    activeSuggestions.length > 0 && (Boolean(mentionToken) || commandPaletteVisible || panelSuggestionMode);
  const commandArgumentHint = !suggestionPaletteVisible
    ? commandPaletteVisible
      ? slashCommandArgumentHint(input)
      : panelCommandArgumentHint(activePanel, input)
    : undefined;
  const selectedSuggestion = activeSuggestions[selectedSuggestionIndex];
  const inlineGhostText =
    suggestionsDismissed
      ? undefined
      : mentionToken && selectedSuggestion?.kind === 'file' && selectedSuggestion.replacement
      ? selectedSuggestion.replacement.startsWith(mentionToken.raw)
        ? selectedSuggestion.replacement.slice(mentionToken.raw.length)
        : undefined
      : commandPaletteVisible &&
          selectedSuggestion &&
          selectedSuggestion.value.toLowerCase().startsWith(input.toLowerCase())
        ? selectedSuggestion.value.slice(input.length)
        : panelSuggestionMode &&
            selectedSuggestion &&
            selectedSuggestion.value.toLowerCase().startsWith(input.toLowerCase())
          ? selectedSuggestion.value.slice(input.length)
        : undefined;
  const editorColumns = Math.max(12, columns - 6);
  const promptLines = useMemo(
    () =>
      renderPromptLines({
        value: input,
        cursorOffset,
        columns: editorColumns,
        placeholder: inputPlaceholder(activePanel),
        inlineGhostText,
      }),
    [activePanel, columns, cursorOffset, editorColumns, inlineGhostText, input],
  );

  useEffect(() => {
    if (!suggestionTriggerKey) {
      if (dismissedSuggestionKey !== null) {
        setDismissedSuggestionKey(null);
      }
      return;
    }
    if (dismissedSuggestionKey && dismissedSuggestionKey !== suggestionTriggerKey) {
      setDismissedSuggestionKey(null);
    }
  }, [dismissedSuggestionKey, suggestionTriggerKey]);

  useEffect(() => {
    setSelectedSuggestionIndex(current =>
      preserveSuggestionIndex(previousSuggestionsRef.current, current, activeSuggestions),
    );
    previousSuggestionsRef.current = activeSuggestions;
  }, [activeSuggestions]);

  useEffect(() => {
    if (!mentionToken) {
      setFileSuggestions([]);
      return;
    }

    let cancelled = false;
    void getWorkspacePathSuggestions(snapshot.workspacePath, mentionToken.search)
      .then(next => {
        if (!cancelled) {
          setFileSuggestions(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFileSuggestions([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [mentionToken, snapshot.workspacePath]);

  const visibleSuggestionRows = suggestionPaletteVisible ? Math.max(1, Math.min(5, activeSuggestions.length || 1)) : 0;
  const suggestionOverflowRows =
    suggestionPaletteVisible && activeSuggestions.length > visibleSuggestionRows ? 1 : 0;
  const commandHintRows = !suggestionPaletteVisible && commandArgumentHint ? 1 : 0;
  const panelRows = activePanel === 'none' ? 0 : Math.min(12, Math.max(7, Math.floor(rows * 0.32)));
  const modalRows = panelRows;
  const showUnreadPill = unreadCount > 0;
  const bottomRows =
    Math.max(1, promptLines.length) + visibleSuggestionRows + suggestionOverflowRows + commandHintRows + 2;
  const bodyRows = Math.max(4, rows - 1 - modalRows - (showUnreadPill ? 1 : 0) - 1 - bottomRows);

  const transcriptBlocks = useMemo(() => timelineToBlocks(snapshot, Math.max(20, columns - 5)), [columns, snapshot]);
  const transcriptLayout = useTranscriptLayout(transcriptBlocks);
  const scroll = useVirtualScroll(transcriptLayout, bodyRows, scrollTop);
  const stickyPrompt = findStickyPrompt(transcriptLayout, scroll.scrollTop);
  const atBottom = scroll.scrollTop >= scroll.maxScroll;
  const footerPills = buildFooterPills(snapshot, activePanel);
  const active = activeMission(snapshot);
  const hintText = footerHint(snapshot, activePanel, suggestionPaletteVisible, atBottom, active, escapePending);

  useEffect(() => {
    scrollTopRef.current = scroll.scrollTop;
  }, [scroll.scrollTop]);

  useEffect(() => {
    const previous = transcriptMetricsRef.current;
    const previousMax = Math.max(0, previous.totalHeight - previous.bodyRows);
    const wasAtBottom = scrollTopRef.current >= previousMax;
    const growth = transcriptLayout.totalHeight - previous.totalHeight;

    if (wasAtBottom) {
      if (scrollTopRef.current !== scroll.maxScroll) {
        setScrollTop(scroll.maxScroll);
      }
      setUnreadCount(0);
    } else {
      if (scrollTopRef.current > scroll.maxScroll) {
        setScrollTop(scroll.maxScroll);
      }
      if (growth > 0) {
        setUnreadCount(current => Math.min(99, current + Math.max(1, Math.ceil(growth / 4))));
      }
    }

    transcriptMetricsRef.current = { totalHeight: transcriptLayout.totalHeight, bodyRows };
  }, [bodyRows, scroll.maxScroll, transcriptLayout.totalHeight]);

  const requestExit = (): void => {
    if (exitingRef.current) {
      return;
    }
    exitingRef.current = true;
    void props.controller.dispose().finally(() => exit());
  };

  const scrollToBottom = (): void => {
    setScrollTop(scroll.maxScroll);
    setUnreadCount(0);
  };

  const scrollBy = (delta: number): void => {
    setScrollTop(current => {
      const next = Math.max(0, Math.min(scroll.maxScroll, current + delta));
      if (next >= scroll.maxScroll) {
        setUnreadCount(0);
      }
      return next;
    });
  };

  const submitInput = (): void => {
    const trimmed = input.trim();
    const canExecuteSelectedPanelCommand =
      activePanel !== 'none' &&
      !trimmed &&
      selectedSuggestion?.kind === 'panel';

    if (!trimmed && !canExecuteSelectedPanelCommand) {
      return;
    }

    let payload = canExecuteSelectedPanelCommand ? selectedSuggestion!.value : trimmed;
    if (
      commandPaletteVisible &&
      selectedSuggestion?.kind !== 'file' &&
      selectedSuggestion &&
      selectedSuggestion.value.toLowerCase().startsWith(trimmed.toLowerCase())
    ) {
      payload = selectedSuggestion.value;
    } else if (
      mentionToken &&
      selectedSuggestion?.kind === 'file' &&
      selectedSuggestion.replacement
    ) {
      const applied = applyMentionSuggestion(input, cursorOffset, mentionToken, {
        id: selectedSuggestion.id,
        display: selectedSuggestion.value.startsWith('@')
          ? selectedSuggestion.value.slice(1)
          : selectedSuggestion.value,
        replacement: selectedSuggestion.replacement,
        description: selectedSuggestion.description === 'directory' ? 'directory' : 'file',
      });
      updateInput(applied.value, applied.cursorOffset);
      return;
    } else if (
      (commandPaletteVisible || panelSuggestionMode) &&
      selectedSuggestion?.kind !== 'file' &&
      selectedSuggestion &&
      selectedSuggestion.value.toLowerCase().startsWith(trimmed.toLowerCase())
    ) {
      payload = selectedSuggestion.value;
    }

    setInput('');
    setCursorOffset(0);
    setHistoryIndex(null);
    historyDraftRef.current = '';
    setFileSuggestions([]);
    setDismissedSuggestionKey(null);
    scrollToBottom();
    setInputHistory(current => (current[current.length - 1] === trimmed ? current : [...current, trimmed].slice(-100)));

    const panelCommand = localPanelCommand(payload);
    if (panelCommand === 'close') {
      setActivePanel('none');
      return;
    }
    if (panelCommand) {
      setActivePanel(panelCommand);
      return;
    }

    if (activePanel !== 'none' && !payload.startsWith('/')) {
      void props.controller.handlePanelInput(activePanel, payload);
      return;
    }

    setActivePanel(payload.startsWith('/') ? followupPanel(payload) ?? activePanel : 'none');
    void props.controller.handleInput(payload);
  };

  const updateInput = (value: string, nextCursorOffset = value.length): void => {
    setInput(value);
    setCursorOffset(clampCursorOffset(value, nextCursorOffset));
    if (value !== input) {
      setDismissedSuggestionKey(null);
    }
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
    if (inputHistory.length === 0) return;
    if (historyIndex === null) {
      historyDraftRef.current = input;
      restoreHistoryInput(inputHistory[inputHistory.length - 1] ?? '', inputHistory.length - 1);
      return;
    }
    const nextIndex = Math.max(0, historyIndex - 1);
    restoreHistoryInput(inputHistory[nextIndex] ?? '', nextIndex);
  };

  const navigateHistoryDown = (): void => {
    if (historyIndex === null) return;
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

  const handleEditorInput = (
    value: string,
    key: Record<string, boolean | undefined>,
    rawInput?: string,
  ): boolean => {
    const resolvedKey = withRawTerminalKeys(key, value, rawInput);
    const cursor = createInputCursor(input, cursorOffset, editorColumns);
    const isBackspaceKey = resolvedKey.backspace || value === '\b' || value === '\u007f';
    const isDeleteKey = resolvedKey.delete || value === '\u001b[3~';
    const isHomeKey = resolvedKey.home || value === '\u001b[H' || value === '\u001b[1~';
    const isEndKey = resolvedKey.end || value === '\u001b[F' || value === '\u001b[4~';
    const rawSequence = rawInput ?? value;

    if (
      rawSequence &&
      (rawSequence.includes('\b') || rawSequence.includes('\u007f')) &&
      !resolvedKey.ctrl &&
      !resolvedKey.meta &&
      !resolvedKey.tab &&
      !resolvedKey.escape &&
      !resolvedKey.return
    ) {
      const applied = applyRawInputSequence(cursor, rawSequence);
      if (applied.handled) {
        applyEditorCursor(applied.cursor);
        return true;
      }
    }

    if (resolvedKey.return) {
      if (resolvedKey.shift || resolvedKey.meta) {
        applyEditorCursor(cursor.insert('\n'));
        return true;
      }
      submitInput();
      return true;
    }
    if (isHomeKey) {
      applyEditorCursor(cursor.startOfLine());
      return true;
    }
    if (isEndKey) {
      applyEditorCursor(cursor.endOfLine());
      return true;
    }
    if (resolvedKey.leftArrow) {
      applyEditorCursor(resolvedKey.ctrl || resolvedKey.meta ? cursor.prevWord() : cursor.left());
      return true;
    }
    if (resolvedKey.rightArrow) {
      if (inlineGhostText && cursorOffset === input.length) {
        updateInput(`${input}${inlineGhostText}`, input.length + inlineGhostText.length);
        return true;
      }
      applyEditorCursor(resolvedKey.ctrl || resolvedKey.meta ? cursor.nextWord() : cursor.right());
      return true;
    }
    if (resolvedKey.upArrow) {
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
    if (resolvedKey.downArrow) {
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
    if (isBackspaceKey) {
      applyEditorCursor(resolvedKey.ctrl || resolvedKey.meta ? (cursor.deleteTokenBefore() ?? cursor.backspace()) : cursor.backspace());
      return true;
    }
    if (isDeleteKey) {
      applyEditorCursor(resolvedKey.meta ? cursor.deleteWordAfter() : cursor.del());
      return true;
    }
    if (!resolvedKey.backspace && !resolvedKey.delete) {
      const rawSequence = applyRawInputSequence(cursor, value);
      if (rawSequence.handled) {
        applyEditorCursor(rawSequence.cursor);
        return true;
      }
    }
    if (value && !resolvedKey.ctrl && !resolvedKey.meta && !resolvedKey.tab && !resolvedKey.escape) {
      let normalized = value;
      if (
        normalized.length > 1 &&
        normalized.endsWith('\r') &&
        !normalized.slice(0, -1).includes('\r') &&
        !normalized.endsWith('\\\r')
      ) {
        normalized = normalized.slice(0, -1);
      }
      normalized = normalized.replace(/\r/g, '\n');
      if (!normalized) {
        return true;
      }
      applyEditorCursor(cursor.insert(normalized));
      return true;
    }
    if (resolvedKey.ctrl) {
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
    if (resolvedKey.meta) {
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
    return false;
  };

  const applySelectedSuggestion = (): boolean => {
    if (!selectedSuggestion) {
      return false;
    }

    if (selectedSuggestion.kind === 'file' && mentionToken) {
      const commonPrefix = longestCommonPrefix(fileSuggestions.map(suggestion => suggestion.display));
      if (fileSuggestions.length > 1 && commonPrefix.length > mentionToken.search.length) {
        const replacement = formatMentionReplacement(
          commonPrefix,
          commonPrefix.endsWith('/') ? 'directory' : 'file',
          { quoted: mentionToken.quoted, complete: false },
        );
        const applied = applyMentionSuggestion(input, cursorOffset, mentionToken, {
          id: 'file:common-prefix',
          display: commonPrefix,
          replacement,
          description: commonPrefix.endsWith('/') ? 'directory' : 'file',
        });
        updateInput(applied.value, applied.cursorOffset);
        return true;
      }

      if (!selectedSuggestion.replacement) {
        return false;
      }

      const applied = applyMentionSuggestion(input, cursorOffset, mentionToken, {
        id: selectedSuggestion.id,
        display: selectedSuggestion.value.startsWith('@')
          ? selectedSuggestion.value.slice(1)
          : selectedSuggestion.value,
        replacement: selectedSuggestion.replacement,
        description: selectedSuggestion.description === 'directory' ? 'directory' : 'file',
      });
      updateInput(applied.value, applied.cursorOffset);
      return true;
    }

    updateInput(selectedSuggestion.value, selectedSuggestion.value.length);
    return true;
  };

  useInput((value, key) => {
    const rawInput = pendingRawInputRef.current ?? undefined;
    const extendedKey = withRawTerminalKeys(key as Record<string, boolean | undefined>, value, rawInput);
    pendingRawInputRef.current = null;
    if ((extendedKey.ctrl && value === 'q') || (extendedKey.ctrl && value === 'c')) {
      requestExit();
      return;
    }
    if (!input && value === '?') {
      setActivePanel('help');
      return;
    }
    if (extendedKey.wheelUp) {
      scrollBy(-3);
      return;
    }
    if (extendedKey.wheelDown) {
      scrollBy(3);
      return;
    }
    if (extendedKey.pageUp) {
      scrollBy(-Math.max(3, Math.floor(bodyRows / 2)));
      return;
    }
    if (extendedKey.pageDown) {
      scrollBy(Math.max(3, Math.floor(bodyRows / 2)));
      return;
    }
    if (!input && extendedKey.home) {
      setScrollTop(0);
      return;
    }
    if (!input && extendedKey.end) {
      scrollToBottom();
      return;
    }
    if (!commandPaletteVisible && activePanel === 'none' && !input && extendedKey.upArrow && scroll.maxScroll > 0) {
      scrollBy(-1);
      return;
    }
    if (!commandPaletteVisible && activePanel === 'none' && !input && extendedKey.downArrow && scroll.maxScroll > 0) {
      scrollBy(1);
      return;
    }
    if (
      (extendedKey.ctrl && value === 'p' && activeSuggestions.length > 0) ||
      (suggestionPaletteVisible && extendedKey.upArrow && activeSuggestions.length > 0)
    ) {
      setSelectedSuggestionIndex(current => (current - 1 + activeSuggestions.length) % activeSuggestions.length);
      return;
    }
    if (
      (extendedKey.ctrl && value === 'n' && activeSuggestions.length > 0) ||
      (suggestionPaletteVisible && extendedKey.downArrow && activeSuggestions.length > 0)
    ) {
      setSelectedSuggestionIndex(current => (current + 1) % activeSuggestions.length);
      return;
    }
    if (extendedKey.tab && suggestionPaletteVisible) {
      if (extendedKey.shift && activeSuggestions.length > 0) {
        setSelectedSuggestionIndex(current => (current - 1 + activeSuggestions.length) % activeSuggestions.length);
        return;
      }
      if (applySelectedSuggestion()) {
        return;
      }
    }
    if (extendedKey.escape && suggestionPaletteVisible) {
      setDismissedSuggestionKey(suggestionTriggerKey ?? null);
      setEscapePending(false);
      return;
    }
    if (extendedKey.escape && activePanel !== 'none' && !input) {
      setActivePanel('none');
      return;
    }
    if (extendedKey.escape && input) {
      if (!escapePending) {
        setEscapePending(true);
        if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
        escapeTimerRef.current = setTimeout(() => {
          setEscapePending(false);
          escapeTimerRef.current = undefined;
        }, 800);
        return;
      }

      setInput('');
      setCursorOffset(0);
      setEscapePending(false);
      if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
      escapeTimerRef.current = undefined;
      setHistoryIndex(null);
      historyDraftRef.current = '';
      return;
    }
    if (extendedKey.escape && active?.status === 'running') {
      void props.controller.handleInput(`/cancel ${active.id}`);
      setActivePanel('tasks');
      return;
    }
    if (handleEditorInput(value, extendedKey, rawInput)) {
      return;
    }
  });

  const modal = activePanel !== 'none' ? (
    <PanelView panel={activePanel} snapshot={snapshot} width={columns} height={panelRows} />
  ) : null;

  return (
    <FullscreenLayout
      rows={rows}
      width={columns}
      headerText={stickyPrompt}
      scrollable={<VirtualMessageList layout={transcriptLayout} scroll={scroll} height={bodyRows} width={columns} />}
      newMessagesLabel={showUnreadPill ? `${unreadCount} new message${unreadCount === 1 ? '' : 's'}` : undefined}
      modal={modal}
      bottom={
        <BottomPane
          promptLines={promptLines}
          suggestionsVisible={suggestionPaletteVisible}
          suggestions={activeSuggestions}
          selectedSuggestionIndex={selectedSuggestionIndex}
          commandArgumentHint={commandArgumentHint}
          hintText={hintText}
          footerPills={footerPills}
          width={columns}
        />
      }
    />
  );
}

export class ActoviqClawTui {
  constructor(private readonly controller: AutonomousAssistantController) {}

  async mount(): Promise<void> {
    enterAlternateScreen();
    try {
      const app = render(<ActoviqClawInkApp controller={this.controller} />, { exitOnCtrlC: false });
      await app.waitUntilExit();
    } finally {
      leaveAlternateScreen();
    }
  }
}
