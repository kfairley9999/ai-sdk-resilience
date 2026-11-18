import type { LanguageModelV4 } from '@ai-sdk/provider';
import type {
  BreakerHandle,
  BreakerRegistryLike,
  BreakerSnapshot,
  BreakerState,
  CircuitBreakerConfig,
  Clock,
  HedgeConfig,
  ResilienceEvent,
} from './types.js';
import { LatencyWindow } from './latency.js';

type Transition = Omit<Extract<ResilienceEvent, { type: 'breaker' }>, 'callId'>;

export function modelKey(model: LanguageModelV4): string {
  return `${model.provider}:${model.modelId}`;
}

class CircuitBreaker implements BreakerHandle {
  state: BreakerState = 'closed';
  consecutiveFailures = 0;
  #openedAt = 0;
  #halfOpenInFlight = 0;
  #halfOpenSuccesses = 0;

  constructor(
    readonly key: string,
    private readonly config: CircuitBreakerConfig,
    private readonly clock: Clock,
    private readonly onTransition: (from: BreakerState, to: BreakerState) => void,
  ) {}

  tryAcquire(): 'allow' | 'probe' | 'reject' {
    this.#maybeHalfOpen();
    if (this.state === 'open') return 'reject';
    if (this.state === 'half-open') {
      if (this.#halfOpenInFlight >= this.config.halfOpenMaxInFlight) return 'reject';
      this.#halfOpenInFlight += 1;
      return 'probe';
    }
    return 'allow';
  }

  recordSuccess(gate: 'allow' | 'probe'): void {
    if (gate === 'probe') {
      this.#halfOpenInFlight = Math.max(0, this.#halfOpenInFlight - 1);
      this.#halfOpenSuccesses += 1;
      if (this.#halfOpenSuccesses >= this.config.successThreshold) {
        this.consecutiveFailures = 0;
        this.#setState('closed');
      }
      return;
    }
    this.consecutiveFailures = 0;
  }

  recordFailure(gate: 'allow' | 'probe'): void {
    if (gate === 'probe') {
      this.#halfOpenInFlight = Math.max(0, this.#halfOpenInFlight - 1);
      this.#trip();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.state === 'closed' && this.consecutiveFailures >= this.config.failureThreshold) {
      this.#trip();
    }
  }

  recordRelease(gate: 'allow' | 'probe'): void {
    if (gate === 'probe') this.#halfOpenInFlight = Math.max(0, this.#halfOpenInFlight - 1);
  }

  #trip(): void {
    this.#openedAt = this.clock.now();
    this.#halfOpenSuccesses = 0;
    this.#halfOpenInFlight = 0;
    this.#setState('open');
  }

  #maybeHalfOpen(): void {
    if (this.state !== 'open') return;
    if (this.clock.now() - this.#openedAt >= this.config.openDurationMs) {
      this.#halfOpenInFlight = 0;
      this.#halfOpenSuccesses = 0;
      this.#setState('half-open');
    }
  }

  #setState(next: BreakerState): void {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition(from, next);
  }
}

export class BreakerRegistry implements BreakerRegistryLike {
  readonly #breakers = new Map<string, CircuitBreaker>();
  readonly #latency = new Map<string, LatencyWindow>();
  readonly #listeners = new Set<(event: Transition) => void>();

  constructor(
    private readonly config: CircuitBreakerConfig,
    private readonly clock: Clock,
    private readonly hedgeDefaults: HedgeConfig,
  ) {}

  subscribe(listener: (event: Transition) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  acquire(model: LanguageModelV4): BreakerHandle {
    const key = modelKey(model);
    let breaker = this.#breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker(key, this.config, this.clock, (from, to) => {
        const event: Transition = { type: 'breaker', key, from, to, at: this.clock.now() };
        for (const listener of this.#listeners) listener(event);
      });
      this.#breakers.set(key, breaker);
    }
    return breaker;
  }

  recordLatency(model: LanguageModelV4, latencyMs: number): void {
    const key = modelKey(model);
    let window = this.#latency.get(key);
    if (!window) {
      window = new LatencyWindow(this.hedgeDefaults.sampleSize);
      this.#latency.set(key, window);
    }
    window.record(latencyMs);
  }

  hedgeDelay(model: LanguageModelV4, hedge: HedgeConfig): number {
    if (hedge.percentile == null) return clamp(hedge.delayMs, hedge.minMs, hedge.maxMs);
    const window = this.#latency.get(modelKey(model));
    if (!window || window.size < hedge.minSamples) return clamp(hedge.delayMs, hedge.minMs, hedge.maxMs);
    const value = window.value(hedge.percentile);
    if (value == null) return clamp(hedge.delayMs, hedge.minMs, hedge.maxMs);
    return clamp(value, hedge.minMs, hedge.maxMs);
  }

  snapshot(): BreakerSnapshot[] {
    return [...this.#breakers.values()].map((breaker) => ({
      key: breaker.key,
      state: breaker.state,
      consecutiveFailures: breaker.consecutiveFailures,
    }));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createBreakerRegistry(
  config: CircuitBreakerConfig,
  clock: Clock,
  hedge: HedgeConfig,
): BreakerRegistry {
  return new BreakerRegistry(config, clock, hedge);
}
