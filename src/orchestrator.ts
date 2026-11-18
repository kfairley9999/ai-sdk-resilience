import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
} from '@ai-sdk/provider';
import { classifyError, headersOf, statusOf } from './classify.js';
import { computeDelay, retryDelayFromHeaders } from './delay.js';
import {
  AttemptTimeoutError,
  CallSettledError,
  HedgeCancelledError,
  ResilienceError,
  errorMessage,
  isAttemptTimeout,
  isCallSettled,
  isHedgeCancelled,
} from './errors.js';
import { mergeProviderOptions } from './resolve.js';
import { assembleStream, continuePrompt, readModelStream, streamFromParts } from './stream.js';
import type {
  AttemptSummary,
  BreakerHandle,
  BreakerRegistryLike,
  ErrorClass,
  ModelSpec,
  ResilienceEvent,
  ResolvedResilience,
  UsageAccounting,
} from './types.js';
import { accountingMetadata, emptyUsage, hasAnyTokens, sumUsage, usageToJson } from './usage.js';

let callSequence = 0;

type Kind = 'generate' | 'stream';

interface ExecuteInput {
  kind: Kind;
  params: LanguageModelV4CallOptions;
  models: ModelSpec[];
  resolved: ResolvedResilience;
  registry: BreakerRegistryLike;
  onEvent?: (event: ResilienceEvent) => void;
  assignCallId: (callId: string) => void;
}

interface Inflight {
  modelIndex: number;
  attempt: number;
  controller: AbortController;
  timeout: AbortController;
  gate: 'allow' | 'probe';
  handle: BreakerHandle;
  provider: string;
  modelId: string;
  startedAt: number;
  released: boolean;
  abandoned: boolean;
}

type AttemptResult = {
  inflight: Inflight;
  latencyMs: number;
  status?: number;
  headers?: Record<string, string>;
  error?: unknown;
  partialText: string;
  partialParts: LanguageModelV4StreamPart[];
  partialUsage?: LanguageModelV4Usage;
  generate?: LanguageModelV4GenerateResult;
  parts?: LanguageModelV4StreamPart[];
  streamRequest?: LanguageModelV4StreamResult['request'];
  streamResponse?: LanguageModelV4StreamResult['response'];
  usage?: LanguageModelV4Usage;
  ok: boolean;
};

type Wake =
  | { type: 'attempt'; result: AttemptResult }
  | { type: 'hedge'; delayMs: number }
  | { type: 'retry'; modelIndex: number }
  | { type: 'control'; error: unknown };

export function execute(input: ExecuteInput & { kind: 'generate' }): Promise<LanguageModelV4GenerateResult>;
export function execute(input: ExecuteInput & { kind: 'stream' }): Promise<LanguageModelV4StreamResult>;
export function execute(input: ExecuteInput): Promise<LanguageModelV4GenerateResult | LanguageModelV4StreamResult> {
  return run(input);
}

async function run(input: ExecuteInput): Promise<LanguageModelV4GenerateResult | LanguageModelV4StreamResult> {
  const { resolved, models, params, registry } = input;
  if (models.length === 0) {
    throw new ResilienceError('At least one model is required', 'no-models', []);
  }

  const callId = `call-${resolved.clock.now()}-${(callSequence += 1)}`;
  input.assignCallId(callId);
  const emit = (event: ResilienceEvent) => {
    try {
      input.onEvent?.(event);
    } catch {
      // Telemetry hooks must not break the generation.
    }
  };

  const userSignal = params.abortSignal;
  const callDone = new AbortController();
  const stopSleeps = combineSignals([userSignal, callDone.signal].filter((signal): signal is AbortSignal => signal != null));

  const running = new Map<number, Inflight>();
  const skipped = new Set<number>();
  const attemptsUsed = new Map<number, number>();
  const waiters = new Map<number, Promise<Wake>>();
  let waiterId = 0;
  const summaries: AttemptSummary[] = [];
  const billed: LanguageModelV4Usage[] = [];
  let lastError: unknown;
  let circuitSkips = 0;
  let launches = 0;
  let lastFailedIndex = 0;
  let backupStarted = false;
  let visibleText = '';
  let carried: LanguageModelV4StreamPart[] | undefined;
  let prompt = params.prompt;

  const originalPrompt = params.prompt;

  function addWaiter(promise: Promise<Wake>): void {
    const id = (waiterId += 1);
    waiters.set(
      id,
      promise.then(
        (wake) => {
          waiters.delete(id);
          return wake;
        },
        (error: unknown) => {
          waiters.delete(id);
          return { type: 'control', error } satisfies Wake;
        },
      ),
    );
  }

  function rememberUsage(usage: LanguageModelV4Usage | undefined): void {
    if (usage && hasAnyTokens(usage)) billed.push(usage);
  }

  function pushSummary(result: AttemptResult, classification: AttemptSummary['classification']): void {
    const usage = result.ok ? result.usage : result.partialUsage;
    const summary: AttemptSummary = {
      provider: result.inflight.provider,
      modelId: result.inflight.modelId,
      attempt: result.inflight.attempt,
      classification,
      latencyMs: result.latencyMs,
    };
    if (result.status != null) summary.status = result.status;
    if (usage && hasAnyTokens(usage)) summary.usage = usageToJson(usage);
    summaries.push(summary);
  }

  function release(inf: Inflight, kind: 'success' | 'failure' | 'drop'): void {
    if (inf.released) return;
    inf.released = true;
    if (kind === 'success') inf.handle.recordSuccess(inf.gate);
    else if (kind === 'failure') inf.handle.recordFailure(inf.gate);
    else inf.handle.recordRelease(inf.gate);
  }

  function classifyAttempt(result: AttemptResult): ErrorClass {
    const reason = result.inflight.controller.signal.aborted ? result.inflight.controller.signal.reason : undefined;
    if (userSignal?.aborted) return 'abort';
    if (isHedgeCancelled(reason) || isHedgeCancelled(result.error) || result.inflight.abandoned) return 'cancelled';
    if (isCallSettled(reason) || isCallSettled(result.error)) return 'cancelled';
    if (isAttemptTimeout(reason) || isAttemptTimeout(result.error)) return 'retryable';
    const fallback = classifyError(result.error);
    return resolved.classify ? resolved.classify(result.error, fallback) : fallback;
  }

  function launch(modelIndex: number, trigger: 'primary' | 'retry' | 'fallback' | 'hedge'): boolean {
    if (modelIndex < 0 || modelIndex >= models.length) return false;
    if (skipped.has(modelIndex) || running.has(modelIndex)) return false;
    const used = attemptsUsed.get(modelIndex) ?? 0;
    if (used >= resolved.retry.maxAttempts) {
      skipped.add(modelIndex);
      return false;
    }
    const spec = models[modelIndex];
    if (!spec) return false;
    const handle = registry.acquire(spec.model);
    const gate = handle.tryAcquire();
    if (gate === 'reject') {
      if (handle.state !== 'half-open') {
        skipped.add(modelIndex);
        circuitSkips += 1;
        emit({
          type: 'skip',
          callId,
          provider: spec.model.provider,
          modelId: spec.model.modelId,
          reason: 'circuit-open',
          state: handle.state,
        });
      }
      return false;
    }

    const attempt = used + 1;
    attemptsUsed.set(modelIndex, attempt);
    launches += 1;
    const controller = new AbortController();
    if (userSignal) linkAbort(userSignal, controller);
    const timeout = new AbortController();
    const timeoutMs = resolved.timeoutMs;
    if (timeoutMs != null && timeoutMs > 0) {
      void resolved.clock.sleep(timeoutMs, timeout.signal).then(
        () => {
          if (!controller.signal.aborted) controller.abort(new AttemptTimeoutError(timeoutMs));
        },
        () => undefined,
      );
    }

    const inflight: Inflight = {
      modelIndex,
      attempt,
      controller,
      timeout,
      gate,
      handle,
      provider: spec.model.provider,
      modelId: spec.model.modelId,
      startedAt: resolved.clock.now(),
      released: false,
      abandoned: false,
    };
    running.set(modelIndex, inflight);
    emit({
      type: 'attempt-start',
      callId,
      provider: inflight.provider,
      modelId: inflight.modelId,
      attempt,
      at: inflight.startedAt,
      gate,
    });
    if (trigger === 'fallback' && lastFailedIndex !== modelIndex) {
      const from = models[lastFailedIndex]?.model;
      if (from) {
        emit({
          type: 'fallback',
          callId,
          from: { provider: from.provider, modelId: from.modelId },
          to: { provider: inflight.provider, modelId: inflight.modelId },
          reason: 'retry-exhausted',
        });
      }
    }
    if (trigger === 'hedge' || trigger === 'fallback') backupStarted = true;

    addWaiter(
      performAttempt(input.kind, spec, prompt, params, inflight, resolved).then((result) => {
        timeout.abort(new CallSettledError());
        if (running.get(modelIndex) === inflight) running.delete(modelIndex);
        return { type: 'attempt', result } satisfies Wake;
      }),
    );
    return true;
  }

  function armHedge(delayMs: number): void {
    addWaiter(
      resolved.clock.sleep(delayMs, stopSleeps).then(
        () => ({ type: 'hedge', delayMs }) satisfies Wake,
        (error: unknown) => ({ type: 'control', error }) satisfies Wake,
      ),
    );
  }

  function scheduleRetry(result: AttemptResult): void {
    const headerMs = retryDelayFromHeaders(result.headers, resolved.clock.now());
    const decision = computeDelay(result.inflight.attempt - 1, resolved.retry, resolved.random, headerMs);
    emit({
      type: 'retry',
      callId,
      provider: result.inflight.provider,
      modelId: result.inflight.modelId,
      attempt: result.inflight.attempt,
      delayMs: decision.delayMs,
      source: decision.source,
      capped: decision.capped,
    });
    addWaiter(
      resolved.clock.sleep(decision.delayMs, stopSleeps).then(
        () => ({ type: 'retry', modelIndex: result.inflight.modelIndex }) satisfies Wake,
        (error: unknown) => ({ type: 'control', error }) satisfies Wake,
      ),
    );
  }

  function startFallback(): boolean {
    for (let index = 0; index < models.length; index += 1) {
      if (launch(index, index === 0 ? 'retry' : 'fallback')) return true;
    }
    return false;
  }

  function throwIfIdle(): void {
    if (waiters.size > 0 || running.size > 0) return;
    const code = launches === 0 && circuitSkips > 0 ? 'all-circuits-open' : 'all-failed';
    throw new ResilienceError(
      code === 'all-circuits-open' ? 'Every model circuit is open' : 'Every model attempt failed',
      code,
      summaries,
      lastError === undefined ? undefined : { cause: lastError },
    );
  }

  function abandonOthers(winner: Inflight): void {
    for (const inf of [...running.values()]) {
      if (inf === winner || inf.abandoned) continue;
      inf.abandoned = true;
      emit({
        type: 'hedge-cancel',
        callId,
        provider: inf.provider,
        modelId: inf.modelId,
        winner: { provider: winner.provider, modelId: winner.modelId },
      });
      if (!inf.controller.signal.aborted) inf.controller.abort(new HedgeCancelledError());
      release(inf, 'drop');
    }
  }

  function accounting(winner: { provider: string; modelId: string }, reported: LanguageModelV4Usage): UsageAccounting {
    return {
      reported,
      billed: sumUsage(billed),
      attempts: summaries,
      winner,
    };
  }

  function notePartial(result: AttemptResult): void {
    if (input.kind !== 'stream' || !result.partialText) return;
    emit({
      type: 'stream-failover',
      callId,
      mode: resolved.stream.onError,
      partialChars: result.partialText.length,
    });
    if (resolved.stream.onError !== 'continue') return;
    visibleText += result.partialText;
    prompt = continuePrompt(originalPrompt, visibleText);
    const chunk = result.partialParts.filter((part) => part.type !== 'finish' && part.type !== 'error');
    carried = [...(carried ?? []), ...chunk];
  }

  try {
    if (userSignal?.aborted) {
      throw new ResilienceError('The call was aborted', 'aborted', [], { cause: userSignal.reason });
    }
    if (!launch(0, 'primary')) startFallback();
    throwIfIdle();

    if (resolved.hedge.enabled && models.length > 1) {
      const primary = models[0]!.model;
      const delayMs = registry.hedgeDelay(primary, resolved.hedge);
      armHedge(delayMs);
    }

    for (let step = 0; step < 200; step += 1) {
      if (waiters.size === 0) {
        if (!startFallback()) throwIfIdle();
        continue;
      }
      const wake = await Promise.race(waiters.values());
      if (wake.type === 'control') {
        if (isCallSettled(wake.error)) continue;
        throw new ResilienceError('The call was aborted', 'aborted', summaries, { cause: wake.error });
      }
      if (wake.type === 'hedge') {
        if (!backupStarted && running.has(0)) {
          for (let index = 1; index < models.length; index += 1) {
            const spec = models[index];
            if (!spec || running.has(index)) continue;
            const started = launch(index, 'hedge');
            if (started) {
              emit({
                type: 'hedge-start',
                callId,
                provider: spec.model.provider,
                modelId: spec.model.modelId,
                delayMs: wake.delayMs,
              });
              break;
            }
          }
        }
        continue;
      }
      if (wake.type === 'retry') {
        if (!launch(wake.modelIndex, 'retry')) startFallback();
        throwIfIdle();
        continue;
      }

      const result = wake.result;
      if (result.inflight.abandoned) {
        if (!result.inflight.released) release(result.inflight, 'drop');
        continue;
      }

      if (result.ok && result.usage) {
        rememberUsage(result.usage);
        pushSummary(result, 'success');
        release(result.inflight, 'success');
        registry.recordLatency(models[result.inflight.modelIndex]!.model, result.latencyMs);
        emit({
          type: 'attempt-success',
          callId,
          provider: result.inflight.provider,
          modelId: result.inflight.modelId,
          attempt: result.inflight.attempt,
          at: resolved.clock.now(),
          latencyMs: result.latencyMs,
          usage: usageToJson(result.usage),
        });
        abandonOthers(result.inflight);
        const report = accounting(
          { provider: result.inflight.provider, modelId: result.inflight.modelId },
          result.usage,
        );
        emit({
          type: 'usage',
          callId,
          reported: usageToJson(report.reported),
          billed: usageToJson(report.billed),
          attempts: summaries.length,
        });
        if (input.kind === 'generate' && result.generate) {
          return decorateGenerate(result.generate, report);
        }
        const parts = assembleStream(carried, result.parts ?? [], report.reported, report);
        return {
          stream: streamFromParts(parts),
          request: result.streamRequest,
          response: result.streamResponse,
        };
      }

      const classification = classifyAttempt(result);
      lastError = result.error;
      lastFailedIndex = result.inflight.modelIndex;
      pushSummary(result, classification);
      rememberUsage(result.partialUsage);
      const reportFailure = () => {
        emit({
          type: 'attempt-failure',
          callId,
          provider: result.inflight.provider,
          modelId: result.inflight.modelId,
          attempt: result.inflight.attempt,
          at: resolved.clock.now(),
          classification,
          ...(result.status != null ? { status: result.status } : {}),
          message: errorMessage(result.error),
        });
      };

      if (classification === 'cancelled') {
        release(result.inflight, 'drop');
        reportFailure();
        continue;
      }
      if (classification === 'abort' || classification === 'fatal') {
        release(result.inflight, 'drop');
        reportFailure();
        for (const inf of [...running.values()]) {
          inf.abandoned = true;
          if (!inf.controller.signal.aborted) inf.controller.abort(result.error);
          release(inf, 'drop');
        }
        throw new ResilienceError(
          classification === 'abort' ? 'The call was aborted' : errorMessage(result.error),
          classification === 'abort' ? 'aborted' : 'fatal',
          summaries,
          { cause: result.error },
        );
      }

      const status = result.status;
      const counts = !(status === 429 && !resolved.circuitBreaker.countRateLimits);
      release(result.inflight, counts ? 'failure' : 'drop');
      reportFailure();
      notePartial(result);

      if (result.inflight.attempt < resolved.retry.maxAttempts) {
        scheduleRetry(result);
        continue;
      }
      skipped.add(result.inflight.modelIndex);
      if (running.size === 0) startFallback();
      throwIfIdle();
    }

    throw new ResilienceError('Retry loop exceeded its safety bound', 'all-failed', summaries, {
      cause: lastError,
    });
  } finally {
    if (!callDone.signal.aborted) callDone.abort(new CallSettledError());
  }
}

async function performAttempt(
  kind: Kind,
  spec: ModelSpec,
  prompt: LanguageModelV4CallOptions['prompt'],
  params: LanguageModelV4CallOptions,
  inflight: Inflight,
  resolved: ResolvedResilience,
): Promise<AttemptResult> {
  const started = resolved.clock.now();
  const base = (): AttemptResult => ({
    inflight,
    latencyMs: 0,
    partialText: '',
    partialParts: [],
    ok: false,
  });
  try {
    const providerOptions = mergeProviderOptions(params.providerOptions, spec.providerOptions);
    const attemptParams: LanguageModelV4CallOptions = {
      ...params,
      prompt,
      abortSignal: inflight.controller.signal,
      ...(providerOptions ? { providerOptions } : {}),
    };
    if (kind === 'generate') {
      const generate = await spec.model.doGenerate(attemptParams);
      return {
        ...base(),
        ok: true,
        generate,
        usage: generate.usage,
        latencyMs: resolved.clock.now() - started,
      };
    }
    const streamed = await spec.model.doStream(attemptParams);
    const read = await readModelStream(streamed.stream, inflight.controller.signal);
    const latencyMs = resolved.clock.now() - started;
    if (read.error !== undefined) {
      const partialUsage = read.usage ?? usageOnError(read.error);
      return {
        ...base(),
        latencyMs,
        error: read.error,
        partialText: read.text,
        partialParts: read.parts,
        ...(partialUsage ? { partialUsage } : {}),
        ...(statusOf(read.error) != null ? { status: statusOf(read.error) } : {}),
        ...(headersOf(read.error) ? { headers: headersOf(read.error) } : {}),
      };
    }
    return {
      ...base(),
      ok: true,
      latencyMs,
      usage: read.usage ?? emptyUsage(),
      parts: read.parts,
      streamRequest: streamed.request,
      streamResponse: streamed.response,
    };
  } catch (error) {
    const partialUsage = usageOnError(error);
    return {
      ...base(),
      latencyMs: resolved.clock.now() - started,
      error,
      ...(partialUsage ? { partialUsage } : {}),
      ...(statusOf(error) != null ? { status: statusOf(error) } : {}),
      ...(headersOf(error) ? { headers: headersOf(error) } : {}),
    };
  }
}

function decorateGenerate(result: LanguageModelV4GenerateResult, report: UsageAccounting): LanguageModelV4GenerateResult {
  const providerMetadata: SharedV4ProviderMetadata = {
    ...(result.providerMetadata ?? {}),
    'ai-sdk-resilience': metadataValue(report),
  };
  return { ...result, usage: report.reported, providerMetadata };
}

function metadataValue(report: UsageAccounting): SharedV4ProviderMetadata[string] {
  return accountingMetadata(report) as SharedV4ProviderMetadata[string];
}

function usageOnError(error: unknown): LanguageModelV4Usage | undefined {
  if (!error || typeof error !== 'object' || !('usage' in error)) return undefined;
  const usage = (error as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object' || !('inputTokens' in usage) || !('outputTokens' in usage)) return undefined;
  return usage as LanguageModelV4Usage;
}

function linkAbort(from: AbortSignal, to: AbortController): void {
  if (from.aborted) {
    if (!to.signal.aborted) to.abort(from.reason);
    return;
  }
  const onAbort = () => {
    if (!to.signal.aborted) to.abort(from.reason);
  };
  from.addEventListener('abort', onAbort, { once: true });
  to.signal.addEventListener('abort', () => from.removeEventListener('abort', onAbort), { once: true });
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    }, { once: true });
  }
  return controller.signal;
}
