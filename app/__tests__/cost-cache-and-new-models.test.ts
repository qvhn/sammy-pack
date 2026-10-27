/**
 * Cost covers what a long Claude agent really spends: prompt-cache reads / writes (most of an agent's input in
 * Claude Code login mode) and Claude models newer than the price table, which used to cost 0 and slipped past
 * every spend cap.
 */
import { costUsd, knownModel } from '../src/llm/pricing';
import { TokenLedger } from '../src/server/token-ledger';
import { runOrchestration, type RunEvent, type StreamFn } from '../src/llm/executor';

jest.mock('../src/api', () => ({
  listAgents: async () => [{ name: 'a', raw: '---\nname: a\n---\nYou are agent A.' }],
  listOrchestrations: async () => [],
}));

describe('costUsd — prompt cache', () => {
  it('prices cache writes at 1.25x and cache reads at 0.1x the input price', () => {
    expect(costUsd('claude-sonnet-4-6', 0, 0, { cacheWriteTokens: 1_000_000 })).toBeCloseTo(3.75);
    expect(costUsd('claude-sonnet-4-6', 0, 0, { cacheReadTokens: 1_000_000 })).toBeCloseTo(0.3);
  });

  it('is unchanged when no cache tokens are reported (other providers, older callers)', () => {
    expect(costUsd('claude-sonnet-4-6', 7, 233)).toBeCloseTo(0.003516, 6);
    expect(costUsd('gpt-4o', 1_000_000, 0, {})).toBeCloseTo(2.5);
  });
});

describe('costUsd — Claude models newer than the table', () => {
  it('prices an unlisted Sonnet like the listed Sonnets', () => {
    expect(costUsd('claude-sonnet-5-5', 1_000_000, 0)).toBeCloseTo(3);
    expect(costUsd('claude-sonnet-5-5', 0, 1_000_000)).toBeCloseTo(15);
  });

  it('prices an unlisted Opus like the most expensive listed Opus', () => {
    expect(costUsd('claude-opus-5-5', 1_000_000, 1_000_000)).toBeCloseTo(90);
  });

  it('prices an unknown Claude family like the most expensive listed Claude model', () => {
    expect(costUsd('claude-fable-5-1', 1_000_000, 0)).toBeCloseTo(15);
  });

  it('still flags them as unlisted, and still charges 0 for non-Claude models with no entry', () => {
    expect(knownModel('claude-sonnet-5-5')).toBe(false);
    expect(costUsd('unknown-model', 1000, 1000)).toBe(0);
  });
});

describe('TokenLedger — cache counters', () => {
  it('reports plain cache read / write totals next to input / output', () => {
    const ledger = new TokenLedger(0);
    ledger.record({ input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 1_500 });
    ledger.record({ input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 21_000 });
    expect(ledger.inputTokens).toBe(5);
    expect(ledger.outputTokens).toBe(50);
    expect(ledger.cacheReadTokens).toBe(41_000);
    expect(ledger.cacheWriteTokens).toBe(1_500);
  });
});

describe('executor — an agent phase is charged for its cache tokens', () => {
  it('folds done.usage cache tokens into the phase cost and the run cost event', async () => {
    const stream: StreamFn = async function* () {
      yield { type: 'text-delta', text: 'done' };
      yield {
        type: 'done',
        usage: { inputTokens: 26, outputTokens: 6_173, cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000 },
      };
    };
    const events: RunEvent[] = [];
    for await (const ev of runOrchestration({
      orchestration: { name: 'flow', phases: [{ name: 'p', agent: 'agents/a.md' }] },
      apiKey: 'k',
      model: 'claude-sonnet-5-5',
      streamFn: stream,
      waitForApproval: async () => true,
      cancelled: { v: false },
    })) {
      events.push(ev);
    }
    // sonnet: $3 in / $15 out per M; reads 0.1x, writes 1.25x the input price
    const expected = (26 * 3 + 6_173 * 15 + 2_000_000 * 0.3 + 100_000 * 3.75) / 1_000_000;
    const end = events.find(e => e.type === 'phase-end' && e.phaseName === 'p');
    if (end?.type !== 'phase-end') throw new Error('expected a phase-end for p');
    expect(end.costUsd).toBeCloseTo(expected, 6);
    const cost = [...events].reverse().find(e => e.type === 'cost');
    if (cost?.type !== 'cost') throw new Error('expected a cost event');
    expect(cost.costUsd).toBeCloseTo(expected, 6);
  });
});
