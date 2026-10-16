// Computes future three-day and one-day reminder deadlines for certain event ends.

import type { FieldStatus } from '../types.ts';

export interface ScheduledReminder {
  eventId: string;
  leadHours: 72 | 24;
  dueAt: string;
}

export function scheduleEventReminders(
  eventId: string,
  endUtc: FieldStatus<string>,
  now = new Date(),
): ScheduledReminder[] {
  if (endUtc.status !== 'ok') return [];
  const endMilliseconds = Date.parse(endUtc.value);
  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(endMilliseconds) || !Number.isFinite(nowMilliseconds) || endMilliseconds <= nowMilliseconds) return [];

  return ([72, 24] as const)
    .map((leadHours) => ({
      eventId,
      leadHours,
      dueAt: new Date(endMilliseconds - leadHours * 60 * 60 * 1_000).toISOString(),
    }))
    .filter((reminder) => Date.parse(reminder.dueAt) > nowMilliseconds);
}
