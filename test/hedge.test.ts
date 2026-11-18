import type { LanguageModelV4 } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { flushMicrotasks, ManualClock } from '../src/clock.js';
import { deferred, harness, textResult, tokens, userPrompt } from './support.js';

describe('hedged requests', () => {
  it('starts the next model after the delay and cancels the loser', async () => {
    const clock = new ManualClock();
    const primaryGate = deferred<ReturnType<typeof textResult>>();
    const secondaryGate = deferred<ReturnType<typeof textResult>>();
    const primaryCalls: AbortSignal[] = [];
    const secondaryCalls: AbortSignal[] = [];
    const primary = gatedModel('openai', 'gpt', primaryGate, primaryCalls);
    const secondary = gatedModel('anthropic', 'claude', secondaryGate, secondaryCalls);
    const { model, events, registry } = harness({
      models: [primary, secondary],
      clock,
      hedge: { enabled: true, delayMs: 40, minMs: 1 },
      circuitBreaker: { failureThreshold: 1 },
      random: () => 0,
    });

    const pending = model.doGenerate({ prompt: userPrompt() });
    await flushMicrotasks();
    expect(primaryCalls).toHaveLength(1);
    expect(secondaryCalls).toHaveLength(0);

    await clock.advance(39);
    await flushMicrotasks();
    expect(secondaryCalls).toHaveLength(0);

    await clock.advance(1);
    await flushMicrotasks();
    expect(secondaryCalls).toHaveLength(1);
    expect(events.some((event) => event.type === 'hedge-start' && event.delayMs === 40)).toBe(true);

    secondaryGate.resolve(textResult('backup', tokens(2, 7)));
    const result = await pending;
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'backup' });
    expect(result.usage.outputTokens.total).toBe(7);
    expect(primaryCalls[0]?.aborted).toBe(true);
    expect(events.some((event) => event.type === 'hedge-cancel' && event.modelId === 'gpt')).toBe(true);
    expect(registry.snapshot().find((item) => item.key.endsWith('claude'))).toMatchObject({
      state: 'closed',
      consecutiveFailures: 0,
    });
    expect(registry.snapshot().find((item) => item.key.endsWith('gpt'))?.state).not.toBe('open');
  });

  it('tracks a rolling percentile once enough samples exist', async () => {
    const clock = new ManualClock();
    const primarySleeps = [10, 20, 100, 1_000];
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const primary: LanguageModelV4 = {
      specificationVersion: 'v4',
      provider: 'openai',
      modelId: 'gpt',
      supportedUrls: {},
      async doGenerate(options) {
        const wait = primarySleeps[Math.min(primaryCalls, primarySleeps.length - 1)] ?? 0;
        primaryCalls += 1;
        if (wait > 0) await clock.sleep(wait, options.abortSignal);
        return textResult('fast', tokens(1, 1));
      },
      async doStream() {
        throw new Error('unused');
      },
    };
    const secondary: LanguageModelV4 = {
      specificationVersion: 'v4',
      provider: 'anthropic',
      modelId: 'claude',
      supportedUrls: {},
      async doGenerate() {
        secondaryCalls += 1;
        return textResult('hedged', tokens(1, 2));
      },
      async doStream() {
        throw new Error('unused');
      },
    };
    const { model } = harness({
      models: [primary, secondary],
      clock,
      hedge: { enabled: true, delayMs: 10_000, percentile: 95, minSamples: 3, minMs: 1, maxMs: 5_000, sampleSize: 8 },
    });

    for (let i = 0; i < 3; i += 1) {
      const pending = model.doGenerate({ prompt: userPrompt() });
      await flushMicrotasks();
      await clock.advanceAll();
      await pending;
    }
    expect(secondaryCalls).toBe(0);

    const pending = model.doGenerate({ prompt: userPrompt() });
    await flushMicrotasks();
    await clock.advance(99);
    await flushMicrotasks();
    expect(secondaryCalls).toBe(0);
    await clock.advance(1);
    await flushMicrotasks();
    expect(secondaryCalls).toBe(1);
    expect(primaryCalls).toBe(4);
    await pending;
  });
});

function gatedModel(
  provider: string,
  modelId: string,
  gate: ReturnType<typeof deferred<ReturnType<typeof textResult>>>,
  signals: AbortSignal[],
): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider,
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      if (options.abortSignal) signals.push(options.abortSignal);
      return Promise.race([
        gate.promise,
        new Promise<never>((_, reject) => {
          if (!options.abortSignal) return;
          if (options.abortSignal.aborted) reject(options.abortSignal.reason);
          options.abortSignal.addEventListener('abort', () => reject(options.abortSignal?.reason), { once: true });
        }),
      ]);
    },
    async doStream() {
      throw new Error('unused');
    },
  };
}
