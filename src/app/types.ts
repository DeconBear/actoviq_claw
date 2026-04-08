import type {
  ActoviqBackgroundTaskRecord,
  ActoviqBuddyState,
  ActoviqCleanToolMetadata,
  ActoviqCompactState,
  ActoviqDreamState,
  AgentMcpServerDefinition,
  ActoviqPermissionMode,
  ActoviqRelevantMemory,
} from 'actoviq-agent-sdk';
import type { PermissionPreset } from './permissions.js';

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
  historyDir: string;
  tooling: {
    enableComputerUse: boolean;
    computerUsePrefix?: string;
    mcpServers: AgentMcpServerDefinition[];
  };
  heartbeat: {
    enabled: boolean;
    guideFilePath: string;
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
    permissionPreset: PermissionPreset;
    allowedTools: string[];
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

export interface AssistantArchivedChat {
  id: string;
  title: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string;
  missions: AssistantMission[];
  logs: AssistantLogEntry[];
}

export interface AssistantChatSummary {
  id: string;
  title: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string;
  missionCount: number;
  preview: string;
}

export interface AssistantPersistedState {
  version: 2;
  paused: boolean;
  controlSessionId?: string;
  currentChatId: string;
  currentChatTitle: string;
  currentChatCreatedAt: string;
  currentChatRestoredFromId?: string;
  chats: AssistantArchivedChat[];
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
  historyDir: string;
  detectedModel?: string;
  permissionMode: ActoviqPermissionMode;
  permissionPreset: PermissionPreset;
  availableTools: ActoviqCleanToolMetadata[];
  configuredAllowedTools: string[];
  effectiveAllowedTools: string[];
  autoRunEnabled: boolean;
  autoExtractMemoryEnabled: boolean;
  autoDreamEnabled: boolean;
  heartbeatEnabled: boolean;
  heartbeatGuideFilePath: string;
  heartbeatIntervalMinutes: number;
  heartbeatUseIsolatedSession: boolean;
  heartbeatActiveHours?: ActiveHoursWindow;
  currentChatId: string;
  currentChatTitle: string;
  currentChatRestoredFromId?: string;
  archivedChats: AssistantChatSummary[];
  paused: boolean;
  busy: boolean;
  liveOutput: string;
  activeMissionId?: string;
  missions: AssistantMission[];
  logs: AssistantLogEntry[];
  heartbeats: HeartbeatRuntimeState;
  buddy?: ActoviqBuddyState;
  buddyReactionText?: string;
  buddyReactionAt?: number;
  buddyIntroText?: string;
  dream?: ActoviqDreamState;
  memory: MemoryPanelState;
  backgroundTasks: ActoviqBackgroundTaskRecord[];
}
