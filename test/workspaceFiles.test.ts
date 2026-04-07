import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  applyMentionSuggestion,
  extractMentionToken,
  formatMentionReplacement,
  getWorkspacePathSuggestions,
} from '../src/app/workspaceFiles.js';

describe('workspace file suggestions', () => {
  it('finds workspace files and applies @ mention completions', async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'actoviq-claw-workspace-'));
    await mkdir(path.join(workspacePath, 'src', 'app'), { recursive: true });
    await mkdir(path.join(workspacePath, 'docs'), { recursive: true });
    await writeFile(path.join(workspacePath, 'src', 'app', 'main.ts'), 'export {};', 'utf8');
    await writeFile(path.join(workspacePath, 'docs', 'release notes.md'), '# Notes', 'utf8');

    const suggestions = await getWorkspacePathSuggestions(workspacePath, 'main');
    const mainSuggestion = suggestions.find(item => item.display === 'src/app/main.ts');
    expect(mainSuggestion).toBeDefined();

    const input = 'Please review @src/ap';
    const token = extractMentionToken(input, input.length);
    expect(token).toEqual({
      raw: '@src/ap',
      search: 'src/ap',
      start: 'Please review '.length,
      end: input.length,
      quoted: false,
    });

    const applied = applyMentionSuggestion(input, input.length, token!, mainSuggestion!);
    expect(applied.value).toBe('Please review @src/app/main.ts ');
    expect(applied.cursorOffset).toBe(applied.value.length);
  });

  it('extracts quoted mentions around the cursor and replaces the full token', () => {
    const input = 'Check @"docs/release notes.md" please';
    const cursorOffset = 'Check @"docs/rele'.length;
    const token = extractMentionToken(input, cursorOffset);

    expect(token).toEqual({
      raw: '@"docs/release notes.md"',
      search: 'docs/release notes.md',
      start: 'Check '.length,
      end: 'Check @"docs/release notes.md"'.length,
      quoted: true,
    });

    const applied = applyMentionSuggestion(input, cursorOffset, token!, {
      id: 'file:docs/release notes.md',
      display: 'docs/release notes.md',
      replacement: formatMentionReplacement('docs/release notes.md', 'file', { quoted: true }),
      description: 'file',
    });

    expect(applied.value).toBe('Check @"docs/release notes.md" please');
  });

  it('formats partial directory replacements without closing the mention', () => {
    expect(formatMentionReplacement('src/app/', 'directory', { complete: false })).toBe('@src/app/');
    expect(formatMentionReplacement('docs/release notes', 'file', { quoted: true, complete: false })).toBe(
      '@"docs/release notes',
    );
  });

  it('keeps the full mention token when the cursor is in the middle of a path', () => {
    const input = 'Use @src/app/main.ts for context';
    const token = extractMentionToken(input, 'Use @src/ap'.length);

    expect(token).toEqual({
      raw: '@src/app/main.ts',
      search: 'src/app/main.ts',
      start: 'Use '.length,
      end: 'Use @src/app/main.ts'.length,
      quoted: false,
    });
  });
});
