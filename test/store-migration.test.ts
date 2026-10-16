import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { getGuildEventObject, openDb, upsertGuildSetup } from '../src/store.ts';

test('v1 schema migrates idempotently, preserving warnings and single-guild Discord references', () => {
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
    assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 4);
    assert.ok((db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'short_links'").get()));
    assert.equal((db.prepare('SELECT key FROM legacy_warnings_sent_v1').get() as { key: string }).key, 'legacy-warning-key');
    assert.deepEqual((db.prepare('PRAGMA table_info(warnings_sent)').all() as Array<{ name: string }>).map(({ name }) => name), [
      'guild_id', 'key', 'content', 'status', 'created_at', 'sent_at',
    ]);

    upsertGuildSetup(db, { guildId: 'legacy-server', eventChannelId: 'events', logChannelId: 'logs' });
    assert.equal((db.prepare('SELECT guild_id AS guildId, status FROM warnings_sent WHERE key = ?').get('legacy-warning-key') as { guildId: string; status: string }).guildId, 'legacy-server');
    assert.equal((db.prepare('SELECT status FROM warnings_sent WHERE key = ?').get('legacy-warning-key') as { status: string }).status, 'sent');
    assert.deepEqual(getGuildEventObject(db, 'legacy-server', 'legacy:event') && {
      messageId: getGuildEventObject(db, 'legacy-server', 'legacy:event')!.messageId,
      scheduledEventId: getGuildEventObject(db, 'legacy-server', 'legacy:event')!.scheduledEventId,
    }, { messageId: 'old-message', scheduledEventId: 'old-schedule' });
    db.close();
    db = undefined;

    db = openDb(path);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM guild_event_objects').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_warnings_sent_v1').get() as { count: number }).count, 1);
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
    assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 4);
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
