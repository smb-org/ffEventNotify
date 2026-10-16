import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTrackedFetch, FetchMetrics } from '../src/dry-run.ts';

test('tracked fetch counts 304 responses and saves one sanitized XML file per URL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-dump-'));
  const metrics = new FetchMetrics(directory);
  const url = 'https://de.finalfantasyxiv.com/lodestone/news/news.xml?format=full';
  let attempt = 0;
  const trackedFetch = createTrackedFetch(metrics, async () => {
    attempt += 1;
    return attempt === 1
      ? new Response('<?xml version="1.0"?><feed></feed>', { status: 200 })
      : new Response(null, { status: 304 });
  });

  try {
    const first = await trackedFetch(url);
    assert.match(await first.text(), /<feed>/);
    await trackedFetch(url);

    const files = readdirSync(directory);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /\.xml$/);
    assert.equal(files[0]!.includes('/'), false);
    assert.match(readFileSync(join(directory, files[0]!), 'utf8'), /<feed>/);
    const statistics = metrics.snapshot();
    assert.equal(statistics.requests, 2);
    assert.equal(statistics.notModified, 1);
    assert.equal(statistics.failures, 0);
    assert.ok(statistics.durationMs >= 0);
    assert.ok(statistics.requestTimeMs >= 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
