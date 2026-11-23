import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { applyField, attachSource, createEvent, findEventBySourceUrl, getGuildEventObject, openDb, upsertGuildSetup } from '../src/store.ts';

function foreignKeyDefinitions(db: ReturnType<typeof openDb>): string[] {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  return tables.flatMap(({ name }) => {
    const escapedName = name.replaceAll('"', '""');
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list("${escapedName}")`).all() as Array<{
      table: string; from: string; to: string; on_delete: string;
    }>;
    return foreignKeys.map(({ table, from, to, on_delete }) => `${name}:${from}->${table}.${to}:${on_delete}`);
  }).sort();
}

test('v1 schema migrates idempotently, preserving warnings while ignoring legacy text-card references', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-migration-'));
  const path = join(directory, 'v1.sqlite');
  let db: ReturnType<typeof openDb> | undefined;
  try {
    const seeded = new DatabaseSync(path);
    seeded.exec(readFileSync(new URL('./fixtures/schema/v1.sql', import.meta.url), 'utf8'));
    seeded.prepare(`INSERT INTO events (event_key, event_type, title, discord_message_id, scheduled_event_id)
      VALUES (?, ?, ?, ?, ?)`).run('legacy:event', 'topic-generic', 'Legacy title', 'old-message', 'old-schedule');
    seeded.prepare('INSERT INTO warnings_sent (key) VALUES (?)').run('legacy-warning-key');
    seeded.close();

    db = openDb(path);
    assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 13);
    assert.ok((db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'short_links'").get()));
    assert.equal((db.prepare('SELECT key FROM legacy_warnings_sent_v1').get() as { key: string }).key, 'legacy-warning-key');
    assert.deepEqual((db.prepare('PRAGMA table_info(warnings_sent)').all() as Array<{ name: string }>).map(({ name }) => name), [
      'guild_id', 'key', 'content', 'status', 'created_at', 'sent_at',
    ]);

    upsertGuildSetup(db, { guildId: 'legacy-server', eventChannelId: 'events', logChannelId: 'logs' });
    assert.equal((db.prepare('SELECT guild_id AS guildId, status FROM warnings_sent WHERE key = ?').get('legacy-warning-key') as { guildId: string; status: string }).guildId, 'legacy-server');
    assert.equal((db.prepare('SELECT status FROM warnings_sent WHERE key = ?').get('legacy-warning-key') as { status: string }).status, 'sent');
    assert.equal(getGuildEventObject(db, 'legacy-server', 'legacy:event'), undefined);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_discord_refs').get() as { count: number }).count, 1);
    const eventColumns = new Set((db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(({ name }) => name));
    assert.ok(eventColumns.has('retracted_at'));
    assert.ok(eventColumns.has('retraction_reason'));
    db.close();
    db = undefined;

    db = openDb(path);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM guild_event_objects').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_warnings_sent_v1').get() as { count: number }).count, 1);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v9 schema adds the patch-bound end column without changing existing event data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-v9-migration-'));
  const path = join(directory, 'v9.sqlite');
  let db: ReturnType<typeof openDb> | undefined;
  try {
    const seeded = new DatabaseSync(path);
    seeded.exec(readFileSync(new URL('./fixtures/schema/v1.sql', import.meta.url), 'utf8'));
    seeded.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version (version) VALUES (9)');
    seeded.prepare('INSERT INTO events (event_key, event_type, title) VALUES (?, ?, ?)')
      .run('legacy:event', 'seasonal-special', 'Vorhandenes Event');
    seeded.close();

    db = openDb(path);
    assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 13);
    assert.ok((db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).some(({ name }) => name === 'end_patch'));
    assert.ok((db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).some(({ name }) => name === 'end_patch_source_url'));
    assert.equal((db.prepare('SELECT title FROM events WHERE event_key = ?').get('legacy:event') as { title: string }).title, 'Vorhandenes Event');
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v10 schema adds retraction state without changing existing event data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-v10-migration-'));
  const path = join(directory, 'v10.sqlite');
  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb(path);
    db.prepare('INSERT INTO events (event_key, event_type, title) VALUES (?, ?, ?)')
      .run('existing:event', 'topic-generic', 'Vorhandenes Event');
    db.close();
    db = undefined;

    const seeded = new DatabaseSync(path);
    seeded.exec(`ALTER TABLE events DROP COLUMN retraction_reason;
      ALTER TABLE events DROP COLUMN retracted_at;
      UPDATE schema_version SET version = 10;`);
    seeded.close();

    db = openDb(path);
    assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 13);
    const columns = new Set((db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(({ name }) => name));
    assert.ok(columns.has('retracted_at'));
    assert.ok(columns.has('retraction_reason'));
    assert.equal((db.prepare('SELECT title FROM events WHERE event_key = ?').get('existing:event') as { title: string }).title, 'Vorhandenes Event');
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v12 migration preserves data, source uniqueness, foreign keys, and the deleted event id high-water mark', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-v12-migration-'));
  const path = join(directory, 'v12.sqlite');
  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb(path);
    const eventId = createEvent(db, { eventKey: 'existing:event', eventType: 'topic-generic', title: 'Vorhandenes Event' });
    const maintenanceId = createEvent(db, { eventKey: 'maintenance:all-worlds', eventType: 'maintenance', title: 'Wartung aller Welten' });
    const deletedMaxId = createEvent(db, { eventKey: 'deleted:max-id', eventType: 'topic-generic', title: 'Gelöschtes Event' });
    db.prepare('DELETE FROM events WHERE id = ?').run(deletedMaxId);
    const eventUrl = 'https://de.finalfantasyxiv.com/lodestone/topics/detail/existing';
    const maintenanceUrl = 'https://de.finalfantasyxiv.com/lodestone/news/detail/maintenance';
    upsertGuildSetup(db, { guildId: 'guild', eventChannelId: 'events', logChannelId: 'logs' });
    db.prepare('INSERT INTO guild_event_objects (guild_id, event_key) VALUES (?, ?)').run('guild', 'existing:event');
    attachSource(db, { eventId, url: eventUrl, kind: 'topic' });
    attachSource(db, { eventId: maintenanceId, url: maintenanceUrl, kind: 'maintenance' });
    applyField(db, eventId, 'title', { status: 'ok', value: 'Vorhandenes Event' }, eventUrl);
    db.prepare(`INSERT INTO field_provenance (event_id, field, source_url, source_time)
      VALUES (?, 'end', ?, '2026-10-16T10:00:00.000Z')`).run(eventId, maintenanceUrl);
    const foreignKeysBefore = foreignKeyDefinitions(db);
    db.close();
    db = undefined;

    const seeded = new DatabaseSync(path);
    const eventSchema = (seeded.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'").get() as { sql: string }).sql;
    const oldEventSchema = eventSchema
      .replace('CREATE TABLE events', 'CREATE TABLE events_v12')
      .replace(", 'pvp-season'", '')
      .replace(/,\s*end_expected_date TEXT(?=\s*\))/u, '');
    const v12Columns = (seeded.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>)
      .map(({ name }) => name).filter((name) => name !== 'end_expected_date')
      .map((name) => `"${name.replaceAll('"', '""')}"`).join(', ');
    seeded.exec(`PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN;
      ${oldEventSchema};
      INSERT INTO events_v12 (${v12Columns}) SELECT ${v12Columns} FROM events;
      DROP TABLE events;
      ALTER TABLE events_v12 RENAME TO events;
      UPDATE schema_version SET version = 12;
      COMMIT;
      PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;`);
    seeded.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'events'").run(deletedMaxId);
    seeded.close();

    db = openDb(path);
    assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 13);
    assert.equal((db.prepare('SELECT title FROM events WHERE event_key = ?').get('existing:event') as { title: string }).title, 'Vorhandenes Event');
    assert.equal((db.prepare('SELECT source_url AS sourceUrl FROM field_provenance WHERE event_id = ? AND field = ?').get(eventId, 'end') as { sourceUrl: string }).sourceUrl, maintenanceUrl);
    assert.equal(findEventBySourceUrl(db, maintenanceUrl), maintenanceId);
    assert.equal(attachSource(db, { eventId, url: maintenanceUrl, kind: 'maintenance' }), false);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM event_sources').get() as { count: number }).count, 2);
    assert.deepEqual(foreignKeyDefinitions(db), foreignKeysBefore);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(getGuildEventObject(db, 'guild', 'existing:event')?.eventKey, 'existing:event');
    const pvpId = createEvent(db, { eventKey: 'pvp:cc:22', eventType: 'pvp-season', title: 'Crystalline Conflict – 22. Saison' });
    assert.equal(pvpId, deletedMaxId + 1);
    assert.equal((db.prepare('SELECT event_type AS eventType FROM events WHERE event_key = ?').get('pvp:cc:22') as { eventType: string }).eventType, 'pvp-season');
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v2 schema adds event post attempts and preserves legacy batch reminder deliveries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-v2-migration-'));
  const path = join(directory, 'v2.sqlite');
  let db: ReturnType<typeof openDb> | undefined;
  try {
    const seeded = new DatabaseSync(path);
    seeded.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (2);
      CREATE TABLE guild_event_objects (
        guild_id TEXT NOT NULL, event_key TEXT NOT NULL, message_id TEXT, message_channel_id TEXT,
        scheduled_event_id TEXT, status TEXT NOT NULL DEFAULT 'pending', last_error TEXT,
        first_run_suppressed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE reminder_deliveries (
        guild_id TEXT NOT NULL, event_key TEXT NOT NULL, lead_hours INTEGER NOT NULL,
        batch_key TEXT NOT NULL, sent_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, event_key, lead_hours, batch_key)
      );
      INSERT INTO reminder_deliveries VALUES ('guild', 'event', 72, 'old-batch', '2026-10-17T12:00:00.000Z');
    `);
    seeded.close();

    db = openDb(path);
    assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 13);
    assert.ok((db.prepare('PRAGMA table_info(guild_event_objects)').all() as Array<{ name: string }>)
      .some(({ name }) => name === 'first_post_attempt_at'));
    assert.equal((db.prepare('SELECT batch_key FROM legacy_reminder_deliveries_v2').get() as { batch_key: string }).batch_key, 'old-batch');
    assert.deepEqual((db.prepare('PRAGMA table_info(reminder_deliveries)').all() as Array<{ name: string }>)
      .map(({ name }) => name), ['guild_id', 'event_key', 'lead_hours', 'user_id', 'status', 'first_attempt_at', 'sent_at']);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v4 schema migration adds forum continuation metadata without changing guild event keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-v4-migration-'));
  const path = join(directory, 'v4.sqlite');
  let db: ReturnType<typeof openDb> | undefined;
  try {
    const seeded = new DatabaseSync(path);
    seeded.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (4);
      CREATE TABLE guild_event_objects (
        guild_id TEXT NOT NULL, event_key TEXT NOT NULL, message_id TEXT, message_channel_id TEXT,
        scheduled_event_id TEXT, first_post_attempt_at TEXT, status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT, first_run_suppressed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO guild_event_objects (guild_id, event_key, message_id) VALUES ('guild', 'event', 'card');
    `);
    seeded.close();

    db = openDb(path);
    assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 13);
    assert.ok((db.prepare('PRAGMA table_info(guild_event_objects)').all() as Array<{ name: string }>).some(({ name }) => name === 'reminder_thread_id'));
    assert.ok((db.prepare('PRAGMA table_info(guild_event_objects)').all() as Array<{ name: string }>).some(({ name }) => name === 'continuation_message_ids'));
    assert.equal((db.prepare('SELECT message_id AS messageId, reminder_thread_id AS reminderThreadId FROM guild_event_objects').get() as { messageId: string; reminderThreadId: string | null }).messageId, 'card');
    assert.equal((db.prepare('SELECT reminder_thread_id AS reminderThreadId FROM guild_event_objects').get() as { reminderThreadId: string | null }).reminderThreadId, null);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v6 schema adds keep-alive timestamps for event and status forum posts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-v6-migration-'));
  const path = join(directory, 'v6.sqlite');
  let db: ReturnType<typeof openDb> | undefined;
  try {
    const seeded = new DatabaseSync(path);
    seeded.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (6);
      CREATE TABLE guilds (
        guild_id TEXT PRIMARY KEY, event_channel_id TEXT, log_channel_id TEXT, setup_at TEXT,
        first_run_done INTEGER NOT NULL DEFAULT 0, needs_setup INTEGER NOT NULL DEFAULT 0, status_message_id TEXT
      );
      CREATE TABLE guild_event_objects (
        guild_id TEXT NOT NULL, event_key TEXT NOT NULL, message_id TEXT, message_channel_id TEXT,
        scheduled_event_id TEXT, reminder_thread_id TEXT, continuation_message_ids TEXT NOT NULL DEFAULT '[]',
        first_post_attempt_at TEXT, status TEXT NOT NULL DEFAULT 'pending', last_error TEXT,
        first_run_suppressed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO guilds (guild_id, status_message_id) VALUES ('guild', 'status');
      INSERT INTO guild_event_objects (guild_id, event_key, message_id) VALUES ('guild', 'event', 'post');
    `);
    seeded.close();

    db = openDb(path);
    assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 13);
    assert.ok((db.prepare('PRAGMA table_info(guilds)').all() as Array<{ name: string }>).some(({ name }) => name === 'status_last_keepalive_at'));
    assert.ok((db.prepare('PRAGMA table_info(guild_event_objects)').all() as Array<{ name: string }>).some(({ name }) => name === 'last_keepalive_at'));
    assert.equal((db.prepare('SELECT message_id AS messageId, last_keepalive_at AS lastKeepaliveAt FROM guild_event_objects').get() as { messageId: string; lastKeepaliveAt: string | null }).messageId, 'post');
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v11 schema adds skip tables while preserving per-character done rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-v11-migration-'));
  const path = join(directory, 'v11.sqlite');
  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb(path);
    db.prepare("INSERT INTO events (event_key, event_type, title) VALUES (?, 'seasonal-special', ?)")
      .run('existing:event', 'Vorhandenes Event');
    db.prepare("INSERT INTO web_chars (user_id, name, sort_order) VALUES ('user', 'Mira', 0)").run();
    const charId = (db.prepare('SELECT id FROM web_chars WHERE user_id = ?').get('user') as { id: number }).id;
    db.prepare('INSERT INTO web_checklist (char_id, event_key, item_id, done_at) VALUES (?, ?, ?, ?)')
      .run(charId, 'existing:event', 'reward', '2026-10-17T12:00:00.000Z');
    db.exec('DROP TABLE web_skipped; DROP TABLE web_skipped_all; UPDATE schema_version SET version = 11');
    db.close();
    db = undefined;

    db = openDb(path);
    assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 13);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM web_checklist').get() as { count: number }).count, 1);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'web_skipped'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'web_skipped_all'").get());
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
