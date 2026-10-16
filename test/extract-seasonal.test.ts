import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { load } from 'cheerio';
import test from 'node:test';
import { extractSeasonal, hasPeriod } from '../src/extractors/seasonal.ts';
import { openDb } from '../src/store.ts';
import type { FetchText } from '../src/types.ts';

const NOW = new Date('2026-10-16T12:00:00Z');
const fixture = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const expected = (path: string): any => JSON.parse(fixture(`./fixtures/expected/${path}`));

function itemFetcher(): FetchText {
  return async (url) => {
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

async function extract(html: string, now = NOW) {
  const store = openDb(':memory:');
  try {
    return await extractSeasonal(html, now, { fetchText: itemFetcher(), store });
  } finally {
    store.close();
  }
}

function simplePeriod(start: string, end: string): string {
  return `<main class="content"><p>Von ${start} bis ${end}</p></main>`;
}

test('All Saints uses Berlin DST labels and resolves all eight rewards from item pages', async () => {
  const html = fixture('./fixtures/special/all-saints-wake-2026.html');
  const expectedPage = expected('all-saints-wake-2026.json');
  const result = await extract(html);

  assert.deepEqual(result.period, { status: 'ok', value: expectedPage.period });
  assert.deepEqual(result.periods, {
    status: 'ok',
    value: [expectedPage.period],
  });
  assert.equal(result.rewards.status, 'ok');
  if (result.rewards.status === 'ok') {
    assert.deepEqual(result.rewards.value, expectedPage.rewards.map(({ section, itemId, name }: any) => ({ section, itemId, name })));
  }
});

test('Mog Mog inherits the end timezone label and keeps its featured and exchange sections', async () => {
  const html = fixture('./fixtures/special/mogmog-202609.html');
  const expectedPage = expected('mogmog-202609.json');
  const result = await extract(html);

  assert.deepEqual(result.period, { status: 'ok', value: expectedPage.period });
  assert.equal(result.rewards.status, 'ok');
  if (result.rewards.status === 'ok') {
    assert.deepEqual(result.rewards.value, expectedPage.rewards.map(({ section, itemId, name }: any) => ({ section, itemId, name })));
  }
  assert.equal(result.periods.status, 'ok');
  if (result.periods.status === 'ok') {
    assert.deepEqual(result.periods.value, [expectedPage.period]);
  }
});

test('Fall Guys parses every historical period and selects the period running at NOW', async () => {
  const html = fixture('./fixtures/special/fallguys.html');
  const expectedPage = expected('fallguys.json');
  const result = await extract(html);

  assert.equal(result.periods.status, 'ok');
  if (result.periods.status === 'ok') {
    assert.deepEqual(result.periods.value, expectedPage.periods.map(({ startUtc, endUtc }: any) => ({ startUtc, endUtc })));
  }
  assert.deepEqual(result.period, { status: 'ok', value: expectedPage.selected });
  assert.deepEqual(result.eventState, { status: 'ok', value: 'active' });
  assert.equal(hasPeriod(html, NOW), 'yes');
});

test('one bad historical timezone label keeps the 2026 Fall Guys page seasonal', async () => {
  const html = fixture('./fixtures/special/fallguys.html')
    .replace('27. November 2025 um 15:59 Uhr (MEZ)', '27. November 2025 um 15:59 Uhr (MESZ)');
  const result = await extract(html);

  assert.ok(result.period.status === 'unsicher' || (
    result.period.status === 'ok' && result.period.value.startUtc === '2026-10-07T08:00:00Z'
  ));
  assert.ok(hasPeriod(html, NOW) === 'yes' || hasPeriod(html, NOW) === 'unsicher');
});

test('a running period wins over an earlier-listed future period', async () => {
  const html = simplePeriod(
    'Samstag, den 17. Oktober 2026 um 10:00 Uhr (MESZ)',
    'Sonntag, den 18. Oktober 2026 um 10:00 Uhr (MESZ)',
  ) + simplePeriod(
    'Donnerstag, den 15. Oktober 2026 um 10:00 Uhr (MESZ)',
    'Samstag, den 17. Oktober 2026 um 10:00 Uhr (MESZ)',
  );
  const result = await extract(html);

  assert.deepEqual(result.period, {
    status: 'ok',
    value: { startUtc: '2026-10-15T08:00:00Z', endUtc: '2026-10-17T08:00:00Z' },
  });
});

test('periods without timezone labels still use the Europe/Berlin zone', async () => {
  const html = simplePeriod(
    'Mittwoch, den 15. Juli 2026 um 10:00 Uhr',
    'Montag, den 20. Juli 2026 um 10:00 Uhr',
  );
  const result = await extract(html, new Date('2026-07-16T08:00:00Z'));

  assert.deepEqual(result.period, {
    status: 'ok',
    value: { startUtc: '2026-07-15T08:00:00Z', endUtc: '2026-07-20T08:00:00Z' },
  });
});

test('overlapping running periods make the selected period uncertain', async () => {
  const html = simplePeriod(
    'Donnerstag, den 15. Oktober 2026 um 10:00 Uhr (MESZ)',
    'Samstag, den 17. Oktober 2026 um 10:00 Uhr (MESZ)',
  ) + simplePeriod(
    'Freitag, den 16. Oktober 2026 um 10:00 Uhr (MESZ)',
    'Sonntag, den 18. Oktober 2026 um 10:00 Uhr (MESZ)',
  );
  const result = await extract(html);

  assert.equal(result.period.status, 'unsicher');
  if (result.period.status === 'unsicher') assert.match(result.period.reason, /more than one|multiple/i);
});

test('an open end is retained as unknown and cannot be selected as a complete period', async () => {
  const html = `<main class="content"><p>Von Mittwoch, den 23. Oktober 2024 um 10:00 Uhr (MESZ) bis zu den Wartungsarbeiten von Patch 7.1.</p></main>`;
  const result = await extract(html, new Date('2024-10-24T12:00:00Z'));

  assert.equal(result.periods.status, 'ok');
  if (result.periods.status === 'ok') {
    assert.deepEqual(result.periods.value, [{ startUtc: '2024-10-23T08:00:00Z', endUtc: null }]);
  }
  assert.equal(result.period.status, 'unsicher');
  if (result.period.status === 'unsicher') assert.match(result.period.reason, /open|end/i);
});

test('a running open period before the next dated period makes the selected end uncertain', async () => {
  const html = '<main class="content">' +
    '<p>Von Samstag, den 10. Oktober 2026 um 10:00 Uhr (MESZ) bis zu den Wartungsarbeiten von Patch 7.1</p>' +
    '<p>Von Dienstag, den 20. Oktober 2026 um 10:00 Uhr (MESZ) bis Donnerstag, den 22. Oktober 2026 um 15:00 Uhr (MESZ).</p>' +
    '</main>';
  const result = await extract(html, NOW);

  assert.equal(result.periods.status, 'ok');
  if (result.periods.status === 'ok') assert.equal(result.periods.value.length, 2);
  assert.equal(result.period.status, 'unsicher');
});

test('block boundaries keep adjacent paragraph periods separate', async () => {
  const html = '<main class="content">' +
    '<p>Von Samstag, den 10. Oktober 2026 um 10:00 Uhr (MESZ) bis zu den Wartungsarbeiten von Patch 7.1</p>' +
    '<p>Von Dienstag, den 20. Oktober 2026 um 10:00 Uhr (MESZ) bis Donnerstag, den 22. Oktober 2026 um 15:00 Uhr (MESZ).</p>' +
    '</main>';
  const result = await extract(html, NOW);

  assert.equal(result.periods.status, 'ok');
  if (result.periods.status === 'ok') assert.equal(result.periods.value.length, 2);
});

test('only past periods report ended and do not provide a postable period', async () => {
  const html = simplePeriod(
    'Mittwoch, den 7. Oktober 2026 um 10:00 Uhr (MESZ)',
    'Dienstag, den 13. Oktober 2026 um 10:00 Uhr (MESZ)',
  );
  const result = await extract(html, NOW);

  assert.deepEqual(result.eventState, { status: 'ok', value: 'ended' });
  assert.equal(result.period.status, 'unsicher');
});

test('timezone label disagreement makes the period uncertain', async () => {
  const html = fixture('./fixtures/special/all-saints-wake-2026.html')
    .replace('15:59 Uhr (MEZ)', '15:59 Uhr (MESZ)');
  const result = await extract(html);

  assert.equal(result.period.status, 'unsicher');
  if (result.period.status === 'unsicher') assert.match(result.period.reason, /label|timezone/i);
});

test('evergreen Fankit and friend recruit pages have no period', async () => {
  for (const path of ['fankit.html', 'friend-recruit.html']) {
    const html = fixture(`./fixtures/special/${path}`);
    const result = await extract(html);
    assert.equal(hasPeriod(html, NOW), 'no');
    assert.deepEqual(result.eventState, { status: 'ok', value: 'not-an-event' });
    assert.equal(result.period.status, 'unsicher');
  }
});

test('missing one reward link and an item link outside a reward section are uncertain', async () => {
  const html = fixture('./fixtures/special/all-saints-wake-2026.html');
  const oneMissingLink = html.replace('/lodestone/playguide/db/item/1077b68a626/', '/lodestone/playguide/db/other/1077b68a626/');
  const partial = await extract(oneMissingLink);
  assert.equal(partial.rewards.status, 'unsicher');

  const $ = load(html);
  $('body').append('<div class="unexpected"><img src="https://lds-img.finalfantasyxiv.com/itemicon/aa/example.png"><a href="/lodestone/playguide/db/item/123456789ab/">extra</a></div>');
  const outside = await extract($.html());
  assert.equal(outside.rewards.status, 'unsicher');

  const $withNavItems = load(html);
  $withNavItems('body').append(
    '<nav><a href="/lodestone/playguide/db/item/nav-item/">nav</a></nav>' +
    '<ul class="sub-nav__news__text"><li><a href="/lodestone/playguide/db/item/subnav-item/">subnav</a></li></ul>' +
    '<ul class="sub-nav__community__fankit"><li><a href="/lodestone/playguide/db/item/fankit-nav-item/">fankit nav</a></li></ul>' +
    '<div class="ldst__side"><a href="/lodestone/playguide/db/item/banner-item/">banner</a></div>',
  );
  const navOnly = await extract($withNavItems.html());
  assert.equal(navOnly.rewards.status, 'ok');

  const duplicateId = html.replace('/lodestone/playguide/db/item/c7ee1246362/', '/lodestone/playguide/db/item/1077b68a626/');
  const duplicate = await extract(duplicateId);
  assert.equal(duplicate.rewards.status, 'unsicher');
});
