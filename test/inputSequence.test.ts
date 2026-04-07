import { describe, expect, it } from 'vitest';

import { Cursor } from '../src/app/claudecode/Cursor.js';
import { applyRawInputSequence, withRawTerminalKeys } from '../src/app/inputSequence.js';

describe('applyRawInputSequence', () => {
  it('applies mixed printable characters and backspace in one raw chunk', () => {
    const cursor = Cursor.fromText('', 80, 0);
    const result = applyRawInputSequence(cursor, "'\b");

    expect(result.handled).toBe(true);
    expect(result.cursor.text).toBe('');
    expect(result.cursor.offset).toBe(0);
  });

  it('handles coalesced text with multiple deletions', () => {
    const cursor = Cursor.fromText('abc', 80, 3);
    const result = applyRawInputSequence(cursor, "de\b'\b");

    expect(result.handled).toBe(true);
    expect(result.cursor.text).toBe('abcd');
    expect(result.cursor.offset).toBe(4);
  });

  it('treats raw backspace as a single-character delete', () => {
    const cursor = Cursor.fromText('abc def', 80, 7);
    const result = applyRawInputSequence(cursor, '\b');

    expect(result.handled).toBe(true);
    expect(result.cursor.text).toBe('abc de');
    expect(result.cursor.offset).toBe(6);
  });

  it('ignores plain text that has no raw backspace characters', () => {
    const cursor = Cursor.fromText('abc', 80, 3);
    const result = applyRawInputSequence(cursor, 'def');

    expect(result.handled).toBe(false);
    expect(result.cursor.text).toBe('abc');
    expect(result.cursor.offset).toBe(3);
  });
});

describe('withRawTerminalKeys', () => {
  it('infers VT arrow and paging keys from raw input', () => {
    const up = withRawTerminalKeys({}, '', '\u001b[A');
    const pageDown = withRawTerminalKeys({}, '', '\u001b[6~');

    expect(up.upArrow).toBe(true);
    expect(pageDown.pageDown).toBe(true);
  });

  it('infers Windows console scan-code sequences from raw input', () => {
    const down = withRawTerminalKeys({}, '', '\u0000P');
    const deleteKey = withRawTerminalKeys({}, '', '\u00e0S');

    expect(down.downArrow).toBe(true);
    expect(deleteKey.delete).toBe(true);
  });

  it('marks shift+tab when the terminal sends reverse tab', () => {
    const result = withRawTerminalKeys({}, '', '\u001b[Z');

    expect(result.tab).toBe(true);
    expect(result.shift).toBe(true);
  });

  it('detects SGR mouse wheel sequences as wheel events instead of arrow navigation', () => {
    const wheelUp = withRawTerminalKeys({}, '', '\u001b[<64;40;18M');
    const wheelDown = withRawTerminalKeys({}, '', '\u001b[<65;40;18M');

    expect(wheelUp.wheelUp).toBe(true);
    expect(wheelUp.upArrow).not.toBe(true);
    expect(wheelDown.wheelDown).toBe(true);
    expect(wheelDown.downArrow).not.toBe(true);
  });

  it('detects legacy xterm mouse wheel sequences', () => {
    const wheelUp = withRawTerminalKeys({}, '', '\u001b[M`!!');
    const wheelDown = withRawTerminalKeys({}, '', '\u001b[Ma!!');

    expect(wheelUp.wheelUp).toBe(true);
    expect(wheelDown.wheelDown).toBe(true);
  });
});
