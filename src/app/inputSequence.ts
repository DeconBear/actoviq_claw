import { Cursor } from './claudecode/Cursor.js';

export type TerminalKeyState = Record<string, boolean | undefined>;

const RAW_KEY_SEQUENCES = {
  upArrow: ['\u001b[A', '\u001bOA', '\u0000H', '\u00e0H'],
  downArrow: ['\u001b[B', '\u001bOB', '\u0000P', '\u00e0P'],
  rightArrow: ['\u001b[C', '\u001bOC', '\u0000M', '\u00e0M'],
  leftArrow: ['\u001b[D', '\u001bOD', '\u0000K', '\u00e0K'],
  home: ['\u001b[H', '\u001b[1~', '\u001bOH', '\u0000G', '\u00e0G'],
  end: ['\u001b[F', '\u001b[4~', '\u001bOF', '\u0000O', '\u00e0O'],
  pageUp: ['\u001b[5~', '\u0000I', '\u00e0I'],
  pageDown: ['\u001b[6~', '\u0000Q', '\u00e0Q'],
  delete: ['\u001b[3~', '\u0000S', '\u00e0S'],
} satisfies Record<string, readonly string[]>;

function rawMatches(raw: string | undefined, sequences: readonly string[]): boolean {
  return Boolean(raw && sequences.includes(raw));
}

function parseRawMouseWheel(rawInput: string | undefined): { wheelUp?: boolean; wheelDown?: boolean } {
  if (!rawInput) {
    return {};
  }

  // SGR mouse mode: ESC [ < Cb ; Cx ; Cy M
  const sgrMatch = /^\u001b\[<(\d+);(\d+);(\d+)([mM])$/u.exec(rawInput);
  if (sgrMatch) {
    const buttonCode = Number.parseInt(sgrMatch[1] ?? '', 10);
    if (!Number.isNaN(buttonCode) && (buttonCode & 64) === 64) {
      return (buttonCode & 1) === 1 ? { wheelDown: true } : { wheelUp: true };
    }
  }

  // X10 mouse mode: ESC [ M Cb Cx Cy with bytes offset by 32.
  if (rawInput.startsWith('\u001b[M') && rawInput.length >= 6) {
    const buttonCode = rawInput.charCodeAt(3) - 32;
    if (!Number.isNaN(buttonCode) && (buttonCode & 64) === 64) {
      return (buttonCode & 1) === 1 ? { wheelDown: true } : { wheelUp: true };
    }
  }

  return {};
}

export function withRawTerminalKeys(
  key: TerminalKeyState,
  value: string,
  rawInput?: string,
): TerminalKeyState {
  if (!rawInput) {
    return key;
  }

  const next: TerminalKeyState = { ...key };
  const mouseWheel = parseRawMouseWheel(rawInput);

  if (!next.wheelUp && mouseWheel.wheelUp) {
    next.wheelUp = true;
  }
  if (!next.wheelDown && mouseWheel.wheelDown) {
    next.wheelDown = true;
  }

  if (!next.upArrow && rawMatches(rawInput, RAW_KEY_SEQUENCES.upArrow)) {
    next.upArrow = true;
  }
  if (!next.downArrow && rawMatches(rawInput, RAW_KEY_SEQUENCES.downArrow)) {
    next.downArrow = true;
  }
  if (!next.leftArrow && rawMatches(rawInput, RAW_KEY_SEQUENCES.leftArrow)) {
    next.leftArrow = true;
  }
  if (!next.rightArrow && rawMatches(rawInput, RAW_KEY_SEQUENCES.rightArrow)) {
    next.rightArrow = true;
  }
  if (!next.home && rawMatches(rawInput, RAW_KEY_SEQUENCES.home)) {
    next.home = true;
  }
  if (!next.end && rawMatches(rawInput, RAW_KEY_SEQUENCES.end)) {
    next.end = true;
  }
  if (!next.pageUp && rawMatches(rawInput, RAW_KEY_SEQUENCES.pageUp)) {
    next.pageUp = true;
  }
  if (!next.pageDown && rawMatches(rawInput, RAW_KEY_SEQUENCES.pageDown)) {
    next.pageDown = true;
  }
  if (!next.delete && rawMatches(rawInput, RAW_KEY_SEQUENCES.delete)) {
    next.delete = true;
  }
  if (!next.backspace && (rawInput === '\b' || rawInput === '\u007f')) {
    next.backspace = true;
  }
  if (!next.tab && (rawInput === '\t' || rawInput === '\u001b[Z')) {
    next.tab = true;
  }
  if (!next.shift && rawInput === '\u001b[Z') {
    next.shift = true;
  }
  if (!next.escape && rawInput === '\u001b') {
    next.escape = true;
  }
  if (!next.return && (rawInput === '\r' || rawInput === '\n' || rawInput === '\r\n' || value === '\r' || value === '\n')) {
    next.return = true;
  }

  return next;
}

export function applyRawInputSequence(
  cursor: Cursor,
  raw: string,
): { cursor: Cursor; handled: boolean } {
  if (!raw.includes('\b') && !raw.includes('\u007f')) {
    return { cursor, handled: false };
  }

  let nextCursor = cursor;
  let buffer = '';

  const flushBuffer = (): void => {
    if (!buffer) {
      return;
    }
    nextCursor = nextCursor.insert(buffer);
    buffer = '';
  };

  for (const character of raw) {
    if (character === '\b' || character === '\u007f') {
      flushBuffer();
      nextCursor = nextCursor.backspace();
      continue;
    }
    buffer += character;
  }

  flushBuffer();
  return { cursor: nextCursor, handled: true };
}
