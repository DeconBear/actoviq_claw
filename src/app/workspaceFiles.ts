import path from 'node:path';
import { readdir } from 'node:fs/promises';

export interface WorkspacePathSuggestion {
  id: string;
  display: string;
  replacement: string;
  description: 'file' | 'directory';
}

export interface MentionToken {
  raw: string;
  search: string;
  start: number;
  end: number;
  quoted: boolean;
}

interface WorkspaceEntry {
  path: string;
  basename: string;
  type: 'file' | 'directory';
}

interface WorkspaceIndexCache {
  entries: WorkspaceEntry[];
  refreshedAt: number;
  pending?: Promise<WorkspaceEntry[]>;
}

const INDEX_CACHE = new Map<string, WorkspaceIndexCache>();
const INDEX_TTL_MS = 30_000;
const MAX_RESULTS = 10;
const AT_TOKEN_HEAD_RE = /^@[\p{L}\p{N}\p{M}_\-./\\()[\]~:]*/u;
const PATH_CHAR_HEAD_RE = /^[\p{L}\p{N}\p{M}_\-./\\()[\]~:]*/u;
const TOKEN_WITH_AT_RE = /(@[\p{L}\p{N}\p{M}_\-./\\()[\]~:]*|[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+)$/u;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.actoviq-claw',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
]);

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function isIgnoredDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name) || name.startsWith('.actoviq');
}

async function crawlWorkspace(
  workspacePath: string,
  currentDir: string,
  entries: WorkspaceEntry[],
): Promise<void> {
  const children = await readdir(currentDir, { withFileTypes: true });

  for (const child of children) {
    const absolutePath = path.join(currentDir, child.name);
    const relativePath = normalizeRelativePath(path.relative(workspacePath, absolutePath));
    if (!relativePath) {
      continue;
    }

    if (child.isDirectory()) {
      if (isIgnoredDirectory(child.name)) {
        continue;
      }
      entries.push({
        path: `${relativePath}/`,
        basename: child.name,
        type: 'directory',
      });
      await crawlWorkspace(workspacePath, absolutePath, entries);
      continue;
    }

    if (child.isFile()) {
      entries.push({
        path: relativePath,
        basename: child.name,
        type: 'file',
      });
    }
  }
}

async function buildWorkspaceIndex(workspacePath: string): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];
  await crawlWorkspace(workspacePath, workspacePath, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

async function ensureWorkspaceIndex(workspacePath: string): Promise<WorkspaceEntry[]> {
  const cached = INDEX_CACHE.get(workspacePath);
  if (cached && Date.now() - cached.refreshedAt < INDEX_TTL_MS && !cached.pending) {
    return cached.entries;
  }
  if (cached?.pending) {
    return cached.pending;
  }

  const pending = buildWorkspaceIndex(workspacePath)
    .then(entries => {
      INDEX_CACHE.set(workspacePath, {
        entries,
        refreshedAt: Date.now(),
      });
      return entries;
    })
    .catch(error => {
      const previous = INDEX_CACHE.get(workspacePath);
      if (previous) {
        previous.pending = undefined;
        INDEX_CACHE.set(workspacePath, previous);
      }
      throw error;
    });

  INDEX_CACHE.set(workspacePath, {
    entries: cached?.entries ?? [],
    refreshedAt: cached?.refreshedAt ?? 0,
    pending,
  });

  return pending;
}

export function startWorkspaceFileScan(workspacePath: string): void {
  void ensureWorkspaceIndex(workspacePath).catch(() => undefined);
}

export function extractMentionToken(input: string, cursorOffset: number): MentionToken | undefined {
  const beforeCursor = input.slice(0, cursorOffset);
  const afterCursor = input.slice(cursorOffset);

  const quotedMatch = beforeCursor.match(/(^|\s)(@"[^"]*)$/u);
  if (quotedMatch && quotedMatch.index !== undefined) {
    const rawHead = quotedMatch[2] ?? quotedMatch[0].trimStart();
    const quotedSuffix = afterCursor.match(/^[^"]*"?/u)?.[0] ?? '';
    const raw = `${rawHead}${quotedSuffix}`;
    return {
      raw,
      search: raw.slice(2).replace(/"$/u, ''),
      start: quotedMatch.index + (quotedMatch[1]?.length ?? 0),
      end: quotedMatch.index + (quotedMatch[1]?.length ?? 0) + raw.length,
      quoted: true,
    };
  }

  const atIndex = beforeCursor.lastIndexOf('@');
  if (atIndex >= 0 && (atIndex === 0 || /\s/u.test(beforeCursor[atIndex - 1] ?? ''))) {
    const fromAt = beforeCursor.slice(atIndex);
    const headMatch = fromAt.match(AT_TOKEN_HEAD_RE);
    if (headMatch && headMatch[0].length === fromAt.length) {
      const suffix = afterCursor.match(PATH_CHAR_HEAD_RE)?.[0] ?? '';
      const raw = `${headMatch[0]}${suffix}`;
      return {
        raw,
        search: raw.slice(1),
        start: atIndex,
        end: atIndex + raw.length,
        quoted: false,
      };
    }
  }

  const tokenMatch = beforeCursor.match(TOKEN_WITH_AT_RE);
  if (!tokenMatch || tokenMatch.index === undefined) {
    return undefined;
  }

  if (!tokenMatch[0].startsWith('@')) {
    return undefined;
  }

  const suffix = afterCursor.match(PATH_CHAR_HEAD_RE)?.[0] ?? '';
  const raw = `${tokenMatch[0]}${suffix}`;
  return {
    raw,
    search: raw.slice(1),
    start: tokenMatch.index,
    end: tokenMatch.index + raw.length,
    quoted: false,
  };
}

export function formatMentionReplacement(
  pathValue: string,
  type: 'file' | 'directory',
  options?: { quoted?: boolean; complete?: boolean },
): string {
  const quoted = options?.quoted ?? /\s/u.test(pathValue);
  const complete = options?.complete ?? true;

  if (quoted) {
    if (type === 'directory') {
      return complete ? `@"${pathValue}` : `@"${pathValue}`;
    }
    return complete ? `@"${pathValue}" ` : `@"${pathValue}`;
  }

  if (type === 'directory') {
    return complete ? `@${pathValue}` : `@${pathValue}`;
  }
  return complete ? `@${pathValue} ` : `@${pathValue}`;
}

export function applyMentionSuggestion(
  input: string,
  cursorOffset: number,
  token: MentionToken,
  suggestion: WorkspacePathSuggestion,
): { value: string; cursorOffset: number } {
  const after = input.slice(token.end);
  const replacement =
    suggestion.replacement.endsWith(' ') && /^\s/u.test(after)
      ? suggestion.replacement.slice(0, -1)
      : suggestion.replacement;
  const nextValue = `${input.slice(0, token.start)}${replacement}${after}`;
  return {
    value: nextValue,
    cursorOffset: token.start + replacement.length,
  };
}

function entryScore(entry: WorkspaceEntry, searchToken: string): number {
  const normalizedPath = entry.path.toLowerCase();
  const normalizedBase = entry.basename.toLowerCase();
  const normalizedSearch = searchToken.toLowerCase().replace(/\\/g, '/').replace(/^\.?\//u, '');

  if (!normalizedSearch) {
    return entry.type === 'directory' ? 0 : 1;
  }

  if (normalizedBase === normalizedSearch) return 0;
  if (normalizedPath === normalizedSearch) return 1;
  if (normalizedBase.startsWith(normalizedSearch)) return 2;
  if (normalizedPath.startsWith(normalizedSearch)) return 3;
  if (normalizedBase.includes(normalizedSearch)) return 4;
  if (normalizedPath.includes(normalizedSearch)) return 5;
  return Number.POSITIVE_INFINITY;
}

export async function getWorkspacePathSuggestions(
  workspacePath: string,
  searchToken: string,
  maxResults = MAX_RESULTS,
): Promise<WorkspacePathSuggestion[]> {
  const entries = await ensureWorkspaceIndex(workspacePath);
  const ranked = entries
    .map(entry => ({
      entry,
      score: entryScore(entry, searchToken),
    }))
    .filter(result => Number.isFinite(result.score))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      if (left.entry.type !== right.entry.type) {
        return left.entry.type === 'directory' ? -1 : 1;
      }
      return left.entry.path.localeCompare(right.entry.path);
    })
    .slice(0, maxResults);

  return ranked.map(({ entry }) => ({
    id: `${entry.type}:${entry.path}`,
    display: entry.path,
    replacement: formatMentionReplacement(entry.path, entry.type),
    description: entry.type,
  }));
}
