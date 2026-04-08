import { describe, expect, it } from 'vitest';

import {
  buildPermissionRules,
  computeEffectiveAllowedTools,
  permissionPresetToMode,
  toolPermissionStatus,
} from '../src/app/permissions.js';

const AVAILABLE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'];

describe('permission presets', () => {
  it('maps the three UI presets to runtime permission modes', () => {
    expect(permissionPresetToMode('chat-only')).toBe('default');
    expect(permissionPresetToMode('workspace-only')).toBe('acceptEdits');
    expect(permissionPresetToMode('full-access')).toBe('bypassPermissions');
  });

  it('caps workspace-only to file tools even if Task is configured', () => {
    expect(
      computeEffectiveAllowedTools('workspace-only', AVAILABLE_TOOLS, AVAILABLE_TOOLS),
    ).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
  });

  it('removes every tool in chat-only mode', () => {
    expect(
      computeEffectiveAllowedTools('chat-only', AVAILABLE_TOOLS, AVAILABLE_TOOLS),
    ).toEqual([]);
  });
});

describe('tool permission rules', () => {
  it('builds explicit allow rules followed by a deny fallback', () => {
    expect(buildPermissionRules(AVAILABLE_TOOLS, ['Read', 'Write'])).toEqual([
      { toolName: 'Read', behavior: 'allow' },
      { toolName: 'Write', behavior: 'allow' },
      { toolName: '*', behavior: 'deny' },
    ]);
  });

  it('reports disabled tools blocked by the active preset separately', () => {
    expect(toolPermissionStatus('Task', 'workspace-only', AVAILABLE_TOOLS, AVAILABLE_TOOLS)).toBe(
      'blocked-by-preset',
    );
    expect(toolPermissionStatus('Task', 'full-access', AVAILABLE_TOOLS, ['Read', 'Write'])).toBe(
      'disabled',
    );
    expect(toolPermissionStatus('Read', 'workspace-only', AVAILABLE_TOOLS, AVAILABLE_TOOLS)).toBe(
      'enabled',
    );
  });
});
