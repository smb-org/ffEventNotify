import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEvent, getAllEvents, getGuildEventObject, markEventRetracting, openDb, setGuildDiscordIds, upsertGuildSetup } from '../src/store.ts';
import { createChar, getReminderRecipients, listChars, recordUserGuild, setCharRemind, setItemDone } from '../src/web/data.ts';
import { syncEventReminders } from '../src/sync/reminders.ts';
import { collectRecentBotMessages } from '../src/discord-history.ts';
import { withGuildDiscordLock } from '../src/guild-lock.ts';
import type { DiscordEmbed, DiscordMessagePayload, DiscordMessageSnapshot, DiscordPort, ScheduledEventPayload, ScheduledEventSnapshot } from '../src/types.ts';

class ReminderDiscord implements DiscordPort {
  readonly sent: Array<{ channelId: string; payload: DiscordMessagePayload }> = [];
  readonly threadSent: Array<{ threadId: string; payload: DiscordMessagePayload }> = [];
  readonly threads = new Map<string, { id: string; parentChannelId: string; starterMessageId: string; name: string; archived: boolean; autoArchiveDuration: number }>();
  readonly threadIdsByStarter = new Map<string, string>();
  threadCreateCount = 0;
  failBeforeAccept = false;
  failAfterAccept = false;
  async createMessage(channelId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    if (this.failBeforeAccept) {
      this.failBeforeAccept = false;
      throw new Error('rejected before acceptance');
    }
    this.sent.push({ channelId, payload });
    const created = { id: `message-${this.sent.length}`, channelId, authorIsBot: true, pinned: false, content: payload.content ?? '', embeds: payload.embeds ?? [] };
    if (this.failAfterAccept) {
      this.failAfterAccept = false;
      throw new Error('response lost after acceptance');
    }
    return created;
  }
  async editMessage(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> { return { id: messageId, channelId, authorIsBot: true, pinned: false, content: payload.content ?? '', embeds: payload.embeds ?? [] }; }
  async fetchRecentBotMessages(channelId: string, _limit: number, _options?: { olderThan?: string; requireChannelStart?: boolean }) {
    const threadMessages = this.threadSent.filter(({ threadId }) => threadId === channelId);
    if (threadMessages.length > 0 || this.threads.has(channelId)) {
      return { messages: threadMessages.map(({ payload }, index) => ({
        id: `thread-message-${index + 1}`, channelId, authorIsBot: true, pinned: false,
        content: payload.content ?? '', embeds: payload.embeds ?? [],
      })), complete: true };
    }
    return { messages: this.sent.filter(({ channelId: sentChannel }) => sentChannel === channelId).map(({ payload }, index) => ({
      id: `message-${index + 1}`, channelId, authorIsBot: true, pinned: false, content: payload.content ?? '', embeds: payload.embeds ?? [],
    })), complete: true };
  }
  async fetchPinnedBotMessages(_channelId: string): Promise<DiscordMessageSnapshot[]> { return []; }
  async fetchMessage(_channelId: string, _messageId: string): Promise<DiscordMessageSnapshot | null> { return null; }
  async isTextChannel(_channelId: string): Promise<boolean> { return true; }
  async createScheduledEvent(guildId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> { return { ...payload, id: 'scheduled', guildId, status: 'SCHEDULED' }; }
  async editScheduledEvent(guildId: string, eventId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> { return { ...payload, id: eventId, guildId, status: 'SCHEDULED' }; }
  async listScheduledEvents(_guildId: string): Promise<ScheduledEventSnapshot[]> { return []; }
  async pinMessage(_channelId: string, _messageId: string): Promise<void> {}
  async sendLog(_channelId: string, _content: string): Promise<void> {}
  async startThreadOnMessage(channelId: string, starterMessageId: string, name: string, autoArchiveDuration: number) {
    this.threadCreateCount += 1;
    const thread = {
      id: `thread-${this.threadCreateCount}`, parentChannelId: channelId, starterMessageId, name,
      archived: false, autoArchiveDuration,
    };
    this.threads.set(thread.id, thread);
    this.threadIdsByStarter.set(starterMessageId, thread.id);
    return { ...thread };
  }
  async fetchThread(channelId: string, threadId: string | null, starterMessageId: string | null) {
    const byId = threadId ? this.threads.get(threadId) : undefined;
    const thread = byId?.parentChannelId === channelId ? byId
      : starterMessageId ? this.threads.get(this.threadIdsByStarter.get(starterMessageId) ?? '') : undefined;
    return thread?.parentChannelId === channelId ? { ...thread } : null;
  }
  async sendToThread(threadId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    if (this.failBeforeAccept) {
      this.failBeforeAccept = false;
      throw new Error('rejected before acceptance');
    }
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error('Unknown Thread');
    thread.archived = false;
    this.threadSent.push({ threadId, payload });
    const created = {
      id: `thread-message-${this.threadSent.length}`, channelId: threadId, authorIsBot: true,
      pinned: false, content: payload.content ?? '', embeds: payload.embeds ?? [],
    };
    if (this.failAfterAccept) {
      this.failAfterAccept = false;
      throw new Error('response lost after acceptance');
    }
    return created;
  }
  deleteThread(threadId: string): void {
    const thread = this.threads.get(threadId);
    this.threads.delete(threadId);
    if (thread) this.threadIdsByStarter.delete(thread.starterMessageId);
  }
}

/** One character "Mira" per user; `done` replaces the finished items of the event, `remind` sets the flag when given. */
function seed(db: ReturnType<typeof openDb>, guildId: string, userId: string, eventKey: string, done: string[], remind?: boolean) {
  recordUserGuild(db, userId, guildId);
  const char = listChars(db, userId)[0] ?? createChar(db, userId, 'Mira');
  db.prepare('DELETE FROM web_checklist WHERE char_id = ? AND event_key = ?').run(char.id, eventKey);
  for (const itemId of done) setItemDone(db, userId, { charId: char.id, eventKey, itemId, done: true });
  if (remind !== undefined) setCharRemind(db, userId, char.id, remind);
}

function setup(db: ReturnType<typeof openDb>, userCount = 1) {
  upsertGuildSetup(db, { guildId: 'guild-1', eventChannelId: 'events', logChannelId: 'logs' });
  const eventKey = 'seasonal-special:/lodestone/special/reminders/';
  const eventId = createEvent(db, { eventKey, eventType: 'seasonal-special', title: 'Allerschutzheiligen 2026' });
  setGuildDiscordIds(db, 'guild-1', eventKey, { messageId: 'card-1', messageChannelId: 'events' });
  const sourceUrl = 'https://de.finalfantasyxiv.com/lodestone/special/reminders/';
  db.prepare('INSERT INTO event_sources (url, event_id, kind) VALUES (?, ?, ?)').run(sourceUrl, eventId, 'special');
  db.prepare("UPDATE events SET start_utc = ?, start_status = 'ok', end_utc = ?, end_status = 'ok', rewards_status = 'ok', rewards_json = ? WHERE id = ?")
    .run('2026-10-15T08:00:00.000Z', '2026-10-20T12:30:00.000Z', JSON.stringify([
      { itemId: 'item-a', name: 'Grizzlybär-Kopf', section: 'Ausrüstung' },
      { itemId: 'item-b', name: 'Herbstkranz', section: 'Möbel' },
      { itemId: 'item-c', name: 'Kürbislaterne', section: 'Möbel' },
      { itemId: 'item-d', name: 'Allerschutzheiligen-Torte', section: 'Möbel' },
    ]), eventId);
  for (let index = 1; index <= userCount; index += 1) {
    const userId = `user-${String(index).padStart(2, '0')}`;
    seed(db, 'guild-1', userId, eventKey, index === 2 ? ['item-a', 'item-b', 'item-c', 'item-d'] : [], index !== 3);
  }
  return { eventKey, eventId };
}

test('due reminders batch only opted-in users with open items and persist slots across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-reminders-'));
  const path = join(directory, 'reminders.sqlite');
  let db = openDb(path);
  const { eventKey, eventId } = setup(db, 3);
  const discord = new ReminderDiscord();
  const due = new Date('2026-10-17T12:31:00.000Z');
  try {
    const events = getAllEvents(db).filter((event) => event.id === eventId);
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events, store: db, discord, now: due });
    assert.equal(discord.threadCreateCount, 1);
    assert.equal(discord.threadSent.length, 1);
    assert.equal(discord.sent.length, 0, 'reminders must not be posted to the event channel');
    assert.match(discord.threadSent[0]?.payload.content ?? '', /Noch 3 Tage: \[Allerschutzheiligen 2026\]/);
    assert.match(discord.threadSent[0]?.payload.content ?? '', /<@user-01>/);
    assert.doesNotMatch(discord.threadSent[0]?.payload.content ?? '', /<@user-02>|<@user-03>/);
    assert.deepEqual(discord.threadSent[0]?.payload.allowedMentions, { parse: [], users: ['user-01'] });
    assert.equal((discord.threadSent[0]?.payload as unknown as { suppressEmbeds?: boolean }).suppressEmbeds, true);
    assert.match(discord.threadSent[0]?.payload.content ?? '', /\]\(<https:\/\/de\.finalfantasyxiv\.com\//);
    assert.equal(discord.threads.get(discord.threadSent[0]!.threadId)?.name, 'Erinnerungen: Allerschutzheiligen 2026');
    assert.equal(discord.threads.get(discord.threadSent[0]!.threadId)?.autoArchiveDuration, 10080);
    assert.equal(getGuildEventObject(db, 'guild-1', eventKey)?.reminderThreadId, discord.threadSent[0]!.threadId);

    db.close();
    db = openDb(path);
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: getAllEvents(db).filter((event) => event.id === eventId), store: db, discord, now: due });
    assert.equal(discord.sent.length, 0, 'a restart must not post into the event channel');
    assert.equal(discord.threadSent.length, 1, 'a restart must not resend the 3-day slot');
    assert.equal(discord.threadCreateCount, 1, 'a restart must recover the event thread');
    assert.ok(eventKey.length > 0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a queued reminder skips an event marked retracting before its guild lock opens', async () => {
  const db = openDb(':memory:');
  const { eventId } = setup(db);
  const discord = new ReminderDiscord();
  const now = new Date('2026-10-17T12:31:00.000Z');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const lock = withGuildDiscordLock('guild-1', async () => gate);
  const queuedReminder = syncEventReminders({
    guildId: 'guild-1', channelId: 'events', events: getAllEvents(db), store: db, discord, now,
  });
  markEventRetracting(db, eventId, 'Quelle wird ignoriert.', now.toISOString());
  release();
  try {
    await Promise.all([lock, queuedReminder]);

    assert.equal(discord.threadCreateCount, 0);
    assert.equal(discord.threadSent.length, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM reminder_deliveries').get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test('reminders use one public thread per event and guild', async () => {
  const db = openDb(':memory:');
  const { eventKey, eventId } = setup(db);
  const discord = new ReminderDiscord();
  const now = new Date('2026-10-17T12:31:00.000Z');
  try {
    const event = getAllEvents(db).find((candidate) => candidate.id === eventId)!;
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });
    upsertGuildSetup(db, { guildId: 'guild-2', eventChannelId: 'events-2', logChannelId: 'logs-2' });
    setGuildDiscordIds(db, 'guild-2', eventKey, { messageId: 'card-2', messageChannelId: 'events-2' });
    seed(db, 'guild-2', 'user-02', eventKey, [], true);
    await syncEventReminders({ guildId: 'guild-2', channelId: 'events-2', events: [event], store: db, discord, now });
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });
    await syncEventReminders({ guildId: 'guild-2', channelId: 'events-2', events: [event], store: db, discord, now });

    assert.equal(discord.threadCreateCount, 2);
    assert.equal(discord.threadSent.length, 2);
    assert.deepEqual(new Set(discord.threadSent.map(({ threadId }) => threadId)).size, 2);
    assert.equal(discord.sent.length, 0);
  } finally {
    db.close();
  }
});

test('a patch-bound end does not schedule an end reminder before maintenance resolves it', async () => {
  const db = openDb(':memory:');
  const { eventId } = setup(db);
  const discord = new ReminderDiscord();
  const now = new Date('2026-10-17T12:31:00.000Z');
  db.prepare("UPDATE events SET end_utc = NULL, end_status = 'unsicher', end_reason = ?, end_patch = '8.0' WHERE id = ?")
    .run('Wird mit der Wartung zu Patch 8.0 festgelegt.', eventId);
  try {
    const event = getAllEvents(db).find((candidate) => candidate.id === eventId)!;
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });
    assert.equal(discord.threadCreateCount, 0);
    assert.equal(discord.threadSent.length, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM reminder_deliveries').get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test('a deleted reminder thread is recreated from the event card before a new batch is sent', async () => {
  const db = openDb(':memory:');
  const { eventKey, eventId } = setup(db);
  const discord = new ReminderDiscord();
  const now = new Date('2026-10-17T12:31:00.000Z');
  try {
    const event = getAllEvents(db).find((candidate) => candidate.id === eventId)!;
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });
    const deletedThreadId = discord.threadSent[0]!.threadId;
    discord.deleteThread(deletedThreadId);
    seed(db, 'guild-1', 'user-02', eventKey, [], true);

    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });

    assert.equal(discord.threadCreateCount, 2);
    assert.equal(discord.threadSent.length, 2);
    assert.notEqual(discord.threadSent[1]?.threadId, deletedThreadId);
    assert.equal(getGuildEventObject(db, 'guild-1', eventKey)?.reminderThreadId, discord.threadSent[1]!.threadId);
    assert.deepEqual(discord.threadSent[1]?.payload.allowedMentions, { parse: [], users: ['user-02'] });
    assert.equal(discord.sent.length, 0);
  } finally {
    db.close();
  }
});

test('a recreated event card gets a thread of its own', async () => {
  const db = openDb(':memory:');
  const { eventKey, eventId } = setup(db);
  const discord = new ReminderDiscord();
  const now = new Date('2026-10-17T12:31:00.000Z');
  try {
    const event = getAllEvents(db).find((candidate) => candidate.id === eventId)!;
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });
    setGuildDiscordIds(db, 'guild-1', eventKey, { messageId: 'recreated-card', messageChannelId: 'events' });
    seed(db, 'guild-1', 'user-02', eventKey, [], true);

    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });

    assert.equal(discord.threadCreateCount, 2);
    assert.equal(discord.threads.get(discord.threadSent[1]!.threadId)?.starterMessageId, 'recreated-card');
    assert.equal(discord.sent.length, 0);
  } finally {
    db.close();
  }
});

test('reminder messages split below 2000 characters with only those users allowed to be mentioned', async () => {
  const db = openDb(':memory:');
  const { eventId } = setup(db, 150);
  const discord = new ReminderDiscord();
  try {
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: getAllEvents(db).filter((event) => event.id === eventId), store: db, discord, now: new Date('2026-10-17T12:31:00.000Z') });
    assert.ok(discord.threadSent.length > 1);
    assert.equal(discord.sent.length, 0);
    for (const { payload } of discord.threadSent) {
      assert.ok((payload.content ?? '').length <= 2_000);
      const mentions = [...(payload.content ?? '').matchAll(/<@(user-\d+)>/g)].map((match) => match[1]);
      assert.deepEqual(payload.allowedMentions, { parse: [], users: mentions });
    }
  } finally {
    db.close();
  }
});

test('late reminder slots send the one-day notice without replaying the stale three-day notice', async () => {
  const db = openDb(':memory:');
  const { eventId } = setup(db);
  const discord = new ReminderDiscord();
  try {
    const event = getAllEvents(db).find((candidate) => candidate.id === eventId)!;
    const endMs = Date.parse(event.endUtc!);
    await syncEventReminders({
      guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord,
      now: new Date(endMs - 12 * 60 * 60 * 1_000),
    });

    assert.equal(discord.threadSent.length, 1);
    assert.equal(discord.sent.length, 0);
    assert.match(discord.threadSent[0]?.payload.content ?? '', /^Noch 1 Tag:/);
  } finally {
    db.close();
  }
});

test('current rewards without checklist rows count as unfinished for existing subscribers', () => {
  const db = openDb(':memory:');
  const { eventId } = setup(db);
  try {
    const event = getAllEvents(db).find((candidate) => candidate.id === eventId)!;
    db.prepare('UPDATE events SET rewards_json = ? WHERE id = ?').run(JSON.stringify([
      ...event.rewards,
      { itemId: 'item-new', name: 'Neue Belohnung', section: 'Möbel' },
    ]), eventId);

    const updated = getAllEvents(db).find((candidate) => candidate.id === eventId)!;
    assert.deepEqual(getReminderRecipients(db, 'guild-1', updated), [
      { userId: 'user-01', chars: [{ name: 'Mira', open: 5 }] },
    ]);
  } finally {
    db.close();
  }
});

test('failed reminder batches retry and accepted messages recover from their stable marker', async () => {
  const db = openDb(':memory:');
  const { eventId } = setup(db);
  const discord = new ReminderDiscord();
  const now = new Date('2026-10-17T12:31:00.000Z');
  try {
    const event = getAllEvents(db).find((candidate) => candidate.id === eventId)!;
    discord.failBeforeAccept = true;
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });
    assert.equal(discord.threadSent.length, 0);

    discord.failAfterAccept = true;
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });
    assert.equal(discord.threadSent.length, 1);
    assert.match(discord.threadSent[0]?.payload.content ?? '', /#ffe-r-[a-f0-9]+/);

    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });
    assert.equal(discord.threadSent.length, 1, 'the accepted batch marker prevents duplicate pings after an ambiguous response');
    assert.equal(discord.sent.length, 0);
  } finally {
    db.close();
  }
});

test('sent users are not pinged again when the open recipient list changes', async () => {
  const db = openDb(':memory:');
  const { eventKey, eventId } = setup(db, 3);
  const discord = new ReminderDiscord();
  const now = new Date('2026-10-17T12:31:00.000Z');
  try {
    const event = getAllEvents(db).find((candidate) => candidate.id === eventId)!;
    seed(db, 'guild-1', 'user-02', eventKey, []);
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });
    assert.deepEqual(discord.threadSent[0]?.payload.allowedMentions?.users, ['user-01', 'user-02']);

    seed(db, 'guild-1', 'user-01', eventKey, ['item-a', 'item-b', 'item-c', 'item-d']);
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });
    assert.equal(discord.threadSent.length, 1, 'the remaining previously sent user must not be pinged again');

    seed(db, 'guild-1', 'user-03', eventKey, [], true);
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });

    assert.equal(discord.threadSent.length, 2);
    assert.deepEqual(discord.threadSent[1]?.payload.allowedMentions?.users, ['user-03']);
    assert.doesNotMatch(discord.threadSent[1]?.payload.content ?? '', /<@user-0[12]>/);
    assert.equal(discord.sent.length, 0);
    const deliveries = db.prepare(`SELECT user_id AS userId, status FROM reminder_deliveries
      WHERE guild_id = 'guild-1' AND event_key = ? AND lead_hours = 72 ORDER BY user_id`)
      .all(eventKey) as Array<{ userId: string; status: string }>;
    assert.deepEqual(deliveries.map(({ userId, status }) => [userId, status]), [
      ['user-01', 'sent'], ['user-02', 'sent'], ['user-03', 'sent'],
    ]);
  } finally {
    db.close();
  }
});

test('reminder recovery stays inconclusive after 200 newer bot posts hide the accepted message', async () => {
  const db = openDb(':memory:');
  const { eventId } = setup(db);
  const discord = new ReminderDiscord();
  const now = new Date('2026-10-17T12:31:00.000Z');
  const history: Array<{ id: string; authorId: string; createdAt: string; snapshot: DiscordMessageSnapshot }> = [];
  discord.fetchRecentBotMessages = async (_channelId, limit, options) => {
    const result = await collectRecentBotMessages(async (pageSize, before) => {
      const start = before === undefined ? 0 : history.findIndex((message) => message.id === before) + 1;
      return history.slice(start, start + pageSize);
    }, 'bot', limit, { pageSize: 100, maxPages: 20, ...options });
    return { messages: result.messages.map((message) => message.snapshot), complete: result.complete };
  };
  try {
    const event = getAllEvents(db).find((candidate) => candidate.id === eventId)!;
    discord.failAfterAccept = true;
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });
    const accepted = discord.threadSent[0]!;
    const acceptedSnapshot: DiscordMessageSnapshot = {
      id: 'accepted-reminder', channelId: accepted.threadId, authorIsBot: true, pinned: false,
      content: accepted.payload.content ?? '', embeds: [],
    };
    history.push({ id: acceptedSnapshot.id, authorId: 'bot', createdAt: '2026-10-17T12:32:00.000Z', snapshot: acceptedSnapshot });
    for (let index = 0; index < 201; index += 1) {
      const snapshot: DiscordMessageSnapshot = {
        id: `newer-${index}`, channelId: 'events', authorIsBot: true, pinned: false, content: '', embeds: [],
      };
      history.push({ id: snapshot.id, authorId: 'bot', createdAt: '2026-10-17T12:33:00.000Z', snapshot });
    }
    history.reverse();

    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now });

    assert.equal(discord.threadSent.length, 1, 'an unseen recovery marker must not be treated as proof that sending is safe');
  } finally {
    db.close();
  }
});

test('re-enrolled reminders recover the previous slot after database loss', async () => {
  const firstDb = openDb(':memory:');
  const { eventId } = setup(firstDb);
  const discord = new ReminderDiscord();
  const now = new Date('2026-10-17T12:31:00.000Z');
  try {
    const firstEvent = getAllEvents(firstDb).find((candidate) => candidate.id === eventId)!;
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [firstEvent], store: firstDb, discord, now });
  } finally {
    firstDb.close();
  }

  const restoredDb = openDb(':memory:');
  const restored = setup(restoredDb);
  try {
    const event = getAllEvents(restoredDb).find((candidate) => candidate.id === restored.eventId)!;
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: restoredDb, discord, now });
    assert.equal(discord.threadSent.length, 1, 'the marker in Discord survives losing reminder delivery state');
  } finally {
    restoredDb.close();
  }
});

test('reminder catch-up sends a three-day slot up to half its lead time late', async () => {
  const db = openDb(':memory:');
  const { eventId } = setup(db);
  const discord = new ReminderDiscord();
  try {
    const event = getAllEvents(db).find((candidate) => candidate.id === eventId)!;
    const dueAt = Date.parse(event.endUtc!) - 72 * 60 * 60 * 1_000;
    await syncEventReminders({
      guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord,
      now: new Date(dueAt + 36 * 60 * 60 * 1_000),
    });
    assert.equal(discord.threadSent.length, 1);

    const freshDb = openDb(':memory:');
    const freshSetup = setup(freshDb);
    const freshDiscord = new ReminderDiscord();
    try {
      const freshEvent = getAllEvents(freshDb).find((candidate) => candidate.id === freshSetup.eventId)!;
      await syncEventReminders({
        guildId: 'guild-1', channelId: 'events', events: [freshEvent], store: freshDb, discord: freshDiscord,
        now: new Date(dueAt + 36 * 60 * 60 * 1_000 + 1),
      });
      assert.equal(freshDiscord.threadSent.length, 0, 'catch-up stops after half the reminder lead time');
    } finally {
      freshDb.close();
    }
  } finally {
    db.close();
  }
});

test('reminder lines list the open count per reminding character and sanitize names', async () => {
  const db = openDb(':memory:');
  const { eventKey, eventId } = setup(db);
  const discord = new ReminderDiscord();
  try {
    const kael = createChar(db, 'user-01', 'Kael');
    setCharRemind(db, 'user-01', kael.id, true);
    createChar(db, 'user-01', 'Still');
    const wild = createChar(db, 'user-01', '<@999> *Boss*');
    setCharRemind(db, 'user-01', wild.id, true);
    setItemDone(db, 'user-01', { charId: kael.id, eventKey, itemId: 'item-a', done: true });
    setItemDone(db, 'user-01', { charId: kael.id, eventKey, itemId: 'item-b', done: true });
    setItemDone(db, 'user-01', { charId: kael.id, eventKey, itemId: 'item-c', done: true });
    const event = getAllEvents(db).find((candidate) => candidate.id === eventId)!;
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: [event], store: db, discord, now: new Date('2026-10-17T12:31:00.000Z') });
    const content = discord.threadSent[0]?.payload.content ?? '';
    assert.match(content, /• <@user-01>: Mira: 4 offen, Kael: 1 offen, 999 \\\*Boss\\\*: 4 offen/);
    assert.ok(!content.includes('Still'));
    assert.ok(!content.includes('<@999>'));
  } finally {
    db.close();
  }
});
