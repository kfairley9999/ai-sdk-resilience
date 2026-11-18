import type { Clock } from './types.js';

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal!));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  },
};

interface Waiter {
  due: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Deterministic clock. `sleep` parks until {@link ManualClock.advance} moves time
 * to the deadline, or until the signal aborts.
 */
export class ManualClock implements Clock {
  #now = 0;
  #waiters: Waiter[] = [];

  now(): number {
    return this.#now;
  }

  get pending(): number {
    return this.#waiters.length;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const delay = Math.max(0, ms);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (delay === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        due: this.#now + delay,
        resolve,
        reject,
        signal,
      };
      const onAbort = () => {
        this.#remove(waiter);
        reject(abortReason(signal!));
      };
      waiter.onAbort = onAbort;
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  async advance(ms: number): Promise<void> {
    const target = this.#now + Math.max(0, ms);
    for (;;) {
      const next = this.#waiters
        .filter((waiter) => waiter.due <= target)
        .sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      this.#now = next.due;
      this.#remove(next);
      next.signal?.removeEventListener('abort', next.onAbort!);
      next.resolve();
      await flushMicrotasks();
    }
    this.#now = target;
  }

  /** Advance to each parked deadline until nothing is waiting. */
  async advanceAll(): Promise<void> {
    let guard = 0;
    while (this.#waiters.length > 0 && guard < 10_000) {
      guard += 1;
      const nextDue = Math.min(...this.#waiters.map((waiter) => waiter.due));
      await this.advance(Math.max(0, nextDue - this.#now));
      await flushMicrotasks();
    }
  }

  #remove(waiter: Waiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index >= 0) this.#waiters.splice(index, 1);
  }
}

export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 24; i += 1) await Promise.resolve();
}
