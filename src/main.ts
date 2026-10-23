// Starts the Discord gateway and runs one non-overlapping sync cycle per hour.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  Client,
  ChannelType,
  ChannelFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  GatewayIntentBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type GuildScheduledEvent,
  type Message,
  type ThreadAutoArchiveDuration,
  type ThreadChannel,
  type ForumChannel,
  type TextChannel,
} from 'discord.js';
import { readConfig } from './config.ts';
import { createTrackedFetch, FetchMetrics, runDryRunCycle } from './dry-run.ts';
import { SourceHealthMonitor } from './health.ts';
import { runCycle, type CycleOptions, type CycleResult } from './cycle.ts';
import { runGuildSyncFromStoredData } from './cycle.ts';
import { openDb } from './store.ts';
import { LodestoneRequestQueue } from './sources/queue.ts';
import { collectRecentBotMessages } from './discord-history.ts';
import { isUnknownDiscordResource } from './discord-errors.ts';
import { missingSetupPermissions, registerGlobalFfEventsCommand, setupPermissionHints } from './commands.ts';
import {
  deleteGuild,
  getAllEvents,
  getConfiguredGuilds,
  getGuild,
  getStoredGuildIds,
  markGuildNeedsSetup,
  isFirstRun,
  setGuildName,
  upsertGuildSetup,
  type Store,
} from './store.ts';
import { syncEventReminders } from './sync/reminders.ts';
import { ensureForumTags } from './sync/forum.ts';
import { formatLogContent } from './log-format.ts';
import { withGuildDiscordLock } from './guild-lock.ts';
import { versionLine } from './version.ts';
import { configureLog, diffActions, log, redactToken, snapshotActions, type ActionCounts } from './log.ts';
import { handleChecklistInteraction, handleNewLinkCommand } from './interactions/checklist.ts';
import { createWebServer } from './web/server.ts';
import { createTokenCodec } from './web/token.ts';
import { handleSidebarFollowButton, handleSidebarFollowCommand } from './interactions/follow.ts';
import { SIDEBAR_FOLLOW_CUSTOM_ID_PREFIX } from './sidebar-follow.ts';
import type {
  DiscordActionRow,
  DiscordEmbed,
  DiscordMessagePayload,
  DiscordMessageHistory,
  DiscordMessageHistoryOptions,
  DiscordMessageSnapshot,
  DiscordPort,
  DiscordForumPostSnapshot,
  DiscordForumTag,
  DiscordForumTagData,
  DiscordThreadSnapshot,
  FetchText,
  ScheduledEventPayload,
  ScheduledEventSnapshot,
  ScheduledEventStatus,
} from './types.ts';

export const CYCLE_INTERVAL_MS = 60 * 60 * 1_000;
export const REMINDER_INTERVAL_MS = 5 * 60 * 1_000;

export type CycleBody = () => Promise<void>;

export interface SchedulerClock {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface HourlySchedulerOptions {
  clock?: SchedulerClock;
  signal?: AbortSignal;
  onSkipped?: (tickAtMilliseconds: number) => void;
  onCycleError?: (error: unknown) => void;
}

export interface ReminderSchedulerOptions {
  clock?: SchedulerClock;
  signal?: AbortSignal;
  intervalMs?: number;
  onCycleError?: (error: unknown) => void;
}

const systemClock: SchedulerClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) => new Promise((resolveSleep) => {
    if (signal?.aborted) {
      resolveSleep();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolveSleep();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolveSleep();
    };
    signal?.addEventListener('abort', abort, { once: true });
  }),
};

function embedBuilder(embed: DiscordEmbed): EmbedBuilder {
  const builder = new EmbedBuilder();
  if (embed.title !== undefined) builder.setTitle(embed.title);
  if (embed.url !== undefined) builder.setURL(embed.url);
  if (embed.description !== undefined) builder.setDescription(embed.description);
  if (embed.color !== undefined) builder.setColor(embed.color);
  if (embed.author !== undefined) builder.setAuthor(embed.author);
  if (embed.image !== undefined) builder.setImage(embed.image.url);
  if (embed.fields !== undefined) builder.addFields(embed.fields);
  if (embed.footer !== undefined) builder.setFooter(embed.footer);
  return builder;
}

function actionRowBuilders(rows: readonly DiscordActionRow[]) {
  return rows.map((row) => {
    const first = row.components[0];
    if (!first) return new ActionRowBuilder<ButtonBuilder>();
    if (first.type === 'string-select') {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(first.customId)
        .setMinValues(first.minValues)
        .setMaxValues(first.maxValues)
        .addOptions(first.options.map((option) => {
          const builder = new StringSelectMenuOptionBuilder()
            .setLabel(option.label)
            .setValue(option.value);
          if (option.description !== undefined) builder.setDescription(option.description);
          if (option.default !== undefined) builder.setDefault(option.default);
          return builder;
        }));
      if (first.placeholder !== undefined) menu.setPlaceholder(first.placeholder);
      return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    }

    const buttons = row.components.map((component) => {
      if (component.type !== 'button') throw new Error('Discord-Aktionszeile enthält gemischte Komponententypen.');
      const builder = new ButtonBuilder().setLabel(component.label).setStyle(
        component.style === 'primary' ? ButtonStyle.Primary
          : component.style === 'secondary' ? ButtonStyle.Secondary
            : ButtonStyle.Link,
      );
      if (component.style === 'link') {
        if (!component.url) throw new Error('Ein Link-Button benötigt eine Zieladresse.');
        builder.setURL(component.url);
      } else if (component.customId !== undefined) {
        builder.setCustomId(component.customId);
      }
      if (component.disabled !== undefined) builder.setDisabled(component.disabled);
      return builder;
    });
    return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
  });
}

function embedSnapshot(embed: Message['embeds'][number]): DiscordEmbed {
  return {
    ...(embed.title === null ? {} : { title: embed.title }),
    ...(embed.url === null ? {} : { url: embed.url }),
    ...(embed.description === null ? {} : { description: embed.description }),
    ...(embed.color === null ? {} : { color: embed.color }),
    ...(embed.author === null ? {} : { author: { name: embed.author.name } }),
    ...(embed.image === null ? {} : { image: { url: embed.image.url } }),
    ...(embed.fields.length === 0 ? {} : { fields: embed.fields.map(({ name, value, inline }) => ({ name, value, inline })) }),
    ...(embed.footer === null ? {} : { footer: { text: embed.footer.text } }),
  };
}

function messageSnapshot(message: Message, botId: string | undefined): DiscordMessageSnapshot {
  type RawComponent = {
    type?: number;
    customId?: string;
    url?: string;
    label?: string;
    style?: number;
    disabled?: boolean;
    placeholder?: string;
    minValues?: number;
    maxValues?: number;
    options?: Array<{ label: string; value: string; description?: string; default?: boolean }>;
  };
  const rawRows = message.components as unknown as Array<{ components?: RawComponent[] }>;
  return {
    id: message.id,
    channelId: message.channelId,
    createdAt: message.createdAt.toISOString(),
    authorIsBot: botId !== undefined && message.author.id === botId,
    pinned: message.pinned,
    content: message.content,
    embeds: message.embeds.map(embedSnapshot),
    components: rawRows.flatMap((row) => !row.components ? [] : [{
      components: row.components.flatMap<DiscordActionRow['components'][number]>((component) => {
        if (component.type === 2) {
          const button = component;
          return [{
            type: 'button' as const,
            style: button.style === ButtonStyle.Link ? 'link' as const : button.style === ButtonStyle.Primary ? 'primary' as const : 'secondary' as const,
            label: button.label ?? '',
            ...(button.customId ? { customId: button.customId } : {}),
            ...(button.url ? { url: button.url } : {}),
            ...(button.disabled ? { disabled: true } : {}),
          }];
        }
        if (component.type === 3) {
          const select = component;
          return [{
            type: 'string-select' as const,
            customId: select.customId ?? '',
            ...(select.placeholder ? { placeholder: select.placeholder } : {}),
            minValues: select.minValues ?? 1,
            maxValues: select.maxValues ?? 1,
            options: (select.options ?? []).map((option) => ({
              label: option.label,
              value: option.value,
              ...(option.description ? { description: option.description } : {}),
              ...(option.default ? { default: true } : {}),
            })),
          }];
        }
        return [];
      }),
    }]),
  };
}

function statusSnapshot(event: GuildScheduledEvent): ScheduledEventStatus {
  switch (event.status) {
    case GuildScheduledEventStatus.Scheduled: return 'SCHEDULED';
    case GuildScheduledEventStatus.Active: return 'ACTIVE';
    case GuildScheduledEventStatus.Completed: return 'COMPLETED';
    case GuildScheduledEventStatus.Canceled: return 'CANCELED';
    default: return 'UNKNOWN';
  }
}

function scheduledSnapshot(event: GuildScheduledEvent): ScheduledEventSnapshot {
  return {
    id: event.id,
    guildId: event.guildId,
    name: event.name,
    startUtc: event.scheduledStartAt?.toISOString() ?? '',
    endUtc: event.scheduledEndAt?.toISOString() ?? '',
    location: event.entityMetadata?.location ?? '',
    description: event.description ?? '',
    status: statusSnapshot(event),
  };
}

export class DiscordJsPort implements DiscordPort {
  private readonly client: Client;
  private threadMemberTail: Promise<void> = Promise.resolve();

  constructor(client: Client) {
    this.client = client;
  }

  private async messageChannel(channelId: string): Promise<TextChannel | ThreadChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('messages' in channel)) {
      throw new Error(`Discord channel ${channelId} does not support messages.`);
    }
    return channel as TextChannel | ThreadChannel;
  }

  private async forumChannel(channelId: string): Promise<ForumChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildForum) {
      throw new Error(`Discord channel ${channelId} is not a forum channel.`);
    }
    return channel as ForumChannel;
  }

  private async forumThread(channelId: string, threadId: string): Promise<ThreadChannel | null> {
    const forum = await this.forumChannel(channelId);
    try {
      const thread = await forum.threads.fetch(threadId, { force: true });
      return thread && thread.parentId === forum.id ? thread : null;
    } catch (error) {
      // A deleted forum post is reported as 10003 Unknown Channel.
      if (isUnknownDiscordResource(error)) return null;
      throw error;
    }
  }

  private queueThreadMemberOperation(action: () => Promise<void>): Promise<void> {
    const result = this.threadMemberTail.then(action);
    this.threadMemberTail = result.catch(() => undefined);
    return result;
  }

  async addThreadMember(threadId: string, userId: string): Promise<void> {
    return this.queueThreadMemberOperation(async () => {
      const thread = await this.client.channels.fetch(threadId, { force: true });
      if (!thread?.isThread()) throw new Error(`Discord channel ${threadId} is not a thread.`);
      await thread.members.add(userId);
    });
  }

  async removeThreadMember(threadId: string, userId: string): Promise<void> {
    return this.queueThreadMemberOperation(async () => {
      const thread = await this.client.channels.fetch(threadId, { force: true });
      if (!thread?.isThread()) throw new Error(`Discord channel ${threadId} is not a thread.`);
      await thread.members.remove(userId);
    });
  }

  private async forumPostSnapshot(thread: ThreadChannel): Promise<DiscordForumPostSnapshot> {
    const starter = await thread.fetchStarterMessage();
    if (!starter) throw new Error(`Forum post ${thread.id} has no starter message.`);
    let lastMessageAt = starter.createdAt.toISOString();
    if (thread.lastMessageId && thread.lastMessageId !== starter.id) {
      try {
        const lastMessage = await thread.messages.fetch({ message: thread.lastMessageId, force: true });
        lastMessageAt = lastMessage.createdAt.toISOString();
      } catch {
        // The starter timestamp and stored keep-alive time remain safe fallbacks when history is unavailable.
      }
    }
    return {
      id: thread.id,
      parentChannelId: thread.parentId ?? '',
      starterMessageId: starter.id,
      name: thread.name,
      archived: thread.archived ?? false,
      appliedTags: [...thread.appliedTags],
      starterMessage: messageSnapshot(starter, this.client.user?.id),
      autoArchiveDuration: thread.autoArchiveDuration ?? 1_440,
      archiveTimestamp: thread.archiveTimestamp == null ? null : new Date(thread.archiveTimestamp).toISOString(),
      lastMessageAt,
      locked: thread.locked ?? false,
      pinned: thread.flags.has(ChannelFlags.Pinned),
    };
  }

  async createMessage(channelId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    const channel = await this.messageChannel(channelId);
    const message = await channel.send({
      content: payload.content,
      embeds: payload.embeds?.map(embedBuilder),
      ...(payload.components === undefined ? {} : { components: actionRowBuilders(payload.components) }),
      allowedMentions: { parse: [], users: payload.allowedMentions?.users ?? [] },
      ...(payload.suppressEmbeds ? { flags: MessageFlags.SuppressEmbeds } : {}),
    });
    return messageSnapshot(message, this.client.user?.id);
  }

  async editMessage(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    const channel = await this.messageChannel(channelId);
    const message = await channel.messages.fetch({ message: messageId, force: true });
    const edited = await message.edit({
      content: payload.content ?? null,
      embeds: payload.embeds?.map(embedBuilder) ?? [],
      components: payload.components === undefined ? message.components : actionRowBuilders(payload.components),
      ...(payload.allowedMentions === undefined ? {} : { allowedMentions: payload.allowedMentions }),
    });
    return messageSnapshot(edited, this.client.user?.id);
  }

  async fetchRecentBotMessages(channelId: string, limit: number, options: DiscordMessageHistoryOptions = {}): Promise<DiscordMessageHistory> {
    const channel = await this.messageChannel(channelId);
    const botId = this.client.user?.id;
    if (!botId) return { messages: [], complete: false };
    return collectRecentBotMessages(async (pageSize, before) => {
      const messages = await channel.messages.fetch({ limit: pageSize, cache: false, ...(before ? { before } : {}) });
      return [...messages.values()].map((message) => ({
        id: message.id,
        authorId: message.author.id,
        createdAt: message.createdAt.toISOString(),
        snapshot: messageSnapshot(message, botId),
      }));
    }, botId, limit, { pageSize: 100, maxPages: 20, ...options }).then(({ messages, complete }) => ({
      messages: messages.map(({ snapshot }) => snapshot), complete,
    }));
  }

  async fetchPinnedBotMessages(channelId: string): Promise<DiscordMessageSnapshot[]> {
    const channel = await this.messageChannel(channelId);
    const botId = this.client.user?.id;
    if (!botId) return [];
    const messages = await channel.messages.fetchPinned();
    return [...messages.values()]
      .filter((message) => message.author.id === botId)
      .map((message) => messageSnapshot(message, botId));
  }

  async fetchMessage(channelId: string, messageId: string): Promise<DiscordMessageSnapshot | null> {
    try {
      const channel = await this.messageChannel(channelId);
      const message = await channel.messages.fetch({ message: messageId, force: true });
      return messageSnapshot(message, this.client.user?.id);
    } catch (error) {
      if (isUnknownDiscordResource(error)) return null;
      throw error;
    }
  }

  async isTextChannel(channelId: string): Promise<boolean> {
    const channel = await this.client.channels.fetch(channelId);
    return Boolean(channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement));
  }

  async isForumChannel(channelId: string): Promise<boolean> {
    const channel = await this.client.channels.fetch(channelId);
    return channel?.type === ChannelType.GuildForum;
  }

  async fetchForumTags(channelId: string): Promise<DiscordForumTag[]> {
    const forum = await this.forumChannel(channelId);
    return forum.availableTags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      moderated: tag.moderated,
      emoji: tag.emoji,
    }));
  }

  async setForumTags(channelId: string, tags: readonly DiscordForumTagData[]): Promise<DiscordForumTag[]> {
    const forum = await this.forumChannel(channelId);
    await forum.setAvailableTags(tags);
    return this.fetchForumTags(channelId);
  }

  async createForumPost(
    channelId: string,
    name: string,
    payload: DiscordMessagePayload,
    appliedTags: readonly string[],
    autoArchiveDuration: number,
  ): Promise<DiscordForumPostSnapshot> {
    const forum = await this.forumChannel(channelId);
    const thread = await forum.threads.create({
      name,
      message: {
        content: payload.content,
        embeds: payload.embeds?.map(embedBuilder),
        ...(payload.components === undefined ? {} : { components: actionRowBuilders(payload.components) }),
        allowedMentions: { parse: [], users: payload.allowedMentions?.users ?? [] },
        ...(payload.suppressEmbeds ? { flags: MessageFlags.SuppressEmbeds } : {}),
      },
      appliedTags,
      autoArchiveDuration: autoArchiveDuration as ThreadAutoArchiveDuration,
    });
    return this.forumPostSnapshot(thread);
  }

  async fetchForumPost(channelId: string, threadId: string): Promise<DiscordForumPostSnapshot | null> {
    const thread = await this.forumThread(channelId, threadId);
    return thread ? this.forumPostSnapshot(thread) : null;
  }

  async listForumPosts(channelId: string): Promise<DiscordForumPostSnapshot[]> {
    const forum = await this.forumChannel(channelId);
    const threads = new Map<string, ThreadChannel>();
    const active = await forum.threads.fetchActive(false);
    for (const [id, thread] of active.threads) threads.set(id, thread);

    let page = await forum.threads.fetchArchived({ type: 'public', limit: 100 }, false);
    while (true) {
      for (const [id, thread] of page.threads) threads.set(id, thread);
      if (!page.hasMore) break;
      const ids = [...page.threads.keys()];
      const oldest = ids.sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0)[0];
      if (!oldest) throw new Error('Discord returned an empty archived forum page with more results.');
      page = await forum.threads.fetchArchived({ type: 'public', limit: 100, before: oldest }, false);
    }
    return Promise.all([...threads.values()].map((thread) => this.forumPostSnapshot(thread)));
  }

  async editForumStarter(threadId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    const channel = await this.client.channels.fetch(threadId, { force: true });
    if (!channel?.isThread()) throw new Error(`Discord channel ${threadId} is not a forum post.`);
    const starter = await channel.fetchStarterMessage({ force: true });
    if (!starter) throw new Error(`Forum post ${threadId} has no starter message.`);
    const edited = await channel.messages.edit(starter.id, {
      content: payload.content ?? null,
      embeds: payload.embeds?.map(embedBuilder) ?? [],
      components: payload.components === undefined ? starter.components : actionRowBuilders(payload.components),
      ...(payload.allowedMentions === undefined ? {} : { allowedMentions: payload.allowedMentions }),
    });
    return messageSnapshot(edited, this.client.user?.id);
  }

  async setForumPostTags(threadId: string, appliedTags: readonly string[]): Promise<void> {
    const channel = await this.client.channels.fetch(threadId, { force: true });
    if (!channel?.isThread()) throw new Error(`Discord channel ${threadId} is not a forum post.`);
    await channel.setAppliedTags(appliedTags);
  }

  async setForumPostName(threadId: string, name: string): Promise<void> {
    const channel = await this.client.channels.fetch(threadId, { force: true });
    if (!channel?.isThread()) throw new Error(`Discord channel ${threadId} is not a forum post.`);
    await channel.setName(name);
  }

  async setForumPostArchived(threadId: string, archived: boolean): Promise<void> {
    const channel = await this.client.channels.fetch(threadId, { force: true });
    if (!channel?.isThread()) throw new Error(`Discord channel ${threadId} is not a forum post.`);
    await channel.setArchived(archived);
  }

  async setForumPostAutoArchiveDuration(threadId: string, autoArchiveDuration: number): Promise<void> {
    const channel = await this.client.channels.fetch(threadId, { force: true });
    if (!channel?.isThread()) throw new Error(`Discord channel ${threadId} is not a forum post.`);
    await channel.setAutoArchiveDuration(autoArchiveDuration as ThreadAutoArchiveDuration);
  }

  async refreshForumPostKeepAlive(threadId: string, autoArchiveDuration: number): Promise<void> {
    const channel = await this.client.channels.fetch(threadId, { force: true });
    if (!channel?.isThread()) throw new Error(`Discord channel ${threadId} is not a forum post.`);
    await channel.setAutoArchiveDuration(4_320);
    await channel.setAutoArchiveDuration(autoArchiveDuration as ThreadAutoArchiveDuration);
  }

  async keepForumPostActive(threadId: string, autoArchiveDuration: number): Promise<void> {
    const channel = await this.client.channels.fetch(threadId, { force: true });
    if (!channel?.isThread()) throw new Error(`Discord channel ${threadId} is not a forum post.`);
    if (channel.archived) await channel.setArchived(false);
    if (channel.autoArchiveDuration !== autoArchiveDuration) {
      await channel.setAutoArchiveDuration(autoArchiveDuration as ThreadAutoArchiveDuration);
    }
  }

  async pinForumPost(threadId: string): Promise<void> {
    const channel = await this.client.channels.fetch(threadId, { force: true });
    if (!channel?.isThread()) throw new Error(`Discord channel ${threadId} is not a forum post.`);
    await channel.pin();
  }

  private threadSnapshot(thread: ThreadChannel, starterMessageId: string | null = thread.id): DiscordThreadSnapshot {
    return {
      id: thread.id,
      parentChannelId: thread.parentId ?? '',
      starterMessageId,
      name: thread.name,
      archived: thread.archived ?? false,
    };
  }

  async startThreadOnMessage(
    channelId: string,
    starterMessageId: string,
    name: string,
    autoArchiveDuration: number,
  ): Promise<DiscordThreadSnapshot> {
    const channel = await this.messageChannel(channelId);
    const message = await channel.messages.fetch({ message: starterMessageId, force: true });
    const thread = await message.startThread({
      name,
      autoArchiveDuration: autoArchiveDuration as ThreadAutoArchiveDuration,
    });
    return this.threadSnapshot(thread, starterMessageId);
  }

  async fetchThread(
    channelId: string,
    threadId: string | null,
    starterMessageId: string | null,
  ): Promise<DiscordThreadSnapshot | null> {
    const parent = await this.messageChannel(channelId);
    const fetchThreadChannel = async (id: string): Promise<DiscordThreadSnapshot | null> => {
      try {
        const channel = await this.client.channels.fetch(id, { force: true });
        if (!channel || !channel.isThread() || channel.parentId !== parent.id) return null;
        const associatedStarter = starterMessageId && id === starterMessageId ? starterMessageId : channel.id;
        return this.threadSnapshot(channel, associatedStarter);
      } catch (error) {
        if (isUnknownDiscordResource(error)) return null;
        throw error;
      }
    };

    if (threadId) {
      const stored = await fetchThreadChannel(threadId);
      if (stored) return stored;
    }
    if (!starterMessageId) return null;

    try {
      const message = await parent.messages.fetch({ message: starterMessageId, force: true });
      if (message.thread && message.thread.parentId === parent.id) {
        return this.threadSnapshot(message.thread, starterMessageId);
      }
    } catch (error) {
      if (!isUnknownDiscordResource(error)) throw error;
    }

    // Message based thread IDs equal their starter message IDs, including archived threads.
    return fetchThreadChannel(starterMessageId);
  }

  async sendToThread(threadId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    const channel = await this.client.channels.fetch(threadId, { force: true });
    if (!channel || !channel.isThread()) throw new Error(`Discord channel ${threadId} is not a thread.`);
    const message = await channel.send({
      content: payload.content,
      embeds: payload.embeds?.map(embedBuilder),
      ...(payload.components === undefined ? {} : { components: actionRowBuilders(payload.components) }),
      allowedMentions: { parse: [], users: payload.allowedMentions?.users ?? [] },
      ...(payload.suppressEmbeds ? { flags: MessageFlags.SuppressEmbeds } : {}),
    });
    return messageSnapshot(message, this.client.user?.id);
  }

  async deleteThreadMessage(threadId: string, messageId: string): Promise<void> {
    const channel = await this.messageChannel(threadId);
    const message = await channel.messages.fetch({ message: messageId, force: true });
    await message.delete();
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId, { force: true });
    if (!channel || !channel.isTextBased() || !('messages' in channel)) return;
    const message = await (channel as TextChannel | ThreadChannel).messages.fetch({ message: messageId, force: true });
    await message.delete();
  }

  async deleteDiscordThread(threadId: string): Promise<void> {
    const thread = await this.client.channels.fetch(threadId, { force: true });
    if (!thread?.isThread()) return;
    await thread.delete();
  }

  async createScheduledEvent(guildId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> {
    const guild = await this.client.guilds.fetch(guildId);
    const event = await guild.scheduledEvents.create({
      name: payload.name,
      scheduledStartTime: new Date(payload.startUtc),
      scheduledEndTime: new Date(payload.endUtc),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: payload.location },
      description: payload.description,
    });
    return scheduledSnapshot(event);
  }

  async editScheduledEvent(guildId: string, eventId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> {
    const guild = await this.client.guilds.fetch(guildId);
    const event = await guild.scheduledEvents.edit(eventId, {
      name: payload.name,
      scheduledStartTime: new Date(payload.startUtc),
      scheduledEndTime: new Date(payload.endUtc),
      entityMetadata: { location: payload.location },
      description: payload.description,
    });
    return scheduledSnapshot(event);
  }

  async deleteScheduledEvent(guildId: string, eventId: string): Promise<void> {
    const guild = await this.client.guilds.fetch(guildId);
    await guild.scheduledEvents.delete(eventId);
  }

  async listScheduledEvents(guildId: string): Promise<ScheduledEventSnapshot[]> {
    const guild = await this.client.guilds.fetch(guildId);
    const events = await guild.scheduledEvents.fetch();
    return [...events.values()].map(scheduledSnapshot);
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.messageChannel(channelId);
    const message = await channel.messages.fetch({ message: messageId, force: true });
    await message.pin();
  }

  async sendLog(channelId: string, content: string): Promise<void> {
    await this.createMessage(channelId, { content: formatLogContent(content), suppressEmbeds: true });
  }
}

export function createDiscordClient(): Client {
  return new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
}

export async function startHourlyScheduler(
  cycleBody: CycleBody,
  options: HourlySchedulerOptions = {},
): Promise<void> {
  const clock = options.clock ?? systemClock;
  const signal = options.signal;
  let nextTickAt = clock.now();
  let activeCycle: Promise<void> | undefined;

  while (!signal?.aborted) {
    const wait = Math.max(0, nextTickAt - clock.now());
    if (wait > 0) await clock.sleep(wait, signal);
    if (signal?.aborted) break;

    const tickAt = nextTickAt;
    nextTickAt += CYCLE_INTERVAL_MS;
    if (activeCycle !== undefined) {
      (options.onSkipped ?? ((at) => log.warn(
        `Stundenzyklus vom ${new Date(at).toISOString()} übersprungen, weil der vorherige Zyklus noch läuft.`,
      )))(tickAt);
      continue;
    }

    activeCycle = cycleBody()
      .catch((error: unknown) => {
        (options.onCycleError ?? ((cause) => log.error('Der Stundenzyklus ist fehlgeschlagen:', describeError(cause))))(error);
      })
      .finally(() => {
        activeCycle = undefined;
      });
  }

  await activeCycle;
}

export function createCoalescedCycleRunner<T>(cycleBody: () => Promise<T>): () => Promise<T> {
  let active: Promise<T> | undefined;
  return () => {
    if (active) return active;
    const run = cycleBody().finally(() => { active = undefined; });
    active = run;
    return run;
  };
}

export function createLoggedCycleRunner(
  cycleOptions: CycleOptions,
  fetchStats: { notModified: number } = { notModified: 0 },
): () => Promise<CycleResult | undefined> {
  return createCoalescedCycleRunner(async () => {
    const startedAt = performance.now();
    const notModifiedBefore = fetchStats.notModified;
    log.info('Zyklus gestartet');
    try {
      const result = await runCycle(cycleOptions);
      const cached = fetchStats.notModified - notModifiedBefore + result.duplicatesAvoided;
      log.info(`Zyklus fertig: ${result.newEvents} neue Events, ${result.postsCreated} Beiträge neu, ${result.postsEdited} bearbeitet, ${result.requests} Anfragen (${cached} aus Cache/304) in ${Math.round((performance.now() - startedAt) / 1_000)} s`);
      return result;
    } catch (error) {
      log.error('Der Stundenzyklus ist fehlgeschlagen:', error);
      log.stack(error);
      return undefined;
    }
  });
}

export const GUILD_SYNC_COOLDOWN_MS = 10 * 60_000;
export const GLOBAL_SYNC_COOLDOWN_MS = 5 * 60_000;

export interface SyncCooldown {
  /** Returns the remaining wait in milliseconds, or 0 when a manual sync is allowed. */
  remaining(guildId: string): number;
  start(guildId: string): void;
}

export function createSyncCooldown(now: () => number = Date.now): SyncCooldown {
  const guildStarts = new Map<string, number>();
  let globalStart: number | undefined;
  return {
    remaining(guildId) {
      const at = now();
      const guildWait = (guildStarts.get(guildId) ?? -Infinity) + GUILD_SYNC_COOLDOWN_MS - at;
      const globalWait = (globalStart ?? -Infinity) + GLOBAL_SYNC_COOLDOWN_MS - at;
      return Math.max(0, guildWait, globalWait);
    },
    start(guildId) {
      guildStarts.set(guildId, now());
      globalStart = now();
    },
  };
}

function formatWait(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} Min ${seconds % 60} s` : `${seconds} s`;
}

function describeSyncResult(counts: ActionCounts): string {
  const created = counts.postCreated + counts.postRecreated;
  const scheduled = counts.scheduledCreated + counts.scheduledUpdated;
  const parts = [
    created > 0 ? `${created} ${created === 1 ? 'Beitrag' : 'Beiträge'} neu angelegt` : '',
    counts.postEdited > 0 ? `${counts.postEdited} bearbeitet` : '',
    counts.postArchived > 0 ? `${counts.postArchived} archiviert` : '',
    counts.postUnarchived > 0 ? `${counts.postUnarchived} entarchiviert` : '',
    scheduled > 0 ? `${scheduled} geplante${scheduled === 1 ? 's Event' : ' Events'} angelegt oder aktualisiert` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `Fertig: ${parts.join(', ')}.` : 'Fertig: Alles ist bereits aktuell.';
}

export async function handleFfEventsAbgleichen(
  interaction: ChatInputCommandInteraction,
  store: ReturnType<typeof openDb>,
  deps: {
    runCycle: () => Promise<CycleResult | undefined>;
    runGuildSync: (guildId: string) => Promise<void>;
    cooldown: SyncCooldown;
  },
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: 'Dieser Befehl funktioniert nur auf einem Server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Dafür brauchst du die Berechtigung „Server verwalten“.', flags: MessageFlags.Ephemeral });
    return;
  }
  const guildId = interaction.guildId;
  const stored = getGuild(store, guildId);
  if (!stored?.eventChannelId || stored.needsSetup) {
    await interaction.reply({ content: 'Der Bot ist auf diesem Server noch nicht eingerichtet. Bitte richte ihn mit `/ffevents setup` ein.', flags: MessageFlags.Ephemeral });
    return;
  }
  const wait = deps.cooldown.remaining(guildId);
  if (wait > 0) {
    await interaction.reply({ content: `Der Abgleich ist gerade gesperrt. Bitte versuche es in ${formatWait(wait)} erneut.`, flags: MessageFlags.Ephemeral });
    return;
  }
  deps.cooldown.start(guildId);
  log.info(`${interaction.guild.name}: Abgleich von ${interaction.user.username ?? interaction.user.id} angefordert`);
  await interaction.reply({ content: 'Abgleich gestartet …', flags: MessageFlags.Ephemeral });

  const before = snapshotActions(guildId);
  try {
    const result = await deps.runCycle();
    if (!result?.syncedGuildIds.includes(guildId)) await deps.runGuildSync(guildId);
  } catch (error) {
    log.error(`Abgleich auf ${interaction.guild.name} fehlgeschlagen:`, error);
    await interaction.editReply({ content: 'Der Abgleich ist fehlgeschlagen. Bitte versuche es später erneut.' });
    return;
  }
  await interaction.editReply({ content: `${describeSyncResult(diffActions(snapshotActions(guildId), before))}\nVersion: ${versionLine()}` });
}

export function createSetupSyncRunner(
  store: Store,
  runSharedCycle: () => Promise<CycleResult | undefined>,
  runGuildSync: (guildId: string) => Promise<void>,
): (guildId: string) => Promise<void> {
  return async (guildId) => {
    if (isFirstRun(store)) {
      const result = await runSharedCycle();
      if (result?.syncedGuildIds.includes(guildId)) return;
    }
    await runGuildSync(guildId);
  };
}

export async function startReminderScheduler(
  reminderBody: CycleBody,
  options: ReminderSchedulerOptions = {},
): Promise<void> {
  const clock = options.clock ?? systemClock;
  const interval = Math.max(1, options.intervalMs ?? REMINDER_INTERVAL_MS);
  const signal = options.signal;
  let nextTickAt = clock.now() + interval;
  while (!signal?.aborted) {
    const wait = Math.max(0, nextTickAt - clock.now());
    if (wait > 0) await clock.sleep(wait, signal);
    if (signal?.aborted) break;
    nextTickAt = clock.now() + interval;
    try {
      await reminderBody();
    } catch (error) {
      (options.onCycleError ?? ((cause) => log.error('Der Erinnerungslauf ist fehlgeschlagen.', cause)))(error);
    }
  }
}

export function createQueuedFetchText(queue: LodestoneRequestQueue, stats?: { notModified: number }): FetchText {
  const cache = new Map<string, { body: string; finalUrl: string; etag?: string; lastModified?: string }>();
  return async (url, options) => {
    const previous = cache.get(url);
    const startedAt = performance.now();
    const logRequest = (status: number | string, note = ''): void => {
      log.debug(`Lodestone-Anfrage: ${url} → ${status} in ${Math.round(performance.now() - startedAt)} ms${note}`);
    };
    const result = await queue.fetch(url, {
      priority: options.priority,
      ...(previous?.etag ? { etag: previous.etag } : {}),
      ...(previous?.lastModified ? { lastModified: previous.lastModified } : {}),
      maxRetries: options.priority === 'item' ? 0 : 3,
    });
    if (!(result instanceof Response)) {
      if (result.status === 304 && stats) stats.notModified += 1;
      logRequest(result.status, ', aus Cache');
      if (result.status === 304 && previous) return { status: 200, ...previous };
      return { status: result.status, body: '', finalUrl: previous?.finalUrl ?? url };
    }

    const body = await result.text();
    logRequest(result.status);
    const finalUrl = result.url || url;
    const etag = result.headers.get('etag') ?? undefined;
    const lastModified = result.headers.get('last-modified') ?? undefined;
    cache.set(url, {
      body,
      finalUrl,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    });
    return { status: result.status, body, finalUrl };
  };
}

export interface CliOptions {
  dryRun: boolean;
  dbPath?: string;
  dumpDir?: string;
}

export function parseCliArgs(args: readonly string[]): CliOptions {
  let dryRun = false;
  let dbPath: string | undefined;
  let dumpDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--db' || argument === '--dump') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing path after ${argument}.`);
      if (argument === '--db') dbPath = value;
      else dumpDir = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!dryRun && (dbPath !== undefined || dumpDir !== undefined)) {
    throw new Error('--db und --dump sind nur mit --dry-run verfügbar.');
  }
  return {
    dryRun,
    ...(dbPath === undefined ? {} : { dbPath }),
    ...(dumpDir === undefined ? {} : { dumpDir }),
  };
}

async function startDryRun(options: CliOptions): Promise<void> {
  log.info(versionLine());
  const config = readConfig({
    dryRun: true,
    ...(options.dbPath ? { dbPath: options.dbPath } : {}),
    ...(options.dumpDir ? { dumpDir: options.dumpDir } : {}),
  });
  const store = openDb(config.dbPath);
  const metrics = new FetchMetrics(config.fixtureDumpDir);
  const queue = new LodestoneRequestQueue({ fetch: createTrackedFetch(metrics) });
  const fetchText = createQueuedFetchText(queue);
  try {
    const result = await runDryRunCycle({ store, fetchText, fetchMetrics: metrics });
    process.stdout.write(`${result.report}\n`);
    if (result.cycle.blind) process.exitCode = 1;
  } finally {
    store.close();
  }
}

export async function startBot(): Promise<void> {
  const config = readConfig();
  configureLog({ level: config.logLevel });
  log.info(versionLine());
  const store = openDb(config.dbPath);
  const web = { codec: createTokenCodec(config.webLinkSecret), baseUrl: config.webBaseUrl };
  const webServer = createWebServer({ store, codec: web.codec, baseUrl: web.baseUrl, trustProxy: true });
  webServer.listen(config.webPort, '0.0.0.0', () => log.info(`Web-Checkliste lauscht auf Port ${config.webPort}`));
  const client = createDiscordClient();
  const discord = new DiscordJsPort(client);
  configureLog({
    level: config.logLevel,
    guildName: (guildId) => client.guilds.cache.get(guildId)?.name,
  });
  const fetchStats = { notModified: 0 };
  const fetchText = createQueuedFetchText(new LodestoneRequestQueue(), fetchStats);
  const health = new SourceHealthMonitor(store);
  // Debug level lists every Discord write; reads stay silent.
  client.rest.on('response', (request, response) => {
    if (request.method !== 'GET') log.debug(`Discord: ${request.method} ${request.path} → ${response.status}`);
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const ready = new Promise<void>((resolveReady) => {
      if (client.isReady()) resolveReady();
      else client.once(Events.ClientReady, () => resolveReady());
    });
    await client.login(config.discordToken);
    await ready;
    reconcileStoredGuilds(store, new Set(client.guilds.cache.keys()));
    log.info(`Verbunden als ${client.user?.tag ?? 'unbekannt'}, ${getConfiguredGuilds(store).length} Server eingerichtet`);
    const application = client.application;
    if (!application) throw new Error('Discord application is unavailable after login.');
    await registerGlobalFfEventsCommand(application.commands);

    const cycleOptions = {
        store,
        discord,
        fetchText,
        health,
      };
    const runSerializedCycle = createLoggedCycleRunner(cycleOptions, fetchStats);
    const syncCooldown = createSyncCooldown();
    const runGuildSync = (guildId: string): Promise<void> => runGuildSyncFromStoredData(cycleOptions, guildId);
    const runSetupSync = createSetupSyncRunner(store, runSerializedCycle, runGuildSync);
    const runReminderPass = createCoalescedCycleRunner(async (): Promise<void> => {
      for (const guild of getConfiguredGuilds(store)) {
        const liveName = client.guilds.cache.get(guild.guildId)?.name;
        if (liveName) setGuildName(store, guild.guildId, liveName);
        try {
          await syncEventReminders({
            guildId: guild.guildId,
            channelId: guild.eventChannelId!,
            events: getAllEvents(store),
            store,
            discord,
            now: new Date(),
          });
        } catch (error) {
          log.error(`Erinnerungen für Server ${guild.guildId} konnten nicht synchronisiert werden.`, error);
        }
      }
    });
    const reminderScheduler = startReminderScheduler(runReminderPass, {
      signal: controller.signal,
      onCycleError: (error) => log.error('Der Erinnerungslauf ist fehlgeschlagen.', error),
    });
    void runReminderPass();

    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand() && interaction.commandName === 'ffevents') {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'abgleichen') {
          void handleFfEventsAbgleichen(interaction, store, {
            runCycle: runSerializedCycle,
            runGuildSync,
            cooldown: syncCooldown,
          }).catch((error: unknown) => {
            log.error('Der Abgleich konnte nicht abgeschlossen werden.', error);
          });
        } else if (subcommand === 'neuer-link') {
          void handleNewLinkCommand(interaction, store, web).catch((error: unknown) => {
            log.error('Der neue Checklisten-Link konnte nicht erstellt werden.', error);
          });
        } else if (subcommand === 'folgen') {
          void handleSidebarFollowCommand(interaction, store, discord).catch((error: unknown) => {
            log.error('Die Seitenleisten-Einstellung konnte nicht abgeschlossen werden.', error);
          });
        } else {
          void handleFfEventsSetup(interaction, store, runSetupSync, discord).catch((error: unknown) => {
            log.error('Die Einrichtung konnte nicht abgeschlossen werden.', error);
          });
        }
      } else if (interaction.isButton() && interaction.customId.startsWith(SIDEBAR_FOLLOW_CUSTOM_ID_PREFIX)) {
        void handleSidebarFollowButton(interaction, store, discord).catch((error: unknown) => {
          log.error('Die Seitenleisten-Einstellung konnte nicht umgeschaltet werden.', error);
        });
      } else if (interaction.isButton() && interaction.customId.startsWith('ffe:cl:')) {
        void handleChecklistInteraction(interaction, store, web).catch((error: unknown) => {
          log.error('Die Checkliste konnte nicht verarbeitet werden.', error);
        });
      }
    });
    client.on(Events.GuildDelete, (guild) => deleteGuild(store, guild.id));
    client.on(Events.ChannelDelete, (channel) => {
      const guildId = 'guildId' in channel ? channel.guildId : null;
      if (!guildId) return;
      void handleChannelDelete(guildId, channel.id, store, discord).catch((error: unknown) => {
        log.error('Der gelöschte Kanal konnte nicht protokolliert werden.', error);
      });
    });

    await startHourlyScheduler(async () => { await runSerializedCycle(); }, {
      signal: controller.signal,
      onCycleError: (error) => log.error('Der Stundenzyklus ist fehlgeschlagen.', error),
    });
    await reminderScheduler;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    webServer.close();
    store.close();
    client.destroy();
  }
}

export async function handleFfEventsSetup(
  interaction: ChatInputCommandInteraction,
  store: ReturnType<typeof openDb>,
  runGuildSync: (guildId: string) => Promise<void>,
  discordPort?: DiscordPort,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: 'Dieser Befehl funktioniert nur auf einem Server.', flags: MessageFlags.Ephemeral });
    return;
  }
  const guildName = interaction.guild.name;
  if (interaction.options.getSubcommand() !== 'setup') {
    await interaction.reply({ content: 'Dieser Unterbefehl ist nicht verfügbar.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Dafür brauchst du die Berechtigung „Server verwalten“.', flags: MessageFlags.Ephemeral });
    return;
  }
  const eventChannel = interaction.options.getChannel('event-kanal', true) as ForumChannel;
  const logChannel = interaction.options.getChannel('log-kanal', true) as TextChannel;
  const isGuildText = (channel: TextChannel) => channel.guildId === interaction.guildId &&
    (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement);
  const isGuildForum = eventChannel.guildId === interaction.guildId && eventChannel.type === ChannelType.GuildForum;
  if (!isGuildForum || !isGuildText(logChannel)) {
    await interaction.reply({ content: 'Bitte wähle einen Forumkanal für Events und einen Textkanal für das Log dieses Servers aus.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let botMember;
  try {
    botMember = await interaction.guild.members.fetchMe();
  } catch (error) {
    log.error('Die Bot-Berechtigungen konnten nicht abgerufen werden.', error);
    await interaction.editReply({ content: 'Die Berechtigungen des Bots konnten gerade nicht geprüft werden. Bitte versuche es erneut.' });
    return;
  }
  const eventPermissions = eventChannel.permissionsFor(botMember);
  const missing = missingSetupPermissions(botMember.permissions, eventPermissions, logChannel.permissionsFor(botMember));
  if (missing.length > 0) {
    await interaction.editReply({ content: `Mir fehlen noch diese Berechtigungen:\n${missing.map((permission) => `• ${permission}`).join('\n')}` });
    return;
  }

  let setupHints = setupPermissionHints(eventPermissions);
  let forumTagSetup;
  const discord = discordPort ?? new DiscordJsPort(interaction.client);
  try {
    forumTagSetup = await ensureForumTags(discord, eventChannel.id, Boolean(eventPermissions?.has(PermissionFlagsBits.ManageChannels)));
    if (forumTagSetup.createdNames.length > 0) log.info(`${guildName}: Forum-Tags angelegt (${forumTagSetup.createdNames.join(', ')})`);
    if (forumTagSetup.missingNames.length > 0) {
      setupHints.push(`Im Forum fehlen diese Tags, die ich nicht anlegen konnte: ${forumTagSetup.missingNames.join(', ')}.`);
    }
  } catch (error) {
    log.error('Die Forum-Tags konnten nicht vorbereitet werden.', error);
    setupHints.push('Die Forum-Tags konnten gerade nicht vollständig vorbereitet werden; vorhandene Tags werden verwendet.');
  }

  try {
    await withGuildDiscordLock(interaction.guildId, async () => {
      upsertGuildSetup(store, {
        guildId: interaction.guildId,
        eventChannelId: eventChannel.id,
        logChannelId: logChannel.id,
      });
      setGuildName(store, interaction.guildId, guildName);
      await runGuildSync(interaction.guildId);
      log.info(`${guildName}: Server eingerichtet`);
    });
  } catch (error) {
    log.error('Der erste Server-Abgleich ist fehlgeschlagen.', error);
  }
  const hintText = setupHints.length > 0 ? `\nHinweis: ${setupHints.join(' ')}` : '';
  try {
    await logChannel.send({
      content: formatLogContent(`✅ Einrichtung gespeichert. Event-Forum: <#${eventChannel.id}> · Log-Kanal: <#${logChannel.id}>.${hintText}`),
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    log.warn(`Setup-Bestätigung für Server ${interaction.guildId} konnte nicht im Log-Kanal gesendet werden.`, error);
  }
  await interaction.editReply({
    content: `✅ Einrichtung gespeichert. Event-Forum: <#${eventChannel.id}> · Log-Kanal: <#${logChannel.id}>. Der erste Abgleich für diesen Server startet jetzt.${hintText ? `\n${hintText.trim()}` : ''}`,
  });
}

export function reconcileStoredGuilds(store: ReturnType<typeof openDb>, activeGuildIds: ReadonlySet<string>): void {
  for (const guildId of getStoredGuildIds(store)) {
    if (!activeGuildIds.has(guildId)) deleteGuild(store, guildId);
  }
}

export async function handleChannelDelete(
  guildId: string,
  channelId: string,
  store: ReturnType<typeof openDb>,
  discord: Pick<DiscordPort, 'sendLog'>,
): Promise<void> {
  await withGuildDiscordLock(guildId, async () => {
    const guild = getGuild(store, guildId);
    if (!guild || (guild.eventChannelId !== channelId && guild.logChannelId !== channelId)) return;
    markGuildNeedsSetup(store, guildId);
    if (guild.eventChannelId === channelId && guild.logChannelId && guild.logChannelId !== channelId) {
      await discord.sendLog(guild.logChannelId,
        'Der Event-Kanal wurde gelöscht. Bitte richte den Bot mit `/ffevents setup` erneut ein.');
    }
  });
}

export { redactToken };

export function describeError(error: unknown): string {
  return redactToken(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

export async function main(cycleBody?: CycleBody, options: HourlySchedulerOptions = {}): Promise<void> {
  if (cycleBody) {
    await startHourlyScheduler(cycleBody, options);
    return;
  }
  const cliOptions = parseCliArgs(process.argv.slice(2));
  if (cliOptions.dryRun) {
    await startDryRun(cliOptions);
  } else {
    await startBot();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    log.error('Der Bot wurde beendet:', describeError(error));
    process.exitCode = 1;
  });
}
