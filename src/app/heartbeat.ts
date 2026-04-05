import type { ActiveHoursWindow } from './types.js';

export interface NormalizedHeartbeatResult {
  acknowledged: boolean;
  visibleText: string;
}

function parseClockValue(value: string): number {
  const matched = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!matched) {
    throw new Error(`Invalid clock value "${value}". Expected HH:MM.`);
  }
  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (hours < 0 || hours > 24 || minutes < 0 || minutes > 59 || (hours === 24 && minutes !== 0)) {
    throw new Error(`Invalid clock value "${value}". Expected HH:MM.`);
  }
  return hours * 60 + minutes;
}

function resolveClockMinutes(now: Date, timezone?: string): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    ...(timezone ? { timeZone: timezone } : {}),
  });
  const parts = formatter.formatToParts(now);
  const hours = Number(parts.find(part => part.type === 'hour')?.value ?? '0');
  const minutes = Number(parts.find(part => part.type === 'minute')?.value ?? '0');
  return hours * 60 + minutes;
}

export function isWithinActiveHours(
  activeHours: ActiveHoursWindow | undefined,
  now: Date = new Date(),
): boolean {
  if (!activeHours) {
    return true;
  }

  const start = parseClockValue(activeHours.start);
  const end = parseClockValue(activeHours.end);
  if (start === end) {
    return false;
  }

  const current = resolveClockMinutes(now, activeHours.timezone);
  if (start < end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}

export function computeNextHeartbeatAt(now: Date, intervalMinutes: number): string {
  return new Date(now.getTime() + intervalMinutes * 60_000).toISOString();
}

export function normalizeHeartbeatResponse(
  text: string,
  ackMaxChars: number,
): NormalizedHeartbeatResult {
  const trimmed = text.trim();
  const token = 'HEARTBEAT_OK';

  if (!trimmed) {
    return {
      acknowledged: true,
      visibleText: '',
    };
  }

  let stripped = trimmed;
  let acknowledged = false;

  if (stripped.startsWith(token)) {
    stripped = stripped.slice(token.length).trim();
    acknowledged = true;
  } else if (stripped.endsWith(token)) {
    stripped = stripped.slice(0, -token.length).trim();
    acknowledged = true;
  }

  if (acknowledged && stripped.length <= ackMaxChars) {
    return {
      acknowledged: true,
      visibleText: '',
    };
  }

  return {
    acknowledged: false,
    visibleText: stripped,
  };
}
