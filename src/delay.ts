import type { RetryConfig } from './types.js';

const DURATION = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/;

/** Parse `6m0s`, `200ms`, `1.5s` into milliseconds. */
export function parseDuration(value: string): number | undefined {
  const match = DURATION.exec(value.trim());
  if (!match) return undefined;
  const [, hours, minutes, seconds, millis] = match;
  if (hours == null && minutes == null && seconds == null && millis == null) return undefined;
  const total =
    (Number(hours ?? 0) * 60 * 60 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000 +
    Number(millis ?? 0);
  if (!Number.isFinite(total) || total < 0) return undefined;
  return Math.round(total);
}

function parseReset(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const duration = parseDuration(trimmed);
  if (duration != null) return duration;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    if (numeric > 1e12) return Math.max(0, numeric - now);
    if (numeric > 1e9) return Math.max(0, numeric * 1000 - now);
    return Math.max(0, numeric * 1000);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return Math.max(0, parsed - now);
  return undefined;
}

const RESET_HEADERS = [
  'retry-after',
  'retry-after-ms',
  'x-ratelimit-reset',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-reset',
];

/**
 * Longest wait requested by Retry-After or a provider rate-limit reset header.
 * Returns undefined when no recognized header is present.
 */
export function retryDelayFromHeaders(
  headers: Record<string, string> | undefined,
  now: number,
): number | undefined {
  if (!headers) return undefined;
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) lower.set(key.toLowerCase(), value);

  const delays: number[] = [];
  for (const key of RESET_HEADERS) {
    const raw = lower.get(key);
    if (raw == null) continue;
    if (key === 'retry-after-ms') {
      const ms = Number(raw.trim());
      if (Number.isFinite(ms) && ms >= 0) delays.push(ms);
      continue;
    }
    if (key === 'retry-after') {
      const seconds = Number(raw.trim());
      if (Number.isFinite(seconds)) {
        delays.push(Math.max(0, seconds * 1000));
        continue;
      }
    }
    const parsed = parseReset(raw, now);
    if (parsed != null) delays.push(parsed);
  }
  if (delays.length === 0) return undefined;
  return Math.max(...delays);
}

export interface DelayDecision {
  delayMs: number;
  source: 'backoff' | 'retry-after';
  capped: boolean;
}

/**
 * Full jitter: uniform in `[0, min(maxDelay, initial * multiplier^retryIndex))`.
 * A server wait replaces that draw when it is longer, then the result is capped
 * by `maxRetryAfterMs`.
 */
export function computeDelay(
  retryIndex: number,
  retry: RetryConfig,
  random: () => number,
  headerMs: number | undefined,
): DelayDecision {
  const exponential = Math.min(
    retry.maxDelayMs,
    retry.initialDelayMs * retry.multiplier ** Math.max(0, retryIndex),
  );
  const span = Math.max(0, exponential);
  const draw = random();
  const unit = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 0;
  const backoff = Math.floor(unit * span);
  const header = headerMs != null && Number.isFinite(headerMs) ? Math.max(0, headerMs) : undefined;
  let delay = header != null ? Math.max(backoff, header) : backoff;
  let capped = false;
  if (delay > retry.maxRetryAfterMs) {
    delay = retry.maxRetryAfterMs;
    capped = true;
  }
  return {
    delayMs: delay,
    source: header != null && header >= backoff ? 'retry-after' : 'backoff',
    capped,
  };
}
