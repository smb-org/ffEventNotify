// Web checklist data: personal tokens, characters and per-character progress.

import { runTransaction, type Store, type StoreEvent } from '../store.ts';
import type { TokenCodec } from './token.ts';

export const MAX_CHARS = 12;
export const MAX_NAME_LENGTH = 32;

/** An input problem that is safe to show to the player. */
export class WebInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface WebChar {
  id: number;
  name: string;
  sortOrder: number;
  remind: boolean;
}

export function getOrCreateToken(db: Store, codec: TokenCodec, userId: string): string {
  const row = db.prepare('SELECT token_enc AS enc FROM web_users WHERE user_id = ?').get(userId) as { enc: string } | undefined;
  return row ? codec.decrypt(row.enc) : rotateToken(db, codec, userId);
}

export function rotateToken(db: Store, codec: TokenCodec, userId: string): string {
  const token = codec.newToken();
  db.prepare(`INSERT INTO web_users (user_id, token_enc, token_hmac) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET token_enc = excluded.token_enc, token_hmac = excluded.token_hmac,
      created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run(userId, codec.encrypt(token), codec.hmac(token));
  return token;
}

export function findUserByToken(db: Store, codec: TokenCodec, token: string): string | undefined {
  const row = db.prepare('SELECT user_id AS userId FROM web_users WHERE token_hmac = ?').get(codec.hmac(token)) as { userId: string } | undefined;
  return row?.userId;
}

export function recordUserGuild(db: Store, userId: string, guildId: string): void {
  db.prepare(`INSERT OR IGNORE INTO web_user_guilds (user_id, guild_id)
    SELECT ?, guild_id FROM guilds WHERE guild_id = ?`).run(userId, guildId);
}

export function listChars(db: Store, userId: string): WebChar[] {
  return (db.prepare(`SELECT id, name, sort_order AS sortOrder, remind FROM web_chars
    WHERE user_id = ? ORDER BY sort_order, id`).all(userId) as Array<Omit<WebChar, 'remind'> & { remind: number }>)
    .map((row) => ({ ...row, remind: row.remind === 1 }));
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) throw new WebInputError(`Der Name muss 1 bis ${MAX_NAME_LENGTH} Zeichen lang sein.`);
  if (/\p{C}/u.test(name)) throw new WebInputError('Der Name enthält unzulässige Zeichen.');
  return name;
}

function assertUnique(db: Store, userId: string, name: string, exceptId = 0): void {
  const folded = name.toLocaleLowerCase('de');
  const clash = listChars(db, userId).some((entry) => entry.id !== exceptId && entry.name.toLocaleLowerCase('de') === folded);
  if (clash) throw new WebInputError('So einen Char hast du schon.');
}

export function createChar(db: Store, userId: string, rawName: unknown): WebChar {
  const name = cleanName(rawName);
  return runTransaction(db, () => {
    const existing = listChars(db, userId);
    if (existing.length >= MAX_CHARS) throw new WebInputError(`Mehr als ${MAX_CHARS} Chars sind nicht möglich.`);
    assertUnique(db, userId, name);
    const sortOrder = existing.length === 0 ? 0 : Math.max(...existing.map((entry) => entry.sortOrder)) + 1;
    const remind = existing.length === 0;
    const id = Number(db.prepare('INSERT INTO web_chars (user_id, name, sort_order, remind) VALUES (?, ?, ?, ?)')
      .run(userId, name, sortOrder, remind ? 1 : 0).lastInsertRowid);
    return { id, name, sortOrder, remind };
  });
}

function requireChar(db: Store, userId: string, charId: unknown): WebChar {
  const found = typeof charId === 'number' ? listChars(db, userId).find((entry) => entry.id === charId) : undefined;
  if (!found) throw new WebInputError('Char nicht gefunden.', 404);
  return found;
}

export function renameChar(db: Store, userId: string, charId: unknown, rawName: unknown): void {
  const name = cleanName(rawName);
  runTransaction(db, () => {
    const found = requireChar(db, userId, charId);
    assertUnique(db, userId, name, found.id);
    db.prepare('UPDATE web_chars SET name = ? WHERE id = ?').run(name, found.id);
  });
}

export function deleteChar(db: Store, userId: string, charId: unknown): void {
  const found = requireChar(db, userId, charId);
  db.prepare('DELETE FROM web_chars WHERE id = ?').run(found.id);
}

export function reorderChars(db: Store, userId: string, ids: unknown): void {
  const current = listChars(db, userId).map((entry) => entry.id);
  if (!Array.isArray(ids) || ids.length !== current.length || !current.every((id) => ids.includes(id))) {
    throw new WebInputError('Ungültige Reihenfolge.');
  }
  runTransaction(db, () => {
    const update = db.prepare('UPDATE web_chars SET sort_order = ? WHERE id = ?');
    (ids as number[]).forEach((id, index) => update.run(index, id));
  });
}

export function setCharRemind(db: Store, userId: string, charId: unknown, remind: unknown): void {
  if (typeof remind !== 'boolean') throw new WebInputError('Ungültige Eingabe.');
  const found = requireChar(db, userId, charId);
  db.prepare('UPDATE web_chars SET remind = ? WHERE id = ?').run(remind ? 1 : 0, found.id);
}

export function setItemDone(
  db: Store,
  userId: string,
  input: { charId: unknown; eventKey: string; itemId: string; done: unknown },
  now = new Date(),
): void {
  if (typeof input.done !== 'boolean') throw new WebInputError('Ungültige Eingabe.');
  const found = requireChar(db, userId, input.charId);
  if (input.done) {
    db.prepare(`INSERT INTO web_checklist (char_id, event_key, item_id, done_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(char_id, event_key, item_id) DO NOTHING`).run(found.id, input.eventKey, input.itemId, now.toISOString());
  } else {
    db.prepare('DELETE FROM web_checklist WHERE char_id = ? AND event_key = ? AND item_id = ?')
      .run(found.id, input.eventKey, input.itemId);
  }
}

/** Done keys `charId|eventKey|itemId` for all of a user's characters. */
export function getDoneKeys(db: Store, userId: string): Set<string> {
  const rows = db.prepare(`SELECT c.char_id AS charId, c.event_key AS eventKey, c.item_id AS itemId
    FROM web_checklist c JOIN web_chars w ON w.id = c.char_id WHERE w.user_id = ?`).all(userId) as Array<{ charId: number; eventKey: string; itemId: string }>;
  return new Set(rows.map((row) => `${row.charId}|${row.eventKey}|${row.itemId}`));
}

export interface ReminderChar { name: string; open: number }
export interface ReminderRecipient { userId: string; chars: ReminderChar[] }

/** Users linked to the guild with at least one reminding character that still misses a reward. */
export function getReminderRecipients(db: Store, guildId: string, event: Pick<StoreEvent, 'eventKey' | 'rewards'>): ReminderRecipient[] {
  const itemIds = new Set(event.rewards.map((reward) => reward.itemId));
  if (itemIds.size === 0) return [];
  const rows = db.prepare(`SELECT w.user_id AS userId, w.id AS charId, w.name AS name
    FROM web_user_guilds g JOIN web_chars w ON w.user_id = g.user_id
    WHERE g.guild_id = ? AND w.remind = 1 ORDER BY w.user_id, w.sort_order, w.id`).all(guildId) as Array<{ userId: string; charId: number; name: string }>;
  const doneStatement = db.prepare('SELECT item_id AS itemId FROM web_checklist WHERE char_id = ? AND event_key = ?');
  const recipients = new Map<string, ReminderChar[]>();
  for (const row of rows) {
    const done = (doneStatement.all(row.charId, event.eventKey) as Array<{ itemId: string }>).filter(({ itemId }) => itemIds.has(itemId)).length;
    const open = itemIds.size - done;
    if (open <= 0) continue;
    recipients.set(row.userId, [...(recipients.get(row.userId) ?? []), { name: row.name, open }]);
  }
  return [...recipients].map(([userId, chars]) => ({ userId, chars }));
}

export interface EventDiscordLink { eventKey: string; guildId: string; guildName: string | null; threadId: string }

/** Forum posts (thread id = starter message id) of the user's guilds, one row per guild and event. */
export function listEventDiscordLinks(db: Store, userId: string): EventDiscordLink[] {
  return db.prepare(`SELECT o.event_key AS eventKey, o.guild_id AS guildId, g.name AS guildName, o.message_id AS threadId
    FROM web_user_guilds u JOIN guilds g ON g.guild_id = u.guild_id
    JOIN guild_event_objects o ON o.guild_id = u.guild_id
    WHERE u.user_id = ? AND o.message_id IS NOT NULL AND o.message_channel_id IS g.event_channel_id
    ORDER BY u.guild_id`).all(userId) as unknown as EventDiscordLink[];
}
