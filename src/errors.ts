import type { AttemptSummary, ErrorClass } from './types.js';

export type ResilienceErrorCode =
  | 'no-models'
  | 'all-failed'
  | 'all-circuits-open'
  | 'fatal'
  | 'aborted';

export class ResilienceError extends Error {
  readonly name = 'ResilienceError';

  constructor(
    message: string,
    readonly code: ResilienceErrorCode,
    readonly attempts: readonly AttemptSummary[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The per-attempt deadline fired. Retryable. Does not mean the caller aborted. */
export class AttemptTimeoutError extends Error {
  readonly name = 'AttemptTimeoutError';

  constructor(readonly timeoutMs: number) {
    super(`Attempt timed out after ${timeoutMs}ms`);
  }
}

/** This attempt lost a hedge or was abandoned because another attempt won. */
export class HedgeCancelledError extends Error {
  readonly name = 'HedgeCancelledError';

  constructor() {
    super('Attempt cancelled because another model finished first');
  }
}

/** Internal signal so in-flight sleeps stop when the call has already settled. */
export class CallSettledError extends Error {
  readonly name = 'CallSettledError';

  constructor() {
    super('Call settled');
  }
}

export function isAttemptTimeout(error: unknown): error is AttemptTimeoutError {
  return error instanceof AttemptTimeoutError || (error instanceof Error && error.name === 'AttemptTimeoutError');
}

export function isHedgeCancelled(error: unknown): error is HedgeCancelledError {
  return error instanceof HedgeCancelledError || (error instanceof Error && error.name === 'HedgeCancelledError');
}

export function isCallSettled(error: unknown): boolean {
  return error instanceof CallSettledError || (error instanceof Error && error.name === 'CallSettledError');
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  if (typeof error === 'string') return error.slice(0, 300);
  return 'Unknown error';
}

export function isAbortError(error: unknown): boolean {
  if (isAttemptTimeout(error) || isHedgeCancelled(error) || isCallSettled(error)) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return error instanceof Error && error.name === 'AbortError';
}

export function classificationOfSettled(error: unknown): ErrorClass | undefined {
  if (isCallSettled(error)) return 'cancelled';
  if (isHedgeCancelled(error)) return 'cancelled';
  if (isAttemptTimeout(error)) return 'retryable';
  return undefined;
}
