import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DiscordEmbed,
  DiscordMessagePayload,
  DiscordMessageSnapshot,
  DiscordPort,
  ScheduledEventPayload,
  ScheduledEventSnapshot,
} from '../src/types.ts';
import {
  applyField,
  attachSource,
  createEvent,
  getOpenEvents,
  openDb,
  setDiscordIds,
} from '../src/store.ts';
import { buildEventEmbed, syncEventEmbed } from '../src/sync/embed.ts';
import { scheduleEventReminders } from '../src/sync/reminders.ts';
import { syncScheduledEvent } from '../src/sync/scheduled.ts';
import { syncLiveStatusPost } from '../src/sync/status.ts';

const NOW = new Date('2026-10-16T12:00:00.000Z');

function discordEmbedSnapshots(embeds: readonly DiscordEmbed[] = []): DiscordEmbed[] {
  return embeds.map((embed) => ({
    ...(embed.title === undefined ? {} : { title: embed.title }),
    ...(embed.description === undefined ? {} : { description: embed.description }),
    ...(embed.fields === undefined ? {} : {
      fields: embed.fields.map((field) => ({ name: field.name, value: field.value, inline: field.inline ?? false })),
    }),
    ...(embed.footer === undefined ? {} : { footer: { text: embed.footer.text } }),
  }));
}

class FakeDiscordPort implements DiscordPort {
  readonly messages: DiscordMessageSnapshot[] = [];
  readonly scheduledEvents: ScheduledEventSnapshot[] = [];
  readonly logs: string[] = [];
  createMessageCount = 0;
  editMessageCount = 0;
  createScheduledCount = 0;
  editScheduledCount = 0;
  pinCount = 0;
  failAfterCreateMessage = false;
  failAfterCreateScheduled = false;
  failModifyScheduledAsCompleted = false;

  async createMessage(channelId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    this.createMessageCount += 1;
    const message = this.message(channelId, payload);
    this.messages.push(message);
    if (this.failAfterCreateMessage) {
      this.failAfterCreateMessage = false;
      throw new Error('simulated process exit after Discord created the message');
    }
    return message;
  }

  async editMessage(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    this.editMessageCount += 1;
    const index = this.messages.findIndex((message) => message.id === messageId && message.channelId === channelId);
    assert.notEqual(index, -1);
    const old = this.messages[index]!;
    const updated = { ...old, content: payload.content ?? '', embeds: discordEmbedSnapshots(payload.embeds) };
    this.messages[index] = updated;
    return updated;
  }

  async fetchRecentBotMessages(channelId: string, limit: number): Promise<DiscordMessageSnapshot[]> {
    return this.messages.filter((message) => message.channelId === channelId && message.authorIsBot).slice(-limit).reverse();
  }

  async createScheduledEvent(guildId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> {
    this.createScheduledCount += 1;
    const event: ScheduledEventSnapshot = { ...payload, id: `scheduled-${this.createScheduledCount}`, guildId, status: 'SCHEDULED' };
    this.scheduledEvents.push(event);
    if (this.failAfterCreateScheduled) {
      this.failAfterCreateScheduled = false;
      throw new Error('simulated process exit after Discord created the scheduled event');
    }
    return event;
  }

  async editScheduledEvent(guildId: string, eventId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> {
    this.editScheduledCount += 1;
    const index = this.scheduledEvents.findIndex((event) => event.id === eventId && event.guildId === guildId);
    assert.notEqual(index, -1);
    if (this.failModifyScheduledAsCompleted) {
      this.failModifyScheduledAsCompleted = false;
      this.scheduledEvents[index]!.status = 'COMPLETED';
      throw new Error('Discord rejects edits to completed events');
    }
    const updated = { ...this.scheduledEvents[index]!, ...payload };
    this.scheduledEvents[index] = updated;
    return updated;
  }

  async listScheduledEvents(guildId: string): Promise<ScheduledEventSnapshot[]> {
    return this.scheduledEvents.filter((event) => event.guildId === guildId).map((event) => ({ ...event }));
  }

  async pinMessage(_channelId: string, messageId: string): Promise<void> {
    this.pinCount += 1;
    const message = this.messages.find((candidate) => candidate.id === messageId);
    assert.ok(message);
    message.pinned = true;
  }

  async sendLog(_channelId: string, content: string): Promise<void> {
    this.logs.push(content);
  }

  private message(channelId: string, payload: DiscordMessagePayload): DiscordMessageSnapshot {
    return {
      id: `message-${this.messages.length + 1}`,
      channelId,
      authorIsBot: true,
      pinned: false,
      content: payload.content ?? '',
      embeds: discordEmbedSnapshots(payload.embeds),
    };
  }
}

function seedEvent(
  db: ReturnType<typeof openDb>,
  eventKey: string,
  title: string,
  startUtc = '2026-10-15T08:00:00.000Z',
  endUtc = '2026-10-20T14:59:00.000Z',
  rewards: Array<{ itemId: string; name: string; section: string }> = [],
): ReturnType<typeof getOpenEvents>[number] {
  const id = createEvent(db, { eventKey, eventType: 'seasonal-special', title });
  const sourceUrl = `https://de.finalfantasyxiv.com/lodestone/special/${eventKey}/`;
  attachSource(db, { eventId: id, url: sourceUrl, kind: 'special', publishedAt: '2026-10-15T08:00:00.000Z' });
  applyField(db, id, 'title', { status: 'ok', value: title }, sourceUrl);
  applyField(db, id, 'start', { status: 'ok', value: startUtc }, sourceUrl);
  applyField(db, id, 'end', { status: 'ok', value: endUtc }, sourceUrl);
  applyField(db, id, 'rewards', { status: 'ok', value: rewards }, sourceUrl);
  applyField(db, id, 'description', { status: 'ok', value: 'Beschreibung' }, sourceUrl);
  return getOpenEvents(db, NOW).find((event) => event.id === id)!;
}

function embedOf(message: DiscordMessageSnapshot): DiscordEmbed {
  const embed = message.embeds[0];
  assert.ok(embed);
  return embed;
}

test('two parallel events get separate messages and scheduled events and share one pinned live status post', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const events = [
      seedEvent(db, 'wake', 'Allerschutzheiligen'),
      seedEvent(db, 'fall-guys', 'Fall Guys'),
    ];
    for (const event of events) {
      const sources = [`https://de.finalfantasyxiv.com/lodestone/special/${event.eventKey}/`];
      await syncEventEmbed({ event, sourceUrls: sources, channelId: 'events', discord, store: db });
      await syncScheduledEvent({ event, sourceUrls: sources, guildId: 'guild', discord, store: db, now: NOW });
    }
    await syncLiveStatusPost({ guildId: 'guild', channelId: 'events', events, discord, store: db, now: NOW });
    await syncLiveStatusPost({ guildId: 'guild', channelId: 'events', events, discord, store: db, now: NOW });

    assert.equal(discord.createMessageCount, 3);
    assert.equal(discord.createScheduledCount, 2);
    assert.equal(discord.pinCount, 1);
    assert.equal(discord.editMessageCount, 0);
    assert.equal(discord.logs.filter((message) => message.includes('Läuft gerade')).length, 1);
    const status = discord.messages.find((message) => embedOf(message).title === 'Läuft gerade');
    assert.ok(status?.pinned);
    assert.match(embedOf(status).description ?? '', /Allerschutzheiligen.*Fall Guys|Fall Guys.*Allerschutzheiligen/s);
    assert.match(embedOf(status).description ?? '', /<t:\d+:R>/);
  } finally {
    db.close();
  }
});

test('event embeds show German local periods, Discord timestamps, linked rewards, and an internal event marker', () => {
  const db = openDb(':memory:');
  try {
    const event = seedEvent(db, 'wake', 'Allerschutzheiligen', '2026-10-15T08:00:00.000Z', '2026-11-02T14:59:00.000Z', [
      { itemId: '1077b68a626', name: 'Grizzlybär-Kopf', section: 'Ausrüstung' },
    ]);
    const embed = buildEventEmbed(event, ['https://de.finalfantasyxiv.com/lodestone/special/wake/'], NOW);
    assert.equal(embed.title, 'Allerschutzheiligen');
    assert.match(embed.description ?? '', /Do\., 15\.10\.2026, 10:00 Uhr – Mo\., 02\.11\.2026, 15:59 Uhr/);
    assert.match(embed.description ?? '', /<t:1792051200:F>.*<t:1793631540:F>/);
    assert.equal(embed.fields?.[0]?.name, 'Ausrüstung');
    assert.match(embed.fields?.[0]?.value ?? '', /\[Grizzlybär-Kopf\]\(https:\/\/de\.finalfantasyxiv\.com\/lodestone\/playguide\/db\/item\/1077b68a626\/\)/);
    assert.equal(embed.footer?.text, String(event.id));
  } finally {
    db.close();
  }
});

test('reward fields split at line boundaries and fit the field and overall embed caps with an overflow link', () => {
  const db = openDb(':memory:');
  try {
    const rewards = Array.from({ length: 120 }, (_, index) => ({
      itemId: `item-${index}`,
      name: `Belohnung ${index} ${'x'.repeat(35)}`,
      section: 'Möbel',
    }));
    const event = seedEvent(db, 'many', 'Große Belohnungsliste', undefined, undefined, rewards);
    const embed = buildEventEmbed(event, ['https://de.finalfantasyxiv.com/lodestone/special/many/'], NOW);
    assert.ok((embed.fields?.length ?? 0) <= 25);
    assert.ok((embed.fields ?? []).every((field) => field.value.length <= 1024));
    const characterCount = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) +
      (embed.footer?.text.length ?? 0) + (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
    assert.ok(characterCount <= 5_500);
    assert.match(embed.fields?.at(-1)?.value ?? '', /… und \d+ weitere Belohnungen auf der \[Sonderseite\]/);
    assert.ok((embed.fields ?? []).some((field) => /Möbel \(\d+\/\d+\)/.test(field.name)));
  } finally {
    db.close();
  }
});

test('uncertain rewards link to the special page without guessing names', () => {
  const db = openDb(':memory:');
  try {
    const event = seedEvent(db, 'uncertain', 'Belohnungen unklar');
    applyField(db, event.id, 'rewards', { status: 'unsicher', reason: 'not complete' }, `https://de.finalfantasyxiv.com/lodestone/special/uncertain/`);
    const updated = getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)!;
    const embed = buildEventEmbed(updated, ['https://de.finalfantasyxiv.com/lodestone/special/uncertain/'], NOW);
    assert.equal(embed.fields?.[0]?.value, 'Belohnungen: siehe Sonderseite\n[Zur Sonderseite](https://de.finalfantasyxiv.com/lodestone/special/uncertain/)');
  } finally {
    db.close();
  }
});

test('Discord embed snapshots with normalized field order do not cause repeat edits', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'stable-embed', 'Stabile Meldung', undefined, undefined, [
      { itemId: 'item-1', name: 'Belohnung', section: 'Möbel' },
    ]);
    const sourceUrls = [`https://de.finalfantasyxiv.com/lodestone/special/stable-embed/`];
    await syncEventEmbed({ event, sourceUrls, channelId: 'events', discord, store: db });
    await syncEventEmbed({ event, sourceUrls, channelId: 'events', discord, store: db });

    assert.equal(discord.createMessageCount, 1);
    assert.equal(discord.editMessageCount, 0);
    assert.equal(embedOf(discord.messages[0]!).fields?.[0]?.inline, false);
  } finally {
    db.close();
  }
});

test('scheduled event uses a short preferred source URL and moves a running start two minutes forward', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'wake', 'Allerschutzheiligen');
    const specialUrl = 'https://de.finalfantasyxiv.com/lodestone/special/wake/';
    const topicUrl = 'https://de.finalfantasyxiv.com/lodestone/topics/detail/a-shorter-url';
    await syncScheduledEvent({ event, sourceUrls: [topicUrl, specialUrl], guildId: 'guild', discord, store: db, now: NOW });
    assert.equal(discord.scheduledEvents[0]?.location, specialUrl);
    assert.equal(discord.scheduledEvents[0]?.startUtc, '2026-10-16T12:02:00.000Z');
    assert.match(discord.scheduledEvents[0]?.description ?? '', new RegExp(`Event-ID: ${event.id}`));
    assert.match(discord.scheduledEvents[0]?.description ?? '', new RegExp(specialUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    db.close();
  }
});

test('scheduled event falls back when the preferred source URL is longer than one hundred characters', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'long', 'Lange Quelle');
    const longUrl = `https://de.finalfantasyxiv.com/lodestone/special/${'very-long-event-name/'.repeat(6)}`;
    await syncScheduledEvent({ event, sourceUrls: [longUrl], guildId: 'guild', discord, store: db, now: NOW });
    assert.equal(discord.scheduledEvents[0]?.location, 'Lodestone – Link in der Beschreibung');
  } finally {
    db.close();
  }
});

test('a completed scheduled event is replaced on extension while the event message is retained', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'maintenance', 'Wartung aller Welten');
    const sourceUrl = 'https://de.finalfantasyxiv.com/lodestone/special/maintenance/';
    await syncEventEmbed({ event, sourceUrls: [sourceUrl], channelId: 'events', discord, store: db });
    const messageId = getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)?.discordMessageId;
    const oldScheduled = {
      id: 'old-scheduled', guildId: 'guild', name: event.title,
      startUtc: '2026-10-15T08:00:00.000Z', endUtc: '2026-10-16T10:00:00.000Z',
      location: sourceUrl, description: `Event-ID: ${event.id}\n${sourceUrl}`, status: 'COMPLETED' as const,
    };
    discord.scheduledEvents.push(oldScheduled);
    setDiscordIds(db, event.id, { scheduledEventId: oldScheduled.id });
    applyField(db, event.id, 'end', { status: 'ok', value: '2026-10-20T14:59:00.000Z' }, sourceUrl, '2026-10-16T11:00:00.000Z');
    const extended = getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)!;

    await syncEventEmbed({ event: extended, sourceUrls: [sourceUrl], channelId: 'events', discord, store: db });
    await syncScheduledEvent({ event: extended, sourceUrls: [sourceUrl], guildId: 'guild', discord, store: db, now: NOW });

    assert.equal(discord.createMessageCount, 1);
    assert.equal(discord.createScheduledCount, 1);
    assert.equal(getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)?.discordMessageId, messageId);
    assert.equal(getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)?.scheduledEventId, 'scheduled-1');
  } finally {
    db.close();
  }
});

test('a modify rejected after Discord completes the event creates a replacement event', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'rejected-extension', 'Wartung aller Welten');
    const sourceUrl = 'https://de.finalfantasyxiv.com/lodestone/special/rejected-extension/';
    await syncScheduledEvent({ event, sourceUrls: [sourceUrl], guildId: 'guild', discord, store: db, now: NOW });
    applyField(db, event.id, 'end', { status: 'ok', value: '2026-10-22T14:59:00.000Z' }, sourceUrl, '2026-10-16T11:00:00.000Z');
    const extended = getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)!;
    discord.failModifyScheduledAsCompleted = true;

    await syncScheduledEvent({ event: extended, sourceUrls: [sourceUrl], guildId: 'guild', discord, store: db, now: NOW });

    assert.equal(discord.editScheduledCount, 1);
    assert.equal(discord.createScheduledCount, 2);
    assert.equal(discord.scheduledEvents[0]?.status, 'COMPLETED');
    assert.equal(discord.scheduledEvents[1]?.endUtc, '2026-10-22T14:59:00.000Z');
    assert.equal(getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)?.scheduledEventId, 'scheduled-2');
  } finally {
    db.close();
  }
});

test('sync adopts messages and scheduled events left behind by a crash before saving their IDs', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'crash', 'Absturzsicheres Event');
    const sources = [`https://de.finalfantasyxiv.com/lodestone/special/crash/`];
    discord.failAfterCreateMessage = true;
    await assert.rejects(syncEventEmbed({ event, sourceUrls: sources, channelId: 'events', discord, store: db }));
    await syncEventEmbed({ event, sourceUrls: sources, channelId: 'events', discord, store: db });
    discord.failAfterCreateScheduled = true;
    await assert.rejects(syncScheduledEvent({ event, sourceUrls: sources, guildId: 'guild', discord, store: db, now: NOW }));
    await syncScheduledEvent({ event, sourceUrls: sources, guildId: 'guild', discord, store: db, now: NOW });

    assert.equal(discord.createMessageCount, 1);
    assert.equal(discord.createScheduledCount, 1);
    assert.equal(getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)?.discordMessageId, 'message-1');
    assert.equal(getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)?.scheduledEventId, 'scheduled-1');
  } finally {
    db.close();
  }
});

test('reminders are scheduled three days and one day before a certain end only when still upcoming', () => {
  assert.deepEqual(scheduleEventReminders('9', { status: 'ok', value: '2026-10-20T12:00:00.000Z' }, NOW), [
    { eventId: '9', leadHours: 72, dueAt: '2026-10-17T12:00:00.000Z' },
    { eventId: '9', leadHours: 24, dueAt: '2026-10-19T12:00:00.000Z' },
  ]);
  assert.deepEqual(scheduleEventReminders('9', { status: 'unsicher', reason: 'unknown' }, NOW), []);
});

