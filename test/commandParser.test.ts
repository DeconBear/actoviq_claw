import { describe, expect, it } from 'vitest';

import { parseCommand, tokenizeCommand } from '../src/app/commandParser.js';

describe('tokenizeCommand', () => {
  it('splits simple tokens', () => {
    expect(tokenizeCommand('buddy pet')).toEqual(['buddy', 'pet']);
  });

  it('keeps quoted tokens together', () => {
    expect(tokenizeCommand('buddy hatch "Moon Cake" "steady and warm"')).toEqual([
      'buddy',
      'hatch',
      'Moon Cake',
      'steady and warm',
    ]);
  });
});

describe('parseCommand', () => {
  it('returns undefined for plain text', () => {
    expect(parseCommand('ship this task')).toBeUndefined();
  });

  it('parses slash commands', () => {
    expect(parseCommand('/heartbeat every 30')).toEqual({
      name: 'heartbeat',
      args: ['every', '30'],
      raw: '/heartbeat every 30',
    });
  });
});
