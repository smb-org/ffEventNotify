// Orchestrates source discovery, extraction, storage, health, and Discord synchronization.

import {
  applyField,
  attachSource,
  createEvent,
  findEventByKey,
  findEventBySourceUrl,
  getAllEvents,
  getEventSources,
  getMetaValue,
  getOpenEvents,
  isFirstRun,
  markFirstRunDone,
  markSeen,
  setMetaValue,
  warnOnce,
  type Store,
  type StoreEvent,
  type StoreEventSource,
} from './store.ts';
import { classifyEntry, maintenanceStem } from './classify.ts';
import { extractGenericTopic, deriveGenericEventKey } from './extractors/generic.ts';
import { extractMaintenance } from './extractors/maintenance.ts';
import { extractSeasonal, hasPeriod } from './extractors/seasonal.ts';
import { fetchNewsFeed, parseNewsFeed } from './sources/feed.ts';
import {
  articleBodyLinks,
  fetchDetailPage,
  fetchMaintenanceListPage,
  fetchSpecialPage,
  fetchTopicListPage,
  normalizeLodestoneUrl,
  parseBannerRail,
  parseMaintenanceList,
  parseTopicList,
  resolveShortLinks,
} from './sources/lodestone.ts';
import { runDailyWikiCrossCheck } from './sources/wiki.ts';
import { syncEventEmbed } from './sync/embed.ts';
import { syncScheduledEvent } from './sync/scheduled.ts';
import { syncLiveStatusPost } from './sync/status.ts';
import { SourceHealthMonitor } from './health.ts';
import type {
  Classification,
  DiscordPort,
  EventType,
  ExtractResult,
  FetchText,
  FieldStatus,
  ListEntry,
  ParsedListEntry,
  Reward,
} from './types.ts';

export interface CycleOptions {
  store: Store;
  discord: DiscordPort;
  fetchText: FetchText;
  guildId: string;
  eventChannelId: string;
  logChannelId: string;
  now?: () => Date;
  health?: SourceHealthMonitor;
}

export interface CycleResult {
  firstRun: boolean;
  capturedEvents: number;
  postedEvents: number;
  blind: boolean;
}

interface CycleContext extends Omit<CycleOptions, 'health'> {
  health: SourceHealthMonitor;
  currentTime: Date;
  processedSources: Set<string>;
  capturedEventIds: Set<number>;
  specialPages: Map<string, Promise<string | undefined>>;
}

interface LoadedLists {
  maintenanceEntries: ReturnType<typeof parseMaintenanceList>;
  topicEntries: ReturnType<typeof parseTopicList>;
  bannerHtml?: string;
  feedEntries: ReturnType<typeof parseNewsFeed>;
  counts: number[];
  succeeded: boolean;
}

function sourceKind(entry: ListEntry): StoreEventSource['kind'] {
  if (entry.source === 'maintenance' || entry.source === 'topic') return entry.source;
  if (/^\[Folge-News\]/i.test(entry.title)) return 'followup';
  return 'feed';
}

function publishedAt(entry: ListEntry, now: Date): string {
  if (entry.publishedAt) return entry.publishedAt;
  if (entry.publishedEpoch !== undefined && Number.isFinite(entry.publishedEpoch)) {
    return new Date(entry.publishedEpoch * 1_000).toISOString();
  }
  return now.toISOString();
}

function isSpecialUrl(value: string): boolean {
  try {
    return new URL(value).pathname.startsWith('/lodestone/special/');
  } catch {
    return false;
  }
}

function asEntry(parsed: ParsedListEntry, source: ListEntry['source'], feedPublishedAt?: string): ListEntry {
  return {
    ...parsed,
    source,
    ...(feedPublishedAt ? { publishedAt: feedPublishedAt } : {}),
  };
}

async function readLists(context: CycleContext, firstRun: boolean): Promise<LoadedLists> {
  const pageCount = firstRun ? 3 : 1;
  const maintenanceEntries: LoadedLists['maintenanceEntries'] = [];
  const topicEntries: LoadedLists['topicEntries'] = [];
  const counts: number[] = [];
  let succeeded = true;
  let bannerHtml: string | undefined;

  for (let page = 1; page <= pageCount; page += 1) {
    try {
      const html = await fetchTopicListPage(page, context.fetchText);
      const entries = parseTopicList(html);
      topicEntries.push(...entries);
      counts.push(entries.length);
      if (page === 1) bannerHtml = html;
    } catch (error) {
      succeeded = false;
      await logSourceFailure(context, `https://de.finalfantasyxiv.com/lodestone/topics/${page > 1 ? `?page=${page}` : ''}`, error);
    }

    try {
      const html = await fetchMaintenanceListPage(page, context.fetchText);
      const entries = parseMaintenanceList(html);
      maintenanceEntries.push(...entries);
      counts.push(entries.length);
      if (page === 1 && bannerHtml === undefined) bannerHtml = html;
    } catch (error) {
      succeeded = false;
      await logSourceFailure(context, `https://de.finalfantasyxiv.com/lodestone/news/category/2${page > 1 ? `?page=${page}` : ''}`, error);
    }
  }

  let feedEntries: LoadedLists['feedEntries'] = [];
  try {
    feedEntries = parseNewsFeed(await fetchNewsFeed(context.fetchText));
  } catch (error) {
    succeeded = false;
    await logSourceFailure(context, 'https://de.finalfantasyxiv.com/lodestone/news/news.xml', error);
  }

  return { topicEntries, maintenanceEntries, bannerHtml, feedEntries, counts, succeeded };
}

async function logWarning(context: CycleContext, key: string, message: string): Promise<void> {
  if (warnOnce(context.store, key)) await context.discord.sendLog(context.logChannelId, message);
}

async function logSourceFailure(context: CycleContext, url: string, error: unknown): Promise<void> {
  await logWarning(
    context,
    `source-failure:${url}`,
    `Die Lodestone-Quelle ist nicht abrufbar: ${url} (${error instanceof Error ? error.message : String(error)})`,
  );
}

async function getSpecialPage(context: CycleContext, url: string): Promise<string | undefined> {
  const normalized = normalizeLodestoneUrl(url);
  const path = new URL(normalized).pathname;
  let page = context.specialPages.get(path);
  if (!page) {
    page = fetchSpecialPage(normalized, context.fetchText).catch(async (error: unknown) => {
      await logSourceFailure(context, normalized, error);
      return undefined;
    });
    context.specialPages.set(path, page);
  }
  return page;
}

function rememberEvent(context: CycleContext, eventId: number): void {
  context.capturedEventIds.add(eventId);
}

function eventForType(context: CycleContext, eventKey: string, eventType: EventType, title: string, sourceUrl: string, preferredEventId?: number): number {
  const attached = findEventBySourceUrl(context.store, sourceUrl);
  if (attached !== undefined) return attached;
  if (preferredEventId !== undefined) return preferredEventId;
  const byKey = findEventByKey(context.store, eventKey);
  return byKey ?? createEvent(context.store, { eventKey, eventType, title });
}

function applyStatus<T>(
  context: CycleContext,
  eventId: number,
  field: 'title' | 'rewards' | 'description',
  status: FieldStatus<T>,
  sourceUrl: string,
  sourceMoment: string,
): void {
  applyField(context.store, eventId, field, status as FieldStatus<string | Reward[]>, sourceUrl, sourceMoment);
}

function applyExtract(
  context: CycleContext,
  eventId: number,
  sourceUrl: string,
  sourceMoment: string,
  result: ExtractResult,
): void {
  applyStatus(context, eventId, 'title', result.title, sourceUrl, sourceMoment);
  if (result.period.status === 'ok') {
    applyField(context.store, eventId, 'start', { status: 'ok', value: result.period.value.startUtc }, sourceUrl, sourceMoment);
    applyField(context.store, eventId, 'end', { status: 'ok', value: result.period.value.endUtc }, sourceUrl, sourceMoment);
  } else {
    applyField(context.store, eventId, 'start', { status: 'unsicher', reason: result.period.reason }, sourceUrl, sourceMoment);
    applyField(context.store, eventId, 'end', { status: 'unsicher', reason: result.period.reason }, sourceUrl, sourceMoment);
  }
  applyStatus(context, eventId, 'rewards', result.rewards, sourceUrl, sourceMoment);
  applyStatus(context, eventId, 'description', result.description, sourceUrl, sourceMoment);
}

function applyGeneric(
  context: CycleContext,
  eventId: number,
  sourceUrl: string,
  sourceMoment: string,
  result: ReturnType<typeof extractGenericTopic>,
): void {
  applyStatus(context, eventId, 'title', result.title, sourceUrl, sourceMoment);
  applyField(context.store, eventId, 'start', result.date, sourceUrl, sourceMoment);
  applyField(context.store, eventId, 'end', {
    status: 'unsicher',
    reason: 'Der Beitrag nennt keinen verlässlichen Endzeitpunkt.',
  }, sourceUrl, sourceMoment);
  applyStatus(context, eventId, 'rewards', result.rewards, sourceUrl, sourceMoment);
  applyStatus(context, eventId, 'description', result.description, sourceUrl, sourceMoment);
}

function eventTitle(context: CycleContext, eventId: number): string {
  return getAllEvents(context.store).find((event) => event.id === eventId)?.title ?? `Event ${eventId}`;
}

async function applySeasonalPage(
  context: CycleContext,
  sourceUrl: string,
  html: string,
  fallbackTitle: string,
  topicEntry?: ListEntry,
  preferredEventId?: number,
): Promise<number> {
  const normalizedSpecialUrl = normalizeLodestoneUrl(sourceUrl);
  const specialPath = new URL(normalizedSpecialUrl).pathname;
  const key = `seasonal-special:${specialPath}`;
  const sourceMoment = topicEntry ? publishedAt(topicEntry, context.currentTime) : context.currentTime.toISOString();
  const result = await extractSeasonal(html, context.currentTime, { fetchText: context.fetchText, store: context.store });
  const suggestedTitle = result.title.status === 'ok' ? result.title.value : fallbackTitle;
  const eventId = eventForType(context, key, 'seasonal-special', suggestedTitle, normalizedSpecialUrl, preferredEventId);

  if (topicEntry) {
    attachSource(context.store, {
      eventId,
      url: topicEntry.url,
      kind: 'topic',
      publishedAt: topicEntry.publishedAt ?? (topicEntry.publishedEpoch === undefined ? undefined : new Date(topicEntry.publishedEpoch * 1_000).toISOString()),
      firstSeenAt: context.currentTime.toISOString(),
    });
    context.processedSources.add(topicEntry.url);
  }
  attachSource(context.store, {
    eventId,
    url: normalizedSpecialUrl,
    kind: 'special',
    firstSeenAt: context.currentTime.toISOString(),
  });
  context.processedSources.add(normalizedSpecialUrl);
  applyExtract(context, eventId, normalizedSpecialUrl, sourceMoment, result);
  rememberEvent(context, eventId);
  return eventId;
}

async function classifyAndLog(
  context: CycleContext,
  entry: ListEntry,
  classification: Classification,
): Promise<void> {
  const unresolvedShortLink = classification.status === 'unclassified'
    && classification.reason === 'short link unresolved';
  if (!unresolvedShortLink) {
    markSeen(context.store, entry.url, classification.status, context.currentTime.toISOString());
  }
  if (classification.status === 'unclassified') {
    if (unresolvedShortLink) {
      await logWarning(context, 'short-link-unresolved:' + entry.url, 'Kurzlink nicht aufgelöst (short link unresolved): ' + entry.title + ' (' + entry.url + ')');
    } else {
      await logWarning(context, `unclassified:${entry.url}`, `Nicht klassifiziert: ${entry.title} (${entry.url})`);
    }
  } else if (classification.status === 'ignored') {
    await logWarning(context, `ignored:${entry.url}`, `Nicht berücksichtigt: ${entry.title} (${entry.url})`);
  }
}

function findMaintenanceMatch(context: CycleContext, entry: ListEntry): { eventId?: number; ambiguity?: 'missing' | 'multiple' } {
  const stem = maintenanceStem(entry.title);
  const matches = getOpenEvents(context.store, context.currentTime)
    .filter((event) => event.eventType === 'maintenance' && maintenanceStem(event.title) === stem);
  if (matches.length === 1) return { eventId: matches[0]!.id };
  if (matches.length > 1) return { ambiguity: 'multiple' };
  return { ambiguity: 'missing' };
}

async function processMaintenance(
  context: CycleContext,
  entry: ListEntry,
  preferredEventId?: number,
): Promise<number | undefined> {
  const classification = await classifyEntry(entry, undefined, { hasPeriod: () => 'no' });
  await classifyAndLog(context, entry, classification);
  context.processedSources.add(entry.url);
  if (classification.status !== 'classified') return undefined;

  const isFollowup = /^\[Folge-News\]/i.test(entry.title);
  const match = findMaintenanceMatch(context, entry);
  let targetId = preferredEventId ?? findEventBySourceUrl(context.store, entry.url) ?? match.eventId;
  if (isFollowup && targetId === undefined && match.ambiguity) {
    const key = match.ambiguity === 'multiple' ? `maintenance:followup:ambiguous:${entry.url}` : `maintenance:followup:${entry.url}`;
    await logWarning(
      context,
      `maintenance-followup:${entry.url}`,
      match.ambiguity === 'multiple'
        ? `Folge-News mehrdeutig: ${entry.title} (${entry.url})`
        : `Folge-News ohne Original: ${entry.title} (${entry.url})`,
    );
    targetId = eventForType(context, key, 'maintenance', entry.title, entry.url);
  }

  const stem = maintenanceStem(entry.title);
  const eventKey = isFollowup ? `maintenance:followup:${entry.url}` : `maintenance:${stem}`;
  const sourceUrl = normalizeLodestoneUrl(entry.url);
  const alreadyKnown = findEventBySourceUrl(context.store, sourceUrl) !== undefined ||
    targetId !== undefined || findEventByKey(context.store, eventKey) !== undefined;
  const eventId = eventForType(context, eventKey, 'maintenance', entry.title, sourceUrl, targetId);
  const kind = sourceKind(entry);
  attachSource(context.store, {
    eventId,
    url: sourceUrl,
    kind,
    publishedAt: entry.publishedAt ?? (entry.publishedEpoch === undefined ? undefined : new Date(entry.publishedEpoch * 1_000).toISOString()),
    firstSeenAt: context.currentTime.toISOString(),
  });

  try {
    const html = await fetchDetailPage(sourceUrl, context.fetchText);
    const result = extractMaintenance(html, entry.title);
    applyExtract(context, eventId, sourceUrl, publishedAt(entry, context.currentTime), result);
  } catch (error) {
    await logSourceFailure(context, sourceUrl, error);
    if (!alreadyKnown) {
      const reason = `Detailseite nicht lesbar: ${error instanceof Error ? error.message : String(error)}`;
      applyField(context.store, eventId, 'start', { status: 'unsicher', reason }, sourceUrl, publishedAt(entry, context.currentTime));
      applyField(context.store, eventId, 'end', { status: 'unsicher', reason }, sourceUrl, publishedAt(entry, context.currentTime));
    }
  }
  rememberEvent(context, eventId);
  return eventId;
}

async function processTopic(
  context: CycleContext,
  entry: ListEntry,
  preferredEventId?: number,
): Promise<number | undefined> {
  let detailHtml: string;
  try {
    detailHtml = await fetchDetailPage(entry.url, context.fetchText);
  } catch (error) {
    context.processedSources.add(entry.url);
    await logSourceFailure(context, entry.url, error);
    markSeen(context.store, entry.url, 'detail-unavailable', context.currentTime.toISOString());
    return undefined;
  }

  const articleLinks = articleBodyLinks(detailHtml);
  const linkResolution = await resolveShortLinks(articleLinks, context.fetchText);
  const specialUrls = [...new Set(linkResolution.links
    .filter((link): link is string => link !== undefined && isSpecialUrl(link))
    .map(normalizeLodestoneUrl))];
  const specialHtmlByPath = new Map<string, string>();
  for (const url of specialUrls) {
    const html = await getSpecialPage(context, url);
    if (html !== undefined) specialHtmlByPath.set(new URL(url).pathname, html);
  }

  const classification = await classifyEntry(entry, detailHtml, {
    resolvedLinks: linkResolution,
    hasPeriod: (path) => {
      const html = specialHtmlByPath.get(path);
      return html === undefined ? 'no' : hasPeriod(html, context.currentTime);
    },
  });
  await classifyAndLog(context, entry, classification);
  context.processedSources.add(entry.url);
  if (classification.status !== 'classified') return undefined;

  if (classification.eventType === 'seasonal-special') {
    const specialUrl = specialUrls.find((url) => {
      const html = specialHtmlByPath.get(new URL(url).pathname);
      return html !== undefined && hasPeriod(html, context.currentTime) !== 'no';
    });
    if (specialUrl === undefined) return undefined;
    return applySeasonalPage(
      context,
      specialUrl,
      specialHtmlByPath.get(new URL(specialUrl).pathname)!,
      entry.title,
      entry,
      preferredEventId ?? findEventBySourceUrl(context.store, entry.url),
    );
  }

  const keyText = deriveGenericEventKey(entry, detailHtml);
  const eventKey = 'generic:' + keyText;
  const sourceUrl = normalizeLodestoneUrl(entry.url);
  const initialResult = extractGenericTopic(entry, detailHtml);
  const proposedTitle = initialResult.title.status === 'ok' ? initialResult.title.value : entry.title;
  const eventId = eventForType(
    context,
    eventKey,
    'topic-generic',
    proposedTitle,
    sourceUrl,
    preferredEventId ?? findEventBySourceUrl(context.store, entry.url),
  );
  attachSource(context.store, {
    eventId,
    url: sourceUrl,
    kind: 'topic',
    publishedAt: entry.publishedAt ?? (entry.publishedEpoch === undefined ? undefined : new Date(entry.publishedEpoch * 1_000).toISOString()),
    firstSeenAt: context.currentTime.toISOString(),
  });
  applyGeneric(context, eventId, sourceUrl, publishedAt(entry, context.currentTime), initialResult);
  rememberEvent(context, eventId);
  return eventId;
}

async function processEntry(context: CycleContext, entry: ListEntry, preferredEventId?: number): Promise<number | undefined> {
  if (entry.source === 'maintenance' || (entry.source === 'feed' && /^\[(?:Wartung|Folge-News)\]/i.test(entry.title))) {
    return processMaintenance(context, entry, preferredEventId);
  }
  if (entry.source === 'topic') return processTopic(context, entry, preferredEventId);
  const classification = await classifyEntry(entry, undefined, { hasPeriod: () => 'no' });
  await classifyAndLog(context, entry, classification);
  context.processedSources.add(entry.url);
  return undefined;
}

function combinedEntries(lists: LoadedLists): ListEntry[] {
  const candidates = new Map<string, ListEntry>();
  const feedByUrl = new Map(lists.feedEntries.map((entry) => [entry.url, entry]));
  for (const entry of lists.topicEntries) candidates.set(entry.url, asEntry(entry, 'topic'));
  for (const entry of lists.maintenanceEntries) {
    const fromFeed = feedByUrl.get(entry.url);
    candidates.set(entry.url, asEntry(entry, 'maintenance', fromFeed?.published));
  }
  for (const item of lists.feedEntries) {
    if (item.category !== 'Wartung' || candidates.has(item.url)) continue;
    const feedTag = /:\s*Folgenews\s*$/i.test(item.title) ? 'Folge-News' : 'Wartung';
    const title = /^\[(?:Wartung|Folge-News)\]/i.test(item.title) ? item.title : `[${feedTag}]${item.title}`;
    candidates.set(item.url, {
      title,
      url: item.url,
      source: 'feed',
      publishedAt: item.published,
    });
  }
  return [...candidates.values()];
}

async function processBannerRail(context: CycleContext, html: string | undefined): Promise<void> {
  if (!html) return;
  for (const path of parseBannerRail(html)) {
    const specialUrl = normalizeLodestoneUrl(path);
    const page = await getSpecialPage(context, specialUrl);
    if (page === undefined) continue;
    const entry: ListEntry = { title: specialTitleFromPath(specialUrl), url: specialUrl, source: 'banner' };
    const classification = await classifyEntry(entry, undefined, {
      hasPeriod: () => hasPeriod(page, context.currentTime),
    });
    await classifyAndLog(context, entry, classification);
    if (classification.status === 'classified' && classification.eventType === 'seasonal-special') {
      await applySeasonalPage(context, specialUrl, page, entry.title);
    }
  }
}

function specialTitleFromPath(url: string): string {
  const last = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? 'Sonderaktion';
  return last.replace(/[_-]+/g, ' ');
}

async function refreshStoredSource(context: CycleContext, event: StoreEvent, source: StoreEventSource): Promise<void> {
  if (context.processedSources.has(source.url)) return;
  context.processedSources.add(source.url);
  const eventId = event.id;
  const sourceMoment = source.publishedAt ?? source.firstSeenAt;

  if (event.eventType === 'seasonal-special' && (source.kind === 'special' || source.kind === 'banner')) {
    const html = await getSpecialPage(context, source.url);
    if (html === undefined) return;
    await applySeasonalPage(context, source.url, html, event.title, undefined, eventId);
    return;
  }

  if (event.eventType === 'maintenance' || source.kind === 'maintenance' || source.kind === 'followup' || source.kind === 'feed') {
    try {
      const html = await fetchDetailPage(source.url, context.fetchText);
      applyExtract(context, eventId, source.url, sourceMoment, extractMaintenance(html, event.title));
    } catch (error) {
      await logSourceFailure(context, source.url, error);
    }
    return;
  }

  if (source.kind === 'topic') {
    const eventEntry: ListEntry = {
      title: event.title,
      url: source.url,
      source: 'topic',
      ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
    };
    await processTopic(context, eventEntry, eventId);
  }
}

async function refreshOpenEvents(context: CycleContext): Promise<void> {
  for (const event of getOpenEvents(context.store, context.currentTime)) {
    for (const source of getEventSources(context.store, event.id)) {
      await refreshStoredSource(context, event, source);
    }
  }
}

async function warnForUncertainFields(context: CycleContext, event: StoreEvent): Promise<void> {
  const fields: Array<[string, string | null]> = [
    ['Titel', event.titleStatus === 'unsicher' ? event.titleReason : null],
    ['Start', event.startStatus === 'unsicher' ? event.startReason : null],
    ['Ende', event.endStatus === 'unsicher' ? event.endReason : null],
    ['Belohnungen', event.rewardsStatus === 'unsicher' ? event.rewardsReason : null],
    ['Beschreibung', event.descriptionStatus === 'unsicher' ? event.descriptionReason : null],
  ];
  for (const [field, reason] of fields) {
    if (reason) await logWarning(context, `event:${event.id}:field:${field}`, `Unsicheres Feld „${field}“ bei „${event.title}“: ${reason}`);
  }
}

async function logHealthTransition(context: CycleContext): Promise<void> {
  const health = context.health.state();
  const transition = health.transition;
  if (!transition) return;
  if (transition.type === 'blind') {
    await logWarning(context, `health:blind:${transition.atUtc}`, `Lodestone nicht lesbar seit ${transition.atUtc}.`);
  } else {
    await logWarning(context, `health:recovered:${transition.atUtc}`, 'Entwarnung: Lodestone ist wieder lesbar.');
  }
}

async function runWikiCrossCheck(context: CycleContext): Promise<void> {
  const day = context.currentTime.toISOString().slice(0, 10);
  if (getMetaValue(context.store, 'wiki_checked_utc_day') === day) return;
  setMetaValue(context.store, 'wiki_checked_utc_day', day);
  const knownEvents = getAllEvents(context.store).map((event) => ({
    title: event.title,
    ...(event.startStatus === 'ok' && event.startUtc ? { startUtc: event.startUtc } : {}),
    ...(event.endStatus === 'ok' && event.endUtc ? { endUtc: event.endUtc } : {}),
  }));
  const result = await runDailyWikiCrossCheck(context.fetchText, knownEvents, context.currentTime);
  if (!result.ok) {
    await logWarning(context, `wiki:failure:${day}`, `Wiki-Gegenprüfung fehlgeschlagen: ${result.reason}`);
    return;
  }
  for (const event of result.unmatched) {
    const eventName = event.name;
    await logWarning(
      context,
      `wiki:mismatch:${day}:${eventName}`,
      `Wiki-Gegenprüfung: „${eventName}“ ist als laufendes Event im Wiki vermerkt, aber im Lodestone-Abgleich nicht zugeordnet.`,
    );
  }
}

function shouldPost(event: StoreEvent, now: Date, firstRun: boolean, firstRunSuppressed: ReadonlySet<number>): boolean {
  if (firstRun) return event.endStatus === 'ok' && event.endUtc !== null && Date.parse(event.endUtc) > now.getTime();
  if (event.discordMessageId !== null) return true;
  if (firstRunSuppressed.has(event.id)) {
    return event.endStatus === 'ok' && event.endUtc !== null && Date.parse(event.endUtc) > now.getTime();
  }
  return event.endStatus === 'unsicher' || (event.endUtc !== null && Date.parse(event.endUtc) > now.getTime());
}

async function syncEvents(
  context: CycleContext,
  firstRun: boolean,
  blind: boolean,
  firstRunSuppressed: ReadonlySet<number>,
): Promise<number> {
  const candidates = getOpenEvents(context.store, context.currentTime)
    .filter((event) => shouldPost(event, context.currentTime, firstRun, firstRunSuppressed));
  if (blind) return 0;
  let posted = 0;
  for (const event of candidates) {
    const sourceUrls = getEventSources(context.store, event.id).map((source) => source.url);
    await syncEventEmbed({
      event,
      sourceUrls,
      channelId: context.eventChannelId,
      logChannelId: context.logChannelId,
      discord: context.discord,
      store: context.store,
      now: context.currentTime,
    });
    await syncScheduledEvent({
      event,
      sourceUrls,
      guildId: context.guildId,
      discord: context.discord,
      store: context.store,
      now: context.currentTime,
    });
    posted += 1;
  }
  return posted;
}

export async function runCycle(options: CycleOptions): Promise<CycleResult> {
  const currentTime = options.now?.() ?? new Date();
  const context: CycleContext = {
    ...options,
    health: options.health ?? new SourceHealthMonitor(options.store),
    currentTime,
    processedSources: new Set(),
    capturedEventIds: new Set(),
    specialPages: new Map(),
  };
  const firstRun = isFirstRun(context.store);
  const lists = await readLists(context, firstRun);
  const health = context.health.recordCycleHealth(lists.counts, lists.succeeded, currentTime);
  await logHealthTransition(context);

  if (!health.isBlind) {
    for (const entry of combinedEntries(lists)) await processEntry(context, entry);
    await processBannerRail(context, lists.bannerHtml);
    await refreshOpenEvents(context);
  }

  const firstRunSuppressed = new Set<number>(JSON.parse(getMetaValue(context.store, 'first_run_suppressed_event_ids') ?? '[]') as number[]);
  if (firstRun && !health.isBlind) {
    for (const event of getAllEvents(context.store)) {
      if (!context.capturedEventIds.has(event.id)) continue;
      if (event.endStatus !== 'ok' || event.endUtc === null || Date.parse(event.endUtc) <= currentTime.getTime()) {
        firstRunSuppressed.add(event.id);
      }
    }
    setMetaValue(context.store, 'first_run_suppressed_event_ids', JSON.stringify([...firstRunSuppressed]));
  }

  const postedEvents = await syncEvents(context, firstRun, health.isBlind, firstRunSuppressed);
  for (const event of getAllEvents(context.store)) await warnForUncertainFields(context, event);
  const liveEvents = getOpenEvents(context.store, currentTime);
  await syncLiveStatusPost({
    guildId: context.guildId,
    channelId: context.eventChannelId,
    logChannelId: context.logChannelId,
    events: liveEvents,
    discord: context.discord,
    store: context.store,
    now: currentTime,
  });

  await runWikiCrossCheck(context);
  if (firstRun && lists.succeeded && !health.isBlind) {
    if (warnOnce(context.store, 'first-run:summary')) {
      await context.discord.sendLog(context.logChannelId, `Erststart: ${context.capturedEventIds.size} erfasst, ${postedEvents} gepostet`);
    }
    markFirstRunDone(context.store);
  }

  return {
    firstRun,
    capturedEvents: context.capturedEventIds.size,
    postedEvents,
    blind: health.isBlind,
  };
}
