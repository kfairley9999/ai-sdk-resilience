import { generateObject, generateText, streamObject, streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ResilienceError } from '../src/errors.js';
import { harness, httpError, scriptedModel, successParts, tokens } from './support.js';

describe('AI SDK entry points', () => {
  it('serves generateText and streamText through the wrapped model', async () => {
    const primary = scriptedModel('openai', 'gpt', [
      { type: 'throw', error: httpError(503) },
      { type: 'text', text: 'hello from the backup', usage: tokens(12, 8) },
    ]);
    const secondary = scriptedModel('anthropic', 'claude', [
      { type: 'text', text: 'hello from the backup', usage: tokens(12, 8) },
    ]);
    const generated = harness({
      models: [primary.model, secondary.model],
      retry: { maxAttempts: 1 },
    });
    const text = await generateText({ model: generated.model, prompt: 'Say hello', maxRetries: 0 });
    expect(text.text).toBe('hello from the backup');
    expect(text.usage.outputTokens).toBe(8);
    expect(text.usage.totalTokens).toBe(20);
    expect(primary.calls).toHaveLength(1);
    expect(secondary.calls).toHaveLength(1);

    const streamPrimary = scriptedModel('openai', 'gpt', [{ type: 'stream', parts: successParts('streamed hello', tokens(4, 3)) }]);
    const streamed = harness({ models: [streamPrimary.model] });
    const stream = streamText({ model: streamed.model, prompt: 'Say hello', maxRetries: 0 });
    expect(await stream.text).toBe('streamed hello');
    expect((await stream.usage).outputTokens).toBe(3);
  });

  it('serves generateObject and streamObject', async () => {
    const schema = z.object({ city: z.string() });
    const model = scriptedModel('openai', 'gpt', [{ type: 'text', text: '{"city":"Lisbon"}', usage: tokens(6, 5) }]);
    const generated = harness({ models: [model.model] });
    const object = await generateObject({
      model: generated.model,
      schema,
      prompt: 'Name a coastal city as JSON.',
      maxRetries: 0,
    });
    expect(object.object.city).toBe('Lisbon');
    expect(object.usage.outputTokens).toBe(5);

    const streamModel = scriptedModel('anthropic', 'claude', [
      { type: 'stream', parts: successParts('{"city":"Kyoto"}', tokens(6, 4)) },
    ]);
    const streamed = harness({ models: [streamModel.model] });
    const stream = streamObject({
      model: streamed.model,
      schema,
      prompt: 'Name a city as JSON.',
      maxRetries: 0,
    });
    for await (const partial of stream.partialObjectStream) {
      if (partial.city) expect(partial.city.length).toBeGreaterThan(0);
    }
    expect((await stream.object).city).toBe('Kyoto');
  });

  it('preserves a fatal error through generateText', async () => {
    const model = scriptedModel('openai', 'gpt', [{ type: 'throw', error: httpError(401) }]);
    const wrapped = harness({ models: [model.model] });
    await expect(generateText({ model: wrapped.model, prompt: 'hi', maxRetries: 0 })).rejects.toBeInstanceOf(ResilienceError);
  });
});
