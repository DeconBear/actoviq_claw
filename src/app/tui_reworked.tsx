import process from 'node:process';
import { EventEmitter } from 'node:events';

import chalk from 'chalk';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdin, useStdout } from 'ink';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

import { Cursor } from './claudecode/Cursor.js';
import { copyTextToClipboard } from './clipboard.js';
import type { AssistantLogEntry, AssistantMission, ControllerSnapshot } from './types.js';
import type { AutonomousAssistantController } from './controller.js';
import { applyRawInputSequence, parseRawMouseInput, withRawTerminalKeys } from './inputSequence.js';
import {
  clearScreenSelection,
  createScreenSelectionState,
  extractSelectedText,
  finishScreenSelection,
  hasScreenSelection,
  startScreenSelection,
  updateScreenSelection,
} from './screenSelection.js';
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
import { toolPermissionStatus } from './permissions.js';

type OverlayPanel = 'help' | 'status' | 'tasks' | 'heartbeat' | 'memory' | 'dream' | 'buddy' | 'tools' | 'permission';
type TimelineTone = 'normal' | 'success' | 'warning' | 'error' | 'muted';
type PanelTone = 'normal' | 'accent' | 'success' | 'warning' | 'error' | 'muted';

interface SlashCommandTemplate {
  value: string;
  description: string;
}

interface PanelCommandTemplate {
  value: string;
  description: string;
  applyValue?: string;
}

interface SuggestionOption {
  id: string;
  value: string;
  description: string;
  kind: 'slash' | 'resume' | 'file' | 'panel';
  applyValue?: string;
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

interface PanelRenderContext {
  tasksResumePickerActive: boolean;
  tasksResumeScope: TasksResumeScope;
  selectedResumeChat?: ControllerSnapshot['archivedChats'][number];
  heartbeatWorktimePickerActive: boolean;
}

interface FooterPill {
  id: string;
  label: string;
  backgroundColor?: string;
  color?: string;
  active?: boolean;
}

type TasksResumeScope = 'current' | 'all';

const SLASH_COMMANDS: SlashCommandTemplate[] = [
  { value: '/help', description: 'open help and usage notes' },
  { value: '/status', description: 'open runtime status and chat controls' },
  { value: '/tasks', description: 'open missions, queue, and archived chats' },
  { value: '/heartbeat', description: 'open heartbeat controls and schedule settings' },
  { value: '/memory', description: 'open memory state and memory search tools' },
  { value: '/dream', description: 'open dream state and run controls' },
  { value: '/buddy', description: 'open buddy controls' },
  { value: '/tools', description: 'open tool allowlist controls' },
  { value: '/permission', description: 'open permission preset controls' },
  { value: '/close', description: 'close the current panel' },
];

const MAX_INPUT_VISIBLE_LINES = 6;
const ASSISTANT_PREFIX = '  >';
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

function fitLine(text: string, width: number): string {
  const safeWidth = Math.max(0, width);
  if (safeWidth === 0) {
    return '';
  }

  if (stringWidth(text) <= safeWidth) {
    return `${text}${' '.repeat(Math.max(0, safeWidth - stringWidth(text)))}`;
  }

  let result = '';
  for (const character of text) {
    const next = `${result}${character}`;
    if (stringWidth(next) > safeWidth) {
      break;
    }
    result = next;
  }
  return result;
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

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return 'n/a';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'n/a';
  }
  return date.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isCurrentWorkspaceChat(chat: ControllerSnapshot['archivedChats'][number], workspacePath: string): boolean {
  return chat.workspacePath === workspacePath;
}

function isAllDayHeartbeatWindow(activeHours: ControllerSnapshot['heartbeatActiveHours']): boolean {
  return activeHours?.start === '00:00' && activeHours?.end === '24:00';
}

function tasksResumeSearch(input: string): string | undefined {
  const normalized = normalizeCommand(input);
  if (!normalized.startsWith('resume')) {
    return undefined;
  }
  const search = normalized.slice('resume'.length).trim();
  if (search === 'last' || search === 'list' || search === 'queue') {
    return undefined;
  }
  return search;
}

function heartbeatWorktimeSearch(input: string): string | undefined {
  const normalized = normalizeCommand(input);
  if (!normalized.startsWith('worktime')) {
    return undefined;
  }
  return normalized.slice('worktime'.length).trim();
}

function buildTasksResumeSuggestions(
  input: string,
  snapshot: ControllerSnapshot,
  scope: TasksResumeScope,
): SuggestionOption[] {
  const search = tasksResumeSearch(input);
  if (search === undefined) {
    return [];
  }

  const chats =
    scope === 'current'
      ? snapshot.archivedChats.filter(chat => isCurrentWorkspaceChat(chat, snapshot.workspacePath))
      : snapshot.archivedChats;

  return chats
    .filter(chat => {
      if (!search) {
        return true;
      }
      return (
        chat.id.toLowerCase().includes(search) ||
        chat.title.toLowerCase().includes(search) ||
        chat.preview.toLowerCase().includes(search) ||
        chat.workspacePath.toLowerCase().includes(search)
      );
    })
    .map(chat => ({
      id: `tasks:resume:${chat.id}`,
      value: chat.id,
      description: `${relativeTimeLabel(chat.updatedAt)} | ${formatDateTime(chat.updatedAt)} | ${chat.workspacePath}`,
      kind: 'panel' as const,
      applyValue: `resume ${chat.id}`,
    }));
}

function buildHeartbeatWorktimeSuggestions(
  input: string,
  snapshot: ControllerSnapshot,
): SuggestionOption[] {
  const search = heartbeatWorktimeSearch(input);
  if (search === undefined) {
    return [];
  }

  const options: SuggestionOption[] = [
    {
      id: 'heartbeat:worktime:24h',
      value: '24h',
      description: 'run heartbeat around the clock',
      kind: 'panel',
      applyValue: 'worktime 24h',
    },
    {
      id: 'heartbeat:worktime:hours',
      value: `hours ${snapshot.heartbeatActiveHours?.start ?? '08:00'} ${snapshot.heartbeatActiveHours?.end ?? '23:30'}`,
      description: 'set the full active time window',
      kind: 'panel',
      applyValue: `worktime hours ${snapshot.heartbeatActiveHours?.start ?? '08:00'} ${snapshot.heartbeatActiveHours?.end ?? '23:30'}`,
    },
    {
      id: 'heartbeat:worktime:start',
      value: `start ${snapshot.heartbeatActiveHours?.start ?? '08:00'}`,
      description: 'set heartbeat daily start time',
      kind: 'panel',
      applyValue: `worktime start ${snapshot.heartbeatActiveHours?.start ?? '08:00'}`,
    },
    {
      id: 'heartbeat:worktime:end',
      value: `end ${snapshot.heartbeatActiveHours?.end ?? '23:30'}`,
      description: 'set heartbeat daily end time',
      kind: 'panel',
      applyValue: `worktime end ${snapshot.heartbeatActiveHours?.end ?? '23:30'}`,
    },
    {
      id: 'heartbeat:worktime:timezone',
      value: `timezone ${snapshot.heartbeatActiveHours?.timezone ?? 'Asia/Shanghai'}`,
      description: 'set heartbeat timezone or clear it',
      kind: 'panel',
      applyValue: `worktime timezone ${snapshot.heartbeatActiveHours?.timezone ?? 'Asia/Shanghai'}`,
    },
  ];

  if (!search) {
    return options;
  }

  return options.filter(option => {
    const value = option.value.toLowerCase();
    const applyValue = option.applyValue?.toLowerCase() ?? '';
    const description = option.description.toLowerCase();
    return value.startsWith(search) || value.includes(search) || applyValue.startsWith(`worktime ${search}`) || description.includes(search);
  });
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
    case '/tools':
      return 'tools';
    case '/permission':
      return 'permission';
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
  if (normalized === '/tools' || normalized.startsWith('/tools ')) return 'tools';
  if (normalized === '/permission' || normalized.startsWith('/permission ')) return 'permission';
  if (normalized.startsWith('/cancel ')) return 'tasks';
  return undefined;
}

function filterResumeSuggestions(query: string, snapshot: ControllerSnapshot): SuggestionOption[] {
  const normalized = query.trim().toLowerCase();
  if (!/^\/resume\s+/u.test(query.toLowerCase())) {
    return [];
  }

  const search = normalized.slice('/resume'.length).trim();
  return [...snapshot.archivedChats]
    .sort((left, right) => {
      const leftCurrent = isCurrentWorkspaceChat(left, snapshot.workspacePath) ? 1 : 0;
      const rightCurrent = isCurrentWorkspaceChat(right, snapshot.workspacePath) ? 1 : 0;
      return rightCurrent - leftCurrent || right.updatedAt.localeCompare(left.updatedAt);
    })
    .filter(chat => {
      if (!search) {
        return true;
      }
      return (
        chat.id.toLowerCase().includes(search) ||
        chat.title.toLowerCase().includes(search) ||
        chat.preview.toLowerCase().includes(search) ||
        chat.workspacePath.toLowerCase().includes(search)
      );
    })
    .map(chat => ({
      id: `resume:${chat.id}`,
      value: `/resume ${chat.id}`,
      description: `${relativeTimeLabel(chat.updatedAt)} | ${formatDateTime(chat.updatedAt)} | ${chat.workspacePath}`,
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

function suggestionApplyValue(option: SuggestionOption | undefined): string | undefined {
  if (!option) {
    return undefined;
  }
  return option.applyValue ?? option.value;
}

function findSuggestionIndexByApplyValue(
  matches: readonly SuggestionOption[],
  applyValue: string | undefined,
): number {
  if (!applyValue) {
    return -1;
  }
  const normalized = applyValue.trim().toLowerCase();
  return matches.findIndex(option => suggestionApplyValue(option)?.trim().toLowerCase() === normalized);
}

function panelCommandTemplates(panel: OverlayPanel, snapshot: ControllerSnapshot): PanelCommandTemplate[] {
  switch (panel) {
    case 'status':
      return [
        { value: 'pause', description: 'pause the autonomous queue' },
        { value: 'resume', description: 'resume the autonomous queue' },
        { value: 'newchat', description: 'start a fresh chat window' },
        { value: 'sessions', description: 'list recent SDK sessions' },
        { value: 'history', description: 'show the current history storage path' },
        { value: 'history-dir ./.actoviq-claw/history', description: 'change the history storage path' },
      ];
    case 'tasks': {
      const active = activeMission(snapshot);
      return [
        { value: 'pause', description: 'pause the autonomous queue' },
        {
          value: 'resume',
          description: 'open the archived-chat picker for this workspace first; Tab shows all workspaces',
        },
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
          value: 'worktime',
          description: 'open the heartbeat worktime picker for 24h or daily hours',
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
        { value: 'show', description: 'refresh the buddy card' },
        { value: 'intro', description: 'show the buddy intro prompt' },
        { value: snapshot.buddy?.muted ? 'unmute' : 'mute', description: 'toggle buddy audio presence' },
        {
          value: `hatch ${snapshot.buddy?.buddy?.name ?? 'Mochi'} calm and observant`,
          description: 'hatch or replace the current buddy',
        },
        {
          value: `rename ${snapshot.buddy?.buddy?.name ?? 'Mochi'}`,
          description: 'rename the current buddy',
        },
        {
          value: `persona ${compactText(snapshot.buddy?.buddy?.personality ?? 'warm and observant', 32)}`,
          description: 'rewrite the buddy personality',
        },
      ];
    case 'tools':
      return [
        { value: 'show', description: 'show the current tool catalog' },
        { value: 'allow all', description: 'enable every registered tool' },
        { value: 'deny all', description: 'disable every registered tool' },
        { value: 'reset', description: 'restore the default tool allowlist' },
        ...Array.from(new Set(snapshot.availableTools.map(tool => tool.category))).map(category => ({
          value: `${category} tools`,
          applyValue: `enable category ${category}`,
          description: `enable every ${category} tool in one step`,
        })),
        ...snapshot.availableTools.map(tool => {
          const status = toolPermissionStatus(
            tool.name,
            snapshot.permissionPreset,
            snapshot.availableTools.map(item => item.name),
            snapshot.configuredAllowedTools,
          );
          const nextAction = status === 'disabled' ? `enable ${tool.name}` : `disable ${tool.name}`;
          const statusLabel =
            status === 'enabled'
              ? 'enabled'
              : status === 'blocked-by-preset'
              ? 'blocked by preset'
              : 'disabled';
          return {
            value: tool.name,
            applyValue: nextAction,
            description: `${statusLabel}  ${tool.category}  ${tool.description}`,
          };
        }),
      ];
    case 'permission':
      return [
        { value: 'chat-only', description: 'no model tools, pure chat replies only' },
        { value: 'workspace-only', description: 'only workspace file tools are effective' },
        { value: 'full-access', description: 'all enabled tools may run' },
        { value: 'show', description: 'show the current permission preset' },
      ];
    case 'help':
      return [
        { value: '/status', description: 'open runtime status and chat controls' },
        { value: '/tasks', description: 'open tasks and archived chats' },
        { value: '/heartbeat', description: 'open heartbeat controls' },
        { value: '/memory', description: 'open memory tools' },
        { value: '/dream', description: 'open dream controls' },
        { value: '/buddy', description: 'open buddy controls' },
        { value: '/tools', description: 'open tool allowlist controls' },
        { value: '/permission', description: 'open permission preset controls' },
      ];
    default:
      return [];
  }
}

function filterPanelCommands(
  panel: OverlayPanel | 'none',
  input: string,
  snapshot: ControllerSnapshot,
  tasksResumeScope: TasksResumeScope,
): SuggestionOption[] {
  if (panel === 'none') {
    return [];
  }

  if (panel === 'tasks') {
    const resumeSuggestions = buildTasksResumeSuggestions(input, snapshot, tasksResumeScope);
    if (resumeSuggestions.length > 0 || tasksResumeSearch(input) !== undefined) {
      return resumeSuggestions;
    }
  }

  if (panel === 'heartbeat') {
    const worktimeSuggestions = buildHeartbeatWorktimeSuggestions(input, snapshot);
    if (worktimeSuggestions.length > 0 || heartbeatWorktimeSearch(input) !== undefined) {
      return worktimeSuggestions;
    }
  }

  const normalized = input.trim().toLowerCase();
  return panelCommandTemplates(panel, snapshot)
    .filter(command => {
      if (!normalized) {
        return true;
      }
      const display = command.value.toLowerCase();
      const applyValue = command.applyValue?.toLowerCase() ?? '';
      const description = command.description.toLowerCase();
      return (
        display.startsWith(normalized) ||
        display.includes(normalized) ||
        applyValue.startsWith(normalized) ||
        applyValue.includes(normalized) ||
        description.includes(normalized)
      );
    })
    .map(command => ({
      id: `${panel}:${command.value}`,
      value: command.value,
      description: command.description,
      kind: 'panel' as const,
      applyValue: command.applyValue,
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
    case '/tools':
      return 'Enter to open tool allowlist controls';
    case '/permission':
      return 'Enter to open permission controls';
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

function panelCommandArgumentHint(
  panel: OverlayPanel | 'none',
  input: string,
  tasksResumeScope: TasksResumeScope,
  snapshot: ControllerSnapshot,
): string | undefined {
  if (panel === 'none') {
    return undefined;
  }

  if (panel === 'tasks') {
    const resumeSearch = tasksResumeSearch(input);
    if (resumeSearch !== undefined) {
      const currentWorkspaceCount = snapshot.archivedChats.filter(chat =>
        isCurrentWorkspaceChat(chat, snapshot.workspacePath),
      ).length;
      const totalCount = snapshot.archivedChats.length;
      return tasksResumeScope === 'current'
        ? `Current workspace IDs: ${currentWorkspaceCount}. Tab shows all IDs (${totalCount}).`
        : `All workspaces: ${totalCount} IDs. Tab returns to current workspace (${currentWorkspaceCount}).`;
    }
  }

  if (panel === 'heartbeat') {
    const worktimeSearch = heartbeatWorktimeSearch(input);
    if (worktimeSearch !== undefined) {
      return 'Heartbeat worktime: choose 24h, or set hours/start/end/timezone for the daily active window.';
    }
  }

  const normalized = normalizeCommand(input);
  switch (`${panel}:${normalized}`) {
    case 'tasks:resume':
      return 'Enter to open the archived chat picker. Tab inside the picker shows all workspaces.';
    case 'tasks:cancel':
      return 'cancel <mission-id>';
    case 'heartbeat:every':
    case 'heartbeat:interval':
      return 'every <minutes>';
    case 'heartbeat:worktime':
      return 'Enter to open the heartbeat worktime picker.';
    case 'heartbeat:start':
      return 'start <HH:MM>';
    case 'heartbeat:end':
      return 'end <HH:MM>';
    case 'heartbeat:hours':
      return 'hours <HH:MM> <HH:MM>  (24:00 allowed for all-day end)';
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
    case 'buddy:rename':
      return 'rename <name>';
    case 'buddy:persona':
      return 'persona <text>';
    case 'tools:enable':
    case 'tools:disable':
    case 'tools:toggle':
      return '<tool-name>';
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
    case 'tools':
      return 'Tools';
    case 'permission':
      return 'Permission';
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

function permissionPresetShortLabel(preset: ControllerSnapshot['permissionPreset']): string {
  switch (preset) {
    case 'chat-only':
      return 'chat';
    case 'workspace-only':
      return 'workspace';
    case 'full-access':
    default:
      return 'full';
  }
}

function buddyRarityColor(rarity: string | undefined): string {
  switch (rarity) {
    case 'legendary':
      return 'yellow';
    case 'epic':
      return 'magenta';
    case 'rare':
      return 'cyan';
    case 'uncommon':
      return 'green';
    default:
      return 'gray';
  }
}

function buddyHatGlyph(hat: string | undefined): string {
  switch (hat) {
    case 'crown':
      return '^^';
    case 'tophat':
      return '[]';
    case 'propeller':
      return '-*-';
    case 'halo':
      return '-o-';
    case 'wizard':
      return '/\\\\';
    case 'beanie':
      return '~~~';
    case 'tinyduck':
      return 'vv';
    default:
      return '';
  }
}

function buddyFace(species: string | undefined, eye: string | undefined): string {
  const e = eye ?? 'o';
  switch (species) {
    case 'duck':
    case 'goose':
      return `(${e}${e})>`;
    case 'cat':
      return `/^${e}.${e}^\\\\`;
    case 'robot':
      return `[${e}:${e}]`;
    case 'ghost':
      return `(${e}${e})~`;
    case 'turtle':
      return `(${e}_${e})`;
    case 'snail':
      return `@(${e}${e})`;
    case 'octopus':
      return `(${e}${e})vvvv`;
    case 'dragon':
      return `<${e}${e}==`;
    case 'penguin':
      return `<${e}${e}>`;
    case 'owl':
      return `(${e}v${e})`;
    case 'rabbit':
      return `(${e}${e})/`;
    default:
      return `(${e}${e})`;
  }
}

function BuddyDock(props: {
  snapshot: ControllerSnapshot;
  width: number;
  activePanel: OverlayPanel | 'none';
}): React.ReactNode {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!props.snapshot.buddyReactionAt) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [props.snapshot.buddyReactionAt]);

  const buddy = props.snapshot.buddy?.buddy;
  if (!buddy) {
    return props.activePanel === 'buddy' ? (
      <Box paddingX={2}>
        <Text dimColor>{compactText('No buddy yet. Open /buddy and run hatch <name> [personality].', Math.max(16, props.width - 4))}</Text>
      </Box>
    ) : null;
  }

  const reactionFresh =
    typeof props.snapshot.buddyReactionAt === 'number' &&
    now - props.snapshot.buddyReactionAt < 12_000;
  const bubbleSource =
    (reactionFresh ? props.snapshot.buddyReactionText : undefined) ??
    (props.activePanel === 'buddy'
      ? props.snapshot.buddyIntroText || buddy.personality
      : undefined);
  const bubbleText = compactText(bubbleSource, Math.max(18, Math.min(56, props.width - 18)));
  const hat = buddyHatGlyph(buddy.hat);
  const face = buddyFace(buddy.species, buddy.eye);
  const label = `${buddy.name} the ${buddy.species}`;
  const color = buddyRarityColor(buddy.rarity);

  return (
    <Box flexDirection="column" paddingX={2} marginBottom={1}>
      {bubbleText ? (
        <Box justifyContent="flex-end">
          <Text dimColor italic>{`"${bubbleText}"`}</Text>
        </Box>
      ) : null}
      <Box justifyContent="flex-end">
        <Text color={color}>{hat ? `${hat} ` : ''}{face}</Text>
        <Text color={color} bold>{`  ${label}`}</Text>
        <Text dimColor>{buddy.shiny ? '  shiny' : ''}</Text>
      </Box>
    </Box>
  );
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
    id: 'permission',
    label: permissionPresetShortLabel(snapshot.permissionPreset),
    backgroundColor:
      snapshot.permissionPreset === 'full-access'
        ? 'red'
        : snapshot.permissionPreset === 'workspace-only'
        ? 'yellow'
        : 'gray',
    color: snapshot.permissionPreset === 'chat-only' ? 'white' : 'black',
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
  tasksResumeScope: TasksResumeScope,
  tasksResumePickerActive: boolean,
  heartbeatWorktimePickerActive: boolean,
  atBottom: boolean,
  active: AssistantMission | undefined,
  escapePending: boolean,
): string {
  if (escapePending) return 'Esc again to clear';
  if (suggestionsVisible) {
    if (activePanel !== 'none') {
      if (activePanel === 'tasks' && tasksResumePickerActive) {
        return tasksResumeScope === 'current'
          ? 'Up/Down move  Enter resume  Tab show all IDs  wheel/PageUp/PageDown scroll content  Esc dismiss'
          : 'Up/Down move  Enter resume  Tab current workspace only  wheel/PageUp/PageDown scroll content  Esc dismiss';
      }
      if (activePanel === 'heartbeat' && heartbeatWorktimePickerActive) {
        return 'Up/Down move  Enter apply  Tab insert  wheel/PageUp/PageDown scroll content  Esc dismiss';
      }
      return 'Up/Down move  Enter run  Tab insert  wheel/PageUp/PageDown scroll content  Esc dismiss';
    }
    return 'Up/Down move  Tab accept  Esc dismiss';
  }
  if (activePanel !== 'none') return `${panelLabel(activePanel)} open  Enter panel command  wheel/PageUp/PageDown scroll content  Esc close`;
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
    case 'tools':
      return 'filter tools or type a tools command';
    case 'permission':
      return 'filter presets or type a permission command';
    case 'help':
      return 'Open a panel with /status, /tasks, /heartbeat, /memory, /dream, /buddy, /tools, or /permission';
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

function buildPanelLines(
  panel: OverlayPanel,
  snapshot: ControllerSnapshot,
  context: PanelRenderContext,
): PanelLine[] {
  const lines: PanelLine[] = [];
  const queued = formatMissionCount(snapshot, 'queued');
  const running = formatMissionCount(snapshot, 'running');
  const completed = formatMissionCount(snapshot, 'completed');
  const failed = formatMissionCount(snapshot, 'failed');
  const active = activeMission(snapshot);

  switch (panel) {
    case 'help': {
      const currentToolList = snapshot.effectiveAllowedTools.join(', ') || 'none';
      const availableToolCategories =
        Array.from(new Set(snapshot.availableTools.map(tool => tool.category))).join(', ') || 'none';
      pushSection(lines, 'help:start', 'Quick Start', [
        'Type plain text and press Enter to queue a mission.',
        'Type / to open the command entry palette.',
        'Type @ to mention workspace files or paths.',
        'Use Shift+Enter to insert a newline without sending.',
      ]);
      pushSection(lines, 'help:mode', 'Current Runtime', [
        `workspace: ${snapshot.workspacePath}`,
        `model: ${snapshot.detectedModel ?? 'unknown'}`,
        `permission preset: ${snapshot.permissionPreset}`,
        `configured tools: ${snapshot.configuredAllowedTools.length}/${snapshot.availableTools.length}`,
        `effective tools: ${currentToolList}`,
      ]);
      pushSection(lines, 'help:panels', 'Panels And Jobs', [
        '/status      inspect runtime, queue state, model, and the current chat',
        '/tasks       inspect missions, background jobs, archived chats, and resume targets',
        '/heartbeat   configure unattended checks, schedule, active hours, and guide file',
        '/memory      inspect surfaced memories, session summary, and memory manifest',
        '/dream       inspect consolidation state and trigger a dream run',
        '/buddy       inspect and control the companion persona and reactions',
        '/tools       inspect every registered tool and toggle allowlist entries',
        '/permission  switch between chat-only, workspace-only, and full-access',
      ]);
      pushSection(lines, 'help:panel-usage', 'How Panel Commands Work', [
        'Slash commands are entry points now. Open a panel first, then run local commands inside it.',
        'Use Up/Down to select a quick action, Enter to apply it, or Tab to insert it into the prompt for editing.',
        'Mouse wheel, PageUp/PageDown, Home, and End scroll the panel body or transcript. They do not select quick actions.',
        'Use /close or Esc on an empty prompt to close the current panel.',
      ]);
      pushSection(lines, 'help:history', 'Chat History', [
        'Every chat already has a stable chat id such as chat_abcd1234_xyz987.',
        'Chats are persisted individually by id in the history directory so they can be resumed later.',
        'Use /tasks, choose resume, and then pick a chat id. The picker shows current-workspace ids first.',
        'Use /status and run history or history-dir <path> to inspect or change where chat history is stored.',
      ]);
      pushSection(lines, 'help:tools', 'Tools And Permissions', [
        `available categories: ${availableToolCategories}`,
        'The /tools panel shows everything currently registered in the SDK runtime, including computer-use and future MCP tools.',
        'The /permission preset sets the broad safety envelope. The /tools allowlist chooses the exact tools inside that envelope.',
        'Effective tools are always the intersection of the permission preset and the tool allowlist.',
        'Computer-use tools are registered by default so they appear in /tools, but they are not in the default allowlist until you enable them.',
      ]);
      pushSection(lines, 'help:automation', 'Autonomy Features', [
        'Heartbeat runs unattended operational checks on a schedule and follows HEARTBEAT.md if present.',
        'Memory extracts durable context after runs and surfaces relevant project facts back into future turns.',
        'Dream handles longer-cycle consolidation when enough sessions or time have accumulated.',
        'Buddy is the companion layer: persona, reactions, intro text, mute state, and presence in the dock.',
      ]);
      pushSection(lines, 'help:examples', 'Useful Examples', [
        'plain task: audit this repo and list the top 5 release risks',
        '@ mention: summarize @README.md and compare it with @src/app/controller.ts',
        '/heartbeat then: tick  |  every 30  |  worktime -> 24h',
        '/tools then: show  |  enable category computer  |  disable Task',
        '/permission then: workspace-only  |  full-access',
        '/tasks then: resume  |  Tab all workspaces  |  cancel <mission-id>',
      ]);
      pushSection(lines, 'help:keys', 'Keyboard Reference', [
        'Up/Down moves suggestions when a suggestion list is open, browses history when the prompt has text, and scrolls chat when the prompt is empty.',
        'Ctrl+N / Ctrl+P also move the current suggestion list.',
        'Tab accepts the selected suggestion. Shift+Tab moves backward inside the suggestion list.',
        'Esc dismisses suggestions first, then closes the active panel, then clears the prompt on a second press.',
        'Ctrl+C or Ctrl+Q exits the TUI.',
      ]);
      pushSection(lines, 'help:recovery', 'Recovery And Session Flow', [
        'Every launch opens a fresh chat window.',
        'Use /resume <chat-id> directly, or open /tasks and enter the resume picker to choose a chat id.',
        'If a mission is running, Esc from an empty prompt interrupts the active mission.',
        'If the queue is paused, use /status or /tasks and run resume.',
      ]);
      break;
    }
    case 'status':
      pushSection(lines, 'status:chat', 'Chat', [
        `current: ${snapshot.currentChatTitle}`,
        `chat id: ${snapshot.currentChatId}`,
        `archived chats: ${snapshot.archivedChats.length}`,
        `history dir: ${snapshot.historyDir}`,
      ]);
      pushSection(lines, 'status:runtime', 'Runtime', [
        `workspace: ${snapshot.workspacePath}`,
        `model: ${snapshot.detectedModel ?? 'unknown'}`,
        `permission: ${snapshot.permissionPreset} (${snapshot.permissionMode})`,
        `effective tools: ${snapshot.effectiveAllowedTools.length}/${snapshot.availableTools.length}`,
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
        'pause  resume  newchat  sessions  history  history-dir <path>',
      ]);
      break;
    case 'tasks': {
      const currentWorkspaceChats = snapshot.archivedChats.filter(chat =>
        isCurrentWorkspaceChat(chat, snapshot.workspacePath),
      );
      const visibleResumeChats =
        context.tasksResumeScope === 'current'
          ? currentWorkspaceChats
          : snapshot.archivedChats;
      if (context.tasksResumePickerActive) {
        pushSection(lines, 'tasks:resume-picker', 'Resume Picker', [
          `scope: ${context.tasksResumeScope === 'current' ? 'current workspace only' : 'all workspaces'}`,
          `showing: ${visibleResumeChats.length} ids`,
          'Tab toggles between current-workspace ids and all-workspace ids.',
        ]);
      }
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
        currentWorkspaceChats.length === 0
          ? [
              'No archived chats for this workspace yet.',
              'Use resume, then press Tab to browse all workspaces.',
            ]
          : currentWorkspaceChats.slice(0, 6).map(
              chat =>
                `${chat.id}  ${relativeTimeLabel(chat.updatedAt)}  ${compactPath(chat.workspacePath)}  ${compactText(chat.title, 24)}`,
            );
      pushSection(lines, 'tasks:archived', 'Archived Chats', archivedBody);
      pushSection(lines, 'tasks:actions', 'Panel Commands', [
        'pause  resume  cancel <mission-id>',
      ]);
      break;
    }
    case 'heartbeat': {
      const activeHours = snapshot.heartbeatActiveHours;
      const allDayHeartbeat = isAllDayHeartbeatWindow(activeHours);
      if (context.heartbeatWorktimePickerActive) {
        pushSection(lines, 'heartbeat:worktime-picker', 'Worktime Picker', [
          `current: ${allDayHeartbeat ? 'all day (24h)' : `${activeHours?.start ?? '08:00'} -> ${activeHours?.end ?? '23:30'}`}`,
          'Choose 24h, or set hours/start/end for the daily active window.',
        ]);
        break;
      }
      pushSection(lines, 'heartbeat:state', 'State', [
        `enabled: ${snapshot.heartbeatEnabled ? 'on' : 'off'}`,
        `interval: every ${snapshot.heartbeatIntervalMinutes}m`,
        `isolated session: ${snapshot.heartbeatUseIsolatedSession ? 'on' : 'off'}`,
        `next: ${formatClock(snapshot.heartbeats.nextTickAt)} (${relativeTimeLabel(snapshot.heartbeats.nextTickAt)})`,
        `last: ${formatClock(snapshot.heartbeats.lastTickAt)}  result: ${compactText(snapshot.heartbeats.lastResult, 90) || 'n/a'}`,
      ]);
      pushSection(lines, 'heartbeat:window', 'Active Window', [
        `window: ${allDayHeartbeat ? 'all day (24h)' : `${activeHours?.start ?? '08:00'} -> ${activeHours?.end ?? '23:30'}`}`,
        `timezone: ${activeHours?.timezone ?? 'local terminal time'}`,
      ]);
      pushSection(lines, 'heartbeat:file', 'Guide File', [
        snapshot.heartbeatGuideFilePath,
      ]);
      pushSection(lines, 'heartbeat:actions', 'Panel Commands', [
        'on  off  toggle  tick',
        'every <minutes>  worktime',
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
        pushSection(lines, 'buddy:actions', 'Panel Commands', [
          'show  pet  intro  mute  unmute  rename <name>  persona <text>  hatch <name> [personality]',
        ]);
        break;
      }

      const sortedStats = Object.entries(buddy.stats)
        .sort((left, right) => right[1] - left[1])
        .map(([name, value]) => `${name.toLowerCase()} ${value}`)
        .join('  ');

      pushSection(lines, 'buddy:sprite', 'Companion', [
        `${buddyHatGlyph(buddy.hat) ? `${buddyHatGlyph(buddy.hat)} ` : ''}${buddyFace(buddy.species, buddy.eye)}  ${buddy.name}`,
      ]);
      pushSection(lines, 'buddy:identity', 'Buddy', [
        `name: ${buddy.name}`,
        `species: ${buddy.species}`,
        `hat: ${buddy.hat}  eye: ${buddy.eye}`,
        `rarity: ${buddy.rarity}${buddy.shiny ? '  shiny' : ''}`,
        `muted: ${snapshot.buddy?.muted ? 'yes' : 'no'}`,
      ]);
      pushSection(lines, 'buddy:personality', 'Personality', [buddy.personality || 'No personality recorded.']);
      pushSection(lines, 'buddy:stats', 'Stats', [sortedStats || 'No stats available.']);
      pushSection(lines, 'buddy:intro', 'Prompt Context', [
        snapshot.buddyIntroText || 'No buddy intro available yet.',
      ]);
      if (snapshot.buddyReactionText) {
        pushSection(lines, 'buddy:reaction', 'Latest Reaction', [snapshot.buddyReactionText]);
      }
      pushSection(lines, 'buddy:actions', 'Panel Commands', [
        'show  pet  intro  mute  unmute  rename <name>  persona <text>  hatch <name> [personality]',
      ]);
      break;
    }
    case 'tools': {
      const nameWidth = Math.max(8, ...snapshot.availableTools.map(tool => tool.name.length));
      const categoryWidth = Math.max(8, ...snapshot.availableTools.map(tool => tool.category.length));
      const categorySummary =
        snapshot.availableTools.length === 0
          ? ['No tool categories yet.']
          : Array.from(new Set(snapshot.availableTools.map(tool => tool.category))).map(category => {
              const tools = snapshot.availableTools.filter(tool => tool.category === category);
              const configuredCount = tools.filter(tool => snapshot.configuredAllowedTools.includes(tool.name)).length;
              const effectiveCount = tools.filter(tool => snapshot.effectiveAllowedTools.includes(tool.name)).length;
              return `${category.padEnd(categoryWidth)} configured ${String(configuredCount).padStart(2)}/${tools.length}  effective ${String(effectiveCount).padStart(2)}/${tools.length}`;
            });
      pushSection(lines, 'tools:state', 'State', [
        `configured tools: ${snapshot.configuredAllowedTools.length}/${snapshot.availableTools.length}`,
        `effective tools: ${snapshot.effectiveAllowedTools.length}/${snapshot.availableTools.length}`,
        `permission preset: ${snapshot.permissionPreset}`,
      ]);
      pushSection(lines, 'tools:categories', 'Categories', categorySummary);
      const toolLines =
        snapshot.availableTools.length === 0
          ? ['No tools are registered.']
          : snapshot.availableTools.map(tool => {
              const enabled = snapshot.effectiveAllowedTools.includes(tool.name);
              const configured = snapshot.configuredAllowedTools.includes(tool.name);
              const status = enabled ? 'enabled' : configured ? 'blocked-by-preset' : 'disabled';
              return `${tool.name.padEnd(nameWidth)} ${status.padEnd(17)} ${tool.category.padEnd(categoryWidth)} ${tool.description}`;
            });
      pushSection(lines, 'tools:list', 'Tools', toolLines);
      pushSection(lines, 'tools:actions', 'Panel Commands', [
        'Use the quick action list below to toggle individual tools.',
        'Global actions: show  allow all  deny all  reset  enable category <name>  disable category <name>',
      ]);
      break;
    }
    case 'permission': {
      pushSection(lines, 'permission:state', 'Current', [
        `preset: ${snapshot.permissionPreset}`,
        `runtime mode: ${snapshot.permissionMode}`,
        `effective tools: ${snapshot.effectiveAllowedTools.join(', ') || 'none'}`,
      ]);
      pushSection(lines, 'permission:options', 'Presets', [
        `chat-only      no model tools, plain chat replies only${snapshot.permissionPreset === 'chat-only' ? '  active' : ''}`,
        `workspace-only only workspace file tools are effective${snapshot.permissionPreset === 'workspace-only' ? '  active' : ''}`,
        `full-access    all enabled tools may run${snapshot.permissionPreset === 'full-access' ? '  active' : ''}`,
      ]);
      pushSection(lines, 'permission:actions', 'Panel Commands', [
        'Use the quick action list below to switch presets.',
        'Optional commands: chat-only  workspace-only  full-access  show',
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

function panelDisplayLines(
  panel: OverlayPanel,
  snapshot: ControllerSnapshot,
  width: number,
  maxRows: number,
  context: PanelRenderContext,
): DisplayLine[] {
  const bodyWidth = Math.max(15, width - 5);
  const flattened: DisplayLine[] = [];

  for (const line of buildPanelLines(panel, snapshot, context)) {
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

  if (maxRows === Number.POSITIVE_INFINITY || flattened.length <= maxRows) {
    return flattened;
  }

  return [...flattened.slice(0, Math.max(0, maxRows - 1)), { key: 'panel:more', text: '  ...', dimColor: true }];
}

function buildPanelScrollbar(totalHeight: number, viewportHeight: number, scrollTop: number): string[] {
  if (viewportHeight <= 0) {
    return [];
  }
  if (totalHeight <= viewportHeight) {
    return Array.from({ length: viewportHeight }, () => ' ');
  }

  const maxScroll = Math.max(1, totalHeight - viewportHeight);
  const handleSize = Math.max(1, Math.round((viewportHeight * viewportHeight) / totalHeight));
  const maxHandleStart = Math.max(0, viewportHeight - handleSize);
  const handleStart = Math.round((scrollTop / maxScroll) * maxHandleStart);

  return Array.from({ length: viewportHeight }, (_, row) =>
    row >= handleStart && row < handleStart + handleSize ? '#' : '|',
  );
}

function visibleTranscriptPlainLines(
  layout: ReturnType<typeof useTranscriptLayout>,
  scroll: ReturnType<typeof useVirtualScroll>,
  height: number,
  width: number,
): string[] {
  const [start, end] = scroll.range;
  const pool: DisplayLine[] = [];

  for (let index = start; index < end; index += 1) {
    pool.push(...(layout.blocks[index]?.lines ?? []));
  }

  const windowed = pool.slice(scroll.localOffset, scroll.localOffset + height);
  while (windowed.length < height) {
    windowed.push({ key: `plain:blank:${windowed.length}`, text: '' });
  }

  const contentWidth = Math.max(4, width - 1);
  return windowed.map(line =>
    line.prefixText
      ? `${line.prefixText}${fitLine(line.text || ' ', Math.max(0, contentWidth - stringWidth(line.prefixText)))}`
      : fitLine(line.text || ' ', contentWidth),
  );
}

function panelQuickActionVisibleCount(
  panel: OverlayPanel,
  detailLines?: string[],
): number {
  if (panel === 'tasks' && detailLines && detailLines.length > 0) {
    return 5;
  }
  return detailLines && detailLines.length > 0 ? 4 : 7;
}

function panelQuickActionReservedRows(props: {
  panel: OverlayPanel;
  width: number;
  matches: SuggestionOption[];
  detailLines?: string[];
}): number {
  if (props.matches.length === 0) {
    return 4;
  }

  const contentWidth = Math.max(20, props.width - 4);
  const visibleCount = Math.min(
    props.matches.length,
    panelQuickActionVisibleCount(props.panel, props.detailLines),
  );
  const detailWrappedRows =
    props.detailLines?.reduce(
      (sum, line) => sum + wrapLines(line, contentWidth).length,
      0,
    ) ?? 0;
  const detailSectionRows = detailWrappedRows > 0 ? detailWrappedRows + 1 : 0;
  const overflowRows = props.matches.length > visibleCount ? 1 : 0;

  // PanelView spends 3 rows on top chrome (padding, title, spacing) and
  // Quick Actions itself needs 2 rows of chrome (top margin + header row)
  // before details/items start rendering.
  return 5 + detailSectionRows + visibleCount + overflowRows;
}

function panelMinimumBodyRows(
  panel: OverlayPanel,
  context: PanelRenderContext,
): number {
  if (panel === 'tasks' && context.tasksResumePickerActive) {
    return 2;
  }
  if (panel === 'heartbeat' && context.heartbeatWorktimePickerActive) {
    return 2;
  }
  return 3;
}

function plainPanelQuickActionLines(props: {
  panel: OverlayPanel;
  matches: SuggestionOption[];
  selectedIndex: number;
  width: number;
  hint?: string;
  detailLines?: string[];
}): string[] {
  if (props.matches.length === 0) {
    return [];
  }

  const maxVisible = panelQuickActionVisibleCount(props.panel, props.detailLines);
  const clampedIndex =
    props.matches.length === 0 ? 0 : Math.max(0, Math.min(props.selectedIndex, props.matches.length - 1));
  const { items: visibleMatches, start } = paletteWindow(props.matches, clampedIndex, maxVisible);
  const selectedId = props.matches[clampedIndex]?.id ?? visibleMatches[0]?.id;
  const contentWidth = Math.max(20, props.width - 4);
  const markerWidth = 1;
  const labelWidth = Math.max(18, Math.min(Math.floor(contentWidth * 0.4), contentWidth - 10));
  const detailWidth = Math.max(0, contentWidth - markerWidth - labelWidth);

  const lines = [
    fitLine(`  Quick Actions  ${props.hint ?? 'Up/Down select  Enter apply  Tab insert'}`, contentWidth),
  ];

  if (props.detailLines) {
    for (const detail of props.detailLines) {
      for (const wrapped of wrapLines(detail, contentWidth)) {
        lines.push(fitLine(wrapped, contentWidth));
      }
    }
  }

  for (const option of visibleMatches) {
    const selected = option.id === selectedId;
    const labelText = fitLine(` ${compactText(option.value, Math.max(8, labelWidth - 1))}`, labelWidth);
    const detailText = detailWidth > 0
      ? fitLine(` ${compactText(option.description, Math.max(8, detailWidth - 1))}`, detailWidth)
      : '';
    lines.push(`${selected ? '>' : ' '}${labelText}${detailText}`);
  }

  if (props.matches.length > visibleMatches.length) {
    lines.push(fitLine(`Showing ${start + 1}-${start + visibleMatches.length} of ${props.matches.length}`, contentWidth));
  }

  return lines;
}

function visiblePanelPlainLines(props: {
  panel: OverlayPanel;
  snapshot: ControllerSnapshot;
  width: number;
  height: number;
  scrollTop: number;
  panelContext: PanelRenderContext;
  panelSuggestionsVisible: boolean;
  suggestions: SuggestionOption[];
  selectedSuggestionIndex: number;
  suggestionsHint?: string;
  suggestionDetailLines?: string[];
}): string[] {
  const reservedRows = props.panelSuggestionsVisible
    ? panelQuickActionReservedRows({
        panel: props.panel,
        width: props.width,
        matches: props.suggestions,
        detailLines: props.suggestionDetailLines,
      })
    : 4;
  const bodyHeight = Math.max(panelMinimumBodyRows(props.panel, props.panelContext), props.height - reservedRows);
  const bodyLines = panelDisplayLines(
    props.panel,
    props.snapshot,
    props.width,
    Number.POSITIVE_INFINITY,
    props.panelContext,
  );
  const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
  const clampedScrollTop = Math.max(0, Math.min(maxScroll, props.scrollTop));
  const visibleBodyLines = bodyLines.slice(clampedScrollTop, clampedScrollTop + bodyHeight);
  while (visibleBodyLines.length < bodyHeight) {
    visibleBodyLines.push({ key: `panel:plain:blank:${visibleBodyLines.length}`, text: '' });
  }

  const lines = [''];
  lines.push(`  ${panelLabel(props.panel)}`);
  lines.push('');
  lines.push(...visibleBodyLines.map(line => fitLine(line.text || ' ', Math.max(15, props.width - 5))));

  if (props.panelSuggestionsVisible) {
    lines.push(
      ...plainPanelQuickActionLines({
        panel: props.panel,
        matches: props.suggestions,
        selectedIndex: props.selectedSuggestionIndex,
        width: props.width,
        hint: props.suggestionsHint,
        detailLines: props.suggestionDetailLines,
      }),
    );
  }

  return lines;
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
  const clampedIndex =
    props.matches.length === 0 ? 0 : Math.max(0, Math.min(props.selectedIndex, props.matches.length - 1));
  const { items: visibleMatches, start } = paletteWindow(props.matches, clampedIndex, 5);
  const rowWidth = Math.max(12, props.width - 4);
  const labelWidth = Math.min(
    Math.max(...visibleMatches.map(command => stringWidth(command.value)), 0) + 2,
    Math.max(18, Math.floor(props.width * 0.45)),
  );
  const detailWidth = Math.max(0, rowWidth - labelWidth);

  return (
    <Box flexDirection="column" paddingX={2}>
      {visibleMatches.length === 0 ? (
        <Text dimColor>No matching command.</Text>
      ) : (
        visibleMatches.map((command, index) => {
          const selected = start + index === clampedIndex;
          const label = `${suggestionIcon(command)} ${command.value}`;
          const padded = fitLine(label, labelWidth);
          return (
            <Box key={command.id}>
              <Text backgroundColor={selected ? 'cyan' : 'black'} color={selected ? 'black' : 'white'}>
                {padded}
              </Text>
              <Text dimColor>{fitLine(`  ${command.description}`, detailWidth)}</Text>
            </Box>
          );
        })
      )}
      {props.matches.length > visibleMatches.length ? (
        <Text dimColor>{fitLine(`Showing ${start + 1}-${start + visibleMatches.length} of ${props.matches.length}`, rowWidth)}</Text>
      ) : null}
    </Box>
  );
}

function PanelQuickActions(props: {
  panel: OverlayPanel;
  snapshot: ControllerSnapshot;
  matches: SuggestionOption[];
  selectedIndex: number;
  width: number;
  hint?: string;
  detailLines?: string[];
}): React.ReactNode {
  const maxVisible = panelQuickActionVisibleCount(props.panel, props.detailLines);
  const clampedIndex =
    props.matches.length === 0 ? 0 : Math.max(0, Math.min(props.selectedIndex, props.matches.length - 1));
  const { items: visibleMatches, start } = paletteWindow(props.matches, clampedIndex, maxVisible);

  if (visibleMatches.length === 0) {
    return null;
  }

  const contentWidth = Math.max(20, props.width - 4);
  const markerWidth = 1;
  const labelWidth = Math.max(18, Math.min(Math.floor(contentWidth * 0.4), contentWidth - 10));
  const detailWidth = Math.max(0, contentWidth - markerWidth - labelWidth);
  const selectedId = props.matches[clampedIndex]?.id ?? visibleMatches[0]?.id;
  const rows = visibleMatches.map(option => {
    const selected = option.id === selectedId;
    let label = option.value;
    let detail = option.description;
    let accent: string | undefined = selected ? 'cyan' : undefined;
    let dim = !selected;

    if (props.panel === 'permission') {
      const active = (option.applyValue ?? option.value) === props.snapshot.permissionPreset;
      label = active ? `${option.value}  active` : option.value;
      accent = active ? 'green' : accent;
      dim = !(selected || active);
    }

    if (props.panel === 'tools') {
      const toolName = option.value.trim();
      const tool = props.snapshot.availableTools.find(item => item.name === toolName);
      const effective = props.snapshot.effectiveAllowedTools.includes(toolName);
      const configured = props.snapshot.configuredAllowedTools.includes(toolName);
      if (tool) {
        const badge = effective ? '[x]' : configured ? '[!]' : '[ ]';
        label = `${badge} ${toolName}`;
        accent = effective ? 'green' : configured ? 'yellow' : accent;
        dim = !(selected || effective || configured);
        detail = `${option.description}  Enter: ${option.applyValue ?? option.value}`;
      }
    }

    const labelText = fitLine(` ${compactText(label, Math.max(8, labelWidth - 1))}`, labelWidth);
    const detailText = fitLine(` ${compactText(detail, Math.max(8, detailWidth - 1))}`, detailWidth);

    return (
      <Box key={option.id} paddingX={2}>
        <Text color={accent} backgroundColor={selected ? 'cyan' : undefined} dimColor={selected ? false : dim} bold={selected}>
          {selected ? '>' : ' '}
        </Text>
        <Text
          color={selected ? 'black' : accent}
          backgroundColor={selected ? 'cyan' : undefined}
          dimColor={selected ? false : dim}
          bold={selected}
        >
          {labelText}
        </Text>
        {detailWidth > 0 ? <Text dimColor={!selected}>{detailText}</Text> : null}
      </Box>
    );
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingX={2}>
        <Text color="cyan" bold>Quick Actions</Text>
        <Text dimColor>
          {fitLine(props.hint ?? '  Up/Down select  Enter apply  Tab insert', Math.max(0, contentWidth - 13))}
        </Text>
      </Box>
      {props.detailLines && props.detailLines.length > 0 ? (
        <Box flexDirection="column" paddingX={2} marginTop={1}>
          {props.detailLines.flatMap((line, lineIndex) =>
            wrapLines(line, contentWidth).map((wrappedLine, wrapIndex) => (
              <Text key={`detail:${lineIndex}:${wrapIndex}`} dimColor={lineIndex > 0} color={lineIndex === 0 ? 'cyan' : undefined}>
                {fitLine(wrappedLine, contentWidth)}
              </Text>
            )),
          )}
        </Box>
      ) : null}
      {rows}
      {props.matches.length > visibleMatches.length ? (
        <Box paddingX={2}>
          <Text dimColor>{fitLine(`Showing ${start + 1}-${start + visibleMatches.length} of ${props.matches.length}`, contentWidth)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function ArgumentHintRow(props: { text: string; width: number }): React.ReactNode {
  return (
    <Box paddingX={2}>
      <Text dimColor>{fitLine(compactText(props.text, Math.max(12, props.width - 4)), Math.max(12, props.width - 4))}</Text>
    </Box>
  );
}

function PanelView(props: {
  panel: OverlayPanel;
  snapshot: ControllerSnapshot;
  width: number;
  height: number;
  scrollTop: number;
  panelContext: PanelRenderContext;
  panelSuggestionsVisible: boolean;
  suggestions: SuggestionOption[];
  selectedSuggestionIndex: number;
  suggestionsHint?: string;
  suggestionDetailLines?: string[];
}): React.ReactNode {
  const reservedRows = props.panelSuggestionsVisible
    ? panelQuickActionReservedRows({
        panel: props.panel,
        width: props.width,
        matches: props.suggestions,
        detailLines: props.suggestionDetailLines,
      })
    : 4;
  const bodyHeight = Math.max(panelMinimumBodyRows(props.panel, props.panelContext), props.height - reservedRows);
  const bodyLines = panelDisplayLines(
    props.panel,
    props.snapshot,
    props.width,
    Number.POSITIVE_INFINITY,
    props.panelContext,
  );
  const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
  const clampedScrollTop = Math.max(0, Math.min(maxScroll, props.scrollTop));
  const visibleBodyLines = bodyLines.slice(clampedScrollTop, clampedScrollTop + bodyHeight);
  while (visibleBodyLines.length < bodyHeight) {
    visibleBodyLines.push({
      key: `panel:blank:${visibleBodyLines.length}`,
      text: '',
      dimColor: true,
    });
  }
  const scrollbar = buildPanelScrollbar(bodyLines.length, bodyHeight, clampedScrollTop);

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Box paddingX={2} marginBottom={1}>
        <Text color="cyan" bold>{panelLabel(props.panel)}</Text>
      </Box>
      <Box flexDirection="column">
        {visibleBodyLines.map((line, index) => (
          <Box key={line.key}>
            <Text color={line.color} backgroundColor={line.backgroundColor} dimColor={line.dimColor} bold={line.bold}>
              {fitLine(line.text || ' ', Math.max(15, props.width - 5))}
            </Text>
            <Text dimColor={scrollbar[index] !== '#'} color={scrollbar[index] === '#' ? 'cyan' : 'gray'}>
              {scrollbar[index] ?? ' '}
            </Text>
          </Box>
        ))}
      </Box>
      {props.panelSuggestionsVisible ? (
        <PanelQuickActions
          panel={props.panel}
          snapshot={props.snapshot}
          matches={props.suggestions}
          selectedIndex={props.selectedSuggestionIndex}
          width={props.width}
          hint={props.suggestionsHint}
          detailLines={props.suggestionDetailLines}
        />
      ) : null}
    </Box>
  );
}

function BottomPane(props: {
  snapshot: ControllerSnapshot;
  activePanel: OverlayPanel | 'none';
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
      <BuddyDock snapshot={props.snapshot} width={props.width} activePanel={props.activePanel} />
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
  const [panelScrollTop, setPanelScrollTop] = useState(0);
  const [tasksResumeScope, setTasksResumeScope] = useState<TasksResumeScope>('current');
  const [unreadCount, setUnreadCount] = useState(0);
  const [activePanel, setActivePanel] = useState<OverlayPanel | 'none'>('none');
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [fileSuggestions, setFileSuggestions] = useState<WorkspacePathSuggestion[]>([]);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [escapePending, setEscapePending] = useState(false);
  const [dismissedSuggestionKey, setDismissedSuggestionKey] = useState<string | null>(null);
  const [selectionActive, setSelectionActive] = useState(false);
  const exitingRef = useRef(false);
  const historyDraftRef = useRef('');
  const suppressHistoryResetRef = useRef(false);
  const escapeTimerRef = useRef<NodeJS.Timeout>();
  const scrollTopRef = useRef(0);
  const transcriptMetricsRef = useRef({ totalHeight: 0, bodyRows: 0 });
  const pendingRawInputRef = useRef<string | null>(null);
  const pendingWheelDeltaRef = useRef(0);
  const previousSuggestionsRef = useRef<SuggestionOption[]>([]);
  const selectionRef = useRef(createScreenSelectionState());

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
      const mouseInput = parseRawMouseInput(data);
      if (mouseInput.wheelUp) {
        pendingWheelDeltaRef.current -= 3;
        return;
      }
      if (mouseInput.wheelDown) {
        pendingWheelDeltaRef.current += 3;
        return;
      }
      if (typeof mouseInput.col === 'number' && typeof mouseInput.row === 'number') {
        const point = { col: Math.max(0, mouseInput.col), row: Math.max(0, mouseInput.row) };
        if (mouseInput.leftDown) {
          startScreenSelection(selectionRef.current, point);
          syncMouseSelection();
          return;
        }
        if (mouseInput.leftDrag) {
          updateScreenSelection(selectionRef.current, point);
          syncMouseSelection();
          return;
        }
        if (mouseInput.leftUp) {
          updateScreenSelection(selectionRef.current, point);
          finishScreenSelection(selectionRef.current);
          syncMouseSelection();
          return;
        }
      }
      pendingRawInputRef.current = data;
    };

    internal_eventEmitter.on('input', handleRawInput);
    return () => {
      internal_eventEmitter.removeListener('input', handleRawInput);
    };
  }, [internal_eventEmitter, syncMouseSelection]);

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
  const tasksResumePickerActive = activePanel === 'tasks' && tasksResumeSearch(input) !== undefined;
  const heartbeatWorktimePickerActive =
    activePanel === 'heartbeat' && heartbeatWorktimeSearch(input) !== undefined;
  const panelMatches = useMemo(
    () => filterPanelCommands(activePanel, input, snapshot, tasksResumeScope),
    [activePanel, input, snapshot, tasksResumeScope],
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
  const undisposedSuggestions = mentionToken
    ? mentionSuggestions
    : commandPaletteVisible
    ? commandMatches
    : panelSuggestionMode
    ? panelMatches
    : [];
  const activeSuggestions = suggestionsDismissed ? [] : undisposedSuggestions;
  const suggestionPaletteVisible =
    activeSuggestions.length > 0 && (Boolean(mentionToken) || commandPaletteVisible || panelSuggestionMode);
  const panelSuggestionsVisible = panelSuggestionMode && activeSuggestions.length > 0;
  const footerSuggestionsVisible = suggestionPaletteVisible && !panelSuggestionsVisible;
  const commandArgumentHint = !suggestionPaletteVisible
    ? commandPaletteVisible
      ? slashCommandArgumentHint(input)
      : panelCommandArgumentHint(activePanel, input, tasksResumeScope, snapshot)
    : undefined;
  const requestedResumeChatId =
    activePanel === 'tasks' && tasksResumePickerActive ? tasksResumeSearch(input)?.trim() || undefined : undefined;
  const requestedHeartbeatWorktimeValue =
    activePanel === 'heartbeat' && heartbeatWorktimePickerActive
      ? heartbeatWorktimeSearch(input)?.trim() || undefined
      : undefined;
  const preferredPanelSuggestionValue = requestedResumeChatId
    ? `resume ${requestedResumeChatId}`
    : requestedHeartbeatWorktimeValue
    ? `worktime ${requestedHeartbeatWorktimeValue}`
    : undefined;
  const preferredPanelSuggestionIndex = findSuggestionIndexByApplyValue(activeSuggestions, preferredPanelSuggestionValue);
  const clampedSelectedSuggestionIndex =
    activeSuggestions.length === 0 ? 0 : Math.max(0, Math.min(selectedSuggestionIndex, activeSuggestions.length - 1));
  const effectiveSelectedSuggestionIndex =
    preferredPanelSuggestionIndex >= 0 ? preferredPanelSuggestionIndex : clampedSelectedSuggestionIndex;
  const selectedSuggestion = activeSuggestions[effectiveSelectedSuggestionIndex];
  const selectedResumeChat = useMemo(() => {
    if (!(activePanel === 'tasks' && tasksResumePickerActive)) {
      return undefined;
    }
    const exactChat = requestedResumeChatId
      ? snapshot.archivedChats.find(chat => chat.id.toLowerCase() === requestedResumeChatId.toLowerCase())
      : undefined;
    if (exactChat) {
      return exactChat;
    }
    const selected = activeSuggestions[effectiveSelectedSuggestionIndex];
    const applyValue = suggestionApplyValue(selected);
    if (!applyValue?.startsWith('resume ')) {
      return undefined;
    }
    const chatId = applyValue.slice('resume '.length).trim();
    return snapshot.archivedChats.find(chat => chat.id === chatId);
  }, [
    activePanel,
    activeSuggestions,
    effectiveSelectedSuggestionIndex,
    requestedResumeChatId,
    snapshot.archivedChats,
    tasksResumePickerActive,
  ]);
  const panelContext = useMemo<PanelRenderContext>(
    () => ({
      tasksResumePickerActive,
      tasksResumeScope,
      selectedResumeChat,
      heartbeatWorktimePickerActive,
    }),
    [heartbeatWorktimePickerActive, selectedResumeChat, tasksResumePickerActive, tasksResumeScope],
  );
  const inlineGhostText =
    suggestionsDismissed
      ? undefined
      : mentionToken && selectedSuggestion?.kind === 'file' && selectedSuggestion.replacement
      ? selectedSuggestion.replacement.startsWith(mentionToken.raw)
        ? selectedSuggestion.replacement.slice(mentionToken.raw.length)
        : undefined
      : commandPaletteVisible &&
          selectedSuggestion &&
          suggestionApplyValue(selectedSuggestion)?.toLowerCase().startsWith(input.toLowerCase())
        ? suggestionApplyValue(selectedSuggestion)!.slice(input.length)
        : panelSuggestionMode &&
            selectedSuggestion &&
            input.trim() &&
            suggestionApplyValue(selectedSuggestion)?.toLowerCase().startsWith(input.toLowerCase())
          ? suggestionApplyValue(selectedSuggestion)!.slice(input.length)
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
    if (selectedSuggestionIndex !== effectiveSelectedSuggestionIndex) {
      setSelectedSuggestionIndex(effectiveSelectedSuggestionIndex);
    }
  }, [effectiveSelectedSuggestionIndex, selectedSuggestionIndex]);

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

  const visibleSuggestionRows = footerSuggestionsVisible ? Math.max(1, Math.min(5, activeSuggestions.length || 1)) : 0;
  const suggestionOverflowRows =
    footerSuggestionsVisible && activeSuggestions.length > visibleSuggestionRows ? 1 : 0;
  const commandHintRows = !footerSuggestionsVisible && commandArgumentHint ? 1 : 0;
  const tasksResumePanelActive = activePanel === 'tasks' && tasksResumePickerActive;
  const heartbeatWorktimePanelActive = activePanel === 'heartbeat' && heartbeatWorktimePickerActive;
  const tallPanel =
    activePanel === 'tools' ||
    activePanel === 'permission' ||
    activePanel === 'buddy' ||
    tasksResumePanelActive ||
    heartbeatWorktimePanelActive;
  const panelRows =
    activePanel === 'none'
      ? 0
      : tasksResumePanelActive
      ? Math.min(20, Math.max(13, Math.floor(rows * 0.5)))
      : heartbeatWorktimePanelActive
      ? Math.min(18, Math.max(12, Math.floor(rows * 0.44)))
      : tallPanel
      ? Math.min(18, Math.max(10, Math.floor(rows * 0.42)))
      : Math.min(12, Math.max(7, Math.floor(rows * 0.32)));
  const panelReservedRows = panelSuggestionsVisible
    ? panelQuickActionReservedRows({
        panel: activePanel,
        width: columns,
        matches: activeSuggestions,
        detailLines:
          tasksResumePanelActive && selectedResumeChat
            ? [
                `Workspace: ${selectedResumeChat.workspacePath}`,
                `Created: ${formatDateTime(selectedResumeChat.createdAt)} (${relativeTimeLabel(selectedResumeChat.createdAt)})`,
                `Updated: ${formatDateTime(selectedResumeChat.updatedAt)} (${relativeTimeLabel(selectedResumeChat.updatedAt)})`,
              ]
            : undefined,
      })
    : 4;
  const panelBodyRows =
    activePanel === 'none'
      ? 0
      : Math.max(panelMinimumBodyRows(activePanel, panelContext), panelRows - panelReservedRows);
  const panelLines = useMemo(
    () =>
      activePanel === 'none'
        ? []
        : panelDisplayLines(activePanel, snapshot, columns, Number.POSITIVE_INFINITY, panelContext),
    [activePanel, columns, panelContext, snapshot],
  );
  const panelMaxScroll =
    activePanel === 'none' ? 0 : Math.max(0, panelLines.length - panelBodyRows);
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
  const hintText = footerHint(
    snapshot,
    activePanel,
    suggestionPaletteVisible,
    tasksResumeScope,
    tasksResumePickerActive,
    heartbeatWorktimePickerActive,
    atBottom,
    active,
    escapePending,
  );
  const panelSuggestionsHint =
    activePanel === 'tasks' && tasksResumePickerActive
      ? tasksResumeScope === 'current'
        ? '  Up/Down select  Enter resume  Tab show all IDs'
        : '  Up/Down select  Enter resume  Tab current workspace only'
      : activePanel === 'heartbeat' && heartbeatWorktimePickerActive
      ? '  Up/Down select  Enter apply  Tab insert'
      : undefined;
  const panelSuggestionDetailLines =
    activePanel === 'tasks' && tasksResumePickerActive && selectedResumeChat
      ? [
          `Workspace: ${selectedResumeChat.workspacePath}`,
          `Created: ${formatDateTime(selectedResumeChat.createdAt)} (${relativeTimeLabel(selectedResumeChat.createdAt)})`,
          `Updated: ${formatDateTime(selectedResumeChat.updatedAt)} (${relativeTimeLabel(selectedResumeChat.updatedAt)})`,
        ]
      : undefined;
  const visibleScreenTextLines = useMemo(() => {
    const lines: string[] = [];
    lines.push(stickyPrompt ? `  ${stickyPrompt}` : '');
    lines.push(...visibleTranscriptPlainLines(transcriptLayout, scroll, bodyRows, columns));
    if (showUnreadPill) {
      lines.push(` ${unreadCount} new messages `);
    }
    if (activePanel !== 'none') {
      lines.push(
        ...visiblePanelPlainLines({
          panel: activePanel,
          snapshot,
          width: columns,
          height: panelRows,
          scrollTop: panelScrollTop,
          panelContext,
          panelSuggestionsVisible,
          suggestions: activeSuggestions,
          selectedSuggestionIndex: effectiveSelectedSuggestionIndex,
          suggestionsHint: panelSuggestionsHint,
          suggestionDetailLines: panelSuggestionDetailLines,
        }),
      );
    }
    lines.push('-'.repeat(Math.max(12, columns)));
    return lines.map(line => fitLine(line, Math.max(1, columns)));
  }, [
    activePanel,
    activeSuggestions,
    bodyRows,
    columns,
    effectiveSelectedSuggestionIndex,
    panelContext,
    panelRows,
    panelScrollTop,
    panelSuggestionDetailLines,
    panelSuggestionsHint,
    panelSuggestionsVisible,
    scroll,
    showUnreadPill,
    snapshot,
    stickyPrompt,
    transcriptLayout,
    unreadCount,
  ]);

  useEffect(() => {
    scrollTopRef.current = scroll.scrollTop;
  }, [scroll.scrollTop]);

  useEffect(() => {
    if (activePanel === 'none') {
      if (panelScrollTop !== 0) {
        setPanelScrollTop(0);
      }
      return;
    }
    if (panelScrollTop > panelMaxScroll) {
      setPanelScrollTop(panelMaxScroll);
    }
  }, [activePanel, panelMaxScroll, panelScrollTop]);

  useEffect(() => {
    if (!tasksResumePickerActive && tasksResumeScope !== 'current') {
      setTasksResumeScope('current');
    }
  }, [tasksResumePickerActive, tasksResumeScope]);

  useEffect(() => {
    if (panelScrollTop !== 0) {
      setPanelScrollTop(0);
    }
  }, [activePanel, heartbeatWorktimePickerActive, tasksResumePickerActive]);

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

  const scrollPanelBy = (delta: number): void => {
    setPanelScrollTop(current => Math.max(0, Math.min(panelMaxScroll, current + delta)));
  };

  function clearMouseSelection(): void {
    clearScreenSelection(selectionRef.current);
    if (selectionActive) {
      setSelectionActive(false);
    }
  }

  function syncMouseSelection(): void {
    setSelectionActive(hasScreenSelection(selectionRef.current));
  }

  function copyCurrentSelection(): void {
    const text = extractSelectedText(visibleScreenTextLines, selectionRef.current);
    if (!text) {
      return;
    }
    void copyTextToClipboard(text);
  }

  const dismissSuggestionsForContentScroll = (): void => {
    if (panelSuggestionMode) {
      return;
    }
    if (suggestionTriggerKey) {
      setDismissedSuggestionKey(suggestionTriggerKey);
    }
  };

  const submitInput = (): void => {
    const trimmed = input.trim();
    const canExecuteSelectedPanelCommand =
      activePanel !== 'none' &&
      !trimmed &&
      selectedSuggestion?.kind === 'panel';

    const selectedSuggestionApplyValue = suggestionApplyValue(selectedSuggestion);
    const shouldOpenTasksResumePicker =
      activePanel === 'tasks' &&
      canExecuteSelectedPanelCommand &&
      selectedSuggestionApplyValue === 'resume';
    const shouldOpenHeartbeatWorktimePicker =
      activePanel === 'heartbeat' &&
      canExecuteSelectedPanelCommand &&
      selectedSuggestionApplyValue === 'worktime';

    if (!trimmed && !canExecuteSelectedPanelCommand) {
      return;
    }

    if (shouldOpenTasksResumePicker) {
      setTasksResumeScope('current');
      updateInput('resume ', 'resume '.length);
      return;
    }

    if (shouldOpenHeartbeatWorktimePicker) {
      updateInput('worktime ', 'worktime '.length);
      return;
    }

    if (activePanel === 'tasks' && tasksResumePickerActive && trimmed === 'resume' && activeSuggestions.length === 0) {
      return;
    }

    let payload = canExecuteSelectedPanelCommand ? selectedSuggestionApplyValue ?? selectedSuggestion!.value : trimmed;
    if (
      activePanel === 'tasks' &&
      tasksResumePickerActive &&
      selectedSuggestion?.kind === 'panel' &&
      selectedSuggestionApplyValue?.startsWith('resume ')
    ) {
      payload = selectedSuggestionApplyValue;
    } else if (
      commandPaletteVisible &&
      selectedSuggestion?.kind !== 'file' &&
      selectedSuggestion &&
      selectedSuggestionApplyValue?.toLowerCase().startsWith(trimmed.toLowerCase())
    ) {
      payload = selectedSuggestionApplyValue!;
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
      selectedSuggestionApplyValue?.toLowerCase().startsWith(trimmed.toLowerCase())
    ) {
      payload = selectedSuggestionApplyValue!;
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
      setDismissedSuggestionKey(`panel:${activePanel}:`);
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

    const nextValue = suggestionApplyValue(selectedSuggestion) ?? selectedSuggestion.value;
    updateInput(nextValue, nextValue.length);
    return true;
  };

  useInput((value, key) => {
    const rawInput = pendingRawInputRef.current ?? undefined;
    const extendedKey = withRawTerminalKeys(key as Record<string, boolean | undefined>, value, rawInput);
    pendingRawInputRef.current = null;
    const pendingWheelDelta = pendingWheelDeltaRef.current;
    pendingWheelDeltaRef.current = 0;
    if (extendedKey.ctrl && value === 'q') {
      requestExit();
      return;
    }
    if (extendedKey.ctrl && value === 'c') {
      if (selectionActive) {
        copyCurrentSelection();
        return;
      }
      requestExit();
      return;
    }
    if (extendedKey.escape && selectionActive) {
      clearMouseSelection();
      return;
    }
    if (selectionActive) {
      clearMouseSelection();
    }
    if (!input && value === '?') {
      setActivePanel('help');
      return;
    }
    if (pendingWheelDelta !== 0) {
      dismissSuggestionsForContentScroll();
      if (activePanel !== 'none' && panelMaxScroll > 0) {
        scrollPanelBy(pendingWheelDelta);
      } else {
        scrollBy(pendingWheelDelta);
      }
      return;
    }
    if (extendedKey.wheelUp) {
      dismissSuggestionsForContentScroll();
      if (activePanel !== 'none' && panelMaxScroll > 0) {
        scrollPanelBy(-3);
      } else {
        scrollBy(-3);
      }
      return;
    }
    if (extendedKey.wheelDown) {
      dismissSuggestionsForContentScroll();
      if (activePanel !== 'none' && panelMaxScroll > 0) {
        scrollPanelBy(3);
      } else {
        scrollBy(3);
      }
      return;
    }
    if (extendedKey.pageUp) {
      dismissSuggestionsForContentScroll();
      if (activePanel !== 'none' && !input) {
        scrollPanelBy(-Math.max(3, Math.floor(panelBodyRows / 2)));
      } else {
        scrollBy(-Math.max(3, Math.floor(bodyRows / 2)));
      }
      return;
    }
    if (extendedKey.pageDown) {
      dismissSuggestionsForContentScroll();
      if (activePanel !== 'none' && !input) {
        scrollPanelBy(Math.max(3, Math.floor(panelBodyRows / 2)));
      } else {
        scrollBy(Math.max(3, Math.floor(bodyRows / 2)));
      }
      return;
    }
    if (!input && extendedKey.home) {
      if (activePanel !== 'none') {
        setPanelScrollTop(0);
      } else {
        setScrollTop(0);
      }
      return;
    }
    if (!input && extendedKey.end) {
      if (activePanel !== 'none') {
        setPanelScrollTop(panelMaxScroll);
      } else {
        scrollToBottom();
      }
      return;
    }
    if (
      suggestionsDismissed &&
      suggestionTriggerKey &&
      undisposedSuggestions.length > 0 &&
      ((extendedKey.ctrl && value === 'p') ||
        (extendedKey.ctrl && value === 'n') ||
        extendedKey.upArrow ||
        extendedKey.downArrow)
    ) {
      setDismissedSuggestionKey(null);
      setSelectedSuggestionIndex(
        (extendedKey.ctrl && value === 'p') || extendedKey.upArrow
          ? Math.max(0, undisposedSuggestions.length - 1)
          : 0,
      );
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
    if (extendedKey.tab && activePanel === 'tasks' && tasksResumePickerActive) {
      setTasksResumeScope(current => (current === 'current' ? 'all' : 'current'));
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
    <PanelView
      panel={activePanel}
      snapshot={snapshot}
      width={columns}
      height={panelRows}
      scrollTop={panelScrollTop}
      panelContext={panelContext}
      panelSuggestionsVisible={panelSuggestionsVisible}
      suggestions={activeSuggestions}
      selectedSuggestionIndex={effectiveSelectedSuggestionIndex}
      suggestionsHint={panelSuggestionsHint}
      suggestionDetailLines={panelSuggestionDetailLines}
    />
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
          snapshot={snapshot}
          activePanel={activePanel}
          promptLines={promptLines}
          suggestionsVisible={footerSuggestionsVisible}
          suggestions={activeSuggestions}
          selectedSuggestionIndex={effectiveSelectedSuggestionIndex}
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
