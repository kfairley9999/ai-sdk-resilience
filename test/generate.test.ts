import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';
import { flushMicrotasks } from '../src/clock.js';
import { ResilienceError } from '../src/errors.js';
import { createResilientModel } from '../src/index.js';
import {
  errorParts,
  generate,
  harness,
  httpError,
  readParts,
  runWithClock,
  scriptedModel,
  successParts,
  tokens,
  userPrompt,
} from './support.js';

describe('generate retries, fallback, and fatal errors', () => {
  it('retries a 500 and reports only the winning usage', async () => {
    const primary = scriptedModel('openai', 'gpt', [
      { type: 'throw', error: Object.assign(httpError(500), { usage: tokens(9, 4) }) },
      { type: 'text', text: 'recovered', usage: tokens(9, 6) },
    ]);
    const { model, clock, events } = harness({
      models: [primary.model],
      retry: { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 1_000, multiplier: 2 },
      random: () => 0.5,
    });
    const result = await runWithClock(clock, () => model.doGenerate({ prompt: userPrompt() }));
    expect(result.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(result.usage.outputTokens.total).toBe(6);
    expect(result.providerMetadata?.['ai-sdk-resilience']).toMatchObject({
      reportedUsage: { outputTokens: 6 },
      billedUsage: { outputTokens: 10 },
    });
    expect(primary.calls).toHaveLength(2);
    expect(events.some((event) => event.type === 'retry' && event.delayMs === 50 && event.source === 'backoff')).toBe(true);
  });

  it('waits for Retry-After and rate-limit reset headers', async () => {
    const primary = scriptedModel('openai', 'gpt', [
      { type: 'throw', error: httpError(429, { 'retry-after': '2', 'x-ratelimit-reset-requests': '1s' }) },
      { type: 'text', text: 'after-limit' },
    ]);
    const { model, clock, events } = harness({ models: [primary.model], random: () => 0 });
    const pending = model.doGenerate({ prompt: userPrompt() });
    await flushMicrotasks();
    await clock.advanceAll();
    const result = await pending;
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'after-limit' });
    const retry = events.find((event) => event.type === 'retry');
    expect(retry).toMatchObject({ delayMs: 2_000, source: 'retry-after', capped: false });
    expect(clock.now()).toBeGreaterThanOrEqual(2_000);
  });

  it('caps a long Retry-After', async () => {
    const primary = scriptedModel('openai', 'gpt', [
      { type: 'throw', error: httpError(429, { 'retry-after': '120' }) },
      { type: 'text', text: 'capped' },
    ]);
    const { model, clock, events } = harness({
      models: [primary.model],
      retry: { maxRetryAfterMs: 250 },
      random: () => 0,
    });
    const pending = model.doGenerate({ prompt: userPrompt() });
    await flushMicrotasks();
    await clock.advanceAll();
    await pending;
    expect(events.find((event) => event.type === 'retry')).toMatchObject({ delayMs: 250, capped: true });
  });

  it('does not retry 400, 401, 403, or 422 and does not trip the breaker', async () => {
    for (const status of [400, 401, 403, 422]) {
      const primary = scriptedModel('openai', 'gpt', [{ type: 'throw', error: httpError(status) }]);
      const secondary = scriptedModel('anthropic', 'claude', [{ type: 'text', text: 'nope' }]);
      const { model, registry } = harness({
        models: [primary.model, secondary.model],
        circuitBreaker: { failureThreshold: 1 },
      });
      await expect(model.doGenerate({ prompt: userPrompt() })).rejects.toMatchObject({
        name: 'ResilienceError',
        code: 'fatal',
      });
      expect(primary.calls).toHaveLength(1);
      expect(secondary.calls).toHaveLength(0);
      expect(registry.snapshot()[0]?.state).toBe('closed');
      expect(registry.snapshot()[0]?.consecutiveFailures).toBe(0);
    }
  });

  it('falls back in order after the primary exhausts retries', async () => {
    const primary = scriptedModel('openai', 'gpt', [
      { type: 'throw', error: httpError(503) },
      { type: 'throw', error: httpError(503) },
    ]);
    const secondary = scriptedModel('anthropic', 'claude', [{ type: 'throw', error: httpError(500) }]);
    const tertiary = scriptedModel('google', 'gemini', [{ type: 'text', text: 'third' }]);
    const { model, events } = harness({
      models: [primary.model, secondary.model, tertiary.model],
      retry: { maxAttempts: 2 },
    });
    const result = await generate(model);
    expect(result.text).toBe('third');
    expect(primary.calls).toHaveLength(2);
    expect(secondary.calls).toHaveLength(2);
    expect(tertiary.calls).toHaveLength(1);
    expect(events.filter((event) => event.type === 'fallback')).toHaveLength(2);
  });

  it('retries timeouts and network failures, then surfaces the last error', async () => {
    const network = new TypeError('fetch failed');
    (network as { cause?: unknown }).cause = { code: 'ECONNRESET' };
    const primary = scriptedModel('openai', 'gpt', [
      { type: 'throw', error: httpError(408) },
      { type: 'throw', error: network },
    ]);
    const { model } = harness({ models: [primary.model], retry: { maxAttempts: 2 } });
    await expect(generate(model)).rejects.toBeInstanceOf(ResilienceError);
    expect(primary.calls).toHaveLength(2);
  });

  it('aborts during backoff without a second attempt', async () => {
    const primary = scriptedModel('openai', 'gpt', [
      { type: 'throw', error: httpError(503) },
      { type: 'text', text: 'should-not-run' },
    ]);
    const controller = new AbortController();
    const { model, clock } = harness({
      models: [primary.model],
      retry: { initialDelayMs: 500, maxDelayMs: 500 },
      random: () => 1,
    });
    const pending = generateText({ model, prompt: 'hi', maxRetries: 0, abortSignal: controller.signal });
    for (let i = 0; i < 10 && clock.pending === 0; i += 1) await flushMicrotasks();
    expect(clock.pending).toBeGreaterThan(0);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(primary.calls).toHaveLength(1);
  });

  it('times out a hung attempt and does not treat it as a caller abort', async () => {
    const primary = scriptedModel('openai', 'gpt', [{ type: 'hang' }]);
    const { model, clock, events } = harness({
      models: [primary.model],
      retry: { maxAttempts: 1 },
      timeoutMs: 40,
    });
    const pending = model.doGenerate({ prompt: userPrompt() });
    const outcome = pending.then(
      () => 'ok',
      (error: unknown) => error,
    );
    await flushMicrotasks();
    await clock.advanceAll();
    const error = await outcome;
    expect(error).toMatchObject({ code: 'all-failed' });
    expect(events.some((event) => event.type === 'attempt-failure' && event.classification === 'retryable')).toBe(true);
  });

  it('opens the breaker, fails fast, then probes in half-open', async () => {
    const primary = scriptedModel('openai', 'gpt', [
      { type: 'throw', error: httpError(500) },
      { type: 'throw', error: httpError(500) },
      { type: 'text', text: 'probed' },
    ]);
    const { model, clock, registry, events } = harness({
      models: [primary.model],
      retry: { maxAttempts: 2 },
      circuitBreaker: { failureThreshold: 2, successThreshold: 1, openDurationMs: 5_000 },
    });
    await expect(runWithClock(clock, () => generate(model))).rejects.toMatchObject({ code: 'all-failed' });
    expect(registry.snapshot()[0]?.state).toBe('open');
    await expect(generate(model)).rejects.toMatchObject({ code: 'all-circuits-open' });
    expect(primary.calls).toHaveLength(2);
    expect(events.some((event) => event.type === 'skip')).toBe(true);

    await clock.advance(5_000);
    const result = await generate(model);
    expect(result.text).toBe('probed');
    expect(registry.snapshot()[0]?.state).toBe('closed');
  });

  it('does not let 429s trip the breaker when countRateLimits is false', async () => {
    const primary = scriptedModel('openai', 'gpt', [
      { type: 'throw', error: httpError(429) },
      { type: 'throw', error: httpError(429) },
    ]);
    const { model, registry } = harness({
      models: [primary.model],
      retry: { maxAttempts: 2 },
      circuitBreaker: { failureThreshold: 1, countRateLimits: false },
    });
    await expect(generate(model)).rejects.toMatchObject({ code: 'all-failed' });
    expect(registry.snapshot()[0]?.state).toBe('closed');
  });

  it('honors a custom classifier and a throwing telemetry hook', async () => {
    const primary = scriptedModel('openai', 'gpt', [{ type: 'throw', error: httpError(500) }]);
    const { model } = harness({
      models: [primary.model],
      classify: () => 'fatal',
      onEvent: () => {
        throw new Error('sink down');
      },
    });
    await expect(generate(model)).rejects.toMatchObject({ code: 'fatal' });
    expect(primary.calls).toHaveLength(1);
  });

  it('merges per-model provider options', async () => {
    const primary = scriptedModel('openai', 'gpt', [{ type: 'text', text: 'opts' }]);
    const { model } = harness({
      models: [{ model: primary.model, providerOptions: { openai: { store: false } } }],
    });
    await model.doGenerate({
      prompt: userPrompt(),
      providerOptions: { openai: { user: 'a' }, anthropic: { cache: true } },
    });
    expect(primary.calls[0]?.providerOptions).toEqual({
      openai: { user: 'a', store: false },
      anthropic: { cache: true },
    });
  });

  it('rejects an empty model list and an invalid configuration', () => {
    expect(() => createResilientModel({ models: [] })).toThrow(ResilienceError);
    expect(() => createResilientModel({ models: [scriptedModel('openai', 'gpt', []).model], retry: { maxAttempts: 0 } })).toThrow(
      /maxAttempts/,
    );
    expect(() =>
      createResilientModel({
        models: [scriptedModel('openai', 'gpt', []).model],
        hedge: { percentile: 0 },
      }),
    ).toThrow(/percentile/);
  });

  it('stops when the caller signal is already aborted', async () => {
    const primary = scriptedModel('openai', 'gpt', [{ type: 'text', text: 'no' }]);
    const { model } = harness({ models: [primary.model] });
    await expect(
      model.doGenerate({ prompt: userPrompt(), abortSignal: AbortSignal.abort(new Error('gone')) }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(primary.calls).toHaveLength(0);
  });

});

describe('stream failover', () => {
  it('restarts after a mid-stream error and does not double-count usage', async () => {
    const primary = scriptedModel('openai', 'gpt', [
      { type: 'stream', parts: errorParts(httpError(503), 'Hello', tokens(3, 10)) },
    ]);
    const secondary = scriptedModel('anthropic', 'claude', [
      { type: 'stream', parts: successParts('There', tokens(3, 20)) },
    ]);
    const { model, events } = harness({
      models: [primary.model, secondary.model],
      retry: { maxAttempts: 1 },
      stream: { onError: 'restart' },
    });
    const streamed = await model.doStream({ prompt: userPrompt('hi') });
    const parts = await readParts(streamed.stream);
    const finishes = parts.filter((part) => part.type === 'finish');
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ usage: { outputTokens: { total: 20 } } });
    expect(parts.some((part) => part.type === 'text-delta' && part.delta === 'Hello')).toBe(false);
    expect(parts.some((part) => part.type === 'text-delta' && part.delta === 'There')).toBe(true);
    expect(finishes[0] && 'providerMetadata' in finishes[0] && finishes[0].providerMetadata?.['ai-sdk-resilience']).toMatchObject({
      billedUsage: { outputTokens: 30 },
      reportedUsage: { outputTokens: 20 },
    });
    expect(events.some((event) => event.type === 'stream-failover' && event.mode === 'restart')).toBe(true);
    expect(JSON.stringify(secondary.calls[0]?.prompt)).not.toContain('Hello');
  });

  it('continues from partial text on the next model', async () => {
    const primary = scriptedModel('openai', 'gpt', [
      { type: 'stream', parts: errorParts(httpError(503), 'Hello', tokens(2, 5)) },
    ]);
    const secondary = scriptedModel('anthropic', 'claude', [
      { type: 'stream', parts: successParts(' world', tokens(8, 4)) },
    ]);
    const { model } = harness({
      models: [primary.model, secondary.model],
      retry: { maxAttempts: 1 },
      stream: { onError: 'continue' },
    });
    const streamed = await model.doStream({ prompt: userPrompt('hi') });
    const parts = await readParts(streamed.stream);
    const text = parts
      .filter((part) => part.type === 'text-delta')
      .map((part) => (part.type === 'text-delta' ? part.delta : ''))
      .join('');
    expect(text).toBe('Hello world');
    expect(parts.filter((part) => part.type === 'finish')).toHaveLength(1);
    const prompt = JSON.stringify(secondary.calls[0]?.prompt);
    expect(prompt).toContain('Hello');
    expect(prompt).toContain('Continue exactly');
  });

  it('retries when doStream throws before any bytes', async () => {
    const primary = scriptedModel('openai', 'gpt', [
      { type: 'throw', error: httpError(500) },
      { type: 'text', text: 'later' },
    ]);
    const { model } = harness({ models: [primary.model], retry: { maxAttempts: 2 } });
    const streamed = await model.doStream({ prompt: userPrompt() });
    const parts = await readParts(streamed.stream);
    expect(parts.some((part) => part.type === 'text-delta' && part.delta === 'later')).toBe(true);
  });
});
