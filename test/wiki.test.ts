import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compareWithKnown, parseWikiEvents, runDailyWikiCrossCheck, WIKI_EVENT_URLS } from '../src/sources/wiki.ts';
import type { KnownEventTitle, WikiEvent } from '../src/types.ts';

function fixture(path: string): string {
  return readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');
}

const now = new Date('2026-10-16T12:00:00Z');

test('wiki parsers extract the running Moogle event and mark date-free seasonal candidates unparsed', () => {
  const seasonal = parseWikiEvents(fixture('wiki/seasonal-events.html'), now);
  const moogle = parseWikiEvents(fixture('wiki/moogle-treasure-trove.html'), now);

  assert.deepEqual(seasonal, {
    ok: true,
    events: [],
    unparsed: [{
      name: "All Saints' Wake",
      unparsedReason: 'Auf der Saison-Event-Seite steht kein verlässlicher Zeitraum.',
    }],
  });
  assert.deepEqual(moogle, {
    ok: true,
    events: [{
      name: 'Moogle Treasure Trove: The First Hunt for Astronomy',
      startUtc: '2026-09-09T00:00:00.000Z',
      endUtc: '2026-10-19T23:59:59.999Z',
    }],
    unparsed: [],
  });
});

test('wiki parser reports an unexpected page structure without throwing', () => {
  assert.deepEqual(parseWikiEvents('<html><body>changed</body></html>', now), {
    ok: false,
    reason: 'Auf der Wiki-Seite wurde keine unterstützte Ereignisstruktur gefunden.',
  });
});

test('wiki comparison requires both event boundaries to agree within one day', () => {
  const wikiEvents: WikiEvent[] = [{
    name: 'Moogle Treasure Trove: The First Hunt for Astronomy',
    startUtc: '2026-09-09T00:00:00.000Z',
    endUtc: '2026-10-19T23:59:59.999Z',
  }];
  const known: KnownEventTitle[] = [{
    title: 'Mogry-Schatzkammer',
    startUtc: '2026-10-20T00:00:00.000Z',
    endUtc: '2026-10-25T00:00:00.000Z',
  }];
  assert.deepEqual(compareWithKnown(wikiEvents, known), wikiEvents);
  assert.deepEqual(compareWithKnown(wikiEvents, [{
    title: 'Mogry-Schatzkammer',
    startUtc: '2026-09-10T00:00:00.000Z',
    endUtc: '2026-10-19T23:59:59.999Z',
  }]), []);
  assert.deepEqual(compareWithKnown(wikiEvents, [{
    title: 'Andere deutsche Meldung',
    startUtc: '2026-11-01T00:00:00.000Z',
    endUtc: '2026-11-02T00:00:00.000Z',
  }]), wikiEvents);
  assert.deepEqual(compareWithKnown([{ name: "All Saints' Wake" }], known), []);
});

test('daily wiki cross-check compares dated events and returns unparsed candidates separately', async () => {
  const calls: Array<{ url: string; priority: string }> = [];
  const result = await runDailyWikiCrossCheck(async (url, options) => {
    calls.push({ url, priority: options.priority });
    const path = url.endsWith('Seasonal_Events') ? 'wiki/seasonal-events.html' : 'wiki/moogle-treasure-trove.html';
    return { status: 200, body: fixture(path), finalUrl: url };
  }, [{
    title: 'Mogry-Schatzkammer',
    startUtc: '2026-09-09T00:00:00.000Z',
    endUtc: '2026-10-19T23:59:59.999Z',
  }], now);
  assert.deepEqual(calls, WIKI_EVENT_URLS.map((url) => ({ url, priority: 'wiki' })));
  assert.deepEqual(result, {
    ok: true,
    unmatched: [],
    unparsed: [{ name: "All Saints' Wake", unparsedReason: 'Auf der Saison-Event-Seite steht kein verlässlicher Zeitraum.' }],
    missingEventTitles: [],
    checkedAtUtc: '2026-10-16T12:00:00.000Z',
  });
});
