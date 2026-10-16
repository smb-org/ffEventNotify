import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
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
