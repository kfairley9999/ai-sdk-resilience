import type { LanguageModelV4 } from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import { createBreakerRegistry } from './breaker.js';
import { createResilienceMiddleware } from './middleware.js';
import { normalizeModel, resolveOptions } from './resolve.js';
import type { ResilientModelOptions } from './types.js';
import { ResilienceError } from './errors.js';

export { createResilienceMiddleware } from './middleware.js';
export { createBreakerRegistry, BreakerRegistry, modelKey } from './breaker.js';
export { classifyError, statusOf, headersOf, isNetworkError } from './classify.js';
export { computeDelay, parseDuration, retryDelayFromHeaders } from './delay.js';
export { ManualClock, systemClock } from './clock.js';
export { sumUsage, usageToJson, emptyUsage } from './usage.js';
export { percentile } from './latency.js';
export {
  AttemptTimeoutError,
  CallSettledError,
  HedgeCancelledError,
  ResilienceError,
} from './errors.js';
export { defaultBreaker, defaultHedge, defaultRetry, defaultStream, resolveOptions } from './resolve.js';

export type {
  AttemptSummary,
  BreakerRegistryLike,
  BreakerSnapshot,
  BreakerState,
  CircuitBreakerConfig,
  Clock,
  ErrorClass,
  HedgeConfig,
  ModelInput,
  ModelSpec,
  ResilienceEvent,
  ResilientModelOptions,
  RetryConfig,
  StreamConfig,
  StreamFailover,
  UsageAccounting,
  UsageJson,
} from './types.js';

/**
 * Wrap an ordered list of models with resilience middleware.
 *
 * Pass the returned model to `generateText`, `streamText`, `generateObject`,
 * or `streamObject`. Set the AI SDK's own `maxRetries: 0` so the SDK does not
 * stack a second retry loop outside this one.
 *
 * The first model is the primary. Later models are fallbacks and, when hedging
 * is enabled, hedge targets. Breaker and latency state live on the registry
 * owned by this call unless you pass `registry` yourself.
 */
export function createResilientModel(options: ResilientModelOptions): LanguageModelV4 {
  if (!options.models.length) {
    throw new ResilienceError('At least one model is required', 'no-models', []);
  }
  const models = options.models.map(normalizeModel);
  const primary = models[0]!.model;
  const resolved = resolveOptions(options);
  return wrapLanguageModel({
    model: primary,
    middleware: createResilienceMiddleware({
      ...options,
      models,
      registry: options.registry ?? createBreakerRegistry(resolved.circuitBreaker, resolved.clock, resolved.hedge),
    }),
    providerId: options.providerId ?? 'ai-sdk-resilience',
    modelId: options.modelId ?? primary.modelId,
  });
}
