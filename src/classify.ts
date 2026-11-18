import { APICallError } from '@ai-sdk/provider';
import { classificationOfSettled, isAbortError } from './errors.js';
import type { ErrorClass } from './types.js';

/**
 * 4xx that must never be retried. 408 and 429 are intentionally absent:
 * 408 is a timeout and 429 is rate limiting, not a validation failure.
 */
const FATAL_STATUS = new Set([
  400, 401, 402, 403, 404, 405, 406, 409, 410, 411, 412, 413, 414, 415, 416, 422, 431, 451,
]);

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const FATAL_NAMES = [
  'AI_InvalidPromptError',
  'InvalidPromptError',
  'AI_InvalidArgumentError',
  'AI_MessageConversionError',
  'AI_TypeValidationError',
  'TypeValidationError',
];

export function statusOf(error: unknown): number | undefined {
  if (APICallError.isInstance(error) && error.statusCode != null) return error.statusCode;
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ['statusCode', 'status', 'status_code']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function headersOf(error: unknown): Record<string, string> | undefined {
  if (APICallError.isInstance(error) && error.responseHeaders) return error.responseHeaders;
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const headers = record.responseHeaders ?? record.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export function isNetworkError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const record = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof record.code === 'string' && NETWORK_CODES.has(record.code)) return true;
  if (typeof record.message === 'string' && /fetch failed|network error|socket hang up|other side closed|econnreset/i.test(record.message)) {
    return true;
  }
  if (record.cause && record.cause !== error) return isNetworkError(record.cause, seen);
  return false;
}

function isTimeoutName(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'ConnectTimeoutError' || error.name === 'HeadersTimeoutError') {
    return true;
  }
  return /\btimeout\b/i.test(error.message) && error.name !== 'AbortError';
}

/**
 * Classify a provider or transport failure.
 * Validation and auth 4xx are fatal. 408, 429, 5xx, timeouts, and network
 * failures are retryable. Caller aborts are not retried and do not trip breakers.
 */
export function classifyError(error: unknown): ErrorClass {
  const settled = classificationOfSettled(error);
  if (settled) return settled;

  const status = statusOf(error);
  if (status === 408 || status === 425 || status === 429 || status === 498) return 'retryable';
  if (status != null && status >= 500) return 'retryable';
  if (status != null && FATAL_STATUS.has(status)) return 'fatal';
  if (status != null && status >= 400 && status < 500) return 'fatal';

  if (isTimeoutName(error) || isNetworkError(error)) return 'retryable';
  if (isAbortError(error)) {
    const message = error instanceof Error || (typeof DOMException !== 'undefined' && error instanceof DOMException) ? error.message : '';
    return /timeout/i.test(message) ? 'retryable' : 'abort';
  }

  if (error instanceof Error && FATAL_NAMES.some((name) => error.name === name)) return 'fatal';

  if (APICallError.isInstance(error)) return error.isRetryable ? 'retryable' : 'fatal';

  if (error instanceof TypeError && /fetch failed|network/i.test(error.message)) return 'retryable';

  // Unknown failures are usually transport blips. maxAttempts bounds the loop.
  return 'retryable';
}
