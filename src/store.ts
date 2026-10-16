// Implements Design: SQLite event/source/item schema, provenance, and warning deduplication (O5, O6).

import { DatabaseSync } from 'node:sqlite';
import type { EventSourceKind, EventType, FieldStatus, Reward } from './types.ts';

export type Store = DatabaseSync;

export type StoreField = 'title' | 'start' | 'end' | 'rewards' | 'description';
export type StoreFieldUpdate = FieldStatus<string | Reward[]>;

export interface CreateEventInput {
  eventKey: string;
  eventType: EventType;
  title: string;
}

export interface AttachSourceInput {
  eventId: number;
  url: string;
  kind: EventSourceKind;
  publishedAt?: string;
  firstSeenAt?: string;
}

export interface StoreEvent {
  id: number;
  eventKey: string;
  eventType: EventType;
  title: string;
  titleStatus: 'ok' | 'unsicher';
  titleReason: string | null;
  startUtc: string | null;
  startStatus: 'ok' | 'unsicher';
  startReason: string | null;
  endUtc: string | null;
  endStatus: 'ok' | 'unsicher';
  endReason: string | null;
  rewards: Reward[];
  rewardsStatus: 'ok' | 'unsicher' | 'n/a';
  rewardsReason: string | null;
  description: string | null;
  descriptionStatus: 'ok' | 'unsicher';
  descriptionReason: string | null;
  createdAt: string;
}

export interface StoredGuild {
  guildId: string;
  eventChannelId: string | null;
  logChannelId: string | null;
  setupAt: string | null;
  firstRunDone: boolean;
  needsSetup: boolean;
  statusMessageId: string | null;
}

export interface GuildEventObject {
  guildId: string;
  eventKey: string;
  messageId: string | null;
  messageChannelId: string | null;
  scheduledEventId: string | null;
  status: 'pending' | 'synced' | 'failed';
  lastError: string | null;
  firstRunSuppressed: boolean;
}

export interface PendingWarning {
  guildId: string;
  key: string;
  content: string;
}

export interface StoreEventSource {
  eventId: number;
  url: string;
  kind: EventSourceKind;
  publishedAt: string | null;
  firstSeenAt: string;
}

export interface CachedItem {
  itemId: string;
  name: string;
  iconUrl: string | null;
  fetchedAt: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL CHECK (event_type IN ('seasonal-special', 'maintenance', 'topic-generic')),
    title TEXT NOT NULL,
    title_status TEXT NOT NULL DEFAULT 'ok' CHECK (title_status IN ('ok', 'unsicher')),
    title_reason TEXT,
    start_utc TEXT,
    start_status TEXT NOT NULL DEFAULT 'unsicher' CHECK (start_status IN ('ok', 'unsicher')),
    start_reason TEXT DEFAULT 'Nicht extrahiert',
    end_utc TEXT,
    end_status TEXT NOT NULL DEFAULT 'unsicher' CHECK (end_status IN ('ok', 'unsicher')),
    end_reason TEXT DEFAULT 'Nicht extrahiert',
    rewards_json TEXT NOT NULL DEFAULT '[]',
    rewards_status TEXT NOT NULL DEFAULT 'unsicher' CHECK (rewards_status IN ('ok', 'unsicher')),
    rewards_reason TEXT DEFAULT 'Nicht extrahiert',
    description TEXT,
    description_status TEXT NOT NULL DEFAULT 'unsicher' CHECK (description_status IN ('ok', 'unsicher')),
    description_reason TEXT DEFAULT 'Nicht extrahiert',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS guilds (
    guild_id TEXT PRIMARY KEY,
    event_channel_id TEXT,
    log_channel_id TEXT,
    setup_at TEXT,
    first_run_done INTEGER NOT NULL DEFAULT 0 CHECK (first_run_done IN (0, 1)),
    needs_setup INTEGER NOT NULL DEFAULT 0 CHECK (needs_setup IN (0, 1)),
    status_message_id TEXT
  );

  CREATE TABLE IF NOT EXISTS guild_event_objects (
    guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
    event_key TEXT NOT NULL REFERENCES events(event_key) ON DELETE CASCADE,
    message_id TEXT,
    message_channel_id TEXT,
    scheduled_event_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'synced', 'failed')),
    last_error TEXT,
    first_run_suppressed INTEGER NOT NULL DEFAULT 0 CHECK (first_run_suppressed IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (guild_id, event_key)
  );

  CREATE TABLE IF NOT EXISTS event_sources (
    url TEXT PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('topic', 'special', 'maintenance', 'followup', 'feed', 'banner')),
    published_at TEXT,
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS field_provenance (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    field TEXT NOT NULL CHECK (field IN ('title', 'start', 'end', 'rewards', 'description')),
    source_url TEXT NOT NULL REFERENCES event_sources(url) ON DELETE CASCADE,
    source_time TEXT NOT NULL,
    PRIMARY KEY (event_id, field)
  );

  CREATE TABLE IF NOT EXISTS items (
    item_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon_url TEXT,
    fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS seen_entries (
    url TEXT PRIMARY KEY,
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    classification TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS warnings_sent (
    guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    sent_at TEXT,
    PRIMARY KEY (guild_id, key)
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checklist_entries (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL REFERENCES items(item_id),
    acquired INTEGER NOT NULL DEFAULT 0 CHECK (acquired IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (event_id, user_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS reminders (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    lead_hours INTEGER NOT NULL CHECK (lead_hours IN (24, 72)),
    due_at TEXT NOT NULL,
    sent_at TEXT,
    PRIMARY KEY (event_id, user_id, lead_hours)
  );

  CREATE INDEX IF NOT EXISTS idx_events_end_utc ON events(end_utc);
  CREATE INDEX IF NOT EXISTS idx_event_sources_event_id ON event_sources(event_id);
  CREATE INDEX IF NOT EXISTS idx_seen_entries_first_seen_at ON seen_entries(first_seen_at);
`;

function runTransaction<T>(db: Store, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openDb(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  for (const field of ['start', 'end', 'rewards', 'description'] as const) {
    db.prepare(`UPDATE events SET ${field}_reason = 'Nicht extrahiert' WHERE ${field}_reason = 'not extracted'`).run();
  }
  return db;
}

export function isFirstRun(db: Store): boolean {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'first_run_done'").get() as { value: string } | undefined;
  return row?.value !== '1';
}

export function markFirstRunDone(db: Store): void {
  db.prepare("INSERT INTO meta (key, value) VALUES ('first_run_done', '1') ON CONFLICT(key) DO NOTHING").run();
}

export function getGuild(db: Store, guildId: string): StoredGuild | undefined {
  const row = db.prepare(`
    SELECT guild_id AS guildId, event_channel_id AS eventChannelId,
           log_channel_id AS logChannelId, setup_at AS setupAt,
           first_run_done AS firstRunDone, needs_setup AS needsSetup,
           status_message_id AS statusMessageId
    FROM guilds WHERE guild_id = ?
  `).get(guildId) as Omit<StoredGuild, 'firstRunDone' | 'needsSetup'> & {
    firstRunDone: number; needsSetup: number;
  } | undefined;
  return row ? { ...row, firstRunDone: row.firstRunDone === 1, needsSetup: row.needsSetup === 1 } : undefined;
}

export function getConfiguredGuilds(db: Store): StoredGuild[] {
  const ids = db.prepare(`
    SELECT guild_id AS guildId FROM guilds
    WHERE setup_at IS NOT NULL AND needs_setup = 0
      AND event_channel_id IS NOT NULL AND log_channel_id IS NOT NULL
    ORDER BY guild_id
  `).all() as Array<{ guildId: string }>;
  return ids.map(({ guildId }) => getGuild(db, guildId)!).filter(Boolean);
}

export function upsertGuildSetup(
  db: Store,
  input: { guildId: string; eventChannelId: string; logChannelId: string; setupAt?: string },
): { created: boolean; channelsChanged: boolean } {
  const existing = getGuild(db, input.guildId);
  const eventChannelChanged = existing !== undefined && existing.eventChannelId !== input.eventChannelId;
  const channelsChanged = existing !== undefined && (
    eventChannelChanged || existing.logChannelId !== input.logChannelId
  );
  db.prepare(`
    INSERT INTO guilds (guild_id, event_channel_id, log_channel_id, setup_at, first_run_done, needs_setup)
    VALUES (?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 0, 0)
    ON CONFLICT(guild_id) DO UPDATE SET
      event_channel_id = excluded.event_channel_id,
      log_channel_id = excluded.log_channel_id,
      setup_at = excluded.setup_at,
      needs_setup = 0,
      status_message_id = CASE
        WHEN guilds.event_channel_id IS NOT excluded.event_channel_id THEN NULL
        ELSE guilds.status_message_id
      END
  `).run(input.guildId, input.eventChannelId, input.logChannelId, input.setupAt ?? null);
  if (eventChannelChanged) {
    db.prepare(`UPDATE guild_event_objects
      SET message_id = NULL, message_channel_id = NULL, status = 'pending', last_error = NULL
      WHERE guild_id = ?`).run(input.guildId);
  }
  return { created: existing === undefined, channelsChanged };
}

export function markGuildNeedsSetup(db: Store, guildId: string): void {
  db.prepare('UPDATE guilds SET needs_setup = 1 WHERE guild_id = ?').run(guildId);
}

export function markGuildFirstRunDone(db: Store, guildId: string): void {
  db.prepare('UPDATE guilds SET first_run_done = 1 WHERE guild_id = ?').run(guildId);
}

export function setGuildStatusMessage(db: Store, guildId: string, messageId: string | null): void {
  db.prepare(`INSERT INTO guilds (guild_id) VALUES (?) ON CONFLICT(guild_id) DO NOTHING`).run(guildId);
  db.prepare('UPDATE guilds SET status_message_id = ? WHERE guild_id = ?').run(messageId, guildId);
}

export function deleteGuild(db: Store, guildId: string): void {
  db.prepare('DELETE FROM guilds WHERE guild_id = ?').run(guildId);
}

function ensureGuildObject(db: Store, guildId: string, eventKey: string): void {
  db.prepare(`INSERT INTO guilds (guild_id) VALUES (?) ON CONFLICT(guild_id) DO NOTHING`).run(guildId);
  db.prepare(`INSERT INTO guild_event_objects (guild_id, event_key) VALUES (?, ?)
    ON CONFLICT(guild_id, event_key) DO NOTHING`).run(guildId, eventKey);
}

export function getGuildEventObject(db: Store, guildId: string, eventKey: string): GuildEventObject | undefined {
  const row = db.prepare(`
    SELECT guild_id AS guildId, event_key AS eventKey, message_id AS messageId,
           message_channel_id AS messageChannelId, scheduled_event_id AS scheduledEventId,
           status, last_error AS lastError, first_run_suppressed AS firstRunSuppressed
    FROM guild_event_objects WHERE guild_id = ? AND event_key = ?
  `).get(guildId, eventKey) as (Omit<GuildEventObject, 'firstRunSuppressed'> & { firstRunSuppressed: number }) | undefined;
  return row ? { ...row, firstRunSuppressed: row.firstRunSuppressed === 1 } : undefined;
}

export function markGuildEventFirstRunSuppressed(db: Store, guildId: string, eventKey: string): void {
  ensureGuildObject(db, guildId, eventKey);
  db.prepare(`UPDATE guild_event_objects SET first_run_suppressed = 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE guild_id = ? AND event_key = ?`)
    .run(guildId, eventKey);
}

export function setGuildDiscordIds(
  db: Store,
  guildId: string,
  eventKey: string,
  ids: { messageId?: string | null; messageChannelId?: string | null; scheduledEventId?: string | null },
): void {
  ensureGuildObject(db, guildId, eventKey);
  const assignments: string[] = [];
  const values: Array<string | null> = [];
  for (const [key, column] of [
    ['messageId', 'message_id'], ['messageChannelId', 'message_channel_id'], ['scheduledEventId', 'scheduled_event_id'],
  ] as const) {
    if (ids[key] !== undefined) {
      assignments.push(`${column} = ?`);
      values.push(ids[key]!);
    }
  }
  if (assignments.length === 0) return;
  assignments.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  db.prepare(`UPDATE guild_event_objects SET ${assignments.join(', ')} WHERE guild_id = ? AND event_key = ?`)
    .run(...values, guildId, eventKey);
}

export function setGuildEventSyncStatus(
  db: Store,
  guildId: string,
  eventKey: string,
  status: GuildEventObject['status'],
  lastError: string | null = null,
): void {
  ensureGuildObject(db, guildId, eventKey);
  db.prepare(`UPDATE guild_event_objects SET status = ?, last_error = ?,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE guild_id = ? AND event_key = ?`)
    .run(status, lastError, guildId, eventKey);
}

export function queueWarning(db: Store, guildId: string, key: string, content: string): void {
  db.prepare(`INSERT INTO guilds (guild_id) VALUES (?) ON CONFLICT(guild_id) DO NOTHING`).run(guildId);
  db.prepare(`INSERT INTO warnings_sent (guild_id, key, content, status)
    VALUES (?, ?, ?, 'pending') ON CONFLICT(guild_id, key) DO NOTHING`).run(guildId, key, content);
}

export function getPendingWarning(db: Store, guildId: string, key: string): PendingWarning | undefined {
  return db.prepare(`SELECT guild_id AS guildId, key, content FROM warnings_sent
    WHERE guild_id = ? AND key = ? AND status = 'pending'`).get(guildId, key) as PendingWarning | undefined;
}

export function getPendingWarnings(db: Store, guildId: string): PendingWarning[] {
  return db.prepare(`SELECT guild_id AS guildId, key, content FROM warnings_sent
    WHERE guild_id = ? AND status = 'pending' ORDER BY created_at, key`).all(guildId) as unknown as PendingWarning[];
}

export function markWarningSent(db: Store, guildId: string, key: string): void {
  db.prepare(`UPDATE warnings_sent SET status = 'sent', sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE guild_id = ? AND key = ? AND status = 'pending'`).run(guildId, key);
}

export async function deliverWarning(
  db: Store,
  guildId: string,
  channelId: string,
  key: string,
  content: string,
  send: (channelId: string, content: string) => Promise<void>,
): Promise<boolean> {
  queueWarning(db, guildId, key, content);
  const pending = getPendingWarning(db, guildId, key);
  if (!pending) return false;
  await send(channelId, pending.content);
  markWarningSent(db, guildId, key);
  return true;
}

export function findEventBySourceUrl(db: Store, url: string): number | undefined {
  const row = db.prepare('SELECT event_id AS eventId FROM event_sources WHERE url = ?').get(url) as { eventId: number } | undefined;
  return row?.eventId;
}

export function findEventByKey(db: Store, eventKey: string): number | undefined {
  const row = db.prepare('SELECT id FROM events WHERE event_key = ?').get(eventKey) as { id: number } | undefined;
  return row?.id;
}

export function createEvent(db: Store, input: CreateEventInput): number {
  db.prepare(`
    INSERT INTO events (event_key, event_type, title)
    VALUES (?, ?, ?)
    ON CONFLICT(event_key) DO NOTHING
  `).run(input.eventKey, input.eventType, input.title);

  const eventId = findEventByKey(db, input.eventKey);
  if (eventId === undefined) throw new Error(`Failed to create event ${input.eventKey}`);
  return eventId;
}

export function attachSource(db: Store, input: AttachSourceInput): boolean {
  return runTransaction(db, () => {
    const inserted = db.prepare(`
      INSERT INTO event_sources (url, event_id, kind, published_at, first_seen_at)
      VALUES (?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
      ON CONFLICT(url) DO NOTHING
    `).run(input.url, input.eventId, input.kind, input.publishedAt ?? null, input.firstSeenAt ?? null);

    if (inserted.changes > 0) return true;

    if (input.publishedAt) {
      const updated = db.prepare(`
        UPDATE event_sources
        SET published_at = ?
        WHERE url = ? AND event_id = ? AND published_at IS NULL
      `).run(input.publishedAt, input.url, input.eventId);
      return updated.changes > 0;
    }
    return false;
  });
}

const FIELD_COLUMNS: Record<StoreField, { value: string; status: string; reason: string }> = {
  title: { value: 'title', status: 'title_status', reason: 'title_reason' },
  start: { value: 'start_utc', status: 'start_status', reason: 'start_reason' },
  end: { value: 'end_utc', status: 'end_status', reason: 'end_reason' },
  rewards: { value: 'rewards_json', status: 'rewards_status', reason: 'rewards_reason' },
  description: { value: 'description', status: 'description_status', reason: 'description_reason' },
};

interface SourceRecord {
  kind: EventSourceKind;
  publishedAt: string | null;
  firstSeenAt: string;
}

interface ProvenanceRecord {
  sourceUrl: string;
  sourceTime: string;
  kind: EventSourceKind;
}

function sourcePriority(field: StoreField, kind: EventSourceKind): number {
  if (field === 'title' && kind === 'maintenance') return 2;
  if (field === 'title' && kind === 'followup') return 1;
  if ((field === 'start' || field === 'end') && kind === 'followup') return 2;
  if ((field === 'start' || field === 'end') && kind === 'special') return 1;
  return 0;
}

function sourceTimeValue(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Invalid source time: ${value}`);
  return parsed;
}

function candidateWins(
  db: Store,
  eventId: number,
  field: StoreField,
  candidate: ProvenanceRecord,
  current: ProvenanceRecord | undefined,
): boolean {
  if (!current) return true;

  const priorityDifference = sourcePriority(field, candidate.kind) - sourcePriority(field, current.kind);
  if (priorityDifference !== 0) return priorityDifference > 0;

  const timeDifference = sourceTimeValue(candidate.sourceTime) - sourceTimeValue(current.sourceTime);
  if (timeDifference !== 0) return timeDifference > 0;
  if (candidate.sourceUrl === current.sourceUrl) return true;
  const key = ['source-time-tie', eventId, field, candidate.sourceTime].join(':');
  const firstOccurrence = db.prepare(`INSERT INTO meta (key, value) VALUES (?, '1')
    ON CONFLICT(key) DO NOTHING`).run(`warned:${key}`).changes > 0;
  if (firstOccurrence) {
    console.warn(`Für Ereignis ${eventId} und Feld „${field}“ gilt dieselbe Quellenzeit; die erste Quelle ${current.sourceUrl} bleibt erhalten.`);
  }
  return false;
}

function serializedValue(field: StoreField, value: string | Reward[]): string {
  if (field === 'rewards') {
    if (!Array.isArray(value)) throw new Error('Rewards field must be an array');
    return JSON.stringify(value);
  }
  if (typeof value !== 'string') throw new Error(`${field} field must be a string`);
  return value;
}

export function applyField(
  db: Store,
  eventId: number,
  field: StoreField,
  update: StoreFieldUpdate,
  sourceUrl: string,
  sourceTime?: string,
): boolean {
  return runTransaction(db, () => {
    const source = db.prepare(`
      SELECT kind, published_at AS publishedAt, first_seen_at AS firstSeenAt
      FROM event_sources
      WHERE url = ? AND event_id = ?
    `).get(sourceUrl, eventId) as SourceRecord | undefined;
    if (!source) throw new Error(`Source ${sourceUrl} is not attached to event ${eventId}`);

    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId) as { id: number } | undefined;
    if (!event) throw new Error(`Event ${eventId} does not exist`);

    const candidate: ProvenanceRecord = {
      sourceUrl,
      sourceTime: sourceTime ?? source.publishedAt ?? source.firstSeenAt,
      kind: source.kind,
    };
    const current = db.prepare(`
      SELECT field_provenance.source_url AS sourceUrl,
             field_provenance.source_time AS sourceTime,
             event_sources.kind AS kind
      FROM field_provenance
      JOIN event_sources ON event_sources.url = field_provenance.source_url
      WHERE field_provenance.event_id = ? AND field_provenance.field = ?
    `).get(eventId, field) as ProvenanceRecord | undefined;

    if (!candidateWins(db, eventId, field, candidate, current)) return false;

    const columns = FIELD_COLUMNS[field];
    const eventResult = update.status === 'ok'
      ? db.prepare(`
          UPDATE events
          SET ${columns.value} = ?, ${columns.status} = 'ok', ${columns.reason} = NULL
          WHERE id = ? AND (${columns.value} IS NOT ? OR ${columns.status} IS NOT 'ok' OR ${columns.reason} IS NOT NULL)
        `).run(serializedValue(field, update.value), eventId, serializedValue(field, update.value))
      : db.prepare(`
          UPDATE events
          SET ${columns.status} = 'unsicher', ${columns.reason} = ?
          WHERE id = ? AND (${columns.status} IS NOT 'unsicher' OR ${columns.reason} IS NOT ?)
        `).run(update.reason, eventId, update.reason);

    const provenanceResult = db.prepare(`
      INSERT INTO field_provenance (event_id, field, source_url, source_time)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(event_id, field) DO UPDATE SET
        source_url = excluded.source_url,
        source_time = excluded.source_time
      WHERE field_provenance.source_url IS NOT excluded.source_url
         OR field_provenance.source_time IS NOT excluded.source_time
    `).run(eventId, field, candidate.sourceUrl, candidate.sourceTime);

    return eventResult.changes > 0 || provenanceResult.changes > 0;
  });
}

interface RawStoreEvent extends Omit<StoreEvent, 'rewards'> {
  rewardsJson: string;
}

function mapStoreEvent({ rewardsJson, ...event }: RawStoreEvent): StoreEvent {
  const rewardsApplicable = event.eventType === 'seasonal-special';
  return {
    ...event,
    rewards: rewardsApplicable ? JSON.parse(rewardsJson) as Reward[] : [],
    rewardsStatus: rewardsApplicable ? event.rewardsStatus : 'n/a',
    rewardsReason: rewardsApplicable ? event.rewardsReason : null,
  };
}

export function getOpenEvents(db: Store, now: Date | string = new Date()): StoreEvent[] {
  const nowValue = now instanceof Date ? now.toISOString() : now;
  const rows = db.prepare(`
    SELECT id,
           event_key AS eventKey,
           event_type AS eventType,
           title,
           title_status AS titleStatus,
           title_reason AS titleReason,
           start_utc AS startUtc,
           start_status AS startStatus,
           start_reason AS startReason,
           end_utc AS endUtc,
           end_status AS endStatus,
           end_reason AS endReason,
           rewards_json AS rewardsJson,
           rewards_status AS rewardsStatus,
           rewards_reason AS rewardsReason,
           description,
           description_status AS descriptionStatus,
           description_reason AS descriptionReason,
           created_at AS createdAt
    FROM events
    WHERE end_status = 'unsicher'
       OR (end_utc IS NOT NULL AND julianday(end_utc) > julianday(?) - 2)
    ORDER BY created_at, id
  `).all(nowValue) as unknown as RawStoreEvent[];

  return rows.map(mapStoreEvent);
}

export function getAllEvents(db: Store): StoreEvent[] {
  const rows = db.prepare(`
    SELECT id,
           event_key AS eventKey,
           event_type AS eventType,
           title,
           title_status AS titleStatus,
           title_reason AS titleReason,
           start_utc AS startUtc,
           start_status AS startStatus,
           start_reason AS startReason,
           end_utc AS endUtc,
           end_status AS endStatus,
           end_reason AS endReason,
           rewards_json AS rewardsJson,
           rewards_status AS rewardsStatus,
           rewards_reason AS rewardsReason,
           description,
           description_status AS descriptionStatus,
           description_reason AS descriptionReason,
           created_at AS createdAt
    FROM events
    ORDER BY created_at, id
  `).all() as unknown as RawStoreEvent[];

  return rows.map(mapStoreEvent);
}

export function getEventSources(db: Store, eventId: number): StoreEventSource[] {
  return db.prepare(`
    SELECT event_id AS eventId,
           url,
           kind,
           published_at AS publishedAt,
           first_seen_at AS firstSeenAt
    FROM event_sources
    WHERE event_id = ?
    ORDER BY CASE kind WHEN 'special' THEN 0 WHEN 'banner' THEN 1 ELSE 2 END, url
  `).all(eventId) as unknown as StoreEventSource[];
}

export function getMetaValue(db: Store, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMetaValue(db: Store, key: string, value: string): boolean {
  return db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE meta.value IS NOT excluded.value
  `).run(key, value).changes > 0;
}

export function markSeen(db: Store, url: string, classification: string, firstSeenAt?: string): boolean {
  const result = db.prepare(`
    INSERT INTO seen_entries (url, first_seen_at, classification)
    VALUES (?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?)
    ON CONFLICT(url) DO UPDATE SET classification = excluded.classification
    WHERE seen_entries.classification IS NOT excluded.classification
  `).run(url, firstSeenAt ?? null, classification);
  return result.changes > 0;
}

export function isSeen(db: Store, url: string): boolean {
  return db.prepare('SELECT 1 FROM seen_entries WHERE url = ?').get(url) !== undefined;
}

export function cacheItem(
  db: Store,
  item: { itemId: string; name: string; iconUrl?: string | null; fetchedAt?: string },
): boolean {
  const result = db.prepare(`
    INSERT INTO items (item_id, name, icon_url, fetched_at)
    VALUES (?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
    ON CONFLICT(item_id) DO UPDATE SET
      name = excluded.name,
      icon_url = excluded.icon_url,
      fetched_at = excluded.fetched_at
    WHERE items.name IS NOT excluded.name OR items.icon_url IS NOT excluded.icon_url
  `).run(item.itemId, item.name, item.iconUrl ?? null, item.fetchedAt ?? null);
  return result.changes > 0;
}

export function getCachedItem(db: Store, itemId: string): CachedItem | undefined {
  const row = db.prepare(`
    SELECT item_id AS itemId,
           name,
           icon_url AS iconUrl,
           fetched_at AS fetchedAt
    FROM items
    WHERE item_id = ?
  `).get(itemId) as CachedItem | undefined;
  return row;
}
