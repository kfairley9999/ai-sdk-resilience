import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Usage,
  SharedV4ProviderOptions,
} from '@ai-sdk/provider';

/**
 * Wall clock used by retries, breaker cooldowns, and hedges.
 * Tests pass a manual clock. Production uses {@link systemClock}.
 */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export type ErrorClass = 'retryable' | 'fatal' | 'abort' | 'cancelled';

export type StreamFailover = 'restart' | 'continue';

export interface RetryConfig {
  /** Total tries per model, including the first call. */
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Exponential base. Delay cap before jitter is `initialDelayMs * multiplier ** retryIndex`. */
  multiplier: number;
  /**
   * Safety cap for a server-supplied Retry-After or rate-limit reset.
   * The header is honored up to this ceiling so a multi-hour reset cannot pin a request.
   */
  maxRetryAfterMs: number;
}

export interface CircuitBreakerConfig {
  /** Consecutive retryable failures that open the breaker. */
  failureThreshold: number;
  /** Successes required in half-open before the breaker closes. */
  successThreshold: number;
  /** How long the breaker stays open before a probe is allowed. */
  openDurationMs: number;
  /** Probes allowed while half-open. Extra calls skip this model. */
  halfOpenMaxInFlight: number;
  /** When false, HTTP 429 retries but does not trip the breaker. */
  countRateLimits: boolean;
}

export interface HedgeConfig {
  enabled: boolean;
  /**
   * Fixed wait before a second model is started, used when `percentile` is unset
   * and as the fallback until enough latency samples exist.
   */
  delayMs: number;
  /** When set, the hedge delay tracks this rolling percentile of successful latencies. */
  percentile?: number;
  minSamples: number;
  minMs: number;
  maxMs: number;
  sampleSize: number;
}

export interface StreamConfig {
  /**
   * `restart` buffers an attempt and only forwards a successful stream.
   * `continue` forwards partial text and asks the next attempt to resume.
   */
  onError: StreamFailover;
}

export interface UsageJson {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface AttemptSummary {
  provider: string;
  modelId: string;
  attempt: number;
  classification: ErrorClass | 'success';
  latencyMs: number;
  status?: number;
  usage?: UsageJson;
}

export interface UsageAccounting {
  /** Usage of the winning attempt. This is what `result.usage` reports. */
  reported: LanguageModelV4Usage;
  /**
   * Sum of usage objects observed across attempts, each attempt counted once.
   * Not added into `result.usage`. Includes the winner.
   */
  billed: LanguageModelV4Usage;
  attempts: AttemptSummary[];
  winner: { provider: string; modelId: string };
}

export type ResilienceEvent =
  | {
      type: 'attempt-start';
      callId: string;
      provider: string;
      modelId: string;
      attempt: number;
      at: number;
      gate: 'allow' | 'probe';
    }
  | {
      type: 'attempt-success';
      callId: string;
      provider: string;
      modelId: string;
      attempt: number;
      at: number;
      latencyMs: number;
      usage: UsageJson;
    }
  | {
      type: 'attempt-failure';
      callId: string;
      provider: string;
      modelId: string;
      attempt: number;
      at: number;
      classification: ErrorClass;
      status?: number;
      message: string;
    }
  | {
      type: 'retry';
      callId: string;
      provider: string;
      modelId: string;
      attempt: number;
      delayMs: number;
      source: 'backoff' | 'retry-after';
      capped: boolean;
    }
  | {
      type: 'fallback';
      callId: string;
      from: { provider: string; modelId: string };
      to: { provider: string; modelId: string };
      reason: string;
    }
  | {
      type: 'skip';
      callId: string;
      provider: string;
      modelId: string;
      reason: 'circuit-open';
      state: BreakerState;
    }
  | {
      type: 'hedge-start';
      callId: string;
      provider: string;
      modelId: string;
      delayMs: number;
    }
  | {
      type: 'hedge-cancel';
      callId: string;
      provider: string;
      modelId: string;
      winner: { provider: string; modelId: string };
    }
  | {
      type: 'breaker';
      callId: string;
      key: string;
      from: BreakerState;
      to: BreakerState;
      at: number;
    }
  | {
      type: 'stream-failover';
      callId: string;
      mode: StreamFailover;
      partialChars: number;
    }
  | {
      type: 'usage';
      callId: string;
      reported: UsageJson;
      billed: UsageJson;
      attempts: number;
    };

export interface ModelSpec {
  model: LanguageModelV4;
  providerOptions?: SharedV4ProviderOptions;
}

export type ModelInput = LanguageModelV4 | ModelSpec;

export interface ResilientModelOptions {
  /** Ordered preference. The first model is the primary. */
  models: ModelInput[];
  retry?: Partial<RetryConfig>;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  hedge?: Partial<HedgeConfig>;
  stream?: Partial<StreamConfig>;
  /** Per-attempt timeout. Aborts that attempt and treats it as retryable. */
  timeoutMs?: number;
  onEvent?: (event: ResilienceEvent) => void;
  /**
   * Replace the default classifier. Return `fatal` to stop the whole call,
   * `retryable` to retry or fall through, `abort` to stop without tripping a breaker.
   */
  classify?: (error: unknown, fallback: ErrorClass) => ErrorClass;
  /** Source of [0, 1) randomness for full jitter. */
  random?: () => number;
  clock?: Clock;
  /** Share breaker and latency state across wrapped models. */
  registry?: BreakerRegistryLike;
  providerId?: string;
  modelId?: string;
}

export interface BreakerSnapshot {
  key: string;
  state: BreakerState;
  consecutiveFailures: number;
}

export interface BreakerRegistryLike {
  snapshot(): BreakerSnapshot[];
  acquire(model: LanguageModelV4): BreakerHandle;
  recordLatency(model: LanguageModelV4, latencyMs: number): void;
  hedgeDelay(model: LanguageModelV4, hedge: HedgeConfig): number;
  subscribe(listener: (event: Omit<Extract<ResilienceEvent, { type: 'breaker' }>, 'callId'>) => void): () => void;
}

export interface BreakerHandle {
  readonly key: string;
  readonly state: BreakerState;
  tryAcquire(): 'allow' | 'probe' | 'reject';
  recordSuccess(gate: 'allow' | 'probe'): void;
  recordFailure(gate: 'allow' | 'probe'): void;
  recordRelease(gate: 'allow' | 'probe'): void;
}

export interface ResolvedResilience {
  retry: RetryConfig;
  circuitBreaker: CircuitBreakerConfig;
  hedge: HedgeConfig;
  stream: StreamConfig;
  timeoutMs?: number;
  classify?: ResilientModelOptions['classify'];
  random: () => number;
  clock: Clock;
}

export type { LanguageModelV4CallOptions, LanguageModelV4Usage };
