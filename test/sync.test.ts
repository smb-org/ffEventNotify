import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DiscordEmbed,
  DiscordMessagePayload,
  DiscordMessageSnapshot,
  DiscordPort,
  DiscordThreadSnapshot,
  ScheduledEventPayload,
  ScheduledEventSnapshot,
} from '../src/types.ts';
import {
  applyField,
  attachSource,
  createEvent,
  getOpenEvents,
  getGuild,
  getGuildEventObject,
  openDb,
  setGuildStatusMessage,
  setGuildDiscordIds,
  setEventImageUrl,
  upsertGuildSetup,
} from '../src/store.ts';
import { buildEventEmbed, syncEventEmbed } from '../src/sync/embed.ts';
import { scheduleEventReminders } from '../src/sync/reminders.ts';
import { scheduledEventPayloadFor, syncScheduledEvent } from '../src/sync/scheduled.ts';
import { syncLiveStatusPost } from '../src/sync/status.ts';
import { stableEventIdentity } from '../src/event-identity.ts';
import { collectRecentBotMessages } from '../src/discord-history.ts';
import { assertDiscordActionRows } from './component-invariants.ts';

const NOW = new Date('2026-10-16T12:00:00.000Z');

function discordEmbedSnapshots(embeds: readonly DiscordEmbed[] = []): DiscordEmbed[] {
  return embeds.map((embed) => ({
    ...(embed.title === undefined ? {} : { title: embed.title }),
    ...(embed.url === undefined ? {} : { url: embed.url }),
    ...(embed.description === undefined ? {} : { description: embed.description }),
    ...(embed.color === undefined ? {} : { color: embed.color }),
    ...(embed.author === undefined ? {} : { author: { ...embed.author } }),
    ...(embed.image === undefined ? {} : { image: { ...embed.image } }),
    ...(embed.fields === undefined ? {} : {
      fields: embed.fields.map((field) => ({ name: field.name, value: field.value, inline: field.inline ?? false })),
    }),
    ...(embed.footer === undefined ? {} : { footer: { text: embed.footer.text } }),
  }));
}

function componentSnapshots(rows: DiscordMessagePayload['components'] = []) {
  assertDiscordActionRows(rows);
  return rows.map((row) => ({
    components: row.components.map((component) => component.type === 'button' ? { ...component } : {
      ...component,
      options: component.options.map((option) => ({ ...option })),
    }),
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
    const updated = {
      ...old,
      content: payload.content ?? '',
      embeds: discordEmbedSnapshots(payload.embeds),
      components: payload.components === undefined ? old.components : componentSnapshots(payload.components),
    };
    this.messages[index] = updated;
    return updated;
  }

  async fetchRecentBotMessages(channelId: string, limit: number, _options?: { olderThan?: string; requireChannelStart?: boolean }) {
    return { messages: this.messages.filter((message) => message.channelId === channelId).slice().reverse()
      .filter((message) => message.authorIsBot).slice(0, limit), complete: true };
  }

  async fetchPinnedBotMessages(channelId: string): Promise<DiscordMessageSnapshot[]> {
    return this.messages.filter((message) => message.channelId === channelId && message.authorIsBot && message.pinned);
  }

  async fetchMessage(channelId: string, messageId: string): Promise<DiscordMessageSnapshot | null> {
    return this.messages.find((message) => message.channelId === channelId && message.id === messageId) ?? null;
  }

  async isTextChannel(_channelId: string): Promise<boolean> {
    return true;
  }

  async startThreadOnMessage(channelId: string, starterMessageId: string, name: string): Promise<DiscordThreadSnapshot> {
    return { id: `thread-${starterMessageId}`, parentChannelId: channelId, starterMessageId, name, archived: false };
  }

  async fetchThread(_channelId: string, _threadId: string | null, _starterMessageId: string | null): Promise<DiscordThreadSnapshot | null> {
    return null;
  }

  async sendToThread(threadId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    return { id: `thread-message-${this.messages.length + 1}`, channelId: threadId, authorIsBot: true, pinned: false,
      content: payload.content ?? '', embeds: discordEmbedSnapshots(payload.embeds), components: componentSnapshots(payload.components) };
  }

  async createScheduledEvent(guildId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> {
    this.createScheduledCount += 1;
    const event: ScheduledEventSnapshot = {
      ...payload,
      startUtc: new Date(payload.startUtc).toISOString(),
      endUtc: new Date(payload.endUtc).toISOString(),
      id: `scheduled-${this.createScheduledCount}`, guildId, status: 'SCHEDULED',
    };
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
    const updated = {
      ...this.scheduledEvents[index]!, ...payload,
      startUtc: new Date(payload.startUtc).toISOString(),
      endUtc: new Date(payload.endUtc).toISOString(),
    };
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
      components: componentSnapshots(payload.components),
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
  upsertGuildSetup(db, { guildId: 'guild', eventChannelId: 'events', logChannelId: 'logs' });
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

async function syncScheduledWithCard(options: Parameters<typeof syncScheduledEvent>[0]): Promise<string | undefined> {
  const channelId = getGuild(options.store, options.guildId)?.eventChannelId;
  if (!channelId) return undefined;
  await syncEventEmbed({
    event: options.event,
    sourceUrls: options.sourceUrls,
    guildId: options.guildId,
    channelId,
    discord: options.discord,
    store: options.store,
    ...(options.now ? { now: options.now } : {}),
  });
  return syncScheduledEvent(options);
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
      await syncScheduledWithCard({ event, sourceUrls: sources, guildId: 'guild', discord, store: db, now: NOW });
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
    const firstCard = getGuildEventObject(db, 'guild', events[0]!.eventKey)!;
    assert.match(embedOf(status).description ?? '', new RegExp(`https://discord\\.com/channels/guild/events/${firstCard.messageId}`));
  } finally {
    db.close();
  }
});

test('live status links each event title to its Discord card and leaves a missing card title plain', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const linked = seedEvent(db, 'status-linked', 'Verknüpftes Event');
    const plain = seedEvent(db, 'status-plain', 'Karte fehlt');
    const linkedSource = [`https://de.finalfantasyxiv.com/lodestone/special/${linked.eventKey}/`];
    await syncEventEmbed({ event: linked, sourceUrls: linkedSource, guildId: 'guild', channelId: 'events', discord, store: db });
    await syncLiveStatusPost({ guildId: 'guild', channelId: 'events', events: [linked, plain], discord, store: db, now: NOW });

    const description = embedOf(discord.messages.find((message) => embedOf(message).title === 'Läuft gerade')!).description ?? '';
    const cardId = getGuildEventObject(db, 'guild', linked.eventKey)?.messageId;
    assert.ok(cardId);
    assert.match(description, new RegExp(`• \\[Verknüpftes Event\\]\\(<https://discord\\.com/channels/guild/events/${cardId}>\\) — endet <t:`));
    assert.match(description, /• Karte fehlt — endet <t:/);
    assert.doesNotMatch(description, /• \[Karte fehlt\]/);
  } finally {
    db.close();
  }
});

test('scheduled event location uses the event card jump link and stays within Discord location bounds', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'scheduled-card-link', 'Karten-Link');
    const sourceUrls = [`https://de.finalfantasyxiv.com/lodestone/special/${event.eventKey}/`];
    await syncEventEmbed({ event, sourceUrls, guildId: 'guild', channelId: 'events', discord, store: db });
    const messageId = getGuildEventObject(db, 'guild', event.eventKey)?.messageId;
    assert.ok(messageId);
    const jumpLink = `https://discord.com/channels/guild/events/${messageId}`;
    assert.ok(jumpLink.length <= 100);
    await syncScheduledWithCard({ event, sourceUrls, guildId: 'guild', discord, store: db, now: NOW });

    assert.equal(discord.scheduledEvents[0]?.location, jumpLink);
    assert.ok((discord.scheduledEvents[0]?.location.length ?? 101) <= 100);
    assert.match(discord.scheduledEvents[0]?.description ?? '', new RegExp(sourceUrls[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const [lodestoneLink, recoveryMarker] = (discord.scheduledEvents[0]?.description ?? '').split('\n');
    assert.match(lodestoneLink ?? '', /^\[Zur Lodestone-Ankündigung\]\(/);
    assert.equal(recoveryMarker, `#ffe-${stableEventIdentity(event.eventKey)}`);
  } finally {
    db.close();
  }
});

test('Discord snowflake jump links fit the scheduled-event location limit', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  const guildId = '12345678901234567890';
  const channelId = '22345678901234567890';
  const messageId = '32345678901234567890';
  try {
    const event = seedEvent(db, 'snowflake-card-link', 'Snowflake-Karte');
    const sourceUrl = `https://de.finalfantasyxiv.com/lodestone/special/${event.eventKey}/`;
    upsertGuildSetup(db, { guildId, eventChannelId: channelId, logChannelId: '42345678901234567890' });
    setGuildDiscordIds(db, guildId, event.eventKey, { messageId, messageChannelId: channelId });
    discord.messages.push({
      id: messageId, channelId, authorIsBot: true, pinned: false, content: '',
      embeds: [buildEventEmbed(event, [sourceUrl], NOW)],
    });
    const jumpLink = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
    assert.ok(jumpLink.length <= 100);

    await syncScheduledEvent({ event, sourceUrls: [sourceUrl], guildId, discord, store: db, now: NOW });

    assert.equal(discord.scheduledEvents[0]?.location, jumpLink);
    assert.ok((discord.scheduledEvents[0]?.location.length ?? 101) <= 100);
  } finally {
    db.close();
  }
});

test('scheduled events are not created before an event card exists', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'scheduled-waits-for-card', 'Wartet auf Karte');
    const id = await syncScheduledEvent({
      event,
      sourceUrls: [`https://de.finalfantasyxiv.com/lodestone/special/${event.eventKey}/`],
      guildId: 'guild', discord, store: db, now: NOW,
    });
    assert.equal(id, undefined);
    assert.equal(discord.createScheduledCount, 0);
  } finally {
    db.close();
  }
});

test('scheduled location follows a recreated event card', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'scheduled-card-recreated', 'Neu erstellte Karte');
    const sourceUrls = [`https://de.finalfantasyxiv.com/lodestone/special/${event.eventKey}/`];
    await syncScheduledWithCard({ event, sourceUrls, guildId: 'guild', discord, store: db, now: NOW });
    const oldCard = getGuildEventObject(db, 'guild', event.eventKey)?.messageId;
    assert.ok(oldCard);
    const cardIndex = discord.messages.findIndex((message) => message.id === oldCard);
    assert.notEqual(cardIndex, -1);
    const replacementCardId = '923456789012345678';
    discord.messages[cardIndex] = { ...discord.messages[cardIndex]!, id: replacementCardId };
    setGuildDiscordIds(db, 'guild', event.eventKey, { messageId: replacementCardId, messageChannelId: 'events' });

    await syncScheduledWithCard({ event, sourceUrls, guildId: 'guild', discord, store: db, now: NOW });

    assert.equal(discord.editScheduledCount, 1);
    assert.equal(discord.scheduledEvents[0]?.location, `https://discord.com/channels/guild/events/${replacementCardId}`);
  } finally {
    db.close();
  }
});

test('event embeds show German source links, Discord timestamps, and linked rewards without visible ids', () => {
  const db = openDb(':memory:');
  try {
    const event = seedEvent(db, 'wake', 'Allerschutzheiligen', '2026-10-15T08:00:00.000Z', '2026-11-02T14:59:00.000Z', [
      { itemId: '1077b68a626', name: 'Grizzlybär-Kopf', section: 'Ausrüstung' },
    ]);
    const embed = buildEventEmbed(event, ['https://de.finalfantasyxiv.com/lodestone/special/wake/'], NOW);
    assert.equal(embed.title, 'Allerschutzheiligen');
    assert.equal(embed.author?.name, 'Saison-Event · Lodestone');
    assert.equal(embed.color, 0xE67E22);
    assert.equal(embed.url, `https://de.finalfantasyxiv.com/lodestone/special/wake/#ffe-${stableEventIdentity(event.eventKey)}`);
    assert.equal(embed.footer?.text, 'Quelle: Lodestone');
    assert.doesNotMatch(JSON.stringify(embed), /Event-ID|\bid\b/i);
    assert.equal(embed.description, undefined);
    assert.deepEqual(embed.fields?.slice(0, 3).map(({ name, value, inline }) => ({ name, value, inline })), [
      { name: 'Beginn', value: '<t:1792051200:f>', inline: true },
      { name: 'Ende', value: '<t:1793631540:f>', inline: true },
      { name: 'Endet', value: '<t:1793631540:R>', inline: true },
    ]);
    assert.equal(embed.fields?.[3]?.name, 'Ausrüstung');
    assert.match(embed.fields?.[3]?.value ?? '', /\[Grizzlybär-Kopf\]\(https:\/\/de\.finalfantasyxiv\.com\/lodestone\/playguide\/db\/item\/1077b68a626\/\)/);
  } finally {
    db.close();
  }
});

test('reward fields show at most eight items per section and fit the field and overall embed caps', () => {
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
    assert.match(embed.fields?.at(-1)?.value ?? '', /… und \d+ weitere auf der Sonderseite/);
    assert.equal((embed.fields?.at(-1)?.value?.match(/\[Belohnung /g) ?? []).length, 8);
  } finally {
    db.close();
  }
});

test('thirty Mog Mog rewards render eight links and the exact twenty-two item overflow', () => {
  const db = openDb(':memory:');
  try {
    const rewards = Array.from({ length: 30 }, (_, index) => ({
      itemId: String(index + 1).padStart(11, '0'),
      name: `Mogry-Gegenstand ${index + 1}`,
      section: 'Belohnungen',
    }));
    const event = seedEvent(db, 'mogmog-collection/202609', 'Mog Mog-Kollektion 2026', undefined, undefined, rewards);
    const embed = buildEventEmbed(event, ['https://de.finalfantasyxiv.com/lodestone/special/mogmog-collection/202609/'], NOW);
    const rewardField = embed.fields?.find((field) => field.name === 'Belohnungen');

    assert.equal(embed.author?.name, 'Mog Mog-Kollektion · Lodestone');
    assert.equal(embed.color, 0xF1C40F);
    assert.equal((rewardField?.value.match(/\[Mogry-Gegenstand /g) ?? []).length, 8);
    assert.match(rewardField?.value ?? '', /… und 22 weitere auf der Sonderseite$/);
  } finally {
    db.close();
  }
});

test('special page images are stored only for the approved Lodestone image hosts', () => {
  const db = openDb(':memory:');
  try {
    const event = seedEvent(db, 'image', 'Mit Bild');
    assert.equal(setEventImageUrl(db, event.id, 'https://lds-img.finalfantasyxiv.com/h/event.jpg'), true);
    assert.equal(getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)?.imageUrl,
      'https://lds-img.finalfantasyxiv.com/h/event.jpg');
    const withImage = getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)!;
    assert.deepEqual(buildEventEmbed(withImage, [`https://de.finalfantasyxiv.com/lodestone/special/${event.eventKey}/`], NOW).image,
      { url: 'https://lds-img.finalfantasyxiv.com/h/event.jpg' });
    assert.equal(setEventImageUrl(db, event.id, 'https://example.test/image.jpg'), false);
    assert.equal(getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)?.imageUrl,
      'https://lds-img.finalfantasyxiv.com/h/event.jpg');
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
    assert.equal(embed.fields?.find((field) => field.name === 'Belohnungen')?.value, 'Belohnungen: siehe Sonderseite');
  } finally {
    db.close();
  }
});

test('uncertain refreshes keep the last verified dates visible and mark the period for Lodestone', () => {
  const db = openDb(':memory:');
  try {
    const rewards = [{ itemId: 'item-1', name: 'Verifizierte Belohnung', section: 'Möbel' }];
    const event = seedEvent(db, 'uncertain-refresh', 'Bestätigtes Event', undefined, undefined, rewards);
    const sourceUrl = `https://de.finalfantasyxiv.com/lodestone/special/uncertain-refresh/`;
    applyField(db, event.id, 'start', { status: 'unsicher', reason: 'Start gerade nicht lesbar' }, sourceUrl);
    applyField(db, event.id, 'end', { status: 'unsicher', reason: 'Ende gerade nicht lesbar' }, sourceUrl);
    applyField(db, event.id, 'rewards', { status: 'unsicher', reason: 'Belohnungen gerade nicht lesbar' }, sourceUrl);
    const refreshed = getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)!;

    const embed = buildEventEmbed(refreshed, [sourceUrl], NOW);

    assert.equal(embed.description, 'Zeitraum: siehe Lodestone');
    assert.deepEqual(embed.fields?.slice(0, 3).map((field) => field.name), ['Beginn', 'Ende', 'Endet']);
    const rewardsField = embed.fields?.find((field) => field.name === 'Möbel');
    assert.match(rewardsField?.value ?? '', /Verifizierte Belohnung/);
    assert.doesNotMatch(rewardsField?.value ?? '', /siehe Sonderseite/);
  } finally {
    db.close();
  }
});

test('a fresh database does not adopt a different event that reused the old numeric row ID', async () => {
  const discord = new FakeDiscordPort();
  const firstDb = openDb(':memory:');
  const secondDb = openDb(':memory:');
  try {
    const first = seedEvent(firstDb, 'stable-source:first', 'Erstes Event');
    const firstUrl = `https://de.finalfantasyxiv.com/lodestone/special/stable-source-first/`;
    await syncEventEmbed({ event: first, sourceUrls: [firstUrl], guildId: 'guild', channelId: 'events', discord, store: firstDb });

    const replacement = seedEvent(secondDb, 'stable-source:other', 'Anderes Event');
    const otherUrl = `https://de.finalfantasyxiv.com/lodestone/special/stable-source-other/`;
    await syncEventEmbed({ event: replacement, sourceUrls: [otherUrl], guildId: 'guild', channelId: 'events', discord, store: secondDb });

    assert.equal(first.id, replacement.id, 'independent databases reuse the same integer row id');
    assert.equal(discord.createMessageCount, 2);
    assert.equal(discord.editMessageCount, 0);
    assert.deepEqual(discord.messages.map((message) => embedOf(message).title), ['Erstes Event', 'Anderes Event']);
  } finally {
    firstDb.close();
    secondDb.close();
  }
});

test('legacy numeric message markers are not adopted without an exact source identity match', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'legacy-recovery', 'Gleichnamiges Event');
    const sourceUrl = 'https://de.finalfantasyxiv.com/lodestone/special/legacy-recovery/';
    discord.messages.push({
      id: 'legacy-message', channelId: 'events', authorIsBot: true, pinned: false, content: '',
      embeds: [{ title: event.title, description: `[Zur Ankündigung](${sourceUrl}anderes-event)`, footer: { text: String(event.id) } }],
    });
    await syncEventEmbed({
      event,
      sourceUrls: [sourceUrl],
      guildId: 'guild', channelId: 'events', discord, store: db,
    });

    assert.equal(discord.createMessageCount, 1);
    assert.equal(discord.editMessageCount, 0);
  } finally {
    db.close();
  }
});

test('legacy numeric message recovery requires an exact Lodestone source link and then upgrades the marker', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'legacy-exact-recovery', 'Legacy Event');
    const sourceUrl = `https://de.finalfantasyxiv.com/lodestone/special/${event.eventKey}/`;
    discord.messages.push({
      id: 'legacy-exact-message', channelId: 'events', authorIsBot: true, pinned: false, content: '',
      embeds: [{
        title: event.title,
        description: `[Zur Ankündigung](${sourceUrl})`,
        footer: { text: String(event.id) },
      }],
    });

    await syncEventEmbed({ event, sourceUrls: [sourceUrl], guildId: 'guild', channelId: 'events', discord, store: db });

    assert.equal(discord.createMessageCount, 0);
    assert.equal(discord.editMessageCount, 1);
    assert.equal(discord.messages[0]?.id, 'legacy-exact-message');
    assert.equal(embedOf(discord.messages[0]!).footer?.text, 'Quelle: Lodestone');
    assert.equal(embedOf(discord.messages[0]!).url, `${sourceUrl}#ffe-${stableEventIdentity(event.eventKey)}`);
  } finally {
    db.close();
  }
});

test('legacy stable footer markers recover older posts even when their embed has no source link', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'legacy-stable-footer', 'Alte Meldung');
    discord.messages.push({
      id: 'legacy-hash-message', channelId: 'events', authorIsBot: true, pinned: false, content: '',
      embeds: [{ title: event.title, footer: { text: `Event-ID: ${stableEventIdentity(event.eventKey)}` } }],
    });

    await syncEventEmbed({
      event,
      sourceUrls: [`https://de.finalfantasyxiv.com/lodestone/special/${event.eventKey}/`],
      guildId: 'guild', channelId: 'events', discord, store: db,
    });

    assert.equal(discord.createMessageCount, 0);
    assert.equal(discord.editMessageCount, 1);
    assert.equal(embedOf(discord.messages[0]!).footer?.text, 'Quelle: Lodestone');
  } finally {
    db.close();
  }
});

test('maintenance and generic embeds omit the not-applicable rewards field', () => {
  const db = openDb(':memory:');
  try {
    for (const eventType of ['maintenance', 'topic-generic'] as const) {
      const id = createEvent(db, { eventKey: eventType, eventType, title: 'Ereignis ohne Belohnungsfeld' });
      const event = getOpenEvents(db, NOW).find((candidate) => candidate.id === id)!;

      assert.equal(event.rewardsStatus, 'n/a');
      const embed = buildEventEmbed(event, [], NOW);
      assert.equal(embed.fields, undefined);
      assert.deepEqual(embed.author, { name: eventType === 'maintenance' ? 'Wartung · Lodestone' : 'News · Lodestone' });
      assert.equal(embed.color, eventType === 'maintenance' ? 0x95A5A6 : 0x5865F2);
    }
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
    assert.equal(embedOf(discord.messages[0]!).fields?.[3]?.inline, false);
  } finally {
    db.close();
  }
});

test('event message components survive embed edits', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'component-edit', 'Mit Checkliste', undefined, undefined, [
      { itemId: 'item-1', name: 'Belohnung', section: 'Möbel' },
    ]);
    const sourceUrls = ['https://de.finalfantasyxiv.com/lodestone/special/component-edit/'];
    await syncEventEmbed({ event, sourceUrls, channelId: 'events', discord, store: db });
    const created = discord.messages[0]!;
    assert.ok(created.components?.some((row) => row.components.some((component) => component.type === 'button'
      && component.customId === `ffe:cl:${stableEventIdentity(event.eventKey).slice(0, 32)}`)));

    applyField(db, event.id, 'title', { status: 'ok', value: 'Aktualisierter Titel' }, sourceUrls[0]!);
    const updated = getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)!;
    await syncEventEmbed({ event: updated, sourceUrls, channelId: 'events', discord, store: db });

    assert.equal(discord.editMessageCount, 1);
    assert.deepEqual(discord.messages[0]?.components, created.components);
  } finally {
    db.close();
  }
});

test('an incomplete recovery search refuses to create a duplicate event message', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'incomplete-history', 'Unvollständige Suche');
    discord.fetchRecentBotMessages = async () => ({ messages: [], complete: false });

    await assert.rejects(syncEventEmbed({
      event,
      sourceUrls: ['https://de.finalfantasyxiv.com/lodestone/special/incomplete-history/'],
      channelId: 'events',
      discord,
      store: db,
    }), /Suche nach vorhandenen Meldungen.*unvollständig/i);
    assert.equal(discord.createMessageCount, 0);
  } finally {
    db.close();
  }
});

test('event recovery finds its post after 51 newer bot messages', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'old-event-post', 'Ältere Meldung');
    const sourceUrls = ['https://de.finalfantasyxiv.com/lodestone/special/old-event-post/'];
    await syncEventEmbed({ event, sourceUrls, guildId: 'guild', channelId: 'events', discord, store: db });
    setGuildDiscordIds(db, 'guild', event.eventKey, { messageId: null, messageChannelId: null });
    for (let index = 0; index < 51; index += 1) {
      discord.messages.push({
        id: `newer-bot-${index}`, channelId: 'events', authorIsBot: true, pinned: false, content: '', embeds: [],
      });
    }

    await syncEventEmbed({ event, sourceUrls, guildId: 'guild', channelId: 'events', discord, store: db });

    assert.equal(discord.createMessageCount, 1);
    assert.equal(discord.editMessageCount, 0);
  } finally {
    db.close();
  }
});

test('event recovery behind 201 newer bot posts is found or stays inconclusive, never creates a second post', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'old-event-post-201', 'Ältere Meldung');
    const sourceUrls = ['https://de.finalfantasyxiv.com/lodestone/special/old-event-post-201/'];
    await syncEventEmbed({ event, sourceUrls, guildId: 'guild', channelId: 'events', discord, store: db, now: NOW });
    const target = discord.messages[0]!;
    assert.equal(getGuildEventObject(db, 'guild', event.eventKey)?.firstPostAttemptAt, NOW.toISOString());
    setGuildDiscordIds(db, 'guild', event.eventKey, { messageId: null, messageChannelId: null });
    for (let index = 0; index < 201; index += 1) {
      discord.messages.push({
        id: `newer-201-${index}`, channelId: 'events', authorIsBot: true, pinned: false, content: '', embeds: [],
      });
    }
    const history = [...discord.messages].reverse().map((snapshot) => ({
      id: snapshot.id,
      authorId: 'bot',
      createdAt: snapshot.id === target.id ? '2026-10-16T12:00:01.000Z' : '2026-10-16T12:01:00.000Z',
      snapshot,
    }));
    discord.fetchRecentBotMessages = async (_channelId, limit, options) => {
      const result = await collectRecentBotMessages(async (pageSize, before) => {
        const start = before === undefined ? 0 : history.findIndex((message) => message.id === before) + 1;
        return history.slice(start, start + pageSize);
      }, 'bot', limit, { pageSize: 100, maxPages: 20, ...options });
      return { messages: result.messages.map((message) => message.snapshot), complete: result.complete };
    };

    await assert.rejects(syncEventEmbed({ event, sourceUrls, guildId: 'guild', channelId: 'events', discord, store: db, now: NOW }), /unvollständig/i);

    assert.equal(discord.createMessageCount, 1);
  } finally {
    db.close();
  }
});

test('a failed stored-message read is not treated as proof that the message is missing', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'stored-read-failure', 'Bestehende Meldung');
    const sources = ['https://de.finalfantasyxiv.com/lodestone/special/stored-read-failure/'];
    setGuildDiscordIds(db, 'guild', event.eventKey, { messageId: 'stored-message', messageChannelId: 'events' });
    discord.fetchMessage = async () => { throw new Error('simulated Discord 503'); };
    await assert.rejects(syncEventEmbed({ event, sourceUrls: sources, channelId: 'events', discord, store: db }), /503/);
    assert.equal(discord.createMessageCount, 0);

    setGuildStatusMessage(db, 'guild', 'stored-status');
    await assert.rejects(syncLiveStatusPost({ guildId: 'guild', channelId: 'events', events: [], discord, store: db, now: NOW }), /503/);
    assert.equal(discord.createMessageCount, 0);
  } finally {
    db.close();
  }
});

test('inconclusive status recovery warns once in German and does not create a duplicate', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    seedEvent(db, 'status-incomplete-history', 'Statusmeldung');
    discord.fetchRecentBotMessages = async () => ({ messages: [], complete: false });
    for (let index = 0; index < 2; index += 1) {
      await syncLiveStatusPost({ guildId: 'guild', channelId: 'events', logChannelId: 'logs', events: [], discord, store: db, now: NOW });
    }

    assert.equal(discord.createMessageCount, 0);
    assert.equal(discord.logs.length, 1);
    assert.match(discord.logs[0] ?? '', /nicht vollständig gesucht.*keine neue erstellt/i);
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
    await syncScheduledWithCard({ event, sourceUrls: [topicUrl, specialUrl], guildId: 'guild', discord, store: db, now: NOW });
    const cardId = getGuildEventObject(db, 'guild', event.eventKey)?.messageId;
    const jumpLink = `https://discord.com/channels/guild/events/${cardId}`;
    assert.ok(jumpLink.length <= 100);
    assert.equal(discord.scheduledEvents[0]?.location, jumpLink);
    assert.equal(discord.scheduledEvents[0]?.startUtc, '2026-10-16T12:02:00.000Z');
    assert.match(discord.scheduledEvents[0]?.description ?? '', new RegExp(`#ffe-${stableEventIdentity(event.eventKey)}`));
    assert.match(discord.scheduledEvents[0]?.description ?? '', new RegExp(specialUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(discord.scheduledEvents[0]?.description ?? '', /Event-ID/i);
  } finally {
    db.close();
  }
});

test('an existing scheduled event keeps its start when an hour passes after it became active', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'running-stable-start', 'Laufendes Event');
    const sources = ['https://de.finalfantasyxiv.com/lodestone/special/running-stable-start/'];
    await syncScheduledWithCard({ event, sourceUrls: sources, guildId: 'guild', discord, store: db, now: NOW });
    const initialStart = discord.scheduledEvents[0]?.startUtc;
    await syncScheduledWithCard({
      event, sourceUrls: sources, guildId: 'guild', discord, store: db,
      now: new Date(NOW.getTime() + 60 * 60 * 1_000),
    });
    assert.equal(discord.scheduledEvents[0]?.startUtc, initialStart);
    assert.equal(discord.editScheduledCount, 0);

    discord.scheduledEvents[0]!.status = 'ACTIVE';
    await syncScheduledWithCard({
      event, sourceUrls: sources, guildId: 'guild', discord, store: db,
      now: new Date(NOW.getTime() + 2 * 60 * 60 * 1_000),
    });
    assert.equal(discord.scheduledEvents[0]?.startUtc, initialStart);
    assert.equal(discord.editScheduledCount, 0);
  } finally {
    db.close();
  }
});

test('schedule recovery does not match a complete marker for a longer event key', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const target = seedEvent(db, 'identity:one', 'Event Eins');
    let longer = seedEvent(db, 'identity:ten', 'Event Zehn');
    for (let index = 0; index < 8; index += 1) {
      seedEvent(db, `padding:${index}`, `Füllereignis ${index}`);
    }
    longer = getOpenEvents(db, NOW).find((event) => event.eventKey === 'identity:ten')!;
    discord.scheduledEvents.push({
      id: 'scheduled-event-10',
      guildId: 'guild',
      name: longer.title,
      startUtc: '2026-10-16T12:02:00.000Z',
      endUtc: longer.endUtc!,
      location: 'https://de.finalfantasyxiv.com/lodestone/special/identity-ten/',
      description: `Event-ID: 10\nhttps://de.finalfantasyxiv.com/lodestone/special/identity-ten/`,
      status: 'SCHEDULED',
    });

    await syncScheduledWithCard({
      event: target,
      sourceUrls: ['https://de.finalfantasyxiv.com/lodestone/special/identity-one/'],
      guildId: 'guild', discord, store: db, now: NOW,
    });

    assert.equal(discord.editScheduledCount, 0);
    assert.equal(discord.createScheduledCount, 1);
    assert.equal(discord.scheduledEvents[0]?.name, longer.title);
    assert.equal(discord.scheduledEvents[1]?.name, target.title);
  } finally {
    db.close();
  }
});

test('legacy stable scheduled markers recover an event after its title changes', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'legacy-schedule', 'Aktueller Titel');
    const sourceUrl = `https://de.finalfantasyxiv.com/lodestone/special/${event.eventKey}/`;
    discord.scheduledEvents.push({
      id: 'legacy-schedule-event',
      guildId: 'guild',
      name: 'Früherer Titel',
      startUtc: '2026-10-16T12:02:00.000Z',
      endUtc: event.endUtc!,
      location: sourceUrl,
      description: `Event-ID: ${stableEventIdentity(event.eventKey)}\n${sourceUrl}`,
      status: 'SCHEDULED',
    });

    await syncScheduledWithCard({ event, sourceUrls: [sourceUrl], guildId: 'guild', discord, store: db, now: NOW });

    assert.equal(discord.createScheduledCount, 0);
    assert.equal(discord.editScheduledCount, 1);
    assert.equal(discord.scheduledEvents[0]?.id, 'legacy-schedule-event');
    assert.equal(discord.scheduledEvents[0]?.name, event.title);
  } finally {
    db.close();
  }
});

test('unchanged scheduled timestamps compare by instant after Discord normalizes milliseconds', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'normalized-time', 'Unveränderter Termin', '2026-10-16T13:00:00Z', '2026-10-20T14:59:00Z');
    const sourceUrls = ['https://de.finalfantasyxiv.com/lodestone/special/normalized-time/'];
    await syncScheduledWithCard({ event, sourceUrls, guildId: 'guild', discord, store: db, now: NOW });
    await syncScheduledWithCard({ event, sourceUrls, guildId: 'guild', discord, store: db, now: NOW });

    assert.equal(discord.createScheduledCount, 1);
    assert.equal(discord.editScheduledCount, 0);
  } finally {
    db.close();
  }
});

test('status description stays within Discord limits and reports omitted running events', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const events = Array.from({ length: 20 }, (_, index) =>
      seedEvent(db, `long-title-${index}`, `${String(index).padStart(2, '0')} ${'X'.repeat(256)}`),
    );
    await syncLiveStatusPost({ guildId: 'guild', channelId: 'events', events, discord, store: db, now: NOW });
    const status = discord.messages.find((message) => embedOf(message).title === 'Läuft gerade');
    const description = embedOf(status!).description ?? '';

    assert.ok(description.length <= 4096);
    assert.match(description, /Weitere Events sind im Event-Kanal aufgeführt\./);
  } finally {
    db.close();
  }
});

test('status recovery finds the pinned post after it falls outside recent bot history', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'old-status', 'Alter Status');
    await syncLiveStatusPost({ guildId: 'guild', channelId: 'events', events: [event], discord, store: db, now: NOW });
    const pinnedStatus = discord.messages.find((message) => embedOf(message).title === 'Läuft gerade');
    assert.ok(pinnedStatus?.pinned);
    assert.equal(getGuild(db, 'guild')?.statusMessageId, pinnedStatus.id);

    setGuildStatusMessage(db, 'guild', null);
    for (let index = 0; index < 51; index += 1) {
      discord.messages.push({
        id: `newer-${index}`, channelId: 'events', authorIsBot: true, pinned: false, content: '', embeds: [],
      });
    }
    await syncLiveStatusPost({ guildId: 'guild', channelId: 'events', events: [], discord, store: db, now: NOW });

    assert.equal(discord.createMessageCount, 1);
    assert.equal(discord.editMessageCount, 1);
    assert.equal(discord.messages.find((message) => message.id === pinnedStatus!.id)?.embeds[0]?.description, 'Gerade läuft kein Event.');
  } finally {
    db.close();
  }
});

test('scheduled event is skipped when the two-minute running-start offset would reach its end', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'ending-soon', 'Endet gleich', '2026-10-16T11:00:00.000Z', '2026-10-16T12:01:00.000Z');
    const scheduledId = await syncScheduledWithCard({
      event,
      sourceUrls: ['https://de.finalfantasyxiv.com/lodestone/special/ending-soon/'],
      guildId: 'guild',
      discord,
      store: db,
      now: NOW,
    });

    assert.equal(scheduledId, undefined);
    assert.equal(discord.createScheduledCount, 0);
  } finally {
    db.close();
  }
});

test('generic embeds display a verified start when the end is uncertain', () => {
  const db = openDb(':memory:');
  try {
    const id = createEvent(db, { eventKey: 'generic-start', eventType: 'topic-generic', title: 'Live-Letter' });
    const sourceUrl = 'https://de.finalfantasyxiv.com/lodestone/topics/detail/generic-start';
    attachSource(db, { eventId: id, url: sourceUrl, kind: 'topic' });
    applyField(db, id, 'start', { status: 'ok', value: '2026-10-20T12:00:00.000Z' }, sourceUrl);
    applyField(db, id, 'end', { status: 'unsicher', reason: 'No end date in announcement.' }, sourceUrl);
    const event = getOpenEvents(db, NOW).find((candidate) => candidate.id === id)!;
    const updated = getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)!;
    const embed = buildEventEmbed(updated, [`https://de.finalfantasyxiv.com/lodestone/special/generic-start/`], NOW);

    assert.equal(embed.description, 'Ende: siehe Lodestone');
    assert.deepEqual(embed.fields?.[0], { name: 'Beginn', value: '<t:1792497600:f>', inline: true });
  } finally {
    db.close();
  }
});

test('uncertain events without a verified title omit the embed title', () => {
  const db = openDb(':memory:');
  try {
    const id = createEvent(db, {
      eventKey: 'seasonal-special:/lodestone/special/opaque123/',
      eventType: 'seasonal-special',
      title: 'opaque123',
    });
    const sourceUrl = 'https://de.finalfantasyxiv.com/lodestone/special/opaque123/';
    attachSource(db, { eventId: id, url: sourceUrl, kind: 'special' });
    applyField(db, id, 'title', { status: 'unsicher', reason: 'No Lodestone title.' }, sourceUrl);
    applyField(db, id, 'start', { status: 'ok', value: '2026-10-16T08:00:00.000Z' }, sourceUrl);
    applyField(db, id, 'end', { status: 'ok', value: '2026-10-20T12:00:00.000Z' }, sourceUrl);
    const event = getOpenEvents(db, NOW).find((candidate) => candidate.id === id)!;

    assert.equal(buildEventEmbed(event, [sourceUrl], NOW).title, undefined);
  } finally {
    db.close();
  }
});

test('unverified fallback titles never appear in scheduled events or the live status post', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  upsertGuildSetup(db, { guildId: 'guild', eventChannelId: 'events', logChannelId: 'logs' });
  try {
    const id = createEvent(db, {
      eventKey: 'seasonal-special:/lodestone/special/opaque123/',
      eventType: 'seasonal-special',
      title: 'opaque123',
    });
    const sourceUrl = 'https://de.finalfantasyxiv.com/lodestone/special/opaque123/';
    attachSource(db, { eventId: id, url: sourceUrl, kind: 'special' });
    applyField(db, id, 'title', { status: 'unsicher', reason: 'No verified title.' }, sourceUrl);
    applyField(db, id, 'start', { status: 'ok', value: '2026-10-15T08:00:00.000Z' }, sourceUrl);
    applyField(db, id, 'end', { status: 'ok', value: '2026-10-20T12:00:00.000Z' }, sourceUrl);
    const event = getOpenEvents(db, NOW).find((candidate) => candidate.id === id)!;
    await syncScheduledWithCard({ event, sourceUrls: [sourceUrl], guildId: 'guild', discord, store: db, now: NOW });
    await syncLiveStatusPost({ guildId: 'guild', channelId: 'events', events: [event], discord, store: db, now: NOW });

    assert.equal(discord.scheduledEvents[0]?.name, 'FFXIV-Event');
    const status = discord.messages.find((message) => message.embeds.some((embed) => embed.title === 'Läuft gerade'));
    const statusDescription = status?.embeds[0]?.description ?? '';
    assert.match(statusDescription, /FFXIV-Event/);
    assert.doesNotMatch(statusDescription, /^• \[\*\*opaque123\*\*\]/m);
  } finally {
    db.close();
  }
});

test('scheduled event location stays short when the Lodestone URL is longer than one hundred characters', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const event = seedEvent(db, 'long', 'Lange Quelle');
    const longUrl = `https://de.finalfantasyxiv.com/lodestone/special/${'very-long-event-name/'.repeat(6)}`;
    await syncScheduledWithCard({ event, sourceUrls: [longUrl], guildId: 'guild', discord, store: db, now: NOW });
    const cardId = getGuildEventObject(db, 'guild', event.eventKey)?.messageId;
    assert.equal(discord.scheduledEvents[0]?.location, `https://discord.com/channels/guild/events/${cardId}`);
    assert.ok((discord.scheduledEvents[0]?.location.length ?? 101) <= 100);
    assert.equal(scheduledEventPayloadFor(event, [longUrl], NOW)?.location, 'Lodestone – Link in der Beschreibung');
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
    const messageId = getGuildEventObject(db, 'guild', event.eventKey)?.messageId;
    const oldScheduled = {
      id: 'old-scheduled', guildId: 'guild', name: event.title,
      startUtc: '2026-10-15T08:00:00.000Z', endUtc: '2026-10-16T10:00:00.000Z',
      location: sourceUrl, description: `Event-ID: ${event.id}\n${sourceUrl}`, status: 'COMPLETED' as const,
    };
    discord.scheduledEvents.push(oldScheduled);
    setGuildDiscordIds(db, 'guild', event.eventKey, { scheduledEventId: oldScheduled.id });
    applyField(db, event.id, 'end', { status: 'ok', value: '2026-10-20T14:59:00.000Z' }, sourceUrl, '2026-10-16T11:00:00.000Z');
    const extended = getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)!;

    await syncEventEmbed({ event: extended, sourceUrls: [sourceUrl], channelId: 'events', discord, store: db });
    await syncScheduledWithCard({ event: extended, sourceUrls: [sourceUrl], guildId: 'guild', discord, store: db, now: NOW });

    assert.equal(discord.createMessageCount, 1);
    assert.equal(discord.createScheduledCount, 1);
    assert.equal(getGuildEventObject(db, 'guild', event.eventKey)?.messageId, messageId);
    assert.equal(getGuildEventObject(db, 'guild', event.eventKey)?.scheduledEventId, 'scheduled-1');
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
    await syncScheduledWithCard({ event, sourceUrls: [sourceUrl], guildId: 'guild', discord, store: db, now: NOW });
    applyField(db, event.id, 'end', { status: 'ok', value: '2026-10-22T14:59:00.000Z' }, sourceUrl, '2026-10-16T11:00:00.000Z');
    const extended = getOpenEvents(db, NOW).find((candidate) => candidate.id === event.id)!;
    discord.failModifyScheduledAsCompleted = true;

    await syncScheduledWithCard({ event: extended, sourceUrls: [sourceUrl], guildId: 'guild', discord, store: db, now: NOW });

    assert.equal(discord.editScheduledCount, 1);
    assert.equal(discord.createScheduledCount, 2);
    assert.equal(discord.scheduledEvents[0]?.status, 'COMPLETED');
    assert.equal(discord.scheduledEvents[1]?.endUtc, '2026-10-22T14:59:00.000Z');
    assert.equal(getGuildEventObject(db, 'guild', event.eventKey)?.scheduledEventId, 'scheduled-2');
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
    await syncScheduledWithCard({ event, sourceUrls: sources, guildId: 'guild', discord, store: db, now: NOW });

    assert.equal(discord.createMessageCount, 1);
    assert.equal(discord.createScheduledCount, 1);
    assert.equal(getGuildEventObject(db, 'guild', event.eventKey)?.messageId, 'message-1');
    assert.equal(getGuildEventObject(db, 'guild', event.eventKey)?.scheduledEventId, 'scheduled-1');
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

