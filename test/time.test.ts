import assert from 'node:assert/strict';
import test from 'node:test';
import { berlinDateTimeToUtc, parseGermanDateTime } from '../src/time.ts';

test('German month names parse and convert MESZ start to UTC', () => {
  assert.equal(berlinDateTimeToUtc('15. Oktober 2026', '10:00', 'MESZ'), '2026-10-15T08:00:00.000Z');
});

test('März parses with its German umlaut and uses winter time before the DST change', () => {
  assert.equal(berlinDateTimeToUtc('15. März 2026', '10:00'), '2026-03-15T09:00:00.000Z');
});

test('all German month names map to the correct calendar month', () => {
  const cases = [
    ['Januar', '2026-01-15T09:00:00.000Z'],
    ['Februar', '2026-02-15T09:00:00.000Z'],
    ['März', '2026-03-15T09:00:00.000Z'],
    ['April', '2026-04-15T08:00:00.000Z'],
    ['Mai', '2026-05-15T08:00:00.000Z'],
    ['Juni', '2026-06-15T08:00:00.000Z'],
    ['Juli', '2026-07-15T08:00:00.000Z'],
    ['August', '2026-08-15T08:00:00.000Z'],
    ['September', '2026-09-15T08:00:00.000Z'],
    ['Oktober', '2026-10-15T08:00:00.000Z'],
    ['November', '2026-11-15T09:00:00.000Z'],
    ['Dezember', '2026-12-15T09:00:00.000Z'],
  ] as const;
  for (const [month, expected] of cases) {
    assert.equal(berlinDateTimeToUtc(`15. ${month} 2026`, '10:00'), expected);
  }
});

test('Berlin conversion is independent of the process timezone', () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Pacific/Honolulu';
  try {
    assert.equal(berlinDateTimeToUtc('2026-10-15', '10:00'), '2026-10-15T08:00:00.000Z');
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test('MEZ end time converts to UTC after the autumn clock change', () => {
  assert.equal(berlinDateTimeToUtc('2. November 2026', '15:59', 'MEZ'), '2026-11-02T14:59:00.000Z');
});

test('ambiguous fall-back time requires a label and the label selects the correct occurrence', () => {
  assert.deepEqual(parseGermanDateTime('2026-10-25', '02:30'), {
    status: 'ambiguous',
    candidatesUtc: ['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z'],
  });
  assert.equal(berlinDateTimeToUtc('2026-10-25', '02:30', 'MESZ'), '2026-10-25T00:30:00.000Z');
  assert.equal(berlinDateTimeToUtc('2026-10-25', '02:30', 'MEZ'), '2026-10-25T01:30:00.000Z');
});

test('non-existent spring-forward local time is invalid', () => {
  assert.equal(parseGermanDateTime('2026-03-29', '02:30').status, 'invalid');
  assert.throws(() => berlinDateTimeToUtc('2026-03-29', '02:30'), { name: 'RangeError' });
});

test('an explicit MESZ or MEZ label that disagrees with the zone is reported', () => {
  assert.deepEqual(parseGermanDateTime('2026-10-15', '10:00', 'MEZ'), {
    status: 'label-mismatch',
    label: 'MEZ',
    actualLabels: ['MESZ'],
  });
  assert.throws(() => berlinDateTimeToUtc('2026-10-15', '10:00', 'MEZ'), /label/);
});

test('invalid dates and times are rejected instead of normalized', () => {
  assert.equal(parseGermanDateTime('32. März 2026', '10:00').status, 'invalid');
  assert.equal(parseGermanDateTime('2026-03-01', '24:00').status, 'invalid');
});
