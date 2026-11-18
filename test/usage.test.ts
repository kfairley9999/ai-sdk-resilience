import { describe, expect, it } from 'vitest';
import { emptyUsage, sumUsage, usageToJson } from '../src/usage.js';
import { tokens } from './support.js';

describe('usage accounting', () => {
  it('sums each attempt once and leaves missing fields undefined', () => {
    const total = sumUsage([
      tokens(10, 4),
      {
        inputTokens: { total: undefined, noCache: undefined, cacheRead: 2, cacheWrite: undefined },
        outputTokens: { total: 6, text: 6, reasoning: undefined },
      },
    ]);
    expect(total.inputTokens.total).toBe(10);
    expect(total.inputTokens.cacheRead).toBe(2);
    expect(total.outputTokens.total).toBe(10);
    expect(total.outputTokens.reasoning).toBe(0);
    expect(sumUsage([]).inputTokens.total).toBeUndefined();
    expect(usageToJson(emptyUsage()).inputTokens).toBeNull();
  });
});
