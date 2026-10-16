// Orchestrates source discovery, extraction, storage, health, and Discord synchronization.

import { load } from 'cheerio';
import {
  applyField,
  attachSource,
  createEvent,
  deliverWarning,
  getConfiguredGuilds,
  findEventByKey,
  findEventBySourceUrl,
  getAllEvents,
  getEventSources,
  getFieldProvenanceSourceUrl,
  getMetaValue,
  getOpenEvents,
  getGuildEventObject,
  getGuild,
  getPendingWarnings,
  markGuildFirstRunDone,
  markGuildEventFirstRunSuppressed,
  markGuildNeedsSetup,
  markFirstRunDone,
  markSeen,
  setMetaValue,
  setGuildEventSyncStatus,
  setEventImageUrl,
  type Store,
  type StoreEvent,
  type StoreEventSource,
  type StoredGuild,
} from './store.ts';
import { classifyEntry, maintenanceStem, maintenanceTarget } from './classify.ts';
import { extractGenericTopic, deriveGenericEventKey } from './extractors/generic.ts';
import { extractMaintenance } from './extractors/maintenance.ts';
import { extractSeasonal, extractSeasonalPeriod, hasDeclaredPeriod, hasPeriod } from './extractors/seasonal.ts';
import { fetchNewsFeed, parseNewsFeed } from './sources/feed.ts';
import {
  articleBodyLinks,
  articleRelatedLinks,
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
import { withGuildDiscordLock } from './guild-lock.ts';
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
  guilds?: CycleGuild[];
  now?: () => Date;
  health?: SourceHealthMonitor;
  skipGlobalFirstRunMark?: boolean;
}

export interface CycleGuild {
  guildId: string;
  eventChannelId: string;
  logChannelId: string;
  firstRun: boolean;
}

export interface CycleResult {
  firstRun: boolean;
  capturedEvents: number;
  postedEvents: number;
  blind: boolean;
}

interface CycleContext extends Omit<CycleOptions, 'health'> {
  health: SourceHealthMonitor;
  clock: () => Date;
  currentTime: Date;
  firstRun: boolean;
  guilds: CycleGuild[];
  processedSources: Set<string>;
  capturedEventIds: Set<number>;
  unclassifiedUrls: Set<string>;
  ignoredUrls: Set<string>;
  processedMaintenanceOriginals: Map<string, number>;
  pendingFollowupWarnings: Array<{ eventId: number; entry: ListEntry; ambiguity: 'missing' | 'multiple' }>;
  specialPages: Map<string, Promise<string | undefined>>;
  pendingDiscoveries: Map<string, PendingDiscovery>;
}

interface PendingDiscovery {
  entry: ListEntry;
  firstRun: boolean;
  firstRunGuildIds?: string[];
}

interface ApplyExtractOptions {
  periodSourceUrl?: string;
  periodSourceMoment?: string;
  rewardsApplicable?: boolean;
  skipPeriod?: boolean;
}

interface LoadedLists {
  maintenanceEntries: ReturnType<typeof parseMaintenanceList>;
  topicEntries: ReturnType<typeof parseTopicList>;
  bannerHtml?: string;
  feedEntries: ReturnType<typeof parseNewsFeed>;
  counts: number[];
  succeeded: boolean;
}

const PENDING_DISCOVERIES_META = 'pending_discoveries';

function loadPendingDiscoveries(store: Store): Map<string, PendingDiscovery> {
  const pending = new Map<string, PendingDiscovery>();
  const raw = getMetaValue(store, PENDING_DISCOVERIES_META);
  if (!raw) return pending;
  try {
    const records = JSON.parse(raw) as unknown;
    if (!Array.isArray(records)) return pending;
    for (const value of records) {
      if (typeof value !== 'object' || value === null || !('entry' in value) || !('firstRun' in value)) continue;
      const record = value as PendingDiscovery;
      if (typeof record.firstRun !== 'boolean' || !record.entry || typeof record.entry.url !== 'string'
        || typeof record.entry.title !== 'string'
        || !['topic', 'maintenance', 'feed', 'banner'].includes(record.entry.source)) continue;
      const entry = { ...record.entry, url: normalizeLodestoneUrl(record.entry.url) };
      pending.set(entry.url, {
        entry,
        firstRun: record.firstRun,
        firstRunGuildIds: Array.isArray(record.firstRunGuildIds)
          ? record.firstRunGuildIds.filter((guildId): guildId is string => typeof guildId === 'string')
          : [],
      });
    }
  } catch {
    return pending;
  }
  return pending;
}

function persistPendingDiscoveries(context: CycleContext): void {
  setMetaValue(context.store, PENDING_DISCOVERIES_META, JSON.stringify([...context.pendingDiscoveries.values()]));
}

function rememberPendingDiscovery(context: CycleContext, entry: ListEntry): void {
  const normalizedEntry = { ...entry, url: normalizeLodestoneUrl(entry.url) };
  const previous = context.pendingDiscoveries.get(normalizedEntry.url);
  const firstRunGuildIds = new Set(previous?.firstRunGuildIds ?? []);
  for (const guild of context.guilds) if (guild.firstRun) firstRunGuildIds.add(guild.guildId);
  context.pendingDiscoveries.set(normalizedEntry.url, {
    entry: normalizedEntry,
    firstRun: firstRunGuildIds.size > 0,
    firstRunGuildIds: [...firstRunGuildIds],
  });
  persistPendingDiscoveries(context);
}

function finishPendingDiscovery(context: CycleContext, url: string, eventId?: number): void {
  const normalizedUrl = normalizeLodestoneUrl(url);
  const pending = context.pendingDiscoveries.get(normalizedUrl);
  if (!pending) return;
  context.pendingDiscoveries.delete(normalizedUrl);
  persistPendingDiscoveries(context);

  if (!pending.firstRun || eventId === undefined) return;
  const event = getAllEvents(context.store).find((candidate) => candidate.id === eventId);
  if (!event || (event.endStatus === 'ok' && event.endUtc !== null
    && Date.parse(event.endUtc) > context.currentTime.getTime())) return;
  for (const guildId of pending.firstRunGuildIds ?? []) {
    markGuildEventFirstRunSuppressed(context.store, guildId, event.eventKey);
  }
}

function sourceKind(entry: ListEntry): StoreEventSource['kind'] {
  if (/^\[Folge-News\]/i.test(entry.title)) return 'followup';
  if (entry.source === 'feed' && /^\[Wartung\]/i.test(entry.title)) return 'maintenance';
  if (entry.source === 'maintenance' || entry.source === 'topic') return entry.source;
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
    return new URL(normalizeLodestoneUrl(value)).pathname.startsWith('/lodestone/special/');
  } catch {
    return false;
  }
}

function titleFromPage(html: string): string {
  const raw = load(html)('title').first().text().trim();
  return raw.replace(/\s*\|\s*FINAL FANTASY XIV(?:,\s*|\s*-\s*)Der Lodestone\s*$/i, '').trim();
}

function titleFromUrl(value: string): string {
  const path = new URL(normalizeLodestoneUrl(value)).pathname;
  const segment = path.split('/').filter(Boolean).at(-1) ?? path;
  try {
    return decodeURIComponent(segment).replace(/[_-]+/g, ' ').trim() || path;
  } catch {
    return segment.replace(/[_-]+/g, ' ').trim() || path;
  }
}

function displayEntryTitle(entry: ListEntry, html?: string): string {
  return entry.title.trim() || (html === undefined ? '' : titleFromPage(html)) || titleFromUrl(entry.url);
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

async function logWarning(context: CycleContext, key: string, message: string, targetGuildId?: string): Promise<void> {
  const recipients = targetGuildId === undefined
    ? context.guilds
    : context.guilds.filter((guild) => guild.guildId === targetGuildId);
  for (const guild of recipients) {
    try {
      await withGuildDiscordLock(guild.guildId, () => deliverWarning(context.store, guild.guildId, guild.logChannelId, key, message,
        (channelId, content) => context.discord.sendLog(channelId, content)));
    } catch (error) {
      console.warn(`Log-Meldung für Server ${guild.guildId} konnte nicht gesendet werden.`, error);
    }
  }
}

async function logWarningToEstablishedGuilds(context: CycleContext, key: string, message: string): Promise<void> {
  for (const guild of context.guilds.filter((candidate) => !candidate.firstRun)) {
    try {
      await deliverWarning(context.store, guild.guildId, guild.logChannelId, key, message,
        (channelId, content) => context.discord.sendLog(channelId, content));
    } catch (error) {
      console.warn(`Log-Meldung für Server ${guild.guildId} konnte nicht gesendet werden.`, error);
    }
  }
}

async function logSourceFailure(context: CycleContext, url: string, error: unknown): Promise<void> {
  void error;
  if (context.guilds.every((guild) => guild.firstRun)) return;
  const normalizedUrl = normalizeLodestoneUrl(url);
  const pending = context.pendingDiscoveries.get(normalizedUrl);
  if (pending?.firstRun && context.guilds.every((guild) => pending.firstRunGuildIds?.includes(guild.guildId))) return;
  const eventId = findEventBySourceUrl(context.store, normalizedUrl);
  if (eventId !== undefined) {
    const suppressedIds = new Set<number>(JSON.parse(getMetaValue(context.store, 'first_run_suppressed_event_ids') ?? '[]') as number[]);
    const event = getAllEvents(context.store).find((candidate) => candidate.id === eventId);
    if (suppressedIds.has(eventId) && (!event || event.endStatus !== 'ok' || !event.endUtc
      || Date.parse(event.endUtc) <= context.currentTime.getTime())) return;
  }
  await logWarningToEstablishedGuilds(context, `source-failure:${url}`, `Die Lodestone-Quelle ist nicht abrufbar: ${url}.`);
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
  options: ApplyExtractOptions = {},
): void {
  applyStatus(context, eventId, 'title', result.title, sourceUrl, sourceMoment);
  const periodSourceUrl = options.periodSourceUrl ?? sourceUrl;
  const periodSourceMoment = options.periodSourceMoment ?? sourceMoment;
  if (!options.skipPeriod) {
    if (result.period.status === 'ok') {
      applyField(context.store, eventId, 'start', { status: 'ok', value: result.period.value.startUtc }, periodSourceUrl, periodSourceMoment);
      applyField(context.store, eventId, 'end', { status: 'ok', value: result.period.value.endUtc }, periodSourceUrl, periodSourceMoment);
    } else {
      applyField(context.store, eventId, 'start', { status: 'unsicher', reason: result.period.reason }, periodSourceUrl, periodSourceMoment);
      applyField(context.store, eventId, 'end', { status: 'unsicher', reason: result.period.reason }, periodSourceUrl, periodSourceMoment);
    }
  }
  if (options.rewardsApplicable !== false && result.rewards.status !== 'n/a') {
    applyStatus(context, eventId, 'rewards', result.rewards, sourceUrl, sourceMoment);
  }
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
  topicHtml?: string,
): Promise<number> {
  const normalizedSpecialUrl = normalizeLodestoneUrl(sourceUrl);
  const specialPath = new URL(normalizedSpecialUrl).pathname;
  const key = `seasonal-special:${specialPath}`;
  const sourceMoment = topicEntry ? publishedAt(topicEntry, context.currentTime) : context.currentTime.toISOString();
  const result = await extractSeasonal(html, context.currentTime, { fetchText: context.fetchText, store: context.store });
  let periodResult = extractSeasonalPeriod(html, context.currentTime);
  let periodSourceUrl = normalizedSpecialUrl;
  let periodSourceMoment = sourceMoment;
  const specialHasPeriod = periodResult.periods.status === 'unsicher' || periodResult.periods.value.length > 0;
  const sourceEventId = preferredEventId ?? findEventBySourceUrl(context.store, normalizedSpecialUrl) ?? findEventByKey(context.store, key);
  const originalPeriodSource = sourceEventId === undefined
    ? undefined
    : getFieldProvenanceSourceUrl(context.store, sourceEventId, 'end');
  const topicOwnsPeriod = topicEntry !== undefined && originalPeriodSource === normalizeLodestoneUrl(topicEntry.url);
  let skipPeriod = false;
  if (topicEntry && !specialHasPeriod && topicHtml !== undefined) {
    const topicPeriodResult = extractSeasonalPeriod(topicHtml, context.currentTime);
    const topicHasPeriod = topicPeriodResult.periods.status === 'unsicher' || topicPeriodResult.periods.value.length > 0;
    if (topicHasPeriod || topicOwnsPeriod) {
      periodResult = topicPeriodResult;
      periodSourceUrl = normalizeLodestoneUrl(topicEntry.url);
      periodSourceMoment = publishedAt(topicEntry, context.currentTime);
    }
  } else if (topicEntry && topicOwnsPeriod && !specialHasPeriod) {
    skipPeriod = true;
  }
  const eventSourceId = findEventBySourceUrl(context.store, normalizedSpecialUrl);
  const keyedEventId = findEventByKey(context.store, key);
  const existingEvent = getAllEvents(context.store).find((event) =>
    event.id === (eventSourceId ?? keyedEventId ?? preferredEventId),
  );
  const suggestedTitle = result.title.status === 'ok'
    ? result.title.value
    : fallbackTitle.trim() || existingEvent?.title || titleFromUrl(normalizedSpecialUrl);
  const eventId = eventForType(context, key, 'seasonal-special', suggestedTitle, normalizedSpecialUrl, preferredEventId);
  setEventImageUrl(context.store, eventId, result.imageUrl);

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
  const combinedResult = { ...result, ...periodResult };
  const terminalPeriod = combinedResult.eventState.status === 'ok' && combinedResult.eventState.value === 'ended'
    && combinedResult.periods.status === 'ok'
    ? [...combinedResult.periods.value]
      .filter((period) => period.endUtc !== null && Date.parse(period.endUtc) <= context.currentTime.getTime())
      .sort((left, right) => Date.parse(right.endUtc!) - Date.parse(left.endUtc!))[0]
    : undefined;
  const persistedResult = terminalPeriod
    ? { ...combinedResult, period: { status: 'ok' as const, value: { startUtc: terminalPeriod.startUtc, endUtc: terminalPeriod.endUtc! } } }
    : combinedResult;
  applyExtract(context, eventId, normalizedSpecialUrl, sourceMoment, persistedResult, { periodSourceUrl, periodSourceMoment, skipPeriod });
  rememberEvent(context, eventId);
  finishPendingDiscovery(context, normalizedSpecialUrl, eventId);
  return eventId;
}

async function classifyAndLog(
  context: CycleContext,
  entry: ListEntry,
  classification: Classification,
): Promise<void> {
  const unresolvedShortLink = classification.status === 'unclassified'
    && classification.reason === 'Ein Kurzlink konnte nicht aufgelöst werden.';
  const newlySeen = unresolvedShortLink
    ? false
    : markSeen(context.store, normalizeLodestoneUrl(entry.url), classification.status, context.currentTime.toISOString());
  const title = displayEntryTitle(entry);
  const hasEstablishedGuild = context.guilds.some((guild) => !guild.firstRun);
  if (classification.status === 'unclassified') {
    context.unclassifiedUrls.add(normalizeLodestoneUrl(entry.url));
    if (unresolvedShortLink || newlySeen || hasEstablishedGuild) {
      const message = unresolvedShortLink
        ? `Kurzlink konnte nicht aufgelöst werden: „${title}“ (${normalizeLodestoneUrl(entry.url)})`
        : `Nicht klassifiziert: ${title} (${normalizeLodestoneUrl(entry.url)})`;
      await logWarningToEstablishedGuilds(context, `${unresolvedShortLink ? 'short-link-unresolved' : 'unclassified'}:${normalizeLodestoneUrl(entry.url)}`, message);
    }
  } else if (classification.status === 'ignored') {
    context.ignoredUrls.add(normalizeLodestoneUrl(entry.url));
    if (entry.source === 'banner' && (newlySeen || hasEstablishedGuild)) {
      await logWarningToEstablishedGuilds(
        context,
        `ignored-banner:${normalizeLodestoneUrl(entry.url)}`,
        `Nicht berücksichtigt: ${title} (${normalizeLodestoneUrl(entry.url)}) — ${classification.reason}`,
      );
    }
  }
}

function findMaintenanceMatch(context: CycleContext, entry: ListEntry): { eventId?: number; ambiguity?: 'missing' | 'multiple' } {
  const stem = maintenanceStem(entry.title);
  const target = maintenanceTarget(entry.title) ?? 'unknown';
  const sameCycleOriginal = context.processedMaintenanceOriginals.get(`${target}\u0000${stem}`);
  if (sameCycleOriginal !== undefined) return { eventId: sameCycleOriginal };
  const matches = getOpenEvents(context.store, context.currentTime)
    .filter((event) => {
      if (event.eventType !== 'maintenance' || maintenanceStem(event.title) !== stem) return false;
      const eventTarget = /^maintenance:([^:]+):/.exec(event.eventKey)?.[1]
        ?? maintenanceTarget(event.title)
        ?? 'unknown';
      return eventTarget === target;
    });
  if (matches.length === 1) return { eventId: matches[0]!.id };
  if (matches.length > 1) return { ambiguity: 'multiple' };
  return { ambiguity: 'missing' };
}

async function explicitMaintenanceTarget(context: CycleContext, html: string): Promise<number | undefined> {
  const resolution = await resolveShortLinks([...articleBodyLinks(html), ...articleRelatedLinks(html)], context.fetchText);
  const targets = new Set<number>();
  for (const link of resolution.links) {
    if (link === undefined) continue;
    const targetId = findEventBySourceUrl(context.store, normalizeLodestoneUrl(link));
    if (targetId === undefined) continue;
    const targetEvent = getAllEvents(context.store).find((event) => event.id === targetId);
    if (targetEvent?.eventType === 'maintenance') targets.add(targetId);
  }
  return targets.size === 1 ? [...targets][0] : undefined;
}

async function processMaintenance(
  context: CycleContext,
  entry: ListEntry,
  preferredEventId?: number,
): Promise<number | undefined> {
  const sourceUrl = normalizeLodestoneUrl(entry.url);
  const classification = await classifyEntry(entry, undefined, { hasPeriod: () => 'no' });
  await classifyAndLog(context, entry, classification);
  context.processedSources.add(entry.url);
  if (classification.status !== 'classified') {
    finishPendingDiscovery(context, sourceUrl);
    return undefined;
  }

  let detailHtml: string | undefined;
  try {
    detailHtml = await fetchDetailPage(sourceUrl, context.fetchText);
  } catch (error) {
    await logSourceFailure(context, sourceUrl, error);
  }
  const isFollowup = /^\[Folge-News\]/i.test(entry.title);
  const linkedTargetId = detailHtml === undefined ? undefined : await explicitMaintenanceTarget(context, detailHtml);
  const match = findMaintenanceMatch(context, entry);
  let targetId = preferredEventId ?? findEventBySourceUrl(context.store, sourceUrl) ?? linkedTargetId ?? match.eventId;
  let followupWarning: 'missing' | 'multiple' | undefined;
  if (isFollowup && targetId === undefined && match.ambiguity) {
    followupWarning = match.ambiguity;
    const key = match.ambiguity === 'multiple' ? `maintenance:followup:ambiguous:${entry.url}` : `maintenance:followup:${entry.url}`;
    targetId = eventForType(context, key, 'maintenance', entry.title, entry.url);
  }

  const stem = maintenanceStem(entry.title);
  const target = maintenanceTarget(entry.title) ?? 'unknown';
  const eventKey = isFollowup ? `maintenance:followup:${sourceUrl}` : `maintenance:${target}:${stem}`;
  const alreadyKnown = findEventBySourceUrl(context.store, sourceUrl) !== undefined ||
    targetId !== undefined || findEventByKey(context.store, eventKey) !== undefined;
  const eventId = eventForType(context, eventKey, 'maintenance', entry.title, sourceUrl, targetId);
  if (!isFollowup) context.processedMaintenanceOriginals.set(`${target}\u0000${stem}`, eventId);
  if (isFollowup && followupWarning === undefined) {
    const attachedOriginal = getEventSources(context.store, eventId)
      .some((source) => source.kind === 'maintenance' || source.kind === 'feed');
    const processedOriginal = [...context.processedMaintenanceOriginals.values()].includes(eventId);
    if (!attachedOriginal && !processedOriginal) followupWarning = 'missing';
  }
  if (followupWarning) context.pendingFollowupWarnings.push({ eventId, entry, ambiguity: followupWarning });
  const kind = sourceKind(entry);
  attachSource(context.store, {
    eventId,
    url: sourceUrl,
    kind,
    publishedAt: entry.publishedAt ?? (entry.publishedEpoch === undefined ? undefined : new Date(entry.publishedEpoch * 1_000).toISOString()),
    firstSeenAt: context.currentTime.toISOString(),
  });

  if (detailHtml !== undefined) {
    const result = extractMaintenance(detailHtml, entry.title);
    applyExtract(context, eventId, sourceUrl, publishedAt(entry, context.currentTime), result, { rewardsApplicable: false });
    finishPendingDiscovery(context, sourceUrl, eventId);
  } else {
    if (!alreadyKnown) {
      const reason = 'Die Detailseite konnte nicht gelesen werden.';
      applyField(context.store, eventId, 'start', { status: 'unsicher', reason }, sourceUrl, publishedAt(entry, context.currentTime));
      applyField(context.store, eventId, 'end', { status: 'unsicher', reason }, sourceUrl, publishedAt(entry, context.currentTime));
    }
    rememberPendingDiscovery(context, entry);
  }
  rememberEvent(context, eventId);
  return eventId;
}

async function processTopic(
  context: CycleContext,
  entry: ListEntry,
  preferredEventId?: number,
): Promise<number | undefined> {
  const sourceUrl = normalizeLodestoneUrl(entry.url);
  let detailHtml: string;
  try {
    detailHtml = await fetchDetailPage(sourceUrl, context.fetchText);
  } catch (error) {
    context.processedSources.add(entry.url);
    await logSourceFailure(context, sourceUrl, error);
    rememberPendingDiscovery(context, entry);
    return undefined;
  }

  const articleLinks = articleBodyLinks(detailHtml);
  const linkResolution = await resolveShortLinks(articleLinks, context.fetchText);
  const specialUrls = [...new Set(linkResolution.links
    .filter((link): link is string => link !== undefined)
    .map(normalizeLodestoneUrl)
    .filter(isSpecialUrl))];
  const specialHtmlByPath = new Map<string, string>();
  for (const url of specialUrls) {
    const html = await getSpecialPage(context, url);
    if (html !== undefined) specialHtmlByPath.set(new URL(url).pathname, html);
  }

  if (specialUrls.some((url) => !specialHtmlByPath.has(new URL(url).pathname))) {
    context.processedSources.add(entry.url);
    rememberPendingDiscovery(context, entry);
    return undefined;
  }

  const classification = await classifyEntry(entry, detailHtml, {
    resolvedLinks: linkResolution,
    topicPeriod: hasDeclaredPeriod(detailHtml, context.currentTime),
    hasPeriod: (path) => {
      const html = specialHtmlByPath.get(path);
      return html === undefined ? 'no' : hasPeriod(html, context.currentTime);
    },
  });
  await classifyAndLog(context, entry, classification);
  context.processedSources.add(entry.url);
  if (classification.status !== 'classified') {
    if (classification.status === 'unclassified' && classification.reason === 'Ein Kurzlink konnte nicht aufgelöst werden.') {
      rememberPendingDiscovery(context, entry);
    } else {
      finishPendingDiscovery(context, sourceUrl);
    }
    return undefined;
  }

  if (classification.eventType === 'seasonal-special') {
    const specialUrl = specialUrls.find((url) => {
      const html = specialHtmlByPath.get(new URL(url).pathname);
      return html !== undefined && hasPeriod(html, context.currentTime) !== 'no';
    }) ?? (hasPeriod(detailHtml, context.currentTime) !== 'no' ? specialUrls[0] : undefined);
    if (specialUrl === undefined) {
      rememberPendingDiscovery(context, entry);
      return undefined;
    }
    const eventId = await applySeasonalPage(
      context,
      specialUrl,
      specialHtmlByPath.get(new URL(specialUrl).pathname)!,
      entry.title,
      entry,
      preferredEventId ?? findEventBySourceUrl(context.store, entry.url),
      detailHtml,
    );
    finishPendingDiscovery(context, sourceUrl, eventId);
    return eventId;
  }

  const keyText = deriveGenericEventKey(entry, detailHtml);
  const eventKey = 'generic:' + keyText;
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
  finishPendingDiscovery(context, sourceUrl, eventId);
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
  finishPendingDiscovery(context, entry.url);
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
  return [...candidates.values()].map((entry, index) => ({ entry, index })).sort((left, right) => {
    const moment = (entry: ListEntry): number | undefined => {
      if (entry.publishedEpoch !== undefined && Number.isFinite(entry.publishedEpoch)) return entry.publishedEpoch;
      if (entry.publishedAt) {
        const parsed = Date.parse(entry.publishedAt);
        if (Number.isFinite(parsed)) return parsed / 1_000;
      }
      return undefined;
    };
    const leftMoment = moment(left.entry);
    const rightMoment = moment(right.entry);
    if (leftMoment !== undefined && rightMoment !== undefined && leftMoment !== rightMoment) return leftMoment - rightMoment;

    const leftFollowup = /^\[Folge-News\]/i.test(left.entry.title);
    const rightFollowup = /^\[Folge-News\]/i.test(right.entry.title);
    if (leftFollowup !== rightFollowup) return leftFollowup ? 1 : -1;
    if (leftMoment !== undefined && rightMoment !== undefined) return left.index - right.index;
    return right.index - left.index;
  }).map(({ entry }) => entry);
}

async function processBannerRail(context: CycleContext, html: string | undefined): Promise<void> {
  const entries = new Map<string, ListEntry>();
  for (const pending of context.pendingDiscoveries.values()) {
    if (pending.entry.source === 'banner') entries.set(pending.entry.url, pending.entry);
  }
  for (const path of html ? parseBannerRail(html) : []) {
    const specialUrl = normalizeLodestoneUrl(path);
    entries.set(specialUrl, { title: '', url: specialUrl, source: 'banner' });
  }
  for (const entry of entries.values()) {
    const specialUrl = normalizeLodestoneUrl(entry.url);
    if (context.processedSources.has(specialUrl)) {
      finishPendingDiscovery(context, specialUrl);
      continue;
    }
    const page = await getSpecialPage(context, specialUrl);
    if (page === undefined) {
      rememberPendingDiscovery(context, entry);
      continue;
    }
    context.processedSources.add(specialUrl);
    const displayEntry = { ...entry, title: displayEntryTitle(entry, page) };
    const classification = await classifyEntry(displayEntry, undefined, {
      hasPeriod: () => hasPeriod(page, context.currentTime),
    });
    await classifyAndLog(context, displayEntry, classification);
    if (classification.status === 'classified' && classification.eventType === 'seasonal-special') {
      const eventId = await applySeasonalPage(context, specialUrl, page, displayEntry.title);
      finishPendingDiscovery(context, specialUrl, eventId);
    } else {
      finishPendingDiscovery(context, specialUrl);
    }
  }
}

async function refreshStoredSource(context: CycleContext, event: StoreEvent, source: StoreEventSource): Promise<void> {
  if (context.processedSources.has(source.url)) return;
  context.processedSources.add(source.url);
  const eventId = event.id;
  const sourceMoment = source.publishedAt ?? source.firstSeenAt;

  if (event.eventType === 'seasonal-special' && (source.kind === 'special' || source.kind === 'banner')) {
    const html = await getSpecialPage(context, source.url);
    if (html === undefined) return;
    const periodSourceUrl = getFieldProvenanceSourceUrl(context.store, eventId, 'end');
    const topicSource = periodSourceUrl === undefined ? undefined : getEventSources(context.store, eventId)
      .find((candidate) => candidate.kind === 'topic' && normalizeLodestoneUrl(candidate.url) === periodSourceUrl);
    if (topicSource) {
      const topicEntry: ListEntry = {
        title: event.title,
        url: topicSource.url,
        source: 'topic',
        ...(topicSource.publishedAt ? { publishedAt: topicSource.publishedAt } : {}),
      };
      let topicHtml: string | undefined;
      try {
        topicHtml = await fetchDetailPage(topicSource.url, context.fetchText);
      } catch (error) {
        await logSourceFailure(context, topicSource.url, error);
      }
      await applySeasonalPage(context, source.url, html, event.title, topicEntry, eventId, topicHtml);
    } else {
      await applySeasonalPage(context, source.url, html, event.title, undefined, eventId);
    }
    return;
  }

  if (event.eventType === 'maintenance' || source.kind === 'maintenance' || source.kind === 'followup' || source.kind === 'feed') {
    try {
      const html = await fetchDetailPage(source.url, context.fetchText);
      applyExtract(context, eventId, source.url, sourceMoment, extractMaintenance(html, event.title), { rewardsApplicable: false });
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

async function warnForUnmatchedFollowups(context: CycleContext): Promise<void> {
  for (const pending of context.pendingFollowupWarnings) {
    const event = getAllEvents(context.store).find((candidate) => candidate.id === pending.eventId);
    if (context.firstRun && (!event || event.endStatus !== 'ok' || !event.endUtc || Date.parse(event.endUtc) <= context.currentTime.getTime())) {
      continue;
    }
    const sources = getEventSources(context.store, pending.eventId);
    const originalWasProcessed = [...context.processedMaintenanceOriginals.values()].includes(pending.eventId);
    const originalIsAttached = sources.some((source) => source.kind === 'maintenance' || source.kind === 'feed');
    if (originalWasProcessed || originalIsAttached) continue;

    const message = pending.ambiguity === 'multiple'
      ? `Folge-News mehrdeutig: ${displayEntryTitle(pending.entry)} (${normalizeLodestoneUrl(pending.entry.url)})`
      : `Folge-News ohne Original: ${displayEntryTitle(pending.entry)} (${normalizeLodestoneUrl(pending.entry.url)})`;
    await logWarning(context, `maintenance-followup:${normalizeLodestoneUrl(pending.entry.url)}`, message);
  }
}

async function warnForUncertainFields(
  context: CycleContext,
  guild: CycleGuild,
  event: StoreEvent,
): Promise<void> {
  const guildEvent = getGuildEventObject(context.store, guild.guildId, event.eventKey);
  const ended = event.endStatus === 'ok' && event.endUtc !== null && Date.parse(event.endUtc) <= context.currentTime.getTime();
  if (ended || (guildEvent?.firstRunSuppressed && !shouldPostToGuild(event, guild.guildId, context.currentTime, false, context.store))
    || (guild.firstRun && !shouldPostToGuild(event, guild.guildId, context.currentTime, true, context.store))) return;

  const fields: Array<[string, string | null]> = [
    ['Titel', event.titleStatus === 'unsicher' ? event.titleReason : null],
    ['Start', event.startStatus === 'unsicher' ? event.startReason : null],
    ['Ende', event.endStatus === 'unsicher' ? event.endReason : null],
    ['Belohnungen', event.rewardsStatus === 'unsicher' ? event.rewardsReason : null],
    ['Beschreibung', event.descriptionStatus === 'unsicher' ? event.descriptionReason : null],
  ];
  for (const [field, reason] of fields) {
    if (reason) {
      await logWarning(context, `event:${event.eventKey}:field:${field}`,
        `Unsicheres Feld „${field}“ bei „${event.titleStatus === 'ok' ? event.title : 'FFXIV-Event'}“: ${reason}`, guild.guildId);
    }
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

function shouldPostToGuild(event: StoreEvent, guildId: string, now: Date, firstRun: boolean, store: Store): boolean {
  const object = getGuildEventObject(store, guildId, event.eventKey);
  if (object?.firstRunSuppressed && !(event.endStatus === 'ok' && event.endUtc !== null && Date.parse(event.endUtc) > now.getTime())) return false;
  if (firstRun) return event.endStatus === 'ok' && event.endUtc !== null && Date.parse(event.endUtc) > now.getTime();
  if (object?.messageId) return true;
  if (event.endUtc !== null && Date.parse(event.endUtc) <= now.getTime()) return false;
  return event.endStatus === 'unsicher' || event.endUtc !== null;
}

async function drainPendingWarnings(context: CycleContext): Promise<void> {
  for (const guild of context.guilds) {
    for (const warning of getPendingWarnings(context.store, guild.guildId)) {
      try {
        await withGuildDiscordLock(guild.guildId, () => deliverWarning(context.store, guild.guildId, guild.logChannelId, warning.key, warning.content,
          (channelId, content) => context.discord.sendLog(channelId, content)));
      } catch (error) {
        console.warn(`Ausstehende Log-Meldung für Server ${guild.guildId} konnte nicht gesendet werden.`, error);
      }
    }
  }
}

async function syncGuildEvents(context: CycleContext, guild: CycleGuild, blind: boolean): Promise<number> {
  const candidates = getOpenEvents(context.store, context.currentTime)
    .filter((event) => shouldPostToGuild(event, guild.guildId, context.currentTime, guild.firstRun, context.store));
  if (blind) return 0;
  let posted = 0;
  for (const event of candidates) {
    const sourceUrls = getEventSources(context.store, event.id).map((source) => source.url);
    const errors: unknown[] = [];
    try {
      await syncEventEmbed({
        event, sourceUrls, guildId: guild.guildId, channelId: guild.eventChannelId,
        discord: context.discord, store: context.store, now: context.currentTime,
      });
    } catch (error) {
      errors.push(error);
    }
    try {
      await syncScheduledEvent({
        event, sourceUrls, guildId: guild.guildId, discord: context.discord,
        store: context.store, now: context.currentTime, clock: context.clock,
      });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      const details = errors.map((error) => error instanceof Error ? error.message : String(error)).join('; ');
      setGuildEventSyncStatus(context.store, guild.guildId, event.eventKey, 'failed', details);
      console.error(`Der Discord-Abgleich für Ereignis ${event.eventKey} ist fehlgeschlagen.`, errors);
      const title = event.titleStatus === 'ok' ? event.title : 'FFXIV-Event';
      await logWarning(context, `guild-event-sync:${event.eventKey}`,
        `Der Discord-Abgleich für „${title}“ konnte nicht abgeschlossen werden. Der Bot versucht es erneut.`, guild.guildId);
    } else {
      setGuildEventSyncStatus(context.store, guild.guildId, event.eventKey, 'synced');
      posted += 1;
    }
  }
  return posted;
}

async function syncGuildStatus(context: CycleContext, guild: CycleGuild, blind: boolean): Promise<void> {
  if (!getGuild(context.store, guild.guildId)) return;
  if (blind) return;
  try {
    await syncLiveStatusPost({
      guildId: guild.guildId,
      channelId: guild.eventChannelId,
      logChannelId: guild.logChannelId,
      events: getOpenEvents(context.store, context.currentTime),
      discord: context.discord,
      store: context.store,
      now: context.currentTime,
      suppressLogs: guild.firstRun,
    });
  } catch (error) {
    console.error(`Die Statusmeldung für Server ${guild.guildId} konnte nicht synchronisiert werden.`, error);
    await logWarning(context, 'status-post:sync-failed',
      'Die Statusmeldung „Läuft gerade“ konnte nicht synchronisiert werden. Der Bot versucht es erneut.', guild.guildId);
  }
}

export async function runCycle(options: CycleOptions): Promise<CycleResult> {
  const clock = options.now ?? (() => new Date());
  const currentTime = clock();
  const configured: CycleGuild[] = options.guilds ?? getConfiguredGuilds(options.store).map((guild: StoredGuild) => ({
    guildId: guild.guildId,
    eventChannelId: guild.eventChannelId!,
    logChannelId: guild.logChannelId!,
    firstRun: !guild.firstRunDone,
  }));
  const guilds: CycleGuild[] = [];
  for (const guild of configured) {
    const validatedGuild = await withGuildDiscordLock(guild.guildId, async () => {
      const storedGuild = getGuild(options.store, guild.guildId);
      if (storedGuild && (storedGuild.needsSetup || storedGuild.eventChannelId !== guild.eventChannelId
        || storedGuild.logChannelId !== guild.logChannelId)) return undefined;
      let eventChannel = false;
      let logChannel = false;
      try {
        [eventChannel, logChannel] = await Promise.all([
          options.discord.isTextChannel(guild.eventChannelId),
          options.discord.isTextChannel(guild.logChannelId),
        ]);
      } catch (error) {
        console.warn(`Die Kanäle für Server ${guild.guildId} konnten vorübergehend nicht geprüft werden.`, error);
        return undefined;
      }
      if (!storedGuild) return undefined;
      if (!eventChannel || !logChannel) {
        markGuildNeedsSetup(options.store, guild.guildId);
        if (!eventChannel && logChannel) {
          try {
            await deliverWarning(options.store, guild.guildId, guild.logChannelId, 'channel-deleted:event',
              'Der Event-Kanal wurde gelöscht. Bitte richte den Bot mit `/ffevents setup` erneut ein.',
              (channelId, content) => options.discord.sendLog(channelId, content));
          } catch (error) {
            console.warn(`Die Setup-Meldung für Server ${guild.guildId} konnte nicht gesendet werden.`, error);
          }
        }
        return undefined;
      }
      return guild;
    });
    if (validatedGuild) guilds.push(validatedGuild);
  }
  const firstRun = guilds.some((guild) => guild.firstRun);
  const context: CycleContext = {
    ...options,
    guilds,
    health: options.health ?? new SourceHealthMonitor(options.store),
    clock,
    currentTime,
    firstRun,
    processedSources: new Set(),
    capturedEventIds: new Set(),
    unclassifiedUrls: new Set(),
    ignoredUrls: new Set(),
    processedMaintenanceOriginals: new Map(),
    pendingFollowupWarnings: [],
    specialPages: new Map(),
    pendingDiscoveries: loadPendingDiscoveries(options.store),
  };
  await drainPendingWarnings(context);
  if (guilds.length === 0) return { firstRun, capturedEvents: 0, postedEvents: 0, blind: false };

  const lists = await readLists(context, firstRun);
  const health = context.health.recordCycleHealth(lists.counts, lists.succeeded, currentTime);
  await logHealthTransition(context);

  if (!health.isBlind) {
    const entries = new Map(combinedEntries(lists).map((entry) => [normalizeLodestoneUrl(entry.url), entry]));
    for (const pending of context.pendingDiscoveries.values()) {
      if (pending.entry.source !== 'banner' && !entries.has(pending.entry.url)) {
        entries.set(pending.entry.url, pending.entry);
      }
    }
    for (const entry of entries.values()) await processEntry(context, entry);
    await processBannerRail(context, lists.bannerHtml);
    await refreshOpenEvents(context);
    await warnForUnmatchedFollowups(context);
  }

  for (const guild of guilds) {
    for (const event of getAllEvents(options.store)) await warnForUncertainFields(context, guild, event);
  }

  let postedEvents = 0;
  for (const guild of guilds) {
    await withGuildDiscordLock(guild.guildId, async () => {
      const currentGuild = getGuild(options.store, guild.guildId);
      if (!currentGuild || currentGuild.needsSetup || currentGuild.eventChannelId !== guild.eventChannelId
        || currentGuild.logChannelId !== guild.logChannelId) return;
      const lockedGuild = { ...guild, firstRun: !currentGuild.firstRunDone };
      if (lockedGuild.firstRun) {
        for (const event of getAllEvents(options.store)) {
          if (!shouldPostToGuild(event, lockedGuild.guildId, context.currentTime, true, options.store)) {
            markGuildEventFirstRunSuppressed(options.store, lockedGuild.guildId, event.eventKey);
          }
        }
      }
      const guildPosted = await syncGuildEvents(context, lockedGuild, health.isBlind);
      postedEvents += guildPosted;
      await syncGuildStatus(context, lockedGuild, health.isBlind);
      if (lockedGuild.firstRun && lists.succeeded && !health.isBlind) {
        try {
          await deliverWarning(options.store, lockedGuild.guildId, lockedGuild.logChannelId, 'first-run:summary',
            `Erststart: ${context.capturedEventIds.size} erfasst, ${guildPosted} gepostet, ${context.unclassifiedUrls.size} unklassifiziert, ${context.ignoredUrls.size} ignoriert`,
            (channelId, content) => options.discord.sendLog(channelId, content));
        } catch (error) {
          console.warn(`Erststart-Bericht für Server ${lockedGuild.guildId} konnte nicht gesendet werden.`, error);
        }
        markGuildFirstRunDone(options.store, lockedGuild.guildId);
      }
    });
  }

  // Explicit guild overrides are used by dry-run and compatibility callers without guild rows.
  if (!options.skipGlobalFirstRunMark && options.guilds && guilds.some((guild) => guild.firstRun) && lists.succeeded && !health.isBlind) {
    markFirstRunDone(options.store);
  }

  await runWikiCrossCheck(context);
  return { firstRun, capturedEvents: context.capturedEventIds.size, postedEvents, blind: health.isBlind };
}

async function runGuildSyncFromStoredDataUnlocked(options: CycleOptions, guildId: string): Promise<void> {
  const storedGuild = getConfiguredGuilds(options.store).find((guild) => guild.guildId === guildId);
  if (!storedGuild) return;
  const guild: CycleGuild = {
    guildId,
    eventChannelId: storedGuild.eventChannelId!,
    logChannelId: storedGuild.logChannelId!,
    firstRun: !storedGuild.firstRunDone,
  };
  let eventChannel: boolean;
  let logChannel: boolean;
  try {
    [eventChannel, logChannel] = await Promise.all([
      options.discord.isTextChannel(guild.eventChannelId),
      options.discord.isTextChannel(guild.logChannelId),
    ]);
  } catch (error) {
    console.warn(`Die Kanäle für Server ${guildId} konnten vorübergehend nicht geprüft werden.`, error);
    return;
  }
  if (!getGuild(options.store, guildId)) return;
  if (!eventChannel || !logChannel) {
    markGuildNeedsSetup(options.store, guildId);
    if (!eventChannel && logChannel) {
      await deliverWarning(options.store, guildId, guild.logChannelId, 'channel-deleted:event',
        'Der Event-Kanal wurde gelöscht. Bitte richte den Bot mit `/ffevents setup` erneut ein.',
        (channelId, content) => options.discord.sendLog(channelId, content));
    }
    return;
  }

  const currentTime = (options.now ?? (() => new Date()))();
  const context: CycleContext = {
    ...options,
    guilds: [guild],
    health: options.health ?? new SourceHealthMonitor(options.store),
    clock: options.now ?? (() => new Date()),
    currentTime,
    firstRun: guild.firstRun,
    processedSources: new Set(),
    capturedEventIds: new Set(),
    unclassifiedUrls: new Set(),
    ignoredUrls: new Set(),
    processedMaintenanceOriginals: new Map(),
    pendingFollowupWarnings: [],
    specialPages: new Map(),
    pendingDiscoveries: loadPendingDiscoveries(options.store),
  };
  await drainPendingWarnings(context);
  for (const event of getAllEvents(options.store)) await warnForUncertainFields(context, guild, event);
  const blind = context.health.isBlind();
  await syncGuildEvents(context, guild, blind);
  await syncGuildStatus(context, guild, blind);
}

export function runGuildSyncFromStoredData(options: CycleOptions, guildId: string): Promise<void> {
  return withGuildDiscordLock(guildId, () => runGuildSyncFromStoredDataUnlocked(options, guildId));
}
