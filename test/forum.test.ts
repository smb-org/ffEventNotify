import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load } from 'cheerio';
import {
  applyField,
  attachSource,
  createEvent,
  getAllEvents,
  getGuildEventObject,
  openDb,
  saveChecklistSelection,
  setGuildEventLastKeepaliveAt,
  setChecklistReminderPreference,
  upsertGuildSetup,
  type StoreEvent,
} from '../src/store.ts';
import { FORUM_TAG_NAMES, ensureForumTags, forumTagIdsForEvent, syncForumEvent, syncForumStatus } from '../src/sync/forum.ts';
import { syncEventReminders } from '../src/sync/reminders.ts';
import { syncScheduledEvent } from '../src/sync/scheduled.ts';
import { runGuildSyncFromStoredData } from '../src/cycle.ts';
import type {
  DiscordEmbed,
  DiscordForumPostSnapshot,
  DiscordForumTag,
  DiscordForumTagData,
  DiscordMessageHistory,
  DiscordMessagePayload,
  DiscordMessageSnapshot,
  DiscordPort,
  DiscordThreadSnapshot,
  ScheduledEventPayload,
  ScheduledEventSnapshot,
} from '../src/types.ts';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const reports = [
  new URL('./fixtures/live-2026-10-16/dry-run-report.txt', import.meta.url),
  new URL('./fixtures/live-2026-10-16/dry-run-report-2.txt', import.meta.url),
];
const mogExpected = JSON.parse(readFileSync(new URL('./fixtures/expected/mogmog-202609.json', import.meta.url), 'utf8')) as {
  rewards: Array<{ itemId: string; name: string; section: string; cost?: string }>;
};

function copyEmbeds(embeds: readonly DiscordEmbed[] | undefined): DiscordEmbed[] {
  return (embeds ?? []).map((embed) => structuredClone(embed));
}

function makeMessage(id: string, channelId: string, payload: DiscordMessagePayload, pinned = false): DiscordMessageSnapshot {
  return {
    id,
    channelId,
    authorIsBot: true,
    pinned,
    content: payload.content ?? '',
    embeds: copyEmbeds(payload.embeds),
    ...(payload.components === undefined ? {} : { components: structuredClone(payload.components) }),
    createdAt: new Date().toISOString(),
  };
}

class ForumDiscord implements DiscordPort {
  readonly posts = new Map<string, DiscordForumPostSnapshot>();
  readonly replies = new Map<string, DiscordMessageSnapshot[]>();
  readonly scheduled: ScheduledEventSnapshot[] = [];
  readonly operations: string[] = [];
  readonly logs: Array<{ channelId: string; content: string }> = [];
  readonly sentToThreads: Array<{ threadId: string; payload: DiscordMessagePayload }> = [];
  tags: DiscordForumTag[] = FORUM_TAG_NAMES.map((name, index) => ({ id: `tag-${index + 1}`, name }));
  postCreates = 0;
  threadStarts = 0;
  failUnarchive = false;
  private sequence = 0;

  async createMessage(channelId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> { return makeMessage(`message-${++this.sequence}`, channelId, payload); }
  async editMessage(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    const reply = this.replies.get(channelId)?.find((message) => message.id === messageId);
    assert.ok(reply);
    const updated = makeMessage(messageId, channelId, payload, reply.pinned);
    const list = this.replies.get(channelId)!;
    list[list.indexOf(reply)] = updated;
    this.operations.push('edit-continuation');
    return updated;
  }
  async fetchRecentBotMessages(channelId: string, _limit: number): Promise<DiscordMessageHistory> {
    return { messages: [...(this.replies.get(channelId) ?? [])], complete: true };
  }
  async fetchPinnedBotMessages(channelId: string): Promise<DiscordMessageSnapshot[]> {
    return [...this.posts.values()].filter((post) => post.parentChannelId === channelId && post.pinned).map((post) => post.starterMessage);
  }
  async fetchMessage(channelId: string, messageId: string): Promise<DiscordMessageSnapshot | null> {
    const post = this.posts.get(messageId);
    if (post && (post.parentChannelId === channelId || post.id === channelId)) return post.starterMessage;
    return (this.replies.get(channelId) ?? []).find((message) => message.id === messageId) ?? null;
  }
  async isTextChannel(_channelId: string): Promise<boolean> { return true; }
  async isForumChannel(_channelId: string): Promise<boolean> { return true; }
  async fetchForumTags(_channelId: string): Promise<DiscordForumTag[]> { return structuredClone(this.tags); }
  async setForumTags(_channelId: string, tags: readonly DiscordForumTagData[]): Promise<DiscordForumTag[]> {
    this.tags = tags.map((tag, index) => ({ id: tag.id ?? `tag-added-${index}`, name: tag.name, moderated: tag.moderated ?? false, emoji: tag.emoji ?? null }));
    this.operations.push('set-available-tags');
    return structuredClone(this.tags);
  }
  async createForumPost(channelId: string, name: string, payload: DiscordMessagePayload, appliedTags: readonly string[], autoArchiveDuration: number): Promise<DiscordForumPostSnapshot> {
    const id = `post-${++this.sequence}`;
    const starterMessage = makeMessage(id, id, payload);
    starterMessage.createdAt = NOW.toISOString();
    const post: DiscordForumPostSnapshot = {
      id, parentChannelId: channelId, starterMessageId: id, name, archived: false,
      appliedTags: [...appliedTags], starterMessage, autoArchiveDuration,
      archiveTimestamp: NOW.toISOString(), lastMessageAt: NOW.toISOString(), locked: false, pinned: false,
    };
    this.posts.set(id, post);
    this.replies.set(id, []);
    this.postCreates += 1;
    this.operations.push('create-post');
    return post;
  }
  async fetchForumPost(channelId: string, threadId: string): Promise<DiscordForumPostSnapshot | null> {
    const post = this.posts.get(threadId);
    return post?.parentChannelId === channelId ? post : null;
  }
  async listForumPosts(channelId: string): Promise<DiscordForumPostSnapshot[]> {
    return [...this.posts.values()].filter((post) => post.parentChannelId === channelId);
  }
  async editForumStarter(threadId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    const post = this.posts.get(threadId)!;
    post.starterMessage = makeMessage(threadId, threadId, payload, post.starterMessage.pinned);
    this.operations.push('edit-starter');
    return post.starterMessage;
  }
  async setForumPostTags(threadId: string, appliedTags: readonly string[]): Promise<void> {
    this.posts.get(threadId)!.appliedTags = [...appliedTags];
    this.operations.push('set-tags');
  }
  async setForumPostName(threadId: string, name: string): Promise<void> { this.posts.get(threadId)!.name = name; this.operations.push('set-name'); }
  async setForumPostArchived(threadId: string, archived: boolean): Promise<void> {
    if (!archived && this.failUnarchive) throw new Error('simulated unarchive failure');
    this.posts.get(threadId)!.archived = archived;
    this.operations.push(archived ? 'archive' : 'unarchive');
  }
  async setForumPostAutoArchiveDuration(threadId: string, autoArchiveDuration: number): Promise<void> {
    this.posts.get(threadId)!.autoArchiveDuration = autoArchiveDuration;
    this.operations.push(`duration-${autoArchiveDuration}`);
  }
  async refreshForumPostKeepAlive(threadId: string, autoArchiveDuration: number): Promise<void> {
    this.posts.get(threadId)!.autoArchiveDuration = 4_320;
    this.operations.push('duration-4320');
    this.posts.get(threadId)!.autoArchiveDuration = autoArchiveDuration;
    this.operations.push(`duration-${autoArchiveDuration}`);
  }
  async keepForumPostActive(threadId: string, autoArchiveDuration: number): Promise<void> {
    const post = this.posts.get(threadId)!;
    post.archived = false;
    post.autoArchiveDuration = autoArchiveDuration;
    this.operations.push('keep-active');
  }
  async pinForumPost(threadId: string): Promise<void> { this.posts.get(threadId)!.pinned = true; this.operations.push('pin-forum-post'); }
  async sendToThread(threadId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    const reply = makeMessage(`reply-${++this.sequence}`, threadId, payload);
    this.replies.get(threadId)!.push(reply);
    this.sentToThreads.push({ threadId, payload });
    this.operations.push('send-to-thread');
    return reply;
  }
  async deleteThreadMessage(threadId: string, messageId: string): Promise<void> {
    this.replies.set(threadId, (this.replies.get(threadId) ?? []).filter((message) => message.id !== messageId));
  }
  async startThreadOnMessage(_channelId: string, _starterMessageId: string, _name: string, _duration: number): Promise<DiscordThreadSnapshot> {
    this.threadStarts += 1;
    throw new Error('forum reminders must not create a second thread');
  }
  async fetchThread(_channelId: string, _threadId: string | null, _starterMessageId: string | null): Promise<DiscordThreadSnapshot | null> { return null; }
  async createScheduledEvent(guildId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> {
    const event = { ...payload, id: `scheduled-${this.scheduled.length + 1}`, guildId, status: 'SCHEDULED' as const };
    this.scheduled.push(event);
    return event;
  }
  async editScheduledEvent(guildId: string, eventId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> {
    const event = { ...payload, id: eventId, guildId, status: 'SCHEDULED' as const };
    return event;
  }
  async listScheduledEvents(_guildId: string): Promise<ScheduledEventSnapshot[]> { return [...this.scheduled]; }
  async pinMessage(_channelId: string, _messageId: string): Promise<void> {}
  async sendLog(channelId: string, content: string): Promise<void> { this.logs.push({ channelId, content }); }
}

function storeEvent(
  db: ReturnType<typeof openDb>,
  input: { eventKey: string; eventType: StoreEvent['eventType']; title: string; sourceUrl: string; startUtc: string; endUtc: string; rewards?: StoreEvent['rewards'] },
): StoreEvent {
  const eventId = createEvent(db, { eventKey: input.eventKey, eventType: input.eventType, title: input.title });
  attachSource(db, { eventId, url: input.sourceUrl, kind: input.eventType === 'seasonal-special' ? 'special' : input.eventType === 'maintenance' ? 'maintenance' : 'topic' });
  applyField(db, eventId, 'start', { status: 'ok', value: input.startUtc }, input.sourceUrl);
  applyField(db, eventId, 'end', { status: 'ok', value: input.endUtc }, input.sourceUrl);
  if (input.rewards) applyField(db, eventId, 'rewards', { status: 'ok', value: input.rewards }, input.sourceUrl);
  return getAllEvents(db).find((event) => event.id === eventId)!;
}

function setupGuild(db: ReturnType<typeof openDb>, forumId = 'forum-1'): void {
  upsertGuildSetup(db, { guildId: 'guild-1', eventChannelId: forumId, logChannelId: 'logs-1' });
}

test('forum type tags map fixture and live titles only when the rule is certain', () => {
  const liveTitles = new Set<string>();
  for (const report of reports) {
    const text = readFileSync(report, 'utf8');
    for (const match of text.matchAll(/^## (.+)$/gm)) liveTitles.add(match[1]!.trim());
    for (const match of text.matchAll(/^- (.+?) — beim Erststart/gm)) liveTitles.add(match[1]!.trim());
  }
  assert.ok(liveTitles.has('Kollabo-Event: FINAL FANTASY XIV x Fall Guys'));
  const liveMapped = new Map([...liveTitles].map((title) => [title, forumTagIdsForEvent(
    { eventType: 'topic-generic', title, titleStatus: 'ok' } as StoreEvent,
    [], NOW,
    FORUM_TAG_NAMES.map((name, index) => ({ id: name, name })),
  ).slice(1).map((id) => id)]));
  assert.deepEqual(liveMapped.get('Kollabo-Event: FINAL FANTASY XIV x Fall Guys'), ['Kollabo']);
  assert.deepEqual(liveMapped.get('Veröffentlichung der Details zu Patch 7.57!'), ['Patch']);
  assert.deepEqual(liveMapped.get('Ankündigung der neuen „Support-A-Streamer“-Twitch-Kampagne'), ['Kampagne']);
  assert.deepEqual(liveMapped.get('Ankündigung des Bühnen- und Streamprogramms für das Fan Festival 2026 in Berlin'), ['Fan Festival']);
  assert.deepEqual(liveMapped.get('Der Brief des Produzenten LIVE Teil 93 wird am Samstag, den 25. Juli vom Fan Festival in Berlin übertragen!'), ['Live-Letter', 'Fan Festival']);
  assert.deepEqual(liveMapped.get('Allerschutzheiligen 2026 - Schaurig, kostümiert und ... bärenstark?!'), []);

  const mog = load(readFileSync(new URL('./fixtures/special/mogmog-202609.html', import.meta.url), 'utf8'))('title').text();
  const seasonal = load(readFileSync(new URL('./fixtures/special/all-saints-wake-2026.html', import.meta.url), 'utf8'))('title').text();
  const fallGuys = load(readFileSync(new URL('./fixtures/special/fallguys.html', import.meta.url), 'utf8'))('title').text();
  const fixtureTag = (title: string, eventType: StoreEvent['eventType'], url: string) => forumTagIdsForEvent(
    { eventType, title, titleStatus: 'ok' } as StoreEvent, [url], NOW, FORUM_TAG_NAMES.map((name) => ({ id: name, name })),
  ).slice(1);
  assert.deepEqual(fixtureTag(mog, 'seasonal-special', 'https://de.finalfantasyxiv.com/lodestone/special/mogmog-collection/202609/example'), ['Mog Mog-Kollektion']);
  assert.deepEqual(fixtureTag(seasonal, 'seasonal-special', 'https://de.finalfantasyxiv.com/lodestone/special/2026/All_Saints_Wake/example'), ['Saison-Event']);
  assert.deepEqual(fixtureTag(fallGuys, 'seasonal-special', 'https://de.finalfantasyxiv.com/lodestone/special/fallguys/'), ['Kollabo']);
  assert.deepEqual(fixtureTag('Kollaborationsevent FINAL FANTASY XIV & FINAL FANTASY XV', 'topic-generic', 'https://de.finalfantasyxiv.com/lodestone/topics/detail/ffxv'), ['Kollabo']);
  assert.deepEqual(fixtureTag('[Wartung]Wartung aller Welten (12-13. Okt.)', 'maintenance', 'https://de.finalfantasyxiv.com/lodestone/news/detail/a'), ['Wartung']);
  assert.deepEqual(fixtureTag('[Wartung]Notwartung aller Welten (17. Sep.)', 'maintenance', 'https://de.finalfantasyxiv.com/lodestone/news/detail/b'), ['Notwartung']);
  assert.deepEqual(fixtureTag('[Wartung][Crystal] Notwartung der Welt Diabolos (11. Sep.)', 'maintenance', 'https://de.finalfantasyxiv.com/lodestone/news/detail/c'), ['Welt-Wartung']);
  assert.deepEqual(fixtureTag('[Folge-News]Wartung aller Welten (12-13. Okt.)', 'maintenance', 'https://de.finalfantasyxiv.com/lodestone/news/detail/d'), []);
  assert.deepEqual(forumTagIdsForEvent(
    { eventType: 'topic-generic', title: 'Kampagne', titleStatus: 'unsicher' } as StoreEvent,
    [], NOW, FORUM_TAG_NAMES.map((name) => ({ id: name, name })),
  ).map((id) => FORUM_TAG_NAMES.find((name) => name === id)), ['Läuft']);
});

test('forum tag setup preserves existing tags, fills available slots only with Manage Channels, and never exceeds 20', async () => {
  const discord = new ForumDiscord();
  discord.tags = Array.from({ length: 19 }, (_, index) => ({ id: `existing-${index}`, name: `Existing ${index}` }));
  const result = await ensureForumTags(discord, 'forum-1', true);
  assert.equal(result.tags.length, 20);
  assert.equal(result.createdNames.length, 1);
  assert.equal(result.createdNames[0], 'Saison-Event');
  assert.ok(result.tags.some((tag) => tag.name === 'Existing 0'));
  assert.equal(discord.operations.filter((operation) => operation === 'set-available-tags').length, 1);

  const withoutPermission = new ForumDiscord();
  withoutPermission.tags = [{ id: 'existing-status', name: 'Läuft' }];
  const skipped = await ensureForumTags(withoutPermission, 'forum-1', false);
  assert.deepEqual(skipped.createdNames, []);
  assert.equal(skipped.tags.length, 1);
  assert.equal(withoutPermission.operations.length, 0);
  assert.ok(skipped.missingNames.includes('Beendet'));
});

test('30 Mog Mog rewards with verified costs fill the starter and continuation posts without an eight-item cap', async () => {
  const db = openDb(':memory:');
  const discord = new ForumDiscord();
  setupGuild(db);
  const url = 'https://de.finalfantasyxiv.com/lodestone/special/mogmog-collection/202609/lsekubsk45';
  const event = storeEvent(db, {
    eventKey: 'seasonal-special:/lodestone/special/mogmog-collection/202609/lsekubsk45',
    eventType: 'seasonal-special',
    title: 'Mog Mog-Kollektion Astronomische Abenteuer - Teil 1',
    sourceUrl: url,
    startUtc: '2026-09-09T08:00:00.000Z',
    endUtc: '2026-10-19T14:59:00.000Z',
    rewards: mogExpected.rewards,
  });
  try {
    const postId = await syncForumEvent({ guildId: 'guild-1', channelId: 'forum-1', event, sourceUrls: [url], discord, store: db, now: NOW });
    const post = discord.posts.get(postId)!;
    assert.ok(post.name.length <= 100);
    assert.ok(getGuildEventObject(db, 'guild-1', event.eventKey)!.continuationMessageIds.length > 0);
    const rendered = [
      ...post.starterMessage.embeds.flatMap((embed) => [embed.title ?? '', embed.description ?? '', ...(embed.fields ?? []).flatMap((field) => [field.name, field.value])]),
      ...(discord.replies.get(postId) ?? []).flatMap((message) => message.embeds.flatMap((embed) => [embed.title ?? '', embed.description ?? ''])),
    ].join('\n');
    for (const reward of mogExpected.rewards) assert.ok(rendered.includes(`[${reward.name}](https://de.finalfantasyxiv.com/lodestone/playguide/db/item/${reward.itemId}/)`), reward.name);
    for (const reward of mogExpected.rewards.filter((item) => item.cost)) assert.ok(rendered.includes(`— ${reward.cost}`), `${reward.name} cost`);
    assert.equal(mogExpected.rewards.filter((reward) => reward.cost).length, 29);
    assert.ok((discord.replies.get(postId) ?? []).some((message) => message.embeds[0]?.title === 'Belohnungen (Fortsetzung)'));
  } finally {
    db.close();
  }
});

test('restart recovers active and archived event posts from their marker without duplicates', async () => {
  for (const archived of [false, true]) {
    const discord = new ForumDiscord();
    let db = openDb(':memory:');
    setupGuild(db);
    const eventInput = {
      eventKey: `seasonal-special:/lodestone/special/2026/restart-${archived}`,
      eventType: 'seasonal-special' as const,
      title: 'Neustart-Event',
      sourceUrl: `https://de.finalfantasyxiv.com/lodestone/special/2026/restart-${archived}`,
      startUtc: '2026-10-15T08:00:00.000Z',
      endUtc: '2026-10-20T14:59:00.000Z',
    };
    const first = storeEvent(db, eventInput);
    const postId = await syncForumEvent({ guildId: 'guild-1', channelId: 'forum-1', event: first, sourceUrls: [eventInput.sourceUrl], discord, store: db, now: NOW });
    assert.equal(discord.posts.get(postId)?.autoArchiveDuration, 10_080);
    discord.posts.get(postId)!.archived = archived;
    db.close();

    db = openDb(':memory:');
    setupGuild(db);
    const afterRestart = storeEvent(db, eventInput);
    await syncForumEvent({ guildId: 'guild-1', channelId: 'forum-1', event: afterRestart, sourceUrls: [eventInput.sourceUrl], discord, store: db, now: NOW });
    assert.equal(discord.postCreates, 1);
    assert.equal(discord.posts.size, 1);
    assert.equal(getGuildEventObject(db, 'guild-1', eventInput.eventKey)?.messageId, postId);
    assert.equal(discord.posts.get(postId)?.archived, false);
    db.close();
  }
});

test('the next stored-data cycle unarchives a running event post', async () => {
  const db = openDb(':memory:');
  const discord = new ForumDiscord();
  setupGuild(db);
  const url = 'https://de.finalfantasyxiv.com/lodestone/special/2026/cycle-unarchive';
  const event = storeEvent(db, {
    eventKey: 'seasonal-special:/lodestone/special/2026/cycle-unarchive', eventType: 'seasonal-special',
    title: 'Zyklus-Event', sourceUrl: url,
    startUtc: '2026-10-15T08:00:00.000Z', endUtc: '2026-10-20T14:59:00.000Z',
  });
  try {
    const postId = await syncForumEvent({ guildId: 'guild-1', channelId: 'forum-1', event, sourceUrls: [url], discord, store: db, now: NOW });
    discord.posts.get(postId)!.archived = true;
    discord.operations.length = 0;
    await runGuildSyncFromStoredData({
      store: db,
      discord,
      fetchText: async (requestedUrl) => ({ status: 200, body: '', finalUrl: requestedUrl }),
      now: () => new Date(NOW),
    }, 'guild-1');
    assert.equal(discord.posts.get(postId)?.archived, false);
    assert.ok(discord.operations.includes('unarchive'));
  } finally {
    db.close();
  }
});

test('an active post older than six days gets one silent duration toggle per keep-alive window', async () => {
  const db = openDb(':memory:');
  const discord = new ForumDiscord();
  setupGuild(db);
  const url = 'https://de.finalfantasyxiv.com/lodestone/special/2026/keepalive';
  const event = storeEvent(db, {
    eventKey: 'seasonal-special:/lodestone/special/2026/keepalive', eventType: 'seasonal-special',
    title: 'Keep-alive-Event', sourceUrl: url,
    startUtc: '2026-10-15T08:00:00.000Z', endUtc: '2026-10-20T14:59:00.000Z',
  });
  try {
    const postId = await syncForumEvent({ guildId: 'guild-1', channelId: 'forum-1', event, sourceUrls: [url], discord, store: db, now: NOW });
    const post = discord.posts.get(postId)!;
    const old = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    post.archiveTimestamp = old;
    post.lastMessageAt = old;
    setGuildEventLastKeepaliveAt(db, 'guild-1', event.eventKey, old);
    discord.operations.length = 0;

    await syncForumEvent({ guildId: 'guild-1', channelId: 'forum-1', event, sourceUrls: [url], discord, store: db, now: NOW });
    assert.deepEqual(discord.operations.filter((operation) => operation.startsWith('duration-')), ['duration-4320', 'duration-10080']);
    assert.equal(getGuildEventObject(db, 'guild-1', event.eventKey)?.lastKeepaliveAt, NOW.toISOString());
    assert.equal(discord.sentToThreads.length, 0);

    discord.operations.length = 0;
    const nextHour = new Date(NOW.getTime() + 60 * 60 * 1_000);
    await syncForumEvent({ guildId: 'guild-1', channelId: 'forum-1', event, sourceUrls: [url], discord, store: db, now: nextHour });
    assert.deepEqual(discord.operations.filter((operation) => operation.startsWith('duration-')), []);
  } finally {
    db.close();
  }
});

test('an event ending updates its Beendet tag and card before archiving without locking the post', async () => {
  const db = openDb(':memory:');
  const discord = new ForumDiscord();
  setupGuild(db);
  const url = 'https://de.finalfantasyxiv.com/lodestone/news/detail/maintenance';
  const event = storeEvent(db, {
    eventKey: 'maintenance:all-worlds:maintenance', eventType: 'maintenance',
    title: '[Wartung]Wartung aller Welten (16. Okt.)', sourceUrl: url,
    startUtc: '2026-10-16T08:00:00.000Z', endUtc: '2026-10-16T14:00:00.000Z',
  });
  try {
    const postId = await syncForumEvent({ guildId: 'guild-1', channelId: 'forum-1', event, sourceUrls: [url], discord, store: db, now: NOW });
    applyField(db, event.id, 'end', { status: 'ok', value: '2026-10-16T11:00:00.000Z' }, url);
    const ended = getAllEvents(db).find((candidate) => candidate.id === event.id)!;
    discord.operations.length = 0;
    await syncForumEvent({ guildId: 'guild-1', channelId: 'forum-1', event: ended, sourceUrls: [url], discord, store: db, now: NOW });
    assert.deepEqual(discord.posts.get(postId)?.appliedTags, ['tag-13', 'tag-4']);
    assert.equal(discord.posts.get(postId)?.archived, true);
    assert.equal(discord.posts.get(postId)?.locked, false);
    assert.ok(discord.operations.indexOf('set-tags') < discord.operations.indexOf('edit-starter'));
    assert.ok(discord.operations.indexOf('edit-starter') < discord.operations.indexOf('archive'));
    discord.operations.length = 0;
    await syncForumEvent({ guildId: 'guild-1', channelId: 'forum-1', event: ended, sourceUrls: [url], discord, store: db, now: NOW });
    assert.equal(discord.posts.get(postId)?.archived, true);
    assert.equal(discord.operations.includes('unarchive'), false);
  } finally {
    db.close();
  }
});

test('the pinned Läuft gerade forum post is restored when archived and carries the Läuft tag', async () => {
  const db = openDb(':memory:');
  const discord = new ForumDiscord();
  setupGuild(db);
  const event = storeEvent(db, {
    eventKey: 'seasonal-special:/lodestone/special/2026/status', eventType: 'seasonal-special',
    title: 'Status-Event', sourceUrl: 'https://de.finalfantasyxiv.com/lodestone/special/2026/status',
    startUtc: '2026-10-15T08:00:00.000Z', endUtc: '2026-10-20T14:59:00.000Z',
  });
  try {
    await syncForumEvent({ guildId: 'guild-1', channelId: 'forum-1', event, sourceUrls: ['https://de.finalfantasyxiv.com/lodestone/special/2026/status'], discord, store: db, now: NOW });
    await syncForumStatus({ guildId: 'guild-1', channelId: 'forum-1', events: [event], discord, store: db, now: NOW });
    const status = [...discord.posts.values()].find((post) => post.name === 'Läuft gerade');
    assert.ok(status);
    assert.equal(status.pinned, true);
    assert.equal(status.archived, false);
    assert.equal(status.autoArchiveDuration, 10_080);
    assert.deepEqual(status.appliedTags, ['tag-12']);
    assert.match(status.starterMessage.embeds[0]?.description ?? '', /discord\.com\/channels\/guild-1\/post-/);

    status.archived = true;
    discord.operations.length = 0;
    await syncForumStatus({ guildId: 'guild-1', channelId: 'forum-1', events: [event], discord, store: db, now: NOW });
    assert.equal(status.archived, false);
    assert.ok(discord.operations.includes('unarchive'));
  } finally {
    db.close();
  }
});

test('failed status-post unarchive is logged once in German to the guild log channel', async () => {
  const db = openDb(':memory:');
  const discord = new ForumDiscord();
  setupGuild(db);
  try {
    await syncForumStatus({ guildId: 'guild-1', channelId: 'forum-1', logChannelId: 'logs-1', events: [], discord, store: db, now: NOW });
    const status = [...discord.posts.values()].find((post) => post.name === 'Läuft gerade')!;
    status.archived = true;
    discord.failUnarchive = true;
    await syncForumStatus({ guildId: 'guild-1', channelId: 'forum-1', logChannelId: 'logs-1', events: [], discord, store: db, now: NOW });
    await syncForumStatus({ guildId: 'guild-1', channelId: 'forum-1', logChannelId: 'logs-1', events: [], discord, store: db, now: NOW });
    assert.deepEqual(discord.logs.map(({ channelId }) => channelId), ['logs-1']);
    assert.match(discord.logs[0]?.content ?? '', /konnte nicht entarchiviert werden/);
  } finally {
    db.close();
  }
});

test('reminders go into the event forum post and scheduled event location is the post jump link', async () => {
  const db = openDb(':memory:');
  const discord = new ForumDiscord();
  setupGuild(db);
  const url = 'https://de.finalfantasyxiv.com/lodestone/special/2026/reminder';
  const event = storeEvent(db, {
    eventKey: 'seasonal-special:/lodestone/special/2026/reminder', eventType: 'seasonal-special',
    title: 'Erinnerungs-Event', sourceUrl: url, startUtc: '2026-10-15T08:00:00.000Z',
    endUtc: '2026-10-17T08:00:00.000Z', rewards: [{ itemId: 'item-1', name: 'Belohnung', section: 'Gegenstände' }],
  });
  try {
    const postId = await syncForumEvent({ guildId: 'guild-1', channelId: 'forum-1', event, sourceUrls: [url], discord, store: db, now: NOW });
    saveChecklistSelection(db, { guildId: 'guild-1', userId: 'user-1', eventKey: event.eventKey, itemIds: ['item-1'], doneItemIds: [] });
    setChecklistReminderPreference(db, 'guild-1', 'user-1', event.eventKey, true);
    await syncEventReminders({ guildId: 'guild-1', channelId: 'forum-1', events: [event], store: db, discord, now: NOW });
    assert.equal(discord.sentToThreads.length, 1);
    assert.equal(discord.sentToThreads[0]?.threadId, postId);
    assert.equal(discord.threadStarts, 0);

    await syncScheduledEvent({ event, sourceUrls: [url], guildId: 'guild-1', store: db, discord, now: NOW });
    assert.equal(discord.scheduled[0]?.location, `https://discord.com/channels/guild-1/${postId}`);
    assert.ok(discord.scheduled[0]!.location.length <= 100);
  } finally {
    db.close();
  }
});
