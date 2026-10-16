import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src/config.ts';
import { CYCLE_INTERVAL_MS, parseCliArgs, startHourlyScheduler } from '../src/main.ts';

class FakeClock {
  private time = 0;
  private waiters: Array<{ at: number; resolve: () => void; signal?: AbortSignal; abort?: () => void }> = [];

  now(): number {
    return this.time;
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { at: this.time + milliseconds, resolve, signal } as {
        at: number; resolve: () => void; signal?: AbortSignal; abort?: () => void;
      };
      waiter.abort = () => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        signal?.removeEventListener('abort', waiter.abort!);
        resolve();
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  async advance(milliseconds: number): Promise<void> {
    this.time += milliseconds;
    const due = this.waiters.filter((waiter) => waiter.at <= this.time);
    this.waiters = this.waiters.filter((waiter) => waiter.at > this.time);
    for (const waiter of due) {
      if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.resolve();
    }
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

test('hourly scheduler logs a skipped tick and never overlaps a long cycle', async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  const skips: number[] = [];
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let releaseFirstCycle!: () => void;
  const scheduler = startHourlyScheduler(async () => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (calls === 1) await new Promise<void>((resolve) => { releaseFirstCycle = resolve; });
    active -= 1;
  }, {
    clock,
    signal: controller.signal,
    onSkipped: (tickAt) => skips.push(tickAt),
  });

  await flushMicrotasks();
  assert.equal(calls, 1);
  await clock.advance(CYCLE_INTERVAL_MS);
  assert.deepEqual(skips, [CYCLE_INTERVAL_MS]);
  assert.equal(calls, 1);
  releaseFirstCycle();
  await flushMicrotasks();
  controller.abort();
  await flushMicrotasks();
  await scheduler;

  assert.equal(maximumActive, 1);
});

test('dry-run config works without environment while production still requires Discord credentials', () => {
  const dryRunConfig = readConfig({ dryRun: true, env: {} });

  assert.equal(dryRunConfig.dbPath, ':memory:');
  assert.throws(() => readConfig({ env: {} }), /DISCORD_TOKEN/);
});

test('dry-run CLI accepts an optional database and dump directory', () => {
  assert.deepEqual(parseCliArgs(['--dry-run', '--db', './dry-run.sqlite', '--dump', './lodestone-dump']), {
    dryRun: true,
    dbPath: './dry-run.sqlite',
    dumpDir: './lodestone-dump',
  });
  assert.throws(() => parseCliArgs(['--dry-run', '--db']), /Missing path/);
});
