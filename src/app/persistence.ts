import path from 'node:path';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';

import {
  getLoadedJsonConfig,
  loadDefaultActoviqSettings,
  loadJsonConfigFile,
} from 'actoviq-agent-sdk';

import { buildDefaultConfig, DEFAULT_HEARTBEAT_TEMPLATE } from './defaults.js';
import type {
  AssistantAppConfig,
  AssistantPersistedState,
  RuntimeBootstrapInfo,
} from './types.js';

const CONFIG_FILENAME = 'actoviq-claw.config.json';
const STATE_FILENAME = 'state.json';
const HEARTBEAT_FILENAME = 'HEARTBEAT.md';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

  return {
    workspacePath:
      typeof raw.workspacePath === 'string' && raw.workspacePath.trim()
        ? path.resolve(raw.workspacePath)
        : defaults.workspacePath,
    runtimeConfigPath:
      typeof raw.runtimeConfigPath === 'string' && raw.runtimeConfigPath.trim()
        ? path.resolve(raw.runtimeConfigPath)
        : defaults.runtimeConfigPath,
    stateDir:
      typeof raw.stateDir === 'string' && raw.stateDir.trim()
        ? path.resolve(raw.stateDir)
        : defaults.stateDir,
    heartbeat: {
      enabled:
        typeof heartbeat.enabled === 'boolean' ? heartbeat.enabled : defaults.heartbeat.enabled,
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

export async function ensureHeartbeatTemplate(workspacePath: string): Promise<string> {
  const heartbeatPath = path.join(workspacePath, HEARTBEAT_FILENAME);
  if (!(await fileExists(heartbeatPath))) {
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
  return {
    version: 1,
    paused: false,
    missions: [],
    logs: [],
    heartbeats: {
      skippedCount: 0,
    },
  };
}

export async function loadOrCreateState(stateDir: string): Promise<AssistantPersistedState> {
  const statePath = path.join(stateDir, STATE_FILENAME);
  const loaded = await readJsonFile<AssistantPersistedState>(statePath);
  const next = loaded ?? defaultPersistedState();
  if (!loaded) {
    await writeJsonFile(statePath, next);
  }
  return next;
}

export async function saveState(stateDir: string, state: AssistantPersistedState): Promise<void> {
  await writeJsonFile(path.join(stateDir, STATE_FILENAME), state);
}
