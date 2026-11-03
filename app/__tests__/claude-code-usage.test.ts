/**
 * The browser's Claude Code client keeps the cached input the proxy reports.
 * A Claude Code session reads most of its prompt from cache; dropping those
 * counts priced the call as a few tokens of input and showed "3t in".
 */

import { streamClaudeCode } from '../src/llm/claude-code';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

function proxyReplying(...events: unknown[]) {
  const body = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  global.fetch = jest.fn(async () => new Response(body)) as unknown as typeof fetch;
}

async function lastUsage() {
  let usage: unknown;
  for await (const ev of streamClaudeCode({ model: 'claude-sonnet-4-6', system: 's', messages: [] })) {
    if (ev.type === 'done') usage = ev.usage;
  }
  return usage;
}

describe('the Claude Code client', () => {
  it('passes on cache reads and writes from the proxy', async () => {
    proxyReplying(
      { type: 'text-delta', text: 'hi' },
      { type: 'done', usage: { inputTokens: 3, outputTokens: 9, cacheReadTokens: 12_000, cacheWriteTokens: 4_000 } },
    );
    expect(await lastUsage()).toEqual({ inputTokens: 3, outputTokens: 9, cacheReadTokens: 12_000, cacheWriteTokens: 4_000 });
  });

  it('reports no cache fields when the proxy sends none', async () => {
    proxyReplying({ type: 'done', usage: { inputTokens: 5, outputTokens: 2 } });
    expect(await lastUsage()).toEqual({ inputTokens: 5, outputTokens: 2 });
  });
});
