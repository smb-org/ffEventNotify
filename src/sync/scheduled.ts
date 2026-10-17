// Synchronizes Discord-managed external scheduled events without setting status.

import type { Store, StoreEvent } from '../store.ts';
import { getGuild, getGuildEventObject, setGuildDiscordIds } from '../store.ts';
import { withGuildDiscordLock } from '../guild-lock.ts';
import { logAction } from '../log.ts';
import {
  bestEventSourceUrl,
  eventMarkerFragment,
  hasEventMarkerUrl,
  stableEventIdentity,
} from '../event-identity.ts';
import type { DiscordPort, ScheduledEventPayload, ScheduledEventSnapshot } from '../types.ts';

export interface SyncScheduledEventOptions {
  event: StoreEvent;
  sourceUrls: readonly string[];
  guildId: string;
  discord: DiscordPort;
  store: Store;
  now?: Date;
  clock?: () => Date;
}

const LOCATION_FALLBACK = 'Lodestone – Link in der Beschreibung';

function orderedUrls(sourceUrls: readonly string[]): string[] {
  const unique = [...new Set(sourceUrls)];
  const special = unique.filter((url) => {
    try {
      return new URL(url).pathname.startsWith('/lodestone/special/');
    } catch {
      return false;
    }
  });
  const other = unique.filter((url) => !special.includes(url));
  return [
    ...special.sort((left, right) => left.length - right.length || left.localeCompare(right)),
    ...other.sort((left, right) => left.length - right.length || left.localeCompare(right)),
  ];
}

export function scheduledEventPayloadFor(
  event: StoreEvent,
  sourceUrls: readonly string[],
  now: Date,
  cardJumpLink?: string,
): ScheduledEventPayload | undefined {
  if (event.startStatus !== 'ok' || event.endStatus !== 'ok' || !event.startUtc || !event.endUtc) return undefined;
  const nowMs = now.getTime();
  const endMs = Date.parse(event.endUtc);
  const startMs = Date.parse(event.startUtc);
  if (!Number.isFinite(nowMs) || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= nowMs || endMs <= startMs) return undefined;

  const urls = orderedUrls(sourceUrls);
  const chosenUrl = bestEventSourceUrl(urls);
  const selectedLocation = cardJumpLink && cardJumpLink.length <= 100
    ? cardJumpLink
    : chosenUrl && chosenUrl.length <= 100 ? chosenUrl : LOCATION_FALLBACK;
  const sourceUrl = bestEventSourceUrl(urls);
  const description = [
    ...(sourceUrl ? [`[Zur Lodestone-Ankündigung](${sourceUrl})`] : []),
    `#${eventMarkerFragment(event.eventKey)}`,
  ].join('\n');

  const scheduledStart = startMs < nowMs ? nowMs + 2 * 60_000 : startMs;
  if (!(nowMs < scheduledStart && scheduledStart < endMs)) return undefined;

  return {
    name: (event.titleStatus === 'ok' ? event.title : 'FFXIV-Event').slice(0, 100),
    startUtc: new Date(scheduledStart).toISOString(),
    endUtc: event.endUtc,
    location: selectedLocation || LOCATION_FALLBACK,
    description,
  };
}

export function scheduledEventUnavailableReason(event: StoreEvent, now: Date): string {
  if (event.startStatus !== 'ok' || !event.startUtc) {
    return `Start ist unsicher${event.startReason ? `: ${event.startReason}` : '.'}`;
  }
  if (event.endStatus !== 'ok' || !event.endUtc) {
    return `Ende ist unsicher${event.endReason ? `: ${event.endReason}` : '.'}`;
  }
  const nowMs = now.getTime();
  const startMs = Date.parse(event.startUtc);
  const endMs = Date.parse(event.endUtc);
  if (!Number.isFinite(nowMs) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 'Start- oder Endzeit ist kein gültiges Datum.';
  }
  if (endMs <= nowMs) return 'Das Event ist bereits beendet.';
  if (endMs <= startMs) return 'Das Ende liegt nicht nach dem Start.';
  const scheduledStart = startMs < nowMs ? nowMs + 2 * 60_000 : startMs;
  if (!(nowMs < scheduledStart && scheduledStart < endMs)) return 'Der gültige Start läge nicht vor dem Ende.';
  return 'Es konnte kein passender Discord-Event-Zeitraum berechnet werden.';
}

function sameInstant(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

function sameSchedule(event: ScheduledEventSnapshot, payload: ScheduledEventPayload): boolean {
  return event.name === payload.name && sameInstant(event.startUtc, payload.startUtc) && sameInstant(event.endUtc, payload.endUtc) &&
    event.location === payload.location && event.description === payload.description;
}

function linksInDescription(description: string): string[] {
  const markdown = [...description.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map((match) => match[1] ?? '');
  const bare = description.split(/\r?\n/).filter((line) => /^https?:\/\//.test(line.trim())).map((line) => line.trim());
  return [...markdown, ...bare];
}

function hasExactMarkerLink(description: string, event: StoreEvent): boolean {
  return description.split(/\r?\n/).includes(`#${eventMarkerFragment(event.eventKey)}`)
    || linksInDescription(description).some((link) => hasEventMarkerUrl(link, event.eventKey));
}

function hasExactLegacyStableMarker(description: string, event: StoreEvent): boolean {
  return description.split(/\r?\n/).includes(`Event-ID: ${stableEventIdentity(event.eventKey)}`);
}

function hasLegacyDescription(description: string, marker: string, sourceUrls: readonly string[]): boolean {
  if (!description.split(/\r?\n/).includes(marker)) return false;
  return linksInDescription(description).some((link) => {
    try {
      const url = new URL(link);
      url.hash = '';
      url.search = '';
      return sourceUrls.some((source) => {
        const sourceUrl = new URL(source);
        sourceUrl.hash = '';
        sourceUrl.search = '';
        return sourceUrl.toString().replace(/\/$/, '') === url.toString().replace(/\/$/, '');
      });
    } catch {
      return false;
    }
  });
}

function findByMarker(
  events: readonly ScheduledEventSnapshot[],
  event: StoreEvent,
  sourceUrls: readonly string[],
): ScheduledEventSnapshot | undefined {
  const stableMatches = events.filter((candidate) => hasExactMarkerLink(candidate.description, event));
  if (stableMatches.length > 1) throw new Error(`Mehrere Discord-Events tragen dieselbe Quellenmarkierung für ${event.title}.`);
  if (stableMatches.length === 1) return stableMatches[0];

  const legacyStableMatches = events.filter((candidate) => hasExactLegacyStableMarker(candidate.description, event));
  if (legacyStableMatches.length > 1) throw new Error(`Mehrere ältere Discord-Events passen zu ${event.title}.`);
  if (legacyStableMatches.length === 1) return legacyStableMatches[0];

  // Older versions stored numeric row IDs. Adopt one only when its title and exact source URL
  // prove that it belongs to this Lodestone event; a reused SQLite ID alone is not identity.
  return events.find((candidate) => candidate.name === event.title &&
    hasLegacyDescription(candidate.description, `Event-ID: ${event.id}`, sourceUrls));
}

async function createReplacement(
  event: StoreEvent,
  sourceUrls: readonly string[],
  guildId: string,
  discord: DiscordPort,
  store: Store,
  now: Date,
  clock?: () => Date,
  cardJumpLink?: string,
): Promise<string | undefined> {
  const payload = scheduledEventPayloadFor(event, sourceUrls, clock?.() ?? now, cardJumpLink);
  if (!payload) return undefined;
  const created = await discord.createScheduledEvent(guildId, payload);
  setGuildDiscordIds(store, guildId, event.eventKey, { scheduledEventId: created.id });
  logAction(guildId, 'scheduledCreated', `Geplantes Event „${event.title}“ neu angelegt (Ersatz)`);
  return created.id;
}

async function syncScheduledEventUnlocked({
  event,
  sourceUrls,
  guildId,
  discord,
  store,
  now = new Date(),
  clock,
}: SyncScheduledEventOptions): Promise<string | undefined> {
  if (event.startStatus !== 'ok' || event.endStatus !== 'ok' || !event.startUtc || !event.endUtc) return undefined;

  const guild = getGuild(store, guildId);
  const guildEventObject = getGuildEventObject(store, guildId, event.eventKey);
  if (!guild?.eventChannelId || !guildEventObject?.messageId
    || guildEventObject.messageChannelId !== guild.eventChannelId) return undefined;
  let cardJumpLink: string;
  if (discord.fetchForumPost) {
    const post = await discord.fetchForumPost(guild.eventChannelId, guildEventObject.messageId);
    if (!post?.starterMessage.authorIsBot || !post.starterMessage.embeds.some((embed) => embed.url && hasEventMarkerUrl(embed.url, event.eventKey))) return undefined;
    cardJumpLink = `https://discord.com/channels/${guildId}/${guildEventObject.messageId}`;
  } else {
    const card = await discord.fetchMessage(guild.eventChannelId, guildEventObject.messageId);
    if (!card?.authorIsBot || !card.embeds.some((embed) => embed.url && hasEventMarkerUrl(embed.url, event.eventKey))) return undefined;
    cardJumpLink = `https://discord.com/channels/${guildId}/${guild.eventChannelId}/${guildEventObject.messageId}`;
  }

  const schedules = await discord.listScheduledEvents(guildId);
  const storedObject = guildEventObject;
  const stored = storedObject?.scheduledEventId === null || storedObject?.scheduledEventId === undefined
    ? undefined
    : schedules.find((candidate) => candidate.id === storedObject.scheduledEventId);
  const matched = stored ?? findByMarker(schedules, event, sourceUrls);
  const currentTime = clock?.() ?? now;
  const initialPayload = scheduledEventPayloadFor(event, sourceUrls, currentTime, cardJumpLink);
  if (!initialPayload) return undefined;
  if (!matched) {
    const created = await discord.createScheduledEvent(guildId, initialPayload);
    setGuildDiscordIds(store, guildId, event.eventKey, { scheduledEventId: created.id });
    logAction(guildId, 'scheduledCreated', `Geplantes Event „${event.title}“ angelegt`);
    return created.id;
  }

  setGuildDiscordIds(store, guildId, event.eventKey, { scheduledEventId: matched.id });
  if (matched.status === 'COMPLETED' || matched.status === 'CANCELED') {
    return createReplacement(event, sourceUrls, guildId, discord, store, currentTime, clock, cardJumpLink);
  }

  const editTime = clock?.() ?? currentTime;
  const basePayload = scheduledEventPayloadFor(event, sourceUrls, editTime, cardJumpLink);
  const preserveStart = matched.status === 'ACTIVE' || Date.parse(event.startUtc) < editTime.getTime();
  const payload = basePayload && preserveStart ? { ...basePayload, startUtc: matched.startUtc } : basePayload;
  if (!payload || sameSchedule(matched, payload)) return matched.id;

  try {
    const edited = await discord.editScheduledEvent(guildId, matched.id, payload);
    setGuildDiscordIds(store, guildId, event.eventKey, { scheduledEventId: edited.id });
    logAction(guildId, 'scheduledUpdated', `Geplantes Event „${event.title}“ aktualisiert`);
    return edited.id;
  } catch (error) {
    const refreshed = await discord.listScheduledEvents(guildId);
    const current = refreshed.find((candidate) => candidate.id === matched.id);
    if (current && (current.status === 'COMPLETED' || current.status === 'CANCELED')) {
      return createReplacement(event, sourceUrls, guildId, discord, store, editTime, clock, cardJumpLink);
    }
    throw error;
  }
}

export function syncScheduledEvent(options: SyncScheduledEventOptions): Promise<string | undefined> {
  return withGuildDiscordLock(options.guildId, () => syncScheduledEventUnlocked(options));
}
