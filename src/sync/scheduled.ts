// Synchronizes Discord-managed external scheduled events without setting status.

import type { Store, StoreEvent } from '../store.ts';
import { setDiscordIds } from '../store.ts';
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

function eventMarker(eventId: number): string {
  return `Event-ID: ${eventId}`;
}

function payloadFor(
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
  const description = `${eventMarker(event.id)}${descriptionUrl ? `\n${descriptionUrl}` : ''}`;

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

function sameSchedule(event: ScheduledEventSnapshot, payload: ScheduledEventPayload): boolean {
  return event.name === payload.name && event.startUtc === payload.startUtc && event.endUtc === payload.endUtc &&
    event.location === payload.location && event.description === payload.description;
}

function findByMarker(events: readonly ScheduledEventSnapshot[], eventId: number): ScheduledEventSnapshot | undefined {
  const marker = eventMarker(eventId);
  return events.find((event) => event.description.includes(marker));
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
  const payload = payloadFor(event, sourceUrls, clock?.() ?? now);
  if (!payload) return undefined;
  const created = await discord.createScheduledEvent(guildId, payload);
  setDiscordIds(store, event.id, { scheduledEventId: created.id });
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
  const stored = event.scheduledEventId === null ? undefined : schedules.find((candidate) => candidate.id === event.scheduledEventId);
  const matched = stored ?? findByMarker(schedules, event.id);
  const currentTime = clock?.() ?? now;
  const initialPayload = payloadFor(event, sourceUrls, currentTime);
  if (!initialPayload) return undefined;
  if (!matched) {
    const created = await discord.createScheduledEvent(guildId, initialPayload);
    setDiscordIds(store, event.id, { scheduledEventId: created.id });
    return created.id;
  }

  setDiscordIds(store, event.id, { scheduledEventId: matched.id });
  if (matched.status === 'COMPLETED' || matched.status === 'CANCELED') {
    return createReplacement(event, sourceUrls, guildId, discord, store, currentTime, clock);
  }

  const editTime = clock?.() ?? currentTime;
  const payload = payloadFor(event, sourceUrls, editTime);
  if (!payload || sameSchedule(matched, payload)) return matched.id;

  try {
    const edited = await discord.editScheduledEvent(guildId, matched.id, payload);
    setDiscordIds(store, event.id, { scheduledEventId: edited.id });
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
