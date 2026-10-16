// Sends one persisted reminder slot to opted-in players who still have open rewards.

import {
  claimReminderSlot,
  getChecklistReminderRecipients,
  type Store,
  type StoreEvent,
} from '../store.ts';
import type { DiscordPort, FieldStatus } from '../types.ts';

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

export interface SyncEventRemindersOptions {
  guildId: string;
  channelId: string;
  events: readonly StoreEvent[];
  store: Store;
  discord: DiscordPort;
  now?: Date;
}

interface ReminderRecipient {
  userId: string;
  line: string;
}

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_SLOT_LATENESS_MS = 60 * 60 * 1_000;

function reminderLeadLabel(leadHours: 24 | 72): string {
  return leadHours === 72 ? 'Noch 3 Tage' : 'Noch 1 Tag';
}

function recipientsForEvent(
  event: StoreEvent,
  store: Store,
  guildId: string,
): ReminderRecipient[] {
  const rewardsById = new Map(event.rewards.map((reward) => [reward.itemId, reward.name]));
  return getChecklistReminderRecipients(store, guildId, event.eventKey, event.rewards.map((reward) => reward.itemId))
    .map(({ userId, openItemIds }) => {
      const names = openItemIds.slice(0, 3).map((itemId) => (rewardsById.get(itemId) ?? 'Belohnung').slice(0, 180));
      const remaining = openItemIds.length - names.length;
      const items = `${names.join(', ')}${remaining > 0 ? ` +${remaining}` : ''}`;
      return { userId, line: `• <@${userId}>: ${items}` };
    });
}

function splitReminderMessages(prefix: string, recipients: readonly ReminderRecipient[]): Array<{ content: string; userIds: string[] }> {
  const messages: Array<{ content: string; userIds: string[] }> = [];
  let lines: string[] = [];
  let users: string[] = [];
  const flush = () => {
    if (lines.length === 0) return;
    messages.push({ content: `${prefix}\n${lines.join('\n')}`, userIds: users });
    lines = [];
    users = [];
  };

  for (const recipient of recipients) {
    const safeLine = recipient.line.length > MAX_MESSAGE_LENGTH - prefix.length - 1
      ? `${recipient.line.slice(0, MAX_MESSAGE_LENGTH - prefix.length - 4)}…`
      : recipient.line;
    const proposed = `${prefix}\n${[...lines, safeLine].join('\n')}`;
    if (lines.length > 0 && proposed.length > MAX_MESSAGE_LENGTH) flush();
    lines.push(safeLine);
    users.push(recipient.userId);
  }
  flush();
  return messages;
}

export async function syncEventReminders({
  guildId,
  channelId,
  events,
  store,
  discord,
  now = new Date(),
}: SyncEventRemindersOptions): Promise<void> {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return;
  for (const event of events) {
    if (event.endStatus !== 'ok' || !event.endUtc || event.rewardsStatus !== 'ok' || event.rewards.length === 0) continue;
    const endMs = Date.parse(event.endUtc);
    if (!Number.isFinite(endMs) || endMs <= nowMs) continue;
    for (const leadHours of [72, 24] as const) {
      const dueAt = endMs - leadHours * 60 * 60 * 1_000;
      const lateness = nowMs - dueAt;
      if (lateness < 0 || lateness > MAX_SLOT_LATENESS_MS) continue;
      const recipients = recipientsForEvent(event, store, guildId);
      if (recipients.length === 0) continue;
      // Claim before sending so a timeout or restart after Discord accepted a message cannot duplicate pings.
      if (!claimReminderSlot(store, guildId, event.eventKey, leadHours)) continue;
      const prefix = `${reminderLeadLabel(leadHours)}: ${event.title} — offen bei euch:`;
      for (const message of splitReminderMessages(prefix, recipients)) {
        try {
          await discord.createMessage(channelId, {
            content: message.content,
            allowedMentions: { parse: [], users: message.userIds },
          });
        } catch (error) {
          console.warn(`Erinnerung für „${event.title}“ konnte nicht gesendet werden.`, error);
        }
      }
    }
  }
}
