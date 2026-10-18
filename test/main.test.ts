import assert from 'node:assert/strict';
import { ButtonStyle, ChannelType, Client, DiscordAPIError, ForumChannel, GatewayIntentBits, Guild, Message, MessageFlags, PermissionsBitField, PermissionFlagsBits, TextChannel, ThreadChannel } from 'discord.js';
import test from 'node:test';
import { readConfig } from '../src/config.ts';
import { CYCLE_INTERVAL_MS, createCoalescedCycleRunner, createDiscordClient, DiscordJsPort, handleChannelDelete, handleFfEventsSetup, parseCliArgs, redactToken, reconcileStoredGuilds, REMINDER_INTERVAL_MS, startHourlyScheduler, startReminderScheduler } from '../src/main.ts';
import { applyField, attachSource, createEvent, getGuild, openDb, upsertGuildSetup } from '../src/store.ts';
import { runGuildSyncFromStoredData } from '../src/cycle.ts';

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
  assert.throws(() => readConfig({ env: {} }), /DISCORD_TOKEN.*WEB_BASE_URL.*WEB_LINK_SECRET/);
});

test('runtime configuration accepts only shared token and optional paths', () => {
  const secret = Buffer.alloc(32, 1).toString('base64');
  const config = readConfig({ env: { DISCORD_TOKEN: 'token', WEB_BASE_URL: 'https://ffe.example.de/', WEB_LINK_SECRET: secret } });
  assert.equal(config.discordToken, 'token');
  assert.equal(config.webBaseUrl, 'https://ffe.example.de');
  assert.equal(config.webPort, 3480);
  assert.throws(() => readConfig({ env: { DISCORD_TOKEN: 'token', WEB_BASE_URL: 'https://x.de', WEB_LINK_SECRET: 'kurz' } }), /32 bytes/);
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

function rawForumChannel(guildId: string, id: string, availableTags: Array<{ id: string; name: string }> = []) {
  return {
    id, type: ChannelType.GuildForum, guild_id: guildId, name: 'offline test forum', position: 0,
    permission_overwrites: [], topic: null, nsfw: false, rate_limit_per_user: 0, parent_id: null,
    available_tags: availableTags.map((tag) => ({ ...tag, moderated: false, emoji_id: null, emoji_name: null })),
    default_reaction_emoji: null, default_auto_archive_duration: 1440, default_thread_rate_per_user: 0,
    default_sort_order: null, default_forum_layout: 0, flags: 0,
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

function rawThread(guildId: string, parentId: string, id: string, starterMessageId: string, archived = false) {
  return {
    id, type: ChannelType.PublicThread, guild_id: guildId, parent_id: parentId, name: 'Erinnerungen: Test',
    last_message_id: null, rate_limit_per_user: 0,
    thread_metadata: {
      archived, auto_archive_duration: 10080, archive_timestamp: new Date('2026-10-16T12:00:00.000Z').toISOString(),
      locked: false, create_timestamp: new Date('2026-10-16T12:00:00.000Z').toISOString(),
    },
    member: { id, user_id: '523456789012345678', join_timestamp: new Date('2026-10-16T12:00:00.000Z').toISOString(), flags: 0 },
    message: { id: starterMessageId },
  };
}

test('DiscordJsPort starts, fetches, and sends to a public thread with real discord.js objects', async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  const guildId = '123456789012345678';
  const channelId = '323456789012345678';
  const cardId = '423456789012345678';
  const threadId = cardId;
  const guild = Reflect.construct(Guild as unknown as Function, [client, rawGuild(guildId)]) as Guild;
  const channel = Reflect.construct(TextChannel as unknown as Function, [guild, rawTextChannel(guildId, channelId), client]) as TextChannel;
  const card = Reflect.construct(Message as unknown as Function, [client, rawMessage(guildId, channelId, cardId, 'card')],) as Message;
  client.guilds.cache.set(guild.id, guild as never);
  guild.channels.cache.set(channel.id, channel as never);
  client.channels.cache.set(channel.id, channel as never);
  let serverThreadArchived = false;
  let unarchivedByMessage = false;
  client.rest.get = async (route) => {
    if (String(route).includes(`/messages/${cardId}`)) return rawMessage(guildId, channelId, cardId, 'card');
    if (String(route).includes(`/channels/${threadId}`)) return rawThread(guildId, channelId, threadId, cardId, serverThreadArchived);
    throw new Error(`Unexpected GET ${String(route)}`);
  };
  let threadCreateBody: unknown;
  let messageBody: unknown;
  client.rest.post = async (route, options) => {
    if (String(route).includes(`/messages/${cardId}/threads`)) {
      threadCreateBody = options?.body;
      return rawThread(guildId, channelId, threadId, cardId);
    }
    if (String(route).includes(`/channels/${threadId}/messages`)) {
      messageBody = options?.body;
      unarchivedByMessage = serverThreadArchived;
      serverThreadArchived = false;
      return rawMessage(guildId, threadId, '623456789012345678', 'reminder');
    }
    throw new Error(`Unexpected POST ${String(route)}`);
  };
  const rawPort = new DiscordJsPort(client) as unknown as {
    startThreadOnMessage(parentId: string, starterId: string, name: string, autoArchiveDuration: number): Promise<{ id: string; archived: boolean; starterMessageId: string | null }>;
    fetchThread(parentId: string, threadId: string | null, starterMessageId: string | null): Promise<{ id: string; archived: boolean; starterMessageId: string | null } | null>;
    sendToThread(threadId: string, payload: { content: string; allowedMentions: { parse: []; users: string[] }; suppressEmbeds: boolean }): Promise<{ id: string; channelId: string }>;
  };
  try {
    const created = await rawPort.startThreadOnMessage(channelId, card.id, 'Erinnerungen: Test', 10080);
    assert.equal(created.id, threadId);
    assert.deepEqual(threadCreateBody, {
      name: 'Erinnerungen: Test', auto_archive_duration: 10080, type: ChannelType.PublicThread,
      invitable: undefined, rate_limit_per_user: undefined,
    });

    serverThreadArchived = true;
    const thread = Reflect.construct(ThreadChannel as unknown as Function, [guild, rawThread(guildId, channelId, threadId, cardId, true), client]) as ThreadChannel;
    client.channels.cache.set(thread.id, thread as never);
    channel.threads.cache.set(thread.id, thread as never);
    const recovered = await rawPort.fetchThread(channelId, null, cardId);
    assert.equal(recovered?.id, threadId);
    assert.equal(recovered?.starterMessageId, cardId);
    assert.equal(recovered?.archived, true);

    const sent = await rawPort.sendToThread(threadId, {
      content: '<@523456789012345678> #ffe-r-marker',
      allowedMentions: { parse: [], users: ['523456789012345678'] },
      suppressEmbeds: true,
    });
    assert.equal(sent.channelId, threadId);
    const body = messageBody as { content: string; allowed_mentions: { parse: string[]; users: string[] }; flags: number };
    assert.equal(body.content, '<@523456789012345678> #ffe-r-marker');
    assert.deepEqual(body.allowed_mentions, { parse: [], users: ['523456789012345678'] });
    assert.equal(body.flags, MessageFlags.SuppressEmbeds);
    assert.equal(unarchivedByMessage, true, 'sending to an archived thread activates it');
  } finally {
    client.destroy();
  }
});

test('DiscordJsPort forum methods use real discord.js forum and thread classes with REST stubbed', async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  const guildId = '123456789012345678';
  const forumId = '323456789012345678';
  const postId = '423456789012345678';
  const archivedA = '523456789012345678';
  const archivedB = '623456789012345678';
  const guild = Reflect.construct(Guild as unknown as Function, [client, rawGuild(guildId)]) as Guild;
  const forum = Reflect.construct(ForumChannel as unknown as Function, [guild, rawForumChannel(guildId, forumId, [{ id: 'tag-1', name: 'Läuft' }]), client]) as ForumChannel;
  const threadData = new Map<string, ReturnType<typeof rawThread> & { applied_tags: string[] }>();
  const messages = new Map<string, ReturnType<typeof rawMessage>>();
  const requests: Array<{ method: string; route: string; body?: Record<string, unknown> }> = [];
  let nextPost = postId;
  let archivedPage = 0;
  let memberRequestsActive = 0;
  let maxMemberRequestsActive = 0;
  const makeForumThread = (id: string, archived = false) => {
    const data = { ...rawThread(guildId, forumId, id, id, archived), type: ChannelType.PublicThread, applied_tags: ['tag-1'] };
    threadData.set(id, data);
    messages.set(id, { ...rawMessage(guildId, forumId, id, ''), embeds: [], components: [] });
    return data;
  };
  client.guilds.cache.set(guild.id, guild as never);
  guild.channels.cache.set(forum.id, forum as never);
  client.channels.cache.set(forum.id, forum as never);
  client.channels.fetch = (async (id: string) => {
    if (id === forum.id) return forum;
    const data = threadData.get(id);
    if (data) {
      const cached = client.channels.cache.get(id);
      if (cached?.isThread()) return cached;
      const thread = Reflect.construct(ThreadChannel as unknown as Function, [guild, data, client]) as ThreadChannel;
      client.channels.cache.set(thread.id, thread as never);
      guild.channels.cache.set(thread.id, thread as never);
      forum.threads.cache.set(thread.id, thread as never);
      return thread;
    }
    return null;
  }) as typeof client.channels.fetch;
  client.rest.get = async (route) => {
    const path = String(route);
    requests.push({ method: 'GET', route: path });
    if (path.includes('/threads/active')) return { threads: [threadData.get(postId) ?? makeForumThread(postId)], members: [] };
    if (path.includes('/threads/archived/public')) {
      archivedPage += 1;
      if (archivedPage === 1) return { threads: [threadData.get(archivedA) ?? makeForumThread(archivedA, true)], members: [], has_more: true };
      return { threads: [threadData.get(archivedB) ?? makeForumThread(archivedB, true)], members: [], has_more: false };
    }
    const messageMatch = path.match(/\/channels\/([^/]+)\/messages\/([^/?]+)/);
    if (messageMatch) {
      const found = messages.get(messageMatch[2]!);
      if (found) return found;
      throw Object.assign(new Error('Unknown Message'), { code: 10008 });
    }
    const channelMatch = path.match(/\/channels\/([^/?]+)(?:\?|$)/);
    const channel = channelMatch ? threadData.get(channelMatch[1]!) : undefined;
    if (channel) return channel;
    throw new Error(`Unexpected forum GET ${path}`);
  };
  client.rest.post = async (route, options) => {
    const path = String(route);
    const body = (options?.body ?? {}) as Record<string, unknown>;
    requests.push({ method: 'POST', route: path, body });
    if (path.includes(`/channels/${forumId}/threads`)) {
      nextPost = postId;
      const data = makeForumThread(nextPost);
      const messageBody = body.message as { content?: string; embeds?: unknown[]; components?: unknown[] };
      messages.set(nextPost, { ...rawMessage(guildId, forumId, nextPost, messageBody.content ?? ''), embeds: messageBody.embeds ?? [], components: messageBody.components ?? [] } as ReturnType<typeof rawMessage>);
      return data;
    }
    if (path.includes(`/channels/${postId}/messages`)) {
      const id = '723456789012345678';
      const message = { ...rawMessage(guildId, postId, id, String(body.content ?? '')), embeds: body.embeds ?? [], components: body.components ?? [] };
      messages.set(id, message as ReturnType<typeof rawMessage>);
      return message;
    }
    throw new Error(`Unexpected forum POST ${path}`);
  };
  client.rest.patch = async (route, options) => {
    const path = String(route);
    const body = (options?.body ?? {}) as Record<string, unknown>;
    requests.push({ method: 'PATCH', route: path, body });
    if (path.endsWith(`/channels/${forumId}`)) {
      return rawForumChannel(guildId, forumId, (body.available_tags as Array<{ id?: string; name: string }>).map((tag, index) => ({ id: tag.id ?? `tag-added-${index}`, name: tag.name })));
    }
    const messageMatch = path.match(/\/channels\/([^/]+)\/messages\/([^/?]+)/);
    if (messageMatch) {
      const old = messages.get(messageMatch[2]!);
      const updated = { ...old, ...Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)), id: messageMatch[2], channel_id: messageMatch[1] };
      messages.set(messageMatch[2]!, updated as ReturnType<typeof rawMessage>);
      return updated;
    }
    const threadMatch = path.match(/\/channels\/([^/?]+)/);
    if (threadMatch && threadData.has(threadMatch[1]!)) {
      const old = threadData.get(threadMatch[1]!)!;
      const updated = {
        ...old,
        name: typeof body.name === 'string' ? body.name : old.name,
        applied_tags: Array.isArray(body.applied_tags) ? body.applied_tags as string[] : old.applied_tags,
        thread_metadata: {
          ...old.thread_metadata,
          archived: typeof body.archived === 'boolean' ? body.archived : old.thread_metadata.archived,
          auto_archive_duration: typeof body.auto_archive_duration === 'number' ? body.auto_archive_duration : old.thread_metadata.auto_archive_duration,
        },
      } as ReturnType<typeof rawThread> & { applied_tags: string[] };
      threadData.set(threadMatch[1]!, updated);
      return updated;
    }
    throw new Error(`Unexpected forum PATCH ${path}`);
  };
  client.rest.put = async (route) => {
    const path = String(route);
    requests.push({ method: 'PUT', route: path });
    if (path.includes('/thread-members/')) {
      memberRequestsActive += 1;
      maxMemberRequestsActive = Math.max(maxMemberRequestsActive, memberRequestsActive);
      await new Promise((resolve) => setTimeout(resolve, 0));
      memberRequestsActive -= 1;
    }
    return {};
  };
  client.rest.delete = async (route) => {
    const path = String(route);
    requests.push({ method: 'DELETE', route: path });
    if (path.includes('/thread-members/')) {
      memberRequestsActive += 1;
      maxMemberRequestsActive = Math.max(maxMemberRequestsActive, memberRequestsActive);
      await new Promise((resolve) => setTimeout(resolve, 0));
      memberRequestsActive -= 1;
    }
    return {};
  };
  try {
    const port = new DiscordJsPort(client);
    assert.equal(await port.isForumChannel(forumId), true);
    assert.deepEqual(await port.fetchForumTags(forumId), [{ id: 'tag-1', name: 'Läuft', moderated: false, emoji: null }]);
    await port.setForumTags(forumId, [{ id: 'tag-1', name: 'Läuft' }, { name: 'Beendet' }]);
    assert.deepEqual((await port.fetchForumTags(forumId)).map((tag) => tag.name), ['Läuft', 'Beendet']);

    const post = await port.createForumPost(forumId, 'Test-Event', {
      content: '⏳ Endet <t:1792508340:R> · <t:1792508340:f>',
      embeds: [{ title: 'Test-Event', url: 'https://de.finalfantasyxiv.com/lodestone/special/2026/test#ffe-stable' }],
      components: [{ components: [{ type: 'button', style: 'link', label: 'Zur Sonderseite', url: 'https://de.finalfantasyxiv.com/lodestone/special/2026/test' }] }],
      allowedMentions: { parse: [], users: [] },
    }, ['tag-1'], 10_080);
    assert.equal(post.id, postId);
    assert.equal(post.starterMessageId, postId);
    const createRequest = requests.find((request) => request.method === 'POST' && request.route.includes(`/channels/${forumId}/threads`));
    assert.deepEqual(createRequest?.body?.applied_tags, ['tag-1']);
    assert.equal(createRequest?.body?.auto_archive_duration, 10_080);
    const createMessage = createRequest?.body?.message as { content?: string; allowed_mentions?: { parse?: string[] } } | undefined;
    assert.equal(createMessage?.content, '⏳ Endet <t:1792508340:R> · <t:1792508340:f>');
    assert.deepEqual(createMessage?.allowed_mentions?.parse, []);

    const recovered = await port.fetchForumPost(forumId, postId);
    assert.equal(recovered?.id, postId);
    const memberA = '823456789012345678';
    const memberB = '923456789012345678';
    await Promise.all([port.addThreadMember(postId, memberA), port.removeThreadMember(postId, memberB)]);
    assert.equal(maxMemberRequestsActive, 1, 'thread member requests are serialized through discord.js REST');
    assert.ok(requests.some((request) => request.method === 'PUT' && request.route.endsWith(`/thread-members/${memberA}`)));
    assert.ok(requests.some((request) => request.method === 'DELETE' && request.route.endsWith(`/thread-members/${memberB}`)));
    const allPosts = await port.listForumPosts(forumId);
    assert.deepEqual(new Set(allPosts.map((item) => item.id)), new Set([postId, archivedA, archivedB]));
    assert.equal(archivedPage, 2);

    await port.setForumPostTags(postId, ['tag-1']);
    await port.setForumPostName(postId, 'Renamed-Event');
    await port.setForumPostArchived(postId, true);
    await port.keepForumPostActive(postId, 10_080);
    await port.refreshForumPostKeepAlive(postId, 10_080);
    await port.editForumStarter(postId, {
      content: '✅ Beendet <t:1792148400:f>',
      embeds: [{ title: 'Aktualisiert' }],
      allowedMentions: { parse: [], users: [] },
    });
    const starterEditRequest = requests.filter((request) => request.method === 'PATCH' && request.route.endsWith(`/channels/${postId}/messages/${postId}`)).at(-1);
    assert.equal(starterEditRequest?.body?.content, '✅ Beendet <t:1792148400:f>');
    assert.deepEqual((starterEditRequest?.body?.allowed_mentions as { parse?: string[] } | undefined)?.parse, []);
    await port.pinForumPost(postId);
    assert.ok(requests.some((request) => request.method === 'PATCH' && request.route.includes(`/channels/${postId}`) && request.body?.flags !== undefined));
    assert.deepEqual(requests.filter((request) => request.method === 'PATCH' && request.route.includes(`/channels/${postId}`)
      && request.body?.auto_archive_duration !== undefined).slice(-2).map((request) => request.body?.auto_archive_duration), [4_320, 10_080]);
  } finally {
    client.destroy();
  }
});

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

test('DiscordJsPort suppresses embeds and wraps URLs in log messages', async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const guild = Reflect.construct(Guild as unknown as Function, [client, rawGuild('123456789012345678')]) as Guild;
  const channel = Reflect.construct(TextChannel as unknown as Function, [guild, rawTextChannel(guild.id, '323456789012345678'), client]) as TextChannel;
  client.channels.fetch = async () => channel;
  let postOptions: unknown;
  client.rest.post = async (_route, options) => {
    postOptions = options;
    return rawMessage(guild.id, channel.id, '423456789012345678', 'warning');
  };
  try {
    await new DiscordJsPort(client).sendLog(channel.id, 'Quelle nicht lesbar: https://de.finalfantasyxiv.com/lodestone/topics/.');
    const body = (postOptions as { body: { content: string; flags: number } }).body;
    assert.equal(body.content, 'Quelle nicht lesbar: <https://de.finalfantasyxiv.com/lodestone/topics/>.');
    assert.equal(body.flags, MessageFlags.SuppressEmbeds);
  } finally {
    client.destroy();
  }
});

test('a text channel is refused as the event channel and produces no event posts or schedules', async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const guildId = '123456789012345678';
  const channelId = '323456789012345678';
  const botId = '523456789012345678';
  const guild = Reflect.construct(Guild as unknown as Function, [client, rawGuild(guildId)]) as Guild;
  const channel = Reflect.construct(TextChannel as unknown as Function, [guild, rawTextChannel(guildId, channelId), client]) as TextChannel;
  const db = openDb(':memory:');
  upsertGuildSetup(db, { guildId, eventChannelId: channelId, logChannelId: channelId });
  const eventId = createEvent(db, { eventKey: 'seasonal-special:/lodestone/special/concurrent/', eventType: 'seasonal-special', title: 'Gleichzeitiges Event' });
  const sourceUrl = 'https://de.finalfantasyxiv.com/lodestone/special/concurrent/';
  attachSource(db, { eventId, url: sourceUrl, kind: 'special' });
  applyField(db, eventId, 'start', { status: 'ok', value: '2026-10-15T08:00:00.000Z' }, sourceUrl);
  applyField(db, eventId, 'end', { status: 'ok', value: '2026-10-20T14:59:00.000Z' }, sourceUrl);

  const messages = new Map<string, ReturnType<typeof rawMessage>>();
  const schedules = new Map<string, Record<string, unknown>>();
  let nextMessageId = 623456789012345678n;
  let nextScheduleId = 723456789012345678n;
  client.user = { id: botId } as never;
  client.channels.cache.set(channelId, channel as never);
  client.channels.fetch = async () => channel;
  client.guilds.fetch = (async () => guild) as unknown as typeof client.guilds.fetch;
  client.rest.get = async (route) => {
    const path = String(route);
    if (path.includes('/scheduled-events')) {
      const snapshot = [...schedules.values()];
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return snapshot;
    }
    if (path.includes('/messages/pins')) {
      const snapshot = [...messages.values()].filter((message) => message.pinned);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return snapshot;
    }
    const messageMatch = path.match(/\/messages\/([^/]+)$/);
    if (messageMatch) {
      const found = messages.get(messageMatch[1]!);
      if (found) return found;
      throw Object.assign(new Error('Unknown Message'), { code: 10008 });
    }
    if (path.includes('/messages')) {
      const snapshot = [...messages.values()].reverse();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return snapshot;
    }
    return [];
  };
  client.rest.post = async (route, request) => {
    const path = String(route);
    const body = (request as { body?: Record<string, unknown> } | undefined)?.body ?? {};
    if (path.includes('/scheduled-events')) {
      const id = String(nextScheduleId++);
      const created = {
        id, guild_id: guildId, name: body.name, description: body.description,
        scheduled_start_time: body.scheduled_start_time, scheduled_end_time: body.scheduled_end_time,
        privacy_level: body.privacy_level, entity_type: body.entity_type,
        entity_metadata: body.entity_metadata, status: 1, creator_id: botId, user_count: 0, image: null,
      };
      schedules.set(id, created);
      return created;
    }
    const id = String(nextMessageId++);
    const created = {
      ...rawMessage(guildId, channelId, id, String(body.content ?? '')),
      embeds: Array.isArray(body.embeds) ? body.embeds : [],
      components: Array.isArray(body.components) ? body.components : [],
    };
    messages.set(id, created as ReturnType<typeof rawMessage>);
    return created;
  };
  client.rest.put = async (route) => {
    const messageId = String(route).split('/').at(-1)!;
    const message = messages.get(messageId);
    if (message) message.pinned = true;
    return {};
  };
  const discord = new DiscordJsPort(client);
  const options = {
    store: db,
    discord,
    fetchText: async () => { throw new Error('stored-data sync must not fetch Lodestone'); },
    now: () => new Date('2026-10-16T12:00:00.000Z'),
  };
  try {
    await Promise.all([
      runGuildSyncFromStoredData(options, guildId),
      runGuildSyncFromStoredData(options, guildId),
    ]);

    const posted = [...messages.values()];
    assert.ok(posted.every((message) => !message.embeds.some((embed: { title?: string }) => embed.title === 'Gleichzeitiges Event' || embed.title === 'Läuft gerade')));
    assert.equal(schedules.size, 0);
  } finally {
    db.close();
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
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.SendMessagesInThreads,
  ]);
  const guildId = '123456789012345678';
  const loggedMessages: string[] = [];
  const setupLogMessages: Array<{ content?: string; flags?: MessageFlags }> = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { loggedMessages.push(values.map(String).join(' ')); };
  const eventChannel = { id: '323456789012345678', guildId, type: ChannelType.GuildForum, permissionsFor: () => channelPermissions };
  const logChannel = {
    id: '423456789012345678', guildId, type: ChannelType.GuildText, permissionsFor: () => channelPermissions,
    send: async (payload: { content?: string; flags?: MessageFlags }) => { order.push('send-log'); setupLogMessages.push(payload); },
  };
  const interaction = {
    guildId,
    guild: { name: 'Testserver', members: { fetchMe: async () => { order.push('fetch'); return { permissions: new PermissionsBitField([PermissionFlagsBits.CreateEvents]) }; } } },
    memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]),
    inGuild: () => true,
    options: { getSubcommand: () => 'setup', getChannel: (name: string) => name === 'event-kanal' ? eventChannel : logChannel },
    deferReply: async (options: { flags: MessageFlags }) => { order.push('defer'); assert.equal(options.flags, MessageFlags.Ephemeral); },
    editReply: async (options: { content: string }) => { order.push('edit'); assert.match(options.content, /Einrichtung gespeichert/); },
  };
  try {
    const setupDiscord = {
      fetchForumTags: async () => [],
      setForumTags: async (_channelId: string, tags: readonly { name: string }[]) => tags.map((tag, index) => ({ ...tag, id: `tag-${index}` })),
    };
    await handleFfEventsSetup(interaction as never, db, async (selectedGuildId) => { order.push(`sync:${selectedGuildId}`); }, setupDiscord as never);
    assert.deepEqual(order, ['defer', 'fetch', `sync:${guildId}`, 'send-log', 'edit']);
    assert.match(setupLogMessages[0]?.content ?? '', new RegExp(`Event-Forum: <#${eventChannel.id}> · Log-Kanal: <#${logChannel.id}>\\.`));
    assert.match(setupLogMessages[0]?.content ?? '', /Kanäle verwalten/);
    assert.equal(setupLogMessages[0]?.flags, MessageFlags.SuppressEmbeds);
    assert.doesNotMatch(setupLogMessages[0]?.content ?? '', /\r|\n/);
    assert.deepEqual(loggedMessages.map((line) => String(line).replace(/^\S+ /, '')), ['Testserver: Server eingerichtet']);
  } finally {
    console.log = originalLog;
    db.close();
  }
});

test('setup reports a bot-member fetch failure after acknowledging the interaction', async () => {
  const db = openDb(':memory:');
  const order: string[] = [];
  const channelPermissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads,
  ]);
  const guildId = '123456789012345678';
  const eventChannel = { id: '323456789012345678', guildId, type: ChannelType.GuildForum, permissionsFor: () => channelPermissions };
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
    assert.match(String(loggedErrors[0]?.[0]), /raw Discord failure/);
  } finally {
    console.error = originalError;
    db.close();
  }
});

test('setup rejects a text channel selected for events', async () => {
  const db = openDb(':memory:');
  let reply = '';
  const interaction = {
    guildId: '123456789012345678',
    guild: { name: 'Testserver' },
    memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]),
    inGuild: () => true,
    options: {
      getSubcommand: () => 'setup',
      getChannel: (name: string) => ({
        id: name === 'event-kanal' ? '323456789012345678' : '423456789012345678',
        guildId: '123456789012345678',
        type: ChannelType.GuildText,
      }),
    },
    reply: async (payload: { content: string }) => { reply = payload.content; },
  };
  try {
    await handleFfEventsSetup(interaction as never, db, async () => assert.fail('invalid text event channel must not sync'));
    assert.match(reply, /Forumkanal für Events/);
    assert.equal(getGuild(db, '123456789012345678'), undefined);
  } finally {
    db.close();
  }
});

test('setup reply lists missing forum thread permissions in German', async () => {
  const db = openDb(':memory:');
  const basePermissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
  const eventChannel = { id: '323456789012345678', guildId: '123456789012345678', type: ChannelType.GuildForum, permissionsFor: () => basePermissions };
  const logChannel = { id: '423456789012345678', guildId: '123456789012345678', type: ChannelType.GuildText, permissionsFor: () => basePermissions };
  let reply = '';
  const interaction = {
    guildId: '123456789012345678',
    guild: { name: 'Testserver', members: { fetchMe: async () => ({ permissions: new PermissionsBitField([PermissionFlagsBits.CreateEvents]) }) } },
    memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]),
    inGuild: () => true,
    options: { getSubcommand: () => 'setup', getChannel: (name: string) => name === 'event-kanal' ? eventChannel : logChannel },
    deferReply: async () => {},
    editReply: async (payload: { content: string }) => { reply = payload.content; },
  };
  try {
    await handleFfEventsSetup(interaction as never, db, async () => assert.fail('sync must not run with missing thread permissions'));
    assert.match(reply, /Mir fehlen noch diese Berechtigungen:/);
    assert.match(reply, /Event-Kanal: Threads verwalten/);
    assert.match(reply, /Event-Kanal: Nachrichten in Threads senden/);
  } finally {
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

test('redactToken removes the Discord token from error text', () => {
  assert.equal(redactToken('login failed with abc.def.ghi!', 'abc.def.ghi'), 'login failed with [Token entfernt]!');
  assert.equal(redactToken('plain', ''), 'plain');
});

test('DiscordJsPort treats a deleted forum post (10003) as confirmed absence but propagates other errors', async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const guild = Reflect.construct(Guild as unknown as Function, [client, rawGuild('123456789012345678')]) as Guild;
  const forum = Reflect.construct(ForumChannel as unknown as Function, [guild, rawForumChannel(guild.id, '323456789012345678', []), client]) as ForumChannel;
  const originalFetch = client.channels.fetch.bind(client.channels);
  client.channels.fetch = (async (id: string, options?: never) => id === forum.id ? forum : originalFetch(id, options)) as typeof client.channels.fetch;
  let failure: unknown;
  client.rest.get = async () => { throw failure; };
  const apiError = (status: number, code: number) => new DiscordAPIError({ code, message: 'x' }, code, status, 'GET', '/channels/1', {});
  try {
    const port = new DiscordJsPort(client);
    failure = apiError(404, 10003);
    assert.equal(await port.fetchForumPost(forum.id, '423456789012345678'), null);
    for (const error of [apiError(403, 50001), apiError(500, 0), new Error('network down')]) {
      failure = error;
      await assert.rejects(port.fetchForumPost(forum.id, '423456789012345678'), error);
    }
  } finally {
    client.destroy();
  }
});
