import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { SourceHealthMonitor } from '../src/health.ts';
import { getAllEvents, getOpenEvents, isSeen, markFirstRunDone, openDb, type Store } from '../src/store.ts';
import type {
  DiscordEmbed,
  DiscordMessagePayload,
  DiscordMessageSnapshot,
  DiscordPort,
  FetchText,
  ScheduledEventPayload,
  ScheduledEventSnapshot,
} from '../src/types.ts';
import { runCycle } from '../src/cycle.ts';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const fixture = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

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

  async createMessage(channelId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    this.createMessageCount += 1;
    const message = this.makeMessage(channelId, payload);
    this.messages.push(message);
    return message;
  }

  async editMessage(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    this.editMessageCount += 1;
    const index = this.messages.findIndex((message) => message.id === messageId && message.channelId === channelId);
    assert.notEqual(index, -1);
    const message = { ...this.messages[index]!, content: payload.content ?? '', embeds: discordEmbedSnapshots(payload.embeds) };
    this.messages[index] = message;
    return message;
  }

  async fetchRecentBotMessages(channelId: string, limit: number): Promise<DiscordMessageSnapshot[]> {
    return this.messages.filter((message) => message.authorIsBot && message.channelId === channelId).slice(-limit).reverse();
  }

  async createScheduledEvent(guildId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> {
    this.createScheduledCount += 1;
    const event: ScheduledEventSnapshot = {
      ...payload,
      id: `scheduled-${this.createScheduledCount}`,
      guildId,
      status: 'SCHEDULED',
    };
    this.scheduledEvents.push(event);
    return event;
  }

  async editScheduledEvent(guildId: string, eventId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> {
    this.editScheduledCount += 1;
    const index = this.scheduledEvents.findIndex((event) => event.guildId === guildId && event.id === eventId);
    assert.notEqual(index, -1);
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

  private makeMessage(channelId: string, payload: DiscordMessagePayload): DiscordMessageSnapshot {
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

function fixtureFetcher(): FetchText {
  const classify = JSON.parse(fixture('./fixtures/expected/classify.json')) as {
    topicsP1: Array<{ url: string; fixture: string }>;
  };
  const topicPages = new Map(classify.topicsP1.map((entry) => [entry.url, entry.fixture]));
  topicPages.set('/lodestone/topics/detail/c026fd2ed62da67c1c329e3b3cf0b56e8778fe6e', 'topics/ll93-topic-a.html');
  topicPages.set('/lodestone/topics/detail/033b8797fd77a4f114a5ae3e0b9b3e1dab43ab53', 'topics/ll93-topic-b.html');

  const shortTargets: Record<string, string> = {
    '/oZP2Y': 'https://de.finalfantasyxiv.com/lodestone/special/2026/All_Saints_Wake/tfrx2rkv52',
    '/AH3Ln': 'https://de.finalfantasyxiv.com/lodestone/special/2026/All_Saints_Wake/tfrx2rkv52',
    '/yZDu7': 'https://de.finalfantasyxiv.com/lodestone/special/fallguys/',
    '/sl1ML': 'https://de.finalfantasyxiv.com/lodestone/special/ffxv/8ghatq7szp/',
    '/YQ1Zf': 'https://de.finalfantasyxiv.com/lodestone/special/tales_under_the_golden_sun/sidestory_8/',
    '/2PT09': 'https://de.finalfantasyxiv.com/lodestone/special/tales_under_the_golden_sun/sidestory_7/',
  };
  const maintenance = JSON.parse(fixture('./fixtures/expected/maintenance-pair.json')) as {
    original: { url: string; fixture: string };
    followup: { url: string; fixture: string };
    mogstationIgnored: { fixture: string };
  };
  const maintenancePages = new Map([
    [maintenance.original.url, maintenance.original.fixture],
    [maintenance.followup.url, maintenance.followup.fixture],
    ['/lodestone/news/detail/5d1809b76f6c2577fb2c64939438e6c15ce79eac', maintenance.mogstationIgnored.fixture],
  ]);

  return async (requestedUrl) => {
    const url = new URL(requestedUrl);
    const pathname = url.pathname;
    if (url.hostname === 'sqex.to') {
      const target = shortTargets[pathname];
      return {
        status: 200,
        body: '',
        finalUrl: target ?? 'https://external.example.test/resolved',
      };
    }
    if (pathname === '/lodestone/topics/') {
      const page = url.searchParams.get('page') ?? '1';
      const pages: Record<string, string> = {
        '1': 'lists/topics-p1.html', '2': 'lists/topics-p2.html', '3': 'lists/topics-p3.html',
      };
      return { status: 200, body: fixture(`./fixtures/${pages[page] ?? pages['1']}`), finalUrl: requestedUrl };
    }
    if (pathname === '/lodestone/news/category/2') {
      const page = url.searchParams.get('page') ?? '1';
      const pages: Record<string, string> = {
        '1': 'lists/maintenance-p1.html', '2': 'lists/maintenance-p2.html', '3': 'lists/maintenance-p3.html',
      };
      return { status: 200, body: fixture(`./fixtures/${pages[page] ?? pages['1']}`), finalUrl: requestedUrl };
    }
    if (pathname === '/lodestone/news/news.xml') {
      return { status: 200, body: fixture('./fixtures/lists/news.xml'), finalUrl: requestedUrl };
    }
    if (pathname.endsWith('/Seasonal_Events')) {
      return { status: 200, body: fixture('./fixtures/wiki/seasonal-events.html'), finalUrl: requestedUrl };
    }
    if (pathname.endsWith('/Moogle_Treasure_Trove_Events')) {
      return { status: 200, body: fixture('./fixtures/wiki/moogle-treasure-trove.html'), finalUrl: requestedUrl };
    }
    if (pathname.includes('/playguide/db/item/')) {
      const id = pathname.match(/\/item\/([^/]+)\//)?.[1];
      if (!id) return { status: 404, body: '', finalUrl: requestedUrl };
      try {
        const compressed = readFileSync(fileURLToPath(new URL(`./fixtures/items/${id}.html.gz`, import.meta.url)));
        return { status: 200, body: gunzipSync(compressed).toString('utf8'), finalUrl: requestedUrl };
      } catch {
        return { status: 404, body: '', finalUrl: requestedUrl };
      }
    }
    if (pathname.startsWith('/lodestone/special/')) {
      const specialPages: Array<[string, string]> = [
        ['/lodestone/special/2026/All_Saints_Wake/tfrx2rkv52', 'special/all-saints-wake-2026.html'],
        ['/lodestone/special/fallguys/', 'special/fallguys.html'],
        ['/lodestone/special/mogmog-collection/202609/lsekubsk45', 'special/mogmog-202609.html'],
        ['/lodestone/special/friend_recruit/', 'special/friend-recruit.html'],
        ['/lodestone/special/ffxiv/8ghatq7szp/', 'special/fankit.html'],
        ['/lodestone/special/tales_under_the_golden_sun/sidestory_8/', 'special/update-log.html'],
        ['/lodestone/special/tales_under_the_golden_sun/sidestory_7/', 'special/patchnote-log.html'],
      ];
      const found = specialPages.find(([path]) => pathname.startsWith(path));
      return found
        ? { status: 200, body: fixture(`./fixtures/${found[1]}`), finalUrl: requestedUrl }
        : { status: 404, body: '', finalUrl: requestedUrl };
    }
    if (pathname.startsWith('/lodestone/topics/detail/')) {
      const path = topicPages.get(pathname);
      return path ? { status: 200, body: fixture(`./fixtures/${path}`), finalUrl: requestedUrl }
        : { status: 404, body: '', finalUrl: requestedUrl };
    }
    if (pathname.startsWith('/lodestone/news/detail/')) {
      const path = maintenancePages.get(pathname);
      return path ? { status: 200, body: fixture(`./fixtures/${path}`), finalUrl: requestedUrl }
        : { status: 404, body: '', finalUrl: requestedUrl };
    }
    return { status: 404, body: '', finalUrl: requestedUrl };
  };
}

function eventEmbeds(discord: FakeDiscordPort): Array<{ eventId: string; embed: DiscordEmbed }> {
  return discord.messages.flatMap((message) => message.embeds
    .filter((embed) => embed.footer?.text !== undefined && embed.title !== 'Läuft gerade')
    .map((embed) => ({ eventId: embed.footer!.text, embed })));
}

function cycleOptions(store: Store, discord: FakeDiscordPort, health = new SourceHealthMonitor(store)) {
  return {
    store,
    discord,
    fetchText: fixtureFetcher(),
    guildId: 'guild',
    eventChannelId: 'events',
    logChannelId: 'logs',
    now: () => new Date(NOW),
    health,
  };
}

test('first-run replay of live list fixtures posts only All Saints, Fall Guys, and Mog Mog and logs the summary', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  try {
    const result = await runCycle(cycleOptions(db, discord));
    const posted = eventEmbeds(discord);
    const status = discord.messages.find((message) => message.embeds.some((embed) => embed.title === 'Läuft gerade'));

    assert.equal(result.firstRun, true);
    assert.equal(posted.length, 3);
    const postedTitles = getAllEvents(db)
      .filter((event) => event.discordMessageId !== null)
      .map((event) => event.title);
    assert.equal(postedTitles.length, 3);
    assert.ok(postedTitles.some((title) => title.includes('Allerschutzheiligen')));
    assert.ok(postedTitles.some((title) => title.includes('Fall Guys')));
    assert.ok(postedTitles.some((title) => title.includes('Mog Mog-Kollektion')));
    assert.equal(discord.createScheduledCount, 3);
    assert.equal(discord.pinCount, 1);
    assert.ok(status?.pinned);
    assert.match(status?.embeds.find((embed) => embed.title === 'Läuft gerade')?.description ?? '', /Allerschutzheiligen/);
    assert.match(status?.embeds.find((embed) => embed.title === 'Läuft gerade')?.description ?? '', /Fall Guys/);
    assert.match(status?.embeds.find((embed) => embed.title === 'Läuft gerade')?.description ?? '', /Mog Mog-Kollektion/);
    assert.ok(discord.logs.some((message) => /^Erststart: \d+ erfasst, 3 gepostet$/.test(message)));
    assert.equal(discord.logs.some((message) => message.includes("All Saints' Wake") && message.includes('Wiki')), false);
    assert.ok(discord.logs.some((message) => message.includes('Unsicheres Feld')));
    assert.deepEqual(getOpenEvents(db, NOW).filter((event) => event.discordMessageId !== null).length, 3);
  } finally {
    db.close();
  }
});

test('ten repeated cycles and a database restart create and edit nothing after initial synchronization', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-cycle-'));
  const dbPath = join(directory, 'events.sqlite');
  const discord = new FakeDiscordPort();
  try {
    let db = openDb(dbPath);
    const health = new SourceHealthMonitor(db);
    const options = cycleOptions(db, discord, health);
    await runCycle(options);
    const createdMessages = discord.createMessageCount;
    const createdSchedules = discord.createScheduledCount;
    const edits = discord.editMessageCount + discord.editScheduledCount;

    const counts: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      await runCycle(options);
      counts.push(discord.createMessageCount);
    }
    db.close();
    db = openDb(dbPath);
    await runCycle(cycleOptions(db, discord, new SourceHealthMonitor(db)));

    assert.equal(discord.createMessageCount, createdMessages, JSON.stringify({ counts, events: getAllEvents(db).map((event) => ({ id: event.id, key: event.eventKey, message: event.discordMessageId, title: event.title })) }));
    assert.equal(discord.createScheduledCount, createdSchedules);
    assert.equal(discord.editMessageCount + discord.editScheduledCount, edits);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('blind source state suppresses event and scheduled-event creates', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  const health = new SourceHealthMonitor(db);
  health.recordCycleHealth([2, 2], true, NOW);
  discord.messages.push({
    id: 'status-existing',
    channelId: 'events',
    authorIsBot: true,
    pinned: true,
    content: '',
    embeds: [{ title: 'Läuft gerade', description: 'Gerade läuft kein Event.' }],
  });
  try {
    await runCycle({
      ...cycleOptions(db, discord, health),
      fetchText: async (url) => {
        const response = await fixtureFetcher()(url, { priority: 'list' });
        if (new URL(url).pathname === '/lodestone/topics/') return { ...response, body: '<html><body></body></html>' };
        return response;
      },
    });
    assert.equal(eventEmbeds(discord).length, 0);
    assert.equal(discord.createMessageCount, 0);
    assert.equal(discord.editMessageCount, 0);
    assert.equal(discord.createScheduledCount, 0);
    assert.ok(discord.logs.some((message) => message.includes('Lodestone nicht lesbar')));
  } finally {
    db.close();
  }
});

test('a restart while blind sends no duplicate warning and one recovery Entwarnung', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-blind-'));
  const dbPath = join(directory, 'events.sqlite');
  const discord = new FakeDiscordPort();
  let db = openDb(dbPath);
  const fixtureFetch = fixtureFetcher();
  const emptyTopics: FetchText = async (url, options) => {
    if (new URL(url).pathname === '/lodestone/topics/') {
      return { status: 200, body: '<html><body></body></html>', finalUrl: url };
    }
    return fixtureFetch(url, options);
  };
  try {
    await runCycle({ ...cycleOptions(db, discord), fetchText: emptyTopics });
    db.close();

    db = openDb(dbPath);
    await runCycle({ ...cycleOptions(db, discord, new SourceHealthMonitor(db)), fetchText: emptyTopics });
    assert.equal(discord.logs.filter((message) => message.includes('Lodestone nicht lesbar')).length, 1);

    await runCycle({ ...cycleOptions(db, discord, new SourceHealthMonitor(db)), fetchText: fixtureFetch });
    assert.equal(discord.logs.filter((message) => message.includes('Lodestone nicht lesbar')).length, 1);
    assert.equal(discord.logs.filter((message) => message.includes('Entwarnung: Lodestone ist wieder lesbar.')).length, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unresolved sqex.to topic stays unseen and is retried successfully next cycle', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  let rejectShortLink = true;
  const baseFetch = fixtureFetcher();
  const fetchText: FetchText = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'sqex.to' && parsed.pathname === '/yZDu7' && rejectShortLink) {
      throw new Error('temporary redirect failure');
    }
    return baseFetch(url, options);
  };
  const topicUrl = 'https://de.finalfantasyxiv.com/lodestone/topics/detail/67df2c10d0b7467e5a006dbadd025c629dbfe8bc';

  try {
    const options = { ...cycleOptions(db, discord), fetchText };
    await runCycle(options);
    assert.equal(isSeen(db, topicUrl), false);
    assert.equal(discord.logs.filter((message) => message.includes('short link unresolved')).length, 1);

    rejectShortLink = false;
    await runCycle(options);
    assert.equal(isSeen(db, topicUrl), true);
    assert.equal(discord.logs.filter((message) => message.includes('short link unresolved')).length, 1);
    assert.equal(getAllEvents(db).filter((event) => event.eventKey === 'seasonal-special:/lodestone/special/fallguys/').length, 1);
  } finally {
    db.close();
  }
});

