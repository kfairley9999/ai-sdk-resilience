import { wrapLanguageModel } from 'ai';
import { describe, expect, it } from 'vitest';
import { createBreakerRegistry } from '../src/breaker.js';
import { headersOf, statusOf } from '../src/classify.js';
import { ManualClock } from '../src/clock.js';
import { computeDelay, retryDelayFromHeaders } from '../src/delay.js';
import { errorMessage, isAttemptTimeout, isCallSettled, isHedgeCancelled } from '../src/errors.js';
import { createResilienceMiddleware, createResilientModel } from '../src/index.js';
import { LatencyWindow } from '../src/latency.js';
import { defaultHedge, defaultRetry, mergeProviderOptions } from '../src/resolve.js';
import { assembleStream, readModelStream, textFromParts } from '../src/stream.js';
import { emptyUsage } from '../src/usage.js';
import { httpError, scriptedModel, tokens, userPrompt } from './support.js';

describe('remaining branches', () => {
  it('reads loose statuses, headers, and error messages', () => {
    expect(statusOf(null)).toBeUndefined();
    expect(statusOf('x')).toBeUndefined();
    expect(statusOf({ status_code: 503 })).toBe(503);
    expect(statusOf({ status: '503' })).toBeUndefined();
    expect(headersOf(null)).toBeUndefined();
    expect(headersOf(httpError(500))).toBeUndefined();
    expect(headersOf({ headers: ['nope'] })).toBeUndefined();
    expect(headersOf({ responseHeaders: { a: '1', b: 2 } })).toEqual({ a: '1' });
    expect(errorMessage('short')).toBe('short');
    expect(errorMessage(12)).toBe('Unknown error');
    expect(errorMessage('x'.repeat(400)).length).toBe(300);
    const timeout = new Error('t');
    timeout.name = 'AttemptTimeoutError';
    const hedge = new Error('h');
    hedge.name = 'HedgeCancelledError';
    const settled = new Error('s');
    settled.name = 'CallSettledError';
    expect(isAttemptTimeout(timeout)).toBe(true);
    expect(isHedgeCancelled(hedge)).toBe(true);
    expect(isCallSettled(settled)).toBe(true);
  });

  it('parses millisecond timestamps, blank headers, and a NaN jitter draw', () => {
    const now = 1_700_000_000_000;
    expect(retryDelayFromHeaders({ 'x-ratelimit-reset': String(now + 2_500) }, now)).toBe(2_500);
    expect(retryDelayFromHeaders({ 'retry-after': '   ' }, now)).toBe(0);
    expect(retryDelayFromHeaders({ 'x-ratelimit-reset': '   ' }, now)).toBeUndefined();
    expect(computeDelay(0, { ...defaultRetry }, () => Number.NaN, undefined).delayMs).toBe(0);
    expect(computeDelay(0, { ...defaultRetry, initialDelayMs: -5, maxDelayMs: 10 }, () => 1, -10).delayMs).toBe(0);
  });

  it('drops bad latency samples and evicts old ones', () => {
    const window = new LatencyWindow(2);
    window.record(Number.NaN);
    window.record(-4);
    window.record(5);
    window.record(9);
    window.record(12);
    expect(window.size).toBe(2);
    expect(window.value(100)).toBe(12);
  });

  it('unsubscribes breaker listeners and skips a percentile with no samples', () => {
    const clock = new ManualClock();
    const registry = createBreakerRegistry(
      { failureThreshold: 2, successThreshold: 1, openDurationMs: 10, halfOpenMaxInFlight: 1, countRateLimits: true },
      clock,
      defaultHedge,
    );
    let seen = 0;
    const stop = registry.subscribe(() => {
      seen += 1;
    });
    stop();
    const { model } = scriptedModel('openai', 'gpt', []);
    const breaker = registry.acquire(model);
    breaker.recordFailure('allow');
    breaker.recordFailure('allow');
    expect(seen).toBe(0);
    expect(registry.hedgeDelay(model, { ...defaultHedge, percentile: 95, minSamples: 5 })).toBe(defaultHedge.delayMs);
  });

  it('merges provider options that are not objects', () => {
    const merged = mergeProviderOptions(
      { openai: 'skip' as never },
      { openai: { store: false } },
    );
    expect(merged?.openai).toEqual({ store: false });
  });

  it('builds a finish part when the winner stream omitted one', () => {
    const usage = tokens(1, 2);
    const parts = assembleStream(
      [{ type: 'reasoning-start', id: 'r' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Hi' }],
      [{ type: 'stream-start', warnings: [] }, { type: 'text-delta', id: 't', delta: '!' }],
      usage,
      { reported: usage, billed: emptyUsage(), attempts: [], winner: { provider: 'openai', modelId: 'gpt' } },
    );
    expect(textFromParts(parts)).toBe('Hi!');
    expect(parts.filter((part) => part.type === 'finish')).toHaveLength(1);
    expect(parts.some((part) => part.type === 'reasoning-end')).toBe(true);
    expect(parts.some((part) => part.type === 'text-end')).toBe(true);
  });

  it('surfaces a thrown stream read and an already-aborted attempt', async () => {
    const thrown = await readModelStream(
      new ReadableStream({
        pull() {
          throw new Error('boom');
        },
        cancel() {
          throw new Error('cancel failed');
        },
      }),
      new AbortController().signal,
    );
    expect(thrown.error).toBeInstanceOf(Error);

    const aborted = await readModelStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'x' });
          controller.close();
        },
      }),
      AbortSignal.abort(new Error('stop')),
    );
    expect((aborted.error as Error).message).toBe('stop');
  });

  it('creates a model without an external registry and ignores a throwing hook', async () => {
    const primary = scriptedModel('openai', 'gpt', [{ type: 'throw', error: 'plain failure' }]);
    const clock = new ManualClock();
    const wrapped = createResilientModel({
      models: [primary.model],
      clock,
      random: () => 0,
      retry: { maxAttempts: 1 },
      circuitBreaker: { failureThreshold: 1 },
      providerId: 'resilience-test',
      modelId: 'primary',
      onEvent: () => {
        throw new Error('telemetry down');
      },
    });
    await expect(wrapped.doGenerate({ prompt: userPrompt() })).rejects.toMatchObject({ code: 'all-failed' });
    expect(wrapped.provider).toBe('resilience-test');
    expect(wrapped.modelId).toBe('primary');

    const secondary = scriptedModel('anthropic', 'claude', [{ type: 'throw', error: { nope: true } }]);
    const viaMiddleware = wrapLanguageModel({
      model: secondary.model,
      middleware: createResilienceMiddleware({
        models: [secondary.model],
        clock,
        random: () => 0,
        retry: { maxAttempts: 1 },
        onEvent: () => {
          throw new Error('hook');
        },
      }),
    });
    await expect(viaMiddleware.doGenerate({ prompt: userPrompt() })).rejects.toBeTruthy();
  });
});
