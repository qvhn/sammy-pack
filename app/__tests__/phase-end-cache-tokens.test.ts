/**
 * A phase's `phase-end` carries the cached input it read alongside its
 * uncached input, so the pages can count all of it. An agent session reads
 * most of its prompt from cache, and showing uncached input alone made a call
 * that read thousands of tokens report "3t in".
 */

import { runOrchestration, type RunEvent, type StreamFn } from '../src/llm/executor';
import type { HarnessToolSpec } from '../src/llm/harness';
import { foldSpend } from '../src/lib/spend';
import type { Node } from '../src/types';

const agents = [{ name: 'plain', raw: '---\nname: plain\n---\nDo it.' }];
const usage = { inputTokens: 3, outputTokens: 10, cacheReadTokens: 12_000, cacheWriteTokens: 4_000 };

async function run(orchestration: Node, streamFn: StreamFn) {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: '',
    model: 'claude-sonnet-4-6',
    streamFn,
    initialInput: 'go',
    waitForApproval: async () => true,
    cancelled: { v: false },
    agentsOverride: agents,
    orchestrationsOverride: [],
    harnessSupported: true,
    allowAgentTools: true,
  })) {
    events.push(ev);
  }
  return events;
}

const endOf = (events: RunEvent[], phase: string) =>
  events.find(e => e.type === 'phase-end' && e.phaseName === phase);

describe("a phase-end's cached input", () => {
  it('is on a pipeline phase and counted by the spend fold', async () => {
    const streamFn: StreamFn = () =>
      (async function* () {
        yield { type: 'text-delta' as const, text: 'ok' };
        yield { type: 'done' as const, usage };
      })();
    const events = await run({ name: 'o', phases: [{ name: 'p', agent: 'agents/plain.md' }] }, streamFn);
    expect(endOf(events, 'p')).toMatchObject({ inputTokens: 3, cacheReadTokens: 12_000, cacheWriteTokens: 4_000 });
    expect(foldSpend(events as never[]).inputTokens).toBe(16_003);
  });

  it('is on a harness step, attributed to the step that read it', async () => {
    const streamFn: StreamFn = params => {
      const t = Object.fromEntries(
        (params.harness?.tools ?? []).map((x: HarnessToolSpec) => [x.name, (a: Record<string, string>) => x.handler(a)]),
      );
      return (async function* () {
        await t.start_step({ step: 'p' });
        yield { type: 'usage' as const, usage };
        await t.complete_step({ step: 'p', output: 'done' });
        yield { type: 'done' as const, usage };
      })();
    };
    const events = await run(
      { name: 'o', execution: 'harness', phases: [{ name: 'p', agent: 'agents/plain.md' }] },
      streamFn,
    );
    expect(endOf(events, 'p')).toMatchObject({ inputTokens: 3, cacheReadTokens: 12_000, cacheWriteTokens: 4_000 });
    expect(foldSpend(events as never[]).inputTokens).toBe(16_003);
  });
});
