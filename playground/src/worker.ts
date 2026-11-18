import { APICallError, type LanguageModelV4, type LanguageModelV4Usage } from '@ai-sdk/provider';
import { generateText } from 'ai';
import {
  createBreakerRegistry,
  createResilientModel,
  defaultBreaker,
  defaultHedge,
  systemClock,
} from '../../dist/index.js';
import type { ResilienceEvent } from '../../dist/index.js';
import { page } from './page.js';

interface ProviderSpec {
  provider: string;
  modelId: string;
  failureRate: number;
  latencyMs: number;
}

interface RunBody {
  batchSize: number;
  hedge: boolean;
  providers: ProviderSpec[];
}

const encoder = new TextEncoder();

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(page, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/run') {
      return runBatch(request);
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
};

async function runBatch(request: Request): Promise<Response> {
  let body: RunBody;
  try {
    body = validate(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request';
    return Response.json({ error: message }, { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (value: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      };
      try {
        await execute(body, send);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Batch failed';
        send({ type: 'error', message });
        console.log(JSON.stringify({ level: 'error', msg: 'batch.failed', message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function execute(body: RunBody, send: (value: unknown) => void): Promise<void> {
  const models = body.providers.map((spec) => chaosModel(spec));
  const hedgeDelayMs = Math.max(40, Math.round((body.providers[0]?.latencyMs ?? 80) * 0.75));
  const registry = createBreakerRegistry(
    { ...defaultBreaker, failureThreshold: 3, openDurationMs: 1_500 },
    systemClock,
    { ...defaultHedge, enabled: body.hedge, delayMs: hedgeDelayMs, minMs: 30, maxMs: 400 },
  );
  const traces: ResilienceEvent[] = [];
  let currentRequest = 0;
  const model = createResilientModel({
    models,
    registry,
    retry: { maxAttempts: 2, initialDelayMs: 25, maxDelayMs: 90, multiplier: 2, maxRetryAfterMs: 150 },
    circuitBreaker: { failureThreshold: 3, successThreshold: 1, openDurationMs: 1_500, halfOpenMaxInFlight: 1 },
    hedge: { enabled: body.hedge, delayMs: hedgeDelayMs, minMs: 30, maxMs: 400 },
    timeoutMs: 220,
    onEvent: (event) => {
      traces.push(event);
      send({ type: 'trace', request: currentRequest, event, breakers: registry.snapshot() });
    },
  });

  const startedAt = Date.now();
  const latencies: number[] = [];
  let successes = 0;

  for (let index = 0; index < body.batchSize; index += 1) {
    currentRequest = index;
    const t0 = Date.now();
    try {
      const result = await generateText({ model, prompt: 'Say hello in five words.', maxRetries: 0 });
      const latencyMs = Date.now() - t0;
      latencies.push(latencyMs);
      successes += 1;
      send({ type: 'result', request: index, ok: true, text: result.text, latencyMs, usage: result.usage });
    } catch (error) {
      const latencyMs = Date.now() - t0;
      latencies.push(latencyMs);
      send({
        type: 'result',
        request: index,
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 140) : 'failed',
        latencyMs,
      });
    }
  }

  const summary = {
    type: 'summary',
    successRate: successes / body.batchSize,
    p95Ms: percentile(latencies, 95),
    retries: traces.filter((event) => event.type === 'retry').length,
    failovers: traces.filter((event) => event.type === 'fallback').length,
    hedges: traces.filter((event) => event.type === 'hedge-start').length,
    breakerOpens: traces.filter((event) => event.type === 'breaker' && event.to === 'open').length,
    elapsedMs: Date.now() - startedAt,
  };
  send(summary);
  console.log(JSON.stringify({ level: 'info', msg: 'batch.complete', ...summary, providers: body.providers.length }));
}

function validate(input: unknown): RunBody {
  if (!input || typeof input !== 'object') throw new Error('Expected a JSON object');
  const record = input as Record<string, unknown>;
  if ('apiKey' in record || 'api_key' in record || 'authorization' in record) {
    throw new Error('This playground does not accept API keys');
  }
  const batchSize = clampInt(record.batchSize, 4, 12, 8);
  const hedge = record.hedge !== false;
  if (!Array.isArray(record.providers) || record.providers.length < 2 || record.providers.length > 3) {
    throw new Error('Provide two or three mock providers');
  }
  const providers = record.providers.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error('Provider spec is invalid');
    const spec = item as Record<string, unknown>;
    const provider = typeof spec.provider === 'string' ? spec.provider.slice(0, 40) : `provider-${index}`;
    const modelId = typeof spec.modelId === 'string' ? spec.modelId.slice(0, 60) : `model-${index}`;
    return {
      provider,
      modelId,
      failureRate: clampNumber(spec.failureRate, 0, 0.9, 0.2),
      latencyMs: clampInt(spec.latencyMs, 20, 400, 80),
    };
  });
  return { batchSize, hedge, providers };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function chaosModel(spec: ProviderSpec): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: spec.provider,
    modelId: spec.modelId,
    supportedUrls: {},
    async doGenerate(options) {
      await sleep(spec.latencyMs, options.abortSignal);
      if (Math.random() < spec.failureRate) throw chaosError();
      return {
        content: [{ type: 'text', text: `hello from ${spec.modelId}` }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: usage(12, 6),
        warnings: [],
      };
    },
    async doStream(options) {
      await sleep(Math.min(spec.latencyMs, 80), options.abortSignal);
      if (Math.random() < spec.failureRate) throw chaosError();
      const parts = [
        { type: 'stream-start' as const, warnings: [] },
        { type: 'text-start' as const, id: 't' },
        { type: 'text-delta' as const, id: 't', delta: `hello from ${spec.modelId}` },
        { type: 'text-end' as const, id: 't' },
        { type: 'finish' as const, usage: usage(12, 6), finishReason: { unified: 'stop' as const, raw: 'stop' } },
      ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

function chaosError(): Error {
  const roll = Math.random();
  if (roll < 0.34) {
    const error = new Error('upstream timeout');
    error.name = 'TimeoutError';
    return error;
  }
  if (roll < 0.7) {
    return new APICallError({
      message: 'HTTP 429',
      url: 'https://mock.invalid/v1',
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: true,
      ...(Math.random() < 0.5 ? { responseHeaders: { 'retry-after': '0.08' } } : {}),
    });
  }
  return new APICallError({
    message: roll < 0.85 ? 'HTTP 500' : 'HTTP 503',
    url: 'https://mock.invalid/v1',
    requestBodyValues: {},
    statusCode: roll < 0.85 ? 500 : 503,
    isRetryable: true,
  });
}

function usage(input: number, output: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return Math.round(sorted[rank - 1] ?? 0);
}
