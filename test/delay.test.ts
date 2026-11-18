import { describe, expect, it } from 'vitest';
import { computeDelay, parseDuration, retryDelayFromHeaders } from '../src/delay.js';
import { defaultRetry } from '../src/resolve.js';

describe('backoff and rate-limit headers', () => {
  it('uses full jitter inside the exponential cap', () => {
    const retry = { ...defaultRetry, initialDelayMs: 100, maxDelayMs: 1000, multiplier: 2 };
    expect(computeDelay(0, retry, () => 0, undefined)).toEqual({ delayMs: 0, source: 'backoff', capped: false });
    expect(computeDelay(0, retry, () => 0.5, undefined).delayMs).toBe(50);
    expect(computeDelay(1, retry, () => 1, undefined).delayMs).toBe(200);
    expect(computeDelay(20, retry, () => 1, undefined).delayMs).toBe(1000);
  });

  it('honors Retry-After over a shorter backoff and caps a huge reset', () => {
    const retry = { ...defaultRetry, initialDelayMs: 100, maxDelayMs: 10_000, maxRetryAfterMs: 1_000 };
    const waited = computeDelay(0, retry, () => 0, 2_000);
    expect(waited).toEqual({ delayMs: 1_000, source: 'retry-after', capped: true });
    const longerBackoff = computeDelay(0, { ...retry, maxRetryAfterMs: 30_000 }, () => 1, 50);
    expect(longerBackoff.source).toBe('backoff');
    expect(longerBackoff.delayMs).toBe(100);
  });

  it('parses durations and provider reset headers', () => {
    expect(parseDuration('6m0s')).toBe(360_000);
    expect(parseDuration('200ms')).toBe(200);
    expect(parseDuration('1.5s')).toBe(1_500);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('nope')).toBeUndefined();
    expect(parseDuration('')).toBeUndefined();

    const now = 1_700_000_000_000;
    expect(retryDelayFromHeaders({ 'Retry-After': '2' }, now)).toBe(2_000);
    expect(retryDelayFromHeaders({ 'retry-after-ms': '250' }, now)).toBe(250);
    expect(retryDelayFromHeaders({ 'x-ratelimit-reset-requests': '1s' }, now)).toBe(1_000);
    expect(retryDelayFromHeaders({ 'x-ratelimit-reset-tokens': '6m0s' }, now)).toBe(360_000);
    expect(retryDelayFromHeaders({ 'x-ratelimit-reset': String(Math.floor(now / 1000) + 5) }, now)).toBe(5_000);
    expect(retryDelayFromHeaders({ 'anthropic-ratelimit-requests-reset': new Date(now + 4_000).toISOString() }, now)).toBe(4_000);
    expect(
      retryDelayFromHeaders(
        {
          'retry-after': '1',
          'x-ratelimit-reset-requests': '3s',
        },
        now,
      ),
    ).toBe(3_000);
    expect(retryDelayFromHeaders({ 'retry-after': new Date(now + 2_000).toUTCString() }, now)).toBe(2_000);
    expect(retryDelayFromHeaders(undefined, now)).toBeUndefined();
    expect(retryDelayFromHeaders({ 'x-unrelated': '1' }, now)).toBeUndefined();
    expect(retryDelayFromHeaders({ 'retry-after': 'soon' }, now)).toBeUndefined();
  });

  it('treats a past reset as zero wait', () => {
    const now = 1_700_000_000_000;
    expect(retryDelayFromHeaders({ 'x-ratelimit-reset': String(now - 5_000) }, now)).toBe(0);
  });
});
