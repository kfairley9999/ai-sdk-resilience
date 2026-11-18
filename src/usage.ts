import type { LanguageModelV4Usage } from '@ai-sdk/provider';
import type { UsageAccounting, UsageJson } from './types.js';

function add(left: number | undefined, right: number | undefined): number | undefined {
  if (left == null && right == null) return undefined;
  return (left ?? 0) + (right ?? 0);
}

export function emptyUsage(): LanguageModelV4Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}

export function hasAnyTokens(usage: LanguageModelV4Usage | undefined): boolean {
  if (!usage) return false;
  const values = [
    usage.inputTokens?.total,
    usage.inputTokens?.noCache,
    usage.inputTokens?.cacheRead,
    usage.inputTokens?.cacheWrite,
    usage.outputTokens?.total,
    usage.outputTokens?.text,
    usage.outputTokens?.reasoning,
  ];
  return values.some((value) => value != null);
}

/** Sum distinct attempts. Undefined fields stay undefined until one attempt reports them. */
export function sumUsage(usages: readonly LanguageModelV4Usage[]): LanguageModelV4Usage {
  return usages.reduce<LanguageModelV4Usage>((total, usage) => {
    return {
      inputTokens: {
        total: add(total.inputTokens.total, usage.inputTokens?.total),
        noCache: add(total.inputTokens.noCache, usage.inputTokens?.noCache),
        cacheRead: add(total.inputTokens.cacheRead, usage.inputTokens?.cacheRead),
        cacheWrite: add(total.inputTokens.cacheWrite, usage.inputTokens?.cacheWrite),
      },
      outputTokens: {
        total: add(total.outputTokens.total, usage.outputTokens?.total),
        text: add(total.outputTokens.text, usage.outputTokens?.text),
        reasoning: add(total.outputTokens.reasoning, usage.outputTokens?.reasoning),
      },
    };
  }, emptyUsage());
}

export function usageToJson(usage: LanguageModelV4Usage | undefined): UsageJson {
  return {
    inputTokens: usage?.inputTokens?.total ?? null,
    outputTokens: usage?.outputTokens?.total ?? null,
    reasoningTokens: usage?.outputTokens?.reasoning ?? null,
    cacheReadTokens: usage?.inputTokens?.cacheRead ?? null,
    cacheWriteTokens: usage?.inputTokens?.cacheWrite ?? null,
  };
}

export function accountingMetadata(accounting: UsageAccounting): Record<string, unknown> {
  return {
    reportedUsage: usageToJson(accounting.reported),
    billedUsage: usageToJson(accounting.billed),
    attemptCount: accounting.attempts.length,
    winner: accounting.winner,
    note: 'result.usage is the winning attempt only. billedUsage sums each attempt once and is not included in result.usage.',
  };
}
