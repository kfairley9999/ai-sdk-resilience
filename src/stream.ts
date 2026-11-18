import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
} from '@ai-sdk/provider';
import { accountingMetadata } from './usage.js';
import type { UsageAccounting } from './types.js';

const ID_PARTS = new Set([
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-end',
  'tool-call',
  'tool-result',
]);

export function textFromParts(parts: readonly LanguageModelV4StreamPart[]): string {
  let text = '';
  for (const part of parts) {
    if (part.type === 'text-delta') text += part.delta;
  }
  return text;
}

function withId(part: LanguageModelV4StreamPart, suffix: string): LanguageModelV4StreamPart {
  if (!('id' in part) || typeof part.id !== 'string' || !ID_PARTS.has(part.type)) return part;
  return { ...part, id: `${part.id}${suffix}` };
}

function closeOpenBlocks(parts: LanguageModelV4StreamPart[]): LanguageModelV4StreamPart[] {
  const openText = new Set<string>();
  const openReasoning = new Set<string>();
  for (const part of parts) {
    if (part.type === 'text-start') openText.add(part.id);
    if (part.type === 'text-end') openText.delete(part.id);
    if (part.type === 'reasoning-start') openReasoning.add(part.id);
    if (part.type === 'reasoning-end') openReasoning.delete(part.id);
  }
  const closed = [...parts];
  for (const id of openText) closed.push({ type: 'text-end', id });
  for (const id of openReasoning) closed.push({ type: 'reasoning-end', id });
  return closed;
}

function keepLastFinish(parts: LanguageModelV4StreamPart[]): LanguageModelV4StreamPart[] {
  let last = -1;
  parts.forEach((part, index) => {
    if (part.type === 'finish') last = index;
  });
  if (last === -1) return parts;
  return parts.filter((part, index) => part.type !== 'finish' || index === last);
}

function annotateFinish(
  part: Extract<LanguageModelV4StreamPart, { type: 'finish' }>,
  usage: LanguageModelV4Usage,
  accounting: UsageAccounting,
): LanguageModelV4StreamPart {
  const metadata: SharedV4ProviderMetadata = {
    ...(part.providerMetadata ?? {}),
    'ai-sdk-resilience': accountingMetadata(accounting) as SharedV4ProviderMetadata[string],
  };
  return { ...part, usage, providerMetadata: metadata };
}

/**
 * Build the stream the caller sees.
 * Restart mode forwards only the winning attempt.
 * Continue mode prepends partial text blocks and still emits a single finish,
 * whose usage is the winner. Earlier attempts stay in `accounting.billed`.
 */
export function assembleStream(
  partial: readonly LanguageModelV4StreamPart[] | undefined,
  winner: readonly LanguageModelV4StreamPart[],
  usage: LanguageModelV4Usage,
  accounting: UsageAccounting,
): LanguageModelV4StreamPart[] {
  const winnerBody = keepLastFinish(
    winner.filter((part) => part.type !== 'error'),
  );
  let combined: LanguageModelV4StreamPart[];
  if (partial && partial.length > 0) {
    const head = closeOpenBlocks(partial.filter((part) => part.type !== 'error' && part.type !== 'finish'));
    const tail = winnerBody
      .filter((part) => part.type !== 'stream-start')
      .map((part) => withId(part, ':next'));
    combined = [...head, ...tail];
  } else {
    combined = [...winnerBody];
  }

  let sawFinish = false;
  const annotated = combined.map((part) => {
    if (part.type !== 'finish') return part;
    sawFinish = true;
    return annotateFinish(part, usage, accounting);
  });
  if (!sawFinish) {
    annotated.push(
      annotateFinish(
        {
          type: 'finish',
          usage,
          finishReason: { unified: 'stop', raw: undefined },
        },
        usage,
        accounting,
      ),
    );
  }
  return annotated;
}

export function streamFromParts(parts: readonly LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const part = parts[index];
      index += 1;
      if (part === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(part);
    },
  });
}

export function continuePrompt(prompt: LanguageModelV4Prompt, partialText: string): LanguageModelV4Prompt {
  return [
    ...prompt,
    { role: 'assistant', content: [{ type: 'text', text: partialText }] },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Continue exactly where the assistant left off. Do not repeat text that was already written.',
        },
      ],
    },
  ];
}

export async function readModelStream(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  signal: AbortSignal,
): Promise<{
  parts: LanguageModelV4StreamPart[];
  text: string;
  usage?: LanguageModelV4Usage;
  error?: unknown;
}> {
  const reader = stream.getReader();
  const parts: LanguageModelV4StreamPart[] = [];
  let text = '';
  let usage: LanguageModelV4Usage | undefined;
  let error: unknown;
  try {
    while (true) {
      if (signal.aborted) {
        error = signal.reason;
        break;
      }
      const next = await reader.read();
      if (next.done) break;
      const part = next.value;
      if (part.type === 'error') {
        error = part.error;
        break;
      }
      if (part.type === 'text-delta') text += part.delta;
      if (part.type === 'finish') usage = part.usage;
      parts.push(part);
    }
  } catch (caught) {
    error = caught;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The lock may already be released after a failed read.
    }
    if (error !== undefined) {
      try {
        await stream.cancel(error);
      } catch {
        // Cancellation is best-effort once the attempt has failed.
      }
    }
  }
  return error === undefined ? { parts, text, usage } : { parts, text, usage, error };
}
