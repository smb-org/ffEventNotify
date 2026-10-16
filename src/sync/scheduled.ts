// Synchronizes Discord-managed external scheduled events without setting status.

import type { Store, StoreEvent } from '../store.ts';
import { getGuildEventObject, setGuildDiscordIds } from '../store.ts';
import { stableEventIdentity } from '../event-identity.ts';
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

function eventMarker(eventKey: string): string {
  return `Event-ID: ${stableEventIdentity(eventKey)}`;
}

export function scheduledEventPayloadFor(
  event: StoreEvent,
  sourceUrls: readonly string[],
  now: Date,
): ScheduledEventPayload | undefined {
  if (event.startStatus !== 'ok' || event.endStatus !== 'ok' || !event.startUtc || !event.endUtc) return undefined;
  const nowMs = now.getTime();
  const endMs = Date.parse(event.endUtc);
  const startMs = Date.parse(event.startUtc);
  if (!Number.isFinite(nowMs) || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= nowMs || endMs <= startMs) return undefined;

  const urls = orderedUrls(sourceUrls);
  const chosenUrl = urls[0];
  const selectedLocation = chosenUrl && chosenUrl.length <= 100 ? chosenUrl : LOCATION_FALLBACK;
  const descriptionUrl = urls.find((url) => url.length <= 980) ?? chosenUrl ?? '';
  const description = `${eventMarker(event.eventKey)}${descriptionUrl ? `\n${descriptionUrl}` : ''}`;

  const scheduledStart = startMs < nowMs ? nowMs + 2 * 60_000 : startMs;
  if (!(nowMs < scheduledStart && scheduledStart < endMs)) return undefined;

  return {
    name: event.title.slice(0, 100),
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

function hasExactMarkerLine(description: string, marker: string): boolean {
  return description.split(/\r?\n/).includes(marker);
}

function findByMarker(
  events: readonly ScheduledEventSnapshot[],
  event: StoreEvent,
  sourceUrls: readonly string[],
): ScheduledEventSnapshot | undefined {
  const marker = eventMarker(event.eventKey);
  const stableMatches = events.filter((candidate) => hasExactMarkerLine(candidate.description, marker));
  if (stableMatches.length > 1) throw new Error(`Mehrere Discord-Events tragen dieselbe Event-ID ${marker}.`);
  if (stableMatches.length === 1) return stableMatches[0];

  // Older versions stored numeric row IDs. Adopt one only when its title and exact source URL
  // prove that it belongs to this Lodestone event; a reused SQLite ID alone is not identity.
  const legacyMarker = `Event-ID: ${event.id}`;
  return events.find((candidate) => hasExactMarkerLine(candidate.description, legacyMarker) &&
    candidate.name === event.title && candidate.description.split(/\r?\n/).some((line) => sourceUrls.includes(line)));
}

async function createReplacement(
  event: StoreEvent,
  sourceUrls: readonly string[],
  guildId: string,
  discord: DiscordPort,
  store: Store,
  now: Date,
  clock?: () => Date,
): Promise<string | undefined> {
  const payload = scheduledEventPayloadFor(event, sourceUrls, clock?.() ?? now);
  if (!payload) return undefined;
  const created = await discord.createScheduledEvent(guildId, payload);
  setGuildDiscordIds(store, guildId, event.eventKey, { scheduledEventId: created.id });
  return created.id;
}

export async function syncScheduledEvent({
  event,
  sourceUrls,
  guildId,
  discord,
  store,
  now = new Date(),
  clock,
}: SyncScheduledEventOptions): Promise<string | undefined> {
  if (event.startStatus !== 'ok' || event.endStatus !== 'ok' || !event.startUtc || !event.endUtc) return undefined;

  const schedules = await discord.listScheduledEvents(guildId);
  const storedObject = getGuildEventObject(store, guildId, event.eventKey);
  const stored = storedObject?.scheduledEventId === null || storedObject?.scheduledEventId === undefined
    ? undefined
    : schedules.find((candidate) => candidate.id === storedObject.scheduledEventId);
  const matched = stored ?? findByMarker(schedules, event, sourceUrls);
  const currentTime = clock?.() ?? now;
  const initialPayload = scheduledEventPayloadFor(event, sourceUrls, currentTime);
  if (!initialPayload) return undefined;
  if (!matched) {
    const created = await discord.createScheduledEvent(guildId, initialPayload);
    setGuildDiscordIds(store, guildId, event.eventKey, { scheduledEventId: created.id });
    return created.id;
  }

  setGuildDiscordIds(store, guildId, event.eventKey, { scheduledEventId: matched.id });
  if (matched.status === 'COMPLETED' || matched.status === 'CANCELED') {
    return createReplacement(event, sourceUrls, guildId, discord, store, currentTime, clock);
  }

  const editTime = clock?.() ?? currentTime;
  const payload = scheduledEventPayloadFor(event, sourceUrls, editTime);
  if (!payload || sameSchedule(matched, payload)) return matched.id;

  try {
    const edited = await discord.editScheduledEvent(guildId, matched.id, payload);
    setGuildDiscordIds(store, guildId, event.eventKey, { scheduledEventId: edited.id });
    return edited.id;
  } catch (error) {
    const refreshed = await discord.listScheduledEvents(guildId);
    const current = refreshed.find((candidate) => candidate.id === matched.id);
    if (current && (current.status === 'COMPLETED' || current.status === 'CANCELED')) {
      return createReplacement(event, sourceUrls, guildId, discord, store, editTime, clock);
    }
    throw error;
  }
}
