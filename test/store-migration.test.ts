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
    assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 2);
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
