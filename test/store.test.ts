import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyField,
  attachSource,
  cacheItem,
  createEvent,
  findEventByKey,
  findEventBySourceUrl,
  getCachedItem,
  getOpenEvents,
  isFirstRun,
  isSeen,
  markFirstRunDone,
  markSeen,
  openDb,
  setDiscordIds,
  warnOnce,
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
      'event_sources',
      'events',
      'field_provenance',
      'items',
      'meta',
      'reminders',
      'seen_entries',
      'warnings_sent',
    ]);

    const first = newEvent(db, 'first');
    const second = newEvent(db, 'second');
    const url = 'https://example.test/event';
    assert.equal(attachSource(db, { eventId: first, url, kind: 'topic' }), true);
    assert.equal(attachSource(db, { eventId: second, url, kind: 'topic' }), false);
    assert.equal(findEventBySourceUrl(db, url), first);
  } finally {
    db.close();
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

test('first-run state and warning keys are stored once', () => {
  const db = openDb(':memory:');
  try {
    assert.equal(isFirstRun(db), true);
    markFirstRunDone(db);
    assert.equal(isFirstRun(db), false);
    markFirstRunDone(db);
    assert.equal(isFirstRun(db), false);

    assert.equal(warnOnce(db, 'event-1:end'), true);
    assert.equal(warnOnce(db, 'event-1:end'), false);
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

    assert.equal(setDiscordIds(db, eventId, { discordMessageId: 'message-1', scheduledEventId: 'scheduled-1' }), true);
    assert.equal(setDiscordIds(db, eventId, { discordMessageId: 'message-1', scheduledEventId: 'scheduled-1' }), false);
    const saved = db.prepare('SELECT discord_message_id AS messageId, scheduled_event_id AS scheduledId FROM events WHERE id = ?').get(eventId) as { messageId: string; scheduledId: string };
    assert.deepEqual({ ...saved }, { messageId: 'message-1', scheduledId: 'scheduled-1' });

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
