import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  type ActoviqAgentClient,
  type ActoviqBackgroundTaskRecord,
  type ActoviqBuddyState,
  type ActoviqCleanToolMetadata,
  type ActoviqDreamState,
  type ActoviqPermissionRule,
  type AgentEvent,
  type AgentSession,
  createAgentSdk,
} from 'actoviq-agent-sdk';

import {
  buildDefaultComputerUseOptions,
  buildDefaultMcpServers,
  buildDefaultTools,
  buildNamedAgents,
  DEFAULT_SYSTEM_PROMPT,
} from './defaults.js';
import { parseCommand, tokenizeCommand } from './commandParser.js';
import {
  computeNextHeartbeatAt,
  isWithinActiveHours,
  normalizeHeartbeatResponse,
} from './heartbeat.js';
import {
  buildPermissionRules,
  canonicalizeAllowedTools,
  computeEffectiveAllowedTools,
  defaultAllowedTools,
  normalizePermissionPreset,
  permissionPresetLabel,
  permissionPresetToMode,
} from './permissions.js';
import {
  ensureDirectory,
  ensureHeartbeatTemplate,
  ensureRuntimeConfig,
  loadOrCreateAppConfig,
  loadOrCreateState,
  saveAppConfig,
  saveState,
} from './persistence.js';
import type {
  AssistantAppConfig,
  AssistantArchivedChat,
  AssistantChatSummary,
  AssistantLogEntry,
  AssistantMission,
  AssistantPersistedState,
  ControllerSnapshot,
  MemoryPanelState,
  RuntimeBootstrapInfo,
} from './types.js';

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isValidClockValue(value: string): boolean {
  const match = value.match(/^(\d{2}):(\d{2})$/u);
  if (!match) {
    return false;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function trimPreview(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/u)[0] ?? 'Untitled mission';
  return trimPreview(firstLine, 72) || 'Untitled mission';
}

function titleFromChat(chat: Pick<AssistantArchivedChat, 'title' | 'missions' | 'logs' | 'createdAt'>): string {
  if (chat.title.trim()) {
    return chat.title;
  }
  const firstMission = [...chat.missions].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
  if (firstMission?.title?.trim()) {
    return firstMission.title;
  }
  const createdAt = new Date(chat.createdAt);
  if (!Number.isNaN(createdAt.getTime())) {
    return `Chat ${createdAt.toLocaleString()}`;
  }
  return 'Chat';
}

function chatPreview(chat: Pick<AssistantArchivedChat, 'missions' | 'logs'>): string {
  const latestMission = [...chat.missions]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (latestMission?.resultText?.trim()) {
    return trimPreview(latestMission.resultText, 72);
  }
  if (latestMission?.prompt?.trim()) {
    return trimPreview(latestMission.prompt, 72);
  }
  const latestLog = [...chat.logs].sort((left, right) => right.at.localeCompare(left.at))[0];
  return trimPreview(latestLog?.text ?? 'No messages yet.', 72);
}

function formatBackgroundTask(task: ActoviqBackgroundTaskRecord): string {
  const suffix = task.text ? ` | ${trimPreview(task.text, 90)}` : '';
  return `${task.status} ${task.subagentType}: ${trimPreview(task.description, 70)}${suffix}`;
}

export class AutonomousAssistantController extends EventEmitter {
  private config!: AssistantAppConfig;
  private runtimeInfo!: RuntimeBootstrapInfo;
  private sdk!: ActoviqAgentClient;
  private state!: AssistantPersistedState;
  private saveTimer?: NodeJS.Timeout;
  private heartbeatPollTimer?: NodeJS.Timeout;
  private backgroundPollTimer?: NodeJS.Timeout;
  private busy = false;
  private heartbeatBusy = false;
  private disposed = false;
  private activeAbortController?: AbortController;
  private liveOutput = '';
  private activeMissionId?: string;
  private buddy?: ActoviqBuddyState;
  private dream?: ActoviqDreamState;
  private memoryPanel: MemoryPanelState = {
    manifestPreview: '',
    sessionMemoryPreview: '',
    relevantMemories: [],
  };
  private toolMetadata: ActoviqCleanToolMetadata[] = [];
  private backgroundTasks: ActoviqBackgroundTaskRecord[] = [];
  private backgroundStatusIndex = new Map<string, string>();
  private buddyReactionText?: string;
  private buddyReactionAt?: number;
  private buddyIntroText?: string;

  constructor(private readonly rootDir: string) {
    super();
  }

  async initialize(): Promise<void> {
    this.config = await loadOrCreateAppConfig(this.rootDir);
    this.config.autonomy.permissionPreset = normalizePermissionPreset(
      this.config.autonomy.permissionPreset,
      'full-access',
    );
    this.config.autonomy.permissionMode = this.runtimePermissionMode();
    await ensureDirectory(this.config.stateDir);
    await ensureDirectory(`${this.config.stateDir}/sessions`);
    await ensureHeartbeatTemplate(this.config.heartbeat.guideFilePath);
    this.runtimeInfo = await ensureRuntimeConfig(this.config.runtimeConfigPath);
    this.state = await loadOrCreateState(this.config.stateDir);
    this.startFreshChatWindow();
    await saveState(this.config.stateDir, this.state);

    this.sdk = await createAgentSdk({
      workDir: this.config.workspacePath,
      sessionDirectory: `${this.config.stateDir}/sessions`,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      tools: buildDefaultTools(this.config.workspacePath),
      mcpServers: buildDefaultMcpServers(this.config),
      computerUse: buildDefaultComputerUseOptions(this.config),
      permissionMode: this.runtimePermissionMode(),
      agents: buildNamedAgents(),
    });

    await this.refreshToolCatalog();
    await this.sdk.memory.updateSettings({
      autoCompactEnabled: true,
      autoMemoryEnabled: true,
      autoDreamEnabled: this.config.autonomy.autoDream,
    });

    await this.ensureBuddy();
    await this.refreshRuntimePanels();
    this.scheduleHeartbeat(true);
    this.heartbeatPollTimer = setInterval(() => {
      void this.maybeRunHeartbeat();
    }, 5_000);
    this.backgroundPollTimer = setInterval(() => {
      void this.pollBackgroundTasks();
    }, 3_000);

    this.log('success', 'system', 'Actoviq Claw is ready. Submit a mission or use /help.');

    if (this.config.autonomy.autoRun) {
      void this.processQueue();
    } else {
      this.emitUpdated();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.heartbeatPollTimer) {
      clearInterval(this.heartbeatPollTimer);
    }
    if (this.backgroundPollTimer) {
      clearInterval(this.backgroundPollTimer);
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    await this.persistNow();
    if (this.sdk) {
      await this.sdk.close();
    }
  }

  private summarizeChats(): AssistantChatSummary[] {
    return this.state.chats.map(chat => ({
      id: chat.id,
      title: titleFromChat(chat),
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      archivedAt: chat.archivedAt,
      missionCount: chat.missions.length,
      preview: chatPreview(chat),
    }));
  }

  private startFreshChatWindow(): void {
    this.archiveCurrentChatIfNeeded();
    this.state.currentChatId = createId('chat');
    this.state.currentChatCreatedAt = nowIso();
    this.state.currentChatTitle = `Chat ${new Date(this.state.currentChatCreatedAt).toLocaleString()}`;
    this.state.currentChatRestoredFromId = undefined;
    this.state.missions = [];
    this.state.logs = [];
    this.busy = false;
    this.liveOutput = '';
    this.activeMissionId = undefined;
  }

  private archiveCurrentChatIfNeeded(): void {
    if (this.state.missions.length === 0 && this.state.logs.length === 0) {
      return;
    }

    const latestMissionAt = this.state.missions.reduce(
      (latest, mission) => (mission.updatedAt > latest ? mission.updatedAt : latest),
      this.state.currentChatCreatedAt,
    );
    const latestLogAt = this.state.logs.reduce(
      (latest, entry) => (entry.at > latest ? entry.at : latest),
      latestMissionAt,
    );

    const chat: AssistantArchivedChat = {
      id: this.state.currentChatId,
      title: this.state.currentChatTitle,
      createdAt: this.state.currentChatCreatedAt,
      updatedAt: latestLogAt,
      archivedAt: nowIso(),
      missions: this.state.missions.map(mission => ({ ...mission })),
      logs: this.state.logs.map(entry => ({ ...entry })),
    };

    this.state.chats = [chat, ...this.state.chats.filter(existing => existing.id !== chat.id)].slice(0, 50);
  }

  private findArchivedChat(query: string | undefined): AssistantArchivedChat | undefined {
    if (this.state.chats.length === 0) {
      return undefined;
    }
    if (!query || !query.trim()) {
      return this.state.chats[0];
    }

    const normalized = query.trim().toLowerCase();
    return this.state.chats.find(chat => {
      const title = titleFromChat(chat).toLowerCase();
      return chat.id.toLowerCase() === normalized || title.includes(normalized);
    });
  }

  private restoreArchivedChat(chat: AssistantArchivedChat): void {
    this.archiveCurrentChatIfNeeded();
    this.state.chats = this.state.chats.filter(entry => entry.id !== chat.id);
    this.state.currentChatId = chat.id;
    this.state.currentChatTitle = titleFromChat(chat);
    this.state.currentChatCreatedAt = chat.createdAt;
    this.state.currentChatRestoredFromId = chat.id;
    this.state.missions = chat.missions.map(mission => {
      if (mission.status === 'running') {
        return {
          ...mission,
          status: 'queued',
          startedAt: undefined,
          completedAt: undefined,
          updatedAt: nowIso(),
          error: mission.error ?? 'Restored from a previous chat window.',
        };
      }
      return { ...mission };
    });
    this.state.logs = chat.logs.map(entry => ({ ...entry }));
    this.busy = false;
    this.liveOutput = '';
    this.activeMissionId = undefined;
  }

  private async handleResumeCommand(args: string[]): Promise<void> {
    const subject = (args[0] ?? '').trim();

    if (!subject || subject.toLowerCase() === 'last') {
      const chat = this.findArchivedChat(undefined);
      if (!chat) {
        this.log('info', 'system', 'No archived chats are available to resume.');
        return;
      }
      this.restoreArchivedChat(chat);
      this.log('success', 'system', `Resumed chat ${chat.id}: ${titleFromChat(chat)}`);
      this.scheduleSave();
      if (this.config.autonomy.autoRun) {
        void this.processQueue();
      }
      return;
    }

    if (subject.toLowerCase() === 'list') {
      const chats = this.summarizeChats();
      this.log(
        'info',
        'system',
        chats.length === 0
          ? 'No archived chats are available.'
          : chats
              .slice(0, 12)
              .map(chat => `${chat.id} | ${chat.title} | ${chat.missionCount} missions | ${chat.preview}`)
              .join('\n'),
      );
      return;
    }

    if (subject.toLowerCase() === 'queue') {
      this.state.paused = false;
      this.log('success', 'system', 'Autonomous queue resumed.');
      this.scheduleSave();
      void this.processQueue();
      return;
    }

    const chat = this.findArchivedChat(subject);
    if (!chat) {
      this.log('warn', 'system', `No archived chat matched "${subject}". Use /resume list first.`);
      return;
    }

    this.restoreArchivedChat(chat);
    this.log('success', 'system', `Resumed chat ${chat.id}: ${titleFromChat(chat)}`);
    this.scheduleSave();
    if (this.config.autonomy.autoRun) {
      void this.processQueue();
    }
  }

  private availableToolNames(): string[] {
    if (this.toolMetadata.length > 0) {
      return this.toolMetadata.map(tool => tool.name);
    }
    return defaultAllowedTools();
  }

  private configuredAllowedToolNames(): string[] {
    const available = this.availableToolNames();
    return canonicalizeAllowedTools(available, this.config.autonomy.allowedTools);
  }

  private effectiveAllowedToolNames(): string[] {
    const available = this.availableToolNames();
    return computeEffectiveAllowedTools(
      this.config.autonomy.permissionPreset,
      available,
      this.config.autonomy.allowedTools,
    );
  }

  private runtimePermissionMode() {
    return permissionPresetToMode(this.config.autonomy.permissionPreset);
  }

  private runtimePermissionRules(): ActoviqPermissionRule[] {
    return buildPermissionRules(this.availableToolNames(), this.effectiveAllowedToolNames());
  }

  private runtimePermissionOptions(): {
    permissionMode: ReturnType<typeof permissionPresetToMode>;
    permissions?: ActoviqPermissionRule[];
  } {
    const permissions = this.runtimePermissionRules();
    return permissions.length > 0
      ? {
          permissionMode: this.runtimePermissionMode(),
          permissions,
        }
      : {
          permissionMode: this.runtimePermissionMode(),
        };
  }

  private resolveToolName(input: string | undefined): string | undefined {
    const trimmed = input?.trim();
    if (!trimmed) {
      return undefined;
    }

    const available = this.availableToolNames();
    const exact = available.find(toolName => toolName.toLowerCase() === trimmed.toLowerCase());
    if (exact) {
      return exact;
    }

    const prefixMatches = available.filter(toolName =>
      toolName.toLowerCase().startsWith(trimmed.toLowerCase()),
    );
    return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
  }

  private setBuddyReaction(text: string | undefined): void {
    const normalized = text?.trim();
    if (!normalized) {
      return;
    }
    this.buddyReactionText = normalized;
    this.buddyReactionAt = Date.now();
  }

  private async refreshToolCatalog(): Promise<void> {
    this.toolMetadata = (await this.sdk.listToolMetadata()).sort((left, right) => {
      if (left.category === right.category) {
        return left.name.localeCompare(right.name);
      }
      return left.category.localeCompare(right.category);
    });
    const normalizedAllowed = canonicalizeAllowedTools(
      this.availableToolNames(),
      this.config.autonomy.allowedTools,
    );
    if (
      normalizedAllowed.length !== this.config.autonomy.allowedTools.length ||
      normalizedAllowed.some((value, index) => value !== this.config.autonomy.allowedTools[index])
    ) {
      this.config.autonomy.allowedTools = normalizedAllowed;
      await this.persistConfig();
    }
  }

  private toolSummaryLines(): string[] {
    const configured = new Set(this.configuredAllowedToolNames());
    const effective = new Set(this.effectiveAllowedToolNames());
    const nameWidth = Math.max(8, ...this.toolMetadata.map(tool => tool.name.length));
    const categoryWidth = Math.max(8, ...this.toolMetadata.map(tool => tool.category.length));

    return this.toolMetadata.length === 0
      ? ['No tools are registered.']
      : this.toolMetadata.map(tool => {
          const status = effective.has(tool.name)
            ? 'enabled'
            : configured.has(tool.name)
            ? 'blocked-by-preset'
            : 'disabled';
          return `${tool.name.padEnd(nameWidth)} ${status.padEnd(17)} ${tool.category.padEnd(categoryWidth)} ${tool.description}`;
        });
  }

  snapshot(): ControllerSnapshot {
    return {
      workspacePath: this.config.workspacePath,
      runtimeConfigPath: this.runtimeInfo.runtimeConfigPath,
      runtimeConfigSource: this.runtimeInfo.source,
      detectedModel: this.runtimeInfo.detectedModel,
      permissionMode: this.runtimePermissionMode(),
      permissionPreset: this.config.autonomy.permissionPreset,
      availableTools: [...this.toolMetadata],
      configuredAllowedTools: this.configuredAllowedToolNames(),
      effectiveAllowedTools: this.effectiveAllowedToolNames(),
      autoRunEnabled: this.config.autonomy.autoRun,
      autoExtractMemoryEnabled: this.config.autonomy.autoExtractMemory,
      autoDreamEnabled: this.config.autonomy.autoDream,
      heartbeatEnabled: this.config.heartbeat.enabled,
      heartbeatGuideFilePath: this.config.heartbeat.guideFilePath,
      heartbeatIntervalMinutes: this.config.heartbeat.intervalMinutes,
      heartbeatUseIsolatedSession: this.config.heartbeat.useIsolatedSession,
      heartbeatActiveHours: this.config.heartbeat.activeHours,
      currentChatId: this.state.currentChatId,
      currentChatTitle: this.state.currentChatTitle,
      currentChatRestoredFromId: this.state.currentChatRestoredFromId,
      archivedChats: this.summarizeChats(),
      paused: this.state.paused,
      busy: this.busy,
      liveOutput: this.liveOutput,
      activeMissionId: this.activeMissionId,
      missions: [...this.state.missions].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      ),
      logs: [...this.state.logs],
      heartbeats: { ...this.state.heartbeats },
      buddy: this.buddy,
      buddyReactionText: this.buddyReactionText,
      buddyReactionAt: this.buddyReactionAt,
      buddyIntroText: this.buddyIntroText,
      dream: this.dream,
      memory: this.memoryPanel,
      backgroundTasks: this.backgroundTasks,
    };
  }

  async handleInput(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    const command = parseCommand(trimmed);
    if (!command) {
      this.enqueueMission(trimmed);
      return;
    }

    switch (command.name) {
      case 'help':
        this.log(
          'info',
          'system',
          [
            'Commands:',
            '/help',
            '/status | /tasks | /heartbeat | /memory | /dream | /buddy | /tools | /permission',
            '/resume [chat-id|last|list|queue] | /sessions | /close',
            'Open a panel, then type local commands like "tick", "every 20", or "pet".',
          ].join('\n'),
        );
        break;
      case 'pause':
        this.state.paused = true;
        this.log('warn', 'system', 'Autonomous queue paused.');
        this.scheduleSave();
        break;
      case 'resume':
        await this.handleResumeCommand(command.args);
        break;
      case 'heartbeat':
        await this.handleHeartbeatCommand(command.args);
        break;
      case 'buddy':
        await this.handleBuddyCommand(command.args);
        break;
      case 'tools':
        await this.handleToolsCommand(command.args);
        break;
      case 'permission':
        await this.handlePermissionCommand(command.args);
        break;
      case 'dream':
        await this.handleDreamCommand(command.args);
        break;
      case 'memory':
        await this.handleMemoryCommand(command.args);
        break;
      case 'tasks':
        this.log(
          'info',
          'system',
          this.state.missions.length === 0
            ? 'No missions yet.'
            : this.state.missions
                .slice()
                .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
                .map(
                  mission =>
                    `${mission.id} | ${mission.status} | ${mission.title} | tools=${mission.toolCalls}`,
                )
                .join('\n'),
        );
        break;
      case 'cancel':
        await this.cancelMission(command.args[0]);
        break;
      case 'sessions':
        await this.handleSessionsCommand();
        break;
      case 'status':
        this.log(
          'info',
          'system',
          [
            `chat: ${this.state.currentChatTitle} (${this.state.currentChatId})`,
            `archived chats: ${this.state.chats.length}`,
            `workspace: ${this.config.workspacePath}`,
            `model: ${this.runtimeInfo.detectedModel ?? 'unknown'}`,
            `permission: ${permissionPresetLabel(this.config.autonomy.permissionPreset)} (${this.runtimePermissionMode()})`,
            `tools: ${this.effectiveAllowedToolNames().length}/${this.availableToolNames().length} enabled`,
            `paused: ${this.state.paused}`,
            `busy: ${this.busy}`,
            `missions: ${this.state.missions.length}`,
            `background tasks: ${this.backgroundTasks.length}`,
            `heartbeat next: ${this.state.heartbeats.nextTickAt ?? 'n/a'}`,
            `dream ready: ${this.dream?.canRun ?? false}`,
          ].join('\n'),
        );
        break;
      default:
        this.log('warn', 'system', `Unknown command: ${command.raw}`);
        break;
    }

    this.emitUpdated();
  }

  private enqueueMission(prompt: string): void {
    if (this.state.missions.length === 0 && this.state.logs.length === 0) {
      this.state.currentChatTitle = titleFromPrompt(prompt);
    }

    const mission: AssistantMission = {
      id: createId('mission'),
      title: titleFromPrompt(prompt),
      prompt,
      status: 'queued',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      toolCalls: 0,
      delegatedAgents: [],
    };

    this.state.missions.push(mission);
    this.log('info', 'mission', `Queued mission ${mission.id}: ${mission.title}`);
    this.scheduleSave();
    this.emitUpdated();

    if (this.config.autonomy.autoRun) {
      void this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.busy || this.state.paused || this.disposed) {
      this.emitUpdated();
      return;
    }

    const nextMission = this.state.missions
      .filter(mission => mission.status === 'queued')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

    if (!nextMission) {
      this.emitUpdated();
      return;
    }

    this.busy = true;
    this.activeMissionId = nextMission.id;
    this.liveOutput = '';
    nextMission.status = 'running';
    nextMission.startedAt = nowIso();
    nextMission.updatedAt = nowIso();
    this.activeAbortController = new AbortController();
    this.log('info', 'mission', `Running mission ${nextMission.id}: ${nextMission.title}`);
    this.emitUpdated();
    this.scheduleSave();

    try {
      const session = await this.sdk.createSession({
        title: nextMission.title,
        metadata: {
          actoviq_claw_mission: nextMission.id,
        },
      });
      nextMission.sessionId = session.id;

      const stream = session.stream(nextMission.prompt, {
        signal: this.activeAbortController.signal,
        ...this.runtimePermissionOptions(),
      });

      for await (const event of stream) {
        this.consumeAgentEvent(nextMission, event);
      }

      const result = await stream.result;
      nextMission.status = 'completed';
      nextMission.completedAt = nowIso();
      nextMission.updatedAt = nowIso();
      nextMission.runId = result.runId;
      nextMission.model = result.model;
      nextMission.resultText = result.text;
      nextMission.toolCalls = result.toolCalls.length;
      nextMission.delegatedAgents = (result.delegatedAgents ?? []).map(record => record.name);
      this.log(
        'success',
        'mission',
        `Mission ${nextMission.id} completed with ${result.toolCalls.length} tool calls.`,
      );

      await this.captureMemoryState(session, nextMission, result.text);
      await this.refreshRuntimePanels();
      this.scheduleHeartbeat(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      nextMission.status =
        this.activeAbortController?.signal.aborted === true ? 'cancelled' : 'failed';
      nextMission.completedAt = nowIso();
      nextMission.updatedAt = nowIso();
      nextMission.error = message;
      this.log('error', 'mission', `Mission ${nextMission.id} failed: ${message}`);
    } finally {
      this.activeAbortController = undefined;
      this.busy = false;
      this.activeMissionId = undefined;
      this.liveOutput = '';
      this.emitUpdated();
      this.scheduleSave();
      if (this.config.autonomy.autoRun) {
        void this.processQueue();
      }
    }
  }

  private consumeAgentEvent(mission: AssistantMission, event: AgentEvent): void {
    switch (event.type) {
      case 'response.text.delta':
        this.liveOutput = event.snapshot;
        break;
      case 'tool.call':
        this.log(
          'info',
          'mission',
          `Tool call: ${event.call.publicName} (${trimPreview(JSON.stringify(event.call.input), 120)})`,
        );
        break;
      case 'tool.result':
        this.log(
          event.result.isError ? 'warn' : 'success',
          'mission',
          `Tool result: ${event.result.publicName} ${event.result.isError ? 'failed' : 'ok'}`,
        );
        break;
      case 'tool.permission':
        this.log(
          event.decision.behavior === 'allow' ? 'info' : 'warn',
          'mission',
          `Permission ${event.decision.behavior}: ${event.decision.publicName} (${event.decision.reason})`,
        );
        break;
      case 'session.compacted':
        this.log(
          'info',
          'memory',
          `Session compacted for ${mission.id}: ${event.result.reason}`,
        );
        break;
      case 'error':
        this.log('error', 'mission', `Runtime error: ${event.error.message}`);
        break;
      default:
        break;
    }

    mission.updatedAt = nowIso();
    this.emitUpdated();
  }

  private async captureMemoryState(
    session: AgentSession,
    mission: AssistantMission,
    query: string,
  ): Promise<void> {
    if (this.config.autonomy.autoExtractMemory) {
      const extraction = await session.extractMemory();
      if (extraction.memoryPath) {
        mission.memoryPath = extraction.memoryPath;
      }
      this.log(
        extraction.updated ? 'success' : 'info',
        'memory',
        `Session memory ${extraction.updated ? 'updated' : 'checked'}: ${
          extraction.reason ?? extraction.memoryPath ?? 'no change'
        }`,
      );
    }

    const compactState = await session.compactState({
      includeSessionMemory: true,
      includeSummaryMessage: true,
    });
    const relevantMemories = await this.sdk.memory.findRelevantMemories(query, {
      sessionId: session.id,
    });
    const manifest = await this.sdk.memory.formatMemoryManifest({
      sessionId: session.id,
    });

    this.memoryPanel = {
      manifestPreview: trimPreview(manifest, 600),
      sessionMemoryPreview: trimPreview(compactState.sessionMemory?.content ?? '', 700),
      relevantMemories,
      compactState,
    };

    if (this.config.autonomy.autoDream) {
      const dreamResult = await session.maybeAutoDream({
        currentSessionId: session.id,
        background: true,
      });
      if (dreamResult.task) {
        mission.dreamSummary = `Dream background task: ${dreamResult.task.id}`;
        this.log('info', 'dream', `Dream launched in background: ${dreamResult.task.id}`);
      } else if (!dreamResult.skipped) {
        mission.dreamSummary = trimPreview(dreamResult.result?.text ?? 'Dream complete.');
        this.log('success', 'dream', `Dream finished: ${mission.dreamSummary}`);
      } else {
        mission.dreamSummary = dreamResult.reason;
        this.log('info', 'dream', `Dream skipped: ${dreamResult.reason}`);
      }
    }
  }

  private async refreshRuntimePanels(): Promise<void> {
    this.buddy = await this.sdk.buddy.state();
    this.buddyIntroText = (await this.sdk.buddy.getIntroText()) ?? undefined;
    this.dream = await this.sdk.dreamState();
    const manifest = await this.sdk.memory.formatMemoryManifest();
    this.memoryPanel = {
      ...this.memoryPanel,
      manifestPreview: trimPreview(manifest, 600),
      relevantMemories: this.memoryPanel.relevantMemories ?? [],
      sessionMemoryPreview: this.memoryPanel.sessionMemoryPreview ?? '',
    };
    await this.pollBackgroundTasks();
  }

  private async ensureBuddy(): Promise<void> {
    let state = await this.sdk.buddy.state();
    if (!state.buddy && this.config.buddy.autoHatch) {
      await this.sdk.buddy.hatch({
        name: this.config.buddy.name,
        personality: this.config.buddy.personality,
      });
      this.log('success', 'buddy', `Buddy hatched: ${this.config.buddy.name}`);
      state = await this.sdk.buddy.state();
    }

    if (this.config.buddy.muted) {
      state = await this.sdk.buddy.mute();
    } else {
      state = await this.sdk.buddy.unmute();
    }

    this.buddy = state;
    this.buddyIntroText = (await this.sdk.buddy.getIntroText()) ?? undefined;
  }

  private async pollBackgroundTasks(): Promise<void> {
    if (!this.sdk) {
      return;
    }
    const tasks = await this.sdk.tasks.list();
    this.backgroundTasks = tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    for (const task of tasks) {
      const previous = this.backgroundStatusIndex.get(task.id);
      if (previous !== task.status) {
        this.backgroundStatusIndex.set(task.id, task.status);
        this.log(
          task.status === 'failed' ? 'warn' : 'info',
          'background',
          formatBackgroundTask(task),
        );

        if (
          previous &&
          previous !== 'completed' &&
          previous !== 'failed' &&
          previous !== 'cancelled' &&
          (task.status === 'completed' || task.status === 'failed')
        ) {
          this.scheduleHeartbeat(false, 'background-task-finished');
        }
      }
    }

    this.emitUpdated();
  }

  private async persistConfig(): Promise<void> {
    await saveAppConfig(this.rootDir, this.config);
  }

  private heartbeatGuideInstruction(): string {
    const relative = path.relative(this.config.workspacePath, this.config.heartbeat.guideFilePath);
    const guidePath = relative && !relative.startsWith('..') ? relative.replace(/\\/g, '/') : this.config.heartbeat.guideFilePath;
    return `If the heartbeat guide file exists at "${guidePath}", read it before acting and follow it strictly.`;
  }

  async updateHeartbeatSettings(patch: {
    enabled?: boolean;
    intervalMinutes?: number;
    activeHours?: { start?: string; end?: string; timezone?: string | undefined };
    guideFilePath?: string;
    useIsolatedSession?: boolean;
  }): Promise<void> {
    if (typeof patch.enabled === 'boolean') {
      this.config.heartbeat.enabled = patch.enabled;
      if (patch.enabled) {
        this.scheduleHeartbeat(true, 'manually-enabled');
      }
    }

    if (typeof patch.intervalMinutes === 'number' && Number.isFinite(patch.intervalMinutes)) {
      this.config.heartbeat.intervalMinutes = Math.max(1, Math.round(patch.intervalMinutes));
      this.scheduleHeartbeat(true, 'interval-updated');
    }

    if (patch.activeHours) {
      this.config.heartbeat.activeHours = {
        start: patch.activeHours.start ?? this.config.heartbeat.activeHours?.start ?? '08:00',
        end: patch.activeHours.end ?? this.config.heartbeat.activeHours?.end ?? '23:30',
        timezone:
          patch.activeHours.timezone === undefined
            ? this.config.heartbeat.activeHours?.timezone
            : patch.activeHours.timezone || undefined,
      };
      this.scheduleHeartbeat(true, 'active-hours-updated');
    }

    if (typeof patch.guideFilePath === 'string' && patch.guideFilePath.trim()) {
      const nextGuidePath = path.isAbsolute(patch.guideFilePath)
        ? patch.guideFilePath
        : path.resolve(this.config.workspacePath, patch.guideFilePath);
      this.config.heartbeat.guideFilePath = nextGuidePath;
      await ensureHeartbeatTemplate(this.config.heartbeat.guideFilePath);
    }

    if (typeof patch.useIsolatedSession === 'boolean') {
      this.config.heartbeat.useIsolatedSession = patch.useIsolatedSession;
    }

    await this.persistConfig();
    this.emitUpdated();
  }

  async updatePermissionSettings(preset: 'chat-only' | 'workspace-only' | 'full-access'): Promise<void> {
    this.config.autonomy.permissionPreset = preset;
    this.config.autonomy.permissionMode = this.runtimePermissionMode();
    await this.persistConfig();
    this.emitUpdated();
  }

  async updateAllowedTools(nextAllowedTools: string[]): Promise<void> {
    this.config.autonomy.allowedTools = canonicalizeAllowedTools(
      this.availableToolNames(),
      nextAllowedTools,
    );
    await this.persistConfig();
    this.emitUpdated();
  }

  async handlePanelInput(
    panel: 'help' | 'status' | 'tasks' | 'memory' | 'dream' | 'buddy' | 'heartbeat' | 'tools' | 'permission',
    input: string,
  ): Promise<void> {
    const tokens = tokenizeCommand(input.trim());
    const action = (tokens[0] ?? '').toLowerCase();
    const args = tokens.slice(1);

    if (!action) {
      return;
    }

    switch (panel) {
      case 'heartbeat': {
        switch (action) {
          case 'show':
            this.log('info', 'heartbeat', 'Heartbeat settings refreshed.');
            break;
          case 'on':
          case 'off':
            await this.updateHeartbeatSettings({ enabled: action === 'on' });
            this.log(action === 'on' ? 'success' : 'warn', 'heartbeat', `Heartbeat ${action === 'on' ? 'enabled' : 'disabled'}.`);
            break;
          case 'toggle':
            await this.updateHeartbeatSettings({ enabled: !this.config.heartbeat.enabled });
            this.log(
              this.config.heartbeat.enabled ? 'success' : 'warn',
              'heartbeat',
              `Heartbeat ${this.config.heartbeat.enabled ? 'enabled' : 'disabled'}.`,
            );
            break;
          case 'tick':
          case 'run':
            await this.runHeartbeat('manual');
            break;
          case 'every':
          case 'interval': {
            const minutes = Number(args[0]);
            if (!Number.isFinite(minutes) || minutes <= 0) {
              this.log('warn', 'heartbeat', 'Usage: every <minutes>');
              break;
            }
            await this.updateHeartbeatSettings({ intervalMinutes: minutes });
            this.log('success', 'heartbeat', `Heartbeat interval set to ${Math.round(minutes)} minutes.`);
            break;
          }
          case 'start': {
            const start = args[0] ?? '';
            if (!isValidClockValue(start)) {
              this.log('warn', 'heartbeat', 'Usage: start <HH:MM>');
              break;
            }
            await this.updateHeartbeatSettings({ activeHours: { start } });
            this.log('success', 'heartbeat', `Heartbeat start time set to ${start}.`);
            break;
          }
          case 'end': {
            const end = args[0] ?? '';
            if (!isValidClockValue(end)) {
              this.log('warn', 'heartbeat', 'Usage: end <HH:MM>');
              break;
            }
            await this.updateHeartbeatSettings({ activeHours: { end } });
            this.log('success', 'heartbeat', `Heartbeat end time set to ${end}.`);
            break;
          }
          case 'hours': {
            const start = args[0] ?? '';
            const end = args[1] ?? '';
            if (!isValidClockValue(start) || !isValidClockValue(end)) {
              this.log('warn', 'heartbeat', 'Usage: hours <HH:MM> <HH:MM>');
              break;
            }
            await this.updateHeartbeatSettings({ activeHours: { start, end } });
            this.log('success', 'heartbeat', `Heartbeat active hours set to ${start}-${end}.`);
            break;
          }
          case 'timezone': {
            const timezone = args.join(' ').trim();
            await this.updateHeartbeatSettings({ activeHours: { timezone: timezone.toLowerCase() === 'clear' ? '' : timezone } });
            this.log('success', 'heartbeat', timezone ? `Heartbeat timezone set to ${timezone}.` : 'Heartbeat timezone cleared.');
            break;
          }
          case 'file':
          case 'path': {
            const filePath = args.join(' ').trim();
            if (!filePath) {
              this.log('warn', 'heartbeat', 'Usage: file <path-to-heartbeat-guide>');
              break;
            }
            await this.updateHeartbeatSettings({ guideFilePath: filePath });
            this.log('success', 'heartbeat', `Heartbeat guide file set to ${this.config.heartbeat.guideFilePath}.`);
            break;
          }
          case 'isolated': {
            const mode = (args[0] ?? '').toLowerCase();
            if (mode !== 'on' && mode !== 'off') {
              this.log('warn', 'heartbeat', 'Usage: isolated <on|off>');
              break;
            }
            await this.updateHeartbeatSettings({ useIsolatedSession: mode === 'on' });
            this.log('success', 'heartbeat', `Heartbeat isolated session ${mode === 'on' ? 'enabled' : 'disabled'}.`);
            break;
          }
          default:
            this.log(
              'warn',
              'heartbeat',
              'Heartbeat panel commands: on | off | toggle | tick | every <minutes> | start <HH:MM> | end <HH:MM> | hours <start> <end> | timezone <name|clear> | file <path> | isolated <on|off>',
            );
            break;
        }
        break;
      }
      case 'permission': {
        await this.handlePermissionCommand([action, ...args]);
        break;
      }
      case 'tools': {
        await this.handleToolsCommand([action, ...args]);
        break;
      }
      case 'buddy': {
        if (
          action === 'pet' ||
          action === 'mute' ||
          action === 'unmute' ||
          action === 'hatch' ||
          action === 'rename' ||
          action === 'persona' ||
          action === 'intro' ||
          action === 'show'
        ) {
          await this.handleBuddyCommand([action, ...args]);
          break;
        }
        this.log('warn', 'buddy', 'Buddy panel commands: show | pet | intro | mute | unmute | rename <name> | persona <text> | hatch <name> [personality]');
        break;
      }
      case 'dream': {
        if (action === 'run' || action === 'now') {
          await this.handleDreamCommand(['now']);
          break;
        }
        if (action === 'state' || action === 'refresh') {
          await this.handleDreamCommand(['state']);
          break;
        }
        this.log('warn', 'dream', 'Dream panel commands: run | state');
        break;
      }
      case 'memory': {
        if (action === 'state' || action === 'refresh') {
          await this.handleMemoryCommand(['state']);
          break;
        }
        if (action === 'find') {
          await this.handleMemoryCommand(['find', ...args]);
          break;
        }
        this.log('warn', 'memory', 'Memory panel commands: refresh | find <query>');
        break;
      }
      case 'tasks': {
        if (action === 'pause') {
          this.state.paused = true;
          this.log('warn', 'system', 'Autonomous queue paused.');
          this.scheduleSave();
          break;
        }
        if (action === 'resume') {
          await this.handleResumeCommand(args);
          break;
        }
        if (action === 'cancel') {
          await this.cancelMission(args[0]);
          break;
        }
        this.log('warn', 'system', 'Tasks panel commands: pause | resume [chat-id|last|list|queue] | cancel <mission-id>');
        break;
      }
      case 'status': {
        if (action === 'pause') {
          this.state.paused = true;
          this.log('warn', 'system', 'Autonomous queue paused.');
          this.scheduleSave();
          break;
        }
        if (action === 'resume') {
          this.state.paused = false;
          this.log('success', 'system', 'Autonomous queue resumed.');
          this.scheduleSave();
          void this.processQueue();
          break;
        }
        if (action === 'sessions') {
          await this.handleSessionsCommand();
          break;
        }
        if (action === 'newchat' || action === 'new') {
          this.startFreshChatWindow();
          this.log('success', 'system', `Opened ${this.state.currentChatTitle}.`);
          this.scheduleSave();
          break;
        }
        this.log('warn', 'system', 'Status panel commands: pause | resume | newchat | sessions');
        break;
      }
      case 'help':
        this.log('info', 'system', 'Use /heartbeat, /tasks, /memory, /dream, /buddy, /tools, /permission, or /status to open a focused panel.');
        break;
    }

    this.emitUpdated();
  }

  private scheduleHeartbeat(force: boolean, reason = 'scheduled'): void {
    const now = new Date();
    if (force || !this.state.heartbeats.nextTickAt) {
      this.state.heartbeats.nextTickAt = computeNextHeartbeatAt(
        now,
        this.config.heartbeat.intervalMinutes,
      );
      this.state.heartbeats.lastReason = reason;
      this.scheduleSave();
    }
  }

  private async maybeRunHeartbeat(): Promise<void> {
    if (
      !this.config.heartbeat.enabled ||
      this.heartbeatBusy ||
      !this.state.heartbeats.nextTickAt ||
      this.state.paused
    ) {
      return;
    }

    if (new Date(this.state.heartbeats.nextTickAt).getTime() > Date.now()) {
      return;
    }

    await this.runHeartbeat('scheduled');
  }

  private async runHeartbeat(reason: string): Promise<void> {
    if (this.heartbeatBusy || this.disposed) {
      return;
    }

    if (!isWithinActiveHours(this.config.heartbeat.activeHours)) {
      this.state.heartbeats.skippedCount += 1;
      this.state.heartbeats.lastReason = 'outside-active-hours';
      this.scheduleHeartbeat(true, 'outside-active-hours');
      this.scheduleSave();
      this.emitUpdated();
      return;
    }

    if (this.busy) {
      this.state.heartbeats.skippedCount += 1;
      this.state.heartbeats.lastReason = 'mission-running';
      this.scheduleHeartbeat(true, 'mission-running');
      this.scheduleSave();
      this.emitUpdated();
      return;
    }

    this.heartbeatBusy = true;
    try {
      const session = await this.resolveHeartbeatSession();
      const result = await session.send(
        `${this.config.heartbeat.prompt}\n\n${this.heartbeatGuideInstruction()}`,
        this.runtimePermissionOptions(),
      );
      const normalized = normalizeHeartbeatResponse(
        result.text,
        this.config.heartbeat.ackMaxChars,
      );

      this.state.heartbeats.lastTickAt = nowIso();
      this.state.heartbeats.lastReason = reason;
      this.state.heartbeats.lastResult = normalized.visibleText || 'HEARTBEAT_OK';
      this.state.heartbeats.nextTickAt = computeNextHeartbeatAt(
        new Date(),
        this.config.heartbeat.intervalMinutes,
      );

      if (normalized.acknowledged) {
        this.log('info', 'heartbeat', 'Heartbeat acknowledged with HEARTBEAT_OK.');
      } else {
        this.log('warn', 'heartbeat', normalized.visibleText || trimPreview(result.text, 200));
      }

      this.dream = await this.sdk.dreamState(session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('error', 'heartbeat', `Heartbeat failed: ${message}`);
      this.state.heartbeats.lastReason = 'failed';
      this.state.heartbeats.lastResult = message;
      this.state.heartbeats.nextTickAt = computeNextHeartbeatAt(
        new Date(),
        this.config.heartbeat.intervalMinutes,
      );
    } finally {
      this.heartbeatBusy = false;
      this.scheduleSave();
      this.emitUpdated();
    }
  }

  private async resolveHeartbeatSession(): Promise<AgentSession> {
    if (this.config.heartbeat.useIsolatedSession) {
      return this.sdk.createSession({
        title: `Heartbeat ${new Date().toLocaleString()}`,
        metadata: {
          actoviq_claw_heartbeat: true,
        },
      });
    }

    if (this.state.controlSessionId) {
      return this.sdk.resumeSession(this.state.controlSessionId);
    }

    const session = await this.sdk.createSession({
      title: 'Actoviq Claw Control',
      metadata: {
        actoviq_claw_control: true,
      },
    });
    this.state.controlSessionId = session.id;
    return session;
  }

  private async handleHeartbeatCommand(args: string[]): Promise<void> {
    const action = (args[0] ?? '').toLowerCase();
    if (!action || action === 'tick') {
      await this.runHeartbeat('manual');
      return;
    }
    if (action === 'on') {
      await this.updateHeartbeatSettings({ enabled: true });
      this.log('success', 'heartbeat', 'Heartbeat enabled.');
      return;
    }
    if (action === 'off') {
      await this.updateHeartbeatSettings({ enabled: false });
      this.log('warn', 'heartbeat', 'Heartbeat disabled.');
      return;
    }
    if (action === 'every') {
      const minutes = Number(args[1]);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        this.log('warn', 'heartbeat', 'Usage: /heartbeat every <minutes>');
        return;
      }
      await this.updateHeartbeatSettings({ intervalMinutes: minutes });
      this.log('success', 'heartbeat', `Heartbeat interval set to ${Math.round(minutes)} minutes.`);
      return;
    }
    this.log('warn', 'heartbeat', 'Usage: /heartbeat on | off | tick | every <minutes>');
  }

  private async handlePermissionCommand(args: string[]): Promise<void> {
    const action = normalizePermissionPreset(args[0], this.config.autonomy.permissionPreset);
    const raw = (args[0] ?? '').toLowerCase();

    if (!args[0] || raw === 'show' || raw === 'state') {
      this.log(
        'info',
        'system',
        [
          `permission preset: ${permissionPresetLabel(this.config.autonomy.permissionPreset)}`,
          `runtime mode: ${this.runtimePermissionMode()}`,
          `effective tools: ${this.effectiveAllowedToolNames().join(', ') || 'none'}`,
        ].join('\n'),
      );
      return;
    }

    if (
      raw !== 'chat-only' &&
      raw !== 'workspace-only' &&
      raw !== 'full-access' &&
      raw !== 'chat' &&
      raw !== 'workspace' &&
      raw !== 'full'
    ) {
      this.log('warn', 'system', 'Usage: /permission chat-only | workspace-only | full-access');
      return;
    }

    const preset =
      raw === 'chat'
        ? 'chat-only'
        : raw === 'workspace'
        ? 'workspace-only'
        : raw === 'full'
        ? 'full-access'
        : action;

    await this.updatePermissionSettings(preset);
    this.log(
      'success',
      'system',
      `Permission preset set to ${permissionPresetLabel(preset)}. Effective tools: ${
        this.effectiveAllowedToolNames().join(', ') || 'none'
      }.`,
    );
  }

  private async handleToolsCommand(args: string[]): Promise<void> {
    const action = (args[0] ?? '').toLowerCase();
    const available = this.availableToolNames();
    const configured = new Set(this.configuredAllowedToolNames());
    const category = args[1]?.toLowerCase() === 'category' ? (args[2] ?? '').toLowerCase() : undefined;
    const categoryTools =
      category && this.toolMetadata.some(tool => tool.category === category)
        ? this.toolMetadata
            .filter(tool => tool.category === category)
            .map(tool => tool.name)
        : [];

    if (!action || action === 'show' || action === 'list') {
      this.log(
        'info',
        'system',
        [
          `permission preset: ${permissionPresetLabel(this.config.autonomy.permissionPreset)}`,
          `configured tools: ${this.configuredAllowedToolNames().join(', ') || 'none'}`,
          `effective tools: ${this.effectiveAllowedToolNames().join(', ') || 'none'}`,
          ...this.toolSummaryLines(),
        ].join('\n'),
      );
      return;
    }

    if ((action === 'allow' || action === 'enable') && (args[1] ?? '').toLowerCase() === 'all') {
      await this.updateAllowedTools(available);
      this.log('success', 'system', `All tools enabled in the tool allowlist.`);
      return;
    }

    if ((action === 'deny' || action === 'disable') && (args[1] ?? '').toLowerCase() === 'all') {
      await this.updateAllowedTools([]);
      this.log('warn', 'system', 'All tools disabled in the tool allowlist.');
      return;
    }

    if (action === 'reset') {
      await this.updateAllowedTools(defaultAllowedTools());
      this.log('success', 'system', `Tool allowlist reset to defaults: ${this.configuredAllowedToolNames().join(', ') || 'none'}.`);
      return;
    }

    if ((action === 'allow' || action === 'enable') && categoryTools.length > 0) {
      await this.updateAllowedTools([...new Set([...configured, ...categoryTools])]);
      this.log('success', 'system', `Enabled ${category} tools: ${categoryTools.join(', ')}.`);
      return;
    }

    if ((action === 'deny' || action === 'disable') && categoryTools.length > 0) {
      categoryTools.forEach(toolName => configured.delete(toolName));
      await this.updateAllowedTools([...configured]);
      this.log('warn', 'system', `Disabled ${category} tools: ${categoryTools.join(', ')}.`);
      return;
    }

    const target = this.resolveToolName(args.slice(1).join(' '));
    if (!target) {
      this.log('warn', 'system', 'Usage: /tools show | allow all | deny all | reset | enable <tool> | disable <tool> | toggle <tool> | enable category <name> | disable category <name>');
      return;
    }

    switch (action) {
      case 'allow':
      case 'enable': {
        configured.add(target);
        await this.updateAllowedTools([...configured]);
        this.log('success', 'system', `${target} enabled in the tool allowlist.`);
        return;
      }
      case 'deny':
      case 'disable': {
        configured.delete(target);
        await this.updateAllowedTools([...configured]);
        this.log('warn', 'system', `${target} disabled in the tool allowlist.`);
        return;
      }
      case 'toggle': {
        if (configured.has(target)) {
          configured.delete(target);
          await this.updateAllowedTools([...configured]);
          this.log('warn', 'system', `${target} disabled in the tool allowlist.`);
        } else {
          configured.add(target);
          await this.updateAllowedTools([...configured]);
          this.log('success', 'system', `${target} enabled in the tool allowlist.`);
        }
        return;
      }
      default:
        this.log('warn', 'system', 'Usage: /tools show | allow all | deny all | reset | enable <tool> | disable <tool> | toggle <tool> | enable category <name> | disable category <name>');
        return;
    }
  }

  private async handleBuddyCommand(args: string[]): Promise<void> {
    const action = (args[0] ?? '').toLowerCase();
    switch (action) {
      case 'show': {
        this.buddy = await this.sdk.buddy.state();
        this.buddyIntroText = (await this.sdk.buddy.getIntroText()) ?? undefined;
        this.log(
          'info',
          'buddy',
          this.buddy?.buddy
            ? `${this.buddy.buddy.name} the ${this.buddy.buddy.species} is here.`
            : 'No buddy has been hatched yet.',
        );
        break;
      }
      case 'pet': {
        const reaction = await this.sdk.buddy.pet();
        this.buddy = await this.sdk.buddy.state();
        this.setBuddyReaction(reaction?.reaction);
        this.log('success', 'buddy', reaction?.reaction ?? 'Buddy is resting quietly.');
        break;
      }
      case 'intro': {
        this.buddyIntroText = (await this.sdk.buddy.getIntroText()) ?? undefined;
        this.log('info', 'buddy', this.buddyIntroText ?? 'Buddy intro is not available yet.');
        break;
      }
      case 'mute':
        this.buddy = await this.sdk.buddy.mute();
        this.config.buddy.muted = true;
        await this.persistConfig();
        this.setBuddyReaction(`${this.config.buddy.name} is muted for now.`);
        this.log('info', 'buddy', 'Buddy muted.');
        break;
      case 'unmute':
        this.buddy = await this.sdk.buddy.unmute();
        this.config.buddy.muted = false;
        await this.persistConfig();
        this.setBuddyReaction(`${this.config.buddy.name} is back.`);
        this.log('success', 'buddy', 'Buddy unmuted.');
        break;
      case 'rename': {
        const name = args.slice(1).join(' ').trim();
        const current = this.buddy?.buddy;
        if (!name || !current) {
          this.log('warn', 'buddy', 'Usage: /buddy rename <name>');
          return;
        }
        await this.sdk.buddy.hatch({ name, personality: current.personality });
        this.config.buddy.name = name;
        await this.persistConfig();
        this.buddy = await this.sdk.buddy.state();
        this.buddyIntroText = (await this.sdk.buddy.getIntroText()) ?? undefined;
        this.setBuddyReaction(`${name} has a fresh name tag now.`);
        this.log('success', 'buddy', `Buddy renamed to ${name}.`);
        break;
      }
      case 'persona': {
        const personality = args.slice(1).join(' ').trim();
        const current = this.buddy?.buddy;
        if (!personality || !current) {
          this.log('warn', 'buddy', 'Usage: /buddy persona <text>');
          return;
        }
        await this.sdk.buddy.hatch({ name: current.name, personality });
        this.config.buddy.personality = personality;
        await this.persistConfig();
        this.buddy = await this.sdk.buddy.state();
        this.buddyIntroText = (await this.sdk.buddy.getIntroText()) ?? undefined;
        this.setBuddyReaction(`${current.name} feels newly ${trimPreview(personality, 36)}.`);
        this.log('success', 'buddy', 'Buddy personality updated.');
        break;
      }
      case 'hatch': {
        const name = args[1];
        const personality = args.slice(2).join(' ').trim() || this.config.buddy.personality;
        if (!name) {
          this.log('warn', 'buddy', 'Usage: /buddy hatch <name> [personality]');
          return;
        }
        await this.sdk.buddy.hatch({ name, personality });
        this.config.buddy.name = name;
        this.config.buddy.personality = personality;
        await this.persistConfig();
        this.buddy = await this.sdk.buddy.state();
        this.buddyIntroText = (await this.sdk.buddy.getIntroText()) ?? undefined;
        this.setBuddyReaction(`${name} the ${this.buddy?.buddy?.species ?? 'buddy'} hatched beside the prompt.`);
        this.log('success', 'buddy', `Buddy hatched: ${name}`);
        break;
      }
      default:
        this.log('warn', 'buddy', 'Usage: /buddy show | pet | intro | mute | unmute | rename <name> | persona <text> | hatch <name> [personality]');
        break;
    }
  }

  private async handleDreamCommand(args: string[]): Promise<void> {
    const action = (args[0] ?? '').toLowerCase();
    if (action === 'state') {
      this.dream = await this.sdk.dreamState();
      this.log(
        'info',
        'dream',
        `Dream state: canRun=${this.dream.canRun} reason=${this.dream.blockedReason ?? 'ready'}`,
      );
      return;
    }

    const result = await this.sdk.dream.run({
      force: true,
      background: true,
      extraContext:
        'Consolidate stable project knowledge, useful collaboration patterns, and recurring implementation facts.',
    });
    this.dream = result.state;
    if (result.task) {
      this.log('success', 'dream', `Dream launched in background: ${result.task.id}`);
    } else {
      this.log('success', 'dream', trimPreview(result.result?.text ?? 'Dream completed.'));
    }
  }

  private async handleMemoryCommand(args: string[]): Promise<void> {
    const action = (args[0] ?? '').toLowerCase();
    if (action === 'state' || !action) {
      const state = await this.sdk.memory.state({
        includeSessionMemory: true,
      });
      this.memoryPanel = {
        ...this.memoryPanel,
        manifestPreview: trimPreview(await this.sdk.memory.formatMemoryManifest(), 600),
        sessionMemoryPreview: trimPreview(state.sessionMemory?.content ?? '', 700),
      };
      this.log(
        'info',
        'memory',
        `Memory state: autoMemory=${state.enabled.autoMemory} autoDream=${state.enabled.autoDream}`,
      );
      return;
    }
    if (action === 'find') {
      const query = args.slice(1).join(' ').trim();
      if (!query) {
        this.log('warn', 'memory', 'Usage: /memory find <query>');
        return;
      }
      const memories = await this.sdk.memory.findRelevantMemories(query);
      this.memoryPanel = {
        ...this.memoryPanel,
        relevantMemories: memories,
      };
      this.log(
        'info',
        'memory',
        memories.length === 0
          ? 'No relevant memories found.'
          : memories.map(memory => `${memory.scope} ${memory.filename}`).join('\n'),
      );
      return;
    }
    this.log('warn', 'memory', 'Usage: /memory state | find <query>');
  }

  private async handleSessionsCommand(): Promise<void> {
    const sessions = await this.sdk.sessions.list();
    this.log(
      'info',
      'system',
      sessions.length === 0
        ? 'No sessions found.'
        : sessions
            .slice(0, 8)
            .map(session => `${session.id} | ${session.title} | runs=${session.runCount}`)
            .join('\n'),
    );
  }

  private async cancelMission(missionId: string | undefined): Promise<void> {
    if (!missionId) {
      this.log('warn', 'system', 'Usage: /cancel <mission-id>');
      return;
    }

    const mission = this.state.missions.find(item => item.id === missionId);
    if (!mission) {
      this.log('warn', 'system', `No mission found with id ${missionId}.`);
      return;
    }

    if (mission.status === 'queued') {
      mission.status = 'cancelled';
      mission.updatedAt = nowIso();
      this.log('warn', 'mission', `Cancelled queued mission ${mission.id}.`);
      this.scheduleSave();
      return;
    }

    if (mission.status === 'running' && this.activeMissionId === mission.id) {
      this.activeAbortController?.abort();
      this.log('warn', 'mission', `Abort requested for mission ${mission.id}.`);
      return;
    }

    this.log('warn', 'system', `Mission ${mission.id} is already ${mission.status}.`);
  }

  private log(level: AssistantLogEntry['level'], scope: AssistantLogEntry['scope'], text: string): void {
    const entry: AssistantLogEntry = {
      id: createId('log'),
      at: nowIso(),
      level,
      scope,
      text,
    };
    this.state.logs = [...this.state.logs, entry].slice(-250);
    this.scheduleSave();
    this.emitUpdated();
  }

  private emitUpdated(): void {
    this.emit('updated', this.snapshot());
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      void this.persistNow();
    }, 200);
  }

  private async persistNow(): Promise<void> {
    await saveState(this.config.stateDir, this.state);
  }
}
