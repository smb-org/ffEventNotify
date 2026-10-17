import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyField,
  attachSource,
  cacheItem,
  createEvent,
  findEventByKey,
  findEventBySourceUrl,
  getCachedItem,
  getConfiguredGuilds,
  ensureGuildEventFirstPostAttemptAt,
  getGuildEventObject,
  getGuild,
  getOpenEvents,
  isFirstRun,
  isSeen,
  markFirstRunDone,
  markSeen,
  openDb,
  setGuildDiscordIds,
  setGuildStatusMessage,
  upsertGuildSetup,
  deliverWarning,
  getPendingWarning,
  deleteGuild,
  markGuildFirstRunDone,
  markGuildNeedsSetup,
  getMetaValue,
  setMetaValue,
} from '../src/store.ts';

function newEvent(db: ReturnType<typeof openDb>, eventKey: string, eventType: 'seasonal-special' | 'maintenance' | 'topic-generic' = 'maintenance'): number {
  return createEvent(db, { eventKey, eventType, title: eventKey });
}

function addSource(db: ReturnType<typeof openDb>, eventId: number, url: string, kind: 'topic' | 'special' | 'maintenance' | 'followup' | 'feed' | 'banner', publishedAt?: string): void {
  attachSource(db, { eventId, url, kind, publishedAt });
}

test('creates the storage tables and enforces one event per source URL', () => {
  const db = openDb(':memory:');

  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    assert.deepEqual(rows.map((row) => row.name).sort(), [
      'checklist_entries',
      'checklist_items',
      'checklist_reminder_preferences',
      'event_sources',
      'events',
      'field_provenance',
      'guild_event_objects',
      'guild_sidebar_follows',
      'guilds',
      'items',
      'legacy_discord_refs',
      'meta',
      'reminder_deliveries',
      'reminder_slots',
      'reminders',
      'schema_version',
      'seen_entries',
      'short_links',
      'warnings_sent',
      'web_chars',
      'web_checklist',
      'web_user_guilds',
      'web_users',
    ]);

    const first = newEvent(db, 'first');
    const second = newEvent(db, 'second');
    const initialReasons = db.prepare(`
      SELECT start_reason AS start, end_reason AS end, rewards_reason AS rewards, description_reason AS description
      FROM events WHERE id = ?
    `).get(first) as { start: string; end: string; rewards: string; description: string };
    assert.deepEqual({ ...initialReasons }, {
      start: 'Nicht extrahiert',
      end: 'Nicht extrahiert',
      rewards: 'Nicht extrahiert',
      description: 'Nicht extrahiert',
    });
    const url = 'https://example.test/event';
    assert.equal(attachSource(db, { eventId: first, url, kind: 'topic' }), true);
    assert.equal(attachSource(db, { eventId: second, url, kind: 'topic' }), false);
    assert.equal(findEventBySourceUrl(db, url), first);
  } finally {
    db.close();
  }
});

test('translates legacy field reasons before they can appear in admin logs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-store-'));
  const path = join(directory, 'events.sqlite');
  let db = openDb(path);
  try {
    const eventId = newEvent(db, 'legacy-reasons');
    db.prepare(`
      UPDATE events
      SET start_reason = 'not extracted', end_reason = 'not extracted',
          rewards_reason = 'not extracted', description_reason = 'not extracted'
      WHERE id = ?
    `).run(eventId);
    db.close();

    db = openDb(path);
    const reasons = db.prepare(`
      SELECT start_reason AS start, end_reason AS end, rewards_reason AS rewards, description_reason AS description
      FROM events WHERE id = ?
    `).get(eventId) as { start: string; end: string; rewards: string; description: string };
    assert.deepEqual({ ...reasons }, {
      start: 'Nicht extrahiert',
      end: 'Nicht extrahiert',
      rewards: 'Nicht extrahiert',
      description: 'Nicht extrahiert',
    });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a follow-up end wins whether it is applied before or after the original', () => {
  for (const order of ['original-first', 'followup-first'] as const) {
    const db = openDb(':memory:');
    try {
      const eventId = newEvent(db, order);
      const originalUrl = `https://example.test/${order}/original`;
      const followupUrl = `https://example.test/${order}/followup`;
      addSource(db, eventId, originalUrl, 'maintenance', '2026-01-02T10:00:00.000Z');
      addSource(db, eventId, followupUrl, 'followup', '2026-01-01T10:00:00.000Z');

      const original = () => applyField(db, eventId, 'end', { status: 'ok', value: '2026-01-10T12:00:00.000Z' }, originalUrl, '2026-01-02T10:00:00.000Z');
      const followup = () => applyField(db, eventId, 'end', { status: 'ok', value: '2026-01-12T12:00:00.000Z' }, followupUrl, '2026-01-01T10:00:00.000Z');
      if (order === 'original-first') {
        original();
        followup();
      } else {
        followup();
        original();
      }

      const [saved] = getOpenEvents(db, '2026-01-01T00:00:00.000Z');
      assert.equal(saved?.endUtc, '2026-01-12T12:00:00.000Z');
    } finally {
      db.close();
    }
  }
});

test('a special page wins over a newer topic for the event period', () => {
  const db = openDb(':memory:');
  try {
    const eventId = newEvent(db, 'special-period', 'seasonal-special');
    const topicUrl = 'https://example.test/topic';
    const specialUrl = 'https://example.test/special';
    addSource(db, eventId, topicUrl, 'topic', '2026-01-02T10:00:00.000Z');
    addSource(db, eventId, specialUrl, 'special', '2026-01-01T10:00:00.000Z');
    applyField(db, eventId, 'end', { status: 'ok', value: '2026-02-10T00:00:00.000Z' }, topicUrl, '2026-01-02T10:00:00.000Z');
    applyField(db, eventId, 'end', { status: 'ok', value: '2026-02-12T00:00:00.000Z' }, specialUrl, '2026-01-01T10:00:00.000Z');

    assert.equal(getOpenEvents(db, '2026-01-10T00:00:00.000Z')[0]?.endUtc, '2026-02-12T00:00:00.000Z');
  } finally {
    db.close();
  }
});

test('an older source cannot overwrite a newer source of the same kind', () => {
  const db = openDb(':memory:');
  try {
    const eventId = newEvent(db, 'newest-source');
    const oldUrl = 'https://example.test/old';
    const newUrl = 'https://example.test/new';
    addSource(db, eventId, oldUrl, 'topic', '2026-01-01T10:00:00.000Z');
    addSource(db, eventId, newUrl, 'topic', '2026-01-02T10:00:00.000Z');
    applyField(db, eventId, 'end', { status: 'ok', value: '2026-01-15T00:00:00.000Z' }, newUrl, '2026-01-02T10:00:00.000Z');
    assert.equal(applyField(db, eventId, 'end', { status: 'ok', value: '2026-01-14T00:00:00.000Z' }, oldUrl, '2026-01-01T10:00:00.000Z'), false);

    assert.equal(getOpenEvents(db, '2026-01-10T00:00:00.000Z')[0]?.endUtc, '2026-01-15T00:00:00.000Z');
  } finally {
    db.close();
  }
});

test('equal source times keep the first value and warn once', () => {
  const db = openDb(':memory:');
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(' '));
  try {
    const eventId = newEvent(db, 'equal-source-time');
    const firstUrl = 'https://example.test/first';
    const secondUrl = 'https://example.test/second';
    const sourceTime = '2026-01-01T10:00:00.000Z';
    addSource(db, eventId, firstUrl, 'topic', sourceTime);
    addSource(db, eventId, secondUrl, 'topic', sourceTime);

    assert.equal(applyField(db, eventId, 'end', { status: 'ok', value: '2026-01-10T00:00:00.000Z' }, firstUrl, sourceTime), true);
    assert.equal(applyField(db, eventId, 'end', { status: 'ok', value: '2026-01-11T00:00:00.000Z' }, secondUrl, sourceTime), false);
    assert.equal(applyField(db, eventId, 'end', { status: 'ok', value: '2026-01-12T00:00:00.000Z' }, secondUrl, sourceTime), false);

    assert.equal(getOpenEvents(db, '2026-01-05T00:00:00.000Z')[0]?.endUtc, '2026-01-10T00:00:00.000Z');
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
    db.close();
  }
});

test('follow-up priority does not override a newer title', () => {
  const db = openDb(':memory:');
  try {
    const eventId = newEvent(db, 'followup-title-priority');
    const originalUrl = 'https://example.test/title-original';
    const followupUrl = 'https://example.test/title-followup';
    addSource(db, eventId, originalUrl, 'maintenance', '2026-01-02T10:00:00.000Z');
    addSource(db, eventId, followupUrl, 'followup', '2026-01-01T10:00:00.000Z');

    assert.equal(applyField(db, eventId, 'title', { status: 'ok', value: 'Original title' }, originalUrl, '2026-01-02T10:00:00.000Z'), true);
    assert.equal(applyField(db, eventId, 'title', { status: 'ok', value: 'Follow-up title' }, followupUrl, '2026-01-01T10:00:00.000Z'), false);
    assert.equal(getOpenEvents(db, '2026-01-01T00:00:00.000Z')[0]?.title, 'Original title');
  } finally {
    db.close();
  }
});

test('an uncertain refresh keeps the last known value and marks the field uncertain', () => {
  const db = openDb(':memory:');
  try {
    const eventId = newEvent(db, 'uncertain-refresh');
    const url = 'https://example.test/uncertain-refresh';
    addSource(db, eventId, url, 'maintenance', '2026-01-01T10:00:00.000Z');
    applyField(db, eventId, 'end', { status: 'ok', value: '2026-01-02T12:00:00.000Z' }, url, '2026-01-01T10:00:00.000Z');
    applyField(db, eventId, 'end', { status: 'unsicher', reason: 'The page no longer exposes an end time' }, url, '2026-01-01T10:00:00.000Z');

    const [saved] = getOpenEvents(db, '2026-01-20T00:00:00.000Z');
    assert.equal(saved?.endUtc, '2026-01-02T12:00:00.000Z');
    assert.equal(saved?.endStatus, 'unsicher');
    assert.equal(saved?.endReason, 'The page no longer exposes an end time');
  } finally {
    db.close();
  }
});

test('open events include future ends and ends less than 48 hours ago, but exclude older ends', () => {
  const db = openDb(':memory:');
  try {
    const future = newEvent(db, 'future');
    const recent = newEvent(db, 'recent');
    const boundary = newEvent(db, 'boundary');
    const stale = newEvent(db, 'stale');
    const unknown = newEvent(db, 'unknown');
    const entries = [
      [future, 'future', '2026-01-11T12:00:00.000Z'],
      [recent, 'recent', '2026-01-08T13:00:00.000Z'],
      [boundary, 'boundary', '2026-01-08T12:00:00.000Z'],
      [stale, 'stale', '2026-01-08T11:00:00.000Z'],
    ] as const;
    for (const [eventId, key, endUtc] of entries) {
      const url = `https://example.test/${key}`;
      addSource(db, eventId, url, 'maintenance');
      applyField(db, eventId, 'end', { status: 'ok', value: endUtc }, url, '2026-01-01T00:00:00.000Z');
    }
    const unknownUrl = 'https://example.test/unknown';
    addSource(db, unknown, unknownUrl, 'maintenance');
    applyField(db, unknown, 'end', { status: 'unsicher', reason: 'No end date on page' }, unknownUrl, '2026-01-01T00:00:00.000Z');

    const openIds = getOpenEvents(db, '2026-01-10T12:00:00.000Z').map((event) => event.id);
    assert.deepEqual(openIds.sort((a, b) => a - b), [future, recent, unknown].sort((a, b) => a - b));
  } finally {
    db.close();
  }
});

test('first-run state is stored once', () => {
  const db = openDb(':memory:');
  try {
    assert.equal(isFirstRun(db), true);
    markFirstRunDone(db);
    assert.equal(isFirstRun(db), false);
    markFirstRunDone(db);
    assert.equal(isFirstRun(db), false);

  } finally {
    db.close();
  }
});

test('seen entries, merge keys, Discord IDs, and item cache survive repeated calls', () => {
  const db = openDb(':memory:');
  try {
    const eventId = newEvent(db, 'generic:producer-live:93', 'topic-generic');
    assert.equal(createEvent(db, { eventKey: 'generic:producer-live:93', eventType: 'topic-generic', title: 'duplicate' }), eventId);
    assert.equal(findEventByKey(db, 'generic:producer-live:93'), eventId);
    addSource(db, eventId, 'https://example.test/source', 'topic');
    assert.equal(findEventBySourceUrl(db, 'https://example.test/source'), eventId);

    assert.equal(markSeen(db, 'https://example.test/seen', 'unclassified'), true);
    assert.equal(markSeen(db, 'https://example.test/seen', 'unclassified'), false);
    assert.equal(isSeen(db, 'https://example.test/seen'), true);

    upsertGuildSetup(db, { guildId: 'guild-1', eventChannelId: 'events-1', logChannelId: 'logs-1' });
    setGuildDiscordIds(db, 'guild-1', 'generic:producer-live:93', {
      messageId: 'message-1', messageChannelId: 'events-1', scheduledEventId: 'scheduled-1',
    });
    const saved = getGuildEventObject(db, 'guild-1', 'generic:producer-live:93');
    assert.deepEqual(saved && { messageId: saved.messageId, messageChannelId: saved.messageChannelId, scheduledEventId: saved.scheduledEventId }, {
      messageId: 'message-1', messageChannelId: 'events-1', scheduledEventId: 'scheduled-1',
    });

    cacheItem(db, { itemId: '1234', name: 'Testitem', iconUrl: 'https://example.test/icon.png', fetchedAt: '2026-01-01T00:00:00.000Z' });
    const cachedItem = getCachedItem(db, '1234');
    assert.deepEqual(cachedItem && { ...cachedItem }, {
      itemId: '1234',
      name: 'Testitem',
      iconUrl: 'https://example.test/icon.png',
      fetchedAt: '2026-01-01T00:00:00.000Z',
    });
  } finally {
    db.close();
  }
});

test('event data is shared while Discord objects and warning delivery state stay isolated per guild', async () => {
  const db = openDb(':memory:');
  try {
    const eventId = newEvent(db, 'shared-event');
    upsertGuildSetup(db, { guildId: 'guild-a', eventChannelId: 'events-a', logChannelId: 'logs-a' });
    upsertGuildSetup(db, { guildId: 'guild-b', eventChannelId: 'events-b', logChannelId: 'logs-b' });
    setGuildDiscordIds(db, 'guild-a', 'shared-event', { messageId: 'message-a', scheduledEventId: 'schedule-a' });
    setGuildDiscordIds(db, 'guild-b', 'shared-event', { messageId: 'message-b', scheduledEventId: 'schedule-b' });

    assert.equal(getOpenEvents(db, new Date())[0]?.id, eventId);
    assert.equal(getGuildEventObject(db, 'guild-a', 'shared-event')?.messageId, 'message-a');
    assert.equal(getGuildEventObject(db, 'guild-b', 'shared-event')?.messageId, 'message-b');

    let sends = 0;
    await assert.rejects(deliverWarning(db, 'guild-a', 'logs-a', 'uncertain:event', 'Belohnungen unsicher', async () => {
      sends += 1;
      throw new Error('temporary Discord failure');
    }), /temporary Discord failure/);
    assert.equal(getPendingWarning(db, 'guild-a', 'uncertain:event')?.content, 'Belohnungen unsicher');
    assert.equal(getPendingWarning(db, 'guild-b', 'uncertain:event'), undefined);
    assert.equal(await deliverWarning(db, 'guild-a', 'logs-a', 'uncertain:event', 'Belohnungen unsicher', async () => { sends += 1; }), true);
    assert.equal(await deliverWarning(db, 'guild-a', 'logs-a', 'uncertain:event', 'Belohnungen unsicher', async () => { sends += 1; }), false);
    assert.equal(sends, 2);

    deleteGuild(db, 'guild-a');
    assert.equal(getGuildEventObject(db, 'guild-a', 'shared-event'), undefined);
    assert.equal(getGuildEventObject(db, 'guild-b', 'shared-event')?.messageId, 'message-b');
  } finally {
    db.close();
  }
});

test('Discord reconciliation writes cannot recreate a guild after its removal', () => {
  const db = openDb(':memory:');
  try {
    const eventId = newEvent(db, 'removed-guild-event');
    addSource(db, eventId, 'https://example.test/removed-guild-event', 'topic');
    upsertGuildSetup(db, { guildId: 'departed', eventChannelId: 'events', logChannelId: 'logs' });
    deleteGuild(db, 'departed');

    setGuildDiscordIds(db, 'departed', 'removed-guild-event', { messageId: 'stale-message' });

    assert.equal(getGuild(db, 'departed'), undefined);
    assert.equal(getGuildEventObject(db, 'departed', 'removed-guild-event'), undefined);
  } finally {
    db.close();
  }
});

test('removing a guild prunes its id from pending discovery first-run metadata', () => {
  const db = openDb(':memory:');
  try {
    upsertGuildSetup(db, { guildId: 'departed', eventChannelId: 'events', logChannelId: 'logs' });
    upsertGuildSetup(db, { guildId: 'remaining', eventChannelId: 'events-remaining', logChannelId: 'logs-remaining' });
    setMetaValue(db, 'pending_discoveries', JSON.stringify([{
      entry: { title: 'pending', url: 'https://example.test/pending', source: 'topic' },
      firstRun: true,
      firstRunGuildIds: ['departed', 'remaining'],
    }]));

    deleteGuild(db, 'departed');

    const pending = JSON.parse(getMetaValue(db, 'pending_discoveries') ?? '[]') as Array<{ firstRunGuildIds: string[] }>;
    assert.deepEqual(pending[0]?.firstRunGuildIds, ['remaining']);
  } finally {
    db.close();
  }
});

test('setup channel changes clear only that guild message and status references and preserve its schedule', () => {
  const db = openDb(':memory:');
  try {
    const eventId = newEvent(db, 'channel-change');
    upsertGuildSetup(db, { guildId: 'guild-a', eventChannelId: 'old-events', logChannelId: 'old-logs' });
    markGuildFirstRunDone(db, 'guild-a');
    setGuildDiscordIds(db, 'guild-a', 'channel-change', {
      messageId: 'old-message', messageChannelId: 'old-events', scheduledEventId: 'existing-schedule',
    });
    ensureGuildEventFirstPostAttemptAt(db, 'guild-a', 'channel-change', '2026-10-16T12:00:00.000Z');
    setGuildStatusMessage(db, 'guild-a', 'old-status');
    markGuildNeedsSetup(db, 'guild-a');

    const updated = upsertGuildSetup(db, { guildId: 'guild-a', eventChannelId: 'new-events', logChannelId: 'new-logs' });

    assert.deepEqual(updated, { created: false, channelsChanged: true });
    assert.deepEqual(getGuild(db, 'guild-a') && {
      eventChannelId: getGuild(db, 'guild-a')!.eventChannelId,
      logChannelId: getGuild(db, 'guild-a')!.logChannelId,
      firstRunDone: getGuild(db, 'guild-a')!.firstRunDone,
      needsSetup: getGuild(db, 'guild-a')!.needsSetup,
      statusMessageId: getGuild(db, 'guild-a')!.statusMessageId,
    }, {
      eventChannelId: 'new-events', logChannelId: 'new-logs', firstRunDone: false, needsSetup: false, statusMessageId: null,
    });
    assert.equal(getGuildEventObject(db, 'guild-a', 'channel-change')?.messageId, null);
    assert.equal(getGuildEventObject(db, 'guild-a', 'channel-change')?.scheduledEventId, 'existing-schedule');
    assert.equal(getGuildEventObject(db, 'guild-a', 'channel-change')?.firstPostAttemptAt, null);
    assert.deepEqual(getGuildEventObject(db, 'guild-a', 'channel-change')?.continuationMessageIds, []);
    assert.equal(getConfiguredGuilds(db).some((guild) => guild.guildId === 'guild-a'), true);
    assert.equal(getOpenEvents(db).some((event) => event.id === eventId), true);
  } finally {
    db.close();
  }
});

test('changing only the log channel preserves event posts and the pinned status reference', () => {
  const db = openDb(':memory:');
  try {
    newEvent(db, 'shared-event');
    upsertGuildSetup(db, { guildId: 'guild-a', eventChannelId: 'events-a', logChannelId: 'old-logs' });
    setGuildDiscordIds(db, 'guild-a', 'shared-event', {
      messageId: 'event-message', messageChannelId: 'events-a', scheduledEventId: 'schedule',
    });
    setGuildStatusMessage(db, 'guild-a', 'status-message');

    const result = upsertGuildSetup(db, { guildId: 'guild-a', eventChannelId: 'events-a', logChannelId: 'new-logs' });

    assert.deepEqual(result, { created: false, channelsChanged: true });
    assert.equal(getGuildEventObject(db, 'guild-a', 'shared-event')?.messageId, 'event-message');
    assert.equal(getGuildEventObject(db, 'guild-a', 'shared-event')?.scheduledEventId, 'schedule');
    assert.equal(getGuild(db, 'guild-a')?.statusMessageId, 'status-message');
  } finally {
    db.close();
  }
});

test('applying an identical field and provenance is a no-op after the first write', () => {
  const db = openDb(':memory:');
  try {
    const eventId = newEvent(db, 'idempotent');
    const url = 'https://example.test/idempotent';
    addSource(db, eventId, url, 'topic');
    const field = { status: 'ok', value: '2026-01-15T00:00:00.000Z' } as const;

    assert.equal(applyField(db, eventId, 'end', field, url, '2026-01-01T00:00:00.000Z'), true);
    for (let i = 0; i < 9; i += 1) {
      assert.equal(applyField(db, eventId, 'end', field, url, '2026-01-01T00:00:00.000Z'), false);
    }

    const event = db.prepare('SELECT end_utc AS endUtc, end_status AS status FROM events WHERE id = ?').get(eventId) as { endUtc: string; status: string };
    const provenance = db.prepare('SELECT source_url AS sourceUrl, source_time AS sourceTime FROM field_provenance WHERE event_id = ? AND field = ?').get(eventId, 'end') as { sourceUrl: string; sourceTime: string };
    assert.deepEqual({ ...event }, { endUtc: '2026-01-15T00:00:00.000Z', status: 'ok' });
    assert.deepEqual({ ...provenance }, { sourceUrl: url, sourceTime: '2026-01-01T00:00:00.000Z' });
  } finally {
    db.close();
  }
});
