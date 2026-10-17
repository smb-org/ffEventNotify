// Local preview of the web checklist without Discord. Only runs on a throw-away copy of a database:
//   cp data/smoke.sqlite data/web-test.sqlite && DB_PATH=./data/web-test.sqlite pnpm web:dev

import { basename } from 'node:path';
import { openDb } from '../store.ts';
import { createChar, getOrCreateToken, listChars } from './data.ts';
import { createWebServer } from './server.ts';
import { createTokenCodec } from './token.ts';

const dbPath = process.env.DB_PATH ?? '';
if (!basename(dbPath).startsWith('web-test')) {
  console.error('web:dev legt Demo-Daten an und braucht DB_PATH auf eine Kopie namens web-test*.sqlite.');
  process.exit(1);
}
const port = Number(process.env.WEB_PORT ?? 3480);
const baseUrl = `http://localhost:${port}`;
const store = openDb(dbPath);
const codec = createTokenCodec(Buffer.alloc(32, 7).toString('base64'));
const userId = 'demo-user';
if (listChars(store, userId).length === 0) {
  createChar(store, userId, 'Mira');
  createChar(store, userId, 'Kael');
}
createWebServer({ store, codec, baseUrl }).listen(port, '127.0.0.1', () => {
  console.log(`Demo-Link: ${baseUrl}/c/${getOrCreateToken(store, codec, userId)}`);
});
