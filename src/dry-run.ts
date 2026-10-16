// Runs the production cycle with a Discord port that only records intended effects.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runCycle, type CycleResult } from './cycle.ts';
import {
  getAllEvents,
  getEventSources,
  getMetaValue,
  isFirstRun,
  deleteGuild,
  upsertGuildSetup,
  type Store,
  type StoreEvent,
} from './store.ts';
import { stableEventIdentity } from './event-identity.ts';
import { scheduledEventPayloadFor, scheduledEventUnavailableReason } from './sync/scheduled.ts';
import type {
  DiscordEmbed,
  DiscordMessagePayload,
  DiscordMessageSnapshot,
  DiscordPort,
  FetchText,
  ScheduledEventPayload,
  ScheduledEventSnapshot,
} from './types.ts';

export interface FetchStatistics {
  requests: number;
  notModified: number;
  failures: number;
  durationMs: number;
  requestTimeMs: number;
  byType: Record<FetchRequestType, number>;
}

export type FetchRequestType =
  | 'lists'
  | 'feed'
  | 'topicDetails'
  | 'maintenanceDetails'
  | 'shortLinks'
  | 'specialPages'
  | 'items'
  | 'wiki';

function emptyRequestTypes(): Record<FetchRequestType, number> {
  return {
    lists: 0,
    feed: 0,
    topicDetails: 0,
    maintenanceDetails: 0,
    shortLinks: 0,
    specialPages: 0,
    items: 0,
    wiki: 0,
  };
}

function requestType(url: string): FetchRequestType {
  const parsed = new URL(url);
  if (parsed.hostname.toLocaleLowerCase('en') === 'sqex.to') return 'shortLinks';
  if (parsed.hostname.toLocaleLowerCase('en') !== 'de.finalfantasyxiv.com') return 'wiki';
  if (parsed.pathname.startsWith('/lodestone/topics/detail/')) return 'topicDetails';
  if (parsed.pathname.startsWith('/lodestone/news/detail/')) return 'maintenanceDetails';
  if (parsed.pathname.startsWith('/lodestone/special/')) return 'specialPages';
  if (parsed.pathname.startsWith('/lodestone/news/news.xml')) return 'feed';
  if (parsed.pathname.startsWith('/lodestone/topics/') || parsed.pathname.startsWith('/lodestone/news/category/')) return 'lists';
  if (parsed.pathname.startsWith('/lodestone/playguide/db/item/')) return 'items';
  return 'wiki';
}

export class FetchMetrics {
  private readonly dumpDir?: string;
  private firstRequestAt: number | undefined;
  private lastRequestAt: number | undefined;
  private requestCount = 0;
  private notModifiedCount = 0;
  private failureCount = 0;
  private requestTime = 0;
  private readonly requestTypes = emptyRequestTypes();

  constructor(dumpDir?: string) {
    this.dumpDir = dumpDir;
  }

  record(url: string, status: number | undefined, body: string, durationMs: number): void {
    const finishedAt = performance.now();
    this.requestCount += 1;
    this.requestTime += durationMs;
    this.requestTypes[requestType(url)] += 1;
    this.firstRequestAt ??= finishedAt - durationMs;
    this.lastRequestAt = finishedAt;
    if (status === 304) this.notModifiedCount += 1;
    if (status === undefined || (status !== 304 && (status < 200 || status >= 300))) this.failureCount += 1;
    if (body && this.dumpDir) this.dump(url, body);
  }

  snapshot(): FetchStatistics {
    return {
      requests: this.requestCount,
      notModified: this.notModifiedCount,
      failures: this.failureCount,
      durationMs: this.firstRequestAt === undefined || this.lastRequestAt === undefined
        ? 0
        : Math.max(0, this.lastRequestAt - this.firstRequestAt),
      requestTimeMs: this.requestTime,
      byType: { ...this.requestTypes },
    };
  }

  private dump(url: string, body: string): void {
    const prefix = body.trimStart().slice(0, 1_000).toLowerCase();
    const isXml = new URL(url).pathname.toLowerCase().endsWith('.xml') ||
      /^<(?:\?xml|feed\b|rss\b)/i.test(prefix);
    const isHtml = /^<(?:!doctype\s+html|html\b|head\b|body\b|article\b)/i.test(prefix);
    if (!isXml && !isHtml) return;

    const parsed = new URL(url);
    const sourceName = `${parsed.hostname}_${parsed.pathname}_${parsed.search}`
      .replace(/[^a-z\d_-]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 96) || 'lodestone';
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 12);
    const filename = `${sourceName}_${hash}.${isXml ? 'xml' : 'html'}`;
    mkdirSync(this.dumpDir!, { recursive: true });
    writeFileSync(join(this.dumpDir!, filename), body, 'utf8');
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

export function createTrackedFetch(
  metrics: FetchMetrics,
  implementation: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await implementation(input, init);
    } catch (error) {
      metrics.record(url, undefined, '', performance.now() - startedAt);
      throw error;
    }

    let body = '';
    try {
      body = await response.clone().text();
    } catch {
      // Keep the successful response usable even if a diagnostic copy cannot be read.
    }
    metrics.record(url, response.status, body, performance.now() - startedAt);
    return response;
  };
}

export type RecordingDiscordAction =
  | { type: 'fetch-messages'; channelId: string; limit: number }
  | { type: 'create-message'; channelId: string; payload: DiscordMessagePayload }
  | { type: 'edit-message'; channelId: string; messageId: string; payload: DiscordMessagePayload }
  | { type: 'pin-message'; channelId: string; messageId: string }
  | { type: 'create-scheduled-event'; guildId: string; payload: ScheduledEventPayload }
  | { type: 'edit-scheduled-event'; guildId: string; eventId: string; payload: ScheduledEventPayload }
  | { type: 'list-scheduled-events'; guildId: string }
  | { type: 'log'; channelId: string; content: string };

function copyEmbed(embed: DiscordEmbed): DiscordEmbed {
  return {
    ...(embed.title === undefined ? {} : { title: embed.title }),
    ...(embed.url === undefined ? {} : { url: embed.url }),
    ...(embed.description === undefined ? {} : { description: embed.description }),
    ...(embed.color === undefined ? {} : { color: embed.color }),
    ...(embed.author === undefined ? {} : { author: { ...embed.author } }),
    ...(embed.image === undefined ? {} : { image: { ...embed.image } }),
    ...(embed.fields === undefined ? {} : {
      fields: embed.fields.map((field) => ({ ...field })),
    }),
    ...(embed.footer === undefined ? {} : { footer: { ...embed.footer } }),
  };
}

function copyPayload(payload: DiscordMessagePayload): DiscordMessagePayload {
  return {
    ...(payload.content === undefined ? {} : { content: payload.content }),
    ...(payload.embeds === undefined ? {} : { embeds: payload.embeds.map(copyEmbed) }),
    ...(payload.components === undefined ? {} : { components: payload.components.map((row) => ({
      components: row.components.map((component) => component.type === 'button' ? { ...component } : {
        ...component,
        options: component.options.map((option) => ({ ...option })),
      }),
    })) }),
    ...(payload.allowedMentions === undefined ? {} : { allowedMentions: { parse: [], users: [...payload.allowedMentions.users] } }),
  };
}

export class RecordingDiscordPort implements DiscordPort {
  readonly connected = false;
  readonly recordedActions: RecordingDiscordAction[] = [];
  readonly logMessages: string[] = [];
  private readonly messages = new Map<string, DiscordMessageSnapshot>();
  private readonly scheduledEvents = new Map<string, ScheduledEventSnapshot>();
  private messageSequence = 0;
  private scheduledSequence = 0;

  async createMessage(channelId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    const messageId = `dry-message-${++this.messageSequence}`;
    const message = this.messageSnapshot(messageId, channelId, payload, false);
    this.recordedActions.push({ type: 'create-message', channelId, payload: copyPayload(payload) });
    this.messages.set(messageId, message);
    return message;
  }

  async editMessage(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot> {
    this.recordedActions.push({ type: 'edit-message', channelId, messageId, payload: copyPayload(payload) });
    const previous = this.messages.get(messageId);
    const merged = payload.components === undefined && previous?.components
      ? { ...payload, components: previous.components }
      : payload;
    const message = this.messageSnapshot(messageId, channelId, merged, previous?.pinned ?? false);
    this.messages.set(messageId, message);
    return message;
  }

  async fetchRecentBotMessages(channelId: string, limit: number): Promise<import('./types.ts').DiscordMessageHistory> {
    this.recordedActions.push({ type: 'fetch-messages', channelId, limit });
    return { messages: [...this.messages.values()]
      .filter((message) => message.channelId === channelId)
      .slice(-Math.max(1, limit))
      .reverse()
      .map((message) => ({ ...message, embeds: message.embeds.map(copyEmbed) })), complete: true };
  }

  async fetchPinnedBotMessages(channelId: string): Promise<DiscordMessageSnapshot[]> {
    return [...this.messages.values()]
      .filter((message) => message.channelId === channelId && message.pinned)
      .map((message) => ({ ...message, embeds: message.embeds.map(copyEmbed) }));
  }

  async fetchMessage(channelId: string, messageId: string): Promise<DiscordMessageSnapshot | null> {
    const message = this.messages.get(messageId);
    return message?.channelId === channelId ? { ...message, embeds: message.embeds.map(copyEmbed) } : null;
  }

  async isTextChannel(_channelId: string): Promise<boolean> {
    return true;
  }

  async createScheduledEvent(guildId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> {
    const eventId = `dry-scheduled-${++this.scheduledSequence}`;
    const event = { ...payload, id: eventId, guildId, status: 'SCHEDULED' as const };
    this.recordedActions.push({ type: 'create-scheduled-event', guildId, payload: { ...payload } });
    this.scheduledEvents.set(eventId, event);
    return event;
  }

  async editScheduledEvent(guildId: string, eventId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot> {
    const existing = this.scheduledEvents.get(eventId);
    const event = {
      ...payload,
      id: eventId,
      guildId,
      status: existing?.status ?? 'SCHEDULED' as const,
    };
    this.recordedActions.push({ type: 'edit-scheduled-event', guildId, eventId, payload: { ...payload } });
    this.scheduledEvents.set(eventId, event);
    return event;
  }

  async listScheduledEvents(guildId: string): Promise<ScheduledEventSnapshot[]> {
    this.recordedActions.push({ type: 'list-scheduled-events', guildId });
    return [...this.scheduledEvents.values()].filter((event) => event.guildId === guildId).map((event) => ({ ...event }));
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    this.recordedActions.push({ type: 'pin-message', channelId, messageId });
    const existing = this.messages.get(messageId);
    if (existing) this.messages.set(messageId, { ...existing, pinned: true });
  }

  async sendLog(channelId: string, content: string): Promise<void> {
    this.recordedActions.push({ type: 'log', channelId, content });
    this.logMessages.push(content);
  }

  private messageSnapshot(
    id: string,
    channelId: string,
    payload: DiscordMessagePayload,
    pinned: boolean,
  ): DiscordMessageSnapshot {
    return {
      id,
      channelId,
      authorIsBot: true,
      pinned,
      content: payload.content ?? '',
      embeds: payload.embeds?.map(copyEmbed) ?? [],
      components: payload.components?.map((row) => ({
        components: row.components.map((component) => component.type === 'button' ? { ...component } : {
          ...component,
          options: component.options.map((option) => ({ ...option })),
        }),
      })) ?? [],
    };
  }
}

export interface DryRunCycleOptions {
  store: Store;
  fetchText: FetchText;
  fetchMetrics?: FetchMetrics;
  now?: () => Date;
}

export interface DryRunCycleOutput {
  cycle: CycleResult;
  discord: RecordingDiscordPort;
  fetchStatistics: FetchStatistics;
  report: string;
}

const dateTimeFormatter = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
  hourCycle: 'h23',
});

function berlinDateTime(utc: string | null): string {
  if (!utc || !Number.isFinite(Date.parse(utc))) return 'unbekannt';
  return dateTimeFormatter.format(new Date(utc));
}

function fieldStatus(name: string, status: 'ok' | 'unsicher' | 'n/a', reason: string | null): string {
  return `  ${name}: ${status}${status === 'unsicher' ? ` — ${reason ?? 'kein Grund hinterlegt'}` : ''}`;
}

function eventTypeName(event: StoreEvent): string {
  switch (event.eventType) {
    case 'seasonal-special': return 'Sonderseite';
    case 'maintenance': return 'Wartung';
    case 'topic-generic': return 'Themenbeitrag';
  }
}

function eventIdentityFromMessageAction(action: RecordingDiscordAction): string | undefined {
  if (action.type !== 'create-message' && action.type !== 'edit-message') return undefined;
  const url = action.payload.embeds?.find((embed) => embed.title !== 'Läuft gerade')?.url;
  if (!url) return undefined;
  try {
    return /^#ffe-([a-f0-9]{64})$/.exec(new URL(url).hash)?.[1];
  } catch {
    return undefined;
  }
}

function eventIdentityFromScheduledAction(action: RecordingDiscordAction): string | undefined {
  if (action.type !== 'create-scheduled-event' && action.type !== 'edit-scheduled-event') return undefined;
  const links = [...action.payload.description.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map((match) => match[1] ?? '');
  for (const link of links) {
    try {
      const marker = /^#ffe-([a-f0-9]{64})$/.exec(new URL(link).hash)?.[1];
      if (marker) return marker;
    } catch {
      // Ignore malformed source links in recorded actions.
    }
  }
  return undefined;
}

function scheduledActionFor(
  eventIdentity: string,
  actions: readonly RecordingDiscordAction[],
): RecordingDiscordAction | undefined {
  return actions.find((action) => eventIdentityFromScheduledAction(action) === eventIdentity);
}

function eventPeriod(event: StoreEvent): string {
  const startUtc = event.startStatus === 'ok' ? event.startUtc : null;
  const endUtc = event.endStatus === 'ok' ? event.endUtc : null;
  const start = startUtc ? berlinDateTime(startUtc) : 'unsicher';
  const end = endUtc ? berlinDateTime(endUtc) : 'unsicher';
  return `${start} – ${end}\n  UTC: ${startUtc ?? 'unbekannt'} – ${endUtc ?? 'unbekannt'}`;
}

function rewardSections(event: StoreEvent): string[] {
  if (event.rewardsStatus === 'n/a') return [];
  if (event.rewardsStatus === 'unsicher' && event.rewards.length === 0) return [`  unsicher — ${event.rewardsReason ?? 'kein Grund hinterlegt'}`];
  if (event.rewards.length === 0) return ['  Keine Belohnungen erkannt.'];
  const groups = new Map<string, string[]>();
  for (const reward of event.rewards) {
    const names = groups.get(reward.section) ?? [];
    names.push(reward.name);
    groups.set(reward.section, names);
  }
  return [...groups].map(([section, names]) => `  ${section}: ${names.join(', ')}`);
}

function scheduledDecision(event: StoreEvent, sourceUrls: readonly string[], now: Date, action?: RecordingDiscordAction): string {
  const recordedPayload = action?.type === 'create-scheduled-event' || action?.type === 'edit-scheduled-event'
    ? action.payload
    : undefined;
  const payload = recordedPayload ?? scheduledEventPayloadFor(event, sourceUrls, now);
  if (!payload) return `Nein — ${scheduledEventUnavailableReason(event, now)}`;
  const verb = action?.type === 'edit-scheduled-event' ? 'würde bearbeitet' : 'würde erstellt';
  return `${verb}: Start ${berlinDateTime(payload.startUtc)} (${payload.startUtc}), Ende ${berlinDateTime(payload.endUtc)} (${payload.endUtc}), Ort: ${payload.location}`;
}

function suppressedIds(store: Store): Set<number> {
  try {
    const values = JSON.parse(getMetaValue(store, 'first_run_suppressed_event_ids') ?? '[]') as unknown;
    return new Set(Array.isArray(values) ? values.filter((value): value is number => Number.isSafeInteger(value)) : []);
  } catch {
    return new Set();
  }
}

function notPostedReason(event: StoreEvent, firstRun: boolean, blind: boolean, suppressed: ReadonlySet<number>, now: Date): string {
  if (blind) return 'Quellenstatus blind; Veröffentlichung ausgesetzt.';
  if (firstRun && suppressed.has(event.id)) {
    if (event.endStatus === 'ok' && event.endUtc && Date.parse(event.endUtc) <= now.getTime()) {
      return 'beim Erststart unterdrückt: Event bereits beendet.';
    }
    return 'beim Erststart unterdrückt: Ende nicht sicher in der Zukunft.';
  }
  if (event.endStatus === 'ok' && event.endUtc && Date.parse(event.endUtc) <= now.getTime()) {
    return 'Event beendet; kein neuer Discord-Post.';
  }
  if (firstRun) return 'beim Erststart unterdrückt (Ende nicht sicher in der Zukunft).';
  return 'in diesem Zyklus nicht zum Posten ausgewählt.';
}

function buildReport(
  store: Store,
  cycle: CycleResult,
  discord: RecordingDiscordPort,
  statistics: FetchStatistics,
  now: Date,
): string {
  const events = getAllEvents(store);
  const postedIdentities = new Set(discord.recordedActions.map(eventIdentityFromMessageAction).filter((identity): identity is string => identity !== undefined));
  const suppressed = suppressedIds(store);
  const posted = events.filter((event) => postedIdentities.has(stableEventIdentity(event.eventKey)));
  const omitted = events.filter((event) => !postedIdentities.has(stableEventIdentity(event.eventKey)));
  const sections = [
    'Lodestone-Trockenlauf',
    `Zyklus: ${cycle.firstRun ? 'Erststart' : 'Folgelauf'}; erfasst: ${cycle.capturedEvents}; würde posten: ${cycle.postedEvents}`,
    `Lodestone blind: ${cycle.blind ? 'JA' : 'nein'}`,
    '',
    `Würde als Event-Beitrag veröffentlicht (${posted.length})`,
  ];

  for (const event of posted) {
    const sources = getEventSources(store, event.id).map((source) => source.url);
    const scheduledAction = scheduledActionFor(stableEventIdentity(event.eventKey), discord.recordedActions);
    sections.push(
      '',
      `## ${event.title}`,
      `Typ: ${eventTypeName(event)}`,
      `Zeitraum: ${eventPeriod(event)}`,
      'Status je Feld:',
      fieldStatus('Titel', event.titleStatus, event.titleReason),
      fieldStatus('Start', event.startStatus, event.startReason),
      fieldStatus('Ende', event.endStatus, event.endReason),
      fieldStatus('Belohnungen', event.rewardsStatus, event.rewardsReason),
      fieldStatus('Beschreibung', event.descriptionStatus, event.descriptionReason),
      ...(event.rewardsStatus === 'n/a' ? [] : ['Belohnungen nach Abschnitt:', ...rewardSections(event)]),
      'Quellen:',
      ...(sources.length > 0 ? sources.map((url) => `  ${url}`) : ['  Keine Quellen hinterlegt.']),
      `Discord-Event: ${scheduledDecision(event, sources, now, scheduledAction)}`,
    );
  }

  sections.push('', `Gespeichert, aber nicht gepostet (${omitted.length})`);
  for (const event of omitted) {
    sections.push(`- ${event.title} — ${notPostedReason(event, cycle.firstRun, cycle.blind, suppressed, now)}`);
  }

  sections.push('', `Log-Kanal-Meldungen, die gesendet würden (${discord.logMessages.length})`);
  sections.push(...(discord.logMessages.length > 0 ? discord.logMessages.map((message) => `- ${message}`) : ['- Keine.']));
  sections.push(
    '',
    'Abrufstatistik:',
    `- Anfragen: ${statistics.requests}; 304: ${statistics.notModified}; Fehler: ${statistics.failures}`,
    `- Anfragen nach Typ: Listen ${statistics.byType.lists}; Feed ${statistics.byType.feed}; Topic-Details ${statistics.byType.topicDetails}; Wartungsdetails ${statistics.byType.maintenanceDetails}; Kurzlinks ${statistics.byType.shortLinks}; Sonderseiten ${statistics.byType.specialPages}; Items ${statistics.byType.items}; Wiki ${statistics.byType.wiki}`,
    `- Duplikate vermieden: ${cycle.duplicatesAvoided}`,
    `- Dauer: ${(statistics.durationMs / 1_000).toFixed(2)} s gesamt; ${(statistics.requestTimeMs / 1_000).toFixed(2)} s kumulierte Anfragezeit`,
  );
  return sections.join('\n');
}

function observedFetchText(fetchText: FetchText, metrics: FetchMetrics): FetchText {
  return async (url, options) => {
    const startedAt = performance.now();
    let response;
    try {
      response = await fetchText(url, options);
    } catch (error) {
      metrics.record(url, undefined, '', performance.now() - startedAt);
      throw error;
    }
    metrics.record(url, response.status, response.body, performance.now() - startedAt);
    return response;
  };
}

export async function runDryRunCycle(options: DryRunCycleOptions): Promise<DryRunCycleOutput> {
  const metrics = options.fetchMetrics ?? new FetchMetrics();
  const fetchText = options.fetchMetrics ? options.fetchText : observedFetchText(options.fetchText, metrics);
  const discord = new RecordingDiscordPort();
  const guildId = `dry-run-${randomUUID()}`;
  upsertGuildSetup(options.store, { guildId, eventChannelId: 'dry-run-events', logChannelId: 'dry-run-logs' });
  let cycle: CycleResult;
  try {
    cycle = await runCycle({
      store: options.store,
      discord,
      fetchText,
      guilds: [{
        guildId,
        eventChannelId: 'dry-run-events',
        logChannelId: 'dry-run-logs',
        firstRun: isFirstRun(options.store),
      }],
      skipGlobalFirstRunMark: true,
      ...(options.now ? { now: options.now } : {}),
    });
  } finally {
    deleteGuild(options.store, guildId);
  }
  const fetchStatistics = metrics.snapshot();
  const reportNow = options.now?.() ?? new Date();
  return {
    cycle,
    discord,
    fetchStatistics,
    report: buildReport(options.store, cycle, discord, fetchStatistics, reportNow),
  };
}
