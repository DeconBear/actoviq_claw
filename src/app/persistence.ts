import path from 'node:path';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';

import {
  getLoadedJsonConfig,
  loadDefaultActoviqSettings,
  loadJsonConfigFile,
} from 'actoviq-agent-sdk';

import { buildDefaultConfig, DEFAULT_HEARTBEAT_TEMPLATE } from './defaults.js';
import { defaultAllowedTools, normalizePermissionPreset } from './permissions.js';
import type {
  AssistantAppConfig,
  AssistantArchivedChat,
  AssistantPersistedState,
  RuntimeBootstrapInfo,
} from './types.js';

const CONFIG_FILENAME = 'actoviq-claw.config.json';
const STATE_FILENAME = 'state.json';
const HEARTBEAT_FILENAME = 'HEARTBEAT.md';
const HISTORY_FILENAME_RE = /^chat_[a-z0-9]+_[a-z0-9]+\.json$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createChatId(): string {
  return `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultChatTitle(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return 'Chat';
  }
  return `Chat ${date.toLocaleString()}`;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries: Array<[string, string]> = Object.entries(value).flatMap(
    ([key, entryValue]) =>
      key.trim().length > 0 && typeof entryValue === 'string'
        ? [[key, entryValue]]
        : [],
  );
  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

function normalizeMcpServers(value: unknown, workspacePath: string): AssistantAppConfig['tooling']['mcpServers'] {
  if (!Array.isArray(value)) {
    return [];
  }

  const servers: AssistantAppConfig['tooling']['mcpServers'] = [];

  for (const server of value) {
    if (!isRecord(server) || typeof server.kind !== 'string' || typeof server.name !== 'string') {
      continue;
    }

    const prefix =
      typeof server.prefix === 'string' && server.prefix.trim() ? server.prefix.trim() : undefined;

    if (server.kind === 'stdio' && typeof server.command === 'string' && server.command.trim()) {
      servers.push({
        kind: 'stdio',
        name: server.name.trim(),
        command: server.command,
        args: Array.isArray(server.args)
          ? server.args.filter((entry): entry is string => typeof entry === 'string')
          : undefined,
        env: stringRecord(server.env),
        cwd:
          typeof server.cwd === 'string' && server.cwd.trim()
            ? path.resolve(workspacePath, server.cwd)
            : undefined,
        prefix,
        stderr:
          server.stderr === 'inherit' || server.stderr === 'ignore' || server.stderr === 'pipe'
            ? server.stderr
            : undefined,
      });
      continue;
    }

    if (server.kind === 'streamable_http' && typeof server.url === 'string' && server.url.trim()) {
      servers.push({
        kind: 'streamable_http',
        name: server.name.trim(),
        url: server.url,
        headers: stringRecord(server.headers),
        sessionId:
          typeof server.sessionId === 'string' && server.sessionId.trim()
            ? server.sessionId.trim()
            : undefined,
        prefix,
      });
    }
  }

  return servers;
}

function normalizeChats(value: unknown): AssistantArchivedChat[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map(chat => {
      const createdAt = typeof chat.createdAt === 'string' ? chat.createdAt : nowIso();
      const updatedAt = typeof chat.updatedAt === 'string' ? chat.updatedAt : createdAt;
      const archivedAt = typeof chat.archivedAt === 'string' ? chat.archivedAt : updatedAt;
      return {
        id: typeof chat.id === 'string' && chat.id.trim() ? chat.id : createChatId(),
        title:
          typeof chat.title === 'string' && chat.title.trim()
            ? chat.title
            : defaultChatTitle(createdAt),
        workspacePath:
          typeof chat.workspacePath === 'string' && chat.workspacePath.trim()
            ? path.resolve(chat.workspacePath)
            : '',
        createdAt,
        updatedAt,
        archivedAt,
        missions: asArray<AssistantArchivedChat['missions'][number]>(chat.missions),
        logs: asArray<AssistantArchivedChat['logs'][number]>(chat.logs),
      };
    })
    .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
}

function normalizeState(raw: unknown): AssistantPersistedState {
  const defaults = defaultPersistedState();
  if (!isRecord(raw)) {
    return defaults;
  }

  if (raw.version === 2) {
    const currentChatCreatedAt =
      typeof raw.currentChatCreatedAt === 'string' ? raw.currentChatCreatedAt : defaults.currentChatCreatedAt;
    return {
      version: 2,
      paused: typeof raw.paused === 'boolean' ? raw.paused : defaults.paused,
      controlSessionId:
        typeof raw.controlSessionId === 'string' && raw.controlSessionId.trim()
          ? raw.controlSessionId
          : undefined,
      currentChatId:
        typeof raw.currentChatId === 'string' && raw.currentChatId.trim()
          ? raw.currentChatId
          : defaults.currentChatId,
      currentChatTitle:
        typeof raw.currentChatTitle === 'string' && raw.currentChatTitle.trim()
          ? raw.currentChatTitle
          : defaultChatTitle(currentChatCreatedAt),
      currentChatCreatedAt,
      currentChatRestoredFromId:
        typeof raw.currentChatRestoredFromId === 'string' && raw.currentChatRestoredFromId.trim()
          ? raw.currentChatRestoredFromId
          : undefined,
      chats: normalizeChats(raw.chats),
      missions: asArray<AssistantPersistedState['missions'][number]>(raw.missions),
      logs: asArray<AssistantPersistedState['logs'][number]>(raw.logs),
      heartbeats: isRecord(raw.heartbeats)
        ? {
            lastTickAt: typeof raw.heartbeats.lastTickAt === 'string' ? raw.heartbeats.lastTickAt : undefined,
            nextTickAt: typeof raw.heartbeats.nextTickAt === 'string' ? raw.heartbeats.nextTickAt : undefined,
            lastReason: typeof raw.heartbeats.lastReason === 'string' ? raw.heartbeats.lastReason : undefined,
            lastResult: typeof raw.heartbeats.lastResult === 'string' ? raw.heartbeats.lastResult : undefined,
            skippedCount:
              typeof raw.heartbeats.skippedCount === 'number'
                ? raw.heartbeats.skippedCount
                : defaults.heartbeats.skippedCount,
          }
        : defaults.heartbeats,
    };
  }

  const missions = asArray<AssistantPersistedState['missions'][number]>(raw.missions);
  const logs = asArray<AssistantPersistedState['logs'][number]>(raw.logs);
  const firstTimestamp =
    missions[0]?.createdAt ??
    logs[0]?.at ??
    defaults.currentChatCreatedAt;

  return {
    version: 2,
    paused: typeof raw.paused === 'boolean' ? raw.paused : defaults.paused,
    controlSessionId:
      typeof raw.controlSessionId === 'string' && raw.controlSessionId.trim()
        ? raw.controlSessionId
        : undefined,
    currentChatId: createChatId(),
    currentChatTitle: defaultChatTitle(firstTimestamp),
    currentChatCreatedAt: firstTimestamp,
    currentChatRestoredFromId: undefined,
    chats: [],
    missions,
    logs,
    heartbeats: isRecord(raw.heartbeats)
      ? {
          lastTickAt: typeof raw.heartbeats.lastTickAt === 'string' ? raw.heartbeats.lastTickAt : undefined,
          nextTickAt: typeof raw.heartbeats.nextTickAt === 'string' ? raw.heartbeats.nextTickAt : undefined,
          lastReason: typeof raw.heartbeats.lastReason === 'string' ? raw.heartbeats.lastReason : undefined,
          lastResult: typeof raw.heartbeats.lastResult === 'string' ? raw.heartbeats.lastResult : undefined,
          skippedCount:
            typeof raw.heartbeats.skippedCount === 'number'
              ? raw.heartbeats.skippedCount
              : defaults.heartbeats.skippedCount,
        }
      : defaults.heartbeats,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  if (!(await fileExists(filePath))) {
    return undefined;
  }
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function mergeConfig(defaults: AssistantAppConfig, raw: unknown): AssistantAppConfig {
  if (!isRecord(raw)) {
    return defaults;
  }

  const heartbeat = isRecord(raw.heartbeat) ? raw.heartbeat : {};
  const autonomy = isRecord(raw.autonomy) ? raw.autonomy : {};
  const buddy = isRecord(raw.buddy) ? raw.buddy : {};
  const tooling = isRecord(raw.tooling) ? raw.tooling : {};
  const workspacePath =
    typeof raw.workspacePath === 'string' && raw.workspacePath.trim()
      ? path.resolve(raw.workspacePath)
      : defaults.workspacePath;
  const legacyPermissionPreset =
    autonomy.permissionMode === 'acceptEdits'
      ? 'workspace-only'
      : autonomy.permissionMode === 'plan'
      ? 'chat-only'
      : defaults.autonomy.permissionPreset;

  return {
    workspacePath:
      workspacePath,
    runtimeConfigPath:
      typeof raw.runtimeConfigPath === 'string' && raw.runtimeConfigPath.trim()
        ? path.resolve(raw.runtimeConfigPath)
        : defaults.runtimeConfigPath,
    stateDir:
      typeof raw.stateDir === 'string' && raw.stateDir.trim()
        ? path.resolve(raw.stateDir)
        : defaults.stateDir,
    historyDir:
      typeof raw.historyDir === 'string' && raw.historyDir.trim()
        ? path.resolve(raw.historyDir)
        : defaults.historyDir,
    tooling: {
      enableComputerUse:
        typeof tooling.enableComputerUse === 'boolean'
          ? tooling.enableComputerUse
          : defaults.tooling.enableComputerUse,
      computerUsePrefix:
        typeof tooling.computerUsePrefix === 'string' && tooling.computerUsePrefix.trim()
          ? tooling.computerUsePrefix.trim()
          : defaults.tooling.computerUsePrefix,
      mcpServers:
        normalizeMcpServers(tooling.mcpServers, workspacePath) ?? defaults.tooling.mcpServers,
    },
    heartbeat: {
      enabled:
        typeof heartbeat.enabled === 'boolean' ? heartbeat.enabled : defaults.heartbeat.enabled,
      guideFilePath:
        typeof heartbeat.guideFilePath === 'string' && heartbeat.guideFilePath.trim()
          ? path.resolve(
              workspacePath,
              heartbeat.guideFilePath,
            )
          : defaults.heartbeat.guideFilePath,
      intervalMinutes:
        typeof heartbeat.intervalMinutes === 'number'
          ? heartbeat.intervalMinutes
          : defaults.heartbeat.intervalMinutes,
      ackMaxChars:
        typeof heartbeat.ackMaxChars === 'number'
          ? heartbeat.ackMaxChars
          : defaults.heartbeat.ackMaxChars,
      useIsolatedSession:
        typeof heartbeat.useIsolatedSession === 'boolean'
          ? heartbeat.useIsolatedSession
          : defaults.heartbeat.useIsolatedSession,
      prompt:
        typeof heartbeat.prompt === 'string' && heartbeat.prompt.trim()
          ? heartbeat.prompt
          : defaults.heartbeat.prompt,
      activeHours: isRecord(heartbeat.activeHours)
        ? {
            start:
              typeof heartbeat.activeHours.start === 'string'
                ? heartbeat.activeHours.start
                : defaults.heartbeat.activeHours?.start ?? '08:00',
            end:
              typeof heartbeat.activeHours.end === 'string'
                ? heartbeat.activeHours.end
                : defaults.heartbeat.activeHours?.end ?? '23:30',
            timezone:
              typeof heartbeat.activeHours.timezone === 'string'
                ? heartbeat.activeHours.timezone
                : defaults.heartbeat.activeHours?.timezone,
          }
        : defaults.heartbeat.activeHours,
    },
    autonomy: {
      autoRun:
        typeof autonomy.autoRun === 'boolean' ? autonomy.autoRun : defaults.autonomy.autoRun,
      autoExtractMemory:
        typeof autonomy.autoExtractMemory === 'boolean'
          ? autonomy.autoExtractMemory
          : defaults.autonomy.autoExtractMemory,
      autoDream:
        typeof autonomy.autoDream === 'boolean'
          ? autonomy.autoDream
          : defaults.autonomy.autoDream,
      permissionMode:
        autonomy.permissionMode === 'default' ||
        autonomy.permissionMode === 'acceptEdits' ||
        autonomy.permissionMode === 'bypassPermissions' ||
        autonomy.permissionMode === 'plan' ||
        autonomy.permissionMode === 'auto'
          ? autonomy.permissionMode
          : defaults.autonomy.permissionMode,
      permissionPreset: normalizePermissionPreset(
        typeof autonomy.permissionPreset === 'string' ? autonomy.permissionPreset : undefined,
        legacyPermissionPreset,
      ),
      allowedTools:
        Array.isArray(autonomy.allowedTools)
          ? autonomy.allowedTools.filter(
              (value): value is string => typeof value === 'string' && value.trim().length > 0,
            )
          : defaults.autonomy.allowedTools ?? defaultAllowedTools(),
    },
    buddy: {
      autoHatch:
        typeof buddy.autoHatch === 'boolean' ? buddy.autoHatch : defaults.buddy.autoHatch,
      muted: typeof buddy.muted === 'boolean' ? buddy.muted : defaults.buddy.muted,
      name:
        typeof buddy.name === 'string' && buddy.name.trim()
          ? buddy.name
          : defaults.buddy.name,
      personality:
        typeof buddy.personality === 'string' && buddy.personality.trim()
          ? buddy.personality
          : defaults.buddy.personality,
    },
  };
}

function getEnvValue(
  env: Record<string, unknown> | Record<string, string>,
  key: string,
): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function applyActoviqEnvAliases(): void {
  const loaded = getLoadedJsonConfig();
  const raw = loaded?.raw;
  const loadedEnv =
    raw && isRecord(raw.env)
      ? raw.env
      : {};

  const resolvedBaseUrl =
    process.env.ACTOVIQ_BASE_URL ??
    getEnvValue(loadedEnv, 'ACTOVIQ_BASE_URL') ??
    process.env.ANTHROPIC_BASE_URL ??
    getEnvValue(loadedEnv, 'ANTHROPIC_BASE_URL');

  const resolvedAuthToken =
    process.env.ACTOVIQ_AUTH_TOKEN ??
    getEnvValue(loadedEnv, 'ACTOVIQ_AUTH_TOKEN') ??
    process.env.ANTHROPIC_AUTH_TOKEN ??
    getEnvValue(loadedEnv, 'ANTHROPIC_AUTH_TOKEN');

  const resolvedModel =
    process.env.ACTOVIQ_MODEL ??
    getEnvValue(loadedEnv, 'ACTOVIQ_MODEL') ??
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
    getEnvValue(loadedEnv, 'ANTHROPIC_DEFAULT_SONNET_MODEL') ??
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ??
    getEnvValue(loadedEnv, 'ANTHROPIC_DEFAULT_OPUS_MODEL') ??
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??
    getEnvValue(loadedEnv, 'ANTHROPIC_DEFAULT_HAIKU_MODEL');

  if (resolvedBaseUrl && !process.env.ACTOVIQ_BASE_URL) {
    process.env.ACTOVIQ_BASE_URL = resolvedBaseUrl;
  }
  if (resolvedAuthToken && !process.env.ACTOVIQ_AUTH_TOKEN) {
    process.env.ACTOVIQ_AUTH_TOKEN = resolvedAuthToken;
  }
  if (resolvedModel && !process.env.ACTOVIQ_MODEL) {
    process.env.ACTOVIQ_MODEL = resolvedModel;
  }
}

export async function loadOrCreateAppConfig(rootDir: string): Promise<AssistantAppConfig> {
  const defaults = buildDefaultConfig(rootDir);
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  const loaded = await readJsonFile<unknown>(configPath);
  const merged = mergeConfig(defaults, loaded);
  if (!loaded) {
    await writeJsonFile(configPath, merged);
  }
  return merged;
}

export async function saveAppConfig(rootDir: string, config: AssistantAppConfig): Promise<void> {
  await writeJsonFile(path.join(rootDir, CONFIG_FILENAME), config);
}

export async function ensureHeartbeatTemplate(heartbeatPath: string): Promise<string> {
  if (!(await fileExists(heartbeatPath))) {
    await ensureDirectory(path.dirname(heartbeatPath));
    await writeFile(heartbeatPath, DEFAULT_HEARTBEAT_TEMPLATE, 'utf8');
  }
  return heartbeatPath;
}

export async function ensureRuntimeConfig(
  runtimeConfigPath: string,
): Promise<RuntimeBootstrapInfo> {
  if (await fileExists(runtimeConfigPath)) {
    await loadJsonConfigFile(runtimeConfigPath);
    applyActoviqEnvAliases();
    return {
      runtimeConfigPath,
      source: 'local',
      detectedModel: detectModelFromLoadedConfig(),
    };
  }

  await loadDefaultActoviqSettings();
  const loaded = getLoadedJsonConfig();
  if (!loaded) {
    throw new Error(
      'No Actoviq runtime configuration was found. Create ~/.actoviq/settings.json or provide actoviq-claw.runtime.settings.local.json.',
    );
  }

  const payload =
    loaded.raw && isRecord(loaded.raw)
      ? loaded.raw
      : {
          env: loaded.env,
        };

  await writeJsonFile(runtimeConfigPath, payload);
  await loadJsonConfigFile(runtimeConfigPath);
  applyActoviqEnvAliases();
  return {
    runtimeConfigPath,
    source: 'copied-default',
    detectedModel: detectModelFromLoadedConfig(),
  };
}

function detectModelFromLoadedConfig(): string | undefined {
  const loaded = getLoadedJsonConfig();
  if (!loaded) {
    return undefined;
  }

  if (loaded.raw && isRecord(loaded.raw)) {
    const topLevel = loaded.raw.ACTOVIQ_MODEL;
    if (typeof topLevel === 'string' && topLevel.trim()) {
      return topLevel;
    }
    if (isRecord(loaded.raw.env) && typeof loaded.raw.env.ACTOVIQ_MODEL === 'string') {
      return loaded.raw.env.ACTOVIQ_MODEL;
    }
    if (
      isRecord(loaded.raw.env) &&
      typeof loaded.raw.env.ANTHROPIC_DEFAULT_SONNET_MODEL === 'string'
    ) {
      return loaded.raw.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    }
    if (
      isRecord(loaded.raw.env) &&
      typeof loaded.raw.env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'string'
    ) {
      return loaded.raw.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    }
    if (
      isRecord(loaded.raw.env) &&
      typeof loaded.raw.env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'string'
    ) {
      return loaded.raw.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    }
  }

  return (
    (typeof loaded.env.ACTOVIQ_MODEL === 'string' ? loaded.env.ACTOVIQ_MODEL : undefined) ??
    (typeof loaded.env.ANTHROPIC_DEFAULT_SONNET_MODEL === 'string'
      ? loaded.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      : undefined) ??
    (typeof loaded.env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'string'
      ? loaded.env.ANTHROPIC_DEFAULT_OPUS_MODEL
      : undefined) ??
    (typeof loaded.env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'string'
      ? loaded.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
      : undefined)
  );
}

export function defaultPersistedState(): AssistantPersistedState {
  const createdAt = nowIso();
  return {
    version: 2,
    paused: false,
    currentChatId: createChatId(),
    currentChatTitle: defaultChatTitle(createdAt),
    currentChatCreatedAt: createdAt,
    chats: [],
    missions: [],
    logs: [],
    heartbeats: {
      skippedCount: 0,
    },
  };
}

export async function loadOrCreateState(stateDir: string): Promise<AssistantPersistedState> {
  const statePath = path.join(stateDir, STATE_FILENAME);
  const loaded = await readJsonFile<unknown>(statePath);
  const next = normalizeState(loaded);
  if (!loaded || JSON.stringify(loaded) !== JSON.stringify(next)) {
    await writeJsonFile(statePath, next);
  }
  return next;
}

export async function saveState(stateDir: string, state: AssistantPersistedState): Promise<void> {
  await writeJsonFile(path.join(stateDir, STATE_FILENAME), state);
}

export async function loadArchivedChats(historyDir: string): Promise<AssistantArchivedChat[]> {
  if (!(await fileExists(historyDir))) {
    return [];
  }

  const { readdir } = await import('node:fs/promises');
  const files = await readdir(historyDir, { withFileTypes: true });
  const chats: AssistantArchivedChat[] = [];

  for (const entry of files) {
    if (!entry.isFile() || !HISTORY_FILENAME_RE.test(entry.name)) {
      continue;
    }

    const raw = await readJsonFile<unknown>(path.join(historyDir, entry.name));
    const normalized = normalizeChats(raw ? [raw] : []);
    if (normalized[0]) {
      chats.push(normalized[0]);
    }
  }

  return chats.sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
}

export async function saveArchivedChats(
  historyDir: string,
  chats: readonly AssistantArchivedChat[],
): Promise<void> {
  await ensureDirectory(historyDir);
  await Promise.all(
    chats.map(chat => writeJsonFile(path.join(historyDir, `${chat.id}.json`), chat)),
  );
}
