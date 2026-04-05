import { describe, expect, it } from 'vitest';

import {
  computeNextHeartbeatAt,
  isWithinActiveHours,
  normalizeHeartbeatResponse,
} from '../src/app/heartbeat.js';

describe('normalizeHeartbeatResponse', () => {
  it('treats bare HEARTBEAT_OK as acknowledged', () => {
    expect(normalizeHeartbeatResponse('HEARTBEAT_OK', 100)).toEqual({
      acknowledged: true,
      visibleText: '',
    });
  });

  it('strips acknowledged preamble', () => {
    expect(normalizeHeartbeatResponse('HEARTBEAT_OK all clear', 100)).toEqual({
      acknowledged: true,
      visibleText: '',
    });
  });

  it('keeps alert payloads visible when too long', () => {
    expect(
      normalizeHeartbeatResponse('HEARTBEAT_OK Something needs attention right now.', 10),
    ).toEqual({
      acknowledged: false,
      visibleText: 'Something needs attention right now.',
    });
  });
});

describe('active hours', () => {
  it('allows times inside the window', () => {
    expect(
      isWithinActiveHours(
        {
          start: '08:00',
          end: '18:00',
          timezone: 'UTC',
        },
        new Date('2026-04-05T09:00:00Z'),
      ),
    ).toBe(true);
  });

  it('blocks times outside the window', () => {
    expect(
      isWithinActiveHours(
        {
          start: '08:00',
          end: '18:00',
          timezone: 'UTC',
        },
        new Date('2026-04-05T20:00:00Z'),
      ),
    ).toBe(false);
  });
});

describe('computeNextHeartbeatAt', () => {
  it('adds interval minutes', () => {
    expect(computeNextHeartbeatAt(new Date('2026-04-05T00:00:00Z'), 20)).toBe(
      '2026-04-05T00:20:00.000Z',
    );
  });
});
