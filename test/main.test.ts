import assert from 'node:assert/strict';
import { ButtonStyle, ChannelType, Client, GatewayIntentBits, Guild, Message, MessageFlags, PermissionsBitField, PermissionFlagsBits, TextChannel } from 'discord.js';
import test from 'node:test';
import { readConfig } from '../src/config.ts';
import { CYCLE_INTERVAL_MS, createCoalescedCycleRunner, createDiscordClient, DiscordJsPort, handleChannelDelete, handleFfEventsSetup, parseCliArgs, reconcileStoredGuilds, REMINDER_INTERVAL_MS, startHourlyScheduler, startReminderScheduler } from '../src/main.ts';
import { getGuild, openDb, upsertGuildSetup } from '../src/store.ts';

class FakeClock {
  private time = 0;
  private waiters: Array<{ at: number; resolve: () => void; signal?: AbortSignal; abort?: () => void }> = [];

  now(): number {
    return this.time;
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { at: this.time + milliseconds, resolve, signal } as {
        at: number; resolve: () => void; signal?: AbortSignal; abort?: () => void;
      };
      waiter.abort = () => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        signal?.removeEventListener('abort', waiter.abort!);
        resolve();
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  async advance(milliseconds: number): Promise<void> {
    this.time += milliseconds;
    const due = this.waiters.filter((waiter) => waiter.at <= this.time);
    this.waiters = this.waiters.filter((waiter) => waiter.at > this.time);
    for (const waiter of due) {
      if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.resolve();
    }
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

test('hourly scheduler logs a skipped tick and never overlaps a long cycle', async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  const skips: number[] = [];
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let releaseFirstCycle!: () => void;
  const scheduler = startHourlyScheduler(async () => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (calls === 1) await new Promise<void>((resolve) => { releaseFirstCycle = resolve; });
    active -= 1;
  }, {
    clock,
    signal: controller.signal,
    onSkipped: (tickAt) => skips.push(tickAt),
  });

  await flushMicrotasks();
  assert.equal(calls, 1);
  await clock.advance(CYCLE_INTERVAL_MS);
  assert.deepEqual(skips, [CYCLE_INTERVAL_MS]);
  assert.equal(calls, 1);
  releaseFirstCycle();
  await flushMicrotasks();
  controller.abort();
  await flushMicrotasks();
  await scheduler;

  assert.equal(maximumActive, 1);
});

test('reminder scheduler wakes independently every five minutes', async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  let calls = 0;
  const scheduler = startReminderScheduler(async () => { calls += 1; }, {
    clock, signal: controller.signal, intervalMs: REMINDER_INTERVAL_MS,
  });
  await flushMicrotasks();
  assert.equal(calls, 0);
  await clock.advance(REMINDER_INTERVAL_MS);
  assert.equal(calls, 1);
  await clock.advance(REMINDER_INTERVAL_MS);
  assert.equal(calls, 2);
  controller.abort();
  await flushMicrotasks();
  await scheduler;
});

test('overlapping global discovery requests share one in-flight cycle', async () => {
  let calls = 0;
  let release!: () => void;
  const runCycle = createCoalescedCycleRunner(async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
  });

  const first = runCycle();
  const second = runCycle();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  const next = runCycle();
  assert.equal(calls, 2);
  release();
  await next;
});

test('dry-run config works without environment while production still requires Discord credentials', () => {
  const dryRunConfig = readConfig({ dryRun: true, env: {} });

  assert.equal(dryRunConfig.dbPath, ':memory:');
  assert.throws(() => readConfig({ env: {} }), /DISCORD_TOKEN/);
});

test('runtime configuration accepts only shared token and optional paths', () => {
  const config = readConfig({ env: { DISCORD_TOKEN: 'token' } });
  assert.equal(config.discordToken, 'token');
  assert.equal(config.dbPath, './data/ffeventnotify.sqlite');
  assert.equal(config.fixtureDumpDir, undefined);
  assert.deepEqual(readConfig({ dryRun: true, env: {} }), { dbPath: ':memory:' });
});

test('dry-run CLI accepts an optional database and dump directory', () => {
  assert.deepEqual(parseCliArgs(['--dry-run', '--db', './dry-run.sqlite', '--dump', './lodestone-dump']), {
    dryRun: true,
    dbPath: './dry-run.sqlite',
    dumpDir: './lodestone-dump',
  });
  assert.throws(() => parseCliArgs(['--dry-run', '--db']), /Missing path/);
});

function rawGuild(id: string) {
  return {
    id, name: 'offline test guild', icon: null, owner_id: '223456789012345678', permissions: '0', features: [],
    verification_level: 0, default_message_notifications: 0, explicit_content_filter: 0, roles: [], emojis: [], stickers: [],
    mfa_level: 0, application_id: null, system_channel_id: null, system_channel_flags: 0, rules_channel_id: null,
    public_updates_channel_id: null, preferred_locale: 'en-US', safety_alerts_channel_id: null, nsfw_level: 0, nsfw: false,
  };
}

function rawTextChannel(guildId: string, id: string) {
  return {
    id, type: ChannelType.GuildText, guild_id: guildId, name: 'offline test channel', position: 0,
    permission_overwrites: [], topic: null, nsfw: false, last_message_id: null, rate_limit_per_user: 0, parent_id: null,
  };
}

function rawMessage(guildId: string, channelId: string, id: string, content: string) {
  return {
    id, channel_id: channelId, guild_id: guildId,
    author: { id: '523456789012345678', username: 'Bot', avatar: null, discriminator: '0', global_name: null, bot: true },
    content, timestamp: new Date('2026-10-16T12:00:00.000Z').toISOString(), edited_timestamp: null,
    tts: false, mention_everyone: false, mentions: [], attachments: [], embeds: [], pinned: false, type: 0, flags: 0,
    components: [{ type: 1, components: [{ type: 2, style: ButtonStyle.Primary, label: 'Meine Checkliste', custom_id: 'ffe:cl:0123456789abcdef0123456789abcdef' }] }],
  };
}

test('DiscordJsPort forces stored-message REST reads and snapshots raw component payloads', async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const guild = Reflect.construct(Guild as unknown as Function, [client, rawGuild('123456789012345678')]) as Guild;
  const channel = Reflect.construct(TextChannel as unknown as Function, [guild, rawTextChannel(guild.id, '323456789012345678'), client]) as TextChannel;
  const stale = Reflect.construct(Message as unknown as Function, [client, { ...rawMessage(guild.id, channel.id, '423456789012345678', 'stale cache') }, channel]) as Message;
  channel.messages.cache.set(stale.id, stale as never);
  client.channels.fetch = async () => channel;
  let restReads = 0;
  client.rest.get = async () => { restReads += 1; return rawMessage(guild.id, channel.id, stale.id, 'fresh REST state'); };
  const port = new DiscordJsPort(client);
  try {
    const snapshot = await port.fetchMessage(channel.id, stale.id);
    assert.equal(restReads, 1);
    assert.equal(snapshot?.content, 'fresh REST state');
    assert.deepEqual(snapshot?.components?.[0]?.components[0], {
      type: 'button', style: 'primary', label: 'Meine Checkliste', customId: 'ffe:cl:0123456789abcdef0123456789abcdef',
    });
  } finally {
    client.destroy();
  }
});

test('DiscordJsPort treats the Discord Unknown Message response as confirmed absence', async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const guild = Reflect.construct(Guild as unknown as Function, [client, rawGuild('123456789012345678')]) as Guild;
  const channel = Reflect.construct(TextChannel as unknown as Function, [guild, rawTextChannel(guild.id, '323456789012345678'), client]) as TextChannel;
  client.channels.fetch = async () => channel;
  let code = 10008;
  client.rest.get = async () => { throw Object.assign(new Error(code === 10008 ? 'Unknown Message' : 'Unknown Channel'), { code }); };
  try {
    assert.equal(await new DiscordJsPort(client).fetchMessage(channel.id, '423456789012345678'), null);
    code = 10003;
    assert.equal(await new DiscordJsPort(client).fetchMessage(channel.id, '423456789012345678'), null);
  } finally {
    client.destroy();
  }
});

test('DiscordJsPort retains raw API components during an embed-only edit', async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.user = { id: '523456789012345678' } as never;
  const guild = Reflect.construct(Guild as unknown as Function, [client, rawGuild('123456789012345678')]) as Guild;
  const channel = Reflect.construct(TextChannel as unknown as Function, [guild, rawTextChannel(guild.id, '323456789012345678'), client]) as TextChannel;
  const id = '423456789012345678';
  client.channels.cache.set(channel.id, channel as never);
  client.channels.fetch = async () => channel;
  client.rest.get = async () => rawMessage(guild.id, channel.id, id, 'old content');
  let patchOptions: unknown;
  client.rest.patch = async (_route, options) => {
    patchOptions = options;
    return rawMessage(guild.id, channel.id, id, 'edited content');
  };
  const port = new DiscordJsPort(client);
  try {
    await port.editMessage(channel.id, id, { embeds: [{ title: 'Updated' }] });
    const body = (patchOptions as { body: { components: Array<{ components: Array<{ custom_id: string }> }> } }).body;
    assert.equal(body.components[0]?.components[0]?.custom_id, 'ffe:cl:0123456789abcdef0123456789abcdef');
  } finally {
    client.destroy();
  }
});

test('DiscordJsPort disables implicit mention parsing while retaining explicit reminder users', async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  const guild = Reflect.construct(Guild as unknown as Function, [client, rawGuild('123456789012345678')]) as Guild;
  const channel = Reflect.construct(TextChannel as unknown as Function, [guild, rawTextChannel(guild.id, '323456789012345678'), client]) as TextChannel;
  client.channels.fetch = async () => channel;
  let postOptions: unknown;
  client.rest.post = async (_route, options) => {
    postOptions = options;
    return rawMessage(guild.id, channel.id, '423456789012345678', 'reminder');
  };
  try {
    await new DiscordJsPort(client).createMessage(channel.id, {
      content: '<@user-1> @everyone', allowedMentions: { parse: [], users: ['user-1'] },
    });
    const body = (postOptions as { body: { allowed_mentions: { parse: string[]; users: string[] } } }).body;
    assert.deepEqual(body.allowed_mentions, { parse: [], users: ['user-1'] });
  } finally {
    client.destroy();
  }
});

test('production Discord client only enables guild events and disables implicit mention parsing', () => {
  const client = createDiscordClient();
  try {
    assert.equal(client.options.intents.bitfield, GatewayIntentBits.Guilds);
    assert.deepEqual(client.options.allowedMentions, { parse: [] });
  } finally {
    client.destroy();
  }
});

test('stored guilds absent from the ready gateway cache are deleted', () => {
  const db = openDb(':memory:');
  try {
    upsertGuildSetup(db, { guildId: 'present', eventChannelId: 'e1', logChannelId: 'l1' });
    upsertGuildSetup(db, { guildId: 'departed-offline', eventChannelId: 'e2', logChannelId: 'l2' });
    reconcileStoredGuilds(db, new Set(['present']));
    assert.ok(getGuild(db, 'present'));
    assert.equal(getGuild(db, 'departed-offline'), undefined);
  } finally {
    db.close();
  }
});

test('setup defers before fetching the bot member and completes with editReply', async () => {
  const db = openDb(':memory:');
  const order: string[] = [];
  const channelPermissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages,
  ]);
  const guildId = '123456789012345678';
  const eventChannel = { id: '323456789012345678', guildId, type: ChannelType.GuildText, permissionsFor: () => channelPermissions };
  const logChannel = { id: '423456789012345678', guildId, type: ChannelType.GuildText, permissionsFor: () => channelPermissions };
  const interaction = {
    guildId,
    guild: { members: { fetchMe: async () => { order.push('fetch'); return { permissions: new PermissionsBitField([PermissionFlagsBits.CreateEvents]) }; } } },
    memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]),
    inGuild: () => true,
    options: { getSubcommand: () => 'setup', getChannel: (name: string) => name === 'event-kanal' ? eventChannel : logChannel },
    deferReply: async (options: { flags: MessageFlags }) => { order.push('defer'); assert.equal(options.flags, MessageFlags.Ephemeral); },
    editReply: async (options: { content: string }) => { order.push('edit'); assert.match(options.content, /Einrichtung gespeichert/); },
  };
  try {
    await handleFfEventsSetup(interaction as never, db, async (selectedGuildId) => { order.push(`sync:${selectedGuildId}`); });
    assert.deepEqual(order, ['defer', 'fetch', `sync:${guildId}`, 'edit']);
  } finally {
    db.close();
  }
});

test('setup reports a bot-member fetch failure after acknowledging the interaction', async () => {
  const db = openDb(':memory:');
  const order: string[] = [];
  const channelPermissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages,
  ]);
  const guildId = '123456789012345678';
  const eventChannel = { id: '323456789012345678', guildId, type: ChannelType.GuildText, permissionsFor: () => channelPermissions };
  const logChannel = { id: '423456789012345678', guildId, type: ChannelType.GuildText, permissionsFor: () => channelPermissions };
  const interaction = {
    guildId,
    guild: { members: { fetchMe: async () => { order.push('fetch'); throw new Error('raw Discord failure'); } } },
    memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]),
    inGuild: () => true,
    options: { getSubcommand: () => 'setup', getChannel: (name: string) => name === 'event-kanal' ? eventChannel : logChannel },
    deferReply: async () => { order.push('defer'); },
    editReply: async (options: { content: string }) => {
      order.push('edit');
      assert.match(options.content, /Berechtigungen des Bots konnten gerade nicht geprüft werden/);
      assert.doesNotMatch(options.content, /raw Discord failure/);
    },
  };
  const loggedErrors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => { loggedErrors.push(values); };
  try {
    await handleFfEventsSetup(interaction as never, db, async () => assert.fail('sync should not run after a permission fetch failure'));
    assert.deepEqual(order, ['defer', 'fetch', 'edit']);
    assert.equal(loggedErrors.length, 1);
    assert.match(String(loggedErrors[0]?.[1]), /raw Discord failure/);
  } finally {
    console.error = originalError;
    db.close();
  }
});

test('deleting an event channel marks setup invalid and notifies through the surviving log channel', async () => {
  const db = openDb(':memory:');
  upsertGuildSetup(db, { guildId: '123456789012345678', eventChannelId: 'events', logChannelId: 'logs' });
  const notices: string[] = [];
  try {
    await handleChannelDelete('123456789012345678', 'events', db, { sendLog: async (_channel: string, content: string) => { notices.push(content); } } as never);
    assert.equal(getGuild(db, '123456789012345678')?.needsSetup, true);
    assert.match(notices[0] ?? '', /Event-Kanal wurde gelöscht.*\/ffevents setup/i);
  } finally {
    db.close();
  }
});
