import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEvent, getAllEvents, openDb, saveChecklistSelection, setChecklistReminderPreference } from '../src/store.ts';
import { syncEventReminders } from '../src/sync/reminders.ts';
import type { DiscordEmbed, DiscordMessagePayload, DiscordMessageSnapshot, DiscordPort, ScheduledEventPayload, ScheduledEventSnapshot } from '../src/types.ts';

class ReminderDiscord implements DiscordPort {
  readonly sent: Array<{ channelId: string; payload: DiscordMessagePayload }> = [];
  async createMessage(channelId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    this.sent.push({ channelId, payload });
    return { id: `message-${this.sent.length}`, channelId, authorIsBot: true, pinned: false, content: payload.content ?? '', embeds: payload.embeds ?? [] };
  }
  async editMessage(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> { return { id: messageId, channelId, authorIsBot: true, pinned: false, content: payload.content ?? '', embeds: payload.embeds ?? [] }; }
  async fetchRecentBotMessages(_channelId: string, _limit: number): Promise<DiscordMessageSnapshot[]> { return []; }
  async fetchPinnedBotMessages(_channelId: string): Promise<DiscordMessageSnapshot[]> { return []; }
  async fetchMessage(_channelId: string, _messageId: string): Promise<DiscordMessageSnapshot | null> { return null; }
  async isTextChannel(_channelId: string): Promise<boolean> { return true; }
  async createScheduledEvent(guildId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> { return { ...payload, id: 'scheduled', guildId, status: 'SCHEDULED' }; }
  async editScheduledEvent(guildId: string, eventId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> { return { ...payload, id: eventId, guildId, status: 'SCHEDULED' }; }
  async listScheduledEvents(_guildId: string): Promise<ScheduledEventSnapshot[]> { return []; }
  async pinMessage(_channelId: string, _messageId: string): Promise<void> {}
  async sendLog(_channelId: string, _content: string): Promise<void> {}
}

function setup(db: ReturnType<typeof openDb>, userCount = 1) {
  const eventKey = 'seasonal-special:/lodestone/special/reminders/';
  const eventId = createEvent(db, { eventKey, eventType: 'seasonal-special', title: 'Allerschutzheiligen 2026' });
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
    saveChecklistSelection(db, {
      guildId: 'guild-1', userId, eventKey,
      itemIds: ['item-a', 'item-b', 'item-c', 'item-d'],
      doneItemIds: index === 2 ? ['item-a', 'item-b', 'item-c', 'item-d'] : [],
    });
    setChecklistReminderPreference(db, 'guild-1', userId, eventKey, index !== 3);
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
    assert.equal(discord.sent.length, 1);
    assert.match(discord.sent[0]?.payload.content ?? '', /Noch 3 Tage: Allerschutzheiligen 2026/);
    assert.match(discord.sent[0]?.payload.content ?? '', /<@user-01>/);
    assert.doesNotMatch(discord.sent[0]?.payload.content ?? '', /<@user-02>|<@user-03>/);
    assert.deepEqual(discord.sent[0]?.payload.allowedMentions, { parse: [], users: ['user-01'] });

    db.close();
    db = openDb(path);
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: getAllEvents(db).filter((event) => event.id === eventId), store: db, discord, now: due });
    assert.equal(discord.sent.length, 1, 'a restart must not resend the 3-day slot');
    assert.ok(eventKey.length > 0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reminder messages split below 2000 characters with only those users allowed to be mentioned', async () => {
  const db = openDb(':memory:');
  const { eventId } = setup(db, 40);
  const discord = new ReminderDiscord();
  try {
    await syncEventReminders({ guildId: 'guild-1', channelId: 'events', events: getAllEvents(db).filter((event) => event.id === eventId), store: db, discord, now: new Date('2026-10-17T12:31:00.000Z') });
    assert.ok(discord.sent.length > 1);
    for (const { payload } of discord.sent) {
      assert.ok((payload.content ?? '').length <= 2_000);
      const mentions = [...(payload.content ?? '').matchAll(/<@(user-\d+)>/g)].map((match) => match[1]);
      assert.deepEqual(payload.allowedMentions, { parse: [], users: mentions });
    }
  } finally {
    db.close();
  }
});

test('late reminder slots do not send stale three-day and one-day notices together', async () => {
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

    assert.equal(discord.sent.length, 0);
  } finally {
    db.close();
  }
});
