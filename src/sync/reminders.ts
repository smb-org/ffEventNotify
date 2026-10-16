// Sends one persisted reminder slot to opted-in players who still have open rewards.

import {
  ensureReminderDeliveries,
  getChecklistReminderRecipients,
  getEventSources,
  getGuild,
  getGuildEventObject,
  markReminderDeliveriesAttempted,
  markReminderDeliveriesSent,
  setGuildDiscordIds,
  type ReminderDeliveryKey,
  type Store,
  type StoreEvent,
} from '../store.ts';
import { bestEventSourceUrl, stableEventIdentity } from '../event-identity.ts';
import { withGuildDiscordLock } from '../guild-lock.ts';
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
const REMINDER_RECOVERY_LIMIT = 200;
const REMINDER_RECOVERY_CHANNEL_SCAN_LIMIT = 2_000;
const REMINDER_MARKER_PLACEHOLDER = `ffe-r-${'0'.repeat(32)}`;
const REMINDER_THREAD_AUTO_ARCHIVE_DURATION = 10_080;

function reminderLeadLabel(leadHours: 24 | 72): string {
  return leadHours === 72 ? 'Noch 3 Tage' : 'Noch 1 Tag';
}

function reminderThreadName(event: StoreEvent): string {
  const title = event.titleStatus === 'ok' ? event.title : 'FFXIV-Event';
  return Array.from(`Erinnerungen: ${title}`.replace(/\s+/g, ' ').trim()).slice(0, 100).join('');
}

async function ensureReminderThread(
  event: StoreEvent,
  guildId: string,
  channelId: string,
  store: Store,
  discord: DiscordPort,
): Promise<string | undefined> {
  const card = getGuildEventObject(store, guildId, event.eventKey);
  if (!card?.messageId || card.messageChannelId !== channelId) return undefined;
  let thread = await discord.fetchThread(channelId, card.reminderThreadId, card.messageId);
  if (thread && thread.starterMessageId !== card.messageId) {
    thread = await discord.fetchThread(channelId, null, card.messageId);
  }
  if (!thread) {
    thread = await discord.startThreadOnMessage(
      channelId,
      card.messageId,
      reminderThreadName(event),
      REMINDER_THREAD_AUTO_ARCHIVE_DURATION,
    );
  }
  if (thread.id !== card.reminderThreadId) {
    setGuildDiscordIds(store, guildId, event.eventKey, { reminderThreadId: thread.id });
  }
  return thread.id;
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

function eventLink(event: StoreEvent, store: Store, fragment: string): string | undefined {
  const source = bestEventSourceUrl(getEventSources(store, event.id).map((entry) => entry.url));
  if (!source) return undefined;
  const url = new URL(source);
  url.hash = fragment;
  return url.toString();
}

function reminderBatchKey(guildId: string, eventKey: string, leadHours: 24 | 72, users: readonly string[]): string {
  return stableEventIdentity(JSON.stringify([guildId, eventKey, leadHours, users])).slice(0, 32);
}

function batchMarker(guildId: string, eventKey: string, leadHours: 24 | 72, users: readonly string[]): string {
  return `ffe-r-${reminderBatchKey(guildId, eventKey, leadHours, users)}`;
}

async function syncEventRemindersUnlocked({
  guildId,
  channelId,
  events,
  store,
  discord,
  now = new Date(),
}: SyncEventRemindersOptions): Promise<void> {
  if (!getGuild(store, guildId)) return;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return;
  for (const event of events) {
    if (event.endStatus !== 'ok' || !event.endUtc || event.rewardsStatus !== 'ok' || event.rewards.length === 0) continue;
    const endMs = Date.parse(event.endUtc);
    if (!Number.isFinite(endMs) || endMs <= nowMs) continue;
    for (const leadHours of [72, 24] as const) {
      const dueAt = endMs - leadHours * 60 * 60 * 1_000;
      const lateness = nowMs - dueAt;
      if (lateness < 0 || lateness > leadHours * 60 * 60 * 1_000 / 2) continue;
      const recipients = recipientsForEvent(event, store, guildId);
      if (recipients.length === 0) continue;
      const placeholderLink = eventLink(event, store, REMINDER_MARKER_PLACEHOLDER);
      if (!placeholderLink) {
        console.warn(`Für „${event.titleStatus === 'ok' ? event.title : 'FFXIV-Event'}“ gibt es keine bestätigte Quellenadresse; die Erinnerung bleibt ausstehend.`);
        continue;
      }
      const displayTitle = event.titleStatus === 'ok' ? event.title : 'FFXIV-Event';
      const title = displayTitle.replace(/[\\[\]()*_~`|>]/g, '\\$&');
      const linkedTitle = placeholderLink ? `[${title}](<${placeholderLink}>)` : title;
      const prefix = `${reminderLeadLabel(leadHours)}: ${linkedTitle} — offen bei euch:`;
      const delivery: Omit<ReminderDeliveryKey, 'userId'> = { guildId, eventKey: event.eventKey, leadHours };
      const states = ensureReminderDeliveries(store, delivery, recipients.map((recipient) => recipient.userId));
      const stateByUser = new Map(states.map((state) => [state.userId, state]));
      const unsentRecipients = recipients.filter((recipient) => stateByUser.get(recipient.userId)?.status !== 'sent');
      if (unsentRecipients.length === 0) continue;

      const unsentStates = unsentRecipients.map((recipient) => stateByUser.get(recipient.userId)).filter((state) => state !== undefined);
      const requiresChannelStart = unsentStates.some((state) => state.firstAttemptAt === null
        || !Number.isFinite(Date.parse(state.firstAttemptAt)));
      const firstAttemptBoundary = requiresChannelStart ? undefined : unsentStates
        .map((state) => state.firstAttemptAt!)
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
      let threadId: string | undefined;
      try {
        threadId = await ensureReminderThread(event, guildId, channelId, store, discord);
      } catch (error) {
        console.warn(`Der Erinnerungs-Thread für „${displayTitle}“ konnte nicht abgerufen werden.`, error);
        continue;
      }
      if (!threadId) continue;
      const recentMessages = await discord.fetchRecentBotMessages(
        threadId,
        requiresChannelStart ? REMINDER_RECOVERY_CHANNEL_SCAN_LIMIT : REMINDER_RECOVERY_LIMIT,
        requiresChannelStart ? { requireChannelStart: true } : { olderThan: firstAttemptBoundary },
      );
      const recoveredUsers = new Set<string>();
      for (const candidate of recentMessages.messages) {
        const userIds = recoveredRecipients(candidate.content, guildId, event.eventKey, leadHours);
        if (!userIds) continue;
        markReminderDeliveriesSent(store, delivery, userIds, candidate.createdAt ?? now.toISOString());
        for (const userId of userIds) recoveredUsers.add(userId);
      }
      const remainingRecipients = unsentRecipients.filter((recipient) => !recoveredUsers.has(recipient.userId));
      if (remainingRecipients.length === 0) continue;
      if (!recentMessages.complete) {
        console.warn(`Die Suche nach früheren Erinnerungen für „${displayTitle}“ ist unvollständig; der Versand wird wiederholt.`);
        continue;
      }

      for (const message of splitReminderMessages(prefix, remainingRecipients)) {
        const marker = batchMarker(guildId, event.eventKey, leadHours, message.userIds);
        const content = message.content.replace(REMINDER_MARKER_PLACEHOLDER, marker);
        markReminderDeliveriesAttempted(store, delivery, message.userIds, now.toISOString());
        try {
          await discord.sendToThread(threadId, {
            content,
            allowedMentions: { parse: [], users: message.userIds },
            suppressEmbeds: true,
          });
          markReminderDeliveriesSent(store, delivery, message.userIds, now.toISOString());
        } catch (error) {
          console.warn(`Erinnerung für „${displayTitle}“ konnte nicht gesendet werden.`, error);
        }
      }
    }
  }
}

function recoveredRecipients(
  content: string,
  guildId: string,
  eventKey: string,
  leadHours: 24 | 72,
): string[] | undefined {
  const userIds = [...content.matchAll(/<@!?([^>\s]+)>/g)]
    .map((match) => match[1]!)
    .filter((id, index, ids) => ids.indexOf(id) === index);
  if (userIds.length === 0) return undefined;
  const marker = `#${batchMarker(guildId, eventKey, leadHours, userIds)}`;
  return content.includes(marker) ? userIds : undefined;
}

export function syncEventReminders(options: SyncEventRemindersOptions): Promise<void> {
  return withGuildDiscordLock(options.guildId, () => syncEventRemindersUnlocked(options));
}
