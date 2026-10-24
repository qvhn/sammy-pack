/**
 * Per-agent token ceiling — cost-weighted accounting + trip diagnostics
 * (a legitimate hours-long supervision phase burned the 30M ceiling in ~20
 * minutes).
 *
 * The breaker used to sum RAW tokens, so `cache_read_input_tokens` — the
 * same context re-read every turn at ~10% the price of a fresh token —
 * dominated, making the counter the time-integral of context size: it grew
 * with DURATION, not waste. It now counts cost-weighted
 * ("input-equivalent") tokens via the pure ledger, so a flat cached loop is
 * cheap and a genuine runaway still trips.
 */

import {
  TokenLedger,
  ceilingVerdict,
  formatCeilingShape,
  CACHE_READ_WEIGHT,
  CACHE_WRITE_WEIGHT,
  OUTPUT_WEIGHT,
} from '../src/server/token-ledger';
import {
  runOrchestration,
  type RunEvent,
  type StreamFn,
} from '../src/llm/executor';
import type { Node } from '../src/types';

/** One turn of a healthy supervision loop: tiny fresh input + a big CACHED
 *  context re-read + a small reply. Raw = 40,300; weighted = 5,100. */
const FLAT_TURN = {
  input_tokens: 100,
  cache_read_input_tokens: 40_000,
  output_tokens: 200,
};
const RAW_PER_FLAT_TURN = 40_300;
const WEIGHTED_PER_FLAT_TURN = 100 + 40_000 * CACHE_READ_WEIGHT + 200 * OUTPUT_WEIGHT;

describe('TokenLedger — weights encode price, not volume', () => {
  test('each class is weighted by its real cost relative to fresh input', () => {
    const l = new TokenLedger();
    l.record({
      input_tokens: 1_000,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: 1_000,
      output_tokens: 1_000,
    });
    expect(l.rawTokens).toBe(4_000);
    expect(l.weightedTokens).toBe(
      1_000 + 1_000 * CACHE_WRITE_WEIGHT + 1_000 * CACHE_READ_WEIGHT + 1_000 * OUTPUT_WEIGHT,
    );
    // The whole point: a re-read cached token must cost far less than fresh.
    expect(CACHE_READ_WEIGHT).toBeLessThan(1);
  });

  test('a flat cached loop survives a ceiling that RAW accounting would trip', () => {
    const TURNS = 20;
    const l = new TokenLedger();
    for (let i = 0; i < TURNS; i++) l.record(FLAT_TURN);

    // Ceiling above 20 weighted turns (~102k) but far BELOW 20 raw turns
    // (~806k) — exactly the regime raw accounting kills a healthy loop in.
    const ceiling = 300_000;
    expect(RAW_PER_FLAT_TURN * TURNS).toBeGreaterThan(ceiling);
    expect(l.weightedTokens).toBe(WEIGHTED_PER_FLAT_TURN * TURNS);
    expect(l.exceeded(ceiling)).toBe(false);
  });

  test('cache reads are discounted, not free — enough of them still trip it', () => {
    const l = new TokenLedger();
    for (let i = 0; i < 200; i++) l.record(FLAT_TURN);
    expect(l.exceeded(500_000)).toBe(true);
  });

  test('ceiling 0 disables the breaker entirely', () => {
    const l = new TokenLedger();
    for (let i = 0; i < 1_000; i++) l.record(FLAT_TURN);
    expect(l.exceeded(0)).toBe(false);
  });
});

describe('trip diagnostics — runaway vs long legitimate work', () => {
  test('FLAT context ⇒ verdict points at the ceiling, not the agent', () => {
    const l = new TokenLedger(1_000);
    for (let i = 0; i < 200; i++) l.record(FLAT_TURN);
    l.noteCompaction();
    const d = l.diagnostics(1_000 + 90 * 60_000);

    expect(d.contextGrew).toBe(false);
    expect(d.turns).toBe(200);
    expect(d.compactions).toBe(1);
    expect(d.rawTokens).toBe(RAW_PER_FLAT_TURN * 200);
    expect(ceilingVerdict(d)).toMatch(/context stayed FLAT/i);
    expect(ceilingVerdict(d)).toContain('maxAgentTokens');
    // Loop shape is diagnosable from a log line alone.
    expect(formatCeilingShape(d)).toMatch(/turns=200/);
    expect(formatCeilingShape(d)).toMatch(/elapsed=90min/);
    expect(formatCeilingShape(d)).toMatch(/compactions=1/);
  });

  test('GROWING context ⇒ verdict points at the agent', () => {
    // Fresh (uncached) input climbing every turn — the sim-vision pathology.
    const l = new TokenLedger();
    for (let i = 1; i <= 40; i++) {
      l.record({ input_tokens: 5_000 * i, output_tokens: 500 });
    }
    const d = l.diagnostics();
    expect(d.contextGrew).toBe(true);
    expect(d.firstPromptTokens).toBe(5_000);
    expect(d.lastPromptTokens).toBe(200_000);
    expect(ceilingVerdict(d)).toMatch(/context GREW/i);
    expect(ceilingVerdict(d)).toMatch(/tool outputs|poll less often/i);
  });

  test('a modest warm-up is not mistaken for runaway growth', () => {
    const l = new TokenLedger();
    l.record({ input_tokens: 10_000 });
    l.record({ input_tokens: 12_000 }); // 1.2× — under the 1.5× bar
    expect(l.diagnostics().contextGrew).toBe(false);
  });
});

describe('executor — SDK compaction surfaces as a run event', () => {
  test('a compaction chunk becomes phase-compacted with its before/after sizes', async () => {
    const streamFn: StreamFn = async function* () {
      yield { type: 'text-delta', text: 'working' };
      yield {
        type: 'compaction',
        trigger: 'auto',
        preTokens: 150_000,
        postTokens: 20_000,
      };
      yield { type: 'text-delta', text: 'still here' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const orchestration: Node = {
      name: 'flow',
      phases: [{ name: 'long-phase', agent: 'agents/a.md' }],
    };
    const events: RunEvent[] = [];
    for await (const ev of runOrchestration({
      orchestration,
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      streamFn,
      waitForApproval: async () => true,
      cancelled: { v: false },
      agentsOverride: [{ name: 'a', raw: '---\nname: a\n---\nAgent A.' }],
      orchestrationsOverride: [],
    })) {
      events.push(ev);
    }
    expect(events.find(e => e.type === 'phase-compacted')).toMatchObject({
      phaseName: 'long-phase',
      trigger: 'auto',
      preTokens: 150_000,
      postTokens: 20_000,
    });
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });
});

describe('compaction sampling passes (usage.iterations)', () => {
  // VERIFIED against the Anthropic SDK typings: `usage.iterations` is
  // `Array<BetaMessageIterationUsage | BetaCompactionIterationUsage | …>`,
  // each carrying its own input/output/cache token counts. With threshold
  // compaction on, the extra summarization pass lives ONLY there — a
  // ceiling reading the top level alone under-counts exactly when the
  // agent is doing the long work that triggers compaction.
  const TURN_WITH_COMPACTION = {
    // Top-level reports the message pass only.
    input_tokens: 100,
    cache_read_input_tokens: 40_000,
    output_tokens: 200,
    iterations: [
      {
        type: 'compaction',
        input_tokens: 0,
        cache_read_input_tokens: 150_000,
        cache_creation_input_tokens: 20_000,
        output_tokens: 3_000,
      },
      {
        type: 'message',
        input_tokens: 100,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 0,
        output_tokens: 200,
      },
    ],
  };

  test('the compaction pass is counted, not dropped', () => {
    const withIterations = new TokenLedger();
    withIterations.record(TURN_WITH_COMPACTION);

    const topLevelOnly = new TokenLedger();
    topLevelOnly.record({
      input_tokens: 100,
      cache_read_input_tokens: 40_000,
      output_tokens: 200,
    });

    // The summarization pass is real spend — 20k cache writes + 3k output.
    expect(withIterations.weightedTokens).toBeGreaterThan(
      topLevelOnly.weightedTokens,
    );
    const compactionCost =
      150_000 * CACHE_READ_WEIGHT + 20_000 * CACHE_WRITE_WEIGHT + 3_000 * OUTPUT_WEIGHT;
    expect(withIterations.weightedTokens).toBeCloseTo(
      topLevelOnly.weightedTokens + compactionCost,
      6,
    );
  });

  test('the message pass is not double-counted with the top level', () => {
    const l = new TokenLedger();
    l.record(TURN_WITH_COMPACTION);
    // Raw = the two iterations only (190.2k + 40.3k), NOT plus the
    // duplicated top-level message pass.
    expect(l.rawTokens).toBe(173_000 + 40_300);
  });

  test('a multi-pass turn is ONE turn, and the trajectory tracks the message pass', () => {
    const l = new TokenLedger();
    l.record(TURN_WITH_COMPACTION);
    const d = l.diagnostics();
    expect(d.turns).toBe(1);
    // 40.1k (the message), not 170k (the compaction pass) — otherwise a
    // compaction would masquerade as a context explosion.
    expect(d.lastPromptTokens).toBe(40_100);
  });
});
