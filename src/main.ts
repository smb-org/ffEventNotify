// Starts the Discord gateway and runs one non-overlapping sync cycle per hour.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Client,
  ChannelType,
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
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type GuildScheduledEvent,
  type Message,
  type TextChannel,
} from 'discord.js';
import { readConfig } from './config.ts';
import { createTrackedFetch, FetchMetrics, runDryRunCycle } from './dry-run.ts';
import { SourceHealthMonitor } from './health.ts';
import { runCycle } from './cycle.ts';
import { openDb } from './store.ts';
import { LodestoneRequestQueue } from './sources/queue.ts';
import { collectRecentBotMessages } from './discord-history.ts';
import { missingSetupPermissions, registerGlobalFfEventsCommand } from './commands.ts';
import {
  deleteGuild,
  getGuild,
  markGuildNeedsSetup,
  upsertGuildSetup,
} from './store.ts';
import { handleChecklistInteraction } from './interactions/checklist.ts';
import type {
  DiscordActionRow,
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
      ...(payload.components === undefined ? {} : { components: actionRowBuilders(payload.components) }),
      ...(payload.allowedMentions === undefined ? {} : { allowedMentions: payload.allowedMentions }),
    });
    return messageSnapshot(message, this.client.user?.id);
  }

  async editMessage(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    const channel = await this.textChannel(channelId);
    const message = await channel.messages.fetch(messageId);
    const edited = await message.edit({
      content: payload.content ?? null,
      embeds: payload.embeds?.map(embedBuilder) ?? [],
      components: payload.components === undefined ? message.components : actionRowBuilders(payload.components),
      ...(payload.allowedMentions === undefined ? {} : { allowedMentions: payload.allowedMentions }),
    });
    return messageSnapshot(edited, this.client.user?.id);
  }

  async fetchRecentBotMessages(channelId: string, limit: number): Promise<DiscordMessageSnapshot[]> {
    const channel = await this.textChannel(channelId);
    const botId = this.client.user?.id;
    if (!botId) return [];
    return collectRecentBotMessages(async (pageSize, before) => {
      const messages = await channel.messages.fetch({ limit: pageSize, ...(before ? { before } : {}) });
      return [...messages.values()].map((message) => ({
        id: message.id,
        authorId: message.author.id,
        snapshot: messageSnapshot(message, botId),
      }));
    }, botId, limit).then((messages) => messages.map(({ snapshot }) => snapshot));
  }

  async fetchPinnedBotMessages(channelId: string): Promise<DiscordMessageSnapshot[]> {
    const channel = await this.textChannel(channelId);
    const botId = this.client.user?.id;
    if (!botId) return [];
    const messages = await channel.messages.fetchPinned();
    return [...messages.values()]
      .filter((message) => message.author.id === botId)
      .map((message) => messageSnapshot(message, botId));
  }

  async fetchMessage(channelId: string, messageId: string): Promise<DiscordMessageSnapshot | null> {
    const channel = await this.textChannel(channelId);
    try {
      const message = await channel.messages.fetch(messageId);
      return messageSnapshot(message, this.client.user?.id);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 10008) return null;
      throw error;
    }
  }

  async isTextChannel(channelId: string): Promise<boolean> {
    const channel = await this.client.channels.fetch(channelId);
    return Boolean(channel && channel.isTextBased() && 'messages' in channel);
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
        `Stundenzyklus vom ${new Date(at).toISOString()} übersprungen, weil der vorherige Zyklus noch läuft.`,
      )))(tickAt);
      continue;
    }

    activeCycle = cycleBody()
      .catch((error: unknown) => {
        (options.onCycleError ?? (() => console.error('Der Stundenzyklus ist fehlgeschlagen.')))(error);
      })
      .finally(() => {
        activeCycle = undefined;
      });
  }

  await activeCycle;
}

export function createQueuedFetchText(queue: LodestoneRequestQueue): FetchText {
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
    const application = client.application;
    if (!application) throw new Error('Discord application is unavailable after login.');
    await registerGlobalFfEventsCommand(application.commands);

    const cycleOptions = {
        store,
        discord,
        fetchText,
        health,
      };
    let cycleQueue: Promise<void> = Promise.resolve();
    const runSerializedCycle = (): Promise<void> => {
      const run = cycleQueue.then(async () => { await runCycle(cycleOptions); });
      cycleQueue = run.catch((error: unknown) => {
        console.error('Der Stundenzyklus ist fehlgeschlagen.', error);
      });
      return run;
    };

    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand() && interaction.commandName === 'ffevents') {
        void handleFfEventsSetup(interaction, store, runSerializedCycle);
      } else if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('ffe:')) {
        void handleChecklistInteraction(interaction, store);
      }
    });
    client.on(Events.GuildDelete, (guild) => deleteGuild(store, guild.id));
    client.on(Events.ChannelDelete, (channel) => {
      const guildId = 'guildId' in channel ? channel.guildId : null;
      if (!guildId) return;
      const guild = getGuild(store, guildId);
      if (guild && (guild.eventChannelId === channel.id || guild.logChannelId === channel.id)) {
        markGuildNeedsSetup(store, guildId);
      }
    });

    await startHourlyScheduler(runSerializedCycle, {
      signal: controller.signal,
      onCycleError: (error) => console.error('Der Stundenzyklus ist fehlgeschlagen.', error),
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    store.close();
    client.destroy();
  }
}

export async function handleFfEventsSetup(
  interaction: ChatInputCommandInteraction,
  store: ReturnType<typeof openDb>,
  runImmediateCycle: () => Promise<void>,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: 'Dieser Befehl funktioniert nur auf einem Server.', ephemeral: true });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Dafür brauchst du die Berechtigung „Server verwalten“.', ephemeral: true });
    return;
  }
  if (interaction.options.getSubcommand() !== 'setup') {
    await interaction.reply({ content: 'Dieser Unterbefehl ist noch nicht verfügbar.', ephemeral: true });
    return;
  }

  const eventChannel = interaction.options.getChannel('event-kanal', true) as TextChannel;
  const logChannel = interaction.options.getChannel('log-kanal', true) as TextChannel;
  const isGuildText = (channel: TextChannel) => channel.guildId === interaction.guildId &&
    (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement);
  if (!isGuildText(eventChannel) || !isGuildText(logChannel)) {
    await interaction.reply({ content: 'Bitte wähle zwei Textkanäle dieses Servers aus.', ephemeral: true });
    return;
  }

  const botMember = await interaction.guild.members.fetchMe();
  const missing = missingSetupPermissions(
    botMember.permissions,
    eventChannel.permissionsFor(botMember),
    logChannel.permissionsFor(botMember),
  );
  if (missing.length > 0) {
    await interaction.reply({
      content: `Mir fehlen noch diese Berechtigungen:\n${missing.map((permission) => `• ${permission}`).join('\n')}`,
      ephemeral: true,
    });
    return;
  }

  upsertGuildSetup(store, {
    guildId: interaction.guildId,
    eventChannelId: eventChannel.id,
    logChannelId: logChannel.id,
  });
  await interaction.reply({
    content: `✅ Einrichtung gespeichert. Event-Kanal: <#${eventChannel.id}> · Log-Kanal: <#${logChannel.id}>. Der erste Abgleich für diesen Server startet jetzt.`,
    ephemeral: true,
  });
  void runImmediateCycle().catch((error: unknown) => console.error('Der sofortige Server-Abgleich ist fehlgeschlagen.', error));
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
    console.error('Der Bot wurde beendet.');
    process.exitCode = 1;
  });
}
