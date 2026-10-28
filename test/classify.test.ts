import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { classifyEntry, maintenanceStem } from '../src/classify.ts';
import { hasDeclaredPeriod, hasPeriod } from '../src/extractors/seasonal.ts';
import { parseMaintenanceList, parseTopicList } from '../src/sources/lodestone.ts';

const classifyFixture = JSON.parse(readFileSync(new URL('./fixtures/expected/classify.json', import.meta.url), 'utf8')) as {
  topicsP1: Array<{ title: string; url: string; fixture: string; expected: string; note?: string }>;
  maintenanceP1: Array<{ title: string; url: string; expected: string }>;
  keywordEvidence: Array<{ keyword: string; title: string; expected: string; url?: string; fixture?: string; note?: string }>;
};

const NOW = new Date('2026-10-16T12:00:00Z');

const shortTargets: Record<string, string> = {
  'https://sqex.to/oZP2Y': 'https://eu.finalfantasyxiv.com/lodestone/special/2026/All_Saints_Wake/tfrx2rkv52',
  'https://sqex.to/AH3Ln': 'https://de.finalfantasyxiv.com/lodestone/special/2026/All_Saints_Wake/tfrx2rkv52',
  'https://sqex.to/yZDu7': 'https://eu.finalfantasyxiv.com/lodestone/special/fallguys/',
  'https://sqex.to/sl1ML': 'https://eu.finalfantasyxiv.com/lodestone/special/ffxv/8ghatq7szp/',
  'https://sqex.to/YQ1Zf': 'https://eu.finalfantasyxiv.com/lodestone/special/tales_under_the_golden_sun/sidestory_8/#sidestory_8',
  'https://sqex.to/2PT09': 'https://de.finalfantasyxiv.com/lodestone/special/tales_under_the_golden_sun/sidestory_7/#sidestory_7',
};

function detailHtml(fixture: string): string {
  return readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8');
}

const specialFixtures: Array<[string, string]> = [
  ['/lodestone/special/2026/All_Saints_Wake/', 'special/all-saints-wake-2026.html'],
  ['/lodestone/special/fallguys/', 'special/fallguys.html'],
  ['/lodestone/special/mogmog-collection/202609/', 'special/mogmog-202609.html'],
  ['/lodestone/special/friend_recruit/', 'special/friend-recruit.html'],
  ['/lodestone/special/ffxv/8ghatq7szp/', 'special/ffxv-2026.html'],
  ['/lodestone/special/tales_under_the_golden_sun/', 'special/update-log.html'],
];

function periodEvidence(path: string): 'yes' | 'no' | 'unsicher' {
  const fixture = specialFixtures.find(([prefix]) => path.startsWith(prefix))?.[1];
  if (fixture === undefined) return 'no';
  const evidence: unknown = hasPeriod(detailHtml(fixture), NOW);
  if (evidence === true) return 'yes';
  if (evidence === false) return 'no';
  return evidence as 'yes' | 'no' | 'unsicher';
}

function listPath(url: string): string {
  return new URL(url).pathname;
}

const topicEntries = parseTopicList(readFileSync(new URL('./fixtures/lists/topics-p1.html', import.meta.url), 'utf8'))
  .map((entry) => ({ ...entry, source: 'topic' as const }));
const topicEntriesP3 = parseTopicList(readFileSync(new URL('./fixtures/lists/topics-p3.html', import.meta.url), 'utf8'))
  .map((entry) => ({ ...entry, source: 'topic' as const }));
const maintenanceEntries = parseMaintenanceList(readFileSync(new URL('./fixtures/lists/maintenance-p1.html', import.meta.url), 'utf8'))
  .map((entry) => ({ ...entry, source: 'maintenance' as const }));

function expectedClassification(value: string): { status: string; eventType?: string } {
  if (value === 'ignore') return { status: 'ignored' };
  if (value === 'unclassified') return { status: 'unclassified' };
  return { status: 'classified', eventType: value };
}

async function classify(
  entry: { title: string; url: string; source: 'topic' | 'maintenance' },
  body?: string,
) {
  try {
    return await classifyEntry(entry, body, {
      fetchText: async (url) => ({
        status: 200,
        body: '',
        finalUrl: shortTargets[url] ?? (new URL(url).hostname === 'sqex.to' ? 'https://example.test/resolved/' : url),
      }),
      hasPeriod: periodEvidence,
      topicPeriod: body === undefined ? 'no' : hasDeclaredPeriod(body, NOW),
    });
  } catch (error) {
    assert.fail(`classifyEntry should return a classification: ${String(error)}`);
  }
}

test('topic classification follows the fixture expectations and filters specials without periods', async () => {
  for (const item of classifyFixture.topicsP1) {
    const entry = topicEntries.find((candidate) => listPath(candidate.url) === item.url);
    assert.ok(entry, `topic list entry exists for ${item.url}`);
    assert.equal(entry.title, item.title);
    const result = await classify(
      entry,
      detailHtml(item.fixture),
    );
    const expected = item.note?.includes('without period') ? 'unclassified' : item.expected;
    assert.deepEqual(
      { status: result.status, ...('eventType' in result ? { eventType: result.eventType } : {}) },
      expectedClassification(expected),
      item.title,
    );
  }
});

test('maintenance classification follows every maintenance-p1 expected value', async () => {
  for (const item of classifyFixture.maintenanceP1) {
    const entry = maintenanceEntries.find((candidate) => listPath(candidate.url) === item.url);
    assert.ok(entry, `maintenance list entry exists for ${item.url}`);
    assert.equal(entry.title, item.title);
    const result = await classify(entry);
    assert.deepEqual(
      { status: result.status, ...('eventType' in result ? { eventType: result.eventType } : {}) },
      expectedClassification(item.expected),
      item.title,
    );
  }
});

test('maintenance stems pair the original and follow-up titles in the expected fixture', () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/expected/maintenance-pair.json', import.meta.url), 'utf8')) as {
    original: { title: string; stem: string };
    followup: { title: string; stem: string };
    stemsMatch: boolean;
  };
  assert.equal(maintenanceStem(expected.original.title), expected.original.stem);
  assert.equal(maintenanceStem(expected.followup.title), expected.followup.stem);
  assert.equal(maintenanceStem('[Folge-News][Aether] Wartung aller Welten (12.-13. Okt.): Folgenews'), 'Wartung aller Welten (12-13. Okt.)');
  assert.equal(expected.stemsMatch, maintenanceStem(expected.original.title) === maintenanceStem(expected.followup.title));
});

test('a LIVE-letter topic with site-wide special banners is not classified as seasonal', async () => {
  const html = detailHtml('topics/ll93-topic-a.html');
  const expected = JSON.parse(readFileSync(new URL('./fixtures/expected/ll93.json', import.meta.url), 'utf8')) as Record<string, {
    topics: Array<{ title: string; url: string }>;
  }>;
  const title = expected['Brief des Produzenten LIVE Teil 93']!.topics[0]!.title;
  const result = await classify({
    title,
    url: '/lodestone/topics/detail/c026fd2ed62da67c1c329e3b3cf0b56e8778fe6e',
    source: 'topic',
  }, html);
  assert.deepEqual(result, {
    status: 'classified',
    eventType: 'topic-generic',
  });
});

test('a shop announcement with an event keyword is ignored', async () => {
  const result = await classify({
    title: 'Neue Gegenstände zum Fan Festival 2026 (Teil 3) & Rabattaktion!',
    url: '/lodestone/topics/detail/b726db23f28d44f6051a9920d65ebadf6098c1e3',
    source: 'topic',
  }, detailHtml('topics/b726db23f28d44f6051a9920d65ebadf6098c1e3.html'));
  assert.equal(result.status, 'ignored');
});

test('a Fan Festival announcement without another event keyword is ignored', async () => {
  const result = await classify({
    title: 'Das Fan Festival 2026 in Tokyo beginnt am 31. Oktober! Lasst euch die Livestreams nicht entgehen!',
    url: '/lodestone/topics/detail/ce2b34c5d8b5660a93b07e555e775df5ac9628ce',
    source: 'topic',
  });
  assert.deepEqual(result, {
    status: 'ignored',
    reason: 'Der Beitrag betrifft das Fan Festival, kein Ingame-Event.',
  });
});

test('a community contest announcement with an event keyword is ignored', async () => {
  const result = await classify({
    title: 'Ankündigung des „Fan Festival im Gruppenfotomodus“ Screenshot-Gewinnspiels',
    url: '/lodestone/topics/detail/f19dfeeb61eafd79c11fda40571bf1ed81f1fedc',
    source: 'topic',
  }, detailHtml('topics/f19dfeeb61eafd79c11fda40571bf1ed81f1fedc.html'));
  assert.equal(result.status, 'ignored');
});

test('a special link without a parsed period falls through keyword classification', async () => {
  const entry = classifyFixture.topicsP1.find((item) => item.note?.includes('without period'))!;
  const result = await classify({ title: entry.title, url: entry.url, source: 'topic' }, detailHtml(entry.fixture));
  assert.deepEqual(result, {
    status: 'unclassified',
    reason: `Keine Klassifikationsregel passt auf „${entry.title}“.`,
  });
});

test('each classification keyword has fixture-backed exact-case behavior', async (t) => {
  for (const item of classifyFixture.keywordEvidence) {
    await t.test(`${item.keyword}: ${item.title}`, async () => {
      if (item.url !== undefined) {
        const sourceEntries = item.fixture === 'lists/topics-p3.html' ? topicEntriesP3 : topicEntries;
        const sourceEntry = sourceEntries.find((candidate) => listPath(candidate.url) === item.url);
        assert.equal(sourceEntry?.title, item.title, 'keyword title matches the captured Lodestone list fixture');
      }
      const result = await classifyEntry({
        title: item.title,
        url: item.url ?? `https://de.finalfantasyxiv.com/lodestone/topics/detail/keyword-${encodeURIComponent(item.title)}`,
        source: 'topic',
      }, undefined, { hasPeriod: () => 'no' });
      assert.deepEqual(
        { status: result.status, ...('eventType' in result ? { eventType: result.eventType } : {}) },
        expectedClassification(item.expected),
        item.note,
      );
    });
  }
});

test('banner special pages use their real period evidence', async () => {
  const cases = [
    ['/lodestone/special/mogmog-collection/202609/lsekubsk45', 'seasonal-special'],
    ['/lodestone/special/ffxiv/8ghatq7szp/', 'ignored'],
    ['/lodestone/special/friend_recruit/', 'ignored'],
  ] as const;
  for (const [path, expected] of cases) {
    const result = await classifyEntry({ title: path, url: path, source: 'banner' }, undefined, {
      hasPeriod: periodEvidence,
    });
    assert.equal(result.status === 'classified' ? result.eventType : result.status, expected, path);
    if (expected === 'ignored') assert.deepEqual(result, { status: 'ignored', reason: 'Auf der Sonderseite steht kein Zeitraum.' });
  }
});

test('a rejected sqex.to resolution is explicitly unclassified', async () => {
  const item = classifyFixture.topicsP1.find(({ title }) => title.includes('Allerschutzheiligen'))!;
  const entry = topicEntries.find((candidate) => listPath(candidate.url) === item.url)!;
  const result = await classifyEntry(entry, detailHtml(item.fixture), {
    fetchText: async () => { throw new Error('offline'); },
    hasPeriod: periodEvidence,
  });
  assert.deepEqual(result, { status: 'unclassified', reason: 'Ein Kurzlink konnte nicht aufgelöst werden.' });
});

test('a bad historical Fall Guys timezone label keeps the topic seasonal', async () => {
  const html = detailHtml('special/fallguys.html').replace('15:59 Uhr (MEZ)', '15:59 Uhr (MESZ)');
  assert.equal(periodEvidence('/lodestone/special/fallguys/'), 'yes');
  const result = await classifyEntry({
    title: 'Die Fall Guys-Kollaboration kehrt am 7. Oktober zurück!',
    url: '/lodestone/topics/detail/fallguys',
    source: 'topic',
  }, '<article class="news__detail"><div class="news__detail__wrapper"><a href="/lodestone/special/fallguys/">Fall Guys</a></div></article>', {
    hasPeriod: () => hasPeriod(html, NOW) as unknown as 'yes' | 'no' | 'unsicher',
  });
  assert.deepEqual(result, { status: 'classified', eventType: 'seasonal-special' });
});

test('FFXV topic period classifies its linked special page even when the special page has no period', async () => {
  const expected = classifyFixture.topicsP1.find(({ title }) => title.includes('FINAL FANTASY XV'))!;
  const entry = topicEntries.find((candidate) => listPath(candidate.url) === expected.url)!;
  const result = await classify(entry, detailHtml(expected.fixture));

  assert.deepEqual(result, { status: 'classified', eventType: 'seasonal-special' });
});
