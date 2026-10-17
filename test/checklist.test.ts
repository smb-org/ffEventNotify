import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags } from 'discord.js';
import { handleChecklistInteraction, handleNewLinkCommand, parseChecklistCustomId } from '../src/interactions/checklist.ts';
import { stableEventIdentity } from '../src/event-identity.ts';
import { createFfEventsCommand } from '../src/commands.ts';
import { applyField, createEvent, openDb, upsertGuildSetup } from '../src/store.ts';
import { findUserByToken } from '../src/web/data.ts';
import { createTokenCodec } from '../src/web/token.ts';

const codec = createTokenCodec(Buffer.alloc(32, 3).toString('base64'));
const web = { codec, baseUrl: 'https://ffe.example.de' };
const eventKey = 'seasonal-special:/lodestone/special/mogmog/';
const hash = stableEventIdentity(eventKey).slice(0, 32);

function seed(db: ReturnType<typeof openDb>) {
  upsertGuildSetup(db, { guildId: 'guild-1', eventChannelId: 'events', logChannelId: 'logs' });
  const eventId = createEvent(db, { eventKey, eventType: 'seasonal-special', title: 'Mog Mog-Kollektion 2026' });
  const url = 'https://de.finalfantasyxiv.com/lodestone/special/mogmog/';
  db.prepare('INSERT INTO event_sources (url, event_id, kind) VALUES (?, ?, ?)').run(url, eventId, 'special');
  applyField(db, eventId, 'rewards', { status: 'ok', value: [{ itemId: 'item-1', name: 'Belohnung 1', section: 'Belohnungen' }] }, url);
}

class FakeInteraction {
  readonly user = { id: 'user-1' };
  readonly guildId = 'guild-1';
  readonly replies: Array<{ content: string; flags: number }> = [];
  customId = `ffe:cl:${hash}`;
  inGuild() { return true; }
  async reply(options: { content: string; flags: number }) { this.replies.push(options); }
}

test('only the checklist open button is a valid custom id', () => {
  assert.deepEqual(parseChecklistCustomId(`ffe:cl:${hash}`), { action: 'open', eventHash: hash });
  assert.equal(parseChecklistCustomId(`ffe:select:${hash}:abc:1`), undefined);
  assert.equal(parseChecklistCustomId('ffe:cl:xyz'), undefined);
});

test('the button replies ephemerally with a personal link, reuses the token and links the guild', async () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const first = new FakeInteraction();
    await handleChecklistInteraction(first as never, db, web);
    const content = first.replies[0]!.content;
    assert.ok(first.replies[0]!.flags & MessageFlags.Ephemeral);
    const match = new RegExp(`^Deine Checkliste für „Mog Mog-Kollektion 2026“: https://ffe\\.example\\.de/c/([\\w-]{43})/e/${hash} — nur für dich, bitte nicht teilen\\.$`).exec(content);
    assert.ok(match, content);
    assert.equal(findUserByToken(db, codec, match[1]!), 'user-1');
    assert.deepEqual(db.prepare('SELECT user_id AS u, guild_id AS g FROM web_user_guilds').all().map((row) => ({ ...row })), [{ u: 'user-1', g: 'guild-1' }]);

    const second = new FakeInteraction();
    await handleChecklistInteraction(second as never, db, web);
    assert.equal(second.replies[0]!.content, content, 'the same token is shown again');
  } finally {
    db.close();
  }
});

test('an unknown event gets a plain ephemeral error and no token', async () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const interaction = new FakeInteraction();
    interaction.customId = `ffe:cl:${'0'.repeat(32)}`;
    await handleChecklistInteraction(interaction as never, db, web);
    assert.match(interaction.replies[0]!.content, /nicht mehr verfügbar/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM web_users').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

test('/ffevents neuer-link rotates the token and the old link stops working', async () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const button = new FakeInteraction();
    await handleChecklistInteraction(button as never, db, web);
    const oldToken = /\/c\/([\w-]{43})\//.exec(button.replies[0]!.content)![1]!;

    const command = new FakeInteraction();
    await handleNewLinkCommand(command as never, db, web);
    assert.ok(command.replies[0]!.flags & MessageFlags.Ephemeral);
    const newToken = /https:\/\/ffe\.example\.de\/c\/([\w-]{43}) /.exec(command.replies[0]!.content)![1]!;
    assert.notEqual(newToken, oldToken);
    assert.equal(findUserByToken(db, codec, oldToken), undefined);
    assert.equal(findUserByToken(db, codec, newToken), 'user-1');
  } finally {
    db.close();
  }
});

test('the slash command offers neuer-link without options', () => {
  const sub = createFfEventsCommand().toJSON().options!.find((option) => option.name === 'neuer-link') as { options?: unknown[] };
  assert.ok(sub);
  assert.deepEqual(sub.options, []);
});
