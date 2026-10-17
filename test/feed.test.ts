import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fetchNewsFeed, LODESTONE_NEWS_FEED_URL, parseNewsFeed } from '../src/sources/feed.ts';

const xml = readFileSync(new URL('./fixtures/lists/news.xml', import.meta.url), 'utf8');
const expected = JSON.parse(readFileSync(new URL('./fixtures/expected/news-feed.json', import.meta.url), 'utf8')) as {
  count: number;
  entries: Array<{ title: string; url: string; published: string; category: string }>;
};

test('Atom feed parser returns the expected title, canonical URL, published time, and category', () => {
  let actual: ReturnType<typeof parseNewsFeed>;
  try {
    actual = parseNewsFeed(xml);
  } catch (error) {
    assert.fail(`parseNewsFeed should parse the fixture: ${String(error)}`);
  }
  assert.equal(actual.length, expected.count);
  assert.deepEqual(actual, expected.entries);
});

test('feed retrieval uses the injected fetcher and list priority', async () => {
  let requested: { url: string; priority: string } | undefined;
  const body = await fetchNewsFeed(async (url, options) => {
    requested = { url, priority: options.priority };
    return { status: 200, body: xml, finalUrl: url };
  });
  assert.equal(body, xml);
  assert.deepEqual(requested, { url: LODESTONE_NEWS_FEED_URL, priority: 'list' });
});
