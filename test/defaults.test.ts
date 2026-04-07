import { describe, expect, it } from 'vitest';

import { buildDefaultTools, DEFAULT_HEARTBEAT_PROMPT, DEFAULT_SYSTEM_PROMPT } from '../src/app/defaults.js';

describe('default sdk tools', () => {
  it('includes the workspace file tools needed by chat and heartbeat flows', () => {
    const tools = buildDefaultTools('E:/workspace');
    const toolNames = tools.map(tool => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Glob', 'Grep']));
  });
});

describe('default prompts', () => {
  it('tells heartbeat to use file tools for HEARTBEAT.md', () => {
    expect(DEFAULT_HEARTBEAT_PROMPT).toContain('file tools');
  });

  it('tells the assistant it can directly inspect and modify workspace files', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Read, Glob, Grep, Edit, and Write');
  });
});
