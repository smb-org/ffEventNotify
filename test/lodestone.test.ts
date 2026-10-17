import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDb, type Store } from '../src/store.ts';
import {
  articleBodyLinks,
  normalizeLodestoneUrl,
  parseBannerRail,
  parseMaintenanceList,
  parseTopicList,
  resolveShortLinks,
} from '../src/sources/lodestone.ts';

function fixture(path: string): string {
  return readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');
}

const bannerExpected = JSON.parse(fixture('expected/banner.json')) as {
  specials: Array<{ path: string; location: string }>;
};

test('topic list parser extracts absolute German URLs and published epochs', () => {
  const entries = parseTopicList(fixture('lists/topics-p1.html'));
  assert.equal(entries.length, 20);
  assert.deepEqual(entries[0], {
    title: 'Ankündigung des Bühnen- und Streamprogramms für das Fan Festival 2026 in Tokyo',
    url: 'https://de.finalfantasyxiv.com/lodestone/topics/detail/02288c94ccfb267ca6df2a31770cd164a4ceb2ce',
    publishedEpoch: 1792143000,
  });
});

test('maintenance parser keeps its tag, normalized title, URL, and publish epoch', () => {
  const entries = parseMaintenanceList(fixture('lists/maintenance-p1.html'));
  assert.equal(entries.length, 20);
  assert.deepEqual(entries[0], {
    title: '[Folge-News]Wartung der Mogry-Station / des Online-Shops (15. Okt.): Folgenews',
    url: 'https://de.finalfantasyxiv.com/lodestone/news/detail/3d3cdb7b8fe1d9b73cf7f35bdfd499e113ae7133',
    publishedEpoch: 1792053600,
    tag: 'Folge-News',
  });
});

test('banner parser returns only normalized special paths from the promo rail', () => {
  const actual = parseBannerRail(fixture('lists/topics-p1.html'));
  const expected = bannerExpected.specials
    .filter((special) => special.location === 'banner-rail')
    .map((special) => special.path);
  assert.deepEqual(actual, expected);
});

test('article links exclude site banners and global navigation', () => {
  const html = fixture('topics/ll93-topic-a.html');
  const links = articleBodyLinks(html);
  const banners = parseBannerRail(html);
  assert.ok(banners.length > 0);
  assert.ok(links.length > 0);
  assert.ok(links.every((href) => !href.includes('/lodestone/special/')));
});

test('Lodestone URLs normalize regional hosts and drop query and fragment', () => {
  assert.equal(
    normalizeLodestoneUrl('http://eu.finalfantasyxiv.com/lodestone/special/fallguys/?utm_source=x#top'),
    'https://de.finalfantasyxiv.com/lodestone/special/fallguys/',
  );
  assert.equal(normalizeLodestoneUrl('/lodestone/news/detail/abc?x=1'), 'https://de.finalfantasyxiv.com/lodestone/news/detail/abc');
});

test('short links resolve through the injected fetcher', async () => {
  const calls: Array<{ url: string; priority: string }> = [];
  const urls = await resolveShortLinks(['https://sqex.to/oZP2Y', '/lodestone/special/fallguys/'], async (url, options) => {
    calls.push({ url, priority: options.priority });
    return {
      status: 200,
      body: '',
      finalUrl: 'https://eu.finalfantasyxiv.com/lodestone/special/2026/All_Saints_Wake/tfrx2rkv52?utm=x',
    };
  });
  assert.deepEqual(urls, {
    links: [
      'https://de.finalfantasyxiv.com/lodestone/special/2026/All_Saints_Wake/tfrx2rkv52',
      '/lodestone/special/fallguys/',
    ],
    unresolvedUrls: [],
  });
  assert.deepEqual(calls, [{ url: 'https://sqex.to/oZP2Y', priority: 'detail' }]);
});

test('a failed or non-successful short-link resolution is reported as unresolved', async () => {
  const rejected = await resolveShortLinks(['https://sqex.to/oZP2Y'], async () => {
    throw new Error('offline');
  });
  const notFound = await resolveShortLinks(['https://sqex.to/oZP2Y'], async (url) => ({
    status: 404,
    body: 'not found',
    finalUrl: url,
  }));

  assert.deepEqual(rejected, { links: [undefined], unresolvedUrls: ['https://sqex.to/oZP2Y'] });
  assert.deepEqual(notFound, { links: [undefined], unresolvedUrls: ['https://sqex.to/oZP2Y'] });
});

test('successful short-link resolutions persist and are reused without another request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-short-links-'));
  const path = join(directory, 'links.sqlite');
  let db: Store = openDb(path);
  let calls = 0;
  const fetchText = async (url: string) => {
    calls += 1;
    return { status: 200, body: '', finalUrl: 'https://de.finalfantasyxiv.com/lodestone/special/fallguys/' };
  };
  try {
    const first = await resolveShortLinks(['http://sqex.to/oZP2Y?utm_source=test'], fetchText, db, '2026-10-16T12:00:00.000Z');
    db.close();
    db = openDb(path);
    const second = await resolveShortLinks(['https://sqex.to/oZP2Y'], fetchText, db, '2026-10-16T13:00:00.000Z');

    assert.deepEqual(first.links, ['https://de.finalfantasyxiv.com/lodestone/special/fallguys/']);
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
    assert.deepEqual({ ...db.prepare('SELECT short_url AS shortUrl, final_url AS finalUrl, resolved_at AS resolvedAt FROM short_links WHERE short_url = ?')
      .get('https://sqex.to/oZP2Y') as { shortUrl: string; finalUrl: string; resolvedAt: string } }, {
      shortUrl: 'https://sqex.to/oZP2Y',
      finalUrl: 'https://de.finalfantasyxiv.com/lodestone/special/fallguys/',
      resolvedAt: '2026-10-16T12:00:00.000Z',
    });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed short-link resolutions are not cached and can succeed on a later attempt', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  try {
    const first = await resolveShortLinks(['https://sqex.to/oZP2Y'], async (url) => {
      calls += 1;
      return { status: 503, body: '', finalUrl: url };
    }, db);
    const second = await resolveShortLinks(['https://sqex.to/oZP2Y'], async (url) => {
      calls += 1;
      return { status: 200, body: '', finalUrl: 'https://de.finalfantasyxiv.com/lodestone/special/fallguys/' };
    }, db);

    assert.deepEqual(first, { links: [undefined], unresolvedUrls: ['https://sqex.to/oZP2Y'] });
    assert.deepEqual(second.links, ['https://de.finalfantasyxiv.com/lodestone/special/fallguys/']);
    assert.equal(calls, 2);
  } finally {
    db.close();
  }
});
