import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SourceHealthMonitor } from '../src/health.ts';
import { openDb } from '../src/store.ts';

test('source becomes blind after three failed cycles and emits one entry transition', () => {
  const db = openDb(':memory:');
  try {
    const health = new SourceHealthMonitor(db);
    const now = new Date('2026-10-16T10:00:00.000Z');

    assert.equal(health.recordCycleHealth([12], false, now).transition, undefined);
    assert.equal(health.recordCycleHealth([12], false, now).transition, undefined);
    const entered = health.recordCycleHealth([12], false, now);

    assert.equal(entered.isBlind, true);
    assert.equal(entered.consecutiveFailedCycles, 3);
    assert.deepEqual(entered.transition, { type: 'blind', atUtc: now.toISOString() });
    assert.equal(health.isBlind(), true);
    assert.equal(health.recordCycleHealth([12], false, now).transition, undefined);
  } finally {
    db.close();
  }
});

test('an empty parsed list enters blind state immediately and recovery emits once', () => {
  const db = openDb(':memory:');
  try {
    const health = new SourceHealthMonitor(db);
    const now = new Date('2026-10-16T10:00:00.000Z');

    const entered = health.recordCycleHealth([0, 4], true, now);
    assert.equal(entered.isBlind, true);
    assert.deepEqual(entered.transition, { type: 'blind', atUtc: now.toISOString() });

    const recovered = health.recordCycleHealth([4, 3], true, new Date('2026-10-16T11:00:00.000Z'));
    assert.equal(recovered.isBlind, false);
    assert.deepEqual(recovered.transition, { type: 'recovered', atUtc: '2026-10-16T11:00:00.000Z' });
    assert.equal(health.isBlind(), false);
    assert.equal(health.recordCycleHealth([4, 3], true, now).transition, undefined);
  } finally {
    db.close();
  }
});

test('blind state stays latched through a failed probe and clears only after all required lists recover', () => {
  const db = openDb(':memory:');
  try {
    const health = new SourceHealthMonitor(db);
    const now = new Date('2026-10-16T10:00:00.000Z');

    health.recordCycleHealth([0, 4], true, now);
    const failedProbe = health.recordCycleHealth([], false, new Date('2026-10-16T11:00:00.000Z'));
    assert.equal(failedProbe.isBlind, true);
    assert.equal(failedProbe.transition, undefined);

    const partialRecovery = health.recordCycleHealth([4, 0], true, new Date('2026-10-16T12:00:00.000Z'));
    assert.equal(partialRecovery.isBlind, true);
    assert.equal(partialRecovery.transition, undefined);

    const recovered = health.recordCycleHealth([4, 3], true, new Date('2026-10-16T13:00:00.000Z'));
    assert.equal(recovered.isBlind, false);
    assert.deepEqual(recovered.transition, { type: 'recovered', atUtc: '2026-10-16T13:00:00.000Z' });
  } finally {
    db.close();
  }
});

test('a successful cycle resets the consecutive failure count', () => {
  const db = openDb(':memory:');
  try {
    const health = new SourceHealthMonitor(db);
    health.recordCycleHealth([5], false, new Date('2026-10-16T10:00:00.000Z'));
    const result = health.recordCycleHealth([5], true, new Date('2026-10-16T11:00:00.000Z'));
    assert.equal(result.consecutiveFailedCycles, 0);
    assert.equal(result.isBlind, false);
  } finally {
    db.close();
  }
});

test('blind state survives a process restart without repeating the warning and recovers once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffeventnotify-health-'));
  const dbPath = join(directory, 'health.sqlite');
  let db = openDb(dbPath);
  try {
    const started = new SourceHealthMonitor(db).recordCycleHealth(
      [0],
      true,
      new Date('2026-10-16T10:00:00.000Z'),
    );
    assert.deepEqual(started.transition, { type: 'blind', atUtc: '2026-10-16T10:00:00.000Z' });
    db.close();

    db = openDb(dbPath);
    const restarted = new SourceHealthMonitor(db);
    const stillBlind = restarted.recordCycleHealth(
      [0],
      true,
      new Date('2026-10-16T11:00:00.000Z'),
    );
    assert.equal(stillBlind.isBlind, true);
    assert.equal(stillBlind.blindSinceUtc, '2026-10-16T10:00:00.000Z');
    assert.equal(stillBlind.transition, undefined);

    const recovered = restarted.recordCycleHealth(
      [4, 3],
      true,
      new Date('2026-10-16T12:00:00.000Z'),
    );
    assert.deepEqual(recovered.transition, { type: 'recovered', atUtc: '2026-10-16T12:00:00.000Z' });
    assert.equal(restarted.recordCycleHealth([4, 3], true, new Date('2026-10-16T13:00:00.000Z')).transition, undefined);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('health monitors use independent state without a module singleton', () => {
  const firstDb = openDb(':memory:');
  const secondDb = openDb(':memory:');
  try {
    const first = new SourceHealthMonitor(firstDb);
    const second = new SourceHealthMonitor(secondDb);
    first.recordCycleHealth([0], true, new Date('2026-10-16T10:00:00.000Z'));

    assert.equal(first.isBlind(), true);
    assert.equal(second.isBlind(), false);
  } finally {
    firstDb.close();
    secondDb.close();
  }
});
