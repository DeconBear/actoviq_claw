import { EventEmitter } from 'node:events';

import {
  createAgentSdk,
  type ActoviqAgentClient,
  type ActoviqBackgroundTaskRecord,
  type ActoviqBuddyState,
  type ActoviqDreamState,
  type AgentEvent,
  type AgentSession,
} from 'actoviq-agent-sdk';

import { buildNamedAgents, DEFAULT_SYSTEM_PROMPT } from './defaults.js';
import { parseCommand } from './commandParser.js';
import {
  computeNextHeartbeatAt,
  isWithinActiveHours,
  normalizeHeartbeatResponse,
} from './heartbeat.js';
import {
  ensureDirectory,
  ensureHeartbeatTemplate,
  ensureRuntimeConfig,
  loadOrCreateAppConfig,
  loadOrCreateState,
  saveState,
} from './persistence.js';
import type {
  AssistantAppConfig,
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

function trimPreview(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/u)[0] ?? 'Untitled mission';
  return trimPreview(firstLine, 72) || 'Untitled mission';
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
  private backgroundTasks: ActoviqBackgroundTaskRecord[] = [];
  private backgroundStatusIndex = new Map<string, string>();

  constructor(private readonly rootDir: string) {
    super();
  }

  async initialize(): Promise<void> {
    this.config = await loadOrCreateAppConfig(this.rootDir);
    await ensureDirectory(this.config.stateDir);
    await ensureDirectory(`${this.config.stateDir}/sessions`);
    await ensureHeartbeatTemplate(this.config.workspacePath);
    this.runtimeInfo = await ensureRuntimeConfig(this.config.runtimeConfigPath);
    this.state = await loadOrCreateState(this.config.stateDir);

    this.sdk = await createAgentSdk({
      workDir: this.config.workspacePath,
      sessionDirectory: `${this.config.stateDir}/sessions`,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      permissionMode: this.config.autonomy.permissionMode,
      agents: buildNamedAgents(),
    });

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

  snapshot(): ControllerSnapshot {
    return {
      workspacePath: this.config.workspacePath,
      runtimeConfigPath: this.runtimeInfo.runtimeConfigPath,
      runtimeConfigSource: this.runtimeInfo.source,
      detectedModel: this.runtimeInfo.detectedModel,
      permissionMode: this.config.autonomy.permissionMode,
      autoRunEnabled: this.config.autonomy.autoRun,
      autoExtractMemoryEnabled: this.config.autonomy.autoExtractMemory,
      autoDreamEnabled: this.config.autonomy.autoDream,
      heartbeatEnabled: this.config.heartbeat.enabled,
      heartbeatIntervalMinutes: this.config.heartbeat.intervalMinutes,
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
            '/pause | /resume',
            '/heartbeat on | off | tick | every <minutes>',
            '/buddy pet | mute | unmute | hatch <name> [personality]',
            '/dream now | state',
            '/memory state | find <query>',
            '/tasks',
            '/cancel <mission-id>',
            '/sessions',
            '/status',
          ].join('\n'),
        );
        break;
      case 'pause':
        this.state.paused = true;
        this.log('warn', 'system', 'Autonomous queue paused.');
        this.scheduleSave();
        break;
      case 'resume':
        this.state.paused = false;
        this.log('success', 'system', 'Autonomous queue resumed.');
        this.scheduleSave();
        void this.processQueue();
        break;
      case 'heartbeat':
        await this.handleHeartbeatCommand(command.args);
        break;
      case 'buddy':
        await this.handleBuddyCommand(command.args);
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
            `workspace: ${this.config.workspacePath}`,
            `model: ${this.runtimeInfo.detectedModel ?? 'unknown'}`,
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
        permissionMode: this.config.autonomy.permissionMode,
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
      const result = await session.send(this.config.heartbeat.prompt, {
        permissionMode: this.config.autonomy.permissionMode,
      });
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
      this.config.heartbeat.enabled = true;
      this.scheduleHeartbeat(true, 'manually-enabled');
      this.log('success', 'heartbeat', 'Heartbeat enabled.');
      return;
    }
    if (action === 'off') {
      this.config.heartbeat.enabled = false;
      this.log('warn', 'heartbeat', 'Heartbeat disabled.');
      return;
    }
    if (action === 'every') {
      const minutes = Number(args[1]);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        this.log('warn', 'heartbeat', 'Usage: /heartbeat every <minutes>');
        return;
      }
      this.config.heartbeat.intervalMinutes = Math.max(1, Math.round(minutes));
      this.scheduleHeartbeat(true, 'interval-updated');
      this.log('success', 'heartbeat', `Heartbeat interval set to ${minutes} minutes.`);
      return;
    }
    this.log('warn', 'heartbeat', 'Usage: /heartbeat on | off | tick | every <minutes>');
  }

  private async handleBuddyCommand(args: string[]): Promise<void> {
    const action = (args[0] ?? '').toLowerCase();
    switch (action) {
      case 'pet': {
        const reaction = await this.sdk.buddy.pet();
        this.buddy = await this.sdk.buddy.state();
        this.log('success', 'buddy', reaction?.reaction ?? 'Buddy is resting quietly.');
        break;
      }
      case 'mute':
        this.buddy = await this.sdk.buddy.mute();
        this.log('info', 'buddy', 'Buddy muted.');
        break;
      case 'unmute':
        this.buddy = await this.sdk.buddy.unmute();
        this.log('success', 'buddy', 'Buddy unmuted.');
        break;
      case 'hatch': {
        const name = args[1];
        const personality = args.slice(2).join(' ').trim() || this.config.buddy.personality;
        if (!name) {
          this.log('warn', 'buddy', 'Usage: /buddy hatch <name> [personality]');
          return;
        }
        await this.sdk.buddy.hatch({ name, personality });
        this.buddy = await this.sdk.buddy.state();
        this.log('success', 'buddy', `Buddy hatched: ${name}`);
        break;
      }
      default:
        this.log('warn', 'buddy', 'Usage: /buddy pet | mute | unmute | hatch <name> [personality]');
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
    if (this.disposed) {
      return;
    }
    await saveState(this.config.stateDir, this.state);
  }
}
