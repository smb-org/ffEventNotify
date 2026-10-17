import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyField, cacheItem, createEvent, openDb, setGuildDiscordIds, setGuildName, upsertGuildSetup, type Store } from '../src/store.ts';
import {
  MAX_CHARS, WebInputError, createChar, deleteChar, findUserByToken, getDoneKeys, getOrCreateToken, getReminderRecipients,
  listChars, recordUserGuild, renameChar, reorderChars, rotateToken, setCharRemind, setItemDone,
} from '../src/web/data.ts';
import { eventHash } from '../src/web/render.ts';
import { createWebServer } from '../src/web/server.ts';
import { createTokenCodec } from '../src/web/token.ts';

const codec = createTokenCodec(Buffer.alloc(32, 9).toString('base64'));
const NOW = new Date('2026-10-17T12:00:00.000Z');
const BASE = 'https://ffe.example.de';

function seedEvent(db: Store, key: string, title: string, endUtc: string, itemCount = 3, startUtc = '2026-10-01T08:00:00.000Z') {
  const eventKey = `seasonal-special:/lodestone/special/${key}/`;
  const id = createEvent(db, { eventKey, eventType: 'seasonal-special', title });
  const url = `https://de.finalfantasyxiv.com/lodestone/special/${key}/`;
  db.prepare('INSERT INTO event_sources (url, event_id, kind) VALUES (?, ?, ?)').run(url, id, 'special');
  const rewards = Array.from({ length: itemCount }, (_, index) => ({ itemId: `${key}-${index + 1}`, name: `Belohnung ${index + 1}`, section: index === 0 ? 'Ausrüstung' : 'Möbel' }));
  applyField(db, id, 'start', { status: 'ok', value: startUtc }, url);
  applyField(db, id, 'end', { status: 'ok', value: endUtc }, url);
  applyField(db, id, 'rewards', { status: 'ok', value: rewards }, url);
  return { eventKey, rewards };
}

function fresh() {
  const db = openDb(':memory:');
  upsertGuildSetup(db, { guildId: 'guild-1', eventChannelId: 'events', logChannelId: 'logs' });
  return db;
}

test('tokens are stored encrypted, found by HMAC and rotate', () => {
  const db = fresh();
  try {
    const token = getOrCreateToken(db, codec, 'user-1');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(getOrCreateToken(db, codec, 'user-1'), token, 'shown again');
    const row = db.prepare('SELECT token_enc AS enc, token_hmac AS mac FROM web_users').get() as { enc: string; mac: string };
    assert.ok(!row.enc.includes(token) && !row.mac.includes(token));
    assert.equal(findUserByToken(db, codec, token), 'user-1');

    const next = rotateToken(db, codec, 'user-1');
    assert.notEqual(next, token);
    assert.equal(findUserByToken(db, codec, token), undefined);
    assert.equal(findUserByToken(db, codec, next), 'user-1');
    assert.throws(() => createTokenCodec(Buffer.alloc(8).toString('base64')), /32 bytes/);
    const other = createTokenCodec(Buffer.alloc(32, 1).toString('base64'));
    assert.throws(() => other.decrypt(codec.encrypt(token)));
    const old = 'A'.repeat(22);
    db.prepare('UPDATE web_users SET token_enc = ?, token_hmac = ? WHERE user_id = ?').run(codec.encrypt(old), codec.hmac(old), 'user-1');
    assert.equal(findUserByToken(db, codec, old), 'user-1', 'old 22-char token still resolves');
  } finally {
    db.close();
  }
});

test('character validation: length, duplicates, maximum, ownership', () => {
  const db = fresh();
  try {
    const first = createChar(db, 'user-1', '  Mira  ');
    assert.equal(first.name, 'Mira');
    assert.equal(first.remind, true, 'the first char reminds by default');
    assert.equal(createChar(db, 'user-1', 'Kael').remind, false);
    for (const bad of ['', '   ', 'x'.repeat(33), 42, null, 'a\u0000b']) {
      assert.throws(() => createChar(db, 'user-1', bad), WebInputError);
    }
    assert.throws(() => createChar(db, 'user-1', 'mira'), /schon/);
    assert.throws(() => createChar(db, 'user-1', 'MIRA'), /schon/);
    assert.equal(createChar(db, 'user-2', 'Mira').name, 'Mira', 'names are unique per user only');
    for (let index = listChars(db, 'user-1').length; index < MAX_CHARS; index += 1) createChar(db, 'user-1', `Char ${index}`);
    assert.throws(() => createChar(db, 'user-1', 'Zu viel'), /12/);

    renameChar(db, 'user-1', first.id, 'Mira II');
    assert.equal(listChars(db, 'user-1')[0]!.name, 'Mira II');
    assert.throws(() => renameChar(db, 'user-1', first.id, 'kael'), /schon/);
    renameChar(db, 'user-1', first.id, 'MIRA II');
    assert.throws(() => renameChar(db, 'user-2', first.id, 'Fremd'), /nicht gefunden/);
    assert.throws(() => deleteChar(db, 'user-2', first.id), /nicht gefunden/);
    const ids = listChars(db, 'user-1').map((entry) => entry.id).reverse();
    reorderChars(db, 'user-1', ids);
    assert.deepEqual(listChars(db, 'user-1').map((entry) => entry.id), ids);
    assert.throws(() => reorderChars(db, 'user-1', ids.slice(1)), WebInputError);
    deleteChar(db, 'user-1', first.id);
    assert.equal(listChars(db, 'user-1').length, MAX_CHARS - 1);
  } finally {
    db.close();
  }
});

test('toggling persists per character and dies with the character', () => {
  const db = fresh();
  try {
    const { eventKey } = seedEvent(db, 'a', 'Event A', '2026-10-20T14:59:00.000Z');
    const mira = createChar(db, 'user-1', 'Mira');
    const kael = createChar(db, 'user-1', 'Kael');
    const other = createChar(db, 'user-2', 'Mira');
    setItemDone(db, 'user-1', { charId: mira.id, eventKey, itemId: 'a-1', done: true }, NOW);
    setItemDone(db, 'user-1', { charId: mira.id, eventKey, itemId: 'a-1', done: true }, NOW);
    setItemDone(db, 'user-1', { charId: kael.id, eventKey, itemId: 'a-2', done: true }, NOW);
    assert.deepEqual([...getDoneKeys(db, 'user-1')].sort(), [`${mira.id}|${eventKey}|a-1`, `${kael.id}|${eventKey}|a-2`].sort());
    assert.equal(getDoneKeys(db, 'user-2').size, 0);
    assert.throws(() => setItemDone(db, 'user-1', { charId: other.id, eventKey, itemId: 'a-1', done: true }), /nicht gefunden/);
    assert.throws(() => setItemDone(db, 'user-1', { charId: mira.id, eventKey, itemId: 'a-1', done: 'ja' }), WebInputError);
    setItemDone(db, 'user-1', { charId: mira.id, eventKey, itemId: 'a-1', done: false });
    assert.equal(getDoneKeys(db, 'user-1').size, 1);
    deleteChar(db, 'user-1', kael.id);
    assert.equal(getDoneKeys(db, 'user-1').size, 0);
  } finally {
    db.close();
  }
});

test('migration turns old per-guild checklist rows into a Hauptchar', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffe-web-migration-'));
  const path = join(directory, 'v8.sqlite');
  try {
    let db = openDb(path);
    upsertGuildSetup(db, { guildId: 'guild-1', eventChannelId: 'e', logChannelId: 'l' });
    upsertGuildSetup(db, { guildId: 'guild-2', eventChannelId: 'e', logChannelId: 'l' });
    const { eventKey } = seedEvent(db, 'm', 'Event M', '2026-10-20T14:59:00.000Z');
    const insert = db.prepare('INSERT INTO checklist_items (guild_id, user_id, event_key, item_id, done) VALUES (?, ?, ?, ?, ?)');
    insert.run('guild-1', 'user-1', eventKey, 'm-1', 1);
    insert.run('guild-1', 'user-1', eventKey, 'm-2', 0);
    insert.run('guild-2', 'user-1', eventKey, 'm-2', 1);
    insert.run('guild-1', 'user-2', eventKey, 'm-1', 0);
    db.prepare('INSERT INTO checklist_reminder_preferences (guild_id, user_id, event_key, enabled) VALUES (?, ?, ?, ?)').run('guild-1', 'user-2', eventKey, 0);
    db.exec('DELETE FROM web_checklist; DELETE FROM web_chars; DELETE FROM web_user_guilds; UPDATE schema_version SET version = 8');
    db.close();

    db = openDb(path);
    assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 9);
    const one = listChars(db, 'user-1');
    assert.deepEqual(one.map(({ name, remind }) => [name, remind]), [['Hauptchar', true]]);
    assert.deepEqual([...getDoneKeys(db, 'user-1')].sort(), [`${one[0]!.id}|${eventKey}|m-1`, `${one[0]!.id}|${eventKey}|m-2`]);
    assert.deepEqual(listChars(db, 'user-2').map(({ name, remind }) => [name, remind]), [['Hauptchar', false]]);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM web_user_guilds').get() as { n: number }).n, 3);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM checklist_items').get() as { n: number }).n, 4, 'old rows are kept');
    db.close();
    db = openDb(path);
    assert.equal(listChars(db, 'user-1').length, 1, 'the migration runs once');
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reminder recipients count open items per reminding character in linked guilds only', () => {
  const db = fresh();
  try {
    upsertGuildSetup(db, { guildId: 'guild-2', eventChannelId: 'e', logChannelId: 'l' });
    const { eventKey, rewards } = seedEvent(db, 'r', 'Event R', '2026-10-20T14:59:00.000Z', 4);
    const event = { eventKey, rewards };
    recordUserGuild(db, 'user-1', 'guild-1');
    const mira = createChar(db, 'user-1', 'Mira');
    const kael = createChar(db, 'user-1', 'Kael');
    const quiet = createChar(db, 'user-1', 'Still');
    setCharRemind(db, 'user-1', kael.id, true);
    for (const itemId of ['r-1', 'r-2', 'r-3']) setItemDone(db, 'user-1', { charId: mira.id, eventKey, itemId, done: true });
    setItemDone(db, 'user-1', { charId: quiet.id, eventKey, itemId: 'r-1', done: true });
    assert.deepEqual(getReminderRecipients(db, 'guild-1', event), [
      { userId: 'user-1', chars: [{ name: 'Mira', open: 1 }, { name: 'Kael', open: 4 }] },
    ]);
    assert.deepEqual(getReminderRecipients(db, 'guild-2', event), [], 'not linked to guild-2');
    setItemDone(db, 'user-1', { charId: mira.id, eventKey, itemId: 'r-4', done: true });
    assert.deepEqual(getReminderRecipients(db, 'guild-1', event).map((entry) => entry.chars), [[{ name: 'Kael', open: 4 }]]);
    setCharRemind(db, 'user-1', kael.id, false);
    assert.deepEqual(getReminderRecipients(db, 'guild-1', event), []);
  } finally {
    db.close();
  }
});

async function withServer(
  run: (ctx: { db: Store; url: string; token: string; get: (path: string) => Promise<Response>; post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response> }) => Promise<void>,
  limits: { ip?: number; token?: number; trustProxy?: boolean } = {},
) {
  const db = fresh();
  const server = createWebServer({
    store: db, codec, baseUrl: BASE, now: () => NOW, ...(limits.trustProxy ? { trustProxy: true } : {}),
    ...(limits.ip ? { ipLimitPerMinute: limits.ip } : {}), ...(limits.token ? { tokenLimitPerMinute: limits.token } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = getOrCreateToken(db, codec, 'user-1');
  const get = (path: string) => fetch(url + path);
  const post = (path: string, body: unknown, headers: Record<string, string> = { 'X-FFE': '1' }) =>
    fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    await run({ db, url, token, get, post });
  } finally {
    server.close();
    server.closeAllConnections();
    db.close();
  }
}

test('the overview lists running and announced events by end date, archive last, and escapes input', async () => {
  await withServer(async ({ db, token, get }) => {
    seedEvent(db, 'late', 'Später Event', '2026-11-20T14:59:00.000Z');
    seedEvent(db, 'soon', 'Bald Event', '2026-10-20T14:59:00.000Z');
    seedEvent(db, 'next', 'Kommt Event', '2026-12-01T14:59:00.000Z', 3, '2026-10-25T08:00:00.000Z');
    seedEvent(db, 'old', 'Altes Event', '2026-10-10T14:59:00.000Z');
    seedEvent(db, 'ancient', 'Uraltes Event', '2026-06-10T14:59:00.000Z');
    seedEvent(db, 'xss', '<script>alert(1)</script>', '2026-10-30T14:59:00.000Z');
    cacheItem(db, { itemId: 'soon-1', name: 'x', iconUrl: 'https://lds-img.finalfantasyxiv.com/itemicon/aa/aa.png' });
    cacheItem(db, { itemId: 'soon-2', name: 'x', iconUrl: 'https://evil.example/itemicon.png' });
    createChar(db, 'user-1', '<img src=x onerror=alert(1)>');

    const response = await get(`/c/${token}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(!html.includes('<script>alert'), 'event title escaped');
    assert.ok(!html.includes('<img src=x'), 'char name escaped');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    const order = ['Bald Event', 'Später Event', 'Kommt Event'].map((title) => html.indexOf(title));
    assert.ok(order.every((index) => index > 0) && order[0]! < order[1]! && order[1]! < order[2]!);
    assert.ok(html.indexOf('Altes Event') > html.indexOf('class="archive"'));
    assert.ok(!html.includes('Uraltes Event'), 'older than 60 days');
    assert.ok(html.includes('https://lds-img.finalfantasyxiv.com/itemicon/aa/aa.png'));
    assert.ok(!html.includes('evil.example'), 'only allowed image hosts');
    assert.ok(html.includes('rel="noopener noreferrer"'));
    assert.match(html, /4\/12|1 von 12/);
    assert.ok(html.indexOf('<details class="chars"') > html.lastIndexOf('role="tabpanel"'), 'char management after the panels');
    assert.ok(html.includes('class="chars-link"') && html.indexOf('chars-link') < html.indexOf('role="tablist"'));
    assert.ok(!/<details class="chars"[^>]* open/.test(html), 'collapsed with chars');
    const css = await (await get('/static/app.css')).text();
    assert.ok(!/\.tablewrap\s*\{[^}]*max-height/.test(css), 'no inner vertical scroll');

  });
});

test('tabs: one per running event plus Archiv, selection by URL, escaped labels', async () => {
  await withServer(async ({ db, token, get }) => {
    seedEvent(db, 'soon', 'Bald Event', '2026-10-20T14:59:00.000Z');
    seedEvent(db, 'next', 'Kommt Event', '2026-12-01T14:59:00.000Z', 3, '2026-10-25T08:00:00.000Z');
    seedEvent(db, 'xss', '<script>alert(1)</script> und ein sehr sehr langer Titel', '2026-10-30T14:59:00.000Z');
    seedEvent(db, 'old', 'Altes Event', '2026-10-10T14:59:00.000Z');
    createChar(db, 'user-1', 'Hauptchar');
    const selectedTab = (html: string) => /role="tab"[^>]*id="t-([a-f0-9]{32}|archiv)"[^>]*aria-selected="true"/.exec(html)?.[1];
    const hidden = (html: string, id: string) => new RegExp(`id="p-${id}"[^>]*hidden`).test(html);
    const hash = (key: string) => eventHash(`seasonal-special:/lodestone/special/${key}/`);

    const html = await (await get(`/c/${token}`)).text();
    assert.equal((html.match(/role="tab"/g) ?? []).length, 4, '3 events + Archiv');
    assert.ok(html.includes('role="tablist"') && html.includes('role="tabpanel"'));
    assert.equal(selectedTab(html), hash('soon'), 'first tab by end date');
    assert.ok(!hidden(html, hash('soon')) && hidden(html, hash('next')) && hidden(html, 'archiv'));
    assert.ok(html.includes('noch 3 Tage') && html.includes('ab 25.10.') && html.includes('noch 13 Tage'));
    assert.ok(html.includes('3 offen'), 'open hint for reminding chars');
    assert.ok(!html.includes('<script>alert') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('sehr sehr langer Titel'), 'full title in the title attribute');
    assert.match(html, /<span class="tab-title">&lt;script&gt;[^<]*…<\/span>/);

    const next = await (await get(`/c/${token}/e/${hash('next')}`)).text();
    assert.equal(selectedTab(next), hash('next'));
    assert.ok(!hidden(next, hash('next')) && hidden(next, hash('soon')));

    const archive = await get(`/c/${token}/archiv`);
    assert.equal(archive.status, 200);
    const archiveHtml = await archive.text();
    assert.equal(selectedTab(archiveHtml), 'archiv');
    assert.ok(!hidden(archiveHtml, 'archiv') && hidden(archiveHtml, hash('soon')) && archiveHtml.includes('Altes Event'));

    const archived = await (await get(`/c/${token}/e/${hash('old')}`)).text();
    assert.equal(selectedTab(archived), 'archiv');
    assert.match(archived, /<details class="event" id="e-[a-f0-9]{32}" data-event="[a-f0-9]{32}" open>/);

    const unknown = await get(`/c/${token}/e/${'0'.repeat(32)}`);
    assert.equal(unknown.status, 200);
    assert.equal(selectedTab(await unknown.text()), hash('soon'));
  });
});

test('every response carries the security headers; unknown tokens give an empty 404', async () => {
  await withServer(async ({ token, get }) => {
    const expected = {
      'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    };
    for (const path of [`/c/${token}`, '/c/' + 'A'.repeat(22), '/static/app.css', '/static/app.js', '/nope']) {
      const response = await get(path);
      for (const [name, value] of Object.entries(expected)) assert.equal(response.headers.get(name), value, `${name} on ${path}`);
      const csp = response.headers.get('content-security-policy')!;
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /img-src 'self' https:\/\/lds-img\.finalfantasyxiv\.com https:\/\/img\.finalfantasyxiv\.com/);
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
    }
    const missing = await get('/c/' + 'A'.repeat(22));
    assert.equal(missing.status, 404);
    const body = await missing.text();
    assert.match(body, /Link ungültig oder erneuert/);
    assert.ok(!body.includes('AAAAAAAAAA'));
    assert.equal((await get('/c/zu-kurz')).status, 404);
  });
});

test('the API toggles, manages chars and rejects missing header or foreign origin', async () => {
  await withServer(async ({ db, token, post }) => {
    const { eventKey } = seedEvent(db, 'api', 'API Event', '2026-10-30T14:59:00.000Z');
    const hash = eventHash(eventKey);
    assert.equal((await post(`/c/${token}/api/chars`, { name: 'Mira' })).status, 200);
    const charId = listChars(db, 'user-1')[0]!.id;
    const toggle = { charId, eventKey: hash, itemId: 'api-1', done: true };

    assert.equal((await post(`/c/${token}/api/toggle`, toggle, {})).status, 403, 'no X-FFE header');
    assert.equal((await post(`/c/${token}/api/toggle`, toggle, { 'X-FFE': '1', Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(`/c/${token}/api/toggle`, toggle, { 'X-FFE': '1', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal(getDoneKeys(db, 'user-1').size, 0);

    assert.equal((await post(`/c/${token}/api/toggle`, toggle, { 'X-FFE': '1', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    assert.equal(getDoneKeys(db, 'user-1').size, 1);
    assert.equal((await post(`/c/${token}/api/toggle`, { ...toggle, itemId: 'nope' })).status, 404);
    assert.equal((await post(`/c/${token}/api/toggle`, { ...toggle, charId: 99999 })).status, 404);
    assert.equal((await post(`/c/${token}/api/toggle`, { ...toggle, done: 'x' })).status, 400);
    assert.equal((await post(`/c/${token}/api/chars`, { name: 'mira' })).status, 400);
    assert.equal((await post(`/c/${token}/api/remind`, { charId, remind: false })).status, 200);
    assert.equal(listChars(db, 'user-1')[0]!.remind, false);
    assert.equal((await post(`/c/${token}/api/chars/rename`, { charId, name: 'Mira Zwei' })).status, 200);
    assert.equal((await post(`/c/${token}/api/chars/delete`, { charId })).status, 200);
    assert.equal(listChars(db, 'user-1').length, 0);
    assert.equal((await post(`/c/${'A'.repeat(22)}/api/chars`, { name: 'X' })).status, 404);
  });
});

test('requests beyond the per-IP and per-token limits get 429', async () => {
  await withServer(async ({ get, token }) => {
    assert.equal((await get('/nope')).status, 404);
    assert.equal((await get('/nope')).status, 404);
    assert.equal((await get('/nope')).status, 429);
    assert.equal((await get(`/c/${token}`)).status, 429, 'the IP is over its limit');
  }, { ip: 2 });
  await withServer(async ({ get, token }) => {
    assert.equal((await get(`/c/${token}`)).status, 200);
    assert.equal((await get(`/c/${token}`)).status, 200);
    assert.equal((await get(`/c/${token}`)).status, 429);
    assert.equal((await get('/c/' + 'B'.repeat(22))).status, 404, 'other tokens are unaffected');
  }, { token: 2 });
});

test('behind the proxy the rate limit keys on X-Real-IP, then the first X-Forwarded-For entry', async () => {
  await withServer(async ({ url }) => {
    const hit = (headers: Record<string, string>) => fetch(url + '/nope', { headers }).then((r) => r.status);
    assert.equal(await hit({ 'X-Real-IP': '1.1.1.1' }), 404);
    assert.equal(await hit({ 'X-Real-IP': '1.1.1.1', 'X-Forwarded-For': '9.9.9.9' }), 429, 'X-Real-IP wins');
    assert.equal(await hit({ 'X-Real-IP': '2.2.2.2' }), 404, 'another client is unaffected');
    assert.equal(await hit({ 'X-Forwarded-For': '3.3.3.3, 10.0.0.1' }), 404);
    assert.equal(await hit({ 'X-Forwarded-For': '3.3.3.3, 10.0.0.2' }), 429, 'first entry is the key');
  }, { ip: 1, trustProxy: true });
  await withServer(async ({ url }) => {
    const hit = (ip: string) => fetch(url + '/nope', { headers: { 'X-Real-IP': ip } }).then((r) => r.status);
    assert.equal(await hit('1.1.1.1'), 404);
    assert.equal(await hit('2.2.2.2'), 429, 'headers are ignored without trustProxy');
  }, { ip: 1 });
});

test('event header links to Lodestone and to the forum post of each of the user\'s guilds', async () => {
  await withServer(async ({ db, token, get }) => {
    const { eventKey } = seedEvent(db, 'link', 'Link Event', '2026-10-30T14:59:00.000Z');
    const eventId = (db.prepare('SELECT id FROM events WHERE event_key = ?').get(eventKey) as { id: number }).id;
    db.prepare('INSERT INTO event_sources (url, event_id, kind) VALUES (?, ?, ?)').run('https://de.finalfantasyxiv.com/lodestone/topics/detail/abc', eventId, 'topic');
    db.prepare('INSERT INTO event_sources (url, event_id, kind) VALUES (?, ?, ?)').run('https://evil.example/x', eventId, 'followup');
    const lodestone = 'https://de.finalfantasyxiv.com/lodestone/special/link/';

    let html = await (await get(`/c/${token}`)).text();
    assert.ok(html.includes(`<a href="${lodestone}" target="_blank" rel="noopener noreferrer">Link Event</a>`), 'title links to the special page');
    assert.ok(html.includes(`href="${lodestone}" target="_blank" rel="noopener noreferrer">Lodestone ↗</a>`));
    assert.ok(!html.includes('evil.example'));
    assert.ok(!html.includes('discord.com'), 'no guild, no Discord link');

    recordUserGuild(db, 'user-1', 'guild-1');
    assert.ok(!(await (await get(`/c/${token}`)).text()).includes('discord.com'), 'guild without post');

    setGuildDiscordIds(db, 'guild-1', eventKey, { messageId: '555', messageChannelId: 'events' });
    html = await (await get(`/c/${token}`)).text();
    assert.ok(html.includes('href="https://discord.com/channels/guild-1/555"') === false, 'non-numeric ids are rejected');

    upsertGuildSetup(db, { guildId: '111', eventChannelId: 'ev1', logChannelId: 'lg1' });
    setGuildDiscordIds(db, '111', eventKey, { messageId: '555', messageChannelId: 'ev1' });
    recordUserGuild(db, 'user-1', '111');
    html = await (await get(`/c/${token}`)).text();
    assert.ok(html.includes('href="https://discord.com/channels/111/555" target="_blank" rel="noopener noreferrer">Discord-Beitrag ↗</a>'));

    upsertGuildSetup(db, { guildId: '222', eventChannelId: 'ev2', logChannelId: 'lg2' });
    setGuildName(db, '222', 'Zwei <b>"&"</b>');
    setGuildName(db, '111', 'Eins');
    setGuildDiscordIds(db, '222', eventKey, { messageId: '777', messageChannelId: 'ev2' });
    recordUserGuild(db, 'user-1', '222');
    html = await (await get(`/c/${token}`)).text();
    assert.ok(html.includes('channels/111/555" target="_blank" rel="noopener noreferrer">Discord: Eins ↗</a>'));
    assert.ok(html.includes('channels/222/777" target="_blank" rel="noopener noreferrer">Discord: Zwei &lt;b&gt;&quot;&amp;&quot;&lt;/b&gt; ↗</a>'));
    assert.ok(!html.includes('<b>"&"</b>'));

    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare("UPDATE event_sources SET url = 'https://de.finalfantasyxiv.com.evil.example/x' WHERE kind = 'special'").run();
    db.prepare("UPDATE event_sources SET url = 'http://de.finalfantasyxiv.com/lodestone/topics/detail/abc' WHERE kind = 'topic'").run();
    assert.ok(!(await (await get(`/c/${token}`)).text()).includes('Lodestone ↗'), 'only https on the Lodestone host');
  });
});
