import type { LanguageModelV4Middleware } from '@ai-sdk/provider';
import { createBreakerRegistry } from './breaker.js';
import { execute } from './orchestrator.js';
import { normalizeModel, resolveOptions } from './resolve.js';
import type { BreakerRegistryLike, ResilienceEvent, ResilientModelOptions } from './types.js';

/**
 * LanguageModelV4 middleware. `wrapGenerate` / `wrapStream` run the retry,
 * fallback, hedge, and breaker policy.
 *
 * The `doGenerate` passed into middleware is closed over the original params,
 * so it cannot carry a fresh AbortSignal for each attempt. Every attempt calls
 * the selected model's `doGenerate` or `doStream` with its own signal instead.
 */
export function createResilienceMiddleware(options: ResilientModelOptions): LanguageModelV4Middleware {
  const resolved = resolveOptions(options);
  const models = options.models.map(normalizeModel);
  const registry: BreakerRegistryLike =
    options.registry ?? createBreakerRegistry(resolved.circuitBreaker, resolved.clock, resolved.hedge);
  let callId = 'idle';
  registry.subscribe((event) => {
    safeEmit(options.onEvent, { ...event, callId });
  });

  const shared = {
    models,
    resolved,
    registry,
    onEvent: options.onEvent,
    assignCallId: (id: string) => {
      callId = id;
    },
  };

  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ params }) => execute({ ...shared, kind: 'generate', params }),
    wrapStream: async ({ params }) => execute({ ...shared, kind: 'stream', params }),
  };
}

function safeEmit(onEvent: ResilientModelOptions['onEvent'], event: ResilienceEvent): void {
  try {
    onEvent?.(event);
  } catch {
    // A throwing telemetry hook must not fail the generation.
  }
}
