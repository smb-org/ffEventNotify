import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deriveGenericEventKey, extractGeneric, extractGenericTopic } from '../src/extractors/generic.ts';
import type { ListEntry } from '../src/types.ts';

const fixture = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const expected = JSON.parse(fixture('./fixtures/expected/ll93.json'))['Brief des Produzenten LIVE Teil 93'];
const entry: ListEntry = {
  title: expected.topics[0].title,
  url: expected.topics[0].url,
  source: 'topic',
};

test('LL93 date comes from the article schedule, not the later update time', () => {
  const html = fixture(`./fixtures/${expected.topics[0].fixture}`);
  const result = extractGeneric(html);

  assert.equal(result.title.status, 'ok');
  if (result.title.status === 'ok') assert.equal(result.title.value, expected.topics[0].title);
  assert.deepEqual(result.date, { status: 'ok', value: expected.startUtc });
  assert.equal(result.period.status, 'unsicher');
});

test('duplicate LL93 topics share a key based on their part number', () => {
  const first = fixture(`./fixtures/${expected.topics[0].fixture}`);
  const second = fixture(`./fixtures/${expected.topics[1].fixture}`);
  assert.equal(deriveGenericEventKey(entry, first), 'Brief des Produzenten LIVE Teil 93');
  assert.equal(deriveGenericEventKey({ ...entry, title: expected.topics[1].title }, second), 'Brief des Produzenten LIVE Teil 93');
  assert.deepEqual(extractGenericTopic(entry, first).date, { status: 'ok', value: expected.startUtc });
});

test('the generic event key normalizes the title and uses the parsed article date', () => {
  const html = fixture('./fixtures/' + expected.topics[0].fixture);
  assert.equal(
    deriveGenericEventKey({ ...entry, title: 'Titel, mit Satzzeichen!' }, html),
    'Titel mit Satzzeichen 2026-07-25',
  );
});

test('without a reliable schedule date the generic date remains uncertain', () => {
  const html = fixture(`./fixtures/${expected.topics[0].fixture}`)
    .replace('Samstag, den 25. Juli 2026 um 16:30 Uhr (MESZ)', 'Datum folgt');
  const result = extractGeneric(html);

  assert.equal(result.date.status, 'unsicher');
});
