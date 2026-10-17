import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { load } from 'cheerio';
import test from 'node:test';
import { createCoalescedCycleRunner, createLoggedCycleRunner, createSetupSyncRunner } from '../src/main.ts';
import { captureLog } from './log-capture.ts';
import { SourceHealthMonitor } from '../src/health.ts';
import { applyField, attachSource, createEvent, deleteGuild, getAllEvents, getEventSources, getGuild, getGuildEventObject, getMetaValue, getOpenEvents, isFirstRun, isSeen, markFirstRunDone, markGuildFirstRunDone, openDb, setMetaValue, upsertGuildSetup, type Store } from '../src/store.ts';
import type {
  DiscordEmbed,
  DiscordMessagePayload,
  DiscordMessageSnapshot,
  DiscordPort,
  DiscordThreadSnapshot,
  FetchText,
  ScheduledEventPayload,
  ScheduledEventSnapshot,
} from '../src/types.ts';
import { runCycle, runGuildSyncFromStoredData } from '../src/cycle.ts';
import { runDryRunCycle } from '../src/dry-run.ts';
import { stableEventIdentity } from '../src/event-identity.ts';
import { formatLogContent } from '../src/log-format.ts';
import { assertDiscordActionRows } from './component-invariants.ts';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const fixture = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

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
  failScheduledNameOnce: string | undefined;
  readonly logChannels: Array<{ channelId: string; content: string }> = [];

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
    const old = this.messages[index]!;
    const message = {
      ...old,
      content: payload.content ?? '',
      embeds: discordEmbedSnapshots(payload.embeds),
      components: payload.components === undefined ? old.components : componentSnapshots(payload.components),
    };
    this.messages[index] = message;
    return message;
  }

  async fetchRecentBotMessages(channelId: string, limit: number) {
    return { messages: this.messages.filter((message) => message.channelId === channelId).slice().reverse()
      .filter((message) => message.authorIsBot).slice(0, limit), complete: true };
  }

  async fetchPinnedBotMessages(channelId: string): Promise<DiscordMessageSnapshot[]> {
    return this.messages.filter((message) => message.authorIsBot && message.channelId === channelId && message.pinned);
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
    return this.makeMessage(threadId, payload);
  }

  async createScheduledEvent(guildId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> {
    if (payload.name === this.failScheduledNameOnce) {
      this.failScheduledNameOnce = undefined;
      throw new Error(`simulated scheduled-event failure for ${payload.name}`);
    }
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

  async sendLog(channelId: string, content: string): Promise<void> {
    const formatted = formatLogContent(content);
    this.logs.push(formatted);
    this.logChannels.push({ channelId, content: formatted });
  }

  private makeMessage(channelId: string, payload: DiscordMessagePayload): DiscordMessageSnapshot {
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
        ['/lodestone/special/ffxv/8ghatq7szp/', 'special/ffxv-2026.html'],
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
    .filter((embed) => embed.url !== undefined && embed.title !== 'Läuft gerade')
    .map((embed) => ({ eventId: new URL(embed.url!).hash.slice(1), embed })));
}

function cycleOptions(store: Store, discord: FakeDiscordPort, health = new SourceHealthMonitor(store)) {
  const firstRun = isFirstRun(store);
  upsertGuildSetup(store, { guildId: 'guild', eventChannelId: 'events', logChannelId: 'logs' });
  if (!firstRun) markGuildFirstRunDone(store, 'guild');
  return {
    store,
    discord,
    fetchText: fixtureFetcher(),
    guilds: [{ guildId: 'guild', eventChannelId: 'events', logChannelId: 'logs', firstRun }],
    now: () => new Date(NOW),
    health,
  };
}

type FetchResult = Awaited<ReturnType<FetchText>>;

function topicListHtml(entries: Array<{ title: string; url: string }>, bannerUrls: string[] = []): string {
  const list = entries.map(({ title, url }) =>
    `<li class="news__list--topics"><header class="news__list--header"><p class="news__list--title"><a href="${url}">${title}</a></p></header></li>`,
  ).join('');
  const banners = bannerUrls.map((url) => `<div class="mb10"><a href="${url}">Banner</a></div>`).join('');
  return `<html><body><ul>${list}</ul><div class="ldst__side">${banners}</div></body></html>`;
}

function maintenanceListHtml(entries: Array<{
  tag: 'Wartung' | 'Folge-News';
  title: string;
  url: string;
  publishedEpoch?: number;
}>): string {
  const list = entries.map(({ tag, title, url, publishedEpoch }) =>
    `<li class="news__list"><a class="news__list--link" href="${url}"><p class="news__list--title"><span class="news__list--tag">[${tag}]</span>${title}</p></a>${publishedEpoch === undefined ? '' : `<time><span data-epoch="${publishedEpoch}"></span></time>`}</li>`,
  ).join('');
  return `<html><body><ul>${list}</ul></body></html>`;
}

function controlledFetcher(options: {
  topicList?: string;
  maintenanceList?: string;
  feedBody?: string;
  intercept?: (url: string, fetchOptions: { priority: 'list' | 'detail' | 'item' | 'wiki' }) => Promise<FetchResult | undefined>;
}): FetchText {
  const base = fixtureFetcher();
  return async (url, fetchOptions) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/lodestone/topics/' && parsed.searchParams.get('page') === null && options.topicList !== undefined) {
      return { status: 200, body: options.topicList, finalUrl: url };
    }
    if (parsed.pathname === '/lodestone/news/category/2' && parsed.searchParams.get('page') === null && options.maintenanceList !== undefined) {
      return { status: 200, body: options.maintenanceList, finalUrl: url };
    }
    if (parsed.pathname === '/lodestone/news/news.xml' && options.feedBody !== undefined) {
      return { status: 200, body: options.feedBody, finalUrl: url };
    }
    const intercepted = await options.intercept?.(url, fetchOptions);
    return intercepted ?? base(url, fetchOptions);
  };
}

test('FFXV period from the topic supplies the seasonal event when its special page has no period', async () => {
  const topicUrl = '/lodestone/topics/detail/0f1a2726a316f0bce54721fa018a68802564efaa';
  const specialUrl = '/lodestone/special/ffxv/8ghatq7szp/';
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Das Kollaborations-Event „FINAL FANTASY XIV & FINAL FANTASY XV“ kehrt zurück!', url: topicUrl }]),
    maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
  });

  for (const [now, isUpcoming] of [
    ['2026-10-01T12:00:00.000Z', true],
    ['2026-10-16T12:00:00.000Z', false],
  ] as const) {
    const db = openDb(':memory:');
    const discord = new FakeDiscordPort();
    markFirstRunDone(db);
    setMetaValue(db, 'wiki_checked_utc_day', now.slice(0, 10));
    try {
      await runCycle({ ...cycleOptions(db, discord), fetchText, now: () => new Date(now) });
      const event = getAllEvents(db).find((candidate) => candidate.eventType === 'seasonal-special');

      assert.ok(event, 'the linked FFXV special is classified as seasonal');
      assert.equal(event.startUtc, '2026-09-24T08:00:00Z');
      assert.equal(event.endUtc, '2026-10-13T14:59:00Z');
      assert.equal(event.endStatus, 'ok');
      assert.equal(event.rewardsStatus, 'unsicher', 'missing item-page fixtures leave names unresolved');
      assert.equal(getEventSources(db, event.id).some((source) => source.url === `https://de.finalfantasyxiv.com${specialUrl}`), true);
      const periodProvenance = db.prepare(`
        SELECT field, source_url AS sourceUrl
        FROM field_provenance
        WHERE event_id = ? AND field IN ('start', 'end')
        ORDER BY field
      `).all(event.id) as Array<{ field: string; sourceUrl: string }>;
      assert.deepEqual(periodProvenance.map(({ field, sourceUrl }) => ({ field, sourceUrl })), [
        { field: 'end', sourceUrl: `https://de.finalfantasyxiv.com${topicUrl}` },
        { field: 'start', sourceUrl: `https://de.finalfantasyxiv.com${topicUrl}` },
      ]);
      assert.equal(getGuildEventObject(db, 'guild', event.eventKey)?.messageId !== null && getGuildEventObject(db, 'guild', event.eventKey)?.messageId !== undefined, isUpcoming);
      if (!isUpcoming) assert.equal(eventEmbeds(discord).length, 0);
    } finally {
      db.close();
    }
  }
});

test('a period-free special refresh preserves and refreshes the topic-owned period', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  const topicUrl = '/lodestone/topics/detail/0f1a2726a316f0bce54721fa018a68802564efaa';
  const specialUrl = '/lodestone/special/ffxv/8ghatq7szp/';
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'FINAL FANTASY XIV & FINAL FANTASY XV', url: '/lodestone/topics/detail/filler' }]),
    maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => new URL(url).pathname === '/lodestone/topics/detail/filler'
      ? { status: 200, body: '<article class="news__detail"><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: url }
      : undefined,
  });
  try {
    const originalLists = controlledFetcher({
      topicList: topicListHtml([{ title: 'Das Kollaborations-Event „FINAL FANTASY XIV & FINAL FANTASY XV“ kehrt zurück!', url: topicUrl }]),
      maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
      feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    });
    await runCycle({ ...cycleOptions(db, discord), fetchText: originalLists });
    const before = getAllEvents(db).find((candidate) => candidate.eventType === 'seasonal-special')!;
    assert.equal(before.endStatus, 'ok');
    assert.equal(before.endUtc, '2026-10-13T14:59:00Z');

    await runCycle({ ...cycleOptions(db, discord), fetchText, now: () => new Date('2026-10-16T13:00:00.000Z') });
    const after = getAllEvents(db).find((candidate) => candidate.id === before.id)!;
    assert.equal(after.endStatus, 'ok');
    assert.equal(after.endUtc, before.endUtc);
    const owner = db.prepare("SELECT source_url AS sourceUrl FROM field_provenance WHERE event_id = ? AND field = 'end'")
      .get(before.id) as { sourceUrl: string };
    assert.equal(owner.sourceUrl, `https://de.finalfantasyxiv.com${topicUrl}`);
  } finally {
    db.close();
  }
});

test('ignored banner log uses the page title instead of an empty title', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  setMetaValue(db, 'wiki_checked_utc_day', NOW.toISOString().slice(0, 10));
  const bannerUrl = '/lodestone/special/friend_recruit/';
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Die Fall Guys-Kollaboration kehrt am 7. Oktober zurück!', url: '/lodestone/topics/detail/67df2c10d0b7467e5a006dbadd025c629dbfe8bc' }], [bannerUrl]),
    maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
  });

  try {
    await runCycle({ ...cycleOptions(db, discord), fetchText });
    assert.ok(discord.logs.includes(
      'Nicht berücksichtigt: Lade einen Freund ein (<https://de.finalfantasyxiv.com/lodestone/special/friend_recruit/>) — Auf der Sonderseite steht kein Zeitraum.',
    ));
    assert.ok(discord.logs.every((message) => !message.includes('Nicht berücksichtigt:  (')));
  } finally {
    db.close();
  }
});

test('first shared crawl runs and stores events with no configured guilds', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  const calls: string[] = [];
  const baseFetch = fixtureFetcher();
  const fetchText: FetchText = async (url, options) => {
    calls.push(url);
    return baseFetch(url, options);
  };
  try {
    const result = await runCycle({ store: db, discord, fetchText, guilds: [], now: () => new Date(NOW) });

    assert.equal(result.firstRun, true);
    assert.ok(calls.some((url) => new URL(url).pathname === '/lodestone/topics/' && new URL(url).searchParams.get('page') === '3'));
    assert.ok(calls.some((url) => new URL(url).pathname === '/lodestone/news/category/2' && new URL(url).searchParams.get('page') === '3'));
    assert.ok(getAllEvents(db).some((event) => event.title.includes('Allerschutzheiligen')));
    assert.equal(result.postedEvents, 0);
    assert.equal(discord.createMessageCount, 0);
    assert.equal(isFirstRun(db), false);
  } finally {
    db.close();
  }
});

test('setup before the first shared crawl finishes awaits the coalesced crawl and posts once', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  const baseFetch = fixtureFetcher();
  let enteredFirstList!: () => void;
  let releaseFirstList!: () => void;
  const firstListEntered = new Promise<void>((resolve) => { enteredFirstList = resolve; });
  const firstListGate = new Promise<void>((resolve) => { releaseFirstList = resolve; });
  let paused = false;
  let globalCycleRuns = 0;
  const fetchCalls: string[] = [];
  const fetchText: FetchText = async (url, options) => {
    fetchCalls.push(url);
    if (!paused && options.priority === 'list') {
      paused = true;
      enteredFirstList();
      await firstListGate;
    }
    return baseFetch(url, options);
  };
  try {
    const { createSetupSyncRunner } = await import('../src/main.ts');
    assert.equal(typeof createSetupSyncRunner, 'function');
    const runGlobalCycle = createCoalescedCycleRunner(async () => {
      globalCycleRuns += 1;
      return runCycle({ store: db, discord, fetchText, guilds: [], now: () => new Date(NOW) });
    });
    const activeCycle = runGlobalCycle();
    await firstListEntered;

    upsertGuildSetup(db, { guildId: 'guild', eventChannelId: 'events', logChannelId: 'logs' });
    const runSetupSync = createSetupSyncRunner(db, runGlobalCycle, (guildId) =>
      runGuildSyncFromStoredData({ store: db, discord, fetchText, now: () => new Date(NOW) }, guildId));
    const setupSync = runSetupSync('guild');
    releaseFirstList();
    await Promise.all([activeCycle, setupSync]);

    assert.equal(globalCycleRuns, 1);
    assert.equal(fetchCalls.filter((url) => new URL(url).pathname === '/lodestone/topics/' && new URL(url).searchParams.get('page') === null).length, 1);
    assert.equal(eventEmbeds(discord).length, 3);
    assert.equal(discord.createMessageCount, 4, 'three event cards and one live-status post are created once');
    assert.equal(discord.createScheduledCount, 3);
  } finally {
    db.close();
  }
});

test('setup before any shared crawl starts it and avoids a second guild sync', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  let globalCycleRuns = 0;
  let storedGuildSyncs = 0;
  upsertGuildSetup(db, { guildId: 'guild', eventChannelId: 'events', logChannelId: 'logs' });
  const runGlobalCycle = createCoalescedCycleRunner(async () => {
    globalCycleRuns += 1;
    return runCycle({ store: db, discord, fetchText: fixtureFetcher(), now: () => new Date(NOW) });
  });
  const runSetupSync = createSetupSyncRunner(db, runGlobalCycle, async () => { storedGuildSyncs += 1; });
  try {
    await runSetupSync('guild');

    assert.equal(globalCycleRuns, 1);
    assert.equal(storedGuildSyncs, 0, 'the coalesced cycle already synchronized the new guild');
    assert.equal(eventEmbeds(discord).length, 3);
    assert.equal(discord.createMessageCount, 4);
    assert.equal(discord.createScheduledCount, 3);
  } finally {
    db.close();
  }
});

test('stale maintenance entries are classified and seen without fetching their detail page', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  const url = 'https://de.finalfantasyxiv.com/lodestone/news/detail/stale-june-maintenance';
  let detailRequests = 0;
  markFirstRunDone(db);
  setMetaValue(db, 'wiki_checked_utc_day', '2026-06-03');
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Nicht klassifizierbare Nachricht', url: '/lodestone/topics/detail/stale-maintenance-health' }]),
    maintenanceList: maintenanceListHtml([{
      tag: 'Wartung', title: 'Wartung aller Welten (2. Jun.)', url,
      publishedEpoch: Math.floor(Date.parse('2025-06-01T12:00:00.000Z') / 1_000),
    }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (requestedUrl) => {
      if (new URL(requestedUrl).pathname === '/lodestone/topics/detail/stale-maintenance-health') {
        return { status: 200, body: '<article class="news__detail"><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: requestedUrl };
      }
      if (new URL(requestedUrl).pathname !== new URL(url).pathname) return undefined;
      detailRequests += 1;
      return { status: 200, body: '<html></html>', finalUrl: requestedUrl };
    },
  });
  try {
    await runCycle({ ...cycleOptions(db, discord), fetchText, now: () => new Date('2026-06-03T12:00:00.000Z') });

    assert.equal(detailRequests, 0);
    assert.equal(isSeen(db, url), true);
    assert.equal(getAllEvents(db).filter((event) => event.eventType === 'maintenance').length, 0);
  } finally {
    db.close();
  }
});

test('a stale maintenance entry is still fetched when it matches an open maintenance event', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  const url = 'https://de.finalfantasyxiv.com/lodestone/news/detail/open-june-maintenance';
  const eventId = createEvent(db, {
    eventKey: 'maintenance:all-worlds:Wartung aller Welten (2. Jun.)',
    eventType: 'maintenance',
    title: 'Wartung aller Welten (2. Jun.)',
  });
  attachSource(db, { eventId, url, kind: 'maintenance' });
  applyField(db, eventId, 'end', { status: 'ok', value: '2026-06-06T09:00:00Z' }, url);
  markFirstRunDone(db);
  setMetaValue(db, 'wiki_checked_utc_day', '2026-06-05');
  let detailRequests = 0;
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Nicht klassifizierbare Nachricht', url: '/lodestone/topics/detail/open-maintenance-health' }]),
    maintenanceList: maintenanceListHtml([{
      tag: 'Wartung', title: 'Wartung aller Welten (2. Jun.)', url,
      publishedEpoch: Math.floor(Date.parse('2026-06-02T12:00:00.000Z') / 1_000),
    }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (requestedUrl) => {
      if (new URL(requestedUrl).pathname === '/lodestone/topics/detail/open-maintenance-health') {
        return { status: 200, body: '<article class="news__detail"><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: requestedUrl };
      }
      if (new URL(requestedUrl).pathname !== new URL(url).pathname) return undefined;
      detailRequests += 1;
      return {
        status: 200,
        body: '<article class="news__detail"><header class="news__header"><h1>Wartung aller Welten</h1></header><div class="news__detail__wrapper">[Datum &amp; Uhrzeit] Von Dienstag, den 2. Juni 2026 um 10:00 Uhr bis Dienstag, den 2. Juni 2026 um 11:00 Uhr</div></article>',
        finalUrl: requestedUrl,
      };
    },
  });
  try {
    await runCycle({ ...cycleOptions(db, discord), fetchText, now: () => new Date('2026-06-05T12:00:00.000Z') });
    assert.equal(detailRequests, 1);
    assert.equal(getAllEvents(db).find((event) => event.id === eventId)?.endUtc, '2026-06-06T09:00:00Z');
  } finally {
    db.close();
  }
});

test('first-run replay of live list fixtures posts only All Saints, Fall Guys, and Mog Mog and logs the summary', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  const fetchCalls: string[] = [];
  const baseFetch = fixtureFetcher();
  const fetchText: FetchText = async (url, options) => {
    fetchCalls.push(url);
    return baseFetch(url, options);
  };
  try {
    const result = await runCycle({ ...cycleOptions(db, discord), fetchText });
    const posted = eventEmbeds(discord);
    const status = discord.messages.find((message) => message.embeds.some((embed) => embed.title === 'Läuft gerade'));

    assert.equal(result.firstRun, true);
    assert.ok(fetchCalls.length <= 160, `expected at most 160 first-run requests, got ${fetchCalls.length}`);
    assert.equal(fetchCalls.length, result.requests);
    assert.equal(new Set(fetchCalls).size, fetchCalls.length, 'each fixture URL is fetched at most once in a cycle');
    assert.ok(result.duplicatesAvoided > 0);
    assert.equal(fetchCalls.filter((url) => new URL(url).pathname.startsWith('/lodestone/news/detail/')).length, 0,
      'past maintenance entries from the three-page fixture replay need no detail requests');
    assert.equal(posted.length, 3);
    const postedTitles = getAllEvents(db)
      .filter((event) => getGuildEventObject(db, 'guild', event.eventKey)?.messageId !== null && getGuildEventObject(db, 'guild', event.eventKey)?.messageId !== undefined)
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
    assert.deepEqual(discord.logs, [
      'Unsicheres Feld „Belohnungen“ bei „Kollabo-Event: FINAL FANTASY XIV x Fall Guys“: Gegenstand bbf686f52b7: Die Gegenstandsseite antwortete mit Status 404.',
      'Erststart: 8 erfasst, 3 gepostet, 14 unklassifiziert, 37 ignoriert',
    ]);
    assert.deepEqual(getOpenEvents(db, NOW).filter((event) => getGuildEventObject(db, 'guild', event.eventKey)?.messageId).length, 3);

    discord.logs.length = 0;
    setMetaValue(db, 'wiki_checked_utc_day', NOW.toISOString().slice(0, 10));
    const newTopicUrl = '/lodestone/topics/detail/new-unclassified';
    const secondCycleFetch = controlledFetcher({
      topicList: topicListHtml([{ title: 'Neue Meldung ohne Eventbezug', url: newTopicUrl }]),
      maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
      feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
      intercept: async (url) => new URL(url).pathname === newTopicUrl
        ? { status: 200, body: '<article class="news__detail"><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: url }
        : undefined,
    });
    await runCycle({ ...cycleOptions(db, discord), fetchText: secondCycleFetch });
    assert.deepEqual(discord.logs, [
      `Neue Lodestone-News ohne Event:\n• [Neue Meldung ohne Eventbezug](<https://de.finalfantasyxiv.com${newTopicUrl}>)`,
    ]);
  } finally {
    db.close();
  }
});

test('a new guild gets a stored-data-only sync without another Lodestone crawl', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  upsertGuildSetup(db, { guildId: 'guild-a', eventChannelId: 'events-a', logChannelId: 'logs-a' });
  const fetchCalls: string[] = [];
  const baseFetch = fixtureFetcher();
  const fetchText: FetchText = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/lodestone/topics/' || parsed.pathname === '/lodestone/news/category/2' || parsed.pathname === '/lodestone/news/news.xml') {
      fetchCalls.push(`${parsed.pathname}${parsed.search}`);
    }
    return baseFetch(url, options);
  };
  try {
    await runCycle({ store: db, discord, fetchText, now: () => new Date(NOW) });
    const guildAMessages = discord.messages.filter((message) => message.channelId === 'events-a');
    assert.equal(guildAMessages.filter((message) => message.embeds.some((embed) => embed.title === 'Läuft gerade')).length, 1);

    upsertGuildSetup(db, { guildId: 'guild-b', eventChannelId: 'events-b', logChannelId: 'logs-b' });
    fetchCalls.length = 0;
    await runGuildSyncFromStoredData({ store: db, discord, fetchText, now: () => new Date(NOW) }, 'guild-b');

    const guildBMessages = discord.messages.filter((message) => message.channelId === 'events-b');
    assert.equal(guildAMessages.filter((message) => message.embeds.some((embed) => embed.title === 'Läuft gerade')).length, 1);
    assert.equal(guildBMessages.filter((message) => message.embeds.some((embed) => embed.title === 'Läuft gerade')).length, 1);
    assert.equal(guildBMessages.filter((message) => message.embeds.some((embed) => embed.footer?.text)).length, 3);
    assert.equal(discord.scheduledEvents.filter((event) => event.guildId === 'guild-a').length, 3);
    assert.equal(discord.scheduledEvents.filter((event) => event.guildId === 'guild-b').length, 3);
    assert.equal(fetchCalls.length, 0, 'setup sync must use the shared event data already in SQLite');
    assert.equal(discord.logChannels.some(({ channelId, content }) => channelId === 'logs-b' && content.startsWith('Erststart:')), false);
  } finally {
    db.close();
  }
});

test('one event sync failure is logged for its guild and later events still synchronize', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  const sourceUrls = [
    'https://de.finalfantasyxiv.com/lodestone/special/failing-event/',
    'https://de.finalfantasyxiv.com/lodestone/special/later-event/',
  ];
  for (const [index, title] of ['Fehlerhaftes Event', 'Späteres Event'].entries()) {
    const eventKey = `sync-isolation:${index}`;
    const id = createEvent(db, { eventKey, eventType: 'topic-generic', title });
    attachSource(db, { eventId: id, url: sourceUrls[index]!, kind: 'special' });
    applyField(db, id, 'start', { status: 'ok', value: '2026-10-16T10:00:00.000Z' }, sourceUrls[index]!);
    applyField(db, id, 'end', { status: 'ok', value: '2026-10-20T14:59:00.000Z' }, sourceUrls[index]!);
  }
  discord.failScheduledNameOnce = 'Fehlerhaftes Event';
  const captured = captureLog('info');
  const baseOptions = cycleOptions(db, discord);
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Unclassified filler', url: '/lodestone/topics/detail/filler' }]),
    maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => new URL(url).pathname === '/lodestone/topics/detail/filler'
      ? { status: 200, body: '<article class="news__detail"><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: url }
      : undefined,
  });
  try {
    await runCycle({ ...baseOptions, fetchText });
    assert.deepEqual(captured.messages().filter((line) => line.startsWith('FEHLER Abgleich fehlgeschlagen')),
      ['FEHLER Abgleich fehlgeschlagen: „Fehlerhaftes Event“ auf guild: simulated scheduled-event failure for Fehlerhaftes Event']);

    const eventTitles = eventEmbeds(discord).map(({ embed }) => embed.title);
    assert.ok(eventTitles.includes('Fehlerhaftes Event'));
    assert.ok(eventTitles.includes('Späteres Event'));
    assert.ok(discord.scheduledEvents.some((event) => event.name === 'Späteres Event'));
    assert.equal(discord.logChannels.filter(({ channelId, content }) => channelId === 'logs'
      && content.includes('Der Discord-Abgleich für „Fehlerhaftes Event“')).length, 1);
    assert.equal(discord.logChannels.some(({ content }) => content.includes('simulated scheduled-event failure')), false);
    assert.equal(getGuildEventObject(db, 'guild', 'sync-isolation:0')?.status, 'failed');
    assert.equal(getGuildEventObject(db, 'guild', 'sync-isolation:1')?.status, 'synced');
    const messageCount = discord.createMessageCount;
    await runCycle({ ...baseOptions, fetchText });
    assert.equal(discord.createMessageCount, messageCount);
    assert.equal(getGuildEventObject(db, 'guild', 'sync-isolation:0')?.status, 'synced');
    assert.equal(discord.scheduledEvents.filter((event) => event.name === 'Fehlerhaftes Event').length, 1);
  } finally {
    captured.restore();
    db.close();
  }
});

test('an idle cycle logs only start, list lines and summary, and a restart counts no known event as new', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-log-'));
  const dbPath = join(directory, 'events.sqlite');
  const discord = new FakeDiscordPort();
  const captured = captureLog('info');
  try {
    let db = openDb(dbPath);
    const first = await createLoggedCycleRunner(cycleOptions(db, discord))();
    assert.ok(first && first.newEvents > 0);
    assert.ok(captured.messages().some((line) => line.startsWith('Neu erkannt: „')));

    captured.lines.length = 0;
    const idle = await createLoggedCycleRunner(cycleOptions(db, discord))();
    assert.equal(idle?.newEvents, 0);
    const lines = captured.messages();
    assert.match(lines[0]!, /^Zyklus gestartet$/);
    assert.match(lines.at(-1)!, /^Zyklus fertig: 0 neue Events, 0 Beiträge neu, 0 bearbeitet, \d+ Anfragen \(\d+ aus Cache\/304\) in \d+ s$/);
    for (const line of lines.slice(1, -1)) assert.match(line, /^(Lodestone: (Topic-Liste|Wartungsliste|news\.xml) gelesen \(\d+ Einträge, \d+ neu\)|Banner: \d+ Sonderseiten)$/);

    db.close();
    db = openDb(dbPath);
    captured.lines.length = 0;
    const afterRestart = await createLoggedCycleRunner(cycleOptions(db, discord))();
    assert.equal(afterRestart?.newEvents, 0);
    assert.equal(captured.messages().some((line) => line.startsWith('Neu erkannt')), false);
    assert.ok((afterRestart?.capturedEvents ?? 0) > 0, 'known events are still re-read');
    db.close();
  } finally {
    captured.restore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dry-run reports fixture events and records Discord effects without contacting Discord', async () => {
  const db = openDb(':memory:');
  try {
    const result = await runDryRunCycle({
      store: db,
      fetchText: fixtureFetcher(),
      now: () => new Date(NOW),
    });

    assert.equal(result.cycle.firstRun, true);
    assert.match(result.report, /Allerschutzheiligen/);
    assert.match(result.report, /Fall Guys/);
    assert.match(result.report, /Mog Mog-Kollektion/);
    assert.match(result.report, /Belohnungen/);
    assert.match(result.report, /Belohnungen nach Abschnitt/);
    assert.match(result.report, /Quellen/);
    assert.match(result.report, /Discord-Event/);
    assert.match(result.report, /Status je Feld/);
    assert.match(result.report, /UTC:/);
    assert.match(result.report, /MESZ|MEZ/);
    assert.match(result.report, /Gespeichert, aber nicht gepostet/);
    assert.match(result.report, /beim Erststart unterdrückt|Event beendet/);
    assert.match(result.report, /Log-Kanal-Meldungen/);
    assert.match(result.report, /Abrufstatistik/);
    assert.match(result.report, /Anfragen nach Typ/);
    assert.match(result.report, /Duplikate vermieden: \d+/);
    assert.ok(result.fetchStatistics.byType);
    assert.equal(result.fetchStatistics.requests, Object.values(result.fetchStatistics.byType).reduce((sum, count) => sum + count, 0));
    assert.equal(result.fetchStatistics.requests, result.cycle.requests);
    assert.ok(result.fetchStatistics.byType.shortLinks > 0);
    assert.ok(result.fetchStatistics.byType.specialPages > 0);
    assert.ok(result.fetchStatistics.byType.items > 0);
    assert.match(result.report, /Lodestone blind/);
    assert.match(result.report, /Würde als Event-Beitrag veröffentlicht \(3\)/);
    const logCount = Number(/Log-Kanal-Meldungen, die gesendet würden \((\d+)\)/.exec(result.report)?.[1]);
    assert.ok(logCount <= 5, `expected at most 5 log lines; received ${logCount}`);
    assert.match(result.report, /Erststart: \d+ erfasst, 3 gepostet, \d+ unklassifiziert, \d+ ignoriert/);
    assert.ok(result.discord.recordedActions.length > 0);
    assert.equal(result.discord.connected, false);
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

    assert.equal(discord.createMessageCount, createdMessages, JSON.stringify({ counts, events: getAllEvents(db).map((event) => ({ id: event.id, key: event.eventKey, message: getGuildEventObject(db, 'guild', event.eventKey)?.messageId, title: event.title })) }));
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
    embeds: [{ title: 'Läuft gerade', description: 'Veralteter Status, der im blinden Zustand eingefroren bleiben muss.' }],
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
    assert.equal(discord.messages.find((message) => message.id === 'status-existing')?.embeds[0]?.description,
      'Veralteter Status, der im blinden Zustand eingefroren bleiben muss.');
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
    assert.equal(discord.logs.filter((message) => message.includes('Kurzlink konnte nicht aufgelöst werden')).length, 1);

    rejectShortLink = false;
    await runCycle(options);
    assert.equal(isSeen(db, topicUrl), true);
    assert.equal(discord.logs.filter((message) => message.includes('Kurzlink konnte nicht aufgelöst werden')).length, 1);
    assert.equal(getAllEvents(db).filter((event) => event.eventKey === 'seasonal-special:/lodestone/special/fallguys/').length, 1);
  } finally {
    db.close();
  }
});

test('cycle reads the clock again at scheduling time after discovery and extraction', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  let clockReads = 0;
  try {
    await runCycle({
      ...cycleOptions(db, discord),
      now: () => new Date(clockReads++ === 0 ? '2026-10-16T12:00:00.000Z' : '2026-10-16T12:03:00.000Z'),
    });

    assert.ok(clockReads > 1);
    assert.equal(discord.scheduledEvents.length, 3);
    assert.ok(discord.scheduledEvents.every((event) => event.startUtc === '2026-10-16T12:05:00.000Z'));
  } finally {
    db.close();
  }
});

test('maintenance originals for different worlds keep distinct identities despite the same stem', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  const original = 'https://de.finalfantasyxiv.com/lodestone/news/detail/aether-original';
  const crystal = 'https://de.finalfantasyxiv.com/lodestone/news/detail/crystal-original';
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Unrelated announcement', url: '/lodestone/topics/detail/filler' }]),
    maintenanceList: maintenanceListHtml([
      { tag: 'Wartung', title: '[Aether] Notwartung (17. Okt.)', url: original, publishedEpoch: 1792152000 },
      { tag: 'Wartung', title: '[Crystal] Notwartung (17. Okt.)', url: crystal, publishedEpoch: 1792152060 },
    ]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => {
      const path = new URL(url).pathname;
      if (path === '/lodestone/topics/detail/filler') {
        return { status: 200, body: '<article class="news__detail"><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: url };
      }
      if (path === '/lodestone/news/detail/aether-original' || path === '/lodestone/news/detail/crystal-original') {
        return { status: 200, body: fixture('./fixtures/maintenance/all-worlds-original.html'), finalUrl: url };
      }
      return undefined;
    },
  });
  try {
    await runCycle({ ...cycleOptions(db, discord), fetchText });
    const maintenance = getAllEvents(db).filter((event) => event.eventType === 'maintenance');

    assert.equal(maintenance.length, 2);
    assert.notEqual(maintenance[0]?.eventKey, maintenance[1]?.eventKey);
  } finally {
    db.close();
  }
});

test('maintenance-p1 follow-up finds its original later in the newest-first list and uses the original display title', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  setMetaValue(db, 'wiki_checked_utc_day', '2026-10-12');
  const original = '/lodestone/news/detail/937bc8f7dda7fe51008b7ea77d65548fcd4e5ebe';
  const followup = '/lodestone/news/detail/e06c2ed28cd282761a0204f7c0af613bb873cb3e';
  const maintenancePage = load(fixture('./fixtures/lists/maintenance-p1.html'));
  maintenancePage('li.news__list').each((_, element) => {
    const href = maintenancePage(element).find('a.news__list--link').attr('href');
    if (href !== original && href !== followup) maintenancePage(element).remove();
  });
  const pairList = maintenancePage.html();
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Unclassified filler', url: '/lodestone/topics/detail/filler' }]),
    maintenanceList: pairList,
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => new URL(url).pathname === '/lodestone/topics/detail/filler'
      ? { status: 200, body: '<article class="news__detail"><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: url }
      : undefined,
  });

  try {
    await runCycle({ ...cycleOptions(db, discord), fetchText, now: () => new Date('2026-10-12T09:00:00.000Z') });
    const events = getAllEvents(db).filter((event) => event.eventType === 'maintenance');

    assert.equal(events.length, 1);
    assert.equal(events[0]!.title, 'Wartung aller Welten (12-13. Okt.)');
    assert.deepEqual(getEventSources(db, events[0]!.id).map((source) => source.url).sort(), [
      `https://de.finalfantasyxiv.com${original}`,
      `https://de.finalfantasyxiv.com${followup}`,
    ].sort());
    assert.equal(discord.logs.some((message) => message.includes('Folge-News ohne Original')), false);
  } finally {
    db.close();
  }
});

test('an explicit original link joins a follow-up whose title stem changed', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  const original = 'https://de.finalfantasyxiv.com/lodestone/news/detail/937bc8f7dda7fe51008b7ea77d65548fcd4e5ebe';
  const followup = 'https://de.finalfantasyxiv.com/lodestone/news/detail/e06c2ed28cd282761a0204f7c0af613bb873cb3e';
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Unrelated announcement', url: '/lodestone/topics/detail/filler' }]),
    maintenanceList: maintenanceListHtml([
      { tag: 'Wartung', title: 'Wartung aller Welten (12-13. Okt.)', url: original, publishedEpoch: 1791882900 },
      { tag: 'Folge-News', title: 'Notwartung aller Welten (12-13. Okt.): Folgenews', url: followup, publishedEpoch: 1791882960 },
    ]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => new URL(url).pathname === '/lodestone/topics/detail/filler'
      ? { status: 200, body: '<article class="news__detail"><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: url }
      : undefined,
  });
  try {
    await runCycle({
      ...cycleOptions(db, discord),
      now: () => new Date('2026-10-12T09:00:00.000Z'),
      fetchText,
    });
    const maintenance = getAllEvents(db).filter((event) => event.eventType === 'maintenance');

    assert.equal(maintenance.length, 1);
    assert.deepEqual(getEventSources(db, maintenance[0]!.id).map((source) => source.url).sort(), [original, followup].sort());
    assert.equal(eventEmbeds(discord).length, 1);
  } finally {
    db.close();
  }
});

test('cycle stores follow-up source kind so its extended period wins over a later original timestamp', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  const original = 'https://de.finalfantasyxiv.com/lodestone/news/detail/937bc8f7dda7fe51008b7ea77d65548fcd4e5ebe';
  const followup = 'https://de.finalfantasyxiv.com/lodestone/news/detail/e06c2ed28cd282761a0204f7c0af613bb873cb3e';
  const followupHtml = fixture('./fixtures/maintenance/all-worlds-followup.html')
    .replace('bis zum 13. Okt. 2026 um 11:25 (MESZ)', 'bis zum 14. Okt. 2026 um 13:00 (MESZ)');
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Unrelated announcement', url: '/lodestone/topics/detail/filler' }]),
    maintenanceList: maintenanceListHtml([
      { tag: 'Wartung', title: 'Wartung aller Welten (12-13. Okt.)', url: original, publishedEpoch: 1792152000 },
      { tag: 'Folge-News', title: 'Wartung aller Welten (12-13. Okt.): Folgenews', url: followup, publishedEpoch: 1792130400 },
    ]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => {
      const path = new URL(url).pathname;
      if (path === '/lodestone/topics/detail/filler') {
        return { status: 200, body: '<article class="news__detail"><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: url };
      }
      if (path === '/lodestone/news/detail/e06c2ed28cd282761a0204f7c0af613bb873cb3e') {
        return { status: 200, body: followupHtml, finalUrl: url };
      }
      return undefined;
    },
  });
  try {
    await runCycle({ ...cycleOptions(db, discord), now: () => new Date('2026-10-12T09:00:00.000Z'), fetchText });
    const maintenance = getAllEvents(db).find((event) => event.eventType === 'maintenance');
    assert.ok(maintenance);
    const sources = getEventSources(db, maintenance.id);
    assert.equal(sources.find((source) => source.url === followup)?.kind, 'followup');
    assert.equal(maintenance.endUtc, '2026-10-14T11:00:00Z');
  } finally {
    db.close();
  }
});

test('topic discovery normalizes direct relative special links before fetching the special page', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  const topicUrl = '/lodestone/topics/detail/relative-special';
  const specialUrl = '/lodestone/special/relative-event/';
  const page = '<html><head><meta property="og:title" content="Relatives Sonderereignis"><meta name="description" content="Von Freitag, den 16. Oktober 2026 um 10:00 Uhr (MESZ) bis Dienstag, den 20. Oktober 2026 um 15:00 Uhr (MESZ)"></head><body><main class="content"><p>Von Freitag, den 16. Oktober 2026 um 10:00 Uhr (MESZ) bis Dienstag, den 20. Oktober 2026 um 15:00 Uhr (MESZ)</p></main></body></html>';
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Rückkehr eines Spiels', url: topicUrl }]),
    maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => {
      const path = new URL(url).pathname;
      if (path === topicUrl) {
        return { status: 200, body: `<article class="news__detail"><div class="news__detail__wrapper"><a href="${specialUrl}">Sonderseite</a></div></article>`, finalUrl: url };
      }
      if (path === specialUrl) return { status: 200, body: page, finalUrl: url };
      return undefined;
    },
  });
  try {
    await runCycle({ ...cycleOptions(db, discord), fetchText });
    const event = getAllEvents(db).find((candidate) => candidate.eventKey === 'seasonal-special:/lodestone/special/relative-event/');

    assert.ok(event);
    assert.ok(getEventSources(db, event.id).some((source) => source.url === 'https://de.finalfantasyxiv.com/lodestone/topics/detail/relative-special'));
  } finally {
    db.close();
  }
});

test('unavailable special evidence stays pending and later banner and topic discovery produce one seasonal event', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  const topicUrl = '/lodestone/topics/detail/pending-special';
  const specialUrl = '/lodestone/special/pending-event/';
  let specialAttempts = 0;
  let topicUnavailable = false;
  const page = '<html><head><meta property="og:title" content="Verifiziertes Sonderereignis"><meta name="description" content="Von Freitag, den 16. Oktober 2026 um 10:00 Uhr (MESZ) bis Dienstag, den 20. Oktober 2026 um 15:00 Uhr (MESZ)"></head><body><main class="content"><p>Von Freitag, den 16. Oktober 2026 um 10:00 Uhr (MESZ) bis Dienstag, den 20. Oktober 2026 um 15:00 Uhr (MESZ)</p></main></body></html>';
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Kampagne mit Sonderseite', url: topicUrl }], [specialUrl]),
    maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => {
      const path = new URL(url).pathname;
      if (path === topicUrl) {
        if (topicUnavailable) return { status: 503, body: '', finalUrl: url };
        return { status: 200, body: `<article class="news__detail"><div class="news__detail__wrapper"><a href="${specialUrl}">Sonderseite</a></div></article>`, finalUrl: url };
      }
      if (path === specialUrl && specialAttempts++ === 0) return { status: 503, body: '', finalUrl: url };
      if (path === specialUrl) return { status: 200, body: page, finalUrl: url };
      return undefined;
    },
  });
  try {
    const options = { ...cycleOptions(db, discord), fetchText };
    await runCycle(options);
    assert.equal(getAllEvents(db).length, 0);
    assert.equal(isSeen(db, 'https://de.finalfantasyxiv.com/lodestone/topics/detail/pending-special'), false);

    topicUnavailable = true;
    await runCycle(options);
    assert.equal(getAllEvents(db).filter((event) => event.eventType === 'seasonal-special').length, 1);

    topicUnavailable = false;
    await runCycle(options);
    const events = getAllEvents(db).filter((event) => event.eventType === 'seasonal-special');
    assert.equal(events.length, 1);
    assert.ok(getEventSources(db, events[0]!.id).some((source) => source.url === 'https://de.finalfantasyxiv.com/lodestone/topics/detail/pending-special'));
    assert.ok(getEventSources(db, events[0]!.id).some((source) => source.url === 'https://de.finalfantasyxiv.com/lodestone/special/pending-event/'));
    assert.equal(eventEmbeds(discord).length, 1);
  } finally {
    db.close();
  }
});

test('a first-run topic detail failure persists its URL and suppression after it leaves the list', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-pending-'));
  const dbPath = join(directory, 'events.sqlite');
  let db = openDb(dbPath);
  const discord = new FakeDiscordPort();
  const targetUrl = 'https://de.finalfantasyxiv.com/lodestone/topics/detail/02288c94ccfb267ca6df2a31770cd164a4ceb2ce';
  const base = fixtureFetcher();
  let unavailable = true;
  let omitFromList = false;
  const fetchText: FetchText = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/lodestone/topics/' && parsed.searchParams.get('page') === null && omitFromList) {
      const response = await base(url, options);
      const $ = load(response.body);
      $('a[href="/lodestone/topics/detail/02288c94ccfb267ca6df2a31770cd164a4ceb2ce"]').closest('li.news__list--topics').remove();
      return { ...response, body: $.html() };
    }
    if (parsed.pathname === new URL(targetUrl).pathname && unavailable) return { status: 503, body: '', finalUrl: url };
    return base(url, options);
  };
  try {
    await runCycle({ ...cycleOptions(db, discord), fetchText });
    assert.equal(isSeen(db, targetUrl), false);
    const messagesAfterBootstrap = discord.createMessageCount;
    db.close();

    db = openDb(dbPath);
    unavailable = false;
    omitFromList = true;
    await runCycle({ ...cycleOptions(db, discord), fetchText });
    const event = getAllEvents(db).find((candidate) => getEventSources(db, candidate.id).some((source) => source.url === targetUrl));

    assert.ok(event);
    assert.equal(event.endStatus, 'unsicher');
    assert.equal(getGuildEventObject(db, 'guild', event.eventKey)?.messageId ?? null, null);
    assert.equal(discord.createMessageCount, messagesAfterBootstrap);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a first-run suppressed event is posted after recovery verifies a future end', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  const specialUrl = '/lodestone/special/recoverable-period/';
  const title = 'Wieder verifizierbares Event';
  let specialPage = `<html><head><title>${title} | FINAL FANTASY XIV - Der Lodestone</title></head><body><main class="content__section"><p>Von Donnerstag, den 15. Oktober 2026 um 10:00 Uhr (MESZ) bis unleserlich</p></main></body></html>`;
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Unrelated announcement', url: '/lodestone/topics/detail/filler' }], [specialUrl]),
    maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => new URL(url).pathname === specialUrl
      ? { status: 200, body: specialPage, finalUrl: url }
      : new URL(url).pathname === '/lodestone/topics/detail/filler'
        ? { status: 200, body: '<article class="news__detail"><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: url }
        : undefined,
  });
  try {
    await runCycle({ ...cycleOptions(db, discord), fetchText, now: () => new Date('2026-10-16T12:00:00.000Z') });
    const event = getAllEvents(db).find((candidate) => candidate.eventKey === `seasonal-special:${specialUrl}`)!;
    assert.equal(getGuildEventObject(db, 'guild', event.eventKey)?.firstRunSuppressed, true);
    assert.equal(event.endStatus, 'unsicher');

    specialPage = `<html><head><title>${title} | FINAL FANTASY XIV - Der Lodestone</title></head><body><main class="content__section"><p>Von Donnerstag, den 15. Oktober 2026 um 10:00 Uhr (MESZ) bis Montag, den 2. November 2026 um 15:59 Uhr (MEZ)</p></main></body></html>`;
    await runCycle({ ...cycleOptions(db, discord), fetchText, now: () => new Date('2026-10-16T13:00:00.000Z') });
    const refreshed = getAllEvents(db).find((candidate) => candidate.id === event.id)!;
    assert.equal(refreshed.endStatus, 'ok');
    assert.ok(getGuildEventObject(db, 'guild', event.eventKey)?.messageId);
  } finally {
    db.close();
  }
});

test('a transient channel lookup failure does not mark a guild as needing setup', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  upsertGuildSetup(db, { guildId: 'guild', eventChannelId: 'events', logChannelId: 'logs' });
  const fetchText = fixtureFetcher();
  let failOnce = true;
  discord.isTextChannel = async () => {
    if (failOnce) {
      failOnce = false;
      throw new Error('transient 503');
    }
    return true;
  };
  try {
    await runCycle({ store: db, discord, fetchText, now: () => new Date(NOW) });
    assert.equal(getGuild(db, 'guild')?.needsSetup, false);
    await runCycle({ store: db, discord, fetchText, now: () => new Date(NOW) });
    assert.ok(discord.messages.some((message) => message.channelId === 'events'));
  } finally {
    db.close();
  }
});

test('one guild first-run does not suppress an unclassified warning for an established guild', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  upsertGuildSetup(db, { guildId: 'established', eventChannelId: 'events-a', logChannelId: 'logs-a' });
  upsertGuildSetup(db, { guildId: 'initializing', eventChannelId: 'events-b', logChannelId: 'logs-b' });
  markGuildFirstRunDone(db, 'established');
  const topicUrl = '/lodestone/topics/detail/unclassified-multi-guild';
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Neue Meldung ohne Klassifikation', url: topicUrl }]),
    maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => new URL(url).pathname === topicUrl
      ? { status: 200, body: '<article><div class="news__detail__wrapper">Nichts erkannt.</div></article>', finalUrl: url }
      : undefined,
  });
  try {
    await runCycle({
      store: db, discord, fetchText, now: () => new Date(NOW),
      guilds: [
        { guildId: 'established', eventChannelId: 'events-a', logChannelId: 'logs-a', firstRun: false },
        { guildId: 'initializing', eventChannelId: 'events-b', logChannelId: 'logs-b', firstRun: true },
      ],
    });
    assert.ok(discord.logChannels.some(({ channelId, content }) => channelId === 'logs-a' && content.startsWith('Neue Lodestone-News ohne Event:\n')));
    assert.ok(!discord.logChannels.some(({ channelId, content }) => channelId === 'logs-b' && content.startsWith('Neue Lodestone-News ohne Event:\n')));
  } finally {
    db.close();
  }
});

test('global first crawl suppresses backlog notices, then logs new unclassified topics once per cycle', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  upsertGuildSetup(db, { guildId: 'guild', eventChannelId: 'events', logChannelId: 'logs' });
  setMetaValue(db, 'wiki_checked_utc_day', NOW.toISOString().slice(0, 10));
  const backlogUrl = '/lodestone/topics/detail/backlog-topic';
  const freshUrl = '/lodestone/topics/detail/fresh-topic';
  let entries = [{ title: 'Backlog topic', url: backlogUrl }];
  const fetchText: FetchText = async (requestedUrl) => {
    const url = new URL(requestedUrl);
    if (url.pathname === '/lodestone/topics/') {
      return { status: 200, body: topicListHtml(entries), finalUrl: requestedUrl };
    }
    if (url.pathname === '/lodestone/news/category/2') {
      return {
        status: 200,
        body: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
        finalUrl: requestedUrl,
      };
    }
    if (url.pathname === '/lodestone/news/news.xml') {
      return { status: 200, body: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>', finalUrl: requestedUrl };
    }
    if (url.pathname === backlogUrl || url.pathname === freshUrl) {
      return { status: 200, body: '<article><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: requestedUrl };
    }
    return { status: 404, body: '', finalUrl: requestedUrl };
  };

  try {
    await runCycle({
      store: db, discord, fetchText, now: () => new Date(NOW),
      guilds: [{ guildId: 'guild', eventChannelId: 'events', logChannelId: 'logs', firstRun: false }],
    });

    assert.deepEqual(discord.logChannels.map(({ content }) => content), [
      'Erststart: 0 erfasst, 0 gepostet, 1 unklassifiziert, 1 ignoriert',
    ]);

    const firstCycleLogCount = discord.logChannels.length;
    entries = [
      { title: 'Backlog topic', url: backlogUrl },
      { title: 'Neue [News] (Info) * _ ~ ` |', url: freshUrl },
    ];
    await runCycle({ store: db, discord, fetchText, now: () => new Date(NOW) });

    const newMessages = discord.logChannels.slice(firstCycleLogCount).map(({ content }) => content);
    assert.deepEqual(newMessages, [
      'Neue Lodestone-News ohne Event:\n• [Neue \\[News\\] \\(Info\\) \\* \\_ \\~ \\` \\|](<https://de.finalfantasyxiv.com/lodestone/topics/detail/fresh-topic>)',
    ]);
  } finally {
    db.close();
  }
});

test('new unclassified topic notices split only at Discord’s 2000-character limit', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  upsertGuildSetup(db, { guildId: 'guild', eventChannelId: 'events', logChannelId: 'logs' });
  markGuildFirstRunDone(db, 'guild');
  markFirstRunDone(db);
  setMetaValue(db, 'wiki_checked_utc_day', NOW.toISOString().slice(0, 10));
  const entries = Array.from({ length: 30 }, (_, index) => ({
    title: `Neue Ankündigung ${String(index).padStart(2, '0')} ${'x'.repeat(80)}`,
    url: `/lodestone/topics/detail/unclassified-${index}`,
  }));
  const fetchText: FetchText = async (requestedUrl) => {
    const url = new URL(requestedUrl);
    if (url.pathname === '/lodestone/topics/') return { status: 200, body: topicListHtml(entries), finalUrl: requestedUrl };
    if (url.pathname === '/lodestone/news/category/2') {
      return { status: 200, body: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]), finalUrl: requestedUrl };
    }
    if (url.pathname === '/lodestone/news/news.xml') return { status: 200, body: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>', finalUrl: requestedUrl };
    if (url.pathname.startsWith('/lodestone/topics/detail/')) {
      return { status: 200, body: '<article><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: requestedUrl };
    }
    return { status: 404, body: '', finalUrl: requestedUrl };
  };

  try {
    await runCycle({ store: db, discord, fetchText, now: () => new Date(NOW) });

    const messages = discord.logChannels.map(({ content }) => content)
      .filter((content) => content.startsWith('Neue Lodestone-News ohne Event:\n'));
    assert.ok(messages.length > 1);
    assert.ok(messages.every((message) => message.length <= 2_000));
    assert.ok(messages.every((message) => message.startsWith('Neue Lodestone-News ohne Event:\n')));
    assert.equal(messages.join('\n').match(/\[Neue Ankündigung/g)?.length, entries.length);
  } finally {
    db.close();
  }
});

test('pending discovery adds every guild that joins while its first run is active', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  upsertGuildSetup(db, { guildId: 'guild-a', eventChannelId: 'events-a', logChannelId: 'logs-a' });
  const topicUrl = '/lodestone/topics/detail/pending-first-run-guild';
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Patch 7.9 details', url: topicUrl }]),
    maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => new URL(url).pathname === topicUrl
      ? { status: 503, body: '', finalUrl: url }
      : undefined,
  });
  try {
    await runCycle({ store: db, discord, fetchText, now: () => new Date(NOW), guilds: [
      { guildId: 'guild-a', eventChannelId: 'events-a', logChannelId: 'logs-a', firstRun: false },
    ] });
    upsertGuildSetup(db, { guildId: 'guild-b', eventChannelId: 'events-b', logChannelId: 'logs-b' });
    await runCycle({ store: db, discord, fetchText, now: () => new Date(NOW), guilds: [
      { guildId: 'guild-a', eventChannelId: 'events-a', logChannelId: 'logs-a', firstRun: false },
      { guildId: 'guild-b', eventChannelId: 'events-b', logChannelId: 'logs-b', firstRun: true },
    ] });
    const pending = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'pending_discoveries'").get()?.value as string) as Array<{ firstRunGuildIds: string[] }>;
    assert.ok(pending[0]?.firstRunGuildIds.includes('guild-b'));
  } finally {
    db.close();
  }
});

test('an in-flight first-run crawl cannot persist a guild removed before pending discovery is written', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  const guildId = 'removed-during-crawl';
  upsertGuildSetup(db, { guildId, eventChannelId: 'events', logChannelId: 'logs' });
  setMetaValue(db, 'wiki_checked_utc_day', NOW.toISOString().slice(0, 10));
  const topicUrl = '/lodestone/topics/detail/removed-during-crawl';
  const baseFetcher = controlledFetcher({
    topicList: topicListHtml([{ title: 'Patch 8.0 details', url: topicUrl }]),
    maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => {
      if (new URL(url).pathname !== topicUrl) return undefined;
      deleteGuild(db, guildId);
      return { status: 503, body: '', finalUrl: url };
    },
  });
  const fetchText: FetchText = async (url, options) => new URL(url).pathname === '/lodestone/news/category/2'
    ? { status: 503, body: '', finalUrl: url }
    : baseFetcher(url, options);
  try {
    await runCycle({ store: db, discord, fetchText, now: () => new Date(NOW), guilds: [
      { guildId, eventChannelId: 'events', logChannelId: 'logs', firstRun: true },
    ] });

    const pending = JSON.parse(getMetaValue(db, 'pending_discoveries') ?? '[]') as Array<{ firstRun: boolean; firstRunGuildIds: string[] }>;
    assert.deepEqual(pending[0]?.firstRunGuildIds, []);
    assert.equal(pending[0]?.firstRun, false);
  } finally {
    db.close();
  }
});

test('an expired seasonal banner stores its verified terminal period and is not posted', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  const specialUrl = '/lodestone/special/ended-season/';
  const expired = '<html><body><main class="content"><p>Von Mittwoch, den 7. Oktober 2026 um 10:00 Uhr (MESZ) bis Dienstag, den 13. Oktober 2026 um 10:00 Uhr (MESZ).</p></main></body></html>';
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Unrelated announcement', url: '/lodestone/topics/detail/filler' }], [specialUrl]),
    maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => new URL(url).pathname === specialUrl
      ? { status: 200, body: expired, finalUrl: url }
      : new URL(url).pathname === '/lodestone/topics/detail/filler'
        ? { status: 200, body: '<article class="news__detail"><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: url }
        : undefined,
  });
  try {
    await runCycle({ ...cycleOptions(db, discord), fetchText });
    const event = getAllEvents(db).find((candidate) => candidate.eventKey === 'seasonal-special:/lodestone/special/ended-season/');

    assert.ok(event);
    assert.equal(event.startUtc, '2026-10-07T08:00:00Z');
    assert.equal(event.endUtc, '2026-10-13T08:00:00Z');
    assert.equal(event.endStatus, 'ok');
    assert.equal(discord.messages.some((message) => message.embeds.some((embed) => embed.footer?.text === String(event.id))), false);
  } finally {
    db.close();
  }
});

test('banner specials without a verified title do not publish their URL fragment', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  const specialUrl = '/lodestone/special/opaque123/';
  const page = '<html><body><main class="content"><p>Von Freitag, den 16. Oktober 2026 um 10:00 Uhr (MESZ) bis Dienstag, den 20. Oktober 2026 um 15:00 Uhr (MESZ).</p></main></body></html>';
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Unrelated announcement', url: '/lodestone/topics/detail/filler' }], [specialUrl]),
    maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => new URL(url).pathname === specialUrl
      ? { status: 200, body: page, finalUrl: url }
      : new URL(url).pathname === '/lodestone/topics/detail/filler'
        ? { status: 200, body: '<article class="news__detail"><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: url }
        : undefined,
  });
  try {
    await runCycle({ ...cycleOptions(db, discord), fetchText });
    const event = getAllEvents(db).find((candidate) => candidate.eventKey === 'seasonal-special:/lodestone/special/opaque123/');
    assert.ok(event);
    const posted = eventEmbeds(discord).find((entry) => entry.eventId === `ffe-${stableEventIdentity(event.eventKey)}`);

    assert.ok(posted);
    assert.equal(event.title, 'opaque123');
    assert.equal(event.titleStatus, 'unsicher');
    assert.equal(posted.embed.title, undefined);
  } finally {
    db.close();
  }
});

test('an existing seasonal event keeps its verified terminal period after expiration', async () => {
  const db = openDb(':memory:');
  const discord = new FakeDiscordPort();
  markFirstRunDone(db);
  const specialUrl = '/lodestone/special/seasonal-expiration/';
  const page = '<html><head><meta property="og:title" content="Sonderaktion mit Ablauf"></head><body><main class="content"><p>Von Freitag, den 16. Oktober 2026 um 10:00 Uhr (MESZ) bis Freitag, den 16. Oktober 2026 um 15:00 Uhr (MESZ).</p></main></body></html>';
  const fetchText = controlledFetcher({
    topicList: topicListHtml([{ title: 'Unrelated announcement', url: '/lodestone/topics/detail/filler' }], [specialUrl]),
    maintenanceList: maintenanceListHtml([{ tag: 'Wartung', title: 'Wartung der Mogry-Station', url: '/lodestone/news/detail/ignored' }]),
    feedBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    intercept: async (url) => new URL(url).pathname === specialUrl
      ? { status: 200, body: page, finalUrl: url }
      : new URL(url).pathname === '/lodestone/topics/detail/filler'
        ? { status: 200, body: '<article class="news__detail"><div class="news__detail__wrapper">Keine Klassifikation.</div></article>', finalUrl: url }
        : undefined,
  });
  let cycleTime = new Date('2026-10-16T12:00:00.000Z');
  try {
    const options = { ...cycleOptions(db, discord), now: () => new Date(cycleTime), fetchText };
    await runCycle(options);
    const event = getAllEvents(db).find((candidate) => candidate.eventKey === 'seasonal-special:/lodestone/special/seasonal-expiration/');
    assert.ok(event);
    assert.equal(event.endUtc, '2026-10-16T13:00:00Z');
    assert.equal(event.endStatus, 'ok');
    const messageCount = eventEmbeds(discord).length;

    cycleTime = new Date('2026-10-16T14:00:00.000Z');
    await runCycle(options);
    const refreshed = getAllEvents(db).find((candidate) => candidate.id === event.id)!;

    assert.equal(refreshed.startUtc, '2026-10-16T08:00:00Z');
    assert.equal(refreshed.endUtc, '2026-10-16T13:00:00Z');
    assert.equal(refreshed.endStatus, 'ok');
    assert.equal(eventEmbeds(discord).length, messageCount);
  } finally {
    db.close();
  }
});

