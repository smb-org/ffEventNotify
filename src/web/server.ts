// Small node:http server for the checklist page and its JSON API. Same process as the bot.

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getAllEvents, type Store } from '../store.ts';
import { log } from '../log.ts';
import {
  WebInputError, createChar, deleteChar, findUserByToken, getDoneKeys, listChars, renameChar, reorderChars, setCharRemind, setItemDone,
} from './data.ts';
import { eventHash, hasChecklist, renderNotFound, renderPage } from './render.ts';
import { TOKEN_PATTERN, type TokenCodec } from './token.ts';

export interface WebServerOptions {
  store: Store;
  codec: TokenCodec;
  /** Public base URL; POST requests must come from this origin. */
  baseUrl: string;
  /** Read the client address from X-Real-IP / X-Forwarded-For (only behind the Caddy proxy). */
  trustProxy?: boolean;
  now?: () => Date;
  ipLimitPerMinute?: number;
  tokenLimitPerMinute?: number;
}

const SECURITY_HEADERS: Record<string, string> = {
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https://lds-img.finalfantasyxiv.com https://img.finalfantasyxiv.com; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

const staticDir = new URL('./static/', import.meta.url);
const STATIC: Record<string, { body: Buffer; type: string }> = {
  '/static/app.css': { body: readFileSync(new URL('app.css', staticDir)), type: 'text/css; charset=utf-8' },
  '/static/app.js': { body: readFileSync(new URL('app.js', staticDir)), type: 'text/javascript; charset=utf-8' },
};

/** Fixed-window counter per key; old windows are dropped lazily. */
class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  allow(key: string, nowMs: number): boolean {
    if (this.hits.size > 10_000) {
      for (const [entry, value] of this.hits) if (nowMs - value.windowStart >= 60_000) this.hits.delete(entry);
    }
    const current = this.hits.get(key);
    if (!current || nowMs - current.windowStart >= 60_000) {
      this.hits.set(key, { windowStart: nowMs, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}

function send(response: ServerResponse, status: number, body: string | Buffer, type: string): void {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  response.end(body);
}

const sendJson = (response: ServerResponse, status: number, value: unknown) =>
  send(response, status, JSON.stringify(value), 'application/json; charset=utf-8');

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) throw new WebInputError('Ungültige Anfrage.', 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 4_096) throw new WebInputError('Anfrage zu groß.', 413);
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // falls through to the shared error
  }
  throw new WebInputError('Ungültige Anfrage.');
}

export function createWebServer(options: WebServerOptions): Server {
  const { store, codec } = options;
  const now = options.now ?? (() => new Date());
  const origin = new URL(options.baseUrl).origin;
  const ipLimiter = new RateLimiter(options.ipLimitPerMinute ?? 120);
  const tokenLimiter = new RateLimiter(options.tokenLimitPerMinute ?? 240);

  const clientIp = (request: IncomingMessage): string => {
    if (options.trustProxy) {
      // Caddy sets X-Real-IP from Cloudflare's CF-Connecting-IP.
      const real = [request.headers['x-real-ip']].flat()[0]?.trim();
      const first = [request.headers['x-forwarded-for']].flat().join(',').split(',')[0]?.trim();
      if (real || first) return (real || first) as string;
    }
    return request.socket.remoteAddress || 'unknown';
  };

  const sameOrigin = (request: IncomingMessage): boolean => {
    if (request.headers['x-ffe'] !== '1') return false;
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return false;
    const requestOrigin = request.headers.origin;
    return requestOrigin === undefined || requestOrigin === origin;
  };

  // The page sends the 32-character event hash; the full key is accepted too.
  function resolveEvent(value: unknown) {
    if (typeof value !== 'string') return undefined;
    return getAllEvents(store).find((event) => hasChecklist(event) && (event.eventKey === value || eventHash(event.eventKey) === value));
  }

  async function api(request: IncomingMessage, response: ServerResponse, userId: string, action: string): Promise<void> {
    if (!sameOrigin(request)) return sendJson(response, 403, { error: 'Anfrage abgelehnt.' });
    const body = await readJson(request);
    switch (action) {
      case 'toggle': {
        const event = resolveEvent(body.eventKey);
        const reward = event?.rewards.find((entry) => entry.itemId === body.itemId);
        if (!event || !reward) throw new WebInputError('Belohnung nicht gefunden.', 404);
        setItemDone(store, userId, { charId: body.charId, eventKey: event.eventKey, itemId: reward.itemId, done: body.done }, now());
        break;
      }
      case 'chars': createChar(store, userId, body.name); break;
      case 'chars/rename': renameChar(store, userId, body.charId, body.name); break;
      case 'chars/delete': deleteChar(store, userId, body.charId); break;
      case 'chars/reorder': reorderChars(store, userId, body.ids); break;
      case 'remind': setCharRemind(store, userId, body.charId, body.remind); break;
      default: return sendJson(response, 404, { error: 'Unbekannt.' });
    }
    sendJson(response, 200, { ok: true });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const nowMs = now().getTime();
    if (!ipLimiter.allow(clientIp(request), nowMs)) {
      response.setHeader('Retry-After', '60');
      return send(response, 429, 'Zu viele Anfragen.', 'text/plain; charset=utf-8');
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? 'GET';
    const asset = STATIC[url.pathname];
    if (asset && method === 'GET') return send(response, 200, asset.body, asset.type);

    const match = /^\/c\/([^/]+)(?:\/(?:e\/([a-f0-9]{32})|(archiv)|api\/(.+)))?$/.exec(url.pathname);
    if (!match) return send(response, 404, renderNotFound(), 'text/html; charset=utf-8');
    const [, token = '', focusHash, archiveTab, apiAction] = match;
    if (!tokenLimiter.allow(token.slice(0, 64), nowMs)) {
      response.setHeader('Retry-After', '60');
      return send(response, 429, 'Zu viele Anfragen.', 'text/plain; charset=utf-8');
    }
    const userId = TOKEN_PATTERN.test(token) ? findUserByToken(store, codec, token) : undefined;
    if (!userId) return send(response, 404, renderNotFound(), 'text/html; charset=utf-8');

    if (apiAction !== undefined) {
      if (method !== 'POST') return sendJson(response, 405, { error: 'Nicht erlaubt.' });
      return api(request, response, userId, apiAction);
    }
    if (method !== 'GET') return send(response, 405, 'Nicht erlaubt.', 'text/plain; charset=utf-8');
    send(response, 200, renderPage({
      store, events: getAllEvents(store), chars: listChars(store, userId), done: getDoneKeys(store, userId), focusHash, archiveTab: archiveTab !== undefined, now: now(),
    }), 'text/html; charset=utf-8');
  }

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) return response.end();
      if (error instanceof WebInputError) return sendJson(response, error.status, { error: error.message });
      log.error('Web-Anfrage fehlgeschlagen.', error);
      sendJson(response, 500, { error: 'Das hat nicht geklappt. Bitte versuche es erneut.' });
    });
  });
}
