# Benchmark

Measured 2026-11-18T15:05:43.662Z on Node v22.23.4 (linux), 60 sequential `generateText` calls, seed 20261118.

| Strategy | Success | p50 ms | p95 ms | p99 ms | mean ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Plain AI SDK (one model, maxRetries 0) | 50.0% | 10.4 | 49 | 49.8 | 19 |
| ai-fallback 3.x (ordered switch, no backoff) | 100.0% | 22.2 | 59.6 | 61.7 | 26.6 |
| cockatiel (retry + breaker, primary only) | 40.0% | 18.8 | 48.5 | 55.9 | 24.7 |
| ai-sdk-resilience | 100.0% | 17.7 | 37.7 | 41.4 | 20.5 |

- Mock LanguageModelV4 providers. No network calls.
- generateText maxRetries is 0 so the SDK retry loop is not stacked on top.
- ai-fallback modelResetInterval is 1ms so each request starts on the primary. Its default is to stick to the fallback for 3 minutes.
- cockatiel retries and breaks the primary only. It has no model fallback and no view of AI SDK streams.
- Requests 24-31 are a forced primary 500 outage.
- p50/p95/p99 are over successful requests. p95AllMs includes failures.
- Delays use real timers. Re-running moves the numbers by a few milliseconds.
