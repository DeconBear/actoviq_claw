import type {
  ActoviqBackgroundTaskRecord,
  ActoviqBuddyState,
  ActoviqCompactState,
  ActoviqDreamState,
  ActoviqPermissionMode,
  ActoviqRelevantMemory,
} from 'actoviq-agent-sdk';

export type AssistantLogLevel = 'info' | 'success' | 'warn' | 'error';
export type MissionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ActiveHoursWindow {
  start: string;
  end: string;
  timezone?: string;
}

export interface AssistantAppConfig {
  workspacePath: string;
  runtimeConfigPath: string;
  stateDir: string;
  heartbeat: {
    enabled: boolean;
    intervalMinutes: number;
    ackMaxChars: number;
    useIsolatedSession: boolean;
    prompt: string;
    activeHours?: ActiveHoursWindow;
  };
  autonomy: {
    autoRun: boolean;
    autoExtractMemory: boolean;
    autoDream: boolean;
    permissionMode: ActoviqPermissionMode;
  };
  buddy: {
    autoHatch: boolean;
    muted: boolean;
    name: string;
    personality: string;
  };
}

export interface AssistantMission {
  id: string;
  title: string;
  prompt: string;
  status: MissionStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  sessionId?: string;
  runId?: string;
  model?: string;
  resultText?: string;
  error?: string;
  toolCalls: number;
  delegatedAgents: string[];
  memoryPath?: string;
  dreamSummary?: string;
}

export interface AssistantLogEntry {
  id: string;
  at: string;
  level: AssistantLogLevel;
  scope: 'system' | 'mission' | 'heartbeat' | 'buddy' | 'memory' | 'dream' | 'background';
  text: string;
}

export interface HeartbeatRuntimeState {
  lastTickAt?: string;
  nextTickAt?: string;
  lastReason?: string;
  lastResult?: string;
  skippedCount: number;
}

export interface AssistantPersistedState {
  version: 1;
  paused: boolean;
  controlSessionId?: string;
  missions: AssistantMission[];
  logs: AssistantLogEntry[];
  heartbeats: HeartbeatRuntimeState;
}

export interface RuntimeBootstrapInfo {
  runtimeConfigPath: string;
  source: 'local' | 'copied-default';
  detectedModel?: string;
}

export interface MemoryPanelState {
  manifestPreview: string;
  sessionMemoryPreview: string;
  relevantMemories: ActoviqRelevantMemory[];
  compactState?: ActoviqCompactState;
}

export interface ControllerSnapshot {
  workspacePath: string;
  runtimeConfigPath: string;
  runtimeConfigSource: RuntimeBootstrapInfo['source'];
  detectedModel?: string;
  paused: boolean;
  busy: boolean;
  liveOutput: string;
  activeMissionId?: string;
  missions: AssistantMission[];
  logs: AssistantLogEntry[];
  heartbeats: HeartbeatRuntimeState;
  buddy?: ActoviqBuddyState;
  dream?: ActoviqDreamState;
  memory: MemoryPanelState;
  backgroundTasks: ActoviqBackgroundTaskRecord[];
}
