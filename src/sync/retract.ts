// Removes persisted Discord objects for events whose Lodestone source is now ignored.

import type { Store, StoreEvent } from '../store.ts';
import {
  clearEventRetraction,
  getEventSources,
  getGuild,
  getGuildEventObject,
  getSeenClassification,
  isEventRetracting,
} from '../store.ts';
import { isDiscordNotFound } from '../discord-errors.ts';
import { withGuildDiscordLock } from '../guild-lock.ts';
import { hasEventMessageMarker } from './embed.ts';
import { findForumPost } from './forum.ts';
import { findByMarker } from './scheduled.ts';
import type { DiscordPort } from '../types.ts';

export interface DeleteEventObjectsOptions {
  event: StoreEvent;
  guildId: string;
  discord: DiscordPort;
  store: Store;
}

function sourceStillIgnored(store: Store, event: StoreEvent): boolean {
  if (!isEventRetracting(store, event.id)) return false;
  const sources = getEventSources(store, event.id);
  if (sources.length === 1 && sources[0]!.kind === 'topic'
    && getSeenClassification(store, sources[0]!.url) === 'ignored') return true;
  clearEventRetraction(store, event.id);
  return false;
}

async function deleteGuildEventObjectsUnlocked({ event, guildId, discord, store }: DeleteEventObjectsOptions): Promise<boolean> {
  if (!sourceStillIgnored(store, event)) return false;
  const object = getGuildEventObject(store, guildId, event.eventKey);
  if (!object) return true;

  const errors: unknown[] = [];
  let sourceRestored = false;
  const attempt = async (action: (() => Promise<void>) | undefined): Promise<void> => {
    if (sourceRestored) return;
    if (!sourceStillIgnored(store, event)) {
      sourceRestored = true;
      return;
    }
    if (!action) {
      errors.push(new Error('Dieser Discord-Adapter unterstützt das Löschen des gespeicherten Objekts nicht.'));
      return;
    }
    try {
      await action();
    } catch (error) {
      if (!isDiscordNotFound(error)) errors.push(error);
    }
  };

  const guild = getGuild(store, guildId);
  const messageChannelId = object.messageChannelId ?? guild?.eventChannelId ?? undefined;
  let messageId = object.messageId ?? undefined;
  let isForumPost = false;
  let channelCheckFailed = false;
  let channelChecked = false;
  let reminderRecoveryFailed = false;

  if (!messageId && object.firstPostAttemptAt && messageChannelId) {
    try {
      if (discord.isForumChannel) {
        channelChecked = true;
        isForumPost = await discord.isForumChannel(messageChannelId);
      }
      if (isForumPost) {
        const recovered = await findForumPost(messageChannelId, event, null, discord);
        messageId = recovered?.id;
      } else {
        const hasAttemptBoundary = Number.isFinite(Date.parse(object.firstPostAttemptAt));
        const history = await discord.fetchRecentBotMessages(
          messageChannelId,
          hasAttemptBoundary ? 200 : 2_000,
          hasAttemptBoundary ? { olderThan: object.firstPostAttemptAt } : { requireChannelStart: true },
        );
        if (!history.complete) throw new Error('Die Suche nach dem verlorenen Discord-Post ist unvollständig.');
        const matches = history.messages.filter((message) => hasEventMessageMarker(message, event, getEventSources(store, event.id).map((source) => source.url)));
        if (matches.length > 1) throw new Error(`Mehrere Discord-Meldungen tragen dieselbe Quellenmarkierung für ${event.title}.`);
        messageId = matches[0]?.id;
      }
    } catch (error) {
      if (!isDiscordNotFound(error)) errors.push(error);
    }
  }

  if (messageId && messageChannelId && discord.isForumChannel && !channelChecked) {
    channelChecked = true;
    try {
      isForumPost = await discord.isForumChannel(messageChannelId);
    } catch (error) {
      if (isDiscordNotFound(error)) isForumPost = true;
      else {
        errors.push(error);
        channelCheckFailed = true;
      }
    }
  }

  if (object.reminderThreadId) {
    await attempt(discord.deleteDiscordThread ? () => discord.deleteDiscordThread!(object.reminderThreadId!) : undefined);
  } else if (messageId && messageChannelId && !isForumPost && !channelCheckFailed) {
    try {
      const reminderThread = await discord.fetchThread(messageChannelId, null, messageId);
      if (reminderThread) {
        const errorCount = errors.length;
        await attempt(discord.deleteDiscordThread ? () => discord.deleteDiscordThread!(reminderThread.id) : undefined);
        reminderRecoveryFailed = errors.length > errorCount;
      }
    } catch (error) {
      if (!isDiscordNotFound(error)) {
        errors.push(error);
        reminderRecoveryFailed = true;
      }
    }
  }

  if (messageId && !reminderRecoveryFailed) {
    if (!channelCheckFailed && isForumPost) {
      await attempt(discord.deleteDiscordThread ? () => discord.deleteDiscordThread!(messageId!) : undefined);
    } else if (!channelCheckFailed && messageChannelId) {
      for (const continuationId of object.continuationMessageIds) {
        await attempt(discord.deleteMessage ? () => discord.deleteMessage!(messageChannelId, continuationId) : undefined);
      }
      await attempt(discord.deleteMessage ? () => discord.deleteMessage!(messageChannelId, messageId!) : undefined);
    } else if (!channelCheckFailed) {
      errors.push(new Error(`Für den Discord-Post von ${event.eventKey} fehlt der übergeordnete Kanal.`));
    }
  } else if (object.continuationMessageIds.length > 0) {
    errors.push(new Error(`Für die Fortsetzungen von ${event.eventKey} fehlt der Discord-Post.`));
  }

  let scheduledEventId = object.scheduledEventId ?? undefined;
  if (!scheduledEventId) {
    try {
      const scheduledEvents = await discord.listScheduledEvents(guildId);
      scheduledEventId = findByMarker(scheduledEvents, event, getEventSources(store, event.id).map((source) => source.url))?.id;
    } catch (error) {
      if (!isDiscordNotFound(error)) errors.push(error);
    }
  }
  if (scheduledEventId) {
    await attempt(discord.deleteScheduledEvent ? () => discord.deleteScheduledEvent!(guildId, scheduledEventId!) : undefined);
  }

  if (sourceRestored) return false;
  if (errors.length > 0) {
    throw new AggregateError(errors, `Discord-Objekte für ${event.eventKey} konnten nicht vollständig gelöscht werden.`);
  }
  return true;
}

export function deleteGuildEventObjects(options: DeleteEventObjectsOptions): Promise<boolean> {
  return withGuildDiscordLock(options.guildId, () => deleteGuildEventObjectsUnlocked(options));
}
