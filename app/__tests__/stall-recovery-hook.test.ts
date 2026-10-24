/**
 * Tests for the stall → recovery hook (`onStall`).
 *
 * When the stall watchdog aborts a node (no progress within `stallTimeout`) and
 * the node declares `onStall: { recover, maxRetries }`, the executor runs the
 * `recover` phase for its side effect and then RE-RUNS the stalled node, up to
 * `maxRetries` times, instead of letting the stall abort the run.
 *
 * The streams here are driven on a real clock (same approach as
 * composite-resilience.test.ts): a provider stream yields one progress delta —
 * so the stall watchdog sees a heartbeat — and then goes silent past a tiny
 * `stallTimeout` (but FINITE, so its teardown settles — a leaf's withTimeout
 * awaits the stream's `.return()`, which a permanent hang would wedge). A closure
 * counter lets a stream stall on its first N dispatches and SUCCEED on the
 * re-run, so a recovery+re-run is observed end-to-end with only millisecond
 * waits.
 */

import {
  runOrchestration,
  type RunEvent,
  type StreamFn,
} from '../src/llm/executor';
import type { Node } from '../src/types';

// ── Mock the default (Anthropic) stream — same shape as composite-resilience ──
const mockState: {
  responder: (sys: string, user: string) => Promise<string> | string;
} = { responder: () => '' };

jest.mock('../src/llm/anthropic', () => ({
  streamAnthropic(params: {
    system?: string;
    messages: { role: string; content: string }[];
  }) {
    const sys = params.system ?? '';
    const user = params.messages[0]?.content ?? '';
    const result = Promise.resolve(mockState.responder(sys, user));
    let stage = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (stage === 0) {
              stage = 1;
              return { value: { type: 'text-delta', text: await result }, done: false };
            }
            if (stage === 1) {
              stage = 2;
              return {
                value: { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
                done: false,
              };
            }
            return { value: undefined, done: true };
          },
          return() {
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  },
}));

jest.mock('../src/api', () => ({
  listAgents: async () => [
    { name: 'worker', raw: '---\nname: worker\n---\nWorker agent.' },
    { name: 'fixer', raw: '---\nname: fixer\n---\nFixer agent.' },
  ],
  listOrchestrations: async () => [],
}));

function setResponder(
  fn: (sys: string, user: string) => Promise<string> | string,
): void {
  mockState.responder = fn;
}

async function runToCompletion(
  orchestration: Node,
  opts?: {
    initialInput?: string;
    providerStreamFns?: Record<string, StreamFn>;
  },
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    initialInput: opts?.initialInput,
    waitForApproval: async () => true,
    cancelled: { v: false },
    providerStreamFns: opts?.providerStreamFns,
    allowAgentTools: true,
  })) {
    events.push(ev);
  }
  return events;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** How long a "stalling" dispatch goes silent after its heartbeat. Must be
 *  comfortably LONGER than the test nodes' `stallTimeout` (50ms) so the stall
 *  watchdog trips — but FINITE so the dispatch's teardown (`.return()`, which a
 *  leaf's withTimeout awaits) settles instead of wedging the test. A permanent
 *  hang can't be used for a LEAF stall (its teardown would never resolve — the
 *  reason composite-resilience uses a slow-but-resolving stream for leaf
 *  timeouts). Kept small so even several stalls stay well under the test budget. */
const STALL_SILENCE_MS = 200;

/** A provider stream that yields one heartbeat, goes silent past the stall
 *  window (tripping the watchdog), then resolves — so its `.return()` settles
 *  and the StallError can propagate. */
const stallingStream: StreamFn = async function* () {
  yield { type: 'text-delta', text: 'working…' };
  await sleep(STALL_SILENCE_MS);
  yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
};

/** A provider stream that completes quickly and cleanly. */
function okStream(text = 'done'): StreamFn {
  return async function* () {
    yield { type: 'text-delta', text };
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
  };
}

/** A provider stream that STALLS on its first N dispatches (tripping the stall
 *  watchdog each time) and then completes cleanly. Each `dispatchNode` re-run
 *  calls the streamFn afresh, so the closure counter advances per attempt. */
function stallThenSucceed(
  stallCount: number,
): { fn: StreamFn; calls: () => number } {
  let calls = 0;
  const fn: StreamFn = async function* (...args) {
    const n = calls++;
    if (n < stallCount) {
      yield* stallingStream(...(args as Parameters<StreamFn>));
      return;
    }
    yield* okStream('recovered-run')(...(args as Parameters<StreamFn>));
  };
  return { fn, calls: () => calls };
}

// ──────────────────────────────────────────────────────────────────────────
// onStall: recover + retry succeeds
// ──────────────────────────────────────────────────────────────────────────
describe('onStall — recover + re-run', () => {
  test('a node that stalls once, recovers, and re-runs successfully → run completes', async () => {
    setResponder(() => 'fixed it'); // the recovery agent (default Anthropic path)
    const { fn: workerStream, calls } = stallThenSucceed(1);

    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'flaky-worker',
            agent: 'agents/worker.md',
            provider: 'openai',
            stallTimeout: 0.05, // 50ms — the first dispatch hangs past this
            onStall: {
              recover: { name: 'kick', agent: 'agents/fixer.md' },
              maxRetries: 1,
            },
          },
        ],
      },
      { providerStreamFns: { openai: workerStream } },
    );

    // The watchdog tripped once…
    const stalled = events.filter(e => e.type === 'node-stalled');
    expect(stalled.length).toBeGreaterThanOrEqual(1);
    // …a stall-recovery was emitted for the stalled node…
    const recovery = events.find(e => e.type === 'stall-recovery');
    expect(recovery).toBeDefined();
    if (recovery?.type !== 'stall-recovery') throw new Error('expected stall-recovery');
    expect(recovery.phaseName).toBe('flaky-worker');
    expect(recovery.attempt).toBe(1);
    expect(recovery.maxRetries).toBe(1);
    // …the recovery phase ran…
    expect(events.some(e => e.type === 'phase-end' && e.phaseName === 'kick')).toBe(true);
    // …the worker was dispatched twice (initial hang + recovered re-run)…
    expect(calls()).toBe(2);
    // …and the run completed cleanly with the re-run's output.
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
    const workerEnd = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'flaky-worker',
    );
    expect(workerEnd).toBeDefined();
    if (workerEnd?.type !== 'phase-end') throw new Error('expected worker end');
    expect(workerEnd.output).toContain('recovered-run');
  }, 5000);

  test('stall-recovery is emitted BEFORE the recovery phase runs and the re-run', async () => {
    setResponder(() => 'fix');
    const { fn: workerStream } = stallThenSucceed(1);
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'w',
            agent: 'agents/worker.md',
            provider: 'openai',
            stallTimeout: 0.05,
            onStall: { recover: { name: 'kick', agent: 'agents/fixer.md' }, maxRetries: 1 },
          },
        ],
      },
      { providerStreamFns: { openai: workerStream } },
    );
    const recoveryIdx = events.findIndex(e => e.type === 'stall-recovery');
    const kickStartIdx = events.findIndex(
      e => e.type === 'phase-start' && e.phaseName === 'kick',
    );
    // the second phase-start for 'w' is the re-run
    const wStarts = events
      .map((e, i) => ({ e, i }))
      .filter(x => x.e.type === 'phase-start' && (x.e as { phaseName?: string }).phaseName === 'w')
      .map(x => x.i);
    expect(recoveryIdx).toBeGreaterThanOrEqual(0);
    expect(kickStartIdx).toBeGreaterThan(recoveryIdx); // recovery decision, then recovery phase
    expect(wStarts.length).toBe(2); // initial + re-run
    expect(wStarts[1]).toBeGreaterThan(kickStartIdx); // re-run after recovery
  }, 5000);
});

// ──────────────────────────────────────────────────────────────────────────
// onStall: retries exhausted → abort
// ──────────────────────────────────────────────────────────────────────────
describe('onStall — retries exhausted', () => {
  test('a node that keeps stalling past maxRetries aborts the run', async () => {
    setResponder(() => 'fix attempt');
    // Hangs forever — every re-run stalls too.
    const { fn: alwaysStall, calls } = stallThenSucceed(99);
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'wedged',
            agent: 'agents/worker.md',
            provider: 'openai',
            stallTimeout: 0.05,
            onStall: { recover: { name: 'kick', agent: 'agents/fixer.md' }, maxRetries: 2 },
          },
        ],
      },
      { providerStreamFns: { openai: alwaysStall } },
    );

    // Two recoveries attempted (maxRetries: 2), then the third stall aborts.
    const recoveries = events.filter(e => e.type === 'stall-recovery');
    expect(recoveries).toHaveLength(2);
    expect((recoveries[0] as { attempt: number }).attempt).toBe(1);
    expect((recoveries[1] as { attempt: number }).attempt).toBe(2);
    // initial dispatch + 2 re-runs = 3 dispatches of the wedged node.
    expect(calls()).toBe(3);
    // The recovery phase ran for each recovery attempt.
    expect(
      events.filter(e => e.type === 'phase-end' && e.phaseName === 'kick'),
    ).toHaveLength(2);
    // The run ultimately FAILED on the stall (retries exhausted → abort).
    const runErr = events.find(e => e.type === 'run-error');
    expect(runErr).toBeDefined();
    expect((runErr as { error?: string }).error).toMatch(/no progress|stall/i);
  }, 5000);

  test('maxRetries: 0 disables recovery — a stall aborts immediately (no stall-recovery)', async () => {
    setResponder(() => 'unused');
    const { fn: alwaysStall } = stallThenSucceed(99);
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'wedged',
            agent: 'agents/worker.md',
            provider: 'openai',
            stallTimeout: 0.05,
            onStall: { recover: { name: 'kick', agent: 'agents/fixer.md' }, maxRetries: 0 },
          },
        ],
      },
      { providerStreamFns: { openai: alwaysStall } },
    );
    expect(events.some(e => e.type === 'stall-recovery')).toBe(false);
    expect(events.some(e => e.type === 'phase-end' && e.phaseName === 'kick')).toBe(false);
    expect(events.some(e => e.type === 'run-error')).toBe(true);
  }, 5000);
});

// ──────────────────────────────────────────────────────────────────────────
// No regression: a node WITHOUT onStall behaves exactly as before
// ──────────────────────────────────────────────────────────────────────────
describe('onStall — no regression', () => {
  test('a stalling node with NO onStall still aborts (today behavior)', async () => {
    setResponder(() => 'unused');
    const { fn: alwaysStall } = stallThenSucceed(99);
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'wedged',
            agent: 'agents/worker.md',
            provider: 'openai',
            stallTimeout: 0.05,
          },
        ],
      },
      { providerStreamFns: { openai: alwaysStall } },
    );
    expect(events.some(e => e.type === 'node-stalled')).toBe(true);
    expect(events.some(e => e.type === 'stall-recovery')).toBe(false);
    expect(events.some(e => e.type === 'run-error')).toBe(true);
  }, 5000);

  test('a healthy node with onStall declared never triggers recovery', async () => {
    setResponder(() => 'unused');
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'healthy',
            agent: 'agents/worker.md',
            provider: 'openai',
            stallTimeout: 5,
            onStall: { recover: { name: 'kick', agent: 'agents/fixer.md' }, maxRetries: 1 },
          },
        ],
      },
      { providerStreamFns: { openai: okStream('all good') } },
    );
    expect(events.some(e => e.type === 'stall-recovery')).toBe(false);
    expect(events.some(e => e.type === 'phase-end' && e.phaseName === 'kick')).toBe(false);
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
    const end = events.find(e => e.type === 'phase-end' && e.phaseName === 'healthy');
    expect((end as { output?: string }).output).toContain('all good');
  }, 5000);
});
