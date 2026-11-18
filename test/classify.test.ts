import { APICallError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { classifyError, isNetworkError, statusOf } from '../src/classify.js';
import { AttemptTimeoutError, HedgeCancelledError } from '../src/errors.js';
import { httpError } from './support.js';

describe('classifyError', () => {
  it('retries 408, 425, 429, 498, and 5xx', () => {
    for (const status of [408, 425, 429, 498, 500, 502, 503, 504, 599]) {
      expect(classifyError(httpError(status)), String(status)).toBe('retryable');
    }
  });

  it('never retries validation, auth, or other fatal 4xx', () => {
    for (const status of [400, 401, 402, 403, 404, 409, 413, 422, 451]) {
      const error = httpError(status);
      (error as { isRetryable: boolean }).isRetryable = true;
      expect(classifyError(error), String(status)).toBe('fatal');
    }
  });

  it('reads status from plain objects and nested network causes', () => {
    expect(statusOf({ status: 503 })).toBe(503);
    expect(classifyError({ statusCode: 422, message: 'bad' })).toBe('fatal');
    const cause = { code: 'ECONNRESET' };
    const error = new TypeError('fetch failed');
    (error as { cause?: unknown }).cause = cause;
    expect(isNetworkError(error)).toBe(true);
    expect(classifyError(error)).toBe('retryable');
    expect(isNetworkError(cause)).toBe(true);
  });

  it('treats timeouts as retryable and caller aborts as abort', () => {
    expect(classifyError(new AttemptTimeoutError(10))).toBe('retryable');
    expect(classifyError(new HedgeCancelledError())).toBe('cancelled');
    expect(classifyError(new DOMException('The operation was aborted.', 'AbortError'))).toBe('abort');
    const timeoutAbort = new DOMException('request timeout', 'AbortError');
    expect(classifyError(timeoutAbort)).toBe('retryable');
    const named = new Error('headers timed out');
    named.name = 'HeadersTimeoutError';
    expect(classifyError(named)).toBe('retryable');
  });

  it('treats prompt validation as fatal and unknown API errors by the provider flag', () => {
    const invalid = new Error('bad prompt');
    invalid.name = 'AI_InvalidPromptError';
    expect(classifyError(invalid)).toBe('fatal');
    const plain = new APICallError({
      message: 'no status',
      url: 'https://example.invalid',
      requestBodyValues: {},
      isRetryable: false,
    });
    expect(classifyError(plain)).toBe('fatal');
    const retryable = new APICallError({
      message: 'no status',
      url: 'https://example.invalid',
      requestBodyValues: {},
      isRetryable: true,
    });
    expect(classifyError(retryable)).toBe('retryable');
    expect(classifyError(new Error('capacity vanished'))).toBe('retryable');
  });

  it('does not recurse forever on a cyclic cause', () => {
    const error: { cause?: unknown; message: string } = { message: 'loop' };
    error.cause = error;
    expect(isNetworkError(error)).toBe(false);
  });
});
