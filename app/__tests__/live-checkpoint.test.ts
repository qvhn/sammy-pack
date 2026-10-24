/**
 * Tests for LIVE CHECKPOINTING — in-process re-runs skip completed leaves.
 *
 * `ctx.replayOutputs` used to be seeded only on RESUME, so an in-process
 * re-run of a composite (node `retry`, an `onStall` recover-and-re-run)
 * re-executed EVERY completed child alongside the one that actually failed —
 * cost amplification proportional to the composite's size. Leaves now
 * checkpoint their output the moment they succeed, so a re-run replays the
 * completed children exactly like a resume would: only the failed/stalled
 * leaf (which never checkpointed) re-executes.
 *
 * Also covered: loop iterations stay unaffected (distinct replay scopes per
 * iteration), and the `onStall` RECOVER phase re-runs on every stall attempt
 * (its executions are attempt-scoped — a side-effect fix-up must never be
 * satisfied by replaying its previous output).
 *
 * Harness: caller-supplied spy streamFn counting dispatches per agent (via
 * the system prompt). Stall cases run on a real clock with tiny stall
 * windows + slow-but-finite streams, the same approach as
 * stall-recovery-hook.test.ts (a leaf's teardown awaits the stream's
 * `.return()`, so a permanent hang would wedge it).
 */

import {
  runOrchestration,
  type RunEvent,
  type StreamFn,
} from '../src/llm/executor';
import type { AgentFile } from '../src/api';
import type { Node } from '../src/types';

const AGENTS: AgentFile[] = [
  { name: 'a', raw: '---\nname: a\n---\nAgent A.' },
  { name: 'b', raw: '---\nname: b\n---\nAgent B.' },
  { name: 'fixer', raw: '---\nname: fixer\n---\nFixer agent.' },
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function collect(
  orchestration: Node,
  streamFn: StreamFn,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    streamFn,
    waitForApproval: async () => true,
    cancelled: { v: false },
    agentsOverride: AGENTS,
    orchestrationsOverride: [],
  })) {
    events.push(ev);
  }
  return events;
}

describe('composite retry — only the failed leaf re-runs', () => {
  test('phases[A ok, B fails-once] with retry on the composite: A dispatches ONCE, B twice, run succeeds', async () => {
    const dispatches = { a: 0, b: 0 };
    const streamFn: StreamFn = async function* (params) {
      const sys = params.system ?? '';
      if (sys.includes('Agent A')) {
        dispatches.a += 1;
        yield { type: 'text-delta', text: 'a-out' };
      } else {
        dispatches.b += 1;
        if (dispatches.b === 1) throw new Error('B failed on the first pass');
        yield { type: 'text-delta', text: 'b-out' };
      }
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };

    const events = await collect(
      {
        name: 'flow',
        phases: [
          {
            name: 'wrap',
            retry: { times: 1, initialMs: 1 },
            phases: [
              { name: 'A', agent: 'agents/a.md' },
              { name: 'B', agent: 'agents/b.md' },
            ],
          },
        ],
      },
      streamFn,
    );

    // The composite retried…
    expect(events.some(e => e.type === 'node-retried' && e.phaseName === 'wrap')).toBe(true);
    // …but A's completed work REPLAYED instead of re-dispatching.
    expect(dispatches.a).toBe(1);
    expect(dispatches.b).toBe(2);
    // A emitted TWO phase-ends (real run + zero-cost replay) with the same output.
    const aEnds = events.filter(
      e => e.type === 'phase-end' && e.phaseName === 'A',
    );
    expect(aEnds).toHaveLength(2);
    if (aEnds[1]?.type === 'phase-end') {
      expect(aEnds[1].output).toBe('a-out');
      expect(aEnds[1].inputTokens).toBe(0); // replayed, not re-billed
    }
    expect(events.some(e => e.type === 'run-end')).toBe(true);
    expect(events.some(e => e.type === 'run-error')).toBe(false);
  });

  test('loop iterations are UNAFFECTED — each iteration re-runs its body (distinct scopes)', async () => {
    let stepDispatches = 0;
    const streamFn: StreamFn = async function* () {
      stepDispatches += 1;
      yield { type: 'text-delta', text: `pass-${stepDispatches}` };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const events = await collect(
      {
        name: 'flow',
        phases: [
          {
            name: 'refine',
            loop: {
              maxIterations: 2,
              body: { name: 'step', agent: 'agents/a.md' },
            },
          },
        ],
      },
      streamFn,
    );
    // Two loop iterations = two REAL dispatches — iteration 2 must not replay
    // iteration 1's checkpoint (scopes `refine@1/step` vs `refine@2/step`).
    expect(stepDispatches).toBe(2);
    expect(
      events.filter(e => e.type === 'loop-iteration' && e.phaseName === 'refine'),
    ).toHaveLength(2);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });
});

describe('onStall recover-and-re-run — completed siblings replay, the recover phase does not', () => {
  /** Build the stall scenario: wrap{phases:[good, wedge], onStall{recover:fix}}.
   *  `wedge` stalls (one delta then silence past its tiny stallTimeout) for
   *  its first `stallsBeforeSuccess` dispatches, then succeeds. */
  function stallHarness(stallsBeforeSuccess: number, maxRetries: number) {
    const dispatches = { good: 0, wedge: 0, fix: 0 };
    const streamFn: StreamFn = async function* (params) {
      const sys = params.system ?? '';
      if (sys.includes('Agent A')) {
        dispatches.good += 1;
        yield { type: 'text-delta', text: 'good-out' };
        yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      if (sys.includes('Fixer')) {
        dispatches.fix += 1;
        yield { type: 'text-delta', text: 'fixed' };
        yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      // The wedge: a heartbeat, then silence past the 0.2s stall window on
      // early dispatches (slow-but-FINITE so teardown settles), success after.
      dispatches.wedge += 1;
      yield { type: 'text-delta', text: 'starting…' };
      if (dispatches.wedge <= stallsBeforeSuccess) {
        await sleep(600);
        yield { type: 'text-delta', text: 'too late' };
      }
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const orchestration: Node = {
      name: 'flow',
      phases: [
        {
          name: 'wrap',
          onStall: {
            recover: { name: 'fix', agent: 'agents/fixer.md' },
            maxRetries,
          },
          phases: [
            { name: 'good', agent: 'agents/a.md' },
            { name: 'wedge', agent: 'agents/b.md', stallTimeout: 0.2 },
          ],
        },
      ],
    };
    return { dispatches, streamFn, orchestration };
  }

  test('one stall: good replays on the re-run; wedge re-runs; recover ran once', async () => {
    const { dispatches, streamFn, orchestration } = stallHarness(1, 1);
    const events = await collect(orchestration, streamFn);
    expect(
      events.some(e => e.type === 'stall-recovery' && e.phaseName === 'wrap'),
    ).toBe(true);
    expect(dispatches.good).toBe(1); // replayed, not re-run
    expect(dispatches.wedge).toBe(2); // stalled once, succeeded on the re-run
    expect(dispatches.fix).toBe(1);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
    expect(events.some(e => e.type === 'run-error')).toBe(false);
  }, 15000);

  test('two stalls: the RECOVER phase re-runs per attempt (attempt-scoped — never replays its fix-up)', async () => {
    const { dispatches, streamFn, orchestration } = stallHarness(2, 2);
    const events = await collect(orchestration, streamFn);
    expect(dispatches.good).toBe(1);
    expect(dispatches.wedge).toBe(3); // stall, stall, success
    // The whole point of onStall.recover is the SIDE EFFECT — the second
    // attempt must genuinely re-run it, not replay attempt 1's checkpoint.
    expect(dispatches.fix).toBe(2);
    expect(
      events.filter(e => e.type === 'stall-recovery' && e.phaseName === 'wrap'),
    ).toHaveLength(2);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
    expect(events.some(e => e.type === 'run-error')).toBe(false);
  }, 15000);
});
