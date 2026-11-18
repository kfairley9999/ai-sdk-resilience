import type {
  HedgeConfig,
  ModelInput,
  ModelSpec,
  ResilientModelOptions,
  ResolvedResilience,
} from './types.js';
import { systemClock } from './clock.js';

export const defaultRetry = {
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 10_000,
  multiplier: 2,
  maxRetryAfterMs: 30_000,
} as const;

export const defaultBreaker = {
  failureThreshold: 5,
  successThreshold: 1,
  openDurationMs: 30_000,
  halfOpenMaxInFlight: 1,
  countRateLimits: true,
} as const;

export const defaultHedge: HedgeConfig = {
  enabled: false,
  delayMs: 800,
  minSamples: 8,
  minMs: 50,
  maxMs: 10_000,
  sampleSize: 64,
};

export const defaultStream = {
  onError: 'restart',
} as const;

export function resolveOptions(options: ResilientModelOptions): ResolvedResilience {
  const hedge = { ...defaultHedge, ...options.hedge };
  if (hedge.percentile != null && (hedge.percentile <= 0 || hedge.percentile > 100)) {
    throw new Error('hedge.percentile must be in the range (0, 100]');
  }
  if ((options.retry?.maxAttempts ?? defaultRetry.maxAttempts) < 1) {
    throw new Error('retry.maxAttempts must be at least 1');
  }
  return {
    retry: { ...defaultRetry, ...options.retry },
    circuitBreaker: { ...defaultBreaker, ...options.circuitBreaker },
    hedge,
    stream: { ...defaultStream, ...options.stream },
    timeoutMs: options.timeoutMs,
    classify: options.classify,
    random: options.random ?? Math.random,
    clock: options.clock ?? systemClock,
  };
}

export function normalizeModel(input: ModelInput): ModelSpec {
  if ('specificationVersion' in input) return { model: input };
  return input;
}

export function mergeProviderOptions(
  callOptions: ModelSpec['providerOptions'],
  modelOptions: ModelSpec['providerOptions'],
): ModelSpec['providerOptions'] {
  if (!modelOptions) return callOptions;
  const merged: NonNullable<ModelSpec['providerOptions']> = { ...(callOptions ?? {}) };
  for (const [provider, value] of Object.entries(modelOptions)) {
    const current = merged[provider];
    merged[provider] = {
      ...(current && typeof current === 'object' ? current : {}),
      ...(value && typeof value === 'object' ? value : {}),
    };
  }
  return merged;
}
