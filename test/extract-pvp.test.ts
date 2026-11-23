import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extractPvpSeasonUpdates } from '../src/extractors/pvp.ts';

const fixture = (id: string) => readFileSync(new URL(`./fixtures/topics/${id}.html`, import.meta.url), 'utf8');

test('Crystalline Conflict patch-end announcements keep the date as a cross-check and infer a missing year', () => {
  const fullYear = extractPvpSeasonUpdates(
    'Auf in die letzte Phase der 21. Saison von Crystalline Conflict!',
    fixture('377ccb56749da916d62a8d0ac10907d6b77ab11e'),
    '2026-11-03T10:00:00Z',
  );
  assert.deepEqual(fullYear, [{
    eventKey: 'pvp:cc:21',
    title: 'Crystalline Conflict – 21. Saison',
    endPatch: '7.58',
    expectedEndDate: '2026-11-10',
  }]);

  const inferredYear = extractPvpSeasonUpdates(
    'Auf in die letzte Phase der 20. Saison von Crystalline Conflict!',
    fixture('e0aabd6871cdda42b7edbd07b4543e61172feb9c'),
    '2026-07-14T10:00:00Z',
  );
  assert.equal(inferredYear[0]?.expectedEndDate, '2026-07-28');
  assert.equal(inferredYear[0]?.endPatch, '7.55');
});

test('Crystalline Conflict season-change announcements end an existing prior season and start the next', () => {
  const updates = extractPvpSeasonUpdates(
    'Die 21. Saison von Crystalline Conflict ist abgeschlossen, Ring frei für die 22. Saison!',
    fixture('2854fb25991c1cab6f03ae0e7d390ccaa7cd1a02'),
    '2026-11-10T09:00:00Z',
  );
  assert.deepEqual(updates, [
    { eventKey: 'pvp:cc:21', title: 'Crystalline Conflict – 21. Saison', endUtc: '2026-11-10T09:00:00Z' },
    { eventKey: 'pvp:cc:22', title: 'Crystalline Conflict – 22. Saison', startUtc: '2026-11-10T09:00:00Z' },
  ]);
});

test('PvP-Serie patch-end announcement captures patch and the year-inferred date', () => {
  const updates = extractPvpSeasonUpdates(
    'Die PvP-Serie 11 endet mit der Veröffentlichung von Patch 7.56!',
    fixture('4769450afe53ac24710d5c28ad1e6e9c94fc7f73'),
    '2026-08-20T10:00:00Z',
  );
  assert.deepEqual(updates, [{
    eventKey: 'pvp:series:11',
    title: 'PvP-Serie 11',
    endPatch: '7.56',
    expectedEndDate: '2026-09-08',
  }]);
});

test('PvP-Serie change ends an existing prior series and starts the next at publication', () => {
  const updates = extractPvpSeasonUpdates(
    'Die PvP-Serie 11 ist zu Ende und Serie 12 hat begonnen',
    fixture('0aa579530ee986a480f0e48688a64bf791deb09d'),
    '2026-11-10T09:00:00Z',
  );
  assert.deepEqual(updates, [
    { eventKey: 'pvp:series:11', title: 'PvP-Serie 11', endUtc: '2026-11-10T09:00:00Z' },
    { eventKey: 'pvp:series:12', title: 'PvP-Serie 12', startUtc: '2026-11-10T09:00:00Z' },
  ]);
});

test('Brett der Bestie start announcement keeps its date and leaves the imprecise end open', () => {
  const updates = extractPvpSeasonUpdates(
    'Startdatum für Saison 1 auf dem Brett der Bestie',
    fixture('7bf7d30ca5cd6a070407c97c2cd3c04f57430c40'),
    '2026-10-20T10:00:00Z',
  );
  assert.deepEqual(updates, [{
    eventKey: 'pvp:crucible:1',
    title: 'Brett der Bestie – 1. Saison',
    startUtc: '2026-10-26T05:00:00Z',
  }]);
});

test('Brett der Bestie open-season announcement uses publication as its start and leaves the end unknown', () => {
  const updates = extractPvpSeasonUpdates(
    'Die 1. Saison der Ranglisten für das Brett der Bestie hat begonnen!',
    fixture('1695818e251893e210bc4aab92f2b7a2164a7b0b'),
    '2026-10-26T05:00:00Z',
  );
  assert.deepEqual(updates, [{
    eventKey: 'pvp:crucible:1',
    title: 'Brett der Bestie – 1. Saison',
    startUtc: '2026-10-26T05:00:00Z',
  }]);
});

test('Brett der Bestie end and next-season period accept ca. before the time', () => {
  const updates = extractPvpSeasonUpdates(
    'Das Ende von Saison 1 und der Start von Saison 2 auf dem Brett der Bestie',
    fixture('e1432cb0adb2c59d841fdbde19406820d4a49cc3'),
    '2026-12-01T04:59:00Z',
  );
  assert.deepEqual(updates, [
    { eventKey: 'pvp:crucible:1', title: 'Brett der Bestie – 1. Saison', endUtc: '2026-12-01T04:59:00Z' },
    {
      eventKey: 'pvp:crucible:2',
      title: 'Brett der Bestie – 2. Saison',
      startUtc: '2026-12-08T05:00:00Z',
      endPatch: '8.0',
    },
  ]);
});

test('yearless PvP dates use the first Berlin calendar occurrence on or after publication', () => {
  const updates = extractPvpSeasonUpdates(
    'Auf in die letzte Phase der 21. Saison von Crystalline Conflict!',
    '<article class="news__detail"><div class="news__detail__wrapper"><p>Bis zum Beginn der Wartungsarbeiten für Patch 8.1 am Dienstag, den 5. Januar.</p></div></article>',
    '2026-12-28T23:30:00Z',
  );
  assert.equal(updates[0]?.expectedEndDate, '2027-01-05');
});

test('Brett period blocks keep exact dates local and parse yearless times without borrowing a later patch', () => {
  const updates = extractPvpSeasonUpdates(
    'Das Ende von Saison 3 und der Start von Saison 4 auf dem Brett der Bestie',
    '<article class="news__detail"><div class="news__detail__wrapper">'
      + '<h4>Zeitraum der 3. Saison</h4><p>Von Montag, den 4. Januar um 6:00 Uhr bis Dienstag, den 12. Januar um 5:59 Uhr</p>'
      + '<h4>Zeitraum der 4. Saison</h4><p>Von Dienstag, den 12. Januar um 6:00 Uhr bis zum Beginn der Wartungsarbeiten für Patch 8.2</p>'
      + '</div></article>',
    '2026-12-28T23:30:00Z',
  );
  assert.deepEqual(updates, [
    { eventKey: 'pvp:crucible:3', title: 'Brett der Bestie – 3. Saison', startUtc: '2027-01-04T05:00:00Z', endUtc: '2027-01-12T04:59:00Z' },
    { eventKey: 'pvp:crucible:4', title: 'Brett der Bestie – 4. Saison', startUtc: '2027-01-12T05:00:00Z', endPatch: '8.2' },
  ]);
});
