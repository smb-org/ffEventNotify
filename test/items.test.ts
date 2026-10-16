import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { resolveItem } from '../src/items.ts';
import { getCachedItem, openDb } from '../src/store.ts';
import type { FetchText } from '../src/types.ts';

const readFixture = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const expectedSaints = JSON.parse(readFixture('./fixtures/expected/all-saints-wake-2026.json'));
const expectedMogmog = JSON.parse(readFixture('./fixtures/expected/mogmog-202609.json'));
const expectedRewards = [...expectedSaints.rewards, ...expectedMogmog.rewards];

function fixtureFetch(counter?: { count: number }): FetchText {
  return async (url) => {
    if (counter) counter.count += 1;
    const id = new URL(url).pathname.match(/\/item\/([^/]+)\//)?.[1];
    if (!id) return { status: 404, body: '', finalUrl: url };
    try {
      const body = gunzipSync(readFileSync(fileURLToPath(new URL(`./fixtures/items/${id}.html.gz`, import.meta.url)))).toString('utf8');
      return { status: 200, body, finalUrl: url };
    } catch {
      return { status: 404, body: '', finalUrl: url };
    }
  };
}

test('all 38 compressed item fixtures resolve the expected German names and icons', async () => {
  const ids = readdirSync(fileURLToPath(new URL('./fixtures/items/', import.meta.url))).filter((name) => name.endsWith('.html.gz'));
  assert.equal(ids.length, 38);
  assert.deepEqual(new Set(expectedRewards.map((reward: any) => `${reward.itemId}.html.gz`)), new Set(ids));

  const store = openDb(':memory:');
  try {
    for (const reward of expectedRewards) {
      const result = await resolveItem(reward.itemId, { fetchText: fixtureFetch(), store });
      assert.equal(result.status, 'ok', reward.itemId);
      if (result.status === 'ok') {
        assert.equal(result.value.name, reward.name, reward.itemId);
        assert.match(result.value.iconUrl ?? '', /\/itemicon\//, reward.itemId);
      }
    }
  } finally {
    store.close();
  }
});

test('a successful item cache hit avoids another fetch', async () => {
  const store = openDb(':memory:');
  const counter = { count: 0 };
  try {
    const first = await resolveItem('04393053cf6', { fetchText: fixtureFetch(counter), store });
    assert.equal(first.status, 'ok');
    assert.equal(counter.count, 1);

    const second = await resolveItem('04393053cf6', { fetchText: fixtureFetch(counter), store });
    assert.equal(second.status, 'ok');
    assert.equal(counter.count, 1);
  } finally {
    store.close();
  }
});

test('fetch failure and empty names are uncertain and are not cached', async () => {
  const store = openDb(':memory:');
  try {
    const failure = await resolveItem('missing', {
      fetchText: async () => { throw new Error('offline'); },
      store,
    });
    assert.equal(failure.status, 'unsicher');
    assert.equal(getCachedItem(store, 'missing'), undefined);

    const empty = await resolveItem('empty', {
      fetchText: async (url) => ({ status: 200, body: '<html><title> </title></html>', finalUrl: url }),
      store,
    });
    assert.equal(empty.status, 'unsicher');
    assert.equal(getCachedItem(store, 'empty'), undefined);
  } finally {
    store.close();
  }
});

test('an error-page title does not produce a cached item name', async () => {
  const store = openDb(':memory:');
  try {
    const result = await resolveItem('error-title', {
      fetchText: async (url) => ({
        status: 200,
        body: '<html><head><title>Internal Server Error | FINAL FANTASY XIV - Der Lodestone</title><meta property="og:image" content="/itemicon/error.png"></head></html>',
        finalUrl: url,
      }),
      store,
    });

    assert.equal(result.status, 'unsicher');
    assert.equal(getCachedItem(store, 'error-title'), undefined);
  } finally {
    store.close();
  }
});
