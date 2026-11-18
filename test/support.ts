import { APICallError, type LanguageModelV4, type LanguageModelV4CallOptions, type LanguageModelV4GenerateResult, type LanguageModelV4StreamPart, type LanguageModelV4Usage } from '@ai-sdk/provider';
import { generateText } from 'ai';
import { flushMicrotasks, ManualClock } from '../src/clock.js';
import { createBreakerRegistry } from '../src/breaker.js';
import { createResilientModel } from '../src/index.js';
import { resolveOptions } from '../src/resolve.js';
import type { ResilienceEvent, ResilientModelOptions } from '../src/types.js';

export function tokens(input: number, output: number, reasoning = 0): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: Math.max(0, input), cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: Math.max(0, output - reasoning), reasoning },
  };
}

export function textResult(text: string, usage: LanguageModelV4Usage = tokens(11, text.length)): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  };
}

export function httpError(status: number, headers?: Record<string, string>, message = `HTTP ${status}`): APICallError {
  return new APICallError({
    message,
    url: 'https://example.invalid/v1/messages',
    requestBodyValues: {},
    statusCode: status,
    ...(headers ? { responseHeaders: headers } : {}),
    isRetryable: status === 408 || status === 429 || status >= 500,
  });
}

export function userPrompt(text = 'hi'): LanguageModelV4CallOptions['prompt'] {
  return [{ role: 'user', content: [{ type: 'text', text }] }];
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export type Step =
  | { type: 'text'; text: string; usage?: LanguageModelV4Usage }
  | { type: 'throw'; error: unknown }
  | { type: 'hang' }
  | { type: 'defer'; deferred: Deferred<LanguageModelV4GenerateResult> }
  | { type: 'stream'; parts: LanguageModelV4StreamPart[] }
  | { type: 'stream-error'; error: unknown };

export interface Script {
  model: LanguageModelV4;
  calls: LanguageModelV4CallOptions[];
}

export function scriptedModel(provider: string, modelId: string, steps: Step[]): Script {
  const calls: LanguageModelV4CallOptions[] = [];
  let cursor = 0;
  const take = (): Step => {
    const step = steps[Math.min(cursor, Math.max(0, steps.length - 1))];
    cursor += 1;
    if (!step) throw new Error(`No scripted step for ${provider}/${modelId}`);
    return step;
  };

  const model: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider,
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      calls.push(options);
      const step = take();
      if (step.type === 'hang') return abortAsPromise(options.abortSignal);
      if (step.type === 'defer') {
        return Promise.race([step.deferred.promise, abortAsPromise(options.abortSignal)]);
      }
      if (step.type === 'throw' || step.type === 'stream-error') throw step.error;
      if (step.type === 'stream') return textResult('stream-as-generate');
      return textResult(step.text, step.usage);
    },
    async doStream(options) {
      calls.push(options);
      const step = take();
      if (step.type === 'hang') await abortAsPromise(options.abortSignal);
      if (step.type === 'throw' || step.type === 'stream-error') {
        if (step.type === 'throw') throw step.error;
      }
      if (step.type === 'defer') {
        const generated = await Promise.race([step.deferred.promise, abortAsPromise(options.abortSignal)]);
        const text = generated.content.find((part) => part.type === 'text');
        return {
          stream: fromParts(successParts(text && text.type === 'text' ? text.text : 'ok', generated.usage)),
        };
      }
      if (step.type === 'stream') return { stream: fromParts(step.parts) };
      if (step.type === 'stream-error') return { stream: fromParts(errorParts(step.error)) };
      return { stream: fromParts(successParts(step.type === 'text' ? step.text : 'ok', step.type === 'text' ? step.usage : undefined)) };
    },
  };

  return { model, calls };
}

function abortAsPromise(signal?: AbortSignal): Promise<never> {
  if (!signal) return new Promise(() => undefined);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

export function successParts(text: string, usage: LanguageModelV4Usage = tokens(5, text.length)): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
  ];
}

export function errorParts(error: unknown, partial = 'Hello', usage?: LanguageModelV4Usage): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: partial },
  ];
  if (usage) {
    parts.push({ type: 'finish', usage, finishReason: { unified: 'error', raw: 'error' } });
  }
  parts.push({ type: 'error', error });
  return parts;
}

function fromParts(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

export async function readParts(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<LanguageModelV4StreamPart[]> {
  const reader = stream.getReader();
  const parts: LanguageModelV4StreamPart[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
  }
  return parts;
}

export interface Harness {
  clock: ManualClock;
  events: ResilienceEvent[];
  model: LanguageModelV4;
  registry: ReturnType<typeof createBreakerRegistry>;
}

export function harness(options: ResilientModelOptions & { random?: () => number }): Harness {
  const clock = (options.clock as ManualClock | undefined) ?? new ManualClock();
  const random = options.random ?? (() => 0);
  const resolved = resolveOptions({ ...options, clock, random });
  const registry =
    (options.registry as ReturnType<typeof createBreakerRegistry> | undefined) ??
    createBreakerRegistry(resolved.circuitBreaker, clock, resolved.hedge);
  const events: ResilienceEvent[] = [];
  const model = createResilientModel({
    ...options,
    clock,
    random,
    registry,
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
  });
  return { clock, events, model, registry };
}

export async function runWithClock<T>(clock: ManualClock, start: () => PromiseLike<T>): Promise<T> {
  let settled = false;
  let failed = false;
  let value!: T;
  let failure: unknown;
  const promise = Promise.resolve(start()).then(
    (next) => {
      settled = true;
      value = next;
    },
    (error: unknown) => {
      settled = true;
      failed = true;
      failure = error;
    },
  );
  let idle = 0;
  for (let i = 0; i < 200 && !settled; i += 1) {
    await flushMicrotasks();
    if (settled) break;
    if (clock.pending > 0) {
      idle = 0;
      await clock.advanceAll();
    } else {
      idle += 1;
      if (idle > 6) break;
    }
  }
  await promise;
  if (failed) throw failure;
  return value;
}

export async function generate(model: LanguageModelV4, prompt = 'hi'): Promise<Awaited<ReturnType<typeof generateText>>> {
  return generateText({ model, prompt, maxRetries: 0 });
}
