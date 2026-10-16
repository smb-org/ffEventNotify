// Serial Lodestone fetch queue with spacing, timeouts, priorities, and delayed retries.

export const LODESTONE_USER_AGENT = 'ffEventNotify (Discord-Bot, ein Server)';
export const MIN_REQUEST_SPACING_MS = 1_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_RETRY_AFTER_MS = 10 * 60_000;
export const RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;

export type RequestPriority = 'list' | 'detail' | 'item' | 'wiki';

export interface QueueClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface QueueRequestOptions {
  priority: RequestPriority;
  etag?: string;
  lastModified?: string;
  /** Set to zero to leave transient failures for the next cycle. */
  maxRetries?: number;
}

export interface NotModifiedResponse {
  status: 304;
}

export type QueueResponse = Response | NotModifiedResponse;

export interface LodestoneRequestQueueOptions {
  fetch?: typeof fetch;
  clock?: QueueClock;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}

interface QueueTask<T = unknown> {
  request: (init: RequestInit) => Promise<T>;
  options: QueueRequestOptions;
  resolve: (value: T | NotModifiedResponse) => void;
  reject: (reason: unknown) => void;
  retries: number;
}

const priorityOrder: Record<RequestPriority, number> = {
  list: 0,
  detail: 1,
  item: 2,
  wiki: 3,
};

const systemClock: QueueClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export function retryAfterMilliseconds(
  headerValue: string | null,
  nowMilliseconds = Date.now(),
): number | undefined {
  if (headerValue === null) return undefined;
  const value = headerValue.trim();
  if (!value) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Number(value) * 1_000);

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - nowMilliseconds);
}

export class LodestoneRequestQueue {
  private readonly fetchImplementation: typeof fetch;
  private readonly clock: QueueClock;
  private readonly timeoutSignal: (milliseconds: number) => AbortSignal;
  private readonly tasks: QueueTask[] = [];
  private previousStartAt: number | undefined;
  private draining = false;
  private pumpScheduled = false;

  constructor(options: LodestoneRequestQueueOptions = {}) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.clock = options.clock ?? systemClock;
    this.timeoutSignal = options.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  }

  fetch(url: string | URL, options: QueueRequestOptions): Promise<QueueResponse> {
    return this.enqueueRequest<Response>((init) => this.fetchImplementation(url, init), options);
  }

  enqueueRequest<T>(
    request: (init: RequestInit) => Promise<T>,
    options: QueueRequestOptions,
  ): Promise<T | NotModifiedResponse> {
    return new Promise<T | NotModifiedResponse>((resolve, reject) => {
      const task: QueueTask<T> = {
        request,
        options,
        resolve,
        reject,
        retries: 0,
      };
      this.tasks.push(task as QueueTask);
      this.schedulePump();
    });
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.draining) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.tasks.length > 0) {
        const spacingWait = this.nextStartWait();
        if (spacingWait > 0) await this.clock.sleep(spacingWait);

        const task = this.takeHighestPriorityTask();
        if (task === undefined) break;
        this.previousStartAt = this.clock.now();
        await this.runAttempt(task);
      }
    } finally {
      this.draining = false;
      if (this.tasks.length > 0) this.schedulePump();
    }
  }

  private nextStartWait(): number {
    if (this.previousStartAt === undefined) return 0;
    return Math.max(0, this.previousStartAt + MIN_REQUEST_SPACING_MS - this.clock.now());
  }

  private takeHighestPriorityTask(): QueueTask | undefined {
    if (this.tasks.length === 0) return undefined;
    let bestIndex = 0;
    for (let index = 1; index < this.tasks.length; index += 1) {
      if (priorityOrder[this.tasks[index]!.options.priority] < priorityOrder[this.tasks[bestIndex]!.options.priority]) {
        bestIndex = index;
      }
    }
    return this.tasks.splice(bestIndex, 1)[0];
  }

  private async runAttempt(task: QueueTask): Promise<void> {
    const headers = new Headers({ 'User-Agent': LODESTONE_USER_AGENT });
    if (task.options.etag !== undefined) headers.set('If-None-Match', task.options.etag);
    if (task.options.lastModified !== undefined) headers.set('If-Modified-Since', task.options.lastModified);
    const init: RequestInit = {
      headers,
      signal: this.timeoutSignal(REQUEST_TIMEOUT_MS),
    };

    try {
      const result = await task.request(init);
      if (result instanceof Response && result.status === 304) {
        task.resolve({ status: 304 });
        return;
      }

      if (result instanceof Response && this.shouldRetryResponse(result)) {
        if (this.canRetry(task)) {
          const retryAfter = result.status === 429
            ? retryAfterMilliseconds(result.headers.get('retry-after'), this.clock.now())
            : undefined;
          if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS) {
            task.resolve(result);
            return;
          }
          const delay = result.status === 429
            ? retryAfter ?? this.retryDelay(task.retries)
            : this.retryDelay(task.retries);
          this.scheduleRetry(task, delay);
          return;
        }
      }
      task.resolve(result);
    } catch (error) {
      if (this.canRetry(task)) {
        this.scheduleRetry(task, this.retryDelay(task.retries));
      } else {
        task.reject(error);
      }
    }
  }

  private shouldRetryResponse(response: Response): boolean {
    return response.status === 429 || response.status >= 500;
  }

  private canRetry(task: QueueTask): boolean {
    return task.retries < (task.options.maxRetries ?? RETRY_DELAYS_MS.length);
  }

  private retryDelay(retriesAlreadyUsed: number): number {
    return RETRY_DELAYS_MS[Math.min(retriesAlreadyUsed, RETRY_DELAYS_MS.length - 1)]!;
  }

  private scheduleRetry(task: QueueTask, delay: number): void {
    task.retries += 1;
    void this.clock.sleep(delay).then(() => {
      this.tasks.push(task);
      this.schedulePump();
    }, (error: unknown) => task.reject(error));
  }
}

const defaultQueue = new LodestoneRequestQueue();

export function enqueueRequest<T>(
  request: (init?: RequestInit) => Promise<T>,
  options: QueueRequestOptions,
): Promise<T | NotModifiedResponse> {
  return defaultQueue.enqueueRequest((init) => request(init), options);
}
