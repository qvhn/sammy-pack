/**
 * Executor-level tests for the anti-retry-storm guards — a REAL executor run
 * (mocked provider stream) proving:
 *   (1) a TERMINAL-marked phase is NOT re-attempted by node `retry`, by `onStall`
 *       recovery, or by a loop's `retryOnFailure` — and an UNMARKED failure still
 *       retries / re-iterates exactly as before (the no-regression case).
 *   (4) a loop's `maxFailures` cap stops a `retryOnFailure` loop after that many
 *       CONSECUTIVE failures instead of grinding every `maxIterations`.
 *
 * Mock approach mirrors stall-recovery-hook.test.ts: the default (Anthropic)
 * stream returns whatever a per-test responder yields; a per-call closure counter
 * proves how many times a phase was dispatched.
 */

import {
  runOrchestration,
  type RunEvent,
  type StreamFn,
} from '../src/llm/executor';
import type { Node } from '../src/types';

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
    { name: 'validate', raw: '---\nname: validate\n---\nValidator agent.' },
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
  opts?: { providerStreamFns?: Record<string, StreamFn> },
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    waitForApproval: async () => true,
    cancelled: { v: false },
    providerStreamFns: opts?.providerStreamFns,
    allowAgentTools: true,
  })) {
    events.push(ev);
  }
  return events;
}

// ──────────────────────────────────────────────────────────────────────────
// (1) node `retry` does NOT re-run a terminally-marked phase
// ──────────────────────────────────────────────────────────────────────────
describe('terminal marker vs node retry', () => {
  test('a SAMMY-TERMINAL phase with retry.times=3 is dispatched ONCE (no re-attempts)', async () => {
    let calls = 0;
    const terminalStream: StreamFn = async function* () {
      calls += 1;
      yield { type: 'text-delta', text: 'SAMMY-TERMINAL: validator is offline' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'validate',
            agent: 'agents/validate.md',
            provider: 'openai',
            retry: { times: 3 },
          },
        ],
      },
      { providerStreamFns: { openai: terminalStream } },
    );
    // Dispatched exactly once — the 3 retries were suppressed.
    expect(calls).toBe(1);
    // A phase-terminal event was emitted (the loud suppression signal)…
    const term = events.find(e => e.type === 'phase-terminal');
    expect(term).toBeDefined();
    if (term?.type !== 'phase-terminal') throw new Error('expected phase-terminal');
    expect(term.phaseName).toBe('validate');
    expect(term.reason).toContain('validator is offline');
    expect(term.retriesSuppressed).toBe(3);
    // …and NO node-retried events (the storm never started).
    expect(events.some(e => e.type === 'node-retried')).toBe(false);
    // The run still FAILS (terminal is a failure, just not re-run).
    expect(events.some(e => e.type === 'run-error')).toBe(true);
  });

  test('NO-REGRESSION: an unmarked failure still retries the full retry.times', async () => {
    let calls = 0;
    const failStream: StreamFn = async function* () {
      calls += 1;
      // A plain failure with no terminal marker — throw mid-stream.
      yield { type: 'text-delta', text: 'working' };
      throw new Error('transient blip');
    };
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'flaky',
            agent: 'agents/worker.md',
            provider: 'openai',
            retry: { times: 2, initialMs: 1 },
          },
        ],
      },
      { providerStreamFns: { openai: failStream } },
    );
    // initial + 2 retries = 3 dispatches (unchanged behavior).
    expect(calls).toBe(3);
    expect(events.filter(e => e.type === 'node-retried')).toHaveLength(2);
    expect(events.some(e => e.type === 'phase-terminal')).toBe(false);
    expect(events.some(e => e.type === 'run-error')).toBe(true);
  });

  test('a terminal failure still reaches onError (terminal = do-not-REDO, not ignore)', async () => {
    let calls = 0;
    const terminalStream: StreamFn = async function* () {
      calls += 1;
      yield { type: 'text-delta', text: 'SAMMY-TERMINAL: infra down' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    setResponder(() => 'recovered output'); // the onError branch (default path)
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'validate',
            agent: 'agents/validate.md',
            provider: 'openai',
            retry: { times: 5 },
            onError: { name: 'fallback', agent: 'agents/fixer.md' },
          },
        ],
      },
      { providerStreamFns: { openai: terminalStream } },
    );
    // The phase ran once (no retries), then onError ran → run completes.
    expect(calls).toBe(1);
    expect(events.some(e => e.type === 'phase-terminal')).toBe(true);
    expect(events.some(e => e.type === 'node-recovered')).toBe(true);
    expect(events.some(e => e.type === 'phase-end' && e.phaseName === 'fallback')).toBe(true);
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (1) a loop's retryOnFailure stops on a terminal failure
// ──────────────────────────────────────────────────────────────────────────
describe('terminal marker vs loop retryOnFailure', () => {
  test('a terminal failure inside a retryOnFailure loop stops it (no re-iteration)', async () => {
    let calls = 0;
    const terminalStream: StreamFn = async function* () {
      calls += 1;
      yield { type: 'text-delta', text: 'SAMMY-TERMINAL: cannot proceed' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'refine',
            loop: {
              maxIterations: 10,
              retryOnFailure: true,
              body: { name: 'work', agent: 'agents/worker.md', provider: 'openai' },
            },
          },
        ],
      },
      { providerStreamFns: { openai: terminalStream } },
    );
    // The body ran ONCE — the terminal failure stopped the loop immediately,
    // not after 10 iterations.
    expect(calls).toBe(1);
    const exhausted = events.find(e => e.type === 'loop-exhausted');
    expect(exhausted).toBeDefined();
    // Only one loop-iteration was emitted.
    expect(events.filter(e => e.type === 'loop-iteration')).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (4) loop maxFailures cap
// ──────────────────────────────────────────────────────────────────────────
describe('loop maxFailures cap (anti-retry-storm bound)', () => {
  test('a loop whose body always fails stops after maxFailures, not maxIterations', async () => {
    let calls = 0;
    const failStream: StreamFn = async function* () {
      calls += 1;
      yield { type: 'text-delta', text: 'attempt' };
      throw new Error('still broken');
    };
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'grind',
            loop: {
              maxIterations: 12, // would grind 12× without the cap
              retryOnFailure: true,
              maxFailures: 3,
              body: { name: 'fix', agent: 'agents/worker.md', provider: 'openai' },
            },
          },
        ],
      },
      { providerStreamFns: { openai: failStream } },
    );
    // Stopped after 3 consecutive failures — NOT 12.
    expect(calls).toBe(3);
    expect(events.filter(e => e.type === 'loop-iteration')).toHaveLength(3);
    const exhausted = events.find(e => e.type === 'loop-exhausted');
    expect(exhausted).toBeDefined();
    if (exhausted?.type !== 'loop-exhausted') throw new Error('expected loop-exhausted');
    expect(exhausted.failures).toBe(3);
    expect(exhausted.maxFailures).toBe(3);
  });

  test('a successful iteration RESETS the failure streak (an intermittent blip never trips it)', async () => {
    // Fail, fail, succeed, fail, fail — with maxFailures:3 this should NEVER
    // trip (max consecutive run is 2), so it runs the full maxIterations.
    let n = 0;
    const pattern = [false, false, true, false, false]; // true = success
    const intermittentStream: StreamFn = async function* () {
      const ok = pattern[n] ?? true;
      n += 1;
      yield { type: 'text-delta', text: ok ? 'ok' : 'fail' };
      if (!ok) throw new Error('blip');
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'refine',
            loop: {
              maxIterations: 5,
              retryOnFailure: true,
              maxFailures: 3,
              body: { name: 'work', agent: 'agents/worker.md', provider: 'openai' },
            },
          },
        ],
      },
      { providerStreamFns: { openai: intermittentStream } },
    );
    // Never exhausted (consecutive failures never reached 3); ran all 5.
    expect(events.some(e => e.type === 'loop-exhausted')).toBe(false);
    expect(events.filter(e => e.type === 'loop-iteration')).toHaveLength(5);
  });

  test('NO-REGRESSION: a loop with no maxFailures runs the full maxIterations on repeated failure', async () => {
    let calls = 0;
    const failStream: StreamFn = async function* () {
      calls += 1;
      yield { type: 'text-delta', text: 'attempt' };
      throw new Error('broken');
    };
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'grind',
            loop: {
              maxIterations: 4,
              retryOnFailure: true,
              // no maxFailures
              body: { name: 'fix', agent: 'agents/worker.md', provider: 'openai' },
            },
          },
        ],
      },
      { providerStreamFns: { openai: failStream } },
    );
    expect(calls).toBe(4); // ground the full maxIterations, as before
    expect(events.some(e => e.type === 'loop-exhausted')).toBe(false);
  });
});
