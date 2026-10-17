import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LODESTONE_USER_AGENT,
  LodestoneRequestQueue,
  MIN_REQUEST_SPACING_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  retryAfterMilliseconds,
} from '../src/sources/queue.ts';

interface FakeWaiter {
  at: number;
  resolve: () => void;
  signal?: AbortSignal;
  abort?: () => void;
}

class FakeClock {
  private time = 0;
  private waiters: FakeWaiter[] = [];
  private timers: Array<{ at: number; fire: () => void }> = [];

  now(): number {
    return this.time;
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter: FakeWaiter = { at: this.time + milliseconds, resolve, signal };
      waiter.abort = () => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        signal?.removeEventListener('abort', waiter.abort!);
        resolve();
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  timeoutSignal(milliseconds: number): AbortSignal {
    const controller = new AbortController();
    this.timers.push({
      at: this.time + milliseconds,
      fire: () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
    });
    return controller.signal;
  }

  async advance(milliseconds: number): Promise<void> {
    const target = this.time + milliseconds;
    while (true) {
      const nextTimer = this.timers.reduce<number | undefined>(
        (closest, timer) => timer.at <= target && (closest === undefined || timer.at < closest) ? timer.at : closest,
        undefined,
      );
      const nextWaiter = this.waiters.reduce<number | undefined>(
        (closest, waiter) => waiter.at <= target && (closest === undefined || waiter.at < closest) ? waiter.at : closest,
        undefined,
      );
      const next = [nextTimer, nextWaiter].filter((value): value is number => value !== undefined)
        .reduce<number | undefined>((closest, value) => closest === undefined || value < closest ? value : closest, undefined);
      if (next === undefined) break;
      this.time = next;
      const timers = this.timers.filter((timer) => timer.at <= next);
      this.timers = this.timers.filter((timer) => timer.at > next);
      for (const timer of timers) timer.fire();
      const waiters = this.waiters.filter((waiter) => waiter.at <= next);
      this.waiters = this.waiters.filter((waiter) => waiter.at > next);
      for (const waiter of waiters) {
        if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort);
        waiter.resolve();
      }
      await flushMicrotasks();
    }
    this.time = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function makeQueue(clock: FakeClock, fetcher: typeof fetch) {
  return new LodestoneRequestQueue({
    fetch: fetcher,
    clock,
    timeoutSignal: (milliseconds) => clock.timeoutSignal(milliseconds),
  });
}

test('queue spaces request starts by at least one second', async () => {
  const clock = new FakeClock();
  const starts: number[] = [];
  const queue = makeQueue(clock, async () => {
    starts.push(clock.now());
    return new Response('ok');
  });

  const first = queue.fetch('https://example.test/first', { priority: 'detail' });
  const second = queue.fetch('https://example.test/second', { priority: 'detail' });
  await flushMicrotasks();
  assert.deepEqual(starts, [0]);
  await clock.advance(MIN_REQUEST_SPACING_MS - 1);
  assert.deepEqual(starts, [0]);
  await clock.advance(1);
  await Promise.all([first, second]);
  assert.deepEqual(starts, [0, 1_000]);
});

test('list requests are started before queued detail and item requests', async () => {
  const clock = new FakeClock();
  const starts: string[] = [];
  const queue = makeQueue(clock, async (input) => {
    starts.push(new URL(String(input)).pathname);
    return new Response('ok');
  });

  const item = queue.fetch('https://example.test/item', { priority: 'item' });
  const detail = queue.fetch('https://example.test/detail', { priority: 'detail' });
  const list = queue.fetch('https://example.test/list', { priority: 'list' });
  await flushMicrotasks();
  await clock.advance(2_000);
  await Promise.all([item, detail, list]);
  assert.deepEqual(starts, ['/list', '/detail', '/item']);
});

test('queue sends conditional headers and turns 304 into a small status result', async () => {
  const clock = new FakeClock();
  let received: RequestInit | undefined;
  const queue = makeQueue(clock, async (_input, init) => {
    received = init;
    return new Response(null, { status: 304 });
  });

  const result = await queue.fetch('https://example.test/page', {
    priority: 'list',
    etag: '"etag-1"',
    lastModified: 'Thu, 15 Oct 2026 08:00:00 GMT',
  });

  assert.deepEqual(result, { status: 304 });
  const headers = new Headers(received?.headers);
  assert.equal(headers.get('user-agent'), LODESTONE_USER_AGENT);
  assert.equal(headers.get('if-none-match'), '"etag-1"');
  assert.equal(headers.get('if-modified-since'), 'Thu, 15 Oct 2026 08:00:00 GMT');
});

test('request timeout aborts the fetch signal at fifteen seconds', async () => {
  const clock = new FakeClock();
  let signal: AbortSignal | undefined;
  const queue = makeQueue(clock, async (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
    });
  });

  const request = queue.fetch('https://example.test/slow', { priority: 'detail', maxRetries: 0 });
  const rejected = assert.rejects(request, { name: 'TimeoutError' });
  await flushMicrotasks();
  assert.equal(signal?.aborted, false);
  await clock.advance(REQUEST_TIMEOUT_MS - 1);
  assert.equal(signal?.aborted, false);
  await clock.advance(1);
  await rejected;
  assert.equal(signal?.aborted, true);
});

test('429 Retry-After controls the retry time', async () => {
  const clock = new FakeClock();
  const starts: number[] = [];
  let attempt = 0;
  const queue = makeQueue(clock, async () => {
    starts.push(clock.now());
    attempt += 1;
    return attempt === 1
      ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
      : new Response('ok');
  });

  const request = queue.fetch('https://example.test/rate-limited', { priority: 'list', maxRetries: 1 });
  await flushMicrotasks();
  await clock.advance(1_999);
  assert.deepEqual(starts, [0]);
  await clock.advance(1);
  await request;
  assert.deepEqual(starts, [0, 2_000]);
});

test('Retry-After longer than ten minutes gives up for this cycle', async () => {
  const clock = new FakeClock();
  const starts: number[] = [];
  const queue = makeQueue(clock, async () => {
    starts.push(clock.now());
    return new Response('slow down', { status: 429, headers: { 'retry-after': '601' } });
  });

  const request = queue.fetch('https://example.test/long-rate-limit', { priority: 'list', maxRetries: 1 });
  await flushMicrotasks();
  await clock.advance(601_000);
  const response = await request;

  assert.equal(response.status, 429);
  assert.deepEqual(starts, [0]);
});

test('a failed request backoff does not block later queued work', async () => {
  const clock = new FakeClock();
  let failingAttempts = 0;
  let laterCompleted = false;
  const queue = makeQueue(clock, async (input) => {
    if (String(input).endsWith('/fails-first')) {
      failingAttempts += 1;
      if (failingAttempts === 1) throw new Error('temporary failure');
    } else {
      laterCompleted = true;
    }
    return new Response('ok');
  });

  const retrying = queue.fetch('https://example.test/fails-first', { priority: 'item', maxRetries: 3 });
  const later = queue.fetch('https://example.test/later', { priority: 'list' });
  await flushMicrotasks();
  await clock.advance(MIN_REQUEST_SPACING_MS);
  await later;
  assert.equal(laterCompleted, true);
  assert.equal(failingAttempts, 1);
  assert.equal(RETRY_DELAYS_MS[0], 30_000);

  await clock.advance(RETRY_DELAYS_MS[0]);
  await clock.advance(MIN_REQUEST_SPACING_MS);
  await retrying;
  assert.equal(failingAttempts, 2);
});

test('transient server failures use the three backoffs and stop after three retries', async () => {
  const clock = new FakeClock();
  const starts: number[] = [];
  const queue = makeQueue(clock, async () => {
    starts.push(clock.now());
    return new Response('unavailable', { status: 503 });
  });

  const request = queue.fetch('https://example.test/unavailable', { priority: 'list' });
  await flushMicrotasks();
  await clock.advance(RETRY_DELAYS_MS[0]);
  await clock.advance(RETRY_DELAYS_MS[1]);
  await clock.advance(RETRY_DELAYS_MS[2]);
  const response = await request;

  assert.equal(response.status, 503);
  assert.deepEqual(starts, [0, 30_000, 150_000, 450_000]);
});

test('callers can defer item retries to the next cycle', async () => {
  const clock = new FakeClock();
  let attempts = 0;
  const queue = makeQueue(clock, async () => {
    attempts += 1;
    throw new Error('offline');
  });

  await assert.rejects(queue.fetch('https://example.test/item', { priority: 'item', maxRetries: 0 }), /offline/);
  await clock.advance(RETRY_DELAYS_MS[0] * 2);
  assert.equal(attempts, 1);
});

test('Retry-After supports HTTP dates and ignores invalid values', () => {
  const now = Date.parse('Thu, 15 Oct 2026 08:00:00 GMT');
  assert.equal(retryAfterMilliseconds('3', now), 3_000);
  assert.equal(retryAfterMilliseconds('Thu, 15 Oct 2026 08:00:05 GMT', now), 5_000);
  assert.equal(retryAfterMilliseconds('invalid', now), undefined);
});
