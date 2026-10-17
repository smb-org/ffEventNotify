import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { extractMaintenance } from '../src/extractors/maintenance.ts';

const fixture = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const expected = JSON.parse(fixture('./fixtures/expected/maintenance-pair.json'));

test('maintenance windows come from the labeled block, not launcher or update times', () => {
  const html = fixture(`./fixtures/${expected.original.fixture}`);
  const result = extractMaintenance(html);

  assert.deepEqual(result.title, { status: 'ok', value: expected.original.title });
  assert.deepEqual(result.period, {
    status: 'ok',
    value: { startUtc: expected.original.startUtc, endUtc: expected.original.endUtc },
  });
});

test('follow-up end time may omit Uhr and still replaces the original window', () => {
  const html = fixture(`./fixtures/${expected.followup.fixture}`);
  const result = extractMaintenance(html);

  assert.deepEqual(result.period, {
    status: 'ok',
    value: { startUtc: expected.followup.startUtc, endUtc: expected.followup.endUtc },
  });
});

test('Mogstation single-day windows parse without throwing', () => {
  const html = fixture(`./fixtures/${expected.mogstationIgnored.fixture}`);
  const result = extractMaintenance(html);

  assert.equal(result.period.status, 'ok');
  if (result.period.status === 'ok') {
    assert.deepEqual(result.period.value, {
      startUtc: '2026-10-15T07:00:00Z',
      endUtc: '2026-10-15T09:00:00Z',
    });
  }
});

test('missing the date and time label does not fall back to other article times', () => {
  const html = fixture(`./fixtures/${expected.original.fixture}`).replace('[Datum & Uhrzeit]', '[Zeitangaben fehlen]');
  const result = extractMaintenance(html);

  assert.equal(result.period.status, 'unsicher');
});
