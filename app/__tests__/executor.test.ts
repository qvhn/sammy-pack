/**
 * End-to-end executor tests with a mocked LLM (no network).
 *
 * Drives confidence that the decorator stack, state, map, onError, retry,
 * timeout, when, budget, and tools validation all actually work — not just
 * that the types compile and the pure helpers behave.
 */

import {
  runOrchestration,
  RunPauseRequested,
  type RunEvent,
  type StreamFn,
} from '../src/llm/executor';
import { agentSlots } from '../src/llm/concurrency';
import {
  computeRequestChangesInvalidation,
  feedbackTargetKey,
  priorCrossedLocks,
} from '../src/server/gate-invalidation';
import type { Node } from '../src/types';

// ── Mock streamAnthropic at the module level ──────────────────────────────
// Jest disallows async-generator literals inside jest.mock() factory bodies
// (they reference an internal _wrapAsyncGenerator). Instead, the mock returns
// a plain object with [Symbol.asyncIterator] so babel doesn't have to wrap it.

// Names prefixed with `mock` are exempt from the out-of-scope check.
const mockState: {
  responder: (sys: string, user: string) => Promise<string> | string;
  callCount: number;
} = { responder: () => '', callCount: 0 };

jest.mock('../src/llm/anthropic', () => ({
  streamAnthropic(params: {
    system?: string;
    messages: { role: string; content: string }[];
  }) {
    mockState.callCount += 1;
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
              const text = await result;
              return { value: { type: 'text-delta', text }, done: false };
            }
            if (stage === 1) {
              stage = 2;
              return {
                value: {
                  type: 'done',
                  usage: { inputTokens: 10, outputTokens: 20 },
                },
                done: false,
              };
            }
            return { value: undefined, done: true };
          },
          return() { return Promise.resolve({ value: undefined, done: true }); },
        };
      },
    };
  },
}));

const mockOrchestrations: { current: { name: string; phases?: any[] }[] } = {
  current: [],
};

jest.mock('../src/api', () => ({
  listAgents: async () => [
    { name: 'a', raw: '---\nname: a\n---\nYou are agent A. Input was: ${input}' },
    { name: 'b', raw: '---\nname: b\n---\nYou are agent B.' },
    { name: 'failing', raw: '---\nname: failing\n---\nfailing agent' },
    { name: 'fallback', raw: '---\nname: fallback\n---\nfallback agent' },
    { name: 'judge', raw: '---\n---\njudge agent' },
    { name: 'router', raw: '---\n---\nrouter agent' },
  ],
  listOrchestrations: async () => mockOrchestrations.current,
}));

function setResponder(fn: (sys: string, user: string) => Promise<string> | string) {
  mockState.responder = fn;
  mockState.callCount = 0;
}

async function runToCompletion(orchestration: Node, opts?: {
  initialInput?: string;
  configuredTools?: Set<string>;
  replayOutputs?: Record<string, string>;
  autoApproveLocks?: string[];
  gateMessages?: Record<string, string>;
  waitForApproval?: (name: string) => Promise<boolean>;
  allowAgentTools?: boolean;
  resolvedInputs?: Record<string, string>;
  providerStreamFns?: Record<string, StreamFn>;
}): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    initialInput: opts?.initialInput,
    waitForApproval: opts?.waitForApproval ?? (async () => true),
    cancelled: { v: false },
    configuredTools: opts?.configuredTools,
    replayOutputs: opts?.replayOutputs,
    autoApproveLocks: opts?.autoApproveLocks,
    gateMessages: opts?.gateMessages,
    allowAgentTools: opts?.allowAgentTools,
    resolvedInputs: opts?.resolvedInputs,
    providerStreamFns: opts?.providerStreamFns,
  })) {
    events.push(ev);
  }
  return events;
}

describe('executor — basic dispatch', () => {
  test('single agent runs and yields phase-end with telemetry', async () => {
    setResponder(() => 'hello world');
    const events = await runToCompletion({
      name: 'flow',
      phases: [{ name: 'p', agent: 'agents/a.md' }],
    });
    const end = events.find(e => e.type === 'phase-end' && e.phaseName === 'p');
    expect(end).toBeDefined();
    if (end?.type !== 'phase-end') throw new Error('expected phase-end');
    expect(end.output).toBe('hello world');
    expect(end.inputTokens).toBe(10);
    expect(end.outputTokens).toBe(20);
    expect(end.costUsd).toBeGreaterThan(0); // opus has known pricing
    expect(end.model).toBe('claude-opus-4-7');
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('serial phases thread output through pipe', async () => {
    const seen: string[] = [];
    setResponder((_sys, user) => {
      seen.push(user);
      return user + '+next';
    });
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          { name: 'p1', agent: 'agents/a.md' },
          { name: 'p2', agent: 'agents/b.md' },
        ],
      },
      { initialInput: 'start' },
    );
    expect(seen[0]).toBe('start');
    expect(seen[1]).toBe('start+next');
    expect(events.find(e => e.type === 'run-end')).toBeDefined();
  });
});

describe('executor — state (${var} interpolation)', () => {
  test('${name} resolves from `as` write of an earlier node', async () => {
    let secondCallUser = '';
    setResponder((_sys, user) => {
      if (mockState.callCount === 1) return 'SPECTEXT';
      secondCallUser = user;
      return 'done';
    });
    await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'spec', agent: 'agents/a.md', as: 'spec' },
        {
          name: 'impl',
          agent: 'agents/b.md',
          // Input contract: use ${spec} (we pass the input as literal string via
          // the implicit pipe — but executor interpolates BEFORE sending).
          // Since the second phase's input is the first's output ("SPECTEXT"),
          // and we want to test that ${spec} resolves in the system prompt,
          // we'd need a custom input. For this test, agent A's systemPrompt
          // already references ${input}, so let's check that.
        },
      ],
    });
    expect(secondCallUser).toBe('SPECTEXT');
  });

  test('state-set event fires for `as` writes', async () => {
    setResponder(() => 'x');
    const events = await runToCompletion({
      name: 'flow',
      phases: [{ name: 'p', agent: 'agents/a.md', as: 'myvar' }],
    });
    expect(events.find(e => e.type === 'state-set' && (e as any).key === 'myvar'))
      .toBeDefined();
  });
});

describe('executor — binding-empty (empty upstream `as` fed downstream)', () => {
  test('fires when a ${as-output} that resolved EMPTY is interpolated into a prompt', async () => {
    // Phase `crawl` produces an EMPTY `as: "summary"` (an agent that truncated
    // before emitting its line); phase `report` reads ${summary}. The binding
    // exists but is blank → binding-empty, distinct from unresolved.
    setResponder(() => (mockState.callCount === 1 ? '' : 'published'));
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'crawl', agent: 'agents/a.md', as: 'summary' },
        { name: 'report', agent: 'agents/b.md', prompt: 'Publish this:\n${summary}' },
      ],
    });
    const ev = events.find(e => e.type === 'binding-empty') as any;
    expect(ev).toBeDefined();
    expect(ev.phaseName).toBe('report');
    expect(ev.bindings).toContain('summary');
    // It is NOT an unresolved ref — the binding resolved, just to "".
    expect(events.find(e => e.type === 'interpolation-unresolved')).toBeUndefined();
  });

  test('does NOT fire for a non-empty `as` output', async () => {
    setResponder(() => (mockState.callCount === 1 ? 'REAL SUMMARY' : 'published'));
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'crawl', agent: 'agents/a.md', as: 'summary' },
        { name: 'report', agent: 'agents/b.md', prompt: 'Publish this:\n${summary}' },
      ],
    });
    expect(events.find(e => e.type === 'binding-empty')).toBeUndefined();
  });

  test('does NOT fire for a deliberately-empty VAR (only `as` producers count)', async () => {
    setResponder(() => 'ok');
    const events = await runToCompletion({
      name: 'flow',
      vars: { note: '' },
      phases: [{ name: 'p', agent: 'agents/b.md', prompt: 'note is: ${note}' }],
    });
    expect(events.find(e => e.type === 'binding-empty')).toBeUndefined();
  });
});

describe('executor — state reducers', () => {
  test('append reducer accumulates serial writes', async () => {
    let captured = '';
    setResponder((_sys, user) => {
      if (mockState.callCount === 1) return '["defect-a"]';
      if (mockState.callCount === 2) return '["defect-b", "defect-c"]';
      captured = user;
      return 'done';
    });
    await runToCompletion({
      name: 'flow',
      state: { defects: { reducer: 'append' } },
      phases: [
        { name: 'p1', agent: 'agents/a.md', as: 'defects' },
        { name: 'p2', agent: 'agents/a.md', as: 'defects' },
        {
          name: 'reader',
          agent: 'agents/b.md',
          prompt: 'defects=${defects}',
        },
      ],
    });
    expect(captured).toContain('defect-a');
    expect(captured).toContain('defect-b');
    expect(captured).toContain('defect-c');
  });

  test('increment reducer sums numeric writes', async () => {
    let captured = '';
    setResponder((_sys, user) => {
      if (mockState.callCount === 1) return '3';
      if (mockState.callCount === 2) return '7';
      captured = user;
      return 'done';
    });
    await runToCompletion({
      name: 'flow',
      state: { count: { reducer: 'increment', initial: 10 } },
      phases: [
        { name: 'p1', agent: 'agents/a.md', as: 'count' },
        { name: 'p2', agent: 'agents/a.md', as: 'count' },
        {
          name: 'reader',
          agent: 'agents/b.md',
          prompt: 'count=${count}',
        },
      ],
    });
    // 10 (initial) + 3 + 7 = 20
    expect(captured).toBe('count=20');
  });

  test('undeclared keys still use replace-on-write (back-compat)', async () => {
    let captured = '';
    setResponder((_sys, user) => {
      if (mockState.callCount === 1) return 'first';
      if (mockState.callCount === 2) return 'second';
      captured = user;
      return 'done';
    });
    await runToCompletion({
      name: 'flow',
      // No state block — these writes hit the legacy replace path.
      phases: [
        { name: 'p1', agent: 'agents/a.md', as: 'val' },
        { name: 'p2', agent: 'agents/a.md', as: 'val' },
        {
          name: 'reader',
          agent: 'agents/b.md',
          prompt: 'val=${val}',
        },
      ],
    });
    expect(captured).toBe('val=second');
  });

  test('append reducer in serial map accumulates per item', async () => {
    let captured = '';
    setResponder((_sys, user) => {
      // First 3 calls are the map body (one per item); 4th is the reader.
      if (mockState.callCount === 1) return '["a1"]';
      if (mockState.callCount === 2) return '["b1", "b2"]';
      if (mockState.callCount === 3) return '["c1"]';
      captured = user;
      return 'done';
    });
    await runToCompletion({
      name: 'flow',
      state: { items: { reducer: 'append' } },
      phases: [
        {
          name: 'fanout',
          map: {
            over: '["x", "y", "z"]',
            serial: true,
            body: { name: 'leaf', agent: 'agents/a.md', as: 'items' },
          },
        },
        {
          name: 'reader',
          agent: 'agents/b.md',
          prompt: 'items=${items}',
        },
      ],
    });
    expect(captured).toContain('a1');
    expect(captured).toContain('b1');
    expect(captured).toContain('b2');
    expect(captured).toContain('c1');
  });
});

describe('executor — when', () => {
  test('skips node when predicate is "false"', async () => {
    setResponder(() => 'should not run');
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'gated', agent: 'agents/a.md', when: 'false' },
      ],
    });
    expect(mockState.callCount).toBe(0);
    expect(events.find(e => e.type === 'phase-skipped')).toBeDefined();
  });

  test('runs node when predicate is "true"', async () => {
    setResponder(() => 'ran');
    await runToCompletion({
      name: 'flow',
      phases: [{ name: 'gated', agent: 'agents/a.md', when: 'true' }],
    });
    expect(mockState.callCount).toBe(1);
  });
});

describe('executor — retry + onError + timeout', () => {
  test('retry on transient failure, succeed on second attempt', async () => {
    let attempts = 0;
    setResponder(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('flaky');
      return 'ok';
    });
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'p',
          agent: 'agents/a.md',
          retry: { times: 2, backoff: 'fixed', initialMs: 10 },
        },
      ],
    });
    expect(attempts).toBe(2);
    expect(events.find(e => e.type === 'node-retried')).toBeDefined();
    expect(events.find(e => e.type === 'run-end')).toBeDefined();
  });

  test('onError recovers after retries exhausted', async () => {
    setResponder((sys, _user) => {
      if (sys.includes('fallback agent')) return 'recovered';
      throw new Error('always fails');
    });
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'p',
          agent: 'agents/failing.md',
          retry: { times: 1, initialMs: 1 },
          onError: { name: 'rescue', agent: 'agents/fallback.md' },
        },
      ],
    });
    expect(events.find(e => e.type === 'node-recovered')).toBeDefined();
    expect(events.find(e => e.type === 'run-end')).toBeDefined();
  });

  test('timeout fires when agent takes too long', async () => {
    setResponder(async () => {
      await new Promise(r => setTimeout(r, 200));
      return 'too late';
    });
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'slow',
          agent: 'agents/a.md',
          // 0.05s = 50ms; well below the 200ms sleep above
          timeout: 0.05,
        },
      ],
    });
    expect(events.find(e => e.type === 'run-error')).toBeDefined();
  }, 5000);
});

describe('executor — stall watchdog + default-timeout backstop', () => {
  // A provider StreamFn we can drive on a clock: it yields `count` text-delta
  // events spaced `gapMs` apart, after an initial `firstDelayMs` of silence,
  // then a `done`. Routing a phase here (provider:'openai' +
  // providerStreamFns) lets us control exactly when "progress" events flow, so
  // we can isolate the stall watchdog from the hard wallclock cap.
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  function clockedStreamFn(opts: {
    firstDelayMs?: number;
    gapMs?: number;
    count?: number;
  }): StreamFn {
    const { firstDelayMs = 0, gapMs = 0, count = 1 } = opts;
    return async function* () {
      if (firstDelayMs > 0) await sleep(firstDelayMs);
      for (let i = 0; i < count; i++) {
        if (i > 0 && gapMs > 0) await sleep(gapMs);
        yield { type: 'text-delta', text: `chunk ${i}` };
      }
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
  }

  // Save/restore the env overrides so these tests don't leak globals.
  let savedNodeTimeout: string | undefined;
  let savedStallTimeout: string | undefined;
  beforeEach(() => {
    savedNodeTimeout = process.env.SAMMY_DEFAULT_NODE_TIMEOUT_SEC;
    savedStallTimeout = process.env.SAMMY_DEFAULT_STALL_TIMEOUT_SEC;
  });
  afterEach(() => {
    if (savedNodeTimeout === undefined) delete process.env.SAMMY_DEFAULT_NODE_TIMEOUT_SEC;
    else process.env.SAMMY_DEFAULT_NODE_TIMEOUT_SEC = savedNodeTimeout;
    if (savedStallTimeout === undefined) delete process.env.SAMMY_DEFAULT_STALL_TIMEOUT_SEC;
    else process.env.SAMMY_DEFAULT_STALL_TIMEOUT_SEC = savedStallTimeout;
  });

  // (a) A node that yields NO events for longer than stallTimeout is aborted
  // by the watchdog, which surfaces a node-stalled event and (via the retry
  // loop) a node-retried, then ultimately onError recovery.
  test('a node with no progress past stallTimeout stalls → node-stalled, retry, onError', async () => {
    setResponder((sys) => (sys.includes('fallback agent') ? 'rescued' : 'unused'));
    // 250ms of silence before the first event, but a 50ms stall window → stalls.
    const stuck = clockedStreamFn({ firstDelayMs: 250, count: 1 });
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'wedged',
            agent: 'agents/a.md',
            provider: 'openai',
            stallTimeout: 0.05,
            retry: { times: 1, initialMs: 1 },
            onError: { name: 'rescue', agent: 'agents/fallback.md' },
          },
        ],
      },
      { providerStreamFns: { openai: stuck }, allowAgentTools: true },
    );
    const stalled = events.find(e => e.type === 'node-stalled');
    expect(stalled).toBeDefined();
    if (stalled?.type === 'node-stalled') {
      expect(stalled.phaseName).toBe('wedged');
      expect(stalled.stallSeconds).toBe(0.05);
    }
    // The StallError flowed through the existing recovery path.
    expect(events.find(e => e.type === 'node-retried')).toBeDefined();
    expect(events.find(e => e.type === 'node-recovered')).toBeDefined();
    // Recovery succeeded → the run finishes (no run-error).
    expect(events.find(e => e.type === 'run-error')).toBeUndefined();
    expect(events.find(e => e.type === 'run-end')).toBeDefined();
  }, 10000);

  // (b) A node that keeps emitting events more often than stallTimeout is NOT
  // flagged, even though its TOTAL runtime far exceeds stallTimeout — the
  // timer resets on each event.
  test('a slow-but-streaming node (events < stallTimeout apart) is NOT stalled', async () => {
    setResponder(() => 'unused');
    // 8 events, 40ms apart → ~320ms total, well past the 100ms stall window,
    // but no single gap exceeds it → must complete cleanly.
    const slow = clockedStreamFn({ gapMs: 40, count: 8 });
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'chatty',
            agent: 'agents/a.md',
            provider: 'openai',
            stallTimeout: 0.1,
          },
        ],
      },
      { providerStreamFns: { openai: slow }, allowAgentTools: true },
    );
    expect(events.find(e => e.type === 'node-stalled')).toBeUndefined();
    expect(events.find(e => e.type === 'run-error')).toBeUndefined();
    const end = events.find(e => e.type === 'phase-end' && e.phaseName === 'chatty');
    expect(end).toBeDefined();
  }, 10000);

  // (c) A node with NO explicit timeout still gets the default hard wallclock
  // cap, and is aborted if it exceeds it. We shrink the default via env and
  // keep events flowing fast (so the stall guard never fires) — isolating the
  // hard-cap backstop. A high stallTimeout guarantees only the cap can trip.
  test('a node without an explicit timeout gets the default hard cap and is aborted past it', async () => {
    process.env.SAMMY_DEFAULT_NODE_TIMEOUT_SEC = '0.1'; // 100ms hard cap
    setResponder(() => 'unused');
    // Streams steadily (no stall) but for ~400ms total — past the 100ms cap.
    const longRunner = clockedStreamFn({ gapMs: 25, count: 16 });
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'overrun',
            agent: 'agents/a.md',
            provider: 'openai',
            stallTimeout: 5, // generous → stall guard cannot be what fires
            // NO timeout set → default hard cap applies
          },
        ],
      },
      { providerStreamFns: { openai: longRunner }, allowAgentTools: true },
    );
    // Aborted by the hard cap, not the stall watchdog.
    expect(events.find(e => e.type === 'node-stalled')).toBeUndefined();
    expect(events.find(e => e.type === 'run-error')).toBeDefined();
    const end = events.find(e => e.type === 'phase-end' && e.phaseName === 'overrun');
    expect(end).toBeUndefined();
  }, 10000);

  // (d) A normal fast node is unaffected by either guard.
  test('a fast node is unaffected by the stall watchdog / default cap', async () => {
    setResponder(() => 'done');
    const events = await runToCompletion({
      name: 'flow',
      phases: [{ name: 'quick', agent: 'agents/a.md' }],
    });
    expect(events.find(e => e.type === 'node-stalled')).toBeUndefined();
    expect(events.find(e => e.type === 'run-error')).toBeUndefined();
    const end = events.find(e => e.type === 'phase-end' && e.phaseName === 'quick');
    expect(end).toBeDefined();
    if (end?.type === 'phase-end') expect(end.output).toBe('done');
  });

  // The env override for the stall default is honored (no per-node stallTimeout).
  test('SAMMY_DEFAULT_STALL_TIMEOUT_SEC drives the watchdog when no per-node value is set', async () => {
    process.env.SAMMY_DEFAULT_STALL_TIMEOUT_SEC = '0.05';
    setResponder(() => 'unused');
    const stuck = clockedStreamFn({ firstDelayMs: 250, count: 1 });
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [{ name: 'envWedged', agent: 'agents/a.md', provider: 'openai' }],
      },
      { providerStreamFns: { openai: stuck }, allowAgentTools: true },
    );
    const stalled = events.find(e => e.type === 'node-stalled');
    expect(stalled).toBeDefined();
    if (stalled?.type === 'node-stalled') expect(stalled.stallSeconds).toBe(0.05);
    // No onError here → the stall becomes a run-error.
    expect(events.find(e => e.type === 'run-error')).toBeDefined();
  }, 10000);

  // ── Composite/subflow stall-window INHERITANCE ──────────────────────────
  // A composite (phases) with only the SHORT default stall window must NOT
  // trip during a child's silence when that child declares a LONGER per-node
  // stallTimeout. The parent inherits max(own/default, max-child) so the
  // long-but-quiet child runs to its own deadline. (The 3 AM preflight bug:
  // the parent's default 420s guard aborted a child that had set a longer
  // window.)
  test('a composite inherits its longest child stallTimeout and does NOT trip early', async () => {
    process.env.SAMMY_DEFAULT_STALL_TIMEOUT_SEC = '0.08'; // parent default: 80ms
    setResponder(() => 'unused');
    // Child is silent for 200ms (past the parent's 80ms default) before its
    // first event, but declares a generous 5s stallTimeout. With inheritance
    // the parent's window widens to 5s, so no stall fires.
    const quietThenChatty = clockedStreamFn({ firstDelayMs: 200, count: 1 });
    const events = await runToCompletion(
      {
        name: 'parent', // a `phases` composite — NO own stallTimeout
        phases: [
          {
            name: 'long-child',
            agent: 'agents/a.md',
            provider: 'openai',
            stallTimeout: 5, // generous — should propagate up to the parent
          },
        ],
      },
      { providerStreamFns: { openai: quietThenChatty }, allowAgentTools: true },
    );
    // Neither the child nor the parent stalled.
    expect(events.find(e => e.type === 'node-stalled')).toBeUndefined();
    expect(events.find(e => e.type === 'run-error')).toBeUndefined();
    const end = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'long-child',
    );
    expect(end).toBeDefined();
    expect(events.find(e => e.type === 'run-end')).toBeDefined();
  }, 10000);

  // Control / negative: the SAME silent child WITHOUT a generous per-node
  // stallTimeout (so the parent keeps only the short default) DOES trip —
  // proving the inheritance above is what kept the first case alive, not some
  // unrelated leniency. The stall is attributed to the composite parent.
  test('without a long child stallTimeout, the same composite trips on the default', async () => {
    process.env.SAMMY_DEFAULT_STALL_TIMEOUT_SEC = '0.08';
    setResponder(() => 'unused');
    const quietThenChatty = clockedStreamFn({ firstDelayMs: 250, count: 1 });
    const events = await runToCompletion(
      {
        name: 'parent',
        phases: [
          // No stallTimeout on the child → parent stays at the 80ms default.
          { name: 'plain-child', agent: 'agents/a.md', provider: 'openai' },
        ],
      },
      { providerStreamFns: { openai: quietThenChatty }, allowAgentTools: true },
    );
    const stalled = events.find(e => e.type === 'node-stalled');
    expect(stalled).toBeDefined();
    // The inner leaf is the first to go silent past the default, so it trips
    // first; either the leaf or the parent stalling proves the default applied.
    expect(events.find(e => e.type === 'run-error')).toBeDefined();
  }, 10000);

  // A subflow inherits a long stallTimeout declared INSIDE the referenced
  // orchestration (whose body is invisible to a static parent walk) — so a
  // long-but-quiet phase in the inlined flow doesn't trip the subflow node's
  // default guard.
  test('a subflow inherits a long stallTimeout from inside the referenced orchestration', async () => {
    process.env.SAMMY_DEFAULT_STALL_TIMEOUT_SEC = '0.08';
    setResponder(() => 'unused');
    mockOrchestrations.current = [
      {
        name: 'SLOW_SUB',
        phases: [
          {
            name: 'slow-inner',
            agent: 'agents/a.md',
            provider: 'openai',
            stallTimeout: 5, // declared inside the subflow — must propagate up
          },
        ],
      } as any,
    ];
    const quietThenChatty = clockedStreamFn({ firstDelayMs: 200, count: 1 });
    const events = await runToCompletion(
      {
        name: 'PARENT',
        phases: [{ name: 'call', subflow: 'SLOW_SUB' }],
      },
      { providerStreamFns: { openai: quietThenChatty }, allowAgentTools: true },
    );
    expect(events.find(e => e.type === 'node-stalled')).toBeUndefined();
    expect(events.find(e => e.type === 'run-error')).toBeUndefined();
    expect(
      events.find(e => e.type === 'phase-end' && e.phaseName === 'slow-inner'),
    ).toBeDefined();
  }, 10000);
});

describe('executor — code node (deterministic transform)', () => {
  const out = (events: RunEvent[], phase: string) => {
    const e = events.find(
      ev => ev.type === 'phase-end' && ev.phaseName === phase,
    );
    return e?.type === 'phase-end' ? e.output : undefined;
  };
  const errorText = (events: RunEvent[]) =>
    events
      .filter(e => e.type === 'phase-error' || e.type === 'run-error')
      .map(e => (e as { error?: string }).error ?? '')
      .join(' | ');

  test('runs a normal transform and threads the output', async () => {
    const events = await runToCompletion(
      { name: 'f', phases: [{ name: 'c', code: { source: "return input + '!'" } }] },
      { initialInput: 'hi' },
    );
    expect(out(events, 'c')).toBe('hi!');
  });

  test('stringifies a non-string return; JS built-ins are available', async () => {
    const events = await runToCompletion({
      name: 'f',
      phases: [
        { name: 'c', code: { source: 'return { x: Math.max(1, 2), y: [3, 4] }' } },
      ],
    });
    expect(out(events, 'c')).toBe('{"x":2,"y":[3,4]}');
  });

  test('has NO ambient I/O (no fetch / process / require / setTimeout)', async () => {
    const events = await runToCompletion({
      name: 'f',
      phases: [
        {
          name: 'c',
          code: {
            source:
              'return [typeof fetch, typeof process, typeof require, typeof setTimeout].join(",")',
          },
        },
      ],
    });
    expect(out(events, 'c')).toBe('undefined,undefined,undefined,undefined');
  });

  test('a synchronous busy-loop is interrupted (does not hang)', async () => {
    const events = await runToCompletion({
      name: 'f',
      phases: [
        {
          name: 'spin',
          code: { source: 'while (true) {}' },
          sandbox: { maxRunSeconds: 1 },
        },
      ],
    });
    expect(events.find(e => e.type === 'run-error')).toBeDefined();
    expect(out(events, 'spin')).toBeUndefined();
  }, 8000);

  test('an async hang is bounded by the wall-clock race', async () => {
    const events = await runToCompletion({
      name: 'f',
      phases: [
        {
          name: 'hang',
          code: { source: 'await new Promise(() => {}); return "never"' },
          sandbox: { maxRunSeconds: 1 },
        },
      ],
    });
    expect(events.find(e => e.type === 'run-error')).toBeDefined();
    expect(errorText(events)).toMatch(/exceeded 1s/);
  }, 8000);

  test('output over the byte cap fails the phase', async () => {
    const events = await runToCompletion({
      name: 'f',
      phases: [
        {
          name: 'big',
          code: { source: "return 'x'.repeat(100)" },
          sandbox: { maxOutputBytes: 10 },
        },
      ],
    });
    expect(errorText(events)).toMatch(/exceeds sandbox cap/);
  });

  test('code.run is disabled by default', async () => {
    const events = await runToCompletion({
      name: 'f',
      phases: [{ name: 'sh', code: { run: 'echo hi' } }],
    });
    expect(errorText(events)).toMatch(/SAMMY_ALLOW_CODE_RUN/);
  });

  describe('code.run (opt-in shell)', () => {
    const prev = process.env.SAMMY_ALLOW_CODE_RUN;
    beforeAll(() => { process.env.SAMMY_ALLOW_CODE_RUN = '1'; });
    afterAll(() => {
      if (prev === undefined) delete process.env.SAMMY_ALLOW_CODE_RUN;
      else process.env.SAMMY_ALLOW_CODE_RUN = prev;
    });

    test('interpolates ${...} in the command before spawning', async () => {
      const events = await runToCompletion({
        name: 'f',
        vars: { greeting: 'hello-from-var' },
        phases: [{ name: 'sh', code: { run: 'echo ${greeting}' } }],
      } as any);
      expect(out(events, 'sh')).toContain('hello-from-var');
    });

    test('the sandbox denylist is checked on the RESOLVED command', async () => {
      // The denied substring only appears AFTER interpolation — proves the
      // check runs post-resolution, not on the verbatim template.
      const events = await runToCompletion({
        name: 'f',
        vars: { danger: 'rm -rf /tmp/x' },
        phases: [
          {
            name: 'sh',
            sandbox: { deniedCommands: ['rm -rf'] },
            code: { run: 'echo ${danger}' },
          },
        ],
      } as any);
      expect(errorText(events)).toMatch(/denylist/);
    });

    test('streams child stdout as phase-delta progress events (stall heartbeat)', async () => {
      // The drive's stdout must surface incrementally — both for live UI and so
      // the stall watchdog sees a real heartbeat from a running child.
      const events = await runToCompletion({
        name: 'f',
        phases: [{ name: 'sh', code: { run: 'echo heartbeat-line' } }],
      } as any);
      const delta = events.find(
        e => e.type === 'phase-delta' && e.phaseName === 'sh',
      );
      expect(delta).toBeDefined();
      if (delta?.type === 'phase-delta') expect(delta.text).toContain('heartbeat-line');
      // The full stdout still lands in the phase output (unchanged behavior).
      expect(out(events, 'sh')).toContain('heartbeat-line');
    });
  });
});

describe('executor — budget', () => {
  test('budget breach aborts the run', async () => {
    setResponder(() => 'output');
    // Each phase emits 10 input + 20 output = 30 tokens. Budget 20 should trip
    // after the first agent call.
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'group',
          phases: [
            { name: 'p1', agent: 'agents/a.md' },
            { name: 'p2', agent: 'agents/b.md' },
          ],
          budget: { maxTokens: 20 },
        },
      ],
    });
    expect(events.find(e => e.type === 'budget-exceeded')).toBeDefined();
    expect(events.find(e => e.type === 'run-error')).toBeDefined();
  });
});

describe('executor — cost event (running spend snapshot)', () => {
  test('a cost event follows each agent phase with cumulative run-wide totals', async () => {
    setResponder(() => 'out'); // each call: 10 input + 20 output tokens
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'p1', agent: 'agents/a.md' },
        { name: 'p2', agent: 'agents/b.md' },
      ],
    });
    const costs = events.filter(e => e.type === 'cost') as Array<{
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    }>;
    // One per agent phase, and the totals ACCUMULATE (not per-phase deltas).
    expect(costs).toHaveLength(2);
    expect(costs[0].inputTokens).toBe(10);
    expect(costs[0].outputTokens).toBe(20);
    expect(costs[1].inputTokens).toBe(20); // 10 + 10
    expect(costs[1].outputTokens).toBe(40); // 20 + 20
    // Cost is monotonic non-decreasing.
    expect(costs[1].costUsd).toBeGreaterThanOrEqual(costs[0].costUsd);
  });
});

describe('executor — tools', () => {
  test('warns on undeclared tool', async () => {
    setResponder(() => 'ok');
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          { name: 'p', agent: 'agents/a.md', tools: ['nonexistent-tool'] },
        ],
      },
      { configuredTools: new Set(['github']) },
    );
    const warning = events.find(e => e.type === 'tools-warning');
    expect(warning).toBeDefined();
    if (warning?.type !== 'tools-warning') throw new Error('expected tools-warning');
    expect(warning.missing).toEqual(['nonexistent-tool']);
  });

  test('no warning when all tools configured', async () => {
    setResponder(() => 'ok');
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          { name: 'p', agent: 'agents/a.md', tools: ['github'] },
        ],
      },
      { configuredTools: new Set(['github']) },
    );
    expect(events.find(e => e.type === 'tools-warning')).toBeUndefined();
  });
});

describe('executor — map', () => {
  test('runs body for each item in an inline array', async () => {
    const seen: string[] = [];
    setResponder((_sys, user) => {
      seen.push(user);
      return user.toUpperCase();
    });
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'mapper',
          map: {
            over: '["one", "two", "three"]',
            body: { name: 'process', agent: 'agents/a.md' },
            serial: true, // deterministic order for the test
          },
        },
      ],
    });
    expect(seen.length).toBe(3);
    expect(seen).toEqual(['one', 'two', 'three']);
    const iters = events.filter(e => e.type === 'map-iteration');
    expect(iters.length).toBe(3);
  });

  test('runs body for each item from ${state} array', async () => {
    const seen: string[] = [];
    let firstCall = true;
    setResponder((_sys, user) => {
      if (firstCall) {
        firstCall = false;
        return '["a", "b"]'; // becomes ${docs}
      }
      seen.push(user);
      return 'ok';
    });
    await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'load', agent: 'agents/a.md', as: 'docs' },
        {
          name: 'mapper',
          map: {
            over: '${docs}',
            body: { name: 'process', agent: 'agents/b.md' },
            serial: true,
          },
        },
      ],
    });
    expect(seen).toEqual(['a', 'b']);
  });

  test('fan-out over sandbox.maxFanout fails the phase (engine-enforced bound)', async () => {
    setResponder(() => 'ok');
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'mapper',
          sandbox: { maxFanout: 3 },
          map: {
            over: JSON.stringify(['a', 'b', 'c', 'd', 'e']), // 5 > cap 3
            body: { name: 'process', agent: 'agents/a.md' },
            serial: true,
          },
        },
      ],
    });
    const err = events.find(
      e => e.type === 'phase-error' && e.phaseName === 'mapper',
    );
    expect(err).toBeDefined();
    if (err?.type === 'phase-error') {
      expect(err.error).toMatch(/fan-out 5 exceeds cap 3/);
    }
    // No iterations ran — it was refused before fan-out.
    expect(events.filter(e => e.type === 'map-iteration')).toHaveLength(0);
  });

  test('map `as` stores a REAL array — downstream ${as.i.field} resolves', async () => {
    let captured = '';
    setResponder((_sys, user) => {
      // Map body (calls 1-2) returns a JSON object per item; the reader (3) reads.
      if (mockState.callCount <= 2) return JSON.stringify({ id: user });
      captured = user;
      return 'ok';
    });
    await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'fanout',
          map: {
            over: '["one", "two"]',
            serial: true,
            body: { name: 'leaf', agent: 'agents/a.md' },
          },
          as: 'results',
        },
        {
          name: 'reader',
          agent: 'agents/b.md',
          // Index + field access only works if `results` is a true array of
          // parsed objects, not the joined "…---…" string.
          prompt: 'second=${results.1.id} count=${results.length}',
        },
      ],
    });
    expect(captured).toBe('second=two count=2');
  });
});

describe('executor — provider/tools guard', () => {
  // A resolved (registry-present) text-only provider stub.
  const fakeText: StreamFn = async function* () {
    yield { type: 'text-delta', text: 'ok' };
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
  };

  test('text-only provider with declared tools emits a tools-warning', async () => {
    setResponder(() => 'ok');
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          { name: 'p', agent: 'agents/a.md', provider: 'openai', tools: ['Read'] },
        ],
      },
      { allowAgentTools: true, providerStreamFns: { openai: fakeText } },
    );
    const w = events.find(
      e => e.type === 'tools-warning' && e.phaseName === 'p',
    );
    expect(w).toBeDefined();
    if (w?.type === 'tools-warning') expect(w.missing).toContain('Read');
  });

  test('declared provider with NO configured creds fails loud (no silent fallback)', async () => {
    setResponder(() => 'should not be reached');
    // provider 'openai' declared but not in the registry → must error, NOT
    // silently run on the default (Claude) streamFn.
    const events = await runToCompletion({
      name: 'flow',
      phases: [{ name: 'p', agent: 'agents/a.md', provider: 'openai' }],
    });
    const err = events.find(
      e => e.type === 'phase-error' && e.phaseName === 'p',
    );
    expect(err).toBeDefined();
    if (err?.type === 'phase-error') {
      expect(err.error).toMatch(/no credentials are configured/);
    }
    expect(events.find(e => e.type === 'run-error')).toBeDefined();
  });

  test('anthropic provider with no registry entry uses the default (no error)', async () => {
    setResponder(() => 'ok');
    const events = await runToCompletion({
      name: 'flow',
      phases: [{ name: 'p', agent: 'agents/a.md', provider: 'anthropic' }],
    });
    expect(events.find(e => e.type === 'phase-error')).toBeUndefined();
    const end = events.find(e => e.type === 'phase-end' && e.phaseName === 'p');
    expect(end).toBeDefined();
  });

  test('anthropic provider with tools DOES warn — its adapter is text-only', async () => {
    // This asserted the opposite, pinning a claim that was not true of the
    // code. `providers.ts` routes `provider: "anthropic"` to
    // `streamAnthropic`, whose parameters are
    // {apiKey, model, system, messages, maxTokens} — the module contains ZERO
    // references to tools, subagents or MCP. So a phase declaring
    // `provider: "anthropic"` plus `tools` silently lost them, and the guard
    // that exists to say so listed only openai/gemini/bedrock.
    //
    // The full agentic path is the Claude CODE proxy (`claude-code`), not the
    // direct Anthropic API — which is what every doc means by "Claude-native",
    // and the distinction a user hits the moment they set `provider`
    // explicitly.
    setResponder(() => 'ok');
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'p',
            agent: 'agents/a.md',
            provider: 'anthropic',
            tools: ['Read'],
          },
        ],
      },
      { allowAgentTools: true },
    );
    const warning = events.find(
      e => e.type === 'tools-warning' && e.phaseName === 'p',
    );
    expect(warning).toBeDefined();
    expect((warning as { missing: string[] }).missing).toContain('Read');
    // Still RUNS — the tools are dropped, not a phase failure.
    expect(events.find(e => e.type === 'phase-error')).toBeUndefined();
  });
});

describe('executor — tool use', () => {
  // streamFn yields tool-use + tool-result; verify the executor passes
  // them through as phase-tool-* RunEvents AND that agent-declared
  // tools[] only get forwarded when allowAgentTools is on.

  function makeToolStreamFn() {
    const captured: { lastTools?: string[] } = {};
    const fn = async function* (params: { tools?: string[] }) {
      captured.lastTools = params.tools;
      yield { type: 'text-delta', text: '' };
      yield { type: 'tool-use', toolUseId: 'tu_1', name: 'Bash', input: { command: 'ls' } };
      yield { type: 'tool-result', toolUseId: 'tu_1', output: 'foo\nbar', isError: false };
      yield { type: 'text-delta', text: 'done' };
      yield { type: 'done', usage: { inputTokens: 5, outputTokens: 7 } };
    };
    return { fn: fn as never, captured };
  }

  test('forwards tool-use + tool-result as phase-tool-* events when allowed', async () => {
    setResponder(() => 'unused');
    const { fn: streamFn, captured } = makeToolStreamFn();
    const events: RunEvent[] = [];
    for await (const ev of runOrchestration({
      orchestration: {
        name: 'flow',
        phases: [{ name: 'tooled', agent: 'agents/a.md', tools: ['Bash'] }],
      },
      apiKey: 'x',
      model: 'claude-sonnet-4-6',
      streamFn,
      waitForApproval: async () => true,
      cancelled: { v: false },
      allowAgentTools: true,
    })) {
      events.push(ev);
    }
    const toolUse = events.find(e => e.type === 'phase-tool-use');
    const toolResult = events.find(e => e.type === 'phase-tool-result');
    expect(toolUse).toBeDefined();
    if (toolUse?.type !== 'phase-tool-use') throw new Error('expected phase-tool-use');
    expect(toolUse.toolName).toBe('Bash');
    expect(toolUse.toolUseId).toBe('tu_1');
    expect(toolResult).toBeDefined();
    if (toolResult?.type !== 'phase-tool-result') throw new Error('expected phase-tool-result');
    expect(toolResult.output).toBe('foo\nbar');
    expect(toolResult.isError).toBe(false);
    expect(captured.lastTools).toEqual(['Bash']);
  });

  test('strips agent-declared tools + emits warning when allowAgentTools is false', async () => {
    setResponder(() => 'unused');
    const { fn: streamFn, captured } = makeToolStreamFn();
    const events: RunEvent[] = [];
    for await (const ev of runOrchestration({
      orchestration: {
        name: 'flow',
        phases: [{ name: 'wantsBash', agent: 'agents/a.md', tools: ['Bash'] }],
      },
      apiKey: 'x',
      model: 'claude-sonnet-4-6',
      streamFn,
      waitForApproval: async () => true,
      cancelled: { v: false },
      allowAgentTools: false,
    })) {
      events.push(ev);
    }
    expect(events.find(e => e.type === 'tools-warning')).toBeDefined();
    expect(captured.lastTools).toBeUndefined();
  });
});

describe('executor — subflow', () => {
  test('inlines a referenced orchestration and shares state', async () => {
    setResponder((_sys, user) => {
      // First call: in subflow A, sets ${shared}
      // Second call: in parent C, reads ${shared} (passed through pipe + state)
      return user.includes('${shared}') ? user : user + '-x';
    });
    mockOrchestrations.current = [
      {
        name: 'A',
        phases: [
          { name: 'a-step', agent: 'agents/a.md', as: 'shared' },
        ],
      },
    ];
    const events = await runToCompletion({
      name: 'C',
      phases: [
        { name: 'call-a', subflow: 'A' },
        // After A runs and sets ${shared}, reads it via interpolated input
        {
          name: 'use-shared',
          agent: 'agents/b.md',
        },
      ],
    });
    const setEv = events.find(e => e.type === 'state-set');
    expect(setEv).toBeDefined();
    if (setEv?.type !== 'state-set') throw new Error('expected state-set');
    expect(setEv.key).toBe('shared');
    const subflowStart = events.find(
      e => e.type === 'composite-start' && (e as any).kind === 'subflow',
    );
    expect(subflowStart).toBeDefined();
  });

  test("seeds the referenced orchestration's own vars so its phases can interpolate them", async () => {
    const seen: string[] = [];
    setResponder((_sys, user) => {
      seen.push(user);
      return 'ok';
    });
    mockOrchestrations.current = [
      {
        name: 'SUB',
        vars: { region: 'EMEA' },
        phases: [{ name: 's', agent: 'agents/a.md', prompt: 'region is ${region}' }],
      } as any,
    ];
    await runToCompletion({
      name: 'PARENT',
      phases: [{ name: 'call', subflow: 'SUB' }],
    });
    // The sub-orchestration's own `vars.region` resolves inside its phase.
    expect(seen[0]).toBe('region is EMEA');
  });

  test('parent state wins over a subflow var of the same name', async () => {
    const seen: string[] = [];
    setResponder((_sys, user) => {
      seen.push(user);
      return 'ok';
    });
    mockOrchestrations.current = [
      {
        name: 'SUB',
        vars: { region: 'EMEA' },
        phases: [{ name: 's', agent: 'agents/a.md', prompt: 'region is ${region}' }],
      } as any,
    ];
    await runToCompletion({
      name: 'PARENT',
      vars: { region: 'APAC' },
      phases: [{ name: 'call', subflow: 'SUB' }],
    } as any);
    expect(seen[0]).toBe('region is APAC');
  });

  test('runs a referenced orchestration whose root is a body, not `phases`', async () => {
    // SUB has no `phases` — its root IS a single `code` node. The subflow
    // must dispatch that root directly instead of silently no-op'ing.
    setResponder((_sys, user) => `read:${user}`);
    mockOrchestrations.current = [
      { name: 'SUB', code: { source: "return input + '-fromsub'" } } as any,
    ];
    let captured = '';
    setResponder((_sys, user) => {
      captured = user;
      return 'ok';
    });
    await runToCompletion(
      {
        name: 'PARENT',
        phases: [
          { name: 'call', subflow: 'SUB', as: 'r' },
          { name: 'read', agent: 'agents/b.md', prompt: 'got ${r}' },
        ],
      },
      { initialInput: 'hi' },
    );
    expect(captured).toBe('got hi-fromsub');
  });

  test('a node INSIDE a subflow inherits the parent sandbox policy', async () => {
    // Run-start can't see inside a subflow (resolved by name at dispatch), so
    // its leaves used to be absent from sandboxByPhase — losing the inherited
    // policy. With the fix, the parent root's denylist reaches the nested
    // code.run node. Observable via the denylist firing on a nested command.
    const prev = process.env.SAMMY_ALLOW_CODE_RUN;
    process.env.SAMMY_ALLOW_CODE_RUN = '1';
    try {
      setResponder(() => 'x');
      mockOrchestrations.current = [
        {
          name: 'SUB',
          phases: [{ name: 'sub-code', code: { run: 'echo blocked-token' } }],
        } as any,
      ];
      const events = await runToCompletion({
        name: 'PARENT',
        sandbox: { deniedCommands: ['blocked-token'] },
        phases: [{ name: 'call', subflow: 'SUB' }],
      } as any);
      const err = events.find(
        e => e.type === 'phase-error' && (e as any).phaseName === 'sub-code',
      );
      expect(err).toBeDefined();
      if (err?.type === 'phase-error') expect(err.error).toMatch(/denylist/);
    } finally {
      if (prev === undefined) delete process.env.SAMMY_ALLOW_CODE_RUN;
      else process.env.SAMMY_ALLOW_CODE_RUN = prev;
    }
  });

  test('throws on missing subflow reference', async () => {
    setResponder(() => 'x');
    mockOrchestrations.current = []; // empty registry
    const events = await runToCompletion({
      name: 'C',
      phases: [{ name: 'broken', subflow: 'DoesNotExist' }],
    });
    const err = events.find(e => e.type === 'run-error');
    expect(err).toBeDefined();
    if (err?.type !== 'run-error') throw new Error('expected run-error');
    expect(err.error).toMatch(/not found/);
  });

  test('detects circular subflow reference', async () => {
    setResponder(() => 'x');
    // A → B → A (cycle)
    mockOrchestrations.current = [
      { name: 'A', phases: [{ name: 'call-b', subflow: 'B' }] },
      { name: 'B', phases: [{ name: 'call-a', subflow: 'A' }] },
    ];
    const events = await runToCompletion({
      name: 'A',
      phases: [{ name: 'call-b', subflow: 'B' }],
    });
    const err = events.find(e => e.type === 'run-error');
    expect(err).toBeDefined();
    if (err?.type !== 'run-error') throw new Error('expected run-error');
    expect(err.error).toMatch(/circular/);
  });

  test('subflow can nest decorators (subflow node has its own retry)', async () => {
    let attempts = 0;
    setResponder(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('flaky subflow agent');
      return 'ok';
    });
    mockOrchestrations.current = [
      { name: 'A', phases: [{ name: 'a-step', agent: 'agents/a.md' }] },
    ];
    const events = await runToCompletion({
      name: 'C',
      phases: [
        {
          name: 'call-a',
          subflow: 'A',
          retry: { times: 2, initialMs: 1 },
        },
      ],
    });
    expect(attempts).toBe(2);
    expect(events.find(e => e.type === 'node-retried')).toBeDefined();
    expect(events.find(e => e.type === 'run-end')).toBeDefined();
  });
});

describe('executor — subflow name-resolution precedence (imported > shipped)', () => {
  // Two orchestrations declare the SAME name; they differ only by __origin and
  // by the phase name inside, so the events tell us which one actually ran.
  // The IMPORTED (domain) one must win regardless of array order — the bug was
  // a generic example shadowing the intended domain router by readdir order.
  const importedRouter = {
    name: 'ticket-to-pr',
    __origin: 'imported',
    phases: [{ name: 'imported-step', agent: 'agents/a.md' }],
  } as any;
  const shippedRouter = {
    name: 'ticket-to-pr',
    __origin: 'shipped',
    phases: [{ name: 'shipped-step', agent: 'agents/b.md' }],
  } as any;

  const ranImported = (events: RunEvent[]) =>
    events.some(e => e.type === 'phase-end' && e.phaseName === 'imported-step');
  const ranShipped = (events: RunEvent[]) =>
    events.some(e => e.type === 'phase-end' && e.phaseName === 'shipped-step');

  test('imported shadows shipped when the shipped entry is listed LAST', async () => {
    setResponder(() => 'ok');
    // Shipped last → last-write-wins (the old behavior) would have picked it.
    mockOrchestrations.current = [importedRouter, shippedRouter];
    const events = await runToCompletion({
      name: 'PARENT',
      phases: [{ name: 'call', subflow: 'ticket-to-pr' }],
    });
    expect(ranImported(events)).toBe(true);
    expect(ranShipped(events)).toBe(false);
  });

  test('imported shadows shipped when the imported entry is listed LAST', async () => {
    setResponder(() => 'ok');
    mockOrchestrations.current = [shippedRouter, importedRouter];
    const events = await runToCompletion({
      name: 'PARENT',
      phases: [{ name: 'call', subflow: 'ticket-to-pr' }],
    });
    expect(ranImported(events)).toBe(true);
    expect(ranShipped(events)).toBe(false);
  });

  test('with two shipped entries of the same name, last-write still wins (back-compat)', async () => {
    setResponder(() => 'ok');
    const shippedA = {
      name: 'dup',
      __origin: 'shipped',
      phases: [{ name: 'shipped-a', agent: 'agents/a.md' }],
    } as any;
    const shippedB = {
      name: 'dup',
      __origin: 'shipped',
      phases: [{ name: 'shipped-b', agent: 'agents/b.md' }],
    } as any;
    mockOrchestrations.current = [shippedA, shippedB];
    const events = await runToCompletion({
      name: 'PARENT',
      phases: [{ name: 'call', subflow: 'dup' }],
    });
    // Same tier → the later one (shippedB) wins, unchanged from before.
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'shipped-b'),
    ).toBe(true);
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'shipped-a'),
    ).toBe(false);
  });

  test('an unmarked entry is treated as shipped and loses to an imported one', async () => {
    setResponder(() => 'ok');
    const unmarked = {
      name: 'ticket-to-pr',
      // no __origin → defaults to shipped precedence
      phases: [{ name: 'unmarked-step', agent: 'agents/b.md' }],
    } as any;
    mockOrchestrations.current = [importedRouter, unmarked];
    const events = await runToCompletion({
      name: 'PARENT',
      phases: [{ name: 'call', subflow: 'ticket-to-pr' }],
    });
    expect(ranImported(events)).toBe(true);
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'unmarked-step'),
    ).toBe(false);
  });
});

describe('executor — route', () => {
  test('router chooses a branch by substring match', async () => {
    setResponder((_sys, user) => {
      if (user.includes('Classify')) return 'bug';
      return 'fixed';
    });
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'r',
          route: {
            router: 'agents/router.md',
            branches: {
              bug: { name: 'fix', agent: 'agents/a.md' },
              feature: { name: 'plan', agent: 'agents/b.md' },
            },
          },
        },
      ],
    });
    const dec = events.find(e => e.type === 'route-decision');
    expect(dec).toBeDefined();
    if (dec?.type !== 'route-decision') throw new Error('expected route-decision');
    expect(dec.branch).toBe('bug');
  });

  test('a structured {branch} verdict beats a branch name mentioned in prose', () => {
    // The router picks "feature" structurally while ALSO saying the word "bug"
    // in prose. The old substring logic would mis-route to "bug" (first key to
    // appear); the structured decision routes to "feature".
    return (async () => {
      setResponder((_sys, user) => {
        if (user.includes('Classify'))
          return 'This bug-adjacent request is really a feature. {"branch":"feature"}';
        return 'planned';
      });
      const events = await runToCompletion({
        name: 'flow',
        phases: [
          {
            name: 'r',
            route: {
              router: 'agents/router.md',
              branches: {
                bug: { name: 'fix', agent: 'agents/a.md' },
                feature: { name: 'plan', agent: 'agents/b.md' },
              },
            },
          },
        ],
      });
      const dec = events.find(e => e.type === 'route-decision');
      if (dec?.type !== 'route-decision') throw new Error('expected route-decision');
      expect(dec.branch).toBe('feature');
    })();
  });
});

describe('executor — pause / resume primitives', () => {
  test('replayOutputs short-circuits the SDK call and yields the stored output', async () => {
    setResponder(() => 'fresh dispatch — should NOT fire');
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          { name: 'replayed', agent: 'agents/a.md' },
          { name: 'live', agent: 'agents/b.md' },
        ],
      },
      {
        replayOutputs: { replayed: 'from snapshot' },
      },
    );
    // The replayed phase emits phase-end with the stored output and
    // doesn't invoke the LLM mock — callCount should be 1 (only `live`).
    expect(mockState.callCount).toBe(1);
    const ends = events.filter(e => e.type === 'phase-end');
    const replayedEnd = ends.find(
      e => e.type === 'phase-end' && e.phaseName === 'replayed',
    );
    expect(replayedEnd).toBeDefined();
    if (replayedEnd?.type !== 'phase-end') throw new Error();
    expect(replayedEnd.output).toBe('from snapshot');
    expect(replayedEnd.inputTokens).toBe(0);
  });

  test('autoApproveLocks bypasses waitForApproval for the named phase', async () => {
    setResponder(() => 'ok');
    let approvalCalls = 0;
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          { name: 'gated', agent: 'agents/a.md', lock: true },
          { name: 'after', agent: 'agents/b.md' },
        ],
      },
      {
        autoApproveLocks: ['gated'],
        waitForApproval: async () => {
          approvalCalls += 1;
          return true;
        },
      },
    );
    expect(approvalCalls).toBe(0);
    // Lock-gate event still fires (so the UI can render that the lock
    // was crossed), but the wait was skipped.
    expect(events.some(e => e.type === 'lock-gate')).toBe(true);
    expect(events.some(e => e.type === 'phase-end' && e.phaseName === 'gated')).toBe(true);
  });

  // ── Unattended-mode auto-approve (orchestration-root autoApproveLocks) ────
  // Distinct from the resume-scoped `autoApproveLocks` SET above: the
  // orchestration ROOT `autoApproveLocks: true` boolean blanket-approves EVERY
  // lock gate without pausing — for cron / webhook runs where no human is
  // present. The gate event is still emitted (audit trail), waitForApproval is
  // never called, and the run reaches completion instead of stalling forever.
  test('orchestration autoApproveLocks:true runs a lock straight through (no pause) and still emits lock-gate', async () => {
    setResponder(() => 'ok');
    let approvalCalls = 0;
    const events = await runToCompletion(
      {
        name: 'flow',
        autoApproveLocks: true,
        phases: [
          { name: 'gated', agent: 'agents/a.md', lock: true },
          { name: 'after', agent: 'agents/b.md' },
        ],
      },
      {
        waitForApproval: async () => {
          approvalCalls += 1;
          return true;
        },
      },
    );
    // No pause: the human-approval hook is never consulted under the flag.
    expect(approvalCalls).toBe(0);
    // The audit trail is preserved — the gate still fires its event.
    expect(events.some(e => e.type === 'lock-gate')).toBe(true);
    // The run flows past the gate to completion (the gated phase AND the
    // downstream phase both finish; the run reaches run-end).
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'gated'),
    ).toBe(true);
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'after'),
    ).toBe(true);
    expect(events.find(e => e.type === 'run-end')).toBeDefined();
  });

  // Control: WITHOUT the flag a lock still defers to the human-approval gate
  // exactly as before — waitForApproval IS called, and a declined gate halts
  // the run before the gated phase runs (the genuine pause/cancel path). This
  // is what makes the unattended flag necessary for headless runs.
  test('without autoApproveLocks a lock still gates on waitForApproval (prior behavior)', async () => {
    setResponder(() => 'ok');
    let approvalCalls = 0;
    const events = await runToCompletion(
      {
        name: 'flow',
        // no autoApproveLocks on the root
        phases: [
          { name: 'gated', agent: 'agents/a.md', lock: true },
          { name: 'after', agent: 'agents/b.md' },
        ],
      },
      {
        // A human who never approves (declines) — the production unattended
        // hazard the flag fixes. Here it deterministically halts the run.
        waitForApproval: async () => {
          approvalCalls += 1;
          return false;
        },
      },
    );
    // The gate WAS consulted (it did not auto-approve past it).
    expect(approvalCalls).toBe(1);
    // The gate still emitted its event before blocking on approval.
    expect(events.some(e => e.type === 'lock-gate')).toBe(true);
    // Declined → the gated phase never ran and neither did the downstream one.
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'gated'),
    ).toBe(false);
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'after'),
    ).toBe(false);
  });

  test('gateMessages appends a human correction to the gated phase input only', async () => {
    // Capture the user prompt each phase's agent receives.
    const seen: Record<string, string> = {};
    setResponder((_sys, user) => {
      // Phase order: 'gated' first, 'after' second. Tag by content
      // marker so we can attribute each prompt to its phase.
      if (user.includes('initial work')) seen.gated = user;
      else seen.after = user;
      return 'ok';
    });
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          { name: 'gated', agent: 'agents/a.md', lock: true },
          { name: 'after', agent: 'agents/b.md' },
        ],
      },
      {
        initialInput: 'initial work',
        // Simulate a resumed run: the gate the human approved auto-approves,
        // and they attached a correction for the gated phase.
        autoApproveLocks: ['gated'],
        gateMessages: { gated: 'Only audit the auth flow; skip billing.' },
      },
    );
    // The gated phase's agent input carries the fenced human instruction.
    expect(seen.gated).toContain('HUMAN INSTRUCTION (gate approval)');
    expect(seen.gated).toContain('Only audit the auth flow; skip billing.');
    // The downstream phase must NOT inherit the correction (consumed once).
    expect(seen.after ?? '').not.toContain('Only audit the auth flow');
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'after'),
    ).toBe(true);
  });

  // ── Gate-resume SCOPE: auto-approve is per-iteration, not per-name ───────
  // A refinement loop whose body holds a `lock` gate, resumed with the gated
  // phase auto-approved, must approve ONLY the current iteration and RE-GATE on
  // the next one. The bug: autoApproveLocks keyed by bare phase name skipped
  // EVERY future hit, so the loop never re-paused after the first approve.
  test('a loop lock auto-approved once still re-gates on the next iteration', async () => {
    setResponder(() => 'keep going'); // no until/judge → runs all iterations
    let approvalCalls = 0;
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'refine',
            loop: {
              maxIterations: 2,
              // The body IS the gated node.
              body: { name: 'review-gate', agent: 'agents/a.md', lock: true },
            },
          },
        ],
      },
      {
        // Resume seeds the bare phase name the run paused at.
        autoApproveLocks: ['review-gate'],
        waitForApproval: async () => {
          approvalCalls += 1;
          return true;
        },
      },
    );
    // Two iterations → two lock-gate events (the gate is crossed each round).
    const gateEvents = events.filter(e => e.type === 'lock-gate');
    expect(gateEvents.length).toBe(2);
    // Iteration 1 auto-approved (consumed); iteration 2 re-gated → exactly one
    // real approval call. (Pre-fix this was 0 — every iteration was skipped.)
    expect(approvalCalls).toBe(1);
    expect(events.find(e => e.type === 'run-end')).toBeDefined();
  });

  // The scoped replay key is also honored directly: seeding the iteration-1
  // scoped key auto-approves iteration 1 and re-gates iteration 2 (the
  // run-controller seeds the bare name, but a scoped seed must work too).
  test('a loop lock auto-approved by SCOPED replay key re-gates later iterations', async () => {
    setResponder(() => 'keep going');
    let approvalCalls = 0;
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'refine',
            loop: {
              maxIterations: 2,
              body: { name: 'review-gate', agent: 'agents/a.md', lock: true },
            },
          },
        ],
      },
      {
        // Iteration-1 scoped key: `<loop>@1/<leaf>` (see replayScope).
        autoApproveLocks: ['refine@1/review-gate'],
        waitForApproval: async () => {
          approvalCalls += 1;
          return true;
        },
      },
    );
    expect(events.filter(e => e.type === 'lock-gate').length).toBe(2);
    // Iteration 1 matched the scoped key (consumed); iteration 2 re-gated.
    expect(approvalCalls).toBe(1);
  });

  // Back-compat: a plain (non-loop) gate auto-approved by name still works and
  // is unaffected by consume-once (it's only hit once anyway).
  test('a non-loop gate auto-approve is unchanged by consume-once scoping', async () => {
    setResponder(() => 'ok');
    let approvalCalls = 0;
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          { name: 'gated', agent: 'agents/a.md', lock: true },
          { name: 'after', agent: 'agents/b.md' },
        ],
      },
      {
        autoApproveLocks: ['gated'],
        waitForApproval: async () => {
          approvalCalls += 1;
          return true;
        },
      },
    );
    expect(approvalCalls).toBe(0);
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'gated'),
    ).toBe(true);
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'after'),
    ).toBe(true);
  });
});

// ── Regression: request-changes at a post-loop ship gate ─────────────────
// The ticket-to-PR shape: a `lock`ed implement-LOOP (implement → qa-verify),
// then `review`, then a `lock`ed `open-pr` ship gate. The live bug: calling
// request-changes at `open-pr` invalidated only the last completed leaf
// (`review`), so on resume `implement` + `qa-verify` REPLAYED from cache — the
// dev never re-implemented with the feedback, `review` re-ran against the same
// stale diff, and (because two gates exist) the resume re-paused at the FIRST
// gate and the run bounced between gates forever, never reaching `open-pr`.
//
// These tests drive the REAL executor through one gate cycle, deriving the
// resume parameters with the REAL gate-invalidation helpers and the same
// capture/seed math the run-controller uses — so they reproduce the bug and
// pin the fix end-to-end (not just at the unit-helper level).
describe('executor — request-changes at a post-loop gate (regression)', () => {
  // The post-loop-gate orchestration. Two locks: the implement-loop gate and
  // the ship gate. `until: [VERIFIED]` exits the loop when qa-verify passes.
  function ttpOrchestration(): Node {
    return {
      name: 'ttp',
      phases: [
        {
          name: 'implement-and-qa',
          lock: true,
          loop: {
            maxIterations: 3,
            until: '[VERIFIED]',
            body: {
              name: 'impl-then-verify',
              phases: [
                { name: 'implement', agent: 'agents/a.md', prompt: 'IMPLEMENT ${input}', as: 'implementation' },
                { name: 'qa-verify', agent: 'agents/b.md', prompt: 'QAVERIFY', as: 'qaVerify' },
              ],
            },
          },
        },
        { name: 'review', agent: 'agents/a.md', prompt: 'REVIEW', as: 'reviewVerdict' },
        { name: 'open-pr', agent: 'agents/b.md', prompt: 'OPENPR', lock: true, as: 'prResult' },
      ],
    };
  }

  // Route the mock LLM by the phase's prompt marker. `qaVerdict` controls
  // whether qa-verify passes (loop exits) or fails (loop iterates).
  function setTtpResponder(qaVerdict: () => string): string[] {
    const dispatched: string[] = [];
    setResponder((_sys, user) => {
      if (user.includes('IMPLEMENT')) { dispatched.push('implement'); return 'implemented diff'; }
      if (user.includes('QAVERIFY')) { dispatched.push('qa-verify'); return qaVerdict(); }
      if (user.includes('REVIEW')) { dispatched.push('review'); return 'LGTM no blocking'; }
      if (user.includes('OPENPR')) { dispatched.push('open-pr'); return 'PR opened'; }
      return 'x';
    });
    return dispatched;
  }

  /** Mirror the run-controller: capture each leaf's checkpoint key + output
   *  (keyed by the phase-end replayKey, exactly as run-controller does) and
   *  the phase the run paused at, by running until a RunPauseRequested. */
  async function runUntilPause(
    orchestration: Node,
    opts: {
      replayOutputs?: Record<string, string>;
      autoApproveLocks?: string[];
      gateMessages?: Record<string, string>;
    },
  ): Promise<{
    events: RunEvent[];
    completedLeaves: string[];
    leafOutputs: Record<string, string>;
    pausedFor: string | null;
  }> {
    const events: RunEvent[] = [];
    const completedLeaves: string[] = [];
    const leafOutputs: Record<string, string> = { ...(opts.replayOutputs ?? {}) };
    let pausedFor: string | null = null;
    try {
      for await (const ev of runOrchestration({
        orchestration,
        apiKey: 'k',
        model: 'claude-opus-4-7',
        cancelled: { v: false },
        allowAgentTools: true,
        replayOutputs: opts.replayOutputs,
        autoApproveLocks: opts.autoApproveLocks,
        gateMessages: opts.gateMessages,
        waitForApproval: async (name) => {
          // Auto-approve set is consumed by the executor itself; here a lock
          // reaching waitForApproval means it was NOT auto-approved → pause.
          throw new RunPauseRequested(name);
        },
      })) {
        events.push(ev);
        if (ev.type === 'phase-end') {
          const key = (ev as { replayKey?: string }).replayKey ?? ev.phaseName;
          if (!(key in leafOutputs) || !completedLeaves.includes(key)) {
            if (!completedLeaves.includes(key)) completedLeaves.push(key);
            leafOutputs[key] = (ev as { output: string }).output;
          }
        }
      }
    } catch (err) {
      if (err instanceof RunPauseRequested) pausedFor = err.pausedFor;
      else throw err;
    }
    return { events, completedLeaves, leafOutputs, pausedFor };
  }

  /** Replicate run-controller.resume()'s parameter derivation for a
   *  request-changes decision, using the real helpers. */
  function deriveRequestChangesResume(
    first: { events: RunEvent[]; completedLeaves: string[]; leafOutputs: Record<string, string>; pausedFor: string | null },
    message: string,
  ): { replayOutputs: Record<string, string>; autoApproveLocks: string[]; gateMessages: Record<string, string> } {
    const invalidate = computeRequestChangesInvalidation(first.completedLeaves);
    const invalidateSet = new Set(invalidate);
    const replayOutputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(first.leafOutputs)) {
      if (!invalidateSet.has(k)) replayOutputs[k] = v;
    }
    // reArmLock=true → don't auto-approve pausedFor; DO auto-approve prior gates.
    const autoApproveLocks = priorCrossedLocks(
      first.events as { type?: string; phaseName?: string }[],
      first.pausedFor,
    );
    // Map the feedback target replayKey → display phase name (run-controller
    // does this via the last matching phase-end; here keys==names for the
    // implement leaf's mapping target, which we resolve from the events).
    const targetKey = feedbackTargetKey(invalidate, first.completedLeaves);
    let targetName = targetKey ?? '';
    for (let i = first.events.length - 1; i >= 0; i--) {
      const e = first.events[i] as { type?: string; phaseName?: string; replayKey?: string };
      if (e.type === 'phase-end' && typeof e.phaseName === 'string' &&
          (e.replayKey === targetKey || (e.replayKey == null && e.phaseName === targetKey))) {
        targetName = e.phaseName;
        break;
      }
    }
    const gateMessages = targetName ? { [targetName]: message } : {};
    return { replayOutputs, autoApproveLocks, gateMessages };
  }

  test('reproduces the bug shape: first pass pauses at the ship gate after the loop', async () => {
    setTtpResponder(() => '[VERIFIED]'); // qa passes first try → loop exits at iter 1
    const first = await runUntilPause(ttpOrchestration(), {});
    // Pauses at the FIRST gate (implement-and-qa) on a fresh run.
    expect(first.pausedFor).toBe('implement-and-qa');

    // Approve the plan gate → resume; now it pauses at the ship gate.
    const second = await runUntilPause(ttpOrchestration(), {
      autoApproveLocks: ['implement-and-qa'],
    });
    expect(second.pausedFor).toBe('open-pr');
    // The loop body leaves checkpointed under SCOPED keys; review is unscoped;
    // the last completed leaf before the gate is `review` (NOT the impl).
    expect(second.completedLeaves).toEqual([
      'implement-and-qa@1/implement',
      'implement-and-qa@1/qa-verify',
      'review',
    ]);
  });

  test('request-changes re-runs the loop body (not replay) — exactly one re-pass — then re-pauses at the gate', async () => {
    // First pass through both gates to the ship gate.
    setTtpResponder(() => '[VERIFIED]');
    await runUntilPause(ttpOrchestration(), {}); // pause at plan gate
    const atShipGate = await runUntilPause(ttpOrchestration(), {
      autoApproveLocks: ['implement-and-qa'],
    });
    expect(atShipGate.pausedFor).toBe('open-pr');

    // Human clicks request-changes with feedback. Derive resume params via the
    // real helpers (what the gate handler + run-controller now do).
    const resumeParams = deriveRequestChangesResume(
      atShipGate,
      'change the assertion to toBe(1)',
    );
    // The loop body + review are invalidated; nothing replays from cache.
    expect(resumeParams.replayOutputs).toEqual({});
    // The plan gate (already crossed) is auto-approved so the re-walk doesn't
    // re-pause there; the ship gate stays armed (not listed).
    expect(resumeParams.autoApproveLocks).toEqual(['implement-and-qa']);
    // Feedback routed to the dev (implement leaf), by display name.
    expect(resumeParams.gateMessages).toEqual({
      implement: 'change the assertion to toBe(1)',
    });

    // Resume. qa passes on the (single) re-pass → loop exits at iteration 1.
    const dispatched = setTtpResponder(() => '[VERIFIED]');
    const resumed = await runUntilPause(ttpOrchestration(), resumeParams);

    // The loop body GENUINELY re-ran (implement + qa-verify dispatched), and
    // review re-ran — none replayed.
    expect(dispatched).toContain('implement');
    expect(dispatched).toContain('qa-verify');
    expect(dispatched).toContain('review');
    // EXACTLY ONE additional implement→qa→review pass — guards the 5x re-entry.
    expect(dispatched.filter(d => d === 'implement').length).toBe(1);
    expect(dispatched.filter(d => d === 'qa-verify').length).toBe(1);
    expect(dispatched.filter(d => d === 'review').length).toBe(1);
    // open-pr did NOT dispatch — the gate re-fired and the run re-paused there.
    expect(dispatched).not.toContain('open-pr');
    expect(resumed.pausedFor).toBe('open-pr');
  });

  test('the dev re-implementation actually receives the human feedback', async () => {
    setTtpResponder(() => '[VERIFIED]');
    await runUntilPause(ttpOrchestration(), {});
    const atShipGate = await runUntilPause(ttpOrchestration(), {
      autoApproveLocks: ['implement-and-qa'],
    });
    const resumeParams = deriveRequestChangesResume(atShipGate, 'use toBe(1) not toBe(2)');

    // Capture the implement phase's user prompt on the re-run.
    let implPrompt = '';
    setResponder((_sys, user) => {
      if (user.includes('IMPLEMENT')) { implPrompt = user; return 'implemented diff'; }
      if (user.includes('QAVERIFY')) return '[VERIFIED]';
      if (user.includes('REVIEW')) return 'LGTM';
      if (user.includes('OPENPR')) return 'PR opened';
      return 'x';
    });
    await runUntilPause(ttpOrchestration(), resumeParams);
    expect(implPrompt).toContain('HUMAN INSTRUCTION (gate approval)');
    expect(implPrompt).toContain('use toBe(1) not toBe(2)');
  });

  test('a multi-iteration first pass invalidates ALL iterations and still re-runs exactly once', async () => {
    // qa fails twice then passes → loop runs 3 iterations on the first pass.
    let q = 0;
    setTtpResponder(() => (++q >= 3 ? '[VERIFIED]' : 'still failing X'));
    await runUntilPause(ttpOrchestration(), {});
    const atShipGate = await runUntilPause(ttpOrchestration(), {
      autoApproveLocks: ['implement-and-qa'],
    });
    expect(atShipGate.pausedFor).toBe('open-pr');
    // All 3 iterations checkpointed.
    expect(atShipGate.completedLeaves.filter(k => k.includes('@')).length).toBe(6);

    const resumeParams = deriveRequestChangesResume(atShipGate, 'fix it');
    // Every loop leaf (all iterations) + review invalidated → empty replay.
    expect(resumeParams.replayOutputs).toEqual({});

    // On resume the feedback fixes it → qa passes on iteration 1.
    const dispatched = setTtpResponder(() => '[VERIFIED]');
    const resumed = await runUntilPause(ttpOrchestration(), resumeParams);
    // Clean single re-pass despite the first pass having looped 3×.
    expect(dispatched.filter(d => d === 'implement').length).toBe(1);
    expect(dispatched.filter(d => d === 'qa-verify').length).toBe(1);
    expect(dispatched.filter(d => d === 'review').length).toBe(1);
    expect(resumed.pausedFor).toBe('open-pr');
  });
});

// ── Regression: per-iteration gate inside a SERIAL MAP (resume→re-pause) ──────
// The live bug: a server-owned run of a serial `map` whose body holds a human
// GATE. Iteration 0's gate approves + the run progresses; iteration 1 pauses at
// ITS gate, but every resume replays through the prior (already-approved) locks
// and RE-PAUSES at iteration 1's gate without executing past it — a
// resume→pause loop the 2nd item can never escape.
//
// Root cause: the gate's identity was the BARE phase name (identical across map
// iterations), so the plain-approve auto-approve entry got consumed by
// iteration 0's gate on the re-walk and iteration 1's gate (same name, already
// consumed) re-paused. Fix: the lock-gate event + the pause record + the resume
// auto-approve set all key by the iteration-SCOPED replay key
// (`<map>[<idx>]/<gate>`), so each iteration's gate is a distinct, separately
// consumed lock.
//
// These tests drive the REAL executor and derive the resume parameters with the
// REAL helpers + the same capture/seed math the run-controller uses — pinning
// the fix end-to-end, not just at the unit-helper level.
describe('executor — per-iteration gate in a serial map (regression)', () => {
  // Serial map over two items; the body's FIRST phase is the gate, so the run
  // pauses before doing each item's work — mirrors the live ticket-to-PR-per-
  // item shape (gate → implement → open-pr, fanned out over a ticket list).
  function serialMapGateOrchestration(): Node {
    return {
      name: 'per-item-flow',
      phases: [
        {
          name: 'per-item',
          map: {
            over: '["item-1","item-2"]',
            serial: true,
            body: {
              name: 'do-item',
              phases: [
                { name: 'gate', agent: 'agents/a.md', prompt: 'GATE ${item}', lock: true },
                { name: 'work', agent: 'agents/b.md', prompt: 'WORK ${item}', as: 'itemResult' },
              ],
            },
          },
        },
      ],
    };
  }

  function setMapResponder(): string[] {
    const dispatched: string[] = [];
    setResponder((_sys, user) => {
      if (user.includes('GATE')) { dispatched.push('gate'); return 'gate ok'; }
      if (user.includes('WORK')) {
        const item = user.match(/WORK (\S+)/)?.[1] ?? '?';
        dispatched.push(`work:${item}`);
        return `did ${item}`;
      }
      return 'x';
    });
    return dispatched;
  }

  /** Drive the REAL executor until it pauses, capturing checkpoints exactly as
   *  the run-controller does. The server's waitForApproval throws
   *  RunPauseRequested with the bare display name (so `pausedFor` is the bare
   *  name — unchanged for the UI); the gate's per-iteration identity rides on
   *  the lock-gate event's scoped replayKey, which the resume derivation reads. */
  async function runUntilPauseScoped(
    orchestration: Node,
    opts: { replayOutputs?: Record<string, string>; autoApproveLocks?: string[] },
  ): Promise<{
    events: RunEvent[];
    completedLeaves: string[];
    leafOutputs: Record<string, string>;
    pausedFor: string | null;
  }> {
    const events: RunEvent[] = [];
    const completedLeaves: string[] = [];
    const leafOutputs: Record<string, string> = { ...(opts.replayOutputs ?? {}) };
    let pausedFor: string | null = null;
    try {
      for await (const ev of runOrchestration({
        orchestration,
        apiKey: 'k',
        model: 'claude-opus-4-7',
        cancelled: { v: false },
        allowAgentTools: true,
        replayOutputs: opts.replayOutputs,
        autoApproveLocks: opts.autoApproveLocks,
        waitForApproval: async (name) => {
          // Server semantics (run-runner): pause record is the bare name.
          throw new RunPauseRequested(name);
        },
      })) {
        events.push(ev);
        if (ev.type === 'phase-end') {
          const key = (ev as { replayKey?: string }).replayKey ?? ev.phaseName;
          if (!completedLeaves.includes(key)) completedLeaves.push(key);
          leafOutputs[key] = (ev as { output: string }).output;
        }
      }
    } catch (err) {
      if (err instanceof RunPauseRequested) pausedFor = err.pausedFor;
      else throw err;
    }
    return { events, completedLeaves, leafOutputs, pausedFor };
  }

  /** The run-controller's plain-approve resume derivation: auto-approve every
   *  prior crossed lock PLUS the current gate — all by their iteration-SCOPED
   *  keys. The current gate's scoped key is the LAST lock-gate event's
   *  replayKey (exactly as run-controller.resume() derives it). */
  function deriveApproveResume(first: {
    events: RunEvent[];
    leafOutputs: Record<string, string>;
    pausedFor: string | null;
  }): { replayOutputs: Record<string, string>; autoApproveLocks: string[] } {
    let currentGateKey: string | null = first.pausedFor;
    if (first.pausedFor) {
      for (let i = first.events.length - 1; i >= 0; i--) {
        const e = first.events[i] as { type?: string; replayKey?: string };
        if (e.type === 'lock-gate') {
          if (typeof e.replayKey === 'string') currentGateKey = e.replayKey;
          break;
        }
      }
    }
    const priorLocks = priorCrossedLocks(first.events, currentGateKey);
    return {
      replayOutputs: { ...first.leafOutputs },
      autoApproveLocks: [
        ...priorLocks,
        ...(currentGateKey ? [currentGateKey] : []),
      ],
    };
  }

  test('the lock-gate event carries the iteration-scoped replay key', async () => {
    setMapResponder();
    const first = await runUntilPauseScoped(serialMapGateOrchestration(), {});
    const gateEvents = first.events.filter(
      (e): e is RunEvent & { type: 'lock-gate' } => e.type === 'lock-gate',
    );
    // Only iteration 0's gate fires on a fresh run (iteration 1 isn't reached
    // until iteration 0 completes — and iteration 0 pauses).
    expect(gateEvents.length).toBe(1);
    expect(gateEvents[0].phaseName).toBe('gate'); // display name unscoped
    expect((gateEvents[0] as { replayKey?: string }).replayKey).toBe(
      'per-item[0]/gate',
    );
    // The pause record keeps the bare display name; the scoped identity is on
    // the event's replayKey above.
    expect(first.pausedFor).toBe('gate');
  });

  test('approve+resume crosses iteration 0, then PAUSES at iteration 1 gate', async () => {
    // First pass pauses at iteration 0's gate.
    setMapResponder();
    const first = await runUntilPauseScoped(serialMapGateOrchestration(), {});
    expect(first.pausedFor).toBe('gate');

    // Approve iteration 0's gate. The run does item 0's work, then advances to
    // iteration 1 and pauses at ITS gate. The resume auto-approve set is the
    // current gate's SCOPED key (derived from the last lock-gate event).
    const r0 = deriveApproveResume(first);
    expect(r0.autoApproveLocks).toEqual(['per-item[0]/gate']);
    const dispatched = setMapResponder();
    const second = await runUntilPauseScoped(serialMapGateOrchestration(), r0);
    // Item 0's work ran; item 1's gate is now where we pause (bare display name).
    expect(dispatched).toContain('work:item-1');
    expect(second.pausedFor).toBe('gate');
  });

  test('resume PAST iteration 1 gate executes item 1 and completes — no resume-loop', async () => {
    // Walk to the iteration-1 pause (the state the live run was stuck at).
    setMapResponder();
    const first = await runUntilPauseScoped(serialMapGateOrchestration(), {});
    const r0 = deriveApproveResume(first);
    const second = await runUntilPauseScoped(serialMapGateOrchestration(), r0);
    expect(second.pausedFor).toBe('gate');

    // Now PLAIN-APPROVE iteration 1's gate. The resume auto-approve set must
    // carry BOTH iteration 0's already-crossed gate (so the re-walk doesn't
    // re-pause there) AND iteration 1's current gate — as DISTINCT scoped keys.
    const r1 = deriveApproveResume(second);
    expect(new Set(r1.autoApproveLocks)).toEqual(
      new Set(['per-item[0]/gate', 'per-item[1]/gate']),
    );

    const dispatched = setMapResponder();
    const finalRun = await runUntilPauseScoped(serialMapGateOrchestration(), r1);

    // THE PROOF: the run did NOT re-pause. It executed PAST iteration 1's gate
    // (item 1's work ran) and completed. Pre-fix this looped: the bare-name
    // approve was consumed by iteration 0's gate and item 1 re-paused forever.
    expect(finalRun.pausedFor).toBeNull();
    expect(dispatched).toContain('work:item-2');
    expect(finalRun.events.some(e => e.type === 'run-end')).toBe(true);
  });

  test('iteration 0 gate still resumes normally (no regression)', async () => {
    // A single-item view of the first gate: approve iteration 0 → its work runs.
    setMapResponder();
    const first = await runUntilPauseScoped(serialMapGateOrchestration(), {});
    const r0 = deriveApproveResume(first);
    const dispatched = setMapResponder();
    const second = await runUntilPauseScoped(serialMapGateOrchestration(), r0);
    expect(dispatched).toContain('work:item-1'); // iteration 0 progressed
    // (then pauses at iteration 1 — exercised by the test above).
    expect(second.events.some(e => e.type === 'phase-end' && e.phaseName === 'work')).toBe(true);
  });

  test('a single (non-map) gate run is unaffected: pausedFor + approve stay bare-name', async () => {
    setResponder((_sys, user) =>
      user.includes('GATE') ? 'ok' : 'done',
    );
    const orchestration: Node = {
      name: 'single-gate',
      phases: [
        { name: 'plan', agent: 'agents/a.md', prompt: 'GATE', lock: true },
        { name: 'ship', agent: 'agents/b.md', prompt: 'SHIP' },
      ],
    };
    const first = await runUntilPauseScoped(orchestration, {});
    // Top-level gate: scoped key == bare name, so nothing changes for non-map.
    expect(first.pausedFor).toBe('plan');
    const lg = first.events.find(e => e.type === 'lock-gate') as
      | { phaseName?: string; replayKey?: string }
      | undefined;
    expect(lg?.replayKey).toBe('plan');

    const r = deriveApproveResume(first);
    expect(r.autoApproveLocks).toEqual(['plan']);
    const second = await runUntilPauseScoped(orchestration, r);
    expect(second.pausedFor).toBeNull();
    expect(second.events.some(e => e.type === 'phase-end' && e.phaseName === 'ship')).toBe(true);
    expect(second.events.some(e => e.type === 'run-end')).toBe(true);
  });
});

describe('executor — runtime I/O-contract enforcement', () => {
  test('output that violates an inline schema surfaces as a run error', async () => {
    setResponder(() => 'just some prose, definitely not JSON');
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'structured',
          agent: 'agents/a.md',
          output: { type: 'object', required: ['verdict'] },
        },
      ],
    });
    const err = events.find(e => e.type === 'run-error');
    expect(err).toBeDefined();
    if (err?.type !== 'run-error') throw new Error('expected run-error');
    expect(err.error).toMatch(/structured/);
    expect(err.error).toMatch(/contract|JSON/);
  });

  test('output that satisfies the contract passes cleanly', async () => {
    setResponder(() => '{"verdict":"pass","score":9}');
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'structured',
          agent: 'agents/a.md',
          output: {
            type: 'object',
            properties: { verdict: { type: 'string' }, score: { type: 'integer' } },
            required: ['verdict'],
          },
        },
      ],
    });
    expect(events.some(e => e.type === 'phase-end')).toBe(true);
    expect(events.some(e => e.type === 'run-error')).toBe(false);
  });

  test('a contract-violating attempt still charges: with retry, the run reports 2× the single-call cost', async () => {
    // The violation threw BEFORE the phase-end, and every spend reader folds
    // phase-ends (plus, now, the leaf's phase-error) — so `retry` paid twice
    // while the run reported the cost of one call.
    let calls = 0;
    setResponder(() => (++calls === 1 ? 'prose, not JSON' : '{"verdict":"pass"}'));
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'structured',
          agent: 'agents/a.md',
          output: { type: 'object', required: ['verdict'] },
          retry: { times: 1, initialMs: 1 },
        },
      ],
    });
    expect(calls).toBe(2);
    const end = events.find(e => e.type === 'phase-end' && e.phaseName === 'structured');
    if (end?.type !== 'phase-end') throw new Error('expected phase-end');
    const failed = events.filter(
      e => e.type === 'phase-error' && e.phaseName === 'structured',
    );
    expect(failed.length).toBe(1);
    if (failed[0].type !== 'phase-error') throw new Error('expected phase-error');
    expect(failed[0].error).toMatch(/contract|JSON/);
    expect(failed[0].inputTokens).toBe(10);
    expect(failed[0].outputTokens).toBe(20);
    expect(failed[0].costUsd).toBeCloseTo(end.costUsd);
    // The ledger every reader folds: phase-ends + the leaf's phase-errors.
    const ledger = events.reduce(
      (sum, e) =>
        (e.type === 'phase-end' || e.type === 'phase-error') && typeof e.costUsd === 'number'
          ? sum + e.costUsd
          : sum,
      0,
    );
    expect(ledger).toBeCloseTo(2 * end.costUsd);
    // And the run-wide snapshot agrees — both attempts were charged.
    const snapshots = events.filter(e => e.type === 'cost');
    const last = snapshots[snapshots.length - 1];
    if (last?.type !== 'cost') throw new Error('expected a cost snapshot');
    expect(last.costUsd).toBeCloseTo(2 * end.costUsd);
  });

  test('a turn that dies with usage attached (the sdk-stream throw sites) charges those tokens on its phase-error', async () => {
    // sdk-stream stamps `err.usage` on the errors it throws mid-turn (ceiling,
    // non-success result, headless tool block): `done` never follows a throw,
    // so the thrower is the only party that knows what the dead turn spent.
    const dying: StreamFn = async function* () {
      throw Object.assign(new Error('turn failed'), {
        usage: { inputTokens: 1_000, outputTokens: 500 },
      });
      // eslint-disable-next-line no-unreachable
      yield { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } } as never;
    };
    const events: RunEvent[] = [];
    for await (const ev of runOrchestration({
      orchestration: {
        name: 'flow',
        phases: [{ name: 'p', agent: 'agents/a.md', continueOnError: true }],
      },
      apiKey: 'k',
      model: 'claude-opus-4-7',
      streamFn: dying,
      waitForApproval: async () => true,
      cancelled: { v: false },
    })) {
      events.push(ev);
    }
    const failed = events.find(e => e.type === 'phase-error' && e.phaseName === 'p');
    if (failed?.type !== 'phase-error') throw new Error('expected the leaf phase-error');
    expect(failed.inputTokens).toBe(1_000);
    expect(failed.outputTokens).toBe(500);
    expect(failed.costUsd).toBeGreaterThan(0); // opus has known pricing
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });

  // The producer half — sdk-stream stamping its usage on every throw site —
  // is driven behaviourally in sdk-stream.test.ts through the injected
  // `queryFn` seam (it replaced a source-level regex pin that a neutered
  // `withUsage` still passed).

  test("a SAMMY-TERMINAL marker is charged: the leaf phase-error carries the attempt's spend", async () => {
    // The marker throws BEFORE the phase-end and no phase-end follows a
    // terminal failure, so without a charged phase-error the attempt was
    // free to every spend reader — just like the contract violation above.
    setResponder(() => 'validator is down\nSAMMY-TERMINAL: validator unreachable');
    const events = await runToCompletion({
      name: 'flow',
      phases: [{ name: 'p', agent: 'agents/a.md', continueOnError: true }],
    });
    // continueOnError records its own (uncharged) phase-error as it swallows
    // the failure; the ledger entry is the LEAF's, the one carrying the cost.
    const charged = events.filter(
      e => e.type === 'phase-error' && e.phaseName === 'p' && typeof e.costUsd === 'number',
    );
    expect(charged).toHaveLength(1);
    if (charged[0].type !== 'phase-error') throw new Error('expected phase-error');
    expect(charged[0].error).toMatch(/validator unreachable/);
    expect(charged[0].inputTokens).toBe(10);
    expect(charged[0].outputTokens).toBe(20);
    expect(charged[0].costUsd).toBeGreaterThan(0); // opus has known pricing
    expect(events.some(e => e.type === 'phase-terminal')).toBe(true);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });

  test('a cancel after a completed exchange charges that exchange on a phase-error', async () => {
    // The abort unwind knows what the COMPLETED exchanges spent (the one in
    // flight never reports). A phase parked between exchanges — paused —
    // and then cancelled used to walk away without charging the turn it
    // had already paid for.
    const cancelled = { v: false };
    const paused = { v: false };
    const stream: StreamFn = async function* () {
      yield { type: 'text-delta', text: 'first exchange' };
      yield { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } };
      // Runs once the executor has folded `done` and asks for more: park the
      // phase so the cancel lands between exchanges.
      paused.v = true;
    };
    const events: RunEvent[] = [];
    for await (const ev of runOrchestration({
      orchestration: { name: 'flow', phases: [{ name: 'p', agent: 'agents/a.md' }] },
      apiKey: 'k',
      model: 'claude-opus-4-7',
      streamFn: stream,
      waitForApproval: async () => true,
      cancelled,
      paused,
    })) {
      events.push(ev);
      if (ev.type === 'phase-paused') cancelled.v = true;
    }
    const charged = events.find(e => e.type === 'phase-error' && e.phaseName === 'p');
    if (charged?.type !== 'phase-error') throw new Error('expected the cancel-unwind phase-error');
    expect(charged.error).toMatch(/cancelled — charging the exchanges it completed/);
    expect(charged.inputTokens).toBe(100);
    expect(charged.outputTokens).toBe(50);
    expect(charged.costUsd).toBeGreaterThan(0);
    expect(events[events.length - 1].type).toBe('run-cancelled');
  });

  test('a cancel inside the first turn charges nothing — there is no completed exchange to charge', async () => {
    const cancelled = { v: false };
    const stream: StreamFn = async function* () {
      yield { type: 'text-delta', text: 'partial' };
      cancelled.v = true; // the in-flight exchange never reports its usage
      yield { type: 'text-delta', text: 'never processed' };
      yield { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } };
    };
    const events: RunEvent[] = [];
    for await (const ev of runOrchestration({
      orchestration: { name: 'flow', phases: [{ name: 'p', agent: 'agents/a.md' }] },
      apiKey: 'k',
      model: 'claude-opus-4-7',
      streamFn: stream,
      waitForApproval: async () => true,
      cancelled,
    })) {
      events.push(ev);
    }
    expect(events.some(e => e.type === 'phase-error')).toBe(false);
    expect(events[events.length - 1].type).toBe('run-cancelled');
  });

  test('continueOnError swallows a contract violation + the run continues', async () => {
    setResponder(() => 'prose, not the JSON the contract wants');
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'bad-contract',
          agent: 'agents/a.md',
          output: { type: 'object', required: ['x'] },
          continueOnError: true,
        },
        { name: 'after', agent: 'agents/b.md' },
      ],
    });
    expect(events.some(e => e.type === 'phase-error' && e.phaseName === 'bad-contract')).toBe(true);
    expect(events.some(e => e.type === 'phase-end' && e.phaseName === 'after')).toBe(true);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });
});

describe('executor — sandbox policy', () => {
  test('a run-root sandbox allowlist strips a tool from a leaf agent', async () => {
    setResponder(() => 'ok');
    // The agent declares Bash + Read; the run sandbox only allows Read.
    // Bash is stripped → a tools-warning surfaces with sandbox-blocked:.
    const events = await runToCompletion(
      {
        name: 'flow',
        sandbox: { allowedTools: ['Read'] },
        phases: [{ name: 'p', agent: 'agents/a.md', tools: ['Bash', 'Read'] }],
      },
      { allowAgentTools: true },
    );
    const warn = events.find(e => e.type === 'tools-warning');
    expect(warn).toBeDefined();
    if (warn?.type !== 'tools-warning') throw new Error();
    expect(warn.missing).toContain('sandbox-blocked:Bash');
    expect(warn.missing).not.toContain('sandbox-blocked:Read');
    // The phase still completes — stripping a tool isn't a failure.
    expect(events.some(e => e.type === 'phase-end' && e.phaseName === 'p')).toBe(true);
  });

  test('a node sandbox tightens the run-root sandbox (intersection)', async () => {
    setResponder(() => 'ok');
    const events = await runToCompletion(
      {
        name: 'flow',
        sandbox: { allowedTools: ['Read', 'Bash', 'Write'] },
        phases: [
          {
            name: 'p',
            agent: 'agents/a.md',
            tools: ['Read', 'Bash', 'Write'],
            // Node tightens to just Read — Bash + Write get stripped.
            sandbox: { allowedTools: ['Read'] },
          },
        ],
      },
      { allowAgentTools: true },
    );
    const warn = events.find(e => e.type === 'tools-warning');
    if (warn?.type !== 'tools-warning') throw new Error('expected tools-warning');
    expect(warn.missing.sort()).toEqual([
      'sandbox-blocked:Bash',
      'sandbox-blocked:Write',
    ]);
  });
});

describe('executor — converge single-writer state merge', () => {
  test('distinct branch `as` writes both land in parent state', async () => {
    setResponder((_sys, user) => user);
    const events = await runToCompletion({
      name: 'root',
      phases: [
        {
          name: 'fan',
          converge: [
            { name: 'br1', agent: 'agents/a.md', prompt: 'val-one', as: 'r1' },
            { name: 'br2', agent: 'agents/b.md', prompt: 'val-two', as: 'r2' },
          ],
        },
        { name: 'consume', agent: 'agents/a.md', prompt: 'r1=${r1} r2=${r2}' },
      ],
    });
    const consume = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'consume',
    );
    if (consume?.type !== 'phase-end') throw new Error('expected consume phase-end');
    expect(consume.output).toBe('r1=val-one r2=val-two');
  });

  test('two branches writing the same key emit state-conflict; last index wins', async () => {
    setResponder((_sys, user) => user);
    const events = await runToCompletion({
      name: 'root',
      phases: [
        {
          name: 'fan',
          converge: [
            { name: 'br1', agent: 'agents/a.md', prompt: 'v1', as: 'shared' },
            { name: 'br2', agent: 'agents/b.md', prompt: 'v2', as: 'shared' },
          ],
        },
        { name: 'consume', agent: 'agents/a.md', prompt: '${shared}' },
      ],
    });
    const conflict = events.find(e => e.type === 'state-conflict');
    if (conflict?.type !== 'state-conflict')
      throw new Error('expected a state-conflict event');
    expect(conflict.key).toBe('shared');
    const consume = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'consume',
    );
    if (consume?.type !== 'phase-end') throw new Error('expected consume phase-end');
    // Highest-index branch (br2) wins, deterministically.
    expect(consume.output).toBe('v2');
  });

  test('parallel map iterations get the same single-writer treatment', async () => {
    setResponder((_sys, user) => user);
    const events = await runToCompletion({
      name: 'root',
      phases: [
        {
          name: 'fan',
          map: {
            over: '["a","b","c"]',
            body: {
              name: 'item',
              agent: 'agents/a.md',
              prompt: 'item-${item}',
              as: 'lastItem',
            },
          },
        },
        { name: 'consume', agent: 'agents/a.md', prompt: '${lastItem}' },
      ],
    });
    // Three parallel iterations all write `as: lastItem`. Merge in
    // INDEX order → highest index wins, deterministically.
    const consume = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'consume',
    );
    if (consume?.type !== 'phase-end') throw new Error('expected consume');
    expect(consume.output).toBe('item-c');
    // Multiple iterations wrote the same key → state-conflict diagnostic.
    expect(events.some(e => e.type === 'state-conflict')).toBe(true);
  });
});

describe('executor — multi-provider routing', () => {
  test('node.provider routes only that phase to the registered streamFn', async () => {
    setResponder(() => 'default-output');
    const calls: { provider: string; model: string }[] = [];
    const fakeOpenAi = async function* (params: {
      model: string;
    }): AsyncIterable<{ type: string; text?: string; usage?: { inputTokens: number; outputTokens: number } }> {
      calls.push({ provider: 'openai', model: params.model });
      yield { type: 'text-delta', text: 'openai-out' };
      yield { type: 'done', usage: { inputTokens: 5, outputTokens: 7 } };
    };
    const events: RunEvent[] = [];
    for await (const ev of runOrchestration({
      orchestration: {
        name: 'mixed',
        phases: [
          { name: 'default-phase', agent: 'agents/a.md' },
          {
            name: 'openai-phase',
            agent: 'agents/b.md',
            provider: 'openai',
            model: 'gpt-4o-mini',
          },
        ],
      },
      apiKey: 'test-key',
      model: 'claude-sonnet-4-6',
      waitForApproval: async () => true,
      cancelled: { v: false },
      // Cast — the test fake has the minimum shape the executor needs.
      providerStreamFns: { openai: fakeOpenAi as unknown as StreamFn },
    })) {
      events.push(ev);
    }
    expect(calls).toEqual([{ provider: 'openai', model: 'gpt-4o-mini' }]);
    const def = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'default-phase',
    );
    const oa = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'openai-phase',
    );
    if (def?.type !== 'phase-end' || oa?.type !== 'phase-end') {
      throw new Error('expected both phase-end events');
    }
    expect(def.output).toBe('default-output');
    expect(def.model).toBe('claude-sonnet-4-6');
    expect(oa.output).toBe('openai-out');
    expect(oa.model).toBe('gpt-4o-mini');
  });
});

describe('executor — loop.stopAtScore (numeric judge)', () => {
  test('exits the loop as soon as the judge score crosses the threshold', async () => {
    // Judge returns 0.5 then 0.95; threshold is 0.8 → should stop on iter 2.
    let judgeCalls = 0;
    setResponder((_sys, user) => {
      if (user.includes('Score the output')) {
        judgeCalls += 1;
        return judgeCalls === 1 ? '0.5' : '0.95';
      }
      return 'body output';
    });
    const events = await runToCompletion({
      name: 'root',
      phases: [
        {
          name: 'refine',
          loop: {
            body: { name: 'rewrite', agent: 'agents/a.md' },
            judge: 'agents/judge.md',
            stopAtScore: 0.8,
            maxIterations: 5,
          },
        },
      ],
    });
    const stopped = events.find(e => e.type === 'loop-stopped');
    if (stopped?.type !== 'loop-stopped')
      throw new Error('expected loop-stopped event');
    expect(stopped.reason).toMatch(/0\.95/);
    expect(stopped.iteration).toBe(2);
    const bodyEnds = events.filter(
      e => e.type === 'phase-end' && e.phaseName === 'rewrite',
    );
    expect(bodyEnds.length).toBe(2);
    expect(judgeCalls).toBe(2);
  });

  test('keeps iterating when scores never cross — stops at maxIterations', async () => {
    setResponder((_sys, user) =>
      user.includes('Score the output') ? '0.4' : 'body',
    );
    const events = await runToCompletion({
      name: 'root',
      phases: [
        {
          name: 'refine',
          loop: {
            body: { name: 'rewrite', agent: 'agents/a.md' },
            judge: 'agents/judge.md',
            stopAtScore: 0.9,
            maxIterations: 3,
          },
        },
      ],
    });
    // No loop-stopped event — exits cleanly at the iteration cap.
    expect(events.some(e => e.type === 'loop-stopped')).toBe(false);
    const bodyEnds = events.filter(
      e => e.type === 'phase-end' && e.phaseName === 'rewrite',
    );
    expect(bodyEnds.length).toBe(3);
  });

  test('literal STOP from the judge always wins, even with stopAtScore set', async () => {
    setResponder((_sys, user) =>
      user.includes('Score the output') ? 'STOP' : 'body',
    );
    const events = await runToCompletion({
      name: 'root',
      phases: [
        {
          name: 'refine',
          loop: {
            body: { name: 'rewrite', agent: 'agents/a.md' },
            judge: 'agents/judge.md',
            stopAtScore: 0.9,
            maxIterations: 5,
          },
        },
      ],
    });
    const stopped = events.find(e => e.type === 'loop-stopped');
    if (stopped?.type !== 'loop-stopped')
      throw new Error('expected loop-stopped');
    expect(stopped.reason).toBe('judge said STOP');
    expect(stopped.iteration).toBe(1);
  });
});

describe('executor — loop efficient handoff (carryContext / warmSession)', () => {
  test('carryContext (default) frames re-iterations as a refinement of prior work', async () => {
    const seen: string[] = [];
    setResponder((_sys, user) => {
      seen.push(user);
      return 'keep going';
    });
    await runToCompletion({
      name: 'root',
      phases: [
        {
          name: 'refine',
          loop: { body: { name: 'work', agent: 'agents/a.md' }, maxIterations: 2 },
        },
      ],
    });
    // First pass runs on raw input (no framing); the second is framed.
    expect(seen[0]).not.toMatch(/Refinement iteration/);
    expect(seen[1]).toMatch(/Refinement iteration 2 of 2/);
    expect(seen[1]).toMatch(/do not start over/i);
  });

  test('warmSession carries the full prior-iteration history forward', async () => {
    let n = 0;
    const seen: string[] = [];
    setResponder((_sys, user) => {
      seen.push(user);
      n += 1;
      return `result-${n}`;
    });
    await runToCompletion({
      name: 'root',
      phases: [
        {
          name: 'refine',
          loop: {
            body: { name: 'work', agent: 'agents/a.md' },
            maxIterations: 3,
            warmSession: true,
          },
        },
      ],
    });
    expect(seen[1]).toMatch(/Warm refinement loop/);
    expect(seen[1]).toContain('result-1');
    expect(seen[2]).toContain('result-1');
    expect(seen[2]).toContain('result-2');
  });

  test('carryContext:false restores the legacy raw passthrough', async () => {
    const seen: string[] = [];
    setResponder((_sys, user) => {
      seen.push(user);
      return 'again';
    });
    await runToCompletion({
      name: 'root',
      phases: [
        {
          name: 'refine',
          loop: {
            body: { name: 'work', agent: 'agents/a.md' },
            maxIterations: 2,
            carryContext: false,
          },
        },
      ],
    });
    expect(seen[1]).not.toMatch(/Refinement iteration/);
    expect(seen[1]).toBe('again');
  });
});

describe('executor — resolved run inputs', () => {
  test('seeds resolved inputs into state as ${name}', async () => {
    const seen: string[] = [];
    setResponder((_sys, user) => {
      seen.push(user);
      return 'ok';
    });
    await runToCompletion(
      {
        name: 'root',
        inputs: [{ name: 'ticket', kind: 'jira', required: true }],
        phases: [
          { name: 'work', agent: 'agents/a.md', prompt: 'working on ${ticket}' },
        ],
      },
      { resolvedInputs: { ticket: 'BUG-1: login crashes' } },
    );
    expect(seen[0]).toBe('working on BUG-1: login crashes');
  });
});

describe('executor — code.run (external script, opt-in)', () => {
  // code.run is gated behind SAMMY_ALLOW_CODE_RUN; enable it for this suite.
  const prev = process.env.SAMMY_ALLOW_CODE_RUN;
  beforeAll(() => {
    process.env.SAMMY_ALLOW_CODE_RUN = '1';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.SAMMY_ALLOW_CODE_RUN;
    else process.env.SAMMY_ALLOW_CODE_RUN = prev;
  });

  test('pipes upstream output to stdin and uses stdout as the phase output', async () => {
    setResponder(() => 'hello world');
    const events = await runToCompletion({
      name: 'root',
      phases: [
        { name: 'producer', agent: 'agents/a.md' },
        { name: 'upper', code: { run: "tr '[:lower:]' '[:upper:]'" } },
      ],
    });
    const end = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'upper',
    );
    if (end?.type !== 'phase-end') throw new Error('expected upper phase-end');
    expect(end.output.trim()).toBe('HELLO WORLD');
  });

  test('a non-zero exit is a phase error', async () => {
    setResponder(() => 'x');
    const events = await runToCompletion({
      name: 'root',
      phases: [
        { name: 'producer', agent: 'agents/a.md' },
        { name: 'boom', code: { run: 'exit 3' } },
      ],
    });
    const err = events.find(
      e => e.type === 'phase-error' && e.phaseName === 'boom',
    );
    expect(err).toBeDefined();
  });
});

describe('executor — code body kind', () => {
  test('runs the snippet against the upstream input + emits its return', async () => {
    setResponder(() => 'hello world');
    const events = await runToCompletion({
      name: 'root',
      phases: [
        { name: 'producer', agent: 'agents/a.md' },
        {
          name: 'transform',
          code: { source: 'return input.toUpperCase();' },
        },
        {
          name: 'consume',
          agent: 'agents/a.md',
          prompt: 'got: ${input}',
        },
      ],
    });
    setResponder((_sys, user) => user); // echo for consume
    const codeEnd = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'transform',
    );
    if (codeEnd?.type !== 'phase-end')
      throw new Error('expected transform phase-end');
    expect(codeEnd.output).toBe('HELLO WORLD');
    expect(codeEnd.costUsd).toBe(0);
    expect(codeEnd.model).toBe('code');
  });

  test('JSON-stringifies non-string returns', async () => {
    const events = await runToCompletion({
      name: 'root',
      phases: [
        {
          name: 'make-array',
          code: { source: 'return [1, 2, 3];' },
        },
      ],
    });
    const end = events.find(e => e.type === 'phase-end');
    if (end?.type !== 'phase-end') throw new Error('expected phase-end');
    expect(end.output).toBe('[1,2,3]');
  });

  test('exceptions in the snippet surface as a phase-error', async () => {
    const events = await runToCompletion({
      name: 'root',
      phases: [
        {
          name: 'oops',
          code: { source: 'throw new Error("nope");' },
        },
      ],
    });
    const err = events.find(e => e.type === 'phase-error');
    expect(err && (err as { error?: string }).error).toMatch(/nope/);
    expect(events.some(e => e.type === 'run-error')).toBe(true);
  });
});

describe('executor — a2a node', () => {
  test('a2a phase short-circuits to its replay output (no network)', async () => {
    setResponder(() => 'should not be reached');
    const events = await runToCompletion(
      {
        name: 'root',
        phases: [
          { name: 'remote', a2a: { agentCard: 'http://example.test/card' } },
        ],
      },
      { replayOutputs: { remote: 'cached remote output' } },
    );
    const end = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'remote',
    );
    if (end?.type !== 'phase-end') throw new Error('expected remote phase-end');
    expect(end.output).toBe('cached remote output');
    const start = events.find(
      e => e.type === 'phase-start' && e.phaseName === 'remote',
    );
    if (start?.type !== 'phase-start') throw new Error('expected phase-start');
    expect(start.agentPath).toContain('a2a:');
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });
});

describe('executor — parameterized paths (${var} in agent / subflow)', () => {
  test('agent path interpolates from state and dispatches to the resolved agent', async () => {
    const systems: string[] = [];
    setResponder(sys => {
      systems.push(sys);
      return 'ok';
    });
    await runToCompletion({
      name: 'param-agent',
      phases: [
        // pick the agent at runtime, store it, then dispatch via ${which}
        { name: 'pick', code: { source: "return 'b'" }, as: 'which' },
        { name: 'dispatch', agent: 'agents/${which}.md' },
      ],
    });
    // ${which} = 'b' → agents/b.md ran (its system prompt identifies agent B),
    // NOT agents/a.md — proving the path was resolved from state.
    expect(systems.some(s => s.includes('agent B'))).toBe(true);
    expect(systems.some(s => s.includes('agent A'))).toBe(false);
  });

  test('a literal agent path (no ${...}) still dispatches unchanged', async () => {
    const systems: string[] = [];
    setResponder(sys => {
      systems.push(sys);
      return 'ok';
    });
    await runToCompletion({
      name: 'literal-agent',
      phases: [{ name: 'p', agent: 'agents/a.md' }],
    });
    expect(systems.some(s => s.includes('agent A'))).toBe(true);
  });

  test('subflow name interpolates from state and inlines the resolved orchestration', async () => {
    setResponder(() => 'ok');
    mockOrchestrations.current = [
      { name: 'SUBX', phases: [{ name: 's', agent: 'agents/a.md' }] },
    ];
    const events = await runToCompletion({
      name: 'param-subflow',
      phases: [
        { name: 'pick', code: { source: "return 'SUBX'" }, as: 'target' },
        { name: 'call', subflow: '${target}' },
      ],
    });
    const subflowStart = events.find(
      e => e.type === 'composite-start' && (e as { kind?: string }).kind === 'subflow',
    );
    expect(subflowStart).toBeDefined();
    // Resolved to a real orchestration → it ran, no "subflow not found" error.
    expect(events.some(e => e.type === 'phase-error')).toBe(false);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });
});

describe('executor — map concurrency cap', () => {
  test('caps how many items run at once (batches), still processes all', async () => {
    let active = 0;
    let peak = 0;
    setResponder(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 15)); // hold the slot so overlap is observable
      active--;
      return 'ok';
    });
    const events = await runToCompletion({
      name: 'capped',
      phases: [
        {
          name: 'mapper',
          map: {
            over: '[1,2,3,4,5,6]',
            concurrency: 2,
            body: { name: 'work', agent: 'agents/a.md' },
          },
        },
      ],
    });
    const iters = events.filter(e => e.type === 'map-iteration');
    expect(iters.length).toBe(6); // all items ran
    expect(peak).toBeLessThanOrEqual(2); // never more than the cap
    expect(peak).toBe(2); // and it DID parallelize within the cap (not serial)
  });

  test('no cap = all-at-once (unchanged default)', async () => {
    let active = 0;
    let peak = 0;
    setResponder(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      return 'ok';
    });
    await runToCompletion({
      name: 'uncapped',
      phases: [
        {
          name: 'mapper',
          map: { over: '[1,2,3,4]', body: { name: 'work', agent: 'agents/a.md' } },
        },
      ],
    });
    expect(peak).toBe(4); // all four ran concurrently
  });
});

describe('executor — deterministic resume (scoped replay keys)', () => {
  test('loop iterations checkpoint under iteration-scoped replay keys', async () => {
    let n = 0;
    setResponder(() => `draft ${++n}`);
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'refine',
          loop: {
            body: { name: 'draft', agent: 'agents/a.md' },
            maxIterations: 2,
          },
        },
      ],
    });
    const keys = events
      .filter(e => e.type === 'phase-end')
      .map(e => (e.type === 'phase-end' ? e.replayKey : undefined));
    expect(keys).toContain('refine@1/draft');
    expect(keys).toContain('refine@2/draft');
  });

  test('loop resume replays each iteration\'s OWN output at zero dispatches', async () => {
    setResponder(() => {
      throw new Error('SDK must not be called on a fully-replayed loop');
    });
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'refine',
            loop: {
              body: { name: 'draft', agent: 'agents/a.md' },
              maxIterations: 2,
            },
          },
        ],
      },
      {
        replayOutputs: {
          'refine@1/draft': 'first iteration output',
          'refine@2/draft': 'second iteration output',
        },
      },
    );
    expect(mockState.callCount).toBe(0);
    const ends = events.filter(
      e => e.type === 'phase-end' && e.phaseName === 'draft',
    );
    expect(ends.map(e => (e.type === 'phase-end' ? e.output : ''))).toEqual([
      'first iteration output',
      'second iteration output',
    ]);
  });

  test('route resume replays the router verdict — same branch, router not re-asked', async () => {
    // If the router were re-dispatched it would now pick "feature"; the
    // replayed verdict must win so resume takes the SAME branch.
    setResponder((_sys, user) =>
      user.includes('Classify') ? '{"branch": "feature"}' : 'branch work done',
    );
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'classify',
            route: {
              router: 'agents/router.md',
              branches: {
                bug: { name: 'fix-bug', agent: 'agents/a.md' },
                feature: { name: 'scope-feature', agent: 'agents/b.md' },
              },
            },
          },
        ],
      },
      { replayOutputs: { 'classify/router': '{"branch": "bug"}' } },
    );
    const dec = events.find(e => e.type === 'route-decision');
    if (dec?.type !== 'route-decision') throw new Error('expected route-decision');
    expect(dec.branch).toBe('bug');
    expect(mockState.callCount).toBe(1); // only the branch agent ran live
  });

  test('loop judge verdicts replay — resume stops at the same iteration, zero dispatches', async () => {
    setResponder(() => {
      throw new Error('SDK must not be called on a fully-replayed loop');
    });
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'refine',
            loop: {
              body: { name: 'draft', agent: 'agents/a.md' },
              judge: 'agents/judge.md',
              maxIterations: 3,
            },
          },
        ],
      },
      {
        replayOutputs: {
          'refine@1/draft': 'v1',
          'refine/judge-1': '{"decision": "CONTINUE"}',
          'refine@2/draft': 'v2',
          'refine/judge-2': '{"decision": "STOP"}',
        },
      },
    );
    expect(mockState.callCount).toBe(0);
    const stopped = events.find(e => e.type === 'loop-stopped');
    if (stopped?.type !== 'loop-stopped') throw new Error('expected loop-stopped');
    expect(stopped.iteration).toBe(2);
  });

  test('map items replay their own outputs under item-scoped keys', async () => {
    setResponder(() => {
      throw new Error('SDK must not be called on a fully-replayed map');
    });
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'fan',
            map: {
              over: '["x","y"]',
              body: { name: 'work', agent: 'agents/a.md' },
            },
          },
        ],
      },
      {
        replayOutputs: {
          'fan[0]/work': 'output for x',
          'fan[1]/work': 'output for y',
        },
      },
    );
    expect(mockState.callCount).toBe(0);
    const byKey = new Map(
      events
        .filter(e => e.type === 'phase-end' && e.phaseName === 'work')
        .map(e =>
          e.type === 'phase-end' ? [e.replayKey, e.output] : ['', ''],
        ),
    );
    expect(byKey.get('fan[0]/work')).toBe('output for x');
    expect(byKey.get('fan[1]/work')).toBe('output for y');
  });

  test('subflow leaves checkpoint under the subflow node\'s scope', async () => {
    mockOrchestrations.current = [
      {
        name: 'child-flow',
        phases: [{ name: 'step', agent: 'agents/a.md' }],
      },
    ];
    setResponder(() => 'child output');
    const events = await runToCompletion({
      name: 'flow',
      phases: [{ name: 'inline-child', subflow: 'child-flow' }],
    });
    const end = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'step',
    );
    if (end?.type !== 'phase-end') throw new Error('expected phase-end');
    expect(end.replayKey).toBe('inline-child/step');
    mockOrchestrations.current = [];
  });
});

describe('executor — global agent concurrency cap', () => {
  // The cap lives in a process-wide singleton; save/restore so we don't
  // perturb the other suites that share this worker.
  let savedLimit: number;
  beforeEach(() => {
    savedLimit = agentSlots.limit;
  });
  afterEach(() => {
    agentSlots.setLimit(savedLimit);
  });

  test('a wide `parallel` never exceeds the cap, and every branch still runs', async () => {
    agentSlots.setLimit(2);
    let active = 0;
    let peak = 0;
    // Async responder so leaf streams genuinely overlap in time — that's what
    // lets us observe the gate doing its job.
    setResponder(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 10));
      active -= 1;
      return 'ok';
    });
    const branches: Node[] = Array.from({ length: 8 }, (_unused, i) => ({
      name: `b${i}`,
      agent: 'agents/a.md',
    }));
    const events = await runToCompletion({
      name: 'wide',
      phases: [{ name: 'fan', parallel: branches }],
    });
    const ends = events.filter(e => e.type === 'phase-end');
    // All 8 leaves completed (no deadlock, no starvation)…
    expect(ends.length).toBe(8);
    // …but never more than the cap ran at once.
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
    // Pool fully drained afterwards.
    expect(agentSlots.inUse).toBe(0);
    expect(agentSlots.waiting).toBe(0);
  });

  test('cancelling while queued does not hang and frees the pool', async () => {
    agentSlots.setLimit(1);
    setResponder(async () => {
      await new Promise(r => setTimeout(r, 10));
      return 'ok';
    });
    const cancelled = { v: false };
    const branches: Node[] = Array.from({ length: 5 }, (_unused, i) => ({
      name: `c${i}`,
      agent: 'agents/a.md',
    }));
    const iter = runOrchestration({
      orchestration: { name: 'cancelme', phases: [{ name: 'fan', parallel: branches }] },
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      waitForApproval: async () => true,
      cancelled,
    });
    // Let a couple leaves start/queue, then cancel mid-flight.
    const collected: RunEvent[] = [];
    const pump = (async () => {
      for await (const ev of iter) {
        collected.push(ev);
        if (collected.filter(e => e.type === 'phase-start').length >= 1) {
          cancelled.v = true;
        }
      }
    })();
    // Must settle (not hang) and leave the pool clean.
    await pump;
    expect(agentSlots.inUse).toBe(0);
    expect(agentSlots.waiting).toBe(0);
  });
});

describe('executor — switch (deterministic value-based cases)', () => {
  test('if/else on the upstream output: true → the true case runs', async () => {
    setResponder(() => 'ran');
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'gate',
            switch: {
              cases: {
                true: { name: 'yes', agent: 'agents/a.md' },
                false: { name: 'no', agent: 'agents/b.md' },
              },
            },
          },
        ],
      },
      { initialInput: 'true' },
    );
    const dec = events.find(e => e.type === 'route-decision');
    if (dec?.type !== 'route-decision') throw new Error('expected a decision');
    expect(dec.branch).toBe('true');
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'yes'),
    ).toBe(true);
    expect(
      events.some(e => e.type === 'phase-start' && e.phaseName === 'no'),
    ).toBe(false);
  });

  test('multi-way x/y/z routes to the matching case', async () => {
    setResponder(() => 'ran');
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'gate',
            switch: {
              cases: {
                x: { name: 'cx', agent: 'agents/a.md' },
                y: { name: 'cy', agent: 'agents/a.md' },
                z: { name: 'cz', agent: 'agents/a.md' },
              },
            },
          },
        ],
      },
      { initialInput: 'z' },
    );
    const dec = events.find(e => e.type === 'route-decision');
    if (dec?.type !== 'route-decision') throw new Error('expected a decision');
    expect(dec.branch).toBe('z');
    expect(
      events.some(e => e.type === 'phase-start' && e.phaseName === 'cz'),
    ).toBe(true);
  });

  test('switches on an `on` expression referencing a prior `as` write', async () => {
    setResponder(() => 'y'); // classify writes "y" → verdict
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'classify', agent: 'agents/a.md', as: 'verdict' },
        {
          name: 'gate',
          switch: {
            on: '${verdict}',
            cases: {
              x: { name: 'cx', agent: 'agents/a.md' },
              y: { name: 'cy', agent: 'agents/a.md' },
            },
          },
        },
      ],
    });
    const dec = events.find(e => e.type === 'route-decision');
    if (dec?.type !== 'route-decision') throw new Error('expected a decision');
    expect(dec.branch).toBe('y');
  });

  test('falls back to default when no case matches', async () => {
    setResponder(() => 'ran');
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'gate',
            switch: {
              cases: { x: { name: 'cx', agent: 'agents/a.md' } },
              default: { name: 'fallback', agent: 'agents/a.md' },
            },
          },
        ],
      },
      { initialInput: 'nope' },
    );
    const dec = events.find(e => e.type === 'route-decision');
    if (dec?.type !== 'route-decision') throw new Error('expected a decision');
    expect(dec.branch).toBe('default');
    expect(
      events.some(e => e.type === 'phase-start' && e.phaseName === 'fallback'),
    ).toBe(true);
  });

  test('no matching case and no default fails the phase', async () => {
    setResponder(() => 'ran');
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'gate',
            switch: { cases: { x: { name: 'cx', agent: 'agents/a.md' } } },
          },
        ],
      },
      { initialInput: 'nope' },
    );
    // Emits an error event (phase-error → run-error) instead of silently
    // routing somewhere, and the lone case never runs.
    const errored = events.some(
      e =>
        (e.type === 'phase-error' || e.type === 'run-error') &&
        /switch|no matching case|matched no case/i.test(
          String((e as { error?: unknown }).error ?? ''),
        ),
    );
    expect(errored).toBe(true);
    expect(
      events.some(e => e.type === 'phase-start' && e.phaseName === 'cx'),
    ).toBe(false);
  });
});

describe('executor — halt (controlled early return)', () => {
  test('halt ends the run — later phases do not run', async () => {
    setResponder(() => 'x');
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'a', agent: 'agents/a.md', halt: true },
        { name: 'b', agent: 'agents/a.md' },
      ],
    });
    expect(
      events.some(e => e.type === 'run-halted' && e.phaseName === 'a'),
    ).toBe(true);
    expect(
      events.some(e => e.type === 'phase-start' && e.phaseName === 'a'),
    ).toBe(true);
    expect(
      events.some(e => e.type === 'phase-start' && e.phaseName === 'b'),
    ).toBe(false);
  });

  test('halt + when=false skips the node and does NOT halt (run continues)', async () => {
    setResponder(() => 'x');
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'gate', agent: 'agents/a.md', halt: true, when: 'false' },
        { name: 'b', agent: 'agents/a.md' },
      ],
    });
    expect(events.some(e => e.type === 'run-halted')).toBe(false);
    expect(
      events.some(e => e.type === 'phase-start' && e.phaseName === 'b'),
    ).toBe(true);
  });

  test('halt + when=true runs the node then halts', async () => {
    setResponder(() => 'x');
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'gate', agent: 'agents/a.md', halt: true, when: 'true' },
        { name: 'b', agent: 'agents/a.md' },
      ],
    });
    expect(events.some(e => e.type === 'run-halted')).toBe(true);
    expect(
      events.some(e => e.type === 'phase-start' && e.phaseName === 'b'),
    ).toBe(false);
  });

  test('halt deep inside a switch branch unwinds and stops the outer sequence', async () => {
    setResponder(() => 'x');
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'gate',
            switch: {
              cases: {
                x: { name: 'stop-here', agent: 'agents/a.md', halt: true },
              },
              default: { name: 'd', agent: 'agents/a.md' },
            },
          },
          { name: 'after', agent: 'agents/a.md' },
        ],
      },
      { initialInput: 'x' },
    );
    expect(
      events.some(e => e.type === 'run-halted' && e.phaseName === 'stop-here'),
    ).toBe(true);
    expect(
      events.some(e => e.type === 'phase-start' && e.phaseName === 'after'),
    ).toBe(false);
  });
});
