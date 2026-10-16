// Starts the Discord gateway and runs one non-overlapping sync cycle per hour.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  type GuildScheduledEvent,
  type Message,
  type TextChannel,
} from 'discord.js';
import { readConfig } from './config.ts';
import { SourceHealthMonitor } from './health.ts';
import { runCycle } from './cycle.ts';
import { openDb } from './store.ts';
import { LodestoneRequestQueue } from './sources/queue.ts';
import type {
  DiscordEmbed,
  DiscordMessagePayload,
  DiscordMessageSnapshot,
  DiscordPort,
  FetchText,
  ScheduledEventPayload,
  ScheduledEventSnapshot,
  ScheduledEventStatus,
} from './types.ts';

export const CYCLE_INTERVAL_MS = 60 * 60 * 1_000;

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
  if (embed.description !== undefined) builder.setDescription(embed.description);
  if (embed.fields !== undefined) builder.addFields(embed.fields);
  if (embed.footer !== undefined) builder.setFooter(embed.footer);
  return builder;
}

function embedSnapshot(embed: Message['embeds'][number]): DiscordEmbed {
  return {
    ...(embed.title === null ? {} : { title: embed.title }),
    ...(embed.description === null ? {} : { description: embed.description }),
    ...(embed.fields.length === 0 ? {} : { fields: embed.fields.map(({ name, value, inline }) => ({ name, value, inline })) }),
    ...(embed.footer === null ? {} : { footer: { text: embed.footer.text } }),
  };
}

function messageSnapshot(message: Message, botId: string | undefined): DiscordMessageSnapshot {
  return {
    id: message.id,
    channelId: message.channelId,
    authorIsBot: botId !== undefined && message.author.id === botId,
    pinned: message.pinned,
    content: message.content,
    embeds: message.embeds.map(embedSnapshot),
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

  constructor(client: Client) {
    this.client = client;
  }

  private async textChannel(channelId: string): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('messages' in channel)) {
      throw new Error(`Discord channel ${channelId} is not a text channel.`);
    }
    return channel as TextChannel;
  }

  async createMessage(channelId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    const channel = await this.textChannel(channelId);
    const message = await channel.send({
      content: payload.content,
      embeds: payload.embeds?.map(embedBuilder),
    });
    return messageSnapshot(message, this.client.user?.id);
  }

  async editMessage(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    const channel = await this.textChannel(channelId);
    const message = await channel.messages.fetch(messageId);
    const edited = await message.edit({
      content: payload.content ?? null,
      embeds: payload.embeds?.map(embedBuilder) ?? [],
    });
    return messageSnapshot(edited, this.client.user?.id);
  }

  async fetchRecentBotMessages(channelId: string, limit: number): Promise<DiscordMessageSnapshot[]> {
    const channel = await this.textChannel(channelId);
    const messages = await channel.messages.fetch({ limit: Math.max(1, Math.min(100, Math.trunc(limit))) });
    const botId = this.client.user?.id;
    return [...messages.values()]
      .filter((message) => botId !== undefined && message.author.id === botId)
      .map((message) => messageSnapshot(message, botId));
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

  async listScheduledEvents(guildId: string): Promise<ScheduledEventSnapshot[]> {
    const guild = await this.client.guilds.fetch(guildId);
    const events = await guild.scheduledEvents.fetch();
    return [...events.values()].map(scheduledSnapshot);
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.textChannel(channelId);
    const message = await channel.messages.fetch(messageId);
    await message.pin();
  }

  async sendLog(channelId: string, content: string): Promise<void> {
    await this.createMessage(channelId, { content });
  }
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
      (options.onSkipped ?? ((at) => console.warn(
        `Hourly cycle skipped at ${new Date(at).toISOString()}: previous cycle is still running.`,
      )))(tickAt);
      continue;
    }

    activeCycle = cycleBody()
      .catch((error: unknown) => {
        (options.onCycleError ?? ((failure) => console.error('Hourly cycle failed:', failure)))(error);
      })
      .finally(() => {
        activeCycle = undefined;
      });
  }

  await activeCycle;
}

function createQueuedFetchText(queue: LodestoneRequestQueue): FetchText {
  const cache = new Map<string, { body: string; finalUrl: string; etag?: string; lastModified?: string }>();
  return async (url, options) => {
    const previous = cache.get(url);
    const result = await queue.fetch(url, {
      priority: options.priority,
      ...(previous?.etag ? { etag: previous.etag } : {}),
      ...(previous?.lastModified ? { lastModified: previous.lastModified } : {}),
      maxRetries: options.priority === 'item' ? 0 : 3,
    });
    if (!(result instanceof Response)) {
      if (result.status === 304 && previous) return { status: 200, ...previous };
      return { status: result.status, body: '', finalUrl: previous?.finalUrl ?? url };
    }

    const body = await result.text();
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

export async function startBot(): Promise<void> {
  const config = readConfig();
  const store = openDb(config.dbPath);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const discord = new DiscordJsPort(client);
  const fetchText = createQueuedFetchText(new LodestoneRequestQueue());
  const health = new SourceHealthMonitor(store);
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
    await startHourlyScheduler(async () => {
      await runCycle({
        store,
        discord,
        fetchText,
        guildId: config.guildId,
        eventChannelId: config.eventChannelId,
        logChannelId: config.logChannelId,
        health,
      });
    }, { signal: controller.signal });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    store.close();
    client.destroy();
  }
}

export async function main(cycleBody?: CycleBody, options: HourlySchedulerOptions = {}): Promise<void> {
  if (cycleBody) {
    await startHourlyScheduler(cycleBody, options);
    return;
  }
  await startBot();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => console.error('Bot stopped:', error));
}
