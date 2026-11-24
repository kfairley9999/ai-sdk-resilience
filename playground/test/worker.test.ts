import { describe, expect, it } from 'vitest';
import worker, { contentSecurityPolicy } from '../src/worker.js';
import { page } from '../src/page.js';

const BASE = 'https://playground.test';
const providers = [
  { provider: 'a', modelId: 'one', failureRate: 0, latencyMs: 20 },
  { provider: 'b', modelId: 'two', failureRate: 0, latencyMs: 20 },
];

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/api/run`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
}

describe('playground worker', () => {
  it('serves the page with a CSP that allows exactly its inline script and style', async () => {
    const response = await worker.fetch(new Request(`${BASE}/`));
    expect(response.status).toBe(200);
    const csp = response.headers.get('content-security-policy') ?? '';
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';
    const style = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1] ?? '';
    const hash = async (text: string) => {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
      return `'sha256-${btoa(String.fromCharCode(...digest))}'`;
    };
    expect(csp).toContain(`script-src ${await hash(script)}`);
    expect(csp).toContain(`style-src ${await hash(style)}`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await contentSecurityPolicy()).toBe(csp);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(await response.text()).toContain('github.com/kfairley9999/ai-sdk-resilience');
    const head = await worker.fetch(new Request(`${BASE}/`, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('answers wrong methods with 405 and unknown routes with 404', async () => {
    const get = await worker.fetch(new Request(`${BASE}/api/run`));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const postPage = await worker.fetch(new Request(`${BASE}/`, { method: 'POST' }));
    expect(postPage.status).toBe(405);
    const missing = await worker.fetch(new Request(`${BASE}/nope`));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('rejects malformed, oversized, and key-bearing bodies without echoing parser internals', async () => {
    const bad = await worker.fetch(post('nope'));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/^Send a JSON object/);
    expect((await worker.fetch(post('[]'))).status).toBe(400);
    expect((await worker.fetch(post(JSON.stringify({ apiKey: 'x', providers })))).status).toBe(400);
    const big = await worker.fetch(post(JSON.stringify({ providers, pad: 'x'.repeat(20_000) })));
    expect(big.status).toBe(413);
    const declared = await worker.fetch(post('{}', { 'content-length': String(1_000_000) }));
    expect(declared.status).toBe(413);
  });

  it('streams a batch as NDJSON and ends with a summary', async () => {
    const response = await worker.fetch(post(JSON.stringify({ batchSize: 4, hedge: false, providers })));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as { type: string; successRate?: number });
    const results = lines.filter((line) => line.type === 'result');
    expect(results).toHaveLength(4);
    const summary = lines.at(-1);
    expect(summary?.type).toBe('summary');
    expect(summary?.successRate).toBe(1);
  });
});
