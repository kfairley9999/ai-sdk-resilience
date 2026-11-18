import { APICallError, type LanguageModelV4, type LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { generateText } from 'ai';
import { createFallback } from 'ai-fallback';
import {
  circuitBreaker,
  ConsecutiveBreaker,
  ExponentialBackoff,
  handleWhen,
  noJitterGenerator,
  retry,
  wrap,
} from 'cockatiel';
import { writeFileSync } from 'node:fs';
import { createResilientModel } from '../src/index.js';

/**
 * Mock-provider benchmark. Same seeded failure plan for every strategy.
 * Delays are real timers, so the p95 numbers are measurements, not estimates.
 *
 * Requests 24–31 are a hard primary outage (every attempt returns 500) so a
 * circuit breaker has something to open on.
 */

const REQUESTS = 60;
const SEED = 20261118;

type Kind = 'ok' | 'slow' | 'http-500' | 'http-429' | 'timeout';

interface Fate {
  kind: Kind;
  delayMs: number;
  retryAfterMs?: number;
}

const plan: Fate[][][] = [];

for (let request = 0; request < REQUESTS; request += 1) {
  const models: Fate[][] = [];
  for (let model = 0; model < 3; model += 1) {
    const attempts: Fate[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      attempts.push(fateFor(request, model, attempt));
    }
    models.push(attempts);
  }
  plan.push(models);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fateFor(request: number, model: number, attempt: number): Fate {
  if (request >= 24 && request <= 31 && model === 0) {
    return { kind: 'http-500', delayMs: 12 };
  }
  const rng = mulberry32(SEED + request * 997 + model * 131 + attempt * 17);
  const roll = rng();
  const failRate = model === 0 ? (attempt === 0 ? 0.42 : attempt === 1 ? 0.12 : 0.05) : model === 1 ? 0.16 : 0.04;
  if (roll < failRate) {
    const kindRoll = rng();
    if (kindRoll < 0.45) return { kind: 'http-500', delayMs: 6 };
    if (kindRoll < 0.75) return { kind: 'http-429', delayMs: 5, retryAfterMs: rng() < 0.5 ? 12 : undefined };
    return { kind: 'timeout', delayMs: 40 };
  }
  if (model === 0 && attempt === 0 && rng() < 0.22) return { kind: 'slow', delayMs: 48 };
  const base = model === 0 ? 8 : model === 1 ? 14 : 11;
  return { kind: 'ok', delayMs: base + Math.floor(rng() * 6) };
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
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function failure(fate: Fate): Error {
  if (fate.kind === 'timeout') {
    const error = new Error('upstream timeout');
    error.name = 'TimeoutError';
    return error;
  }
  const status = fate.kind === 'http-429' ? 429 : 500;
  return new APICallError({
    message: `HTTP ${status}`,
    url: 'https://example.invalid/v1',
    requestBodyValues: {},
    statusCode: status,
    isRetryable: true,
    ...(fate.retryAfterMs != null ? { responseHeaders: { 'retry-after': String(fate.retryAfterMs / 1000) } } : {}),
  });
}

function okResult(): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text: 'ok' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
    warnings: [],
  };
}

function makeModel(label: string, modelIndex: number, requestRef: { current: number }, attempts: Map<string, number>): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: label,
    modelId: `bench-${label}`,
    supportedUrls: {},
    async doGenerate(options) {
      const key = `${requestRef.current}:${modelIndex}`;
      const attempt = attempts.get(key) ?? 0;
      attempts.set(key, attempt + 1);
      const fate = plan[requestRef.current]?.[modelIndex]?.[Math.min(attempt, 2)];
      if (!fate) throw new Error('missing fate');
      await sleep(fate.delayMs, options.abortSignal);
      if (fate.kind === 'ok' || fate.kind === 'slow') return okResult();
      throw failure(fate);
    },
    async doStream() {
      throw new Error('benchmark uses generateText');
    },
  };
}

interface Sample {
  ok: boolean;
  ms: number;
}

async function time(run: () => Promise<unknown>): Promise<Sample> {
  const started = performance.now();
  try {
    await run();
    return { ok: true, ms: performance.now() - started };
  } catch {
    return { ok: false, ms: performance.now() - started };
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return round(sorted[rank - 1] ?? 0);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function summarize(samples: Sample[]) {
  const ok = samples.filter((sample) => sample.ok);
  const all = samples.map((sample) => sample.ms);
  const success = ok.map((sample) => sample.ms);
  return {
    requests: samples.length,
    successes: ok.length,
    successRate: round(ok.length / samples.length),
    p50Ms: percentile(success, 50),
    p95Ms: percentile(success, 95),
    p99Ms: percentile(success, 99),
    meanSuccessMs: round(success.reduce((sum, value) => sum + value, 0) / Math.max(1, success.length)),
    p95AllMs: percentile(all, 95),
  };
}

async function runStrategy(name: string, create: (requestRef: { current: number }, attempts: Map<string, number>) => LanguageModelV4): Promise<Sample[]> {
  const requestRef = { current: 0 };
  const attempts = new Map<string, number>();
  const model = create(requestRef, attempts);
  const samples: Sample[] = [];
  for (let request = 0; request < REQUESTS; request += 1) {
    requestRef.current = request;
    samples.push(await time(() => generateText({ model, prompt: 'Reply with ok.', maxRetries: 0 })));
  }
  console.log(name, summarize(samples));
  return samples;
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = 'statusCode' in error ? (error as { statusCode?: number }).statusCode : undefined;
  if (status === 429 || status === 408 || (status != null && status >= 500)) return true;
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AttemptTimeoutError');
}

const primaryOnly = async () =>
  runStrategy('plain', (requestRef, attempts) => makeModel('primary', 0, requestRef, attempts));

const fallback = async () =>
  runStrategy('ai-fallback', (requestRef, attempts) =>
    createFallback({
      models: [makeModel('primary', 0, requestRef, attempts), makeModel('secondary', 1, requestRef, attempts), makeModel('tertiary', 2, requestRef, attempts)],
      modelResetInterval: 1,
    }),
  );

const cockatiel = async () =>
  runStrategy('cockatiel', (requestRef, attempts) => {
    const inner = makeModel('primary', 0, requestRef, attempts);
    const policy = wrap(
      retry(handleWhen(isRetryable), {
        maxAttempts: 3,
        backoff: new ExponentialBackoff({ initialDelay: 4, maxDelay: 16, generator: noJitterGenerator }),
      }),
      circuitBreaker(handleWhen(isRetryable), {
        halfOpenAfter: 200,
        breaker: new ConsecutiveBreaker(4),
      }),
    );
    return {
      specificationVersion: 'v4',
      provider: 'cockatiel',
      modelId: 'primary-only',
      supportedUrls: {},
      doGenerate: (options) => policy.execute(() => inner.doGenerate(options), options.abortSignal),
      doStream: () => {
        throw new Error('benchmark uses generateText');
      },
    };
  });

const resilient = async () =>
  runStrategy('ai-sdk-resilience', (requestRef, attempts) =>
    createResilientModel({
      models: [makeModel('primary', 0, requestRef, attempts), makeModel('secondary', 1, requestRef, attempts), makeModel('tertiary', 2, requestRef, attempts)],
      random: () => 0.5,
      retry: { maxAttempts: 3, initialDelayMs: 4, maxDelayMs: 16, multiplier: 2, maxRetryAfterMs: 30 },
      circuitBreaker: { failureThreshold: 4, successThreshold: 1, openDurationMs: 200, halfOpenMaxInFlight: 1 },
      hedge: { enabled: true, delayMs: 18, minMs: 10, maxMs: 80 },
      timeoutMs: 25,
    }),
  );

const started = Date.now();
const results = {
  plain: summarize(await primaryOnly()),
  'ai-fallback': summarize(await fallback()),
  cockatiel: summarize(await cockatiel()),
  'ai-sdk-resilience': summarize(await resilient()),
};

const report = {
  measuredAt: new Date(started).toISOString(),
  elapsedMs: Date.now() - started,
  node: process.version,
  platform: process.platform,
  requests: REQUESTS,
  seed: SEED,
  notes: [
    'Mock LanguageModelV4 providers. No network calls.',
    'generateText maxRetries is 0 so the SDK retry loop is not stacked on top.',
    'ai-fallback modelResetInterval is 1ms so each request starts on the primary. Its default is to stick to the fallback for 3 minutes.',
    'cockatiel retries and breaks the primary only. It has no model fallback and no view of AI SDK streams.',
    'Requests 24-31 are a forced primary 500 outage.',
    'p50/p95/p99 are over successful requests. p95AllMs includes failures.',
    'Delays use real timers. Re-running moves the numbers by a few milliseconds.',
  ],
  results,
};

writeFileSync(new URL('./results.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);

const row = (name: string, key: keyof typeof results) => {
  const item = results[key];
  return `| ${name} | ${(item.successRate * 100).toFixed(1)}% | ${item.p50Ms} | ${item.p95Ms} | ${item.p99Ms} | ${item.meanSuccessMs} |`;
};

const markdown = `# Benchmark

Measured ${report.measuredAt} on Node ${report.node} (${report.platform}), ${REQUESTS} sequential \`generateText\` calls, seed ${SEED}.

| Strategy | Success | p50 ms | p95 ms | p99 ms | mean ms |
| --- | ---: | ---: | ---: | ---: | ---: |
${row('Plain AI SDK (one model, maxRetries 0)', 'plain')}
${row('ai-fallback 3.x (ordered switch, no backoff)', 'ai-fallback')}
${row('cockatiel (retry + breaker, primary only)', 'cockatiel')}
${row('ai-sdk-resilience', 'ai-sdk-resilience')}

${report.notes.map((note) => `- ${note}`).join('\n')}
`;

writeFileSync(new URL('./RESULTS.md', import.meta.url), markdown);
console.log(markdown);
