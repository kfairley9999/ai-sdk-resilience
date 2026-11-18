/** Nearest-rank percentile. `percentile(samples, 95)` is the sample at `ceil(0.95 * n) - 1`. */
export function percentile(samples: readonly number[], p: number): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export class LatencyWindow {
  readonly #samples: number[] = [];

  constructor(private readonly capacity: number) {}

  record(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    this.#samples.push(latencyMs);
    while (this.#samples.length > this.capacity) this.#samples.shift();
  }

  get size(): number {
    return this.#samples.length;
  }

  value(p: number): number | undefined {
    return percentile(this.#samples, p);
  }
}
