import { describe, expect, it } from 'vitest';
import { createBreakerRegistry } from '../src/breaker.js';
import { ManualClock } from '../src/clock.js';
import { defaultHedge } from '../src/resolve.js';
import { percentile } from '../src/latency.js';
import { scriptedModel } from './support.js';

const config = {
  failureThreshold: 2,
  successThreshold: 2,
  openDurationMs: 1_000,
  halfOpenMaxInFlight: 1,
  countRateLimits: true,
};

describe('circuit breaker', () => {
  it('walks closed, open, half-open, and back', async () => {
    const clock = new ManualClock();
    const events: string[] = [];
    const registry = createBreakerRegistry(config, clock, defaultHedge);
    registry.subscribe((event) => events.push(`${event.from}->${event.to}`));
    const { model } = scriptedModel('openai', 'gpt', []);
    const breaker = registry.acquire(model);

    expect(breaker.tryAcquire()).toBe('allow');
    breaker.recordFailure('allow');
    expect(registry.snapshot()[0]).toMatchObject({ state: 'closed', consecutiveFailures: 1 });
    breaker.recordSuccess('allow');
    expect(registry.snapshot()[0]?.consecutiveFailures).toBe(0);
    breaker.recordFailure('allow');
    breaker.recordFailure('allow');
    expect(registry.snapshot()[0]?.state).toBe('open');
    expect(breaker.tryAcquire()).toBe('reject');

    await clock.advance(999);
    expect(breaker.tryAcquire()).toBe('reject');
    await clock.advance(1);
    expect(breaker.tryAcquire()).toBe('probe');
    expect(breaker.tryAcquire()).toBe('reject');
    breaker.recordSuccess('probe');
    expect(registry.snapshot()[0]?.state).toBe('half-open');

    expect(breaker.tryAcquire()).toBe('probe');
    breaker.recordFailure('probe');
    expect(registry.snapshot()[0]?.state).toBe('open');

    await clock.advance(1_000);
    expect(breaker.tryAcquire()).toBe('probe');
    breaker.recordSuccess('probe');
    expect(breaker.tryAcquire()).toBe('probe');
    breaker.recordSuccess('probe');
    expect(registry.snapshot()[0]?.state).toBe('closed');
    expect(events).toContain('closed->open');
    expect(events).toContain('open->half-open');
    expect(events).toContain('half-open->closed');
  });

  it('releases a probe without tripping when the attempt is cancelled', async () => {
    const clock = new ManualClock();
    const registry = createBreakerRegistry(config, clock, defaultHedge);
    const { model } = scriptedModel('anthropic', 'claude', []);
    const breaker = registry.acquire(model);
    breaker.recordFailure('allow');
    breaker.recordFailure('allow');
    await clock.advance(1_000);
    expect(breaker.tryAcquire()).toBe('probe');
    breaker.recordRelease('probe');
    expect(breaker.tryAcquire()).toBe('probe');
    breaker.recordRelease('allow');
    expect(registry.snapshot()[0]?.state).toBe('half-open');
  });

  it('computes a nearest-rank percentile', () => {
    expect(percentile([], 95)).toBeUndefined();
    expect(percentile([10, 20, 30, 100], 95)).toBe(100);
    expect(percentile([10, 20, 30, 100], 50)).toBe(20);
  });
});
