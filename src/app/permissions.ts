import type {
  ActoviqPermissionMode,
  ActoviqPermissionRule,
} from 'actoviq-agent-sdk';

export type PermissionPreset = 'chat-only' | 'workspace-only' | 'full-access';

export const DEFAULT_FILE_TOOL_NAMES = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;
export const DEFAULT_MODEL_TOOL_NAMES = [...DEFAULT_FILE_TOOL_NAMES, 'Task'] as const;

export function defaultAllowedTools(): string[] {
  return [...DEFAULT_MODEL_TOOL_NAMES];
}

export function normalizePermissionPreset(
  value: string | undefined,
  fallback: PermissionPreset = 'full-access',
): PermissionPreset {
  if (value === 'chat-only' || value === 'workspace-only' || value === 'full-access') {
    return value;
  }
  return fallback;
}

export function permissionPresetToMode(preset: PermissionPreset): ActoviqPermissionMode {
  switch (preset) {
    case 'chat-only':
      return 'default';
    case 'workspace-only':
      return 'acceptEdits';
    case 'full-access':
    default:
      return 'bypassPermissions';
  }
}

export function permissionPresetLabel(preset: PermissionPreset): string {
  switch (preset) {
    case 'chat-only':
      return 'chat only';
    case 'workspace-only':
      return 'workspace only';
    case 'full-access':
    default:
      return 'full access';
  }
}

export function canonicalizeAllowedTools(
  availableTools: readonly string[],
  configuredAllowedTools: readonly string[],
): string[] {
  if (availableTools.length === 0) {
    return [...configuredAllowedTools];
  }

  const configured = new Set(configuredAllowedTools.map(value => value.trim().toLowerCase()).filter(Boolean));
  return availableTools.filter(toolName => configured.has(toolName.toLowerCase()));
}

export function profileAllowedTools(
  preset: PermissionPreset,
  availableTools: readonly string[],
): string[] {
  switch (preset) {
    case 'chat-only':
      return [];
    case 'workspace-only':
      return availableTools.filter(toolName => DEFAULT_FILE_TOOL_NAMES.includes(toolName as (typeof DEFAULT_FILE_TOOL_NAMES)[number]));
    case 'full-access':
    default:
      return [...availableTools];
  }
}

export function computeEffectiveAllowedTools(
  preset: PermissionPreset,
  availableTools: readonly string[],
  configuredAllowedTools: readonly string[],
): string[] {
  const configured = canonicalizeAllowedTools(availableTools, configuredAllowedTools);
  const allowedByPreset = new Set(profileAllowedTools(preset, availableTools));
  return configured.filter(toolName => allowedByPreset.has(toolName));
}

export function buildPermissionRules(
  availableTools: readonly string[],
  effectiveAllowedTools: readonly string[],
): ActoviqPermissionRule[] {
  const canonicalAllowed = canonicalizeAllowedTools(availableTools, effectiveAllowedTools);
  if (canonicalAllowed.length >= availableTools.length) {
    return [];
  }

  return [
    ...canonicalAllowed.map(toolName => ({
      toolName,
      behavior: 'allow' as const,
    })),
    {
      toolName: '*',
      behavior: 'deny' as const,
    },
  ];
}

export function toolPermissionStatus(
  toolName: string,
  preset: PermissionPreset,
  availableTools: readonly string[],
  configuredAllowedTools: readonly string[],
): 'enabled' | 'blocked-by-preset' | 'disabled' {
  const configured = new Set(canonicalizeAllowedTools(availableTools, configuredAllowedTools));
  const allowedByPreset = new Set(profileAllowedTools(preset, availableTools));

  if (!configured.has(toolName)) {
    return 'disabled';
  }
  if (!allowedByPreset.has(toolName)) {
    return 'blocked-by-preset';
  }
  return 'enabled';
}
